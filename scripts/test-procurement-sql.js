#!/usr/bin/env node
'use strict';
/**
 * The Procurement tab's rows (api/procurement.js) against a real Postgres.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-procurement-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql. This
 * applies the WHOLE of neon-schema.sql twice more, split the way
 * scripts/run-schema.js splits it on every deploy, so a statement that is not
 * idempotent, or that the splitter would shred, fails here before it fails a
 * deploy. Refuses a database whose name does not look like a test database;
 * it creates and removes two companies of its own.
 *
 * Every request goes through the real sign-in path (a real token, the account
 * read from the users table, the real division and level rules) and the real
 * SQL, over a connection POOL, so requests sent together really do race.
 *
 * What a stub cannot show, and this does:
 *   - Send to Procurement is idempotent because of the unique index on the
 *     bid line: twice, with a retry's same ids, or six people at once, each
 *     bid line becomes one row — and a deleted ("skipped") row is restored,
 *     never duplicated;
 *   - a PATCH changes only the cells it names, so two people editing two
 *     cells of one row at the same moment both keep their change;
 *   - every query is scoped by company AND division;
 *   - who may read, who may write and who may delete a whole job is the
 *     server's rule, not the page's;
 *   - the nightly shrink check counts the live rows, and the restore its
 *     email carries puts a deleted job's rows back.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { Pool } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'procurement-test-secret';

const CO  = 'PRTEST';
const CO2 = 'PRTEST2';
const pool = new Pool({ connectionString: URL, max: 12 });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

const DB = { fail: false, failInsert: false };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') {
    return { neon: () => {
      const sql = makeSql(pool);
      return (strings, ...values) => {
        if (DB.fail && strings.join('?').includes('procurement_items')) {
          return Promise.reject(new Error('connection reset by peer at 10.0.0.7:5432'));
        }
        // A statement that ADDS procurement rows fails (as a dropped
        // connection would): whatever it was sent with must not happen alone.
        if (DB.failInsert && strings.join('?').includes('INSERT INTO procurement_items')) {
          return Promise.reject(new Error('connection reset by peer at 10.0.0.7:5432'));
        }
        return sql(strings, ...values);
      };
    } };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const jwt = require('jsonwebtoken');
const handler = require(path.join(ROOT, 'api/procurement.js'));
const B = require(path.join(ROOT, 'api/lib/data-backup.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}
const show = r => `${r.statusCode} ${JSON.stringify(r.body)}`;
const q = (text, values = []) => pool.query(text, values).then(r => r.rows);

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
const get    = (user, qs = {}, division = 'turf') => call('GET', { division, ...qs }, null, user);
const create = (user, item, division = 'turf') => call('POST', { division }, { item }, user);
const send   = (user, body, division = 'turf') => call('POST', { division, action: 'send' }, body, user);
const patch  = (user, id, fields, division = 'turf') => call('PATCH', { division, id }, { fields }, user);
const bulk   = (user, ids, fields, extra = {}, division = 'turf') => call('PATCH', { division, action: 'bulk' }, { ids, fields, ...extra }, user);
const del    = (user, qs, division = 'turf') => call('DELETE', { division, ...qs }, null, user);
const rowOf  = async id => (await q('SELECT * FROM procurement_items WHERE id = $1', [id]))[0];

let seq = 0;
const uid = (p = 'r') => `${p}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const line = (bid, extra = {}) => ({ id: uid('s'), bid_item_id: bid, cost_code: 'Stormwater', sub_code: 'Geofabric', quantity: 901, unit: 'LF', ...extra });

const SHAPE_KEYS = ['id', 'project_id', 'source', 'bid_item_id', 'cost_code', 'sub_code', 'description', 'quantity', 'unit',
  'bid_qty_at_send', 'bid_unit_at_send', 'sca_status', 'date_needed', 'lead_time_days', 'date_ordered', 'date_delivered',
  'vendor', 'quote_number', 'contact', 'email', 'po_id', 'po_auto', 'version', 'created_at', 'created_by', 'updated_at',
  'updated_by', 'deleted_at'];

async function cleanUp() {
  for (const co of [CO, CO2]) {
    // The job blobs (bids) these tests store, and their normalized mirror.
    await q("DELETE FROM app_data WHERE key LIKE $1 || ':%'", [co]).catch(() => {});
    await q('DELETE FROM bid_items WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM projects WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM procurement_items WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM supplier_contacts WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM users WHERE company_code = $1', [co]);
    await q('DELETE FROM companies WHERE code = $1', [co]);
  }
}

// neon-schema.sql split exactly as scripts/run-schema.js splits it.
function schemaStatements() {
  return fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
}

(async () => {
  // ─────────────────────────────────────────────────────────────────────
  console.log('The schema, the way every deploy applies it');
  {
    const stmts = schemaStatements();
    const mine = stmts.filter(s => /procurement_items|supplier_contacts/.test(s));
    assert('the PROCUREMENT section is in neon-schema.sql, both tables created IF NOT EXISTS',
      mine.some(s => s.startsWith('CREATE TABLE IF NOT EXISTS procurement_items'))
        && mine.some(s => s.startsWith('CREATE TABLE IF NOT EXISTS supplier_contacts')), mine.map(s => s.slice(0, 50)).join(' | '));
    assert('…and survives the semicolon splitter: no DO blocks, no comment left inside a statement',
      mine.length >= 15 && mine.every(s => !/\$\$/.test(s) && !/--/.test(s) && !/^\s*DO\b/i.test(s)), mine.find(s => /--|\$\$/.test(s)));
    const client = await pool.connect();
    let error = null;
    try {
      for (let pass = 1; pass <= 2 && !error; pass++) {
        for (const s of stmts) {
          try { await client.query(s); } catch (err) { error = `pass ${pass}: ${err.message} in ${s.slice(0, 120)}`; break; }
        }
      }
    } finally { client.release(); }
    assert('the whole file applies twice in a row without an error (idempotent)', !error, error);
    const idx = await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'procurement_items'`);
    const bidIdx = idx.find(i => i.indexname === 'uq_procurement_items_bid_line');
    assert('the bid-line unique index covers deleted rows too (its only condition is source = bid)',
      bidIdx && /UNIQUE/.test(bidIdx.indexdef) && /WHERE \(source = 'bid'::text\)$/.test(bidIdx.indexdef), bidIdx && bidIdx.indexdef);
    assert('live rows of a job are indexed', idx.some(i => i.indexname === 'idx_procurement_items_project' && /deleted_at IS NULL/.test(i.indexdef)));
  }

  await cleanUp();
  await q("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Procurement test', '{turf,paving,kiewit,dust}')", [CO]);
  await q("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Rival Co', '{turf,paving}')", [CO2]);

  const mk = async (username, roles, { co = CO, platform = false } = {}) => {
    const id = (await q(
      "INSERT INTO users (username, company_code, password_hash, role, division_roles, is_platform_admin) VALUES ($1, $2, 'x', 'level1', $3, $4) RETURNING id",
      [username, co, JSON.stringify(roles), platform]))[0].id;
    // The token's claims are deliberately generous; the users row decides.
    const token = jwt.sign({ userId: id, username, companyCode: co, role: 'admin', divisionRoles: { turf: 'admin', paving: 'admin', kiewit: 'admin' } },
      process.env.JWT_SECRET);
    return { id, username, token };
  };
  const ADMIN = await mk('p_admin', { turf: 'admin', paving: 'admin' });
  const L3    = await mk('p_l3', { turf: 'level3' });
  const L2    = await mk('p_l2', { turf: 'level2', paving: 'level1' });
  const L1    = await mk('p_l1', { turf: 'level1', paving: 'level2' });
  const SALES = await mk('p_sales', { turf: 'sales', paving: 'sales' });
  const PAVE  = await mk('p_paving', { paving: 'level3' });
  const KIEW  = await mk('p_kiewit', { kiewit: 'level2' });
  const DUSTY = await mk('p_dust', { dust: 'admin' });
  const PLAT  = await mk('p_platform', {}, { platform: true });
  const RIVAL = await mk('p_rival', { turf: 'admin', paving: 'admin' }, { co: CO2 });

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nWho may read and who may write');
  {
    let r = await get(L1, { project_id: 'job-1' });
    assert('a level1 user reads a job\'s rows (200), canEdit false', r.statusCode === 200 && r.body.ok && r.body.canEdit === false
      && Array.isArray(r.body.items), show(r));
    for (const [who, u] of [['a level2', L2], ['a level3', L3], ['an admin', ADMIN], ['a platform admin', PLAT]]) {
      r = await get(u, { project_id: 'job-1' });
      assert(`${who} may edit (canEdit true)`, r.statusCode === 200 && r.body.canEdit === true, show(r));
    }
    r = await get(L2, { project_id: 'job-1' }, 'paving');
    assert('…a level2 in turf who is level1 in paving may not edit paving\'s (levels are per division)', r.statusCode === 200 && r.body.canEdit === false, show(r));
    r = await get(SALES, { project_id: 'job-1' });
    assert('a sales login is refused outright (403 no_access)', r.statusCode === 403 && r.body.error === 'no_access', show(r));
    r = await create(SALES, { id: uid(), project_id: 'job-1' });
    assert('…and cannot add a row (403)', r.statusCode === 403, show(r));
    r = await get(PAVE, { project_id: 'job-1' });
    assert('a paving-only user is refused turf (403)', r.statusCode === 403, show(r));
    r = await get(DUSTY, { project_id: 'job-1' }, 'dust');
    assert('a division Procurement does not serve → 400 division_not_supported', r.statusCode === 400 && r.body.error === 'division_not_supported', show(r));
    r = await call('GET', { project_id: 'job-1' }, null, ADMIN);
    assert('no division → 400 (never a turf default)', r.statusCode === 400, show(r));
    r = await call('POST', {}, { item: { id: uid(), project_id: 'job-1' } }, ADMIN);
    assert('…a write without a division too', r.statusCode === 400, show(r));
    r = await call('GET', { division: 'turf', project_id: 'job-1' }, null, null);
    assert('no login → 401', r.statusCode === 401, show(r));
    r = await call('GET', { division: 'turf', project_id: 'job-1' }, null, 'not-a-token');
    assert('a bad token → 401', r.statusCode === 401, show(r));
    r = await get(L1);
    assert('GET without a project → 400 project_id_required', r.statusCode === 400 && r.body.error === 'project_id_required', show(r));
    r = await call('PUT', { division: 'turf' }, {}, ADMIN);
    assert('PUT → 405', r.statusCode === 405, show(r));
    r = await call('OPTIONS', { division: 'turf' }, {}, null);
    assert('OPTIONS → 200 without a login', r.statusCode === 200);

    const id = uid();
    for (const [what, p] of [
      ['add a row', () => create(L1, { id, project_id: 'job-1' })],
      ['send bid lines', () => send(L1, { project_id: 'job-1', items: [line('b-x')] })],
      ['change a cell', () => patch(L1, id, { vendor: 'X' })],
      ['bulk edit', () => bulk(L1, [id], { vendor: 'X' })],
      ['delete a row', () => del(L1, { id })],
      ['delete a job\'s rows', () => del(L1, { project_id: 'job-1' })],
    ]) {
      r = await p();
      assert(`a level1 user cannot ${what} (403 read_only), whatever the token claims`, r.statusCode === 403 && r.body.error === 'read_only', show(r));
    }
    assert('…and nothing was written', (await q('SELECT 1 FROM procurement_items WHERE company_code = $1', [CO])).length === 0);
    r = await create(L1, { id: uid(), project_id: 'p-1' }, 'paving');
    assert('…while the same person, level2 in paving, may add a paving row (201)', r.statusCode === 201 && r.body.item.project_id === 'p-1', show(r));
    r = await create(KIEW, { id: uid(), project_id: 'k-1', description: 'Kiewit stone' }, 'kiewit');
    assert('kiewit is served too (a level2 adds a row)', r.statusCode === 201, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nAdding a row by hand');
  let manual;
  {
    const id = uid('m');
    let r = await create(L2, { id, project_id: 'job-1', source: 'bid', version: 99, created_by: 'someone else', deleted_at: '2020-01-01',
      cost_code: ' Stormwater ', sub_code: 'Geo\u0000fabric', description: 'Black\tnon-woven,\nroll 12.5 ft', quantity: '1,200',
      unit: 'LF', date_needed: '2026-12-01', lead_time_days: '14', vendor: 'Acme Supply', quote_number: 'Q-77',
      contact: 'Pat', email: '(724) 555-0100' });
    manual = r.body && r.body.item;
    assert('a level2 adds a row (201)', r.statusCode === 201 && manual && manual.id === id, show(r));
    assert('…with exactly the fields of the contract', manual && JSON.stringify(Object.keys(manual).sort()) === JSON.stringify(SHAPE_KEYS.slice().sort()),
      manual && Object.keys(manual).join(','));
    assert('…always a manual row, whatever source, version or audit fields the body claims', manual.source === 'manual' && manual.version === 1
      && manual.created_by === 'p_l2' && manual.updated_by === 'p_l2' && manual.deleted_at === null, JSON.stringify(manual));
    assert('…text trimmed, NUL dropped, control characters turned into spaces', manual.cost_code === 'Stormwater' && manual.sub_code === 'Geofabric'
      && manual.description === 'Black non-woven, roll 12.5 ft', JSON.stringify(manual));
    assert('…"1,200" read as 1200 and "14" as 14 days', manual.quantity === 1200 && manual.lead_time_days === 14, JSON.stringify(manual));
    assert('…dates come back as YYYY-MM-DD', manual.date_needed === '2026-12-01' && manual.date_ordered === null, JSON.stringify(manual));
    assert('…an "email" that is a phone number is kept as typed (never checked for shape)', manual.email === '(724) 555-0100');
    assert('…defaults: SCA Pending, PO auto-match on, no PO, no bid line', manual.sca_status === 'Pending' && manual.po_auto === true
      && manual.po_id === null && manual.bid_item_id === null && manual.bid_qty_at_send === null && manual.bid_unit_at_send === null, JSON.stringify(manual));
    const row = await rowOf(id);
    assert('the row is scoped to company and division', row.company_code === CO && row.division === 'turf' && row.project_id === 'job-1');

    r = await create(L3, { id, project_id: 'job-1' });
    assert('the same id again → 409 duplicate', r.statusCode === 409 && r.body.error === 'duplicate', show(r));

    r = await create(L2, { id: uid('m'), project_id: 'job-1', bid_item_id: 'b-geo', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SY',
      sca_status: 'Needed', po_auto: false, date_needed: '', quantity: '', lead_time_days: '' });
    assert('"+ Material": a manual row may carry a bid line\'s codes; blanks are blank', r.statusCode === 201 && r.body.item.bid_item_id === 'b-geo'
      && r.body.item.sca_status === 'Needed' && r.body.item.po_auto === false && r.body.item.date_needed === null
      && r.body.item.quantity === null && r.body.item.lead_time_days === null, show(r));

    const ok = [
      [{ description: 'd'.repeat(500) }, '500-character description'],
      [{ lead_time_days: 0 }, 'lead time 0'], [{ lead_time_days: 3650 }, 'lead time 3650'],
      [{ quantity: '$1,234.50' }, 'quantity "$1,234.50"'], [{ quantity: -3 }, 'a negative quantity (a credit)'],
      [{ date_needed: '2028-02-29' }, 'a leap day'], [{ sca_status: 'Not Needed' }, 'SCA Not Needed'],
      [{ vendor: 'v'.repeat(120), quote_number: 'q'.repeat(120), contact: 'c'.repeat(120), email: 'e'.repeat(200), unit: 'u'.repeat(20) }, 'every text field at its limit'],
    ];
    for (const [extra, what] of ok) {
      r = await create(L2, { id: uid('ok'), project_id: 'job-ok', ...extra });
      assert(`${what} is fine (201)`, r.statusCode === 201, show(r));
    }
    r = await get(L2, { project_id: 'job-ok' });
    assert('…and reads back as sent', r.body.items.some(i => i.quantity === 1234.5) && r.body.items.some(i => i.quantity === -3)
      && r.body.items.some(i => i.date_needed === '2028-02-29'), JSON.stringify(r.body.items.map(i => [i.quantity, i.date_needed])));

    const bad = [
      [{ id: 'has space' }, 'id', 'an id with a space'],
      [{ id: 'x'.repeat(65) }, 'id', 'a 65-character id'],
      [{ id: 42 }, 'id', 'an id that is a number'],
      [{ project_id: '' }, 'project_id', 'a blank job'],
      [{ project_id: 'p'.repeat(121) }, 'project_id', 'a 121-character job id'],
      [{ sca_status: 'Maybe' }, 'sca_status', 'an SCA status not in the list'],
      [{ date_needed: '2026-02-30' }, 'date_needed', 'February 30th'],
      [{ date_ordered: '02/03/2026' }, 'date_ordered', 'a date not in YYYY-MM-DD'],
      [{ date_delivered: '0026-01-05' }, 'date_delivered', 'year 0026'],
      [{ date_needed: 20261201 }, 'date_needed', 'a date that is a number'],
      [{ quantity: 'abc' }, 'quantity', 'quantity "abc"'],
      [{ quantity: '12 ft' }, 'quantity', 'quantity "12 ft" (parseFloat would keep the 12)'],
      [{ quantity: '1e3' }, 'quantity', 'quantity in exponent notation'],
      [{ quantity: 1e13 }, 'quantity', 'a quantity past a trillion'],
      [{ bid_qty_at_send: 'lots' }, 'bid_qty_at_send', 'a bid quantity that is not a number'],
      [{ lead_time_days: -1 }, 'lead_time_days', 'lead time -1'],
      [{ lead_time_days: 3651 }, 'lead_time_days', 'lead time 3651'],
      [{ lead_time_days: 1.5 }, 'lead_time_days', 'lead time 1.5'],
      [{ lead_time_days: 'ten' }, 'lead_time_days', 'lead time "ten"'],
      [{ po_auto: 'yes' }, 'po_auto', 'po_auto that is not true or false'],
      [{ description: 'd'.repeat(501) }, 'description', 'a 501-character description'],
      [{ vendor: 'v'.repeat(121) }, 'vendor', 'a 121-character vendor'],
      [{ quote_number: 'q'.repeat(121) }, 'quote_number', 'a 121-character quote #'],
      [{ contact: 'c'.repeat(121) }, 'contact', 'a 121-character contact'],
      [{ email: 'e'.repeat(201) }, 'email', 'a 201-character email'],
      [{ unit: 'u'.repeat(21) }, 'unit', 'a 21-character unit'],
      [{ cost_code: 'c'.repeat(201) }, 'cost_code', 'a 201-character cost code'],
      [{ sub_code: { x: 1 } }, 'sub_code', 'a sub code that is not text'],
      [{ bid_item_id: 'b'.repeat(65) }, 'bid_item_id', 'a 65-character bid line id'],
      [{ po_id: 'p'.repeat(65) }, 'po_id', 'a 65-character PO id'],
    ];
    for (const [extra, field, what] of bad) {
      r = await create(L2, { id: uid('bad'), project_id: 'job-bad', ...extra });
      assert(`${what} → 400 naming ${field}`, r.statusCode === 400 && r.body.ok === false && r.body.field === field
        && typeof r.body.message === 'string', show(r));
    }
    r = await call('POST', { division: 'turf' }, { item: 'nope' }, L2);
    assert('an item that is not an object → 400', r.statusCode === 400, show(r));
    r = await call('POST', { division: 'turf' }, ['not', 'an', 'object'], L2);
    assert('a body that is a list → 400', r.statusCode === 400, show(r));
    r = await call('POST', { division: 'turf', action: 'explode' }, { item: { id: uid(), project_id: 'job-1' } }, L2);
    assert('an unknown action → 400', r.statusCode === 400, show(r));
    assert('nothing refused was stored', (await q("SELECT 1 FROM procurement_items WHERE project_id = 'job-bad'")).length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nSend to Procurement');
  let sent;
  {
    const lines = [line('b-1', { quantity: '1,200.5' }), line('b-2', { sub_code: 'Inlet protection', unit: 'EA', quantity: 4 }),
      line('b-3', { cost_code: 'General', sub_code: 'Mobilization', unit: 'LS', quantity: 1 })];
    let r = await send(L2, { project_id: 'job-1', items: lines, restore_ids: [] });
    sent = r.body && r.body.created;
    assert('a level2 sends three bid lines: three rows, none skipped', r.statusCode === 200 && r.body.ok && sent.length === 3
      && r.body.restored.length === 0 && r.body.skipped === 0, show(r));
    const one = sent.find(i => i.bid_item_id === 'b-1');
    assert('…source bid, codes, quantity and unit from the bid', one && one.source === 'bid' && one.cost_code === 'Stormwater'
      && one.sub_code === 'Geofabric' && one.quantity === 1200.5 && one.unit === 'LF', JSON.stringify(one));
    assert('…and what the bid said at send, for the "bid changed" badge', one.bid_qty_at_send === 1200.5 && one.bid_unit_at_send === 'LF', JSON.stringify(one));
    assert('…filed under the job and the sender', sent.every(i => i.project_id === 'job-1' && i.created_by === 'p_l2' && i.sca_status === 'Pending'));
    r = await get(L1, { project_id: 'job-1' });
    const bidRows = r.body.items.filter(i => i.source === 'bid');
    assert('GET lists them in the order they were sent (created_at, id)', JSON.stringify(bidRows.map(i => i.bid_item_id)) === '["b-1","b-2","b-3"]',
      JSON.stringify(bidRows.map(i => i.bid_item_id)));

    const count = async (pid = 'job-1') => Number((await q("SELECT count(*) FROM procurement_items WHERE company_code = $1 AND project_id = $2 AND source = 'bid'", [CO, pid]))[0].count);
    r = await send(L3, { project_id: 'job-1', items: [line('b-1'), line('b-2'), line('b-3')] });
    assert('sending the same lines again (new ids) adds nothing: all skipped', r.statusCode === 200 && r.body.created.length === 0 && r.body.skipped === 3, show(r));
    r = await send(L2, { project_id: 'job-1', items: lines });
    assert('a retry with the very same ids adds nothing and is not an error', r.statusCode === 200 && r.body.created.length === 0 && r.body.skipped === 3, show(r));
    assert('…still three bid rows on the job', await count() === 3, await count());
    r = await send(L2, { project_id: 'job-1', items: [line('b-4'), line('b-4')] });
    assert('the same bid line twice in one send is one row (the second skipped)', r.statusCode === 200 && r.body.created.length === 1 && r.body.skipped === 1, show(r));
    r = await send(L2, { project_id: 'job-2', items: [line('b-1')] });
    assert('…while another job may hold the same bid line id', r.statusCode === 200 && r.body.created.length === 1, show(r));

    // Six people pressing Send on the same job at the same moment.
    const fresh = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5'];
    const results = await Promise.all(Array.from({ length: 6 }, (_, k) =>
      send(k % 2 ? L2 : L3, { project_id: 'job-race', items: fresh.map(b => line(b)) })));
    const createdTotal = results.reduce((n, x) => n + (x.body && x.body.created ? x.body.created.length : 0), 0);
    assert('six concurrent sends of five lines: every one answers 200', results.every(x => x.statusCode === 200), results.map(show).join(' | '));
    assert('…five rows in all, one per bid line, never a duplicate', createdTotal === 5 && await count('job-race') === 5, `${createdTotal} / ${await count('job-race')}`);
    assert('…and the rest report them as skipped', results.reduce((n, x) => n + x.body.skipped, 0) === 25);

    r = await send(L2, { project_id: 'job-1', items: [] , restore_ids: [] });
    assert('an empty send is fine and does nothing', r.statusCode === 200 && r.body.created.length === 0 && r.body.skipped === 0, show(r));
    const dupId = uid();
    const badSends = [
      [{ items: [line('b-9')] }, 'no job'],
      [{ project_id: 'job-1', items: 'b-9' }, 'items that is not a list'],
      [{ project_id: 'job-1', items: [{ ...line('b-9'), bid_item_id: '' }] }, 'a line with no bid line id'],
      [{ project_id: 'job-1', items: [{ ...line('b-9'), id: 'bad id' }] }, 'a line with a bad id'],
      [{ project_id: 'job-1', items: [{ ...line('b-9'), id: dupId }, { ...line('b-10'), id: dupId }] }, 'two lines with one id'],
      [{ project_id: 'job-1', items: [line('b-9', { quantity: 'many' })] }, 'a quantity that is not a number'],
      [{ project_id: 'job-1', items: [line('b-9', { unit: 'u'.repeat(21) })] }, 'a 21-character unit'],
      [{ project_id: 'job-1', items: [null] }, 'a line that is not an object'],
      [{ project_id: 'job-1', items: [], restore_ids: 'nope' }, 'restore_ids that is not a list of ids'],
      [{ project_id: 'job-1', items: Array.from({ length: 2001 }, (_, k) => line('z-' + k)) }, '2001 lines (the cap is 2000)'],
    ];
    for (const [body, what] of badSends) {
      r = await send(L2, body);
      assert(`${what} → 400, nothing sent`, r.statusCode === 400 && r.body.ok === false, show(r));
    }
    assert('…no b-9 row anywhere', (await q("SELECT 1 FROM procurement_items WHERE bid_item_id IN ('b-9','b-10')")).length === 0);
    r = await send(L2, { project_id: 'job-cap', items: Array.from({ length: 2000 }, (_, k) => line('cap-' + k)) });
    assert('2000 lines in one send are fine, in one statement', r.statusCode === 200 && r.body.created.length === 2000, show(r).slice(0, 200));
    await q("DELETE FROM procurement_items WHERE company_code = $1 AND project_id = 'job-cap'", [CO]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA skipped (deleted) bid line comes back as the same row');
  {
    const b2 = sent.find(i => i.bid_item_id === 'b-2');
    await patch(L2, b2.id, { vendor: 'Inlet Co', quote_number: 'Q-2' });
    let r = await del(L2, { id: b2.id });
    assert('a level2 deletes the bid row (skip this material)', r.statusCode === 200 && r.body.deleted === 1, show(r));
    r = await get(L1, { project_id: 'job-1' });
    assert('…it is gone from the live list', !r.body.items.some(i => i.id === b2.id));
    r = await get(L1, { project_id: 'job-1', include_deleted: '1' });
    const gone = r.body.items.find(i => i.id === b2.id);
    assert('…include_deleted=1 lists it, with its deleted_at, for "removed earlier"', gone && gone.deleted_at && r.body.items.some(i => !i.deleted_at), show(r).slice(0, 300));
    const row = await rowOf(b2.id);
    assert('…soft: the row stays, marked with who deleted it', row.deleted_at && row.deleted_by === 'p_l2');

    r = await send(L2, { project_id: 'job-1', items: [line('b-2')] });
    assert('sending that line again WITHOUT restoring it adds nothing (the skip is remembered)', r.body.created.length === 0 && r.body.skipped === 1
      && Number((await q("SELECT count(*) FROM procurement_items WHERE company_code = $1 AND project_id = 'job-1' AND bid_item_id = 'b-2'", [CO]))[0].count) === 1, show(r));
    assert('…and it stays deleted', Boolean((await rowOf(b2.id)).deleted_at));

    const otherJob = (await send(L2, { project_id: 'job-3', items: [line('b-77')] })).body.created[0];
    await del(L2, { id: otherJob.id });
    const live = sent.find(i => i.bid_item_id === 'b-1');
    r = await send(L3, { project_id: 'job-1', items: [line('b-2'), line('b-5')], restore_ids: [b2.id, otherJob.id, live.id] });
    assert('ticking it again restores it: restored 1, plus the one new line', r.statusCode === 200 && r.body.restored.length === 1
      && r.body.restored[0].id === b2.id && r.body.created.length === 1 && r.body.created[0].bid_item_id === 'b-5' && r.body.skipped === 1, show(r));
    const back = r.body.restored[0];
    assert('…the same row, with what was typed on it before, and a new version', back.vendor === 'Inlet Co' && back.quote_number === 'Q-2'
      && back.deleted_at === null && back.version > b2.version && back.updated_by === 'p_l3', JSON.stringify(back));
    assert('…another job\'s deleted row named in restore_ids is not touched', Boolean((await rowOf(otherJob.id)).deleted_at));
    r = await get(L1, { project_id: 'job-1' });
    assert('…and the job holds one row per bid line', r.body.items.filter(i => i.bid_item_id === 'b-2').length === 1);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nAfter a Procore "Replace all": a skipped line comes back tied to its new id');
  {
    // Sent from the old bid, a quote typed on it, then deleted on purpose.
    const old = (await send(L2, { project_id: 'job-ra', items: [line('ra-old-1', { cost_code: 'E&S', sub_code: 'Silt Sock 12inch' })] })).body.created[0];
    await patch(L2, old.id, { quote_number: 'Q-SILT-1' });
    await del(L2, { id: old.id });
    // The bid is replaced: the line is now 'ra-new-1'. A deleted row cannot be
    // PATCHed, so the restore carries the new link.
    let r = await patch(L2, old.id, { bid_item_id: 'ra-new-1' });
    assert('a deleted row cannot be re-linked by PATCH (404)', r.statusCode === 404, show(r));
    r = await send(L2, { project_id: 'job-ra', items: [], restore_ids: [{ id: old.id, bid_item_id: 'ra-new-1', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }] });
    const back = r.body.restored && r.body.restored[0];
    assert('restore_ids { id, bid_item_id, … } brings the same row back on the new line', r.statusCode === 200 && back && back.id === old.id
      && back.bid_item_id === 'ra-new-1' && back.cost_code === 'E&S' && back.sub_code === 'Silt Sock 12inch' && back.quote_number === 'Q-SILT-1'
      && back.deleted_at === null, show(r));
    r = await send(L2, { project_id: 'job-ra', items: [line('ra-new-1', { cost_code: 'E&S', sub_code: 'Silt Sock 12inch' })] });
    assert('…and the new line is then its line: sending it again adds nothing', r.body.created.length === 0 && r.body.skipped === 1, show(r));

    // A plain id and a re-link in one send; another bid row already on the target line refuses the whole restore.
    const a = (await send(L2, { project_id: 'job-ra', items: [line('ra-a', { sub_code: 'A' }), line('ra-b', { sub_code: 'B' }), line('ra-c', { sub_code: 'C' })] })).body.created;
    await del(L2, { ids: a.map(x => x.id).join(',') });
    r = await send(L2, { project_id: 'job-ra', items: [], restore_ids: [a[0].id, { id: a[1].id, bid_item_id: 'ra-b2', cost_code: 'Stormwater', sub_code: 'B' }] });
    assert('a plain id and a re-link entry in one send: each restored its own way', r.statusCode === 200 && r.body.restored.length === 2
      && r.body.restored.find(x => x.id === a[0].id).bid_item_id === 'ra-a' && r.body.restored.find(x => x.id === a[1].id).bid_item_id === 'ra-b2', show(r));
    const v0 = (await rowOf(a[2].id)).version;
    r = await send(L2, { project_id: 'job-ra', items: [line('ra-new-x')], restore_ids: [{ id: a[2].id, bid_item_id: 'ra-b2', cost_code: 'Stormwater', sub_code: 'C' }] });
    assert('re-linking onto a line another bid row already has → 409, nothing restored or sent', r.statusCode === 409 && r.body.error === 'duplicate'
      && Boolean((await rowOf(a[2].id)).deleted_at) && (await rowOf(a[2].id)).version === v0
      && (await q("SELECT 1 FROM procurement_items WHERE bid_item_id = 'ra-new-x'")).length === 0, show(r));
    assert('…and the answer names the line that is taken', /"Stormwater \/ B"/.test(r.body.message || '') && JSON.stringify(r.body.lines) === '["ra-b2"]', show(r));

    // The restore and the new lines are one statement: a send whose insert
    // fails restores nothing either, and the same send tried again works.
    DB.failInsert = true;
    r = await send(L2, { project_id: 'job-ra', items: [line('ra-new-y')], restore_ids: [a[2].id] });
    DB.failInsert = false;
    assert('a send whose new lines fail to go in restores nothing either (500, nothing half done)', r.statusCode === 500
      && Boolean((await rowOf(a[2].id)).deleted_at) && (await rowOf(a[2].id)).version === v0
      && (await q("SELECT 1 FROM procurement_items WHERE bid_item_id = 'ra-new-y'")).length === 0, show(r));
    r = await send(L2, { project_id: 'job-ra', items: [line('ra-new-y')], restore_ids: [a[2].id] });
    assert('…and sent again it all happens', r.statusCode === 200 && r.body.restored.length === 1 && r.body.created.length === 1
      && !(await rowOf(a[2].id)).deleted_at, show(r));
    await del(L2, { id: a[2].id });          // deleted again, for the checks below
    for (const [entry, what] of [
      [{ id: 'bad id', bid_item_id: 'x' }, 'a re-link entry with a bad id'],
      [{ id: a[2].id }, 'a re-link entry with no bid line'],
      [{ id: a[2].id, bid_item_id: 'x', cost_code: 'c'.repeat(201) }, 'a re-link entry with a 201-character cost code'],
      [42, 'an entry that is neither an id nor an object'],
    ]) {
      r = await send(L2, { project_id: 'job-ra', items: [], restore_ids: [entry] });
      assert(`${what} → 400`, r.statusCode === 400 && r.body.field === 'restore_ids', show(r));
    }
    const otherCo = await send(RIVAL, { project_id: 'job-ra', items: [], restore_ids: [{ id: a[2].id, bid_item_id: 'ra-z', cost_code: '', sub_code: '' }] });
    assert('another company naming the row restores nothing', otherCo.statusCode === 200 && otherCo.body.restored.length === 0 && Boolean((await rowOf(a[2].id)).deleted_at), show(otherCo));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nChanging cells');
  {
    const b1 = (await get(L2, { project_id: 'job-1' })).body.items.find(i => i.bid_item_id === 'b-1');
    let r = await patch(L2, b1.id, { vendor: '  Acme Supply ' });
    assert('a level2 changes one cell: only that one changes, version + 1, who and when', r.statusCode === 200 && r.body.item.vendor === 'Acme Supply'
      && r.body.item.version === b1.version + 1 && r.body.item.updated_by === 'p_l2' && r.body.item.quantity === b1.quantity
      && r.body.item.description === b1.description && r.body.item.sca_status === b1.sca_status, show(r));

    // Two people, two cells of one row, at the same moment — and five more.
    const before = (await rowOf(b1.id)).version;
    const edits = [
      [L2, { date_needed: '2026-12-15' }], [L3, { description: 'Mirafi 140N' }], [ADMIN, { lead_time_days: 21 }],
      [L2, { quote_number: 'Q-1001' }], [L3, { sca_status: 'Executed' }], [ADMIN, { contact: 'Dana', email: 'dana@acme.example' }],
      [L2, { quantity: 950, unit: 'LF' }],
    ];
    const results = await Promise.all(edits.map(([u, f]) => patch(u, b1.id, f)));
    assert('seven people change seven different cells of one row at once: every save answers 200', results.every(x => x.statusCode === 200), results.map(show).join(' | '));
    const after = await rowOf(b1.id);
    const d = v => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v);
    assert('…and every change survives: none of them wrote back a stale copy of the others',
      d(after.date_needed) === '2026-12-15' && after.description === 'Mirafi 140N' && after.lead_time_days === 21 && after.quote_number === 'Q-1001'
        && after.sca_status === 'Executed' && after.contact === 'Dana' && after.email === 'dana@acme.example' && Number(after.quantity) === 950
        && after.vendor === 'Acme Supply', JSON.stringify(after));
    assert('…the version went up once per save', after.version === before + edits.length, `${before} → ${after.version}`);

    // The slow case: a tab that loaded long ago saves one cell.
    r = await patch(L3, b1.id, { po_auto: false });
    assert('a save from a stale tab sends only its cell and leaves the newer ones alone',
      r.statusCode === 200 && r.body.item.po_auto === false && r.body.item.description === 'Mirafi 140N' && r.body.item.vendor === 'Acme Supply', show(r));

    r = await patch(L2, b1.id, { date_needed: '', quantity: '', lead_time_days: null, po_id: 'po-123', po_auto: true });
    assert('cells are cleared with "" or null; a PO is linked by id', r.statusCode === 200 && r.body.item.date_needed === null
      && r.body.item.quantity === null && r.body.item.lead_time_days === null && r.body.item.po_id === 'po-123', show(r));
    r = await patch(L2, b1.id, { po_id: null, po_auto: false });
    assert('…and "No PO" is no po_id with auto-match off', r.body.item.po_id === null && r.body.item.po_auto === false, show(r));
    r = await patch(L2, b1.id, { quantity: 950, unit: 'LF', bid_qty_at_send: 950, bid_unit_at_send: 'LF' });
    assert('"Use bid qty" sets the quantity and what the bid said in one save', r.statusCode === 200 && r.body.item.quantity === 950
      && r.body.item.bid_qty_at_send === 950 && r.body.item.bid_unit_at_send === 'LF', show(r));
    r = await patch(L2, b1.id, { bid_unit_at_send: '' });
    assert('…a bid line with no unit is remembered as "" (not as never sent)', r.body.item.bid_unit_at_send === '', show(r));

    const notAllowed = ['id', 'project_id', 'source', 'company_code', 'division', 'version', 'created_by', 'updated_at', 'deleted_at', 'po_number'];
    for (const k of notAllowed) {
      r = await patch(L2, b1.id, { [k]: 'x', vendor: 'Nope' });
      assert(`${k} cannot be changed → 400 field_not_allowed`, r.statusCode === 400 && r.body.error === 'field_not_allowed' && r.body.field === k, show(r));
    }
    assert('…and the cell sent beside it was not saved either', (await rowOf(b1.id)).vendor === 'Acme Supply');
    r = await patch(L2, b1.id, {});
    assert('an empty change → 400 no_fields', r.statusCode === 400 && r.body.error === 'no_fields', show(r));
    r = await call('PATCH', { division: 'turf', id: b1.id }, { vendor: 'unwrapped' }, L2);
    assert('fields not wrapped in { fields } → 400', r.statusCode === 400, show(r));
    for (const [f, what] of [[{ date_needed: '2026-13-01' }, 'month 13'], [{ sca_status: '' }, 'a blank SCA status'],
      [{ lead_time_days: 4000 }, 'lead time 4000'], [{ quantity: 'NaN' }, 'quantity NaN'], [{ po_auto: 1 }, 'po_auto 1']]) {
      r = await patch(L2, b1.id, f);
      assert(`${what} → 400`, r.statusCode === 400 && r.body.field === Object.keys(f)[0], show(r));
    }
    r = await patch(L2, b1.id, { bid_item_id: null });
    assert('a bid row cannot lose its bid line → 400', r.statusCode === 400 && r.body.error === 'invalid' && /bid line/.test(r.body.message), show(r));
    r = await patch(L2, manual.id, { bid_item_id: 'b-3', cost_code: 'General', sub_code: 'Mobilization' });
    assert('…a manual row can pick (or drop) one freely', r.statusCode === 200 && r.body.item.bid_item_id === 'b-3', show(r));
    const b3 = sent.find(i => i.bid_item_id === 'b-3');
    r = await patch(L3, b1.id, { bid_item_id: 'b-3' });
    assert('re-linking a bid row to a line another bid row holds → 409 duplicate', r.statusCode === 409 && r.body.error === 'duplicate'
      && (await rowOf(b1.id)).bid_item_id === 'b-1', show(r));
    r = await patch(L3, b3.id, { bid_item_id: 'b-3-new', cost_code: 'General', sub_code: 'Mobilization' });
    assert('…to a free one (after a Procore "Replace all") is fine', r.statusCode === 200 && r.body.item.bid_item_id === 'b-3-new', show(r));

    r = await patch(L2, 'no-such-row', { vendor: 'X' });
    assert('a row that does not exist → 404', r.statusCode === 404 && r.body.error === 'not_found', show(r));
    r = await call('PATCH', { division: 'turf' }, { fields: { vendor: 'X' } }, L2);
    assert('no id → 400 id_required', r.statusCode === 400 && r.body.error === 'id_required', show(r));
    r = await patch(L2, 'bad id!', { vendor: 'X' });
    assert('a junk id → 400', r.statusCode === 400, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nBulk edit');
  {
    const j1 = (await get(L2, { project_id: 'job-1' })).body.items;
    const ids = j1.map(i => i.id);
    let r = await bulk(L2, ids, { vendor: 'Bulk Supply', quote_number: 'Q-9', date_needed: '2027-01-04' });
    assert('a level2 sets the vendor, quote and date on every row of a job in one save', r.statusCode === 200 && r.body.items.length === ids.length
      && r.body.items.every(i => i.vendor === 'Bulk Supply' && i.quote_number === 'Q-9' && i.date_needed === '2027-01-04') && r.body.missing.length === 0, show(r).slice(0, 300));
    assert('…the cells it did not name are left alone', r.body.items.find(i => i.id === manual.id).description === manual.description);
    const job2 = (await get(L2, { project_id: 'job-2' })).body.items[0];
    r = await bulk(L2, [ids[0], job2.id], { vendor: 'Wrong' });
    assert('rows of two jobs in one bulk edit → 400 mixed_projects', r.statusCode === 400 && r.body.error === 'mixed_projects', show(r));
    assert('…and neither job was touched', (await rowOf(ids[0])).vendor === 'Bulk Supply' && (await rowOf(job2.id)).vendor === '');
    r = await bulk(L2, [ids[0]], { vendor: 'Wrong' }, { project_id: 'job-2' });
    assert('rows that are not on the job the page says → 400 mixed_projects', r.statusCode === 400 && r.body.error === 'mixed_projects', show(r));
    const deletedOne = (await send(L2, { project_id: 'job-1', items: [line('b-del')] })).body.created[0];
    await del(L2, { id: deletedOne.id });
    r = await bulk(L3, [ids[0], deletedOne.id, 'never-was'], { sca_status: 'Needed' });
    assert('rows gone since the page loaded are reported as missing; the rest are saved', r.statusCode === 200 && r.body.items.length === 1
      && JSON.stringify(r.body.missing.sort()) === JSON.stringify([deletedOne.id, 'never-was'].sort()), show(r));
    r = await bulk(L3, ['never-was'], { sca_status: 'Needed' });
    assert('…none of them left → 404', r.statusCode === 404, show(r));
    r = await bulk(RIVAL, [ids[0]], { vendor: 'Rival' });
    assert('another company\'s rows are not found (404)', r.statusCode === 404 && (await rowOf(ids[0])).vendor === 'Bulk Supply', show(r));
    r = await bulk(L2, Array.from({ length: 2001 }, (_, k) => 'x' + k), { vendor: 'X' });
    assert('2001 ids → 400 too_many', r.statusCode === 400 && r.body.error === 'too_many', show(r));
    r = await bulk(L2, [], { vendor: 'X' });
    assert('no ids → 400', r.statusCode === 400, show(r));
    r = await bulk(L2, ids, { project_id: 'job-2' });
    assert('a field a PATCH may not change → 400 here too', r.statusCode === 400 && r.body.error === 'field_not_allowed', show(r));
    r = await bulk(L2, ids, { lead_time_days: -5 });
    assert('…and a bad value → 400 naming it', r.statusCode === 400 && r.body.field === 'lead_time_days', show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nCompany and division scoping');
  {
    let r = await get(RIVAL, { project_id: 'job-1' });
    assert('another company reading the same job id sees none of it', r.statusCode === 200 && r.body.items.length === 0, show(r));
    r = await get(RIVAL, { project_id: 'job-1', include_deleted: '1' });
    assert('…deleted rows included', r.body.items.length === 0, show(r));
    r = await patch(RIVAL, manual.id, { vendor: 'Rival' });
    assert('…cannot change one of its rows (404)', r.statusCode === 404, show(r));
    r = await del(RIVAL, { id: manual.id });
    assert('…cannot delete one (404)', r.statusCode === 404 && !(await rowOf(manual.id)).deleted_at, show(r));
    r = await del(RIVAL, { project_id: 'job-1' });
    assert('…and deleting "its" job-1 deletes nothing of ours', r.statusCode === 200 && r.body.deleted === 0, show(r));
    r = await send(RIVAL, { project_id: 'job-1', items: [line('b-1')] });
    assert('…while it may send its own job-1\'s bid line b-1 (its own row)', r.statusCode === 200 && r.body.created.length === 1, show(r));
    r = await get(ADMIN, { project_id: 'job-1' }, 'paving');
    assert('paving\'s job-1 is not turf\'s', r.statusCode === 200 && r.body.items.length === 0, show(r));
    r = await patch(ADMIN, manual.id, { vendor: 'Via paving' }, 'paving');
    assert('…and a turf row cannot be changed through paving (404)', r.statusCode === 404, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nDeleting');
  {
    const created = (await send(L2, { project_id: 'job-del', items: ['d-1', 'd-2', 'd-3', 'd-4'].map(b => line(b)) })).body.created;
    const [a, b, c, d] = created.map(i => i.id);
    let r = await del(L2, { ids: `${a},${b}, ${c},${a}` });
    assert('a level2 deletes three rows at once (?ids=a,b,c, de-duped)', r.statusCode === 200 && r.body.deleted === 3, show(r));
    assert('…softly, each marked', (await q('SELECT count(*) FROM procurement_items WHERE id = ANY($1) AND deleted_at IS NOT NULL AND deleted_by = $2', [[a, b, c], 'p_l2']))[0].count === '3');
    r = await del(L2, { ids: `${a},${d}` });
    assert('…deleting again counts only the rows still there', r.body.deleted === 1, show(r));
    r = await del(L2, { id: a });
    assert('one row already gone → 404', r.statusCode === 404, show(r));
    const more = (await send(L2, { project_id: 'job-del', items: ['d-5', 'd-6'].map(b2 => line(b2)) })).body.created.map(i => i.id);
    r = await del(L2, { ids: more });
    assert('?ids=a&ids=b (a repeated parameter) works like a list', r.statusCode === 200 && r.body.deleted === 2, show(r));
    r = await del(L2, { ids: 'ok,bad id' });
    assert('a junk id in the list → 400', r.statusCode === 400, show(r));
    r = await del(L2, {});
    assert('no id, ids or project_id → 400', r.statusCode === 400 && r.body.error === 'id_required', show(r));
    r = await del(L2, { id: manual.id, project_id: 'job-1' });
    assert('two of them at once → 400 (which did you mean?)', r.statusCode === 400 && !(await rowOf(manual.id)).deleted_at, show(r));

    const liveJob1 = Number((await q("SELECT count(*) FROM procurement_items WHERE company_code = $1 AND project_id = 'job-1' AND deleted_at IS NULL", [CO]))[0].count);
    r = await del(L2, { project_id: 'job-1' });
    assert('a level2 cannot delete a whole job\'s rows (403 level3_required)', r.statusCode === 403 && r.body.error === 'level3_required', show(r));

    // The nightly check counts live rows, and its restore must put a job back.
    const sql = makeSql(pool);
    const before = (await B.readCounts(sql)).filter(x => x.company_code === CO);
    const turfBefore = (before.find(x => x.measure === 'procurement_items.turf') || {}).n;
    // A run's stamp is whole seconds, so wait out the second the earlier
    // deletes happened in before taking one.
    await new Promise(res => setTimeout(res, 1100));
    const since = (await q("SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS t"))[0].t;

    r = await del(L3, { project_id: 'job-1' });
    assert('a level3 deletes every row of a deleted job', r.statusCode === 200 && r.body.deleted === liveJob1 && liveJob1 > 3, show(r));
    assert('…every one marked deleted, by the level3', (await q("SELECT count(*) FROM procurement_items WHERE company_code = $1 AND project_id = 'job-1' AND (deleted_at IS NULL OR (deleted_at > $2::timestamptz AND deleted_by <> 'p_l3'))", [CO, since]))[0].count === '0'
      && Number((await q("SELECT count(*) FROM procurement_items WHERE company_code = $1 AND project_id = 'job-1' AND deleted_at > $2::timestamptz AND deleted_by = 'p_l3'", [CO, since]))[0].count) === liveJob1);
    assert('…other jobs and the other company\'s job-1 are untouched',
      (await q("SELECT count(*) FROM procurement_items WHERE company_code = $1 AND project_id = 'job-2' AND deleted_at IS NULL", [CO]))[0].count === '1'
        && (await q("SELECT count(*) FROM procurement_items WHERE company_code = $1 AND project_id = 'job-1' AND deleted_at IS NULL", [CO2]))[0].count === '1');
    r = await del(ADMIN, { project_id: 'job-2' });
    assert('an admin may too', r.statusCode === 200 && r.body.deleted === 1, show(r));

    const after = (await B.readCounts(sql)).filter(x => x.company_code === CO);
    const turfAfter = (after.find(x => x.measure === 'procurement_items.turf') || {}).n;
    assert('the nightly shrink check counts LIVE procurement rows per division', turfBefore > 0 && turfAfter === turfBefore - liveJob1 - 1
      && after.some(x => x.measure === 'procurement_items.paving') && after.some(x => x.measure === 'procurement_items.kiewit'),
      JSON.stringify(after.filter(x => /procurement/.test(x.measure))));
    assert('…labelled for the alert', B.labelFor('procurement_items.turf') === 'Procurement rows (turf)' && B.labelFor('supplier_contacts.paving') === 'Supplier contacts (paving)');
    const { html } = B.buildAlert({ companyCode: CO, companyName: 'Procurement test', since, at: since,
      drops: [{ measure: 'procurement_items.turf', before: turfBefore, after: turfAfter }] });
    assert('…its email offers no app_data restore for a table, but a soft-delete one', !/INSERT INTO app_data/.test(html) && /deleted softly/.test(html), html.slice(0, 200));
    const snippet = B.softRestoreSql(CO, 'procurement_items.turf', since)
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean);
    const looked = await q(snippet[0]);
    assert('…"look first" lists exactly what was deleted since the fuller run', looked.length === liveJob1 + 1, looked.length);
    await q(snippet[1]);
    r = await get(L1, { project_id: 'job-1' });
    assert('…and running its UPDATE puts the job\'s rows back', r.body.items.length === liveJob1, `${r.body.items.length} of ${liveJob1}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA row is tied only to a line on the bid as it is stored now');
  {
    // The job's blob, as the pages and api/bid-items.js store it.
    const PID = 'prtest-bidjob';
    const blob = (pid, items) => q(`INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [`${CO}:fct_project_${pid}`, JSON.stringify({ id: pid, bidItems: items })]);
    const L = (id, sub) => ({ id, cost_code: 'Stormwater', sub_code: sub, quantity: 901, unit: 'LF' });
    await blob(PID, [L('ob1', 'Geofabric'), L('ob2', 'Perf Drain 15"')]);
    let r = await send(L2, { project_id: PID, items: [line('ob1'), line('ob2', { sub_code: 'Perf Drain 15"' })] });
    assert('lines on the stored bid are sent', r.statusCode === 200 && r.body.created.length === 2, show(r));
    const [g1, g2] = r.body.created;
    const m1 = (await create(L2, { id: uid('m'), project_id: PID, bid_item_id: 'ob1', cost_code: 'Stormwater', sub_code: 'Geofabric' })).body.item;

    // A Procore "Replace all": the stored bid's lines get new ids.
    await blob(PID, [L('nb1', 'Geofabric'), L('nb2', 'Perf Drain 15"')]);
    r = await patch(L2, g1.id, { bid_item_id: 'nb1', cost_code: 'Stormwater', sub_code: 'Geofabric' });
    assert('a re-link to a line on the stored bid lands', r.statusCode === 200 && r.body.item.bid_item_id === 'nb1', show(r));
    const v1 = (await rowOf(g1.id)).version;
    // A page still holding the old bid (its check passed a moment before the
    // Replace all landed) moves the row back: refused in the same statement.
    r = await patch(L2, g1.id, { bid_item_id: 'ob1', cost_code: 'Stormwater', sub_code: 'Geofabric' });
    assert('a re-link to a line the stored bid no longer has → 409 stale_bid, naming the field', r.statusCode === 409
      && r.body.error === 'stale_bid' && r.body.field === 'bid_item_id' && /no longer on the job's bid/.test(r.body.message), show(r));
    const g1Now = await rowOf(g1.id);
    assert('…and nothing about the row changed', g1Now.bid_item_id === 'nb1' && g1Now.version === v1, JSON.stringify(g1Now));
    r = await patch(L2, g2.id, { vendor: 'LB Water' });
    assert('a change that ties nothing to a line is not checked (the row still on a gone line saves)', r.statusCode === 200 && r.body.item.vendor === 'LB Water', show(r));
    r = await patch(L2, m1.id, { bid_item_id: null });
    assert('…nor is untying a row', r.statusCode === 200 && r.body.item.bid_item_id === null, show(r));
    r = await patch(L2, 'prtest-no-such-row', { bid_item_id: 'ob1' });
    assert('a row that is not there is still 404, not stale_bid', r.statusCode === 404 && r.body.error === 'not_found', show(r));
    r = await bulk(L2, [m1.id], { bid_item_id: 'ob2' });
    assert('a bulk edit onto a gone line → 409 stale_bid', r.statusCode === 409 && r.body.error === 'stale_bid' && (await rowOf(m1.id)).bid_item_id === null, show(r));
    r = await bulk(L2, [m1.id], { bid_item_id: 'nb2' });
    assert('…onto a line the bid has, it lands', r.statusCode === 200 && r.body.items[0].bid_item_id === 'nb2', show(r));

    // Send: every line a row is tied to has to be on the stored bid.
    const count = async () => Number((await q('SELECT count(*) FROM procurement_items WHERE company_code = $1 AND project_id = $2', [CO, PID]))[0].count);
    const n0 = await count();
    r = await send(L2, { project_id: PID, items: [line('nb2', { sub_code: 'Perf Drain 15"' }), line('ob9')] });
    assert('a send with a line the stored bid does not have → 409 stale_bid, naming it', r.statusCode === 409 && r.body.error === 'stale_bid'
      && JSON.stringify(r.body.lines) === '["ob9"]', show(r));
    assert('…and nothing at all went in, not even the good line', await count() === n0);
    await del(L2, { id: g2.id });
    r = await send(L2, { project_id: PID, restore_ids: [g2.id] });
    assert('a plain restore of a row whose line is gone → 409 stale_bid', r.statusCode === 409 && r.body.error === 'stale_bid'
      && !!(await rowOf(g2.id)).deleted_at, show(r));
    r = await send(L2, { project_id: PID, restore_ids: [{ id: g2.id, bid_item_id: 'ob2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"' }] });
    assert('a restore re-tied to a gone line → 409 stale_bid', r.statusCode === 409 && !!(await rowOf(g2.id)).deleted_at, show(r));
    r = await send(L2, { project_id: PID, restore_ids: [{ id: g2.id, bid_item_id: 'nb2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"' }] });
    const g2Now = await rowOf(g2.id);
    assert('a restore re-tied to the current line comes back on it', r.statusCode === 200 && r.body.restored.length === 1
      && !g2Now.deleted_at && g2Now.bid_item_id === 'nb2' && g2Now.vendor === 'LB Water', show(r));
    r = await send(L2, { project_id: 'prtest-no-blob', items: [line('whatever-line')] });
    assert('a job with no stored blob has nothing to check against, and is not refused', r.statusCode === 200 && r.body.created.length === 1, show(r));
    // The blob key is the division's own.
    await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`${CO}:fct_paving_project_${PID}`, JSON.stringify({ id: PID, bidItems: [L('pv1', 'Base')] })]);
    r = await send(PAVE, { project_id: PID, items: [line('nb1')] }, 'paving');
    assert('paving checks the paving job\'s bid (a turf line is not on it)', r.statusCode === 409 && r.body.error === 'stale_bid', show(r));
    r = await send(PAVE, { project_id: PID, items: [line('pv1', { sub_code: 'Base' })] }, 'paving');
    assert('…and takes its own line', r.statusCode === 200 && r.body.created.length === 1, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA bid line renamed on the bid page renames the rows\' stored copy (api/bid-items.js)');
  {
    const bidHandler = require(path.join(ROOT, 'api/bid-items.js'));
    const putLine = async (user, pid, item, key = `fct_project_${pid}`) => {
      const res = fakeRes();
      await bidHandler({ method: 'PUT', query: { id: item.id, projectId: pid, projectKey: key },
        body: { bidItem: item, ts: Date.now() }, headers: { authorization: 'Bearer ' + user.token } }, res);
      return res;
    };
    const PID = 'prtest-renamejob';
    await q("INSERT INTO projects (id, company_code, name) VALUES ($1, $2, 'Rename job') ON CONFLICT (id) DO NOTHING", [PID, CO]);
    await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`${CO}:fct_project_${PID}`, JSON.stringify({ id: PID, bidItems: [
        { id: 'rb1', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', quantity: 901, unit: 'LF' },
        { id: 'rb2', cost_code: 'E&S', sub_code: 'Silt Sock', quantity: 1200, unit: 'LF' }] })]);
    let r = await send(L2, { project_id: PID, items: [line('rb1', { sub_code: 'Perf Drain 15"' }), line('rb2', { cost_code: 'E&S', sub_code: 'Silt Sock' })] });
    const [R1, R2] = r.body.created;
    const M1 = (await create(L2, { id: uid('m'), project_id: PID, bid_item_id: 'rb1', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', description: 'Couplers' })).body.item;
    const OTHER = (await create(L2, { id: uid('m'), project_id: 'prtest-other', bid_item_id: 'rb1', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"' })).body.item;
    await del(L2, { id: R2.id });
    const ver = async id => (await rowOf(id)).version;
    const [vR1, vM1, vO] = [await ver(R1.id), await ver(M1.id), await ver(OTHER.id)];

    r = await putLine(L2, PID, { id: 'rb1', cost_code: 'Stormwater', sub_code: 'Perimeter Drain 15in Perf', quantity: 901, unit: 'LF' });
    assert('the bid line is saved', r.statusCode === 200 && r.body.ok, show(r));
    const [r1, m1] = [await rowOf(R1.id), await rowOf(M1.id)];
    assert('the rows tied to it — sent and hand-added — store its new sub code at once', r1.sub_code === 'Perimeter Drain 15in Perf'
      && m1.sub_code === 'Perimeter Drain 15in Perf' && r1.cost_code === 'Stormwater' && r1.version === vR1 + 1 && m1.version === vM1 + 1,
      JSON.stringify([r1.sub_code, m1.sub_code, r1.version, m1.version]));
    assert('…and nothing else of theirs changes', m1.description === 'Couplers' && r1.bid_item_id === 'rb1');
    const o = await rowOf(OTHER.id);
    assert('…another job\'s row with the same line id is untouched', o.sub_code === 'Perf Drain 15"' && o.version === vO);
    r = await putLine(L2, PID, { id: 'rb2', cost_code: 'Erosion Control', sub_code: 'Silt Sock 12in', quantity: 1200, unit: 'LF' });
    const r2 = await rowOf(R2.id);
    assert('a deleted row follows its line too (Send can offer it back on the new line)', r2.cost_code === 'Erosion Control'
      && r2.sub_code === 'Silt Sock 12in' && !!r2.deleted_at, JSON.stringify([r2.cost_code, r2.sub_code]));
    const vNow = await ver(R1.id);
    r = await putLine(L2, PID, { id: 'rb1', cost_code: 'Stormwater', sub_code: 'Perimeter Drain 15in Perf', quantity: 950, unit: 'LF' });
    assert('a quantity edit does not touch the rows (no version churn)', r.statusCode === 200 && await ver(R1.id) === vNow);
    r = await putLine(L2, PID, { id: 'rb1', cost_code: 'Stormwater', sub_code: '', quantity: 950, unit: 'LF' });
    assert('a sub code blanked half way through a rename is not copied over', (await rowOf(R1.id)).sub_code === 'Perimeter Drain 15in Perf'
      && await ver(R1.id) === vNow);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nWhen the database fails');
  {
    DB.fail = true;
    const r = await get(L2, { project_id: 'job-1' });
    const w = await patch(L2, manual.id, { vendor: 'X' });
    DB.fail = false;
    assert('a read is a 500 that says so, without the driver\'s words', r.statusCode === 500 && r.body.error === 'database_error'
      && !/10\.0\.0\.7|reset/.test(JSON.stringify(r.body)), show(r));
    assert('…and so is a write', w.statusCode === 500 && w.body.error === 'database_error', show(w));
  }

  await cleanUp();
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error(err);
  try { await cleanUp(); await pool.end(); } catch { /* already reporting the real failure */ }
  process.exit(1);
});
