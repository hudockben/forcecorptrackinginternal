#!/usr/bin/env node
'use strict';
/**
 * The board's span: a day by default, a week on request.
 *
 * Run: node scripts/test-sched-span.js
 *
 * A dispatcher works one day at a time — who is on what tomorrow — and a
 * seven-column board made him read six columns he was not acting on to find
 * the one he was. So the board opens on a day, and Week is a toggle beside the
 * date.
 *
 * The whole risk of that change is ONE distinction, and it is what this suite
 * is for. Two ranges now exist:
 *
 *   weekDays()     what is ON SCREEN. The KPI strip, both boards, the
 *                  Attention tab and the off-project rows follow it, so the
 *                  numbers describe the columns underneath them.
 *   fullWeekDays() a CALENDAR WEEK, whatever the view. Copy week → next, the
 *                  Apply-to spans in the assign dialog, the weekly dispatch
 *                  sheet, how loaded a man is, and auto-fill's "rest of the
 *                  week" all mean seven days and must keep meaning seven days.
 *
 * Run the second group off the visible range and a day view quietly turns
 * "Copy week → next" into copying one day, and "Apply to all 7 days" into
 * applying to one. Neither would throw; both would just silently do a seventh
 * of the job. That is the failure this file exists to catch, so most of what
 * follows reads the page's source to prove which range each caller uses.
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

/** The page's own range helpers, over a fixed anchor. */
function ranges(span) {
  const sandbox = { console, state: { span, weekAnchor: new Date('2026-09-21T12:00:00') } };
  vm.createContext(sandbox);
  const decl = SCHED.match(/^const BOARD_SPANS = \{[^}]*\};$/m);
  if (!decl) throw new Error('BOARD_SPANS not found — the span model moved');
  vm.runInContext(decl[0], sandbox, { filename: 'scheduler.html' });
  vm.runInContext("function pad(n){return String(n).padStart(2,'0');}" +
    "function dstr(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}", sandbox);
  ['spanDaysCount','viewingOneDay','_daysFrom','weekDays','weekDateStrs','fullWeekDays','fullWeekDateStrs','rangeTag','rangeWords']
    .forEach(n => vm.runInContext(requireFn(SCHED, n, 'scheduler.html'), sandbox, { filename: 'scheduler.html' }));
  return sandbox;
}

/** The body of a named function, for asserting which range it reads. */
const bodyOf = n => requireFn(SCHED, n, 'scheduler.html');

(async () => {
  console.log('The board’s span\n');

  console.log('[what is on screen]');
  {
    const d = ranges('day'), w = ranges('week');
    eq('  a day view is one column', d.weekDateStrs().length, 1);
    eq('  and it is the anchor day', d.weekDateStrs()[0], '2026-09-21');
    eq('  a week view is seven', w.weekDateStrs().length, 7);
    eq('  starting at the same anchor', w.weekDateStrs()[0], '2026-09-21');
    eq('  and ending six days later', w.weekDateStrs()[6], '2026-09-27');
    assert('  the day view knows it is one day', d.viewingOneDay() && !w.viewingOneDay());
  }

  console.log('\n[a calendar week is seven days in either view]');
  {
    const d = ranges('day'), w = ranges('week');
    eq('  seven days in the day view', d.fullWeekDateStrs().length, 7);
    eq('  seven days in the week view', w.fullWeekDateStrs().length, 7);
    eq('  and the same seven', d.fullWeekDateStrs().join(), w.fullWeekDateStrs().join());
    eq('  which the week view’s columns match exactly',
      w.weekDateStrs().join(), w.fullWeekDateStrs().join());
  }

  console.log('\n[an unknown span falls back to a week, never to nothing]');
  {
    const junk = ranges('fortnight');
    eq('  a span nobody defined still draws seven columns', junk.weekDateStrs().length, 7);
  }

  console.log('\n[the callers that MEAN a calendar week read one]');
  {
    // Each of these would silently do a seventh of its job against the visible
    // range in a day view, without throwing.
    const mustUseFullWeek = [
      ['loadForResource',      'how loaded a man is — the pill says /7d'],
      ['spanDates',            'Apply to: Weekdays / All 7 days'],
      ['staffedDaysThisWeek',  '"N days staffed this week"'],
      ['codeStaffed',          'whether a finished cost code still has crew'],
      ['jobAllDone',           'whether a done job still has crew on it'],
      ['copyWeekForward',      'Copy week → next'],
      ['dispatchDates',        'the weekly dispatch sheet'],
      ['firstWorkdayThisWeek', 'where auto-fill starts'],
      ['autoFill',             'auto-fill’s "rest of the week"'],
    ];
    mustUseFullWeek.forEach(([fn, why]) => {
      const src = bodyOf(fn);
      assert('  ' + fn + ' — ' + why,
        /fullWeekDate?Strs?\(\)|fullWeekDays\(\)/.test(src) && !/[^l]weekDateStrs\(\)/.test(src),
        'reads the visible range');
    });
  }

  console.log('\n[the callers that mean WHAT IS ON SCREEN read that]');
  {
    [['renderCapacity', 'the KPI strip'],
     ['otherJobsInWeek', 'the off-project rows'],
     ['offRoster', 'names booked who are not on the roster'],
     ['resourcesInPlay', 'who the By Crew board lists']].forEach(([fn, why]) => {
      const src = bodyOf(fn);
      assert('  ' + fn + ' — ' + why, /weekDateStrs\(\)/.test(src) && !/fullWeek/.test(src),
        'reads a calendar week');
    });
  }

  console.log('\n[what the range is called]');
  {
    const d = ranges('day'), w = ranges('week');
    eq('  a day does not claim to be 7d', d.rangeTag(), 'this day');
    eq('  a week says 7d', w.rangeTag(), '7d');
    eq('  and the prose follows it', d.rangeWords(), 'this day');
    eq('  both ways', w.rangeWords(), 'this week');
  }

  console.log('\n[the toggle is wired and the default is a day]');
  {
    assert('the board opens on a day', /\bspan:'day'/.test(SCHED),
      (SCHED.match(/span:'[a-z]+'/) || ['(not found)'])[0]);
    assert('the preference is saved', /span:state\.span/.test(SCHED));
    assert('and read back, but only if it is one of the two',
      /p\.span === 'day' \|\| p\.span === 'week'/.test(SCHED));
    assert('the Day and Week buttons exist', /id="spanDay"/.test(SCHED) && /id="spanWeek"/.test(SCHED));
    assert('and are wired to setBoardSpan',
      /on\('spanDay',\s*\(\) => setBoardSpan\('day'\)\)/.test(SCHED) &&
      /on\('spanWeek',\s*\(\) => setBoardSpan\('week'\)\)/.test(SCHED));
    // Paging must move by what is on screen, or Week's arrows step one day.
    assert('the arrows step by the span, not a hard-coded 7',
      /stepDays\(-spanDaysCount\(\)\)/.test(SCHED) && /stepDays\(spanDaysCount\(\)\)/.test(SCHED),
      'nav still steps a fixed number of days');
    // wk[6] is undefined when one column is drawn.
    assert('the date label never reaches past the last column drawn',
      !/wk\[6\]/.test(SCHED), 'wknavHtml still indexes wk[6]');
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
