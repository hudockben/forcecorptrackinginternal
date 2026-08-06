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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
