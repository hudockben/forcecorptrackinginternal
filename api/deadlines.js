'use strict';

const { neon } = require('@neondatabase/serverless');
const jwt      = require('jsonwebtoken');

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

  const companyCode = payload.companyCode;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // GET — return all deadlines for this company, sorted by deadline date
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, message, deadline_date, project_name, author_user, created_at
        FROM deadlines
        WHERE company_code = ${companyCode}
        ORDER BY deadline_date ASC NULLS LAST, created_at DESC
      `;
      return res.json({ deadlines: rows });
    }

    // POST — create a deadline entry (any authenticated user)
    if (req.method === 'POST') {
      const { message, deadline_date, project_name } = req.body || {};
      if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

      const [row] = await sql`
        INSERT INTO deadlines (company_code, message, deadline_date, project_name, author_user)
        VALUES (
          ${companyCode},
          ${message.trim()},
          ${deadline_date || null},
          ${(project_name || '').trim()},
          ${payload.username || ''}
        )
        RETURNING id, message, deadline_date, project_name, author_user, created_at
      `;
      return res.status(201).json({ deadline: row });
    }

    // DELETE — remove a deadline (admin only)
    if (req.method === 'DELETE') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });

      await sql`
        DELETE FROM deadlines
        WHERE id = ${parseInt(id, 10)} AND company_code = ${companyCode}
      `;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[deadlines] error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
