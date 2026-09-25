#!/usr/bin/env node
'use strict';
/**
 * Code Time: whose days a coder may see and code.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-coder-crew-scope-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * DESTRUCTIVE: truncates timesheet_entries and timesheet_audit_log, and
 * rewrites a handful of users and employees rows. It refuses to run against a
 * database whose name doesn't look like a test database.
 *
 * A submitted day reaches a coder's queue (?scope=crew) and may be coded by
 * him (?action=precode) when EITHER:
 *
 *   1. he filed his own day — submitted or approved, never a draft — on the
 *      same job and date, or
 *   2. the man who filed it named him as its supervisor.
 *
 * The second path is what lets a foreman code his crew before he has sent his
 * own time in. This drives the real handler against a real PostgreSQL, with
 * the real payrollAccess, and checks both halves agree: a day he is shown is a
 * day he can save, and a day he is not shown is one he cannot.
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script truncates tables. Point PG_TEST_URL at a scratch database.');
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

// The REAL auth module, with only requireAuth stubbed: payrollAccess is what
// decides coder vs approver, and a stand-in for it would let this pass without
// the narrow grant being enforced at all.
let AUTH = null;
const realAuthPath = path.resolve(__dirname, '..', 'api', 'lib', 'auth.js');
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  if (request === './lib/auth' && parent && /timesheet-entries\.js$/.test(parent.filename || '')) {
    const real = origLoad.call(this, realAuthPath, parent);
    return Object.assign({}, real, { requireAuth: () => AUTH });
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const DAY = '2026-09-25';

const TED = { companyCode: 'FCT', userId: 50, username: 'devalerioted',
              divisionRoles: { timesheet: 'level1', payroll: 'level2' } };
const BOB = { companyCode: 'FCT', userId: 53, username: 'bobforeman',
              divisionRoles: { timesheet: 'level1', payroll: 'level2' } };

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

const queue = async (auth) => {
  const r = await call('GET', { scope: 'crew', status: 'submitted', from: DAY, to: DAY }, null, auth);
  return (r.body && r.body.entries || []).map(e => e.username).sort();
};

const precode = (id, auth) => call('POST', { action: 'precode', id: String(id) }, {
  split: [{ cost_code: '101', sub_code: 'A', labor_hours: 8, quantity: 0 }],
}, auth);

let TED_EMP = null;

async function seed() {
  const q = (t, v) => client.query(t, v);
  await q(`TRUNCATE timesheet_entries, timesheet_audit_log RESTART IDENTITY CASCADE`);
  await q(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp'), ('OTH','Other Co')
           ON CONFLICT (code) DO NOTHING`);
  await q(`DELETE FROM users WHERE id BETWEEN 50 AND 70`);
  await q(`INSERT INTO users (id, company_code, username, password_hash, role) VALUES
             (50,'FCT','devalerioted','x','level1'),
             (53,'FCT','bobforeman','x','level1'),
             (61,'FCT','mike','x','level1'), (62,'FCT','sam','x','level1'),
             (63,'FCT','nick','x','level1'), (64,'FCT','olly','x','level1'),
             (65,'FCT','dan','x','level1'),  (66,'FCT','dave','x','level1'),
             (67,'FCT','tim','x','level1'),  (68,'OTH','other','x','level1')`);
  await q(`DELETE FROM employees WHERE company_code IN ('FCT','OTH')`);
  // Ted's roster row is what the Supervisor picker hands out as the value.
  // Capitalised differently from his login, as roster names routinely are.
  const [emp] = (await q(`INSERT INTO employees (company_code, name, is_supervisor)
                          VALUES ('FCT','DeValerioTed', TRUE) RETURNING id`)).rows;
  TED_EMP = emp.id;
  const [steve] = (await q(`INSERT INTO employees (company_code, name, is_supervisor)
                            VALUES ('FCT','Steve Travis', TRUE) RETURNING id`)).rows;

  const add = (o) => q(`
    INSERT INTO timesheet_entries (
      company_code, user_id, username, entry_type, work_date, status,
      division, job_id, job_label, start_time, end_time,
      computed_hours, travel_hours, supervisor_id, supervisor_name
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'07:00','15:30',8,0,$10,$11)
    RETURNING id`,
    [o.company || 'FCT', o.uid, o.name, o.type || 'daily', DAY, o.status || 'submitted',
     o.div || 'paving', o.job === undefined ? '26019' : o.job, 'Punxsy Storage Lot',
     o.supId === undefined ? null : o.supId, o.supName === undefined ? null : o.supName])
    .then(r => r.rows[0].id);

  return {
    // Picked Ted off the list: id and label both say him.
    mike:  await add({ uid: 61, name: 'mike',  supId: TED_EMP, supName: 'devalerioted' }),
    // Same job, but reports to somebody else — only path 1 can bring him in.
    sam:   await add({ uid: 62, name: 'sam',   supId: steve.id, supName: 'Steve Travis' }),
    // Name only (an older row with no id), stray whitespace and case.
    nick:  await add({ uid: 63, name: 'nick',  job: '30000', supId: null, supName: '  DEVALERIOTED ' }),
    // Id only: the label has drifted since, the id still points at Ted.
    olly:  await add({ uid: 64, name: 'olly',  job: '30000', supId: TED_EMP, supName: 'Ted (old name)' }),
    // Named Ted, but not work a coder codes.
    dan:   await add({ uid: 65, name: 'dan',   div: 'quarry', job: 'daily:1', supId: TED_EMP, supName: 'devalerioted' }),
    dave:  await add({ uid: 66, name: 'dave',  status: 'draft', supId: TED_EMP, supName: 'devalerioted' }),
    tim:   await add({ uid: 67, name: 'tim',   type: 'time_off', job: null, div: null, supId: TED_EMP, supName: 'devalerioted' }),
    // Another company's day naming a man of the same name.
    other: await add({ company: 'OTH', uid: 68, name: 'other', supId: TED_EMP, supName: 'devalerioted' }),
  };
}

async function run() {
  await client.connect();
  const ids = await seed();

  console.log('\n[before Ted has filed anything]');
  let q = await queue(TED);
  assert('the day that picked him off the list is there', q.includes('mike'), JSON.stringify(q));
  assert('a day naming him by login only is there', q.includes('nick'), JSON.stringify(q));
  assert('a day naming him by roster id only is there', q.includes('olly'), JSON.stringify(q));
  assert('a day reporting to somebody else is not', !q.includes('sam'), JSON.stringify(q));
  assert('quarry is still out of scope', !q.includes('dan'));
  assert('a draft is still out of scope', !q.includes('dave'));
  assert('time off is still out of scope', !q.includes('tim'));
  assert('another company\'s day is not', !q.includes('other'));

  let r = await precode(ids.mike, TED);
  assert('he can code the day that named him', r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body)}`);
  r = await precode(ids.olly, TED);
  assert('he can code the day that names him by id', r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body)}`);
  r = await precode(ids.sam, TED);
  assert('he cannot code the day he was not shown', r.statusCode === 403, `${r.statusCode} ${JSON.stringify(r.body)}`);

  console.log('\n[another coder]');
  q = await queue(BOB);
  assert('sees none of it', q.length === 0, JSON.stringify(q));
  r = await precode(ids.nick, BOB);
  assert('and cannot code a day naming Ted', r.statusCode === 403, `${r.statusCode}`);

  console.log('\n[the login is read off the account, not the token]');
  q = await queue(Object.assign({}, TED, { username: 'somebody-else' }));
  assert('a stale token name still finds his crew', q.includes('mike'), JSON.stringify(q));
  await client.query(`UPDATE users SET username = 'ted-renamed' WHERE id = 50`);
  q = await queue(TED);
  assert('a renamed account no longer answers to the old name', !q.includes('nick'), JSON.stringify(q));
  await client.query(`UPDATE users SET username = 'devalerioted' WHERE id = 50`);

  console.log('\n[his own draft still confers nothing]');
  await client.query(`
    INSERT INTO timesheet_entries (company_code, user_id, username, entry_type, work_date, status,
                                   division, job_id, computed_hours, travel_hours)
    VALUES ('FCT', 50, 'devalerioted', 'daily', $1, 'draft', 'paving', '26019', 8, 0)`, [DAY]);
  q = await queue(TED);
  assert('the rest of the job stays out', !q.includes('sam'), JSON.stringify(q));
  r = await precode(ids.sam, TED);
  assert('and cannot be coded', r.statusCode === 403, `${r.statusCode}`);

  console.log('\n[once he files his own day on the job]');
  await client.query(`UPDATE timesheet_entries SET status = 'submitted' WHERE user_id = 50`);
  q = await queue(TED);
  assert('the rest of the job comes in with it', q.includes('sam'), JSON.stringify(q));
  assert('the days that named him are still there', q.includes('mike') && q.includes('nick'), JSON.stringify(q));
  r = await precode(ids.sam, TED);
  assert('and can be coded', r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  await client.end();
  process.exit(failed ? 1 : 0);
}

run().catch(async (err) => {
  console.error(err);
  try { await client.end(); } catch {}
  process.exit(1);
});
