'use strict';
/**
 * GET  /api/dust-config  — settings + lists for the company
 * PUT  /api/dust-config  — full sync: { settings: { ub_rate }, lists: { equipment, employees, companies, materials, states, mu } }
 *
 * Source of truth: dust_settings, dust_equipment, dust_companies,
 *   dust_company_locations, dust_company_personnel, dropdown_lists tables.
 * On first GET, if the normalized tables are empty, migrates from legacy
 *   app_data JSON blobs (dust_settings / dust_lists).
 */

const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

function safeFloat(v) {
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

// Idempotent guard so ALTER TABLE only runs once per cold-start
let _companyRateColsEnsured = false;
async function ensureCompanyRateColumns(sql) {
  if (_companyRateColsEnsured) return;
  await sql`ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS v1_rate NUMERIC(10,4)`;
  await sql`ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS v2_rate NUMERIC(10,4)`;
  _companyRateColsEnsured = true;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    await ensureCompanyRateColumns(sql);

    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [settingsRows, equipRows, empRows, matRows, stateRows, muRows, coRows] = await Promise.all([
        sql`SELECT ub_rate FROM dust_settings WHERE company_code = ${companyCode}`,
        sql`SELECT * FROM dust_equipment
            WHERE company_code = ${companyCode} ORDER BY sort_order, name`,
        sql`SELECT value FROM dropdown_lists
            WHERE company_code = ${companyCode} AND list_name = 'dust_employees'
            ORDER BY sort_order, value`,
        sql`SELECT value FROM dropdown_lists
            WHERE company_code = ${companyCode} AND list_name = 'dust_materials'
            ORDER BY sort_order, value`,
        sql`SELECT value FROM dropdown_lists
            WHERE company_code = ${companyCode} AND list_name = 'dust_states'
            ORDER BY sort_order, value`,
        sql`SELECT value FROM dropdown_lists
            WHERE company_code = ${companyCode} AND list_name = 'dust_mu'
            ORDER BY sort_order, value`,
        sql`SELECT * FROM dust_companies
            WHERE company_code = ${companyCode} ORDER BY sort_order, name`,
      ]);

      // Always load blobs too so we can detect stale normalized tables.
      // Check both scoped (FORCECORP:dust_settings) and legacy unscoped keys.
      const [blobSettings, blobLists, blobSettingsLegacy, blobListsLegacy] = await Promise.all([
        sql`SELECT value FROM app_data WHERE key = ${companyCode + ':dust_settings'}`,
        sql`SELECT value FROM app_data WHERE key = ${companyCode + ':dust_lists'}`,
        sql`SELECT value FROM app_data WHERE key = 'dust_settings'`,
        sql`SELECT value FROM app_data WHERE key = 'dust_lists'`,
      ]);

      const _asObj = r => (r?.value && typeof r.value === 'object') ? r.value : null;
      const blobSettingsVal = _asObj(blobSettings[0]) || _asObj(blobSettingsLegacy[0]) || { ub_rate: 0 };
      const blobListsRaw    = _asObj(blobLists[0])    || _asObj(blobListsLegacy[0]);
      const blobListsVal    = blobListsRaw || { equipment: [], employees: [], companies: [], materials: [], states: [], mu: [] };

      // Normalized is trustworthy if companies count matches blob companies count.
      const blobCoCount   = (blobListsVal.companies || []).length;
      const normCoCount   = coRows.length;
      const hasNormalized = settingsRows.length > 0 || equipRows.length > 0
        || empRows.length > 0 || coRows.length > 0;
      const normalizedIsTrustworthy = hasNormalized
        && (blobCoCount === 0 || normCoCount >= blobCoCount * 0.9);

      if (normalizedIsTrustworthy) {
        // Load locations + personnel for each company
        const coIds = coRows.map(c => c.id);
        const [locRows, persRows] = coIds.length > 0
          ? await Promise.all([
              sql`SELECT * FROM dust_company_locations WHERE dust_company_id = ANY(${coIds}) ORDER BY sort_order`,
              sql`SELECT * FROM dust_company_personnel WHERE dust_company_id = ANY(${coIds}) ORDER BY sort_order`,
            ])
          : [[], []];

        const companies = coRows.map(co => ({
          id:        co.id,
          name:      co.name,
          tier:      co.tier || '',
          v1_rate:   co.v1_rate != null ? parseFloat(co.v1_rate) : null,
          v2_rate:   co.v2_rate != null ? parseFloat(co.v2_rate) : null,
          locations: locRows
            .filter(l => l.dust_company_id === co.id)
            .map(l => ({ id: l.id, name: l.name, state: l.state || '' })),
          men: persRows
            .filter(p => p.dust_company_id === co.id)
            .map(p => ({ id: p.id, name: p.name })),
        }));

        return res.json({
          settings: {
            ub_rate: parseFloat(settingsRows[0]?.ub_rate) || 0,
            // profit_margin lives only in the settings blob (no normalized
            // column); surface it here so the Profit Margin tab persists.
            profit_margin: blobSettingsVal.profit_margin ?? null,
          },
          lists: {
            equipment: equipRows.map(e => ({
              id:           e.id,
              name:         e.name,
              unit_number:  e.unit_number  || '',
              vehicle_rate: e.vehicle_rate != null ? e.vehicle_rate : null,
            })),
            employees: empRows.map(r => r.value),
            materials: matRows.map(r => r.value),
            states:    stateRows.map(r => r.value),
            mu:        muRows.map(r => r.value),
            companies,
          },
        });
      }

      // Normalized tables are stale or empty — use blobs and re-sync.
      const settings = blobSettingsVal;
      const lists    = blobListsVal;

      if (settings.ub_rate || (lists.equipment || []).length > 0
          || (lists.companies || []).length > 0) {
        _syncToTables(sql, companyCode, settings, lists).catch(err =>
          console.error('[dust-config] initial migration failed:', err.message)
        );
      }

      return res.json({ settings, lists });
    }

    // ── PUT ────────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { settings, lists } = req.body || {};
      const safeSettings = (settings && typeof settings === 'object') ? settings : { ub_rate: 0 };
      const safeLists    = (lists    && typeof lists    === 'object') ? lists    : { equipment: [], employees: [], companies: [], materials: [], states: [], mu: [] };

      // Write blobs in parallel (safety net during migration window)
      await Promise.all([
        sql`
          INSERT INTO app_data (key, value, updated_at)
          VALUES (${companyCode + ':dust_settings'}, ${JSON.stringify(safeSettings)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
        sql`
          INSERT INTO app_data (key, value, updated_at)
          VALUES (${companyCode + ':dust_lists'}, ${JSON.stringify(safeLists)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
      ]);

      await _syncToTables(sql, companyCode, safeSettings, safeLists);

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[dust-config]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

// ── Sync helpers ────────────────────────────────────────────────────────────

async function _syncToTables(sql, companyCode, settings, lists) {
  await Promise.all([
    _syncSettings(sql, companyCode, settings),
    _syncEquipment(sql, companyCode, lists.equipment || []),
    _syncDropdownList(sql, companyCode, 'dust_employees', lists.employees || []),
    _syncDropdownList(sql, companyCode, 'dust_materials', lists.materials || []),
    _syncDropdownList(sql, companyCode, 'dust_states',    lists.states    || []),
    _syncDropdownList(sql, companyCode, 'dust_mu',        lists.mu        || []),
    _syncCompanies(sql, companyCode, lists.companies || []),
  ]);
}

async function _syncSettings(sql, companyCode, settings) {
  const rate = safeFloat(settings.ub_rate) ?? 0;
  await sql`
    INSERT INTO dust_settings (company_code, ub_rate, updated_at)
    VALUES (${companyCode}, ${rate}, NOW())
    ON CONFLICT (company_code) DO UPDATE SET ub_rate = EXCLUDED.ub_rate, updated_at = NOW()
  `;
}

async function _syncEquipment(sql, companyCode, equipment) {
  const ids = equipment.map(e => e && e.id).filter(Boolean);
  // Bulk-wipe protection: refuse to wipe the equipment table when the
  // incoming list is empty but the table has multiple existing rows.
  // Single-item deletes still work (count==1 case proceeds with wipe).
  if (ids.length === 0) {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM dust_equipment WHERE company_code = ${companyCode}
    `;
    if (count > 1) {
      console.warn(`[dust-config] refused empty equipment sync: ${count} rows would have been wiped for ${companyCode}`);
      return;
    }
    await sql`DELETE FROM dust_equipment WHERE company_code = ${companyCode}`;
    return;
  }
  await sql`DELETE FROM dust_equipment WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;
  for (let i = 0; i < equipment.length; i++) {
    const e = equipment[i];
    if (!e || !e.id) continue;
    await sql`
      INSERT INTO dust_equipment (id, company_code, name, unit_number, vehicle_rate, sort_order)
      VALUES (${e.id}, ${companyCode}, ${e.name || ''}, ${e.unit_number || null},
              ${safeFloat(e.vehicle_rate)}, ${i})
      ON CONFLICT (id) DO UPDATE SET
        name         = EXCLUDED.name,
        unit_number  = EXCLUDED.unit_number,
        vehicle_rate = EXCLUDED.vehicle_rate,
        sort_order   = EXCLUDED.sort_order
    `;
  }
}

async function _syncDropdownList(sql, companyCode, listName, values) {
  // Bulk-wipe protection: refuse to wipe a dropdown list when the incoming
  // values are empty but the table has multiple existing entries — almost
  // always indicates a stale-state bug. Single-item deletes still work.
  if (!Array.isArray(values) || values.length === 0) {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM dropdown_lists
      WHERE company_code = ${companyCode} AND list_name = ${listName}
    `;
    if (count > 1) {
      console.warn(`[dust-config] refused empty ${listName} sync: ${count} rows would have been wiped for ${companyCode}`);
      return;
    }
  }
  await sql`
    DELETE FROM dropdown_lists WHERE company_code = ${companyCode} AND list_name = ${listName}
  `;
  for (let i = 0; i < values.length; i++) {
    if (!values[i]) continue;
    await sql`
      INSERT INTO dropdown_lists (company_code, list_name, value, sort_order)
      VALUES (${companyCode}, ${listName}, ${values[i]}, ${i})
      ON CONFLICT (company_code, list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order
    `;
  }
}

async function _syncCompanies(sql, companyCode, companies) {
  const ids = companies.map(c => c && c.id).filter(Boolean);
  // Bulk-wipe protection: refuse to wipe the entire dust_companies table
  // (and its cascading locations + personnel) when the incoming list is
  // empty but multiple companies exist. This is the same class of bug as
  // the row-data wipes — a stale or partial client state would silently
  // destroy all company records along with every well pad and company man.
  if (ids.length === 0) {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM dust_companies WHERE company_code = ${companyCode}
    `;
    if (count > 1) {
      console.warn(`[dust-config] refused empty companies sync: ${count} companies would have been wiped (with cascading locations + personnel) for ${companyCode}`);
      return;
    }
    await sql`DELETE FROM dust_companies WHERE company_code = ${companyCode}`;
    return;
  }
  await sql`DELETE FROM dust_companies WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;

  for (let i = 0; i < companies.length; i++) {
    const co = companies[i];
    if (!co || !co.id) continue;

    await sql`
      INSERT INTO dust_companies (id, company_code, name, tier, v1_rate, v2_rate, sort_order)
      VALUES (${co.id}, ${companyCode}, ${co.name || ''}, ${co.tier || ''},
              ${safeFloat(co.v1_rate)}, ${safeFloat(co.v2_rate)}, ${i})
      ON CONFLICT (id) DO UPDATE SET
        name       = EXCLUDED.name,
        tier       = EXCLUDED.tier,
        v1_rate    = EXCLUDED.v1_rate,
        v2_rate    = EXCLUDED.v2_rate,
        sort_order = EXCLUDED.sort_order
    `;

    // Locations — bulk-wipe protection per company.
    const locIds = (co.locations || []).map(l => l && l.id).filter(Boolean);
    if (locIds.length > 0) {
      await sql`DELETE FROM dust_company_locations WHERE dust_company_id = ${co.id} AND id <> ALL(${locIds})`;
    } else {
      const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count FROM dust_company_locations WHERE dust_company_id = ${co.id}
      `;
      if (count > 1) {
        console.warn(`[dust-config] refused empty locations for company ${co.id}: ${count} would have been wiped`);
      } else if (count === 1) {
        await sql`DELETE FROM dust_company_locations WHERE dust_company_id = ${co.id}`;
      }
    }
    for (let li = 0; li < (co.locations || []).length; li++) {
      const loc = co.locations[li];
      if (!loc || !loc.id) continue;
      await sql`
        INSERT INTO dust_company_locations (id, dust_company_id, name, state, sort_order)
        VALUES (${loc.id}, ${co.id}, ${loc.name || ''}, ${loc.state || null}, ${li})
        ON CONFLICT (id) DO UPDATE SET
          name       = EXCLUDED.name,
          state      = EXCLUDED.state,
          sort_order = EXCLUDED.sort_order
      `;
    }

    // Personnel — bulk-wipe protection per company.
    const persIds = (co.men || []).map(p => p && p.id).filter(Boolean);
    if (persIds.length > 0) {
      await sql`DELETE FROM dust_company_personnel WHERE dust_company_id = ${co.id} AND id <> ALL(${persIds})`;
    } else {
      const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count FROM dust_company_personnel WHERE dust_company_id = ${co.id}
      `;
      if (count > 1) {
        console.warn(`[dust-config] refused empty personnel for company ${co.id}: ${count} would have been wiped`);
      } else if (count === 1) {
        await sql`DELETE FROM dust_company_personnel WHERE dust_company_id = ${co.id}`;
      }
    }
    for (let pi = 0; pi < (co.men || []).length; pi++) {
      const p = co.men[pi];
      if (!p || !p.id) continue;
      await sql`
        INSERT INTO dust_company_personnel (id, dust_company_id, name, sort_order)
        VALUES (${p.id}, ${co.id}, ${p.name || ''}, ${pi})
        ON CONFLICT (id) DO UPDATE SET
          name       = EXCLUDED.name,
          sort_order = EXCLUDED.sort_order
      `;
    }
  }
}
