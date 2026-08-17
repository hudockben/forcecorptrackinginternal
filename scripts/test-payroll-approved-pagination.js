#!/usr/bin/env node
'use strict';
/**
 * Approved-tab pagination test for payroll.html.
 *
 * Run: node scripts/test-payroll-approved-pagination.js
 *
 * Two layers:
 *   1. Structural — greps payroll.html for the pager markup, the CSS block
 *      and the print rule, so a refactor that drops one of them is caught.
 *   2. Behavioural — evaluates the whole inline <script> inside a sandboxed
 *      vm with a mock DOM / localStorage / fetch, then drives renderRows()
 *      over a synthetic entry set and asserts on:
 *        - the Approved tab renders one page, not the whole list
 *        - the "Showing X–Y of Z" caption and page-count arithmetic
 *        - first/prev/next/last disabled states at the ends
 *        - the page window ("1 … 4 5 6 … 20") builder
 *        - clamping when rows disappear under the current page
 *        - Pending is NOT paginated (bulk approve still sees everything)
 *        - "All" renders the whole list
 *        - page size persists to localStorage
 *        - a filter change resets to page 1, a row edit does not
 *        - leaving the Approved tab hides both pager bars
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`);
  }
}

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'payroll.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// 1) STRUCTURAL CHECKS
// ─────────────────────────────────────────────────────────────────────
console.log('\n[structural — payroll.html]');
assert('pagerTop container exists',        /<div class="pager" id="pagerTop">/.test(HTML));
assert('pagerBottom container exists',     /<div class="pager" id="pagerBottom">/.test(HTML));
assert('.pager CSS block exists',          /\n\s*\.pager \{[\s\S]*?\}/.test(HTML));
assert('.pager.open flips to flex',        /\.pager\.open \{ display: flex; \}/.test(HTML));
assert('print CSS hides the pager',        /\.pager, \.modal-backdrop, \.btn-print \{ display: none !important; \}/.test(HTML));
assert('page sizes include an All option', /const APPROVED_PAGE_SIZES\s*=\s*\[25, 50, 100, 250, 0\]/.test(HTML));
assert('page size persists per browser',   /APPROVED_PAGE_SIZE_KEY\s*=\s*'payroll\.approvedPageSize'/.test(HTML));
assert('switchTab hides the pagers',       /function switchTab[\s\S]{0,2600}?hidePagers\(\)/.test(HTML));
assert('renderRows slices only Approved',  /currentTab === 'approved' && approvedPageSize > 0/.test(HTML));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL — run the page's script against a mock DOM
// ─────────────────────────────────────────────────────────────────────
const scriptMatch = HTML.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error('could not find the inline <script> in payroll.html');
  process.exit(1);
}

const scrolledInto = [];   // ids passed to scrollIntoView, newest last

function makeElement(id) {
  const classes = new Set();
  return {
    id,
    value: '',
    innerHTML: '',
    textContent: '',
    hidden: false,
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      add:      (c) => classes.add(c),
      remove:   (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle:   (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
                             else if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    scrollIntoView() { scrolledInto.push(id); },
    focus() {},
    querySelector()    { return null; },
    querySelectorAll() { return []; },
    appendChild(c) { return c; },
    remove() {},
  };
}

const els = new Map();
function el(id) {
  if (!els.has(id)) els.set(id, makeElement(id));
  return els.get(id);
}

const storage = new Map([
  ['fct_token', 'test-token'],
  ['fct_user', JSON.stringify({ username: 'tester', isPlatformAdmin: true, allowedDivisions: ['payroll'] })],
]);

const tableWrap = makeElement('table-wrap');
// Declared ahead of the sandbox: init() fires a request while the page script
// is still loading, so the mock fetch must not close over a dead binding.
let mockEntries = [];
let mockFetchOk = true;
let fetchQueue  = null;
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  document: {
    getElementById: el,
    querySelector: (sel) => (sel === '.table-wrap' ? tableWrap : null),
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeElement('body'),
  },
  window: { location: { replace() {}, href: '' }, addEventListener() {} },
  // init() defers the first fetch through setTimeout; swallow it so the test
  // drives renderRows() directly instead of racing a mock request.
  setTimeout: () => 0,
  clearTimeout: () => {},
  // Whatever the current test has loaded — lets applyFilters() (the refetch
  // that a row edit and "Refresh Rates" both trigger) round-trip realistically.
  fetch: async () => {
    // fetchQueue, when set, scripts one reply per request in call order — with
    // a real delay, so an earlier request can be made to answer LAST.
    if (fetchQueue && fetchQueue.length) {
      const spec = fetchQueue.shift();
      if (spec.delayMs) await new Promise(r => setTimeout(r, spec.delayMs));
      return spec.ok === false
        ? { ok: false, status: 500, json: async () => ({ error: spec.error || 'Database unavailable' }) }
        : { ok: true,  status: 200, json: async () => ({ entries: spec.entries || [] }) };
    }
    return mockFetchOk
      ? { ok: true,  status: 200, json: async () => ({ entries: mockEntries }) }
      : { ok: false, status: 500, json: async () => ({ error: 'Database unavailable' }) };
  },
  alert() {},
  confirm: () => true,
  Date, Math, JSON, Number, String, Array, Object, Set, Map, Boolean, Error, isNaN, parseInt, parseFloat,
  URLSearchParams,
};
sandbox.globalThis = sandbox;
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(scriptMatch[1], ctx, { filename: 'payroll-inline.js' });
} catch (err) {
  console.error('\n  ✗ inline script threw while loading: ' + err.message);
  process.exit(1);
}
// Top-level `let` bindings live in the context's lexical scope, not on the
// global object — reach them by running snippets in the same context.
const run = (src) => vm.runInContext(src, ctx);

function makeEntries(n, status) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${status}-${i + 1}`,
    username: `emp${i % 7}`,
    work_date: '2026-08-14',
    entry_type: 'daily',
    division: 'quarry',
    job_label: 'Daily — Homer City',
    status,
    computed_hours: 9.5,
    travel_hours: 0,
    start_time: '06:30',
    end_time: '16:00',
    supervisor_name: 'travissteve',
    approved_at: '2026-08-17T11:11:00Z',
    submitted_at: '2026-08-14T18:57:00Z',
    approved_by_name: 'travissteve',
    lunch_break: false,
    operated_equipment: true,
    prevailing_wage: null,
    // Distinct jobs so the hours-mismatch detector stays quiet and doesn't
    // muddy the row counts with its banner.
    job_id: String(i + 1),
  }));
}

function loadEntries(entries) {
  mockEntries = entries;
  run(`allEntries = ${JSON.stringify(entries)}; filtered = allEntries.slice();`);
}

function rowCount() {
  return (el('rowsBody').innerHTML.match(/<tr\b/g) || []).length;
}
const pagerText = (id) => el(id).innerHTML.replace(/\s+/g, ' ');
const pagerOpen = (id) => el(id).classList.contains('open');

// switchTab() fires an un-awaited applyFilters(). Left in flight it resolves
// during a later test and re-renders on top of it, so drain the queue first.
const flush = () => new Promise(r => setImmediate(r));

// Wrapped so the one refetch assertion below can await applyFilters().
(async function behavioural() {

// ── Approved tab, 137 entries, default page size 50 ──
console.log('\n[behavioural — Approved tab paging]');
run(`currentTab = 'approved'; approvedPage = 1; approvedPageSize = 50;`);
loadEntries(makeEntries(137, 'approved'));
run('renderRows()');

assert('page 1 renders 50 of 137 rows',        rowCount() === 50, `got ${rowCount()}`);
assert('bottom pager is shown',                pagerOpen('pagerBottom'));
assert('top pager is shown when >1 page',      pagerOpen('pagerTop'));
assert('caption reads "Showing 1–50 of 137"',
  /Showing <strong>1&ndash;50<\/strong> of <strong>137<\/strong> approved entries/.test(pagerText('pagerBottom')),
  pagerText('pagerBottom').slice(0, 160));
assert('caption reads "Page 1 of 3"',
  /Page <strong>1<\/strong> of <strong>3<\/strong>/.test(pagerText('pagerBottom')));
assert('Prev is disabled on page 1',
  /title="Previous page" disabled/.test(pagerText('pagerBottom')));
assert('Next is live on page 1',
  /title="Next page"\s+onclick="gotoApprovedPage\(2\)"/.test(pagerText('pagerBottom')));
assert('current page button is marked',
  /class="pager-btn current" data-pager-key="page-1" aria-current="page"[^>]*>1</.test(pagerText('pagerBottom')),
  pagerText('pagerBottom').slice(0, 400));

// ── Last page ──
run('gotoApprovedPage(3)');
assert('page 3 renders the 37-row remainder',  rowCount() === 37, `got ${rowCount()}`);
assert('caption reads "Showing 101–137 of 137"',
  /Showing <strong>101&ndash;137<\/strong> of <strong>137<\/strong>/.test(pagerText('pagerBottom')),
  pagerText('pagerBottom').slice(0, 160));
assert('Next is disabled on the last page',    /title="Next page" disabled/.test(pagerText('pagerBottom')));
assert('First is live on the last page',       /title="First page"\s+onclick/.test(pagerText('pagerBottom')));

// The rows on page 3 really are the tail of the list, not a repeat of page 1.
assert('page 3 holds entries 101-137',
  el('rowsBody').innerHTML.includes('approved-101') &&
  el('rowsBody').innerHTML.includes('approved-137') &&
  !el('rowsBody').innerHTML.includes('approved-1"'),
  'page 3 rows are not the expected slice');

// ── Out-of-range requests clamp ──
run('gotoApprovedPage(99)');
assert('a page past the end clamps to the last', run('approvedPage') === 3, `got ${run('approvedPage')}`);
run('gotoApprovedPage(-4)');
assert('a page below 1 clamps to the first',     run('approvedPage') === 1, `got ${run('approvedPage')}`);

// ── Rows disappearing under the current page ──
run(`approvedPage = 3; renderRows();`);
assert('sitting on page 3 of 3', run('approvedPage') === 3);
// Un-approve / delete shrinks the list to 60 rows — page 3 no longer exists.
loadEntries(makeEntries(60, 'approved'));
run('renderRows()');
assert('clamps to the new last page when rows vanish', run('approvedPage') === 2, `got ${run('approvedPage')}`);
assert('renders the 10-row remainder after clamping',  rowCount() === 10, `got ${rowCount()}`);

// ── A row edit holds your place; a filter change does not ──
console.log('\n[behavioural — page retention]');
loadEntries(makeEntries(137, 'approved'));
run(`approvedPage = 2; renderRows();`);
assert('page survives a plain re-render (approve/delete/edit)', run('approvedPage') === 2);
// filterAndRender() re-reads the filter inputs; changing one resets to page 1.
el('flt-from').value = '2026-08-01';
el('flt-to').value   = '2026-08-17';
el('flt-division').value = '';
el('flt-user').value = '';
el('flt-supervisor').value = '';
run('filterAndRender()');
run(`approvedPage = 2; renderRows();`);
run('filterAndRender()');
assert('page survives a re-render with unchanged filters', run('approvedPage') === 2, `got ${run('approvedPage')}`);
el('flt-user').value = 'boringjamey';
run('filterAndRender()');
assert('page resets to 1 when a filter changes', run('approvedPage') === 1, `got ${run('approvedPage')}`);
el('flt-user').value = '';
run('filterAndRender()');

// A row edit and "Refresh Rates" both refetch through applyFilters(). The
// filters are untouched, so the admin lands back on the page they were on.
run(`approvedPage = 3; renderRows();`);
await run('applyFilters()');
assert('page survives the refetch after an edit', run('approvedPage') === 3, `got ${run('approvedPage')}`);

// ── Pending stays whole ──
console.log('\n[behavioural — Pending is not paginated]');
run(`currentTab = 'pending'; approvedPage = 1;`);
loadEntries(makeEntries(137, 'submitted'));
run('renderRows()');
assert('Pending renders all 137 rows',      rowCount() === 137, `got ${rowCount()}`);
assert('Pending hides the bottom pager',    !pagerOpen('pagerBottom'));
assert('Pending hides the top pager',       !pagerOpen('pagerTop'));

// ── "All" page size ──
console.log('\n[behavioural — page size]');
run(`currentTab = 'approved';`);
loadEntries(makeEntries(137, 'approved'));
run('setApprovedPageSize(0)');
assert('"All" renders every approved row',  rowCount() === 137, `got ${rowCount()}`);
assert('"All" keeps the bottom pager (to switch back)', pagerOpen('pagerBottom'));
assert('"All" drops the redundant top pager',           !pagerOpen('pagerTop'));
assert('"All" is selected in the dropdown',
  /<option value="0" selected>All<\/option>/.test(pagerText('pagerBottom')));

run('setApprovedPageSize(100)');
assert('switching size re-pages to 100 rows', rowCount() === 100, `got ${rowCount()}`);
assert('switching size returns to page 1',    run('approvedPage') === 1);
assert('page size is written to localStorage', storage.get('payroll.approvedPageSize') === '100',
  `got ${storage.get('payroll.approvedPageSize')}`);
run('setApprovedPageSize(999)');
assert('an unknown size falls back to 50',    run('approvedPageSize') === 50, `got ${run('approvedPageSize')}`);

// readApprovedPageSize() runs at load, before any preference exists. Number(null)
// is 0 — a legal size here ("All") — so the missing-key case has to be caught
// before the conversion or a first-time visitor gets the unpaged list.
storage.delete('payroll.approvedPageSize');
assert('no stored preference defaults to 50',  run('readApprovedPageSize()') === 50, `got ${run('readApprovedPageSize()')}`);
storage.set('payroll.approvedPageSize', '');
assert('an empty stored value defaults to 50', run('readApprovedPageSize()') === 50, `got ${run('readApprovedPageSize()')}`);
storage.set('payroll.approvedPageSize', 'banana');
assert('a junk stored value defaults to 50',   run('readApprovedPageSize()') === 50, `got ${run('readApprovedPageSize()')}`);
storage.set('payroll.approvedPageSize', '0');
assert('a stored "All" is honoured',           run('readApprovedPageSize()') === 0, `got ${run('readApprovedPageSize()')}`);
storage.set('payroll.approvedPageSize', '250');
assert('a stored size is honoured',            run('readApprovedPageSize()') === 250, `got ${run('readApprovedPageSize()')}`);
storage.delete('payroll.approvedPageSize');

// ── Empty Approved tab ──
console.log('\n[behavioural — edge cases]');
run(`approvedPageSize = 50; approvedPage = 1;`);
loadEntries([]);
run('renderRows()');
assert('empty Approved tab hides both pagers', !pagerOpen('pagerTop') && !pagerOpen('pagerBottom'));
assert('empty Approved tab keeps the empty-state row',
  /No approved entries in this range yet/.test(el('rowsBody').innerHTML));

// Exactly one full page — no nav, but the size selector stays reachable.
loadEntries(makeEntries(50, 'approved'));
run('renderRows()');
assert('an exact single page renders 50 rows',   rowCount() === 50, `got ${rowCount()}`);
assert('an exact single page shows no page nav', !/pager-pages/.test(pagerText('pagerBottom')));
assert('an exact single page hides the top bar', !pagerOpen('pagerTop'));

// Leaving the Approved tab clears the bars even though renderRows never runs
// for Reports / Audit Log / Analytics.
loadEntries(makeEntries(137, 'approved'));
run('renderRows()');
assert('pagers are open before leaving the tab', pagerOpen('pagerBottom'));
run(`switchTab('reports')`);
assert('switching to Reports hides the bottom pager', !pagerOpen('pagerBottom'));
assert('switching to Reports hides the top pager',    !pagerOpen('pagerTop'));
await flush();   // let switchTab's refetch land before the next section
assert('they stay hidden once the refetch lands',     !pagerOpen('pagerBottom') && !pagerOpen('pagerTop'));

// ── A failed refetch must not leave a live pager over the error ──
// Otherwise the bar still counts the previous result set, and clicking a page
// button re-renders those stale rows straight over the error message — payroll
// would be reading pre-failure data with nothing on screen saying so.
console.log('\n[behavioural — failed refetch]');
run(`currentTab = 'approved'; approvedPageSize = 50;`);
loadEntries(makeEntries(137, 'approved'));
run('renderRows()');
assert('pager is up before the failure', pagerOpen('pagerBottom'));
mockFetchOk = false;
await run('applyFilters()');
mockFetchOk = true;
assert('the failure notice is shown',       /Couldn't load time entries — Database unavailable/.test(el('rowsBody').innerHTML),
  el('rowsBody').innerHTML.slice(0, 120));
assert('bottom pager is pulled down',       !pagerOpen('pagerBottom'));
assert('top pager is pulled down',          !pagerOpen('pagerTop'));
assert('no stale page buttons remain',      el('pagerBottom').innerHTML === '' && el('pagerTop').innerHTML === '');

// ── A failed load must drop the rows it failed to refresh ──
// The filter boxes re-render straight from allEntries without refetching, so
// rows kept after a failure are one keystroke away from being drawn back over
// the error as though they were current.
console.log('\n[behavioural — failed load drops stale rows]');
loadEntries(makeEntries(137, 'approved'));
run('renderRows()');
mockFetchOk = false;
await run('applyFilters()');
mockFetchOk = true;
assert('the failed load clears allEntries', run('allEntries.length') === 0, `got ${run('allEntries.length')}`);
assert('the failed load clears filtered',   run('filtered.length')   === 0, `got ${run('filtered.length')}`);
assert('the notice names the failure',
  /Couldn't load time entries — Database unavailable/.test(el('rowsBody').innerHTML), el('rowsBody').innerHTML.slice(0, 140));
assert('the notice offers a retry',         /onclick="applyFilters\(\)"/.test(el('rowsBody').innerHTML));
assert('stats are blanked, not zeroed',     el('stat-approved').textContent === '—', el('stat-approved').textContent);
assert('tab badges are blanked too',
  el('tab-approved-count').textContent === '—' && el('tab-pending-count').textContent === '—',
  `pending=${el('tab-pending-count').textContent} approved=${el('tab-approved-count').textContent}`);
// The bug: typing in the Employee box redrew the pre-failure rows.
el('flt-user').value = 'emp1';
run('filterAndRender()');
assert('filtering cannot resurrect the dropped rows', rowCount() === 1, `got ${rowCount()} rows`);
assert('the failure notice survives filtering',
  /Couldn't load time entries/.test(el('rowsBody').innerHTML), el('rowsBody').innerHTML.slice(0, 120));
assert('pagers stay down through filtering', !pagerOpen('pagerTop') && !pagerOpen('pagerBottom'));
// Reports and Analytics draw from the same rows, so they must not show the
// last good render as if it were current either.
assert('Reports shows the failure too',   /Couldn't load time entries/.test(el('reportWrap').innerHTML));
assert('Analytics shows the failure too', /Couldn't load time entries/.test(el('analyticsWrap').innerHTML));
// A good load clears the error state.
el('flt-user').value = '';
loadEntries(makeEntries(137, 'approved'));
await run('applyFilters()');
assert('a successful reload recovers',     run('entriesLoadError') === null && rowCount() === 50, `got ${rowCount()} rows`);

// ── Only the newest request may write the result ──
// Requests are never cancelled, so a slow reply for an old date range can land
// after a fast reply for a new one and leave the grid contradicting the filters.
console.log('\n[behavioural — out-of-order loads]');
const tag = (n, name) => makeEntries(n, 'approved').map(e => ({ ...e, username: name }));
fetchQueue = [
  { entries: tag(60, 'OLDRANGE'), delayMs: 80 },   // requested first, answers last
  { entries: tag(5,  'NEWRANGE'), delayMs: 0  },   // requested second, answers first
];
await Promise.all([run('applyFilters()'), run('applyFilters()')]);
await flush();
assert('the newest response wins', run('allEntries.length') === 5, `got ${run('allEntries.length')} entries`);
assert('the stale range never lands',
  run(`allEntries.every(e => e.username === 'NEWRANGE')`), run('allEntries[0] && allEntries[0].username'));

// A stale FAILURE must not throw an error over a newer good load either.
fetchQueue = [
  { ok: false, delayMs: 80 },                      // requested first, fails last
  { entries: tag(20, 'NEWRANGE'), delayMs: 0 },    // requested second, succeeds first
];
await Promise.all([run('applyFilters()'), run('applyFilters()')]);
await flush();
assert('a stale failure cannot blank a newer good load',
  run('entriesLoadError') === null, `entriesLoadError = ${JSON.stringify(run('entriesLoadError'))}`);
assert('the newer rows survive the stale failure', run('allEntries.length') === 20, `got ${run('allEntries.length')}`);
fetchQueue = null;
loadEntries(makeEntries(137, 'approved'));
run(`approvedPage = 1;`);
run('renderRows()');

// ── Paging scrolls to the pager, not past it ──
// Anchoring on the table puts the top bar just off-screen, so the button you
// just clicked is gone when you go to click it again.
console.log('\n[behavioural — scroll anchor]');
loadEntries(makeEntries(137, 'approved'));
run('renderRows()');
scrolledInto.length = 0;
run('gotoApprovedPage(2)');
assert('paging anchors on the top pager', scrolledInto[scrolledInto.length - 1] === 'pagerTop',
  `scrolled to ${scrolledInto[scrolledInto.length - 1]}`);
// With one page there is no top bar, so the table is the only anchor left.
run('setApprovedPageSize(0)');
scrolledInto.length = 0;
run('gotoApprovedPage(1)');
assert('falls back to the table when no top bar', scrolledInto[scrolledInto.length - 1] === 'table-wrap',
  `scrolled to ${scrolledInto[scrolledInto.length - 1]}`);
run('setApprovedPageSize(50)');

// ── Focus survives the redraw ──
// Every control needs a stable key, because the redraw destroys the button
// under the cursor and focus would otherwise drop to <body> each page turn.
console.log('\n[behavioural — keyboard focus]');
run('renderRows()');
const bar = pagerText('pagerBottom');
['first', 'prev', 'next', 'last', 'size', 'page-1'].forEach(k =>
  assert(`control "${k}" carries a focus key`, bar.includes(`data-pager-key="${k}"`)));
assert('restorePagerFocus is wired into the redraw',
  /if \(focusedBar && focusedKey\) restorePagerFocus\(focusedBar\.id, focusedKey\)/.test(HTML));

// ── Page-window builder ──
console.log('\n[behavioural — page window]');
const win = (cur, count) => JSON.stringify(run(`pagerPageList(${cur}, ${count})`));
assert('3 pages list every page',        win(1, 3)   === JSON.stringify([1, 2, 3]), win(1, 3));
assert('7 pages list every page',        win(4, 7)   === JSON.stringify([1, 2, 3, 4, 5, 6, 7]), win(4, 7));
assert('middle of 20 windows with gaps', win(10, 20) === JSON.stringify([1, '…', 9, 10, 11, '…', 20]), win(10, 20));
assert('head of 20 keeps 1-4 solid',     win(2, 20)  === JSON.stringify([1, 2, 3, 4, '…', 20]), win(2, 20));
assert('tail of 20 keeps the last runs', win(19, 20) === JSON.stringify([1, '…', 17, 18, 19, 20]), win(19, 20));

// ── 70-entries-a-day reality check ──
console.log('\n[behavioural — 70 entries/day over a two-week range]');
run(`currentTab = 'approved'; approvedPage = 1; approvedPageSize = 50;`);
loadEntries(makeEntries(70 * 14, 'approved'));
run('renderRows()');
assert('980 approved entries page into 20 pages',
  /Page <strong>1<\/strong> of <strong>20<\/strong>/.test(pagerText('pagerBottom')), pagerText('pagerBottom').slice(0, 200));
assert('only one page of DOM is built',  rowCount() === 50, `got ${rowCount()}`);
run('gotoApprovedPage(20)');
assert('the final page renders its 30 rows', rowCount() === 30, `got ${rowCount()}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

})().catch(err => {
  console.error('\n  ✗ test harness threw: ' + err.stack);
  process.exit(1);
});
