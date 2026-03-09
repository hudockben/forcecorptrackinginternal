'use strict';

/**
 * POST /api/admin/users
 * Protected by ADMIN_SECRET env var.
 * Body: { adminSecret, companyCode, username, password, role? }
 *
 * Creates (or resets the password for) a user in the given company.
 * role defaults to 'user'; pass role:'admin' for company admins.
 */

const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { adminSecret, companyCode, username, password, role = 'user' } = req.body || {};

  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!companyCode || !username || !password) {
    return res.status(400).json({ error: 'companyCode, username, and password are required' });
  }

  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'role must be "admin" or "user"' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const cleanCode = companyCode.trim().toUpperCase();

  try {
    // Verify company exists
    const companies = await sql`SELECT code FROM companies WHERE code = ${cleanCode}`;
    if (!companies.length) {
      return res.status(404).json({ error: `Company "${cleanCode}" not found. Create it first via /api/admin/companies` });
    }

    const hash = await bcrypt.hash(password, 12);

    await sql`
      INSERT INTO users (username, company_code, password_hash, role)
      VALUES (${username.trim()}, ${cleanCode}, ${hash}, ${role})
      ON CONFLICT (username, company_code)
      DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
    `;

    return res.json({ ok: true, username: username.trim(), companyCode: cleanCode, role });
  } catch (err) {
    console.error('[admin/users] error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
