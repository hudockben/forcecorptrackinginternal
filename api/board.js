'use strict';

const { neon }            = require('@neondatabase/serverless');
const { requireDivision } = require('./lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const guard = requireDivision(req, res);
  if (!guard) return;
  const { payload, division } = guard;
  const companyCode = payload.companyCode;
  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, message, author_user, author_name, completed, created_at
        FROM company_board
        WHERE company_code = ${companyCode} AND division = ${division}
        ORDER BY created_at DESC
        LIMIT 5
      `;
      return res.json({ posts: rows });
    }

    if (req.method === 'POST') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      const { message } = req.body || {};
      if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

      const authorUser = payload.username || '';
      const [row] = await sql`
        INSERT INTO company_board (company_code, division, message, author_user, author_name)
        VALUES (${companyCode}, ${division}, ${message.trim()}, ${authorUser}, ${authorUser})
        RETURNING id, message, author_user, author_name, completed, created_at
      `;
      return res.status(201).json({ post: row });
    }

    if (req.method === 'PATCH') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { completed } = req.body || {};
      if (typeof completed !== 'boolean') return res.status(400).json({ error: 'completed (boolean) required' });

      await sql`
        UPDATE company_board
        SET completed = ${completed}
        WHERE id = ${parseInt(id, 10)}
          AND company_code = ${companyCode}
          AND division     = ${division}
      `;
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });

      await sql`
        DELETE FROM company_board
        WHERE id = ${parseInt(id, 10)}
          AND company_code = ${companyCode}
          AND division     = ${division}
      `;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[board] error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
