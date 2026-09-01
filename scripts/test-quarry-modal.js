#!/usr/bin/env node
'use strict';
/**
 * Payroll's cost-tracking modals — the guards that stop a save writing over a
 * row it never managed to read.
 *
 * Run: node scripts/test-quarry-modal.js
 *
 * Editing an approved quarry entry works by pre-fill: the modal opens on blank
 * boxes, then fetches the row the entry already injected (?action=split) and
 * re-renders from it. Saving posts whatever is in the boxes, and the server
 * rewrites the injected row from that — so any path where the pre-fill silently
 * does not happen is a path where Save wipes the rate, equipment, task, fuel and
 * quantities the quarry office bills from.
 *
 * Three of those paths existed:
 *   - the lookup answered 403 or 500, whose JSON body parses like any other and
 *     was read as "this entry has no row",
 *   - the lookup threw, and the catch kept the blank boxes,
 *   - a lookup for one entry landed after the modal had moved to another.
 *
 * The turf/paving Edit Split modal fails the same way and worse: it falls back
 * to its own defaults — one labor row for the whole day — which are a perfectly
 * valid split, so the save lands, reports success, and replaces every cost code,
 * sub code, quantity and equipment line the supervisor had entered.
 *
 * Two layers, following test-dust-split-modal.js:
 *   1. Structural — the guards exist and sit in the right order in payroll.html,
 *      for both modals.
 *   2. Behavioural — quarrySave itself is run in a vm against a stubbed DOM, and
 *      asserted to refuse exactly when the posted row is unknown, and to go
 *      through when it is known or when there is nothing to know.
 *
 * The fuel boxes are covered here too, for a different failure: the form used to
 * take a dollar TOTAL and derive $/gal, supervisors read "Fuel Cost ($)" as the
 * pump price, and 190 gallons at a typed 4.50 was stored as $0.0237/gal — $4.50
 * of fuel for a day that burned $855. The typed box is the per-gallon price now.
 *
 * No DB, no browser.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const SRC = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');
function slice(from, to, label) {
  const a = SRC.indexOf(from);
  const b = a < 0 ? -1 : SRC.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : to})`);
  return SRC.slice(a, b);
}

console.log('Payroll cost-tracking modal guards\n');

// ── 1) Structural ───────────────────────────────────────────────────────────
console.log('[the pre-fill cannot be mistaken for an empty row]');
{
  const open = slice('async function openQuarryModal(entry, mode)', '\n    function closeQuarry()', 'openQuarryModal');
  assert('a refusal is thrown rather than read as "no row"',
    /if \(!res\.ok\) throw new Error/.test(open));
  assert('…before anything is taken from the body',
    open.includes('if (!res.ok) throw') && open.includes("quarryRowLoad = 'loaded'")
    && open.indexOf('if (!res.ok) throw') < open.indexOf("quarryRowLoad = 'loaded'"));
  assert('a late answer for another entry is dropped',
    /const seq = \+\+quarryFetchSeq/.test(open) && /if \(seq !== quarryFetchSeq\) return/.test(open));
  assert('and a failure is recorded rather than swallowed',
    /quarryRowLoad = 'failed'/.test(open) && !/keep blank fields on lookup failure/.test(open));
  assert('a fresh approve has nothing to load',
    /quarryRowLoad = mode === 'resplit' \? 'pending' : 'none'/.test(open));

  const close = slice('function closeQuarry()', 'bindBackdropClose(document.getElementById(\'quarryBackdrop\')', 'closeQuarry');
  assert('closing orphans a pre-fill still in flight',
    /quarryFetchSeq\+\+/.test(close) && /quarryRowLoad = 'none'/.test(close));

  const save = slice('async function quarrySave()', '\n    // ──', 'quarrySave');
  assert('the save refuses while the posted row is unknown',
    /quarryRowLoad === 'pending' \|\| quarryRowLoad === 'failed'/.test(save));
  assert('…before it collects a single box',
    save.includes("quarryRowLoad === 'pending'")
    && save.indexOf("quarryRowLoad === 'pending'") < save.indexOf('collectQuarryFields(activity)'));
}

// ── 2) Behavioural ──────────────────────────────────────────────────────────
// quarrySave, run for real. Everything it reaches for is stubbed; the only
// thing under test is whether it posts.
function runSave(rowLoad, mode) {
  const boxes = {
    q_equipmentName: { value: 'Loader' }, q_taskName: { value: 'Stripping' },
    q_rate: { value: '42' }, q_fuelGallons: { value: '0' }, q_fuelPerGal: { value: '0' },
    q_hours: { value: '8' }, q_tons: { value: '' }, q_comments: { value: '' },
    quarrySaveBtn: { textContent: '', disabled: false },
    quarryMsg: {
      textContent: '', className: '',
      classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
    },
  };
  const posts = [];
  const ctx = {
    quarryEntry: { id: 7, username: 'strickallen', job_id: 'quarry:daily:homer', division: 'quarry' },
    quarryMode: mode,
    quarryRowLoad: rowLoad,
    quarryActivityOf: () => 'daily',
    collectQuarryFields: () => ({ equipmentName: 'Loader', taskName: 'Stripping', rate: '42' }),
    authHeaders: () => ({}),
    applyEntryUpdate: () => {}, renderRows: () => {}, renderStats: () => {},
    closeQuarry: () => {}, setTimeout: () => {},
    selectedIds: new Set(),
    _qval: id => (boxes[id] ? boxes[id].value : ''),
    fetch: (url, init) => {
      posts.push({ url, init });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, entry: null }) });
    },
    document: { getElementById: id => boxes[id] || null },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(slice('async function quarrySave()', '\n    // ──', 'quarrySave') + '\nquarrySave();', ctx);
  return { posts, msg: boxes.quarryMsg };
}

console.log('\n[what Save does when the row it should be correcting is unknown]');
{
  // Still in flight. The boxes are blank for a reason that has nothing to do
  // with the row, so posting them would blank the row.
  const pending = runSave('pending', 'resplit');
  assert('a save while the lookup is in flight posts nothing', pending.posts.length === 0);
  assert('and says to try again in a moment',
    /Still loading/.test(pending.msg.textContent) && pending.msg.classList.contains('error'),
    pending.msg.textContent);

  // The lookup failed — a refusal, a 500, or the network. Same blank boxes.
  const failed = runSave('failed', 'resplit');
  assert('a save after a failed lookup posts nothing', failed.posts.length === 0);
  assert('and says to reopen Edit Row',
    /close and reopen Edit Row/.test(failed.msg.textContent), failed.msg.textContent);
}

console.log('\n[and when it is known, or there is nothing to know]');
{
  const loaded = runSave('loaded', 'resplit');
  assert('an edit whose row came back saves normally', loaded.posts.length === 1);
  assert('as a resplit', /action=resplit/.test(loaded.posts[0].url), loaded.posts[0] && loaded.posts[0].url);

  // A fresh approve has no posted row to wipe: blank means blank there, exactly
  // as it always has.
  const fresh = runSave('none', 'approve');
  assert('a fresh approve is never blocked', fresh.posts.length === 1);
  assert('as an approve', /action=approve/.test(fresh.posts[0].url), fresh.posts[0] && fresh.posts[0].url);
}

// ── 3) Which fuel box is typed, and which is derived ────────────────────────
// quarryFieldsHtml / recalcQuarryFuelCost / collectQuarryFields, run for real
// against stubbed boxes. Getting this backwards is the bug they exist to stop.
function fuelCtx(boxes) {
  const ctx = {
    escapeHtml: v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    num2: n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2),
    Q_LABEL_STYLE: 'label', Q_INPUT_STYLE: 'input', Q_RO_STYLE: 'input;readonly-look',
    QUARRY_DEFAULT_RATE: 26,
    quarryEntry: { username: 'boringjamey' },
    quarryEmployeeRate: () => null,
    quarryEquipOptions: [], quarryTaskOptions: [],
    _qval: id => (boxes[id] ? boxes[id].value : ''),
    document: { getElementById: id => boxes[id] || null },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(
    slice('function _qNumField(id, label, val, span)', '\n    function openQuarryModalById(', 'quarry fuel fields'),
    ctx);
  return ctx;
}
// The <input …> tag carrying `id`, so readonly/value can be asserted per box.
function tagFor(html, id) {
  const m = new RegExp('<input[^>]*id="' + id + '"[^>]*>').exec(html);
  return m ? m[0] : '';
}

console.log('\n[the pump price is typed; the dollar total is the derived one]');
for (const activity of ['crushing', 'daily']) {
  // A row already on file: 190 gallons at $4.50/gal. Crushing keeps the
  // per-gallon rate in fuelCost, Daily in ppg — both hold $/gal, not dollars.
  const stored = activity === 'crushing'
    ? { fuelGallons: 190, fuelCost: 4.5 }
    : { fuelGallons: 190, ppg: 4.5 };
  const html   = fuelCtx({}).quarryFieldsHtml(activity, stored);
  const perGal = tagFor(html, 'q_fuelPerGal');
  const total  = tagFor(html, 'q_fuelCostAuto');

  assert(`${activity}: the $/gal box holds the stored per-gallon rate`,
    /value="4\.5"/.test(perGal), perGal);
  assert(`${activity}: …and is the box that can be typed in`,
    !!perGal && !/readonly/.test(perGal), perGal);
  assert(`${activity}: fuel cost reads gallons × $/gal`,
    /value="855\.00"/.test(total), total);
  assert(`${activity}: …read-only, so the total can't be typed in by mistake`,
    /readonly/.test(total), total);
}

console.log('\n[what the total does as the boxes are filled]');
{
  const boxes = {
    q_fuelGallons:  { value: '190' },
    q_fuelPerGal:   { value: '4.50' },
    q_fuelCostAuto: { value: '' },
  };
  const ctx = fuelCtx(boxes);
  ctx.recalcQuarryFuelCost();
  assert('190 gallons at $4.50 comes to $855.00', boxes.q_fuelCostAuto.value === '855.00',
    boxes.q_fuelCostAuto.value);

  boxes.q_fuelPerGal.value = '';
  ctx.recalcQuarryFuelCost();
  assert('and a half-filled pair shows nothing rather than $0.00',
    boxes.q_fuelCostAuto.value === '', boxes.q_fuelCostAuto.value);
}

console.log('\n[and what Save sends]');
{
  const boxes = {
    q_hourlyRate:   { value: '26' }, q_hoursCrushing: { value: '5' },
    q_loadsToCrusher: { value: '24' }, q_tonsPerLoad: { value: '30' },
    q_fuelGallons:  { value: '190' }, q_fuelPerGal:   { value: '4.50' },
    q_fuelCostAuto: { value: '855.00' }, q_comments:   { value: '' },
    q_equipmentName: { value: 'Crusher' }, q_taskName:  { value: 'Crushing' },
    q_rate:         { value: '26' },
  };
  const ctx = { _qval: id => (boxes[id] ? boxes[id].value : ''), console };
  vm.createContext(ctx);
  vm.runInContext(
    slice('function collectQuarryFields(activity)', '\n    async function quarrySave()', 'collectQuarryFields'),
    ctx);

  const crush = ctx.collectQuarryFields('crushing');
  assert('crushing posts the typed $/gal as its per-gallon fuelCost',
    Number(crush.fuelCost) === 4.5, JSON.stringify(crush.fuelCost));
  const daily = ctx.collectQuarryFields('daily');
  assert('daily posts it as ppg', Number(daily.ppg) === 4.5, JSON.stringify(daily.ppg));

  // The grid and the executive report both cost fuel as gallons × the stored
  // per-gallon rate. That product is the total the modal showed — which is the
  // whole point: what was on screen is what the quarry office gets billed.
  assert('the grid re-derives the $855 the modal showed',
    Number(crush.fuelGallons) * Number(crush.fuelCost) === 855,
    String(Number(crush.fuelGallons) * Number(crush.fuelCost)));
  assert('…and so does Daily',
    Number(daily.fuelGallons) * Number(daily.ppg) === 855,
    String(Number(daily.fuelGallons) * Number(daily.ppg)));
}

console.log('\n[the turf/paving split modal has the same guard]');
{
  const open = slice('async function openSplitModal(entry, mode)', '\n    function closeSplit()', 'openSplitModal');
  assert('a refusal is thrown rather than read as "no split"',
    /if \(!r\.ok\) throw new Error/.test(open));
  assert('the pre-fill records whether it landed',
    /splitRowLoad = 'loaded'/.test(open) && /splitRowLoad = 'failed'/.test(open));
  assert('a late answer for another entry is dropped',
    /const seq = \+\+splitFetchSeq/.test(open) && /if \(seq !== splitFetchSeq\) return/.test(open));
  assert('and a fresh approve has nothing to load',
    /splitRowLoad = mode === 'resplit' \? 'pending' : 'none'/.test(open));

  const close = slice('function closeSplit()', "bindBackdropClose(document.getElementById('splitBackdrop')", 'closeSplit');
  assert('closing orphans a pre-fill still in flight',
    /splitFetchSeq\+\+/.test(close) && /splitRowLoad = 'none'/.test(close));

  const save = slice('async function splitSave()', '\n    // ──', 'splitSave');
  assert('the save refuses while the posted split is unknown',
    /splitRowLoad === 'pending' \|\| splitRowLoad === 'failed'/.test(save));
  // …and before the pre-validation that would otherwise wave the defaults
  // through: one labor row for the whole day passes every check there is.
  assert('before the row checks that would pass the defaults',
    save.includes("splitRowLoad === 'pending'")
    && save.indexOf("splitRowLoad === 'pending'") < save.indexOf('Add at least one row.'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
