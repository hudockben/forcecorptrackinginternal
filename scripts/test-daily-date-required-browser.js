#!/usr/bin/env node
'use strict';
/**
 * A daily entry's date can't be cleared, in a real browser.
 *
 * Run: node scripts/test-daily-date-required-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *
 * The daily_tracking table requires a date, and the server saves a blank one
 * as the day it was saved (api/daily-rows.js, dateOrToday). Clearing a date in
 * Daily Tracking therefore looked like it worked: the cell showed blank, the
 * save went through, and the next reload brought the row back dated today.
 * The office did this to jobs they had imported, hoping to move them out of
 * this year, and moved every row to today instead. A cleared date is now not
 * taken: nothing is sent, the cell gets the row's date back, and the save
 * indicator says why. A real date still saves as before.
 *
 * Run against Turf and Paving, which carry the same handlers.
 *
 * Harness traps (see test-haul-browser.js): served over HTTP, not file://, and
 * fct_division must match the page or it bounces to divisions.html.
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

const PAGES = [
  { file: 'tracker.html', division: 'turf',   lists: 'fct_lists',
    index: 'fct_projects_index',        project: 'fct_project_' },
  { file: 'paving.html',  division: 'paving', lists: 'fct_paving_lists',
    index: 'fct_paving_projects_index', project: 'fct_paving_project_' },
];
const ROWS = [
  { id: 'r1', _projectId: 'p1', date: '2026-03-15', employee: 'Al', cost_code: '100', sub_code: 'Grade',
    labor_hours: '8', rate: '30', quantity: '100' },
  { id: 'r2', _projectId: 'p1', date: '2026-03-16', employee: 'Bo', cost_code: '100', sub_code: 'Grade',
    labor_hours: '8', rate: '30', quantity: '100' },
];

async function run(browser, cfg) {
  console.log(`\n${cfg.file}`);
  const page = await browser.newPage({ viewport: { width: 1474, height: 889 } });
  const errors = [];
  const sent = [];   // the rows each daily-row write carried
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.addInitScript(division => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'hudockben', role: 'admin',
      companyCode: 'FCT', isPlatformAdmin: true, allowedDivisions: ['turf', 'paving', 'kiewit'] }));
    localStorage.setItem('fct_division', division);
  }, cfg.division);
  await page.route('**/api/**', route => {
    const req = route.request();
    const u   = new URL(req.url());
    const p   = u.pathname;
    const m   = req.method();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/daily-rows') {
      if (m === 'GET') return json({ rows: ROWS.map(r => ({ ...r })), hasMore: false });
      const body = JSON.parse(req.postData() || '{}');
      [].concat(body.row || [], body.rows || []).forEach(r => sent.push({ method: m, id: r.id, date: r.date }));
      return json({ ok: true });
    }
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      const values = {};
      if (keys.includes(cfg.project + 'p1')) {
        values[cfg.project + 'p1'] = { id: 'p1', 'project-name': 'Test Job', 'job-number': '1',
          status: 'In Progress', bidItems: [] };
      }
      if (keys.includes(cfg.lists)) values[cfg.lists] = { equipment: [], employees: [], suppliers: [] };
      return json({ values });
    }
    if (p === '/api/data/' + cfg.index) return json({ value: ['p1'] });
    if (p.startsWith('/api/data/')) return json({ value: null });
    return json({});
  });

  await page.goto((await BASE) + '/' + cfg.file);
  await page.waitForFunction(() => typeof projectsList !== 'undefined' && projectsList.length === 1
    && (projectsList[0].dailyRows || []).length === 2, null, { timeout: 20000 });
  await page.evaluate(() => openDailyView('p1'));
  const at   = await page.evaluate(() => getProj('p1').dailyRows.findIndex(r => r.id === 'r1'));
  const cell = page.locator(`#daily-tbody-p1 input[data-f="date"][data-i="${at}"]`);
  await cell.waitFor();
  const rowDate = () => page.evaluate(i => getProj('p1').dailyRows[i].date, at);
  const said    = () => page.evaluate(() => (document.querySelector('#dr-save-indicator .si-label') || {}).textContent || '');

  // Clear it, as the office did, and leave the cell.
  await cell.fill('');
  await cell.press('Tab');
  await page.waitForTimeout(1200);   // past the 800 ms save debounce
  ok('a cleared date is not sent to the server', !sent.some(x => x.id === 'r1'), JSON.stringify(sent));
  ok('  the row keeps its date', (await rowDate()) === '2026-03-15', await rowDate());
  ok('  the cell shows it again', (await cell.inputValue()) === '2026-03-15', await cell.inputValue());
  ok('  and the save indicator says why', /can't be blank/.test(await said()), await said());

  // A real date still saves.
  await cell.fill('2025-06-01');
  await cell.press('Tab');
  await page.waitForTimeout(1200);
  ok('a real date still saves', sent.some(x => x.id === 'r1' && x.date === '2025-06-01'), JSON.stringify(sent));
  ok('  and only real dates were ever sent', sent.filter(x => x.id === 'r1').every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date)));
  ok('  the row carries it', (await rowDate()) === '2025-06-01', await rowDate());

  ok('no page errors', !errors.length, errors.join(' | '));
  await page.close();
}

(async () => {
  const browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME } : {});
  try {
    for (const cfg of PAGES) await run(browser, cfg);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
