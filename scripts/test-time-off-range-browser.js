#!/usr/bin/env node
'use strict';
/**
 * The time-off date boxes take a date typed on the keyboard, digit by digit.
 *
 * Run: node scripts/test-time-off-range-browser.js
 *
 * The bug: on Date range, typing 11/12/2026 into the Last day box wiped it.
 * The first digit of the year made the box's value 0002-11-12; the page's
 * input handler answered by setting the box's `min` to the first day; and
 * Chrome rebuilds a date box whose min is assigned — even to the value it
 * already holds — so the next digit landed in an empty box. The month and day
 * the man had just typed were gone, every time.
 *
 * test-time-off-range.js pins the cause (the handler writes nothing to the
 * boxes). This drives a real Chromium with real keystrokes, because the
 * failure only exists inside the browser's date control and a stub of it
 * would agree with whatever the page did.
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
const ok = (l, c, d) => { if (c) { passed++; console.log('  ✓ ' + l); } else { failed++; console.log('  ✗ ' + l + (d ? '  — ' + d : '')); } };

// fct_user must carry allowedDivisions, or the page shows its no-access panel
// and init() never runs.
const USER = { id: 7, username: 'hudockben', role: 'admin', companyCode: 'FCT',
               isPlatformAdmin: true, allowedDivisions: ['timesheet', 'payroll', 'turf'] };

async function boot(browser) {
  const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(u => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify(u));
    localStorage.setItem('fct_division', 'turf');
  }, USER);
  await page.route('**/api/**', route => {
    const u = route.request().url();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('/api/timesheet-supervisors')) return json({ supervisors: [{ id: 3, name: 'brewernate' }], is_driver: false });
    if (u.includes('/api/timesheet-entries'))     return json({ entries: [] });
    return json({});
  });
  await page.goto((await BASE) + '/timesheet.html');
  await page.waitForTimeout(1000);
  await page.click('#tab-time-off');
  return { page, errors };
}

// Focus a date box on its first (month) segment and type into it one key at a
// time, the way a person does — fill() would set the value in one go and walk
// straight past the bug.
async function typeDate(page, sel, digits) {
  // Blur first: focusing a box that already has focus leaves the caret on the
  // segment it was last on — the year, after a full date — not the month.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.$eval(sel, e => { e.value = ''; });
  await page.focus(sel);
  for (const ch of digits) await page.keyboard.type(ch);
  return page.$eval(sel, e => e.value);
}

(async () => {
  const browser = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
      ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } : {});

  console.log('\n[a date range typed on the keyboard]');
  {
    const { page, errors } = await boot(browser);
    await page.click('#seg-off-len button[data-val="range"]');

    const first = await typeDate(page, '#f-off-date', '11052026');
    ok('the first day takes 11/05/2026 typed digit by digit', first === '2026-11-05', first);
    const last = await typeDate(page, '#f-off-date-end', '11122026');
    ok('the last day takes 11/12/2026 typed digit by digit — the reported bug',
      last === '2026-11-12', JSON.stringify(last));
    ok('  and the first day is still there after it', await page.$eval('#f-off-date', e => e.value) === '2026-11-05');
    const hint = await page.textContent('#off-len-hint');
    ok('  the hint counts the range that was typed', /^6 days off/.test(hint), hint);

    // A last day typed BEFORE the first: the last box must keep its value
    // while the first is typed underneath it.
    await page.$eval('#f-off-date', e => { e.value = ''; });
    const lastAgain = await typeDate(page, '#f-off-date-end', '11202026');
    await typeDate(page, '#f-off-date', '11162026');
    ok('the last day survives the first being typed after it',
      await page.$eval('#f-off-date-end', e => e.value) === lastAgain && lastAgain === '2026-11-20',
      await page.$eval('#f-off-date-end', e => e.value));

    // A year that crosses the first day's — the typed year passes through
    // 0002, 0020, 0202 on the way to 2027.
    const nextYear = await typeDate(page, '#f-off-date-end', '01082027');
    ok('a last day in the next year types through', nextYear === '2027-01-08', nextYear);

    // An earlier last day is still typeable — the hint, not the box, says it
    // is wrong.
    const before = await typeDate(page, '#f-off-date-end', '11022026');
    ok('a last day before the first can be typed, and is not blanked', before === '2026-11-02', before);
    ok('  the hint says it is before the first day', /before the first/.test(await page.textContent('#off-len-hint')));

    ok('no page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  console.log('\n[a single day off typed on the keyboard]');
  {
    const { page, errors } = await boot(browser);
    const d = await typeDate(page, '#f-off-date', '11052026');
    ok('Full day: the date types through', d === '2026-11-05', d);
    await page.click('#seg-off-len button[data-val="range"]');
    await page.click('#seg-off-len button[data-val="full"]');
    ok('  and survives switching to Date range and back', await page.$eval('#f-off-date', e => e.value) === '2026-11-05');
    ok('no page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
