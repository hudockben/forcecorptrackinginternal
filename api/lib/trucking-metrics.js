'use strict';

// Trucking roll-up arithmetic, ported from trucking.html so the executive report
// reports the numbers the Trucking page reports.
//
// Pure functions over truck-division entries. Two things carry over from the
// page and both matter:
//
//   • Revenue is total_hours × haul_fee, per entry. There is no stored revenue
//     column — the figure only exists as that product, so it has to be computed
//     the same way in both places.
//   • "This year" is the most recent year that has entries, falling back to the
//     calendar year. A division whose last haul was in November does not read as
//     having earned nothing; it reads as its last real year.
//
// The invoice state (sent, paid) is owned by the Intercompany screen, which
// writes it back onto these same rows.

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const entryRevenue = e => num(e && e.total_hours) * num(e && e.haul_fee);
const entryHours   = e => num(e && e.total_hours);
const entryYear    = e => {
  const m = String((e && e.actual_date) || '').match(/^(\d{4})/);
  return m ? m[1] : null;
};

// The years present in the data, ascending.
function dataYears(entries) {
  return [...new Set(entries.map(entryYear).filter(Boolean))].sort();
}

// The page's "current" year: the latest year with entries, else the calendar
// year. `fallbackYear` is passed in rather than read from the clock so a whole
// report is built against one date.
function currentYear(entries, fallbackYear) {
  const years = dataYears(entries);
  return years.length ? years[years.length - 1] : String(fallbackYear);
}

// An entry is invoiced once it has been sent, paid once a payment date lands.
// Anything sent and unpaid is awaiting payment; anything unsent is still to
// invoice. A row with no money on it is not an invoicing question at all.
function invoiceState(e) {
  if (entryRevenue(e) <= 0) return 'none';
  if (e.date_paid) return 'paid';
  if (e.invoice_sent_date) return 'awaiting';
  return 'uninvoiced';
}

function truckingMetrics({ entries, fallbackYear }) {
  const all = (Array.isArray(entries) ? entries : []).filter(e => e && typeof e === 'object');

  const year     = currentYear(all, fallbackYear);
  const years    = dataYears(all);
  const prevYear = years.length > 1 ? years[years.length - 2] : null;

  const cur  = all.filter(e => entryYear(e) === year);
  const prev = prevYear ? all.filter(e => entryYear(e) === prevYear) : [];

  const sumRev = list => list.reduce((s, e) => s + entryRevenue(e), 0);
  const sumHrs = list => list.reduce((s, e) => s + entryHours(e), 0);

  const revenue = sumRev(cur);
  const hours   = sumHrs(cur);

  const units   = [...new Set(cur.map(e => e.unit).filter(Boolean))];
  const drivers = [...new Set(cur.map(e => e.driver).filter(Boolean))];

  // Averages come from the Financials sub-tab: per entry, and the mean haul fee
  // across entries (not revenue ÷ hours — the page averages the rate itself).
  const avgRevenuePerEntry = cur.length ? revenue / cur.length : 0;
  const avgHaulFee = cur.length
    ? cur.reduce((s, e) => s + num(e.haul_fee), 0) / cur.length
    : 0;

  const invoices = {
    uninvoiced: { amount: 0, count: 0 },
    awaiting:   { amount: 0, count: 0 },
    paid:       { amount: 0, count: 0 },
  };
  for (const e of cur) {
    const state = invoiceState(e);
    if (state === 'none') continue;
    invoices[state].amount += entryRevenue(e);
    invoices[state].count++;
  }

  // Per customer, the Customer Data sub-tab's aggregation, widened with the
  // invoice state so the money can be chased as well as counted.
  const byCustomer = new Map();
  for (const e of cur) {
    const name = String(e.customer || '').trim() || '(none)';
    if (!byCustomer.has(name)) byCustomer.set(name, {
      name, entries: 0, hours: 0, revenue: 0,
      uninvoiced: 0, awaiting: 0, paid: 0,
      units: new Set(), drivers: new Set(), lastHaul: '',
    });
    const c = byCustomer.get(name);
    c.entries++;
    c.hours   += entryHours(e);
    c.revenue += entryRevenue(e);
    const state = invoiceState(e);
    if (state !== 'none') c[state] += entryRevenue(e);
    if (e.unit)   c.units.add(String(e.unit));
    if (e.driver) c.drivers.add(String(e.driver));
    const d = String(e.actual_date || '').slice(0, 10);
    if (d > c.lastHaul) c.lastHaul = d;
  }

  const customers = [...byCustomer.values()]
    .map(c => ({
      ...c,
      units:   [...c.units].sort(),
      drivers: [...c.drivers].sort(),
      avgHaulFee: c.hours > 0 ? c.revenue / c.hours : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));

  return {
    year, prevYear,
    entryCount: cur.length,
    revenue, hours,
    prevRevenue: sumRev(prev),
    prevHours:   sumHrs(prev),
    activeUnits:   units.length,
    activeDrivers: drivers.length,
    avgRevenuePerEntry,
    avgHaulFee,
    invoices,
    customers,
  };
}

module.exports = {
  entryRevenue,
  entryHours,
  entryYear,
  dataYears,
  currentYear,
  invoiceState,
  truckingMetrics,
};
