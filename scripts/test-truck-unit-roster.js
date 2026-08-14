#!/usr/bin/env node
'use strict';
/**
 * The truck unit roster behind the two Unit boxes.
 *
 * Run: node scripts/test-truck-unit-roster.js
 *
 * A haul's unit is read at the far end BY NAME: the Trucking division's Truck
 * Tracking tab matches a row's unit against that division's unit list to show
 * the truck's number beside it. So "Truck 1000", or 1000 with a stray space,
 * saves fine where it is typed and turns up there unrecognised. Both boxes that
 * can set a unit — the driver's on timesheet.html and payroll's in the approve /
 * Edit Row modal — therefore offer that list and say which side of it the value
 * falls on.
 *
 * Two layers, following test-bid-items-frontend.js:
 *   1. Structural — greps both pages for the wiring: the inputs point at a
 *      datalist, the datalist exists, the note sits under a predictable id, and
 *      the roster is fetched from the cheap ?lists=1 route rather than the full
 *      truck-division GET.
 *   2. Behavioural — runs each page's own note-writing function in a vm against
 *      a mock document and asserts what it says: the number on a match, a
 *      warning on a miss, and SILENCE when the roster is unknown — calling a
 *      good unit unrecognised because the list failed to load would be worse
 *      than saying nothing, and that is a rule living in two files now.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
function slice(src, from, to, label) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : to})`);
  return src.slice(a, b);
}

const PAYROLL   = read('payroll.html');
const TIMESHEET = read('timesheet.html');

// ── 1. Structural ──────────────────────────────────────────────────────────
console.log('\n[payroll.html — the approve / Edit Row modal]');
{
  assert('the Unit input points at a datalist',
    /id="tk_unit"[^>]*list="tk_unitOptions"/.test(PAYROLL));
  assert('and the datalist is emitted with it',
    /<datalist id="tk_unitOptions">\$\{truckUnitOptionsHtml\(\)\}<\/datalist>/.test(PAYROLL));
  assert('a note element rides under the input', /id="tk_unitHint"/.test(PAYROLL));
  assert('the roster comes from the lists-only route, not the full GET',
    /fetch\('\/api\/truck-division\?lists=1'/.test(PAYROLL));
  // The roster arrives asynchronously while the modal is already on screen, so
  // it must never touch the value — that is what the staleness and dirty guards
  // protect, and a roster write would walk straight past both.
  const loader = slice(PAYROLL, 'function truckUnitRosterLoad()', 'function truckUnitOptionsHtml()', 'payroll loader');
  assert('the roster never assigns an input value', !/\.value\s*=/.test(loader), loader.match(/.*\.value\s*=.*/) || '');
  const opener = slice(PAYROLL, 'truckUnitRosterLoad().then', 'Re-edit: pre-fill', 'payroll roster hook');
  assert('when it lands it fills only the options and the note',
    /tk_unitOptions/.test(opener) && /truckUnitHintRefresh\(\)/.test(opener) && !/\.value\s*=/.test(opener));
}

console.log('\n[timesheet.html — the driver\'s form]');
{
  assert('block 0\'s Unit input points at the shared datalist',
    /id="f-truck-unit"[^>]*list="truckUnitOptions"/.test(TIMESHEET));
  assert('so does every extra job block',
    /id="s\$\{i\}-truck-unit"[^>]*list="truckUnitOptions"/.test(TIMESHEET));
  // One list for the page: blocks come and go, the datalist does not.
  assert('the datalist is declared exactly once, outside the blocks',
    (TIMESHEET.match(/<datalist id="truckUnitOptions">/g) || []).length === 1);
  assert('each block\'s note follows the <input id>-hint convention',
    /id="f-truck-unit-hint"/.test(TIMESHEET) && /id="s\$\{i\}-truck-unit-hint"/.test(TIMESHEET));
  assert('the roster comes from the lists-only route here too',
    /fetch\('\/api\/truck-division\?lists=1'/.test(TIMESHEET));
  // Most days on this form are not hauls; none of them should pay for a fetch.
  const onJob = slice(TIMESHEET, 'function onJobChange(i = 0)', '\n    }', 'onJobChange');
  assert('the roster is fetched only once a haul is on screen',
    /if \(isTruck\) \{[\s\S]*truckUnitRosterLoad\(\)/.test(onJob), onJob.slice(0, 200));
  assert('and the note is dropped when the field goes away',
    /else \{[\s\S]*-hint'\)[\s\S]*textContent = ''/.test(onJob));
  // Delegated so blocks added later are covered without re-binding.
  assert('typing is caught by one delegated listener',
    /document\.addEventListener\('input'[\s\S]{0,220}truckUnitHintFor/.test(TIMESHEET));
}

// ── 2. Behavioural ─────────────────────────────────────────────────────────
// Each page writes its note its own way (payroll sets a colour inline, the
// driver's form toggles a class), so both are exercised against the same cases.

function mockDoc(nodes) {
  return {
    getElementById: id => nodes[id] || null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
}
function hintNode() {
  return {
    textContent: '', style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
    },
  };
}

const ROSTER = [
  { name: '1000', number: '21' },
  { name: '2773', number: '17' },
  { name: 'Spare', number: '' },
];

// payroll.html: truckUnitHintRefresh() reads #tk_unit and writes #tk_unitHint.
function payrollHint(rosterValue, inputValue) {
  const src  = slice(PAYROLL, 'function truckUnitHintRefresh()', '// One place that puts fields', 'payroll hint');
  const hint = hintNode();
  const ctx  = {
    truckUnitRoster: rosterValue,
    document: mockDoc({ tk_unit: { id: 'tk_unit', value: inputValue }, tk_unitHint: hint }),
  };
  vm.runInNewContext(src + '\ntruckUnitHintRefresh();', ctx);
  return { text: hint.textContent, amber: hint.style.color === '#fbbf24' };
}

// timesheet.html: truckUnitHintFor(input) writes <input id>-hint.
function driverHint(rosterValue, inputValue) {
  const src   = slice(TIMESHEET, 'function truckUnitHintFor(input)', 'function truckUnitHintsRefresh()', 'driver hint');
  const hint  = hintNode();
  const input = { id: 'f-truck-unit', value: inputValue };
  const ctx   = {
    truckUnitRoster: rosterValue,
    document: mockDoc({ 'f-truck-unit-hint': hint }),
  };
  vm.runInNewContext(src + '\ntruckUnitHintFor(input);', Object.assign(ctx, { input }));
  return { text: hint.textContent, amber: hint.classList.contains('off-list') };
}

for (const [who, hintOf] of [['payroll', payrollHint], ['driver', driverHint]]) {
  console.log(`\n[${who} — what the note says]`);

  let r = hintOf(ROSTER, '1000');
  assert('a unit on the list shows its number', r.text === 'Unit #21' && !r.amber, JSON.stringify(r));

  // The whole point: the office matches by name, and these are the same truck.
  r = hintOf(ROSTER, '  1000  ');
  assert('surrounding space is not a different truck', r.text === 'Unit #21' && !r.amber, JSON.stringify(r));
  r = hintOf(ROSTER, 'spare');
  assert('the match is case-insensitive', !r.amber && /list/.test(r.text), JSON.stringify(r));
  assert('a listed unit with no number still reads as known',
    hintOf(ROSTER, 'Spare').text === (who === 'payroll' ? 'On the Trucking unit list.' : 'On the truck list.'),
    JSON.stringify(hintOf(ROSTER, 'Spare')));

  r = hintOf(ROSTER, 'Truck 1000');
  assert('a near-miss is flagged, in amber', r.amber && /Not on the/.test(r.text), JSON.stringify(r));

  // The rule that matters most, because it is easy to regress into: no answer
  // from the server is NOT an empty roster.
  r = hintOf(null, 'Truck 1000');
  assert('an unknown roster says nothing at all', r.text === '' && !r.amber, JSON.stringify(r));
  r = hintOf([], 'Truck 1000');
  assert('a company with no unit list says nothing either', r.text === '' && !r.amber, JSON.stringify(r));

  r = hintOf(ROSTER, '');
  assert('an empty box says nothing', r.text === '' && !r.amber, JSON.stringify(r));
  r = hintOf(ROSTER, '   ');
  assert('whitespace counts as empty', r.text === '' && !r.amber, JSON.stringify(r));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
