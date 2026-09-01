#!/usr/bin/env node
'use strict';
/**
 * Payroll's dust EES "Edit Row" modal.
 *
 * Run: node scripts/test-ees-edit-row.js
 *
 * A dust day on one of the two standing EES activities (Pre Loading / Washing)
 * posts one row to the dust division's EES Other tab on approval. Until this
 * modal existed the six columns that row shows — unit, customer, location,
 * name, job number, billing — could not be corrected from payroll at all: the
 * entry PUT refuses while an injected row exists ("un-approve it first") and
 * ?action=resplit answered 400, because its branches only knew turf/paving/
 * kiewit, quarry and hauling.
 *
 * The server half is covered against a real database in
 * test-timesheet-entries-sql.js. This is the client half, which differs from
 * the quarry and trucking modals in one way worth pinning: it pre-fills from
 * the ENTRY rather than from a read of the posted row, because that is where
 * these six columns live and the row is rebuilt from them on every
 * re-injection. So there is no pre-fill round trip, and none of the
 * "still loading — saving now would blank it" guarding those modals need.
 *
 *   1. Structural — the modal markup, the gate, and the save's endpoint.
 *   2. Behavioural — openEesModal / eesSave run in a vm against a stubbed DOM.
 *
 * No DB, no browser.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'payroll.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// 1) STRUCTURAL
// ─────────────────────────────────────────────────────────────────────
console.log('\n[structural — payroll.html]');
assert('the modal backdrop exists',   /<div class="modal-backdrop" id="eesBackdrop">/.test(HTML));
assert('it has a save button',        /id="eesSaveBtn" onclick="eesSave\(\)"/.test(HTML));
assert('the row button opens it',     /entryNeedsEes\(e\) \? `<button[^`]*openEesModalById\('\$\{e\.id\}'\)/.test(HTML));
assert('the gate mirrors the server',
  /function entryNeedsEes\(e\) \{[\s\S]{0,240}?EES_JOB_IDS\.includes\(String\(e\.job_id\)\)/.test(HTML));
assert('entryNeedsTrucking still excludes EES jobs',
  /return e\.division === 'dust' && !!e\.job_id && !EES_JOB_IDS\.includes\(String\(e\.job_id\)\);/.test(HTML));
assert('the save posts to resplit',
  /action=resplit&id=' \+ encodeURIComponent\(eesEntry\.id\)/.test(HTML));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL
// ─────────────────────────────────────────────────────────────────────
const scriptMatch = HTML.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('could not find the inline <script>'); process.exit(1); }

function makeElement(id) {
  const classes = new Set();
  return {
    id, value: '', innerHTML: '', textContent: '',
    hidden: false, checked: false, disabled: false, style: {}, dataset: {},
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
                           else if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    addEventListener() {}, removeEventListener() {},
    scrollIntoView() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild(c) { return c; }, remove() {},
  };
}
const els = new Map();
function el(id) { if (!els.has(id)) els.set(id, makeElement(id)); return els.get(id); }

const storage = new Map([
  ['fct_token', 'test-token'],
  ['fct_user', JSON.stringify({ username: 'tester', isPlatformAdmin: true, allowedDivisions: ['payroll'] })],
]);

const posts = [];
let reply = { ok: true, status: 200, json: async () => ({ ok: true, entry: null }) };
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  localStorage: {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  },
  document: {
    getElementById: el,
    querySelector: sel => (sel === '.table-wrap' ? makeElement('tw') : null),
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeElement('body'),
  },
  window: { location: { replace() {}, href: '' }, addEventListener() {} },
  setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  clearTimeout: () => {},
  fetch: async (url, opts) => {
    posts.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return reply;
  },
  alert(m) { sandbox.__alert = m; },
  confirm: () => true,
  Date, Math, JSON, Number, String, Array, Object, Set, Map, Boolean, Error, isNaN,
  parseInt, parseFloat, URLSearchParams,
};
sandbox.globalThis = sandbox;
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;

const ctx = vm.createContext(sandbox);
try { vm.runInContext(scriptMatch[1], ctx, { filename: 'payroll-inline.js' }); }
catch (err) { console.error('\n  ✗ inline script threw while loading: ' + err.message); process.exit(1); }
const run = src => vm.runInContext(src, ctx);

const ENTRY = {
  id: 'ees-1', username: 'barrmike', entry_type: 'daily', division: 'dust',
  job_id: 'ees:preloading', job_label: 'EES - Pre Loading',
  work_date: '2026-08-31', status: 'approved',
  computed_hours: 8, travel_hours: 0, start_time: '07:00', end_time: '15:00',
  supervisor_name: 'reeferscott', notes: 'PRE LOADED TRUCK',
  ees_unit: 'T-12', ees_customer: 'Environmental Energy Services',
  ees_location: 'EES', ees_name: 'Contact', ees_job_number: 'J-900',
  ees_billing: 'Billable',
};

console.log('\n[the gate]');
const gate = e => run(`entryNeedsEes(${JSON.stringify(e)})`);
assert('a Pre Loading day is in',  gate(ENTRY) === true);
assert('a Washing day is in',      gate(Object.assign({}, ENTRY, { job_id: 'ees:washing' })) === true);
assert('a customer haul is out',   gate(Object.assign({}, ENTRY, { job_id: 'penn-energy' })) === false);
assert('a dust day with no job is out', gate(Object.assign({}, ENTRY, { job_id: null })) === false);
assert('trucking is out',          gate(Object.assign({}, ENTRY, { division: 'trucking' })) === false);
assert('time off is out',          gate(Object.assign({}, ENTRY, { entry_type: 'time_off' })) === false);
// The two gates must partition every dust day with a job, or one is unreachable.
const truck = e => run(`entryNeedsTrucking(${JSON.stringify(e)})`);
assert('EES and trucking never both claim a day',
  !(gate(ENTRY) && truck(ENTRY))
  && !(gate(Object.assign({}, ENTRY, { job_id: 'penn-energy' }))
       && truck(Object.assign({}, ENTRY, { job_id: 'penn-energy' }))));
assert('and between them they claim every dust day with a job',
  gate(ENTRY) || truck(ENTRY));

console.log('\n[opening the modal fills the boxes from the entry]');
run(`allEntries = [${JSON.stringify(ENTRY)}]; filtered = allEntries.slice();`);
run(`openEesModalById('ees-1')`);
assert('the backdrop opens',   el('eesBackdrop').classList.contains('open'));
assert('the title names the day',
  /barrmike/.test(el('eesTitle').textContent) && /Aug 31/.test(el('eesTitle').textContent),
  el('eesTitle').textContent);
assert('the summary names the activity', /Pre Loading/.test(el('eesSummary').innerHTML));
assert('the summary says the rate is the office\'s',
  /Rate:.*dust office/s.test(el('eesSummary').innerHTML));
const fields = el('eesFields').innerHTML;
assert('unit is pre-filled',       /id="ees_unit"[^>]*value="T-12"/.test(fields), fields.slice(0, 200));
assert('customer is pre-filled',   /value="Environmental Energy Services"/.test(fields));
assert('job number is pre-filled', /id="ees_job_number"[^>]*value="J-900"/.test(fields));
assert('billing shows the entry\'s value',
  /<option value="Billable" selected>/.test(fields), fields.slice(-300));

console.log('\n[a blank customer says which label the row will fall back to]');
run(`allEntries = [${JSON.stringify(Object.assign({}, ENTRY, { ees_customer: '' }))}]; filtered = allEntries.slice();`);
run(`openEesModalById('ees-1')`);
assert('the placeholder is the job label',
  /id="ees_customer"[^>]*placeholder="EES - Pre Loading"/.test(el('eesFields').innerHTML),
  el('eesFields').innerHTML.slice(0, 400));

console.log('\n[saving posts the six columns to resplit]');
run(`allEntries = [${JSON.stringify(ENTRY)}]; filtered = allEntries.slice();`);
run(`openEesModalById('ees-1')`);
// What payroll typed over the pre-filled boxes.
el('ees_unit').value       = 'T-99';
el('ees_customer').value   = 'EES';
el('ees_location').value   = 'Pad 4';
el('ees_name').value       = 'Mike';
el('ees_job_number').value = 'J-901';
el('ees_billing').value    = 'Non-Billable';
posts.length = 0;
run(`eesSave()`);
// eesSave is async; let its awaited fetch settle.
(async () => {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert('exactly one request', posts.length === 1, JSON.stringify(posts));
  const req = posts[0] || {};
  assert('it is a resplit for this entry',
    /action=resplit&id=ees-1/.test(req.url || ''), req.url);
  assert('it carries the six columns under `ees`', req.body && req.body.ees
    && req.body.ees.unit === 'T-99' && req.body.ees.customer === 'EES'
    && req.body.ees.location === 'Pad 4' && req.body.ees.name === 'Mike'
    && req.body.ees.job_number === 'J-901' && req.body.ees.billing === 'Non-Billable',
    JSON.stringify(req.body));
  // The rate is the dust office's column; payroll's modal must not send one,
  // or the server would have a value to write over it.
  assert('and no rate', req.body && req.body.ees && !('rate' in req.body.ees),
    JSON.stringify(req.body));

  console.log('\n[a failed save says so and keeps the modal open]');
  reply = { ok: false, status: 400, json: async () => ({ error: 'billing must be one of: Non-Billable, Billable' }) };
  run(`openEesModalById('ees-1')`);
  posts.length = 0;
  run(`eesSave()`);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert('the error is shown', /billing must be one of/.test(el('eesMsg').textContent),
    el('eesMsg').textContent);
  assert('the modal stays open', el('eesBackdrop').classList.contains('open'));
  assert('the save button is re-enabled', el('eesSaveBtn').disabled === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
