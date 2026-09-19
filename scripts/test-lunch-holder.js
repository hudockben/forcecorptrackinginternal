#!/usr/bin/env node
'use strict';
/**
 * Which job of a split day the lunch break comes off.
 *
 * Run: node scripts/test-lunch-holder.js
 *
 * The deduction used to land on whichever job was entered first. That is not
 * where anybody eats: a day split 07:30-09:00 / 09:30-16:00 took the whole half
 * hour off the 07:30 block, which then showed 1.00 against a clock window of
 * 1.50 and read as an arithmetic error. On a prevailing-wage day it was worse
 * than confusing — it took the break off the covered job and left the uncovered
 * one whole, understating the hours the covered job has to certify.
 *
 * It now goes on the block overlapping the middle of the day the most, falling
 * back to the longest block when nothing is near midday at all.
 *
 * What this pins:
 *   1. The rule itself, including the midday window, the longest-block
 *      fallback, overnight shifts, and that every tie is broken — the form and
 *      the server must pick the SAME block from the same day or they disagree
 *      about a man's hours.
 *   2. Exactly one block ever carries it.
 *   3. The day's total is unchanged by the move — this reallocates, it does
 *      not pay more or less.
 *   4. The reload path reads the day's answer off the GROUP. Reading job 1
 *      alone silently dropped the deduction on re-save, which paid the half
 *      hour back.
 *   5. The server refuses to let a group hold two deductions.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));

const ROOT  = path.resolve(__dirname, '..');
const SHEET = fs.readFileSync(path.join(ROOT, 'timesheet.html'), 'utf8');
const API   = fs.readFileSync(path.join(ROOT, 'api/timesheet-entries.js'), 'utf8');
const PAY   = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── Lift the page's own rule ───────────────────────────────────────────────
const ctx = vm.createContext({});
vm.runInContext(
  'const LUNCH_WINDOW_MIN = [11 * 60, 14 * 60];\n'
  + 'const LUNCH_MINUTES = 30;\n'
  + requireFn(SHEET, 'spanMinutes',    'timesheet.html') + '\n'
  + requireFn(SHEET, 'startMinutes',   'timesheet.html') + '\n'
  + requireFn(SHEET, 'middayOverlap',  'timesheet.html') + '\n'
  + requireFn(SHEET, 'lunchHolderPos', 'timesheet.html'), ctx);
const lunchHolderPos = vm.runInContext('lunchHolderPos', ctx);
const spanMinutes    = vm.runInContext('spanMinutes', ctx);

const w = (start, end) => ({ start, end });

// ── 1. The rule ────────────────────────────────────────────────────────────
console.log('\nThe break lands on the job it fell in');

assert('the reported day: 07:30-09:00 / 09:30-16:00 → the afternoon job',
  lunchHolderPos([w('07:30', '09:00'), w('09:30', '16:00')]) === 1,
  'was job 0 under the old rule — the 1.5h block that showed 1.00');

assert('order does not matter, only the clock',
  lunchHolderPos([w('09:30', '16:00'), w('07:30', '09:00')]) === 0);

assert('three jobs — the one spanning noon takes it',
  lunchHolderPos([w('06:00', '10:00'), w('10:30', '14:30'), w('15:00', '18:00')]) === 1);

assert('a job that only clips the window still beats one that misses it',
  lunchHolderPos([w('05:00', '11:30'), w('14:00', '19:00')]) === 0,
  '05:00-11:30 overlaps 11:00-11:30; 14:00-19:00 overlaps nothing');

console.log('\nNothing near midday — the longest block carries it');

assert('a morning-only day gives it to the longer block',
  lunchHolderPos([w('05:00', '07:00'), w('07:30', '10:30')]) === 1);

assert('an evening-only day gives it to the longer block',
  lunchHolderPos([w('15:00', '17:00'), w('17:30', '22:00')]) === 1);

assert('a night shift crossing midnight is measured against the midday it reaches',
  lunchHolderPos([w('22:00', '06:00'), w('07:00', '09:00')]) === 0,
  'the 8h block is longest and neither touches midday');

assert('an overnight block that runs INTO midday takes it on overlap, not length',
  lunchHolderPos([w('20:00', '13:00'), w('14:30', '23:00')]) === 0);

console.log('\nEvery tie is broken, so form and server cannot disagree');

assert('equal midday overlap → the longer block',
  lunchHolderPos([w('11:00', '12:00'), w('11:00', '14:00')]) === 1);

assert('identical windows → the earlier block, deterministically',
  lunchHolderPos([w('08:00', '16:00'), w('08:00', '16:00')]) === 0);

assert('repeated calls give the same answer',
  (() => {
    const day = [w('06:00', '11:15'), w('11:45', '15:00'), w('15:30', '19:00')];
    const a = lunchHolderPos(day);
    return [0, 0, 0, 0].every(() => lunchHolderPos(day) === a);
  })());

console.log('\nDegenerate days do not throw or pick nonsense');

assert('no usable clock → -1, and the caller falls back',
  lunchHolderPos([w('', ''), w(null, '09:00')]) === -1);
assert('a zero-length block is never chosen',
  lunchHolderPos([w('12:00', '12:00'), w('06:00', '07:00')]) === 1);
assert('a single job takes it',
  lunchHolderPos([w('07:00', '17:30')]) === 0);
assert('no blocks at all → -1',
  lunchHolderPos([]) === -1);

// ── 2. Exactly one holder, and the day still adds up ───────────────────────
console.log('\nOne deduction per day, and the day is unchanged by the move');

function dayHours(windows, lunchYes) {
  const holder = Math.max(0, lunchHolderPos(windows));
  return windows.map((x, i) => {
    let mins = spanMinutes(x.start, x.end);
    if (i === holder && lunchYes) mins = Math.max(0, mins - 30);
    return Math.round((mins / 60) * 100) / 100;
  });
}
const REPORTED = [w('07:30', '09:00'), w('09:30', '16:00')];

assert('exactly one block is short, whatever the day',
  [[w('07:30','09:00'), w('09:30','16:00')],
   [w('06:00','10:00'), w('10:30','14:30'), w('15:00','18:00')],
   [w('05:00','07:00'), w('07:30','10:30')]].every(day => {
     const gross = day.map(x => Math.round((spanMinutes(x.start, x.end) / 60) * 100) / 100);
     const net   = dayHours(day, true);
     return net.filter((h, i) => Math.abs(gross[i] - h) > 0.001).length === 1;
   }));

assert('the reported day: 1.50 and 6.00, not 1.00 and 6.50',
  JSON.stringify(dayHours(REPORTED, true)) === JSON.stringify([1.5, 6]),
  JSON.stringify(dayHours(REPORTED, true)));

assert('the day total is untouched — this moves the break, it does not pay it',
  (() => {
    const before = 1.00 + 6.50;                       // old allocation
    const after  = dayHours(REPORTED, true).reduce((a, b) => a + b, 0);
    return Math.abs(before - after) < 0.001;
  })(),
  'both must be 7.50 of worked hours');

assert('a No day loses nothing anywhere',
  JSON.stringify(dayHours(REPORTED, false)) === JSON.stringify([1.5, 6.5]));

// ── 3. The submit path uses the rule, and only one block matches ───────────
console.log('\nThe form sends it where the rule says');

assert('buildPayloads picks the holder from the windows it is about to send',
  /const lunchPos = Math\.max\(0, lunchHolderPos\(blocks\.map\(b => \(\{ start: b\.start, end: b\.end \}\)\)\)\);/.test(SHEET));
assert('and flags exactly that block',
  /lunch_break: pos === lunchPos \? lunchVal : false,/.test(SHEET));
assert('the old position-0 rule is gone from the submit path',
  !/lunch_break: pos === 0 \?/.test(SHEET));
assert('the live preview deducts from the same block, not block 0',
  /if \(i === holder && lunchVal === true\)/.test(SHEET)
  && !/if \(i === 0 && lunchVal === true\)/.test(SHEET));
assert('every block repaints when any clock moves',
  /for \(const i of blockOrder\(\)\) paintBlockHours\(i, holder\);/.test(SHEET));
assert('toggling the lunch answer repaints the day, not block 0',
  !/lunchVal = val; updateHours\(0\)/.test(SHEET)
  && /lunchVal = val; updateHours\(\)/.test(SHEET));

// ── 4. The reload path — the silent half hour ──────────────────────────────
console.log('\nReloading a saved day keeps its break');

assert('the day\'s answer is read off the whole group',
  /group\.some\(g => g\.lunch_break === true\)/.test(SHEET));
assert('reading job 1 alone is gone',
  !/first\.lunch_break === true \|\| first\.lunch_break === false/.test(SHEET));

const lunchAnswer = g =>
  g.some(x => x.lunch_break === true) ? true
  : g.some(x => x.lunch_break === false) ? false : null;

assert('a break stored on job 2 still reads Yes for the day',
  lunchAnswer([{ lunch_break: false }, { lunch_break: true }]) === true,
  'this is the resubmit-loses-the-lunch case');
assert('an explicit No everywhere reads No',
  lunchAnswer([{ lunch_break: false }, { lunch_break: false }]) === false);
assert('a day never asked stays unanswered, not a silent No',
  lunchAnswer([{ lunch_break: null }, { lunch_break: null }]) === null);

// ── 5. The server refuses a day with two deductions ────────────────────────
console.log('\nThe server keeps one break per day');

assert('releaseSiblingLunch exists',
  /async function releaseSiblingLunch\(sql, companyCode, payload, holder\)/.test(API));
assert('it only acts on a split daily row that carries the break',
  /if \(!holder\.split_group_id \|\| holder\.lunch_break !== true\) return \[\];/.test(API));
assert('it finds siblings still claiming it',
  /AND id <> \$\{holder\.id\}[\s\S]{0,60}AND lunch_break IS TRUE/.test(API));
assert('it recomputes from the punches rather than adding 0.5 back',
  /const gross = computeHours\(hhmm\(other\.start_time\), hhmm\(other\.end_time\)\);/.test(API));
assert('it audits every row it corrects',
  /reason: 'lunch_break moved to another job of this split day'/.test(API));
assert('it runs on insert', /await releaseSiblingLunch\(sql, companyCode, payload, row\);/.test(API));
assert('it runs on update', /await releaseSiblingLunch\(sql, companyCode, payload, updated\);/.test(API));

assert('there is a single call that moves the break across a day',
  /req\.query\.action === 'lunch_holder'/.test(API));
assert('it rejects a job that is not part of the day',
  /That job is not part of this day/.test(API));
assert('it can clear the day entirely',
  /lunch break cleared for this day/.test(API));
assert('it gates on payroll or the worker\'s own draft',
  /const ownDraft = anchorRow\.user_id === userId && anchorRow\.status === 'draft';/.test(API));

// ── 6. Payroll names the job that took it ──────────────────────────────────
console.log('\nPayroll names the job, not "job 1"');

assert('no tooltip still hardcodes job 1',
  !/lunch[^\\n]*deducted on job 1 of this split/.test(PAY)
  && !/lunch deduction is taken on job 1 of this split/.test(PAY));
assert('the holder is looked up per split group',
  /function lunchHolders\(\)/.test(PAY) && /function lunchNoTitle\(e\)/.test(PAY));
assert('built from allEntries, so a filtered-out sibling is still found',
  /const src = typeof allEntries === 'undefined' \? \[\] : allEntries;/.test(PAY)
  && /for \(const e of src\)[\s\S]{0,200}map\.set\(e\.split_group_id/.test(PAY),
  'the lookup must read the full result set, not the filtered one');
assert('the approver can move it',
  /id="em-lunch-on"/.test(PAY) && /async function saveLunchHolder\(\)/.test(PAY));
assert('the modal reads the day\'s answer, not one row\'s',
  /lunchGroup\.some\(g => g\.lunch_break === true\)/.test(PAY));
assert('the move is one call, not a PUT per job',
  /action=lunch_holder/.test(PAY));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
