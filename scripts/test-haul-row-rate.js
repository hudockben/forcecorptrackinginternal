#!/usr/bin/env node
'use strict';
/**
 * Which of a haul day's rows the truck actually paid for.
 *
 * Run: node scripts/test-haul-row-rate.js
 *
 * A driver's labour is inside the truck's hourly rate — the triaxle at $121/h is
 * the truck AND the man in it — so a haul row posts a $0 labour rate. That was
 * decided once for the whole day, off timesheet_entries.haul_type, and it is
 * wrong for the commonest complicated day there is: a man who hauls to the job,
 * gets out, and works it.
 *
 * Marked as one haul, his site labour posted at $0. The job got that work for
 * nothing, he dropped out of its crew-size and units-per-man-hour denominators
 * (a haul stamp takes the hours out of both), and on a prevailing-wage job his
 * hours on the covered site were paid at the standard rate. He is supposed to
 * file the two halves as separate job blocks; plenty of days arrive as one, and
 * payroll is where it gets caught.
 *
 * So the ROW decides, on the only fact that means anything: whether the truck is
 * on it. His labour is bought by the truck exactly when he is inside it.
 *
 * Three rules, in order:
 *   1. Travel outranks everything. The commute is not the truck's time.
 *   2. An explicit is_haul from the approver wins.
 *   3. Otherwise the truck decides — NAMED, with HOURS, and actually the unit
 *      the driver said he hauled with. "Any machine counts" puts the original
 *      bug back one machine over: 6.50 h in the triaxle then 2.50 h on the site
 *      running a roller is a second row with a unit and hours on it, and reading
 *      that as the haul zeroes his roller time exactly as marking the whole day
 *      did.
 *
 * And the answer is STORED, in all three states — daily_tracking.is_haul. An
 * absent stamp used to mean two things at once ("he was working" and "nobody
 * asked"), which the refresh-rates sweep could only guess at; it guessed wrong
 * and put the $0 back on every run. A row approved before that column existed
 * has only its stamp, so the stamp is read as the legacy "it was a haul".
 *
 * These are the real functions out of api/timesheet-entries.js. The pricing
 * expression and the sweep that re-rates approved rows are read from source,
 * because both are inline in code that needs a database to run.
 */

const fs   = require('fs');
const path = require('path');
const T    = require(path.resolve(__dirname, '../api/timesheet-entries.js'))._test;
const { truckOnRow, isHaulWorkRow, haulWorkHoursOf, haulTypeOf } = T;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');
// Available to any assertion below that needs a whole function rather than a
// line of it — one shared brace matcher, see scripts/lib/fn-source.js.
const { fnSource } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const row = over => Object.assign(
  { cost_code: 'Notch Milling 9.5MM', sub_code: 'Milling - Trucking',
    labor_hours: 8, equipment: '', equip_hours: 0 }, over);
const OFF = { haul_type: 'off_site' };
const ON  = { haul_type: 'on_site' };
const NOT = { haul_type: null };

console.log('\n[is the truck on this row?]');

const TRIAXLE = { truck_unit: 'Triaxle Dump' };
assert('a named unit with hours against it', truckOnRow(row({ equipment: 'Triaxle Dump', equip_hours: 6.5 })) === true);
assert('a named unit with NO hours buys nothing',
  truckOnRow(row({ equipment: 'Triaxle Dump', equip_hours: 0 })) === false);
assert('hours with no unit buy nothing either',
  truckOnRow(row({ equipment: '', equip_hours: 6.5 })) === false);
assert('whitespace is not a unit',
  truckOnRow(row({ equipment: '   ', equip_hours: 6.5 })) === false);
assert('a bare row', truckOnRow(row()) === false);
assert('and nothing at all does not throw', truckOnRow(null) === false);

// And it has to be THE truck. A driver on the site running a second machine is
// not in his truck, and pricing that row as a haul is the original bug wearing
// a different unit.
assert('the truck the driver named is the truck',
  truckOnRow(row({ equipment: 'Triaxle Dump', equip_hours: 6.5 }), TRIAXLE) === true);
assert('  and a roller he ran on the site is not, however many hours it has',
  truckOnRow(row({ equipment: 'Roller', equip_hours: 2.5 }), TRIAXLE) === false);
assert('  spelling is compared case-insensitively, not by identity',
  truckOnRow(row({ equipment: 'triaxle dump', equip_hours: 6.5 }), TRIAXLE) === true);
assert('where the driver named no truck there is nothing better, so any machine counts',
  truckOnRow(row({ equipment: 'Roller', equip_hours: 2.5 }), {}) === true);

console.log('\n[a machine on the row is not the same question as the truck]');

// Conflating them got the warning wrong: "is this the truck he hauled with"
// decides whether to ASSUME the row is a haul; "is any machine priced here"
// decides whether the row costs the job anything at all.
{
  const lowboy = row({ equipment: 'Lowboy', equip_hours: 3, labor_hours: 3 });
  assert('a lowboy on a triaxle day is not the named truck',
    truckOnRow(lowboy, TRIAXLE) === false);
  assert('  but it is unquestionably priced, so the row does cost the job something',
    T.pricedMachineOnRow(lowboy) === true);
  // Priced AND not the truck is the pair worth asking the approver about. The
  // question itself is the modal's — see splitUnnamedMachineRows in payroll.html
  // and its coverage in test-haul-unpriced-warning.js; the server holds only the
  // two predicates it is composed from, because the server has nobody to ask.
  const oddPair = r => T.pricedMachineOnRow(r) && !truckOnRow(r, TRIAXLE);
  assert('  and that pair is what makes it worth asking about', oddPair(lowboy) === true);
  assert('the named truck is never one of them',
    oddPair(row({ equipment: 'Triaxle Dump', equip_hours: 6.5 })) === false);
  assert('nor is a bare row — there is no machine on it to wonder about',
    oddPair(row()) === false);
  assert('nor a unit with no hours, which bills nothing either way',
    oddPair(row({ equipment: 'Lowboy', equip_hours: 0 })) === false);
  assert('and the server keeps no unused copy of the question it cannot answer',
    T.unnamedMachineOnRow === undefined
    && !/function unnamedMachineOnRow\(/.test(src));
}

console.log('\n[which rows the haul pays for]');

{
  // Rick's day on Libby Phillipsburg, as filed: one 9-hour block answered
  // "to & from", split by payroll into the driving and the labouring.
  const driving  = row({ labor_hours: 6.5, equipment: 'Triaxle Dump', equip_hours: 6.5 });
  const labour   = row({ labor_hours: 2.5, sub_code: 'Scratch/leveling - Labor' });
  assert('the hours in the truck are the haul', isHaulWorkRow(driving, 'off_site') === true);
  assert('the hours on the site are not — the job owes him for those',
    isHaulWorkRow(labour, 'off_site') === false);
  assert('  and the same holds for an on-site haul',
    isHaulWorkRow(driving, 'on_site') === true && isHaulWorkRow(labour, 'on_site') === false);
}
{
  assert('nothing is a haul on a day nobody called one',
    isHaulWorkRow(row({ equipment: 'Triaxle Dump', equip_hours: 8 }), null) === false);
  assert('  not even a row ticked as one',
    isHaulWorkRow(row({ is_haul: true }), null) === false);
}

console.log('\n[the approver overrules the truck, in both directions]');

assert('ticked with no truck named: still the haul, still $0',
  isHaulWorkRow(row({ is_haul: true }), 'off_site') === true);
assert('unticked with the truck right there: not the haul, and he gets paid',
  isHaulWorkRow(row({ is_haul: false, equipment: 'Triaxle Dump', equip_hours: 8 }), 'off_site') === false);
assert('anything that is not true or false is not an answer — the truck decides',
  isHaulWorkRow(row({ is_haul: 'yes', equipment: 'Triaxle Dump', equip_hours: 8 }), 'off_site') === true
  && isHaulWorkRow(row({ is_haul: 'yes' }), 'off_site') === false);
assert('  including undefined, which is what an untouched row sends',
  isHaulWorkRow(row({ is_haul: undefined, equipment: 'Triaxle Dump', equip_hours: 8 }), 'off_site') === true);

// A client that has never heard of the tick must still get the same answer as
// one that has — otherwise the rule lives in the browser, not on the server.
assert('a payload with no is_haul key at all prices exactly as the modal shows it',
  isHaulWorkRow({ equipment: 'Triaxle Dump', equip_hours: 8, labor_hours: 8 }, 'off_site') === true
  && isHaulWorkRow({ equipment: '', equip_hours: 0, labor_hours: 8 }, 'off_site') === false);

console.log('\n[what the entry records as hauled]');

{
  const rows = [
    row({ labor_hours: 6.5, equipment: 'Triaxle Dump', equip_hours: 6.5 }),
    row({ labor_hours: 2.5, sub_code: 'Scratch/leveling - Labor' }),
  ];
  assert('only the hours the truck bought', haulWorkHoursOf(OFF, rows) === 6.5);
  assert('  and on an on-site haul too', haulWorkHoursOf(ON, rows) === 6.5);
}
{
  // Travel is already standard-rate on its own rule. Counting it here as well
  // would let prevailing + standard stop adding up to what the man is owed.
  const rows = [
    row({ labor_hours: 6, equipment: 'Triaxle Dump', equip_hours: 6 }),
    row({ labor_hours: 1, is_travel: true, equipment: 'Triaxle Dump', equip_hours: 1 }),
  ];
  assert('travel never counts, even with the truck on it', haulWorkHoursOf(OFF, rows) === 6);
  assert('  nor does a row on a travel code without the tick',
    haulWorkHoursOf(OFF, [row({ labor_hours: 4, sub_code: 'Mobilization - Travel',
                                equipment: 'Triaxle Dump', equip_hours: 4 })]) === 0);
}
assert('a day that is not a haul records nothing at all',
  haulWorkHoursOf(NOT, [row({ equipment: 'Triaxle Dump', equip_hours: 8 })]) === null);
assert('a haul day where no row carries the truck records zero, not null',
  haulWorkHoursOf(OFF, [row()]) === 0);
assert('an empty split is zero, not a crash', haulWorkHoursOf(OFF, []) === 0);
assert('and so is a missing one', haulWorkHoursOf(OFF, null) === 0);
assert('fractions survive to the cent',
  haulWorkHoursOf(OFF, [
    row({ labor_hours: 2.25, equipment: 'Lowboy', equip_hours: 2.25 }),
    row({ labor_hours: 3.5,  equipment: 'Lowboy', equip_hours: 3.5 }),
  ]) === 5.75);

console.log('\n[the rate the row is actually written with]');

// insertSplitRows needs a database, so the expression is read from source. It
// is one line and it decides every dollar on the injected row.
const insert = src.slice(src.indexOf('async function insertSplitRows('),
                         src.indexOf('async function removeSplitRows('));
assert('travel still outranks the haul, and keeps its own rate',
  /const isHaulRow = !isTravel && isHaulWorkRow\(r, haulType, entry\);/.test(insert));
assert('  and the entry goes with it, so the rule knows which unit was the truck',
  /isHaulWorkRow\(r, haulType, entry\)/.test(insert));
// An absent stamp meant two things at once — "he was working" and "nobody
// asked" — so the approver's decision had to be written down somewhere the
// re-rate sweep could read it.
assert('an explicit "not a haul" is stored, not merely left unstamped',
  /material_cost, quantity, timesheet_entry_id, is_haul/.test(insert)
  && /r\.is_haul === true \|\| r\.is_haul === false \? r\.is_haul : null/.test(insert));
assert('a haul row is written at 0 and every other row at its real rate',
  /\$\{isHaulRow \? 0 : \(isTravel \? travelRate : workRate\)\}/.test(insert));
assert('the stamp follows the same answer, so the rate and the marker cannot disagree',
  /const fieldType = isTravel \? 'Travel' : \(isHaulRow \? HAUL_FIELD_TYPE\[haulType\] : null\);/
    .test(insert));

console.log('\n[the re-rate sweep does not walk over the approver]');

// refresh-rates re-prices every injected row in a date range. It used to read
// the haul answer off the ENTRY alone and re-stamp every non-travel row, which
// would put the $0 straight back onto the site-labour row on the next run.
// Wide enough to reach the audit record at the end of the branch: the
// haul_hours adjustment and the line naming whose prevailing split moved both
// live past where the old 12000-char window stopped.
const sweep = src.slice(src.indexOf("req.query.action === 'refresh-rates'"),
                        src.indexOf("req.query.action === 'refresh-rates'") + 16000);
assert('it reads the stamp already on the row',
  /const stamped\s*=\s*HAUL_FIELD_TYPE_RE\.test\(String\(r\.field_type \|\| ''\)\)/.test(sweep));
assert('  and hands the truck plus that stored answer to the rule the approval uses',
  /isHaulWorkRow\(\{[\s\S]{0,160}?equip_hours:\s*r\.equip_hours,\s*\n\s*\.\.\.stored,/.test(sweep));
assert('  which means it needs the equipment hours, so it selects them',
  (src.match(/dt\.equipment, dt\.equip_unit_cost, dt\.equip_hours,/g) || []).length === 2);
assert('travel still outranks it here too',
  /!travelRow && isHaulWorkRow\(/.test(sweep));
assert('a row that is no longer a haul is re-priced AND un-stamped',
  /: \(stamped \? null : \(r\.field_type \|\| null\)\)/.test(sweep));
assert('  and the stamp is tested once, not three times over the same value',
  (sweep.match(/HAUL_FIELD_TYPE_RE\.test/g) || []).length === 1);
assert('the stored exemption outranks the truck, so the sweep cannot re-haul a row',
  /const stored    = storedHaulAnswer\(r\);/.test(sweep)
  && T.storedHaulAnswer({ is_haul: false }).is_haul === false);
assert('  which means it reads that column, and the truck the driver named',
  (src.match(/dt\.cost_code, dt\.sub_code, dt\.is_haul,/g) || []).length === 2
  && (src.match(/te\.haul_type, te\.truck_unit/g) || []).length === 2);
// A row that changes sides moves exactly its own labour hours in or out of the
// hauled total. ADJUSTED, not cleared: null means "the whole day was hauled",
// so clearing on a row LEAVING the haul moved MORE of the man's hours to
// standard rather than fewer — a supervisor re-coding the driving row onto a
// travel code was enough to strip the prevailing premium off hours he really
// worked on the covered site.
assert('a row that changes sides adjusts its entry\'s haul_hours by its own hours',
  /if \(stamped !== !!haulType && r\.timesheet_entry_id\) \{/.test(sweep)
  && /seen\.delta \+= \(haulType \? 1 : -1\) \* \(Number\(r\.labor_hours\) \|\| 0\);/.test(sweep));
assert('  starting from the whole day when nothing was ever recorded',
  /COALESCE\(te\.haul_hours, m\.work\) \+ m\.delta/.test(sweep));
// One statement for every entry that moved, not one per entry: a loop of
// awaited updates costs a round-trip each, and the first sweep over a wide
// range after a deploy is exactly when there are most of them.
assert('  and written for every moved entry in a single statement',
  /FROM unnest\(\$\{movedIds\}::bigint\[\], \$\{movedDeltas\}::numeric\[\], \$\{movedWork\}::numeric\[\]\)/
    .test(sweep)
  && !/for \(const \[id, moved\] of haulHoursMoved\)/.test(sweep));
assert('  and clamped to the day at both ends, so the split still adds up',
  /GREATEST\(0, LEAST\(/.test(sweep));
assert('  which needs the row\'s hours and the day\'s, so it selects both',
  (src.match(/dt\.timesheet_entry_id, dt\.labor_hours,/g) || []).length === 2
  && (src.match(/te\.computed_hours/g) || []).length === 2);
assert('a sweep that moves somebody\'s prevailing split says whose',
  /haul_hours_reclassified: reclassified/.test(sweep) && /reclassified,/.test(sweep));

// The three rules, evaluated the way the sweep evaluates them.
const asSweep = (r, entryHaul) => {
  const stamped = T.HAUL_FIELD_TYPE_RE.test(String(r.field_type || ''));
  const travel  = String(r.field_type || '') === 'Travel'
    || T.isTravelSplitRow({ cost_code: r.cost_code, sub_code: r.sub_code });
  return (!travel && isHaulWorkRow(
    Object.assign({ equipment: r.equipment, equip_hours: r.equip_hours },
                  stamped ? { is_haul: true } : null,
                  r.is_haul === false ? { is_haul: false } : null),
    haulTypeOf({ haul_type: entryHaul }), r)) ? haulTypeOf({ haul_type: entryHaul }) : null;
};

assert('a stamped row keeps its stamp and its $0, run after run',
  asSweep({ field_type: 'Haul — To/From Site', equipment: '', equip_hours: 0 }, 'off_site') === 'off_site');
assert('the site-labour row the approver un-hauled stays un-hauled',
  asSweep({ field_type: null, equipment: '', equip_hours: 0, sub_code: 'Scratch/leveling - Labor' }, 'off_site') === null);
assert('a row posted before the driver was flagged still self-heals — it carries the truck',
  asSweep({ field_type: null, equipment: 'Triaxle Dump', equip_hours: 6.5 }, 'off_site') === 'off_site');
// THE ONE THE SWEEP GOT WRONG. He hauled in the triaxle and then ran a roller
// on the site; payroll unticked that row so the job pays him for it. Without
// the stored exemption, "any machine with hours is the truck" re-stamped it and
// put the $0 back on every run — silently, for as long as anyone kept running.
assert('a second machine on a haul day is not the truck, so it is left alone',
  asSweep({ field_type: null, equipment: 'Roller', equip_hours: 2.5,
            truck_unit: 'Triaxle Dump' }, 'off_site') === null);
assert('and the stored exemption holds even against the truck itself',
  asSweep({ field_type: null, equipment: 'Triaxle Dump', equip_hours: 6.5,
            truck_unit: 'Triaxle Dump', is_haul: false }, 'off_site') === null);
assert('and a day no longer called a haul loses the stamp it had',
  asSweep({ field_type: 'Haul — To/From Site', equipment: 'Triaxle Dump', equip_hours: 6.5 }, null) === null);
assert('travel is never re-stamped as a haul, whatever the entry says',
  asSweep({ field_type: 'Travel', equipment: 'Triaxle Dump', equip_hours: 6.5 }, 'off_site') === null);

console.log('\n[the column that carries it]');

assert('haul_hours is added to timesheet_entries',
  /ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS haul_hours NUMERIC\(6,2\);/
    .test(fs.readFileSync(path.resolve(__dirname, '../neon-schema.sql'), 'utf8')));
assert('the approval writes it from the split it is about to inject',
  /const haulHours = splitRows \? haulWorkHoursOf\(existing, splitRows\) : null;/.test(src)
  && /haul_hours          = \$\{haulHours\},/.test(src));
assert('a resplit rewrites it from the new split',
  /const rsHaulHours = haulWorkHoursOf\(existing, splitRows\);/.test(src));
assert('and it is cleared everywhere the split goes away',
  (src.match(/haul_hours\s*=\s*NULL/g) || []).length >= 2,
  `${(src.match(/haul_hours\s*=\s*NULL/g) || []).length} clears`);
// But NOT on an edit that keeps the answer. Cleared unconditionally, this had
// the same backwards sign the sweep did: null means THE WHOLE DAY WAS HAULED,
// so wiping it on an edit that kept haul_type moved a driver's site hours out
// of prevailing. Same "absent means keep" rule as haul_type beside it.
assert('  and kept by an edit that keeps the haul answer it describes',
  /haul_hours         = CASE WHEN \$\{keepHaul\}::boolean\s*\n\s*THEN haul_hours ELSE NULL END,/
    .test(src));
assert('the entry hands it to the page that reads it',
  /haul_hours:\s*r\.haul_hours != null \? Number\(r\.haul_hours\) : null,/.test(src));
assert('is_haul is added to daily_tracking, nullable so it can hold all three states',
  /ALTER TABLE daily_tracking ADD COLUMN IF NOT EXISTS is_haul BOOLEAN;/
    .test(fs.readFileSync(path.resolve(__dirname, '../neon-schema.sql'), 'utf8')));

// Reopening a split has to hand back THREE states, never two. Collapsed to a
// boolean, every row of a day that was never a haul came back as a deliberate
// "not a haul" — so an approver switching the picker to "hauled to & from site"
// re-stamped the entry and re-priced nothing at all.
assert('a stamped row reopens as a haul',
  JSON.stringify(T.storedHaulAnswer({ field_type: 'Haul — To/From Site' })) === '{"is_haul":true}');
assert('  an un-hauled row reopens as deliberately not one',
  JSON.stringify(T.storedHaulAnswer({ is_haul: false })) === '{"is_haul":false}');
// The column is authoritative; the stamp is only what a row approved before it
// existed has to go on. Without that fallback every historic haul row would
// read as "nobody said" and be re-derived from a truck many never named.
assert('  a row from before the column falls back to its stamp',
  JSON.stringify(T.storedHaulAnswer({ is_haul: null, field_type: 'Haul — On Site' })) === '{"is_haul":true}');
assert('  and the column outranks a stamp that disagrees with it',
  JSON.stringify(T.storedHaulAnswer({ is_haul: false, field_type: 'Haul — On Site' })) === '{"is_haul":false}');
assert('  and a row nobody ever answered reopens with no key at all, so the truck decides',
  T.storedHaulAnswer({ is_haul: null, field_type: null }) === null);
assert('  with one function answering that for both readers',
  /\.\.\.storedHaulAnswer\(r\),/.test(src) && /storedHaulAnswer\(r\);/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
