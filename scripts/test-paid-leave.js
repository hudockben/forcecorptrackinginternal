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

/** A top-level `const` array/object lifted from a page, marker to marker. */
function sliceConst(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`could not find ${start}`);
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error(`could not close ${start}`);
  return src.slice(a, b + end.length);
}

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
  // Every shape a row arrives in — INCLUDING ones that carry the column. Without
  // those the two copies were only ever compared on entries that say nothing,
  // which is the one input where a copy that ignored time_off_hours entirely
  // would still agree.
  const cases = [
    off('2026-09-17'),
    off('2026-09-17', { status: 'submitted' }),
    off('2026-09-17', { status: 'draft' }),
    off('2026-09-17', { time_off_type: 'holiday' }),
    off('2026-09-17', { time_off_hours: 4 }),
    off('2026-09-17', { time_off_hours: 0 }),
    off('2026-09-17', { time_off_hours: 7.5 }),
    off('2026-09-17', { time_off_hours: '4' }),
    off('2026-09-17', { time_off_hours: 'abc' }),
    off('2026-09-17', { time_off_hours: -2 }),
    off('2026-09-17', { time_off_hours: 900 }),
    off('2026-09-17', { status: 'submitted', time_off_hours: 4 }),
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
      // The lunch pill's "No" names whichever job of a split day took the
      // break, so reportDetailHtml reaches the review grid's holder lookup.
      'lunchHolders', 'lunchNoTitle',
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
      // lunchHolders() reads the page's full result set to find which job of a
      // split day carries the break. These fixtures have no split days, so an
      // empty one is the honest stub: every row's pill falls to "No lunch
      // break taken", exactly as it did before the lookup existed.
      const allEntries = [];
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
  // Whitespace is nobody saying, not somebody saying zero. Number('  ') is 0,
  // finite and in range, so an untrimmed guard stored a box full of spaces as
  // an UNPAID day off — the one conversion the whole branch exists to prevent.
  assert('a box holding only whitespace is NOT an unpaid day — it is no answer',
    post({ time_off_hours: '  ' }).data.time_off_hours === null
    && post({ time_off_hours: '\t' }).data.time_off_hours === null,
    String(post({ time_off_hours: '  ' }).data.time_off_hours));
  assert('  and a padded number is still that number',
    post({ time_off_hours: ' 4 ' }).data.time_off_hours === 4);

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

  // Sliced to the INSERT, and then to its two halves. Checked against the WHOLE
  // file, the binding half of this passed on the UPDATE's own
  // `time_off_hours = ${data.time_off_hours}` further down — so the INSERT's
  // VALUES entry could be replaced with a literal NULL and nothing failed. Every
  // new entry would file as "nobody said", every half day would pay eight, and
  // the guard on the write path would report itself green. Verified by making
  // that exact edit and watching this fail.
  const insertStart = API.indexOf('INSERT INTO timesheet_entries');
  const insert = API.slice(insertStart, API.indexOf('RETURNING *', insertStart));
  const [cols, vals] = insert.split(/\bVALUES\b/);
  assert('the INSERT is sliced, and has both halves', !!cols && !!vals);
  assert('  its column list names time_off_hours', /\btime_off_hours\b/.test(cols));
  assert('  and its VALUES list binds the value, not a literal',
    /\$\{data\.time_off_hours\}/.test(vals), vals.slice(0, 200));
  // The column list and the VALUES list must also still be the same length, or
  // every column right of the break is bound to its neighbour's value.
  assert('  and the two lists are still the same length',
    (cols.match(/,/g) || []).length === (vals.match(/,/g) || []).length,
    `${(cols.match(/,/g) || []).length} vs ${(vals.match(/,/g) || []).length}`);
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

  // "Other" seeds the box from the answer being LEFT, not from a constant. Read
  // after offLen is reassigned it is always 'other', so the seed could only be a
  // full day: a man who picked Half day and then tapped Other to adjust it found
  // 8 in the box, and submitting without typing — the numeric keypad covers the
  // field on a phone — filed a whole paid day on an entry he had already told
  // the form was half of one. Four hours of pay, from a default.
  assert('"Other" seeds from the answer being left, not always a full day',
    /const prev = offLen;/.test(TS)
    && /OFF_LEN_HOURS\[prev\] != null \? OFF_LEN_HOURS\[prev\] : OFF_LEN_HOURS\.full/.test(TS));

  // The control's default lives in a variable, not in the markup, so something
  // has to light it. resetForm() is not called at load, so without this the
  // first time-off request after opening the page showed three muted segments —
  // the look the page uses for a question NOBODY HAS ANSWERED, over a control
  // that is answered and will file a full day.
  assert('the control is painted at page load, not left looking unanswered',
    /async function init\(\)[\s\S]{0,900}?renderOffLen\(\);/.test(TS));

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

// ── The audit CSV lines up, column for column ───────────────────────────────
// A reconciliation export is worth nothing if its header and its rows disagree
// about how many columns there are: one extra cell in the row array shifts
// every figure right of it under the wrong heading, and the file still opens
// cleanly in Excel. This change edited BOTH arrays, and nothing executed either
// — so it is executed here, against the page's own source.
console.log('\n[the audit CSV header and row still describe the same columns]');
{
  const PAY = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
  const csv = new Function(`
    ${sliceConst(PAY, '    const CSV_HEADERS = [', '];')}
    ${requireFn(PAY, 'csvEscape',       'payroll.html')}
    ${requireFn(PAY, 'yn',              'payroll.html')}
    ${requireFn(PAY, 'equipUsedPieces', 'payroll.html')}
    ${requireFn(PAY, 'equipUsedNames',  'payroll.html')}
    ${requireFn(PAY, 'buildAuditCsv',   'payroll.html')}
    return { CSV_HEADERS, buildAuditCsv };
  `)();

  const ev = (snap, over = {}) => Object.assign({
    id: 1, created_at: '2026-09-18T12:00:00Z', action: 'UPDATE', entry_id: 9,
    username: 'office', user_id: 42, changes: null, snapshot: snap,
  }, over);

  // A half day, an entry that says nothing, and a day worked — the three row
  // shapes the export has to line up identically.
  const out = csv.buildAuditCsv([
    ev({ username: 'boringjamey', status: 'approved', work_date: '2026-09-18',
         entry_type: 'time_off', time_off_type: 'vacation', time_off_hours: 4 }),
    ev({ username: 'boringjamey', status: 'approved', work_date: '2026-09-17',
         entry_type: 'time_off', time_off_type: 'vacation' }),
    ev({ username: 'boringjamey', status: 'approved', work_date: '2026-09-16',
         entry_type: 'daily', division: 'quarry', job_label: 'Homer City',
         computed_hours: 8, travel_hours: 0 }),
  ]);

  // Split on commas OUTSIDE quotes, the way a CSV reader does — walked
  // character by character rather than matched with a regex, because a regex
  // that finds fields silently loses a TRAILING EMPTY one (every row here ends
  // with an empty Changes column), and a parser that miscounts by one is
  // exactly the bug this block is here to detect.
  const cells = line => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const lines = out.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  const head  = cells(lines[0]);

  assert('the header is the page\'s own CSV_HEADERS', head.length === csv.CSV_HEADERS.length,
    `${head.length} vs ${csv.CSV_HEADERS.length}`);
  assert('  and every data row has exactly as many cells as the header',
    lines.slice(1).every(l => cells(l).length === head.length),
    lines.slice(1).map(l => cells(l).length).join(', '));

  const col = name => head.indexOf(name);
  assert('  the paid-hours column exists and is named', col('Time Off Paid Hours') > -1);
  const rows = lines.slice(1).map(cells);
  assert('  a half day records 4.00 under it',
    rows[0][col('Time Off Paid Hours')] === '4.00', rows[0][col('Time Off Paid Hours')]);
  // Blank, not 8.00. Writing the fallback here would record an answer nobody
  // gave, in the one file whose job is to say who said what.
  assert('  an entry that never said records BLANK, not the 8.00 it pays',
    rows[1][col('Time Off Paid Hours')] === '', JSON.stringify(rows[1][col('Time Off Paid Hours')]));
  assert('  and a day WORKED records blank too', rows[2][col('Time Off Paid Hours')] === '');
  // The column right of it must still be Notes, or everything shifted.
  assert('  the columns after it did not shift',
    head[col('Time Off Paid Hours') + 1] === 'Notes'
    && head[head.length - 1] === 'Changes (JSON)', head.slice(-3).join(' | '));
}

// ── An unpaid day off is a day off ──────────────────────────────────────────
// The trap this change opened. While every day off paid eight, "did he take
// leave" and "do his leave hours sum above zero" were the same question, and a
// lot of code asked the second one. Zero broke the equivalence: an approved
// UNPAID day is a day the office signed off, and a surface that reports it as
// no time off at all is denying a fact its own neighbouring rows assert.
console.log('\n[an approved day of ZERO hours still happened]');
{
  const PAY = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
  const cell = new Function(`
    const PAID_LEAVE_HOURS = ${PAID_LEAVE_HOURS};
    ${requireFn(PAY, 'escapeHtml',  'payroll.html')}
    ${requireFn(PAY, 'timeOffCell', 'payroll.html')}
    return timeOffCell;
  `)();

  const none    = cell({ approvedOff: 0, pendingOff: 0, offHours: 0, pendingOffHours: 0 });
  const unpaid  = cell({ approvedOff: 1, pendingOff: 0, offHours: 0, pendingOffHours: 0 });
  const pending = cell({ approvedOff: 0, pendingOff: 1, offHours: 0, pendingOffHours: 0 });

  assert('a man who took no leave reads as none', none.text === '&mdash;');
  assert('an approved UNPAID day does NOT read as none',
    unpaid.text !== none.text && !/No time off/.test(unpaid.title), JSON.stringify(unpaid));
  assert('  it reads 0.00, and names the day',
    unpaid.text === '0.00' && /1 day off, approved/.test(unpaid.title), JSON.stringify(unpaid));
  assert('  and a pending zero-hour request is named too, not erased',
    pending.text === '0.00' && /1 day still pending/.test(pending.title), JSON.stringify(pending));

  // The guard must read the COUNTS. Keyed on the hours it is the same bug again
  // the next time somebody adds a figure that can legitimately be zero.
  assert('the guard is keyed on the requests, not on their hours',
    /if \(!r\.approvedOff && !r\.pendingOff\)/.test(PAY));

  // executive.html never had the guard, so the two surfaces disagreed. They are
  // documented as mirrors; check they now agree on this exact case.
  assert('and the executive table, which mirrors it, agrees',
    /r\.offHours > 0\.001 \? 'tone-teal' : 'v-mute'/.test(EXEC)
    && /\$\{days\(r\.approvedOff\)\} off, approved/.test(EXEC));

  // The strip tile beside it had the same shape of bug, keyed on the sum.
  assert('the executive strip keys its leave caption on the day count too',
    /tone: t\.approvedOff \? 'teal' : 'mute'/.test(API)
    && /sub: t\.approvedOff/.test(API));
}

// ── The comments are the authority on the rule ──────────────────────────────
// This repository's convention is that the comment above a rule is where the
// rule is stated; a stale one sends the next maintainer back to the flat
// multiple this change exists to remove.
console.log('\n[no comment still claims every day off is eight hours]');
{
  const PAY = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
  const PM  = fs.readFileSync(path.join(ROOT, 'api/lib/payroll-metrics.js'), 'utf8');
  for (const [name, src] of [['payroll.html', PAY], ['payroll-metrics.js', PM]]) {
    assert(`  ${name} does not describe offHours as PAID_LEAVE_HOURS per day`,
      !/hours are PAID_LEAVE_HOURS apiece/.test(src));
    assert(`  ${name} does not call an approved day off "a full eight hours"`,
      !/approved day off pays: a full eight hours/.test(src));
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

  // The assistant is asked "did he take any time off", which is a question
  // about DAYS. Answered from offHours alone, an approved unpaid day reads as
  // none — the crew totals carried the counts all along, the per-person list
  // did not, and per person is where the question is actually asked.
  const DIG = fs.readFileSync(path.join(ROOT, 'api/lib/mathis-digests.js'), 'utf8');
  assert('the digest sends the day COUNTS per employee, not only the hours',
    /approvedOff:\s+e\.approvedOff/.test(DIG) && /pendingOff:\s+e\.pendingOff/.test(DIG));
  assert('  and says outright that 0.00 hours is not the same as no leave',
    /OFFHOURS OF 0\.00 DOES NOT MEAN NO LEAVE/.test(DIG));
  assert('the executive table reads offHours, not a count of requests',
    /r\.offHours/.test(EXEC) && !/\$\{r\.pendingOff\} pending \/ \$\{r\.approvedOff\} approved/.test(EXEC));
  assert('  and shows Total Paid beside it',
    /r\.totalPaidHours/.test(EXEC));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
