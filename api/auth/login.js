'use strict';

const { neon }   = require('@neondatabase/serverless');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { syncProjects, syncLists, syncPurchaseOrders, syncInventory } = require('../lib/sync-normalized');

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

  const { companyCode, username, password } = req.body || {};

  if (!companyCode || !username || !password) {
    return res.status(400).json({ error: 'companyCode, username, and password are required' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Look up user within that company
    const rows = await sql`
      SELECT u.id, u.username, u.password_hash, u.role, c.name AS company_name
      FROM users u
      JOIN companies c ON c.code = u.company_code
      WHERE LOWER(u.username) = LOWER(${username.trim()})
        AND LOWER(u.company_code) = LOWER(${companyCode.trim()})
    `;

    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid company code, username, or password' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid company code, username, or password' });
    }

    const token = jwt.sign(
      {
        userId:      user.id,
        username:    user.username,
        companyCode: companyCode.trim().toUpperCase(),
        companyName: user.company_name,
        role:        user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    // Trigger background backfill on first login after deploy (no await — never delays login)
    autoSyncIfNeeded(companyCode.trim().toUpperCase());

    return res.json({
      ok: true,
      token,
      user: {
        username:    user.username,
        companyCode: companyCode.trim().toUpperCase(),
        companyName: user.company_name,
        role:        user.role,
      },
    });
  } catch (err) {
    console.error('[auth/login] error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
