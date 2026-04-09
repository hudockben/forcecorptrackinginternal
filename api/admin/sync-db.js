'use strict';

/**
 * POST /api/admin/sync-db
 * Full resync: reads all JSON blobs from app_data and populates every
 * normalized table (projects, bid_items, employees, equipment_list,
 * suppliers, purchase_orders, po_deliveries, inventory_items).
 *
 * Auth: Bearer JWT (admin or level3)  OR  { adminSecret, companyCode } in body
 *
 * The live write-through in api/data/[key].js keeps tables current on every
 * save. This endpoint is for initial backfill or recovery after an outage.
 */

const { neon } = require('@neondatabase/serverless');
const jwt      = require('jsonwebtoken');
const {
  syncProjects,
  syncLists,
  syncPurchaseOrders,
  syncInventory,
  syncCostRows,
  syncTrucking,
  syncScaleManual,
} = require('../lib/sync-normalized');

function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // Auth: accept JWT or admin secret
  let companyCode;
  const jwtPayload = verifyToken(req);
  if (jwtPayload && ['admin', 'level3'].includes(jwtPayload.role)) {
    companyCode = body.companyCode
      ? String(body.companyCode).toUpperCase()
      : jwtPayload.companyCode;
  } else if (body.adminSecret && body.adminSecret === process.env.ADMIN_SECRET) {
    if (!body.companyCode) return res.status(400).json({ error: 'companyCode required' });
    companyCode = String(body.companyCode).toUpperCase();
  } else {
    return res.status(403).json({ error: 'Forbidden — valid JWT (admin/level3) or adminSecret required' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Load all relevant blobs in one query
    const keys = [
      `${companyCode}:fct_projects`,
      `${companyCode}:fct_projects_index`,
      `${companyCode}:fct_lists`,
      `${companyCode}:fct_purchase_orders`,
      `${companyCode}:fct_inventory`,
      `${companyCode}:fct_cost_rows`,
      `${companyCode}:fct_trucking`,
      `${companyCode}:fct_scale_manual`,
    ];
    const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${keys})`;
    const blobs = {};
    rows.forEach(r => { blobs[r.key] = r.value; });

    // Also pull any per-project blobs stored as fct_project_{id}
    const projectBlobs = await sql`
      SELECT key, value FROM app_data
      WHERE key LIKE ${companyCode + ':fct_project_%'}
        AND key NOT LIKE ${companyCode + ':fct_projects%'}
    `;

    const p = companyCode + ':';

    const projectsValue = blobs[`${p}fct_projects`] || blobs[`${p}fct_projects_index`] || [];
    const s1 = await syncProjects(sql, companyCode, projectsValue);

    let extraProjects = 0, extraBidItems = 0;
    for (const row of projectBlobs) {
      if (!row.value) continue;
      const s = await syncProjects(sql, companyCode, row.value);
      extraProjects += s.projects;
      extraBidItems += s.bid_items;
    }

    const s2 = await syncLists(sql, companyCode, blobs[`${p}fct_lists`] || {});
    const s3 = await syncPurchaseOrders(sql, companyCode, blobs[`${p}fct_purchase_orders`] || []);
    const s4 = await syncInventory(sql, companyCode, blobs[`${p}fct_inventory`] || []);
    const s5 = await syncCostRows(sql, companyCode, blobs[`${p}fct_cost_rows`] || []);
    const s6 = await syncTrucking(sql, companyCode, blobs[`${p}fct_trucking`] || []);
    const s7 = await syncScaleManual(sql, companyCode, blobs[`${p}fct_scale_manual`] || []);

    // Record sync timestamp so auto-sync on login knows it's been done
    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${companyCode + ':fct_last_sync'}, ${JSON.stringify(new Date().toISOString())}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    return res.json({
      ok: true,
      companyCode,
      stats: {
        projects:             s1.projects      + extraProjects,
        bid_items:            s1.bid_items     + extraBidItems,
        employees:            s2.employees,
        equipment:            s2.equipment,
        suppliers:            s2.suppliers,
        purchase_orders:      s3.purchase_orders,
        po_deliveries:        s3.po_deliveries,
        inventory_items:      s4.inventory_items,
        cost_items:           s5.cost_items,
        trucking_entries:     s6.trucking_entries,
        scale_manual_entries: s7.scale_manual_entries,
      },
    });

  } catch (err) {
    console.error('[sync-db] error:', err.message);
    return res.status(500).json({ error: 'Sync failed', detail: err.message });
  }
};
