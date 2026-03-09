'use strict';

/**
 * POST /api/admin/companies
 * Protected by ADMIN_SECRET env var.
 * Body: { adminSecret, code, name }
 *
 * Creates a new company. Use this from the Neon SQL Editor or
 * via curl/Postman to onboard new organizations.
 */

const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { adminSecret, code, name } = req.body || {};

  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!code || !name) {
    return res.status(400).json({ error: 'code and name are required' });
  }

  const cleanCode = code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(cleanCode)) {
    return res.status(400).json({ error: 'code must be 2–20 uppercase letters, digits, hyphens, or underscores' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    await sql`
      INSERT INTO companies (code, name)
      VALUES (${cleanCode}, ${name.trim()})
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    `;
    return res.json({ ok: true, code: cleanCode, name: name.trim() });
  } catch (err) {
    console.error('[admin/companies] error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
