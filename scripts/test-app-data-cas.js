#!/usr/bin/env node
'use strict';
/**
 * Optimistic concurrency on PUT /api/data/:key.
 *
 * Run: node scripts/test-app-data-cas.js
 *
 * Several blobs are read-modify-written by more than one page —
 * fct_intercompany_billing_entries above all, which trucking.html and both
 * dust tabs reconcile into. app_data had no way to detect that: whoever PUT
 * last silently erased the other's entries, and nothing surfaced the loss.
 *
 * GET now returns the row's updated_at, and PUT accepts it back as
 * `baseUpdatedAt`. A stale base is refused with 409 so the caller can re-read
 * and reconcile onto the newer value. The field is optional and every existing
 * caller omits it, so the tests below pin BOTH halves: the guard works when
 * asked for, and nothing changes when it isn't.
 */

const path   = require('path');
const Module = require('module');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const API = path.resolve(__dirname, '../api');
const KEY = 'fct_intercompany_billing_entries';

// One-row store standing in for app_data.
const db = { value: null, updated_at: null, exists: false };
let syncCalls = 0;

const orig = Module._load;
Module._load = function (req, parent) {
  if (req === '@neondatabase/serverless') {
    return { neon: () => (strings, ...vals) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      if (/^SELECT value, updated_at FROM app_data/.test(q)) {
        return Promise.resolve(db.exists ? [{ value: db.value, updated_at: db.updated_at }] : []);
      }
      if (/^SELECT updated_at FROM app_data/.test(q)) {
        return Promise.resolve(db.exists ? [{ updated_at: db.updated_at }] : []);
      }
      if (/^SELECT value FROM app_data/.test(q)) {
        return Promise.resolve(db.exists ? [{ value: db.value }] : []);
      }
      if (/^INSERT INTO app_data/.test(q)) {
        db.value = JSON.parse(vals[1]);
        db.updated_at = new Date(Date.parse(db.updated_at || '2026-07-01T00:00:00.000Z') + 1000);
        db.exists = true;
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }};
  }
  if (req === '../lib/auth' && parent && parent.filename.includes('data')) {
    return {
      requireAuth: () => ({ companyCode: 'ACME', isPlatformAdmin: true, userId: 1, username: 'tester' }),
      hasDivisionAccess: () => true,
      hasAnyDivisionAccess: () => true,
      divisionForKey: () => null,
      isSharedKey: () => true,
      isCrossDivisionKey: () => false,
      CROSS_DIVISION_CONTRIBUTORS: [],
    };
  }
  if (req === '../lib/sync-normalized' && parent && parent.filename.includes('data')) {
    return { syncForKey: async () => { syncCalls++; } };
  }
  return orig.apply(this, arguments);
};

const handler = require(path.join(API, 'data/[key].js'));

const call = (method, body, query = {}) => new Promise(resolve => {
  const req = { method, query: { key: KEY, ...query }, headers: {}, body: body || {} };
  const res = {
    setHeader() {}, status(c) { this._c = c; return this; },
    json(o) { resolve({ code: this._c || 200, body: o }); },
    end() { resolve({ code: this._c || 200, body: null }); },
  };
  handler(req, res);
});

const reset = (value, stamp) => {
  db.value = value;
  db.updated_at = stamp ? new Date(stamp) : null;
  db.exists = value !== null;
};

(async () => {
  console.log('\n[GET exposes the version a writer must build on]');
  {
    reset([{ id: 'a' }], '2026-07-01T00:00:00.000Z');
    const r = await call('GET');
    assert('value returned', JSON.stringify(r.body.value) === JSON.stringify([{ id: 'a' }]));
    assert('updated_at returned as ISO', r.body.updated_at === '2026-07-01T00:00:00.000Z', String(r.body.updated_at));
  }
  {
    reset(null, null);
    const r = await call('GET');
    assert('a missing row reports null for both', r.body.value === null && r.body.updated_at === null);
  }

  console.log('\n[a write built on the current version lands]');
  {
    reset([{ id: 'a' }], '2026-07-01T00:00:00.000Z');
    const r = await call('PUT', { value: [{ id: 'a' }, { id: 'b' }], baseUpdatedAt: '2026-07-01T00:00:00.000Z' });
    assert('accepted', r.code === 200 || r.code === undefined, JSON.stringify(r));
    assert('value stored', JSON.stringify(db.value) === JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    assert('normalized mirror still ran', syncCalls > 0);
  }

  console.log('\n[a write built on a stale version is refused]');
  {
    reset([{ id: 'a' }], '2026-07-02T00:00:00.000Z');   // someone else already wrote
    const before = JSON.stringify(db.value);
    const r = await call('PUT', { value: [{ id: 'mine' }], baseUpdatedAt: '2026-07-01T00:00:00.000Z' });
    assert('409 Conflict', r.code === 409, JSON.stringify(r));
    assert('the other writer\'s value survives', JSON.stringify(db.value) === before, JSON.stringify(db.value));
    assert('the current version is reported back', r.body.updated_at === '2026-07-02T00:00:00.000Z', String(r.body.updated_at));
  }

  console.log('\n[timestamp forms that must still compare equal]');
  {
    // The driver hands back a Date; the client always sends the ISO string.
    // Comparing them as text would 409 on every single write.
    reset([{ id: 'a' }], '2026-07-01T12:34:56.789Z');
    const r = await call('PUT', { value: [{ id: 'b' }], baseUpdatedAt: '2026-07-01T12:34:56.789Z' });
    assert('a Date and its ISO string match', r.code !== 409, JSON.stringify(r));
  }
  {
    reset([{ id: 'a' }], '2026-07-01T00:00:00.000Z');
    const r = await call('PUT', { value: [{ id: 'b' }], baseUpdatedAt: '2026-07-01T00:00:00Z' });   // no millis
    assert('an equivalent instant in another form matches', r.code !== 409, JSON.stringify(r));
  }

  console.log('\n[writing onto a row that has since vanished]');
  {
    reset(null, null);
    const r = await call('PUT', { value: [{ id: 'x' }], baseUpdatedAt: '2026-07-01T00:00:00.000Z' });
    assert('409 rather than silently recreating', r.code === 409, JSON.stringify(r));
  }

  console.log('\n[a malformed base is a client error, not a silent overwrite]');
  {
    reset([{ id: 'a' }], '2026-07-01T00:00:00.000Z');
    const r = await call('PUT', { value: [{ id: 'b' }], baseUpdatedAt: 'not-a-date' });
    assert('400 Bad Request', r.code === 400, JSON.stringify(r));
    assert('nothing written', JSON.stringify(db.value) === JSON.stringify([{ id: 'a' }]));
  }

  console.log('\n[callers that do not opt in are unaffected]');
  {
    reset([{ id: 'a' }], '2026-07-02T00:00:00.000Z');
    const r = await call('PUT', { value: [{ id: 'b' }] });                 // no baseUpdatedAt
    assert('still last-writer-wins', r.code !== 409, JSON.stringify(r));
    assert('value overwritten as before', JSON.stringify(db.value) === JSON.stringify([{ id: 'b' }]));
  }
  {
    reset([{ id: 'a' }], '2026-07-02T00:00:00.000Z');
    const r = await call('PUT', { value: [{ id: 'b' }], baseUpdatedAt: null });
    assert('an explicit null also opts out', r.code !== 409, JSON.stringify(r));
  }

  console.log('\n[the bulk-wipe guard still applies to guarded writes]');
  {
    reset([{ id: 'a' }, { id: 'b' }, { id: 'c' }], '2026-07-01T00:00:00.000Z');
    const r = await call('PUT', { value: [], baseUpdatedAt: '2026-07-01T00:00:00.000Z' });
    assert('empty-array PUT refused', r.code === 409, JSON.stringify(r));
    assert('detail names the wipe, not the version', /Refusing to wipe|empty array/i.test(JSON.stringify(r.body)), JSON.stringify(r.body));
    assert('rows intact', db.value.length === 3);
  }
  {
    reset([{ id: 'a' }, { id: 'b' }, { id: 'c' }], '2026-07-01T00:00:00.000Z');
    const r = await call('PUT', { value: [], baseUpdatedAt: '2026-07-01T00:00:00.000Z' }, { force: '1' });
    assert('force=1 still clears deliberately', r.code !== 409, JSON.stringify(r));
    assert('blob emptied', Array.isArray(db.value) && db.value.length === 0);
  }
  {
    // …and force=1 must not become a way around a stale base.
    reset([{ id: 'a' }, { id: 'b' }], '2026-07-02T00:00:00.000Z');
    const r = await call('PUT', { value: [], baseUpdatedAt: '2026-07-01T00:00:00.000Z' }, { force: '1' });
    assert('a stale force-clear is still refused', r.code === 409, JSON.stringify(r));
    assert('rows intact', db.value.length === 2);
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
