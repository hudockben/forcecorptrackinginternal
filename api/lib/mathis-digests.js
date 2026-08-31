'use strict';
/* Mathis — one digest builder per division.
 *
 * Each of these is a thin wrapper over a metrics library that already exists
 * and is already tested. Nothing here recomputes a figure: quarry margin comes
 * from quarry-metrics.js, dust revenue from dust-metrics.js, job profit from
 * job-financials.js. Those libraries were ported line-for-line out of the
 * division pages and are pinned by port-equivalence tests, so an answer Mathis
 * gives and the number on the page behind it come from the same arithmetic.
 * A digest that did its own sums would be a second opinion, and a second
 * opinion about money is a support ticket.
 *
 * Two rules every builder here follows.
 *
 *   Read only through readBlob. It prefixes the company code and derives the
 *   division check from the key. api/executive/report.js reads the UNPREFIXED
 *   'fct_truck_division' as a fallback when a company's own blob is empty —
 *   app_data has no company_code column, so that row is shared by every
 *   tenant. Deliberately not inherited: see truckingDigest.
 *
 *   Say what you cannot answer. Every digest carries a `limits` array, and for
 *   several divisions the most important thing in it is that a figure the user
 *   is about to ask for does not exist. Trucking captures no cost anywhere, so
 *   trucking profit is not a number that can be computed — and revenue offered
 *   in its place would be a wrong answer delivered confidently.
 */

const report   = require('../executive/report');
const jobFin   = require('./job-financials');
const ctx      = require('./mathis-context');
const quarryM  = require('./quarry-metrics');
const dustM    = require('./dust-metrics');
const dustCost = require('./dust-cost-metrics');
const truckM   = require('./trucking-metrics');
const icM      = require('./ic-metrics');
const payrollM = require('./payroll-metrics');

const { readBlob, safeText, money } = ctx;

const DEFAULT_JOB_ROWS = 12;
const MAX_JOB_ROWS     = 40;
// How many rows of any per-thing breakdown (customers, pits, employees) travel
// with a digest. Enough to answer "who is the biggest", small enough that one
// noisy division cannot fill the whole request.
const LIST_CAP = 15;

/**
 * Truncate a list and say so. A digest that quietly drops the tail invites an
 * answer about "all our customers" built from fifteen of them.
 */
function capList(list, cap = LIST_CAP) {
  const all = Array.isArray(list) ? list : [];
  return {
    rows: all.slice(0, cap),
    total: all.length,
    truncated: all.length > cap,
  };
}

const asArray = v => (Array.isArray(v) ? v : []);
const round2  = v => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

/** Read a blob, mapping readBlob's status onto what the metrics libs expect. */
async function blobValue(c, key) {
  const r = await readBlob(c, key);
  return r.status === 'ok' ? r.value : null;
}

// ── Job divisions: turf, paving, kiewit ────────────────────────────────────

const JOB_LIMITS = ctx.JOB_LIMITS;

const countIds = v => {
  if (Array.isArray(v)) return v.length;
  if (v && Array.isArray(v.ids)) return v.ids.length;
  return 0;
};

function pickJobRow(r) {
  return {
    name:       safeText(r.name),
    jobNumber:  safeText(r.jobNumber, 40),
    status:     safeText(r.status, 40),
    complete:   !!r.complete,
    inProgress: !!r.inProgress,
    contract:   money(r.contract),
    bid:        money(r.bid),
    actualCost: money(r.actual),
    projectedFinalCost: money(r.projected),
    variance:   money(r.variance),
    projectedProfit: r.profit    === null ? null : money(r.profit),
    actualProfit:    r.actProfit === null ? null : money(r.actProfit),
  };
}

async function jobDigest(c, division, opts = {}) {
  const div = jobFin.jobDivision(division);
  if (!div) return null;

  const want  = Number(opts.limit);
  const limit = Number.isFinite(want) && want > 0 ? Math.min(Math.floor(want), MAX_JOB_ROWS) : DEFAULT_JOB_ROWS;

  const idx = await readBlob(c, report.PROJECT_KEYS[division].index);
  if (idx.status === 'denied') return { division, kind: 'denied' };
  const totalProjects = countIds(idx.value);

  const projects = (await div.read(c.sql, c.companyCode, { limit })).filter(Boolean);
  if (!projects.length) {
    return {
      division, divisionName: div.name, kind: 'jobs',
      totalProjects, includedProjects: 0, rows: [], summary: null,
      ordering: 'none — this division has no projects on file',
      limits: JOB_LIMITS,
    };
  }

  const fin  = await report.buildFinancials(c.sql, c.companyCode, division, projects, null);
  const rows = jobFin.rowsFor(div, projects, fin, false);

  return {
    division,
    divisionName: div.name,
    kind: 'jobs',
    totalProjects,
    includedProjects: rows.length,
    truncated: totalProjects > rows.length,
    ordering: 'Most recent first, as the division page orders its own project list (pinned jobs lead). There is no created-at date on a project, so this is the ordering "the last N jobs" refers to; say which ordering you used.',
    rows: rows.map(pickJobRow),
    summary: jobFin.summarise(rows),
    limits: JOB_LIMITS,
  };
}

// ── Quarry ─────────────────────────────────────────────────────────────────

const QUARRY_LIMITS = [
  'Quarry "margin" is a per-ton contribution — average price per ton minus variable cost and royalty per ton. It is NOT job profit and must never be described as profit on a project.',
  'Sales tax, net-of-tax sales and total-due are derived in the browser from the sales-tax period settings and exist in no figure here. If asked, say the figure is not available server-side.',
  'There is no month-by-month trend in this data beyond the flow figure for the cutoff month. Do not describe a trend across months.',
  'Break-even tons is null when there is not enough information to compute it. Null means unknown; it does not mean zero and it does not mean the pit breaks even.',
];

async function quarryDigest(c, opts = {}) {
  const B = report.QUARRY_BLOBS;
  const [sales, daily, crush, inventory, lossPct, monthlyFixed, royalty, lists] = await Promise.all([
    blobValue(c, B.sales), blobValue(c, B.daily), blobValue(c, B.crush), blobValue(c, B.inventory),
    blobValue(c, B.lossPct), blobValue(c, B.monthlyFixed), blobValue(c, B.royalty), blobValue(c, B.lists),
  ]);

  const m = quarryM.quarryMetrics({
    sales: asArray(sales), daily: asArray(daily), crush: asArray(crush),
    inventory, lossPct, monthlyFixed, royalty, lists,
    year: opts.year, cutoff: opts.cutoff,
  });

  const pit = e => ({
    name:        safeText(e.name, 60),
    totalSales:  money(e.totalSales),
    tonsSold:    round2(e.tonsSold),
    salesCount:  e.salesCount,
    dailyCost:   money(e.dailyCost),
    crushCost:   money(e.crushCost),
    tonsCrushed: round2(e.tonsCrushed),
  });

  const locations = capList((m.locations || []).map(pit));
  const onHand    = capList(((m.inventory && m.inventory.locations) || []).map(l => ({
    name:   safeText(l.name, 60),
    onHand: round2(l.onHand),
  })));

  return {
    division: 'quarry',
    divisionName: 'Quarry',
    kind: 'quarry',
    year: m.year,
    cutoff: m.cutoff,
    entryCount: m.entryCount,
    total: m.total ? pit(m.total) : null,
    locations,
    inventory: { onHand: round2(m.inventory && m.inventory.onHand), byLocation: onHand },
    monthFlow: m.flow || null,
    stockAlert: m.alert ? {
      pit:  safeText(m.alert.value, 60),
      note: safeText(m.alert.sub, 160),
      tone: safeText(m.alert.tone, 12),
    } : null,
    breakEven: m.breakEven ? {
      name:           safeText(m.breakEven.name, 60),
      avgPricePerTon: money(m.breakEven.avgPrice),
      varCostPerTon:  money(m.breakEven.varCostPerTon),
      royaltyPerTon:  money(m.breakEven.royaltyPerTon),
      contributionPerTon: money(m.breakEven.contribution),
      monthlyFixedCost:   money(m.breakEven.monthlyFixed),
      breakEvenTons:  m.breakEven.breakEvenTons === null ? null : round2(m.breakEven.breakEvenTons),
      // breakEvenStatus returns {tone, value, sub}, not a string. Passing the
      // object through safeText stringified it to "[object Object]" — which
      // the model would have read as the status and could have repeated.
      status: m.breakEven.status ? {
        state: safeText(m.breakEven.status.value, 40),
        note:  safeText(m.breakEven.status.sub, 120),
        tone:  safeText(m.breakEven.status.tone, 12),
      } : null,
    } : null,
    limits: QUARRY_LIMITS,
  };
}

// ── Dust control ───────────────────────────────────────────────────────────

const DUST_LIMITS = [
  'productMargin is a PRODUCT margin: what one sprayed gallon costs to make against what one gallon is charged. It is not a margin on a job, a customer or a season, and it must never be described as one.',
  'It is only as good as the batch entered on the Product Cost page. When productMargin.ready is false, marginPct and profitPerGal are null — that is unknown, not break-even. Say the batch has not been entered.',
  'Always state which charge basis it used. "invoice" is invoice total over gallons, "ub" is UB revenue over gallons, "custom" is a figure somebody typed in. The three give different margins on the same product and the division picks one.',
  'A book shown as unavailable could not be read. Its revenue is missing from the totals, so the totals are a floor, not the division\'s earnings. Say so rather than reporting the smaller figure as if it were complete.',
  'Revenue spans three books: pad Tracking, Other Billing and EES Other. "Jobs" counts pad visits only, so job counts and revenue are not two views of the same rows.',
];

async function dustDigest(c) {
  const yearStart = `${new Date().getUTCFullYear()}-01-01`;
  const eraStart  = `${dustM.INVOICE_ERA_START_YEAR}-01-01`;
  const from      = yearStart < eraStart ? yearStart : eraStart;

  // A book that could not be read must stay null. Collapsing it to [] reports
  // the division as billing less than it did, and the smaller figure looks
  // exactly like a real one — dustMetrics reads null as "unavailable".
  const bookOf = async key => {
    const r = await readBlob(c, key);
    if (r.status === 'ok')    return Array.isArray(r.value) ? r.value : null;
    if (r.status === 'empty') return [];
    return null;
  };

  const [rows, companies, ubRate, obRows, eesRows] = await Promise.all([
    c.sql`
      SELECT date::text AS date, company, location, state,
             start_time, end_time,
             v1_rate::float AS v1_rate, v2_rate::float AS v2_rate,
             gallons_ub::float AS gallons_ub,
             inv_sent::text AS inv_sent, inv_received::text AS inv_received, inv_status
        FROM dust_control_entries
       WHERE company_code = ${c.companyCode}
         AND date IS NOT NULL
         AND date >= ${from}::date
    `.catch(err => { console.error('[mathis] dust rows failed:', err.message); return null; }),
    c.sql`SELECT name, ub_rate::float AS ub_rate FROM dust_companies WHERE company_code = ${c.companyCode}`
      .catch(() => []),
    c.sql`SELECT ub_rate::float AS v FROM dust_settings WHERE company_code = ${c.companyCode}`
      .then(r => (r[0] && r[0].v) || 0).catch(() => 0),
    bookOf('dust_other_billing_rows'),
    bookOf('dust_ees_other_rows'),
  ]);

  // profit_margin has no normalized column — api/dust-config.js says so — and
  // lives in the dust_settings blob. Read through readBlob, which prefixes the
  // company: dust-config.js also falls back to an UNPREFIXED 'dust_settings'
  // key, and that row belongs to whichever tenant wrote it last.
  const settings = await blobValue(c, 'dust_settings');
  const pm = (settings && typeof settings === 'object') ? settings.profit_margin : null;

  const m = dustM.dustMetrics({
    rows, obRows, eesRows,
    companies: companies || [],
    ubRate: ubRate || 0,
  });

  const unavailable = [];
  if (rows === null)    unavailable.push('Tracking');
  if (obRows === null)  unavailable.push('Other Billing');
  if (eesRows === null) unavailable.push('EES Other');

  // The panel narrows its charge to the year the user picked; the rest of this
  // digest is year-to-date, so the same year keeps the two consistent.
  const margin = dustProductMarginFor(pm, rows, ubRate, companies, m.year);

  return {
    division: 'dust',
    divisionName: 'Dust Control',
    kind: 'dust',
    year: m.year,
    productMargin: margin,
    unavailableBooks: unavailable,
    revenue: m.revenue,
    revenueYtd: money(m.revenueYtd),
    jobsYtd: m.jobsYtd,
    jobsThisMonth: m.jobsThisMonth,
    gallonsYtd: round2(m.gallonsYtd),
    hoursYtd: round2(m.hoursYtd),
    activeCustomers: m.activeCustomers,
    avgRevenuePerJob: money(m.avgRevenuePerJob),
    invoices: m.invoices,
    customers: capList((m.customers || []).map(x => ({
      name:    safeText(x.name || x.customer, 60),
      revenue: money(x.revenue),
      jobs:    x.jobs,
    }))),
    limits: DUST_LIMITS,
  };
}

/**
 * The product-cost margin, or an explicit "nothing entered" rather than a
 * pile of zeros. `rows` may be null when the Tracking book could not be read,
 * in which case an invoice- or UB-based charge has nothing behind it.
 */
function dustProductMarginFor(pm, rows, ubRate, companies, year) {
  const out = dustCost.dustProductMargin({
    pm, rows: Array.isArray(rows) ? rows : [], ubRate: ubRate || 0,
    companies: companies || [], year,
  });
  return {
    ready:            out.ready,
    costToMakePerGal: out.costToMakePerGal || null,
    chargePerGal:     out.chargePerGal || null,
    chargeBasis:      out.chargeBasis,
    profitPerGal:     out.profitPerGal,
    marginPct:        out.marginPct,
    markupPct:        out.markupPct,
    mixParts:         out.mixParts || null,
    concentratePerGal: out.concentratePerGal || null,
    batchTotalCost:   out.batch.totalCost || null,
    batchGallons:     out.batch.totalGallons || null,
    fromTracking: {
      jobs:          out.tracking.jobs,
      gallons:       out.tracking.gallons,
      perGalInvoice: out.tracking.perGalInvoice,
      perGalUb:      out.tracking.perGalUb,
      year:          out.tracking.year,
    },
  };
}

// ── Trucking ───────────────────────────────────────────────────────────────

const TRUCKING_LIMITS = [
  'THERE IS NO TRUCKING COST ANYWHERE IN THIS SYSTEM. Trucking profit and trucking margin do not exist as numbers and cannot be computed from anything here. If asked for either, say that the system does not capture what a haul costs. Never offer revenue as the answer to a profit question, and never call revenue profit.',
  'Revenue is not a stored figure either. It is hours multiplied by the haul fee, worked out at read time, so it moves when a rate or an hour is edited.',
  'Only this company\'s own trucking blob is read. Figures cover the hauls recorded there and nothing else.',
];

async function truckingDigest(c) {
  // Only the company-scoped key. api/executive/report.js also reads the
  // unprefixed 'fct_truck_division' when this one is empty, and since app_data
  // has no company_code column that row belongs to whichever tenant wrote it
  // last. A company with no hauls of its own must read as having none.
  const entries = asArray(await blobValue(c, 'fct_truck_division'));
  const m = truckM.truckingMetrics({ entries, fallbackYear: new Date().getUTCFullYear() });

  return {
    division: 'trucking',
    divisionName: 'Trucking',
    kind: 'trucking',
    year: m.year,
    entryCount: m.entryCount,
    revenue: money(m.revenue),
    hours: round2(m.hours),
    prevYear: m.prevYear,
    prevRevenue: money(m.prevRevenue),
    activeUnits: m.activeUnits,
    activeDrivers: m.activeDrivers,
    avgHaulFee: money(m.avgHaulFee),
    avgRevenuePerEntry: money(m.avgRevenuePerEntry),
    invoices: m.invoices,
    customers: capList((m.customers || []).map(x => ({
      name:    safeText(x.name || x.customer, 60),
      revenue: money(x.revenue),
      hours:   round2(x.hours),
      avgHaulFee: money(x.avgHaulFee),
    }))),
    cost: null,
    profit: null,
    limits: TRUCKING_LIMITS,
  };
}

// ── Intercompany ───────────────────────────────────────────────────────────

const IC_LIMITS = [
  'These figures come from the intercompany billing blob, which is the authoritative record. The mirrored table over-reports, so any figure a report drew from that table may be higher; this one is the correct one.',
  'Intercompany amounts are what one division bills another. They are not customer revenue and not profit.',
  'A duplicate count above zero means the same haul was posted more than once and has already been collapsed. Mention it if it is not zero.',
];

async function icDigest(c) {
  const [entries, ratesBlob, dustUbRate, dustCompanies] = await Promise.all([
    blobValue(c, 'fct_intercompany_billing_entries'),
    blobValue(c, 'fct_intercompany_rates'),
    c.sql`SELECT ub_rate::float AS v FROM dust_settings WHERE company_code = ${c.companyCode}`
      .then(r => (r[0] && r[0].v) || 0).catch(() => 0),
    c.sql`SELECT name, ub_rate::float AS ub_rate FROM dust_companies WHERE company_code = ${c.companyCode}`
      .catch(() => []),
  ]);

  // icMetrics dedupes internally (ic-metrics.js:160), so raw entries go in.
  const m = icM.icMetrics({
    entries: asArray(entries),
    ratesBlob,
    dustUbRate: dustUbRate || 0,
    dustCompanies: dustCompanies || [],
  });

  return {
    division: 'intercompany',
    divisionName: 'Intercompany',
    kind: 'intercompany',
    year: m.year,
    entryCount: m.entryCount,
    duplicatesCollapsed: m.duplicates,
    billed: { total: money(m.totalIc), truck: money(m.truckIc), dust: money(m.dustIc) },
    truckEntries: m.truckEntries,
    dustEntries: m.dustEntries,
    customerRevenue: money(m.customerRevenue),
    totalHours: round2(m.totalHours),
    outstanding: m.outstanding,
    notInvoiced: m.notInvoiced,
    awaitingPayment: m.awaitingPayment,
    aged: m.aged,
    companies: capList((m.companies || []).map(x => ({
      name:   safeText(x.name || x.company, 60),
      amount: money(x.ic),
    }))),
    limits: IC_LIMITS,
  };
}

// ── Payroll ────────────────────────────────────────────────────────────────

const PAYROLL_LIMITS = [
  'THIS DATA CARRIES NO PAY RATE AND NO DOLLAR FIGURE OF ANY KIND. Hours are hours. No question about pay, wages, labour cost or payroll spend can be answered from it — say the rates are not in this data rather than estimating from anything.',
  'Figures cover the current biweekly pay period only, and only entries that are submitted or approved. A draft an employee has not sent is not counted and must not be described as missing time.',
  'Prevailing-wage hours are split by a flag on the job, not by a rate. It says which work was prevailing-wage, not what any of it paid.',
];

async function payrollDigest(c) {
  const { startIso, endIso } = report.biweeklyPayPeriod(new Date());

  let rows;
  try {
    rows = await c.sql`
      SELECT user_id, username, entry_type, status, division, job_id,
             work_date::text             AS work_date,
             computed_hours::float       AS computed_hours,
             travel_hours::float         AS travel_hours,
             travel_to_site_hours::float AS travel_to_site_hours,
             travel_to_shop_hours::float AS travel_to_shop_hours
        FROM timesheet_entries
       WHERE company_code = ${c.companyCode}
         AND status IN ('submitted', 'approved')
         AND work_date >= ${startIso}::date
         AND work_date <= ${endIso}::date
    `;
  } catch (err) {
    console.error('[mathis] payroll entries failed:', err.message);
    return { division: 'payroll', kind: 'payroll', error: true, limits: PAYROLL_LIMITS };
  }

  const entries = rows || [];
  // Resolves one boolean per job — whether the work was prevailing-wage — from
  // the project blob, which is where that flag lives. It is company-scoped
  // (report.js keys it "{company}:{prefix}{job_id}"), and it reads no figure:
  // this is the one place a payroll caller touches a job blob, and it comes
  // back with a flag, never a dollar.
  try { await report.attachPrevailingWage(c.sql, c.companyCode, entries); }
  catch (err) { console.error('[mathis] prevailing-wage lookup failed:', err.message); }

  const m = payrollM.payrollMetrics({ entries, periodStart: startIso, periodEnd: endIso });

  return {
    division: 'payroll',
    divisionName: 'Payroll',
    kind: 'payroll',
    periodStart: m.periodStart,
    periodEnd: m.periodEnd,
    totals: m.totals,
    employees: capList((m.employees || []).map(e => ({
      name:          safeText(e.username || e.name, 60),
      workHours:     round2(e.workHours),
      travelHours:   round2(e.travelHours),
      pendingHours:  round2(e.pendingHours),
      approvedHours: round2(e.approvedHours),
      pwHours:       round2(e.pwHours),
      stdHours:      round2(e.stdHours),
      daysWorked:    e.daysWorked,
    }))),
    limits: PAYROLL_LIMITS,
  };
}

// ── Personal mode ──────────────────────────────────────────────────────────

const PERSONAL_LIMITS = ctx.PERSONAL_LIMITS;

async function personalDigest(c) {
  let rows = [];
  try {
    rows = await c.sql`
      SELECT work_date, status, entry_type, time_off_type, job_label,
             COALESCE(computed_hours, 0)::float AS hours,
             COALESCE(travel_hours, 0)::float   AS travel_hours
      FROM   timesheet_entries
      WHERE  company_code = ${c.companyCode}
        AND  user_id      = ${c.authz.userId}
        AND  work_date   >= CURRENT_DATE - INTERVAL '45 days'
      ORDER  BY work_date DESC
      LIMIT  120
    `;
  } catch (err) {
    console.error('[mathis] personal digest failed:', err.message);
    return { division: null, kind: 'personal', rows: [], byStatus: {}, error: true, limits: PERSONAL_LIMITS };
  }

  const byStatus = {};
  for (const r of rows) {
    const k = r.status || 'draft';
    byStatus[k] = byStatus[k] || { entries: 0, hours: 0, travelHours: 0 };
    byStatus[k].entries += 1;
    byStatus[k].hours   += Number(r.hours) || 0;
    byStatus[k].travelHours += Number(r.travel_hours) || 0;
  }
  for (const v of Object.values(byStatus)) {
    v.hours = round2(v.hours);
    v.travelHours = round2(v.travelHours);
  }

  return {
    division: null,
    kind: 'personal',
    window: 'the last 45 days',
    rows: rows.map(r => ({
      workDate:  r.work_date instanceof Date ? r.work_date.toISOString().slice(0, 10) : String(r.work_date || ''),
      status:    safeText(r.status, 20),
      entryType: safeText(r.entry_type, 20),
      timeOffType: r.time_off_type ? safeText(r.time_off_type, 20) : null,
      job:       safeText(r.job_label),
      hours:     round2(r.hours),
      travelHours: round2(r.travel_hours),
    })),
    byStatus,
    limits: PERSONAL_LIMITS,
  };
}

// ── The router ─────────────────────────────────────────────────────────────

const BUILDERS = {
  quarry:       quarryDigest,
  dust:         dustDigest,
  trucking:     truckingDigest,
  intercompany: icDigest,
  payroll:      payrollDigest,
};

/**
 * Assemble the one digest this turn may see. Exactly one division, already
 * resolved and authorised by the caller. Cross-division comparison is not a
 * feature left out — the single-division digest is what makes the whole thing
 * defensible, and widening it is a decision, not a tweak.
 */
async function buildDigest(c, division, opts = {}) {
  if (!division) return await personalDigest(c);
  // On the timesheet page the honest subject is the person, whoever is asking.
  // The review side of that queue is payroll, which has its own page and its
  // own digest, so answering here with anything but the asker's own entries
  // would be answering a different question. The other field-side keys (fuel,
  // driver, quarry sales) are NOT folded in: a driver asking what they are
  // hauling tomorrow would get timesheet hours, which is a wrong answer rather
  // than a missing one.
  if (division === 'timesheet') return await personalDigest(c);
  if (jobFin.jobDivision(division)) return await jobDigest(c, division, opts);

  const builder = BUILDERS[division];
  if (builder) return await builder(c, opts);

  return {
    division,
    kind: 'unsupported',
    reason: ctx.NOT_YET[division] || 'This division is not wired into Mathis yet.',
    limits: ['Answer only that this division is not available yet, and say plainly what is missing. Do not substitute a figure from another division or from another metric.'],
  };
}

module.exports = {
  DEFAULT_JOB_ROWS,
  MAX_JOB_ROWS,
  LIST_CAP,
  QUARRY_LIMITS,
  DUST_LIMITS,
  TRUCKING_LIMITS,
  IC_LIMITS,
  PAYROLL_LIMITS,
  capList,
  buildDigest,
  jobDigest,
  personalDigest,
  quarryDigest,
  dustDigest,
  truckingDigest,
  icDigest,
  payrollDigest,
};
