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
 *   turf      → `app_data` JSON blobs (fct_project_<id>) anchored to the
 *                fct_projects_index so orphan blobs don't leak through
 *   paving    → same pattern with fct_paving_project_<id> + index
 *   trucking  → `dropdown_lists` rows where list_name = 'truck_customers'
 *                (the Trucking division's customer roster)
 *   dust      → `dust_companies` (customer-level — no status, show all)
 *   quarry    → `quarry_locations` (no status, show all)
 *
 * "Active/awarded" = project status in {Awarded, In Progress, Substantially Complete}.
 * Empty/missing status is also included so older projects without a status set
 * still appear in the picker. Projects with empty names are skipped.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

const SUPPORTED = ['turf', 'dust', 'paving', 'trucking', 'quarry'];
const ACTIVE_PROJECT_STATUSES = ['Awarded', 'In Progress', 'Substantially Complete'];

/**
 * Read the projects index blob and return the ordered list of project ids.
 * The index is the canonical source for "which projects are live" — it's
 * what tracker.html / paving.html maintain. Reading blobs directly with
 * a LIKE pattern would surface orphan blobs that no longer belong to a
 * live project.
 */
async function readIndexIds(sql, companyCode, indexKey) {
  const rows = await sql`
    SELECT value FROM app_data WHERE key = ${companyCode + ':' + indexKey}
  `;
  if (!rows.length || !rows[0].value) return [];
  const v = rows[0].value;
  if (Array.isArray(v))            return v.filter(Boolean);
  if (v && Array.isArray(v.ids))   return v.ids.filter(Boolean);
  return [];
}

async function projectsFromBlobs(sql, companyCode, projectPrefix, indexKey) {
  const ids = await readIndexIds(sql, companyCode, indexKey);
  if (!ids.length) return [];

  const keys = ids.map(id => companyCode + ':' + projectPrefix + id);
  const rows = await sql`
    SELECT key, value FROM app_data WHERE key = ANY(${keys})
  `;

  // Map blob → job; skip nameless / inactive / dup-id rows.
  // Label shape: "Name · 26045" when a job number exists; just "Name" otherwise.
  const seen = new Set();
  const jobs = [];
  for (const r of rows) {
    const blob = r.value;
    if (!blob || typeof blob !== 'object') continue;
    const id = blob.id || r.key.split(':' + projectPrefix)[1];
    if (!id || seen.has(id)) continue;
    const name = (blob['project-name'] || blob.name || '').trim();
    if (!name) continue;
    const status = (blob.status || '').trim();
    const isActive = !status || ACTIVE_PROJECT_STATUSES.includes(status);
    if (!isActive) continue;
    const jobNum = String(blob['job-number'] || blob.job_number || '').trim();
    const label  = jobNum ? `${name} · ${jobNum}` : name;
    seen.add(id);
    jobs.push({ id: String(id), label });
  }

  jobs.sort((a, b) => a.label.localeCompare(b.label));
  return jobs;
}

async function turfOrTruckingJobs(sql, companyCode) {
  return projectsFromBlobs(sql, companyCode, 'fct_project_', 'fct_projects_index');
}

async function turfJobs(sql, companyCode) {
  return projectsFromBlobs(sql, companyCode, 'fct_project_', 'fct_projects_index');
}

async function pavingJobs(sql, companyCode) {
  return projectsFromBlobs(sql, companyCode, 'fct_paving_project_', 'fct_paving_projects_index');
}

async function truckingJobs(sql, companyCode) {
  // Trucking's "jobs" are its customer roster — the people they haul for.
  // Source of truth is the dropdown_lists table; the same data is also
  // mirrored in fct_truck_division_lists but the table is the canonical
  // form (see api/truck-division.js).
  const rows = await sql`
    SELECT value, sort_order FROM dropdown_lists
    WHERE  company_code = ${companyCode}
      AND  list_name    = 'truck_customers'
    ORDER  BY sort_order ASC, value ASC
  `;
  const seen = new Set();
  const jobs = [];
  for (const r of rows) {
    const name = (r.value || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // No stable id — customer name is the identifier in the trucking model.
    jobs.push({ id: name, label: name });
  }
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
    if      (division === 'turf')     jobs = await turfJobs(sql, payload.companyCode);
    else if (division === 'paving')   jobs = await pavingJobs(sql, payload.companyCode);
    else if (division === 'trucking') jobs = await truckingJobs(sql, payload.companyCode);
    else if (division === 'dust')     jobs = await dustJobs(sql, payload.companyCode);
    else if (division === 'quarry')   jobs = await quarryJobs(sql, payload.companyCode);

    return res.json({ jobs });
  } catch (err) {
    console.error('[timesheet-jobs]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
