#!/usr/bin/env node
'use strict';
/**
 * Who a login is, as an admin said it: the SQL, against a real Postgres.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-login-links-sql.js
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * as the other *-sql.js suites.
 *
 * scripts/test-login-names.js pins the logic with the database stubbed; what a
 * stub cannot show is that the statements do what they say. The answers live
 * in one app_data row per company, an entry per login, and every write changes
 * one entry in place — so two admins answering for different logins at the
 * same moment must both be there afterwards. That is the claim this runs.
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

const CO = 'LLTEST';   // a company of its own, removed at the start and the end
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
const { writeLoginLink, readLoginLinks, loginLinksKey, readPeopleRoster } = require(path.join(ROOT, 'api', 'lib', 'roster'));
const handler = require(path.join(ROOT, 'api', 'employees.js'));

const ADMIN = { companyCode: CO, userId: 1, username: 'hudockben', role: 'admin', isPlatformAdmin: false };
const FIELD = { companyCode: CO, userId: 2, username: 'strickallen', role: 'level1', isPlatformAdmin: false };

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const eq = (label, got, want) => assert(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

async function call(method, query, body, auth) {
  AUTH = auth;
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  await handler({ method, query, body: body || {}, headers: {} }, res);
  return res;
}
const stored = async () => {
  const rows = await client.query('SELECT value FROM app_data WHERE key = $1', [loginLinksKey(CO)]);
  return rows.rows.length ? rows.rows[0].value : null;
};

async function cleanUp() {
  await client.query('DELETE FROM app_data WHERE key = $1', [loginLinksKey(CO)]);
  await client.query('DELETE FROM companies WHERE code = $1', [CO]);   // users and employees go with it
}

(async () => {
  await client.connect();
  const sql = makeSql(client);
  await cleanUp();
  await client.query("INSERT INTO companies (code, name) VALUES ($1, 'Login links test')", [CO]);
  const logins = ['toddaaron', 'atodd', 'travissteve', 'strickallen', 'hudockben'];
  for (const u of logins) await client.query("INSERT INTO users (username, company_code, password_hash) VALUES ($1, $2, 'x')", [u, CO]);
  const emp = async (name, sup) => client.query('INSERT INTO employees (company_code, name, is_supervisor) VALUES ($1, $2, $3)', [CO, name, !!sup]);
  await emp('Aaron Todd'); await emp('Amy Todd'); await emp('Allen Strick');
  await emp('toddaaron', true); await emp('atodd', true); await emp('travissteve', true); await emp('strickallen', true);

  console.log('Who a login is, in the database\n');

  console.log('[one entry at a time]');
  {
    eq('  nothing is stored until an admin answers', await readLoginLinks(sql, CO), {});
    await writeLoginLink(sql, CO, 'ToddAaron', { person: 'Amy Todd' });
    eq('  the first answer makes the row', await stored(), { links: { toddaaron: { person: 'Amy Todd' } } });
    await writeLoginLink(sql, CO, 'atodd', { person: 'Aaron Todd' });
    eq('  a second login joins it, the first kept', await readLoginLinks(sql, CO),
      { atodd: { person: 'Aaron Todd' }, toddaaron: { person: 'Amy Todd' } });
    await writeLoginLink(sql, CO, 'toddaaron', { none: true });
    eq('  answering again replaces that login’s answer only', await readLoginLinks(sql, CO),
      { atodd: { person: 'Aaron Todd' }, toddaaron: { none: true } });
    await writeLoginLink(sql, CO, 'toddaaron', null);
    eq('  going back to the name takes out that entry alone', await readLoginLinks(sql, CO), { atodd: { person: 'Aaron Todd' } });
    await client.query('DELETE FROM app_data WHERE key = $1', [loginLinksKey(CO)]);
    await writeLoginLink(sql, CO, 'atodd', null);
    eq('  clearing with no row there makes none', await stored(), null);
    await client.query("INSERT INTO app_data (key, value) VALUES ($1, '{\"links\": [1, 2]}')", [loginLinksKey(CO)]);
    await writeLoginLink(sql, CO, 'atodd', { person: 'Amy Todd' });
    eq('  a row in the wrong shape is replaced rather than added to', await stored(), { links: { atodd: { person: 'Amy Todd' } } });
    await client.query('DELETE FROM app_data WHERE key = $1', [loginLinksKey(CO)]);
  }

  console.log('\n[two admins at once]');
  {
    // Ten connections, ten logins, all at the same moment. A write that read
    // the row and wrote it back would leave only some of them.
    const conns = await Promise.all(Array.from({ length: 10 }, async () => { const c = new Client({ connectionString: URL }); await c.connect(); return c; }));
    await Promise.all(conns.map((c, i) => writeLoginLink(makeSql(c), CO, 'login' + i, { person: 'Person ' + i })));
    const after = await readLoginLinks(sql, CO);
    eq('  every answer is there', Object.keys(after).sort(), Array.from({ length: 10 }, (_, i) => 'login' + i).sort());
    await Promise.all(conns.map((c, i) => (i % 2 ? writeLoginLink(makeSql(c), CO, 'login' + i, null) : writeLoginLink(makeSql(c), CO, 'login' + i, { none: true }))));
    const mixed = await readLoginLinks(sql, CO);
    eq('  and clearing some while changing others at once leaves exactly the rest',
      Object.keys(mixed).sort(), ['login0', 'login2', 'login4', 'login6', 'login8']);
    assert('  each with its own new answer', ['login0', 'login2', 'login4', 'login6', 'login8'].every(k => mixed[k].none === true));
    await Promise.all(conns.map(c => c.end()));
    await client.query('DELETE FROM app_data WHERE key = $1', [loginLinksKey(CO)]);
  }

  console.log('\n[PATCH /api/employees?login=, end to end]');
  {
    const field = await call('PATCH', { login: 'toddaaron' }, { person: 'Amy Todd' }, FIELD);
    assert('  a field user cannot say who a login is', field.statusCode === 403 && (await stored()) === null);
    const stranger = await call('PATCH', { login: 'toddaaron' }, { person: 'Somebody Else' }, ADMIN);
    assert('  a person not on the roster is refused', stranger.statusCode === 400 && (await stored()) === null, JSON.stringify(stranger.body));
    const other = await call('PATCH', { login: 'nobodyslogin' }, { person: 'Amy Todd' }, ADMIN);
    assert('  a login that is not the company’s is refused', other.statusCode === 404 && (await stored()) === null);
    const ok = await call('PATCH', { login: 'TODDAARON' }, { person: 'amy TODD' }, ADMIN);
    assert('  an admin’s answer is saved', ok.statusCode === 200 && ok.body.ok === true, JSON.stringify(ok.body));
    eq('  under the login, with the name as the roster spells it', await readLoginLinks(sql, CO), { toddaaron: { person: 'Amy Todd' } });

    const { people, matched, manual } = await readPeopleRoster(sql, CO);
    eq('  the roster folds the login where the admin said', matched.toddaaron, 'Amy Todd');
    assert('  and knows it was an admin, not the name', manual.includes('toddaaron'));
    assert('  Amy Todd takes on its role', people.find(p => p.name === 'Amy Todd').is_supervisor === true);
    assert('  the name still does the rest', matched.strickallen === 'Allen Strick');

    await call('PATCH', { login: 'travissteve' }, { none: true }, ADMIN);
    const view = await call('GET', { view: 'people' }, null, ADMIN);
    assert('  a login off the crew comes back marked, for the directory',
      view.body.offCrew.includes('travissteve') && view.body.employees.find(e => e.name === 'travissteve').offCrew === true);
    const plain = await call('GET', {}, null, ADMIN);
    assert('  and the rows themselves are untouched, for Manage Users → Roles',
      ['toddaaron', 'atodd', 'travissteve', 'strickallen'].every(n => plain.body.employees.some(e => e.name === n)));

    const back = await call('PATCH', { login: 'toddaaron' }, { person: null }, ADMIN);
    assert('  going back to the name clears the entry', back.statusCode === 200 && !('toddaaron' in await readLoginLinks(sql, CO)));
    eq('  and the name takes over again', (await readPeopleRoster(sql, CO)).matched.toddaaron, 'Aaron Todd');
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
