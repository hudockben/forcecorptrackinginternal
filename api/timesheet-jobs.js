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
 *   quarry    → `quarry_locations` × two standing activities (Daily,
 *                Crushing) — one job per (activity, location); job_id encodes
 *                "<activity>:<locationId>" so approval routes to the right tab
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
  // Trucking's "jobs" are its customer roster — the people they haul for. The
  // Trucking division manages this list in trucking.html, and its SOURCE OF
  // TRUTH is the fct_truck_division_lists app_data blob: api/truck-division.js
  // writes that blob synchronously and prefers it on read, while the
  // dropdown_lists table is only a fire-and-forget mirror that can lag (or be
  // dropped entirely) in a serverless request. Reading the mirror here made the
  // picker drift out of sync with the managed customer list — showing far fewer
  // customers than the division actually has. Read the blob (scoped key first,
  // then the legacy unscoped key — same resolution api/truck-division.js uses)
  // so the picker mirrors exactly what "Manage lists" shows.
  const [scopedRows, legacyRows] = await Promise.all([
    sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_truck_division_lists'}`,
    sql`SELECT value FROM app_data WHERE key = 'fct_truck_division_lists'`,
  ]);
  const scoped = (scopedRows[0]?.value && typeof scopedRows[0].value === 'object') ? scopedRows[0].value : null;
  const legacy = (legacyRows[0]?.value && typeof legacyRows[0].value === 'object') ? legacyRows[0].value : null;
  const lists  = scoped || legacy || null;

  let customers = (lists && Array.isArray(lists.customers)) ? lists.customers : null;

  // Fallback for older data that only ever populated the normalized mirror.
  if (!customers) {
    const mirror = await sql`
      SELECT value FROM dropdown_lists
      WHERE  company_code = ${companyCode} AND list_name = 'truck_customers'
      ORDER  BY sort_order ASC, value ASC
    `;
    customers = mirror.map(r => r.value);
  }

  // Mirror the managed list as-is: keep distinct-cased names (the roster
  // intentionally holds e.g. "Force" and "FORCE" as separate customers), and
  // drop only blanks and exact duplicates. Customer name is the identifier —
  // the trucking model has no stable per-customer id.
  const seen = new Set();
  const jobs = [];
  for (const raw of customers) {
    const name = (raw || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    jobs.push({ id: name, label: name });
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
  // Quarry doesn't spin up a new "project" per job the way turf/paving do — it
  // runs two standing activities (Daily field work, Crushing) at each location.
  // Encode BOTH the activity and the location in the job so payroll approval
  // knows which quarry tab to auto-inject the approved hours into:
  //   job_id    = "<activity>:<locationId>"   (activity ∈ daily | crushing)
  //   job_label = "Daily — <name>" / "Crushing — <name>"
  // The approve handler in timesheet-entries.js parses job_id back into
  // (activity, locationId) — see parseQuarryJob there.
  const jobs = [];
  for (const r of rows) {
    const name = (r.name || '').trim();
    if (!name || r.id == null) continue;
    jobs.push({ id: `daily:${r.id}`,    label: `Daily — ${name}` });
    jobs.push({ id: `crushing:${r.id}`, label: `Crushing — ${name}` });
  }
  return jobs;
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

// Internal helper exposed for unit testing only (scripts/test-trucking-injection.js).
module.exports._test = { truckingJobs };
