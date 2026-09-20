#!/usr/bin/env node
'use strict';
/**
 * Planning the lunch-break backfill.
 *
 * Run: node scripts/test-lunch-backfill.js
 *
 * The backfill rewrites historical payroll. It gets one chance to be right, and
 * there is no database here to rehearse it against, so the decisions are made
 * by a pure module (scripts/lib/lunch-backfill.js) and tested in full before
 * anything is pointed at live data.
 *
 * What this pins:
 *   1. The planner's rule is the SAME rule the timesheet form applies, checked
 *      against timesheet.html's own function over hundreds of generated days.
 *      Two implementations of "which job" is two places for a man's hours to
 *      disagree, and a backfill that used a drifted copy would write that
 *      disagreement into the record.
 *   2. A planned move NEVER changes what a day pays. It reallocates. Any plan
 *      that would move the total is refused and reported instead.
 *   3. Days that are not a clean reallocation — two breaks already deducted,
 *      or stored hours that do not match their own punches — are separated out
 *      and never applied by default, because fixing them changes pay.
 *   4. A split day is rewritten whole or not at all. Half a day moving is how
 *      a day ends up carrying two breaks or none.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const B = require(path.resolve(__dirname, 'lib/lunch-backfill.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── Row helper: a stored entry, consistent with its own punches ────────────
let nextId = 1;
function row(start, end, opts = {}) {
  const gross = B.grossHours({ start_time: start, end_time: end });
  const lunch = opts.lunch === true;
  return {
    id: opts.id || `e${nextId++}`,
    entry_type: 'daily',
    status: opts.status || 'submitted',
    split_group_id: opts.group || null,
    split_index: opts.index || null,
    split_count: opts.count || null,
    start_time: start, end_time: end,
    lunch_break: opts.lunch === undefined ? false : opts.lunch,
    computed_hours: opts.hours != null ? opts.hours
      : (lunch ? Math.round((gross - 0.5) * 100) / 100 : gross),
  };
}
function day(windows, holderIdx, opts = {}) {
  const g = opts.group || `g${nextId++}`;
  return windows.map((w, i) => row(w[0], w[1], {
    group: g, index: i + 1, count: windows.length,
    lunch: i === holderIdx, status: opts.status, hours: (opts.hours || {})[i],
  }));
}

// ── 1. The planner's rule IS the form's rule ───────────────────────────────
console.log('\nThe backfill picks the same job the form would');

const SHEET = fs.readFileSync(path.resolve(__dirname, '..', 'timesheet.html'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(
  'const LUNCH_WINDOW_MIN = [11 * 60, 14 * 60];\nconst LUNCH_MINUTES = 30;\n'
  + requireFn(SHEET, 'spanMinutes',    'timesheet.html') + '\n'
  + requireFn(SHEET, 'startMinutes',   'timesheet.html') + '\n'
  + requireFn(SHEET, 'middayOverlap',  'timesheet.html') + '\n'
  + requireFn(SHEET, 'lunchHolderPos', 'timesheet.html'), ctx);
const pageHolderPos = vm.runInContext('lunchHolderPos', ctx);

// A deterministic sweep of shapes: early starts, late finishes, overnights,
// single and multi-block days, blocks that straddle the window and blocks
// nowhere near it.
const hhmm = m => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
let compared = 0, agreed = 0;
for (let startA = 0; startA < 1440; startA += 37) {
  for (let lenA = 30; lenA <= 700; lenA += 83) {
    for (let gap = 0; gap <= 240; gap += 60) {
      for (let lenB = 30; lenB <= 700; lenB += 131) {
        const windows = [
          { start: hhmm(startA), end: hhmm(startA + lenA) },
          { start: hhmm(startA + lenA + gap), end: hhmm(startA + lenA + gap + lenB) },
        ];
        compared++;
        if (B.lunchHolderPos(windows) === pageHolderPos(windows)) agreed++;
      }
    }
  }
}
assert(`agrees with timesheet.html on all ${compared} generated two-job days`,
  agreed === compared, `${compared - agreed} disagreements`);

let compared3 = 0, agreed3 = 0;
for (let a = 0; a < 1440; a += 173) {
  for (let l1 = 60; l1 <= 400; l1 += 97) {
    for (let l2 = 60; l2 <= 400; l2 += 113) {
      for (let l3 = 60; l3 <= 400; l3 += 131) {
        const w = [
          { start: hhmm(a),                 end: hhmm(a + l1) },
          { start: hhmm(a + l1 + 30),       end: hhmm(a + l1 + 30 + l2) },
          { start: hhmm(a + l1 + l2 + 60),  end: hhmm(a + l1 + l2 + 60 + l3) },
        ];
        compared3++;
        if (B.lunchHolderPos(w) === pageHolderPos(w)) agreed3++;
      }
    }
  }
}
assert(`and on all ${compared3} generated three-job days`,
  agreed3 === compared3, `${compared3 - agreed3} disagreements`);

// ── 2. A move reallocates; it never changes pay ────────────────────────────
console.log('\nA move never changes what the day pays');

{
  // The reported day: 07:30-09:00 (holds it, wrongly) / 09:30-16:00.
  const rows = day([['07:30', '09:00'], ['09:30', '16:00']], 0);
  const plan = B.planBackfill(rows);
  assert('the reported day is a move', plan.moves.length === 1, JSON.stringify(plan.skipped));
  const m = plan.moves[0];
  assert('off the morning job', String(m.from.id) === String(rows[0].id));
  assert('onto the job that ran over midday', String(m.target.id) === String(rows[1].id));
  assert('the day pays exactly the same before and after',
    m.dayHoursBefore === m.dayHoursAfter && m.totalPreserved,
    `${m.dayHoursBefore} vs ${m.dayHoursAfter}`);
  assert('7.50 of worked hours either way', m.dayHoursAfter === 7.5, String(m.dayHoursAfter));
  assert('both rows are rewritten', m.updates.length === 2);
  assert('the morning job is made whole at 1.50',
    m.updates.find(u => String(u.id) === String(rows[0].id)).to.computed_hours === 1.5);
  assert('the afternoon job goes to 6.00',
    m.updates.find(u => String(u.id) === String(rows[1].id)).to.computed_hours === 6);
  assert('exactly one row ends up holding it',
    m.updates.filter(u => u.to.lunch_break === true).length === 1);
}

assert('every move in a mixed batch preserves its day total',
  (() => {
    const rows = [].concat(
      day([['07:30', '09:00'], ['09:30', '16:00']], 0),
      day([['06:00', '10:00'], ['10:30', '14:30'], ['15:00', '18:00']], 0),
      day([['05:00', '07:00'], ['07:30', '10:30']], 0),
      day([['22:00', '06:00'], ['07:00', '09:00']], 1));
    const plan = B.planBackfill(rows);
    return plan.moves.length > 0 && plan.moves.every(m => m.totalPreserved);
  })());

// ── 3. Days that are already right, or have nothing to move ────────────────
console.log('\nDays with nothing to do are left alone');

assert('a day already allocated correctly is not touched',
  B.planBackfill(day([['07:30', '09:00'], ['09:30', '16:00']], 1)).moves.length === 0);
assert('and is counted as already right',
  B.planBackfill(day([['07:30', '09:00'], ['09:30', '16:00']], 1)).skipped.alreadyRight === 1);
assert('a day with no lunch is skipped',
  B.planBackfill(day([['07:30', '09:00'], ['09:30', '16:00']], -1)).skipped.noLunch === 1);
assert('a single-job day has nowhere to move it',
  B.planBackfill([row('07:00', '17:30', { lunch: true })]).skipped.single === 1);
assert('a single-job day is never rewritten even when it holds the break',
  B.planBackfill([row('07:00', '17:30', { lunch: true })]).moves.length === 0);

// ── 4. The dangerous shapes are separated, never applied ───────────────────
console.log('\nA block too short to hold the break is never given it');

assert('the planner agrees with the form about short blocks',
  B.lunchHolderPos([{ start: '07:00', end: '11:00' }, { start: '11:50', end: '12:10' }]) === 0);

assert('a holder shorter than the break is never written negative',
  (() => {
    // The day currently pays 4.00 because the break was clamped away entirely
    // on a 20-minute block. Moving it to a block that can absorb it makes the
    // day 3.83 — the worker loses ten minutes. That is pay, not reallocation.
    const rows = day([['07:00', '11:00'], ['11:50', '12:10']], 1);
    const plan = B.planBackfill(rows);
    return plan.moves.length === 0 && plan.drift.length === 1;
  })(),
  'it must be reported, never applied blind');

assert('a day shorter than the break itself is refused',
  (() => {
    const plan = B.planBackfill(day([['11:00', '11:20'], ['11:30', '11:55']], 0));
    return plan.moves.length === 0;
  })());

assert('no planned write is ever a negative number of hours',
  (() => {
    const rows = [].concat(
      day([['07:00', '11:00'], ['11:50', '12:10']], 1),
      day([['07:30', '09:00'], ['09:30', '16:00']], 0),
      day([['11:00', '11:20'], ['11:30', '11:55']], 0));
    const plan = B.planBackfill(rows);
    return plan.moves.every(m => m.updates.every(u => u.to.computed_hours >= 0));
  })());

console.log('\nDays that would change pay are reported, not moved');

{
  // Two rows each deducted half an hour: the day is an hour short, not half.
  const rows = day([['07:00', '11:00'], ['11:30', '16:00']], 0);
  rows[1].lunch_break = true;
  rows[1].computed_hours = 4.0;           // 4.5 gross less a second deduction
  const plan = B.planBackfill(rows);
  assert('a day deducted twice is flagged, not moved',
    plan.twoBreaks.length === 1 && plan.moves.length === 0);
  assert('because putting it right hands hours back — that is pay, not reallocation',
    plan.twoBreaks[0].holders.length === 2);
}

{
  // Stored hours that match nothing the punches say.
  const rows = day([['07:00', '11:00'], ['11:30', '16:00']], 0, { hours: { 1: 9.75 } });
  const plan = B.planBackfill(rows);
  assert('a row whose hours do not match its punches is flagged as drift',
    plan.drift.length === 1 && plan.moves.length === 0);
  assert('and names the row that drifted',
    plan.drift[0].drifted.length === 1
    && String(plan.drift[0].drifted[0].id) === String(rows[1].id));
}

assert('a day whose punches do not compute is reported unusable',
  (() => {
    const rows = day([['07:30', '09:00'], ['09:30', '16:00']], 0);
    rows[1].start_time = '';
    const plan = B.planBackfill(rows);
    return plan.unusable.length === 1 && plan.moves.length === 0;
  })());

// ── 5. Status: a day moves whole, or not at all ────────────────────────────
console.log('\nA split day is rewritten whole or not at all');

assert('approved days are out of scope by default',
  B.planBackfill(day([['07:30', '09:00'], ['09:30', '16:00']], 0, { status: 'approved' }))
    .skipped.status === 1);

assert('a day half-approved is held back entirely, not half-moved',
  (() => {
    const rows = day([['07:30', '09:00'], ['09:30', '16:00']], 0);
    rows[1].status = 'approved';
    const plan = B.planBackfill(rows, { statuses: ['draft', 'submitted'] });
    return plan.moves.length === 0 && plan.skipped.status === 1;
  })(),
  'moving one job of a day while its sibling is held back is how a day ends up with two breaks');

assert('opting approved in brings the whole day',
  B.planBackfill(day([['07:30', '09:00'], ['09:30', '16:00']], 0, { status: 'approved' }),
    { statuses: ['approved'] }).moves.length === 1);

assert('drafts are in scope alongside submitted',
  B.planBackfill(day([['07:30', '09:00'], ['09:30', '16:00']], 0, { status: 'draft' }))
    .moves.length === 1);

// ── 6. Grouping ────────────────────────────────────────────────────────────
console.log('\nGrouping is by day, in the order the worker entered the jobs');

assert('rows of one day group together whatever order they arrive in',
  (() => {
    const rows = day([['07:30', '09:00'], ['09:30', '16:00']], 0);
    const g = B.groupEntries([rows[1], rows[0]]);
    const list = [...g.values()][0];
    return list.length === 2 && Number(list[0].split_index) === 1;
  })());
assert('ungrouped entries never merge into one another',
  B.groupEntries([row('07:00', '12:00'), row('13:00', '17:00')]).size === 2);
assert('time-off rows are ignored entirely',
  B.groupEntries([{ id: 'x', entry_type: 'time_off' }]).size === 0);
assert('two separate days are two plans',
  (() => {
    const plan = B.planBackfill([].concat(
      day([['07:30', '09:00'], ['09:30', '16:00']], 0),
      day([['06:00', '08:00'], ['08:30', '15:00']], 0)));
    return plan.moves.length === 2;
  })());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
