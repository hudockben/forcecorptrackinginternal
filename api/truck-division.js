'use strict';
/**
 * GET  /api/truck-division  — all entries + lists for the company
 * PUT  /api/truck-division  — full sync: { entries: [...], lists: { drivers, customers, units } }
 *
 * `lists` is stored as-is in the blob, so what the page keeps alongside those
 * three rosters — the record of deleted names, the per-customer rates — rides
 * with them. The normalized tables mirror the three the rest of the app reads.
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
const {
  sweepInjectedTruckRows,
  backfillInjectedTaskNumbers,
} = require('./lib/truck-injected');
const { guardInjectedBlobWrite } = require('./lib/injected-blob-guard');

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
    // ── GET ?lists=1 — the dropdown rosters on their own ───────────────────
    // Payroll's approve modal offers the trucking office's own unit names when
    // it asks for a haul's unit, so that a unit typed there is one the office
    // recognises rather than a near-miss its tab cannot match. It needs only the
    // rosters, and the full GET below hands back every tracking row with them —
    // thousands of rows to fill one dropdown. Same data, same reader, less of it.
    //
    // It reads no entries, so it deliberately does not run the orphaned-row
    // sweep the full GET does: there is nothing here for the sweep to correct,
    // and a dropdown being filled is no reason to rewrite the tracking blob.
    if (req.method === 'GET' && req.query.lists === '1') {
      const [blobL, blobLLegacy, driverRows, customerRows, unitRows] = await Promise.all([
        sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_truck_division_lists'}`,
        sql`SELECT value FROM app_data WHERE key = 'fct_truck_division_lists'`,
        sql`SELECT value FROM dropdown_lists
            WHERE company_code = ${companyCode} AND list_name = 'truck_drivers'
            ORDER BY sort_order, value`,
        sql`SELECT value FROM dropdown_lists
            WHERE company_code = ${companyCode} AND list_name = 'truck_customers'
            ORDER BY sort_order, value`,
        sql`SELECT name, number, type FROM truck_division_units
            WHERE company_code = ${companyCode} ORDER BY sort_order, name`,
      ]);

      // Blob first, same as the full GET: the trucking page PUTs it
      // synchronously while the normalized tables are synced fire-and-forget,
      // so a unit added minutes ago is in the blob and may not be in the table
      // yet. Fall back to the tables only when the blob has nothing to say.
      const asObj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
      const fromBlob = asObj(blobL[0]?.value) || asObj(blobLLegacy[0]?.value);
      const arr = v => (Array.isArray(v) ? v : []);
      const blobHasAny = !!fromBlob && (
        arr(fromBlob.units).length || arr(fromBlob.drivers).length || arr(fromBlob.customers).length);

      // What each company is billed per hour, as set in the Trucking tab's
      // Manage Lists. Payroll pre-fills a haul's fee from it, so a day is
      // approved at the rate the office agreed rather than at whatever the
      // approver remembers — the same number the tab itself drops onto a row
      // when you name a customer on it.
      //
      // Read from the blob whatever the rosters came from: rates have no
      // normalized table (dropdown_lists stores a customer as a bare name), so
      // the blob is the only place they exist. Same shape the tab stores and
      // the full GET returns — { 'Kinkead': '121' } — normalized here so a
      // reader never has to guess at a stray space or a non-numeric value.
      const rates = {};
      const rawRates = asObj(fromBlob && fromBlob.rates);
      if (rawRates) {
        for (const key of Object.keys(rawRates)) {
          const name = String(key).trim();
          const val  = String(rawRates[key] == null ? '' : rawRates[key]).trim();
          if (name && val && !isNaN(parseFloat(val))) rates[name] = val;
        }
      }

      return res.json({
        lists: blobHasAny
          ? { drivers: arr(fromBlob.drivers), customers: arr(fromBlob.customers), units: arr(fromBlob.units), rates }
          : {
              drivers:   driverRows.map(r => r.value),
              customers: customerRows.map(r => r.value),
              units:     unitRows.map(r => ({ name: r.name, number: r.number || '', type: r.type || '' })),
              rates,
            },
      });
    }

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
        sql`SELECT name, number, type FROM truck_division_units
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
        // Number any payroll row still carrying a blank Task Number. Rows
        // injected before payroll started minting one are blank in the column
        // the office bills a haul out of, and the tab cannot fill them in
        // itself — its writes against a payroll row are refused. Same
        // self-healing-on-read bargain as the sweep above, and equally
        // non-fatal: a numbering that fails must not take the tab's data with
        // it, so the rows are served as they are.
        try {
          ({ entries } = await backfillInjectedTaskNumbers(sql, companyCode, entries));
        } catch (err) {
          console.error('[truck-division] task-number backfill failed:', err.message);
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
        try {
          ({ entries } = await backfillInjectedTaskNumbers(sql, companyCode, entries));
        } catch (err) {
          console.error('[truck-division] task-number backfill failed:', err.message);
        }
        return res.json({
          entries,
          lists: {
            drivers:   driverRows.map(r => r.value),
            customers: customerRows.map(r => r.value),
            // The type is what sections the dispatch sheet — a unit that comes
            // back without one is a tri-axle filed under Other on every sheet
            // that goes out, so it rides with the name and number.
            units:     unitRows.map(r => ({ name: r.name, number: r.number || '', type: r.type || '' })),
            // The normalized tables hold no record of a name the office
            // deleted, and the page re-seeds its lists from the stored rows —
            // so without carrying this over from the blob, falling back to the
            // tables would quietly undo every deletion. Same for the per-customer
            // rates: the tables store a customer as a bare name.
            removed:   (blobLists && blobLists.removed) || undefined,
            rates:     (blobLists && blobLists.rates)   || undefined,
            // And the same again for the sign-ins the office has said are not
            // drivers: no table records that answer, so dropping it here would
            // put every office login back on the drivers tab as a name to add.
            notDrivers: (blobLists && blobLists.notDrivers) || undefined,
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

      // Payroll owns the rows it injected, on write as well as on read. This
      // page saves the whole list, and the copy it saves was read before any
      // approval that has landed since — so without this a routine cell edit
      // silently deletes work payroll approved seconds earlier, and a stale
      // copy of an un-approved row puts it back. See lib/injected-blob-guard.
      let stored = entries;
      try {
        stored = await guardInjectedBlobWrite(sql, companyCode, 'fct_truck_division', entries);
      } catch (err) {
        // Non-fatal, but say so loudly: this write is unguarded.
        console.error('[truck-division] injected-row write guard failed:', err.message);
      }

      // Write blobs in parallel with the normalized sync so neither blocks the response
      await Promise.all([
        sql`
          INSERT INTO app_data (key, value, updated_at)
          VALUES (${companyCode + ':fct_truck_division'}, ${JSON.stringify(stored)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
        sql`
          INSERT INTO app_data (key, value, updated_at)
          VALUES (${companyCode + ':fct_truck_division_lists'}, ${JSON.stringify(safeLists)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
      ]);

      // Mirror to normalized tables (fire-and-forget). Mirrors what was stored,
      // not what was sent — otherwise the mirror would delete the very payroll
      // rows the guard just kept.
      _syncToTables(sql, companyCode, stored, safeLists).catch(err =>
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
      INSERT INTO truck_division_units (company_code, name, number, type, sort_order)
      VALUES (${companyCode}, ${u.name}, ${u.number || null}, ${u.type || null}, ${i})
      ON CONFLICT (company_code, name) DO UPDATE SET
        number     = EXCLUDED.number,
        type       = EXCLUDED.type,
        sort_order = EXCLUDED.sort_order
    `;
  }
}
