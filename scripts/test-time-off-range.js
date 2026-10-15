#!/usr/bin/env node
'use strict';
/**
 * A stretch of days off is filed in one go — one full-day entry per weekday.
 *
 * Run: node scripts/test-time-off-range.js
 *
 * Before this, a man off November 5th to the 12th filled the time-off form in
 * six times. The "How long" control's third answer is now "Date range": a
 * first and a last day, and every weekday between them goes out as its own
 * full-day (8 h) entry. One entry PER DAY, not one long entry, because payroll,
 * the reports and the scheduler all read time off a day at a time.
 *
 * What has to hold, and why each is money:
 *
 *   WEEKDAYS ONLY.  A week off is five days of vacation. Filing the Saturday
 *                   and Sunday pays sixteen hours nobody was owed.
 *   EVERY DAY ONCE. Early November is when the clocks go back; a range walked
 *                   in local time across that night can repeat or skip a date.
 *   FULL DAYS.      Each entry says 8 hours out loud — an absent figure is
 *                   read as a full day too, but the form never relies on that.
 *   A CAP.          A slip of the year on the picker turns a week into a
 *                   twelvemonth of entries.
 *   NO LEFTOVERS.   A range saved as a draft and then shortened deletes the
 *                   drafts for the days it dropped, instead of leaving them on
 *                   the list one tap from being submitted.
 *
 * Runs the page's own functions out of timesheet.html in a vm sandbox.
 */

// The range is walked in UTC; prove it by running in a zone that changes its
// clocks inside the ranges below.
process.env.TZ = 'America/New_York';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn, sliceSource, evalSlice } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SRC = fs.readFileSync(path.resolve(__dirname, '../timesheet.html'), 'utf8');

// ── A sandbox with just the elements the time-off form touches ──────────────
function classList(initial = []) {
  const s = new Set(initial);
  return {
    add:      c => s.add(c),
    remove:   c => s.delete(c),
    contains: c => s.has(c),
    toggle:   (c, on) => (on === undefined
      ? (s.has(c) ? s.delete(c) : s.add(c))
      : (on ? s.add(c) : s.delete(c))),
  };
}

function sandbox() {
  const els = {};
  const attrWrites = [];
  const el = id => {
    if (els[id]) return els[id];
    const e = { id, style: {}, value: '', min: '', textContent: '',
                classList: classList(), querySelectorAll: () => [] };
    if (id === 'seg-off-len') {
      e.buttons = ['full', 'half', 'range'].map(v => ({ dataset: { val: v }, classList: classList() }));
      e.querySelectorAll = () => e.buttons;
    }
    if (id === 'off-dates') e.classList.add('one');   // as the markup ships
    // The two date boxes record any write to their min or max. Chrome rebuilds
    // a date box whose min is assigned — even to the value it already has —
    // and wipes whatever is half-typed in it, so the handler that runs on
    // every keystroke must never make one.
    if (id === 'f-off-date' || id === 'f-off-date-end') {
      for (const attr of ['min', 'max']) {
        let v = '';
        Object.defineProperty(e, attr, {
          get: () => v,
          set: x => { attrWrites.push(`${id}.${attr}=${x}`); v = x; },
        });
      }
      e.setAttribute = (n, x) => attrWrites.push(`${id}.setAttribute(${n}, ${x})`);
    }
    if (id === 'f-off-supervisor') {
      e.value = '7';
      e.selectedIndex = 0;
      e.options = [{ value: '7', dataset: { name: 'Sam Foreman' }, textContent: 'Sam Foreman' }];
    }
    return (els[id] = e);
  };
  const fetches = [];
  const sb = {
    console, Date, Math, Number, Set, Object, String, JSON,
    document: { getElementById: el },
    authHeaders: () => ({ Authorization: 'Bearer t' }),
    // DELETE always succeeds unless a test says otherwise.
    __deleteOk: true,
    fetch: async (url, opts) => {
      fetches.push({ url, method: opts && opts.method });
      return { ok: sb.__deleteOk, json: async () => (sb.__deleteOk ? { ok: true } : { error: 'nope' }) };
    },
    __els: els, __fetches: fetches, __attrWrites: attrWrites,
  };
  vm.createContext(sb);
  // Everything from the length control's state down to the hours it asks the
  // API for comes across in one piece, so the pieces cannot drift apart here.
  evalSlice(sliceSource(SRC, "    let offLen = 'full';", '    // ── Compute hours live',
    'the time-off length control', 'function offHoursValue()'), sb, 'the time-off length control');
  evalSlice([
    requireFn(SRC, 'prettyDate',       'timesheet.html'),
    requireFn(SRC, 'buildPayloads',    'timesheet.html'),
    requireFn(SRC, 'listUnit',         'timesheet.html'),
    // Lifted from the word `function`, so the `async` in front is put back.
    'async ' + requireFn(SRC, 'dropStaleOffDays', 'timesheet.html'),
    // The vacation note under the length control — scripts/test-vacation.js.
    'function renderVacationHint() {}',
    // The page's `let`s live in the script scope, not on the sandbox object.
    `let currentType = 'time_off', offType = 'vacation', editingIds = {};`,
    `globalThis.__state = () => ({ offLen, currentType, editingIds });`,
    `globalThis.__set = (k, v) => { if (k === 'editingIds') editingIds = v;
                                   else if (k === 'currentType') currentType = v;
                                   else if (k === 'offType') offType = v; };`,
  ].join('\n'), sb, 'the time-off payload builder');
  return sb;
}

// ── The markup ──────────────────────────────────────────────────────────────
console.log('\n[the third answer is a date range]');
{
  assert('"Other" is gone from the length control',
    !/data-val="other"[^>]*>Other</.test(SRC) && !/setOffLen\('other'/.test(SRC));
  assert('  and "Date range" is in its place',
    /<button type="button" data-val="range" onclick="setOffLen\('range'\)">Date range<\/button>/.test(SRC));
  assert('there is a last-day picker beside the first',
    /id="row-off-date-end"[\s\S]{0,200}?<input type="date" id="f-off-date-end"/.test(SRC));
  assert('  in the same row as the date, so picking a range does not shift the page',
    /<div class="row-2 one" id="off-dates">[\s\S]{0,400}?id="f-off-date"[\s\S]{0,400}?id="f-off-date-end"/.test(SRC));
  assert('a blank form clears the last day', /getElementById\('f-off-date-end'\)\.value = '';/.test(SRC));
}

// ── Which days a range files ────────────────────────────────────────────────
console.log('\n[a range files every weekday, once]');
{
  const sb = sandbox();
  const r = sb.offRangeDays('2026-11-05', '2026-11-12');
  assert('Thu Nov 5 to Thu Nov 12 is six days off',
    same(r.days, ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']),
    JSON.stringify(r));
  assert('  with the Saturday and Sunday skipped, and counted', r.skipped === 2, JSON.stringify(r));

  // Clocks go back on Sunday Nov 1, 2026. Walked in local time, that 25-hour
  // day is where a date gets repeated or dropped.
  const dst = sb.offRangeDays('2026-10-30', '2026-11-04');
  assert('a range across the clocks going back neither skips nor repeats a day',
    same(dst.days, ['2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04']), JSON.stringify(dst));
  const spring = sb.offRangeDays('2026-03-06', '2026-03-10');
  assert('  nor across the clocks going forward',
    same(spring.days, ['2026-03-06', '2026-03-09', '2026-03-10']), JSON.stringify(spring));

  assert('a range of one weekday is that one day',
    same(sb.offRangeDays('2026-11-05', '2026-11-05').days, ['2026-11-05']));
  assert('a range starting on a Saturday starts filing on the Monday',
    same(sb.offRangeDays('2026-11-07', '2026-11-10').days, ['2026-11-09', '2026-11-10']));
  assert('a month is allowed', !sb.offRangeDays('2026-11-01', '2026-12-01').error);
}

console.log('\n[a range that cannot be filed says why]');
{
  const sb = sandbox();
  assert('no last day', /last day/.test(sb.offRangeDays('2026-11-05', '').error || ''));
  assert('no first day', /first day/.test(sb.offRangeDays('', '2026-11-05').error || ''));
  assert('the last day before the first',
    /before the first/.test(sb.offRangeDays('2026-11-12', '2026-11-05').error || ''));
  assert('a weekend and nothing else',
    /only a weekend/.test(sb.offRangeDays('2026-11-07', '2026-11-08').error || ''));
  const long = sb.offRangeDays('2026-11-05', '2027-11-12');
  assert('a slip of the year is refused, not filed as a year of entries',
    /at most 31 days/.test(long.error || '') && !long.days, JSON.stringify(long).slice(0, 120));
  assert('  and 32 days is one too many',
    /at most 31 days/.test(sb.offRangeDays('2026-11-01', '2026-12-02').error || ''));
}

// ── What the form posts ─────────────────────────────────────────────────────
console.log('\n[a range posts one full-day entry per day]');
{
  const sb = sandbox();
  sb.document.getElementById('f-off-date').value     = '2026-11-05';
  sb.document.getElementById('f-off-date-end').value = '2026-11-12';
  sb.setOffLen('range');
  const { list, error } = sb.buildPayloads();
  assert('it builds without an error', !error, error);
  assert('  six entries for six weekdays', list && list.length === 6, list && list.length);
  assert('  one for each date, in order',
    same(list.map(x => x.data.work_date),
      ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']));
  assert('  every one a full day, said out loud',
    list.every(x => x.data.time_off_hours === 8 && x.data.entry_type === 'time_off'));
  assert('  every one the same type, supervisor and notes',
    list.every(x => x.data.time_off_type === 'vacation'
      && x.data.supervisor_id === '7' && x.data.supervisor_name === 'Sam Foreman'));
  assert('  labelled by date, so a failure says which day',
    list[0].label === sb.prettyDate('2026-11-05') && list[5].label === sb.prettyDate('2026-11-12'));
  // Block 0 is shared with a single day off; the rest must not be the bare
  // numbers the daily form gives its split jobs.
  assert('  the first day writes through block 0, the rest through their own keys',
    list[0].block === 0 && list.slice(1).every((x, n) => x.block === `off${n + 1}`),
    JSON.stringify(list.map(x => x.block)));
  assert('  none of which a daily split job can ever be given',
    list.slice(1).every(x => typeof x.block !== 'number'));

  sb.document.getElementById('f-off-date-end').value = '2026-11-04';
  assert('a backwards range is refused before anything is written',
    /before the first/.test(sb.buildPayloads().error || ''));
  sb.document.getElementById('f-off-date-end').value = '';
  assert('  and so is a range with no last day', /last day/.test(sb.buildPayloads().error || ''));
  sb.document.getElementById('f-off-date').value = '';
  assert('  or no first day', /first day/.test(sb.buildPayloads().error || ''));
}

console.log('\n[a single day is unchanged]');
{
  const sb = sandbox();
  sb.document.getElementById('f-off-date').value     = '2026-11-07';   // a Saturday
  sb.document.getElementById('f-off-date-end').value = '2026-11-20';   // ignored off a range
  sb.setOffLen('full');
  let r = sb.buildPayloads();
  assert('Full day posts one entry of 8 hours on block 0',
    r.list.length === 1 && r.list[0].block === 0 && r.list[0].data.time_off_hours === 8
    && r.list[0].label === 'Time off');
  assert('  for the one date, weekend or not', r.list[0].data.work_date === '2026-11-07');
  sb.setOffLen('half');
  r = sb.buildPayloads();
  assert('Half day posts one entry of 4 hours', r.list.length === 1 && r.list[0].data.time_off_hours === 4);

  // A draft filed through the old "Other" box reopens in 'custom' and keeps
  // its own figure — turning it into a full day on re-save would pay hours
  // nobody asked for.
  sb.setOffLen('custom');
  sb.document.getElementById('f-off-hours').value = '6';
  r = sb.buildPayloads();
  assert('an old custom-hours draft keeps its hours when saved again',
    r.list.length === 1 && r.list[0].data.time_off_hours === 6);
  sb.document.getElementById('f-off-hours').value = '';
  assert('  and still refuses an empty box rather than guessing', !!sb.buildPayloads().error);
}

// ── What the control shows ──────────────────────────────────────────────────
console.log('\n[the control shows the range, and what it will file]');
{
  const sb = sandbox();
  const $ = id => sb.document.getElementById(id);
  $('f-off-date').value = '2026-11-05';
  sb.setOffLen('range');
  const lit = () => $('seg-off-len').buttons.filter(b => b.classList.contains('on')).map(b => b.dataset.val);
  assert('Date range lights on its own', same(lit(), ['range']));
  assert('  the last-day picker appears', $('row-off-date-end').style.display === 'flex');
  assert('  beside the first, which is relabelled',
    !$('off-dates').classList.contains('one') && $('lbl-off-date').textContent === 'First day');
  assert('  the hours box stays hidden', $('row-off-hours').style.display === 'none');
  assert('  the hint asks for both days before there are two',
    /Pick the first and last day/.test($('off-len-hint').textContent));

  $('f-off-date-end').value = '2026-11-12';
  sb.onOffDatesChange();
  const hint = $('off-len-hint').textContent;
  assert('with both days the hint counts the days and the hours',
    /^6 days off/.test(hint) && /48\.00 hours in all/.test(hint), hint);
  assert('  and says the weekend was skipped', /2 weekend days skipped/.test(hint), hint);

  $('f-off-date-end').value = '2026-11-01';
  sb.onOffDatesChange();
  assert('a backwards range says so in the hint, before Submit',
    /before the first/.test($('off-len-hint').textContent));

  // The bug this guards: typing 11/12/2026 into the last day, the first digit
  // of the year made the value 0002-11-12, the handler set the box's min, and
  // the next digit wiped the month and day. Walk the same keystrokes through.
  for (const v of ['0002-11-12', '0020-11-12', '0202-11-12', '2026-11-12']) {
    $('f-off-date-end').value = v;
    sb.onOffDatesChange();
  }
  for (const v of ['0002-11-05', '0020-11-05', '0202-11-05', '2026-11-05']) {
    $('f-off-date').value = v;
    sb.onOffDatesChange();
  }
  assert('typing a date never writes to either date box\'s min or max',
    sb.__attrWrites.length === 0, sb.__attrWrites.join(', '));
  assert('  and the handler has no assignment to a min, max or value in it',
    !/\.(min|max|value)\s*=(?!=)/.test(requireFn(SRC, 'onOffDatesChange', 'timesheet.html')));

  sb.setOffLen('full');
  assert('back on Full day the second picker goes and the label is Date again',
    $('row-off-date-end').style.display === 'none' && $('off-dates').classList.contains('one')
    && $('lbl-off-date').textContent === 'Date');
  assert('  and the hint is the ordinary one', /full day is paid at 8 hours/.test($('off-len-hint').textContent));

  sb.setOffLen('custom');
  assert('an old custom draft lights nothing and shows its hours box',
    same(lit(), []) && $('row-off-hours').style.display === 'flex');
  assert('  with a hint that says how to leave it', /Pick Full day or Half day/.test($('off-len-hint').textContent));

  sb.setOffLen('other');
  assert('anything unknown falls back to a full day', sb.__state().offLen === 'full');
}

// ── Shrinking a saved range ─────────────────────────────────────────────────
console.log('\n[a range saved and then shortened drops the days it lost]');
(async () => {
  {
    const sb = sandbox();
    sb.__set('editingIds', { 0: 'r0', off1: 'r1', off2: 'r2', off3: 'r3' });
    await sb.dropStaleOffDays([{ block: 0 }, { block: 'off1' }]);
    const deleted = sb.__fetches.filter(f => f.method === 'DELETE').map(f => f.url.split('id=')[1]);
    assert('the two days no longer in the range are deleted', same(deleted.sort(), ['r2', 'r3']), JSON.stringify(deleted));
    assert('  and the form lets go of them, keeping the rest',
      same(sb.__state().editingIds, { 0: 'r0', off1: 'r1' }), JSON.stringify(sb.__state().editingIds));
  }
  {
    const sb = sandbox();
    sb.__set('editingIds', { 0: 'r0', off1: 'r1' });
    sb.__deleteOk = false;
    let threw = null;
    try { await sb.dropStaleOffDays([{ block: 0 }]); } catch (e) { threw = e; }
    assert('a delete that fails stops the save with a message', threw && /no longer in the range/.test(threw.message));
    assert('  and the row stays pinned so the next press tries again', sb.__state().editingIds.off1 === 'r1');
  }
  {
    // The daily form's split jobs are 1, 2, 3… and must never be touched here.
    const sb = sandbox();
    sb.__set('currentType', 'daily');
    sb.__set('editingIds', { 0: 'd0', 1: 'd1', off2: 'r2' });
    await sb.dropStaleOffDays([{ block: 0 }]);
    assert('a daily save deletes nothing', sb.__fetches.length === 0);
    sb.__set('currentType', 'time_off');
    sb.__set('editingIds', { 0: 'd0', 1: 'd1' });
    await sb.dropStaleOffDays([{ block: 0 }]);
    assert('  and a time-off save never deletes a numbered split job', sb.__fetches.length === 0);
  }

  // The messages count days, not jobs.
  {
    const sb = sandbox();
    assert('a multi-entry time-off save talks about days', sb.listUnit() === 'day');
    sb.__set('currentType', 'daily');
    assert('  and a split day still talks about jobs', sb.listUnit() === 'job');
  }
  assert('save and submit both drop the stale days before writing',
    /try \{\s*await dropStaleOffDays\(list\);\s*for \(const item of list\) await writeEntry/.test(SRC)
    && /try \{\s*await dropStaleOffDays\(list\);\s*\/\/ Write every block out as a draft first/.test(SRC));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
