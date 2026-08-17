#!/usr/bin/env node
'use strict';
/**
 * Payroll's "split this day across hauls" modal — the dust half.
 *
 * Run: node scripts/test-dust-split-modal.js
 *
 * A driver's day is one timesheet entry, but the dust office bills per haul:
 * ten hours can be 4,000 gallons on one customer's pad and 2,000 on another's.
 * The approving supervisor splits the day here, and each leg posts its own Dust
 * Control Tracking row. Two layers:
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

console.log('Payroll dust split modal\n');

// ── 1) Structural ───────────────────────────────────────────────────────────
console.log('[the payload the modal and the server agree on]');
{
  const save = SRC.match(/async function truckingSave\(\)[\s\S]+?\n    \}\n/);
  assert('truckingSave sends the legs as dust.rows',
    !!save && /body\.dust = \{\s*\n\s*rows: dustLegs\.map/.test(save[0]));
  assert('every leg carries its own window',
    !!save && /start_time:\s*leg\.start_time/.test(save[0]) && /end_time:\s*leg\.end_time/.test(save[0]));
  assert('a leg on the timesheet customer sends no company',
    !!save && /=== entryCo \? undefined : leg\.company/.test(save[0]));
  assert('a haul with no hours is refused before it can bill nothing',
    !!save && /has no hours/.test(save[0]));

  // The server reads that payload, caps it, and prunes what a save dropped.
  assert('the server accepts { rows: [...] }',
    /Array\.isArray\(raw\.rows\)\) legs = raw\.rows/.test(SERVER));
  assert('…and still accepts the old flat object',
    /else if \(typeof raw === 'object'\) legs = \[raw\]/.test(SERVER));
  assert('the server prunes legs a save no longer has',
    /const drop = prior\.map\(r => String\(r\.id\)\)\.filter\(id => id && !keep\.has\(id\)\)/.test(SERVER));
  assert('leg 1 keeps the historic row id',
    /n <= 1 \? `\$\{dustRowIdPrefix\(entryId\)\}row`/.test(LIB));

  const cap = LIB.match(/const MAX_DUST_ROWS = (\d+)/);
  const uiCap = SRC.match(/const MAX_DUST_LEGS = (\d+)/);
  assert('the modal and the server cap the split at the same number',
    !!cap && !!uiCap && cap[1] === uiCap[1], `${cap && cap[1]} vs ${uiCap && uiCap[1]}`);

  // The read-time sweep must no longer treat a second leg as a duplicate.
  assert('the sweep keeps every live leg of one entry',
    /Several live rows for ONE entry is normal/.test(LIB) && !/keptByEntry/.test(LIB));
}

// ── 2) Behavioural ──────────────────────────────────────────────────────────
// The leg model, run for real against a stubbed DOM.
function makeSandbox(entry, options, companies) {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, { id, value: '', textContent: '', innerHTML: '', style: {}, className: '' });
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
    num2: n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2),
    TK_LABEL: '', TK_INPUT: '',
    document: {
      activeElement: null,
      getElementById: id => el(id),
    },
    console,
  };
  vm.createContext(ctx);
  const start = SRC.indexOf('    // ── The dust half of the same modal ─');
  const end   = SRC.indexOf("    const TK_LABEL = 'display:flex");
  if (start < 0 || end < 0) throw new Error('could not find the dust half of payroll.html');
  vm.runInContext(SRC.slice(start, end), ctx);
  // The block's own `let`s live in the context's lexical scope, not on the
  // context object, so they are reached by running code in the same context
  // rather than by poking at ctx.
  const run = code => vm.runInContext(code, ctx);
  ctx.__opts = options;
  ctx.__cos  = companies;
  run('dustOptions = __opts; dustCompanies = __cos; dustLegs = [dustFreshLeg(null)];');
  return {
    run,
    legs: () => run('dustLegs'),
    call: (fn, ...args) => { ctx.__args = args; return run(`${fn}(...__args)`); },
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
  assert('and its hours are the day\'s hours', t.call('dustLegHours', leg) === 10);
  assert('vehicle 1 is the unit the driver logged', leg.vehicle1 === 'Distributor Truck 4000');
  assert('the customer\'s rate beats the vehicle\'s own (135, not 99)', leg.v1_rate === '135');
  assert('the escort follows the customer',
    leg.vehicle2 === 'Escort Vehicle 7549' && leg.v2_rate === '60');
  assert('the customer box opens on the timesheet customer', leg.company === 'CNX');
}

console.log('\n[splitting the day]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t.call('dustAddLeg');
  const [a, b] = t.legs();
  assert('a second haul appears', t.legs().length === 2);
  assert('the day is halved rather than doubled',
    a.start_time === '05:00' && a.end_time === '10:00' &&
    b.start_time === '10:00' && b.end_time === '15:00');
  assert('the two hauls still add up to the day',
    t.call('dustLegHours', a) + t.call('dustLegHours', b) === 10);
  assert('the new haul keeps the same truck', b.vehicle1 === 'Distributor Truck 4000');
  assert('but not the pad or the company man', b.location === '' && b.company_man === '');

  // 4,000 gallons to CNX for five hours, 2,000 to Antero for five.
  t.call('dkEdit', a.key, 'location', 'Deer Lick Compressor');
  t.call('dkEdit', a.key, 'gallons_ub', '4000');
  assert('picking a pad fills the state in', a.state === 'PA');
  t.call('dustSetCompany', b.key, 'Antero');
  assert('re-pointing a haul takes the other customer\'s rate', b.v1_rate === '145');
  // The escort belongs to the customer that was there before: a customer billed
  // no escort rate is not sent one, and is certainly not billed the last
  // customer's escort.
  assert('and drops the previous customer\'s escort',
    b.vehicle2 === '' && b.v2_rate === '');
  assert('while the driver\'s own truck stays on the haul',
    b.vehicle1 === 'Distributor Truck 4000');
  t.call('dkEdit', b.key, 'location', 'Bear Hollow');
  t.call('dkEdit', b.key, 'gallons_ub', '2000');
  assert('the second customer\'s own pad fills its own state', b.state === 'WV');
  assert('each haul keeps its own gallons',
    a.gallons_ub === '4000' && b.gallons_ub === '2000');
  assert('and its own customer', a.company === 'CNX' && b.company === 'Antero');
}

console.log('\n[typing hours instead of times]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t.call('dustAddLeg');
  const [a, b] = t.legs();
  t.call('dustSetHours', a.key, '6');
  assert('the haul ends six hours after it started', a.end_time === '11:00');
  assert('and reads back as six hours', t.call('dustLegHours', a) === 6);
  t.call('dustSetHours', b.key, '0');
  assert('zero hours is ignored rather than collapsing the haul', b.end_time === '15:00');
}

console.log('\n[taking a haul back off]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  t.call('dustAddLeg');
  const [a, b] = t.legs();
  t.call('dustRemoveLeg', b.key);
  assert('one haul is left', t.legs().length === 1);
  assert('and it covers the whole day again',
    a.start_time === '05:00' && a.end_time === '15:00');
  t.call('dustRemoveLeg', a.key);
  assert('the last haul cannot be removed', t.legs().length === 1);
}

console.log('\n[a late pre-fill never overwrites an answer]');
{
  const t = makeSandbox(ENTRY, OPTIONS, COMPANIES);
  // Payroll starts typing while the lookup for the posted rows is still out.
  const leg = t.legs()[0];
  t.call('dkEdit', leg.key, 'gallons_ub', '9999');
  t.call('dkEdit', leg.key, 'company_man', 'Someone Else');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
