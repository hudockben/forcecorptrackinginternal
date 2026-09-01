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
const dailyM   = require('./daily-cost-metrics');
const truckM   = require('./trucking-metrics');
const icM      = require('./ic-metrics');
const payrollM = require('./payroll-metrics');
const schedBoard = require('../scheduler/board');
const driverSched = require('../driver/schedule');

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

/* What a digest is ABOUT, in plain words.
 *
 * `limits` says how the figures inside could be misread. This says whether the
 * question is even in the building. They are different failures and only one
 * of them was guarded: asked about rubber inventory on turf, Mathis returned
 * projected profit — it described what it had, because nothing told it what it
 * did not have, and a blob of job rows next to any question invites a summary
 * of the blob.
 *
 * A closed list of everything a division does NOT hold is impossible to keep
 * true. A short list of what it DOES hold is easy to keep true, and the prompt
 * turns anything outside it into "I don't have that".
 */
const COVERS = {
  jobs: ['per-job contract value, bid budget, actual cost to date, projected final cost, projected and actual profit, and variance'],
  job_history: ['how each job\'s contract, cost and projected profit have MOVED over a window of days, from a nightly snapshot — the only history in this system'],
  quarry: ['sales, tons sold and crushed, cost per pit, tons on hand, and per-ton contribution against break-even'],
  dust: ['revenue across the three billing books, gallons, invoice ageing, and the product margin on a sprayed gallon'],
  trucking: ['haul revenue, hours, active units and drivers, and invoice state'],
  intercompany: ['what each division billed another, hours, and what is uninvoiced or aged'],
  payroll: ['hours for the current pay period, by employee and by status'],
  scheduler: ['sub-code pace and status, extra laborers implied, double-bookings and time off'],
  fuel_admin: ['fill-ups, gallons, fleet and per-truck economy, balancing state, and statement variance'],
  executive: ['one headline figure per division the user can reach'],
  personal: ['the asking user\'s own timesheet entries and hours'],
  own_fuel: ['the asking user\'s own fuel fill-ups'],
  own_driver: ['the hauls assigned to the asking user'],
  own_quarry_sales: ['the asking user\'s own scale-house loads'],
};

const asArray = v => (Array.isArray(v) ? v : []);
const round2  = v => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

/**
 * Read a company-scoped blob whose key does NOT carry its division.
 *
 * readBlob derives the division check from the key, which is the right default
 * and is what stops a caller naming a resource they cannot have. Purchase
 * orders break the pattern: their key is
 * `{company}:fct_purchase_orders:{division}`, and divisionForKey sees no known
 * prefix and answers 'turf' — so a paving foreman asking for paving's own
 * purchase orders would be refused for lacking turf.
 *
 * So the check is made here instead, against the division — and the KEY is
 * built from the division that check returned, not from anything the caller
 * held separately. Passing the two independently is how a read ends up
 * authorised for one division and pointed at another's row; `keyFor` makes
 * that combination impossible to write rather than merely wrong.
 */
async function readScopedBlob(c, keyFor, requested) {
  const division = ctx.resolveDivision(requested, c.authz);
  if (!division) return { status: 'denied', value: null, division: null };
  const key = keyFor(division);
  try {
    const rows = await c.sql`SELECT value FROM app_data WHERE key = ${`${c.companyCode}:${key}`}`;
    if (!rows.length || rows[0].value == null) return { status: 'empty', value: null, division };
    return { status: 'ok', value: rows[0].value, division };
  } catch (err) {
    console.error(`[mathis] scoped blob read failed for ${key}:`, err.message);
    return { status: 'error', value: null, division };
  }
}

/** Read a blob, mapping readBlob's status onto what the metrics libs expect. */
async function blobValue(c, key) {
  const r = await readBlob(c, key);
  return r.status === 'ok' ? r.value : null;
}

// ── Job divisions: turf, paving, kiewit ────────────────────────────────────

const JOB_LIMITS = ctx.JOB_LIMITS.concat([
  'A purchase order\'s value is what was ordered — quantity times unit cost, plus tax, across its lines. It is not what has been spent and not what has been invoiced, and it must never be added to a job\'s actual cost, which already counts the delivered material.',
  'Purchase orders are listed for the whole division. A PO\'s `job` is filled in only when that job is among the rows in this digest; `job: null` means the job is outside the window shown, NOT that the PO is unassigned.',
  'Equipment cost is hours times the unit cost the daily row was written with — or the imported total when the row carries one. It is ALREADY part of that job\'s actualCost: it breaks that number down by machine and must never be added to it.',
  'The equipment roster\'s unit cost is the rate the list carries TODAY. A row costed last year kept the rate it was written with, so the two can differ and the row is the one that was paid.',
  'Equipment assigned to a job is a plan, not a record. A machine can be assigned and never turn up, or turn up without being assigned; `hours` is what actually ran and `assigned` is what somebody intended.',
  'Equipment hours cover only the jobs in this digest. A machine showing no hours may well have run on an older job — say the window rather than calling it idle.',
  'Labor cost is the rate stored ON EACH DAILY ROW times its hours — not the roster rate today, because a prevailing-wage job is costed at a different rate and a closed job keeps what it was written with. Like equipment, it is ALREADY part of that job\'s actualCost and must never be added to it.',
  'Employees assigned to a job are a plan, not a record, exactly as with equipment. `byJob.assigned` is who somebody put on the job; `worked` is who actually logged hours.',
  'When `employees.payVisible` is false there are no pay rates and no worked hours in this digest, because the asking user\'s access level does not include them — the division page hides them too. Say they are not available at this access level. Do NOT estimate a rate, do not derive one from any other figure, and do not describe the absence as "no rates on file".',
  'The document vault is counted, never read. There is no file content here of any kind: a question about what a contract, permit or change order SAYS cannot be answered from this, only how many such files exist and when they were uploaded.',
  'Deleted documents are excluded, including any still inside the 30-day trash window. "No documents" for a job means none on file now.',
  'The document read stops at 500 files. When `documents.truncated` is true the counts are a floor, not a total — say so rather than reporting them as the whole vault.',
  'The cost-code catalogue is the list of codes this division uses with the quantity and unit cost carried against each. It is a catalogue, not spend: actual spend per job is each job\'s actualCost.',
]);

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

// Where each job division keeps its cost-code catalogue. Turf's is unprefixed,
// which divisionForKey correctly reads as turf.
const COST_ROW_KEYS = {
  turf:   'fct_cost_rows',
  paving: 'fct_paving_cost_rows',
  kiewit: 'fct_kiewit_cost_rows',
};

const poValue = po => (Array.isArray(po && po.lines) ? po.lines : []).reduce((sum, l) => {
  const qty  = Number(l && l.qty) || 0;
  const cost = Number(l && l.unit_cost) || 0;
  const tax  = Number(l && l.tax) || 0;
  return sum + qty * cost + tax;
}, 0);

/**
 * Purchase orders for one job division.
 *
 * `notes` is deliberately dropped. It is free text any colleague can write, it
 * answers no question anybody asks about a PO, and every field like it that
 * reaches the model is surface for no benefit.
 */
async function purchaseOrders(c, division, projectNames) {
  // 'empty' is a fact, not an absence: every job division raises purchase
  // orders, so a missing blob means none have been raised yet. Returning null
  // for it would drop the subject out of `covers`, and "I don't have purchase
  // orders" is a different — and wrong — answer from "none on file".
  const r = await readScopedBlob(c, d => `fct_purchase_orders:${d}`, division);
  if (r.status === 'denied' || r.status === 'error') return null;
  const list = asArray(r.value);
  if (!list.length) return { count: 0, totalValue: 0, byStatus: {}, bySupplier: capList([]), rows: capList([]) };

  const byStatus = {}, bySupplier = new Map();
  let total = 0;
  const rows = [];
  for (const po of list) {
    if (!po || typeof po !== 'object') continue;
    const value = round2(poValue(po));
    total += value;
    const st = safeText(po.status, 30) || 'Open';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const sup = safeText(po.supplier, 60) || '(none)';
    bySupplier.set(sup, round2((bySupplier.get(sup) || 0) + value));
    rows.push({
      poNumber: safeText(po.po_number, 40),
      title:    safeText(po.title),
      supplier: sup,
      status:   st,
      // Only the jobs in this digest's window have names here; a PO against an
      // older job gets null rather than an id nobody can read.
      job:      projectNames.get(String(po.project_id || '')) || null,
      costCode: safeText(po.cost_code, 20),
      subCode:  safeText(po.sub_code, 20),
      dated:    safeText(po.date_created, 20),
      value,
      lines:    Array.isArray(po.lines) ? po.lines.length : 0,
    });
  }
  rows.sort((a, b) => b.value - a.value);

  return {
    count: rows.length,
    totalValue: round2(total),
    byStatus,
    bySupplier: capList([...bySupplier.entries()]
      .map(([supplier, value]) => ({ supplier, value }))
      .sort((a, b) => b.value - a.value)),
    rows: capList(rows),
  };
}

/**
 * The cost-code catalogue: which codes this division uses, what quantity is
 * carried against each and what it is costed at. Not daily spend — that is in
 * daily_tracking and reaches the digest as each job's `actualCost`.
 */
async function costCodes(c, division) {
  const key = COST_ROW_KEYS[division];
  if (!key) return null;
  // readBlob, not blobValue: blobValue folds 'denied' and 'empty' into the
  // same null, and those are the two cases that have to be told apart here.
  const r = await readBlob(c, key);
  if (r.status === 'denied' || r.status === 'error') return null;
  const list = asArray(r.value);
  if (!list.length) return { count: 0, rows: capList([]) };
  const rows = list.filter(r => r && typeof r === 'object').map(r => ({
    costCode:    safeText(r.cost_code || r.costCode, 20),
    subCode:     safeText(r.sub_code  || r.subCode, 20),
    description: safeText(r.description, 80),
    quantity:    round2(r.quantity),
    unitCost:    money(r.bid_item_cost != null ? r.bid_item_cost : r.bidItemCost),
    status:      safeText(r.status, 20) || 'Active',
  }));
  return { count: rows.length, rows: capList(rows) };
}

// Each job division keeps its own roster blob — employees, equipment,
// suppliers. api/timesheet-entries.js writes the same map down.
const LISTS_KEYS = {
  turf:   'fct_lists',
  paving: 'fct_paving_lists',
  kiewit: 'fct_kiewit_lists',
};

/**
 * Equipment: the roster, what is assigned where, and what actually ran.
 *
 * Three different questions live under one word here and they have three
 * different answers. "What does a roller cost us" is the roster's unit cost.
 * "What is on Atwood" is the job's assignment list. "What did we actually run"
 * is the daily rows — and only that last one is a figure about money.
 *
 * The dollars are a BREAKDOWN of each job's actual cost, not an addition to
 * it: daily rows are what actual cost is made of. Saying so is the limit
 * below, and it is the same trap purchase orders set from the other side.
 */
async function equipment(c, division, projects) {
  const key = LISTS_KEYS[division];
  if (!key) return null;
  const r = await readBlob(c, key);
  if (r.status === 'denied' || r.status === 'error') return null;

  const lists   = r.value && typeof r.value === 'object' ? r.value : {};
  const roster  = asArray(lists.equipment).length ? asArray(lists.equipment)
                                                  : asArray(lists.equipmentList);
  const catalogue = roster.map(e => (typeof e === 'string'
    ? { name: safeText(e, 80), unitCost: null }
    : { name: safeText(e && e.name, 80),
        unitCost: money(e && (e.unit_cost != null ? e.unit_cost : e.unitCost)) }
  )).filter(e => e.name);

  const usage = dailyM.equipmentUsage(projects, report.projName);

  // What a PM assigned to the job, which is a plan and not a record: a machine
  // can be assigned and never turn up, and turn up without being assigned.
  const byJob = [];
  for (const proj of projects) {
    const assigned = asArray(proj && proj.assigned_equipment)
      .map(n => safeText(n, 80)).filter(Boolean);
    const job = report.projName(proj);
    const ran = usage.rows.filter(u => u.jobs.includes(job));
    if (!assigned.length && !ran.length) continue;
    byJob.push({
      job,
      assigned: capList(assigned),
      piecesRun: ran.length,
      hours: round2(ran.reduce((t, u) => t + u.hours, 0)),
      cost:  money(ran.reduce((t, u) => t + u.cost, 0)),
    });
  }

  return {
    count: catalogue.length,
    catalogue: capList(catalogue),
    usage: {
      totalHours: usage.totalHours,
      totalCost:  money(usage.totalCost),
      rows: capList(usage.rows.map(u => ({
        name: u.name, hours: u.hours, cost: money(u.cost),
        jobs: capList(u.jobs),
      }))),
    },
    byJob: capList(byJob),
  };
}

/**
 * Employees: the roster, who is on which job, and — for those allowed to see
 * it — what people are paid and the hours behind the labor cost.
 *
 * This is the one block here with a check inside it beyond "which division".
 * tracker.html shows pay rates only in the Manage Lists modal, and hides that
 * modal, the Daily tab and Labor Analytics below level3. A level2 foreman
 * therefore cannot see what his crew earns on his own page, and answering it
 * in a chat window would make this feature a permissions bypass. Names and
 * assignments stay open to everyone with the division, because the project
 * card already shows both.
 *
 * `payVisible` travels with the digest so the model can say WHY a rate is
 * missing. Without it the absence looks like no data, and "we have no rates on
 * file" is a wrong answer to a question that was really about permission.
 */
async function employees(c, division, projects) {
  const key = LISTS_KEYS[division];
  if (!key) return null;
  const r = await readBlob(c, key);
  if (r.status === 'denied' || r.status === 'error') return null;

  const payVisible = ctx.canSeePay(c.authz, division);
  const lists = r.value && typeof r.value === 'object' ? r.value : {};

  const roster = asArray(lists.employees).map(e => {
    const name = safeText(typeof e === 'string' ? e : (e && e.name), 80);
    if (!name) return null;
    if (!payVisible) return { name };
    const o = typeof e === 'object' && e ? e : {};
    return {
      name,
      jobClass: safeText(o.job_class || o.jobClass, 60),
      // Both rates, because which one applies is the JOB's prevailing-wage
      // flag and not the person's — reporting one as "their rate" is wrong
      // half the time.
      prevailingRate:    money(o.prevailing_rate    != null ? o.prevailing_rate    : o.pw_rate),
      nonPrevailingRate: money(o.non_prevailing_rate != null ? o.non_prevailing_rate : o.non_pw_rate),
    };
  }).filter(Boolean);

  // Assignment is a plan and visible to everyone; hours are the record and
  // are not. Keeping them in separate fields is what stops one being answered
  // with the other.
  const byJob = [];
  for (const proj of projects) {
    const assigned = asArray(proj && proj.assigned_employees)
      .map(n => safeText(n, 80)).filter(Boolean);
    if (!assigned.length) continue;
    byJob.push({ job: report.projName(proj), assigned: capList(assigned) });
  }

  let worked = null;
  if (payVisible) {
    const u = dailyM.laborUsage(projects, report.projName);
    worked = {
      totalHours: u.totalHours,
      totalLaborCost: money(u.totalCost),
      rows: capList(u.rows.map(x => ({
        name: x.name, hours: x.hours, laborCost: money(x.cost), jobs: capList(x.jobs),
      }))),
    };
  }

  return { count: roster.length, payVisible, roster: capList(roster), byJob: capList(byJob), worked };
}

// How far back a history read looks by default, and the ceiling on it.
const DEFAULT_HISTORY_DAYS = 90;
const MAX_HISTORY_DAYS     = 400;   // matches the cron's retention

const HISTORY_LIMITS = [
  'This series begins the day the nightly snapshot started running. There is NO data before `firstDay`, and a question about a period earlier than that has no answer here — say the history does not go back that far rather than describing the earliest point as if it were the start of the job.',
  'A row is the projection AS IT STOOD at the end of that day, not what was spent that day. actualCost is cost-to-date and climbs; the difference between two days is roughly what was booked between them, and only if nobody edited a bid item in between.',
  'Projected profit can move because cost was booked, because somebody changed the contract value, or because a bid item was edited. These rows cannot tell those apart. Describe WHAT changed; do not assert WHY unless the figures make it unambiguous.',
  'A missing day is a day the snapshot did not run — a deploy, an outage, a job that had not been created yet. It is not a day with no work. Do not read a gap as a pause.',
  'A job appearing part-way through the series entered the data then, which is not the same as the job starting then.',
  'With fewer than two distinct days there is no trend, only one point. Say so plainly instead of describing a direction.',
];

/**
 * How the jobs have moved, from the nightly snapshot.
 *
 * Everything else here is a picture of now. This is the only thing in the
 * system that knows what a job looked like last month, and it exists because
 * "how has profit trended" previously had no answer that was not invented.
 *
 * The figures are not recomputed and not re-derived: api/cron/job-snapshot.js
 * wrote them through the same rowsFor path the live digest uses, so a point on
 * this series and the number on the page today came from one piece of
 * arithmetic.
 */
async function jobHistory(c, division, opts = {}) {
  const div = jobFin.jobDivision(division);
  if (!div) return null;

  const want = Number(opts.days);
  const days = Number.isFinite(want) && want > 0
    ? Math.min(Math.floor(want), MAX_HISTORY_DAYS)
    : DEFAULT_HISTORY_DAYS;

  let rows;
  try {
    rows = await c.sql`
      SELECT project_id, day::text AS day, job_name, job_number, status, complete,
             contract::float         AS contract,
             actual_cost::float      AS actual_cost,
             projected_cost::float   AS projected_cost,
             projected_profit::float AS projected_profit,
             actual_profit::float    AS actual_profit
        FROM mathis_job_facts
       WHERE company_code = ${c.companyCode}
         AND division     = ${division}
         AND day >= CURRENT_DATE - ${days}::integer
       ORDER BY day ASC
    `;
  } catch (err) {
    console.error('[mathis] job history read failed:', err.message);
    return null;
  }

  const list = Array.isArray(rows) ? rows : [];
  const dayKeys = [...new Set(list.map(r => r.day))].sort();

  // Said out loud rather than left for the reader to notice. On the first
  // night after deploy this branch is the whole answer, and a single point
  // described as a trend is exactly the invented answer the snapshot exists
  // to replace.
  if (dayKeys.length < 2) {
    return {
      division, divisionName: div.name, kind: 'job_history',
      covers: COVERS.job_history,
      windowDays: days, days: dayKeys.length,
      firstDay: dayKeys[0] || null, lastDay: dayKeys[dayKeys.length - 1] || null,
      enough: false,
      note: dayKeys.length === 0
        ? 'No snapshots have been taken for this division yet.'
        : 'Only one day has been captured so far, so there is nothing to compare it against.',
      totals: capList([]), rows: capList([]),
      limits: HISTORY_LIMITS,
    };
  }

  // Per-day division totals. Nulls stay out of the sums rather than counting
  // as zero — a job with no contract on file would otherwise drag the series
  // down on the day it was created.
  const byDay = new Map();
  for (const r of list) {
    let d = byDay.get(r.day);
    if (!d) byDay.set(r.day, (d = { day: r.day, jobs: 0, contract: 0, actualCost: 0, projectedCost: 0, projectedProfit: 0 }));
    d.jobs++;
    if (r.contract         != null) d.contract         += r.contract;
    if (r.actual_cost      != null) d.actualCost       += r.actual_cost;
    if (r.projected_cost   != null) d.projectedCost    += r.projected_cost;
    if (r.projected_profit != null) d.projectedProfit  += r.projected_profit;
  }
  const totals = [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map(d => ({
      day: d.day, jobs: d.jobs,
      contract: money(d.contract), actualCost: money(d.actualCost),
      projectedCost: money(d.projectedCost), projectedProfit: money(d.projectedProfit),
    }));

  // Per job: where it started in this window, where it is now, and the move.
  const byJob = new Map();
  for (const r of list) {
    const key = String(r.project_id);
    let j = byJob.get(key);
    if (!j) byJob.set(key, (j = { first: r, last: r }));
    if (r.day < j.first.day) j.first = r;
    if (r.day > j.last.day)  j.last  = r;
  }
  const delta = (a, b) => (a == null || b == null ? null : money(b - a));
  const jobs = [...byJob.values()].map(({ first, last }) => ({
    name:      safeText(last.job_name),
    jobNumber: safeText(last.job_number, 40),
    status:    safeText(last.status, 40),
    complete:  !!last.complete,
    firstSeen: first.day,
    from: {
      day: first.day,
      contract: money(first.contract), actualCost: money(first.actual_cost),
      projectedCost: money(first.projected_cost), projectedProfit: money(first.projected_profit),
    },
    to: {
      day: last.day,
      contract: money(last.contract), actualCost: money(last.actual_cost),
      projectedCost: money(last.projected_cost), projectedProfit: money(last.projected_profit),
    },
    change: {
      contract:         delta(first.contract, last.contract),
      actualCost:       delta(first.actual_cost, last.actual_cost),
      projectedCost:    delta(first.projected_cost, last.projected_cost),
      projectedProfit:  delta(first.projected_profit, last.projected_profit),
    },
    // A job whose window starts after the series does was not there on day
    // one, and the model has to be able to tell that apart from one that
    // simply did not move.
    partialWindow: first.day !== dayKeys[0],
  })).sort((a, b) => {
    const A = a.change.projectedProfit, B = b.change.projectedProfit;
    if (A == null) return 1;
    if (B == null) return -1;
    return Math.abs(B) - Math.abs(A);
  });

  return {
    division, divisionName: div.name, kind: 'job_history',
    covers: COVERS.job_history,
    windowDays: days,
    days: dayKeys.length,
    firstDay: dayKeys[0],
    lastDay: dayKeys[dayKeys.length - 1],
    enough: true,
    ordering: 'Jobs are ordered by how far projected profit moved across the window, biggest move first, regardless of direction.',
    totals: capList(totals, 60),
    rows: capList(jobs),
    limits: HISTORY_LIMITS,
  };
}

/**
 * The document vault: how much paperwork exists and where, never what is in it.
 *
 * project_documents carries company_code AND division as real columns, so this
 * is one of the few reads here that is a plain scoped query rather than a blob.
 * Three fields are left behind on purpose. storage_key and storage_url are the
 * object-store path — an access route, not an answer. `note` is free text a
 * colleague typed, same as a purchase order's.
 *
 * Soft-deleted rows are excluded. They sit in a 30-day trash window that only
 * an administrator can see through the documents page, and a digest that
 * counted them would answer a question the asker cannot verify.
 */
async function documents(c, division, projects) {
  let rows;
  try {
    rows = await c.sql`
      SELECT project_id, filename, content_type,
             size_bytes::float          AS size_bytes,
             uploaded_by,
             uploaded_at::text          AS uploaded_at
        FROM project_documents
       WHERE company_code = ${c.companyCode}
         AND division     = ${division}
         AND deleted_at IS NULL
       ORDER BY uploaded_at DESC
       LIMIT 500
    `;
  } catch (err) {
    console.error('[mathis] documents read failed:', err.message);
    return null;
  }

  const list = Array.isArray(rows) ? rows : [];
  const names = new Map(projects.map(p => [String(p.id || ''), report.projName(p)]));

  const byJob = new Map();
  let bytes = 0;
  for (const d of list) {
    const pid = String(d.project_id || '');
    // A null project_id is the division's General / Non-Job area, which is
    // where paperwork belonging to no job files. Naming it beats a blank.
    const job = pid ? (names.get(pid) || null) : 'General (no job)';
    const label = job || 'a job outside this list';
    byJob.set(label, (byJob.get(label) || 0) + 1);
    bytes += Number(d.size_bytes) || 0;
  }

  const withDocs = new Set(list.map(d => String(d.project_id || '')).filter(Boolean));

  return {
    count: list.length,
    truncated: list.length >= 500,
    totalMB: round2(bytes / 1048576),
    byJob: capList([...byJob.entries()].map(([job, count]) => ({ job, count }))
      .sort((a, b) => b.count - a.count)),
    recent: capList(list.slice(0, LIST_CAP).map(d => ({
      filename:   safeText(d.filename, 200),
      job:        d.project_id ? (names.get(String(d.project_id)) || null) : 'General (no job)',
      uploadedBy: safeText(d.uploaded_by, 60),
      uploadedAt: safeText(d.uploaded_at, 10),
      sizeMB:     round2((Number(d.size_bytes) || 0) / 1048576),
      kind:       safeText(d.content_type, 60),
    }))),
    // Which of the jobs in this digest have no paperwork at all. Answerable
    // precisely because the window is stated: it is these jobs, not every job.
    jobsWithNoDocuments: capList(projects
      .filter(p => !withDocs.has(String(p.id || '')))
      .map(p => report.projName(p))),
  };
}

/**
 * Rubber inventory, turf's own. This is what somebody asked about first and
 * got projected profit for instead, because the digest held nothing else.
 * buildRubberInventory is the executive report's reader, not a second one.
 */
async function rubberInventory(c) {
  try {
    const inv = await report.buildRubberInventory(c.sql, c.companyCode);
    return capList((Array.isArray(inv) ? inv : []).map(r => ({
      rubberType: safeText(r.rubber_type || r.type, 60),
      produced:   round2(r.produced),
      used:       round2(r.used),
      inStock:    round2(r.in_stock),
      poundsProduced: round2(r.lbs_total),
    })));
  } catch (err) {
    console.error('[mathis] rubber inventory failed:', err.message);
    return null;
  }
}

async function jobDigest(c, division, opts = {}) {
  const div = jobFin.jobDivision(division);
  if (!div) return null;

  const want  = Number(opts.limit);
  const limit = Number.isFinite(want) && want > 0 ? Math.min(Math.floor(want), MAX_JOB_ROWS) : DEFAULT_JOB_ROWS;

  const idx = await readBlob(c, report.PROJECT_KEYS[division].index);
  if (idx.status === 'denied') return { division, kind: 'denied' };
  const totalProjects = countIds(idx.value);

  // Read before the empty-projects branch: rubber stock, purchase orders and
  // the cost-code catalogue all exist whether or not a single job is open, and
  // returning early skipped them entirely.
  const inventory = division === 'turf' ? await rubberInventory(c) : null;

  const projects = (await div.read(c.sql, c.companyCode, { limit })).filter(Boolean);
  // Named so a PO can say which job it is against instead of an opaque id.
  const projectNames = new Map(projects.map(p => [String(p.id || ''), report.projName(p)]));

  const [pos, codes, equip, docs, crew] = await Promise.all([
    purchaseOrders(c, division, projectNames),
    costCodes(c, division),
    equipment(c, division, projects),
    documents(c, division, projects),
    employees(c, division, projects),
  ]);

  const extraCovers = [];
  if (inventory) extraCovers.push('rubber inventory by type: bags produced, used and in stock');
  if (pos)   extraCovers.push('purchase orders: value, supplier, status and which job each is against');
  if (codes) extraCovers.push('the cost-code catalogue: which codes this division uses, their quantities and unit costs');
  if (equip) extraCovers.push('equipment: the roster and its unit costs, what is assigned to each job, and the hours each machine ran');
  if (docs)  extraCovers.push('the document vault: how many files each job has, who uploaded them and when — file names only, never their contents');
  if (crew)  extraCovers.push(crew.payVisible
    ? 'employees: the roster with job classes and pay rates, who is assigned to each job, and the hours each person worked with the labor cost of those hours'
    : 'employees: the roster by NAME and who is assigned to each job — pay rates and worked hours are NOT here, because this user\'s access level does not include them');
  const extras = {
    ...(inventory ? { rubberInventory: inventory } : {}),
    ...(pos   ? { purchaseOrders: pos } : {}),
    ...(codes ? { costCodes: codes } : {}),
    ...(equip ? { equipment: equip } : {}),
    ...(docs  ? { documents: docs } : {}),
    ...(crew  ? { employees: crew } : {}),
  };
  if (!projects.length) {
    return {
      division, divisionName: div.name, kind: 'jobs',
      covers: COVERS.jobs.concat(extraCovers),
      ...extras,
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
    covers: COVERS.jobs.concat(extraCovers),
    ...extras,
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
    covers: COVERS.quarry,
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
    covers: COVERS.dust,
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
    covers: COVERS.trucking,
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
    covers: COVERS.intercompany,
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
    return { division: 'payroll', kind: 'payroll', covers: COVERS.payroll, error: true, limits: PAYROLL_LIMITS };
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
    covers: COVERS.payroll,
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

// ── Scheduler ──────────────────────────────────────────────────────────────

const SCHEDULER_LIMITS = [
  'A sub-code\'s status comes from its pace against its remaining working days. "no-data" means there is no bid quantity to measure against — it is not on track, it is unmeasured. Say so rather than counting it as either.',
  'A conflict is one person or machine booked on two different jobs on the SAME DAY. It is decided per day, not per hour, so a genuine morning-on-one-job, afternoon-on-another split appears here as a conflict. Say what it means before calling it a problem.',
  'Only the divisions that run jobs feed this board. Trucking dispatch is a separate board with its own drivers and trucks, and none of it is here.',
  'addlLaborersNeeded is arithmetic — the extra bodies the pace implies — not a decision about who is available. Never present it as a staffing instruction.',
  'These figures are the plan as it stands today. There is no history here, so nothing about how the schedule has moved over time can be answered.',
];

const SCHED_BAD = ['behind', 'at-risk'];

async function schedulerDigest(c, opts = {}) {
  const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);

  let board;
  try {
    // The Scheduler page's own builder, not a second reading of the same
    // blobs — the assistant has to say what that page says.
    board = await schedBoard.buildBoard(c.sql, c.companyCode, today);
  } catch (err) {
    console.error('[mathis] scheduler board failed:', err.message);
    return { division: 'scheduler', kind: 'scheduler', covers: COVERS.scheduler, error: true, limits: SCHEDULER_LIMITS };
  }

  const counts = { behind: 0, atRisk: 0, onTrack: 0, complete: 0, noData: 0 };
  let addlLaborersNeeded = 0, unstaffed = 0;
  const problems = [];

  for (const j of board.jobs || []) {
    for (const sc of j.subCodes || []) {
      if (sc.status === 'behind')        counts.behind++;
      else if (sc.status === 'at-risk')  counts.atRisk++;
      else if (sc.status === 'on-track') counts.onTrack++;
      else if (sc.status === 'complete') counts.complete++;
      else                               counts.noData++;

      if (!SCHED_BAD.includes(sc.status)) continue;
      addlLaborersNeeded += Number(sc.addlLaborersNeeded) || 0;
      const crewSize = (sc.crew || []).length;
      if (!crewSize) unstaffed++;
      problems.push({
        job:        safeText(j.name),
        jobNumber:  safeText(j.jobNumber, 40),
        division:   j.division,
        costCode:   safeText(sc.costCode, 20),
        subCode:    safeText(sc.subCode, 20),
        status:     sc.status,
        pctComplete: round2(sc.pctComplete),
        daysLeft:   sc.effectiveDaysLeft === null || sc.effectiveDaysLeft === undefined ? null : Number(sc.effectiveDaysLeft),
        addlLaborersNeeded: Number(sc.addlLaborersNeeded) || 0,
        crewSize,
        deadline:   j.deadline || null,
      });
    }
  }
  // Worst first: behind before at-risk, then whatever needs the most bodies.
  problems.sort((a, b) =>
    (a.status === b.status ? 0 : a.status === 'behind' ? -1 : 1)
    || b.addlLaborersNeeded - a.addlLaborersNeeded);

  // Double-bookings, by the rule the Scheduler page itself uses
  // (scheduler.html conflictResourcesOn): one resource, two distinct jobs, one
  // day. Read from the dispatcher's own saved board rather than from the
  // planner-derived assignments, because what was actually placed is what a
  // dispatcher is asking about.
  const saved = await blobValue(c, 'fct_scheduler_assignments');
  const byDate = (saved && saved.assignments && typeof saved.assignments === 'object') ? saved.assignments : {};
  const conflicts = [];
  for (const date of Object.keys(byDate).sort()) {
    if (date < today) continue;                       // behind us is not a plan
    const byResource = new Map();
    for (const a of (Array.isArray(byDate[date]) ? byDate[date] : [])) {
      if (!a || !a.resource) continue;
      const key = String(a.resource);
      if (!byResource.has(key)) byResource.set(key, new Set());
      byResource.get(key).add(`${a.division}::${a.jobId}`);
    }
    for (const [resource, jobsOn] of byResource) {
      if (jobsOn.size > 1) {
        conflicts.push({ date, resource: safeText(resource, 60), jobs: jobsOn.size });
      }
    }
  }

  const off = Object.keys((board.timeOff && typeof board.timeOff === 'object') ? board.timeOff : {});

  return {
    division: 'scheduler',
    divisionName: 'Scheduler',
    kind: 'scheduler',
    covers: COVERS.scheduler,
    today: board.today,
    sourceDivisions: board.sourceDivisions || [],
    activeJobs: (board.jobs || []).length,
    subCodes: counts,
    addlLaborersNeeded,
    unstaffedAtRisk: unstaffed,
    crewSize: (board.employees || []).length,
    equipmentCount: (board.equipment || []).length,
    problems: capList(problems),
    conflicts: capList(conflicts),
    timeOff: capList(off.map(n => ({ name: safeText(n, 60) }))),
    limits: SCHEDULER_LIMITS,
  };
}

// ── Fuel administration ────────────────────────────────────────────────────

const FUEL_ADMIN_LIMITS = [
  'Miles per gallon here is total mileage over total gallons across the fill-ups in the window. It is a fleet average, not a per-truck reading unless the figure is under a truck number, and a fill-up with no mileage recorded contributes gallons but no miles — which drags the average down without being a truck that drank more.',
  'Approval and balancing are two separate axes and must not be merged. A fill-up is approved or not (the daily review), and separately balanced or not (the monthly reconciliation against the fuel account). "Approved but not yet balanced" is where most of a month sits and is not a problem.',
  'Statement variance is what a reconciliation recorded at the time. It is not recomputed here, so a period nobody reconciled has no variance rather than a variance of zero.',
];

async function fuelAdminDigest(c, opts = {}) {
  const days = Number.isFinite(Number(opts.days)) ? Math.min(Math.max(7, Number(opts.days)), 365) : 90;
  let rows = [], variance = [];
  try {
    [rows, variance] = await Promise.all([
      c.sql`
        SELECT status, balance_status, truck_number,
               COALESCE(gallons, 0)::float AS gallons,
               COALESCE(mileage, 0)::float AS mileage,
               work_date::text AS work_date
          FROM fuel_submissions
         WHERE company_code = ${c.companyCode}
           AND work_date >= CURRENT_DATE - (${days} || ' days')::interval
      `,
      c.sql`
        SELECT period_month, account,
               ours_total::float AS ours_total,
               statement_total::float AS statement_total,
               difference::float AS difference,
               variance_count, not_in_ours_count, not_on_statement_count
          FROM fuel_statement_matches
         WHERE company_code = ${c.companyCode}
         ORDER BY period_end DESC
         LIMIT 12
      `,
    ]);
  } catch (err) {
    console.error('[mathis] fuel admin digest failed:', err.message);
    return { division: 'fuel_admin', kind: 'fuel_admin', covers: COVERS.fuel_admin, error: true, limits: FUEL_ADMIN_LIMITS };
  }

  const byStatus = {}, byBalance = {};
  const perTruck = new Map();
  let gallons = 0, mileage = 0, noMileage = 0;
  for (const r of rows) {
    byStatus[r.status || 'draft'] = (byStatus[r.status || 'draft'] || 0) + 1;
    byBalance[r.balance_status || 'pending'] = (byBalance[r.balance_status || 'pending'] || 0) + 1;
    const g = Number(r.gallons) || 0, m = Number(r.mileage) || 0;
    gallons += g; mileage += m;
    if (g > 0 && m <= 0) noMileage++;
    const t = r.truck_number == null ? null : String(r.truck_number);
    if (!t) continue;
    if (!perTruck.has(t)) perTruck.set(t, { truck: t, gallons: 0, mileage: 0, fillUps: 0 });
    const e = perTruck.get(t);
    e.gallons += g; e.mileage += m; e.fillUps += 1;
  }

  const trucks = [...perTruck.values()]
    .map(e => ({
      truck: safeText(e.truck, 20),
      fillUps: e.fillUps,
      gallons: round2(e.gallons),
      mileage: round2(e.mileage),
      // Null, not zero: a truck whose fill-ups carry no odometer has no
      // economy to report, and 0 mpg reads as a truck in trouble.
      mpg: (e.gallons > 0 && e.mileage > 0) ? round2(e.mileage / e.gallons) : null,
    }))
    .sort((a, b) => (a.mpg === null ? 1 : b.mpg === null ? -1 : a.mpg - b.mpg));

  return {
    division: 'fuel_admin',
    divisionName: 'Fuel Administration',
    kind: 'fuel_admin',
    covers: COVERS.fuel_admin,
    windowDays: days,
    fillUps: rows.length,
    gallons: round2(gallons),
    mileage: round2(mileage),
    fleetMpg: (gallons > 0 && mileage > 0) ? round2(mileage / gallons) : null,
    fillUpsWithoutMileage: noMileage,
    byStatus,
    byBalanceStatus: byBalance,
    unbalanced: (byBalance.pending || 0) + (byBalance.issue || 0),
    trucks: capList(trucks),
    statementPeriods: capList(variance.map(v => ({
      period:   safeText(v.period_month, 20),
      account:  safeText(v.account, 40),
      ours:     money(v.ours_total),
      statement: money(v.statement_total),
      difference: money(v.difference),
      variances: v.variance_count,
      missingFromOurs: v.not_in_ours_count,
      missingFromStatement: v.not_on_statement_count,
    }))),
    limits: FUEL_ADMIN_LIMITS,
  };
}

// ── Executive rollup ───────────────────────────────────────────────────────

const EXEC_LIMITS = [
  'This rollup covers ONLY the divisions this user can reach. It is not every division the company runs, so never describe it as a company-wide total — say which divisions it covers.',
  'These are the same figures each division page shows. The Executive Report applies a job-number floor, a per-project exclusion flag and a portfolio cap that this does NOT, so its totals are legitimately different. If the user cites a figure from that report, both can be right — say which one you are quoting.',
  'Each division means something different by its headline figure: job divisions report profit, quarry a per-ton contribution, dust and trucking revenue only, payroll hours. They cannot be added together, and a total across them would be meaningless.',
  'Every division\'s own limits still apply inside its section. Trucking in particular has no cost and therefore no profit at all.',
];

// What is worth carrying up from each division. Deliberately small: an
// executive summary that reproduced every digest would just be every digest.
function execSlice(d) {
  if (!d || d.error) return { available: false };
  if (d.kind === 'jobs') {
    const s = d.summary || {};
    return {
      measure: 'projected profit', activeProjects: s.activeProjects,
      contract: money(s.contract), actualCost: money(s.actual),
      projectedProfit: s.projProfit === null ? null : money(s.projProfit),
      actualProfit: s.actProfit === null ? null : money(s.actProfit),
      completedJobs: s.completedJobs,
    };
  }
  if (d.kind === 'quarry') return {
    measure: 'contribution per ton',
    sales: d.total && d.total.totalSales, tonsSold: d.total && d.total.tonsSold,
    contributionPerTon: d.breakEven && d.breakEven.contributionPerTon,
    breakEvenStatus: d.breakEven && d.breakEven.status && d.breakEven.status.state,
  };
  if (d.kind === 'dust') return {
    measure: 'revenue, plus a product margin',
    revenue: d.revenueYtd, gallons: d.gallonsYtd,
    marginPct: d.productMargin && d.productMargin.marginPct,
  };
  if (d.kind === 'trucking') return {
    measure: 'revenue only — no cost is captured, so no profit exists',
    revenue: d.revenue, hours: d.hours, cost: null, profit: null,
  };
  if (d.kind === 'intercompany') return {
    measure: 'billed between divisions',
    billed: d.billed && d.billed.total, notInvoiced: d.notInvoiced && d.notInvoiced.amount,
  };
  if (d.kind === 'payroll') return {
    measure: 'hours only — no rate exists in this data',
    totalHours: d.totals && d.totals.totalHours, employees: d.totals && d.totals.employees,
  };
  if (d.kind === 'scheduler') return {
    measure: 'schedule health',
    behind: d.subCodes && d.subCodes.behind, atRisk: d.subCodes && d.subCodes.atRisk,
    conflicts: d.conflicts && d.conflicts.total,
  };
  return { available: false };
}

const EXEC_DIVISIONS = ['turf', 'paving', 'kiewit', 'quarry', 'dust', 'trucking',
                        'intercompany', 'payroll', 'scheduler'];

async function executiveDigest(c, opts = {}) {
  // Built from the divisions this caller already has, so the rollup widens
  // nothing: holding 'executive' is not a key to divisions they were not
  // granted, and an executive who holds three divisions gets three.
  const scope = ctx.divisionScope(c.authz);
  const covered = EXEC_DIVISIONS.filter(d => scope.includes(d));

  const parts = await Promise.all(covered.map(async d => {
    try { return { division: d, slice: execSlice(await buildDigest(c, d, { limit: 8 })) }; }
    catch (err) {
      console.error(`[mathis] exec rollup ${d} failed:`, err.message);
      return { division: d, slice: { available: false } };
    }
  }));

  return {
    division: 'executive',
    divisionName: 'Executive',
    kind: 'executive',
    covers: COVERS.executive,
    coversDivisions: covered,
    // Named so an answer cannot quietly present a partial view as the company.
    notCovered: EXEC_DIVISIONS.filter(d => !covered.includes(d)),
    divisions: parts,
    limits: EXEC_LIMITS,
  };
}

// ── The field queues: the asker's own records ──────────────────────────────

const OWN_LIMITS = [
  'These are ONLY the asking user\'s own records. Nobody else\'s are available through this or any other tool, and none should be described even in aggregate.',
];

async function fuelOwnDigest(c) {
  let rows = [];
  try {
    rows = await c.sql`
      SELECT work_date::text AS work_date, status, balance_status, truck_number,
             COALESCE(gallons, 0)::float AS gallons,
             COALESCE(mileage, 0)::float AS mileage,
             fueling_site, state
        FROM fuel_submissions
       WHERE company_code = ${c.companyCode} AND user_id = ${c.authz.userId}
         AND work_date >= CURRENT_DATE - INTERVAL '90 days'
       ORDER BY work_date DESC
       LIMIT 100
    `;
  } catch (err) {
    console.error('[mathis] own fuel digest failed:', err.message);
    return { division: 'fuel', kind: 'own_fuel', covers: COVERS.own_fuel, error: true, limits: OWN_LIMITS };
  }
  const byStatus = {};
  let gallons = 0;
  for (const r of rows) {
    byStatus[r.status || 'draft'] = (byStatus[r.status || 'draft'] || 0) + 1;
    gallons += Number(r.gallons) || 0;
  }
  return {
    division: 'fuel', kind: 'own_fuel', window: 'the last 90 days',
    covers: COVERS.own_fuel,
    fillUps: rows.length, gallons: round2(gallons), byStatus,
    rows: capList(rows.map(r => ({
      workDate: r.work_date, status: safeText(r.status, 20),
      balanceStatus: safeText(r.balance_status, 20),
      truck: r.truck_number == null ? null : String(r.truck_number),
      gallons: round2(r.gallons), mileage: round2(r.mileage),
      site: safeText(r.fueling_site, 60), state: safeText(r.state, 8),
    }))),
    limits: OWN_LIMITS.concat([
      'A draft is a fill-up the user has not sent yet. Saying how many are still in draft is useful; describing one as missing or late is not — it may simply be today\'s.',
    ]),
  };
}

async function driverOwnDigest(c) {
  const today = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  let byDate = {};
  try {
    // resolveDriver maps this login to the name on the board. Using the
    // username directly would either match nothing or, worse, match somebody
    // else's row — it is the check that keeps one driver out of another's work.
    const driver = await driverSched.resolveDriver(c.sql, c.companyCode, c.authz.username);
    if (!driver) {
      return { division: 'driver', kind: 'own_driver', covers: COVERS.own_driver, unlinked: true, assignments: capList([]),
        limits: OWN_LIMITS.concat(['This login is not linked to a driver on the board, so there are no hauls to show. Say that rather than saying they have none scheduled.']) };
    }
    byDate = await driverSched.assignmentsFor(c.sql, c.companyCode, driver, today, to);
  } catch (err) {
    console.error('[mathis] own driver digest failed:', err.message);
    return { division: 'driver', kind: 'own_driver', covers: COVERS.own_driver, error: true, limits: OWN_LIMITS };
  }

  const out = [];
  for (const date of Object.keys(byDate).sort()) {
    for (const a of byDate[date]) {
      out.push({
        date,
        board:    safeText(a.board, 20),
        unit:     safeText(a.unit || a.truck, 40),
        job:      safeText(a.job || a.jobName),
        customer: safeText(a.customer, 60),
        from:     safeText(a.from || a.origin, 60),
        to:       safeText(a.to || a.destination, 60),
        start:    safeText(a.start_time || a.start, 10),
      });
    }
  }
  return {
    division: 'driver', kind: 'own_driver',
    covers: COVERS.own_driver,
    window: 'today through the next 14 days',
    assignments: capList(out),
    limits: OWN_LIMITS.concat([
      'These are the hauls the dispatcher has put on the board for this driver. A day with nothing on it means nothing is assigned yet, not that the driver is off.',
    ]),
  };
}

async function quarrySalesOwnDigest(c) {
  let rows = [];
  try {
    rows = await c.sql`
      SELECT work_date::text AS work_date, status, location_name, customer_name, product_name,
             COALESCE(tons, 0)::float AS tons,
             COALESCE(amount_charged, 0)::float AS amount_charged,
             payment
        FROM quarry_sales_submissions
       WHERE company_code = ${c.companyCode} AND user_id = ${c.authz.userId}
         AND work_date >= CURRENT_DATE - INTERVAL '45 days'
       ORDER BY work_date DESC
       LIMIT 100
    `;
  } catch (err) {
    console.error('[mathis] own quarry sales digest failed:', err.message);
    return { division: 'quarry_sales', kind: 'own_quarry_sales', covers: COVERS.own_quarry_sales, error: true, limits: OWN_LIMITS };
  }
  const byStatus = {};
  let tons = 0, charged = 0;
  for (const r of rows) {
    byStatus[r.status || 'draft'] = (byStatus[r.status || 'draft'] || 0) + 1;
    tons += Number(r.tons) || 0;
    charged += Number(r.amount_charged) || 0;
  }
  return {
    division: 'quarry_sales', kind: 'own_quarry_sales', window: 'the last 45 days',
    covers: COVERS.own_quarry_sales,
    loads: rows.length, tons: round2(tons), charged: money(charged), byStatus,
    rows: capList(rows.map(r => ({
      workDate: r.work_date, status: safeText(r.status, 20),
      pit: safeText(r.location_name, 60), customer: safeText(r.customer_name, 60),
      product: safeText(r.product_name, 60),
      tons: round2(r.tons), charged: money(r.amount_charged),
      payment: safeText(r.payment, 20),
    }))),
    limits: OWN_LIMITS.concat([
      'Amount charged is what was recorded at the scale. Sales tax and net-of-tax figures are worked out elsewhere and are not here.',
    ]),
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
    return { division: null, kind: 'personal', covers: COVERS.personal, rows: [], byStatus: {}, error: true, limits: PERSONAL_LIMITS };
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
    covers: COVERS.personal,
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
  executive:    executiveDigest,
  fuel_admin:   fuelAdminDigest,
  scheduler:    schedulerDigest,
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
  if (division === 'timesheet')    return await personalDigest(c);
  if (division === 'fuel')         return await fuelOwnDigest(c);
  if (division === 'driver')       return await driverOwnDigest(c);
  if (division === 'quarry_sales') return await quarrySalesOwnDigest(c);
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
  COVERS,
  DEFAULT_JOB_ROWS,
  MAX_JOB_ROWS,
  LIST_CAP,
  QUARRY_LIMITS,
  SCHEDULER_LIMITS,
  FUEL_ADMIN_LIMITS,
  EXEC_LIMITS,
  OWN_LIMITS,
  EXEC_DIVISIONS,
  DUST_LIMITS,
  TRUCKING_LIMITS,
  IC_LIMITS,
  PAYROLL_LIMITS,
  capList,
  buildDigest,
  jobDigest,
  personalDigest,
  rubberInventory,
  purchaseOrders,
  costCodes,
  equipment,
  documents,
  employees,
  jobHistory,
  HISTORY_LIMITS,
  DEFAULT_HISTORY_DAYS,
  MAX_HISTORY_DAYS,
  readScopedBlob,
  quarryDigest,
  schedulerDigest,
  executiveDigest,
  fuelAdminDigest,
  fuelOwnDigest,
  driverOwnDigest,
  quarrySalesOwnDigest,
  dustDigest,
  truckingDigest,
  icDigest,
  payrollDigest,
};
