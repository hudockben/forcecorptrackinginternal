#!/usr/bin/env node
'use strict';
/**
 * A haul row with no truck on it is free labour — say so, don't refuse it.
 *
 * Run: node scripts/test-haul-unpriced-warning.js
 *
 * On a haul, the labour rows post at a $0 rate because the driver is already
 * inside the truck's hourly cost. Nothing requires a truck ON the row, though.
 * So a haul row left with no equipment costs the job NOTHING AT ALL: no wage,
 * because it is a haul, and no machine, because none was named. The hours
 * balance, the approval succeeds, and the job quietly gets free labour.
 *
 * The approver is warned rather than blocked. They may well be right — a driver
 * riding along, a truck billed on another row, a leg the office prices
 * elsewhere — and refusing an approval that is genuinely correct only teaches
 * people to work around the modal.
 *
 * Evaluates the real functions out of payroll.html — no browser needed.
 */

const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');

// Lift a top-level `function name(...) { ... }` out of the page by brace match.
function fnSource(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in payroll.html`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} never closes`);
}

// splitHaulUnpricedRows reads splitEntry and splitRows as free variables and
// calls isTravelSplitRow, which in turn reads TRAVEL_CODE_RE — so all three
// come across together. Lifted from the page rather than restated here: a
// second copy of the travel pattern is a second place for it to drift, and
// this test exists precisely to pin what the page does.
const travelRe = /^\s*const TRAVEL_CODE_RE = (\/.*\/[a-z]*);$/m.exec(src);
if (!travelRe) throw new Error('TRAVEL_CODE_RE not found in payroll.html');
const run = (splitEntry, splitRows) => new Function(
  'splitEntry', 'splitRows',
  `const TRAVEL_CODE_RE = ${travelRe[1]};\n` +
  `${fnSource('isTravelSplitRow')}\n${fnSource('splitHaulUnpricedRows')}\n` +
  `return splitHaulUnpricedRows();`,
)(splitEntry, splitRows);

const HAUL  = { haul_type: 'off_site' };
const ONSITE = { haul_type: 'on_site' };
const NOT   = { haul_type: null };
// equip_hours is deliberately absent from the defaults: 0 is what a fresh split
// row actually carries (_blankSplitRow), so a fixture that wants a PRICED truck
// has to say so, the same way the approver has to.
const row = over => Object.assign(
  { cost_code: 'Earthwork', sub_code: 'Excess Cut', labor_hours: 8, equipment: '' }, over);

console.log('\n[when the warning fires]');

{
  const bad = run(HAUL, [row()]);
  assert('a haul row with hours and no truck is flagged', bad.length === 1);
  assert('  and it is named by its row number', bad[0].n === 1);
  assert('  and carries its hours, so the warning can total them', bad[0].hours === 8);
}
{
  const bad = run(ONSITE, [row()]);
  assert('an on-site haul is flagged too — both answers price labour at $0',
    bad.length === 1);
}
{
  const bad = run(HAUL, [
    row({ labor_hours: 4 }),
    row({ labor_hours: 4, equipment: 'Triaxle Dump', equip_hours: 4 }),
  ]);
  assert('only the row missing its truck is flagged', bad.length === 1 && bad[0].n === 1);
}
{
  const bad = run(HAUL, [row({ labor_hours: 3 }), row({ labor_hours: 5 })]);
  assert('two bare rows are both flagged', bad.length === 2);
  assert('  and their hours add up to the day', bad.reduce((s, r) => s + r.hours, 0) === 8);
}

console.log('\n[when it stays quiet]');

{
  assert('a haul row with a truck AND its hours is fine',
    run(HAUL, [row({ equipment: 'Triaxle Dump', equip_hours: 8 })]).length === 0);
}
{
  assert('an ordinary (non-haul) entry is never flagged — the wage is real there',
    run(NOT, [row()]).length === 0);
}
{
  assert('an entry that predates the question is never flagged',
    run({}, [row()]).length === 0);
}
{
  // Travel keeps the employee's own rate on a haul day: the commute is not
  // bought by the truck, so those hours are priced whether or not one is named.
  assert('a travel row on a haul day is not flagged (it keeps its own rate)',
    run(HAUL, [row({ is_travel: true, equipment: '' })]).length === 0);
  assert('  and neither is one booked to a travel code without the tick',
    run(HAUL, [row({ sub_code: 'Mobilization - Travel', equipment: '' })]).length === 0);
}
{
  assert('a zero-hour row is not flagged — nothing is being given away',
    run(HAUL, [row({ labor_hours: 0 })]).length === 0);
}
{
  assert('whitespace is not a truck',
    run(HAUL, [row({ equipment: '   ' })]).length === 1);
}
{
  // The case the first cut of this warning missed entirely. _blankSplitRow
  // starts every row at equip_hours 0 and only travel rows get theirs filled
  // in, so a named unit with no hours is the LIKELY shape of the mistake, not
  // an exotic one — and it costs the job exactly as nothing as naming no truck.
  const bad = run(HAUL, [row({ equipment: 'Triaxle Dump', equip_hours: 0 })]);
  assert('a named truck with no equipment hours is still flagged', bad.length === 1);
  assert('  and the warning knows a unit was named, so it can say what to fix',
    bad[0].hasUnit === true);
}
{
  const bad = run(HAUL, [row({ equipment: '', equip_hours: 0 })]);
  assert('a row with neither unit nor hours reports no unit',
    bad.length === 1 && bad[0].hasUnit === false);
}
{
  assert('a truck with real hours on it is priced, so it stays quiet',
    run(HAUL, [row({ equipment: 'Triaxle Dump', equip_hours: 8 })]).length === 0);
}
{
  assert('an unrecognized haul answer is not flagged',
    run({ haul_type: 'nonsense' }, [row()]).length === 0);
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
