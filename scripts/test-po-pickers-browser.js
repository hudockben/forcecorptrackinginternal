#!/usr/bin/env node
'use strict';
/**
 * The Cost / Sub Code, Vendor and Received By pickers on purchase-orders.html,
 * in a real browser.
 *
 * Run: node scripts/test-po-pickers-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *
 * scripts/test-po-page.js runs the picker's own code in jsdom. What that
 * cannot see is layout and real focus, which is most of what can go wrong:
 *
 *   - Every one of these boxes sits inside something that scrolls — the order
 *     table, the deliveries table, a sheet — so a list positioned inside it is
 *     clipped, and one opened low on the screen runs off the bottom.
 *   - Tab takes a code AND moves on in one keystroke. A re-render at that
 *     moment rebuilds the row and throws the cursor out of the table.
 *   - On a phone the list's rows are taps, and have to be thumb-sized.
 *   - The scan sheet's code box holds a search until a code is picked, and its
 *     save has to refuse one that never was.
 *
 * Harness traps (see test-row-delete-browser.js): served over HTTP, not
 * file://, and fct_division must be purchase_orders or the page bounces to
 * divisions.html.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright not installed — skipping browser checks'); process.exit(0); }
const path = require('path');
const http = require('http');
const fs   = require('fs');
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.env.PO_PICKER_SHOTS || '';   // a directory to drop screenshots in, if wanted

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
async function until(cond, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await cond()) return true; await sleep(50); }
  return false;
}

// ── The world the page loads into ──────────────────────────────────────────
const CODES = [
  { cost_code: '100', sub_code: 'Mobilization', description: '' },
  { cost_code: '420', sub_code: 'Base',    description: 'Stone base' },
  { cost_code: '420', sub_code: 'Surface', description: 'Asphalt surface — 9.5mm wearing course, two lifts' },
  { cost_code: '510', sub_code: 'Stone',   description: 'Rip rap' },
];
const CATALOG = {
  divisions: [
    { division: 'turf',   label: 'Turf Management', projects: [] },
    { division: 'paving', label: 'Paving', projects: [
      { id: 'p1', name: 'Route 9 Resurfacing', jobNumber: '2201', codes: CODES, done: false },
    ] },
    { division: 'kiewit', label: 'Kiewit Pinetree', projects: [] },
  ],
  vendors: ['84 Lumber', 'Fastenal', 'Ferguson', 'Grainger', 'Home Depot', "Lowe's", 'Martin Limestone',
    'Pennsy Supply', 'Sunbelt Rentals', 'Tri-State Aggregates & Supply Co', 'United Rentals']
    .map(name => ({ name })),
  employees: ['Dana Ruiz', 'Lee Park', 'Sam Ortiz'].map(name => ({ name })),
  truncated: [],
};
const line = id => ({ id, invoice_num: '', date: '2026-10-01', qty: '', unit_cost: '', tax: '', tax_pct: '',
  employee: '', po_row_id: null });
// Newest first by date_created — none of these ids decode as a uid().
const ORDERS = {
  paving: [{ id: 'po-main', po_number: 'PO-0011', status: 'pending', date_created: '2026-10-01',
    project_id: 'p1', cost_code: '420', sub_code: 'Base', title: 'Base stone', supplier: 'Home Depot',
    notes: '', origin: 'purchasing', lines: [line('l1')] }],
  purchase_orders: Array.from({ length: 11 }, (_, i) => ({
    id: 'po-g' + i, po_number: 'PO-' + String(i + 1).padStart(4, '0'), status: 'pending',
    date_created: '2026-09-' + String(20 - i).padStart(2, '0'), project_id: '', cost_code: '', sub_code: '',
    title: 'Shop supplies ' + i, supplier: 'Fastenal', notes: '', origin: 'purchasing', lines: [line('lg' + i)] })),
};
// The classic 1×1 PNG — enough for the scan's canvas downscale to read.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function openPage(browser, opts) {
  const saves = [];
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'tester', name: 'Test User',
      companyCode: 'FCT', isPlatformAdmin: true, allowedDivisions: ['turf', 'paving', 'kiewit', 'purchase_orders'] }));
    localStorage.setItem('fct_division', 'purchase_orders');
  });
  const base = await BASE;
  await page.route('**/upload/**', route => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/**', route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/po-catalog') return json(CATALOG);
    if (p === '/api/purchase-orders') {
      const division = u.searchParams.get('division');
      if (m === 'GET') return json({ purchaseOrders: JSON.parse(JSON.stringify(ORDERS[division] || [])) });
      const body = JSON.parse(req.postData() || '{}');
      saves.push({ division, po: body.purchaseOrder });
      return json({ purchaseOrder: body.purchaseOrder, mergedLines: 0 });
    }
    if (p === '/api/ai/receipt-scan') {
      return json({ receipt: { vendor: 'Fastenal', description: 'Anchor bolts', date: '2026-10-01',
        invoice_number: 'INV-77', qty: 2, unit_cost: 10, tax_pct: 0, total: 20, confidence: 'high' } });
    }
    if (p === '/api/documents') {
      if (m === 'GET') return json({ counts: {}, documents: [] });
      if (m === 'PUT') return json({ folders: [{ id: 'f1', slug: 'purchase-orders' }] });
      return json({});
    }
    if (p === '/api/document-upload-url') {
      return json({ uploadUrl: base + '/upload/r.jpg', contentType: 'image/jpeg', storageKey: 'k1', documentId: 'd1' });
    }
    return json({});
  });
  await page.goto(base + '/purchase-orders.html');
  return { page, ctx, saves, errors };
}

/** Where an open list sits against its box and the window, measured in the page. */
const geometry = (page, input) => input.evaluate(el => {
  const menu = el.nextElementSibling;
  const r = el.getBoundingClientRect(), m = menu.getBoundingClientRect();
  const opts = [...menu.querySelectorAll('.cb-opt')];
  // Whatever is really on top at each entry's middle — an entry clipped by a
  // scroll container is hidden under, or cut out by, something else.
  const reachable = opts.every(o => {
    const b = o.getBoundingClientRect();
    if (b.bottom <= m.top || b.top >= m.bottom) return true;   // scrolled out of the list, not clipped
    return document.elementFromPoint(b.left + b.width / 2, Math.max(b.top, m.top) + 2) === o;
  });
  return { open: !menu.hidden, box: { top: r.top, bottom: r.bottom, left: r.left }, menu: { top: m.top, bottom: m.bottom, left: m.left, right: m.right, height: m.height },
    vw: document.documentElement.clientWidth, vh: window.innerHeight, reachable,
    rowHeights: opts.map(o => o.getBoundingClientRect().height), texts: opts.map(o => o.textContent) };
});

(async () => {
  const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined });

  // ── Desktop: the order table ─────────────────────────────────────────────
  console.log('\n[desktop — the order table]');
  {
    const { page, ctx, saves, errors } = await openPage(browser, { viewport: { width: 1474, height: 889 } });
    await page.waitForSelector('#po-body .cb[data-list="codes"] .cb-input');
    const row  = page.locator('#po-body tr.po-head').first();
    const code = row.locator('.cb[data-list="codes"] .cb-input');
    const vendor = row.locator('.cb[data-list="vendors"] .cb-input');
    const desc = row.locator('input[placeholder="Material / description"]');
    const active = () => page.evaluate(() => (document.activeElement || {}).outerHTML.slice(0, 120));
    const entry = (box, text) => box.locator('xpath=following-sibling::div[1]').locator('.cb-opt', { hasText: text });
    // A click the way a hand makes one. Playwright's own lets go in the same
    // instant, which hides anything that happens to the page mid-press.
    const press = async loc => {
      const b = await loc.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down(); await sleep(90); await page.mouse.up();
    };

    ok('the code cell shows the order\'s code by its label', await code.inputValue() === '420 / Base — Stone base',
      await code.inputValue());
    await code.click();
    let g = await geometry(page, code);
    ok('clicking it opens the job\'s codes', g.open && g.texts.length === 4, JSON.stringify(g.texts));
    ok('  below the box', g.menu.top >= g.box.bottom, JSON.stringify(g));
    ok('  and inside the window, not clipped by the table\'s scroll pane',
      g.reachable && g.menu.bottom <= g.vh && g.menu.right <= g.vw, JSON.stringify(g));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'po-picker-code-desktop.png') });

    await page.keyboard.type('rip');
    g = await geometry(page, code);
    ok('typing narrows the list', g.texts.join('|') === '510 / Stone — Rip rap', g.texts.join('|'));
    await page.keyboard.press('Enter');
    ok('Enter takes the code and saves it', await until(() => saves.some(s => s.po.id === 'po-main'
      && s.po.cost_code === '510' && s.po.sub_code === 'Stone')), JSON.stringify(saves.map(s => s.po.cost_code)));
    ok('  and the box shows its label', await until(async () =>
      (await row.locator('.cb[data-list="codes"] .cb-input').inputValue()) === '510 / Stone — Rip rap'));

    // A right-click on an entry — to copy its text, say — is not a pick.
    await code.click();
    const savesBeforeRight = saves.length;
    await entry(code, 'Mobilization').click({ button: 'right' });
    await sleep(600);
    ok('a right-click on an entry does not take it',
      saves.length === savesBeforeRight && await code.inputValue() !== '100 / Mobilization', await code.inputValue());
    // Away the way a hand goes after a context menu: a click elsewhere. Chrome
    // places the caret on the next click into the box after a right-click
    // rather than keeping the box's own select-all, which is its affair.
    await page.mouse.click(700, 30);
    await sleep(200);

    // Tab takes a code and moves on in the same keystroke. The row must not be
    // rebuilt under the field the cursor went to — nor later, under whatever
    // is reached or pressed next.
    await code.click();
    await page.keyboard.type('base');
    await page.keyboard.press('Tab');
    await sleep(300);
    ok('Tab takes the code and the cursor lands in Description',
      await desc.evaluate(el => document.activeElement === el), await active());
    ok('  where it stays while the save goes out', await until(() =>
      saves.some(s => s.po.cost_code === '420' && s.po.sub_code === 'Base')));
    await page.keyboard.press('End');   // tabbing into a text field selects what is in it
    await page.keyboard.type(' — 2 loads');
    ok('  and typing carries on in that field', (await desc.inputValue()) === 'Base stone — 2 loads', await desc.inputValue());
    await page.keyboard.press('Tab');   // Vendor
    await page.keyboard.press('Tab');   // Status
    await page.keyboard.press('Tab');   // the paperclip
    await sleep(300);
    ok('  and Tab walks on along the row to the paperclip, focus intact',
      await row.locator('.icon-btn').evaluate(el => document.activeElement === el), await active());

    await code.click();
    await page.keyboard.type('surface');
    await page.keyboard.press('Tab');
    await sleep(200);
    await press(row.locator('td').first());
    ok('the first click after a Tab pick lands: ▶ opens the deliveries',
      await until(async () => await page.locator('#po-body .lines-wrap').count() === 1, 1500));
    ok('  and the code was taken', await until(() => saves.some(s => s.po.sub_code === 'Surface')));

    // Half-typed text that names no code goes back on blur.
    const surface = '420 / Surface — Asphalt surface — 9.5mm wearing course, two lifts';
    await code.click();
    await page.keyboard.type('asph');
    await page.mouse.click(700, 30);
    await sleep(300);
    ok('half-typed text that names no code goes back to the order\'s code',
      await code.inputValue() === surface, await code.inputValue());

    // Vendor: free text the list suggests for.
    await vendor.click();
    g = await geometry(page, vendor);
    ok('the vendor box lists every vendor', g.open && g.texts.length === CATALOG.vendors.length, g.texts.length);
    await page.keyboard.type('state');
    g = await geometry(page, vendor);
    ok('typing finds a vendor by a word inside its name', g.texts.join('|') === 'Tri-State Aggregates & Supply Co',
      g.texts.join('|'));
    ok('  suggested, not chosen: a partial match is not highlighted',
      await vendor.evaluate(el => !el.nextElementSibling.querySelector('.cb-opt.hi')));
    await entry(vendor, 'Tri-State').click();
    ok('a click takes it and saves it', await until(() => saves.some(s => s.po.id === 'po-main'
      && s.po.supplier === 'Tri-State Aggregates & Supply Co')));
    await vendor.click();
    await page.keyboard.type('Ferg');
    await page.keyboard.press('Enter');
    ok('Enter keeps a name as typed, even one a longer entry contains', await until(() =>
      saves.some(s => s.po.id === 'po-main' && s.po.supplier === 'Ferg')), await vendor.inputValue());
    await vendor.click();
    await page.keyboard.type('Keystone Concrete');
    await page.mouse.click(700, 30);
    ok('a vendor not on the list is saved as typed', await until(() => saves.some(s => s.po.id === 'po-main'
      && s.po.supplier === 'Keystone Concrete')));

    // Received By, in the deliveries panel opened above — a second scroll pane,
    // nested. Opened here if that click was lost, so the rest still reports.
    if (await page.locator('#po-body .lines-wrap').count() === 0) await row.locator('td').first().click();
    const recv = page.locator('#po-body .cb[data-list="employees"] .cb-input').first();
    await recv.waitFor();
    await recv.click();
    g = await geometry(page, recv);
    ok('Received By lists the employees, clear of the deliveries table',
      g.open && g.texts.join('|') === 'Dana Ruiz|Lee Park|Sam Ortiz' && g.reachable, JSON.stringify(g.texts));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'po-picker-received-by.png') });
    await page.keyboard.type('Lee');
    await page.keyboard.press('Tab');
    ok('Tab keeps a name as typed: a delivery taken by "Lee" stays Lee', await until(() =>
      saves.some(s => s.po.id === 'po-main' && s.po.lines && s.po.lines[0].employee === 'Lee')), await recv.inputValue());
    await recv.click();
    await page.keyboard.type('lee');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    ok('ArrowDown then Enter takes the suggestion', await until(() => saves.some(s => s.po.id === 'po-main'
      && s.po.lines && s.po.lines[0].employee === 'Lee Park')), await recv.inputValue());

    // Low on the screen there is no room below, so the list goes up.
    const last = page.locator('#po-body tr.po-head').last().locator('.cb[data-list="vendors"] .cb-input');
    await last.evaluate(el => el.scrollIntoView({ block: 'end' }));
    await last.click();
    g = await geometry(page, last);
    ok('a list opened low on the screen opens upward, all of it in view',
      g.open && g.menu.bottom <= g.box.top + 1 && g.menu.top >= 0 && g.reachable, JSON.stringify(g));
    await page.keyboard.press('Escape');

    ok('no script errors on the desktop page', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ── Phone: the card editor ───────────────────────────────────────────────
  console.log('\n[phone — the card editor]');
  {
    const { page, ctx, saves, errors } = await openPage(browser,
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.waitForSelector('.po-card');
    await page.locator('.po-card').first().locator('button', { hasText: 'Edit details' }).tap();
    const code = page.locator('#po-cards .cb[data-list="codes"] .cb-input');
    await code.waitFor();
    await code.tap();
    let g = await geometry(page, code);
    ok('the card\'s code box opens its list', g.open && g.texts.length === 4, JSON.stringify(g.texts));
    ok('  inside the screen', g.menu.left >= 0 && g.menu.right <= g.vw && g.reachable, JSON.stringify(g.menu));
    ok('  with every row a 44px tap', g.rowHeights.every(h => h >= 44), g.rowHeights.join(','));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'po-picker-code-phone.png') });
    await page.locator('#po-cards .cb-opt', { hasText: 'Mobilization' }).tap();
    ok('a tap on an entry takes it and saves it', await until(() => saves.some(s => s.po.id === 'po-main'
      && s.po.cost_code === '100')));
    ok('  and the card above shows the new code', await until(async () =>
      (await page.locator('.po-card').first().locator('.meta').nth(1).innerText()).includes('100 / Mobilization')));

    const vendor = page.locator('#po-cards .cb[data-list="vendors"] .cb-input');
    await vendor.tap();
    await page.keyboard.type('lime');
    g = await geometry(page, vendor);
    ok('the card\'s vendor box searches too', g.texts.join('|') === 'Martin Limestone', g.texts.join('|'));
    await page.keyboard.press('Escape');

    // A phone on its side with the keyboard up leaves a strip of screen. The
    // list has to fit the room there is, not hang off the bottom of it.
    await page.setViewportSize({ width: 844, height: 160 });
    await code.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await code.tap();
    g = await geometry(page, code);
    ok('with little room either side, the list still fits the screen',
      g.open && g.menu.top >= 0 && g.menu.bottom <= g.vh, JSON.stringify({ box: g.box, menu: g.menu, vh: g.vh }));
    ok('no script errors on the phone page', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ── The scan sheet ───────────────────────────────────────────────────────
  console.log('\n[the scan sheet]');
  {
    const { page, ctx, saves, errors } = await openPage(browser, { viewport: { width: 1280, height: 900 } });
    await page.waitForSelector('#po-body tr.po-head');
    const chooser = page.waitForEvent('filechooser');
    await page.click('#scan-btn');
    await (await chooser).setFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('#sc-code');

    const sc = page.locator('#sc-code');
    ok('the code box waits for a job', await sc.isDisabled());
    await page.selectOption('#sc-division', 'paving');
    await page.selectOption('#sc-project', 'p1');
    ok('  and opens once one with codes is picked', !(await sc.isDisabled()));

    // The list can hang past the bottom of the sheet, over the backdrop. A pick
    // made there has to land on the entry — not close the sheet, scan and all.
    const spot = await page.evaluate(() => {
      const sheet = document.getElementById('scan-sheet');
      const box = document.getElementById('sc-vendor');
      const edge = sheet.getBoundingClientRect().bottom;
      sheet.scrollTop += box.getBoundingClientRect().bottom - (edge - 224);
      const r = box.getBoundingClientRect();
      return { x: r.left + 30, y: r.top + r.height / 2, edge };
    });
    await page.mouse.click(spot.x, spot.y);
    const hanging = await page.evaluate(edge => {
      const menu = document.querySelector('#scan-sheet .cb[data-list="vendors"] .cb-menu');
      const m = menu.getBoundingClientRect();
      for (const o of menu.querySelectorAll('.cb-opt')) {
        const b = o.getBoundingClientRect();
        const top = Math.max(b.top, edge + 2), bottom = Math.min(b.bottom, m.bottom - 2);
        if (bottom - top >= 4) return { text: o.textContent, x: b.left + b.width / 2, y: (top + bottom) / 2 };
      }
      return null;
    }, spot.edge);
    ok('the vendor list can hang past the bottom of the sheet', Boolean(hanging), JSON.stringify(spot));
    let vendorNow = 'Fastenal';
    if (hanging) {
      await page.mouse.click(hanging.x, hanging.y);
      await sleep(250);
      ok('a pick made there keeps the sheet — and the scan — open',
        await page.locator('#scan-backdrop.open').count() === 1);
      if (await page.locator('#scan-backdrop.open').count() === 0) {
        console.log('  (the sheet is gone, so the rest of the scan checks cannot run)');
        failed++;
        await ctx.close();
        await browser.close();
        server.close();
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exit(1);
      }
      ok('  and takes the entry', await page.locator('#sc-vendor').inputValue() === hanging.text,
        await page.locator('#sc-vendor').inputValue());
      vendorNow = hanging.text;
    }

    // Escape backs out of a list without throwing the scan away.
    await page.locator('#sc-vendor').click();
    await page.keyboard.press('Escape');
    await sleep(150);
    ok('Escape in a list closes the list, not the sheet',
      await page.locator('#scan-backdrop.open').count() === 1 && await page.locator('#sc-vendor').inputValue() === vendorNow);

    await sc.click();
    await page.keyboard.type('base');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'po-picker-scan.png') });
    const before = saves.length;
    await page.click('#sc-save');
    await sleep(300);
    ok('a code typed but never picked is refused, with a reason',
      saves.length === before && /Pick the cost \/ sub code from the list/.test(await page.locator('#toast').innerText()),
      await page.locator('#toast').innerText());
    ok('  and the sheet stays open with what was typed', await page.locator('#scan-backdrop.open').count() === 1
      && await sc.inputValue() === 'base');

    await sc.click();
    await page.keyboard.type('base');
    await page.keyboard.press('Enter');
    await page.click('#sc-save');
    ok('a picked code is booked on the new order', await until(() => saves.some(s => s.division === 'paving'
      && s.po.id !== 'po-main' && s.po.cost_code === '420' && s.po.sub_code === 'Base' && s.po.supplier === vendorNow)),
      JSON.stringify(saves.map(s => [s.division, s.po.cost_code, s.po.sub_code, s.po.supplier])));
    ok('  and the sheet closes', await until(async () => await page.locator('#scan-backdrop.open').count() === 0));
    ok('no script errors in the scan', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
