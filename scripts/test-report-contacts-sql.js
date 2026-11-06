#!/usr/bin/env node
'use strict';
/**
 * Saved customer contacts (Custom Reporting v2), against a real Postgres:
 * api/report-contacts.js, api/lib/report-contacts.js (contactsForJobs, the
 * schedule runner's "each job's saved contacts"), and the Email modal's
 * "Save as contact" (report-email.js in jsdom) posting to the real handler.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-report-contacts-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql. The
 * CUSTOM REPORTING V2 section is applied again here (it is idempotent), so a
 * database from before v2 works too. Refuses a database whose name does not
 * look like a test database; it creates and removes two companies of its own.
 *
 * Every request goes through the real sign-in path: a real token, the account
 * read from the users table, the real division and level rules.
 *
 * What a stub cannot show, and this does:
 *   - the unique index, compared without case and over live rows only, is
 *     what turns a second copy of an address into 409 duplicate;
 *   - every query is scoped by company AND division;
 *   - an empty pick of jobs and clients returns nobody, never the division;
 *   - who may read (every non-sales division user) and who may write
 *     (admin, level3, level2) is the server's rule, not the page's.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'report-contacts-test-secret';

const CO  = 'RCTEST';
const CO2 = 'RCTEST2';
const client = new Client({ connectionString: URL });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

const DB = { fail: false };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') {
    return { neon: () => {
      const sql = makeSql(client);
      return (strings, ...values) => {
        if (DB.fail && strings.join('?').includes('report_contacts')) return Promise.reject(new Error('connection reset'));
        return sql(strings, ...values);
      };
    } };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const jwt = require('jsonwebtoken');
const handler = require(path.join(ROOT, 'api/report-contacts.js'));
const { contactsForJobs, clientKeyOf } = require(path.join(ROOT, 'api/lib/report-contacts.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}
const show = r => `${r.statusCode} ${JSON.stringify(r.body)}`;

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; },
  };
}
async function call(method, query, body, user) {
  const res = fakeRes();
  const headers = user ? { authorization: 'Bearer ' + (typeof user === 'string' ? user : user.token) } : {};
  await handler({ method, query: query || {}, body: body === undefined ? {} : body, headers }, res);
  return res;
}
const P = (extra = {}) => ({ division: 'paving', ...extra });
const get  = (user, q = {}, division = 'paving') => call('GET', { division, ...q }, null, user);
const post = (user, body, division = 'paving') => call('POST', { division }, body, user);
const put  = (user, id, body, division = 'paving') => call('PUT', { division, id: String(id) }, body, user);
const del  = (user, id, division = 'paving') => call('DELETE', { division, id: String(id) }, null, user);
const emails = r => (r.body && Array.isArray(r.body.contacts) ? r.body.contacts.map(c => c.email) : []);

async function cleanUp() {
  for (const co of [CO, CO2]) {
    await client.query('DELETE FROM report_contacts WHERE company_code = $1', [co]).catch(() => {});
    await client.query('DELETE FROM users WHERE company_code = $1', [co]);
    await client.query('DELETE FROM companies WHERE code = $1', [co]);
  }
}

// The CUSTOM REPORTING V2 section, applied the run-schema way.
async function applyV2() {
  const file = fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8');
  const at = file.indexOf('\n-- CUSTOM REPORTING V2');
  if (at < 0) throw new Error('neon-schema.sql has no CUSTOM REPORTING V2 section');
  const stmts = file.slice(file.lastIndexOf('\n-- ─', at)).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
  for (const s of stmts) await client.query(s);
}

(async () => {
  await client.connect();
  await applyV2();
  await cleanUp();
  await client.query("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Contacts test', '{turf,paving,kiewit,dust}')", [CO]);
  await client.query("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Rival Co', '{turf,paving}')", [CO2]);

  const mk = async (username, roles, { co = CO, platform = false } = {}) => {
    const id = (await client.query(
      "INSERT INTO users (username, company_code, password_hash, role, division_roles, is_platform_admin) VALUES ($1, $2, 'x', 'level1', $3, $4) RETURNING id",
      [username, co, JSON.stringify(roles), platform])).rows[0].id;
    // The token's claims are deliberately generous; the users row decides.
    const token = jwt.sign({ userId: id, username, companyCode: co, role: 'admin', divisionRoles: { paving: 'admin', turf: 'admin', kiewit: 'admin' } },
      process.env.JWT_SECRET);
    return { id, username, token };
  };
  const ADMIN = await mk('c_admin', { paving: 'admin', turf: 'admin' });
  const L3    = await mk('c_l3', { paving: 'level3' });
  const L2    = await mk('c_l2', { paving: 'level2', turf: 'level1' });
  const L1    = await mk('c_l1', { paving: 'level1', turf: 'level2' });
  const SALES = await mk('c_sales', { paving: 'sales', turf: 'sales' });
  const TURF  = await mk('c_turf', { turf: 'level3' });
  const KIEW  = await mk('c_kiewit', { kiewit: 'level2' });
  const DUSTY = await mk('c_dust', { dust: 'admin' });
  const PLAT  = await mk('c_platform', {}, { platform: true });
  const RIVAL = await mk('c_rival', { paving: 'admin', turf: 'admin' }, { co: CO2 });

  // ─────────────────────────────────────────────────────────────────────
  console.log('Who may read and who may write');
  {
    let r = await get(L1);
    assert('a level1 user reads the division\'s contacts (200), canEdit false', r.statusCode === 200 && r.body.ok && r.body.canEdit === false, show(r));
    for (const [who, u] of [['a level2', L2], ['a level3', L3], ['an admin', ADMIN], ['a platform admin', PLAT]]) {
      r = await get(u);
      assert(`${who} may edit them (canEdit true)`, r.statusCode === 200 && r.body.canEdit === true, show(r));
    }
    r = await get(L2, {}, 'turf');
    assert('…a level2 in paving who is level1 in turf may not edit turf\'s (levels are per division)', r.statusCode === 200 && r.body.canEdit === false, show(r));
    r = await get(SALES);
    assert('a sales login is refused (403)', r.statusCode === 403, show(r));
    r = await post(SALES, { project_id: 'job-1', email: 'a@example.com' });
    assert('…and cannot save one (403)', r.statusCode === 403, show(r));
    r = await get(TURF);
    assert('a turf-only user is refused paving (403)', r.statusCode === 403, show(r));
    r = await get(DUSTY, {}, 'dust');
    assert('a division without Custom Reporting → 400', r.statusCode === 400, show(r));
    r = await call('GET', {}, null, ADMIN);
    assert('no division → 400', r.statusCode === 400, show(r));
    r = await call('GET', P(), null, null);
    assert('no login → 401', r.statusCode === 401, show(r));
    r = await call('GET', P(), null, 'not-a-token');
    assert('a bad token → 401', r.statusCode === 401, show(r));
    r = await post(L1, { project_id: 'job-1', email: 'a@example.com' });
    assert('a level1 user cannot save a contact (403), whatever their token claims', r.statusCode === 403, show(r));
    r = await call('PATCH', P(), {}, ADMIN);
    assert('PATCH → 405', r.statusCode === 405, show(r));
    r = await call('OPTIONS', P(), {}, null);
    assert('OPTIONS → 200 without a login', r.statusCode === 200);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nSaving a contact');
  let jane, acmeGc;
  {
    let r = await post(L2, { project_id: 'job-1', name: '  Jane\u0000 Smith ', title: 'Owner\'s Rep', organization: 'Acme Township',
      email: '  Jane.Smith@Acme.example.COM ', phone: '(724) 555-0100 ext. 12', role: 'owner' });
    jane = r.body && r.body.contact;
    assert('a level2 saves a job contact (201)', r.statusCode === 201 && jane && jane.id, show(r));
    assert('…the address trimmed and lower-cased, the name cleaned', jane.email === 'jane.smith@acme.example.com' && jane.name === 'Jane Smith', JSON.stringify(jane));
    assert('…filed under the job, no client key', jane.project_id === 'job-1' && jane.client_key === null && jane.role === 'owner'
      && jane.auto_add === true && jane.phone === '(724) 555-0100 ext. 12' && jane.updated_by_username === 'c_l2', JSON.stringify(jane));
    assert('…with exactly the fields the builder reads',
      JSON.stringify(Object.keys(jane).sort()) === JSON.stringify(['auto_add', 'client_key', 'client_name', 'email', 'id', 'name', 'organization',
        'phone', 'project_id', 'role', 'title', 'updated_at', 'updated_by_username'].sort()), Object.keys(jane).join(','));
    const row = (await client.query('SELECT * FROM report_contacts WHERE id = $1', [jane.id])).rows[0];
    assert('the row is scoped to company and division, with who made it',
      row.company_code === CO && row.division === 'paving' && row.created_by_username === 'c_l2' && row.created_by_user_id === L2.id && !row.deleted_at);

    r = await post(L3, { client_name: '  Acme Township ', email: 'gc@builder.example.com', role: 'gc', auto_add: false });
    acmeGc = r.body && r.body.contact;
    assert('a client contact is filed under the client name trimmed and lower-cased',
      r.statusCode === 201 && acmeGc.client_key === 'acme township' && acmeGc.client_name === 'Acme Township' && acmeGc.project_id === null
        && acmeGc.auto_add === false, show(r));
    r = await post(ADMIN, { client_key: '  ACME Township', email: 'eng@acme.example.com' });
    assert('…a client_key alone is normalized the same way, and the role defaults to other',
      r.statusCode === 201 && r.body.contact.client_key === 'acme township' && r.body.contact.role === 'other', show(r));

    r = await post(L2, { project_id: 'job-1', email: 'JANE.SMITH@acme.example.com' });
    assert('the same address on the same job again, in any case → 409 duplicate', r.statusCode === 409 && r.body.error === 'duplicate', show(r));
    r = await post(L2, { client_name: 'Acme Township', email: 'jane.smith@acme.example.com' });
    assert('…but on the client it is a separate contact (201)', r.statusCode === 201, show(r));
    const onClient = r.body.contact;
    r = await post(L2, { project_id: 'job-1', email: 'jane.smith@acme.example.com' }, 'turf');
    assert('…and a level1 in turf cannot save it there (403)', r.statusCode === 403, show(r));
    r = await post(TURF, { project_id: 'job-1', email: 'jane.smith@acme.example.com' }, 'turf');
    assert('…while turf may hold the same address on its own job-1 (201)', r.statusCode === 201, show(r));
    r = await post(KIEW, { project_id: 'k-1', email: 'k@example.com' }, 'kiewit');
    assert('kiewit has contacts too (a level2 saves one)', r.statusCode === 201, show(r));

    const bad = [
      [{ project_id: 'job-2' }, 'no email'],
      [{ project_id: 'job-2', email: 'not an email' }, 'an invalid email'],
      [{ project_id: 'job-2', email: 'a@example..com' }, 'an email the mail service would refuse'],
      [{ project_id: 'job-2', email: 'a@example.com', phone: 'call the office' }, 'a phone with letters'],
      [{ project_id: 'job-2', email: 'a@example.com', phone: '1'.repeat(41) }, 'a 41-character phone'],
      [{ project_id: 'job-2', email: 'a@example.com', name: 'n'.repeat(121) }, 'a 121-character name'],
      [{ project_id: 'job-2', email: 'a@example.com', title: 't'.repeat(121) }, 'a 121-character title'],
      [{ project_id: 'job-2', email: 'a@example.com', organization: 'o'.repeat(121) }, 'a 121-character organization'],
      [{ project_id: 'job-2', email: 'a@example.com', role: 'boss' }, 'an unknown role'],
      [{ project_id: 'job-2', email: 'a@example.com', auto_add: 'yes' }, 'auto_add that is not true or false'],
      [{ email: 'a@example.com' }, 'neither a job nor a client'],
      [{ project_id: '   ', email: 'a@example.com' }, 'a blank job id'],
      [{ project_id: 'job-2', client_key: 'acme township', email: 'a@example.com' }, 'both a job and a client'],
      [{ client_name: 'Acme Township', client_key: 'other co', email: 'a@example.com' }, 'a client_key that is not the client_name'],
      [{ project_id: 'p'.repeat(121), email: 'a@example.com' }, 'a 121-character job id'],
      [{ project_id: { x: 1 }, email: 'a@example.com' }, 'a job id that is not text'],
    ];
    for (const [body, what] of bad) {
      r = await post(L2, body);
      assert(`${what} → 400`, r.statusCode === 400 && typeof r.body.error === 'string', show(r));
    }
    r = await post(L2, ['not', 'an', 'object']);
    assert('a body that is a list → 400', r.statusCode === 400, show(r));
    r = await post(L2, { project_id: 'job-2', email: 'max@example.com', name: 'n'.repeat(120), phone: '+1 (724) 555-0100 x 9', role: 'inspector' });
    assert('120-character names and a phone with + ( ) . - x are fine', r.statusCode === 201 && r.body.contact.role === 'inspector', show(r));
    r = await post(L2, { project_id: 'job-2', email: 'nophone@example.com', phone: '', name: '', title: null });
    assert('blank optional fields are stored as nothing', r.statusCode === 201 && r.body.contact.phone === null && r.body.contact.name === null, show(r));

    await del(L2, onClient.id);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nReading them back');
  {
    await post(L2, { project_id: 'job-3', email: 'three@example.com', name: 'Three' });
    await post(L2, { client_name: 'Oak Co', email: 'oak@example.com' });
    let r = await get(L1, { project_ids: 'job-1,job-2' });
    assert('?project_ids gives those jobs\' contacts only',
      r.statusCode === 200 && emails(r).includes('jane.smith@acme.example.com') && emails(r).includes('max@example.com')
        && !emails(r).includes('three@example.com') && !emails(r).includes('gc@builder.example.com'), emails(r).join(','));
    r = await get(L1, { client_keys: ' Acme TOWNSHIP ' });
    assert('?client_keys gives that client\'s contacts, the key compared trimmed and without case',
      JSON.stringify(emails(r).sort()) === JSON.stringify(['eng@acme.example.com', 'gc@builder.example.com']), emails(r).join(','));
    r = await get(L1, { project_ids: 'job-1', client_keys: 'acme township,oak co' });
    const kinds = r.body.contacts.map(c => (c.project_id ? 'job' : 'client'));
    assert('both together: the job\'s own contacts first, then the clients\'',
      kinds.join(',') === 'job,client,client,client' && emails(r).includes('oak@example.com'), kinds.join(',') + ' ' + emails(r).join(','));
    r = await get(L1, { project_ids: '', client_keys: '' });
    assert('an EMPTY pick returns nobody — never every customer in the division', r.statusCode === 200 && r.body.contacts.length === 0, show(r));
    r = await get(L1, { project_ids: ['job-1', 'job-3'] });
    assert('a repeated project_ids parameter works like a list', emails(r).includes('three@example.com') && emails(r).includes('jane.smith@acme.example.com'), emails(r).join(','));
    r = await get(L1, { project_ids: Array.from({ length: 201 }, (_, i) => 'j' + i).join(',') });
    assert('201 job ids → 400', r.statusCode === 400, show(r));
    r = await get(L1, { client_keys: Array.from({ length: 201 }, (_, i) => 'c' + i).join(',') });
    assert('201 client keys → 400', r.statusCode === 400, show(r));
    r = await get(L1, { project_ids: Array.from({ length: 200 }, (_, i) => 'j' + i).join(',') });
    assert('200 is fine', r.statusCode === 200, show(r));
    r = await get(L1);
    assert('with no filter, every live contact in the division',
      ['jane.smith@acme.example.com', 'gc@builder.example.com', 'three@example.com', 'oak@example.com'].every(e => emails(r).includes(e))
        && !emails(r).includes('k@example.com'), emails(r).join(','));
    assert('…not the deleted one', r.body.contacts.filter(c => c.email === 'jane.smith@acme.example.com').length === 1);
    r = await get(TURF, {}, 'turf');
    assert('turf\'s list is turf\'s', JSON.stringify(emails(r)) === '["jane.smith@acme.example.com"]' && r.body.contacts[0].project_id === 'job-1', show(r));
    r = await get(RIVAL);
    assert('another company sees none of them', r.statusCode === 200 && r.body.contacts.length === 0, show(r));
    r = await get(RIVAL, { project_ids: 'job-1' });
    assert('…not even asking for the same job id', r.body.contacts.length === 0, show(r));

    await client.query(`
      INSERT INTO report_contacts (company_code, division, project_id, email)
      SELECT $1, 'kiewit', 'bulk', 'bulk' || g || '@example.com' FROM generate_series(1, 2005) g`, [CO]);
    r = await get(KIEW, {}, 'kiewit');
    assert('the unfiltered list stops at 2000', r.body.contacts.length === 2000, r.body.contacts && r.body.contacts.length);
    r = await get(KIEW, { project_ids: 'bulk' }, 'kiewit');
    assert('…and so does a filtered one', r.body.contacts.length === 2000, r.body.contacts && r.body.contacts.length);
    await client.query("DELETE FROM report_contacts WHERE company_code = $1 AND project_id = 'bulk'", [CO]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nChanging and removing a contact');
  {
    let r = await put(L3, jane.id, { name: 'Jane Q. Smith', phone: '724-555-0199' });
    assert('a level3 changes the name and phone; the rest is kept',
      r.statusCode === 200 && r.body.contact.name === 'Jane Q. Smith' && r.body.contact.phone === '724-555-0199'
        && r.body.contact.title === 'Owner\'s Rep' && r.body.contact.role === 'owner' && r.body.contact.updated_by_username === 'c_l3', show(r));
    r = await put(L2, jane.id, { auto_add: false, role: 'engineer', phone: null });
    assert('…auto_add and role change, and a phone can be cleared', r.statusCode === 200 && r.body.contact.auto_add === false
      && r.body.contact.role === 'engineer' && r.body.contact.phone === null, show(r));
    const maxJob1 = (await post(L2, { project_id: 'job-1', email: 'max@example.com' })).body.contact;
    r = await put(L2, jane.id, { email: 'MAX@example.com' });
    assert('changing it to an address already on the same job → 409 duplicate, nothing changed',
      r.statusCode === 409 && r.body.error === 'duplicate'
        && (await client.query('SELECT email FROM report_contacts WHERE id = $1', [jane.id])).rows[0].email === 'jane.smith@acme.example.com', show(r));
    r = await put(L2, jane.id, { email: 'jane@acme.example.com' });
    assert('…a free one is fine, lower-cased', r.statusCode === 200 && r.body.contact.email === 'jane@acme.example.com', show(r));
    r = await put(L2, jane.id, { email: 'nope' });
    assert('an invalid address → 400', r.statusCode === 400, show(r));
    r = await put(L2, jane.id, { project_id: 'job-9' });
    assert('moving it to another job → 400', r.statusCode === 400 && /cannot be moved/.test(r.body.error), show(r));
    r = await put(L2, jane.id, { project_id: 'job-1', client_key: null, name: 'Jane Smith' });
    assert('…sending back the same job is fine', r.statusCode === 200 && r.body.contact.name === 'Jane Smith', show(r));
    r = await put(L2, jane.id, { client_key: 'acme township' });
    assert('…giving a job contact a client → 400', r.statusCode === 400, show(r));
    r = await put(L2, acmeGc.id, { client_name: 'ACME TOWNSHIP' });
    assert('a client contact\'s client name can be re-cased', r.statusCode === 200 && r.body.contact.client_name === 'ACME TOWNSHIP'
      && r.body.contact.client_key === 'acme township', show(r));
    r = await put(L2, acmeGc.id, { client_name: 'Oak Co' });
    assert('…but not changed to another client', r.statusCode === 400, show(r));
    r = await put(L1, jane.id, { name: 'Level one' });
    assert('a level1 user cannot change one (403)', r.statusCode === 403, show(r));
    r = await put(RIVAL, jane.id, { name: 'Rival' });
    assert('another company cannot (404)', r.statusCode === 404, show(r));
    r = await put(RIVAL, jane.id, { project_id: 'elsewhere' });
    assert('…and learns nothing about it: 404 before any other check, not "cannot be moved"', r.statusCode === 404, show(r));
    r = await put(ADMIN, jane.id, { name: 'Via turf' }, 'turf');
    assert('…nor can it be changed through another division (404)', r.statusCode === 404, show(r));
    r = await call('PUT', P(), { name: 'x' }, L2);
    assert('no id → 400', r.statusCode === 400, show(r));
    r = await put(L2, 'abc', { name: 'x' });
    assert('a junk id → 400', r.statusCode === 400, show(r));

    r = await del(L1, maxJob1.id);
    assert('a level1 user cannot remove one (403)', r.statusCode === 403, show(r));
    r = await del(RIVAL, maxJob1.id);
    assert('another company cannot (404)', r.statusCode === 404, show(r));
    r = await del(L2, maxJob1.id);
    assert('a level2 removes one', r.statusCode === 200 && r.body.id === maxJob1.id, show(r));
    const row = (await client.query('SELECT deleted_at, updated_by_username FROM report_contacts WHERE id = $1', [maxJob1.id])).rows[0];
    assert('…softly: the row stays, marked, with who removed it', row && row.deleted_at && row.updated_by_username === 'c_l2');
    assert('…and it is gone from the list', !emails(await get(L1, { project_ids: 'job-1' })).includes('max@example.com'));
    r = await del(L2, maxJob1.id);
    assert('removing it again → 404', r.statusCode === 404, show(r));
    r = await put(L2, maxJob1.id, { name: 'Zombie' });
    assert('a removed contact cannot be changed (404)', r.statusCode === 404, show(r));
    r = await post(L2, { project_id: 'job-1', email: 'max@example.com' });
    assert('…and its address can be saved on the job again', r.statusCode === 201, show(r));

    DB.fail = true;
    r = await get(L2);
    DB.fail = false;
    assert('a database failure is a 500 that says so, not a crash', r.statusCode === 500 && r.body.error === 'Database error', show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\ncontactsForJobs — the schedule runner\'s "each job\'s saved contacts"');
  {
    const sql = makeSql(client);
    await post(L2, { project_id: 'job-7', email: 'Dup@Example.com', name: 'Job Dup' });
    await post(L2, { client_name: 'Pine Co', email: 'dup@example.com', name: 'Client Dup' });
    await post(L2, { client_name: 'Pine Co', email: 'pine@example.com', name: 'Pine Person' });
    await post(L2, { client_name: 'Pine Co', email: 'quiet@example.com', auto_add: false });
    const gone = (await post(L2, { project_id: 'job-7', email: 'gone@example.com' })).body.contact;
    await del(L2, gone.id);
    await post(TURF, { project_id: 'job-7', email: 'turfonly@example.com' }, 'turf');
    await post(RIVAL, { project_id: 'job-7', email: 'rival@example.com' });

    let list = await contactsForJobs(sql, CO, 'paving', [{ id: 'job-7', client: '  PINE co ' }]);
    assert('a job\'s auto-add contacts, then its client\'s, each address once — the job\'s entry wins',
      JSON.stringify(list) === JSON.stringify([
        { email: 'dup@example.com', name: 'Job Dup', source: 'job' },
        { email: 'pine@example.com', name: 'Pine Person', source: 'client' },
      ]), JSON.stringify(list));
    assert('…not one marked "don\'t fill in", not a removed one, not another division\'s or company\'s',
      !list.some(c => ['quiet@example.com', 'gone@example.com', 'turfonly@example.com', 'rival@example.com'].includes(c.email)));
    list = await contactsForJobs(sql, CO, 'paving', [{ id: 'job-1', client: 'Acme Township' }, { id: 'job-7', client: null }, { id: 'job-3' }]);
    assert('several jobs together, deduped across them', list.some(c => c.email === 'three@example.com') && list.some(c => c.email === 'dup@example.com')
      && list.some(c => c.email === 'eng@acme.example.com') && !list.some(c => c.email === 'gc@builder.example.com')
      && new Set(list.map(c => c.email)).size === list.length, JSON.stringify(list));
    assert('nothing to look up → [] without a query', JSON.stringify(await contactsForJobs(sql, CO, 'paving', [])) === '[]'
      && JSON.stringify(await contactsForJobs(sql, CO, 'paving', [{ id: '', client: '  ' }, null])) === '[]'
      && JSON.stringify(await contactsForJobs(sql, CO, 'dust', [{ id: 'job-7' }])) === '[]'
      && JSON.stringify(await contactsForJobs(sql, '', 'paving', [{ id: 'job-7' }])) === '[]');
    list = await contactsForJobs(sql, CO, 'turf', [{ id: 'job-7' }]);
    assert('turf\'s job-7 is turf\'s', JSON.stringify(list.map(c => c.email)) === '["turfonly@example.com"]', JSON.stringify(list));
    assert('clientKeyOf trims, lower-cases and drops control characters', clientKeyOf('  Pine\tCo \n') === 'pine co' && clientKeyOf(null) === '' && clientKeyOf(42) === '42');
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe Email modal\'s "Save as contact", against the real handler');
  {
    const { JSDOM } = require('jsdom');
    const src = fs.readFileSync(path.join(ROOT, 'report-email.js'), 'utf8');
    const tick = () => new Promise(res => setTimeout(res, 10));
    async function modal(ctx, user, opts = {}) {
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const w = dom.window;
      w.localStorage.setItem('fct_token', 'page-token');
      const calls = [];
      w.fetch = async (url, o = {}) => {
        const u = new w.URL(String(url), 'http://localhost');
        if (u.pathname.endsWith('/report-contacts')) {
          calls.push({ path: u.pathname, auth: (o.headers || {}).Authorization, body: JSON.parse(o.body) });
          const res = fakeRes();
          await handler({ method: o.method || 'GET', query: Object.fromEntries(u.searchParams), body: JSON.parse(o.body || '{}'),
            headers: { authorization: (o.headers || {}).Authorization } }, res);
          return { ok: res.statusCode < 300, status: res.statusCode, text: async () => JSON.stringify(res.body), json: async () => res.body };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, isAdmin: false, groups: [] }) };
      };
      w.eval(src);
      w.openReportEmailModal({ reportType: 'paving_custom_report', getHTML: () => '<p>x</p>',
        contactContext: { getToken: () => user.token, ...ctx }, ...opts });
      const $ = id => w.document.getElementById(id);
      const m = {
        w, $, calls,
        type: v => { $('rem-input').value = v; $('rem-add').click(); },
        chip: email => w.document.querySelector(`#rem-chips > span[data-email="${email}"]`),
        status: () => ($('rem-status') || {}).textContent || '',
        msg: () => ($('rem-contact-msg') || {}).textContent || '',
        async save(email, { name, role, scope } = {}) {
          m.chip(email).querySelector('.rem-chip-save').click();
          if (name !== undefined) $('rem-contact-name').value = name;
          if (role) $('rem-contact-role').value = role;
          if (scope) $('rem-contact-scope').value = scope;
          $('rem-contact-save').click();
          for (let i = 0; i < 100 && $('rem-contact-save') && !/Couldn/.test(m.msg()); i++) await tick();
          await tick();
        },
      };
      return m;
    }
    const live = async (q) => (await client.query(`SELECT * FROM report_contacts WHERE company_code = $1 AND deleted_at IS NULL AND ${q} ORDER BY id`, [CO])).rows;

    const ctx = { division: 'paving', projectIds: ['job-9'], clients: [{ key: 'acme township', name: 'Acme Township' }], canEdit: true };
    let m = await modal(ctx, L2);
    m.type('New.Person@Example.com');
    assert('a typed address offers "☆ Save as contact"', m.chip('new.person@example.com') && /Save as contact/.test(m.chip('new.person@example.com').textContent));
    m.chip('new.person@example.com').querySelector('.rem-chip-save').click();
    const scopes = [...m.$('rem-contact-scope').options].map(o => [o.value, o.textContent]);
    assert('its form offers this job and this client', JSON.stringify(scopes) === JSON.stringify([['job', 'This job'], ['client:0', 'This client — Acme Township']]), JSON.stringify(scopes));
    m.$('rem-contact-cancel').click();
    assert('Cancel closes the form', m.$('rem-contact-form').style.display === 'none' && !m.$('rem-contact-save'));
    await m.save('new.person@example.com', { name: 'New <b>Person</b>', role: 'engineer', scope: 'job' });
    let rows = await live("email = 'new.person@example.com'");
    assert('Save posts it to /api/report-contacts as the page\'s user, filed under the job',
      rows.length === 1 && rows[0].project_id === 'job-9' && rows[0].role === 'engineer' && rows[0].name === 'New <b>Person</b>'
        && rows[0].created_by_username === 'c_l2' && rows[0].auto_add === true && m.calls[0].auth === 'Bearer ' + L2.token
        && m.calls[0].path === '/api/report-contacts', JSON.stringify(rows[0]));
    const chip = m.chip('new.person@example.com');
    assert('…the chip now shows the name (as text), marked saved, with no Save button',
      chip.firstChild.textContent === 'New <b>Person</b>' && !chip.querySelector('b') && /Saved/.test(chip.textContent)
        && !chip.querySelector('.rem-chip-save'), chip.innerHTML.slice(0, 300));
    assert('…and the modal says so', m.status() === 'Saved new.person@example.com as a contact for this job.', m.status());

    m.type('client.person@example.com');
    await m.save('client.person@example.com', { scope: 'client:0' });
    rows = await live("email = 'client.person@example.com'");
    assert('saved for the client: filed under the client key the server works out', rows.length === 1 && rows[0].client_key === 'acme township'
      && rows[0].project_id === null && rows[0].name === null && rows[0].role === 'other', JSON.stringify(rows[0]));
    assert('…said so', m.status() === 'Saved client.person@example.com as a contact for client Acme Township.', m.status());

    m.type('jane@acme.example.com');
    m.w.close();
    m = await modal(ctx, L2);
    m.type('jane@acme.example.com');
    await post(L2, { project_id: 'job-9', email: 'jane@acme.example.com' });
    await m.save('jane@acme.example.com', { scope: 'job' });
    assert('an address already saved for the job reads as saved, not as an error',
      m.status() === 'jane@acme.example.com was already a saved contact for this job.' && /Saved/.test(m.chip('jane@acme.example.com').textContent), m.status());
    m.w.close();

    m = await modal({ ...ctx, projectIds: ['job-10', 'job-11'], clients: [] }, L3);
    await post(L3, { project_id: 'job-11', email: 'both@example.com' });
    m.type('both@example.com');
    m.chip('both@example.com').querySelector('.rem-chip-save').click();
    assert('with several jobs picked the form offers "Each picked job (2)"',
      [...m.$('rem-contact-scope').options].map(o => o.textContent).join('|') === 'Each picked job (2)');
    m.$('rem-contact-save').click();
    for (let i = 0; i < 100 && m.$('rem-contact-save'); i++) await tick();
    rows = await live("email = 'both@example.com'");
    assert('…and saves it on each of them (the one it was already on counts as saved)',
      JSON.stringify(rows.map(x => x.project_id).sort()) === '["job-10","job-11"]' && m.status() === 'Saved both@example.com as a contact for 2 jobs.', m.status());
    m.w.close();

    // Jobs of two customers: a typed address is never filed on every picked
    // job (one customer's contact would later be sent the other's jobs by a
    // schedule), and the client is chosen, not defaulted.
    const two = { ...ctx, projectIds: ['job-20', 'job-21'], clients: [{ key: 'acme township', name: 'Acme Township' }, { key: 'oak llc', name: 'Oak LLC' }] };
    m = await modal(two, L2, {
      suggestedContacts: [{ email: 'Owner@Maple.example', name: 'Olivia <b>Owner</b>', source: 'job', label: 'Job contact — Maple Ave' },
        { email: 'cfo@oak.example', source: 'client', label: 'Client contact — Oak LLC' }, { email: 'not-an-email' }],
      suggestedNote: 'These jobs belong to 2 different customers — each recipient would see the others\' jobs.' });
    assert('two customers: the suggested contacts are listed, not filled in, under the warning',
      !m.$('rem-chips').querySelector('.rem-chip') && m.$('rem-suggest').style.display === 'block'
        && /2 different customers/.test(m.$('rem-suggest').querySelector('.rem-suggest-note').textContent)
        && [...m.$('rem-suggest').querySelectorAll('.rem-suggest-add')].map(b => b.getAttribute('data-email')).join() === 'owner@maple.example,cfo@oak.example'
        && !m.$('rem-suggest').querySelector('b'), m.$('rem-suggest').innerHTML.slice(0, 300));
    m.$('rem-suggest').querySelector('.rem-suggest-add[data-email="owner@maple.example"]').click();
    assert('…one click adds that one, by name, labelled, and it leaves the list',
      m.chip('owner@maple.example') && m.chip('owner@maple.example').firstChild.textContent === 'Olivia <b>Owner</b>'
        && m.chip('owner@maple.example').getAttribute('title') === 'Job contact — Maple Ave' && !m.chip('cfo@oak.example')
        && !m.$('rem-suggest').querySelector('.rem-suggest-add[data-email="owner@maple.example"]'));
    m.chip('owner@maple.example').querySelector('.rem-chip-x').click();
    assert('…removed again, it is offered again', !!m.$('rem-suggest').querySelector('.rem-suggest-add[data-email="owner@maple.example"]'));
    m.type('pm@maple.example');
    m.chip('pm@maple.example').querySelector('.rem-chip-save').click();
    const twoScopes = [...m.$('rem-contact-scope').options].map(o => [o.value, o.textContent]);
    assert('"Save as contact" offers each client, not "Each picked job", and starts on "Pick one"',
      JSON.stringify(twoScopes) === JSON.stringify([['', 'Who is it for? Pick one…'], ['client:0', 'Client — Acme Township'], ['client:1', 'Client — Oak LLC']])
        && m.$('rem-contact-scope').value === '', JSON.stringify(twoScopes));
    const before = m.calls.length;
    m.$('rem-contact-save').click();
    await tick();
    assert('…Save without picking saves nothing and says to pick', m.calls.length === before && /Pick who this contact is for/.test(m.msg())
      && (await live("email = 'pm@maple.example'")).length === 0, m.msg());
    m.$('rem-contact-scope').value = 'client:0';
    m.$('rem-contact-save').click();
    for (let i = 0; i < 100 && m.$('rem-contact-save'); i++) await tick();
    rows = await live("email = 'pm@maple.example'");
    assert('…picked, it is filed for that client only', rows.length === 1 && rows[0].client_key === 'acme township' && rows[0].project_id === null, JSON.stringify(rows));
    m.w.close();
    m = await modal({ ...ctx, projectIds: ['job-22', 'job-23'], clients: [], mixed: true }, L2);
    m.type('who@example.com');
    assert('jobs that may be different customers\' (mixed, no client named): nowhere safe to file a typed address, so no Save',
      !m.chip('who@example.com').querySelector('.rem-chip-save'));
    m.w.close();

    m = await modal(ctx, L1);
    m.type('refused@example.com');
    await m.save('refused@example.com', { scope: 'job' });
    assert('when the server refuses (a level1 user), the form says why and nothing is marked saved',
      /Couldn’t save the contact: Only admin, level 3 and level 2/.test(m.msg()) && m.$('rem-contact-save').disabled === false
        && !/Saved/.test(m.chip('refused@example.com').textContent) && (await live("email = 'refused@example.com'")).length === 0, m.msg());
    m.w.close();

    m = await modal({ ...ctx, apiBase: '/api/' }, L2, { contacts: [{ email: 'known@example.com', name: 'Known', source: 'job' }] });
    m.type('other@example.com');
    assert('a saved contact\'s chip offers no Save; a new address does',
      !m.chip('known@example.com').querySelector('.rem-chip-save') && Boolean(m.chip('other@example.com').querySelector('.rem-chip-save')));
    await m.save('other@example.com', { scope: 'job' });
    assert('apiBase with a trailing slash still reaches /api/report-contacts', m.calls[0] && m.calls[0].path === '/api/report-contacts'
      && (await live("email = 'other@example.com'")).length === 1, JSON.stringify(m.calls[0]));
    m.chip('other@example.com').querySelector('.rem-chip-x').click();
    assert('a saved chip can still be removed from this send', !m.chip('other@example.com'));
    m.w.close();

    m = await modal({ ...ctx, projectIds: [], clients: [] }, L2);
    m.type('nowhere@example.com');
    assert('with no job and no client to save to, no Save is offered', !m.chip('nowhere@example.com').querySelector('.rem-chip-save'));
    m.w.close();
  }

  await cleanUp();
  await client.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error(err);
  try { await cleanUp(); await client.end(); } catch { /* already reporting the real failure */ }
  process.exit(1);
});
