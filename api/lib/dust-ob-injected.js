'use strict';
/**
 * Identity + lifecycle rules for the Dust "Other Billing" rows payroll injects.
 *
 * A dust customer haul is not always dust. The same driver, the same truck and
 * the same clock window can be 4,000 gallons of UB on a well pad — which the
 * dust office bills off Dust Control Tracking, vehicle rates times hours — or a
 * delivery of material to that same customer, which it bills off Other Billing,
 * quantity times price per unit plus trucking hours times a trucking rate. Two
 * different invoices for two different kinds of work, and until now only the
 * first of them was ever posted from a timesheet: an approved material haul
 * landed in Dust Control Tracking with the UB shape, and the office re-typed it
 * by hand into Other Billing from the timesheet the driver had already filled
 * in — the same retyping that injecting the tracking row was written to end.
 *
 * So the destination is now a property of the HAUL, not of the entry. The
 * approve modal asks it per leg, and each leg posts exactly one billing row, in
 * whichever of the two dust tabs its answer names:
 *
 *   Dust Control Tracking   company man, pad, state, vehicle 1 + rate,
 *                           vehicle 2 + rate, gallons of UB
 *   Other Billing (here)    driver, truck #, trailer #, destination, state,
 *                           material, gallons/bags, MU, price per unit,
 *                           trucking hours + rate
 *
 * The answer also decides whether the haul reaches Truck Tracking. A haul that
 * lands here does: this grid prices the material, and the hauling of it is the
 * trucking office's line, billed at trucking hours times a trucking rate. A
 * haul billed off Dust Control Tracking does not — that grid covers the work
 * end to end. So a material haul, and only a material haul, still feeds
 * Intercompany from two sides, and whoever reconciles it picks one: the
 * "⊘ Removed in IC" suppression both tabs support is how that choice is
 * expressed. A UB haul has no trucking-side counterpart left to suppress.
 *
 * Other Billing is a JSON blob (dust_other_billing_rows) rather than a table,
 * so the mechanics here are the trucking blob's rather than dust tracking's:
 * every removal filters inside the UPDATE, and the whole-list write the tab
 * performs is merged against the server's copy by injected-blob-guard.js. The
 * rules live in their own module for the reason dust-injected.js gives — the
 * blob endpoint sweeps rows that outlived their entry on read, and a second
 * copy of "which rows are payroll's" is exactly the drift that stranded rows
 * before it.
 */

const { removeIcBillingEntries, MAX_INJECTED_LEGS, splitSentTo } = require('./truck-injected');
const { needsDustTrackingRow } = require('./dust-injected');
const { IC_SOURCES } = require('./ic-sources');

// The blob the Other Billing grid is stored in, and the tag its rows carry in
// the shared Intercompany list.
const OB_BLOB_KEY  = 'dust_other_billing_rows';
const IC_SOURCE_OB = IC_SOURCES.DUST_OTHER_BILLING;

/* ── The manual price override ─────────────────────────────────────────────
 *
 * The price a delivery bills at belongs to payroll: the approve modal asks for
 * it per leg, and every column of an injected row is rewritten from the
 * timesheet entry. That is the right owner and it stays the right owner — but
 * it was also the ONLY way to price one, and Other Billing is the tab where an
 * unpriced delivery is noticed, because it is the tab the invoice comes out of.
 * A haul approved with no price — nobody typed one in the modal, and the
 * material has no rate standing behind it — lands here at nothing: it invoices
 * the customer for the trucking alone, and the gallons go out free. Fixing it
 * meant finding the entry in Payroll, un-approving it, re-approving it with a
 * price, and hoping nothing else on the day had moved in between.
 *
 * So the price gets a manual override: the office types one in the tab, and it
 * is kept BESIDE payroll's number rather than on top of it. Same shape, and the
 * same reasoning, as the backup haul fee in truck-injected.js.
 *
 *   price_per_unit_override — what the office typed here. The tab may write it
 *                             (it is on OB_TAB_FIELDS), so it survives both a
 *                             whole-blob save and a re-approval.
 *   price_per_unit_payroll  — payroll's own figure, kept only while an override
 *                             is standing, so the tab can show what it is
 *                             disagreeing with and hand the row back with one
 *                             click.
 *   price_per_unit          — DERIVED: the override when one stands, payroll's
 *                             number otherwise.
 *
 * Deriving into price_per_unit is the point. Everything that prices a delivery
 * reads that one column — the tab's own material total, the home dashboard's
 * unpriced tally, dust-metrics, Intercompany billing and the mirror table it
 * syncs into, the audit log's diff, and payroll's own Edit Row — and an
 * override each of them had to know about separately is an override some of
 * them would miss, which is a row billing one figure and reported at another.
 * They keep reading one column; this decides what is in it, at both of the two
 * writers (a tab save through injected-blob-guard, and re-injection in
 * api/timesheet-entries.js).
 *
 * Payroll is never locked out. It goes on rewriting price_per_unit from the
 * entry, and if it comes back with a different number the override still stands
 * — the office set it deliberately, and a price somebody has invoiced under
 * must not change because an unrelated correction was made upstream — but the
 * tab says so, and clearing the box takes payroll's figure back. An override
 * that agrees with payroll is dropped rather than kept: there is nothing to
 * override, and a receipt left behind would go on shadowing a column it no
 * longer changes.
 *
 * Which is also how a disagreement ends on its own. Payroll's Edit Row fills
 * its Price per Gal/Bag box from the posted row (obSplitForEntry feeds it), so
 * it shows the price the delivery is actually billing at — the office's, when
 * one stands. Saving it puts that same number on the entry, the override now
 * agrees with payroll, and it is dropped: payroll has adopted the figure, and
 * the row goes back to having one owner.
 */
const OB_PRICE_OVERRIDE = 'price_per_unit_override';
const OB_PRICE_PAYROLL  = 'price_per_unit_payroll';

// The ceiling on a price, wherever one is read. DUST_NUMERIC_MAX in
// api/timesheet-entries.js, restated: price_per_unit is NUMERIC(10,4) both
// where payroll validates it and in the Intercompany mirror this row's billing
// syncs into (api/lib/sync-normalized.js), so a ceiling any wider than this
// does not reject a fat-fingered figure — it accepts one Postgres then refuses
// with a 22003 overflow, on a sync nobody was watching.
const OB_PRICE_MAX = 999999.9999;

/**
 * Read a price the way every writer must read one: `{ value }` with a number,
 * `{ value: '' }` for "nobody has set one", or `{ error }`.
 *
 * Trimmed before Number(), because Number(' ') is 0 — a whitespace-only box
 * would otherwise store as a deliberate $0.00/gal, which reads to the office as
 * material given away on purpose rather than as a delivery nobody has priced.
 * 0 typed on purpose is a legitimate price and passes.
 */
function normalizeObPrice(v) {
  if (v == null || String(v).trim() === '') return { value: '' };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > OB_PRICE_MAX) {
    return { error: `price_per_unit must be a number between 0 and ${OB_PRICE_MAX}` };
  }
  return { value: Math.round(n * 10000) / 10000 };
}

// Two prices are the same price when they are the same number. String vs number
// is how the same figure arrives from a JSON blob ('1.42') and from payroll
// (1.42), so comparing them raw would read every override as a disagreement.
function sameObPrice(a, b) {
  const x = normalizeObPrice(a), y = normalizeObPrice(b);
  if (x.error || y.error) return false;
  return x.value === y.value;
}

/**
 * Settle `price_per_unit` on one injected row from the override standing
 * against it. Mutates and returns the row — the two callers each have a row in
 * hand they are about to store.
 *
 * Payroll's figure is whatever the row carries before this runs, EXCEPT when a
 * previous pass already moved it aside: price_per_unit_payroll is the price
 * this row would bill with no override, wherever it is present. That
 * distinction is what makes the function idempotent, and it is why the guard
 * can run it on a row it just took from the database.
 *
 * A junk override — negative, non-numeric, past the ceiling — is dropped
 * rather than honoured. It cannot arrive from the tab, which validates before
 * it saves, so it means a hand-edited blob or an older client, and inventing a
 * price from it is the one outcome worse than ignoring it.
 */
function applyObPriceOverride(row) {
  if (!row || typeof row !== 'object') return row;

  const payroll = Object.prototype.hasOwnProperty.call(row, OB_PRICE_PAYROLL)
    ? row[OB_PRICE_PAYROLL]
    : row.price_per_unit;
  const { value, error } = normalizeObPrice(row[OB_PRICE_OVERRIDE]);

  // Nothing standing: no override, one this cannot read, or one that agrees
  // with payroll anyway. The row bills payroll's number and carries no receipt.
  if (error || value === '' || sameObPrice(value, payroll)) {
    delete row[OB_PRICE_OVERRIDE];
    delete row[OB_PRICE_PAYROLL];
    row.price_per_unit = payroll == null ? '' : payroll;
    return row;
  }

  row[OB_PRICE_OVERRIDE] = value;
  row[OB_PRICE_PAYROLL]  = payroll == null ? '' : payroll;
  row.price_per_unit     = value;
  return row;
}

/**
 * The columns the dust office owns on a row payroll owns.
 *
 * Everything else on an injected row renders locked in the tab — it came off
 * the timesheet or out of the approve modal, and payroll is where it is
 * corrected. These are the office's: the invoice number it bills under, the
 * note it writes against that invoice, and the backup price (see "The manual
 * price override" above). Re-injection preserves them and overwrites the rest,
 * or correcting a haul's hours quietly wipes the invoice number off a row that
 * was already sent. Same rule, and the same reason, as DUST_TAB_FIELDS on the
 * tracking side and TRUCK_TAB_FIELDS on the trucking one.
 *
 * `comments` is seeded from the driver's notes on a first injection and then
 * belongs to the office — see insertObRows.
 *
 * The override, not price_per_unit itself: a tab that could write the price
 * outright would also freeze payroll out of it, because this list is what
 * re-injection PRESERVES — a price on it could never be corrected from the
 * timesheet again.
 */
const OB_TAB_FIELDS = ['inv_number', 'comments', OB_PRICE_OVERRIDE];

/**
 * True when this entry can post Other Billing rows at all.
 *
 * Deliberately identical to needsDustTrackingRow: the two tabs take the same
 * work, and which of them a given haul lands in is answered per LEG in the
 * approve modal rather than by anything on the entry. So this is the gate for
 * "could this entry have rows here" — it is what un-approve, delete and the
 * read-time sweep ask — while the per-leg `dest` decides where each haul goes.
 *
 * A dust entry on a standing EES activity is not customer work and goes to the
 * division's "EES Other" tab; a dust entry with no job names no customer, so
 * there is nobody to bill and it injects nowhere.
 */
function needsObRow(entry) { return needsDustTrackingRow(entry); }

// Every row injected from one timesheet entry shares this prefix, so un-approve
// and delete can find them again. "tso-" (timesheet → other billing) rather
// than the tracking side's "tsd-": the two describe the same day's hauls and a
// shared prefix would make a sweep written for one look like it matched the
// other's rows in any code that ever sees both.
function obRowIdPrefix(entryId) { return `tso-${entryId}-`; }

/**
 * The canonical id for leg `index` (1-based) of an entry's injected rows.
 *
 * The index is the leg's position in the WHOLE day, not its position among the
 * hauls that came here. A day whose second of three hauls was material and
 * whose first and third were UB posts tso-<id>-2 beside tsd-<id>-row and
 * tsd-<id>-3, and re-pointing that middle haul at UB is then a plain
 * delete-one/insert-one on stable ids rather than a renumbering of everything
 * after it. Positional identity across the day is what makes the destination
 * toggle safe to change on a re-edit.
 *
 * Stable, not stamped with Date.now(), for the reason dustRowId gives:
 * Intercompany keys its billing entry off this id, and a fresh id on every
 * re-injection would orphan that entry along with any invoice or payment dates
 * recorded against it.
 *
 * Leg 1 is "-1" rather than the tracking side's historic "-row". That suffix
 * exists there to keep faith with rows posted before a day could be split;
 * nothing has ever been posted under this prefix, so there is no history to
 * keep and no special case to carry.
 */
function obRowId(entryId, index = 1) {
  const n = Number(index) || 1;
  return `${obRowIdPrefix(entryId)}${n}`;
}

// The most legs one day can be split into. Taken from truck-injected.js rather
// than restated: every leg posts a Truck Tracking row too, so a cap one side
// accepted and the other refused would post half a split.
const MAX_OB_ROWS = MAX_INJECTED_LEGS;

// The 1-based leg an injected id names, or null when the id names no leg this
// module could have minted — including a number past the cap. Bounded rather
// than clamped: a stray row must not be read as a real haul, because
// obSplitForEntry hands what it returns to the approve modal, and anything the
// modal shows it saves.
function obRowIndexFromId(rowId) {
  const m = /^tso-\d+-([1-9]\d*)$/.exec(String(rowId || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return (Number.isInteger(n) && n >= 1 && n <= MAX_OB_ROWS) ? n : null;
}

// The timesheet entry a "tso-<entryId>-<leg>" row came from, or null when the id
// isn't one of ours. Rows added by hand in the tab use uid() — a base-36
// timestamp with a random tail — so the prefix cannot collide with one.
function entryIdFromObRowId(rowId) {
  const m = /^tso-(\d+)-/.exec(String(rowId || ''));
  return m ? Number(m[1]) : null;
}

function isInjectedObRowId(rowId) { return entryIdFromObRowId(rowId) != null; }

function isInjectedObRow(row) {
  return !!row && typeof row === 'object' && isInjectedObRowId(row.id);
}

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
 * Several live rows for ONE entry is normal, not a duplicate: a day split
 * across two material deliveries posts one row per leg. Legs the split no
 * longer has — including a leg the approver re-pointed at Dust Control Tracking
 * — are pruned by the injection itself, which knows which legs it just wrote.
 * This sweep only knows whether an entry still routes here at all, so an
 * entry-level "keep one, drop the rest" rule would delete the second delivery's
 * billing every time the tab was opened.
 *
 * Rows added by hand are never candidates: only ids carrying the
 * "tso-<entryId>-" prefix payroll mints are even looked at.
 */
function findStaleObRows(rows, entriesById) {
  const stale = [];
  const seen  = new Set();

  for (const row of (rows || []).filter(isInjectedObRow)) {
    const id      = String(row.id);
    const entryId = entryIdFromObRowId(id);
    const entry   = entriesById.get(entryId) || null;
    if (!entry || entry.status !== 'approved'
        || !(needsObRow(entry) || splitSentTo(entry, 'dust'))) {
      stale.push(id);
      continue;
    }
    // An id carrying our prefix but naming no leg is not a haul: nothing here
    // mints one, so it is a row a failed prune left behind. Sweeping it is the
    // only thing that ever will — the tab refuses to delete payroll's rows, and
    // its entry is alive, so every other test here passes it.
    if (obRowIndexFromId(id) == null) { stale.push(id); continue; }
    if (seen.has(id)) { stale.push(id); continue; }
    seen.add(id);
  }
  return stale;
}

/**
 * Remove a set of Other Billing rows by id, along with the Intercompany billing
 * entries they created.
 *
 * One statement for the blob, for the reason deleteTruckBlobRows gives: the tab
 * PUTs the whole list on a 900ms debounce, so a sweep that read the array and
 * wrote it back could undo a row somebody added in between. Filtering inside
 * the UPDATE only ever removes the named ids.
 *
 * The billing sweep is what makes the removal stick. dust.html's auto-sync
 * mirrors every qualifying Other Billing row into the shared Intercompany list,
 * and an entry left behind by an un-approval goes on invoicing a delivery
 * payroll has withdrawn. Any Intercompany-side invoice or payment dates go with
 * it; that is the intended trade, since the work they billed for is no longer
 * approved.
 *
 * Company-scoped key only — the unscoped legacy blob predates company scoping
 * and is shared, so one company's timesheet entries are no grounds to delete
 * rows out of it.
 */
async function deleteObRows(sql, companyCode, rowIds) {
  const ids = [...new Set((rowIds || []).map(v => String(v || '')).filter(Boolean))];
  if (!ids.length) return 0;
  const scoped = `${companyCode}:${OB_BLOB_KEY}`;
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
  // Non-fatal. Throwing here would fail an un-approve after the rows are
  // already gone, and the retry would find nothing to remove and return early —
  // so the billing entries would be stranded by the very error meant to protect
  // them.
  try {
    await removeIcBillingEntries(sql, companyCode, IC_SOURCE_OB, ids);
  } catch (err) {
    console.error('[dust-ob-injected] removing IC billing entries failed:', err.message);
  }
  return ids.length;
}

/**
 * Sweep injected rows that outlived their timesheet entry out of `rows`.
 *
 * Self-healing on read, because the alternative is a row nobody can remove: the
 * Other Billing tab refuses to delete payroll rows, and payroll can only
 * un-approve an entry that still exists and still owns that id.
 *
 * Costs one indexed lookup, and only when the list actually contains injected
 * rows; it writes nothing in the steady state, which is every call after the
 * first. Returns { rows, removed } with `rows` filtered — the caller can hand
 * it straight back to the client, so a stale row is gone from the tab on the
 * same load that cleaned it up.
 */
async function sweepInjectedObRows(sql, companyCode, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const entryIds = [...new Set(
    list.map(r => (r && typeof r === 'object') ? entryIdFromObRowId(r.id) : null)
        .filter(id => id != null)
  )];
  if (!entryIds.length) return { rows: list, removed: [] };

  const entryRows = await sql`
    SELECT id, status, entry_type, division, job_id, split_destinations
      FROM timesheet_entries
     WHERE company_code = ${companyCode} AND id = ANY(${entryIds}::bigint[])
  `;
  const entriesById = new Map(entryRows.map(r => [Number(r.id), r]));

  const stale = findStaleObRows(list, entriesById);
  if (!stale.length) return { rows: list, removed: [] };

  const staleSet  = new Set(stale);
  const remaining = list.filter(r => !(r && typeof r === 'object' && staleSet.has(String(r.id))));

  await deleteObRows(sql, companyCode, stale);
  console.warn(`[dust-ob-injected] swept ${stale.length} orphaned injected row(s) for ${companyCode}: ${stale.join(', ')}`);
  return { rows: remaining, removed: stale };
}

module.exports = {
  OB_BLOB_KEY,
  IC_SOURCE_OB,
  OB_TAB_FIELDS,
  OB_PRICE_OVERRIDE,
  OB_PRICE_PAYROLL,
  OB_PRICE_MAX,
  normalizeObPrice,
  sameObPrice,
  applyObPriceOverride,
  MAX_OB_ROWS,
  needsObRow,
  obRowIdPrefix,
  obRowId,
  obRowIndexFromId,
  entryIdFromObRowId,
  isInjectedObRowId,
  isInjectedObRow,
  findStaleObRows,
  deleteObRows,
  sweepInjectedObRows,
};
