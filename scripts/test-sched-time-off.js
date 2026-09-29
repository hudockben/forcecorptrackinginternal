#!/usr/bin/env node
'use strict';
/**
 * A half day off does not take a man off the board for the whole day.
 *
 * Run: node scripts/test-sched-time-off.js
 *
 * The Scheduler asks a different question of a time-off entry than payroll
 * does. Payroll asks what the man is owed; the board asks whether he is here.
 * For a long while there was only one answer available — the row existed, so he
 * was off — and blocking the date was right, because every day off was a whole
 * one.
 *
 * Half days broke that. A four-hour morning took a man off the schedule for
 * eight, and the crew was planned around an absence that was half imaginary:
 * the board would not let him be assigned, the auto-fill skipped him, the
 * candidate list greyed him out, and the week review listed him as a problem to
 * fix if anyone scheduled him anyway.
 *
 * THE RULE, and both of its edges are deliberate:
 *
 *   partial  ⇔  0 < hours < FULL_DAY_HOURS
 *
 *   A full day (or longer) is a whole-day absence, plainly. And ZERO is too —
 *   it is an UNPAID day off, which means the man is gone all day and simply not
 *   paid for it. That is a payroll fact, not a second kind of presence, so zero
 *   blocks exactly as eight does. Only an answer that leaves part of the day
 *   standing makes him schedulable.
 *
 * NULL is the load-bearing case, as everywhere else in this feature: it is
 * every row filed before payroll could ask how long, and it has to read as a
 * whole day. Reading it as 0 would turn every one of them into a man who is
 * somehow off for no time at all — and, with the rule above, into a man the
 * board would happily schedule through his own vacation.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT  = path.resolve(__dirname, '..');
const board = require(path.join(ROOT, 'api/scheduler/board.js'));
const { leaveHoursOf, PAID_LEAVE_HOURS } =
  require(path.join(ROOT, 'api/lib/payroll-metrics.js'));
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const PAGE = fs.readFileSync(path.join(ROOT, 'scheduler.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── What the board makes of a row ───────────────────────────────────────────
console.log('\n[how long the day off is, and whether any of it is left]');
{
  const shape = h => board.offShape({ time_off_hours: h });

  assert('a full day is a whole-day absence',
    shape(8).hours === 8 && shape(8).partial === false);
  assert('a HALF day leaves half the day standing',
    shape(4).hours === 4 && shape(4).partial === true);
  assert('  and so does any other part of one',
    [0.5, 2, 6, 7.5].every(h => shape(h).partial === true));

  // The edge that is easy to get backwards. Zero is not "barely off", it is an
  // unpaid day off — gone all day, and paid nothing for it.
  assert('ZERO is a whole-day absence, not a sliver of one',
    shape(0).hours === 0 && shape(0).partial === false);
  assert('  and a day longer than a full one is still just a whole day off',
    shape(12).partial === false);

  // Every row filed before payroll could ask.
  assert('an entry that does not say is a FULL day',
    shape(null).hours === board.FULL_DAY_HOURS && shape(null).partial === false);
  assert('  and so is one with the key absent entirely',
    board.offShape({}).partial === false && board.offShape({}).hours === 8);
  assert('  and an unreadable figure, which is not a zero',
    ['abc', NaN, -4].every(h => shape(h).hours === 8 && shape(h).partial === false));

  // A NUMERIC column can arrive as a string over some drivers.
  assert('a numeric string is a number', shape('4').partial === true && shape('4').hours === 4);
}

// ── The board and payroll must not disagree about the same entry ────────────
// One entry decides both what a man is paid and whether he can be put on a job.
// The board keeps its own copy of the full-day rule (it computes no money and
// should not pull in the payroll module), so the two copies are checked against
// each other rather than trusted to match.
console.log('\n[the board reads the same hours payroll pays]');
{
  assert('the board and payroll agree what a full day is',
    board.FULL_DAY_HOURS === PAID_LEAVE_HOURS);

  const cases = [null, undefined, 0, 0.5, 4, 7.5, 8, 12, '4', 'abc', NaN, -1];
  const mismatched = cases.filter(h => {
    const paid = leaveHoursOf({ entry_type: 'time_off', status: 'approved', time_off_hours: h });
    // payroll clamps a wild figure to a day's maximum; the board does not need
    // to, so compare below that ceiling, which is where every real row sits.
    return paid <= 24 && h !== 12 && board.offShape({ time_off_hours: h }).hours !== paid;
  });
  assert('and on every shape a row arrives in',
    mismatched.length === 0, `disagreed on: ${JSON.stringify(mismatched)}`);
}

// ── What the page does with it ──────────────────────────────────────────────
// The page's own functions, lifted rather than restated: the block rule is the
// one thing on this board that changes what a scheduler is allowed to do.
console.log('\n[a part day is schedulable; a whole one is not]');
{
  const ctx = { state: { board: { timeOff: {} } } };
  vm.createContext(ctx);
  vm.runInContext(`
    ${requireFn(PAGE, 'isOff',        'scheduler.html')}
    ${requireFn(PAGE, 'offHrsText',   'scheduler.html')}
    ${requireFn(PAGE, 'offLabel',     'scheduler.html')}
    ${requireFn(PAGE, 'isBlockedOff', 'scheduler.html')}
  `, ctx);

  const D = '2026-09-18';
  const set = o => { ctx.state.board.timeOff = o ? { 'G. Oakes': { [D]: o } } : {}; };
  const blocked = () => ctx.isBlockedOff('G. Oakes', 'emp', D);
  const approved = (hours, partial) => ({ status: 'approved', type: 'vacation', hours, partial });

  set(null);
  assert('a man with no time off is schedulable', blocked() === false);

  set(approved(8, false));
  assert('an approved WHOLE day off blocks the date', blocked() === true);

  set(approved(4, true));
  assert('an approved HALF day does NOT block it — he is there for the rest',
    blocked() === false);

  set(approved(0, false));
  assert('an approved UNPAID day off still blocks — he is gone all day',
    blocked() === true);

  set({ status: 'submitted', type: 'vacation', hours: 8, partial: false });
  assert('a REQUESTED whole day is a warning, not a block — it is not final yet',
    blocked() === false);

  // Equipment carries no time off at all, whatever happens to be on the map.
  set(approved(8, false));
  assert('equipment is never blocked', ctx.isBlockedOff('G. Oakes', 'equip', D) === false);

  // The label the board says it with, in one place so four screens agree.
  assert('a part day is labelled by its hours', ctx.offLabel(approved(4, true)) === '4 h off');
  assert('  trailing zeros are trimmed, so it reads 4 h and not 4.00 h',
    ctx.offLabel(approved(4, true)) === '4 h off'
    && ctx.offLabel(approved(7.5, true)) === '7.5 h off');
  assert('  and a whole day is just "off"', ctx.offLabel(approved(8, false)) === 'off');
}

// ── The places that used to ask the wrong question ──────────────────────────
// Each of these read isOff — "is there a row" — where the question is "is he
// gone all day". Asserted against the page source because they are one-liners
// inside render functions with no seam to call.
console.log('\n[every path that acts on an absence asks about the whole day]');
{
  const src = PAGE;
  assert('the block rule itself excludes a part day',
    /o\.status === 'approved' && !o\.partial/.test(src));
  assert('auto-fill offers a man who is only off for part of the day',
    /idleEmployees\(\)\.filter\(e => !dates\.every\(d => isBlockedOff\(e\.name, 'emp', d\)\)\)/.test(src));
  // Which days auto-fill then books is run for real, in its own section below.
  assert('the week review does not list a part day as something to fix',
    /if \(off && !off\.partial\) offSched\.push/.test(src));
  assert('the candidate list only greys out a whole approved day',
    /c\.off\.status === 'approved' && !c\.off\.partial/.test(src));
  assert('  and does not sink a part-day candidate to the bottom',
    /const ao = !!\(a\.off && !a\.off\.partial\), bo = !!\(b\.off && !b\.off\.partial\)/.test(src));
  assert('the grid does not flag a scheduled part day as a clash',
    /const offClash = !!\(off && items\.length && !off\.partial\)/.test(src));

  // The one place a scheduler is told WHY they cannot schedule somebody.
  assert('the refusal says it is the whole day that is spoken for',
    /is approved off for the whole day \(/.test(src));
}

// ── Auto-fill, run ──────────────────────────────────────────────────────────
// Fill puts idle crew on a job for the rest of the week. It used to be pinned
// here by a regex on one way of writing its day filter, and the suite went red
// the day the filter was written another way although no day was booked
// differently. What matters is which days end up booked and what the toast
// says about the rest, so that is what this runs.
console.log('\n[auto-fill books the days a person is there, and says why it left the rest]');
{
  const WEEK = ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'];
  const [, MON, TUE, WED, THU, FRI] = WEEK;   // Sunday to Saturday; today is the Monday
  const JOB = { division: 'paving', id: 'j1', name: 'Route 9' };
  const WHO = 'Pat Doyle';
  const toasts = [];
  let seq = 0;
  const ctx = {
    state: null, _undo: [],
    jobById: (div, id) => (div === JOB.division && id === JOB.id ? JOB : null),
    jobRollup: () => ({ needed: 1 }),
    jobCodes: () => [],
    roleOf: () => '',
    idleEmployees: () => ctx.state.board.employees,
    fullWeekDateStrs: () => WEEK.slice(),
    todayStr: () => MON,
    pushUndo: () => { ctx._undo.push('snapshot'); },
    updateUndoButtons: () => {},
    toast: m => { toasts.push(m); },
    render: () => {},
    saveAssignments: () => {},
    stampHaul: () => false,
    uid: () => 'a' + (++seq),
  };
  vm.createContext(ctx);
  // keptOff: placeOnJob refuses anyone kept off the Scheduler in Manage Users.
  vm.runInContext(['isOff', 'isBlockedOff', 'keptOff', 'dayList', 'assignmentsFor', 'placeOnJob', 'addAssignmentSpan', 'autoFill']
    .map(fn => requireFn(PAGE, fn, 'scheduler.html')).join('\n'), ctx);

  const approved = (hours, partial) => ({ status: 'approved', type: 'vacation', hours, partial });
  const elsewhere = { id: 'x1', resource: WHO, kind: 'emp', division: 'paving', jobId: 'j2', jobName: 'Mill St', costCode: '' };
  // Fill the job with WHO the only idle hand; the days they land on it, and what they were told.
  const fill = (timeOff, assignments) => {
    ctx.state = { board: { employees: [{ name: WHO }], timeOff: { [WHO]: timeOff } }, assignments };
    ctx._undo = []; toasts.length = 0;
    ctx.autoFill(JOB.division, JOB.id);
    const onJob = WEEK.filter(d => (assignments[d] || []).some(a => a.resource === WHO && a.jobId === JOB.id));
    return { onJob, toast: toasts[toasts.length - 1] };
  };

  let r = fill({ [WED]: approved(8, false), [THU]: approved(4, true) }, { [TUE]: [{ ...elsewhere }] });
  assert('a whole approved day off is not booked', !r.onJob.includes(WED), JSON.stringify(r.onJob));
  assert('  a part day off IS — they are there for the rest of it', r.onJob.includes(THU), JSON.stringify(r.onJob));
  assert('  and so is every day with nothing in the way', r.onJob.includes(MON) && r.onJob.includes(FRI));
  assert('  while a day already on another job is left alone', !r.onJob.includes(TUE)
    && ctx.state.assignments[TUE].length === 1 && ctx.state.assignments[TUE][0].jobId === 'j2');
  assert('the toast counts the day off apart from the day already booked',
    r.toast === 'Put Pat Doyle on Route 9 · left 1 day alone, already booked · skipped 1 day off', r.toast);

  r = fill({ [MON]: approved(0, false), [TUE]: { status: 'submitted', type: 'vacation', hours: 8, partial: false } }, {});
  assert('an UNPAID day off is skipped like a paid one', !r.onJob.includes(MON), JSON.stringify(r.onJob));
  assert('  a day only REQUESTED off is still filled — it is not final yet', r.onJob.includes(TUE), JSON.stringify(r.onJob));
  assert('  and with nothing already booked, the toast mentions only the day off',
    r.toast === 'Put Pat Doyle on Route 9 · skipped 1 day off', r.toast);

  r = fill({ [WED]: approved(8, false), [THU]: approved(8, false), [FRI]: approved(8, false) },
    { [MON]: [{ ...elsewhere }], [TUE]: [{ ...elsewhere, id: 'x2' }] });
  assert('booked or off every day left, nothing is added', r.onJob.length === 0, JSON.stringify(r.onJob));
  assert('  the toast says off as well as booked',
    r.toast === 'Those crew are already booked or off every day left this week', r.toast);
  assert('  and the undo step it opened is taken back', ctx._undo.length === 0);

  r = fill({ [MON]: approved(8, false), [TUE]: approved(8, false), [WED]: approved(8, false),
    [THU]: approved(8, false), [FRI]: approved(8, false) }, {});
  assert('someone off every day left is not offered at all',
    r.onJob.length === 0 && /off all week/.test(r.toast), r.toast);
}

// ── What the assistant is handed ────────────────────────────────────────────
// A bare name carried neither of the two facts that decide what may be said
// about it, and the digest advertises time off in COVERS.scheduler.
console.log('\n[the assistant is told the status and the length, not just a name]');
{
  const DIG = fs.readFileSync(path.join(ROOT, 'api/lib/mathis-digests.js'), 'utf8');
  assert('the digest sends a row per person per day, not a list of names',
    !/timeOff: capList\(off\.map\(n => \(\{ name: safeText\(n, 60\) \}\)\)\)/.test(DIG)
    && /timeOff: capList\(off\)/.test(DIG));
  assert('  carrying whether it is approved or merely requested',
    /status:\s*o\.status === 'approved' \? 'approved' : 'requested'/.test(DIG));
  assert('  and how long it is, and whether it leaves part of the day',
    /hours:\s*round2\(o\.hours\)/.test(DIG) && /partial:\s*!!o\.partial/.test(DIG));
  assert('  and the date, so "off Tuesday" can be checked against a Tuesday',
    /date:\s*safeText\(date, 10\)/.test(DIG));
  // The limits are the assistant's only guard against saying the wrong thing.
  assert('the scheduler limits forbid reporting a requested day as time taken',
    /never report it as time the person is taking/.test(DIG));
  assert('  and forbid describing a partial day as being out',
    /never describe a partial day as being out/.test(DIG));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
