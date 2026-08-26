#!/usr/bin/env node
'use strict';
/**
 * Approve & Inject: the travel row codes itself.
 *
 * Run: node scripts/test-travel-code-prefill.js
 *
 * A day with travel hours opens with two rows and a Travel tick already on the
 * second one — and then made the supervisor look up and type the cost code and
 * sub code that tick already implies. On turf that is always the same pair
 * (Mobilization / Travel). On paving it is not: the drive is filed under the
 * task, so the same job carries "5in Mill & Fill Travel" and "Excavation Prep
 * Travel" and which one is right is not knowable until the work row names a
 * task.
 *
 * So the prefill reads the job's own bid items and fills only what they
 * settle — one candidate, or one that pairs with the work row's cost code —
 * and re-runs when the work code is picked, which is the moment a paving job
 * becomes answerable. What it must never do is overwrite a supervisor, or
 * guess between two tasks: a wrong code books a day's cost to the wrong task
 * and reads as filled-in while it does it.
 *
 * Evaluates the real functions out of payroll.html in a sandbox — no server or
 * browser needed.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '..', 'payroll.html'), 'utf8');

// Everything in the payroll script block is indented four spaces, so the
// closing brace at that indent is the anchor.
function grab(signature) {
  const i = src.indexOf('function ' + signature);
  if (i < 0) throw new Error(`payroll.html no longer defines: ${signature}`);
  const end = src.indexOf('\n    }\n', i);
  if (end < 0) throw new Error(`could not find the end of: ${signature}`);
  return src.slice(i, end + 6);
}

const travelReSrc = (src.match(/const TRAVEL_CODE_RE = [^\n]+/) || [])[0];
if (!travelReSrc) throw new Error('payroll.html no longer defines TRAVEL_CODE_RE');

let repaints = 0;
const sandbox = {
  console,
  splitEntry: null,
  splitRows: [],
  splitCcCache: {},
  renderSplitRows:  () => { repaints++; },
  renderSplitTally: () => {},
};
vm.createContext(sandbox);
vm.runInContext([
  travelReSrc,
  'let _splitRowSeq = 0;',
  ...[
    'isTravelSplitRow(r) {',
    '_splitRowUid() {',
    '_blankSplitRow(isTravel) {',
    'splitCcListNow() {',
    'splitTravelCandidates(ccList) {',
    'splitTravelSubsFor(ccList, costCode) {',
    'splitPickTravelCodes(ccList, workCostCode) {',
    'splitApplyTravelPrefill() {',
    'splitFillTravelHours(row) {',
    'splitAddRow(isTravel) {',
    'splitOnChange(idx, field, value) {',
    'findCostCode(ccList, code) {',
  ].map(grab),
].join('\n\n'), sandbox);

// ── The two job shapes this has to serve ─────────────────────────────────
// Turf files the drive once, as its own task. Paving files one per task, so
// the job carries several and none of them is "the" travel code.
const TURF = [
  { cost_code: 'Mobilization', sub_codes: ['', 'Travel'] },
  { cost_code: 'Silt Sock',    sub_codes: ['12inch', '18inch'] },
  { cost_code: 'Turf Install', sub_codes: ['Infill', 'Seaming'] },
];
const PAVING = [
  { cost_code: '5in Mill & Fill',  sub_codes: ['5in Mill & Fill', '5in Mill & Fill Travel'] },
  { cost_code: 'Excavation Prep',  sub_codes: ['Excavation Prep', 'Excavation Prep Travel'] },
  { cost_code: '2A Gravel',        sub_codes: ['Base'] },
];
// A job whose only drive line is the cost code itself.
const CC_ONLY = [
  { cost_code: 'Travel Time', sub_codes: ['Local'] },
  { cost_code: 'Paint',       sub_codes: ['Lines'] },
];
// Two travel lines under one task: narrow to the code, leave the choice.
const TWO_UNDER_ONE = [
  { cost_code: 'Mobilization', sub_codes: ['Travel', 'Travel - Overnight'] },
];

// ── What counts as a travel line ─────────────────────────────────────────
console.log('\n[reading the job\'s travel lines]');
{
  const turf = sandbox.splitTravelCandidates(TURF);
  assert('turf offers exactly one — Mobilization / Travel',
    turf.length === 1 && turf[0].cost_code === 'Mobilization' && turf[0].sub_code === 'Travel',
    JSON.stringify(turf));

  const paving = sandbox.splitTravelCandidates(PAVING);
  assert('paving offers one per task', paving.length === 2, JSON.stringify(paving));
  assert('and each is filed under its own task',
    paving.some(c => c.cost_code === '5in Mill & Fill' && c.sub_code === '5in Mill & Fill Travel') &&
    paving.some(c => c.cost_code === 'Excavation Prep' && c.sub_code === 'Excavation Prep Travel'));

  const ccOnly = sandbox.splitTravelCandidates(CC_ONLY);
  assert('a travel cost code with one sub code brings it along',
    ccOnly.length === 1 && ccOnly[0].cost_code === 'Travel Time' && ccOnly[0].sub_code === 'Local',
    JSON.stringify(ccOnly));

  // The word-boundary rule the tally and the server read a row by, applied to
  // the lookup: a Form Traveler is a structure, not a drive, and prefilling it
  // would book work hours at the travel rate.
  const decoys = sandbox.splitTravelCandidates([
    { cost_code: 'Form Traveler', sub_codes: ['Set', 'Strip'] },
    { cost_code: '2A Gravel',     sub_codes: ['Gravel Base'] },
  ]);
  assert('a Form Traveler is not a drive', decoys.length === 0, JSON.stringify(decoys));

  assert('a job with no bid items offers nothing', sandbox.splitTravelCandidates([]).length === 0);
  assert('so does a job that never loaded',        sandbox.splitTravelCandidates(null).length === 0);
}

// ── Which one goes on the row ────────────────────────────────────────────
console.log('\n[picking between them]');
{
  const pick = (list, work) => sandbox.splitPickTravelCodes(list, work);

  const turf = pick(TURF, '');
  assert('turf fills both codes with nothing else known',
    turf && turf.cost_code === 'Mobilization' && turf.sub_code === 'Travel', JSON.stringify(turf));
  assert('and still does once the work row names a task',
    (t => t && t.cost_code === 'Mobilization' && t.sub_code === 'Travel')(pick(TURF, 'Silt Sock')));

  assert('paving with no work code yet fills nothing', pick(PAVING, '') === null,
    JSON.stringify(pick(PAVING, '')));
  const mill = pick(PAVING, '5in Mill & Fill');
  assert('paving pairs the drive with the task once the task is known',
    mill && mill.cost_code === '5in Mill & Fill' && mill.sub_code === '5in Mill & Fill Travel',
    JSON.stringify(mill));
  const exc = pick(PAVING, 'Excavation Prep');
  assert('a different task pairs with a different drive',
    exc && exc.cost_code === 'Excavation Prep' && exc.sub_code === 'Excavation Prep Travel',
    JSON.stringify(exc));
  assert('a work code with no drive of its own falls back to nothing',
    pick(PAVING, '2A Gravel') === null, JSON.stringify(pick(PAVING, '2A Gravel')));

  const two = pick(TWO_UNDER_ONE, '');
  assert('two drives under one task fill the code and leave the choice',
    two && two.cost_code === 'Mobilization' && two.sub_code === '', JSON.stringify(two));

  assert('a job with no travel line at all fills nothing',
    pick([{ cost_code: 'Paint', sub_codes: ['Lines'] }], 'Paint') === null);

  // The other way paving files it: the drive is its own cost code, named after
  // the task, sitting beside it in the same list.
  const SIBLING = [
    { cost_code: '5in Mill & Fill',        sub_codes: ['Tons'] },
    { cost_code: '5in Mill & Fill Travel', sub_codes: ['Hours'] },
    { cost_code: 'Excavation Prep',        sub_codes: ['SY'] },
    { cost_code: 'Excavation Prep-Travel', sub_codes: ['Hours'] },
  ];
  assert('a sibling travel cost code is not guessed at on its own',
    pick(SIBLING, '') === null, JSON.stringify(pick(SIBLING, '')));
  const sib = pick(SIBLING, '5in Mill & Fill');
  assert('but pairs with its task once that is picked',
    sib && sib.cost_code === '5in Mill & Fill Travel' && sib.sub_code === 'Hours',
    JSON.stringify(sib));
  // The two lines are typed by hand and rarely punctuated the same way.
  const dashed = pick(SIBLING, 'Excavation Prep');
  assert('and the pairing survives different punctuation',
    dashed && dashed.cost_code === 'Excavation Prep-Travel', JSON.stringify(dashed));
  assert('a task with no sibling drive still fills nothing',
    pick(SIBLING, 'Paint') === null);
  // An exact sub-code pairing is the stronger signal and wins.
  const both = pick([
    { cost_code: 'Mill & Fill',        sub_codes: ['Tons', 'Mill & Fill Travel'] },
    { cost_code: 'Mill & Fill Travel', sub_codes: ['Hours'] },
  ], 'Mill & Fill');
  assert('a drive filed under the task beats one filed beside it',
    both && both.cost_code === 'Mill & Fill' && both.sub_code === 'Mill & Fill Travel',
    JSON.stringify(both));
}

// ── The turf day: opens filled in ────────────────────────────────────────
console.log('\n[a turf day with travel]');
{
  sandbox.splitEntry = { division: 'turf', job_id: 'J1', computed_hours: 6.5, travel_hours: 1.5 };
  sandbox.splitCcCache['turf::J1'] = TURF;
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true)];
  const moved = sandbox.splitApplyTravelPrefill();
  const [work, drive] = sandbox.splitRows;
  assert('the prefill reports the change', moved === true);
  assert('the travel row opens coded',
    drive.cost_code === 'Mobilization' && drive.sub_code === 'Travel',
    JSON.stringify(drive));
  assert('and is marked as filled in, not typed', drive.code_source === 'auto');
  assert('the work row is left alone',
    work.cost_code === '' && work.sub_code === '' && work.code_source === '');
  assert('the server would price that row as travel', sandbox.isTravelSplitRow(drive));
  assert('running it again is a no-op', sandbox.splitApplyTravelPrefill() === false);
}

// ── The paving day: fills when the task is picked ────────────────────────
console.log('\n[a paving day with travel]');
{
  sandbox.splitEntry = { division: 'paving', job_id: 'P1', computed_hours: 6.5, travel_hours: 1.5 };
  sandbox.splitCcCache['paving::P1'] = PAVING;
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true)];

  assert('nothing is guessed while the task is unknown',
    sandbox.splitApplyTravelPrefill() === false);
  assert('so the travel row opens blank', sandbox.splitRows[1].cost_code === '');

  repaints = 0;
  sandbox.splitOnChange(0, 'cost_code', '5in Mill & Fill');
  const drive = sandbox.splitRows[1];
  assert('picking the work task codes the travel row',
    drive.cost_code === '5in Mill & Fill' && drive.sub_code === '5in Mill & Fill Travel',
    JSON.stringify(drive));
  assert('and repaints so it shows up', repaints > 0);
  assert('the server would price it as travel', sandbox.isTravelSplitRow(drive));

  // Wrong task picked, then corrected: the drive follows, because it was this
  // prefill that put it there and nobody has said otherwise.
  sandbox.splitOnChange(0, 'cost_code', 'Excavation Prep');
  assert('correcting the task moves the drive with it',
    drive.cost_code === 'Excavation Prep' && drive.sub_code === 'Excavation Prep Travel',
    JSON.stringify(drive));

  // A task with no drive of its own leaves what was already there rather than
  // clearing it — the supervisor can see it and change it.
  sandbox.splitOnChange(0, 'cost_code', '2A Gravel');
  assert('a task with no drive line leaves the last one standing',
    drive.cost_code === 'Excavation Prep', JSON.stringify(drive));
}

// ── The travel row's own cost code offers its sub code ───────────────────
console.log('\n[coding the travel row directly]');
{
  sandbox.splitEntry = { division: 'paving', job_id: 'P1', computed_hours: 6.5, travel_hours: 1.5 };
  sandbox.splitCcCache['paving::P1'] = PAVING;
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true)];

  sandbox.splitOnChange(1, 'cost_code', 'Excavation Prep');
  assert('picking the drive\'s own task fills its sub code',
    sandbox.splitRows[1].sub_code === 'Excavation Prep Travel',
    JSON.stringify(sandbox.splitRows[1]));

  // The work row gets no such help — its sub code is a real choice.
  sandbox.splitOnChange(0, 'cost_code', 'Excavation Prep');
  assert('the work row picks its own sub code', sandbox.splitRows[0].sub_code === '');

  // Filling the sub code is help on top of a cost code the supervisor chose —
  // it does NOT hand the row back to the prefill. Marking it 'auto' here let
  // the prefill call in the same commit revert the cost code they had just
  // picked to whatever pairs with the work row, which on a paving job made the
  // drive's cost code impossible to change at all.
  assert('and the drive\'s row stays the supervisor\'s',
    sandbox.splitRows[1].code_source === 'manual', sandbox.splitRows[1].code_source);
}

// ── Re-pointing the drive at a different task must stick ─────────────────
// The whole reason paving needs a hand is that the pairing is a guess. If the
// guess cannot be overridden the prefill is worse than no prefill.
console.log('\n[re-pointing the drive]');
{
  sandbox.splitEntry = { division: 'paving', job_id: 'P1', computed_hours: 6.5, travel_hours: 1.5 };
  sandbox.splitCcCache['paving::P1'] = PAVING;
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true)];

  sandbox.splitOnChange(0, 'cost_code', '5in Mill & Fill');
  assert('the drive is paired with the work task',
    sandbox.splitRows[1].cost_code === '5in Mill & Fill', JSON.stringify(sandbox.splitRows[1]));

  sandbox.splitOnChange(1, 'cost_code', 'Excavation Prep');
  assert('re-pointing it at another task sticks',
    sandbox.splitRows[1].cost_code === 'Excavation Prep', JSON.stringify(sandbox.splitRows[1]));
  assert('with that task\'s own drive under it',
    sandbox.splitRows[1].sub_code === 'Excavation Prep Travel');

  // And it survives the work task being changed afterwards.
  sandbox.splitOnChange(0, 'cost_code', 'Excavation Prep');
  sandbox.splitOnChange(0, 'cost_code', '5in Mill & Fill');
  assert('and survives the work task moving underneath it',
    sandbox.splitRows[1].cost_code === 'Excavation Prep', JSON.stringify(sandbox.splitRows[1]));
}

// ── Nothing the supervisor typed is ever overwritten ─────────────────────
console.log('\n[what the supervisor typed stands]');
{
  sandbox.splitEntry = { division: 'paving', job_id: 'P1', computed_hours: 6.5, travel_hours: 1.5 };
  sandbox.splitCcCache['paving::P1'] = PAVING;
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true)];

  sandbox.splitOnChange(1, 'cost_code', 'Excavation Prep');
  sandbox.splitOnChange(1, 'sub_code',  'Excavation Prep');   // deliberately NOT the travel line
  assert('a hand-picked sub code is marked as theirs',
    sandbox.splitRows[1].code_source === 'manual');

  sandbox.splitOnChange(0, 'cost_code', '5in Mill & Fill');
  assert('and survives the work task being picked',
    sandbox.splitRows[1].cost_code === 'Excavation Prep' &&
    sandbox.splitRows[1].sub_code  === 'Excavation Prep',
    JSON.stringify(sandbox.splitRows[1]));
  assert('re-running the prefill will not touch it',
    sandbox.splitApplyTravelPrefill() === false);
}

// ── A re-edit shows the split that was posted, not a fresh guess ─────────
console.log('\n[Edit Split on an approved entry]');
{
  sandbox.splitEntry = { division: 'turf', job_id: 'J1', computed_hours: 6.5, travel_hours: 1.5 };
  sandbox.splitCcCache['turf::J1'] = TURF;
  // What comes back from the server carries no code_source — it is nobody's
  // guess, it is what was approved.
  sandbox.splitRows = [
    { cost_code: 'Silt Sock',    sub_code: '12inch', labor_hours: 6.5, is_travel: false },
    { cost_code: 'Turf Install', sub_code: 'Infill', labor_hours: 1.5, is_travel: true },
  ];
  assert('a posted split is never re-guessed', sandbox.splitApplyTravelPrefill() === false);
  assert('and stays exactly as it was approved',
    sandbox.splitRows[1].cost_code === 'Turf Install' && sandbox.splitRows[1].sub_code === 'Infill',
    JSON.stringify(sandbox.splitRows[1]));
}

// ── Ticking and unticking Travel ─────────────────────────────────────────
console.log('\n[the Travel tick]');
{
  sandbox.splitEntry = { division: 'turf', job_id: 'J1', computed_hours: 8, travel_hours: 0 };
  sandbox.splitCcCache['turf::J1'] = TURF;
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(false)];

  sandbox.splitOnChange(1, 'is_travel', true);
  assert('ticking Travel on a blank row codes it',
    sandbox.splitRows[1].cost_code === 'Mobilization' && sandbox.splitRows[1].sub_code === 'Travel',
    JSON.stringify(sandbox.splitRows[1]));

  sandbox.splitOnChange(1, 'is_travel', false);
  assert('unticking takes the guessed codes back off',
    sandbox.splitRows[1].cost_code === '' && sandbox.splitRows[1].sub_code === '',
    JSON.stringify(sandbox.splitRows[1]));
  // This is the point of clearing them: a row left on Mobilization / Travel
  // would still be counted as travel by the tally and paid as travel by the
  // server, which is the opposite of what unticking says.
  assert('so the row is no longer travel to anyone', !sandbox.isTravelSplitRow(sandbox.splitRows[1]));

  // A typed code is not the prefill's to take away.
  sandbox.splitOnChange(1, 'is_travel', true);
  sandbox.splitOnChange(1, 'cost_code', 'Turf Install');
  sandbox.splitOnChange(1, 'is_travel', false);
  assert('but a typed code is left where it was put',
    sandbox.splitRows[1].cost_code === 'Turf Install', JSON.stringify(sandbox.splitRows[1]));

  // + Add travel row arrives coded too.
  sandbox.splitRows = [sandbox._blankSplitRow(false)];
  sandbox.splitAddRow(true);
  assert('+ Add travel row arrives coded',
    sandbox.splitRows[1].cost_code === 'Mobilization' && sandbox.splitRows[1].sub_code === 'Travel');
  sandbox.splitAddRow(false);
  assert('+ Add labor row does not', sandbox.splitRows[2].cost_code === '');
}

// ── The hours the entry already states ───────────────────────────────────
// The entry says how much of the day was the drive, and the travel row is
// where those hours go. On the ordinary day — one drive, one figure — that
// leaves nothing to type there at all.
console.log('\n[the travel row opens with its hours in]');
{
  sandbox.splitEntry = { division: 'turf', job_id: 'J1', computed_hours: 8, travel_hours: 2 };
  sandbox.splitCcCache['turf::J1'] = TURF;
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true)];
  sandbox.splitApplyTravelPrefill();
  assert('the drive gets the hours the entry declares',
    sandbox.splitFillTravelHours(sandbox.splitRows[1]) === true &&
    sandbox.splitRows[1].labor_hours === 2, String(sandbox.splitRows[1].labor_hours));
  assert('and the work row is left alone', sandbox.splitRows[0].labor_hours === 0);
  assert('running it again does nothing',
    sandbox.splitFillTravelHours(sandbox.splitRows[1]) === false &&
    sandbox.splitRows[1].labor_hours === 2);

  // A second drive row must not double the day's travel.
  sandbox.splitAddRow(true);
  assert('a second travel row gets what is left, which is nothing',
    sandbox.splitRows[2].labor_hours === 0, String(sandbox.splitRows[2].labor_hours));
  assert('so the travel hours still total what the entry says',
    sandbox.splitRows.filter(r => r.is_travel)
      .reduce((s, r) => s + r.labor_hours, 0) === 2);

  // Split across two drives by hand, and the remainder is what is left.
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true),
                       sandbox._blankSplitRow(true)];
  sandbox.splitRows[1].labor_hours = 0.75;
  assert('the second drive picks up the remainder',
    sandbox.splitFillTravelHours(sandbox.splitRows[2]) === true &&
    sandbox.splitRows[2].labor_hours === 1.25, String(sandbox.splitRows[2].labor_hours));

  // A figure someone typed is never moved.
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true)];
  sandbox.splitRows[1].labor_hours = 0.75;
  assert('a figure already typed is left where it is',
    sandbox.splitFillTravelHours(sandbox.splitRows[1]) === false &&
    sandbox.splitRows[1].labor_hours === 0.75);

  // Ticking Travel on a blank row fills the hours as well as the codes.
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(false)];
  sandbox.splitOnChange(1, 'is_travel', true);
  assert('ticking Travel fills the hours too',
    sandbox.splitRows[1].labor_hours === 2, String(sandbox.splitRows[1].labor_hours));
  // Unticking takes the codes back but not the hours: a travel code on an
  // unticked row is still priced as travel, which is why those are cleared —
  // hours carry no such rule, they are part of the day either way, and the
  // tally says so if the two stop agreeing.
  sandbox.splitOnChange(1, 'is_travel', false);
  assert('unticking clears the codes but keeps the hours',
    sandbox.splitRows[1].cost_code === '' && sandbox.splitRows[1].labor_hours === 2,
    JSON.stringify(sandbox.splitRows[1]));

  // A day the entry says had no travel gets nothing.
  sandbox.splitEntry = { division: 'turf', job_id: 'J1', computed_hours: 8, travel_hours: 0 };
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true)];
  assert('a day with no travel is given no travel hours',
    sandbox.splitFillTravelHours(sandbox.splitRows[1]) === false &&
    sandbox.splitRows[1].labor_hours === 0);
  assert('and neither a missing row nor a closed modal throws',
    sandbox.splitFillTravelHours(null) === false);

  // Edit Split reopens a posted split, whose hours are what was approved.
  const openSrc2 = src.slice(src.indexOf('async function openSplitModal'),
                             src.indexOf('function closeSplit()'));
  assert('and a reopened split is never restated',
    /mode !== 'resplit'[\s\S]{0,120}splitFillTravelHours/.test(openSrc2));
}

// ── Blurring a cost code must not wipe the sub code ──────────────────────
// The combobox commits on blur whether or not anything was picked, so a
// supervisor clicking into a finished cost code and tabbing out was re-running
// the "cost code changed, clear the sub code" branch against an unchanged
// value — and losing the sub code they had just chosen.
console.log('\n[tabbing through a finished row]');
{
  sandbox.splitEntry = { division: 'turf', job_id: 'J1', computed_hours: 8, travel_hours: 0 };
  sandbox.splitCcCache['turf::J1'] = TURF;
  sandbox.splitRows = [{ cost_code: 'Silt Sock', sub_code: '18inch', labor_hours: 8,
                         is_travel: false, code_source: 'manual' }];
  repaints = 0;
  sandbox.splitOnChange(0, 'cost_code', 'Silt Sock');    // blur, nothing picked
  assert('re-committing the same cost code keeps the sub code',
    sandbox.splitRows[0].sub_code === '18inch', JSON.stringify(sandbox.splitRows[0]));
  assert('and does not repaint the table out from under the cursor', repaints === 0);

  sandbox.splitOnChange(0, 'cost_code', 'Turf Install'); // a real change
  assert('an actual change still clears it', sandbox.splitRows[0].sub_code === '');
}

// ── A job the lookup could not load ──────────────────────────────────────
console.log('\n[no cost codes to read]');
{
  sandbox.splitEntry = { division: 'kiewit', job_id: 'K9', computed_hours: 6.5, travel_hours: 1.5 };
  delete sandbox.splitCcCache['kiewit::K9'];
  sandbox.splitRows = [sandbox._blankSplitRow(false), sandbox._blankSplitRow(true)];
  assert('the prefill stands down rather than inventing a code',
    sandbox.splitApplyTravelPrefill() === false);
  assert('and the row is the blank one the supervisor gets today',
    sandbox.splitRows[1].cost_code === '' && sandbox.splitRows[1].sub_code === '');
  sandbox.splitEntry = null;
  assert('with no entry open it does nothing at all',
    sandbox.splitApplyTravelPrefill() === false);
}

// ── Every code it prefills is one the server prices as travel ────────────
// The prefill and the pricing must not be able to disagree: a code this fills
// in that the server reads as ordinary work would pay the drive at the
// prevailing rate on a prevailing-wage job.
console.log('\n[what it fills in is what the server calls travel]');
{
  const apiSrc = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'), 'utf8');
  const re = apiSrc.match(/const TRAVEL_CODE_RE = [^\n]+/);
  const i  = apiSrc.indexOf('function isTravelSplitRow');
  assert('the server still defines its own rule', !!re && i >= 0);
  const sb = { console };
  vm.createContext(sb);
  vm.runInContext(`${re[0]}\n${apiSrc.slice(i, apiSrc.indexOf('\n}', i) + 2)}`, sb);

  for (const [label, list, work] of [
    ['turf',                    TURF,          ''],
    ['paving, task picked',     PAVING,        '5in Mill & Fill'],
    ['paving, other task',      PAVING,        'Excavation Prep'],
    ['a travel cost code',      CC_ONLY,       ''],
  ]) {
    const pick = sandbox.splitPickTravelCodes(list, work);
    assert(`  ${label}: the server calls it travel`,
      !!pick && sb.isTravelSplitRow({ cost_code: pick.cost_code, sub_code: pick.sub_code }),
      JSON.stringify(pick));
  }

  // The one deliberately incomplete fill: several drives under one task, so
  // the cost code is settled and the sub code is not. That pair does NOT read
  // as travel on the codes alone — which is fine, because the row it lands on
  // is the one already ticked Travel, and the tick is the other half of the
  // server's rule. What matters is that it is left visibly unfinished rather
  // than guessed at.
  const partial = sandbox.splitPickTravelCodes(TWO_UNDER_ONE, '');
  assert('  a task with two drives leaves the sub code for the supervisor',
    !!partial && partial.sub_code === '', JSON.stringify(partial));
  assert('  and the Travel tick on the row still prices it as travel',
    sb.isTravelSplitRow({ cost_code: partial.cost_code, sub_code: '', is_travel: true }));
  assert('  with the choice narrowed to that task\'s two drives',
    sandbox.splitTravelSubsFor(TWO_UNDER_ONE, partial.cost_code).length === 2);
}

// ── A prefilled code has to look like one ────────────────────────────────
// Filled-in codes are a guess off the job's bid items, not something anyone
// checked. If they render identically to a typed code, a wrong guess on an
// unusual job sails through the approval looking like a decision.
console.log('\n[the prefilled cells read as prefilled]');
{
  const cbEscSrc = (src.match(/const _cbEsc = [^\n]+/) || [])[0];
  if (!cbEscSrc) throw new Error('payroll.html no longer defines _cbEsc');
  const store = {};
  const render = {
    console,
    splitEntry: { division: 'turf', job_id: 'J1', computed_hours: 6.5, travel_hours: 1.5 },
    splitCcCache: { 'turf::J1': TURF },
    splitEquipmentList: ['320 Excavator'],
    splitRows: [],
    num2: n => Number(n).toFixed(2),
    // No focused cell in this fixture, so the snapshot comes back empty and
    // the restore is a no-op — this section is about the markup.
    document: { activeElement: null,
                getElementById: id => (store[id] = store[id] || { innerHTML: '' }) },
  };
  vm.createContext(render);
  vm.runInContext([
    cbEscSrc,
    'let _splitRowSeq = 0;',
    ...[
      'numInputVal(n) {',
      '_splitRowUid() {',
      'splitCcListNow() {',
      'findCostCode(ccList, code) {',
      '_cbHtml(rowIdx, field, currentValue, options, placeholder, opts) {',
      // renderSplitRows puts the cursor back after a repaint, so the two
      // halves of that come across with it.
      '_splitFocusSnapshot() {',
      '_splitFocusRestore(snap) {',
      'renderSplitRows() {',
    ].map(grab),
  ].join('\n\n'), render);

  render.splitRows = [
    { cost_code: 'Silt Sock', sub_code: '12inch', quantity: 0, equipment: '',
      labor_hours: 6.5, equip_hours: 0, is_travel: false, code_source: 'manual' },
    { cost_code: 'Mobilization', sub_code: 'Travel', quantity: 0, equipment: '',
      labor_hours: 1.5, equip_hours: 0, is_travel: true, code_source: 'auto' },
  ];
  render.renderSplitRows();
  const html = store.splitTbody.innerHTML;

  // Two cells on the travel row — cost code and sub code — and nothing else.
  assert('the prefilled row\'s two code cells are marked',
    (html.match(/cb-input auto-code/g) || []).length === 2,
    String((html.match(/cb-input auto-code/g) || []).length));
  assert('and they say where the value came from',
    (html.match(/title="Filled in from this job's travel code/g) || []).length === 2,
    html.slice(0, 400));
  assert('the values still render',
    /value="Mobilization"/.test(html) && /value="Travel"/.test(html));
  assert('the typed row is not marked',
    !/value="Silt Sock"[^>]*auto-code/.test(html) && !/auto-code[^>]*value="Silt Sock"/.test(html));
  assert('the equipment cell is never marked',
    !/data-field="equipment"[^>]*auto-code/.test(html));

  // A partial prefill — the cost code settled, the sub code deliberately left
  // open because the task files more than one drive under it. Only the cell
  // that actually got a value may claim to have been filled in; a dashed empty
  // box saying "filled in from this job's travel code" is precisely the kind of
  // thing this marking exists to stop.
  render.splitRows[1].sub_code = '';
  render.renderSplitRows();
  const partial = store.splitTbody.innerHTML;
  assert('a partial prefill marks only the cell it filled',
    (partial.match(/cb-input auto-code/g) || []).length === 1,
    String((partial.match(/cb-input auto-code/g) || []).length));
  assert('and the empty sub code is left unmarked',
    !/data-field="sub_code"[\s\S]{0,120}?auto-code/.test(partial));
  render.splitRows[1].sub_code = 'Travel';

  // Once the supervisor takes it over the marking has to go.
  render.splitRows[1].code_source = 'manual';
  render.renderSplitRows();
  assert('taking the row over clears the marking',
    !/auto-code/.test(store.splitTbody.innerHTML));

  // The CSS that makes the marking visible has to actually be there.
  assert('payroll.html styles the marking',
    /\.cb-input\.auto-code\s*\{[^}]*border-style:\s*dashed/.test(src));
  assert('and drops back to solid on focus',
    /\.cb-input\.auto-code:focus\s*\{[^}]*border-style:\s*solid/.test(src));
}

// ── Bulk approve runs the same prefill on the group's travel leg ─────────
// A bulk card is keyed on the job, so one travel code covers a whole crew.
// Leaving it blank there is not neutral — the drive then books to the same
// code as the work, for everybody, which is the thing this is meant to stop.
console.log('\n[bulk approve]');
{
  // A repaint from a change handler has to wait for the cursor to land, so the
  // deferral is part of what is under test: setTimeout is captured rather than
  // run, and fired by hand.
  let bulkRepaints = 0;
  const deferred = [];
  const bulk = {
    console,
    bulkGroups: [],
    bulkR2: n => Math.round((Number(n) || 0) * 100) / 100,
    renderBulkGroups: () => { bulkRepaints++; },
    setTimeout: fn => { deferred.push(fn); return deferred.length; },
    updateBulkRunBtn: () => {},
  };
  vm.createContext(bulk);
  vm.runInContext([
    travelReSrc,
    ...[
      'splitTravelCandidates(ccList) {',
      'splitTravelSubsFor(ccList, costCode) {',
      'splitPickTravelCodes(ccList, workCostCode) {',
      'bulkApplyTravelPrefill(g) {',
      'renderBulkGroupsSoon() {',
      'bulkCostCode(idx, value) {',
      'bulkTravelCostCode(idx, value) {',
      'bulkSet(idx, field, value) {',
    ].map(grab),
  ].join('\n\n'), bulk);

  const group = (ccList, travelHours = 1.5) => ({
    type: 'split', ccList,
    entries: [{ id: 'a', computed_hours: 6.5, travel_hours: travelHours }],
    template: { cost_code: '', sub_code: '', travel_cost_code: '', travel_sub_code: '',
                travel_code_source: '' },
  });

  const turf = group(TURF);
  bulk.bulkGroups = [turf];
  assert('a turf group opens with its travel leg coded',
    bulk.bulkApplyTravelPrefill(turf) === true &&
    turf.template.travel_cost_code === 'Mobilization' &&
    turf.template.travel_sub_code  === 'Travel',
    JSON.stringify(turf.template));

  const paving = group(PAVING);
  bulk.bulkGroups = [paving];
  assert('a paving group waits for the task',
    bulk.bulkApplyTravelPrefill(paving) === false && paving.template.travel_cost_code === '');
  bulk.bulkCostCode(0, '5in Mill & Fill');
  assert('and codes the travel leg once the task is picked',
    paving.template.travel_cost_code === '5in Mill & Fill' &&
    paving.template.travel_sub_code  === '5in Mill & Fill Travel',
    JSON.stringify(paving.template));
  bulk.bulkCostCode(0, 'Excavation Prep');
  assert('correcting the task moves the travel leg with it',
    paving.template.travel_cost_code === 'Excavation Prep' &&
    paving.template.travel_sub_code  === 'Excavation Prep Travel',
    JSON.stringify(paving.template));

  // Typed into, and it is the supervisor's from then on.
  const typed = group(PAVING);
  bulk.bulkGroups = [typed];
  bulk.bulkSet(0, 'travel_cost_code', '2A Gravel');
  bulk.bulkSet(0, 'travel_sub_code',  'Base');
  bulk.bulkCostCode(0, '5in Mill & Fill');
  assert('a typed travel leg survives the work code being picked',
    typed.template.travel_cost_code === '2A Gravel' && typed.template.travel_sub_code === 'Base',
    JSON.stringify(typed.template));

  // Naming the travel cost code by hand still offers the one drive under it.
  const byHand = group(PAVING);
  bulk.bulkGroups = [byHand];
  bulk.bulkTravelCostCode(0, 'Excavation Prep');
  assert('naming the travel cost code fills the one drive filed under it',
    byHand.template.travel_sub_code === 'Excavation Prep Travel', JSON.stringify(byHand.template));
  bulk.bulkTravelCostCode(0, '2A Gravel');
  assert('and a task with no drive leaves it blank',
    byHand.template.travel_sub_code === '', JSON.stringify(byHand.template));

  // ── The bulk card repaints from a change handler ──────────────────────
  // A change event on a text input fires in the gap between the old control
  // losing focus and the new one gaining it, with activeElement parked on the
  // body. Repainting inside that gap destroys the field the cursor was on its
  // way to, so it ends up nowhere and the next Tab restarts from the top of
  // the page.
  const timed = group(TURF);
  bulk.bulkGroups = [timed];
  bulkRepaints = 0; deferred.length = 0;
  bulk.bulkCostCode(0, 'Silt Sock');
  assert('committing a cost code does not repaint inside the focus gap',
    bulkRepaints === 0 && deferred.length === 1, `${bulkRepaints} repaints, ${deferred.length} deferred`);
  deferred.forEach(fn => fn());
  assert('it repaints once the cursor has landed', bulkRepaints === 1);
  bulkRepaints = 0; deferred.length = 0;
  bulk.bulkTravelCostCode(0, 'Mobilization');
  assert('and the travel cost code waits the same way',
    bulkRepaints === 0 && deferred.length === 1, `${bulkRepaints} repaints, ${deferred.length} deferred`);
  deferred.forEach(fn => fn());

  // The card hides the travel fields when no day in the group has travel
  // hours. Filling them anyway would put a code into the approval that nobody
  // was shown.
  const noTravel = group(TURF, 0);
  bulk.bulkGroups = [noTravel];
  assert('a group with no travel hours is left blank',
    bulk.bulkApplyTravelPrefill(noTravel) === false &&
    noTravel.template.travel_cost_code === '', JSON.stringify(noTravel.template));
  bulk.bulkCostCode(0, 'Silt Sock');
  assert('and stays blank when the work code is picked',
    noTravel.template.travel_cost_code === '' && noTravel.template.travel_sub_code === '',
    JSON.stringify(noTravel.template));

  // Non-split groups have no travel leg at all.
  const quarry = { type: 'quarry', ccList: TURF, entries: [], template: { travel_code_source: '' } };
  assert('a quarry group is left alone', bulk.bulkApplyTravelPrefill(quarry) === false);
  assert('and so is nothing at all',      bulk.bulkApplyTravelPrefill(null) === false);
}

// ── A repaint must not take the cursor with it ───────────────────────────
// The cost-code combobox commits 120ms AFTER it loses focus, so its repaint
// lands while the supervisor is already typing in the next cell — and a
// repaint replaces every control in the table. Tabbing out of a cost code used
// to leave the focus on the cost code itself (the default Tab had nothing left
// to move from), so the next thing typed went straight back into the box they
// had just left. Run against a real DOM, with the page's own combobox.
console.log('\n[a repaint keeps the cursor where it was]');
{
  const { JSDOM } = require('jsdom');
  const names = [
    'isTravelSplitRow(r) {', '_splitRowUid() {', '_blankSplitRow(isTravel) {',
    'findCostCode(ccList, code) {', 'cbCloseAll() {', 'splitDeleteRow(idx) {',
    'splitCcListNow() {', 'splitTravelCandidates(ccList) {', 'splitTravelSubsFor(ccList, costCode) {',
    'splitPickTravelCodes(ccList, workCostCode) {', 'splitApplyTravelPrefill() {',
    'splitFillTravelHours(row) {', 'numInputVal(n) {',
    '_cbHtml(rowIdx, field, currentValue, options, placeholder, opts) {', '_cbReadOptions(input) {',
    'cbOnFocus(input) {', 'cbOnInput(input) {', 'cbRenderMenu(input) {', 'cbPositionMenu(input) {',
    'cbScrollHi(input) {', 'cbClose(input) {', 'cbCommit(input) {',
    '_splitFocusSnapshot() {', '_splitFocusRestore(snap) {',
    'renderSplitRows() {', 'splitOnChange(idx, field, value) {',
    'splitFlushPendingCommits() {',
  ];
  const harness = [
    travelReSrc,
    (src.match(/const _cbEsc = [^\n]+/) || [])[0],
    'const _cbState = new WeakMap();',
    'let _splitRowSeq = 0;',
    ...names.map(grab),
    'function num2(n){ return Number(n).toFixed(2); }',
    'function renderSplitTally(){}',
    'function cbOnKey(){}  function cbOnBlur(){}',
    'function renderSplitTallyNoop(){}',
    "var splitEntry = { division: 'turf', job_id: 'J1', computed_hours: 6.5, travel_hours: 1.5 };",
    "var splitCcCache = { 'turf::J1': " + JSON.stringify(TURF) + ' };',
    'var splitEquipmentList = [];',
    'var splitRows = [_blankSplitRow(false), _blankSplitRow(true)];',
  ].join('\n\n');

  const dom = new JSDOM(
    '<!doctype html><body><table class="split-table"><tbody id="splitTbody"></tbody></table></body>',
    { url: 'http://localhost/', runScripts: 'dangerously' });
  const { window } = dom;
  window.eval(harness);
  const doc = window.document;
  window.eval('renderSplitRows()');

  const row  = i => doc.querySelectorAll('#splitTbody tr')[i];
  const cell = (i, field) => row(i).querySelector(`.cb[data-field="${field}"] .cb-input`);
  const opts = (i, field) => JSON.parse(row(i).querySelector(`.cb[data-field="${field}"]`).dataset.options);
  const whereIsFocus = () => {
    const el = doc.activeElement;
    const cb = el && el.closest && el.closest('.cb');
    if (cb) return `row${cb.dataset.row}/${cb.dataset.field}`;
    return el === doc.body ? 'BODY' : 'other';
  };

  // The supervisor picks a cost code and moves on to the sub code. 120ms later
  // the deferred commit fires and repaints the table underneath them.
  cell(0, 'sub_code').focus();
  assert('the supervisor is standing in the sub code', whereIsFocus() === 'row0/sub_code');
  window.eval("splitOnChange(0, 'cost_code', 'Silt Sock')");
  assert('and is still standing there after the repaint',
    whereIsFocus() === 'row0/sub_code', whereIsFocus());
  assert('with the sub codes of the cost code just picked',
    opts(0, 'sub_code').join() === '12inch,18inch', JSON.stringify(opts(0, 'sub_code')));

  // The caret survives a repaint that leaves the cell's value alone — which is
  // most of them, since a repaint is triggered by a change to some OTHER row
  // as often as by this one. Focusing a combobox selects all of its text, so
  // without putting the caret back the next keystroke replaces the code
  // instead of continuing it.
  window.eval("splitRows[0].sub_code = '18inch'; renderSplitRows()");
  const sc = cell(0, 'sub_code');
  sc.focus(); sc.setSelectionRange(2, 2);
  window.eval("splitOnChange(1, 'cost_code', 'Turf Install')");   // a repaint from another row
  assert('the cell keeps its value across an unrelated repaint',
    cell(0, 'sub_code').value === '18inch', cell(0, 'sub_code').value);
  assert('and the caret is put back where it was, not left selecting everything',
    doc.activeElement.selectionStart === 2 && doc.activeElement.selectionEnd === 2,
    `${doc.activeElement.selectionStart}-${doc.activeElement.selectionEnd}`);

  // Ticking Travel repaints from the checkbox itself. Nothing in this table
  // repainted from a checkbox before the prefill existed.
  window.eval('splitRows[1].is_travel = false; splitRows[1].cost_code = "";' +
              'splitRows[1].sub_code = ""; splitRows[1].code_source = ""; renderSplitRows()');
  row(1).querySelector('.travel-cell input').focus();
  window.eval("splitOnChange(1, 'is_travel', true)");
  assert('ticking Travel leaves the cursor on the tick',
    doc.activeElement === row(1).querySelector('.travel-cell input'), whereIsFocus());
  assert('and the row came back coded', window.eval('splitRows[1].cost_code') === 'Mobilization');

  // Nothing focused inside the table — a repaint must not go grabbing.
  doc.activeElement.blur();
  window.eval("splitOnChange(0, 'cost_code', 'Silt Sock')");
  assert('a repaint with nobody in the table leaves the focus alone',
    whereIsFocus() === 'BODY', whereIsFocus());

  // ── A trailing space is invisible and emptied the sub-code list ────────
  // These codes are typed as often as picked. The commit stores what is in the
  // box, and the sub-code list is looked up by exact cost code, so one stray
  // space produced an empty picker on a code that was otherwise perfectly
  // good — and rode along onto the injected row.
  const cc = cell(0, 'cost_code');
  cc.focus();
  cc.value = '  Mobilization  ';
  window.eval("cbCommit(document.querySelectorAll('#splitTbody tr')[0]" +
              ".querySelector('.cb[data-field=\"cost_code\"] .cb-input'))");
  assert('a padded cost code is stored trimmed',
    window.eval('splitRows[0].cost_code') === 'Mobilization',
    JSON.stringify(window.eval('splitRows[0].cost_code')));
  assert('the box is cleaned up to match what was stored',
    cell(0, 'cost_code').value === 'Mobilization', JSON.stringify(cell(0, 'cost_code').value));
  assert('and its sub codes are found rather than coming back empty',
    opts(0, 'sub_code').join() === ',Travel', JSON.stringify(opts(0, 'sub_code')));

  // ── A pending commit belongs to a ROW, not to a position ──────────────
  // The commit is deferred 120ms past the blur so a click on a menu option is
  // handled first. A single ordinary click that lands on another row's ✕
  // deletes a row inside that window — and every row under it shifts up. Named
  // by position, the pending edit landed on whichever row moved into the slot:
  // a day's cost booked to the wrong task, with the table showing a perfectly
  // plausible result.
  window.eval("splitRows = ['A','B','C','D','E'].map(function (n) {" +
              "  return Object.assign(_blankSplitRow(false), { cost_code: n }); });" +
              'renderSplitRows()');
  const rowC = cell(2, 'cost_code');            // the supervisor retypes row C
  rowC.value = 'Turf Install';
  window.eval('splitDeleteRow(0)');             // and the same click hits row A's ✕
  window._pendingInput = rowC;                  // 120ms later the commit fires,
  window.eval('cbCommit(window._pendingInput)');// on a node that is now detached
  assert('a pending edit follows its row when the rows shift under it',
    window.eval('splitRows.map(function (r) { return r.cost_code; }).join()') ===
      'B,Turf Install,D,E',
    window.eval('splitRows.map(function (r) { return r.cost_code; }).join()'));

  // And an edit whose row is gone goes with it rather than landing on a
  // stranger.
  window.eval("splitRows = ['A','B','C'].map(function (n) {" +
              '  return Object.assign(_blankSplitRow(false), { cost_code: n }); });' +
              'renderSplitRows()');
  const rowA = cell(0, 'cost_code');
  rowA.value = 'Turf Install';
  window.eval('splitDeleteRow(0)');
  window._pendingInput = rowA;
  window.eval('cbCommit(window._pendingInput)');
  assert('and an edit whose row was deleted is dropped, not re-homed',
    window.eval('splitRows.map(function (r) { return r.cost_code; }).join()') === 'B,C',
    window.eval('splitRows.map(function (r) { return r.cost_code; }).join()'));

  // ── A later action beats a commit that predates it ────────────────────
  // Unticking Travel clears the drive's codes. The click that reaches the tick
  // blurs the sub-code cell, so that cell's commit arrives 120ms afterwards —
  // and it used to put the code straight back. A sub code does not repaint on
  // its own, so the table went on showing the row as ordinary work while the
  // split still carried a travel code, and the server went on pricing it as
  // travel: exactly what unticking is supposed to prevent.
  window.eval('splitRows = [_blankSplitRow(false), _blankSplitRow(true)];' +
              'splitApplyTravelPrefill(); renderSplitRows()');
  assert('the drive opens coded and ticked',
    window.eval('splitRows[1].sub_code') === 'Travel' &&
    window.eval('splitRows[1].code_source') === 'auto');
  const driveSub = cell(1, 'sub_code');       // the supervisor is standing here
  driveSub.focus();
  window.eval("splitOnChange(1, 'is_travel', false)");   // and clicks the tick
  assert('unticking clears the codes', window.eval('splitRows[1].sub_code') === '');
  window._pendingInput = driveSub;            // the blur's commit, 120ms late
  window.eval('cbCommit(window._pendingInput)');
  assert('and the pending sub-code commit does not put it back',
    window.eval('splitRows[1].sub_code') === '', window.eval('splitRows[1].sub_code'));
  assert('so the row is not travel to the server either',
    window.eval('isTravelSplitRow(splitRows[1])') === false);

  // The table and the split must never disagree — the supervisor approves
  // from the table.
  const domVsState = () => window.eval(
    '[...document.querySelectorAll("#splitTbody tr")].every(function (tr, i) {' +
    '  return ["cost_code","sub_code","equipment"].every(function (f) {' +
    '    var el = tr.querySelector(".cb[data-field=\\"" + f + "\\"] .cb-input");' +
    '    return !el || el.value === String(splitRows[i][f] || ""); }); })');
  assert('the table still shows exactly what the split holds', domVsState() === true);

  // A commit nothing else disturbed still lands, and lands painted. A sub code
  // does not repaint on its own, so one arriving from a cell the table has
  // already replaced would otherwise sit in the split without ever appearing
  // in the table the supervisor approves from.
  window.eval("splitRows = ['A','B','C'].map(function (n) {" +
              "  return Object.assign(_blankSplitRow(false), " +
              "    { cost_code: 'Silt Sock', sub_code: n }); });" +
              'renderSplitRows()');
  const pending = cell(2, 'sub_code');        // the supervisor retypes row 3
  pending.value = '18inch';
  window.eval('splitDeleteRow(0)');           // and the same click hits row 1's ✕
  window._pendingInput = pending;
  window.eval('cbCommit(window._pendingInput)');
  assert('a sub code committed off a replaced cell still reaches its row',
    window.eval('splitRows[1].sub_code') === '18inch', window.eval('splitRows[1].sub_code'));
  assert('and the table is repainted to show it', domVsState() === true,
    window.eval('[...document.querySelectorAll("#splitTbody tr")].map(function (tr) {' +
                'return tr.querySelector(".cb[data-field=\\"sub_code\\"] .cb-input").value; }).join()'));

  // ── What is on screen is what gets approved ───────────────────────────
  // A typed code is not in the split until its cell commits, and that commit
  // is deferred 120ms past the blur. Clicking Approve & Inject blurs the cell
  // and runs the save in the same click, so the approval went out holding what
  // the cell held BEFORE they typed. Typing into an empty cell at least failed
  // loudly — the server rejects a row with no code. CORRECTING one did not:
  // the old code validates, so a day's hours booked to the task the supervisor
  // had just replaced, at that task's rate, with the box showing the code they
  // meant.
  window.eval("splitRows = [_blankSplitRow(false), _blankSplitRow(true)];" +
              "splitRows[0].cost_code = 'Mobilization'; splitRows[0].sub_code = 'Travel';" +
              "splitRows[0].labor_hours = 6.5; splitRows[1].labor_hours = 1.5;" +
              'renderSplitRows()');
  const correcting = cell(0, 'cost_code');
  correcting.focus();
  correcting.value = 'Silt Sock';           // typed, blurred by the button, uncommitted
  window.eval('splitFlushPendingCommits()');
  assert('a save flushes what the table is showing into the split',
    window.eval('splitRows[0].cost_code') === 'Silt Sock',
    window.eval('splitRows[0].cost_code'));
  assert('and the sub code the old cost code carried goes with it',
    window.eval('splitRows[0].sub_code') === '', window.eval('splitRows[0].sub_code'));

  // Nothing pending: the flush must not disturb a split that is already true,
  // and must not undo a clear the supervisor just made.
  window.eval("splitRows = [_blankSplitRow(false), _blankSplitRow(true)];" +
              "splitApplyTravelPrefill(); renderSplitRows()");
  const beforeFlush = window.eval('JSON.stringify(splitRows.map(function (r) {' +
                                  'return [r.cost_code, r.sub_code, r.code_source]; }))');
  window.eval('splitFlushPendingCommits()');
  assert('a flush with nothing pending changes nothing',
    window.eval('JSON.stringify(splitRows.map(function (r) {' +
                'return [r.cost_code, r.sub_code, r.code_source]; }))') === beforeFlush,
    beforeFlush);

  // The untick case again, this time through the save: the cell still shows
  // the code it was drawn with, and the flush must not put it back.
  const cleared = cell(1, 'sub_code');
  cleared.focus();
  window.eval("splitOnChange(1, 'is_travel', false)");
  window._pendingInput = cleared;
  window.eval('splitFlushPendingCommits()');
  assert('and a flush does not resurrect codes an untick just cleared',
    window.eval('splitRows[1].sub_code') === '', window.eval('splitRows[1].sub_code'));

  // The modal opens before its lookups land, and its buttons are live the whole
  // time. A supervisor who presses "+ Add labor row" while waiting had their
  // row still sitting in splitRows when the defaults arrived on top of it: a
  // form opening with three rows, one blank, and a tally that will not balance
  // until they work out which to remove. Read off the source for the same
  // reason as the flush below — openSplitModal is async and this file is not.
  const openSrc = src.slice(src.indexOf('async function openSplitModal'),
                            src.indexOf('function closeSplit()'));
  assert('the modal opens on exactly its defaults, not on top of what is there',
    openSrc.length > 0 && /splitRows = fresh;/.test(openSrc) &&
    !/splitRows\.push\(_blankSplitRow/.test(openSrc));
  assert('and a split read back from the server carries the same row shape',
    /code_source: ''/.test(openSrc));

  // The flush only helps if the save runs it. Read off the source rather than
  // driven, because splitSave is async and this file is not — what has to hold
  // is that the call is there, ahead of the body it posts.
  const saveSrc = src.slice(src.indexOf('async function splitSave()'),
                            src.indexOf('JSON.stringify({ split: splitRows })'));
  assert('and splitSave runs the flush before it posts the split',
    saveSrc.length > 0 && /splitFlushPendingCommits\(\)/.test(saveSrc),
    saveSrc.slice(0, 160));

  // ── One dropdown at a time ────────────────────────────────────────────
  // A click closes the other menus through the document handler; Tab did not,
  // and the cell being left keeps its menu open until its own deferred commit
  // fires — so two dropdowns overlapped for that 120ms.
  window.eval("splitRows = [_blankSplitRow(false), _blankSplitRow(true)]; renderSplitRows()");
  cell(0, 'cost_code').focus();
  assert('focusing a combobox opens its menu',
    doc.querySelectorAll('.cb-menu:not([hidden])').length === 1);
  cell(0, 'sub_code').focus();
  assert('and focusing the next one leaves only that one open',
    doc.querySelectorAll('.cb-menu:not([hidden])').length === 1,
    String(doc.querySelectorAll('.cb-menu:not([hidden])').length));
}

// ── The bulk card puts the cursor back too ───────────────────────────────
// Positional there rather than by id: the two repaints that change how many
// controls a card carries (+ machine, and dropping one) are both fired from
// buttons, so there is never an input focused across them.
console.log('\n[the bulk card keeps the cursor too]');
{
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="bulkGroupsWrap"></div></body>',
    { url: 'http://localhost/', runScripts: 'dangerously' });
  const { window } = dom;
  window.eval([grab('_bulkFocusSnapshot() {'), grab('_bulkFocusRestore(snap) {')].join('\n\n'));
  const doc = window.document;
  const wrap = doc.getElementById('bulkGroupsWrap');
  const paint = () => {
    wrap.innerHTML = '<div class="card"><input id="a"><input id="b"><select id="c">' +
                     '<option>work</option><option>travel</option></select></div>';
  };
  paint();
  doc.getElementById('b').focus();
  doc.getElementById('b').value = 'Silt Sock';
  doc.getElementById('b').setSelectionRange(4, 4);
  const snap = window._bulkFocusSnapshot();
  paint();                                   // the repaint replaces every control
  assert('the repaint drops the cursor on its own', doc.activeElement === doc.body);
  doc.getElementById('b').value = 'Silt Sock';
  window._bulkFocusRestore(snap);
  assert('and the restore puts it back on the same field',
    doc.activeElement === doc.getElementById('b'),
    doc.activeElement && doc.activeElement.id);
  assert('with the caret where it was', doc.activeElement.selectionStart === 4,
    String(doc.activeElement.selectionStart));

  // A <select> has no selection to read, and must not throw on the way past.
  doc.getElementById('c').focus();
  const selSnap = window._bulkFocusSnapshot();
  paint();
  window._bulkFocusRestore(selSnap);
  assert('a select is restored without throwing on its missing selection',
    doc.activeElement === doc.getElementById('c'), doc.activeElement && doc.activeElement.id);

  // Nothing focused inside the card — the repaint must not go grabbing.
  doc.activeElement.blur();
  assert('a repaint with nobody in the card takes no snapshot',
    window._bulkFocusSnapshot() === null);
  window._bulkFocusRestore(null);
  assert('and restoring nothing leaves the focus alone', doc.activeElement === doc.body);

  // A control that is gone by the time the restore runs is simply not there.
  doc.getElementById('a').focus();
  const goneSnap = window._bulkFocusSnapshot();
  wrap.innerHTML = '';
  window._bulkFocusRestore(goneSnap);
  assert('a field the repaint removed is left alone rather than mis-restored',
    doc.activeElement === doc.body);
}

// ── The lookup itself tolerates whatever the box holds ───────────────────
console.log('\n[matching a typed code against the bid items]');
{
  const f = sandbox.findCostCode;
  assert('an exact code is found',   (f(TURF, 'Mobilization') || {}).cost_code === 'Mobilization');
  assert('a padded one is too',      (f(TURF, '  Mobilization ') || {}).cost_code === 'Mobilization');
  assert('and a padded bid item as well',
    ((f([{ cost_code: ' Mobilization ', sub_codes: ['Travel'] }], 'Mobilization') || {}).sub_codes || [])
      .join() === 'Travel');
  assert('a code the job does not carry is not found', f(TURF, 'Paint') === null);
  assert('blank finds nothing rather than the first row', f(TURF, '   ') === null);
  assert('and neither a missing list nor a missing code throws',
    f(null, 'x') === null && f(TURF, null) === null);
}

// ── The form and the server must agree about what is saveable ────────────
// splitSave pre-validates so obvious problems are named before the round trip.
// Anywhere it says go and the server says no, the supervisor fills out a form,
// presses Approve, and gets a raw "split[2].equip_hours must be between 0 and
// 24" back — which is the exact experience bulkBadEquipHours was written to
// avoid on the crew-sized path, where it names the day instead.
//
// Driven, not read: the real splitSave against a stubbed fetch, and the real
// validateSplit out of api/timesheet-entries.js.
console.log('\n[the form and the server agree on what is saveable]');
{
  const { JSDOM } = require('jsdom');
  const api = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'), 'utf8');
  const grabApi = name => {
    const i = api.indexOf('function ' + name + '(');
    assert(`api/timesheet-entries.js still defines ${name}`, i >= 0);
    return i < 0 ? '' : api.slice(i, api.indexOf('\n}\n', i) + 3);
  };
  const srv = { console };
  vm.createContext(srv);
  vm.runInContext([
    'function safeStr(v,n){ if (v==null) return ""; return String(v).trim().slice(0,n); }',
    'function _r2(n){ return Math.round((Number(n)||0)*100)/100; }',
    grabApi('normalizeSplitRow'), grabApi('validateSplit'),
  ].join('\n\n'), srv);

  const NAMES = ['isTravelSplitRow', '_splitRowUid', '_blankSplitRow', 'findCostCode',
    'splitCcListNow', 'splitTravelCandidates', 'splitTravelSubsFor', 'splitPickTravelCodes',
    'splitApplyTravelPrefill', 'splitFillTravelHours', 'numInputVal', '_cbHtml',
    '_cbReadOptions', 'cbOnFocus',
    'cbOnInput', 'cbRenderMenu', 'cbPositionMenu', 'cbCloseAll', 'cbScrollHi', 'cbClose',
    'cbCommit', '_splitFocusSnapshot', '_splitFocusRestore', 'renderSplitRows',
    'splitOnChange', 'splitFlushPendingCommits'];
  const byName = n => {
    const i = src.indexOf('function ' + n + '(');
    if (i < 0) throw new Error('payroll.html no longer defines: ' + n);
    return src.slice(i, src.indexOf('\n    }\n', i) + 6);
  };
  const harness = [
    travelReSrc, (src.match(/const _cbEsc = [^\n]+/) || [])[0],
    'const _cbState = new WeakMap();', 'let _splitRowSeq = 0;',
    ...NAMES.map(byName),
    'async ' + byName('splitSave'),
    'function num2(n){return Number(n).toFixed(2);}  function renderSplitTally(){}',
    'function cbOnKey(){}  function cbOnBlur(){}',
    'function authHeaders(){return {};}  function applyEntryUpdate(){}',
    'function renderRows(){}  function renderStats(){}  function closeSplit(){}',
    'var selectedIds = new Set();',
    'var splitMode = "approve", splitRowLoad = "none";',
    "var splitEntry = { id: 1, division: 'turf', job_id: 'J1', computed_hours: 20, travel_hours: 5 };",
    "var splitCcCache = { 'turf::J1': [{ cost_code: 'Silt Sock', sub_codes: ['12inch'] }] };",
    'var splitEquipmentList = [];  var splitRows = [];',
    'window.__sent = null;',
    'window.fetch = function (url, opts) { window.__sent = JSON.parse(opts.body);',
    '  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true }); } }); };',
  ].join('\n\n');

  const dom = new JSDOM('<!doctype html><body><table class="split-table">' +
    '<tbody id="splitTbody"></tbody></table><div id="splitMsg"></div>' +
    '<button id="splitSaveBtn"></button></body>',
    { url: 'http://localhost/', runScripts: 'dangerously' });
  const { window } = dom;
  window.eval(harness);

  let seq = 0;
  const ROW = ov => Object.assign({
    _uid: 'v' + (++seq), cost_code: 'Silt Sock', sub_code: '12inch', quantity: 0,
    equipment: '', labor_hours: 0, equip_hours: 0, is_travel: false, code_source: '',
  }, ov);
  // 20 work + 5 travel, so one 25-hour row balances and the per-row cap of 24
  // is reachable without an impossible day.
  const ENTRY = { computed_hours: 20, travel_hours: 5 };
  const CASES = [
    ['a normal split',           [ROW({ labor_hours: 20 }), ROW({ labor_hours: 5, is_travel: true })]],
    ['equipment hours over 24',  [ROW({ labor_hours: 20, equip_hours: 30 }), ROW({ labor_hours: 5, is_travel: true })]],
    ['labor hours over 24',      [ROW({ labor_hours: 25 })]],
    ['a quantity over the cap',  [ROW({ labor_hours: 20, quantity: 2e9 }), ROW({ labor_hours: 5, is_travel: true })]],
    // Every row inside its own bounds and the hours adding up, so the only
    // thing wrong is the count — otherwise a row-level rule catches it first
    // and the cap is never the reason either end says no.
    ['51 rows',                  Array.from({ length: 51 }, (_, i) =>
                                   ROW(i === 0 ? { labor_hours: 20 }
                                     : i === 1 ? { labor_hours: 5, is_travel: true }
                                     : { labor_hours: 0, equip_hours: 1 }))],
    // Not reachable through the table — splitOnChange clamps a typed negative
    // to zero — but the rule should hold wherever the row came from.
    ['a negative equipment hour', [ROW({ labor_hours: 20, equip_hours: -3 }), ROW({ labor_hours: 5, is_travel: true })]],
    // The two ends round differently: the form compares to the cent, the
    // server rounds each side first. They have to land on the same verdict.
    ['a total 0.003 over',       [ROW({ labor_hours: 20.003 }), ROW({ labor_hours: 5, is_travel: true })]],
    ['a total 0.005 over',       [ROW({ labor_hours: 20.005 }), ROW({ labor_hours: 5, is_travel: true })]],
    ['a total 0.007 over',       [ROW({ labor_hours: 20.007 }), ROW({ labor_hours: 5, is_travel: true })]],
    ['a row with no code',       [ROW({ labor_hours: 25, cost_code: '', sub_code: '' })]],
    ['a row with no hours',      [ROW({ labor_hours: 25 }), ROW({ labor_hours: 0, equip_hours: 0 })]],
    ['hours that do not add up', [ROW({ labor_hours: 5 })]],
  ];

  let pending = CASES.length;
  const run = async () => {
    for (const [label, rows] of CASES) {
      window.eval('splitRows = ' + JSON.stringify(rows) + '; renderSplitRows();');
      window.__sent = null;
      window.document.getElementById('splitMsg').textContent = '';
      await window.splitSave();
      const posted = window.__sent !== null;
      const verdict = srv.validateSplit(JSON.parse(JSON.stringify(rows)), ENTRY);
      assert(`  ${label}: the form and the server agree`, posted === !verdict.error,
        `form ${posted ? 'posts' : 'refuses ("' + window.document.getElementById('splitMsg').textContent + '")'}` +
        `, server ${verdict.error ? 'rejects ("' + verdict.error + '")' : 'accepts'}`);
      pending--;
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  };
  run();
}

