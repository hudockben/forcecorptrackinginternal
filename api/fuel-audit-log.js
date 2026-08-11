'use strict';
/**
 * Fuel audit log — read-only view of every state change on fuel_submissions.
 * Drives the Fuel Admin "Audit Log" tab.
 *
 *   GET /api/fuel-audit-log
 *     ?from=YYYY-MM-DD&to=YYYY-MM-DD — date range (default open-ended)
 *     ?action=INSERT|UPDATE|SUBMIT|APPROVE|UNAPPROVE|ADMIN_EDIT|DELETE
 *     ?entry_id=N   — restrict to one submission
 *     ?user_id=N    — restrict to actions performed by one user
 *     ?limit=N      — cap (default 500, max 2000)
 *
 *   → { events: [{ id, entry_id, action, user_id, username,
 *                  changes, snapshot, created_at }, ...] }
 *
 * Access: Fuel Admin or platform admin. Deliberately NOT readable by the
 * field side — it carries the whole company's submissions in its snapshots.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

const VALID_ACTIONS = ['INSERT','UPDATE','SUBMIT','APPROVE','UNAPPROVE','ADMIN_EDIT','DELETE'];

function safeDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const canRead = hasDivisionAccess(payload, 'fuel_admin') || payload.isPlatformAdmin;
  if (!canRead) return res.status(403).json({ error: 'Fuel Admin access required' });

  const q = req.query || {};
  const from   = safeDate(q.from) || '1900-01-01';
  const to     = safeDate(q.to)   || '9999-12-31';
  const action = VALID_ACTIONS.includes(q.action) ? q.action : '';
  // BIGSERIAL/SERIAL ids start at 1 — 0 is a safe "no filter" sentinel.
  const entryF = safeInt(q.entry_id) || 0;
  const userF  = safeInt(q.user_id)  || 0;
  let limit    = safeInt(q.limit)    || 500;
  if (limit > 2000) limit = 2000;
  if (limit < 1)    limit = 1;

  const sql = neon(process.env.DATABASE_URL);

  try {
    const rows = await sql`
      SELECT id, entry_id, action, user_id, username,
             changes, snapshot, created_at
      FROM   fuel_audit_log
      WHERE  company_code = ${payload.companyCode}
        AND  created_at >= ${from}::date
        AND  created_at <  (${to}::date + INTERVAL '1 day')
        AND  (${action} = ''  OR action   = ${action})
        AND  (${entryF} = 0   OR entry_id = ${entryF})
        AND  (${userF}  = 0   OR user_id  = ${userF})
      ORDER  BY created_at DESC, id DESC
      LIMIT  ${limit}
    `;
    return res.json({ events: rows });
  } catch (err) {
    console.error('[fuel-audit-log]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
