#!/usr/bin/env node
'use strict';
/**
 * The "lunch −0.50" note under the HOURS figure in payroll.html.
 *
 * Run: node scripts/test-payroll-lunch-note.js
 *
 * An entry's computed_hours is stored ALREADY net of the day's 30-minute
 * unpaid break (api/timesheet-entries.js), while travel_hours is not. On a
 * split day the whole day's deduction lands on job 1, so a short first block
 * reads 1.00 against a 07:30–09:00 window that is plainly an hour and a half —
 * and until now the only thing on screen that admitted why was the Lunch Break
 * pill's tooltip, which nobody hovers while scanning a column of numbers. The
 * owner hit exactly that and read the row as an arithmetic error.
 *
 * What this pins:
 *
 *   1. The note appears on precisely the rows that carry the deduction, and on
 *      no others — a note on a sibling whose hours DO match its punches would
 *      explain a discrepancy that row does not have.
 *   2. The arithmetic in the tooltip is the real subtraction, including the
 *      overnight wrap, so the figure it names is the one the server stored.
 *   3. It is wired into the HOURS cell of renderRows(), not merely defined —
 *      the failure mode of a display helper is that it exists and is never
 *      called.
 *   4. The text is escaped, because the tooltip interpolates stored fields.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'payroll.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── Lift the page's own helpers ────────────────────────────────────────────
const ctx = vm.createContext({
  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
});
vm.runInContext(
  'const LUNCH_DEDUCTION_HOURS = 0.5;\n'
  + requireFn(SRC, 'clockSpanHours', 'payroll.html') + '\n'
  + requireFn(SRC, 'lunchNoteHtml', 'payroll.html'), ctx);
const clockSpanHours = vm.runInContext('clockSpanHours', ctx);
const lunchNoteHtml  = vm.runInContext('lunchNoteHtml',  ctx);

const daily = o => Object.assign({ entry_type: 'daily' }, o);

// ── 1. Who gets the note ───────────────────────────────────────────────────
console.log('\nThe note appears on exactly the rows that carry the deduction');

assert('split job 1, lunch yes — noted',
  lunchNoteHtml(daily({ lunch_break: true, computed_hours: 1.0,
    start_time: '07:30', end_time: '09:00', split_index: 1, split_count: 2 })).includes('−0.50 lunch'));

assert('split job 2, lunch no — silent',
  lunchNoteHtml(daily({ lunch_break: false, computed_hours: 6.5,
    start_time: '09:30', end_time: '16:00', split_index: 2, split_count: 2 })) === '',
  'the sibling\'s hours match its own punches — nothing to explain');

assert('single job, lunch yes — noted',
  lunchNoteHtml(daily({ lunch_break: true, computed_hours: 10.0,
    start_time: '07:00', end_time: '17:30' })).includes('−0.50 lunch'));

assert('single job, lunch no — silent',
  lunchNoteHtml(daily({ lunch_break: false, computed_hours: 10.5,
    start_time: '07:00', end_time: '17:30' })) === '');

assert('time off — silent',
  lunchNoteHtml({ entry_type: 'time_off', lunch_break: true }) === '',
  'a time-off row has no clock to reconcile');

assert('legacy row with lunch_break null — silent',
  lunchNoteHtml(daily({ lunch_break: null, computed_hours: 8.0,
    start_time: '07:00', end_time: '15:00' })) === '',
  'null is "never asked", not "no" — it must not assert a deduction that may not have happened');

assert('no entry at all — silent, not a throw',
  lunchNoteHtml(null) === '');

// ── 2. The arithmetic it states ────────────────────────────────────────────
console.log('\nThe tooltip states the real subtraction');

const rowB = lunchNoteHtml(daily({ lunch_break: true, computed_hours: 1.0,
  start_time: '07:30', end_time: '09:00', split_index: 1, split_count: 2 }));
assert('names the gross span the punches imply', rowB.includes('1.50h on the clock'), rowB);
assert('names the net hours the row prints',     rowB.includes('leaving 1.00h'), rowB);
assert('says travel is not lunch-deducted',      rowB.includes('never lunch-deducted'));
assert('says the split takes it once, on job 1',
  rowB.includes('whole day') && rowB.includes('job 1 of this split'), rowB);

assert('a single job says nothing about splits',
  !lunchNoteHtml(daily({ lunch_break: true, computed_hours: 10.0,
    start_time: '07:00', end_time: '17:30' })).includes('split'));

assert('overnight shift wraps rather than going negative',
  clockSpanHours('22:00', '06:00') === 8,
  String(clockSpanHours('22:00', '06:00')));
assert('overnight tooltip reads 8.00 → 7.50',
  lunchNoteHtml(daily({ lunch_break: true, computed_hours: 7.5,
    start_time: '22:00', end_time: '06:00' })).includes('8.00h on the clock'));

assert('a missing clock still states the rule, without inventing a span',
  (() => {
    const out = lunchNoteHtml(daily({ lunch_break: true, computed_hours: 7.5,
      start_time: null, end_time: null }));
    return out.includes('−0.50 lunch')
      && out.includes('already net of')
      && !out.includes('on the clock');
  })());

assert('clockSpanHours caps at 24h and rejects junk',
  clockSpanHours('bad', '09:00') === null && clockSpanHours('07:30', '') === null);

// ── 3. Wired into the HOURS cell ───────────────────────────────────────────
console.log('\nIt is actually rendered');

assert('renderRows computes the note per row',
  /const lunchNote = lunchNoteHtml\(e\);/.test(SRC));
assert('the HOURS <td> emits it',
  /\$\{hours\}\$\{hoursMarker\}\$\{lunchNote\}<\/td>/.test(SRC),
  'the note must land in the hours cell, beside the number it explains');
assert('.hours-lunch is styled',
  /\.hours-lunch\s*\{/.test(SRC));
assert('the note is muted, not another amber flag',
  /\.hours-lunch\s*\{[^}]*color:\s*var\(--muted\)/.test(SRC),
  'amber is reserved for prevailing wage and the hours-mismatch flag');

// ── 4. Escaping ────────────────────────────────────────────────────────────
console.log('\nStored fields reach the tooltip escaped');

const nasty = lunchNoteHtml(daily({ lunch_break: true, computed_hours: 1.0,
  start_time: '07:30" onmouseover="alert(1)', end_time: '09:00' }));
assert('a quote in a stored time cannot break out of title=',
  !/title="[^"]*"\s+onmouseover/.test(nasty), nasty);
assert('the apostrophe in "day\'s" is escaped, not raw',
  rowB.includes('&#39;') && !/title="[^"]*day's/.test(rowB));

// ── 5. TOTAL spells out the sum it is ──────────────────────────────────────
console.log('\nTOTAL says what it is made of');

vm.runInContext(requireFn(SRC, 'totalTitleAttr', 'payroll.html'), ctx);
const totalTitleAttr = vm.runInContext('totalTitleAttr', ctx);

const totB = totalTitleAttr(daily({ lunch_break: true, split_index: 1, split_count: 2 }), 1.0, 1.5);
assert('states the addition behind the figure',
  totB.includes('1.00h worked + 1.50h travel = 2.50h'), totB);
assert('says the lunch is already off the worked side',
  totB.includes('already off the worked hours'), totB);
assert('on a split, names the job that carried it',
  totB.includes('taken on job 1, the job it fell in'), totB);

const totA = totalTitleAttr(daily({ lunch_break: false, split_index: 2, split_count: 2 }), 6.5, 1.5);
assert('a row with no deduction states the sum and stops there',
  totA.includes('6.50h worked + 1.50h travel = 8.00h') && !totA.includes('lunch'), totA);

assert('renders as a title attribute, escaped',
  /^ title="[^"]*"$/.test(totB) && totB.includes('&#39;'), totB);
assert('time off gets no tooltip',
  totalTitleAttr({ entry_type: 'time_off' }, null, null) === '');
assert('an entry with neither side gets no tooltip',
  totalTitleAttr(daily({ lunch_break: true }), null, null) === '');
assert('travel-only day still adds up',
  totalTitleAttr(daily({ lunch_break: false }), null, 2).includes('0.00h worked + 2.00h travel = 2.00h'));
assert('the TOTAL <td> carries it',
  /tabular-nums"\$\{totalTitleAttr\(e, workH, travelH\)\}><strong>\$\{total\}/.test(SRC));

// ── 6. The printed report's pill finally names the cost ────────────────────
console.log('\nThe printed Hours Report pill names the deduction');

assert('its yes-tooltip says 30 minutes',
  /Took a lunch break — 30 minutes already deducted from this day/.test(SRC));
assert('its no-tooltip names whichever job took the break',
  /lunchNoTitle\(e\)\)\}<\/td>/.test(SRC)
  && /the day's 30-minute lunch is deducted on /.test(SRC),
  'the printed report shares the grid\'s holder lookup rather than naming job 1');
assert('the report row gained no extra line or column',
  (() => {
    const i = SRC.indexOf('<td class="date">${prettyDate(e.work_date)}</td>');
    const row = SRC.slice(i, SRC.indexOf('</tr>', i));
    return (row.match(/<td[\s>]/g) || []).length === 14;
  })(),
  'the landscape page has no room to spare — see scripts/test-report-width.js');

// ── 7. One idiom for the deduction, everywhere the page names it ──────────
console.log('\nThe deduction is worded the same way throughout');

assert('the grid hint uses the trucking modal\'s "−0.50 lunch" wording',
  /`−\$\{LUNCH_DEDUCTION_HOURS\.toFixed\(2\)\} lunch<\/div>`/.test(SRC));
assert('the haul gloss is written once, not per branch',
  (SRC.match(/push\(`−\$\{num2\(lunch\)\} lunch`\)/g) || []).length === 1,
  'two copies of the wording is two places for it to drift');

// The unsplit branch used to name a lunch-deducted total in silence.
const glossSrc = SRC.slice(SRC.indexOf('const billsGloss ='), SRC.indexOf('// The per-leg hours readouts'));
assert('both haul branches gloss the figure they print',
  (glossSrc.match(/billsGloss\(travel, lunch\)/g) || []).length === 2, glossSrc.slice(0, 200));

const billsGloss = vm.runInContext(
  'const num2 = n => Number(n).toFixed(2);'
  + SRC.slice(SRC.indexOf('const billsGloss ='), SRC.indexOf('};', SRC.indexOf('const billsGloss =')) + 2)
  + 'billsGloss', ctx);
assert('names both carried figures', billsGloss(1.5, 0.5) === ' (+1.50 travel, −0.50 lunch)', billsGloss(1.5, 0.5));
assert('lunch alone', billsGloss(0, 0.5) === ' (−0.50 lunch)', billsGloss(0, 0.5));
assert('travel alone', billsGloss(1.5, 0) === ' (+1.50 travel)', billsGloss(1.5, 0));
assert('neither — no empty parenthesis', billsGloss(0, 0) === '', JSON.stringify(billsGloss(0, 0)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
