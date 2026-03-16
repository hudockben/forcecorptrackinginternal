'use strict';

const { neon } = require('@neondatabase/serverless');
const jwt      = require('jsonwebtoken');

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

function parseFloatOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

// For columns declared NOT NULL DEFAULT 0 — never sends a null to the DB
function parseFloatOrZero(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const f = parseFloat(v);
  return isNaN(f) ? 0 : f;
}

function dbRowToFrontend(r) {
  const row = {
    id:              r.row_id,
    _projectId:      r.project_id,
    date:            r.date ? String(r.date).slice(0, 10) : '',
    field_type:      r.field_type      || '',
    employee:        r.employee        || '',
    cost_code:       r.cost_code       || '',
    sub_code:        r.sub_code        || '',
    job_class:       r.job_class       || '',
    rate:            r.rate            != null ? String(r.rate)            : '',
    labor_hours:     r.labor_hours     != null ? String(r.labor_hours)     : '',
    equipment:       r.equipment       || '',
    equip_unit_cost: r.equip_unit_cost != null ? String(r.equip_unit_cost) : '',
    equip_hours:     r.equip_hours     != null ? String(r.equip_hours)     : '',
    material:        r.material        || '',
    supplier:        r.supplier        || '',
    po_num:          r.po_num          != null ? String(r.po_num)          : '',
    units_purchased: r.units_purchased != null ? String(r.units_purchased) : '',
    unit_cost:       r.unit_cost       != null ? String(r.unit_cost)       : '',
    material_cost:   r.material_cost   != null ? String(r.material_cost)   : '',
    quantity:        r.quantity        != null ? String(r.quantity)        : '',
  };
  // Optional override fields from CSV import — only include if non-null
  if (r.equip_total_override != null) row.equip_total_override = String(r.equip_total_override);
  if (r.total_cost_override  != null) row.total_cost            = String(r.total_cost_override);
  if (r.num_laborers         != null) row.num_laborers          = String(r.num_laborers);
  return row;
}

async function insertRows(sql, projectId, companyCode, rows) {
  for (const r of rows) {
    await sql`
      INSERT INTO daily_tracking (
        row_id, project_id, company_code,
        date, field_type, employee, cost_code, sub_code, job_class,
        rate, labor_hours, equipment, equip_unit_cost, equip_hours,
        material, supplier, po_num, units_purchased, unit_cost,
        material_cost, quantity,
        equip_total_override, total_cost_override, num_laborers
      ) VALUES (
        ${String(r.id)}, ${projectId}, ${companyCode},
        ${r.date || null}, ${r.field_type || null}, ${r.employee || null},
        ${r.cost_code || null}, ${r.sub_code || null}, ${r.job_class || null},
        ${parseFloatOrZero(r.rate)}, ${parseFloatOrZero(r.labor_hours)},
        ${r.equipment || null}, ${parseFloatOrZero(r.equip_unit_cost)},
        ${parseFloatOrZero(r.equip_hours)}, ${r.material || null},
        ${r.supplier || null}, ${r.po_num || null},
        ${parseFloatOrZero(r.units_purchased)}, ${parseFloatOrZero(r.unit_cost)},
        ${parseFloatOrZero(r.material_cost)}, ${parseFloatOrZero(r.quantity)},
        ${parseFloatOrNull(r.equip_total_override)},
        ${parseFloatOrNull(r.total_cost)},
        ${parseFloatOrNull(r.num_laborers)}
      )
      ON CONFLICT (row_id) DO NOTHING
    `;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized — please log in' });

  const companyCode = payload.companyCode;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET — fetch rows ───────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { projectId } = req.query;
      let rows;
      if (projectId) {
        rows = await sql`
          SELECT * FROM daily_tracking
          WHERE company_code = ${companyCode} AND project_id = ${projectId}
          ORDER BY date ASC NULLS LAST, created_at ASC
        `;
      } else {
        rows = await sql`
          SELECT * FROM daily_tracking
          WHERE company_code = ${companyCode}
          ORDER BY project_id, date ASC NULLS LAST, created_at ASC
        `;
      }
      return res.json({ rows: rows.map(dbRowToFrontend) });
    }

    // ── POST — insert one or many rows ────────────────────────────────────
    if (req.method === 'POST') {
      const { projectId, row, rows } = req.body;
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });

      const toInsert = rows || (row ? [row] : []);
      if (!toInsert.length) return res.status(400).json({ error: 'row or rows required' });

      await insertRows(sql, projectId, companyCode, toInsert);
      return res.json({ ok: true });
    }

    // ── PUT — upsert a single row (insert if missing, update if exists) ──────
    if (req.method === 'PUT') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id query param required' });

      const { row, projectId } = req.body;
      if (!row) return res.status(400).json({ error: 'row required in body' });

      if (projectId) {
        // Upsert: if the original POST failed we still save the row on first edit
        await sql`
          INSERT INTO daily_tracking (
            row_id, project_id, company_code,
            date, field_type, employee, cost_code, sub_code, job_class,
            rate, labor_hours, equipment, equip_unit_cost, equip_hours,
            material, supplier, po_num, units_purchased, unit_cost,
            material_cost, quantity, updated_at
          ) VALUES (
            ${id}, ${projectId}, ${companyCode},
            ${row.date || null}, ${row.field_type || null}, ${row.employee || null},
            ${row.cost_code || null}, ${row.sub_code || null}, ${row.job_class || null},
            ${parseFloatOrZero(row.rate)}, ${parseFloatOrZero(row.labor_hours)},
            ${row.equipment || null}, ${parseFloatOrZero(row.equip_unit_cost)},
            ${parseFloatOrZero(row.equip_hours)}, ${row.material || null},
            ${row.supplier || null}, ${row.po_num || null},
            ${parseFloatOrZero(row.units_purchased)}, ${parseFloatOrZero(row.unit_cost)},
            ${parseFloatOrZero(row.material_cost)}, ${parseFloatOrZero(row.quantity)},
            NOW()
          )
          ON CONFLICT (row_id) DO UPDATE SET
            date            = EXCLUDED.date,
            field_type      = EXCLUDED.field_type,
            employee        = EXCLUDED.employee,
            cost_code       = EXCLUDED.cost_code,
            sub_code        = EXCLUDED.sub_code,
            job_class       = EXCLUDED.job_class,
            rate            = EXCLUDED.rate,
            labor_hours     = EXCLUDED.labor_hours,
            equipment       = EXCLUDED.equipment,
            equip_unit_cost = EXCLUDED.equip_unit_cost,
            equip_hours     = EXCLUDED.equip_hours,
            material        = EXCLUDED.material,
            supplier        = EXCLUDED.supplier,
            po_num          = EXCLUDED.po_num,
            units_purchased = EXCLUDED.units_purchased,
            unit_cost       = EXCLUDED.unit_cost,
            material_cost   = EXCLUDED.material_cost,
            quantity        = EXCLUDED.quantity,
            updated_at      = NOW()
          WHERE daily_tracking.company_code = ${companyCode}
        `;
      } else {
        await sql`
          UPDATE daily_tracking SET
            date            = ${row.date || null},
            field_type      = ${row.field_type || null},
            employee        = ${row.employee || null},
            cost_code       = ${row.cost_code || null},
            sub_code        = ${row.sub_code || null},
            job_class       = ${row.job_class || null},
            rate            = ${parseFloatOrZero(row.rate)},
            labor_hours     = ${parseFloatOrZero(row.labor_hours)},
            equipment       = ${row.equipment || null},
            equip_unit_cost = ${parseFloatOrZero(row.equip_unit_cost)},
            equip_hours     = ${parseFloatOrZero(row.equip_hours)},
            material        = ${row.material || null},
            supplier        = ${row.supplier || null},
            po_num          = ${row.po_num || null},
            units_purchased = ${parseFloatOrZero(row.units_purchased)},
            unit_cost       = ${parseFloatOrZero(row.unit_cost)},
            material_cost   = ${parseFloatOrZero(row.material_cost)},
            quantity        = ${parseFloatOrZero(row.quantity)},
            updated_at      = NOW()
          WHERE row_id = ${id} AND company_code = ${companyCode}
        `;
      }
      return res.json({ ok: true });
    }

    // ── DELETE — by row id, by project, or by cost/sub code ───────────────
    if (req.method === 'DELETE') {
      const { id, projectId, costCode, subCode } = req.query;

      if (id) {
        await sql`
          DELETE FROM daily_tracking
          WHERE row_id = ${id} AND company_code = ${companyCode}
        `;
      } else if (projectId) {
        await sql`
          DELETE FROM daily_tracking
          WHERE project_id = ${projectId} AND company_code = ${companyCode}
        `;
      } else if (costCode !== undefined && subCode !== undefined) {
        await sql`
          DELETE FROM daily_tracking
          WHERE cost_code = ${costCode} AND sub_code = ${subCode}
            AND company_code = ${companyCode}
        `;
      } else {
        return res.status(400).json({ error: 'id, projectId, or costCode+subCode required' });
      }
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[daily-rows] error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
