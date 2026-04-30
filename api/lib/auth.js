'use strict';
const jwt = require('jsonwebtoken');

// Canonical division list. MUST match the divisions exposed in divisions.html
// and the values stored in users.division_roles.
const ALL_DIVISIONS = ['turf', 'dust', 'paving', 'trucking', 'intercompany'];

// Blob-key prefix → division mapping. Used by api/data/[key].js to verify
// the caller has access to a division before reading or writing its blob.
// Order matters: most-specific prefix wins.
const KEY_PREFIX_DIVISION = [
  ['fct_paving_',       'paving'],
  ['fct_trucking',      'trucking'],
  ['fct_truck_division','trucking'],
  ['fct_intercompany',  'intercompany'],
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

module.exports = {
  ALL_DIVISIONS,
  requireAuth,
  requireDivision,
  hasDivisionAccess,
  normalizeDivision,
  divisionForKey,
};
