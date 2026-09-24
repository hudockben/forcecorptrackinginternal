'use strict';
/**
 * Timesheet audit log — read-only view of every state change on
 * timesheet_entries. Drives the Payroll review "Audit Log" tab.
 *
 *   GET /api/timesheet-audit-log
 *     ?from=YYYY-MM-DD&to=YYYY-MM-DD — date range (default open-ended)
 *     ?action=INSERT|UPDATE|SUBMIT|APPROVE|ADMIN_EDIT|DELETE — single action
 *     ?entry_id=N   — restrict to one entry
 *     ?user_id=N    — restrict to actions performed by one user
 *     ?limit=N      — cap (default 500, max 2000)
 *
 *   → { events: [{ id, entry_id, action, user_id, username,
 *                  changes, snapshot, created_at }, ...] }
 *
 * Access: payroll admin or platform admin.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, payrollAccess } = require('./lib/auth');

const VALID_ACTIONS = ['INSERT','UPDATE','SUBMIT','APPROVE','ADMIN_EDIT','DELETE','PRECODE'];

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

  const payload = await requireAuth(req, res);
  if (!payload) return;

  // APPROVER-only, not merely payroll-holding. This endpoint returns `changes`
  // AND `snapshot` — whole before/after copies of an entry — for every
  // employee in the company, with no scoping by crew, job or supervisor.
  // A coder is granted payroll access so he can reach the timesheet endpoint
  // and the cost-code list, and hasDivisionAccess cannot tell the two grants
  // apart; reading it here would hand a foreman the entire company's timesheet
  // history as a side effect of being allowed to type a cost code.
  const { canApprove } = payrollAccess(payload);
  if (!canApprove) {
    return res.status(403).json({ error: 'Payroll access required' });
  }

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
      FROM   timesheet_audit_log
      WHERE  company_code = ${payload.companyCode}
        AND  created_at >= ${from}::date
        AND  created_at <  (${to}::date + INTERVAL '1 day')
        AND  (${action}  = ''  OR action   = ${action})
        AND  (${entryF}  = 0   OR entry_id = ${entryF})
        AND  (${userF}   = 0   OR user_id  = ${userF})
      ORDER  BY created_at DESC, id DESC
      LIMIT  ${limit}
    `;
    return res.json({ events: rows });
  } catch (err) {
    console.error('[timesheet-audit-log]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
