#!/usr/bin/env node
'use strict';
process.env.TZ = 'Europe/Berlin';
/**
 * A Safety Center day, end to end, against a real PostgreSQL.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-safety-hours-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * scripts/test-safety-hours.js asserts what the endpoints send; this one asserts
 * what the database does with it, through the real handlers:
 *
 *   laborer files a Safety Center day → submits it → the Safety Center lists it
 *   as waiting on payroll → payroll approves it with the plain Approve → it is
 *   in the Safety Center's hours log, and nothing was posted anywhere else →
 *   payroll un-approves it → it is back to waiting, and gone from the log.
 *
 * Plus the casts the hours read depends on (a DATE as text, NUMERIC as a
 * number), the signer-name lookup, and the scoping a mock can only pretend to
 * apply: another company, another division, a draft, a day off.
 *
 * Everything it writes is under its own company code, which it clears before
 * and after, so it never touches anyone else's rows — but it still refuses a
 * database whose name does not look like a test database.
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
process.env.DATABASE_URL = URL;

const client = new Client({ connectionString: URL });

// neon-serverless' tagged template, backed by pg: same contract (a Promise of
// the row array), so the handlers cannot tell the difference.
function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

// Only token decoding is replaced; every access rule is the real one.
const realAuth = require(path.resolve(__dirname, '..', 'api', 'lib', 'auth.js'));
let AUTH = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  if (request === './lib/auth') return Object.assign({}, realAuth, { requireAuth: async () => AUTH });
  return origLoad.apply(this, arguments);
};

const entries = require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'));
const hours   = require(path.resolve(__dirname, '..', 'api', 'safety-hours.js'));
const jobs    = require(path.resolve(__dirname, '..', 'api', 'timesheet-jobs.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const CO = 'SAFEHRS_TEST';
const OTHER_CO = 'SAFEHRS_OTHER';

async function call(handler, auth, method, query, body) {
  AUTH = auth;
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query: query || {}, body: body || {}, headers: {} }, res);
  return res;
}

async function clear() {
  for (const co of [CO, OTHER_CO]) {
    await client.query('DELETE FROM timesheet_audit_log WHERE company_code = $1', [co]);
    await client.query('DELETE FROM daily_tracking     WHERE company_code = $1', [co]);
    await client.query('DELETE FROM timesheet_entries  WHERE company_code = $1', [co]);
    await client.query('DELETE FROM safety_signatures  WHERE company_code = $1', [co]);
    await client.query('DELETE FROM safety_documents   WHERE company_code = $1', [co]);
    await client.query("DELETE FROM app_data WHERE key LIKE $1", [co + ':%']);
    await client.query('DELETE FROM users              WHERE company_code = $1', [co]);
    await client.query('DELETE FROM companies          WHERE code = $1', [co]);
  }
}

async function user(co, username, roles) {
  const { rows } = await client.query(
    `INSERT INTO users (company_code, username, password_hash, role, division_roles)
     VALUES ($1, $2, 'x', 'level1', $3::jsonb) RETURNING id`,
    [co, username, JSON.stringify(roles)]);
  return { companyCode: co, userId: rows[0].id, username, divisionRoles: roles };
}

const DAY = {
  entry_type: 'daily', work_date: '2026-11-02', division: 'safety',
  job_id: 'safety:training', job_label: 'Safety Training',
  // 07:00–10:00 with lunch is 2.5 h — the deduction applies here as on any day.
  start_time: '07:00', end_time: '10:00', lunch_break: true, operated_equipment: false,
  travel_to_site_hours: '0.5', travel_to_shop_hours: '',
  supervisor_id: null, supervisor_name: 'Steve Travis', notes: 'Fall protection refresher',
};

async function run() {
  await client.connect();
  await clear();
  for (const co of [CO, OTHER_CO]) {
    await client.query(`INSERT INTO companies (code, name) VALUES ($1, $1)`, [co]);
  }
  const LABORER = await user(CO, 'strickallen', { timesheet: 'level1' });
  const PAYROLL = await user(CO, 'office',      { timesheet: 'level1', payroll: 'level3' });
  const SUP     = await user(CO, 'travissteve', { safety: 'level3' });
  const OTHER   = await user(OTHER_CO, 'strickallen', { timesheet: 'level1' });
  const appDataBefore = Number((await client.query('SELECT COUNT(*)::int AS n FROM app_data')).rows[0].n);

  console.log('\n[the Timesheet offers it]');
  {
    const r = await call(jobs, LABORER, 'GET', { division: 'safety' });
    assert('the job picker answers for safety', r.statusCode === 200 && r.body.jobs.some(j => j.id === DAY.job_id),
      JSON.stringify(r.body));
  }

  console.log('\n[the laborer files and submits a Safety Center day]');
  const created = await call(entries, LABORER, 'POST', {}, DAY);
  assert('the draft is created', created.statusCode === 200 && created.body.ok, JSON.stringify(created.body));
  const id = created.body.entry && created.body.entry.id;
  {
    const { rows: [r] } = await client.query('SELECT * FROM timesheet_entries WHERE id = $1', [id]);
    assert('  stored under the safety division, against the activity', r && r.division === 'safety' && r.job_id === 'safety:training');
    assert('  with its hours worked out by the server, lunch taken off', r && Number(r.computed_hours) === 2.5, r && r.computed_hours);
    assert('  and its travel kept beside them', r && Number(r.travel_hours) === 0.5, r && r.travel_hours);
  }
  const submitted = await call(entries, LABORER, 'POST', { action: 'submit', id: String(id) });
  assert('it is submitted', submitted.statusCode === 200 && submitted.body.entry.status === 'submitted',
    JSON.stringify(submitted.body));

  // Noise the read must step around: the same man's turf day, a safety draft,
  // a day off, and a safety day in another company under the same login.
  await client.query(
    `INSERT INTO timesheet_entries (company_code, user_id, username, entry_type, work_date, status,
       division, job_id, job_label, start_time, end_time, computed_hours, supervisor_name)
     VALUES ($1,$2,'strickallen','daily','2026-11-02','approved','turf','26019','Punxsy','10:00','16:00',6,'Steve Travis'),
            ($1,$2,'strickallen','daily','2026-11-03','draft','safety','safety:meeting','Safety Meeting / Tailgate','07:00','07:30',0.5,'Steve Travis'),
            ($3,$4,'strickallen','daily','2026-11-02','approved','safety','safety:meeting','Safety Meeting / Tailgate','07:00','08:00',1,'X')`,
    [CO, LABORER.userId, OTHER_CO, OTHER.userId]);
  await client.query(
    `INSERT INTO timesheet_entries (company_code, user_id, username, entry_type, work_date, status, time_off_type, supervisor_name)
     VALUES ($1,$2,'strickallen','time_off','2026-11-04','approved','vacation','Steve Travis')`,
    [CO, LABORER.userId]);

  const RANGE = { from: '2026-10-26', to: '2026-11-08' };

  console.log('\n[before payroll approves it]');
  {
    const r = await call(hours, SUP, 'GET', RANGE);
    assert('the Safety Center reads the range', r.statusCode === 200, JSON.stringify(r.body));
    assert('  the day is listed as waiting on payroll', r.body.pending.length === 1 && r.body.pending[0].id === String(id),
      JSON.stringify(r.body.pending));
    assert('  and it is not in the hours log yet', r.body.entries.length === 0, JSON.stringify(r.body.entries));
  }

  console.log('\n[payroll approves it — the same plain Approve as any status-only day]');
  {
    const r = await call(entries, PAYROLL, 'POST', { action: 'approve', id: String(id) });
    assert('approved', r.statusCode === 200 && r.body.entry.status === 'approved', JSON.stringify(r.body));
    const { rows: [n] } = await client.query(
      'SELECT COUNT(*)::int AS n FROM daily_tracking WHERE timesheet_entry_id = $1', [id]);
    assert('  no cost tracking row was posted', n.n === 0, n.n);
    const appDataAfter = Number((await client.query('SELECT COUNT(*)::int AS n FROM app_data')).rows[0].n);
    assert('  and no division blob was written', appDataAfter === appDataBefore, `${appDataBefore} → ${appDataAfter}`);
    const { rows: audit } = await client.query(
      `SELECT action FROM timesheet_audit_log WHERE company_code = $1 AND entry_id = $2 ORDER BY id`, [CO, id]);
    assert('  and the audit trail reads like any other day\'s', audit.map(a => a.action).join(',') === 'INSERT,SUBMIT,APPROVE',
      audit.map(a => a.action).join(','));
  }

  console.log('\n[after — the Safety Center hours log]');
  {
    const r = await call(hours, SUP, 'GET', RANGE);
    const e = r.body.entries[0] || {};
    assert('the day is in the log', r.statusCode === 200 && r.body.entries.length === 1 && e.id === String(id),
      JSON.stringify(r.body));
    assert('  and no longer waiting', r.body.pending.length === 0);
    assert('  hours and travel as numbers, out of NUMERIC', e.hours === 2.5 && e.travelHours === 0.5,
      `${typeof e.hours} ${e.hours} / ${typeof e.travelHours} ${e.travelHours}`);
    assert('  the date as the calendar day, out of a DATE, east of Greenwich', e.workDate === '2026-11-02', e.workDate);
    assert('  who approved it', e.approvedBy === 'office' && !!e.approvedAt);
    assert('  with lunch, supervisor and notes carried', e.lunchBreak === true && e.supervisorName === 'Steve Travis'
      && e.notes === 'Fall protection refresher');
    assert('  never another division\'s day, a draft, a day off, or another company\'s',
      r.body.entries.length + r.body.pending.length === 1);
  }
  {
    // The name a person signed a form with, the latest one.
    await client.query(
      `INSERT INTO safety_documents (id, company_code, title, week_of, filename, storage_key)
       VALUES ('doc-safehrs-1', $1, 'Ladders', '2026-10-26', 'l.pdf', 'safety/SAFEHRS_TEST/doc-safehrs-1.pdf')`, [CO]);
    await client.query(
      `INSERT INTO safety_signatures (company_code, document_id, user_id, username, full_name, signed_at)
       VALUES ($1,'doc-safehrs-1',$2,'strickallen','A Strick','2026-10-26T12:00:00Z')`, [CO, LABORER.userId]);
    await client.query(
      `INSERT INTO safety_documents (id, company_code, title, week_of, filename, storage_key)
       VALUES ('doc-safehrs-2', $1, 'Heat', '2026-11-02', 'h.pdf', 'safety/SAFEHRS_TEST/doc-safehrs-2.pdf')`, [CO]);
    await client.query(
      `INSERT INTO safety_signatures (company_code, document_id, user_id, username, full_name, signed_at)
       VALUES ($1,'doc-safehrs-2',$2,'strickallen','Allen Strick','2026-11-02T12:00:00Z')`, [CO, LABORER.userId]);
    const r = await call(hours, SUP, 'GET', RANGE);
    assert('a person is named as they last signed', (r.body.entries[0] || {}).fullName === 'Allen Strick',
      JSON.stringify(r.body.entries[0]));
  }
  {
    const r = await call(hours, SUP, 'GET', {});
    assert('no dates reads every handed-in safety day of the company',
      r.statusCode === 200 && r.body.entries.length === 1 && r.body.from === null && r.body.to === null);
    const narrow = await call(hours, SUP, 'GET', { from: '2026-11-03', to: '2026-11-08' });
    assert('a range that misses the day misses it', narrow.statusCode === 200 && narrow.body.entries.length === 0);
  }
  {
    const r = await call(entries, PAYROLL, 'GET', { scope: 'all', division: 'safety', from: '2026-10-26', to: '2026-11-08', status: 'approved' });
    const ids = (r.body.entries || []).map(e => String(e.id));
    assert('payroll\'s Division filter narrows the review grid to Safety Center days',
      r.statusCode === 200 && ids.length === 1 && ids[0] === String(id), JSON.stringify(ids));
  }

  console.log('\n[payroll un-approves it]');
  {
    const r = await call(entries, PAYROLL, 'POST', { action: 'unapprove', id: String(id) });
    assert('back to Pending', r.statusCode === 200 && r.body.entry.status === 'submitted', JSON.stringify(r.body));
    const h = await call(hours, SUP, 'GET', RANGE);
    assert('  gone from the hours log with nothing to clean up', h.body.entries.length === 0);
    assert('  and waiting on payroll again', h.body.pending.length === 1 && h.body.pending[0].id === String(id));
  }

  console.log('\n[payroll edits a safety day — the activity and the haul answer]');
  {
    // A day filed against an activity that has since been retired. Inserted
    // directly: no current page can file one, which is the point.
    const { rows: [old] } = await client.query(
      `INSERT INTO timesheet_entries (company_code, user_id, username, entry_type, work_date, status,
         division, job_id, job_label, start_time, end_time, computed_hours, supervisor_name)
       VALUES ($1,$2,'strickallen','daily','2026-10-28','submitted','safety','safety:fit-test',
               'Respirator Fit Test','13:00','14:00',1,'Steve Travis') RETURNING id`, [CO, LABORER.userId]);
    const edit = over => Object.assign({}, DAY, { work_date: '2026-10-28', job_id: 'safety:fit-test',
      job_label: 'Respirator Fit Test', start_time: '13:00', end_time: '14:30', lunch_break: false }, over);
    const kept = await call(entries, PAYROLL, 'PUT', { id: String(old.id) }, edit());
    const { rows: [k] } = await client.query('SELECT job_id, job_label, computed_hours FROM timesheet_entries WHERE id = $1', [old.id]);
    assert('correcting the hours on a day filed under a retired activity still works',
      kept.statusCode === 200 && k.job_id === 'safety:fit-test' && Number(k.computed_hours) === 1.5,
      `${kept.statusCode} ${JSON.stringify(kept.body).slice(0, 160)}`);
    assert('  and it keeps the label it was filed with', k.job_label === 'Respirator Fit Test', k.job_label);
    const moved = await call(entries, PAYROLL, 'PUT', { id: String(old.id) }, edit({ job_id: 'safety:made-up', job_label: 'Made Up' }));
    assert('but it cannot be moved onto an activity that does not exist', moved.statusCode === 400,
      `${moved.statusCode} ${JSON.stringify(moved.body)}`);

    // A driver's turf day with an off-site haul answer, which payroll then moves
    // to the Safety Center. Payroll's Edit sends no haul_type key — on any other
    // move that keeps the stored answer, and here it must not.
    const { rows: [haul] } = await client.query(
      `INSERT INTO timesheet_entries (company_code, user_id, username, entry_type, work_date, status,
         division, job_id, job_label, start_time, end_time, computed_hours, supervisor_name, haul_type)
       VALUES ($1,$2,'strickallen','daily','2026-10-29','submitted','turf','26019','Punxsy','07:00','09:00',2,
               'Steve Travis','off_site') RETURNING id`, [CO, LABORER.userId]);
    const toSafety = await call(entries, PAYROLL, 'PUT', { id: String(haul.id) },
      Object.assign({}, DAY, { work_date: '2026-10-29', start_time: '07:00', end_time: '09:00', lunch_break: false }));
    const { rows: [h] } = await client.query('SELECT division, haul_type FROM timesheet_entries WHERE id = $1', [haul.id]);
    assert('a haul day moved to the Safety Center loses its haul answer',
      toSafety.statusCode === 200 && h.division === 'safety' && h.haul_type === null,
      `${toSafety.statusCode} ${JSON.stringify(h)} ${JSON.stringify(toSafety.body).slice(0, 120)}`);

    // And the laborer's own create, with a haul answer from a driver's form.
    const filed = await call(entries, LABORER, 'POST', {},
      Object.assign({}, DAY, { work_date: '2026-10-30', haul_type: 'off_site' }));
    const { rows: [f] } = await client.query('SELECT haul_type FROM timesheet_entries WHERE id = $1', [filed.body.entry.id]);
    assert('a safety day filed with a haul answer stores none', filed.statusCode === 200 && f.haul_type === null,
      JSON.stringify(f));
  }

  console.log('\n[who may read it]');
  {
    const crew = await user(CO, 'jhauser', { timesheet: 'level1', safety: 'level1' });
    assert('crew are refused', (await call(hours, crew, 'GET', RANGE)).statusCode === 403);
    assert('payroll alone is refused', (await call(hours, PAYROLL, 'GET', RANGE)).statusCode === 403);
  }

  await clear();
  await client.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch(async err => {
  console.error(err);
  try { await clear(); await client.end(); } catch { /* already gone */ }
  process.exit(1);
});
