#!/usr/bin/env node
'use strict';
/**
 * Newest first, on every list the office reads top-down.
 *
 * Run: node scripts/test-newest-first.js
 *
 * Reported as "the most recent submitted ones are somehow in the middle of the
 * stack rather than at the top on page 1" — on the Purchase Orders page, and in
 * a job's Daily Tracking. Both lists showed ARRAY order, and neither array was
 * ever chronological:
 *
 *  - purchase-orders.html loads each division's list one after another and
 *    reversed the lot, so only General's orders were newest first; the newest
 *    Turf order sat below every General, Kiewit and Paving order.
 *
 *  - Daily Tracking loads the last 90 days, then a backfill APPENDS every older
 *    row after them, and every add appends — so today's rows ended up where
 *    the two blocks meet.
 *
 * The fix sorts only what is drawn. The stored arrays keep their order (the
 * poll compares them, saves send them, and data-i indexes p.dailyRows), so the
 * helpers must return copies and the handlers must keep reading real indices.
 *
 * Runs each page's OWN functions, lifted with scripts/lib/fn-source.js.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');
const { fnSource, requireFn } = require('./lib/fn-source');

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

let failed = 0, passed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail) console.error('      ' + String(detail).slice(0, 400));
};

const DIVISION_PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const PO_PAGES = DIVISION_PAGES.concat(['purchase-orders.html']);
const SRC = Object.fromEntries(PO_PAGES.map(f => [f, read(f)]));

// uid() as every page mints it, at a chosen moment.
const uidAt = (iso, tail) => Date.parse(iso).toString(36) + (tail || 'k3j9x2q1ab');

// ── 1. The copies agree ────────────────────────────────────────────────────
console.log('\n[the helpers are the same in every page]');
{
  for (const name of ['_poCreatedMs', '_poNewestFirst']) {
    const copies = PO_PAGES.map(f => fnSource(SRC[f], name));
    assert(`${name} is in all four PO pages`, copies.every(Boolean),
      PO_PAGES.filter((f, i) => !copies[i]).join(', '));
    assert(`${name} is identical in all four`, copies.every(c => c === copies[0]));
  }
  for (const name of ['_dailySortDate', '_dailyDisplayOrder', '_dailyShowNewest', 'renderDailyTable']) {
    const copies = DIVISION_PAGES.map(f => fnSource(SRC[f], name));
    assert(`${name} is in all three division pages`, copies.every(Boolean),
      DIVISION_PAGES.filter((f, i) => !copies[i]).join(', '));
    assert(`${name} is identical in all three`, copies.every(c => c === copies[0]));
  }
  // uid() is what the PO sort decodes. If a page ever mints ids differently,
  // its orders stop sorting by time.
  const uids = PO_PAGES.map(f => fnSource(SRC[f], 'uid'));
  assert('every PO page mints ids with the same uid()',
    uids.every(u => u && u.includes('Date.now().toString(36)') && u === uids[0]));
}

// ── 2. Purchase-order order ────────────────────────────────────────────────
console.log('\n[purchase orders: newest raised first]');
{
  const ctx = vm.createContext({});
  ['_poCreatedMs', '_poNewestFirst'].forEach(n =>
    vm.runInContext(requireFn(SRC['purchase-orders.html'], n, 'purchase-orders.html'), ctx));
  const newestFirst = list => vm.runInContext('_poNewestFirst', ctx)(list);
  const createdMs   = po   => vm.runInContext('_poCreatedMs', ctx)(po);

  const t = uidAt('2026-09-01T09:00:00Z');
  assert('a uid decodes to the moment it was minted', createdMs({ id: t }) === Date.parse('2026-09-01T09:00:00Z'));
  assert('a uid minted right now decodes',
    Math.abs(createdMs({ id: Date.now().toString(36) + 'abcdefghij' }) - Date.now()) < 5000);

  // The reported bug, as loadPurchaseOrders builds the list: turf, paving,
  // kiewit, then general — each oldest first. The newest order of all is Turf.
  const order = (id, div, date) => ({ id, _division: div, date_created: date || '' });
  const list = [
    order(uidAt('2026-09-01T08:00:00Z'), 'turf'),
    order(uidAt('2026-09-29T15:00:00Z'), 'turf'),      // newest of everything
    order(uidAt('2026-09-10T08:00:00Z'), 'paving'),
    order(uidAt('2026-09-28T08:00:00Z'), 'paving'),
    order(uidAt('2026-09-05T08:00:00Z'), 'kiewit'),
    order(uidAt('2026-09-02T08:00:00Z'), 'purchase_orders'),
    order(uidAt('2026-09-20T08:00:00Z'), 'purchase_orders'),
  ];
  const before = JSON.stringify(list);
  const sorted = newestFirst(list);
  assert('the newest order is first, whatever list it is stored in',
    sorted[0] === list[1], sorted[0]._division);
  assert('every order follows in the order it was raised',
    sorted.map(po => list.indexOf(po)).join() === '1,3,6,2,4,5,0');
  assert('the old reverse() put General on top instead',
    list.slice().reverse()[0]._division === 'purchase_orders');
  assert('the stored list is not reordered', JSON.stringify(list) === before);
  assert('a copy is returned', sorted !== list);

  // An order moved from General into a job division keeps its id, so it keeps
  // its place — it no longer jumps to the top of the division it moved into.
  const moved = order(uidAt('2026-08-01T08:00:00Z'), 'turf');
  const tab = [order(uidAt('2026-09-01T08:00:00Z'), 'turf'), order(uidAt('2026-09-02T08:00:00Z'), 'turf'), moved];
  assert('an order moved in (appended) keeps its own place',
    newestFirst(tab)[2] === moved && newestFirst(tab)[0] === tab[1]);

  // Ids that do not decode: a UUID, a short test id, a decimal timestamp.
  // They fall back to the Date field, then to list position.
  const uuid = { id: '550e8400-e29b-41d4-a716-446655440000', date_created: '2026-09-15' };
  assert('a UUID does not decode as a time', createdMs(uuid) === Date.parse('2026-09-15T12:00:00'));
  assert('a decimal timestamp id does not decode as a time',
    createdMs({ id: '1727000000000', date_created: '' }) === -Infinity);
  assert('a short id falls back to the Date field',
    createdMs({ id: 'mine', date_created: '2026-09-15' }) === Date.parse('2026-09-15T12:00:00'));
  assert('an id minted in the future (a fast clock) does not decode',
    createdMs({ id: uidAt(new Date(Date.now() + 3 * 864e5).toISOString()), date_created: '' }) === -Infinity);

  const mixed = [
    { id: 'aa', date_created: '' },                     // no time at all
    { id: uidAt('2026-09-10T08:00:00Z') },
    { id: 'legacy', date_created: '2026-09-20' },       // falls back to its date
    { id: 'bb', date_created: '' },                     // no time, later in the list
  ];
  const m = newestFirst(mixed).map(po => po.id);
  assert('a dated fallback sorts among the timed orders', m[0] === 'legacy');
  assert('orders with no time at all go last, later-in-list first',
    m[2] === 'bb' && m[3] === 'aa', m.join());

  // Wiring.
  const page = SRC['purchase-orders.html'];
  assert('the Purchase Orders page draws newest first',
    /function render\(\) \{[\s\S]{0,500}const all = _poNewestFirst\(visiblePOs\(\)\);/.test(page));
  assert('and no longer reverses the combined list', !/visiblePOs\(\)\.slice\(\)\.reverse\(\)/.test(page));
  for (const f of DIVISION_PAGES) {
    assert(`${f}: the PO tab draws newest first`,
      /const allFilteredPOs = _poNewestFirst\(applyPOFilters\(\)\);/.test(SRC[f]));
    assert(`${f}: + New PO goes back to page 1`,
      /function addPO\(\) \{[\s\S]{0,900}poPage = 0;[^\n]*\n\s*renderPOTab\(\);\n\}/.test(SRC[f]));
  }
}

// ── 3. Daily Tracking order ────────────────────────────────────────────────
console.log('\n[daily tracking: newest work date first]');
{
  const src = SRC['tracker.html'];
  const ctx = vm.createContext({});
  ['_localDateStr', '_dailySortDate', '_dailyDisplayOrder'].forEach(n =>
    vm.runInContext(requireFn(src, n, 'tracker.html'), ctx));
  const order = (all, rows) => vm.runInContext('_dailyDisplayOrder', ctx)(all, rows || all);
  const today = vm.runInContext('_localDateStr()', ctx);

  // What a load really leaves: the last 90 days oldest first, then the
  // backfill's older rows appended, then a row added this session.
  const r = (id, date) => ({ id, date });
  const rows = [
    r('a', '2026-08-10'), r('b', '2026-09-01'), r('c', '2026-09-20'),
    r('d1', '2026-09-28'), r('d2', '2026-09-28'),          // same day, d2 entered later
    r('old1', '2026-03-01'), r('old2', '2026-05-15'),       // backfill, appended
    r('new', today),                                        // + Add Row, appended
  ];
  const before = rows.map(x => x.id).join();
  const drawn = order(rows);
  assert('today\'s new row is drawn first', drawn[0].row.id === 'new', drawn.map(x => x.row.id).join());
  assert('then every row by work date, newest first',
    drawn.map(x => x.row.id).join() === 'new,d2,d1,c,b,a,old2,old1', drawn.map(x => x.row.id).join());
  assert('within a date, the later entry is first', drawn[1].row.id === 'd2' && drawn[2].row.id === 'd1');
  assert('each drawn row carries its real index in p.dailyRows',
    drawn.every(x => rows[x.ai] === x.row));
  assert('p.dailyRows itself is not reordered', rows.map(x => x.id).join() === before);

  // A column filter hands in a subset. The indices must still be the real ones.
  const subset = [rows[1], rows[5], rows[3]];
  const f = order(rows, subset);
  assert('a filtered subset is sorted', f.map(x => x.row.id).join() === 'd1,b,old1');
  assert('and keeps its real indices', f.map(x => x.ai).join() === '3,1,5');

  // Copy row splices the copy in right after its source: it is the later
  // entry on that date, so it is drawn directly above the source.
  const withCopy = rows.slice(0, 4).concat([r('c-copy', '2026-09-28')], rows.slice(4));
  const wc = order(withCopy).map(x => x.row.id);
  assert('a copied row is drawn right beside its source',
    Math.abs(wc.indexOf('c-copy') - wc.indexOf('d1')) === 1, wc.join());

  const sd = (d) => vm.runInContext('_dailySortDate', ctx)(d, '2026-09-29');
  assert('an imported M/D/YYYY date sorts as its date', sd('9/3/2026') === '2026-09-03');
  assert('and M/D/YY', sd('12/31/25') === '2025-12-31');
  assert('an ISO date with a time keeps its date', sd('2026-09-03T00:00:00.000Z') === '2026-09-03');
  assert('a blank date sorts as today (what the server saves it as)', sd('') === '2026-09-29');
  assert('an unreadable date sorts as today, not above every real one', sd('Sept 3') === '2026-09-29');
}

// ── 4. renderDailyTable, drawn for real ────────────────────────────────────
console.log('\n[renderDailyTable draws newest first, and data-i stays the real index]');
for (const file of DIVISION_PAGES) {
  const src = SRC[file];
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="daily-table-wrap" style="overflow:auto"><table><tbody id="daily-tbody-p1"></tbody></table></div>
  </body></html>`);
  const w = dom.window;
  const proj = {
    id: 'p1', assigned_employees: [], assigned_equipment: [],
    dailyRows: [
      { id: 'r0', date: '2026-09-01', quantity: '1' },
      { id: 'r1', date: '2026-09-25', quantity: '2' },
      { id: 'r2', date: '2026-05-01', quantity: '3' },     // backfilled, appended
      { id: 'r3', date: '2026-09-25', quantity: '4', timesheet_entry_id: '7' },  // same day, later
    ],
  };
  const ctx = vm.createContext({
    window: w, document: w.document, console, Map, Set,
    getProj: () => proj, dailyFilters: {}, perm: { canEdit: true },
    lists: { field_types: [], employees: [], equipment: [], job_classes: [], suppliers: [] },
    HAUL_FIELD_TYPES: [], INJECTED_EDITABLE_FIELDS: new Set(['cost_code', 'sub_code', 'job_class', 'quantity']),
    renderDailyTotals() {}, _updateFilterButtons() {},
    calcDaily: () => ({ labor_cost: 0, equip_total: 0, total_cost: 0 }),
    fmt: n => String(n), esc: s => String(s == null ? '' : s),
    makeSelect: () => '<select></select>', makePOSelect: () => '<select></select>',
    cbHtml: () => '<input>',
  });
  ['_localDateStr', '_dailySortDate', '_dailyDisplayOrder', '_dailyShowNewest', 'renderDailyTable']
    .forEach(n => vm.runInContext(requireFn(src, n, file), ctx));

  vm.runInContext("renderDailyTable('p1')", ctx);
  const tbody = w.document.getElementById('daily-tbody-p1');
  const drawn = [...tbody.children].map(tr => {
    const el = tr.querySelector('input[data-f="date"]');
    return el ? el.dataset.i + ':' + el.value : '?';
  });
  assert(`${file}: rows are drawn newest work date first, later entry first`,
    drawn.join() === '3:2026-09-25,1:2026-09-25,0:2026-09-01,2:2026-05-01', drawn.join());
  assert(`${file}: every data-i still names its own row`,
    [...tbody.querySelectorAll('input[data-f="date"]')].every(el => proj.dailyRows[+el.dataset.i].date === el.value));
  assert(`${file}: p.dailyRows is untouched`, proj.dailyRows.map(x => x.id).join() === 'r0,r1,r2,r3');

  const wrap = w.document.querySelector('.daily-table-wrap');
  wrap.scrollTop = 500;
  vm.runInContext("_dailyShowNewest('p1')", ctx);
  assert(`${file}: after an add the table scrolls back to the top`, wrap.scrollTop === 0);

  assert(`${file}: + Add Row brings the new row into view`,
    /function addDailyRow\(projId\) \{[\s\S]{0,300}renderDailyTable\(projId\);\n\s*_dailyShowNewest\(projId\);\n\}/.test(src));
  assert(`${file}: so does the mass add`,
    /function massAddDailyRows\(projId\) \{[\s\S]{0,900}renderDailyTable\(projId\);\n\s*_dailyShowNewest\(projId\);\n\}/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
