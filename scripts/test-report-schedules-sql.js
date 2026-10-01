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
  if (request === '../lib/auth' && parent && /api[\\/]email[\\/]report-schedules\.js$/.test(parent.filename)) {
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

async function call(method, query, body, auth) {
  AUTH = auth;
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  await handler({ method, query: query || {}, body: body || {}, headers: { host: 'datawatch.test' } }, res);
  return res;
}

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
    runner.runSchedule = async (s, sched) => {
      sentIds.push(Number(sched.id));
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

  console.log('\nHistory');
  {
    const r = await call('GET', {}, null, BOSS);
    assert('the tab gets recent runs, newest first, with what they were',
      r.body.runs.length >= 4 && r.body.runs[0].report_type === 'turf_daily_pm'
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
