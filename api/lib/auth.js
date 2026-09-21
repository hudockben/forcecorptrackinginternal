'use strict';
const jwt = require('jsonwebtoken');

// Canonical division list. MUST match the divisions exposed in divisions.html
// and the values stored in users.division_roles.
// 'timesheet' (field-employee entry) and 'payroll' (admin review) are
// permission-only keys — they have no division-scoped data tables of their
// own. Field users typically have ONLY timesheet:level1 and nothing else.
// 'fuel' (field fuel submissions) and 'fuel_admin' (office review of them)
// are the same shape: a submit side and a review side of one queue.
// 'driver' is the same again — the field side of trucking. A driver sees the
// hauls the Scheduler gave them and reports back against them; the review side
// is the trucking division's own Scheduler tab, so there is no second key.
// 'quarry_sales' is the field side of the quarry. The scale house submits one
// form per load and it posts straight into the quarry division's own Sales
// Tracking tab, so — like driver — there is no second key for the review side.
// 'purchase_orders' is central purchasing. It writes purchase orders into the
// job divisions rather than holding a job ledger of its own: a PO raised there
// against paving is stored in paving's own PO list, so it shows up in that
// division's Purchase Orders tab and costs its project exactly as one entered
// there would. Its own key holds only the general (non-job) orders.
const ALL_DIVISIONS = ['turf', 'dust', 'paving', 'kiewit', 'trucking', 'quarry', 'intercompany', 'executive', 'scheduler', 'timesheet', 'payroll', 'fuel', 'fuel_admin', 'driver', 'quarry_sales', 'purchase_orders'];

// The job divisions central purchasing raises orders against. A PO tied to one
// of these lives in THAT division's purchase-order list — there is no second
// copy to reconcile, which is what makes "shows up in the division's own tab"
// true by construction rather than by a sync job.
const PO_SOURCE_DIVISIONS = ['turf', 'paving', 'kiewit'];

// Where a general (non-job) purchase order is filed. Orders with no division
// belong to no job ledger, so they stay in purchasing's own list.
const PO_GENERAL_DIVISION = 'purchase_orders';

// Keys that are intentionally shared across every division within a company
// (any logged-in user may read/write them regardless of their division roles).
// Examples: presence/heartbeat is a company-wide "who's online" feed.
const SHARED_KEY_PREFIXES = [
  'fct_presence',
];

// Cross-division keys: blobs that aggregate data from multiple source
// divisions, so anyone with access to any of those source divisions (or to
// intercompany itself) must be able to read and write them. The canonical
// example is intercompany billing — a trucking/dust/paving user clicks
// "Send to Intercompany" on a row in their division and that has to write
// to the IC list. Without this carve-out the PUT 403s and the entry is
// silently dropped, leaving the IC sent badge in memory only.
const CROSS_DIVISION_KEYS = new Set([
  'fct_intercompany_billing_entries',
  'fct_intercompany_companies',
  // Entries an intercompany user deleted. The source divisions must READ this
  // to know not to recreate a removed row — without the carve-out their GET
  // 403s, the list reads as empty, and every deletion is silently undone on
  // the next sync, which is exactly the behaviour it exists to prevent.
  'fct_intercompany_removed_entries',
]);
const CROSS_DIVISION_CONTRIBUTORS = ['trucking', 'dust', 'paving', 'intercompany'];

function isCrossDivisionKey(key) {
  return Boolean(key) && CROSS_DIVISION_KEYS.has(key);
}

// Quarry blobs that an intercompany user may READ (GET only) even without a
// quarry role. The IC Quarry sub-tab auto-pulls both — daily and crushing
// labor hours roll into each location's intercompany total — so both must be
// readable, but neither is writable through this escape hatch.
const IC_QUARRY_READONLY_KEYS = new Set(['fct_quarry_daily', 'fct_quarry_crushing']);

/**
 * True when `key` is a quarry blob the caller may read solely by virtue of
 * intercompany access (GET only). Returns false for writes and for callers
 * without intercompany access — normal division checks still apply to those.
 */
function isIcQuarryReadOnlyGet(key, payload, method) {
  return method === 'GET'
    && IC_QUARRY_READONLY_KEYS.has(key)
    && hasDivisionAccess(payload, 'intercompany');
}

// Blob-key prefix → division mapping. Used by api/data/[key].js to verify
// the caller has access to a division before reading or writing its blob.
// Order matters: most-specific prefix wins.
const KEY_PREFIX_DIVISION = [
  ['fct_paving_',       'paving'],
  ['fct_kiewit_',       'kiewit'],
  ['fct_trucking',      'trucking'],
  ['fct_truck_division','trucking'],
  ['fct_quarry_',       'quarry'],
  ['fct_intercompany',  'intercompany'],
  ['fct_scheduler',     'scheduler'],
  ['dust_',             'dust'],
];

/**
 * Resolve the division a blob key belongs to. Returns null if the key is
 * shared (turf-default) — callers should treat null as "turf".
 */
function divisionForKey(key) {
  if (!key) return null;
  for (const [prefix, division] of KEY_PREFIX_DIVISION) {
    if (key.startsWith(prefix)) return division;
  }
  return null;
}

/**
 * True for keys that any authenticated user of the company may access,
 * regardless of their division roles (e.g. presence / heartbeat).
 */
function isSharedKey(key) {
  if (!key) return false;
  return SHARED_KEY_PREFIXES.some(p => key.startsWith(p));
}

/**
 * Validates the Bearer JWT and returns the decoded payload.
 * If invalid, sends 401 and returns null so the caller can `return`.
 */
function requireAuth(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Unauthorized — please log in' });
    return null;
  }
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'Unauthorized — please log in' });
    return null;
  }
}

/**
 * Normalize a division string. Returns null if not in ALL_DIVISIONS.
 */
function normalizeDivision(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return ALL_DIVISIONS.includes(v) ? v : null;
}

/**
 * Returns true if the JWT payload is allowed to operate on `division`.
 * Platform admins always pass. Otherwise we require divisionRoles[division]
 * to be a value other than 'no_access'. Legacy tokens without division_roles
 * fall back to allowedDivisions, and ultimately to turf-only access.
 */
function hasAnyDivisionAccess(payload, divisions) {
  if (!payload || !Array.isArray(divisions)) return false;
  return divisions.some(d => hasDivisionAccess(payload, d));
}

function hasDivisionAccess(payload, division) {
  if (!payload || !division) return false;
  if (payload.isPlatformAdmin) return true;

  const dr = payload.divisionRoles;
  if (dr && typeof dr === 'object') {
    const role = dr[division];
    return Boolean(role) && role !== 'no_access';
  }

  // Legacy token: trust allowedDivisions, else turf only
  if (Array.isArray(payload.allowedDivisions) && payload.allowedDivisions.length) {
    return payload.allowedDivisions.includes(division);
  }
  return division === 'turf';
}

/**
 * May this caller read and write division `division`'s PURCHASE ORDERS?
 *
 * True the ordinary way — they hold a role in that division — and also for a
 * central-purchasing user acting on one of the job divisions purchasing raises
 * orders against. That second arm is what lets purchase-orders.html file an
 * order into paving's list so it lands in paving's own tab.
 *
 * Deliberately narrow: it grants nothing but the purchase-order list and the
 * cost rows those orders create. A purchasing user still cannot read paving's
 * bids, its daily tracking, or any of its blobs — every other endpoint keeps
 * using requireDivision unchanged.
 */
function canAccessPODivision(payload, division) {
  if (!payload || !division) return false;
  if (hasDivisionAccess(payload, division)) return true;
  if (!hasDivisionAccess(payload, PO_GENERAL_DIVISION)) return false;
  return PO_SOURCE_DIVISIONS.includes(division) || division === PO_GENERAL_DIVISION;
}

/**
 * Every division whose purchase orders this caller may see, in display order:
 * the job divisions they can reach, then the general (non-job) list.
 */
function poDivisionsFor(payload) {
  const list = PO_SOURCE_DIVISIONS.filter(d => canAccessPODivision(payload, d));
  if (canAccessPODivision(payload, PO_GENERAL_DIVISION)) list.push(PO_GENERAL_DIVISION);
  return list;
}

/**
 * What a caller may DO with `division`'s purchase orders and their paperwork.
 *
 * canAccessPODivision answers whether they get in at all; this answers at what
 * level, and the two are not the same question. A purchasing clerk given
 * view-only rights must not be able to raise orders in paving just because
 * purchasing can reach paving.
 *
 * A real role in the division answers for itself. Otherwise the answer comes
 * from the caller's role in PURCHASING — never a hardcoded level, and never
 * payload.role, which is the caller's TURF role and would be the wrong
 * division's answer in both directions.
 *
 * The two are combined rather than one shadowing the other, so granting a
 * purchasing user read access to a division cannot take a capability away.
 * Adding paving:level1 to a purchasing level3 used to do exactly that: the
 * division role won, said view-only, and the receipts they could attach the
 * day before stopped uploading.
 */
function poCapabilities(payload, division) {
  const own = hasDivisionAccess(payload, division) ? capabilities(payload, division) : null;
  const viaPurchasing = canAccessPODivision(payload, division) && hasDivisionAccess(payload, PO_GENERAL_DIVISION)
    ? capabilities(payload, PO_GENERAL_DIVISION)
    : null;

  if (!own && !viaPurchasing) return { level: 'no_access', canUpload: false, canManage: false, canDelete: false };

  const canUpload = Boolean((own && own.canUpload) || (viaPurchasing && viaPurchasing.canUpload));
  const canManage = Boolean((own && own.canManage) || (viaPurchasing && viaPurchasing.canManage));
  const canDelete = Boolean(own && own.canDelete);

  return {
    // Derived from the booleans, never carried over from whichever role won.
    // Taking it from the purchasing side could answer 'admin' for a caller
    // whose canDelete was false — an object contradicting itself, and the first
    // consumer to do the natural thing and test `level === 'admin'` would have
    // handed a purchasing administrator a division's document vault.
    level:     canDelete ? 'admin' : canManage ? 'level3' : canUpload ? 'level2' : 'level1',
    canUpload,
    canManage,
    // Destroying a stored FILE stays with the division that owns it, and comes
    // from `own` alone — a purchasing administrator is an administrator of
    // purchasing, not of paving's document vault. Note this is a narrower thing
    // than canManage above, which does travel: purchasing owning the life of an
    // order it raised is the feature.
    canDelete,
  };
}

/**
 * Guard for the purchase-order endpoints. Same shape as requireDivision — it
 * answers { payload, division } or sends the response and returns null — but
 * resolves access through canAccessPODivision, and requires the division to be
 * named rather than defaulting to turf: a cross-division writer that guessed
 * would file the order against the wrong job.
 */
function requirePODivision(req, res) {
  const payload = requireAuth(req, res);
  if (!payload) return null;

  const raw = (req.query && req.query.division) || (req.body && req.body.division) || null;
  const division = normalizeDivision(raw);
  if (!division) {
    res.status(400).json({ error: 'division query param is required' });
    return null;
  }
  if (!canAccessPODivision(payload, division)) {
    res.status(403).json({ error: 'You do not have access to this division' });
    return null;
  }
  return { payload, division };
}

/**
 * One-stop guard for division-scoped endpoints.
 *
 * Steps:
 *  1. requireAuth — validates Bearer JWT.
 *  2. Resolve division from req.query.division or req.body.division.
 *     If `options.required` is true, missing/invalid division → 400.
 *     Otherwise we default to 'turf' (back-compat for tracker.html).
 *  3. Verify the caller's divisionRoles allow the requested division.
 *     If not → 403, no leak of which divisions exist.
 *
 * Returns { payload, division } on success, or null when a response has
 * already been sent and the caller should `return` immediately.
 */
function requireDivision(req, res, options = {}) {
  const payload = requireAuth(req, res);
  if (!payload) return null;

  const raw = (req.query && req.query.division) || (req.body && req.body.division) || null;
  let division = normalizeDivision(raw);

  if (!division) {
    if (options.required) {
      res.status(400).json({ error: 'division query param is required' });
      return null;
    }
    division = 'turf'; // legacy default — only reached when caller opted in
  }

  if (!hasDivisionAccess(payload, division)) {
    res.status(403).json({ error: 'You do not have access to this division' });
    return null;
  }

  return { payload, division };
}

/**
 * Capability level for a caller IN A GIVEN DIVISION.
 *
 * payload.role is the caller's TURF role — login.js sets it from
 * divisionRoles.turf (falling back to users.role) for tracker.html's benefit.
 * Reading it directly on any other division answers about the wrong one, so
 * divisionRoles[division] comes first and payload.role is only the fallback
 * for legacy tokens that carry no per-division map.
 */
function levelFor(payload, division) {
  if (!payload) return 'level1';
  if (payload.isPlatformAdmin) return 'admin';
  const dr = payload.divisionRoles;
  if (dr && typeof dr === 'object' && dr[division] && dr[division] !== 'no_access') {
    return dr[division];
  }
  return payload.role || 'level1';
}

/**
 * What a caller may do in a division. Mirrors the `perm` object the division
 * pages build:
 *   level1  view only
 *   level2  upload, and edit their own uploads
 *   level3  everything except destroying a file
 *   admin   destroy and restore
 */
function capabilities(payload, division) {
  const level = levelFor(payload, division);
  return {
    level,
    canUpload: ['admin', 'level3', 'level2'].includes(level),
    canManage: ['admin', 'level3'].includes(level),
    canDelete: level === 'admin',
  };
}

// ─────────────────────────────────────────────────
// PAYROLL — the one division whose grant is split in two
// ─────────────────────────────────────────────────
// Payroll does two different things, and until now one grant carried both:
//
//   CODING    — "what phase was this work?" A classification. The man who ran
//               the site knows it; a supervisor who was not there does not.
//   APPROVING — "these hours are correct, pay them." An authority act, and the
//               ONLY bridge out of timesheet_entries into job cost.
//
// A foreman running a site his supervisor cannot reach every day may do the
// first and must never do the second. payroll:'level2' is that grant.
//
// level2 is deliberately not a new value: DIV_ROLE_VALUES in
// api/company/users.js has always accepted it for every division, while
// Manage Users offers payroll only 'no_access' and 'level3' (payroll is left
// out of DIV_KEYS_FULL_SCALE in divisions.html). So no account anywhere
// carries payroll:'level2' today, and nobody's existing grant changes meaning
// on deploy — the discriminating value is simply unused until someone is
// deliberately made a coder.
const PAYROLL_CODER_LEVEL = 'level2';

/**
 * What a caller may do in PAYROLL, as two separate answers.
 *
 *   canCode    — may write cost codes onto a submitted entry (propose a split)
 *   canApprove — may approve, resplit, un-approve, edit hours, delete, and
 *                read the reports and the audit log. Everything that moves
 *                money or state.
 *   isCoder    — canCode without canApprove. The narrow grant.
 *
 * Fails OPEN to today's behaviour in every ambiguous case, on purpose:
 * only an EXPLICIT payroll grant of the coder level restricts anyone.
 * A legacy token carrying no division_roles resolves its level through
 * levelFor's fallback to the account-wide role, which says nothing about
 * payroll — reading that as "coder" would silently strip approve from
 * accounts that hold it today.
 */
function payrollAccess(payload) {
  if (!hasDivisionAccess(payload, 'payroll')) {
    return { canCode: false, canApprove: false, isCoder: false };
  }
  // A platform admin is never narrowed, whatever their division map says.
  if (payload.isPlatformAdmin) {
    return { canCode: true, canApprove: true, isCoder: false };
  }
  const dr = payload.divisionRoles;
  const isCoder = Boolean(dr) && typeof dr === 'object'
    && dr.payroll === PAYROLL_CODER_LEVEL;
  return { canCode: true, canApprove: !isCoder, isCoder };
}

module.exports = {
  ALL_DIVISIONS,
  PO_SOURCE_DIVISIONS,
  PO_GENERAL_DIVISION,
  PAYROLL_CODER_LEVEL,
  canAccessPODivision,
  payrollAccess,
  poCapabilities,
  poDivisionsFor,
  requirePODivision,
  levelFor,
  capabilities,
  CROSS_DIVISION_CONTRIBUTORS,
  IC_QUARRY_READONLY_KEYS,
  requireAuth,
  requireDivision,
  hasDivisionAccess,
  hasAnyDivisionAccess,
  normalizeDivision,
  divisionForKey,
  isSharedKey,
  isCrossDivisionKey,
  isIcQuarryReadOnlyGet,
};
