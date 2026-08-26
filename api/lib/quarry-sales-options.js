'use strict';
/**
 * The one option list on the Quarry Sales form that isn't in Manage Lists.
 *
 * Payment is a fixed pair, not a list anybody maintains: the quarry's Sales
 * Tracking tab has always offered exactly Cash or Credit, and a third value
 * would render as a blank cell in the grid the sale lands in. Kept here rather
 * than restated in the form, the submissions endpoint and quarry.html, because
 * a value that lives in only one of the three is one a worker can pick and
 * then be refused for picking.
 */
const PAYMENT_OPTIONS = ['Cash', 'Credit'];

module.exports = { PAYMENT_OPTIONS };
