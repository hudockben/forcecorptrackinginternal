'use strict';

const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const ALLOWED_ROLES     = ['admin', 'level3', 'level2', 'level1'];
const DIV_ROLE_VALUES   = ['admin', 'level3', 'level2', 'level1', 'no_access'];
const ALL_DIVISIONS     = ['turf', 'dust', 'paving', 'trucking', 'quarry', 'intercompany', 'executive', 'scheduler', 'timesheet', 'payroll'];

function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

/** Derive the legacy `role` column value from division_roles (turf role, or highest if no turf) */
function deriveLegacyRole(divisionRoles) {
  if (!divisionRoles) return null;
  const turfRole = divisionRoles.turf;
  if (turfRole && turfRole !== 'no_access') return turfRole;
  // If turf is no_access, use highest role across all divisions
  const roleOrder = ['admin', 'level3', 'level2', 'level1'];
  for (const r of roleOrder) {
    if (Object.values(divisionRoles).includes(r)) return r;
  }
  return 'level1';
}

/** Derive the `divisions` array from division_roles (keys where value != 'no_access') */
function deriveDivisions(divisionRoles) {
  if (!divisionRoles) return null;
  const divs = Object.entries(divisionRoles)
    .filter(([, v]) => v !== 'no_access')
    .map(([k]) => k);
  return divs.length ? divs : [];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  if (payload.role !== 'admin' && !payload.isPlatformAdmin) {
    return res.status(403).json({ error: 'Company admin access required' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const companyCode = payload.companyCode;

  // GET — list all users in this company
  if (req.method === 'GET') {
    try {
      let rows;
      try {
        rows = await sql`
          SELECT id, username, role, division_roles, created_at
          FROM users
          WHERE company_code = ${companyCode}
          ORDER BY created_at ASC
        `;
      } catch {
        // division_roles column not yet migrated
        rows = await sql`
          SELECT id, username, role, created_at
          FROM users
          WHERE company_code = ${companyCode}
          ORDER BY created_at ASC
        `;
        rows.forEach(r => { r.division_roles = null; });
      }
      return res.json({ ok: true, users: rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — create or update a user in this company
  if (req.method === 'POST') {
    const {
      username,
      password,
      role           = 'level1',
      division_roles = null,
    } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    // Validate division_roles if provided
    if (division_roles !== null) {
      if (typeof division_roles !== 'object' || Array.isArray(division_roles)) {
        return res.status(400).json({ error: 'division_roles must be an object' });
      }
      for (const [div, r] of Object.entries(division_roles)) {
        if (!ALL_DIVISIONS.includes(div)) {
          return res.status(400).json({ error: `Unknown division: "${div}"` });
        }
        if (!DIV_ROLE_VALUES.includes(r)) {
          return res.status(400).json({ error: `Invalid role "${r}" for division "${div}"` });
        }
      }
    }

    // Validate legacy role (only matters when division_roles not provided)
    if (!division_roles && !ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }

    if (password !== undefined && password !== '' && password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const effectiveRole    = division_roles ? deriveLegacyRole(division_roles) : role;
    const effectiveDivs    = division_roles ? deriveDivisions(division_roles)  : null;
    const cleanUsername    = username.trim();

    try {
      // Check if user already exists (determines whether password is required)
      const existing = await sql`
        SELECT id FROM users
        WHERE LOWER(username) = LOWER(${cleanUsername}) AND company_code = ${companyCode}
      `;
      const isNew = existing.length === 0;

      if (isNew && !password) {
        return res.status(400).json({ error: 'password is required for new users' });
      }

      if (isNew || password) {
        // Create or full reset (with new password)
        const hash = await bcrypt.hash(password, 12);
        await sql`
          INSERT INTO users (username, company_code, password_hash, role, divisions, division_roles)
          VALUES (${cleanUsername}, ${companyCode}, ${hash}, ${effectiveRole}, ${effectiveDivs}, ${division_roles ? JSON.stringify(division_roles) : null})
          ON CONFLICT (username, company_code)
          DO UPDATE SET
            password_hash  = EXCLUDED.password_hash,
            role           = EXCLUDED.role,
            divisions      = EXCLUDED.divisions,
            division_roles = EXCLUDED.division_roles
        `;
      } else {
        // Update roles only — no password change
        await sql`
          UPDATE users
          SET role = ${effectiveRole},
              divisions = ${effectiveDivs},
              division_roles = ${division_roles ? JSON.stringify(division_roles) : null}
          WHERE LOWER(username) = LOWER(${cleanUsername}) AND company_code = ${companyCode}
        `;
      }

      return res.json({ ok: true, username: cleanUsername, role: effectiveRole, division_roles });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove a user by id (cannot delete yourself)
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (id === payload.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    try {
      const rows = await sql`SELECT id FROM users WHERE id = ${id} AND company_code = ${companyCode}`;
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      await sql`DELETE FROM users WHERE id = ${id} AND company_code = ${companyCode}`;
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
