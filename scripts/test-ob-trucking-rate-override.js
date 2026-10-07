#!/usr/bin/env node
'use strict';
/**
 * A payroll row's trucking rate can be corrected where it is billed — and
 * payroll stays the primary source of it.
 *
 * Run: node scripts/test-ob-trucking-rate-override.js
 *
 * Trucking $/hr on a "← Timesheet" Other Billing row comes from the approve
 * modal. It was read-only in the tab, so a rate typed wrong at approval meant
 * finding the entry in Payroll's Edit Row before the invoice could go out. The
 * box is open now, as an override kept beside payroll's figure — the same
 * shape as the price per gal/bag (scripts/test-ob-price-override.js) — with one
 * difference: when payroll's own rate changes, payroll's new figure wins.
 *
 * What this pins:
 *   1. the derivation (api/lib/dust-ob-injected.js) in isolation,
 *   2. payroll outranking an override on re-injection,
 *   3. a tab save (injected-blob-guard): the office's rate lands, clearing it
 *      sticks, and a tab that loaded before payroll changed the rate cannot
 *      put a dropped override back,
 *   4. the page (dust.html): its gate is the server's, and the box is wired to
 *      the override rather than to trucking_rate,
 *   5. the readers downstream still bill off trucking_rate.
 *
 * Re-injection end to end is in scripts/test-dust-ob-injection.js ("a trucking
 * rate the office set stands until payroll changes its own"); the rendered box
 * is in scripts/test-dust-ob-tab.js.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');

const {
  OB_TAB_FIELDS, OB_TRK_RATE_OVERRIDE, OB_TRK_RATE_PAYROLL, OB_TRK_RATE_MAX,
  normalizeObTruckingRate, sameObTruckingRate, applyObTruckingRateOverride,
  obTruckingRateOverrideOutranked, obTruckingRateOverrideStale, applyObOverrides,
} = require('../api/lib/dust-ob-injected.js');
const { guardConfigFor, mergeInjectedRows } = require('../api/lib/injected-blob-guard.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const read = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const DUST = read('dust.html');

// The page's override code, lifted out of dust.html and run for real. The
// trucking block leans on the price block's gate (_obPriceVal), so both are
// taken together.
function newPage(rows) {
  const start = DUST.indexOf("    const OB_PRICE_OVERRIDE = 'price_per_unit_override';");
  const end   = DUST.indexOf('    // The columns the dust office still owns on a payroll row');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('could not find the override blocks in dust.html');
  }
  const dom = new JSDOM('<input id="ob-trate-0"><div id="ob-trate-ovr-0"></div>');
  const sandbox = {
    console, document: dom.window.document,
    obRows: rows,
    saves: 0,
    obScheduleSave() { sandbox.saves++; },
    obRefreshCalcCells() {}, obRefreshTotals() {},
    obIsInjectedRow: r => /^tso-\d+-/.test(String((r && r.id) || '')),
    money: n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    rate4: n => '$' + Number(n).toFixed(4),
    esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  };
  vm.createContext(sandbox);
  vm.runInContext(DUST.slice(start, end), sandbox, { filename: 'dust.html' });
  return { page: sandbox, doc: dom.window.document };
}

(async () => {
  console.log('The manual trucking rate override — payroll primary, editable where it bills\n');

  // ── 1. The rules ─────────────────────────────────────────────────────────
  console.log('[the derivation]');
  {
    const ovr = row => applyObTruckingRateOverride({ id: 'tso-41-1', ...row });

    const over = ovr({ trucking_rate: 121, trucking_rate_override: '135' });
    assert('an override outranks payroll\'s rate', over.trucking_rate === 135);
    assert('and payroll\'s rate is kept behind it', over[OB_TRK_RATE_PAYROLL] === 121);

    const twice = applyObTruckingRateOverride({ ...over });
    assert('a second pass changes nothing',
      twice.trucking_rate === 135 && twice[OB_TRK_RATE_PAYROLL] === 121);

    const blank = ovr({ trucking_rate: '', trucking_rate_override: 95 });
    assert('an override rates a haul payroll left blank',
      blank.trucking_rate === 95 && blank[OB_TRK_RATE_PAYROLL] === '');

    const agreed = ovr({ trucking_rate: 121, trucking_rate_override: '121' });
    assert('an override that agrees with payroll is dropped',
      !(OB_TRK_RATE_OVERRIDE in agreed) && !(OB_TRK_RATE_PAYROLL in agreed)
      && agreed.trucking_rate === 121);

    const cleared = applyObTruckingRateOverride({ ...over, [OB_TRK_RATE_OVERRIDE]: '' });
    assert('clearing hands the rate back to payroll',
      cleared.trucking_rate === 121 && !(OB_TRK_RATE_OVERRIDE in cleared));

    for (const [what, v] of [['negative', -1], ['not a number', 'abc'],
                             ['past the ceiling', OB_TRK_RATE_MAX + 1]]) {
      const junk = ovr({ trucking_rate: 121, trucking_rate_override: v });
      assert(`an override that is ${what} is dropped, not honoured`,
        junk.trucking_rate === 121 && !(OB_TRK_RATE_OVERRIDE in junk), JSON.stringify(junk));
    }

    assert('$0 typed on purpose is a rate', normalizeObTruckingRate('0').value === 0);
    assert('a blank is not', normalizeObTruckingRate(' ').value === '');
    assert('the ceiling is what the NUMERIC(10,4) mirror column holds',
      OB_TRK_RATE_MAX === 999999.9999 && !!normalizeObTruckingRate(OB_TRK_RATE_MAX + 1).error);
    assert('the error names the trucking rate',
      /trucking_rate/.test(normalizeObTruckingRate(-1).error || ''));
    assert('the same rate from a blob and from payroll is the same rate',
      sameObTruckingRate('121', 121) && !sameObTruckingRate('121', 135));

    // The price override is untouched by the trucking one, and vice versa.
    const both = applyObOverrides({ id: 'tso-41-1', price_per_unit: 0.42, trucking_rate: 121,
      price_per_unit_override: 1.28, trucking_rate_override: 135 });
    assert('both overrides settle in the one call',
      both.price_per_unit === 1.28 && both.trucking_rate === 135
      && both.price_per_unit_payroll === 0.42 && both[OB_TRK_RATE_PAYROLL] === 121);
  }

  // ── 2. Payroll is primary ────────────────────────────────────────────────
  console.log('\n[payroll outranks an override when its own rate changes]');
  {
    const prev = { trucking_rate: 135, [OB_TRK_RATE_OVERRIDE]: 135, [OB_TRK_RATE_PAYROLL]: 121 };
    assert('an unchanged payroll rate leaves the override standing',
      obTruckingRateOverrideOutranked(prev, '121') === false);
    assert('a changed payroll rate outranks it',
      obTruckingRateOverrideOutranked(prev, 140) === true);
    assert('Edit Row saving the posted rate (adoption) counts as a change, and agrees anyway',
      obTruckingRateOverrideOutranked(prev, 135) === true);
    assert('a row with no override standing is never outranked',
      obTruckingRateOverrideOutranked({ trucking_rate: 121 }, 140) === false);
    assert('and no prior row means nothing to outrank',
      obTruckingRateOverrideOutranked(null, 140) === false);
  }

  // ── 3. A tab save ────────────────────────────────────────────────────────
  console.log('\n[the tab may write the override, and nothing else on the row]');
  {
    const cfg = guardConfigFor('dust_other_billing_rows');
    assert('the override is one of the office\'s columns',
      OB_TAB_FIELDS.includes(OB_TRK_RATE_OVERRIDE));
    assert('the rate itself is not', !OB_TAB_FIELDS.includes('trucking_rate'));
    assert('the guard settles both overrides', cfg.derive === applyObOverrides);

    const server = [{ id: 'tso-41-1', customer: 'CNX', gallons_bags: 387, price_per_unit: 1.28,
                      trucking_hrs: 2.5, trucking_rate: 121, inv_number: '' }];

    // The office types 135 — the page records payroll's 121 beside it.
    const [landed] = mergeInjectedRows(server, [{ ...server[0], trucking_rate: 135,
      [OB_TRK_RATE_OVERRIDE]: 135, [OB_TRK_RATE_PAYROLL]: 121, trucking_hrs: 99 }], cfg);
    assert('the office\'s rate lands',
      landed.trucking_rate === 135 && landed[OB_TRK_RATE_OVERRIDE] === 135);
    assert('with payroll\'s rate behind it', landed[OB_TRK_RATE_PAYROLL] === 121);
    assert('while payroll\'s columns are still the server\'s', landed.trucking_hrs === 2.5);

    const [smuggled] = mergeInjectedRows(server, [{ ...server[0], trucking_rate: 999 }], cfg);
    assert('a raw trucking_rate in the save is ignored', smuggled.trucking_rate === 121);

    // An older client never sends the field and must not clear a standing one.
    const held = [{ ...server[0], trucking_rate: 135,
                    [OB_TRK_RATE_OVERRIDE]: 135, [OB_TRK_RATE_PAYROLL]: 121 }];
    const [kept] = mergeInjectedRows(held, [{ ...server[0], trucking_rate: 135 }], cfg);
    assert('an older client cannot drop one it never sent',
      kept.trucking_rate === 135 && kept[OB_TRK_RATE_OVERRIDE] === 135);

    // Clearing: the page leaves an explicit blank, and that reaches the server.
    const [handed] = mergeInjectedRows(held,
      [{ ...server[0], trucking_rate: 121, [OB_TRK_RATE_OVERRIDE]: '' }], cfg);
    assert('clearing the box hands the rate back to payroll',
      handed.trucking_rate === 121 && !(OB_TRK_RATE_OVERRIDE in handed)
      && !(OB_TRK_RATE_PAYROLL in handed));

    // Typing payroll's own figure over a standing override is a clear too.
    const [typedBack] = mergeInjectedRows(held,
      [{ ...server[0], trucking_rate: 121, [OB_TRK_RATE_OVERRIDE]: '' }], cfg);
    assert('typing payroll\'s figure back clears it as well',
      typedBack.trucking_rate === 121 && !(OB_TRK_RATE_OVERRIDE in typedBack));

    // The stale tab: it loaded the row while the override (135 over 121) stood.
    // Payroll then retyped the rate as 140 in Edit Row, which dropped the
    // override. The tab, unaware, saves its copy back on an unrelated edit.
    const afterPayroll = [{ ...server[0], trucking_rate: 140 }];
    const staleSave = [{ ...held[0], inv_number: 'INV-9' }];
    assert('the stale save is recognised as stale',
      obTruckingRateOverrideStale(staleSave[0], afterPayroll[0]) === true);
    const [stale] = mergeInjectedRows(afterPayroll, staleSave, cfg);
    assert('it cannot put the dropped override back — payroll\'s 140 stands',
      stale.trucking_rate === 140 && !(OB_TRK_RATE_OVERRIDE in stale), JSON.stringify(stale));
    assert('while its unrelated edit still lands', stale.inv_number === 'INV-9');

    // The same stale tab clearing the box is harmless and goes through.
    const [staleClear] = mergeInjectedRows(afterPayroll,
      [{ ...server[0], trucking_rate: 121, [OB_TRK_RATE_OVERRIDE]: '' }], cfg);
    assert('a clear from a stale tab leaves payroll\'s rate', staleClear.trucking_rate === 140);

    // A stale tab must not wipe an override another device set on top of
    // payroll's new figure either: the server's own override is kept.
    const otherDevice = [{ ...server[0], trucking_rate: 150,
                           [OB_TRK_RATE_OVERRIDE]: 150, [OB_TRK_RATE_PAYROLL]: 140 }];
    const [kept2] = mergeInjectedRows(otherDevice, staleSave, cfg);
    assert('a stale save leaves another device\'s override standing',
      kept2.trucking_rate === 150 && kept2[OB_TRK_RATE_OVERRIDE] === 150
      && kept2[OB_TRK_RATE_PAYROLL] === 140, JSON.stringify(kept2));
  }

  // ── 4. The page ──────────────────────────────────────────────────────────
  console.log('\n[the tab renders a box, and it is wired to the override]');
  {
    const locked = { id: 'tso-41-1', customer: 'CNX', gallons_bags: 387,
                     price_per_unit: 1.28, trucking_hrs: 2.5, trucking_rate: 121 };
    const manual = { id: 'm8x2p1', customer: 'CNX', trucking_rate: '110' };
    const { page, doc } = newPage([locked, manual]);

    page.obSetTruckingRateOverride(0, '135');
    assert('typing a rate stores an override, not a rate',
      locked[OB_TRK_RATE_OVERRIDE] === 135 && locked.trucking_rate === 135);
    assert('payroll\'s rate is kept beside it', locked[OB_TRK_RATE_PAYROLL] === 121);
    assert('and the edit is saved', page.saves === 1);

    const note = doc.getElementById('ob-trate-ovr-0').innerHTML;
    assert('the note says the rate was set here', /set here/.test(note), note);
    assert('and what payroll has', /payroll \$121\.00/.test(note), note);
    assert('with one click back to it', /obClearTruckingRateOverride\(0\)/.test(note), note);

    // What the page then saves is what the guard needs to land the rate.
    const [stored] = mergeInjectedRows(
      [{ ...locked, trucking_rate: 121, [OB_TRK_RATE_OVERRIDE]: undefined }].map(r => {
        const c = { ...r }; delete c[OB_TRK_RATE_OVERRIDE]; delete c[OB_TRK_RATE_PAYROLL]; return c;
      }),
      [JSON.parse(JSON.stringify(locked))], guardConfigFor('dust_other_billing_rows'));
    assert('and the save it makes lands on the server', stored.trucking_rate === 135);

    page.obClearTruckingRateOverride(0);
    assert('clearing takes payroll\'s rate back', locked.trucking_rate === 121);
    assert('leaving an explicit blank for the save',
      locked[OB_TRK_RATE_OVERRIDE] === '' && !(OB_TRK_RATE_PAYROLL in locked));
    assert('the note goes with it', page._obTrkRateNote(locked, 0) === '');
    assert('and the box shows payroll\'s rate', doc.getElementById('ob-trate-0').value === '121');

    const before = page.saves;
    page.obSetTruckingRateOverride(0, '-5');
    assert('a negative rate is refused', locked.trucking_rate === 121 && page.saves === before);
    page.obSetTruckingRateOverride(0, 'abc');
    assert('so is one that is not a number', locked.trucking_rate === 121 && page.saves === before);

    page.obSetTruckingRateOverride(1, '9.99');
    assert('a hand-added row is not overridden',
      manual.trucking_rate === '110' && !(OB_TRK_RATE_OVERRIDE in manual));

    for (const [what, v] of [['a blank', ''], ['spaces', '  '], ['zero', '0'],
                             ['four decimals', '121.12345'], ['the ceiling', OB_TRK_RATE_MAX],
                             ['past it', OB_TRK_RATE_MAX + 1], ['a negative', -1], ['a word', 'abc']]) {
      const srv = normalizeObTruckingRate(v);
      const pg  = page._obPriceVal(v);
      assert(`the page reads ${what} exactly as the server does`,
        srv.error ? pg === null : pg === srv.value, `${JSON.stringify(pg)} vs ${JSON.stringify(srv)}`);
    }
  }

  // ── 5. Everything downstream still bills off trucking_rate ───────────────
  console.log('\n[the readers never learn about any of this]');
  {
    const AUDIT   = read('api/lib/dust-ob-audit.js');
    const METRICS = read('api/lib/dust-metrics.js');
    const IC      = read('intercompany.html');
    const TS      = read('api/timesheet-entries.js');
    assert('the tab\'s trucking total reads trucking_rate',
      /const rate  = parseFloat\(row\.trucking_rate\)\s+\|\| 0;/.test(DUST));
    assert('the Intercompany tab reads it', /parseFloat\(e\.trucking_rate\)/.test(IC));
    assert('so do the division metrics', /num\(row && row\.trucking_rate\)/.test(METRICS));
    assert('the audit log diffs the rate the row bills at', /'trucking_rate',/.test(AUDIT));
    assert('and not the bookkeeping behind it',
      !AUDIT.includes(OB_TRK_RATE_OVERRIDE) && !AUDIT.includes(OB_TRK_RATE_PAYROLL));
    assert('Edit Row is pre-filled from the posted (derived) rate',
      /trucking_rate:\s+n\(r\.trucking_rate\),/.test(TS));
    assert('re-injection lets payroll outrank a carried override',
      /if \(obTruckingRateOverrideOutranked\(prev, row\.trucking_rate\)\) delete row\[OB_TRK_RATE_OVERRIDE\];/.test(TS));
    assert('and settles both overrides before storing', /applyObOverrides\(row\);/.test(TS));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
