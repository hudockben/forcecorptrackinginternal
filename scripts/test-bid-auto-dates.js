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
    ${extractFunction(src, '_bidDateCellHTML')}
    return { _workDaysForItems, _workDaySpanLabel, _autoBidDates, autoBidDates, _bidDateCellHTML, setProj };
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
  const { _workDaysForItems, _workDaySpanLabel, _autoBidDates, autoBidDates, _bidDateCellHTML, setProj } = load(src);

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

  // The projection scales spend by elapsed-vs-planned duration. Auto dates are
  // the days already worked, so that branch would divide a span by itself and
  // hand back the actual cost — every started line projecting in at exactly
  // what it has spent. It has to keep reading the typed dates only.
  const proj = extractFunction(src, 'projForBidItem');
  assert('the projection still reads only the typed dates',
    /if \(b\.start_date && b\.target_date\) \{/.test(proj) && !/autoBidDates/.test(proj));
  const sched = extractFunction(src, '_jsBidScheduleHtml');
  assert('the schedule chart still plots only the typed dates',
    /\.filter\(bi => bi\.start_date \|\| bi\.target_date\)/.test(sched) && !/autoBidDates/.test(sched));

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
