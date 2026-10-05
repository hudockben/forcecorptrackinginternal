#!/usr/bin/env node
'use strict';
/**
 * Auto Reports, against a real Postgres: the schedules API, the runner's
 * checks, and the five-minute cron.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-report-schedules-sql.js
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * as the other *-sql.js suites.
 *
 * What a stub cannot show, and this does:
 *   - a schedule's next time is computed and stored, and moves on after a run;
 *   - two cron runs that overlap send each due report once, not twice;
 *   - a claim left by a run that died is picked up, a live one is not;
 *   - a report twelve hours late is written down as missed, not sent;
 *   - the account a schedule runs as is checked as it is NOW — deleted, or
 *     its division taken away, and the schedule stops with a reason.
 *
 * Building and sending the report itself is test-auto-report-browser.js's job;
 * here runSchedule is replaced where the cron would call it.
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

const CO = 'RSTEST';
const client = new Client({ connectionString: URL });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

const ROOT = path.resolve(__dirname, '..');
const realAuth = require(path.join(ROOT, 'api/lib/auth.js'));

let AUTH = null;
let SQL_CLIENT = client;
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(SQL_CLIENT) };
  // The API handler's auth: who is asking is the test's to say; what they may
  // do is the real rule.
  if (request === '../lib/auth' && parent && /api[\\/]email[\\/](report-schedules|send-report)\.js$/.test(parent.filename)) {
    return {
      ...realAuth,
      requireAuth: (req, res) => {
        if (!AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        return AUTH;
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.join(ROOT, 'api/email/report-schedules.js'));
const runner  = require(path.join(ROOT, 'api/lib/report-schedule-runner.js'));
const cron    = require(path.join(ROOT, 'api/cron/report-schedules.js'));
const T       = require(path.join(ROOT, 'api/lib/report-schedule-time.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

async function call(method, query, body, auth, h = handler) {
  AUTH = auth;
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  await h({ method, query: query || {}, body: body || {}, headers: { host: 'datawatch.test' } }, res);
  return res;
}
// The Email Report button's endpoint: who may send which report by hand.
const sendReport = require(path.join(ROOT, 'api/email/send-report.js'));
const emailNow = (report_type, auth) => call('POST', {}, { report_type, recipients: [], html: '<p>x</p>' }, auth, sendReport);

async function cleanUp() {
  await client.query('DELETE FROM report_schedules WHERE company_code = $1', [CO]);
  await client.query('DELETE FROM report_recipient_groups WHERE company_code = $1', [CO]);
  await client.query('DELETE FROM app_data WHERE key LIKE $1', [CO + ':%']);
  await client.query('DELETE FROM companies WHERE code = $1', [CO]);
}

const row = async id => (await client.query('SELECT * FROM report_schedules WHERE id = $1', [id])).rows[0];
const runsFor = async id => (await client.query('SELECT * FROM report_schedule_runs WHERE schedule_id = $1 ORDER BY id', [id])).rows;

(async () => {
  await client.connect();
  const sql = makeSql(client);
  await cleanUp();
  await client.query("INSERT INTO companies (code, name) VALUES ($1, 'Auto Reports test')", [CO]);
  const mkUser = async (username, roles) => (await client.query(
    "INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ($1, $2, 'x', 'level1', $3) RETURNING id",
    [username, CO, JSON.stringify(roles)])).rows[0].id;
  const bossId  = await mkUser('boss',  { turf: 'admin', paving: 'admin', dust: 'admin' });
  const pavId   = await mkUser('pavadmin', { paving: 'admin' });
  const fieldId = await mkUser('foreman', { turf: 'level1' });

  const BOSS  = { companyCode: CO, userId: bossId, username: 'boss', role: 'level1', divisionRoles: { turf: 'admin', paving: 'admin', dust: 'admin' } };
  const PAV   = { companyCode: CO, userId: pavId,  username: 'pavadmin', role: 'level1', divisionRoles: { paving: 'admin' } };
  const FIELD = { companyCode: CO, userId: fieldId, username: 'foreman', role: 'level1', divisionRoles: { turf: 'level1' } };

  const grp = async (name, emails) => (await client.query(
    'INSERT INTO report_recipient_groups (company_code, name, emails) VALUES ($1, $2, $3) RETURNING id',
    [CO, name, JSON.stringify(emails)])).rows[0].id;
  const g1 = await grp('Turf PMs', ['pm1@example.com', 'PM2@example.com']);
  const g2 = await grp('Office',   ['office@example.com', 'pm1@example.com']);

  // Two turf jobs on the books, for the job picker.
  await client.query("INSERT INTO app_data (key, value) VALUES ($1, $2)", [CO + ':fct_projects_index', JSON.stringify(['j1', 'j2'])]);
  await client.query("INSERT INTO app_data (key, value) VALUES ($1, $2)", [CO + ':fct_project_j1', JSON.stringify({ id: 'j1', 'project-name': 'Maple Ave', 'job-number': '26101', status: 'In Progress' })]);
  await client.query("INSERT INTO app_data (key, value) VALUES ($1, $2)", [CO + ':fct_project_j2', JSON.stringify({ id: 'j2', 'project-name': 'Oak St', 'job-number': '26102', status: 'Complete' })]);

  const base = {
    report_type: 'turf_daily_pm', project_id: 'j1', project_name: 'Maple Ave',
    frequency: 'weekdays', send_time: '06:30', timezone: 'America/New_York', group_ids: [g1],
  };

  console.log('Who may use it');
  {
    let r = await call('GET', {}, null, FIELD);
    assert('a user who is not an admin is refused', r.statusCode === 403);
    r = await call('GET', {}, null, BOSS);
    assert('an admin gets the divisions they can open, with their reports',
      r.statusCode === 200 && JSON.stringify(r.body.divisions.map(d => d.key)) === '["turf","paving","dust"]',
      JSON.stringify(r.body && r.body.divisions && r.body.divisions.map(d => d.key)));
    const turf = r.body.divisions.find(d => d.key === 'turf');
    assert('…Turf offers its five reports', turf && turf.reports.length === 5, turf && turf.reports.map(x => x.type).join(','));
    assert('…and the saved groups to send to', r.body.groups.length === 2 && r.body.groups.every(g => g.count === 2));
    r = await call('GET', {}, null, PAV);
    assert('a Paving admin sees Paving only', JSON.stringify(r.body.divisions.map(d => d.key)) === '["paving"]');
  }

  console.log('\nPayroll: approvers only');
  {
    const payId   = await mkUser('payroller', { payroll: 'admin' });
    const coderId = await mkUser('coder',     { payroll: 'level2', turf: 'admin' });
    const PAYR  = { companyCode: CO, userId: payId,   username: 'payroller', role: 'level1', divisionRoles: { payroll: 'admin' } };
    const CODER = { companyCode: CO, userId: coderId, username: 'coder',     role: 'level1', divisionRoles: { payroll: 'level2', turf: 'admin' } };
    let r = await call('GET', {}, null, PAYR);
    const pay = r.body.divisions && r.body.divisions.find(d => d.key === 'payroll');
    assert('a payroll approver gets the Payroll card with its three reports',
      pay && JSON.stringify(pay.reports.map(x => x.type)) === '["payroll_hours","payroll_projects","payroll_overtime"]',
      JSON.stringify(r.body.divisions && r.body.divisions.map(d => d.key)));
    assert('…and the pay ranges by their button names', r.body.payRanges && r.body.payRanges.last_biweekly === 'Last pay cycle');
    r = await call('GET', {}, null, CODER);
    assert('a payroll coder does not', !r.body.divisions.some(d => d.key === 'payroll'), JSON.stringify(r.body.divisions.map(d => d.key)));
    const body = { report_type: 'payroll_hours', frequency: 'weekly', days_of_week: [1], send_time: '07:00', group_ids: [g1], options: { range: 'last_biweekly' } };
    r = await call('POST', {}, body, CODER);
    assert('…and cannot schedule one', r.statusCode === 403, `${r.statusCode} ${JSON.stringify(r.body)}`);
    r = await emailNow('payroll_hours', CODER);
    assert('…nor email one by hand', r.statusCode === 403, `${r.statusCode} ${JSON.stringify(r.body)}`);
    r = await call('POST', {}, body, PAYR);
    assert('an approver can, and the pay range is kept', r.statusCode === 200 && r.body.schedule.options.range === 'last_biweekly', JSON.stringify(r.body));
    const pid = r.body.schedule.id;
    r = await call('POST', {}, { ...body, options: { range: 'last_month' } }, PAYR);
    assert('a range that is not one of the page\'s falls back to last week', r.body.schedule && r.body.schedule.options.range === 'last_week', JSON.stringify(r.body));
    await call('DELETE', { id: r.body.schedule.id }, null, PAYR);
    const sched = await row(pid);
    await client.query("UPDATE users SET division_roles = $1 WHERE id = $2", [JSON.stringify({ payroll: 'level2' }), payId]);
    const res = await runner.runSchedule(sql, sched, { now: new Date() });
    assert('the run stops if its owner is made a coder since, saying why',
      res.status === 'failed' && /payroller is no longer a payroll approver/.test(res.message), res.message);
    await client.query('DELETE FROM report_schedules WHERE id = $1', [pid]);
  }

  console.log('\nSafety Center: supervisors only');
  {
    const supId  = await mkUser('safetysup',  { safety: 'level3', turf: 'admin' });
    const crewId = await mkUser('safetycrew', { safety: 'level1', turf: 'admin' });
    const SUP  = { companyCode: CO, userId: supId,  username: 'safetysup',  role: 'level1', divisionRoles: { safety: 'level3', turf: 'admin' } };
    const CREW = { companyCode: CO, userId: crewId, username: 'safetycrew', role: 'level1', divisionRoles: { safety: 'level1', turf: 'admin' } };
    let r = await call('GET', {}, null, SUP);
    const saf = r.body.divisions && r.body.divisions.find(d => d.key === 'safety');
    const rep = saf && saf.reports[0];
    assert('a safety supervisor gets the Safety Center card with the sign-off report',
      saf && saf.name === 'Safety Center' && saf.reports.length === 1 && rep.type === 'safety_signoff' && rep.scope === 'division',
      JSON.stringify(r.body.divisions && r.body.divisions.map(d => d.key)));
    assert('…offering whole-week periods only, last week first',
      rep && rep.period === 'prev_week' && JSON.stringify(rep.periods) === '["prev_week","week_to_date","month_to_date","prev_month"]'
        && /filed by week/.test(rep.periodHint || ''), JSON.stringify(rep));
    r = await call('GET', {}, null, CREW);
    assert('crew, who hold the division only to sign, do not', !r.body.divisions.some(d => d.key === 'safety'),
      JSON.stringify(r.body.divisions.map(d => d.key)));
    r = await call('GET', {}, null, { ...BOSS, isPlatformAdmin: true });
    assert('a platform admin with no safety role of their own does, as on the Safety page',
      r.body.divisions.some(d => d.key === 'safety'), JSON.stringify(r.body.divisions.map(d => d.key)));
    r = await call('GET', {}, null, { ...CREW, isPlatformAdmin: true });
    assert('…but not one whose own safety role is crew', !r.body.divisions.some(d => d.key === 'safety'),
      JSON.stringify(r.body.divisions.map(d => d.key)));

    const body = { report_type: 'safety_signoff', frequency: 'weekly', days_of_week: [1], send_time: '07:00', group_ids: [g1],
      options: { period: 'month_to_date' } };
    r = await call('POST', {}, body, CREW);
    assert('crew cannot schedule it', r.statusCode === 403, `${r.statusCode} ${JSON.stringify(r.body)}`);
    r = await emailNow('safety_signoff', CREW);
    assert('…nor email one by hand under its name', r.statusCode === 403, `${r.statusCode} ${JSON.stringify(r.body)}`);
    r = await emailNow('safety_signoff', SUP);
    assert('…which a supervisor gets past (to the next check: no recipients)', r.statusCode === 400 && /recipient/.test(r.body.error),
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    r = await call('POST', {}, body, SUP);
    assert('a supervisor can, and the period is kept',
      r.statusCode === 200 && r.body.schedule.division === 'safety' && r.body.schedule.options.period === 'month_to_date'
        && r.body.schedule.project_id === null, JSON.stringify(r.body));
    const sid = r.body.schedule.id;
    r = await call('POST', {}, { ...body, options: { period: 'prev_day' } }, SUP);
    assert('a period it does not offer falls back to last week', r.body.schedule && r.body.schedule.options.period === 'prev_week',
      JSON.stringify(r.body));
    await call('DELETE', { id: r.body.schedule.id }, null, SUP);
    const sched = await row(sid);
    const spec = runner.specFor({ ...sched, options: { period: 'prev_day' } }, require(path.join(ROOT, 'api/lib/report-catalog.js')).SCHEDULABLE.safety_signoff,
      new Date('2026-10-07T15:00:00Z'));
    assert('…and so does the run, for one saved before the list was narrowed',
      spec.start === '2026-09-28' && spec.end === '2026-10-04', JSON.stringify(spec));
    await client.query("UPDATE users SET division_roles = $1 WHERE id = $2", [JSON.stringify({ safety: 'level1', turf: 'admin' }), supId]);
    const res = await runner.runSchedule(sql, sched, { now: new Date() });
    assert('the run stops if its owner is moved to crew since, saying why',
      res.status === 'failed' && /safetysup is no longer a Safety Center supervisor/.test(res.message), res.message);
    await client.query('DELETE FROM report_schedules WHERE id = $1', [sid]);
  }

  console.log('\nExecutive: picking its divisions');
  {
    const exId = await mkUser('execboss', { executive: 'admin' });
    const EXEC = { companyCode: CO, userId: exId, username: 'execboss', role: 'level1', divisionRoles: { executive: 'admin' } };
    let r = await call('GET', {}, null, EXEC);
    const exDiv = r.body.divisions && r.body.divisions.find(d => d.key === 'executive');
    const exRep = exDiv && exDiv.reports.find(x => x.type === 'executive');
    assert('the Executive Report offers its divisions to pick, in the order it reads them',
      exRep && JSON.stringify((exRep.sections || []).map(x => x.key))
        === '["turf","paving","kiewit","quarry","dust","trucking","intercompany","payroll","safety"]'
        && exRep.sections[0].name === 'Turf Management', JSON.stringify(exRep));
    const body = { report_type: 'executive', frequency: 'weekly', days_of_week: [1], send_time: '07:00', group_ids: [g1] };
    r = await call('POST', {}, { ...body, options: { sections: ['payroll', 'turf', 'turf'] } }, EXEC);
    assert('the divisions picked are kept, once each, in the report\'s order',
      r.statusCode === 200 && JSON.stringify(r.body.schedule.options.sections) === '["turf","payroll"]', JSON.stringify(r.body));
    const sid = r.body.schedule.id;
    const spec = runner.specFor(await row(sid), require(path.join(ROOT, 'api/lib/report-catalog.js')).SCHEDULABLE.executive, new Date());
    assert('…and the run hands them to the page', JSON.stringify(spec.options.sections) === '["turf","payroll"]', JSON.stringify(spec));
    r = await call('PUT', { id: sid }, { ...body, options: { sections: ['turf', 'payrol'] } }, EXEC);
    assert('a division the report does not have is refused, not dropped',
      r.statusCode === 400 && /Pick divisions from the list/.test(r.body.error)
        && JSON.stringify((await row(sid)).options.sections) === '["turf","payroll"]', JSON.stringify(r.body));
    r = await call('PUT', { id: sid }, { ...body, options: { sections: [] } }, EXEC);
    assert('none picked is the whole report',
      r.statusCode === 200 && !('sections' in r.body.schedule.options), JSON.stringify(r.body));
    const whole = runner.specFor(await row(sid), require(path.join(ROOT, 'api/lib/report-catalog.js')).SCHEDULABLE.executive, new Date());
    assert('…which the run hands over as nothing picked', whole.options.sections === null, JSON.stringify(whole.options));
    await client.query('DELETE FROM report_schedules WHERE id = $1', [sid]);
  }

  console.log('\nThe job picker');
  {
    const r = await call('GET', { projects: 'turf' }, null, BOSS);
    assert('lists the division\'s jobs with their status',
      r.statusCode === 200 && r.body.projects.length === 2
        && r.body.projects.find(p => p.id === 'j1').status === 'In Progress', JSON.stringify(r.body));
    const r2 = await call('GET', { projects: 'turf' }, null, PAV);
    assert('…and not to an admin of another division', r2.statusCode === 403);
  }

  let id;
  console.log('\nSetting one up');
  {
    const bad = async (label, body, auth, status) => {
      const r = await call('POST', {}, body, auth || BOSS);
      assert(label, r.statusCode === (status || 400), `${r.statusCode} ${JSON.stringify(r.body)}`);
    };
    await bad('no report is refused', { ...base, report_type: 'nope' });
    await bad('a job report with no job is refused', { ...base, project_id: '' });
    await bad('no recipient group is refused', { ...base, group_ids: [] });
    await bad('a group that does not exist is refused', { ...base, group_ids: [g1, 999999] });
    await bad('weekly with no day picked is refused', { ...base, frequency: 'weekly', days_of_week: [] });
    await bad('a time that is not a time is refused', { ...base, send_time: '25:00' });
    await bad('a division the admin cannot open is refused', base, PAV, 403);

    const before = new Date();
    const r = await call('POST', {}, base, BOSS);
    assert('a good one is saved', r.statusCode === 200 && r.body.ok, JSON.stringify(r.body));
    id = r.body.schedule.id;
    const s = await row(id);
    const want = T.nextRunAt({ frequency: 'weekdays', send_time: '06:30', timezone: 'America/New_York' }, before);
    assert('…its next send is the next weekday at 6:30 Eastern',
      Math.abs(new Date(s.next_run_at) - want) < 1000, `${new Date(s.next_run_at).toISOString()} vs ${want.toISOString()}`);
    assert('…it runs as the admin who saved it', s.run_as_user_id === bossId && s.run_as_username === 'boss');
    assert('…the Daily PM keeps no period it has no use for', JSON.stringify(s.options) === '{}', JSON.stringify(s.options));

    const ds = await call('POST', {}, { ...base, report_type: 'turf_daily_summary', project_id: '' }, BOSS);
    assert('a Daily Summary with no job is every job, with the default period',
      ds.statusCode === 200 && ds.body.schedule.project_id === null && ds.body.schedule.options.period === 'prev_workday',
      JSON.stringify(ds.body));
    await call('DELETE', { id: ds.body.schedule.id }, null, BOSS);
  }

  console.log('\nSwitching it off and on, and editing');
  {
    let r = await call('PUT', { id }, { enabled: false }, BOSS);
    let s = await row(id);
    assert('off: no next send', r.statusCode === 200 && s.enabled === false && s.next_run_at === null);
    r = await call('PUT', { id }, { enabled: true }, BOSS);
    s = await row(id);
    assert('on: the next send is from now, not a catch-up', s.enabled === true && new Date(s.next_run_at) > new Date());

    r = await call('PUT', { id }, { ...base, group_ids: [g1, g2], frequency: 'weekly', days_of_week: [1, 3], send_time: '07:15' }, BOSS);
    s = await row(id);
    assert('an edit is saved and retimed',
      r.statusCode === 200 && s.frequency === 'weekly' && JSON.stringify(s.days_of_week) === '[1,3]' && s.send_time === '07:15'
        && [1, 3].includes(new Date(s.next_run_at).getUTCDay()), JSON.stringify(r.body));

    r = await call('PUT', { id }, base, PAV);
    assert('an admin of another division cannot edit it', r.statusCode === 403);
    r = await call('GET', {}, null, PAV);
    assert('…or see it', r.body.schedules.length === 0);
  }

  console.log('\nThe account it runs as, checked at every send');
  {
    const sched = await row(id);
    let res = await runner.runSchedule(sql, { ...sched, run_as_user_id: 9999999, run_as_username: 'gone' }, { now: new Date() });
    assert('a deleted account stops it, saying so',
      res.status === 'failed' && /gone.*no longer exists.*save it/i.test(res.message), res.message);

    res = await runner.runSchedule(sql, { ...sched, run_as_user_id: pavId, run_as_username: 'pavadmin' }, { now: new Date() });
    assert('an account without the division stops it, saying so',
      res.status === 'failed' && /pavadmin no longer has access to Turf Management/.test(res.message), res.message);

    res = await runner.runSchedule(sql, { ...sched, group_ids: [999998] }, { now: new Date() });
    assert('a deleted recipient group stops it, saying so', res.status === 'failed' && /group was deleted/i.test(res.message), res.message);

    const r = await runner.recipientsFor(sql, CO, [g1, g2]);
    assert('the groups\' addresses are folded into one list, case-insensitively',
      JSON.stringify(r.emails.slice().sort()) === JSON.stringify(['office@example.com', 'pm1@example.com', 'pm2@example.com']),
      JSON.stringify(r.emails));
    assert('…with nothing left off', Array.isArray(r.invalid) && r.invalid.length === 0, JSON.stringify(r.invalid));

    // Saved before the check was strict: an address the mail service refuses,
    // which would stop the email going to anybody on it.
    const gBad = await grp('Safety Report Group', ['bhudock@example.com', 'abotsford@forcecorporation..com', 'Abotsford@ForceCorporation..com']);
    const rb = await runner.recipientsFor(sql, CO, [gBad, g2]);
    assert('an address the mail service would refuse is kept off the list',
      JSON.stringify(rb.emails) === '["bhudock@example.com","office@example.com","pm1@example.com"]', JSON.stringify(rb.emails));
    assert('…and handed back once, with its group, to be named',
      JSON.stringify(rb.invalid) === '[{"email":"abotsford@forcecorporation..com","group":"Safety Report Group"}]', JSON.stringify(rb.invalid));
    const gAllBad = await grp('Typos', ['abotsford@forcecorporation..com', 'pm.@example.com']);
    res = await runner.runSchedule(sql, { ...sched, group_ids: [gAllBad] }, { now: new Date() });
    assert('a group with no address left to send to fails, naming each one and the fix',
      res.status === 'failed' && res.message === 'Nobody to send to. Left off abotsford@forcecorporation..com (Typos), pm.@example.com (Typos) '
        + '— not valid email addresses; fix them with Edit on the group.', res.message);
    await client.query('DELETE FROM report_recipient_groups WHERE id = ANY($1)', [[gBad, gAllBad]]);
  }

  console.log('\nSend now');
  {
    const realRun = runner.runSchedule;
    let ranWith = null;
    runner.runSchedule = async (s, sched, ctx) => { ranWith = { sched, ctx }; return { status: 'sent', sent: 1, total: 1, recipientCount: 3, message: 'Sent to 3 recipients.' }; };
    const before = await row(id);
    const r = await call('POST', { id, action: 'run' }, {}, BOSS);
    runner.runSchedule = realRun;
    const after = await row(id);
    assert('runs the schedule and answers with how it went',
      r.statusCode === 200 && r.body.result.status === 'sent' && ranWith && ranWith.sched.id == id, JSON.stringify(r.body));
    assert('…on the request\'s host only when the deployment has no address of its own (a laptop)',
      ranWith && ranWith.ctx.baseUrl === 'https://datawatch.test', ranWith && ranWith.ctx.baseUrl);
    assert('…and with a deadline inside the function\'s limit', ranWith && ranWith.ctx.deadline > Date.now() && ranWith.ctx.deadline < Date.now() + 300000);
    assert('…records it', after.last_status === 'sent' && (await runsFor(id)).slice(-1)[0].run_kind === 'manual');
    assert('…and leaves the timetable alone', String(after.next_run_at) === String(before.next_run_at));
    const r2 = await call('POST', { id, action: 'run' }, {}, PAV);
    assert('an admin of another division cannot send it', r2.statusCode === 403);
  }

  console.log('\nWhere the robot goes');
  {
    const env = { ...process.env };
    const spoof = { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } };
    Object.assign(process.env, { VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'datawatch.forcecorp.com', VERCEL_URL: 'dw-abc123.vercel.app' });
    delete process.env.APP_BASE_URL;
    assert('in production, the production domain — whatever Host the request claims',
      runner.appBaseUrl(spoof) === 'https://datawatch.forcecorp.com', runner.appBaseUrl(spoof));
    process.env.VERCEL_ENV = 'preview';
    assert('on a preview, that deployment\'s own URL', runner.appBaseUrl(spoof) === 'https://dw-abc123.vercel.app', runner.appBaseUrl(spoof));
    process.env.APP_BASE_URL = 'https://reports.forcecorp.com/';
    assert('APP_BASE_URL over both', runner.appBaseUrl(spoof) === 'https://reports.forcecorp.com', runner.appBaseUrl(spoof));
    for (const k of ['VERCEL_ENV', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL', 'APP_BASE_URL']) {
      if (k in env) process.env[k] = env[k]; else delete process.env[k];
    }
  }

  console.log('\nThe cron');
  {
    const realRun = runner.runSchedule;
    const sentIds = [];
    const ctxs = {};
    runner.runSchedule = async (s, sched, ctx) => {
      sentIds.push(Number(sched.id));
      ctxs[Number(sched.id)] = ctx;
      await new Promise(r => setTimeout(r, 50));
      return { status: 'sent', sent: 1, total: 1, recipientCount: 2, message: 'Sent to 2 recipients.' };
    };
    const noBrowser = { launchBrowser: async () => ({ close: async () => {} }) };

    const mk = async (over) => (await call('POST', {}, { ...base, ...over }, BOSS)).body.schedule.id;
    const due1 = await mk({});
    const due2 = await mk({ project_id: '*' });
    const later = await mk({});
    const off   = await mk({ enabled: false });
    await client.query("UPDATE report_schedules SET next_run_at = NOW() - interval '2 minutes' WHERE id = ANY($1)", [[due1, due2]]);
    await client.query("UPDATE report_schedules SET next_run_at = NOW() + interval '1 hour' WHERE id = $1", [later]);
    await client.query("UPDATE report_schedules SET next_run_at = NOW() - interval '2 minutes' WHERE id = $1", [id]);
    await client.query("UPDATE report_schedules SET claimed_at = NOW() - interval '1 minute' WHERE id = $1", [id]);   // another run has it

    // Two runs at once, on two connections.
    const c2 = new Client({ connectionString: URL }); await c2.connect();
    const [a, b] = await Promise.all([
      cron.runDueSchedules(sql, noBrowser),
      cron.runDueSchedules(makeSql(c2), noBrowser),
    ]);
    await c2.end();
    const counts = {};
    sentIds.forEach(x => { counts[x] = (counts[x] || 0) + 1; });
    assert('two overlapping runs send each due report exactly once',
      counts[due1] === 1 && counts[due2] === 1, JSON.stringify(counts));
    assert('…and nothing that was not due, switched off, or claimed by a live run',
      !counts[later] && !counts[off] && !counts[id], JSON.stringify(counts));
    assert('…between them they claimed two', a.claimed + b.claimed === 2, `${a.claimed} + ${b.claimed}`);
    const c1 = ctxs[Number(due1)] || {};
    assert('a run\'s dates are worked from when it was due, not when the server got to it',
      c1.occurrence instanceof Date && Math.abs(Date.now() - 120000 - c1.occurrence.getTime()) < 15000, String(c1.occurrence));
    assert('…and it checks the schedule is still wanted before it sends', typeof c1.stillWanted === 'function');

    const s1 = await row(due1);
    assert('a sent schedule moves to its next time and lets go of its claim',
      s1.claimed_at === null && new Date(s1.next_run_at) > new Date() && s1.last_status === 'sent');
    assert('…and the run is in the history as a scheduled one', (await runsFor(due1)).slice(-1)[0].run_kind === 'schedule');

    await client.query("UPDATE report_schedules SET claimed_at = NOW() - interval '20 minutes' WHERE id = $1", [id]);
    sentIds.length = 0;
    await cron.runDueSchedules(sql, noBrowser);
    assert('a claim left by a run that died is picked up', sentIds.includes(Number(id)), JSON.stringify(sentIds));

    await client.query("UPDATE report_schedules SET next_run_at = NOW() - interval '13 hours', claimed_at = NULL WHERE id = $1", [due1]);
    sentIds.length = 0;
    const m = await cron.runDueSchedules(sql, noBrowser);
    const s = await row(due1);
    assert('thirteen hours late is missed, not sent',
      !sentIds.includes(due1) && m.missed === 1 && s.last_status === 'missed' && /more than 12 hours late/.test(s.last_message),
      `${JSON.stringify(m)} ${s.last_message}`);
    assert('…and it is back on its timetable', new Date(s.next_run_at) > new Date());

    runner.runSchedule = realRun;
  }

  console.log('\nCut off, edited, doubled — what the review found');
  {
    const realRun = runner.runSchedule;
    const noBrowser = { launchBrowser: async () => ({ close: async () => {} }) };
    const mk = async over => (await call('POST', {}, { ...base, ...over }, BOSS)).body.schedule.id;
    const due = id => client.query("UPDATE report_schedules SET next_run_at = NOW() - interval '1 minute', claimed_at = NULL WHERE id = $1", [id]);
    const sentOk = { status: 'sent', sent: 1, total: 1, recipientCount: 2, message: 'Sent to 2 recipients.' };

    // A run that dies between its first email and its last.
    const k = await mk({});
    await due(k);
    const tk = runner.newClaimToken();
    const claimed = await runner.claimNextDue(sql, tk);
    await runner.beginRun(sql, claimed, tk, { kind: 'schedule', now: new Date() });
    let after = await row(k);
    assert('the timetable moves on before anything is sent',
      claimed && Number(claimed.id) === Number(k) && new Date(after.next_run_at) > new Date() && after.last_status === 'sending',
      JSON.stringify({ claimed: claimed && claimed.id, next: after.next_run_at, st: after.last_status }));
    await client.query("UPDATE report_schedules SET claimed_at = NOW() - interval '20 minutes' WHERE id = $1", [k]);
    let calls = 0;
    runner.runSchedule = async () => { calls++; return sentOk; };
    await cron.runDueSchedules(sql, noBrowser);
    assert('so a run killed partway is not sent again in full fifteen minutes later', calls === 0, `${calls} run(s)`);
    let g = await call('GET', {}, null, BOSS);
    let shown = g.body.schedules.find(x => Number(x.id) === Number(k));
    assert('…it reads Interrupted, not Sending…, and Send now is free',
      shown.last_status === 'interrupted' && shown.sending === false && /cut off/.test(shown.last_message), JSON.stringify(shown));

    // An edit saved while it runs is the timetable that stands.
    const e = await mk({});
    await due(e);
    const te = runner.newClaimToken();
    const ce = await runner.claimNextDue(sql, te);
    await runner.beginRun(sql, ce, te, { kind: 'schedule', now: new Date() });
    const put = await call('PUT', { id: e }, { ...base, frequency: 'weekly', days_of_week: [1], send_time: '14:00' }, BOSS);
    await runner.recordRun(sql, ce, sentOk, { kind: 'schedule', token: te, startedAt: new Date(), now: new Date() });
    after = await row(e);
    assert('an edit saved mid-run is not overwritten by the old timetable when the run ends',
      after.frequency === 'weekly' && new Date(after.next_run_at).getTime() === new Date(put.body.schedule.next_run_at).getTime()
        && after.claimed_at === null && after.last_status === 'sent',
      JSON.stringify({ next: after.next_run_at, put: put.body.schedule.next_run_at, claimed: after.claimed_at }));

    // Switched off, changed or deleted while it is being built: nothing more goes.
    const w = await mk({});
    let snap = await row(w);
    await call('PUT', { id: w }, { enabled: false }, BOSS);
    assert('switched off mid-run: the run is told to stop', /switched off/.test(await runner.stillWanted(sql, snap) || ''));
    await call('PUT', { id: w }, { enabled: true }, BOSS);
    snap = await row(w);
    await new Promise(r => setTimeout(r, 20));
    await call('PUT', { id: w }, { ...base, subject: 'New subject' }, BOSS);
    assert('changed mid-run: told to stop, the next run uses the change', /changed/.test(await runner.stillWanted(sql, snap) || ''));
    snap = await row(w);
    assert('unchanged: carries on', (await runner.stillWanted(sql, snap)) === null);
    await client.query('DELETE FROM report_schedules WHERE id = $1', [w]);
    assert('deleted mid-run: told to stop', /deleted/.test(await runner.stillWanted(sql, snap) || ''));

    // Send now twice while the first is still going.
    const d2 = await mk({});
    runner.runSchedule = async () => { await new Promise(r => setTimeout(r, 400)); return sentOk; };
    const [r1, r2] = await Promise.all([
      call('POST', { id: d2, action: 'run' }, {}, BOSS),
      new Promise(r => setTimeout(r, 80)).then(() => call('POST', { id: d2, action: 'run' }, {}, BOSS)),
    ]);
    assert('a second Send now while the first is going is refused, not sent twice',
      r1.statusCode === 200 && r2.statusCode === 409 && /being sent right now/.test(r2.body.error), `${r1.statusCode} ${r2.statusCode}`);
    after = await row(d2);
    assert('…and the claim is let go when the first finishes', after.claimed_at === null && after.claim_token === null);

    // Saving a schedule that shows Due now.
    const dn = await mk({});
    await due(dn);
    const dueAt = (await row(dn)).next_run_at;
    await call('PUT', { id: dn }, { ...base, subject: 'Typo fixed' }, BOSS);
    assert('fixing a subject while it is Due now keeps today\'s send', new Date((await row(dn)).next_run_at).getTime() === new Date(dueAt).getTime());
    await call('PUT', { id: dn }, { ...base, send_time: '17:00' }, BOSS);
    assert('…retiming it does move it on', new Date((await row(dn)).next_run_at) > new Date());

    // The history says what was sent, not what the schedule says now.
    await call('PUT', { id: e }, { ...base, project_id: 'j2', project_name: 'Oak St' }, BOSS);
    g = await call('GET', {}, null, BOSS);
    const eRuns = g.body.runs.filter(r => Number(r.schedule_id) === Number(e));
    assert('a past send keeps the job it was for after the schedule moves to another',
      eRuns.length === 1 && eRuns[0].project_name === 'Maple Ave' && eRuns[0].division === 'turf', JSON.stringify(eRuns));

    // A quiet division's sends are not pushed out by a busy one's.
    const dustId = await mk({ report_type: 'dust_tracking_summary', project_id: '' });
    await client.query(`INSERT INTO report_schedule_runs (schedule_id, company_code, run_kind, status, started_at, report_type, division)
                        VALUES ($1, $2, 'schedule', 'sent', NOW() - interval '6 days', 'dust_tracking_summary', 'dust')`, [dustId, CO]);
    for (let i = 0; i < 45; i++) {
      await client.query(`INSERT INTO report_schedule_runs (schedule_id, company_code, run_kind, status, started_at, report_type, division)
                          VALUES ($1, $2, 'schedule', 'sent', NOW() - ($3 || ' minutes')::interval, 'turf_daily_pm', 'turf')`, [e, CO, String(i)]);
    }
    g = await call('GET', {}, null, BOSS);
    assert('a weekly dust send is still in the history under 45 newer turf ones',
      g.body.runs.some(r => r.division === 'dust'), `${g.body.runs.length} runs, divisions ${[...new Set(g.body.runs.map(r => r.division))]}`);

    // More addresses than one email can carry.
    const many = n => Array.from({ length: n }, (_, i) => `crew${n}-${i}@example.com`);
    const ga = (await client.query("INSERT INTO report_recipient_groups (company_code, name, emails) VALUES ($1, 'Field', $2) RETURNING id", [CO, JSON.stringify(many(40))])).rows[0].id;
    const gb = (await client.query("INSERT INTO report_recipient_groups (company_code, name, emails) VALUES ($1, 'Office', $2) RETURNING id", [CO, JSON.stringify(many(41))])).rows[0].id;
    const rec = await runner.recipientsFor(sql, CO, [gb, ga]);
    assert('groups past fifty addresses keep every address, in the order the groups were picked',
      rec.emails.length === 81 && rec.emails[0] === 'crew41-0@example.com', `${rec.emails.length} ${rec.emails[0]}`);

    runner.runSchedule = realRun;
  }

  console.log('\nThe rest of a run, handed to the next pass');
  {
    const realRun = runner.runSchedule;
    const realBegin = runner.beginRun;
    const noBrowser = { launchBrowser: async () => ({ close: async () => {} }) };
    const mk = async over => (await call('POST', {}, { ...base, ...over }, BOSS)).body.schedule.id;
    const due = id => client.query("UPDATE report_schedules SET next_run_at = NOW() - interval '1 minute', claimed_at = NULL, claim_token = NULL WHERE id = $1", [id]);
    const sentOk = { status: 'sent', sent: 1, total: 1, recipientCount: 2, message: 'Sent to 2 recipients.' };
    // Claim one schedule by id, the way claimNextDue claims (its reading of updated_at included).
    const claim = async id => {
      const tok = runner.newClaimToken();
      const r = await client.query(
        `UPDATE report_schedules SET claimed_at = NOW(), claim_token = $2 WHERE id = $1
          RETURNING *, extract(epoch FROM updated_at)::text AS updated_epoch`, [id, tok]);
      return { sched: r.rows[0], tok };
    };
    // Other due schedules from the sections above are sent and forgotten.
    const quietOthers = () => client.query(
      "UPDATE report_schedules SET next_run_at = NOW() + interval '1 day' WHERE company_code = $1 AND next_run_at <= NOW()", [CO]);

    // Fifteen Daily PMs where the time allows eleven.
    const h = await mk({ project_id: '*' });
    await quietOthers();
    await due(h);
    const dueAt = new Date((await row(h)).next_run_at);
    const seen = [];
    runner.runSchedule = async (s, sched, ctx) => {
      if (Number(sched.id) !== Number(h)) return sentOk;
      seen.push({ resume: ctx.resume, occurrence: ctx.occurrence });
      if (seen.length === 1) {
        const ok = await ctx.handBack({ state: { done: ['j1'], sent: 1, attempted: 1, problems: [], passes: 1 }, progress: true });
        return ok
          ? { status: 'continuing', sent: 1, total: 1, recipientCount: 2, message: 'Sent 1 report to 2 recipients so far. 1 more job goes out at the next pass, in a few minutes.' }
          : { status: 'partial', sent: 1, total: 1, recipientCount: 2, message: 'not handed back' };
      }
      return { status: 'sent', sent: 1, total: 1, recipientCount: 2, message: 'Sent 2 reports to 2 recipients (over 2 runs).' };
    };
    let out = await cron.runDueSchedules(sql, noBrowser);
    let s = await row(h);
    assert('a run that runs out of time hands the rest back: due again at once, for the same occurrence',
      s.last_status === 'continuing' && new Date(s.next_run_at).getTime() === dueAt.getTime() && s.claimed_at === null,
      JSON.stringify({ st: s.last_status, next: s.next_run_at, due: dueAt, claimed: s.claimed_at }));
    assert('…with what it already sent written down', s.resume_state && JSON.stringify(s.resume_state.done) === '["j1"]' && s.resume_count === 1,
      JSON.stringify({ state: s.resume_state, n: s.resume_count }));
    assert('…and the same pass does not take it again', seen.length === 1 && out.continuing === 1, JSON.stringify({ seen: seen.length, out }));
    out = await cron.runDueSchedules(sql, noBrowser);
    s = await row(h);
    assert('the next pass continues it — the same occurrence, told what was sent',
      seen.length === 2 && seen[1].occurrence.getTime() === dueAt.getTime() && seen[1].resume && JSON.stringify(seen[1].resume.done) === '["j1"]',
      JSON.stringify(seen[1]));
    assert('…and once it is finished: on to its next time, nothing carried over',
      s.last_status === 'sent' && new Date(s.next_run_at) > new Date() && s.resume_state === null && s.resume_count === 0,
      JSON.stringify({ st: s.last_status, next: s.next_run_at, state: s.resume_state, n: s.resume_count }));
    assert('both passes are in the history', (await runsFor(h)).map(r => r.status).join(',') === 'continuing,sent',
      (await runsFor(h)).map(r => r.status).join(','));
    runner.runSchedule = realRun;

    // What decides whether the rest is wanted.
    const occ = new Date(Date.now() - 60000);
    const state = { done: ['j1'], sent: 1, attempted: 1, problems: [], passes: 1 };
    let x = await mk({ project_id: '*' });
    let c = await claim(x);
    await new Promise(r => setTimeout(r, 15));
    await call('PUT', { id: x }, { ...base, project_id: '*', subject: 'Typo fixed' }, BOSS);
    assert('saved mid-send with the same timetable: the rest goes at the next pass, with the new settings',
      await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state, progress: true }) === true
        && new Date((await row(x)).next_run_at).getTime() === occ.getTime());
    c = await claim(x);
    await call('PUT', { id: x }, { ...base, project_id: '*', send_time: '15:00' }, BOSS);
    const retimedNext = (await row(x)).next_run_at;
    assert('retimed mid-send: nothing handed back, the new timetable stands',
      await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state, progress: true }) === false
        && new Date((await row(x)).next_run_at).getTime() === new Date(retimedNext).getTime());
    c = await claim(x);
    await call('PUT', { id: x }, { enabled: false }, BOSS);
    assert('switched off mid-send: nothing handed back', await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state, progress: true }) === false
      && (await row(x)).next_run_at === null);
    await call('PUT', { id: x }, { enabled: true }, BOSS);
    c = await claim(x);
    await call('PUT', { id: x }, { ...base, project_id: '', report_type: 'turf_daily_summary', send_time: c.sched.send_time }, BOSS);
    assert('another report since: handed back, but started over rather than skipping jobs',
      await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state, progress: true }) === true && (await row(x)).resume_state === null);
    c = await claim(x);
    assert(`no more than ${runner.MAX_PASSES} passes at one occurrence`,
      await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state: { ...state, passes: runner.MAX_PASSES } }) === false
        && await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state: { ...state, passes: runner.MAX_PASSES - 1 } }) === true);
    assert(`…and no more than ${runner.MAX_IDLE_PASSES} hand-backs from passes that got nothing done — counted on their own`,
      await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state: { ...state, passes: 3, idle: runner.MAX_IDLE_PASSES + 1 } }) === false
        && await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state: { ...state, passes: 5, idle: runner.MAX_IDLE_PASSES } }) === true);
    assert('…and the row says how many passes the occurrence has had', (await row(x)).resume_count === 5);
    assert('a claim that is not this run\'s hands nothing back',
      await runner.handBack(sql, c.sched, 'someone-else', { occurrence: occ, state }) === false);
    await client.query('DELETE FROM report_schedules WHERE id = $1', [x]);
    assert('deleted mid-send: nothing handed back', await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state, progress: true }) === false);

    // Saved between the claim and the start.
    const b = await mk({});
    await quietOthers();
    await due(b);
    const before = (await row(b)).next_run_at;
    let ran = 0;
    runner.runSchedule = async (s2, sched) => { if (Number(sched.id) === Number(b)) ran++; return sentOk; };
    runner.beginRun = async (...a) => {
      if (Number(a[1].id) === Number(b) && !ran) await call('PUT', { id: b }, { ...base, subject: 'Saved just now' }, BOSS);
      return realBegin(...a);
    };
    out = await cron.runDueSchedules(sql, noBrowser);
    runner.beginRun = realBegin;
    s = await row(b);
    assert('a schedule saved between its claim and its start is not run on the old copy, nor its new timetable overwritten',
      ran === 0 && s.claimed_at === null && s.claim_token === null && s.last_status !== 'sending'
        && new Date(s.next_run_at).getTime() === new Date(before).getTime(),
      JSON.stringify({ ran, claimed: s.claimed_at, st: s.last_status, next: s.next_run_at, before }));
    await cron.runDueSchedules(sql, noBrowser);
    assert('…the next pass sends it as saved', ran === 1 && (await row(b)).last_status === 'sent');
    runner.runSchedule = realRun;

    // Send now that cannot start.
    const sn = await mk({});
    runner.beginRun = async () => { throw new Error('connection reset'); };
    let r = await call('POST', { id: sn, action: 'run' }, {}, BOSS);
    runner.beginRun = realBegin;
    s = await row(sn);
    assert('a Send now that cannot start says so and lets go of its claim',
      r.statusCode === 500 && /Could not start it/.test(r.body.error) && s.claim_token === null && s.claimed_at === null,
      `${r.statusCode} ${JSON.stringify(r.body)} ${s.claim_token}`);
    runner.runSchedule = async () => sentOk;
    r = await call('POST', { id: sn, action: 'run' }, {}, BOSS);
    assert('…so pressing it again works, not "being sent right now"', r.statusCode === 200 && r.body.result.status === 'sent');
    runner.runSchedule = realRun;

    // Carried state and the editor.
    const cs = await mk({ project_id: '*' });
    await due(cs);
    await client.query(`UPDATE report_schedules SET resume_state = '{"done":["j1"],"sent":1}'::jsonb, resume_count = 1 WHERE id = $1`, [cs]);
    await call('PUT', { id: cs }, { ...base, project_id: '*', subject: 'Fixed' }, BOSS);
    s = await row(cs);
    assert('saving a schedule mid-continuation, same timetable: what was sent is kept',
      s.resume_state && JSON.stringify(s.resume_state.done) === '["j1"]' && s.resume_count === 1);
    await runner.recordRun(sql, s, sentOk, { kind: 'manual', token: null, triggeredBy: 'boss', startedAt: new Date(), now: new Date() });
    assert('…a Send now in between leaves it alone', (await row(cs)).resume_count === 1);
    await call('PUT', { id: cs }, { ...base, project_id: '*', report_type: 'turf_bid_items' }, BOSS);
    s = await row(cs);
    assert('…pointed at another report, it starts clean, though still due', s.resume_state === null && s.resume_count === 0
      && new Date(s.next_run_at) <= new Date());
    await client.query(`UPDATE report_schedules SET resume_state = '{"done":["j1"],"sent":11}'::jsonb, resume_count = 1,
        last_status = 'continuing', last_message = '4 more jobs go out at the next pass, in a few minutes.' WHERE id = $1`, [cs]);
    await call('PUT', { id: cs }, { enabled: false }, BOSS);
    s = await row(cs);
    assert('a report handed to the next pass and then switched off says the rest did not go',
      s.resume_state === null && s.last_status === 'partial' && /did not go out: it was switched off/.test(s.last_message)
        && /11 reports had gone out/.test(s.last_message), `${s.last_status} ${s.last_message}`);
    await call('PUT', { id: cs }, { enabled: true }, BOSS);
    await client.query(`UPDATE report_schedules SET resume_state = '{"done":[],"sent":0}'::jsonb,
        last_status = 'continuing', last_message = 'It will be tried again at the next pass.' WHERE id = $1`, [cs]);
    await call('PUT', { id: cs }, { ...base, project_id: '*', report_type: 'turf_bid_items', send_time: '16:00' }, BOSS);
    s = await row(cs);
    assert('…and retimed with nothing sent yet, that nothing went', s.resume_state === null && s.resume_count === 0
      && s.last_status === 'skipped' && /it was changed before the next pass/.test(s.last_message), `${s.last_status} ${s.last_message}`);

    // History: a run for all jobs stays a run for all jobs.
    const all = await mk({ report_type: 'turf_daily_summary', project_id: '' });
    await runner.recordRun(sql, await row(all), sentOk, { kind: 'manual', token: null, triggeredBy: 'boss', startedAt: new Date(), now: new Date() });
    await call('PUT', { id: all }, { ...base, report_type: 'turf_daily_summary', project_id: 'j1', project_name: 'Maple Ave' }, BOSS);
    const g = await call('GET', {}, null, BOSS);
    const allRuns = g.body.runs.filter(rr => Number(rr.schedule_id) === Number(all));
    assert('a past send for all jobs is not relabelled with the job the schedule moved to',
      allRuns.length === 1 && allRuns[0].project_name === null && allRuns[0].project_id === null, JSON.stringify(allRuns));
  }

  console.log('\nPicked jobs');
  {
    let r = await call('POST', {}, { ...base, project_id: '*', picked_jobs: [
      { id: 'j1', name: 'Maple Ave' }, { id: 'j2', name: 'Oak St' }, { id: 'j1', name: 'Maple Ave' }, { id: '*' }, { id: '' }] }, BOSS);
    assert('a schedule can send for the jobs ticked, each once',
      r.statusCode === 200 && JSON.stringify(r.body.schedule.picked_jobs) === '[{"id":"j1","name":"Maple Ave"},{"id":"j2","name":"Oak St"}]'
        && r.body.schedule.project_id === '*', JSON.stringify(r.body));
    const pid = r.body.schedule.id;
    let row1 = await row(pid);
    assert('…stored as the jobs and their names', JSON.stringify(row1.picked_jobs) === '[{"id":"j1","name":"Maple Ave"},{"id":"j2","name":"Oak St"}]');
    const spec = runner.specFor(row1, { scope: 'job', type: 'turf_daily_pm' }, new Date());
    assert('the run is told which jobs', spec.projectId === '*' && JSON.stringify(spec.pickedJobs) === '[{"id":"j1","name":"Maple Ave"},{"id":"j2","name":"Oak St"}]',
      JSON.stringify(spec));
    await call('PUT', { id: pid }, { enabled: false }, BOSS);
    await call('PUT', { id: pid }, { enabled: true }, BOSS);
    assert('switching it off and on keeps the jobs ticked', JSON.stringify((await row(pid)).picked_jobs) === JSON.stringify(row1.picked_jobs));
    await runner.recordRun(sql, await row(pid), { status: 'sent', sent: 2, total: 2, recipientCount: 2, message: 'Sent 2 reports.' },
      { kind: 'manual', token: null, triggeredBy: 'boss', startedAt: new Date(), now: new Date() });
    const g = await call('GET', {}, null, BOSS);
    assert('its sends read as the picked jobs in the history', g.body.runs.some(x => Number(x.schedule_id) === Number(pid) && x.project_name === '2 picked jobs'),
      JSON.stringify(g.body.runs.filter(x => Number(x.schedule_id) === Number(pid))));
    r = await call('PUT', { id: pid }, { ...base, project_id: '*', picked_jobs: [] }, BOSS);
    assert('none ticked is every In Progress job', r.statusCode === 200 && r.body.schedule.picked_jobs === null && (await row(pid)).picked_jobs === null);
    r = await call('PUT', { id: pid }, { ...base, project_id: 'j1', project_name: 'Maple Ave', picked_jobs: [{ id: 'j2' }] }, BOSS);
    assert('a single job is that job, whatever else came along', r.body.schedule.picked_jobs === null && r.body.schedule.project_id === 'j1');
    r = await call('POST', {}, { ...base, report_type: 'turf_daily_summary', project_id: '', picked_jobs: [{ id: 'j1' }] }, BOSS);
    assert('a report that is one report for all jobs takes no picks', r.statusCode === 200 && r.body.schedule.picked_jobs === null, JSON.stringify(r.body));
    await call('DELETE', { id: r.body.schedule.id }, null, BOSS);
    r = await call('POST', {}, { ...base, project_id: '*', picked_jobs: Array.from({ length: 101 }, (_, i) => ({ id: 'x' + i })) }, BOSS);
    assert('at most 100 jobs on one schedule', r.statusCode === 400 && /at most 100 jobs/.test(r.body.error), JSON.stringify(r.body));
    await call('DELETE', { id: pid }, null, BOSS);
  }

  console.log('\nWhere a run has got to');
  {
    const mk = async over => (await call('POST', {}, { ...base, ...over }, BOSS)).body.schedule.id;
    const pg = await mk({});
    const tok = runner.newClaimToken();
    await client.query("UPDATE report_schedules SET claimed_at = NOW(), claim_token = $2, last_status = 'sending', last_message = 'Building and sending.' WHERE id = $1", [pg, tok]);
    const snap = await row(pg);
    const note = runner.progressWriter(sql, snap, tok);
    note('Building Maple Ave (3 of 12); 2 reports sent so far; 900 MB in use');
    await new Promise(r => setTimeout(r, 150));
    let s = await row(pg);
    assert('a run notes its step on the row while it sends',
      s.last_message === 'Working: Building Maple Ave (3 of 12); 2 reports sent so far; 900 MB in use', s.last_message);
    let g = await call('GET', {}, null, BOSS);
    let shown = g.body.schedules.find(x => Number(x.id) === Number(pg));
    assert('…which the tab gets, still sending', shown.sending === true && /^Working: Building Maple Ave/.test(shown.last_message));
    await client.query("UPDATE report_schedules SET claimed_at = NOW() - interval '20 minutes' WHERE id = $1", [pg]);
    g = await call('GET', {}, null, BOSS);
    shown = g.body.schedules.find(x => Number(x.id) === Number(pg));
    assert('cut off there, it reads Interrupted and says where it stopped',
      shown.last_status === 'interrupted'
        && shown.last_message === 'The run was cut off at: Building Maple Ave (3 of 12); 2 reports sent so far; 900 MB in use. Some of its emails may have gone out; the rest did not.',
      shown.last_message);
    await runner.recordRun(sql, snap, { status: 'sent', sent: 12, total: 12, recipientCount: 1, message: 'Sent 12 reports to 1 recipient.' },
      { kind: 'manual', token: tok, startedAt: new Date(), now: new Date() });
    note('Making the PDF and sending Oak St (12 of 12); a late note');
    await new Promise(r => setTimeout(r, 150));
    s = await row(pg);
    assert('a note that lands after the run is written down does not overwrite its result',
      s.last_status === 'sent' && s.last_message === 'Sent 12 reports to 1 recipient.', `${s.last_status} ${s.last_message}`);
  }

  console.log('\nHistory');
  {
    const r = await call('GET', {}, null, BOSS);
    assert('the tab gets recent runs, newest first, with what they were',
      r.body.runs.length >= 4 && /^turf_/.test(r.body.runs[0].report_type || '')
        && new Date(r.body.runs[0].started_at) >= new Date(r.body.runs[r.body.runs.length - 1].started_at));
    const d = await call('DELETE', { id }, null, BOSS);
    assert('deleting a schedule takes its history with it',
      d.statusCode === 200 && !(await row(id)) && (await runsFor(id)).length === 0);
  }

  await cleanUp();
  await client.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => { console.error(err); try { await cleanUp(); await client.end(); } catch {} process.exit(1); });
