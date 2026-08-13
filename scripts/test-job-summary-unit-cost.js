#!/usr/bin/env node
'use strict';
/**
 * Job Summary Report — Running Unit Cost column
 *
 * Run: node scripts/test-job-summary-unit-cost.js
 *
 * The report's Cost & Sub-Code Groups table gained a Running Unit Cost
 * column: actual cost ÷ running quantity, the same rate the Bid Items
 * page shows. Every division app prints the same report, so all three
 * are checked.
 *
 * Two layers, matching the house style of the other frontend tests:
 *   1. Structural — the header, the body row, the group header, both
 *      subtotals, the totals row and the empty-table row all have to
 *      agree on the table's width. A colspan left at the old count
 *      shifts every column past Sub Code under the wrong heading.
 *   2. Behavioural — evaluates the real Running Unit Cost expressions
 *      lifted out of the source and asserts on:
 *        - the rate itself (actual ÷ running qty)
 *        - a sub code with no running quantity printing blank rather
 *          than dividing by zero
 *        - green at or under the bid's unit cost, red above it
 *        - no colour at all when there is no bid rate to compare to
 */

const fs   = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`);
  }
}

// Every division app prints this report from its own copy of the function.
const APPS = ['paving.html', 'tracker.html', 'kiewit-pinetree.html'];

/* The report is one big template literal, so the table is read out of the
   text rather than parsed — the same way the other frontend tests read it. */
function jobSummary(src) {
  const start = src.indexOf('async function exportJobSummary(projId, opts = {})');
  const end   = src.indexOf('function exportBidPDF', start);
  if (start < 0 || end < 0) throw new Error('exportJobSummary block not found');
  return src.slice(start, end);
}
// `from` anchors the search — the Change Orders section carries rows of the
// same class, so "the first <tr class="totals">" is not the one wanted here.
const slice = (s, a, b, from = 0) => {
  const i = s.indexOf(a, from);
  return i < 0 ? '' : s.slice(i, s.indexOf(b, i) + b.length);
};
const count = (s, re) => (s.match(re) || []).length;

for (const app of APPS) {
  console.log(`\n[structural — ${app}]`);
  const js = jobSummary(fs.readFileSync(path.resolve(__dirname, '..', app), 'utf8'));

  // ── The table's declared width ─────────────────────────────────────
  const thead = slice(js, '<th>Sub Code</th>', '</tr></thead>');
  const COLS  = count(thead, /<th[ >]/g);
  assert('the cost table declares a header row', COLS > 0);
  // The two rates only compare if they are adjacent — a column between them
  // is the whole reason the bid rate was brought into the report.
  assert('Bid Unit Cost and Running Unit Cost sit side by side, before Bid Cost',
    /Running Qty<\/th>\s*<th[^>]*>Bid Unit Cost<\/th><th[^>]*>Running Unit Cost<\/th>\s*<th[^>]*>Bid Cost/.test(thead),
    thead.replace(/\s+/g, ' '));

  // ── Body row: one cell per header ──────────────────────────────────
  const bodyRow = slice(js, '<td class="sub">${esc(b.sub_code)', '</tr>`;');
  assert('one body cell per header', count(bodyRow, /<td[ >]/g) === COLS,
    `${count(bodyRow, /<td[ >]/g)} td / ${COLS} th`);
  assert('the bid rate is the bid item\'s own unit cost',
    /<td class="num">\$\{uc \? '\$' \+ fmt\(uc\) : dash\}<\/td>\s*<td class="num \$\{rucCls\}"/.test(bodyRow), bodyRow.replace(/\s+/g, ' '));
  assert('the running rate is printed as money, blank when there is none',
    /<td class="num \$\{rucCls\}">\$\{runUC \? '\$' \+ fmt\(runUC\) : dash\}<\/td>/.test(bodyRow), bodyRow.replace(/\s+/g, ' '));

  // ── Group headers span the full width ──────────────────────────────
  for (const m of js.matchAll(/<tr class="group-hdr"><td colspan="(\d+)"/g)) {
    assert(`group header spans all ${COLS} columns`, +m[1] === COLS, `colspan ${m[1]}`);
  }
  assert('the empty-table row spans all columns',
    new RegExp(`<tr><td colspan="${COLS}"[^>]*>No bid items on this project\\.`).test(js));

  // ── Subtotals and totals: label colspan + trailing cells = width ───
  // The label runs through both unit-cost columns — a cost code mixes
  // units, so there is no per-unit figure to total.
  const rows = [
    ['cost-code subtotal', slice(js, '<tr class="subtotal">', '</tr>`;')],
    ['unmatched subtotal', slice(js, '<tr class="subtotal">', '</tr>`;', js.indexOf('Unmatched Job Rows'))],
    ['project totals',     slice(js, '<tr class="totals">', '</tr></tbody>', js.indexOf('<tbody>${bidRowsHTML}'))],
  ];
  for (const [label, row] of rows) {
    const span  = +(row.match(/colspan="(\d+)"/) || [0, 0])[1];
    const trail = count(row, /<td[ >]/g) - (span ? 1 : 0);
    assert(`${label} covers all ${COLS} columns`, !!row && span + trail === COLS,
      `colspan ${span} + ${trail} cells`);
    assert(`${label} keeps Bid / Actual / Variance in the last three columns`, trail === 3, `${trail} trailing`);
  }

  // ── The reader is told what the columns are ────────────────────────
  assert('the report explains both rates under the table',
    /Bid Unit Cost is the rate the sub code was bid at/.test(js) &&
    /Running Unit Cost is actual cost &divide; running quantity/.test(js));
  assert('the note\'s colour words are styled — td.under alone would not reach them',
    /td\.under, \.note \.under \{/.test(js) && /td\.over,\s+\.note \.over\s+\{/.test(js));
}

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL — run the real expressions.
// ─────────────────────────────────────────────────────────────────────
console.log('\n[behavioural — the rate and its colour]');

const pav   = jobSummary(fs.readFileSync(path.resolve(__dirname, '../paving.html'), 'utf8'));
const lines = slice(pav, 'const runUC  =', "const rucCls = (runUC && uc) ? (runUC <= uc ? 'under' : 'over') : '';");
assert('lifted the Running Unit Cost expressions out of the report', !!lines, lines);
const runningUC = new Function('rqty', 'actual', 'uc', `${lines}\nreturn { runUC, rucCls };`);

const cases = [
  // label,                          rqty,  actual,     uc,    runUC,   rucCls
  ['rate is actual ÷ running qty',   5070,  10010.50,  1.50,  1.974457, 'over'],
  ['at the bid rate reads green',     100,    150,      1.50,  1.5,      'under'],
  ['under the bid rate reads green',  100,    120,      1.50,  1.2,      'under'],
  ['over the bid rate reads red',     100,    200,      1.50,  2,        'over'],
  ['no running qty prints blank',       0,   6281.20,   1.50,  0,        ''],
  ['no cost yet prints blank',       6670,      0,      1.50,  0,        ''],
  ['un-bid work has no rate to beat', 6050,  6050.02,   0,     1.0000033, ''],
];
for (const [label, rqty, actual, uc, wantUC, wantCls] of cases) {
  const got = runningUC(rqty, actual, uc);
  assert(label, Math.abs(got.runUC - wantUC) < 1e-6 && got.rucCls === wantCls,
    `runUC ${got.runUC} / class "${got.rucCls}"`);
}

// A negative running quantity (a correction backing work out) must not print
// a nonsense negative rate — the guard is `rqty > 0`, not `rqty`.
assert('a negative running quantity prints blank', runningUC(-40, 900, 1.5).runUC === 0);

// The report's rate has to be the one the Bid Items page and the bid PDF
// already show, or the two reports disagree about the same job.
console.log('\n[consistency — same rate as the bid report]');
for (const app of APPS) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', app), 'utf8');
  assert(`${app}: the bid PDF's running unit cost is still actual ÷ running qty`,
    /const ruc\s+= rqty > 0 && actual \? '\$' \+ fmt\(actual \/ rqty\) : dash;/.test(src));
  assert(`${app}: the job summary computes the same rate`,
    /const runUC\s+= rqty > 0 && actual \? actual \/ rqty : 0;/.test(jobSummary(src)));
}

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
