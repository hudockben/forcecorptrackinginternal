#!/usr/bin/env node
'use strict';
/**
 * Start Date and Target Date fill themselves in from the daily sheets
 *
 * Run: node scripts/test-bid-auto-dates.js
 *
 * Nobody keeps two dates a row current by hand down a 200-line estimate, so
 * the two date boxes on a bid line answer themselves: the start is the first
 * day work was booked to the sub code, the target is the latest one. Three
 * things have to hold for that to be trustworthy:
 *
 *   1. The dates are the ends of the SAME work days the Days Worked column
 *      counts — the three cells sit next to each other, and "4 days ·
 *      Jul 30 – Aug 4" beside a start of Jul 31 would look like a bug.
 *   2. A typed date outranks the auto one. Somebody planning a start before
 *      the crew ever mobilises is telling us something the sheets cannot.
 *   3. The auto dates are shown, never saved, and never read as a plan. The
 *      latest day worked moves every time the crew books another, and the
 *      projection and the schedule measure the job AGAINST start-and-target —
 *      feed them the days already worked and every line reports itself
 *      finished exactly on time.
 *
 * Two layers, matching the house style of the other frontend tests:
 *   1. Behavioural — evaluates the real derivation and the real cell markup
 *      out of each division page against fixtures.
 *   2. Structural — the row, the printed report and the styling are wired to
 *      it, and the projection is not.
 */

const fs   = require('fs');
const path = require('path');

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

/* Lift one top-level function out of the page by brace-matching its body.
   Brace matching starts after the parameter list, not at the first `{` in the
   source — a default parameter puts a brace in the signature. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let paren = 0, i = src.indexOf('(', start);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

function load(src) {
  return new Function(`
    let _proj = null;
    function setProj(p) { _proj = p; }
    function getProj() { return _proj; }
    function getAllDailyRows() { return []; }
    ${extractFunction(src, 'esc')}
    ${extractFunction(src, '_rowIsWorkDay')}
    ${extractFunction(src, '_workDaysForItems')}
    ${extractFunction(src, '_workDaySpanLabel')}
    ${extractFunction(src, '_autoBidDates')}
    ${extractFunction(src, 'autoBidDates')}
    ${extractFunction(src, '_schedBidDates')}
    ${extractFunction(src, '_bidDateCellHTML')}
    return { _workDaysForItems, _workDaySpanLabel, _autoBidDates, autoBidDates,
             _schedBidDates, _bidDateCellHTML, setProj };
  `)();
}

// ── Fixtures — Storm Water Construction ─────────────────────────────────────
const CC   = 'Storm Water Construction';
const SUB  = 'Trench Drain Excavation';
const ITEM = { id: 'bi-1', cost_code: CC, sub_code: SUB };

// A crew day: hours booked against a sub code.
const day = (date, sub = SUB, extra = {}) =>
  Object.assign({ date, cost_code: CC, sub_code: sub, labor_hours: 8, quantity: 0 }, extra);

for (const file of FILES) {
  console.log(`\n[${file}]`);
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const { _workDaysForItems, _workDaySpanLabel, _autoBidDates, autoBidDates,
          _schedBidDates, _bidDateCellHTML, setProj } = load(src);

  const auto = (rows, item = ITEM) => { setProj({ id: 'p1', dailyRows: rows }); return autoBidDates(item, 'p1'); };

  console.log('  — the two ends of the record');
  const AUG = [day('2026-08-04'), day('2026-08-03'), day('2026-08-06')];
  assert('the start is the first day work was booked', auto(AUG).start === '2026-08-03', auto(AUG).start);
  assert('the target is the latest day work was booked', auto(AUG).target === '2026-08-06', auto(AUG).target);
  assert('the rows can arrive in any order', auto([...AUG].reverse()).start === '2026-08-03');
  const ONE = [day('2026-07-06')];
  assert('one day worked starts and targets the same date',
    auto(ONE).start === '2026-07-06' && auto(ONE).target === '2026-07-06');
  assert('a gap between work days does not move either end',
    auto([day('2026-08-01'), day('2026-08-05')]).start === '2026-08-01' &&
    auto([day('2026-08-01'), day('2026-08-05')]).target === '2026-08-05');

  console.log('  — nothing worked yet');
  assert('no rows → two blanks, not nulls', auto([]).start === '' && auto([]).target === '');
  assert('another sub code\'s days do not fill this line in',
    auto([day('2026-08-03', 'Structure Excavation')]).start === '');
  // A PO line writes a job row: a date, a supplier and a cost, but no work.
  assert('a material delivery does not start the line', auto([
    { date: '2026-08-02', cost_code: CC, sub_code: SUB, material_cost: '4232.80', field_type: 'Material' },
  ]).start === '');
  assert('the delivery date does count once the crew also worked it', auto([
    { date: '2026-08-02', cost_code: CC, sub_code: SUB, material_cost: '4232.80' },
    day('2026-08-02'),
  ]).start === '2026-08-02');
  assert('no project → two blanks', (setProj(null), autoBidDates(ITEM, 'p1').start) === '');

  console.log('  — the same days the Days Worked column counts');
  // The invariant the whole feature rests on: the two dates are the ends of
  // the very list the count and its span label are built from.
  setProj({ id: 'p1', dailyRows: AUG });
  const days = _workDaysForItems([ITEM], 'p1');
  const ends = _autoBidDates(days);
  assert('start and target are the first and last of that list',
    ends.start === days[0] && ends.target === days[days.length - 1]);
  assert('so the span printed under the count agrees with them',
    _workDaySpanLabel(days) === 'Aug 3 – Aug 6', _workDaySpanLabel(days));
  assert('an equipment-only day is a day here too, exactly as it is there',
    auto([day('2026-08-03', SUB, { labor_hours: 0, equip_hours: 6 })]).start === '2026-08-03');

  console.log('  — the box on the row');
  const cell = (b, field, autoVal) => _bidDateCellHTML('p1', b, field, autoVal);
  const autoStart = cell(ITEM, 'start_date', '2026-08-03');
  assert('an auto date is shown in the box', /value="2026-08-03"/.test(autoStart));
  assert('and marked as auto-filled', /class="bid-date-auto"/.test(autoStart));
  assert('and still coloured as a start date', /color:var\(--green\)/.test(autoStart));
  const autoTarget = cell(ITEM, 'target_date', '2026-08-06');
  assert('a target date keeps its own colour', /color:var\(--blue\)/.test(autoTarget));
  assert('the tooltip says where the date came from',
    /title="From the daily sheets[^"]*latest day work was booked/.test(autoTarget));

  const typed = cell({ id: 'bi-1', start_date: '2026-07-20' }, 'start_date', '2026-08-03');
  assert('a typed date outranks the auto one', /value="2026-07-20"/.test(typed));
  assert('and is not dimmed like an auto one', !/bid-date-auto/.test(typed));
  assert('its tooltip says how to hand the line back', /Clear it to go back to the first day/.test(typed));

  const empty = cell(ITEM, 'start_date', '');
  assert('nothing worked and nothing typed → an empty box', /value=""/.test(empty));
  assert('an empty box is muted, not green', /color:var\(--muted\)/.test(empty) && !/bid-date-auto/.test(empty));
  assert('an empty box says the column fills itself in', /Fills itself in from the first day/.test(empty));

  assert('every box commits through the one handler',
    /onchange="_bidDateCommit\(this,'p1','bi-1','start_date'\)"/.test(autoStart) &&
    /onchange="_bidDateCommit\(this,'p1','bi-1','target_date'\)"/.test(autoTarget));
  assert('no tooltip breaks out of its attribute',
    [autoStart, autoTarget, typed, empty].every(h => !/title="[^"]*"[^>]*"[^>]*>/.test(h.split('\n')[0])));

  // ── Wiring ────────────────────────────────────────────────────────────────
  console.log('  — wiring');
  const render = extractFunction(src, 'renderBidTable');
  assert('the row derives both dates from the days it already counted',
    /const _auto   = _autoBidDates\(_wDays\);/.test(render));
  assert('and does not scan the daily rows a second time to do it',
    (render.match(/_workDaysForItems\(\[b\], projId\)/g) || []).length === 1);
  assert('both boxes are built by the shared cell',
    /_bidDateCellHTML\(projId, b, 'start_date',\s+_auto\.start\)/.test(render) &&
    /_bidDateCellHTML\(projId, b, 'target_date', _auto\.target\)/.test(render));
  assert('nothing types the old hand-rolled date input any more',
    !/updateBidItem\('\$\{projId\}','\$\{b\.id\}','(start|target)_date'/.test(render));
  assert('the dimmed-italic style ships with the page',
    /\.bid-table td input\.bid-date-auto \{[^}]*font-style: italic/.test(src));

  console.log('  — an auto date is shown, not saved');
  const commit = extractFunction(src, '_bidDateCommit');
  assert('only what the box holds is written down', /updateBidItem\(projId, itemId, field, el\.value\);/.test(commit));
  assert('clearing the box refills it from the daily sheets',
    /const auto = \(!el\.value && item\)/.test(commit) && /if \(auto\) el\.value = auto;/.test(commit));
  assert('and re-marks it as auto-filled', /el\.classList\.toggle\('bid-date-auto', !!auto\);/.test(commit));

  // ── Where a line sits on a calendar ──────────────────────────────────────
  console.log('  — the dates a drawing places a line by');
  const placed = (rows, b) => { setProj({ id: 'p1', dailyRows: rows }); return _schedBidDates(b, 'p1'); };
  const WORKED = [day('2026-08-03'), day('2026-08-06')];

  const planned = placed(WORKED, { ...ITEM, start_date: '2026-07-01', target_date: '2026-07-31' });
  assert('a typed plan is used as the plan',
    planned.start === '2026-07-01' && planned.target === '2026-07-31');
  assert('and is not marked as coming from the sheets',
    planned.auto === false && planned.autoStart === false && planned.autoTarget === false);

  const fromSheets = placed(WORKED, ITEM);
  assert('a line with no plan is placed by the days it was worked',
    fromSheets.start === '2026-08-03' && fromSheets.target === '2026-08-06');
  assert('and both ends are marked as the sheets\'',
    fromSheets.auto === true && fromSheets.autoStart === true && fromSheets.autoTarget === true);

  const halfStart = placed(WORKED, { ...ITEM, start_date: '2026-07-01' });
  assert('a typed start keeps its end and the sheets fill the other',
    halfStart.start === '2026-07-01' && halfStart.target === '2026-08-06');
  assert('and only that other end is marked',
    halfStart.autoStart === false && halfStart.autoTarget === true && halfStart.auto === true);

  const halfTarget = placed(WORKED, { ...ITEM, target_date: '2026-09-30' });
  assert('a typed target does the same the other way round',
    halfTarget.start === '2026-08-03' && halfTarget.target === '2026-09-30' &&
    halfTarget.autoStart === true && halfTarget.autoTarget === false);

  const nowhere = placed([], ITEM);
  assert('nothing typed and nothing worked → nowhere to draw it',
    nowhere.start === '' && nowhere.target === '' && nowhere.auto === false);

  // ── What must NOT read those dates ───────────────────────────────────────
  console.log('  — what keeps measuring against the plan alone');
  // The projection scales spend by elapsed-vs-planned duration. Auto dates are
  // the days already worked, so that branch would divide a span by itself and
  // hand back the actual cost — every started line projecting in at exactly
  // what it has spent.
  const proj = extractFunction(src, 'projForBidItem');
  assert('the cost projection reads only the typed dates',
    /if \(b\.start_date && b\.target_date\) \{/.test(proj) &&
    !/autoBidDates|_schedBidDates/.test(proj));
  // Pace, required rate and status all score the job against its deadline. The
  // latest day worked is behind us, so feeding it in marks everything late or
  // finished on the nose.
  const calc = extractFunction(src, '_schedCalcRow');
  assert('pace and status read only the typed dates',
    /const biDeadline  = bi\.target_date \|\| deadline;/.test(calc) &&
    !/autoBidDates|_schedBidDates/.test(calc));

  // ── The Gantt chart ──────────────────────────────────────────────────────
  console.log('  — the Gantt chart');
  const gantt = extractFunction(src, '_renderGanttModal');
  assert('every line is placed once, up front',
    /const gDates = new Map\(\);/.test(gantt) &&
    (gantt.match(/_schedBidDates\(bi, proj\.id\)/g) || []).length === 1);
  assert('the chart window covers the days worked as well as the plans',
    /if \(d\.start\)  allMs\.push/.test(gantt) && /if \(d\.target\) allMs\.push/.test(gantt));
  assert('the bar is drawn between them',
    /const barS   = gd\.start  \|\| todayStr;/.test(gantt) &&
    /const barE   = gd\.target \|\| deadline;/.test(gantt));
  assert('a bar the sheets supplied is dashed',
    /const dash = gd\.auto \? ' stroke-dasharray="4 2\.5"' : '';/.test(gantt) &&
    (gantt.match(/stroke-width="1"\$\{dash\}/g) || []).length === 3);
  assert('the tooltip says which end is the sheets\'',
    /gd\.autoStart  \? 'First Worked' : 'Start'/.test(gantt) &&
    /gd\.autoTarget \? 'Last Worked'  : 'Target'/.test(gantt));
  assert('the project deadline no longer poses as a target',
    /\$\{gd\.target \? `<span class="lbl">/.test(gantt));
  // The whole point of keeping the plan separate: nothing is late against a
  // span that ends on the last day somebody worked.
  assert('late and early are scored against the plan',
    /const planE  = bi\.target_date \|\| deadline;/.test(gantt) &&
    /const lateEarly = projFMs && planEMs/.test(gantt) &&
    !/lateEarly = projFMs && barEMs/.test(gantt));
  assert('and so is the projected-finish diamond',
    /projFMs > \(planEMs \|\| todayMs\)/.test(gantt));
  assert('the dashed bars are explained under the chart',
    /const autoRows = bidItems\.filter\(bi => gDates\.get\(bi\)\.auto\)\.length;/.test(gantt) &&
    /Dashed bars are drawn from the daily sheets/.test(gantt) &&
    /container\.innerHTML = svg \+ caption;/.test(gantt));

  console.log('  — the Gantt button');
  const schedTab = extractFunction(src, 'renderScheduleTab');
  assert('the chart opens for a job nobody has dated by hand',
    /const hasGanttData = hasBidItems && \(proj\.bidItems \|\| \[\]\)\.some\(bi => _schedBidDates\(bi, proj\.id\)\.start\);/.test(schedTab));

  console.log('  — the printed Gantt');
  const gpdf = extractFunction(src, 'printGanttPDF');
  assert('it places lines by the same rule as the screen',
    /const gDates = new Map\(\);/.test(gpdf) &&
    /const barStartStr = gd\.start  \|\| todayStr;/.test(gpdf) &&
    /const barEndStr   = gd\.target \|\| deadline;/.test(gpdf));
  assert('the range covers them too',
    /if \(d\.start\)  allDates\.push/.test(gpdf) && /if \(d\.target\) allDates\.push/.test(gpdf));
  assert('a sheets-supplied bar prints dashed',
    /const dash = gd\.auto \? ' stroke-dasharray="3\.5 2"' : '';/.test(gpdf) &&
    (gpdf.match(/stroke-width="1"\$\{dash\}/g) || []).length === 3);
  assert('the diamond is still scored against the plan',
    /const planEndStr  = bi\.target_date \|\| deadline;/.test(gpdf) &&
    /projFinMs > \(planEndMs \|\| todayMs\)/.test(gpdf));
  assert('and the sheet says what a dashed bar means',
    /Dashed bar = drawn from the daily sheets, no dates entered/.test(gpdf));

  console.log('  — the pace table');
  const pace = extractFunction(src, 'renderScheduleProjectDetail');
  assert('the two chips under the cost code are placed by the shared rule',
    /const schedDates    = _schedBidDates\(bi, proj\.id\);/.test(pace) &&
    /const startDateFmt  = schedDates\.start  \? _schedDFmt\(schedDates\.start\)  : null;/.test(pace) &&
    /const targetDateFmt = schedDates\.target \? _schedDFmt\(schedDates\.target\) : null;/.test(pace));
  assert('a date the sheets supplied says so and is dimmed',
    /schedDates\.autoStart \? 'First worked' : 'Start'/.test(pace) &&
    /schedDates\.autoTarget \? 'Last worked' : 'Target'/.test(pace) &&
    (pace.match(/opacity:0\.6;font-style:italic/g) || []).length === 2);
  assert('and its tooltip says what it is and what still measures the plan',
    /No start date entered — this is the first day the crew booked work/.test(pace) &&
    /never against this date/.test(pace));
  // Everything else on the row scores the job against its deadline, so it has
  // to stay on the typed target.
  assert('the projected-finish column still compares against the plan',
    /const deadlineToCompare = bi\.target_date \|\| deadline;/.test(pace));
  // A not-started line carries a typed future start by definition, so the pill
  // can read the resolved date without ever printing one off the sheets.
  assert('the "Starts …" pill still reads a real start date',
    /not-started">Starts \$\{startDateFmt \|\| '\?'\}/.test(pace));

  console.log('  — the printed pace table');
  const spdf = extractFunction(src, 'printSchedulePDF');
  assert('it prints the same two dates the screen shows',
    /const pdfDates = _schedBidDates\(bi, proj\.id\);/.test(spdf) &&
    /\$\{pdfDates\.start \? `<div style="font-size:8px;color:#15803d/.test(spdf) &&
    /\$\{pdfDates\.target \? `<div style="font-size:8px;color:#[0-9a-f]{6}/.test(spdf));
  assert('a sheets-supplied date prints in italics and says which end it is',
    (spdf.match(/font-style:italic;opacity:0\.8/g) || []).length === 2 &&
    /pdfDates\.autoStart \? ' first worked' : ''/.test(spdf) &&
    /pdfDates\.autoTarget \? ' last worked' : ''/.test(spdf));
  assert('the projection still scores against the typed target',
    /const pdfDeadlineCompare = bi\.target_date \|\| deadline;/.test(spdf) &&
    /: status === 'not-started' \? `Starts \$\{bi\.start_date \|\| '\?'\}`/.test(spdf));
  assert('and the sheet explains the italics under the table',
    /A cost code with no date entered shows the daily sheets instead, in italics/.test(spdf) &&
    /never against an italic date/.test(spdf));

  console.log('  — the job summary schedule page');
  const sched = extractFunction(src, '_jsBidScheduleHtml');
  assert('a worked line earns a place on the chart',
    /\.map\(bi => \(\{ bi, d: _schedBidDates\(bi, proj\.id\) \}\)\)/.test(sched) &&
    /\.filter\(x => x\.d\.start \|\| x\.d\.target\)/.test(sched));
  assert('and is drawn between the dates it was placed by',
    /startMs: d\.start  \? _jsMs\(d\.start\)  : null,/.test(sched) &&
    /endMs:   d\.target \? _jsMs\(d\.target\) : \(deadline \? _jsMs\(deadline\) : null\),/.test(sched));
  assert('the plan is carried separately for the scoring',
    /planMs:  bi\.target_date \? _jsMs\(bi\.target_date\) : \(deadline \? _jsMs\(deadline\) : null\),/.test(sched) &&
    /const col = r\.projMs > \(r\.planMs \|\| todayMs\) \? '#dc2626'/.test(sched) &&
    /const lateFin = r\.projMs && r\.planMs && r\.projMs > r\.planMs;/.test(sched));
  assert('a sheets-supplied span is dashed here as well',
    /const dash = r\.d\.auto \? ' stroke-dasharray="3 2"' : '';/.test(sched) &&
    (sched.match(/stroke-width="0\.9"\$\{dash\}/g) || []).length === 3);
  assert('the detail table prints those dates in italics',
    /<td\$\{r\.d\.autoStart  \? ' class="auto"' : ''\}>/.test(sched) &&
    /<td\$\{r\.d\.autoTarget \? ' class="auto"' : ''\}>/.test(sched) &&
    /\.sched-table td\.auto \{ color: #6b7280; font-style: italic; \}/.test(src));
  assert('the legend and the note explain the dashed bars',
    /Drawn from the daily sheets — no dates entered/.test(sched) &&
    /dashed, across the first to the latest day the crew booked work to it/.test(sched) &&
    /never against a dashed span/.test(sched));

  // ── The printed / emailed report ─────────────────────────────────────────
  console.log('  — the printed report');
  const pdf = extractFunction(src, 'exportBidPDF');
  assert('it prints the same two dates the screen shows', /\$\{dateCells\(b\)\}/.test(pdf));
  assert('falling back to the daily sheets the same way',
    /const auto = autoBidDates\(b, projId\);/.test(pdf) &&
    /cell\(b\.start_date, auto\.start\) \+ cell\(b\.target_date, auto\.target\)/.test(pdf));
  assert('an auto date prints in italics so the two are told apart',
    /manual \? '' : 'auto'/.test(pdf) && /td\.auto \{ color: #555; font-style: italic; \}/.test(pdf));
  assert('and the report says which is which',
    /Dates in italics are the sheets'; a date in plain type was entered by hand/.test(pdf));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
