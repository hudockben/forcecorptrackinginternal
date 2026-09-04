#!/usr/bin/env node
'use strict';
/**
 * A truck driver's hours: paid in full, but not always at the prevailing rate.
 *
 * Run: node scripts/test-haul-prevailing.js
 *
 * A driver hauling dirt for a prevailing-wage job used to have every one of his
 * hours counted as prevailing, because the prevailing flag is a property of the
 * PROJECT and nothing else was asked. But the premium is for work on the
 * covered site, and a man running to and from it never worked there. Worse, the
 * same driver can do both in one day — out to the job at the standard rate,
 * then hauling inside the fence at the prevailing one — so the answer cannot be
 * a property of the person or even of the day.
 *
 * It is asked per JOB BLOCK on the timesheet (timesheet_entries.haul_type), and
 * a block is already a leg: the form posts one row per block. This test pins
 * down the arithmetic that reads it, in the module the Payroll page and the
 * executive report both roll their fortnight up through.
 *
 * And a man can do BOTH INSIDE ONE BLOCK. He is meant to file the two halves
 * separately, but plenty of days arrive as one 9-hour block answered "to & from"
 * — he hauled there, got out, and worked the site. haul_type cannot say how much
 * of it was which; payroll's split can, and lands the answer on the entry as
 * haul_hours. Those hours are the truck's and fall to standard; the rest were
 * worked on the covered site and keep the premium.
 *
 * The invariant that matters most is the last one: whatever the split, a
 * worker's prevailing + standard hours must still add up to the hours he is
 * owed. Reclassifying hours must never create or destroy any.
 */

const path = require('path');
const { payrollMetrics, offSiteHaulWork } =
  require(path.resolve(__dirname, '../api/lib/payroll-metrics.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// One 'daily' entry. Defaults describe the ordinary case: 8 work hours on a
// prevailing-wage job with no travel and no hauling.
function entry(over = {}) {
  return Object.assign({
    username:       'kris',
    entry_type:     'daily',
    status:         'approved',
    division:       'turf',
    job_id:         'franklin-regional',
    work_date:      '2026-08-31',
    computed_hours: 8,
    travel_hours:   0,
    prevailing_wage: true,
    haul_type:      null,
  }, over);
}

const only = e => payrollMetrics({ entries: [e], periodStart: '2026-08-31', periodEnd: '2026-09-13' }).totals;
const near = (a, b) => Math.abs(a - b) < 0.001;

// ── The three answers ────────────────────────────────────────────────────────
console.log('\n[what each answer does to a prevailing-wage day]');

const ordinary = only(entry());
assert('no haul on a prevailing job: all 8 h prevailing',
  near(ordinary.pwHours, 8) && near(ordinary.stdHours, 0),
  `pw=${ordinary.pwHours} std=${ordinary.stdHours}`);

const onSite = only(entry({ haul_type: 'on_site' }));
assert('hauling ON the site is covered work — still 8 h prevailing',
  near(onSite.pwHours, 8) && near(onSite.stdHours, 0),
  `pw=${onSite.pwHours} std=${onSite.stdHours}`);

const offSite = only(entry({ haul_type: 'off_site' }));
assert('hauling TO & FROM the site falls to standard — 0 h prevailing, 8 h standard',
  near(offSite.pwHours, 0) && near(offSite.stdHours, 8),
  `pw=${offSite.pwHours} std=${offSite.stdHours}`);

assert('and the hours themselves are untouched — the driver is still owed all 8',
  near(offSite.workHours, 8) && near(offSite.totalHours, 8),
  `work=${offSite.workHours} total=${offSite.totalHours}`);

assert('an off-site haul is reported separately so the exclusion is visible',
  near(offSite.haulHours, 8) && near(ordinary.haulHours, 0) && near(onSite.haulHours, 0),
  `off=${offSite.haulHours} ordinary=${ordinary.haulHours} on=${onSite.haulHours}`);

// ── Nothing else changes ─────────────────────────────────────────────────────
console.log('\n[every other case behaves exactly as it did]');

const legacy = only(entry({ haul_type: undefined }));
assert('an entry saved before the question existed is ordinary work',
  near(legacy.pwHours, 8) && near(legacy.stdHours, 0),
  `pw=${legacy.pwHours} std=${legacy.stdHours}`);

const nonPw = only(entry({ prevailing_wage: false, haul_type: 'off_site' }));
assert('an off-site haul on a NON-prevailing job is standard, as it always was',
  near(nonPw.pwHours, 0) && near(nonPw.stdHours, 8),
  `pw=${nonPw.pwHours} std=${nonPw.stdHours}`);

const noConcept = only(entry({ prevailing_wage: null, haul_type: 'off_site' }));
assert('a division with no prevailing-wage concept is unaffected',
  near(noConcept.pwHours, 0) && near(noConcept.stdHours, 8),
  `pw=${noConcept.pwHours} std=${noConcept.stdHours}`);

const withTravel = only(entry({ haul_type: 'off_site', travel_hours: 2 }));
assert('travel on an off-site haul day is standard too — it always was',
  near(withTravel.pwHours, 0) && near(withTravel.stdHours, 10),
  `pw=${withTravel.pwHours} std=${withTravel.stdHours}`);

const pwTravel = only(entry({ travel_hours: 2 }));
assert('and travel on an ordinary prevailing day still splits work/travel',
  near(pwTravel.pwHours, 8) && near(pwTravel.stdHours, 2),
  `pw=${pwTravel.pwHours} std=${pwTravel.stdHours}`);

const draft = only(entry({ status: 'draft', haul_type: 'off_site' }));
assert('a draft still carries no hours at all',
  near(draft.workHours, 0) && near(draft.stdHours, 0));

const submitted = only(entry({ status: 'submitted', haul_type: 'off_site' }));
assert('a SUBMITTED entry is classified too — this is why the answer lives on the entry',
  near(submitted.pwHours, 0) && near(submitted.stdHours, 8),
  `pw=${submitted.pwHours} std=${submitted.stdHours}`);

// ── The mixed day, which is the whole point ─────────────────────────────────
console.log('\n[one driver, one day, two legs]');

// Franklin Regional is prevailing wage. Kris runs dirt out to it for 4 hours,
// then spends 6 hours hauling inside the fence. Two job blocks, same date, same
// job — which is exactly what timesheet.html posts for a split day.
const mixed = payrollMetrics({
  entries: [
    entry({ computed_hours: 4, haul_type: 'off_site', split_group_id: 'g1', split_index: 1, split_count: 2 }),
    entry({ computed_hours: 6, haul_type: 'on_site',  split_group_id: 'g1', split_index: 2, split_count: 2 }),
  ],
  periodStart: '2026-08-31', periodEnd: '2026-09-13',
}).totals;

assert('the run out to the job is standard: 4 h',
  near(mixed.stdHours, 4), `std=${mixed.stdHours}`);
assert('the hauling on site is prevailing: 6 h',
  near(mixed.pwHours, 6), `pw=${mixed.pwHours}`);
assert('he is paid for the whole 10-hour day',
  near(mixed.workHours, 10) && near(mixed.totalHours, 10),
  `work=${mixed.workHours} total=${mixed.totalHours}`);
assert('and it is one day worked, not two',
  mixed.daysWorked === 1, `daysWorked=${mixed.daysWorked}`);

// ── One block, both kinds of hour ───────────────────────────────────────────
console.log('\n[he hauled there, got out, and worked the site — all in one block]');

// Rick's day on Libby Phillipsburg: 9 hours filed as ONE block answered
// "to & from". 6.50 h of it was the triaxle; the other 2.50 h he spent on
// scratch/leveling with his boots on the ground. Payroll separates them in the
// split modal and the hours land here.
const partial = only(entry({ computed_hours: 9, haul_type: 'off_site', haul_hours: 6.5 }));
assert('the hours in the truck fall to standard: 6.50 h',
  near(partial.stdHours, 6.5), `std=${partial.stdHours}`);
assert('the hours on the site keep the premium: 2.50 h prevailing',
  near(partial.pwHours, 2.5), `pw=${partial.pwHours}`);
assert('  and only the hauled hours are reported as excluded',
  near(partial.haulHours, 6.5), `haul=${partial.haulHours}`);
assert('he is still owed the whole 9-hour day',
  near(partial.workHours, 9) && near(partial.pwHours + partial.stdHours, 9),
  `work=${partial.workHours} pw+std=${partial.pwHours + partial.stdHours}`);

const partialTravel = only(entry({ computed_hours: 9, travel_hours: 1, haul_type: 'off_site', haul_hours: 6.5 }));
assert('travel joins the hauled hours in standard, as it always has',
  near(partialTravel.stdHours, 7.5) && near(partialTravel.pwHours, 2.5),
  `pw=${partialTravel.pwHours} std=${partialTravel.stdHours}`);

const noneHauled = only(entry({ computed_hours: 9, haul_type: 'off_site', haul_hours: 0 }));
assert('a split that found no hauled hours at all pays the whole day prevailing',
  near(noneHauled.pwHours, 9) && near(noneHauled.stdHours, 0),
  `pw=${noneHauled.pwHours} std=${noneHauled.stdHours}`);

const allHauled = only(entry({ computed_hours: 9, haul_type: 'off_site', haul_hours: 9 }));
assert('a split that was all truck reads exactly as the un-split day did',
  near(allHauled.pwHours, 0) && near(allHauled.stdHours, 9),
  `pw=${allHauled.pwHours} std=${allHauled.stdHours}`);

// ── Nothing approved before this reports differently ───────────────────────
console.log('\n[the column is new; the numbers it replaces are not]');

const unsplit = only(entry({ computed_hours: 9, haul_type: 'off_site' }));
assert('haul_hours null means the whole day, exactly as haul_type meant alone',
  near(unsplit.pwHours, 0) && near(unsplit.stdHours, 9),
  `pw=${unsplit.pwHours} std=${unsplit.stdHours}`);
assert('  and an explicit null is read the same way',
  near(only(entry({ computed_hours: 9, haul_type: 'off_site', haul_hours: null })).stdHours, 9));

// An ON-SITE haul is covered work whatever the split says: the man was on the
// site for all of it, and haul_hours is about the LABOUR COST of the rows, not
// about where he stood. Reading it here would move his premium on the strength
// of a cost decision.
const onSitePartial = only(entry({ computed_hours: 9, haul_type: 'on_site', haul_hours: 6.5 }));
assert('an on-site haul stays wholly prevailing however the rows were split',
  near(onSitePartial.pwHours, 9) && near(onSitePartial.stdHours, 0),
  `pw=${onSitePartial.pwHours} std=${onSitePartial.stdHours}`);

// A split whose hauled hours somehow exceed the day cannot be allowed to invent
// negative prevailing hours — the invariant below is the whole contract.
const overrun = only(entry({ computed_hours: 9, haul_type: 'off_site', haul_hours: 40 }));
assert('a nonsense haul figure is clamped to the day, never negative',
  near(overrun.pwHours, 0) && near(overrun.stdHours, 9),
  `pw=${overrun.pwHours} std=${overrun.stdHours}`);
const negative = only(entry({ computed_hours: 9, haul_type: 'off_site', haul_hours: -3 }));
assert('  and so is a negative one',
  near(negative.pwHours, 9) && near(negative.stdHours, 0),
  `pw=${negative.pwHours} std=${negative.stdHours}`);

// ── The two copies of the rule ──────────────────────────────────────────────
// payroll.html carries its own, because the page cannot import this module. The
// executive report renders the fortnight from here and payroll checks it there,
// so a difference between them is two numbers for one day.
console.log('\n[payroll.html says the same thing]');
{
  const fs   = require('fs');
  const page = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');
  const start = page.indexOf('function offSiteHaulWork(');
  assert('payroll.html carries its own offSiteHaulWork', start >= 0);
  let depth = 0, end = -1;
  for (let i = page.indexOf('{', start); i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const pageFn = new Function(
    'isOffSiteHaul',
    `${page.slice(start, end)}; return offSiteHaulWork;`,
  )(e => !!e && e.haul_type === 'off_site');

  const CASES = [
    { haul_type: 'off_site', haul_hours: 6.5 },
    { haul_type: 'off_site', haul_hours: 0 },
    { haul_type: 'off_site', haul_hours: null },
    { haul_type: 'off_site' },
    { haul_type: 'off_site', haul_hours: 40 },
    { haul_type: 'off_site', haul_hours: -3 },
    { haul_type: 'on_site',  haul_hours: 6.5 },
    { haul_type: null,       haul_hours: 6.5 },
    { haul_type: 'off_site', haul_hours: 'nonsense' },
  ];
  let agree = 0;
  for (const c of CASES) if (near(pageFn(c, 9), offSiteHaulWork(c, 9))) agree++;
  assert(`the page and the module agree on all ${CASES.length} shapes`,
    agree === CASES.length, `${agree}/${CASES.length}`);
}

// ── The pill the approver reads ─────────────────────────────────────────────
// The Prevailing column and the pill beside it are computed from the same rule,
// and the pill's own comment says it exists so the two can never look like they
// disagree. A day answered as a haul whose split found no hours in the truck is
// wholly prevailing, and a "Haul" pill promising the standard rate beside a
// full prevailing figure is that mismatch in reverse.
console.log('\n[the pill says what the hours say]');
{
  const fs   = require('fs');
  const page = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');
  const grab = name => {
    const start = page.indexOf(`function ${name}(`);
    if (start < 0) return null;
    let depth = 0;
    for (let i = page.indexOf('{', start); i < page.length; i++) {
      if (page[i] === '{') depth++;
      else if (page[i] === '}' && --depth === 0) return page.slice(start, i + 1);
    }
    return null;
  };
  const pill = new Function('offSiteHaulWork', 'isOffSiteHaul',
    `${grab('prevailingWageHtml')}; return prevailingWageHtml;`,
  )(offSiteHaulWork, e => !!e && e.haul_type === 'off_site');
  const day = over => Object.assign(
    { entry_type: 'daily', prevailing_wage: true, computed_hours: 9, haul_type: 'off_site' }, over);

  assert('all of it in the truck reads "Haul"',
    />Haul</.test(pill(day({ haul_hours: 9 }))), pill(day({ haul_hours: 9 })));
  assert('an unsplit haul day reads "Haul" too — it still means the whole day',
    />Haul</.test(pill(day({}))));
  assert('part of it reads "Part haul", with both figures in the title',
    />Part haul</.test(pill(day({ haul_hours: 6.5 })))
    && /6\.50/.test(pill(day({ haul_hours: 6.5 })))
    && /2\.50/.test(pill(day({ haul_hours: 6.5 }))));
  assert('and NONE of it in the truck reads "Yes" — every hour was worked on the site',
    />Yes</.test(pill(day({ haul_hours: 0 }))), pill(day({ haul_hours: 0 })));
  assert('an ordinary prevailing day is unchanged',
    />Yes</.test(pill(day({ haul_type: null }))));
  assert('and a non-prevailing job still reads "No"',
    />No</.test(pill(day({ prevailing_wage: false, haul_type: null }))));
}

// ── The invariant ───────────────────────────────────────────────────────────
console.log('\n[hours are only ever reclassified, never created or destroyed]');

const CASES = [];
for (const pw of [true, false, null]) {
  for (const haul of [null, 'on_site', 'off_site']) {
    for (const travel of [0, 2.5]) {
      // Every shape haul_hours can arrive in, including the ones no split
      // should ever produce — the invariant has to hold against those too.
      for (const hh of [undefined, null, 0, 3, 8, 40, -3]) {
        CASES.push({ pw, haul, travel, hh });
      }
    }
  }
}
let balanced = 0;
for (const c of CASES) {
  const t = only(entry({ prevailing_wage: c.pw, haul_type: c.haul,
                         travel_hours: c.travel, haul_hours: c.hh }));
  if (near(t.pwHours + t.stdHours, 8 + c.travel)) balanced++;
}
assert(`prevailing + standard = work + travel, across all ${CASES.length} combinations`,
  balanced === CASES.length, `${balanced}/${CASES.length} balanced`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
