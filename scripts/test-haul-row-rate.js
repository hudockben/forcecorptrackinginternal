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
 *   3. Otherwise the truck decides — NAMED and with HOURS, since a unit with no
 *      hours prices at nothing and buys nothing.
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
const row = over => Object.assign(
  { cost_code: 'Notch Milling 9.5MM', sub_code: 'Milling - Trucking',
    labor_hours: 8, equipment: '', equip_hours: 0 }, over);
const OFF = { haul_type: 'off_site' };
const ON  = { haul_type: 'on_site' };
const NOT = { haul_type: null };

console.log('\n[is the truck on this row?]');

assert('a named unit with hours against it', truckOnRow(row({ equipment: 'Triaxle Dump', equip_hours: 6.5 })) === true);
assert('a named unit with NO hours buys nothing',
  truckOnRow(row({ equipment: 'Triaxle Dump', equip_hours: 0 })) === false);
assert('hours with no unit buy nothing either',
  truckOnRow(row({ equipment: '', equip_hours: 6.5 })) === false);
assert('whitespace is not a unit',
  truckOnRow(row({ equipment: '   ', equip_hours: 6.5 })) === false);
assert('a bare row', truckOnRow(row()) === false);
assert('and nothing at all does not throw', truckOnRow(null) === false);

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
  /const isHaulRow = !isTravel && isHaulWorkRow\(r, haulType\);/.test(insert));
assert('a haul row is written at 0 and every other row at its real rate',
  /\$\{isHaulRow \? 0 : \(isTravel \? travelRate : workRate\)\}/.test(insert));
assert('the stamp follows the same answer, so the rate and the marker cannot disagree',
  /const fieldType = isTravel \? 'Travel' : \(isHaulRow \? HAUL_FIELD_TYPE\[haulType\] : null\);/
    .test(insert));

console.log('\n[the re-rate sweep does not walk over the approver]');

// refresh-rates re-prices every injected row in a date range. It used to read
// the haul answer off the ENTRY alone and re-stamp every non-travel row, which
// would put the $0 straight back onto the site-labour row on the next run.
const sweep = src.slice(src.indexOf("req.query.action === 'refresh-rates'"),
                        src.indexOf("req.query.action === 'refresh-rates'") + 12000);
assert('it reads the stamp already on the row',
  /const stamped\s*=\s*HAUL_FIELD_TYPE_RE\.test\(String\(r\.field_type \|\| ''\)\)/.test(sweep));
assert('  and hands both the truck and that stamp to the same rule the approval uses',
  /isHaulWorkRow\(\{[\s\S]{0,220}?equip_hours:\s*r\.equip_hours,[\s\S]{0,220}?stamped \? \{ is_haul: true \} : null/
    .test(sweep));
assert('  which means it needs the equipment hours, so it selects them',
  (src.match(/dt\.equipment, dt\.equip_unit_cost, dt\.equip_hours,/g) || []).length === 2);
assert('travel still outranks it here too',
  /!travelRow && isHaulWorkRow\(/.test(sweep));
assert('a row that is no longer a haul is re-priced AND un-stamped',
  /HAUL_FIELD_TYPE_RE\.test\(String\(r\.field_type \|\| ''\)\) \? null : \(r\.field_type \|\| null\)/
    .test(sweep));

// The three rules, evaluated the way the sweep evaluates them.
const asSweep = (r, entryHaul) => {
  const stamped = T.HAUL_FIELD_TYPE_RE.test(String(r.field_type || ''));
  const travel  = String(r.field_type || '') === 'Travel'
    || T.isTravelSplitRow({ cost_code: r.cost_code, sub_code: r.sub_code });
  return (!travel && isHaulWorkRow(
    Object.assign({ equipment: r.equipment, equip_hours: r.equip_hours },
                  stamped ? { is_haul: true } : null),
    haulTypeOf({ haul_type: entryHaul }))) ? haulTypeOf({ haul_type: entryHaul }) : null;
};

assert('a stamped row keeps its stamp and its $0, run after run',
  asSweep({ field_type: 'Haul — To/From Site', equipment: '', equip_hours: 0 }, 'off_site') === 'off_site');
assert('the site-labour row the approver un-hauled stays un-hauled',
  asSweep({ field_type: null, equipment: '', equip_hours: 0, sub_code: 'Scratch/leveling - Labor' }, 'off_site') === null);
assert('a row posted before the driver was flagged still self-heals — it carries the truck',
  asSweep({ field_type: null, equipment: 'Triaxle Dump', equip_hours: 6.5 }, 'off_site') === 'off_site');
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
  (src.match(/haul_hours\s*=\s*NULL/g) || []).length >= 3,
  `${(src.match(/haul_hours\s*=\s*NULL/g) || []).length} clears`);
assert('the entry hands it to the page that reads it',
  /haul_hours:\s*r\.haul_hours != null \? Number\(r\.haul_hours\) : null,/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
