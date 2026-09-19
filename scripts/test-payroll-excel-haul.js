#!/usr/bin/env node
'use strict';
/**
 * The payroll workbook's labour/haul split.
 *
 * Run: node scripts/test-payroll-excel-haul.js
 *
 * A day's work hours used to land in the export as one figure, and a driver's
 * day looked exactly like a paver's: 11.00 in the Work column either way. But
 * one of those men put down asphalt for eleven hours and the other drove a
 * lowboy, and a production rate measured against the second is not a rate at
 * all — the hours are real, the output is somebody else's.
 *
 * So the export splits them. Work Hours is labour on the job, Haul Hours is the
 * same day's time in the truck, and the two still add up to the hours worked.
 * Nothing is created or destroyed here either: what this file pins down is that
 * the sheets keep adding up after the split.
 *
 * Note which haul counts. The prevailing columns ask which hours lose the
 * premium and ignore an on-site haul, because a man hauling inside the fence is
 * on the covered site and keeps it. The Haul column asks what he was DOING, and
 * that is driving on either haul. The two splits are different questions on the
 * same day, and both are on the sheet.
 */

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const PAGE = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');

let JSDOM;
try { ({ JSDOM } = require(path.join(ROOT, 'node_modules/jsdom'))); }
catch { console.log('jsdom not installed — skipping export checks'); process.exit(0); }

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// ── The page's own export, lifted whole ─────────────────────────────────────
// Re-stating the sheet builders here would test a copy. Every function the two
// builders reach, including the ones their callees reach.
const FNS = ['prettyDiv', 'prettyOff', 'isOffSiteHaul', 'offSiteHaulWork', 'haulWorkHours',
  'weekStartOf', 'weekEndOf', 'stampKey', 'compareIds', 'byEntryOrder', 'weeklyOvertime',
  'buildReportModel', 'colLetter', 'excelDateSerial', 'xmlEsc', 'xlsxRow', 'xlsxSheetXml',
  // The detail sheet carries a column of the machines the operator named.
  'equipUsedPieces', 'equipUsedNames',
  // And what an approved day off pays, which is the only figure on such a row —
  // read off the entry now that half days can be filed, so its reader comes too.
  'timeOffPayHours', 'leaveHoursOf',
  'reportSummarySheetXml', 'reportDetailSheetXml'];
// XS and the cell shorthands are consts, not functions — taken as a slice,
// along with the one constant weeklyOvertime reaches for.
const CONST_END = "const cNum = (v, s) => ({ t: 'n', v, s });";
const CONSTS = PAGE.slice(PAGE.indexOf('    const XS = {'),
  PAGE.indexOf(CONST_END) + CONST_END.length)
  + '\n' + PAGE.match(/const OT_WEEKLY_THRESHOLD = \d+;/)[0]
  + '\n' + PAGE.match(/const PAID_LEAVE_HOURS = \d+;/)[0]
  + '\n' + PAGE.match(/const MAX_LEAVE_HOURS = \d+;/)[0];

const dom = new JSDOM(`<!doctype html><body>
  <input id="flt-from" value="2026-08-31"><input id="flt-to" value="2026-09-13">
  <select id="flt-division"><option value="" selected></option></select>
  <input id="flt-user" value=""><input id="flt-supervisor" value=""></body>`);

// One fortnight, one man, with every shape a day's hauling answer arrives in.
const day = (work_date, computed_hours, over = {}) => Object.assign({
  id: work_date, username: 'beckerben', entry_type: 'daily', status: 'approved',
  division: 'turf', work_date, computed_hours, travel_hours: 0,
  job_label: 'Juniata College Baseball · 26053', prevailing_wage: false,
  haul_type: null, haul_hours: null, lunch_break: false, operated_equipment: false,
  created_at: work_date + 'T12:00:00Z',
}, over);

const ENTRIES = [
  // Plain labour — nobody called it a haul.
  day('2026-08-31', 10),
  // Hauled to & from site, whole day, split confirming it.
  day('2026-09-01', 11, { haul_type: 'off_site', haul_hours: 11 }),
  // Drove there, got out, worked the site: 6.50 in the truck, 2.50 on the job.
  day('2026-09-02', 9, { haul_type: 'off_site', haul_hours: 6.5, prevailing_wage: true }),
  // Hauled ON the site — driving, but the hours stay prevailing.
  day('2026-09-03', 8, { haul_type: 'on_site', haul_hours: 8, prevailing_wage: true }),
  // Answered as a haul, never split: the day-level answer is still the day.
  day('2026-09-04', 7, { haul_type: 'off_site', haul_hours: null }),
  // A haul day with travel on top of it.
  day('2026-09-08', 9, { haul_type: 'off_site', haul_hours: 9, travel_hours: 1.5,
                         travel_to_site_hours: 1, travel_to_shop_hours: 0.5 }),
  // Time off — no work hours at all, and never a haul. A HALF day: the old flat
  // rule would have paid it eight, so every figure below that reads 4.00 is
  // checking the entry's own answer reached the sheet.
  { id: 'off1', username: 'beckerben', entry_type: 'time_off', status: 'approved',
    work_date: '2026-09-09', time_off_type: 'vacation', time_off_hours: 4,
    created_at: '2026-09-09T12:00:00Z' },
];

const build = new Function('document', 'user', 'filtered', 'loadedScope',
  `${FNS.map(n => requireFn(PAGE, n, 'payroll.html')).join('\n')}
   ${CONSTS}
   return { buildReportModel, reportSummarySheetXml, reportDetailSheetXml };`);
const api = build(dom.window.document, { companyName: 'Force Corp' }, ENTRIES,
  { from: '2026-08-31', to: '2026-09-13', division: '' });
const model = api.buildReportModel();

// ── Reading a sheet back ────────────────────────────────────────────────────
// The XML the page emits, parsed the way Excel would read it: a value per cell
// reference, plus the style index, which is what carries the Haul tint.
function cells(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"(?: s="(\d+)")?(?: t="inlineStr")?\s*(?:\/>|>(.*?)<\/c>)/g)) {
    const inner = m[3] || '';
    const num = inner.match(/<v>(.*?)<\/v>/);
    const txt = inner.match(/<t[^>]*>(.*?)<\/t>/);
    out.set(m[1], { v: num ? Number(num[1]) : (txt ? txt[1] : null), s: Number(m[2] || 0) });
  }
  return out;
}
const val = (c, ref) => (c.get(ref) || {}).v;
const sty = (c, ref) => (c.get(ref) || {}).s;

const detail  = cells(api.reportDetailSheetXml(model));
const summary = cells(api.reportSummarySheetXml(model));
const XS = new Function(`${CONSTS} return XS;`)();

// ── Sheet 2: one row per submission ─────────────────────────────────────────
console.log('\n[the detail sheet splits the day into labour and driving]');
{
  const HDR = 6;                       // header row; entries start beneath it
  assert('the Work column says it is labour',
    val(detail, `H${HDR}`) === 'Work Hours (labour)', val(detail, `H${HDR}`));
  assert('and the new column beside it says it is driving',
    val(detail, `I${HDR}`) === 'Haul Hours (driving)', val(detail, `I${HDR}`));

  // Rows land in date order under the header.
  const row = n => HDR + n;
  const work = n => val(detail, `H${row(n)}`), haul = n => val(detail, `I${row(n)}`);
  const total = n => val(detail, `M${row(n)}`);   // Total Hours, two columns on

  assert('a day nobody called a haul is all labour',       work(1) === 10 && haul(1) === 0);
  assert('a day hauled to & from site is all driving',     work(2) === 0 && haul(2) === 11);
  assert('a day he drove there and then worked it splits', near(work(3), 2.5) && near(haul(3), 6.5));
  assert('an ON-SITE haul is driving too — it is the premium it keeps, not the wheel',
    work(4) === 0 && haul(4) === 8, `${work(4)} / ${haul(4)}`);
  assert('a haul nobody split is still the whole day',     work(5) === 0 && haul(5) === 7);
  assert('and travel is not part of either figure',
    work(6) === 0 && haul(6) === 9 && total(6) === 10.5);
  assert('time off posts neither', work(7) == null && haul(7) == null);
  // But it is NOT a blank row. An approved day off is a full paid day, and
  // Total Hours is the only column on this sheet that can carry it — the day
  // was not worked, so every other figure on the row is rightly empty.
  assert('  an approved day off still carries its pay in Total Hours',
    total(7) === 4, String(total(7)));
  assert('  at the length the ENTRY says, not a flat eight',
    total(7) !== 8, 'a half day reached the sheet as a whole one');
  assert('  and it is tinted, so paid leave is findable in a wide sheet',
    sty(detail, `M${row(7)}`) === XS.numOff, String(sty(detail, `M${row(7)}`)));

  // The point of the split: it moves hours between two columns and nowhere else.
  let ok = true;
  for (let n = 1; n <= 6; n++) {
    const e = ENTRIES[n - 1];
    if (!near(work(n) + haul(n), e.computed_hours)) ok = false;
    if (!near(work(n) + haul(n) + Number(e.travel_hours || 0), total(n))) ok = false;
  }
  assert('labour + haul = the hours worked, on every row, and + travel = the total', ok);

  const TOT = row(ENTRIES.length) + 1;            // the totals row, under the last entry
  assert('the totals row adds both columns up',
    near(val(detail, `H${TOT}`), 12.5) && near(val(detail, `I${TOT}`), 41.5),
    `${val(detail, `H${TOT}`)} / ${val(detail, `I${TOT}`)}`);
  // 55.50 worked over the fortnight, plus the one approved half day.
  assert('  and its Total is the hours PAID, leave included',
    near(val(detail, `M${TOT}`), 59.5), String(val(detail, `M${TOT}`)));
  assert('  and says so, rather than leaving the extra four unexplained',
    /incl\. 4\.00 h paid leave/.test(String(val(detail, `A${TOT}`))), String(val(detail, `A${TOT}`)));
  assert('and the haul figures are tinted, so the column is findable in a wide sheet',
    sty(detail, `I${row(2)}`) === XS.numHaul && sty(detail, `I${TOT}`) === XS.totHaul);
}

// ── Sheet 1: one row per employee ───────────────────────────────────────────
console.log('\n[the summary sheet splits the same way]');
{
  const HDR = 10;
  assert('its headers say the same thing',
    val(summary, `B${HDR}`) === 'Work Hours (labour)'
    && val(summary, `C${HDR}`) === 'Haul Hours (driving)');
  const r = model.rows[0];
  assert('the man hauled 41.50 h of his 54.00 h',
    near(r.truckHours, 41.5) && near(r.workHours, 54), `${r.workHours} / ${r.truckHours}`);
  assert('labour is what is left',   near(val(summary, `B${HDR + 1}`), 12.5));
  assert('driving is beside it',     near(val(summary, `C${HDR + 1}`), 41.5));
  assert('and the two still make the hours worked',
    near(val(summary, `B${HDR + 1}`) + val(summary, `C${HDR + 1}`), r.workHours));
  assert('Total Hours is unchanged — labour + haul + travel',
    near(val(summary, `G${HDR + 1}`), 55.5), val(summary, `G${HDR + 1}`));
  assert('the totals row carries the split too',
    near(val(summary, `B${HDR + 2}`), 12.5) && near(val(summary, `C${HDR + 2}`), 41.5));
  assert('and the haul total is tinted', sty(summary, `C${HDR + 2}`) === XS.totHaul);

  // The prevailing split is a DIFFERENT question, and the sheet keeps both.
  // Sep 2: 6.50 h hauled off site loses the premium, 2.50 h on the site keeps
  // it. Sep 3: 8.00 h hauled ON the site — all driving, all prevailing.
  assert('prevailing hours are untouched by the labour/haul split',
    near(val(summary, `J${HDR + 1}`), 10.5), val(summary, `J${HDR + 1}`));

  // Paid leave: the one figure on this sheet with no timesheet behind it. The
  // man took one approved HALF day in the fortnight, so he is owed four hours
  // nothing else on the row accounts for — and eight would be the old flat rule
  // still running.
  assert('the approved half day is four paid hours of its own',
    near(val(summary, `O${HDR + 1}`), 4), val(summary, `O${HDR + 1}`));
  assert('  and Total Paid is the hours worked plus that leave',
    near(val(summary, `P${HDR + 1}`), 59.5), val(summary, `P${HDR + 1}`));
  assert('  while Total Hours stays the hours WORKED — the 40 is measured on it',
    near(val(summary, `G${HDR + 1}`), 55.5), val(summary, `G${HDR + 1}`));
  assert('  the totals row carries both',
    near(val(summary, `O${HDR + 2}`), 4) && near(val(summary, `P${HDR + 2}`), 59.5));
  assert('  and the leave is tinted like the haul column beside it',
    sty(summary, `O${HDR + 1}`) === XS.numOff && sty(summary, `O${HDR + 2}`) === XS.totOff);
}

// ── The workbook still describes itself correctly ───────────────────────────
console.log('\n[the sheets declare the width they now have]');
{
  const dXml = api.reportDetailSheetXml(model);
  const sXml = api.reportSummarySheetXml(model);
  // 23 since the detail sheet grew "Equipment Run (hrs)" — the machines the
  // operator named and the hours on each, which is what a production rate is
  // pivoted on.
  assert('the detail sheet filters and sizes 23 columns',
    /<autoFilter ref="A6:W\d+"\/>/.test(dXml)
    && (dXml.match(/<col /g) || []).length === 23
    && /<dimension ref="A1:W\d+"\/>/.test(dXml));
  // 17 since paid leave was given a column of its own and a Total Paid beside
  // it — the hours the check is cut for, which Total Hours is not.
  assert('the summary sheet filters and sizes 17',
    /<autoFilter ref="A10:Q\d+"\/>/.test(sXml)
    && (sXml.match(/<col /g) || []).length === 17
    && /<dimension ref="A1:Q\d+"\/>/.test(sXml));
  // A style index with no xf behind it is a cell Excel refuses to open.
  const styles = PAGE.slice(PAGE.indexOf('const XLSX_STYLES'), PAGE.indexOf('</styleSheet>'));
  const count = Number((styles.match(/<cellXfs count="(\d+)">/) || [])[1]);
  const defined = (styles.match(/<xf numFmtId=/g) || []).length - 1;  // less cellStyleXfs
  assert(`every style index the sheets use exists (${count} declared)`,
    count === defined && count > Math.max(XS.numHaul, XS.totHaul, XS.numOff, XS.totOff),
    `declared ${count}, defined ${defined}`);
  for (const [n, c] of [['fonts', 'font'], ['fills', 'fill']]) {
    const declared = Number((styles.match(new RegExp(`<${n} count="(\\d+)">`)) || [])[1]);
    const actual = (styles.match(new RegExp(`<${c}>`, 'g')) || []).length;
    assert(`  and the ${n} count matches the ${n} listed`, declared === actual,
      `declared ${declared}, found ${actual}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
