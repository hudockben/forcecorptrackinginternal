#!/usr/bin/env node
'use strict';
/**
 * The row ✕ on Daily Tracking and Purchase Orders, in a real browser.
 *
 * Run: node scripts/test-row-delete-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *
 * One document-level handler answers every row ✕ that carries a data-tab:
 * it opens the "Are you sure?" popover and deletes on Yes. Three things were
 * wrong with it, none of which a sandboxed unit test can see:
 *
 *   - It kept an "already open" flag on the button that nothing cleared when
 *     the popover closed any other way — a click elsewhere, or another row's
 *     ✕ — so that ✕ went dead until the table was redrawn.
 *   - Yes deleted p.dailyRows[i], with i read when the ✕ was clicked. Coming
 *     back to the window reloads the open job's rows in the server's order
 *     (date, then entry time), so a row someone else added in between moved
 *     the target, and Yes deleted THEIR row — on the server — instead.
 *   - It also answered the ✕ buttons that run their own delete (suppliers,
 *     CRM rows, change orders), adding a second "Are you sure?" whose Yes did
 *     nothing.
 *
 * Run against all three division pages, which carry the same handler.
 *
 * Harness traps (see test-haul-browser.js): served over HTTP, not file://, and
 * fct_division must match the page or it bounces to divisions.html. The popover
 * opens over the next row's ✕, so a click meant for that ✕ is dispatched to it
 * directly rather than through the mouse.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright not installed — skipping browser checks'); process.exit(0); }
const path = require('path');
const http = require('http');
const fs   = require('fs');
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

const dailyRow = (id, date, employee) => ({ id, _projectId: 'p1', date, employee,
  cost_code: '100', sub_code: 'Grade', labor_hours: '8', rate: '30', quantity: '100' });
// X is someone else's row, entered after B on B's date: the server returns it
// between B and C, which is exactly what moves C.
const A = dailyRow('rA', '2026-09-01', 'Al');
const B = dailyRow('rB', '2026-09-02', 'Bo');
const C = dailyRow('rC', '2026-09-03', 'Cy');
const X = dailyRow('rX', '2026-09-02', 'Xi');
const PO = id => ({ id, po_num: 'PO-' + id, title: 'PO ' + id, supplier: 'Acme Stone',
  project_id: '', status: 'Open', lines: [] });

async function run(browser, cfg) {
  console.log(`\n${cfg.file}`);
  let serverRows = [A, B, C];
  const deleted = [];
  const LISTS = { equipment: [], employees: [], suppliers: [{ name: 'Acme Stone' }, { name: 'Bolt Supply' }] };

  const page = await browser.newPage({ viewport: { width: 1474, height: 889 } });
  const errors = [];
  const dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  // A ✕ with its own confirm is dismissed, so nothing is deleted by it.
  page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
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
      if (m === 'DELETE') { deleted.push(u.searchParams.get('id')); return json({ ok: true }); }
      if (m === 'GET') return json({ rows: serverRows.map(r => ({ ...r })), hasMore: false });
      return json({ ok: true });
    }
    if (p === '/api/purchase-orders') {
      return m === 'GET' ? json({ purchaseOrders: [PO('a'), PO('b')] }) : json({ ok: true });
    }
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      const values = {};
      if (keys.includes(cfg.project + 'p1')) {
        values[cfg.project + 'p1'] = { id: 'p1', 'project-name': 'Test Job', 'job-number': '1',
          bidItems: [], status: 'In Progress' };
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
    && (projectsList[0].dailyRows || []).length === 3, null, { timeout: 20000 });
  await sleep(300);

  const popovers = () => page.locator('.del-confirm').count();
  const ids      = () => page.evaluate(() => getProj('p1').dailyRows.map(r => r.id));
  const xDaily   = async id => page.locator(`.del-btn[data-tab="daily"][data-i="${(await ids()).indexOf(id)}"]`);
  const away     = () => page.mouse.click(700, 120);   // the page, not a ✕ or the popover
  const no       = async () => { if (await popovers()) await page.click('.del-confirm .dc-no'); await sleep(100); };

  await page.evaluate(() => openDailyView('p1'));
  await sleep(300);

  // ── The ✕ stays live ────────────────────────────────────────────────────
  await (await xDaily('rA')).click(); await sleep(100);
  ok('daily ✕ opens the confirm', await popovers() === 1);
  await away(); await sleep(100);
  ok('a click elsewhere closes it', await popovers() === 0);
  await (await xDaily('rA')).click(); await sleep(100);
  ok('…and the same ✕ opens it again', await popovers() === 1, `${await popovers()} open`);
  await no();

  await (await xDaily('rA')).dblclick(); await sleep(100);
  ok('a double-click on ✕ leaves the confirm open', await popovers() === 1, `${await popovers()} open`);
  await no();

  await (await xDaily('rB')).click(); await sleep(100);
  await (await xDaily('rC')).dispatchEvent('click'); await sleep(100);
  ok('another row\'s ✕ moves the confirm to that row', await popovers() === 1);
  await no();
  await (await xDaily('rB')).click(); await sleep(100);
  ok('…and the first ✕ still opens it afterwards', await popovers() === 1, `${await popovers()} open`);
  await no();
  ok('No deletes nothing', deleted.length === 0 && (await ids()).join() === 'rA,rB,rC', deleted.join());

  // ── Yes deletes the row the ✕ was on ────────────────────────────────────
  await (await xDaily('rC')).click(); await sleep(100);
  serverRows = [A, B, X, C];
  await page.evaluate(() => reloadDailyRows('p1'));   // what coming back to the window does
  await sleep(300);
  ok('a reload while the confirm is open puts a row ahead of it', (await ids()).join() === 'rA,rB,rX,rC',
    (await ids()).join());
  if (await popovers()) await page.click('.del-confirm .dc-yes');
  await sleep(300);
  ok('Yes deletes that row on the server, not the one now in its place',
    deleted.join() === 'rC', `DELETE sent for ${deleted.join() || 'nothing'}`);
  ok('…and on the page', (await ids()).join() === 'rA,rB,rX', (await ids()).join());
  serverRows = [A, B, X];

  await (await xDaily('rB')).click(); await sleep(100);
  serverRows = [A, X];                                // gone already, removed elsewhere
  await page.evaluate(() => reloadDailyRows('p1'));
  await sleep(300);
  if (await popovers()) await page.click('.del-confirm .dc-yes');
  await sleep(300);
  ok('a row gone before Yes deletes nothing in its place', deleted.join() === 'rC',
    `DELETE sent for ${deleted.join()}`);
  ok('…and the rest stay', (await ids()).join() === 'rA,rX', (await ids()).join());

  await (await xDaily('rA')).click(); await sleep(100);
  if (await popovers()) await page.click('.del-confirm .dc-yes');
  await sleep(300);
  ok('an ordinary Yes still deletes', deleted.join() === 'rC,rA' && (await ids()).join() === 'rX',
    `DELETE sent for ${deleted.join()}; left ${(await ids()).join()}`);

  // ── Purchase Orders ─────────────────────────────────────────────────────
  await page.evaluate(() => closeDailyView());
  await page.click('.tab-btn[data-tab="po"]');
  await sleep(400);
  const poX = page.locator('.del-btn[data-tab="po"][data-po-id="a"]');
  await poX.click(); await sleep(100);
  ok('PO ✕ opens the confirm', await popovers() === 1);
  await away(); await sleep(100);
  await poX.click(); await sleep(100);
  ok('…and opens it again after a click elsewhere', await popovers() === 1, `${await popovers()} open`);
  if (await popovers()) await page.click('.del-confirm .dc-yes');
  await sleep(300);
  ok('Yes deletes that PO', JSON.stringify(await page.evaluate(() => purchaseOrders.map(p => p.id))) === '["b"]',
    JSON.stringify(await page.evaluate(() => purchaseOrders.map(p => p.id))));

  // ── A ✕ that runs its own delete ────────────────────────────────────────
  await page.evaluate(() => adminSwitchTab('supplier'));
  await sleep(400);
  const supX = page.locator('#supplier-root .del-btn').first();
  await supX.click(); await sleep(150);
  ok('supplier ✕ asks once, with its own confirm', dialogs.length === 1, dialogs.join(' | '));
  ok('…and no second "Are you sure?" beside it', await popovers() === 0, `${await popovers()} open`);
  ok('…which was dismissed, so the supplier stays',
    (await page.evaluate(() => lists.suppliers.length)) === 2);

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
