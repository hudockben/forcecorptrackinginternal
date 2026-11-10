'use strict';
/**
 * Single-purchase-order writes, for central purchasing.
 *
 * The division pages (tracker / paving / kiewit) save purchase orders by
 * PUTting their whole list back. That is fine while one division's own tab is
 * the only writer: whoever saves last wins, and they were both editing the same
 * screen. Central purchasing breaks that assumption — purchase-orders.html
 * writes into turf, paving, kiewit and quarry, so a full-list PUT from it would erase
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
const { PO_GENERAL_DIVISION, PO_JOB_DIVISIONS } = require('./auth');
const { numeric } = require('./numeric');

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

// Quantities and costs arrive as strings typed on a phone or read off a
// photograph, so both go through the shared reading in ./numeric first — a bare
// parseFloat stops at a comma and drops the cents from '360,82'.
function safeFloat(v) {
  const f = numeric(v);
  return isNaN(f) ? null : f;
}

function floatOrZero(v) {
  const f = numeric(v);
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
 * What one unit of a delivery actually costs the job once tax is on it.
 *
 * The cost row's material_cost includes the tax, so its unit_cost has to as
 * well — a row reading 63.82 t at $16.00 but $1,082.39 doesn't add up, and the
 * job's cost tab re-derives material cost as units × unit cost the moment
 * anyone touches either, which silently dropped the tax off the job. With the
 * tax folded in here, units × unit cost comes back to the line total.
 *
 * Spreads the line's tax over its quantity, so a legacy flat-dollar tax lands
 * the same way a percentage does. With no quantity there is nothing to spread
 * over; the percentage, if any, is applied straight to the price.
 *
 * Rounded to four places, which is what daily_tracking.unit_cost stores.
 */
function lineUnitCostWithTax(line) {
  if (!line) return 0;
  const uc  = floatOrZero(line.unit_cost);
  const qty = floatOrZero(line.qty);
  let out;
  if (qty) out = uc + lineTax(line) / qty;
  else {
    const pct = safeFloat(line.tax_pct);
    out = uc * (1 + (pct || 0) / 100);
  }
  return Math.round(out * 1e4) / 1e4;
}

/**
 * Does this delivery line cost the job? The frontend creates a daily row the
 * moment a line has a quantity or a unit cost, and not before — an empty line
 * someone added and never filled in should not show up on the job's cost tab.
 */
function lineHasCost(line) {
  return Boolean(line && (line.qty || line.unit_cost));
}

// ── Deliveries recorded from Daily Tracking ─────────────────────────────────
// A job row that names one of its job's purchase orders and carries material
// IS a delivery on that order. Before, only the other direction existed — a
// line typed on an order minted its job row — so a foreman could pick PO-0003
// on a Daily Tracking row, key in 20 t at $16.00 under 02-100 / 0420, and the
// job was charged while PO-0003, on the division's tab and on central
// purchasing, still read "no deliveries".
//
// Those deliveries are lines tagged source:'daily' (id 'dr-<row id>',
// po_row_id = the row), and the SERVER is their only author. It derives them
// from daily_tracking, which is the truth for them, at three points:
//
//   syncRowsToOrders     after a job row is written or deleted (daily-rows.js)
//   deriveDailyLines     on every save of an order — the division tabs' list
//                        PUT and purchasing's single-order POST — so a copy
//                        from a tab that is a minute behind can neither put
//                        back a line whose row moved or went, nor drop one
//   reconcileDailyLines  once per page load, for rows entered before this
//
// One invariant follows: a Daily Tracking line exists exactly while its row
// exists in this division and names that order (on the order's job). No page
// adds or removes one, so a stale page has nothing to resurrect.
//
// The row is the field's. Nothing done to an order deletes it or re-codes it:
// deleting the order, moving its job or division, or emptying the line leaves
// the row on its job (its PO # then names an order that is not there, which
// the PO tab lists). Purchasing may still correct a delivery's quantity, unit
// cost, date or receiver — those reach the row — but only on a line it says it
// edited (`editedLineIds`), never from a copy it merely re-sent.

const DAILY_SOURCE = 'daily';

/** Was this delivery line recorded from a Daily Tracking row? */
function isDailyLine(line) {
  return Boolean(line && line.source === DAILY_SOURCE);
}

/** The line id a Daily Tracking row is recorded under: one per row, always. */
function dailyLineId(rowId) {
  return 'dr-' + String(rowId);
}

function normPONum(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * A job row's material, or null when it records no delivery: nothing bought,
 * or units × unit cost the row has not charged (a freshly copied row, whose
 * material cost the page blanks until it is next edited) — recording that
 * would put money on the order the job does not have.
 */
function rowMaterial(row) {
  if (!row) return null;
  const qty = floatOrZero(row.units_purchased);
  const uc  = floatOrZero(row.unit_cost);
  const mat = floatOrZero(row.material_cost);
  if (!qty && !uc && !mat) return null;
  if (!mat && Math.abs(qty * uc) >= 0.005) return null;
  return { qty, uc, mat };
}

/** Can this job row be a delivery? Payroll's rows are payroll's. */
function rowIsDelivery(row) {
  if (!row || row.row_id == null) return false;
  if (row.timesheet_entry_id != null) return false;
  if (isInjectedRowId(row.row_id)) return false;
  return rowMaterial(row) !== null;
}

// The pre-tax unit cost behind a unit cost that carries the line's tax — the
// inverse of lineUnitCostWithTax. A line with no tax_pct key is a legacy flat
// dollar tax, spread over the quantity.
function unitPreTax(ucWithTax, qty, line) {
  if (!line || line.tax_pct == null) {
    const t = line ? floatOrZero(line.tax) : 0;
    return qty ? ucWithTax - t / qty : ucWithTax;
  }
  const pct = safeFloat(line.tax_pct);
  return pct === null ? ucWithTax : ucWithTax / (1 + pct / 100);
}

// The pre-tax amount behind a total that carries the line's tax.
function amountPreTax(money, line) {
  if (!line || line.tax_pct == null) return money - (line ? floatOrZero(line.tax) : 0);
  const pct = safeFloat(line.tax_pct);
  return pct === null ? money : money / (1 + pct / 100);
}

// Four places, like daily_tracking.unit_cost — unless four would move the
// line's money by half a cent or more (a large quantity behind an imported
// total), when it keeps enough places to come to the row's money exactly.
function unitCostText(uc, qty) {
  if (!uc) return '';
  const r4 = Math.round(uc * 1e4) / 1e4;
  if (!qty || Math.abs((r4 - uc) * qty) < 0.005) return String(r4);
  return String(Math.round(uc * 1e8) / 1e8);
}

/**
 * The quantity and pre-tax unit cost a line needs to record `row`'s material,
 * given the line's own tax. The row's material cost is what the job is
 * charged, so the line comes to that money: a row whose unit cost built it is
 * taken at that unit cost, an imported total at whatever unit cost reaches it,
 * and a lump sum with no quantity as one unit. Null when the row records none.
 */
function lineFiguresFromRow(row, line) {
  const m = rowMaterial(row);
  if (!m) return null;
  let qty = m.qty, uc;
  if (m.mat) {
    if (!qty) { qty = 1; uc = amountPreTax(m.mat, line); }
    else if (Math.abs(qty * m.uc - m.mat) < 0.005) uc = unitPreTax(m.uc, qty, line);
    else uc = amountPreTax(m.mat, line) / qty;
  } else {
    uc = m.uc ? unitPreTax(m.uc, qty, line) : 0;
  }
  return {
    qty:       qty ? String(Math.round(qty * 1e6) / 1e6) : '',
    unit_cost: unitCostText(uc, qty),
  };
}

/**
 * Bring a line to its row. Returns true when the line changed.
 *
 * Quantity and unit cost move only when the row's actually differ from what
 * the line already charges — rewriting an unchanged figure would nudge it by
 * the rounding on every save. A percentage tax is re-taken on the new amount;
 * a legacy flat tax stays flat. A Daily Tracking line also carries the row's
 * cost / sub code, which is what the PO tab shows under it: the order's header
 * code is the order's own and can differ.
 */
function applyRowToLine(line, row, daily) {
  if (!line || !row) return false;
  let changed = false;
  const set = (k, v) => {
    const now = line[k] == null ? '' : String(line[k]);
    const to  = v == null ? '' : String(v);
    if (now !== to) { line[k] = v; changed = true; }
  };
  const f = lineFiguresFromRow(row, line);
  if (f) {
    const m = rowMaterial(row);
    const sameQty = Math.abs(floatOrZero(line.qty) - floatOrZero(f.qty)) < 1e-9;
    const sameMoney = m.mat
      ? Math.abs(lineAmt(line) + lineTax(line) - m.mat) < 0.005
      : Math.abs(floatOrZero(line.unit_cost) - floatOrZero(f.unit_cost)) < 5e-5;
    if (!sameQty) set('qty', f.qty);
    if (!sameQty || !sameMoney) set('unit_cost', f.unit_cost);
    if (line.tax_pct != null) {
      const pct = safeFloat(line.tax_pct);
      const t = pct === null ? 0 : lineAmt(line) * pct / 100;
      const now = floatOrZero(line.tax);
      if (Math.abs(now - t) >= 1e-9) set('tax', t ? String(t) : '');
    }
  }
  const d = safeDate(row.date);
  if (d) set('date', d);
  set('employee', row.employee || '');
  if (daily) {
    set('cost_code', row.cost_code || '');
    set('sub_code',  row.sub_code  || '');
  }
  return changed;
}

function newDailyLine(rowId) {
  return {
    id: dailyLineId(rowId), source: DAILY_SOURCE,
    invoice_num: '', date: '', qty: '', unit_cost: '', tax: '', tax_pct: '', employee: '',
    cost_code: '', sub_code: '', po_row_id: String(rowId),
  };
}

/** The order a row's PO # names: that number, on the row's own job. */
function orderForRow(list, row, aliases) {
  const want = normPONum(row && row.po_num);
  if (!want || !row.project_id) return null;
  return (list || []).find(po => po && po.project_id
    && String(po.project_id) === String(row.project_id)
    && (normPONum(po.po_number) === want
        || ((aliases && aliases.get(po.id)) || []).some(a => normPONum(a) === want))) || null;
}

function raisedRowIdsOf(list) {
  const out = new Set();
  (list || []).forEach(po => ((po && Array.isArray(po.lines)) ? po.lines : []).forEach(l => {
    if (l && !isDailyLine(l) && l.po_row_id) out.add(String(l.po_row_id));
  }));
  return out;
}

/**
 * Make the Daily Tracking lines of `list` exactly what `rows` say. Mutates the
 * orders in place; returns the ids of those it changed.
 *
 * `rows` must hold every row any of the scoped orders' Daily Tracking lines
 * names, and every row on those orders' jobs that carries a PO # — see
 * linkScope / fetchLinkRows. A named row missing from it is gone.
 *
 * opts.scope           order ids to derive (default: every order in `list`)
 * opts.aliases         order id → other numbers it answers to (a renumbered
 *                      order's rows still carry the old one until written)
 * opts.raisedRowIds    rows a line raised on an order outside `list` owns
 * opts.editedLineIds   lines purchasing edited: their figures stand
 */
function deriveDailyLines(list, rows, opts) {
  opts = opts || {};
  const changed = new Set();
  const scoped = po => po && (!opts.scope || opts.scope.has(po.id));
  // A row a raised line names is that line's delivery, wherever it sits.
  const raised = raisedRowIdsOf(list);
  (opts.raisedRowIds || []).forEach(id => raised.add(String(id)));
  const edited = opts.editedLineIds || new Set();

  const want = new Map();   // order id → rows it should carry
  for (const row of rows || []) {
    const rid = String(row.row_id);
    if (raised.has(rid) || !rowIsDelivery(row)) continue;
    const target = orderForRow(list, row, opts.aliases);
    if (!target || !scoped(target)) continue;
    if (!want.has(target.id)) want.set(target.id, []);
    want.get(target.id).push(row);
  }

  for (const po of list || []) {
    if (!scoped(po)) continue;
    const lines = Array.isArray(po.lines) ? po.lines : [];
    const wanted = want.get(po.id) || [];
    const wantedIds = new Set(wanted.map(r => String(r.row_id)));
    const seen = new Set();
    const kept = lines.filter(l => {
      if (!isDailyLine(l)) return true;
      const rid = l.po_row_id != null ? String(l.po_row_id) : '';
      if (!rid || !wantedIds.has(rid) || seen.has(rid)) return false;
      seen.add(rid);
      return true;
    });
    if (kept.length !== lines.length || !Array.isArray(po.lines)) { po.lines = kept; changed.add(po.id); }
    for (const row of wanted) {
      const rid = String(row.row_id);
      let line = po.lines.find(l => isDailyLine(l) && String(l.po_row_id) === rid);
      if (!line) {
        // An unlinked leftover under the same id would read as a second copy.
        po.lines = po.lines.filter(l => !(l && l.id === dailyLineId(rid)));
        line = newDailyLine(rid);
        po.lines.push(line);
        changed.add(po.id);
      }
      if (edited.has(String(line.id))) continue;
      if (applyRowToLine(line, row, true)) changed.add(po.id);
    }
  }
  return changed;
}

/**
 * Carry written or deleted job rows to the orders, in place. Returns the ids
 * of the orders changed. Every row id in `rowIds` is decided; one absent from
 * `rowsById` is gone from this division.
 *
 *  - a row a line raised on an order names: that line follows the row's
 *    figures, and is detached if the row was deleted (`deleted`). Its order
 *    owns its number, so the row's PO # is not consulted. Any Daily Tracking
 *    copy of it goes.
 *  - any other row: recorded on the order its PO # names on its job, once,
 *    and on no other — moved there with its invoice # and tax if it was on
 *    another, removed when it names none or stops carrying material.
 */
function applyRowsToOrders(list, rowsById, rowIds, opts) {
  const deleted = (opts && opts.deleted) || new Set();
  const changed = new Set();
  const take = (po, line) => {
    po.lines = (po.lines || []).filter(l => l !== line);
    changed.add(po.id);
  };
  for (const rid of [...new Set((rowIds || []).map(String))]) {
    const row = rowsById.get(rid) || null;
    const raised = [], daily = [];
    (list || []).forEach(po => ((po && Array.isArray(po.lines)) ? po.lines : []).forEach(l => {
      if (l && l.po_row_id != null && String(l.po_row_id) === rid) (isDailyLine(l) ? daily : raised).push({ po, line: l });
    }));

    if (raised.length) {
      daily.forEach(d => take(d.po, d.line));
      if (!row) {
        if (deleted.has(rid)) raised.forEach(r => { r.line.po_row_id = null; changed.add(r.po.id); });
        continue;
      }
      raised.forEach(r => { if (applyRowToLine(r.line, row, false)) changed.add(r.po.id); });
      continue;
    }

    const target = row && rowIsDelivery(row) ? orderForRow(list, row) : null;
    const keep = target ? (daily.find(d => d.po === target) || daily[0] || null) : null;
    daily.forEach(d => { if (d !== keep) take(d.po, d.line); });
    if (!target) continue;
    let line;
    if (keep && keep.po === target) line = keep.line;
    else if (keep) { take(keep.po, keep.line); line = keep.line; target.lines = (target.lines || []).concat([line]); changed.add(target.id); }
    else {
      (list || []).forEach(po => {
        if (po && Array.isArray(po.lines) && po.lines.some(l => l && l.id === dailyLineId(rid))) {
          po.lines = po.lines.filter(l => !(l && l.id === dailyLineId(rid)));
          changed.add(po.id);
        }
      });
      line = newDailyLine(rid);
      target.lines = (Array.isArray(target.lines) ? target.lines : []).concat([line]);
      changed.add(target.id);
    }
    if (applyRowToLine(line, row, true)) changed.add(target.id);
  }
  return changed;
}

/**
 * Drop a Daily Tracking line that names a job row a line raised on the same
 * order already names. Mutates `po`; returns how many went. One row is one
 * delivery: purchasing writes a row a moment before the order linking it, and
 * a row synced in that moment is recorded a second time. The raised line is
 * the original. deriveDailyLines makes the same call across a whole list.
 */
function dropShadowedDailyLines(po) {
  if (!po || !Array.isArray(po.lines)) return 0;
  const raised = raisedRowIdsOf([po]);
  if (!raised.size) return 0;
  const before = po.lines.length;
  po.lines = po.lines.filter(l => !(isDailyLine(l) && l.po_row_id && raised.has(String(l.po_row_id))));
  return before - po.lines.length;
}

/** What fetchLinkRows has to read to derive `list`'s Daily Tracking lines. */
function linkScope(list) {
  const rowIds = new Set(), projectIds = new Set();
  (list || []).forEach(po => {
    if (!po) return;
    if (po.project_id) projectIds.add(String(po.project_id));
    ((Array.isArray(po.lines) ? po.lines : [])).forEach(l => {
      if (isDailyLine(l) && l.po_row_id) rowIds.add(String(l.po_row_id));
    });
  });
  return { rowIds: [...rowIds], projectIds: [...projectIds] };
}

/**
 * The job rows a derivation needs: the ones named by id, and every row on the
 * named jobs that carries a PO #. Scoped to this company and division, so a row
 * in another division reads as gone — which it is, for this division's orders.
 */
async function fetchLinkRows(sql, companyCode, division, scope) {
  if (!PO_JOB_DIVISIONS.includes(division)) return [];
  const ids      = [...new Set(((scope && scope.rowIds) || []).map(String).filter(Boolean))];
  const projects = [...new Set(((scope && scope.projectIds) || []).map(String).filter(Boolean))];
  if (!ids.length && !projects.length) return [];
  return sql`
    SELECT row_id, project_id, date, employee, cost_code, sub_code, po_num,
           units_purchased, unit_cost, material_cost, timesheet_entry_id
    FROM daily_tracking
    WHERE company_code = ${companyCode} AND division = ${division}
      AND (row_id = ANY(${ids})
           OR (project_id = ANY(${projects}) AND COALESCE(TRIM(po_num), '') <> ''))
  `;
}

/**
 * After job rows are written or deleted: bring the division's orders into line
 * with them, under the compare-and-set. Returns { ok, orders } — the orders it
 * changed, for the page that wrote the rows to take on at once.
 *
 * Only rows that could matter are worth the read: the caller passes those that
 * carry a PO # before or after the write, and every deleted one.
 */
async function syncRowsToOrders(sql, { companyCode, division, rowIds, deletedIds }) {
  if (!PO_JOB_DIVISIONS.includes(division)) return { ok: true, orders: [] };
  const ids = [...new Set((rowIds || []).concat(deletedIds || []).map(String)
    .filter(id => id && !isInjectedRowId(id)))];
  if (!ids.length) return { ok: true, orders: [] };
  const rows = await fetchLinkRows(sql, companyCode, division, { rowIds: ids });
  const byId = new Map(rows.map(r => [String(r.row_id), r]));
  const deleted = new Set((deletedIds || []).map(String));
  let changedOrders = [];
  const res = await mutatePOBlob(sql, blobKeyFor(companyCode, division), list => {
    const next = JSON.parse(JSON.stringify(list));
    const changed = applyRowsToOrders(next, byId, ids, { deleted });
    if (!changed.size) { changedOrders = []; return null; }
    changedOrders = next.filter(po => po && changed.has(po.id));
    return next;
  });
  if (!res.ok) return { ok: false, orders: [] };
  for (const po of changedOrders) {
    try { await mirrorOnePO(sql, companyCode, division, po); }
    catch (err) { console.error('[po-sync] could not mirror an order after a row sync:', err.message); }
  }
  return { ok: true, orders: changedOrders };
}

/**
 * Derive every order's Daily Tracking lines from the job rows — the catch-up a
 * division page asks for once per load, which records rows entered before
 * this existed. The rows are re-read on every attempt, so an order raised
 * between attempts is derived against its own job's rows.
 */
async function reconcileDailyLines(sql, { companyCode, division }) {
  const key = blobKeyFor(companyCode, division);
  if (!PO_JOB_DIVISIONS.includes(division)) {
    return { ok: true, changed: [], list: (await readPOBlob(sql, key)).list };
  }
  let changedOrders = [];
  const res = await mutatePOBlob(sql, key, async list => {
    const rows = await fetchLinkRows(sql, companyCode, division, linkScope(list));
    const next = JSON.parse(JSON.stringify(list));
    const changed = deriveDailyLines(next, rows);
    if (!changed.size) { changedOrders = []; return null; }
    changedOrders = next.filter(po => po && changed.has(po.id));
    return next;
  });
  if (!res.ok) return { ok: false, changed: [], list: null };
  for (const po of changedOrders) {
    try { await mirrorOnePO(sql, companyCode, division, po); }
    catch (err) { console.error('[po-sync] could not mirror an order after a reconcile:', err.message); }
  }
  return { ok: true, changed: changedOrders.map(po => po.id), list: res.list };
}

/**
 * Write to the job rows what purchasing changed on Daily Tracking lines: the
 * figures of a line it edited, and the order's number where a row still
 * carries an old one. Only ever an UPDATE — a row that is gone stays gone —
 * scoped to the order's job and this division, and never a payroll row.
 */
async function writeDailyRows(sql, { companyCode, division, po, editedLineIds, rowsById }) {
  if (!po || !po.project_id || !PO_JOB_DIVISIONS.includes(division)) return 0;
  const edited = new Set((editedLineIds || []).map(String));
  let n = 0;
  for (const line of (Array.isArray(po.lines) ? po.lines : [])) {
    if (!isDailyLine(line) || !line.po_row_id) continue;
    const row = rowsById && rowsById.get(String(line.po_row_id));
    const renumber = row && String(row.po_num || '') !== String(po.po_number || '');
    if (edited.has(String(line.id))) {
      await sql`
        UPDATE daily_tracking SET
          units_purchased = ${floatOrZero(line.qty)},
          unit_cost       = ${lineUnitCostWithTax(line)},
          material_cost   = ${lineAmt(line) + lineTax(line)},
          date            = COALESCE(${safeDate(line.date)}::date, daily_tracking.date),
          employee        = ${line.employee || null},
          po_num          = ${po.po_number || null},
          updated_at      = NOW()
        WHERE company_code = ${companyCode} AND division = ${division}
          AND project_id = ${po.project_id} AND row_id = ${String(line.po_row_id)}
          AND timesheet_entry_id IS NULL
      `;
      n++;
    } else if (renumber) {
      await sql`
        UPDATE daily_tracking SET po_num = ${po.po_number || null}, updated_at = NOW()
        WHERE company_code = ${companyCode} AND division = ${division}
          AND project_id = ${po.project_id} AND row_id = ${String(line.po_row_id)}
          AND timesheet_entry_id IS NULL
      `;
      n++;
    }
  }
  return n;
}

// ── Who raised an order, and when ───────────────────────────────────────────
// created_at / created_by sit beside status_changed_at / status_changed_by and
// are shown in the same place, under the order's status. The page that raises
// an order stamps them, the same way a status change is stamped, so the line is
// on screen at once. What the server adds is that the stamp is written ONCE:
// every save carries the order whole, and a copy that lacked the stamp or said
// something else would otherwise overwrite who raised it.

/** An ISO timestamp for `v`, or null when it does not read as a time. */
function safeTimestamp(v) {
  if (v == null || v === '') return null;
  const t = Date.parse(String(v));
  return isNaN(t) ? null : new Date(t).toISOString();
}

const CREATION_KEYS = ['created_at', 'created_by'];

/**
 * Settle `po`'s creation stamp before it is stored. Mutates and returns `po`.
 *
 * `stored` is the copy of this order the server already holds, or null when
 * this save is the one that brings the order into being.
 *
 *  - Already stored: the stored stamp stands, whatever the request says — and
 *    an order stored without one (anything raised before the stamp existed)
 *    stays without one. Saving an order can neither rewrite who raised it nor
 *    claim an old one.
 *  - New: the page's own stamp is kept, so the order reads the same stored as
 *    it did on screen, and an order a stale tab puts back after a delete keeps
 *    the stamp it was raised with. A page that sent none — a tab still running
 *    the code from before this change — gets the signed-in user and the
 *    server's clock instead of no stamp at all.
 *
 * The page's word is taken for a new order's stamp exactly as it is for the
 * status byline beside it.
 */
function settleCreationStamp(po, stored, { username } = {}) {
  if (!po || typeof po !== 'object') return po;
  if (stored) {
    for (const k of CREATION_KEYS) {
      const v = stored[k];
      if (v != null && v !== '') { if (po[k] !== v) po[k] = v; }
      else if (k in po) delete po[k];
    }
    return po;
  }
  const at = safeTimestamp(po.created_at) || new Date().toISOString();
  if (po.created_at !== at) po.created_at = at;
  const sent = typeof po.created_by === 'string' ? po.created_by.trim().slice(0, 200) : '';
  const by = sent || String(username || '').trim();
  if (by) { if (po.created_by !== by) po.created_by = by; }
  else if ('created_by' in po) delete po.created_by;
  return po;
}

/**
 * The same for every order in a list about to replace `storedList` — the
 * division tabs' full-list save. Orders are matched to their stored copies by
 * id, and an order carried over from the stored list unchanged comes out as it
 * went in.
 */
function settleCreationStamps(list, storedList, ctx) {
  const byId = new Map();
  for (const p of (Array.isArray(storedList) ? storedList : [])) {
    if (p && p.id != null && !byId.has(String(p.id))) byId.set(String(p.id), p);
  }
  for (const po of (Array.isArray(list) ? list : [])) {
    if (!po || po.id == null) continue;
    settleCreationStamp(po, byId.get(String(po.id)) || null, ctx);
  }
  return list;
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
 * it has to derive everything from the list it is handed. It may be async —
 * reconcileDailyLines reads the job rows for the list it is handed.
 */
async function mutatePOBlob(sql, blobKey, mutate) {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const base = await readPOBlob(sql, blobKey);
    const next = await mutate(base.list);
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
  // The row's created_at is the order's own creation stamp when it has one. An
  // order raised before the stamp existed keeps the time its row was first
  // written, and created_by stays empty — see the fallback in
  // api/purchase-orders.js, which reports the one only alongside the other.
  const createdAt = safeTimestamp(po.created_at);
  await sql`
    INSERT INTO purchase_orders (
      id, company_code, division, po_num, title, supplier, project_id,
      cost_code, sub_code, status, notes, origin,
      date_created, status_changed_at, status_changed_by, updated_at,
      created_at, created_by
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
      NOW(),
      COALESCE(${createdAt}::timestamptz, NOW()),
      ${po.created_by     || null}
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
      updated_at         = NOW(),
      created_at         = COALESCE(${createdAt}::timestamptz, purchase_orders.created_at),
      created_by         = EXCLUDED.created_by
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
  const lines = Array.isArray(po.lines) ? po.lines : [];
  // Only turf, paving and kiewit keep a job ledger a purchase order can charge.
  // An order filed anywhere else carries no job: the general list by design,
  // quarry because it has no projects to charge, and every other division
  // because normalizeDivision accepts all sixteen and daily_tracking's own
  // CHECK admits six — so the INSERT would 500 with the raw constraint name,
  // after the DELETE above had already removed the rows for the old job. The
  // page clears the job when the division changes, but that is client-side: a
  // stale tab, a replayed request or any non-browser client with the same
  // token still sends one.
  if (!PO_JOB_DIVISIONS.includes(division) && po.project_id) po.project_id = '';
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
  //
  // Nor can it gain a link to one here. A po_row_id the stored order does not
  // already name came from the request, and returning before writeRow would
  // store it — after which it counts as owned, and emptying the line deletes
  // that row by id wherever it lives. The job path below never keeps such a
  // link; this is the same rule for an order with no job, which every quarry
  // order is.
  if (!projectId) {
    for (const line of lines) {
      if (line && line.po_row_id && !ownsRow(line.po_row_id)) line.po_row_id = null;
    }
    return { staleIds, written: 0, writtenIds: [], createdIds: [] };
  }

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
        ${floatOrZero(line.qty)}, ${lineUnitCostWithTax(line)}, ${cost}
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
async function upsertPO(sql, { companyCode, division, po, from, deletedLineIds, editedLineIds, username }) {
  const prevDivision = from && from !== division ? from : null;
  // syncPOCostRows makes the same call; made here first because the Daily
  // Tracking lines below are derived against the job the order is saved with.
  if (!PO_JOB_DIVISIONS.includes(division) && po.project_id) po.project_id = '';

  // Every list this order might already be stored in. The target's copy matters
  // as much as the source's after a move that half landed, when the order is in
  // both — see the ownership note in syncPOCostRows.
  const targetList = (await readPOBlob(sql, blobKeyFor(companyCode, division))).list;
  const targetCopy = targetList.find(p => p && p.id === po.id) || null;

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

  // Who raised it and when, from whichever copy is already stored — a move
  // carries the stamp with it. Only an order stored nowhere is new.
  settleCreationStamp(po, priorCopies.find(c => c.created_at) || priorCopies[0] || null, { username });

  // Deliveries somebody else added while this caller was holding a stale copy.
  // Merged back BEFORE the cost rows are reconciled, so their rows are not read
  // as belonging to deleted lines and swept away.
  const recovered = unseenLines(po, priorCopies, deletedLineIds);
  if (recovered.length) po.lines = (Array.isArray(po.lines) ? po.lines : []).concat(recovered);

  // The order's Daily Tracking lines are whatever its job's rows say — never
  // what this copy happened to carry. A purchasing tab a minute behind still
  // holds a line whose row has since moved to another order or been deleted;
  // sending it back used to re-attach the delivery here and, the stored order
  // no longer naming the row, mint the job a second one. A line purchasing says
  // it edited keeps its figures; those are written to the row once the order is
  // stored (writeDailyRows). A failed read leaves the lines as they came and the
  // save goes ahead: nothing below writes a Daily Tracking row's money from them.
  const edited = new Set((Array.isArray(editedLineIds) ? editedLineIds : []).map(String));
  const priorDailyIds = new Set();
  priorCopies.concat([po]).forEach(c => ((c && Array.isArray(c.lines)) ? c.lines : [])
    .forEach(l => { if (isDailyLine(l) && l.id) priorDailyIds.add(String(l.id)); }));
  let dailyRowsById = new Map();
  try {
    const rows = await fetchLinkRows(sql, companyCode, division, linkScope([po].concat(priorCopies)));
    dailyRowsById = new Map(rows.map(r => [String(r.row_id), r]));
    const aliases = new Map([[po.id, priorCopies.map(c => c && c.po_number).filter(Boolean)]]);
    deriveDailyLines([po], rows, {
      aliases,
      editedLineIds: edited,
      raisedRowIds: raisedRowIdsOf(targetList.filter(p => p && p.id !== po.id)),
    });
  } catch (err) {
    console.error('[po-sync] could not read the job rows behind Daily Tracking lines:', err.message);
    dropShadowedDailyLines(po);
  }

  // The job cost rows are the order's own deliveries' business. A Daily
  // Tracking line's row is the field's: it is never minted, re-pointed or
  // swept here — not when a line goes, not when the order moves job — so the
  // reconciliation sees the order without those lines. The line objects are
  // shared, so the links it mints land on the order itself.
  const raisedOnly = o => (o ? { ...o, lines: (Array.isArray(o.lines) ? o.lines : []).filter(l => !isDailyLine(l)) } : o);
  const raisedView = raisedOnly(po);
  const rows = await syncPOCostRows(sql, {
    companyCode, division, po: raisedView, prevPO: raisedOnly(prevPO), prevDivision,
    priorCopies: priorCopies.map(raisedOnly),
  });
  po.project_id = raisedView.project_id;

  // The new list is written FIRST, and only then is the old one emptied.
  // The reverse order has a window where the order is in neither list, and a
  // compare-and-set that runs out of attempts in that window loses it outright.
  // This way the worst case is a duplicate, which is visible, harmless to the
  // job's costs (the rows were already moved) and cleaned up by the retry.
  // The merge above ran against the list as it was at the TOP of this call, and
  // several round trips have happened since — syncPOCostRows alone is a handful,
  // and on a lost compare-and-set this mutator runs again over the winner's
  // list. A delivery recorded by somebody else inside that window is not in
  // `priorCopies`, so it was not merged, and replacing the order wholesale drops
  // it: the delivery is gone from the stored order, gone from po_deliveries, and
  // its daily_tracking row survives with nothing naming it — not even deleting
  // the order finds it, because removePO reads the row ids off the stored lines.
  // So merge again here, from the list actually being written over.
  let lateMerged = 0;
  const lateStale = [];
  // The same test syncPOCostRows makes, recomputed here because it is local to
  // that function. po.project_id has already been through its clearing pass, so
  // this reads the value the rows were actually reconciled against.
  const movedOrder = (Boolean(prevPO) && (prevPO.project_id || '') !== (po.project_id || ''))
    || (Boolean(prevDivision) && prevDivision !== division);
  const saved = await mutatePOBlob(sql, blobKeyFor(companyCode, division), list => {
    const idx = list.findIndex(p => p && p.id === po.id);
    if (idx === -1) return [...list, po];

    // Stored since the read at the top — the same new order's first save, from
    // another request, landing first. The stamp it was stored with stands.
    if (list[idx].created_at) settleCreationStamp(po, list[idx]);

    // Idempotent across retries: unseenLines skips any id already in po.lines.
    // A Daily Tracking line the copies read at the top already carried was
    // decided by the derivation above — dropped, if its row no longer names
    // this order — and does not come back through here. Only one a row sync
    // added since is new.
    const late = unseenLines(po, [list[idx]], deletedLineIds)
      .filter(l => !(isDailyLine(l) && priorDailyIds.has(String(l.id))));
    if (late.length) {
      lateMerged += late.length;
      // Normally the other writer's po_row_id is kept: that row is live and
      // correct for this delivery, and syncPOCostRows has already run, so
      // nothing here would reconcile a fresh one.
      //
      // Not when this save MOVED the order. writeRow's ON CONFLICT predicate
      // pins project_id and division, so a row sitting on the old job can never
      // be re-pointed at the new one — the UPDATE matches nothing, RETURNING
      // comes back empty, and the next save mints a SECOND row instead. Both
      // jobs then carry the delivery. So the link is cleared, and the row it
      // named goes out with the rest of the move's stale rows.
      //
      // A Daily Tracking line that arrived in the window was derived from its
      // row a moment ago and is kept as it is — unless the order moved, when
      // its row (on the old job) no longer names it. Its row is never swept.
      po.lines = (Array.isArray(po.lines) ? po.lines : []).concat(
        movedOrder
          ? late.filter(l => !isDailyLine(l)).map(l => {
              if (l && l.po_row_id && !isInjectedRowId(l.po_row_id)) lateStale.push(String(l.po_row_id));
              return { ...l, po_row_id: null };
            })
          : late);
      dropShadowedDailyLines(po);
    }

    // Replaced in place. The purchase-order tables sort by the time in the
    // order's id now, but an order whose id carries no time still falls back
    // to its place in the list, and moving it would churn every open tab's
    // poll comparison for nothing.
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
  try { removed = await deletePORows(sql, companyCode, (rows.staleIds || []).concat(lateStale)); }
  catch (err) { console.error('[po-sync] could not clear replaced cost rows:', err.message); }

  await mirrorOnePO(sql, companyCode, division, po);

  // What purchasing changed on Daily Tracking deliveries reaches their rows.
  try {
    await writeDailyRows(sql, { companyCode, division, po, editedLineIds: [...edited], rowsById: dailyRowsById });
  } catch (err) {
    console.error('[po-sync] could not write Daily Tracking deliveries to their rows:', err.message);
  }

  let staleCopy = false;
  if (prevDivision) {
    // The old list is re-read here, long after the copy this call merged from
    // was taken at the top — syncPOCostRows' round trips, the target write and
    // mirrorOnePO all happened in between, and that division's own tab still
    // shows the order for all of it, because this is what removes it. A
    // delivery recorded in that window is on the copy about to be filtered out
    // and on nothing else: it would go from the blob, and from po_deliveries
    // too, since mirrorOnePO has already re-inserted only the lines the new
    // list carries. Its cost row would then sit on the old job with nothing
    // naming it — no later save finds it, and neither does deleting the order.
    //
    // So look before dropping. Something unaccounted for means the move is not
    // finished: leave the copy where it is and report it, which is the same
    // answer a half-landed move already gives. The caller keeps its note, the
    // next save repeats the move, and by then the delivery is in priorCopies
    // and reconciled like any other.
    let leftBehind = 0;
    const dropped = await mutatePOBlob(sql, blobKeyFor(companyCode, prevDivision), list => {
      const hit = list.find(p => p && p.id === po.id) || null;
      if (!hit) return null;
      // Daily Tracking lines are derived from their rows, not carried: a move
      // leaves them behind on purpose, so they are never "unaccounted".
      const unaccounted = unseenLines(po, [hit], deletedLineIds).filter(l => !isDailyLine(l));
      if (unaccounted.length) { leftBehind = unaccounted.length; return null; }
      return list.filter(p => !p || p.id !== po.id);
    });
    // Saved, but the old division still shows a copy. The caller is told so it
    // can leave its "this order was last stored under X" note alone — the next
    // save then repeats the move and clears the copy. Reporting this as a
    // failure would be worse: the order IS saved, and a caller that retried
    // from scratch would raise a second one.
    staleCopy = !dropped.ok || leftBehind > 0;
    if (leftBehind) {
      console.warn(`[po-sync] ${leftBehind} delivery(s) reached ${po.id} in ${prevDivision} during its move; leaving the copy for the next save`);
    }
  }

  return {
    ok: true, purchaseOrder: po, staleCopy,
    // So the caller can show what it had not heard about, instead of silently
    // carrying on with a list it now knows is short.
    mergedLines: recovered.length + lateMerged,
    rows: { removed, written: rows.written, writtenIds: rows.writtenIds },
  };
}

/** Remove one purchase order, its deliveries, and the cost rows it created. */
async function removePO(sql, { companyCode, division, poId }) {
  // The copy the compare-and-set actually removed, captured inside the mutator.
  // Reading it from a snapshot taken beforehand meant a delivery recorded in
  // between — mutatePOBlob re-reads on every attempt, so the window is at least
  // one round trip and unbounded across retries — was not in the list whose row
  // ids get deleted here. Its daily_tracking row then survived the order that
  // named it, charging the job with nothing anywhere pointing at it: the exact
  // orphan this function exists to prevent.
  let existing = null;
  const removed = await mutatePOBlob(sql, blobKeyFor(companyCode, division), list => {
    const hit = list.find(p => p && p.id === poId) || null;
    if (!hit) { existing = null; return null; }
    existing = hit;
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

  // The rows the order's own deliveries made. A Daily Tracking line's row is
  // the field's entry on its job and stays there; its PO # then names an order
  // that is gone, which the division's PO tab lists.
  const rowIds = existing.lines && Array.isArray(existing.lines)
    ? existing.lines.filter(l => l && l.po_row_id && !isDailyLine(l)).map(l => l.po_row_id)
    : [];
  const gone = await deletePORows(sql, companyCode, rowIds);

  // ...and the mirror only when it is THIS division's copy being removed. A
  // half-landed move leaves the order in both lists on purpose, so `existing`
  // is truthy for the leftover copy too — and unmirrorPO scopes on id and
  // company alone, so clearing the leftover wiped the mirror of the order that
  // is live in the other division, taking its delivery rows with it.
  const mirror = await sql`
    SELECT division FROM purchase_orders
    WHERE id = ${poId} AND company_code = ${companyCode}
  `;
  if (!mirror.length || String(mirror[0].division) === String(division)) {
    await unmirrorPO(sql, companyCode, poId);
  }

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
  safeTimestamp,
  settleCreationStamp,
  settleCreationStamps,
  unseenLines,
  findPOInDivision,
  resolvePODocScope,
  blobKeyFor,
  lineAmt,
  lineTax,
  lineUnitCostWithTax,
  lineHasCost,
  isInjectedRowId,
  isDailyLine,
  dailyLineId,
  rowMaterial,
  rowIsDelivery,
  lineFiguresFromRow,
  applyRowToLine,
  deriveDailyLines,
  applyRowsToOrders,
  dropShadowedDailyLines,
  linkScope,
  fetchLinkRows,
  syncRowsToOrders,
  reconcileDailyLines,
  writeDailyRows,
  readPOBlob,
  mutatePOBlob,
  syncPOCostRows,
  mirrorOnePO,
  unmirrorPO,
  upsertPO,
  removePO,
};
