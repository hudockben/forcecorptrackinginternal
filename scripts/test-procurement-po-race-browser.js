#!/usr/bin/env node
'use strict';
/**
 * Procurement and the purchase-order saves, in a real browser, against the
 * REAL /api/purchase-orders, /api/daily-rows, /api/procurement and
 * /api/supplier-contacts handlers on a real Postgres — tracker.html.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-procurement-po-race-browser.js
 *      (PW_CHROMIUM=/path/to/chrome to point it at a different Chromium)
 *
 * The Purchase Orders tab saves the whole list one save at a time, takes on
 * what each save answers with (an order raised elsewhere since, say), and
 * drops a read answered before a save landed. Procurement works its PO #,
 * Status and "Create PO from selected" out from that same list. Checked:
 *
 *  - a save's answer that brings in an order while the Procurement sheet is on
 *    screen redraws the sheet: the rows on that order read Ordered — straight
 *    away, and when the answer waited for focus to leave a box
 *  - "Create PO from selected", one PO per sub code, with the minute poll's
 *    read of the list answered before the first order was stored and arriving
 *    after: the order stays on the page, and the second gets the next number
 *  - "Create PO from selected" while a PO save is owed (it failed): nothing is
 *    raised and the user is told why; once the save lands, the rows a
 *    colleague already ordered are found on that order
 *  - the same while a PO save is still out: it waits for the save, then finds
 *    the colleague's order instead of raising a duplicate
 *  - a supplier rename made while a PO save's answer is still to come: the
 *    answer (stored before the rename) does not leave the old supplier on the
 *    page, and Procurement's row on that order reads Ordered
 *  - a person's click (press, release) from a cell onto + Add Row or Create
 *    PO from selected while a save's answer waits for focus to leave: the
 *    press lets the answer in, the sheet's redraw for it waits for the
 *    release, and the click is acted on
 *  - nothing throws
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const Module = require('module');
const { Pool } = require('pg');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const CHROME = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .find(p => p && fs.existsSync(p));
if (!CHROME) { console.log('no Chrome/Chromium on this box — skipping'); process.exit(0); }

const URL_ = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL_.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) { console.error(`Refusing to run: "${dbName}" does not look like a test database.`); process.exit(1); }

process.env.JWT_SECRET = 'proc-po-race-secret';
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
const jwt     = require('jsonwebtoken');
const poSync  = require(path.join(ROOT, 'api/lib/po-sync.js'));
const HANDLERS = {
  '/api/purchase-orders':   require(path.join(ROOT, 'api/purchase-orders.js')),
  '/api/daily-rows':        require(path.join(ROOT, 'api/daily-rows.js')),
  '/api/procurement':       require(path.join(ROOT, 'api/procurement.js')),
  '/api/supplier-contacts': require(path.join(ROOT, 'api/supplier-contacts.js')),
};

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = (t, v = []) => pool.query(t, v).then(r => r.rows);
function deferred() { let resolve; const p = new Promise(r => { resolve = r; }); p.resolve = resolve; return p; }
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(100); }
}

const CO = 'PROCPORACE';
let TOKEN = null;
async function cleanUp() {
  await q('DELETE FROM app_data WHERE key LIKE $1', [CO + ':%']);
  await q('DELETE FROM po_deliveries WHERE company_code = $1', [CO]);
  await q('DELETE FROM purchase_orders WHERE company_code = $1', [CO]);
  await q('DELETE FROM daily_tracking WHERE company_code = $1', [CO]);
  await q('DELETE FROM procurement_items WHERE company_code = $1', [CO]);
  await q('DELETE FROM supplier_contacts WHERE company_code = $1', [CO]);
  await q('DELETE FROM users WHERE company_code = $1', [CO]);
  await q('DELETE FROM companies WHERE code = $1', [CO]);
}
async function setUp() {
  await cleanUp();
  await q("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Procurement PO race', '{turf,paving,kiewit}')", [CO]);
  const roles = { turf: 'admin', paving: 'admin', kiewit: 'admin' };
  const id = (await q("INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ('procpo_admin', $1, 'x', 'admin', $2) RETURNING id",
    [CO, JSON.stringify(roles)]))[0].id;
  TOKEN = jwt.sign({ userId: id, username: 'procpo_admin', name: 'Ada', companyCode: CO, role: 'admin', divisionRoles: roles }, process.env.JWT_SECRET);
}

async function callApi(method, url, body) {
  const u = new URL(url, 'http://x');
  const handler = HANDLERS[u.pathname];
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
  await handler({ method, query: Object.fromEntries(u.searchParams), body: body == null ? {} : body,
    headers: { authorization: 'Bearer ' + TOKEN } }, res);
  return res;
}

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});
const BASE = new Promise(r => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port)));

const pad = n => String(n).padStart(2, '0');
const daysAgo = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// Two orders on job p1 (PO-0009 has two deliveries, each with its cost row),
// and Procurement rows on p1: by default r1/r2 on 04-300 / 0700 from Acme
// Supply (on no order yet) and r3, which PO-0009 matches by codes and vendor.
// r1 is the bid line's own row and r2 a material added under it, so an order
// raised for the line elsewhere is r1's (procurement.js autoTaker), not both.
const DEFAULT_ROWS = [
  { id: 'r1', cost_code: '04-300', sub_code: '0700', description: 'Drain pipe',     vendor: 'Acme Supply', source: 'bid', bid_item_id: 'b3' },
  { id: 'r2', cost_code: '04-300', sub_code: '0700', description: 'Drain fittings', vendor: 'Acme Supply', bid_item_id: 'b3' },
  { id: 'r3', cost_code: '03-200', sub_code: '0610', description: 'Infill',         vendor: 'Acme Supply' },
];
async function seed(rows = DEFAULT_ROWS) {
  await setUp();
  const d = daysAgo(2);
  const ln = (id, qty, row) => ({ id, invoice_num: '', date: d, qty: String(qty), unit_cost: '10', tax: '', tax_pct: '', employee: '', po_row_id: row });
  const list = [
    { id: 'po7', po_number: 'PO-0007', title: 'Geofabric', supplier: 'LB Water', status: 'pending', notes: '', date_created: daysAgo(6),
      project_id: 'p1', cost_code: '02-100', sub_code: '0420', lines: [ln('l71', 5, 'dr71')] },
    { id: 'po9', po_number: 'PO-0009', title: 'Infill', supplier: 'Acme Supply', status: 'pending', notes: '', date_created: daysAgo(3),
      project_id: 'p1', cost_code: '03-200', sub_code: '0610', lines: [ln('l91', 3, 'dr91'), ln('l92', 4, 'dr92')] },
  ];
  await q('INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())',
    [poSync.blobKeyFor(CO, 'turf'), JSON.stringify(list)]);
  for (const [row, sup, qty, po, cc, sc] of [['dr71', 'LB Water', 5, 'PO-0007', '02-100', '0420'],
    ['dr91', 'Acme Supply', 3, 'PO-0009', '03-200', '0610'], ['dr92', 'Acme Supply', 4, 'PO-0009', '03-200', '0610']]) {
    await q(`INSERT INTO daily_tracking (row_id, company_code, division, project_id, date, field_type, cost_code, sub_code, material, supplier, po_num, units_purchased, unit_cost, material_cost, quantity)
             VALUES ($1, $2, 'turf', 'p1', $3, 'Material', $4, $5, 'stone', $6, $7, $8, 10, $9, $8)`,
      [row, CO, d, cc, sc, sup, po, qty, qty * 10]);
  }
  for (const r of rows) {
    await q(`INSERT INTO procurement_items (id, company_code, division, project_id, source, bid_item_id, cost_code, sub_code, description, vendor, date_needed, lead_time_days)
             VALUES ($1, $2, 'turf', 'p1', $8, $9, $3, $4, $5, $6, $7, 3)`,
      [r.id, CO, r.cost_code, r.sub_code, r.description, r.vendor, daysAgo(-20), r.source || 'manual', r.bid_item_id || null]);
  }
}
const storedPOs = async () => (await callApi('GET', '/api/purchase-orders?division=turf')).body.purchaseOrders || [];
// An order raised in central purchasing, on job p1.
const colleagueOrder = (num, cc, sc, supplier) => callApi('POST', '/api/purchase-orders?division=turf', { purchaseOrder: {
  id: 'pox' + num.slice(-2), po_number: num, title: 'Drain pipe', supplier, status: 'pending', date_created: daysAgo(0),
  project_id: 'p1', cost_code: cc, sub_code: sc, notes: '', lines: [] } });

/**
 * W: { log, failPut, holdPutAnswer (ms a PUT's answer waits after the server
 * stored it), holdPutBefore (ms a PUT waits before the server sees it),
 * holdGetResp (a promise a PO-list GET's answer waits on, after the server
 * answered it), holdProcWrite (a promise a Procurement write waits on) }
 */
async function openPage(browser, W) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.addInitScript(() => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'procpo_admin', name: 'Ada', role: 'admin', companyCode: 'PROCPORACE',
      divisionRoles: { turf: 'admin', paving: 'admin', kiewit: 'admin' }, allowedDivisions: ['turf', 'paving', 'kiewit'] }));
    localStorage.setItem('fct_division', 'turf');
    localStorage.setItem('fct_proc_project_turf', 'p1');
  });
  const LISTS = { equipment: [], employees: [{ name: 'Sam' }],
    suppliers: [{ name: 'Acme Supply' }, { name: 'LB Water' }, { name: 'Turf Co' }] };
  const PROJECT = { id: 'p1', 'project-name': 'Main St', 'job-number': '1', status: 'In Progress',
    bidItems: [{ id: 'b1', cost_code: '02-100', sub_code: '0420' }, { id: 'b2', cost_code: '03-200', sub_code: '0610' },
               { id: 'b3', cost_code: '04-300', sub_code: '0700' }, { id: 'b4', cost_code: '05-400', sub_code: '0800' }] };
  await page.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    const send = (status, b) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) }).catch(() => {});
    if (HANDLERS[p]) {
      const api = p.split('/').pop();
      if (p === '/api/purchase-orders' && m === 'PUT') {
        if (W.failPut) { W.failPut--; W.log.push({ api, method: m, status: 500, body }); return send(500, { error: 'Could not save the purchase order. Try again.' }); }
        if (W.holdPutBefore) { const ms = W.holdPutBefore; W.holdPutBefore = 0; await sleep(ms); }
      }
      if (p === '/api/procurement' && m !== 'GET' && W.holdProcWrite) { const h = W.holdProcWrite; W.holdProcWrite = null; await h; }
      const r = await callApi(m, u.pathname + u.search, body);
      const entry = { api, method: m, q: Object.fromEntries(u.searchParams), body, status: r.statusCode, resp: r.body };
      W.log.push(entry);
      if (p === '/api/purchase-orders' && m === 'PUT' && W.holdPutAnswer) { const ms = W.holdPutAnswer; W.holdPutAnswer = 0; await sleep(ms); }
      if (p === '/api/purchase-orders' && m === 'GET' && W.holdGetResp) { const h = W.holdGetResp; W.holdGetResp = null; entry.held = true; await h; }
      return send(r.statusCode, r.body);
    }
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      const values = {};
      if (keys.includes('fct_project_p1')) values.fct_project_p1 = PROJECT;
      if (keys.includes('fct_lists')) values.fct_lists = LISTS;
      return send(200, { values });
    }
    if (p === '/api/data/fct_projects_index') return send(200, { value: ['p1'] });
    if (p === '/api/data/fct_lists' && m === 'GET') return send(200, { value: LISTS, updated_at: '2026-01-01T00:00:00Z' });
    if (p === '/api/data/fct_lists' && m === 'PUT') { try { Object.assign(LISTS, (body && body.value) || {}); } catch {} return send(200, { ok: true, updated_at: new Date().toISOString() }); }
    if (p === '/api/data/fct_project_p1' && m === 'GET') return send(200, { value: PROJECT });
    if (p.startsWith('/api/data/')) return send(200, { value: null });
    return send(200, {});
  });
  await page.goto((await BASE) + '/tracker.html');
  await page.waitForFunction(() => typeof projectsList !== 'undefined' && projectsList.length === 1
    && (projectsList[0].dailyRows || []).length === 3 && _poLoadOk && purchaseOrders.length === 2 && !!window.FCTProcurement,
    null, { timeout: 25000 });
  await sleep(700);           // the once-per-load catch-up, answered
  return { ctx, page, errors };
}
const tab = async (page, name) => { await page.click(`.tab-btn[data-tab="${name}"]`); await sleep(300); };
const showSheet = async (page, n) => {
  await tab(page, 'procurement');
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(c => c === n), 10000);
  await sleep(500);
};
// A Procurement row's Status cell and the order numbers it names.
const rowSays = (page, id) => page.evaluate(id => {
  const tr = document.querySelector(`#procurement-root tr.fctproc-row[data-row="${id}"]`);
  if (!tr) return { status: '(no row)', pos: '' };
  const st = tr.querySelector('td.c-status');
  const box = tr.querySelector('[data-pf="po"]'), txt = tr.querySelector('.fctproc-po .fctproc-txt');
  return { status: st ? st.textContent.replace(/\s+/g, ' ').trim() : '', pos: box ? box.value : txt ? txt.textContent.trim() : '' };
}, id);
const isOrdered = s => /^Ordered\b/.test(s.status);
const pagePOs = page => page.evaluate(() => purchaseOrders.map(p => p.po_number).join(','));
const pagePosts = W => W.log.filter(l => l.api === 'purchase-orders' && l.method === 'POST' && l.body && l.body.purchaseOrder);
const poll = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const toasts = page => page.evaluate(() => [...document.querySelectorAll('.fctproc-toast')].map(t => t.textContent.trim()).join(' | '));
const modalText = page => page.evaluate(() => { const m = document.querySelector('.fctproc-modal'); return m ? m.textContent.replace(/\s+/g, ' ').trim() : ''; });
const closeModal = page => page.evaluate(() => { const b = [...document.querySelectorAll('.fctproc-modal button')].find(x => /^Cancel$/.test(x.textContent.trim())); if (b) b.click(); });
const SHOTS = process.env.PROC_PO_RACE_SHOTS || '';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    // ══ 1. A save's answer brings in an order while the sheet is on screen ══
    for (const focused of [false, true]) {
      console.log(`\n[a PO save's answer brings in a colleague's order while Procurement is shown${focused ? ' — held while a box there has focus' : ''}]`);
      await seed();
      const W = { log: [] };
      const { ctx, page, errors } = await openPage(browser, W);
      await showSheet(page, 3);          // the sheet's rows read once already
      await tab(page, 'po');
      ok('colleague raised PO-0010 for 04-300 / 0700, Acme Supply',
        (await colleagueOrder('PO-0010', '04-300', '0700', 'Acme Supply')).statusCode === 200);
      const title = page.locator('[data-po-id="po7"][data-po-field="title"]').first();
      await title.click();
      await title.fill('Geofabric rolls');
      W.holdPutAnswer = focused ? 2000 : 1200;   // answered once the sheet has drawn
      await page.click('.tab-btn[data-tab="procurement"]');   // the blur saves; the sheet draws now
      await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(c => c === 3), 8000);
      await sleep(300);
      const drawn = await rowSays(page, 'r1');
      ok('  the sheet drew before the answer: r1 Not Ordered', /^Not Ordered/.test(drawn.status), drawn);
      if (focused) {
        await page.click('#fctproc-search');
        await until(() => W.log.some(l => l.api === 'purchase-orders' && l.method === 'PUT' && l.status === 200), 6000);
        await until(() => page.evaluate(() => _poDeferredAdopt.length === 1), 4000);
        ok('  the answer waits while the search box has focus', await page.evaluate(() => _poDeferredAdopt.length === 1));
        await page.locator('#procurement-root .fctproc').first().click({ position: { x: 3, y: 3 } });
      } else {
        await until(() => W.log.some(l => l.api === 'purchase-orders' && l.method === 'PUT' && l.status === 200), 6000);
      }
      await until(() => page.evaluate(() => !_poSaving && !_poDeferredAdopt.length && purchaseOrders.some(p => p.po_number === 'PO-0010')), 4000);
      const put = W.log.find(l => l.api === 'purchase-orders' && l.method === 'PUT');
      ok('  the save answered with PO-0010, and the page took it on',
        (put.resp.orders || []).some(o => o.po_number === 'PO-0010') && /PO-0010/.test(await pagePOs(page)),
        { answer: (put.resp.orders || []).map(o => o.po_number), page: await pagePOs(page) });
      await until(async () => isOrdered(await rowSays(page, 'r1')), 2000);
      const r1 = await rowSays(page, 'r1'), r2 = await rowSays(page, 'r2');
      ok('  r1 (the line\'s own row) now reads Ordered on PO-0010 — without waiting for a poll; r2, added under it, is not on it',
        isOrdered(r1) && r1.pos === 'PO-0010' && !isOrdered(r2) && r2.pos !== 'PO-0010', { r1, r2 });
      const stored = await storedPOs();
      ok('  the PO-tab edit is stored, and the colleague\'s order kept',
        stored.find(p => p.id === 'po7').title === 'Geofabric rolls' && stored.some(p => p.po_number === 'PO-0010'));
      await shot(page, 'answer-redraw' + (focused ? '-focused' : ''));
      ok('  nothing threw', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ══ 2. Create PO, one per sub code, with a poll's read straddling the first POST ══
    {
      console.log('\n[Create PO from selected, one PO per sub code, while the minute poll\'s read is out]');
      await seed([
        { id: 'pa', cost_code: '04-300', sub_code: '0700', description: 'Sod',  vendor: 'Turf Co' },
        { id: 'pc', cost_code: '05-400', sub_code: '0800', description: 'Seed', vendor: 'Turf Co' },
      ]);
      const W = { log: [] };
      const { ctx, page, errors } = await openPage(browser, W);
      await showSheet(page, 2);
      await page.check('#procurement-root [data-sel="pa"]');
      await page.check('#procurement-root [data-sel="pc"]');
      await page.click('#procurement-root [data-act="bulk-po"]');
      await until(() => modalText(page).then(t => /span/.test(t)), 5000);
      ok('the "span 2 sub codes" chooser is open', /span 2/.test(await modalText(page)), await modalText(page));
      // The poll reads the list now; the server answers it (no new order yet)
      // and the answer is slow to arrive.
      const getHeld = deferred();
      W.holdGetResp = getHeld;
      await poll(page);
      await until(() => W.log.some(l => l.api === 'purchase-orders' && l.method === 'GET' && l.held), 5000);
      ok('  the poll\'s read was answered before any order was stored', W.log.some(l => l.api === 'purchase-orders' && l.method === 'GET' && l.held));
      const linkHeld = deferred();
      W.holdProcWrite = linkHeld;    // the rows' link to the first order waits
      await page.locator('.fctproc-modal button', { hasText: 'One PO per sub code' }).click();
      await until(() => page.evaluate(() => purchaseOrders.some(p => p.po_number === 'PO-0010')), 5000);
      ok('  the first order is stored and on the page', /PO-0010/.test(await pagePOs(page)) && pagePosts(W).length === 1, await pagePOs(page));
      getHeld.resolve();             // the poll's older answer arrives
      await sleep(800);
      ok('  the poll\'s older read does not take the new order off the page', /PO-0010/.test(await pagePOs(page)), await pagePOs(page));
      linkHeld.resolve();
      await until(() => pagePosts(W).length >= 2, 6000);
      await until(() => toasts(page).then(t => /Created/.test(t)), 4000);
      const nums = pagePosts(W).map(l => l.body.purchaseOrder.po_number);
      ok('  the second order gets the next number', JSON.stringify(nums) === '["PO-0010","PO-0011"]', nums);
      const stored = (await storedPOs()).map(p => p.po_number);
      ok('  stored: one PO-0010 and one PO-0011', stored.filter(n => n === 'PO-0010').length === 1 && stored.includes('PO-0011'), stored);
      await sleep(400);
      const pa = await rowSays(page, 'pa'), pc = await rowSays(page, 'pc');
      ok('  each row reads Ordered on its own order', isOrdered(pa) && pa.pos === 'PO-0010' && isOrdered(pc) && pc.pos === 'PO-0011', { pa, pc });
      ok('  the toast names two different numbers', /PO-0010, PO-0011/.test(await toasts(page)), await toasts(page));
      await shot(page, 'create-straddled');
      ok('  nothing threw', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ══ 3. Create PO while a PO save is owed, then once it lands ══
    {
      console.log('\n[Create PO from selected while a PO save that failed is owed]');
      await seed();
      const W = { log: [] };
      const { ctx, page, errors } = await openPage(browser, W);
      await tab(page, 'po');
      W.failPut = 1;
      await page.evaluate(() => { const p = purchaseOrders.find(x => x.id === 'po7'); p.notes = 'gate code 1234'; _poNoteEdit('po7', 'notes'); savePurchaseOrders(); });
      await until(() => page.evaluate(() => _poSaveFailed && !_poSaving), 5000);
      ok('the PO save failed and is owed', await page.evaluate(() => _poSaveFailed));
      await colleagueOrder('PO-0010', '04-300', '0700', 'Acme Supply');
      await showSheet(page, 3);
      await page.check('#procurement-root [data-sel="r1"]');
      await page.check('#procurement-root [data-sel="r2"]');
      await page.click('#procurement-root [data-act="bulk-po"]');
      await until(() => toasts(page).then(Boolean), 4000);
      await sleep(500);
      const said = await toasts(page);
      ok('  no order is raised', pagePosts(W).length === 0, pagePosts(W).map(l => l.body.purchaseOrder.po_number));
      ok('  and the user is told the PO change has not been saved yet', /not been saved/i.test(said), said);
      ok('  stored: still one PO-0010', (await storedPOs()).filter(p => p.po_number === 'PO-0010').length === 1);
      await shot(page, 'create-owed');
      // The poll sends the save again; it lands, and its answer brings PO-0010.
      await poll(page);
      await until(() => page.evaluate(() => !_poSaveFailed && !_poSaving && purchaseOrders.some(p => p.po_number === 'PO-0010')), 6000);
      ok('  the retried save lands', (await storedPOs()).find(p => p.id === 'po7').notes === 'gate code 1234');
      await page.check('#procurement-root [data-sel="r1"]');
      await page.check('#procurement-root [data-sel="r2"]');
      await page.click('#procurement-root [data-act="bulk-po"]');
      await until(() => modalText(page).then(t => /already on/.test(t)), 5000);
      ok('  Create now finds the rows already on PO-0010', /already on PO-0010/.test(await modalText(page)), await modalText(page));
      await closeModal(page);
      await sleep(300);
      ok('  still no order raised from the page', pagePosts(W).length === 0);
      ok('  nothing threw', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ══ 4. Create PO while a PO save is still out ══
    {
      console.log('\n[Create PO from selected while a PO save is still out]');
      await seed();
      const W = { log: [] };
      const { ctx, page, errors } = await openPage(browser, W);
      await showSheet(page, 3);
      await colleagueOrder('PO-0010', '04-300', '0700', 'Acme Supply');
      await page.check('#procurement-root [data-sel="r1"]');
      await page.check('#procurement-root [data-sel="r2"]');
      W.holdPutBefore = 2000;
      await page.evaluate(() => { const p = purchaseOrders.find(x => x.id === 'po7'); p.notes = 'call ahead'; _poNoteEdit('po7', 'notes'); savePurchaseOrders(); });
      await sleep(200);
      ok('a PO save is out', await page.evaluate(() => _poSaving));
      await page.click('#procurement-root [data-act="bulk-po"]');
      await until(() => modalText(page).then(t => /already on/.test(t)), 8000);
      ok('  Create waits for it, then finds the rows already on PO-0010', /already on PO-0010/.test(await modalText(page)), await modalText(page));
      await closeModal(page);
      await sleep(300);
      ok('  no duplicate order is raised', pagePosts(W).length === 0, pagePosts(W).map(l => l.body.purchaseOrder.po_number));
      ok('  stored: one PO-0010, and the PO-tab edit', (await storedPOs()).filter(p => p.po_number === 'PO-0010').length === 1
        && (await storedPOs()).find(p => p.id === 'po7').notes === 'call ahead');
      ok('  nothing threw', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ══ 5. A supplier rename while a PO save's answer is still to come ══
    {
      console.log('\n[a supplier rename made while a PO save\'s answer (stored before it) is still to come]');
      await seed();
      const W = { log: [] };
      const { ctx, page, errors } = await openPage(browser, W);
      await showSheet(page, 3);
      ok('r3 reads Ordered on PO-0009 to begin with', isOrdered(await rowSays(page, 'r3')), await rowSays(page, 'r3'));
      // Purchasing corrected a delivery on PO-0009 since this page read the
      // list, so the save's answer carries PO-0009 — as stored before the rename.
      await q(`UPDATE app_data SET value = jsonb_set(value, '{1,lines,0,qty}', '"6"'::jsonb), updated_at = NOW() WHERE key = $1`,
        [poSync.blobKeyFor(CO, 'turf')]);
      await tab(page, 'po');
      W.holdPutAnswer = 2500;
      await page.evaluate(() => { const p = purchaseOrders.find(x => x.id === 'po7'); p.title = 'Geofabric rolls'; _poNoteEdit('po7', 'title'); savePurchaseOrders(); });
      await sleep(400);              // stored; its answer held
      await page.evaluate(() => adminSwitchTab('supplier'));
      await until(() => page.evaluate(() => _supContactsLoad.state === 'ok'), 8000);
      const boxes = page.locator('#supplier-root [data-sup-field="name"]');
      let renamed = false;
      for (let i = 0; i < await boxes.count(); i++) {
        if (await boxes.nth(i).inputValue() === 'Acme Supply') {
          await boxes.nth(i).fill('Acme Supply Co');
          await page.locator('#supplier-root').click({ position: { x: 5, y: 5 } });
          renamed = true;
          break;
        }
      }
      ok('  renamed Acme Supply to Acme Supply Co on Admin > Suppliers', renamed);
      await until(() => W.log.some(l => l.api === 'supplier-contacts' && l.q.action === 'rename'), 6000);
      const ren = W.log.find(l => l.api === 'supplier-contacts' && l.q.action === 'rename');
      ok('  the server renamed PO-0009', ren && (ren.resp.po_ids || []).includes('po9'), ren && ren.resp);
      await until(() => W.log.some(l => l.api === 'purchase-orders' && l.method === 'PUT' && l.status === 200), 6000);
      const put = W.log.find(l => l.api === 'purchase-orders' && l.method === 'PUT');
      ok('  the save\'s answer carries PO-0009 with the old supplier',
        (put.resp.orders || []).some(o => o.id === 'po9' && o.supplier === 'Acme Supply'), (put.resp.orders || []).map(o => o.id + ':' + o.supplier));
      await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
      await until(() => page.evaluate(() => !_poSaving && !_poDeferredAdopt.length), 4000);
      await until(() => page.evaluate(() => purchaseOrders.find(p => p.id === 'po9').supplier === 'Acme Supply Co'), 3000);
      const sup = await page.evaluate(() => purchaseOrders.find(p => p.id === 'po9').supplier);
      ok('  the page\'s PO-0009 keeps the new supplier — without waiting for a poll', sup === 'Acme Supply Co', sup);
      ok('  and keeps purchasing\'s quantity', await page.evaluate(() => purchaseOrders.find(p => p.id === 'po9').lines[0].qty) === '6');
      await showSheet(page, 3);
      const r3 = await rowSays(page, 'r3');
      ok('  Procurement\'s r3 (vendor Acme Supply Co) reads Ordered on PO-0009', isOrdered(r3) && r3.pos === 'PO-0009', r3);
      const stored = (await storedPOs()).find(p => p.id === 'po9');
      ok('  stored PO-0009: the new supplier', stored.supplier === 'Acme Supply Co', stored.supplier);
      await shot(page, 'rename-late-answer');
      ok('  nothing threw', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ══ 6. A click from a cell onto a sheet button, with a save's answer held ══
    // The press moves focus out of the cell, which lets the held answer in,
    // and the sheet redraws for it: the redraw waits for the button to come
    // up, so the button pressed is still there for the click.
    for (const v of ['add', 'create']) {
      const what = v === 'add' ? '+ Add Row, from a Quantity cell' : 'Create PO from selected, from a row\'s checkbox';
      console.log(`\n[a person's click on ${what}, while a PO save's answer waits for focus to leave the sheet]`);
      await seed();
      const W = { log: [] };
      const { ctx, page, errors } = await openPage(browser, W);
      await showSheet(page, 3);
      await tab(page, 'po');
      ok('colleague raised PO-0010 for 04-300 / 0700, Acme Supply',
        (await colleagueOrder('PO-0010', '04-300', '0700', 'Acme Supply')).statusCode === 200);
      const title = page.locator('[data-po-id="po7"][data-po-field="title"]').first();
      await title.click();
      await title.fill('Geofabric rolls');
      W.holdPutAnswer = 1500;
      await page.click('.tab-btn[data-tab="procurement"]');   // the blur saves
      await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(c => c === 3), 8000);
      if (v === 'add') await page.locator('#procurement-root [data-pr="r1"][data-pf="quantity"]').click();
      else await page.check('#procurement-root [data-sel="r1"]');
      await until(() => W.log.some(l => l.api === 'purchase-orders' && l.method === 'PUT' && l.status === 200), 6000);
      await until(() => page.evaluate(() => _poDeferredAdopt.length === 1), 4000);
      ok('  the answer (with PO-0010) waits while the cell has focus', await page.evaluate(() => _poDeferredAdopt.length === 1
        && !purchaseOrders.some(p => p.po_number === 'PO-0010')));
      const sel = v === 'add' ? '#procurement-root [data-act="add"]' : '#procurement-root [data-act="bulk-po"]';
      await page.evaluate(sel => {
        window.__btn = document.querySelector(sel);
        window.__clicks = 0;
        document.addEventListener('click', e => { if (e.target.closest && e.target.closest(sel)) window.__clicks++; }, true);
      }, sel);
      const writesBefore = W.log.filter(l => l.api === 'procurement' && l.method !== 'GET').length;
      const bb = await page.locator(sel).boundingBox();
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.mouse.down();
      await sleep(120);
      const mid = await page.evaluate(sel => ({
        taken: purchaseOrders.some(p => p.po_number === 'PO-0010'),
        same: window.__btn.isConnected && document.querySelector(sel) === window.__btn,
      }), sel);
      ok('  the press let the answer in, and the button pressed is still there', mid.taken && mid.same, mid);
      await page.mouse.up();
      if (v === 'add') {
        await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(c => c === 4), 4000);
        const writes = W.log.filter(l => l.api === 'procurement' && l.method !== 'GET').length - writesBefore;
        ok('  the click is acted on: a row is added', await page.evaluate(() => window.__clicks) === 1 && writes >= 1
          && await page.locator('#procurement-root tr.fctproc-row').count() === 4, { clicks: await page.evaluate(() => window.__clicks), writes });
      } else {
        await until(() => modalText(page).then(t => /already on/.test(t)), 6000);
        ok('  the click is acted on: Create finds r1 already on PO-0010', await page.evaluate(() => window.__clicks) === 1
          && /already on PO-0010/.test(await modalText(page)), await modalText(page));
        await closeModal(page);
      }
      await until(async () => isOrdered(await rowSays(page, 'r1')), 3000);
      const r1 = await rowSays(page, 'r1');
      ok('  …and the sheet redraws for the answer once the button is up: r1 Ordered on PO-0010', isOrdered(r1) && r1.pos === 'PO-0010', r1);
      ok('  no order raised', pagePosts(W).length === 0, pagePosts(W).map(l => l.body.purchaseOrder.po_number));
      await shot(page, 'click-held-answer-' + v);
      ok('  nothing threw', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  } catch (e) {
    ok('the run finished', false, e && e.stack);
  } finally {
    await browser.close().catch(() => {});
    server.close();
    await cleanUp().catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
