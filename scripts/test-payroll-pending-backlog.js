#!/usr/bin/env node
'use strict';
/**
 * Pending time must not be hidden by the default date range — payroll.html
 * and /api/timesheet-entries?action=pending_span.
 *
 * Run: node scripts/test-payroll-pending-backlog.js
 *
 * The review grid loads ONE date range, and that range defaults to the
 * Monday–Sunday week in progress. On a Monday morning the week in progress is
 * nearly empty while last week's crew days are the ones sitting unapproved —
 * so the screen opened on "Awaiting Review 0" over a full queue. Nothing on
 * the page said the count was about the range rather than the company, and a
 * queue that reads as done is a queue nobody works.
 *
 * Two mechanisms, both under test here:
 *   · the first load reaches BACK over the default range when older time is
 *     still awaiting review (widenPendingOnLoad), on week boundaries and no
 *     further than MAX_AUTO_WIDEN_DAYS
 *   · anything still outside the range — because the cap stopped the widen,
 *     or because the range was narrowed by hand afterwards — is named in a
 *     notice with a one-click widen (renderBacklogNote / showHiddenPending)
 *
 * Three layers:
 *   1. Structural — the markup, the CSS and the print rule.
 *   2. Behavioural (page) — the inline <script> in a sandboxed vm with a mock
 *      DOM and fetch, driving the widen and the notice directly.
 *   3. Behavioural (API) — the handler with a stubbed neon driver, asserting
 *      the scoping of the new branch: own rows by default, company-wide only
 *      on an explicit ?scope=all from a payroll admin.
 */

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const Module = require('module');
const { missingGlobals } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'payroll.html'), 'utf8');
const API  = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// 1) STRUCTURAL
// ─────────────────────────────────────────────────────────────────────
console.log('\n[structural — payroll.html]');
assert('backlogNote container exists',        /<div class="backlog" id="backlogNote"><\/div>/.test(HTML));
assert('it sits between the filters and the tabs',
  HTML.indexOf('id="backlogNote"') > HTML.indexOf('id="flt-user"') &&
  HTML.indexOf('id="backlogNote"') < HTML.indexOf('data-tab="pending"'));
assert('.backlog CSS block exists',           /\n\s*\.backlog \{[\s\S]*?\}/.test(HTML));
assert('.backlog.open flips to flex',         /\.backlog\.open \{ display: flex; \}/.test(HTML));
assert('.backlog.info variant exists',        /\.backlog\.info \{/.test(HTML));
// Match the member, not the selectors it happens to share a line with today —
// the same shape test-payroll-approved-pagination.js uses, for the same reason.
assert('print CSS hides the notice',
  /@media print \{[\s\S]*?[\s,]\.backlog,[\s\S]*?display: none !important;/.test(HTML));
assert('the auto-widen has a cap',            /const MAX_AUTO_WIDEN_DAYS = 84;/.test(HTML));
assert('init widens before the first fetch',
  /widenPendingOnLoad\(\)\.then\(\(\) => applyFilters\(\)\)/.test(HTML));
assert('applyFilters asks for the span too',  /fetchPendingSpan\(from, to, division\)/.test(HTML));
assert('renderStats keeps the notice in step',
  /function renderStats\(\)[\s\S]{0,1400}?renderBacklogNote\(\)/.test(HTML));
assert('the span request opts in to scope=all',
  /params\.set\('action', 'pending_span'\);[\s\S]{0,200}?params\.set\('scope', 'all'\);/.test(HTML));

console.log('\n[structural — api/timesheet-entries.js]');
assert('pending_span branch exists',
  /req\.method === 'GET' && req\.query\.action === 'pending_span'/.test(API));
assert('it counts only submitted time',       /status\s+= 'submitted'/.test(API));
assert('company-wide is an explicit opt-in',
  /const companyWide = canAdmin && askedUser == null && q\.scope === 'all';/.test(API));
assert('it can be asked for the oldest WITHIN a floor, not just the oldest',
  /MIN\(work_date\) FILTER \(WHERE work_date >= \$\{sinceF\}::date\) AS oldest_since/.test(API));
assert('the widen aims at that, so a straggler past the cap cannot move it',
  /weekStartOf\(span\.oldestSince\)/.test(HTML) && !/weekStartOf\(span\.oldest\)/.test(HTML));
assert('the span is only asked for on the tabs that draw it',
  /if \(currentTab === 'pending' \|\| currentTab === 'approved'\) \{\s*\n\s*const spanSeq/.test(HTML));
assert('the list branch still ignores it',    /req\.method === 'GET' && !req\.query\.action/.test(API));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL — the page's own script, in a sandbox
// ─────────────────────────────────────────────────────────────────────
const scriptMatch = HTML.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error('could not find the inline <script> in payroll.html');
  process.exit(1);
}

function makeElement(id) {
  const classes = new Set();
  return {
    id, value: '', innerHTML: '', textContent: '',
    hidden: false, checked: false, disabled: false,
    style: {}, dataset: {},
    classList: {
      add:      (...c) => c.forEach(x => classes.add(x)),
      remove:   (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle:   (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
                             else if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    addEventListener() {}, removeEventListener() {},
    scrollIntoView() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild(c) { return c; }, remove() {},
  };
}
const els = new Map();
function el(id) {
  if (!els.has(id)) els.set(id, makeElement(id));
  return els.get(id);
}

const storage = new Map([
  ['fct_token', 'test-token'],
  ['fct_user', JSON.stringify({ username: 'office', isPlatformAdmin: true, allowedDivisions: ['payroll'] })],
]);

// The reply the mock server gives to ?action=pending_span, and a log of the
// URLs it was asked for — the sequencing assertions read that log.
let spanReply   = { total: 0, before: 0, after: 0, oldest: null, newest: null };
let spanUrls    = [];
let entryUrls   = [];
// What the page asked the admin before loading something enormous, and what
// they said back.
const confirmed = [];
let confirmAnswer = true;
let mockEntries = [];
const pageLogs  = [];

const sandbox = {
  console: { log() {}, warn: (...a) => pageLogs.push(a.join(' ')),
             error: (...a) => pageLogs.push(a.join(' ')) },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  document: {
    getElementById: el,
    querySelector: (sel) => (sel === '.table-wrap' ? el('table-wrap') : null),
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeElement('body'),
  },
  window: { location: { replace() {}, href: '' }, addEventListener() {} },
  // init() defers its first fetch through setTimeout; swallow it so the tests
  // drive widenPendingOnLoad() themselves rather than racing it.
  setTimeout: () => 0,
  clearTimeout: () => {},
  fetch: async (url) => {
    const u = String(url || '');
    if (u.includes('action=pending_span')) {
      spanUrls.push(u);
      return { ok: true, status: 200, json: async () => spanReply };
    }
    entryUrls.push(u);
    return { ok: true, status: 200, json: async () => ({ entries: mockEntries }) };
  },
  alert() {}, confirm: (m) => { confirmed.push(m); return confirmAnswer; },
  Date, Math, JSON, Number, String, Array, Object, Set, Map, Boolean, Error,
  isNaN, parseInt, parseFloat, URLSearchParams,
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
const run = (src) => vm.runInContext(src, ctx);

const noteHtml = () => el('backlogNote').innerHTML.replace(/\s+/g, ' ').trim();
const noteOpen = () => el('backlogNote').classList.contains('open');

// The page's own idea of this week, so the assertions move with the calendar
// instead of being pinned to the day they were written.
const MONDAY = run('ymd(thisWeekMonday())');
const SUNDAY = run('ymd(addDays(thisWeekMonday(), 6))');

function setRangeBoxes(from, to) {
  el('flt-from').value = from;
  el('flt-to').value   = to;
}

(async function behavioural() {

// ── The first load reaches back over the default range ──
console.log('\n[behavioural — the first load reaches back]');
{
  // Last Monday: a week older than the default range, well inside the cap.
  const lastMonday = run(`ymd(addDays(thisWeekMonday(), -7))`);
  const lastFriday = run(`ymd(addDays(thisWeekMonday(), -3))`);
  setRangeBoxes(MONDAY, SUNDAY);
  run('autoWidened = null;');
  spanReply = { total: 21, before: 21, after: 0, oldest: lastFriday, newest: lastFriday,
                oldest_since: lastFriday };
  await run('widenPendingOnLoad()');

  assert('From moves back over the older pending time',
    el('flt-from').value === lastMonday, `From is ${el('flt-from').value}, wanted ${lastMonday}`);
  assert('and lands on a Monday, not on the entry\'s own date',
    el('flt-from').value !== lastFriday);
  assert('To is left alone — a future-dated entry is a typo, not a backlog',
    el('flt-to').value === SUNDAY, `To is ${el('flt-to').value}`);
  assert('what it did is remembered, so the notice can explain it',
    run('autoWidened') === lastMonday, `autoWidened is ${run('autoWidened')}`);
}

{
  // Nothing older than the range: the default stands.
  setRangeBoxes(MONDAY, SUNDAY);
  run('autoWidened = null;');
  spanReply = { total: 4, before: 0, after: 0, oldest: MONDAY, newest: SUNDAY,
                oldest_since: MONDAY };
  await run('widenPendingOnLoad()');
  assert('an empty backlog leaves the default range where it was',
    el('flt-from').value === MONDAY && el('flt-to').value === SUNDAY);
  assert('and claims no widen', run('autoWidened') === null);
}

{
  // A straggler from 2020 that nobody will ever approve — a departed
  // employee's row, a bad day filed and abandoned. The reach is aimed at the
  // oldest day it is WILLING to show, so a row past the cap moves nothing:
  // widening to the cap for it would pay twelve weeks of approved rows on
  // every single load and still leave the row off-screen.
  setRangeBoxes(MONDAY, SUNDAY);
  run('autoWidened = null;');
  const ancient = '2020-03-02';
  spanReply = { total: 1, before: 1, after: 0, oldest: ancient, newest: ancient,
                oldest_since: null };
  await run('widenPendingOnLoad()');
  assert('a straggler past the cap does not widen the range at all',
    el('flt-from').value === MONDAY && run('autoWidened') === null,
    `From is ${el('flt-from').value}`);
  assert('  and the request said how far back the page would go',
    spanUrls[spanUrls.length - 1].includes('since='), spanUrls[spanUrls.length - 1]);

  // Same straggler, but there IS reachable time too: the range opens to the
  // reachable one and stops there, and the notice carries the rest.
  setRangeBoxes(MONDAY, SUNDAY);
  run('autoWidened = null;');
  const reachable = run(`ymd(addDays(thisWeekMonday(), -20))`);
  spanReply = { total: 9, before: 9, after: 0, oldest: ancient, newest: reachable,
                oldest_since: reachable };
  await run('widenPendingOnLoad()');
  assert('it opens to the oldest REACHABLE week, not to the cap',
    el('flt-from').value === run(`weekStartOf('${reachable}')`),
    `From is ${el('flt-from').value}`);
  assert('and the capped From is still a Monday',
    run(`weekStartOf('${el('flt-from').value}')`) === el('flt-from').value);
}

{
  // A failed span request must not move anything. The range the admin sees is
  // then the documented default, which is a thing they can reason about.
  setRangeBoxes(MONDAY, SUNDAY);
  run('autoWidened = null;');
  const saved = sandbox.fetch;
  sandbox.fetch = async () => { throw new Error('offline'); };
  await run('widenPendingOnLoad()');
  sandbox.fetch = saved;
  assert('a failed span request leaves the default range alone',
    el('flt-from').value === MONDAY && run('autoWidened') === null);
}

// ── The notice over whatever is still hidden ──
console.log('\n[behavioural — the notice]');
run(`currentTab = 'pending'; entriesLoadError = null; autoWidened = null;`);
{
  run(`pendingSpan = { total: 21, before: 21, after: 0, oldest: '2026-06-12',
                       newest: '2026-06-12', from: '${MONDAY}', to: '${SUNDAY}' };`);
  run('renderBacklogNote()');
  assert('pending outside the range is named',       noteOpen());
  assert('with the count',                            /21 pending entries/.test(noteHtml()));
  assert('which way it lies',                         /outside this date range — before /.test(noteHtml()));
  assert('the oldest date carries its year',          /Oldest submitted: .*2026/.test(noteHtml()));
  assert('it says why the stat strip disagrees',
    /Not counted in Awaiting Review/.test(noteHtml()));
  assert('and offers to pull it in',                  /onclick="showHiddenPending\(\)"/.test(noteHtml()));
}
{
  run(`pendingSpan = { total: 1, before: 0, after: 1, oldest: '2026-12-30',
                       newest: '2026-12-30', from: '${MONDAY}', to: '${SUNDAY}' };`);
  run('renderBacklogNote()');
  assert('a single hidden entry reads as one entry',  /1 pending entry /.test(noteHtml()), noteHtml());
  assert('time after the range is named as such',     /— after /.test(noteHtml()));
  assert('and the date quoted is the one off the END of the range',
    /Latest submitted: .*Dec 30, 2026/.test(noteHtml()) && !/Oldest/.test(noteHtml()), noteHtml());
}
{
  run(`pendingSpan = { total: 6, before: 0, after: 0, oldest: '${MONDAY}',
                       newest: '${SUNDAY}', from: '${MONDAY}', to: '${SUNDAY}' };`);
  run('renderBacklogNote()');
  assert('nothing hidden draws no notice',            !noteOpen() && noteHtml() === '');
}
{
  // Never drawn from an unanswered question: "we have not asked" is not
  // "there is none", and it is certainly not "there are 21".
  run('pendingSpan = null; renderBacklogNote()');
  assert('no answer yet draws nothing',               !noteOpen());
}
{
  run(`pendingSpan = { total: 21, before: 21, after: 0, oldest: '2026-06-12',
                       newest: '2026-06-12', from: '${MONDAY}', to: '${SUNDAY}' };`);
  for (const tab of ['reports', 'auditlog', 'analytics']) {
    run(`currentTab = '${tab}'; renderBacklogNote()`);
    assert(`the ${tab} tab is not asking, so it is not told`, !noteOpen());
  }
  run(`currentTab = 'pending'; renderBacklogNote()`);
  assert('back on Pending Review it returns',         noteOpen());
}
{
  // A failed load blanks every count on the page. A notice counting pending
  // time beside "—" would be the one live number on a dead screen.
  run(`entriesLoadError = 'Database unavailable'; renderBacklogNote()`);
  assert('a failed load takes the notice with it',    !noteOpen());
  run(`entriesLoadError = null;`);
}

// ── "Show Them" ──
console.log('\n[behavioural — Show Them]');
{
  setRangeBoxes(MONDAY, SUNDAY);
  run(`pendingSpan = { total: 21, before: 21, after: 0, oldest: '2026-06-12',
                       newest: '2026-06-12', from: '${MONDAY}', to: '${SUNDAY}' };`);
  run('showHiddenPending()');
  assert('From drops to the Monday of the oldest pending week',
    el('flt-from').value === '2026-06-08', `got ${el('flt-from').value}`);
  assert('To is untouched when nothing is hidden past it',
    el('flt-to').value === SUNDAY);
}
{
  setRangeBoxes(MONDAY, SUNDAY);
  run(`pendingSpan = { total: 2, before: 0, after: 2, oldest: '2026-12-30',
                       newest: '2026-12-30', from: '${MONDAY}', to: '${SUNDAY}' };`);
  run('showHiddenPending()');
  assert('To extends to the Sunday closing the latest pending week',
    el('flt-to').value === '2027-01-03', `got ${el('flt-to').value}`);
  assert('and From stays put',                        el('flt-from').value === MONDAY);
}

// ── The other half: explaining a range this page moved ──
console.log('\n[behavioural — explaining the widened range]');
{
  const lastMonday = run(`ymd(addDays(thisWeekMonday(), -7))`);
  const lastWed    = run(`ymd(addDays(thisWeekMonday(), -5))`);
  setRangeBoxes(lastMonday, SUNDAY);
  run(`currentTab = 'pending'; autoWidened = '${lastMonday}';`);
  run(`pendingSpan = { total: 3, before: 0, after: 0, oldest: '${lastMonday}',
                       newest: '${SUNDAY}', from: '${lastMonday}', to: '${SUNDAY}' };`);
  // Three older days awaiting review and one already approved, all inside the
  // widened range — the note counts the ones still waiting.
  const older = (st, d) => ({ id: `o-${st}-${d}`, status: st, work_date: d });
  run(`allEntries = ${JSON.stringify([older('submitted', lastWed), older('submitted', lastWed),
                                      older('submitted', lastWed), older('approved', lastWed)])};
       filtered = allEntries.slice();`);
  run('renderBacklogNote()');
  assert('a From date this page moved is explained',  noteOpen());
  assert('it is the calmer variant, not the warning',
    el('backlogNote').classList.contains('info'));
  assert('it counts the rows it reached back for',    /3 entries from before this week/.test(noteHtml()),
    noteHtml());
  assert('and offers the default range back',         /setRange\('current_week'\)/.test(noteHtml()));

  // Approving them is what the reach was for. The count comes off the rows on
  // screen, so it falls as they are worked rather than quoting the load.
  run(`allEntries = allEntries.map(e => Object.assign({}, e, { status: 'approved' }));
       filtered = allEntries.slice();`);
  run('renderBacklogNote()');
  assert('and the bar goes once the queue is worked', !noteOpen(), noteHtml());

  // Anyone moving the box means they now own the range.
  run(`allEntries = ${JSON.stringify([older('submitted', lastWed)])}; filtered = allEntries.slice();`);
  run('renderBacklogNote()');
  assert('it is back while one is still waiting',     noteOpen());
  el('flt-from').value = MONDAY;
  run('renderBacklogNote()');
  assert('changing the range drops the explanation',  !noteOpen());
}

// ── The span request rides alongside, and is sequenced ──
console.log('\n[behavioural — the span rides alongside the entry fetch]');
{
  spanUrls = [];
  mockEntries = [];
  setRangeBoxes(MONDAY, SUNDAY);
  el('flt-division').value = 'turf';
  spanReply = { total: 0, before: 0, after: 0, oldest: null, newest: null };
  run(`currentTab = 'pending';`);
  await run('applyFilters()');
  await new Promise(r => setImmediate(r));
  assert('applyFilters asks the span question too',   spanUrls.length === 1, `${spanUrls.length} calls`);
  assert('for the same range the grid loaded',
    spanUrls[0].includes(`from=${MONDAY}`) && spanUrls[0].includes(`to=${SUNDAY}`));
  assert('and the same division',                     spanUrls[0].includes('division=turf'));
  assert('company-wide, like the entry list',         spanUrls[0].includes('scope=all'));
  el('flt-division').value = '';
}
{
  // A slow answer for an old range must not draw a notice over a new one —
  // the same rule the entry list follows, on its own counter. Driven through
  // applyFilters with a delayed first reply, so the guard under test is the
  // page's and not a restatement of it here.
  run('pendingSpan = null; pendingSpanPrefetch = null;');
  const answers = [
    { delayMs: 40, span: { total: 9, before: 9, after: 0,
                           oldest: '2020-01-06', newest: '2020-01-06', oldest_since: null } },
    { delayMs: 0,  span: { total: 0, before: 0, after: 0,
                           oldest: null, newest: null, oldest_since: null } },
  ];
  const saved = sandbox.fetch;
  sandbox.fetch = async (url) => {
    const u = String(url || '');
    if (!u.includes('action=pending_span')) {
      return { ok: true, status: 200, json: async () => ({ entries: [] }) };
    }
    const a = answers.shift() || answers[0];
    if (a.delayMs) await new Promise(r => setTimeout(r, a.delayMs));
    return { ok: true, status: 200, json: async () => a.span };
  };

  setRangeBoxes('2026-01-05', '2026-01-11');   // the range whose answer is slow
  const slow = run('applyFilters()');
  setRangeBoxes(MONDAY, SUNDAY);               // …superseded before it lands
  await run('applyFilters()');
  await slow;
  await new Promise(r => setTimeout(r, 80));
  sandbox.fetch = saved;

  assert('the newest span answer wins',
    run('pendingSpan && pendingSpan.total') === 0, JSON.stringify(run('pendingSpan')));
  assert('and the stale one never draws its notice', !noteOpen(), noteHtml());
}

console.log('\n[behavioural — what the load costs]');
{
  // The first load asks about the range it is ON, so when nothing moves that
  // answer is still true for the fetch that follows and is handed forward.
  // Otherwise the page asks the same question twice before drawing anything.
  spanUrls = []; entryUrls = [];
  setRangeBoxes(MONDAY, SUNDAY);
  run(`currentTab = 'pending'; autoWidened = null; pendingSpanPrefetch = null;`);
  spanReply = { total: 0, before: 0, after: 0, oldest: null, newest: null, oldest_since: null };
  await run('widenPendingOnLoad()');
  await run('applyFilters()');
  await new Promise(r => setImmediate(r));
  assert('a load that does not widen asks the span question once',
    spanUrls.length === 1, `${spanUrls.length} calls`);
  assert('  and still loads the entries',        entryUrls.length === 1);
  assert('  and the handed-forward answer is consumed, not left to go stale',
    run('pendingSpanPrefetch') === null);
}
{
  // A widen invalidates it — those counts were measured against a range the
  // page is no longer on — so the second question is asked and must be.
  spanUrls = [];
  const lastMon = run(`ymd(addDays(thisWeekMonday(), -7))`);
  setRangeBoxes(MONDAY, SUNDAY);
  run(`autoWidened = null; pendingSpanPrefetch = null;`);
  spanReply = { total: 3, before: 3, after: 0, oldest: lastMon, newest: lastMon,
                oldest_since: lastMon };
  await run('widenPendingOnLoad()');
  await run('applyFilters()');
  await new Promise(r => setImmediate(r));
  assert('a load that widens re-asks against the range it actually opened',
    spanUrls.length === 2 && spanUrls[1].includes(`from=${lastMon}`),
    spanUrls.join(' | '));
}
{
  // Reports, Analytics and the Audit Log all route through applyFilters and
  // none of them draws the notice.
  for (const tab of ['reports', 'analytics', 'auditlog']) {
    spanUrls = [];
    run(`currentTab = '${tab}'; pendingSpanPrefetch = null;`);
    await run('applyFilters()');
    await new Promise(r => setImmediate(r));
    assert(`the ${tab} tab costs no span query`, spanUrls.length === 0, spanUrls.join(' | '));
  }
  run(`currentTab = 'pending';`);
}

console.log('\n[behavioural — the capped case explains itself]');
{
  // Both notices are reached at once here: the range WAS opened up, and
  // something is still outside it. One bar is drawn, so it has to carry both
  // — or the admin is left looking at a From date nobody set.
  const reach = run(`ymd(addDays(thisWeekMonday(), -21))`);
  setRangeBoxes(reach, SUNDAY);
  run(`currentTab = 'pending'; entriesLoadError = null; autoWidened = '${reach}';`);
  run(`pendingSpan = { total: 5, before: 2, after: 0, oldest: '2020-03-02',
                       newest: '2020-03-02', from: '${reach}', to: '${SUNDAY}' };`);
  run('renderBacklogNote()');
  assert('the warning names what is still outside',   /2 pending entries outside/.test(noteHtml()));
  assert('  and still says the page moved the From',
    /range was already opened back to/.test(noteHtml()), noteHtml());

  // With no widen behind it, there is nothing to explain and it says nothing.
  run(`autoWidened = null;`);
  run('renderBacklogNote()');
  assert('  but says so only when there was a widen',
    !/range was already opened back to/.test(noteHtml()), noteHtml());
}

console.log('\n[behavioural — Show Them asks before an enormous load]');
{
  confirmed.length = 0; confirmAnswer = false;
  setRangeBoxes(MONDAY, SUNDAY);
  run(`pendingSpan = { total: 1, before: 1, after: 0, oldest: '2020-03-02',
                       newest: '2020-03-02', from: '${MONDAY}', to: '${SUNDAY}' };`);
  run('showHiddenPending()');
  assert('six years back is put to the admin first',  confirmed.length === 1, confirmed.join(''));
  assert('  naming where it reaches',                 /2020/.test(confirmed[0] || ''));
  assert('  and declining changes nothing',
    el('flt-from').value === MONDAY, `From is ${el('flt-from').value}`);

  confirmed.length = 0; confirmAnswer = true;
  run('showHiddenPending()');
  assert('  accepting widens it, onto that entry\'s own Monday',
    el('flt-from').value === '2020-03-02', `From is ${el('flt-from').value}`);

  // A few weeks back is ordinary work and must not nag.
  confirmed.length = 0;
  setRangeBoxes(MONDAY, SUNDAY);
  const recent = run(`ymd(addDays(thisWeekMonday(), -21))`);
  run(`pendingSpan = { total: 3, before: 3, after: 0, oldest: '${recent}',
                       newest: '${recent}', from: '${MONDAY}', to: '${SUNDAY}' };`);
  run('showHiddenPending()');
  assert('three weeks back is just work, and is not put to anyone',
    confirmed.length === 0 && el('flt-from').value === run(`weekStartOf('${recent}')`),
    `${confirmed.length} prompts, From is ${el('flt-from').value}`);
}

const stray = missingGlobals(pageLogs);
assert('no page code hit a name this sandbox does not have', stray.length === 0, stray.join(' | '));

// ─────────────────────────────────────────────────────────────────────
// 3) BEHAVIOURAL — the endpoint, with the driver stubbed
// ─────────────────────────────────────────────────────────────────────
console.log('\n[behavioural — GET ?action=pending_span]');

const FIELD = { companyCode: 'FCT', userId: 7,  username: 'strickallen', payrollAdmin: false };
const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',      payrollAdmin: true  };

let CURRENT_SQL = null;
let NEXT_AUTH   = FIELD;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: () => NEXT_AUTH,
      requireDivision: () => null,
      hasDivisionAccess: (p, area) => (area === 'payroll' ? !!(p && p.payrollAdmin) : true),
    };
  }
  return origLoad.apply(this, arguments);
};
const handler = require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'));

/**
 * Drive one pending_span GET. Returns the response alongside the statement
 * the handler built — `userFilter` is the value bound to `user_id = $n`, or
 * undefined when the statement carries no user_id predicate at all, which is
 * the whole question for a company-wide read.
 */
async function span(query, auth = ADMIN, row = {}) {
  NEXT_AUTH = auth;
  let stmt = null;
  CURRENT_SQL = (strings, ...values) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT COUNT(*)::int AS total')) {
      const idx = strings.findIndex(s => /user_id\s*=\s*$/.test(s));
      stmt = { sql: q, userFilter: idx === -1 ? undefined : values[idx], values };
      return Promise.resolve([Object.assign(
        { total: 0, oldest: null, newest: null, before_range: 0, after_range: 0 }, row)]);
    }
    return Promise.resolve([]);
  };
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method: 'GET', query: Object.assign({ action: 'pending_span' }, query), body: {} }, res);
  return { res, stmt };
}

{
  const { res, stmt } = await span({ scope: 'all', from: '2026-09-21', to: '2026-09-27' }, ADMIN,
    { total: 21, oldest: '2026-09-18', newest: '2026-09-20', before_range: 21, after_range: 0 });
  assert('?scope=all drops the user_id predicate for an admin', stmt.userFilter === undefined);
  assert('it counts submitted time only',       /status = 'submitted'/.test(stmt.sql), stmt.sql);
  assert('the range bounds it reports against, not the rows it counts',
    stmt.values.includes('2026-09-21') && stmt.values.includes('2026-09-27'));
  assert('the counts come back',                res.body.total === 21 && res.body.before === 21);
  assert('with the oldest date',                res.body.oldest === '2026-09-18');
  assert('and no entries — this is counts, not a second list',
    res.body.entries === undefined);
}
{
  const { res, stmt } = await span({ scope: 'all' }, FIELD);
  assert('a field user asking for scope=all is scoped to themselves', stmt.userFilter === 7);
  assert('and is not refused — nothing to reveal, nothing to refuse',
    res.statusCode === 200, `HTTP ${res.statusCode}`);
}
{
  const { stmt } = await span({}, ADMIN);
  assert('an admin who omits scope gets their own backlog, not the company\'s',
    stmt.userFilter === 42);
}
{
  // ?user_id beats ?scope=all, exactly as the list branch has it. Counts over
  // a wider set than the grid they annotate is the one way this endpoint can
  // mislead: a notice claiming hidden pending time belonging to other people,
  // over a grid scoped to one. No caller sends both today — which is why the
  // two must be held together here rather than by whoever adds the first one.
  const { stmt } = await span({ scope: 'all', user_id: '7' }, ADMIN);
  assert('?user_id beats ?scope=all, so the counts match the grid',
    stmt.userFilter === 7, `bound ${JSON.stringify(stmt.userFilter)}`);
}
{
  const { stmt } = await span({ user_id: '11' }, FIELD);
  assert('and a field user cannot count another user\'s backlog', stmt.userFilter === 7);
}
{
  const { res, stmt } = await span(
    { scope: 'all', from: '2026-09-21', to: '2026-09-27', since: '2026-06-29' }, ADMIN,
    { total: 4, oldest: '2020-03-02', newest: '2026-09-20',
      oldest_since: '2026-09-18', before_range: 4, after_range: 0 });
  assert('?since asks where the oldest REACHABLE day is', stmt.values.includes('2026-06-29'));
  assert('  and it comes back beside the oldest that exists',
    res.body.oldest === '2020-03-02' && res.body.oldest_since === '2026-09-18');
}
{
  const { stmt } = await span({ scope: 'all', division: 'turf' }, ADMIN);
  assert('a division filter is passed through',  stmt.values.includes('turf'));
}
{
  const { stmt } = await span({ scope: 'all', division: '../../etc' }, ADMIN);
  assert('an unknown division is dropped, not bound',
    !stmt.values.includes('../../etc') && stmt.values.includes(''));
}
{
  const { res } = await span({ scope: 'all' }, ADMIN, { total: null, oldest: null, newest: null });
  assert('an empty company reads as zero, never NaN',
    res.body.total === 0 && res.body.before === 0 && res.body.oldest === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

})();
