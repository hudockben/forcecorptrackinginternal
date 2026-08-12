#!/usr/bin/env node
'use strict';
// A DATE read back from the driver used to lose a day on its way through
// safeDate anywhere east of Greenwich. Pin the clock there so the assertions
// below actually discriminate instead of passing by geography. Set before
// anything touches a Date.
process.env.TZ = 'Europe/Berlin';
/**
 * api/fuel-submissions.js and the two pages in front of it.
 *
 * Run: node scripts/test-fuel-submissions.js
 * No DB or server required — the neon driver and the auth module are stubbed
 * at require time, and the sql mock records each statement so the WHERE clause
 * and its bound values can be asserted directly.
 *
 * Three things are worth pinning here, in descending order of how quietly they
 * would break:
 *
 * 1. ZERO IS AN ANSWER. Both meter readings are asked for as "0 if not Force
 *    Fuel", so every completeness check in this feature — server-side, on the
 *    field form, and in the Fuel Admin edit modal — has to treat 0 as filled
 *    in. A plain truthiness test passes every ordinary case and then refuses
 *    the correctly-answered form of every driver who is not on Force Fuel,
 *    pointing at a box with a 0 sitting in it.
 *
 * 2. THE OPTION LISTS ARE COPIED THREE TIMES. api/lib/fuel-options.js is
 *    canonical; fuel.html and fuel-admin.html carry copies because they are
 *    static pages with no build step. The server refuses a submit whose card
 *    or state is not on ITS list, so a value that lives only in a page is one
 *    a worker can pick and then be refused for picking.
 *
 * 3. OWN ROWS BY DEFAULT. A request that names no scope gets the caller's own
 *    fuel entries, for every caller including admins — company-wide is an
 *    opt-in, never something a page falls into by forgetting to ask.
 */

const path   = require('path');
const fs     = require('fs');
const Module = require('module');

const FIELD = { companyCode: 'FCT', userId: 7,  username: 'strickallen', fuelAdmin: false };
const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',      fuelAdmin: true  };

let CURRENT_SQL = null;
let NEXT_AUTH   = FIELD;

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: () => NEXT_AUTH,
      requireDivision: () => null,
      // Mirror the real gate: canAdmin is hasDivisionAccess(payload,
      // 'fuel_admin'). A stub that always says yes would let a scoping test
      // pass without any scoping check at all.
      hasDivisionAccess: (p, area) => (area === 'fuel_admin' ? !!(p && p.fuelAdmin) : true),
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'fuel-submissions.js'));
const { normalizeBody, missingFields, isBlank, gallonsFromMeters, REPORTED_FIELDS } = handler._test;
const OPTIONS = require(path.resolve(__dirname, '..', 'api', 'lib', 'fuel-options.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// A complete, valid submission. Individual tests knock one field out of it.
const FULL = {
  work_date: '2026-08-11',
  employee_username: 'strickallen',
  fuel_card: 'Guttman',
  fuel_type: 'Off Road Diesel',
  gallons: '84.5',
  mileage: '132480',
  truck_number: '412',
  beginning_meter: '0',
  ending_meter: '0',
  fueling_site: 'Force Yard',
  city_fueled: 'Punxsutawney',
  state: 'PA',
  tank_number: '2',
};

// A row as the driver hands it back — same keys, column types.
function rowFrom(overrides) {
  const { data } = normalizeBody(Object.assign({}, FULL, overrides || {}));
  return Object.assign({
    id: 1, company_code: 'FCT', user_id: 7, username: 'strickallen', status: 'draft',
  }, data);
}

function makeRes() {
  return {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
}

// ── 1. Zero is an answer ────────────────────────────────────────────────────
function zeroTests() {
  console.log('\n[Zero is a reported value, not a missing one]');

  assert('isBlank(0) is false',            isBlank(0) === false);
  assert("isBlank('0') is false",          isBlank('0') === false);
  assert("isBlank('') is true",            isBlank('') === true);
  assert('isBlank(null) is true',          isBlank(null) === true);
  assert('isBlank(undefined) is true',     isBlank(undefined) === true);
  assert('isBlank("  ") is true',          isBlank('  ') === true);

  {
    // The exact shape the instruction on the form produces: not on Force
    // Fuel, so both meters read 0.
    const { data, error } = normalizeBody(FULL);
    assert('a form with both meters at 0 parses', !error, error);
    assert('beginning_meter stays 0, not null', data.beginning_meter === 0);
    assert('ending_meter stays 0, not null',     data.ending_meter === 0);
    assert('and the row counts as complete',     missingFields(data).length === 0,
      JSON.stringify(missingFields(data)));
  }
  {
    const { data } = normalizeBody(Object.assign({}, FULL, { gallons: '0', truck_number: '0', tank_number: '0', mileage: '0' }));
    assert('zeros elsewhere are kept too', data.gallons === 0 && data.truck_number === 0 && data.tank_number === 0 && data.mileage === 0);
    assert('a row of zeros is still complete', missingFields(data).length === 0);
  }
  {
    const { data } = normalizeBody(Object.assign({}, FULL, { ending_meter: '' }));
    assert('an EMPTY meter is missing', missingFields(data).includes('Ending Meter Reading'));
    assert('and nothing else is', missingFields(data).length === 1, JSON.stringify(missingFields(data)));
  }
}

// ── 1b. Gallons off the tank meter ──────────────────────────────────────────
// The table every copy of the rule is measured against — the server's and the
// one in each page. Kept as data so pageTests() can run the pages' copies
// through exactly the same cases.
const METER_CASES = [
  // [begin, end, expected gallons or null, what it is]
  [0,      0,      null,  'a card purchase — both meters read 0'],
  [1200,   1284.5, 84.5,  'an ordinary Force Fuel fill'],
  [1200,   1200,   null,  'identical readings — nothing pumped'],
  [1200,   1100,   null,  'a rolled-over or replaced meter'],
  [0,      84.5,   84.5,  'a tank whose meter starts at 0'],
  [null,   1284.5, null,  'no beginning reading yet'],
  [1200,   null,   null,  'no ending reading yet'],
  [null,   null,   null,  'neither reading yet'],
  [1200.4, 1200.7, 0.3,   'a fraction of a gallon, rounded to 2dp'],
];

function meterTests() {
  console.log('\n[Gallons off the tank meter]');
  for (const [b, e, want, what] of METER_CASES) {
    const got = gallonsFromMeters(b, e);
    assert(`${what} → ${want === null ? 'reported' : want}`, got === want, `got ${got}`);
  }

  console.log('\n[…and normalizeBody applies it]');
  {
    // The driver's own figure loses to the tank. Both pages show the metered
    // number read-only, so a body that says otherwise is stale or hand-made.
    const { data } = normalizeBody(Object.assign({}, FULL, {
      beginning_meter: '1200', ending_meter: '1284.5', gallons: '10',
    }));
    assert('a metered fill overrides the gallons in the body', data.gallons === 84.5,
      String(data.gallons));
  }
  {
    const { data } = normalizeBody(Object.assign({}, FULL, {
      beginning_meter: '1200', ending_meter: '1284.5', gallons: '',
    }));
    assert('and fills gallons in when the body sent none', data.gallons === 84.5, String(data.gallons));
    assert('so the row is complete without a typed gallons figure',
      missingFields(data).length === 0, JSON.stringify(missingFields(data)));
  }
  {
    // The case that makes this rule conditional rather than absolute: a card
    // purchase has no tank meter, so the receipt is the only source there is.
    const { data } = normalizeBody(Object.assign({}, FULL, { gallons: '41.2' }));
    assert('a card purchase (0/0) keeps the reported gallons', data.gallons === 41.2,
      String(data.gallons));
  }
  {
    const { data } = normalizeBody(Object.assign({}, FULL, {
      beginning_meter: '1200', ending_meter: '1100', gallons: '41.2',
    }));
    assert('a rolled-over meter keeps the reported gallons', data.gallons === 41.2,
      String(data.gallons));
  }
  {
    const { data } = normalizeBody(Object.assign({}, FULL, {
      beginning_meter: '1200', ending_meter: '1200', gallons: '41.2',
    }));
    assert('identical readings keep the reported gallons', data.gallons === 41.2,
      String(data.gallons));
  }
  {
    // A meter fill with no gallons typed and no meters either is still just
    // an incomplete draft — the rule must not invent a figure.
    const { data } = normalizeBody({ work_date: '2026-08-11' });
    assert('no meters and no gallons leaves gallons null', data.gallons === null);
    assert('and Gallons is still listed as missing',
      missingFields(data).includes('Gallons'));
  }
}

// ── 2. Parsing and refusals ─────────────────────────────────────────────────
function parseTests() {
  console.log('\n[normalizeBody]');

  assert('a date is required',           normalizeBody({}).error != null);
  assert('a junk date is refused',       normalizeBody({ work_date: 'yesterday' }).error != null);
  assert('a bare date is enough for a draft',
    normalizeBody({ work_date: '2026-08-11' }).data != null);
  assert('and that draft is incomplete',
    missingFields(normalizeBody({ work_date: '2026-08-11' }).data).length === 12);

  assert('an unknown fuel card is refused',
    normalizeBody(Object.assign({}, FULL, { fuel_card: 'Shell' })).error != null);
  assert('an unknown fuel type is refused',
    normalizeBody(Object.assign({}, FULL, { fuel_type: 'Kerosene' })).error != null);
  assert('a non-state is refused',
    normalizeBody(Object.assign({}, FULL, { state: 'ZZ' })).error != null);
  assert('a lowercase state is accepted and upper-cased',
    normalizeBody(Object.assign({}, FULL, { state: 'pa' })).data.state === 'PA');
  assert('the en-dash bulk card is accepted verbatim',
    normalizeBody(Object.assign({}, FULL, { fuel_card: 'Bulk Fuel – No card' })).data.fuel_card === 'Bulk Fuel – No card');

  assert('a negative gallons figure is refused',
    normalizeBody(Object.assign({}, FULL, { gallons: '-5' })).error != null);
  assert('non-numeric gallons are refused',
    normalizeBody(Object.assign({}, FULL, { gallons: 'lots' })).error != null);
  assert('a fractional truck number is refused',
    normalizeBody(Object.assign({}, FULL, { truck_number: '41.5' })).error != null);
  assert('gallons round to 2dp',
    normalizeBody(Object.assign({}, FULL, { gallons: '84.567' })).data.gallons === 84.57);
  assert('an absent optional field is null, not 0',
    normalizeBody({ work_date: '2026-08-11' }).data.gallons === null);

  console.log('\n[missingFields names the form labels, in form order]');
  const bare = normalizeBody({ work_date: '2026-08-11' }).data;
  const miss = missingFields(bare);
  assert('Employee comes before Fuel Card', miss.indexOf('Employee') < miss.indexOf('Fuel Card Used'));
  assert('Tank Number comes last',          miss[miss.length - 1] === 'Tank Number');
  assert('Date is not listed (it is set)',  !miss.includes('Date'));
  // Gallons is worked out from the two readings, so it is asked for after
  // them — on the form and in the list of what is still missing.
  assert('Gallons comes after both meter readings',
    miss.indexOf('Gallons') > miss.indexOf('Ending Meter Reading') &&
    miss.indexOf('Ending Meter Reading') > miss.indexOf('Beginning Meter Reading'),
    miss.join(', '));
}

// ── 3. Request routing and scope ────────────────────────────────────────────
async function get(query, auth = FIELD) {
  NEXT_AUTH = auth;
  let listQuery = null;
  CURRENT_SQL = (strings, ...values) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT * FROM fuel_submissions')) {
      const idx = strings.findIndex(s => /user_id\s*=\s*$/.test(s));
      listQuery = { sql: q, userFilter: idx === -1 ? undefined : values[idx] };
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  const res = makeRes();
  await handler({ method: 'GET', query, body: {} }, res);
  return { res, listQuery };
}

async function scopeTests() {
  console.log('\n[GET — own rows by default]');
  {
    const { listQuery } = await get({ status: 'submitted_approved', from: '2026-07-01', to: '2026-08-11' });
    assert('a field user is filtered to their own user_id', listQuery.userFilter === 7);
  }
  {
    const { listQuery } = await get({}, ADMIN);
    assert('an admin who asks for nothing gets their OWN rows', listQuery.userFilter === 42);
  }
  {
    const { listQuery } = await get({ scope: 'all' }, ADMIN);
    assert('?scope=all lifts the filter for an admin', listQuery.userFilter === undefined);
  }
  {
    const { listQuery } = await get({ scope: 'all' }, FIELD);
    assert('?scope=all from a field user is still scoped to them', listQuery.userFilter === 7);
  }
  {
    const { listQuery } = await get({ user_id: '11' }, ADMIN);
    assert('?user_id=N names one submitter, for an admin', listQuery.userFilter === 11);
  }
  {
    const { listQuery } = await get({ user_id: '11' }, FIELD);
    assert('?user_id=N from a field user is ignored', listQuery.userFilter === 7);
  }
  {
    const { res } = await get({}, { companyCode: 'FCT', username: 'ghost', fuelAdmin: true });
    assert('a token with no user id is refused rather than handed the company',
      res.statusCode === 401, `got ${res.statusCode}`);
  }
  {
    const { listQuery } = await get({ employee: 'strickallen', fuel_card: 'Wex', fuel_type: 'Gas' });
    assert('the employee / card / type filters reach the SQL',
      /employee_username/.test(listQuery.sql) && /fuel_card/.test(listQuery.sql) && /fuel_type/.test(listQuery.sql));
  }
}

// ── 4. Submit ───────────────────────────────────────────────────────────────
// Drive one action through the handler against a stubbed row.
// The bound values of each recorded statement, by the same index as `seen`.
// Some rules are enforced by a flag computed in JS and bound into a CASE, so
// the SQL text alone can't tell you whether they fired.
let seenValues = [];

async function action(method, query, body, row, auth = FIELD) {
  NEXT_AUTH = auth;
  const seen = [];
  seenValues = [];
  CURRENT_SQL = (strings, ...values) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    seen.push(q);
    seenValues.push(values);
    if (q.startsWith('SELECT * FROM fuel_submissions WHERE id')) {
      return Promise.resolve(row ? [row] : []);
    }
    if (q.startsWith('SELECT b.id, b.status FROM fuel_submissions a')) {
      return Promise.resolve([]);           // no duplicate
    }
    // The balance branch, matched BEFORE the generic UPDATE below — that one
    // starts with the same six words and would otherwise answer for it,
    // handing back a row on which nothing had changed.
    if (q.startsWith('UPDATE fuel_submissions SET balance_status')) {
      const [status, note] = values;
      // Mirrors the statement's own `AND status = 'approved'`. A mock that
      // returned the row regardless would let the eligibility rule be
      // deleted from the handler without a single test noticing.
      if (!row || row.status !== 'approved') return Promise.resolve([]);
      return Promise.resolve([Object.assign({}, row, { balance_status: status, balance_note: note })]);
    }
    if (q.startsWith('UPDATE fuel_submissions')) {
      // Echo the row back with whatever status the statement set, the way
      // RETURNING * would.
      const m = /SET status = '(\w+)'/.exec(q);
      return Promise.resolve([Object.assign({}, row, m ? { status: m[1] } : {})]);
    }
    if (q.startsWith('INSERT INTO fuel_audit_log')) return Promise.resolve([]);
    if (q.startsWith('DELETE FROM fuel_submissions')) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  const res = makeRes();
  await handler({ method, query, body: body || {} }, res);
  return { res, seen };
}

async function submitTests() {
  console.log('\n[POST ?action=submit]');
  {
    const { res } = await action('POST', { action: 'submit', id: '1' }, null, rowFrom());
    assert('a complete draft submits', res.statusCode === 200 && res.body.ok === true,
      JSON.stringify(res.body));
    assert('and comes back submitted', res.body.entry.status === 'submitted');
  }
  {
    // The case the whole zero rule exists for: not on Force Fuel, both meters
    // at 0, everything else filled. This must go through.
    const row = rowFrom({ beginning_meter: '0', ending_meter: '0' });
    const { res } = await action('POST', { action: 'submit', id: '1' }, null, row);
    assert('a non-Force-Fuel entry (0 meters) submits', res.statusCode === 200,
      JSON.stringify(res.body));
  }
  {
    const row = rowFrom({ city_fueled: '', tank_number: '' });
    const { res } = await action('POST', { action: 'submit', id: '1' }, null, row);
    assert('an incomplete draft is refused', res.statusCode === 400);
    assert('and the refusal names the empty fields',
      Array.isArray(res.body.missing_fields) &&
      res.body.missing_fields.includes('City Fueled') &&
      res.body.missing_fields.includes('Tank Number'),
      JSON.stringify(res.body));
  }
  {
    const row = Object.assign(rowFrom(), { user_id: 99 });
    const { res } = await action('POST', { action: 'submit', id: '1' }, null, row);
    assert("someone else's draft cannot be submitted", res.statusCode === 403);
  }
  {
    const row = Object.assign(rowFrom(), { status: 'submitted' });
    const { res } = await action('POST', { action: 'submit', id: '1' }, null, row);
    assert('a submitted row cannot be submitted twice', res.statusCode === 409);
  }
  {
    const { res } = await action('POST', { action: 'submit' }, null, rowFrom());
    assert('submit with no id is a 400', res.statusCode === 400);
  }
}

async function balanceTests() {
  console.log('\n[POST ?action=balance — the second review]');
  const approved = () => Object.assign(rowFrom(), { id: 1, status: 'approved' });

  {
    const { res } = await action('POST', { action: 'balance' },
      { ids: ['1'], balance_status: 'balanced' }, approved(), FIELD);
    assert('a field user cannot balance', res.statusCode === 403);
  }
  {
    const { res } = await action('POST', { action: 'balance' },
      { ids: ['1'], balance_status: 'sorted' }, approved(), ADMIN);
    assert('an invented balance status is refused', res.statusCode === 400);
  }
  {
    const { res } = await action('POST', { action: 'balance' },
      { ids: [], balance_status: 'balanced' }, approved(), ADMIN);
    assert('balancing nothing is refused', res.statusCode === 400);
  }
  {
    const { res, seen } = await action('POST', { action: 'balance' },
      { ids: ['1', '2', '2'], balance_status: 'balanced' }, approved(), ADMIN);
    assert('an admin can balance', res.statusCode === 200 && res.body.ok, JSON.stringify(res.body));
    const upd = seen.find(s => s.startsWith('UPDATE fuel_submissions SET balance_status'));
    // Balancing is the stage AFTER approval. Marking a submitted entry
    // balanced would account for fuel the office has not agreed to yet.
    assert('only approved entries are eligible', /status = 'approved'/.test(upd), upd);
    // Some neon-serverless paths mis-bind a JS array for ANY() and hang, so
    // the ids cross as one string and are split in SQL.
    assert('ids cross as a string, not a bound array',
      /string_to_array/.test(upd), upd);
  }
  {
    const { seen } = await action('POST', { action: 'balance' },
      { ids: ['1'], balance_status: 'balanced', balance_note: 'looks fine' }, approved(), ADMIN);
    const upd = seen.find(s => s.startsWith('UPDATE fuel_submissions SET balance_status'));
    assert('a balanced row is stamped with who and when',
      /balanced_at = CASE WHEN \?::boolean THEN NOW\(\)/.test(upd), upd.slice(0, 160));
    // One audit statement, not one per entry. This runs AFTER the update has
    // committed, on the path built for clearing a whole month from a single
    // statement match — a loop there times out and reports failure for work
    // that already succeeded.
    const audits = seen.filter(s => s.startsWith('INSERT INTO fuel_audit_log'));
    assert('the audit rows go in one statement', audits.length === 1, String(audits.length));
    assert('expanded by the database from one JSON parameter',
      /jsonb_to_recordset/.test(audits[0]), audits[0].slice(0, 140));
    // Selecting the eligible rows and then updating them separately reports
    // on a world that was true a round trip ago.
    assert('and eligibility is read off the update itself, not a prior select',
      !seen.some(s => s.startsWith('SELECT * FROM fuel_submissions WHERE company_code')),
      seen.join(' | ').slice(0, 200));
  }
  {
    // A note explains an issue. Carried onto a balanced row it would leave
    // the reason something was once a problem attached to a figure that
    // isn't one any more.
    const { res } = await action('POST', { action: 'balance' },
      { ids: ['1'], balance_status: 'balanced', balance_note: 'was short 4 gal' }, approved(), ADMIN);
    assert('a note is dropped when the verdict is not an issue',
      res.body.entries[0].balance_note === null, String(res.body.entries[0].balance_note));
  }
  {
    const { res } = await action('POST', { action: 'balance' },
      { ids: ['1'], balance_status: 'issue', balance_note: 'not on the Guttman statement' },
      approved(), ADMIN);
    assert('an issue keeps its note',
      res.body.entries[0].balance_note === 'not on the Guttman statement',
      String(res.body.entries[0].balance_note));
  }
  {
    const row = Object.assign(rowFrom(), { id: 1, status: 'submitted' });
    const { res } = await action('POST', { action: 'balance' },
      { ids: ['1'], balance_status: 'balanced' }, row, ADMIN);
    assert('an entry still awaiting the daily review cannot be balanced',
      res.statusCode === 409, JSON.stringify(res.body));
  }

  console.log('\n[correcting a balanced entry un-signs it]');
  {
    // The same invariant un-approving enforces: a row cannot go on reading
    // "balanced by office" once the figure the office balanced has changed
    // underneath it — and this workflow expects entries to be corrected after
    // a match, so it is the ordinary case.
    const row = Object.assign(rowFrom(), {
      id: 1, status: 'approved', balance_status: 'balanced', balanced_by_name: 'office',
    });
    const { seen } = await action('PUT', { id: '1' },
      Object.assign({}, FULL, { gallons: '120' }), row, ADMIN);
    const upd = seen.find(s => s.startsWith('UPDATE fuel_submissions SET work_date'));
    assert('changing the gallons resets the balance',
      /balance_status = CASE WHEN \?::boolean THEN 'pending'/.test(upd), upd.slice(0, 400));
    // The flag is computed in JS and bound; true here means "reset".
    const idx = seen.indexOf(upd);
    assert('and the reset flag is set', seenValues[idx].includes(true), JSON.stringify(seenValues[idx]));
  }
  {
    // Fixing a misspelt city has nothing to do with whether the gallons were
    // accounted for. Throwing the verdict away for it would make the
    // reconciler redo a month's work over a typo.
    const row = Object.assign(rowFrom(), {
      id: 1, status: 'approved', balance_status: 'balanced', balanced_by_name: 'office',
    });
    const { seen } = await action('PUT', { id: '1' },
      Object.assign({}, FULL, { city_fueled: 'Punxsutawny' }), row, ADMIN);
    const idx = seen.findIndex(s => s.startsWith('UPDATE fuel_submissions SET work_date'));
    assert('but correcting a spelling does not', !seenValues[idx].includes(true),
      JSON.stringify(seenValues[idx]));
  }
  {
    const row = Object.assign(rowFrom(), { id: 1, status: 'approved', balance_status: 'pending' });
    const { seen } = await action('PUT', { id: '1' },
      Object.assign({}, FULL, { gallons: '120' }), row, ADMIN);
    const idx = seen.findIndex(s => s.startsWith('UPDATE fuel_submissions SET work_date'));
    assert('an entry nobody has balanced yet needs no reset',
      !seenValues[idx].includes(true), JSON.stringify(seenValues[idx]));
  }
  {
    // NUMERIC arrives from the driver as a string, so the two sides have to
    // be normalised before comparison — and normalising with `Number(v) || v`
    // reads a zero as unchanged, which is the same falsy-zero trap the meter
    // readings already sprung once.
    const row = Object.assign(rowFrom({ gallons: '0' }), {
      id: 1, status: 'approved', balance_status: 'balanced', balanced_by_name: 'office',
      gallons: '0.00',            // as PostgreSQL hands NUMERIC back
    });
    const { seen } = await action('PUT', { id: '1' },
      Object.assign({}, FULL, { gallons: '0' }), row, ADMIN);
    const idx = seen.findIndex(s => s.startsWith('UPDATE fuel_submissions SET work_date'));
    assert('a zero that did not change is recognised as unchanged',
      !seenValues[idx].includes(true), JSON.stringify(seenValues[idx]));
  }
  {
    const row = Object.assign(rowFrom(), {
      id: 1, status: 'approved', balance_status: 'balanced', balanced_by_name: 'office',
      truck_number: 0,
    });
    const { seen } = await action('PUT', { id: '1' },
      Object.assign({}, FULL, { truck_number: '412' }), row, ADMIN);
    const idx = seen.findIndex(s => s.startsWith('UPDATE fuel_submissions SET work_date'));
    assert('and a truck numbered 0 moving to 412 IS a change',
      seenValues[idx].includes(true), JSON.stringify(seenValues[idx]));
  }

  console.log('\n[un-approving takes the balance verdict with it]');
  {
    const row = Object.assign(rowFrom(), {
      id: 1, status: 'approved', balance_status: 'balanced', balanced_by_name: 'office',
    });
    const { seen } = await action('POST', { action: 'unapprove', id: '1' }, null, row, ADMIN);
    const upd = seen.find(s => s.startsWith('UPDATE fuel_submissions SET status = \'submitted\''));
    // A row left reading 'balanced' while unapproved says the office has
    // accounted for a figure it has just withdrawn.
    assert('it is returned to pending', /balance_status = 'pending'/.test(upd), upd.slice(0, 200));
    assert('and who balanced it is cleared', /balanced_by_name = NULL/.test(upd), upd.slice(0, 260));
  }

  console.log('\n[the list can be filtered by it]');
  {
    const { listQuery } = await get({ scope: 'all', balance: 'pending' }, ADMIN);
    assert('?balance=pending reaches the SQL', /balance_status/.test(listQuery.sql), listQuery.sql);
  }
  {
    const { listQuery } = await get({ scope: 'all', balance: 'sorted' }, ADMIN);
    assert('and a junk value filters nothing rather than erroring',
      listQuery != null, 'no list query ran');
  }
}

async function adminTests() {
  console.log('\n[Approve / un-approve — Fuel Admin only]');
  {
    const row = Object.assign(rowFrom(), { status: 'submitted' });
    const { res } = await action('POST', { action: 'approve', id: '1' }, null, row, FIELD);
    assert('a field user cannot approve', res.statusCode === 403);
  }
  {
    const row = Object.assign(rowFrom(), { status: 'submitted' });
    const { res } = await action('POST', { action: 'approve', id: '1' }, null, row, ADMIN);
    assert('an admin can approve a submitted entry', res.statusCode === 200, JSON.stringify(res.body));
    assert('and it comes back approved', res.body.entry.status === 'approved');
  }
  {
    const row = Object.assign(rowFrom({ fueling_site: '' }), { status: 'submitted' });
    const { res } = await action('POST', { action: 'approve', id: '1' }, null, row, ADMIN);
    assert('an incomplete entry cannot be approved', res.statusCode === 400);
  }
  {
    const row = Object.assign(rowFrom(), { status: 'draft' });
    const { res } = await action('POST', { action: 'approve', id: '1' }, null, row, ADMIN);
    assert('a draft cannot jump straight to approved', res.statusCode === 409);
  }
  {
    const row = Object.assign(rowFrom(), { status: 'approved' });
    const { res } = await action('POST', { action: 'unapprove', id: '1' }, null, row, ADMIN);
    assert('un-approve puts it back to submitted',
      res.statusCode === 200 && res.body.entry.status === 'submitted', JSON.stringify(res.body));
  }
  {
    const row = Object.assign(rowFrom(), { status: 'submitted' });
    const { res } = await action('POST', { action: 'unapprove', id: '1' }, null, row, ADMIN);
    assert('un-approving something not approved is a 409', res.statusCode === 409);
  }

  console.log('\n[PUT — who may edit what]');
  {
    const { res } = await action('PUT', { id: '1' }, FULL, rowFrom(), FIELD);
    assert('a field user may edit their own draft', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    const row = Object.assign(rowFrom(), { status: 'submitted' });
    const { res } = await action('PUT', { id: '1' }, FULL, row, FIELD);
    assert('a field user may NOT edit it once submitted', res.statusCode === 403);
  }
  {
    const row = Object.assign(rowFrom(), { status: 'submitted' });
    const { res } = await action('PUT', { id: '1' }, FULL, row, ADMIN);
    assert('an admin may edit a submitted entry', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    const row = Object.assign(rowFrom(), { status: 'submitted' });
    const body = Object.assign({}, FULL, { city_fueled: '' });
    const { res } = await action('PUT', { id: '1' }, body, row, ADMIN);
    assert('an admin may NOT blank a field on a submitted entry', res.statusCode === 400);
    assert('and is told which one', (res.body.missing_fields || []).includes('City Fueled'));
  }
  {
    // A draft, on the other hand, is allowed to be emptied back out.
    const body = Object.assign({}, FULL, { city_fueled: '' });
    const { res } = await action('PUT', { id: '1' }, body, rowFrom(), FIELD);
    assert('a draft may be left incomplete', res.statusCode === 200, JSON.stringify(res.body));
  }

  console.log('\n[DELETE]');
  {
    const { res } = await action('DELETE', { id: '1' }, null, rowFrom(), FIELD);
    assert('a field user may delete their own draft', res.statusCode === 200);
  }
  {
    const row = Object.assign(rowFrom(), { status: 'submitted' });
    const { res } = await action('DELETE', { id: '1' }, null, row, FIELD);
    assert('a field user may NOT delete a submitted entry', res.statusCode === 403);
  }
  {
    const row = Object.assign(rowFrom(), { status: 'approved' });
    const { res } = await action('DELETE', { id: '1' }, null, row, ADMIN);
    assert('an admin may delete at any status', res.statusCode === 200);
  }
  {
    const { res } = await action('DELETE', { id: '1' }, null, null, ADMIN);
    assert('deleting a row that is gone is a 404', res.statusCode === 404);
  }
}

// ── 5. The pages' copies of the option lists ────────────────────────────────
// Pull a top-level `const NAME = <literal>;` out of a page's script block and
// evaluate it. Anchored at the start of a line so a mention inside a comment
// or a string can't be mistaken for the declaration.
function liftConst(src, name, file) {
  const re = new RegExp(`^\\s{0,6}const ${name} = ([\\s\\S]*?);\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`${file} no longer declares ${name}`);
  return (new Function(`return ${m[1]}`))();
}

// Same idea for a function declaration: take everything from `function name(`
// to its balancing brace.
function liftFn(src, name, file) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${file} no longer defines ${name}()`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${file}: could not find the end of ${name}()`);
}

function pageTests() {
  console.log('\n[The pages and the server agree on the option lists]');
  const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

  for (const file of ['fuel.html', 'fuel-admin.html']) {
    const src = read(file);
    const cards  = liftConst(src, 'FUEL_CARDS', file);
    const types  = liftConst(src, 'FUEL_TYPES', file);
    const states = liftConst(src, 'US_STATES',  file);
    assert(`${file}: fuel cards match api/lib/fuel-options.js`,
      JSON.stringify(cards) === JSON.stringify(OPTIONS.FUEL_CARDS),
      JSON.stringify(cards));
    assert(`${file}: fuel types match`,
      JSON.stringify(types) === JSON.stringify(OPTIONS.FUEL_TYPES),
      JSON.stringify(types));
    assert(`${file}: states match (${OPTIONS.US_STATES.length})`,
      JSON.stringify(states) === JSON.stringify(OPTIONS.US_STATES),
      `page has ${states.length}`);

    // The form's field list must cover exactly the columns the server asks
    // for — a field added to one and not the other is a box nobody can fill
    // or a column nobody can see.
    const fields = liftConst(src, 'FIELDS', file);
    const pageKeys   = fields.map(f => f.key).join(',');
    const serverKeys = REPORTED_FIELDS.map(([k]) => k).join(',');
    assert(`${file}: FIELDS matches the server's REPORTED_FIELDS, in order`,
      pageKeys === serverKeys, `${pageKeys}\n      vs ${serverKeys}`);

    // Both pages show the driver a gallons figure that the server then
    // recomputes on write. If a page's copy of the rule disagrees by so much
    // as an edge case, it shows one number and stores another — and the one
    // on screen is the one somebody signed off on.
    const pageGallons = new Function(`
      ${liftFn(src, 'gallonsFromMeters', file)}
      return gallonsFromMeters;
    `)();
    const mismatches = METER_CASES.filter(([b, e, want]) => pageGallons(b, e) !== want);
    assert(`${file}: gallonsFromMeters agrees with the server on all ${METER_CASES.length} cases`,
      mismatches.length === 0,
      mismatches.map(([b, e, want]) => `(${b},${e}) page=${pageGallons(b, e)} server=${want}`).join('; '));
  }

  console.log('\n[fuel.html — the form agrees that 0 is filled in]');
  {
    const src = read('fuel.html');
    const FIELDS = liftConst(src, 'FIELDS', 'fuel.html');
    const values = {};
    const sandbox = new Function('FIELDS', 'val', `
      ${liftFn(src, 'emptyFields', 'fuel.html')}
      return emptyFields;
    `)(FIELDS, id => (values[id] == null ? '' : values[id]));

    // Everything answered, not on Force Fuel — both meters read 0.
    for (const f of FIELDS) values[f.id] = 'x';
    values['f-beginning-meter'] = '0';
    values['f-ending-meter']    = '0';
    values['f-gallons']         = '0';
    assert('a form whose meters read 0 is complete',
      sandbox().length === 0, JSON.stringify(sandbox().map(f => f.label)));

    values['f-ending-meter'] = '';
    const out = sandbox();
    assert('an untouched meter is still caught',
      out.length === 1 && out[0].label === 'Ending Meter Reading',
      JSON.stringify(out.map(f => f.label)));
  }

  console.log('\n[fuel.html — the gallons box changes hands cleanly]');
  {
    const src = read('fuel.html');
    // Enough of a DOM for the three nodes updateGallons() touches.
    const nodes = {
      'f-gallons':         { value: '', readOnly: false, classList: { remove() {}, add() {}, toggle() {} } },
      'f-beginning-meter': { value: '' },
      'f-ending-meter':    { value: '' },
      'gallonsNote':       { className: '', textContent: '' },
    };
    const form = new Function('nodes', `
      let manualGallons = '';
      function el(id)  { return nodes[id]; }
      function val(id) { const e = nodes[id]; return e ? e.value : ''; }
      ${liftFn(src, 'gallonsFromMeters', 'fuel.html')}
      ${liftFn(src, 'numOrNull',         'fuel.html')}
      ${liftFn(src, 'onGallonsTyped',    'fuel.html')}
      ${liftFn(src, 'updateGallons',     'fuel.html')}
      return { updateGallons, onGallonsTyped, manual: () => manualGallons };
    `)(nodes);
    const gal = nodes['f-gallons'];

    form.updateGallons();
    assert('an empty form leaves gallons typeable', gal.readOnly === false);
    assert('and says where the figure will come from', /tank meter/.test(nodes.gallonsNote.textContent));

    // A card purchase: the driver types the receipt figure.
    gal.value = '41.2'; form.onGallonsTyped();
    nodes['f-beginning-meter'].value = '0';
    nodes['f-ending-meter'].value    = '0';
    form.updateGallons();
    assert('0/0 keeps the typed figure', gal.value === '41.2' && gal.readOnly === false);
    assert('and explains why it is not calculated', /not a force fuel/i.test(nodes.gallonsNote.textContent));

    // …then they realise it was a tank fill and enter the real readings.
    nodes['f-beginning-meter'].value = '1200';
    nodes['f-ending-meter'].value    = '1284.5';
    form.updateGallons();
    assert('real readings take the box over', gal.readOnly === true);
    assert('and put the meter figure in it', gal.value === '84.50', gal.value);
    assert('the note shows the arithmetic', /1284\.5 minus 1200/.test(nodes.gallonsNote.textContent),
      nodes.gallonsNote.textContent);
    assert('and points at the readings above it', /above/.test(nodes.gallonsNote.textContent),
      nodes.gallonsNote.textContent);

    // A keystroke that lands while the tank owns the box is not theirs to
    // keep — remembering it would resurrect a metered figure as "manual".
    form.onGallonsTyped();
    assert('a metered figure is not remembered as hand-typed', form.manual() === '41.2', form.manual());

    // Cleared back to a card purchase: they get their own number back.
    nodes['f-beginning-meter'].value = '0';
    nodes['f-ending-meter'].value    = '0';
    form.updateGallons();
    assert('clearing the meters hands the box back', gal.readOnly === false);
    assert('with what the driver actually typed', gal.value === '41.2', gal.value);

    // A meter that reads backwards has to be typed in, and say so.
    nodes['f-beginning-meter'].value = '1200';
    nodes['f-ending-meter'].value    = '1100';
    form.updateGallons();
    assert('a backwards meter leaves gallons typeable', gal.readOnly === false);
    assert('and names the reason', /below the beginning/.test(nodes.gallonsNote.textContent),
      nodes.gallonsNote.textContent);
    assert('and the note stops claiming it was calculated',
      !nodes.gallonsNote.className.includes('auto'), nodes.gallonsNote.className);
  }

  console.log('\n[fuel-admin.html — the meter flag]');
  {
    const src = read('fuel-admin.html');
    const meterFlagged = new Function(`
      ${liftFn(src, 'meterFlagged', 'fuel-admin.html')}
      return meterFlagged;
    `)();
    assert('0 / 0 is the documented not-Force-Fuel answer, not a flag',
      meterFlagged({ beginning_meter: 0, ending_meter: 0 }) === false);
    assert('ending below beginning is flagged',
      meterFlagged({ beginning_meter: 1200.5, ending_meter: 1100 }) === true);
    assert('ending above beginning is not',
      meterFlagged({ beginning_meter: 1100, ending_meter: 1200.5 }) === false);
    assert('equal readings are not flagged',
      meterFlagged({ beginning_meter: 1100, ending_meter: 1100 }) === false);
    assert('a reading of 0 against a real beginning IS flagged',
      meterFlagged({ beginning_meter: 1200, ending_meter: 0 }) === true);
    assert('a missing reading is not flagged (the workflow catches that)',
      meterFlagged({ beginning_meter: null, ending_meter: 5 }) === false);
  }

  console.log('\n[fuel-admin.html — an entry that bought no fuel]');
  {
    const src = read('fuel-admin.html');
    const zeroGallons = new Function(`
      ${liftFn(src, 'zeroGallons', 'fuel-admin.html')}
      return zeroGallons;
    `)();
    // The whole form is built so that 0 is never mistaken for blank, which is
    // right for the meters and wrong for the thing being bought: an entry
    // recording no fuel passes every completeness check there is and then
    // fails to balance against a statement that says forty gallons.
    assert('0 gallons is flagged', zeroGallons({ gallons: 0 }) === true);
    assert('and so is a string zero off the wire', zeroGallons({ gallons: '0' }) === true);
    assert('a real fill is not', zeroGallons({ gallons: 84.5 }) === false);
    // Blank is a different problem with its own message — an entry that never
    // answered is caught by the completeness check before it can be submitted,
    // and reporting it here as "bought nothing" would be wrong about it.
    assert('and neither is a blank one', zeroGallons({ gallons: null }) === false);
    assert('nor an entry that is not there at all', zeroGallons(null) === false);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  zeroTests();
  meterTests();
  parseTests();
  await scopeTests();
  await submitTests();
  await adminTests();
  await balanceTests();
  pageTests();

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
