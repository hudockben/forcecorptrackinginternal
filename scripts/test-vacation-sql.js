#!/usr/bin/env node
'use strict';
/**
 * Vacation banks, against a real Postgres: the table, the statements in
 * api/vacation.js, and the arithmetic over real timesheet_entries rows.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-vacation-sql.js
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * as the other *-sql.js suites. The vacation statements are run again here
 * the way scripts/run-schema.js runs them (comments stripped, split on ';'),
 * so a statement the deploy's splitter would cut in half fails this suite
 * rather than the build.
 *
 * scripts/test-vacation.js pins the logic with the database stubbed. What a
 * stub cannot show is that the SQL counts the rows it says it counts: only
 * vacation, only submitted and approved, only the year, at the hours payroll
 * pays — and that the bank is set, cleared and copied the way the tab says.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { Pool } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

// Writes and deletes rows. Make it hard to point at something real by accident.
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script writes and deletes rows. Point PG_TEST_URL at a scratch database.');
  process.exit(1);
}

const CO    = 'VACTEST';   // a company of its own, removed at the start and the end
const OTHER = 'VACTEST2';  // somebody else's company, which nothing here may reach
// A pool, not one client: the handler runs its reads side by side, as it does
// against Neon.
const client = new Pool({ connectionString: URL, max: 4 });

// neon-serverless' tagged template, backed by pg: same contract (a Promise of
// rows) so the code under test is the code that ships.
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
  if (request === './lib/auth' || request === '../lib/auth') {
    return {
      requireAuth: (req, res) => {
        if (!AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        return AUTH;
      },
      payrollAccess: p => ({ canCode: !!p.canApprove, canApprove: !!p.canApprove, isCoder: false }),
    };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const handler = require(path.join(ROOT, 'api', 'vacation.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}
const eq = (label, got, want) => assert(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

async function call(method, query, body, auth) {
  AUTH = auth;
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  await handler({ method, query, body: body === undefined ? {} : body, headers: {} }, res);
  return res;
}

/** The statements run-schema.js would run for the vacation block, split its way. */
function vacationStatements() {
  const stripped = fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  return stripped.split(';').map(s => s.trim()).filter(s => /vacation_allowances|idx_ts_vacation/.test(s));
}

async function cleanUp() {
  await client.query('DELETE FROM app_data WHERE key LIKE $1 OR key LIKE $2', [CO + ':%', OTHER + ':%']);
  await client.query('DELETE FROM companies WHERE code = $1 OR code = $2', [CO, OTHER]);   // users, entries, banks go with it
}

(async () => {
  await cleanUp();

  console.log('Vacation banks, in the database\n');

  console.log('[the schema, as the deploy runs it]');
  {
    const stmts = vacationStatements();
    assert('the vacation block splits into whole statements', stmts.length === 3
      && /^CREATE TABLE IF NOT EXISTS vacation_allowances \(/.test(stmts[0]) && /\)$/.test(stmts[0]), stmts.map(s => s.slice(0, 60)).join(' | '));
    let ok = true;
    for (const s of stmts) { try { await client.query(s); } catch (err) { ok = false; console.error(err.message); } }
    assert('  and runs again on a database that already has it', ok);
  }

  await client.query("INSERT INTO companies (code, name) VALUES ($1, 'Vacation test'), ($2, 'Other company')", [CO, OTHER]);
  const user = async (co, username, roles) => (await client.query(
    'INSERT INTO users (username, company_code, password_hash, division_roles) VALUES ($1, $2, $3, $4) RETURNING id',
    [username, co, 'x', roles ? JSON.stringify(roles) : null])).rows[0].id;
  const admin  = await user(CO, 'hudockben', { turf: 'admin' });
  const zach   = await user(CO, 'brewerzach', { timesheet: 'level1' });
  const zach2  = await user(CO, 'zbrewer', { timesheet: 'level1' });       // the same man, a second login
  const allen  = await user(CO, 'strickallen', { timesheet: 'level1' });
  const office = await user(CO, 'officejan', { turf: 'level1' });           // not on the Timesheet
  const gone   = await user(CO, 'nolonger', { timesheet: 'no_access' });    // taken off it, vacation on file
  const stranger = await user(OTHER, 'elsewhere', { timesheet: 'level1' });
  await client.query('INSERT INTO employees (company_code, name) VALUES ($1, $2), ($1, $3)', [CO, 'Zach Brewer', 'Allen Strick']);

  const ADMIN    = { companyCode: CO, userId: admin, username: 'hudockben', role: 'admin', isPlatformAdmin: false };
  const PAYROLL  = { companyCode: CO, userId: allen, username: 'strickallen', role: 'level1', isPlatformAdmin: false, canApprove: true };
  const FIELD    = { companyCode: CO, userId: zach, username: 'brewerzach', role: 'level1', isPlatformAdmin: false };

  let n = 0;
  const entry = async (uid, username, date, status, type, hours, entryType, co) => (await client.query(
    `INSERT INTO timesheet_entries (company_code, user_id, username, entry_type, work_date, status, time_off_type, time_off_hours)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [co || CO, uid, username, entryType || 'time_off', date, status, entryType === 'daily' ? null : type, hours])).rows[0].id;
  // Zach's 2026, every kind of row the count must take or leave.
  const e = {};
  e.approvedFull  = await entry(zach, 'brewerzach', '2026-03-02', 'approved',  'vacation', null);  // says nothing: a full 8
  e.approvedHalf  = await entry(zach, 'brewerzach', '2026-03-03', 'approved',  'vacation', 4);
  e.unpaid        = await entry(zach, 'brewerzach', '2026-03-04', 'approved',  'vacation', 0);     // unpaid: takes nothing
  e.waitJune      = await entry(zach, 'brewerzach', '2026-06-15', 'submitted', 'vacation', 8);
  e.waitAug       = await entry(zach, 'brewerzach', '2026-08-10', 'submitted', 'vacation', 8);
  e.draft         = await entry(zach, 'brewerzach', '2026-09-01', 'draft',     'vacation', 8);     // never asked for
  e.sick          = await entry(zach, 'brewerzach', '2026-04-01', 'approved',  'sick', 8);         // not vacation
  e.holiday       = await entry(zach, 'brewerzach', '2026-07-03', 'approved',  'holiday', 8);
  e.daily         = await entry(zach, 'brewerzach', '2026-05-05', 'approved',  null, null, 'daily');
  e.lastDay       = await entry(zach, 'brewerzach', '2026-12-31', 'submitted', 'vacation', 8);     // the year's last day counts
  e.prevYear      = await entry(zach, 'brewerzach', '2025-12-31', 'approved',  'vacation', 8);     // last year's bank
  e.nextYear      = await entry(zach, 'brewerzach', '2027-01-01', 'submitted', 'vacation', 8);     // next year's
  e.otherLogin    = await entry(zach2, 'zbrewer', '2026-02-02', 'approved',  'vacation', 8);       // his other login
  e.goneRow       = await entry(gone, 'nolonger', '2026-02-02', 'approved',  'vacation', 8);
  e.stranger      = await entry(stranger, 'elsewhere', '2026-02-02', 'approved', 'vacation', 8, null, OTHER);
  void n;

  console.log('\n[setting a bank]');
  {
    let r = await call('PUT', { user_id: String(zach), year: '2026' }, { hours: 40 }, ADMIN);
    eq('80 hours… no, 40: the PUT answers with the bank as it now stands',
      { s: r.statusCode, hours: r.body.hours, approved: r.body.approved, pending: r.body.pending, left: r.body.left, by: r.body.set_by },
      // approved: 8 (full, unsaid) + 4 (half) + 0 (unpaid) = 12
      // pending:  8 (June) + 8 (August) + 8 (Dec 31) = 24
      { s: 200, hours: 40, approved: 12, pending: 24, left: 4, by: 'hudockben' });
    const stored = (await client.query('SELECT hours::float8 AS h, set_by_user_id, set_by_name FROM vacation_allowances WHERE company_code = $1 AND user_id = $2 AND year = 2026', [CO, zach])).rows;
    eq('  one row, with who set it', stored, [{ h: 40, set_by_user_id: admin, set_by_name: 'hudockben' }]);
    r = await call('PUT', { user_id: String(zach), year: '2026' }, { hours: '30.254' }, ADMIN);
    eq('  setting it again changes that row, rounded to the cent', { hours: r.body.hours, left: r.body.left }, { hours: 30.25, left: -5.75 });
    const count = (await client.query('SELECT COUNT(*)::int AS n FROM vacation_allowances WHERE company_code = $1 AND user_id = $2', [CO, zach])).rows[0].n;
    eq('  still one row', count, 1);
    r = await call('PUT', { user_id: String(stranger), year: '2026' }, { hours: 40 }, ADMIN);
    eq('another company’s login cannot be given a bank', r.statusCode, 404);
    const theirs = (await client.query('SELECT COUNT(*)::int AS n FROM vacation_allowances WHERE user_id = $1', [stranger])).rows[0].n;
    eq('  and none was made', theirs, 0);
    r = await call('PUT', { user_id: String(zach), year: '2026' }, {}, ADMIN);
    eq('a body with no hours is refused, not read as "stop tracking"', r.statusCode, 400);
    r = await call('PUT', { user_id: String(zach), year: '2026' }, { hours: 1001 }, ADMIN);
    eq('more than the table allows is refused before it reaches the table', r.statusCode, 400);
    r = await call('PUT', { user_id: String(zach), year: '2026' }, { hours: 80 }, FIELD);
    eq('only an admin may set a bank', r.statusCode, 403);
    r = await call('PUT', { user_id: String(zach), year: '2026' }, { hours: 80 }, PAYROLL);
    eq('  not a payroll approver either', r.statusCode, 403);
    let threw = false;
    try { await client.query('INSERT INTO vacation_allowances (company_code, user_id, year, hours) VALUES ($1, $2, 2026, 5)', [CO, zach]); }
    catch { threw = true; }
    assert('the table holds one bank per login and year', threw);
    threw = false;
    try { await client.query('INSERT INTO vacation_allowances (company_code, user_id, year, hours) VALUES ($1, $2, 2030, -1)', [CO, zach]); }
    catch { threw = true; }
    assert('  and no negative bank', threw);
    await call('PUT', { user_id: String(zach), year: '2026' }, { hours: 80 }, ADMIN);
  }

  console.log('\n[what the man sees: his own banks]');
  {
    let r = await call('GET', { mine: '1', years: '2026,2027,2025' }, undefined, FIELD);
    eq('2026 tracked; the others not set', r.body.balances, {
      2025: { tracked: false },
      2026: { tracked: true, hours: 80, approved: 12, pending: 24, left: 44 },
      2027: { tracked: false },
    });
    await call('PUT', { user_id: String(zach), year: '2027' }, { hours: 40 }, ADMIN);
    r = await call('GET', { mine: '1', years: '2027' }, undefined, FIELD);
    eq('next year’s bank takes next year’s request only', r.body.balances['2027'], { tracked: true, hours: 40, approved: 0, pending: 8, left: 32 });
    r = await call('GET', { mine: '1', years: '2026' }, undefined, { ...FIELD, userId: allen, username: 'strickallen' });
    eq('somebody else asking gets their own, which is not set', r.body.balances['2026'], { tracked: false });
    r = await call('GET', { mine: '1', years: '26' }, undefined, FIELD);
    eq('a year that is not a year is refused', r.statusCode, 400);
  }

  console.log('\n[Payroll: which waiting request goes over]');
  {
    await call('PUT', { user_id: String(zach), year: '2026' }, { hours: 28 }, ADMIN);
    let r = await call('GET', { year: '2026', view: 'payroll' }, undefined, PAYROLL);
    const z = r.body.balances[zach];
    // 28 − 12 approved = 16 before the waiting ones; June leaves 8, August 0, Dec 31 −8.
    eq('the approver sees the bank and what each waiting request leaves', z,
      { hours: 28, approved: 12, pending: 24, left: -8,
        after: { [e.waitJune]: 8, [e.waitAug]: 0, [e.lastDay]: -8 } });
    eq('  only banks that are set, and only this company’s', Object.keys(r.body.balances), [String(zach)]);
    await client.query("UPDATE timesheet_entries SET status = 'approved' WHERE id = $1", [e.lastDay]);
    r = await call('GET', { year: '2026', view: 'payroll' }, undefined, PAYROLL);
    eq('approving the December day takes it first; the waiting ones are what is short',
      r.body.balances[zach].after, { [e.waitJune]: 0, [e.waitAug]: -8 });
    await client.query("UPDATE timesheet_entries SET status = 'submitted' WHERE id = $1", [e.lastDay]);
    await client.query('DELETE FROM timesheet_entries WHERE id = $1', [e.waitAug]);
    r = await call('GET', { year: '2026', view: 'payroll' }, undefined, PAYROLL);
    eq('denying (deleting) a request gives its hours back', { left: r.body.balances[zach].left, after: r.body.balances[zach].after },
      { left: 0, after: { [e.waitJune]: 8, [e.lastDay]: 0 } });
    await client.query("UPDATE timesheet_entries SET time_off_hours = 4 WHERE id = $1", [e.waitJune]);
    r = await call('GET', { year: '2026', view: 'payroll' }, undefined, PAYROLL);
    eq('an edit to a request’s hours counts at the new hours', r.body.balances[zach].left, 4);
    await client.query("UPDATE timesheet_entries SET time_off_type = 'sick' WHERE id = $1", [e.waitJune]);
    r = await call('GET', { year: '2026', view: 'payroll' }, undefined, PAYROLL);
    eq('  and one retyped as sick stops counting', r.body.balances[zach].left, 8);
    r = await call('GET', { year: '2026', view: 'payroll' }, undefined, FIELD);
    eq('a field login cannot read anybody’s', r.statusCode, 403);
    r = await call('GET', { year: '2026', view: 'payroll' }, undefined, ADMIN);
    eq('an admin can', r.statusCode, 200);
  }

  console.log('\n[the Manage System tab]');
  {
    await call('PUT', { user_id: String(zach), year: '2025' }, { hours: 24 }, ADMIN);
    await call('PUT', { user_id: String(allen), year: '2025' }, { hours: 80 }, ADMIN);
    let r = await call('GET', { year: '2026' }, undefined, ADMIN);
    const names = r.body.people.map(p => p.username);
    eq('everybody on the Timesheet, and anybody with vacation on file, by name',
      names, ['strickallen', 'nolonger', 'brewerzach', 'zbrewer']);
    const zrow = r.body.people.find(p => p.username === 'brewerzach');
    eq('a login is shown as the person it is, with his other login named',
      { person: zrow.person, also: zrow.also, timesheet: zrow.timesheet }, { person: 'Zach Brewer', also: ['zbrewer'], timesheet: true });
    eq('  his bank, and last year’s for reference (24 − 8 taken = 16 unused)',
      { hours: zrow.hours, approved: zrow.approved, pending: zrow.pending, left: zrow.left, prev: zrow.prev },
      { hours: 28, approved: 12, pending: 8, left: 8, prev: { hours: 24, left: 16 } });
    const z2 = r.body.people.find(p => p.username === 'zbrewer');
    eq('his other login shows what it filed, untracked', { hours: z2.hours, approved: z2.approved, left: z2.left, also: z2.also },
      { hours: null, approved: 8, left: null, also: ['brewerzach'] });
    const goneRow = r.body.people.find(p => p.username === 'nolonger');
    eq('a login taken off the Timesheet still shows with its vacation', { timesheet: goneRow.timesheet, approved: goneRow.approved }, { timesheet: false, approved: 8 });
    assert('nobody off the Timesheet with nothing on file', !names.includes('officejan') && !names.includes('hudockben'));
    eq('one login has last year’s bank and nothing this year: that is what Copy would fill', r.body.copyable, 1);
    r = await call('GET', { year: '2026' }, undefined, PAYROLL);
    eq('the tab is for admins', r.statusCode, 403);
  }

  console.log('\n[copying last year’s hours]');
  {
    let r = await call('POST', { action: 'copy', from: '2025', to: '2026' }, {}, ADMIN);
    eq('copies only for logins with nothing set for the new year', { s: r.statusCode, copied: r.body.copied }, { s: 200, copied: 1 });
    const banks = (await client.query('SELECT user_id, hours::float8 AS h FROM vacation_allowances WHERE company_code = $1 AND year = 2026 ORDER BY user_id', [CO])).rows;
    eq('  Allen gets his 80; Zach keeps the 28 somebody typed', banks, [{ user_id: zach, h: 28 }, { user_id: allen, h: 80 }]);
    r = await call('POST', { action: 'copy', from: '2025', to: '2026' }, {}, ADMIN);
    eq('  copying again copies nothing', r.body.copied, 0);
    r = await call('POST', { action: 'copy', from: '2026', to: '2026' }, {}, ADMIN);
    eq('  a year onto itself is refused', r.statusCode, 400);
    r = await call('POST', { action: 'copy', from: '2025', to: '2026' }, {}, PAYROLL);
    eq('  and only an admin may copy', r.statusCode, 403);
  }

  console.log('\n[stopping, and a login removed]');
  {
    let r = await call('PUT', { user_id: String(allen), year: '2026' }, { hours: '' }, ADMIN);
    eq('an emptied box stops tracking that year', { s: r.statusCode, hours: r.body.hours, left: r.body.left }, { s: 200, hours: null, left: null });
    const left = (await client.query('SELECT COUNT(*)::int AS n FROM vacation_allowances WHERE user_id = $1 AND year = 2026', [allen])).rows[0].n;
    eq('  the row is gone', left, 0);
    const still = (await client.query('SELECT COUNT(*)::int AS n FROM vacation_allowances WHERE user_id = $1 AND year = 2025', [allen])).rows[0].n;
    eq('  last year’s is not touched', still, 1);
    await client.query('DELETE FROM users WHERE id = $1', [zach]);
    const banks = (await client.query('SELECT COUNT(*)::int AS n FROM vacation_allowances WHERE user_id = $1', [zach])).rows[0].n;
    eq('deleting a login takes its banks with it', banks, 0);
  }

  await cleanUp();
  await client.end();
  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error(err);
  try { await cleanUp(); await client.end(); } catch {}
  process.exit(1);
});
