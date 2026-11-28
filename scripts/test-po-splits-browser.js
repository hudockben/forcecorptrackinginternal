#!/usr/bin/env node
'use strict';
/**
 * A purchase order split between jobs, on the Turf Purchase Orders tab, in a
 * real browser against a real Postgres.
 *
 * Run: PG_TEST_URL=postgres://user:pw@localhost/some_test_db node scripts/test-po-splits-browser.js
 *      (default postgres://fct_test_user:test@localhost/fct_test; Chromium at
 *       PW_CHROMIUM or /opt/pw-browsers/chromium, else it skips)
 *      SHOTS=dir  also saves screenshots of the expanded order there.
 *
 * The case from the field: PO-0385, silt sock for all four Hempfield fields,
 * entered as one $6,726.97 delivery on Hempfield Baseball. On the tab:
 *  - "+ Add the other Hempfield jobs (3)" puts the site's other fields on the
 *    order, each coded like it where its bid has the same sub code;
 *  - the order says "+ 3 more jobs · split PO" under its Project;
 *  - "⇄" splits the delivery across the four by quantity — a delivery per
 *    field, the same invoice and price — and each field's job row carries its
 *    own share under its own codes;
 *  - the Job column moves a delivery to another field, and its row with it;
 *  - each field's own PO list shows the order with that field's share, and its
 *    Daily Tracking PO # picker offers it.
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

process.env.JWT_SECRET = 'po-splits-browser-secret';
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

const CO = 'POSPLITB';
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
  await q("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'PO splits browser', '{turf,purchase_orders}')", [CO]);
  const roles = { turf: 'admin' };
  const id = (await q("INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ('posplitb', $1, 'x', 'admin', $2) RETURNING id",
    [CO, JSON.stringify(roles)]))[0].id;
  TOKEN = jwt.sign({ userId: id, username: 'posplitb', name: 'Ada', companyCode: CO, role: 'admin', divisionRoles: roles }, process.env.JWT_SECRET);
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

// Four fields of one site, each with its own bid. Soccer's bid names its silt
// sock differently, so it is left for somebody to code.
const bid = (cc, sc, d) => ({ id: 'b-' + sc, cost_code: cc, sub_code: sc, description: d || '' });
const PROJECTS = {
  hb:  { id: 'hb',  'project-name': 'Hempfield Baseball', 'job-number': '26057', status: 'In Progress', site: 'Hempfield',
         bidItems: [bid('Erosion and Sediment Control', 'Silt Sock', 'Silt sock 12"'), bid('Landscaping', 'Seed')] },
  hs:  { id: 'hs',  'project-name': 'Hempfield Softball', 'job-number': '26058', status: 'In Progress', site: 'Hempfield',
         bidItems: [bid('Erosion and Sediment Control', 'Silt Sock', 'Silt sock 12"')] },
  hss: { id: 'hss', 'project-name': 'Hempfield Soccer',   'job-number': '26059', status: 'Awarded', site: 'hempfield',
         bidItems: [bid('Erosion and Sediment Control', 'Silt Sock 18in'), bid('Erosion and Sediment Control', 'Inlet Protection')] },
  hf:  { id: 'hf',  'project-name': 'Hempfield Football', 'job-number': '26060', status: 'In Progress', site: 'Hempfield',
         bidItems: [bid('Erosion and Sediment Control', 'Silt Sock', 'Silt sock 12"')] },
  ox:  { id: 'ox',  'project-name': 'Penn Cambria Field',  'job-number': '26100', status: 'In Progress', site: '',
         bidItems: [bid('Erosion and Sediment Control', 'Silt Sock')] },
};
const IDS = Object.keys(PROJECTS);
const LISTS = { equipment: [], employees: [{ name: 'Sam' }], suppliers: [{ name: 'Frank Roberts' }] };

async function seed() {
  await setUp();
  const list = [{
    id: 'po385', po_number: 'PO-0385', title: '', supplier: 'Frank Roberts', status: 'pending', notes: '',
    date_created: '2026-11-27', project_id: 'hb', cost_code: 'Erosion and Sediment Control', sub_code: 'Silt Sock',
    created_at: '2026-11-27T18:13:00.000Z', created_by: 'strickallen',
    lines: [{ id: 'd1', invoice_num: 'INV-5512', date: '2026-11-27', qty: '1', unit_cost: '6726.97', tax: '', tax_pct: '', employee: '', po_row_id: null }],
  }];
  // Stored the way central purchasing stores it, so the delivery has its row.
  const r = await callApi('POST', '/api/purchase-orders?division=turf', { purchaseOrder: list[0] });
  if (!r.body || !r.body.ok) throw new Error('seed failed: ' + JSON.stringify(r.body));
}

async function openPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.addInitScript(() => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'posplitb', name: 'Ada', role: 'admin', companyCode: 'POSPLITB',
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
    if (HANDLERS[p]) {
      const r = await callApi(m, u.pathname + u.search, body);
      return send(r.statusCode, r.body);
    }
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
    && _poLoadOk && purchaseOrders.length === 1, IDS.length, { timeout: 25000 });
  await sleep(600);
  await page.click('.tab-btn[data-tab="po"]');
  await sleep(300);
  return { ctx, page, errors };
}
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(100); }
}
const settled = page => until(() => page.evaluate(() => !_poSaving && !_poSaveAgain && !Object.keys(_poEditedFields).length
  && !Object.keys(_poEditedLines).length));
const stored = async () => {
  const r = await callApi('GET', '/api/purchase-orders?division=turf');
  return (r.body.purchaseOrders || []).find(p => p.id === 'po385') || null;
};
const rowsFor = async () => q("SELECT row_id, project_id, cost_code, sub_code, units_purchased, material_cost FROM daily_tracking WHERE company_code = $1 AND po_num = 'PO-0385' ORDER BY project_id, row_id", [CO]);

(async () => {
  const shots = process.env.SHOTS || '';
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    await seed();
    const { page, errors } = await openPage(browser);
    const shot = async (name, sel) => {
      if (!shots) return;
      const el = sel ? await page.$(sel) : null;
      await (el || page).screenshot({ path: path.join(shots, name + '.png') });
    };

    console.log('\n[an order on one field, opened]');
    await page.evaluate(() => _togglePOLines('po385'));
    await sleep(200);
    const offer = await page.$eval('#po-jobs-po385', el => el.textContent.replace(/\s+/g, ' ')).catch(() => '');
    ok('it offers to split across jobs, and the rest of its site', /Jobs on this PO/.test(offer) && /\+ Split across jobs/.test(offer)
      && /\+ Add the other Hempfield jobs \(3\)/.test(offer), offer);
    ok('  a job on no site is not offered', !/Penn Cambria/.test(offer));

    console.log('\n[the rest of the site added]');
    await page.click('#po-jobs-po385 button:has-text("Add the other Hempfield jobs")');
    await settled(page);
    let po = await stored();
    const byProj = Object.fromEntries((po.splits || []).map(s => [s.project_id, s]));
    ok('the three other fields are on the order', (po.splits || []).length === 3 && byProj.hs && byProj.hss && byProj.hf, po.splits);
    ok('  each coded like the order where its bid has the same sub code', byProj.hs.sub_code === 'Silt Sock' && byProj.hf.sub_code === 'Silt Sock'
      && byProj.hs.cost_code === 'Erosion and Sediment Control');
    ok('  and left for somebody to code where it does not', byProj.hss.sub_code === '' && byProj.hss.cost_code === '', byProj.hss);
    const chip = await page.$eval('tr:has(#po-arrow-po385) td:nth-child(4)', el => el.textContent.replace(/\s+/g, ' ')).catch(() => '');
    ok('the order says so under its Project', /\+ 3 more jobs · split PO/.test(chip), chip);
    const jobsRows = await page.$$eval('#po-jobs-po385 tbody tr', trs => trs.length);
    ok('Jobs on this PO lists all four', jobsRows === 4, jobsRows);
    const head = await page.$$eval('#po-lines-po385 table thead th', ths => ths.map(t => t.textContent.trim()));
    ok('the deliveries table gains a Job column', head.includes('Job') && head.indexOf('Job') < head.indexOf('Invoice / Ticket #'), head);

    console.log('\n[Soccer coded by hand]');
    await page.click('#po-split-sub-' + byProj.hss.id + ' .cb-input');
    await sleep(150);
    await page.keyboard.type('silt sock 18');
    await sleep(150);
    await page.keyboard.press('Enter');
    await settled(page);
    po = await stored();
    const soccer = (po.splits || []).find(s => s.project_id === 'hss');
    ok('its sub code is its own bid\'s', soccer && soccer.sub_code === 'Silt Sock 18in' && soccer.cost_code === 'Erosion and Sediment Control', soccer);

    console.log('\n[the $6,726.97 delivery split across the four fields]');
    await shot('1-before-split', 'tr#po-lines-po385');
    await page.click('#po-lines-po385 button[title^="Split this delivery"]');
    await sleep(200);
    ok('the split dialog opens with each job', (await page.$$('#po-split-dlg input[data-split-key]')).length === 4);
    await page.click('#po-split-even');
    await sleep(100);
    const sumText = await page.$eval('#po-split-sum', el => el.textContent);
    ok('"Split evenly" shares the quantity out and adds back up', /Total 1(\.00)? of 1(\.00)?$/.test(sumText.trim()), sumText);
    await shot('2-split-dialog', '#po-split-dlg > div');
    await page.click('#po-split-ok');
    await settled(page);
    await sleep(400);
    po = await stored();
    const rows = await rowsFor();
    const byJob = Object.fromEntries(rows.map(r => [r.project_id, r]));
    ok('a delivery per field, same invoice and price', po.lines.length === 4 && po.lines.every(l => l.invoice_num === 'INV-5512'
      && Number(l.unit_cost) === 6726.97), po.lines);
    ok('a job row on each field', rows.length === 4 && ['hb', 'hs', 'hss', 'hf'].every(id => byJob[id]), rows);
    ok('  each under that field\'s own codes', byJob.hss.sub_code === 'Silt Sock 18in' && byJob.hs.sub_code === 'Silt Sock'
      && byJob.hb.cost_code === 'Erosion and Sediment Control', rows);
    const total = rows.reduce((s, r) => s + Number(r.material_cost), 0);
    ok('  and the four shares come back to the invoice', Math.abs(total - 6726.97) < 0.01, total);
    ok('  each field carrying its quarter', rows.every(r => Math.abs(Number(r.material_cost) - 6726.97 / 4) < 0.02), rows.map(r => r.material_cost));
    await page.evaluate(() => renderPOTab());
    await sleep(200);
    await shot('3-after-split', 'tr#po-lines-po385');
    const jobTotals = await page.$$eval('#po-jobs-po385 tbody tr', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ')));
    ok('Jobs on this PO shows each field\'s share', jobTotals.length === 4 && jobTotals.every(t => /\$1,681\.7[45]/.test(t)), jobTotals);

    console.log('\n[a delivery moved to another field]');
    po = await stored();
    const soccerLine = po.lines.find(l => l.split === soccer.id);
    const oldRow = soccerLine.po_row_id;
    await page.selectOption(`select[data-line-id="${soccerLine.id}"][data-line-field="split"]`, byProj.hf.id);
    await settled(page);
    await sleep(400);
    po = await stored();
    const movedLine = po.lines.find(l => l.id === soccerLine.id);
    const after = await rowsFor();
    ok('it is on the new field', movedLine.split === byProj.hf.id, movedLine);
    ok('  its row went with it, under that field\'s codes', !after.some(r => r.row_id === oldRow)
      && after.filter(r => r.project_id === 'hf').length === 2 && after.filter(r => r.project_id === 'hss').length === 0
      && after.filter(r => r.project_id === 'hf').every(r => r.sub_code === 'Silt Sock'), after);

    console.log('\n[each field\'s own views]');
    const hfShare = await page.evaluate(() => _poProjectTotals(purchaseOrders[0], 'hf').total);
    ok('a field\'s share is its deliveries', Math.abs(hfShare - 6726.97 / 2) < 0.02, hfShare);
    const offers = await page.evaluate(() => makePOSelect('hs', '', 0, null));
    ok('a sister field\'s Daily Tracking PO # picker offers the order', /PO-0385/.test(offers), offers);
    const notOffered = await page.evaluate(() => makePOSelect('ox', '', 0, null));
    ok('  a job it does not book to does not', !/PO-0385/.test(notOffered));
    const proc = await page.evaluate(() => {
      const ctx = { purchaseOrders: [], project: null };
      return (window.FCTProcurement ? 'loaded' : 'not loaded');
    });
    console.log('\n[+ Add job, then a job picked for it]');
    {
      const before = (await stored()).splits.length;
      await page.evaluate(() => { _poExpanded.add('po385'); renderPOTab(); });
      await sleep(150);
      await page.click('#po-jobs-po385 button:has-text("+ Add job")');
      await settled(page);
      const blank = (await stored()).splits.find(s => !s.project_id);
      ok('a blank job is added to the order', !!blank && (await stored()).splits.length === before + 1);
      // A picker's list opens over everything around it. The jobs table and
      // the order rows sit in scrolling boxes, which cut off a list drawn
      // inside them: the job's list went under the "+ Add job" row.
      const listOnTop = async sel => {
        await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
        await sleep(150);
        await page.click(sel);
        await sleep(200);
        const out = await page.evaluate(sel => {
          const menu = document.querySelector(sel)?.nextElementSibling;
          const opt = menu && !menu.hidden && menu.querySelector('.cb-opt');
          if (!opt) return { open: false };
          const r = opt.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2);
          return { open: true, position: getComputedStyle(menu).position, onTop: !!hit && menu.contains(hit),
            hit: hit ? hit.tagName + ' ' + (hit.textContent || '').trim().slice(0, 30) : null };
        }, sel);
        await page.keyboard.press('Escape');
        await sleep(150);
        return out;
      };
      const jobList = await listOnTop(`#po-split-proj-${blank.id} .cb-input`);
      ok('  its Job list opens on top, not under the "+ Add job" row', jobList.open && jobList.position === 'fixed' && jobList.onTop, jobList);
      await page.evaluate(() => { _poExpanded.delete('po385'); renderPOTab(); });
      await sleep(300);
      const supplierList = await listOnTop('[data-po-id="po385"][data-po-field="supplier"]');
      ok('  so does the order\'s Supplier list, on the last order row with the order closed', supplierList.open && supplierList.onTop, supplierList);
      await page.evaluate(() => { _poExpanded.add('po385'); renderPOTab(); });
      await sleep(300);
      await page.click(`#po-split-proj-${blank.id} .cb-input`);
      await sleep(150);
      await page.keyboard.type('Penn Cambria');
      await sleep(150);
      await page.keyboard.press('Enter');
      await settled(page);
      const picked = (await stored()).splits.find(s => s.id === blank.id);
      ok('picking its job codes it the way the order is, where that job\'s bid allows', picked && picked.project_id === 'ox'
        && picked.cost_code === 'Erosion and Sediment Control' && picked.sub_code === 'Silt Sock', picked);
      ok('  a job already on the order is not offered for it',
        !(await page.evaluate(id => cbOptionsFor('po_split_projects:po385|' + id).map(o => o.value), blank.id)).some(v => ['hb', 'hs', 'hss', 'hf'].includes(v)));
      await page.evaluate(id => removePOSplit('po385', id), blank.id);
      await settled(page);
      ok('  and an empty job comes off the order again', (await stored()).splits.length === before);
    }

    ok('(the page ran with no errors)', errors.length === 0, errors);
    if (proc) { /* Procurement's own matching has its own test (test-procurement-frontend.js). */ }

    console.log('\n[central purchasing: the same order on purchase-orders.html]');
    {
      const codesOf = id => PROJECTS[id].bidItems.map(b => ({ cost_code: b.cost_code, sub_code: b.sub_code, description: b.description || '' }));
      const CATALOG = {
        divisions: [{ division: 'turf', label: 'Turf Management', projects: IDS.map(id => ({
          id, name: PROJECTS[id]['project-name'], jobNumber: PROJECTS[id]['job-number'], codes: codesOf(id), done: false,
          ...(PROJECTS[id].site ? { site: PROJECTS[id].site } : {}),
        })) }],
        vendors: [{ name: 'Frank Roberts' }], employees: [{ name: 'Sam' }], truncated: [],
      };
      const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      const cp = await ctx2.newPage();
      const cErrors = [];
      cp.on('pageerror', e => cErrors.push(e.message));
      cp.on('dialog', d => d.accept().catch(() => {}));
      await cp.addInitScript(() => {
        localStorage.setItem('fct_token', 'x.y.z');
        localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'posplitb', name: 'Ada', companyCode: 'POSPLITB',
          divisionRoles: { turf: 'admin' }, allowedDivisions: ['turf'] }));
        localStorage.setItem('fct_division', 'purchase_orders');
      });
      await cp.route('**/api/**', async route => {
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
        if (p === '/api/documents') return send(200, m === 'GET' ? { counts: {}, documents: [] } : {});
        return send(200, {});
      });
      await cp.goto((await BASE) + '/purchase-orders.html');
      await until(() => cp.evaluate(() => typeof purchaseOrders !== 'undefined' && purchaseOrders.some(p => p.id === 'po385')));
      await cp.evaluate(() => toggleLines('po385'));
      await sleep(250);
      const panel = await cp.$eval('.lines-wrap .jobs-panel', el => el.textContent.replace(/\s+/g, ' ')).catch(() => '');
      ok('the order\'s jobs are listed with their shares', /Jobs on this PO/.test(panel) && /Hempfield Football/.test(panel)
        && /Hempfield Softball/.test(panel) && /Hempfield Soccer/.test(panel), panel);
      const cHead = await cp.$$eval('.lines-wrap table', ts => ts.map(t => [...t.querySelectorAll('thead th')].map(h => h.textContent.trim())));
      ok('its deliveries table has a Job column', cHead.some(h => h[0] === 'Job' && h[1] === 'Invoice / Ticket #'), cHead);
      const chip = await cp.$eval('tr.po-head td:nth-child(5)', el => el.textContent.replace(/\s+/g, ' ')).catch(() => '');
      ok('the order says it is split, under its Job', /\+ 3 more jobs · split PO/.test(chip), chip);
      if (shots) {
        const el = await cp.$('.lines-wrap');
        if (el) await el.screenshot({ path: path.join(shots, '4-central-purchasing.png') });
      }

      // Move Baseball's delivery to Soccer from here: the server moves its row.
      po = await stored();
      const own = po.lines.find(l => !l.split);
      const soccerSplit = po.splits.find(s => s.project_id === 'hss');
      const ownRow = own.po_row_id;
      await cp.selectOption(`.lines-wrap select[onchange*="setLineJob('po385','${own.id}'"]`, soccerSplit.id);
      await until(async () => { const x = await stored(); return x && x.lines.find(l => l.id === own.id).split === soccerSplit.id; });
      await sleep(300);
      const rowsNow = await rowsFor();
      po = await stored();
      const movedOwn = po.lines.find(l => l.id === own.id);
      ok('a delivery moved to another job here lands there', movedOwn.split === soccerSplit.id
        && rowsNow.some(r => r.row_id === movedOwn.po_row_id && r.project_id === 'hss' && r.sub_code === 'Silt Sock 18in'), rowsNow);
      ok('  and its row on the old job is gone', !rowsNow.some(r => r.row_id === ownRow), rowsNow);
      ok('(the purchasing page ran with no errors)', cErrors.length === 0, cErrors);
      await ctx2.close();
    }
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
