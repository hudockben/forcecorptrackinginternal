#!/usr/bin/env node
'use strict';
// Anywhere east of Greenwich a DATE read back from the driver used to lose a
// day on its way through safeDate. Pin the clock there so the assertion below
// actually discriminates instead of passing by geography. Set before anything
// touches a Date.
process.env.TZ = 'Europe/Berlin';
/**
 * api/timesheet-entries.js — scoping, routing, and the guards around them.
 *
 * Run: node scripts/test-timesheet-entries.js
 * (scripts/test-timesheet-entries-sql.js drives the same handler against a
 * real PostgreSQL; this one needs no database.)
 *
 * timesheet.html's "My Recent Entries" sends no user_id — it asks for a status
 * and a date window and trusts the endpoint to scope the rest. The endpoint
 * used to read that omission as "no filter" for any caller holding payroll
 * access, so a supervisor who also submits their own time got back every entry
 * in the company. The card renders no employee name, so four crew members'
 * identical day on one job looked exactly like four of the supervisor's own —
 * time they never worked, on a job they were never on.
 *
 * The rule under test: own rows by default, for everyone. Company-wide is an
 * opt-in (?scope=all) and one named user is another (?user_id=N), both
 * admin-only. A non-admin who asks for either is scoped to themselves, not
 * refused. Separately, the list branch must not swallow ?action=split.
 *
 * No DB or server required — the neon driver and the auth module are stubbed
 * at require time, and the sql mock records each statement so the WHERE clause
 * and its bound values can be asserted directly.
 */

const path   = require('path');
const fs     = require('fs');
const Module = require('module');

const FIELD = { companyCode: 'FCT', userId: 7,  username: 'strickallen', payrollAdmin: false };
const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',      payrollAdmin: true  };

let CURRENT_SQL = null;
let NEXT_AUTH   = FIELD;

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: () => NEXT_AUTH,
      requireDivision: () => null,
      // Mirror the real gate: canAdmin is hasDivisionAccess(payload,'payroll').
      // A stub that always says yes would let a scoping test pass without any
      // scoping check at all.
      hasDivisionAccess: (p, area) => (area === 'payroll' ? !!(p && p.payrollAdmin) : true),
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// One row per crew member on the same paving day — the shape that made the
// leak invisible on the card.
const CREW_DAY = [7, 11, 12, 13].map((uid, i) => ({
  id: 100 + i, company_code: 'FCT', user_id: uid, username: `crew${uid}`,
  entry_type: 'daily', work_date: '2025-07-29', status: 'submitted',
  division: 'paving', job_id: '26019', job_label: 'Punxsy Storage Lot',
  start_time: '07:00', end_time: '16:30', computed_hours: 9.5, travel_hours: 1,
}));

/**
 * Drive one GET through the handler. Returns the recorded list query along
 * with the response, so a test can assert on the SQL the endpoint built —
 * `userFilter` is the value bound to `user_id = $n`, or undefined when the
 * statement carries no user_id predicate at all.
 */
async function get(query, auth = FIELD) {
  NEXT_AUTH = auth;
  let listQuery = null;

  CURRENT_SQL = (strings, ...values) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT * FROM timesheet_entries')) {
      const idx = strings.findIndex(s => /user_id\s*=\s*$/.test(s));
      listQuery = { sql: q, userFilter: idx === -1 ? undefined : values[idx] };
      // Return only the rows the filter would actually have matched, so the
      // assertions can read the response the way the page does.
      const rows = listQuery.userFilter === undefined
        ? CREW_DAY
        : CREW_DAY.filter(r => r.user_id === listQuery.userFilter);
      return Promise.resolve(rows);
    }
    if (q.startsWith('SELECT key, value FROM app_data')) return Promise.resolve([]);
    return Promise.resolve([]);
  };

  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method: 'GET', query, body: {} }, res);
  return { res, listQuery };
}

async function scopeTests() {
  console.log('\n[GET /api/timesheet-entries — default scope]');

  {
    // Exactly what timesheet.html sends.
    const { res, listQuery } = await get({ status: 'submitted_approved', from: '2025-07-27', to: '2025-08-09' });
    assert('a field user is filtered to their own user_id', listQuery.userFilter === 7);
    assert('and gets back only their own entry', res.body.entries.length === 1);
  }
  {
    const { res, listQuery } = await get({ status: 'submitted_approved', from: '2025-07-27', to: '2025-08-09' }, ADMIN);
    assert('an admin sending no scope is filtered to their own user_id too',
      listQuery.userFilter === 42, `bound ${JSON.stringify(listQuery.userFilter)}`);
    assert('so "My Recent Entries" cannot show the crew\'s day',
      res.body.entries.length === 0, `${res.body.entries.length} entries leaked`);
  }
  {
    const { listQuery } = await get({ status: 'draft' }, ADMIN);
    assert('the drafts slice is scoped the same way', listQuery.userFilter === 42);
  }
  {
    // The unbounded "Show older entries" toggle — no status, no window. The
    // widest possible request, and still only the caller's own rows.
    const { listQuery } = await get({}, ADMIN);
    assert('an empty query does not widen to the company', listQuery.userFilter === 42);
  }

  console.log('\n[GET /api/timesheet-entries — explicit scope]');
  {
    // Exactly what payroll.html sends.
    const { res, listQuery } = await get({ status: 'submitted_approved', scope: 'all' }, ADMIN);
    assert('?scope=all drops the user_id predicate for an admin', listQuery.userFilter === undefined);
    assert('and returns the whole crew', res.body.entries.length === 4);
  }
  {
    const { res, listQuery } = await get({ scope: 'all' }, FIELD);
    assert('a field user asking for scope=all is scoped to themselves', listQuery.userFilter === 7);
    assert('and is not refused — nothing to reveal, nothing to refuse',
      res.statusCode === 200, `HTTP ${res.statusCode}`);
    assert('so they still see their own entry', res.body.entries.length === 1);
  }
  {
    const { res, listQuery } = await get({ user_id: '11' }, ADMIN);
    assert('?user_id=N targets that user for an admin', listQuery.userFilter === 11);
    assert('and returns that user\'s rows only',
      res.body.entries.length === 1 && res.body.entries[0].user_id === 11);
  }
  {
    const { listQuery } = await get({ user_id: '11' }, FIELD);
    assert('a field user cannot read another user_id', listQuery.userFilter === 7);
  }
  {
    // scope=all is the wider of the two; a request carrying both should not
    // let it override the narrower named user.
    const { listQuery } = await get({ user_id: '11', scope: 'all' }, ADMIN);
    assert('user_id wins over scope=all', listQuery.userFilter === 11);
  }
  {
    const { listQuery } = await get({ scope: 'ALL' }, ADMIN);
    assert('the opt-in is exact — "ALL" is not "all"', listQuery.userFilter === 42);
  }
  {
    // A token with no user id has nothing to scope to. Running the query
    // anyway would bind null and reproduce the leak, so it has to fail closed.
    const { res, listQuery } = await get({}, { companyCode: 'FCT', username: 'legacy', payrollAdmin: true });
    assert('a token with no user id is rejected, not widened', res.statusCode === 401);
    assert('and no query runs at all', listQuery === null);
  }
}

// The list branch answered every GET, including the action-specific ones, so
// the payroll modal's re-edit pre-fill silently got an entry list instead of a
// split and fell back to blank rows.
async function actionRoutingTests() {
  console.log('\n[GET ?action=split — not swallowed by the list branch]');

  NEXT_AUTH = ADMIN;
  let sawListQuery = false, sawEntryLookup = false;
  CURRENT_SQL = (strings) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT * FROM timesheet_entries')) { sawListQuery = true; return Promise.resolve([]); }
    if (q.startsWith('SELECT id, entry_type, division')) {
      sawEntryLookup = true;
      return Promise.resolve([{ id: 5, entry_type: 'daily', division: 'paving', job_id: 'J1', job_label: 'X' }]);
    }
    return Promise.resolve([]);
  };
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method: 'GET', query: { action: 'split', id: '5' }, body: {} }, res);

  assert('the list branch does not run', !sawListQuery);
  assert('the split branch does', sawEntryLookup);
  assert('and the response carries a split, not entries',
    Array.isArray(res.body && res.body.split), JSON.stringify(res.body).slice(0, 80));
}

// The other half of what was on the screen: four identical submitted rows for
// one day. The client used to forget the draft it had just created whenever
// the submit leg failed, so every retry posted another row. Submit is the gate
// into payroll, so it is where the second one has to be refused.
async function duplicateSubmitTests() {
  console.log('\n[POST ?action=submit — duplicate gate]');

  const DRAFT = {
    id: 500, company_code: 'FCT', user_id: 7, username: 'strickallen',
    entry_type: 'daily', work_date: '2025-07-29', status: 'draft',
    division: 'paving', job_id: '26019', job_label: 'Punxsy Storage Lot',
    start_time: '07:00', end_time: '16:30', computed_hours: 9.5,
  };

  async function submit(dupeRows, draft = DRAFT) {
    NEXT_AUTH = FIELD;
    let updated = false;
    CURRENT_SQL = (strings) => {
      const q = strings.join('?').replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT * FROM timesheet_entries')) return Promise.resolve([draft]);
      if (q.includes('JOIN timesheet_entries b'))          return Promise.resolve(dupeRows);
      if (q.startsWith('UPDATE timesheet_entries')) {
        updated = true;
        return Promise.resolve([Object.assign({}, draft, { status: 'submitted' })]);
      }
      return Promise.resolve([]);
    };
    const res = {
      statusCode: 200, body: null,
      setHeader() {}, status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; }, end() { return this; },
    };
    await handler({ method: 'POST', query: { action: 'submit', id: '500' }, body: {} }, res);
    return { res, updated };
  }

  {
    const { res, updated } = await submit([]);
    assert('a first submit goes through', updated && res.statusCode === 200);
  }
  {
    const { res, updated } = await submit([{ id: 499, status: 'submitted' }]);
    assert('a second identical submit is refused', res.statusCode === 409);
    assert('and the row is left as a draft', !updated);
    assert('the error names what already covers the day',
      /already have a submitted entry for this day, job and times/.test(res.body.error), res.body.error);
    assert('and points at the row', res.body.duplicate_of === '499');
  }
  {
    const { res } = await submit([{ id: 499, status: 'approved' }]);
    assert('an already-approved twin blocks it too',
      res.statusCode === 409 && /approved entry/.test(res.body.error));
  }
  {
    const off = Object.assign({}, DRAFT, { entry_type: 'time_off', time_off_type: 'vacation' });
    const { res } = await submit([{ id: 498, status: 'submitted' }], off);
    assert('time off gets its own wording',
      res.statusCode === 409 && /time-off entry for this day/.test(res.body.error), res.body.error);
  }
}

// A DATE column arrives from the driver as a JS Date at LOCAL midnight.
// Converting that to UTC to slice the day off moves it backwards for any
// runtime east of Greenwich — the entry a worker filed on the 29th reads as
// the 28th, and the injected cost row lands on the wrong day with it.
async function dateRoundTripTests() {
  console.log('\n[work_date round-trip (TZ=Europe/Berlin)]');

  const berlin = new Date(2026, 6, 29);   // local midnight, July 29
  const sane = berlin.toISOString().slice(0, 10) === '2026-07-28';
  if (!sane) {
    console.log('  ! runtime ignored TZ — this assertion cannot discriminate here');
  }

  NEXT_AUTH = FIELD;
  CURRENT_SQL = (strings) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT * FROM timesheet_entries')) {
      return Promise.resolve([{
        id: 900, company_code: 'FCT', user_id: 7, username: 'strickallen',
        entry_type: 'daily', work_date: berlin, status: 'submitted',
        division: 'paving', job_id: '26019', start_time: '07:00', end_time: '16:30',
      }]);
    }
    return Promise.resolve([]);
  };
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method: 'GET', query: {}, body: {} }, res);

  assert('a DATE at local midnight keeps its day',
    res.body.entries[0].work_date === '2026-07-29', res.body.entries[0].work_date);
}

// Un-approve rewrites the blob, then mirrors the delete. If the mirror throws,
// a quarry/trucking row outlives the un-approve on an entry that now reads
// 'submitted'. Deleting the entry is the last chance to take it along, so the
// sweep keys on the entry's division rather than on its status.
async function deleteSweepTests() {
  console.log('\n[DELETE sweeps injected rows whatever the status]');

  async function del(entry) {
    NEXT_AUTH = ADMIN;
    let sweptTrucking = false, sweptQuarry = false;
    CURRENT_SQL = (strings, ...values) => {
      const q = strings.join('?').replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT * FROM timesheet_entries')) return Promise.resolve([entry]);
      if (q.includes('FROM daily_tracking'))               return Promise.resolve([{ cnt: 0 }]);
      // Reading a division's blob is the tell that its sweep ran. The key is a
      // bound value, not part of the template, so match on the values.
      if (q.startsWith('SELECT value FROM app_data')) {
        const key = String(values[0] || '');
        if (key.includes('truck_division')) sweptTrucking = true;
        if (key.includes('quarry'))         sweptQuarry   = true;
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    };
    const res = {
      statusCode: 200, body: null,
      setHeader() {}, status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; }, end() { return this; },
    };
    await handler({ method: 'DELETE', query: { id: String(entry.id) }, body: {} }, res);
    return { res, sweptTrucking, sweptQuarry };
  }

  const base = {
    id: 700, company_code: 'FCT', user_id: 7, username: 'strickallen',
    entry_type: 'daily', work_date: '2026-07-29', job_id: 'x',
  };
  {
    const { res, sweptTrucking } = await del(Object.assign({}, base, { division: 'trucking', status: 'submitted' }));
    assert('a submitted trucking entry still gets swept', sweptTrucking, `HTTP ${res.statusCode}`);
  }
  {
    const { sweptQuarry } = await del(Object.assign({}, base, { division: 'quarry', status: 'submitted' }));
    assert('a submitted quarry entry still gets swept', sweptQuarry);
  }
  {
    const { sweptTrucking, sweptQuarry } = await del(Object.assign({}, base, { division: 'paving', status: 'draft' }));
    assert('a paving draft sweeps neither — nothing to find there',
      !sweptTrucking && !sweptQuarry);
  }
}

// ── Statements this file ships must be parseable SQL ──────────────────────
// A `//` line inside a sql`` template is not a comment. The tag only ever sees
// text, so the line is shipped to Postgres — which has no `//` comment syntax
// — and the statement fails to parse. One explanatory comment written inside
// the daily_tracking INSERT took out turf, paving and kiewit approval
// wholesale: every approve threw, hit the injection catch, and rolled itself
// back with "failed to write cost tracking rows". It reads exactly like a
// working comment in the editor, which is what makes it worth a test.
function sqlSyntaxTests() {
  console.log('\n[api — sql`` templates are valid SQL]');
  const apiDir = path.resolve(__dirname, '..', 'api');
  const files = [];
  (function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules') continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith('.js')) files.push(p);
    }
  })(apiDir);
  assert('the api directory was found and walked', files.length > 10, `${files.length} files`);

  // Every sql`...` template, matched non-greedily from the tag to the closing
  // backtick. Checked across the whole of api/, not just this endpoint: the
  // mistake is invisible on review anywhere it is made.
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /sql`([\s\S]*?)`/g;
    let m;
    while ((m = re.exec(src))) {
      const startLine = src.slice(0, m.index).split('\n').length;
      m[1].split('\n').forEach((line, k) => {
        if (/^\s*\/\//.test(line)) {
          offenders.push(`${path.relative(apiDir, f)}:${startLine + k + 1} ${line.trim().slice(0, 50)}`);
        }
      });
    }
  }
  assert('no // comment is embedded in a SQL statement anywhere in api/',
    offenders.length === 0, offenders.join(' | '));

  const src = fs.readFileSync(path.join(apiDir, 'timesheet-entries.js'), 'utf8');

  // The daily_tracking INSERT is the one that got bitten; check it is also
  // internally consistent, since a stray line there shifts every value by one.
  const ins = src.match(/INSERT INTO daily_tracking \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)\s*\n\s*ON CONFLICT/);
  assert('the daily_tracking INSERT is still findable', !!ins);
  if (ins) {
    const cols = ins[1].split(',').map(s => s.trim()).filter(Boolean);
    const vals = ins[2].split(',').map(s => s.trim()).filter(Boolean);
    assert('its column list and VALUES list are the same length',
      cols.length === vals.length, `${cols.length} columns vs ${vals.length} values`);
    assert('and every value is a bound placeholder, not bare text',
      vals.every(v => v.startsWith('${')), vals.filter(v => !v.startsWith('${')).join(' | '));
  }
}

(async () => {
  await scopeTests();
  await actionRoutingTests();
  await duplicateSubmitTests();
  await dateRoundTripTests();
  await deleteSweepTests();
  sqlSyntaxTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
