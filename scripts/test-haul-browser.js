#!/usr/bin/env node
'use strict';
/**
 * The haul UIs, in a real browser.
 *
 * Run: node scripts/test-haul-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *
 * Everything else on this branch is code-level — functions lifted out of the
 * pages and run in a sandbox. That cannot tell you whether the control actually
 * renders, whether it is reachable, or whether the page still boots at all. It
 * is exactly the class of gap the owner's own manual test found twice.
 *
 * Two harness traps this hit, both worth keeping written down because either one
 * makes the suite measure nothing while reporting a failure that looks real:
 *
 *   - The pages MUST be served over HTTP. Loaded from file://, a relative
 *     `/api/...` fetch never leaves as HTTP, every lookup fails, and the form
 *     degrades exactly as it would offline.
 *   - The stubbed fct_user MUST carry allowedDivisions. Without it timesheet.html
 *     shows its no-access panel and init() never runs, so nothing is fetched and
 *     every control is legitimately hidden.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright not installed — skipping browser checks'); process.exit(0); }
const path = require('path');
const http = require('http');
const fs   = require('fs');
const ROOT = path.resolve(__dirname, '..');

// Served over HTTP, not file://. A page loaded from file:// cannot fetch a
// relative /api/ URL at all — the request never leaves as HTTP, so every lookup
// fails and the form degrades exactly as it would offline. That would have made
// this whole harness measure the wrong thing.
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

const TOKEN = 'x.y.z';
const USER  = { id: 7, username: 'hudockben', role: 'admin', companyCode: 'FCT',
              isPlatformAdmin: true, allowedDivisions: ['timesheet','payroll','turf'] };

// Every API the two pages touch on boot, answered with the smallest honest body.
function mockApi(page, { isDriver = true, equipment = [] } = {}) {
  return page.route('**/api/**', route => {
    const u = route.request().url();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('/api/timesheet-supervisors')) {
      return json({ supervisors: [{ id: 3, name: 'brewernate' }], is_driver: isDriver });
    }
    if (u.includes('/api/equipment'))       return json({ equipment });
    if (u.includes('/api/timesheet-jobs'))  return json({ jobs: [{ id: '26049', label: 'Franklin Regional Multi · 26049' }] });
    if (u.includes('/api/timesheet-entries')) return json({ entries: [] });
    if (u.includes('/api/company/users'))   return json({ users: [] });
    if (u.includes('/api/employees'))       return json({ employees: [] });
    if (u.includes('/api/projects'))        return json({ projects: [] });
    return json({});
  });
}

async function boot(page, file, opts) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ t, u }) => {
    localStorage.setItem('fct_token', t);
    localStorage.setItem('fct_user', JSON.stringify(u));
    localStorage.setItem('fct_division', 'turf');
  }, { t: TOKEN, u: USER });
  await mockApi(page, opts || {});
  await page.goto((await BASE) + '/' + file);
  await page.waitForTimeout(1200);
  return errors;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // ── The driver's form ────────────────────────────────────────────────────
  console.log('\n[timesheet.html — the driver is asked]');
  {
    const page = await browser.newPage();
    const errs = await boot(page, 'timesheet.html',
      { isDriver: true, equipment: [{ name: 'Triaxle Dump' }, { name: 'Lowboy' }] });
    ok('the page boots with no uncaught error', errs.length === 0, errs.slice(0, 2).join(' | '));

    const haulShown = await page.evaluate(() => {
      const r = document.getElementById('row-haul');
      return !!r && getComputedStyle(r).display !== 'none';
    });
    ok('a flagged driver is asked the hauling question', haulShown);

    const labels = await page.$$eval('#seg-haul button', b => b.map(x => x.textContent.trim()));
    ok('with all three answers', labels.length === 3 && labels.includes('On site'), labels.join('/'));

    // Answering it should reveal the truck picker, filled from the equipment list.
    await page.evaluate(() => { document.getElementById('f-division').value = 'turf'; });
    await page.click('#seg-haul button[data-val="off_site"]');
    await page.waitForTimeout(600);
    const unit = await page.evaluate(() => {
      const r = document.getElementById('row-haul-unit');
      const s = document.getElementById('haul-unit');
      return { shown: !!r && getComputedStyle(r).display !== 'none',
               opts: s ? [...s.options].map(o => o.value).filter(Boolean) : [] };
    });
    ok('answering "haul" reveals the truck picker', unit.shown);
    ok('  populated from the company equipment list',
      unit.opts.includes('Triaxle Dump') && unit.opts.includes('Lowboy'), unit.opts.join('/'));

    // And taking the answer back hides it again.
    await page.click('#seg-haul button[data-val=""]');
    await page.waitForTimeout(300);
    const hidden = await page.evaluate(() =>
      getComputedStyle(document.getElementById('row-haul-unit')).display === 'none');
    ok('answering "no" hides it again', hidden);
    await page.close();
  }

  console.log('\n[timesheet.html — a non-driver is not]');
  {
    const page = await browser.newPage();
    const errs = await boot(page, 'timesheet.html', { isDriver: false });
    ok('the page boots with no uncaught error', errs.length === 0, errs.slice(0, 2).join(' | '));
    const shown = await page.evaluate(() => {
      const r = document.getElementById('row-haul');
      return !!r && getComputedStyle(r).display !== 'none';
    });
    ok('the question is not shown', shown === false);
    await page.close();
  }

  // ── The approver's modal ─────────────────────────────────────────────────
  console.log('\n[payroll.html — the approver can classify]');
  {
    const page = await browser.newPage();
    const errs = await boot(page, 'payroll.html');
    ok('the page boots with no uncaught error', errs.length === 0, errs.slice(0, 2).join(' | '));

    const built = await page.evaluate(() => {
      if (typeof splitHaulPickerHtml !== 'function') return { err: 'splitHaulPickerHtml missing' };
      const host = document.createElement('div');
      host.innerHTML = splitHaulPickerHtml({ haul_type: 'off_site' });
      document.body.appendChild(host);
      const sel = host.querySelector('#splitHaulPick');
      return {
        opts: sel ? [...sel.options].map(o => o.value) : null,
        selected: sel ? sel.value : null,
        answer: typeof splitHaulAnswer !== 'undefined' ? splitHaulAnswer : '(missing)',
      };
    });
    ok('the approve modal renders the hauling picker', !built.err, built.err);
    ok('  with all three answers',
      built.opts && built.opts.length === 3 && built.opts.includes('on_site'),
      JSON.stringify(built.opts));
    ok('  defaulted to what the driver said', built.selected === 'off_site', built.selected);
    ok('  and seeded into splitHaulAnswer, not onto the entry', built.answer === 'off_site', built.answer);

    const note = await page.evaluate(() => {
      const h = document.createElement('div');
      h.innerHTML = splitHaulNoteHtml({ prevailing_wage: true });
      return h.textContent;
    });
    ok('the $0-labour note explains itself', /\$0 labour rate/.test(note), note.slice(0, 80));
    ok('  and says the hours pay at standard on a prevailing job',
      /standard/.test(note) && /prevailing/.test(note));
    await page.close();
  }

  console.log('\n[divisions.html — the Driver toggle is findable]');
  {
    const page = await browser.newPage();
    const errs = await boot(page, 'divisions.html');
    ok('the page boots with no uncaught error', errs.length === 0, errs.slice(0, 2).join(' | '));
    const tab = await page.evaluate(() => {
      const b = document.getElementById('muTabBtnSupervisors');
      const th = [...document.querySelectorAll('.sup-table thead th')].map(t => t.textContent.trim());
      return { label: b ? b.textContent.trim() : null, headers: th };
    });
    ok('the sub-tab is named for what it now holds', tab.label === 'Roles', tab.label);
    ok('  and the table has a Driver column',
      tab.headers.includes('Driver') && tab.headers.includes('Supervisor'), tab.headers.join('/'));
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('harness error:', e.message); process.exit(1); });
