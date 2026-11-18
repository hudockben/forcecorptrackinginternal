#!/usr/bin/env node
'use strict';
/**
 * A delivery typed on the Purchase Orders tab, a key at a time, in a real
 * browser, on the real pages — the race that filled an order with deliveries
 * nobody entered.
 *
 * Run: node scripts/test-po-keystroke-race-browser.js
 *      (PW_CHROMIUM=/path/to/chrome to point it at a different Chromium)
 *
 * Typing the first figure on a new delivery mints its job row and saves the
 * list, both at once. The row's write was answered with the order as stored
 * BEFORE that save — the delivery still unlinked there — and the page took
 * that link over the one it had just minted. The next key then minted a second
 * row, and so on; every row left behind still named the order, so each came
 * back on it as a "from Daily Tracking" delivery holding whatever had been
 * typed by then (2 @ 0.00, 21.5 @ 0.00, 21.54 @ 2, 21.54 @ 21.7 ...), and the
 * job was charged for all of them. And a row write's answer reaching the page
 * after a later save's put that older copy's figures back on screen.
 *
 * tracker.html, paving.html and kiewit-pinetree.html are booted against an API
 * that keeps job rows and orders in memory, records Daily Tracking deliveries
 * with the server's own functions from api/lib/po-sync.js, and settles a
 * list save per key as api/purchase-orders.js does. Twice per page:
 *
 *  - each row write answered at once, its copy of the order reaching the page
 *    before the save that links the delivery to its row
 *  - each row write's answer held back, reaching the page after the answer to
 *    a save that landed later
 *
 * and then the row is deleted in Daily Tracking, which takes the delivery off
 * the order with it.
 *
 * Either way: one job row for the one delivery, carrying what was typed; the
 * order holds that delivery, linked to it, and no Daily Tracking copy of it;
 * the screen shows what was typed; nothing throws.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const poSync = require('../api/lib/po-sync');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});
const BASE = new Promise(r => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port)));

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + d : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOKEN = 'x.y.z';
const PAGES = [
  { file: 'tracker.html',         division: 'turf',   lists: 'fct_lists',
    index: 'fct_projects_index',        project: 'fct_project_' },
  { file: 'paving.html',          division: 'paving', lists: 'fct_paving_lists',
    index: 'fct_paving_projects_index', project: 'fct_paving_project_' },
  { file: 'kiewit-pinetree.html', division: 'kiewit', lists: 'fct_kiewit_lists',
    index: 'fct_kiewit_projects_index', project: 'fct_kiewit_project_' },
];

const asDbRow = r => ({
  row_id: String(r.id), project_id: r._projectId, date: r.date, employee: r.employee,
  cost_code: r.cost_code, sub_code: r.sub_code, po_num: r.po_num,
  units_purchased: r.units_purchased, unit_cost: r.unit_cost, material_cost: r.material_cost,
  timesheet_entry_id: r.timesheet_entry_id || null,
});
const num = v => { const f = parseFloat(v); return isNaN(f) ? 0 : f; };

async function run(browser, cfg, rowAnswerDelay) {
  console.log(`\n${cfg.file} — row writes answered ${rowAnswerDelay ? `${rowAnswerDelay} ms late` : 'at once'}`);
  // ── the in-memory server ──
  const rows = new Map();
  let blob = [{ id: 'po3', po_number: 'PO-0003', title: 'Cement', supplier: 'Acme', status: 'approved',
                date_created: '2026-11-18', project_id: 'p1', cost_code: '07', sub_code: 'CO7',
                lines: [] }];
  let version = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 18, 12, 0, 0, 0) + (++version) * 1000).toISOString();
  let updatedAt = stamp();
  const rowPosts = [], listPuts = [];
  const dbRows = () => [...rows.values()].map(asDbRow);
  // syncRowsToOrders, against the list as stored right now.
  const syncRows = (ids, deleted) => {
    const byId = new Map(dbRows().map(r => [r.row_id, r]));
    const next = JSON.parse(JSON.stringify(blob));
    const changed = poSync.applyRowsToOrders(next, byId, ids, { deleted: new Set(deleted || []) });
    if (!changed.size) return null;
    blob = next; updatedAt = stamp();
    return { orders: JSON.parse(JSON.stringify(blob.filter(p => changed.has(p.id)))), updatedAt };
  };
  // The list PUT as a current tab gets it from api/purchase-orders.js: the
  // tab's keys and the stored rest, a stale copy's link put back over a row it
  // minted, the Daily Tracking lines derived from the rows, the rows of the
  // deliveries it changed written from the order as stored.
  const putList = body => {
    const sent = JSON.parse(JSON.stringify(body.purchaseOrders || []));
    const sentById = new Map(sent.map(po => [po.id, JSON.stringify(po)]));
    const edits = poSync.editedLineFieldsByOrder(body.editedLineFields) || new Map();
    const editsFor = id => edits.get(String(id)) || new Map();
    const storedById = new Map(blob.map(po => [po.id, po]));
    const moved = body.baseUpdatedAt !== updatedAt;
    const dropRows = [];
    const list = sent.map(po => {
      const was = storedById.get(po.id);
      if (!was) return po;
      const copy = { ...po };
      poSync.settleLineFigures(copy, was, editsFor(po.id));
      if (moved) {
        const wasById = new Map((was.lines || []).map(l => [l.id, l]));
        copy.lines = copy.lines.map(l => {
          if (poSync.isDailyLine(l)) return l;
          const before = wasById.get(l.id);
          if (!before || !before.po_row_id || String(l.po_row_id || '') === String(before.po_row_id)) return l;
          if (!rows.has(String(before.po_row_id))) return l;
          if (l.po_row_id) dropRows.push(String(l.po_row_id));
          return { ...l, po_row_id: before.po_row_id };
        });
      }
      return copy;
    });
    poSync.deriveDailyLines(list, dbRows(), { editedLineFields: po => editsFor(po.id) });
    for (const po of list) {
      const figures = poSync.rowEditedLineIds(editsFor(po.id));
      for (const line of po.lines || []) {
        if (!line.po_row_id || poSync.isDailyLine(line) || !figures.has(String(line.id))) continue;
        const id = String(line.po_row_id);
        const was = rows.get(id) || { id, _projectId: po.project_id, field_type: 'Material',
          cost_code: po.cost_code, sub_code: po.sub_code, material: po.title, supplier: po.supplier };
        rows.set(id, { ...was, date: line.date, employee: line.employee || '', po_num: po.po_number,
          units_purchased: String(poSync.lineHasCost(line) ? num(line.qty) : 0),
          unit_cost: String(poSync.lineHasCost(line) ? poSync.lineUnitCostWithTax(line) : 0),
          material_cost: String(poSync.lineHasCost(line) ? poSync.lineAmt(line) + poSync.lineTax(line) : 0) });
      }
    }
    dropRows.forEach(id => rows.delete(id));
    blob = list; updatedAt = stamp();
    const orders = list.filter(po => sentById.get(po.id) !== JSON.stringify(po));
    return { ok: true, updatedAt, merged: 0, derived: 0, orders: JSON.parse(JSON.stringify(orders)) };
  };

  const LISTS = { equipment: [], employees: [{ name: 'Sam' }], suppliers: [{ name: 'Acme' }] };
  const page = await browser.newPage({ viewport: { width: 1474, height: 889 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.addInitScript(({ t, division }) => {
    localStorage.setItem('fct_token', t);
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'hudockben', role: 'admin',
      companyCode: 'FCT', isPlatformAdmin: true, allowedDivisions: ['turf', 'paving', 'kiewit'] }));
    localStorage.setItem('fct_division', division);
  }, { t: TOKEN, division: cfg.division });
  await page.route('**/api/**', async route => {
    const req = route.request();
    const u   = new URL(req.url());
    const p   = u.pathname;
    const m   = req.method();
    const body = (() => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } })();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/daily-rows') {
      if (m === 'GET') return json({ rows: [...rows.values()].map(r => ({ ...r })), hasMore: false });
      if (m === 'POST') {
        const list = body.rows || (body.row ? [body.row] : []);
        list.forEach(r => {
          rowPosts.push({ ...r });
          if (!rows.has(String(r.id))) rows.set(String(r.id), { ...r, _projectId: body.projectId });
        });
        // Recorded now, as the server does — only the answer is held back.
        const po = syncRows(list.filter(r => String(r.po_num || '').trim()).map(r => String(r.id)));
        if (rowAnswerDelay) await sleep(rowAnswerDelay);
        return json({ ok: true, inserted: list.length, ...(po ? { po } : {}) });
      }
      if (m === 'PUT') {
        const id = u.searchParams.get('id');
        const before = rows.get(id);
        rows.set(id, { ...body.row, id, _projectId: body.projectId || (before && before._projectId) });
        const po = syncRows([id]);
        if (rowAnswerDelay) await sleep(rowAnswerDelay);
        return json({ ok: true, ...(po ? { po } : {}) });
      }
      if (m === 'DELETE') {
        const id = u.searchParams.get('id');
        rows.delete(id);
        // As syncRowsToOrders: the deleted id is one of the rows decided.
        const po = syncRows([id], [id]);
        return json({ ok: true, ...(po ? { po } : {}) });
      }
    }
    if (p === '/api/purchase-orders') {
      if (m === 'GET') return json({ purchaseOrders: JSON.parse(JSON.stringify(blob)), updatedAt });
      if (m === 'POST' && u.searchParams.get('reconcile') === '1') {
        const changed = poSync.deriveDailyLines(blob, dbRows());
        if (changed.size) updatedAt = stamp();
        return json({ ok: true, changed: changed.size, purchaseOrders: JSON.parse(JSON.stringify(blob)), updatedAt });
      }
      if (m === 'PUT') {
        listPuts.push(body);
        return json(putList(body));
      }
    }
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      const values = {};
      if (keys.includes(cfg.project + 'p1')) {
        values[cfg.project + 'p1'] = { id: 'p1', 'project-name': 'Main St', 'job-number': '1',
          bidItems: [{ id: 'b1', cost_code: '07', sub_code: 'CO7', description: 'Cement Soil Stabilization' }],
          status: 'In Progress' };
      }
      if (keys.includes(cfg.lists)) values[cfg.lists] = LISTS;
      return json({ values });
    }
    if (p === '/api/data/' + cfg.index) return json({ value: ['p1'] });
    if (p === '/api/data/' + cfg.lists && m === 'GET') return json({ value: LISTS });
    if (p.startsWith('/api/data/')) return json({ value: null });
    return json({});
  });

  await page.goto((await BASE) + '/' + cfg.file);
  await page.waitForFunction(() => typeof projectsList !== 'undefined' && projectsList.length === 1
    && typeof purchaseOrders !== 'undefined' && purchaseOrders.length === 1, null, { timeout: 20000 });
  await sleep(400);
  await page.click('.tab-btn[data-tab="po"]');
  await sleep(300);
  await page.evaluate(() => { if (!_poExpanded.has('po3')) _togglePOLines('po3'); });
  await sleep(200);

  // ── + Add Delivery, then type it a key at a time ──
  const putsBefore = listPuts.length;
  await page.locator('#po-root button:has-text("Add Delivery")').first().click();
  for (let i = 0; i < 40 && listPuts.length === putsBefore; i++) await sleep(50);
  await sleep(200);
  const lineId = await page.evaluate(() => purchaseOrders.find(p => p.id === 'po3').lines[0].id);
  const field = f => page.locator(`input[data-po-id="po3"][data-line-id="${lineId}"][data-line-field="${f}"]`);
  ok('the new delivery is on screen to type in', await field('qty').count() === 1 && await field('unit_cost').count() === 1);
  await field('qty').click();
  await field('qty').pressSequentially('21.54', { delay: 70 });
  await page.keyboard.press('Tab');
  await field('unit_cost').click();
  await field('unit_cost').pressSequentially('21.75', { delay: 70 });
  await page.keyboard.press('Tab');
  await page.locator('#po-root').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  // Every save, row write and held-back answer settled.
  await sleep(1500 + 4 * rowAnswerDelay);
  await page.evaluate(() => { if (typeof _poApplyDeferred === 'function') _poApplyDeferred(); });
  await sleep(300);

  // ── The job ──
  const onOrder = [...rows.values()].filter(r => String(r.po_num || '') === 'PO-0003');
  ok('the job holds ONE row for the one delivery', onOrder.length === 1,
    JSON.stringify(onOrder.map(r => [r.id, r.units_purchased, r.unit_cost])));
  const row = onOrder[0] || {};
  ok('  carrying what was typed: 21.54 at $21.75', num(row.units_purchased) === 21.54
    && Math.abs(num(row.material_cost) - 21.54 * 21.75) < 0.005, JSON.stringify(row));
  ok('  and the page minted just that one', rowPosts.length === 1,
    JSON.stringify(rowPosts.map(r => [r.id, r.units_purchased, r.unit_cost])));

  // ── The order, as stored ──
  const stored = blob.find(p => p.id === 'po3') || { lines: [] };
  ok('the stored order holds the one delivery, and no Daily Tracking copy of it',
    stored.lines.length === 1 && stored.lines[0].id === lineId && !poSync.isDailyLine(stored.lines[0]),
    JSON.stringify(stored.lines));
  ok('  linked to that row, with what was typed', stored.lines[0] && String(stored.lines[0].po_row_id) === String(row.id)
    && stored.lines[0].qty === '21.54' && stored.lines[0].unit_cost === '21.75', JSON.stringify(stored.lines[0]));

  // ── The page ──
  const mine = await page.evaluate(() => JSON.parse(JSON.stringify(purchaseOrders.find(p => p.id === 'po3').lines)));
  ok('the page shows the same one delivery', mine.length === 1 && mine[0].id === lineId, JSON.stringify(mine));
  ok('  still linked to its row', mine[0] && String(mine[0].po_row_id) === String(row.id), JSON.stringify(mine[0]));
  ok('  and still reading what was typed', mine[0] && mine[0].qty === '21.54' && mine[0].unit_cost === '21.75',
    JSON.stringify(mine[0]));
  const jobRows = await page.evaluate(() => getProj('p1').dailyRows
    .filter(r => String(r.po_num || '') === 'PO-0003').map(r => String(r.id)));
  ok('the job on screen has the one row too', jobRows.length === 1 && jobRows[0] === String(row.id), JSON.stringify(jobRows));
  await page.evaluate(() => renderPOTab());
  await sleep(150);
  ok('the PO tab shows no "from Daily Tracking" delivery',
    !/from Daily Tracking/.test(await page.locator('#po-lines-po3').innerText().catch(() => '')));

  // ── A Daily Tracking edit to the row still reaches the delivery ──
  // The guard against old answers must not stop a newer one: the row's own
  // write in Daily Tracking answers with the order as it is now.
  await page.click('.tab-btn[data-tab="po"]');
  await page.evaluate(() => openDailyView('p1'));
  await sleep(400);
  const i1 = await page.evaluate(id => getProj('p1').dailyRows.findIndex(r => String(r.id) === id), String(row.id));
  const units = page.locator(`input[data-tab="daily"][data-proj="p1"][data-i="${i1}"][data-f="units_purchased"]`);
  if (await units.count() === 1) {
    await units.fill('22');
    await units.blur();
    await sleep(900 + 2 * rowAnswerDelay);
    const after = await page.evaluate(() => JSON.parse(JSON.stringify(purchaseOrders.find(p => p.id === 'po3').lines)));
    ok('a quantity changed on the row in Daily Tracking reaches the delivery on screen',
      after.length === 1 && after[0].qty === '22' && String(after[0].po_row_id) === String(row.id), JSON.stringify(after));
  } else {
    ok('the row is in Daily Tracking to edit', false, 'not found');
  }

  // ── Deleting that row in Daily Tracking takes the delivery off the order ──
  // Left there unlinked, it still counted in the order's total while the job
  // no longer paid for it, and looked like every other delivery.
  const i2 = await page.evaluate(id => getProj('p1').dailyRows.findIndex(r => String(r.id) === id), String(row.id));
  const trash = page.locator(`.del-btn[data-tab="daily"][data-proj="p1"][data-i="${i2}"]`);
  if (await trash.count() === 1) {
    await trash.click();
    await sleep(150);
    const ask = await page.locator('.del-confirm span').innerText().catch(() => '');
    ok('the delete asks, saying the delivery leaves PO-0003 too', /removes the delivery from PO-0003/.test(ask), ask);
    await page.click('.del-confirm .dc-yes');
    await sleep(1200 + 3 * rowAnswerDelay);
    const gone = await page.evaluate(() => JSON.parse(JSON.stringify(purchaseOrders.find(p => p.id === 'po3').lines)));
    ok('the delivery leaves the order on screen', gone.length === 0, JSON.stringify(gone));
    ok('  and as stored', (blob.find(p => p.id === 'po3') || { lines: [1] }).lines.length === 0,
      JSON.stringify((blob.find(p => p.id === 'po3') || {}).lines));
    ok('  and its row is gone from the job', !rows.has(String(row.id)), JSON.stringify([...rows.keys()]));
    await page.reload();
    await page.waitForFunction(() => typeof purchaseOrders !== 'undefined' && purchaseOrders.length === 1, null, { timeout: 20000 });
    await sleep(800);
    const reloaded = await page.evaluate(() => JSON.parse(JSON.stringify(purchaseOrders.find(p => p.id === 'po3').lines)));
    ok('  and stays gone after a reload', reloaded.length === 0, JSON.stringify(reloaded));
  } else {
    ok('the row\'s delete button is in Daily Tracking', false, 'not found');
  }

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    for (const cfg of PAGES) {
      await run(browser, cfg, 0);
      await run(browser, cfg, 400);
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
