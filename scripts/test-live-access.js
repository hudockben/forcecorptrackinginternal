#!/usr/bin/env node
'use strict';
/**
 * Access follows the account, not the sign-in.
 *
 * Run: node scripts/test-live-access.js
 * No DB and no server. The neon driver is stubbed with an in-memory users
 * table; JWTs are real, signed against a test secret, and go in through the
 * real requireAuth — the whole point is who gets through it.
 *
 * A token is a thirty-day snapshot of what the account could do when that
 * device signed in. Manage Users writes to the users row, nothing reissues
 * anybody's token, and the server keeps no list of them — so every device
 * holds its own snapshot, and signing in or out on one changes nothing on
 * another. While endpoints trusted the snapshot:
 *
 *   - a division granted after somebody signed in stayed refused on that
 *     device until they signed out ("works on my machine when I sign in as
 *     him, not on his phone");
 *   - a division taken away, a company admin stood down, or an account
 *     deleted outright kept working on every device already signed in until
 *     the token ran out, up to a month later.
 *
 * Every test here signs a token from the account as it was, then changes the
 * account the way Manage Users would, then asks. Anything that still read the
 * token would answer the first question; only the account answers the second.
 */

process.env.JWT_SECRET   = 'live-access-test-secret';
process.env.DATABASE_URL = 'postgres://stub/stub';
delete process.env.ANTHROPIC_API_KEY;   // the AI endpoint is only driven to its gate
process.env.MAPBOX_TOKEN = 'pk.test-mapbox';
process.env.ADMIN_SECRET = 'test-admin-secret';

const path   = require('path');
const fs     = require('fs');
const Module = require('module');

const root = f => path.resolve(__dirname, '..', f);

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── The fake database ──────────────────────────────────────────────────────
// Just the users table, read the way requireAuth reads it. Every other query
// answers an empty company: these tests are about who gets past the gate, and
// an endpoint that got past it with nothing to show still answers.
const USER_READ = /^SELECT u\.division_roles, .* FROM users u JOIN companies c ON c\.code = u\.company_code WHERE u\.id =/;
const DB = { users: new Map(), failRead: false, down: false, calls: [] };

function sql(strings, ...values) {
  const q = (Array.isArray(strings) ? strings.join('?') : String(strings)).replace(/\s+/g, ' ').trim();
  DB.calls.push({ q, values });
  if (DB.down) return Promise.reject(new Error('Connection terminated unexpectedly'));
  if (USER_READ.test(q)) {
    if (DB.failRead) return Promise.reject(new Error('Connection terminated unexpectedly'));
    const row = DB.users.get(values[0]);
    return Promise.resolve(row ? [{ ...row }] : []);
  }
  return Promise.resolve([]);
}

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => sql };
  return origLoad.apply(this, arguments);
};

const jwt  = require('jsonwebtoken');
const auth = require(root('api/lib/auth.js'));

// ── Accounts, and signing in as them ────────────────────────────────────────
const COMPANY = 'FCT';
let nextId = 100;

/** A users row, joined to its company the way requireAuth reads it. */
function account(fields) {
  const row = {
    id: nextId++, username: 'user' + nextId, company_code: COMPANY, role: 'level1',
    divisions: null, division_roles: null, is_platform_admin: false, allowed_divisions: null,
    ...fields,
  };
  DB.users.set(row.id, row);
  return row;
}

/**
 * Sign in as the account as it stands right now — the claims login.js would
 * sign, built by the same accessFromRow it uses. What changes afterwards is
 * what Manage Users did since.
 */
function signIn(row, opts = {}) {
  return jwt.sign({
    userId: row.id, username: row.username, companyCode: COMPANY, companyName: 'Force Corp',
    ...auth.accessFromRow(row),
  }, process.env.JWT_SECRET, { expiresIn: opts.expiresIn || '30d' });
}

/** Manage Users, since: replaces fields on the row, never edits them in place. */
function manageUsers(row, fields) { Object.assign(row, fields); }
function deleteAccount(row) { DB.users.delete(row.id); }

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}
const reqWith = (token, extra = {}) => ({
  method: 'GET', query: {}, body: undefined,
  headers: token ? { authorization: 'Bearer ' + token } : {},
  ...extra,
});
async function call(handlerPath, token, extra = {}) {
  const res = makeRes();
  await require(root(handlerPath))(reqWith(token, extra), res);
  return res;
}
/** requireAuth on its own: the response it sent, and what it resolved to. */
async function authFor(token) {
  const res = makeRes();
  const payload = await auth.requireAuth(reqWith(token), res);
  return { payload, res };
}
/** Run `fn` with the console quiet — the endpoints log what failed — then restore it. */
async function quietly(fn) {
  const saved = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = saved; }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. requireAuth: the token says who, the account says what
// ═══════════════════════════════════════════════════════════════════════════
async function requireAuthTests() {
  console.log('\n[requireAuth — the token says who is asking, the account says what they may do]');

  {
    const { payload, res } = await authFor(null);
    assert('no token is 401', payload === null && res.statusCode === 401, String(res.statusCode));
    const bad = await authFor('not-a-token');
    assert('a garbage token is 401', bad.payload === null && bad.res.statusCode === 401);
    const row = account({ division_roles: { turf: 'level1' } });
    const forged = jwt.sign({ userId: row.id, companyCode: COMPANY }, 'some-other-secret');
    const f = await authFor(forged);
    assert('a token signed with another secret is 401', f.payload === null && f.res.statusCode === 401);
    const expired = await authFor(signIn(row, { expiresIn: -10 }));
    assert('an expired token is 401', expired.payload === null && expired.res.statusCode === 401);
  }

  {
    const row = account({ username: 'kbarlow', division_roles: { turf: 'level1' } });
    const token = signIn(row);
    manageUsers(row, { division_roles: { turf: 'level1', paving: 'level3' } });
    DB.calls.length = 0;
    const { payload } = await authFor(token);
    assert('a division granted after sign-in is in the payload',
      payload && payload.divisionRoles.paving === 'level3' && auth.hasDivisionAccess(payload, 'paving'),
      JSON.stringify(payload && payload.divisionRoles));
    assert('  and in the divisions the account can open',
      payload.allowedDivisions.includes('paving'), JSON.stringify(payload.allowedDivisions));
    assert('  while who is asking still comes from the token',
      payload.userId === row.id && payload.username === 'kbarlow' && payload.companyCode === COMPANY);
    const reads = DB.calls.filter(c => USER_READ.test(c.q));
    assert('  read in one query, keyed on the token\'s account',
      reads.length === 1 && reads[0].values[0] === row.id, JSON.stringify(reads.map(r => r.values)));
  }

  {
    const row = account({ division_roles: { paving: 'level3', turf: 'level1' } });
    const token = signIn(row);
    manageUsers(row, { division_roles: { paving: 'no_access', turf: 'level1' } });
    const { payload } = await authFor(token);
    assert('a division taken away after sign-in is gone from the payload',
      payload && !auth.hasDivisionAccess(payload, 'paving') && !payload.allowedDivisions.includes('paving'),
      JSON.stringify(payload && payload.divisionRoles));
  }

  {
    // payload.role is the turf role, and it is what Manage Users itself checks.
    const row = account({ role: 'admin', division_roles: { turf: 'admin' } });
    const token = signIn(row);
    manageUsers(row, { role: 'level1', division_roles: { turf: 'level1' } });
    const { payload } = await authFor(token);
    assert('a company admin stood down since sign-in is no longer an admin',
      payload && payload.role === 'level1', payload && payload.role);
  }

  {
    const row = account({ is_platform_admin: true });
    const token = signIn(row);
    manageUsers(row, { is_platform_admin: false, division_roles: { turf: 'level1' } });
    const { payload } = await authFor(token);
    assert('a platform-admin flag removed since sign-in is gone',
      payload && payload.isPlatformAdmin === false && !auth.hasDivisionAccess(payload, 'payroll'),
      JSON.stringify(payload && { isPlatformAdmin: payload.isPlatformAdmin }));
  }

  {
    const row = account({ division_roles: { turf: 'level1' } });
    const token = signIn(row);
    deleteAccount(row);
    const { payload, res } = await authFor(token);
    // 401 rather than 403: every page signs out on a 401, so the device stops
    // presenting the token at all instead of being refused one call at a time.
    assert('a deleted account is signed out, however long its token has left',
      payload === null && res.statusCode === 401, String(res.statusCode));
  }

  {
    const row = account({ division_roles: { turf: 'level1' } });
    const token = signIn(row);
    manageUsers(row, { company_code: 'OTH' });
    const other = await authFor(token);
    assert('an account now in another company is signed out of this one',
      other.payload === null && other.res.statusCode === 401, String(other.res.statusCode));
    // login.js uppercases the code it signs; the row need not have been.
    manageUsers(row, { company_code: COMPANY.toLowerCase() });
    const cased = await authFor(token);
    assert('  though the same company spelled in another case is the same company',
      cased.payload !== null, String(cased.res.statusCode));
  }

  {
    // A legacy account — no role map — falls back to its own division list,
    // and a restricted division is never granted that way, whatever the token
    // it signed in with said.
    const row = account({ division_roles: { safety: 'level1', timesheet: 'level1' } });
    const token = signIn(row);
    manageUsers(row, { division_roles: null, divisions: ['turf', 'paving', 'safety', 'timesheet'] });
    const { payload } = await authFor(token);
    assert('a cleared role map falls back to the account\'s own list',
      payload && auth.hasDivisionAccess(payload, 'paving'), JSON.stringify(payload && payload.allowedDivisions));
    assert('  never to a restricted division, whatever the old token listed',
      !auth.hasDivisionAccess(payload, 'safety') && !auth.hasDivisionAccess(payload, 'timesheet'),
      JSON.stringify(payload.allowedDivisions));
  }

  {
    const row = account({ division_roles: { turf: 'level1' } });
    const token = signIn(row);
    DB.failRead = true;
    const { payload, res } = await quietly(() => authFor(token));
    DB.failRead = false;
    // Never 401 — the pages read that as signed out, and a database blip must
    // not sign the whole company out — and never the token's roles either.
    assert('an account that cannot be read is a 503, not a sign-out and not the token',
      payload === null && res.statusCode === 503, String(res.statusCode));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. The division guards
// ═══════════════════════════════════════════════════════════════════════════
async function guardTests() {
  console.log('\n[requireDivision and requirePODivision judge the account]');

  const row = account({ division_roles: { turf: 'level1' } });
  const token = signIn(row);

  const guard = async (fn, query) => {
    const res = makeRes();
    const out = await fn(reqWith(token, { query }), res);
    return { out, res };
  };

  let g = await guard(auth.requireDivision, { division: 'kiewit' });
  assert('before the grant, the division is refused', g.out === null && g.res.statusCode === 403);

  manageUsers(row, { division_roles: { turf: 'level1', kiewit: 'level2' } });
  g = await guard(auth.requireDivision, { division: 'kiewit' });
  assert('granted since sign-in, it is let in without signing out',
    g.out && g.out.division === 'kiewit' && g.out.payload.divisionRoles.kiewit === 'level2',
    JSON.stringify(g.res.body));

  manageUsers(row, { division_roles: { turf: 'level1', kiewit: 'no_access' } });
  g = await guard(auth.requireDivision, { division: 'kiewit' });
  assert('taken away again, it is refused on the next request',
    g.out === null && g.res.statusCode === 403, String(g.res.statusCode));

  manageUsers(row, { division_roles: { purchase_orders: 'level3' } });
  g = await guard(auth.requirePODivision, { division: 'paving' });
  assert('purchasing granted since sign-in can file into a job division',
    g.out && g.out.division === 'paving', JSON.stringify(g.res.body));

  deleteAccount(row);
  g = await guard(auth.requirePODivision, { division: 'paving' });
  assert('and a deleted account is signed out of both guards',
    g.out === null && g.res.statusCode === 401, String(g.res.statusCode));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. End to end, one endpoint of each kind
// ═══════════════════════════════════════════════════════════════════════════
async function endpointTests() {
  console.log('\n[a division\'s data]');
  {
    const row = account({ division_roles: { turf: 'level3' } });
    const token = signIn(row);
    const read = () => call('api/data/[key].js', token, { query: { key: 'fct_paving_bid_items' } });

    let r = await read();
    assert('paving data is refused before paving is granted', r.statusCode === 403, String(r.statusCode));
    manageUsers(row, { division_roles: { turf: 'level3', paving: 'level1' } });
    r = await read();
    assert('granted since sign-in, it is served', r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body)}`);
    manageUsers(row, { division_roles: { turf: 'level3' } });
    r = await read();
    assert('taken away again, it is refused', r.statusCode === 403, String(r.statusCode));
  }

  console.log('\n[the crew\'s own screens]');
  {
    const row = account({ division_roles: { timesheet: 'level1' } });
    const token = signIn(row);
    const ask = () => call('api/timesheet-supervisors.js', token);
    let r = await ask();
    assert('a crew member with Timesheet gets in', r.statusCode === 200, String(r.statusCode));
    manageUsers(row, { division_roles: { timesheet: 'no_access' } });
    r = await ask();
    assert('  and with it taken away since sign-in, does not', r.statusCode === 403, String(r.statusCode));
  }

  console.log('\n[payroll approval]');
  {
    // Approve is the act that moves hours into job cost. Taking it away has to
    // hold on the next request, and so does giving it.
    const approve = token => call('api/timesheet-entries.js', token, { method: 'POST', query: { action: 'approve' } });

    const approver = account({ division_roles: { payroll: 'level3' } });
    const token = signIn(approver);
    let r = await approve(token);
    assert('an approver reaches approve', r.statusCode === 400 && /id is required/.test(r.body.error),
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    manageUsers(approver, { division_roles: { payroll: 'level2' } });   // made a coder
    r = await approve(token);
    assert('  and made a coder since sign-in, no longer does',
      r.statusCode === 403 && /Payroll admin access/.test(r.body.error), `${r.statusCode} ${JSON.stringify(r.body)}`);

    const foreman = account({ division_roles: { timesheet: 'level1' } });
    const fToken = signIn(foreman);
    manageUsers(foreman, { division_roles: { timesheet: 'level1', payroll: 'level3' } });
    r = await approve(fToken);
    assert('given approve since sign-in, it works without signing out',
      r.statusCode === 400 && /id is required/.test(r.body.error), `${r.statusCode} ${JSON.stringify(r.body)}`);
  }

  console.log('\n[Manage Users]');
  {
    const list = token => call('api/company/users.js', token);
    const admin = account({ role: 'admin', division_roles: { turf: 'admin' } });
    const token = signIn(admin);
    let r = await list(token);
    assert('a company admin can open Manage Users', r.statusCode === 200, String(r.statusCode));
    manageUsers(admin, { role: 'level1', division_roles: { turf: 'level1' } });
    r = await list(token);
    // This screen can make anybody an admin, so a demotion that waited for the
    // token to run out would leave a month to put it back.
    assert('  and stood down since sign-in, cannot', r.statusCode === 403, String(r.statusCode));
    deleteAccount(admin);
    r = await list(token);
    assert('  and deleted, is signed out', r.statusCode === 401, String(r.statusCode));

    const promoted = account({ role: 'level1', division_roles: { turf: 'level1' } });
    const pToken = signIn(promoted);
    manageUsers(promoted, { role: 'admin', division_roles: { turf: 'admin' } });
    r = await list(pToken);
    assert('made a company admin since sign-in, can', r.statusCode === 200, String(r.statusCode));
  }

  console.log('\n[the session refresh the pages draw from]');
  {
    const row = account({ division_roles: { turf: 'level1' } });
    const token = signIn(row);
    manageUsers(row, { division_roles: { turf: 'level1', safety: 'level1' } });
    let r = await call('api/auth/verify.js', token);
    assert('verify reports what the account holds now',
      r.statusCode === 200 && r.body.user.divisionRoles.safety === 'level1'
      && r.body.user.allowedDivisions.includes('safety'), JSON.stringify(r.body));
    DB.failRead = true;
    r = await quietly(() => call('api/auth/verify.js', token));
    DB.failRead = false;
    // divisions.html and timesheet.html keep their cached session on anything
    // but a 401, so a blip here must not be one.
    assert('  a database blip is a 503, which the pages ride out',
      r.statusCode === 503, String(r.statusCode));
    deleteAccount(row);
    r = await call('api/auth/verify.js', token);
    // It used to answer ok from the token's own claims when the row was gone,
    // which kept a deleted account signed in on every device it had used.
    assert('  and a deleted account is a 401, which signs the page out',
      r.statusCode === 401, `${r.statusCode} ${JSON.stringify(r.body)}`);
  }

  console.log('\n[the endpoints that used to check the token themselves]');
  {
    const row = account({ division_roles: { turf: 'level1' } });
    const token = signIn(row);
    let r = await call('api/config/mapbox.js', token);
    assert('the map key is handed to a live account', r.statusCode === 200 && r.body.token === 'pk.test-mapbox');
    r = await call('api/ai/conflict-resolve.js', token, { method: 'POST', body: {} });
    assert('an AI endpoint lets a live account through to its own checks',
      r.statusCode === 503 && /AI not configured/.test(r.body.error), `${r.statusCode} ${JSON.stringify(r.body)}`);
    r = await call('api/debug.js', token);
    assert('the diagnostics answer a live account', r.statusCode === 200, String(r.statusCode));

    deleteAccount(row);
    const gone = [
      await call('api/config/mapbox.js', token),
      await call('api/ai/conflict-resolve.js', token, { method: 'POST', body: {} }),
      await call('api/ai/receipt-scan.js', token, { method: 'POST', body: {} }),
      await call('api/ai/estimate-subcode.js', token, { method: 'POST', body: {} }),
      await call('api/ai/schedule-analysis.js', token, { method: 'POST', body: {} }),
      await call('api/ai/scheduler-insights.js', token, { method: 'POST', body: {} }),
      await call('api/debug.js', token),
    ];
    assert('  and a deleted one is signed out of every one of them',
      gone.every(x => x.statusCode === 401), gone.map(x => x.statusCode).join(','));
  }

  console.log('\n[the resync, which also takes the admin secret]');
  {
    const run = (token, body = {}) => call('api/admin/sync-db.js', token, { method: 'POST', body });
    const admin = account({ role: 'admin', division_roles: { turf: 'admin' } });
    const token = signIn(admin);
    manageUsers(admin, { role: 'level1', division_roles: { turf: 'level1' } });
    let r = await run(token);
    assert('an admin stood down since sign-in cannot run it on the token',
      r.statusCode === 403, String(r.statusCode));
    DB.failRead = true;
    r = await quietly(() => run(token));
    DB.failRead = false;
    assert('  an account that cannot be read is a 503 rather than a refusal',
      r.statusCode === 503, String(r.statusCode));
    r = await quietly(() => run(token, { adminSecret: process.env.ADMIN_SECRET, companyCode: COMPANY }));
    assert('  and the admin secret still works whatever the token says',
      r.statusCode !== 403 && r.statusCode !== 503, `${r.statusCode} ${JSON.stringify(r.body)}`);

    // Taking the body's company code on trust let any company's level3
    // rebuild another company's tables and read back its record counts.
    const own = account({ role: 'level3', division_roles: { turf: 'level3' } });
    const ownToken = signIn(own);
    r = await quietly(() => run(ownToken, { companyCode: 'OTH' }));
    assert('a company admin cannot resync another company',
      r.statusCode === 403 && /own company/.test(r.body.error), `${r.statusCode} ${JSON.stringify(r.body)}`);
    r = await quietly(() => run(ownToken, { companyCode: COMPANY.toLowerCase() }));
    assert('  but can resync their own, however it is spelled',
      r.statusCode === 200 && r.body.companyCode === COMPANY, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const platform = account({ role: 'admin', is_platform_admin: true });
    r = await quietly(() => run(signIn(platform), { companyCode: 'OTH' }));
    assert('  while a platform admin still can',
      r.statusCode === 200 && r.body.companyCode === 'OTH', `${r.statusCode} ${JSON.stringify(r.body)}`);
  }

  console.log('\n[the diagnostics during an outage]');
  {
    // The account read comes first everywhere, but an unreachable database is
    // what this endpoint exists to report — so a genuine token still gets the
    // environment and the database check, just not the blob listing.
    const row = account({ division_roles: { turf: 'level1' } });
    const token = signIn(row);
    DB.down = true;
    let r = await quietly(() => call('api/debug.js', token));
    DB.down = false;
    assert('with the database down, the debug endpoint still reports it',
      r.statusCode === 200 && r.body.checks && r.body.checks.DATABASE_URL === true
      && /Connection terminated/.test(String(r.body.dbCheck)),
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    assert('  says the account could not be read, and lists no data',
      r.body.account === 'could not be read' && r.body.appDataKeys === null, JSON.stringify(r.body));
    r = await call('api/debug.js', token);
    assert('  and with it back, the verified account gets the listing again',
      r.statusCode === 200 && r.body.account === 'ok' && Array.isArray(r.body.appDataKeys),
      JSON.stringify(r.body));
    const forged = jwt.sign({ userId: row.id, companyCode: COMPANY }, 'some-other-secret');
    DB.down = true;
    r = await quietly(() => call('api/debug.js', forged));
    DB.down = false;
    assert('  while a forged token is still refused, outage or not', r.statusCode === 401, String(r.statusCode));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Nothing gets around it
// ═══════════════════════════════════════════════════════════════════════════
function staticTests() {
  console.log('\n[every way in goes through the account]');

  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js')) files.push(p);
    }
  })(root('api'));
  const rel = p => path.relative(root('.'), p);
  const src = Object.fromEntries(files.map(p => [rel(p), fs.readFileSync(p, 'utf8')]));
  // Comments may name the helpers; only code is judged.
  const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // An un-awaited call resolves to a promise, and a promise is truthy: the
  // `if (!payload) return;` after it would read as a pass, with a payload that
  // has no company and no roles.
  const unawaited = [];
  for (const [f, s] of Object.entries(src)) {
    if (f === 'api/lib/auth.js') continue;
    for (const line of code(s).split('\n')) {
      if (/\b(requireAuth|requireDivision|requirePODivision|authenticate)\(/.test(line)
          && !/await (requireAuth|requireDivision|requirePODivision|authenticate)\(/.test(line)
          && !/require\(/.test(line)) {
        unawaited.push(`${f}: ${line.trim()}`);
      }
    }
  }
  assert('every call to the auth helpers is awaited', unawaited.length === 0, unawaited.join(' | '));

  const verifiers = Object.entries(src)
    .filter(([f, s]) => f !== 'api/lib/auth.js' && /jwt\.verify\(/.test(code(s)))
    .map(([f]) => f);
  assert('no endpoint checks a token on its own', verifiers.length === 0, verifiers.join(', '));

  const signers = Object.entries(src).filter(([, s]) => /jwt\.sign\(/.test(code(s))).map(([f]) => f);
  assert('  and only sign-in signs one', signers.join(',') === 'api/auth/login.js', signers.join(','));

  // The cron jobs read the Authorization header too, but for their own
  // secret, which is not a sign-in and has no account behind it.
  const readers = Object.entries(src)
    .filter(([f, s]) => f !== 'api/lib/auth.js' && /headers\.authorization|headers\['authorization'\]/.test(code(s)))
    .map(([f]) => f);
  assert('only the auth library and the cron jobs read the Authorization header',
    readers.every(f => /^api\/cron\//.test(f)), readers.join(', '));
  assert('  and the cron jobs compare it to their own secret',
    readers.every(f => /CRON_SECRET/.test(src[f])), readers.filter(f => !/CRON_SECRET/.test(src[f])).join(', '));
}

// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  await requireAuthTests();
  await guardTests();
  await endpointTests();
  staticTests();

  Module._load = origLoad;
  console.log(`\n${'─'.repeat(40)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(40)}`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
