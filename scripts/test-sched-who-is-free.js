#!/usr/bin/env node
'use strict';
/**
 * Who is spare, and who is in two places at once.
 *
 * Run: node scripts/test-sched-who-is-free.js
 *
 * Both questions are asked of the same number — how many jobs a man is on
 * today — and the board had been answering neither well.
 *
 * IDLE MEANS THE RANGE ON SCREEN. The strip counted "idle this day" from the
 * day you were looking at while the crew panel beside it filtered on the whole
 * week, so a day board said 67 idle at the top and offered four in the panel.
 * Everything reads bookedInView() now: a man booked on Tuesday is available on
 * Monday, and on Monday that is the only thing being asked about him.
 *
 * THE PILL SAYS THE THING YOU CAME FOR. "3/7" is the right answer on a week
 * board and a fact about six days you are not looking at on a day board, where
 * it reads free, on, or "2 jobs" in red — which is the double-booking, said in
 * the panel you drag FROM, before you add a third.
 *
 * AND FILL MUST NOT MANUFACTURE ONE. Once idle means free TODAY, a man offered
 * for a fill may well be on another job on Thursday; filling him Monday to
 * Friday would create the very clash the board reddens.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const eq = (label, got, want) => assert(label, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const SCHED = read('scheduler.html');

const WEEK = ['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26','2026-09-27'];
const FNS = ['assignmentsFor','loadForResource','bookedInView','jobsOnDate','idleEmployees',
             'railLoadPill','viewingOneDay','spanDaysCount','conflictResourcesOn'];

const A = (r, div, id, cc) => ({ id: r+div+id+(cc||''), resource:r, kind:'emp', division:div,
                                 jobId:id, jobName:id, costCode:cc||'', half:false });

/** The page's own helpers, over a board and a span. */
function page(span, assignments, employees) {
  const sandbox = {
    console,
    state: { span, assignments: assignments || {}, board: { employees: employees || [] } },
    weekDateStrs: () => (span === 'day' ? [WEEK[0]] : WEEK),
    fullWeekDateStrs: () => WEEK,
  };
  vm.createContext(sandbox);
  const decl = SCHED.match(/^const BOARD_SPANS = \{[^}]*\};$/m);
  if (!decl) throw new Error('BOARD_SPANS not found — the span model moved');
  vm.runInContext(decl[0], sandbox, { filename: 'scheduler.html' });
  FNS.forEach(n => vm.runInContext(requireFn(SCHED, n, 'scheduler.html'), sandbox, { filename: 'scheduler.html' }));
  return sandbox;
}

// Blake works Monday on turf. Colton works Tuesday only.
const BOARD = {
  '2026-09-21': [A('Blake', 'turf', '26049')],
  '2026-09-22': [A('Colton', 'paving', '26091')],
};
const CREW = [{ name:'Blake' }, { name:'Colton' }, { name:'Shane' }];

(async () => {
  console.log('Who is spare, and who is in two places at once\n');

  console.log('[idle follows the range on screen]');
  {
    const d = page('day', BOARD, CREW), w = page('week', BOARD, CREW);
    assert('  a man working today is not idle today', d.bookedInView('Blake'));
    assert('  a man working TOMORROW is idle today', !d.bookedInView('Colton'));
    assert('  and on a week board he is not', w.bookedInView('Colton'));
    eq('  so the day board counts two spare', d.idleEmployees().length, 2);
    eq('  and the week board one', w.idleEmployees().length, 1);
    // The gap this closes: the strip and the panel disagreeing in one view.
    assert('  nobody is idle who is booked in the range',
      d.idleEmployees().every(e => !d.bookedInView(e.name)));
  }

  console.log('\n[how many jobs, not how many bookings]');
  {
    // Two cost codes on ONE job is one job. The board books a man once per
    // job, but a older row can still carry a code, and counting rows would
    // report a clash that is not one.
    const p = page('day', { '2026-09-21': [A('Blake','turf','26049','02-100'), A('Blake','turf','26049','02-200')] });
    eq('  two codes on one job is one job', p.jobsOnDate('Blake', WEEK[0]), 1);
    const q = page('day', { '2026-09-21': [A('Blake','turf','26049'), A('Blake','paving','26091')] });
    eq('  two jobs is two', q.jobsOnDate('Blake', WEEK[0]), 2);
    assert('  and that is what the board reddens', q.conflictResourcesOn(WEEK[0]).has('Blake'));
    eq('  a man on nothing is on nothing', q.jobsOnDate('Shane', WEEK[0]), 0);
  }

  console.log('\n[the pill says what the board is showing]');
  {
    const clash = { '2026-09-21': [A('Blake','turf','26049'), A('Blake','paving','26091')] };
    const d = page('day', clash, CREW);
    assert('  free, on a day nothing is booked', /free/.test(d.railLoadPill('Shane')), d.railLoadPill('Shane'));
    const blake = d.railLoadPill('Blake');
    assert('  two jobs on one day says so', /2 jobs/.test(blake), blake);
    assert('  and says it in red', /rail-load clash/.test(blake), blake);
    const one = page('day', BOARD, CREW).railLoadPill('Blake');
    assert('  one job is neither free nor a clash',
      /">on</.test(one) && !/clash/.test(one) && !/free/.test(one), one);

    // A week board is still counting days, and still says so.
    const w = page('week', BOARD, CREW);
    assert('  a week board counts days out of seven', /1\/7/.test(w.railLoadPill('Blake')), w.railLoadPill('Blake'));
    assert('  and marks nobody a clash there', !/clash/.test(w.railLoadPill('Blake')));
  }

  console.log('\n[Fill never manufactures a double-booking]');
  {
    const src = requireFn(SCHED, 'autoFill', 'scheduler.html');
    assert('  it drops days the man is already working',
      /dates\.filter\(d => !assignmentsFor\(d, e\.name\)\.length\)/.test(src), src.slice(0, 300));
    assert('  and fills only the days that are left', /addAssignmentSpan\(e\.name, 'emp', job, '', free\)/.test(src));
    assert('  saying how many it left alone', /skipped/.test(src));
    // It still reaches across the real week, not the one day on screen.
    assert('  over the whole week, whichever board you are on', /fullWeekDateStrs\(\)/.test(src));
  }

  console.log('\n[hover one man and the board says where he is]');
  {
    const chip = requireFn(SCHED, 'chip', 'scheduler.html');
    assert('  a chip says whose it is', /data-res="'\+esc\(a\.resource\)\+'"/.test(chip),
      'chips carry no data-res, so nothing can trace them');
    const trace = requireFn(SCHED, 'traceResource', 'scheduler.html');
    // A name is free text. "O'Brien" in an attribute selector is a syntax
    // error, so the match walks the chips and compares instead.
    assert('  matching compares the value, it does not build a selector',
      /dataset\.res === name/.test(trace) && !/querySelectorAll\('\[data-res="/.test(trace), trace);
    assert('  the rest of the board dims rather than disappearing',
      /classList\.toggle\('tracing'/.test(trace) && /body\.tracing \.asn:not\(\.trace\) \{ opacity/.test(SCHED));
    const over = requireFn(SCHED, 'onTraceOver', 'scheduler.html');
    assert('  it reads the crew panel as well as the board',
      /\.rail-row\[data-res\]/.test(over), over);
    assert('  and never fights a drag for the highlight', /if \(_drag\) return;/.test(over), over);
    assert('  a drag clears it outright',
      /function onDragStart\(e\) \{\s*traceResource\(null\);/.test(SCHED));
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
