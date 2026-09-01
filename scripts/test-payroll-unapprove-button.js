#!/usr/bin/env node
'use strict';
/**
 * Un-approve button gate test for payroll.html.
 *
 * Run: node scripts/test-payroll-unapprove-button.js
 *
 * The button used to be gated on entryNeedsSplit || entryNeedsQuarry ||
 * entryNeedsTrucking — the same three predicates that decide whether an Edit
 * Split / Edit Row modal exists. Those three miss two kinds of approved entry:
 *
 *   - a dust EES day (job ees:preloading / ees:washing), which entryNeedsTrucking
 *     deliberately excludes because it posts to the dust EES Other tab instead
 *     of Truck Tracking — but it DOES inject a row, into dust_ees_other_rows
 *   - time off, which injects nothing
 *
 * Neither could be un-approved from the UI: Delete was the only way back, which
 * throws the entry away and makes the employee resubmit. The server never had
 * this limit — action=unapprove in api/timesheet-entries.js sweeps every
 * injection type off the entry itself — so the gate is now just "is it
 * approved". This test holds the two together.
 *
 *   1. Structural — the gate in the markup is the bare !isPending form.
 *   2. Behavioural — evaluates the page's inline <script> in a sandboxed vm and
 *      drives renderRows() over one approved entry of every division/type,
 *      asserting each row carries Un-approve, that pending rows do not, and
 *      that the Edit buttons stay gated as they were.
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
assert('Un-approve is gated on !isPending alone',
  /\$\{!isPending \? `<button class="row-btn delete"\s+onclick="unapproveEntry\(/.test(HTML));
assert('the old three-predicate gate is gone',
  !/\(entryNeedsSplit\(e\) \|\| entryNeedsQuarry\(e\) \|\| entryNeedsTrucking\(e\)\)\s*\?\s*`<button class="row-btn delete"/.test(HTML));
assert('Edit Split stays gated on entryNeedsSplit',
  /\$\{!isPending && entryNeedsSplit\(e\) \?/.test(HTML));
assert('Edit Row stays gated on entryNeedsQuarry',
  /\$\{!isPending && entryNeedsQuarry\(e\) \?/.test(HTML));
assert('Edit Row stays gated on entryNeedsTrucking',
  /\$\{!isPending && entryNeedsTrucking\(e\) \?/.test(HTML));
assert('Edit Row is gated on entryNeedsEes',
  /\$\{!isPending && entryNeedsEes\(e\) \?/.test(HTML));
assert('the confirm text does not promise cost rows for time off',
  /const injects = e\.entry_type !== 'time_off';/.test(HTML));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL — run the page's script against a mock DOM
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
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
                           else if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    addEventListener() {}, removeEventListener() {},
    scrollIntoView() {}, focus() {},
    querySelector() { return null; },
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
let mockEntries = [];
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
  setTimeout: () => 0,
  clearTimeout: () => {},
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ entries: mockEntries }) }),
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
const run = (src) => vm.runInContext(src, ctx);

// One approved entry of every shape payroll can be looking at. Distinct
// usernames so the hours-mismatch detector stays quiet.
function entry(over) {
  return Object.assign({
    work_date: '2026-08-28',
    entry_type: 'daily',
    status: 'approved',
    computed_hours: 8, travel_hours: 0,
    start_time: '07:00', end_time: '15:00',
    supervisor_name: 'reeferscott',
    approved_at: '2026-08-30T20:34:00Z',
    submitted_at: '2026-08-28T16:03:00Z',
    approved_by_name: 'stewartcarrie',
    lunch_break: false, operated_equipment: false,
    prevailing_wage: null,
  }, over);
}

// barrmike's two rows from the report, plus one of every other division.
const CASES = [
  { id: 'dust-ees',    label: 'dust EES Pre Loading',  edits: true,
    e: entry({ id: 'dust-ees',  username: 'barrmike',  division: 'dust',
               job_id: 'ees:preloading', job_label: 'EES - Pre Loading' }) },
  { id: 'dust-ees-w',  label: 'dust EES Washing',      edits: true,
    e: entry({ id: 'dust-ees-w', username: 'washguy',  division: 'dust',
               job_id: 'ees:washing', job_label: 'EES - Washing' }) },
  { id: 'dust-cust',   label: 'dust customer haul',    edits: true,
    e: entry({ id: 'dust-cust', username: 'haulguy',   division: 'dust',
               job_id: 'penn-energy', job_label: 'Penn Energy' }) },
  { id: 'dust-nojob',  label: 'dust day with no job',  edits: false,
    e: entry({ id: 'dust-nojob', username: 'nojobguy', division: 'dust',
               job_id: null, job_label: '' }) },
  { id: 'turf-1',      label: 'turf daily',            edits: true,
    e: entry({ id: 'turf-1',   username: 'turfguy',    division: 'turf',
               job_id: 'j-turf', job_label: 'Some Turf Job' }) },
  { id: 'paving-1',    label: 'paving daily',          edits: true,
    e: entry({ id: 'paving-1', username: 'pavingguy',  division: 'paving',
               job_id: 'j-pave', job_label: 'Some Paving Job' }) },
  { id: 'kiewit-1',    label: 'kiewit daily',          edits: true,
    e: entry({ id: 'kiewit-1', username: 'kiewitguy',  division: 'kiewit',
               job_id: 'j-kw',  job_label: 'Some Kiewit Job' }) },
  { id: 'quarry-1',    label: 'quarry daily',          edits: true,
    e: entry({ id: 'quarry-1', username: 'quarryguy',  division: 'quarry',
               job_id: 'daily:homer', job_label: 'Daily — Homer City' }) },
  { id: 'truck-1',     label: 'trucking daily',        edits: true,
    e: entry({ id: 'truck-1',  username: 'truckguy',   division: 'trucking',
               job_id: 'j-tk',  job_label: 'Some Haul' }) },
  { id: 'off-1',       label: 'time off',              edits: false,
    e: entry({ id: 'off-1',    username: 'offguy',     division: 'turf',
               entry_type: 'time_off', time_off_type: 'vacation',
               job_id: null, job_label: '', computed_hours: null,
               travel_hours: null, start_time: null, end_time: null }) },
];

function render(entries, tab) {
  mockEntries = entries;
  run(`currentTab = '${tab}'; approvedPage = 1; approvedPageSize = 0;`);
  run(`allEntries = ${JSON.stringify(entries)}; filtered = allEntries.slice();`);
  run('renderRows()');
  return el('rowsBody').innerHTML;
}

const hasUnapprove = (html, id) => html.includes(`unapproveEntry('${id}')`);

console.log('\n[behavioural — Approved tab]');
const approvedHtml = render(CASES.map(c => c.e), 'approved');
assert('every approved row rendered', (approvedHtml.match(/<tr\b/g) || []).length === CASES.length,
  `got ${(approvedHtml.match(/<tr\b/g) || []).length}`);
for (const c of CASES) {
  assert(`${c.label} offers Un-approve`, hasUnapprove(approvedHtml, c.id));
}

console.log('\n[behavioural — the Edit buttons keep their own gate]');
for (const c of CASES) {
  const opensModal = approvedHtml.includes(`openSplitModalById('${c.id}'`)
    || approvedHtml.includes(`openQuarryModalById('${c.id}'`)
    || approvedHtml.includes(`openTruckingModalById('${c.id}'`)
    || approvedHtml.includes(`openEesModalById('${c.id}'`);
  assert(`${c.label} ${c.edits ? 'has an' : 'has no'} Edit modal button`, opensModal === c.edits);
}

console.log('\n[behavioural — Pending tab]');
const pendingHtml = render(
  CASES.map(c => Object.assign({}, c.e, { status: 'submitted', approved_at: null, approved_by_name: null })),
  'pending');
for (const c of CASES) {
  assert(`${c.label} pending offers no Un-approve`, !hasUnapprove(pendingHtml, c.id));
}
assert('pending rows offer Approve instead',
  CASES.every(c => pendingHtml.includes(`approveOne('${c.id}')`)));

console.log('\n[behavioural — the confirm text tells the truth]');
const prompts = [];
sandbox.confirm = (msg) => { prompts.push(msg); return false; };  // false = don't fire the fetch
run(`unapproveEntry('dust-ees')`);
run(`unapproveEntry('off-1')`);
assert('a dust EES day is told its cost rows go',
  /remove the cost tracking rows injected into the Dust Control division/.test(prompts[0] || ''),
  prompts[0]);
assert('time off is not promised a cost row removal',
  !/cost tracking rows/.test(prompts[1] || '') && /back into Pending/.test(prompts[1] || ''),
  prompts[1]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
