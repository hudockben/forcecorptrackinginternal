'use strict';
/**
 * Active/awarded jobs for a given division — used by the Timesheet field
 * form to populate the "which job did you work on?" dropdown.
 *
 *   GET /api/timesheet-jobs?division=<turf|dust|paving|trucking|quarry>
 *     → { jobs: [{ id: string, label: string }, ...] }
 *
 * STRICTLY READ-ONLY. This endpoint does not write, modify, or migrate any
 * existing division's data — it only queries what's already there.
 *
 * Each division stores its "jobs" differently; the strategy per division:
 *   turf      → `projects` table, filtered by status
 *   paving    → `app_data` JSON blobs (fct_paving_project_<id>), filtered by status
 *   trucking  → same `projects` table as turf (trucking_entries.project_id FKs to it)
 *   dust      → `dust_companies` (customer-level — no status, show all)
 *   quarry    → `quarry_locations` (no status, show all)
 *
 * "Active/awarded" = project status in {Awarded, In Progress, Substantially Complete}.
 * Empty/missing status is also included so older projects without a status set
 * still appear in the picker.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

const SUPPORTED = ['turf', 'dust', 'paving', 'trucking', 'quarry'];
const ACTIVE_PROJECT_STATUSES = ['Awarded', 'In Progress', 'Substantially Complete'];

async function turfOrTruckingJobs(sql, companyCode) {
  const rows = await sql`
    SELECT id, name, status
    FROM   projects
    WHERE  company_code = ${companyCode}
      AND  (
            status IS NULL
         OR status = ''
         OR status = ANY(${ACTIVE_PROJECT_STATUSES})
      )
    ORDER BY name ASC
  `;
  return rows.map(r => ({
    id:    r.id,
    label: r.name || '(unnamed project)',
  }));
}

async function pavingJobs(sql, companyCode) {
  // Paving projects live in app_data JSON blobs:
  //   "<company>:fct_paving_project_<projectId>"
  // The index lives at "<company>:fct_paving_projects_index".
  // We deliberately read only the per-project blobs (skipping the index) and
  // never touch the paving frontend's storage.
  const rows = await sql`
    SELECT key, value FROM app_data
    WHERE key LIKE ${companyCode + ':fct_paving_project_%'}
      AND key NOT LIKE ${companyCode + ':fct_paving_projects_%'}
  `;
  const jobs = [];
  for (const r of rows) {
    const blob = r.value;
    if (!blob || typeof blob !== 'object') continue;
    const id     = blob.id || r.key.split(':fct_paving_project_')[1];
    const name   = blob['project-name'] || blob.name || '(unnamed project)';
    const status = blob.status || '';
    const isActive =
      !status ||
      ACTIVE_PROJECT_STATUSES.includes(status);
    if (!isActive) continue;
    jobs.push({ id: String(id), label: String(name) });
  }
  jobs.sort((a, b) => a.label.localeCompare(b.label));
  return jobs;
}

async function dustJobs(sql, companyCode) {
  // Dust "jobs" are customer companies (dust_companies). Locations live in a
  // separate table but field users typically pick the company; locations can
  // be a future refinement once admins ask for it.
  const rows = await sql`
    SELECT id, name FROM dust_companies
    WHERE company_code = ${companyCode}
    ORDER BY name ASC
  `;
  return rows.map(r => ({ id: r.id, label: r.name }));
}

async function quarryJobs(sql, companyCode) {
  const rows = await sql`
    SELECT id, name FROM quarry_locations
    WHERE company_code = ${companyCode}
    ORDER BY name ASC
  `;
  return rows.map(r => ({ id: r.id, label: r.name }));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  // Any user with timesheet or payroll access can read the job picker
  const allowed =
    hasDivisionAccess(payload, 'timesheet') ||
    hasDivisionAccess(payload, 'payroll')   ||
    payload.isPlatformAdmin;
  if (!allowed) {
    return res.status(403).json({ error: 'Timesheet or Payroll access required' });
  }

  const division = String(req.query.division || '').toLowerCase();
  if (!SUPPORTED.includes(division)) {
    return res.status(400).json({ error: `division must be one of: ${SUPPORTED.join(', ')}` });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    let jobs = [];
    if (division === 'turf' || division === 'trucking') jobs = await turfOrTruckingJobs(sql, payload.companyCode);
    else if (division === 'paving')                     jobs = await pavingJobs(sql, payload.companyCode);
    else if (division === 'dust')                       jobs = await dustJobs(sql, payload.companyCode);
    else if (division === 'quarry')                     jobs = await quarryJobs(sql, payload.companyCode);

    return res.json({ jobs });
  } catch (err) {
    console.error('[timesheet-jobs]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
