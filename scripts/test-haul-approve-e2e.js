#!/usr/bin/env node
'use strict';
/**
 * Payroll can classify a haul at approval time — the whole way through.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-haul-approve-e2e.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql.
 * DESTRUCTIVE: truncates timesheet_entries, daily_tracking and app_data.
 *
 * The driver answers the hauling question on his timesheet. But only a driver
 * the office has FLAGGED is asked, and a day already submitted cannot be
 * answered retrospectively by anyone but payroll. So on the day this is
 * switched on, every entry in the queue carries no answer — and a driver who
 * simply forgot could otherwise only be fixed by sending the day back.
 *
 * This drives the real handler against a real PostgreSQL and asserts the case
 * the owner actually hit: a Franklin Regional entry submitted with no answer,
 * approved as an off-site haul, must come out with
 *
 *   - the entry carrying haul_type, so the prevailing-hours report reclassifies
 *   - the injected cost row priced at $0 LABOUR but with its hours intact and
 *     the truck still costed
 *
 * The hours are the point: payroll balances the driver's day against them, so
 * suppressing the money must never suppress the time.
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}

const client = new Client({ connectionString: URL });
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
      hasDivisionAccess: (p, area) => !!(p && (p.isPlatformAdmin ||
        (p.divisionRoles && p.divisionRoles[area] && p.divisionRoles[area] !== 'no_access'))),
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

const FIELD = { companyCode: 'FCT', userId: 7,  username: 'hudockben', divisionRoles: { timesheet: 'level1' } };
const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',
                divisionRoles: { timesheet: 'level1', payroll: 'level3' }, role: 'admin' };

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

const q = (sql, p) => client.query(sql, p).then(r => r.rows);

(async () => {
  await client.connect();
  await client.query(`INSERT INTO companies (code,name) VALUES ('FCT','Force Corp')
                      ON CONFLICT (code) DO NOTHING`);
  await client.query('TRUNCATE timesheet_entries, daily_tracking, app_data RESTART IDENTITY CASCADE');

  // Franklin Regional Multi, prevailing wage — exactly the owner's job.
  await client.query(
    `INSERT INTO app_data (key,value) VALUES ('FCT:fct_project_26049', $1)`,
    [JSON.stringify({ id: '26049', 'project-name': 'Franklin Regional Multi', prevailing_wage: true })]);
  // The turf roster the injected row is priced from.
  await client.query(
    `INSERT INTO app_data (key,value) VALUES ('FCT:fct_lists', $1)`,
    [JSON.stringify({
      employees: [{ name: 'Ben Hudock', job_class: 'Operator',
                    prevailing_rate: 77, non_prevailing_rate: 55 }],
      equipment: [{ name: 'Triaxle Dump', unit_cost: 121 }],
    })]);

  // A day submitted with NO answer — the driver was never flagged, which is the
  // state every entry is in on the day this is switched on.
  // A distinct date per scenario: the submit path refuses a second entry for the
  // same person, day and job, which is a duplicate guard, not something to work
  // around.
  let _day = 0;
  const mk = async () => {
    const c = await call('POST', {}, {
      entry_type: 'daily', work_date: `2026-09-0${++_day}`, division: 'turf',
      job_id: '26049', job_label: 'Franklin Regional Multi · 26049',
      start_time: '07:00', end_time: '13:00', lunch_break: false, operated_equipment: false,
      supervisor_id: 3, supervisor_name: 'brewernate',
    }, FIELD);
    if (c.statusCode !== 200) throw new Error('create failed: ' + JSON.stringify(c.body));
    await call('POST', { action: 'submit', id: c.body.entry.id }, {}, FIELD);
    return c.body.entry.id;
  };

  const SPLIT = [{ cost_code: 'Earthwork', sub_code: 'Excess Cut - Off Site Disposal',
                   equipment: 'Triaxle Dump', labor_hours: 6, equip_hours: 6, quantity: 0 }];

  console.log('\n[the entry as submitted]');
  const id = await mk();
  let [e] = await q('SELECT haul_type, computed_hours FROM timesheet_entries WHERE id=$1', [id]);
  assert('carries no hauling answer', e.haul_type === null);
  assert('  and six work hours', Number(e.computed_hours) === 6);

  console.log('\n[payroll approves it as an off-site haul]');
  const r = await call('POST', { action: 'approve', id }, { split: SPLIT, haul_type: 'off_site' }, ADMIN);
  assert('the approval succeeds', r.statusCode === 200, JSON.stringify(r.body).slice(0, 200));

  [e] = await q('SELECT haul_type, status FROM timesheet_entries WHERE id=$1', [id]);
  assert('the answer is stored on the entry', e.haul_type === 'off_site');
  assert('  and the entry is approved', e.status === 'approved');

  let [row] = await q(
    `SELECT rate::float rate, labor_hours::float lh, equip_unit_cost::float euc,
            equip_hours::float eh, field_type, employee, job_class
       FROM daily_tracking WHERE timesheet_entry_id=$1`, [id]);
  assert('one cost row was injected', !!row);
  assert('the LABOUR RATE is $0 — the driver is inside the truck cost', row.rate === 0,
    `rate=${row.rate}`);
  assert('the HOURS are intact — payroll balances the day against them', row.lh === 6,
    `labor_hours=${row.lh}`);
  assert('the truck is still priced at $121/h for 6 h',
    row.euc === 121 && row.eh === 6, `euc=${row.euc} eh=${row.eh}`);
  assert('the row says why it costs nothing', row.field_type === 'Haul — To/From Site',
    `field_type=${row.field_type}`);
  assert('and it still carries the roster name and class',
    row.employee === 'Ben Hudock' && row.job_class === 'Operator');

  console.log('\n[the prevailing split follows from it]');
  const { payrollMetrics } = require(path.resolve(__dirname, '../api/lib/payroll-metrics.js'));
  const entries = await q(
    `SELECT username, entry_type, status, division, job_id, work_date::text work_date,
            computed_hours::float computed_hours, travel_hours::float travel_hours, haul_type
       FROM timesheet_entries WHERE id=$1`, [id]);
  entries[0].prevailing_wage = true;   // Franklin Regional is a PW job
  const t = payrollMetrics({ entries, periodStart: '2026-08-31', periodEnd: '2026-09-13' }).totals;
  assert('the 6 hours are STANDARD, not prevailing', t.pwHours === 0 && t.stdHours === 6,
    `pw=${t.pwHours} std=${t.stdHours}`);
  assert('  and he is still owed all six', t.workHours === 6);

  console.log('\n[an ordinary approval is untouched]');
  const id2 = await mk();
  const r2 = await call('POST', { action: 'approve', id: id2 }, { split: SPLIT, haul_type: '' }, ADMIN);
  assert('it approves', r2.statusCode === 200, JSON.stringify(r2.body).slice(0, 200));
  [row] = await q(`SELECT rate::float rate, field_type FROM daily_tracking
                    WHERE timesheet_entry_id=$1`, [id2]);
  assert('the prevailing rate is applied as always', row.rate === 77, `rate=${row.rate}`);
  assert('  and nothing is stamped', row.field_type === null);

  console.log('\n[approving without mentioning haul_type keeps the driver\'s own answer]');
  const id3 = await mk();
  await q(`UPDATE timesheet_entries SET haul_type='on_site' WHERE id=$1`, [id3]);
  const r3 = await call('POST', { action: 'approve', id: id3 }, { split: SPLIT }, ADMIN);
  assert('it approves', r3.statusCode === 200);
  [e] = await q('SELECT haul_type FROM timesheet_entries WHERE id=$1', [id3]);
  assert('the answer survives an approval that never mentioned it', e.haul_type === 'on_site');
  [row] = await q(`SELECT rate::float rate, field_type FROM daily_tracking
                    WHERE timesheet_entry_id=$1`, [id3]);
  assert('  and it still priced the labour at $0', row.rate === 0);
  assert('  stamped as an on-site haul', row.field_type === 'Haul — On Site');

  console.log(`\n${passed} passed, ${failed} failed`);
  await client.end();
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('Harness error:', err.stack); process.exit(1); });
