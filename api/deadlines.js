'use strict';

const { neon }            = require('@neondatabase/serverless');
const { requireDivision } = require('./lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
        SELECT id, message, deadline_date, project_name, author_user, created_at
        FROM deadlines
        WHERE company_code = ${companyCode} AND division = ${division}
        ORDER BY deadline_date ASC NULLS LAST, created_at DESC
      `;
      return res.json({ deadlines: rows });
    }

    if (req.method === 'POST') {
      const { message, deadline_date, project_name } = req.body || {};
      if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

      const [row] = await sql`
        INSERT INTO deadlines (company_code, division, message, deadline_date, project_name, author_user)
        VALUES (
          ${companyCode}, ${division},
          ${message.trim()},
          ${deadline_date || null},
          ${(project_name || '').trim()},
          ${payload.username || ''}
        )
        RETURNING id, message, deadline_date, project_name, author_user, created_at
      `;
      return res.status(201).json({ deadline: row });
    }

    if (req.method === 'DELETE') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });

      await sql`
        DELETE FROM deadlines
        WHERE id = ${parseInt(id, 10)}
          AND company_code = ${companyCode}
          AND division     = ${division}
      `;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[deadlines] error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
