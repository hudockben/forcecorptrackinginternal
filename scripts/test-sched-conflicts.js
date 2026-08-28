#!/usr/bin/env node
'use strict';
/**
 * The Scheduler's double-booking flag: what it fires on, and what it stopped
 * firing on.
 *
 * Run: node scripts/test-sched-conflicts.js
 *
 * The old rule was "this truck appears on two drivers' rows today". On a board
 * of twenty-six drivers that fired on every truck handed over between shifts,
 * and on every truck shared by two drivers whose hauls had no end time yet —
 * which is most of them, most mornings. It also never once flagged a driver
 * booked on two hauls over the same hours, which is the thing a dispatcher
 * actually cannot ship.
 *
 * So there are two flags now, both meaning the same impossible thing: one
 * driver in two places at once, and one truck on two hauls at once. Both are
 * decided on the clock, and an overlap has to be provable — a haul with no end
 * time is read as the instant it starts rather than as the rest of the day.
 *
 * Two layers:
 *   1. Behavioural — runs trucking.html's own schedConflicts in a vm over
 *      days built to sit either side of every edge of the rule.
 *   2. Wiring      — the board, the day sheet and the printed plan each read
 *      the flag they are about, in the column it belongs to.
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

const TRUCKING = read('trucking.html');
const SCHED    = slice(TRUCKING, '    function schedPad(n)', '    function schedMerge(baseStr',
  'scheduler day helpers');
// Everything the Day view is drawn from, in one piece: the helpers above, the
// toolbar, the timeline, the day sheet and the grouping it is sectioned by.
// The sheet's sections are built from the truck types, which are declared with
// the managed lists — so the real ones come along rather than a stand-in.
const TYPES    = slice(TRUCKING, '    /* ── What kind of truck a unit is ──',
                                 '    /** The dismissed sign-ins', 'unit types');
const DAYVIEW  = TYPES + '\n' +
  slice(TRUCKING, '    function schedPad(n)', '    function schedSheetRows(date)', 'day view');

const DATE = '2026-08-27';

/** trucking.html's own conflict rule, over one day of assignments. */
function day(items) {
  const sandbox = {
    console,
    _remKey: v => String(v == null ? '' : v).trim(),
    divTruckLists: { drivers: [], customers: [], units: [], materials: [], locations: [] },
    schedS: () => ({ assignments: { [DATE]: items }, hidden: new Set() }),
  };
  vm.createContext(sandbox);
  vm.runInContext(SCHED, sandbox, { filename: 'trucking.html' });
  const c = sandbox.schedConflicts(DATE);
  return {
    ...c,
    page: sandbox,
    flagged: id => c.ids.get(id),
    ids: c.ids,
  };
}

/** The Day view as it is actually drawn — the timeline, the dispatch sheet and
 *  the toolbar over it — so a flag that reads right in the data is checked
 *  where a dispatcher would see it. */
function renderDay(items, units) {
  const sandbox = {
    console,
    _remKey: v => String(v == null ? '' : v).trim(),
    divTruckLists: { drivers: [...new Set(items.map(a => a.driver).filter(Boolean))].sort(),
                     customers: [], units: units || [], materials: [], locations: [] },
    schedS: () => ({ anchor: DATE, view: 'day', assignments: { [DATE]: items }, hidden: new Set(),
                     loaded: true, status: 'saved' }),
    schedEsc: v => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    // Declared further down the page than this slice reaches.
    schedRepItems: d => (d === DATE ? items : []),
    schedDivLabel: k => k || '',
    schedJobOf: a => (a && (a.project || a.customer)) || '',
    schedWeekDates: () => [DATE],
    // The slice binds the page's unload flush as it loads, and reads the save
    // state for the toolbar's status pill. Neither is what this is about.
    window: { addEventListener() {} },
    document: { getElementById: () => null, addEventListener() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(DAYVIEW, sandbox, { filename: 'trucking.html' });
  return { html: sandbox.schedDayHTML(), toolbar: sandbox.schedToolbarHTML(), page: sandbox };
}

(async () => {
  console.log('The Scheduler’s double-booking flag\n');

  console.log('[a truck on two hauls at once]');
  {
    const c = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00' },
      { id: '2', driver: 'Kirk, Dan',     unit: '2757', start: '10:00', end: '18:00' },
    ]);
    assert('both hauls are flagged', !!c.flagged('1') && !!c.flagged('2'));
    assert('as the truck, not the driver',
      c.flagged('1').unit === true && c.flagged('1').driver === false, JSON.stringify(c.flagged('1')));
    assert('and the truck is named once', c.units.size === 1 && c.units.has('2757'),
      [...c.units].join(','));
  }

  console.log('\n[a truck handed over between shifts is not]');
  {
    const c = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00' },
      { id: '2', driver: 'Kirk, Dan',     unit: '2757', start: '14:00', end: '22:00' },
    ]);
    assert('nothing is flagged', c.ids.size === 0, JSON.stringify([...c.ids]));
  }

  console.log('\n[and neither is a truck shared by two drivers on hours we cannot compare]');
  {
    // This is the one that made the flag meaningless: two hauls on one truck,
    // no end times yet, and the old rule called every one of them a conflict.
    const c = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00' },
      { id: '2', driver: 'Kirk, Dan',     unit: '2757', start: '13:00' },
    ]);
    assert('an unfinished window is not evidence of anything', c.ids.size === 0,
      JSON.stringify([...c.ids]));
    assert('and the toolbar has nothing to count', c.units.size === 0 && c.drivers.size === 0);
  }

  console.log('\n[a driver on two hauls at once — which nothing used to catch]');
  {
    const c = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00' },
      { id: '2', driver: 'Barr, Michael', unit: '5403', start: '09:00', end: '12:00' },
    ]);
    assert('both hauls are flagged', !!c.flagged('1') && !!c.flagged('2'));
    assert('as the driver', c.flagged('2').driver === true && c.flagged('2').unit === false,
      JSON.stringify(c.flagged('2')));
    assert('and the driver is named', c.drivers.size === 1 && c.drivers.has('Barr, Michael'),
      [...c.drivers].join(','));
  }

  console.log('\n[two hauls in a day for one driver is normal work]');
  {
    const c = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '11:00' },
      { id: '2', driver: 'Barr, Michael', unit: '2757', start: '11:00', end: '15:00' },
      { id: '3', driver: 'Barr, Michael', unit: '2757', start: '15:00', end: '19:00' },
    ]);
    assert('back-to-back is not double-booked', c.ids.size === 0, JSON.stringify([...c.ids]));
  }

  console.log('\n[what an unfinished window can still prove]');
  {
    const same = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00' },
      { id: '2', driver: 'Barr, Michael', unit: '5403', start: '06:00' },
    ]);
    assert('nobody starts two hauls on the same minute',
      !!same.flagged('1') && same.flagged('1').driver === true, JSON.stringify([...same.ids]));

    const inside = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00' },
      { id: '2', driver: 'Kirk, Dan',     unit: '2757', start: '10:00' },
    ]);
    assert('and a haul starting on a truck already out is a conflict',
      !!inside.flagged('2') && inside.flagged('2').unit === true, JSON.stringify([...inside.ids]));

    const after = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00' },
      { id: '2', driver: 'Kirk, Dan',     unit: '2757', start: '14:30' },
    ]);
    assert('but one starting after it is back is not', after.ids.size === 0,
      JSON.stringify([...after.ids]));
  }

  console.log('\n[the rows the rule cannot read]');
  {
    const c = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757' },
      { id: '2', driver: 'Barr, Michael', unit: '2757' },
      { id: '3', driver: 'Kirk, Dan',     unit: '',     start: '06:00', end: '14:00' },
      { id: '4', driver: '',              unit: '5403', start: '06:00', end: '14:00' },
      { id: '5', driver: 'Kirk, Dan',     unit: '5403', start: '25:00', end: '14:00' },
    ]);
    assert('an assignment with no start is never flagged',
      !c.flagged('1') && !c.flagged('2'), JSON.stringify([...c.ids]));
    assert('a blank truck is not a truck two hauls share', !c.flagged('3'));
    assert('a blank driver is not a person booked twice', !c.flagged('4'));
    assert('and an unreadable time is left alone rather than guessed at', !c.flagged('5'));
  }

  console.log('\n[a haul that is both]');
  {
    const c = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00' },
      { id: '2', driver: 'Barr, Michael', unit: '2757', start: '08:00', end: '10:00' },
    ]);
    assert('is flagged as both', c.flagged('1').driver === true && c.flagged('1').unit === true,
      JSON.stringify(c.flagged('1')));
    assert('and says so in one sentence',
      c.page.schedClashNote(c.flagged('1')) ===
        'this driver and this truck are both booked on another haul over the same hours',
      c.page.schedClashNote(c.flagged('1')));
    assert('while each on its own says only what it is',
      c.page.schedClashNote({ driver: true, unit: false }).startsWith('this driver')
      && c.page.schedClashNote({ driver: false, unit: true }).startsWith('this truck'));
    assert('and a clean haul says nothing at all', c.page.schedClashNote(undefined) === '');
  }

  console.log('\n[three hauls on one truck]');
  {
    const c = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00' },
      { id: '2', driver: 'Kirk, Dan',     unit: '2757', start: '07:00', end: '09:00' },
      { id: '3', driver: 'Riffer, Jeff',  unit: '2757', start: '08:00', end: '12:00' },
      { id: '4', driver: 'Glatt, Shane',  unit: '2757', start: '14:00', end: '18:00' },
    ]);
    assert('every haul that overlaps another is flagged',
      ['1', '2', '3'].every(id => !!c.flagged(id)), JSON.stringify([...c.ids]));
    assert('the one that does not is left clean', !c.flagged('4'));
    assert('and the truck is still counted once, not once per pair', c.units.size === 1,
      [...c.units].join(','));
  }

  console.log('\n[unrelated work is left alone]');
  {
    const c = day([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00' },
      { id: '2', driver: 'Kirk, Dan',     unit: '5403', start: '06:00', end: '14:00' },
    ]);
    assert('two drivers on two trucks over the same hours is a normal day',
      c.ids.size === 0, JSON.stringify([...c.ids]));
  }

  // ── 2. What the board and the sheets do with it ──────────────────────────
  console.log('\n[the flag is shown where it applies]');
  {
    const sheet = slice(TRUCKING, '    function schedDayHTML()', '    /* ═══════ How the daily report',
      'day table');
    assert('the day sheet flags the driver in the driver column',
      /schedEsc\(a\.driver\)[\s\S]{0,400}clash && clash\.driver[\s\S]{0,120}double-booked/.test(sheet));
    assert('and the truck in the truck column',
      /schedEsc\(a\.unit\)[\s\S]{0,80}clash && clash\.unit[\s\S]{0,160}overlap/.test(sheet));

    const bar = slice(TRUCKING, '    function schedToolbarHTML()', '    function schedNoDriversHTML()',
      'toolbar');
    assert('the toolbar counts drivers double-booked', /driver\$\{[^}]*\} double-booked/.test(bar));
    assert('and trucks in conflict, separately', /truck conflict/.test(bar));
    assert('and no longer claims a missing time is one',
      !/can’t compare/.test(bar) && !/couldn’t compare/.test(bar));

    const rep = slice(TRUCKING, '    function schedRepByDay(dates)', '    function schedRepBody(scope',
      'plan report');
    assert('the printed plan marks a double-booked driver', /\(double-booked\)/.test(rep));
    assert('and an overlapping truck', /\(overlap\)/.test(rep));
    assert('on the sheet each driver is handed, too',
      /_clash\.driver/.test(rep) && /_clash\.unit/.test(rep));

    assert('and nothing reads the old truck-only rule any more',
      !/schedUnitConflicts/.test(TRUCKING));
  }

  console.log('\n[the Day view, as it is drawn]');
  {
    const { html, toolbar } = renderDay([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00', project: 'CNX Fence' },
      { id: '2', driver: 'Barr, Michael', unit: '5403', start: '09:00', end: '12:00', project: 'Kovalchick' },
      { id: '3', driver: 'Kirk, Dan',     unit: '2757', start: '14:00', end: '20:00', project: 'Russell Jenk' },
    ], [{ name: '2757', number: '4', type: 'triaxle' }, { name: '5403', number: '21', type: 'lowboy' }]);

    assert('the day sheet draws', /Dispatch Sheet/.test(html) && /<table/.test(html));
    assert('the double-booked driver is called out on their rows',
      (html.match(/double-booked/g) || []).length === 2, String((html.match(/double-booked/g) || []).length));
    // The truck the two drivers share is handed over at 2pm, so it is not one.
    assert('and the truck handed over between them is not flagged',
      !/>overlap</.test(html), (html.match(/.{40}overlap.{20}/) || [''])[0]);
    assert('the rows in the clash are marked as a pair',
      (html.match(/<tr class="conflict"/g) || []).length === 2);
    assert('and the timeline bars with them',
      (html.match(/sch-tl-bar conflict/g) || []).length === 2);
    assert('the toolbar says what is wrong in the words of the thing that is wrong',
      /1 driver double-booked/.test(toolbar), toolbar.replace(/\s+/g, ' ').slice(0, 200));
    assert('and does not invent a truck conflict to go with it', !/truck conflict/.test(toolbar));
    // The sheet is still sectioned by type with the type on every row.
    assert('the sheet sections the hauls by truck type',
      /Tri-Axle<\/td>|Tri-Axle\s*<span class="ct"|>Tri-Axle</.test(html), 'no Tri-Axle section');
  }

  console.log('\n[and when it really is the truck]');
  {
    const { html, toolbar } = renderDay([
      { id: '1', driver: 'Barr, Michael', unit: '2757', start: '06:00', end: '14:00', project: 'CNX Fence' },
      { id: '2', driver: 'Kirk, Dan',     unit: '2757', start: '10:00', end: '18:00', project: 'Kovalchick' },
    ], [{ name: '2757', number: '4', type: 'triaxle' }]);

    assert('the overlap is called out in the truck column',
      (html.match(/>overlap</g) || []).length === 2, String((html.match(/>overlap</g) || []).length));
    assert('and nobody is accused of being in two places at once',
      !/double-booked/.test(html));
    assert('the toolbar counts the truck', /1 truck conflict/.test(toolbar));
    assert('and only the truck', !/double-booked/.test(toolbar));
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
