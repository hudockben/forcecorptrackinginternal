#!/usr/bin/env node
'use strict';
/**
 * SQL-level integration test for the Team Directory's half of /api/employees.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-employee-directory-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * DESTRUCTIVE: truncates employees, quarry_employees and app_data. It refuses
 * to run against a database whose name doesn't look like a test database.
 *
 * scripts/test-employee-directory.js asserts what the handler INTENDS to send.
 * This one drives the real handler against a real PostgreSQL and asserts what
 * the database does with it — because the interesting behaviour here is not in
 * the JavaScript, it is in one upsert that has to hold two contradictory
 * promises at once:
 *
 *   - the role flags survive a contact save, and the contact card survives a
 *     flag toggle (two screens, one row, and no ordering between them)
 *   - a field can still be CLEARED, which is a different thing from not being
 *     sent, even though both arrive as null
 *
 * Also covers the reason the contact card lives on `employees` at all: a man
 * who exists only in paving's list blob has no row until someone gives him a
 * phone number, and the PATCH has to create it.
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

// This truncates. Make it hard to point at something real by accident.
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script truncates tables. Point PG_TEST_URL at a scratch database.');
  process.exit(1);
}

const client = new Client({ connectionString: URL });

// neon-serverless' tagged template, backed by pg: same contract (a Promise of
// rows) so the handler under test is the one that ships.
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
  if (request === './lib/auth') {
    return {
      requireAuth: (req, res) => {
        if (!AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        return AUTH;
      },
      requireDivision: () => AUTH,
      hasDivisionAccess: () => true,
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'employees.js'));

const ADMIN = { companyCode: 'FCT', userId: 1, username: 'hudockben', role: 'admin', isPlatformAdmin: true };

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(o)   { this.body = o; return this; },
    end()     { return this; },
  };
}

async function patch(name, body, auth = ADMIN) {
  AUTH = auth;
  const res = mockRes();
  await handler({ method: 'PATCH', query: { name }, headers: {}, body }, res);
  return res;
}

async function get(auth = ADMIN) {
  AUTH = auth;
  const res = mockRes();
  await handler({ method: 'GET', query: {}, headers: {}, body: null }, res);
  return res;
}

async function rowFor(name) {
  const { rows } = await client.query(
    `SELECT is_supervisor, is_driver, phone, email, supervisor_name
       FROM employees WHERE company_code = 'FCT' AND name = $1`, [name]);
  return rows[0] || null;
}

(async () => {
  await client.connect();
  await client.query('TRUNCATE employees, quarry_employees, app_data RESTART IDENTITY CASCADE');
  await client.query(
    `INSERT INTO companies (code, name) VALUES ('FCT','Force Corp') ON CONFLICT (code) DO NOTHING`);

  // A man on the canonical roster, already flagged as a driver.
  await client.query(
    `INSERT INTO employees (company_code, name, job_class, is_driver, sort_order)
     VALUES ('FCT','Dale Smith','Operator', TRUE, 0)`);
  // A supervisor, so the directory has a reporting line to point at.
  await client.query(
    `INSERT INTO employees (company_code, name, is_supervisor, sort_order)
     VALUES ('FCT','Ben Hudock', TRUE, 1)`);
  // And two people who exist only in a division's own roster.
  await client.query(
    `INSERT INTO app_data (key, value) VALUES ('FCT:fct_paving_lists', $1)`,
    [JSON.stringify({ employees: [{ name: 'Paving Pete' }] })]);
  await client.query(
    `INSERT INTO quarry_employees (id, company_code, name) VALUES (1, 'FCT', 'Quarry Quinn')`);

  // ── 1. A contact save leaves the role flags where they were ──────────────
  console.log('\n[the contact card]');
  {
    const res = await patch('Dale Smith', {
      phone: '(814) 555-0142', email: 'Dale.Smith@ForceCorp.com', supervisor_name: 'Ben Hudock',
    });
    const row = await rowFor('Dale Smith');
    assert('a card saves', res.statusCode === 200 && res.body.ok === true, JSON.stringify(res.body));
    assert('the number is stored as typed', row.phone === '(814) 555-0142');
    assert('the email is normalised down', row.email === 'dale.smith@forcecorp.com');
    assert('the reporting line is stored', row.supervisor_name === 'Ben Hudock');
    assert('and his Driver flag is untouched', row.is_driver === true);
    assert('as is Supervisor', row.is_supervisor === false);
  }

  // ── 2. A flag toggle leaves the contact card where it was ────────────────
  {
    await patch('Dale Smith', { is_supervisor: true });
    const row = await rowFor('Dale Smith');
    assert('flagging him a supervisor takes', row.is_supervisor === true);
    assert('and does not blank his number',  row.phone === '(814) 555-0142');
    assert('nor his email',                  row.email === 'dale.smith@forcecorp.com');
    assert('nor who he reports to',          row.supervisor_name === 'Ben Hudock');
    assert('and leaves Driver alone',        row.is_driver === true);
  }

  // ── 3. Sending one field leaves the other two alone ──────────────────────
  {
    await patch('Dale Smith', { phone: '814-555-9999' });
    const row = await rowFor('Dale Smith');
    assert('a phone-only save updates the phone', row.phone === '814-555-9999');
    assert('and leaves the email',                row.email === 'dale.smith@forcecorp.com');
    assert('and the supervisor',                  row.supervisor_name === 'Ben Hudock');
  }

  // ── 4. Clearing is a real edit, not a no-op ──────────────────────────────
  {
    await patch('Dale Smith', { phone: '' });
    const row = await rowFor('Dale Smith');
    assert('an empty phone actually clears the column', row.phone === null);
    assert('and clears nothing else',
      row.email === 'dale.smith@forcecorp.com' && row.supervisor_name === 'Ben Hudock');
    assert('with the flags still standing', row.is_driver === true && row.is_supervisor === true);
  }

  // ── 5. A blob-only man gets a row the first time he is given a number ────
  console.log('\n[people who live in a division list]');
  {
    const before = await rowFor('Paving Pete');
    const res    = await patch('Paving Pete', { phone: '814-555-7788', supervisor_name: 'Ben Hudock' });
    const after  = await rowFor('Paving Pete');
    assert('he starts with no employees row', before === null);
    assert('the save succeeds anyway', res.statusCode === 200, JSON.stringify(res.body));
    assert('and creates the row', after && after.phone === '814-555-7788');
    assert('with the reporting line on it', after.supervisor_name === 'Ben Hudock');
    assert('and both flags defaulted off, not guessed',
      after.is_supervisor === false && after.is_driver === false);
  }

  // ── 6. What the directory reads back ─────────────────────────────────────
  console.log('\n[the merged roster the directory renders]');
  {
    const res  = await get();
    const list = res.body.employees || [];
    const byName = Object.fromEntries(list.map(e => [e.name, e]));
    assert('everyone appears', list.length === 4, `${list.length}: ${list.map(e => e.name).join(', ')}`);
    assert('and exactly once', new Set(list.map(e => e.name)).size === list.length);
    assert('the card comes back with them',
      byName['Dale Smith'].email === 'dale.smith@forcecorp.com'
      && byName['Dale Smith'].supervisor_name === 'Ben Hudock');
    assert('a cleared field reads as empty, not missing',
      byName['Dale Smith'].phone === null);
    assert('the man who was only in the paving blob now carries a number',
      byName['Paving Pete'].phone === '814-555-7788');
    assert('and the quarry-only man is listed with an empty card',
      byName['Quarry Quinn'].phone === null && byName['Quarry Quinn'].supervisor_name === null);
  }

  // ── 7. A division saving its roster must not wipe the directory ──────────
  // This is the failure nobody would notice for a month: paving saves its
  // employee list, the blob carries no phone numbers, and every number in the
  // company goes with it.
  console.log('\n[a division saves its roster]');
  {
    AUTH = ADMIN;
    const res = mockRes();
    await handler({
      method: 'PUT', query: {}, headers: {},
      body: { employees: [
        { name: 'Dale Smith',  job_class: 'Foreman' },
        { name: 'Ben Hudock' },
        { name: 'Paving Pete' },
      ] },
    }, res);
    assert('the roster save succeeds', res.statusCode === 200, JSON.stringify(res.body));

    const dale = await rowFor('Dale Smith');
    const pete = await rowFor('Paving Pete');
    assert('the job class it does own is updated',
      (await client.query(`SELECT job_class FROM employees WHERE name='Dale Smith'`)).rows[0].job_class === 'Foreman');
    assert('but the email survives',      dale.email === 'dale.smith@forcecorp.com');
    assert('and the reporting line',      dale.supervisor_name === 'Ben Hudock');
    assert('and so does Pete\'s number',  pete.phone === '814-555-7788');
  }

  // ── 8. syncLists — the other way a roster blob reaches this table ────────
  // Note the re-flag: unlike syncLists, the bulk PUT above DOES carry
  // is_supervisor in its UPDATE SET, so a payload without the flag clears it.
  // That is long-standing behaviour of the PUT contract and nothing in the app
  // sends it today — it is set here so this step tests syncLists rather than
  // the previous step's leftovers.
  {
    await patch('Dale Smith', { is_supervisor: true });
    const { syncLists } = require(path.resolve(__dirname, '..', 'api', 'lib', 'sync-normalized.js'));
    if (typeof syncLists === 'function') {
      await syncLists(makeSql(client), 'FCT', { employees: [{ name: 'Dale Smith', job_class: 'Operator' }] });
      const dale = await rowFor('Dale Smith');
      assert('a blob sync leaves the card alone too',
        dale.email === 'dale.smith@forcecorp.com' && dale.supervisor_name === 'Ben Hudock');
      assert('and both flags', dale.is_driver === true && dale.is_supervisor === true);
    } else {
      console.log('  — syncLists is not exported; skipped');
    }
  }

  // ── 9. What the database refuses ─────────────────────────────────────────
  console.log('\n[refusals]');
  {
    const before = await rowFor('Dale Smith');
    const res    = await patch('Dale Smith', { email: 'not an address' });
    const after  = await rowFor('Dale Smith');
    assert('a bad email is refused', res.statusCode === 400);
    assert('and the stored row is untouched', after.email === before.email);

    const res2 = await patch('Dale Smith', { supervisor_name: 'dale smith' });
    assert('a self-report is refused', res2.statusCode === 400);
    assert('and the stored line is untouched',
      (await rowFor('Dale Smith')).supervisor_name === 'Ben Hudock');

    const res3 = await patch('Dale Smith', { phone: '814-555-0000' },
      { companyCode: 'FCT', userId: 9, username: 'strickallen', role: 'level1', isPlatformAdmin: false });
    assert('the field cannot edit the directory', res3.statusCode === 403);
    assert('and nothing moved', (await rowFor('Dale Smith')).phone === null);
  }

  await client.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error(err);
  try { await client.end(); } catch {}
  process.exit(1);
});
