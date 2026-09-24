'use strict';

const { neon }   = require('@neondatabase/serverless');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { syncProjects, syncLists, syncPurchaseOrders, syncInventory } = require('../lib/sync-normalized');
// What a sign-in grants is decided in one place, because requireAuth applies
// the same rule to the account on every request afterwards: a token that
// disagreed with it would be a device whose screens and server disagreed.
const { accessFromRow } = require('../lib/auth');

/**
 * Background sync — runs after login if the projects table has no rows for
 * this company (i.e. first login after a fresh deploy). Fire-and-forget:
 * never delays the login response or throws to the caller.
 */
async function autoSyncIfNeeded(companyCode) {
  try {
    const sql = neon(process.env.DATABASE_URL);

    // Only sync if we haven't done so yet (projects table empty for this company)
    const check = await sql`SELECT 1 FROM projects WHERE company_code = ${companyCode} LIMIT 1`;
    if (check.length > 0) return; // already populated

    const keys = [
      `${companyCode}:fct_projects`,
      `${companyCode}:fct_projects_index`,
      `${companyCode}:fct_lists`,
      `${companyCode}:fct_purchase_orders`,
      `${companyCode}:fct_inventory`,
    ];
    const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${keys})`;
    const blobs = {};
    rows.forEach(r => { blobs[r.key] = r.value; });

    const projectBlobs = await sql`
      SELECT key, value FROM app_data
      WHERE key LIKE ${companyCode + ':fct_project_%'}
        AND key NOT LIKE ${companyCode + ':fct_projects%'}
    `;

    const p = companyCode + ':';
    await syncProjects(sql, companyCode, blobs[`${p}fct_projects`] || blobs[`${p}fct_projects_index`] || []);
    for (const row of projectBlobs) {
      if (row.value) await syncProjects(sql, companyCode, row.value);
    }
    await syncLists(sql, companyCode, blobs[`${p}fct_lists`] || {});
    await syncPurchaseOrders(sql, companyCode, blobs[`${p}fct_purchase_orders`] || []);
    await syncInventory(sql, companyCode, blobs[`${p}fct_inventory`] || []);

    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${companyCode + ':fct_last_sync'}, ${JSON.stringify(new Date().toISOString())}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    console.log(`[auto-sync] backfill complete for ${companyCode}`);
  } catch (err) {
    console.error(`[auto-sync] failed for ${companyCode}:`, err.message);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body || {};

  // A single-tenant deployment sets DEFAULT_COMPANY_CODE and callers may then
  // omit companyCode entirely — the sign-in page hides the field for exactly
  // this reason. An explicit code in the body still wins, so a second company
  // keeps working. With the env var unset the field stays required as before.
  const companyCode = String(
    (req.body && req.body.companyCode) || process.env.DEFAULT_COMPANY_CODE || ''
  ).trim();

  if (!companyCode || !username || !password) {
    return res.status(400).json({ error: 'companyCode, username, and password are required' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Fetch user + company. Try with division_roles first; fall back gracefully
    // if the column hasn't been migrated yet on this deployment.
    let rows;
    try {
      rows = await sql`
        SELECT
          u.id,
          u.username,
          u.password_hash,
          u.role,
          u.divisions,
          u.division_roles,
          u.is_platform_admin,
          c.name               AS company_name,
          c.allowed_divisions
        FROM users u
        JOIN companies c ON c.code = u.company_code
        WHERE LOWER(u.username)     = LOWER(${username.trim()})
          AND LOWER(u.company_code) = LOWER(${companyCode})
      `;
    } catch (colErr) {
      // division_roles column not yet migrated — query without it
      rows = await sql`
        SELECT
          u.id,
          u.username,
          u.password_hash,
          u.role,
          u.divisions,
          u.is_platform_admin,
          c.name               AS company_name,
          c.allowed_divisions
        FROM users u
        JOIN companies c ON c.code = u.company_code
        WHERE LOWER(u.username)     = LOWER(${username.trim()})
          AND LOWER(u.company_code) = LOWER(${companyCode})
      `;
      rows.forEach(r => { r.division_roles = null; });
    }

    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid company code, username, or password' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid company code, username, or password' });
    }

    // role (the turf role, for tracker.html), divisionRoles, allowedDivisions
    // and isPlatformAdmin. The token carries them so the pages can draw
    // without a round trip; the server never trusts them — requireAuth reads
    // the account again on every request.
    const { role, divisionRoles, allowedDivisions, isPlatformAdmin } = accessFromRow(user);

    const cleanCode = companyCode.toUpperCase();

    const token = jwt.sign(
      {
        userId:           user.id,
        username:         user.username,
        companyCode:      cleanCode,
        companyName:      user.company_name,
        role,
        divisionRoles,
        allowedDivisions,
        isPlatformAdmin,
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Trigger background backfill on first login after deploy (no await — never delays login)
    autoSyncIfNeeded(cleanCode);

    return res.json({
      ok: true,
      token,
      user: {
        username:         user.username,
        companyCode:      cleanCode,
        companyName:      user.company_name,
        role,
        divisionRoles,
        allowedDivisions,
        isPlatformAdmin,
      },
    });
  } catch (err) {
    console.error('[auth/login] error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
