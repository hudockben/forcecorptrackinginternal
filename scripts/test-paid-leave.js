#!/usr/bin/env node
'use strict';
/**
 * An approved day off is eight paid hours, and they are NOT hours worked.
 *
 * Run: node scripts/test-paid-leave.js
 *
 * A time-off entry carries a date and a type and nothing else — every hours
 * column on the row is null — so the eight hours are not a figure the timesheet
 * reports. They are what APPROVING the day MEANS. The payroll report used to
 * say nothing about them at all: a fortnight with two approved vacation days
 * read 25.00 hours across every column, and the sixteen hours the man was owed
 * lived in whoever remembered them. That is what this file exists to prevent
 * coming back.
 *
 * The two halves of the rule are equally load-bearing, and pull in opposite
 * directions:
 *
 *   PAID.      The hours have to reach the sheet payroll runs the cycle off —
 *              as a figure, on the row, in the workbook, in the executive PDF.
 *
 *   NOT WORKED. And they must reach none of the columns that measure work.
 *              Paid leave that leaked into the weekly total would push a man
 *              into overtime he never worked; into prevailing, it would claim a
 *              premium for a covered site he was nowhere near. So totalHours
 *              stays the hours WORKED — it is what regular + overtime is
 *              measured against — and the leave rejoins the row exactly once,
 *              in totalPaidHours.
 *
 * And ONLY an approved day. A request still waiting on a supervisor is owed
 * nothing yet; it is counted separately so the office can see what the queue is
 * worth, and it is never added into a paid total.
 */

const fs   = require('fs');
const path = require('path');
const {
  payrollMetrics, timeOffPayHours, PAID_LEAVE_HOURS,
} = require(path.resolve(__dirname, '../api/lib/payroll-metrics.js'));
// One brace matcher, shared — see scripts/lib/fn-source.js for why.
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));

const ROOT = path.resolve(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'payroll.html'),    'utf8');
const EXEC = fs.readFileSync(path.join(ROOT, 'executive.html'),  'utf8');
const API  = fs.readFileSync(path.join(ROOT, 'api/executive/report.js'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;

// A day worked. Defaults are the ordinary case: eight hours on a
// non-prevailing job with no travel.
const day = (work_date, over = {}) => Object.assign({
  id: 'd' + work_date, username: 'boringjamey', entry_type: 'daily',
  status: 'approved', division: 'quarry', work_date,
  computed_hours: 8, travel_hours: 0, prevailing_wage: false, haul_type: null,
  job_label: 'Daily — Homer City', lunch_break: false, operated_equipment: true,
  created_at: work_date + 'T12:00:00Z',
}, over);

// A day off. Approved unless the case under test is about approval.
const off = (work_date, over = {}) => Object.assign({
  id: 'o' + work_date, username: 'boringjamey', entry_type: 'time_off',
  status: 'approved', time_off_type: 'vacation', work_date,
  created_at: work_date + 'T12:00:00Z',
}, over);

const WEEK = { periodStart: '2026-09-14', periodEnd: '2026-09-20' };
const run  = entries => payrollMetrics(Object.assign({ entries }, WEEK)).totals;

// ── What a day off pays ──────────────────────────────────────────────────────
console.log('\n[a day off pays eight hours, once it is approved]');
{
  assert('the rate is a full eight-hour day', PAID_LEAVE_HOURS === 8);
  assert('an approved day off pays it', timeOffPayHours(off('2026-09-17')) === 8);
  assert('  whatever the reason on it — leave is leave',
    ['vacation', 'sick', 'holiday', 'jury_duty', 'bereavement']
      .every(t => timeOffPayHours(off('2026-09-17', { time_off_type: t })) === 8));
  // The line approvedHours already draws, drawn the same way.
  assert('a day still waiting on a supervisor pays nothing yet',
    timeOffPayHours(off('2026-09-17', { status: 'submitted' })) === 0);
  assert('  and a draft was never even asked for',
    timeOffPayHours(off('2026-09-17', { status: 'draft' })) === 0);
  assert('a day WORKED is not leave, whatever it is handed',
    timeOffPayHours(day('2026-09-14')) === 0);
  assert('  and neither is nothing at all',
    timeOffPayHours(null) === 0 && timeOffPayHours(undefined) === 0);
}

// ── The fortnight in the screenshot that started this ───────────────────────
console.log('\n[the week that read 25.00 hours and owed 41.00]');
{
  const t = run([
    day('2026-09-14', { computed_hours: 9.25 }),
    day('2026-09-15'),
    day('2026-09-16', { computed_hours: 7.75 }),
    off('2026-09-17'),
    off('2026-09-18'),
  ]);
  assert('the hours worked are unchanged — 25.00, exactly as before',
    near(t.totalHours, 25), String(t.totalHours));
  assert('the two approved days off are sixteen paid hours', near(t.offHours, 16));
  assert('and the check is cut for 41.00', near(t.totalPaidHours, 41));
  assert('  which is the two figures and nothing else',
    near(t.totalPaidHours, t.totalHours + t.offHours));
}

// ── Not worked: the columns leave must never reach ──────────────────────────
console.log('\n[paid, and never counted as worked]');
{
  // Thirty-six hours and a paid holiday. Forty-four hours are owed; not one of
  // them is overtime, because four of them were never worked.
  const t = run([
    day('2026-09-14', { computed_hours: 9 }),
    day('2026-09-15', { computed_hours: 9 }),
    day('2026-09-16', { computed_hours: 9 }),
    day('2026-09-17', { computed_hours: 9 }),
    off('2026-09-18', { time_off_type: 'holiday' }),
  ]);
  assert('44.00 h are paid for the week', near(t.totalPaidHours, 44));
  assert('  and NONE of it is overtime — the man worked 36',
    near(t.otHours, 0), String(t.otHours));
  assert('  the forty is measured on the hours worked, which is totalHours',
    near(t.totalHours, 36) && near(t.regHours, 36));

  // The same week on a prevailing-wage job. A man on holiday worked no covered
  // site, so the premium cannot follow him onto it.
  const pw = run([
    day('2026-09-14', { computed_hours: 8, prevailing_wage: true }),
    off('2026-09-15', { time_off_type: 'holiday' }),
  ]);
  assert('leave is never prevailing', near(pw.pwHours, 8), String(pw.pwHours));
  assert('  and it is not in the standard bucket either — it is in neither',
    near(pw.stdHours, 0), String(pw.stdHours));
  assert('  so prevailing + standard still equals the hours WORKED',
    near(pw.pwHours + pw.stdHours, pw.totalHours));
  assert('and it is no part of the work/travel split',
    near(pw.workHours, 8) && near(pw.travelHours, 0));
  assert('nor of a day worked — a day off is not a day worked',
    pw.daysWorked === 1, String(pw.daysWorked));
}

// ── Pending leave is named, never paid ──────────────────────────────────────
console.log('\n[what the approval queue is worth is not what is owed]');
{
  const t = run([
    day('2026-09-14'),
    off('2026-09-15'),
    off('2026-09-16', { status: 'submitted' }),
    off('2026-09-17', { status: 'submitted' }),
  ]);
  assert('only the approved day is paid', near(t.offHours, 8), String(t.offHours));
  assert('  the two pending days are carried separately',
    near(t.pendingOffHours, 16), String(t.pendingOffHours));
  assert('  and are not in the paid total', near(t.totalPaidHours, 16));
  assert('the day counts still say how many of each',
    t.approvedOff === 1 && t.pendingOff === 2);
}

// ── The two copies of the rule ──────────────────────────────────────────────
// payroll.html carries its own, because the Reports tab renders in the browser
// off rows already in memory. A second copy is a second place to drift, so the
// two are run against each other rather than trusted to match.
console.log('\n[payroll.html says the same thing]');
{
  const pageConst = PAGE.match(/const PAID_LEAVE_HOURS = (\d+);/);
  assert('the page names the same eight hours',
    pageConst && Number(pageConst[1]) === PAID_LEAVE_HOURS,
    pageConst ? pageConst[1] : 'not found');

  const pageFn = new Function(`
    const PAID_LEAVE_HOURS = ${PAID_LEAVE_HOURS};
    ${requireFn(PAGE, 'timeOffPayHours', 'payroll.html')}
    return timeOffPayHours;
  `)();
  const cases = [
    off('2026-09-17'),
    off('2026-09-17', { status: 'submitted' }),
    off('2026-09-17', { status: 'draft' }),
    off('2026-09-17', { time_off_type: 'holiday' }),
    day('2026-09-14'),
    null,
  ];
  assert('and both copies answer every case identically',
    cases.every(c => pageFn(c) === timeOffPayHours(c)),
    cases.map(c => `${pageFn(c)}/${timeOffPayHours(c)}`).join(' '));
}

// ── The report actually shows it ────────────────────────────────────────────
// Arithmetic nobody can see is the state this change was made to fix. The
// figure has to be ON the sheet, so the page's own renderer is run and the
// cells are read back out of it.
console.log('\n[the Hours Report puts the figure on the sheet]');
{
  let JSDOM;
  try { ({ JSDOM } = require(path.join(ROOT, 'node_modules/jsdom'))); }
  catch { console.log('  jsdom not installed — skipping the render checks'); JSDOM = null; }

  if (JSDOM) {
    const FROM = '2026-09-14', TO = '2026-09-20';
    const dom = new JSDOM(`<!doctype html><body>
      <input id="flt-from" value="${FROM}"><input id="flt-to" value="${TO}">
      <select id="flt-division"><option value="" selected></option></select>
      <input id="flt-user" value=""><input id="flt-supervisor" value="">
      <div id="reportWrap"></div></body>`);

    const FULL_SRC = PAGE.slice(PAGE.indexOf("    const FULL = '"),
      PAGE.indexOf(';', PAGE.indexOf("    const FULL = '")) + 1);
    const DETAIL_COLS_SRC = PAGE.slice(PAGE.indexOf('    const DETAIL_COLUMNS = ['),
      PAGE.indexOf('];', PAGE.indexOf('    const DETAIL_COLUMNS = [')) + 2);
    const FNS = ['escapeHtml', 'prettyDate', 'prettyDateShort', 'prettyDiv', 'prettyOff',
      'dayFlagHtml', 'equipUsedPieces', 'equipUsedNames',
      'isOffSiteHaul', 'offSiteHaulWork', 'haulWorkHours', 'weekStartOf', 'weekEndOf',
      'stampKey', 'compareIds', 'byEntryOrder', 'timeOffPayHours', 'timeOffCell',
      'weeklyOvertime', 'detailColumnsRowHtml', 'weekBandHtml', 'reportDetailHtml',
      'buildReportModel', 'renderReport'];

    const entries = [
      day('2026-09-14', { computed_hours: 9.25 }),
      day('2026-09-15'),
      day('2026-09-16', { computed_hours: 7.75 }),
      off('2026-09-17'),
      off('2026-09-18'),
    ];
    const api = new Function('document', 'filtered', 'user', 'expandedReportUsers', 'loadedScope', `
      const OT_WEEKLY_THRESHOLD = 40;
      const PAID_LEAVE_HOURS = ${PAID_LEAVE_HOURS};
      ${FULL_SRC}
      ${DETAIL_COLS_SRC}
      ${FNS.map(n => requireFn(PAGE, n, 'payroll.html')).join('\n')}
      return { renderReport, buildReportModel };
    `)(dom.window.document, entries, { companyName: 'Force Corp' },
       new Set(['boringjamey']), { from: FROM, to: TO, division: '' });

    const model = api.buildReportModel();
    // The page's totals carry the hours worked as pending + approved, the way
    // its Total column reads them — the same 25.00 the module reports.
    const worked = model.tot.pendingHours + model.tot.approvedHours;
    assert('the page reaches the same figures the module does',
      near(model.tot.offHours, 16) && near(worked, 25),
      `${model.tot.offHours} / ${worked}`);

    api.renderReport();
    const doc = dom.window.document;
    const heads = [...doc.querySelectorAll('.report > .report-scroll > table > thead th')]
      .map(th => th.textContent.replace(/\s+/g, ' ').trim());
    assert('the report has a Time Off Hrs column and a Total Paid beside it',
      heads[14] === 'Time Off Hrs' && heads[15] === 'Total Paid', JSON.stringify(heads.slice(13)));

    const cellsOf = sel => [...doc.querySelectorAll(sel)].map(td => td.textContent.trim());
    const body = cellsOf('.report > .report-scroll > table > tbody > tr.emp-row > td');
    assert('  the man\'s row shows the sixteen hours of leave',
      body[14] === '16.00', body[14]);
    assert('  and 41.00 as the hours he is paid for',
      body[15] === '41.00', body[15]);
    assert('  while Total beside them is still the 25.00 he worked',
      body[6] === '25.00', body[6]);

    const foot = cellsOf('.report > .report-scroll > table > tfoot > tr.total > td');
    assert('the totals row carries both figures too',
      foot[14] === '16.00' && foot[15] === '41.00', `${foot[14]} / ${foot[15]}`);

    // The expanded breakdown. A vacation row used to be a line of dashes; the
    // one column that can carry its pay is Total, and it has to.
    const detail = [...doc.querySelectorAll('.report-detail-table > tbody > tr')]
      .filter(tr => /Time Off/.test(tr.textContent));
    assert('each approved day off shows its 8.00 in the detail',
      detail.length === 2 && detail.every(tr => /(^|\s)8\.00(\s|$)/.test(
        tr.children[8].textContent.trim())),
      detail.map(tr => tr.children[8].textContent.trim()).join(' | '));

    const totalRow = doc.querySelector('.report-detail-table tr.detail-total');
    assert('  and the breakdown\'s own total says how much of it was leave',
      /incl\. 16\.00 h paid leave/.test(totalRow.textContent), totalRow.textContent.trim());
  }
}

// ── The executive report reads the same numbers ─────────────────────────────
console.log('\n[the executive report carries it through]');
{
  assert('the API hands the rows their leave and their paid total',
    /offHours:\s+e\.offHours/.test(API) && /totalPaidHours:\s+e\.totalPaidHours/.test(API));
  assert('  and the totals row as well',
    /offHours:\s+t\.offHours/.test(API) && /totalPaidHours:\s+t\.totalPaidHours/.test(API));
  assert('  and the strip names the hours the check is cut for',
    /label: 'Total Paid Hrs'/.test(API));
  assert('the executive table reads offHours, not a count of requests',
    /r\.offHours/.test(EXEC) && !/\$\{r\.pendingOff\} pending \/ \$\{r\.approvedOff\} approved/.test(EXEC));
  assert('  and shows Total Paid beside it',
    /r\.totalPaidHours/.test(EXEC));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
