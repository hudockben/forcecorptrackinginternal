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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });

  const companyCode = payload.companyCode;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // GET — return top 5 most recent posts for this company
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, message, author_user, author_name, completed, created_at
        FROM company_board
        WHERE company_code = ${companyCode}
        ORDER BY created_at DESC
        LIMIT 5
      `;
      return res.json({ posts: rows });
    }

    // POST — create a new post (admin only)
    if (req.method === 'POST') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      const { message } = req.body || {};
      if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

      const authorUser = payload.username || '';
      const authorName = payload.username || '';

      const [row] = await sql`
        INSERT INTO company_board (company_code, message, author_user, author_name)
        VALUES (${companyCode}, ${message.trim()}, ${authorUser}, ${authorName})
        RETURNING id, message, author_user, author_name, completed, created_at
      `;
      return res.status(201).json({ post: row });
    }

    // PATCH — toggle completed on a post (admin only)
    if (req.method === 'PATCH') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { completed } = req.body || {};
      if (typeof completed !== 'boolean') return res.status(400).json({ error: 'completed (boolean) required' });

      await sql`
        UPDATE company_board
        SET completed = ${completed}
        WHERE id = ${parseInt(id, 10)} AND company_code = ${companyCode}
      `;
      return res.json({ ok: true });
    }

    // DELETE — remove a post (admin only)
    if (req.method === 'DELETE') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });

      await sql`
        DELETE FROM company_board
        WHERE id = ${parseInt(id, 10)} AND company_code = ${companyCode}
      `;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[board] error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
