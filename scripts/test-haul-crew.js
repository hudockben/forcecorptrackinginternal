#!/usr/bin/env node
'use strict';
/**
 * A whole crew hauling: many drivers, many machines, one job.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-haul-crew.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * DESTRUCTIVE: truncates timesheet_entries, daily_tracking and app_data.
 *
 * The normal day is not one driver. It is five trucks of stone into Franklin
 * Regional, some on triaxles and some on a lowboy, alongside operators who are
 * not hauling at all — and the same man may be on a lowboy today and a triaxle
 * tomorrow.
 *
 * The truck is therefore never inferred from the job or from the person. Each
 * driver names his own on his own timesheet, so the number of trucks on a
 * project does not enter into it: five drivers are five entries, each carrying
 * its own answer, and each priced from that. The job's assigned-equipment list
 * is only a fallback for a day nobody answered, and it deliberately declines to
 * guess when the job has more than one machine on it.
 *
 * This pins that at the scale the work actually runs at, through the real
 * handler against a real PostgreSQL.
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
let AUTH = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') {
    return { neon: () => (strings, ...values) => {
      let text = '';
      strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
      return client.query(text, values).then(r => r.rows);
    } };
  }
  if (request === './lib/auth') {
    return {
      requireAuth: () => AUTH, requireDivision: () => null,
      hasDivisionAccess: (p, a) => !!(p && (p.isPlatformAdmin ||
        (p.divisionRoles && p.divisionRoles[a] && p.divisionRoles[a] !== 'no_access'))),
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

const ADMIN = { companyCode: 'FCT', userId: 99, username: 'office',
                divisionRoles: { timesheet: 'level1', payroll: 'level3' }, role: 'admin' };
const q = (sql, p) => client.query(sql, p).then(r => r.rows);

async function call(method, query, body, auth) {
  AUTH = auth;
  const res = { statusCode: 200, body: null, setHeader() {},
                status(c) { this.statusCode = c; return this; },
                json(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method, query: query || {}, body: body || {} }, res);
  return res;
}

// The crew: four drivers on three different machines, and an operator who is
// not hauling at all and must be priced exactly as he always was.
const CREW = [
  { user: 'rising',    name: 'Cam Rising',   truck: 'Triaxle Dump', haul: 'off_site' },
  { user: 'cribbs',    name: 'Jon Cribbs',   truck: 'Triaxle Dump', haul: 'off_site' },
  { user: 'fairman',   name: 'Kris Fairman', truck: 'Lowboy',       haul: 'on_site'  },
  { user: 'becker',    name: 'Ben Becker',   truck: 'Tandem Dump',  haul: 'off_site' },
  { user: 'strickall', name: 'Al Strick',    truck: null,           haul: null       },
];

(async () => {
  await client.connect();
  await client.query(`INSERT INTO companies (code,name) VALUES ('FCT','Force Corp')
                      ON CONFLICT (code) DO NOTHING`);
  await client.query('TRUNCATE timesheet_entries, daily_tracking, app_data RESTART IDENTITY CASCADE');

  await client.query(
    `INSERT INTO app_data (key,value) VALUES ('FCT:fct_project_26049', $1)`,
    [JSON.stringify({ id: '26049', 'project-name': 'Franklin Regional Multi',
                      prevailing_wage: true,
                      // Several machines on the job — the normal case, and the
                      // one the fallback refuses to guess from.
                      assigned_equipment: ['Triaxle Dump', 'Lowboy', 'Tandem Dump'] })]);
  await client.query(
    `INSERT INTO app_data (key,value) VALUES ('FCT:fct_lists', $1)`,
    [JSON.stringify({
      employees: CREW.map(c => ({ name: c.name, job_class: 'Operator',
                                  prevailing_rate: 77, non_prevailing_rate: 55 })),
      equipment: [{ name: 'Triaxle Dump', unit_cost: 121 },
                  { name: 'Lowboy',       unit_cost: 95 },
                  { name: 'Tandem Dump',  unit_cost: 88 }],
    })]);

  const ids = {};
  for (const c of CREW) {
    await client.query(
      `INSERT INTO users (company_code,username,password_hash,role) VALUES ('FCT',$1,'x','level1')
       ON CONFLICT (company_code,username) DO NOTHING`, [c.user]);
    const uid = (await q(`SELECT id FROM users WHERE username=$1`, [c.user]))[0].id;
    const FIELD = { companyCode: 'FCT', userId: uid, username: c.user,
                    divisionRoles: { timesheet: 'level1' } };
    const body = {
      entry_type: 'daily', work_date: '2026-09-01', division: 'turf',
      job_id: '26049', job_label: 'Franklin Regional Multi · 26049',
      start_time: '07:00', end_time: '15:00', lunch_break: false, operated_equipment: false,
      supervisor_id: 3, supervisor_name: 'brewernate',
    };
    if (c.haul) { body.haul_type = c.haul; body.truck_unit = c.truck; }
    const r = await call('POST', {}, body, FIELD);
    if (r.statusCode !== 200) throw new Error(`${c.user}: ${JSON.stringify(r.body)}`);
    ids[c.user] = r.body.entry.id;
    const s = await call('POST', { action: 'submit', id: ids[c.user] }, {}, FIELD);
    if (s.statusCode !== 200) throw new Error(`${c.user} submit: ${JSON.stringify(s.body)}`);
  }

  console.log('\n[five people, one job, one day — all submitted]');
  const subs = await q(`SELECT COUNT(*)::int n FROM timesheet_entries WHERE status='submitted'`);
  assert('every entry went in; nobody was refused as a duplicate', subs[0].n === CREW.length,
    `submitted=${subs[0].n} of ${CREW.length}`);
  assert('  each carries its own truck',
    (await q(`SELECT COUNT(DISTINCT truck_unit)::int n FROM timesheet_entries
              WHERE truck_unit IS NOT NULL`))[0].n === 3);

  console.log('\n[each is approved and priced from its OWN driver\'s answer]');
  for (const c of CREW) {
    const split = [{ cost_code: 'Earthwork', sub_code: 'Stone', quantity: 0,
                     // The approver names no equipment: the point is that each
                     // row still finds the right machine on its own.
                     equipment: '', labor_hours: 8, equip_hours: 0 }];
    // haul_type is not resent — the driver's own answer stands.
    const r = await call('POST', { action: 'approve', id: ids[c.user] }, { split }, ADMIN);
    if (r.statusCode !== 200) throw new Error(`${c.user} approve: ${JSON.stringify(r.body)}`);
  }

  for (const c of CREW) {
    const [row] = await q(
      `SELECT employee, rate::float rate, labor_hours::float lh, equipment,
              equip_unit_cost::float euc, field_type
         FROM daily_tracking WHERE timesheet_entry_id=$1`, [ids[c.user]]);
    if (c.haul) {
      assert(`${c.name}: labour is $0 — his truck already pays for him`, row.rate === 0,
        `rate=${row.rate}`);
      assert(`  and the row is stamped ${c.haul === 'on_site' ? 'on site' : 'to/from'}`,
        /^Haul —/.test(row.field_type || ''), row.field_type);
    } else {
      assert(`${c.name} is not hauling, so he is paid the prevailing rate as always`,
        row.rate === 77 && row.field_type === null, `rate=${row.rate} ft=${row.field_type}`);
    }
    assert(`  ${c.name} keeps all 8 hours`, row.lh === 8, `lh=${row.lh}`);
  }

  console.log('\n[the prevailing split, across the whole crew]');
  const { payrollMetrics } = require(path.resolve(__dirname, '../api/lib/payroll-metrics.js'));
  const entries = await q(
    `SELECT username, entry_type, status, division, job_id, work_date::text work_date,
            computed_hours::float computed_hours, travel_hours::float travel_hours, haul_type
       FROM timesheet_entries`);
  entries.forEach(e => { e.prevailing_wage = true; });   // Franklin Regional is PW
  const t = payrollMetrics({ entries, periodStart: '2026-08-31', periodEnd: '2026-09-13' }).totals;
  // 3 off-site haulers x 8 = 24 standard; the on-site hauler and the operator
  // are on the covered site, so 16 stay prevailing.
  assert('the three off-site haulers drop to standard: 24 h',
    t.stdHours === 24, `std=${t.stdHours}`);
  assert('the on-site hauler and the operator stay prevailing: 16 h',
    t.pwHours === 16, `pw=${t.pwHours}`);
  assert('  and the crew is still owed every hour it worked',
    t.workHours === 40 && (t.pwHours + t.stdHours) === 40);

  console.log('\n[the job assignment is only ever a fallback]');
  // Franklin has three machines on it, so with no answer from the driver there
  // is nothing to infer — and inventing one would bill the job at another
  // machine's hourly rate. The row is left bare and the approver is warned.
  const [noAnswer] = await q(
    `SELECT equipment FROM daily_tracking WHERE timesheet_entry_id=$1`, [ids.strickall]);
  assert('a day nobody called a haul gets no truck invented for it',
    !noAnswer.equipment, `equipment=${JSON.stringify(noAnswer.equipment)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  await client.end();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Harness error:', e.stack); process.exit(1); });
