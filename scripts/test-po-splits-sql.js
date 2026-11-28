#!/usr/bin/env node
'use strict';
/**
 * One purchase order split between several jobs, against a real Postgres.
 *
 * Run: PG_TEST_URL=postgres://user:pw@localhost/some_test_db node scripts/test-po-splits-sql.js
 *      (default postgres://fct_test_user:test@localhost/fct_test, schema applied:
 *       auth-schema.sql then neon-schema.sql)
 *
 * The silt sock for all four Hempfield fields is one order to one supplier,
 * under one number — and each field still has to carry its own share, under
 * its own sub code. "One order, several jobs" in api/lib/po-sync.js: the order
 * keeps its own job (project_id / cost_code / sub_code), `splits` lists its
 * other jobs with their codes, and each delivery's `split` says which job it
 * is for. One delivery is one job row, on its job, under that job's codes.
 *
 * Driven through the real handlers (api/purchase-orders.js) with the neon
 * driver swapped for this pool, so what is checked is what lands in
 * daily_tracking, app_data and the mirror tables:
 *
 *  - central purchasing (single-order POST): each delivery's row on its own
 *    job and codes; moving a delivery to another job; pointing a job of the
 *    order at another job; re-coding a job; a supervisor's re-code surviving
 *    an unrelated save; a stale save that drops a split still in use.
 *  - Daily Tracking: a row on one of the order's other jobs naming its number
 *    is recorded on it, under that job; a row on a job it does not book to is
 *    not.
 *  - a division tab (full-list PUT): a delivery moved to another job, with
 *    the tab's own row; the same with a stale base (the merge must not put the
 *    old link back).
 *  - the general list keeps no splits; the recovery GET rebuilds a split order
 *    from the mirror; deleting the order removes its rows on every job.
 *  - races, each reproduced against the code before its fix, under the marks
 *    the pages send (one per change to a job: 'split:<id>:add|job|codes|remove'):
 *    a stale tab or purchasing page re-coding one job while another was
 *    pointed elsewhere; a stale tab moving a delivery onto a job pointed
 *    elsewhere, or taken off, meanwhile; a stale tab moving the order's own job
 *    while its delivery moved onto another; a tab from before splits moving a
 *    split order; a move to another division from a copy without the splits;
 *    two purchasing saves at once, one moving a delivery while the other writes.
 */

const path   = require('path');
const Module = require('module');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const URL_ = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL_.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) { console.error(`Refusing to run: "${dbName}" does not look like a test database.`); process.exit(1); }

process.env.JWT_SECRET = 'po-splits-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub/neondb';
const pool = new Pool({ connectionString: URL_, max: 6 });
// Runs before each statement when set: lets a test land a second save at an
// exact point inside the first one.
let sqlHook = null;
const makeSql = c => async (strings, ...values) => {
  let text = '';
  strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
  if (sqlHook) await sqlHook(text, values);
  return c.query(text, values).then(r => r.rows);
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(pool) };
  return origLoad.apply(this, arguments);
};
const jwt    = require('jsonwebtoken');
const poSync = require(path.join(ROOT, 'api/lib/po-sync.js'));
const handler = require(path.join(ROOT, 'api/purchase-orders.js'));

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700) : '')); }
};
const q = (t, v = []) => pool.query(t, v).then(r => r.rows);
const money = v => Math.round(Number(v) * 100) / 100;

const CO = 'POSPLIT';
let TOKEN = null;

async function cleanUp() {
  await q('DELETE FROM app_data WHERE key LIKE $1', [CO + ':%']);
  await q('DELETE FROM po_deliveries WHERE company_code = $1', [CO]);
  await q('DELETE FROM purchase_orders WHERE company_code = $1', [CO]);
  await q('DELETE FROM daily_tracking WHERE company_code = $1', [CO]);
  await q('DELETE FROM users WHERE company_code = $1', [CO]);
  await q('DELETE FROM companies WHERE code = $1', [CO]);
}
async function setUp() {
  await cleanUp();
  await q("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'PO splits', '{turf,paving,kiewit,purchase_orders}')", [CO]);
  const roles = { turf: 'admin', paving: 'admin', kiewit: 'admin', purchase_orders: 'admin' };
  const id = (await q("INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ('posplit_admin', $1, 'x', 'admin', $2) RETURNING id",
    [CO, JSON.stringify(roles)]))[0].id;
  TOKEN = jwt.sign({ userId: id, username: 'posplit_admin', name: 'Ada', companyCode: CO, role: 'admin', divisionRoles: roles }, process.env.JWT_SECRET);
}

async function api(method, url, body) {
  const u = new URL(url, 'http://x');
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
  await handler({ method, query: Object.fromEntries(u.searchParams), body: body == null ? {} : body,
    headers: { authorization: 'Bearer ' + TOKEN } }, res);
  return res;
}
const post = (body, division = 'turf') => api('POST', `/api/purchase-orders?division=${division}`, body);
const KEY = (division = 'turf') => poSync.blobKeyFor(CO, division);
async function stored(id = 'sp1', division = 'turf') {
  const r = await q('SELECT value, updated_at FROM app_data WHERE key = $1', [KEY(division)]);
  const list = r.length && Array.isArray(r[0].value) ? r[0].value : [];
  return list.find(p => p && p.id === id) || null;
}
async function baseOf(division = 'turf') {
  const r = await q('SELECT updated_at FROM app_data WHERE key = $1', [KEY(division)]);
  return r.length ? new Date(r[0].updated_at).toISOString() : null;
}
const rowOf = async id => (await q('SELECT * FROM daily_tracking WHERE company_code = $1 AND row_id = $2', [CO, String(id)]))[0] || null;
const rowsOn = async pid => q('SELECT * FROM daily_tracking WHERE company_code = $1 AND project_id = $2 ORDER BY row_id', [CO, pid]);
const lineOf = (po, id) => ((po && po.lines) || []).find(l => l && l.id === id) || null;

// Hempfield: Baseball (hb) is the order's own job; Softball (hs) and Soccer
// (hss) are its splits. Football (hf) and an unrelated job (hx) come later.
const ORDER = () => ({
  id: 'sp1', po_number: 'PO-0100', title: 'Silt sock', supplier: 'Frank Roberts', status: 'pending', notes: '',
  date_created: '2026-11-20', project_id: 'hb', cost_code: 'E&S', sub_code: 'Silt Sock',
  splits: [
    { id: 's-sb', project_id: 'hs',  cost_code: 'E&S',  sub_code: 'Silt Sock' },
    { id: 's-ss', project_id: 'hss', cost_code: 'E&S2', sub_code: 'Sock' },
  ],
  lines: [
    { id: 'l1', invoice_num: 'INV-1', date: '2026-11-21', qty: '400', unit_cost: '3', tax_pct: '6', tax: '72', employee: '' },
    { id: 'l2', invoice_num: 'INV-1', date: '2026-11-21', qty: '300', unit_cost: '3', tax_pct: '6', tax: '54', employee: '', split: 's-sb' },
    { id: 'l3', invoice_num: 'INV-1', date: '2026-11-21', qty: '250', unit_cost: '3', tax_pct: '6', tax: '45', employee: '', split: 's-ss' },
  ],
});

(async () => {
  try {
    await setUp();

    console.log('\n[central purchasing raises an order split between three jobs]');
    let r = await post({ purchaseOrder: ORDER() });
    ok('it saves', r.statusCode === 200 && r.body && r.body.ok, r.body);
    let po = await stored();
    const l1 = lineOf(po, 'l1'), l2 = lineOf(po, 'l2'), l3 = lineOf(po, 'l3');
    ok('every delivery has its own cost row', l1 && l1.po_row_id && l2 && l2.po_row_id && l3 && l3.po_row_id
      && new Set([l1.po_row_id, l2.po_row_id, l3.po_row_id]).size === 3, po && po.lines);
    let r1 = await rowOf(l1.po_row_id), r2 = await rowOf(l2.po_row_id), r3 = await rowOf(l3.po_row_id);
    ok('the order\'s own delivery is on its own job, under its codes', r1 && r1.project_id === 'hb'
      && r1.cost_code === 'E&S' && r1.sub_code === 'Silt Sock', r1);
    ok('a split\'s delivery is on THAT job, under its codes', r2 && r2.project_id === 'hs' && r2.cost_code === 'E&S' && r2.sub_code === 'Silt Sock'
      && r3 && r3.project_id === 'hss' && r3.cost_code === 'E&S2' && r3.sub_code === 'Sock', [r2, r3]);
    ok('each job is charged for its own quantity, tax in', money(r1.material_cost) === 1272 && money(r2.material_cost) === 954
      && money(r3.material_cost) === 795 && Number(r2.units_purchased) === 300, [r1.material_cost, r2.material_cost, r3.material_cost]);
    ok('every row carries the one PO number, title and supplier', [r1, r2, r3].every(x => x.po_num === 'PO-0100'
      && x.material === 'Silt sock' && x.supplier === 'Frank Roberts' && x.division === 'turf'));
    const mirror = (await q('SELECT splits FROM purchase_orders WHERE id = $1 AND company_code = $2', [ 'sp1', CO ]))[0];
    ok('the mirror keeps the order\'s other jobs', mirror && Array.isArray(mirror.splits) && mirror.splits.length === 2
      && mirror.splits.some(s => s.id === 's-ss' && s.project_id === 'hss'), mirror);
    const dels = await q('SELECT line_id, split_id FROM po_deliveries WHERE po_id = $1 AND company_code = $2 ORDER BY line_id', ['sp1', CO]);
    ok('  and which job each delivery is for', dels.length === 3 && dels[0].split_id === null && dels[1].split_id === 's-sb'
      && dels[2].split_id === 's-ss', dels);

    console.log('\n[a delivery moved to another of the order\'s jobs]');
    const oldL2Row = l2.po_row_id;
    po = await stored();
    lineOf(po, 'l2').split = 's-ss';
    r = await post({ purchaseOrder: po, editedFields: [], editedLineFields: { l2: ['split'] } });
    ok('it saves', r.statusCode === 200 && r.body.ok, r.body);
    po = await stored();
    const movedRow = await rowOf(lineOf(po, 'l2').po_row_id);
    ok('its row on the old job is gone', !(await rowOf(oldL2Row)));
    ok('it has a new row on its new job, under that job\'s codes', lineOf(po, 'l2').po_row_id !== oldL2Row && movedRow
      && movedRow.project_id === 'hss' && movedRow.cost_code === 'E&S2' && movedRow.sub_code === 'Sock'
      && money(movedRow.material_cost) === 954, movedRow);
    ok('the other deliveries\' rows are untouched', lineOf(po, 'l1').po_row_id === l1.po_row_id && lineOf(po, 'l3').po_row_id === l3.po_row_id
      && !!(await rowOf(l1.po_row_id)) && !!(await rowOf(l3.po_row_id)));
    ok('Softball is charged nothing for it now', (await rowsOn('hs')).length === 0, await rowsOn('hs'));

    console.log('\n[one of the order\'s jobs pointed at another job]');
    po = await stored();
    const ssRows = [lineOf(po, 'l2').po_row_id, lineOf(po, 'l3').po_row_id];
    po.splits = po.splits.map(s => (s.id === 's-ss' ? { ...s, project_id: 'hf' } : s));
    r = await post({ purchaseOrder: po, editedFields: ['split:s-ss:job', 'split:s-ss:codes'], editedLineFields: {} });
    ok('it saves', r.statusCode === 200 && r.body.ok, r.body);
    po = await stored();
    const onHf = await rowsOn('hf');
    ok('both its deliveries\' rows move to the new job', onHf.length === 2
      && onHf.every(x => x.cost_code === 'E&S2' && x.sub_code === 'Sock' && x.po_num === 'PO-0100'), onHf);
    ok('  and none is left on the old one', (await rowsOn('hss')).length === 0 && !(await rowOf(ssRows[0])) && !(await rowOf(ssRows[1])));
    ok('  and the order names the new rows', onHf.map(x => x.row_id).sort().join() === [lineOf(po, 'l2').po_row_id, lineOf(po, 'l3').po_row_id].sort().join());
    ok('the order\'s own delivery is untouched', lineOf(po, 'l1').po_row_id === l1.po_row_id);

    console.log('\n[one of the order\'s jobs re-coded]');
    po = await stored();
    const hfIds = [lineOf(po, 'l2').po_row_id, lineOf(po, 'l3').po_row_id];
    po.splits = po.splits.map(s => (s.id === 's-ss' ? { ...s, cost_code: 'E&S3', sub_code: 'Sock3' } : s));
    r = await post({ purchaseOrder: po, editedFields: ['split:s-ss:codes'], editedLineFields: {} });
    po = await stored();
    const recoded = await rowsOn('hf');
    ok('its rows take the new codes, in place', r.body.ok && recoded.length === 2 && recoded.every(x => x.cost_code === 'E&S3' && x.sub_code === 'Sock3')
      && recoded.map(x => x.row_id).sort().join() === hfIds.slice().sort().join(), recoded);
    const hb1 = await rowOf(l1.po_row_id);
    ok('the other jobs\' codes are not touched', hb1.cost_code === 'E&S' && hb1.sub_code === 'Silt Sock');

    console.log('\n[a supervisor\'s re-code survives a save that changed something else]');
    await q("UPDATE daily_tracking SET cost_code = 'SUP', sub_code = 'SUPX' WHERE company_code = $1 AND row_id IN ($2, $3)", [CO, l1.po_row_id, hfIds[0]]);
    po = await stored();
    po.title = 'Silt sock 12in';
    r = await post({ purchaseOrder: po, editedFields: ['title'], editedLineFields: {} });
    const a = await rowOf(l1.po_row_id), b = await rowOf(hfIds[0]);
    ok('a retitle reaches every job\'s rows', r.body.ok && a.material === 'Silt sock 12in' && b.material === 'Silt sock 12in');
    ok('  and leaves the supervisor\'s codes on both jobs', a.cost_code === 'SUP' && a.sub_code === 'SUPX'
      && b.cost_code === 'SUP' && b.sub_code === 'SUPX', [a, b]);

    console.log('\n[a stale save that drops a job still in use]');
    po = await stored();
    const before3 = lineOf(po, 'l3').po_row_id;
    const stale = { ...po, splits: po.splits.filter(s => s.id !== 's-ss') };
    r = await post({ purchaseOrder: stale, editedFields: ['split:s-ss:remove'], editedLineFields: {} });
    po = await stored();
    ok('the job its deliveries are on stays on the order', r.body.ok && po.splits.some(s => s.id === 's-ss' && s.project_id === 'hf'), po.splits);
    ok('  so its deliveries\' rows stay where they are', lineOf(po, 'l3').po_row_id === before3 && (await rowOf(before3)).project_id === 'hf');

    console.log('\n[Daily Tracking: a row on one of the order\'s jobs naming its number]');
    await q(`INSERT INTO daily_tracking (row_id, company_code, division, project_id, date, field_type, cost_code, sub_code, material, supplier, po_num, units_purchased, unit_cost, material_cost)
             VALUES ('dt-hs-1', $1, 'turf', 'hs', '2026-11-22', 'Material', 'E&S', 'Silt Sock', 'sock', 'Frank Roberts', 'PO-0100', 50, 3, 150)`, [CO]);
    await q(`INSERT INTO daily_tracking (row_id, company_code, division, project_id, date, field_type, cost_code, sub_code, material, supplier, po_num, units_purchased, unit_cost, material_cost)
             VALUES ('dt-hx-1', $1, 'turf', 'hx', '2026-11-22', 'Material', 'E&S', 'Silt Sock', 'sock', 'Frank Roberts', 'PO-0100', 10, 3, 30)`, [CO]);
    r = await api('POST', '/api/purchase-orders?division=turf&reconcile=1', { reconcile: true });
    po = await stored();
    const dLine = lineOf(po, 'dr-dt-hs-1');
    ok('it is recorded on the order, under that job', r.body.ok && dLine && dLine.source === 'daily' && dLine.split === 's-sb'
      && Number(dLine.qty) === 50, dLine);
    ok('a row on a job the order does not book to is not', !lineOf(po, 'dr-dt-hx-1'));

    console.log('\n[a division tab moves a delivery to the order\'s own job (full-list PUT)]');
    {
      const list = (await api('GET', '/api/purchase-orders?division=turf')).body;
      const base = list.updatedAt;
      const order = list.purchaseOrders.find(p => p.id === 'sp1');
      const l3now = lineOf(order, 'l3');
      // What the tab does itself: the row on the old job goes, a new one on the new job.
      await q('DELETE FROM daily_tracking WHERE company_code = $1 AND row_id = $2', [CO, l3now.po_row_id]);
      await q(`INSERT INTO daily_tracking (row_id, company_code, division, project_id, date, field_type, cost_code, sub_code, material, supplier, po_num, units_purchased, unit_cost, material_cost)
               VALUES ('tab-l3', $1, 'turf', 'hb', '2026-11-21', 'Material', 'E&S', 'Silt Sock', 'Silt sock 12in', 'Frank Roberts', 'PO-0100', 250, 3.18, 795)`, [CO]);
      delete l3now.split;
      l3now.po_row_id = 'tab-l3';
      r = await api('PUT', '/api/purchase-orders?division=turf', {
        purchaseOrders: list.purchaseOrders, baseUpdatedAt: base,
        editedFields: {}, editedLineFields: { sp1: { l3: ['split'] } }, deletedLineIds: {}, deletedOrderIds: [],
      });
      po = await stored();
      const tabRow = await rowOf('tab-l3');
      ok('it saves', r.statusCode === 200 && r.body.ok, r.body);
      ok('the delivery is on the order\'s own job, linked to the tab\'s row', lineOf(po, 'l3').po_row_id === 'tab-l3' && !lineOf(po, 'l3').split, lineOf(po, 'l3'));
      ok('  which is on that job, under its codes', tabRow && tabRow.project_id === 'hb' && tabRow.cost_code === 'E&S'
        && tabRow.sub_code === 'Silt Sock' && money(tabRow.material_cost) === 795, tabRow);
      ok('  and the old job keeps only what is still on it', (await rowsOn('hf')).length === 1, await rowsOn('hf'));
    }

    console.log('\n[the same from a tab a save behind (the merge must not put the old link back)]');
    {
      const list = (await api('GET', '/api/purchase-orders?division=turf')).body;
      const base = list.updatedAt;
      // Somebody else saves in between: the tab's copy is now behind.
      po = await stored();
      po.notes = 'checked';
      await post({ purchaseOrder: po, editedFields: ['notes'], editedLineFields: {} });
      ok('(the list moved on since the tab read it)', (await baseOf()) !== new Date(base).toISOString());
      const order = list.purchaseOrders.find(p => p.id === 'sp1');
      const l2now = lineOf(order, 'l2');
      const oldRow = l2now.po_row_id;
      await q('DELETE FROM daily_tracking WHERE company_code = $1 AND row_id = $2', [CO, oldRow]);
      await q(`INSERT INTO daily_tracking (row_id, company_code, division, project_id, date, field_type, cost_code, sub_code, material, supplier, po_num, units_purchased, unit_cost, material_cost)
               VALUES ('tab-l2', $1, 'turf', 'hs', '2026-11-21', 'Material', 'E&S', 'Silt Sock', 'Silt sock 12in', 'Frank Roberts', 'PO-0100', 300, 3.18, 954)`, [CO]);
      l2now.split = 's-sb';
      l2now.po_row_id = 'tab-l2';
      r = await api('PUT', '/api/purchase-orders?division=turf', {
        purchaseOrders: list.purchaseOrders, baseUpdatedAt: base,
        editedFields: {}, editedLineFields: { sp1: { l2: ['split'] } }, deletedLineIds: {}, deletedOrderIds: [],
      });
      po = await stored();
      ok('it saves', r.statusCode === 200 && r.body.ok, r.body);
      ok('the tab\'s link stands', lineOf(po, 'l2').po_row_id === 'tab-l2' && lineOf(po, 'l2').split === 's-sb', lineOf(po, 'l2'));
      ok('  its row is on Softball, and the old one is gone', (await rowOf('tab-l2')).project_id === 'hs' && !(await rowOf(oldRow)));
      ok('the other job\'s field kept what the tab did not change', po.notes === 'checked');
    }

    console.log('\n[where each job stands]');
    {
      const sum = async pid => (await rowsOn(pid)).reduce((s, x) => s + Number(x.material_cost), 0);
      const hb = await sum('hb'), hs = await sum('hs'), hf = await sum('hf');
      ok('Baseball: its own delivery and the one moved onto it', money(hb) === 1272 + 795, hb);
      ok('Softball: its delivery, and its Daily Tracking row', money(hs) === 954 + 150, hs);
      ok('Football: nothing left on it', money(hf) === 0, hf);
    }

    console.log('\n[the general list has no jobs to split between]');
    r = await post({ purchaseOrder: { ...ORDER(), id: 'gen1', po_number: 'PO-0001', project_id: '' } }, 'purchase_orders');
    const gen = await stored('gen1', 'purchase_orders');
    ok('its splits are dropped', r.body.ok && gen && !('splits' in gen), gen);
    ok('  and so is every delivery\'s split', gen && gen.lines.every(l => !('split' in l)));
    ok('  and nothing is charged to any job', (await q("SELECT 1 FROM daily_tracking WHERE company_code = $1 AND po_num = 'PO-0001'", [CO])).length === 0);

    console.log('\n[the recovery read rebuilds a split order from the mirror]');
    // The list itself is put back afterwards, not the recovery read's copy of
    // it: that read is a last resort, and it does not carry everything (a
    // Daily Tracking delivery's tag, for one).
    const kept = (await q('SELECT value FROM app_data WHERE key = $1', [KEY('turf')]))[0].value;
    await q('DELETE FROM app_data WHERE key = $1', [KEY('turf')]);
    const fallback = (await api('GET', '/api/purchase-orders?division=turf')).body;
    const fb = fallback.purchaseOrders.find(p => p.id === 'sp1');
    ok('its other jobs come back', fb && Array.isArray(fb.splits) && fb.splits.some(s => s.id === 's-sb' && s.project_id === 'hs'), fb && fb.splits);
    ok('  and which job each delivery is for', fb && lineOf(fb, 'l2').split === 's-sb' && !('split' in lineOf(fb, 'l1')), fb && fb.lines);
    await q('INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())', [KEY('turf'), JSON.stringify(kept)]);

    console.log('\n[deleting the order]');
    r = await api('DELETE', '/api/purchase-orders?division=turf&id=sp1');
    ok('removes the rows its deliveries raised on every job', r.body.ok
      && (await q("SELECT row_id FROM daily_tracking WHERE company_code = $1 AND po_num = 'PO-0100' AND row_id NOT LIKE 'dt-%'", [CO])).length === 0,
      await q("SELECT row_id, project_id FROM daily_tracking WHERE company_code = $1 AND po_num = 'PO-0100'", [CO]));
    ok('  and leaves the field\'s Daily Tracking rows', !!(await rowOf('dt-hs-1')) && !!(await rowOf('dt-hx-1')));

    // ── Races ───────────────────────────────────────────────────────────────
    // Each on an order of its own, on jobs ja..je, so the sums above stand.
    const put = body => api('PUT', '/api/purchase-orders?division=turf',
      { editedFields: {}, editedLineFields: {}, deletedLineIds: {}, deletedOrderIds: [], ...body });
    const tabRead = async () => {
      const b = (await api('GET', '/api/purchase-orders?division=turf')).body;
      return { base: b.updatedAt, list: JSON.parse(JSON.stringify(b.purchaseOrders)) };
    };
    // A row as a division tab raises it for a delivery.
    const tabRaise = (rowId, pid, qty, unit, poNum, cc = '', sc = '') => q(
      `INSERT INTO daily_tracking (row_id, company_code, division, project_id, date, field_type, cost_code, sub_code, material, supplier, po_num, units_purchased, unit_cost, material_cost)
       VALUES ($1, $2, 'turf', $3, '2026-11-21', 'Material', $4, $5, 'Sock', 'Supp', $6, $7, $8, $9)`,
      [rowId, CO, pid, cc, sc, poNum, qty, unit, qty * unit]);
    const dropRow = id => q('DELETE FROM daily_tracking WHERE company_code = $1 AND row_id = $2', [CO, String(id)]);
    const rowsFor = poNum => q('SELECT row_id, project_id, cost_code, sub_code, material_cost FROM daily_tracking WHERE company_code = $1 AND po_num = $2 ORDER BY project_id, row_id', [CO, poNum]);
    const charged = async poNum => money((await rowsFor(poNum)).reduce((sum, x) => sum + Number(x.material_cost), 0));
    // Rows naming the order's number that the order itself does not name.
    const unnamed = async (poNum, id) => {
      const o = await stored(id);
      const named = new Set(((o && o.lines) || []).map(l => l.po_row_id).filter(Boolean));
      return (await rowsFor(poNum)).filter(x => !named.has(x.row_id));
    };
    const SOCK = (id, num, lines, splits) => ({ id, po_number: num, title: 'Sock', supplier: 'Supp', status: 'pending', notes: '',
      date_created: '2026-11-20', project_id: 'ja', cost_code: 'OWN', sub_code: 'O1', ...(splits ? { splits } : {}), lines });
    const dl = (id, qty, split) => ({ id, invoice_num: '', date: '2026-11-21', qty: String(qty), unit_cost: '5', tax_pct: '', tax: '', employee: '',
      ...(split ? { split } : {}) });
    const TWO_JOBS = () => [{ id: 's1', project_id: 'jb', cost_code: 'C', sub_code: 'A' }, { id: 's2', project_id: 'jc', cost_code: 'C', sub_code: 'B' }];

    console.log('\n[a stale tab re-codes one job while purchasing had pointed another elsewhere]');
    {
      r = await post({ purchaseOrder: SOCK('rx1', 'PO-0201', [dl('a1', 10), dl('a2', 20, 's1'), dl('a3', 30, 's2')], TWO_JOBS()) });
      const tab = await tabRead();
      po = await stored('rx1');
      po.splits = po.splits.map(s => (s.id === 's2' ? { ...s, project_id: 'jd' } : s));
      r = await post({ purchaseOrder: po, editedFields: ['split:s2:job', 'split:s2:codes'], editedLineFields: {} });
      ok('(purchasing pointed the second job elsewhere)', r.body.ok && (await rowOf(lineOf(await stored('rx1'), 'a3').po_row_id)).project_id === 'jd');
      const t = tab.list.find(p => p.id === 'rx1');
      t.splits = t.splits.map(s => (s.id === 's1' ? { ...s, sub_code: 'A2' } : s));
      r = await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: { rx1: ['split:s1:codes'] } });
      po = await stored('rx1');
      const a3row = await rowOf(lineOf(po, 'a3').po_row_id);
      ok('the tab saves', r.statusCode === 200 && r.body.ok, r.body);
      ok('the tab\'s re-code is taken', po.splits.find(s => s.id === 's1').sub_code === 'A2', po.splits);
      ok('the job purchasing pointed elsewhere stays there', po.splits.find(s => s.id === 's2').project_id === 'jd', po.splits);
      ok('  and its delivery keeps a live row on it', a3row && a3row.project_id === 'jd', [lineOf(po, 'a3'), await rowsFor('PO-0201')]);
      ok('nothing is left on the job it was pointed away from', !(await rowsOn('jc')).length, await rowsOn('jc'));
      ok('every row is named by the order, which is charged once: $300',
        !(await unnamed('PO-0201', 'rx1')).length && (await charged('PO-0201')) === 300, await rowsFor('PO-0201'));
    }

    console.log('\n[a purchasing page a save behind re-codes one job while another page pointed a second elsewhere]');
    {
      r = await post({ purchaseOrder: SOCK('rx2', 'PO-0202', [dl('b1', 10), dl('b2', 20, 's2')], TWO_JOBS()) });
      const pageA = JSON.parse(JSON.stringify(await stored('rx2')));
      po = await stored('rx2');
      po.splits = po.splits.map(s => (s.id === 's2' ? { ...s, project_id: 'jd' } : s));
      await post({ purchaseOrder: po, editedFields: ['split:s2:job', 'split:s2:codes'], editedLineFields: {} });
      pageA.splits = pageA.splits.map(s => (s.id === 's1' ? { ...s, sub_code: 'A2' } : s));
      r = await post({ purchaseOrder: pageA, editedFields: ['split:s1:codes'], editedLineFields: {} });
      po = await stored('rx2');
      ok('it saves its own re-code', r.body.ok && po.splits.find(s => s.id === 's1').sub_code === 'A2', po.splits);
      ok('  and leaves the other page\'s move, with its delivery\'s row', po.splits.find(s => s.id === 's2').project_id === 'jd'
        && (await rowOf(lineOf(po, 'b2').po_row_id)).project_id === 'jd', [po.splits, await rowsFor('PO-0202')]);
      ok('  every row named, the order charged once: $150',
        !(await unnamed('PO-0202', 'rx2')).length && (await charged('PO-0202')) === 150, await rowsFor('PO-0202'));
    }

    console.log('\n[a stale tab moves a delivery onto a job purchasing had pointed elsewhere]');
    {
      r = await post({ purchaseOrder: SOCK('rx3', 'PO-0203', [dl('k1', 10, 's1')], TWO_JOBS()) });
      const tab = await tabRead();
      po = await stored('rx3');
      const k1row = lineOf(po, 'k1').po_row_id;
      po.splits = po.splits.map(s => (s.id === 's2' ? { ...s, project_id: 'jd' } : s));
      await post({ purchaseOrder: po, editedFields: ['split:s2:job', 'split:s2:codes'], editedLineFields: {} });
      // What the tab does when it moves a delivery: the old job's row goes, and
      // it raises one on the job ITS copy has the second job on.
      await dropRow(k1row);
      await tabRaise('tab-k1', 'jc', 10, 5, 'PO-0203', 'C', 'B');
      const t = tab.list.find(p => p.id === 'rx3');
      lineOf(t, 'k1').split = 's2';
      lineOf(t, 'k1').po_row_id = 'tab-k1';
      r = await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedLineFields: { rx3: { k1: ['split'] } } });
      po = await stored('rx3');
      const k1 = lineOf(po, 'k1');
      const k1now = k1 && k1.po_row_id ? await rowOf(k1.po_row_id) : null;
      ok('the tab saves', r.statusCode === 200 && r.body.ok, r.body);
      ok('the delivery is on the second job, where purchasing pointed it', k1.split === 's2' && po.splits.find(s => s.id === 's2').project_id === 'jd', [k1, po.splits]);
      ok('  its row is on that job, and the tab\'s on the old one is gone', k1now && k1now.project_id === 'jd' && !(await rowOf('tab-k1')),
        [k1, await rowsFor('PO-0203')]);
      po.notes = 'later';
      await post({ purchaseOrder: po, editedFields: ['notes'], editedLineFields: {} });
      ok('after a later save it is still charged once: $50',
        (await charged('PO-0203')) === 50 && !(await unnamed('PO-0203', 'rx3')).length, await rowsFor('PO-0203'));
    }

    console.log('\n[a stale tab moves a delivery onto a job purchasing had just taken off]');
    {
      r = await post({ purchaseOrder: SOCK('rx4', 'PO-0204', [dl('g1', 10, 's1')], TWO_JOBS()) });
      const tab = await tabRead();
      po = await stored('rx4');
      const g1row = lineOf(po, 'g1').po_row_id;
      po.splits = po.splits.filter(s => s.id !== 's2');
      await post({ purchaseOrder: po, editedFields: ['split:s2:remove'], editedLineFields: {} });
      ok('(purchasing took the empty job off)', !(await stored('rx4')).splits.some(s => s.id === 's2'));
      await dropRow(g1row);
      await tabRaise('tab-g1', 'jc', 10, 5, 'PO-0204', 'C', 'B');
      const t = tab.list.find(p => p.id === 'rx4');
      lineOf(t, 'g1').split = 's2';
      lineOf(t, 'g1').po_row_id = 'tab-g1';
      r = await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedLineFields: { rx4: { g1: ['split'] } } });
      po = await stored('rx4');
      ok('the tab saves', r.statusCode === 200 && r.body.ok, r.body);
      ok('the job the tab put the delivery on is back on the order', po.splits.some(s => s.id === 's2' && s.project_id === 'jc'), po.splits);
      ok('  with the delivery on it, on the tab\'s row there', lineOf(po, 'g1').split === 's2' && lineOf(po, 'g1').po_row_id === 'tab-g1'
        && (await rowOf('tab-g1')).project_id === 'jc', lineOf(po, 'g1'));
      po.notes = 'later';
      await post({ purchaseOrder: po, editedFields: ['notes'], editedLineFields: {} });
      ok('after a later save it is still charged once: $50', (await charged('PO-0204')) === 50, await rowsFor('PO-0204'));
    }

    console.log('\n[a stale tab moves the order\'s own job while purchasing moved its delivery onto the other job]');
    {
      r = await post({ purchaseOrder: SOCK('rx5', 'PO-0205', [dl('b1', 10)], TWO_JOBS().slice(0, 1)) });
      const tab = await tabRead();
      po = await stored('rx5');
      const ownRow = lineOf(po, 'b1').po_row_id;
      lineOf(po, 'b1').split = 's1';
      await post({ purchaseOrder: po, editedFields: [], editedLineFields: { b1: ['split'] } });
      po = await stored('rx5');
      const splitRow = lineOf(po, 'b1').po_row_id;
      ok('(purchasing moved the delivery onto the other job)', (await rowOf(splitRow)).project_id === 'jb' && !(await rowOf(ownRow)));
      // The tab moves the order: its copy's row for the delivery goes (already
      // gone), and it raises one on the order's new job.
      await dropRow(ownRow);
      await tabRaise('tab-b1', 'je', 10, 5, 'PO-0205');
      const t = tab.list.find(p => p.id === 'rx5');
      t.project_id = 'je'; t.cost_code = ''; t.sub_code = '';
      lineOf(t, 'b1').po_row_id = 'tab-b1';
      r = await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: { rx5: ['project_id', 'cost_code', 'sub_code'] } });
      po = await stored('rx5');
      ok('the tab saves, moving the order', r.statusCode === 200 && r.body.ok && po.project_id === 'je', r.body);
      ok('the delivery stays on the other job, on purchasing\'s row', lineOf(po, 'b1').split === 's1' && lineOf(po, 'b1').po_row_id === splitRow
        && (await rowOf(splitRow)).project_id === 'jb', [lineOf(po, 'b1'), await rowsFor('PO-0205')]);
      ok('  and the tab\'s row for it on the new job is gone', !(await rowOf('tab-b1')), await rowsFor('PO-0205'));
      ok('  so it is charged once: $50, every row named',
        (await charged('PO-0205')) === 50 && !(await unnamed('PO-0205', 'rx5')).length, await rowsFor('PO-0205'));
    }

    console.log('\n[a tab from before splits moves a split order\'s own job]');
    {
      r = await post({ purchaseOrder: SOCK('rx8', 'PO-0208', [dl('e1', 10), dl('e2', 20, 's1')], TWO_JOBS().slice(0, 1)) });
      const tab = await tabRead();
      const t = tab.list.find(p => p.id === 'rx8');
      // The old code raises every delivery's row again on the order's new job,
      // under the codes it has there (none yet).
      for (const l of t.lines) await dropRow(l.po_row_id);
      await tabRaise('old-e1', 'je', 10, 5, 'PO-0208');
      await tabRaise('old-e2', 'je', 20, 5, 'PO-0208');
      t.project_id = 'je'; t.cost_code = ''; t.sub_code = '';
      lineOf(t, 'e1').po_row_id = 'old-e1';
      lineOf(t, 'e2').po_row_id = 'old-e2';
      r = await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: { rx8: ['project_id', 'cost_code', 'sub_code'] } });
      po = await stored('rx8');
      const e2 = lineOf(po, 'e2');
      const e2row = e2 && e2.po_row_id ? await rowOf(e2.po_row_id) : null;
      ok('it saves, moving the order', r.statusCode === 200 && r.body.ok && po.project_id === 'je', r.body);
      ok('the delivery on the other job keeps a row there, under that job\'s codes',
        e2.split === 's1' && e2row && e2row.project_id === 'jb' && e2row.sub_code === 'A', [e2, e2row, await rowsFor('PO-0208')]);
      ok('  the old tab\'s row for it on the new job is gone', !(await rowOf('old-e2')));
      ok('  the delivery on the order\'s own job is on the tab\'s row', lineOf(po, 'e1').po_row_id === 'old-e1', lineOf(po, 'e1'));
      ok('  so the order is charged once: $150',
        (await charged('PO-0208')) === 150 && !(await unnamed('PO-0208', 'rx8')).length, await rowsFor('PO-0208'));
    }

    console.log('\n[an order moved to another division leaves its other jobs behind]');
    {
      r = await post({ purchaseOrder: SOCK('rx6', 'PO-0206', [dl('m1', 10), dl('m2', 20)]) });
      const pageA = JSON.parse(JSON.stringify(await stored('rx6')));
      po = await stored('rx6');
      po.splits = [{ id: 's1', project_id: 'jb', cost_code: 'C', sub_code: 'A' }];
      lineOf(po, 'm2').split = 's1';
      await post({ purchaseOrder: po, editedFields: ['split:s1:add'], editedLineFields: { m2: ['split'] } });
      ok('(somebody split it, putting a delivery on the other job)', (await rowOf(lineOf(await stored('rx6'), 'm2').po_row_id)).project_id === 'jb');
      pageA.project_id = 'pv1'; pageA.cost_code = 'PC'; pageA.sub_code = 'PS'; pageA.po_number = 'PV-0206';
      r = await api('POST', '/api/purchase-orders?division=paving&from=turf', { purchaseOrder: pageA,
        editedFields: ['project_id', 'cost_code', 'sub_code', 'po_number'], editedLineFields: {} });
      const moved = await stored('rx6', 'paving');
      ok('a page from before the split moves it to paving', r.body.ok && moved && !(await stored('rx6', 'turf')), r.body);
      ok('  without the turf job it was split onto', moved && !('splits' in moved) && moved.lines.every(l => !('split' in l)), moved);
      const both = await q("SELECT division, project_id FROM daily_tracking WHERE company_code = $1 AND po_num IN ('PO-0206', 'PV-0206')", [CO]);
      ok('  both deliveries charged to the paving job, nothing left on turf',
        both.length === 2 && both.every(x => x.division === 'paving' && x.project_id === 'pv1'), both);
    }

    console.log('\n[two purchasing saves at once: one moves a delivery while the other writes its rows]');
    {
      r = await post({ purchaseOrder: SOCK('rx7', 'PO-0207', [dl('c1', 10), dl('c2', 20)], TWO_JOBS().slice(0, 1)) });
      const pageA = JSON.parse(JSON.stringify(await stored('rx7')));
      const pageB = JSON.parse(JSON.stringify(await stored('rx7')));
      let fired = false;
      sqlHook = async text => {
        if (fired || !/INSERT INTO daily_tracking/.test(text)) return;
        fired = true;
        sqlHook = null;
        lineOf(pageB, 'c2').split = 's1';
        await post({ purchaseOrder: pageB, editedFields: [], editedLineFields: { c2: ['split'] } });
      };
      lineOf(pageA, 'c1').qty = '11';
      try { r = await post({ purchaseOrder: pageA, editedFields: [], editedLineFields: { c1: ['qty'] } }); }
      finally { sqlHook = null; }
      ok('(the second save landed while the first was writing its rows)', fired);
      po = await stored('rx7');
      const c2 = lineOf(po, 'c2');
      const c2row = c2 && c2.po_row_id ? await rowOf(c2.po_row_id) : null;
      ok('the first save stores, the moved delivery and its row on one job', r.body.ok && c2row
        && c2row.project_id === poSync.lineJob(po, c2).project_id, [c2, c2row]);
      ok('  leaving no row the order does not name', !(await unnamed('PO-0207', 'rx7')).length, await rowsFor('PO-0207'));
      po.notes = 'later';
      await post({ purchaseOrder: po, editedFields: ['notes'], editedLineFields: {} });
      po = await stored('rx7');
      ok('a later save records no second delivery: $155 in all', (await charged('PO-0207')) === 155
        && !po.lines.some(l => l.source === 'daily'), [await rowsFor('PO-0207'), po.lines]);
    }

    console.log('\n[a purchasing page a save behind clears the job of a job somebody just booked a delivery on]');
    {
      r = await post({ purchaseOrder: SOCK('rx9', 'PO-0209', [dl('m1', 10)], TWO_JOBS().slice(0, 1)) });
      const pageA = JSON.parse(JSON.stringify(await stored('rx9')));
      po = await stored('rx9');
      po.lines.push(dl('m2', 4, 's1'));
      await post({ purchaseOrder: po, editedFields: [], editedLineFields: {} });
      const m2row = lineOf(await stored('rx9'), 'm2').po_row_id;
      ok('(somebody booked a delivery on the other job)', (await rowOf(m2row)).project_id === 'jb');
      // Its copy has nothing on that job, so the page lets its job be cleared.
      pageA.splits = pageA.splits.map(x => (x.id === 's1' ? { ...x, project_id: '', cost_code: '', sub_code: '' } : x));
      r = await post({ purchaseOrder: pageA, editedFields: ['split:s1:job', 'split:s1:codes'], editedLineFields: {} });
      po = await stored('rx9');
      ok('it saves', r.body.ok, r.body);
      ok('the job keeps its job, a delivery being on it', po.splits.some(x => x.id === 's1' && x.project_id === 'jb' && x.sub_code === 'A'), po.splits);
      ok('  and the delivery\'s row stays on it', lineOf(po, 'm2').split === 's1' && lineOf(po, 'm2').po_row_id === m2row
        && (await rowOf(m2row)).project_id === 'jb', [lineOf(po, 'm2'), await rowsFor('PO-0209')]);
      ok('  nothing moves onto the order\'s own job: $70 in all', (await charged('PO-0209')) === 70
        && (await rowsOn('ja')).filter(x => x.po_num === 'PO-0209').length === 1, await rowsFor('PO-0209'));
    }

    console.log('\n[a stale tab clears the job of a job purchasing just booked a delivery on]');
    {
      r = await post({ purchaseOrder: SOCK('rx10', 'PO-0210', [dl('n1', 10)], TWO_JOBS().slice(0, 1)) });
      const tab = await tabRead();
      po = await stored('rx10');
      po.lines.push(dl('n2', 4, 's1'));
      await post({ purchaseOrder: po, editedFields: [], editedLineFields: {} });
      const n2row = lineOf(await stored('rx10'), 'n2').po_row_id;
      const t = tab.list.find(x => x.id === 'rx10');
      t.splits = t.splits.map(x => (x.id === 's1' ? { ...x, project_id: '', cost_code: '', sub_code: '' } : x));
      r = await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: { rx10: ['split:s1:job', 'split:s1:codes'] } });
      po = await stored('rx10');
      ok('the tab saves', r.statusCode === 200 && r.body.ok, r.body);
      ok('the job keeps its job, and the delivery its row there', po.splits.some(x => x.id === 's1' && x.project_id === 'jb')
        && lineOf(po, 'n2') && lineOf(po, 'n2').po_row_id === n2row && (await rowOf(n2row)).project_id === 'jb',
        [po.splits, lineOf(po, 'n2'), await rowsFor('PO-0210')]);
      ok('  charged once: $70', (await charged('PO-0210')) === 70, await rowsFor('PO-0210'));
    }

    console.log('\n[a stale tab points a job elsewhere while purchasing moved one of its deliveries to another job]');
    {
      r = await post({ purchaseOrder: SOCK('rx11', 'PO-0211', [dl('p1', 10), dl('p2', 20, 's1')], TWO_JOBS()) });
      const tab = await tabRead();
      po = await stored('rx11');
      const oldRow = lineOf(po, 'p2').po_row_id;
      lineOf(po, 'p2').split = 's2';
      await post({ purchaseOrder: po, editedFields: [], editedLineFields: { p2: ['split'] } });
      const movedRow = lineOf(await stored('rx11'), 'p2').po_row_id;
      ok('(purchasing moved the delivery to the second job)', (await rowOf(movedRow)).project_id === 'jc' && !(await rowOf(oldRow)));
      // The tab points the first job at jd: the rows of what ITS copy has on
      // that job go, and it raises them again on jd — under its own marks only.
      await dropRow(oldRow);
      await tabRaise('tab-p2', 'jd', 20, 5, 'PO-0211', 'C', 'A');
      const t = tab.list.find(x => x.id === 'rx11');
      t.splits = t.splits.map(x => (x.id === 's1' ? { ...x, project_id: 'jd' } : x));
      lineOf(t, 'p2').po_row_id = 'tab-p2';
      r = await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: { rx11: ['split:s1:job', 'split:s1:codes'] } });
      po = await stored('rx11');
      ok('the tab saves, pointing its job at jd', r.statusCode === 200 && r.body.ok && po.splits.find(x => x.id === 's1').project_id === 'jd', [r.body, po.splits]);
      ok('the delivery stays where purchasing moved it, on its row there', lineOf(po, 'p2').split === 's2' && lineOf(po, 'p2').po_row_id === movedRow
        && (await rowOf(movedRow)).project_id === 'jc', [lineOf(po, 'p2'), await rowsFor('PO-0211')]);
      ok('  and the row the tab raised for it on jd is gone', !(await rowOf('tab-p2')), await rowsFor('PO-0211'));
      po.notes = 'later';
      await post({ purchaseOrder: po, editedFields: ['notes'], editedLineFields: {} });
      po = await stored('rx11');
      ok('after a later save: charged once ($150), no phantom Daily Tracking delivery',
        (await charged('PO-0211')) === 150 && !po.lines.some(l => l.source === 'daily'), [await rowsFor('PO-0211'), po.lines]);
    }

    console.log('\n[a bid code renamed on one of a split order\'s other jobs]');
    {
      const poCodes = require(path.join(ROOT, 'api/lib/bid-po-codes.js'));
      const ESC = [{ id: 's1', project_id: 'jb', cost_code: 'ESC', sub_code: 'Silt Sock' }];
      await post({ purchaseOrder: SOCK('rx12', 'PO-0212', [dl('q1', 10), dl('q2', 4, 's1')], ESC) });
      await post({ purchaseOrder: { ...SOCK('rx13', 'PO-0213', [dl('w1', 2)]), project_id: 'jb', cost_code: 'ESC', sub_code: 'Silt Sock' } });
      // The same codes on a job that is not renamed: left alone.
      await post({ purchaseOrder: SOCK('rx14', 'PO-0214', [dl('v1', 1)], [{ id: 's9', project_id: 'jc', cost_code: 'ESC', sub_code: 'Silt Sock' }]) });
      const q2row = lineOf(await stored('rx12'), 'q2').po_row_id;
      const out = await poCodes.carryBidCodeRenames(makeSql(pool), { companyCode: CO, division: 'turf', projectId: 'jb',
        before: [{ id: 'b1', cost_code: 'ESC', sub_code: 'Silt Sock' }], after: [{ id: 'b1', cost_code: 'ESC', sub_code: 'Silt Sock 12in' }] });
      const a = await stored('rx12'), b = await stored('rx13'), c = await stored('rx14');
      ok('both of the job\'s orders are renamed — the plain one and the split one', out.pos === 2
        && out.ids.slice().sort().join() === 'rx12,rx13', out);
      ok('the split order: only its share on that job takes the new code', a.splits[0].sub_code === 'Silt Sock 12in'
        && a.project_id === 'ja' && a.sub_code === 'O1', a.splits);
      ok('  an order with those codes on another job keeps them', c.splits[0].sub_code === 'Silt Sock', c.splits);
      ok('  and the plain order takes them, as before', b.sub_code === 'Silt Sock 12in');
      const mirror = (await q("SELECT splits FROM purchase_orders WHERE company_code = $1 AND id = 'rx12'", [CO]))[0];
      ok('the mirror carries the split\'s new code', mirror && Array.isArray(mirror.splits) && mirror.splits[0].sub_code === 'Silt Sock 12in', mirror);
      ok('the rows already raised keep theirs (a bid rename re-codes no row)', (await rowOf(q2row)).sub_code === 'Silt Sock');
      const next = await stored('rx12');
      next.lines.push(dl('q3', 2, 's1'));
      await post({ purchaseOrder: next, editedFields: [], editedLineFields: {} });
      const q3 = lineOf(await stored('rx12'), 'q3');
      ok('  and the next delivery on that job is raised under the new code', (await rowOf(q3.po_row_id)).sub_code === 'Silt Sock 12in');
    }

    console.log('\n[purchasing approves an order while the tab raises a blank delivery\'s first row]');
    {
      // Any order, split or not: the tab saved l2 blank (addPOLine), then its
      // quantity is typed — the tab raises its row and saves the link — while
      // a purchasing save that only approves the order is writing its rows.
      await post({ purchaseOrder: SOCK('rx15', 'PO-0215', [dl('f1', 10), { ...dl('f2', 0), qty: '', unit_cost: '' }, dl('f3', 30)]) });
      const tab = await tabRead();
      const pageB = JSON.parse(JSON.stringify(await stored('rx15')));
      pageB.status = 'approved';
      let fired = false;
      sqlHook = async text => {
        if (fired || !/INSERT INTO daily_tracking/.test(text)) return;
        fired = true;
        sqlHook = null;
        await tabRaise('tab-f2', 'ja', 20, 5, 'PO-0215', 'OWN', 'O1');
        const t = tab.list.find(x => x.id === 'rx15');
        Object.assign(lineOf(t, 'f2'), { qty: '20', unit_cost: '5', po_row_id: 'tab-f2' });
        await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedLineFields: { rx15: { f2: ['qty', 'unit_cost'] } } });
      };
      try { r = await post({ purchaseOrder: pageB, editedFields: ['status'], editedLineFields: {} }); }
      finally { sqlHook = null; }
      po = await stored('rx15');
      ok('(the tab saved while the approval was writing)', fired && r.body.ok && po.status === 'approved');
      ok('the delivery keeps the row the tab raised for it', lineOf(po, 'f2').po_row_id === 'tab-f2' && lineOf(po, 'f2').qty === '20'
        && !!(await rowOf('tab-f2')), [lineOf(po, 'f2'), await rowsFor('PO-0215')]);
      ok('  so the job carries the whole order: $300', (await charged('PO-0215')) === 300 && !(await unnamed('PO-0215', 'rx15')).length,
        await rowsFor('PO-0215'));
    }

    console.log('\n[a purchasing page a save behind moves a delivery onto a job somebody took off]');
    {
      await post({ purchaseOrder: SOCK('rx16', 'PO-0216', [dl('g1', 10, 's1')], TWO_JOBS()) });
      const pageA = JSON.parse(JSON.stringify(await stored('rx16')));
      const tab = await tabRead();
      const t = tab.list.find(x => x.id === 'rx16');
      t.splits = t.splits.filter(x => x.id !== 's2');
      await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: { rx16: ['split:s2:remove'] } });
      ok('(the tab took the empty job off)', !(await stored('rx16')).splits.some(x => x.id === 's2'));
      lineOf(pageA, 'g1').split = 's2';
      r = await post({ purchaseOrder: pageA, editedFields: [], editedLineFields: { g1: ['split'] } });
      po = await stored('rx16');
      const g1 = lineOf(po, 'g1');
      const g1row = g1 && g1.po_row_id ? await rowOf(g1.po_row_id) : null;
      ok('the job the page put it on comes back, from the page\'s own copy', r.body.ok && po.splits.some(x => x.id === 's2' && x.project_id === 'jc'), po.splits);
      ok('  and the delivery is charged there, not to the order\'s own job', g1.split === 's2' && g1row && g1row.project_id === 'jc'
        && (await charged('PO-0216')) === 50, [g1, await rowsFor('PO-0216')]);
    }

    console.log('\n[a row the server raises for the tab fails to write once]');
    {
      // The tab moves a split order's own job, not knowing of a delivery
      // purchasing recorded on it meanwhile: the server raises that delivery's
      // row on the new job itself. That write fails once.
      await post({ purchaseOrder: SOCK('rx17', 'PO-0217', [dl('h1', 10), dl('h2', 20, 's1')], TWO_JOBS().slice(0, 1)) });
      const tab = await tabRead();
      po = await stored('rx17');
      po.lines.push(dl('u1', 15));
      await post({ purchaseOrder: po, editedFields: [], editedLineFields: {} });
      const t = tab.list.find(x => x.id === 'rx17');
      await dropRow(lineOf(t, 'h1').po_row_id);
      await tabRaise('tab-h1', 'je', 10, 5, 'PO-0217');
      t.project_id = 'je'; t.cost_code = ''; t.sub_code = '';
      lineOf(t, 'h1').po_row_id = 'tab-h1';
      const body = { purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: { rx17: ['project_id', 'cost_code', 'sub_code'] } };
      let failedOnce = false;
      sqlHook = async (text, values) => {
        if (failedOnce || !/INSERT INTO daily_tracking/.test(text) || (values || []).includes('tab-h1')) return;
        failedOnce = true;
        throw new Error('connection dropped');
      };
      try { r = await put(body); } finally { sqlHook = null; }
      ok('(the row write failed, and the save says it will be retried)', failedOnce && r.statusCode === 500, r.body);
      r = await put(body);
      po = await stored('rx17');
      const u1 = lineOf(po, 'u1');
      const u1row = u1 && u1.po_row_id ? await rowOf(u1.po_row_id) : null;
      ok('the retry raises the delivery\'s row on the order\'s new job', r.statusCode === 200 && u1row && u1row.project_id === 'je', [r.body, u1, await rowsFor('PO-0217')]);
      ok('  and the jobs carry the whole order: $225', (await charged('PO-0217')) === 225 && !(await unnamed('PO-0217', 'rx17')).length,
        await rowsFor('PO-0217'));
    }

    console.log('\n[a link to another division\'s row, planted on an order, reaches no row]');
    {
      // A paving labour row, on no order. A turf order is saved through the tab
      // with a delivery whose link names it (the list is stored as sent).
      await q(`INSERT INTO daily_tracking (row_id, company_code, division, project_id, date, field_type, employee, rate, labor_hours)
               VALUES ('victim-pav-1', $1, 'paving', 'pv9', '2026-11-21', 'Labor', 'Sam', 52.5, 8)`, [CO]);
      await post({ purchaseOrder: SOCK('rx18', 'PO-0218', [dl('t1', 10)], TWO_JOBS().slice(0, 1)) });
      const tab = await tabRead();
      lineOf(tab.list.find(x => x.id === 'rx18'), 't1').po_row_id = 'victim-pav-1';
      tab.list.find(x => x.id === 'rx18').lines.push({ ...dl('t2', 4, 's1'), po_row_id: 'victim-pav-1' });
      await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedLineFields: { rx18: { t2: ['qty'] } } });
      po = await stored('rx18');
      po.status = 'approved';
      r = await post({ purchaseOrder: po, editedFields: ['status'], editedLineFields: {} });
      ok('an approval of that order leaves the other division\'s row alone', r.body.ok && !!(await rowOf('victim-pav-1')), r.body);
      r = await api('DELETE', '/api/purchase-orders?division=turf&id=rx18');
      ok('  and so does deleting the order', r.body.ok && !!(await rowOf('victim-pav-1')), r.body);
      await q("DELETE FROM daily_tracking WHERE company_code = $1 AND row_id = 'victim-pav-1'", [CO]);
    }

    console.log('\n[a stale tab points a job elsewhere after purchasing moved a delivery onto it]');
    {
      r = await post({ purchaseOrder: SOCK('rx19', 'PO-0219', [dl('y1', 10), dl('y2', 20, 's1'), dl('y4', 4)], TWO_JOBS().slice(0, 1)) });
      const tab = await tabRead();
      po = await stored('rx19');
      lineOf(po, 'y4').split = 's1';
      await post({ purchaseOrder: po, editedFields: [], editedLineFields: { y4: ['split'] } });
      const y4row = lineOf(await stored('rx19'), 'y4').po_row_id;
      ok('(purchasing moved y4 onto the other job)', (await rowOf(y4row)).project_id === 'jb');
      // The tab re-points that job: the rows of what ITS copy has there go
      // and are raised again on jd. Its copy still has y4 on the order's own
      // job, under the row purchasing just deleted.
      const t = tab.list.find(x => x.id === 'rx19');
      await dropRow(lineOf(t, 'y2').po_row_id);
      await tabRaise('tab-y2', 'jd', 20, 5, 'PO-0219', 'C', 'A');
      lineOf(t, 'y2').po_row_id = 'tab-y2';
      t.splits = t.splits.map(x => (x.id === 's1' ? { ...x, project_id: 'jd' } : x));
      r = await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: { rx19: ['split:s1:job', 'split:s1:codes'] } });
      po = await stored('rx19');
      const y4 = lineOf(po, 'y4');
      const y4now = y4 && y4.po_row_id ? await rowOf(y4.po_row_id) : null;
      ok('the tab saves, the job now on jd', r.statusCode === 200 && r.body.ok && po.splits.find(x => x.id === 's1').project_id === 'jd', r.body);
      ok('y4, on that job, has a live row on jd', y4.split === 's1' && y4now && y4now.project_id === 'jd', [y4, await rowsFor('PO-0219')]);
      ok('  and nothing is left on jb: the order is charged once, $170', !(await rowsOn('jb')).some(x => x.po_num === 'PO-0219')
        && (await charged('PO-0219')) === 170 && !(await unnamed('PO-0219', 'rx19')).length, await rowsFor('PO-0219'));
    }

    console.log('\n[two pages add the site\'s other jobs a moment apart]');
    {
      await post({ purchaseOrder: SOCK('rx20', 'PO-0220', [dl('z1', 10)]) });
      const tab = await tabRead();
      po = await stored('rx20');
      po.splits = [{ id: 'pA', project_id: 'jb', cost_code: 'C', sub_code: 'A' }, { id: 'pB', project_id: 'jc', cost_code: 'C', sub_code: 'B' }];
      await post({ purchaseOrder: po, editedFields: ['split:pA:add', 'split:pB:add'], editedLineFields: {} });
      const t = tab.list.find(x => x.id === 'rx20');
      t.splits = [{ id: 'tA', project_id: 'jb', cost_code: 'C', sub_code: 'A' }, { id: 'tC', project_id: 'jd', cost_code: 'C', sub_code: 'D' }];
      r = await put({ purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: { rx20: ['split:tA:add', 'split:tC:add'] } });
      po = await stored('rx20');
      const jobs = po.splits.map(x => x.project_id).sort();
      ok('each job is on the order once — the one both added, and each one\'s own', r.body.ok && JSON.stringify(jobs) === '["jb","jc","jd"]', po.splits);
    }

    console.log('\n[a move to another division, retried with a job added in the new one]');
    {
      // On turf with a turf job beside its own. The page moves it to paving;
      // the move is still being retried when the clerk adds a paving job and
      // puts a delivery on it, so one save carries all of it (from=turf).
      await post({ purchaseOrder: SOCK('rx21', 'PO-0221', [dl('k1', 10), dl('k2', 4, 's1')], TWO_JOBS().slice(0, 1)) });
      const page = JSON.parse(JSON.stringify(await stored('rx21')));
      page.project_id = 'pv1'; page.cost_code = 'PC'; page.sub_code = 'PS'; page.po_number = 'PV-0221';
      page.splits = [{ id: 'sP', project_id: 'pv2', cost_code: 'PC', sub_code: 'PS2' }];
      lineOf(page, 'k2').split = 'sP';
      r = await api('POST', '/api/purchase-orders?division=paving&from=turf', { purchaseOrder: page,
        editedFields: ['project_id', 'cost_code', 'sub_code', 'po_number', 'split:s1:remove', 'split:sP:add'], editedLineFields: { k2: ['split'] } });
      const moved = await stored('rx21', 'paving');
      ok('it lands in paving with the paving job the clerk added, and not the turf one', r.body.ok && moved
        && JSON.stringify(poSync.poSplits(moved).map(x => [x.id, x.project_id])) === '[["sP","pv2"]]', moved && moved.splits);
      const k2 = lineOf(moved, 'k2');
      const k2row = k2 && k2.po_row_id ? await rowOf(k2.po_row_id) : null;
      ok('  the delivery put on it is charged there, in paving', k2.split === 'sP' && k2row && k2row.division === 'paving' && k2row.project_id === 'pv2',
        [k2, k2row]);
      const left = await q("SELECT 1 FROM daily_tracking WHERE company_code = $1 AND division = 'turf' AND po_num = 'PO-0221'", [CO]);
      ok('  and nothing is left on turf', !left.length && !(await stored('rx21', 'turf')));
    }

    console.log('\n[a view-only account cannot save the list]');
    {
      const vid = (await q("INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ('posplit_view', $1, 'x', 'level1', $2) RETURNING id",
        [CO, JSON.stringify({ turf: 'level1' })]))[0].id;
      const viewer = jwt.sign({ userId: vid, username: 'posplit_view', name: 'Vi', companyCode: CO, role: 'level1', divisionRoles: { turf: 'level1' } }, process.env.JWT_SECRET);
      const tab = await tabRead();
      const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: { authorization: 'Bearer ' + viewer },
        body: { purchaseOrders: tab.list, baseUpdatedAt: tab.base, editedFields: {}, editedLineFields: {}, deletedLineIds: {}, deletedOrderIds: [] } }, res);
      ok('its PUT is refused, as its POST is (403)', res.statusCode === 403, res.body);
      const res2 = { ...res, statusCode: 200, body: null };
      await handler({ method: 'GET', query: { division: 'turf' }, headers: { authorization: 'Bearer ' + viewer } }, res2);
      ok('  while it still reads the list', res2.statusCode === 200 && Array.isArray(res2.body.purchaseOrders), res2.statusCode);
    }
  } catch (err) {
    failed++;
    console.log('  ✗ crashed: ' + (err && err.stack || err));
  } finally {
    try { await cleanUp(); } catch { /* best effort */ }
    await pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
