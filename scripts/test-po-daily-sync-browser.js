#!/usr/bin/env node
'use strict';
/**
 * Daily Tracking → Purchase Orders, in a real browser, on the real pages.
 *
 * Run: node scripts/test-po-daily-sync-browser.js
 *      (PW_CHROMIUM=/path/to/chrome to point it at a different Chromium)
 *
 * tracker.html, paving.html and kiewit-pinetree.html, booted against an API
 * that keeps its job rows and orders in memory and records Daily Tracking
 * deliveries with the SERVER's own functions from api/lib/po-sync.js — so what
 * the page shows is what the real derivation would store:
 *
 *  - a row already naming one of its job's orders is on it after load
 *  - typing a quantity into Daily Tracking reaches the order, with no
 *    whole-list save from the page
 *  - clearing the row's PO # takes it off; picking it again puts it back
 *  - the PO tab tags it, locks it, and lists a PO # no order holds, whose
 *    Create raises the order with the row on it
 *  - deleting the order leaves the field's row on the job
 *  - nothing throws
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

// A page's row, as the server holds it for the derivation.
const asDbRow = r => ({
  row_id: String(r.id), project_id: r._projectId, date: r.date, employee: r.employee,
  cost_code: r.cost_code, sub_code: r.sub_code, po_num: r.po_num,
  units_purchased: r.units_purchased, unit_cost: r.unit_cost, material_cost: r.material_cost,
  timesheet_entry_id: r.timesheet_entry_id || null,
});

async function run(browser, cfg) {
  console.log(`\n${cfg.file}`);
  // ── the in-memory server ──
  const rows = new Map([
    ['r1', { id: 'r1', _projectId: 'p1', date: '2026-11-02', field_type: 'Material', employee: 'Sam',
             cost_code: '02-100', sub_code: '0420', material: '57 stone', supplier: 'Acme Stone',
             po_num: 'PO-0003', units_purchased: '20', unit_cost: '16', material_cost: '320' }],
    ['r2', { id: 'r2', _projectId: 'p1', date: '2026-11-03', field_type: 'Material', employee: 'Lee',
             cost_code: '03-200', sub_code: '0610', material: 'Rebar', supplier: 'Steel Co',
             po_num: 'PO-0099', units_purchased: '5', unit_cost: '10', material_cost: '50' }],
  ]);
  let blob = [{ id: 'po3', po_number: 'PO-0003', title: 'Aggregate', supplier: 'Acme Stone', status: 'pending',
                date_created: '2026-11-01', project_id: 'p1', cost_code: '', sub_code: '', lines: [] }];
  let version = 1;
  const stamp = () => '2026-11-10T00:00:0' + (version++) + '.000Z';
  let updatedAt = stamp();
  const listPuts = [], rowDeletes = [];
  const dbRows = () => [...rows.values()].map(asDbRow);
  const syncRows = (ids, deleted) => {
    const byId = new Map(dbRows().map(r => [r.row_id, r]));
    const changed = poSync.applyRowsToOrders(blob, byId, ids, { deleted: new Set(deleted || []) });
    if (changed.size) updatedAt = stamp();
    return blob.filter(p => changed.has(p.id));
  };

  const LISTS = { equipment: [], employees: [{ name: 'Sam' }, { name: 'Lee' }], suppliers: [{ name: 'Acme Stone' }] };
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
  await page.route('**/api/**', route => {
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
        list.forEach(r => { if (!rows.has(String(r.id))) rows.set(String(r.id), { ...r, _projectId: body.projectId }); });
        const orders = syncRows(list.filter(r => String(r.po_num || '').trim()).map(r => String(r.id)));
        return json({ ok: true, inserted: list.length, ...(orders.length ? { po: { orders } } : {}) });
      }
      if (m === 'PUT') {
        const id = u.searchParams.get('id');
        const before = rows.get(id);
        rows.set(id, { ...body.row, id, _projectId: body.projectId || (before && before._projectId) });
        const orders = (String((before && before.po_num) || '').trim() || String(body.row.po_num || '').trim()) ? syncRows([id]) : [];
        return json({ ok: true, ...(orders.length ? { po: { orders } } : {}) });
      }
      if (m === 'DELETE') {
        const id = u.searchParams.get('id');
        rowDeletes.push(id); rows.delete(id);
        const orders = syncRows([], [id]);
        return json({ ok: true, ...(orders.length ? { po: { orders } } : {}) });
      }
    }
    if (p === '/api/purchase-orders') {
      if (m === 'GET') return json({ purchaseOrders: JSON.parse(JSON.stringify(blob)), updatedAt });
      if (m === 'POST' && u.searchParams.get('reconcile') === '1') {
        const changed = poSync.deriveDailyLines(blob, dbRows());
        if (changed.size) updatedAt = stamp();
        return json({ ok: true, changed: changed.size, purchaseOrders: JSON.parse(JSON.stringify(blob)), updatedAt });
      }
      if (m === 'POST') {
        const po = body.purchaseOrder;
        poSync.deriveDailyLines([po], dbRows());
        blob = blob.filter(x => x.id !== po.id).concat([po]);
        updatedAt = stamp();
        return json({ ok: true, purchaseOrder: po, rows: { removed: 0, written: 0 }, staleCopy: false, mergedLines: 0 });
      }
      if (m === 'PUT') {
        const list = body.purchaseOrders || [];
        listPuts.push(JSON.parse(JSON.stringify(list)));
        const derived = poSync.deriveDailyLines(list, dbRows()).size;
        blob = list; updatedAt = stamp();
        return json({ ok: true, updatedAt, merged: 0, derived });
      }
    }
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      const values = {};
      if (keys.includes(cfg.project + 'p1')) {
        values[cfg.project + 'p1'] = { id: 'p1', 'project-name': 'Main St', 'job-number': '1',
          bidItems: [{ id: 'b1', cost_code: '02-100', sub_code: '0420', description: 'Stone base' }], status: 'In Progress' };
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
    && (projectsList[0].dailyRows || []).length === 2, null, { timeout: 20000 });
  await page.waitForFunction(() => purchaseOrders.length && (purchaseOrders[0].lines || []).length > 0,
    null, { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const pageLines = () => page.evaluate(() => JSON.parse(JSON.stringify(
    (purchaseOrders.find(p => p.id === 'po3') || { lines: [] }).lines)));

  // ── At load ─────────────────────────────────────────────────────────────
  let lines = await pageLines();
  ok('the row already naming PO-0003 is on it after load',
    lines.length === 1 && lines[0].id === 'dr-r1' && lines[0].source === 'daily' && lines[0].po_row_id === 'r1', JSON.stringify(lines));
  ok('  with its quantity, unit cost and codes',
    lines[0] && lines[0].qty === '20' && lines[0].unit_cost === '16' && lines[0].cost_code === '02-100', JSON.stringify(lines[0]));
  ok('  recorded by the server, with no whole-list save from the page', listPuts.length === 0, listPuts.length);
  ok('the stray PO # is on no order', !blob.some(o => o.lines.some(l => l.po_row_id === 'r2')));

  // ── Daily Tracking edits ────────────────────────────────────────────────
  await page.evaluate(() => openDailyView('p1'));
  await sleep(400);
  const idx = id => page.evaluate(i => getProj('p1').dailyRows.findIndex(r => String(r.id) === i), id);
  const i1 = await idx('r1');
  const units = page.locator(`input[data-tab="daily"][data-proj="p1"][data-i="${i1}"][data-f="units_purchased"]`);
  await units.fill('25');
  await units.blur();
  await sleep(500);
  lines = await pageLines();
  ok('a quantity typed in Daily Tracking reaches the order', lines[0] && lines[0].qty === '25' && lines[0].unit_cost === '16', JSON.stringify(lines));
  ok('  stored by the server', blob[0].lines[0] && blob[0].lines[0].qty === '25');
  ok('  and still without a whole-list save from the page', listPuts.length === 0, listPuts.length);

  const sel = page.locator(`select[data-tab="daily"][data-proj="p1"][data-i="${i1}"][data-f="po_num"]`);
  await sel.selectOption('');
  await sleep(500);
  ok('clearing the row\'s PO # takes it off the order', (await pageLines()).length === 0 && blob[0].lines.length === 0);
  await page.evaluate(() => renderDailyTable('p1'));
  await sleep(150);
  await page.locator(`select[data-tab="daily"][data-proj="p1"][data-i="${i1}"][data-f="po_num"]`).selectOption('PO-0003');
  await sleep(500);
  lines = await pageLines();
  ok('picking it again puts it back, once', lines.length === 1 && lines[0].id === 'dr-r1' && lines[0].qty === '25', JSON.stringify(lines));
  const cells = await page.locator('select[data-tab="daily"][data-proj="p1"][data-f="po_num"]').evaluateAll(els =>
    els.map(e => ({ v: e.value, disabled: e.disabled, flagged: /outline/.test(e.getAttribute('style') || '') })));
  ok('a Daily Tracking delivery keeps its PO # editable', cells.some(c => c.v === 'PO-0003' && !c.disabled), JSON.stringify(cells));
  ok('a PO # with no order on the job is flagged', cells.some(c => c.v === 'PO-0099' && c.flagged), JSON.stringify(cells));

  // ── The Purchase Orders tab ─────────────────────────────────────────────
  await page.evaluate(() => closeDailyView());
  await page.click('.tab-btn[data-tab="po"]');
  await sleep(400);
  await page.evaluate(() => _togglePOLines('po3'));
  await sleep(200);
  const notice = page.locator('#po-root details.po-orphans');
  ok('the notice of PO #s with no order starts folded', await notice.count() === 1
    && !(await notice.evaluate(d => d.open)) && !(await notice.locator('ul').isVisible()));
  await notice.locator('summary').click();
  await sleep(150);
  await page.evaluate(() => renderPOTab());
  await sleep(150);
  ok('  and, once opened, stays open through a re-render', await page.locator('#po-root details.po-orphans').evaluate(d => d.open));
  const text = await page.locator('#po-root').innerText();
  ok('the PO tab tags the delivery with its row\'s codes', /from Daily Tracking · 02-100 \/ 0420/.test(text), text.slice(0, 500));
  ok('  and shows a lock, not a ✕, on it',
    await page.locator('#po-lines-po3 td[title^="Entered on Daily Tracking"]').count() === 1
    && await page.locator('#po-lines-po3 button[title="Remove delivery"]').count() === 0);
  ok('and lists the PO # no order holds', /PO numbers in Daily Tracking with no purchase order/.test(text) && /PO-0099/.test(text));
  await page.click('#po-root button:has-text("Create PO-0099")');
  await sleep(500);
  const made = await page.evaluate(() => JSON.parse(JSON.stringify(purchaseOrders.find(p => p.po_number === 'PO-0099') || null)));
  ok('Create raises it on the job with its row on it',
    made && made.project_id === 'p1' && made.lines.length === 1 && made.lines[0].po_row_id === 'r2', JSON.stringify(made));
  ok('  saved as that one order', blob.some(o => o.po_number === 'PO-0099') && listPuts.length === 0);
  ok('  and the notice is gone', !/with no purchase order on that job/.test(await page.locator('#po-root').innerText()));

  // ── Deleting the order ──────────────────────────────────────────────────
  await page.locator('.del-btn[data-tab="po"][data-po-id="po3"]').click();
  await sleep(150);
  if (await page.locator('.del-confirm .dc-yes').count()) await page.click('.del-confirm .dc-yes');
  await sleep(500);
  ok('deleting the order deletes no Daily Tracking row', !rowDeletes.includes('r1') && rows.has('r1'), rowDeletes.join());
  ok('  and the row is still on the page', await page.evaluate(() => getProj('p1').dailyRows.some(r => String(r.id) === 'r1')));

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    for (const cfg of PAGES) await run(browser, cfg);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
