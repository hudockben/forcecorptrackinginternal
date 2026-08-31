'use strict';
/* Mathis — the guard and digest layer.
 *
 * Every read the assistant makes goes through this file. That is the whole
 * point of it: the model never sees a row this module did not fetch and
 * authorise, and it never writes the query that fetched one.
 *
 * Three rules hold everything else up.
 *
 *   1. The model authors no SQL. app_data has no company_code column —
 *      tenancy is the "CODE:" string prefix built in application code — and
 *      several tables (cost_items, equipment_list) carry company_code only as
 *      a nullable column added later, while dust_company_locations has none at
 *      all. There is no row-level security anywhere, and users.password_hash
 *      sits in the same database. One omitted WHERE is a cross-tenant breach,
 *      so the model is given answers, never a connection.
 *
 *   2. A division is a selector, never an authoriser. What the browser sends
 *      is a request to look at a division, checked against roles re-read from
 *      the database on this turn. requireDivision() is deliberately not used:
 *      its silent default to 'turf' is right for a blob endpoint and wrong
 *      here, where an unrecognised division must be refused rather than
 *      quietly answered about somewhere else.
 *
 *   3. A denied read and an empty read never look alike. readBlob returns a
 *      status, not null. api/executive/report.js already carries a comment
 *      about what happens when they blur: a book read as empty "silently
 *      subtracts its revenue from the division, and the smaller figure looks
 *      exactly like a real one".
 */

const { ALL_DIVISIONS, hasDivisionAccess, normalizeDivision, divisionForKey } = require('./auth');
const report = require('../executive/report');
const jobFin = require('./job-financials');

// Divisions with no data of their own — a submit side whose review side is
// another division's tab. A user holding only these is a field employee, and
// Mathis answers about their own rows rather than about a division.
const FIELD_ONLY = new Set(['timesheet', 'fuel', 'driver', 'quarry_sales']);

// How many projects a digest carries. Reading every blob a company has ever
// had to answer a five-row question is what the limit on readProjectBlobs
// exists to avoid; this is the ceiling when the question does not say.
const DEFAULT_JOB_ROWS = 12;
const MAX_JOB_ROWS     = 40;

// How much of any string a colleague typed reaches the model.
const TEXT_CAP = 120;

/**
 * Anything a user can type is data, never instruction. Project names, job
 * labels and statuses are free text writable by any colleague — and
 * api/data/[key].js applies no level gating at all, so a level1 viewer can
 * write them. Control characters go (they are how a payload fakes a message
 * boundary), and length is capped so a single field cannot crowd out the
 * figures. This is containment, not a defence: what actually stops an injected
 * project name changing an answer is that every number the user sees is
 * rendered from these rows rather than from the model's prose.
 */
function safeText(v, cap = TEXT_CAP) {
  const s = String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
}

const money = v => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

/**
 * Re-read this user's access from the database, every turn.
 *
 * Tokens last 30 days and carry no revocation, so a role the JWT claims may be
 * a month stale. Reading the row back is what makes "access removed this
 * morning" mean anything before tomorrow.
 *
 * The legacy path matters as much as the explicit one: when division_roles is
 * NULL, hasDivisionAccess falls through to payload.allowedDivisions, which on
 * an unrefreshed token is exactly the stale claim we are trying to replace. So
 * users.divisions and companies.allowed_divisions are refreshed too, and
 * restricted divisions are stripped from those paths the same way
 * api/auth/verify.js strips them.
 *
 * Returns null when the user cannot be read — a missing row, a dropped
 * connection, a deleted account. The caller must treat null as "no access",
 * never as "carry on with the token": failing open here would hand a deleted
 * user their company's financials.
 */
const RESTRICTED_DIVISIONS = new Set(['timesheet', 'payroll', 'fuel', 'fuel_admin', 'driver', 'quarry_sales']);

async function refreshAuthz(sql, payload) {
  if (!payload || !payload.userId || !payload.companyCode) return null;
  let rows;
  try {
    rows = await sql`
      SELECT u.division_roles, u.divisions, u.role, u.is_platform_admin,
             u.company_code, c.allowed_divisions
      FROM   users u
      JOIN   companies c ON c.code = u.company_code
      WHERE  u.id = ${payload.userId}
      LIMIT  1
    `;
  } catch (err) {
    console.error('[mathis] role refresh failed:', err.message);
    return null;
  }
  if (!rows.length) return null;
  const u = rows[0];

  // login.js uppercases the company code into the JWT while its own lookup is
  // LOWER(...), so the two spellings must be compared case-insensitively or
  // every request from a lowercase-coded company is refused.
  const dbCode = String(u.company_code || '').toUpperCase();
  const tokCode = String(payload.companyCode || '').toUpperCase();
  if (!dbCode || dbCode !== tokCode) {
    console.error('[mathis] company mismatch between token and row');
    return null;
  }

  const isPlatformAdmin = Boolean(u.is_platform_admin);
  const divisionRoles   = (u.division_roles && typeof u.division_roles === 'object') ? u.division_roles : null;

  let allowedDivisions;
  if (isPlatformAdmin) {
    allowedDivisions = ALL_DIVISIONS.slice();
  } else if (divisionRoles) {
    allowedDivisions = Object.entries(divisionRoles).filter(([, v]) => v !== 'no_access').map(([k]) => k);
  } else if (Array.isArray(u.divisions) && u.divisions.length) {
    allowedDivisions = u.divisions.filter(d => !RESTRICTED_DIVISIONS.has(d));
  } else if (Array.isArray(u.allowed_divisions) && u.allowed_divisions.length) {
    allowedDivisions = u.allowed_divisions.filter(d => !RESTRICTED_DIVISIONS.has(d));
  } else {
    allowedDivisions = [];
  }

  return {
    userId:      payload.userId,
    username:    safeText(payload.username, 60),
    companyCode: dbCode,
    role:        u.role || 'level1',
    divisionRoles,
    allowedDivisions,
    isPlatformAdmin,
  };
}

/** Every division this user may look at, freshly computed. */
function divisionScope(authz) {
  if (!authz) return [];
  return ALL_DIVISIONS.filter(d => hasDivisionAccess(authz, d));
}

/**
 * Turn what the browser asked for into a division we are willing to answer
 * about. Validate the shape first (normalizeDivision), then authorise
 * (hasDivisionAccess) — both, in that order. A division outside the scope
 * returns null and the caller refuses; it never falls back to another one.
 */
function resolveDivision(requested, authz) {
  const division = normalizeDivision(requested);
  if (!division) return null;
  return hasDivisionAccess(authz, division) ? division : null;
}

/** True when the user holds nothing but field-side divisions. */
function isFieldOnly(scope) {
  return scope.length > 0 && scope.every(d => FIELD_ONLY.has(d));
}

/**
 * Read one company-scoped blob, with the division check derived from the KEY
 * rather than from anything the caller passed in — api/bid-items.js resolves
 * access off the resource for the same reason.
 *
 * Returns a status rather than a value. 'denied' and 'empty' are different
 * facts and a caller that cannot tell them apart will report a figure it was
 * refused as a figure that is zero.
 */
async function readBlob(ctx, key) {
  if (!key) return { status: 'empty', value: null };
  const division = divisionForKey(key) || 'turf';
  if (!hasDivisionAccess(ctx.authz, division)) return { status: 'denied', value: null, division };
  let rows;
  try {
    rows = await ctx.sql`SELECT value FROM app_data WHERE key = ${`${ctx.companyCode}:${key}`}`;
  } catch (err) {
    console.error(`[mathis] blob read failed for ${key}:`, err.message);
    return { status: 'error', value: null, division };
  }
  if (!rows.length || rows[0].value == null) return { status: 'empty', value: null, division };
  return { status: 'ok', value: rows[0].value, division };
}

const countIds = v => {
  if (Array.isArray(v)) return v.length;
  if (v && Array.isArray(v.ids)) return v.ids.length;
  return 0;
};

// The only fields of a financial row that reach the model. Everything absent
// is absent on purpose: a profit answer needs no notes, no descriptions, no
// material text. Deleting the free-text surface beats defending it.
function pickRow(r) {
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

// Stated on every job digest, because each one is a way an answer could be
// confidently wrong rather than merely incomplete.
const JOB_LIMITS = [
  'Profit means PROJECTED profit: contract minus projected FINAL cost. That is what every page in this application means by the word. Cost-to-date would flatter a half-spent job into looking twice as profitable as it will finish.',
  'Actual profit is contract minus money actually spent, and is only meaningful on a job that is complete.',
  'A job with no contract value on file has UNKNOWN profit, shown as null. It is not a profit of zero and it is not a loss. Say the contract is missing.',
  'There is no as-of history for contract values, so questions about a past period ("profit last quarter", "is margin improving") cannot be answered honestly from this data. Spend is dated, but applying today\'s contract to an older period would report a fiction. Say so rather than estimating.',
  'These figures may differ from the Executive report, which applies a job-number floor, a per-project exclusion flag and a portfolio cap that this data does not. If the user cites a different number from that page, both can be right.',
];

/**
 * The job-financials digest — turf, paving and kiewit.
 *
 * Reads at most `limit` projects in index order. The home pages keep that
 * index pinned-first then most-recently-added, so the head of it is the
 * defensible reading of "the last N jobs" — and the digest says so, along with
 * how many projects exist in total, because a summary built from 12 of 47 jobs
 * that does not admit it is a wrong answer rather than a partial one.
 */
async function jobDigest(ctx, division, opts = {}) {
  const div = jobFin.jobDivision(division);
  if (!div) return null;

  const want = Number(opts.limit);
  const limit = Number.isFinite(want) && want > 0 ? Math.min(Math.floor(want), MAX_JOB_ROWS) : DEFAULT_JOB_ROWS;

  // Count from the index rather than by reading every blob.
  const idx = await readBlob(ctx, report.PROJECT_KEYS[division].index);
  if (idx.status === 'denied') return { division, kind: 'denied' };
  const totalProjects = countIds(idx.value);

  const projects = (await div.read(ctx.sql, ctx.companyCode, { limit })).filter(Boolean);
  if (!projects.length) {
    return {
      division, divisionName: div.name, kind: 'jobs',
      totalProjects, includedProjects: 0, rows: [], summary: null,
      ordering: 'none — this division has no projects on file',
      limits: JOB_LIMITS,
    };
  }

  const fin  = await report.buildFinancials(ctx.sql, ctx.companyCode, division, projects, null);
  const rows = jobFin.rowsFor(div, projects, fin, false);

  return {
    division,
    divisionName: div.name,
    kind: 'jobs',
    totalProjects,
    includedProjects: rows.length,
    truncated: totalProjects > rows.length,
    ordering: 'Most recent first, as the division page orders its own project list (pinned jobs lead). There is no created-at date on a project, so this is the ordering "the last N jobs" refers to; say which ordering you used.',
    rows: rows.map(pickRow),
    summary: jobFin.summarise(rows),
    limits: JOB_LIMITS,
  };
}

const PERSONAL_LIMITS = [
  'These are only this user\'s own timesheet entries, for the last 45 days. No other employee\'s hours are available and none should be described.',
  'Hours are hours. This data carries no pay rate and no dollar figure of any kind, so no question about pay, wages or labour cost can be answered from it.',
];

/**
 * The personal digest — a field employee's own rows and nothing else.
 *
 * Scoped by user_id as well as company_code, so this is the one digest that
 * stays correct for someone who holds no division at all. notes is read by
 * nobody: it is free text that would reach the model for no benefit.
 */
async function personalDigest(ctx) {
  let rows = [];
  try {
    rows = await ctx.sql`
      SELECT work_date, status, entry_type, time_off_type, job_label,
             COALESCE(computed_hours, 0)::float AS hours,
             COALESCE(travel_hours, 0)::float   AS travel_hours
      FROM   timesheet_entries
      WHERE  company_code = ${ctx.companyCode}
        AND  user_id      = ${ctx.authz.userId}
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
    v.hours = Math.round(v.hours * 100) / 100;
    v.travelHours = Math.round(v.travelHours * 100) / 100;
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
      hours:     Math.round((Number(r.hours) || 0) * 100) / 100,
      travelHours: Math.round((Number(r.travel_hours) || 0) * 100) / 100,
    })),
    byStatus,
    limits: PERSONAL_LIMITS,
  };
}

// Divisions Mathis can answer about today, and what to say about the rest.
// Naming the gap is the point: "we do not capture what a haul costs" is a
// true answer, while quoting trucking revenue as if it were profit is not.
const NOT_YET = {
  quarry:       'The quarry\'s margin, cost per ton and break-even figures exist but are not wired into Mathis yet.',
  dust:         'Dust revenue is available but its margin is calculated only in the browser, so Mathis cannot answer margin questions for dust at all yet.',
  trucking:     'Trucking captures revenue but NO cost anywhere in the system, so trucking profit does not exist as a number. Never present trucking revenue as profit.',
  intercompany: 'Intercompany billing figures are not wired into Mathis yet.',
  executive:    'The cross-division executive rollup is not wired into Mathis yet.',
  scheduler:    'Scheduling and pacing are not wired into Mathis yet.',
  payroll:      'Payroll carries hours only — never dollars — and is not wired into Mathis yet.',
  fuel_admin:   'Fuel administration is not wired into Mathis yet.',
};

/**
 * Assemble the one digest this turn is allowed to see. Exactly one division,
 * resolved and authorised server-side. Cross-division comparison is not a
 * feature that was left out; the single-division digest is the property that
 * makes the whole thing defensible.
 */
async function buildDigest(ctx, division, opts = {}) {
  if (!division) return await personalDigest(ctx);
  if (jobFin.jobDivision(division)) return await jobDigest(ctx, division, opts);
  return {
    division,
    kind: 'unsupported',
    reason: NOT_YET[division] || 'This division is not wired into Mathis yet.',
    limits: ['Answer only that this division is not available yet, and say plainly what is missing. Do not substitute a figure from another division or from another metric.'],
  };
}

module.exports = {
  FIELD_ONLY,
  DEFAULT_JOB_ROWS,
  MAX_JOB_ROWS,
  TEXT_CAP,
  JOB_LIMITS,
  PERSONAL_LIMITS,
  NOT_YET,
  safeText,
  refreshAuthz,
  divisionScope,
  resolveDivision,
  isFieldOnly,
  readBlob,
  buildDigest,
  jobDigest,
  personalDigest,
};
