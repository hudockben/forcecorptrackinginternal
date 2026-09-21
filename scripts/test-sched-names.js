#!/usr/bin/env node
'use strict';
/**
 * Who the Scheduler board says is on a job.
 *
 * Run: node scripts/test-sched-names.js
 *
 * The By Job board used to label every chip with the FIRST WORD of a name.
 * That is fine until the roster carries two Blakes, and this one carries
 * several of most first names — at which point the board stops naming anybody.
 * It says "Blake", and the only way to learn which Blake was to hover the chip
 * and read the tooltip, which is no use at all while you are dragging it.
 *
 * Nowhere else in the app ever made that trade. The crew rail, the By Crew
 * rows, the assign dialog, the dispatch sheet and every toast have always
 * printed the whole name. So the rule this pins is a simple one, and it is the
 * one that kept being broken in one corner while holding everywhere else:
 *
 *   a name the board shows is the whole name, on people and machines alike.
 *
 * Two layers:
 *   1. Behavioural — runs scheduler.html's own chip() in a vm, over the shapes
 *      a day cell actually holds: two men sharing a first name, a man with no
 *      last name at all, a machine and its operator, a half day, a cost code.
 *   2. Wiring      — the page over again, for any surviving place a name is
 *      cut down to its first word.
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
const { sliceSource, evalSlice } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const slice = sliceSource;

const SCHED = read('scheduler.html');

// The page's own escaper rather than a restatement of it: half of what is
// asserted below is that chip() still escapes what it now prints in full.
const ESC  = slice(SCHED, 'const esc = s =>', 'const pad = n =>', 'the HTML escaper', 'escAttr');
// chip(), the const it closes over, and the whole stretch of page above it —
// because the helper this suite exists to keep deleted lived in exactly that
// stretch, and a slice that started at DRAG_TIP let it come back invisible: the
// lift still evaluated, and chip() died on a ReferenceError at call time with
// nothing in it about names.
const CHIP = slice(SCHED, 'function renderCapacity(', '// ── By Job board', 'the board chip',
                   ['const DRAG_TIP =', 'function chip(']);

/** scheduler.html's own chip(), over one assignment. */
function chip(a, opts) {
  const o = opts || {};
  const sandbox = {
    console,
    // The division stripe down the left of a chip. Not what any of this is about.
    divColor: () => '#22c55e',
    // Whether a booking is a trucking haul read through from Trucking. Only the
    // dashed edge and the truck glyph turn on it; the names do not.
    isForeign: a => !!(a && a.src),
    fmtTime: s => s || '',
  };
  vm.createContext(sandbox);
  evalSlice(ESC + '\n' + CHIP, sandbox, 'the board chip', { filename: 'scheduler.html' });
  try {
    return sandbox.chip(a, !!o.conflict, o.date || '2026-09-21', !!o.showJob);
  } catch (err) {
    // evalSlice only reaches what the lift READS as it loads. A helper chip()
    // reaches for when it RUNS surfaces here instead, and as a bare
    // ReferenceError it takes the suite down without saying what it was about.
    if (err instanceof ReferenceError) {
      return `[chip() could not run: ${err.message}. Either the page grew a helper `
           + `this slice does not cover, or it is back to shortening names.]`;
    }
    throw err;
  }
}

/** What a scheduler READS on the chip: its markup minus the tags and the
 *  tooltip, which has always carried the full name and is not the point. */
function label(html) {
  return html
    .replace(/^<span[^>]*>/, '')      // the chip's own open tag, tooltip and all
    .replace(/<[^>]*>/g, '')          // the cost-code tag and the drag grip
    .trim();
}

const MAN   = { id:'a1', kind:'emp', resource:'Blake Hostetler', division:'turf',
                jobId:'26049', jobName:'Franklin Regional Softball', costCode:'', half:false };
const OTHER = { ...MAN, id:'a2', resource:'Blake Kunkle' };

(async () => {
  console.log('Who the Scheduler board says is on a job\n');

  console.log('[a man on a job]');
  {
    const html = chip(MAN);
    assert('the chip names him in full', label(html) === 'Blake Hostetler', label(html));
    assert('and the tooltip still says where he is',
      /Blake Hostetler — Franklin Regional Softball/.test(html), html.slice(0, 200));
  }

  console.log('\n[the two Blakes this exists for]');
  {
    const a = label(chip(MAN)), b = label(chip(OTHER));
    assert('the board tells them apart without a tooltip', a !== b, `${a} vs ${b}`);
    assert('by their surnames', a === 'Blake Hostetler' && b === 'Blake Kunkle', `${a} / ${b}`);
  }

  console.log('\n[the things riding alongside the name]');
  {
    const coded = chip({ ...MAN, costCode:'02-200' });
    assert('a cost code still rides on the chip', /02-200/.test(coded), label(coded));
    assert('and the name is still whole beside it',
      label(coded).startsWith('Blake Hostetler'), label(coded));
    const half = chip({ ...MAN, half:true });
    assert('a half day is still marked ½', /½/.test(label(half)), label(half));
    const conf = chip(MAN, { conflict:true });
    assert('a double-booking still reddens the chip', /class="asn conflict"/.test(conf),
      conf.slice(0, 80));
  }

  console.log('\n[a machine and the man on it]');
  {
    const html = chip({ id:'e1', kind:'equip', resource:'John Deere 644K', op:'Tuffy Shellenbarger',
                        division:'paving', jobId:'26091', jobName:'Orchard Hills', costCode:'', half:false });
    const l = label(html);
    assert('the machine is named in full', /John Deere 644K/.test(l), l);
    assert('so the first word of it is not read as a man', !/^🚜 John$/.test(l), l);
    assert('and its operator is named in full', /Tuffy Shellenbarger/.test(l), l);
    assert('with a space either side of the separator between them',
      / · /.test(l) && !/\S·|·\S/.test(l), JSON.stringify(l));
    const loose = chip({ id:'e2', kind:'equip', resource:'CAT 336', division:'paving',
                         jobId:'26091', jobName:'Orchard Hills', costCode:'', half:false });
    assert('a machine with nobody on it names only itself', label(loose) === '🚜 CAT 336', label(loose));
  }

  console.log('\n[the names that are not two words]');
  {
    // Time-off rows fall back to the login when the roster has no name for one
    // (api/scheduler/board.js readTimeOff), so single-token names reach the board.
    const one = chip({ ...MAN, resource:'devalerioted' });
    assert('a one-word name comes through unchanged', label(one) === 'devalerioted', label(one));
    const long = chip({ ...MAN, resource:'Christopher Vandermolen-Shellenbarger Jr' });
    assert('a long one is not cut short by the renderer',
      label(long) === 'Christopher Vandermolen-Shellenbarger Jr', label(long));
  }

  console.log('\n[a name is still not markup]');
  {
    const html = chip({ ...MAN, resource:'Bob <script>alert(1)</script> & Sons' });
    assert('the name is escaped where it is shown', !/<script>/.test(html), html.slice(0, 240));
    assert('and the ampersand with it', /&amp;/.test(html), html.slice(0, 240));
  }

  console.log('\n[the By Crew board still names the JOB]');
  {
    // That board's row lead already names the man; repeating him in every cell
    // said nothing, so those chips carry the job he is on instead.
    const html = chip({ ...MAN, costCode:'02-200' }, { showJob:true });
    assert('the cell says the job, not the man',
      /Franklin Regional Softball/.test(label(html)) && !/Blake/.test(label(html)), label(html));
  }

  console.log('\n[and nowhere on the page is a name cut to its first word]');
  {
    assert('firstWord() is gone', !/firstWord/.test(SCHED));
    const splits = SCHED.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /\.split\(' '\)\[0\]/.test(l));
    assert('and no name is split on its first space either', splits.length === 0,
      splits.map(([n, l]) => `line ${n}: ${l.trim()}`).join(' | '));
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
