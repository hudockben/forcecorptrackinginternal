'use strict';
/**
 * One reading of a number typed, pasted or scanned into a money field.
 *
 * Everything on the purchase-order path — the phone's scan sheet, the division
 * tabs' delivery rows, the figures the reader pulls off a photograph — arrives
 * as a STRING and is parsed with parseFloat somewhere downstream. parseFloat
 * stops at the first character it does not understand, which makes a comma
 * silently destructive rather than an error:
 *
 *   parseFloat('360,82')    === 360        the cents are gone
 *   parseFloat('1,234.56')  === 1          the thousands are gone
 *   parseFloat('1.234,56')  === 1.234
 *
 * and the receipt reader's own attempt to cope — stripping commas as thousands
 * separators — was worse, because it multiplies a decimal comma by a hundred:
 *
 *   '360,82'.replace(/,/g,'') -> '36082'   a hundred times the real amount
 *
 * A comma reaches these fields without anyone travelling: a phone whose region
 * is set to one that uses a decimal comma, a figure pasted from a supplier's
 * European invoice, a keyboard layout somebody picked up secondhand.
 *
 * The rule, in order:
 *   - currency symbols, spaces and thin spaces come off;
 *   - (123.45) is accounting notation for a negative;
 *   - with BOTH separators present, whichever comes LAST is the decimal one,
 *     which reads '1,234.56' and '1.234,56' correctly without being told a
 *     locale;
 *   - with only commas, a single comma trailed by one or two digits is a
 *     decimal comma; anything else is a thousands separator;
 *   - with only periods, the period stays a decimal point.
 *
 * The last two rules resolve the genuinely ambiguous cases — '1,234' and
 * '1.234' — the way a US crew means them, which is 1234 and 1.234. Everything
 * unambiguous is read correctly whichever convention wrote it.
 *
 * Returns a STRING for parseFloat to finish, or '' for nothing usable, so it
 * can sit in front of an existing parse without changing what that parse does
 * with a blank. purchase-orders.html carries a copy of this function; the test
 * suite runs both over the same table and fails if they ever disagree.
 */
function normalizeNumeric(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let t = String(v).trim().replace(/[\s '$£€]/g, '');
  if (!t) return '';

  const neg = /^\(.*\)$/.test(t);
  if (neg) t = t.slice(1, -1);

  const lastComma = t.lastIndexOf(',');
  const lastDot   = t.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');
    else                     t = t.replace(/,/g, '');
  } else if (lastComma > -1) {
    const tail = t.length - lastComma - 1;
    const once = t.indexOf(',') === lastComma;
    t = (once && tail >= 1 && tail <= 2) ? t.replace(',', '.') : t.replace(/,/g, '');
  }

  if (neg) t = '-' + t;
  return t;
}

/** parseFloat, with the reading above in front of it. NaN for nothing usable. */
function numeric(v) {
  return parseFloat(normalizeNumeric(v));
}

/** …and the same, as 0 rather than NaN, for the cost arithmetic. */
function numericOrZero(v) {
  const f = numeric(v);
  return isNaN(f) ? 0 : f;
}

module.exports = { normalizeNumeric, numeric, numericOrZero };
