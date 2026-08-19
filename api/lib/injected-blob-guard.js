'use strict';
/**
 * Payroll owns its injected rows on write, too.
 *
 * Four division tabs keep their cost tracking in a JSON blob that the tab
 * saves WHOLE — trucking (fct_truck_division), quarry (fct_quarry_daily /
 * fct_quarry_crushing) and dust Other Billing (dust_other_billing_rows).
 * Payroll writes into those same blobs whenever a timesheet entry is approved
 * or un-approved. The two writers race, and the
 * tab's copy is always the stale one, because it was read before the approval
 * it is about to land on top of:
 *
 *   - Payroll approves while the tab is open. The tab's next save — a debounced
 *     600ms write after any cell edit — PUTs the list it loaded earlier, and the
 *     just-injected row is gone. Payroll still reports the entry as approved, so
 *     nothing flags it: the hours simply never reach cost tracking or billing,
 *     and the tab will not let anyone add the row back by hand.
 *   - Payroll un-approves while the tab is open, and the same stale save puts
 *     the row back, re-billing work that was withdrawn.
 *
 * api/daily-rows.js already settled this for the turf/paving side: a division
 * tab has no authority over a payroll-injected row, so its writes against one
 * are refused rather than merged. This is that rule for the blob-backed tabs.
 * On every whole-blob write the injected rows are taken from the SERVER's copy,
 * never the client's — so a stale save can neither drop one nor resurrect one —
 * while the rows the tab genuinely owns are saved exactly as sent.
 *
 * The one nuance is that a tab may own some COLUMNS of a row it does not own:
 * the trucking office fills in the invoice sub-row (QB number, invoiced/sent
 * dates, paid status) on a locked payroll row. Those are replayed from the
 * incoming copy onto the server's row, the same way dust's EES tab replays its
 * rate column. Everything else on the row stays payroll's.
 *
 * Dust's EES tab (dust_ees_other_rows) is deliberately absent: it already
 * version-checks its writes and replays its own columns on a conflict, and is
 * the only one of the four that was never exposed.
 *
 * Dust's Other Billing tab (dust_other_billing_rows) joined the list when
 * payroll started posting material hauls into it. It has neither of EES's
 * protections — it PUTs the whole list on a 900ms debounce after any cell edit,
 * with no version check — so without this every injected row would be erased by
 * the next keystroke anywhere in the grid.
 */

// TRUCK_TAB_FIELDS lives beside the row identity it belongs to: the same list
// governs what re-injection preserves and what a tab save may overwrite, and
// the two drifting apart is how an office edit survives one path but not the
// other.
const {
  needsTruckTrackingRow, truckingRowIdPrefix, TRUCK_TAB_FIELDS,
} = require('./truck-injected');
// Same rule, same reason, for the Dust Other Billing grid: OB_TAB_FIELDS is
// what re-injection preserves, so it is also what a tab save may overwrite.
const { OB_TAB_FIELDS } = require('./dust-ob-injected');

/**
 * Blob key → how payroll-injected rows are recognised in it, and which of their
 * columns the owning tab may still write.
 *
 * The prefixes are the ones api/timesheet-entries.js mints: "tst-<entryId>-"
 * for Truck Tracking, "tsq-<entryId>-" for the quarry Daily/Crushing tabs and
 * "tso-<entryId>-" for Dust Other Billing. Manual rows use UUIDs or "TR-####"
 * task numbers and never collide.
 */
const INJECTED_BLOBS = {
  fct_truck_division:  { prefix: 'tst-', tabFields: TRUCK_TAB_FIELDS },
  // Quarry's injected rows are rendered read-only in quarry.html (isTimesheetRow),
  // so the tab owns none of their columns.
  fct_quarry_daily:    { prefix: 'tsq-', tabFields: [] },
  fct_quarry_crushing: { prefix: 'tsq-', tabFields: [] },
  // The dust office still bills on a payroll row here — the invoice number and
  // the note against it are its columns, and stay editable in the tab.
  dust_other_billing_rows: { prefix: 'tso-', tabFields: OB_TAB_FIELDS },
};

function guardConfigFor(key) { return INJECTED_BLOBS[key] || null; }

const isInjected = (row, prefix) =>
  !!row && typeof row === 'object' && String(row.id || '').startsWith(prefix);

/**
 * Merge one incoming whole-blob write against the server's current rows.
 * Pure — takes both arrays, returns the array to store.
 *
 * Rules, in order of the incoming list so the tab's own ordering survives:
 *   - a row the tab owns  → kept exactly as sent,
 *   - a payroll row the server still has → server's copy, with the tab-owned
 *     columns replayed from the incoming copy,
 *   - a payroll row the server no longer has → dropped (payroll un-approved or
 *     deleted it; the client's copy is stale by definition),
 *   - a payroll row the server has that the incoming list never mentioned →
 *     appended (it was injected after the client read).
 */
function mergeInjectedRows(serverRows, incomingRows, cfg) {
  const prefix = cfg.prefix;
  const server = Array.isArray(serverRows) ? serverRows : [];
  const incoming = Array.isArray(incomingRows) ? incomingRows : [];

  const serverById = new Map();
  for (const row of server) if (isInjected(row, prefix)) serverById.set(String(row.id), row);

  const merged = [];
  const placed = new Set();
  for (const row of incoming) {
    if (!isInjected(row, prefix)) { merged.push(row); continue; }
    const id  = String(row.id);
    const srv = serverById.get(id);
    if (!srv || placed.has(id)) continue;      // withdrawn by payroll, or a duplicate
    // The tab's columns are replayed; the rest of the row is the server's.
    const out = { ...srv };
    for (const f of cfg.tabFields) {
      if (Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f];
    }
    merged.push(out);
    placed.add(id);
  }
  // Injected after the client read its copy — never seen by this save.
  for (const [id, srv] of serverById) if (!placed.has(id)) merged.push(srv);

  return merged;
}

/**
 * Count how a write was adjusted, for logging. Silent correction of a client
 * write is exactly the kind of thing that should leave a trace.
 */
function describeMerge(serverRows, incomingRows, merged, cfg) {
  const p = cfg.prefix;
  const inIds  = new Set((incomingRows || []).filter(r => isInjected(r, p)).map(r => String(r.id)));
  const srvIds = new Set((serverRows   || []).filter(r => isInjected(r, p)).map(r => String(r.id)));
  let restored = 0, dropped = 0;
  for (const id of srvIds) if (!inIds.has(id)) restored++;
  for (const id of inIds)  if (!srvIds.has(id)) dropped++;
  return { restored, dropped };
}

/**
 * Apply the guard to a whole-blob write. Returns the value to store — the
 * incoming value untouched when the key carries no injected rows, so callers
 * can run this unconditionally.
 *
 * Reads the server's current blob itself rather than taking it from the caller,
 * so the comparison is against the value as of this write and not something
 * read earlier in the request.
 */
async function guardInjectedBlobWrite(sql, companyCode, key, value) {
  const cfg = guardConfigFor(key);
  if (!cfg || !Array.isArray(value)) return value;

  const scoped = `${companyCode}:${key}`;
  const rows = await sql`SELECT value FROM app_data WHERE key = ${scoped}`;
  const current = (rows.length && Array.isArray(rows[0].value)) ? rows[0].value : [];
  // Nothing injected on either side — the common case, and a no-op.
  if (!current.some(r => isInjected(r, cfg.prefix)) &&
      !value.some(r => isInjected(r, cfg.prefix))) return value;

  const merged = mergeInjectedRows(current, value, cfg);
  const { restored, dropped } = describeMerge(current, value, merged, cfg);
  if (restored || dropped) {
    console.warn(
      `[injected-blob-guard] ${companyCode}/${key}: kept ${restored} payroll row(s) the save omitted, ` +
      `ignored ${dropped} the save carried that payroll no longer has`
    );
  }
  return merged;
}

module.exports = {
  INJECTED_BLOBS,
  TRUCK_TAB_FIELDS,
  guardConfigFor,
  mergeInjectedRows,
  describeMerge,
  guardInjectedBlobWrite,
  // Re-exported so callers that already have a truck row in hand don't reach
  // past this module for the two things that decide its fate.
  needsTruckTrackingRow,
  truckingRowIdPrefix,
};
