#!/usr/bin/env node
'use strict';
/**
 * Daily Tracking → Purchase Orders, in a real browser, on the real pages.
 *
 * Run: node scripts/test-po-daily-sync-browser.js
 *      (PW_CHROMIUM=/path/to/chrome to point it at a different Chromium)
 *
 * scripts/test-po-daily-sync.js runs the functions; this runs the PAGE —
 * tracker.html, paving.html and kiewit-pinetree.html, booted against a mocked
 * API — and watches what reaches the server:
 *
 *  - a job row already naming one of its job's orders is recorded on it at
 *    load, and the full-list save carries the delivery
 *  - typing a new quantity into Daily Tracking reaches the order on blur
 *  - the Purchase Orders tab shows the delivery, tagged, and lists a PO # no
 *    order holds — with a button that raises it
 *  - nothing throws
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');

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

// Entered on Daily Tracking against PO-0003, before the rows fed the orders.
const ROW = { id: 'r1', _projectId: 'p1', date: '2026-11-02', field_type: 'Material', employee: 'Sam',
  cost_code: '02-100', sub_code: '0420', material: '57 stone', supplier: 'Acme Stone',
  po_num: 'PO-0003', units_purchased: '20', unit_cost: '16', material_cost: '320' };
// A PO # nothing in the division holds — an import, or an order since deleted.
const STRAY = { ...ROW, id: 'r2', po_num: 'PO-0099', units_purchased: '5', unit_cost: '10', material_cost: '50' };
const ORDER = { id: 'po3', po_number: 'PO-0003', title: 'Aggregate', supplier: 'Acme Stone', status: 'pending',
  date_created: '2026-11-01', project_id: 'p1', cost_code: '', sub_code: '', lines: [] };

async function run(browser, cfg) {
  console.log(`\n${cfg.file}`);
  const puts = [];   // every full-list PO save, parsed
  const LISTS = { equipment: [], employees: [{ name: 'Sam' }], suppliers: [{ name: 'Acme Stone' }] };

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
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/daily-rows') {
      if (m === 'GET') return json({ rows: [ROW, STRAY].map(r => ({ ...r })), hasMore: false });
      return json({ ok: true });
    }
    if (p === '/api/purchase-orders') {
      if (m === 'GET') return json({ purchaseOrders: [JSON.parse(JSON.stringify(ORDER))], updatedAt: '2026-11-10T00:00:00Z' });
      if (m === 'PUT') { try { puts.push(JSON.parse(req.postData() || '{}')); } catch {} }
      return json({ ok: true, updatedAt: '2026-11-10T00:00:0' + puts.length + 'Z', merged: 0 });
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

  // ── At load ─────────────────────────────────────────────────────────────
  const atLoad = await page.evaluate(() => JSON.parse(JSON.stringify(purchaseOrders)));
  const line = ((atLoad[0] || {}).lines || [])[0];
  ok('the row already naming PO-0003 is recorded on it at load',
    line && line.po_row_id === 'r1' && line.source === 'daily', JSON.stringify(atLoad));
  ok('  with its quantity, unit cost and codes',
    line && line.qty === '20' && line.unit_cost === '16' && line.cost_code === '02-100' && line.sub_code === '0420',
    JSON.stringify(line));
  const firstPut = puts[0] && (puts[0].purchaseOrders || [])[0];
  ok('and saved to the server', firstPut && (firstPut.lines || []).some(l => l.po_row_id === 'r1'),
    JSON.stringify(puts));
  ok('  against the version it read', puts[0] && puts[0].baseUpdatedAt === '2026-11-10T00:00:00Z');
  ok('the stray PO # is not invented onto any order',
    !atLoad.some(o => (o.lines || []).some(l => l.po_row_id === 'r2')));

  // ── An edit in Daily Tracking ───────────────────────────────────────────
  await page.evaluate(() => openDailyView('p1'));
  await sleep(400);
  const i = await page.evaluate(() => getProj('p1').dailyRows.findIndex(r => String(r.id) === 'r1'));
  const units = page.locator(`input[data-tab="daily"][data-proj="p1"][data-i="${i}"][data-f="units_purchased"]`);
  const before = puts.length;
  await units.fill('25');
  await units.blur();
  await sleep(400);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(purchaseOrders[0].lines)));
  ok('a new quantity typed in Daily Tracking reaches the order', after[0] && after[0].qty === '25', JSON.stringify(after));
  ok('  and the order is saved with it',
    puts.length > before && (puts[puts.length - 1].purchaseOrders[0].lines || [])[0].qty === '25');
  const sel = await page.locator(`select[data-tab="daily"][data-proj="p1"][data-f="po_num"]`).evaluateAll(els =>
    els.map(e => ({ v: e.value, disabled: e.disabled, flagged: /outline/.test(e.getAttribute('style') || '') })));
  ok('a Daily Tracking delivery keeps its PO # editable', sel.some(s => s.v === 'PO-0003' && !s.disabled), JSON.stringify(sel));
  ok('a PO # with no order on the job is flagged', sel.some(s => s.v === 'PO-0099' && s.flagged), JSON.stringify(sel));

  // ── The Purchase Orders tab ─────────────────────────────────────────────
  await page.evaluate(() => closeDailyView());
  await page.click('.tab-btn[data-tab="po"]');
  await sleep(400);
  await page.evaluate(() => _togglePOLines('po3'));
  await sleep(200);
  const tag = await page.locator('#po-root').innerText();
  ok('the PO tab shows the delivery as from Daily Tracking, with its codes',
    /from Daily Tracking · 02-100 \/ 0420/.test(tag), tag.slice(0, 600));
  ok('and lists the PO # no order holds', /PO numbers in Daily Tracking with no purchase order/.test(tag) && /PO-0099/.test(tag));
  const n = puts.length;
  await page.click('#po-root button:has-text("Create PO-0099")');
  await sleep(400);
  const made = await page.evaluate(() => JSON.parse(JSON.stringify(purchaseOrders.find(p => p.po_number === 'PO-0099') || null)));
  ok('Create raises it on the job, with its row recorded',
    made && made.project_id === 'p1' && made.lines.length === 1 && made.lines[0].po_row_id === 'r2', JSON.stringify(made));
  ok('  and saves it', puts.length > n && puts[puts.length - 1].purchaseOrders.some(o => o.po_number === 'PO-0099'));
  ok('  and the notice is gone', !/with no purchase order on that job/.test(await page.locator('#po-root').innerText()));

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
