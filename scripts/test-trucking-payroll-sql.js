#!/usr/bin/env node
'use strict';
/**
 * SQL-level test for GET /api/daily-rows?trucking=1, against a real PostgreSQL.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-trucking-payroll-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * DESTRUCTIVE: deletes this test's company (FCTTRK) and everything under it.
 * Refuses to run against a database whose name does not look like a test
 * database.
 *
 * The mocked suite (test-trucking-payroll-view.js) checks the JS rule. This one
 * checks what PostgreSQL does with the WHERE clause that restates it, because
 * that clause is what the LIMIT counts:
 *
 *   - the regexes (passed as parameters) match the same rows as the JS ones
 *   - the timesheet_entries join supplies truck_unit, so a Trucking-class
 *     driver's roller is left out and his named truck is not
 *   - is_haul = false is never trucking; NULL is "nobody said"
 *   - company and division scoping
 *   - the LIMIT counts trucking rows, not every split row of a haul day
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script deletes rows. Point PG_TEST_URL at a scratch database.');
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

const CO = 'FCTTRK';
let DIVISION = 'paving';
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  if (request === './lib/auth') {
    return { requireDivision: () => ({ payload: { companyCode: CO }, division: DIVISION }) };
  }
  return origLoad.apply(this, arguments);
};
const handler = require(path.resolve(__dirname, '..', 'api', 'daily-rows.js'));
Module._load = origLoad;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

async function get(division) {
  DIVISION = division;
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; },
                json(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method: 'GET', query: { division, trucking: '1' }, body: {} }, res);
  return res;
}

async function cleanup() {
  await client.query(`DELETE FROM daily_tracking WHERE company_code = $1`, [CO]);
  await client.query(`DELETE FROM timesheet_entries WHERE company_code = $1`, [CO]);
  await client.query(`DELETE FROM users WHERE company_code = $1`, [CO]);
  await client.query(`DELETE FROM companies WHERE code = $1`, [CO]);
}

async function entry(truckUnit) {
  const { rows } = await client.query(
    `INSERT INTO timesheet_entries (company_code, user_id, username, entry_type, work_date, status, truck_unit)
     VALUES ($1, $2, 'nick', 'daily', '2026-09-28', 'approved', $3) RETURNING id`,
    [CO, USER_ID, truckUnit]);
  return Number(rows[0].id);
}

let seq = 0;
async function row(o) {
  const id = o.row_id || `ts${o.entry || 0}-1759000000000-${seq++}-1`;
  await client.query(
    `INSERT INTO daily_tracking (row_id, project_id, company_code, division, date, field_type, employee,
       job_class, equipment, equip_unit_cost, equip_hours, equip_total_override, timesheet_entry_id, is_haul)
     VALUES ($1, 'p1', $2, $3, $4, $5, 'Nick Detwiler', $6, $7, 121, $8, $9, $10, $11)`,
    [id, o.company || CO, o.division || 'paving', o.date || '2026-09-28', o.field_type || null,
     o.job_class || 'Trucking', o.equipment || null, o.equip_hours || 0, o.override || null,
     o.entry === undefined ? null : o.entry, o.is_haul === undefined ? null : o.is_haul]);
  return id;
}

let USER_ID = null;

(async () => {
  await client.connect();
  await cleanup();
  await client.query(`INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Trucking SQL test', '{turf,paving}')`, [CO]);
  USER_ID = (await client.query(
    `INSERT INTO users (username, company_code, password_hash) VALUES ('nick-trk', $1, 'x') RETURNING id`, [CO])).rows[0].id;

  console.log('\n[which rows the query returns]');
  const e1 = await entry('Triaxle Dump');   // named his truck
  const e2 = await entry(null);             // named nothing
  const e3 = await entry('Tandem Dump');    // a truck the name rule does not know
  const want = new Map();
  const add = async (label, o, expect) => want.set(await row(o), { label, expect });

  await add('stamped haul (em dash)',             { entry: e1, field_type: 'Haul — To/From Site', equipment: 'Triaxle Dump', equip_hours: 10.5 }, true);
  await add('stamped haul (hyphen, leading space)', { entry: e1, field_type: ' Haul - On Site', equipment: 'Triaxle Dump', equip_hours: 4 }, true);
  await add('his travel row, truck at 0 h',       { entry: e1, field_type: 'Travel', equipment: 'Triaxle Dump', equip_hours: 0 }, false);
  await add('the roller he ran on site',          { entry: e1, equipment: 'Roller', equip_hours: 2.5 }, false);
  await add('a crew Pickup Truck',                { entry: e1, equipment: 'Pickup Truck', equip_hours: 3 }, false);
  await add('answered "not a haul" on the Triaxle', { entry: e1, equipment: 'Triaxle Dump', equip_hours: 6, is_haul: false }, false);
  await add('unstamped Triaxle, nobody said',     { entry: e1, equipment: 'Triaxle Dump', equip_hours: 6 }, true);
  await add('Lowboy on a laborer',                { entry: e2, job_class: 'Hourly', equipment: 'Low-Boy Trailer', equip_hours: 3 }, true);
  await add('Toro Triplex on a laborer',          { entry: e2, job_class: 'Hourly', equipment: 'Toro Triplex', equip_hours: 3 }, false);
  await add('Trucking driver, named Tandem, on it', { entry: e3, job_class: ' trucking ', equipment: 'tandem dump', equip_hours: 8 }, true);
  await add('Trucking driver, named nothing, skid steer', { entry: e2, equipment: 'Skid Steer', equip_hours: 3 }, false);
  await add('override total, 0 hours',            { entry: e1, equipment: 'Lowboy', equip_hours: 0, override: 600 }, true);
  await add('lost link, ts id, stamped',          { row_id: 'ts999-1-0-1', field_type: 'Haul — On Site', equipment: 'Triaxle Dump', equip_hours: 5 }, true);
  await add('manual row (Trucking tab entry)',    { row_id: '1759000000000.42', equipment: 'Triaxle Dump', equip_hours: 5 }, false);
  await add('an office "Haul Off" field type',    { entry: e2, job_class: 'Hourly', field_type: 'Haul Off', equipment: 'Skid Steer', equip_hours: 3 }, false);
  await add('another division (turf)',            { entry: e1, division: 'turf', field_type: 'Haul — On Site', equipment: 'Triaxle Dump', equip_hours: 5 }, false);

  const res = await get('paving');
  assert('200', res.statusCode === 200, JSON.stringify(res.body));
  const got = new Set((res.body.rows || []).map(r => r.id));
  for (const [id, { label, expect }] of want) {
    assert(`${expect ? 'listed' : 'left out'}: ${label}`, got.has(id) === expect);
  }
  assert('nothing listed that was not expected', [...got].every(id => want.has(id) && want.get(id).expect));
  const turf = await get('turf');
  assert('turf asks for turf and gets only its own row', (turf.body.rows || []).length === 1);

  // Every row the SQL returns must also pass the JS rule — the two agree.
  const { isPayrollTruckingRow } = handler._test;
  const raw = (await client.query(
    `SELECT dt.*, te.truck_unit FROM daily_tracking dt
     LEFT JOIN timesheet_entries te ON te.id = dt.timesheet_entry_id AND te.company_code = dt.company_code
     WHERE dt.company_code = $1 AND dt.division = 'paving'`, [CO])).rows;
  const jsIds = new Set(raw.filter(isPayrollTruckingRow).map(r => r.row_id));
  assert('the SQL clause and the JS rule pick the same rows',
    jsIds.size === got.size && [...jsIds].every(id => got.has(id)),
    `js=${[...jsIds].join(',')} sql=${[...got].join(',')}`);

  console.log('\n[the LIMIT counts trucking rows]');
  {
    // A haul day is travel + haul + travel. 2,600 days is 7,800 split rows but
    // only 2,600 trucking rows — under the 5,000 cap, so every one comes back.
    await client.query(`DELETE FROM daily_tracking WHERE company_code = $1`, [CO]);
    await client.query(
      `INSERT INTO daily_tracking (row_id, project_id, company_code, division, date, field_type, employee,
         job_class, equipment, equip_unit_cost, equip_hours, timesheet_entry_id)
       SELECT 'ts' || $2::text || '-' || d || '-' || k || '-1', 'p1', $1, 'paving',
              DATE '2026-09-30' - d,
              CASE WHEN k = 1 THEN 'Haul — To/From Site' ELSE 'Travel' END,
              'Nick Detwiler', 'Trucking', 'Triaxle Dump', 121,
              CASE WHEN k = 1 THEN 8 ELSE 0 END, $2::bigint
       FROM generate_series(0, 2599) d, generate_series(0, 2) k`, [CO, e1]);
    const r = await get('paving');
    assert('all 2,600 hauls come back', (r.body.rows || []).length === 2600, (r.body.rows || []).length);
    const oldest = (await client.query(`SELECT (DATE '2026-09-30' - 2599)::text AS d`)).rows[0].d;
    assert(`and the oldest (${oldest}) is there`, (r.body.rows || []).some(x => x.date === oldest));
    assert('hasMore is false', r.body.hasMore === false);
  }

  await cleanup();
  await client.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error('SQL test crashed:', err);
  try { await cleanup(); await client.end(); } catch {}
  process.exit(1);
});
