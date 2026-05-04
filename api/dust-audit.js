'use strict';
/**
 * GET /api/dust-audit — audit log for the dust control division.
 *
 * Query params (all optional):
 *   limit   default 500, max 5000
 *   action  INSERT | UPDATE | DELETE
 *   source  tracking | other-billing
 *   from    ISO date  — created_at >= from
 *   to      ISO date  — created_at <= to
 *
 * Returns: { entries: [ { id, row_id, action, source, user_id, username,
 *                         changes, snapshot, created_at } ] }
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  const q      = req.query || {};
  const limit  = Math.min(Math.max(parseInt(q.limit, 10) || 500, 1), 5000);
  const action = ['INSERT', 'UPDATE', 'DELETE'].includes(String(q.action || '').toUpperCase())
    ? String(q.action).toUpperCase()
    : null;
  const source = ['tracking', 'other-billing'].includes(String(q.source || '').toLowerCase())
    ? String(q.source).toLowerCase()
    : null;
  const fromIso = q.from ? new Date(q.from).toISOString() : null;
  const toIso   = q.to   ? new Date(q.to).toISOString()   : null;

  try {
    // Ensure table exists with the source column.
    await sql`
      CREATE TABLE IF NOT EXISTS dust_control_audit_log (
        id            BIGSERIAL PRIMARY KEY,
        company_code  TEXT        NOT NULL,
        row_id        TEXT        NOT NULL,
        action        TEXT        NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
        user_id       INTEGER,
        username      TEXT,
        changes       JSONB,
        snapshot      JSONB,
        source        TEXT        NOT NULL DEFAULT 'tracking',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE dust_control_audit_log ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tracking'`;
    await sql`CREATE INDEX IF NOT EXISTS idx_dust_audit_company_src ON dust_control_audit_log(company_code, source, created_at DESC)`;

    // Single query with optional filters via COALESCE-style guards.
    const rows = await sql`
      SELECT id, row_id, action, source, user_id, username, changes, snapshot, created_at
      FROM dust_control_audit_log
      WHERE company_code = ${companyCode}
        AND (${action}::text  IS NULL OR action     = ${action})
        AND (${source}::text  IS NULL OR source     = ${source})
        AND (${fromIso}::timestamptz IS NULL OR created_at >= ${fromIso})
        AND (${toIso}::timestamptz   IS NULL OR created_at <= ${toIso})
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;

    return res.json({ entries: rows });
  } catch (err) {
    console.error('[dust-audit]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
