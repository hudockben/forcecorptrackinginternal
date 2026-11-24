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
 *     email carries puts a deleted job's rows back;
 *   - a line's attached files follow its cost code: a write that changes the
 *     code (a re-picked Sub Code, the page's code sync, a bulk edit, a
 *     restore onto a new bid line) moves them to the new code's Document
 *     Vault folder, never strands one, and never fails the write when the
 *     move goes wrong; a line brought back from "removed earlier" is filed
 *     in its code's folder again;
 *   - a cost or sub code renamed on the bid page (the whole-job save or the
 *     per-line one) renames the job's purchase orders still on the old
 *     codes, so Procurement keeps matching its rows to them.
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

// fail / failInsert: statements on procurement rows fail as a dropped
// connection would. failFolders: statements on the Document Vault's folders
// fail (a re-file breaking part way). log: when an array, every statement's
// text is pushed onto it, so a check can see which tables a request touched.
const DB = { fail: false, failInsert: false, failFolders: false, log: null };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') {
    return { neon: () => {
      const sql = makeSql(pool);
      return (strings, ...values) => {
        if (DB.log) DB.log.push(strings.join('?'));
        if (DB.failFolders && strings.join('?').includes('project_folders')) {
          return Promise.reject(new Error('connection reset by peer at 10.0.0.7:5432'));
        }
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
    // The purchase orders' normalized mirror (a bid code rename carries them).
    await q('DELETE FROM purchase_orders WHERE company_code = $1', [co]).catch(() => {});
    // The attached files, folders and trail of the cost-code re-file checks.
    await q('DELETE FROM document_audit_log WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM document_links WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM project_documents WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM project_folders WHERE company_code = $1', [co]).catch(() => {});
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
  console.log('\nTwo people, one cell: a save says what it saw (expect), and lands only while that is still there');
  {
    const xp = (user, id, fields, expect) => call('PATCH', { division: 'turf', id }, { fields, expect }, user);
    const id = uid('x');
    let r = await create(L2, { id, project_id: 'job-1', description: 'Infill', quantity: 950, unit: 'LF', vendor: 'Acme Supply',
      date_needed: '2026-12-01', lead_time_days: 14 });
    assert('(a row to work on)', r.statusCode === 201, show(r));
    const v0 = r.body.item.version;

    r = await xp(L2, id, { vendor: 'Beta Corp' }, { vendor: 'Acme Supply' });
    assert('the cell still holds what was seen: the save lands', r.statusCode === 200 && r.body.item.vendor === 'Beta Corp' && r.body.item.version === v0 + 1, show(r));

    r = await xp(L3, id, { vendor: 'Gamma Inc' }, { vendor: 'Acme Supply' });
    assert('someone else changed it since it was seen → 409 conflict, naming the cell, who and when, with the row as it is',
      r.statusCode === 409 && r.body.error === 'conflict' && eq(r.body.fields, ['vendor']) && r.body.item && r.body.item.vendor === 'Beta Corp'
        && r.body.changed_by === 'p_l2' && typeof r.body.changed_at === 'string'
        && /changed since you started editing it \(last by p_l2\)/.test(r.body.message), show(r));
    let now = await rowOf(id);
    assert('…and nothing at all is written: not the cell, not the version', now.vendor === 'Beta Corp' && now.version === v0 + 1, JSON.stringify(now));

    r = await xp(L3, id, { vendor: 'Gamma Inc', quote_number: 'Q-9' }, { vendor: 'Acme Supply', quote_number: '' });
    assert('one stale cell holds back the whole save — and only it is named', r.statusCode === 409 && eq(r.body.fields, ['vendor'])
      && (await rowOf(id)).quote_number === '', show(r));

    const vBefore = (await rowOf(id)).version;
    r = await xp(L3, id, { quote_number: 'Q-9' }, { quote_number: '' });
    assert('a different cell of the same row, seen as it is, is not held back by the other change', r.statusCode === 200 && r.body.item.quote_number === 'Q-9'
      && r.body.item.vendor === 'Beta Corp', show(r));
    assert('…and its answer says who saved the row last before it, and the version it was (so the page can name the vendor change it brings)',
      r.body.was && r.body.was.updated_by === 'p_l2' && r.body.was.version === vBefore && typeof r.body.was.updated_at === 'string'
        && r.body.item.version === vBefore + 1, JSON.stringify(r.body.was));

    r = await xp(L3, id, { vendor: 'Gamma Inc' }, { vendor: 'Beta Corp' });
    assert('"Keep mine": the save expects the other person\'s value, and lands', r.statusCode === 200 && r.body.item.vendor === 'Gamma Inc', show(r));
    r = await xp(L2, id, { vendor: 'Gamma Inc' }, { vendor: 'Beta Corp' });
    assert('a cell that already holds what is being saved is no conflict, whatever was expected (two people set the same value; a save sent again after its answer was lost)',
      r.statusCode === 200 && r.body.item.vendor === 'Gamma Inc', show(r));
    r = await xp(L2, id, { vendor: ' Gamma Inc ', quote_number: 'Q-9' }, { vendor: 'Acme Supply', quote_number: 'Q-9' });
    assert('…compared as stored (" Gamma Inc " is "Gamma Inc")', r.statusCode === 200, show(r));
    r = await xp(L2, id, { vendor: 'Gamma Inc', quote_number: 'Q-10' }, { vendor: 'Acme Supply', quote_number: 'Q-1' });
    assert('…but a cell beside it that is stale still is → 409 naming only that one', r.statusCode === 409 && eq(r.body.fields, ['quote_number']), show(r));
    r = await xp(L2, id, { date_needed: '2026-12-01' }, { date_needed: '2020-01-01' });
    assert('…a date already holding the one being saved', r.statusCode === 200, show(r));
    r = await xp(L2, id, { quantity: 950.0 }, { quantity: 1 });
    assert('…a number by value', r.statusCode === 200, show(r));

    // Each kind of cell compared by value, as the page holds it.
    r = await xp(L2, id, { quantity: 1000 }, { quantity: 950 });
    assert('a number: 950 matches the stored 950', r.statusCode === 200 && r.body.item.quantity === 1000, show(r));
    r = await xp(L2, id, { quantity: 1100 }, { quantity: 950 });
    assert('…and not the 1000 stored since → 409', r.statusCode === 409 && eq(r.body.fields, ['quantity']) && r.body.item.quantity === 1000, show(r));
    r = await xp(L2, id, { quantity: 12.5 }, { quantity: 1000.0 });
    assert('…by value, not by spelling (1000.0 is 1000)', r.statusCode === 200 && r.body.item.quantity === 12.5, show(r));
    r = await xp(L2, id, { quantity: 13 }, { quantity: '12.50' });
    assert('…and a number sent as text, the way a save would read it', r.statusCode === 200 && r.body.item.quantity === 13, show(r));
    r = await xp(L2, id, { date_needed: '2026-12-15' }, { date_needed: '2026-12-01' });
    assert('a date as YYYY-MM-DD', r.statusCode === 200 && r.body.item.date_needed === '2026-12-15', show(r));
    r = await xp(L2, id, { date_needed: '2027-01-01' }, { date_needed: '2026-12-01' });
    assert('…a different date → 409', r.statusCode === 409 && eq(r.body.fields, ['date_needed']) && r.body.item.date_needed === '2026-12-15', show(r));
    r = await xp(L2, id, { date_needed: '' }, { date_needed: '2026-12-15' });
    assert('(a date cleared)', r.statusCode === 200 && r.body.item.date_needed === null, show(r));
    r = await xp(L2, id, { date_needed: '2027-02-01' }, { date_needed: null });
    assert('a blank cell: null matches it', r.statusCode === 200, show(r));
    r = await xp(L2, id, { date_needed: '' }, { date_needed: '2027-02-01' });
    r = await xp(L2, id, { date_needed: '2027-03-01' }, { date_needed: '' });
    assert('…and so does "" — what the page sent to clear it, a moment ago', r.statusCode === 200 && r.body.item.date_needed === '2027-03-01', show(r));
    r = await xp(L2, id, { date_needed: '2027-04-01' }, { date_needed: null });
    assert('…but a blank does not match a date someone has put in since → 409', r.statusCode === 409 && eq(r.body.fields, ['date_needed']), show(r));
    r = await xp(L2, id, { vendor: 'Delta' }, { vendor: '  Gamma Inc ' });
    assert('text as a save would store it: " Gamma Inc " (sent; stored trimmed) matches', r.statusCode === 200 && r.body.item.vendor === 'Delta', show(r));
    r = await xp(L2, id, { lead_time_days: 21 }, { lead_time_days: 14 });
    assert('whole days', r.statusCode === 200 && r.body.item.lead_time_days === 21, show(r));
    r = await xp(L2, id, { po_auto: false }, { po_auto: true });
    assert('true / false', r.statusCode === 200 && r.body.item.po_auto === false, show(r));
    r = await xp(L2, id, { po_auto: true }, { po_auto: true });
    assert('…a different one → 409', r.statusCode === 409 && eq(r.body.fields, ['po_auto']), show(r));
    r = await xp(L2, id, { po_id: 'po-9', po_auto: false }, { po_id: null, po_auto: false });
    assert('no PO is null', r.statusCode === 200 && r.body.item.po_id === 'po-9', show(r));
    r = await xp(L2, id, { sca_status: 'Executed' }, { sca_status: 'Pending' });
    assert('the Sub-Contractor Agreement', r.statusCode === 200 && r.body.item.sca_status === 'Executed', show(r));
    r = await xp(L2, id, { bid_item_id: null, cost_code: '', sub_code: '' }, { bid_item_id: null, cost_code: '', sub_code: '' });
    assert('a codes pick: line, cost code and sub code together', r.statusCode === 200, show(r));

    // What `expect` may hold.
    for (const [ex, what] of [[{ version: 3 }, 'a column no save may change (version)'], [{ updated_by: 'x' }, 'updated_by'],
      [{ vendor: { a: 1 } }, 'an object for a value'], [{ vendor: ['x'] }, 'a list for a value'], ['vendor', 'a string for the whole of it']]) {
      r = await xp(L2, id, { quote_number: 'never' }, ex);
      assert(`expect with ${what} → 400, and nothing written`, r.statusCode === 400 && r.body.error === 'invalid', show(r));
    }
    assert('…nothing at all', (await rowOf(id)).quote_number === 'Q-9');
    r = await xp(L2, id, { quote_number: 'Q-10' }, {});
    assert('an empty expect is no check', r.statusCode === 200 && r.body.item.quote_number === 'Q-10', show(r));
    r = await xp(L2, id, { quote_number: 'Q-11' }, null);
    assert('…and so is null (and none at all: every save above it)', r.statusCode === 200 && r.body.item.quote_number === 'Q-11', show(r));
    r = await xp(L2, id, { quote_number: 'Q-12' }, { quote_number: 'Q-11', vendor: 'not what is there' });
    assert('a cell expected but not being changed is checked too', r.statusCode === 409 && eq(r.body.fields, ['vendor']), show(r));
    r = await xp(L2, id, { quote_number: 'Q-12' }, { quote_number: 'Q-1', vendor: 'nope' });
    assert('…two stale cells are both named, in order', r.statusCode === 409 && eq(r.body.fields, ['quote_number', 'vendor']), show(r));

    // The other reasons a save can match nothing still answer as before.
    await del(L2, { id: uid('none') }).catch(() => {});
    r = await xp(L2, 'no-such-row', { vendor: 'X' }, { vendor: '' });
    assert('a row that does not exist, with expect → 404 (not a conflict)', r.statusCode === 404 && r.body.error === 'not_found', show(r));
    const gone = uid('x');
    await create(L2, { id: gone, project_id: 'job-1', vendor: 'Acme Supply' });
    await del(L2, { id: gone });
    r = await xp(L2, gone, { vendor: 'X' }, { vendor: 'Acme Supply' });
    assert('…nor does a deleted one', r.statusCode === 404 && r.body.error === 'not_found', show(r));
    const XPID = 'prtest-expectjob';
    await q(`INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [`${CO}:fct_project_${XPID}`, JSON.stringify({ id: XPID, bidItems: [{ id: 'xb1', cost_code: 'Stormwater', sub_code: 'Geofabric' }] })]);
    const onBid = (await create(L2, { id: uid('x'), project_id: XPID, vendor: 'Acme Supply' })).body.item;
    r = await xp(L2, onBid.id, { bid_item_id: 'b-not-on-the-bid', cost_code: 'X', sub_code: 'Y' }, { bid_item_id: null });
    assert('a bid line that is not on the bid, the cells as seen → 409 stale_bid, as without expect', r.statusCode === 409 && r.body.error === 'stale_bid'
      && (await rowOf(onBid.id)).bid_item_id === null, show(r));
    r = await xp(L2, onBid.id, { bid_item_id: 'xb1', cost_code: 'Stormwater', sub_code: 'Geofabric' }, { bid_item_id: null });
    assert('…and one that is, lands', r.statusCode === 200 && r.body.item.bid_item_id === 'xb1', show(r));

    // Seven people, one cell, at once: one wins, the others are told.
    const base = (await rowOf(id)).vendor;
    const race = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n, i) => xp([L2, L3, ADMIN][i % 3], id, { vendor: 'Race ' + n }, { vendor: base })));
    const won = race.filter(x => x.statusCode === 200), told = race.filter(x => x.statusCode === 409);
    assert('seven saves of one cell, all from the same value, at once: exactly one lands, six are told', won.length === 1 && told.length === 6,
      race.map(x => x.statusCode).join(','));
    assert('…and each of the six is shown the one that landed', told.every(x => x.body.item.vendor === won[0].body.item.vendor
      && eq(x.body.fields, ['vendor'])), told.map(show).join(' | '));
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
    r = await putLine(ADMIN, PID, { id: 'rb1', cost_code: 'Stormwater', sub_code: 'Perimeter Drain 15 in Perf', quantity: 901, unit: 'LF' });
    assert('the rows record who renamed the line (the Procurement sheet shows "Changed by" them, not the row\'s last editor)',
      r.statusCode === 200 && (await rowOf(R1.id)).updated_by === 'p_admin' && (await rowOf(M1.id)).updated_by === 'p_admin', show(r));
    await putLine(L2, PID, { id: 'rb1', cost_code: 'Stormwater', sub_code: 'Perimeter Drain 15in Perf', quantity: 901, unit: 'LF' });
    assert('…and the next rename its renamer', (await rowOf(R1.id)).updated_by === 'p_l2');
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
    // projectId naming one job and projectKey another: the blob written is
    // the key's, so only the key's job's rows follow — never projectId's,
    // whose bid did not change.
    const PID2 = 'prtest-renamejob2';
    await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`${CO}:fct_project_${PID2}`, JSON.stringify({ id: PID2, bidItems: [{ id: 'rb1', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', quantity: 10, unit: 'LF' }] })]);
    const B1 = (await create(L2, { id: uid('m'), project_id: PID2, bid_item_id: 'rb1', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"' })).body.item;
    r = await putLine(L2, PID, { id: 'rb1', cost_code: 'ZZZ', sub_code: 'Written through another job', quantity: 10, unit: 'LF' }, `fct_project_${PID2}`);
    const [r1b, b1] = [await rowOf(R1.id), await rowOf(B1.id)];
    assert('a PUT whose projectId names another job than its projectKey leaves projectId\'s rows alone', r.statusCode === 200
      && r1b.sub_code === 'Perimeter Drain 15in Perf' && r1b.cost_code === 'Stormwater' && r1b.version === vNow,
      JSON.stringify([r.statusCode, r1b.cost_code, r1b.sub_code, r1b.version]));
    assert('…and renames the rows of the job whose bid it wrote', b1.cost_code === 'ZZZ' && b1.sub_code === 'Written through another job',
      JSON.stringify([b1.cost_code, b1.sub_code]));
    await q('DELETE FROM app_data WHERE key = $1', [`${CO}:fct_project_${PID2}`]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA bid code renamed on the bid page renames the job\'s purchase orders that carry it');
  {
    // Procurement matches a row to an order nobody linked it to by the row's
    // live bid codes against the codes the order keeps of its own
    // (procurement.js effectivePO). An order left on the old codes drops the
    // row to Not Ordered and Late, and Create PO raises a second order.
    const dataHandler = require(path.join(ROOT, 'api/data/[key].js'));
    const bidHandler = require(path.join(ROOT, 'api/bid-items.js'));
    const poCodes = require(path.join(ROOT, 'api/lib/bid-po-codes.js'));
    const PID = 'prtest-pocodes';
    const auth = user => ({ authorization: 'Bearer ' + user.token });
    // The bid page's whole-job save (saveProject), and its per-line save.
    const putJob = async (user, items, key = `fct_project_${PID}`) => {
      const res = fakeRes();
      await dataHandler({ method: 'PUT', query: { key }, body: { value: { id: PID, name: 'PO codes job', bidItems: items } }, headers: auth(user) }, res);
      return res;
    };
    const putLine = async (user, item, key = `fct_project_${PID}`) => {
      const res = fakeRes();
      await bidHandler({ method: 'PUT', query: { id: item.id, projectId: PID, projectKey: key },
        body: { bidItem: item, ts: Date.now() }, headers: auth(user) }, res);
      return res;
    };
    const BL = (id, cost, sub) => ({ id, cost_code: cost, sub_code: sub, quantity: 10, unit: 'LF' });
    let bid = [BL('pc1', 'Stormwater', 'Geofabric'), BL('pc2', 'Stormwater', 'Perf Drain 15"'), BL('pc3', 'E&S', 'Silt Sock'),
      BL('pc4', 'Stormwater', 'Inlet'), BL('pc5', 'Stormwater', 'Inlet')];
    await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`${CO}:fct_project_${PID}`, JSON.stringify({ id: PID, name: 'PO codes job', bidItems: bid })]);
    await q("INSERT INTO projects (id, company_code, name) VALUES ($1, $2, 'PO codes job') ON CONFLICT (id) DO NOTHING", [PID, CO]);

    const poKey = (division, co = CO) => `${co}:fct_purchase_orders:${division}`;
    const putList = (k, list) => q(`INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [k, JSON.stringify(list)]);
    const listOf = async k => ((await q('SELECT value FROM app_data WHERE key = $1', [k]))[0] || {}).value || [];
    const stampOf = async k => ((await q('SELECT updated_at::text AS t FROM app_data WHERE key = $1', [k]))[0] || {}).t;
    // jsonb keeps no key order: compared with the keys sorted.
    const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));
    const PO = (id, cost, sub, extra = {}) => ({ id, po_number: id.toUpperCase(), title: 'Geofabric', supplier: 'LB Water', status: 'pending',
      date_created: '2026-11-01', project_id: PID, cost_code: cost, sub_code: sub, notes: 'call before delivery',
      lines: [{ id: `${id}-l1`, qty: '10', unit_cost: '5' }], ...extra });
    const turf = [
      PO('pc-po7', 'Stormwater', 'Geofabric'),                 // raised the normal way, matched by its codes
      PO('pc-po8', ' stormwater ', 'PERF DRAIN 15"'),           // spelled its own way; a row is linked to it
      PO('pc-po9', 'E&S', 'Silt Sock'),
      PO('pc-po10', 'Stormwater', 'Inlet'),                    // two lines of the bid carry these codes
      PO('pc-po11', 'Stormwater', 'Geofabric', { project_id: 'prtest-pocodes-other' }),
    ];
    await putList(poKey('turf'), turf);
    await putList(poKey('paving'), [PO('pc-po21', 'Stormwater', 'Geofabric')]);
    await putList(poKey('turf', CO2), [PO('pc-po31', 'Stormwater', 'Geofabric')]);
    for (const po of turf) {
      await q(`INSERT INTO purchase_orders (id, company_code, division, project_id, po_num, supplier, cost_code, sub_code, status, updated_at)
               VALUES ($1, $2, 'turf', $3, $4, 'LB Water', $5, $6, 'pending', '2000-01-01T00:00:00Z')`,
        [po.id, CO, po.project_id, po.po_number, po.cost_code, po.sub_code]);
    }
    const linked = (await create(L2, { id: uid('m'), project_id: PID, bid_item_id: 'pc2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', po_id: 'pc-po8' })).body.item;
    let list = await listOf(poKey('turf'));
    const po = id => list.find(p => p.id === id) || {};
    const mirror = async () => Object.fromEntries((await q(
      "SELECT id, cost_code, sub_code, updated_at > '2000-01-02' AS bumped FROM purchase_orders WHERE company_code = $1", [CO])).map(x => [x.id, x]));

    // ── A section renamed: the whole-job save first, then each line's ──
    const stamp0 = await stampOf(poKey('turf'));
    bid = bid.map(l => (l.cost_code === 'Stormwater' ? { ...l, cost_code: 'Storm Drainage' } : l));
    let r = await putJob(L2, bid);
    list = await listOf(poKey('turf'));
    assert('a section renamed on the bid page (the whole-job save, 200): the order raised for its line takes the new cost code, so its row still reads Ordered on it',
      r.statusCode === 200 && po('pc-po7').cost_code === 'Storm Drainage' && po('pc-po7').sub_code === 'Geofabric', JSON.stringify([show(r), po('pc-po7')]));
    assert('…and nothing else about the order changes', canon(po('pc-po7')) === canon({ ...turf[0], cost_code: 'Storm Drainage' }), JSON.stringify(po('pc-po7')));
    assert('…an order spelled its own way (case, spaces) has the same codes, and the order a row is linked to follows too, onto the line\'s codes',
      po('pc-po8').cost_code === 'Storm Drainage' && po('pc-po8').sub_code === 'Perf Drain 15"' && linked && linked.po_id === 'pc-po8', JSON.stringify(po('pc-po8')));
    assert('…two lines with the same codes renamed alike take their order along', po('pc-po10').cost_code === 'Storm Drainage' && po('pc-po10').sub_code === 'Inlet');
    assert('…an order under another section is untouched', canon(po('pc-po9')) === canon(turf[2]));
    assert('…so is another job\'s order on the old codes', canon(po('pc-po11')) === canon(turf[4]));
    assert('…and paving\'s orders and another company\'s', (await listOf(poKey('paving')))[0].cost_code === 'Stormwater'
      && (await listOf(poKey('turf', CO2)))[0].cost_code === 'Stormwater');
    assert('…the order list\'s version moved, so the pages holding it read it again', await stampOf(poKey('turf')) !== stamp0);
    let m = await mirror();
    assert('the normalized mirror follows for the renamed orders only, their updated_at moved',
      m['pc-po7'].cost_code === 'Storm Drainage' && m['pc-po7'].bumped && m['pc-po8'].sub_code === 'Perf Drain 15"' && m['pc-po8'].bumped
        && m['pc-po10'].bumped && m['pc-po9'].cost_code === 'E&S' && !m['pc-po9'].bumped && !m['pc-po11'].bumped, JSON.stringify(m));
    const stamp1 = await stampOf(poKey('turf'));
    for (const l of bid.filter(x => x.cost_code === 'Storm Drainage')) r = await putLine(L2, l);
    assert('the per-line saves that follow (200) find the orders renamed already: the order list is not written again',
      r.statusCode === 200 && await stampOf(poKey('turf')) === stamp1);

    // ── A sub code renamed through the per-line save alone ──
    // An open Procurement sheet may bring the rows' stored copy up to date
    // (its code sync) before that save lands: the order follows all the same.
    const silt = (await send(L2, { project_id: PID, items: [line('pc3', { cost_code: 'E&S', sub_code: 'Silt Sock' })] })).body.created[0];
    r = await patch(L2, silt.id, { bid_item_id: 'pc3', cost_code: 'E&S', sub_code: 'Silt Sock 12in' });
    assert('(the sheet\'s code sync lands first)', r.statusCode === 200 && r.body.item.sub_code === 'Silt Sock 12in', show(r));
    r = await putLine(L2, BL('pc3', 'E&S', 'Silt Sock 12in'));
    bid = bid.map(l => (l.id === 'pc3' ? BL('pc3', 'E&S', 'Silt Sock 12in') : l));
    list = await listOf(poKey('turf'));
    assert('a sub code renamed on the bid page (200) renames its order\'s sub code too',
      r.statusCode === 200 && po('pc-po9').cost_code === 'E&S' && po('pc-po9').sub_code === 'Silt Sock 12in', JSON.stringify([show(r), po('pc-po9')]));
    assert('…and its mirror', (await mirror())['pc-po9'].sub_code === 'Silt Sock 12in');

    // ── What does not rename an order ──
    const stamp2 = await stampOf(poKey('turf'));
    r = await putLine(L2, BL('pc4', 'Storm Drainage', 'Inlet Type M'));
    list = await listOf(poKey('turf'));
    assert('one of two lines with the same codes renamed: the order stays on them (the other line still has them)',
      r.statusCode === 200 && po('pc-po10').sub_code === 'Inlet' && await stampOf(poKey('turf')) === stamp2, JSON.stringify(po('pc-po10')));
    r = await putLine(L2, BL('pc1', 'Storm Drainage', ''));
    list = await listOf(poKey('turf'));
    assert('a sub code blanked half way through a rename leaves the order as it was', r.statusCode === 200 && po('pc-po7').sub_code === 'Geofabric');
    await putLine(L2, BL('pc1', 'Storm Drainage', 'Geofabric'));
    bid = bid.map(l => (l.id === 'pc4' ? BL('pc4', 'Storm Drainage', 'Inlet Type M') : l));
    r = await putJob(L2, bid.map(l => (l.id === 'pc1' ? { ...l, cost_code: '  ' } : l)));
    list = await listOf(poKey('turf'));
    assert('…so does a cost code blanked in the whole-job save', r.statusCode === 200 && po('pc-po7').cost_code === 'Storm Drainage');
    r = await putJob(L2, bid);
    const stamp3 = await stampOf(poKey('turf'));
    r = await putJob(L2, bid.map(l => ({ ...l, quantity: 99 })));
    list = await listOf(poKey('turf'));
    assert('a whole-job save that renames nothing writes no order', r.statusCode === 200 && po('pc-po7').cost_code === 'Storm Drainage'
      && await stampOf(poKey('turf')) === stamp3);

    // ── Paving's job and its orders ──
    await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`${CO}:fct_paving_project_${PID}`, JSON.stringify({ id: PID, bidItems: [BL('pv1', 'Stormwater', 'Geofabric')] })]);
    const turfNow = canon(await listOf(poKey('turf')));
    r = await putJob(PAVE, [BL('pv1', 'Base', 'Geofabric')], `fct_paving_project_${PID}`);
    assert('a paving job\'s section renamed (200): paving\'s order follows, and turf\'s orders for a job of the same id do not',
      r.statusCode === 200 && (await listOf(poKey('paving')))[0].cost_code === 'Base' && canon(await listOf(poKey('turf'))) === turfNow, show(r));

    // ── Never fails the bid save ──
    const realCarry = poCodes.carryBidCodeRenames;
    poCodes.carryBidCodeRenames = async () => { throw new Error('order rename exploded'); };
    let r2;
    try {
      r = await putJob(L2, bid.map(l => (l.id === 'pc3' ? BL('pc3', 'Erosion Control', 'Silt Sock 12in') : l)));
      r2 = await putLine(L2, BL('pc2', 'Storm Drainage', 'Perf Drain 15in'));
    } finally { poCodes.carryBidCodeRenames = realCarry; }
    const stored = ((await q('SELECT value FROM app_data WHERE key = $1', [`${CO}:fct_project_${PID}`]))[0].value.bidItems || []);
    assert('an order rename that throws never fails the bid save (200 both ways), and the bid is stored',
      r.statusCode === 200 && r2.statusCode === 200 && stored.find(l => l.id === 'pc3').cost_code === 'Erosion Control'
        && stored.find(l => l.id === 'pc2').sub_code === 'Perf Drain 15in', JSON.stringify([show(r), show(r2)]));
    assert('the real rename is back in place', poCodes.carryBidCodeRenames === realCarry);

    // The rules on their own (bidCodeRenames).
    const R = poCodes.bidCodeRenames;
    assert('lines with the same codes renamed two different ways: no telling which way their order goes, so it stays',
      eq(R([BL('a', 'Stormwater', 'Inlet'), BL('b', 'Stormwater', 'Inlet')], [BL('a', 'Stormwater', 'Inlet A'), BL('b', 'Stormwater', 'Inlet B')]), []));
    assert('a line that had no codes at all renames no order (an order saved with none is no line\'s)',
      eq(R([BL('a', '', '')], [BL('a', 'Stormwater', 'Inlet')]), []));
    assert('a code changed only in case or spaces is no rename (Procurement still matches the order)',
      eq(R([BL('a', 'Stormwater', 'Inlet')], [BL('a', ' STORMWATER', 'inlet ')]), []));
    assert('a rename names the old codes as Procurement compares them and the new ones as the line holds them',
      eq(R([BL('a', 'Stormwater', 'Inlet')], [BL('a', 'Storm Drainage', 'Inlet')]),
        [{ from: 'stormwater\u0000inlet', cost_code: 'Storm Drainage', sub_code: 'Inlet' }]));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA line\'s attached files follow its cost code (the Job Document Vault\'s cost-code folders)');
  {
    // A file attached to a line is filed in the folder picked AND in the
    // folder for the line's cost code (api/lib/procurement-docs.js). These
    // drive the real Procurement handler and look at where the files are
    // filed afterwards. The files, folders and links are written straight to
    // the tables, the way api/documents.js leaves them.
    const procDocs = require(path.join(ROOT, 'api/lib/procurement-docs.js'));
    const PID = 'prtest-files';
    const BL = (id, cost, sub) => ({ id, cost_code: cost, sub_code: sub, quantity: 10, unit: 'LF' });
    let bid = [BL('fb1', 'Stormwater', 'Geofabric'), BL('fb2', 'E&S', 'Silt Sock'), BL('fb5', 'E&S', 'Silt Sock 12in'),
      BL('fb6', 'E&S', 'Silt Fence')];
    const putBid = () => q(`INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [`${CO}:fct_project_${PID}`, JSON.stringify({ id: PID, bidItems: bid })]);
    await putBid();

    let fseq = 0;
    const folder = async (name, { kind = 'cost_code', code = null, slug, co = CO, pid = PID } = {}) => {
      const id = `prtest-f${++fseq}`;
      await q(`INSERT INTO project_folders (id, company_code, division, project_id, name, kind, slug, cost_code, sort_order)
               VALUES ($1, $2, 'turf', $3, $4, $5, $6, $7, 10)`,
        [id, co, pid, name, kind, slug === undefined ? (code ? 'cc-' + code : null) : slug, code]);
      return id;
    };
    const SAFETY = await folder('Safety', { kind: 'fixed', slug: 'safety' });
    const STORM  = await folder('Stormwater', { code: 'Stormwater' });
    const ES     = await folder('E&S · Erosion & Sediment', { code: 'E&S' });

    let dseq = 0;
    const doc = async (rows, folders, { co = CO, deleted = false, pid = PID } = {}) => {
      const id = `prtest-doc-${++dseq}`;
      await q(`INSERT INTO project_documents (id, company_code, division, project_id, filename, content_type, size_bytes,
                 storage_key, uploaded_by, deleted_at)
               VALUES ($1, $2, 'turf', $3, $4, 'application/pdf', 10, $5, 'p_l2', $6)`,
        [id, co, pid, `${id}.pdf`, `${co}/turf/${pid}/${id}/${id}.pdf`, deleted ? new Date() : null]);
      for (const r of rows) {
        await q(`INSERT INTO document_links (document_id, company_code, link_type, target_id) VALUES ($1, $2, 'procurement', $3)`, [id, co, r]);
      }
      for (const f of folders) {
        await q(`INSERT INTO document_links (document_id, company_code, link_type, target_id) VALUES ($1, $2, 'folder', $3)`, [id, co, f]);
      }
      return id;
    };
    const foldersOf = async id => (await q(
      `SELECT target_id FROM document_links WHERE document_id = $1 AND link_type = 'folder'`, [id])).map(r => r.target_id);
    const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const ccFolder = code => q(`SELECT * FROM project_folders WHERE company_code = $1 AND division = 'turf' AND project_id = $2
      AND kind = 'cost_code' AND lower(btrim(cost_code)) = lower(btrim($3))`, [CO, PID, code]);
    const trail = id => q(`SELECT action, actor, folder_id, detail FROM document_audit_log WHERE document_id = $1 ORDER BY id`, [id]);
    const folderCount = async () => Number((await q('SELECT count(*) FROM project_folders WHERE company_code = $1', [CO]))[0].count);
    const manualRow = async (cost, extra = {}) => (await create(L2, { id: uid('fm'), project_id: PID, cost_code: cost, ...extra })).body.item;

    // ── A hand-added line re-coded by picking another Sub Code ──
    const m1 = await manualRow('Stormwater', { sub_code: 'Geofabric' });
    const d1 = await doc([m1.id], [SAFETY, STORM]);
    let r = await patch(L2, m1.id, { bid_item_id: 'fb2', cost_code: 'E&S', sub_code: 'Silt Sock' });
    assert('a hand-added line re-coded by picking another Sub Code saves as it always did (200)',
      r.statusCode === 200 && r.body.item.cost_code === 'E&S' && r.body.item.bid_item_id === 'fb2', show(r));
    let now = await foldersOf(d1);
    assert('…its file is filed in the new code\'s folder and leaves the old one, keeping the folder picked',
      same(now, [SAFETY, ES]), JSON.stringify(now));
    const t1 = await trail(d1);
    assert('…both moves are in the document trail, by the person who saved, naming the line',
      t1.length === 2
        && t1.some(t => t.action === 'LINK' && t.folder_id === ES && t.detail.target_id === ES && t.detail.link_type === 'folder')
        && t1.some(t => t.action === 'UNLINK' && t.folder_id === STORM && t.detail.target_id === STORM)
        && t1.every(t => t.actor === 'p_l2' && t.detail.via === 'procurement_cost_code' && t.detail.procurement_id === m1.id),
      JSON.stringify(t1));
    r = await patch(L2, m1.id, { bid_item_id: null, cost_code: 'Stormwater', sub_code: 'Geofabric' });
    now = await foldersOf(d1);
    assert('…and typed back to the first code, it moves back', r.statusCode === 200 && same(now, [SAFETY, STORM]), JSON.stringify(now));

    // ── Only case or spaces changed: the same section ──
    const m2 = await manualRow('Stormwater');
    const d2 = await doc([m2.id], [SAFETY, STORM]);
    const nFolders = await folderCount();
    r = await patch(L2, m2.id, { cost_code: '  stormwater ' });
    assert('a code changed only in case or spaces saves (200)', r.statusCode === 200 && r.body.item.cost_code === 'stormwater', show(r));
    assert('…and moves nothing: same folders, no new folder, nothing in the trail',
      same(await foldersOf(d2), [SAFETY, STORM]) && await folderCount() === nFolders && (await trail(d2)).length === 0,
      JSON.stringify(await foldersOf(d2)));

    // ── A file on two lines of one section ──
    const a = await manualRow('Stormwater');
    const b2 = await manualRow('stormwater');
    const d3 = await doc([a.id, b2.id], [SAFETY, STORM]);
    r = await patch(L2, a.id, { cost_code: 'E&S' });
    now = await foldersOf(d3);
    assert('a file on two lines, one of them re-coded: it is filed under the new code too', r.statusCode === 200 && now.includes(ES), JSON.stringify(now));
    assert('…and STAYS in the old section\'s folder while the other line is still in that section (case ignored)',
      same(now, [SAFETY, STORM, ES]), JSON.stringify(now));
    r = await patch(L2, b2.id, { cost_code: 'E&S' });
    now = await foldersOf(d3);
    assert('…and leaves it once the other line moves too', same(now, [SAFETY, ES]), JSON.stringify(now));

    const c1 = await manualRow('Stormwater');
    const cGone = await manualRow('Stormwater');
    await del(L2, { id: cGone.id });
    const d4 = await doc([c1.id, cGone.id], [SAFETY, STORM]);
    r = await patch(L2, c1.id, { cost_code: 'E&S' });
    now = await foldersOf(d4);
    assert('a line deleted from the sheet does not hold a file in its old section', same(now, [SAFETY, ES]), JSON.stringify(now));

    // ── A code blanked ──
    const e1 = await manualRow('Stormwater');
    const d5 = await doc([e1.id], [STORM]);
    r = await patch(L2, e1.id, { cost_code: '' });
    assert('a line whose code is cleared saves (200)', r.statusCode === 200 && r.body.item.cost_code === '', show(r));
    assert('…a file whose ONLY folder is the old code\'s stays there — never filed nowhere',
      same(await foldersOf(d5), [STORM]) && (await trail(d5)).length === 0, JSON.stringify(await foldersOf(d5)));
    const f1 = await manualRow('Stormwater');
    const d6 = await doc([f1.id], [SAFETY, STORM]);
    r = await patch(L2, f1.id, { cost_code: '' });
    assert('…while a file that has another folder leaves the old code\'s (the line is in no section now)',
      same(await foldersOf(d6), [SAFETY]), JSON.stringify(await foldersOf(d6)));

    // ── The page bringing a stale stored code into line with a renamed bid line ──
    const s1 = (await send(L2, { project_id: PID, items: [line('fb1', { cost_code: 'Stormwater', sub_code: 'Geofabric' })] })).body.created[0];
    const d7 = await doc([s1.id], [SAFETY, STORM]);
    // The bid line is renamed on the bid page and the job saved whole: the
    // sheet shows the new code at once, the row still stores the old one.
    bid = bid.map(x => (x.id === 'fb1' ? BL('fb1', 'Storm Drainage', 'Geofabric') : x));
    await putBid();
    r = await patch(L2, s1.id, { vendor: 'Acme Supply' });
    assert('a save that does not touch the codes moves nothing, even while the stored copy is stale',
      r.statusCode === 200 && same(await foldersOf(d7), [SAFETY, STORM]), JSON.stringify(await foldersOf(d7)));
    r = await patch(L2, s1.id, { cost_code: 'Storm Drainage', sub_code: 'Geofabric' });
    const sd = await ccFolder('Storm Drainage');
    now = await foldersOf(d7);
    assert('the page\'s code sync (200) moves the file to the renamed code\'s folder, made for it',
      r.statusCode === 200 && sd.length === 1 && same(now, [SAFETY, sd[0].id]), JSON.stringify({ now, sd }));
    assert('…made the way the folder seed makes one (top level, kind cost_code, slug cc-<code>, the bare code as its name)',
      sd[0] && sd[0].parent_id === null && sd[0].kind === 'cost_code' && sd[0].slug === 'cc-Storm Drainage'
        && sd[0].name === 'Storm Drainage' && sd[0].cost_code === 'Storm Drainage' && sd[0].sort_order === 800 && sd[0].created_by === 'p_l2',
      JSON.stringify(sd[0]));

    // ── The bid page renaming a line's cost code (api/bid-items.js) ──
    // That PUT rewrites the rows' stored copy in the same request, so the
    // sheet has nothing left to bring into line and never sends the code
    // itself: the files have to move there, or they stay in the old folder.
    {
      const bidHandler = require(path.join(ROOT, 'api/bid-items.js'));
      const putBidLine = async item => {
        const res = fakeRes();
        await bidHandler({ method: 'PUT', query: { id: item.id, projectId: PID, projectKey: `fct_project_${PID}` },
          body: { bidItem: item, ts: Date.now() }, headers: { authorization: 'Bearer ' + L2.token } }, res);
        // Keep this test's copy of the bid in step with what the PUT stored.
        bid = bid.map(x => (x.id === item.id ? BL(item.id, item.cost_code, item.sub_code) : x));
        return res;
      };
      bid = bid.concat([BL('fb7', 'Stormwater', 'Drain Rock')]);
      await putBid();
      // The turf job's normalized mirror needs its projects row (step 3).
      await q("INSERT INTO projects (id, company_code, name) VALUES ($1, $2, 'Files job') ON CONFLICT (id) DO NOTHING", [PID, CO]);
      // One row sent from the line, one hand-added and tied to it.
      const k1 = (await send(L2, { project_id: PID, items: [line('fb7', { cost_code: 'Stormwater', sub_code: 'Drain Rock' })] })).body.created[0];
      const k2 = (await create(L2, { id: uid('m'), project_id: PID, bid_item_id: 'fb7', cost_code: 'Stormwater', sub_code: 'Drain Rock',
        description: 'second' })).body.item;
      const d12 = await doc([k1.id], [SAFETY, STORM]);
      const before12 = (await trail(d12)).length;

      DB.log = [];
      r = await putBidLine({ id: 'fb7', cost_code: 'Stormwater', sub_code: 'Drain Rock', quantity: 20, unit: 'LF' });
      const qtyLog = DB.log;
      DB.log = null;
      assert('a bid line\'s quantity edit (200) moves nothing and reads nothing more of the Vault than the copy statement',
        r.statusCode === 200 && same(await foldersOf(d12), [SAFETY, STORM])
          && qtyLog.filter(s => /document_links|project_folders|document_audit_log/.test(s)).length === 1
          && !qtyLog.some(s => /project_folders|INSERT INTO document_links|DELETE FROM document_links/.test(s)),
        JSON.stringify(qtyLog.filter(s => /document_links|project_folders/.test(s)).length));

      r = await putBidLine({ id: 'fb7', cost_code: 'Stormwater', sub_code: 'Drain Rock #57', quantity: 20, unit: 'LF' });
      assert('a sub code renamed on the bid page moves nothing (the section is the same)',
        r.statusCode === 200 && (await rowOf(k1.id)).sub_code === 'Drain Rock #57' && same(await foldersOf(d12), [SAFETY, STORM])
          && (await trail(d12)).length === before12, JSON.stringify(await foldersOf(d12)));

      r = await putBidLine({ id: 'fb7', cost_code: 'Site Drainage', sub_code: 'Drain Rock #57', quantity: 20, unit: 'LF' });
      const sdr = await ccFolder('Site Drainage');
      now = await foldersOf(d12);
      assert('the cost code renamed on the bid page (200): both rows store it, and the file moves to its folder, made for it',
        r.statusCode === 200 && (await rowOf(k1.id)).cost_code === 'Site Drainage' && (await rowOf(k2.id)).cost_code === 'Site Drainage'
          && sdr.length === 1 && same(now, [SAFETY, sdr[0].id]), JSON.stringify({ now, sdr, status: r.statusCode }));
      const t12 = (await trail(d12)).slice(before12);
      assert('…the move is in the document trail, by the person who renamed it, naming the line',
        t12.length === 2 && t12.some(t => t.action === 'LINK' && t.folder_id === (sdr[0] && sdr[0].id))
          && t12.some(t => t.action === 'UNLINK' && t.folder_id === STORM)
          && t12.every(t => t.actor === 'p_l2' && t.detail.via === 'procurement_cost_code' && t.detail.procurement_id === k1.id),
        JSON.stringify(t12));

      const realRefile = procDocs.refileProcurementDocs;
      procDocs.refileProcurementDocs = async () => { throw new Error('re-file exploded'); };
      try { r = await putBidLine({ id: 'fb7', cost_code: 'Drainage', sub_code: 'Drain Rock #57', quantity: 20, unit: 'LF' }); }
      finally { procDocs.refileProcurementDocs = realRefile; }
      assert('a re-file that throws never fails the bid edit (200), and the rows still take the new code',
        r.statusCode === 200 && r.body.ok && (await rowOf(k1.id)).cost_code === 'Drainage', show(r));
      assert('…the file simply stays where it was', same(await foldersOf(d12), [SAFETY, sdr[0] && sdr[0].id]));
    }

    // ── Bulk edit ──
    const g1 = await manualRow('Stormwater');
    const g2 = await manualRow('E&S');
    const g3 = await manualRow('Stormwater');
    const d8 = await doc([g1.id], [SAFETY, STORM]);
    const d9 = await doc([g2.id], [SAFETY, ES]);
    r = await bulk(L2, [g1.id, g2.id, g3.id], { vendor: 'Bulk Supply' });
    assert('a bulk edit of other cells moves nothing', r.statusCode === 200
      && same(await foldersOf(d8), [SAFETY, STORM]) && same(await foldersOf(d9), [SAFETY, ES]));
    r = await bulk(L2, [g1.id, g2.id, g3.id], { cost_code: 'Paving' });
    const pav = await ccFolder('Paving');
    assert('a bulk re-code (200) moves every line\'s files into the one new folder',
      r.statusCode === 200 && r.body.items.length === 3 && pav.length === 1
        && same(await foldersOf(d8), [SAFETY, pav[0].id]) && same(await foldersOf(d9), [SAFETY, pav[0].id]),
      JSON.stringify({ d8: await foldersOf(d8), d9: await foldersOf(d9), pav }));

    // ── Send: a deleted line restored onto its bid line's new id ──
    const s5 = (await send(L2, { project_id: PID, items: [line('fb5', { cost_code: 'E&S', sub_code: 'Silt Sock 12in' })] })).body.created[0];
    const s6 = (await send(L2, { project_id: PID, items: [line('fb6', { cost_code: 'E&S', sub_code: 'Silt Fence' })] })).body.created[0];
    const d10 = await doc([s5.id], [SAFETY, ES]);
    const d11 = await doc([s6.id], [SAFETY, ES]);
    await del(L2, { ids: `${s5.id},${s6.id}` });
    // A Procore "Replace all": the lines have new ids, one under a renamed code.
    bid = bid.filter(x => x.id !== 'fb5' && x.id !== 'fb6')
      .concat([BL('fb5n', 'Erosion Control', 'Silt Sock 12in'), BL('fb6n', 'e&s ', 'Silt Fence')]);
    await putBid();
    r = await send(L2, { project_id: PID, items: [], restore_ids: [
      { id: s5.id, bid_item_id: 'fb5n', cost_code: 'Erosion Control', sub_code: 'Silt Sock 12in' },
      { id: s6.id, bid_item_id: 'fb6n', cost_code: 'e&s', sub_code: 'Silt Fence' }] });
    const ec = await ccFolder('Erosion Control');
    assert('a deleted line restored onto its new bid line (200) brings its file to the new code\'s folder',
      r.statusCode === 200 && r.body.restored.length === 2 && ec.length === 1 && same(await foldersOf(d10), [SAFETY, ec[0].id]),
      JSON.stringify({ r: show(r).slice(0, 200), d10: await foldersOf(d10), ec }));
    assert('…while one restored under the same code spelled differently stays put',
      same(await foldersOf(d11), [SAFETY, ES]) && (await trail(d11)).length === 0, JSON.stringify(await foldersOf(d11)));

    // ── Send: a line brought back whose file left its section while it was deleted ──
    // One supplier quote on two Stormwater lines. One line is deleted, the
    // other re-coded onto E&S: the quote leaves the Stormwater folder, since
    // a deleted line holds nothing there. Brought back from "removed
    // earlier", the first is a Stormwater line with the quote on its
    // paperclip again, and nothing later would file it back: its stored code
    // already matches its live one.
    bid = bid.concat([BL('fb8', 'Stormwater', 'Perf Drain'), BL('fb9', 'Stormwater', 'Inlet'), BL('fb10', 'E&S', 'Inlet Protection'),
      BL('fb11', 'E&S', 'Wattle'), BL('fb12', 'E&S', 'Wattle 12in')]);
    await putBid();
    const CC = require(path.join(ROOT, 'api/lib/cost-code-counts.js'));
    const chip = async code => ((await CC.costCodeCounts(makeSql(pool), { companyCode: CO, division: 'turf', projectId: PID })) || {})[code] || 0;
    const [px, py] = (await send(L2, { project_id: PID, items: [line('fb8', { cost_code: 'Stormwater', sub_code: 'Perf Drain' }),
      line('fb9', { cost_code: 'Stormwater', sub_code: 'Inlet' })] })).body.created;
    const d13 = await doc([px.id, py.id], [SAFETY, STORM]);
    const storm0 = await chip('Stormwater');
    await del(L2, { id: px.id });
    r = await patch(L2, py.id, { bid_item_id: 'fb10', cost_code: 'E&S', sub_code: 'Inlet Protection' });
    assert('(the quote leaves Stormwater once its live line moves to E&S and the other is deleted)',
      r.statusCode === 200 && same(await foldersOf(d13), [SAFETY, ES]) && await chip('Stormwater') === storm0 - 1, JSON.stringify(await foldersOf(d13)));
    const before13 = (await trail(d13)).length;
    r = await send(ADMIN, { project_id: PID, items: [], restore_ids: [px.id] });
    assert('a line brought back from "removed earlier" (200) is filed in its section again: the Stormwater folder has the quote and its chip counts it',
      r.statusCode === 200 && r.body.restored.length === 1 && same(await foldersOf(d13), [SAFETY, STORM, ES]) && await chip('Stormwater') === storm0,
      JSON.stringify({ r: show(r).slice(0, 200), now: await foldersOf(d13), chip: await chip('Stormwater'), storm0 }));
    const t13 = (await trail(d13)).slice(before13);
    assert('…the filing is in the document trail, by the person who brought the line back, naming the line',
      t13.length === 1 && t13[0].action === 'LINK' && t13[0].folder_id === STORM && t13[0].actor === 'p_admin'
        && t13[0].detail.via === 'procurement_cost_code' && t13[0].detail.procurement_id === px.id, JSON.stringify(t13));
    await del(L2, { id: px.id });
    r = await send(L2, { project_id: PID, items: [], restore_ids: [px.id] });
    assert('…brought back again with the quote still there, nothing moves and the trail stays quiet',
      r.statusCode === 200 && same(await foldersOf(d13), [SAFETY, STORM, ES]) && (await trail(d13)).length === before13 + 1, JSON.stringify(await foldersOf(d13)));
    // The same, restored onto its line's new id under the same code (a
    // Procore "Replace all" in between).
    const [pa, pb] = (await send(L2, { project_id: PID, items: [line('fb11', { cost_code: 'E&S', sub_code: 'Wattle' }),
      line('fb12', { cost_code: 'E&S', sub_code: 'Wattle 12in' })] })).body.created;
    const d14 = await doc([pa.id, pb.id], [SAFETY, ES]);
    await del(L2, { id: pa.id });
    r = await patch(L2, pb.id, { bid_item_id: 'fb9', cost_code: 'Stormwater', sub_code: 'Inlet' });
    bid = bid.filter(x => x.id !== 'fb11').concat([BL('fb11n', 'e&s', 'Wattle')]);
    await putBid();
    r = await send(L2, { project_id: PID, items: [], restore_ids: [{ id: pa.id, bid_item_id: 'fb11n', cost_code: 'e&s', sub_code: 'Wattle' }] });
    assert('…and a line restored onto its new bid line under the same code is filed in that section again too',
      r.statusCode === 200 && r.body.restored.length === 1 && same(await foldersOf(d14), [SAFETY, ES, STORM]), JSON.stringify(await foldersOf(d14)));

    // ── Only this company's live files, in this line's own job ──
    const iso = await manualRow('Stormwater');
    const isoLive  = await doc([iso.id], [SAFETY, STORM]);
    const isoGone  = await doc([iso.id], [SAFETY, STORM], { deleted: true });
    const rivalF   = await folder('Stormwater', { code: 'Stormwater', co: CO2 });
    const isoRival = await doc([iso.id], [rivalF], { co: CO2 });
    const otherF   = await folder('Safety', { kind: 'fixed', slug: 'safety', pid: 'prtest-files-other' });
    const isoOther = await doc([iso.id], [otherF], { pid: 'prtest-files-other' });
    r = await patch(L2, iso.id, { cost_code: 'E&S' });
    assert('the line\'s live file moves', r.statusCode === 200 && same(await foldersOf(isoLive), [SAFETY, ES]), JSON.stringify(await foldersOf(isoLive)));
    assert('…a deleted file attached to it is left as it was', same(await foldersOf(isoGone), [SAFETY, STORM]));
    assert('…so is another company\'s file naming the same line id', same(await foldersOf(isoRival), [rivalF]));
    assert('…and a file filed under another job is not pulled into this job\'s tree', same(await foldersOf(isoOther), [otherF]));
    assert('…and no folder was made in another company\'s tree',
      (await q("SELECT 1 FROM project_folders WHERE company_code = $1 AND cost_code = 'E&S'", [CO2])).length === 0);

    // ── What it costs: nothing extra unless the codes were part of the save ──
    const bare = await manualRow('Stormwater');
    DB.log = [];
    r = await patch(L2, bare.id, { vendor: 'Nothing extra' });
    const quiet = DB.log.filter(s => /document_links|project_documents|project_folders|document_audit_log/.test(s)).length;
    DB.log = [];
    const r2 = await patch(L2, bare.id, { cost_code: 'E&S' });
    const coded = DB.log;
    DB.log = null;
    assert('a save of other cells reads nothing of the Document Vault', r.statusCode === 200 && quiet === 0, String(quiet));
    assert('a re-code of a line with nothing attached costs one read, and touches no folder',
      r2.statusCode === 200 && coded.filter(s => /document_links/.test(s)).length === 1
        && !coded.some(s => /project_folders|INSERT INTO document_links|DELETE FROM document_links/.test(s)), coded.length);

    // ── A re-file that fails never fails the save ──
    const real = { refile: procDocs.refileProcurementDocs, live: procDocs.liveCostCodes, snap: procDocs.snapshotStoredCodes };
    const h1 = await manualRow('Stormwater');
    const dh1 = await doc([h1.id], [SAFETY, STORM]);
    procDocs.refileProcurementDocs = async () => { throw new Error('re-file exploded'); };
    try { r = await patch(L2, h1.id, { cost_code: 'E&S' }); } finally { procDocs.refileProcurementDocs = real.refile; }
    assert('a re-file that throws: the save still answers 200 with the new code, and it is stored',
      r.statusCode === 200 && r.body.ok && r.body.item.cost_code === 'E&S' && (await rowOf(h1.id)).cost_code === 'E&S', show(r));
    assert('…the file simply stays where it was', same(await foldersOf(dh1), [SAFETY, STORM]));

    procDocs.liveCostCodes = async () => { throw new Error('live codes exploded'); };
    try { r = await bulk(L2, [h1.id], { cost_code: 'Paving' }); } finally { procDocs.liveCostCodes = real.live; }
    assert('reading the live codes fails: the bulk save still answers 200', r.statusCode === 200 && r.body.items[0].cost_code === 'Paving', show(r));

    procDocs.snapshotStoredCodes = async () => { throw new Error('snapshot exploded'); };
    try { r = await patch(L2, h1.id, { cost_code: 'Stormwater' }); } finally { procDocs.snapshotStoredCodes = real.snap; }
    assert('reading the codes before the save fails: the save still answers 200', r.statusCode === 200 && r.body.item.cost_code === 'Stormwater', show(r));

    // The database itself failing part way through the re-file: the folder
    // table unreachable.
    const h2 = await manualRow('Stormwater');
    const dh2 = await doc([h2.id], [SAFETY, STORM]);
    DB.failFolders = true;
    try { r = await patch(L2, h2.id, { cost_code: 'Brand New Code' }); } finally { DB.failFolders = false; }
    assert('the folder table failing mid re-file: the save still answers 200', r.statusCode === 200 && r.body.item.cost_code === 'Brand New Code', show(r));
    assert('…and the file is left where it was, filed', same(await foldersOf(dh2), [SAFETY, STORM]), JSON.stringify(await foldersOf(dh2)));
    assert('…no folder half made', (await ccFolder('Brand New Code')).length === 0);
    assert('the real helpers are back in place', procDocs.refileProcurementDocs === real.refile
      && procDocs.liveCostCodes === real.live && procDocs.snapshotStoredCodes === real.snap);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe material library (GET action=materials): the names bought under each sub code, across jobs');
  {
    // Kiewit, which nothing above wrote to, so the list is exactly these.
    const ins = (id, o) => q(`INSERT INTO procurement_items (id, company_code, division, project_id, cost_code, sub_code, description, unit, vendor, updated_at, deleted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, o.co || CO, o.division || 'kiewit', o.job, o.cost || '', o.sub || '', o.desc || '', o.unit || '', o.vendor || '', o.at, o.deleted || null]);
    await ins(uid('m'), { job: 'kA', cost: 'Turf Installation', sub: 'Infill Crumb Rubber', desc: '20/40 Mesh rubber crumb infill', unit: 'LBS', vendor: 'Willig Tire', at: '2026-10-01T12:00:00Z' });
    // The newest spelling of a name is the one kept; a blank unit or vendor
    // takes the most recent one that has it.
    await ins(uid('m'), { job: 'kB', cost: 'turf installation', sub: 'infill crumb rubber', desc: '20/40 mesh rubber crumb infill', at: '2026-11-01T12:00:00Z' });
    await ins(uid('m'), { job: 'kB', cost: 'Turf Installation', sub: 'Infill Crumb Rubber', desc: '20/40 Mesh rubber crumb infill', unit: 'TON', at: '2026-09-01T12:00:00Z' });
    await ins(uid('m'), { job: 'kC', cost: 'Base Construction', sub: '12" Concrete Curb', desc: '12"x12" Concrete Curb', unit: 'LF', vendor: 'Three Rivers Concrete', at: '2026-08-01T12:00:00Z' });
    // The same name under another sub code is another entry.
    await ins(uid('m'), { job: 'kC', cost: 'Sports Equipment', sub: 'Ball Catcher Foundations/Install', desc: '12"x12" Concrete Curb', unit: 'LF', at: '2026-06-01T12:00:00Z' });
    await ins(uid('m'), { job: 'kD', desc: 'Dumpster Rental', unit: 'EA', vendor: 'Dumpster Dudes', at: '2026-07-01T12:00:00Z' });
    // Not names: the sub code again, blank, blanks, and a deleted row.
    await ins(uid('m'), { job: 'kC', cost: 'Stormwater', sub: 'Geofabric', desc: 'GEOFABRIC ', at: '2026-11-02T12:00:00Z' });
    await ins(uid('m'), { job: 'kC', cost: 'Stormwater', sub: 'Geofabric', desc: '', at: '2026-11-02T12:00:00Z' });
    await ins(uid('m'), { job: 'kC', cost: 'Stormwater', sub: 'Geofabric', desc: '   ', at: '2026-11-02T12:00:00Z' });
    await ins(uid('m'), { job: 'kD', cost: 'Stormwater', sub: 'Geofabric', desc: 'Skipped fabric', at: '2026-11-02T12:00:00Z', deleted: '2026-11-03T12:00:00Z' });
    // Another division's and another company's names stay theirs.
    await ins(uid('m'), { division: 'turf', job: 'kE', sub: 'Infill Crumb Rubber', desc: 'Turf-division name', at: '2026-11-02T12:00:00Z' });
    await ins(uid('m'), { co: CO2, division: 'paving', job: 'kF', sub: 'Infill Crumb Rubber', desc: 'Rival company name', at: '2026-11-02T12:00:00Z' });

    let r = await get(KIEW, { action: 'materials' }, 'kiewit');
    assert('a level2 reads the division\'s library (no job needed)', r.statusCode === 200 && r.body.ok && r.body.canEdit === true && Array.isArray(r.body.materials), show(r));
    assert('…which has the row added by hand on job k-1 above, too', r.body.materials.some(m => m.material === 'Kiewit stone' && m.jobs === 1 && m.sub_code === ''));
    // From here on, just the rows of this section.
    r.body.materials = r.body.materials.filter(m => m.material !== 'Kiewit stone');
    const names = r.body.materials.map(m => m.material);
    assert('one entry per sub code + name (compared as the sheet compares codes), most jobs first, then most recent',
      eq(names, ['20/40 mesh rubber crumb infill', '12"x12" Concrete Curb', 'Dumpster Rental', '12"x12" Concrete Curb']), JSON.stringify(names));
    const infill = r.body.materials[0];
    assert('…counting the jobs it was bought on, not the rows', infill.jobs === 2 && infill.last_used === '2026-11-01T12:00:00.000Z', JSON.stringify(infill));
    assert('…with its newest spelling, and the newest unit and vendor that are not blank',
      infill.sub_code === 'infill crumb rubber' && infill.cost_code === 'turf installation' && infill.unit === 'LBS' && infill.vendor === 'Willig Tire', JSON.stringify(infill));
    assert('…the same name under another sub code is its own entry',
      r.body.materials[3].sub_code === 'Ball Catcher Foundations/Install' && r.body.materials[1].sub_code === '12" Concrete Curb' && r.body.materials[1].vendor === 'Three Rivers Concrete');
    assert('…a name with no codes is kept (a dumpster is bought too)', r.body.materials[2].sub_code === '' && r.body.materials[2].unit === 'EA');
    assert('…and the shape is exactly what the page reads', r.body.materials.every(m => eq(Object.keys(m).sort(), ['cost_code', 'cost_codes', 'jobs', 'last_used', 'material', 'sub_code', 'unit', 'vendor'])),
      JSON.stringify(r.body.materials[0]));
    assert('…every cost code a name was bought under comes with it, one per code however it was spelled, none for a name bought with no cost code',
      eq(infill.cost_codes, ['turf installation']) && eq(r.body.materials[2].cost_codes, []), JSON.stringify(r.body.materials.map(x => x.cost_codes)));
    assert('the Sub Code again, blank, blanks and deleted rows are no names', !names.some(n => /geofabric|skipped/i.test(n) || !n.trim()));
    assert('another division\'s and another company\'s names are not in it', !names.includes('Turf-division name') && !names.includes('Rival company name'));
    r = await get(RIVAL, { action: 'materials' }, 'paving');
    assert('…and the other company reads only its own', r.statusCode === 200 && eq(r.body.materials.map(m => m.material), ['Rival company name']), show(r));
    r = await get(L1, { action: 'materials' });
    assert('a level1 may read it too (what the rows already show), canEdit false', r.statusCode === 200 && r.body.canEdit === false
      && r.body.materials.some(m => m.material === 'Turf-division name'), show(r));
    r = await get(SALES, { action: 'materials' });
    assert('a sales login is refused (403), as for the rows', r.statusCode === 403 && r.body.error === 'no_access', show(r));
    r = await get(ADMIN, { action: 'bogus' });
    assert('an unknown read action is a 400, not a job\'s rows', r.statusCode === 400 && /Unknown action/.test(r.body.message || ''), show(r));
    DB.log = [];
    await get(KIEW, { action: 'materials' }, 'kiewit');
    const stmt = DB.log.find(s => /procurement_items/.test(s)) || '';
    DB.log = null;
    assert('one read, scoped by company and division, live named rows only, capped',
      /company_code = \?/.test(stmt) && /division = \?/.test(stmt) && /deleted_at IS NULL/.test(stmt) && /btrim\(description\) <> ''/.test(stmt) && /LIMIT \?/.test(stmt), stmt);

    // One name bought on one line of one job, and on another cost code's line
    // with the same sub code later: "+ Material" on the first line's code
    // still has the first job's list to offer, so the entry names both codes.
    await ins(uid('m'), { job: 'kG', cost: 'stormwater ', sub: 'Geofabric', desc: 'mirafi 140n', at: '2026-04-01T12:00:00Z' });
    await ins(uid('m'), { job: 'kA', cost: 'Stormwater', sub: 'Geofabric', desc: 'Mirafi 140N', at: '2026-05-01T12:00:00Z' });
    await ins(uid('m'), { job: 'kH', sub: 'Geofabric', desc: 'Mirafi 140N', at: '2026-05-02T12:00:00Z' });
    await ins(uid('m'), { job: 'kB', cost: ' Base ', sub: 'GEOFABRIC', desc: 'Mirafi 140N', at: '2026-05-03T12:00:00Z' });
    r = await get(KIEW, { action: 'materials' }, 'kiewit');
    const mirafi = (r.body.materials || []).filter(x => /mirafi/i.test(x.material));
    assert('a name bought under two cost codes with one sub code is one entry, its newest cost code shown',
      mirafi.length === 1 && mirafi[0].cost_code === 'Base' && mirafi[0].sub_code === 'GEOFABRIC' && mirafi[0].jobs === 4, JSON.stringify(mirafi));
    assert('…carrying every cost code it was bought under, newest first, each once (case and spaces ignored), blank left out',
      mirafi[0] && eq(mirafi[0].cost_codes, ['Base', 'Stormwater']), JSON.stringify(mirafi[0] && mirafi[0].cost_codes));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA bid line\'s material list on other jobs (GET action=breakdowns), copied in one go (POST action=add)');
  {
    const ins = (id, o) => q(`INSERT INTO procurement_items (id, company_code, division, project_id, source, bid_item_id, cost_code, sub_code, description, quantity, unit, vendor, created_at, updated_at, deleted_at)
      VALUES ($1, $2, 'kiewit', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)`,
      [id, o.co || CO, o.job, o.source || 'manual', o.bid || null, o.cost || 'Stormwater', o.sub || 'Detention System', o.desc || '', o.qty ?? null, o.unit || '', o.vendor || '', o.at, o.deleted || null]);
    // Field A: the detention system as five materials (one of them twice).
    await ins('bdA1', { job: 'bA', source: 'bid', bid: 'la', desc: 'Geofabric (Collector)', qty: 1040, unit: 'SF', vendor: 'LB Water', at: '2026-10-01T10:00:00Z' });
    await ins('bdA2', { job: 'bA', bid: 'la', desc: 'Flat Drain', qty: 1055, unit: 'LF', vendor: 'LB Water', at: '2026-10-01T10:01:00Z' });
    await ins('bdA3', { job: 'bA', bid: 'la', sub: 'detention  system', desc: '15" TEE watertight w/ gasket', qty: 2, unit: 'EA', vendor: 'LB Water', at: '2026-10-01T10:02:00Z' });
    await ins('bdA4', { job: 'bA', bid: 'la', desc: 'flat drain', qty: 20, unit: 'LF', at: '2026-10-01T10:03:00Z' });
    await ins('bdA5', { job: 'bA', bid: 'la', desc: 'Detention System', at: '2026-10-01T10:04:00Z' });
    await ins('bdA6', { job: 'bA', bid: 'la', desc: 'Old hatch', at: '2026-10-01T10:05:00Z', deleted: '2026-10-02T00:00:00Z' });
    await ins('bdA7', { job: 'bA', bid: 'la', desc: '', at: '2026-10-01T10:06:00Z' });
    // Field B, more recently: two materials. Another sub code on it is not asked for.
    await ins('bdB1', { job: 'bB', desc: 'Perforated 15" SLCPP', qty: 400, unit: 'LF', vendor: 'LB Water', at: '2026-11-05T10:00:00Z' });
    await ins('bdB2', { job: 'bB', sub: '  Detention System ', desc: 'Aluminum AO Hatch', qty: 1, unit: 'EA', at: '2026-11-05T10:01:00Z' });
    await ins('bdB3', { job: 'bB', sub: 'Geofabric', desc: 'Mirafi 140N', at: '2026-11-05T10:02:00Z' });
    // Another company's job is never offered.
    await ins('bdX1', { co: CO2, job: 'bX', desc: 'Rival pipe', at: '2026-11-09T10:00:00Z' });
    // Their names must also not leak into this one through another division.

    let r = await get(KIEW, { action: 'breakdowns', sub_code: 'DETENTION SYSTEM' }, 'kiewit');
    const bd = r.body.breakdowns || [];
    assert('a level2 reads a sub code\'s lists, job by job, the most recent job first', r.statusCode === 200 && r.body.ok && eq(bd.map(b => b.project_id), ['bB', 'bA']), show(r));
    assert('…each job\'s named rows in the order they were added — the same name twice is one line, the sub code itself, blanks and deleted rows none',
      eq(bd[1].items.map(i => i.material), ['Geofabric (Collector)', 'Flat Drain', '15" TEE watertight w/ gasket']), JSON.stringify(bd[1].items.map(i => i.material)));
    assert('…matched as the sheet compares codes (case, spacing), and no other sub code', eq(bd[0].items.map(i => i.material), ['Perforated 15" SLCPP', 'Aluminum AO Hatch']),
      JSON.stringify(bd[0].items));
    assert('…each with where it came from, its quantity (a number), unit and vendor',
      eq(bd[1].items[0], { id: 'bdA1', source: 'bid', material: 'Geofabric (Collector)', cost_code: 'Stormwater', sub_code: 'Detention System', quantity: 1040, unit: 'SF', vendor: 'LB Water' })
      && bd[0].last_used === '2026-11-05T10:01:00.000Z', JSON.stringify(bd[1].items[0]) + ' ' + bd[0].last_used);
    r = await get(KIEW, { action: 'breakdowns', sub_code: 'Detention System', exclude_project: 'bB' }, 'kiewit');
    assert('the asking job is left out', r.statusCode === 200 && eq(r.body.breakdowns.map(b => b.project_id), ['bA']), show(r));
    // The same sub code under another cost code is another bid line.
    await ins('bdS1', { job: 'bS', cost: 'Sanitary', desc: 'Sanitary tank liner', at: '2026-11-20T10:00:00Z' });
    r = await get(KIEW, { action: 'breakdowns', sub_code: 'Detention System' }, 'kiewit');
    const withS = r.body.breakdowns.map(b => b.project_id);
    r = await get(KIEW, { action: 'breakdowns', sub_code: 'Detention System', cost_code: ' stormwater ' }, 'kiewit');
    assert('with the line\'s cost code, only lists under that cost code (compared as the sheet does)', withS.includes('bS')
      && eq(r.body.breakdowns.map(b => b.project_id), ['bB', 'bA']), JSON.stringify([withS, r.body.breakdowns.map(b => b.project_id)]));
    r = await get(RIVAL, { action: 'breakdowns', sub_code: 'Detention System' }, 'paving');
    assert('another company sees none of it (its own rows are another division here)', r.statusCode === 200 && eq(r.body.breakdowns, []), show(r));
    r = await get(L1, { action: 'breakdowns', sub_code: 'Detention System' });
    assert('a level1 may read lists (the rows are already theirs to read)', r.statusCode === 200 && r.body.canEdit === false, show(r));
    r = await get(SALES, { action: 'breakdowns', sub_code: 'Detention System' });
    assert('a sales login may not', r.statusCode === 403, show(r));
    r = await get(KIEW, { action: 'breakdowns', sub_code: '  ' }, 'kiewit');
    assert('no sub code is a 400', r.statusCode === 400 && r.body.field === 'sub_code', show(r));

    // ── POST action=add ──
    const PIDK = 'bC';
    await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`${CO}:fct_kiewit_project_${PIDK}`, JSON.stringify({ id: PIDK, bidItems: [{ id: 'lc', cost_code: 'Stormwater', sub_code: 'Detention System', quantity: 1, unit: 'LS' }] })]);
    const addq = (user, body, division = 'kiewit') => call('POST', { division, action: 'add' }, body, user);
    const items = [
      { id: uid('ad'), bid_item_id: 'lc', cost_code: 'Stormwater', sub_code: 'Detention System', description: 'Flat Drain', unit: 'LF', vendor: 'LB Water', quantity: null },
      { id: uid('ad'), bid_item_id: 'lc', cost_code: 'Stormwater', sub_code: 'Detention System', description: '15" TEE watertight w/ gasket', unit: 'EA', vendor: 'LB Water', quantity: '2' },
      { id: uid('ad'), bid_item_id: 'lc', cost_code: 'Stormwater', sub_code: 'Detention System', description: 'Aluminum AO Hatch', unit: 'EA', vendor: '', source: 'bid', sca_status: 'Executed', po_id: 'sneaky' },
    ];
    r = await addq(KIEW, { project_id: PIDK, items });
    assert('a level2 adds several materials in one request (201), in the order sent', r.statusCode === 201 && r.body.ok
      && eq(r.body.created.map(x => x.id), items.map(i => i.id)) && eq(r.body.existing, []) && r.body.skipped === 0, show(r));
    const made = await q('SELECT * FROM procurement_items WHERE id = ANY($1::text[]) ORDER BY created_at', [items.map(i => i.id)]);
    assert('…each a hand-added row of the job, tied to the line, with its name, unit, vendor and quantity (read as a number)',
      made.length === 3 && made.every(m => m.source === 'manual' && m.project_id === PIDK && m.division === 'kiewit' && m.company_code === CO && m.bid_item_id === 'lc')
      && eq(made.map(m => [m.description, m.unit, m.vendor, m.quantity === null ? null : Number(m.quantity)]),
        [['Flat Drain', 'LF', 'LB Water', null], ['15" TEE watertight w/ gasket', 'EA', 'LB Water', 2], ['Aluminum AO Hatch', 'EA', '', null]]), JSON.stringify(made.map(m => [m.description, m.quantity, m.source])));
    assert('…keeping the list\'s order (created_at), and none of the cells a copy may not carry (source, agreement, PO)',
      made.map(m => m.id).join() === items.map(i => i.id).join() && made.every(m => m.sca_status === 'Pending' && m.po_id === null && m.created_by === 'p_kiewit'));
    r = await addq(KIEW, { project_id: PIDK, items });
    assert('sent again (an answer lost): nothing new, the rows come back as existing (200)', r.statusCode === 200 && eq(r.body.created, [])
      && eq(r.body.existing.map(x => x.id), items.map(i => i.id)) && (await q('SELECT count(*)::int AS n FROM procurement_items WHERE project_id = $1', [PIDK]))[0].n === 3, show(r));
    r = await addq(KIEW, { project_id: 'bOther', items: [items[0]] });
    assert('…an id that is another job\'s row is neither added nor shown', r.statusCode === 200 && eq(r.body.created, []) && eq(r.body.existing, []) && r.body.skipped === 1, show(r));
    r = await addq(KIEW, { project_id: PIDK, items: [{ ...items[0], id: uid('ad'), bid_item_id: 'gone-line' }] });
    assert('a row tied to a line not on the stored bid: 409 stale_bid, nothing added', r.statusCode === 409 && r.body.error === 'stale_bid'
      && (await q('SELECT count(*)::int AS n FROM procurement_items WHERE project_id = $1', [PIDK]))[0].n === 3, show(r));
    const before = (await q('SELECT count(*)::int AS n FROM procurement_items WHERE project_id = $1', [PIDK]))[0].n;
    r = await addq(KIEW, { project_id: PIDK, items: [{ ...items[0], id: uid('ad') }, { ...items[0], id: uid('ad'), quantity: '12 ft' }] });
    assert('one bad value refuses the whole list (400, naming the row and the field), nothing added', r.statusCode === 400 && r.body.field === 'quantity' && r.body.index === 1
      && (await q('SELECT count(*)::int AS n FROM procurement_items WHERE project_id = $1', [PIDK]))[0].n === before, show(r));
    const dupId = uid('ad');
    r = await addq(KIEW, { project_id: PIDK, items: [{ ...items[0], id: dupId }, { ...items[1], id: dupId }] });
    assert('an id twice in one list is a 400', r.statusCode === 400 && /used twice/.test(r.body.message || ''), show(r));
    r = await addq(KIEW, { project_id: PIDK, items: [] });
    assert('an empty list is a 400', r.statusCode === 400 && r.body.field === 'items', show(r));
    r = await addq(KIEW, { project_id: PIDK, items: [{ ...items[0], id: 'bad id!' }] });
    assert('an id of the wrong shape is a 400', r.statusCode === 400 && r.body.field === 'id', show(r));
    r = await call('POST', { division: 'turf', action: 'add' }, { project_id: PIDK, items: [{ ...items[0], id: uid('ad'), bid_item_id: null }] }, L1);
    assert('a level1 may not add (403 read_only)', r.statusCode === 403 && r.body.error === 'read_only', show(r));
    r = await call('POST', { division: 'turf', action: 'add' }, { project_id: PIDK, items: [{ ...items[0], id: uid('ad'), bid_item_id: null }] }, SALES);
    assert('nor a sales login (403)', r.statusCode === 403, show(r));
    r = await call('POST', { division: 'paving', action: 'add' }, { project_id: PIDK, items: [{ ...items[0], id: uid('ad'), bid_item_id: null }] }, RIVAL);
    const rivalRows = await q('SELECT company_code, division FROM procurement_items WHERE company_code = $1 AND project_id = $2', [CO2, PIDK]);
    assert('another company\'s rows go in under its own company (scoped by the login)', r.statusCode === 201 && rivalRows.length === 1 && rivalRows[0].division === 'paving', show(r));
    r = await addq(KIEW, { project_id: 'bNoBlob', items: [{ ...items[0], id: uid('ad'), bid_item_id: 'anything' }] });
    assert('a job with no stored bid at all is not refused (nothing to check against), as everywhere', r.statusCode === 201, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA bulk edit with expect (Create PO links its rows only while each is as the page decided)');
  {
    const a = uid('ba'), b = uid('bb'), c = uid('bc');
    for (const id of [a, b, c]) {
      const r = await create(L2, { id, project_id: 'job-1', description: 'Stone ' + id.slice(-3), vendor: 'Acme Supply' });
      assert(`(row ${id.slice(-3)})`, r.statusCode === 201, show(r));
    }
    // A colleague puts b on an order meanwhile; c is deleted.
    let r = await patch(L3, b, { po_id: 'po-theirs', po_auto: true });
    assert('(b linked to their order)', r.statusCode === 200, show(r));
    r = await call('DELETE', { division: 'turf', id: c }, null, L3);
    assert('(c deleted)', r.statusCode === 200, show(r));
    r = await bulk(L2, [a, b, c], { po_id: 'po-mine', po_auto: true }, { project_id: 'job-1', expect: { po_id: null, po_auto: true } });
    assert('rows still as expected are written; the one changed meanwhile is not, and comes back in conflicts as it is now',
      r.statusCode === 200 && eq(r.body.items.map(x => x.id), [a]) && r.body.items[0].po_id === 'po-mine'
        && eq(r.body.conflicts.map(x => [x.id, x.po_id]), [[b, 'po-theirs']]) && eq(r.body.missing, [c]), show(r));
    assert('…in the database too: b is still on their order', (await rowOf(b)).po_id === 'po-theirs' && (await rowOf(a)).po_id === 'po-mine');
    r = await bulk(L2, [a], { po_id: 'po-mine', po_auto: true }, { project_id: 'job-1', expect: { po_id: null, po_auto: true } });
    assert('…a row already holding the value being written is no conflict (the same link sent again)', r.statusCode === 200
      && eq(r.body.items.map(x => x.id), [a]) && eq(r.body.conflicts, []), show(r));
    r = await bulk(L2, [a], { quote_number: 'Q-1' }, { project_id: 'job-1' });
    assert('without expect, a bulk edit answers as before (no conflicts list)', r.statusCode === 200 && !('conflicts' in r.body)
      && eq(r.body.items.map(x => x.quote_number), ['Q-1']), show(r));
    r = await bulk(L2, [a], { quote_number: 'Q-2' }, { project_id: 'job-1', expect: { nope: 1 } });
    assert('an expect naming no column is refused', r.statusCode === 400, show(r));
  }

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
