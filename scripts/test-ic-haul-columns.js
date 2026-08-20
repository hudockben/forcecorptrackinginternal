#!/usr/bin/env node
'use strict';
/**
 * Intercompany ▸ Reports ▸ Job Summary — Lowboy / Tri Axle / Equipment split.
 *
 * Run: node scripts/test-ic-haul-columns.js
 *
 * Two things the report used to get wrong:
 *
 *   It keyed the split on the row's JOB CLASS, only considering a row for the
 *   haul columns when the class was 'Trucking'. A lowboy typed straight onto
 *   the daily grid carries the crew's class ('Hourly'), so its cost was billed
 *   as Equipment — Craig Dean's $1,512.50 of lowboy sat inside a $2,902.50
 *   Equipment figure.
 *
 *   It matched tri-axle on a bare 'tri', which is also a substring of
 *   disTRIbutor, sTRIper and elecTRIc. Widening the rule to every row without
 *   fixing that would have swept ordinary paving equipment into Tri Axle.
 *
 * The matchers are lifted out of intercompany.html and run for real, so these
 * check behaviour rather than that the source mentions the right words.
 */

const fs   = require('fs');
const path = require('path');
const root = p => path.resolve(__dirname, '..', p);

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const ic = fs.readFileSync(root('intercompany.html'), 'utf8');

// Lift the real function declarations out of the report.
const grab = name => {
  const start = ic.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in intercompany.html`);
  let depth = 0;
  for (let j = ic.indexOf('{', start); j < ic.length; j++) {
    if (ic[j] === '{') depth++;
    else if (ic[j] === '}' && --depth === 0) return ic.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
};
let isLowboy, isTriAxle, addEquipCost;
try {
  ({ isLowboy, isTriAxle, addEquipCost } = new Function(`
    ${['isLowboy', 'isTriAxle', 'addEquipCost'].map(grab).join('\n')}
    return { isLowboy, isTriAxle, addEquipCost };
  `)());
} catch (err) {
  // Report this as a failure rather than a stack trace — the usual cause is
  // the split having been folded back inline into the aggregation loops.
  assert('the report exposes the haul-column matchers', false, err.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

const blank = () => ({ equipCost: 0, lowboyCost: 0, triAxleCost: 0 });

console.log('\n══════════ Lowboy / Tri Axle / Equipment ══════════');

console.log('\n[a lowboy is a lowboy however it was typed]');
for (const name of ['Lowboy', 'lowboy', 'LOWBOY', 'Lowboy Truck', 'Mack Lowboy']) {
  assert(`"${name}"`, isLowboy(name));
}

console.log('\n[tri axle, however it is spaced]');
for (const name of ['Tri Axle', 'tri-axle', 'TriAxle', 'Tri Axle Dump', 'tri axle truck', 'Tri']) {
  assert(`"${name}"`, isTriAxle(name));
}

console.log('\n[but "tri" inside an ordinary word is not a truck]');
// This is the whole reason the split could not simply be widened to every row.
for (const name of ['Distributor', 'Asphalt Distributor', 'Striper', 'Line Striping Truck',
                    'Electric Roller', 'Nitrogen Cart', 'Trimble Paver']) {
  assert(`"${name}" is not tri axle`, !isTriAxle(name), 'a bare "tri" substring match swept this in');
}

console.log('\n[neither matcher fires on the ordinary fleet]');
for (const name of ['Pickup', 'Skid Steer', 'Roller (Small 224)', '150 Wirtgen Mill',
                    'tack truck', 'tar buggy', '', null, undefined]) {
  const label = name === '' ? '(blank)' : String(name);
  assert(`"${label}" is plain equipment`, !isLowboy(name) && !isTriAxle(name));
}

console.log('\n[the job class no longer decides the column]');
// Craig Dean's two rows: Kris Fairman 121 × 6.0 and Cam Rising 121 × 6.5,
// both entered on the daily grid under job class 'Hourly'.
const craig = blank();
addEquipCost(craig, 'Lowboy', 121 * 6);
addEquipCost(craig, 'Lowboy', 121 * 6.5);
for (const [equip, cost] of [['Pickup', 175], ['150 Wirtgen Mill', 715], ['Pickup', 175],
                             ['Skid Steer', 130], ['Roller (Small 224)', 20], ['Pickup', 175]]) {
  addEquipCost(craig, equip, cost);
}
assert('the lowboy hours reach the Lowboy column', craig.lowboyCost === 1512.5,
  `lowboy read ${craig.lowboyCost}, expected 1512.5`);
assert('  and are no longer inside Equipment', craig.equipCost === 1390,
  `equipment read ${craig.equipCost}, expected 1390`);
assert('  leaving the job total unchanged at $2,902.50',
  craig.lowboyCost + craig.equipCost + craig.triAxleCost === 2902.5);

console.log('\n[no dollar is dropped]');
// A haul whose type matches neither column used to be counted nowhere at all,
// so the money left the report entirely rather than landing in Equipment.
const misc = blank();
addEquipCost(misc, 'tack truck', 400);
addEquipCost(misc, 'Water Truck', 250);
assert('an unmatched haul lands in Equipment rather than vanishing',
  misc.equipCost === 650 && misc.lowboyCost === 0 && misc.triAxleCost === 0);

const spread = blank();
for (const [name, cost] of [['Lowboy', 100], ['Tri Axle', 200], ['Pickup', 300]]) {
  addEquipCost(spread, name, cost);
}
assert('each cost lands in exactly one column',
  spread.lowboyCost === 100 && spread.triAxleCost === 200 && spread.equipCost === 300);
assert('  and the three columns still sum to what was spent',
  spread.lowboyCost + spread.triAxleCost + spread.equipCost === 600);

console.log('\n[the report calls the shared helper on both cost sources]');
assert('daily rows are classified by equipment name',
  /addEquipCost\(entry, row\.equipment,/.test(ic));
assert('trucking entries are classified by truck type',
  /addEquipCost\(entry, t\.truck_type,/.test(ic));
assert('no path still gates the split on job class',
  !/job_class[^\n]*trucking'\) \{[\s\S]{0,200}lowboy/.test(ic),
  'the job-class gate is what put a lowboy in the Equipment column');
// The dedup set is a different concern and must keep reading job_class.
assert('  but the trucking-mirror dedup still keys on job class',
  /truckingDailyIds[\s\S]{0,200}job_class[^\n]*=== 'trucking'/.test(ic));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
