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

function emptyEmployee(username) {
  return {
    username,
    workHours: 0, travelToSite: 0, travelToShop: 0, travelHours: 0,
    pwHours: 0, stdHours: 0, haulHours: 0,
    pendingHours: 0, approvedHours: 0,
    pendingOff: 0, approvedOff: 0,
    daysWorked: 0,
    divisions: new Set(),
    _dates: new Set(),
  };
}

const TOTAL_KEYS = [
  'workHours', 'travelToSite', 'travelToShop', 'travelHours',
  'pwHours', 'stdHours', 'haulHours', 'pendingHours', 'approvedHours',
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

    if (e.entry_type === 'daily') {
      const work   = num(e.computed_hours);
      const travel = num(e.travel_hours);
      const h      = work + travel;

      if (COUNTED_STATUSES.has(e.status)) {
        acc.workHours    += work;
        acc.travelHours  += travel;
        acc.travelToSite += num(e.travel_to_site_hours);
        acc.travelToShop += num(e.travel_to_shop_hours);
        // An off-site haul is standard even on a prevailing job, so its work
        // hours join the travel in the standard bucket. Every other case is
        // unchanged: 'on_site' and null both fall through to the old rule.
        const offSiteHaul = e.haul_type === 'off_site';
        if (e.prevailing_wage === true && !offSiteHaul) {
          acc.pwHours  += work; acc.stdHours += travel;
        } else {
          acc.stdHours += h;
        }
        // Only hours this rule actually MOVED. A driver's off-site haul on a
        // job that was never prevailing wage is standard either way, and
        // counting it here had the executive strip report "40.00 h off-site
        // haul excluded" beside a prevailing total of 0.00 — describing a
        // reclassification that never happened.
        if (offSiteHaul && e.prevailing_wage === true) acc.haulHours += work;
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

  return { periodStart, periodEnd, employees, totals };
}

module.exports = { payrollMetrics, COUNTED_STATUSES };
