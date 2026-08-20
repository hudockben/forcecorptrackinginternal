'use strict';

// Dust Control roll-up arithmetic, ported from dust.html so the executive
// report reports the numbers the Dust Control home dashboard reports.
//
// Pure functions over rows already fetched from the division's THREE billing
// books. The per-row money is computed here rather than in SQL for one reason:
// dust.html computes it in JavaScript, and one copy of the formula is the only
// way the two can be guaranteed to agree.
//
//   rowHours / rowTotals ← calc()       (Dust Control Tracking)
//   obRowTotals          ← obCalc()     (Other Billing)
//   eesRowTotals         ← eeCalc()     (EES Other)
//   invoiceStatus        ← effectiveInvStatus()
//
// scripts/test-dust-metrics-port.js runs the same fixture through this module
// and through dust.html itself and asserts the same answers, which is what
// keeps a port from being worse than no port at all.
//
// The page's KPIs are year-to-date on the current year; its invoice overview
// covers 2026 and forward (before that, invoice dates weren't tracked).
//
// ── Why three books, and what may be added across them ──────────────────
//
// Dust Control invoices off three grids, and payroll posts an approved haul
// into exactly one of them: Dust Control Tracking bills vehicle rates times
// hours plus UB gallons, Other Billing bills quantity times price per unit plus
// trucking hours times a rate, and EES Other bills hours times a rate on the
// standing pre-load / wash work. They are disjoint by construction (see
// legDest in api/timesheet-entries.js), so no haul is counted twice.
//
// DOLLARS are therefore additive, and the division's revenue is the sum. Almost
// nothing else is:
//
//   gallons   Tracking's gallons_ub is UB product APPLIED. Other Billing's
//             gallons_bags is a quantity DELIVERED whose unit is whatever the
//             MU column says — gallons on one row, bags on the next. Adding
//             them would invent a number that measures nothing, so "Gallons
//             YTD" stays UB-only and delivered quantity is reported beside it,
//             per unit, never totalled.
//   hours     Tracking hours are the clock window on the pad; Other Billing's
//             are trucking hours; EES's are worked hours on a standing job.
//             Three measures, three figures, never one.
//   jobs      A tracking row is a pad visit. An Other Billing row is a
//             delivery. Counting them together would make "Avg Rev / Job" a
//             ratio of two different denominators, so visits stay tracking's
//             and Avg Rev / Job stays tracking revenue over tracking visits.
//   invoices  Only Tracking carries inv_sent / inv_received / inv_status, so
//             only Tracking rows can be aged into overdue / unpaid / paid.
//             Putting an Other Billing row into those buckets would be
//             inventing an invoice state it does not have. The money on the
//             other two books is reported as its own figure — `untracked` —
//             precisely because the AR chase cannot see it.
//
// CUSTOMERS do span the books: the same customer is billed off more than one
// of them, and "how much is this customer worth" is a question about the
// division, not about a grid. So the customer table is keyed across all three.

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

// ── Other Billing ─────────────────────────────────────────────────────
// A port of obCalc() in dust.html. Material sold plus the trucking that carried
// it — two independent products on one invoice line, rounded separately before
// they are added, because that is the order the tab rounds them in and a
// half-cent that survives one path and not the other is exactly the drift this
// module exists to prevent.
function obRowTotals(row) {
  const qty      = num(row && row.gallons_bags);
  const price    = num(row && row.price_per_unit);
  const hours    = num(row && row.trucking_hrs);
  const rate     = num(row && row.trucking_rate);
  const matTotal = round2(qty * price);
  const trkTotal = round2(hours * rate);
  return {
    quantity: qty,
    // Whatever the office measures this row in. Kept as typed rather than
    // normalised to a known list: an unrecognised unit must read as its own
    // unit, never be folded into gallons.
    unit:     String((row && row.mu) || '').trim(),
    hours,
    matTotal,
    trkTotal,
    invTotal: round2(matTotal + trkTotal),
  };
}

// ── EES Other ─────────────────────────────────────────────────────────
// A port of eeIsBillable() / eeCalc() in dust.html. Only a Billable row carries
// money; a Non-Billable one still has real hours — that is the whole point of
// tracking it — but never a total.
//
// It does still reach Intercompany: _reconcileEesBilling over there gates on
// HOURS rather than money, so the work shows up at $0 instead of vanishing.
// (Both copies of this comment used to claim the opposite. They are held in
// step by scripts/test-dust-metrics-port.js, so fixing one and not the other is
// how the wrong half survives.)
function eesIsBillable(row) {
  return String((row && row.billing) || '').trim().toLowerCase() === 'billable';
}

function eesRowTotals(row) {
  const hours    = num(row && row.actual_hours);
  const rate     = num(row && row.rate);
  const billable = eesIsBillable(row);
  return {
    hours,
    billable,
    // A Billable row with no rate is not $0 of work — it is work nobody has
    // priced yet. It totals zero either way, but it is counted separately so
    // the figure can be shown rather than silently swallowed into revenue.
    unpriced: billable && hours > 0 && rate === 0,
    invTotal: billable ? round2(hours * rate) : 0,
  };
}

// A customer's identity across the three books. The same customer is spelled
// its own way in each grid — one has a dropdown off dust_companies, one is free
// text — so a raw-string key would rank the same customer three times. Case and
// runs of whitespace are the differences that show up in practice; anything
// beyond that is a different customer until somebody says otherwise.
function customerKey(name) {
  return String(name == null ? '' : name).trim().replace(/\s+/g, ' ').toLowerCase();
}

const NO_CUSTOMER = '— No customer —';

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
function dustMetrics({ rows, obRows, eesRows, companies, ubRate, today }) {
  const now      = today || new Date();
  const thisYear = String(now.getFullYear());
  const thisMo   = `${thisYear}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ubRateFor = ubRateResolver(companies, ubRate);

  // A book is UNAVAILABLE when its caller passes null — the read threw, or the
  // page has not finished loading it — and merely EMPTY when it passes []. The
  // two must not be conflated: an unavailable book makes every division-wide
  // figure a smaller number that looks exactly like a real one, which is the
  // single worst thing this module could do. Omitting the argument entirely
  // means empty, so a caller written before there were three books keeps its
  // existing answers rather than silently going dark.
  const avail = v => v !== null;
  const list  = v => (Array.isArray(v) ? v.filter(r => r && typeof r === 'object') : []);
  const obIn  = obRows  === undefined ? [] : obRows;
  const eesIn = eesRows === undefined ? [] : eesRows;
  const coverage = {
    tracking: avail(rows),
    other:    avail(obIn),
    ees:      avail(eesIn),
  };
  coverage.complete = coverage.tracking && coverage.other && coverage.ees;

  const computed = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object')
    .map(r => {
      const iso = String(r.date || '').slice(0, 10);
      return { ...r, date: iso, ...rowTotals(r, ubRateFor), status: invoiceStatus({ ...r, date: iso }, now) };
    });

  const ytd       = computed.filter(r => r.date.startsWith(thisYear));
  const thisMonth = computed.filter(r => r.date.startsWith(thisMo));

  // The other two books, on the same year window and with their own arithmetic.
  // Each row is reduced to the four things a division-wide roll-up can ask of
  // any book: when, who, how much money, and how many hours OF ITS OWN KIND.
  const obComputed = list(obIn).map(r => {
    const iso = String(r.date || '').slice(0, 10);
    return { ...r, date: iso, customerName: r.customer, ...obRowTotals(r) };
  });
  const eesComputed = list(eesIn).map(r => {
    const iso = String(r.actual_date || '').slice(0, 10);
    return { ...r, date: iso, customerName: r.customer, ...eesRowTotals(r) };
  });
  const obYtd  = obComputed.filter(r => r.date.startsWith(thisYear));
  const eesYtd = eesComputed.filter(r => r.date.startsWith(thisYear));

  const sum = (list, k) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const trackingRevenue = sum(ytd, 'invTotal');
  const obRevenue       = sum(obYtd, 'invTotal');
  const eesRevenue      = sum(eesYtd, 'invTotal');
  // The division's revenue. The three books are disjoint by construction, so
  // this is a sum and not a merge — see the header.
  const ytdRevenue = round2(trackingRevenue + obRevenue + eesRevenue);
  const ytdGallons = sum(ytd, 'gallons');
  const ytdHours   = sum(ytd, 'hours');
  // Customers span the books; jobs, gallons and hours do not.
  const activeCos  = new Set([
    ...ytd.map(r => r.company),
    ...obYtd.map(r => r.customerName),
    ...eesYtd.map(r => r.customerName),
  ].map(customerKey).filter(Boolean)).size;
  // Other Billing carries a state column too, and a customer served only off
  // that book is still a state this division worked in this year. EES has none.
  const states     = [...new Set([
    ...ytd.map(r => r.state),
    ...obYtd.map(r => r.state),
  ].filter(Boolean))].sort();

  // Delivered quantity, per unit, never totalled — gallons of one thing and
  // bags of another do not add. Ordered by size so the dominant unit reads
  // first; a row with no MU gets its own bucket rather than joining gallons.
  const byUnit = new Map();
  for (const r of obYtd) {
    if (!r.quantity) continue;
    const u = r.unit || '(no unit)';
    byUnit.set(u, (byUnit.get(u) || 0) + r.quantity);
  }
  const deliveredQuantity = [...byUnit.entries()]
    .map(([unit, qty]) => ({ unit, quantity: round2(qty) }))
    .sort((a, b) => b.quantity - a.quantity || a.unit.localeCompare(b.unit));

  const obHours       = round2(sum(obYtd, 'hours'));
  const eesBillable   = eesYtd.filter(r => r.billable);
  const eesHours      = { billable: round2(sum(eesBillable, 'hours')),
                          nonBillable: round2(sum(eesYtd.filter(r => !r.billable), 'hours')) };
  // Work recorded with nobody's price on it. It totals zero either way; the
  // point of counting it is that zero revenue on real hours is a gap to close,
  // not a fact about the job.
  const unpriced = {
    // Quantity recorded with no price, AND no trucking money either — a row
    // that bills trucking is priced, whatever its material column says. Written
    // as "not (hours and rate)" rather than comparing either against zero, so a
    // negative figure sitting in the blob lands the same way on both surfaces.
    other: obYtd.filter(r => r.quantity > 0 && !num(r.price_per_unit)
                          && !(r.hours && num(r.trucking_rate))).length,
    ees:   eesYtd.filter(r => r.unpriced).length,
  };
  unpriced.count = unpriced.other + unpriced.ees;

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
  // Keyed across all three books on the normalised name, so a customer billed
  // off two of them is one row rather than two. The DISPLAY name is the raw
  // spelling that carries the most revenue — picking arbitrarily would show the
  // office a spelling it does not use.
  const byCustomer = new Map();
  const bump = (rawName, date, apply) => {
    const key  = customerKey(rawName) || NO_CUSTOMER;
    const name = String(rawName || '').trim();
    if (!byCustomer.has(key)) byCustomer.set(key, {
      name: name || NO_CUSTOMER,
      visits: 0, gallons: 0, hours: 0,
      revenue: 0, revenueTracking: 0, revenueOther: 0, revenueEes: 0,
      overdue: 0, unpaid: 0, paidAmt: 0, untracked: 0,
      lastVisit: '', states: new Set(),
      _spellings: new Map(),
    });
    const c = byCustomer.get(key);
    apply(c);
    if (name) c._spellings.set(name, (c._spellings.get(name) || 0) + 1);
    if (date && date > c.lastVisit) c.lastVisit = date;
    return c;
  };

  for (const r of ytd) {
    bump(r.company, r.date, c => {
      // Visits, gallons and hours are Tracking's measures — see the header.
      c.visits++;
      c.gallons += r.gallons;
      c.hours   += r.hours;
      c.revenue         += r.invTotal;
      c.revenueTracking += r.invTotal;
      if      (r.status === 'overdue') c.overdue += r.invTotal;
      else if (r.status === 'paid')    c.paidAmt += r.invTotal;
      else                             c.unpaid  += r.invTotal;
      if (r.state) c.states.add(r.state);
    });
  }
  for (const r of obYtd) {
    bump(r.customerName, r.date, c => {
      c.revenue      += r.invTotal;
      c.revenueOther += r.invTotal;
      // Not overdue, not unpaid, not paid — this book has no invoice state to
      // age, so its money sits in its own column rather than being guessed into
      // one of the three the AR chase reads.
      c.untracked    += r.invTotal;
      if (r.state) c.states.add(r.state);
    });
  }
  for (const r of eesYtd) {
    bump(r.customerName, r.date, c => {
      c.revenue    += r.invTotal;
      c.revenueEes += r.invTotal;
      c.untracked  += r.invTotal;
    });
  }

  const customers = [...byCustomer.values()]
    .map(c => {
      // The spelling seen most often wins; ties go to the first seen, which is
      // Tracking's, because that grid picks its customer off dust_companies.
      let best = c.name, bestN = -1;
      for (const [spelling, n] of c._spellings) if (n > bestN) { best = spelling; bestN = n; }
      const { _spellings, ...rest } = c;
      return {
        ...rest,
        name:        best || NO_CUSTOMER,
        states:      [...c.states].sort(),
        revenue:     round2(c.revenue),
        revenueTracking: round2(c.revenueTracking),
        revenueOther:    round2(c.revenueOther),
        revenueEes:      round2(c.revenueEes),
        untracked:   round2(c.untracked),
        // Per PAD VISIT, which is Tracking's denominator — so the numerator is
        // Tracking's revenue too. Dividing three books of money by one book of
        // visits would inflate it by whatever the other two billed.
        avgPerVisit: c.visits > 0 ? c.revenueTracking / c.visits : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));

  // Money on the other two books, over the same invoice era. Reported rather
  // than bucketed: it is real revenue that the overdue / unpaid / paid figures
  // beside it structurally cannot see, and a reader who does not know that will
  // read those three as the division's whole AR picture.
  const eraYear = d => {
    const y = parseInt(String(d || '').slice(0, 4), 10);
    return Number.isFinite(y) && y >= INVOICE_ERA_START_YEAR;
  };
  const obEra  = obComputed.filter(r => eraYear(r.date) && r.invTotal);
  const eesEra = eesComputed.filter(r => eraYear(r.date) && r.invTotal);

  // One line per book, pre-formatted here rather than on each surface, so the
  // dashboard and the report cannot describe the same book differently. Each
  // carries its OWN measures — the units are part of the number.
  // Formatted here AND in dust.html, in the same expression, because the two
  // surfaces print the same string and neither can require the other. Up to two
  // decimals with no trailing zeros: rounding a part-bag away would report a
  // quantity nobody delivered, and padding a whole one with ".00" would differ
  // from the page for no reason.
  //
  // scripts/test-dust-metrics-port.js compares these STRINGS, not just the
  // numbers behind them — a formatter that drifted is still a figure that
  // disagrees with itself across two screens. dust.html's own numFmt is
  // deliberately not the model here: it pins minimum and maximum fraction
  // digits to the same number, so a part-bag would be rounded away.
  const qtyStr = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fmtQty = list => list.map(q => `${qtyStr(q.quantity)} ${q.unit}`).join(' · ');
  // Hours to one decimal WITH thousands separators — dust.html's numFmt(n, 1).
  // The two have to match to the character: the first version of this printed
  // "5" where the page printed "5.0", which the port test caught immediately.
  const hrsStr = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // `volume` and `hoursText` are the rendered STRINGS, because the units are
  // part of the answer and both surfaces have to say it the same way. The raw
  // `hours` number stays alongside for anything that needs to compute.
  const books = [
    {
      key: 'tracking', label: 'Dust Control Tracking',
      available: coverage.tracking,
      lines: ytd.length, revenue: round2(trackingRevenue),
      hours: round2(ytdHours), hoursLabel: 'field hours',
      hoursText: ytdHours ? `${hrsStr(round2(ytdHours))} field hours` : '',
      volume: ytdGallons ? `${Math.round(ytdGallons).toLocaleString('en-US')} gal UB` : '',
      ar: 'invoiced here — sent, paid and overdue all tracked',
    },
    {
      key: 'other', label: 'Other Billing',
      available: coverage.other,
      lines: obYtd.length, revenue: round2(obRevenue),
      hours: obHours, hoursLabel: 'trucking hours',
      hoursText: obHours ? `${hrsStr(obHours)} trucking hours` : '',
      volume: fmtQty(deliveredQuantity),
      ar: 'invoice number only — no sent or paid date on this side',
    },
    {
      key: 'ees', label: 'EES Other',
      available: coverage.ees,
      lines: eesYtd.length, revenue: round2(eesRevenue),
      hours: eesHours.billable, hoursLabel: 'billable hours',
      hoursText: eesHours.billable ? `${hrsStr(eesHours.billable)} billable hours` : '',
      volume: eesHours.nonBillable
        ? `${hrsStr(eesHours.nonBillable)} non-billable hours` : '',
      ar: 'no dust-side invoice — billed through Intercompany',
    },
  ];

  return {
    year: thisYear,
    month: thisMo,
    // Pad visits, and Tracking's alone: an Other Billing row is a delivery and
    // an EES row is a shift, so counting them here would change what the word
    // means. `books[].lines` is where the other two are counted.
    jobsYtd:      ytd.length,
    jobsThisMonth: thisMonth.length,
    // The division's revenue across all three books.
    revenueYtd:   ytdRevenue,
    revenue: {
      tracking: round2(trackingRevenue),
      other:    round2(obRevenue),
      ees:      round2(eesRevenue),
      total:    ytdRevenue,
    },
    // UB product applied. Delivered quantity is `deliveredQuantity`, per unit.
    gallonsYtd:   ytdGallons,
    deliveredQuantity,
    // Clock hours on the pad. The other books' hours are their own measures.
    hoursYtd:     ytdHours,
    otherHoursYtd: obHours,
    eesHoursYtd:   eesHours,
    activeCustomers: activeCos,
    // Tracking revenue over Tracking visits — the two halves of the ratio have
    // to come off the same book or it is not an average of anything.
    avgRevenuePerJob: ytd.length ? trackingRevenue / ytd.length : 0,
    states,
    unpriced,
    books,
    coverage,
    invoices: {
      overdue:     { amount: sum(overdue, 'invTotal'),     count: overdue.length },
      outstanding: { amount: sum(outstanding, 'invTotal'), count: outstanding.length },
      paid:        { amount: sum(paid, 'invTotal'),        count: paid.length },
      needsSent:    { amount: sum(needsSent, 'invTotal'),    count: needsSent.length },
      needsPayment: { amount: sum(needsPayment, 'invTotal'), count: needsPayment.length },
      // NOT one of the buckets above, and deliberately named so it cannot be
      // mistaken for one: revenue with no dust-side invoice state at all.
      untracked: {
        amount: round2(sum(obEra, 'invTotal') + sum(eesEra, 'invTotal')),
        count:  obEra.length + eesEra.length,
        byBook: { other: round2(sum(obEra, 'invTotal')), ees: round2(sum(eesEra, 'invTotal')) },
      },
    },
    customers,
  };
}

module.exports = {
  INVOICE_ERA_START_YEAR,
  OVERDUE_AFTER_DAYS,
  NO_CUSTOMER,
  parseMins,
  rowHours,
  rowTotals,
  obRowTotals,
  eesIsBillable,
  eesRowTotals,
  customerKey,
  ubRateResolver,
  invoiceStatus,
  dustMetrics,
};
