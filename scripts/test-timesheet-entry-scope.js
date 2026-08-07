#!/usr/bin/env node
'use strict';
/**
 * GET /api/timesheet-entries — whose rows come back.
 *
 * Run: node scripts/test-timesheet-entry-scope.js
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
    if (q.startsWith('SELECT id, division')) { sawEntryLookup = true; return Promise.resolve([{ id: 5, division: 'paving', job_id: 'J1', job_label: 'X' }]); }
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

(async () => {
  await scopeTests();
  await actionRoutingTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
