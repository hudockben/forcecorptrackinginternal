#!/usr/bin/env node
'use strict';
/**
 * Bulk approve: per-day equipment overrides.
 *
 * Run: node scripts/test-bulk-equipment-overrides.js
 *
 * A bulk approve group is keyed on the job, so one card covers a whole crew and
 * the cost code is entered once. Equipment used to work the same way — one
 * field applied to every day in the group — which meant a machine only one
 * operator ran either landed on everybody or had to be done a day at a time
 * outside the bulk flow.
 *
 * The day table now carries a list of machines per row, each with its own
 * hours. Blank inherits the group's value, so "one machine for the whole crew"
 * still works; filling one in singles that person out; and a day that ran more
 * than one machine — drove the pickup in, ran the roller on site — lists both.
 *
 * Evaluates the real functions out of payroll.html in a sandbox — no server or
 * browser needed. What matters most here is the negative case: an override on
 * one row must not leak onto anybody else's day, because that is cost landing
 * on the wrong job.
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

// Pull a top-level function out of the payroll script block. Everything there
// is indented four spaces, so the closing brace is the anchor.
function grab(signature) {
  const i = src.indexOf('function ' + signature);
  if (i < 0) throw new Error(`payroll.html no longer defines: ${signature}`);
  const end = src.indexOf('\n    }\n', i);
  if (end < 0) throw new Error(`could not find the end of: ${signature}`);
  return src.slice(i, end + 6);
}

const sandbox = {
  console,
  bulkGroups: [],
  document: { getElementById: () => null },   // the hours prefill repaints one input
  entryNeedsSplit:    e => e.division === 'turf',
  entryNeedsQuarry:   () => false,
  entryNeedsTrucking: () => false,
  quarryActivityOf:   () => null,
  bulkQuarryRate:     () => 0,
  bulkR2:      n => Math.round((Number(n) || 0) * 100) / 100,
  escapeHtml:  s => String(s),
  escapeJsAttr: s => String(s),
  prettyDate:  s => s,
  prettyDiv:   s => s,
  num2:        n => Number(n).toFixed(2),
  updateBulkRunBtn: () => {},
  renderBulkGroups: () => {},   // adding/removing a machine repaints the card
};
vm.createContext(sandbox);
vm.runInContext([
  'buildBulkGroups(entries) {',
  '_blankMachine() {',
  '_bulkRowCell(g, entryId) {',
  '_bulkRowItem(g, entryId, itemIdx) {',
  'bulkRowAddMachine(idx, entryId) {',
  'bulkRowRemoveMachine(idx, entryId, itemIdx) {',
  'bulkRowEffective(g, e) {',
  'bulkRowSet(idx, entryId, itemIdx, field, value) {',
  'bulkRowEquipCommit(idx, entryId, itemIdx) {',
  'bulkRowLeg(idx, entryId, itemIdx, value) {',
  'bulkTravelCostCode(idx, value) {',
  'bulkCostCode(idx, value) {',
  // Both validators below name the offending day through this, so it has to
  // come across with them — a split day puts two rows with the same worker and
  // date in one group, and it is what tells them apart.
  'bulkDayLabel(g, e) {',
  'bulkBadEquipHours() {',
  'bulkDroppedMachines() {',
  'bulkDaysTable(g, idx) {',
  'buildBulkBody(g, e) {',
].map(grab).join('\n\n'), sandbox);

const entry = (user, day, work, travel = 0) => ({
  id: `${user}-${day}`, username: user, division: 'turf',
  job_id: 'J1', job_label: 'General Time · 2026',
  work_date: `2026-08-0${day}`, computed_hours: work, travel_hours: travel,
});

// Two people, two days each. Zach's second day carries travel.
const jamey3 = entry('jamey', 3, 8);
const jamey4 = entry('jamey', 4, 8);
const zach3  = entry('zach',  3, 10);
const zach4  = entry('zach',  4, 8, 1.5);
const crew   = [jamey3, jamey4, zach3, zach4];

const { groups } = sandbox.buildBulkGroups(crew);
assert('one job → one group for the whole crew', groups.length === 1 && groups[0].entries.length === 4);

const g = groups[0];
sandbox.bulkGroups = groups;
g.template.cost_code = 'CC1';
g.template.sub_code  = 'SC1';

// ── One machine, one operator, one day ──
console.log('\n[machine assigned to a single operator]');
sandbox.bulkRowSet(0, 'jamey-3', 0, 'equipment', '320 Excavator');
sandbox.bulkRowEquipCommit(0, 'jamey-3', 0);
assert("hours prefill from that day's work hours", g.perRow['jamey-3'].items[0].equip_hours === '8');

const bJ3 = sandbox.buildBulkBody(g, jamey3);
const bJ4 = sandbox.buildBulkBody(g, jamey4);
const bZ3 = sandbox.buildBulkBody(g, zach3);
assert('the operator gets the machine and its hours',
  bJ3.split[0].equipment === '320 Excavator' && bJ3.split[0].equip_hours === 8);
assert("the same operator's other day stays clean",
  bJ4.split[0].equipment === '' && bJ4.split[0].equip_hours === 0);
assert('nobody else in the crew is touched',
  bZ3.split[0].equipment === '' && bZ3.split[0].equip_hours === 0);
assert('cost + sub code are still shared by everyone',
  bZ3.split[0].cost_code === 'CC1' && bZ3.split[0].sub_code === 'SC1');

// ── Crew-wide machine with one person overridden ──
console.log('\n[crew-wide machine, one override]');
g.template.equipment   = 'Skid Steer';
g.template.equip_hours = '6';
assert('a blank row inherits the crew machine', sandbox.buildBulkBody(g, zach3).split[0].equipment === 'Skid Steer');
assert('a blank row inherits the crew hours',   sandbox.buildBulkBody(g, zach3).split[0].equip_hours === 6);
assert('an overridden row keeps its own machine', sandbox.buildBulkBody(g, jamey3).split[0].equipment === '320 Excavator');
assert('an overridden row keeps its own hours',   sandbox.buildBulkBody(g, jamey3).split[0].equip_hours === 8);
sandbox.bulkRowSet(0, 'jamey-4', 0, 'equip_hours', '0');
assert('an explicit 0 on a row beats the crew value',
  sandbox.buildBulkBody(g, jamey4).split[0].equip_hours === 0);

// ── Travel, and the hours total the server checks ──
console.log('\n[travel and hour totals]');
const bZ4 = sandbox.buildBulkBody(g, zach4);
assert('the travel row never carries the machine',
  bZ4.split[1].is_travel === true && bZ4.split[1].equipment === '');
assert('the travel row has no equipment hours', bZ4.split[1].equip_hours === 0);
assert('labor hours still sum to work + travel',
  bZ4.split.reduce((s, r) => s + r.labor_hours, 0) === 9.5);

// A travel-only day has no work row; the assignment gets its own row rather
// than being silently dropped.
{
  const travelOnly = entry('pat', 5, 0, 2);
  const { groups: g2 } = sandbox.buildBulkGroups([travelOnly]);
  const gt = g2[0];
  gt.template.cost_code = 'CC1';
  gt.perRow[String(travelOnly.id)] = { items: [{ equipment: 'Roller', equip_hours: '3' }] };
  const body = sandbox.buildBulkBody(gt, travelOnly);
  assert('a travel-only day still records its machine',
    body.split.some(r => r.equipment === 'Roller' && r.equip_hours === 3 && r.labor_hours === 0));
  assert('and its labor total is still just the travel',
    body.split.reduce((s, r) => s + r.labor_hours, 0) === 2);
}

// ── Changing your mind ──
// The auto-filled hours belong to the machine that triggered them. Clearing the
// machine while the crew has one of its own would otherwise leave the row
// inheriting the crew machine with hours nobody typed — cost on a job for a day
// that machine never worked.
console.log('\n[clearing an override]');
{
  const solo = entry('pat', 6, 8);
  const { groups: g3 } = sandbox.buildBulkGroups([solo]);
  const gc = g3[0];
  sandbox.bulkGroups = g3;
  gc.template.cost_code = 'CC1';
  gc.template.equipment = 'Skid Steer';      // crew machine, no crew hours
  sandbox.bulkRowSet(0, solo.id, 0, 'equipment', '320 Excavator');
  sandbox.bulkRowEquipCommit(0, solo.id, 0);
  assert('picking a machine fills the hours', gc.perRow[solo.id].items[0].equip_hours === '8');
  sandbox.bulkRowSet(0, solo.id, 0, 'equipment', '');
  assert('clearing the machine clears the hours it filled', gc.perRow[solo.id].items[0].equip_hours === '');
  const back = sandbox.buildBulkBody(gc, solo);
  assert('the row falls back to the crew machine with no hours',
    back.split[0].equipment === 'Skid Steer' && back.split[0].equip_hours === 0);

  // Hours typed by hand are the supervisor's and must survive the same edit.
  sandbox.bulkRowSet(0, solo.id, 0, 'equipment', 'Roller');
  sandbox.bulkRowSet(0, solo.id, 0, 'equip_hours', '3');
  sandbox.bulkRowSet(0, solo.id, 0, 'equipment', '');
  assert('hand-typed hours are not cleared', gc.perRow[solo.id].items[0].equip_hours === '3');
}
sandbox.bulkGroups = groups;

// ── Guard rails ──
console.log('\n[guard rails]');
assert('a group with no overrides at all does not throw',
  sandbox.bulkRowEffective({ template: {}, entries: [] }, jamey3).length === 0);
g.template.equipment   = '';
g.template.equip_hours = '';
sandbox.bulkRowSet(0, 'zach-3', 0, 'equip_hours', '30');
assert('hours over 24 are caught before the run starts', sandbox.bulkBadEquipHours().length === 1);
sandbox.bulkRowSet(0, 'zach-3', 0, 'equip_hours', '-2');
assert('negative hours are caught too',                  sandbox.bulkBadEquipHours().length === 1);
sandbox.bulkRowSet(0, 'zach-3', 0, 'equip_hours', '');
assert('blank hours are not an error',                   sandbox.bulkBadEquipHours().length === 0);
sandbox.bulkRowSet(0, 'zach-3', 0, 'equip_hours', '8');
assert('hours with no machine resolve to nothing',
  sandbox.buildBulkBody(g, zach3).split[0].equipment === '' &&
  sandbox.buildBulkBody(g, zach3).split[0].equip_hours === 0);

// ── More than one machine in a day ──
// The reported case: drove the pickup to the job, ran the 224 roller on site.
// Both belong to that operator on that day, and neither belongs to the crew.
console.log('\n[two machines in one day]');
{
  const day = entry('cipollini', 9, 9.5, 2);   // 9.5 work + 2.0 travel
  const { groups: g4 } = sandbox.buildBulkGroups([day]);
  const gm = g4[0];
  sandbox.bulkGroups = g4;
  gm.template.cost_code = 'Paving';
  gm.template.sub_code  = 'Base';

  sandbox.bulkRowSet(0, day.id, 0, 'equipment', '224 Roller');
  sandbox.bulkRowEquipCommit(0, day.id, 0);
  assert("the first machine's hours prefill from the day", gm.perRow[day.id].items[0].equip_hours === '9.5');
  sandbox.bulkRowSet(0, day.id, 0, 'equip_hours', '7.5');

  sandbox.bulkRowAddMachine(0, day.id);
  sandbox.bulkRowSet(0, day.id, 1, 'equipment', 'Pickup Truck');
  sandbox.bulkRowEquipCommit(0, day.id, 1);
  assert('the second machine is NOT given the whole day',  gm.perRow[day.id].items[1].equip_hours === '');
  sandbox.bulkRowSet(0, day.id, 1, 'equip_hours', '2');

  const body = sandbox.buildBulkBody(gm, day);
  const labor  = body.split.find(r => r.labor_hours === 9.5);
  const travel = body.split.find(r => r.is_travel);
  const extra  = body.split.find(r => r.labor_hours === 0 && r.equipment === 'Pickup Truck');
  assert('the first machine rides on the labor row',
    !!labor && labor.equipment === '224 Roller' && labor.equip_hours === 7.5);
  assert('the second machine gets a row of its own',  !!extra && extra.equip_hours === 2);
  assert('the travel row still carries no machine',   !!travel && travel.equipment === '');
  assert('the labor total is untouched by either',
    body.split.reduce((s, r) => s + r.labor_hours, 0) === 11.5);
  assert('both machines post to the same cost code',
    labor.cost_code === 'Paving' && extra.cost_code === 'Paving' && extra.sub_code === 'Base');

  // Removing one must leave the other exactly as it was.
  sandbox.bulkRowRemoveMachine(0, day.id, 0);
  const after = sandbox.buildBulkBody(gm, day);
  assert('removing a machine leaves the other alone',
    after.split[0].equipment === 'Pickup Truck' && after.split[0].equip_hours === 2);
  assert('and the labor total still holds',
    after.split.reduce((s, r) => s + r.labor_hours, 0) === 11.5);

  // Out-of-range hours on ANY machine in the day must be caught.
  sandbox.bulkRowSet(0, day.id, 0, 'equip_hours', '30');
  assert('bad hours on any machine are caught', sandbox.bulkBadEquipHours().length === 1);
  sandbox.bulkRowSet(0, day.id, 0, 'equip_hours', '2');
}

// ── Which leg of the day a machine ran in ──
// A pickup driven to site and back belongs to the travel hours, not the work
// hours. Marking it travel puts it on the travel row and takes its hours from
// the drive, so the day posts two rows rather than three.
console.log('\n[work leg vs travel leg]');
{
  const day = entry('cipollini', 9, 9.5, 2);
  const { groups: g5 } = sandbox.buildBulkGroups([day]);
  const gl = g5[0];
  sandbox.bulkGroups = g5;
  gl.template.cost_code = 'Paving';

  sandbox.bulkRowSet(0, day.id, 0, 'equipment', '224 Roller');
  sandbox.bulkRowEquipCommit(0, day.id, 0);
  sandbox.bulkRowSet(0, day.id, 0, 'equip_hours', '7.5');
  sandbox.bulkRowAddMachine(0, day.id);
  sandbox.bulkRowSet(0, day.id, 1, 'equipment', 'Pickup Truck');
  sandbox.bulkRowLeg(0, day.id, 1, 'travel');
  assert('a travel machine takes its hours from the drive',
    gl.perRow[day.id].items[1].equip_hours === '2');

  const body = sandbox.buildBulkBody(gl, day);
  const workRow   = body.split.find(r => !r.is_travel);
  const travelRow = body.split.find(r => r.is_travel);
  assert('the day posts two rows, not three',        body.split.length === 2);
  assert('the roller stays on the work row',         workRow.equipment === '224 Roller' && workRow.equip_hours === 7.5);
  assert('the truck rides on the travel row',        travelRow.equipment === 'Pickup Truck' && travelRow.equip_hours === 2);
  assert('the travel row keeps its own labor hours', travelRow.labor_hours === 2);
  assert('the labor total is still work + travel',
    body.split.reduce((s, r) => s + r.labor_hours, 0) === 11.5);

  // Switching back re-guesses from the work leg rather than keeping the drive's.
  sandbox.bulkRowSet(0, day.id, 1, 'equip_hours', '');
  sandbox.bulkRowLeg(0, day.id, 1, 'work');
  assert('switching back to work re-guesses from the work hours',
    gl.perRow[day.id].items[1].equip_hours === '' || gl.perRow[day.id].items[1].equip_hours === '9.5');
}
sandbox.bulkGroups = groups;

// ── A half-filled slot must not summon the crew's machine ──
// Hours typed into a slot before the machine is picked is an EMPTY slot. Reading
// it as "the crew's machine, for these hours" put a shared machine onto a day
// that had already named its own — cost for equipment that was never there.
console.log('\n[half-filled slot]');
{
  const day = entry('dana', 8, 8);
  const { groups: g6 } = sandbox.buildBulkGroups([day]);
  const gh = g6[0];
  sandbox.bulkGroups = g6;
  gh.template.cost_code = 'CC1';
  gh.template.equipment = 'Skid Steer';
  gh.template.equip_hours = '6';

  sandbox.bulkRowSet(0, day.id, 0, 'equipment', '224 Roller');
  sandbox.bulkRowSet(0, day.id, 0, 'equip_hours', '7.5');
  sandbox.bulkRowAddMachine(0, day.id);
  sandbox.bulkRowSet(0, day.id, 1, 'equip_hours', '2');   // hours, no machine yet

  const machines = sandbox.bulkRowEffective(gh, day);
  assert('only the machine this day named resolves',
    machines.length === 1 && machines[0].equipment === '224 Roller');
  assert("the crew's machine is not billed to this day",
    !sandbox.buildBulkBody(gh, day).split.some(r => r.equipment === 'Skid Steer'));

  // With nothing named, the crew's machine still applies at the day's hours.
  gh.perRow[day.id] = { items: [{ equipment: '', equip_hours: '3' }] };
  const inherited = sandbox.bulkRowEffective(gh, day);
  assert('a day naming nothing still inherits the crew machine',
    inherited.length === 1 && inherited[0].equipment === 'Skid Steer' && inherited[0].equip_hours === 3);
}
sandbox.bulkGroups = groups;
sandbox.bulkGroups = groups;

// ── A machine with no hours must not vanish ──
// Only the first machine on a leg can be a bare tag: it rides that leg's labor
// row. Anything after it needs hours, because the server rejects a row with
// neither labor nor equipment hours — so without a check it was typed into the
// table and then silently never recorded.
console.log('\n[machines that would be dropped]');
{
  const day = entry('cip', 9, 9.5);          // no travel hours
  const { groups: g7 } = sandbox.buildBulkGroups([day]);
  const gd = g7[0];
  sandbox.bulkGroups = g7;
  gd.template.cost_code = 'CC1';

  sandbox.bulkRowSet(0, day.id, 0, 'equipment', '224 Roller');
  sandbox.bulkRowSet(0, day.id, 0, 'equip_hours', '7.5');
  sandbox.bulkRowAddMachine(0, day.id);
  sandbox.bulkRowSet(0, day.id, 1, 'equipment', 'Pickup Truck');   // hours left blank

  const dropped = sandbox.bulkDroppedMachines();
  assert('a second machine with no hours is caught before the run',
    dropped.length === 1 && dropped[0].equipment === 'Pickup Truck');
  assert('and the message names the day',  /cip/.test(dropped[0].who));

  sandbox.bulkRowSet(0, day.id, 1, 'equip_hours', '2');
  assert('giving it hours clears the block', sandbox.bulkDroppedMachines().length === 0);
  assert('and it then actually posts',
    sandbox.buildBulkBody(gd, day).split.some(r => r.equipment === 'Pickup Truck' && r.equip_hours === 2));

  // The FIRST machine on a leg is allowed to be a tag with no cost — it rides
  // the labor row, so nothing is lost.
  sandbox.bulkRowRemoveMachine(0, day.id, 1);
  sandbox.bulkRowSet(0, day.id, 0, 'equip_hours', '');
  assert('a lone machine with no hours is still allowed as a tag',
    sandbox.bulkDroppedMachines().length === 0);
  assert('and it still reaches the labor row',
    sandbox.buildBulkBody(gd, day).split[0].equipment === '224 Roller');
}
sandbox.bulkGroups = groups;

// ── A second cost/sub code for the travel leg ──
// The drive is its own task — Mobilization / Travel — while the work books to
// the job's code. The single-day modal has always allowed that; bulk forced
// both legs onto one code, which is the whole reason a crew day had to be
// approved one person at a time.
console.log('\n[travel books to its own code]');
{
  const day = u => entry(u, 3, 7.5, 2);
  const gang = ['forcecaden', 'shuffstallmatt', 'cipollini'].map(day);
  const { groups: g8 } = sandbox.buildBulkGroups(gang);
  const gt = g8[0];
  sandbox.bulkGroups = g8;
  gt.template.cost_code        = 'Silt Sock';
  gt.template.sub_code         = 'Silt Sock 12inch';
  gt.template.travel_cost_code = 'Mobilization';
  gt.template.travel_sub_code  = 'Travel';

  const bodies = gang.map(e => sandbox.buildBulkBody(gt, e));
  assert('every day in the crew gets both rows', bodies.every(b => b.split.length === 2));
  assert('work books to the task for all of them',
    bodies.every(b => b.split[0].cost_code === 'Silt Sock' && b.split[0].sub_code === 'Silt Sock 12inch'));
  assert('travel books to its own code for all of them',
    bodies.every(b => b.split[1].is_travel && b.split[1].cost_code === 'Mobilization' && b.split[1].sub_code === 'Travel'));
  assert('the hours check is untouched',
    bodies.every(b => b.split.reduce((s, r) => s + r.labor_hours, 0) === 9.5));

  // Blank has to keep meaning what it meant before the fields existed.
  gt.template.travel_cost_code = '';
  gt.template.travel_sub_code  = '';
  const back = sandbox.buildBulkBody(gt, gang[0]);
  assert('blank travel codes fall back to the work codes',
    back.split[1].cost_code === 'Silt Sock' && back.split[1].sub_code === 'Silt Sock 12inch');

  // Only one of the two set is still a valid thing to ask for.
  gt.template.travel_cost_code = 'Mobilization';
  const half = sandbox.buildBulkBody(gt, gang[0]);
  assert('a travel cost code alone keeps the work sub code',
    half.split[1].cost_code === 'Mobilization' && half.split[1].sub_code === 'Silt Sock 12inch');

  // A machine on the travel leg belongs to the travel task, not the work one.
  gt.template.travel_sub_code = 'Travel';
  sandbox.bulkRowSet(0, gang[0].id, 0, 'equipment', '224 Roller');
  sandbox.bulkRowSet(0, gang[0].id, 0, 'equip_hours', '7.5');
  sandbox.bulkRowAddMachine(0, gang[0].id);
  sandbox.bulkRowSet(0, gang[0].id, 1, 'equipment', 'Pickup Truck');
  sandbox.bulkRowLeg(0, gang[0].id, 1, 'travel');
  const withRig = sandbox.buildBulkBody(gt, gang[0]);
  const truck = withRig.split.find(r => r.equipment === 'Pickup Truck');
  assert('the truck rides the travel row at the travel code',
    truck.is_travel && truck.cost_code === 'Mobilization' && truck.sub_code === 'Travel');
  assert('the roller stays on the work row at the work code',
    withRig.split.some(r => r.equipment === '224 Roller' && !r.is_travel && r.cost_code === 'Silt Sock'));
}
sandbox.bulkGroups = groups;

// ── A cost-code change must not orphan the travel sub code ──
// While the travel leg has no cost code of its own it borrows the work one, so
// its sub code came from a list that changes when the work cost code changes.
// Leaving it put paired a sub code from the old cost code with the new one.
console.log('\n[stale travel sub code]');
{
  const day = entry('sam', 3, 7.5, 2);
  const { groups: g9 } = sandbox.buildBulkGroups([day]);
  const gs = g9[0];
  sandbox.bulkGroups = g9;

  sandbox.bulkCostCode(0, 'Silt Sock');
  gs.template.sub_code        = 'Silt Sock 12inch';
  gs.template.travel_sub_code = 'Silt Sock 12inch';   // picked off the inherited list
  sandbox.bulkCostCode(0, 'Mobilization');
  assert('the work sub code is cleared',            gs.template.sub_code === '');
  assert('an inherited travel sub code is cleared', gs.template.travel_sub_code === '');

  // A travel leg with its own cost code is independent and must survive.
  sandbox.bulkTravelCostCode(0, 'Mobilization');
  gs.template.travel_sub_code = 'Travel';
  sandbox.bulkCostCode(0, 'Silt Sock');
  assert('a travel leg with its own code keeps its sub code',
    gs.template.travel_sub_code === 'Travel' && gs.template.travel_cost_code === 'Mobilization');
  assert('and it still books there',
    sandbox.buildBulkBody(gs, day).split[1].sub_code === 'Travel');

  // Picking a travel cost code clears its own sub code, same as the work pair.
  sandbox.bulkTravelCostCode(0, 'Load Out');
  assert('changing the travel cost code clears its sub code', gs.template.travel_sub_code === '');
}
sandbox.bulkGroups = groups;

// ── The single-day split tally reconciles travel, not just the total ──
// The Travel tick only flags a row; it does not move it to a travel cost code.
// So ticking it on the wrong row books those hours to the wrong task — and the
// old tally, which only checked the total, called that "✓ balanced".
console.log('\n[split tally: travel reconciliation]');
{
  // The tally asks isTravelSplitRow which rows are the drive, so it has to come
  // across too. Without it every assertion below died on a ReferenceError
  // before reaching its check — the whole travel-reconciliation section had
  // been passing vacuously since the tally started consulting it.
  const travelRe = src.match(/const TRAVEL_CODE_RE = [^\n]+/);
  if (!travelRe) throw new Error('payroll.html no longer defines TRAVEL_CODE_RE');
  const tallyFn = [travelRe[0], grab('isTravelSplitRow(r) {'), grab('renderSplitTally() {')].join('\n\n');
  function tally(rows, entry) {
    const store = {};
    const stub = () => ({ textContent: '', style: {}, classList: { add() {}, remove() {} } });
    const sb = { console, splitRows: rows, splitEntry: entry,
                 document: { getElementById: id => (store[id] = store[id] || stub()) } };
    vm.createContext(sb);
    vm.runInContext(tallyFn, sb);
    sb.renderSplitTally();
    return store;
  }
  const E = { computed_hours: 7.5, travel_hours: 2 };
  const drive = ov => Object.assign({ cost_code: 'Mobilization', sub_code: 'Travel', labor_hours: 2 }, ov);
  const work  = ov => Object.assign({ cost_code: 'Silt Sock', sub_code: '12inch', labor_hours: 7.5 }, ov);

  const wrong = tally([drive({ is_travel: false }), work({ is_travel: true })], E);
  assert('ticking Travel on the work row is no longer "balanced"',
    !/balanced/.test(wrong.splitTallyStatus.textContent));
  // 9.50, not 7.50: the drive is booked to a "Travel" sub code, so it counts as
  // travel alongside the mis-ticked work row — the same rule the server prices
  // the rows by. The message says "booked as", because only 7.50 is ticked.
  assert('and the message says which way it is off',
    /9\.50 h booked as Travel, entry says 2\.00/.test(wrong.splitTallyStatus.textContent),
    wrong.splitTallyStatus.textContent);

  const right = tally([drive({ is_travel: true }), work({ is_travel: false })], E);
  assert('ticking it on the drive row balances', /balanced/.test(right.splitTallyStatus.textContent));

  const none = tally([work({ labor_hours: 9.5, is_travel: false })], E);
  assert('an entry with travel and nothing ticked is flagged',
    /2\.00 h of travel on this entry, 0\.00 booked as Travel/.test(none.splitTallyStatus.textContent),
    none.splitTallyStatus.textContent);

  const short = tally([work({ labor_hours: 5, is_travel: false })], E);
  assert('an hours mismatch still wins over the travel message',
    short.splitTallyStatus.textContent === 'under-allocated');

  const noTravel = tally([{ cost_code: 'A', sub_code: 'B', labor_hours: 8, is_travel: false }],
                         { computed_hours: 8, travel_hours: 0 });
  assert('a day with no travel hides the readout and balances',
    noTravel.splitTravelTally.style.display === 'none' &&
    /balanced/.test(noTravel.splitTallyStatus.textContent));
}

// ── The cell's layout ──
// Everything in a machine row is a flex item. width:100% on one makes its basis
// the whole cell, which shoves the later controls past the edge and puts a
// horizontal scrollbar under the table — the controls then cannot shrink back
// because of their min-width floors.
console.log('\n[machine cell layout]');
{
  // Anchored to the first selector, not the comment above it: the block
  // explains the width:100% hazard in prose, and a grep that included the prose
  // would match its own documentation and fail on correct CSS.
  const css = src.slice(src.indexOf('.bulk-days td.edit {'),
                        src.indexOf('.bulk-days td.edit input::placeholder'))
                 .replace(/\/\*[\s\S]*?\*\//g, '');
  assert('no flex item in a machine row is width:100%', !/width:\s*100%/.test(css));
  assert('the inputs can shrink (min-width:0)',          /min-width:\s*0/.test(css));
  assert('only the name flexes, on a small basis',       /input\.eq-name\s*\{\s*flex:\s*1 1 \d+px/.test(css));
  assert('the leg picker is fixed and narrow',           /select\.eq-leg\s*\{[\s\S]{0,40}flex:\s*0 0 6\dpx/.test(css));
  assert('the hours box is fixed and narrow',            /input\.eq-hrs\s*\{\s*flex:\s*0 0 4\dpx/.test(css));
  // th:last-child would also hit the read-only quarry/trucking day tables.
  assert('the width hint is scoped to the editable cell', !/th:last-child/.test(css));
}

// ── The rendered table ──
console.log('\n[day table]');
const html = sandbox.bulkDaysTable(g, 0);
assert('split groups gain an equipment column', /<th>Equipment &amp; hours<\/th>/.test(html));
assert('every machine input shares the one group datalist',
  (html.match(/list="blk_equipment_0"/g) || []).length >= 4);
assert('each day offers another machine slot',
  (html.match(/\+ machine/g) || []).length === 4);
assert('a stored override renders back into its cell',  /value="320 Excavator"/.test(html));
assert('a repaint keeps the override in state',         g.perRow['jamey-3'].items[0].equipment === '320 Excavator');
const readOnly = sandbox.bulkDaysTable({ ...g, type: 'quarry', perRow: {} }, 0);
assert('non-split groups stay read-only',
  !/<th>Equipment/.test(readOnly) && !/<input/.test(readOnly));

// ── payroll.html and the server must call the same rows Travel ─────────────
// isTravelSplitRow exists twice: here, deciding what the tally counts, and in
// api/timesheet-entries.js, deciding what rate the row is paid at. They were
// split apart yesterday and nothing held them together — and the whole point
// of the second copy is that a row cannot be counted as travel in one place
// and priced as work in the other. Compared by behaviour, not by text, so a
// rewrite that keeps the rule is fine and one that changes it is not.
console.log('\n[the two isTravelSplitRow implementations agree]');
{
  const apiSrc = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'), 'utf8');

  function lift(text, label) {
    const re = text.match(/const TRAVEL_CODE_RE = [^\n]+/);
    const i  = text.indexOf('function isTravelSplitRow');
    assert(`${label} still defines TRAVEL_CODE_RE and isTravelSplitRow`, !!re && i >= 0);
    if (!re || i < 0) return null;
    // Both copies close at their own indent; take to the first line that is
    // just a closing brace.
    const end = text.indexOf('\n}', i) >= 0 && text.indexOf('\n}', i) < text.indexOf('\n    }', i)
      ? text.indexOf('\n}', i) + 2
      : text.indexOf('\n    }', i) + 6;
    const sb = { console };
    vm.createContext(sb);
    vm.runInContext(`${re[0]}\n${text.slice(i, end)}`, sb);
    return sb.isTravelSplitRow;
  }

  const mine   = lift(src, 'payroll.html');
  const server = lift(apiSrc, 'api/timesheet-entries.js');
  if (mine && server) {
    const cases = [
      ['ticked outright',            { is_travel: true,  cost_code: 'Silt Sock', sub_code: '12inch' }],
      ['untouched work row',         { is_travel: false, cost_code: 'Silt Sock', sub_code: '12inch' }],
      ['paving travel sub code',     { is_travel: false, cost_code: '19mm',      sub_code: '19mm - Travel' }],
      ['travel in the cost code',    { is_travel: false, cost_code: 'Travel Time', sub_code: '' }],
      ['gravel is not travel',       { is_travel: false, cost_code: '2A Gravel', sub_code: 'Gravel Base' }],
      ['a Form Traveler is not one', { is_travel: false, cost_code: 'Form Traveler', sub_code: '' }],
      ['nothing at all',             {}],
      ['no row',                     null],
    ];
    for (const [label, row] of cases) {
      assert(`  ${label}: both say ${mine(row) ? 'travel' : 'work'}`,
        mine(row) === server(row), `payroll ${mine(row)} vs server ${server(row)}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
