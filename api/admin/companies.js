'use strict';

const { neon } = require('@neondatabase/serverless');

const VALID_DIVISIONS = ['turf', 'dust', 'paving', 'kiewit', 'trucking', 'quarry', 'intercompany', 'executive'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  // GET — list all companies
  if (req.method === 'GET') {
    const { adminSecret } = req.query;
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const rows = await sql`
        SELECT code, name, allowed_divisions, created_at
        FROM companies
        ORDER BY created_at DESC
      `;
      return res.json({ ok: true, companies: rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — create or update a company
  if (req.method === 'POST') {
    const { adminSecret, code, name, allowed_divisions } = req.body || {};

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

    // Validate and normalize allowed_divisions
    let divisions = ['turf']; // default: turf only
    if (allowed_divisions !== undefined) {
      if (!Array.isArray(allowed_divisions) || allowed_divisions.length === 0) {
        return res.status(400).json({ error: 'allowed_divisions must be a non-empty array' });
      }
      const invalid = allowed_divisions.filter(d => !VALID_DIVISIONS.includes(d));
      if (invalid.length) {
        return res.status(400).json({ error: `Invalid division(s): ${invalid.join(', ')}. Valid: ${VALID_DIVISIONS.join(', ')}` });
      }
      divisions = allowed_divisions;
    }

    try {
      await sql`
        INSERT INTO companies (code, name, allowed_divisions)
        VALUES (${cleanCode}, ${name.trim()}, ${divisions})
        ON CONFLICT (code) DO UPDATE
          SET name              = EXCLUDED.name,
              allowed_divisions = EXCLUDED.allowed_divisions
      `;
      return res.json({ ok: true, code: cleanCode, name: name.trim(), allowed_divisions: divisions });
    } catch (err) {
      console.error('[admin/companies] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
