#!/usr/bin/env node
'use strict';
/**
 * Days worked on the bid view's green cost-code header
 *
 * Run: node scripts/test-bid-group-days.js
 *
 * The header says how far along a cost code is; it now also says how many
 * days have gone into it. The figure is a count of DISTINCT DATES across
 * the cost code's sub codes, which is the only reading that survives the
 * two ways a naive count goes wrong:
 *   - a gap between work days is not worked time (the 1st and the 5th are
 *     two days, not five)
 *   - two sub codes worked on the same date are one day on the job, so the
 *     sub codes' own day counts cannot simply be added up
 *
 * Two layers, matching the house style of the other frontend tests:
 *   1. Behavioural — evaluates the real daysWorkedForGroup out of each
 *      division page against fixtures.
 *   2. Structural — the header renders it, off the same visible sub codes
 *      the percent badge speaks for, and the style it needs exists.
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
    ${extractFunction(src, 'daysWorkedForGroup')}
    ${extractFunction(src, '_bidGroupDaysHTML')}
    return { daysWorkedForGroup, _bidGroupDaysHTML, setProj };
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
  const { daysWorkedForGroup, _bidGroupDaysHTML, setProj } = load(src);
  const days = (rows, items = GROUP) => { setProj({ id: 'p1', dailyRows: rows }); return daysWorkedForGroup(items, 'p1'); };

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

  console.log('  — wiring');
  const render = extractFunction(src, 'renderBidTable');
  // visItems, not groupItems: a filtered group's header has to speak for the
  // rows on screen, the same rule the percent badge already follows.
  assert('the header counts the visible sub codes',
    (render.match(/_bidGroupDaysHTML\(daysWorkedForGroup\(visItems, projId\)\)/g) || []).length === 1);
  assert('both the read-only and editable headers print it',
    (render.match(/\$\{gPctHTML\}\$\{gDaysHTML\}/g) || []).length === 2);
  assert('it sits after the percent badge, not before it',
    !/\$\{gDaysHTML\}\$\{gPctHTML\}/.test(render));
  assert('the style it needs ships with the page',
    /\.bid-grp-days \{[^}]*color: var\(--muted\)/.test(src) && /\.bid-grp-days::before/.test(src));
}

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
