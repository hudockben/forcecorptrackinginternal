#!/usr/bin/env node
'use strict';
/**
 * The haul fee, pre-filled from the customer's rate.
 *
 * Run: node scripts/test-haul-fee-rate-prefill.js
 *
 * What a company is billed per hour is set once, beside its name in the Trucking
 * division's Manage Lists, and the tab already drops it onto a row the moment you
 * name a customer on one. Payroll approves the same work from the other end and
 * used to ask for the number again — so a day hauled for Kinkead got whatever the
 * approver remembered, or read off last week's row, or left blank.
 *
 * This holds the two ends together. The rule is the tab's own, and it is a rule
 * about SAFETY as much as convenience: a rate is read FORWARD ONLY, onto a fee
 * still blank, because re-pricing a customer must never silently restate a haul
 * that has already been invoiced. Payroll's copy adds one thing the tab does not
 * need — it remembers the number it filled in (`feeFromRate`), so re-pointing a
 * haul at another customer swaps that customer's rate in rather than billing them
 * at the last one's price. Everything else on screen it leaves alone, for good.
 *
 * Three layers:
 *   1. Structural — the rates reach payroll at all (the ?lists=1 route carries
 *      them), the pre-fill is called from every place a fee or a customer can
 *      change, and the marker it keeps is never sent to the server.
 *   2. Server — the normalizing that route does, run for real.
 *   3. Behavioural — payroll's own leg model, run in a vm against a stubbed DOM:
 *      what gets filled, what is left alone, and what the note says about it.
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

const SRC      = read('payroll.html');
const TRUCKING = read('trucking.html');
const ROUTE    = read('api/truck-division.js');

// ── 1. Structural ──────────────────────────────────────────────────────────
console.log('\n[the rates get to payroll]');
{
  // Rates live in the lists blob beside the rosters and have no normalized
  // table — dropdown_lists stores a customer as a bare name — so the cheap
  // rosters-only route has to read them from the blob whichever source the
  // rosters themselves came from.
  const listsOnly = slice(ROUTE, "req.query.lists === '1'", '// ── GET ─', 'the ?lists=1 branch');
  assert('the rosters-only route hands back the rates', /rates,?\s*$/m.test(listsOnly));
  assert('on the blob branch', /units: arr\(fromBlob\.units\), rates \}/.test(listsOnly));
  assert('and on the normalized-table fallback too, which stores no rate itself',
    /units:\s+unitRows\.map[^\n]*\n\s+rates,/.test(listsOnly));
  assert('read from the blob, which is the only place they exist',
    /asObj\(fromBlob && fromBlob\.rates\)/.test(listsOnly));

  assert('payroll reads them off the same fetch as the rosters',
    /Array\.isArray\(j\.lists\.customers\)/.test(SRC) && /j\.lists\.rates/.test(SRC));
  assert('and looks one up through its own accessor',
    /function truckCustomerRate\(name\)/.test(SRC));
}

console.log('\n[the same matching rule as the Trucking tab]');
{
  // A LIST entry is a spelling — "kovalchick" and "Kovalchick" are two entries
  // in the tab's Manage Lists because each was typed onto a row, and deleting
  // one must leave the other alone. A RATE is a fact about the company, so it
  // matches on case as well as space. Two files, one rule.
  assert('trucking.html keys a rate on case and space',
    /const _rateKey = v => String\(v == null \? '' : v\)\.trim\(\)\.toLowerCase\(\);/.test(TRUCKING));
  assert('and payroll keys it identically',
    /const _truckRateKey = v => String\(v == null \? '' : v\)\.trim\(\)\.toLowerCase\(\);/.test(SRC));
  // Both ends throw away a rate that is not a price, so neither can put a
  // non-number in a box that reads as money.
  assert('both drop a blank or non-numeric rate',
    /if \(name && v && !isNaN\(parseFloat\(v\)\)\) out\[name\] = v;/.test(TRUCKING)
    && /if \(name && val && !isNaN\(parseFloat\(val\)\)\) rates\[name\] = val;/.test(SRC));
  assert('the server drops it too, so a bad rate never leaves the database',
    /if \(name && val && !isNaN\(parseFloat\(val\)\)\) rates\[name\] = val;/.test(ROUTE));
}

console.log('\n[called wherever a fee or a customer can move]');
{
  // Four moments. Miss one and a box is left blank, or left holding the last
  // customer's price.
  const opener = slice(SRC, 'truckListsLoad().then', 'const wantsLookup', 'the roster hook');
  assert('when the rates land on a fresh approve', /haulRateApply\(\)/.test(opener));
  assert('behind the staleness guard, since it writes a value',
    /if \(seq !== truckingFetchSeq\) return;/.test(opener));

  const lookup = slice(SRC, 'haulApplyTruckRows(truckRows);', 'truckingRenderFields(row);', 're-edit pre-fill');
  assert('after a re-edit reads back the rows already posted', /haulRateApply\(\);/.test(lookup));

  const company = slice(SRC, 'function haulSetCompany', 'function haulSetDest', 'haulSetCompany');
  assert('when a haul is re-pointed at another customer', /haulRateApply\(\);/.test(company));
  assert('and only when the customer actually changed',
    company.indexOf('haulRateApply()') > company.indexOf("if (before !== leg.company.trim().toLowerCase())"));

  const dest = slice(SRC, 'function haulSetDest', 'function haulAddLeg', 'haulSetDest');
  assert('and when a dust haul moves to the grid that posts a truck row',
    /haulRateApply\(\);/.test(dest));

  // Filling the model without repainting would leave the box blank on screen and
  // still save the number — the sort of thing nobody finds until an invoice.
  assert('every call is followed by a repaint',
    /if \(haulRateApply\(\)\) truckingRenderFields\(lastTruckingRow\);/.test(opener)
    && /haulRateApply\(\);\n\s*truckingRenderFields\(lastTruckingRow\);/.test(company + dest));
}

console.log('\n[the marker stays on this side of the wire]');
{
  // feeFromRate is bookkeeping about where a number came from, not a column.
  // In HAUL_FIELDS it would be blanked on every fresh leg and, worse, offered
  // to the server as an answer.
  const fields = slice(SRC, 'const HAUL_FIELDS = [', '];', 'HAUL_FIELDS');
  assert('it is not one of the fields a leg sends', !/feeFromRate/.test(fields));
  const save = slice(SRC, 'trucking.rows = haulLegs.map', '// The dust half', 'the save payload');
  assert('and no leg carries it into the save', !/feeFromRate/.test(save));
  assert('the fee itself still is sent, from the model rather than the box',
    /if \(feeAnswered\(leg\)\) row\.haul_fee = leg\.haul_fee;/.test(save));
}

// ── A fee nobody ever answered is not sent at all ──────────────────────────
// The modal sends every other box blank included, because every other box was
// pre-filled and blank is therefore an answer. The fee is the one that can be
// blank for a reason that has nothing to do with the approver: the rates may
// not have landed by the time Approve was clicked, or this customer may have no
// rate at all. Sent as '' that posts the haul at no fee — $0/hr in the trucking
// tab — so it is left OFF the payload instead, and the server prices it from
// the customer's rate exactly as the box would have.
console.log('\n[a fee nobody answered]');
{
  const save = slice(SRC, 'const btn = document.getElementById(\'truckingSaveBtn\');',
                          '// The dust half', 'the trucking save payload');
  assert('an answer is a number in the box, or a box the approver typed in',
    /const feeAnswered = leg =>\s*\n\s*haulTouchedHas\(leg, 'haul_fee'\) \|\| legStr\(leg\.haul_fee\)\.trim\(\) !== '';/.test(save));
  assert('the day\'s fee is only sent when it is one',
    /if \(topFee !== '' \|\| truckingTouched\.has\('tk_haulFee'\)\) trucking\.haul_fee = topFee;/.test(save));
  assert('and it is dropped when a haul on a split day answered nothing',
    /if \(haulLegs\.every\(feeAnswered\)\) trucking\.haul_fee = haulLegs\[0\]\.haul_fee;\s*\n\s*else delete trucking\.haul_fee;/.test(save));
  // The unit next to it is unconditional, and says why in its own comment: it
  // is pre-filled from the timesheet, so its blank IS an answer. The two rules
  // sit side by side deliberately.
  assert('the unit beside it is still always sent', /unit: _tkval\('tk_unit'\),/.test(save));

  // The server end of the same rule.
  const API = read('api/timesheet-entries.js');
  assert('the server keeps absent apart from blank',
    /const feeGiven = t\.haul_fee !== undefined && t\.haul_fee !== null;/.test(API)
    && /if \(feeGiven\) fields\.haul_fee = fee\.value;/.test(API));
  assert('and prices the hauls nobody answered for from the customer\'s rate',
    /const rates = await truckCustomerRates\(sql, companyCode\);/.test(API)
    && /truckFee\(truckRateFor\(rates, row\.customer\)\)/.test(API));
  assert('reading them off the same lists blob the ?lists=1 route reads',
    /async function truckCustomerRates\(sql, companyCode\)/.test(API)
    && /companyCode \+ ':fct_truck_division_lists'/.test(API));
  assert('and matching the customer the way both pages match one',
    /const _truckRateKey = v => String\(v == null \? '' : v\)\.trim\(\)\.toLowerCase\(\);/.test(API));
}

console.log('\n[the note under the box]');
{
  assert('a hint rides under the day\'s Haul Fee', /id="tk_haulFeeHint"/.test(SRC));
  assert('and under each haul\'s, when the day is split',
    /id="hl_\$\{leg\.key\}_haulFeeHint"/.test(SRC));
  assert('both are refreshed on every keystroke, not only on a repaint',
    /truckUnitHintRefresh\(\);\n\s*truckFeeHintRefresh\(\);\n\s*const id = e\.target/.test(SRC));
}

// ── 2. The server's normalizing, run for real ──────────────────────────────
console.log('\n[what the route will serve]');
{
  const body = slice(ROUTE, 'const rates = {};', 'return res.json({', 'the rate normalizer');
  const norm = blob => {
    const ctx = {
      asObj: v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null,
      fromBlob: blob,
      out: null,
    };
    vm.createContext(ctx);
    vm.runInContext(body + '\nout = rates;', ctx);
    return ctx.out;
  };
  assert('a rate comes through under the name it is stored as',
    JSON.stringify(norm({ rates: { Kinkead: '121' } })) === '{"Kinkead":"121"}');
  assert('a stray space around the name is trimmed off',
    JSON.stringify(norm({ rates: { ' Kinkead ': ' 121 ' } })) === '{"Kinkead":"121"}');
  assert('a blank rate is not a price', JSON.stringify(norm({ rates: { Kinkead: '' } })) === '{}');
  assert('nor is a word',              JSON.stringify(norm({ rates: { Kinkead: 'call' } })) === '{}');
  assert('nor is a nameless one',      JSON.stringify(norm({ rates: { '   ': '121' } })) === '{}');
  assert('a number stored as one still comes through',
    JSON.stringify(norm({ rates: { Kinkead: 121 } })) === '{"Kinkead":"121"}');
  assert('a blob with no rates is an empty set, never undefined',
    JSON.stringify(norm({ customers: ['Kinkead'] })) === '{}');
  assert('and so is no blob at all', JSON.stringify(norm(null)) === '{}');
  assert('an array is not a rate table', JSON.stringify(norm({ rates: ['121'] })) === '{}');
}

// ── 3. Behavioural — payroll's own leg model ───────────────────────────────
// The real functions, run against a stubbed DOM. getElementById answers only for
// boxes actually mounted, so a fee box that is not on screen reads as absent
// rather than as an empty one — which is the difference between "no fee asked
// for" and "fee deliberately left blank".
function makeSandbox({ entry, rates, dust }) {
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
    escapeHtml: s => String(s == null ? '' : s),
    num2: n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2),
    TK_LABEL: '', TK_INPUT: '',
    // The roster as truckListsLoad leaves it. null = still in flight.
    truckLists: rates === null ? null : { units: [], customers: [], rates },
    document: {
      activeElement: null,
      getElementById: id => (els.has(id) ? els.get(id) : null),
    },
    console,
  };
  // The container every repaint writes into is always there; the boxes inside it
  // are mounted per test, so a fee box that is not on screen reads as absent.
  mount('truckingFields');
  vm.createContext(ctx);
  // The real accessors and the real note-writer, not stubs of them: whether a
  // rate matches, and what the box says about it, is the whole subject here.
  const helpers = slice(SRC, '    const truckUnitRoster     = ()',
                             '    // ── The hauls a day is split into', 'the roster accessors');
  const gate    = slice(SRC, '    const EES_JOB_IDS =', '    function truckingFieldsHtml(', 'entryNeedsTrucking');
  const model   = slice(SRC, '    // ── The hauls a day is split into',
                             "    const TK_LABEL = 'display:flex", 'the haul model');
  vm.runInContext(helpers, ctx);
  vm.runInContext(gate, ctx);
  vm.runInContext(model, ctx);
  const run = code => vm.runInContext(code, ctx);
  ctx.__opts = dust ? dust.options : null;
  ctx.__cos  = dust ? dust.companies : null;
  run('dustOptions = __opts; dustCompanies = __cos; haulLegs = [haulFreshLeg(null)];');
  return {
    ctx, run, mount,
    legs: () => run('haulLegs'),
    call: (fn, ...args) => { ctx.__args = args; return run(`${fn}(...__args)`); },
    fee:  (i = 0) => run('haulLegs')[i].haul_fee,
  };
}

const TRUCK_ENTRY = {
  id: 41, division: 'trucking', entry_type: 'daily', job_id: 'kinkead',
  job_label: 'Kinkead', username: 'barrmike', truck_unit: '2760',
  start_time: '06:00', end_time: '14:30', computed_hours: 8.5, travel_hours: 0,
};
const RATES = { Kinkead: '121', 'Derry Stone': '98.50' };

console.log('\n[a trucking day, freshly approved]');
{
  const s = makeSandbox({ entry: TRUCK_ENTRY, rates: RATES });
  assert('the haul opens on the timesheet\'s customer', s.legs()[0].company === 'Kinkead');
  assert('with no fee on it yet', s.fee() === '');
  assert('the rates landing fills it in', s.call('haulRateApply') === true && s.fee() === '121');
  assert('and running again changes nothing', s.call('haulRateApply') === false && s.fee() === '121');
}

console.log('\n[matching the customer]');
{
  const spelt = name => {
    const s = makeSandbox({ entry: { ...TRUCK_ENTRY, job_label: name }, rates: RATES });
    s.call('haulRateApply');
    return s.fee();
  };
  assert('lower case bills the same company', spelt('kinkead') === '121');
  assert('shouted, it is still the same company', spelt('KINKEAD') === '121');
  assert('and a stray space is not another one', spelt('  Kinkead ') === '121');
  assert('a customer with no rate is left blank', spelt('Somebody Else') === '');
  assert('a rate stored under a spaced name is still found',
    (() => {
      const s = makeSandbox({ entry: TRUCK_ENTRY, rates: { ' KINKEAD ': '121' } });
      s.call('haulRateApply');
      return s.fee();
    })() === '121');
}

console.log('\n[what it will not touch]');
{
  // The approver typed it. Right, wrong or deliberately blank, it is theirs.
  const typed = makeSandbox({ entry: TRUCK_ENTRY, rates: RATES });
  typed.call('haulEdit', typed.legs()[0].key, 'haul_fee', '85');
  assert('a fee the approver typed stands', typed.call('haulRateApply') === false && typed.fee() === '85');

  const cleared = makeSandbox({ entry: TRUCK_ENTRY, rates: RATES });
  cleared.call('haulEdit', cleared.legs()[0].key, 'haul_fee', '');
  assert('a fee they cleared is an answer too', cleared.call('haulRateApply') === false && cleared.fee() === '');

  // On a re-edit this is the fee the row was posted — and possibly invoiced — at.
  // Re-pricing the customer in Manage Lists must not restate it.
  const posted = makeSandbox({ entry: TRUCK_ENTRY, rates: RATES });
  posted.run(`haulSet(haulLegs[0], 'haul_fee', 'haulFee', '110')`);
  assert('a fee off a row already posted stands', posted.call('haulRateApply') === false && posted.fee() === '110');
  assert('and stops being the pre-fill\'s business', posted.legs()[0].feeFromRate === '');

  // A day that came back to be priced: approved in bulk with the box left blank.
  const unpriced = makeSandbox({ entry: TRUCK_ENTRY, rates: RATES });
  unpriced.run(`haulSet(haulLegs[0], 'haul_fee', 'haulFee', '')`);
  assert('but a row posted with NO fee is what the rate is for',
    unpriced.call('haulRateApply') === true && unpriced.fee() === '121');

  const quiet = makeSandbox({ entry: TRUCK_ENTRY, rates: null });
  assert('and nothing is filled from a roster that never arrived',
    quiet.call('haulRateApply') === false && quiet.fee() === '');
}

console.log('\n[re-pointing a haul at someone else]');
{
  const s = makeSandbox({ entry: TRUCK_ENTRY, rates: RATES });
  s.call('haulRateApply');
  const key = s.legs()[0].key;
  s.call('haulSetCompany', key, 'Derry Stone');
  assert('the new customer\'s rate replaces the old one\'s', s.fee() === '98.50');
  s.call('haulSetCompany', key, 'Nobody In Particular');
  assert('a customer with no rate takes the filled-in number back', s.fee() === '');
  assert('leaving the box exactly as blank as it found it', s.legs()[0].feeFromRate === '');
  s.call('haulSetCompany', key, 'Kinkead');
  assert('and naming a priced customer fills it again', s.fee() === '121');

  // The one it must never do.
  const t = makeSandbox({ entry: TRUCK_ENTRY, rates: RATES });
  t.call('haulEdit', t.legs()[0].key, 'haul_fee', '75');
  t.call('haulSetCompany', t.legs()[0].key, 'Derry Stone');
  assert('a fee they typed survives the customer changing under it', t.fee() === '75');
}

console.log('\n[a day split across hauls]');
{
  const s = makeSandbox({ entry: TRUCK_ENTRY, rates: RATES });
  s.call('haulRateApply');
  s.call('haulAddLeg');
  assert('the second haul starts on the first haul\'s customer and fee',
    s.legs()[1].company === 'Kinkead' && s.fee(1) === '121');
  assert('and inherits where that fee came from', s.legs()[1].feeFromRate === '121');
  s.call('haulSetCompany', s.legs()[1].key, 'Derry Stone');
  assert('so re-pointing it prices it for the new customer', s.fee(1) === '98.50');
  assert('while the first haul is untouched', s.fee(0) === '121' && s.legs()[0].company === 'Kinkead');
}

console.log('\n[a dust haul]');
{
  // A dust day's hauls bill off the dust office's own grid, which prices them by
  // vehicle rate × hours and has no haul fee at all. Only a haul moved to Other
  // Billing posts a Truck Tracking row — and that is when the fee box appears.
  const DUST_ENTRY = {
    id: 77, division: 'dust', entry_type: 'daily', job_id: 'ff-1', job_label: 'Kinkead',
    username: 'barrmike', truck_unit: '4000', start_time: '06:00', end_time: '16:00',
    computed_hours: 10, travel_hours: 0,
  };
  const s = makeSandbox({
    entry: DUST_ENTRY, rates: RATES,
    dust: { options: { company: 'Kinkead', known: true, men: [], locations: [], equipment: [] }, companies: [] },
  });
  assert('a haul on the dust grid is asked for no fee',
    s.call('haulRateApply') === false && s.fee() === '');
  s.call('haulSetDest', s.legs()[0].key, 'ob');
  assert('moving it to Other Billing fills the box that just appeared', s.fee() === '121');
  s.call('haulSetDest', s.legs()[0].key, 'dust');
  assert('and moving it back leaves the number alone, unsent either way', s.fee() === '121');
}

console.log('\n[what the hint says]');
{
  const hintFor = ({ rates, boxValue, customer }) => {
    const s = makeSandbox({ entry: { ...TRUCK_ENTRY, job_label: customer || 'Kinkead' }, rates });
    const box  = s.mount('tk_haulFee');
    const hint = s.mount('tk_haulFeeHint');
    box.value = boxValue;
    s.call('truckFeeHintRefresh');
    return hint;
  };
  const matched = hintFor({ rates: RATES, boxValue: '121' });
  assert('a box holding the agreed rate says whose rate it is',
    /Kinkead's rate, from Trucking → Manage Lists\./.test(matched.textContent), matched.textContent);
  assert('quietly', matched.style.color === 'var(--muted)');

  const off = hintFor({ rates: RATES, boxValue: '85' });
  assert('a box billing something else says what the office agreed',
    off.textContent === 'Trucking bills Kinkead at $121/hr.', off.textContent);
  assert('in amber', off.style.color === '#fbbf24');

  assert('the same figure spelled differently is not off-rate',
    /rate, from Trucking/.test(hintFor({ rates: RATES, boxValue: '121.00' }).textContent));
  assert('a blank box is flagged against a customer that has a rate',
    hintFor({ rates: RATES, boxValue: '' }).textContent === 'Trucking bills Kinkead at $121/hr.');
  // Silence is the rule the unit hint already follows, for the same reason: a
  // payroll that keeps no rates must read exactly as it always has.
  assert('a customer with no rate says nothing at all',
    hintFor({ rates: RATES, boxValue: '121', customer: 'Somebody Else' }).textContent === '');
  assert('and a roster that never arrived says nothing either',
    hintFor({ rates: null, boxValue: '121' }).textContent === '');
}

// ── 4. Bulk approve ────────────────────────────────────────────────────────
// The other place a haul fee is set, and the riskier one: ONE box prices every
// day on the card, so it may only be filled in when every day agrees on what
// that price is.
console.log('\n[bulk approve]');
{
  const bulk = slice(SRC, "if (g.type !== 'trucking' || g.division === 'dust') continue;",
                          'renderBulkGroups();', 'the bulk haul-fee prefill');
  assert('a card is only priced when every day on it resolves to one rate',
    /const fees = new Set\(g\.entries\.map\(e => truckCustomerRate\(bulkTruckCustomer\(e\)\)\)\);/.test(bulk)
    && /if \(fees\.size === 1 && \[\.\.\.fees\]\[0\]\)/.test(bulk));
  assert('and never over a figure already typed',
    /if \(String\(g\.template\.haul_fee \|\| ''\)\.trim\(\)\) continue;/.test(bulk));
  assert('a dust trucking card is skipped — it has no fee box at all',
    /g\.division === 'dust'/.test(bulk));
  assert('the customer is resolved the way the server resolves it',
    /const bulkTruckCustomer = e =>\s*\n\s*String\(\(e && \(e\.job_label \|\| e\.job_id\)\) \|\| ''\)\.trim\(\);/.test(SRC));

  const open = slice(SRC, 'const needTruckRates', 'for (const g of groups) bulkApplyTravelPrefill', 'the bulk loader');
  assert('the rates are fetched only when a card asks for a fee',
    /needTruckRates \? truckListsLoad\(\) : Promise\.resolve\(\)/.test(open)
    && /g\.type === 'trucking' && g\.division !== 'dust'/.test(open));

  // A number the modal filled in is marked as such — the dashed border every
  // other prefilled field on this card already wears — and the card says whose
  // rate it is, which is what makes it checkable at a glance.
  assert('a filled-in fee wears the same marker as the other prefills',
    /_bulkNum\(idx, 'haul_fee', g\.template\.haul_fee,\s*\n\s*ratedN \? "auto · each customer's rate" : '0\.00', fromRate/.test(SRC)
    && /className: 'auto-code'/.test(SRC));
  assert('and the card names the customer the rate came from',
    /The fee is <strong>\$\{escapeHtml\(rateCustomer\)\}<\/strong>'s rate/.test(SRC));
  // The prefill's condition is agreement on the PRICE, and two companies can be
  // billed the same — so the name is only printed when there is one to print.
  // Crediting entries[0] regardless would put a customer's name over days that
  // were never theirs.
  assert('but only when the card really does hold one customer',
    /const rateCustomer = rateNames\.length === 1 \? rateNames\[0\] : '';/.test(SRC)
    && /every customer\n\s*on this card is billed at it/.test(SRC));
  assert('and spellings of one company count as one',
    /rateNames\.some\(n => _truckRateKey\(n\) === _truckRateKey\(name\)\)/.test(SRC));
  assert('typing over it takes the marker off',
    /if \(field === 'haul_fee'\) g\.template\.haul_fee_source = '';/.test(SRC));
  // haul_fee_source is the card's own bookkeeping. On the wire it would be a
  // field the approve endpoint never asked for.
  const body = slice(SRC, "if (g.type === 'trucking') {\n        // ONE box prices",
                          'return null;', 'the bulk approve body');
  assert('the marker is not sent with the approval', !/haul_fee_source/.test(body));
  // And the point of the whole card: a box that could not be filled in is not
  // an answer. Sent as '' it priced every day on the card at nothing — which is
  // what put $0 haul fees on rows the office had an agreed rate for.
  assert('an empty box is left off the payload rather than sent blank',
    /const trucking = \{ division: g\.template\.division_col \};/.test(body)
    && /if \(fee !== ''\) trucking\.haul_fee = fee;/.test(body));

  // What the card SAYS a blank box will do, which is the other half of it: a
  // money box left empty reads as "$0" unless something says otherwise.
  assert('the card says a blank box prices each day from its own customer',
    /Left empty, each day bills <strong>its own customer's rate<\/strong>/.test(SRC));
  assert('and counts the days that would still post unpriced',
    /const ratedN   = perDay\.filter\(Boolean\)\.length;/.test(SRC)
    && /const unrated  = days - ratedN;/.test(SRC)
    && /\$\{unrated\}<\/strong> of the \$\{days\} days here/.test(SRC));
  assert('a card whose customers have no rate at all says so instead',
    /No rate is set for \$\{days === 1 \? 'this customer' : 'these customers'\}/.test(SRC));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
