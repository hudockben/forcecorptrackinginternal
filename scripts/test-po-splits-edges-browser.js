#!/usr/bin/env node
'use strict';
/**
 * The edges of a purchase order split between jobs, in a real browser against
 * a real Postgres — each a defect a review reproduced, checked fixed:
 *
 * The Turf tab (tracker.html; paving.html and kiewit-pinetree.html carry the
 * same block):
 *  - "Split delivery" will not take a share below zero, which balanced the
 *    total, was then dropped, and left the delivery bigger than it was;
 *  - a delivery taxed in flat dollars (an old entry with no tax %) shares its
 *    tax out by quantity, instead of every job but one going untaxed;
 *  - the Job Summary (printed and emailed) counts a split order on each of its
 *    jobs for that job's share, not its whole total on its own job.
 * Central purchasing (purchase-orders.html):
 *  - the same two "Split delivery" checks;
 *  - on a phone, "Jobs on this PO" repaints the card's copy, not only the
 *    table's hidden one;
 *  - an order whose own job is cleared keeps showing its other jobs;
 *  - "+ N more jobs · split PO" opens the order the way its arrow does,
 *    counting each delivery's attachments;
 *  - "+ Add the other <Site> jobs" offers only live jobs, as the tabs do.
 *
 * Run: PG_TEST_URL=postgres://user:pw@localhost/some_test_db node scripts/test-po-splits-edges-browser.js
 *      (default postgres://fct_test_user:test@localhost/fct_test; Chromium at
 *       PW_CHROMIUM or /opt/pw-browsers/chromium, else it skips)
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

process.env.JWT_SECRET = 'po-splits-edges-secret';
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
const HANDLERS = {
  '/api/purchase-orders': require(path.join(ROOT, 'api/purchase-orders.js')),
  '/api/daily-rows':      require(path.join(ROOT, 'api/daily-rows.js')),
};

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = (t, v = []) => pool.query(t, v).then(r => r.rows);
const money = v => Math.round(Number(v) * 100) / 100;

const CO = 'POSPLITE';
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
  await q("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'PO split edges', '{turf,purchase_orders}')", [CO]);
  const roles = { turf: 'admin', purchase_orders: 'admin' };
  const id = (await q("INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ('posplite', $1, 'x', 'admin', $2) RETURNING id",
    [CO, JSON.stringify(roles)]))[0].id;
  TOKEN = jwt.sign({ userId: id, username: 'posplite', name: 'Ada', companyCode: CO, role: 'admin', divisionRoles: roles }, process.env.JWT_SECRET);
}
async function callApi(method, url, body) {
  const u = new URL(url, 'http://x');
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
  await HANDLERS[u.pathname]({ method, query: Object.fromEntries(u.searchParams), body: body == null ? {} : body,
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

// One site: two fields being worked, one still being bid, one on hold, and a
// third live field the orders below are not on.
const bid = (cc, sc) => ({ id: 'b-' + sc, cost_code: cc, sub_code: sc, description: '' });
const PROJECTS = {
  hb:    { id: 'hb',    'project-name': 'Hempfield Baseball', 'job-number': '1', status: 'In Progress', site: 'Hempfield', bidItems: [bid('E&S', 'Silt Sock')] },
  hs:    { id: 'hs',    'project-name': 'Hempfield Softball', 'job-number': '2', status: 'In Progress', site: 'Hempfield', bidItems: [bid('E&S', 'Silt Sock')] },
  hf:    { id: 'hf',    'project-name': 'Hempfield Football', 'job-number': '3', status: 'Awarded',     site: 'Hempfield', bidItems: [bid('E&S', 'Silt Sock')] },
  hbid:  { id: 'hbid',  'project-name': 'Hempfield Track',    'job-number': '4', status: 'Bidding',     site: 'Hempfield', bidItems: [bid('E&S', 'Silt Sock')] },
  hhold: { id: 'hhold', 'project-name': 'Hempfield Tennis',   'job-number': '5', status: 'On Hold',     site: 'Hempfield', bidItems: [bid('E&S', 'Silt Sock')] },
};
const IDS = Object.keys(PROJECTS);
const LISTS = { equipment: [], employees: [{ name: 'Sam' }], suppliers: [{ name: 'Frank Roberts' }] };
const LIVE = new Set(['', 'awarded', 'in progress', 'substantially complete']);

const SPLIT = [{ id: 's-sb', project_id: 'hs', cost_code: 'E&S', sub_code: 'Silt Sock' }];
// A flat-dollar tax no percentage reproduces: an old entry, kept as dollars.
const FLAT = { qty: '1000', unit_cost: '123.4567', tax: '7407.41' };
async function seed() {
  await setUp();
  const orders = [
    { id: 'po1', po_number: 'PO-0501', title: 'Silt sock', supplier: 'Frank Roberts', status: 'pending', notes: '',
      date_created: '2026-11-27', project_id: 'hb', cost_code: 'E&S', sub_code: 'Silt Sock', splits: SPLIT,
      lines: [
        { id: 'd1', invoice_num: 'INV-1', date: '2026-11-27', qty: '10', unit_cost: '5', tax: '', tax_pct: '', employee: '', po_row_id: null },
        { id: 'd2', invoice_num: 'INV-2', date: '2026-11-27', ...FLAT, employee: '', po_row_id: null },
      ] },
    { id: 'po2', po_number: 'PO-0502', title: 'Stakes', supplier: 'Frank Roberts', status: 'pending', notes: '',
      date_created: '2026-11-27', project_id: 'hb', cost_code: 'E&S', sub_code: 'Silt Sock', splits: SPLIT,
      lines: [
        { id: 'e1', invoice_num: 'INV-3', date: '2026-11-27', qty: '10', unit_cost: '3', tax: '', tax_pct: '', employee: '', po_row_id: null },
        { id: 'e2', invoice_num: 'INV-4', date: '2026-11-27', ...FLAT, employee: '', po_row_id: null },
      ] },
  ];
  for (const po of orders) {
    const r = await callApi('POST', '/api/purchase-orders?division=turf', { purchaseOrder: po });
    if (!r.body || !r.body.ok) throw new Error('seed failed: ' + JSON.stringify(r.body));
  }
}
async function stored(id) {
  const r = await q('SELECT value FROM app_data WHERE key = $1', [poSync.blobKeyFor(CO, 'turf')]);
  return ((r[0] && r[0].value) || []).find(p => p && p.id === id) || null;
}
const rowsFor = poNum => q("SELECT row_id, project_id, units_purchased, material_cost FROM daily_tracking WHERE company_code = $1 AND po_num = $2 ORDER BY project_id", [CO, poNum]);
const sumOn = (rows, pid) => money(rows.filter(r => r.project_id === pid).reduce((s, r) => s + Number(r.material_cost), 0));
const lineTotal = l => money(Number(l.qty) * Number(l.unit_cost) + Number(l.tax || 0));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
  return false;
}

async function openTab(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.addInitScript(() => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'posplite', name: 'Ada', role: 'admin', companyCode: 'POSPLITE',
      divisionRoles: { turf: 'admin' }, allowedDivisions: ['turf'] }));
    localStorage.setItem('fct_division', 'turf');
  });
  await page.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    const send = (status, b) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) }).catch(() => {});
    if (HANDLERS[p]) { const r = await callApi(m, u.pathname + u.search, body); return send(r.statusCode, r.body); }
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      const values = {};
      IDS.forEach(id => { if (keys.includes('fct_project_' + id)) values['fct_project_' + id] = PROJECTS[id]; });
      if (keys.includes('fct_lists')) values.fct_lists = LISTS;
      return send(200, { values });
    }
    if (p === '/api/data/fct_projects_index') return send(200, { value: IDS });
    if (p === '/api/data/fct_lists' && m === 'GET') return send(200, { value: LISTS });
    const pm = p.match(/^\/api\/data\/fct_project_(\w+)$/);
    if (pm && m === 'GET') return send(200, { value: PROJECTS[pm[1]] || null });
    if (p.startsWith('/api/data/')) return send(200, { value: null });
    return send(200, {});
  });
  await page.goto((await BASE) + '/tracker.html');
  await page.waitForFunction(n => typeof projectsList !== 'undefined' && projectsList.length === n
    && typeof _poLoadOk !== 'undefined' && _poLoadOk && purchaseOrders.length === 2, IDS.length, { timeout: 30000 });
  await sleep(400);
  return { ctx, page, errors };
}

async function openCentral(browser, viewport) {
  const codesOf = id => PROJECTS[id].bidItems.map(b => ({ cost_code: b.cost_code, sub_code: b.sub_code, description: b.description || '' }));
  const CATALOG = {
    divisions: [{ division: 'turf', label: 'Turf Management', projects: IDS.map(id => ({
      id, name: PROJECTS[id]['project-name'], jobNumber: PROJECTS[id]['job-number'], codes: codesOf(id),
      done: false, live: LIVE.has(PROJECTS[id].status.toLowerCase()), site: PROJECTS[id].site,
    })) }],
    vendors: [{ name: 'Frank Roberts' }], employees: [{ name: 'Sam' }], truncated: [],
  };
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  const docReads = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.addInitScript(() => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'posplite', name: 'Ada', companyCode: 'POSPLITE',
      divisionRoles: { turf: 'admin' }, allowedDivisions: ['turf'] }));
    localStorage.setItem('fct_division', 'purchase_orders');
  });
  await page.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    const send = (status, b) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) }).catch(() => {});
    if (p === '/api/po-catalog') return send(200, CATALOG);
    if (p === '/api/purchase-orders') {
      if (u.searchParams.get('division') !== 'turf') return send(200, { purchaseOrders: [] });
      const r = await callApi(m, u.pathname + u.search, body);
      return send(r.statusCode, r.body);
    }
    if (p === '/api/documents') {
      if (u.searchParams.get('poLineCounts')) { docReads.push(u.searchParams.get('poId')); return send(200, { counts: { e1: 2 } }); }
      return send(200, m === 'GET' ? { counts: {}, documents: [] } : {});
    }
    return send(200, {});
  });
  await page.goto((await BASE) + '/purchase-orders.html');
  await until(() => page.evaluate(() => typeof purchaseOrders !== 'undefined' && purchaseOrders.some(p => p.id === 'po2')), 20000);
  await sleep(300);
  return { ctx, page, errors, docReads };
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    await seed();

    // ── The Turf tab ────────────────────────────────────────────────────────
    const { ctx, page, errors } = await openTab(browser);
    await page.click('.tab-btn[data-tab="po"]');
    await sleep(300);
    await page.evaluate(() => _togglePOLines('po1'));
    await sleep(200);

    console.log('\n[the tab: "Split delivery" takes no share below zero]');
    await page.evaluate(() => openPOSplitDelivery('po1', 'd1'));
    await sleep(150);
    const fill = async (sel, map) => {
      for (const [key, v] of Object.entries(map)) {
        await page.fill(`${sel} input[data-split-key="${key}"]`, String(v));
        await page.dispatchEvent(`${sel} input[data-split-key="${key}"]`, 'input');
      }
      await sleep(80);
    };
    await fill('#po-split-dlg', { '': 15, 's-sb': -5 });
    const negTab = await page.evaluate(() => ({ off: document.getElementById('po-split-ok').disabled, msg: document.getElementById('po-split-sum').textContent }));
    ok('15 and −5 add up to the 10 delivered, but the button stays off', negTab.off && /below zero/.test(negTab.msg), negTab);
    await fill('#po-split-dlg', { '': 6, 's-sb': 4 });
    ok('  6 and 4 turn it on', !(await page.evaluate(() => document.getElementById('po-split-ok').disabled)));
    await page.click('#po-split-ok');
    await until(async () => { const s = await stored('po1'); return s && s.lines.length === 3 && s.lines.every(l => l.po_row_id); });
    await sleep(400);
    let po = await stored('po1');
    ok('the delivery is 6 on its own job, and 4 more go to Softball',
      po.lines.find(l => l.id === 'd1').qty === '6' && po.lines.some(l => l.id !== 'd1' && l.id !== 'd2' && l.qty === '4' && l.split === 's-sb'), po.lines);

    console.log('\n[the tab: a delivery taxed in flat dollars shares its tax out]');
    await page.evaluate(() => openPOSplitDelivery('po1', 'd2'));
    await sleep(150);
    await fill('#po-split-dlg', { '': 500, 's-sb': 500 });
    await page.click('#po-split-ok');
    await until(async () => { const s = await stored('po1'); return s && s.lines.length === 4 && s.lines.every(l => l.po_row_id); });
    await sleep(600);
    po = await stored('po1');
    const d2 = po.lines.find(l => l.id === 'd2');
    const d2b = po.lines.find(l => l.id !== 'd2' && l.qty === '500');
    ok('each half carries its share of the $7,407.41, in dollars',
      d2 && d2b && Math.abs(Number(d2.tax) - 3703.71) < 0.011 && Math.abs(Number(d2b.tax) - 3703.70) < 0.011
      && money(Number(d2.tax) + Number(d2b.tax)) === 7407.41 && !('tax_pct' in d2b), [d2, d2b]);
    const rows1 = await rowsFor('PO-0501');
    const wantHb = lineTotal(po.lines.find(l => l.id === 'd1')) + lineTotal(d2);
    const wantHs = po.lines.filter(l => l.split === 's-sb').reduce((s, l) => s + lineTotal(l), 0);
    ok('  and each job\'s rows carry it: the order still comes to what it did', Math.abs(sumOn(rows1, 'hb') - wantHb) < 0.02
      && Math.abs(sumOn(rows1, 'hs') - wantHs) < 0.02 && Math.abs(sumOn(rows1, 'hb') + sumOn(rows1, 'hs') - (50 + 123456.70 + 7407.41)) < 0.02,
      { rows: rows1, wantHb, wantHs });

    console.log('\n[the tab: the Job Summary counts each job\'s share]');
    const summary = await page.evaluate(async () => {
      const read = async id => {
        const built = await exportJobSummary(id, { returnHtml: true });
        const m = built && built.html.match(/Total Purchases<\/div><div class="sum-val">([^<]*)</);
        return m ? m[1] : null;
      };
      return { hb: await read('hb'), hs: await read('hs'),
        shareHb: _poProjectTotals(purchaseOrders.find(p => p.id === 'po1'), 'hb').total + _poProjectTotals(purchaseOrders.find(p => p.id === 'po2'), 'hb').total,
        shareHs: _poProjectTotals(purchaseOrders.find(p => p.id === 'po1'), 'hs').total + _poProjectTotals(purchaseOrders.find(p => p.id === 'po2'), 'hs').total };
    });
    const dollars = v => Number(String(v || '').replace(/[$,]/g, ''));
    ok('Baseball\'s summary: only Baseball\'s share of the two orders', Math.abs(dollars(summary.hb) - summary.shareHb) < 0.02, summary);
    ok('Softball\'s summary: its share, where it showed nothing', summary.shareHs > 0 && Math.abs(dollars(summary.hs) - summary.shareHs) < 0.02, summary);
    ok('(the tab ran with no errors)', errors.length === 0, errors);
    await ctx.close();

    // ── Central purchasing, on a phone ──────────────────────────────────────
    const c = await openCentral(browser, { width: 390, height: 844 });
    const cp = c.page;

    console.log('\n[purchasing: "+ N more jobs · split PO" counts the deliveries\' attachments]');
    await cp.evaluate(() => { const po = purchaseOrders.find(p => p.id === 'po2'); expanded.delete('po2'); render(); return !!po; });
    const reads = c.docReads.length;
    // The chip is on the desktop row; the phone shows the card, so call what it runs.
    const chipJs = await cp.evaluate(() => { const d = document.createElement('div'); d.innerHTML = splitChipHTML(purchaseOrders.find(p => p.id === 'po2')); return d.firstChild && d.firstChild.getAttribute('onclick'); });
    ok('the chip opens the order through toggleLines', /toggleLines\('po2'\)/.test(chipJs || ''), chipJs);
    await cp.evaluate(js => { new Function(js)(); }, chipJs);
    await until(() => c.docReads.length > reads, 3000);
    ok('  which asks for its deliveries\' attachment counts', c.docReads.slice(reads).includes('po2'), c.docReads);

    console.log('\n[purchasing on a phone: "Jobs on this PO" repaints the card]');
    await sleep(300);
    const own = () => cp.$$eval('[data-jobtot="amt|po2|own"]', els => els.map(e => ({ text: e.textContent, shown: e.offsetParent !== null })));
    let cells = await own();
    // The own job's amount: e1 (10 × $3) and the flat-taxed e2 (1000 × $123.4567), before tax.
    ok('the panel is in the table and the card alike', cells.length === 2 && cells.some(x => x.shown)
      && cells.every(x => x.text === '$123,486.70'), cells);
    const cardQty = '.po-card input[oninput*="setLineField(\'po2\',\'e1\',\'qty\'"]';
    await cp.fill(cardQty, '20');
    await cp.dispatchEvent(cardQty, 'input');
    await sleep(200);
    cells = await own();
    ok('typing 20 on the card repaints both — the one on screen too', cells.length === 2 && cells.every(x => x.text === '$123,516.70'), cells);

    console.log('\n[purchasing: "Split delivery" takes no share below zero, and shares a flat tax]');
    await cp.evaluate(() => openSplitDelivery('po2', 'e1'));
    await sleep(150);
    const fillC = async map => {
      for (const [key, v] of Object.entries(map)) {
        await cp.fill(`input[data-split-key="${key}"]`, String(v));
        await cp.dispatchEvent(`input[data-split-key="${key}"]`, 'input');
      }
      await sleep(80);
    };
    await fillC({ '': 25, 's-sb': -5 });
    const negC = await cp.evaluate(() => ({ off: document.getElementById('split-ok').disabled, msg: document.getElementById('split-sum').textContent }));
    ok('25 and −5 add up to the 20 delivered, but the button stays off', negC.off && /below zero/.test(negC.msg), negC);
    await cp.click('#split-cancel');
    await cp.evaluate(() => openSplitDelivery('po2', 'e2'));
    await sleep(150);
    await fillC({ '': 250, 's-sb': 750 });
    await cp.click('#split-ok');
    await until(async () => { const s = await stored('po2'); return s && s.lines.length === 3 && s.lines.every(l => l.po_row_id); });
    await sleep(500);
    po = await stored('po2');
    const e2 = po.lines.find(l => l.id === 'e2');
    const e2b = po.lines.find(l => l.qty === '750');
    ok('a quarter and three quarters of the flat tax, in dollars, adding back up',
      e2 && e2b && Math.abs(Number(e2.tax) - 1851.85) < 0.011 && Math.abs(Number(e2b.tax) - 5555.56) < 0.011
      && money(Number(e2.tax) + Number(e2b.tax)) === 7407.41 && !('tax_pct' in e2b), [e2, e2b]);
    const rows2 = await rowsFor('PO-0502');
    ok('  each job\'s rows carrying its part', Math.abs(sumOn(rows2, 'hs') - lineTotal(e2b)) < 0.02
      && Math.abs(sumOn(rows2, 'hb') - (lineTotal(po.lines.find(l => l.id === 'e1')) + lineTotal(e2))) < 0.02, rows2);

    console.log('\n[purchasing: "+ Add the other Hempfield jobs" offers only live ones]');
    const offer = await cp.evaluate(() => siteJobsToAdd(purchaseOrders.find(p => p.id === 'po2')).jobs.map(p => p.id).sort());
    ok('Football (awarded) is offered; Track (bidding) and Tennis (on hold) are not', JSON.stringify(offer) === '["hf"]', offer);

    console.log('\n[purchasing: an order whose own job is cleared keeps showing its other jobs]');
    await cp.evaluate(() => setProject('po2', ''));
    await until(async () => { const s = await stored('po2'); return s && !s.project_id; });
    await sleep(400);
    const panel = await cp.$$eval('.po-card .jobs-panel', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    ok('the card still lists the other job, with its share', panel.length === 1 && /Hempfield Softball/.test(panel[0]) && /no job/.test(panel[0]), panel);
    ok('  and a way to take it off', await cp.$$eval('.po-card .jobs-panel button.del-btn', els => els.length) === 1);
    ok('  but no "+ Add job" without a job of its own', !(await cp.$$eval('.po-card .jobs-panel button', els => els.some(b => /Add job/.test(b.textContent)))));
    ok('(purchasing ran with no errors)', c.errors.length === 0, c.errors);
    await c.ctx.close();
  } catch (err) {
    failed++;
    console.log('  ✗ crashed: ' + (err && err.stack || err));
  } finally {
    await browser.close();
    server.close();
    try { await cleanUp(); } catch { /* best effort */ }
    await pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
