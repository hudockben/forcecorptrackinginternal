'use strict';

const { neon }  = require('@neondatabase/serverless');
const bcrypt    = require('bcryptjs');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  // GET — list users for a company
  if (req.method === 'GET') {
    const { adminSecret, companyCode } = req.query;
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const rows = companyCode
        ? await sql`SELECT id, username, company_code, role, created_at FROM users WHERE company_code = ${companyCode.toUpperCase()} ORDER BY created_at DESC`
        : await sql`SELECT id, username, company_code, role, created_at FROM users ORDER BY created_at DESC`;
      return res.json({ ok: true, users: rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — create or reset a user
  if (req.method === 'POST') {
    const { adminSecret, companyCode, username, password, role = 'level1' } = req.body || {};

    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!companyCode || !username || !password) {
      return res.status(400).json({ error: 'companyCode, username, and password are required' });
    }
    if (!['admin', 'level3', 'level2', 'level1'].includes(role)) {
      return res.status(400).json({ error: 'role must be "admin", "level3", "level2", or "level1"' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const cleanCode = companyCode.trim().toUpperCase();

    try {
      const companies = await sql`SELECT code FROM companies WHERE code = ${cleanCode}`;
      if (!companies.length) {
        return res.status(404).json({ error: `Company "${cleanCode}" not found. Create it first.` });
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
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove a user by id
  if (req.method === 'DELETE') {
    const { adminSecret, id } = req.body || {};
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      await sql`DELETE FROM users WHERE id = ${id}`;
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
