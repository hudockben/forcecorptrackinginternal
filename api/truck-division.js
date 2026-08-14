'use strict';
/**
 * GET  /api/truck-division  — all entries + lists for the company
 * PUT  /api/truck-division  — full sync: { entries: [...], lists: { drivers, customers, units } }
 *
 * Source of truth: truck_division_entries + truck_division_units + dropdown_lists tables.
 * On first GET, if the normalized tables are empty, migrates from the legacy
 * app_data JSON blobs (fct_truck_division / fct_truck_division_lists).
 *
 * GET also sweeps out payroll-injected rows that outlived their timesheet entry
 * (see lib/truck-injected.js). Those rows are the one kind the tab cannot get
 * rid of on its own — it refuses to delete a payroll row, and payroll can only
 * un-approve an entry that still exists and still owns that row id — so the
 * read path is where a stranded one gets cleaned up.
 */

const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');
const { sweepInjectedTruckRows } = require('./lib/truck-injected');

function safeFloat(v) {
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

function safeDate(v) {
  if (!v) return null;
  // Handle JS Date objects returned by Neon for DATE columns
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // MM/DD/YYYY or M/D/YYYY
  const a = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (a) return `${a[3]}-${a[1].padStart(2,'0')}-${a[2].padStart(2,'0')}`;
  // ISO timestamp (e.g. 2026-04-15T00:00:00.000Z)
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return null;
}

function dbToEntry(r) {
  return {
    id:                r.id,
    task_number:       r.task_number       || '',
    actual_date:       safeDate(r.actual_date) || '',
    driver:            r.driver            || '',
    unit:              r.unit              || '',
    actual_start:      r.actual_start      || '',
    actual_end:        r.actual_end        || '',
    total_hours:       r.total_hours    != null ? String(r.total_hours)    : '',
    haul_fee:          r.haul_fee       != null ? String(r.haul_fee)       : '',
    customer:          r.customer          || '',
    description:       r.description       || '',
    division:          r.division          || '',
    notes:             r.notes             || '',
    qb_invoice:        r.qb_invoice        || '',
    invoiced_date:     safeDate(r.invoiced_date)     || '',
    invoice_sent_date: safeDate(r.invoice_sent_date) || '',
    invoice_status:    r.invoice_status    || 'Unpaid',
    date_paid:         safeDate(r.date_paid)         || '',
  };
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
    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [entryRows, driverRows, customerRows, unitRows] = await Promise.all([
        sql`SELECT * FROM truck_division_entries
            WHERE company_code = ${companyCode} ORDER BY created_at ASC`,
        sql`SELECT value FROM dropdown_lists
            WHERE company_code = ${companyCode} AND list_name = 'truck_drivers'
            ORDER BY sort_order, value`,
        sql`SELECT value FROM dropdown_lists
            WHERE company_code = ${companyCode} AND list_name = 'truck_customers'
            ORDER BY sort_order, value`,
        sql`SELECT name, number FROM truck_division_units
            WHERE company_code = ${companyCode} ORDER BY sort_order, name`,
      ]);

      // Always check the blob so we can detect if normalized tables are stale.
      const [blobE, blobL, blobELegacy, blobLLegacy] = await Promise.all([
        sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_truck_division'}`,
        sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_truck_division_lists'}`,
        sql`SELECT value FROM app_data WHERE key = 'fct_truck_division'`,
        sql`SELECT value FROM app_data WHERE key = 'fct_truck_division_lists'`,
      ]);

      // Pick the best available source (prefer whichever has more entries).
      const scopedEntries  = Array.isArray(blobE[0]?.value) ? blobE[0].value : null;
      const legacyEntries  = Array.isArray(blobELegacy[0]?.value) ? blobELegacy[0].value : null;
      const blobEntries = (scopedEntries && scopedEntries.length > 0)
        ? scopedEntries
        : (legacyEntries || []);

      const scopedLists = (blobL[0]?.value && typeof blobL[0].value === 'object') ? blobL[0].value : null;
      const legacyLists = (blobLLegacy[0]?.value && typeof blobLLegacy[0].value === 'object') ? blobLLegacy[0].value : null;
      const blobLists = scopedLists || legacyLists || { drivers: [], customers: [], units: [] };

      // Prefer blob — PUT writes the blob synchronously so it always reflects the
      // latest save.  The normalized tables are synced fire-and-forget and may lag
      // behind by seconds, causing GET to return stale driver/unit/customer values
      // that then overwrite correct in-memory data on the client.
      const normCount = entryRows.length;
      const blobCount = blobEntries.length;

      if (blobCount > 0) {
        // Drop injected rows whose timesheet entry was un-approved or deleted
        // before returning them, so the tab is clean on the same load that
        // cleaned it up. Non-fatal: a sweep that fails must not take the tab's
        // data with it, so the unfiltered list is served instead.
        let entries = blobEntries;
        try {
          ({ entries } = await sweepInjectedTruckRows(sql, companyCode, blobEntries));
        } catch (err) {
          console.error('[truck-division] injected-row sweep failed:', err.message);
        }
        // Keep normalized tables in sync in background when they're behind.
        if (normCount < entries.length * 0.9) {
          _syncToTables(sql, companyCode, entries, blobLists).catch(err =>
            console.error('[truck-division] re-sync from blob failed:', err.message)
          );
        }
        return res.json({ entries, lists: blobLists });
      }

      // Blob is empty — fall back to normalized tables (first-load / migration path).
      if (normCount > 0 || driverRows.length > 0) {
        let entries = entryRows.map(dbToEntry);
        try {
          ({ entries } = await sweepInjectedTruckRows(sql, companyCode, entries));
        } catch (err) {
          console.error('[truck-division] injected-row sweep failed:', err.message);
        }
        return res.json({
          entries,
          lists: {
            drivers:   driverRows.map(r => r.value),
            customers: customerRows.map(r => r.value),
            units:     unitRows.map(r => ({ name: r.name, number: r.number || '' })),
          },
        });
      }

      return res.json({ entries: [], lists: { drivers: [], customers: [], units: [] } });
    }

    // ── PUT ────────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { entries, lists } = req.body || {};
      if (!Array.isArray(entries)) {
        return res.status(400).json({ error: 'entries array required' });
      }
      const safeLists = lists && typeof lists === 'object'
        ? lists
        : { drivers: [], customers: [], units: [] };

      // Bulk-wipe protection: an empty incoming entries list against an
      // existing non-trivial table is almost always a client bug (race,
      // stale poll, network blip) and would silently destroy the user's
      // truck division data via the blob+normalized writes below.
      // Single-row deletes still work. Override with ?force=1.
      if (entries.length === 0 && req.query.force !== '1') {
        const existing = await sql`
          SELECT value FROM app_data WHERE key = ${companyCode + ':fct_truck_division'}
        `;
        const existingArr = Array.isArray(existing[0]?.value) ? existing[0].value : null;
        if (existingArr && existingArr.length > 1) {
          console.warn(`[truck-division] refused empty PUT: would have wiped ${existingArr.length} entries for ${companyCode}`);
          return res.status(409).json({
            error: 'Refusing to wipe truck division entries',
            detail: `Cannot replace ${existingArr.length} entries with an empty list. Pass ?force=1 to override.`,
          });
        }
      }

      // Write blobs in parallel with the normalized sync so neither blocks the response
      await Promise.all([
        sql`
          INSERT INTO app_data (key, value, updated_at)
          VALUES (${companyCode + ':fct_truck_division'}, ${JSON.stringify(entries)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
        sql`
          INSERT INTO app_data (key, value, updated_at)
          VALUES (${companyCode + ':fct_truck_division_lists'}, ${JSON.stringify(safeLists)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
      ]);

      // Mirror to normalized tables (fire-and-forget)
      _syncToTables(sql, companyCode, entries, safeLists).catch(err =>
        console.error('[truck-division] normalize failed:', err.message)
      );

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[truck-division]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

// ── Sync helpers ────────────────────────────────────────────────────────────

async function _syncToTables(sql, companyCode, entries, lists) {
  await Promise.all([
    _syncEntries(sql, companyCode, entries),
    _syncLists(sql, companyCode, lists),
  ]);
}

async function _syncEntries(sql, companyCode, entries) {
  const ids = entries.map(e => e && e.id).filter(Boolean);

  // Defense in depth: even if an empty list slips past the upstream guard
  // (e.g. during the legacy migration path), refuse to wipe the mirror
  // table. The blob is the source of truth — leaving the mirror intact
  // preserves a recovery option.
  if (ids.length === 0) return;

  await sql`
    DELETE FROM truck_division_entries
    WHERE company_code = ${companyCode} AND id <> ALL(${ids})
  `;

  for (const e of entries) {
    if (!e || !e.id) continue;
    await sql`
      INSERT INTO truck_division_entries (
        id, company_code, task_number, actual_date, driver, unit,
        actual_start, actual_end, total_hours, haul_fee, customer,
        description, division, notes, qb_invoice, invoiced_date,
        invoice_sent_date, invoice_status, date_paid, updated_at
      ) VALUES (
        ${e.id}, ${companyCode},
        ${e.task_number        || null},
        ${safeDate(e.actual_date)},
        ${e.driver             || null},
        ${e.unit               || null},
        ${e.actual_start       || null},
        ${e.actual_end         || null},
        ${safeFloat(e.total_hours)},
        ${safeFloat(e.haul_fee)},
        ${e.customer           || null},
        ${e.description        || null},
        ${e.division           || null},
        ${e.notes              || null},
        ${e.qb_invoice         || null},
        ${safeDate(e.invoiced_date)},
        ${safeDate(e.invoice_sent_date)},
        ${e.invoice_status     || 'Unpaid'},
        ${safeDate(e.date_paid)},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        task_number       = EXCLUDED.task_number,
        actual_date       = EXCLUDED.actual_date,
        driver            = EXCLUDED.driver,
        unit              = EXCLUDED.unit,
        actual_start      = EXCLUDED.actual_start,
        actual_end        = EXCLUDED.actual_end,
        total_hours       = EXCLUDED.total_hours,
        haul_fee          = EXCLUDED.haul_fee,
        customer          = EXCLUDED.customer,
        description       = EXCLUDED.description,
        division          = EXCLUDED.division,
        notes             = EXCLUDED.notes,
        qb_invoice        = EXCLUDED.qb_invoice,
        invoiced_date     = EXCLUDED.invoiced_date,
        invoice_sent_date = EXCLUDED.invoice_sent_date,
        invoice_status    = EXCLUDED.invoice_status,
        date_paid         = EXCLUDED.date_paid,
        updated_at        = NOW()
    `;
  }
}

async function _syncLists(sql, companyCode, lists) {
  const drivers   = Array.isArray(lists.drivers)   ? lists.drivers   : [];
  const customers = Array.isArray(lists.customers) ? lists.customers : [];
  const units     = Array.isArray(lists.units)     ? lists.units     : [];

  // Drivers
  await sql`
    DELETE FROM dropdown_lists
    WHERE company_code = ${companyCode} AND list_name = 'truck_drivers'
  `;
  for (let i = 0; i < drivers.length; i++) {
    if (!drivers[i]) continue;
    await sql`
      INSERT INTO dropdown_lists (company_code, list_name, value, sort_order)
      VALUES (${companyCode}, 'truck_drivers', ${drivers[i]}, ${i})
      ON CONFLICT (company_code, list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order
    `;
  }

  // Customers
  await sql`
    DELETE FROM dropdown_lists
    WHERE company_code = ${companyCode} AND list_name = 'truck_customers'
  `;
  for (let i = 0; i < customers.length; i++) {
    if (!customers[i]) continue;
    await sql`
      INSERT INTO dropdown_lists (company_code, list_name, value, sort_order)
      VALUES (${companyCode}, 'truck_customers', ${customers[i]}, ${i})
      ON CONFLICT (company_code, list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order
    `;
  }

  // Units
  await sql`DELETE FROM truck_division_units WHERE company_code = ${companyCode}`;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!u || !u.name) continue;
    await sql`
      INSERT INTO truck_division_units (company_code, name, number, sort_order)
      VALUES (${companyCode}, ${u.name}, ${u.number || null}, ${i})
      ON CONFLICT (company_code, name) DO UPDATE SET
        number     = EXCLUDED.number,
        sort_order = EXCLUDED.sort_order
    `;
  }
}
