'use strict';

// Intercompany roll-up arithmetic, ported from intercompany.html so the
// executive report reports the numbers the Intercompany page reports.
//
// This one has to read the same SOURCE, not just run the same formula. The page
// works off the fct_intercompany_billing_entries blob and two fields that only
// exist there — payment_received_date, and the per-source rate inputs — while
// the normalized intercompany_billing_entries table it syncs to has neither.
// The table also keeps every row the blob keeps, including the duplicates the
// page collapses on load, so counting from it over-reports.
//
//   dedupeBillingEntries ← loadBillingEntries()'s two-pass dedup
//   icAmount             ← icAmt()
//
// The rates chain is the page's too: dust_settings supplies the UB $/gal and
// per-customer overrides, and an explicitly saved rates blob may override the
// truck rate and a non-zero UB rate on top.

const { IC_SOURCES, DUST_IC_SOURCES, isDustSource } = require('./ic-sources');

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Dust billing that arrives as one flat total rather than as rate × quantity.
// The two are Dust Control's tags other than its tracking tab, so they come from
// the shared list rather than being written out again here.
const DUST_FLAT_TOTAL_SOURCES = DUST_IC_SOURCES.filter(s => s !== IC_SOURCES.DUST_TRACKING);
// Past this many days an unpaid invoice is an aged receivable.
const AR_AGED_DAYS = 30;

function shiftDaysIso(iso, days) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// The page's fallback when no rate has ever been saved. It reads this from
// localStorage, which does not exist server-side, so the same default stands in.
const DEFAULT_TRUCK_RATE = 121;

// Which division a row belongs to. Dust bills under several tags and the list of
// them lives in api/lib/ic-sources — a prefix test here would quietly disagree
// with intercompany.html's own _isDustSrc, which checks that same list.
const isDustEntry  = e => isDustSource(e && e.source);
const isTruckSource = e => String((e && e.source) || IC_SOURCES.TRUCKING) === IC_SOURCES.TRUCKING;
const isInjectedDust = e => String((e && e.source_id) || '').startsWith('tsd-');

// The blob accumulates duplicates from re-sends and CSV replacements, and the
// page collapses them the moment it loads. Reading the raw list — or the
// normalized table, which mirrors it row for row — double-counts the money.
//
// Two passes for dust rows carrying a source_id:
//   1a. per source_id, the entry with the latest sent_at wins.
//   1b. among those winners, MANUAL rows collapse by physical job key
//       (date + company + location + vehicle1, start_time ignored so a
//       time-less original folds into its timed CSV replacement).
// A payroll-injected dust row is exactly one approved timesheet entry, so two of
// them are two real hauls even when day, customer and truck all match — 1a alone
// decides those. Non-dust rows with a source_id are unique by (source,
// source_id); rows with no source_id fall back to a content key.
function dedupeBillingEntries(raw) {
  const list = (Array.isArray(raw) ? raw : []).filter(e => e && typeof e === 'object');

  const jobKey = e => [
    e.actual_date,
    String(e.company_name || '').toLowerCase(),
    String(e.location || '').toLowerCase(),
    String(e.vehicle1 || '').toLowerCase(),
  ].join('|');

  const bestBySourceId = new Map();
  for (const e of list) {
    if (e.source === 'dust' && e.source_id) {
      const prev = bestBySourceId.get(e.source_id);
      if (!prev || String(e.sent_at || '') > String(prev.sent_at || '')) {
        bestBySourceId.set(e.source_id, e);
      }
    }
  }
  const bestByJobKey = new Map();
  for (const e of bestBySourceId.values()) {
    if (isInjectedDust(e)) continue;   // identified by source_id alone
    const jk = jobKey(e);
    const prev = bestByJobKey.get(jk);
    if (!prev || String(e.sent_at || '') > String(prev.sent_at || '')) {
      bestByJobKey.set(jk, e);
    }
  }

  const seenContentKeys = new Set();
  const seenSourceIds   = new Set();
  const deduped = [];
  for (const e of list) {
    if (e.source === 'dust' && e.source_id) {
      if (isInjectedDust(e)) {
        if (bestBySourceId.get(e.source_id) === e) deduped.push(e);
      } else if (bestByJobKey.get(jobKey(e)) === e) {
        deduped.push(e);
      }
    } else if (e.source_id) {
      const sk = `${e.source || ''}|${e.source_id}`;
      if (!seenSourceIds.has(sk)) { seenSourceIds.add(sk); deduped.push(e); }
    } else {
      const ck = [
        e.actual_date,
        String(e.company_name || '').toLowerCase(),
        e.actual_start || '',
        String(e.location || '').toLowerCase(),
        e.source || '',
      ].join('|');
      if (!seenContentKeys.has(ck)) { seenContentKeys.add(ck); deduped.push(e); }
    }
  }
  return deduped;
}

// The rate chain the page walks: dust_settings for the UB $/gal and its
// per-customer overrides, then an explicitly saved rates blob on top — which may
// set the truck rate, and may raise the UB rate but only with a non-zero value.
function icRates({ ratesBlob, dustUbRate, dustCompanies }) {
  let truckRate = DEFAULT_TRUCK_RATE;
  let ubRate    = num(dustUbRate);

  const overrides = new Map();
  for (const c of (Array.isArray(dustCompanies) ? dustCompanies : [])) {
    if (!c || c.name == null || c.ub_rate == null || c.ub_rate === '') continue;
    const r = parseFloat(c.ub_rate);
    if (Number.isFinite(r)) overrides.set(String(c.name).trim().toLowerCase(), r);
  }

  const blob = (ratesBlob && typeof ratesBlob === 'object' && !Array.isArray(ratesBlob)) ? ratesBlob : null;
  if (blob) {
    if (blob.truck != null && num(blob.truck) > 0) truckRate = num(blob.truck);
    if (blob.ub    != null && num(blob.ub)    > 0) ubRate    = num(blob.ub);
  }

  const ubRateFor = name => {
    const own = overrides.get(String(name == null ? '' : name).trim().toLowerCase());
    return own != null ? own : ubRate;
  };
  return { truckRate, ubRate, ubRateFor };
}

// What one entry bills between the companies. Not the same as `total`, which is
// what the end customer is charged.
function icAmount(e, { truckRate, ubRateFor }) {
  if (DUST_FLAT_TOTAL_SOURCES.includes(e && e.source)) return num(e.total);
  if (isTruckSource(e)) return num(e.total_hours) * truckRate;
  return num(e.v1_total) + num(e.v2_total) + num(e.gallons_ub) * ubRateFor(e.company_name);
}

function icMetrics({ entries, ratesBlob, dustUbRate, dustCompanies, year, asOfIso }) {
  const rates = icRates({ ratesBlob, dustUbRate, dustCompanies });
  const amt   = e => icAmount(e, rates);
  const yr    = String(year);

  const deduped   = dedupeBillingEntries(entries);
  const duplicates = (Array.isArray(entries) ? entries.length : 0) - deduped.length;
  const yrEntries = deduped.filter(e => String(e.actual_date || '').slice(0, 4) === yr);

  const truck = yrEntries.filter(isTruckSource);
  const dust  = yrEntries.filter(isDustEntry);

  const sumIc  = list => list.reduce((s, e) => s + amt(e), 0);
  const sumRev = list => list.reduce((s, e) => s + num(e.total), 0);
  const sumHrs = list => list.reduce((s, e) => s + num(e.total_hours), 0);

  const truckIc = sumIc(truck);
  const dustIc  = sumIc(dust);

  // Anything billable that has not been invoiced, plus anything invoiced that
  // has not been paid. Together they are what is still owed inward.
  const noInvoice  = yrEntries.filter(e => amt(e) > 0 && !e.invoice_sent_date);
  const pendingPay = yrEntries.filter(e => e.invoice_sent_date && !e.payment_received_date);

  // Aged receivable: invoiced more than 30 days ago with no payment recorded.
  // Not year-scoped — an invoice from last year that is still unpaid is more of a
  // problem, not less. `asOf` is passed in so a whole report ages against one day.
  const agedCutoff = asOfIso ? shiftDaysIso(asOfIso, -AR_AGED_DAYS) : null;
  const aged = agedCutoff
    ? deduped.filter(e => e.invoice_sent_date
        && String(e.invoice_sent_date).slice(0, 10) < agedCutoff
        && !e.payment_received_date)
    : [];

  // Per company — the dashboard's Top Companies list, widened into a table.
  const byCompany = new Map();
  for (const e of yrEntries) {
    const name = String(e.company_name || '').trim() || 'Unknown';
    if (!byCompany.has(name)) byCompany.set(name, {
      name, entries: 0, hours: 0,
      truckIc: 0, dustIc: 0, ic: 0, revenue: 0,
      notInvoiced: 0, awaitingPayment: 0, paid: 0,
    });
    const c = byCompany.get(name);
    const a = amt(e);
    c.entries++;
    c.hours   += num(e.total_hours);
    c.ic      += a;
    c.revenue += num(e.total);
    if (isTruckSource(e))     c.truckIc += a;
    else if (isDustEntry(e))  c.dustIc  += a;
    if (a > 0 && !e.invoice_sent_date)                     c.notInvoiced     += a;
    else if (e.invoice_sent_date && !e.payment_received_date) c.awaitingPayment += a;
    else if (e.payment_received_date)                      c.paid            += a;
  }

  const companies = [...byCompany.values()]
    .sort((a, b) => b.ic - a.ic || a.name.localeCompare(b.name));

  return {
    year: yr,
    rates,
    duplicates,
    entryCount:   yrEntries.length,
    truckEntries: truck.length,
    dustEntries:  dust.length,
    truckIc, dustIc,
    totalIc:      truckIc + dustIc,
    customerRevenue: sumRev(yrEntries),
    totalHours:   sumHrs(yrEntries),
    outstanding: {
      amount: [...noInvoice, ...pendingPay].reduce((s, e) => s + amt(e), 0),
      count:  noInvoice.length + pendingPay.length,
    },
    notInvoiced:     { amount: sumIc(noInvoice),  count: noInvoice.length },
    awaitingPayment: { amount: sumIc(pendingPay), count: pendingPay.length },
    aged:            { amount: sumIc(aged),       count: aged.length, days: AR_AGED_DAYS },
    companies,
  };
}

module.exports = {
  DUST_FLAT_TOTAL_SOURCES,
  DEFAULT_TRUCK_RATE,
  AR_AGED_DAYS,
  isDustEntry,
  isTruckSource,
  dedupeBillingEntries,
  icRates,
  icAmount,
  icMetrics,
};
