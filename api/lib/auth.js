'use strict';
const jwt = require('jsonwebtoken');

// Canonical division list. MUST match the divisions exposed in divisions.html
// and the values stored in users.division_roles.
// 'timesheet' (field-employee entry) and 'payroll' (admin review) are
// permission-only keys — they have no division-scoped data tables of their
// own. Field users typically have ONLY timesheet:level1 and nothing else.
// 'fuel' (field fuel submissions) and 'fuel_admin' (office review of them)
// are the same shape: a submit side and a review side of one queue.
const ALL_DIVISIONS = ['turf', 'dust', 'paving', 'kiewit', 'trucking', 'quarry', 'intercompany', 'executive', 'scheduler', 'timesheet', 'payroll', 'fuel', 'fuel_admin'];

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

module.exports = {
  ALL_DIVISIONS,
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
