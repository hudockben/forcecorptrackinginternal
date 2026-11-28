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
const makeSql = c => (strings, ...values) => {
  let text = '';
  strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
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
    r = await post({ purchaseOrder: po, editedFields: ['splits'], editedLineFields: {} });
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
    r = await post({ purchaseOrder: po, editedFields: ['splits'], editedLineFields: {} });
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
    r = await post({ purchaseOrder: stale, editedFields: ['splits'], editedLineFields: {} });
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
