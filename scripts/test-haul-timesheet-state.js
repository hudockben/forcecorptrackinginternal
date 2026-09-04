#!/usr/bin/env node
'use strict';
/**
 * The hauling answer: no default, and it survives the roster call landing late.
 *
 * Run: node scripts/test-haul-timesheet-state.js
 *
 * Two separate ways this control has silently answered itself for the driver.
 *
 * 1. THE LATE ROSTER CALL. timesheet.html learns whether the signed-in user is
 *    a truck driver from /api/timesheet-supervisors, and init() fires that
 *    request CONCURRENTLY with the one that draws the entry cards:
 *
 *        await Promise.all([loadSupervisors(), loadEntries()]);
 *
 *    So there is a real window where the cards are on screen and isDriver is
 *    still null. A driver who tapped a saved draft inside that window had
 *    fillBlockFromEntry store his 'off_site' answer and applyHaulVisibility wipe
 *    it on the very next line — because that function used to clear haulVals
 *    whenever isDriver was not yet TRUE. The flag then arrived true, the control
 *    rendered "No", and saving posted haul_type '' — moving his hours back into
 *    prevailing and re-billing his wage to the job on the next approval.
 *
 *    The fix is that applyHaulVisibility is purely presentational. Nothing needs
 *    the clear: buildPayloads decides what to POST from isDriver directly.
 *
 * 2. THE PRE-LIT "No". The control used to open on "No", so a driver who never
 *    scrolled to it filed exactly the same wrong answer as one who read it and
 *    got it wrong — and afterwards the two were indistinguishable in the data.
 *    A block now starts UNANSWERED (haulVals null, distinct from '' meaning
 *    "not a haul"), renders nothing lit, and buildPayloads refuses to save the
 *    day until the driver picks. That is why setHaul — which records a PICK —
 *    is now separate from renderHaul, which only draws what is already there.
 *
 * Evaluates the real functions out of timesheet.html — no browser needed.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '../timesheet.html'), 'utf8');

function fnSource(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in timesheet.html`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} never closes`);
}

// Just enough DOM for the three buttons and the two classes that carry the
// whole state of this control on screen.
function classList() {
  const s = new Set();
  return {
    add:      c => s.add(c),
    remove:   c => s.delete(c),
    contains: c => s.has(c),
    toggle:   (c, on) => (on === undefined
      ? (s.has(c) ? s.delete(c) : s.add(c))
      : (on ? s.add(c) : s.delete(c))),
  };
}

// A sandbox holding just what these functions touch. Every element is a stub
// that records what it was told.
function sandbox(isDriver, haulVals, blocks = [0], opts = {}) {
  const els = {};
  const el = id => {
    if (els[id]) return els[id];
    const e = { id, style: {}, value: '', classList: classList(),
                querySelectorAll: () => [] };
    if (/seg-haul$/.test(id)) {
      // The real markup opens with `needs` on, which is what an unanswered
      // control looks like before any JS has run.
      e.classList.add('needs');
      e.buttons = ['', 'on_site', 'off_site'].map(v =>
        ({ dataset: { val: v }, classList: classList() }));
      e.querySelectorAll = () => e.buttons;
    }
    return (els[id] = e);
  };
  // The block's division picker, which decides whether the truck question has
  // anywhere to land.
  el('division').value = opts.division || 'turf';
  const sb = {
    console, isDriver, haulVals,
    haulUnits: opts.haulUnits || { 0: '' },
    blockOrder: () => blocks,
    bel: (i, key) => el(i === 0 ? key : `s${i}-${key}`),
    // Only the two that reach past this control are stubbed.
    haulUnitFill(i) { sb.__fillCalls.push(i); },
    equipmentNamesLoad: () => Promise.resolve([]),
    __fillCalls: [],
    __els: els,
  };
  vm.createContext(sb);
  // Everything that renders or writes this control comes across together.
  // Stubbing one of them would let the four drift apart unnoticed, which is the
  // failure this file exists to catch in the first place.
  vm.runInContext(
    `const HAUL_UNIT_DIVISIONS = ['turf','paving','kiewit'];\n` +
    `${fnSource('setHaul')}\n${fnSource('renderHaul')}\n` +
    `${fnSource('applyHaulUnitVisibility')}\n${fnSource('applyHaulVisibility')}`, sb);
  return sb;
}

// Which answer, if any, is lit on a block's control.
function lit(sb, i = 0) {
  // No element at all means renderHaul never ran for that block — which reads
  // the same on screen as nothing lit, and is what a non-driver gets.
  const seg = sb.__els[i === 0 ? 'seg-haul' : `s${i}-seg-haul`];
  const on  = ((seg && seg.buttons) || []).filter(b => b.classList.contains('on'));
  return on.length === 1 ? on[0].dataset.val : (on.length ? '??' : null);
}
const needs = (sb, i = 0) =>
  sb.__els[i === 0 ? 'seg-haul' : `s${i}-seg-haul`].classList.contains('needs');

console.log('\n[nothing is answered for the driver]');

{
  const sb = sandbox(true, { 0: null });
  sb.applyHaulVisibility(0);
  assert('an untouched block lights no answer at all', lit(sb) === null,
    `lit: ${JSON.stringify(lit(sb))}`);
  assert('  and is marked as still needing one', needs(sb) === true);
  assert('  with the "pick one" marker beside the label left up',
    sb.__els['haul-need'].style.display === '');
  assert('  and no truck picker, because nothing says it is a haul',
    sb.__els['row-haul-unit'].style.display === 'none');
}
{
  // "No" is an ANSWER, not the absence of one — '' and null are different
  // states and the control has to show that.
  const sb = sandbox(true, { 0: null });
  sb.setHaul('', 0);
  assert('tapping No stores an explicit "not a haul"', sb.haulVals[0] === '');
  assert('  lights the No segment', lit(sb) === '');
  assert('  drops the needs-an-answer marking', needs(sb) === false);
  assert('  and hides the "pick one" marker',
    sb.__els['haul-need'].style.display === 'none');
}
{
  const sb = sandbox(true, { 0: null });
  sb.setHaul('off_site', 0);
  assert('tapping To & from stores it', sb.haulVals[0] === 'off_site');
  assert('  and lights that segment alone', lit(sb) === 'off_site');
  assert('  and reveals the truck picker', sb.__els['row-haul-unit'].style.display === 'flex');
}
{
  // Re-rendering an unanswered block must not answer it. This is the split
  // between setHaul and renderHaul, and the reason for it.
  const sb = sandbox(true, { 0: null });
  sb.applyHaulVisibility(0);
  sb.applyHaulVisibility();
  sb.applyHaulVisibility(0);
  assert('re-rendering a blank block never fills in "No" for him',
    sb.haulVals[0] === null, `haulVals[0] = ${JSON.stringify(sb.haulVals[0])}`);
}

console.log('\n[the roster call has not landed yet — isDriver is null]');

{
  // fillBlockFromEntry stores the saved answer, then calls applyHaulVisibility.
  const sb = sandbox(null, { 0: 'off_site' });
  sb.applyHaulVisibility(0);
  assert('a saved off-site haul survives being rendered while the flag is unknown',
    sb.haulVals[0] === 'off_site', `haulVals[0] = ${JSON.stringify(sb.haulVals[0])}`);
  assert('  and the question stays hidden, because we do not know yet',
    sb.__els['row-haul'].style.display === 'none');
}
{
  const sb = sandbox(null, { 0: 'on_site' });
  sb.applyHaulVisibility();
  assert('the same holds for the whole-form pass', sb.haulVals[0] === 'on_site');
}

console.log('\n[the flag arrives — the control shows what was saved]');

{
  // The real sequence: render at null, then loadSupervisors resolves true and
  // applyHaulVisibility() runs again over every block.
  const sb = sandbox(null, { 0: 'off_site' });
  sb.applyHaulVisibility(0);
  sb.isDriver = true;
  sb.applyHaulVisibility();
  assert('the driver sees the answer he actually saved, not "No"',
    sb.haulVals[0] === 'off_site' && lit(sb) === 'off_site',
    `haulVals[0] = ${JSON.stringify(sb.haulVals[0])}, lit = ${JSON.stringify(lit(sb))}`);
  assert('  and the question is now shown',
    sb.__els['row-haul'].style.display === 'flex');
}

console.log('\n[a non-driver]');

{
  const sb = sandbox(false, { 0: null });
  sb.applyHaulVisibility();
  assert('never sees the question', sb.__els['row-haul'].style.display === 'none');
  assert('  and the control is never rendered for them at all',
    sb.__els['seg-haul'] === undefined && lit(sb) === null);
  assert('  and the truck picker stays hidden too',
    sb.__els['row-haul-unit'].style.display === 'none');
}

console.log('\n[the form starts, adds and resets blocks unanswered]');

// Source-pinned: these three are the only places a block's answer is seeded,
// and a stray '' in any of them puts the pre-lit "No" straight back.
assert('block 0 starts unanswered', /let haulVals\s*=\s*\{ 0: null \};/.test(src));
assert('a job block added mid-form starts unanswered',
  /equipVals\[i\] = null;\s*\n\s*haulVals\[i\]\s*=\s*null;/.test(src));
assert('resetForm clears back to unanswered',
  /haulVals\s*=\s*\{ 0: null \};\s*\n\s*haulUnits\s*=\s*\{ 0: '' \};/.test(src));
assert('a saved entry re-opens on the answer it was stored with',
  /haulVals\[i\] = e\.haul_type \|\| '';/.test(src));

console.log('\n[what actually gets posted is decided by isDriver, not by haulVals]');

// This is why applyHaulVisibility does not need to clear anything: buildPayloads
// reads isDriver directly. Pinned as source, because the three branches are the
// contract the fix above relies on.
const build = src.slice(src.indexOf('function buildPayloads('),
                        src.indexOf('function buildPayloads(') + 12000);
assert('a driver cannot save the day with the question unanswered',
  /if \(isDriver && haulVals\[i\] == null\) \{/.test(build)
  && /Was this a haul\? Pick No, On site or To & from\./.test(build));
assert('unknown roster (null) posts NO haul_type key, so the server keeps what it has',
  /haulKey: isDriver === null \? \{\}/.test(build));
assert('a non-driver posts an explicit empty answer, which clears any stale value',
  /const _haul\s*=\s*isDriver \? \(haulVals\[i\] \|\| ''\) : '';/.test(build)
  && /\{ haul_type: _haul \}/.test(build));
assert('the payload spreads that key rather than always sending the field',
  /\}, b\.haulKey, splitTagFor\(/.test(build));

// The truck rides on truck_unit, but only for a haul on a division whose cost
// row has an equipment column to receive it. null means "not mine" and leaves
// the trucking/dust rules that own that field untouched.
assert('the truck is only sent for a haul on a cost-tracking division',
  /_haulUnit\s*=\s*\(isDriver && _haul && HAUL_UNIT_DIVISIONS\.includes\(div\)\)/.test(build));
assert('  and is null otherwise, so trucking and dust keep that column',
  /\?\s*\(haulUnits\[i\] \|\| ''\) : null;/.test(build));
assert('  with the trucking path used whenever it is null',
  /b\.haulUnit != null\s*\n\s*\? b\.haulUnit/.test(build));

// And the guard itself: a render function that writes to haulVals is the bug.
for (const name of ['applyHaulVisibility', 'renderHaul']) {
  const fn = fnSource(name);
  assert(`${name} never assigns to haulVals — it only renders`,
    !/haulVals\s*\[[^\]]*\]\s*=/.test(fn), fn);
}

console.log('\n[the three answers do not look alike]');

// The other half of the same complaint: every answer on this form lit the same
// teal, so "lit" read as "answered" and nobody read WHICH. One hue each.
for (const [val, hue] of [['', '--blue'], ['on_site', '--yellow'], ['off_site', '--green']]) {
  const re = new RegExp(`\\.seg\\.seg-3 button\\[data-val="${val}"\\]\\.on\\s*\\{[^}]*var\\(${hue}\\)`);
  assert(`"${val || 'No'}" lights its own colour (${hue})`, re.test(src));
}
assert('an unanswered control is outlined rather than just dark',
  /\.seg\.seg-3\.needs \{[^}]*border-style: dashed;/.test(src));
assert('both the first block and a split block open needing an answer',
  (src.match(/class="seg seg-3 needs"/g) || []).length === 2);
assert('and both spell out what On site and To & from mean',
  (src.match(/On site = you hauled within the job\./g) || []).length === 2);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
