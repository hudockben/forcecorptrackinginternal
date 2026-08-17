'use strict';
/**
 * Identity + lifecycle rules for the Truck Tracking rows payroll injects.
 *
 * Approving a trucking (or dust customer) timesheet entry writes one row into
 * the Trucking division's fct_truck_division blob, mirrored into
 * truck_division_entries. Un-approving or deleting the entry takes it back out.
 * Those rows are payroll-owned end to end: trucking.html renders them with a
 * "← Timesheet" badge and refuses to delete them, because the only correct way
 * to remove one is to un-approve the entry it came from.
 *
 * That contract broke in two places, and the two together let un-approved work
 * come back and stay:
 *
 *   1. The injected row id was stamped with Date.now(), so every re-approval
 *      minted a NEW identity. Intercompany keys its billing entry off that id,
 *      so a row approved, un-approved, corrected and re-approved left an
 *      orphaned billing entry behind pointing at an id nothing owned any more.
 *   2. Nothing removed the Intercompany billing entry when the row went away,
 *      and trucking.html's _recoverEntriesFromIcBilling treats a billing entry
 *      whose truck row is missing as data lost to a blob overwrite — so it
 *      rebuilt the row from the stale entry on the next page load. The row came
 *      back with its original id, undeletable from the tab, and invisible to
 *      the next un-approve once the entry had moved on to a different id.
 *
 * The rules live here rather than in api/timesheet-entries.js because
 * api/truck-division.js needs them too — it sweeps rows that outlived their
 * entry on read, and a second copy of "which rows are payroll's" is exactly the
 * kind of drift that produced the bug.
 */

const TRUCK_DIVISION_BLOB = 'fct_truck_division';

/**
 * The columns the trucking office owns on a row payroll owns.
 *
 * An injected row renders locked in Truck Tracking — every cost field is
 * payroll's — except the invoice sub-row, which stays editable so the office
 * can still manage billing on it. Re-injection therefore has to preserve these
 * and overwrite the rest, or correcting an entry's hours quietly wipes the QB
 * invoice number and the paid date off a row that was already invoiced. Same
 * rule, and the same reason, as EES_OTHER_TAB_FIELDS on the dust side.
 */
const TRUCK_TAB_FIELDS = [
  'qb_invoice', 'invoiced_date', 'invoice_sent_date', 'invoice_status', 'date_paid',
];

// The shared Intercompany billing list, and the tag trucking rows carry in it.
const IC_BILLING_BLOB = 'fct_intercompany_billing_entries';
const IC_SOURCE_TRUCKING = 'trucking';

// The two standing EES activities, as encoded by api/timesheet-jobs.js. A dust
// entry on one of these is EES work and goes to the Dust division's own tab;
// any other dust job is a customer haul and comes to Truck Tracking.
const EES_JOB_IDS = ['ees:preloading', 'ees:washing'];
function isEesJob(jobId) { return EES_JOB_IDS.includes(String(jobId || '')); }

/**
 * True when approving this entry injects a Truck Tracking row.
 *
 * Two divisions route here. Trucking, obviously — its own daily entries have
 * always injected. And dust customer work, because that work IS hauling: a
 * driver takes a truck to a customer for a day, which is the same shape the
 * Truck Tracking tab already records, down to the driver/date/customer/hours
 * columns. Filing it under dust describes who did the work, not where the cost
 * belongs.
 *
 * A dust entry therefore routes by job, and the two dust destinations are
 * disjoint by construction: the standing EES activities go to the Dust
 * division's own "EES Other" tab (isEesJob), every other dust job is a customer
 * haul and comes here. That disjointness is what lets the approve path treat
 * them as an if/else rather than having to order them.
 *
 * A dust entry with no job names no customer, so it injects nowhere and just
 * flips status — the same rule EES already applies. Trucking keeps its old
 * behaviour of injecting regardless, since its rows carry a unit and a
 * description that stand on their own without a customer.
 *
 * Single predicate on purpose: the gate appears at six sites (approve, resplit,
 * un-approve, the edit guard, the read-time sweep, and payroll.html's modal
 * trigger), and a row that outlives its entry is exactly what happens when one
 * of them drifts. The delete sweep deliberately casts wider than this — see the
 * note there.
 */
function needsTruckTrackingRow(entry) {
  if (!entry || entry.entry_type !== 'daily') return false;
  if (entry.division === 'trucking') return true;
  return entry.division === 'dust' && !!entry.job_id && !isEesJob(entry.job_id);
}

// Every row injected from one timesheet entry shares this prefix, so un-approve
// and delete can find them again. Encoded into the row `id` (not a side field)
// because the division tabs drop unknown keys but always preserve `id`.
function truckingRowIdPrefix(entryId) { return `tst-${entryId}-`; }

/**
 * The most legs one day can be split into, in either tab.
 *
 * Defined here because the two halves of a dust haul must agree on it — the
 * Truck Tracking rows and the Dust Control Tracking rows are the same hauls seen
 * from two offices, so a cap either side could accept and the other refuse would
 * post half a split. dust-injected.js re-exports this as MAX_DUST_ROWS.
 *
 * Six is what the timesheet allows a driver to split a day across
 * (MAX_JOB_BLOCKS in timesheet.html); a supervisor breaking the same day down by
 * customer has no reason to need more.
 */
const MAX_INJECTED_LEGS = 6;

/**
 * The canonical id for leg `index` (1-based) of an entry's injected rows.
 *
 * Stable, not stamped with Date.now(): a leg's position in the day is what
 * identifies it, and Intercompany keys its billing entry off this id. A fresh id
 * on every re-injection orphaned that entry — the billing entry outlived the row
 * it described, kept billing the customer, and got read back as a lost row and
 * rebuilt into a duplicate. Re-injecting is now genuinely idempotent: each leg
 * keeps its identity, its place in the table, and its Intercompany history
 * across an un-approve/correct/re-approve cycle. Matches the scheme the dust
 * "EES Other" rows were moved to for the same reason.
 *
 * Leg 1 keeps the historic "-row" suffix rather than becoming "-1", so every row
 * posted before a day could be split keeps the id its billing entry and its
 * invoice history are already filed under.
 */
function truckingRowId(entryId, index = 1) {
  const n = Number(index) || 1;
  return n <= 1 ? `${truckingRowIdPrefix(entryId)}row` : `${truckingRowIdPrefix(entryId)}${n}`;
}

// The timesheet entry a "tst-<entryId>-<suffix>" row came from, or null when the
// id isn't one of ours. Manual rows use UUIDs and "TR-####" task numbers, so the
// prefix cannot collide with one.
function entryIdFromTruckRowId(rowId) {
  const m = /^tst-(\d+)-/.exec(String(rowId || ''));
  return m ? Number(m[1]) : null;
}

function isInjectedTruckRowId(rowId) { return entryIdFromTruckRowId(rowId) != null; }

// Rank competing rows for the same LEG so exactly one survives a sweep: the
// canonical "-row" id wins outright, otherwise the newest Date.now() stamp does
// (the current row is always the last one injected). An unparseable suffix
// sorts below every real candidate.
function truckRowRecency(rowId) {
  const suffix = String(rowId || '').replace(/^tst-\d+-/, '');
  if (suffix === 'row') return Number.MAX_SAFE_INTEGER;
  const n = Number(suffix);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Which leg of the day an injected id names.
 *
 * "-row" is leg 1 and "-2".."-6" are the legs a split day adds. A legacy
 * Date.now()-stamped id is NOT a leg: it is a leftover copy of the pre-split
 * single row, so it answers 1 and goes on competing with the canonical id for
 * that leg — which is what keeps the sweep clearing those out.
 *
 * The two are told apart by magnitude, which is safe because a Date.now() stamp
 * is around 1.7e12 and a leg index never exceeds MAX_INJECTED_LEGS.
 */
function truckRowLegIndex(rowId) {
  const suffix = String(rowId || '').replace(/^tst-\d+-/, '');
  if (suffix === 'row') return 1;
  const n = Number(suffix);
  return (Number.isInteger(n) && n >= 2 && n <= MAX_INJECTED_LEGS) ? n : 1;
}

/**
 * Drop Intercompany billing entries for a set of source rows, from both the
 * shared blob and its normalized mirror. Returns the number removed.
 *
 * Called whenever an injected Truck Tracking row is removed. Without it the
 * billing entry outlives the row: Intercompany keeps invoicing hours that were
 * un-approved, and the trucking page reads the orphan as a row it lost and
 * rebuilds it. Any Intercompany-side invoice/payment dates on the entry go with
 * it — that is the intended trade, since the work it billed for no longer
 * exists. This is the same call the dust "EES Other" reconciler already makes
 * when payroll un-approves one of its rows.
 *
 * One statement, deliberately. Reading the list and writing it back would race
 * every other division doing the same thing against this one shared blob:
 * dust reads [A], we write [A minus ours], dust writes [A,B] — and our removal
 * is silently undone. jsonb_agg rebuilds the array inside the UPDATE, so there
 * is no window. COALESCE(..., false) keeps a non-object element (there should
 * be none, but a malformed blob shouldn't be quietly pruned) from evaluating
 * to NULL and being dropped by the filter.
 */
async function removeIcBillingEntries(sql, companyCode, source, sourceIds) {
  const ids = [...new Set((sourceIds || []).map(v => String(v || '')).filter(Boolean))];
  if (!ids.length) return 0;
  const scoped = `${companyCode}:${IC_BILLING_BLOB}`;

  const rows = await sql`
    WITH hits AS (
      SELECT count(*)::int AS n
        FROM app_data d, jsonb_array_elements(d.value) AS t
       WHERE d.key = ${scoped}
         AND jsonb_typeof(d.value) = 'array'
         AND t->>'source' = ${source}
         AND t->>'source_id' = ANY(${ids}::text[])
    ),
    upd AS (
      UPDATE app_data
         SET value = COALESCE((
               SELECT jsonb_agg(t)
                 FROM jsonb_array_elements(value) AS t
                WHERE NOT COALESCE(
                        t->>'source' = ${source}
                    AND t->>'source_id' = ANY(${ids}::text[]), false)
             ), '[]'::jsonb),
             updated_at = NOW()
       WHERE key = ${scoped}
         AND jsonb_typeof(value) = 'array'
         AND (SELECT n FROM hits) > 0
      RETURNING 1
    )
    SELECT (SELECT n FROM hits) AS removed
  `;
  const removed = rows.length ? Number(rows[0].removed) || 0 : 0;

  // Keep the normalized mirror honest. syncForKey rewrites it wholesale from
  // the blob on the next PUT, but Intercompany reads the table directly, so a
  // row left here bills for work the blob no longer carries.
  await sql`
    DELETE FROM intercompany_billing_entries
     WHERE company_code = ${companyCode}
       AND source = ${source}
       AND source_id = ANY(${ids}::text[])
  `;
  return removed;
}

/**
 * Remove a set of rows from the Truck Tracking blob by id, race-free.
 *
 * Same read-modify-write hazard as above: trucking.html PUTs the whole blob, so
 * a sweep that read the array and wrote it back could undo a row somebody added
 * in between. Filtering inside the UPDATE only ever removes the named ids.
 *
 * Company-scoped key only. The unscoped "fct_truck_division" blob predates
 * company scoping and is shared, so one company's timesheet entries are not
 * grounds to delete rows out of it — a row belonging to another company would
 * read as an entry that doesn't exist. A read served from the legacy blob is
 * still filtered before it reaches the client, and the first save migrates it
 * to the scoped key.
 */
async function deleteTruckBlobRows(sql, companyCode, rowIds) {
  const ids = [...new Set((rowIds || []).map(v => String(v || '')).filter(Boolean))];
  if (!ids.length) return;
  const scoped = `${companyCode}:${TRUCK_DIVISION_BLOB}`;
  await sql`
    UPDATE app_data
       SET value = COALESCE((
             SELECT jsonb_agg(t)
               FROM jsonb_array_elements(value) AS t
              WHERE NOT COALESCE(t->>'id' = ANY(${ids}::text[]), false)
           ), '[]'::jsonb),
           updated_at = NOW()
     WHERE key = ${scoped}
       AND jsonb_typeof(value) = 'array'
  `;
}

/**
 * Decide which injected rows in `entries` no longer have a right to be there.
 *
 * Pure — takes the rows and the timesheet entries they claim to come from, and
 * returns the ids to drop. A row is stale when:
 *   - its entry is gone (payroll deleted it),
 *   - its entry is no longer approved (payroll un-approved it),
 *   - its entry no longer routes to Truck Tracking (it was edited onto a
 *     different division, or a dust entry moved onto an EES job), or
 *   - a newer row for the same LEG of the same entry exists — the duplicate an
 *     old Date.now() id left behind when the entry was re-approved.
 *
 * Competition is per leg, not per entry: a day split across two customers posts
 * one row per haul, and both are live. Legs the split no longer has are pruned
 * by the injection itself, which knows how many it just wrote; this sweep only
 * knows whether the entry still routes here at all, so an entry-level "keep one,
 * drop the rest" rule would delete the second haul's billing on every load of
 * the Truck Tracking tab.
 *
 * Manual rows are never candidates: the sweep only ever looks at ids carrying
 * the "tst-<entryId>-" prefix payroll mints.
 */
function findStaleTruckRows(entries, entriesById) {
  const stale = [];
  const newestByLeg = new Map();

  const injected = (entries || []).filter(r => r && typeof r === 'object' && isInjectedTruckRowId(r.id));
  for (const row of injected) {
    const entryId = entryIdFromTruckRowId(row.id);
    const entry   = entriesById.get(entryId) || null;
    if (!entry || entry.status !== 'approved' || !needsTruckTrackingRow(entry)) {
      stale.push(String(row.id));
      continue;
    }
    const key  = `${entryId}|${truckRowLegIndex(row.id)}`;
    const prev = newestByLeg.get(key);
    if (!prev) { newestByLeg.set(key, row); continue; }
    // Two live rows for one leg: keep the newer, drop the other.
    if (truckRowRecency(row.id) > truckRowRecency(prev.id)) {
      newestByLeg.set(key, row);
      stale.push(String(prev.id));
    } else {
      stale.push(String(row.id));
    }
  }
  return stale;
}

/**
 * Sweep injected rows that outlived their timesheet entry out of `entries`.
 *
 * Self-healing on read, because the alternative is a row nobody can remove: the
 * Truck Tracking tab refuses to delete payroll rows, and payroll can only
 * un-approve an entry that still exists and still owns that id. Rows stranded
 * before the fixes above are only reachable this way.
 *
 * Costs one indexed lookup, and only when the list actually contains injected
 * rows; it writes nothing in the steady state, which is every call after the
 * first. Returns { entries, removed } with `entries` filtered in place of the
 * caller's list — the caller can hand it straight back to the client, so the
 * stale row is gone from the tab on the same load that cleaned it up.
 */
async function sweepInjectedTruckRows(sql, companyCode, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const entryIds = [...new Set(
    list.map(r => (r && typeof r === 'object') ? entryIdFromTruckRowId(r.id) : null)
        .filter(id => id != null)
  )];
  if (!entryIds.length) return { entries: list, removed: [] };

  const rows = await sql`
    SELECT id, status, entry_type, division, job_id
      FROM timesheet_entries
     WHERE company_code = ${companyCode} AND id = ANY(${entryIds}::bigint[])
  `;
  const entriesById = new Map(rows.map(r => [Number(r.id), r]));

  const stale = findStaleTruckRows(list, entriesById);
  if (!stale.length) return { entries: list, removed: [] };

  const staleSet = new Set(stale);
  const remaining = list.filter(r => !(r && typeof r === 'object' && staleSet.has(String(r.id))));

  await deleteTruckBlobRows(sql, companyCode, stale);
  await sql`
    DELETE FROM truck_division_entries
     WHERE company_code = ${companyCode} AND id = ANY(${stale}::text[])
  `;
  // The billing entry has to go with the row, or the trucking page reads it as
  // a lost row and rebuilds exactly what we just swept.
  await removeIcBillingEntries(sql, companyCode, IC_SOURCE_TRUCKING, stale);

  console.warn(`[truck-injected] swept ${stale.length} orphaned injected row(s) for ${companyCode}: ${stale.join(', ')}`);
  return { entries: remaining, removed: stale };
}

module.exports = {
  TRUCK_DIVISION_BLOB,
  TRUCK_TAB_FIELDS,
  IC_BILLING_BLOB,
  IC_SOURCE_TRUCKING,
  EES_JOB_IDS,
  MAX_INJECTED_LEGS,
  isEesJob,
  needsTruckTrackingRow,
  truckingRowIdPrefix,
  truckingRowId,
  entryIdFromTruckRowId,
  isInjectedTruckRowId,
  truckRowRecency,
  truckRowLegIndex,
  removeIcBillingEntries,
  deleteTruckBlobRows,
  findStaleTruckRows,
  sweepInjectedTruckRows,
};
