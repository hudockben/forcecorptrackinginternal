'use strict';
/**
 * GET /api/dust-audit — audit log for the dust control tracking tab.
 *
 * Query params:
 *   limit  (optional, default 500, max 5000)
 *   action (optional: INSERT | UPDATE | DELETE)
 *   from   (optional ISO date — created_at >= from)
 *   to     (optional ISO date — created_at <= to)
 *
 * Returns: { entries: [ { id, row_id, action, user_id, username,
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
  const from = q.from ? new Date(q.from) : null;
  const to   = q.to   ? new Date(q.to)   : null;

  try {
    // Ensure table exists (idempotent) — same shape as dust-rows.js
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
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_dust_audit_company ON dust_control_audit_log(company_code, created_at DESC)`;

    let rows;
    if (action && from && to) {
      rows = await sql`
        SELECT id, row_id, action, user_id, username, changes, snapshot, created_at
        FROM dust_control_audit_log
        WHERE company_code = ${companyCode}
          AND action       = ${action}
          AND created_at  >= ${from.toISOString()}
          AND created_at  <= ${to.toISOString()}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `;
    } else if (action) {
      rows = await sql`
        SELECT id, row_id, action, user_id, username, changes, snapshot, created_at
        FROM dust_control_audit_log
        WHERE company_code = ${companyCode}
          AND action       = ${action}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `;
    } else if (from && to) {
      rows = await sql`
        SELECT id, row_id, action, user_id, username, changes, snapshot, created_at
        FROM dust_control_audit_log
        WHERE company_code = ${companyCode}
          AND created_at  >= ${from.toISOString()}
          AND created_at  <= ${to.toISOString()}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT id, row_id, action, user_id, username, changes, snapshot, created_at
        FROM dust_control_audit_log
        WHERE company_code = ${companyCode}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `;
    }

    return res.json({ entries: rows });
  } catch (err) {
    console.error('[dust-audit]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
