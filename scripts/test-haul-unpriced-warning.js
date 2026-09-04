#!/usr/bin/env node
'use strict';
/**
 * Which rows a haul actually pays for, and the warning when one pays for nothing.
 *
 * Run: node scripts/test-haul-unpriced-warning.js
 *
 * A haul row posts a $0 labour rate because the driver is already inside the
 * truck's hourly cost. The day-level answer used to decide that for EVERY row
 * at once, and that is wrong for the commonest complicated day there is: a man
 * who hauls to the job, gets out, and works it. His time in the truck is bought
 * by the truck; his time on the site is not, and the job owes him for it. Marked
 * as one haul, his site labour posted at $0 — free work — and his hours dropped
 * out of the job's crew-size and units-per-man-hour denominators as well,
 * because a haul stamp takes them out of both.
 *
 * So the ROW decides now, on the only fact that means anything: whether the
 * truck is on it (named AND with hours, since a unit with no hours prices at
 * nothing). splitRowIsHaul is that rule, and the Haul tick overrides it in
 * either direction — for the day the truck really is billed on another row.
 *
 * What is left for the warning is the row somebody TICKED as a haul with no
 * priced truck on it. That one costs the job nothing at all: no wage, because
 * it is a haul, and no machine, because none was named.
 *
 * The approver is warned rather than blocked. They may well be right — a driver
 * riding along, a truck billed on another row, a leg the office prices
 * elsewhere — and refusing an approval that is genuinely correct only teaches
 * people to work around the modal.
 *
 * Evaluates the real functions out of payroll.html — no browser needed.
 */

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');

// Lift a top-level `function name(...) { ... }` out of the page — one shared
// brace matcher, see scripts/lib/fn-source.js.
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const fnSource = name => requireFn(src, name, 'payroll.html');

// splitHaulUnpricedRows reads splitEntry and splitRows as free variables and
// calls isTravelSplitRow, which in turn reads TRAVEL_CODE_RE — so all three
// come across together. Lifted from the page rather than restated here: a
// second copy of the travel pattern is a second place for it to drift, and
// this test exists precisely to pin what the page does.
const travelRe = /^\s*const TRAVEL_CODE_RE = (\/.*\/[a-z]*);$/m.exec(src);
if (!travelRe) throw new Error('TRAVEL_CODE_RE not found in payroll.html');
// splitHaulAnswer, not splitEntry.haul_type: the picker's value is held apart
// from the cached grid entry on purpose, so trying an answer and cancelling
// cannot move a day's hours out of prevailing on the page behind the modal.
// splitHaulIs comes across too — it is the one place the answer is read.
const HAUL_PRELUDE =
  `const TRAVEL_CODE_RE = ${travelRe[1]};\n` +
  `const splitHaulIs = () =>\n` +
  `  (splitHaulAnswer === 'on_site' || splitHaulAnswer === 'off_site') ? splitHaulAnswer : null;\n` +
  `${fnSource('isTravelSplitRow')}\n` +
  // The per-row rule and the two helpers around it. Lifted rather than
  // restated for the same reason as the travel pattern: this file exists to
  // pin what the page does, and a second copy is a second thing to drift.
  `${fnSource('splitPricedMachineOnRow')}\n` +
  `${fnSource('splitTruckOnRow')}\n` +
  `${fnSource('splitRowIsHaul')}\n` +
  `${fnSource('splitRowTakesTruck')}\n`;

const run = (splitEntry, splitRows) => new Function(
  'splitEntry', 'splitRows', 'splitHaulAnswer',
  `${HAUL_PRELUDE}${fnSource('splitHaulUnpricedRows')}\n` +
  `return splitHaulUnpricedRows();`,
)(splitEntry, splitRows, (splitEntry && splitEntry.haul_type) || '');

const HAUL  = { haul_type: 'off_site' };
const ONSITE = { haul_type: 'on_site' };
const NOT   = { haul_type: null };
// equip_hours is deliberately absent from the defaults: 0 is what a fresh split
// row actually carries (_blankSplitRow), so a fixture that wants a PRICED truck
// has to say so, the same way the approver has to.
const row = over => Object.assign(
  { cost_code: 'Earthwork', sub_code: 'Excess Cut', labor_hours: 8, equipment: '' }, over);

// The rule the modal prices by, evaluated the same way.
const isHaul = (splitEntry, rows, i = 0) => new Function(
  'splitEntry', 'splitRows', 'splitHaulAnswer',
  `${HAUL_PRELUDE}return splitRowIsHaul(splitRows[${i}]);`,
)(splitEntry, rows, (splitEntry && splitEntry.haul_type) || '');

// The machines on a haul day that are not the truck he named.
const oddMachines = (splitEntry, rows) => new Function(
  'splitEntry', 'splitRows', 'splitHaulAnswer',
  `${HAUL_PRELUDE}${fnSource('splitUnnamedMachineRows')}\n` +
  `return splitUnnamedMachineRows();`,
)(splitEntry, rows, (splitEntry && splitEntry.haul_type) || '');

// And the day-level "nobody claimed the truck" figure.
const looseHours = (splitEntry, rows) => new Function(
  'splitEntry', 'splitRows', 'splitHaulAnswer',
  `${HAUL_PRELUDE}${fnSource('splitHaulNoTruckHours')}\n` +
  `return splitHaulNoTruckHours();`,
)(splitEntry, rows, (splitEntry && splitEntry.haul_type) || '');

console.log('\n[which rows the truck actually bought]');

{
  assert('a row with the truck on it and hours against it is the haul',
    isHaul(HAUL, [row({ equipment: 'Triaxle Dump', equip_hours: 8 })]) === true);
  assert('  and so it is on an on-site haul — both answers price labour at $0',
    isHaul(ONSITE, [row({ equipment: 'Triaxle Dump', equip_hours: 8 })]) === true);
}
{
  // THE CASE THIS EXISTS FOR. He hauled to & from, then got out and worked the
  // site. One row has the truck; the other is his labour and the job owes it.
  const rows = [
    row({ labor_hours: 6.5, sub_code: 'Milling - Trucking', equipment: 'Triaxle Dump', equip_hours: 6.5 }),
    row({ labor_hours: 2.5, sub_code: 'Scratch/leveling - Labor' }),
  ];
  assert('the hours he spent driving are the haul', isHaul(HAUL, rows, 0) === true);
  assert('the hours he spent working the site are NOT — the job pays him',
    isHaul(HAUL, rows, 1) === false);
}
{
  assert('a named truck with no hours against it buys nothing, so it is not the haul',
    isHaul(HAUL, [row({ equipment: 'Triaxle Dump', equip_hours: 0 })]) === false);
  assert('whitespace is not a truck',
    isHaul(HAUL, [row({ equipment: '   ', equip_hours: 8 })]) === false);
}
{
  assert('the tick forces a row to be the haul even with no truck named',
    isHaul(HAUL, [row({ is_haul: true })]) === true);
  assert('  and unticking forces it not to be, truck and all',
    isHaul(HAUL, [row({ is_haul: false, equipment: 'Triaxle Dump', equip_hours: 8 })]) === false);
}
{
  assert('travel is never the haul — the commute is not the truck\'s time',
    isHaul(HAUL, [row({ is_travel: true, equipment: 'Triaxle Dump', equip_hours: 8 })]) === false);
  assert('  nor is a row booked to a travel code without the tick',
    isHaul(HAUL, [row({ sub_code: 'Mobilization - Travel', equipment: 'Triaxle Dump', equip_hours: 8 })]) === false);
  assert('  and not even a ticked one — travel outranks the tick, as on the server',
    isHaul(HAUL, [row({ is_travel: true, is_haul: true })]) === false);
}
{
  assert('nothing is a haul on a day nobody called one',
    isHaul(NOT, [row({ equipment: 'Triaxle Dump', equip_hours: 8 })]) === false);
  assert('  or on an unrecognized answer',
    isHaul({ haul_type: 'nonsense' }, [row({ is_haul: true })]) === false);
}

console.log('\n[when the warning fires]');

{
  // What is left to warn about: somebody said outright that the truck bought
  // this row, and there is no priced truck on it. $0 wage, $0 machine.
  const bad = run(HAUL, [row({ is_haul: true })]);
  assert('a row ticked as a haul with no truck is flagged', bad.length === 1);
  assert('  and it is named by its row number', bad[0].n === 1);
  assert('  and carries its hours, so the warning can total them', bad[0].hours === 8);
  assert('  and reports that no unit was named, so it can say what to fix',
    bad[0].hasUnit === false);
}
{
  // The likely shape of the mistake: _blankSplitRow starts every row at
  // equip_hours 0, so a unit picked and never given hours costs the job exactly
  // as nothing as naming no truck at all.
  const bad = run(HAUL, [row({ is_haul: true, equipment: 'Triaxle Dump', equip_hours: 0 })]);
  assert('a ticked row with a named truck but no hours is still flagged', bad.length === 1);
  assert('  and the warning knows a unit was named', bad[0].hasUnit === true);
}
{
  const bad = run(HAUL, [
    row({ labor_hours: 4, is_haul: true }),
    row({ labor_hours: 4, equipment: 'Triaxle Dump', equip_hours: 4 }),
  ]);
  assert('only the row missing its truck is flagged', bad.length === 1 && bad[0].n === 1);
}
{
  const bad = run(HAUL, [row({ labor_hours: 3, is_haul: true }), row({ labor_hours: 5, is_haul: true })]);
  assert('two bare ticked rows are both flagged', bad.length === 2);
  assert('  and their hours add up to the day', bad.reduce((s, r) => s + r.hours, 0) === 8);
}

console.log('\n[when it stays quiet]');

{
  assert('a haul row with a truck AND its hours is fine',
    run(HAUL, [row({ equipment: 'Triaxle Dump', equip_hours: 8 })]).length === 0);
}
{
  // The change: this used to be the headline warning, and it was warning about
  // the wrong thing. An untouched row with no truck is not a haul any more —
  // it prices the man's own rate, which is what he is owed.
  assert('a row with no truck is not flagged — it pays him, it does not zero him',
    run(HAUL, [row()]).length === 0);
  assert('  and neither is a named truck left without hours',
    run(HAUL, [row({ equipment: 'Triaxle Dump', equip_hours: 0 })]).length === 0);
}
{
  assert('an ordinary (non-haul) entry is never flagged — the wage is real there',
    run(NOT, [row({ is_haul: true })]).length === 0);
}
{
  assert('an entry that predates the question is never flagged',
    run({}, [row({ is_haul: true })]).length === 0);
}
{
  // Travel keeps the employee's own rate on a haul day: the commute is not
  // bought by the truck, so those hours are priced whether or not one is named.
  assert('a travel row on a haul day is not flagged (it keeps its own rate)',
    run(HAUL, [row({ is_travel: true, is_haul: true, equipment: '' })]).length === 0);
  assert('  and neither is one booked to a travel code without the tick',
    run(HAUL, [row({ sub_code: 'Mobilization - Travel', is_haul: true })]).length === 0);
}
{
  assert('a zero-hour row is not flagged — nothing is being given away',
    run(HAUL, [row({ labor_hours: 0, is_haul: true })]).length === 0);
}
{
  assert('an unrecognized haul answer is not flagged',
    run({ haul_type: 'nonsense' }, [row({ is_haul: true })]).length === 0);
}

console.log('\n[a machine that is not the truck he named]');

// Two different questions, and conflating them got this warning wrong both
// ways round. "Is this the truck he hauled with" decides whether to ASSUME the
// row is a haul; "is any machine priced here" decides whether the row costs the
// job anything at all.
const TRIAXLE_DAY = { haul_type: 'off_site', truck_unit: 'Triaxle Dump' };
{
  // A ticked haul row carrying the lowboy on a day he named the triaxle. It is
  // not the named truck — and it is unquestionably priced, so telling the
  // approver it "will cost the job nothing at all" is false, and the remedy the
  // warning names (put the equipment hours on) is already done, which left a
  // banner that could never be cleared from inside the modal.
  const lowboy = row({ is_haul: true, equipment: 'Lowboy', equip_hours: 3, labor_hours: 3 });
  assert('a ticked haul row with a priced lowboy is NOT called unpriced',
    run(TRIAXLE_DAY, [lowboy]).length === 0,
    JSON.stringify(run(TRIAXLE_DAY, [lowboy])));
  assert('  while a ticked row with nothing priced on it still is',
    run(TRIAXLE_DAY, [row({ is_haul: true })]).length === 1);
}
{
  // Untouched, a machine that is not the truck is genuinely ambiguous: a second
  // truck he also hauled with, or a roller he ran on the site. Guessing "haul"
  // takes his wage off a row he worked; guessing "work" bills the job his wage
  // on top of the machine. It pays him — the side that cannot underpay a
  // person — and says so, because the silence was the real defect.
  const odd = oddMachines(TRIAXLE_DAY, [
    row({ labor_hours: 6, equipment: 'Triaxle Dump', equip_hours: 6 }),
    row({ labor_hours: 3, equipment: 'Lowboy',       equip_hours: 3 }),
  ]);
  assert('the machine that is not his truck is surfaced', odd.length === 1);
  assert('  named, so the approver knows which row and which unit',
    odd[0].n === 2 && odd[0].unit === 'Lowboy' && odd[0].hours === 3);
  assert('the truck itself is never surfaced',
    oddMachines(TRIAXLE_DAY, [row({ equipment: 'Triaxle Dump', equip_hours: 8 })]).length === 0);
  assert('  and nor is it once the approver has ticked it as a haul',
    oddMachines(TRIAXLE_DAY, [row({ is_haul: true, equipment: 'Lowboy', equip_hours: 3 })]).length === 0);
  // A row he UNTICKED that carries the actual truck is a deliberate "the truck
  // is billed elsewhere" call, not an ambiguous machine — there is nothing to
  // ask him about, and nagging about a decision he just made is how a banner
  // becomes wallpaper. This is the only case the truck test itself decides:
  // everything else is settled by the haul check above it.
  assert('an unticked row carrying his own truck is his decision, not a question',
    oddMachines(TRIAXLE_DAY, [row({ is_haul: false, equipment: 'Triaxle Dump', equip_hours: 8 })]).length === 0);
  assert('  while an unticked row carrying a different machine still is one',
    oddMachines(TRIAXLE_DAY, [row({ is_haul: false, equipment: 'Lowboy', equip_hours: 3 })]).length === 1);
  assert('  nor a bare row, which has no machine to wonder about',
    oddMachines(TRIAXLE_DAY, [row()]).length === 0);
  assert('  nor a unit with no hours, which bills nothing either way',
    oddMachines(TRIAXLE_DAY, [row({ equipment: 'Lowboy', equip_hours: 0 })]).length === 0);
  assert('  nor travel, which keeps its own rate whatever is on it',
    oddMachines(TRIAXLE_DAY, [row({ is_travel: true, equipment: 'Lowboy', equip_hours: 3 })]).length === 0);
  assert('where the driver named no truck there is nothing to compare against',
    oddMachines(HAUL, [row({ equipment: 'Lowboy', equip_hours: 3 })]).length === 0);
  assert('and an ordinary day says nothing at all',
    oddMachines(NOT, [row({ equipment: 'Lowboy', equip_hours: 3 })]).length === 0);

  // The tests above call it directly, so they cannot see it being unwired from
  // the banner that is the only reason it exists. Named first in there because
  // it is the one live money question of the three, not a missing figure.
  const render = fnSource('renderSplitHaulWarning');
  assert('and the banner actually asks for it',
    /const odd = splitUnnamedMachineRows\(\);/.test(render), render);
  assert('  before either of the other two notes',
    render.indexOf('splitUnnamedMachineRows') < render.indexOf('splitHaulNoTruckHours')
    && /if \(odd\.length\) \{/.test(render));
}

console.log('\n[a haul day where nobody claimed the truck]');

// The other way the day can read wrong, and the one the new default creates:
// every row prices the man's labour and nothing bills the job for a truck.
// Nothing is broken — that is the safe direction — but it changes what the day
// costs, so it is said out loud rather than left to be noticed.
{
  assert('a haul day with no haul row on it reports its work hours',
    looseHours(HAUL, [row({ labor_hours: 9 })]) === 9);
  assert('  travel is left out of that figure — it was never the truck\'s time',
    looseHours(HAUL, [row({ labor_hours: 6 }), row({ labor_hours: 3, is_travel: true })]) === 6);
  assert('one real haul row anywhere settles it, and the note goes quiet',
    looseHours(HAUL, [
      row({ labor_hours: 6, equipment: 'Triaxle Dump', equip_hours: 6 }),
      row({ labor_hours: 3 }),
    ]) === 0);
  assert('  and so does a row the approver ticked',
    looseHours(HAUL, [row({ labor_hours: 9, is_haul: true })]) === 0);
  assert('an ordinary day says nothing', looseHours(NOT, [row({ labor_hours: 9 })]) === 0);
}

console.log('\n[it warns — it must never refuse]');

// The whole point: this is advice, not a gate. If splitSave ever consults the
// warning the approver loses the ability to approve a day that is genuinely
// correct, and starts working around the modal instead.
const saveStart = src.indexOf('async function splitSave(');
let depth = 0, saveEnd = -1;
for (let i = src.indexOf('{', saveStart); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { saveEnd = i + 1; break; }
}
const saveSrc = src.slice(saveStart, saveEnd);
assert('splitSave was found', saveStart >= 0 && saveEnd > saveStart);
assert('splitSave never consults the warning',
  !/splitHaulUnpricedRows|splitWarn|renderSplitHaulWarning/.test(saveSrc));

// And it has to actually be shown, on every recompute rather than only at open,
// or a supervisor who adds the truck is left staring at a stale warning.
// Brace-matched rather than regex-spanned: a lazy [\s\S]*? would happily match
// a call that had been moved somewhere else entirely in the file.
assert('the warning is rendered from renderSplitTally, so it tracks every edit',
  /renderSplitHaulWarning\(\);/.test(fnSource('renderSplitTally')));
assert('the warning has somewhere to render',
  /id="splitWarn"/.test(src) && /\.split-warn\s*\{/.test(src));
// Amber, not red: red in this modal means the save was refused.
assert('it is styled as advice, not as an error',
  /\.split-warn\s*\{[^}]*var\(--yellow\)/.test(src));

// ── The stamp must not claim field types the office already owns ────────────
// field_types is a free-form, company-managed dropdown (api/dropdown-lists.js)
// with nothing reserving the word "Haul". A regex of /^haul\b/ would have
// swallowed a paving company's existing "Haul Off" for spoil removal: every
// such row priced at $0 and dropped out of its own production rates on the
// first deploy, silently. The stamp claims the "Haul — …" shape only.
// ── The autofill that keeps a haul row from costing nothing ────────────────
// A haul posts $0 labour by design. If the truck is missing too, the day is
// free to the job — which is the opposite of what calling it a haul means.
console.log('\n[a haul row fills in its own truck and hours]');
{
  const mk = (over, proj, haul) => {
    const sb = {
      splitEntry: {},
      splitHaulAnswer: haul === undefined ? 'off_site' : (haul || ''),
      splitRows: [],
      splitProjEquipment: proj || [],
    };
    vm.createContext(sb);
    vm.runInContext(
      `${HAUL_PRELUDE}${fnSource('splitDefaultHaulEquipment')}\n` +
      `${fnSource('splitMirrorHaulEquipHours')}\n${fnSource('splitClearHaulAuto')}\n`, sb);
    const r = Object.assign({ cost_code: 'Earthwork', sub_code: 'Excess Cut',
                              equipment: '', labor_hours: 6, equip_hours: 0 }, over);
    sb.splitRows = [r];
    const a = sb.splitDefaultHaulEquipment(r);
    const b = sb.splitMirrorHaulEquipHours(r);
    return { r, changed: a || b };
  };

  // What the driver himself said always wins — he is the only one who knows
  // whether he was on a lowboy or a triaxle that day.
  const mkSaid = (unit, proj) => {
    const sb = { splitEntry: { truck_unit: unit }, splitHaulAnswer: 'off_site',
                 splitRows: [], splitProjEquipment: proj || [] };
    vm.createContext(sb);
    vm.runInContext(
      `${HAUL_PRELUDE}${fnSource('splitDefaultHaulEquipment')}\n`, sb);
    const r = { cost_code: 'Earthwork', sub_code: 'Excess Cut', equipment: '',
                labor_hours: 6, equip_hours: 0 };
    sb.splitDefaultHaulEquipment(r);
    return r;
  };
  assert('the truck the DRIVER picked is used',
    mkSaid('Lowboy', []).equipment === 'Lowboy');
  assert('  and it beats the job\'s assignment, because only he was there',
    mkSaid('Lowboy', ['Triaxle Dump']).equipment === 'Lowboy');
  assert('  and it works where the job assigns several',
    mkSaid('Triaxle Dump', ['Triaxle Dump', 'Lowboy']).equipment === 'Triaxle Dump');
  assert('a driver who left it blank falls back to the job assignment',
    mkSaid('', ['Triaxle Dump']).equipment === 'Triaxle Dump');

  let { r } = mk({}, ['Triaxle Dump']);
  assert('the job\'s single assigned unit becomes the truck', r.equipment === 'Triaxle Dump');
  assert('  and its hours follow the driver\'s', r.equip_hours === 6);

  ({ r } = mk({}, ['Triaxle Dump', 'Lowboy']));
  assert('two assigned units is a guess, so it picks neither', r.equipment === '');
  // Changed deliberately. Hours against no unit price at nothing, so all this
  // used to do was make a row that costs the job nothing LOOK like a priced
  // haul — while the $0 labour rate it carried was real. With no truck the row
  // is simply not a haul, and pays the man his own rate.
  assert('  and the hours do not follow either, because there is nothing to mirror onto',
    r.equip_hours === 0);

  ({ r } = mk({}, []));
  assert('no assigned equipment leaves the truck blank', r.equipment === '');

  ({ r } = mk({ equipment: 'Lowboy' }, ['Triaxle Dump']));
  assert('a truck the approver already chose is never overwritten', r.equipment === 'Lowboy');

  ({ r } = mk({ equip_hours: 2, _equipHoursTouched: true }, ['Triaxle Dump']));
  assert('hours set by hand stick — a driver can be out of the truck part of the day',
    r.equip_hours === 2);

  ({ r } = mk({}, ['Triaxle Dump'], null));
  assert('none of it happens on an ordinary day',
    r.equipment === '' && r.equip_hours === 0);

  ({ r } = mk({ is_travel: true }, ['Triaxle Dump']));
  assert('nor on a travel row — the commute is not the truck\'s time',
    r.equipment === '' && r.equip_hours === 0);

  ({ r } = mk({ labor_hours: 0 }, ['Triaxle Dump']));
  assert('a zero-hour row gets the truck but no hours',
    r.equipment === 'Triaxle Dump' && r.equip_hours === 0);
}

// ── The rate a haul row shows ──────────────────────────────────────────────
// dailyRowAutoRate returns a numeric 0 for a haul: the truck already pays for
// the man. Every rate-write in the row handler goes through dailyRateOut so
// that 0 is written as a NUMBER. Written as `autoRate || ''` — which each site
// used to say for itself — the 0 becomes '', and an empty rate cell reads as
// "the lookup failed". The hand-fix for that is typing the driver's wage back
// onto a row whose truck already covers him, which is the double-billing the
// whole feature exists to remove.
console.log('\n[a haul row shows $0, not a blank]');
{
  const fs3 = require('fs');
  for (const page of ['tracker.html', 'paving.html', 'kiewit-pinetree.html']) {
    const s = fs3.readFileSync(path.resolve(__dirname, '..', page), 'utf8');
    const grab = name => {
      const start = s.indexOf(`function ${name}(`);
      if (start < 0) return null;
      let d = 0;
      for (let i = s.indexOf('{', start); i < s.length; i++) {
        if (s[i] === '{') d++;
        else if (s[i] === '}' && --d === 0) return s.slice(start, i + 1);
      }
      return null;
    };
    const reM = /^const HAUL_FIELD_TYPE_RE = (\/.*\/[a-z]*);/m.exec(s);
    const src = grab('dailyRateOut');
    assert(`${page} defines dailyRateOut`, !!src && !!reM);
    if (!src || !reM) continue;
    const out = new Function('HAUL_FIELD_TYPE_RE', `${src}; return dailyRateOut;`)(eval(reM[1]));

    assert(`  ${page}: a haul row writes a numeric 0`,
      out({ field_type: 'Haul — On Site' }, 0) === 0);
    assert(`  ${page}: and so does the to/from stamp`,
      out({ field_type: 'Haul — To/From Site' }, 0) === 0);
    // Deliberately unchanged: an employee with no roster rate still blanks.
    // "Nothing to fill in" is what an empty rate cell has always meant, and a
    // blanket `0` there would invent a rate of zero for a missing one.
    assert(`  ${page}: an ordinary row with no roster rate still blanks`,
      out({ field_type: '' }, 0) === '');
    assert(`  ${page}: a real rate passes through untouched`,
      out({ field_type: '' }, 32.5) === 32.5);
    assert(`  ${page}: a haul row with a real rate still shows 0 — the truck pays`,
      out({ field_type: 'Haul — On Site' }, 77) === 0);
    assert(`  ${page}: "no basis to set one" stays null, so callers leave the rate alone`,
      out({ field_type: 'Haul — On Site' }, null) === null);
  }

  // And no site may quietly go back to doing it by hand.
  for (const page of ['tracker.html', 'paving.html', 'kiewit-pinetree.html']) {
    const s = fs3.readFileSync(path.resolve(__dirname, '..', page), 'utf8');
    const handler = s.slice(s.indexOf("if (f === 'cost_code')"),
                            s.indexOf('// Auto-calculate material cost'));
    assert(`  ${page}: the row handler writes no rate outside dailyRateOut`,
      !/(autoRate|ar) \|\| ''/.test(handler),
      (/(autoRate|ar) \|\| ''/.exec(handler) || [''])[0]);
  }
}

// ── Taking the answer back ─────────────────────────────────────────────────
// The modal fills in a truck and its hours on a haul. If the row stops being a
// haul, what the MODAL guessed has to go with it — otherwise the row posts the
// full labour rate AND a truck nobody chose, or bills the commute to a truck
// the travel rule says is not on the clock.
console.log('\n[what the modal guessed, the modal takes back]');
{
  const mkClear = (haul, over) => {
    const sb = { splitEntry: { truck_unit: 'Triaxle Dump' }, splitHaulAnswer: 'off_site',
                 splitRows: [], splitProjEquipment: [] };
    vm.createContext(sb);
    vm.runInContext(
      `${HAUL_PRELUDE}${fnSource('splitDefaultHaulEquipment')}\n` +
      `${fnSource('splitMirrorHaulEquipHours')}\n${fnSource('splitClearHaulAuto')}\n`, sb);
    const r = Object.assign({ cost_code: 'Earthwork', sub_code: 'Excess Cut',
                              equipment: '', labor_hours: 6, equip_hours: 0 }, over);
    sb.splitDefaultHaulEquipment(r);
    sb.splitMirrorHaulEquipHours(r);
    sb.splitHaulAnswer = haul;          // the approver changes their mind
    sb.splitClearHaulAuto(r);
    return r;
  };

  let r = mkClear('');
  assert('answering "no" after "haul" takes the guessed truck back', r.equipment === '');
  assert('  and its hours with it', r.equip_hours === 0);

  r = mkClear('on_site');
  assert('a haul that stays a haul keeps them',
    r.equipment === 'Triaxle Dump' && r.equip_hours === 6);

  // A truck the APPROVER typed is theirs, not the modal's to remove.
  r = mkClear('', { equipment: 'Lowboy' });
  assert('a truck the approver chose is never taken back', r.equipment === 'Lowboy');
  r = mkClear('', { equip_hours: 4, _equipHoursTouched: true });
  assert('hours the approver set are never taken back', r.equip_hours === 4);

  // The per-row version of the same retraction. Unticking Haul on one row of a
  // day that is still a haul says the driver was out of the truck for those
  // hours — so the truck the modal put there has to go with it, or the row
  // reads as priced equipment nobody chose.
  r = mkClear('off_site', { is_haul: false });
  assert('unticking one row takes back the truck the modal guessed for it',
    r.equipment === '' && r.equip_hours === 0);
  r = mkClear('off_site', { is_haul: false, equipment: 'Lowboy' });
  assert('  but not a truck the approver typed on it himself', r.equipment === 'Lowboy');
}

// The picker's value is deliberately NOT written onto splitEntry: that object is
// the one the grid holds, and isOffSiteHaul reads it from the Hours Report, the
// per-employee table and the Excel export. Trying an answer and pressing Cancel
// must not move a day's hours out of prevailing behind the modal.
console.log('\n[trying an answer does not change the page behind the modal]');
{
  const change = fnSource('onSplitHaulChange');
  assert('onSplitHaulChange writes the answer to splitHaulAnswer',
    /splitHaulAnswer = el\.value/.test(change));
  assert('  and never onto the cached entry',
    !/splitEntry\.haul_type\s*=/.test(change), change);
  assert('no code path writes haul_type onto splitEntry',
    !/splitEntry\.haul_type\s*=/.test(src));
  assert('closing the modal resets the pending answer',
    /splitHaulAnswer\s*=\s*''/.test(fnSource('closeSplit')));
  // The tests above call splitClearHaulAuto directly, so they cannot see it
  // being unwired from the one place that runs it over every row.
  assert('the un-fill is actually wired into the pass over every row',
    /splitClearHaulAuto\(r\)/.test(fnSource('splitMirrorHaulEquipHoursAll')));
  assert('  and that pass is what the picker triggers',
    /splitMirrorHaulEquipHoursAll\(\)/.test(fnSource('onSplitHaulChange')));
  // Rows read back by Edit Split carry hours somebody already approved. Marked
  // touched, or the mirror rewrites a deliberate 5 h to the labour hours the
  // next time anything on the row changes — a silent over-charge for truck time
  // nobody logged.
  assert('rows read back by Edit Split are marked as hand-set',
    /is_travel:\s*!!r\.is_travel,[\s\S]{0,1600}?_equipHoursTouched:\s*true,/.test(src));
  // And carry the answer they were APPROVED with, not one re-derived from the
  // truck now on the row. A day signed off before the answer was per-row comes
  // back with every work row ticked — which is what it was approved as — so
  // reopening it moves nobody's money until the approver unticks the row where
  // the driver was out of the truck.
  // And re-open on the answer they were approved with, in THREE states — never
  // collapsed to a boolean. Forced to one, every row of a day that was never a
  // haul came back as a deliberate "not a haul", so an approver switching the
  // picker to "hauled to & from site" re-stamped the entry and re-priced no row
  // at all: the truck kept charging the job AND the man kept charging his wage.
  assert('  and re-open on the haul answer they were approved with, undefined included',
    /is_travel:\s*!!r\.is_travel,[\s\S]{0,1600}?is_haul:\s*r\.is_haul,/.test(src));
  {
    // daily_tracking.is_haul holds the answer outright, in all three states.
    // Read through one function so the sweep and this read-back cannot come to
    // different conclusions about the same row.
    const T = require(path.resolve(__dirname, '../api/timesheet-entries.js'))._test;
    assert('an un-hauled row reads back as deliberately not one',
      JSON.stringify(T.storedHaulAnswer({ is_haul: false })) === '{"is_haul":false}');
    assert('  a hauled row as a haul',
      JSON.stringify(T.storedHaulAnswer({ is_haul: true })) === '{"is_haul":true}');
    assert('  and a row nobody answered as nothing at all, so the truck decides',
      T.storedHaulAnswer({ is_haul: null, field_type: null }) === null);
    // A row approved before the column existed has only its stamp to go on.
    // Without that fallback every historic haul row would read as "nobody said"
    // and be re-derived from a truck many of them never named.
    assert('  a row from before the column falls back to its stamp',
      JSON.stringify(T.storedHaulAnswer({ is_haul: null, field_type: 'Haul — To/From Site' })) === '{"is_haul":true}');
    assert('  with the column outranking a stamp that disagrees with it',
      JSON.stringify(T.storedHaulAnswer({ is_haul: false, field_type: 'Haul — On Site' })) === '{"is_haul":false}');
    const api = fs.readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');
    assert('and both readers go through that one function, not their own copy',
      (api.match(/\.\.\.storedHaulAnswer\(r\)/g) || []).length === 1
      && /const stored    = storedHaulAnswer\(r\);/.test(api)
      && (api.match(/is_haul === false\) return \{ is_haul: false \}/g) || []).length === 1);
  }
  // Only a real answer is sent. An untouched row sends no key, and the server
  // reads the truck off the row exactly as the modal does — so "nobody said"
  // can never arrive looking like a deliberate "not a haul".
  assert('an untouched row sends no is_haul key at all',
    /if \(r\.is_haul === true \|\| r\.is_haul === false\) out\.is_haul = r\.is_haul;/
      .test(fnSource('splitRowPayload')));
  assert('  and the job equipment, so it cannot leak into the next entry',
    /splitProjEquipment\s*=\s*\[\]/.test(fnSource('closeSplit')));
}

console.log('\n[the haul stamp claims only its own field types]');
{
  const fs2 = require('fs');
  const files = ['api/timesheet-entries.js', 'tracker.html', 'paving.html', 'kiewit-pinetree.html'];
  const pats = files.map(f => {
    const m = /^\s*const HAUL_FIELD_TYPE_RE = (\/.*\/[a-z]*);/m
      .exec(fs2.readFileSync(path.resolve(__dirname, '..', f), 'utf8'));
    return { f, re: m && eval(m[1]) };
  });
  assert('every copy of the matcher was found',
    pats.every(p => p.re), pats.filter(p => !p.re).map(p => p.f).join(', '));
  assert('all four copies are identical — the rule lives in four files',
    new Set(pats.map(p => String(p.re))).size === 1,
    [...new Set(pats.map(p => String(p.re)))].join(' vs '));

  const re = pats[0].re;
  for (const s of ['Haul — On Site', 'Haul — To/From Site', 'Haul - On Site']) {
    assert(`  matches ${JSON.stringify(s)}`, re.test(s));
  }
  for (const s of ['Haul Off', 'Hauling', 'Haul', 'Haulage', 'Material', 'Trucking']) {
    assert(`  leaves ${JSON.stringify(s)} alone`, !re.test(s));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
