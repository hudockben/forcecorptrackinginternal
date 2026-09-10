#!/usr/bin/env node
'use strict';
/**
 * Overtime: the one figure on the payroll report that is not the range added up.
 *
 * Run: node scripts/test-overtime.js
 *
 * Every other column on the Hours Report is a sum — total the fortnight and you
 * have it. Overtime is not, and treating it like one is the mistake this test
 * exists to prevent. The fortieth hour is a fact about a WEEK. A man who works
 * 79.75 hours over two weeks has not worked 39.75 hours of overtime; he may
 * have worked none. Split 50/30 he worked ten.
 *
 * The week runs MONDAY THROUGH SUNDAY, and that is not a preference. The pay
 * period is built out of exactly two of them — biweeklyPayPeriod ends on a
 * Sunday and opens thirteen days earlier on a Monday — so a Monday-start week
 * nests inside the period with nothing straddling its edges.
 *
 * And the split that makes this worth showing at all: PREVAILING-WAGE OVERTIME
 * IS NOT THE SAME MONEY AS STANDARD OVERTIME. The premium on covered work is
 * one and a half times the BASE rate plus the FULL fringe, the fringe never
 * multiplied. Payroll cannot run the week off a single overtime figure — it has
 * to know how many of those hours were worked on the covered site. So the
 * overtime is classified by the same prevailing/standard rule the columns
 * beside it use, and the invariants below are what keep the two honest.
 */

const fs   = require('fs');
const path = require('path');
const {
  payrollMetrics, weeklyOvertime, weekStartOf, weekEndOf, OT_WEEKLY_THRESHOLD,
  stampKey, compareIds,
} = require(path.resolve(__dirname, '../api/lib/payroll-metrics.js'));
// One brace matcher, shared — see scripts/lib/fn-source.js for why.
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const PAGE = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const near = (a, b) => Math.abs(a - b) < 0.001;

// One approved 'daily' entry. Defaults describe the ordinary case: eight hours
// on a non-prevailing job with no travel.
function entry(work_date, over = {}) {
  return Object.assign({
    username:       'matt',
    entry_type:     'daily',
    status:         'approved',
    division:       'paving',
    work_date,
    computed_hours: 8,
    travel_hours:   0,
    prevailing_wage: false,
    haul_type:      null,
  }, over);
}

// Mon 2026-08-24 through Sun 2026-08-30, then Mon 2026-08-31 onward.
const MON = '2026-08-24', TUE = '2026-08-25', WED = '2026-08-26',
      THU = '2026-08-27', FRI = '2026-08-28', SAT = '2026-08-29', SUN = '2026-08-30';
const NEXT_MON = '2026-08-31', NEXT_TUE = '2026-09-01';

const ot = (entries, range) => weeklyOvertime(entries, range || {});

// ── The week, and where it starts ───────────────────────────────────────────
console.log('\n[the week runs Monday through Sunday]');

assert('the threshold is forty hours', OT_WEEKLY_THRESHOLD === 40);
assert('Monday opens its own week', weekStartOf(MON) === MON);
assert('  Wednesday belongs to that Monday', weekStartOf(WED) === MON);
assert('  and SUNDAY IS THE LAST DAY OF IT, not the first',
  weekStartOf(SUN) === MON, `got ${weekStartOf(SUN)}`);
assert('the next Monday opens the next week', weekStartOf(NEXT_MON) === NEXT_MON);
assert('a week closes on the Sunday six days later', weekEndOf(MON) === SUN);

assert('a timestamp is read for its calendar date, not its clock',
  weekStartOf('2026-08-30T23:30:00Z') === MON, `got ${weekStartOf('2026-08-30T23:30:00Z')}`);
assert('and an unreadable date is left out rather than filed into an invented week',
  weekStartOf('') === null && weekStartOf(null) === null && weekStartOf('not a date') === null);

// ── A week at a time, never the range ───────────────────────────────────────
console.log('\n[the fortieth hour is a fact about a week, not about the range]');

// Five ten-hour days, then five more: eighty hours over a fortnight, ten of
// them overtime — not forty.
const twoBigWeeks = ot([
  entry(MON, { computed_hours: 10 }), entry(TUE, { computed_hours: 10 }),
  entry(WED, { computed_hours: 10 }), entry(THU, { computed_hours: 10 }),
  entry(NEXT_MON, { computed_hours: 10 }), entry(NEXT_TUE, { computed_hours: 10 }),
]);
assert('two weeks of forty and twenty is no overtime at all — not twenty',
  near(twoBigWeeks.totalHours, 60) && near(twoBigWeeks.otHours, 0),
  `total=${twoBigWeeks.totalHours} ot=${twoBigWeeks.otHours}`);

const oneBigWeek = ot([
  entry(MON, { computed_hours: 10 }), entry(TUE, { computed_hours: 10 }),
  entry(WED, { computed_hours: 10 }), entry(THU, { computed_hours: 10 }),
  entry(FRI, { computed_hours: 10 }), entry(SAT, { computed_hours: 10 }),
]);
assert('sixty hours inside ONE week is twenty hours of overtime',
  near(oneBigWeek.otHours, 20) && near(oneBigWeek.regHours, 40),
  `ot=${oneBigWeek.otHours} reg=${oneBigWeek.regHours}`);

// The same total in both cases. The difference is entirely which week the hours
// landed in, which is the whole reason this cannot be a sum over the range.
assert('  same sixty hours either way — only the weeks differ',
  near(oneBigWeek.totalHours, 60) && near(twoBigWeeks.totalHours, 60));

const sundayCarry = ot([
  entry(MON, { computed_hours: 8 }), entry(TUE, { computed_hours: 8 }),
  entry(WED, { computed_hours: 8 }), entry(THU, { computed_hours: 8 }),
  entry(FRI, { computed_hours: 8 }), entry(SUN, { computed_hours: 8 }),
]);
assert('a Sunday still belongs to the week behind it: 48 h, 8 h overtime',
  near(sundayCarry.otHours, 8) && sundayCarry.weeks.length === 1,
  `ot=${sundayCarry.otHours} weeks=${sundayCarry.weeks.length}`);

// ── What counts toward the forty ────────────────────────────────────────────
console.log('\n[work and travel count toward it; paid leave does not]');

const withTravel = ot([
  entry(MON, { computed_hours: 8, travel_hours: 2 }),
  entry(TUE, { computed_hours: 8, travel_hours: 2 }),
  entry(WED, { computed_hours: 8, travel_hours: 2 }),
  entry(THU, { computed_hours: 8, travel_hours: 2 }),
  entry(FRI, { computed_hours: 8, travel_hours: 2 }),
]);
assert('travel time on the clock is time worked — 50 h is 10 h of overtime',
  near(withTravel.totalHours, 50) && near(withTravel.otHours, 10),
  `total=${withTravel.totalHours} ot=${withTravel.otHours}`);

// A holiday plus five eight-hour days is forty-eight hours PAID and forty
// hours WORKED. Only hours worked push a week into overtime.
const withHoliday = ot([
  { username: 'matt', entry_type: 'time_off', status: 'approved',
    time_off_type: 'holiday', work_date: MON },
  entry(TUE), entry(WED), entry(THU), entry(FRI), entry(SAT),
]);
assert('a holiday is paid leave, not hours worked — 40 h worked, no overtime',
  near(withHoliday.totalHours, 40) && near(withHoliday.otHours, 0),
  `total=${withHoliday.totalHours} ot=${withHoliday.otHours}`);

const withDraft = ot([
  entry(MON, { computed_hours: 10 }), entry(TUE, { computed_hours: 10 }),
  entry(WED, { computed_hours: 10 }), entry(THU, { computed_hours: 10 }),
  entry(FRI, { computed_hours: 10, status: 'draft' }),
]);
assert('a draft carries no hours here either — it is not payroll\'s business yet',
  near(withDraft.totalHours, 40) && near(withDraft.otHours, 0),
  `total=${withDraft.totalHours} ot=${withDraft.otHours}`);

const submittedOnly = ot([
  entry(MON, { computed_hours: 10, status: 'submitted' }),
  entry(TUE, { computed_hours: 10, status: 'submitted' }),
  entry(WED, { computed_hours: 10, status: 'submitted' }),
  entry(THU, { computed_hours: 10, status: 'submitted' }),
  entry(FRI, { computed_hours: 10, status: 'submitted' }),
]);
assert('but a SUBMITTED week is counted — overtime is visible before it is approved',
  near(submittedOnly.otHours, 10), `ot=${submittedOnly.otHours}`);

// ── Which hours are the overtime ones ───────────────────────────────────────
console.log('\n[the overtime hours are the ones worked last]');

// Four standard ten-hour days take him to forty. Friday is entirely on a
// prevailing-wage job, so every overtime hour is a prevailing one.
const pwFriday = ot([
  entry(MON, { computed_hours: 10 }), entry(TUE, { computed_hours: 10 }),
  entry(WED, { computed_hours: 10 }), entry(THU, { computed_hours: 10 }),
  entry(FRI, { computed_hours: 8, prevailing_wage: true }),
]);
assert('a prevailing Friday after forty standard hours is 8 h of PREVAILING overtime',
  near(pwFriday.otHours, 8) && near(pwFriday.otPwHours, 8) && near(pwFriday.otStdHours, 0),
  `ot=${pwFriday.otHours} pw=${pwFriday.otPwHours} std=${pwFriday.otStdHours}`);

// The mirror image: the prevailing work came first and was over by Thursday.
// The overtime is standard, even though the week is full of prevailing hours.
const pwFirst = ot([
  entry(MON, { computed_hours: 10, prevailing_wage: true }),
  entry(TUE, { computed_hours: 10, prevailing_wage: true }),
  entry(WED, { computed_hours: 10, prevailing_wage: true }),
  entry(THU, { computed_hours: 10, prevailing_wage: true }),
  entry(FRI, { computed_hours: 8 }),
]);
assert('  and the same week worked the other way round is 8 h of STANDARD overtime',
  near(pwFirst.otHours, 8) && near(pwFirst.otPwHours, 0) && near(pwFirst.otStdHours, 8),
  `ot=${pwFirst.otHours} pw=${pwFirst.otPwHours} std=${pwFirst.otStdHours}`);

// Travel on a prevailing day is standard — it is not paid at the prevailing
// rate — so an overtime day that includes travel splits both ways.
const straddle = ot([
  entry(MON, { computed_hours: 9 }), entry(TUE, { computed_hours: 9 }),
  entry(WED, { computed_hours: 9 }), entry(THU, { computed_hours: 9 }),
  entry(FRI, { computed_hours: 8, travel_hours: 2, prevailing_wage: true }),
]);
// Thursday closes on 36. Friday's ten hours carry him past forty, so six of
// them are overtime, split across that day's own 8 prevailing / 2 standard mix.
assert('the day that CROSSES the fortieth hour splits pro rata, not by a guessed order',
  near(straddle.otHours, 6) && near(straddle.otPwHours, 4.8) && near(straddle.otStdHours, 1.2),
  `ot=${straddle.otHours} pw=${straddle.otPwHours} std=${straddle.otStdHours}`);

// An off-site haul is standard for the same reason travel is — the man never
// worked the covered site — so it is standard in overtime too.
const haulOt = ot([
  entry(MON, { computed_hours: 10 }), entry(TUE, { computed_hours: 10 }),
  entry(WED, { computed_hours: 10 }), entry(THU, { computed_hours: 10 }),
  entry(FRI, { computed_hours: 9, prevailing_wage: true, haul_type: 'off_site', haul_hours: 6.5 }),
]);
assert('an off-site haul in overtime is standard overtime, as it is standard everywhere else',
  near(haulOt.otHours, 9) && near(haulOt.otPwHours, 2.5) && near(haulOt.otStdHours, 6.5),
  `ot=${haulOt.otHours} pw=${haulOt.otPwHours} std=${haulOt.otStdHours}`);

// ── The invariants ──────────────────────────────────────────────────────────
console.log('\n[classifying hours never creates or destroys any]');

const CASES = [
  pwFriday, pwFirst, straddle, haulOt, oneBigWeek, twoBigWeeks, withTravel, sundayCarry,
];
assert('regular + overtime = the hours he is owed, in every case',
  CASES.every(c => near(c.regHours + c.otHours, c.totalHours)));
assert('prevailing overtime + standard overtime = overtime, in every case',
  CASES.every(c => near(c.otPwHours + c.otStdHours, c.otHours)));
assert('no week is ever more than forty regular hours',
  CASES.every(c => c.weeks.every(w => w.regHours <= 40.001)),
  JSON.stringify(CASES.flatMap(c => c.weeks.map(w => w.regHours))));
assert('and a week under forty reports no overtime at all',
  CASES.every(c => c.weeks.every(w => w.totalHours > 40.001 || near(w.otHours, 0))));

// ── A week the filter cut in half ───────────────────────────────────────────
console.log('\n[a week the date range cuts into is a floor, not an answer]');

// Only Thursday and Friday of the week are in range. Whatever he worked Monday
// to Wednesday was never loaded, so his forty may already have gone.
const clipped = ot([entry(THU, { computed_hours: 10 }), entry(FRI, { computed_hours: 10 })],
  { from: THU, to: NEXT_TUE });
assert('a range starting mid-week flags the week it cut',
  clipped.clipped && clipped.weeks[0].clipped);
assert('  and it still reports the overtime it CAN see — zero here, honestly labelled',
  near(clipped.weeks[0].otHours, 0) && near(clipped.weeks[0].totalHours, 20));

const whole = ot([entry(MON, { computed_hours: 10 })], { from: MON, to: SUN });
assert('a range covering the whole week flags nothing', !whole.clipped);

const unbounded = ot([entry(WED, { computed_hours: 10 })], {});
assert('and no range set flags nothing either — there is no filter to blame',
  !unbounded.clipped);

// ── Through payrollMetrics, which is what the pages read ────────────────────
console.log('\n[the roll-up carries it per employee, never per crew]');

const crew = payrollMetrics({
  entries: [
    entry(MON, { username: 'matt', computed_hours: 10 }),
    entry(TUE, { username: 'matt', computed_hours: 10 }),
    entry(WED, { username: 'matt', computed_hours: 10 }),
    entry(THU, { username: 'matt', computed_hours: 10 }),
    entry(FRI, { username: 'matt', computed_hours: 10, prevailing_wage: true }),
    entry(MON, { username: 'jason', computed_hours: 10 }),
    entry(TUE, { username: 'jason', computed_hours: 10 }),
    entry(WED, { username: 'jason', computed_hours: 10 }),
  ],
  periodStart: MON, periodEnd: '2026-09-06',
});
const matt  = crew.employees.find(e => e.username === 'matt');
const jason = crew.employees.find(e => e.username === 'jason');
assert('matt worked fifty hours and ten of them are overtime',
  near(matt.otHours, 10) && near(matt.regHours, 40), `ot=${matt.otHours}`);
assert('  all ten on the prevailing job — the money payroll needs told apart',
  near(matt.otPwHours, 10) && near(matt.otStdHours, 0), `pw=${matt.otPwHours}`);
assert('jason worked thirty and none of it is overtime', near(jason.otHours, 0));
assert('the crew total is the sum of the men, not a re-measurement of the crew',
  near(crew.totals.otHours, 10) && near(crew.totals.totalHours, 80),
  `ot=${crew.totals.otHours} total=${crew.totals.totalHours}`);
assert('  which is the point: eighty crew hours, ten hours of overtime',
  crew.totals.totalHours > 40 && near(crew.totals.otHours, 10));
assert('every employee carries their weeks, so the report can say WHICH week',
  matt.weeks.length === 1 && matt.weeks[0].weekStart === MON);

// ── The shape the timestamp arrives in ──────────────────────────────────────
// The server reads created_at straight off the driver, which hands TIMESTAMPTZ
// back as a JS Date; the browser gets the same column as an ISO string over
// JSON. String(Date) is "Fri Aug 28 2026 09:00:00 GMT+0000" — it sorts by the
// NAME OF THE WEEKDAY — so compared naively the two ordered the same fortnight
// differently and reported different prevailing overtime for it.
console.log('\n[a timestamp orders the same whichever shape it arrives in]');
{
  const upTo36 = [
    entry(MON, { computed_hours: 9 }), entry(TUE, { computed_hours: 9 }),
    entry(WED, { computed_hours: 9 }), entry(THU, { computed_hours: 9 }),
  ];
  // Mon 31 Aug is before Fri 4 Sep, but "Mon…" sorts after "Fri…" by weekday.
  const EARLY = '2026-08-31T09:00:00Z', LATE = '2026-09-04T09:00:00Z';
  const blocks = shape => [
    entry(FRI, { id: 1, created_at: shape(EARLY), computed_hours: 4 }),
    entry(FRI, { id: 2, created_at: shape(LATE),  computed_hours: 4, prevailing_wage: true }),
  ];
  const asDate = ot([...upTo36, ...blocks(v => new Date(v))]);
  const asIso  = ot([...upTo36, ...blocks(v => v)]);
  assert('a Date and its ISO string give the same prevailing overtime',
    near(asDate.otPwHours, asIso.otPwHours),
    `Date ${asDate.otPwHours} vs ISO ${asIso.otPwHours}`);
  assert('  and it is the block created LATER that carries it',
    near(asIso.otPwHours, 4), `${asIso.otPwHours}`);

  assert('an unreadable date sorts as absent rather than as "Invalid Date"',
    stampKey(new Date('nonsense')) === '' && stampKey(null) === '' && stampKey(undefined) === '');

  // id is a bigserial, so it counts up with time — and the SQL orders it as a
  // number. As text "10" comes before "9", which is the reverse.
  console.log('\n[ids order the way the database orders them]');
  assert('9 before 10, not after it', compareIds(9, 10) < 0, String(compareIds(9, 10)));
  assert('  and 2 before 10',         compareIds(2, 10) < 0);
  assert('  exact past the float limit, because bigints are compared as digits',
    compareIds('9007199254740993', '9007199254740994') < 0);
  assert('  a non-numeric id still orders deterministically',
    compareIds('a', 'b') < 0 && compareIds(null, null) === 0);

  const byId    = [...upTo36,
    entry(FRI, { id: 10, computed_hours: 4 }),
    entry(FRI, { id: 9,  computed_hours: 4, prevailing_wage: true })];
  // id 9 was created first, so it keeps the regular hours and 10 takes the
  // overtime — which here is the non-prevailing block.
  assert('the lower id is counted first, matching ORDER BY work_date, created_at, id',
    near(ot(byId).otPwHours, 0), `${ot(byId).otPwHours}`);
}

// ── The two copies of the rule ──────────────────────────────────────────────
// payroll.html carries its own, because the page cannot import this module. The
// executive report renders the fortnight from here and payroll checks it there,
// so a difference between them is two answers for one week.
console.log('\n[payroll.html says the same thing]');
{
  assert('payroll.html carries its own weekly overtime arithmetic',
    /function weeklyOvertime\(/.test(PAGE) && /function weekStartOf\(/.test(PAGE));
  assert('  and the same forty-hour threshold, named the same way',
    /const OT_WEEKLY_THRESHOLD = 40;/.test(PAGE)
    && /const OT_WEEKLY_THRESHOLD = 40;/.test(
      fs.readFileSync(path.resolve(__dirname, '../api/lib/payroll-metrics.js'), 'utf8')));

  const page = new Function(`
    const OT_WEEKLY_THRESHOLD = 40;
    ${requireFn(PAGE, 'isOffSiteHaul',  'payroll.html')}
    ${requireFn(PAGE, 'offSiteHaulWork','payroll.html')}
    ${requireFn(PAGE, 'weekStartOf',    'payroll.html')}
    ${requireFn(PAGE, 'weekEndOf',       'payroll.html')}
    ${requireFn(PAGE, 'stampKey',        'payroll.html')}
    ${requireFn(PAGE, 'compareIds',      'payroll.html')}
    ${requireFn(PAGE, 'byEntryOrder',    'payroll.html')}
    ${requireFn(PAGE, 'weeklyOvertime',  'payroll.html')}
    return { weeklyOvertime, weekStartOf, weekEndOf };
  `)();

  assert('the page finds the same Monday for every day of a week',
    [MON, TUE, WED, THU, FRI, SAT, SUN].every(d => page.weekStartOf(d) === weekStartOf(d)));

  // Every case above, put through both copies. A number that differs is a week
  // payroll and the executive report would report differently.
  const SETS = [
    [entry(MON, { computed_hours: 10 }), entry(TUE, { computed_hours: 10 }),
     entry(WED, { computed_hours: 10 }), entry(THU, { computed_hours: 10 }),
     entry(FRI, { computed_hours: 8, travel_hours: 2, prevailing_wage: true })],
    [entry(MON, { computed_hours: 10, prevailing_wage: true }),
     entry(TUE, { computed_hours: 10, prevailing_wage: true }),
     entry(WED, { computed_hours: 10, prevailing_wage: true }),
     entry(THU, { computed_hours: 10, prevailing_wage: true }),
     entry(FRI, { computed_hours: 8 })],
    [entry(MON, { computed_hours: 10 }), entry(TUE, { computed_hours: 10 }),
     entry(WED, { computed_hours: 10 }), entry(THU, { computed_hours: 10 }),
     entry(FRI, { computed_hours: 9, prevailing_wage: true, haul_type: 'off_site', haul_hours: 6.5 })],
    [entry(SUN, { computed_hours: 12 }), entry(NEXT_MON, { computed_hours: 12 })],
    [{ username: 'matt', entry_type: 'time_off', status: 'approved', work_date: MON },
     entry(TUE), entry(WED), entry(THU), entry(FRI), entry(SAT)],
    [entry(MON, { computed_hours: 10, status: 'draft' }), entry(TUE, { computed_hours: 10 })],
    [entry('not a date', { computed_hours: 10 }), entry(TUE, { computed_hours: 10 })],
    // Two blocks on ONE date, which is the only case the created_at/id tiebreak
    // is ever reached on. Without it the page copy could call a helper it does
    // not have and this cross-check would never notice.
    // 36 hours in, then two blocks of 4 on ONE date — so the fortieth hour falls
    // BETWEEN them and the order genuinely decides which is the overtime one.
    // Both blocks wholly past 40 would give the same answer either way and
    // prove nothing.
    [entry(MON, { computed_hours: 9 }), entry(TUE, { computed_hours: 9 }),
     entry(WED, { computed_hours: 9 }), entry(THU, { computed_hours: 9 }),
     entry(FRI, { computed_hours: 4, id: 10, created_at: new Date('2026-08-31T09:00:00Z') }),
     entry(FRI, { computed_hours: 4, id: 9,  created_at: new Date('2026-09-04T09:00:00Z'),
                  prevailing_wage: true })],
    // The same day with no timestamps at all, so the id tiebreak is what decides.
    [entry(MON, { computed_hours: 9 }), entry(TUE, { computed_hours: 9 }),
     entry(WED, { computed_hours: 9 }), entry(THU, { computed_hours: 9 }),
     entry(FRI, { computed_hours: 4, id: 10 }),
     entry(FRI, { computed_hours: 4, id: 9, prevailing_wage: true })],
  ];
  const KEYS = ['totalHours', 'regHours', 'otHours', 'otPwHours', 'otStdHours'];
  const range = { from: MON, to: '2026-09-06' };
  const diffs = [];
  SETS.forEach((set, i) => {
    const a = weeklyOvertime(set, range);
    const b = page.weeklyOvertime(set, range);
    for (const k of KEYS) if (!near(a[k], b[k])) diffs.push(`set ${i} ${k}: ${a[k]} vs ${b[k]}`);
    if (a.weeks.length !== b.weeks.length) diffs.push(`set ${i} weeks: ${a.weeks.length} vs ${b.weeks.length}`);
    a.weeks.forEach((w, j) => {
      if (w.weekStart !== b.weeks[j].weekStart) diffs.push(`set ${i} week ${j} start`);
      if (w.clipped !== b.weeks[j].clipped)     diffs.push(`set ${i} week ${j} clipped`);
    });
  });
  assert(`both copies agree across all ${SETS.length} weeks`, diffs.length === 0, diffs.join(' | '));
}

// ── What a week with no counted hours is allowed to say ─────────────────────
// A week of approved vacation has no hours worked, so weeklyOvertime produces
// no week for it — and the band printed above those rows used to read "nothing
// submitted or approved this week" directly over a column of APPROVED pills.
// On a sheet payroll prints, that is not a wording problem, it is a false
// statement about the man's time.
console.log('\n[a week with no hours worked still describes itself honestly]');
{
  const band = new Function(`
    ${requireFn(PAGE, 'escapeHtml',      'payroll.html')}
    ${requireFn(PAGE, 'prettyDateShort', 'payroll.html')}
    ${requireFn(PAGE, 'weekEndOf',       'payroll.html')}
    ${requireFn(PAGE, 'weekBandHtml',    'payroll.html')}
    return weekBandHtml;
  `)();

  const off = { entry_type: 'time_off', status: 'approved', work_date: MON };
  const vacationWeek = band(MON, undefined, [off, { ...off, work_date: TUE }]);
  assert('a week of approved time off is not called unsubmitted',
    !/submitted|approved/i.test(vacationWeek), vacationWeek);
  assert('  it says what it is: time off, and no hours toward the 40',
    /time off only/.test(vacationWeek) && /40/.test(vacationWeek), vacationWeek);
  assert('  and it still names its own week',
    vacationWeek.includes('Week of'), vacationWeek);

  // Any other week without counted hours states the fact and stops. Naming a
  // status here would be a second thing to get wrong — the pills on the rows
  // below the band already say what each entry is.
  const otherWeek = band(MON, undefined, [entry(MON, { status: 'draft' })]);
  assert('any other empty week states the fact without naming a status',
    /no hours counted/.test(otherWeek) && !/submitted|approved|draft/i.test(otherWeek),
    otherWeek);

  const dated = band('', undefined, []);
  assert('and an entry with no readable date is still called out separately',
    /no readable work date/.test(dated), dated);
}

// ── The range the overtime is measured against ──────────────────────────────
// The filter boxes re-render the report from the rows already in memory, with
// no refetch. So the date inputs can say one thing while the rows say another,
// and "this week is only half loaded" is a fact about the FETCH. Reading it off
// the inputs put a partial-week warning on a whole week (and, worse, took one
// off a week that really was cut).
console.log('\n[the partial-week warning describes the fetch, not the filter bar]');
{
  assert('the page records the scope its rows were fetched with',
    /let loadedScope = \{ from: '', to: '', division: '' \};/.test(PAGE));
  assert('  it is set from the reply that landed, not from the inputs at render time',
    /allEntries = Array\.isArray\(data\.entries\)[\s\S]{0,80}loadedScope = \{ from, to, division \};/.test(PAGE));
  assert('  and a failed load clears it, so stale bounds cannot outlive the rows',
    /allEntries = \[\];[\s\S]{0,200}loadedScope = \{ from: '', to: '', division: '' \};/.test(PAGE));
  assert('the overtime weeks are measured against that scope',
    /weeklyOvertime\(r\.entries, loadedScope\)/.test(PAGE));
  assert('  and the footnote names the division that was actually loaded',
    /loadedScope\.division/.test(PAGE));
}

// ── The printed sheet ───────────────────────────────────────────────────────
// The week band's colours come from CSS variables built for a dark screen. The
// print block forces the report to black on white; a span left out of it prints
// near-white on white, which on the band's label is the week's own dates.
console.log('\n[the week band survives being printed]');
{
  const printBlock = PAGE.slice(PAGE.indexOf('@media print'));
  // Every rule in the print block that paints text black, as selector-list and
  // body pairs. A band span is safe if it appears in the selectors of one.
  const blackRules = [...printBlock.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(m => /color:\s*#000/.test(m[2]))
    .map(m => m[1]);
  for (const cls of ['wb-label', 'wb-fig', 'wb-note', 'wb-ot', 'wb-ot-pw', 'wb-warn']) {
    const dotted = '.' + cls;
    assert(`  ${dotted} is forced to black on paper`,
      blackRules.some(sel => sel.split(',').some(one => one.trim().endsWith(dotted))));
  }
  assert('the band gets a print size too, or it ignores the table\'s point size',
    /week-band[\s\S]{0,600}font-size/.test(printBlock));
}

// ── Two entries on one date ─────────────────────────────────────────────────
// A split day is two rows sharing a work_date, and the walk counts them in
// sequence: whichever sorts first keeps the regular hours and the other takes
// the overtime. If the order is not pinned, the answer falls to however the
// database returned the rows — and the executive report disagrees with the
// Payroll page about the same driver's same day.
console.log('\n[a split day is counted in a fixed order, not the order it arrived]');
{
  const split = (id, hours, pw, created_at) => ({
    id, created_at, username: 'kris', entry_type: 'daily', status: 'approved',
    division: 'turf', work_date: FRI, computed_hours: hours, travel_hours: 0,
    prevailing_wage: pw, haul_type: null,
  });
  // Thirty-six hours in by Thursday. Friday is two blocks totalling eight, so
  // four of them are overtime — and WHICH four decides how much prevailing
  // overtime he is owed.
  const upTo36 = [
    entry(MON, { computed_hours: 9 }), entry(TUE, { computed_hours: 9 }),
    entry(WED, { computed_hours: 9 }), entry(THU, { computed_hours: 9 }),
  ];
  const first  = split('b', 4, false, '2026-08-28T07:00:00Z');
  const second = split('a', 4, true,  '2026-08-28T12:00:00Z');

  const forwards  = ot([...upTo36, first, second]);
  const backwards = ot([...upTo36, second, first]);
  assert('the same two blocks give the same answer whichever order they arrive in',
    near(forwards.otHours, backwards.otHours)
    && near(forwards.otPwHours, backwards.otPwHours),
    `${forwards.otPwHours} vs ${backwards.otPwHours}`);
  assert('  and it is the LATER block that carries the overtime',
    near(forwards.otHours, 4) && near(forwards.otPwHours, 4),
    `ot=${forwards.otHours} pw=${forwards.otPwHours}`);

  // With no created_at at all the comparator must still be deterministic, or a
  // caller that forgets the column silently gets a different answer.
  const noStamp = [split('b', 4, false), split('a', 4, true)];
  const byId    = ot([...upTo36, ...noStamp]);
  const byIdRev = ot([...upTo36, ...noStamp.slice().reverse()]);
  assert('with no timestamps it falls through to id and is still deterministic',
    near(byId.otPwHours, byIdRev.otPwHours), `${byId.otPwHours} vs ${byIdRev.otPwHours}`);

  assert('payroll.html sorts by the same three keys',
    /a\.work_date[\s\S]{0,220}a\.created_at[\s\S]{0,220}a\.id/.test(PAGE));

  // The order the hours are COUNTED in and the order they are SHOWN in have to
  // be one order. weeklyOvertime decides which of two blocks on a date takes
  // the overtime; if the detail table or the workbook listed them the other way
  // round, the row carrying the OT would print above the row that does not —
  // the report contradicting the rule it is applying, on its own face.
  const SORTERS = [...PAGE.matchAll(/\.slice\(\)\.sort\(([\s\S]{0,240}?)\);/g)].map(m => m[1]);
  const entrySorters = SORTERS.filter(x => /work_date/.test(x) || /byEntryOrder/.test(x));
  assert(`all ${entrySorters.length} places that order a day's entries use the one comparator`,
    entrySorters.length >= 3 && entrySorters.every(x => /^byEntryOrder$/.test(x.trim())),
    entrySorters.filter(x => !/^byEntryOrder$/.test(x.trim())).join(' | ') || 'none');

  // Both server callers have to SELECT what the comparator sorts on, and order
  // the rows themselves — the column list is explicit, so omitting one is
  // silent.
  const consumers = ['../api/executive/report.js', '../api/lib/mathis-digests.js'];
  for (const rel of consumers) {
    const src = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    // Anchor on the call, not on the table: report.js reads timesheet_entries
    // for the truck grid as well, and that query is nowhere near this one.
    const call = src.indexOf('payrollMetrics({');
    const q    = src.slice(src.lastIndexOf('SELECT', call), call);
    assert(`  ${rel.split('/').pop()} selects created_at and id`,
      /\bcreated_at\b/.test(q) && /\bid\b/.test(q));
    assert(`  ${rel.split('/').pop()} orders the rows it hands to payrollMetrics`,
      /ORDER BY work_date, created_at, id/.test(q));
    // ::text, the way work_date already is. Left as TIMESTAMPTZ the driver
    // returns a Date and the server sorts "Fri Aug 28 2026 …" while the browser
    // sorts the ISO string it got over JSON.
    assert(`  ${rel.split('/').pop()} hands created_at over as text`,
      /created_at::text/.test(q));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
