'use strict';
/**
 * Cost codes + sub codes for a given timesheet job (project).
 *
 *   GET /api/timesheet-job-costcodes?division=<turf|paving>&jobId=<projectId>
 *     → {
 *         cost_codes: [
 *           { cost_code: '101', sub_codes: ['A', 'B', ''] },
 *           ...
 *         ]
 *       }
 *
 * Used by the payroll-approval split modal in payroll.html. Strictly
 * read-only. Source of truth is the bid_items table (mirror of the project
 * blob's bidItems array).
 *
 * Authorization: any user with payroll OR timesheet access can read this.
 * The lookup is scoped to the caller's company_code so cross-company reads
 * are impossible.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

const SUPPORTED_DIVISIONS = ['turf', 'paving', 'kiewit'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const allowed =
    hasDivisionAccess(payload, 'payroll')   ||
    hasDivisionAccess(payload, 'timesheet') ||
    payload.isPlatformAdmin;
  if (!allowed) {
    return res.status(403).json({ error: 'Payroll or Timesheet access required' });
  }

  const division = String(req.query.division || '').toLowerCase();
  if (!SUPPORTED_DIVISIONS.includes(division)) {
    return res.status(400).json({ error: `division must be one of: ${SUPPORTED_DIVISIONS.join(', ')}` });
  }
  const jobId = String(req.query.jobId || '').trim();
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  const sql = neon(process.env.DATABASE_URL);

  try {
    const rows = await sql`
      SELECT cost_code, sub_code FROM bid_items
      WHERE project_id   = ${jobId}
        AND company_code = ${payload.companyCode}
    `;

    // Group sub codes per cost code. A blank sub_code is preserved as ''
    // because some bid items legitimately have no sub code and the
    // supervisor may still want to split labor against them.
    const grouped = new Map();
    for (const r of rows) {
      const cc = (r.cost_code || '').trim();
      if (!cc) continue;
      if (!grouped.has(cc)) grouped.set(cc, new Set());
      grouped.get(cc).add((r.sub_code || '').trim());
    }

    const cost_codes = [...grouped.entries()]
      .map(([cost_code, set]) => ({
        cost_code,
        sub_codes: [...set].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.cost_code.localeCompare(b.cost_code));

    return res.json({ cost_codes });
  } catch (err) {
    console.error('[timesheet-job-costcodes]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
