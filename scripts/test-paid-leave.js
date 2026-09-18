#!/usr/bin/env node
'use strict';
/**
 * An approved day off is paid for the hours it says, and they are NOT hours worked.
 *
 * Run: node scripts/test-paid-leave.js
 *
 * HALF DAYS HAPPEN. A man takes the morning for an appointment and works the
 * afternoon, and the four hours he is owed are four. The entry carries the
 * figure now — time_off_hours — and PAID_LEAVE_HOURS is what a day off means
 * when nobody narrowed it: a full one.
 *
 * The fallback is the load-bearing half of that. Every time-off row approved
 * before the column existed holds NULL, and NULL has to keep paying the eight
 * hours it always did — no fortnight may change its numbers on deploy. Which
 * means the failure mode is silent in BOTH directions and neither looks wrong:
 * a reader that forgets the column pays every half day as a whole one, and a
 * reader that treats an unparseable value as zero pays nothing for a day the
 * office signed off.
 *
 * Before any of this the payroll report said nothing about leave at all: a
 * fortnight with two approved vacation days read 25.00 hours across every
 * column, and the sixteen hours the man was owed lived in whoever remembered
 * them. That is what this file exists to prevent coming back.
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
  payrollMetrics, timeOffPayHours, leaveHoursOf, PAID_LEAVE_HOURS, MAX_LEAVE_HOURS,
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

// A day off. Approved unless the case under test is about approval, and with
// NO time_off_hours unless the case is about length — which is deliberately the
// default, because that is the shape of every row that predates the column.
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

// ── The length the entry itself carries ─────────────────────────────────────
console.log('\n[how long the day off was is the entry\'s answer, not a constant]');
{
  const paid = (h, over = {}) => timeOffPayHours(off('2026-09-17', Object.assign({ time_off_hours: h }, over)));

  assert('a HALF day pays four', paid(4) === 4);
  assert('  and any other length pays exactly what it says',
    paid(6) === 6 && paid(2) === 2 && paid(7.5) === 7.5);
  assert('a full day still pays eight', paid(8) === 8);

  // The distinction the nullable column exists to keep. Both of these are
  // "8 paid hours" and they are NOT the same fact: one is an answer, the other
  // is the absence of one, and only the second may ever be re-read as something
  // else later.
  assert('an entry that says nothing is a FULL day — every row filed before the column existed',
    timeOffPayHours(off('2026-09-17')) === PAID_LEAVE_HOURS);
  assert('  and so is one that says nothing in the older shape, with the key absent entirely',
    timeOffPayHours({ entry_type: 'time_off', status: 'approved', work_date: '2026-09-17' }) === 8);

  // Zero is somebody's answer, not the absence of one.
  assert('ZERO is an unpaid day off, and survives as one', paid(0) === 0);
  assert('  which is not the same as saying nothing — that is still a full day',
    paid(0) !== timeOffPayHours(off('2026-09-17')));

  // The same judgement offSiteHaulWork makes: an unreadable figure is not a
  // zero. Reading it as one would pay a man nothing for a day the office
  // signed off, on the strength of a value nobody can parse.
  assert('an unreadable length falls back to a full day, never to nothing',
    paid('abc') === 8 && paid(NaN) === 8 && paid(Infinity) === 8, 'unreadable must not pay 0');
  assert('  and so does a negative, because there is no such day',
    paid(-4) === 8);
  // A numeric string is what a JSON round-trip through a NUMERIC column gives.
  assert('a numeric string is a number — NUMERIC comes back as text from some drivers',
    paid('4') === 4 && paid('7.50') === 7.5);
  assert('one bad row cannot invent a week: a day is capped at 24 h',
    paid(900) === MAX_LEAVE_HOURS && MAX_LEAVE_HOURS === 24);
}

// ── What the queue is worth vs what is owed ─────────────────────────────────
console.log('\n[a pending half day is four hours of exposure, not eight]');
{
  const pendingHalf = off('2026-09-17', { status: 'submitted', time_off_hours: 4 });
  assert('it pays nothing until somebody approves it', timeOffPayHours(pendingHalf) === 0);
  assert('  but it ASKS for four, and the queue is measured in what it asks for',
    leaveHoursOf(pendingHalf) === 4);
  assert('leaveHoursOf ignores approval entirely — that is the caller\'s question',
    leaveHoursOf(off('2026-09-17', { status: 'draft', time_off_hours: 6 })) === 6);
  assert('  and it is still 0 for a day worked',
    leaveHoursOf(day('2026-09-14')) === 0);
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

// ── A fortnight of mixed lengths ────────────────────────────────────────────
console.log('\n[a week of full days, half days and one that says nothing]');
{
  const t = run([
    day('2026-09-14', { computed_hours: 8 }),
    off('2026-09-15', { time_off_hours: 4 }),                    // half day
    off('2026-09-16', { time_off_hours: 4, time_off_type: 'sick' }),
    off('2026-09-17'),                                            // says nothing → 8
    off('2026-09-18', { time_off_hours: 0 }),                    // unpaid
  ]);
  assert('the hours worked are the one day worked', near(t.totalHours, 8));
  assert('the leave adds up day by day — 4 + 4 + 8 + 0',
    near(t.offHours, 16), String(t.offHours));
  assert('  four approved days off, whatever their lengths',
    t.approvedOff === 4, String(t.approvedOff));
  assert('  and the unpaid one is still a day off, counted and worth nothing',
    t.approvedOff === 4 && near(t.offHours, 16));
  assert('the check is cut for 24.00', near(t.totalPaidHours, 24));
  assert('and none of it moved the 40', near(t.otHours, 0) && near(t.regHours, 8));

  // The whole point of the change. Under the old flat rule this same fortnight
  // reported 32.00 hours of leave — sixteen hours the company does not owe.
  assert('the old flat rule would have paid 32.00; the entries say 16.00',
    near(t.offHours, 16) && t.approvedOff * PAID_LEAVE_HOURS === 32);
}

// ── Pending leave is named, never paid ──────────────────────────────────────
console.log('\n[what the approval queue is worth is not what is owed]');
{
  const t = run([
    day('2026-09-14'),
    off('2026-09-15'),
    off('2026-09-16', { status: 'submitted' }),                     // says nothing → asks 8
    off('2026-09-17', { status: 'submitted', time_off_hours: 4 }),  // asks 4
  ]);
  assert('only the approved day is paid', near(t.offHours, 8), String(t.offHours));
  assert('  the two pending days are carried separately, at the hours they ASK for',
    near(t.pendingOffHours, 12), String(t.pendingOffHours));
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
    const MAX_LEAVE_HOURS = ${MAX_LEAVE_HOURS};
    ${requireFn(PAGE, 'leaveHoursOf',    'payroll.html')}
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
      'stampKey', 'compareIds', 'byEntryOrder',
      'timeOffPayHours', 'leaveHoursOf', 'offDayTitle', 'timeOffCell',
      'weeklyOvertime', 'detailColumnsRowHtml', 'weekBandHtml', 'reportDetailHtml',
      'buildReportModel', 'renderReport'];

    // A full day that says nothing, and a half day that does — so the rendered
    // sheet is checked carrying BOTH readings at once, which is the shape a
    // real fortnight has while the column is still filling in.
    const entries = [
      day('2026-09-14', { computed_hours: 9.25 }),
      day('2026-09-15'),
      day('2026-09-16', { computed_hours: 7.75 }),
      off('2026-09-17'),
      off('2026-09-18', { time_off_hours: 4 }),
    ];
    const api = new Function('document', 'filtered', 'user', 'expandedReportUsers', 'loadedScope', `
      const OT_WEEKLY_THRESHOLD = 40;
      const PAID_LEAVE_HOURS = ${PAID_LEAVE_HOURS};
      const MAX_LEAVE_HOURS = ${MAX_LEAVE_HOURS};
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
      near(model.tot.offHours, 12) && near(worked, 25),
      `${model.tot.offHours} / ${worked}`);
    // And agrees with the module on the same entries, which is the whole reason
    // the rule is written twice and then checked against itself.
    assert('  and the module agrees, on the same entries',
      near(payrollMetrics({ entries, periodStart: FROM, periodEnd: TO }).totals.offHours, 12));

    api.renderReport();
    const doc = dom.window.document;
    const heads = [...doc.querySelectorAll('.report > .report-scroll > table > thead th')]
      .map(th => th.textContent.replace(/\s+/g, ' ').trim());
    assert('the report has a Time Off Hrs column and a Total Paid beside it',
      heads[14] === 'Time Off Hrs' && heads[15] === 'Total Paid', JSON.stringify(heads.slice(13)));

    const cellsOf = sel => [...doc.querySelectorAll(sel)].map(td => td.textContent.trim());
    const body = cellsOf('.report > .report-scroll > table > tbody > tr.emp-row > td');
    assert('  the man\'s row shows the twelve hours of leave — a full day and a half',
      body[14] === '12.00', body[14]);
    assert('  and 37.00 as the hours he is paid for',
      body[15] === '37.00', body[15]);
    assert('  while Total beside them is still the 25.00 he worked',
      body[6] === '25.00', body[6]);

    const foot = cellsOf('.report > .report-scroll > table > tfoot > tr.total > td');
    assert('the totals row carries both figures too',
      foot[14] === '12.00' && foot[15] === '37.00', `${foot[14]} / ${foot[15]}`);

    // The summary cell must never multiply a day count by eight — from a total
    // and a count there is no telling 4 + 8 from 6 + 6.
    const offCell = doc.querySelector('.report > .report-scroll > table > tbody > tr.emp-row > td:nth-child(15)');
    assert('the Time Off tooltip states the total and claims no per-day figure',
      /12\.00 h in all/.test(offCell.getAttribute('title') || '')
      && !/h each/.test(offCell.getAttribute('title') || ''),
      offCell.getAttribute('title'));

    // The expanded breakdown. A vacation row used to be a line of dashes; the
    // one column that can carry its pay is Total, and it has to.
    const detail = [...doc.querySelectorAll('.report-detail-table > tbody > tr')]
      .filter(tr => /Time Off/.test(tr.textContent));
    const detailHours = detail.map(tr => tr.children[8].textContent.trim());
    assert('each day off shows its OWN hours in the detail, not a flat eight',
      JSON.stringify(detailHours) === JSON.stringify(['8.00', '4.00']),
      JSON.stringify(detailHours));
    // Where 8.00 came from has to be sayable: it is a rule, not something on
    // the row, and an approver hunting for it will not find it on the entry.
    assert('  the full day says its figure came from the entry not saying',
      /does not say how long/.test(detail[0].children[8].getAttribute('title') || ''),
      detail[0].children[8].getAttribute('title'));
    assert('  while the half day simply states what it paid',
      !/does not say how long/.test(detail[1].children[8].getAttribute('title') || '')
      && /4\.00 h paid/.test(detail[1].children[8].getAttribute('title') || ''),
      detail[1].children[8].getAttribute('title'));

    // An approved day of ZERO hours is somebody's answer — an unpaid day off —
    // and a pending day is the absence of one. They must not render alike, or
    // the sheet cannot tell a deliberate unpaid day from one nobody has signed.
    {
      const mixed = [
        off('2026-09-15', { time_off_hours: 0, time_off_type: 'sick' }),
        off('2026-09-16', { status: 'submitted', time_off_hours: 4 }),
      ];
      const d2 = new JSDOM(`<!doctype html><body>
        <input id="flt-from" value="${FROM}"><input id="flt-to" value="${TO}">
        <select id="flt-division"><option value="" selected></option></select>
        <input id="flt-user" value=""><input id="flt-supervisor" value="">
        <div id="reportWrap"></div></body>`);
      const a2 = new Function('document', 'filtered', 'user', 'expandedReportUsers', 'loadedScope', `
        const OT_WEEKLY_THRESHOLD = 40;
        const PAID_LEAVE_HOURS = ${PAID_LEAVE_HOURS};
        const MAX_LEAVE_HOURS = ${MAX_LEAVE_HOURS};
        ${FULL_SRC}
        ${DETAIL_COLS_SRC}
        ${FNS.map(n => requireFn(PAGE, n, 'payroll.html')).join('\n')}
        return { renderReport };
      `)(d2.window.document, mixed, { companyName: 'Force Corp' },
         new Set(['boringjamey']), { from: FROM, to: TO, division: '' });
      a2.renderReport();
      const rows = [...d2.window.document.querySelectorAll('.report-detail-table > tbody > tr')]
        .filter(tr => /Time Off/.test(tr.textContent))
        .map(tr => tr.children[8].textContent.trim());
      assert('an approved UNPAID day shows 0.00, and a pending day shows a dash',
        JSON.stringify(rows) === JSON.stringify(['0.00', '—']), JSON.stringify(rows));
    }

    const totalRow = doc.querySelector('.report-detail-table tr.detail-total');
    assert('  and the breakdown\'s own total says how much of it was leave',
      /incl\. 12\.00 h paid leave/.test(totalRow.textContent), totalRow.textContent.trim());
  }
}

// ── The API is what decides what reaches the column ─────────────────────────
// A half day that never gets stored is a half day paid as a whole one, so the
// write path is as load-bearing as the arithmetic.
console.log('\n[the API stores what the form asked for, and refuses what it cannot use]');
{
  const { normalizeEntryBody } = require(path.resolve(__dirname, '../api/timesheet-entries.js'))._test;
  const post = over => normalizeEntryBody(Object.assign({
    entry_type: 'time_off', work_date: '2026-09-17', time_off_type: 'vacation',
    supervisor_id: 3, supervisor_name: 'Strick',
  }, over));

  assert('a half day is stored as four', post({ time_off_hours: 4 }).data.time_off_hours === 4);
  assert('  a decimal survives to the hundredth, as the NUMERIC(6,2) column holds it',
    post({ time_off_hours: 7.256 }).data.time_off_hours === 7.26);
  assert('  zero is stored as zero, not dropped — an unpaid day off is an answer',
    post({ time_off_hours: 0 }).data.time_off_hours === 0);
  // Absent stays absent. Defaulting it to 8 here would write an answer nobody
  // gave and make "nobody said" untellable from "somebody said eight".
  assert('an absent answer is stored as null, never as 8',
    post({}).data.time_off_hours === null
    && post({ time_off_hours: null }).data.time_off_hours === null
    && post({ time_off_hours: '' }).data.time_off_hours === null);

  // Deliberately NOT safeHours, which turns anything it cannot use into null.
  // Null here is not "no answer", it is a specific one — a full paid day — so a
  // fat-fingered 88 would be silently paid as eight hours.
  for (const bad of [88, -1, 'abc', NaN, Infinity]) {
    assert(`  ${JSON.stringify(bad)} is an ERROR, not a quiet fall back to a full day`,
      !!post({ time_off_hours: bad }).error, JSON.stringify(post({ time_off_hours: bad })));
  }

  assert('a DAILY entry nulls it, so switching an entry away from time off clears it',
    normalizeEntryBody({
      entry_type: 'daily', work_date: '2026-09-14', division: 'quarry',
      job_id: 'j1', job_label: 'Homer City', start_time: '07:00', end_time: '15:00',
      supervisor_id: 3, supervisor_name: 'Strick', lunch_break: false,
    }).data.time_off_hours === null);

  // The column has to be in the INSERT and the UPDATE, or the form's answer is
  // validated and then thrown away.
  const API = fs.readFileSync(path.join(ROOT, 'api/timesheet-entries.js'), 'utf8');
  assert('the INSERT names the column and binds it',
    /INSERT INTO timesheet_entries[\s\S]*?\btime_off_hours\b[\s\S]*?VALUES/.test(API)
    && /\$\{data\.time_off_hours\}/.test(API));
  assert('the UPDATE writes it', /time_off_hours\s*=\s*\$\{data\.time_off_hours\}/.test(API));
  assert('and the row mapper sends it to the browser as a number or null, never 0',
    /time_off_hours:\s*r\.time_off_hours != null \? Number\(r\.time_off_hours\) : null/.test(API));
}

// ── Every consumer must be FED the column ───────────────────────────────────
// The silent one. A SELECT that forgets it does not error and does not report
// zero — every row arrives looking un-narrowed, which reads as a full day, so a
// crew of half days is reported at double what it is owed.
console.log('\n[every reader of the timesheet table selects the column]');
{
  const consumers = [
    'api/executive/report.js',
    'api/lib/mathis-digests.js',
  ];
  for (const rel of consumers) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/^\s*--.*$/gm, '')             // SQL comments, which discuss the column
      .replace(/(^|[^:])\/\/.*$/gm, '$1');    // JS comments, same
    const lists = [...src.matchAll(/SELECT((?:(?!\bFROM\b)[\s\S])*?)\bFROM\s+timesheet_entries/gi)]
      .map(m => m[1]);
    assert(`  ${rel} selects from timesheet_entries`, lists.length > 0);
    assert(`  ${rel} passes time_off_hours through`,
      lists.some(c => /\*/.test(c) || /\btime_off_hours\b/.test(c)),
      lists.map(c => c.replace(/\s+/g, ' ').trim().slice(0, 100)).join(' || '));
  }
}

// ── The field crew has to be able to say it ─────────────────────────────────
console.log('\n[the timesheet form asks how long the day off is]');
{
  const TS = fs.readFileSync(path.join(ROOT, 'timesheet.html'), 'utf8');
  assert('the time-off form carries a length control',
    /id="seg-off-len"/.test(TS) && /setOffLen\('half'\)/.test(TS));
  assert('  with a full day and a half day as the two named answers',
    /OFF_LEN_HOURS = \{ full: 8, half: 4 \}/.test(TS));
  assert('  and an Other box for the lengths in between',
    /id="f-off-hours"/.test(TS) && /setOffLen\('other'\)/.test(TS));
  assert('the payload always sends the hours, so a half day cannot be filed as a whole one',
    /time_off_hours: len\.hours/.test(TS));
  assert('  and the form validates the box before sending it',
    /function offHoursValue\(\)/.test(TS) && /between 0 and 24/.test(TS));

  // Loading a saved draft must agree with the sheet about what it says.
  assert('a saved draft reopens on the length it was saved with',
    /savedOff === OFF_LEN_HOURS\.half/.test(TS) && /setOffLen\('other', false\)/.test(TS));

  // And payroll must be able to correct one.
  const PAY = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
  assert('the payroll edit modal can correct the hours',
    /id="em-off-hours"/.test(PAY) && /time_off_hours: offHrs/.test(PAY));
  assert('  and leaves the box EMPTY for an entry that never said, rather than prefilling 8',
    /e\.time_off_hours == null \? '' : String\(Number\(e\.time_off_hours\)\)/.test(PAY));
  assert('the audit trail records the figure, so a changed half day is traceable',
    /'Time Off Paid Hours'/.test(PAY) && /snap\.time_off_hours/.test(PAY));
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
