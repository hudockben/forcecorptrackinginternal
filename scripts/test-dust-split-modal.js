#!/usr/bin/env node
'use strict';
/**
 * Payroll's "split this day across hauls" modal.
 *
 * Run: node scripts/test-dust-split-modal.js
 *
 * A driver's day is one timesheet entry, but both offices bill per haul: ten
 * hours can be 4,000 gallons on one customer's pad and 2,000 on another's, or
 * two loads for two customers with no dust in it at all. The approving
 * supervisor splits the day here, and each haul posts one billing row in
 * whichever tab it names — Truck Tracking for a trucking day, and for a dust
 * customer haul either Dust Control Tracking (which the dust office bills end
 * to end, posting nothing to Truck Tracking) or Other Billing (which posts a
 * Truck Tracking row beside it, since that grid prices the material and the
 * hauling of it is trucking's line). Two layers:
 *
 *   1. Structural — greps payroll.html and the server so the two halves of the
 *      contract stay in step: the save sends { dust: { rows: [...] } }, the leg
 *      cap matches the server's, and the entry's own customer is still sent as
 *      "absent" so a renamed customer resolves by job_id.
 *   2. Behavioural — runs the real leg model out of payroll.html in a vm with a
 *      stubbed DOM, and asserts on what a supervisor actually does: split a day,
 *      type hours instead of times, re-point a leg at another customer, remove a
 *      leg again.
 *
 * No DB, no browser.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const SRC    = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');
const SERVER = fs.readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');
const LIB    = fs.readFileSync(path.resolve(__dirname, '../api/lib/dust-injected.js'), 'utf8');
const { MAX_DUST_ROWS } = require('../api/lib/dust-injected.js');
const { MAX_INJECTED_LEGS } = require('../api/lib/truck-injected.js');

console.log('Payroll dust split modal\n');

// ── 1) Structural ───────────────────────────────────────────────────────────
console.log('[the payload the modal and the server agree on]');
{
  const save = SRC.match(/async function truckingSave\(\)[\s\S]+?\n    \}\n/);
  assert('truckingSave sends the legs as dust.rows',
    !!save && /body\.dust = \{\s*\n\s*rows: haulLegs\.map/.test(save[0]));
  assert('every leg carries its own window',
    !!save && /start_time:\s*leg\.start_time/.test(save[0]) && /end_time:\s*leg\.end_time/.test(save[0]));
  // Three call sites, not two: the Truck Tracking half, and each of the two
  // grids a dust haul can bill off. All three have to name the customer the
  // same way or one tab's row bills somebody the others never heard of.
  assert('a leg on the timesheet customer sends no company to any tab',
    /return same \? undefined : leg\.company/.test(SRC)
    && !!save && (save[0].match(/company:\s*legCustomerPayload\(leg\)/g) || []).length === 3);
  assert('and the two divisions compare that customer their own way',
    /typed\.toLowerCase\(\) === entryCo\.toLowerCase\(\)/.test(SRC) && /typed === entryCo/.test(SRC));
  assert('and the same legs go to the Truck Tracking half',
    !!save && /trucking\.rows = haulLegs\.map/.test(save[0])
    && /haul_fee:\s*leg\.haul_fee/.test(save[0]));
  assert('a haul with no hours is refused before it can bill nothing',
    !!save && /has no hours/.test(save[0]));
  // The per-haul destination. Both branches have to say which grid they are,
  // because the server reads `dest` and nothing else to decide — a leg that
  // sent no destination would silently bill UB rates against a delivery.
  assert('each leg says which dust grid it bills off',
    !!save && /dest:\s*'ob'/.test(save[0]) && /dest:\s*'dust'/.test(save[0]));
  assert('and the branch is the leg\'s own answer',
    !!save && /rows: haulLegs\.map\(leg => legIsOb\(leg\)/.test(save[0]));
  assert('an Other Billing leg sends that grid\'s columns',
    !!save && ['trailer_number', 'material', 'gallons_bags', 'mu', 'price_per_unit', 'trucking_rate']
      .every(f => new RegExp(`${f}:\\s*leg\\.${f}`).test(save[0])));
  // …and only those. Every key sent counts as the approver's answer, blank
  // included, so a UB column riding along on a material haul would be an answer
  // to a question that haul was never asked.
  {
    const branch = (save || [''])[0].match(/legIsOb\(leg\)\s*\n\s*\? \{([\s\S]*?)\n\s*\}\s*\n\s*: \{/);
    assert('and does NOT send the tracking grid\'s columns',
      !!branch && !/gallons_ub|company_man|v1_rate|v2_rate|vehicle2/.test(branch[1]),
      branch ? branch[1].replace(/\s+/g, ' ').slice(0, 120) : 'no ob branch found');
  }
  // The save sends the WHOLE day to the trucking half — every leg, whichever
  // grid it bills off — and the server decides which of them post. Filtering in
  // the page would put the two halves out of step on leg numbering, and would
  // leave a haul re-pointed from material to UB with its old Truck Tracking row
  // still standing: the server prunes what this call does not write, so it has
  // to see the leg to know it is gone.
  assert('the save sends every leg to the trucking half, filtering none',
    !!save && /trucking\.rows = haulLegs\.map/.test(save[0])
    && !/trucking\.rows = haulLegs\.filter/.test(save[0]));

  // The server reads that payload, caps it, and prunes what a save dropped.
  assert('the server accepts { rows: [...] }',
    /Array\.isArray\(raw\.rows\)\) legs = raw\.rows/.test(SERVER));
  assert('…and still accepts the old flat object',
    /else if \(typeof raw === 'object'\) legs = \[raw\]/.test(SERVER));
  assert('the server prunes legs a save no longer has',
    /const drop = prior\.map\(r => String\(r\.id\)\)\.filter\(id => id && !keep\.has\(id\)\)/.test(SERVER));
  assert('leg 1 keeps the historic row id',
    /n <= 1 \? `\$\{dustRowIdPrefix\(entryId\)\}row`/.test(LIB));

  const uiCap = SRC.match(/const MAX_HAUL_LEGS = (\d+)/);
  assert('the modal and the server cap the split at the same number',
    !!uiCap && Number(uiCap[1]) === MAX_DUST_ROWS, `${uiCap && uiCap[1]} vs ${MAX_DUST_ROWS}`);
  assert('and both tabs cap it at the same number too',
    MAX_DUST_ROWS === MAX_INJECTED_LEGS);
  assert('the server prunes dropped Truck Tracking legs as well',
    /const staleIds = \[\.\.\.priorById\.keys\(\)\]\.filter\(id => id && !kept\.has\(id\)\)/.test(SERVER));
  assert('the truck sweep competes per leg, not per entry',
    /Competition is per leg, not per entry/.test(
      fs.readFileSync(path.resolve(__dirname, '../api/lib/truck-injected.js'), 'utf8')));

  // A refusal from the pre-fill lookup must not read as "this day posted
  // nothing". It parses as JSON like any answer, and taking it at face value
  // lets a save carry one haul where the day has several — which the server
  // reads as "drop the rest", billing entries and all.
  const open = SRC.match(/async function openTruckingModal\(entry, mode\)[\s\S]+?\n    \}\n/);
  assert('the pre-fill lookup refuses a non-OK response',
    !!open && /if \(!res\.ok\) throw new Error/.test(open[0]));
  assert('…so the save guard sees it as a failed load, not a loaded one',
    !!open && open[0].indexOf('if (!res.ok) throw') < open[0].indexOf("rowLoad = 'loaded'")
    && /if \(rowLoad === 'pending'\) rowLoad = 'failed'/.test(open[0]));
  assert('and the save refuses while the posted rows are unknown',
    !!save && /rowLoad === 'pending' \|\| rowLoad === 'failed'/.test(save[0]));

  // The read-time sweep must no longer treat a second leg as a duplicate.
  assert('the sweep keeps every live leg of one entry',
    /Several live rows for ONE entry is normal/.test(LIB) && !/keptByEntry/.test(LIB));
}

// ── Which hauls reach Truck Tracking ────────────────────────────────────────
// A haul billed off Dust Control Tracking is the dust office's from end to end
// and posts nothing to Truck Tracking; a haul billed off Other Billing still
// does, because that grid prices the material and the hauling is trucking's
// line. The page and the server have to draw that line in the same place, or
// payroll collects a haul fee the server discards — or, worse, the server posts
// a row the modal never mentioned.
console.log('\n[only a material haul reaches Truck Tracking]');
{
  assert('the server gates the Truck Tracking write per leg',
    /const postsHere = i => !dustLegs \|\| legDest\(dustLegs\[i\] \|\| \{\}\) === 'ob'/.test(SERVER));
  assert('and a dust entry with no legs given posts nothing there',
    /needsDustTrackingRow\(entry\)\s*\n\s*\? \(\(Array\.isArray\(flags\.dustLegs\) && flags\.dustLegs\.length\) \? flags\.dustLegs : \[\{\}\]\)\s*\n\s*: null/.test(SERVER));
  // Built for every leg and filtered after, never filtered first: the lunch
  // deduction runs down the legs in order, so filtering first would change a
  // haul's hours according to what the haul BEFORE it billed off.
  assert('every leg is still costed, only the posted ones are written',
    /const allRows = legs\.map\(\(leg, i\) => \{/.test(SERVER)
    && /const rows = allRows\.filter\(\(_, i\) => postsHere\(i\)\)/.test(SERVER));
  // The id is the leg's place in the DAY. Renumbering after a filter would move
  // a haul's Intercompany history onto another haul's row.
  assert('and the row id still names the leg\'s place in the day',
    /id:\s*truckingRowId\(entry\.id, i \+ 1\)/.test(SERVER));

  // Both approve and resplit have to hand the day's legs over, or the write
  // falls back to "no legs given" and takes every Truck Tracking row back.
  assert('approve passes the day\'s hauls to the trucking write',
    /insertTruckingRows\(sql, companyCode, updated, truckingInject \|\| \{\}, \{ clearSuppression: true, dustLegs: dustInject \}\)/.test(SERVER));
  assert('and so does a re-edit',
    /insertTruckingRows\(sql, companyCode, existing, fields, \{ dustLegs: dustParsed\.rows \}\)/.test(SERVER));

  // The page's own gate, which decides whether the Haul Fee and Division boxes
  // are even asked for. Drift one way and payroll approves a material haul with
  // no fee on its Truck Tracking row; drift the other and it types a fee into a
  // day that posts none.
  assert('the page mirrors the gate',
    /const legPostsTruck = leg => !isDustEntry\(\) \|\| legIsOb\(leg\)/.test(SRC));
  assert('the per-haul fee box is gated on it',
    /\$\{split && posts \? `<label style="\$\{TK_LABEL\}"><span>Haul Fee/.test(SRC));
  assert('the day\'s Haul Fee and Division boxes are gated on it too',
    /const posts = anyTruckLeg\(\);/.test(SRC)
    && /\$\{split \|\| !posts \? '' : `<label style="\$\{TK_LABEL\}"><span>Haul Fee/.test(SRC)
    && /\$\{!posts \? '' : `<label style="\$\{TK_LABEL\}"><span>Division/.test(SRC));
  assert('the Unit box is NOT — it seeds each haul\'s Vehicle 1 as well',
    /<span>Unit<\/span>\s*\n\s*<input type="text" id="tk_unit"/.test(SRC));
  assert('the note says outright when nothing goes to Truck Tracking',
    /Nothing is posted to Truck Tracking/.test(SRC));
  assert('and the save confirmation stops naming a tab it did not write',
    /: 'Dust Control Tracking';/.test(SRC));

  // The pre-fill has to reassemble by leg now that the list can be sparse.
  assert('the server tags each posted truck row with its leg',
    /\.map\(\(\{ r, leg \}\) => \(\{ \.\.\.r, leg \}\)\);/.test(SERVER));
  assert('and the modal slots them by leg rather than by position',
    /const n = Number\(row && row\.leg\);/.test(SRC)
    && /byLeg\.forEach\(\(row, index\) => \{/.test(SRC));
}

// ── 2) Behavioural ──────────────────────────────────────────────────────────
// The leg model, run for real against a stubbed DOM.
function makeSandbox(entry, options, companies) {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, {
      id, value: '', textContent: '', innerHTML: '', style: {}, className: '',
      focus() {}, setSelectionRange() {},
    });
    return els.get(id);
  };
  const ctx = {
    // What the extracted block reaches for outside itself.
    truckingEntry: entry,
    truckingMode:  'approve',
    truckingFieldsHtml: () => '',
    truckUnitHintRefresh: () => {},
    truckingNoteRefresh:  () => {},
    escapeHtml: s => String(s == null ? '' : s),
    // The trucking office's own customer roster, fetched once per payroll
    // session (truckListsLoad) and offered on a trucking day's hauls.
    truckCustomerRoster: () => ['Acme Materials', 'Derry Stone', 'HC Quarry'],
    num2: n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2),
    TK_LABEL: '', TK_INPUT: '',
    document: {
      activeElement: null,
      getElementById: id => el(id),
    },
    console,
  };
  vm.createContext(ctx);
  const start = SRC.indexOf('    // ── The hauls a day is split into ─');
  const end   = SRC.indexOf("    const TK_LABEL = 'display:flex");
  if (start < 0 || end < 0) throw new Error('could not find the haul model in payroll.html');
  // The real division gate comes along, rather than a stub of it: which entries
  // can be split at all is the one thing the model asks the outside world, and a
  // stub that drifted from payroll.html would test nothing.
  const gateStart = SRC.indexOf('    const EES_JOB_IDS =');
  const gateEnd   = SRC.indexOf('    function truckingFieldsHtml(');
  if (gateStart < 0 || gateEnd < 0) throw new Error('could not find entryNeedsTrucking in payroll.html');
  vm.runInContext(SRC.slice(gateStart, gateEnd), ctx);
  vm.runInContext(SRC.slice(start, end), ctx);
  // The block's own `let`s live in the context's lexical scope, not on the
  // context object, so they are reached by running code in the same context
  // rather than by poking at ctx.
  const run = code => vm.runInContext(code, ctx);
  ctx.__opts = options;
  ctx.__cos  = companies;
  run('dustOptions = __opts; dustCompanies = __cos; haulLegs = [haulFreshLeg(null)];');
  return {
    run,
    legs: () => run('haulLegs'),
    call: (fn, ...args) => { ctx.__args = args; return run(`${fn}(...__args)`); },
    // Park the caret in a stubbed box, the way a supervisor mid-word would.
    focus: node => { ctx.document.activeElement = node; },
    el,
  };
}

const ENTRY = {
  id: 42, username: 'barrmike', division: 'dust', entry_type: 'daily',
  work_date: '2026-08-17', start_time: '05:00', end_time: '15:00',
  job_id: 'co-cnx', job_label: 'CNX', truck_unit: 'Distributor Truck 4000',
  computed_hours: 10, travel_hours: 0,
};
const OPTIONS = {
  company: 'CNX', known: true, v1_rate: 135, v2_rate: 60,
  men: ['Steve Quinn'],
  locations: [{ name: 'Deer Lick Compressor', state: 'PA' }],
  equipment: [
    { name: 'Distributor Truck 4000', unit_number: '4000', vehicle_rate: 99 },
    { name: 'Escort Vehicle 7549',    unit_number: '7549', vehicle_rate: 50 },
  ],
  usual_vehicle2: 'Escort Vehicle 7549',
};
const COMPANIES = [
  { id: 'co-cnx', name: 'CNX', v1_rate: 135, v2_rate: 60,
    men: ['Steve Quinn'], locations: [{ name: 'Deer Lick Compressor', state: 'PA' }] },
  { id: 'co-ant', name: 'Antero', v1_rate: 145, v2_rate: null,
    men: ['Maximus Lockerbie'], locations: [{ name: 'Bear Hollow', state: 'WV' }] },
];

console.log('\n[the day opens as one haul]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  const [leg] = t.legs();
  assert('one leg, covering the clock window',
    t.legs().length === 1 && leg.start_time === '05:00' && leg.end_time === '15:00');
  assert('and its hours are the day\'s hours', t.call('haulHours', leg) === 10);
  assert('vehicle 1 is the unit the driver logged', leg.vehicle1 === 'Distributor Truck 4000');
  assert('the customer\'s rate beats the vehicle\'s own (135, not 99)', leg.v1_rate === '135');
  assert('the escort follows the customer',
    leg.vehicle2 === 'Escort Vehicle 7549' && leg.v2_rate === '60');
  assert('the customer box opens on the timesheet customer', leg.company === 'CNX');
}

console.log('\n[splitting the day]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t.call('haulAddLeg');
  const [a, b] = t.legs();
  assert('a second haul appears', t.legs().length === 2);
  assert('the day is halved rather than doubled',
    a.start_time === '05:00' && a.end_time === '10:00' &&
    b.start_time === '10:00' && b.end_time === '15:00');
  assert('the two hauls still add up to the day',
    t.call('haulHours', a) + t.call('haulHours', b) === 10);
  assert('the new haul keeps the same truck', b.vehicle1 === 'Distributor Truck 4000');
  assert('but not the pad or the company man', b.location === '' && b.company_man === '');

  // 4,000 gallons to CNX for five hours, 2,000 to Antero for five.
  t.call('haulEdit', a.key, 'location', 'Deer Lick Compressor');
  t.call('haulEdit', a.key, 'gallons_ub', '4000');
  assert('picking a pad fills the state in', a.state === 'PA');
  // The real event order: the box writes the model as it is typed (oninput),
  // then commits on blur (onchange). A cascade that compared the model against
  // itself would find "no change" here and leave the last customer's rate on
  // the new customer's haul — which is exactly what a browser produces and a
  // direct haulSetCompany call does not.
  t.call('haulEdit', b.key, 'company', 'Antero');
  t.call('haulSetCompany', b.key, 'Antero');
  assert('re-pointing a haul takes the other customer\'s rate', b.v1_rate === '145',
    `v1_rate=${b.v1_rate}`);
  // The escort belongs to the customer that was there before: a customer billed
  // no escort rate is not sent one, and is certainly not billed the last
  // customer's escort.
  assert('and drops the previous customer\'s escort',
    b.vehicle2 === '' && b.v2_rate === '');
  assert('while the driver\'s own truck stays on the haul',
    b.vehicle1 === 'Distributor Truck 4000');
  t.call('haulEdit', b.key, 'location', 'Bear Hollow');
  t.call('haulEdit', b.key, 'gallons_ub', '2000');
  assert('the second customer\'s own pad fills its own state', b.state === 'WV');
  assert('each haul keeps its own gallons',
    a.gallons_ub === '4000' && b.gallons_ub === '2000');
  assert('and its own customer', a.company === 'CNX' && b.company === 'Antero');
}

console.log('\n[typing hours instead of times]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t.call('haulAddLeg');
  const [a, b] = t.legs();
  t.call('haulSetHours', a.key, '6');
  assert('the haul ends six hours after it started', a.end_time === '11:00');
  assert('and reads back as six hours', t.call('haulHours', a) === 6);
  t.call('haulSetHours', b.key, '0');
  assert('zero hours is ignored rather than collapsing the haul', b.end_time === '15:00');
}

console.log('\n[taking a haul back off]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t.call('haulAddLeg');
  const [a, b] = t.legs();
  t.call('haulRemoveLeg', b.key);
  assert('one haul is left', t.legs().length === 1);
  assert('and it covers the whole day again',
    a.start_time === '05:00' && a.end_time === '15:00');
  t.call('haulRemoveLeg', a.key);
  assert('the last haul cannot be removed', t.legs().length === 1);
}

console.log('\n[a late pre-fill never overwrites an answer]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  // Payroll starts typing while the lookup for the posted rows is still out.
  const leg = t.legs()[0];
  t.call('haulEdit', leg.key, 'gallons_ub', '9999');
  t.call('haulEdit', leg.key, 'company_man', 'Someone Else');
  t.call('dustApplyRows', [{ company_man: 'Steve Quinn', location: 'Deer Lick Compressor',
                             gallons_ub: '1660', state: 'PA' }]);
  assert('what they typed stands',
    leg.gallons_ub === '9999' && leg.company_man === 'Someone Else');
  assert('what they never touched is filled from the posted row',
    leg.location === 'Deer Lick Compressor' && leg.state === 'PA');

  // And a posted row for a leg that isn't on screen yet is added, not dropped —
  // a leg left off the save is a row the server takes back.
  t.call('dustApplyRows', [{ location: 'Deer Lick Compressor' },
                           { company: 'Antero', location: 'Bear Hollow' }]);
  assert('a second posted haul is picked up rather than lost',
    t.legs().length === 2 && t.legs()[1].location === 'Bear Hollow');
}

console.log('\n[the haul fee follows the haul]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  // The fee typed at the top of the modal belongs to leg 1 — the box is bound to
  // it — so splitting the day carries it onto the haul that was added.
  t.call('haulEdit', t.legs()[0].key, 'haul_fee', '135');
  t.call('haulAddLeg');
  const [a, b] = t.legs();
  assert('the fee typed for the day carries onto the new haul',
    a.haul_fee === '135' && b.haul_fee === '135');
  t.call('haulEdit', b.key, 'haul_fee', '145');
  assert('and each haul can then bill its own',
    a.haul_fee === '135' && b.haul_fee === '145');

  // Re-editing reads the posted Truck Tracking rows back onto the hauls.
  const t2 = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t2.call('haulApplyTruckRows', [
    { id: 'tst-42-row', customer: 'CNX',    actual_start: '05:00', actual_end: '10:00', haul_fee: 135 },
    { id: 'tst-42-2',   customer: 'Antero', actual_start: '10:00', actual_end: '15:00', haul_fee: 145 },
  ]);
  const legs2 = t2.legs();
  assert('a posted second haul is picked up rather than lost',
    legs2.length === 2 && legs2[1].company === 'Antero' && legs2[1].start_time === '10:00');
  assert('each haul gets back the fee it was posted with',
    legs2[0].haul_fee === '135' && legs2[1].haul_fee === '145');

  // A fee the approver has already typed is theirs, late answer or not.
  const t3 = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t3.call('haulEdit', t3.legs()[0].key, 'haul_fee', '999');
  t3.call('haulApplyTruckRows', [{ id: 'tst-42-row', haul_fee: 135 }]);
  assert('what they typed stands', t3.legs()[0].haul_fee === '999');
}

console.log('\n[a trucking day, which has no dust half at all]');
{
  const TRUCKING = {
    id: 77, username: 'smith', division: 'trucking', entry_type: 'daily',
    work_date: '2026-08-17', start_time: '07:00', end_time: '15:30',
    job_id: 'Acme Materials', job_label: 'Acme Materials', truck_unit: '634',
    computed_hours: 8, travel_hours: 0,
  };
  // No dust options and no dust company directory — a trucking entry is offered
  // the trucking office's own customer roster instead.
  const t = makeSandbox(TRUCKING, null, null);
  assert('a trucking entry can be split', t.run('entrySplits()') === true);
  assert('but it is not a dust entry', t.run('isDustEntry()') === false);
  assert('it opens as one haul covering the day',
    t.legs().length === 1 && t.legs()[0].start_time === '07:00' && t.legs()[0].end_time === '15:30');
  assert('on the customer off the timesheet', t.legs()[0].company === 'Acme Materials');
  // Unsplit, the haul boxes stay hidden: everything that row needs is already in
  // the three boxes at the top, and its hours are the timesheet's, not a window
  // the approver could "correct" here to no effect.
  assert('unsplit, no haul boxes are shown', t.run('haulBoxesShown()') === false);
  assert('and the section still offers the split',
    /Split this day across hauls/.test(t.run('haulSectionHtml()')));
  assert('the section names the tab it posts into',
    /Truck Tracking — hauls/.test(t.run('haulSectionHtml()')));
  assert('and carries no dust heading',
    !/Dust Control Tracking/.test(t.run('haulSectionHtml()')));

  t.call('haulAddLeg');
  const [a, b] = t.legs();
  assert('splitting halves the day',
    a.end_time === '11:15' && b.start_time === '11:15' && b.end_time === '15:30');
  assert('and the boxes appear', t.run('haulBoxesShown()') === true);
  const html = t.run('haulSectionHtml()');
  assert('a trucking haul shows the customer, window, hours and fee',
    /_company"/.test(html) && /_start"/.test(html) && /_end"/.test(html)
    && /_hours"/.test(html) && /_haulFee"/.test(html));
  assert('and none of the dust columns',
    !/_companyMan"/.test(html) && !/_location"/.test(html) && !/_state"/.test(html)
    && !/_gallons"/.test(html) && !/_vehicle1"/.test(html) && !/_v1Rate"/.test(html));
  t.call('haulSetCompany', b.key, 'Derry Stone');
  assert('the second haul takes its own customer', b.company === 'Derry Stone');
  assert('while the first keeps the timesheet\'s', a.company === 'Acme Materials');
  t.call('haulEdit', b.key, 'haul_fee', '105');
  assert('and can bill at its own fee', b.haul_fee === '105');
}

console.log('\n[collapsing a trucking split back to one haul]');
{
  const TRUCKING = {
    id: 77, username: 'smith', division: 'trucking', entry_type: 'daily',
    work_date: '2026-08-17', start_time: '07:00', end_time: '15:30',
    job_id: 'Acme Materials', job_label: 'Acme Materials', truck_unit: '634',
    computed_hours: 8, travel_hours: 0,
  };
  const t = makeSandbox(TRUCKING, null, null);
  t.call('haulAddLeg');
  const [a, b] = t.legs();
  // The whole day was really Derry Stone, so haul 1 is re-pointed — then the
  // supervisor thinks better of the split and removes the second haul.
  t.call('haulSetCompany', a.key, 'Derry Stone');
  t.call('haulRemoveLeg', b.key);
  assert('one haul is left, covering the day again',
    t.legs().length === 1 && t.legs()[0].end_time === '15:30');
  assert('the customer they chose survives', t.legs()[0].company === 'Derry Stone');
  // …and the box holding it stays on screen. An override that is still sent but
  // no longer visible is the one outcome worth ruling out.
  assert('and its box is still shown', t.run('haulBoxesShown()') === true);
  assert('the header says the haul is the whole day',
    /The whole day/.test(t.run('haulSectionHtml()')));
  assert('with no Remove button on the only haul',
    !/haulRemoveLeg/.test(t.run('haulSectionHtml()')));
  // A fee typed at the top of an unsplit modal must NOT pop the boxes open.
  const t2 = makeSandbox(TRUCKING, null, null);
  t2.call('haulEdit', t2.legs()[0].key, 'haul_fee', '90');
  assert('typing a fee alone leaves the day unsplit and quiet',
    t2.run('haulBoxesShown()') === false);
}

console.log('\n[re-editing a split trucking day]');
{
  const TRUCKING = {
    id: 77, username: 'smith', division: 'trucking', entry_type: 'daily',
    work_date: '2026-08-17', start_time: '07:00', end_time: '15:30',
    job_id: 'Acme Materials', job_label: 'Acme Materials', truck_unit: '634',
    computed_hours: 8, travel_hours: 0,
  };
  // Edit Row on a day approved as two hauls. Nothing else on screen describes
  // them: a trucking entry has no dust rows, so if these do not come back the
  // modal shows one haul covering the whole day on the timesheet's customer —
  // and saving that re-bills the entire day on haul 1, under the wrong customer,
  // with no sign it happened.
  const t = makeSandbox(TRUCKING, null, null);
  t.call('haulApplyTruckRows', [
    { id: 'tst-77-row', customer: 'Derry Stone',    actual_start: '07:00', actual_end: '11:15', haul_fee: 90 },
    { id: 'tst-77-2',   customer: 'Acme Materials', actual_start: '11:15', actual_end: '15:30', haul_fee: 105 },
  ]);
  const [a, b] = t.legs();
  assert('both posted hauls come back', t.legs().length === 2);
  assert('haul 1 is the posted haul, not the whole day',
    a.company === 'Derry Stone' && a.start_time === '07:00' && a.end_time === '11:15',
    JSON.stringify([a.company, a.start_time, a.end_time]));
  assert('haul 2 is the one posted after it',
    b.company === 'Acme Materials' && b.start_time === '11:15' && b.end_time === '15:30');
  assert('each keeps the fee it was posted with', a.haul_fee === '90' && b.haul_fee === '105');
  assert('and together they still cover the clock window',
    t.run('haulHoursAllocated()') === t.run('entryClockHours()'));

  // A single posted haul that differs from the timesheet must be visible, not
  // just present: an override that is sent but not shown is the worst outcome.
  const t2 = makeSandbox(TRUCKING, null, null);
  assert('a lone haul starts hidden', t2.run('haulBoxesShown()') === false);
  t2.call('haulApplyTruckRows', [
    { id: 'tst-77-row', customer: 'Derry Stone', actual_start: '07:00', actual_end: '15:30', haul_fee: 90 },
  ]);
  assert('…and is shown once a posted row has answered it',
    t2.run('haulBoxesShown()') === true && t2.legs()[0].company === 'Derry Stone');

  // What the approver typed still outranks the answer that arrives after it.
  const t3 = makeSandbox(TRUCKING, null, null);
  t3.call('haulEdit', t3.legs()[0].key, 'company', 'Somebody Else');
  t3.call('haulApplyTruckRows', [{ id: 'tst-77-row', customer: 'Derry Stone', haul_fee: 90 }]);
  assert('a typed customer stands against a late prefill',
    t3.legs()[0].company === 'Somebody Else' && t3.legs()[0].haul_fee === '90');

  // A DUST haul is unaffected: its dust rows are authoritative and land first.
  const t4 = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t4.call('dustApplyRows', [
    { company: 'CNX',    location: 'Deer Lick Compressor', start_time: '05:00', end_time: '10:00' },
    { company: 'Antero', location: 'Bear Hollow',          start_time: '10:00', end_time: '15:00' },
  ]);
  t4.call('haulApplyTruckRows', [
    { id: 'tsd-42-row', customer: 'WRONG', actual_start: '00:00', actual_end: '23:00', haul_fee: 135 },
    { id: 'tsd-42-2',   customer: 'WRONG', actual_start: '00:00', actual_end: '23:00', haul_fee: 145 },
  ]);
  const d = t4.legs();
  assert('the dust rows keep the customer and the window',
    d[0].company === 'CNX' && d[0].end_time === '10:00' && d[1].company === 'Antero');
  assert('while the truck rows still supply the fees',
    d[0].haul_fee === '135' && d[1].haul_fee === '145');
}

console.log('\n[hauls that would bill something odd]');
{
  const TRUCKING = {
    id: 78, username: 'smith', division: 'trucking', entry_type: 'daily',
    work_date: '2026-08-17', start_time: '07:00', end_time: '15:30',
    job_id: 'Acme Materials', job_label: 'Acme Materials', truck_unit: '634',
    computed_hours: 8, travel_hours: 0,
  };
  const t = makeSandbox(TRUCKING, null, null);
  t.call('haulAddLeg');
  const [a, b] = t.legs();
  // A customer the office does not know is saved as typed — and warned about,
  // because Intercompany matches a truck row to a company by name.
  t.call('haulSetCompany', b.key, 'Nobody Hauling Co');
  assert('an off-roster customer is flagged, not blocked',
    /not on the Trucking customer list/.test(t.run('haulSectionHtml()')));
  t.call('haulSetCompany', b.key, 'Derry Stone');
  assert('and a roster name is not', !/not on the Trucking customer list/.test(t.run('haulSectionHtml()')));
  // 15:30 mistyped as 05:30 would silently bill 18.25 h on a day that never ran
  // past midnight.
  t.call('haulEdit', b.key, 'end_time', '05:30');
  assert('a haul that ends before it starts is called out',
    /ends before it starts/.test(t.run('haulSectionHtml()')));
  assert('and the tally shows the day no longer adds up',
    t.run('haulHoursAllocated()') !== t.run('entryClockHours()'));

  // Removing the FIRST haul hands its hours forward rather than dropping them.
  const t2 = makeSandbox(TRUCKING, null, null);
  t2.call('haulAddLeg');
  const [x, y] = t2.legs();
  t2.call('haulRemoveLeg', x.key);
  assert('the survivor covers the whole day again',
    t2.legs().length === 1 && y.start_time === '07:00' && y.end_time === '15:30',
    JSON.stringify([y.start_time, y.end_time]));
}

console.log('\n[what is being typed survives a pre-fill landing]');
{
  // The lookup lands a moment after the modal opens, and re-renders the section
  // from the model. Anything typed but not yet committed has to survive that:
  // the box keeps its text and the caret, so a save cannot post a customer the
  // approver had already replaced.
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  const leg = t.legs()[0];
  // Typing goes into the model on every keystroke, not just on blur.
  t.call('haulEdit', leg.key, 'company', 'Ant');
  assert('a half-typed customer is already in the model', leg.company === 'Ant');
  assert('and the box is bound to fire on input',
    /id="hl_\$\{leg\.key\}_company"[\s\S]{0,260}\$\{haulIn\(leg, 'company'\)\}/.test(SRC));

  // Mid-word, with focus in the box, a re-render must not put the old value back.
  const box = t.el(`hl_${leg.key}_company`);
  box.value = 'Anter';
  box.selectionStart = 5;
  t.focus(box);
  t.call('truckingRenderFields', null);
  assert('the box keeps what is in it across a re-render',
    t.el(`hl_${leg.key}_company`).value === 'Anter',
    t.el(`hl_${leg.key}_company`).value);
}

console.log('\n[hours that would fold the clock]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  const leg = t.legs()[0];
  t.call('haulSetHours', leg.key, '24');
  assert('a 24-hour haul is refused rather than collapsed to zero',
    leg.end_time === '15:00' && t.call('haulHours', leg) === 10,
    JSON.stringify([leg.end_time, t.call('haulHours', leg)]));
  t.call('haulSetHours', leg.key, '6');
  assert('while an ordinary figure still moves the end', leg.end_time === '11:00');
}

console.log('\n[a UB haul posts nothing to Truck Tracking]');
{
  // A haul billed off Dust Control Tracking is the dust office's from end to
  // end — recorded, priced and invoiced on its own grid — so no Truck Tracking
  // row is posted beside it, and none of that tab's boxes are asked for.
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  assert('the lone haul carries a header line',
    /The whole day/.test(t.run('haulSectionHtml()')));
  assert('the day defaults to the tracking grid', t.legs()[0].dest !== 'ob');
  assert('so the haul posts no Truck Tracking row',
    t.run('legPostsTruck(haulLegs[0])') === false);
  assert('and neither does the day', t.run('anyTruckLeg()') === false);
  t.call('haulTallyRefresh');
  assert('nothing claims a Truck Tracking row bills the day',
    !/Truck Tracking bills the day/.test(t.el(`hl_${t.legs()[0].key}_truckOut`).textContent),
    t.el(`hl_${t.legs()[0].key}_truckOut`).textContent);
  // Split, so the per-haul fee box is the one in play: it is Truck Tracking's
  // only column in this modal, and a UB haul has no row for it to land on.
  t.call('haulAddLeg');
  assert('no per-haul fee box on a UB day',
    !/_haulFee/.test(t.run('haulSectionHtml()')));
}

console.log('\n[a material haul still says what its truck row bills]');
{
  // Other Billing prices the material; the hauling of it is trucking's line, so
  // that haul DOES post a Truck Tracking row — and the day's hours it bills are
  // spelled out, rather than leaving the two tabs to disagree unannounced.
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t.call('haulSetDest', t.legs()[0].key, 'ob');
  assert('the haul posts a Truck Tracking row', t.run('legPostsTruck(haulLegs[0])') === true);
  assert('with the hours it will actually bill',
    /_truckOut/.test(t.run('haulSectionHtml()')));
  t.call('haulTallyRefresh');
  assert('spelled out in full',
    /Truck Tracking bills the day: 10\.00 h/.test(t.el(`hl_${t.legs()[0].key}_truckOut`).textContent),
    t.el(`hl_${t.legs()[0].key}_truckOut`).textContent);
}

console.log('\n[typing a customer, then blurring, still re-rates the haul]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t.call('haulAddLeg');
  const [, b] = t.legs();
  // Keystroke by keystroke, the way the box actually fires.
  for (const partial of ['A', 'An', 'Ant', 'Ante', 'Anter', 'Antero']) {
    t.call('haulEdit', b.key, 'company', partial);
  }
  assert('nothing is re-derived while they are still typing', b.v1_rate === '135');
  t.call('haulSetCompany', b.key, 'Antero');
  assert('and the blur re-rates the haul for its new customer', b.v1_rate === '145');
  // Blurring again with no change must not disturb a rate they then corrected.
  t.call('haulEdit', b.key, 'v1_rate', '160');
  t.call('haulSetCompany', b.key, 'Antero');
  assert('a second blur leaves a corrected rate alone', b.v1_rate === '160');
}

console.log('\n[the per-haul destination toggle]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  const [first] = t.legs();
  assert('a dust day opens on the tracking grid', t.call('legDest', first) === 'dust');

  t.call('haulSetDest', first.key, 'ob');
  assert('the toggle moves it to Other Billing', t.call('legDest', t.legs()[0]) === 'ob');
  assert('and the truck, customer and window are untouched',
    t.legs()[0].vehicle1 === 'Distributor Truck 4000'
    && t.legs()[0].company === 'CNX'
    && t.legs()[0].start_time === '05:00' && t.legs()[0].end_time === '15:00');

  // The UB answers stay on the leg so flipping back loses nothing — the save
  // simply never sends them while the leg is billing material.
  t.call('haulEdit', t.legs()[0].key, 'material', 'ClearFrac');
  t.call('haulSetDest', t.legs()[0].key, 'dust');
  assert('flipping back is free', t.call('legDest', t.legs()[0]) === 'dust');
  assert('and the material typed under the other grid is still there',
    t.legs()[0].material === 'ClearFrac');

  // A haul added after a delivery is usually another delivery.
  t.call('haulSetDest', t.legs()[0].key, 'ob');
  t.call('haulAddLeg');
  assert('an added haul inherits the destination above it',
    t.legs().length === 2 && t.call('legDest', t.legs()[1]) === 'ob');
  assert('and a day with any material haul is reported as mixed',
    t.run('anyObLeg()') === true && t.run('allObLegs()') === true);

  t.call('haulSetDest', t.legs()[1].key, 'dust');
  assert('one of each is mixed but not all',
    t.run('anyObLeg()') === true && t.run('allObLegs()') === false);
}

console.log('\n[re-editing a day that ran to both dust grids]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  // What ?action=split answers for a day whose MIDDLE haul billed material:
  // two tracking legs at 1 and 3, one Other Billing leg at 2.
  const dustRows = [
    { leg: 1, dest: 'dust', company: 'CNX', start_time: '05:00', end_time: '08:00',
      company_man: 'Steve Quinn', location: 'Deer Lick Compressor', state: 'PA',
      gallons_ub: '3000', vehicle1: 'Distributor Truck 4000', v1_rate: '135',
      vehicle2: 'Escort Vehicle 7549', v2_rate: '60', haul_fee: '' },
    { leg: 3, dest: 'dust', company: 'CNX', start_time: '12:00', end_time: '15:00',
      company_man: 'Steve Quinn', location: 'Deer Lick Compressor', state: 'PA',
      gallons_ub: '2000', vehicle1: 'Distributor Truck 4000', v1_rate: '135',
      vehicle2: 'Escort Vehicle 7549', v2_rate: '60', haul_fee: '' },
  ];
  const obRows = [
    { leg: 2, dest: 'ob', company: 'Antero', start_time: '08:00', end_time: '12:00',
      location: 'Bear Hollow', state: 'WV', vehicle1: 'Distributor Truck 4000',
      trailer_number: 'TR-9', material: 'Calcium Chloride', gallons_bags: '40',
      mu: 'BAG', price_per_unit: '12.5', trucking_rate: '95' },
  ];
  t.run('dustRowsSeen = [1];');   // a re-edit: the posted rows are authoritative
  t.call('dustApplyRows', dustRows, obRows);

  const legs = t.legs();
  assert('the day comes back as three hauls', legs.length === 3, String(legs.length));
  assert('in the order they were billed in',
    legs.map(l => t.call('legDest', l)).join(',') === 'dust,ob,dust');
  assert('the material haul lands in the middle, not packed to the front',
    legs[1].company === 'Antero' && legs[1].material === 'Calcium Chloride');
  assert('with its own window', legs[1].start_time === '08:00' && legs[1].end_time === '12:00');
  assert('and its own money', legs[1].price_per_unit === '12.5' && legs[1].trucking_rate === '95');
  assert('the UB hauls keep their gallons',
    legs[0].gallons_ub === '3000' && legs[2].gallons_ub === '2000');

  // A destination the approver already changed is theirs, even if the lookup
  // lands afterwards — it is the one late write that would change which boxes
  // are on screen.
  const t2 = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t2.call('haulSetDest', t2.legs()[0].key, 'ob');
  t2.run('dustRowsSeen = [1];');
  t2.call('dustApplyRows', [dustRows[0]], []);
  assert('a late pre-fill cannot move a haul the approver just re-pointed',
    t2.call('legDest', t2.legs()[0]) === 'ob');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
