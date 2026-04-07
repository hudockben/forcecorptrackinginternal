'use strict';

const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const ALLOWED_ROLES = ['admin', 'level3', 'level2', 'level1'];

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  if (payload.role !== 'admin') return res.status(403).json({ error: 'Company admin access required' });

  const sql = neon(process.env.DATABASE_URL);
  const companyCode = payload.companyCode;

  // GET — list all users in this company
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, username, role, created_at
        FROM users
        WHERE company_code = ${companyCode}
        ORDER BY created_at ASC
      `;
      return res.json({ ok: true, users: rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — create or reset a user in this company
  if (req.method === 'POST') {
    const { username, password, role = 'level1' } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      await sql`
        INSERT INTO users (username, company_code, password_hash, role)
        VALUES (${username.trim()}, ${companyCode}, ${hash}, ${role})
        ON CONFLICT (username, company_code)
        DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
      `;
      return res.json({ ok: true, username: username.trim(), role });
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
      // Ensure the user belongs to this company, and scope the DELETE to this company
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
