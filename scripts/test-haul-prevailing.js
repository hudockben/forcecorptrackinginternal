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
 * The invariant that matters most is the last one: whatever the split, a
 * worker's prevailing + standard hours must still add up to the hours he is
 * owed. Reclassifying hours must never create or destroy any.
 */

const path = require('path');
const { payrollMetrics } = require(path.resolve(__dirname, '../api/lib/payroll-metrics.js'));

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

// ── The invariant ───────────────────────────────────────────────────────────
console.log('\n[hours are only ever reclassified, never created or destroyed]');

const CASES = [];
for (const pw of [true, false, null]) {
  for (const haul of [null, 'on_site', 'off_site']) {
    for (const travel of [0, 2.5]) {
      CASES.push({ pw, haul, travel });
    }
  }
}
let balanced = 0;
for (const c of CASES) {
  const t = only(entry({ prevailing_wage: c.pw, haul_type: c.haul, travel_hours: c.travel }));
  if (near(t.pwHours + t.stdHours, 8 + c.travel)) balanced++;
}
assert(`prevailing + standard = work + travel, across all ${CASES.length} combinations`,
  balanced === CASES.length, `${balanced}/${CASES.length} balanced`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
