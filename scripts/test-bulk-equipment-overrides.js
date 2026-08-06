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
 * The day table now carries an Equipment + Equip h cell per row. Blank inherits
 * the group's value, so "one machine for the whole crew" still works; filling
 * one in singles that person out.
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
};
vm.createContext(sandbox);
vm.runInContext([
  'buildBulkGroups(entries) {',
  '_bulkRowCell(g, entryId) {',
  'bulkRowEffective(g, e) {',
  'bulkRowSet(idx, entryId, field, value) {',
  'bulkRowEquipCommit(idx, entryId) {',
  'bulkBadEquipHours() {',
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
sandbox.bulkRowSet(0, 'jamey-3', 'equipment', '320 Excavator');
sandbox.bulkRowEquipCommit(0, 'jamey-3');
assert("hours prefill from that day's work hours", g.perRow['jamey-3'].equip_hours === '8');

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
sandbox.bulkRowSet(0, 'jamey-4', 'equip_hours', '0');
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
  gt.perRow[String(travelOnly.id)] = { equipment: 'Roller', equip_hours: '3' };
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
  sandbox.bulkRowSet(0, solo.id, 'equipment', '320 Excavator');
  sandbox.bulkRowEquipCommit(0, solo.id);
  assert('picking a machine fills the hours', gc.perRow[solo.id].equip_hours === '8');
  sandbox.bulkRowSet(0, solo.id, 'equipment', '');
  assert('clearing the machine clears the hours it filled', gc.perRow[solo.id].equip_hours === '');
  const back = sandbox.buildBulkBody(gc, solo);
  assert('the row falls back to the crew machine with no hours',
    back.split[0].equipment === 'Skid Steer' && back.split[0].equip_hours === 0);

  // Hours typed by hand are the supervisor's and must survive the same edit.
  sandbox.bulkRowSet(0, solo.id, 'equipment', 'Roller');
  sandbox.bulkRowSet(0, solo.id, 'equip_hours', '3');
  sandbox.bulkRowSet(0, solo.id, 'equipment', '');
  assert('hand-typed hours are not cleared', gc.perRow[solo.id].equip_hours === '3');
}
sandbox.bulkGroups = groups;

// ── Guard rails ──
console.log('\n[guard rails]');
assert('a group with no overrides at all does not throw',
  sandbox.bulkRowEffective({ template: {}, entries: [] }, jamey3).equipment === '');
g.template.equipment   = '';
g.template.equip_hours = '';
sandbox.bulkRowSet(0, 'zach-3', 'equip_hours', '30');
assert('hours over 24 are caught before the run starts', sandbox.bulkBadEquipHours().length === 1);
sandbox.bulkRowSet(0, 'zach-3', 'equip_hours', '-2');
assert('negative hours are caught too',                  sandbox.bulkBadEquipHours().length === 1);
sandbox.bulkRowSet(0, 'zach-3', 'equip_hours', '');
assert('blank hours are not an error',                   sandbox.bulkBadEquipHours().length === 0);
sandbox.bulkRowSet(0, 'zach-3', 'equip_hours', '8');
assert('hours with no machine resolve to nothing',
  sandbox.buildBulkBody(g, zach3).split[0].equipment === '' &&
  sandbox.buildBulkBody(g, zach3).split[0].equip_hours === 0);

// ── The rendered table ──
console.log('\n[day table]');
const html = sandbox.bulkDaysTable(g, 0);
assert('split groups gain Equipment + Equip h columns', /<th>Equipment<\/th><th>Equip h<\/th>/.test(html));
assert('every row shares the one group datalist',
  (html.match(/list="blk_equipment_0"/g) || []).length === 4);
assert('a stored override renders back into its cell',  /value="320 Excavator"/.test(html));
assert('a repaint keeps the override in state',         g.perRow['jamey-3'].equipment === '320 Excavator');
const readOnly = sandbox.bulkDaysTable({ ...g, type: 'quarry', perRow: {} }, 0);
assert('non-split groups stay read-only',
  !/<th>Equipment<\/th>/.test(readOnly) && !/<input/.test(readOnly));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
