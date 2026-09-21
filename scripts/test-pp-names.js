#!/usr/bin/env node
'use strict';
/**
 * Who the Projection Planner says is working a day.
 *
 * Run: node scripts/test-pp-names.js
 *
 * The planner's month calendar labelled each crew chip with the FIRST WORD of
 * a name, the same trade the Scheduler board used to make and for the same
 * reason — a month cell is small. It cost the same thing: on a roster carrying
 * two Blakes, "Blake" names neither of them, and unlike the Scheduler's chips
 * these carried no title either, so there was nowhere to go and look.
 *
 * Underneath it a second cut was doing more damage than the first. `.pp-chip`
 * capped itself at 72px — about twelve characters — and that cap applied to
 * every chip on the page, including the ones the code had already handed a
 * WHOLE name: the crew-history list, and the day panel's tick-list where you
 * choose which of the two Blakes works Tuesday. Every name in a five-man
 * sample clipped there. So the truncation went, and the cap with it.
 *
 * Lifting the cap moved the problem rather than solving it, which is the third
 * rule below. A full name set the calendar column's min-content, `1fr` floors
 * at min-content, and the grid grew past .pp-cal-section — whose parent
 * .pp-main clips instead of scrolling. Saturday went off the side of the
 * screen, 170px of it at 1280px, with no scrollbar to reach it. A planner that
 * loses a day is worse than one that shortens a name, so the columns are
 * minmax(0,1fr) now and the overflow lands on the chip, where the ellipsis and
 * its title are.
 *
 * Three layers:
 *   1. Behavioural — runs the page's own chip-building block in a vm over the
 *      shapes a day holds: plain crew, crew split by machine, equipment, the
 *      "+N more" tail, a no-work day.
 *   2. Layout rules — the two CSS guarantees the names depend on.
 *   3. Drift      — tracker, paving and kiewit carry copies of this planner.
 *                   They have to stay copies.
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
const { sliceSource } = require(path.resolve(__dirname, 'lib/fn-source.js'));

const PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const SRC = Object.fromEntries(PAGES.map(f => [f, read(f)]));

// The page's own escaper, so the test cannot disagree with it about markup.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/** The planner's own chip block, over one day's plan. */
function chips(page, plan) {
  const region = sliceSource(SRC[page], "    let empChips = '';", '    // Copy-week button on Saturdays',
    page + ' calendar chips', ['pp-chip', 'eqChips']);
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext('globalThis.build = function (plan, esc) {\n' + region +
                  '\nreturn { empChips, eqChips };\n}', sandbox, { filename: page });
  return sandbox.build(plan, esc);
}

const text = html => html.replace(/<[^>]*>/g, '').trim();
const titles = html => [...html.matchAll(/title="([^"]*)"/g)].map(m => m[1]);

(async () => {
  console.log('Who the Projection Planner says is working a day\n');

  for (const page of PAGES) {
    console.log(`[${page}]`);

    // Plain crew: no machines assigned to anyone.
    {
      const r = chips(page, { employees: ['Blake Hostetler', 'Blake Kunkle', 'Colton Reed'] });
      assert('  a day names its crew in full',
        text(r.empChips) === 'Blake HostetlerBlake KunkleColton Reed', text(r.empChips));
      assert('  so two Blakes are told apart on the calendar',
        /Blake Hostetler/.test(r.empChips) && /Blake Kunkle/.test(r.empChips));
      assert('  and every chip carries the name as a tooltip too',
        titles(r.empChips).join('|') === 'Blake Hostetler|Blake Kunkle|Colton Reed',
        titles(r.empChips).join('|'));
    }

    // More than three: the cell shows three and counts the rest.
    {
      const r = chips(page, { employees: ['Adam Kunkle','Blake Hostetler','Colton Reed','Shane Glatt','Tyler Mathis'] });
      assert('  a fourth and fifth man still roll up into "+2"', /\+2/.test(r.empChips), text(r.empChips));
      assert('  and the three shown are whole', /Adam Kunkle/.test(r.empChips) && /Colton Reed/.test(r.empChips));
    }

    // Crew split by machine: chips become "<machine>:<count>".
    {
      const r = chips(page, { employees: ['Blake Hostetler','Colton Reed','Shane Glatt'],
                              crew: { 'Blake Hostetler':'320 Excavator', 'Colton Reed':'320 Excavator',
                                      'Shane Glatt':'Triaxle Dump' } });
      assert('  a machine breakdown names the machine in full',
        /320 Excavator:2/.test(r.empChips), text(r.empChips));
      assert('  so its first word is not mistaken for one',
        !/>320:2</.test(r.empChips) && /Triaxle Dump:1/.test(r.empChips), text(r.empChips));
    }

    // Loose equipment on the day.
    {
      const r = chips(page, { employees: [], equipment: ['320 Excavator','Triaxle Dump','Form Traveler'] });
      assert('  equipment is named in full', /320 Excavator/.test(r.eqChips) && /Triaxle Dump/.test(r.eqChips),
        text(r.eqChips));
      assert('  with the third rolled into "+1"', /\+1/.test(r.eqChips), text(r.eqChips));
      assert('  and a tooltip on each', titles(r.eqChips).length === 2, String(titles(r.eqChips).length));
    }

    // A no-work day says nothing about crew.
    {
      const r = chips(page, { noWork: true, employees: ['Blake Hostetler'], equipment: ['Roller'] });
      assert('  a no-work day lists nobody', r.empChips === '' && r.eqChips === '',
        JSON.stringify(r));
    }

    // A name is not markup.
    {
      const r = chips(page, { employees: ['Bob <script>alert(1)</script>'] });
      assert('  a name is escaped in the chip and in its tooltip',
        !/<script>/.test(r.empChips) && /&lt;script&gt;/.test(r.empChips), r.empChips.slice(0, 120));
    }

    // The two layout rules the full names depend on.
    {
      const css = SRC[page].slice(SRC[page].indexOf('.pp-chip {'), SRC[page].indexOf('.pp-chip.equip'));
      assert('  a chip is bounded by what holds it, not a fixed 72px',
        /max-width:\s*100%/.test(css) && !/max-width:\s*\d+px/.test(css), css.replace(/\s+/g, ' ').slice(0, 140));
      assert('  and the ellipsis stays behind it as the net',
        /text-overflow:\s*ellipsis/.test(css));
      // Scoped to the calendar's OWN rule: the page has other grids, and a
      // match on one of those would pass this while Saturday stayed missing.
      const grid = SRC[page].slice(SRC[page].indexOf('.pp-cal-grid {'),
                                   SRC[page].indexOf('.pp-col-hdr'));
      assert('  the week cannot be pushed off the side of the screen',
        /grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/.test(grid),
        (grid.match(/grid-template-columns:[^;]*/) || ['(no rule found)'])[0]);
    }

    assert('  no name is cut to its first word anywhere on the page',
      !/\.split\(' '\)\[0\]/.test(SRC[page]),
      (SRC[page].split('\n').findIndex(l => /\.split\(' '\)\[0\]/.test(l)) + 1) || '');
    console.log('');
  }

  // These three planners are copies of one another. A fix applied to one and
  // not the others is how they drift, and drift is why this bug outlived the
  // same fix on the Scheduler board.
  console.log('[the three planners stay copies of each other]');
  {
    const block = p => sliceSource(SRC[p], "    let empChips = '';", '    // Copy-week button on Saturdays', p, 'pp-chip');
    const [a, b, c] = PAGES.map(block);
    assert('  tracker and paving render chips identically', a === b);
    assert('  tracker and kiewit render chips identically', a === c);
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
