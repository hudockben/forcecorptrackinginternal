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
 * read-only. Reads the project blob's bidItems array — the same source
 * api/timesheet-jobs.js reads to list the jobs, so every division's jobs
 * resolve. The normalized bid_items table is NOT used: only turf project
 * blobs are synced into it, so paving and kiewit jobs returned nothing.
 *
 * Authorization: any user with payroll OR timesheet access can read this.
 * The lookup is scoped to the caller's company_code so cross-company reads
 * are impossible.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

const SUPPORTED_DIVISIONS = ['turf', 'paving', 'kiewit'];

// Where each division's project blob lives. Same map api/timesheet-jobs.js
// uses to list the jobs, so a job that appears in the picker always has a
// readable blob here.
const PROJECT_PREFIX = {
  turf:   'fct_project_',
  paving: 'fct_paving_project_',
  kiewit: 'fct_kiewit_project_',
};

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
    // Read the project blob, not the normalized bid_items mirror. Only turf
    // project blobs are synced into that table (syncForKey routes
    // fct_project_* and nothing else), so a paving or kiewit job — which
    // api/timesheet-jobs.js happily lists, because it reads blobs — came back
    // with no cost codes at all and the split modal had nothing to offer.
    // The blob is the source of truth every other endpoint uses.
    const scopedKey = `${payload.companyCode}:${PROJECT_PREFIX[division]}${jobId}`;
    const rows = await sql`SELECT value FROM app_data WHERE key = ${scopedKey}`;
    const blob = rows.length ? rows[0].value : null;
    const bidItems = (blob && Array.isArray(blob.bidItems)) ? blob.bidItems : [];

    // Group sub codes per cost code. A blank sub_code is preserved as ''
    // because some bid items legitimately have no sub code and the
    // supervisor may still want to split labor against them.
    const grouped = new Map();
    for (const r of bidItems) {
      if (!r || typeof r !== 'object') continue;
      const cc = String(r.cost_code || '').trim();
      if (!cc) continue;
      if (!grouped.has(cc)) grouped.set(cc, new Set());
      grouped.get(cc).add(String(r.sub_code || '').trim());
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
