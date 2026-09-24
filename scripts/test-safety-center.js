#!/usr/bin/env node
'use strict';
// A DATE is the axis this whole division files on, and a week that slides a
// day depending on where the server happens to run would file two copies of
// one tailgate meeting. Pin the clock east of Greenwich so the assertions
// below actually discriminate instead of passing by geography. Set before
// anything touches a Date.
process.env.TZ = 'Europe/Berlin';
/**
 * The Safety Center: api/lib/safety.js, the two endpoints, and safety.html.
 *
 * Run: node scripts/test-safety-center.js
 * No DB or server required. The neon driver is stubbed with an in-memory
 * store, the two network calls in api/lib/storage.js are stubbed and the rest
 * of that module runs for real, and the page is driven in jsdom — reading a
 * page as text cannot tell whether it works.
 *
 * Auth is NOT stubbed. Real JWTs are signed against a test secret and go in
 * through requireAuth, because every rule worth pinning here is a rule about
 * who may do what, and a stub that waves callers through would let the whole
 * file pass with no gate at all.
 *
 * Six things are worth pinning, in descending order of how quietly they would
 * break:
 *
 * 1. A SIGNATURE IS A RECORD, AND RECORDS DO NOT MOVE. Signing twice does not
 *    write a second row or restamp the first: the moment somebody signed is a
 *    fact about the past. The unique index is the backstop; the endpoint
 *    answers the second tap with the first signature rather than an error,
 *    because a second tap on a jobsite connection is the likeliest way it
 *    happens.
 *
 * 2. THE ACKNOWLEDGEMENT IS THE SIGNATURE. A row written without the box
 *    ticked would be a record that somebody opened a file, which is not what
 *    the report claims each row means. The sentence agreed to is stored beside
 *    the row so re-wording the page later cannot rewrite what people agreed to.
 *
 * 3. OUTSTANDING IS THE ROSTER MINUS WHO SIGNED — never a countdown from the
 *    roster. Somebody who signed and has since left the division is not
 *    outstanding, and counting the other way round would put them back on the
 *    list every week forever.
 *
 * 4. THE REPORT IS THE SUPERVISOR'S. A laborer's own screen carries their own
 *    state and no counts: being told "3 of 11 have signed" is being shown the
 *    report through the back door, and the crew's screen is a list of what
 *    they owe rather than a roll-call of who is behind.
 *
 * 5. THE FILE UNDER A SIGNED DOCUMENT IS NOT REPLACEABLE. The storage key is
 *    recomputed rather than trusted, and the shared upload endpoint refuses to
 *    delete or overwrite a key the Safety Center has registered — otherwise
 *    every signature already collected would quietly describe different bytes.
 *
 * 6. ACCESS IS THE ROW, NOT THE TOKEN. A token is a thirty-day snapshot of
 *    sign-in and Manage Users only ever writes the row, so somebody granted the
 *    division after they last signed in was refused everything until they
 *    signed out — while the report, which reads the row, listed them as owing
 *    a signature. Every other caller in this file carries a token signed from
 *    the same map as its row, which is the one case where it makes no
 *    difference which of the two the endpoints read; only the tests that pull
 *    the two apart can tell.
 */

const path   = require('path');
const fs     = require('fs');
const Module = require('module');
const { JSDOM } = require('jsdom');

process.env.JWT_SECRET          = 'safety-center-test-secret';
process.env.DATABASE_URL        = 'postgres://stub/stub';
// Real presigning, fake credentials. buildKey and presignDownload run for
// real — the key-mismatch test below is only worth anything if the key the
// endpoint recomputes is built by the same code that minted the original.
process.env.S3_ENDPOINT         = 'https://acct.r2.cloudflarestorage.com';
process.env.S3_BUCKET           = 'forcecorp-documents';
process.env.S3_ACCESS_KEY_ID    = 'test-key-id';
process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key';

const root = f => path.resolve(__dirname, '..', f);
const read = f => fs.readFileSync(root(f), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── The fake database ──────────────────────────────────────────────────────
// An in-memory stand-in shaped like the three tables these endpoints touch.
// Faithful enough that the assertions are about the endpoints rather than
// about the mock: every filter the real SQL applies is applied here too.
//
// It must also answer in the TYPES the real driver answers in, which is not a
// detail. @neondatabase/serverless applies the standard pg parsers, so a DATE
// column comes back as a JS Date at LOCAL midnight — never the string that was
// inserted. A mock that hands back the string leaves the only branch
// production ever takes unexecuted by every assertion in this file, which is
// exactly how a week that reads a day early shipped once already.
function pgDate(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);            // local midnight, as the parser gives
}
// What Postgres actually STORES when a value is bound to a DATE column. A JS
// Date is serialised as a UTC instant, so its UTC date part is what lands —
// which is NOT the calendar day the driver read out of that same column. A
// mock that quietly round-tripped the Date could not see an edit path that
// rewinds the week a day every time it is saved.
function bindDate(v) {
  return pgDate(v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
}

// And back again the way Postgres compares them: by the calendar day, not
// through UTC.
function ymd(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0')
         + '-' + String(v.getDate()).padStart(2, '0');
  }
  return String(v).slice(0, 10);
}
const DB = { docs: [], sigs: [], users: [], nextSigId: 1, calls: [], failUserRead: false };
// requireAuth's read of the caller's account (api/lib/auth.js currentAccess).
const USER_READ = /^SELECT u\.division_roles, .* FROM users u JOIN companies c ON c\.code = u\.company_code WHERE u\.id =/;

function resetDb() {
  DB.docs = []; DB.sigs = []; DB.users = []; DB.nextSigId = 1; DB.calls = [];
  DB.failUserRead = false;
}

function sql(strings, ...values) {
  const q = Array.isArray(strings) ? strings.join('?') : String(strings);
  const flat = q.replace(/\s+/g, ' ').trim();
  DB.calls.push({ q: flat, values });
  const v = values;

  // ── users ──
  // The caller's own account, which requireAuth reads on every request and
  // access is decided on. Answers only for the id asked about — a mock that
  // handed back any row would let an endpoint that read the wrong one pass.
  if (USER_READ.test(flat)) {
    if (DB.failUserRead) return Promise.reject(new Error('Connection terminated unexpectedly'));
    return Promise.resolve(DB.users
      .filter(u => u.id === v[0])
      .slice(0, 1)
      .map(u => ({
        division_roles: u.division_roles, divisions: u.divisions || null, role: u.role || 'level1',
        is_platform_admin: Boolean(u.is_platform_admin), company_code: u.company_code,
        allowed_divisions: null,
      })));
  }
  if (/^SELECT id, username, division_roles FROM users/.test(flat)) {
    const [companyCode, divKey] = v;
    return Promise.resolve(DB.users
      .filter(u => u.company_code === companyCode
                && u.division_roles
                && (u.division_roles[divKey] || 'no_access') !== 'no_access')
      .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()))
      .map(u => ({ id: u.id, username: u.username, division_roles: u.division_roles })));
  }

  // ── safety_documents ──
  if (/^SELECT COUNT\(\*\)::int AS unsigned_by_me/.test(flat)) {
    const [companyCode, sigCompany, userId] = v;
    const n = DB.docs
      .filter(d => d.company_code === companyCode && !d.archived_at)
      .filter(d => !DB.sigs.some(sg => sg.document_id === d.id
                                    && sg.company_code === sigCompany
                                    && sg.user_id === userId))
      .length;
    return Promise.resolve([{ unsigned_by_me: n }]);
  }
  if (/^SELECT id FROM safety_documents WHERE storage_key/.test(flat)) {
    return Promise.resolve(DB.docs.filter(d => d.storage_key === v[0]).map(d => ({ id: d.id })));
  }
  if (/^SELECT id, filename, content_type, storage_key, archived_at FROM safety_documents/.test(flat)) {
    return Promise.resolve(DB.docs.filter(d => d.id === v[0] && d.company_code === v[1]));
  }
  if (/^SELECT id, title FROM safety_documents/.test(flat)) {
    return Promise.resolve(DB.docs.filter(d =>
      d.id === v[0] && d.company_code === v[1] && !d.archived_at));
  }
  if (/^SELECT \* FROM safety_documents WHERE id =/.test(flat)) {
    return Promise.resolve(DB.docs.filter(d => d.id === v[0] && d.company_code === v[1]));
  }
  if (/^SELECT \* FROM safety_documents WHERE company_code/.test(flat)) {
    const [companyCode, withArchived, from, to] = v;
    return Promise.resolve(DB.docs
      .filter(d => d.company_code === companyCode)
      .filter(d => withArchived || !d.archived_at)
      .filter(d => ymd(d.week_of) >= from && ymd(d.week_of) <= to)
      .sort((a, b) => (ymd(b.week_of).localeCompare(ymd(a.week_of))) || (b.uploaded_at - a.uploaded_at)));
  }
  if (/^INSERT INTO safety_documents/.test(flat)) {
    const [id, company_code, title, description, week_of, filename,
           content_type, size_bytes, storage_key, uploaded_by] = v;
    if (DB.docs.some(d => d.id === id)) {
      return Promise.reject(new Error('duplicate key value violates unique constraint'));
    }
    const row = {
      id, company_code, title, description, week_of: bindDate(week_of), filename, content_type,
      size_bytes, storage_key, uploaded_by,
      uploaded_at: new Date(), updated_at: new Date(), archived_at: null, archived_by: null,
    };
    DB.docs.push(row);
    return Promise.resolve([row]);
  }
  if (/^UPDATE safety_documents SET title/.test(flat)) {
    const [title, description, week_of, id, company_code] = v;
    const row = DB.docs.find(d => d.id === id && d.company_code === company_code);
    if (!row) return Promise.resolve([]);
    Object.assign(row, { title, description, week_of: bindDate(week_of), updated_at: new Date() });
    return Promise.resolve([row]);
  }
  if (/^UPDATE safety_documents SET archived_at = NOW\(\)/.test(flat)) {
    const [archived_by, id, company_code] = v;
    const row = DB.docs.find(d => d.id === id && d.company_code === company_code);
    if (!row) return Promise.resolve([]);
    Object.assign(row, { archived_at: new Date(), archived_by });
    return Promise.resolve([row]);
  }
  if (/^UPDATE safety_documents SET archived_at = NULL/.test(flat)) {
    const [id, company_code] = v;
    const row = DB.docs.find(d => d.id === id && d.company_code === company_code);
    if (!row) return Promise.resolve([]);
    Object.assign(row, { archived_at: null, archived_by: null });
    return Promise.resolve([row]);
  }

  // ── safety_signatures ──
  if (/^SELECT document_id, full_name, signed_at FROM safety_signatures/.test(flat)) {
    return Promise.resolve(DB.sigs
      .filter(s => s.company_code === v[0] && s.user_id === v[1])
      .map(s => ({ document_id: s.document_id, full_name: s.full_name, signed_at: s.signed_at })));
  }
  if (/^SELECT document_id, COUNT\(\*\)/.test(flat)) {
    const [companyCode, rosterIds] = v;
    const tally = {};
    DB.sigs
      .filter(s => s.company_code === companyCode)
      .filter(s => !rosterIds || rosterIds.includes(s.user_id))
      .forEach(s => { tally[s.document_id] = (tally[s.document_id] || 0) + 1; });
    return Promise.resolve(Object.entries(tally).map(([document_id, signed]) => ({ document_id, signed })));
  }
  if (/^SELECT \* FROM safety_signatures WHERE document_id/.test(flat)) {
    return Promise.resolve(DB.sigs.filter(s => s.document_id === v[0] && s.user_id === v[1]));
  }
  if (/FROM safety_signatures WHERE company_code .* ANY/.test(flat)) {
    const [companyCode, ids] = v;
    const withImage = /signature_image,/.test(flat);
    return Promise.resolve(DB.sigs
      .filter(s => s.company_code === companyCode && ids.includes(s.document_id))
      .sort((a, b) => a.signed_at - b.signed_at)
      .map(s => {
        // Mirror the column list the endpoint actually asks for. A mock that
        // always returned every column could not tell a report that carries
        // 2,000 base64 PNGs from one that does not.
        const row = {
          id: s.id, document_id: s.document_id, user_id: s.user_id, username: s.username,
          full_name: s.full_name, statement: s.statement, signed_at: s.signed_at,
          has_drawn: s.signature_image != null,
        };
        if (withImage) row.signature_image = s.signature_image;
        return row;
      }));
  }
  if (/^SELECT s\.\*, d\.title, d\.week_of/.test(flat)) {
    const [companyCode, userId] = v;
    return Promise.resolve(DB.sigs
      .filter(s => s.company_code === companyCode && s.user_id === userId)
      .map(s => {
        const d = DB.docs.find(x => x.id === s.document_id) || {};
        return { ...s, title: d.title, week_of: d.week_of };
      })
      .sort((a, b) => b.signed_at - a.signed_at));
  }
  if (/^INSERT INTO safety_signatures/.test(flat)) {
    const [company_code, document_id, user_id, username, full_name,
           signature_image, statement, ip_address, user_agent] = v;
    if (DB.sigs.some(s => s.document_id === document_id && s.user_id === user_id)) {
      return Promise.reject(new Error('duplicate key value violates unique constraint "idx_safety_sig_once"'));
    }
    const row = {
      id: DB.nextSigId++, company_code, document_id, user_id, username, full_name,
      signature_image, acknowledged: true, statement, ip_address, user_agent,
      signed_at: new Date(),
    };
    DB.sigs.push(row);
    return Promise.resolve([row]);
  }

  throw new Error('unhandled query: ' + flat.slice(0, 120));
}

// ── Module wiring ──────────────────────────────────────────────────────────
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => sql };
  return origLoad.apply(this, arguments);
};

const jwt      = require('jsonwebtoken');
const storage  = require(root('api/lib/storage.js'));
const safetyLib = require(root('api/lib/safety.js'));
const docsHandler = require(root('api/safety-documents.js'));
const sigHandler  = require(root('api/safety-signatures.js'));
const uploadHandler = require(root('api/document-upload-url.js'));

// The only two things in api/lib/storage.js that touch the network. Everything
// else — key building, MIME resolution, SigV4 presigning — runs for real.
let HEAD_ANSWER = { exists: true, size: 120 * 1024, contentType: 'application/pdf' };
const DELETED_KEYS = [];
storage.headObject   = async () => HEAD_ANSWER;
storage.deleteObject = async key => { DELETED_KEYS.push(key); return true; };

// ── Callers ────────────────────────────────────────────────────────────────
const COMPANY = 'FCT';

// The document ids are real uuids because registration now insists on one —
// the id is caller-supplied, echoed back, and rendered, and the storage-key
// comparison is not a check on it (buildKey sanitises both sides, so any
// string at all produces a matching key). Fixed rather than generated so the
// assertions stay deterministic.
const DOC1 = '11111111-1111-4111-8111-111111111111';
const DOC2 = '22222222-2222-4222-8222-222222222222';
function tokenFor(user) {
  return jwt.sign({
    userId: user.id, username: user.username, companyCode: COMPANY,
    divisionRoles: user.division_roles, isPlatformAdmin: Boolean(user.isPlatformAdmin),
    // Only set by the tests that need a legacy division list on the token;
    // left undefined, it is dropped from the payload like it never existed.
    allowedDivisions: user.allowedDivisions,
    role: 'level1',
  }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const SUPER  = { id: 1, username: 'dsimmons', division_roles: { safety: 'level3' } };
const LAB_A  = { id: 2, username: 'jhauser',  division_roles: { safety: 'level1', timesheet: 'level1' } };
const LAB_B  = { id: 3, username: 'mreyes',   division_roles: { safety: 'level1' } };
const LAB_C  = { id: 4, username: 'twhite',   division_roles: { safety: 'level1' } };
const OFFICE = { id: 5, username: 'bookkeep', division_roles: { payroll: 'level3' } };
const PLATFORM = { id: 6, username: 'root', division_roles: null, isPlatformAdmin: true };

// The platform admin has a row like anyone else — access is read from it — but
// no role map, so the roster query passes over them.
function seedUsers() {
  DB.users = [SUPER, LAB_A, LAB_B, LAB_C, OFFICE, PLATFORM].map(u => ({
    id: u.id, username: u.username, company_code: COMPANY, division_roles: u.division_roles,
    is_platform_admin: Boolean(u.isPlatformAdmin),
  }));
}

// What Manage Users has done since a caller signed in. Replaces fields on the
// row rather than editing the role map in place: seeded rows share their map
// with the caller constants, so an in-place edit would rewrite the TOKEN too
// and the test would be comparing the row with itself.
function setRow(id, fields) {
  const row = DB.users.find(u => u.id === id);
  if (!row) throw new Error('no seeded row for user ' + id);
  Object.assign(row, fields);
}

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, val) { this.headers[k] = val; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

async function call(handler, user, { method = 'GET', query = {}, body = undefined, headers = {} } = {}) {
  const res = makeRes();
  await handler({
    method, query, body,
    headers: { authorization: 'Bearer ' + tokenFor(user), ...headers },
  }, res);
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The pure helpers
// ═══════════════════════════════════════════════════════════════════════════
function helperTests() {
  console.log('\n[two levels, one division]');
  const caps = u => safetyLib.safetyCapabilities({
    divisionRoles: u.division_roles, isPlatformAdmin: Boolean(u.isPlatformAdmin),
  });

  assert('a laborer may view and sign',       caps(LAB_A).canView && !caps(LAB_A).canManage);
  assert('a supervisor may run the division', caps(SUPER).canManage && caps(SUPER).canView);
  assert('  and is a signer too, not just a reader of the report',
    caps(SUPER).canView, 'the supervisor conducts the meeting and signs it');
  assert('an admin runs it as well',
    caps({ division_roles: { safety: 'admin' } }).canManage);
  // level2 is not on the user form but a role map can still carry it. Guessing
  // at it in each endpoint is how one of them would guess "supervisor".
  assert('level2 reads as a signer, never a supervisor',
    caps({ division_roles: { safety: 'level2' } }).canView &&
    !caps({ division_roles: { safety: 'level2' } }).canManage);
  assert('somebody without the division gets nothing',
    !caps(OFFICE).canView && !caps(OFFICE).canManage);
  assert('no_access is not access',
    !caps({ division_roles: { safety: 'no_access' } }).canView);
  assert('a platform admin with no safety role set runs it', caps(PLATFORM).canManage);

  // The bug this pins: a platform admin explicitly set to "Read & sign" was
  // resolved as 'admin' anyway, because levelFor() in api/lib/auth.js answers
  // for the flag before it looks at the roles. The account had been told it
  // was crew and was handed the upload form and the whole sign-off report.
  {
    const named = { division_roles: { safety: 'level1' }, isPlatformAdmin: true };
    assert('an EXPLICIT grant beats the platform-admin default',
      caps(named).canManage === false && caps(named).level === 'level1',
      JSON.stringify(caps(named)));
    assert('  and they can still read and sign, which is what they were given',
      caps(named).canView === true);
    const sup = { division_roles: { safety: 'level3' }, isPlatformAdmin: true };
    assert('  an explicit supervisor grant still runs the division',
      caps(sup).canManage === true && caps(sup).level === 'level3');
    const silent = { division_roles: { turf: 'admin' }, isPlatformAdmin: true };
    assert('  and saying nothing about safety still leaves them in charge of it',
      caps(silent).canManage === true,
      'nobody should be locked out of a division they administer');
    // The rule narrows one account rather than widening any, so it cannot hand
    // somebody access they did not have.
    assert('  while no ordinary account gains anything from the rule',
      caps({ division_roles: { safety: 'level1' } }).canManage === false
      && caps({ division_roles: { safety: 'no_access' } }).canView === false);
  }

  // The page decides what to DRAW with its own copy of that rule. The two
  // disagreeing means a screen that offers what the server refuses.
  {
    const src = read('safety.html');
    const m = /const myLevel = \(\(\) => \{([\s\S]*?)\}\)\(\);/.exec(src);
    assert('the page carries the same rule', !!m);
    if (m) {
      const pageLevel = new Function('user', 'DIVISION',
        `const myLevel = (() => {${m[1]}})(); return myLevel;`);
      const table = [
        [{ divisionRoles: { safety: 'level1' }, isPlatformAdmin: true },  'level1'],
        [{ divisionRoles: { safety: 'level3' }, isPlatformAdmin: true },  'level3'],
        [{ divisionRoles: { turf: 'admin' },    isPlatformAdmin: true },  'admin'],
        [{ divisionRoles: { safety: 'level1' }, isPlatformAdmin: false }, 'level1'],
        [{ divisionRoles: null,                 isPlatformAdmin: true },  'admin'],
      ];
      const off = table.filter(([u, want]) => pageLevel(u, 'safety') !== want);
      assert('  and resolves every account the same way the server does',
        off.length === 0,
        off.map(([u, want]) => `${JSON.stringify(u)} page=${pageLevel(u, 'safety')} want=${want}`).join('; '));
    }
  }

  console.log('\n[a week means one date]');
  const M = safetyLib.mondayOf;
  assert('a Monday is already the Monday',      M('2026-09-14') === '2026-09-14', M('2026-09-14'));
  assert('a Wednesday files to that Monday',    M('2026-09-16') === '2026-09-14', M('2026-09-16'));
  assert('a Friday files to the same Monday',   M('2026-09-18') === '2026-09-14', M('2026-09-18'));
  // Sunday is the trap: every naive "subtract getDay()" lands it on the Monday
  // AFTER the week that was actually worked, filing Sunday's paperwork a week
  // ahead of the meeting it came from.
  assert('a Sunday belongs to the week just ended',
    M('2026-09-20') === '2026-09-14', M('2026-09-20'));
  assert('  and the Monday after it starts the next one',
    M('2026-09-21') === '2026-09-21', M('2026-09-21'));
  assert('it survives a year boundary',         M('2027-01-01') === '2026-12-28', M('2027-01-01'));
  assert('nonsense is refused rather than guessed', M('not-a-date') === null);
  assert('a blank is refused',                  M('') === null && M(null) === null);
  assert('a timestamp is taken by its date',    M('2026-09-16T23:30:00Z') === '2026-09-14');

  console.log('\n[who is expected to sign]');
  resetDb(); seedUsers();
  return safetyLib.requiredSigners(sql, COMPANY).then(roster => {
    const names = roster.map(r => r.username).join(',');
    assert('everyone granted the division is on the roster',
      names === 'dsimmons,jhauser,mreyes,twhite', names);
    assert('  and somebody without it is not', !names.includes('bookkeep'));
    assert('  listed in a stable order a supervisor can read down',
      names === roster.map(r => r.username).sort().join(','));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Posting a document
// ═══════════════════════════════════════════════════════════════════════════
const GOOD_FILE = 'tailgate-trenching.pdf';
function keyFor(id, filename = GOOD_FILE) {
  return storage.buildKey({
    companyCode: COMPANY, division: 'safety', projectId: null, documentId: id, filename,
  });
}
function postBody(id, over = {}) {
  return {
    documentId: id, filename: GOOD_FILE, storageKey: keyFor(id),
    title: 'Tailgate — Trenching & Excavation', weekOf: '2026-09-16', ...over,
  };
}

async function uploadTests() {
  console.log('\n[only a supervisor posts, and only a document]');
  resetDb(); seedUsers();
  HEAD_ANSWER = { exists: true, size: 120 * 1024, contentType: 'application/pdf' };

  {
    const r = await call(docsHandler, LAB_A, { method: 'POST', body: postBody(DOC1) });
    assert('a laborer cannot post a document', r.statusCode === 403, String(r.statusCode));
    assert('  and nothing was written', DB.docs.length === 0);
  }
  {
    const r = await call(docsHandler, OFFICE, { method: 'POST', body: postBody(DOC1) });
    assert('somebody outside the division cannot even look', r.statusCode === 403, String(r.statusCode));
  }
  {
    const r = await call(docsHandler, SUPER, { method: 'POST', body: postBody(DOC1, { title: '   ' }) });
    assert('an untitled document is refused', r.statusCode === 400, String(r.statusCode));
  }
  {
    const r = await call(docsHandler, SUPER, { method: 'POST', body: postBody(DOC1, { weekOf: 'whenever' }) });
    assert('a document with no week is refused', r.statusCode === 400, String(r.statusCode));
  }
  {
    // The storage allowlist would take a .docx happily. This division will not:
    // the crew signs that they read THE DOCUMENT, and a spreadsheet that opens
    // in a download prompt is not a document anyone read on their phone.
    const r = await call(docsHandler, SUPER, {
      method: 'POST',
      body: postBody(DOC1, { filename: 'tailgate.docx', storageKey: keyFor(DOC1, 'tailgate.docx') }),
    });
    assert('a Word file is refused even though storage would take it',
      r.statusCode === 400 && /PDF/.test(r.body.error), JSON.stringify(r.body));
  }
  {
    // A prefix test would admit this. The key is recomputed instead, so a
    // hand-crafted one cannot aim the registration at another company's prefix.
    const r = await call(docsHandler, SUPER, {
      method: 'POST',
      body: postBody(DOC1, { storageKey: `${COMPANY}/safety/../../OTH/safety/d1/${GOOD_FILE}` }),
    });
    assert('a hand-crafted storage key is refused',
      r.statusCode === 400 && /storageKey/.test(r.body.error), JSON.stringify(r.body));
  }
  {
    HEAD_ANSWER = { exists: false, size: 0, contentType: null };
    const r = await call(docsHandler, SUPER, { method: 'POST', body: postBody(DOC1) });
    assert('a registration with no file behind it is refused',
      r.statusCode === 409, String(r.statusCode));
    HEAD_ANSWER = { exists: true, size: 120 * 1024, contentType: 'application/pdf' };
  }
  {
    // The declared size is not evidence of anything: the presigned PUT signs
    // only `host`, so the store takes a body of any length. What is stored is
    // what the store says it holds.
    HEAD_ANSWER = { exists: true, size: 600 * 1024 * 1024, contentType: 'application/pdf' };
    DELETED_KEYS.length = 0;
    const r = await call(docsHandler, SUPER, { method: 'POST', body: postBody(DOC1) });
    assert('a file over the ceiling is refused whatever the caller declared',
      r.statusCode === 413, String(r.statusCode));
    assert('  and the oversized bytes are dropped rather than left unreferenced',
      DELETED_KEYS.includes(keyFor(DOC1)), DELETED_KEYS.join(','));
    HEAD_ANSWER = { exists: true, size: 120 * 1024, contentType: 'application/pdf' };
  }
  {
    // The id is caller-supplied, stored, and rendered back into every crew
    // member's page. The storage-key comparison below is NOT a check on it:
    // buildKey() sanitises the id on both sides, so any string at all produces
    // a matching key. It is only ever the uuid the upload ticket minted.
    const evil = `x');alert(1);//`;
    const r = await call(docsHandler, SUPER, {
      method: 'POST',
      body: postBody(evil, { documentId: evil, storageKey: keyFor(evil) }),
    });
    assert('a documentId that is not the uuid the ticket minted is refused',
      r.statusCode === 400 && /upload id/.test(r.body.error), JSON.stringify(r.body));
    assert('  even though its storage key matches, because the key is sanitised',
      keyFor(evil) === storage.buildKey({
        companyCode: COMPANY, division: 'safety', projectId: null,
        documentId: evil, filename: GOOD_FILE,
      }));
    assert('  and nothing was written', DB.docs.length === 0, String(DB.docs.length));
  }
  {
    const r = await call(docsHandler, SUPER, { method: 'POST', body: postBody(DOC1) });
    assert('a supervisor posts the week\'s form', r.statusCode === 201, JSON.stringify(r.body));
    const doc = r.body.document;
    assert('  filed to the Monday of the week they picked',
      doc.weekOf === '2026-09-14', doc.weekOf);
    assert('  with the size the STORE reports, not the one the browser claimed',
      DB.docs[0].size_bytes === 120 * 1024, String(DB.docs[0].size_bytes));
    assert('  and stamped with who posted it',
      doc.uploadedBy === 'dsimmons', String(doc.uploadedBy));
  }
  {
    const r = await call(docsHandler, SUPER, { method: 'POST', body: postBody(DOC1) });
    assert('the same document cannot be registered twice', r.statusCode === 409, String(r.statusCode));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Signing
// ═══════════════════════════════════════════════════════════════════════════
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

async function seedTwoDocs() {
  resetDb(); seedUsers();
  HEAD_ANSWER = { exists: true, size: 120 * 1024, contentType: 'application/pdf' };
  await call(docsHandler, SUPER, { method: 'POST', body: postBody(DOC1) });
  await call(docsHandler, SUPER, {
    method: 'POST',
    body: postBody(DOC2, { title: 'Tailgate — Heat Illness', weekOf: '2026-09-21' }),
  });
}

async function signTests() {
  console.log('\n[the acknowledgement is the signature]');
  await seedTwoDocs();

  {
    const r = await call(sigHandler, LAB_A, {
      method: 'POST', body: { documentId: DOC1, fullName: 'Jesse Hauser', acknowledged: false },
    });
    assert('an unticked box does not sign anything', r.statusCode === 400, String(r.statusCode));
    assert('  and no row was written', DB.sigs.length === 0);
  }
  {
    const r = await call(sigHandler, LAB_A, {
      method: 'POST', body: { documentId: DOC1, fullName: 'J', acknowledged: true },
    });
    assert('a name too short to be one is refused', r.statusCode === 400, String(r.statusCode));
  }
  {
    // This string is rendered back into an <img> on the report. Anything but a
    // PNG data URL is refused HERE rather than at the point it is displayed,
    // where one missed template would be an injection.
    for (const bad of [
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'javascript:alert(1)',
      'https://example.test/sig.png',
      'data:image/png;base64,<script>alert(1)</script>',
    ]) {
      const r = await call(sigHandler, LAB_A, {
        method: 'POST',
        body: { documentId: DOC1, fullName: 'Jesse Hauser', acknowledged: true, signatureImage: bad },
      });
      assert(`a signature image that is not a PNG data URL is refused (${bad.slice(0, 24)}…)`,
        r.statusCode === 400, String(r.statusCode));
    }
  }
  {
    const r = await call(sigHandler, LAB_A, {
      method: 'POST',
      body: { documentId: DOC1, fullName: '  Jesse   Hauser ', acknowledged: true, signatureImage: PNG },
    });
    assert('a laborer signs', r.statusCode === 201, JSON.stringify(r.body));
    assert('  with their name tidied rather than rejected',
      r.body.signature.fullName === 'Jesse Hauser', r.body.signature.fullName);
    const row = DB.sigs[0];
    assert('  and the sentence they agreed to is stored beside the row',
      typeof row.statement === 'string' && /read this document in full/.test(row.statement),
      String(row.statement));
    assert('  which is the same sentence the page is told to show',
      row.statement === sigHandler._test.STATEMENT);
    assert('  the drawn mark is kept', row.signature_image === PNG);
    assert('  and the time is the server\'s, not the browser\'s',
      row.signed_at instanceof Date);
  }
  {
    const before = DB.sigs[0].signed_at;
    const r = await call(sigHandler, LAB_A, {
      method: 'POST', body: { documentId: DOC1, fullName: 'Jesse Hauser', acknowledged: true },
    });
    assert('signing twice is not an error', r.statusCode === 200, String(r.statusCode));
    assert('  it answers with the signature already on file',
      r.body.alreadySigned === true, JSON.stringify(r.body));
    assert('  no second row is written', DB.sigs.length === 1, String(DB.sigs.length));
    assert('  and the first timestamp does not move',
      DB.sigs[0].signed_at === before, 'a record of the past does not get restamped');
  }
  {
    const r = await call(sigHandler, OFFICE, {
      method: 'POST', body: { documentId: DOC1, fullName: 'Book Keeper', acknowledged: true },
    });
    assert('somebody without the division cannot sign', r.statusCode === 403, String(r.statusCode));
  }
  {
    const r = await call(sigHandler, LAB_B, {
      method: 'POST', body: { documentId: 'nope', fullName: 'Marco Reyes', acknowledged: true },
    });
    assert('a document that does not exist cannot be signed', r.statusCode === 404, String(r.statusCode));
  }
  {
    await call(docsHandler, SUPER, { method: 'DELETE', query: { id: DOC2 } });
    const r = await call(sigHandler, LAB_B, {
      method: 'POST', body: { documentId: DOC2, fullName: 'Marco Reyes', acknowledged: true },
    });
    assert('an archived document cannot be signed', r.statusCode === 404, String(r.statusCode));
    await call(docsHandler, SUPER, { method: 'DELETE', query: { id: DOC2, restore: '1' } });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. The two screens: what each side is shown
// ═══════════════════════════════════════════════════════════════════════════
async function listAndReportTests() {
  console.log('\n[the crew see what they owe; the supervisor sees who owes it]');
  await seedTwoDocs();
  await call(sigHandler, LAB_A, { method: 'POST', body: { documentId: DOC1, fullName: 'Jesse Hauser', acknowledged: true } });
  await call(sigHandler, LAB_B, { method: 'POST', body: { documentId: DOC1, fullName: 'Marco Reyes', acknowledged: true } });

  {
    const r = await call(docsHandler, LAB_A, {});
    const byId = Object.fromEntries(r.body.documents.map(d => [d.id, d]));
    assert('a laborer sees every live document', r.body.documents.length === 2, String(r.body.documents.length));
    assert('  the one they signed is marked signed', byId[DOC1].signedByMe === true);
    assert('  with the name and time they signed under',
      byId[DOC1].mySignature && byId[DOC1].mySignature.fullName === 'Jesse Hauser');
    assert('  and the one they have not is not', byId[DOC2].signedByMe === false);
    // Being told "2 of 4 have signed" is the report through the back door.
    assert('  no count of anyone else reaches them',
      byId[DOC1].signedCount === undefined && byId[DOC1].expectedCount === undefined,
      JSON.stringify(byId[DOC1]));
    assert('  and they are told plainly they may not manage',
      r.body.permissions.canManage === false && r.body.permissions.canSign === true);
  }
  {
    const r = await call(docsHandler, SUPER, {});
    const d1 = r.body.documents.find(d => d.id === DOC1);
    assert('a supervisor gets the counts on the card',
      d1.signedCount === 2 && d1.expectedCount === 4 && d1.outstandingCount === 2,
      JSON.stringify(d1));
  }
  {
    const r = await call(sigHandler, LAB_A, { query: { scope: 'report' } });
    assert('a laborer cannot read the sign-off report', r.statusCode === 403, String(r.statusCode));
  }
  {
    const r = await call(sigHandler, LAB_A, { query: { documentId: DOC1 } });
    assert('  nor one document\'s worth of it', r.statusCode === 403, String(r.statusCode));
  }
  {
    const r = await call(sigHandler, LAB_A, {});
    assert('what a laborer CAN read is their own signatures',
      r.statusCode === 200 && r.body.signatures.length === 1, JSON.stringify(r.body));
    assert('  carried with the document they belong to',
      r.body.signatures[0].title === 'Tailgate — Trenching & Excavation',
      r.body.signatures[0].title);
  }
  {
    const r = await call(sigHandler, SUPER, { query: { scope: 'report' } });
    assert('the report comes back grouped by document', r.statusCode === 200 && r.body.documents.length === 2);
    const g = r.body.documents.find(x => x.document.id === DOC1);
    assert('  each group carrying the document\'s own title',
      g.document.title === 'Tailgate — Trenching & Excavation', g.document.title);
    const signed = g.signed.map(s => s.username).sort().join(',');
    assert('  who signed, with a timestamp each',
      signed === 'jhauser,mreyes' && g.signed.every(s => s.signedAt), signed);
    const out = g.outstanding.map(o => o.username).sort().join(',');
    assert('  and who has not', out === 'dsimmons,twhite', out);
    assert('  the two adding up to the roster',
      g.signedCount + g.outstandingCount === g.expectedCount,
      `${g.signedCount}+${g.outstandingCount} vs ${g.expectedCount}`);
    const g2 = r.body.documents.find(x => x.document.id === DOC2);
    assert('  a document nobody has signed shows the whole roster outstanding',
      g2.signedCount === 0 && g2.outstandingCount === 4, JSON.stringify(g2));
    assert('  newest week first, which is where a supervisor looks',
      r.body.documents[0].document.id === DOC2, r.body.documents[0].document.id);
  }
  {
    // The direction this is computed in is the whole point. Somebody who signed
    // and has since left the division is NOT outstanding — counting down from
    // today's roster instead of subtracting the signers would put them back on
    // the list every week forever.
    DB.users = DB.users.filter(u => u.username !== 'mreyes');
    const r = await call(sigHandler, SUPER, { query: { scope: 'report' } });
    const g = r.body.documents.find(x => x.document.id === DOC1);
    assert('somebody who signed and then left the division is not outstanding',
      !g.outstanding.some(o => o.username === 'mreyes'),
      g.outstanding.map(o => o.username).join(','));
    assert('  their signature is still on the record',
      g.signed.some(s => s.username === 'mreyes'));
    assert('  and the percentage cannot run over 100',
      g.percentSigned <= 100, String(g.percentSigned));
    seedUsers();
  }
  {
    const r = await call(sigHandler, SUPER, { query: { scope: 'report', from: '2026-09-21', to: '2026-09-25' } });
    assert('the report can be narrowed to a week',
      r.body.documents.length === 1 && r.body.documents[0].document.id === DOC2,
      String(r.body.documents.length));
  }
  {
    await call(docsHandler, SUPER, { method: 'DELETE', query: { id: DOC2 } });
    const crew = await call(docsHandler, LAB_C, {});
    assert('an archived document comes off the crew\'s list',
      crew.body.documents.length === 1, String(crew.body.documents.length));
    const rep = await call(sigHandler, SUPER, { query: { scope: 'report' } });
    assert('  and out of the default report',
      rep.body.documents.length === 1, String(rep.body.documents.length));
    const all = await call(sigHandler, SUPER, { query: { scope: 'report', include: 'archived' } });
    assert('  but a supervisor can still produce what was signed',
      all.body.documents.length === 2, String(all.body.documents.length));
    const crewArchived = await call(docsHandler, LAB_C, { query: { include: 'archived' } });
    assert('  and a laborer asking for archived ones simply gets the live list',
      crewArchived.body.documents.length === 1, String(crewArchived.body.documents.length));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4b. The badge and the report are the same claim, so they must be the same
//     number — and the record has to survive the people in it
// ═══════════════════════════════════════════════════════════════════════════
async function agreementTests() {
  console.log('\n[the card badge and the report cannot disagree]');
  await seedTwoDocs();

  // Everyone on the roster signs d1 EXCEPT twhite, and a platform admin — who
  // is never on the roster — signs it too.
  for (const u of [SUPER, LAB_A, LAB_B]) {
    await call(sigHandler, u, { method: 'POST', body: { documentId: DOC1, fullName: u.username + ' name', acknowledged: true } });
  }
  await call(sigHandler, PLATFORM, { method: 'POST', body: { documentId: DOC1, fullName: 'Root Admin', acknowledged: true } });

  {
    const card = (await call(docsHandler, SUPER, {})).body.documents.find(d => d.id === DOC1);
    const rep  = (await call(sigHandler, SUPER, { query: { scope: 'report' } }))
      .body.documents.find(g => g.document.id === DOC1);

    // A bare COUNT(*) here is 4 against a roster of 4, so the badge went green
    // and said the tailgate was signed off while the report still named twhite.
    assert('a signature from somebody off the roster does not inflate the badge',
      card.signedCount === 3, `signedCount=${card.signedCount}`);
    assert('  so the badge still shows the one person outstanding',
      card.outstandingCount === 1, `outstanding=${card.outstandingCount}`);
    assert('  and the badge agrees with the report, number for number',
      card.signedCount === rep.signedCount
      && card.outstandingCount === rep.outstandingCount
      && card.expectedCount === rep.expectedCount,
      `card=${card.signedCount}/${card.outstandingCount}/${card.expectedCount} `
      + `report=${rep.signedCount}/${rep.outstandingCount}/${rep.expectedCount}`);
    assert('  and the report\'s own three numbers add up',
      rep.signedCount + rep.outstandingCount === rep.expectedCount,
      `${rep.signedCount}+${rep.outstandingCount} vs ${rep.expectedCount}`);
  }
  {
    // The other way the two used to diverge: somebody signs, then loses the
    // division. They are not outstanding, and they no longer count as covered.
    DB.users = DB.users.filter(u => u.username !== 'mreyes');
    const card = (await call(docsHandler, SUPER, {})).body.documents.find(d => d.id === DOC1);
    const rep  = (await call(sigHandler, SUPER, { query: { scope: 'report' } }))
      .body.documents.find(g => g.document.id === DOC1);
    assert('a signer who has left the division drops out of both counts together',
      card.signedCount === rep.signedCount && card.outstandingCount === rep.outstandingCount,
      `card=${card.signedCount}/${card.outstandingCount} report=${rep.signedCount}/${rep.outstandingCount}`);
    assert('  and their signature is still on the record',
      rep.signed.some(x => x.username === 'mreyes'));
    seedUsers();
  }

  console.log('\n[the drawn mark is retrievable, but not on every read]');
  await seedTwoDocs();
  await call(sigHandler, LAB_A, {
    method: 'POST',
    body: { documentId: DOC1, fullName: 'Jesse Hauser', acknowledged: true, signatureImage: PNG },
  });

  {
    // The all-documents report reads every signature the company has ever
    // recorded. Carrying a 128 KB base64 PNG on each one eventually stops the
    // report loading at all, to compute a boolean.
    const all = await call(sigHandler, SUPER, { query: { scope: 'report' } });
    const sig = all.body.documents.find(g => g.document.id === DOC1).signed[0];
    assert('the all-documents report does not carry the images',
      sig.signatureImage === undefined, JSON.stringify(sig).slice(0, 120));
    assert('  but still says which signatures have one', sig.hasDrawnSignature === true);
    const asked = DB.calls.filter(c => /FROM safety_signatures WHERE company_code .* ANY/.test(c.q));
    assert('  because the query does not ask for the column',
      asked.length > 0 && asked.every(c => !/signature_image,/.test(c.q)),
      asked.map(c => c.q.slice(0, 60)).join(' | '));
  }
  {
    // ...and it has to be reachable somewhere, or asking the crew to draw it
    // was asking for something nobody can ever produce.
    const one = await call(sigHandler, SUPER, { query: { documentId: DOC1 } });
    const sig = one.body.documents[0].signed[0];
    assert('reading ONE document does return the mark', sig.signatureImage === PNG, String(sig.signatureImage));
  }
  {
    const mine = await call(sigHandler, LAB_A, {});
    assert('and a laborer can see the mark they drew',
      mine.body.signatures[0].signatureImage === PNG);
  }
  {
    const echoed = await call(sigHandler, LAB_B, {
      method: 'POST',
      body: { documentId: DOC1, fullName: 'Marco Reyes', acknowledged: true, signatureImage: PNG },
    });
    assert('signing does not echo the image straight back',
      echoed.body.signature.signatureImage === undefined);
    assert('  though it confirms one was recorded',
      echoed.body.signature.hasDrawnSignature === true);
  }

  console.log('\n[a signature image has to actually be an image]');
  await seedTwoDocs();
  {
    // The data-URL regex proves only the SHAPE. Without a look at the bytes
    // this is 128 KB of padding stored against a name, once per document per
    // person, and it used to be accepted.
    const padding = 'data:image/png;base64,' + 'A'.repeat(4096);
    const r = await call(sigHandler, LAB_A, {
      method: 'POST',
      body: { documentId: DOC1, fullName: 'Jesse Hauser', acknowledged: true, signatureImage: padding },
    });
    assert('base64 padding shaped like a PNG data URL is refused',
      r.statusCode === 400, String(r.statusCode));
    assert('  and nothing was written', DB.sigs.length === 0, String(DB.sigs.length));
  }
  {
    const r = await call(sigHandler, LAB_A, {
      method: 'POST',
      body: { documentId: DOC1, fullName: 'Jesse Hauser', acknowledged: true, signatureImage: PNG },
    });
    assert('a real PNG header is accepted', r.statusCode === 201, JSON.stringify(r.body).slice(0, 120));
  }
  {
    const huge = 'data:image/png;base64,' + 'A'.repeat(200 * 1024);
    const r = await call(sigHandler, LAB_B, {
      method: 'POST',
      body: { documentId: DOC1, fullName: 'Marco Reyes', acknowledged: true, signatureImage: huge },
    });
    assert('and an oversized one is refused on size before anything else',
      r.statusCode === 413, String(r.statusCode));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4c. Access is what Manage Users says now, not what the token said at sign-in
// ═══════════════════════════════════════════════════════════════════════════
const DOC3 = '33333333-3333-4333-8333-333333333333';
const ticketFor = user => call(uploadHandler, user, {
  method: 'POST', query: { division: 'safety' }, body: { filename: GOOD_FILE },
});

async function currentAccessTests() {
  console.log('\n[access is what Manage Users says now, not what the token said at sign-in]');
  await seedTwoDocs();

  {
    // The baseline the rest departs from: token and row agree.
    const t = await ticketFor(SUPER);
    assert('a supervisor is handed an upload ticket',
      t.statusCode === 200 && typeof t.body.uploadUrl === 'string',
      `${t.statusCode} ${JSON.stringify(t.body).slice(0, 120)}`);
    const L2 = { ...LAB_A, division_roles: { safety: 'level2' } };
    setRow(LAB_A.id, { division_roles: { safety: 'level2' } });
    const l2 = await ticketFor(L2);
    assert('  and a level2 signer is not, though the generic scale would upload',
      l2.statusCode === 403, String(l2.statusCode));
    seedUsers();
  }

  // Signed in when their only grant was timesheet, and given the Safety Center
  // since. Their phone still presents that sign-in's token, which says
  // timesheet and nothing else, while the row says they are crew. Signing in
  // as them anywhere else mints a token that agrees with the row — which is
  // why this worked for whoever tried it on their behalf.
  const LATE = { id: 7, username: 'kbarlow', division_roles: { timesheet: 'level1' } };
  const seedLate = () => DB.users.push({
    id: LATE.id, username: LATE.username, company_code: COMPANY,
    division_roles: { timesheet: 'level1', safety: 'level1' }, is_platform_admin: false,
  });
  seedLate();
  {
    const list = await call(docsHandler, LATE, {});
    assert('somebody granted the division after signing in sees the documents',
      list.statusCode === 200 && list.body.documents.length === 2,
      `${list.statusCode} ${JSON.stringify(list.body).slice(0, 120)}`);
    assert('  as crew, which is what they were granted',
      !!list.body.permissions && list.body.permissions.canSign === true
      && list.body.permissions.canManage === false,
      JSON.stringify(list.body.permissions));
    const count = await call(docsHandler, LATE, { query: { action: 'count' } });
    assert('  the tile counts what they owe',
      count.statusCode === 200 && count.body.unsignedByMe === 2, JSON.stringify(count.body));
    const open = await call(docsHandler, LATE, { query: { action: 'open', id: DOC1 } });
    assert('  they can open one',
      open.statusCode === 200 && /X-Amz-Signature=/.test(open.body.url || ''), String(open.statusCode));
    const sign = await call(sigHandler, LATE, {
      method: 'POST', body: { documentId: DOC1, fullName: 'Kyle Barlow', acknowledged: true },
    });
    assert('  and sign it, without signing out first',
      sign.statusCode === 201, `${sign.statusCode} ${JSON.stringify(sign.body)}`);

    // The report has always read its roster from the row. This is where the
    // two halves disagreed: listed as owing a signature they were refused.
    const rep = await call(sigHandler, SUPER, { query: { scope: 'report' } });
    const g = rep.body.documents.find(x => x.document.id === DOC1);
    assert('  so the report has them signed, not outstanding',
      g.signed.some(s => s.username === LATE.username && s.onRoster === true)
      && !g.outstanding.some(o => o.username === LATE.username),
      JSON.stringify({ signed: g.signed.map(s => s.username), outstanding: g.outstanding.map(o => o.username) }));
  }
  {
    DB.calls.length = 0;
    await call(docsHandler, LATE, {});
    const reads = DB.calls.filter(c => USER_READ.test(c.q));
    assert('one read of the row per request, keyed on whose token it is',
      reads.length === 1 && reads[0].values[0] === LATE.id,
      JSON.stringify(reads.map(r => r.values)));
  }

  {
    // Set back to Read & sign since signing in; the token still says level3.
    setRow(SUPER.id, { division_roles: { safety: 'level1' } });
    const list = await call(docsHandler, SUPER, {});
    assert('a supervisor set back to Read & sign is crew from the next request',
      list.statusCode === 200 && list.body.permissions.canManage === false
      && list.body.documents.every(d => d.signedCount === undefined),
      JSON.stringify(list.body.permissions));
    const rep = await call(sigHandler, SUPER, { query: { scope: 'report' } });
    assert('  the report is closed to them', rep.statusCode === 403, String(rep.statusCode));
    const arch = await call(docsHandler, SUPER, { method: 'DELETE', query: { id: DOC1 } });
    assert('  they cannot archive', arch.statusCode === 403, String(arch.statusCode));
    const t = await ticketFor(SUPER);
    assert('  or get an upload ticket', t.statusCode === 403, String(t.statusCode));
    const post = await call(docsHandler, SUPER, { method: 'POST', body: postBody(DOC3) });
    assert('  or register a document', post.statusCode === 403 && !DB.docs.some(d => d.id === DOC3),
      String(post.statusCode));
    const sign = await call(sigHandler, SUPER, {
      method: 'POST', body: { documentId: DOC1, fullName: 'Dan Simmons', acknowledged: true },
    });
    assert('  but can still sign, which is what they were left with',
      sign.statusCode === 201, `${sign.statusCode} ${JSON.stringify(sign.body)}`);
    seedUsers(); seedLate();
  }

  {
    // Signed in as crew and made the supervisor since. The page draws them the
    // upload form from the refreshed user, so every step behind it must agree.
    setRow(LAB_C.id, { division_roles: { safety: 'level3' } });
    const list = await call(docsHandler, LAB_C, {});
    assert('a supervisor appointed after signing in is told they may manage',
      list.statusCode === 200 && list.body.permissions.canManage === true,
      JSON.stringify(list.body.permissions));
    assert('  with the counts on each card',
      list.body.documents.length > 0 && list.body.documents.every(d => d.expectedCount !== undefined));
    const rep = await call(sigHandler, LAB_C, { query: { scope: 'report' } });
    assert('  can read the report', rep.statusCode === 200, String(rep.statusCode));
    const t = await ticketFor(LAB_C);
    assert('  is handed an upload ticket',
      t.statusCode === 200 && typeof t.body.uploadUrl === 'string',
      `${t.statusCode} ${JSON.stringify(t.body).slice(0, 120)}`);
    const post = await call(docsHandler, LAB_C, {
      method: 'POST', body: postBody(DOC3, { title: 'Tailgate — Ladders', weekOf: '2026-09-28' }),
    });
    assert('  and can post the week\'s form',
      post.statusCode === 201, `${post.statusCode} ${JSON.stringify(post.body).slice(0, 120)}`);
    seedUsers(); seedLate();
  }

  {
    // Still holding a token that says safety:level1; Manage Users has since
    // taken it away.
    setRow(LAB_B.id, { division_roles: { safety: 'no_access' } });
    const rs = [
      await call(docsHandler, LAB_B, {}),
      await call(docsHandler, LAB_B, { query: { action: 'count' } }),
      await call(docsHandler, LAB_B, { query: { action: 'open', id: DOC1 } }),
      await call(sigHandler, LAB_B, {
        method: 'POST', body: { documentId: DOC1, fullName: 'Marco Reyes', acknowledged: true },
      }),
    ];
    assert('access removed since signing in is gone from the next request',
      rs.every(r => r.statusCode === 403), rs.map(r => r.statusCode).join(','));
    assert('  and nothing was signed on the old token', !DB.sigs.some(s => s.user_id === LAB_B.id));
    setRow(LAB_B.id, { division_roles: { timesheet: 'level1' } });
    const dropped = await call(docsHandler, LAB_B, {});
    assert('  whether it was set to no access or dropped from the map',
      dropped.statusCode === 403, String(dropped.statusCode));

    DB.users = DB.users.filter(u => u.id !== LAB_B.id);
    const gone = [
      await call(docsHandler, LAB_B, {}),
      await call(sigHandler, LAB_B, {
        method: 'POST', body: { documentId: DOC1, fullName: 'Marco Reyes', acknowledged: true },
      }),
    ];
    // 401, not 403: the pages sign out on it, so the device stops presenting
    // the token at all rather than being refused one call at a time.
    assert('a deleted account is signed out, however long its token has left',
      gone.every(r => r.statusCode === 401), gone.map(r => r.statusCode).join(','));
    seedUsers(); seedLate();
  }

  {
    setRow(LAB_A.id, { company_code: 'OTH' });
    const other = await call(docsHandler, LAB_A, {});
    assert('a row belonging to another company is signed out here',
      other.statusCode === 401, String(other.statusCode));
    // login.js uppercases the code it signs; the row need not have been.
    setRow(LAB_A.id, { company_code: COMPANY.toLowerCase() });
    const cased = await call(docsHandler, LAB_A, {});
    assert('  though the same company spelled in another case is the same company',
      cased.statusCode === 200, String(cased.statusCode));
    seedUsers(); seedLate();
  }

  {
    // A token from when the map said safety — login.js lists every granted key
    // in allowedDivisions as well — against a row whose map has since been
    // cleared. With no map, hasDivisionAccess falls back to allowedDivisions,
    // so carrying the token's list over would hand the division straight back.
    setRow(LAB_A.id, { division_roles: null });
    const r = await call(docsHandler, { ...LAB_A, allowedDivisions: ['safety', 'timesheet'] }, {});
    assert('a cleared role map is not refilled from the token\'s old division list',
      r.statusCode === 403, String(r.statusCode));
    seedUsers(); seedLate();
  }

  {
    setRow(PLATFORM.id, { is_platform_admin: false });
    const was = await call(docsHandler, PLATFORM, {});
    assert('a platform admin flag removed since signing in takes the division with it',
      was.statusCode === 403, String(was.statusCode));
    seedUsers(); seedLate();
    // Office staff with payroll only, made a platform admin since. No safety
    // role is named, so the platform-admin default applies: the supervisor side.
    setRow(OFFICE.id, { is_platform_admin: true });
    const now = await call(docsHandler, OFFICE, {});
    assert('  and one granted since reaches it, on the supervisor side as ever',
      now.statusCode === 200 && now.body.permissions.canManage === true,
      `${now.statusCode} ${JSON.stringify(now.body.permissions)}`);
    seedUsers(); seedLate();
  }

  {
    // Nothing after the read could have been served either, so this is an
    // error — never a quiet fall back to what the token claims. The endpoints
    // log what failed; kept off the console of an otherwise silent suite, and
    // asserted on only after the console is back, so a failure is still heard.
    const before = DB.sigs.length;
    const quiet = console.error;
    console.error = () => {};
    DB.failUserRead = true;
    let rs;
    try {
      rs = [
        await call(docsHandler, LAB_A, {}),
        await call(sigHandler, LAB_A, {
          method: 'POST', body: { documentId: DOC2, fullName: 'Jesse Hauser', acknowledged: true },
        }),
        await ticketFor(SUPER),
      ];
    } finally {
      DB.failUserRead = false;
      console.error = quiet;
    }
    assert('a failed read of the row is a 503, never a fall back to the token',
      rs.every(r => r.statusCode === 503), rs.map(r => r.statusCode).join(','));
    assert('  so nothing is signed', DB.sigs.length === before, `${before} → ${DB.sigs.length}`);
    assert('  and no writable URL is handed out', !rs[2].body.uploadUrl);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Opening the file, and the file staying put underneath a signature
// ═══════════════════════════════════════════════════════════════════════════
async function fileTests() {
  console.log('\n[the file under a signature does not move]');
  await seedTwoDocs();

  {
    const r = await call(docsHandler, LAB_A, { query: { action: 'open', id: DOC1 } });
    assert('a laborer gets a signed URL to read it', r.statusCode === 200 && /X-Amz-Signature=/.test(r.body.url));
    assert('  which expires in minutes', r.body.expiresIn <= 900 && r.body.expiresIn > 0, String(r.body.expiresIn));
    assert('  is served inline so it opens rather than downloads',
      /response-content-disposition=inline/.test(r.body.url));
    // Without this the object replays whatever Content-Type the unsigned PUT
    // sent, so a file registered as a PDF could come back as text/html and
    // render in the viewer frame.
    assert('  and the type is pinned to what the database believes',
      /response-content-type=application%2Fpdf/.test(r.body.url), r.body.url);
    assert('  and the bucket credentials are never in it',
      !r.body.url.includes(process.env.S3_SECRET_ACCESS_KEY));
  }
  {
    const r = await call(docsHandler, OFFICE, { query: { action: 'open', id: DOC1 } });
    assert('somebody outside the division cannot open it', r.statusCode === 403, String(r.statusCode));
  }
  {
    await call(docsHandler, SUPER, { method: 'DELETE', query: { id: DOC2 } });
    const crew = await call(docsHandler, LAB_A, { query: { action: 'open', id: DOC2 } });
    assert('an archived document is not found for the crew', crew.statusCode === 404, String(crew.statusCode));
    const sup = await call(docsHandler, SUPER, { query: { action: 'open', id: DOC2 } });
    assert('  but the supervisor can still produce it', sup.statusCode === 200, String(sup.statusCode));
  }
  {
    // The shared upload endpoint refuses a key project_documents claims. Safety
    // documents live in their own table, so without the second read a key it
    // owns looks unclaimed — and the file under a signed document could be
    // deleted or written over.
    const claimed = await safetyLib.safetyKeyClaimed(sql, keyFor(DOC1));
    const free    = await safetyLib.safetyKeyClaimed(sql, keyFor('never-registered'));
    assert('a registered safety key reads as claimed', claimed === true);
    assert('  and an unregistered one does not', free === false);

    const upload = read('api/document-upload-url.js');
    assert('the shared upload endpoint asks that question on DELETE',
      /claimed\.length \|\| await safetyKeyClaimed\(sql, key\)[\s\S]{0,200}was not removed/.test(upload));
    assert('  and on the relay PUT, where the damage would be an overwrite',
      /claimed\.length \|\| await safetyKeyClaimed\(sql, key\)[\s\S]{0,200}already belongs to a document/.test(upload));
  }
  {
    // A revised form is a new document. Editing one may fix its title, its
    // week or its note — never the bytes people already signed for.
    const r = await call(docsHandler, SUPER, {
      method: 'PUT', query: { id: DOC1 },
      body: { title: 'Tailgate — Trenching (rev B)', storageKey: keyFor('other'), filename: 'other.pdf' },
    });
    assert('an edit may retitle a document', r.statusCode === 200 && r.body.document.title === 'Tailgate — Trenching (rev B)');
    // The week is read out of the row as a Date and, on a title-only edit, put
    // straight back. Bound to a DATE column a Date serialises as a UTC instant,
    // so east of Greenwich each save stored the day before the last one and the
    // week walked backwards until the document fell out of its own filter.
    assert('  and does not move the week it is filed under',
      r.body.document.weekOf === '2026-09-14', r.body.document.weekOf);
    const again = await call(docsHandler, SUPER, {
      method: 'PUT', query: { id: DOC1 }, body: { description: 'and a note' },
    });
    assert('  however many times it is saved',
      again.body.document.weekOf === '2026-09-14', again.body.document.weekOf);
    assert('  and cannot repoint it at other bytes',
      DB.docs.find(d => d.id === DOC1).storage_key === keyFor(DOC1),
      DB.docs.find(d => d.id === DOC1).storage_key);
    const lab = await call(docsHandler, LAB_A, { method: 'PUT', query: { id: DOC1 }, body: { title: 'nope' } });
    assert('  and a laborer cannot edit at all', lab.statusCode === 403, String(lab.statusCode));
  }
  {
    const lab = await call(docsHandler, LAB_A, { method: 'DELETE', query: { id: DOC1 } });
    assert('a laborer cannot archive a document', lab.statusCode === 403, String(lab.statusCode));
  }
  {
    const r = await call(docsHandler, LAB_A, { method: 'POST', query: {}, body: {} });
    assert('an unauthenticated caller gets nowhere', r.statusCode === 403 || r.statusCode === 400);
    const res = makeRes();
    await docsHandler({ method: 'GET', query: {}, headers: {} }, res);
    assert('  and a request with no token at all is 401', res.statusCode === 401, String(res.statusCode));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. The page
// ═══════════════════════════════════════════════════════════════════════════
function pageTests() {
  console.log('\n[the page shows each side its own half]');
  const page = read('safety.html');

  // The page's own copy of the week rule. It exists so the form shows the week
  // it is actually going to file under; the two disagreeing would mean a
  // supervisor posting "this Wednesday" and hunting for it under a date the
  // report does not have.
  const pageMonday = (() => {
    const start = page.indexOf('function mondayOf(');
    if (start < 0) return null;
    let depth = 0;
    for (let j = page.indexOf('{', start); j < page.length; j++) {
      if (page[j] === '{') depth++;
      else if (page[j] === '}' && --depth === 0) {
        const src = page.slice(start, j + 1);
        const helpers = `
          const pad = n => String(n).padStart(2, '0');
          const dstr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());`;
        return new Function(`${helpers}\n${src}\nreturn mondayOf;`)();
      }
    }
    return null;
  })();
  assert('the page carries its own copy of the week rule', !!pageMonday);
  if (pageMonday) {
    const cases = ['2026-09-14', '2026-09-16', '2026-09-18', '2026-09-20', '2026-09-21', '2027-01-01'];
    const off = cases.filter(d => pageMonday(d) !== safetyLib.mondayOf(d));
    assert(`  and agrees with the server on all ${cases.length} weeks`, off.length === 0,
      off.map(d => `${d}: page=${pageMonday(d)} server=${safetyLib.mondayOf(d)}`).join('; '));
  }

  // The page shows the server's sentence, and carries a literal only for a
  // list read that somehow carried none. The two drifting would mean people
  // ticking a box beside one sentence and having a different one recorded.
  assert('the page takes the acknowledgement wording from the server',
    /if \(data\.statement\) state\.statement = data\.statement/.test(page));
  {
    const fallback = /state\.statement \|\| '([^']+)'/.exec(page);
    assert('  and its fallback is word for word the sentence that gets stored',
      !!fallback && fallback[1] === safetyLib.SIGNATURE_STATEMENT,
      fallback ? fallback[1] : 'no fallback found');
  }
  assert('the documents list hands that wording out',
    /statement: SIGNATURE_STATEMENT/.test(read('api/safety-documents.js')));

  // An inline onclick's body is JAVASCRIPT, and the HTML parser decodes
  // entities in an attribute value BEFORE that source is compiled — so esc()'s
  // &#39; becomes a real quote and closes the string literal the value sits in.
  // A value that reaches a page must never be interpolated into handler source.
  {
    // Scanned with the comments stripped. An assertion about what the code does
    // must not be satisfied — or, as here, broken — by a comment explaining it:
    // the page carries a note naming the exact pattern it no longer uses.
    const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const handlers = [...code.matchAll(/on[a-z]+="([^"]*)"/g)].map(m => m[1]);
    const interpolated = handlers.filter(h => /\$\{/.test(h));
    assert('nothing is interpolated into an inline event handler',
      interpolated.length === 0, interpolated.join(' | ').slice(0, 300));
    assert('  the ids ride on data attributes instead',
      /data-doc-id="\$\{esc\(d\.id\)\}"/.test(code));
    assert('  read back through a delegated listener, not a compiler',
      /addEventListener\('click'/.test(code) && /getAttribute\('data-doc-id'\)/.test(code));
  }

  // The acknowledgement checkbox rendered pixel-for-pixel identical checked and
  // unchecked, because the shared `input, textarea, select` reset applies
  // appearance:none — which on a checkbox removes the native box AND its tick,
  // and makes accent-color a no-op. It toggled correctly and showed nothing, so
  // it read as a dead control: tap, no change, tap again, now it is off again.
  //
  // jsdom has no layout, so this cannot compare pixels. It pins the two things
  // that caused it instead: the reset must not reach a checkbox, and the
  // checked state must declare something visible of its own.
  {
    const reset = /\n\s*(input[^{]*?),\s*textarea,\s*select\s*\{/.exec(page);
    assert('the shared input reset does not reach checkboxes',
      !!reset && /:not\(\[type=checkbox\]\)/.test(reset[1]),
      reset ? reset[1].trim() : 'reset rule not found');
    assert('  nor radios, which would break the same way',
      !!reset && /:not\(\[type=radio\]\)/.test(reset[1]));

    const checked = /\.ack input\[type=checkbox\]:checked\s*\{([^}]*)\}/.exec(page);
    assert('the checked state paints something of its own', !!checked);
    if (checked) {
      assert('  a tick, not just a colour swap',
        /background[^;]*svg/i.test(checked[1]),
        'a filled box with no mark is a state, not a confirmation');
      assert('  and a border that changes with it',
        /border-color/.test(checked[1]));
    }
    assert('the box is big enough for a gloved finger',
      /\.ack input\[type=checkbox\]\s*\{[^}]*width:\s*30px/.test(page));
  }

  assert('the page names its division so Mathis resolves it',
    /const DIVISION = 'safety'/.test(page));
  assert('  and loads the widget like every other division page',
    /<script src="mathis\.js"/.test(page));
  assert('it reads its own token out of localStorage',
    /localStorage\.getItem\('fct_token'\)/.test(page));
  assert('the PDF is opened through a short-lived signed URL the server mints',
    /safety-documents\?action=open/.test(page)
    && /<iframe class="pdf-frame" id="pdfFrame" src="\$\{esc\(url\)\}"/.test(page));
  assert('  and the token never travels in a query string, where it would be logged',
    !/[?&]token=/.test(page) && /'Authorization': 'Bearer '/.test(page));
  assert('uploads go to storage directly, with the API only minting the ticket',
    /document-upload-url\?division=safety/.test(page) && /ticket\.uploadUrl/.test(page));
  assert('  and an upload whose registration fails cleans up after itself',
    /DELETE', '\/document-upload-url\?division=safety&storageKey=/.test(page));

  // ── Driven in jsdom ────────────────────────────────────────────────────
  // jsdom does not fetch <script src>, and the printout is written through
  // dwWrite() from report-branding.js — so the real file is inlined where the
  // page loads it, and every sheet below goes through the branding it ships with.
  const brandingTag = '<script src="report-branding.js" defer></script>';
  // A function, not a string: a string replacement reads `$&` and friends in
  // the inlined source as patterns.
  const pageWithBranding = page.replace(brandingTag, () => `<script>${read('report-branding.js')}</script>`);

  function boot(user, docs, report, opts = {}) {
    const calls = [];
    const dom = new JSDOM(pageWithBranding, {
      url: 'http://localhost/safety.html',
      runScripts: 'dangerously',
      beforeParse(win) {
        // jsdom has no matchMedia, and the page branches on it: a coarse
        // pointer means the PDF cannot be drawn in the page and has to open in
        // the phone's own viewer. Stubbed so BOTH sides can be driven.
        const coarse = Boolean(opts.coarse);
        win.matchMedia = q => ({
          matches: /pointer:\s*coarse/.test(q) ? coarse : false,
          media: q, addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {},
        });
        if (opts.width) {
          Object.defineProperty(win, 'innerWidth', { value: opts.width, configurable: true });
        }
        win.localStorage.setItem('fct_token', 'test-token');
        win.localStorage.setItem('fct_user', JSON.stringify(user));
        win.confirm = () => true;
        // A canvas in jsdom has no 2d context, and the signature pad is the
        // only thing on this page that wants one.
        win.HTMLCanvasElement.prototype.getContext = () => ({
          scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {},
        });
        win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
        win.fetch = (url, init) => {
          calls.push({ url: String(url), opts: init });
          if (opts.fail && opts.fail(String(url))) {
            return Promise.resolve({
              ok: false, status: 500, json: () => Promise.resolve({ error: 'Server error' }),
            });
          }
          // One document's read — the only one that carries the drawn marks.
          const detail = opts.detail && /[?&]documentId=/.test(String(url)) ? opts.detail(String(url)) : undefined;
          const body = detail !== undefined ? detail
            : String(url).includes('safety-signatures')
            ? (String(url).includes('scope=report') ? report : { signatures: [], statement: 'S' })
            : docs;
          return Promise.resolve({
            ok: true, status: 200, json: () => Promise.resolve(body),
          });
        };
      },
    });
    return { win: dom.window, doc: dom.window.document, calls };
  }

  const DOCS_CREW = {
    storageConfigured: true,
    permissions: { level: 'level1', canManage: false, canSign: true },
    documents: [
      { id: DOC1, title: 'Tailgate — Trenching', weekOf: '2026-09-14', filename: 'a.pdf',
        sizeBytes: 12345, uploadedBy: 'dsimmons', uploadedAt: '2026-09-14T12:00:00Z',
        archivedAt: null, signedByMe: false, mySignature: null },
      { id: DOC2, title: 'Tailgate — Heat Illness', weekOf: '2026-09-07', filename: 'b.pdf',
        sizeBytes: 999, uploadedBy: 'dsimmons', uploadedAt: '2026-09-07T12:00:00Z',
        archivedAt: null, signedByMe: true,
        mySignature: { fullName: 'Jesse Hauser', signedAt: '2026-09-08T13:05:00Z' } },
    ],
  };
  const DOCS_SUPER = {
    storageConfigured: true,
    permissions: { level: 'level3', canManage: true, canSign: true },
    documents: DOCS_CREW.documents.map(d => ({ ...d, signedCount: 2, expectedCount: 4, outstandingCount: 2 })),
  };
  const REPORT = {
    statement: 'I have read this document in full…',
    documents: [{
      document: { id: DOC1, title: 'Tailgate — Trenching', weekOf: '2026-09-14',
                  uploadedBy: 'dsimmons', uploadedAt: '2026-09-14T12:00:00Z', archivedAt: null },
      expectedCount: 4, signedCount: 2, outstandingCount: 2, percentSigned: 50,
      signed: [
        { userId: 2, username: 'jhauser', fullName: 'Jesse Hauser', signedAt: '2026-09-15T13:00:00Z' },
        { userId: 3, username: 'mreyes',  fullName: 'Marco Reyes',  signedAt: '2026-09-15T14:00:00Z' },
      ],
      outstanding: [
        { userId: 1, username: 'dsimmons', level: 'level3' },
        { userId: 4, username: 'twhite',   level: 'level1' },
      ],
    }],
  };

  const done = [];

  // A laborer's screen.
  {
    const { win, doc } = boot(
      { username: 'jhauser', divisionRoles: { safety: 'level1' }, isPlatformAdmin: false },
      DOCS_CREW, REPORT);
    done.push(new Promise(resolve => setTimeout(async () => {
      const panel = doc.getElementById('panelDocs').innerHTML;
      assert('a laborer is not offered the report tab',
        doc.getElementById('tabReport').style.display === 'none');
      assert('  nor the upload form', !/Post this week's form/.test(panel));
      assert('  and is told which documents still want a signature',
        /Signature needed/.test(panel) && /1 document waiting for your signature/.test(panel), panel.slice(0, 200));
      assert('  while the one they signed says when',
        /Signed/.test(panel) && /Sep 8, 2026/.test(panel));
      assert('  and the badge says what they are here as',
        doc.getElementById('levelBadge').textContent === 'Crew');

      // The cards are wired by delegation now rather than by an inline onclick,
      // so prove a tap still reaches the viewer — a silent no-op here would be
      // a page where nothing opens at all.
      {
        const card = doc.querySelector('[data-act="open"]');
        assert('a card carries its id as data, not as handler source',
          !!card && card.getAttribute('data-doc-id') === DOCS_CREW.documents[0].id,
          card && card.getAttribute('data-doc-id'));
        card.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        assert('  and tapping it opens the viewer',
          doc.getElementById('viewer').classList.contains('open'));
        win.closeViewer();
      }

      // The viewer is where signing happens, and the button stays dead until
      // both the box and the name are filled in — the page refusing before the
      // server has to.
      win.renderViewer(DOCS_CREW.documents[0], 'https://store.test/x.pdf?sig');
      const btn = doc.getElementById('signBtn');
      assert('the sign button starts disabled', btn.disabled === true);
      doc.getElementById('sigName').value = 'Jesse Hauser';
      win.updateSignButton();
      assert('  a name alone is not enough', btn.disabled === true);
      doc.getElementById('ackBox').checked = true;
      win.onAckChange();
      assert('  the box alone would not be either, but both together are',
        btn.disabled === false);
      assert('  and the sentence on screen is the one being agreed to',
        /read this document in full/.test(doc.getElementById('ackText').textContent));
      // A document already signed offers no second signature.
      win.renderViewer(DOCS_CREW.documents[1], 'https://store.test/y.pdf?sig');
      assert('a document already signed shows the record instead of the form',
        !doc.getElementById('signBtn') && /You signed this on/.test(doc.getElementById('vBody').innerHTML));

      // A slow open must not repaint a viewer the reader has moved on from.
      // The answer for document A landing after they closed it and opened B
      // painted A's PDF and A's sign panel under B's header — and
      // submitSignature posts state.viewing, so they would read one form and
      // sign another. For a legal acknowledgement that is the worst outcome
      // this page has.
      {
        const A = DOCS_CREW.documents[0];
        const B = { ...DOCS_CREW.documents[1], id: 'other', signedByMe: false, mySignature: null };
        // `state` is a top-level const, so it lives in the script's lexical
        // scope rather than on window. win.eval runs global code in the same
        // realm, which can see it; the page's functions are reachable directly
        // because function declarations DO land on the global object.
        win.eval(`state.docs = ${JSON.stringify([A, B])}`);

        let resolveA;
        const realFetch = win.fetch;
        win.fetch = (url, opts) => String(url).includes('action=open')
          ? new Promise(res => { resolveA = () => res({
              ok: true, status: 200, json: () => Promise.resolve({ url: 'https://store.test/A.pdf' }),
            }); })
          : realFetch(url, opts);

        const opening = win.openViewer(A.id);       // never answers yet
        win.closeViewer();                          // the reader backs out
        win.fetch = realFetch;
        await win.openViewer(B.id);                 // and opens another
        resolveA();                                 // A's answer finally lands
        await opening;
        await new Promise(r => setTimeout(r, 5));

        assert('a late answer does not repaint a viewer the reader moved on from',
          win.eval('state.viewing && state.viewing.id') === B.id,
          String(win.eval('state.viewing && state.viewing.id')));
        const frame = doc.getElementById('pdfFrame');
        assert('  so the PDF on screen is the one whose header is above it',
          !frame || !/A\.pdf/.test(frame.getAttribute('src') || ''),
          frame && frame.getAttribute('src'));
        win.eval(`state.docs = ${JSON.stringify(DOCS_CREW.documents)}`);
      }

      // An archived one the server will never accept used to render the whole
      // form — box, name, pad, enabled button — and answer the submit with
      // "Document not found" under the thing they had just read.
      win.renderViewer(
        { ...DOCS_CREW.documents[0], archivedAt: '2026-09-19T10:00:00Z' },
        'https://store.test/z.pdf?sig');
      assert('an archived document offers no signature it could not record',
        !doc.getElementById('signBtn') && !doc.getElementById('ackBox')
        && /has been archived/.test(doc.getElementById('vBody').innerHTML),
        doc.getElementById('vBody').innerHTML.slice(-260));
      assert('  but it is still readable, which is why it was kept',
        /pdf-frame/.test(doc.getElementById('vBody').innerHTML));
      resolve();
    }, 30)));
  }

  // A phone. This is the side of the page that matters most — the crew sign
  // on phones, outdoors, in gloves — and it is a genuinely different screen:
  // iOS Safari paints only the first page of a PDF in an iframe and Android
  // Chrome will not render one at all, so the document opens in the phone's
  // own viewer and the acknowledgement waits until it has been.
  {
    const { win, doc } = boot(
      { username: 'jhauser', divisionRoles: { safety: 'level1' }, isPlatformAdmin: false },
      DOCS_CREW, REPORT, { coarse: true, width: 390 });
    done.push(new Promise(resolve => setTimeout(() => {
      // openViewer sets state.viewing before it paints; renderViewer alone does
      // not, and the open-tracking listener is keyed on it.
      win.eval(`state.viewing = ${JSON.stringify(DOCS_CREW.documents[0])}`);
      win.renderViewer(DOCS_CREW.documents[0], 'https://store.test/x.pdf?sig');
      const body = doc.getElementById('vBody');

      assert('on a phone the PDF is not drawn into the page at all',
        !doc.getElementById('pdfFrame'),
        'a frame that shows page 1 of 4, or nothing, is worse than no frame');
      const open = body.querySelector('[data-act="opened"]');
      assert('  it is opened in the phone\'s own viewer instead',
        !!open && open.getAttribute('target') === '_blank'
        && open.getAttribute('href') === 'https://store.test/x.pdf?sig',
        open && open.outerHTML.slice(0, 120));
      assert('  as the primary action on the screen, not a hyperlink',
        !!open && /btn-primary/.test(open.className), open && open.className);
      assert('  and the link is not leaked to a new browsing context',
        /rel="noopener"/.test(body.innerHTML));

      // The page cannot know they read it. It can refuse to record that they
      // did when it never showed them anything.
      doc.getElementById('sigName').value = 'Jesse Hauser';
      doc.getElementById('ackBox').checked = true;
      win.onAckChange();
      assert('the box and the name are not enough on their own here',
        doc.getElementById('signBtn').disabled === true,
        'nothing has been put in front of them yet');
      assert('  and the page says what is missing',
        /Open the form above/.test(doc.getElementById('signMsg').textContent),
        doc.getElementById('signMsg').textContent);

      open.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert('opening the form is what releases the signature',
        doc.getElementById('signBtn').disabled === false);

      win.closeViewer();
      resolve();
    }, 30)));
  }

  // The same screen on a desktop keeps the inline frame, which renders there.
  {
    const { win, doc } = boot(
      { username: 'jhauser', divisionRoles: { safety: 'level1' }, isPlatformAdmin: false },
      DOCS_CREW, REPORT, { coarse: false, width: 1280 });
    done.push(new Promise(resolve => setTimeout(() => {
      win.renderViewer(DOCS_CREW.documents[0], 'https://store.test/x.pdf?sig');
      assert('on a desktop the document is still shown in the page',
        !!doc.getElementById('pdfFrame'));
      doc.getElementById('sigName').value = 'Jesse Hauser';
      doc.getElementById('ackBox').checked = true;
      win.onAckChange();
      assert('  and nothing extra is asked of them, because they can see it',
        doc.getElementById('signBtn').disabled === false);
      resolve();
    }, 30)));
  }

  // A supervisor's screen.
  {
    const { win, doc, calls } = boot(
      { username: 'dsimmons', divisionRoles: { safety: 'level3' }, isPlatformAdmin: false },
      DOCS_SUPER, REPORT);
    done.push(new Promise(resolve => setTimeout(async () => {
      assert('a supervisor gets the report tab', doc.getElementById('tabReport').style.display !== 'none');
      const panel = doc.getElementById('panelDocs').innerHTML;
      assert('  and the upload form', /Post this week's form/.test(panel) && /id="upFile"/.test(panel));
      {
        // Matching \d{4}-\d{2}-\d{2} accepted every calendar date, so it proved
        // a date was prefilled and not the one property its label names — the
        // property this whole division files on.
        const m = /id="upWeek" type="date" value="(\d{4}-\d{2}-\d{2})"/.exec(panel);
        assert('  with the week pre-filled to a Monday',
          !!m && safetyLib.mondayOf(m[1]) === m[1], m ? m[1] : 'no date prefilled');
      }
      assert('  and the counts on each card', /2 \/ 4 signed/.test(panel), panel.slice(0, 300));

      // Archive sits INSIDE the card. Under delegation it has to win over the
      // card's own open handler, which the old inline version did with
      // stopPropagation — otherwise archiving also opens the PDF.
      {
        const before = calls.length;
        const btn = doc.querySelector('[data-act="archive"]');
        assert('the archive button carries its own action', !!btn);
        btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 10));
        const fired = calls.slice(before).map(c => c.url);
        assert('  clicking it archives rather than opening the document',
          fired.some(u => /safety-documents\?id=/.test(u)) && !fired.some(u => /action=open/.test(u)),
          fired.join(' | '));
        assert('  and the viewer stays shut',
          !doc.getElementById('viewer').classList.contains('open'));
      }

      win.switchTab('report');
      await new Promise(r => setTimeout(r, 20));
      const rep = doc.getElementById('panelReport').innerHTML;
      assert('the report groups by document, titled',
        /Tailgate — Trenching/.test(rep) && /rep-group/.test(rep));
      assert('  showing how far along each one is', /2 \/ 4/.test(rep));
      assert('  and saying plainly that something is outstanding',
        /still short of signatures/.test(rep));

      // Collapsed until asked: a supervisor scanning the weeks wants the
      // headline, and the names when they pick one.
      assert('a group starts collapsed', !/rep-group open/.test(rep));
      win.toggleGroup(DOC1);
      const open = doc.getElementById('panelReport').innerHTML;
      assert('  and expanding it names who signed, with the time',
        /Jesse Hauser/.test(open) && /jhauser/.test(open) && /Sep 15, 2026/.test(open));
      assert('  and who still has to', /Still to sign \(2\)/.test(open) && /twhite/.test(open));

      // The export is the whole picture, not a list of who is in trouble.
      let csv = null;
      win.Blob = function (parts) { csv = String(parts[0]); };
      win.URL.createObjectURL = () => 'blob:x';
      win.URL.revokeObjectURL = () => {};
      win.exportReportCsv();
      assert('the CSV carries the signers', csv && /Jesse Hauser/.test(csv) && /Signed/.test(csv), String(csv));
      assert('  and the ones who have not signed', csv && /twhite,,Not signed/.test(csv), String(csv));
      resolve();
    }, 30)));
  }

  // ── Print / PDF ────────────────────────────────────────────────────────
  // The sheet the safety supervisor uploads to ISNetworld. It has to carry the
  // drawn marks, which the report deliberately does not, so it is built from a
  // fresh read of each document — and it prints who SIGNED, never the list of
  // who has not.
  {
    assert('the page loads the branding its printout is written through',
      page.includes(brandingTag));

    const STATEMENT = safetyLib.SIGNATURE_STATEMENT;
    // A real 1x1 PNG, so it passes the same shape check the server applies.
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const DOC3 = '33333333-3333-4333-8333-333333333333';
    const docMeta = (id, title, weekOf) => ({
      id, title, weekOf, filename: 'form.pdf',
      uploadedBy: 'dsimmons', uploadedAt: weekOf + 'T12:00:00Z', archivedAt: null,
    });
    const JESSE = { userId: 2, username: 'jhauser', fullName: 'Jesse Hauser', signedAt: '2026-09-15T13:00:00.000Z',
                    statement: STATEMENT, hasDrawnSignature: true,  onRoster: true };
    const MARCO = { userId: 3, username: 'mreyes',  fullName: 'Marco Reyes',  signedAt: '2026-09-15T14:00:00.000Z',
                    statement: STATEMENT, hasDrawnSignature: false, onRoster: true };
    const TOM   = { userId: 4, username: 'twhite',  fullName: 'Tom White',    signedAt: '2026-09-08T12:00:00.000Z',
                    statement: STATEMENT, hasDrawnSignature: true,  onRoster: true };
    const grp = (doc, signed, outstanding) => ({
      document: doc, expectedCount: 4, signedCount: signed.length, outstandingCount: outstanding.length,
      percentSigned: Math.round((signed.length / 4) * 100), signed,
      outstanding: outstanding.map((u, i) => ({ userId: 50 + i, username: u, level: 'level1' })),
    });
    const D1 = docMeta(DOC1, 'Tailgate — Trenching',    '2026-09-14');
    const D2 = docMeta(DOC2, 'Tailgate — Heat Illness', '2026-09-07');
    const D3 = docMeta(DOC3, 'Tailgate — Silica',       '2026-08-31');
    // What the report hands out: no marks, only whether one was drawn.
    const REPORT_P = { statement: STATEMENT, documents: [
      grp(D1, [JESSE, MARCO], ['dsimmons', 'twhite']),
      grp(D2, [TOM],          ['dsimmons', 'jhauser', 'mreyes']),
      grp(D3, [],             ['dsimmons', 'jhauser', 'mreyes', 'twhite']),
    ] };
    // What one document's own read hands out: the same rows, marks included.
    const DETAIL_P = {
      [DOC1]: grp(D1, [{ ...JESSE, signatureImage: PNG }, MARCO], ['dsimmons', 'twhite']),
      [DOC2]: grp(D2, [{ ...TOM, signatureImage: PNG }],          ['dsimmons', 'jhauser', 'mreyes']),
      [DOC3]: grp(D3, [],                                         ['dsimmons', 'jhauser', 'mreyes', 'twhite']),
    };
    const detailFrom = table => url => {
      const id = decodeURIComponent(/[?&]documentId=([^&]+)/.exec(url)[1]);
      return { documents: table[id] ? [table[id]] : [], statement: STATEMENT };
    };
    const SUPERVISOR = {
      username: 'dsimmons', companyName: 'Force Corp',
      divisionRoles: { safety: 'level3' }, isPlatformAdmin: false,
    };
    const settle = (ms = 20) => new Promise(r => setTimeout(r, ms));
    const detailReads = calls => calls
      .filter(c => /safety-signatures\?documentId=/.test(c.url))
      .map(c => decodeURIComponent(/documentId=([^&]+)/.exec(c.url)[1]));
    const titleOf = html => (/<title>([^<]*)<\/title>/.exec(html) || [])[1];

    // A stand-in for the pop-up that records what is written into it.
    function popupsOn(win) {
      const opened = [];
      win.open = () => {
        const p = {
          closed: false, writes: [],
          get html() { return this.writes.join(''); },
          document: {
            open() { p.writes = []; },
            write(...chunks) { p.writes.push(chunks.join('')); },
            close() {},
            getElementById: () => null,
          },
          focus() {}, print() {}, close() { p.closed = true; },
        };
        opened.push(p);
        return p;
      };
      return opened;
    }

    // One document's sheet.
    {
      const { win, doc, calls } = boot(SUPERVISOR, DOCS_SUPER, REPORT_P, { detail: detailFrom(DETAIL_P) });
      done.push(new Promise(resolve => setTimeout(async () => {
        win.switchTab('report');
        await settle();
        const popups = popupsOn(win);

        assert('the report offers a print of everything it lists',
          !!doc.querySelector('button[onclick="printReport()"]'));
        const btn = doc.querySelector(`[data-act="print"][data-doc-id="${DOC1}"]`);
        assert('  and each document carries a Print / PDF of its own', !!btn);

        const before = calls.length;
        btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await settle();
        assert('printing a document does not also expand it',
          win.eval(`state.reportOpen.has(${JSON.stringify(DOC1)})`) === false);
        assert('  it opens one print window', popups.length === 1, String(popups.length));
        assert('  filled from a FRESH read of that document, which is where the marks are',
          detailReads(calls.slice(before)).join() === DOC1, detailReads(calls.slice(before)).join());

        const html = popups[0] ? popups[0].html : '';
        assert('the sheet is a whole document, titled for the file it will be saved as',
          /^<!DOCTYPE html>/i.test(html.trim())
          && titleOf(html) === 'Tailgate — Trenching — sign-off sheet — week of 2026-09-14', titleOf(html));
        assert('  written through dwWrite, so it carries the DataWatch band', /data-dw-brand/.test(html));
        assert('  under the company\'s own name', />Force Corp</.test(html));
        assert('  naming the document and its week',
          /<h1>Tailgate — Trenching<\/h1>/.test(html) && /Week of Sep 14, 2026/.test(html));
        assert('  and the sentence each of them agreed to', html.includes(STATEMENT));
        assert('every signer is on it, by typed name and by login',
          /Jesse Hauser/.test(html) && /jhauser/.test(html) && /Marco Reyes/.test(html) && /mreyes/.test(html));
        assert('  with the mark they drew', html.includes(`src="${PNG}"`));
        assert('  and a signer who drew nothing is said so, rather than left blank',
          /Signed by typed name — no mark drawn/.test(html));
        assert('who has NOT signed is not on the sheet', !/twhite/.test(html),
          'the outstanding list is for chasing, not part of the record of who signed');
        assert('the print dialog opens once the sheet has loaded',
          /window\.onload = function \(\) \{ window\.print\(\); \};/.test(html));
        assert('  with a button to open it again that stays off the paper',
          /class="bar no-print"/.test(html) && /\.no-print \{ display: none !important; \}/.test(html));
        resolve();
      }, 30)));
    }

    // One person's acknowledgement.
    {
      const { win, doc } = boot(SUPERVISOR, DOCS_SUPER, REPORT_P, { detail: detailFrom(DETAIL_P) });
      done.push(new Promise(resolve => setTimeout(async () => {
        win.switchTab('report');
        await settle();
        win.toggleGroup(DOC1);
        await settle();
        const popups = popupsOn(win);
        const one = doc.querySelector('[data-act="print-sig"][data-username="jhauser"]');
        assert('each signature carries a Print / PDF of its own',
          !!one && one.getAttribute('data-doc-id') === DOC1
          && one.getAttribute('data-signed-at') === JESSE.signedAt);
        one.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await settle();
        const html = popups[0] ? popups[0].html : '';
        assert('  which prints that one person\'s acknowledgement',
          /Safety acknowledgement record/.test(html) && /<h1>Jesse Hauser<\/h1>/.test(html)
          && html.includes(`src="${PNG}"`) && html.includes(STATEMENT));
        assert('  and nobody else\'s', !/Marco Reyes/.test(html));
        assert('  saved under their name and the document',
          titleOf(html) === 'Jesse Hauser — Tailgate — Trenching — signed 2026-09-15', titleOf(html));
        assert('  without collapsing the group it was pressed in',
          win.eval(`state.reportOpen.has(${JSON.stringify(DOC1)})`) === true);
        resolve();
      }, 30)));
    }

    // Whatever is in a name or a title is printed as text. The pop-up shares
    // this origin, so markup in it would run with the supervisor's session.
    {
      const nasty = { ...JESSE, fullName: 'Jesse <img src=x onerror=alert(1)> Hauser' };
      const odd   = { ...MARCO, hasDrawnSignature: true };
      const title = { ...D1, title: 'Trench <script>alert(1)</script>' };
      const table = { [DOC1]: grp(title, [{ ...nasty, signatureImage: PNG }, { ...odd, signatureImage: 'javascript:alert(1)' }], []) };
      const report = { statement: STATEMENT, documents: [grp(D1, [nasty, odd], [])] };
      const { win } = boot(SUPERVISOR, DOCS_SUPER, report, { detail: detailFrom(table) });
      done.push(new Promise(resolve => setTimeout(async () => {
        win.switchTab('report');
        await settle();
        const popups = popupsOn(win);
        win.printDocument(DOC1);
        await settle();
        const html = popups[0] ? popups[0].html : '';
        assert('a name on the sheet is text, never markup',
          html.includes('Jesse &lt;img src=x onerror=alert(1)&gt; Hauser') && !/<img src=x/.test(html));
        assert('  and so is a title', html.includes('Trench &lt;script&gt;') && !/<script>alert\(1\)/.test(html));
        assert('only a PNG mark ever reaches an src',
          !/javascript:alert/.test(html) && /Drawn signature on file — could not be shown here/.test(html));
        resolve();
      }, 30)));
    }

    // Signers who agreed to different wording.
    {
      const { win } = boot(SUPERVISOR, DOCS_SUPER, REPORT_P, { detail: detailFrom(DETAIL_P) });
      done.push(new Promise(resolve => setTimeout(() => {
        const OLD = 'I have read and understood this form.';
        const info = { at: '2026-09-20T12:00:00Z', by: 'dsimmons', company: 'Force Corp' };
        const html = win.sheetHTML(grp(D1, [JESSE, { ...MARCO, statement: OLD }], []), info);
        assert('signers who agreed to different wording see each wording, numbered',
          html.includes(STATEMENT) && html.includes(OLD) && /<ol>/.test(html));
        assert('  with the number beside each name',
          /Jesse Hauser<\/b><sup>1<\/sup>/.test(html) && /Marco Reyes<\/b><sup>2<\/sup>/.test(html));
        const same = win.sheetHTML(grp(D1, [JESSE, MARCO], []), info);
        assert('  while one wording is stated once, unnumbered', !/<sup>/.test(same) && !/<ol>/.test(same));
        resolve();
      }, 30)));
    }

    // Print all.
    {
      const { win, doc, calls } = boot(SUPERVISOR, DOCS_SUPER, REPORT_P, { detail: detailFrom(DETAIL_P) });
      done.push(new Promise(resolve => setTimeout(async () => {
        win.switchTab('report');
        await settle();
        const popups = popupsOn(win);
        const before = calls.length;
        doc.querySelector('button[onclick="printReport()"]').click();
        await settle(40);
        const html = popups[0] ? popups[0].html : '';
        const reads = detailReads(calls.slice(before));
        assert('Print all reads each signed document afresh',
          reads.slice().sort().join() === [DOC1, DOC2].sort().join(), reads.join());
        assert('  skipping the one nobody has signed', !reads.includes(DOC3));
        assert('  behind a contents page that says it was left out',
          /Safety sign-off report/.test(html) && /1 document in this range\s+has no signatures yet/.test(html));
        const h1s = [...html.matchAll(/<h1>([^<]*)<\/h1>/g)].map(m => m[1]);
        assert('  then a sheet for each, oldest week first',
          h1s.join(' | ') === 'Weeks of Sep 7, 2026 – Sep 14, 2026 | Tailgate — Heat Illness | Tailgate — Trenching',
          h1s.join(' | '));
        assert('  carrying every signature in the range',
          /Jesse Hauser/.test(html) && /Marco Reyes/.test(html) && /Tom White/.test(html));
        assert('  saved under the range it covers',
          titleOf(html) === 'Safety sign-offs — 2026-09-07 to 2026-09-14', titleOf(html));
        resolve();
      }, 30)));
    }

    // A year of weekly forms is a year of small reads, a few at a time — never
    // every document's marks in flight at once.
    {
      const many = [];
      const table = {};
      for (let i = 0; i < 9; i++) {
        const id = `4444444${i}-4444-4444-8444-444444444444`;
        const d = docMeta(id, `Week ${i + 1}`, `2026-0${i < 8 ? 7 : 8}-${String(1 + (i % 8) * 3).padStart(2, '0')}`);
        many.push(grp(d, [TOM], []));
        table[id] = grp(d, [{ ...TOM, signatureImage: PNG }], []);
      }
      const { win } = boot(SUPERVISOR, DOCS_SUPER, { statement: STATEMENT, documents: many }, { detail: detailFrom(table) });
      done.push(new Promise(resolve => setTimeout(async () => {
        win.switchTab('report');
        await settle();
        const popups = popupsOn(win);
        let inFlight = 0, peak = 0, total = 0;
        const realFetch = win.fetch;
        win.fetch = (url, init) => {
          if (!/documentId=/.test(String(url))) return realFetch(url, init);
          inFlight++; total++; peak = Math.max(peak, inFlight);
          return new Promise(r => setTimeout(r, 5)).then(() => { inFlight--; return realFetch(url, init); });
        };
        win.printReport();
        await settle(120);
        assert('Print all reads at most four documents at once', peak > 1 && peak <= 4, `peak ${peak}`);
        assert('  and still reads every one of them', total === 9, String(total));
        assert('  into one printout', popups.length === 1
          && (popups[0].html.match(/<section class="sheet">/g) || []).length === 10);
        win.fetch = realFetch;
        resolve();
      }, 30)));
    }

    // The ways it can go wrong, each of which must say so.
    {
      const { win, doc, calls } = boot(SUPERVISOR, DOCS_SUPER, REPORT_P, {
        detail: detailFrom(DETAIL_P), fail: url => url.includes('documentId=' + DOC2),
      });
      done.push(new Promise(resolve => setTimeout(async () => {
        win.switchTab('report');
        await settle();
        const toastText = () => doc.getElementById('toast').textContent;

        win.open = () => null;
        const before = calls.length;
        win.printDocument(DOC1);
        await settle();
        assert('a blocked pop-up says so, rather than doing nothing',
          /blocked the print window/.test(toastText()), toastText());
        assert('  and reads nothing it has nowhere to put', detailReads(calls.slice(before)).length === 0);

        const popups = popupsOn(win);
        win.printDocument(DOC3);
        await settle();
        assert('a document nobody has signed opens no window', popups.length === 0, String(popups.length));
        assert('  and says why', /nothing to print/.test(toastText()), toastText());

        win.printDocument(DOC2);
        await settle();
        assert('a failed read closes the window rather than printing an empty sheet',
          popups.length === 1 && popups[0].closed && !/class="sheet"/.test(popups[0].html));
        assert('  and says what went wrong', /Could not build the printout/.test(toastText()), toastText());

        win.printReport();
        await settle(40);
        assert('Print all never prints a report with a document silently missing from it',
          popups.length === 2 && popups[1].closed && !/class="sheet"/.test(popups[1].html));
        resolve();
      }, 30)));
    }
  }

  return Promise.all(done);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Wiring — a division that exists in only some of the lists is worse than
//    one that does not exist at all
// ═══════════════════════════════════════════════════════════════════════════
function wiringTests() {
  console.log('\n[the division is wired into every list that decides access]');

  const { ALL_DIVISIONS } = require(root('api/lib/auth.js'));
  assert('safety is a real division', ALL_DIVISIONS.includes('safety'));

  {
    const src = read('api/company/users.js');
    const list = /ALL_DIVISIONS\s*=\s*\[([^\]]*)\]/.exec(src);
    assert('api/company/users.js knows about it', !!list && /'safety'/.test(list[1]));
  }
  // Restricted: a company-wide legacy grant must never hand somebody the
  // Safety Center by accident, because the roster IS the grant — an implicit
  // one would put every login in the company on the outstanding list. The
  // rule lives once, in api/lib/auth.js: sign-in signs it, the session refresh
  // reports it, and requireAuth applies it to every request.
  {
    const authLib = require(root('api/lib/auth.js'));
    assert('it is never granted implicitly', authLib.RESTRICTED_DIVISIONS.has('safety'));
    const legacy = authLib.accessFromRow({
      role: 'level1', division_roles: null,
      divisions: ['turf', 'safety'], allowed_divisions: ['turf', 'safety'],
    });
    assert('  not even by a legacy account whose own list names it',
      !legacy.allowedDivisions.includes('safety')
      && !authLib.hasDivisionAccess({ ...legacy }, 'safety'),
      JSON.stringify(legacy.allowedDivisions));
    const login = read('api/auth/login.js');
    const verify = read('api/auth/verify.js');
    assert('  and sign-in and the session refresh apply that rule rather than their own',
      /accessFromRow\(/.test(login) && !/RESTRICTED_DIVISIONS/.test(login)
      && /requireAuth\(/.test(verify) && !/RESTRICTED_DIVISIONS/.test(verify));
  }

  const divs = read('divisions.html');
  assert('the launcher has a card for it',
    /safety: \{[\s\S]{0,400}href:\s*'safety\.html'/.test(divs));
  assert('  marked built, or the card is a dead end',
    /safety: \{[\s\S]{0,400}built: true/.test(divs));
  assert('  and it is in both of the launcher\'s key lists',
    (divs.match(/const (ALL_DIVISIONS|DIV_KEYS) = \[[^\]]*'safety'\]/g) || []).length === 2);
  // "Set all to Admin" has nothing sensible to set a two-level division to.
  assert('  but out of the five-level "set all"',
    !/DIV_KEYS_FULL_SCALE = \[[^\]]*'safety'/.test(divs));

  const sel = /<select id="mu-role-safety">([\s\S]*?)<\/select>/.exec(divs);
  assert('Manage Users offers the division', !!sel);
  if (sel) {
    const opts = [...sel[1].matchAll(/value="([a-z_0-9]+)"/g)].map(m => m[1]).join(',');
    assert('  with exactly the two levels this division has, and no access',
      opts === 'no_access,level1,level3', opts);
  }
  // The user table's header row is static markup walked in DIV_KEYS order, so
  // a missing column silently shifts every role badge one division to the left.
  {
    const keys = /const DIV_KEYS = \[([^\]]*)\]/.exec(divs);
    const n = keys ? keys[1].split(',').length : 0;
    const head = /<thead>[\s\S]*?<\/thead>/.exec(divs);
    const cols = head ? (head[0].match(/<th scope="col" title=/g) || []).length : 0;
    assert('the user table has a column per division key', cols === n, `${cols} columns vs ${n} keys`);
    assert('  including this one', /title="Safety Center[^"]*">Safety</.test(divs));
  }

  {
    // level2 is not offered by the user form but the API accepts it, and in
    // this division it means a signer. Under the generic canUpload scale it
    // was minted a writable presigned PUT into the company's safety prefix
    // that no registration could ever claim — and nothing sweeps those bytes
    // up, because the purge sweep only walks project_documents.
    const upload = read('api/document-upload-url.js');
    assert('an upload ticket for this division follows ITS levels, not the generic scale',
      /division === SAFETY_DIVISION[\s\S]{0,120}canUpload = safetyCapabilities\(payload\)\.canManage/.test(upload));
    const level2 = safetyLib.safetyCapabilities({ divisionRoles: { safety: 'level2' } });
    assert('  so a level2 signer cannot mint one', level2.canManage === false);
    assert('  while a supervisor still can',
      safetyLib.safetyCapabilities({ divisionRoles: { safety: 'level3' } }).canManage === true);
  }

  const dev = read('scripts/dev-server.js');
  assert('both endpoints are routed for local development',
    /api\/safety-documents/.test(dev) && /api\/safety-signatures/.test(dev));

  // Mathis answers for every division or says so before a question is spent.
  const tools = require(root('api/lib/mathis-tools.js'));
  assert('Mathis treats it as a personal queue, not a division of figures',
    tools.PERSONAL_AREAS.includes('safety') && !tools.SUPPORTED.includes('safety'));
  const widget = read('mathis.js');
  assert('  the widget maps the page to it', /'safety\.html':\s*'safety'/.test(widget));
  assert('  and renders that digest rather than dropping it',
    /own_safety:\s*renderOwnSafety/.test(widget) && /function renderOwnSafety/.test(widget));

  // The schema the whole thing rests on.
  const schema = read('neon-schema.sql');
  assert('the tables are in the schema',
    /CREATE TABLE IF NOT EXISTS safety_documents/.test(schema) &&
    /CREATE TABLE IF NOT EXISTS safety_signatures/.test(schema));
  assert('  one signature per person per document, enforced by the database',
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_safety_sig_once[\s\S]{0,80}\(document_id, user_id\)/.test(schema));
  assert('  a signature outlives the document being archived, not deleted',
    /document_id .* REFERENCES safety_documents\(id\) ON DELETE CASCADE/.test(schema) &&
    /archived_at   TIMESTAMPTZ/.test(schema));
  // Removing a user through Manage Users is a plain DELETE FROM users. Under a
  // cascade that silently destroyed every acknowledgement that person had ever
  // made — at offboarding, which is exactly when producing one is most likely
  // to be asked for.
  {
    // Scoped to this table's own CREATE block: other tables in this schema do
    // cascade from users, and asking the whole file would pass on theirs.
    const block = (/CREATE TABLE IF NOT EXISTS safety_signatures \(([\s\S]*?)\n\);/.exec(schema) || [])[1] || '';
    assert('  and outlives the SIGNER: deleting a user must not cascade',
      /user_id\s+INTEGER\s+REFERENCES users\(id\) ON DELETE SET NULL/.test(block)
      && !/ON DELETE CASCADE/.test(block.split('\n').filter(l => /user_id/.test(l)).join('\n')),
      block.split('\n').filter(l => /user_id/.test(l)).join(' / '));
  }
  assert('  with a migration, since the table shipped with the cascade',
    /ALTER TABLE safety_signatures ALTER COLUMN user_id DROP NOT NULL/.test(schema)
    && /safety_signatures_user_id_fkey[\s\S]{0,160}ON DELETE SET NULL/.test(schema));
  assert('  and the name is denormalised, so the row still reads without the login',
    /full_name       TEXT        NOT NULL/.test(schema) && /username        TEXT        NOT NULL/.test(schema));
  assert('  and what was agreed to is stored per row',
    /statement       TEXT/.test(schema));
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. The count behind the tile badge
// ═══════════════════════════════════════════════════════════════════════════
async function tileCountTests() {
  console.log('\n[the tile says what the Safety Center would say]');
  await seedTwoDocs();

  const countFor = async user =>
    (await call(docsHandler, user, { query: { action: 'count' } })).body.unsignedByMe;

  // The property that matters: the number on the tile and the number the crew's
  // own list works out have to be the same number, or a man is told he owes two
  // and finds one waiting. They are separate queries, so nothing but a test
  // holds them together.
  const listCount = async user => {
    const docs = (await call(docsHandler, user, {})).body.documents;
    return docs.filter(d => !d.signedByMe && !d.archivedAt).length;
  };

  assert('a laborer who has signed nothing owes both documents',
    await countFor(LAB_A) === 2, String(await countFor(LAB_A)));

  await call(sigHandler, LAB_A, {
    method: 'POST', body: { documentId: DOC1, fullName: 'J Hauser', acknowledged: true },
  });
  assert('  signing one takes it off the count', await countFor(LAB_A) === 1);
  assert('  and the count matches the Safety Center\'s own notice',
    await countFor(LAB_A) === await listCount(LAB_A));

  await call(sigHandler, LAB_A, {
    method: 'POST', body: { documentId: DOC2, fullName: 'J Hauser', acknowledged: true },
  });
  assert('  signing the rest clears it, so no badge is drawn', await countFor(LAB_A) === 0);

  // One man's count is his own. The bug this guards is the obvious one — a
  // WHERE that lost the user and started counting everybody's unsigned work.
  assert('another laborer still owes both', await countFor(LAB_B) === 2);

  // Archiving is how a supervisor takes a form off the crew's list. A tile that
  // kept counting it would send a man in to sign something that is not there.
  await call(docsHandler, SUPER, { method: 'DELETE', query: { id: DOC1 } });
  assert('an archived document stops being owed', await countFor(LAB_B) === 1);
  assert('  and the two still agree', await countFor(LAB_B) === await listCount(LAB_B));

  // Supervisors sign the tailgate they ran, so they are counted like anyone
  // else rather than being handed the report's numbers here.
  assert('a supervisor is counted as a signer, not shown the roster',
    await countFor(SUPER) === 1,
    JSON.stringify((await call(docsHandler, SUPER, { query: { action: 'count' } })).body));

  {
    const r = await call(docsHandler, SUPER, { query: { action: 'count' } });
    assert('  and the answer carries nothing but the number',
      Object.keys(r.body).join(',') === 'unsignedByMe', Object.keys(r.body).join(','));
  }

  // Asked on every division-picker load, so it must not quietly become the list
  // read: no document rows, no signature rows, no roster tally. The one other
  // read is the caller's own row, which is what access is decided on.
  {
    DB.calls.length = 0;
    await call(docsHandler, SUPER, { query: { action: 'count' } });
    const qs = DB.calls.map(c => c.q);
    assert('  in one count after the caller\'s own row, since every sign-in pays for it',
      qs.length === 2
      && USER_READ.test(qs[0])
      && /^SELECT COUNT\(\*\)::int AS unsigned_by_me/.test(qs[1]),
      `${qs.length} queries: ${qs.map(q => q.slice(0, 50)).join(' | ')}`);
  }

  {
    const r = await call(docsHandler, OFFICE, { query: { action: 'count' } });
    assert('somebody with no Safety Center gets no count either', r.statusCode === 403);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. The division picker
// ═══════════════════════════════════════════════════════════════════════════
function pickerTests() {
  console.log('\n[the tile carries the count out to where people look]');
  const page = read('divisions.html');

  // Two divisions, because a single-division account is sent straight into it
  // and never sees the picker at all.
  function openPicker({ unsignedByMe = 0, countOk = true } = {}) {
    const user = {
      username: 'jhauser', companyCode: COMPANY, companyName: 'Force Corp',
      divisionRoles: { safety: 'level1', timesheet: 'level1' }, isPlatformAdmin: false,
    };
    const calls = [];
    const dom = new JSDOM(page, {
      url: 'http://localhost/divisions.html',
      runScripts: 'dangerously',
      beforeParse(win) {
        win.localStorage.setItem('fct_token', 'test-token');
        win.localStorage.setItem('fct_user', JSON.stringify(user));
        win.fetch = url => {
          const u = String(url);
          calls.push(u);
          if (u.includes('action=count')) {
            return Promise.resolve({
              ok: countOk, status: countOk ? 200 : 500,
              json: () => Promise.resolve({ unsignedByMe }),
            });
          }
          // Answer verify with exactly the permissions already stored, so the
          // page does not decide they changed and reload out from under us.
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ ok: true, user }),
          });
        };
      },
    });
    return { win: dom.window, doc: dom.window.document, calls };
  }

  // The badge is painted a couple of promise hops after the page is parsed —
  // the fetch, then reading the body. Drained as MICROTASKS rather than with a
  // setTimeout: a macrotask tick would also run the timers still pending in the
  // safety.html documents above, and one of those navigates, which puts a jsdom
  // warning on the console of a suite that is otherwise silent.
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  const safetyCard = doc => [...doc.querySelectorAll('.card')]
    .find(c => (c.querySelector('.card-name') || {}).textContent === 'Safety Center');

  return (async () => {
    {
      const { doc, calls } = openPicker({ unsignedByMe: 3 });
      await settle();
      assert('the picker asks how many documents are waiting',
        calls.some(u => u.includes('/api/safety-documents?action=count')), calls.join(' | '));
      const card = safetyCard(doc);
      assert('  and the Safety tile is the one that gets the badge', !!card);
      const alert = card && card.querySelector('.card-alert');
      assert('  which says how many are waiting',
        !!alert && alert.textContent === '3 documents to sign',
        alert ? alert.textContent : 'no badge');
      // Above the CTA rather than after it: the last thing read before "Enter
      // System" should be the reason to.
      assert('  and sits above the way in',
        !!alert && alert.nextElementSibling
        && alert.nextElementSibling.classList.contains('card-cta'));
      const others = [...doc.querySelectorAll('.card')]
        .filter(c => c !== card && c.querySelector('.card-alert'));
      assert('  and no other division is badged', others.length === 0);
    }

    {
      const { doc } = openPicker({ unsignedByMe: 1 });
      await settle();
      const alert = safetyCard(doc).querySelector('.card-alert');
      assert('one document is a document, not 1 documents',
        !!alert && alert.textContent === '1 document to sign',
        alert ? alert.textContent : 'no badge');
    }

    {
      // Nothing owed is the normal state, and a tile that said "0 documents to
      // sign" would train people to ignore the one that matters.
      const { doc } = openPicker({ unsignedByMe: 0 });
      await settle();
      assert('a man who is up to date sees no badge at all',
        !safetyCard(doc).querySelector('.card-alert'));
    }

    {
      // The picker is how people get into every other division. A Safety
      // Center that is down must not take the whole page with it.
      const { doc } = openPicker({ unsignedByMe: 3, countOk: false });
      await settle();
      const card = safetyCard(doc);
      assert('a failed count leaves the tile working and unbadged',
        !!card && !card.querySelector('.card-alert')
        && !!card.querySelector('.card-cta'));
    }
  })();
}

// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  await helperTests();
  await uploadTests();
  await signTests();
  await listAndReportTests();
  await agreementTests();
  await currentAccessTests();
  await fileTests();
  await pageTests();
  await tileCountTests();
  await pickerTests();
  wiringTests();

  Module._load = origLoad;
  console.log(`\n${'─'.repeat(40)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(40)}`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
