#!/usr/bin/env node
'use strict';
/**
 * Deleting on the Purchase Orders tab, in a real browser, against the REAL
 * /api/purchase-orders and /api/daily-rows handlers on a real Postgres —
 * tracker.html, paving.html and kiewit-pinetree.html.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-po-delete-race-browser.js
 *      (PW_CHROMIUM=/path/to/chrome to point it at a different Chromium)
 *
 * A delivery raised on an order has a cost row on the job. Removing that row
 * also updates the stored order list (the delivery on it is detached), so
 * when the page removed the row alongside the save of the list, the row could
 * land first: the save then read as one from a copy that was behind, and the
 * server merged the deleted delivery — or the whole deleted order — back.
 * It came back on the next refresh, now with no cost on the job. Checked:
 *
 *  - a delivery with a cost row, deleted while its save is held back: gone
 *    from the order, its cost row gone, and it stays gone
 *  - the same for a whole order with cost rows
 *  - an edit's save still out when a delete is made: the delete still sticks
 *  - a delete from a page whose copy really is behind (someone else saved):
 *    the server keeps the delivery, and so does the page — back on the list,
 *    its cost row kept, the user told; deleted again, it goes
 *  - a delete whose save fails: put back, its cost row kept
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

process.env.JWT_SECRET = 'po-delete-race-secret';
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
  '/api/purchase-orders': require(path.join(ROOT, 'api/purchase-orders.js')),
  '/api/daily-rows':      require(path.join(ROOT, 'api/daily-rows.js')),
};

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + String(d).slice(0, 600) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = (t, v = []) => pool.query(t, v).then(r => r.rows);

const CO = 'PODELRACE';
const PAGES = [
  { file: 'tracker.html',         division: 'turf',   lists: 'fct_lists',        index: 'fct_projects_index',        project: 'fct_project_' },
  { file: 'paving.html',          division: 'paving', lists: 'fct_paving_lists', index: 'fct_paving_projects_index', project: 'fct_paving_project_' },
  { file: 'kiewit-pinetree.html', division: 'kiewit', lists: 'fct_kiewit_lists', index: 'fct_kiewit_projects_index', project: 'fct_kiewit_project_' },
];

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
  await q("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'PO delete race', '{turf,paving,kiewit}')", [CO]);
  const roles = { turf: 'admin', paving: 'admin', kiewit: 'admin' };
  const id = (await q("INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ('podel_admin', $1, 'x', 'admin', $2) RETURNING id",
    [CO, JSON.stringify(roles)]))[0].id;
  TOKEN = jwt.sign({ userId: id, username: 'podel_admin', name: 'Ada', companyCode: CO, role: 'admin', divisionRoles: roles }, process.env.JWT_SECRET);
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

// Two orders on job p1; PO-0009 has two deliveries, each with its cost row.
async function seed(cfg) {
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
    [poSync.blobKeyFor(CO, cfg.division), JSON.stringify(list)]);
  for (const [row, sup, qty, po, cc, sc] of [['dr71', 'LB Water', 5, 'PO-0007', '02-100', '0420'],
    ['dr91', 'Acme Supply', 3, 'PO-0009', '03-200', '0610'], ['dr92', 'Acme Supply', 4, 'PO-0009', '03-200', '0610']]) {
    await q(`INSERT INTO daily_tracking (row_id, company_code, division, project_id, date, field_type, cost_code, sub_code, material, supplier, po_num, units_purchased, unit_cost, material_cost, quantity)
             VALUES ($1, $2, $3, 'p1', $4, 'Material', $5, $6, 'stone', $7, $8, $9, 10, $10, $9)`,
      [row, CO, cfg.division, d, cc, sc, sup, po, qty, qty * 10]);
  }
}
const storedPOs = async cfg => {
  const r = await callApi('GET', `/api/purchase-orders?division=${cfg.division}`);
  return { list: r.body.purchaseOrders || [], updatedAt: r.body.updatedAt };
};
const shape = list => list.map(p => `${p.po_number}[${(p.lines || []).map(l => l.id).join(',')}]`).join(' ');
const costRows = async cfg => (await q('SELECT row_id FROM daily_tracking WHERE company_code = $1 AND division = $2 ORDER BY row_id', [CO, cfg.division])).map(r => r.row_id);

async function openPage(browser, cfg, W) {
  const ctx = await browser.newContext({ viewport: { width: 1474, height: 889 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.addInitScript(({ division }) => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'podel_admin', name: 'Ada', role: 'admin', companyCode: 'PODELRACE',
      divisionRoles: { turf: 'admin', paving: 'admin', kiewit: 'admin' }, allowedDivisions: ['turf', 'paving', 'kiewit'] }));
    localStorage.setItem('fct_division', division);
  }, { division: cfg.division });
  const LISTS = { equipment: [], employees: [{ name: 'Sam' }], suppliers: [{ name: 'Acme Supply' }, { name: 'LB Water' }] };
  const PROJECT = { id: 'p1', 'project-name': 'Main St', 'job-number': '1', status: 'In Progress',
    bidItems: [{ id: 'b1', cost_code: '02-100', sub_code: '0420' }, { id: 'b2', cost_code: '03-200', sub_code: '0610' }] };
  await page.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    const send = (status, b) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) }).catch(() => {});
    if (HANDLERS[p]) {
      if (p === '/api/purchase-orders' && m === 'PUT') {
        if (W.failPut) { W.failPut--; W.log.push({ api: 'po', method: m, status: 500, body }); return send(500, { error: 'Could not save the purchase order. Try again.' }); }
        if (W.holdPut) { const ms = W.holdPut; W.holdPut = 0; await sleep(ms); }
      }
      const r = await callApi(m, u.pathname + u.search, body);
      if (m !== 'GET') W.log.push({ api: p === '/api/daily-rows' ? 'dr' : 'po', method: m, q: Object.fromEntries(u.searchParams), body, status: r.statusCode, resp: r.body, at: Date.now() });
      return send(r.statusCode, r.body);
    }
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      const values = {};
      if (keys.includes(cfg.project + 'p1')) values[cfg.project + 'p1'] = PROJECT;
      if (keys.includes(cfg.lists)) values[cfg.lists] = LISTS;
      return send(200, { values });
    }
    if (p === '/api/data/' + cfg.index) return send(200, { value: ['p1'] });
    if (p === '/api/data/' + cfg.lists && m === 'GET') return send(200, { value: LISTS });
    if (p === '/api/data/' + cfg.project + 'p1' && m === 'GET') return send(200, { value: PROJECT });
    if (p.startsWith('/api/data/')) return send(200, { value: null });
    return send(200, {});
  });
  await page.goto((await BASE) + '/' + cfg.file);
  await page.waitForFunction(() => typeof projectsList !== 'undefined' && projectsList.length === 1
    && (projectsList[0].dailyRows || []).length === 3 && _poLoadOk && purchaseOrders.length === 2, null, { timeout: 25000 });
  await sleep(600);           // the once-per-load catch-up, answered
  await page.click('.tab-btn[data-tab="po"]');
  await sleep(300);
  return { ctx, page, errors };
}
const pageShape = page => page.evaluate(() => purchaseOrders.map(p => `${p.po_number}[${(p.lines || []).map(l => l.id).join(',')}]`).join(' '));
const pageRows = page => page.evaluate(() => getProj('p1').dailyRows.map(r => String(r.id)).sort().join());
const banner = page => page.evaluate(() => { const b = document.getElementById('save-error-banner'); return b && b.style.display !== 'none' ? (document.getElementById('save-error-msg') || {}).textContent || '' : ''; });
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(100); }
}

async function run(browser, cfg) {
  console.log(`\n${cfg.file}`);

  // ── 1. A delivery with a cost row, its save held back ─────────────────────
  {
    await seed(cfg);
    const W = { log: [] };
    const { ctx, page, errors } = await openPage(browser, cfg, W);
    W.holdPut = 500;
    await page.evaluate(() => deletePOLine('po9', 'l92'));
    await until(async () => !(await costRows(cfg)).includes('dr92'));
    await sleep(400);
    const put = W.log.find(l => l.api === 'po' && l.method === 'PUT');
    const del = W.log.find(l => l.api === 'dr' && l.method === 'DELETE');
    ok('a delivery deleted while its save is held back: its cost row is removed only after the save is answered',
      put && del && del.at > put.at, JSON.stringify(W.log.map(l => `${l.api} ${l.method} ${l.status}`)));
    ok('  the save is not merged', put && put.resp && put.resp.merged === 0, put && JSON.stringify(put.resp));
    const s = await storedPOs(cfg);
    ok('  the stored order no longer has it', shape(s.list) === 'PO-0007[l71] PO-0009[l91]', shape(s.list));
    ok('  its cost row is gone and the others stay', (await costRows(cfg)).join() === 'dr71,dr91', (await costRows(cfg)).join());
    await page.evaluate(() => (typeof _poReadBack === 'function' ? _poReadBack() : null));
    await sleep(300);
    ok('  and a read of the list does not bring it back', await pageShape(page) === 'PO-0007[l71] PO-0009[l91]', await pageShape(page));
    ok('  no message', (await banner(page)) === '', await banner(page));
    ok('  no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ── 2. A whole order with cost rows, its save held back ───────────────────
  {
    await seed(cfg);
    const W = { log: [] };
    const { ctx, page, errors } = await openPage(browser, cfg, W);
    W.holdPut = 500;
    await page.evaluate(() => deletePO('po9'));
    await until(async () => (await costRows(cfg)).join() === 'dr71');
    await sleep(400);
    const s = await storedPOs(cfg);
    ok('an order deleted while its save is held back stays deleted', shape(s.list) === 'PO-0007[l71]', shape(s.list));
    ok('  its cost rows are gone, the other order\'s stays', (await costRows(cfg)).join() === 'dr71', (await costRows(cfg)).join());
    ok('  and the page holds the list as stored', await pageShape(page) === 'PO-0007[l71]', await pageShape(page));
    ok('  no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ── 3. An edit's save still out when a delete is made ─────────────────────
  {
    await seed(cfg);
    const W = { log: [] };
    const { ctx, page, errors } = await openPage(browser, cfg, W);
    W.holdPut = 500;
    await page.evaluate(() => {
      purchaseOrders.find(p => p.id === 'po7').title = 'Geofabric rolls';
      savePurchaseOrders();
      deletePOLine('po9', 'l92');
    });
    await until(async () => !(await costRows(cfg)).includes('dr92'));
    await sleep(500);
    const puts = W.log.filter(l => l.api === 'po' && l.method === 'PUT');
    const s = await storedPOs(cfg);
    ok('a delete made while an edit\'s save is out: one save at a time, the second from the version the first gave',
      puts.length === 2 && puts[1].body.baseUpdatedAt === new Date(puts[0].resp.updatedAt).toISOString() && puts[1].resp.merged === 0,
      JSON.stringify(puts.map(p => ({ base: p.body.baseUpdatedAt, merged: p.resp && p.resp.merged, at: p.resp && p.resp.updatedAt }))));
    ok('  the edit is stored and the delivery stays deleted',
      shape(s.list) === 'PO-0007[l71] PO-0009[l91]' && s.list[0].title === 'Geofabric rolls', shape(s.list) + ' ' + s.list[0].title);
    ok('  its cost row is gone', (await costRows(cfg)).join() === 'dr71,dr91', (await costRows(cfg)).join());
    ok('  no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ── 4. A copy that really is behind: someone else saved since ─────────────
  {
    await seed(cfg);
    const W = { log: [] };
    const { ctx, page, errors } = await openPage(browser, cfg, W);
    // Another tab raises PO-0005 after this page read the list.
    const other = await storedPOs(cfg);
    const raised = { id: 'po5', po_number: 'PO-0005', title: 'Edging', supplier: 'LB Water', status: 'pending', notes: '',
      date_created: daysAgo(0), project_id: 'p1', cost_code: '', sub_code: '', lines: [] };
    const r = await callApi('PUT', `/api/purchase-orders?division=${cfg.division}`, { purchaseOrders: other.list.concat([raised]), baseUpdatedAt: other.updatedAt });
    if (r.statusCode !== 200) throw new Error('other tab save ' + r.statusCode + ' ' + JSON.stringify(r.body));
    await sleep(50);
    await page.evaluate(() => deletePOLine('po9', 'l92'));
    await until(async () => /was not deleted/.test(await banner(page)));
    await sleep(800);
    let s = await storedPOs(cfg);
    ok('a delete from a copy that is behind: the server keeps the delivery', shape(s.list).includes('PO-0009[l91,l92]'), shape(s.list));
    ok('  and its cost row is kept', (await costRows(cfg)).includes('dr92'), (await costRows(cfg)).join());
    ok('  the page puts it back too, and reads the list again (the order raised elsewhere shows)',
      (await pageShape(page)).includes('PO-0009[l91,l92]') && (await pageShape(page)).includes('PO-0005[]'), await pageShape(page));
    ok('  the job\'s cost row is back on the page', (await pageRows(page)) === 'dr71,dr91,dr92', await pageRows(page));
    ok('  the user is told it was not deleted', /PO-0009: the delivery was not deleted/.test(await banner(page)) && !/kept locally/.test(await banner(page)), await banner(page));
    await page.evaluate(() => deletePOLine('po9', 'l92'));
    await until(async () => !(await costRows(cfg)).includes('dr92'));
    await sleep(400);
    s = await storedPOs(cfg);
    ok('  deleted again, it goes — with its cost row', shape(s.list).includes('PO-0009[l91]') && !(await costRows(cfg)).includes('dr92'),
      shape(s.list) + ' / ' + (await costRows(cfg)).join());
    ok('  no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ── 5. A delete whose save fails ──────────────────────────────────────────
  {
    await seed(cfg);
    const W = { log: [] };
    const { ctx, page, errors } = await openPage(browser, cfg, W);
    W.failPut = 1;
    await page.evaluate(() => deletePOLine('po9', 'l92'));
    await until(async () => (await pageShape(page)).includes('PO-0009[l91,l92]'));
    await until(async () => (await pageRows(page)) === 'dr71,dr91,dr92');
    await sleep(300);
    const s = await storedPOs(cfg);
    ok('a delete whose save failed: the delivery is still stored, and back on the page', shape(s.list).includes('PO-0009[l91,l92]')
      && (await pageShape(page)).includes('PO-0009[l91,l92]'), shape(s.list) + ' / ' + await pageShape(page));
    ok('  its cost row is kept, on the server and the page', (await costRows(cfg)).includes('dr92') && (await pageRows(page)) === 'dr71,dr91,dr92',
      (await costRows(cfg)).join() + ' / ' + await pageRows(page));
    ok('  no cost row was deleted', !W.log.some(l => l.api === 'dr' && l.method === 'DELETE'));
    // The page's own failed-save message is a console error, expected here.
    ok('  no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    for (const cfg of PAGES) await run(browser, cfg);
  } catch (err) {
    failed++;
    console.log('  ✗ crashed: ' + (err && err.stack || err));
  } finally {
    await browser.close().catch(() => {});
    server.close();
    await cleanUp().catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
