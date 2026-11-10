#!/usr/bin/env node
'use strict';
/**
 * Reports ▸ Projects: which JOB is buying the overtime.
 *
 * Run: node scripts/test-payroll-projects.js
 *
 * The Hours Report asks what a man's fortnight costs. This sub-tab asks the
 * superintendent's question instead — which job the overtime is being worked
 * on, and who on it is close to the fortieth hour — and there is exactly one
 * way to get that wrong, so it is what most of this file is about.
 *
 * OVERTIME IS NOT A JOB'S TO PASS. The fortieth hour is a fact about an
 * EMPLOYEE'S WEEK across every job he touched. Four ten-hour days on a paving
 * job and one eight-hour day at the shop is eight hours of overtime, and every
 * one of them is the shop's — not because the shop worked him hard, but because
 * he arrived there with forty hours already behind him. Count each job to 40 on
 * its own and you find no overtime at all: 40 and 8, both under the line.
 *
 * So the split is taken from weeklyOvertime, which already decided which
 * ENTRIES the overtime fell on, and those entries are posted back to the jobs
 * they were worked on. The invariant that keeps it honest is below and is the
 * point of the file: ADDING THE JOBS UP RETURNS THE COMPANY'S OVERTIME EXACTLY.
 * Classifying hours by job may not create or destroy any.
 *
 * The other half is HOURS BEFORE OT, the same figure read forward: what the man
 * can still be given before the premium starts. It is a whole-week, all-jobs
 * number that repeats under every job he worked that week, so the one thing it
 * must never do is sum down a project column — that counts his week once per
 * job. The tests below pin that down on screen and in the workbook.
 */

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const PAGE = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');

let JSDOM;
try { ({ JSDOM } = require(path.join(ROOT, 'node_modules/jsdom'))); }
catch { console.log('jsdom not installed — skipping project report checks'); process.exit(0); }

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// ── The page's own model and renderers, lifted whole ────────────────────────
// Restating any of this here would test a copy of the rule rather than the rule.
const FNS = [
  'escapeHtml', 'prettyDiv', 'prettyOff', 'prettyDateShort',
  'isOffSiteHaul', 'offSiteHaulWork', 'haulWorkHours',
  // What a time-off entry pays. buildReportModel counts approved leave
  // through this, so the vacation day below is priced by the page's own rule.
  'timeOffPayHours', 'leaveHoursOf',
  'weekStartOf', 'weekEndOf', 'stampKey', 'compareIds', 'byEntryOrder', 'weeklyOvertime',
  'buildReportModel', 'projectKeyOf', 'buildProjectsModel',
  'projRoomTitle', 'projEmployeeRowHtml', 'projColumnsHtml', 'projBlockHtml',
  'projBarsHtml', 'projChartHtml',
  // The crew capacity board — what replaced the second bar chart
  // (projCrewChartHtml). One row per man, one meter per Monday–Sunday week,
  // every meter on one shared scale with the 40 drawn on it.
  'ccWeeksShown', 'ccWeekRelation', 'ccWeekTrusted', 'ccWindow', 'ccWeekLabel',
  'ccStanding', 'ccOrdered', 'ccStatus', 'ccScaleMax',
  'ccCellHtml', 'ccRowHtml', 'ccHeadHtml', 'projCapacityHtml',
  'colLetter', 'excelDateSerial', 'xmlEsc', 'xlsxRow', 'xlsxSheetXml',
  'xlsxContentTypes', 'xlsxSheetName', 'xlsxWorkbook', 'xlsxWorkbookRels',
  'projectSummarySheetXml', 'projectCrewSheetXml', 'projectEmployeeSheetXml',
  'projectHeadroomSheetXml',
];

// The consts the lifted functions reach for. Taken as slices rather than
// retyped, for the same reason the functions are.
function slice(startMark, endMark) {
  const a = PAGE.indexOf(startMark);
  const b = PAGE.indexOf(endMark, a + 1);
  if (a < 0 || b < 0) {
    console.error(`could not slice payroll.html between "${startMark}" and "${endMark}"`);
    process.exit(1);
  }
  return PAGE.slice(a, b + endMark.length);
}
function line(re) {
  const m = PAGE.match(re);
  if (!m) {
    console.error(`could not find ${re} in payroll.html`);
    process.exit(1);
  }
  return m[0];
}
const CONSTS = [
  slice('    const XS = {', "const cNum = (v, s) => ({ t: 'n', v, s });"),
  line(/const OT_WEEKLY_THRESHOLD = \d+;/),
  line(/const PAID_LEAVE_HOURS = \d+;/),
  line(/const MAX_LEAVE_HOURS = \d+;/),
  slice('    const PROJ_NUM_KEYS = [', '];'),
  slice('    const PROJ_COLUMNS = [', '];'),
  // The board's own thresholds: how many weeks it draws, and where a man
  // stops counting as having room.
  line(/const CC_WEEKS_SHOWN = \d+;/),
  line(/const CC_AT = [\d.]+;/),
  line(/const CC_NEAR = [\d.]+;/),
].join('\n');

const FROM = '2026-08-24', TO = '2026-09-06';
const dom = new JSDOM(`<!doctype html><body>
  <input id="flt-from" value="${FROM}"><input id="flt-to" value="${TO}">
  <select id="flt-division"><option value="" selected></option></select>
  <input id="flt-user" value=""><input id="flt-supervisor" value=""></body>`);

// ── The fortnight ───────────────────────────────────────────────────────────
// Week one is Mon 2026-08-24 → Sun 2026-08-30; week two opens Mon 2026-08-31.
const day = (username, work_date, hours, job, over = {}) => Object.assign({
  id: `${username}-${work_date}-${job}`,
  username, entry_type: 'daily', status: 'approved',
  division: 'paving', work_date, computed_hours: hours, travel_hours: 0,
  job_id: job.toLowerCase().replace(/\W+/g, '-'), job_label: job,
  prevailing_wage: false, haul_type: null, haul_hours: null,
  created_at: `${work_date}T12:00:00Z`,
}, over);

const ENTRIES = [
  // MATT — the case the whole feature exists for. Four ten-hour days on Ridge
  // Road take him to exactly forty; Friday at the shop is therefore overtime
  // from its first minute, and every hour of it is the SHOP'S overtime even
  // though the shop only worked him eight hours.
  day('matt', '2026-08-24', 10, 'Ridge Road Paving'),
  day('matt', '2026-08-25', 10, 'Ridge Road Paving'),
  day('matt', '2026-08-26', 10, 'Ridge Road Paving'),
  day('matt', '2026-08-27', 10, 'Ridge Road Paving'),
  day('matt', '2026-08-28',  8, 'Shop Yard'),
  // His second week stays well under: 30 hours, so ten to spare.
  day('matt', '2026-08-31', 10, 'Ridge Road Paving'),
  day('matt', '2026-09-01', 10, 'Ridge Road Paving'),
  day('matt', '2026-09-02', 10, 'Ridge Road Paving'),

  // DALE — one job, one week, straddling the line on a PREVAILING day, with
  // travel on it. 36 hours in, then a 9-hour prevailing day: 4 of that day are
  // regular and 5 are overtime, and the overtime is split across the day's own
  // prevailing/standard mix pro rata.
  day('dale', '2026-08-24', 12, 'Juniata College'),
  day('dale', '2026-08-25', 12, 'Juniata College'),
  day('dale', '2026-08-26', 12, 'Juniata College'),
  day('dale', '2026-08-27',  8, 'Juniata College',
    { prevailing_wage: true, travel_hours: 1, travel_to_site_hours: 0.5, travel_to_shop_hours: 0.5 }),

  // RAY — never near the line. 24 hours on one job, sixteen to spare.
  day('ray', '2026-08-24', 8, 'Shop Yard'),
  day('ray', '2026-08-25', 8, 'Shop Yard'),
  day('ray', '2026-08-26', 8, 'Shop Yard', { haul_type: 'off_site', haul_hours: 8 }),

  // A vacation day. Paid leave belongs to no job and never counts toward 40.
  { id: 'off-1', username: 'ray', entry_type: 'time_off', status: 'approved',
    work_date: '2026-08-27', time_off_type: 'vacation', created_at: '2026-08-27T12:00:00Z' },
];

const build = new Function('document', 'user', 'filtered', 'loadedScope',
  `${FNS.map(n => requireFn(PAGE, n, 'payroll.html')).join('\n')}
   ${CONSTS}
   return { ${FNS.join(', ')} };`);
const api = build(dom.window.document, { companyName: 'Force Corp', companyCode: 'FC' },
  ENTRIES, { from: FROM, to: TO, division: '' });

const base  = api.buildReportModel();
const model = api.buildProjectsModel();
const byName = Object.fromEntries(model.projects.map(p => [p.name, p]));
const empOn  = (job, who) => byName[job].employees.find(e => e.username === who);

// ── The invariant the feature rests on ──────────────────────────────────────
console.log('\n[adding the jobs up returns the company overtime exactly]');

const sumJobs = k => model.projects.reduce((s, p) => s + p[k], 0);

assert('every job in the fortnight is on the report',
  model.projects.length === 3, `got ${model.projects.length}: ${model.projects.map(p => p.name).join(', ')}`);
assert('the jobs\' overtime adds to the company\'s overtime',
  near(sumJobs('otHours'), base.tot.otHours),
  `jobs ${sumJobs('otHours').toFixed(2)} vs report ${base.tot.otHours.toFixed(2)}`);
assert('  and so does the prevailing half of it',
  near(sumJobs('otPwHours'), base.tot.otPwHours));
assert('  and the standard half',
  near(sumJobs('otStdHours'), base.tot.otStdHours));
assert('prevailing OT + standard OT is still the overtime',
  near(sumJobs('otPwHours') + sumJobs('otStdHours'), sumJobs('otHours')));
assert('the jobs\' hours add to the hours worked',
  near(sumJobs('totalHours'), base.tot.pendingHours + base.tot.approvedHours),
  `jobs ${sumJobs('totalHours').toFixed(2)}`);
assert('  labour + haul + travel is the total',
  near(sumJobs('workHours') + sumJobs('truckHours') + sumJobs('travelHours'), sumJobs('totalHours')));
assert('  prevailing + standard is the total',
  near(sumJobs('pwHours') + sumJobs('stdHours'), sumJobs('totalHours')));
assert('  regular + overtime is the total',
  near(sumJobs('regHours') + sumJobs('otHours'), sumJobs('totalHours')));

// ── The job that took him past forty is the one that carries it ─────────────
console.log('\n[the overtime lands on the job the late hours were worked on]');

assert('Ridge Road bought 40 hours of Matt\'s first week and none of the overtime',
  near(empOn('Ridge Road Paving', 'matt').otHours, 0),
  `got ${empOn('Ridge Road Paving', 'matt').otHours.toFixed(2)}`);
assert('  the Shop Yard\'s eight hours are ALL overtime',
  near(empOn('Shop Yard', 'matt').otHours, 8),
  `got ${empOn('Shop Yard', 'matt').otHours.toFixed(2)}`);
assert('  though the Shop Yard only worked him eight hours all week',
  near(empOn('Shop Yard', 'matt').totalHours, 8));
assert('  — counting that job to 40 on its own would find no overtime at all',
  empOn('Shop Yard', 'matt').totalHours < 40 && empOn('Shop Yard', 'matt').otHours > 0);
assert('Matt\'s overtime across the jobs is his overtime on the Hours Report',
  near(empOn('Ridge Road Paving', 'matt').otHours + empOn('Shop Yard', 'matt').otHours,
       base.rows.find(r => r.username === 'matt').otHours));

console.log('\n[a day straddling the line splits across its own rate mix]');
{
  const dale = empOn('Juniata College', 'dale');
  // 36 hours in, then a 9-hour day (8 work + 1 travel): 4 regular, 5 overtime.
  assert('the straddling day contributes five overtime hours', near(dale.otHours, 5),
    `got ${dale.otHours.toFixed(2)}`);
  // That day is 8 prevailing work hours + 1 travel = 9, and travel is never
  // prevailing. 5/9 of each falls past the line.
  assert('  its overtime is split pro rata across prevailing and standard',
    near(dale.otPwHours, 8 * (5 / 9)) && near(dale.otStdHours, 1 * (5 / 9)),
    `pw ${dale.otPwHours.toFixed(3)} std ${dale.otStdHours.toFixed(3)}`);
  assert('  and the two halves still add to the overtime',
    near(dale.otPwHours + dale.otStdHours, dale.otHours));
  assert('travel on the day is counted, and never as prevailing',
    near(dale.travelHours, 1) && near(dale.pwHours, 8));
}

// ── Hours before overtime ───────────────────────────────────────────────────
console.log('\n[hours before overtime is a whole week, across every job]');

const room = who => model.crew.get(who);
assert('Matt\'s first week has no room left — it is already at forty',
  near(room('matt').weeks.find(w => w.weekStart === '2026-08-24').remaining, 0));
assert('  his second week, at thirty hours, has ten',
  near(room('matt').weeks.find(w => w.weekStart === '2026-08-31').remaining, 10));
assert('  so ten across the fortnight, not fifty', near(room('matt').remaining, 10));
assert('Ray worked 24 hours and has sixteen to spare', near(room('ray').remaining, 16));
assert('  his vacation day did NOT eat into them — paid leave is not hours worked',
  near(room('ray').weeks[0].totalHours, 24));
assert('Dale is 5 hours past the line, so he has no room — never a negative',
  near(room('dale').remaining, 0) && room('dale').otHours > 0);

assert('the same man carries the same headroom under every job he worked',
  empOn('Ridge Road Paving', 'matt').room.remaining === empOn('Shop Yard', 'matt').room.remaining);
assert('  and the crew headroom is summed across PEOPLE, not project rows',
  near(model.totRemaining, 10 + 0 + 16),
  `got ${model.totRemaining.toFixed(2)}`);
assert('men past forty are counted', model.inOt === 2, `got ${model.inOt}`);
assert('the vacation day is counted out of the jobs and named separately',
  model.offEntries === 1 && !model.projects.some(p => /vacation/i.test(p.name)));
assert('a man with no job hours is not given headroom on this report',
  model.crewRows.every(c => c.weeks.length > 0));

// ── Grouping ────────────────────────────────────────────────────────────────
console.log('\n[jobs, and who is on them]');

assert('the Shop Yard carries both the men who worked it',
  byName['Shop Yard'].employees.length === 2);
assert('  its hours are theirs added together',
  near(byName['Shop Yard'].totalHours, 8 + 24));
assert('distinct work dates are counted once per job, not once per entry',
  byName['Ridge Road Paving'].days === 7, `got ${byName['Ridge Road Paving'].days}`);
assert('an off-site haul day is driving, not labour',
  near(empOn('Shop Yard', 'ray').truckHours, 8) &&
  near(empOn('Shop Yard', 'ray').workHours, 16));
assert('the biggest overtime sorts to the top',
  model.projects[0].otHours >= model.projects[model.projects.length - 1].otHours);
assert('two divisions may share a job label without merging',
  api.projectKeyOf({ division: 'turf', job_id: '', job_label: 'Shop Yard' }) !==
  api.projectKeyOf({ division: 'paving', job_id: '', job_label: 'Shop Yard' }));
assert('  and one job filed in two letter cases does not split in two',
  api.projectKeyOf({ division: 'turf', job_id: '', job_label: 'Shop Yard' }) ===
  api.projectKeyOf({ division: 'turf', job_id: '', job_label: 'shop yard' }));

// ── What the screen says ────────────────────────────────────────────────────
console.log('\n[the screen]');
{
  const chart = api.projChartHtml(model.projects);
  const cdom  = new JSDOM(`<!doctype html><body>${chart}</body>`);
  const rows  = [...cdom.window.document.querySelectorAll('.pc-row')];
  assert('the chart draws a bar per job', rows.length === model.projects.length);
  const shop = rows.find(r => r.querySelector('.pc-label').textContent.includes('Shop Yard'));
  const width = sel => parseFloat((shop.querySelector(sel).getAttribute('style') || '').replace(/\D*([\d.]+).*/, '$1'));
  assert('  the overtime is its own segment of the bar, not a shade of the whole',
    width('.pc-ot') > 0 && width('.pc-reg') > 0);
  // Two percentages each rounded to 2dp, so the pair can land a hundredth
  // either side of the share they describe.
  const share = (byName['Shop Yard'].totalHours / Math.max(...model.projects.map(p => p.totalHours))) * 100;
  assert('  and the two segments together are the job\'s share of the biggest job',
    Math.abs(width('.pc-reg') + width('.pc-ot') - share) < 0.02,
    `${(width('.pc-reg') + width('.pc-ot')).toFixed(2)}% vs ${share.toFixed(2)}%`);
  const clean = rows.find(r => r.querySelector('.pc-label').textContent.includes('Juniata') === false
                            && r.querySelector('.pc-value').textContent.includes('no OT'));
  assert('  a job with no overtime says so rather than printing 0.00 h OT', !!clean);

  const block = new JSDOM(`<!doctype html><body><table>${
    api.projColumnsHtml()}</table><table>${
    byName['Shop Yard'].employees.map(api.projEmployeeRowHtml).join('')}</table></body>`);
  const heads = [...block.window.document.querySelectorAll('th')].map(t => t.textContent);
  const cells = [...block.window.document.querySelectorAll('tr')[1].querySelectorAll('td')];
  assert('every crew column has a cell under it', heads.length === cells.length,
    `${heads.length} headings, ${cells.length} cells`);
  const at = label => cells[heads.indexOf(label)];
  assert('the OT cell is tinted only when there IS overtime',
    at('OT Hrs').className.includes('num-ot'));
  assert('  and the Before OT cell says which weeks it came from',
    /across EVERY job/i.test(at('Before OT').getAttribute('title') || ''));

  const foot = new JSDOM(`<!doctype html><body><table>${api.projBlockHtml(byName['Shop Yard'])}</table></body>`);
  const totalCells = [...foot.window.document.querySelectorAll('tr.total td')];
  assert('the totals row refuses to add the headroom column up',
    totalCells[heads.indexOf('Before OT')].textContent.trim() === '—',
    `got "${totalCells[heads.indexOf('Before OT')].textContent.trim()}"`);
  assert('  and every other column of the block totals its own figures',
    near(totalCells[heads.indexOf('Total')].textContent, byName['Shop Yard'].totalHours) &&
    near(totalCells[heads.indexOf('OT Hrs')].textContent, byName['Shop Yard'].otHours));
}

// ── The same hours, the other way up ────────────────────────────────────────
console.log('\n[one row per man, across every job he worked]');
{
  const crew = Object.fromEntries(model.employees.map(e => [e.username, e]));
  assert('each man appears once, however many jobs he was on',
    model.employees.length === 3 && crew.matt.jobs === 2, JSON.stringify(model.employees.map(e => e.username)));
  assert('  his hours are his jobs\' hours added together',
    near(crew.matt.totalHours,
         empOn('Ridge Road Paving', 'matt').totalHours + empOn('Shop Yard', 'matt').totalHours));
  assert('  and so is his overtime — the same figure the Hours Report prints',
    near(crew.matt.otHours, base.rows.find(r => r.username === 'matt').otHours));
  assert('the crew\'s overtime adds to the company\'s, exactly as the jobs\' does',
    near(model.employees.reduce((s, e) => s + e.otHours, 0), base.tot.otHours));
  assert('  and so do the hours, so the job chart and the crew board draw the same fortnight',
    near(model.employees.reduce((s, e) => s + e.totalHours, 0), sumJobs('totalHours')));
  assert('a day worked on two jobs counts once against the man',
    crew.matt.days === 8, `got ${crew.matt.days}`);
  assert('he carries his headroom, so the board can say what is left',
    near(crew.matt.remaining, 10) && near(crew.ray.remaining, 16));
  assert('the busiest overtime sorts to the top here too',
    model.employees[0].otHours >= model.employees[model.employees.length - 1].otHours);
}

// ── The crew, against the 40 ────────────────────────────────────────────────
// This used to be a second bar chart, projCrewChartHtml: one bar per man,
// scaled to the busiest man's fortnight. payroll.html replaced it with the crew
// capacity board, projCapacityHtml, because a fortnight's bar cannot be read
// against 40: the forty is a WEEK's line. The board draws one meter per
// Monday–Sunday week, and every meter on the board shares one track with the
// 40 drawn on it.
//
// The old chart's checks are asked of the board below: a row per man, OT as
// its own segment, the job count, and headroom in the tooltip. The one that
// cannot carry over is "his share of the busiest man". The board drops that
// scale on purpose, so the check here is the rule that replaced it.
console.log('\n[the crew capacity board]');
{
  const html = api.projCapacityHtml(model.employees, model.weeks, model.rangeFrom);
  const cdom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const doc  = cdom.window.document;
  const rows = [...doc.querySelectorAll('.cc-row:not(.cc-head)')];
  const rowOf = who => rows.find(r => r.querySelector('.cc-name').textContent.trim() === who);
  const meters = row => [...row.querySelectorAll('.cc-cell')];
  const pct = el => (el ? parseFloat((el.getAttribute('style') || '').replace(/\D*([\d.]+).*/, '$1')) : 0);
  const reg = cell => pct(cell.querySelector('.cc-reg'));
  const ot  = cell => pct(cell.querySelector('.cc-ot'));
  const wk  = (who, start) => model.crew.get(who).weeks.find(w => w.weekStart === start);
  const W1 = '2026-08-24', W2 = '2026-08-31';

  assert('the board draws a row per man', rows.length === model.employees.length,
    `${rows.length} rows for ${model.employees.length} men`);
  assert('  with a meter for each week of the fortnight on every row',
    rows.every(r => meters(r).length === 2),
    rows.map(r => meters(r).length).join(', '));

  const matt = rowOf('matt');
  const [m1, m2] = meters(matt);
  assert('  overtime is its own segment of the meter here as well', ot(m1) > 0 && reg(m1) > 0,
    `reg ${reg(m1)}% ot ${ot(m1)}%`);
  assert('  and a week under the 40 has none', ot(m2) === 0 && reg(m2) > 0,
    `reg ${reg(m2)}% ot ${ot(m2)}%`);

  // One track for the whole board, read off the board itself.
  const scaleText = doc.querySelector('.cc-scale').textContent;
  const scale = Number((scaleText.match(/against a (\d+)-hour track/) || [])[1]);
  const heaviest = Math.max(...model.employees.flatMap(e => e.room.weeks.map(w => w.totalHours)));
  assert('  every meter shares one track, past the heaviest week and never under 50 h',
    scale >= 50 && scale > heaviest, `${scale} h track, heaviest week ${heaviest} h`);
  const filled = cell => reg(cell) + ot(cell);
  const onTrack = h => (h / scale) * 100;
  assert('  each meter is that WEEK\'s hours on the track, not his share of the busiest man',
    Math.abs(filled(m1) - onTrack(wk('matt', W1).totalHours)) < 0.02 &&
    Math.abs(filled(m2) - onTrack(wk('matt', W2).totalHours)) < 0.02,
    `${filled(m1).toFixed(2)}% and ${filled(m2).toFixed(2)}% on a ${scale} h track`);
  const [d1, d2] = meters(rowOf('dale'));
  assert('  so the same track holds in every row, and two men\'s weeks compare directly',
    Math.abs(filled(d1) - onTrack(wk('dale', W1).totalHours)) < 0.02,
    `${filled(d1).toFixed(2)}% for ${wk('dale', W1).totalHours} h`);
  assert('  regular time fills up to the 40 and the overtime runs on past it',
    Math.abs(reg(m1) - onTrack(40)) < 0.02 && Math.abs(ot(m1) - onTrack(wk('matt', W1).otHours)) < 0.02,
    `reg ${reg(m1)}% ot ${ot(m1)}%`);
  const tick = parseFloat((doc.querySelector('.cc-board').getAttribute('style')
    .match(/--cc-tick:\s*([\d.]+)%/) || [])[1]);
  assert('  and the 40 is drawn on that same track', Math.abs(tick - onTrack(40)) < 0.02, `${tick}%`);
  assert('  a week he worked no job is an empty track under the 40, not a zero bar',
    !d2.querySelector('.cc-reg') && !!d2.querySelector('.cc-tick'));

  assert('  the row says how many jobs his hours are spread over',
    /2 jobs/.test(matt.querySelector('.cc-sub').textContent), matt.querySelector('.cc-sub').textContent);
  const chip = matt.querySelector('.cc-chip');
  assert('  and the Room tooltip carries the hours left before overtime starts again',
    /before overtime/i.test(chip.getAttribute('title') || ''), chip.getAttribute('title'));
  assert('  for a man on a job in both weeks, Room is his Before OT figure',
    chip.textContent.trim() === `${model.crew.get('matt').remaining.toFixed(2)} h`, chip.textContent);
  // The board's one deliberate departure from Before OT (see ccWindow): inside
  // the cycle, a week nobody put him on is a full 40 open, not silence.
  assert('  a week he was on no job counts as a full 40 open on the board',
    rowOf('ray').querySelector('.cc-chip').textContent.trim() ===
      `${(model.crew.get('ray').remaining + 40).toFixed(2)} h`,
    rowOf('ray').querySelector('.cc-chip').textContent);

  // The window here is the whole fortnight, so the board has to agree with
  // the rest of the report to the hundredth.
  const num = (r, i) => Number(r.querySelectorAll('.cc-num')[i].textContent) || 0;
  assert('  its OT column adds to the company overtime',
    near(rows.reduce((s, r) => s + num(r, 1), 0), base.tot.otHours));
  assert('  and its Total column to the hours on jobs',
    near(rows.reduce((s, r) => s + num(r, 0), 0), sumJobs('totalHours')));

  const order = rows.map(r => r.querySelector('.cc-name').textContent.trim());
  assert('  the men past the 40 lead, most overtime first, then the pool with room',
    order.join() === 'matt,dale,ray', order.join());
  assert('  and only the pool is folded away',
    rowOf('ray').classList.contains('cc-tail') &&
    !rowOf('matt').classList.contains('cc-tail') && !rowOf('dale').classList.contains('cc-tail'));

  // The two crew pictures used to share projBarsHtml, which kept their colours
  // from drifting apart. The board draws its own meters, so the same promise
  // is checked where it now lives: the colour rules and the legend swatches.
  const bg = sel => (PAGE.match(new RegExp(
    sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{\\s*background:\\s*([^;]+);')) || [])[1];
  assert('the board colours regular and overtime the same as the job chart',
    !!bg('.pc-reg') && bg('.cc-meter .cc-reg') === bg('.pc-reg') &&
    !!bg('.pc-ot')  && bg('.cc-meter .cc-ot')  === bg('.pc-ot'),
    `reg ${bg('.cc-meter .cc-reg')} vs ${bg('.pc-reg')}, ot ${bg('.cc-meter .cc-ot')} vs ${bg('.pc-ot')}`);
  const jdom = new JSDOM(`<!doctype html><body>${api.projChartHtml(model.projects)}</body>`);
  const keys = d => [...d.querySelectorAll('.pc-legend .pc-key')].map(k => k.className);
  assert('  and both legends use the same swatches for them',
    ['pc-key reg', 'pc-key ot'].every(k => keys(jdom.window.document).includes(k) && keys(doc).includes(k)),
    `${keys(jdom.window.document)} / ${keys(doc)}`);
  assert('  and each says which yardstick it was drawn against',
    /largest job/.test(jdom.window.document.querySelector('.proj-section-title').textContent) &&
    /against the 40/.test(doc.querySelector('.proj-section-title').textContent) &&
    /one week against a \d+-hour track/.test(scaleText) && /the line is the 40th hour/.test(scaleText),
    scaleText);
}

// ── What the workbook says ──────────────────────────────────────────────────
console.log('\n[the workbook]');

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
// Every value in one column of a sheet, from the row after the header down.
function column(c, letter, first, last) {
  const out = [];
  for (let r = first; r <= last; r++) out.push(val(c, letter + r));
  return out;
}

{
  const s1 = cells(api.projectSummarySheetXml(model));
  const HEAD = 8, n = model.projects.length;
  assert('sheet 1 is one row per job', column(s1, 'A', HEAD + 1, HEAD + n)
    .every(v => typeof v === 'string' && v.length));
  const otCol = column(s1, 'J', HEAD + 1, HEAD + n);
  assert('  its overtime column adds to the company overtime',
    near(otCol.reduce((a, b) => a + b, 0), base.tot.otHours));
  assert('  and its totals row prints that same figure',
    near(val(s1, `J${HEAD + n + 1}`), base.tot.otHours));
  assert('  the employee total is the HEADCOUNT, not the column added up',
    val(s1, `C${HEAD + n + 1}`) === model.employeeCount &&
    model.employeeCount < column(s1, 'C', HEAD + 1, HEAD + n).reduce((a, b) => a + b, 0),
    `headcount ${val(s1, `C${HEAD + n + 1}`)}`);
  assert('  likewise the work days — a day on four jobs is one day',
    val(s1, `D${HEAD + n + 1}`) === model.tot.days);
  assert('  the sheet says on its face that overtime is a week and not a job',
    /OVERTIME IS AN EMPLOYEE.S WEEK, NOT A JOB.S/.test(api.projectSummarySheetXml(model)));
}

{
  const xml = api.projectCrewSheetXml(model);
  const s2 = cells(xml);
  const HEAD = 7, n = model.employees.length;
  assert('sheet 2 is one row per man, across every job', n === 3, `got ${n}`);
  assert('  its overtime column adds to the company overtime too',
    near(column(s2, 'I', HEAD + 1, HEAD + n).reduce((a, b) => a + b, 0), base.tot.otHours));
  assert('  and its hours match the by-job sheet, so the two sheets agree',
    near(val(s2, `G${HEAD + n + 1}`), sumJobs('totalHours')));
  // The whole reason this sheet exists beside the per-job one.
  assert('  HERE the headroom column totals — each man appears exactly once',
    near(val(s2, `M${HEAD + n + 1}`), model.totRemaining),
    `got ${val(s2, `M${HEAD + n + 1}`)} vs ${model.totRemaining}`);
  assert('  the job count is the company\'s, not the column added up',
    val(s2, `B${HEAD + n + 1}`) === model.projects.length &&
    model.projects.length < column(s2, 'B', HEAD + 1, HEAD + n).reduce((a, b) => a + b, 0));
  assert('  and the work days likewise', val(s2, `C${HEAD + n + 1}`) === model.tot.days);
  assert('  the sheet says why its headroom totals and the other\'s does not',
    /each man appears once/i.test(xml));
}

{
  const xml = api.projectEmployeeSheetXml(model);
  const s2 = cells(xml);
  const HEAD = 7;
  const n = model.projects.reduce((s, p) => s + p.employees.length, 0);
  assert('sheet 3 is one row per employee per job', n === 4, `got ${n}`);
  assert('  its overtime column also adds to the company overtime',
    near(column(s2, 'J', HEAD + 1, HEAD + n).reduce((a, b) => a + b, 0), base.tot.otHours));
  assert('  the headroom column REFUSES to total — it would count a week per job',
    typeof val(s2, `M${HEAD + n + 1}`) === 'string',
    `got ${JSON.stringify(val(s2, `M${HEAD + n + 1}`))}`);
  assert('  and it points at the sheet where that total is real',
    /Overtime by Employee/i.test(String(val(s2, `M${HEAD + n + 1}`))));
  assert('  each row carries the weeks its headroom came from',
    String(val(s2, `N${HEAD + 1}`)).includes('2026-08-'));
}

{
  const s3 = cells(api.projectHeadroomSheetXml(model));
  const HEAD = 7;
  const n = model.crewRows.reduce((s, c) => s + c.weeks.length, 0);
  assert('sheet 4 is one row per employee per week', n === 4, `got ${n}`);
  assert('  here the headroom DOES total, because each week appears once',
    near(val(s3, `G${HEAD + n + 1}`), model.totRemaining));
  assert('  hours worked, regular and overtime still reconcile',
    near(val(s3, `D${HEAD + n + 1}`),
         val(s3, `E${HEAD + n + 1}`) + val(s3, `F${HEAD + n + 1}`)));
  assert('  no week is given negative headroom',
    column(s3, 'G', HEAD + 1, HEAD + n).every(v => v >= 0));
  assert('  a week names the jobs it was spread across',
    column(s3, 'I', HEAD + 1, HEAD + n).some(v => String(v).includes('·')));
}

console.log('\n[the package Excel actually has to open]');
{
  const names = ['Overtime by Project', 'Overtime by Employee',
                 'Employees by Project', 'OT Headroom by Week'];
  const wb   = api.xlsxWorkbook(names);
  const rels = api.xlsxWorkbookRels(names.length);
  const ct   = api.xlsxContentTypes(names.length);
  assert('the workbook lists every sheet', names.every(n => wb.includes(`name="${n}"`)));
  assert('  every sheet has a relationship, and styles takes the id after them',
    [1, 2, 3, 4].every(i => rels.includes(`Id="rId${i}"`) && rels.includes(`worksheets/sheet${i}.xml`)) &&
    rels.includes('Id="rId5"') && rels.includes('Target="styles.xml"'));
  assert('  and a content type', [1, 2, 3, 4].every(i => ct.includes(`/xl/worksheets/sheet${i}.xml`)));
  // The generated parts are the reason a fourth sheet was a one-line change.
  assert('  the book grew to four sheets without touching the package parts',
    /projectCrewSheetXml\(model\)[\s\S]{0,200}projectEmployeeSheetXml/.test(PAGE) &&
    api.xlsxContentTypes(4).match(/worksheets\/sheet/g).length === 4);
  assert('  the sheet count is stated once, by the caller',
    api.xlsxContentTypes(2).match(/worksheets\/sheet/g).length === 2);
  assert('a sheet name Excel would reject is clamped rather than shipped',
    !/[[\]:*?/\\]/.test(api.xlsxSheetName('Hours: [2026] / week?')) &&
    api.xlsxSheetName('x'.repeat(40)).length === 31 &&
    api.xlsxSheetName('') === 'Sheet');
  assert('the hours report still asks for its own three sheets',
    /name: 'Payroll Summary',[\s\S]{0,400}name: 'Overtime by Week'/.test(PAGE));
}

// ── Empty and edge ──────────────────────────────────────────────────────────
console.log('\n[nothing, and nothing-shaped]');
{
  const empty = build(dom.window.document, { companyName: 'Force Corp' }, [],
    { from: FROM, to: TO, division: '' }).buildProjectsModel();
  assert('an empty range builds an empty report rather than throwing',
    empty.projects.length === 0 && empty.tot.otHours === 0 && empty.totRemaining === 0);

  const nameless = build(dom.window.document, { companyName: 'Force Corp' },
    [day('matt', '2026-08-24', 8, '', { job_id: '', job_label: '' })],
    { from: FROM, to: TO, division: '' }).buildProjectsModel();
  assert('a day filed against no job is named, not dropped — it is still hours owed',
    nameless.projects.length === 1 && nameless.projects[0].name === 'Unassigned' &&
    near(nameless.projects[0].totalHours, 8));
}

// ── On paper ────────────────────────────────────────────────────────────────
// Measured in a real browser, because column width is not a property of any
// rule: it is what the engine works out from the headings, the figures and the
// space the page allows. The Hours Report has already lost a column off the
// right edge of a landscape sheet once (see test-report-width.js); this table
// is narrower but is printed inside the same page, and the bars beside it are
// the one thing here that a browser drops from a printout by default.
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let puppeteer;
try { puppeteer = require(path.join(ROOT, 'node_modules/puppeteer-core')); } catch { /* skipped below */ }

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (!puppeteer || !fs.existsSync(CHROME)) {
  console.log('\n[on paper]\n  – no bundled browser, skipping the print measurements');
  finish();
} else {
  // Rendered with the page's own renderer — hand-built blocks would measure a
  // sheet nobody prints.
  const rdom = new JSDOM('<!doctype html><body>' +
    `<input id="flt-from" value="${FROM}"><input id="flt-to" value="${TO}">` +
    '<select id="flt-division"><option value="" selected></option></select>' +
    '<input id="flt-user" value=""><input id="flt-supervisor" value="">' +
    '<div id="projectsWrap"></div></body>');
  // The report also draws each section's own Excel/PDF buttons and the
  // "PDF includes" picker. Those only add markup, but renderProjectsReport
  // calls them, so they come across with it. The picker reads its ticks from
  // localStorage. An empty store gives each section its default, which is
  // what a first visit prints.
  const RENDER_FNS = ['projPartTools', 'printPieceState', 'printPickerHtml', 'renderProjectsReport'];
  const RENDER_CONSTS = [
    slice('    const PRINT_PIECES = [', '];'),
    line(/const PRINT_PREF_KEY = [^\n]+/),
  ].join('\n');
  const render = new Function('document', 'user', 'filtered', 'loadedScope', 'localStorage',
    `${[...FNS, ...RENDER_FNS].map(n => requireFn(PAGE, n, 'payroll.html')).join('\n')}
     ${CONSTS}
     ${RENDER_CONSTS}
     return renderProjectsReport;`);
  render(rdom.window.document, { companyName: 'Force Corp', companyCode: 'FC' },
    ENTRIES, { from: FROM, to: TO, division: '' }, { getItem: () => null })();

  const css = [...PAGE.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  // main.main-wide is what the Reports tab puts on <main>; measuring without it
  // would measure a layout the tab never uses.
  const html = `<!doctype html><html><head><style>${css}</style></head><body>` +
    `<main id="mainContent" class="main-wide">${rdom.window.document.getElementById('projectsWrap').innerHTML}` +
    '</main></body></html>';

  // A landscape Letter page at the sheet's own 0.4in margins is 10.2in of
  // usable width — 979px at 96dpi.
  const PRINT_PX = 979;

  (async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const load = async (width, media) => {
      await page.setViewport({ width, height: 1000 });
      await page.setContent(html, { waitUntil: 'load' });
      await page.emulateMediaType(media);
      // setContent before emulateMediaType, then a reflow read, or the print
      // rules are not yet applied when the measurements are taken.
      return page.evaluate(() => document.body.offsetWidth);
    };
    const measure = () => page.evaluate(() => {
      const tables = [...document.querySelectorAll('.proj-block table')].map(t => ({
        needed: Math.round(t.scrollWidth),
        available: Math.round(t.parentElement.clientWidth),
        cols: t.querySelectorAll('thead th').length,
      }));
      const label = document.querySelector('.pc-label');
      const seg = sel => [...document.querySelectorAll(sel)]
        .map(e => ({ w: e.getBoundingClientRect().width, bg: getComputedStyle(e).backgroundColor }));
      return {
        tables,
        body: Math.round(document.body.scrollWidth),
        labelsCut: [...document.querySelectorAll('.pc-label')]
          .filter(e => e.scrollWidth > e.clientWidth + 1).length,
        labelColour: getComputedStyle(label).color,
        ot: seg('.pc-ot'), reg: seg('.pc-reg'),
        // The crew board's meters, which took over from the second bar chart.
        ccOt: seg('.cc-meter .cc-ot'), ccReg: seg('.cc-meter .cc-reg'),
        ccTail: [...document.querySelectorAll('.cc-board .cc-tail')]
          .map(e => getComputedStyle(e).display),
        nameColour: getComputedStyle(document.querySelector('.proj-name')).color,
        avoidBreak: getComputedStyle(document.querySelector('.proj-block')).breakInside,
      };
    });

    console.log('\n[on a landscape page]');
    await load(PRINT_PX, 'print');
    const p = await measure();
    assert(`every crew table fits the ${PRINT_PX}px sheet`,
      p.tables.every(t => t.needed <= t.available + 1),
      JSON.stringify(p.tables.filter(t => t.needed > t.available + 1)));
    assert('  the sheet itself does not run off the page',
      p.body <= PRINT_PX, `${p.body}px > ${PRINT_PX}px`);
    assert('  every job name on the chart is printed in full, not clipped',
      p.labelsCut === 0, `${p.labelsCut} clipped`);
    // A printed bar with its fill dropped is an empty track — the one thing on
    // this sheet that cannot be read as a figure instead.
    assert('  the overtime bars keep their fill on paper',
      p.ot.every(s => !/rgba\(0, 0, 0, 0\)/.test(s.bg)) &&
      p.reg.every(s => !/rgba\(0, 0, 0, 0\)/.test(s.bg)),
      JSON.stringify(p.ot.map(s => s.bg)));
    assert('  and overtime is still told apart from regular time on it',
      p.ot[0].bg !== p.reg[0].bg, `${p.ot[0].bg} vs ${p.reg[0].bg}`);
    // The second crew picture is the capacity board now, and its meters are
    // their own elements. The same rules apply to them on paper.
    assert('  the crew board\'s meters keep their fill on paper as well',
      p.ccOt.length > 0 && p.ccReg.length > 0 &&
      p.ccOt.every(s => !/rgba\(0, 0, 0, 0\)/.test(s.bg)) &&
      p.ccReg.every(s => !/rgba\(0, 0, 0, 0\)/.test(s.bg)),
      JSON.stringify(p.ccOt.map(s => s.bg)));
    assert('  in the job chart\'s own colours for regular and overtime',
      p.ccOt.every(s => s.bg === p.ot[0].bg) && p.ccReg.every(s => s.bg === p.reg[0].bg),
      `ot ${p.ccOt[0] && p.ccOt[0].bg} vs ${p.ot[0].bg}, reg ${p.ccReg[0] && p.ccReg[0].bg} vs ${p.reg[0].bg}`);
    assert('  and the pool folded away on screen is printed in full',
      p.ccTail.length > 0 && p.ccTail.every(d => d !== 'none'), JSON.stringify(p.ccTail));
    assert('  the dark-theme text is printed black, not near-white on white',
      p.nameColour === 'rgb(0, 0, 0)' && p.labelColour === 'rgb(0, 0, 0)',
      `${p.nameColour} / ${p.labelColour}`);
    assert('  and a job is kept whole rather than split across two sheets',
      p.avoidBreak === 'avoid', p.avoidBreak);

    console.log('\n[on the screens payroll uses]');
    for (const width of [1366, 1600, 1920]) {
      await load(width, 'screen');
      const m = await measure();
      assert(`  ${width}px: no crew table is cut off`,
        m.tables.every(t => t.needed <= t.available + 1),
        JSON.stringify(m.tables.filter(t => t.needed > t.available + 1)));
    }

    await browser.close();
    finish();
  })().catch(err => { console.error(err); process.exit(1); });
}
