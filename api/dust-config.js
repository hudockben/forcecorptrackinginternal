'use strict';
/**
 * GET  /api/dust-config  — settings + lists for the company
 * PUT  /api/dust-config  — full sync: { settings: { ub_rate, profit_margin, ub_rate_base },
 *                          lists: { equipment, employees, companies, materials, states, mu, employee_rates, cost_codes } }
 *   Refuses with 409 (writing nothing) a save that would blank the lists or
 *   zero the UB rate over stored values; ?force=1 overrides. Answers
 *   { ok, settings: { ub_rate } } with the rate now in effect.
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

// Merge two scalar dropdown lists, preserving order: normalized values first,
// then any blob-only values appended. Used so a value still present in the
// rewritten-in-full blob isn't lost when the normalized table is trusted.
function _unionValues(primary, extra) {
  const out  = Array.isArray(primary) ? primary.slice() : [];
  const seen = new Set(out.map(v => String(v)));
  (Array.isArray(extra) ? extra : []).forEach(v => {
    if (v == null || v === '') return;
    const k = String(v);
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  });
  return out;
}

// Idempotent guard so ALTER TABLE only runs once per cold-start
let _companyRateColsEnsured = false;
async function ensureCompanyRateColumns(sql) {
  if (_companyRateColsEnsured) return;
  await sql`ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS v1_rate NUMERIC(10,4)`;
  await sql`ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS v2_rate NUMERIC(10,4)`;
  // Optional per-customer UB $/gal override. NULL means "use the global
  // dust_settings.ub_rate"; a value bills that customer at its own rate.
  await sql`ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS ub_rate NUMERIC(10,4)`;
  _companyRateColsEnsured = true;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = await requireAuth(req, res);
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
          ub_rate:   co.ub_rate != null ? parseFloat(co.ub_rate) : null,
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
            // Union the normalized dropdown values with the blob's copy. The
            // blob is rewritten in full on every save, so any value present
            // there but missing from the normalized table (e.g. an employee
            // dropped by a past concurrent-write race) is recovered rather than
            // silently lost. Removals still work: a deleted value is gone from
            // both sources in the same save, so it's absent from the union.
            employees: _unionValues(empRows.map(r => r.value),   blobListsVal.employees),
            materials: _unionValues(matRows.map(r => r.value),   blobListsVal.materials),
            states:    _unionValues(stateRows.map(r => r.value), blobListsVal.states),
            mu:        _unionValues(muRows.map(r => r.value),    blobListsVal.mu),
            companies,
            // Per-employee labor rates live only in the dust_lists blob (no
            // normalized column); surface them from the blob so the Manage
            // Lists rate field and Product Cost auto-fill survive reloads.
            employee_rates: (blobListsRaw && typeof blobListsRaw.employee_rates === 'object'
              && blobListsRaw.employee_rates) || {},
            // Cost codes (with nested sub_codes) also live only in the blob.
            cost_codes: (blobListsRaw && Array.isArray(blobListsRaw.cost_codes)
              && blobListsRaw.cost_codes) || [],
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
      const body  = req.body || {};
      const force = !!req.query && req.query.force === '1';
      // A side the body doesn't carry is left exactly as stored. Both used to
      // default to { ub_rate: 0 } and six empty lists, so a body missing one
      // half silently zeroed or emptied that half.
      const isObj    = v => !!v && typeof v === 'object' && !Array.isArray(v);
      const settings = isObj(body.settings) ? body.settings : null;
      const lists    = isObj(body.lists)    ? body.lists    : null;

      // Read what is stored before writing anything. A page that saves before
      // its config has loaded (or after the load failed) sends its blank
      // starting state: UB rate 0, every list empty. That once replaced both
      // blobs, zeroed dust_settings.ub_rate and lost employee_rates and
      // cost_codes, which live only in the blob; the per-table count > 1
      // guards further down saved the rest, but only for lists of 2 or more.
      // The legacy unscoped blobs are read for the same reason GET reads them:
      // a company still served from them has that data, even if no scoped
      // row exists yet.
      const [blobSettings, blobLists, blobSettingsLegacy, blobListsLegacy, rateRows, countRows, dropdownRows] = await Promise.all([
        sql`SELECT value FROM app_data WHERE key = ${companyCode + ':dust_settings'}`,
        sql`SELECT value FROM app_data WHERE key = ${companyCode + ':dust_lists'}`,
        sql`SELECT value FROM app_data WHERE key = 'dust_settings'`,
        sql`SELECT value FROM app_data WHERE key = 'dust_lists'`,
        sql`SELECT ub_rate FROM dust_settings WHERE company_code = ${companyCode}`,
        sql`SELECT (SELECT COUNT(*)::int FROM dust_equipment WHERE company_code = ${companyCode}) AS equipment,
                   (SELECT COUNT(*)::int FROM dust_companies WHERE company_code = ${companyCode}) AS companies`,
        sql`SELECT list_name, COUNT(*)::int AS count FROM dropdown_lists
            WHERE company_code = ${companyCode}
              AND list_name = ANY(${['dust_employees', 'dust_materials', 'dust_states', 'dust_mu']})
            GROUP BY list_name`,
      ]);
      const _asObj       = r => (r?.value && typeof r.value === 'object') ? r.value : null;
      const prevSettings = _asObj(blobSettings[0]) || _asObj(blobSettingsLegacy[0]) || {};
      const prevLists    = _asObj(blobLists[0])    || _asObj(blobListsLegacy[0])    || {};
      // The rate a reader sees today: the normalized row when there is one,
      // else the blob's copy (GET's own order).
      const storedRate = rateRows.length ? (parseFloat(rateRows[0].ub_rate) || 0)
                                         : (safeFloat(prevSettings.ub_rate) ?? 0);

      const refused = [];
      const emptied = [];

      // The rate this save carries, and ub_rate_base: the rate this tab last
      // got from the server (see the UB rule below). Only a page that loaded
      // its config sends a base, which the list rule also relies on.
      const incomingRate = settings ? safeFloat(settings.ub_rate)      : null;
      const base         = settings ? safeFloat(settings.ub_rate_base) : null;

      // Lists. Stored size is the larger of the blob and the normalized table,
      // because after the blank save the blob itself was empty while the
      // tables still held everything. Arrays are sized after the same null/''
      // filter _syncDropdownList applies; employee_rates by its key count.
      if (lists && !force) {
        const _size  = v => Array.isArray(v) ? v.filter(x => x != null && x !== '').length
                          : isObj(v) ? Object.keys(v).length : 0;
        const _ddCnt = n => (dropdownRows.find(r => r.list_name === n) || {}).count || 0;
        const sizes = [
          ['equipment',      'equipment',      countRows[0].equipment],
          ['companies',      'companies',      countRows[0].companies],
          ['employees',      'employees',      _ddCnt('dust_employees')],
          ['materials',      'materials',      _ddCnt('dust_materials')],
          ['states',         'states',         _ddCnt('dust_states')],
          ['mu',             'MU',             _ddCnt('dust_mu')],
          ['cost_codes',     'cost codes',     0],
          ['employee_rates', 'employee rates', 0],
        ].map(([key, label, normCount]) => ({
          key, label,
          stored:   Math.max(_size(prevLists[key]), normCount),
          incoming: _size(lists[key]),
        }));

        // A save where every list is empty is never a real edit once anything
        // is stored: deleting the last item of one list still sends the
        // others. This also covers lists of exactly 1, which the rule below
        // has to let through so items can still be removed one at a time.
        const blank = sizes.every(s => s.incoming === 0);
        const held  = sizes.filter(s => s.stored > 0);
        // The one exception: the whole config holds a single entry (one state,
        // say, on a company still being set up), and a page that loaded it
        // removes it. Without this that entry could never be deleted, reload
        // or not. The incident's blank save carried no base.
        const lastEntry = base !== null && held.reduce((n, s) => n + s.stored, 0) <= 1;
        const blanked = blank && held.length > 0 && !lastEntry;
        if (blanked) refused.push('blank_lists');
        // Any one list going from several entries to none in a single save is
        // a stale or half-loaded tab, not a user deleting items (2 -> 1 -> 0).
        const wiped = sizes.filter(s => s.stored > 1 && s.incoming === 0);
        wiped.forEach(s => refused.push('empty_' + s.key));
        (blanked ? held : wiped).forEach(s => emptied.push(`${s.label} (${s.stored})`));
      }

      // UB rate. ub_rate_base is the rate this tab last got from the server.
      // Sending it back unchanged means the user didn't touch the rate here,
      // so the stored one stands (another tab may have changed it since). A
      // different value is an edit and is written, including a deliberate 0.
      // A page too old to send a base can't say which, so it can't zero a
      // stored rate. A body with no usable ub_rate at all changes nothing:
      // it once read as 0, so a settings save meant only for the profit
      // margin, sent with a base, zeroed the rate.
      // keepRate: the stored rate stands, and this save writes no rate at all
      // (see the writes below), so a rate another tab saves while this
      // request is running is not put back to the one read above.
      let rate = storedRate;
      let keepRate = true;
      if (settings && incomingRate !== null) {
        if (force)                                    { rate = incomingRate; keepRate = false; }
        else if (base !== null) {
          if (Math.abs(incomingRate - base) >= 1e-9)  { rate = incomingRate; keepRate = false; }
        }
        else if (storedRate > 0 && incomingRate <= 0) refused.push('zero_ub_rate');
        else                                          { rate = incomingRate; keepRate = false; }
      }

      // Refuse the whole save, writing nothing. The detail is shown on the
      // page, so it speaks to the person rather than offering ?force=1. The
      // refused save is often a row edit's: the row itself went to
      // /api/dust-rows and was saved, so the text must not send anyone off to
      // make it again.
      if (refused.length) {
        const parts = [];
        if (emptied.length) parts.push(`emptied ${emptied.join(', ')}`);
        if (refused.includes('zero_ub_rate')) parts.push(`set the UB gallon rate from $${storedRate} to $0`);
        console.warn(`[dust-config] refused PUT for ${companyCode}: ${refused.join(', ')}`);
        return res.status(409).json({
          error:  'Refusing to wipe dust config',
          detail: `The dust settings were not saved: this page's copy of them would have ${parts.join(' and ')}. `
                + 'Tracking rows save separately and are not affected. Reload the page to get the current '
                + 'dust settings, then redo only a change to the UB rate, Manage Lists or the profit margin.',
          refused,
        });
      }

      // ub_rate_base is this request's bookkeeping, not a setting. ub_rate
      // here is only what a record written for the first time gets; the
      // writes below decide what an existing one holds.
      let storeSettings = null;
      if (settings) {
        storeSettings = Object.assign({}, settings, { ub_rate: rate });
        delete storeSettings.ub_rate_base;
      }

      // Write blobs in parallel (safety net during migration window).
      // Settings blob: a kept rate leaves the stored blob's own ub_rate in
      // place (another tab's newer rate stays); a new one is rounded the way
      // dust_settings.ub_rate (NUMERIC(10,4)) rounds it, so the two agree.
      await Promise.all([
        storeSettings && (keepRate
          ? sql`
              INSERT INTO app_data (key, value, updated_at)
              VALUES (${companyCode + ':dust_settings'}, ${JSON.stringify(storeSettings)}::jsonb, NOW())
              ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value || jsonb_build_object('ub_rate',
                          COALESCE(NULLIF(app_data.value->'ub_rate', 'null'::jsonb), EXCLUDED.value->'ub_rate')),
                updated_at = NOW()
            `
          : sql`
              INSERT INTO app_data (key, value, updated_at)
              VALUES (${companyCode + ':dust_settings'},
                      ${JSON.stringify(storeSettings)}::jsonb || jsonb_build_object('ub_rate', round(${rate}::numeric, 4)),
                      NOW())
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            `),
        lists && sql`
          INSERT INTO app_data (key, value, updated_at)
          VALUES (${companyCode + ':dust_lists'}, ${JSON.stringify(lists)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
      ]);

      const savedRate = await _syncToTables(sql, companyCode, storeSettings, lists, keepRate);

      // The page keeps this as its next ub_rate_base: the rate dust_settings
      // holds now, as stored, not the one this request read or sent.
      return res.json({ ok: true, settings: { ub_rate: savedRate ?? storedRate } });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[dust-config]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

// ── Sync helpers ────────────────────────────────────────────────────────────

// Returns the UB rate dust_settings holds afterwards (null when settings was
// not synced).
async function _syncToTables(sql, companyCode, settings, lists, keepRate = false) {
  // A PUT that carried only one side passes null for the other; that side's
  // tables are left as they are.
  const [rate] = await Promise.all([
    settings ? _syncSettings(sql, companyCode, settings, keepRate) : null,
    ...(lists ? [
      _syncEquipment(sql, companyCode, lists.equipment || []),
      _syncDropdownList(sql, companyCode, 'dust_employees', lists.employees || []),
      _syncDropdownList(sql, companyCode, 'dust_materials', lists.materials || []),
      _syncDropdownList(sql, companyCode, 'dust_states',    lists.states    || []),
      _syncDropdownList(sql, companyCode, 'dust_mu',        lists.mu        || []),
      _syncCompanies(sql, companyCode, lists.companies || []),
    ] : []),
  ]);
  return rate;
}

// keepRate: the save did not change the rate, so an existing row keeps the
// rate it holds at the moment of this write, which may be newer than the one
// the PUT read; settings.ub_rate is only used when there is no row yet.
async function _syncSettings(sql, companyCode, settings, keepRate = false) {
  const rate = safeFloat(settings.ub_rate) ?? 0;
  const rows = keepRate
    ? await sql`
        INSERT INTO dust_settings (company_code, ub_rate, updated_at)
        VALUES (${companyCode}, ${rate}, NOW())
        ON CONFLICT (company_code) DO UPDATE SET updated_at = NOW()
        RETURNING ub_rate
      `
    : await sql`
        INSERT INTO dust_settings (company_code, ub_rate, updated_at)
        VALUES (${companyCode}, ${rate}, NOW())
        ON CONFLICT (company_code) DO UPDATE SET ub_rate = EXCLUDED.ub_rate, updated_at = NOW()
        RETURNING ub_rate
      `;
  return rows && rows.length ? (parseFloat(rows[0].ub_rate) || 0) : null;
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
    // dust_equipment has a UNIQUE(company_code, name) constraint, but the upsert
    // below keys ON CONFLICT (id) — so a name held by a *different* id (a
    // duplicate-named vehicle, or a rename that collides) raises a 23505 and
    // aborts the whole config sync. Clear any other row holding this name first
    // so the upsert can't collide; a row that's still wanted is re-inserted by
    // its own loop iteration. (See _syncCompanies for the full rationale.)
    await sql`
      DELETE FROM dust_equipment
      WHERE company_code = ${companyCode} AND name = ${e.name || ''} AND id <> ${e.id}
    `;
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
  const clean = Array.isArray(values) ? values.filter(v => v != null && v !== '') : [];

  // Bulk-wipe protection: refuse to wipe a dropdown list when the incoming
  // values are empty but the table has multiple existing entries — almost
  // always indicates a stale-state bug. Single-item deletes still work.
  if (clean.length === 0) {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM dropdown_lists
      WHERE company_code = ${companyCode} AND list_name = ${listName}
    `;
    if (count > 1) {
      console.warn(`[dust-config] refused empty ${listName} sync: ${count} rows would have been wiped for ${companyCode}`);
      return;
    }
    await sql`DELETE FROM dropdown_lists WHERE company_code = ${companyCode} AND list_name = ${listName}`;
    return;
  }

  // Upsert the incoming values first, then prune only the values no longer
  // present. This avoids the delete-all-then-reinsert gap that a concurrent
  // reader (e.g. the dust page's 60s config poller) could observe as an empty
  // or partial list — which previously caused saved list items to vanish.
  for (let i = 0; i < clean.length; i++) {
    await sql`
      INSERT INTO dropdown_lists (company_code, list_name, value, sort_order)
      VALUES (${companyCode}, ${listName}, ${clean[i]}, ${i})
      ON CONFLICT (company_code, list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order
    `;
  }
  await sql`
    DELETE FROM dropdown_lists
    WHERE company_code = ${companyCode} AND list_name = ${listName}
      AND value <> ALL(${clean})
  `;
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

    // Resolve the UNIQUE(company_code, name) constraint up front. The upsert
    // below only declares ON CONFLICT (id), so it catches primary-key (id)
    // collisions but NOT name collisions. If a *different* row already holds
    // this name — a duplicate-named company, or a rename/swap that lands on
    // another row's name — the INSERT/UPDATE raises a 23505 unique violation.
    // Because callers run the syncs under Promise.all and the PUT writes the
    // JSON blob *before* syncing, that single throw aborts the entire config
    // sync while leaving the normalized tables stale: every company edit (new
    // companies, per-customer UB $/gal, V1/V2 defaults) then silently reverts
    // on the next load, since GET trusts the normalized table. Deleting any
    // other row holding this name first makes the upsert collision-proof. A row
    // that's still wanted keeps its id and is re-inserted by its own iteration;
    // a genuine duplicate name correctly collapses to a single row.
    await sql`
      DELETE FROM dust_companies
      WHERE company_code = ${companyCode} AND name = ${co.name || ''} AND id <> ${co.id}
    `;
    await sql`
      INSERT INTO dust_companies (id, company_code, name, tier, v1_rate, v2_rate, ub_rate, sort_order)
      VALUES (${co.id}, ${companyCode}, ${co.name || ''}, ${co.tier || ''},
              ${safeFloat(co.v1_rate)}, ${safeFloat(co.v2_rate)}, ${safeFloat(co.ub_rate)}, ${i})
      ON CONFLICT (id) DO UPDATE SET
        name       = EXCLUDED.name,
        tier       = EXCLUDED.tier,
        v1_rate    = EXCLUDED.v1_rate,
        v2_rate    = EXCLUDED.v2_rate,
        ub_rate    = EXCLUDED.ub_rate,
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
