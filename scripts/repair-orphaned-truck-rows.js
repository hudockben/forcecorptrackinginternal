#!/usr/bin/env node
'use strict';
/**
 * scripts/repair-orphaned-truck-rows.js
 *
 * Clears Truck Tracking rows that payroll injected but that outlived the
 * timesheet entry they came from.
 *
 * How they happen: approving a trucking (or dust customer) entry appends a row
 * to the fct_truck_division blob with an id of "tst-<entryId>-<suffix>".
 * Un-approving or deleting the entry removes it. Two things let one survive:
 *
 *   - the row id used to be stamped with Date.now(), so re-approving a
 *     corrected entry minted a second identity rather than reusing the first;
 *   - nothing removed the row's Intercompany billing entry, and trucking.html
 *     reads a billing entry with no matching row as a row lost to a blob
 *     overwrite — so it rebuilt the row from the orphan on the next page load.
 *
 * The rebuilt row was then unreachable: the Truck Tracking tab refuses to
 * delete a payroll row, and payroll could only un-approve an entry that still
 * existed and still owned that id. It sat in the tab double-counting hours and,
 * where the customer was enrolled in Intercompany, double-billing them.
 *
 * api/truck-division.js now sweeps these on read, so opening the Trucking tab
 * cleans them up on its own. This script does the same thing out of band —
 * across every company at once, with a dry run first — for auditing what is
 * stranded, or for clearing it without waiting for someone to open the page.
 *
 * For every "tst-" row in a company's truck blob:
 *   - entry exists, is approved, still routes to Truck Tracking, and this is
 *     the only row for that LEG of it   → KEEP
 *   - entry gone / not approved / moved to another division, or a newer row
 *     for the same leg exists → REMOVE, along with its normalized mirror row
 *     and its Intercompany billing entry
 *
 * A day payroll split across customers posts one row per haul, and all of them
 * are legs of the same entry — findStaleTruckRows competes them per leg, so a
 * second haul is never mistaken for a duplicate of the first.
 *
 * Rows the trucking office created (UUIDs, "TR-####" task numbers) are never
 * touched — the sweep only ever looks at the payroll prefix.
 *
 * Usage:
 *   node scripts/repair-orphaned-truck-rows.js                 # dry run
 *   node scripts/repair-orphaned-truck-rows.js --apply         # make changes
 *   node scripts/repair-orphaned-truck-rows.js --company=FCT   # one company
 *
 * Requires DATABASE_URL in environment or a .env file in the project root.
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const {
  TRUCK_DIVISION_BLOB, IC_SOURCE_TRUCKING,
  entryIdFromTruckRowId, findStaleTruckRows,
  deleteTruckBlobRows, removeIcBillingEntries,
} = require('../api/lib/truck-injected');

const apply      = process.argv.includes('--apply');
const companyArg = (process.argv.find(a => a.startsWith('--company=')) || '').split('=')[1] || null;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

const num = v => (v == null || v === '' ? 0 : Number(v) || 0);

function label(row) {
  const total = num(row.total_hours) * num(row.haul_fee);
  return `${row.actual_date || '—'}  ${row.driver || '—'}  ${row.customer || '—'}  ` +
         `${num(row.total_hours)}h × ${num(row.haul_fee)} = $${total.toFixed(2)}  [${row.id}]`;
}

function reasonFor(row, entriesById) {
  const entry = entriesById.get(entryIdFromTruckRowId(row.id));
  if (!entry) return 'timesheet entry deleted';
  if (entry.status !== 'approved') return `entry is ${entry.status}`;
  if (entry.division !== 'trucking' && entry.division !== 'dust') return `entry moved to ${entry.division}`;
  if (entry.entry_type !== 'daily') return `entry is now ${entry.entry_type}`;
  return 'superseded by a newer row for the same entry';
}

(async () => {
  console.log(apply
    ? 'Repairing orphaned Truck Tracking rows…'
    : '[DRY RUN] Scanning for orphaned Truck Tracking rows… (pass --apply to make changes)');

  // Every company's truck blob, keyed "<CO>:fct_truck_division".
  const suffix = ':' + TRUCK_DIVISION_BLOB;
  const blobs = await sql`
    SELECT key, value FROM app_data
     WHERE RIGHT(key, ${suffix.length}) = ${suffix}
       AND jsonb_typeof(value) = 'array'
     ORDER BY key
  `;

  let totalStale = 0;
  for (const blob of blobs) {
    const companyCode = blob.key.slice(0, blob.key.length - suffix.length);
    if (companyArg && companyCode !== companyArg) continue;

    const rows = Array.isArray(blob.value) ? blob.value : [];
    const entryIds = [...new Set(
      rows.map(r => (r && typeof r === 'object') ? entryIdFromTruckRowId(r.id) : null)
          .filter(id => id != null)
    )];
    if (!entryIds.length) continue;

    const entryRows = await sql`
      SELECT id, status, entry_type, division, job_id
        FROM timesheet_entries
       WHERE company_code = ${companyCode} AND id = ANY(${entryIds}::bigint[])
    `;
    const entriesById = new Map(entryRows.map(e => [Number(e.id), e]));

    const stale = findStaleTruckRows(rows, entriesById);
    console.log(`\n${companyCode}: ${rows.length} row(s), ${entryIds.length} payroll-injected entr(ies), ${stale.length} stale.`);
    if (!stale.length) continue;
    totalStale += stale.length;

    const staleSet = new Set(stale);
    for (const row of rows.filter(r => r && staleSet.has(String(r.id)))) {
      console.log(`  REMOVE  ${label(row)}  — ${reasonFor(row, entriesById)}`);
    }

    if (!apply) continue;

    await deleteTruckBlobRows(sql, companyCode, stale);
    await sql`
      DELETE FROM truck_division_entries
       WHERE company_code = ${companyCode} AND id = ANY(${stale}::text[])
    `;
    const billing = await removeIcBillingEntries(sql, companyCode, IC_SOURCE_TRUCKING, stale);
    console.log(`  → removed ${stale.length} row(s) and ${billing} Intercompany billing entr(ies).`);
  }

  if (!totalStale) {
    console.log('\nNothing to do — every injected Truck Tracking row still has an approved entry behind it.');
    return;
  }
  console.log(apply
    ? `\nDone — ${totalStale} row(s) removed.`
    : `\n[DRY RUN] ${totalStale} row(s) would be removed. Re-run with --apply.`);
})().catch(err => {
  console.error('FATAL', err.message);
  process.exit(1);
});
