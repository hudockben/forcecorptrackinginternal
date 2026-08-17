'use strict';

// Dust Control roll-up arithmetic, ported from dust.html so the executive
// report reports the numbers the Dust Control home dashboard reports.
//
// Pure functions over rows already fetched from dust_control_entries. The
// per-row money is computed here rather than in SQL for one reason: dust.html
// computes it in JavaScript, and one copy of the formula is the only way the
// two can be guaranteed to agree.
//
//   rowHours / rowTotals ← calc()
//   invoiceStatus        ← effectiveInvStatus()
//
// The page's KPIs are year-to-date on the current year; its invoice overview
// covers 2026 and forward (before that, invoice dates weren't tracked).

const INVOICE_ERA_START_YEAR = 2026;
// Past this many days an unpaid invoice reads as overdue, matching the page.
const OVERDUE_AFTER_DAYS = 45;

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = n => Math.round(n * 100) / 100;

// "HH:MM" → minutes past midnight, or null when unparseable.
function parseMins(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

// Hours on the job, with overnight support: an end time before the start time
// means the crew worked past midnight.
function rowHours(row) {
  const s = parseMins(row && row.start_time);
  const e = parseMins(row && row.end_time);
  if (s === null || e === null) return 0;
  let mins = e - s;
  if (mins < 0) mins += 24 * 60;
  return round2(mins / 60);
}

// What the job invoices for: each vehicle's hourly rate over the hours worked,
// plus the UB product applied at that customer's rate (its own override when it
// has one, otherwise the division default).
function rowTotals(row, ubRateFor) {
  const hours    = rowHours(row);
  const v1Total  = round2(num(row && row.v1_rate) * hours);
  const v2Total  = round2(num(row && row.v2_rate) * hours);
  const gallons  = num(row && row.gallons_ub);
  const ubTotal  = round2(gallons * ubRateFor(row));
  return {
    hours,
    gallons,
    v1Total,
    v2Total,
    vehTotal: round2(v1Total + v2Total),
    ubTotal,
    invTotal: round2(round2(v1Total + v2Total) + ubTotal),
  };
}

// A per-customer UB rate override wins over the division default.
function ubRateResolver(companies, defaultRate) {
  const byName = new Map();
  for (const c of (Array.isArray(companies) ? companies : [])) {
    if (!c || c.name == null) continue;
    const r = parseFloat(c.ub_rate);
    if (Number.isFinite(r)) byName.set(String(c.name), r);
  }
  const fallback = Number.isFinite(parseFloat(defaultRate)) ? parseFloat(defaultRate) : 0;
  return row => {
    const own = byName.get(String((row && row.company) || ''));
    return own != null ? own : fallback;
  };
}

// Paid stays paid. Otherwise an invoice-era job with nothing received reads as
// overdue once it is old enough. `today` is passed in so the same rows classify
// the same way for a whole report.
function invoiceStatus(row, today) {
  if (row.inv_status === 'paid' || row.inv_received) return row.inv_status || '';
  const year = parseInt(String(row.date || '').slice(0, 4), 10);
  if (Number.isFinite(year) && year >= INVOICE_ERA_START_YEAR) {
    const d = new Date(String(row.date).slice(0, 10) + 'T00:00:00Z');
    if (!Number.isNaN(d.getTime())) {
      const days = Math.floor((today.getTime() - d.getTime()) / 86400000);
      if (days > OVERDUE_AFTER_DAYS) return 'overdue';
    }
  }
  return row.inv_status || '';
}

// ── The roll-up the executive report asks for ────────────────────────
// Returns the home dashboard's KPIs plus a per-customer table: the page ranks
// customers by year-to-date revenue, and that ranking is the closest thing Dust
// Control has to a project list — customers are the unit of work.
function dustMetrics({ rows, companies, ubRate, today }) {
  const now      = today || new Date();
  const thisYear = String(now.getFullYear());
  const thisMo   = `${thisYear}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ubRateFor = ubRateResolver(companies, ubRate);

  const computed = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object')
    .map(r => {
      const iso = String(r.date || '').slice(0, 10);
      return { ...r, date: iso, ...rowTotals(r, ubRateFor), status: invoiceStatus({ ...r, date: iso }, now) };
    });

  const ytd       = computed.filter(r => r.date.startsWith(thisYear));
  const thisMonth = computed.filter(r => r.date.startsWith(thisMo));

  const sum = (list, k) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const ytdRevenue = sum(ytd, 'invTotal');
  const ytdGallons = sum(ytd, 'gallons');
  const ytdHours   = sum(ytd, 'hours');
  const activeCos  = new Set(ytd.map(r => r.company).filter(Boolean)).size;
  const states     = [...new Set(ytd.map(r => r.state).filter(Boolean))].sort();

  // Invoice picture: the invoice era only, and only jobs that invoice for
  // something. Anything not paid and not overdue is outstanding — unsent,
  // sent-unpaid, or never tracked.
  const era = computed.filter(r => {
    const y = parseInt(r.date.slice(0, 4), 10);
    return Number.isFinite(y) && y >= INVOICE_ERA_START_YEAR && r.invTotal;
  });
  const overdue     = era.filter(r => r.status === 'overdue');
  const paid        = era.filter(r => r.status === 'paid');
  const outstanding = era.filter(r => r.status !== 'overdue' && r.status !== 'paid');
  const needsSent    = era.filter(r => !r.inv_sent);
  const needsPayment = era.filter(r => r.inv_sent && !r.inv_received && r.status !== 'paid');

  // Per-customer, year to date — the page's Top Customers list, widened into a
  // table. Overdue and unpaid are carried per customer because that is the
  // question an executive asks next.
  const byCustomer = new Map();
  for (const r of ytd) {
    const name = String(r.company || '').trim() || '— No customer —';
    if (!byCustomer.has(name)) byCustomer.set(name, {
      name, visits: 0, gallons: 0, hours: 0, revenue: 0,
      overdue: 0, unpaid: 0, paidAmt: 0, lastVisit: '',
      states: new Set(),
    });
    const c = byCustomer.get(name);
    c.visits++;
    c.gallons += r.gallons;
    c.hours   += r.hours;
    c.revenue += r.invTotal;
    if      (r.status === 'overdue') c.overdue += r.invTotal;
    else if (r.status === 'paid')    c.paidAmt += r.invTotal;
    else                             c.unpaid  += r.invTotal;
    if (r.state) c.states.add(r.state);
    if (r.date > c.lastVisit) c.lastVisit = r.date;
  }

  const customers = [...byCustomer.values()]
    .map(c => ({
      ...c,
      states:      [...c.states].sort(),
      avgPerVisit: c.visits > 0 ? c.revenue / c.visits : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));

  return {
    year: thisYear,
    month: thisMo,
    jobsYtd:      ytd.length,
    jobsThisMonth: thisMonth.length,
    revenueYtd:   ytdRevenue,
    gallonsYtd:   ytdGallons,
    hoursYtd:     ytdHours,
    activeCustomers: activeCos,
    avgRevenuePerJob: ytd.length ? ytdRevenue / ytd.length : 0,
    states,
    invoices: {
      overdue:     { amount: sum(overdue, 'invTotal'),     count: overdue.length },
      outstanding: { amount: sum(outstanding, 'invTotal'), count: outstanding.length },
      paid:        { amount: sum(paid, 'invTotal'),        count: paid.length },
      needsSent:    { amount: sum(needsSent, 'invTotal'),    count: needsSent.length },
      needsPayment: { amount: sum(needsPayment, 'invTotal'), count: needsPayment.length },
    },
    customers,
  };
}

module.exports = {
  INVOICE_ERA_START_YEAR,
  OVERDUE_AFTER_DAYS,
  parseMins,
  rowHours,
  rowTotals,
  ubRateResolver,
  invoiceStatus,
  dustMetrics,
};
