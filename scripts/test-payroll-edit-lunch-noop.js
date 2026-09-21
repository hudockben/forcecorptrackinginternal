#!/usr/bin/env node
'use strict';
/**
 * Editing a split day must not be refused over a lunch break nobody touched.
 *
 * Run: node scripts/test-payroll-edit-lunch-noop.js
 *
 * payroll.html's edit modal sends a second request after every save to a
 * split day — ?action=lunch_holder — to settle which job of the day carries
 * the break. It sent one after EVERY edit, including a change to the travel
 * hours, and the endpoint refused any such call outright when the day held an
 * approved job with cost rows posted from its hours.
 *
 * So an approver correcting the travel hours on a split day whose other half
 * was already approved was told to un-approve the day and re-split it, over a
 * lunch break they had not touched and which was not moving. And because that
 * second call shared the first one's catch, the refusal arrived as though the
 * EDIT had failed — it had not, it was already saved — with the modal still
 * open over a grid that no longer matched the database.
 *
 * Three things are pinned here, one per layer:
 *   1. The endpoint refuses only what it is actually about to rewrite. A call
 *      that changes nothing changes nothing, and is not an error.
 *   2. The page does not make the call at all when the break is not moving.
 *   3. A failure AFTER the save reads as one: it leads with the save, and it
 *      refreshes the grid, because what is behind the modal is now stale
 *      whichever way the second call went.
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

const ROOT = path.resolve(__dirname, '..');
const PAY  = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');

(async function main() {

// ─────────────────────────────────────────────────────────────────────
// 1) THE ENDPOINT — refuse only what is actually being rewritten
// ─────────────────────────────────────────────────────────────────────
console.log('\n[the endpoint refuses only a real move]');

const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office', payrollAdmin: true };
let CURRENT_SQL = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      // Payroll's grant is two answers — see payrollAccess in api/lib/auth.js.
      // Mirrored here rather than stubbed to a constant: canApprove is what
      // every money path gates on, and a stub that always said yes would let
      // the coder tests pass without any of it being enforced.
      //   payrollAdmin  → holds payroll
      //   payrollCoder  → holds it as a CODER: may propose, may not approve
      payrollAccess: (p) => {
        const canCode = !!(p && p.payrollAdmin);
        const isCoder = canCode && !!p.payrollCoder;
        return { canCode, canApprove: canCode && !isCoder, isCoder };
      },
      requireAuth: () => ADMIN,
      requireDivision: () => null,
      hasDivisionAccess: (p, area) => (area === 'payroll' ? !!(p && p.payrollAdmin) : true),
    };
  }
  return origLoad.apply(this, arguments);
};
const handler = require(path.join(ROOT, 'api/timesheet-entries.js'));

// The day from the report: job 1 approved and already posting cost rows, job 2
// still submitted and the one the approver opened. Neither carries the break.
const day = () => [
  { id: 501, company_code: 'FCT', user_id: 9, username: 'galbraithtyler', entry_type: 'daily',
    work_date: '2026-09-18', status: 'approved',  division: 'turf', split_group_id: 'g1',
    split_index: 1, job_id: '26098', start_time: '07:30', end_time: '15:30',
    computed_hours: 8, lunch_break: false },
  { id: 502, company_code: 'FCT', user_id: 9, username: 'galbraithtyler', entry_type: 'daily',
    work_date: '2026-09-18', status: 'submitted', division: 'turf', split_group_id: 'g1',
    split_index: 2, job_id: '26098', start_time: '15:30', end_time: '16:30',
    computed_hours: 1, lunch_break: false },
];

async function lunchHolder(holderId, rows) {
  const group = rows || day();
  const updated = [];
  CURRENT_SQL = (strings, ...v) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT * FROM timesheet_entries WHERE id =')) {
      return Promise.resolve([group.find(g => g.id === v[0])].filter(Boolean));
    }
    if (q.includes('AND split_group_id =')) return Promise.resolve(group);
    // Only the approved half ever posted cost rows.
    if (q.startsWith('SELECT COUNT(*)::int AS cnt FROM daily_tracking')) {
      const row = group.find(g => Number(g.id) === Number(v[0]));
      return Promise.resolve([{ cnt: row && row.status === 'approved' ? 3 : 0 }]);
    }
    if (q.startsWith('UPDATE timesheet_entries')) {
      const row = group.find(g => Number(g.id) === Number(v[v.length - 2]));
      const saved = Object.assign({}, row, { lunch_break: v[0], computed_hours: v[1] });
      updated.push(saved);
      return Promise.resolve([saved]);
    }
    return Promise.resolve([]);
  };
  const res = { statusCode: 200, body: null, setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method: 'POST', query: { action: 'lunch_holder', id: '502' },
                  body: { holder_id: holderId } }, res);
  return { res, updated };
}

{
  // Exactly what the page sent after the travel-hours edit.
  const { res, updated } = await lunchHolder(null);
  assert('a call that would rewrite nothing is not refused',
    res.statusCode === 200, `HTTP ${res.statusCode} ${JSON.stringify(res.body)}`);
  assert('  and it writes nothing',                 updated.length === 0);
}
{
  // The guard's real job: an approved row's hours changing underneath the
  // cost rows posted from them.
  const { res } = await lunchHolder(501);
  assert('moving the break ONTO the approved half is still refused',
    res.statusCode === 409, `HTTP ${res.statusCode}`);
  assert('  and says why',
    /cost tracking rows injected from approval/.test((res.body || {}).error || ''));
}
{
  // Nothing approved is being rewritten here, so there is nothing to protect.
  const { res, updated } = await lunchHolder(502);
  assert('moving it onto the submitted half goes through',
    res.statusCode === 200, `HTTP ${res.statusCode} ${JSON.stringify(res.body)}`);
  assert('  taking the half hour off that job',
    updated.length === 1 && updated[0].id === 502 && updated[0].computed_hours === 0.5,
    JSON.stringify(updated));
}
{
  // The same day with nothing approved: every move is allowed.
  const plain = day().map(r => Object.assign({}, r, { status: 'submitted' }));
  const { res } = await lunchHolder(501, plain);
  assert('with nothing approved, the break moves freely',
    res.statusCode === 200, `HTTP ${res.statusCode}`);
}

// ─────────────────────────────────────────────────────────────────────
// 2) THE PAGE — no call when the break is not moving, and the two
//    outcomes of a save are kept apart
// ─────────────────────────────────────────────────────────────────────
console.log('\n[the page]');

const scriptMatch = PAY.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('could not find the inline <script>'); process.exit(1); }

function makeElement(id) {
  const classes = new Set();
  return { id, value: '', innerHTML: '', textContent: '', style: {}, dataset: {},
    options: [], selectedIndex: -1, disabled: false, checked: false,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
                           else if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    addEventListener() {}, removeEventListener() {}, scrollIntoView() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild(c) { return c; }, remove() {} };
}
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, makeElement(id)); return els.get(id); };

const storage = new Map([
  ['fct_token', 'test-token'],
  ['fct_user', JSON.stringify({ username: 'office', isPlatformAdmin: true, allowedDivisions: ['payroll'] })],
]);

const calls   = [];          // every request the page made, in order
let putReply  = { ok: true, status: 200, json: async () => ({ ok: true, entry: null }) };
let lunchReply= { ok: true, status: 200, json: async () => ({ ok: true, changed: [] }) };
const pageLogs = [];

const sandbox = {
  console: { log() {}, warn: (...a) => pageLogs.push(a.join(' ')), error: (...a) => pageLogs.push(a.join(' ')) },
  localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem() {}, removeItem() {} },
  document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
              addEventListener() {}, body: makeElement('body') },
  window: { location: { replace() {}, href: '' }, addEventListener() {} },
  // Only the first zero-delay timer — init()'s deferred first load — is
  // dropped; the modal's 600ms auto-close is one of the things under test.
  setTimeout: (fn, ms) => {
    if (!ms && !initSwallowed) { initSwallowed = true; return 0; }
    if (typeof fn === 'function') fn();
    return 0;
  },
  clearTimeout: () => {},
  fetch: async (url, opts) => {
    const u = String(url || '');
    calls.push(u);
    if (u.includes('action=lunch_holder')) return lunchReply;
    if (u.includes('action=pending_span')) {
      return { ok: true, status: 200,
               json: async () => ({ total: 0, before: 0, after: 0, oldest: null, newest: null }) };
    }
    if (opts && opts.method === 'PUT') return putReply;
    return { ok: true, status: 200, json: async () => ({ entries: [] }) };
  },
  alert() {}, confirm: () => true,
  Date, Math, JSON, Number, String, Array, Object, Set, Map, Boolean, Error,
  isNaN, parseInt, parseFloat, URLSearchParams,
};
let initSwallowed = false;
sandbox.globalThis = sandbox;
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;

const ctx = vm.createContext(sandbox);
try { vm.runInContext(scriptMatch[1], ctx, { filename: 'payroll-inline.js' }); }
catch (err) { console.error('\n  ✗ inline script threw while loading: ' + err.message); process.exit(1); }
const run = (src) => vm.runInContext(src, ctx);

// The same split day, as the page holds it.
const GROUP = [
  { id: '501', username: 'galbraithtyler', entry_type: 'daily', work_date: '2026-09-18',
    status: 'approved', division: 'turf', split_group_id: 'g1', split_index: 1,
    job_id: '26098', job_label: 'Lake Erie College Repair', start_time: '07:30',
    end_time: '15:30', computed_hours: 8, travel_hours: 0, lunch_break: false },
  { id: '502', username: 'galbraithtyler', entry_type: 'daily', work_date: '2026-09-18',
    status: 'submitted', division: 'turf', split_group_id: 'g1', split_index: 2,
    job_id: '26098', job_label: 'Lake Erie College Repair', start_time: '15:30',
    end_time: '16:30', computed_hours: 1, travel_hours: 7, lunch_break: false },
];

/** Put the modal in the state the edit screen leaves it in for entry 502. */
function openOn502(lunchValue, holderValue) {
  run(`allEntries = ${JSON.stringify(GROUP)}; filtered = allEntries.slice();
       editingEntry = allEntries.find(e => e.id === '502'); currentTab = 'pending';`);
  el('em-lunch').value    = lunchValue;
  el('em-lunch-on').value = holderValue;
  el('editMsg').textContent = '';
  el('editBackdrop').classList.add('open');
  calls.length = 0;
}

{
  // The reported case: travel hours changed, lunch answer left alone.
  openOn502('false', '502');
  await run('saveLunchHolder()');
  assert('a lunch answer that did not change makes no request',
    calls.length === 0, calls.join(' | '));
}
{
  // No → Yes is a real move and must still go.
  openOn502('true', '502');
  await run('saveLunchHolder()');
  assert('turning the break on does make the request',
    calls.length === 1 && calls[0].includes('action=lunch_holder'), calls.join(' | '));
}
{
  // Yes → No, on a day that currently holds one.
  const held = GROUP.map(g => Object.assign({}, g, { lunch_break: g.id === '501' }));
  run(`allEntries = ${JSON.stringify(held)}; filtered = allEntries.slice();
       editingEntry = allEntries.find(e => e.id === '502');`);
  el('em-lunch').value = 'false'; el('em-lunch-on').value = '501';
  calls.length = 0;
  await run('saveLunchHolder()');
  assert('clearing a break the day really has does make the request',
    calls.length === 1, calls.join(' | '));

  // …and leaving it exactly where it sits does not.
  el('em-lunch').value = 'true'; el('em-lunch-on').value = '501';
  calls.length = 0;
  await run('saveLunchHolder()');
  assert('leaving it where it already sits makes none', calls.length === 0, calls.join(' | '));
}

console.log('\n[a failure after the save reads as one]');
{
  // The endpoint is fixed, but it can still legitimately refuse — a real move
  // onto an approved half. The edit itself has already gone through.
  openOn502('true', '501');
  lunchReply = { ok: false, status: 409, json: async () => ({
    error: 'This day has cost tracking rows injected from approval. '
         + 'Un-approve it first, move the lunch break, then re-approve with a fresh split.' }) };
  await run('saveEdit()');
  const msg = el('editMsg').textContent;
  lunchReply = { ok: true, status: 200, json: async () => ({ ok: true, changed: [] }) };

  assert('it leads with the fact that the edit saved',
    /^Your changes were saved\./.test(msg), msg);
  assert('  and still names what did not happen',
    /lunch break was not moved/.test(msg) && /cost tracking rows/.test(msg), msg);
  assert('  and refreshes the grid, which is now out of date either way',
    calls.some(u => u.includes('status=submitted_approved')), calls.join(' | '));
  assert('  and does not close the modal out from under the message',
    el('editBackdrop').classList.contains('open'));
}
{
  // The save itself failing is a different message, and must not claim
  // anything was saved.
  openOn502('false', '502');
  putReply = { ok: false, status: 400, json: async () => ({ error: 'End time is before start time' }) };
  await run('saveEdit()');
  putReply = { ok: true, status: 200, json: async () => ({ ok: true, entry: null }) };
  const msg = el('editMsg').textContent;
  assert('a failed save says so, and claims nothing saved',
    /End time is before start time/.test(msg) && !/were saved/.test(msg), msg);
}
{
  // The ordinary path still closes.
  openOn502('false', '502');
  await run('saveEdit()');
  assert('a clean save reports success',  /^Saved\.$/.test(el('editMsg').textContent),
    el('editMsg').textContent);
  assert('  and closes the modal',        !el('editBackdrop').classList.contains('open'));
}

const stray = missingGlobals(pageLogs);
assert('no page code hit a name this sandbox does not have', stray.length === 0, stray.join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

})();
