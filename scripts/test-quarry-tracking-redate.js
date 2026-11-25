#!/usr/bin/env node
'use strict';
/**
 * Quarry ▸ Sales, Daily and Crushing Tracking — an edit that takes a row out
 * of the filters takes it off the table.
 *
 * Run: node scripts/test-quarry-tracking-redate.js
 *
 * Crushing re-rendered on a re-dated row; Sales and Daily saved without one,
 * and so did a Sales combobox pick. With Year = 2026, a Sales or Daily row
 * re-dated to 2025 stayed in the table, out of date order, while the summary
 * (which re-filters the next time anything calls it) and the "Delete N Rows"
 * count stopped agreeing with what was shown.
 *
 * Loads quarry.html in jsdom with stubbed blob endpoints and checks, per tab:
 *   - a date set from a script re-renders at once: the row leaves the table,
 *     Rows drops, the Delete count matches, ⇩ Download hands over the same rows
 *   - a date from the row's own date box waits for the box to lose focus
 *     (Chrome fires change at every keystroke — the keyboard side of this is
 *     test-quarry-tracking-redate-browser.js), and not for the window losing it
 *   - a row re-dated inside the filters moves to its date's place
 *   - keystroke paths (numbers, Payment, Crushing comments) still do not
 *     re-render — the same row element stays in the page
 *   - the filter menus are kept as they are: the filter a row just left is
 *     still the filter, not dropped for having no rows
 * and on Sales, a combobox pick outside the Location / Customer / Product
 * filter takes the row off the table with the combobox closed, while one
 * inside it does not re-render (the tax cell still follows the customer).
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT          = path.resolve(__dirname, '..');
const HTML_PATH     = path.join(ROOT, 'quarry.html');
const BRANDING_PATH = path.join(ROOT, 'report-branding.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? undefined : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Fixture ────────────────────────────────────────────────────────────────
const LISTS = {
  location:  [{ id: 'l1', name: 'Homer City' }, { id: 'l2', name: 'McGees Mills' }],
  product:   [{ id: 'p1', name: '2B' }, { id: 'p2', name: '6-' }],
  customer:  [{ id: 'c1', name: 'Force Turf Solutions', taxable: false }, { id: 'c2', name: 'Kunkle Excavating', taxable: true, taxRate: '6' }],
  employees: [{ id: 'e1', name: 'Al' }],
  equipment: [{ id: 'q1', name: 'Loader' }],
  tasks:     [{ id: 't1', name: 'Loading' }],
};
const sale = (id, date, extra) => ({ id, date, locationName: 'Homer City', employeeName: 'Al', customerName: 'Force Turf Solutions', productName: '2B', tons: 10, payment: 'Cash', pricePerTon: 12, ...extra });
const SALES = [
  sale('s1', '2026-11-20'),
  sale('s2', '2026-11-19'),
  sale('s3', '2026-11-18', { locationName: 'McGees Mills' }),   // the only McGees Mills row
  sale('s4', '2025-06-01'),
];
const day = (id, date) => ({ id, date, locationName: 'Homer City', employeeName: 'Al', equipmentName: 'Loader', taskName: 'Loading', hours: 8, rate: 20, fuelGallons: '', ppg: '' });
const DAILY = [day('d1', '2026-11-20'), day('d2', '2026-11-19'), day('d3', '2026-11-18'), day('d4', '2025-06-01')];
const run = (id, date) => ({ id, date, locationName: 'Homer City', employeeName: 'Al', productName: '', hourlyRate: 20, hours: 8, fuelGallons: '', fuelCost: '', loadsToCrusher: 2, tonsPerLoad: 25, hoursCrushing: 1, comments: '' });
const CRUSH = [run('k1', '2026-11-20'), run('k2', '2026-11-19'), run('k3', '2026-11-18'), run('k4', '2025-06-01')];

const BLOBS = {
  fct_quarry_lists: LISTS, fct_quarry_sales: SALES, fct_quarry_crushing: CRUSH, fct_quarry_daily: DAILY,
  fct_quarry_inventory: {}, fct_quarry_loss_pct: {}, fct_presence: {},
};

// Per tab: where its table and counts live, and what its setter is called.
const TABS = [
  { tab: 'sales',    tbody: 'salesTbody', rows: 'salesRows', summary: 'salesSummary', del: 'salesDeleteFilteredBtn',    set: 'updateSalesCell', ids: ['s1', 's2', 's3'], old: 's4' },
  { tab: 'daily',    tbody: 'dailyTbody', rows: 'dailyRows', summary: 'dailySummary', del: 'dailyDeleteFilteredBtn',    set: 'updateDailyCell', ids: ['d1', 'd2', 'd3'], old: 'd4' },
  { tab: 'crushing', tbody: 'crushTbody', rows: 'crushRows', summary: 'crushSummary', del: 'crushingDeleteFilteredBtn', set: 'updateCrushCell', ids: ['k1', 'k2', 'k3'], old: 'k4' },
];

// ── Harness ────────────────────────────────────────────────────────────────
function stubFetch(blobs) {
  return async (url, init) => {
    const m = /\/api\/data\/([^?]+)/.exec(String(url));
    const key = m ? decodeURIComponent(m[1]) : '';
    if (m && (!init || !init.method || init.method === 'GET')) {
      const v = Object.prototype.hasOwnProperty.call(blobs, key) ? JSON.parse(JSON.stringify(blobs[key])) : null;
      return { ok: true, status: 200, json: async () => ({ value: v }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
}

async function loadPage() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/quarry.html',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.eval(fs.readFileSync(BRANDING_PATH, 'utf8'));
      win.localStorage.setItem('fct_token', 'test-token');
      win.localStorage.setItem('fct_user', JSON.stringify({
        userId: 1, username: 'tester', name: 'Test User', companyCode: 'TEST', companyName: 'Test Co',
      }));
      win.fetch = stubFetch(BLOBS);
      win.alert = (msg) => { (win.__alerts = win.__alerts || []).push(String(msg)); };
      win.print = () => {};
      win.__errors = [];
      win.addEventListener('error', e => win.__errors.push(e.message || String(e.error)));
    },
  });
  const win = dom.window;
  for (let i = 0; i < 80 && !win.eval('typeof listsLoaded !== "undefined" && listsLoaded'); i++) await sleep(25);
  for (const tab of ['sales', 'crushing', 'daily']) win.switchTab(tab);
  for (let i = 0; i < 120 && !win.eval('salesLoaded && crushLoaded && dailyLoaded'); i++) await sleep(25);
  await sleep(50);   // the lists re-read that opening a tab starts, and its re-render
  return dom;
}

// What the table shows, top to bottom, as row ids.
const shownIds = (win, c) => win.eval(`[...document.querySelectorAll('#${c.tbody} tr[data-row]')].map(tr => ${c.rows}[Number(tr.dataset.row)].id)`);
const idxOf = (win, c, id) => win.eval(`${c.rows}.findIndex(r => r.id === '${id}')`);
const rowEl = (win, c, id) => win.document.querySelector(`#${c.tbody} tr[data-row="${idxOf(win, c, id)}"]`);
const summaryRows = (win, c) => Number((/Rows\s*(\d+)/.exec(win.document.getElementById(c.summary).textContent) || [])[1]);
const delBtn = (win, c) => { const b = win.document.getElementById(c.del); return [Number((/Delete (\d+)/.exec(b.textContent) || [])[1]), b.disabled]; };
const exported = (win, c) => win.eval(`exportTabCfg('${c.tab}').shown.map(e => e.row.id)`);

async function main() {
  for (const c of TABS) {
    // A fresh page a tab: each one re-dates rows.
    const dom = await loadPage();
    const win = dom.window, doc = win.document;
    win.setYearFilter(c.tab, '2026');
    eq(`${c.tab}: loads clean`, win.__errors, []);

    console.log(`\n— ${c.tab}: re-dated from a script —`);
    eq('Year = 2026 shows the three 2026 rows, newest first', shownIds(win, c), c.ids);
    eq('…Rows and Delete agree with it', [summaryRows(win, c), delBtn(win, c)], [3, [3, false]]);
    win.eval(`${c.set}(${idxOf(win, c, c.ids[1])}, 'date', '2025-11-19')`);
    eq('re-dated to 2025: the row leaves the table at once', shownIds(win, c), [c.ids[0], c.ids[2]]);
    eq('…the summary\'s Rows drops', summaryRows(win, c), 2);
    eq('…the Delete button counts the same rows', delBtn(win, c), [2, false]);
    eq('…⇩ Download hands over what is on screen', exported(win, c), [c.ids[0], c.ids[2]]);
    eq('…saved on the row', win.eval(`${c.rows}[${idxOf(win, c, c.ids[1])}].date`), '2025-11-19');
    eq('…the Year filter is still 2026', [win.eval(`yearFilters['${c.tab}']`), doc.getElementById(c.tab + 'YearFilter').value], ['2026', '2026']);
    win.eval(`${c.set}(${idxOf(win, c, c.ids[1])}, 'date', '2026-11-17')`);
    eq('dated back inside 2026: on screen again, at its date\'s place', shownIds(win, c), [c.ids[0], c.ids[2], c.ids[1]]);
    eq('…and counted again', [summaryRows(win, c), delBtn(win, c)], [3, [3, false]]);
    // The filter menus are kept as they are. Rebuilt, the Year menu would
    // lose 2025 once its last row left it and snap back to this year — the
    // table would swap to 2026's rows under a 2025 edit. (Crushing rebuilds
    // its menus on a re-date, as it did before.)
    if (c.tab !== 'crushing') {
      win.setYearFilter(c.tab, '2025');
      eq('Year = 2025 shows its one row', shownIds(win, c), [c.old]);
      win.eval(`${c.set}(${idxOf(win, c, c.old)}, 'date', '2024-06-01')`);
      eq('…re-dated to 2024: the Year filter is still 2025, not reset for having no rows',
        [win.eval(`yearFilters['${c.tab}']`), doc.getElementById(c.tab + 'YearFilter').value], ['2025', '2025']);
      eq('…and the table is empty, and counted that way', [shownIds(win, c), summaryRows(win, c), delBtn(win, c)], [[], 0, [0, true]]);
      win.eval(`${c.set}(${idxOf(win, c, c.old)}, 'date', '2025-06-01')`);
      win.setYearFilter(c.tab, '2026');
    }

    console.log(`\n— ${c.tab}: re-dated in its date box —`);
    const top = rowEl(win, c, c.ids[0]);
    const box = top && top.querySelector('input[type="date"]');
    assert('the top row has a date box', !!box);
    if (box) {
      const id = c.ids[0];
      box.focus();
      box.value = '0002-11-20';   // what Chrome commits at the first digit of a typed year
      box.dispatchEvent(new win.Event('change', { bubbles: true }));
      await sleep(20);
      assert('while the box has focus the table holds still — the same box, still focused', box.isConnected && doc.activeElement === box);
      eq('…the row is still on screen', shownIds(win, c).includes(id), true);
      eq('…and the keystroke is saved', win.eval(`${c.rows}[${idxOf(win, c, id)}].date`), '0002-11-20');
      box.value = '2025-11-20';
      box.dispatchEvent(new win.Event('change', { bubbles: true }));
      await sleep(20);
      assert('…through the rest of the date too', box.isConnected && doc.activeElement === box);
      // The window losing focus blurs the box but leaves it the active element.
      box.dispatchEvent(new win.FocusEvent('blur'));
      await sleep(20);
      assert('the window losing focus is not the box letting go', box.isConnected);
      box.blur();
      await sleep(20);
      eq('once the box lets go, the row leaves the table', shownIds(win, c).includes(id), false);
      eq('…and the counts follow', [summaryRows(win, c), delBtn(win, c)], [2, [2, false]]);
    }

    console.log(`\n— ${c.tab}: edits that must not re-render —`);
    {
      const id = c.ids[2];
      const tr = rowEl(win, c, id);
      const i = idxOf(win, c, id);
      if (c.tab === 'sales') {
        win.eval(`updateSalesNumber(${i}, 'tons', '11')`);
        win.eval(`updateSalesCell(${i}, 'payment', 'Credit')`);
      } else if (c.tab === 'daily') {
        win.eval(`updateDailyNumber(${i}, 'hours', '9')`);
      } else {
        win.eval(`updateCrushNumber(${i}, 'hours', '9')`);
        win.eval(`updateCrushCell(${i}, 'comments', 'n')`);
      }
      assert('number keystrokes (and Payment / comments) leave the row element in place', !!tr && tr.isConnected);
    }

    eq(`${c.tab}: no uncaught script errors`, win.__errors, []);
    dom.window.close();
  }

  console.log('\n— sales: combobox picks —');
  {
    const dom = await loadPage();
    const win = dom.window, doc = win.document;
    const c = TABS[0];
    win.setYearFilter('sales', '2026');

    // Inside the filters: no re-render, and the tax cell follows the customer.
    const tr1 = rowEl(win, c, 's1');
    const i1 = idxOf(win, c, 's1');
    eq('s1 starts untaxed', doc.getElementById('sales-tax-' + i1).textContent, '—');
    win.eval(`cbDispatch('sales:${i1}', 'customer', 'Kunkle Excavating')`);
    assert('no filter set: picking a customer does not re-render', !!tr1 && tr1.isConnected);
    eq('…the tax cell follows the customer', doc.getElementById('sales-tax-' + i1).textContent, '$7.20');

    // Location = McGees Mills shows only s3, its only row.
    win.eval("msSet('location', 'sales').add('McGees Mills'); msApply('sales', 'location');");
    eq('Location = McGees Mills shows s3', shownIds(win, c), ['s3']);
    const i3 = idxOf(win, c, 's3');
    const input = doc.querySelector(`#salesTbody tr[data-row="${i3}"] .cb[data-field="location"] input`);
    input.focus();
    input.dispatchEvent(new win.FocusEvent('focus'));
    assert('…its Location combobox opens', !!input && !input.nextElementSibling.hidden);
    input.value = 'Homer City';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(200);   // past the combobox's own blur commit
    eq('picking Homer City takes s3 off the table', shownIds(win, c), []);
    eq('…saved on the row', win.eval(`salesRows[${i3}].locationName`), 'Homer City');
    eq('…Rows and Delete agree: none', [summaryRows(win, c), delBtn(win, c)], [0, [0, true]]);
    eq('…⇩ Download has nothing to hand over', [exported(win, c), doc.getElementById('salesExportBtn').disabled], [[], true]);
    eq('…no combobox menu left open', doc.querySelectorAll('.cb-menu:not([hidden])').length, 0);
    eq('…the Location filter is still McGees Mills — not dropped for having no rows', win.eval("[...msSet('location', 'sales')]"), ['McGees Mills']);
    assert('…and the table says nothing matches it', /McGees Mills/.test((doc.querySelector('#salesTbody .sales-empty') || {}).textContent || ''));

    // Customer and Product filters the same way.
    win.eval("msSet('location', 'sales').clear(); msApply('sales', 'location');");
    win.eval("msSet('customer', 'sales').add('Force Turf Solutions'); msApply('sales', 'customer');");
    eq('Customer = Force Turf Solutions', shownIds(win, c), ['s2', 's3']);
    win.eval(`cbDispatch('sales:${idxOf(win, c, 's2')}', 'customer', 'Kunkle Excavating')`);
    eq('…re-picking s2\'s customer takes it off', shownIds(win, c), ['s3']);
    win.eval("msSet('customer', 'sales').clear(); msApply('sales', 'customer');");
    win.eval("msSet('product', 'sales').add('2B'); msApply('sales', 'product');");
    win.eval(`cbDispatch('sales:${idxOf(win, c, 's1')}', 'product', '6-')`);
    eq('Product = 2B: re-picking s1\'s product takes it off', shownIds(win, c), ['s2', 's3']);
    eq('…and the counts follow', [summaryRows(win, c), delBtn(win, c)], [2, [2, false]]);
    const tr2 = rowEl(win, c, 's2');
    win.eval(`cbDispatch('sales:${idxOf(win, c, 's2')}', 'employee', 'Al Two')`);
    assert('an Employee pick cannot leave a filter: no re-render', !!tr2 && tr2.isConnected);

    eq('sales: no uncaught script errors', win.__errors, []);
    eq('no alerts', win.__alerts || [], []);
    dom.window.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
