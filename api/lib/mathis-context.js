'use strict';
/* Mathis — the guard layer.
 *
 * Who the caller is, which division they may look at, and the one function
 * that reads a blob on their behalf. The digests themselves live in
 * ./mathis-digests.js, which reads exclusively through readBlob below.
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

// Deliberately the only require: this file decides who may read what, and
// depending on nothing that reads keeps ./mathis-digests.js free to require it
// without a cycle.
const { ALL_DIVISIONS, hasDivisionAccess, normalizeDivision, divisionForKey, levelFor, payrollAccess } = require('./auth');

// Divisions with no data of their own — a submit side whose review side is
// another division's tab. A user holding only these is a field employee, and
// Mathis answers about their own rows rather than about a division.
const FIELD_ONLY = new Set(['timesheet', 'fuel', 'driver', 'quarry_sales']);

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
 * This turn's access, from the payload requireAuth has just built.
 *
 * Tokens last 30 days and carry no revocation, so a role the JWT claims may be
 * a month stale. Mathis used to read the row back itself for that reason;
 * requireAuth now does it for every request, so the roles here are already
 * the account's rather than the token's — legacy path included — and an
 * account that no longer exists never got this far. A second read of the same
 * row bought nothing but a second way to fail: a blip between the two answered
 * 401, which reads as signed out.
 *
 * Identity comes from the token, access from the row, and the username is
 * made safe for a prompt. Null only for a payload missing who is asking, which
 * the caller treats as no access, never as "carry on".
 */
function authzFrom(payload) {
  if (!payload || !payload.userId || !payload.companyCode) return null;
  return {
    userId:           payload.userId,
    username:         safeText(payload.username, 60),
    companyCode:      String(payload.companyCode).toUpperCase(),
    role:             payload.role || 'level1',
    divisionRoles:    payload.divisionRoles || null,
    allowedDivisions: Array.isArray(payload.allowedDivisions) ? payload.allowedDivisions : [],
    isPlatformAdmin:  Boolean(payload.isPlatformAdmin),
  };
}

/**
 * May this caller ask Mathis about a division?
 *
 * hasDivisionAccess for every division but one. PAYROLL now has two grants and
 * hasDivisionAccess cannot tell them apart — payrollAccess in ./auth is the
 * only thing that can. A CODER (payroll:'level2') holds payroll access purely
 * so a foreman can type cost codes onto his own crew's day; the payroll digest
 * is the opposite of that scope, returning per-employee worked, travel,
 * overtime and paid-leave hours for every employee in the company, in every
 * division, for the pay period.
 *
 * It carries no rate and no dollar figure — see PAYROLL_LIMITS in
 * mathis-digests.js — but it is exactly the "other crews' time" the grant
 * split exists to deny, and the digest reaches the caller whatever the model
 * decides to say, because the rows are streamed alongside the prose.
 *
 * This is also why the check lives HERE rather than on the payroll builder:
 * divisionScope feeds the tool enum, resolveDivision feeds the per-call
 * re-authorisation, and both have to give the same answer.
 */
function mayAskAbout(authz, division) {
  if (!hasDivisionAccess(authz, division)) return false;
  if (division === 'payroll' && payrollAccess(authz).isCoder) return false;
  return true;
}

/** Every division this user may look at, freshly computed. */
function divisionScope(authz) {
  if (!authz) return [];
  return ALL_DIVISIONS.filter(d => mayAskAbout(authz, d));
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
  return mayAskAbout(authz, division) ? division : null;
}

/**
 * Whether this user may see what people are paid, and the hours behind it.
 *
 * Not a rule invented here. tracker.html shows employee rates in exactly one
 * place — the Manage Lists modal — and that modal hangs off the Admin
 * dropdown, which the page hides outright below level3. The Daily tab and
 * Labor Analytics, the only other views carrying per-person hours and labor
 * cost, are hidden for level1 and level2 by the same `visibleTabs` set.
 *
 * So a paving foreman cannot see what his crew earns on his own page, and an
 * assistant that answered it for him would be a permissions bypass wearing a
 * chat window — the single easiest way for this feature to do real damage.
 * The roster of NAMES and who is assigned where stays available to everyone
 * with the division, because the project card already shows both.
 */
function canSeePay(authz, division) {
  const level = levelFor(authz, division);
  return level === 'admin' || level === 'level3';
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

const JOB_LIMITS = [
  'Profit means PROJECTED profit: contract minus projected FINAL cost. That is what every page in this application means by the word. Cost-to-date would flatter a half-spent job into looking twice as profitable as it will finish.',
  'Actual profit is contract minus money actually spent, and is only meaningful on a job that is complete.',
  'A job with no contract value on file has UNKNOWN profit, shown as null. It is not a profit of zero and it is not a loss. Say the contract is missing.',
  'NEVER tell somebody a job they named does not exist unless `searchedEveryJob` is true in this digest. Without it you are looking at the most recent handful, and a job absent from those rows is almost certainly just outside that window — a real, open, pinned job. Look it up: call the figures tool again with `job` set to what they called it. "That is not a job" about a job on their screen is the worst answer this can give.',
  'These figures are TODAY only. This digest has no history in it, so nothing here answers "profit last quarter" or "is margin improving" — applying today\'s contract to an older period reports a fiction. Movement over time is a separate read: use get_job_history if it is offered, and if it is not, say the history does not exist rather than estimating.',
  'These figures may differ from the Executive report, which applies a job-number floor, a per-project exclusion flag and a portfolio cap that this data does not. If the user cites a different number from that page, both can be right.',
];

const PERSONAL_LIMITS = [
  'These are only this user\'s own timesheet entries, for the last 45 days. No other employee\'s hours are available and none should be described.',
  'Hours are hours. This data carries no pay rate and no dollar figure of any kind, so no question about pay, wages or labour cost can be answered from it.',
];

// Divisions Mathis can answer about today, and what to say about the rest.
// Naming the gap is the point: "we do not capture what a haul costs" is a
// true answer, while quoting trucking revenue as if it were profit is not.
// Every division now has a digest or a personal queue behind it. Kept, empty,
// because the next one added starts here — and because buildDigest still needs
// somewhere to look before falling back to a generic answer.
const NOT_YET = {};


module.exports = {
  FIELD_ONLY,
  TEXT_CAP,
  JOB_LIMITS,
  PERSONAL_LIMITS,
  NOT_YET,
  safeText,
  money,
  authzFrom,
  divisionScope,
  resolveDivision,
  canSeePay,
  levelFor,
  isFieldOnly,
  readBlob,
};
