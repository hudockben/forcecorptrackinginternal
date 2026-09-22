#!/usr/bin/env node
'use strict';
/**
 * Code Time: a mandatory sub code, the drive, and the iron.
 *
 * Run: node scripts/test-precode-travel-equipment.js
 *
 * Three things the foreman coding his crew could not say, and what each one
 * costs when he cannot:
 *
 *   THE SUB CODE was optional, so "101" with a blank beside it looked complete
 *   and said nothing about which part of 101 the hours were. That is the field
 *   a production rate is measured on — a cost row without one can never be set
 *   against the bid it came from.
 *
 *   THE DRIVE was whatever the employee had filed, and the travel boxes on the
 *   timesheet are optional and routinely blank. The man who drove the crew out
 *   knew the figure and had nowhere to put it. So he may now name one — and it
 *   is a REQUEST, not a change: proposed_travel_hours sits beside the proposal
 *   and the day pays exactly what was filed until an approver applies it.
 *
 *   THE MACHINE was stripped off his proposal outright, on the reasoning that a
 *   machine on a row prices at that machine's hourly rate. What that actually
 *   bought was the iron being reconstructed days later from a schedule by
 *   somebody who was not on the job.
 *
 * The hazard the middle one creates is what most of this file is about. A
 * proposal naming its own drive balances to work + HIS travel, which is
 * deliberately not work + the entry's — so read by payroll's old rule, that
 * mismatch means "the hours moved after this was coded" and every travel
 * proposal ever written is thrown away as stale, silently, on the one screen
 * that exists to show it.
 *
 * Runs the real functions out of coding.html, payroll.html and
 * api/timesheet-entries.js — no server or browser needed.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn } = require('./lib/fn-source');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
function eq(label, got, want) {
  assert(label, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

const root    = path.resolve(__dirname, '..');
const apiSrc  = fs.readFileSync(path.join(root, 'api/timesheet-entries.js'), 'utf8');
const codeSrc = fs.readFileSync(path.join(root, 'coding.html'), 'utf8');
const payrSrc = fs.readFileSync(path.join(root, 'payroll.html'), 'utf8');

/* ═══════ The server's validators ═══════
 *
 * normalizeSplitRow reaches for a handful of module-level helpers and for the
 * destination validator, which has nothing to do with a proposal — the precode
 * branch deletes `dest` off the body before validateSplit ever sees it. Stubbed
 * to "no destination", which is the shape every row in this file has.
 */
const srv = vm.createContext({ console });
vm.runInContext(`
  const _r2 = n => Math.round(Number(n) * 100) / 100;
  const AUTO_INJECT_DIVISIONS = ['turf','paving','kiewit'];
  const MAX_INJECTED_LEGS = 6;
  const safeStr = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const safeHaulType = v => (v === 'on_site' || v === 'off_site') ? v : '';
  function normalizeSplitDest() { return { dest: null }; }
  ${requireFn(apiSrc, 'normalizeSplitRow', 'api/timesheet-entries.js')}
  ${requireFn(apiSrc, 'splitExpectedHours', 'api/timesheet-entries.js')}
  ${requireFn(apiSrc, 'validateSplit', 'api/timesheet-entries.js')}
`, srv);

/**
 * The precode branch's own rules, in the order the endpoint applies them.
 *
 * Read off the page rather than restated where it is possible to — the two
 * validators above are the real ones — but the branch itself is 200 lines
 * inside a request handler, so its three checks are mirrored here. Each is
 * pinned to the source below (see "the endpoint still says so"), which is what
 * keeps this from drifting into a test of its own invention.
 */
function precode(entry, body) {
  const clean = (body.split || []).map(r => {
    if (!r || typeof r !== 'object') return r;
    const o = Object.assign({}, r);
    delete o.dest; delete o.is_haul; delete o.haul_type;
    return o;
  });
  let proposedTravel = Number(entry.travel_hours) || 0;
  if (body.travel_hours != null && body.travel_hours !== '') {
    const t = Number(body.travel_hours);
    if (!Number.isFinite(t) || t < 0 || t > 24) return { err: 'travel_hours must be between 0 and 24' };
    proposedTravel = Math.round(t * 100) / 100;
  }
  const { rows, error } = srv.validateSplit(clean, entry, proposedTravel);
  if (error) return { err: error };
  for (let i = 0; i < rows.length; i++) {
    if (!String(rows[i].cost_code || '').trim()) return { err: `split[${i}] needs a cost code` };
    if (!String(rows[i].sub_code || '').trim())  return { err: `split[${i}] needs a sub code` };
  }
  return {
    rows,
    coded_for_hours:       srv.splitExpectedHours(entry, proposedTravel),
    proposed_travel_hours: proposedTravel,
  };
}

/** The same, for a body that names no drive at all — an older client, or any
 *  caller that never opted into the travel question. */
function precodeNoTravelKey(entry, split) {
  const { rows, error } = srv.validateSplit(split, entry, null);
  if (error) return { err: error };
  return {
    rows,
    coded_for_hours:       srv.splitExpectedHours(entry, null),
    proposed_travel_hours: Math.round((Number(entry.travel_hours) || 0) * 100) / 100,
  };
}

/* ═══════ Code Time's sheet ═══════
 *
 * The page's own hours helpers and row predicates. saveCoding is one method
 * with a DOM in the middle of it, so its validation walk is mirrored below the
 * lifted helpers — every figure it works from comes off the real ones.
 */
// The mirror writes its row's live input as well as the row. There is no DOM
// here, so the lookup simply misses — which is the same path a real browser
// takes before the first paint, and harvestSheetDom's re-derive is what covers
// it either way.
const cod = vm.createContext({ console, document: { getElementById: () => null } });
vm.runInContext(`
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  ${requireFn(codeSrc, 'workHours', 'coding.html')}
  ${requireFn(codeSrc, 'filedTravel', 'coding.html')}
  ${requireFn(codeSrc, 'requiredHours', 'coding.html')}
  ${requireFn(codeSrc, 'proposedTravel', 'coding.html')}
  ${requireFn(codeSrc, 'proposalStale', 'coding.html')}
  ${requireFn(codeSrc, 'travelPending', 'coding.html')}
  ${requireFn(codeSrc, 'blankRow', 'coding.html')}
  ${requireFn(codeSrc, 'isPickup', 'coding.html')}
  ${requireFn(codeSrc, 'travelCandidates', 'coding.html')}
  ${requireFn(codeSrc, 'travelSubsFor', 'coding.html')}
  ${requireFn(codeSrc, 'pickTravelCodes', 'coding.html')}
  let sheet = null;
  ${requireFn(codeSrc, 'mirrorPickupHours', 'coding.html')}
  ${requireFn(codeSrc, 'applyTravelCodes', 'coding.html')}
  globalThis.setSheet = s => { sheet = s; };
  globalThis.mirrorPickupHours = mirrorPickupHours;
  globalThis.applyTravelCodes = applyTravelCodes;
  ${(codeSrc.match(/const isEquipRow\s+= [^\n]+/) || [])[0]}
  ${(codeSrc.match(/const isTravelRow = [^\n]+/) || [])[0]}
  ${(codeSrc.match(/const TRAVEL_CODE_RE = [^\n]+/) || [])[0]}
  // \`const\` is a lexical binding, not a property of the context — a function
  // declaration lands on the sandbox by itself and an arrow const does not. The
  // arrows are the page's, lifted above; these lines only publish them.
  globalThis.r2 = r2;
  globalThis.isEquipRow = isEquipRow;
  globalThis.isTravelRow = isTravelRow;
`, cod);

/** openSheet's default rows, for a day nobody has coded yet. The pickup rides
 *  the drive, the first other machine rides the work row, and only a second one
 *  needs a line of its own — so the ordinary day is two rows. */
function defaultRows(e) {
  const rows = [cod.blankRow('work')];
  rows[0].labor_hours = String(cod.workHours(e));
  const t = cod.blankRow('travel');
  t.labor_hours = cod.filedTravel(e) > 0 ? String(cod.filedTravel(e)) : '';
  rows.push(t);
  const seen = new Set();
  let pickupSeated = false;
  for (const p of (e.equipment_used || [])) {
    const k = p.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const hours = p.hours != null && p.hours > 0 ? cod.r2(p.hours) : 0;
    if (cod.isPickup(p.name) && !pickupSeated) {
      const drive = cod.filedTravel(e);
      if (drive <= 0 && hours <= 0) continue;
      t.equipment   = p.name;
      t.equip_hours = drive > 0 ? String(drive) : String(hours);
      pickupSeated = true;
      continue;
    }
    if (hours <= 0) continue;
    if (!cod.isPickup(p.name) && !String(rows[0].equipment || '').trim()) {
      rows[0].equipment   = p.name;
      rows[0].equip_hours = String(hours);
      rows[0]._equipHoursTouched = true;
      continue;
    }
    const r = cod.blankRow('equip');
    r.equipment   = p.name;
    r.equip_hours = String(hours);
    r._equipHoursTouched = true;
    rows.push(r);
  }
  return rows;
}

/**
 * The page's OWN mirror, run against a sheet of these rows.
 *
 * Restating it here instead cost a blocker: the restatement had no notion of
 * "no drive to mirror", the real one levelled a pickup's fallback hours to
 * zero on the first harvest, and every assertion still passed because the
 * harness only ever built rows and never harvested them. So the real function
 * is lifted, and `harvest()` below runs what harvestSheetDom runs.
 */
function mirror(rows, i) {
  cod.setSheet({ rows });
  return cod.mirrorPickupHours(i);
}

/** setField's labor_hours branch on a travel row, model side. The DOM write is
 *  the other half and is asserted against the page source. */
function typeTravelHours(rows, i, value) {
  rows[i].labor_hours = value;
  mirror(rows, i);
  return rows;
}

/** What harvestSheetDom does after its DOM-to-row loop: re-derive every row's
 *  mirror. This is the pass that runs on open, on every deferred repaint, and
 *  once more inside saveCoding a line before the POST. */
function harvest(rows) {
  rows.forEach((r, i) => mirror(rows, i));
  return rows;
}

/** openSheet reopening a stored proposal. */
function reopen(stored) {
  return stored.map(r => {
    const labor = Number(r.labor_hours) || 0;
    return {
      kind: r.is_travel ? 'travel' : (labor > 0 ? 'work' : 'equip'),
      cost_code: r.cost_code || '', sub_code: r.sub_code || '',
      quantity: r.quantity ? String(r.quantity) : '',
      labor_hours: r.labor_hours != null ? String(r.labor_hours) : '',
      equipment: r.equipment || '',
      equip_hours: r.equip_hours ? String(r.equip_hours) : '',
      is_travel: !!r.is_travel,
      code_source: 'manual',
      _equipHoursTouched: (Number(r.equip_hours) || 0) > 0
        && !(r.is_travel && cod.isPickup(r.equipment)
             && Math.abs((Number(r.equip_hours) || 0) - (Number(r.labor_hours) || 0)) < 0.001),
    };
  });
}

/** saveCoding: what it refuses, and the body it posts when it does not. */
function save(entry, sheetRows) {
  const kept = sheetRows.map((r, i) => ({ r, n: i + 1 })).filter(({ r }) =>
    !cod.isTravelRow(r) || (Number(r.labor_hours) || 0) > 0
    || String(r.equipment || '').trim() || (Number(r.equip_hours) || 0) > 0);
  const rows = kept.map(x => x.r);
  if (!rows.length) return { err: 'There is nothing on this day to code.' };
  for (const { r, n } of kept) {
    const h = Number(r.labor_hours) || 0, eh = Number(r.equip_hours) || 0;
    const eq = String(r.equipment || '').trim();
    if (eq && !(eh > 0))  return { err: `Row ${n} names ${eq} but gives it no hours.` };
    if (!eq && eh > 0)    return { err: `Row ${n} has machine hours but no machine.` };
    if (cod.isEquipRow(r)) { if (!eq) return { err: `Row ${n} is an equipment row with no machine on it.` }; }
    else if (h <= 0 && !eq) return { err: `Row ${n} has no hours on it.` };
    if (!String(r.cost_code || '').trim()) return { err: `Row ${n} needs a cost code.` };
    if (!String(r.sub_code  || '').trim()) return { err: `Row ${n} needs a sub code.` };
  }
  const wantWork = cod.workHours(entry);
  const gotWork  = cod.r2(rows.reduce((s, r) =>
    s + ((!cod.isTravelRow(r) && !cod.isEquipRow(r)) ? (Number(r.labor_hours) || 0) : 0), 0));
  if (Math.abs(gotWork - wantWork) > 0.001) {
    return { err: `The work rows add up to ${gotWork} h and this day was worked ${wantWork} h.` };
  }
  return {
    travel_hours: cod.r2(rows.reduce((s, r) =>
      s + (cod.isTravelRow(r) ? (Number(r.labor_hours) || 0) : 0), 0)),
    split: rows.map(r => ({
      cost_code: String(r.cost_code || '').trim(), sub_code: String(r.sub_code || '').trim(),
      quantity: Number(r.quantity) || 0, labor_hours: Number(r.labor_hours) || 0,
      equipment: String(r.equipment || '').trim(), equip_hours: Number(r.equip_hours) || 0,
      is_travel: cod.isTravelRow(r),
    })),
  };
}

const code = (rows, cc = '101', sc = 'A') => { rows.forEach(r => { r.cost_code = cc; r.sub_code = sc; }); return rows; };

/* ═══════ Payroll's reading of it ═══════ */
const pay = vm.createContext({ console });
vm.runInContext(`
  ${(payrSrc.match(/const codeR2 = [^\n]+/) || [])[0]}
  ${requireFn(payrSrc, 'codedProposedTravel', 'payroll.html')}
  ${requireFn(payrSrc, 'codedRequiredHours', 'payroll.html')}
  ${requireFn(payrSrc, 'codedTravelPending', 'payroll.html')}
  ${requireFn(payrSrc, 'codedProposalStale', 'payroll.html')}
  globalThis.codeR2 = codeR2;
`, pay);

/* ═══════ The haul rules a coder's machine now meets ═══════
 *
 * On a haul day the day-level answer marks every work row a haul before any of
 * this is read, so the $0 labour rate is the driver's own answer and not
 * something a proposal causes. What a proposal CAN cause is the machine on the
 * row: splitDefaultHaulEquipment only fills a blank one, so a machine the coder
 * named sat where the driver's truck belonged. These are the real rules, run
 * in the order openSplitModal runs them.
 */
const haul = vm.createContext({ console });
vm.runInContext(`
  ${(payrSrc.match(/const TRAVEL_CODE_RE = [^\n]+/) || [])[0]}
  let splitEntry = null, splitRows = [], splitProjEquipment = [];
  ${requireFn(payrSrc, 'isTravelSplitRow', 'payroll.html')}
  ${requireFn(payrSrc, 'splitTruckOnRow', 'payroll.html')}
  ${requireFn(payrSrc, 'splitRowHaulAnswer', 'payroll.html')}
  ${requireFn(payrSrc, 'splitRowTakesTruck', 'payroll.html')}
  ${requireFn(payrSrc, 'splitHaulTruckName', 'payroll.html')}
  ${requireFn(payrSrc, 'splitDefaultHaulEquipment', 'payroll.html')}
  ${requireFn(payrSrc, 'splitSeedRowHaul', 'payroll.html')}
  ${requireFn(payrSrc, 'splitClearNamedOnHaul', 'payroll.html')}
  ${requireFn(payrSrc, 'splitEquipIsPickup', 'payroll.html')}
  // openSplitModal's seeding of a stored proposal, then the take-back and the
  // truck default that splitMirrorHaulEquipHoursAll drives.
  globalThis.openOn = (entry, row) => {
    splitEntry = entry; splitRows = [row];
    const said = entry.haul_type || '';
    if (said === 'on_site' || said === 'off_site') {
      splitRows.filter(r => !r.is_travel && !r.haul_type).forEach(r => { r.haul_type = said; });
    }
    splitRows.forEach(r => {
      r.haul_type = splitSeedRowHaul(r);
      if (r.haul_type === 'none' && r.is_haul === undefined) r.is_haul = false;
    });
    splitRows.forEach(r => { splitClearNamedOnHaul(r); splitDefaultHaulEquipment(r); });
    return splitRows[0];
  };
`, haul);

/** A coder's proposed row, mapped as openSplitModal maps it. */
function codedRow(equipment, isTravel) {
  return {
    cost_code: '101', sub_code: 'A', labor_hours: isTravel ? 1 : 8,
    equip_hours: equipment ? 6 : 0, equipment: equipment || '',
    is_travel: !!isTravel, is_haul: undefined, haul_type: undefined,
    // The flag the mapping sets: a coder's machine on a work row is a NAMED
    // one, to be taken back where the row turns out to be a haul.
    _namedAutoEquip: !isTravel && !!equipment,
  };
}

/** buildBulkBody's merge of the card's machines onto a coded day. */
function bulkMerge(coded, cardMachines) {
  const named = new Set(coded.map(r => String(r.equipment || '').trim().toLowerCase()).filter(Boolean));
  const machines = cardMachines.filter(m => m.equipment && !named.has(String(m.equipment).trim().toLowerCase()));
  const workM   = machines.filter(m => m.leg !== 'travel');
  const travelM = machines.filter(m => m.leg === 'travel');
  const firstWork   = coded.find(r => !r.is_travel && !String(r.equipment || '').trim());
  const firstTravel = coded.find(r =>  r.is_travel && !String(r.equipment || '').trim());
  const seat = (row, m) => {
    if (!row || !m || !m.equipment) return false;
    row.equipment = m.equipment; row.equip_hours = m.equip_hours; return true;
  };
  const sw = seat(firstWork, workM[0]);
  const st = seat(firstTravel, travelM[0]);
  for (const m of [...(sw ? workM.slice(1) : workM), ...(st ? travelM.slice(1) : travelM)]) {
    if (!m.equipment || !(m.equip_hours > 0)) continue;
    const onTravel = m.leg === 'travel';
    const src = coded.find(r => !!r.is_travel === onTravel) || coded[0];
    coded.push({ cost_code: src ? src.cost_code : '', sub_code: src ? src.sub_code : '',
                 quantity: 0, equipment: m.equipment, labor_hours: 0,
                 equip_hours: m.equip_hours, is_travel: onTravel });
  }
  return coded;
}

/** applyProposedTravel's leg split. */
function applyLegs(e, asked) {
  const toSite = pay.codeR2(e.travel_to_site_hours);
  const toShop = pay.codeR2(e.travel_to_shop_hours);
  const legs   = pay.codeR2(toSite + toShop);
  if (legs > 0) {
    const newSite = pay.codeR2(asked * (toSite / legs));
    return { newSite, newShop: pay.codeR2(asked - newSite) };
  }
  return { newSite: asked, newShop: 0 };
}

/* ═══════════════════════════════════════════════════════════════════════ */

console.log('\nA sub code on every row');
{
  const e = { computed_hours: 8, travel_hours: 0, equipment_used: [] };
  const rows = defaultRows(e); rows.forEach(r => { r.cost_code = '101'; });
  const out = save(e, rows);
  assert('the sheet refuses a blank sub code', /sub code/.test(out.err || ''), JSON.stringify(out));

  const srvOut = precode(e, { travel_hours: 0, split: [{ cost_code: '101', sub_code: '', labor_hours: 8 }] });
  assert('and so does the endpoint, for a screen that skipped it',
    /sub code/.test(srvOut.err || ''), JSON.stringify(srvOut));

  const ok = precode(e, { travel_hours: 0, split: [{ cost_code: '101', sub_code: 'A', labor_hours: 8 }] });
  assert('a row carrying both is accepted', !ok.err, ok.err);

  assert('a sub code with no cost code is still refused',
    /cost code/.test((precode(e, { travel_hours: 0, split: [{ cost_code: '', sub_code: 'A', labor_hours: 8 }] }).err) || ''));

  assert('the endpoint still says so',
    /needs a sub code — every row coded here/.test(apiSrc),
    'the precode sub-code rule this suite mirrors is gone from api/timesheet-entries.js');
}

console.log('\nThe drive: prefilled, editable, and only ever a request');
{
  const filedTwo = { computed_hours: 8, travel_hours: 2, equipment_used: [] };
  const body = save(filedTwo, code(defaultRows(filedTwo)));
  eq('a filed drive comes back prefilled', body.travel_hours, 2);
  const out = precode(filedTwo, body);
  eq('and the day still allocates work + travel', out.coded_for_hours, 10);
  eq('the figure is stored even when he agreed with it', out.proposed_travel_hours, 2);

  const none = { computed_hours: 8, travel_hours: 0, equipment_used: [] };
  const untouched = save(none, code(defaultRows(none)));
  eq('a travel row left empty is dropped, not an error', untouched.split.length, 1);
  eq('and reads as no drive at all', untouched.travel_hours, 0);
  eq('allocating the work hours alone', precode(none, untouched).coded_for_hours, 8);

  const rows = code(defaultRows(none));
  rows[1].labor_hours = '2';
  const added = save(none, rows);
  assert('he can add a drive nobody filed', !added.err, added.err);
  eq('the split then allocates work + HIS drive', precode(none, added).coded_for_hours, 10);
  eq('and the figure rides along for the approver', precode(none, added).proposed_travel_hours, 2);

  const misallocated = precode(none, {
    travel_hours: 2,
    split: [{ cost_code: '101', sub_code: 'A', labor_hours: 10, is_travel: false }],
  });
  assert('a drive the rows do not carry is refused — it would book the commute to a production code',
    /travel rows total/.test(misallocated.err || ''), JSON.stringify(misallocated));

  assert('out-of-range travel is refused',
    /between 0 and 24/.test(precode(none, { travel_hours: 25, split: [] }).err || ''));

  assert('the sheet still names the entry\'s own figure beside his',
    /Timesheet says \$\{n2\(filed\)\} h/.test(codeSrc),
    'the filed-travel hint is gone from coding.html');
  assert('and says plainly that his does not move anybody\'s hours',
    /His hours do not change on this screen/.test(codeSrc));
}

console.log('\nEquipment, with its hours');
{
  const e = { computed_hours: 8, travel_hours: 0,
              equipment_used: [{ name: 'CAT 336', hours: 6 }, { name: 'Roller', hours: 3 }] };
  const rows = code(defaultRows(e));
  eq('the first machine rides the work row, not a line of its own', rows[0].equipment, 'CAT 336');
  eq('at the hours HE gave it', rows[0].equip_hours, '6');
  eq('so only the second machine needs its own row', rows.filter(cod.isEquipRow).length, 1);
  const out = precode(e, save(e, rows));
  assert('and survives the endpoint, which used to strip it', !out.err, out.err);
  eq('with the machines intact', out.rows.map(r => r.equipment), ['CAT 336', 'Roller']);
  eq('and their hours', out.rows.map(r => r.equip_hours), [6, 3]);
  eq('machine hours never disturb the labour balance', out.coded_for_hours, 8);

  // A machine nobody gave hours to cannot be priced, and a row carrying one
  // opens the sheet already failing its own check with the error pointing at a
  // row the foreman never wrote. It is left off; he still has "+ Equipment".
  const noHours = { computed_hours: 8, travel_hours: 0, equipment_used: [{ name: 'CAT 336', hours: null }] };
  const nh = defaultRows(noHours);
  eq('a machine named with no hours opens no row at all', nh.length, 2);
  eq('and none of them carries it', nh.filter(r => r.equipment).length, 0);
  assert('so the sheet does not open already failing validation', !save(noHours, code(nh)).err);
  // ...but "left off" and "never mentioned" must not look the same on screen.
  assert('and the sheet says which machine it left off, and why',
    /named \$\{esc\(unpriced\.join\(', '\)\)\} on his timesheet without saying how long/.test(codeSrc),
    'a machine the employee named vanishes with nothing on screen saying so');

  const stray = code(defaultRows({ computed_hours: 8, travel_hours: 0, equipment_used: [] }));
  stray[0].equip_hours = '4';
  assert('machine hours with no machine are refused — the job would be billed for iron nobody can name',
    /no machine/.test(save({ computed_hours: 8, travel_hours: 0 }, stray).err || ''));

  const onWork = code(defaultRows({ computed_hours: 8, travel_hours: 0, equipment_used: [] }));
  onWork[0].equipment = 'Paver'; onWork[0].equip_hours = '5';
  const rode = precode({ computed_hours: 8, travel_hours: 0 }, save({ computed_hours: 8, travel_hours: 0 }, onWork));
  eq('a machine may also ride the row that carries the labour', rode.rows[0].equipment, 'Paver');
  eq('at its own hours', rode.rows[0].equip_hours, 5);

  const back = reopen([
    { cost_code: '101', sub_code: 'A',   labor_hours: 8, equip_hours: 0, equipment: '',        is_travel: false, quantity: 0 },
    { cost_code: '900', sub_code: 'TRV', labor_hours: 2, equip_hours: 2, equipment: 'Pickup',  is_travel: true,  quantity: 0 },
    { cost_code: '101', sub_code: 'A',   labor_hours: 0, equip_hours: 6, equipment: 'CAT 336', is_travel: false, quantity: 0 },
  ]);
  eq('reopening a saved proposal keeps each row the kind it was', back.map(r => r.kind), ['work', 'travel', 'equip']);
  assert('a machine line does not come back as work owing hours the day has not got',
    save({ computed_hours: 8, travel_hours: 2 }, back).err === undefined,
    JSON.stringify(save({ computed_hours: 8, travel_hours: 2 }, back).err));

  assert('the endpoint no longer strips the machine',
    !/delete out\.dest; delete out\.is_haul; delete out\.haul_type; delete out\.equipment;/.test(apiSrc),
    'equipment is being stripped off a proposal again');
}

console.log('\nPayroll tells a proposed drive from a stale proposal');
{
  const agreed = { status: 'submitted', coded_source: 'precode', computed_hours: 8, travel_hours: 2,
                   proposed_travel_hours: 2, coded_for_hours: 10, proposed_split: [{}] };
  eq('a drive he agreed with is nothing to decide', pay.codedTravelPending(agreed), false);
  eq('and the proposal is not stale', pay.codedProposalStale(agreed), false);

  const asking = { ...agreed, travel_hours: 0 };
  eq('a drive he is asking for IS pending', pay.codedTravelPending(asking), true);
  eq('and must never read as stale — that would throw his codes away', pay.codedProposalStale(asking), false);

  const applied = { ...asking, travel_hours: 2 };
  eq('applying it closes the question', pay.codedTravelPending(applied), false);
  eq('and the proposal pre-fills, because coded_for_hours was written as work + his drive',
    pay.codedRequiredHours(applied), Number(applied.coded_for_hours));

  const moved = { ...asking, computed_hours: 7 };
  eq('work hours moving underneath it is still staleness', pay.codedProposalStale(moved), true);
  eq('and staleness is not a decision anybody is waiting on', pay.codedTravelPending(moved), false);

  const old = { ...agreed, proposed_travel_hours: null };
  eq('a proposal from before the column existed reads as it always did', pay.codedProposalStale(old), false);
  eq('including when the day moves under it', pay.codedProposalStale({ ...old, computed_hours: 7 }), true);

  const approver = { ...asking, coded_source: 'approve' };
  eq('an approver\'s own written-back split is never "pending" on somebody', pay.codedTravelPending(approver), false);

  assert('and the bulk panel sets such a day aside rather than posting its template over it',
    /if \(isSplit && codedTravelPending\(e\)\)/.test(payrSrc),
    'buildBulkGroups no longer skips a day with a pending drive');
}

console.log('\nCode Time\'s own reading matches payroll\'s');
{
  const asking = { computed_hours: 8, travel_hours: 0, proposed_travel_hours: 2,
                   coded_for_hours: 10, proposed_split: [{}] };
  eq('the coder\'s own queue does not call his proposal stale', cod.proposalStale(asking), false);
  eq('it says the drive is waiting on his supervisor', cod.travelPending(asking), true);
  eq('and reopening it gives him his own rows back', cod.proposalStale(asking), false);
  eq('a day whose work hours moved is stale on both screens',
    cod.proposalStale({ ...asking, computed_hours: 7 }), true);
  eq('the card still shows the hours the day PAYS, not the ones proposed',
    cod.requiredHours(asking), 8);
}

console.log('\nApplying the drive: which leg gets the hours');
{
  eq('no legs filed — all of it on the drive out',
    applyLegs({ travel_to_site_hours: null, travel_to_shop_hours: null }, 2), { newSite: 2, newShop: 0 });
  eq('even legs stay even',
    applyLegs({ travel_to_site_hours: 1, travel_to_shop_hours: 1 }, 3), { newSite: 1.5, newShop: 1.5 });
  eq('one-sided legs stay one-sided',
    applyLegs({ travel_to_site_hours: 2, travel_to_shop_hours: 0 }, 3), { newSite: 3, newShop: 0 });
  eq('a total with no legs behind it does not land entirely on the leg home',
    applyLegs({ travel_hours: 2, travel_to_site_hours: null, travel_to_shop_hours: null }, 3),
    { newSite: 3, newShop: 0 });

  let drift = null;
  for (const [a, b] of [[1, 2], [0.25, 0.5], [3, 7], [0.75, 0.25], [1, 1], [5, 2]]) {
    for (const asked of [0.25, 1, 1.75, 2.5, 3.33, 7, 12.5]) {
      const { newSite, newShop } = applyLegs({ travel_to_site_hours: a, travel_to_shop_hours: b }, asked);
      if (pay.codeR2(newSite + newShop) !== pay.codeR2(asked) || newSite < 0 || newShop < 0) {
        drift = `legs(${a},${b}) asked ${asked} → ${newSite} + ${newShop}`;
      }
    }
  }
  // A cent of drift here leaves coded_for_hours unmatched and the whole trip
  // wasted: the server recomputes travel_hours as the two legs' sum.
  assert('the two legs always add to exactly what was asked for', drift === null, drift);
}

console.log('\nBulk approve does not overwrite what the foreman named');
{
  const his = [{ cost_code: '101', sub_code: 'A', labor_hours: 8, equipment: 'CAT 336', equip_hours: 6, is_travel: false }];
  const merged = bulkMerge(his, [{ equipment: 'Roller', equip_hours: 8, leg: 'work' }]);
  eq('his machine stands', merged[0].equipment, 'CAT 336');
  eq('and his hours with it', merged[0].equip_hours, 6);
  eq('the card\'s machine takes a row of its own', merged.length, 2);
  eq('coded off a row of the same leg', merged[1].cost_code, '101');
  eq('and carrying no labour, so the balance is undisturbed', merged[1].labor_hours, 0);

  const blank = bulkMerge(
    [{ cost_code: '101', sub_code: 'A', labor_hours: 8, equipment: '', equip_hours: 0, is_travel: false }],
    [{ equipment: 'Roller', equip_hours: 8, leg: 'work' }]);
  eq('a row he left blank is still filled from the card', blank[0].equipment, 'Roller');
  eq('without inventing a second row', blank.length, 1);

  const both = bulkMerge(
    [{ cost_code: '101', sub_code: 'A', labor_hours: 8, equipment: 'Roller', equip_hours: 5, is_travel: false }],
    [{ equipment: 'Roller', equip_hours: 8, leg: 'work' }]);
  eq('one machine named on both sides is not billed twice', both.length, 1);
  eq('and his figure is the one kept', both[0].equip_hours, 5);

  const travel = bulkMerge([
    { cost_code: '101', sub_code: 'A',   labor_hours: 8, equipment: 'CAT 336', equip_hours: 6, is_travel: false },
    { cost_code: '900', sub_code: 'TRV', labor_hours: 1, equipment: 'Pickup',  equip_hours: 1, is_travel: true },
  ], [{ equipment: 'F-250 Pickup', equip_hours: 1, leg: 'travel' }]);
  eq('his pickup stands on the travel leg too', travel[1].equipment, 'Pickup');
  eq('and the card\'s takes the travel codes', travel[2].cost_code, '900');
  eq('on the travel leg', travel[2].is_travel, true);

  assert('and a haul day carrying a machine he named is flagged for review, not skipped',
    /WHAT WILL ACTUALLY END UP ON THE WORK ROWS/.test(payrSrc),
    'bulkHaulNeedsReview no longer reads a coded day\'s own machines');
}

console.log('\nA proposal still cannot price anything');
{
  const e = { computed_hours: 8, travel_hours: 0 };
  const out = precode(e, {
    travel_hours: 0,
    split: [{
      cost_code: '101', sub_code: 'A', labor_hours: 8, equipment: 'CAT 336', equip_hours: 8,
      is_haul: true, haul_type: 'off_site',
      dest: { division: 'trucking', job_id: 'X' },
    }],
  });
  assert('the haul answers and the destination are still stripped', !out.err, out.err);
  eq('no haul claim survives', out.rows[0].is_haul, undefined);
  eq('no haul type survives', out.rows[0].haul_type, undefined);
  eq('and no routing to another division', out.rows[0].dest, null);
  eq('while the machine he named does', out.rows[0].equipment, 'CAT 336');
}

console.log('\nA proposal carrying no drive of its own is not stale');
{
  // Number(null) is 0 and 0 is finite, so `Number.isFinite(Number(override))`
  // read a NULL proposed_travel_hours as a deliberate zero — and every day with
  // travel on it came back "codes no longer add up, redo" with nothing wrong.
  // Two populations hit it: proposals written before the column existed, and
  // every approver write-back, which sets proposed_travel_hours = NULL while
  // writing coded_for_hours = work + travel.
  const e = { computed_hours: 8, travel_hours: 2, coded_for_hours: 10,
              proposed_travel_hours: null, proposed_split: [{}], coded_source: 'approve' };
  eq('the sheet counts the day\'s own drive when none was proposed', cod.requiredHours(e, null), 10);
  eq('so a pre-column proposal is not stale on Code Time', cod.proposalStale(e), false);
  eq('nor on payroll', pay.codedProposalStale(e), false);
  eq('and the two screens agree, which is the whole point',
    cod.proposalStale(e), pay.codedProposalStale(e));
  eq('an approver\'s written-back split survives being sent back',
    cod.proposalStale({ ...e, coded_source: 'approve' }), false);
  eq('a real zero is still a real zero',
    cod.requiredHours({ computed_hours: 8, travel_hours: 2 }, 0), 8);
  eq('and the server agrees with both',
    srv.splitExpectedHours({ computed_hours: 8, travel_hours: 2 }, null), 10);
  eq('while an explicit figure still overrides',
    srv.splitExpectedHours({ computed_hours: 8, travel_hours: 2 }, 3), 11);
}

console.log('\nA body that named no drive is not held to the travel-row rule');
{
  // precode resolves its override to the entry's own figure when the key is
  // absent. Testing the RESOLVED number would impose the rule on a caller that
  // never opted in — a split putting a filed drive on a work row, legal since
  // this endpoint existed, would start earning a 400 about a figure nobody sent.
  const e = { computed_hours: 8, travel_hours: 2 };
  const out = precodeNoTravelKey(e, [{ cost_code: '101', sub_code: 'A', labor_hours: 10, is_travel: false }]);
  assert('an older client that sends no travel_hours still saves', !out.err, out.err);
  eq('and its proposal still records the day\'s own drive', out.proposed_travel_hours, 2);
  const named = precode(e, { travel_hours: 2, split: [{ cost_code: '101', sub_code: 'A', labor_hours: 10, is_travel: false }] });
  assert('while a body that DID name one is held to it',
    /travel rows total/.test(named.err || ''), JSON.stringify(named));
}

console.log('\nA coder\'s machine never displaces the driver\'s truck');
{
  const withTruck = { haul_type: 'off_site', truck_unit: 'Triaxle Dump 12' };
  const r1 = haul.openOn(withTruck, codedRow('Roller'));
  eq('on a haul day the truck the driver named wins', r1.equipment, 'Triaxle Dump 12');

  const r2 = haul.openOn(withTruck, codedRow('Triaxle Dump 12'));
  eq('unless the machine he named IS the truck', r2.equipment, 'Triaxle Dump 12');

  const r3 = haul.openOn({ haul_type: 'on_site', truck_unit: '' }, codedRow('Roller'));
  eq('with no truck named the row stays blank — a refusal, not a gap', r3.equipment, '');

  const r4 = haul.openOn({ haul_type: '', truck_unit: '' }, codedRow('Roller'));
  eq('and on an ordinary day his machine simply stands', r4.equipment, 'Roller');
  eq('on a row nothing calls a haul', r4.haul_type, 'none');
  eq('so his labour is still paid', r4.is_haul, false);

  const r5 = haul.openOn({ haul_type: 'off_site', truck_unit: 'Triaxle Dump 12' }, codedRow('Pickup', true));
  eq('a machine on the DRIVE is his answer and is left alone', r5.equipment, 'Pickup');

  assert('and the mapping sets the flag the take-back keys off',
    /_namedAutoEquip: splitFromProposal && fromCoder/.test(payrSrc),
    'a coder\'s machine is no longer marked as a named one');
}

console.log('\nApplying the drive edits the drive and nothing else');
{
  // `=== true` turns a NULL into an explicit false, and normalizeEntryBody nulls
  // equipment_used on any answer but Yes — so a write meant to move two travel
  // figures would have taken the operator's machines off the entry with it.
  const body = (payrSrc.match(/lunch_break: e\.lunch_break,[\s\S]{0,80}operated_equipment: e\.operated_equipment,/) || [])[0];
  assert('the flags are passed through verbatim, not coerced', !!body,
    'applyProposedTravel is coercing operated_equipment/lunch_break again');
  assert('and no equipment_used key is sent, so the server keeps the list',
    !/applyProposedTravel[\s\S]{0,2000}equipment_used:/.test(payrSrc));
}

console.log('\nThe stale chip names the hours the day actually has');
{
  assert('not the drive the coder asked for and nobody granted',
    /const has = \(Number\(e\.computed_hours\) \|\| 0\) \+ \(Number\(e\.travel_hours\) \|\| 0\);/.test(payrSrc),
    'codedChipHtml is reporting codedRequiredHours as what the day "now has" again');
}

console.log('\nThe sheet says when a lookup failed, and keeps what is typed');
{
  assert('a failed equipment lookup is on screen, not only in the console',
    /Could not load the equipment list/.test(codeSrc),
    'an empty machine picker is indistinguishable from a company with no equipment');
  assert('adding a row harvests the form first',
    /function addRow\(kind\) \{ if \(sheet\) \{ harvestSheetDom\(\);/.test(codeSrc));
  assert('and so does removing one',
    /function delRow\(i\)\s+\{ if \(sheet\) \{ harvestSheetDom\(\);/.test(codeSrc));
}

console.log('\nThe pickup rides the drive, and gets no row of its own');
{
  // The user's complaint: the crew's pickup was opening a THIRD row, with two
  // mandatory code cells on a line that only ever says "we drove out in the
  // truck". It belongs on the travel row, under the drive's own codes, for the
  // drive's own hours.
  const e = { computed_hours: 9, travel_hours: 2, equipment_used: [{ name: 'Pickup Truck', hours: 2 }] };
  const rows = defaultRows(e);
  eq('the ordinary day opens as two rows', rows.length, 2);
  eq('with no equipment row at all', rows.filter(cod.isEquipRow).length, 0);
  const t = rows.find(cod.isTravelRow);
  eq('the pickup is on the drive', t.equipment, 'Pickup Truck');
  eq('at the drive\'s hours', t.equip_hours, '2');
  eq('and the drive still carries the filed travel as LABOUR', t.labor_hours, '2');
  eq('the work row is untouched by it', rows[0].equipment, '');

  const out = precode(e, save(e, code(rows)));
  assert('and it saves', !out.err, out.err);
  eq('as two rows', out.rows.length, 2);
  eq('allocating work + travel', out.coded_for_hours, 11);
  eq('the day still pays what was filed — no drive is being proposed', out.proposed_travel_hours, 2);
}

console.log('\nThe pickup follows the drive as the foreman corrects it');
{
  const e = { computed_hours: 9, travel_hours: 2, equipment_used: [{ name: 'Pickup Truck', hours: 2 }] };
  const rows = defaultRows(e);
  const ti = rows.findIndex(cod.isTravelRow);
  typeTravelHours(rows, ti, '1.5');
  eq('the machine hours move with it', rows[ti].equip_hours, '1.5');
  typeTravelHours(rows, ti, '3');
  eq('in both directions', rows[ti].equip_hours, '3');

  // ...until he says otherwise. A pickup left running while the crew worked is
  // a real thing and his answer stands.
  rows[ti]._equipHoursTouched = true;
  typeTravelHours(rows, ti, '1');
  eq('and stops the moment he types his own figure', rows[ti].equip_hours, '3');

  // A drive that does not exist is not a zero-hour drive: the link waits for
  // one rather than levelling his stated figure to nothing, and relights by
  // itself when he types it.
  const none = defaultRows({ computed_hours: 8, travel_hours: 0,
                             equipment_used: [{ name: 'Pickup', hours: 2 }] });
  const ni = none.findIndex(cod.isTravelRow);
  harvest(none);
  eq('with no drive on the row his own figure stands', none[ni].equip_hours, '2');
  typeTravelHours(none, ni, '1.25');
  eq('and the link relights the moment he names one', none[ni].equip_hours, '1.25');

  assert('the mirror writes the input as well as the row, or the harvest reverts it',
    /const el = document\.getElementById\('eqh' \+ i\);/.test(codeSrc),
    'mirrorPickupHours no longer writes the DOM — saveCoding harvests just before it posts');
  assert('and the harvest re-derives it afterwards',
    /sheet\.rows\.forEach\(\(r, i\) => mirrorPickupHours\(i\)\);/.test(codeSrc));
}

console.log('\nA pickup with nothing to bill opens no row');
{
  // No filed drive and no hours of his own: seating it would open the sheet
  // already failing its own check, on a row that bills the job nothing.
  const bare = { computed_hours: 8, travel_hours: 0, equipment_used: [{ name: 'Pickup', hours: null }] };
  const rows = defaultRows(bare);
  eq('nothing carries it', rows.filter(r => r.equipment).length, 0);
  assert('and the sheet saves clean', !save(bare, code(rows)).err);

  // But his own stated hours are enough, where the timesheet filed no drive.
  const stated = { computed_hours: 8, travel_hours: 0, equipment_used: [{ name: 'Pickup', hours: 1.5 }] };
  const r2rows = defaultRows(stated);
  const t = r2rows.find(cod.isTravelRow);
  eq('the pickup rides the drive on his own figure', t.equipment, 'Pickup');
  eq('at the hours he gave it', t.equip_hours, '1.5');
  // THE ONE THAT GOT THROUGH. harvestSheetDom re-derives the mirror on every
  // row, and a mirror with no "is there a drive" guard levelled this to zero
  // before the foreman had touched anything — leaving a machine with no hours,
  // which the save refuses. It runs on open, on every repaint, and once more
  // inside saveCoding.
  harvest(r2rows);
  eq('and the figure survives the harvest', t.equip_hours, '1.5');
  assert('so the day is still saveable after it', !save(stated, code(harvest(r2rows))).err);
  eq('and the drive itself is still zero — his machine hours are not a claim on his pay',
    t.labor_hours, '');
  const out = precode(stated, save(stated, code(r2rows)));
  assert('it saves', !out.err, out.err);
  eq('proposing no drive, so the day stays on payroll\'s fast path', out.proposed_travel_hours, 0);
}

console.log('\nPickup and machine together — still two rows');
{
  const e = { computed_hours: 8, travel_hours: 1,
              equipment_used: [{ name: 'F-250 Pickup', hours: 1 }, { name: 'CAT 336', hours: 7 }] };
  const rows = defaultRows(e);
  eq('two rows', rows.length, 2);
  eq('the excavator on the work row', rows[0].equipment, 'CAT 336');
  eq('the pickup on the drive', rows.find(cod.isTravelRow).equipment, 'F-250 Pickup');
  assert('and it saves', !precode(e, save(e, code(rows))).err);
}

console.log('\nWhat counts as a pickup');
{
  eq('Pickup', cod.isPickup('Pickup'), true);
  eq('Pickup Truck', cod.isPickup('Pickup Truck'), true);
  eq('F-250 Pickup', cod.isPickup('F-250 Pickup'), true);
  eq('Pick-up', cod.isPickup('Pick-up'), true);
  eq('pickups', cod.isPickup('Shop Pickups'), true);
  // The line that matters: a haul unit is not the drive.
  eq('Triaxle Dump Truck is NOT a pickup', cod.isPickup('Triaxle Dump Truck'), false);
  eq('nor is a Roller', cod.isPickup('Roller'), false);
  eq('nor a Truck Crane', cod.isPickup('Truck Crane'), false);

  const second = { computed_hours: 8, travel_hours: 2,
                   equipment_used: [{ name: 'Pickup', hours: 2 }, { name: 'F-250 Pickup', hours: 2 }] };
  const rows = defaultRows(second);
  eq('only the FIRST pickup rides the drive', rows.find(cod.isTravelRow).equipment, 'Pickup');
  eq('a second one takes a row of its own rather than a second travel row',
    rows.filter(cod.isTravelRow).length, 1);
  // A second travel row would be summed into the drive being proposed
  // (sheetTravel) and the server then holds the travel rows to that total.
  eq('and it is an equipment row', rows.filter(cod.isEquipRow).length, 1);
}

console.log('\nThe drive books to the job\'s own travel line, not a constant');
{
  const TURF = [
    { cost_code: 'Mobilization', sub_codes: ['Travel', 'Load'] },
    { cost_code: '101', sub_codes: ['Mowing'] },
  ];
  eq('a turf job returns the pair the user expects, off its own bid items',
    cod.pickTravelCodes(TURF, ''), { cost_code: 'Mobilization', sub_code: 'Travel' });

  const PAVING = [
    { cost_code: '5in Mill & Fill', sub_codes: ['Paving', 'Travel'] },
    { cost_code: 'Excavation Prep', sub_codes: ['Digging', 'Travel'] },
  ];
  eq('a paving job with two tasks will not guess before the work names one',
    cod.pickTravelCodes(PAVING, ''), null);
  eq('and pairs the drive with the task once it does',
    cod.pickTravelCodes(PAVING, '5in Mill & Fill'),
    { cost_code: '5in Mill & Fill', sub_code: 'Travel' });

  eq('a job whose bid items name no drive gets nothing invented for it',
    cod.pickTravelCodes([{ cost_code: '101', sub_codes: ['Mowing'] }], ''), null);
  eq('nor does one whose codes never loaded', cod.pickTravelCodes([], ''), null);

  eq('the travel picker offers the job\'s travel subs, not every sub under the code',
    cod.travelSubsFor(TURF, 'Mobilization'), ['Travel']);

  assert('the prefill never touches a row the foreman has committed',
    /if \(r\.code_source === 'manual'\) continue;/.test(codeSrc),
    'applyTravelCodes can overwrite what the foreman typed');
  assert('and runs after the harvest, never before it',
    /harvestSheetDom\(\); applyTravelCodes\(\); renderSheet\(\);/.test(codeSrc));

  /* The prefill re-runs on a work-row commit, which is what carries paving —
   * and re-running is exactly what makes authorship load-bearing. `commit`
   * below is setField's cost_code branch: mark the row his, then re-derive. */
  const commit = (rows, i, value) => {
    rows[i].cost_code = value;
    rows[i].code_source = 'manual';
    cod.setSheet({ rows, codes: PAVING });
    cod.applyTravelCodes();
    return rows;
  };
  const sheetRows = () => ([
    { kind: 'work',   cost_code: '', sub_code: '', code_source: '', labor_hours: '8' },
    { kind: 'travel', is_travel: true, cost_code: '', sub_code: '', code_source: '', labor_hours: '1' },
  ]);

  let rs = sheetRows();
  commit(rs, 0, '5in Mill & Fill');
  eq('naming the task fills the drive that belongs to it', rs[1].cost_code, '5in Mill & Fill');
  commit(rs, 0, 'Excavation Prep');
  eq('and CHANGING the task re-derives it rather than leaving the drive on the old one',
    rs[1].cost_code, 'Excavation Prep');
  eq('with its sub code too', rs[1].sub_code, 'Travel');

  rs = sheetRows();
  commit(rs, 0, '5in Mill & Fill');
  // He clears the drive's own cost code to type something else. A blank-only
  // guard put the pick straight back under his thumb before he could.
  rs[1].cost_code = ''; rs[1].sub_code = ''; rs[1].code_source = 'manual';
  cod.setSheet({ rows: rs, codes: PAVING }); cod.applyTravelCodes();
  eq('a drive code the foreman cleared stays cleared', rs[1].cost_code, '');
  rs[1].cost_code = 'Mobilization'; rs[1].sub_code = 'Travel';
  commit(rs, 0, 'Excavation Prep');
  eq('and one he typed is never re-derived out from under him', rs[1].cost_code, 'Mobilization');
}

console.log('\nChanging a cost code really does clear its sub code');
{
  // The clear was written at HEAD and then undone one line later:
  // renderSheetSoon harvests the DOM back over sheet.rows, and the sub-code box
  // still showed the code that belonged to the OLD cost code. The row shipped a
  // sub code from a cost code it no longer named, and it looked filled in.
  const branch = (codeSrc.match(/if \(field === 'cost_code'\) \{[\s\S]{0,1400}?\n      \}/) || [''])[0];
  const iHarvest = branch.indexOf('harvestSheetDom()');
  const iClear   = branch.indexOf("sub_code = ''");
  assert('the harvest runs BEFORE the clear', iHarvest >= 0 && iClear > iHarvest,
    'setField clears the sub code before harvesting again — the DOM puts it straight back');
  assert('and the repaint is still deferred past the focus move',
    /renderSheetSoon\(\);/.test(branch));
  // The helper must no longer harvest, or the order is forced back to
  // mutate-then-harvest and every clear on this path is undone again.
  assert('the deferred repaint does not harvest behind its callers',
    !/function renderSheetSoon\(\) \{\s*harvestSheetDom\(\);/.test(codeSrc),
    'renderSheetSoon harvests again — a cleared sub code or machine-hours box comes back');
}

console.log('\nPayroll keeps the pickup level with the drive it approves');
{
  // Exempt, but only where the stored hours ARE the drive's. The coder's
  // touched-flag does not survive the POST, so equality is the only evidence of
  // authorship that reaches payroll: equal means the mirror wrote it, different
  // means he typed it and his answer stands.
  assert('a MIRRORED travel-row pickup is exempt from the touched-on-reopen rule',
    /r\.is_travel && splitEquipIsPickup\(r\.equipment\)[\s\S]{0,160}Math\.abs\(\(Number\(r\.equip_hours\)[\s\S]{0,80}Number\(r\.labor_hours\)/.test(payrSrc),
    'an approver correcting the drive would bill the old pickup hours against the new drive');
  assert('  and a figure he typed himself is NOT exempted away',
    /splitEquipIsPickup\(r\.equipment\)[\s\S]{0,200}?< 0\.001\)/.test(payrSrc),
    'the exemption is unconditional again — "the truck ran longer" would be overwritten');

  // Code Time applies the same comparison when it reopens a saved proposal.
  const reopened = reopen([
    { cost_code: 'Mob', sub_code: 'Travel', labor_hours: 2, equip_hours: 2, equipment: 'Pickup', is_travel: true, quantity: 0 },
    { cost_code: 'Mob', sub_code: 'Travel', labor_hours: 2, equip_hours: 3, equipment: 'Pickup', is_travel: true, quantity: 0 },
  ]);
  eq('a reopened pickup whose hours are the drive stays open to the link',
    reopened[0]._equipHoursTouched, false);
  eq('and one he had typed over stays his', reopened[1]._equipHoursTouched, true);
  typeTravelHours(reopened, 0, '1.5');
  eq('so correcting the drive on a reopened sheet moves the mirrored one',
    reopened[0].equip_hours, '1.5');
  typeTravelHours(reopened, 1, '1.5');
  eq('and leaves his own figure alone', reopened[1].equip_hours, '3');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
