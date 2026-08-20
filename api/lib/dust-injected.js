'use strict';
/**
 * Identity + lifecycle rules for the Dust Control Tracking rows payroll injects.
 *
 * A dust customer haul already injects a Truck Tracking row on approval (see
 * truck-injected.js) — that tab records who drove where, and the trucking office
 * reads it. But the money for that haul is billed by the DUST office, off its
 * own Dust Control Tracking tab: vehicle rates times hours, plus UB gallons.
 * Until now that row was retyped by hand from the timesheet the driver had
 * already filled in, which is both the slowest part of the week and the one
 * place the two tabs could quietly disagree about the same day's work.
 *
 * So the same approval now writes BOTH rows, each carrying exactly the columns
 * its own tab has — nothing invented, nothing dropped:
 *
 *   Truck Tracking (unchanged)   driver, date, start/end, hours, customer, unit,
 *                                description, haul fee, division
 *   Dust Control Tracking (new)  date, start/end, company, company man, location,
 *                                state, vehicle 1 + rate, vehicle 2 + rate,
 *                                gallons of UB
 *
 * Date, start/end and company come off the timesheet. The approving supervisor
 * fills in the company man, the location and the gallons; state, the vehicle
 * rates and the escort vehicle follow from the customer the same way they do
 * when the row is typed into the dust tab by hand.
 *
 * One timesheet entry can post MORE THAN ONE of these rows. A driver's day is
 * one clock window on one timesheet, but the dust office bills per haul: ten
 * hours can be 4,000 gallons to one customer's pad and 2,000 to another's, and
 * each of those is its own invoice line with its own hours, gallons and rates.
 * So the approve modal lets the supervisor split the day into legs, and each leg
 * becomes one row here — and one Truck Tracking row beside it, on the same legs,
 * so the two tabs describe the same hauls.
 *
 * Both rows feed Intercompany billing, and they bill on different bases (haul
 * fee x hours over there, vehicle rates + gallons here). Whoever reconciles
 * Intercompany has to pick ONE of them per haul or the customer is invoiced
 * twice — the "⊘ Removed in IC" suppression each tab already supports is how
 * that choice is expressed.
 *
 * The rules live here rather than in api/timesheet-entries.js because
 * api/dust-rows.js needs them too — it sweeps rows that outlived their entry on
 * read and refuses the dust tab's writes against a payroll row — and a second
 * copy of "which rows are payroll's" is exactly the kind of drift that stranded
 * Truck Tracking rows before it.
 */

const { isEesJob, removeIcBillingEntries, MAX_INJECTED_LEGS } = require('./truck-injected');
const { IC_SOURCES } = require('./ic-sources');

// The tag Dust Control Tracking rows carry in the shared Intercompany list.
const IC_SOURCE_DUST = IC_SOURCES.DUST_TRACKING;

/**
 * The columns the dust office owns on a row payroll owns.
 *
 * An injected row renders locked in Dust Control Tracking — every column that
 * comes off the timesheet or out of the approve modal is payroll's — except the
 * invoice sub-row, which stays editable so the office can still bill on it.
 * Re-injection therefore has to preserve these and overwrite the rest, or
 * correcting an entry's hours quietly wipes the invoice number and the paid date
 * off a row that was already invoiced. Same rule, and the same reason, as
 * TRUCK_TAB_FIELDS on the trucking side.
 */
const DUST_TAB_FIELDS = [
  'inv_number', 'inv_sent', 'inv_received', 'inv_status',
  'cm_approval', 'inv_location',
];

/**
 * True when approving this entry injects a Dust Control Tracking row.
 *
 * Deliberately the same shape as needsTruckTrackingRow's dust branch, because it
 * describes the same work: a dust customer haul. A dust entry on one of the two
 * standing EES activities is not customer work and goes to the division's "EES
 * Other" tab instead; a dust entry with no job names no customer, so there is no
 * company to file a tracking row under and it injects nowhere.
 *
 * Single predicate on purpose — the gate appears at seven sites (approve,
 * resplit, un-approve, delete, the edit guard, the read-time sweep, and
 * payroll.html's modal) and a row that outlives its entry is what happens when
 * one of them drifts.
 */
function needsDustTrackingRow(entry) {
  if (!entry || entry.entry_type !== 'daily') return false;
  return entry.division === 'dust' && !!entry.job_id && !isEesJob(entry.job_id);
}

// Every row injected from one timesheet entry shares this prefix, so un-approve
// and delete can find them again. "tsd-" (timesheet → dust) rather than the
// trucking "tst-": the two rows describe the same entry and live in different
// tables, but sharing a prefix would make a sweep written for one of them look
// like it matched the other's rows in any code that ever sees both.
function dustRowIdPrefix(entryId) { return `tsd-${entryId}-`; }

/**
 * The canonical id for leg `index` (1-based) of an entry's injected rows.
 *
 * Stable, not stamped with Date.now(): a leg's position in the day is what
 * identifies it, and Intercompany keys its billing entry off this id. A fresh id
 * on every re-injection would orphan that entry — and dust-rows.js rebuilds a
 * row from an orphaned billing entry (recoverFromIcBilling), so the orphan would
 * come back as a duplicate of the row payroll had just corrected. Re-injecting
 * is idempotent: each leg keeps its identity, its place in the table and its
 * Intercompany history across an un-approve/correct/re-approve cycle.
 *
 * Leg 1 keeps the historic "-row" suffix rather than becoming "-1", so every row
 * posted before the day could be split keeps the id its billing entry, its
 * invoice number and its Intercompany history are already filed under.
 */
function dustRowId(entryId, index = 1) {
  const n = Number(index) || 1;
  return n <= 1 ? `${dustRowIdPrefix(entryId)}row` : `${dustRowIdPrefix(entryId)}${n}`;
}

// The most legs one day can be split into. Taken from truck-injected.js rather
// than restated: the two tabs post the same hauls, so a cap one side accepted
// and the other refused would post half a split.
const MAX_DUST_ROWS = MAX_INJECTED_LEGS;

// The 1-based leg an injected id names, or null when the id names no leg this
// module could have minted — including a number past the cap, which is what a
// Date.now()-stamped leftover looks like. Bounded rather than clamped: a stray
// row must not be read as a real haul, because dustSplitForEntry hands what it
// returns to the approve modal, and anything the modal shows it saves.
function dustRowIndexFromId(rowId) {
  const m = /^tsd-\d+-(row|[1-9]\d*)$/.exec(String(rowId || ''));
  if (!m) return null;
  if (m[1] === 'row') return 1;
  const n = Number(m[1]);
  return (Number.isInteger(n) && n >= 2 && n <= MAX_DUST_ROWS) ? n : null;
}

// The timesheet entry a "tsd-<entryId>-<suffix>" row came from, or null when the
// id isn't one of ours. Manually-added dust rows use uid() — a base-36 timestamp
// with a random tail — so the prefix cannot collide with one.
function entryIdFromDustRowId(rowId) {
  const m = /^tsd-(\d+)-/.exec(String(rowId || ''));
  return m ? Number(m[1]) : null;
}

function isInjectedDustRowId(rowId) { return entryIdFromDustRowId(rowId) != null; }

/**
 * Decide which injected rows in `rows` no longer have a right to be there.
 *
 * Pure — takes the rows and the timesheet entries they claim to come from, and
 * returns the ids to drop. A row is stale when:
 *   - its entry is gone (payroll deleted it),
 *   - its entry is no longer approved (payroll un-approved it),
 *   - its entry no longer routes here (edited onto another division, or moved
 *     onto an EES job), or
 *   - the same id appears twice in the list handed in.
 *
 * Several live rows for ONE entry is normal, not a duplicate: a day split across
 * two customers posts one row per leg. Legs the split no longer has are pruned
 * by the injection itself (it knows how many it just wrote); this sweep only
 * knows whether an entry still routes here at all, so an entry-level "keep one,
 * drop the rest" rule here would delete the second customer's billing every time
 * the dust tab was opened.
 *
 * Manual rows are never candidates: only ids carrying the "tsd-<entryId>-"
 * prefix payroll mints are even looked at.
 */
function findStaleDustRows(rows, entriesById) {
  const stale = [];
  const seen = new Set();

  const injected = (rows || []).filter(r => r && typeof r === 'object' && isInjectedDustRowId(r.id));
  for (const row of injected) {
    const id      = String(row.id);
    const entryId = entryIdFromDustRowId(id);
    const entry   = entriesById.get(entryId) || null;
    if (!entry || entry.status !== 'approved' || !needsDustTrackingRow(entry)) {
      stale.push(id);
      continue;
    }
    // An id carrying our prefix but naming no leg is not a haul: nothing here
    // mints one, so it is a row a failed prune left behind. Sweeping it is the
    // only thing that ever will — the tab refuses to delete payroll's rows, and
    // its entry is alive, so every other test here passes it.
    if (dustRowIndexFromId(id) == null) { stale.push(id); continue; }
    if (seen.has(id)) { stale.push(id); continue; }
    seen.add(id);
  }
  return stale;
}

/**
 * Remove a set of Dust Control Tracking rows by id, along with the Intercompany
 * billing entries they created.
 *
 * The billing sweep is what makes a removal stick. dust-rows.js rebuilds a dust
 * row from a billing entry whose row has gone missing (recoverFromIcBilling,
 * written for blob-overwrite data loss) — so a billing entry left behind by an
 * un-approval resurrects the row on the next page load, under the same id, which
 * the tab then refuses to delete. Any Intercompany-side invoice or payment dates
 * go with it; that is the intended trade, since the work they billed for is no
 * longer approved.
 */
async function deleteDustRows(sql, companyCode, rowIds) {
  const ids = [...new Set((rowIds || []).map(v => String(v || '')).filter(Boolean))];
  if (!ids.length) return 0;
  await sql`
    DELETE FROM dust_control_entries
     WHERE company_code = ${companyCode} AND id = ANY(${ids}::text[])
  `;
  // Non-fatal. Throwing here would fail an un-approve after the row is already
  // gone, and the retry would find nothing to remove and return early — so the
  // billing entry would be stranded by the very error meant to protect it.
  try {
    await removeIcBillingEntries(sql, companyCode, IC_SOURCE_DUST, ids);
  } catch (err) {
    console.error('[dust-injected] removing IC billing entries failed:', err.message);
  }
  return ids.length;
}

/**
 * Sweep injected rows that outlived their timesheet entry out of `rows`.
 *
 * Self-healing on read, because the alternative is a row nobody can remove: the
 * Dust Control Tracking tab refuses to delete payroll rows, and payroll can only
 * un-approve an entry that still exists and still owns that id.
 *
 * Costs one indexed lookup, and only when the list actually contains injected
 * rows; it writes nothing in the steady state, which is every call after the
 * first. Returns { rows, removed } with `rows` filtered — the caller can hand it
 * straight back to the client, so a stale row is gone from the tab on the same
 * load that cleaned it up.
 */
async function sweepInjectedDustRows(sql, companyCode, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const entryIds = [...new Set(
    list.map(r => (r && typeof r === 'object') ? entryIdFromDustRowId(r.id) : null)
        .filter(id => id != null)
  )];
  if (!entryIds.length) return { rows: list, removed: [] };

  const entryRows = await sql`
    SELECT id, status, entry_type, division, job_id
      FROM timesheet_entries
     WHERE company_code = ${companyCode} AND id = ANY(${entryIds}::bigint[])
  `;
  const entriesById = new Map(entryRows.map(r => [Number(r.id), r]));

  const stale = findStaleDustRows(list, entriesById);
  if (!stale.length) return { rows: list, removed: [] };

  const staleSet  = new Set(stale);
  const remaining = list.filter(r => !(r && typeof r === 'object' && staleSet.has(String(r.id))));

  await deleteDustRows(sql, companyCode, stale);
  console.warn(`[dust-injected] swept ${stale.length} orphaned injected row(s) for ${companyCode}: ${stale.join(', ')}`);
  return { rows: remaining, removed: stale };
}

/**
 * Which legs of which entries the dust office bills off THIS grid.
 *
 * Returns a Set of "<entryId>|<leg>" keys, one per injected Dust Control
 * Tracking row that names a leg. Nothing here reads it — it exists for the
 * Truck Tracking sweep, which has to tell a haul billed as UB (no Truck
 * Tracking row any more) from one billed as material (still posts one), and the
 * timesheet entry alone cannot say: the destination lives on the LEG.
 *
 * A row in this grid is the positive evidence that its leg bills here, which is
 * deliberately the safe direction to read it. The absence of one is not
 * evidence of anything — a leg whose rows failed to write, or an entry mid-
 * approval, would otherwise look like grounds to delete a haul's billing.
 *
 * Ids only, so this stays one indexed lookup however many hauls the day had.
 */
async function dustBilledLegs(sql, companyCode, entryIds) {
  const ids = [...new Set((entryIds || []).map(Number).filter(Number.isFinite))];
  const legs = new Set();
  if (!ids.length) return legs;

  const patterns = ids.map(id => `${dustRowIdPrefix(id)}%`);
  const rows = await sql`
    SELECT id FROM dust_control_entries
     WHERE company_code = ${companyCode} AND id LIKE ANY(${patterns}::text[])
  `;
  for (const r of rows) {
    const entryId = entryIdFromDustRowId(r && r.id);
    const leg     = dustRowIndexFromId(r && r.id);
    // An id naming no leg is a leftover this grid's own sweep will clear; it
    // describes no haul, so it cannot speak for one.
    if (entryId != null && leg != null) legs.add(`${entryId}|${leg}`);
  }
  return legs;
}

/**
 * Merge one incoming whole-list write from the dust tab against the server's
 * injected rows. Pure — takes both lists, returns the list to store.
 *
 * The tab PUTs every row it has, and its copy is always the stale one: it was
 * read before the approval that is about to land on top of it. Same race
 * injected-blob-guard.js settles for the blob-backed tabs, and the same rule —
 * a division tab has no authority over a payroll-injected row:
 *   - a row the tab owns  → kept exactly as sent,
 *   - a payroll row the server still has → server's copy, with the invoice
 *     columns (DUST_TAB_FIELDS) replayed from the incoming copy,
 *   - a payroll row the server no longer has → dropped (payroll un-approved it;
 *     the client's copy is stale by definition),
 *   - a payroll row the server has that the write never mentioned → kept (it was
 *     injected after the client read).
 */
function mergeInjectedDustRows(serverRows, incomingRows) {
  const server   = Array.isArray(serverRows) ? serverRows : [];
  const incoming = Array.isArray(incomingRows) ? incomingRows : [];

  const serverById = new Map();
  for (const row of server) {
    if (row && typeof row === 'object' && isInjectedDustRowId(row.id)) {
      serverById.set(String(row.id), row);
    }
  }

  const merged = [];
  const placed = new Set();
  for (const row of incoming) {
    if (!row || typeof row !== 'object' || !isInjectedDustRowId(row.id)) { merged.push(row); continue; }
    const id  = String(row.id);
    const srv = serverById.get(id);
    if (!srv || placed.has(id)) continue;      // withdrawn by payroll, or a duplicate
    const out = { ...srv };
    for (const f of DUST_TAB_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f];
    }
    merged.push(out);
    placed.add(id);
  }
  for (const [id, srv] of serverById) if (!placed.has(id)) merged.push(srv);

  return merged;
}

module.exports = {
  IC_SOURCE_DUST,
  DUST_TAB_FIELDS,
  MAX_DUST_ROWS,
  needsDustTrackingRow,
  dustRowIdPrefix,
  dustRowId,
  dustRowIndexFromId,
  entryIdFromDustRowId,
  isInjectedDustRowId,
  findStaleDustRows,
  dustBilledLegs,
  deleteDustRows,
  sweepInjectedDustRows,
  mergeInjectedDustRows,
};
