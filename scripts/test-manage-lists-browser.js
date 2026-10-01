#!/usr/bin/env node
'use strict';
/**
 * Manage Dropdown Lists, in a real browser: can a machine be taken off the list?
 *
 * Run: node scripts/test-manage-lists-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *
 * The modal's ✕, its inline edits and its confirm popover are all wired by
 * delegation on the modal's body. On tracker.html that body was looked up as
 * the FIRST '.modal-body' on the page — and when the CRM Lists modal was added
 * above it in the markup, every handler quietly moved there. Nothing threw:
 * ✕ on an equipment row did nothing, a cost typed into a row was never saved,
 * and ✕ in CRM Lists raised a second, stray "Are you sure?". A suite that lifts
 * functions out of the page cannot see that; only clicking can.
 *
 * Also covered: a double-click on ✕. The handler used to keep an "already
 * open" flag that a click elsewhere never cleared, and the second click of a
 * double-click IS a click elsewhere — so the popover flashed, vanished, and
 * that row's ✕ stayed dead until the list was redrawn.
 *
 * Run against all three division pages, which carry the same modal.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOKEN = 'x.y.z';
const PAGES = [
  { file: 'tracker.html',         division: 'turf',   listsKey: 'fct_lists',        crm: true },
  { file: 'paving.html',          division: 'paving', listsKey: 'fct_paving_lists', crm: false },
  { file: 'kiewit-pinetree.html', division: 'kiewit', listsKey: 'fct_kiewit_lists', crm: false },
];

// The tail of the equipment list in the report that started this.
const EQUIPMENT = ['Groomer', 'Hamm Roller', 'Hydroseed Truck', 'Pick', 'Pick Up', 'PickUp',
  'Pickup', 'Recalimer', 'Reclaimer', 'Rock Truck'].map((name, i) => ({ name, unit_cost: 10 * (i + 1) }));

async function run(browser, { file, division, listsKey, crm }) {
  console.log(`\n${file}`);
  const STORE = {
    [listsKey]: {
      equipment: EQUIPMENT.map(e => ({ ...e })),
      employees: [{ name: 'Sam', non_prevailing_rate: 30, prevailing_rate: 50, job_class: '' }],
      field_types: ['Football', 'Soccer'], job_classes: ['Laborer', 'Operator'],
      infill_types: [], cost_codes: [], suppliers: [],
    },
  };
  const page = await browser.newPage({ viewport: { width: 1474, height: 889 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.addInitScript(({ t, division }) => {
    localStorage.setItem('fct_token', t);
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'hudockben', role: 'admin',
      companyCode: 'FCT', isPlatformAdmin: true, allowedDivisions: ['turf', 'paving', 'kiewit'] }));
    localStorage.setItem('fct_division', division);
  }, { t: TOKEN, division });
  await page.route('**/api/**', route => {
    const req = route.request();
    const u   = new URL(req.url());
    const p   = u.pathname;
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',').filter(Boolean);
      return json({ values: Object.fromEntries(keys.filter(k => k in STORE).map(k => [k, STORE[k]])) });
    }
    if (p.startsWith('/api/data/')) {
      const key = decodeURIComponent(p.slice('/api/data/'.length));
      if (req.method() === 'GET') return json({ value: key in STORE ? STORE[key] : null });
      if (req.method() === 'PUT') {
        try { STORE[key] = JSON.parse(req.postData() || '{}').value; } catch {}
        return json({ ok: true });
      }
    }
    return json({});
  });

  await page.goto((await BASE) + '/' + file);
  await page.waitForFunction(() => typeof _listsLoaded !== 'undefined' && _listsLoaded
    && Array.isArray(lists.equipment) && lists.equipment.length > 0, null, { timeout: 20000 });
  await sleep(300);

  const onPage   = () => page.evaluate(() => lists.equipment.map(e => e.name));
  const onServer = () => (STORE[listsKey].equipment || []).map(e => e.name);
  const popovers = () => page.locator('.del-confirm').count();
  const xFor = async name => {
    const btn = page.locator(`#items-equipment .remove-item[data-idx="${(await onPage()).indexOf(name)}"]`);
    await btn.scrollIntoViewIfNeeded();
    return btn;
  };

  await page.evaluate(() => openModal());
  await page.click('#modal-tabs .modal-tab-btn[data-list="equipment"]');

  // ✕ then Yes takes the machine off the list, on the page and on the server.
  await (await xFor('Pick')).click();
  await sleep(100);
  ok('✕ on an equipment row opens the confirm', await popovers() === 1, `${await popovers()} open`);
  if (await popovers()) await page.click('.del-confirm .dc-yes');
  await sleep(300);
  ok('Yes removes it from the list on the page', !(await onPage()).includes('Pick'));
  ok('…and from the list saved to the server', !onServer().includes('Pick'), onServer().join(', '));
  ok('…and nothing else', onServer().length === EQUIPMENT.length - 1, `${onServer().length} left`);
  ok('…and the row is gone from the modal',
    !(await page.locator('#items-equipment input[data-field="name"]').evaluateAll(els => els.map(e => e.value))).includes('Pick'));

  // No keeps it.
  await (await xFor('Pickup')).click();
  await sleep(100);
  if (await popovers()) await page.click('.del-confirm .dc-no');
  await sleep(200);
  ok('No keeps it', (await onPage()).includes('Pickup') && onServer().includes('Pickup'));

  // A double-click leaves the confirm up, and the ✕ still works after the
  // confirm is closed by clicking somewhere else.
  await (await xFor('Recalimer')).dblclick();
  await sleep(100);
  ok('a double-click on ✕ leaves the confirm open', await popovers() === 1, `${await popovers()} open`);
  await page.click('#modal-overlay .modal-header h2');
  await sleep(100);
  ok('a click elsewhere closes it', await popovers() === 0);
  await (await xFor('Recalimer')).click();
  await sleep(100);
  ok('…and the same ✕ opens it again', await popovers() === 1, `${await popovers()} open`);
  if (await popovers()) await page.click('.del-confirm .dc-yes');
  await sleep(300);
  ok('…and Yes removes that one', !(await onPage()).includes('Recalimer') && !onServer().includes('Recalimer'));

  // An edit typed into a row is saved.
  const hIdx = (await onPage()).indexOf('Hydroseed Truck');
  const cost = page.locator(`#items-equipment input[data-idx="${hIdx}"][data-field="unit_cost"]`);
  await cost.fill('45');
  await cost.blur();
  await sleep(300);
  const saved = (STORE[listsKey].equipment.find(e => e.name === 'Hydroseed Truck') || {}).unit_cost;
  ok('a unit cost typed into a row is saved', saved === 45, `server has ${saved}`);

  // Another list on the same modal: Field Types.
  await page.click('#modal-tabs .modal-tab-btn[data-list="field_types"]');
  await page.locator('#items-field_types .remove-item[data-idx="1"]').click();
  await sleep(100);
  if (await popovers()) await page.click('.del-confirm .dc-yes');
  await sleep(300);
  ok('✕ works on Field Types too', JSON.stringify(STORE[listsKey].field_types) === '["Football"]',
    JSON.stringify(STORE[listsKey].field_types));

  await page.evaluate(() => closeModal());

  // ✕ in CRM Lists runs its own confirm and nothing else.
  if (crm) {
    await page.evaluate(() => openCrmLists('crm_contact_types'));
    await sleep(200);
    const before = await page.evaluate(() => (lists.crm_contact_types || []).length);
    await page.locator('#crm-lists-body .remove-item[title="Remove from the list"]').first().click();
    await sleep(200);
    ok('✕ in CRM Lists raises no stray Manage Lists confirm', await popovers() === 0, `${await popovers()} open`);
    ok('…and still removes its value', await page.evaluate(() => (lists.crm_contact_types || []).length) === before - 1);
    await page.evaluate(() => closeCrmLists());
  }

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    for (const p of PAGES) await run(browser, p);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
