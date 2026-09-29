#!/usr/bin/env node
'use strict';
/**
 * Who is kept off the Scheduler, as an admin said it: the SQL, against a real
 * Postgres.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-off-scheduler-sql.js
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * as the other *-sql.js suites.
 *
 * scripts/test-off-scheduler.js pins the logic with the database stubbed; what
 * a stub cannot show is that the statements do what they say. The answers live
 * in one app_data row per company, an entry per person, and every write changes
 * one entry in place — so two admins switching different people at the same
 * moment must both be there afterwards. That is the claim this runs, and then
 * the whole trip: the PATCH, the list of people, and the Scheduler's board.
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

// Writes and deletes rows. Make it hard to point at something real by accident.
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script writes and deletes rows. Point PG_TEST_URL at a scratch database.');
  process.exit(1);
}

const CO = 'OSTEST';   // a company of its own, removed at the start and the end
const client = new Client({ connectionString: URL });

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
      requireDivision: () => AUTH,
      hasDivisionAccess: () => true,
      payrollAccess: () => ({ canCode: true, canApprove: true, isCoder: false }),
    };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const { writeOffScheduler, readOffScheduler, offSchedulerKey, readPeopleRoster } = require(path.join(ROOT, 'api', 'lib', 'roster'));
const handler = require(path.join(ROOT, 'api', 'employees.js'));
const { buildBoard } = require(path.join(ROOT, 'api', 'scheduler', 'board.js'));

const ADMIN = { companyCode: CO, userId: 1, username: 'hudockben', role: 'admin', isPlatformAdmin: false };
const FIELD = { companyCode: CO, userId: 2, username: 'strickallen', role: 'level1', isPlatformAdmin: false };

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const eq = (label, got, want) => assert(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const keys = o => Object.keys(o || {}).sort();

async function call(method, query, body, auth) {
  AUTH = auth;
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  await handler({ method, query, body: body || {}, headers: {} }, res);
  return res;
}
const stored = async () => {
  const rows = await client.query('SELECT value FROM app_data WHERE key = $1', [offSchedulerKey(CO)]);
  return rows.rows.length ? rows.rows[0].value : null;
};

async function cleanUp() {
  await client.query('DELETE FROM app_data WHERE key LIKE $1', [CO + ':%']);
  await client.query('DELETE FROM companies WHERE code = $1', [CO]);   // users and employees go with it
}

(async () => {
  await client.connect();
  const sql = makeSql(client);
  await cleanUp();
  await client.query("INSERT INTO companies (code, name) VALUES ($1, 'Off the Scheduler test')", [CO]);
  for (const u of ['toddaaron', 'reeferscott', 'strickallen', 'hudockben']) {
    await client.query("INSERT INTO users (username, company_code, password_hash) VALUES ($1, $2, 'x')", [u, CO]);
  }
  const emp = async (name, sup, jobClass) => client.query(
    'INSERT INTO employees (company_code, name, is_supervisor, job_class) VALUES ($1, $2, $3, $4)', [CO, name, !!sup, jobClass || null]);
  await emp('Aaron Todd', false, 'Foreman'); await emp('Allen Strick', false, 'Operator'); await emp('Zach Brewer', false, 'Laborer');
  await emp('toddaaron', true); await emp('strickallen', true);
  await emp('reeferscott', true);             // an office login nobody on the roster answers to
  // Somebody who is only on paving's list: no employees row, and none made for them.
  await client.query("INSERT INTO app_data (key, value) VALUES ($1, $2)",
    [CO + ':fct_paving_lists', JSON.stringify({ employees: [{ name: 'Paving Pete', job_class: 'Laborer' }] })]);

  console.log('Who is kept off the Scheduler, in the database\n');

  console.log('[one entry at a time]');
  {
    eq('  nobody is off until an admin says so', await readOffScheduler(sql, CO), {});
    await writeOffScheduler(sql, CO, 'Zach Brewer', true, 'hudockben');
    const first = await stored();
    eq('  the first answer makes the row, keyed by the name lowercased', keys(first.people), ['zach brewer']);
    assert('  and keeps who said it, and when',
      first.people['zach brewer'].by === 'hudockben' && !isNaN(Date.parse(first.people['zach brewer'].at)), JSON.stringify(first));
    await writeOffScheduler(sql, CO, 'reeferscott', true, 'hudockben');
    eq('  a second person joins it, the first kept', keys(await readOffScheduler(sql, CO)), ['reeferscott', 'zach brewer']);
    await writeOffScheduler(sql, CO, 'ZACH BREWER', true, 'strickallen');
    const again = await readOffScheduler(sql, CO);
    assert('  saying it again replaces that person’s entry only',
      keys(again).length === 2 && again['zach brewer'].by === 'strickallen' && again.reeferscott.by === 'hudockben', JSON.stringify(again));
    await writeOffScheduler(sql, CO, 'Zach Brewer', false);
    eq('  putting someone back takes out that entry alone', keys(await readOffScheduler(sql, CO)), ['reeferscott']);
    await client.query('DELETE FROM app_data WHERE key = $1', [offSchedulerKey(CO)]);
    await writeOffScheduler(sql, CO, 'reeferscott', false);
    eq('  putting back with no row there makes none', await stored(), null);
    await client.query("INSERT INTO app_data (key, value) VALUES ($1, '{\"people\": [1, 2]}')", [offSchedulerKey(CO)]);
    await writeOffScheduler(sql, CO, 'Zach Brewer', true, 'hudockben');
    eq('  a row in the wrong shape is replaced rather than added to', keys((await stored()).people), ['zach brewer']);
    await client.query('DELETE FROM app_data WHERE key = $1', [offSchedulerKey(CO)]);
  }

  console.log('\n[two admins at once]');
  {
    // Ten connections, ten people, all at the same moment. A write that read
    // the row and wrote it back would leave only some of them.
    const conns = await Promise.all(Array.from({ length: 10 }, async () => { const c = new Client({ connectionString: URL }); await c.connect(); return c; }));
    await Promise.all(conns.map((c, i) => writeOffScheduler(makeSql(c), CO, 'Person ' + i, true, 'admin' + i)));
    eq('  every answer is there', keys(await readOffScheduler(sql, CO)), Array.from({ length: 10 }, (_, i) => 'person ' + i).sort());
    await Promise.all(conns.map((c, i) => writeOffScheduler(makeSql(c), CO, 'Person ' + i, i % 2 === 0, 'admin' + i)));
    eq('  and putting some back while switching others off again leaves exactly the rest',
      keys(await readOffScheduler(sql, CO)), ['person 0', 'person 2', 'person 4', 'person 6', 'person 8']);
    await Promise.all(conns.map(c => c.end()));
    await client.query('DELETE FROM app_data WHERE key = $1', [offSchedulerKey(CO)]);
  }

  console.log('\n[PATCH /api/employees?scheduler=, end to end]');
  {
    const field = await call('PATCH', { scheduler: 'Zach Brewer' }, { on: false }, FIELD);
    assert('  a field user cannot take anyone off', field.statusCode === 403 && (await stored()) === null);
    const stranger = await call('PATCH', { scheduler: 'Somebody Else' }, { on: false }, ADMIN);
    assert('  a name not on the crew list is refused', stranger.statusCode === 400 && (await stored()) === null, JSON.stringify(stranger.body));
    const folded = await call('PATCH', { scheduler: 'toddaaron' }, { on: false }, ADMIN);
    assert('  so is a login folded into its person — the person is who to switch off',
      folded.statusCode === 400 && (await stored()) === null, JSON.stringify(folded.body));
    const ok = await call('PATCH', { scheduler: 'zach BREWER' }, { on: false }, ADMIN);
    assert('  an admin’s answer is saved', ok.statusCode === 200 && ok.body.ok === true && ok.body.on === false, JSON.stringify(ok.body));
    eq('  under the name as the roster spells it', ok.body.name, 'Zach Brewer');
    const byWho = await readOffScheduler(sql, CO);
    eq('  with the admin who said it', byWho['zach brewer'] && byWho['zach brewer'].by, 'hudockben');
    assert('  and no employees row is made for anyone to hold it',
      (await client.query('SELECT count(*)::int AS n FROM employees WHERE company_code = $1', [CO])).rows[0].n === 6);

    await call('PATCH', { scheduler: 'Aaron Todd' }, { on: false }, ADMIN);
    await call('PATCH', { scheduler: 'reeferscott' }, { on: false }, ADMIN);
    await call('PATCH', { scheduler: 'Paving Pete' }, { on: false }, ADMIN);
    const noRow = await client.query('SELECT count(*)::int AS n FROM employees WHERE company_code = $1 AND name = $2', [CO, 'Paving Pete']);
    eq('  somebody only on a division’s list is kept off without a row made for them', noRow.rows[0].n, 0);

    const view = await call('GET', { view: 'people' }, null, ADMIN);
    const person = n => view.body.employees.find(e => e.name === n) || {};
    assert('  the list of people marks who is off', person('Zach Brewer').offScheduler === true && person('Paving Pete').offScheduler === true);
    assert('  a login nobody answers to, by its own name', person('reeferscott').offScheduler === true);
    assert('  a person with a login folded in, by the person', person('Aaron Todd').offScheduler === true && (person('Aaron Todd').logins || []).includes('toddaaron'));
    assert('  and nobody else', person('Allen Strick').offScheduler === undefined);
    eq('  Paving Pete keeps the job class on paving’s list', person('Paving Pete').job_class, 'Laborer');

    const quiet = console.warn; console.warn = () => {};
    const board = await buildBoard(sql, CO, '2026-09-29');
    console.warn = quiet;
    const crew = board.employees.map(e => e.name);
    eq('  the Scheduler’s crew list leaves them all off', crew, ['Allen Strick']);
    eq('  and sends them apart, by name', board.offScheduler.map(e => e.name), ['Aaron Todd', 'Paving Pete', 'reeferscott', 'Zach Brewer']);
    const aaron = board.offScheduler.find(e => e.name === 'Aaron Todd');
    assert('  each in the crew list’s own shape', aaron.jobClass === 'Foreman' && aaron.isSupervisor === true && !('login' in aaron), JSON.stringify(aaron));
    assert('  a login still marked a login', board.offScheduler.find(e => e.name === 'reeferscott').login === true);

    const back = await call('PATCH', { scheduler: 'Zach Brewer' }, { on: true }, ADMIN);
    assert('  switching someone back on clears their entry', back.statusCode === 200 && !('zach brewer' in await readOffScheduler(sql, CO)));
    const gone = await call('PATCH', { scheduler: 'Nobody Here Now' }, { on: true }, ADMIN);
    assert('  and putting back a name the roster has lost is allowed, so an old entry can be cleared', gone.statusCode === 200, JSON.stringify(gone.body));
    console.warn = () => {};
    const after = await buildBoard(sql, CO, '2026-09-29');
    console.warn = quiet;
    eq('  Zach is on the crew list again', after.employees.map(e => e.name), ['Allen Strick', 'Zach Brewer']);
    const zach = after.employees.find(e => e.name === 'Zach Brewer');
    eq('  with the same job class as before', zach.jobClass, 'Laborer');
  }

  await cleanUp();
  await client.end();
  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async err => {
  console.error('Harness error:', err);
  try { await cleanUp(); await client.end(); } catch {}
  process.exit(1);
});
