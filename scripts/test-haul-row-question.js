#!/usr/bin/env node
'use strict';
/**
 * "Was this a haul?", asked per row.
 *
 * Run: node scripts/test-haul-row-question.js
 *
 * The question used to be asked once, above the split table, for the whole day.
 * That is the wrong shape for the commonest complicated day there is: a man who
 * hauls to the job, gets out, and works it did two different things, and only
 * the hours he spent in the truck are inside its hourly cost. One answer for
 * the day meant answering for the majority of it and correcting the rest with a
 * checkbox — and a blank answer was indistinguishable from "no", which is the
 * expensive way to be wrong: it pays the driver his wage on top of the truck
 * priced on the very same row, at the covered-site premium on a prevailing job.
 *
 * So the row is asked, and every labour row has to answer before the split can
 * be saved. Three things follow from the answer:
 *
 *   1. The Haul tick beside it — "he was in the truck" is what the question
 *      asks, so the approver says it once rather than twice.
 *   2. The row's own classification on the wire (haul_type), which is what
 *      stamps it 'Haul — On Site' or 'Haul — To/From Site' in cost tracking.
 *   3. The DAY's classification, derived from the rows rather than asked for
 *      again. Off-site wins where they disagree: it is the answer that moves
 *      hours out of prevailing, and the on-site rows are protected from it by
 *      carrying their own answer (rowHaulType on the server).
 *
 * And a reopened split must not make anyone re-answer a day nobody is changing,
 * which is what splitSeedRowHaul is for.
 *
 * Evaluates the real functions out of payroll.html and api/timesheet-entries.js
 * — no browser and no database. The browser half is test-haul-browser.js.
 */

const fs   = require('fs');
const path = require('path');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');
const fn  = name => requireFn(src, name, 'payroll.html');

const travelRe = /^\s*const TRAVEL_CODE_RE = (\/.*\/[a-z]*);$/m.exec(src);
if (!travelRe) throw new Error('payroll.html no longer defines TRAVEL_CODE_RE');
const answersBlock = /const SPLIT_HAUL_ANSWERS = \[[\s\S]*?\n    \];/.exec(src);
if (!answersBlock) throw new Error('payroll.html no longer defines SPLIT_HAUL_ANSWERS');

// The page's own rules, not a restatement of them — a second copy is a second
// place for the two to drift, and this file exists to pin what the page does.
const PRELUDE =
  `const TRAVEL_CODE_RE = ${travelRe[1]};\n` +
  `const splitHaulIs = () =>\n` +
  `  (splitHaulAnswer === 'on_site' || splitHaulAnswer === 'off_site') ? splitHaulAnswer : null;\n` +
  `${answersBlock[0]}\n` +
  `${fn('isTravelSplitRow')}\n` +
  `${fn('splitPricedMachineOnRow')}\n` +
  `${fn('splitTruckOnRow')}\n` +
  `${fn('splitRowIsHaul')}\n` +
  `${fn('splitRowHaulAnswer')}\n` +
  `${fn('splitUnansweredHaulRows')}\n` +
  `${fn('splitDeriveHaulAnswer')}\n` +
  `${fn('splitHaulMixed')}\n` +
  `${fn('splitSeedRowHaul')}\n` +
  `${fn('splitHaulCellHtml')}\n` +
  `${fn('escapeHtml')}\n` +
  `${fn('splitRowPayload')}\n` +
  `${fn('splitDestJobLabel')}\n`;

const run = (body, ctx) => new Function(
  'splitEntry', 'splitRows', 'splitHaulAnswer', 'splitDestJobsCache',
  `${PRELUDE}${body}`,
)((ctx && ctx.entry) || {}, (ctx && ctx.rows) || [],
  (ctx && ctx.day) || '', {});

const LABOUR = over => Object.assign(
  { cost_code: 'Earthwork', sub_code: 'Excess Cut', equipment: '',
    labor_hours: 8, equip_hours: 0, is_travel: false }, over);
const DRIVE = over => Object.assign(
  { cost_code: 'Mobilization', sub_code: 'Travel', equipment: '',
    labor_hours: 1, equip_hours: 0, is_travel: true }, over);

// ── The answer a row carries ───────────────────────────────────────────────
console.log('\n[the four states of the answer]');
{
  const ask = row => run(`return splitRowHaulAnswer(${JSON.stringify(row)});`);
  assert('a blank answer is no answer',           ask(LABOUR()) === '');
  assert('  and so is a missing key',             ask({ labor_hours: 8 }) === '');
  assert('  and so is something unrecognized',    ask(LABOUR({ haul_type: 'maybe' })) === '');
  assert('"no" is an answer, not an absence',     ask(LABOUR({ haul_type: 'none' })) === 'none');
  assert('and both hauls are their own answer',
    ask(LABOUR({ haul_type: 'on_site' }))  === 'on_site'
    && ask(LABOUR({ haul_type: 'off_site' })) === 'off_site');
}

console.log('\n[which rows still owe one]');
{
  const owed = rows => run('return splitUnansweredHaulRows();', { rows });
  assert('a fresh split owes an answer on every labour row',
    JSON.stringify(owed([LABOUR(), LABOUR()])) === '[1,2]');
  assert('  named by row number, the way the save names them',
    JSON.stringify(owed([LABOUR({ haul_type: 'none' }), LABOUR()])) === '[2]');
  assert('travel is never asked — the commute is not the truck\'s time',
    JSON.stringify(owed([LABOUR({ haul_type: 'none' }), DRIVE()])) === '[]');
  assert('  and neither is a row booked to a travel code without the tick',
    JSON.stringify(owed([DRIVE({ is_travel: false })])) === '[]');
  assert('nothing is owed once every row has answered',
    JSON.stringify(owed([LABOUR({ haul_type: 'off_site' }),
                         LABOUR({ haul_type: 'none' })])) === '[]');
}

// ── The day, derived from the rows ─────────────────────────────────────────
// timesheet_entries.haul_type is a per-day column and every reader of it reads
// the day. Asking for it twice — once above the table and once per row — is two
// answers that can disagree, so it is derived from the one the approver gives.
console.log('\n[the day is the sum of its rows]');
{
  const day   = rows => run('return splitDeriveHaulAnswer();', { rows });
  const mixed = rows => run('return splitHaulMixed();', { rows });
  assert('no row a haul, no haul',
    day([LABOUR({ haul_type: 'none' }), LABOUR({ haul_type: 'none' })]) === '');
  assert('  and an unanswered day is not a haul day either',
    day([LABOUR(), LABOUR()]) === '');
  assert('one on-site leg makes it an on-site haul',
    day([LABOUR({ haul_type: 'on_site' }), LABOUR({ haul_type: 'none' })]) === 'on_site');
  // Off-site is the answer with consequences — it is the one that moves hours
  // out of prevailing — so it is the one the day takes. The on-site rows are
  // not dragged with it: each row carries its own answer to the server.
  assert('off-site wins where the rows disagree',
    day([LABOUR({ haul_type: 'on_site' }), LABOUR({ haul_type: 'off_site' })]) === 'off_site');
  assert('  and that disagreement is worth saying out loud',
    mixed([LABOUR({ haul_type: 'on_site' }), LABOUR({ haul_type: 'off_site' })]) === true);
  assert('  while one kind of haul all day is not "mixed"',
    mixed([LABOUR({ haul_type: 'off_site' }), LABOUR({ haul_type: 'off_site' })]) === false);
  assert('a travel row never classifies the day',
    day([LABOUR({ haul_type: 'none' }), DRIVE({ haul_type: 'off_site' })]) === '');
}

// ── Reopening a split ──────────────────────────────────────────────────────
// Edit Split must not make anyone re-answer a day nobody is changing. Every
// source of the old answer is read before the picker is left blank.
console.log('\n[a reopened split comes back answered as it was approved]');
{
  const seed = (row, entry) => run(
    `return splitSeedRowHaul(${JSON.stringify(row)});`, { entry: entry || {} });
  const HAUL = { haul_type: 'off_site', truck_unit: 'Triaxle Dump' };

  assert('the row\'s own stamp is exact, and outranks everything',
    seed({ haul_type: 'on_site', is_haul: true }, HAUL) === 'on_site');
  assert('  which is the only way a day holding both legs reopens correctly',
    seed({ haul_type: 'off_site', is_haul: true }, { haul_type: 'on_site' }) === 'off_site');
  assert('an explicit "not a haul" reopens as No',
    seed({ is_haul: false, equipment: 'Triaxle Dump', equip_hours: 8 }, HAUL) === 'none');
  assert('a haul with no stamp takes the day\'s answer',
    seed({ is_haul: true }, HAUL) === 'off_site');
  // A split approved before the column existed says nothing at all. The truck
  // on the row is what priced it then, so it is what it reopens as now —
  // anything else silently re-prices approved work.
  assert('a row nobody answered reopens as the truck priced it',
    seed({ equipment: 'Triaxle Dump', equip_hours: 8 }, HAUL) === 'off_site');
  assert('  and a row with no truck on it reopens as No',
    seed({ equipment: '', equip_hours: 0 }, HAUL) === 'none');
  assert('  as does a named truck with no hours against it — it priced nothing',
    seed({ equipment: 'Triaxle Dump', equip_hours: 0 }, HAUL) === 'none');
  assert('  and a machine that is not the truck he named',
    seed({ equipment: 'Roller', equip_hours: 8 }, HAUL) === 'none');
  // A day approved as no haul at all was approved with the old picker's first
  // answer, which WAS "no". Reopening must not demand it again.
  assert('a day that was never a haul reopens answered "no", not blank',
    seed({ equipment: '', equip_hours: 0 }, { haul_type: null }) === 'none');
  assert('travel is never asked, however it was stored',
    seed({ is_travel: true, is_haul: true }, HAUL) === '');
}

// ── What reaches the server ────────────────────────────────────────────────
console.log('\n[what the row posts]');
{
  const post = row => run(`return splitRowPayload(${JSON.stringify(row)});`);
  const hauled = post(LABOUR({ haul_type: 'off_site', is_haul: true }));
  assert('a hauled row posts both the tick and which kind it was',
    hauled.is_haul === true && hauled.haul_type === 'off_site', JSON.stringify(hauled));
  const worked = post(LABOUR({ haul_type: 'none', is_haul: false }));
  // 'none' is carried by is_haul already. Sent as a haul_type it would reach
  // safeHaulType as an unparseable answer rather than as "not one".
  assert('a worked row posts the outright "not a haul" and no kind',
    worked.is_haul === false && !('haul_type' in worked), JSON.stringify(worked));
  const blank = post(LABOUR());
  assert('an unanswered row posts neither — the truck decides, as it always did',
    !('is_haul' in blank) && !('haul_type' in blank), JSON.stringify(blank));
  // The override the answer cannot express: he hauled, but the truck is billed
  // on another row or another job, so this job must pay him for the time.
  const unticked = post(LABOUR({ haul_type: 'off_site', is_haul: false }));
  assert('unticking a hauled row still pays him, and still says what it was',
    unticked.is_haul === false && unticked.haul_type === 'off_site',
    JSON.stringify(unticked));
}

// ── The cell ───────────────────────────────────────────────────────────────
console.log('\n[the cell on the row]');
{
  const cell = (row, i) => run(
    `return splitHaulCellHtml(${JSON.stringify(row)}, ${i || 0});`);
  const fresh = cell(LABOUR());
  assert('an unanswered cell is marked, the way an unpriced dust window is',
    /class="haul-pick needed"/.test(fresh), fresh);
  assert('  and offers the blank plus all three answers',
    (fresh.match(/<option/g) || []).length === 4, fresh);
  const done = cell(LABOUR({ haul_type: 'on_site' }));
  assert('an answered cell drops the mark',
    /class="haul-pick"/.test(done) && !/needed/.test(done), done);
  assert('  and shows what was answered',
    /value="on_site" selected/.test(done), done);
  assert('the answer is wired to the row it is on',
    /splitOnChange\(3,'haul_type'/.test(cell(LABOUR(), 3)));
  assert('a travel row is told why it is not asked',
    /not asked/.test(cell(DRIVE())) && !/<select/.test(cell(DRIVE())));
}

// ── The server's half ──────────────────────────────────────────────────────
// The row's answer has to survive the round trip, and daily_tracking has no
// haul_type column — the 'Haul — …' stamp IS the record.
console.log('\n[the server keeps the row\'s answer]');
{
  const T = require(path.resolve(__dirname, '../api/timesheet-entries.js'))._test;
  const api = fs.readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');

  // Through the real validator, which is what the approve and resplit handlers
  // put every posted row through.
  const norm = raw => T.validateSplit(
    [Object.assign({ cost_code: 'Earthwork', labor_hours: 8 }, raw)],
    { computed_hours: 8, travel_hours: 0 }).rows[0];
  assert('a row\'s answer is taken as given',
    norm({ haul_type: 'on_site' }).haul_type === 'on_site');
  assert('  and an unreadable one is no answer at all, not a guess',
    !('haul_type' in norm({ haul_type: 'to and from' })));
  assert('  and a row that says nothing sends nothing',
    !('haul_type' in norm({})));

  assert('the stamp is read back as the answer that wrote it',
    T.storedRowHaulType({ field_type: 'Haul — On Site' }) === 'on_site'
    && T.storedRowHaulType({ field_type: 'Haul — To/From Site' }) === 'off_site');
  assert('  whatever dash survived the copy-paste',
    T.storedRowHaulType({ field_type: 'Haul - On Site' }) === 'on_site'
    && T.storedRowHaulType({ field_type: 'Haul – To/From Site' }) === 'off_site');
  assert('  and nothing else is mistaken for one',
    T.storedRowHaulType({ field_type: 'Travel' }) === null
    && T.storedRowHaulType({ field_type: 'Haul Off' }) === null
    && T.storedRowHaulType({}) === null);

  // ?action=split is what Edit Split pre-fills from. Without the answer on
  // those rows a reopened day holding both legs flattens onto the day's one.
  const getSplit = api.slice(api.indexOf("req.query.action === 'split'"),
                             api.indexOf('// ── PUT — update fields'));
  assert('the split read-back hands the answer back with each row',
    /storedRowHaulType\(r\) \? \{ haul_type: storedRowHaulType\(r\) \}/.test(getSplit));

  // The blob tabs have no field_type column to stamp, so the stored split row
  // is the only place a trucking/dust/quarry leg's answer can live.
  const blob = api.slice(api.indexOf('function blobBoundSplitRows('),
                         api.indexOf('\n}\n', api.indexOf('function blobBoundSplitRows(')));
  assert('a row sent to a blob tab keeps its answer too',
    /row\.haul_type \? \{ haul_type: row\.haul_type \}/.test(blob));

  // haul_hours is read THROUGH the day's classification, so an on-site leg
  // counted inside an off-site day would pay the man the standard rate for
  // hours he spent on the covered site.
  const R = over => Object.assign({ cost_code: 'Earthwork', labor_hours: 0 }, over);
  assert('a day holding both legs counts only its own kind into haul_hours',
    T.haulWorkHoursOf({ haul_type: 'off_site' }, [
      R({ labor_hours: 6, haul_type: 'off_site', is_haul: true }),
      R({ labor_hours: 2, haul_type: 'on_site',  is_haul: true }),
      R({ labor_hours: 1, haul_type: 'none',     is_haul: false }),
    ]) === 6);
  assert('  and a split from before the question moved counts exactly as it did',
    T.haulWorkHoursOf({ haul_type: 'off_site' }, [
      R({ labor_hours: 6, is_haul: true }),
      R({ labor_hours: 3, is_haul: false }),
    ]) === 6);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
