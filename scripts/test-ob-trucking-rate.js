#!/usr/bin/env node
'use strict';
/**
 * The Other Billing trucking rate, pre-filled from the customer's default.
 *
 * Run: node scripts/test-ob-trucking-rate.js
 *
 * An Other Billing row bills two things: the material, at quantity × price, and
 * the hauling of it, at hours × a rate. The material's price is the load's. The
 * RATE is the customer's — the same figure every delivery for that company is
 * hauled at — and it was the one number on the row nobody could set once. Every
 * delivery had it typed in again from whatever the last one said, in the dust
 * tab and in payroll's approve modal alike, and a delivery that went out with
 * the box empty billed the hauling at nothing.
 *
 * So it now lives beside the customer's name in the dust office's Manage Lists,
 * next to the two vehicle rates and the UB price, and is read from there by both
 * ends. The rule is the haul fee's, deliberately parallel — read FORWARD ONLY
 * onto a rate still blank, because re-pricing a customer must never restate a
 * delivery already invoiced, with a marker so that re-pointing a haul at another
 * customer swaps that customer's rate in rather than billing them at the last
 * one's price.
 *
 * Three layers:
 *   1. Structural — the rate is stored, carried and offered: the column, the
 *      route that reads and writes it, the two payloads that hand it to payroll,
 *      the box in the dust customer editor, and the marker never going on the
 *      wire.
 *   2. The dust tab — the forward-only rule as the Other Billing grid applies it
 *      when a customer is named on a row.
 *   3. Behavioural — payroll's own leg model, run for real in a vm against a
 *      stubbed DOM: what gets filled, what is left alone, and what follows a
 *      haul re-pointed at somebody else.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
function slice(src, from, to, label) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : to})`);
  return src.slice(a, b);
}

const SRC     = read('payroll.html');
const DUST    = read('dust.html');
const CONFIG  = read('api/dust-config.js');
const ENTRIES = read('api/timesheet-entries.js');
const SCHEMA  = read('neon-schema.sql');

console.log('The Other Billing trucking rate\n');

// ── 1. Structural ──────────────────────────────────────────────────────────
console.log('[the rate is stored beside the customer]');
{
  // Beside the rates that were already there, in the table that already holds
  // them — a rate is a fact about the customer, like the two vehicle defaults
  // and the UB price.
  assert('the column is on dust_companies',
    /trucking_rate NUMERIC\(10,4\)/.test(SCHEMA));
  assert('and is added to a database that predates it',
    /ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS trucking_rate NUMERIC\(10,4\)/.test(SCHEMA)
    && /ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS trucking_rate NUMERIC\(10,4\)/.test(CONFIG));
  assert('the route hands it back with the other two',
    /trucking_rate: co\.trucking_rate != null \? parseFloat\(co\.trucking_rate\) : null/.test(CONFIG));
  assert('and writes it back on a save',
    /INSERT INTO dust_companies \(id, company_code, name, tier, v1_rate, v2_rate, ub_rate,\s*\n\s*trucking_rate, sort_order\)/.test(CONFIG)
    && /trucking_rate = EXCLUDED\.trucking_rate/.test(CONFIG));
}

console.log('\n[…and reaches payroll on both paths]');
{
  // The modal reads two customer sources: the entry's own customer, and the
  // directory every OTHER customer on a split day comes from. A rate on one and
  // not the other would fill the box on an unsplit day and leave it blank the
  // moment the day was split.
  assert('the timesheet customer\'s own lookup selects it',
    (ENTRIES.match(/SELECT id, name, v1_rate, v2_rate, trucking_rate FROM dust_companies/g) || []).length >= 2);
  assert('and the options it returns carry it',
    /trucking_rate: co && co\.trucking_rate != null \? Number\(co\.trucking_rate\) : null/.test(ENTRIES));
  assert('the customer directory selects it too',
    /sql`SELECT id, name, v1_rate, v2_rate, trucking_rate FROM dust_companies/.test(ENTRIES));
  assert('and hands it back per company',
    /trucking_rate: c\.trucking_rate != null \? Number\(c\.trucking_rate\) : null/.test(ENTRIES));
  // The column is added lazily, by whichever of the dust page's own config loads
  // happens first — and an approval can beat it there, on a database that
  // predates it. Selecting it by name would then throw inside the request that
  // has to roll the approval back, so both readers ensure it, once per cold
  // start, exactly as the executive report ensures ub_rate before reading it.
  assert('and both readers ensure the column before selecting it',
    /ALTER TABLE IF EXISTS dust_companies ADD COLUMN IF NOT EXISTS trucking_rate NUMERIC\(10,4\)/.test(ENTRIES)
    && (ENTRIES.match(/await ensureDustTruckingRateColumn\(sql\);/g) || []).length === 2);
  assert('and a database that will not take the column fails the read, not the approval',
    /_dustTruckingRateColEnsured = true;\s*\n\s*\} catch \(err\) \{/.test(ENTRIES));
  assert('payroll reads it off whichever customer the haul names',
    /trucking_rate: o\.trucking_rate != null \? o\.trucking_rate : null/.test(SRC)
    && /trucking_rate: hit\.trucking_rate != null \? hit\.trucking_rate : null/.test(SRC));
  // An unknown customer is not an error — the boxes are free text and save as
  // typed — it just has no rate to offer.
  assert('and an unknown customer offers none',
    /return \{ name: want, known: false, v1_rate: null, v2_rate: null, trucking_rate: null,/.test(SRC));
}

console.log('\n[the box in the dust customer editor]');
{
  const row = slice(DUST, 'class="company-rates-row"', '</div>', 'the customer rates row');
  assert('it sits with V1, V2 and the UB price', /Hauling \$\/hr/.test(row));
  assert('and writes through the same setter they do',
    /updateCompanyRate\('\$\{co\.id\}','trucking_rate',this\.value\)/.test(row));
  assert('the setter takes any rate field, so it needed no change',
    /function updateCompanyRate\(coId, field, rawValue\)/.test(DUST)
    && /co\[field\] = isNaN\(f\) \? null : f;/.test(DUST));
  assert('a blank box clears the rate rather than storing 0',
    /if \(trimmed === ''\) \{\s*\n\s*co\[field\] = null;/.test(DUST));
}

console.log('\n[the marker stays on this side of the wire]');
{
  // obRateFromCo is bookkeeping about where a number came from, not a column.
  // In HAUL_FIELDS it would be blanked on every fresh leg and, worse, offered
  // to the server as an answer.
  const fields = slice(SRC, 'const HAUL_FIELDS = [', '];', 'HAUL_FIELDS');
  assert('the rate itself is a field a leg sends', /trucking_rate/.test(fields));
  assert('the marker is not', !/obRateFromCo/.test(fields));
  const save = slice(SRC, 'body.dust = {', 'const names = [];', 'the save payload');
  assert('and no leg carries it into the save', !/obRateFromCo/.test(save));
}

console.log('\n[called wherever the box can appear or its customer change]');
{
  // Four moments: the haul becomes a delivery, the delivery changes hands, the
  // customer directory lands, and a haul is added below one.
  const dest = slice(SRC, 'function haulSetDest(', 'function haulAddLeg', 'haulSetDest');
  assert('pointing a haul at Other Billing fills it', /haulObRateApply\(\);/.test(dest));
  const company = slice(SRC, 'function haulSetCompany(', 'function haulSetDest', 'haulSetCompany');
  assert('re-pointing the haul at another customer swaps it',
    /haulObRateApply\(\);/.test(company));
  const opts = slice(SRC, 'function dustApplyOptions(', 'function haulApplyTruckRows', 'dustApplyOptions');
  assert('the directory landing late still fills it', /haulObRateApply\(\);/.test(opts));
  const add = slice(SRC, 'function haulAddLeg(', 'function haulRemoveLeg', 'haulAddLeg');
  assert('and a haul added below a delivery is another delivery',
    /haulObRateApply\(\);/.test(add));
  assert('typing over the rate drops the marker',
    (SRC.match(/if \(field === 'trucking_rate'\) leg\.obRateFromCo = '';/g) || []).length === 2);
}

// ── 2. The dust tab's own copy of the rule ─────────────────────────────────
// Extracted and run, rather than grepped: this is the arithmetic that decides
// whether a number in the box is the last customer's or a person's.
console.log('\n[naming a customer on an Other Billing row]');
{
  // The real block, run with the grid's DOM and totals stubbed out: what is
  // being tested is which of three answers the row gets, and that is arithmetic
  // rather than markup.
  const body = slice(DUST, '      {\n        const cur          = obRows[idx].trucking_rate;',
                           '      if (tr) {', 'the OB rate fill');
  const decide = (cur, oldRate, newRate) => {
    const ctx = {
      obRows: [{ trucking_rate: cur }], idx: 0, tr: null,
      oldCo: oldRate === null ? null : { trucking_rate: oldRate },
      co:    newRate === null ? null : { trucking_rate: newRate },
      obRefreshCalcCells() {}, obRefreshTotals() {},
    };
    vm.createContext(ctx);
    vm.runInContext(body, ctx);
    return ctx.obRows[0].trucking_rate;
  };
  assert('a blank box takes the new customer\'s rate', decide('', null, 95) === '95');
  assert('so does one still holding the last customer\'s', decide('80', 80, 95) === '95');
  assert('and it matches on value, not on spelling', decide('80.00', 80, 95) === '95');
  assert('a hand-typed rate is left alone', decide('77', 80, 95) === '77');
  assert('and so is a rate on a row whose old customer had none',
    decide('77', null, 95) === '77');
  assert('a customer with no rate blanks nothing it did not fill',
    decide('77', 80, null) === '77');
  assert('but does clear its own number, rather than billing the old customer\'s',
    decide('80', 80, null) === '');
  assert('a row nobody has priced under a customer with no rate stays blank',
    decide('', null, null) === '');
  assert('the row is only touched when a customer is really named',
    /if \(obIsInjectedRow\(obRows\[idx\]\)\) return;/.test(
      slice(DUST, 'function obSetCustomer(', 'function obSetDestination', 'obSetCustomer')));
  assert('and the payroll rows locked in this tab are never re-priced by it',
    /const oldCo = \(dustLists\.companies \|\| \[\]\)\.find/.test(DUST));
}

// ── 3. Behavioural — payroll's own leg model ───────────────────────────────
console.log('\n[payroll\'s approve modal]');
function makeSandbox({ entry, options, companies }) {
  const els = new Map();
  const mount = id => {
    if (!els.has(id)) els.set(id, {
      id, value: '', textContent: '', innerHTML: '', style: {},
      focus() {}, setSelectionRange() {},
    });
    return els.get(id);
  };
  const ctx = {
    truckingEntry: entry,
    truckingMode:  'approve',
    truckingFieldsHtml: () => '',
    truckingNoteRefresh: () => {},
    truckUnitHintRefresh: () => {},
    truckFeeHintRefresh: () => {},
    truckCustomerRoster: () => [],
    escapeHtml: s => String(s == null ? '' : s),
    num2: n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2),
    TK_LABEL: '', TK_INPUT: '',
    // The trucking office's rates, which price the HAUL FEE on a material haul
    // and have nothing to do with this one. Left empty so nothing here can be
    // passing because of them.
    truckLists: { units: [], customers: [], rates: {} },
    document: { activeElement: null, getElementById: id => (els.has(id) ? els.get(id) : null) },
    console,
  };
  mount('truckingFields');
  vm.createContext(ctx);
  vm.runInContext(slice(SRC, '    const truckUnitRoster     = ()',
                             '    // ── The hauls a day is split into', 'the roster accessors'), ctx);
  vm.runInContext(slice(SRC, '    const EES_JOB_IDS =',
                             '    function truckingFieldsHtml(', 'entryNeedsTrucking'), ctx);
  vm.runInContext(slice(SRC, '    // ── The hauls a day is split into',
                             "    const TK_LABEL = 'display:flex", 'the haul model'), ctx);
  const run = code => vm.runInContext(code, ctx);
  ctx.__opts = options;
  ctx.__cos  = companies;
  run('dustOptions = __opts; dustCompanies = __cos; haulLegs = [haulFreshLeg(null)];');
  return {
    run, mount,
    legs: () => run('haulLegs'),
    call: (fn, ...args) => { ctx.__args = args; return run(`${fn}(...__args)`); },
    rate: (i = 0) => run('haulLegs')[i].trucking_rate,
  };
}

const DUST_ENTRY = {
  id: 88, division: 'dust', entry_type: 'daily', job_id: 'cnx', job_label: 'CNX',
  username: 'barrmike', truck_unit: '4000',
  start_time: '06:00', end_time: '17:30', computed_hours: 11.5, travel_hours: 0,
};
// The timesheet customer, and one other the day could be split onto.
const OPTIONS   = { company: 'CNX', known: true, v1_rate: 150, v2_rate: 95,
                    trucking_rate: 110, men: [], locations: [], equipment: [], usual_vehicle2: '' };
const COMPANIES = [
  { name: 'CNX',    v1_rate: 150, v2_rate: 95, trucking_rate: 110, men: [], locations: [] },
  { name: 'Antero', v1_rate: 140, v2_rate: 90, trucking_rate: 125, men: [], locations: [] },
  { name: 'Range',  v1_rate: 130, v2_rate: 85, trucking_rate: null, men: [], locations: [] },
];

{
  const s = makeSandbox({ entry: DUST_ENTRY, options: OPTIONS, companies: COMPANIES });
  // A dust day opens on the tracking grid — UB on a pad — which has no trucking
  // rate at all. The box does not exist, so neither does the question.
  assert('a UB haul is not given a rate it has nowhere to put',
    s.call('haulObRateApply') === false && s.rate() === '');
  // Pointing it at Other Billing is what puts the box on screen.
  s.call('haulSetDest', s.legs()[0].key, 'ob');
  assert('pointing the haul at a delivery fills the rate in', s.rate() === '110');
  assert('and running again changes nothing',
    s.call('haulObRateApply') === false && s.rate() === '110');
  // …and pointing it back takes the question away again, without losing what
  // was typed: the leg keeps its Other Billing columns either way.
  s.call('haulSetDest', s.legs()[0].key, 'dust');
  assert('flipping it back to UB keeps the number for if it comes back',
    s.rate() === '110');
}

console.log('\n[what it will not touch]');
{
  const typed = () => {
    const s = makeSandbox({ entry: DUST_ENTRY, options: OPTIONS, companies: COMPANIES });
    s.call('haulSetDest', s.legs()[0].key, 'ob');
    s.call('haulEdit', s.legs()[0].key, 'trucking_rate', '99');
    return s;
  };
  const s = typed();
  assert('a rate the approver typed is theirs',
    s.call('haulObRateApply') === false && s.rate() === '99');
  // The marker is what tells one from the other, and typing drops it.
  assert('and the marker goes with it', s.legs()[0].obRateFromCo === '');

  // A delivery already posted comes back at the price it was invoiced at.
  const posted = makeSandbox({ entry: DUST_ENTRY, options: OPTIONS, companies: COMPANIES });
  posted.run("haulLegs = [haulLegFromDustRow({ company: 'CNX', dest: 'ob', trucking_rate: '85' })];");
  assert('a rate read back off a posted row is left alone',
    posted.call('haulObRateApply') === false && posted.rate() === '85');
  assert('…and stays left alone on the next pass too',
    posted.call('haulObRateApply') === false && posted.rate() === '85');
}

console.log('\n[re-pointing a delivery at somebody else]');
{
  const s = makeSandbox({ entry: DUST_ENTRY, options: OPTIONS, companies: COMPANIES });
  s.call('haulSetDest', s.legs()[0].key, 'ob');
  assert('it starts on the timesheet customer\'s rate', s.rate() === '110');
  s.call('haulSetCompany', s.legs()[0].key, 'Antero');
  assert('and the new customer is billed at their own',
    s.rate() === '125', s.rate());
  s.call('haulSetCompany', s.legs()[0].key, 'Range');
  assert('a customer with no rate set clears it rather than keeping the last one\'s',
    s.rate() === '');
  s.call('haulSetCompany', s.legs()[0].key, 'CNX');
  assert('and coming back fills it again', s.rate() === '110');

  // But only ever its own number: a price somebody typed is not the rate
  // table's to swap out from under them.
  const t = makeSandbox({ entry: DUST_ENTRY, options: OPTIONS, companies: COMPANIES });
  t.call('haulSetDest', t.legs()[0].key, 'ob');
  t.call('haulEdit', t.legs()[0].key, 'trucking_rate', '77');
  t.call('haulSetCompany', t.legs()[0].key, 'Antero');
  assert('a typed rate survives the customer changing under it', t.rate() === '77');
}

console.log('\n[a day split across two deliveries]');
{
  const s = makeSandbox({ entry: DUST_ENTRY, options: OPTIONS, companies: COMPANIES });
  s.call('haulSetDest', s.legs()[0].key, 'ob');
  s.call('haulAddLeg');
  assert('the day is now two hauls', s.legs().length === 2);
  assert('and the second is a delivery too', s.legs()[1].dest === 'ob');
  assert('carrying the same customer\'s rate', s.rate(1) === '110');
  s.call('haulSetCompany', s.legs()[1].key, 'Antero');
  assert('until it is pointed at another customer', s.rate(1) === '125');
  assert('which leaves the first haul exactly where it was', s.rate(0) === '110');
}

console.log('\n[a haul that bills nobody, and one that bills the trucking office]');
{
  // The third destination: hours tracked on EES Other, invoiced to no one. It
  // has no trucking rate box either.
  const s = makeSandbox({ entry: DUST_ENTRY, options: OPTIONS, companies: COMPANIES });
  s.call('haulSetDest', s.legs()[0].key, 'ees');
  assert('a non-billable haul is given no rate',
    s.call('haulObRateApply') === false && s.rate() === '');

  // And a trucking day has no dust half at all: no Other Billing, no box.
  const t = makeSandbox({
    entry: { ...DUST_ENTRY, division: 'trucking', job_label: 'CNX' },
    options: null, companies: null,
  });
  assert('a trucking day is not asked the question',
    t.call('haulObRateApply') === false && t.rate() === '');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
