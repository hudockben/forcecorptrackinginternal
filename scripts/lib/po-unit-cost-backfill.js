'use strict';
/**
 * Decisions for scripts/backfill-po-unit-cost-tax.js — which job cost rows get
 * their unit cost rewritten, and which are reported and left alone.
 *
 * A taxed purchase-order delivery used to put the tax on the job's cost row as
 * part of material_cost but leave the pre-tax price in unit_cost: 63.82 t at
 * $16.00 reading $1,082.39. Deliveries now write the unit cost with tax folded
 * in (lineUnitCostWithTax in api/lib/po-sync.js). This brings the rows written
 * before that into line.
 *
 * The rule the whole plan is built around: MATERIAL COST NEVER CHANGES. A row is
 * rewritten only when it still holds exactly what the delivery put there — the
 * delivery's quantity, its pre-tax price, and its tax-inclusive total — so the
 * new unit cost is the only thing that moves and units × unit cost comes back
 * to the dollars the job is already carrying. Anything else is reported:
 *
 *   taxMissing  the row's material cost is units × the pre-tax price, so the
 *               tax has already fallen off the job (the cost tab re-derives
 *               material cost from those two whenever either is edited). Fixing
 *               it changes what the job is charged, which is a decision for a
 *               person — re-entering the tax % on the PO line puts it back.
 *   drift       the row's quantity, unit cost or material cost matches neither
 *               the delivery nor the old write. Someone edited it on the cost
 *               tab; their figure is left alone.
 *   outOfScope  the row is on a different job, division or company than the
 *               order, or payroll owns it.
 *   ambiguous   two stored copies of the order (a move that half landed) want
 *               different figures for the same row.
 *   missing     the order names a row that does not exist.
 */

const { lineAmt, lineTax, lineUnitCostWithTax, lineHasCost, isInjectedRowId } =
  require('../../api/lib/po-sync');
const { numeric } = require('../../api/lib/numeric');

const BLOB_MARK = ':fct_purchase_orders:';

// daily_tracking stores unit_cost and units_purchased at four places, so a
// figure that round-trips can come back up to half a unit in the fourth place
// away from what was written.
const UNIT_TOL  = 1e-4;
const MONEY_TOL = 0.01;

const n0   = v => { const f = numeric(v); return isNaN(f) ? 0 : f; };
const near = (a, b, tol) => Math.abs(a - b) < tol;

/** "FC:fct_purchase_orders:paving" → { companyCode: 'FC', division: 'paving' } */
function parseBlobKey(key) {
  const k = String(key || '');
  const at = k.indexOf(BLOB_MARK);
  if (at <= 0) return null;
  return { companyCode: k.slice(0, at), division: k.slice(at + BLOB_MARK.length) };
}

/**
 * Every taxed delivery that names a cost row, from the stored order lists.
 *
 * Untaxed deliveries are skipped outright: their pre-tax price IS the unit cost
 * with tax, so there is nothing to change. Grouped by company + row id, because
 * an order caught mid-move is stored in two lists and both copies name the row.
 */
function collectCandidates(blobs, { company } = {}) {
  const byRow = new Map();
  for (const blob of (blobs || [])) {
    const where = parseBlobKey(blob && blob.key);
    if (!where) continue;
    if (company && where.companyCode !== company) continue;
    const list = Array.isArray(blob.value) ? blob.value : [];
    for (const po of list) {
      if (!po || !po.project_id || !Array.isArray(po.lines)) continue;
      for (const line of po.lines) {
        if (!line || !line.po_row_id || !lineHasCost(line)) continue;
        if (isInjectedRowId(line.po_row_id)) continue;
        const tax = lineTax(line);
        if (!tax) continue;
        const rowId = String(line.po_row_id);
        const key = where.companyCode + '|' + rowId;
        if (!byRow.has(key)) byRow.set(key, { companyCode: where.companyCode, rowId, copies: [] });
        const amt = lineAmt(line);
        byRow.get(key).copies.push({
          division:  where.division,
          projectId: String(po.project_id),
          poNumber:  po.po_number || '',
          supplier:  po.supplier || '',
          invoice:   line.invoice_num || '',
          date:      line.date || '',
          qty:       n0(line.qty),
          preTax:    n0(line.unit_cost),
          amt,
          tax,
          total:     amt + tax,
          target:    lineUnitCostWithTax(line),
        });
      }
    }
  }
  return [...byRow.values()];
}

/**
 * Sort each candidate against the cost row it names.
 *
 * `rows` is daily_tracking as read: { row_id, company_code, division,
 * project_id, units_purchased, unit_cost, material_cost, timesheet_entry_id }.
 */
function planBackfill(candidates, rows) {
  const rowById = new Map((rows || []).map(r => [String(r.row_id), r]));
  const plan = { fixes: [], already: [], taxMissing: [], drift: [], outOfScope: [], ambiguous: [], missing: [] };

  for (const c of (candidates || [])) {
    const row = rowById.get(c.rowId);
    const base = { companyCode: c.companyCode, rowId: c.rowId, delivery: c.copies[0] };
    if (!row) { plan.missing.push(base); continue; }

    if (String(row.company_code) !== c.companyCode || row.timesheet_entry_id != null) {
      plan.outOfScope.push({ ...base, row, why: row.timesheet_entry_id != null ? 'payroll owns this row' : 'row belongs to another company' });
      continue;
    }
    // The copy whose job and division the row is actually on. The same scoping
    // the live sync writes under, so nothing here reaches a row it would not.
    const mine = c.copies.filter(d => d.division === String(row.division) && d.projectId === String(row.project_id));
    if (!mine.length) {
      plan.outOfScope.push({ ...base, row, why: 'row is on a different job or division than the order' });
      continue;
    }
    if (mine.some(d => !near(d.target, mine[0].target, UNIT_TOL / 2))) {
      plan.ambiguous.push({ ...base, row, copies: mine });
      continue;
    }

    const d = mine[0];
    const item = { ...base, delivery: d, row,
      cur:   n0(row.unit_cost),
      units: n0(row.units_purchased),
      mat:   n0(row.material_cost),
    };

    if (near(item.cur, d.target, UNIT_TOL / 2)) { plan.already.push(item); continue; }
    if (!near(item.units, d.qty, UNIT_TOL)) {
      plan.drift.push({ ...item, why: `row quantity ${item.units} ≠ delivery ${d.qty}` });
      continue;
    }
    if (!near(item.cur, d.preTax, UNIT_TOL)) {
      plan.drift.push({ ...item, why: `row unit cost ${item.cur} ≠ delivery price ${d.preTax}` });
      continue;
    }
    if (near(item.mat, d.total, MONEY_TOL)) { plan.fixes.push(item); continue; }
    if (near(item.mat, d.amt, MONEY_TOL))   { plan.taxMissing.push(item); continue; }
    plan.drift.push({ ...item, why: `row material cost ${item.mat.toFixed(2)} ≠ delivery ${d.total.toFixed(2)} (or ${d.amt.toFixed(2)} pre-tax)` });
  }
  return plan;
}

module.exports = { BLOB_MARK, UNIT_TOL, parseBlobKey, collectCandidates, planBackfill };
