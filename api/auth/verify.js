'use strict';

const jwt        = require('jsonwebtoken');
const { neon }   = require('@neondatabase/serverless');

const ALL_DIVISIONS = ['turf', 'dust', 'paving', 'kiewit', 'trucking', 'quarry', 'intercompany', 'executive', 'timesheet', 'payroll', 'fuel', 'fuel_admin', 'driver', 'quarry_sales'];
// timesheet/payroll/fuel/fuel_admin/driver/quarry_sales require an explicit
// positive grant in division_roles — they're never granted implicitly through
// user.divisions or company.allowed_divisions.
const RESTRICTED_DIVISIONS = new Set(['timesheet', 'payroll', 'fuel', 'fuel_admin', 'driver', 'quarry_sales']);

/**
 * Verify the bearer token AND return the user's current division roles
 * direct from the DB. The JWT payload is a snapshot from login time;
 * looking up fresh roles lets the frontend reflect permission changes
 * without forcing a sign-out / sign-in cycle.
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Defaults — used if the DB read fails so we still hand back a usable
  // payload to the caller.
  let divisionRoles    = payload.divisionRoles    || null;
  let allowedDivisions = payload.allowedDivisions || (payload.isPlatformAdmin ? ALL_DIVISIONS : ['turf']);
  let isPlatformAdmin  = Boolean(payload.isPlatformAdmin);

  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT u.division_roles, u.divisions, u.is_platform_admin,
             c.allowed_divisions
      FROM   users u
      JOIN   companies c ON c.code = u.company_code
      WHERE  u.id = ${payload.userId}
      LIMIT  1
    `;
    if (rows.length) {
      isPlatformAdmin = Boolean(rows[0].is_platform_admin);
      divisionRoles   = rows[0].division_roles || null;

      if (isPlatformAdmin) {
        allowedDivisions = ALL_DIVISIONS;
      } else if (divisionRoles && typeof divisionRoles === 'object') {
        // Explicit per-division roles — restricted divisions are honored
        // both ways: visible only when set to a non-no_access role.
        allowedDivisions = Object.entries(divisionRoles)
          .filter(([, v]) => v !== 'no_access')
          .map(([k]) => k);
      } else if (Array.isArray(rows[0].divisions) && rows[0].divisions.length) {
        // Legacy fallback — strip restricted divisions; require explicit grant
        allowedDivisions = rows[0].divisions.filter(d => !RESTRICTED_DIVISIONS.has(d));
      } else if (Array.isArray(rows[0].allowed_divisions) && rows[0].allowed_divisions.length) {
        // Company-licensed defaults — strip restricted divisions for same reason
        allowedDivisions = rows[0].allowed_divisions.filter(d => !RESTRICTED_DIVISIONS.has(d));
      } else {
        allowedDivisions = ['turf'];
      }
    }
  } catch (err) {
    console.error('[auth/verify] fresh DB read failed (non-fatal):', err.message);
  }

  return res.json({
    ok: true,
    user: {
      userId:           payload.userId,
      username:         payload.username,
      companyCode:      payload.companyCode,
      companyName:      payload.companyName,
      role:             payload.role,
      divisionRoles,
      allowedDivisions,
      isPlatformAdmin,
    },
  });
};
