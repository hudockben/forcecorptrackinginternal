'use strict';
/**
 * GET    /api/equipment         — every machine in the company, as one list:
 *                                  the equipment_list table unioned with the
 *                                  paving and kiewit list blobs, which nothing
 *                                  syncs into it. See api/lib/equipment.js.
 * PUT    /api/equipment         — full replace: sync entire equipment array
 * POST   /api/equipment         — create a single equipment item
 * DELETE /api/equipment?id=N    — hard-delete one item by id
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');
const { readEquipmentRoster } = require('./lib/equipment');

module.exports = async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // The union of every equipment list in the company, deduplicated by name
      // — see api/lib/equipment.js. The table alone is turf's list and nothing
      // else, because only `fct_lists` is routed to sync-normalized.js, so a
      // paving or kiewit machine was never in it and never reached the
      // Timesheet picker that asks which one he ran.
      const merged = await readEquipmentRoster(sql, companyCode);
      return res.json({ equipment: merged });
    }

    // ── PUT (full replace) ────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { equipment } = req.body || {};
      if (!Array.isArray(equipment)) return res.status(400).json({ error: 'equipment array required' });

      const incoming = equipment
        .map((e, i) => ({ ...e, _i: i }))
        .filter(e => e.name?.trim());
      const incomingNames = new Set(incoming.map(e => e.name.trim()));

      // Bulk-wipe protection: refuse to wipe the equipment list on an empty
      // PUT against a non-trivial table. Single-item deletes still work via
      // DELETE /api/equipment?id=.
      const existing = await sql`SELECT name FROM equipment_list WHERE company_code = ${companyCode}`;
      if (incoming.length === 0 && existing.length > 1 && req.query.force !== '1') {
        console.warn(`[equipment] refused empty PUT: ${existing.length} items would have been wiped for ${companyCode}`);
        return res.status(409).json({
          error: 'Refusing to wipe equipment',
          detail: `Cannot replace ${existing.length} items with an empty list. Use DELETE /api/equipment?id= for single removals, or pass ?force=1 to override.`,
        });
      }

      // Remove deleted items
      for (const { name } of existing) {
        if (!incomingNames.has(name)) {
          await sql`DELETE FROM equipment_list WHERE company_code = ${companyCode} AND name = ${name}`;
        }
      }

      // Upsert each item
      for (const e of incoming) {
        const unitCost = parseFloat(e.unit_cost) || 0;
        await sql`
          INSERT INTO equipment_list (company_code, name, unit_cost, sort_order, active, updated_at)
          VALUES (${companyCode}, ${e.name.trim()}, ${unitCost}, ${e._i}, TRUE, NOW())
          ON CONFLICT (company_code, name) WHERE company_code IS NOT NULL DO UPDATE SET
            unit_cost  = EXCLUDED.unit_cost,
            sort_order = EXCLUDED.sort_order,
            active     = TRUE,
            updated_at = NOW()
        `;
      }
      return res.json({ ok: true });
    }

    // ── POST (single create) ──────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, unit_cost } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ error: 'name required' });
      const cost = parseFloat(unit_cost) || 0;

      const [row] = await sql`
        INSERT INTO equipment_list (company_code, name, unit_cost, sort_order, active, updated_at)
        VALUES (
          ${companyCode}, ${name.trim()}, ${cost},
          (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM equipment_list WHERE company_code = ${companyCode}),
          TRUE, NOW()
        )
        ON CONFLICT (company_code, name) WHERE company_code IS NOT NULL DO UPDATE SET
          unit_cost  = EXCLUDED.unit_cost,
          active     = TRUE,
          updated_at = NOW()
        RETURNING id, name, unit_cost, sort_order
      `;
      return res.status(201).json({ item: row });
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM equipment_list WHERE id = ${id} AND company_code = ${companyCode}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[equipment]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
