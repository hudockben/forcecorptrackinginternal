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
assert('print CSS hides the notice',          /\.stats, \.bulk, \.backlog,/.test(HTML));
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
  /const companyWide = canAdmin && q\.scope === 'all';/.test(API));
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
    return { ok: true, status: 200, json: async () => ({ entries: mockEntries }) };
  },
  alert() {}, confirm: () => true,
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
const dashify  = (d) => d.toISOString().slice(0, 10);

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
  spanReply = { total: 21, before: 21, after: 0, oldest: lastFriday, newest: lastFriday };
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
  spanReply = { total: 4, before: 0, after: 0, oldest: MONDAY, newest: SUNDAY };
  await run('widenPendingOnLoad()');
  assert('an empty backlog leaves the default range where it was',
    el('flt-from').value === MONDAY && el('flt-to').value === SUNDAY);
  assert('and claims no widen', run('autoWidened') === null);
}

{
  // A straggler from last spring. The same fetch carries every APPROVED row
  // in the range, so the reach stops at the cap and the notice takes the rest.
  setRangeBoxes(MONDAY, SUNDAY);
  run('autoWidened = null;');
  const ancient = '2020-03-02';
  spanReply = { total: 1, before: 1, after: 0, oldest: ancient, newest: ancient };
  await run('widenPendingOnLoad()');
  const cap = run('ymd(addDays(new Date(), -MAX_AUTO_WIDEN_DAYS))');
  assert('a year-old straggler does not pull a year of payroll onto the screen',
    el('flt-from').value > ancient, `From is ${el('flt-from').value}`);
  assert('the reach stops within a week of the cap',
    el('flt-from').value <= cap && el('flt-from').value > run(`ymd(addDays(new Date(), -${91}))`),
    `From is ${el('flt-from').value}, cap is ${cap}`);
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
  // the same rule the entry list follows, on its own counter.
  run('pendingSpan = null;');
  run('pendingSpanSeq++;');           // as if a newer request had been issued
  const stale = run('pendingSpanSeq') - 1;
  run(`(function () {
         const seq = ${stale};
         if (seq !== pendingSpanSeq) return;
         pendingSpan = { total: 9, before: 9, after: 0, oldest: '2020-01-06',
                         newest: '2020-01-06', from: 'x', to: 'y' };
       })()`);
  assert('a stale span answer is dropped',            run('pendingSpan') === null);
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
