#!/usr/bin/env node
'use strict';
/**
 * An unpriced delivery can be priced where it is billed.
 *
 * Run: node scripts/test-ob-price-override.js
 *
 * A "← Timesheet" row in the dust Other Billing grid is payroll's: every column
 * on it is rewritten from the timesheet entry, and the tab renders them
 * read-only. The price per gal/bag was one of them — and it is the one field
 * where that cost more than it protected. A delivery approved with no price
 * (nobody typed one in the approve modal, and the material has no rate standing
 * behind it) lands in the tab blank: the customer is invoiced for the trucking
 * hours and the material goes out free. Other Billing is where somebody
 * notices, because it is where the invoice comes out of, and fixing it meant
 * finding the entry in Payroll, un-approving it, re-approving it with a price,
 * and hoping nothing else on the day had moved in between.
 *
 * The price box is now open on a locked row, as an OVERRIDE rather than a
 * takeover:
 *
 *   - what the office types is stored as price_per_unit_override, beside
 *     payroll's own figure (price_per_unit_payroll) rather than on top of it,
 *   - price_per_unit — the column the material total, the unpriced tally,
 *     Intercompany billing, the audit diff and payroll's own Edit Row all read
 *     — is DERIVED from the pair, at both writers, so none of them has to know
 *     any of this,
 *   - payroll goes on owning the price: it can still correct one from the
 *     entry, the row says so when the two disagree, and clearing the box hands
 *     the number back.
 *
 * What this pins:
 *   1. the derivation (api/lib/dust-ob-injected.js) — the rules, in isolation,
 *   2. a tab save (injected-blob-guard) — the office's number lands, and the
 *      rest of the row is still the server's,
 *   3. the page (dust.html) — its gate is the server's gate, and the box is
 *      wired to the override rather than to price_per_unit,
 *   4. the readers downstream — all of them still price off the one column.
 *
 * The other writer, re-injection, is pinned where its harness already lives:
 * "a price the office set is not restated by a re-approval" in
 * scripts/test-dust-ob-injection.js. The rendered DOM — a real box on a locked
 * row, beside a hand-added row that is merely editable — is in
 * scripts/test-dust-ob-tab.js.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');

const {
  OB_TAB_FIELDS, OB_PRICE_OVERRIDE, OB_PRICE_PAYROLL, OB_PRICE_MAX,
  normalizeObPrice, sameObPrice, applyObPriceOverride,
} = require('../api/lib/dust-ob-injected.js');
const {
  guardConfigFor, mergeInjectedRows,
} = require('../api/lib/injected-blob-guard.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const read = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const DUST = read('dust.html');

/**
 * The page's own copy of the derivation, lifted out of dust.html and run for
 * real. Greping for it would pass on a block that throws; this exercises the
 * same functions the browser calls, against a stub row and a stub DOM.
 */
function newPage(rows) {
  const start = DUST.indexOf("    const OB_PRICE_OVERRIDE = 'price_per_unit_override';");
  const end   = DUST.indexOf('    // The columns the dust office still owns on a payroll row');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('could not find the price-override block in dust.html');
  }
  const dom = new JSDOM('<div id="ob-price-ovr-0"></div>');
  const sandbox = {
    console, document: dom.window.document,
    obRows: rows,
    saves: 0,
    obScheduleSave() { sandbox.saves++; },
    obRefreshCalcCells() {}, obRefreshTotals() {},
    obIsInjectedRow: r => /^tso-\d+-/.test(String((r && r.id) || '')),
    rate4: n => '$' + Number(n).toLocaleString('en-US',
      { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
    esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  };
  vm.createContext(sandbox);
  vm.runInContext(DUST.slice(start, end), sandbox, { filename: 'dust.html' });
  return { page: sandbox, doc: dom.window.document };
}

(async () => {
  console.log('The manual price override — pricing a payroll row from the tab it is billed in\n');

  // ── 1. The rules ─────────────────────────────────────────────────────────
  console.log('[the derivation]');
  {
    const ovr = (row) => applyObPriceOverride({ id: 'tso-41-1', ...row });

    const priced = ovr({ price_per_unit: '', price_per_unit_override: '1.42' });
    assert('an override prices a delivery payroll left blank', priced.price_per_unit === 1.42);
    assert('and payroll\'s blank is recorded behind it', priced[OB_PRICE_PAYROLL] === '');

    const over = ovr({ price_per_unit: 0.42, price_per_unit_override: 1.42 });
    assert('an override outranks payroll\'s number', over.price_per_unit === 1.42);
    assert('and payroll\'s number is kept, not lost', over[OB_PRICE_PAYROLL] === 0.42);

    // Idempotent: the guard runs this on a row it just took from the database,
    // so a second pass must not read the override as payroll's own figure.
    const twice = applyObPriceOverride({ ...over });
    assert('a second pass changes nothing',
      twice.price_per_unit === 1.42 && twice[OB_PRICE_PAYROLL] === 0.42);

    const agreed = ovr({ price_per_unit: 1.42, price_per_unit_override: '1.42' });
    assert('an override that agrees with payroll is dropped',
      !(OB_PRICE_OVERRIDE in agreed) && !(OB_PRICE_PAYROLL in agreed));
    assert('and the row bills that same figure', agreed.price_per_unit === 1.42);

    const cleared = applyObPriceOverride({ ...over, [OB_PRICE_OVERRIDE]: '' });
    assert('clearing the override hands the price back to payroll',
      cleared.price_per_unit === 0.42 && !(OB_PRICE_OVERRIDE in cleared));

    const none = ovr({ price_per_unit: 0.42 });
    assert('a row with no override is left as payroll wrote it',
      none.price_per_unit === 0.42 && !(OB_PRICE_PAYROLL in none));

    // Junk cannot arrive from the tab, which validates first, so it means a
    // hand-edited blob or an older client. Inventing a price from it is the one
    // outcome worse than ignoring it.
    for (const [what, v] of [['negative', -1], ['not a number', 'abc'],
                             ['past the ceiling', OB_PRICE_MAX + 1]]) {
      const junk = ovr({ price_per_unit: 0.42, price_per_unit_override: v });
      assert(`an override that is ${what} is dropped, not honoured`,
        junk.price_per_unit === 0.42 && !(OB_PRICE_OVERRIDE in junk), JSON.stringify(junk));
    }

    // A price somebody means, and one nobody typed, are different answers.
    assert('$0 typed on purpose is a price', normalizeObPrice('0').value === 0);
    assert('a blank is not', normalizeObPrice('').value === '');
    assert('and neither is a box holding only spaces', normalizeObPrice('   ').value === '');
    assert('the ceiling is what the NUMERIC(10,4) columns hold',
      OB_PRICE_MAX === 999999.9999 && !!normalizeObPrice(OB_PRICE_MAX + 1).error);
    assert('the same price from a blob and from payroll is the same price',
      sameObPrice('1.42', 1.42) === true && sameObPrice('1.42', 0.42) === false);
    assert('four decimals are kept, as the column does',
      normalizeObPrice('1.42579').value === 1.4258);
  }

  // ── 2. A tab save ────────────────────────────────────────────────────────
  console.log('\n[the tab may write the override, and nothing else on the row]');
  {
    const cfg = guardConfigFor('dust_other_billing_rows');
    assert('the override is one of the office\'s columns',
      OB_TAB_FIELDS.includes(OB_PRICE_OVERRIDE));
    // The override, never price_per_unit: this list is also what re-injection
    // PRESERVES, so a price on it could never be corrected from the timesheet
    // again.
    assert('the price itself is not', !OB_TAB_FIELDS.includes('price_per_unit'));

    const server = [{
      id: 'tso-41-1', customer: 'CNX', destination: 'Bear Hollow', material: 'ClearFrac',
      gallons_bags: 4000, mu: 'GAL', price_per_unit: '', trucking_hrs: 10,
      trucking_rate: 95, inv_number: '', comments: 'two loads',
    }];
    // What the tab sends: the office priced the delivery. Everything else in
    // this save is the stale copy it read before payroll last wrote.
    const incoming = [{
      ...server[0], customer: 'Somebody Else', gallons_bags: 1,
      price_per_unit: 99, price_per_unit_override: '1.42', inv_number: 'INV-2210',
    }];
    const [merged] = mergeInjectedRows(server, incoming, cfg);
    assert('the office\'s price lands', merged.price_per_unit === 1.42);
    assert('recorded as an override', merged[OB_PRICE_OVERRIDE] === 1.42);
    assert('with payroll\'s blank behind it', merged[OB_PRICE_PAYROLL] === '');
    assert('and the invoice number lands with it', merged.inv_number === 'INV-2210');
    assert('while payroll\'s columns are still the server\'s',
      merged.customer === 'CNX' && merged.gallons_bags === 4000);

    // The derived column is recomputed from the server's row rather than taken
    // from the client — which is the whole point of the guard. A save that
    // carries a price_per_unit nobody may write cannot smuggle one in.
    const [smuggled] = mergeInjectedRows(server,
      [{ ...server[0], price_per_unit: 99 }], cfg);
    assert('a raw price in the save is ignored', smuggled.price_per_unit === '');

    // A client too old to know about any of this saves the row as it read it,
    // and must not clear an override standing on the server's copy.
    const held = [{ ...server[0], price_per_unit: 1.42,
                    [OB_PRICE_OVERRIDE]: 1.42, [OB_PRICE_PAYROLL]: '' }];
    const [kept] = mergeInjectedRows(held, [{ ...server[0], price_per_unit: 1.42 }], cfg);
    assert('and an older client cannot drop one it never sent',
      kept.price_per_unit === 1.42 && kept[OB_PRICE_OVERRIDE] === 1.42);

    // Clearing it is a deliberate empty override, which is a value the tab does
    // send — so it goes through, unlike the omission above.
    const [handed] = mergeInjectedRows(held,
      [{ ...server[0], [OB_PRICE_OVERRIDE]: '' }], cfg);
    assert('but clearing the box hands the price back to payroll',
      handed.price_per_unit === '' && !(OB_PRICE_OVERRIDE in handed));
  }

  // ── 3. The page ──────────────────────────────────────────────────────────
  console.log('\n[the tab renders a box, and it is wired to the override]');
  {
    const locked = { id: 'tso-41-1', customer: 'CNX', gallons_bags: 4000,
                     price_per_unit: '', trucking_hrs: 10, trucking_rate: 95 };
    const manual = { id: 'm8x2p1', customer: 'CNX', gallons_bags: 500,
                     price_per_unit: '0.42' };
    const { page, doc } = newPage([locked, manual]);

    page.obSetPriceOverride(0, '1.42');
    assert('typing a price stores an override, not a price',
      locked[OB_PRICE_OVERRIDE] === 1.42 && locked.price_per_unit === 1.42);
    assert('payroll\'s blank is kept behind it', locked[OB_PRICE_PAYROLL] === '');
    assert('and the edit is saved', page.saves === 1);

    // Labelled, not bare: an unlabelled number under a price box reads as the
    // price. Payroll's figure, once it has one, is what the note offers back.
    locked[OB_PRICE_PAYROLL] = 0.42;
    doc.getElementById('ob-price-ovr-0').innerHTML = page._obPriceNote(locked, 0);
    const note = doc.getElementById('ob-price-ovr-0').innerHTML;
    assert('a disagreement says the price was set here', /set here/.test(note), note);
    assert('and whose the other number is', /payroll \$0\.4200/.test(note), note);
    assert('with one click back to it', /obClearPriceOverride\(0\)/.test(note), note);

    page.obClearPriceOverride(0);
    assert('clearing the box takes payroll\'s price back', locked.price_per_unit === 0.42);
    assert('and drops the receipt',
      !(OB_PRICE_OVERRIDE in locked) && !(OB_PRICE_PAYROLL in locked));
    assert('the note goes with it', page._obPriceNote(locked, 0) === '');

    // Junk is refused rather than saved — the server would drop it, and a price
    // that vanishes on the next load is the failure this is meant to prevent.
    const before = page.saves;
    page.obSetPriceOverride(0, '-5');
    assert('a negative price is refused',
      locked.price_per_unit === 0.42 && page.saves === before);
    page.obSetPriceOverride(0, 'abc');
    assert('so is one that is not a number',
      locked.price_per_unit === 0.42 && page.saves === before);

    page.obSetPriceOverride(0, '0');
    assert('$0 typed on purpose is stored',
      locked.price_per_unit === 0 && locked[OB_PRICE_OVERRIDE] === 0);

    // Not offered on a row the tab owns outright: there the price IS the price,
    // and wrapping it in an override would shadow a column nothing else on a
    // hand-added row uses.
    page.obSetPriceOverride(1, '9.99');
    assert('a hand-added row is not overridden, it is just edited',
      manual.price_per_unit === '0.42' && !(OB_PRICE_OVERRIDE in manual));

    // The page's gate has to be the server's gate, or the tab accepts a figure
    // the guard then drops — a price that disappears on the next load.
    for (const [what, v] of [['a blank', ''], ['spaces', '  '], ['zero', '0'],
                             ['four decimals', '1.42579'], ['the ceiling', OB_PRICE_MAX],
                             ['past it', OB_PRICE_MAX + 1], ['a negative', -1],
                             ['a word', 'abc']]) {
      const srv = normalizeObPrice(v);
      const pg  = page._obPriceVal(v);
      assert(`the page reads ${what} exactly as the server does`,
        srv.error ? pg === null : pg === srv.value, `${JSON.stringify(pg)} vs ${JSON.stringify(srv)}`);
    }
    assert('and its ceiling is the same number',
      /const OB_PRICE_MAX = 999999\.9999;/.test(DUST));
  }

  // ── 4. Everything downstream still prices off the one column ─────────────
  console.log('\n[the readers never learn about any of this]');
  {
    const AUDIT   = read('api/lib/dust-ob-audit.js');
    const METRICS = read('api/lib/dust-metrics.js');
    const IC      = read('intercompany.html');

    assert('the tab\'s own material total reads price_per_unit',
      /const price = parseFloat\(row\.price_per_unit\)\s+\|\| 0;/.test(DUST));
    assert('so does the Intercompany mirror it sends',
      /price_per_unit: row\.price_per_unit/.test(DUST));
    assert('and the Intercompany tab that receives it',
      /parseFloat\(e\.price_per_unit\)/.test(IC));
    assert('so do the division metrics', /num\(row && row\.price_per_unit\)/.test(METRICS));
    assert('and the unpriced tally that flags a free delivery',
      /!num\(r\.price_per_unit\)/.test(METRICS));

    // The audit diffs price_per_unit, so an override shows up in the log as the
    // price change it is. The two receipt columns are deliberately not on that
    // list: logging them would report the same change twice.
    assert('the audit log records the price the row bills at',
      /'price_per_unit',/.test(AUDIT));
    assert('and not the bookkeeping behind it',
      !AUDIT.includes(OB_PRICE_OVERRIDE) && !AUDIT.includes(OB_PRICE_PAYROLL));

    // The grid is a JSON blob, so the two columns ride inside it with no schema
    // to migrate — but only if the blob endpoint runs the guard that derives
    // them. test-injected-blob-guard.js pins the wiring; this pins the reason.
    const KEYROUTE = read('api/data/[key].js');
    assert('the blob endpoint guards the write the override arrives in',
      /guardInjectedBlobWrite\(/.test(KEYROUTE));
    assert('and audits what was stored rather than what was sent',
      /auditObChanges\(sql, payload, _obOldValue, stored\)/.test(KEYROUTE));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
