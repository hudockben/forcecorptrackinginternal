'use strict';
/**
 * PUT /api/bid-items?id=<biId>&projectId=<projId>&projectKey=<key>
 *
 * Upserts a single bid item into both:
 *   1. the project blob in app_data (canonical source of truth for the UI)
 *   2. the normalized bid_items table (mirror for analytics / /api/projects)
 *
 * Payload is the single bid item (~500 bytes) instead of the full project
 * blob (which can exceed the 64KB keepalive cap on large projects with
 * 100+ bid items). This is the safe fast-path for field-level edits
 * (start_date, target_date, qty, unit_cost, etc.) — structural changes
 * (add/remove bid item, project metadata) still go through the existing
 * /api/data/<projectKey> full-blob PUT.
 */
const { neon } = require('@neondatabase/serverless');
const {
  requireAuth,
  hasDivisionAccess,
  divisionForKey,
} = require('./lib/auth');

const STATUS_VALUES = new Set(['Active', 'Complete', 'On Hold', 'At Risk']);

function safeDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return s.length === 10 ? s : null;
}

function safeFloat(v) {
  if (v === null || v === undefined || v === '') return null;
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

// Coerce incoming bid item to DB-safe values. Unknown keys are dropped.
function normalize(bi) {
  return {
    id:            String(bi.id),
    cost_code:     String(bi.cost_code || ''),
    sub_code:      bi.sub_code != null && bi.sub_code !== '' ? String(bi.sub_code) : null,
    description:   bi.description != null && bi.description !== '' ? String(bi.description) : null,
    quantity:      safeFloat(bi.quantity) ?? 0,
    unit:          bi.unit != null && bi.unit !== '' ? String(bi.unit) : null,
    unit_cost:     safeFloat(bi.unit_cost) ?? 0,
    status:        STATUS_VALUES.has(bi.status) ? bi.status : 'Active',
    start_date:    safeDate(bi.start_date),
    target_date:   safeDate(bi.target_date),
    is_complete:   bi.is_complete === true,
    change_orders: Array.isArray(bi.change_orders) ? bi.change_orders : [],
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, projectId, projectKey } = req.query;
  if (!id || !projectId || !projectKey) {
    return res.status(400).json({ error: 'id, projectId, and projectKey query params required' });
  }

  // Only known project blob key shapes are accepted — anything else
  // would let a caller probe arbitrary app_data rows.
  if (!/^fct_(project|paving_project)_[a-zA-Z0-9_-]+$/.test(projectKey)) {
    return res.status(400).json({ error: 'Invalid projectKey' });
  }

  // Division authorization: paving keys require paving access; turf keys
  // (the default) require turf access. Same model as /api/data/[key].js.
  const division = divisionForKey(projectKey) || 'turf';
  if (!hasDivisionAccess(payload, division)) {
    return res.status(403).json({ error: 'You do not have access to this division\'s data' });
  }

  const { bidItem, ts: clientTs } = req.body || {};
  if (!bidItem || typeof bidItem !== 'object' || !bidItem.id) {
    return res.status(400).json({ error: 'bidItem object with id required in body' });
  }
  if (bidItem.id !== id) {
    return res.status(400).json({ error: 'bidItem.id must match the query id' });
  }
  // Use the client's ts (Date.now() at edit time) so the caller's own
  // poll doesn't re-trigger loadProjects on its next 60s tick — the
  // client also updates its local _lastProjIndexTs to this same value.
  const indexTs = Number.isFinite(Number(clientTs)) ? Number(clientTs) : Date.now();

  const item = normalize(bidItem);
  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);
  const scopedProjectKey = `${companyCode}:${projectKey}`;
  const indexKey = projectKey.startsWith('fct_paving_project_')
    ? 'fct_paving_projects_index'
    : 'fct_projects_index';
  const scopedIndexKey = `${companyCode}:${indexKey}`;

  try {
    // 1. Update the project blob's bidItems array. The blob is the
    //    source of truth for the UI's read path, so this must succeed.
    //    jsonb_agg rebuilds the array, replacing the matching item by
    //    id, or appending if it doesn't exist yet (so the endpoint is
    //    safe to call before a structural saveProject has registered
    //    the item server-side).
    const itemJson = JSON.stringify(item);
    const result = await sql`
      UPDATE app_data
      SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            ARRAY['bidItems'],
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM jsonb_array_elements(COALESCE(value->'bidItems', '[]'::jsonb)) AS e
                WHERE e->>'id' = ${id}
              )
              THEN (
                SELECT jsonb_agg(
                  CASE WHEN e->>'id' = ${id} THEN ${itemJson}::jsonb ELSE e END
                )
                FROM jsonb_array_elements(value->'bidItems') AS e
              )
              ELSE COALESCE(value->'bidItems', '[]'::jsonb) || ${itemJson}::jsonb
            END
          ),
          updated_at = NOW()
      WHERE key = ${scopedProjectKey}
      RETURNING 1
    `;
    if (!result.length) {
      return res.status(404).json({ error: 'Project blob not found — create the project first' });
    }

    // 2. Bump the projects-index _ts so other tabs' 60s poll detects
    //    the change. The client passes its Date.now() so its own poll
    //    sees the same value and skips a redundant loadProjects().
    await sql`
      UPDATE app_data
      SET value = jsonb_set(
            COALESCE(value, '{"ids": []}'::jsonb),
            '{_ts}',
            to_jsonb(${indexTs}::bigint)
          ),
          updated_at = NOW()
      WHERE key = ${scopedIndexKey}
    `;

    // 3. Mirror into the normalized bid_items table. Frontend doesn't
    //    read from this directly, but /api/projects and any analytics
    //    queries do. If this fails the blob is still correct and the
    //    next full saveProject will reconcile via syncProjects.
    try {
      await sql`
        INSERT INTO bid_items (
          id, project_id, company_code, cost_code, sub_code, description,
          quantity, unit, unit_cost, status, start_date, target_date,
          is_complete, change_orders, updated_at
        ) VALUES (
          ${item.id}, ${projectId}, ${companyCode},
          ${item.cost_code}, ${item.sub_code}, ${item.description},
          ${item.quantity}, ${item.unit}, ${item.unit_cost},
          ${item.status}, ${item.start_date}, ${item.target_date},
          ${item.is_complete}, ${JSON.stringify(item.change_orders)}::jsonb, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          cost_code     = EXCLUDED.cost_code,
          sub_code      = EXCLUDED.sub_code,
          description   = EXCLUDED.description,
          quantity      = EXCLUDED.quantity,
          unit          = EXCLUDED.unit,
          unit_cost     = EXCLUDED.unit_cost,
          status        = EXCLUDED.status,
          start_date    = EXCLUDED.start_date,
          target_date   = EXCLUDED.target_date,
          is_complete   = EXCLUDED.is_complete,
          change_orders = EXCLUDED.change_orders,
          updated_at    = NOW()
      `;
    } catch (mirrorErr) {
      // Non-fatal — the blob was updated. Log for observability.
      console.warn('[bid-items] normalized mirror failed:', mirrorErr.message);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[bid-items]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
