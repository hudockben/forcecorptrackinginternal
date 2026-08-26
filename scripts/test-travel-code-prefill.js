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
// Every selector splitOnChange reaches for after a repaint, so the focus
// restore can be asserted without a browser.
let refocused = [];
const sandbox = {
  console,
  splitEntry: null,
  splitRows: [],
  splitCcCache: {},
  renderSplitRows:  () => { repaints++; },
  renderSplitTally: () => {},
  document: { querySelector: sel => { refocused.push(sel); return { focus() {} }; } },
};
vm.createContext(sandbox);
vm.runInContext([
  travelReSrc,
  ...[
    'isTravelSplitRow(r) {',
    '_blankSplitRow(isTravel) {',
    'splitCcListNow() {',
    'splitTravelCandidates(ccList) {',
    'splitTravelSubsFor(ccList, costCode) {',
    'splitPickTravelCodes(ccList, workCostCode) {',
    'splitApplyTravelPrefill() {',
    'splitAddRow(isTravel) {',
    'splitOnChange(idx, field, value) {',
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

  refocused = [];
  sandbox.splitOnChange(1, 'is_travel', true);
  assert('ticking Travel on a blank row codes it',
    sandbox.splitRows[1].cost_code === 'Mobilization' && sandbox.splitRows[1].sub_code === 'Travel',
    JSON.stringify(sandbox.splitRows[1]));
  // The repaint that shows those codes destroys the tick the supervisor is
  // standing on. Without putting the cursor back, focus lands on the body and
  // the next Tab restarts from the top of the page.
  assert('and puts the cursor back on the tick it just replaced',
    refocused.length === 1 &&
    refocused[0] === '#splitTbody tr:nth-child(2) .travel-cell input',
    JSON.stringify(refocused));

  refocused = [];
  sandbox.splitOnChange(1, 'is_travel', false);
  assert('unticking puts the cursor back too',
    refocused.length === 1 && /nth-child\(2\)/.test(refocused[0]), JSON.stringify(refocused));
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
  repaints = 0; refocused = [];
  sandbox.splitOnChange(0, 'cost_code', 'Silt Sock');    // blur, nothing picked
  assert('re-committing the same cost code keeps the sub code',
    sandbox.splitRows[0].sub_code === '18inch', JSON.stringify(sandbox.splitRows[0]));
  assert('and does not repaint the table out from under the cursor', repaints === 0);
  assert('and does not go grabbing the focus either', refocused.length === 0);

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
    document: { getElementById: id => (store[id] = store[id] || { innerHTML: '' }) },
  };
  vm.createContext(render);
  vm.runInContext([
    cbEscSrc,
    ...[
      'numInputVal(n) {',
      'splitCcListNow() {',
      '_cbHtml(rowIdx, field, currentValue, options, placeholder, opts) {',
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
  const bulk = {
    console,
    bulkGroups: [],
    bulkR2: n => Math.round((Number(n) || 0) * 100) / 100,
    renderBulkGroups: () => {},
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
