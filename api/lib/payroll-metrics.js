'use strict';

// Payroll roll-up arithmetic, ported from payroll.html's buildReportModel so the
// executive report shows the hours payroll is looking at.
//
// A pure function over timesheet entries already fetched from
// timesheet_entries, with `prevailing_wage` resolved onto each one (it lives on
// the project blob, not the timesheet row — see attachPrevailingWage in
// api/timesheet-entries.js for the rule).
//
// The rules that matter, all of them payroll.html's:
//
//   • Hours are work + travel. That is what the worker is owed for the day.
//   • Only submitted and approved entries carry hours. A draft is not payroll's
//     business yet.
//   • Travel is never paid at the prevailing rate. On a prevailing-wage job the
//     work hours are prevailing and the travel falls to standard, so prevailing
//     + standard still add up to the total.
//   • An OFF-SITE HAUL is standard for the same reason travel is, and it is the
//     same kind of fact: the man never worked the site. A driver running dirt
//     to and from a prevailing-wage job is owed his hours, but not the
//     prevailing premium, because the premium is for work ON the covered site.
//     A haul ON the site is ordinary covered work and stays prevailing — which
//     is why haul_type has two values and not one. See the column comment in
//     neon-schema.sql for where the answer comes from.
//   • ONLY THE HOURS HE ACTUALLY HAULED. A driver who runs to the site and then
//     gets out and works it did both in one day, and haul_type on its own
//     cannot say how much of each — it answered for the whole block. Payroll's
//     split says: haul_hours holds the work hours the truck bought, and the
//     rest were worked on the covered site and are owed the premium. An entry
//     with haul_hours null was never split, and reads as the whole day, which
//     is exactly how it behaved before the column existed.
//   • Only an explicit true is prevailing. false and null — the divisions with
//     no prevailing-wage concept — are standard.
//   • travel_to_site + travel_to_shop are the two legs behind travel_hours as
//     entered. An entry saved with only the sum contributes nothing to the legs,
//     so they can add to less than travel_hours; travel_hours stays the
//     authoritative figure.

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const COUNTED_STATUSES = new Set(['submitted', 'approved']);

/**
 * How many of a day's WORK hours the truck bought, and so fall to the standard
 * rate on a prevailing-wage job.
 *
 * Only an off-site haul moves anything: a haul on the site is ordinary covered
 * work, and a day that was not a haul at all has nothing to move.
 *
 *   haul_hours null → the day was never split, so the answer is still the one
 *                     haul_type gave on its own: all of it. This is what keeps
 *                     every fortnight approved before the column existed
 *                     reporting exactly the hours it always did.
 *   haul_hours n    → payroll separated the legs. n hours were in the truck;
 *                     the rest were worked on the site and stay prevailing.
 *
 * Clamped to the day, because prevailing + standard must still add up to the
 * hours the man is owed — reclassifying hours may never create or destroy any.
 *
 * Mirrored in payroll.html (offSiteHaulWork). The two must agree: the executive
 * report renders the fortnight from here and the Payroll page is where it is
 * checked.
 */
function offSiteHaulWork(e, work) {
  if (!e || e.haul_type !== 'off_site') return 0;
  if (e.haul_hours == null) return work;
  const h = Number(e.haul_hours);
  // A figure we cannot read is not a zero. num() would make it one, and that
  // would pay a whole hauled day at the prevailing rate on the strength of a
  // value nobody can parse. Unreadable falls back to what haul_type said on its
  // own — all of it — which is the answer this column refines, never reverses.
  if (!Number.isFinite(h)) return work;
  return Math.min(Math.max(h, 0), work);
}

// ── Overtime ─────────────────────────────────────────────────────────────────
//
// Overtime is a WEEKLY fact, and everything else on this page is a fortnight.
// The two must not be confused: 79.75 hours over a two-week period is not
// 39.75 hours of overtime, it is two weeks measured one at a time, and it may
// be no overtime at all. Anything past the fortieth hour OF A WEEK is overtime;
// nothing else is.
//
// The week runs MONDAY THROUGH SUNDAY. That is not a preference — the pay
// period is built out of exactly two of them (biweeklyPayPeriod in
// api/executive/report.js ends on a Sunday and starts thirteen days earlier,
// and payPeriodWindow in timesheet.html spans Monday of last week to Sunday of
// this one), so a Monday-start week nests inside the period with nothing
// straddling its edges.
//
// WHAT COUNTS TOWARD THE FORTY. Work plus travel, on submitted and approved
// daily entries — the same hours the man is owed for the day, because travel
// time on the clock is time worked. TIME OFF DOES NOT COUNT. Holiday and
// vacation are paid leave, not hours worked, and hours not worked never push a
// week into overtime.
const OT_WEEKLY_THRESHOLD = 40;

/**
 * The Monday of the week a YYYY-MM-DD work date falls in, as YYYY-MM-DD.
 *
 * Parsed as UTC on purpose. `new Date('2026-08-31')` is midnight UTC, but
 * `new Date(2026, 7, 31)` is midnight local, and west of Greenwich the first
 * one read back through local getters is the previous day — which would file a
 * Monday's hours in the week before and move the overtime line by a whole day.
 * Every step here stays in UTC so the calendar date is the only thing that
 * matters.
 *
 * Returns null for anything that is not a date, so an unreadable row is left
 * out of the overtime arithmetic rather than dropped into an invented week.
 */
function weekStartOf(workDate) {
  const d = String(workDate == null ? '' : workDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return null;
  // getUTCDay is 0=Sun..6=Sat; Monday is the start, so Sunday counts back six.
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

/** The Sunday closing the week a Monday opens. */
function weekEndOf(weekStart) {
  const t = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return weekStart;
  t.setUTCDate(t.getUTCDate() + 6);
  return t.toISOString().slice(0, 10);
}

/**
 * Oldest first, and DETERMINISTIC when two entries share a date.
 *
 * This order decides which hours are the overtime ones — the walk stops
 * counting regular at the fortieth hour, so on a day that straddles it the
 * entry sorted first keeps the regular hours and the other takes the overtime.
 * A split day is two rows on one date, which is exactly the case where the
 * question is live.
 *
 * `id` is the last resort because it is the only field every caller has: a
 * caller that forgets to SELECT created_at would otherwise leave two rows
 * comparing equal, and the answer would fall to whatever order the database
 * happened to return them in — different from the Payroll page's, for the same
 * fortnight, with nothing to show why.
 */
function byDateThenCreated(a, b) {
  return String(a.work_date  || '').localeCompare(String(b.work_date  || ''))
      || String(a.created_at || '').localeCompare(String(b.created_at || ''))
      || String(a.id         || '').localeCompare(String(b.id         || ''));
}

/**
 * One employee's hours, split week by week into regular and overtime, with the
 * overtime split again by the rate it is paid at.
 *
 * THE SECOND SPLIT IS THE POINT. A prevailing-wage overtime hour and a standard
 * overtime hour are not the same money: the prevailing premium is one and a
 * half times the BASE rate plus the FULL fringe, the fringe never multiplied,
 * so payroll cannot compute the week from a single overtime figure. It needs to
 * know how many of those hours were covered work.
 *
 * WHICH HOURS ARE THE OVERTIME ONES. The ones worked last. Entries are walked
 * oldest first and the hours past the fortieth are the overtime; each keeps the
 * classification it already had, which is the "rate in effect" method. For the
 * single entry that STRADDLES the fortieth hour, its overtime is split across
 * its own prevailing/standard mix pro rata — nothing on a timesheet says which
 * hour of a day came last, and inventing an order to answer that would be
 * guessing at money.
 *
 * Either way prevailing OT + standard OT = OT, and regular + OT = the hours he
 * is owed. Classifying hours may never create or destroy any.
 *
 * `range` is the window the entries were fetched for ({ from, to }, either
 * side optional). A week reaching outside it is flagged `clipped`: its missing
 * days were never loaded, so its overtime is a floor and not a total.
 */
function weeklyOvertime(entries, range) {
  const from = range && range.from ? String(range.from).slice(0, 10) : '';
  const to   = range && range.to   ? String(range.to).slice(0, 10)   : '';

  const byWeek = new Map();
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || e.entry_type !== 'daily' || !COUNTED_STATUSES.has(e.status)) continue;
    const wk = weekStartOf(e.work_date);
    if (!wk) continue;
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(e);
  }

  const weeks = [];
  for (const wk of [...byWeek.keys()].sort()) {
    const list = byWeek.get(wk).slice().sort(byDateThenCreated);
    let cum = 0, totalHours = 0, otHours = 0, otPwHours = 0, otStdHours = 0;
    const rows = [];
    for (const e of list) {
      const work   = num(e.computed_hours);
      const travel = num(e.travel_hours);
      const total  = work + travel;
      // The same prevailing/standard split the rest of this module makes, so
      // the overtime columns can never disagree with the columns beside them.
      const pw  = e.prevailing_wage === true ? work - offSiteHaulWork(e, work) : 0;
      const std = total - pw;

      const before = cum;
      cum += total;
      const ot = Math.max(0,
        Math.max(0, cum - OT_WEEKLY_THRESHOLD) - Math.max(0, before - OT_WEEKLY_THRESHOLD));
      // 1 once the whole entry is past the line, 0 while it is under it, and a
      // fraction only for the one entry that crosses it.
      const share = total > 0.000001 ? Math.min(1, Math.max(0, ot / total)) : 0;
      const otPw  = pw  * share;
      const otStd = std * share;

      rows.push({ entry: e, hours: total, pwHours: pw, stdHours: std,
                  otHours: ot, otPwHours: otPw, otStdHours: otStd });
      totalHours += total; otHours += ot; otPwHours += otPw; otStdHours += otStd;
    }
    const weekEnd = weekEndOf(wk);
    weeks.push({
      weekStart:  wk,
      weekEnd,
      totalHours,
      regHours:   totalHours - otHours,
      otHours, otPwHours, otStdHours,
      // The filter cut this week in half. Days outside the range were never
      // fetched, so the forty may already have been passed on hours nobody here
      // can see — the figure below it is a floor, not an answer.
      clipped: Boolean((from && wk < from) || (to && weekEnd > to)),
      rows,
    });
  }

  const sum = k => weeks.reduce((s, w) => s + w[k], 0);
  return {
    weeks,
    totalHours: sum('totalHours'),
    regHours:   sum('regHours'),
    otHours:    sum('otHours'),
    otPwHours:  sum('otPwHours'),
    otStdHours: sum('otStdHours'),
    clipped:    weeks.some(w => w.clipped),
  };
}

function emptyEmployee(username) {
  return {
    username,
    workHours: 0, travelToSite: 0, travelToShop: 0, travelHours: 0,
    pwHours: 0, stdHours: 0, haulHours: 0,
    // Filled in per employee by weeklyOvertime once every entry is in hand —
    // overtime cannot be accumulated a row at a time, because whether an hour
    // is overtime depends on the whole week around it.
    regHours: 0, otHours: 0, otPwHours: 0, otStdHours: 0,
    weeks: [], otClipped: false,
    pendingHours: 0, approvedHours: 0,
    pendingOff: 0, approvedOff: 0,
    daysWorked: 0,
    divisions: new Set(),
    _dates: new Set(),
    _entries: [],
  };
}

const TOTAL_KEYS = [
  'workHours', 'travelToSite', 'travelToShop', 'travelHours',
  'pwHours', 'stdHours', 'haulHours',
  'regHours', 'otHours', 'otPwHours', 'otStdHours',
  'pendingHours', 'approvedHours',
  'pendingOff', 'approvedOff', 'daysWorked',
];

function payrollMetrics({ entries, periodStart, periodEnd }) {
  const byUser = new Map();

  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e) continue;
    const u = e.username || '—';
    if (!byUser.has(u)) byUser.set(u, emptyEmployee(u));
    const acc = byUser.get(u);
    if (e.division) acc.divisions.add(String(e.division));
    acc._entries.push(e);

    if (e.entry_type === 'daily') {
      const work   = num(e.computed_hours);
      const travel = num(e.travel_hours);
      const h      = work + travel;

      if (COUNTED_STATUSES.has(e.status)) {
        acc.workHours    += work;
        acc.travelHours  += travel;
        acc.travelToSite += num(e.travel_to_site_hours);
        acc.travelToShop += num(e.travel_to_shop_hours);
        // The hours the truck bought join the travel in the standard bucket;
        // whatever is left of the work he did on the covered site, and is owed
        // the premium for. Every other case is unchanged: 'on_site' and null
        // both come back 0 here and fall through to the old rule.
        const haulWork = offSiteHaulWork(e, work);
        if (e.prevailing_wage === true) {
          acc.pwHours  += work - haulWork;
          acc.stdHours += haulWork + travel;
          // Only hours this rule actually MOVED. A driver's off-site haul on a
          // job that was never prevailing wage is standard either way, and
          // counting it here had the executive strip report "40.00 h off-site
          // haul excluded" beside a prevailing total of 0.00 — describing a
          // reclassification that never happened.
          acc.haulHours += haulWork;
        } else {
          acc.stdHours += h;
        }
        // Distinct dates worked, so two entries on one day are one day.
        const d = String(e.work_date || '').slice(0, 10);
        if (d) acc._dates.add(d);
      }
      if (e.status === 'submitted') acc.pendingHours  += h;
      if (e.status === 'approved')  acc.approvedHours += h;
    } else if (e.entry_type === 'time_off') {
      if (e.status === 'submitted') acc.pendingOff++;
      if (e.status === 'approved')  acc.approvedOff++;
    }
  }

  const employees = [...byUser.values()]
    .map(r => {
      r.daysWorked = r._dates.size;
      delete r._dates;
      // Overtime, week by week, from the same entries the totals above were
      // built from. Done here rather than in the loop because the fortieth hour
      // of a week is only knowable once the whole week has arrived.
      const ot = weeklyOvertime(r._entries, { from: periodStart, to: periodEnd });
      delete r._entries;
      r.weeks      = ot.weeks;
      r.regHours   = ot.regHours;
      r.otHours    = ot.otHours;
      r.otPwHours  = ot.otPwHours;
      r.otStdHours = ot.otStdHours;
      r.otClipped  = ot.clipped;
      // Total is pending + approved, the way the page's Total column reads it.
      r.totalHours = r.pendingHours + r.approvedHours;
      r.divisions  = [...r.divisions].sort();
      r.hasPending = r.pendingHours > 0.001;
      return r;
    })
    .sort((a, b) => a.username.localeCompare(b.username));

  const totals = { employees: employees.length };
  for (const k of TOTAL_KEYS) {
    totals[k] = employees.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  }
  totals.totalHours = totals.pendingHours + totals.approvedHours;
  // Overtime is per person per week, so a crew total is the sum of the people
  // and never a re-measurement of the crew — four men at 30 hours is 120 hours
  // and no overtime at all.
  totals.otClipped = employees.some(e => e.otClipped);

  return { periodStart, periodEnd, employees, totals };
}

module.exports = {
  payrollMetrics, COUNTED_STATUSES, offSiteHaulWork,
  weeklyOvertime, weekStartOf, weekEndOf, OT_WEEKLY_THRESHOLD,
};
