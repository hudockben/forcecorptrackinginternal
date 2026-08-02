#!/usr/bin/env node
'use strict';
/**
 * Tests for GET /api/data/_keys?prefix=... and the turf-only guard on the
 * normalized bid_items mirror.
 *
 * Run: node scripts/test-data-keys.js
 *
 * _keys exists because the client's project recovery pass used to ask
 * /api/projects for project ids. That reads the normalized projects table,
 * which only ever receives turf projects — api/lib/sync-normalized.js routes
 * fct_project_* and fct_projects*, nothing else. So on paving and kiewit the
 * pass fetched turf ids, looked them up under its own blob prefix, matched
 * nothing, and recovered nothing. Listing the blob keys works identically for
 * every division.
 *
 * The endpoint is a deliberate enumeration surface, so most of what is
 * asserted here is what it REFUSES to do.
 */

const path = require('path');
const Module = require('module');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const API = path.resolve(__dirname, '../api');

// Rows as they sit in app_data, including keys that a sloppy LIKE would catch.
const KEYS = [
  'ACME:fct_project_t1', 'ACME:fct_project_t2',
  'ACME:fct_projects_index',            // LIKE 'fct_project_%' matches this — it must not come back
  'ACME:fct_projects',                  // same
  'ACME:fct_paving_project_p1',
  'ACME:fct_kiewit_project_k1', 'ACME:fct_kiewit_project_k2',
  'ACME:fct_lists', 'ACME:auth_users',  // unrelated blobs
  'OTHERCO:fct_project_x1',             // another company
  'ACME:fct_project_gone',              // deleted: the row survives with value NULL
];
// Deleting a project stores null under its key rather than removing the row.
// A null must never come back as a live project id, or recovery would
// resurrect it.
const TOMBSTONED = new Set(['ACME:fct_project_gone']);

let authPayload = { companyCode: 'ACME', isPlatformAdmin: true };
let denyDivision = null;

const orig = Module._load;
Module._load = function (req, parent) {
  if (req === '@neondatabase/serverless') {
    return { neon: () => (strings, ...vals) => {
      const q = strings.join(' ').replace(/\s+/g, ' ');
      if (/LEFT\(key/.test(q)) {
        const [len, scoped] = vals;
        if (!/value IS NOT NULL/.test(q)) throw new Error('key scan must skip tombstones (value IS NOT NULL)');
        return Promise.resolve(
          KEYS.filter(k => k.slice(0, len) === scoped && !TOMBSTONED.has(k)).map(key => ({ key }))
        );
      }
      if (/LIKE/.test(q)) throw new Error('LIKE used for the key scan — underscores are wildcards there');
      return Promise.resolve([]);
    }};
  }
  if (req === '../lib/auth' && parent && parent.filename.includes('data')) {
    return {
      requireAuth: () => authPayload,
      hasDivisionAccess: (p, div) => div !== denyDivision,
      hasAnyDivisionAccess: () => true,
      divisionForKey: k => k.startsWith('fct_paving_') ? 'paving'
                        : k.startsWith('fct_kiewit_') ? 'kiewit'
                        : k.startsWith('fct_quarry_') ? 'quarry' : null,
      isSharedKey: () => false,
      isCrossDivisionKey: () => false,
      CROSS_DIVISION_CONTRIBUTORS: [],
    };
  }
  return orig.apply(this, arguments);
};

const handler = require(path.join(API, 'data/[key].js'));

const call = (prefix, opts = {}) => new Promise(resolve => {
  const req = { method: 'GET', query: { key: '_keys', prefix, ...(opts.query || {}) }, headers: {} };
  const res = {
    setHeader() {}, status(c) { this._c = c; return this; },
    json(o) { resolve({ code: this._c || 200, body: o }); }, end() { resolve({ code: this._c }); },
  };
  handler(req, res);
});

(async () => {
  console.log('\n[lists the project ids for each division]');
  const t = await call('fct_project_');
  assert('turf prefix returns its ids', JSON.stringify(t.body.ids) === JSON.stringify(['t1', 't2']), JSON.stringify(t.body));
  const p = await call('fct_paving_project_');
  assert('paving prefix returns its ids', JSON.stringify(p.body.ids) === JSON.stringify(['p1']), JSON.stringify(p.body));
  const k = await call('fct_kiewit_project_');
  assert('kiewit prefix returns its ids', JSON.stringify(k.body.ids) === JSON.stringify(['k1', 'k2']), JSON.stringify(k.body));

  console.log('\n[the underscore-wildcard trap]');
  // In SQL LIKE, _ matches any single character, so 'fct_project_%' also
  // matches fct_projects_index and fct_projects. api/admin/sync-db.js carries
  // a NOT LIKE patch for exactly this. LEFT(...)= has no wildcards at all.
  assert('the index blob is not returned as a project id', !t.body.ids.includes('s_index'), JSON.stringify(t.body.ids));
  assert('the projects array blob is not returned either', !t.body.ids.some(id => id.startsWith('s')), JSON.stringify(t.body.ids));
  assert('turf prefix does not pick up paving or kiewit projects',
    !t.body.ids.includes('p1') && !t.body.ids.includes('k1'), JSON.stringify(t.body.ids));

  console.log('\n[deleted projects stay deleted]');
  assert('a tombstoned project id is not listed', !t.body.ids.includes('gone'), JSON.stringify(t.body.ids));

  console.log('\n[it is not a general key scanner]');
  for (const bad of ['fct_', '', 'auth_', 'fct_lists', 'fct_quarry_', '%']) {
    const r = await call(bad);
    assert(`prefix ${JSON.stringify(bad)} is rejected`, r.code === 400, JSON.stringify(r.body));
  }
  assert('unrelated blobs never appear', !t.body.ids.concat(p.body.ids, k.body.ids).some(id => /lists|auth/.test(id)));

  console.log('\n[scoping]');
  assert('another company\'s projects are not returned', !t.body.ids.includes('x1'), JSON.stringify(t.body.ids));
  authPayload = { companyCode: 'OTHERCO', isPlatformAdmin: true };
  const other = await call('fct_project_');
  assert('switching company switches the result set',
    JSON.stringify(other.body.ids) === JSON.stringify(['x1']), JSON.stringify(other.body));
  authPayload = { companyCode: 'ACME', isPlatformAdmin: true };

  console.log('\n[division access still applies]');
  denyDivision = 'paving';
  const denied = await call('fct_paving_project_');
  assert('a user without paving access is refused', denied.code === 403, JSON.stringify(denied.body));
  const stillOk = await call('fct_project_');
  assert('  and turf still works for them', stillOk.code === 200 || stillOk.body.ids.length === 2);
  denyDivision = null;

  Module._load = orig;

  console.log('\n[bid_items mirror is written for turf only]');
  const src = require('fs').readFileSync(path.join(API, 'bid-items.js'), 'utf8');
  assert('the mirror write is gated on the turf prefix',
    /const mirrorsToNormalized = projectKey\.startsWith\('fct_project_'\);/.test(src)
    && /if \(mirrorsToNormalized\) try \{/.test(src));
  assert('  the endpoint still accepts all three divisions',
    /\^fct_\(project\|paving_project\|kiewit_project\)_/.test(src));
  assert('  and the comment no longer promises a reconcile that never comes',
    !/next full saveProject will reconcile via syncProjects/.test(src));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
