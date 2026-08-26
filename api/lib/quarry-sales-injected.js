'use strict';
/**
 * Identity + lifecycle rules for the Sales Tracking rows the Quarry Sales
 * division injects.
 *
 * Quarry Sales is the field side of the quarry's Sales Tracking tab, the same
 * shape as Timesheet → Payroll and Fuel Submissions → Fuel Admin: whoever is
 * running the scale fills in one short form per load — date, pit, who sold it,
 * the customer, the product, the tons and how it was paid — and submitting it
 * posts a row into the office's Sales Tracking grid. Those seven answers are
 * exactly the seven columns the grid opens with, so nothing is retyped and
 * nothing is spelled two ways: every one of them but the tons is picked from
 * the quarry's own Manage Lists, which is what the grid's own comboboxes read.
 *
 * The office still owns the money. Price per ton is not asked for on the form —
 * the scale house sells what the office priced — so it stays an empty, editable
 * cell on the injected row, and sales tax, net sales and total due follow from
 * it and from the customer exactly as they do on a row typed in by hand.
 *
 * The rules live here rather than inside api/quarry-sales-submissions.js
 * because api/lib/injected-blob-guard.js needs them too: Sales Tracking saves
 * the whole blob on a debounce, so without the guard the next keystroke
 * anywhere in the grid would erase a sale submitted while the tab was open.
 * A second copy of "which rows are the field's" is exactly the kind of drift
 * that stranded rows on the trucking side.
 */

// The blob the quarry Sales Tracking tab reads and writes whole.
const QUARRY_SALES_BLOB = 'fct_quarry_sales';

/**
 * The columns the office owns on a row the field owns.
 *
 * An injected sale renders locked in Sales Tracking — everything the form
 * asked for is the submitter's — except the price, which the office fills in
 * and which the form never collects. Re-injection preserves it and a tab save
 * may overwrite it; the same list governs both, because the two drifting apart
 * is how an office edit survives one path and not the other.
 */
const SALES_TAB_FIELDS = ['pricePerTon'];

// Every row injected from one submission shares this prefix, so a delete can
// find it again. "qss-" (quarry sales submission) rather than the timesheet
// "tsq-": both land in quarry blobs, and a sweep written for one of them must
// not look like it matched the other's rows in code that sees both.
function salesRowIdPrefix(submissionId) { return `qss-${submissionId}-`; }

/**
 * The canonical blob-row id for a submission.
 *
 * Stable, not stamped with Date.now(): a submission has exactly one sale in it,
 * so the submission's own id is what identifies the row. A fresh id on every
 * write would leave the office's price behind on an orphan and post the
 * corrected sale beside it as a duplicate.
 */
function salesRowId(submissionId) { return `${salesRowIdPrefix(submissionId)}row`; }

// The submission a "qss-<id>-row" came from, or null when the id isn't one of
// ours. Rows typed into the tab use Date.now() + a random tail, so they cannot
// collide with the prefix.
function submissionIdFromSalesRowId(rowId) {
  const m = /^qss-(\d+)-row$/.exec(String(rowId || ''));
  return m ? Number(m[1]) : null;
}

// True when this blob row was posted by a Quarry Sales submission.
function isQuarrySalesRow(row) {
  return !!row && typeof row === 'object' && String(row.id || '').startsWith('qss-');
}

module.exports = {
  QUARRY_SALES_BLOB,
  SALES_TAB_FIELDS,
  salesRowIdPrefix,
  salesRowId,
  submissionIdFromSalesRowId,
  isQuarrySalesRow,
};
