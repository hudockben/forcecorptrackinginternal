'use strict';
/**
 * GET /api/po-catalog — everything the Purchase Orders division needs to fill
 * in a new order: the divisions it may raise one against, each division's jobs
 * and their cost / sub codes, and the vendor and employee lists merged across
 * all of them.
 *
 * purchase-orders.html could not assemble this for itself. A division page
 * reads its own jobs by pulling a blob index and then a blob per job, and it
 * carries a page of recovery passes for when those disagree — three divisions'
 * worth of that would be thirty-odd round trips before the first order could be
 * typed. More to the point, those blobs hold the whole job: bids, schedules,
 * every daily row. Purchasing needs a job's NAME and its CODES and nothing
 * else, so the reduction happens here and the rest never leaves the server.
 *
 * Read-only, and scoped by canAccessPODivision — the same rule that decides
 * which divisions' purchase orders the caller may write.
 */
const { neon } = require('@neondatabase/serverless');
const {
  requireAuth,
  canAccessPODivision,
  PO_SOURCE_DIVISIONS,
} = require('./lib/auth');

// Blob-key prefixes per division. Jobs live at <prefix>project_<id>, the index
// of live job ids at <prefix>projects_index, and the dropdown lists — vendors
// and employees among them — at <prefix>lists.
const DIVISION_BLOBS = {
  turf:   { prefix: 'fct_',        label: 'Turf Management' },
  paving: { prefix: 'fct_paving_', label: 'Paving' },
  kiewit: { prefix: 'fct_kiewit_', label: 'Kiewit Pinetree' },
};

// A job blob can be large and a division can have many. This caps how many are
// read per division so one company's history cannot turn a page load into a
// multi-megabyte query; the cap is far above any live job count, and a division
// that hit it says so in the response rather than silently listing fewer jobs.
const MAX_PROJECTS_PER_DIVISION = 400;

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/** The id list out of a projects index, which has been stored both ways. */
function idsFromIndex(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value && Array.isArray(value.ids)) return value.ids.filter(Boolean).map(String);
  return [];
}

/**
 * Cost/sub code pairs a job can be charged to, from its bid items — the same
 * source the division tabs' sub-code picker reads, so purchasing offers exactly
 * the codes that division's own screen would.
 */
function codesFromProject(project) {
  const seen = new Set();
  const codes = [];
  for (const bid of asArray(project && project.bidItems)) {
    if (!bid || (!bid.cost_code && !bid.sub_code)) continue;
    const costCode = bid.cost_code || '';
    const subCode  = bid.sub_code  || '';
    const key = costCode + '||' + subCode;
    if (seen.has(key)) continue;
    seen.add(key);
    codes.push({ cost_code: costCode, sub_code: subCode, description: bid.description || '' });
  }
  codes.sort((a, b) =>
    (a.cost_code + a.sub_code).localeCompare(b.cost_code + b.sub_code));
  return codes;
}

/** Vendors as the division tabs store them: objects, but strings historically. */
function vendorName(entry) {
  if (typeof entry === 'string') return entry.trim();
  return entry && entry.name ? String(entry.name).trim() : '';
}

async function readBlobs(sql, companyCode, keys) {
  if (!keys.length) return {};
  const scoped = keys.map(k => `${companyCode}:${k}`);
  const rows = await sql`
    SELECT key, value FROM app_data WHERE key = ANY(${scoped})
  `;
  const out = {};
  for (const row of rows) {
    out[String(row.key).slice(companyCode.length + 1)] = row.value;
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const allowed = PO_SOURCE_DIVISIONS.filter(d => canAccessPODivision(payload, d));
  const sql = neon(process.env.DATABASE_URL);

  try {
    // One query for every division's index and list blob, then one more for the
    // job blobs themselves — two round trips regardless of how many divisions
    // the caller can reach.
    const headKeys = [];
    for (const division of allowed) {
      const { prefix } = DIVISION_BLOBS[division];
      headKeys.push(`${prefix}projects_index`, `${prefix}lists`);
    }
    const heads = await readBlobs(sql, companyCode, headKeys);

    const projectKeys = [];
    const wantedByDivision = {};
    const truncated = [];
    for (const division of allowed) {
      const { prefix } = DIVISION_BLOBS[division];
      // The index is append-ordered, oldest first, so take from the END: the
      // newest jobs are the ones purchasing is most likely to be buying for,
      // and slicing from the front dropped exactly those.
      const all = idsFromIndex(heads[`${prefix}projects_index`]);
      const ids = all.length > MAX_PROJECTS_PER_DIVISION
        ? all.slice(all.length - MAX_PROJECTS_PER_DIVISION)
        : all;
      if (all.length > ids.length) truncated.push({ division, total: all.length });
      wantedByDivision[division] = ids;
      for (const id of ids) projectKeys.push(`${prefix}project_${id}`);
    }
    const projectBlobs = await readBlobs(sql, companyCode, projectKeys);

    // Vendors and employees are merged across every division the caller can
    // reach, de-duplicated case-insensitively: the same supplier is on more
    // than one division's list, spelled slightly differently as often as not.
    const vendorsByKey   = new Map();
    const employeesByKey = new Map();

    const divisions = allowed.map(division => {
      const { prefix, label } = DIVISION_BLOBS[division];

      const lists = heads[`${prefix}lists`] || {};
      for (const entry of asArray(lists.suppliers)) {
        const name = vendorName(entry);
        if (!name) continue;
        const key = name.toLowerCase();
        const existing = vendorsByKey.get(key);
        if (existing) {
          if (!existing.divisions.includes(division)) existing.divisions.push(division);
          continue;
        }
        vendorsByKey.set(key, {
          name,
          state:     (entry && entry.state)   || '',
          phone:     (entry && entry.phone)   || '',
          address:   (entry && entry.address) || '',
          divisions: [division],
        });
      }
      for (const entry of asArray(lists.employees)) {
        const name = vendorName(entry);
        if (!name) continue;
        const key = name.toLowerCase();
        if (!employeesByKey.has(key)) employeesByKey.set(key, { name, divisions: [division] });
        else {
          const e = employeesByKey.get(key);
          if (!e.divisions.includes(division)) e.divisions.push(division);
        }
      }

      const projects = [];
      for (const id of wantedByDivision[division]) {
        const blob = projectBlobs[`${prefix}project_${id}`];
        if (!blob || typeof blob !== 'object') continue;
        projects.push({
          id:        String(blob.id || id),
          name:      blob['project-name'] || 'Untitled',
          jobNumber: blob['job-number']   || '',
          codes:     codesFromProject(blob),
        });
      }
      projects.sort((a, b) => a.name.localeCompare(b.name));

      // What actually reached the picker, which is not the same as what was
      // requested: a job whose blob is missing is counted by neither.
      const cut = truncated.find(t => t.division === division);
      if (cut) cut.shown = projects.length;

      return { division, label, projects };
    });

    const byName = (a, b) => a.name.localeCompare(b.name);
    return res.json({
      divisions,
      vendors:   [...vendorsByKey.values()].sort(byName),
      employees: [...employeesByKey.values()].sort(byName),
      truncated,
    });

  } catch (err) {
    console.error('[po-catalog]', err.message);
    return res.status(500).json({ error: 'Could not load the purchasing catalog', detail: err.message });
  }
};
