#!/usr/bin/env node
'use strict';
/**
 * Quarry ▸ Sales, Daily and Crushing Tracking — re-dating a row on the
 * keyboard, in a real browser.
 *
 * Run: node scripts/test-quarry-tracking-redate-browser.js
 *
 * A re-dated row re-renders its table, so a row typed out of the Year filter
 * leaves it and one typed to another day moves to its place. Chrome fires
 * `change` on a date box at every keystroke — typing 2025 into the year goes
 * 0002, 0020, 0202, 2025 (see test-time-off-range-browser.js) — so a
 * re-render on change took the box away at the first digit: with Year = 2026
 * the row left the table at "0002", focus fell to the page, the rest of the
 * date went nowhere, and 0002 is the date it kept. Crushing did exactly that.
 * The re-render now waits for the date box to lose focus, then puts focus
 * back where it went, after any click in progress has landed.
 *
 * Checked per tab, with real keystrokes and real clicks:
 *   - a date typed digit by digit keeps its box (no re-render mid-date),
 *     including an edit whose first key finishes a segment — Chrome sends
 *     that change while focus is between segments, reading as <body>
 *   - Tab out: a row dated out of the Year filter leaves the table, and the
 *     Rows count, the Delete count and ⇩ Download follow; a row re-dated
 *     inside it moves to its date's place and focus is in its next cell
 *   - the first click after a date — another row's ✕, another row's number
 *     cell — does what it was aimed at
 * and on Sales, a customer picked outside the Customer filter takes the row
 * off the table with the combobox closed; inside it, Tab still moves on.
 *
 * Needs playwright; skips cleanly without it, like test-haul-browser.js.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright not installed — skipping browser checks'); process.exit(0); }
const path = require('path');
const http = require('http');
const fs   = require('fs');
const ROOT = path.resolve(__dirname, '..');

// Served over HTTP: from file:// the page cannot reach /api/ at all.
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
const ok = (l, c, d) => { if (c) { passed++; console.log('  ✓ ' + l); } else { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + d : '')); } };
const eq = (l, a, b) => ok(l, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// Three rows a tab, all 2026 at one pit, newest first: A, B, C.
const LISTS = {
  location:  [{ id: 'l1', name: 'Homer City' }],
  product:   [{ id: 'p1', name: '2B' }],
  customer:  [{ id: 'c1', name: 'Acme' }, { id: 'c2', name: 'Beta' }],
  employees: [{ id: 'e1', name: 'Al' }],
  equipment: [{ id: 'q1', name: 'Loader' }],
  tasks:     [{ id: 't1', name: 'Loading' }],
};
const sale  = (id, date, customerName) => ({ id, date, locationName: 'Homer City', customerName, productName: '2B', tons: 5, pricePerTon: 10 });
const daily = (id, date) => ({ id, date, locationName: 'Homer City', employeeName: 'Al', hours: 8, rate: 20 });
const crush = (id, date) => ({ id, date, locationName: 'Homer City', employeeName: 'Al', hours: 8, hourlyRate: 20, loadsToCrusher: 2, tonsPerLoad: 25 });
const BLOBS = () => ({
  fct_quarry_lists: LISTS,
  fct_quarry_sales:    [sale('A', '2026-03-15', 'Acme'), sale('B', '2026-03-10', 'Acme'), sale('C', '2026-03-05', 'Beta')],
  fct_quarry_daily:    [daily('A', '2026-03-15'), daily('B', '2026-03-10'), daily('C', '2026-03-05')],
  fct_quarry_crushing: [crush('A', '2026-03-15'), crush('B', '2026-03-10'), crush('C', '2026-03-05')],
});

// Hours / Tons sit in the sixth column on all three.
const TABS = [
  { tab: 'sales',    tbody: 'salesTbody', rows: 'salesRows', summary: 'salesSummary', numCell: 5, del: 'salesDeleteFilteredBtn' },
  { tab: 'daily',    tbody: 'dailyTbody', rows: 'dailyRows', summary: 'dailySummary', numCell: 5, del: 'dailyDeleteFilteredBtn' },
  { tab: 'crushing', tbody: 'crushTbody', rows: 'crushRows', summary: 'crushSummary', numCell: 5, del: 'crushingDeleteFilteredBtn' },
];

async function boot(browser, tab) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify({ userId: 1, username: 'tester', companyCode: 'TEST', companyName: 'Test Co' }));
    localStorage.setItem('fct_division', 'quarry');
  });
  const blobs = BLOBS();
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url());
    const m = /\/api\/data\/([^?]+)/.exec(u.pathname);
    const key = m ? decodeURIComponent(m[1]) : '';
    if (m && route.request().method() === 'GET') {
      return route.fulfill({ json: { value: Object.prototype.hasOwnProperty.call(blobs, key) ? blobs[key] : null } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto((await BASE) + '/quarry.html');
  await page.evaluate(t => switchTab(t), tab);
  await page.waitForFunction(() => salesLoaded && crushLoaded && dailyLoaded);
  // Opening a tab also re-reads the lists and re-renders when they land; let
  // that happen before typing, or it redraws the table under a keystroke.
  await page.waitForTimeout(300);
  await page.evaluate(t => setYearFilter(t, '2026'), tab);
  return { page, errors };
}

// The table's entry rows, top to bottom, as row ids.
const shownIds = (page, c) => page.evaluate(({ tbody, rows }) =>
  [...document.querySelectorAll(`#${tbody} tr[data-row]`)].map(tr => window.eval(rows)[Number(tr.dataset.row)].id), c);
const dateBox = (page, c, id) => page.evaluateHandle(({ tbody, rows, id }) => {
  const i = window.eval(rows).findIndex(r => r.id === id);
  const tr = document.querySelector(`#${tbody} tr[data-row="${i}"]`);
  return tr && tr.querySelector('input[type=date]');
}, { ...c, id });

// Type a whole date into a row's date box one key at a time — MMDDYYYY, the
// box moving segment to segment as a person's would. Watches the box after
// every key: it has to be the same element, still in the page, still focused.
async function typeDate(page, c, id, digits) {
  const box = await dateBox(page, c, id);
  await box.evaluate(e => e.focus());
  let kept = true;
  for (const ch of digits) {
    await page.keyboard.type(ch);
    if (!(await box.evaluate(e => e.isConnected && document.activeElement === e))) kept = false;
  }
  return { box, kept, value: await box.evaluate(e => e.value) };
}

// Tab until focus leaves the date box. Chromium's date control takes one Tab
// after a typed year before focus moves on to the next cell — its own
// behaviour, the same on a bare page.
async function tabOut(page, box) {
  for (let n = 0; n < 4 && await box.evaluate(e => document.activeElement === e); n++) await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
}

// A click at a person's speed: the button held down for a moment, which is
// long enough for anything the press sets off to run before it is released.
// page.click() presses and releases in one go and would walk past that.
async function press(page, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const b = await page.locator(selector).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(100);
}

const summaryRows = (page, c) => page.$eval('#' + c.summary, el => Number((/Rows\s*(\d+)/.exec(el.textContent) || [])[1]));
const delCount = (page, c) => page.$eval('#' + c.del, el => Number((/Delete (\d+)/.exec(el.textContent) || [])[1]));
const stored = (page, c) => page.evaluate(rows => Object.fromEntries(window.eval(rows).map(r => [r.id, r.date])), c.rows);
const shownForExport = (page, c) => page.evaluate(tab => exportTabCfg(tab).shown.map(e => e.row.id), c.tab);
const focusAt = page => page.evaluate(() => {
  const e = document.activeElement, tr = e && e.closest('tr[data-row]'), td = e && e.closest('td');
  return tr ? { row: Number(tr.dataset.row), cell: td.cellIndex } : e.tagName;
});

(async () => {
  const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME } : {});

  for (const c of TABS) {
    console.log(`\n[${c.tab}: a row typed out of the Year filter]`);
    {
      const { page, errors } = await boot(browser, c.tab);
      eq('starts with A, B, C, newest first', await shownIds(page, c), ['A', 'B', 'C']);
      const t = await typeDate(page, c, 'A', '03012025');
      ok('the date box keeps focus through every keystroke — no re-render mid-date', t.kept);
      eq('  and takes the whole date', t.value, '2025-03-01');
      eq('  while it is still focused the row is still on screen', await shownIds(page, c), ['A', 'B', 'C']);
      await tabOut(page, t.box);
      eq('Tab out: the row leaves the 2026 table', await shownIds(page, c), ['B', 'C']);
      eq('  saved as typed — not 0002', (await stored(page, c)).A, '2025-03-01');
      eq('  Rows counts what is on screen', await summaryRows(page, c), 2);
      eq('  the Delete button counts the same', await delCount(page, c), 2);
      eq('  ⇩ Download hands over the same rows', await shownForExport(page, c), ['B', 'C']);
      eq('no page errors', errors, []);
      await page.close();
    }

    console.log(`\n[${c.tab}: a row re-dated inside the filter]`);
    {
      const { page, errors } = await boot(browser, c.tab);
      const i = await page.evaluate(rows => window.eval(rows).findIndex(r => r.id === 'A'), c.rows);
      const t = await typeDate(page, c, 'A', '03012026');
      eq('  still on screen at its old place while the box is focused', await shownIds(page, c), ['A', 'B', 'C']);
      await tabOut(page, t.box);
      eq('Tab out: it moves to its date\'s place', await shownIds(page, c), ['B', 'C', 'A']);
      eq('  and focus is in the cell Tab went to, in that row', await focusAt(page), { row: i, cell: 1 });
      eq('no page errors', errors, []);
      await page.close();
    }

    console.log(`\n[${c.tab}: an edit whose first key finishes a segment]`);
    {
      // "4" in the month can only be April, so Chrome moves straight on to
      // the day — and dispatches that change mid-move, with focus reading as
      // <body>. It is the edit's first change, so nothing is waiting yet.
      const { page, errors } = await boot(browser, c.tab);
      const t = await typeDate(page, c, 'B', '4');
      ok('the date box keeps focus', t.kept);
      eq('  and takes the month', t.value, '2026-04-10');
      eq('  the table holds still until it is left', await shownIds(page, c), ['A', 'B', 'C']);
      await tabOut(page, t.box);
      eq('Tab out: it moves to its date\'s place', await shownIds(page, c), ['B', 'A', 'C']);
      eq('no page errors', errors, []);
      await page.close();
    }

    console.log(`\n[${c.tab}: the first click after a date]`);
    {
      const { page, errors } = await boot(browser, c.tab);
      await typeDate(page, c, 'A', '03012026');           // A moves below C once the table redraws
      const bi = await page.evaluate(rows => window.eval(rows).findIndex(r => r.id === 'B'), c.rows);
      await press(page, `#${c.tbody} tr[data-row="${bi}"] .row-del-btn`);
      eq('another row\'s ✕ deletes that row, on the first click', Object.keys(await stored(page, c)).sort(), ['A', 'C']);
      eq('  and the re-dated row is where its date puts it', await shownIds(page, c), ['C', 'A']);
      eq('no page errors', errors, []);
      await page.close();
    }
    {
      const { page, errors } = await boot(browser, c.tab);
      await typeDate(page, c, 'A', '03012026');
      const ci = await page.evaluate(rows => window.eval(rows).findIndex(r => r.id === 'C'), c.rows);
      await press(page, `#${c.tbody} tr[data-row="${ci}"] td:nth-child(${c.numCell + 1}) input`);
      eq('a click in another row\'s number cell leaves focus there after the redraw', await focusAt(page), { row: ci, cell: c.numCell });
      await page.keyboard.press('Control+A');
      await page.keyboard.type('7');
      const field = c.tab === 'sales' ? 'tons' : 'hours';
      eq('  so typing goes into that row', await page.evaluate(({ rows, f }) => window.eval(rows).find(r => r.id === 'C')[f], { rows: c.rows, f: field }), 7);
      eq('no page errors', errors, []);
      await page.close();
    }
  }

  console.log('\n[sales: a customer picked outside the Customer filter]');
  {
    const { page, errors } = await boot(browser, 'sales');
    const c = TABS[0];
    await page.evaluate(() => { msSet('customer', 'sales').add('Acme'); msApply('sales', 'customer'); });
    eq('Customer = Acme shows A and B', await shownIds(page, c), ['A', 'B']);
    const ai = await page.evaluate(() => salesRows.findIndex(r => r.id === 'A'));
    const cb = `#salesTbody tr[data-row="${ai}"] .cb[data-field="customer"] input`;
    await page.click(cb);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Beta');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    eq('picking Beta takes A off the table', await shownIds(page, c), ['B']);
    eq('  Rows and Delete count agree', [await summaryRows(page, c), await delCount(page, c)], [1, 1]);
    eq('  no combobox menu left open', await page.$$eval('.cb-menu:not([hidden])', m => m.length), 0);
    eq('  the Customer filter is still Acme', await page.evaluate(() => [...msSet('customer', 'sales')]), ['Acme']);
    eq('  saved', await page.evaluate(() => salesRows.find(r => r.id === 'A').customerName), 'Beta');
    eq('no page errors', errors, []);
    await page.close();
  }
  {
    const { page, errors } = await boot(browser, 'sales');
    const c = TABS[0];
    const ai = await page.evaluate(() => salesRows.findIndex(r => r.id === 'A'));
    const tr = await page.$(`#salesTbody tr[data-row="${ai}"]`);
    await page.click(`#salesTbody tr[data-row="${ai}"] .cb[data-field="customer"] input`);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Beta');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    ok('with no Customer filter, a pick does not redraw the table', await tr.evaluate(e => e.isConnected));
    eq('  and Tab moves on to Product', await focusAt(page), { row: ai, cell: 4 });
    eq('  saved', await page.evaluate(() => salesRows.find(r => r.id === 'A').customerName), 'Beta');
    eq('no page errors', errors, []);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
