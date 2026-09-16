'use strict';
/**
 * Single-purchase-order writes, for central purchasing.
 *
 * The division pages (tracker / paving / kiewit) save purchase orders by
 * PUTting their whole list back. That is fine while one division's own tab is
 * the only writer: whoever saves last wins, and they were both editing the same
 * screen. Central purchasing breaks that assumption — purchase-orders.html
 * writes into turf, paving and kiewit, so a full-list PUT from it would erase
 * whatever that division's own tab had saved in the meantime.
 *
 * So purchasing never PUTs a list. It upserts ONE order at a time through
 * upsertPO / removePO below, which read-modify-write the division's blob under
 * a compare-and-set on app_data.updated_at and retry when they lose the race.
 * Two writers can then both land: the loser re-reads the winner's list and
 * merges onto it.
 *
 * The order is stored in the blob of the division it is tied to, not in a list
 * of purchasing's own. That is what makes "an order raised against paving shows
 * up in paving's Purchase Orders tab" true with no sync step and no second copy
 * — paving's page reads the same key it always did. Orders tied to no division
 * are the exception and live under PO_GENERAL_DIVISION.
 */

const crypto = require('crypto');
const { PO_GENERAL_DIVISION, PO_SOURCE_DIVISIONS } = require('./auth');

// How many times a losing writer re-reads and retries before giving up. Each
// attempt is one round trip; a genuine pile-up on one division's list resolves
// well inside this, and the 409 that follows is honest rather than silent.
const CAS_ATTEMPTS = 6;

// Rows auto-injected by a payroll approval carry a server-minted row_id of the
// form "ts<entryId>-…". Only payroll may create or remove them — see the note
// in api/daily-rows.js. Nothing here should ever touch one, but a PO line whose
// po_row_id had been corrupted into pointing at one would otherwise delete a
// timesheet row on the next save.
function isInjectedRowId(id) {
  return /^ts\d+-/.test(String(id == null ? '' : id));
}

function safeFloat(v) {
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

function floatOrZero(v) {
  const f = parseFloat(v);
  return isNaN(f) ? 0 : f;
}

function safeDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return s.length === 10 ? s : null;
}

function blobKeyFor(companyCode, division) {
  return `${companyCode}:fct_purchase_orders:${division}`;
}

/** Mirrors the frontend's _lineAmt: quantity × unit cost, blanks reading as 0. */
function lineAmt(line) {
  return floatOrZero(line && line.qty) * floatOrZero(line && line.unit_cost);
}

/**
 * Tax on a delivery line, in dollars.
 *
 * Tax is entered as a PERCENTAGE of the line amount and the frontend mirrors
 * the resulting dollars into `tax` so every downstream reader still sees an
 * amount. Three cases, and they are the three the division tabs distinguish
 * between (_lineTax and _recalcLineTax in tracker.html):
 *
 *   tax_pct absent   a line saved before the percentage field existed. Its
 *                    stored dollar figure is all there is, so use it.
 *   tax_pct blank    the user cleared the field, which means no tax. NOT a
 *                    fall back to `tax`: that still holds whatever the
 *                    percentage last wrote there, so falling back would revive
 *                    a tax that was just removed — and charge the job for it.
 *   tax_pct set      a percentage of the line amount.
 *
 * The blank case is why this is not simply `pct ?? dollars`. The frontend keeps
 * `tax` in step as the user types, but a job's costs should not depend on a
 * client having done that.
 */
function lineTax(line) {
  if (!line) return 0;
  if (line.tax_pct == null) return floatOrZero(line.tax);
  const pct = safeFloat(line.tax_pct);
  if (pct === null) return 0;
  return lineAmt(line) * pct / 100;
}

/**
 * Does this delivery line cost the job? The frontend creates a daily row the
 * moment a line has a quantity or a unit cost, and not before — an empty line
 * someone added and never filled in should not show up on the job's cost tab.
 */
function lineHasCost(line) {
  return Boolean(line && (line.qty || line.unit_cost));
}

/**
 * Read a division's purchase-order list along with the timestamp to compare
 * against when writing it back. `exists` distinguishes an absent row from one
 * holding an empty list — they need different SQL to write.
 */
async function readPOBlob(sql, blobKey) {
  // updated_at comes back as TEXT on purpose. app_data.updated_at is a
  // microsecond-precision timestamptz, and the driver parses a timestamptz into
  // a JS Date, which only holds milliseconds — so the microseconds were thrown
  // away on the way out and the value re-bound in casWritePOBlob's WHERE could
  // never equal the stored one. Every compare-and-set lost, all six attempts,
  // and every save and delete central purchasing made answered 409. Text
  // survives the round trip exactly, and Postgres infers timestamptz for the
  // parameter from the comparison.
  const rows = await sql`SELECT value, updated_at::text AS updated_at FROM app_data WHERE key = ${blobKey}`;
  if (!rows.length) return { list: [], updatedAt: null, exists: false };
  const value = rows[0].value;
  return {
    list:      Array.isArray(value) ? value : [],
    updatedAt: rows[0].updated_at,
    exists:    true,
  };
}

/**
 * Write `list` back to `blobKey`, but only if nobody else has written since
 * `base`. Returns false when the compare-and-set loses, so the caller re-reads.
 *
 * clock_timestamp() rather than NOW(): NOW() is the transaction's start time,
 * so two writes could in principle stamp the same value and leave a third
 * writer's base indistinguishable from the version before it.
 */
async function casWritePOBlob(sql, blobKey, list, base) {
  const json = JSON.stringify(list);
  if (base.exists) {
    const updated = await sql`
      UPDATE app_data
      SET    value = ${json}::jsonb, updated_at = clock_timestamp()
      WHERE  key = ${blobKey} AND updated_at = ${base.updatedAt}::timestamptz
      RETURNING key
    `;
    return updated.length > 0;
  }
  // No row yet. DO NOTHING rather than DO UPDATE so a writer that created the
  // row a moment ago is not clobbered by one that read before it existed —
  // that writer loses here and retries against the row it can now see.
  const inserted = await sql`
    INSERT INTO app_data (key, value, updated_at)
    VALUES (${blobKey}, ${json}::jsonb, clock_timestamp())
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `;
  return inserted.length > 0;
}

/**
 * Apply `mutate` to a division's purchase-order list and save it, retrying
 * from a fresh read whenever another writer got there first.
 *
 * `mutate(list)` must return the new list, or null to abandon the write (used
 * when a delete finds nothing to delete). It may be called more than once, so
 * it has to derive everything from the list it is handed.
 */
async function mutatePOBlob(sql, blobKey, mutate) {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const base = await readPOBlob(sql, blobKey);
    const next = mutate(base.list);
    if (next === null) return { ok: true, changed: false, list: base.list };
    if (await casWritePOBlob(sql, blobKey, next, base)) {
      return { ok: true, changed: true, list: next };
    }
  }
  return { ok: false, changed: false, list: null };
}

// ── Normalized mirror ───────────────────────────────────────────────────────
// The blob is the source of truth on read; these tables back the reporting
// queries and the recovery fallback in api/purchase-orders.js. A single-order
// write mirrors only its own row, never the division-wide delete-and-reinsert
// the full-list PUT does — that would wipe every order purchasing did not send.

async function mirrorOnePO(sql, companyCode, division, po) {
  await sql`
    INSERT INTO purchase_orders (
      id, company_code, division, po_num, title, supplier, project_id,
      cost_code, sub_code, status, notes, origin,
      date_created, status_changed_at, status_changed_by, updated_at
    ) VALUES (
      ${po.id}, ${companyCode}, ${division},
      ${po.po_number      || ''},
      ${po.title          || null},
      ${po.supplier       || null},
      ${po.project_id     || null},
      ${po.cost_code      || null},
      ${po.sub_code       || null},
      ${po.status         || 'pending'},
      ${po.notes          || null},
      ${po.origin         || null},
      ${safeDate(po.date_created)},
      ${po.status_changed_at || null},
      ${po.status_changed_by || null},
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      division           = EXCLUDED.division,
      po_num             = EXCLUDED.po_num,
      title              = EXCLUDED.title,
      supplier           = EXCLUDED.supplier,
      project_id         = EXCLUDED.project_id,
      cost_code          = EXCLUDED.cost_code,
      sub_code           = EXCLUDED.sub_code,
      status             = EXCLUDED.status,
      notes              = EXCLUDED.notes,
      origin             = EXCLUDED.origin,
      date_created       = EXCLUDED.date_created,
      status_changed_at  = EXCLUDED.status_changed_at,
      status_changed_by  = EXCLUDED.status_changed_by,
      updated_at         = NOW()
    WHERE purchase_orders.company_code = ${companyCode}
  `;

  // Deliveries are rewritten wholesale for this one order. Unlike the
  // division-wide sync there is no bulk-wipe hazard here: the caller always
  // sends the order's complete line list, because that is what it just saved
  // to the blob.
  await sql`DELETE FROM po_deliveries WHERE po_id = ${po.id} AND company_code = ${companyCode}`;
  for (const line of (Array.isArray(po.lines) ? po.lines : [])) {
    if (!line) continue;
    const qty = safeFloat(line.qty)       ?? 0;
    const uc  = safeFloat(line.unit_cost) ?? 0;
    await sql`
      INSERT INTO po_deliveries (
        po_id, company_code,
        line_id, invoice_num, delivery_date,
        units_delivered, unit_cost, delivery_cost,
        tax, employee, po_row_id
      ) VALUES (
        ${po.id}, ${companyCode},
        ${line.id          || null},
        ${line.invoice_num || null},
        ${safeDate(line.date)},
        ${qty}, ${uc}, ${qty * uc},
        ${lineTax(line)},
        ${line.employee    || null},
        ${line.po_row_id   || null}
      )
    `;
  }
}

async function unmirrorPO(sql, companyCode, poId) {
  await sql`DELETE FROM po_deliveries  WHERE po_id = ${poId} AND company_code = ${companyCode}`;
  await sql`DELETE FROM purchase_orders WHERE id   = ${poId} AND company_code = ${companyCode}`;
}

// ── Job cost rows ───────────────────────────────────────────────────────────
// Reconciles the daily_tracking rows a purchase order's deliveries create on
// its project. The division pages do this client-side one edit at a time
// (_ensurePOLineRow / _syncPOLineToRow / _syncPOHeaderToLines); purchasing does
// not hold that division's project in memory, so the server reconciles the
// whole order instead. Same end state, and idempotent: re-saving an unchanged
// order rewrites the same values.

async function deletePORows(sql, companyCode, rowIds) {
  const ids = (rowIds || []).map(String).filter(id => id && !isInjectedRowId(id));
  if (!ids.length) return 0;
  const gone = await sql`
    DELETE FROM daily_tracking
    WHERE company_code = ${companyCode} AND row_id = ANY(${ids})
    RETURNING row_id
  `;
  return gone.length;
}

/**
 * Bring the cost rows for one purchase order into line with its deliveries.
 *
 * Mutates `po` in place, filling in `po_row_id` on any line that did not have
 * one — the caller must save the order AFTER this runs, or the link is lost
 * and the next save orphans the row it just created.
 *
 * `prevPO` is the order as it was stored before this save, and is what lets a
 * re-tied order clean up after itself: when the project or the division moves,
 * every row the old project carried is removed before the new ones are written.
 */
async function syncPOCostRows(sql, { companyCode, division, po, prevPO, prevDivision, priorCopies }) {
  // An order filed under purchasing itself belongs to no job ledger, so it can
  // carry no job — and daily_tracking's division CHECK does not admit
  // 'purchase_orders' anyway. The page clears the job when the division
  // changes, but that is client-side: a stale tab, a replayed request or any
  // non-browser client with the same token can still send one. Without this the
  // rows for the OLD job are deleted first and the insert that follows violates
  // the constraint, so the request 500s having already destroyed them.
  const lines = Array.isArray(po.lines) ? po.lines : [];
  // Only the job divisions keep a cost ledger, and daily_tracking's own CHECK
  // admits only those. An order filed anywhere else can carry no job — the
  // general list by design, and anything else because the INSERT would violate
  // that constraint and 500 with the raw constraint name. The page clears the
  // job when the division changes, but that is client-side: a stale tab or a
  // replayed request still sends one.
  if (!PO_SOURCE_DIVISIONS.includes(division) && po.project_id) po.project_id = '';
  const projectId = po.project_id || '';

  const prevLines   = (prevPO && Array.isArray(prevPO.lines)) ? prevPO.lines : [];
  const movedJob    = Boolean(prevPO) && (prevPO.project_id || '') !== projectId;
  const movedDiv    = Boolean(prevDivision) && prevDivision !== division;
  const startAfresh = movedJob || movedDiv;

  // The link from a delivery to its cost row is minted here and travels back in
  // the response, so a client that never saw that response sends the line with
  // no link at all — a dropped connection, a second tab that loaded before the
  // first filled in a quantity, a save that raced another. Minting a fresh row
  // for a delivery the STORED order already has one for would charge the job
  // twice and orphan the first row past the reach of even deleting the order,
  // since nothing would name it any more. So the stored list is what the link
  // is read from; the client's copy only adds to it.
  //
  // Not consulted when the order MOVED: every row it had is being deleted, so
  // reusing one of their ids would resurrect the id the move just retired and
  // undo the reset a few lines below.
  const storedRowIdFor = new Map();
  if (!startAfresh) {
    for (const l of prevLines) {
      if (l && l.id && l.po_row_id) storedRowIdFor.set(l.id, l.po_row_id);
    }
  }

  // The cost rows this order actually owns — taken from what is STORED, never
  // from the request.
  //
  // po_row_id arrives in the body, and daily_tracking.row_id is unique across
  // the whole company, so a request naming a row id it did not create could
  // otherwise reach any job-cost row in the tenant: emptying a line's quantity
  // deleted whatever id the line pointed at, and a line carrying a live id
  // rewrote that row's job, division and cost. Neither needed a role in the
  // division that owned it. An id the stored order does not name is simply not
  // this order's to touch, so it is ignored and the delivery gets a row of its
  // own instead.
  // Every stored copy counts, not just the previous one. A move that half
  // landed leaves the order in both lists — the new one already naming the rows
  // this call's first attempt wrote, the old one still naming the ones it
  // replaced — and the retry has to recognise both as its own. Treating only
  // the old copy as authoritative made the retry mint a third set and orphan
  // the second.
  const ownedRowIds = new Set();
  for (const copy of (Array.isArray(priorCopies) && priorCopies.length ? priorCopies : [prevPO])) {
    for (const l of ((copy && Array.isArray(copy.lines)) ? copy.lines : [])) {
      if (l && l.po_row_id) ownedRowIds.add(String(l.po_row_id));
    }
  }
  const ownsRow = id => Boolean(id) && ownedRowIds.has(String(id));

  // Whether the ORDER's own cost/sub code changed in this save. A PO-generated
  // material row is fully editable on the job's own cost tab, and re-coding one
  // is a real workflow — so purchasing flipping a status or fixing a typo must
  // not drag it back. Only a change to the order's codes carries through, which
  // is exactly the `syncCodes` distinction _syncPOHeaderToLines draws in
  // tracker.html. A brand-new row takes the order's codes regardless: there is
  // no supervisor decision on it yet to preserve.
  const codesChanged = !prevPO
    || startAfresh
    || (prevPO.cost_code || '') !== (po.cost_code || '')
    || (prevPO.sub_code  || '') !== (po.sub_code  || '');

  // Rows that must go: everything from the previous project when the order
  // moved, otherwise the rows of lines that were deleted or emptied out.
  const liveLineIds = new Set(lines.filter(lineHasCost).map(l => l.id));
  const stale = prevLines
    .filter(l => l && l.po_row_id)
    .filter(l => startAfresh || !liveLineIds.has(l.id))
    .map(l => l.po_row_id);

  // When the order moved, the rows the INCOMING lines point at go too. Normally
  // those are the same ids prevLines carries — but not after a move that only
  // half landed: the caller retries with lines already pointing at rows on the
  // NEW job, while the stored copy still names the old ones. Without this the
  // retry re-creates every row and leaves the first attempt's behind, and the
  // job is charged for the delivery twice.
  if (startAfresh) {
    for (const line of lines) if (line && ownsRow(line.po_row_id)) stale.push(line.po_row_id);
  }

  // A line the caller sent with a po_row_id but no cost left on it — the user
  // cleared the quantity. Its row goes too, and the stale link with it. Only
  // when the row is one this order owns: otherwise the link is dropped and
  // somebody else's row is left alone.
  for (const line of lines) {
    if (line && line.po_row_id && !lineHasCost(line)) {
      if (ownsRow(line.po_row_id)) stale.push(line.po_row_id);
      line.po_row_id = null;
    }
  }
  if (startAfresh) {
    for (const line of lines) if (line) line.po_row_id = null;
  }

  // The stale rows are named here but deleted by the CALLER, once the order is
  // actually stored. Deleting them now loses them outright when the write then
  // fails — the save is reported as a conflict while the job has quietly lost
  // a cost row. Nothing can collide in the gap: a cleared line has its link
  // nulled just above and is skipped by lineHasCost, and under startAfresh
  // every line is nulled and takes a fresh id.
  const staleIds = stale;

  // An order with no job has no cost rows at all — that is the general-purchase
  // case, and it is a first-class state rather than an incomplete order.
  if (!projectId) return { staleIds, written: 0, writtenIds: [], createdIds: [] };

  /**
   * Write one delivery's cost row under `rowId`, and say whether it landed.
   *
   * One statement for both the create and the update. The INSERT arm matches
   * defaultDailyRow()'s material shape; the UPDATE arm sets only the columns a
   * purchase order owns, so a supervisor's re-categorisation on the job's own
   * cost tab survives — cost and sub code included, unless the ORDER's own
   * codes are what changed.
   *
   * The conflict arm is scoped to this company, the mirror of the DELETE above.
   * daily_tracking.row_id is globally unique, and po_row_id arrives in the
   * request body, so without it a crafted or stale id could rewrite a row
   * belonging to another order, another division or another tenant. RETURNING
   * is what makes that safe to act on: a row the WHERE excludes comes back
   * empty instead of silently doing nothing.
   */
  async function writeRow(rowId, line) {
    const cost = lineAmt(line) + lineTax(line);
    const date = safeDate(line.date) || safeDate(po.date_created) || new Date().toISOString().slice(0, 10);
    const out = await sql`
      INSERT INTO daily_tracking (
        row_id, project_id, company_code, division,
        date, field_type, employee, cost_code, sub_code,
        material, supplier, po_num,
        units_purchased, unit_cost, material_cost
      ) VALUES (
        ${rowId}, ${projectId}, ${companyCode}, ${division},
        ${date}, 'Material', ${line.employee || null},
        ${po.cost_code || null}, ${po.sub_code || null},
        ${po.title || null}, ${po.supplier || null}, ${po.po_number || null},
        ${floatOrZero(line.qty)}, ${floatOrZero(line.unit_cost)}, ${cost}
      )
      ON CONFLICT (row_id) DO UPDATE SET
        project_id      = EXCLUDED.project_id,
        division        = EXCLUDED.division,
        date            = EXCLUDED.date,
        employee        = EXCLUDED.employee,
        cost_code       = CASE WHEN ${codesChanged} THEN EXCLUDED.cost_code ELSE daily_tracking.cost_code END,
        sub_code        = CASE WHEN ${codesChanged} THEN EXCLUDED.sub_code  ELSE daily_tracking.sub_code  END,
        material        = EXCLUDED.material,
        supplier        = EXCLUDED.supplier,
        po_num          = EXCLUDED.po_num,
        units_purchased = EXCLUDED.units_purchased,
        unit_cost       = EXCLUDED.unit_cost,
        material_cost   = EXCLUDED.material_cost,
        updated_at      = NOW()
      WHERE daily_tracking.company_code = ${companyCode}
        AND daily_tracking.division   = ${division}
        AND daily_tracking.project_id = ${projectId}
        AND daily_tracking.timesheet_entry_id IS NULL
      RETURNING row_id
    `;
    return out.length > 0;
  }

  let written = 0;
  const writtenIds = [];
  // Ids MINTED by this call. A reused id names a row the stored order already
  // owns and that was only UPDATED here, so rolling it back would delete a live
  // cost row the order still points at — which is what a routine second save
  // was doing to the job every time.
  const createdIds = [];
  for (const line of lines) {
    if (!line || !lineHasCost(line)) continue;

    // The stored order is the authority on which row a delivery already owns —
    // an id the request supplied is honoured only when the stored order names
    // it too, so a crafted one falls through to a fresh row of its own.
    const linked = (ownsRow(line.po_row_id) && line.po_row_id)
      || storedRowIdFor.get(line.id)
      || null;
    // Nothing here may touch a payroll-injected row, however a link came to
    // point at one. Only payroll creates and removes those.
    if (linked && isInjectedRowId(linked)) continue;

    let rowId = linked || crypto.randomUUID();
    let ok = await writeRow(rowId, line);
    if (!ok && linked) {
      // The id named a row this caller has no claim to — another tenant's, or
      // one payroll owns. Give the delivery a row of its own rather than
      // dropping it: a fresh uuid cannot collide, so this write always lands,
      // and the job gets charged exactly once either way.
      rowId = crypto.randomUUID();
      ok = await writeRow(rowId, line);
    }
    if (!ok) continue;

    line.po_row_id = rowId;
    writtenIds.push(rowId);
    if (rowId !== linked) createdIds.push(rowId);
    written++;
  }

  return { staleIds, written, writtenIds, createdIds };
}

/**
 * Deliveries the stored order has that the incoming one does not mention.
 *
 * A save replaces the stored order outright, which is fine for its own fields
 * but wrong for its deliveries: this page regularly holds a copy that is a
 * minute out of date, and the division's own tab is adding deliveries to the
 * same order the whole time. Replacing wholesale dropped the ones it had not
 * heard about — and syncPOCostRows then read their absence as a deletion and
 * removed the job cost rows behind them too. A supervisor's delivery and the
 * money it put on the job both vanished, with nothing on either screen to say
 * so.
 *
 * "Absent" alone cannot tell a delivery the caller DELETED from one it never
 * saw, so the caller says which it deleted. Anything else the stored order
 * carries is kept.
 */
function unseenLines(po, priorCopies, deletedLineIds) {
  const sent    = new Set((Array.isArray(po.lines) ? po.lines : []).map(l => l && l.id).filter(Boolean).map(String));
  const deleted = new Set((Array.isArray(deletedLineIds) ? deletedLineIds : []).map(String));
  const keep = [], seen = new Set();
  for (const copy of (priorCopies || [])) {
    for (const l of ((copy && Array.isArray(copy.lines)) ? copy.lines : [])) {
      if (!l || !l.id) continue;
      const id = String(l.id);
      if (sent.has(id) || deleted.has(id) || seen.has(id)) continue;
      seen.add(id);
      keep.push(l);
    }
  }
  return keep;
}

/**
 * Save one purchase order into `division`'s list.
 *
 * Order of operations matters: the cost rows are reconciled FIRST, because
 * doing so mints the po_row_id links that then have to be part of what gets
 * stored. Writing the blob first would save an order whose lines point at
 * nothing, and the next save would create a second set of rows.
 *
 * `from` names the division the order was stored under before this save, when
 * purchasing re-tied it to a different one. The order is removed from that list
 * in the same call, so it can never exist in two divisions at once.
 */
async function upsertPO(sql, { companyCode, division, po, from, deletedLineIds }) {
  const prevDivision = from && from !== division ? from : null;

  // Every list this order might already be stored in. The target's copy matters
  // as much as the source's after a move that half landed, when the order is in
  // both — see the ownership note in syncPOCostRows.
  const targetCopy = (await readPOBlob(sql, blobKeyFor(companyCode, division)))
    .list.find(p => p && p.id === po.id) || null;

  let prevPO = targetCopy;
  const priorCopies = [];
  if (targetCopy) priorCopies.push(targetCopy);
  if (prevDivision) {
    const old = await readPOBlob(sql, blobKeyFor(companyCode, prevDivision));
    const sourceCopy = old.list.find(p => p && p.id === po.id) || null;
    // `prevPO` is what this order looked like BEFORE the save, which after a
    // move is the copy in the list it is leaving.
    prevPO = sourceCopy;
    if (sourceCopy) priorCopies.push(sourceCopy);
  }

  // Deliveries somebody else added while this caller was holding a stale copy.
  // Merged back BEFORE the cost rows are reconciled, so their rows are not read
  // as belonging to deleted lines and swept away.
  const recovered = unseenLines(po, priorCopies, deletedLineIds);
  if (recovered.length) po.lines = (Array.isArray(po.lines) ? po.lines : []).concat(recovered);

  const rows = await syncPOCostRows(sql, {
    companyCode, division, po, prevPO, prevDivision, priorCopies,
  });

  // The new list is written FIRST, and only then is the old one emptied.
  // The reverse order has a window where the order is in neither list, and a
  // compare-and-set that runs out of attempts in that window loses it outright.
  // This way the worst case is a duplicate, which is visible, harmless to the
  // job's costs (the rows were already moved) and cleaned up by the retry.
  const saved = await mutatePOBlob(sql, blobKeyFor(companyCode, division), list => {
    const idx = list.findIndex(p => p && p.id === po.id);
    if (idx === -1) return [...list, po];
    // Replaced in place: the purchase-order tables are drawn in list order, so
    // appending an edited order would jump it to the end of everyone's screen.
    const next = list.slice();
    next[idx] = po;
    return next;
  });
  if (!saved.ok) {
    // The cost rows were reconciled before this, because reconciling is what
    // mints the po_row_id links the order has to be stored WITH. With the order
    // unstored, nothing anywhere names the rows this call CREATED — no later
    // save, no project change and not even deleting the order would find them,
    // and the retry would write a second set on top. So those go back.
    //
    // Only those. A row this call merely updated is one the stored order still
    // names and the job still needs; deleting it turned a failed save into a
    // job quietly losing its material cost, every time.
    if (rows.createdIds && rows.createdIds.length) {
      try { await deletePORows(sql, companyCode, rows.createdIds); }
      catch (err) { console.error('[po-sync] could not roll back cost rows:', err.message); }
    }
    return { ok: false, reason: 'conflict' };
  }

  // The order is stored, so the rows its old deliveries left behind can go.
  let removed = 0;
  try { removed = await deletePORows(sql, companyCode, rows.staleIds || []); }
  catch (err) { console.error('[po-sync] could not clear replaced cost rows:', err.message); }

  await mirrorOnePO(sql, companyCode, division, po);

  let staleCopy = false;
  if (prevDivision) {
    const dropped = await mutatePOBlob(sql, blobKeyFor(companyCode, prevDivision), list => {
      if (!list.some(p => p && p.id === po.id)) return null;
      return list.filter(p => !p || p.id !== po.id);
    });
    // Saved, but the old division still shows a copy. The caller is told so it
    // can leave its "this order was last stored under X" note alone — the next
    // save then repeats the move and clears the copy. Reporting this as a
    // failure would be worse: the order IS saved, and a caller that retried
    // from scratch would raise a second one.
    staleCopy = !dropped.ok;
  }

  return {
    ok: true, purchaseOrder: po, staleCopy,
    // So the caller can show what it had not heard about, instead of silently
    // carrying on with a list it now knows is short.
    mergedLines: recovered.length,
    rows: { removed, written: rows.written, writtenIds: rows.writtenIds },
  };
}

/** Remove one purchase order, its deliveries, and the cost rows it created. */
async function removePO(sql, { companyCode, division, poId }) {
  const base = await readPOBlob(sql, blobKeyFor(companyCode, division));
  const existing = base.list.find(p => p && p.id === poId) || null;

  const removed = await mutatePOBlob(sql, blobKeyFor(companyCode, division), list => {
    if (!list.some(p => p && p.id === poId)) return null;
    return list.filter(p => !p || p.id !== poId);
  });
  if (!removed.ok) return { ok: false, reason: 'conflict' };

  // Nothing was in this division's list, so there is nothing of this
  // division's to clean up. unmirrorPO scopes on id and company alone, so
  // running it anyway deleted the order's mirror row and every one of its
  // delivery rows wherever they actually lived — a stale tab deleting an order
  // another tab had already moved would destroy the recovery copy the GET
  // fallback reads, in a division the caller may hold no role in.
  if (!existing) return { ok: true, found: false, rowsRemoved: 0 };

  const rowIds = existing.lines && Array.isArray(existing.lines)
    ? existing.lines.filter(l => l && l.po_row_id).map(l => l.po_row_id)
    : [];
  const gone = await deletePORows(sql, companyCode, rowIds);
  await unmirrorPO(sql, companyCode, poId);

  return { ok: true, found: true, rowsRemoved: gone };
}

// ── Receipt paperwork ───────────────────────────────────────────────────────
// A receipt photographed against a purchase order has to end up filed in the
// SAME division as the order, or the division's own tab shows an order whose
// paperclip is empty. Central purchasing has no document role in turf, paving
// or kiewit, so the document endpoints need a way to admit it — one that opens
// nothing but the order in question.

/** The order with this id in `division`'s list, or null. */
async function findPOInDivision(sql, companyCode, division, poId) {
  if (!poId) return null;
  const { list } = await readPOBlob(sql, blobKeyFor(companyCode, division));
  return list.find(p => p && p.id === String(poId)) || null;
}

/**
 * May this caller act on `division`'s documents solely because they are central
 * purchasing working on one of its orders?
 *
 * Returns { poId, projectId } when so, and null otherwise — including for a
 * caller who already holds a role in the division, who needs no carve-out and
 * should be judged on that role instead.
 *
 * Two things keep this narrow. The request must name a purchase order, and that
 * order must actually be in this division's list — an id the caller invented
 * resolves to nothing and the carve-out does not apply. And the project it
 * answers with is the ORDER's project, not the one the request asked for, so a
 * caller cannot reach another job's folders by naming it alongside a real order.
 */
async function resolvePODocScope(sql, { payload, division, poId, companyCode, canAccessPODivision }) {
  if (!poId) return null;
  if (!canAccessPODivision(payload, division)) return null;
  // Holding a role in this division does NOT disqualify a caller. It used to:
  // a purchasing administrator who had also been given read-only rights in
  // paving came out worse than one with no paving rights at all — the division
  // role answered "view only", and the carve-out that would have let them
  // attach a receipt was skipped for the sole reason that they had a role.
  // What keeps this safe is not the absence of a role, it is the bound: the
  // scope is a single order that really is in this division's list, and the
  // callers resolve it only once the caller's own role has come up short.

  const po = await findPOInDivision(sql, companyCode, division, poId);
  if (!po) return null;

  return { poId: String(poId), projectId: po.project_id ? String(po.project_id) : null, po };
}

module.exports = {
  CAS_ATTEMPTS,
  unseenLines,
  findPOInDivision,
  resolvePODocScope,
  blobKeyFor,
  lineAmt,
  lineTax,
  lineHasCost,
  isInjectedRowId,
  readPOBlob,
  mutatePOBlob,
  syncPOCostRows,
  mirrorOnePO,
  unmirrorPO,
  upsertPO,
  removePO,
};
