#!/usr/bin/env node
'use strict';
/**
 * The crew-capacity board's shared meter scale.
 *
 * Run: node scripts/test-capacity-scale.js
 *
 * payroll.html declared `ccScaleMax` TWICE: one taking employees and reading
 * e.room.weeks, one taking ccOrdered's rows and reading r.win.weeks. Both
 * hoisted, so the later won and the earlier was dead code from before the
 * board moved from range-wide room to a per-window reading.
 *
 * Nothing was broken — the live copy was the right one — but it was two edits
 * away from being. The dead copy did not throw when handed rows; it guarded,
 * found nothing and returned the 50-hour floor. So had anyone deleted the
 * survivor or moved the two, every meter would have silently flattened to a
 * 50-hour track and a 62-hour week would have overflowed its own bar with no
 * error anywhere. And scripts/lib/fn-source.js lifts page functions by name
 * with indexOf, which finds the FIRST declaration — so any test lifting the
 * name would have quietly exercised the dead one.
 *
 * The board had no test at all. This pins the contract and the uniqueness.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn, fnSource } = require(path.resolve(__dirname, 'lib/fn-source.js'));

const PAGE = fs.readFileSync(path.resolve(__dirname, '..', 'payroll.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── 1. Declared once ───────────────────────────────────────────────────────
console.log('\nThe scale is worked out in exactly one place');

const decls = [...PAGE.matchAll(/^\s*function ccScaleMax\s*\(/gm)];
assert('ccScaleMax is declared once', decls.length === 1, `found ${decls.length}`);
assert('and it takes the board\'s rows, not employees',
  /function ccScaleMax\(rows\)/.test(PAGE),
  'the employee-shaped copy read e.room.weeks and returned the floor for every board');
// fnSource is how every suite here lifts a page function, and it takes the
// FIRST match. With one declaration that is the live one; assert the identity
// so a reintroduced duplicate fails here rather than somewhere subtler.
assert('so lifting it by name reaches the live copy',
  fnSource(PAGE, 'ccScaleMax').includes('r.win.weeks'));

// ── 2. The contract ────────────────────────────────────────────────────────
console.log('\nThe scale leaves room past the heaviest week');

const ctx = vm.createContext({});
vm.runInContext(requireFn(PAGE, 'ccScaleMax', 'payroll.html'), ctx);
const ccScaleMax = vm.runInContext('ccScaleMax', ctx);

const row = (...weeks) => ({ e: { username: 'x' }, win: { weeks: weeks.map(h => ({ totalHours: h })) } });

assert('an empty board still gets the 50-hour floor',
  ccScaleMax([]) === 50);
assert('a light week does not shrink the track below 50',
  ccScaleMax([row(12, 8)]) === 50,
  'the 40 tick has to sit inside the track with room past it');
assert('a 40-hour week still fits under the floor',
  ccScaleMax([row(40)]) === 50);
assert('a 62.5-hour week rounds up past itself, not onto its own edge',
  ccScaleMax([row(62.5)]) === 65, String(ccScaleMax([row(62.5)])));
assert('the heaviest week anywhere on the board sets it',
  ccScaleMax([row(20), row(48, 71.25), row(30)]) === 75,
  String(ccScaleMax([row(20), row(48, 71.25), row(30)])));
assert('a week exactly on a five rounds up past it, so the bar never pins flat',
  ccScaleMax([row(55)]) === 60, String(ccScaleMax([row(55)])));
assert('every week of every row is read, not just the first',
  ccScaleMax([row(10, 10, 68)]) === 70, String(ccScaleMax([row(10, 10, 68)])));

// ── 3. The shape it is actually given ──────────────────────────────────────
console.log('\nIt reads the window ccOrdered builds, not range-wide room');

const ordered = requireFn(PAGE, 'ccOrdered', 'payroll.html');
assert('ccOrdered hands it rows of { e, win }',
  /employees\.map\(e => \(\{ e, win: ccWindow\(e, weeks, rangeFrom\) \}\)\)/.test(ordered));
assert('and the board calls it with those rows',
  /const scaleMax = ccScaleMax\(\[\.\.\.hot, \.\.\.open\]\);/.test(PAGE));
assert('so a bar can never exceed its own track',
  (() => {
    // What the dead copy would have produced: no e.room on a row, so 50 flat.
    const rows = [row(62.5, 48)];
    const scale = ccScaleMax(rows);
    return rows.every(r => r.win.weeks.every(w => (w.totalHours / scale) * 100 <= 100));
  })(),
  'with the 50 floor a 62.5-hour week renders at 125% of its meter');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
