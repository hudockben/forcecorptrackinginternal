#!/usr/bin/env node
'use strict';
/**
 * SQL-level test for the hauling columns, against a real PostgreSQL.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-haul-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * DESTRUCTIVE: truncates timesheet_entries and employees. It refuses to run
 * against a database whose name doesn't look like a test database.
 *
 * The mocked suites assert what the handlers intend to send. This one asserts
 * what PostgreSQL actually does with it, for the three pieces of SQL that
 * cannot be checked any other way:
 *
 *   - the haul_type CHECK constraint really admits only NULL / on_site /
 *     off_site. '' in particular must be refused: safeHaulType turns an empty
 *     answer into NULL precisely so it never reaches here, and if that ever
 *     regressed the column is the last thing standing between a typo and a
 *     driver's hours being reclassified.
 *
 *   - the employees role upsert leaves the flag the caller did NOT send alone.
 *     Supervisor and Driver are two toggles in one modal writing one row, so a
 *     single upsert has to supply a value for the absent flag; it sends NULL and
 *     COALESCE keeps what is stored. Getting this wrong silently un-supervises
 *     somebody the first time they are marked a driver, which nobody would
 *     notice until a timesheet could not find its approver.
 *
 *   - the keepHaul CASE WHEN preserves a stored answer when payroll's Edit Entry
 *     modal — which sends no haul_type at all — saves a correction to the hours.
 */

const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

// This truncates. Make it hard to point at something real by accident.
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

(async () => {
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query('TRUNCATE timesheet_entries, employees RESTART IDENTITY CASCADE');
  await c.query(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp')
                 ON CONFLICT (code) DO NOTHING`);
  await c.query(`INSERT INTO users (company_code, username, password_hash, role)
                 VALUES ('FCT','kris','x','level1')
                 ON CONFLICT (company_code, username) DO NOTHING`);
  const userId = (await c.query(`SELECT id FROM users WHERE username='kris'`)).rows[0].id;

  const newEntry = ht => c.query(
    `INSERT INTO timesheet_entries (company_code,user_id,username,entry_type,work_date,haul_type)
     VALUES ('FCT',$1,'kris','daily','2026-08-31',$2) RETURNING id, haul_type`, [userId, ht]);

  // ── The column's own domain ───────────────────────────────────────────────
  console.log('\n[haul_type admits exactly three answers]');
  for (const v of [null, 'on_site', 'off_site']) {
    try {
      const r = await newEntry(v);
      assert(`accepts ${JSON.stringify(v)}`, r.rows[0].haul_type === v);
    } catch (e) { assert(`accepts ${JSON.stringify(v)}`, false, e.message); }
  }
  // '' is the one worth naming: it is what a form posts for "no answer", and it
  // must never be stored as a fourth state that reads as truthy downstream.
  for (const v of ['', 'onsite', 'ON_SITE', 'off site', 'haul', 'Haul — On Site']) {
    try {
      await newEntry(v);
      assert(`refuses ${JSON.stringify(v)}`, false, 'it was accepted');
    } catch (e) {
      assert(`refuses ${JSON.stringify(v)}`, /check constraint/i.test(e.message), e.message.slice(0, 70));
    }
  }

  // ── The role upsert (api/employees.js PATCH) ──────────────────────────────
  console.log('\n[one role toggle never clears the other]');
  const patch = async (name, sup, drv) => {
    const supVal = sup === undefined ? null : Boolean(sup);
    const drvVal = drv === undefined ? null : Boolean(drv);
    const r = await c.query(
      `INSERT INTO employees (company_code,name,is_supervisor,is_driver,sort_order,active,updated_at)
       VALUES ($1,$2,COALESCE($3::boolean,FALSE),COALESCE($4::boolean,FALSE),
         (SELECT COALESCE(MAX(sort_order),-1)+1 FROM employees WHERE company_code=$5),TRUE,NOW())
       ON CONFLICT (company_code,name) DO UPDATE SET
         is_supervisor = COALESCE($6::boolean, employees.is_supervisor),
         is_driver     = COALESCE($7::boolean, employees.is_driver),
         updated_at    = NOW()
       RETURNING id,name,is_supervisor,is_driver`,
      ['FCT', name, supVal, drvVal, 'FCT', supVal, drvVal]);
    return r.rows[0];
  };

  let r = await patch('Kris Fairman', undefined, true);
  assert('a person with no employees row yet can be flagged Driver',
    r && r.is_driver === true && r.is_supervisor === false);
  assert('  and a row always comes back, so the response is never undefined', !!(r && r.id));

  r = await patch('Kris Fairman', true, undefined);
  assert('flagging Supervisor afterwards KEEPS Driver',
    r.is_supervisor === true && r.is_driver === true);

  r = await patch('Kris Fairman', undefined, false);
  assert('un-flagging Driver KEEPS Supervisor',
    r.is_supervisor === true && r.is_driver === false);

  r = await patch('Kris Fairman', false, undefined);
  assert('un-flagging Supervisor leaves Driver as it was',
    r.is_supervisor === false && r.is_driver === false);

  r = await patch('Kris Fairman', true, true);
  assert('both flags in one call works', r.is_supervisor === true && r.is_driver === true);

  const n = (await c.query(`SELECT COUNT(*)::int n FROM employees WHERE name='Kris Fairman'`)).rows[0].n;
  assert('  and five upserts left exactly one row', n === 1, `rows=${n}`);

  // ── keepHaul (the PUT in api/timesheet-entries.js) ────────────────────────
  console.log('\n[payroll editing the hours does not erase the driver\'s answer]');
  const e = (await newEntry('off_site')).rows[0];
  const save = async (keep, val) => (await c.query(
    `UPDATE timesheet_entries
        SET haul_type = CASE WHEN $1::boolean THEN haul_type ELSE $2::text END
      WHERE id = $3 RETURNING haul_type`, [keep, val, e.id])).rows[0].haul_type;

  assert('a save that sends no haul_type keeps the stored answer',
    await save(true, null) === 'off_site');
  assert('a save that sends one overwrites it',
    await save(false, 'on_site') === 'on_site');
  assert('a save that sends a blank clears it',
    await save(false, null) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  await c.end();
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('Harness error:', err.message);
  process.exit(1);
});
