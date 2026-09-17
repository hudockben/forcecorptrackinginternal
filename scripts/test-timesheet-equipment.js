#!/usr/bin/env node
'use strict';
/**
 * Which equipment was run — not merely whether.
 *
 * Run: node scripts/test-timesheet-equipment.js
 *
 * "Operated equipment? Yes" is half an answer. A cost row is coded per MACHINE,
 * at that machine's rate, so a boolean tells the approver that something was on
 * the job and nothing about what — and the gap was filled days later, from the
 * schedule, by someone who was not there. A pickup priced as an excavator is
 * not a rounding error.
 *
 * So a block that answers Yes is now OFFERED the iron to name, from the
 * company's own equipment list — the same vocabulary daily_tracking.equipment
 * uses, so the two compare without translation. A LIST, because a day is
 * routinely more than one piece: the pickup that got him to the job and the
 * excavator he ran once he arrived. And AN HOURS BOX per machine, because the
 * cost row is priced per machine per hour and the figure belongs to the man on
 * the seat — payroll's split modal now opens with both already filled in, the
 * same way the travel legs fill the travel row's hours.
 *
 * Offered, never demanded: see 3 below. Every assertion in here is about what
 * the field does WHEN HE ANSWERS IT, not about making him.
 *
 * What this suite holds down, in the order the answer travels:
 *
 *   1. THE PICKERS. They follow the Yes/No answer, and hiding them never
 *      answers on the operator's behalf — the lesson applyHaulVisibility
 *      carries in full, applied to the control beside it.
 *   2. WHAT IS POSTED. Blank lines dropped, a machine named twice counted once,
 *      and nothing at all posted for a block that said No.
 *   3. NO GATE. Both the machine and its hours are OPTIONAL and the save never
 *      waits on either. The Yes/No above is the answer payroll cannot do
 *      without; these two only make the cost coding easier, and a man standing
 *      in the mud at six in the evening must never be unable to file his day
 *      because the machine he ran is not on the office's list. A blank list
 *      posts as a blank list and the approver fills it in — exactly where he
 *      was before this field existed.
 *   4. THE PREFILL. What he named lands on the cost rows the approver would
 *      otherwise type it onto — filling blanks only, never overwriting the
 *      truck the haul rules put there or a figure anybody typed.
 *   5. THE SERVER. The same rules again on the way in, because the form is not
 *      the only thing that can post here, plus the two write paths: the column
 *      is carried on INSERT, and an UPDATE that does not mention the field
 *      keeps what is stored (payroll's Edit Entry modal sends no such key) —
 *      unless the answer it belongs to is being turned off, which takes the
 *      machines with it.
 *
 * Evaluates the real functions out of timesheet.html — no browser needed.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const eq = (label, a, b) =>
  assert(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'timesheet.html'), 'utf8');
const API  = fs.readFileSync(path.join(ROOT, 'api', 'timesheet-entries.js'), 'utf8');
const SQL  = fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8');
const PAY  = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');

const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const fnSource = name => requireFn(HTML, name, 'timesheet.html');

// ── A sandbox holding just what these functions touch ──────────────────────
// Every element is a stub that records what it was told. The page only ever
// reaches for fields by id, so that is the whole of what it needs.
function sandbox(opts = {}) {
  const els = {};
  const el = id => (els[id] || (els[id] = { id, style: {}, innerHTML: '', disabled: false }));
  const sb = {
    console,
    equipVals: opts.equipVals || { 0: true },
    equipUsed: opts.equipUsed || { 0: [] },
    equipmentNames: opts.names === undefined ? ['Excavator', 'Pickup Truck', 'Roller'] : opts.names,
    MAX_EQUIP_PIECES: 6,
    blockOrder: () => opts.blocks || [0],
    bel: (i, key) => el(i === 0 ? key : `s${i}-${key}`),
    // renderEquipUsed writes the hours boxes into the list's innerHTML, so on
    // the real page they exist by the time anything reaches for one. Reuse the
    // same element factory rather than pretending they don't.
    document: { getElementById: el },
    escapeHtml: s => String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    // The real one fetches once and caches; nothing here depends on the fetch.
    equipmentNamesLoad: () => Promise.resolve(sb.equipmentNames),
    __els: els,
  };
  vm.createContext(sb);
  vm.runInContext(
    ['equipUsedClean', 'equipHrsId', 'blockHours', 'renderEquipUsed', 'equipSlot',
     'writeEquipHours', 'equipAutoRemainder', 'refreshEquipAutoHours', 'setEquipPiece',
     'setEquipHours', 'commitEquipHours', 'addEquipPiece', 'removeEquipPiece',
     'applyEquipUsedVisibility']
      .map(fnSource).join('\n'), sb);
  return sb;
}

console.log('\n[the pickers follow the answer]');
{
  const sb = sandbox({ equipVals: { 0: null } });
  sb.applyEquipUsedVisibility(0);
  assert('unanswered shows nothing to fill in', sb.__els['row-equip-used'].style.display === 'none');

  sb.equipVals[0] = false;
  sb.applyEquipUsedVisibility(0);
  assert('"No" keeps them away', sb.__els['row-equip-used'].style.display === 'none');

  sb.equipVals[0] = true;
  sb.applyEquipUsedVisibility(0);
  assert('"Yes" brings them up', sb.__els['row-equip-used'].style.display === 'flex');
  assert('  with a line already waiting to be filled in', sb.equipUsed[0].length === 1);
  assert('  offering the company equipment list',
    /Excavator/.test(sb.__els['equip-list'].innerHTML)
    && /Pickup Truck/.test(sb.__els['equip-list'].innerHTML));
  // Both blocks say "(optional)" on the label, and neither wears the hauling
  // question's amber "needs an answer" marking — that styling means "this will
  // stop you", and this no longer does.
  {
    const rows = [
      HTML.slice(HTML.indexOf('id="row-equip-used"'), HTML.indexOf('id="equip-add"')),
      HTML.slice(HTML.indexOf('id="s${i}-row-equip-used"'), HTML.indexOf('id="s${i}-equip-add"')),
    ];
    assert('  saying out loud that it is optional, not that it is owed',
      rows.every(r => r.includes('(optional)')), JSON.stringify(rows.map(r => r.length)));
    assert('  and never wearing the hauling question\'s "you must answer" marking',
      rows.every(r => !/haul-need/.test(r)), JSON.stringify(rows.filter(r => /haul-need/.test(r))));
  }

  sb.setEquipPiece(0, 0, 'Excavator');
  assert('  and every line offers an hours box beside the machine',
    /id="equip-hrs-0"/.test(sb.__els['equip-list'].innerHTML)
    && /step="0.25"/.test(sb.__els['equip-list'].innerHTML));
}

// One line carrying a raw figure, straight through equipUsedClean — the path a
// box that is never blurred takes.
function sandboxPosts(hours) {
  const c = sandbox({ equipUsed: { 0: [{ name: 'Excavator', hours: String(hours) }] } });
  return c.equipUsedClean(0);
}

console.log('\n[the hours, which are the point of asking]');
{
  // The first machine is nearly always the one he was on all day, so its hours
  // open on the block's own hours — written INTO THE BOX, where he can see it
  // and change it, not left as a default nobody can tell from an answer.
  const sb = sandbox();
  sb.__els['hours'] = { id: 'hours', style: {}, textContent: '9.00' };
  sb.applyEquipUsedVisibility(0);
  sb.setEquipPiece(0, 0, 'Excavator');
  eq('the first machine opens on the block\'s hours',
    sb.equipUsedClean(0), [{ name: 'Excavator', hours: 9 }]);
  assert('  and the box on screen says so too',
    sb.__els['equip-hrs-0'].value === '9.00', sb.__els['equip-hrs-0'].value);

  sb.setEquipHours(0, 0, '6.5');
  sb.setEquipPiece(0, 0, 'Roller');
  eq('changing the machine never moves hours he typed',
    sb.equipUsedClean(0), [{ name: 'Roller', hours: 6.5 }]);

  // The guess follows the clock it was guessed FROM. Without this, a clock
  // corrected after the machine was picked left a figure on screen that no
  // longer matched the day beside it.
  {
    const c = sandbox();
    c.__els['hours'] = { id: 'hours', style: {}, textContent: '10.00' };
    c.applyEquipUsedVisibility(0);
    c.setEquipPiece(0, 0, 'Excavator');
    eq('the guess opens on the block\'s hours', c.equipUsedClean(0), [{ name: 'Excavator', hours: 10 }]);
    c.__els['hours'].textContent = '8.00';
    c.refreshEquipAutoHours(0);
    eq('  and follows the clock while it is still the form\'s guess',
      c.equipUsedClean(0), [{ name: 'Excavator', hours: 8 }]);
    assert('  writing it back into the box on screen too',
      c.__els['equip-hrs-0'].value === '8.00', c.__els['equip-hrs-0'].value);
    c.setEquipHours(0, 0, '3');
    c.__els['hours'].textContent = '9.00';
    c.refreshEquipAutoHours(0);
    eq('  but never once he has touched the box', c.equipUsedClean(0), [{ name: 'Excavator', hours: 3 }]);
  }

  // A line with no machine posts nothing, so it must not sit there showing a
  // figure that the save throws away without a word.
  {
    const c = sandbox();
    c.__els['hours'] = { id: 'hours', style: {}, textContent: '10.00' };
    c.applyEquipUsedVisibility(0);
    c.setEquipPiece(0, 0, 'Excavator');
    c.setEquipPiece(0, 0, '');
    eq('clearing the machine clears the guess that came with it', c.equipUsedClean(0), []);
    assert('  and empties the box, so nothing on screen is quietly discarded',
      c.__els['equip-hrs-0'].value === '', c.__els['equip-hrs-0'].value);
  }

  // max="24" on an <input> does nothing without a <form>, and this page has
  // none — so an over-24 typo used to reach safeHours, which reads it as NO
  // answer. The save then reported success with the figure simply gone.
  {
    const c = sandbox();
    c.__els['hours'] = { id: 'hours', style: {}, textContent: '10.00' };
    c.applyEquipUsedVisibility(0);
    c.setEquipPiece(0, 0, 'Excavator');
    c.commitEquipHours(0, 0, '88');
    eq('a fat-fingered 88 is held to a day, not dropped',
      c.equipUsedClean(0), [{ name: 'Excavator', hours: 24 }]);
    assert('  and he is shown that it was held',
      c.__els['equip-hrs-0'].value === '24', c.__els['equip-hrs-0'].value);
    assert('  with the same bound in equipUsedClean, for a box that never blurs',
      JSON.stringify(sandboxPosts(99)) === JSON.stringify([{ name: 'Excavator', hours: 24 }]));
  }

  // A saved draft's figures are HIS, flag or no flag — re-opening one must not
  // invent hours he deliberately left blank.
  {
    const c = sandbox({ equipUsed: { 0: [{ name: 'Excavator', hours: '' }] } });
    c.__els['hours'] = { id: 'hours', style: {}, textContent: '10.00' };
    c.applyEquipUsedVisibility(0);
    c.refreshEquipAutoHours(0);
    eq('a re-opened draft saved with no hours is left with none',
      c.equipUsedClean(0), [{ name: 'Excavator', hours: null }]);
  }

  // Only the first line. A second machine is a second answer, and guessing it
  // would bill the job for two full days of iron on a one-man day.
  sb.addEquipPiece(0);
  sb.setEquipPiece(0, 1, 'Pickup Truck');
  eq('a second machine opens with no hours guessed for it',
    sb.equipUsedClean(0), [{ name: 'Roller', hours: 6.5 }, { name: 'Pickup Truck', hours: null }]);
  sb.setEquipHours(0, 1, '2.5');
  eq('  until he gives them',
    sb.equipUsedClean(0), [{ name: 'Roller', hours: 6.5 }, { name: 'Pickup Truck', hours: 2.5 }]);
  assert('  and line 1 keeps the figure HE typed, share or no share',
    sb.equipUsedClean(0)[0].hours === 6.5);

  assert('typing hours never redraws the list under the thumb',
    !/render/.test(fnSource('setEquipHours')), fnSource('setEquipHours'));
}

{
  // The whole lesson of applyHaulVisibility, one control over: a redraw must
  // never answer for the operator. Taking "Yes" back and putting it straight
  // on again is a mis-tap, and it used to cost him the list he had built.
  const picked = [{ name: 'Excavator', hours: '8' }, { name: 'Pickup Truck', hours: '1' }];
  const sb = sandbox({ equipUsed: { 0: picked.map(x => ({ ...x })) } });
  sb.applyEquipUsedVisibility(0);
  sb.equipVals[0] = false;
  sb.applyEquipUsedVisibility(0);
  eq('hiding the row leaves what he picked alone', sb.equipUsed[0], picked);
  sb.equipVals[0] = true;
  sb.applyEquipUsedVisibility(0);
  eq('  so answering Yes again brings it back', sb.equipUsed[0], picked);
}

// And the guard itself: a render that writes the Yes/No answer is the bug.
for (const name of ['renderEquipUsed', 'applyEquipUsedVisibility']) {
  const fn = fnSource(name);
  assert(`${name} never assigns to equipVals — it only renders`,
    !/equipVals\s*\[[^\]]*\]\s*=(?!=)/.test(fn), fn);
}

console.log('\n[the guess is the block\'s REMAINDER, never more than the day]');
{
  // A guess that filled the WHOLE block kept ten hours on line 1 after a second
  // machine was added for two: twelve machine-hours billed against a ten-hour
  // day, off a figure the form invented rather than one he gave. It fills what
  // the block has LEFT — which is splitFillTravelHours' rule for the travel
  // row, and it is here for the same reason.
  const sb = sandbox();
  sb.__els['hours'] = { id: 'hours', style: {}, textContent: '10.00' };
  sb.applyEquipUsedVisibility(0);
  sb.setEquipPiece(0, 0, 'Excavator');
  eq('one machine takes the whole block', sb.equipUsedClean(0), [{ name: 'Excavator', hours: 10 }]);

  sb.addEquipPiece(0);
  sb.setEquipPiece(0, 1, 'Pickup Truck');
  sb.commitEquipHours(0, 1, '2');
  eq('a second machine comes out of the first\'s share',
    sb.equipUsedClean(0), [{ name: 'Excavator', hours: 8 }, { name: 'Pickup Truck', hours: 2 }]);
  assert('  so the day never bills more machine-hours than it has',
    sb.equipUsedClean(0).reduce((t, x) => t + (x.hours || 0), 0) === 10);

  sb.removeEquipPiece(0, 1);
  eq('  and removing it gives the share back', sb.equipUsedClean(0), [{ name: 'Excavator', hours: 10 }]);

  // Nothing left over means nothing to guess — better no figure than a zero or
  // a negative one.
  const full = sandbox();
  full.__els['hours'] = { id: 'hours', style: {}, textContent: '8.00' };
  full.applyEquipUsedVisibility(0);
  full.addEquipPiece(0);
  full.setEquipPiece(0, 1, 'Pickup Truck');
  full.commitEquipHours(0, 1, '8');
  full.setEquipPiece(0, 0, 'Excavator');
  eq('a block already fully accounted for guesses nothing',
    full.equipUsedClean(0), [{ name: 'Excavator', hours: null }, { name: 'Pickup Truck', hours: 8 }]);

  // AND THE ORDER THE HINT ACTUALLY ASKS FOR — biggest machine first, so line 1
  // is guessed BEFORE the others exist. A guess with no share left has to be
  // withdrawn, not left standing: leaving it doubled the day.
  const first = sandbox();
  first.__els['hours'] = { id: 'hours', style: {}, textContent: '8.00' };
  first.applyEquipUsedVisibility(0);
  first.setEquipPiece(0, 0, 'Excavator');
  first.addEquipPiece(0);
  first.setEquipPiece(0, 1, 'Pickup Truck');
  first.commitEquipHours(0, 1, '8');
  eq('a guess left with no share is withdrawn, not left standing',
    first.equipUsedClean(0), [{ name: 'Excavator', hours: null }, { name: 'Pickup Truck', hours: 8 }]);
  assert('  so the day never posts more machine-hours than it has',
    first.equipUsedClean(0).reduce((t, x) => t + (x.hours || 0), 0) === 8);

  // Same when the CLOCK shrinks under the lines already named.
  const shrunk = sandbox();
  shrunk.__els['hours'] = { id: 'hours', style: {}, textContent: '10.00' };
  shrunk.applyEquipUsedVisibility(0);
  shrunk.setEquipPiece(0, 0, 'Excavator');
  shrunk.addEquipPiece(0);
  shrunk.setEquipPiece(0, 1, 'Roller');
  shrunk.commitEquipHours(0, 1, '3');
  eq('a ten-hour block splits seven and three',
    shrunk.equipUsedClean(0), [{ name: 'Excavator', hours: 7 }, { name: 'Roller', hours: 3 }]);
  shrunk.__els['hours'].textContent = '3.00';
  shrunk.refreshEquipAutoHours(0);
  eq('  and a clock corrected down to three withdraws the guess',
    shrunk.equipUsedClean(0), [{ name: 'Excavator', hours: null }, { name: 'Roller', hours: 3 }]);

  // Hours on a line that names no machine are posted by nobody, so they must
  // not come off line 1's share either.
  const unnamed = sandbox();
  unnamed.__els['hours'] = { id: 'hours', style: {}, textContent: '10.00' };
  unnamed.applyEquipUsedVisibility(0);
  unnamed.setEquipPiece(0, 0, 'Excavator');
  unnamed.addEquipPiece(0);
  unnamed.commitEquipHours(0, 1, '3');            // hours typed, machine never picked
  eq('an unnamed line never takes hours off the machine that is named',
    unnamed.equipUsedClean(0), [{ name: 'Excavator', hours: 10 }]);
}

console.log('\n[a box he has been in is his, blank included]');
{
  // "Leave it blank and the office will fill it in" is what the hint offers
  // him. A guess that reappears the next time he touches the picker takes that
  // offer back without saying so — and the schema comment promises null hours
  // mean the approver decides, not that the form invents a figure the job is
  // billed for.
  const draft = sandbox({ equipUsed: { 0: [{ name: 'Excavator', hours: '', auto: false, touched: true }] } });
  draft.__els['hours'] = { id: 'hours', style: {}, textContent: '10.00' };
  draft.applyEquipUsedVisibility(0);
  draft.setEquipPiece(0, 0, 'Roller');
  eq('a re-opened draft saved with no hours is not re-guessed when the machine changes',
    draft.equipUsedClean(0), [{ name: 'Roller', hours: null }]);

  const cleared = sandbox();
  cleared.__els['hours'] = { id: 'hours', style: {}, textContent: '10.00' };
  cleared.applyEquipUsedVisibility(0);
  cleared.setEquipPiece(0, 0, 'Excavator');
  cleared.commitEquipHours(0, 0, '');
  eq('a box he empties by hand stays empty', cleared.equipUsedClean(0), [{ name: 'Excavator', hours: null }]);
  cleared.setEquipPiece(0, 0, 'Roller');
  eq('  and stays empty across a machine change', cleared.equipUsedClean(0), [{ name: 'Roller', hours: null }]);

  assert('fillBlockFromEntry marks every restored line as his',
    /touched: true,/.test(HTML) && /auto:  false,/.test(HTML));
}

console.log('\n[more than one piece, because a day is more than one piece]');
{
  const sb = sandbox();
  sb.applyEquipUsedVisibility(0);
  sb.setEquipPiece(0, 0, 'Pickup Truck');
  sb.setEquipHours(0, 0, '1');
  sb.addEquipPiece(0);
  sb.setEquipPiece(0, 1, 'Excavator');
  sb.setEquipHours(0, 1, '8');
  eq('the pickup that got him there and the machine he ran',
    sb.equipUsedClean(0),
    [{ name: 'Pickup Truck', hours: 1 }, { name: 'Excavator', hours: 8 }]);

  sb.addEquipPiece(0);
  eq('an unfilled line is not a machine', sb.equipUsedClean(0),
    [{ name: 'Pickup Truck', hours: 1 }, { name: 'Excavator', hours: 8 }]);
  sb.removeEquipPiece(0, 2);
  assert('  and can be taken back off', sb.equipUsed[0].length === 2, JSON.stringify(sb.equipUsed[0]));

  // Two stints on the same machine is one machine — and the hours add up,
  // which is the reading that costs the job the right amount either way.
  sb.setEquipPiece(0, 1, 'pickup truck');
  eq('one piece of iron named twice is one piece, for the hours of both',
    sb.equipUsedClean(0), [{ name: 'Pickup Truck', hours: 9 }]);

  sb.equipUsed[0] = [];
  for (let n = 0; n < 10; n++) sb.addEquipPiece(0);
  assert('a day cannot name more machines than it has hours for',
    sb.equipUsed[0].length === sb.MAX_EQUIP_PIECES, `${sb.equipUsed[0].length} lines`);

  sb.equipUsed[0] = [{ name: 'Excavator', hours: '3' }];
  sb.removeEquipPiece(0, 0);
  eq('removing the last line still leaves one to fill in',
    sb.equipUsed[0], [{ name: '', hours: '', auto: false, touched: false }]);
}

{
  // A name the list no longer carries — the piece was renamed or retired after
  // the day was filed. Dropping it silently would rewrite what he answered.
  const sb = sandbox({ equipUsed: { 0: [{ name: 'Old Dozer', hours: '4' }] } });
  sb.applyEquipUsedVisibility(0);
  assert('a machine no longer on the list is still shown, and still selected',
    /Old Dozer/.test(sb.__els['equip-list'].innerHTML)
    && /Old Dozer<\/option>/.test(sb.__els['equip-list'].innerHTML));
  eq('  and still posts, hours and all',
    sb.equipUsedClean(0), [{ name: 'Old Dozer', hours: 4 }]);
}

console.log('\n[what the form will and will not save]');
{
  // Source-pinned, the way the hauling gate beside it is: these are the lines
  // that decide what leaves the page.
  const build = HTML.slice(HTML.indexOf('function buildPayloads('),
                           HTML.indexOf('function buildPayloads(') + 14000);
  assert('only a block that said Yes posts machines at all',
    /const _equipUsed = equipVals\[i\] === true \? equipUsedClean\(i\) : \[\];/.test(build));
  assert('the list rides on the payload as its own field',
    /equipment_used: b\.equipUsed,/.test(build));
  assert('  and is always sent, so a list picked by mistake can be cleared',
    !/equipment_used:[^\n]*\?\s*b\.equipUsed\s*:/.test(build));

  // The whole point of this section: NOTHING here refuses a day. The machine
  // is optional and so are its hours, and no wording anywhere in buildPayloads
  // says otherwise.
  const refusals = (build.match(/return \{ error:[^\n]*/g) || []).join('\n');
  assert('naming no machine never refuses the day',
    !/Name the equipment|name at least one|equipment you ran|pick a machine/i.test(refusals), refusals);
  assert('  nor does leaving its hours blank',
    !/equipment hours|hours you were on|machine hours/i.test(refusals), refusals);
  assert('  and the equipment answer is the only thing this section gates on',
    /if \(equipVals\[i\] == null\) return \{ error: at\(i, 'Operated equipment\? Yes or No\.'\) \};/.test(build));
  assert('  with the reason written down where the next person will read it',
    /OPTIONAL, both of\n\s*\/\/ them, and deliberately not a gate/.test(build));
}

console.log('\n[the form remembers, and forgets, in the right places]');
assert('a new job block starts with nothing named',
  /equipUsed\[i\] = \[\];\s*\n\s*equipVals\[i\] = null;/.test(HTML));
assert('removing a job takes its machines with it',
  /delete equipVals\[i\];\s*\n\s*delete equipUsed\[i\];/.test(HTML));
assert('resetForm clears them back',
  /equipUsed = \{ 0: \[\] \};\s*\n\s*clearSeg\('equip'\);/.test(HTML));
assert('a saved entry re-opens on the machines and hours it was stored with',
  /equipUsed\[i\] = \(Array\.isArray\(e\.equipment_used\) \? e\.equipment_used : \[\]\)\.map/.test(HTML)
  && /hours: \(x && x\.hours != null\) \? String\(x\.hours\) : '',/.test(HTML));
assert('  and it is read BEFORE the Yes/No that draws the pickers',
  HTML.indexOf('equipUsed[i] = (Array.isArray(e.equipment_used)')
    < HTML.indexOf("if (e.operated_equipment === true || e.operated_equipment === false) setSeg('equip'"));
assert('the split block asks the same question as block 0',
  /id="s\$\{i\}-row-equip-used"/.test(HTML) && /id="s\$\{i\}-equip-list"/.test(HTML));
assert('and the card he reads back names them, with their hours',
  /Ran: \$\{escapeHtml\(ran\.join\(', '\)\)\}/.test(HTML)
  && /\$\{Number\(x\.hours\)\.toFixed\(2\)\} h/.test(HTML));

console.log('\n[the server applies the same rules to anything that posts]');
{
  const ctx = { console };
  vm.createContext(ctx);
  for (const fn of ['safeStr', 'safeHours', 'safeEquipmentUsed']) {
    vm.runInContext(requireFn(API, fn, 'api/timesheet-entries.js'), ctx);
  }
  vm.runInContext('const MAX_EQUIPMENT_USED = 6;', ctx);
  const f = ctx.safeEquipmentUsed;
  const P = (name, hours) => ({ name, hours });

  eq('a machine and its hours come through as given',
    f([P('Excavator', 8), P('Pickup Truck', '1.5')]),
    [P('Excavator', 8), P('Pickup Truck', 1.5)]);
  eq('a machine named with no hours keeps null, not a guessed zero',
    f([P('Excavator', null)]), [P('Excavator', null)]);
  eq('  and so does one whose hours are blank', f([P('Excavator', '')]), [P('Excavator', null)]);
  eq('a bare string is a machine with no hours — an older client still files',
    f(['Excavator']), [P('Excavator', null)]);
  eq('unnamed lines are dropped', f([P('Excavator', 8), P('', 3), P(null, 1)]), [P('Excavator', 8)]);
  eq('whitespace is trimmed', f([P('  Roller  ', 2)]), [P('Roller', 2)]);
  eq('one machine named twice is one machine, for the hours of both',
    f([P('Roller', 4), P('roller', 2.5)]), [P('Roller', 6.5)]);
  eq('  and the day it adds up to cannot exceed one',
    f([P('Roller', 20), P('roller', 20)]), [P('Roller', 24)]);
  eq('hours outside a day are no answer, not a clamped one',
    f([P('Roller', 99)]), [P('Roller', null)]);
  eq('  nor is a negative one', f([P('Roller', -3)]), [P('Roller', null)]);
  eq('nothing named is null, not an empty array', f([]), null);
  eq('a non-array is null — an older client sends no such field', f(undefined), null);
  eq('  and so is a string that looks like a list', f('Excavator, Roller'), null);
  assert('the cap holds on the way in too',
    f(['a','b','c','d','e','f','g','h']).length === 6);
  assert('a name longer than the column is cut, not refused',
    f([P('x'.repeat(400), 1)])[0].name.length === 255);

  // And the reader that hands it back out, which has to cope with whatever is
  // in the column — including a row written before the hours box existed.
  vm.runInContext(requireFn(API, 'normalizeEquipmentUsedRow', 'api/timesheet-entries.js'), ctx);
  const g = ctx.normalizeEquipmentUsedRow;
  eq('a stored row reads back as { name, hours }',
    g([{ name: 'Roller', hours: 6.5 }]), [P('Roller', 6.5)]);
  eq('a stored bare string reads as a machine with no hours',
    g(['Roller']), [P('Roller', null)]);
  eq('a null column is an empty list, never a null to special-case', g(null), []);
}

{
  const norm = API.slice(API.indexOf('function normalizeEntryBody('),
                         API.indexOf('module.exports'));
  assert('the machines are tied to the answer they belong to',
    /const equipment_used = operated_equipment === true \? safeEquipmentUsed\(body\.equipment_used\) : null;/.test(norm));
  assert('  so a row can never claim no equipment while naming some',
    /operated_equipment === true \?/.test(norm));
  assert('time off names no machines', /equipment_used:       null,/.test(norm));
}

{
  const insert = API.slice(API.indexOf('INSERT INTO timesheet_entries'),
                           API.indexOf('RETURNING *', API.indexOf('INSERT INTO timesheet_entries')));
  assert('the INSERT carries the column', /equipment_used/.test(insert));
  const cols = insert.slice(insert.indexOf('(') + 1, insert.indexOf(') VALUES'))
    .split(',').map(x => x.trim()).filter(Boolean);
  const vals = insert.slice(insert.indexOf(') VALUES') + 8)
    .replace(/^\s*\(/, '').replace(/\)\s*$/, '')
    .split(/,(?![^{]*})/).map(x => x.trim()).filter(Boolean);
  assert('  and its column list still matches its VALUES list',
    cols.length === vals.length, `${cols.length} columns, ${vals.length} values`);
  assert('  with the array written as JSON, the way split_destinations is',
    /equipment_used \? JSON\.stringify\(data\.equipment_used\) : null/.test(insert));
}

{
  // The hazard haul_type, truck_unit and the EES columns each carry: payroll's
  // Edit Entry modal edits the DAY and sends none of these keys, so a write
  // that always takes the normalized value blanks them on every correction to
  // the hours or the job.
  const upd = API.slice(API.indexOf('const keepEquipUsed'),
                        API.indexOf('split_group_id     = ', API.indexOf('const keepEquipUsed')));
  assert('an update that never mentions the machines keeps them',
    /!Object\.prototype\.hasOwnProperty\.call\(body, 'equipment_used'\)/.test(upd));
  assert('  but only while the answer they belong to is still Yes',
    /data\.operated_equipment === true/.test(upd));
  assert('  and only on a daily entry, so time off cannot carry them back in',
    /data\.entry_type === 'daily'/.test(upd));
  assert('the column is written through a CASE, like the fields beside it',
    /equipment_used\s*=\s*CASE WHEN \$\{keepEquipUsed\}::boolean/.test(upd)
    && /::jsonb END/.test(upd));
}

assert('the column exists in the schema, idempotently',
  /ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS equipment_used JSONB;/.test(SQL));
assert('and the API hands the client an array, never a null to special-case',
  /equipment_used:\s*normalizeEquipmentUsedRow\(r\.equipment_used\),/.test(API));

console.log('\n[payroll can see what was run]');
assert('the review grid names the machines under the pill',
  /function equipFlagHtml\(e\)/.test(PAY) && /\$\{equipFlagHtml\(e\)\}/.test(PAY));
assert('the printed Hours Report keeps the pill alone — that table has no room',
  /<td>\$\{dayFlagHtml\(e, 'operated_equipment',\s*\n\s*equipUsedNames\(e\)\.length/.test(PAY)
  && !/equipFlagHtml/.test(
       PAY.slice(PAY.indexOf('<td class="date">'), PAY.indexOf('report-detail-table'))));
assert('  and says so where the next person will look',
  /scripts\/test-report-width\.js/.test(PAY));
assert('the Excel detail sheet gets its own column, which is what a rate pivots on',
  /'Operated Equipment', 'Equipment Run \(hrs\)',/.test(PAY));
assert('the audit CSV follows the field too',
  /'Operated Equipment', 'Equipment Run', 'Supervisor',/.test(PAY));
{
  const sheet = PAY.slice(PAY.indexOf('function reportDetailSheetXml'),
                          PAY.indexOf('function reportOvertimeSheetXml'));
  const headers = sheet.match(/const headers = \[([\s\S]*?)\];/)[1]
    .split(',').map(x => x.trim()).filter(Boolean).length;
  const widths = sheet.match(/colWidths: \[([^\]]*)\]/)[1].split(',').length;
  const dataRow = sheet.slice(sheet.indexOf('sheet.push([\n            cTxt(r.username'));
  const cells = (dataRow.slice(dataRow.indexOf('[') + 1, dataRow.indexOf(']);'))
    .match(/\bc(Txt|Num)\(/g) || []).length;
  assert('  and the sheet still lines up end to end',
    headers === widths && headers === cells,
    `${headers} headers, ${widths} widths, ${cells} cells`);
  assert('  with the filter range widened to match',
    /autoFilterRef: `A\$\{HEADER_ROW\}:W\$/.test(sheet));
}

console.log('\n[the approver opens on what the operator already answered]');
{
  // The REAL haul predicates, not stubs: the whole hazard this section guards
  // lives in how they and the prefill read the same row.
  const fnPay = name => requireFn(PAY, name, 'payroll.html');
  const PAY_FNS = ['isTravelSplitRow', 'splitRowHaulAnswer', 'splitRowTakesTruck',
    'splitHaulTruckName', 'splitDefaultHaulEquipment', 'splitClearHaulAuto', 'splitClearNamedOnHaul',
    'splitMirrorHaulEquipHours', 'splitMirrorHaulEquipHoursAll', 'splitPricedMachineOnRow',
    'splitTruckOnRow', 'splitRowIsHaul', '_splitRowUid', '_blankSplitRow',
    'equipUsedPieces', 'splitFillNamedEquipment', 'onSplitHaulChange'];
  const ctx = {
    console,
    splitRows: [], splitEntry: null, splitProjEquipment: [], _splitRowSeq: 0,
    splitHaulAnswer: '',
    // The day IS a haul day in these cases — that is when the hazard exists.
    splitHaulIs: () => 'off_site',
    splitDeriveHaulAnswer: () => 'off_site',
    renderSplitHaulNote: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext('const TRAVEL_CODE_RE = /\\btravel\\b/i;', ctx);
  for (const f of PAY_FNS) vm.runInContext(fnPay(f), ctx);

  // The ordinary day: one man, one machine, all day. Nothing to type.
  ctx.splitEntry = { equipment_used: [{ name: 'Excavator', hours: 9 }] };
  ctx.splitRows  = [ctx._blankSplitRow(false), ctx._blankSplitRow(true)];
  ctx.splitRows[0].labor_hours = 9;
  assert('the machine and its hours land on the row the approver would type them onto',
    ctx.splitFillNamedEquipment()
    && ctx.splitRows[0].equipment === 'Excavator'
    && ctx.splitRows[0].equip_hours === 9,
    JSON.stringify(ctx.splitRows[0]));
  assert('  marked as somebody\'s answer, so the haul mirror leaves it alone',
    ctx.splitRows[0]._equipHoursTouched === true);
  assert('  and the travel row is not given a machine',
    !ctx.splitRows[1].equipment, JSON.stringify(ctx.splitRows[1]));

  // Two machines: the second gets its own row, because a cost row is one
  // machine and the approver would otherwise add it by hand.
  ctx.splitEntry = { equipment_used: [{ name: 'Excavator', hours: 6 }, { name: 'Pickup Truck', hours: 1.5 }] };
  ctx.splitRows  = [ctx._blankSplitRow(false)];
  ctx.splitRows[0].labor_hours = 7.5;
  ctx.splitRows[0].haul_type   = 'none';
  ctx.splitFillNamedEquipment();
  assert('a second machine gets a row of its own', ctx.splitRows.length === 2,
    JSON.stringify(ctx.splitRows));
  assert('  carrying the machine and its hours', ctx.splitRows[1].equipment === 'Pickup Truck'
    && ctx.splitRows[1].equip_hours === 1.5, JSON.stringify(ctx.splitRows[1]));
  assert('  and no labour hours, so the day still adds up to itself',
    (Number(ctx.splitRows[1].labor_hours) || 0) === 0);
  assert('  answering the haul question as NOT a haul, so it can be saved',
    ctx.splitRows[1].haul_type === 'none' && ctx.splitRows[1].is_haul === false,
    JSON.stringify(ctx.splitRows[1]));

  // A machine he named without hours cannot have a row of its own: the save
  // refuses a row with neither labour nor equipment hours on it.
  ctx.splitEntry = { equipment_used: [{ name: 'Excavator', hours: 6 }, { name: 'Roller', hours: null }] };
  ctx.splitRows  = [ctx._blankSplitRow(false)];
  ctx.splitFillNamedEquipment();
  assert('a machine named without hours never opens a row that cannot be saved',
    ctx.splitRows.length === 1, JSON.stringify(ctx.splitRows));

  // Fills, never overwrites.
  ctx.splitEntry = { equipment_used: [{ name: 'Excavator', hours: 9 }] };
  ctx.splitRows  = [ctx._blankSplitRow(false)];
  ctx.splitRows[0].equipment   = 'Triaxle Dump';
  ctx.splitRows[0].equip_hours = 4;
  ctx.splitFillNamedEquipment();
  assert('the truck the haul rules put on a row is never pushed off it',
    ctx.splitRows[0].equipment === 'Triaxle Dump' && ctx.splitRows[0].equip_hours === 4,
    JSON.stringify(ctx.splitRows[0]));

  // And the same machine is never billed twice.
  ctx.splitEntry = { equipment_used: [{ name: 'Excavator', hours: 9 }] };
  ctx.splitRows  = [ctx._blankSplitRow(false)];
  ctx.splitRows[0].equipment = 'Excavator';
  ctx.splitFillNamedEquipment();
  assert('a machine already on the form is not added a second time',
    ctx.splitRows.length === 1, JSON.stringify(ctx.splitRows));

  // An entry that named nothing leaves the modal exactly as it was.
  ctx.splitEntry = { equipment_used: [] };
  ctx.splitRows  = [ctx._blankSplitRow(false)];
  assert('an entry that named no machines changes nothing',
    ctx.splitFillNamedEquipment() === false);
}
console.log('\n[and it never turns the operator\'s machine into the haul truck]');
{
  // THE BUG THIS SECTION EXISTS FOR.
  //
  // splitDefaultHaulEquipment leaves a haul row's equipment BLANK when the
  // driver named no truck and the job has no single assigned unit, and
  // splitMirrorHaulEquipHours then refuses its hours for the same reason —
  // "a row with no unit is simply not a haul, and prices the man's labour".
  // That blank is a deliberate refusal, not a gap.
  //
  // The prefill used to fill it. splitTruckOnRow reads ANY machine as the truck
  // when the driver named none (`if (!said) return true`), so writing his
  // Roller there flipped the row to a haul: his whole day priced at $0 labour
  // and the job billed for the Roller as if it had hauled — silently, because
  // every warning that would have caught it read the row as a properly priced
  // haul. And the server applies the same rule (truckOnRow in
  // api/timesheet-entries.js), so it was not a display fault.
  const ctx = {
    console,
    splitRows: [], splitEntry: null, splitProjEquipment: [], _splitRowSeq: 0,
    splitHaulAnswer: '',
    splitHaulIs: () => 'off_site',
    splitDeriveHaulAnswer: () => 'off_site',
    renderSplitHaulNote: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext('const TRAVEL_CODE_RE = /\\btravel\\b/i;', ctx);
  for (const f of ['isTravelSplitRow', 'splitRowHaulAnswer', 'splitRowTakesTruck',
    'splitHaulTruckName', 'splitDefaultHaulEquipment', 'splitClearHaulAuto', 'splitClearNamedOnHaul',
    'splitMirrorHaulEquipHours', 'splitMirrorHaulEquipHoursAll', 'splitPricedMachineOnRow',
    'splitTruckOnRow', 'splitRowIsHaul', '_splitRowUid', '_blankSplitRow',
    'equipUsedPieces', 'splitFillNamedEquipment', 'onSplitHaulChange']) {
    vm.runInContext(requireFn(PAY, f, 'payroll.html'), ctx);
  }

  // A flagged driver: "to & from site", truck picker left blank, and he ran a
  // Roller for 8 h. The job has no single assigned unit.
  ctx.splitEntry = { truck_unit: '', haul_type: 'off_site', prevailing_wage: true,
                     equipment_used: [{ name: 'Roller', hours: 8 }] };
  const haulRow = ctx._blankSplitRow(false);
  haulRow.haul_type = 'off_site'; haulRow.labor_hours = 8;
  ctx.splitRows = [haulRow];
  ctx.splitMirrorHaulEquipHoursAll();
  ctx.splitFillNamedEquipment();

  assert('a truckless haul row keeps the blank the haul rules left it',
    !haulRow.equipment && !((Number(haulRow.equip_hours) || 0) > 0),
    JSON.stringify(haulRow));
  assert('  so the driver\'s hours are still his, not the truck\'s',
    ctx.splitRowIsHaul(haulRow) === false);
  assert('  and his machine gets a cost row of its own instead',
    ctx.splitRows.length === 2 && ctx.splitRows[1].equipment === 'Roller'
      && ctx.splitRows[1].equip_hours === 8 && (Number(ctx.splitRows[1].labor_hours) || 0) === 0,
    JSON.stringify(ctx.splitRows[1]));
  assert('  which is not a haul either, so nothing on it reads as the truck',
    ctx.splitRowIsHaul(ctx.splitRows[1]) === false);

  // The other half: a row prefilled while still unanswered, that the approver
  // then calls a haul. The machine has to come back off it.
  ctx.splitEntry = { truck_unit: '', haul_type: '', equipment_used: [{ name: 'Roller', hours: 8 }] };
  const later = ctx._blankSplitRow(false);
  later.labor_hours = 8;
  ctx.splitRows = [later];
  ctx.splitMirrorHaulEquipHoursAll();
  ctx.splitFillNamedEquipment();
  assert('an unanswered row is still prefilled', later.equipment === 'Roller');
  later.haul_type = 'off_site'; later.is_haul = true;
  ctx.onSplitHaulChange(later);
  assert('  and the moment the approver calls it a haul, the machine comes back off',
    !later.equipment && !((Number(later.equip_hours) || 0) > 0), JSON.stringify(later));
  assert('  leaving the row untouched again, for the truck logic to own',
    later._equipHoursTouched === false && later._namedAutoEquip === false,
    JSON.stringify(later));

  // A machine the APPROVER picked is theirs, and is never taken back.
  const mine = ctx._blankSplitRow(false);
  mine.labor_hours = 8; mine.equipment = 'Triaxle Dump'; mine.equip_hours = 8;
  ctx.splitRows = [mine];
  mine.haul_type = 'off_site'; mine.is_haul = true;
  ctx.onSplitHaulChange(mine);
  assert('a machine the approver picked is never taken back',
    mine.equipment === 'Triaxle Dump', JSON.stringify(mine));

  // And the flag that gates the take-back has to STOP being set the moment the
  // approver overrules the machine — otherwise the take-back reaches past its
  // own comment and deletes what they typed.
  {
    const c2 = ctx;
    const row = c2._blankSplitRow(false);
    row.labor_hours = 9;
    c2.splitEntry = { truck_unit: '', haul_type: '', equipment_used: [{ name: 'Roller', hours: 9 }] };
    c2.splitRows = [row];
    c2.splitMirrorHaulEquipHoursAll();
    c2.splitFillNamedEquipment();
    assert('the prefill marks the machine as its own', row._namedAutoEquip === true);
    // What payroll.html's generic field branch now does on an equipment edit.
    row.equipment = 'Triaxle Dump';
    row._namedAutoEquip = false; row._haulAutoEquip = false;
    row.equip_hours = 9; row._equipHoursTouched = true;
    row.haul_type = 'off_site'; row.is_haul = true;
    c2.onSplitHaulChange(row);
    assert('and once the approver overrules it, the take-back leaves it alone',
      row.equipment === 'Triaxle Dump' && row.equip_hours === 9, JSON.stringify(row));
  }
}
console.log('\n[and it never re-levels the truck, nor bills the commute for a machine]');
{
  const ctx = {
    console,
    splitRows: [], splitEntry: null, splitProjEquipment: [], _splitRowSeq: 0,
    splitHaulAnswer: '',
    splitHaulIs: () => 'off_site',
    splitDeriveHaulAnswer: () => 'off_site',
    renderSplitHaulNote: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext('const TRAVEL_CODE_RE = /\\btravel\\b/i;', ctx);
  for (const f of ['isTravelSplitRow', 'splitRowHaulAnswer', 'splitRowTakesTruck', 'splitHaulTruckName',
    'splitDefaultHaulEquipment', 'splitClearHaulAuto', 'splitClearNamedOnHaul',
    'splitMirrorHaulEquipHours', 'splitMirrorHaulEquipHoursAll', 'splitPricedMachineOnRow',
    'splitTruckOnRow', 'splitRowIsHaul', '_splitRowUid', '_blankSplitRow',
    'equipUsedPieces', 'splitFillNamedEquipment', 'onSplitHaulChange']) {
    vm.runInContext(requireFn(PAY, f, 'payroll.html'), ctx);
  }
  const fresh = (entry, labor) => {
    ctx.splitEntry = entry;
    const row = ctx._blankSplitRow(false);
    row.labor_hours = labor;
    ctx.splitRows = [row];
    ctx.splitMirrorHaulEquipHoursAll();
    ctx.splitFillNamedEquipment();
    return row;
  };

  // The operator named the SAME unit the driver did. Blanking it achieved
  // nothing except to let splitDefaultHaulEquipment put the identical unit back
  // with _equipHoursTouched cleared — whereupon the mirror levelled the truck to
  // the LABOUR hours, billing ten hours of truck for the six he stated, on a row
  // that posts $0 labour so that line is all the job pays.
  {
    const row = fresh({ truck_unit: 'Triaxle Dump 12', haul_type: null,
                        equipment_used: [{ name: 'Triaxle Dump 12', hours: 6 }] }, 10);
    assert('the operator\'s own truck is prefilled with the hours he stated',
      row.equipment === 'Triaxle Dump 12' && row.equip_hours === 6, JSON.stringify(row));
    row.haul_type = 'off_site'; row.is_haul = true;
    ctx.onSplitHaulChange(row);
    assert('  and answering "haul" leaves both alone, because it IS the truck',
      row.equipment === 'Triaxle Dump 12' && row.equip_hours === 6, JSON.stringify(row));
    assert('  keeping his figure marked as somebody\'s, so nothing re-levels it',
      row._equipHoursTouched === true);
  }

  // A DIFFERENT machine on a haul row still comes off — that is the $0-labour
  // hazard the take-back exists for.
  {
    const row = fresh({ truck_unit: 'Triaxle Dump 12', haul_type: null,
                        equipment_used: [{ name: 'Roller', hours: 8 }] }, 8);
    row.haul_type = 'off_site'; row.is_haul = true;
    ctx.onSplitHaulChange(row);
    assert('a machine that is NOT the truck still gives the row back to the haul rules',
      row.equipment === 'Triaxle Dump 12', JSON.stringify(row));
  }

  // The commute is not the machine's time. splitClearHaulAuto names this as the
  // bug it was written for; a prefilled machine walked straight back into it.
  {
    const row = fresh({ truck_unit: '', haul_type: null,
                        equipment_used: [{ name: 'Roller', hours: 8 }] }, 8);
    assert('a prefilled machine is on the row to begin with', row.equipment === 'Roller');
    row.is_travel = true;
    const changed = ctx.splitClearNamedOnHaul(row);
    assert('ticking Travel takes the machine off the commute',
      changed && !row.equipment && !((Number(row.equip_hours) || 0) > 0), JSON.stringify(row));
  }
}
assert('  the is_travel branch runs the take-back before it drops the haul answer',
  /if \(r\.is_travel && splitClearNamedOnHaul\(r\)\) repaint = true;/.test(PAY));
assert('  and one helper answers "which machine would the haul rules name"',
  /function splitHaulTruckName\(\)/.test(PAY)
  && /const truck = splitHaulTruckName\(\);/.test(PAY));

assert('  an equipment edit clears BOTH auto-fill flags, so neither take-back overreaches',
  /if \(field === 'equipment'\) \{ r\._namedAutoEquip = false; r\._haulAutoEquip = false; \}/.test(PAY));
assert('  the take-back runs on both UI paths, which both funnel through onSplitHaulChange',
  /splitClearNamedOnHaul\(row\);/.test(PAY)
  && /changed = splitClearNamedOnHaul\(r\)\s*\|\| changed;/.test(PAY));
assert('  and the prefill refuses a haul row outright',
  /!isTravelSplitRow\(r\) && !splitRowTakesTruck\(r\)/.test(PAY));

assert('  and it only ever runs on a fresh approve, never on Edit Split',
  /if \(mode !== 'resplit'\) splitFillNamedEquipment\(\);/.test(PAY));
assert('  after the haul rules, so the truck on a haul row still wins',
  PAY.indexOf("splitMirrorHaulEquipHoursAll();") < PAY.indexOf("splitFillNamedEquipment();"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
