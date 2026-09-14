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

const fs   = require('fs');
const path = require('path');
const { payrollMetrics, offSiteHaulWork } =
  require(path.resolve(__dirname, '../api/lib/payroll-metrics.js'));
// One brace matcher, shared — see scripts/lib/fn-source.js for why.
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
// Read once. Both blocks below lift a function out of the same page.
const PAGE = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');

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

// ── Labour versus driving ───────────────────────────────────────────────────
// A second split of the same day, answering a different question. haulHours
// above is about the RATE: which hours left prevailing. truckHours is about the
// WORK: which hours moved a truck instead of producing anything on the ground.
// A man hauling on the covered site scores on one and not the other, which is
// exactly why they are two figures and never added together.
console.log('\n[the same day split again — labour, and time in the truck]');

assert('an off-site haul is all driving',      near(offSite.truckHours, 8));
assert('an ON-SITE haul is all driving too — it is prevailing AND in the truck',
  near(onSite.truckHours, 8) && near(onSite.pwHours, 8),
  `truck=${onSite.truckHours} pw=${onSite.pwHours}`);
assert('a day nobody called a haul is all labour', near(ordinary.truckHours, 0));
assert('and it never leaves the hours worked: labour + driving = workHours',
  near(offSite.workHours - offSite.truckHours, 0)
  && near(ordinary.workHours - ordinary.truckHours, 8));

const partialTruck = only(entry({ computed_hours: 9, haul_type: 'off_site', haul_hours: 6.5 }));
assert('a day he drove there and then worked it splits 6.50 / 2.50',
  near(partialTruck.truckHours, 6.5)
  && near(partialTruck.workHours - partialTruck.truckHours, 2.5),
  `truck=${partialTruck.truckHours}`);
// The two figures answer different questions, and the on-site case is where
// reading one for the other would show the office a driver with no prevailing
// hours he is actually owed.
assert('truckHours and haulHours are not the same number on an on-site haul',
  near(onSite.truckHours, 8) && near(onSite.haulHours, 0));

// ── Nothing else changes ─────────────────────────────────────────────────────
console.log('\n[every other case behaves exactly as it did]');

const preColumn = only(entry({ haul_type: undefined }));
assert('an entry saved before the question existed is ordinary work',
  near(preColumn.pwHours, 8) && near(preColumn.stdHours, 0),
  `pw=${preColumn.pwHours} std=${preColumn.stdHours}`);

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

// ── A day holding both kinds of haul ───────────────────────────────────────
// haul_hours is every hour he spent in the truck; haul_off_site_hours is the
// share of them hauled TO OR FROM the site. Only the second moves his pay — the
// on-site legs are covered work and keep the premium — and one column cannot be
// both answers, so the narrower one has its own.
console.log('\n[a day holding both kinds of haul]');
const bothKinds = only(entry({ computed_hours: 9, haul_type: 'off_site',
                           haul_hours: 8, haul_off_site_hours: 6 }));
assert('only the to-and-from legs leave prevailing',
  near(bothKinds.pwHours, 3) && near(bothKinds.stdHours, 6),
  `pw=${bothKinds.pwHours} std=${bothKinds.stdHours}`);
assert('  and the on-site leg still counts as time in the truck',
  near(bothKinds.truckHours, 8), `truck=${bothKinds.truckHours}`);
assert('  with the reclassified figure naming only the hours that moved',
  near(bothKinds.haulHours, 6), `haul=${bothKinds.haulHours}`);
// Without the column — every entry approved before it existed — the day held
// one kind of haul, so the wider figure IS the answer and nothing changes.
const beforeOffCol = only(entry({ computed_hours: 9, haul_type: 'off_site', haul_hours: 6.5 }));
assert('an entry from before the column falls back to haul_hours, as it always read',
  near(beforeOffCol.pwHours, 2.5) && near(beforeOffCol.stdHours, 6.5),
  `pw=${beforeOffCol.pwHours} std=${beforeOffCol.stdHours}`);
assert('  and an explicit null falls back the same way',
  near(only(entry({ computed_hours: 9, haul_type: 'off_site',
                    haul_hours: 6.5, haul_off_site_hours: null })).stdHours, 6.5));
// Zero is an answer, not an absence: a day hauled entirely ON the site keeps
// every hour prevailing even though haul_hours says he was driving all day.
const allOnSite = only(entry({ computed_hours: 9, haul_type: 'off_site',
                               haul_hours: 9, haul_off_site_hours: 0 }));
assert('a zero off-site figure keeps the whole day prevailing',
  near(allOnSite.pwHours, 9) && near(allOnSite.stdHours, 0),
  `pw=${allOnSite.pwHours} std=${allOnSite.stdHours}`);
const badOff = only(entry({ computed_hours: 9, haul_type: 'off_site',
                            haul_hours: 6.5, haul_off_site_hours: 'nonsense' }));
assert('  and an unreadable one falls through rather than becoming zero',
  near(badOff.stdHours, 6.5), `std=${badOff.stdHours}`);

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
  const pageSrc = requireFn(PAGE, 'offSiteHaulWork', 'payroll.html');
  assert('payroll.html carries its own offSiteHaulWork', !!pageSrc);
  const pageFn = new Function(
    'isOffSiteHaul', `${pageSrc}; return offSiteHaulWork;`,
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
    // The narrower column, which is the one that actually moves his pay.
    { haul_type: 'off_site', haul_hours: 8,   haul_off_site_hours: 6 },
    { haul_type: 'off_site', haul_hours: 9,   haul_off_site_hours: 0 },
    { haul_type: 'off_site', haul_hours: 6.5, haul_off_site_hours: null },
    { haul_type: 'off_site', haul_hours: 6.5, haul_off_site_hours: 'nonsense' },
    { haul_type: 'off_site', haul_hours: 2,   haul_off_site_hours: 40 },
    { haul_type: 'off_site', haul_hours: 2,   haul_off_site_hours: -3 },
    { haul_type: 'on_site',  haul_hours: 8,   haul_off_site_hours: 6 },
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
  const pill = new Function('offSiteHaulWork', 'isOffSiteHaul',
    `${requireFn(PAGE, 'prevailingWageHtml', 'payroll.html')}; return prevailingWageHtml;`,
  )(offSiteHaulWork, e => !!e && e.haul_type === 'off_site');
  const day = over => Object.assign(
    { entry_type: 'daily', prevailing_wage: true, computed_hours: 9, haul_type: 'off_site' }, over);

  assert('all of it in the truck reads "Haul"',
    />Haul</.test(pill(day({ haul_hours: 9 }))), pill(day({ haul_hours: 9 })));
  assert('an unsplit haul day reads "Haul" too — it still means the whole day',
    />Haul</.test(pill(day({}))));
  assert('part of it reads "Partial haul", with both figures in the title',
    />Partial haul</.test(pill(day({ haul_hours: 6.5 })))
    && /6\.50/.test(pill(day({ haul_hours: 6.5 })))
    && /2\.50/.test(pill(day({ haul_hours: 6.5 }))));
  assert('and NONE of it in the truck reads "Yes" — every hour was worked on the site',
    />Yes</.test(pill(day({ haul_hours: 0 }))), pill(day({ haul_hours: 0 })));
  assert('an ordinary prevailing day is unchanged',
    />Yes</.test(pill(day({ haul_type: null }))));
  assert('and a non-prevailing job with no hauling still reads "No"',
    />No</.test(pill(day({ prevailing_wage: false, haul_type: null }))));

  // The haul is a fact about the DAY, not about the job's prevailing flag, and
  // it is the fact payroll is reading this column for: those hours post at a $0
  // labour rate because the man is already inside the truck's hourly cost.
  // Keyed on the prevailing flag alone, a haul on a standard job read a plain
  // "No" — indistinguishable from an ordinary day, on the one tab where the
  // difference is money.
  assert('a haul on a NON-prevailing job reads "Haul", not "No"',
    />Haul</.test(pill(day({ prevailing_wage: false, haul_hours: 9 }))),
    pill(day({ prevailing_wage: false, haul_hours: 9 })));
  assert('part of one reads "Partial haul" the same way',
    />Partial haul</.test(pill(day({ prevailing_wage: false, haul_hours: 4 }))));
  assert('and a haul where prevailing wage does not apply at all still reads "Haul"',
    />Haul</.test(pill(day({ prevailing_wage: null, haul_hours: 9 }))),
    pill(day({ prevailing_wage: null, haul_hours: 9 })));
  assert('while a non-haul day there is still the neutral dash',
    /—/.test(pill(day({ prevailing_wage: null, haul_type: null }))));

  // On site is its own answer: the truck's rate still covers his labour, but he
  // IS on the covered site, so a prevailing job keeps its premium. Reading it
  // as "Haul" would have payroll expecting the premium to come off.
  assert('hauled on site reads "On site haul"',
    />On site haul</.test(pill(day({ haul_type: 'on_site', haul_hours: 9 }))),
    pill(day({ haul_type: 'on_site', haul_hours: 9 })));
  assert('on a standard job too',
    />On site haul</.test(pill(day({ haul_type: 'on_site', prevailing_wage: false }))));
  assert('but a split that found no hours in the truck falls back to the job',
    />Yes</.test(pill(day({ haul_type: 'on_site', haul_hours: 0 }))),
    pill(day({ haul_type: 'on_site', haul_hours: 0 })));

  // Time off is never a haul, whatever an older row happens to carry.
  assert('time off is untouched by any of it',
    /—/.test(pill(day({ entry_type: 'time_off', haul_hours: 9 }))));

  // Each answer has to be its own colour, or "sticks out for payroll" is a
  // label nobody scanning the column actually sees.
  assert('and each answer carries its own class',
    /pw-haul/.test(pill(day({ haul_hours: 9 })))
    && /pw-part/.test(pill(day({ haul_hours: 6.5 })))
    && /pw-onsite/.test(pill(day({ haul_type: 'on_site' })))
    && /pw-yes/.test(pill(day({ haul_type: null })))
    && /pw-no/.test(pill(day({ prevailing_wage: false, haul_type: null }))));

  // A class with no rule behind it is a pill that renders as bare text.
  const CSS = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');
  for (const cls of ['pw-haul', 'pw-part', 'pw-onsite', 'pw-yes', 'pw-no']) {
    assert(`.${cls} is styled`, new RegExp(`\\.${cls}\\s*[,{]`).test(CSS));
  }
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
