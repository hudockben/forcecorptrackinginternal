#!/usr/bin/env node
'use strict';
/**
 * Days worked — the green cost-code header, the printed reports, and the
 * turf page's per-sub-code column
 *
 * Run: node scripts/test-bid-group-days.js
 *
 * Everywhere this figure appears it is one thing: a count of DISTINCT DATES
 * booked to the sub codes in question. That is the only reading that
 * survives the two ways a naive count goes wrong:
 *   - a gap between work days is not worked time (the 1st and the 5th are
 *     two days, not five)
 *   - two sub codes worked on the same date are one day on the job, so the
 *     sub codes' own day counts cannot simply be added up — which is why
 *     the group figure is counted across the group, never summed from the
 *     rows under it
 *
 * Two layers, matching the house style of the other frontend tests:
 *   1. Behavioural — evaluates the real day-counting out of each division
 *      page against fixtures.
 *   2. Structural — the green header renders it off the same visible sub
 *      codes the percent badge speaks for, both printed reports carry it,
 *      and on turf the Days Worked column that replaced the historical
 *      estimate left none of that estimate behind.
 */

const fs   = require('fs');
const path = require('path');

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

/* Lift one top-level function out of the page by brace-matching its body.
   Brace matching starts after the parameter list, not at the first `{` in the
   source — a default parameter puts a brace in the signature. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let paren = 0, i = src.indexOf('(', start);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

function load(src) {
  return new Function(`
    let _proj = null;
    function setProj(p) { _proj = p; }
    function getProj() { return _proj; }
    function getAllDailyRows() { return []; }
    ${extractFunction(src, '_rowIsWorkDay')}
    ${extractFunction(src, '_workDaysForItems')}
    ${extractFunction(src, 'daysWorkedForGroup')}
    ${extractFunction(src, '_bidGroupDaysHTML')}
    return { _workDaysForItems, daysWorkedForGroup, _bidGroupDaysHTML, setProj };
  `)();
}

// ── Fixtures — Storm Water Construction ─────────────────────────────────────
const CC = 'Storm Water Construction';
const item = sub => ({ cost_code: CC, sub_code: sub });
const GROUP = [item('Trench Drain Excavation'), item('Structure Excavation'), item('Drain Geo Fabric')];

// A crew day: hours booked against a sub code.
const day = (date, sub, extra = {}) =>
  Object.assign({ date, cost_code: CC, sub_code: sub, labor_hours: 8, quantity: 0 }, extra);

for (const file of FILES) {
  console.log(`\n[${file}]`);
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const { _workDaysForItems, daysWorkedForGroup, _bidGroupDaysHTML, setProj } = load(src);
  const days = (rows, items = GROUP) => { setProj({ id: 'p1', dailyRows: rows }); return daysWorkedForGroup(items, 'p1'); };
  const dates = (rows, items = GROUP) => { setProj({ id: 'p1', dailyRows: rows }); return _workDaysForItems(items, 'p1'); };

  console.log('  — the count itself');
  // The example from the request: two days on one sub code, one on another.
  assert('sub codes add up across the group', days([
    day('2026-08-03', 'Trench Drain Excavation'),
    day('2026-08-04', 'Trench Drain Excavation'),
    day('2026-08-06', 'Structure Excavation'),
  ]) === 3);

  // The failure the count exists to avoid.
  assert('a gap between work days is not worked — Aug 1 and Aug 5 are 2 days', days([
    day('2026-08-01', 'Trench Drain Excavation'),
    day('2026-08-05', 'Trench Drain Excavation'),
  ]) === 2);

  assert('two sub codes on one date count as one day', days([
    day('2026-08-03', 'Trench Drain Excavation'),
    day('2026-08-03', 'Structure Excavation'),
  ]) === 1);

  assert('two crew on one sub code on one date count as one day', days([
    day('2026-08-03', 'Trench Drain Excavation', { employee: 'A. Ruiz' }),
    day('2026-08-03', 'Trench Drain Excavation', { employee: 'K. Boyle' }),
  ]) === 1);

  console.log('  — what counts as a day on the job');
  assert('a quantity-only day counts', days([
    day('2026-08-03', 'Trench Drain Excavation', { labor_hours: 0, quantity: 768 }),
  ]) === 1);
  assert('an equipment-only day counts', days([
    day('2026-08-03', 'Trench Drain Excavation', { labor_hours: 0, equip_hours: 6 }),
  ]) === 1);
  assert('an imported equipment total counts as its day', days([
    day('2026-08-03', 'Trench Drain Excavation', { labor_hours: 0, equip_total_override: 523.29 }),
  ]) === 1);
  // A PO line writes a job row: a date, a supplier and a cost, but no work.
  assert('a material delivery is not a day worked', days([
    { date: '2026-08-02', cost_code: CC, sub_code: '#57 Stone Collector Drain',
      material_cost: '4232.80', units_purchased: '176', field_type: 'Material' },
  ]) === 0);
  assert('the delivery date still counts when the crew also worked it', days([
    { date: '2026-08-02', cost_code: CC, sub_code: '#57 Stone Collector Drain', material_cost: '4232.80' },
    day('2026-08-02', 'Trench Drain Excavation'),
  ]) === 1);
  assert('a row with no date is ignored', days([day('', 'Trench Drain Excavation')]) === 0);

  console.log('  — which rows belong to the group');
  assert('another cost code\'s days do not leak in', days([
    day('2026-08-03', 'Trench Drain Excavation'),
    Object.assign(day('2026-08-07', 'Milling - Labor'), { cost_code: 'Track Milling' }),
  ]) === 1);
  assert('a sub code outside the group does not count', days([
    day('2026-08-03', 'Perimeter Collector Drain 12"'),
  ]) === 0);
  assert('a bid line with only a cost code takes every row under it', days([
    day('2026-08-03', 'Perimeter Collector Drain 12"'),
    day('2026-08-04', 'Anything At All'),
  ], [{ cost_code: CC, sub_code: '' }]) === 2);

  console.log('  — nothing to count');
  assert('no rows → 0', days([]) === 0);
  assert('an empty group → 0', days([day('2026-08-03', 'Trench Drain Excavation')], []) === 0);
  assert('a group of unnamed bid lines → 0',
    days([day('2026-08-03', 'Trench Drain Excavation')], [{ cost_code: '', sub_code: '' }]) === 0);
  assert('no project → 0', (setProj(null), daysWorkedForGroup(GROUP, 'p1')) === 0);

  console.log('  — the badge');
  assert('nothing prints before the first day', _bidGroupDaysHTML(0) === '');
  assert('one day is not "1 days"', /(^|>)1 day worked</.test(_bidGroupDaysHTML(1)), _bidGroupDaysHTML(1));
  assert('more than one is plural', /3 days worked</.test(_bidGroupDaysHTML(3)));
  assert('the tooltip explains the gap rule', /1st and the 5th are 2 days, not 5/.test(_bidGroupDaysHTML(3)));
  assert('the tooltip does not break out of its attribute',
    !/title="[^"]*"[^>]*"/.test(_bidGroupDaysHTML(3).split('\n')[0]));

  console.log('  — the dates behind the count');
  const AUG = [day('2026-08-06', 'Structure Excavation'), day('2026-08-03', 'Trench Drain Excavation'),
               day('2026-08-04', 'Trench Drain Excavation')];
  assert('the dates come back sorted, whatever order the rows are in',
    dates(AUG).join() === '2026-08-03,2026-08-04,2026-08-06', dates(AUG).join());
  assert('the count is just how many there are', dates(AUG).length === days(AUG));
  assert('no days → an empty list, not a null', Array.isArray(dates([])) && dates([]).length === 0);

  console.log('  — wiring');
  const render = extractFunction(src, 'renderBidTable');
  // visItems, not groupItems: a filtered group's header has to speak for the
  // rows on screen, the same rule the percent badge already follows.
  assert('the header counts the visible sub codes',
    (render.match(/const gDaysWorked = daysWorkedForGroup\(visItems, projId\);/g) || []).length === 1);
  assert('the badge reads that one count', /_bidGroupDaysHTML\(gDaysWorked\)/.test(render));
  assert('both the read-only and editable headers print it',
    (render.match(/\$\{gPctHTML\}\$\{gDaysHTML\}/g) || []).length === 2);
  assert('it sits after the percent badge, not before it',
    !/\$\{gDaysHTML\}\$\{gPctHTML\}/.test(render));
  assert('the style it needs ships with the page',
    /\.bid-grp-days \{[^}]*color: var\(--blue\)/.test(src) && /\.bid-grp-days::before/.test(src));

  // ── The printed reports carry the same figure ─────────────────────────────
  console.log('  — the printed reports');
  const pdf = extractFunction(src, 'exportBidPDF');
  const js  = (() => {
    const a = src.indexOf('async function exportJobSummary(projId, opts = {})');
    return src.slice(a, src.indexOf('function exportBidPDF', a));
  })();
  for (const [label, block] of [['bid report', pdf], ['job summary', js]]) {
    assert(`${label}: counts the group's days`,
      /const gDays = daysWorkedForGroup\(g[iI]tems, projId\);/.test(block));
    assert(`${label}: prints them on the cost-code header row`,
      /\$\{gDays\} day\$\{gDays !== 1 \? 's' : ''\} worked/.test(block));
    assert(`${label}: says nothing on a cost code with no days`,
      /\(gDays \? `<span/.test(block));
  }

  // ── The job summary's own Days Worked column ──────────────────────────────
  console.log('  — the job summary column');
  assert('every sub code row counts its own days',
    /const bDays  = daysWorkedForBidItem\(b, projId\);/.test(js) &&
    /<td class="num days">\$\{bDays \? bDays \+ ' day'/.test(js));
  assert('the column is the last one, after Variance',
    /<th class="num">Variance<\/th>\s*<th class="num">Days Worked<\/th>/.test(js));
  // The three roll-up rows each count their own scope. Summing the rows above
  // would double-count a date two sub codes were both worked on.
  assert('the cost-code subtotal prints the group\'s own count',
    /<td class="num days">\$\{gDays \? gDays \+ ' day'/.test(js));
  assert('the project total prints the job\'s own count',
    /<td class="num days">\$\{daysWorked \? daysWorked \+ ' day'/.test(js));
  assert('the top strip counts days the same way the column does',
    /const daysWorked = new Set\(rowsAll\.filter\(_rowIsWorkDay\)\.map\(r => r\.date\)\.filter\(Boolean\)\)\.size;/.test(js));
  assert('the column is styled and explained',
    /td\.days \{ color: #1d4ed8/.test(src) &&
    /Days Worked counts the distinct dates booked to a sub code/.test(js) &&
    /do not add down the column/.test(js));
}

/* The Days Worked column replaced the historical estimate on the turf page —
   the only page that ever carried it. Its machinery has no caller left, and
   dead code that still looks live is worse than no code. */
console.log('\n[turf — the column the estimate gave up]');
const turf = fs.readFileSync(path.resolve(__dirname, '../tracker.html'), 'utf8');
assert('the header names the column for what it now shows',
  /<th class="num" title="Distinct days this sub code has been worked[^"]*">Days Worked<\/th>/.test(turf) &&
  !/Hist\. Estimate/.test(turf));
assert('a sub code counts its own days off the shared rule',
  /function daysWorkedForBidItem\(b, projId\) \{\s*return _workDaysForItems\(\[b\], projId\)\.length;/.test(turf));
assert('the cell prints the count over the span it falls across',
  /\$\{_dCount\} day\$\{_dCount !== 1 \? 's' : ''\}[\s\S]{0,200}_workDaySpanLabel\(_wDays\)/.test(turf));
assert('the span reads as a range, not a second count',
  /\$\{lbl\(dates\[0\]\)\} \\u2013 \$\{lbl\(dates\[dates\.length - 1\]\)\}/.test(turf));
assert('the group total row reads the same count as the header above it',
  /\$\{gDaysWorked \? gDaysWorked \+ ' day'/.test(turf));
assert('the bid footer totals days, not estimated hours',
  /const totalDays = daysWorkedForGroup\(p\.bidItems \|\| \[\], projId\);/.test(turf));
for (const gone of ['_deriveEstFromHist', 'estimateDurationForBidItem', 'applyEstimateToDates', 'gEstHrs', 'totalEstHrs']) {
  assert(`no ${gone} left behind`, !turf.includes(gone), 'still referenced');
}

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
