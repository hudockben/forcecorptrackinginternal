'use strict';
/**
 * Manages simple named string lists stored in the dropdown_lists table.
 * Supported list names: field_types, job_classes, infill_types
 *
 * GET    /api/dropdown-lists              — all lists as { field_types:[], job_classes:[], infill_types:[] }
 * GET    /api/dropdown-lists?name=X       — one list as { name: X, values: [] }
 * PUT    /api/dropdown-lists?name=X       — full replace one list (body: { values: ['a','b',...] })
 * PUT    /api/dropdown-lists              — full replace all lists (body: { field_types:[], job_classes:[], infill_types:[] })
 * POST   /api/dropdown-lists             — add one value (body: { list_name, value })
 * DELETE /api/dropdown-lists?name=X&value=Y — remove one value
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

const ALLOWED = new Set(['field_types', 'job_classes', 'infill_types']);

module.exports = async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { name } = req.query;

      if (name) {
        if (!ALLOWED.has(name)) return res.status(400).json({ error: `Unknown list "${name}"` });
        const rows = await sql`
          SELECT value FROM dropdown_lists
          WHERE company_code = ${companyCode} AND list_name = ${name}
          ORDER BY sort_order ASC, value ASC
        `;
        return res.json({ name, values: rows.map(r => r.value) });
      }

      // Return all lists in one shot
      const rows = await sql`
        SELECT list_name, value FROM dropdown_lists
        WHERE company_code = ${companyCode} AND list_name = ANY(${[...ALLOWED]})
        ORDER BY list_name, sort_order ASC, value ASC
      `;
      const result = { field_types: [], job_classes: [], infill_types: [] };
      for (const row of rows) {
        if (result[row.list_name]) result[row.list_name].push(row.value);
      }
      return res.json(result);
    }

    // ── PUT (full replace) ────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { name } = req.query;
      const body = req.body || {};
      const force = req.query.force === '1';

      // Bulk-wipe protection helper: refuse to wipe a list when the
      // incoming values are empty but the table has multiple existing
      // entries — almost always a stale-state bug. Single-item deletes
      // still work via DELETE /api/dropdown-lists?name=&value=.
      async function _safeReplace(listName, values) {
        if ((!Array.isArray(values) || values.length === 0) && !force) {
          const [{ count }] = await sql`
            SELECT COUNT(*)::int AS count FROM dropdown_lists
            WHERE company_code = ${companyCode} AND list_name = ${listName}
          `;
          if (count > 1) {
            console.warn(`[dropdown-lists] refused empty PUT for ${listName}: ${count} entries would have been wiped for ${companyCode}`);
            return false;
          }
        }
        await sql`DELETE FROM dropdown_lists WHERE company_code = ${companyCode} AND list_name = ${listName}`;
        for (let i = 0; i < values.length; i++) {
          const v = String(values[i]).trim();
          if (!v) continue;
          await sql`
            INSERT INTO dropdown_lists (company_code, list_name, value, sort_order)
            VALUES (${companyCode}, ${listName}, ${v}, ${i})
            ON CONFLICT (company_code, list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order
          `;
        }
        return true;
      }

      if (name) {
        // Replace a single list
        if (!ALLOWED.has(name)) return res.status(400).json({ error: `Unknown list "${name}"` });
        const values = Array.isArray(body.values) ? body.values : [];
        const ok = await _safeReplace(name, values);
        if (!ok) {
          return res.status(409).json({
            error: 'Refusing to wipe dropdown list',
            detail: `Cannot replace "${name}" with an empty list. Use DELETE /api/dropdown-lists?name=&value= for single removals, or pass ?force=1 to override.`,
          });
        }
        return res.json({ ok: true });
      }

      // Replace all allowed lists at once
      const refused = [];
      for (const listName of ALLOWED) {
        const values = Array.isArray(body[listName]) ? body[listName] : [];
        const ok = await _safeReplace(listName, values);
        if (!ok) refused.push(listName);
      }
      if (refused.length > 0) {
        return res.status(409).json({
          error: 'Refusing to wipe one or more dropdown lists',
          detail: `Refused to wipe: ${refused.join(', ')}. Pass ?force=1 to override.`,
        });
      }
      return res.json({ ok: true });
    }

    // ── POST (add one value) ──────────────────────────────────────────────
    if (req.method === 'POST') {
      const { list_name, value } = req.body || {};
      if (!ALLOWED.has(list_name)) return res.status(400).json({ error: `Unknown list "${list_name}"` });
      const v = String(value || '').trim();
      if (!v) return res.status(400).json({ error: 'value required' });

      const [{ max }] = await sql`
        SELECT COALESCE(MAX(sort_order), -1) AS max
        FROM dropdown_lists WHERE company_code = ${companyCode} AND list_name = ${list_name}
      `;
      await sql`
        INSERT INTO dropdown_lists (company_code, list_name, value, sort_order)
        VALUES (${companyCode}, ${list_name}, ${v}, ${max + 1})
        ON CONFLICT (company_code, list_name, value) DO NOTHING
      `;
      return res.status(201).json({ ok: true });
    }

    // ── DELETE (remove one value) ─────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { name, value } = req.query;
      if (!name || !value) return res.status(400).json({ error: 'name and value required' });
      if (!ALLOWED.has(name)) return res.status(400).json({ error: `Unknown list "${name}"` });
      await sql`
        DELETE FROM dropdown_lists
        WHERE company_code = ${companyCode} AND list_name = ${name} AND value = ${value}
      `;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[dropdown-lists]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
