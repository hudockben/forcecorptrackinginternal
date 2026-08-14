#!/usr/bin/env node
'use strict';
/**
 * SQL-level integration test for /api/timesheet-entries.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-timesheet-entries-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * DESTRUCTIVE: truncates timesheet_entries, daily_tracking, timesheet_audit_log
 * and app_data. It refuses to run against a database whose name doesn't look
 * like a test database.
 *
 * The mocked suites (test-timesheet-entries.js, test-injection-autofill.js)
 * assert what the handler intends to send. This one drives the real handler
 * against a real PostgreSQL and asserts what the database does with it:
 *
 *   - the whole life cycle: create → submit → approve → un-approve → delete
 *   - hours and travel computed server-side, and the DATE surviving the round
 *     trip out to Postgres and back
 *   - the injected daily_tracking rows carrying the roster name, job class,
 *     rate and equipment price the cost tab reads
 *   - a split whose hours don't add up leaving nothing behind
 *   - un-approve and delete sweeping every injected row
 *   - list scoping — own rows by default, ?scope=all for the review grid
 *   - the duplicate gate on submit
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

// This truncates. Make it hard to point at something real by accident.
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script truncates tables. Point PG_TEST_URL at a scratch database.');
  process.exit(1);
}

const client = new Client({ connectionString: URL });

// neon-serverless' tagged template, backed by pg: same contract (a Promise of
// the row array), so the handler cannot tell the difference.
function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

let AUTH = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  if (request === './lib/auth') {
    return {
      requireAuth: () => AUTH,
      requireDivision: () => null,
      // Mirror the real gate rather than always saying yes, so the scoping
      // assertions below are testing a permission check that exists.
      hasDivisionAccess: (p, area) => {
        if (!p) return false;
        if (p.isPlatformAdmin) return true;
        return !!(p.divisionRoles && p.divisionRoles[area] && p.divisionRoles[area] !== 'no_access');
      },
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

const FIELD = { companyCode: 'FCT', userId: 7,  username: 'strickallen', divisionRoles: { timesheet: 'level1' } };
const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',      divisionRoles: { timesheet: 'level1', payroll: 'level3' } };

async function call(method, query, body, auth) {
  AUTH = auth;
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query: query || {}, body: body || {} }, res);
  return res;
}

async function seed() {
  const q = (t, v) => client.query(t, v);
  await q(`TRUNCATE daily_tracking, timesheet_entries, timesheet_audit_log, app_data RESTART IDENTITY CASCADE`);
  await q(`DELETE FROM users WHERE id IN (7, 42)`);
  await q(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp') ON CONFLICT (code) DO NOTHING`);
  await q(`INSERT INTO users (id, company_code, username, password_hash, role)
           VALUES (7,'FCT','strickallen','x','level1'), (42,'FCT','office','x','admin')`);
  // What the injector reads for rate, job class and machine price.
  await q(`INSERT INTO app_data (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ['FCT:fct_paving_lists', JSON.stringify({
      employees: [{ name: 'Allen Strick', job_class: 'Operator', non_prevailing_rate: 34.5, prevailing_rate: 61 }],
      equipment: [{ name: 'Roller', unit_cost: 22.5 }, { name: 'Pickup Truck', unit_cost: 12 }],
    })]);
  await q(`INSERT INTO app_data (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ['FCT:fct_paving_project_26019', JSON.stringify({ name: 'Punxsy Storage Lot', prevailing_wage: false })]);
}

// 07:00–16:30 is 9.5 gross; the lunch answer takes 30 minutes off, so the
// server should land on 9.00 work + 1.00 travel.
const DAY = {
  entry_type: 'daily', work_date: '2026-07-29', division: 'paving',
  job_id: '26019', job_label: 'Punxsy Storage Lot',
  start_time: '07:00', end_time: '16:30', lunch_break: true, operated_equipment: true,
  travel_to_site_hours: '0.5', travel_to_shop_hours: '0.5',
  supervisor_id: 3, supervisor_name: 'Steve Travis', notes: '',
};

async function run() {
  await client.connect();
  await seed();

  console.log('\n[create]');
  const created = await call('POST', {}, DAY, FIELD);
  assert('draft created', created.statusCode === 200 && created.body.ok, JSON.stringify(created.body));
  const id = created.body.entry.id;
  assert('hours computed server-side (9.5 gross − 0.5 lunch)', created.body.entry.computed_hours === 9,
    String(created.body.entry.computed_hours));
  assert('travel legs summed', created.body.entry.travel_hours === 1, String(created.body.entry.travel_hours));
  // The DATE goes out to Postgres and comes back as a driver Date object. It
  // must land on the day the worker typed, wherever the process is running.
  assert('work_date survives the round-trip', created.body.entry.work_date === '2026-07-29',
    created.body.entry.work_date);

  console.log('\n[submit + duplicate gate]');
  const sub = await call('POST', { action: 'submit', id }, {}, FIELD);
  assert('submitted', sub.statusCode === 200 && sub.body.entry.status === 'submitted', JSON.stringify(sub.body));

  const dup = await call('POST', {}, DAY, FIELD);
  const dupSub = await call('POST', { action: 'submit', id: dup.body.entry.id }, {}, FIELD);
  assert('an identical second submit is refused', dupSub.statusCode === 409, JSON.stringify(dupSub.body));
  assert('naming the row that already covers the day', dupSub.body.duplicate_of === String(id),
    JSON.stringify(dupSub.body));

  const shifted = await call('POST', {}, Object.assign({}, DAY, { start_time: '17:00', end_time: '21:00' }), FIELD);
  const shiftedSub = await call('POST', { action: 'submit', id: shifted.body.entry.id }, {}, FIELD);
  assert('a split shift on the same day still goes through', shiftedSub.statusCode === 200,
    JSON.stringify(shiftedSub.body));
  await call('DELETE', { id: shifted.body.entry.id }, {}, ADMIN);
  await call('DELETE', { id: dup.body.entry.id }, {}, FIELD);

  console.log('\n[approve → injected cost rows]');
  const appr = await call('POST', { action: 'approve', id }, {
    split: [
      { cost_code: '02-100', sub_code: 'A', quantity: 120, equipment: 'Roller',       labor_hours: 9, equip_hours: 8, is_travel: false },
      { cost_code: '02-900', sub_code: '',  quantity: 0,   equipment: 'Pickup Truck', labor_hours: 1, equip_hours: 1, is_travel: true  },
    ],
  }, ADMIN);
  assert('approved', appr.statusCode === 200 && appr.body.entry.status === 'approved', JSON.stringify(appr.body));

  const rows = (await client.query(
    `SELECT * FROM daily_tracking WHERE timesheet_entry_id = $1`, [id])).rows;
  assert('two cost rows injected', rows.length === 2, String(rows.length));
  const work = rows.find(r => r.field_type === null);
  const trav = rows.find(r => r.field_type === 'Travel');
  assert('the cost row lands on the entry\'s date',
    !!work && work.date.getFullYear() === 2026 && work.date.getMonth() === 6 && work.date.getDate() === 29,
    work && String(work.date));
  assert('the roster name replaces the login', work && work.employee === 'Allen Strick', work && work.employee);
  assert('the job class comes across',         work && work.job_class === 'Operator', work && work.job_class);
  assert('the non-prevailing rate is used',    work && Number(work.rate) === 34.5, work && String(work.rate));
  assert('the machine price resolved',         work && Number(work.equip_unit_cost) === 22.5, work && String(work.equip_unit_cost));
  assert('labor hours match the split',        work && Number(work.labor_hours) === 9, work && String(work.labor_hours));
  assert('quantity carried',                   work && Number(work.quantity) === 120, work && String(work.quantity));
  assert('project_id is the job',              work && work.project_id === '26019', work && work.project_id);
  assert('division carried',                   work && work.division === 'paving', work && work.division);
  assert('the travel leg is tagged Travel',    !!trav, 'no Travel row');
  assert('travel books to its own cost code',  trav && trav.cost_code === '02-900', trav && trav.cost_code);

  console.log('\n[a split that does not add up leaves nothing behind]');
  const other = await call('POST', {}, Object.assign({}, DAY, { work_date: '2026-07-30' }), FIELD);
  const otherId = other.body.entry.id;
  await call('POST', { action: 'submit', id: otherId }, {}, FIELD);
  const bad = await call('POST', { action: 'approve', id: otherId }, {
    split: [{ cost_code: '02-100', sub_code: '', quantity: 0, equipment: '', labor_hours: 5, equip_hours: 0, is_travel: false }],
  }, ADMIN);
  assert('hours that do not add up are rejected', bad.statusCode === 400, JSON.stringify(bad.body));
  const still = (await client.query(`SELECT status FROM timesheet_entries WHERE id = $1`, [otherId])).rows[0];
  assert('the entry stays submitted', still.status === 'submitted', still.status);
  const none = (await client.query(`SELECT count(*)::int c FROM daily_tracking WHERE timesheet_entry_id = $1`, [otherId])).rows[0];
  assert('with nothing injected', none.c === 0, String(none.c));

  console.log('\n[un-approve sweeps the cost rows]');
  const un = await call('POST', { action: 'unapprove', id }, {}, ADMIN);
  assert('un-approved', un.statusCode === 200, JSON.stringify(un.body));
  const swept = (await client.query(`SELECT count(*)::int c FROM daily_tracking WHERE row_id LIKE $1`, [`ts${id}-%`])).rows[0];
  assert('every injected row is gone', swept.c === 0, String(swept.c));

  console.log('\n[?action=split returns a split, not the entry list]');
  await call('POST', { action: 'approve', id }, {
    split: [{ cost_code: '02-100', sub_code: 'A', quantity: 0, equipment: '', labor_hours: 10, equip_hours: 0, is_travel: false }],
  }, ADMIN);
  const split = await call('GET', { action: 'split', id }, {}, ADMIN);
  assert('the split comes back', Array.isArray(split.body.split) && split.body.split.length === 1,
    JSON.stringify(split.body).slice(0, 120));
  assert('with its cost code', split.body.split && split.body.split[0].cost_code === '02-100',
    JSON.stringify(split.body.split));

  console.log('\n[list scoping]');
  const mine  = await call('GET', { status: 'submitted_approved' }, {}, FIELD);
  const admin = await call('GET', { status: 'submitted_approved' }, {}, ADMIN);
  const all   = await call('GET', { status: 'submitted_approved', scope: 'all' }, {}, ADMIN);
  assert('the field user sees their own rows', mine.body.entries.length >= 1);
  assert('and only their own', mine.body.entries.every(e => e.user_id === 7));
  assert('the admin\'s own timesheet view is empty — they filed nothing',
    admin.body.entries.length === 0, String(admin.body.entries.length));
  assert('scope=all is what widens it', all.body.entries.length === mine.body.entries.length);

  console.log('\n[delete takes the cost rows with it]');
  const del = await call('DELETE', { id }, {}, ADMIN);
  assert('deleted', del.statusCode === 200, JSON.stringify(del.body));
  assert('reporting what it removed', del.body.removed_split_rows === 1, String(del.body.removed_split_rows));
  const orphans = (await client.query(`SELECT count(*)::int c FROM daily_tracking WHERE row_id LIKE $1`, [`ts${id}-%`])).rows[0];
  assert('no orphaned cost rows left behind', orphans.c === 0, String(orphans.c));

  console.log('\n[audit trail]');
  const events = (await client.query(
    `SELECT action, changes FROM timesheet_audit_log WHERE entry_id = $1 ORDER BY id`, [id])).rows;
  const actions = events.map(e => e.action);
  assert('every state change is logged',
    ['INSERT', 'SUBMIT', 'APPROVE', 'ADMIN_EDIT', 'DELETE'].every(a => actions.includes(a)), actions.join(','));
  // An un-approve is logged ADMIN_EDIT (the table's CHECK has no UNAPPROVE),
  // so the changes payload is the only thing separating it from payroll
  // correcting an entry — payroll.html's audit table reads it for that reason.
  const unapproveEv = events.find(e => e.changes && e.changes.unapprove);
  assert('the un-approve is marked as one in its changes payload', !!unapproveEv,
    JSON.stringify(events.map(e => e.changes)));
  assert('and records the cost rows it pulled back out',
    unapproveEv && unapproveEv.changes.removed_split_rows === 2,
    unapproveEv && JSON.stringify(unapproveEv.changes));

  await haulFieldsSurviveAnEdit();
  await theUnitIsOnlyWrittenOnceTheRowExists();

  console.log(`\n${passed} passed, ${failed} failed`);
  await client.end();
  process.exit(failed ? 1 : 0);
}

// A haul carries two fields no other division has — the truck unit and the haul
// description — and payroll's entry-edit form has inputs for neither: it edits
// the day (hours, job, supervisor), not the haul. It therefore PUTs a body with
// both keys missing, which used to normalize to null and silently wipe them, so
// correcting a start time threw away the driver's unit and description along
// with the unit payroll had typed at approval. Absent means keep; present still
// wins, blank included, so the driver's own form can still clear a field.
async function haulFieldsSurviveAnEdit() {
  console.log('\n[a payroll edit keeps the haul fields it does not ask about]');
  const HAUL = {
    entry_type: 'daily', work_date: '2026-08-13', division: 'dust',
    job_id: 'CNX', job_label: 'CNX',
    start_time: '06:30', end_time: '15:30', lunch_break: false,
    supervisor_id: 3, supervisor_name: 'Steve Travis', notes: '',
    truck_unit: '', truck_description: 'stone to the pad',
  };
  const made = await call('POST', {}, HAUL, FIELD);
  const hid  = made.body.entry.id;
  await call('POST', { action: 'submit', id: hid }, {}, FIELD);
  await call('POST', { action: 'approve', id: hid }, { trucking: { haul_fee: '121', unit: '1000' } }, ADMIN);
  const approved = (await client.query(`SELECT truck_unit FROM timesheet_entries WHERE id=$1`, [hid])).rows[0];
  assert('payroll\'s unit is on the entry after approval', approved.truck_unit === '1000', approved.truck_unit);

  await call('POST', { action: 'unapprove', id: hid }, {}, ADMIN);
  // Exactly the shape payroll.html's edit modal sends — no truck_* keys at all.
  const edited = await call('PUT', { id: hid }, {
    entry_type: 'daily', work_date: '2026-08-13', division: 'dust',
    job_id: 'CNX', job_label: 'CNX',
    start_time: '06:00', end_time: '15:30',
    travel_to_site_hours: '0', travel_to_shop_hours: '0',
    lunch_break: false, operated_equipment: false,
    supervisor_id: 3, supervisor_name: 'Steve Travis', notes: '',
  }, ADMIN);
  assert('the edit goes through', edited.statusCode === 200, JSON.stringify(edited.body));
  const kept = (await client.query(
    `SELECT truck_unit, truck_description FROM timesheet_entries WHERE id=$1`, [hid])).rows[0];
  assert('the unit survives it', kept.truck_unit === '1000', JSON.stringify(kept));
  assert('and so does the description', kept.truck_description === 'stone to the pad', JSON.stringify(kept));

  // Present still wins — this is how the driver's own form clears a mistake.
  await call('PUT', { id: hid }, Object.assign({}, HAUL, {
    truck_unit: '', truck_description: '',
  }), ADMIN);
  const cleared = (await client.query(
    `SELECT truck_unit, truck_description FROM timesheet_entries WHERE id=$1`, [hid])).rows[0];
  assert('sending them blank still clears them', !cleared.truck_unit && !cleared.truck_description,
    JSON.stringify(cleared));

  // And a division change off the haul divisions must not let a stale unit ride
  // along — normalizeEntryBody nulls both off a non-truck row on purpose.
  await call('PUT', { id: hid }, Object.assign({}, HAUL, { truck_unit: '999' }), ADMIN);
  await call('PUT', { id: hid }, {
    entry_type: 'daily', work_date: '2026-08-13', division: 'turf',
    job_id: '26019', job_label: 'Punxsy Storage Lot',
    start_time: '06:30', end_time: '15:30',
    travel_to_site_hours: '0', travel_to_shop_hours: '0',
    lunch_break: false, operated_equipment: false,
    supervisor_id: 3, supervisor_name: 'Steve Travis', notes: '',
  }, ADMIN);
  const moved = (await client.query(`SELECT truck_unit FROM timesheet_entries WHERE id=$1`, [hid])).rows[0];
  assert('moving the entry off a haul division drops the unit', !moved.truck_unit, JSON.stringify(moved));
  await call('DELETE', { id: hid }, {}, ADMIN);
}

// The unit payroll types is written to the entry AND to the injected row. Those
// are two statements with no transaction around them, so the order matters: if
// the entry is updated first and the injection then fails, the timesheet claims
// a unit the Truck Tracking row never got, and the failure looks recoverable
// when the data has already drifted. Both paths write the entry last.
async function theUnitIsOnlyWrittenOnceTheRowExists() {
  console.log('\n[a failed injection leaves no half-written unit]');
  const made = await call('POST', {}, {
    entry_type: 'daily', work_date: '2026-08-14', division: 'dust',
    job_id: 'Antero', job_label: 'Antero',
    start_time: '06:30', end_time: '15:30', lunch_break: false,
    supervisor_id: 3, supervisor_name: 'Steve Travis', notes: '',
    truck_unit: 'AAA', truck_description: 'x',
  }, FIELD);
  const hid = made.body.entry.id;
  await call('POST', { action: 'submit', id: hid }, {}, FIELD);
  await call('POST', { action: 'approve', id: hid }, { trucking: { haul_fee: '121', unit: 'AAA' } }, ADMIN);

  // Fail the next blob write, which is how insertTruckingRow persists the row.
  const realQuery = client.query.bind(client);
  let armed = true;
  client.query = (text, vals) => {
    if (armed && typeof text === 'string' && text.includes('INSERT INTO app_data')) {
      armed = false;
      return Promise.reject(new Error('simulated blob write failure'));
    }
    return realQuery(text, vals);
  };
  const failed = await call('POST', { action: 'resplit', id: hid }, {
    trucking: { haul_fee: '121', unit: 'BBB' },
  }, ADMIN);
  client.query = realQuery;

  assert('the edit reports the failure', failed.statusCode === 500, JSON.stringify(failed.body));
  const after = (await client.query(`SELECT truck_unit FROM timesheet_entries WHERE id=$1`, [hid])).rows[0];
  assert('the entry still holds the unit the row actually has', after.truck_unit === 'AAA', after.truck_unit);
  const blob = (await client.query(`SELECT value FROM app_data WHERE key = 'FCT:fct_truck_division'`)).rows[0];
  const arr  = blob ? (typeof blob.value === 'string' ? JSON.parse(blob.value) : blob.value) : [];
  const row  = arr.find(r => String(r.id || '').startsWith(`tst-${hid}-`));
  assert('and the Truck Tracking row agrees with it', row && row.unit === 'AAA',
    JSON.stringify(row && row.unit));

  // The retry, once whatever broke is fixed, lands both.
  const retried = await call('POST', { action: 'resplit', id: hid }, {
    trucking: { haul_fee: '121', unit: 'BBB' },
  }, ADMIN);
  assert('a retry succeeds', retried.statusCode === 200, JSON.stringify(retried.body));
  const done = (await client.query(`SELECT truck_unit FROM timesheet_entries WHERE id=$1`, [hid])).rows[0];
  assert('and both sides move together', done.truck_unit === 'BBB', done.truck_unit);
  await call('DELETE', { id: hid }, {}, ADMIN);
}

run().catch(async err => {
  console.error(err);
  try { await client.end(); } catch { /* already closed */ }
  process.exit(1);
});
