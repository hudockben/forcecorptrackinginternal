#!/usr/bin/env node
'use strict';
/**
 * Tests for the Cost Tracking table's per-job averages.
 *
 * Run: node scripts/test-cost-averages.js          (all three division pages)
 *      node scripts/test-cost-averages.js paving.html
 *
 * The table rolls up by sub code across every project, and each sub code row
 * expands into one row per job. Avg Qty and Days Worked on the parent are
 * per-job AVERAGES, so the parent is exactly the mean of the figures the
 * expanded rows show — the number you want when sizing the next job.
 *
 * Both used to be company-wide aggregates that no job would recognise:
 *   Days Worked  was the count of distinct dates across all jobs at once, so
 *                two jobs working the same day counted once and the figure
 *                grew with the number of jobs rather than describing any of them.
 *   Avg Qty      was an average per DAILY ENTRY (tracker summed those per-job
 *                averages, which is not a quantity at all), so jobs logging in
 *                bigger or smaller chunks moved it for no real reason.
 *
 * Worked example, three jobs on one sub code — 300 units over 3 days,
 * 900 over 5 days, 600 over 1 day:
 *   parent Avg Qty      600.00   (mean of 300/900/600)   — was 200 (1800÷9 entries)
 *   parent Days Worked     3.0   (mean of 3/5/1)         — was 9 (all distinct dates)
 */

const fs   = require('fs');
const path = require('path');

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const TARGET = process.argv[2];
if (!TARGET) {
  const { spawnSync } = require('child_process');
  let bad = 0;
  for (const f of FILES) {
    console.log(`\n══════════ ${f} ══════════`);
    if (spawnSync(process.execPath, [__filename, f], { stdio: 'inherit' }).status !== 0) bad++;
  }
  console.log(bad ? `\n${bad} file(s) FAILED` : `\nall ${FILES.length} division pages pass`);
  process.exit(bad ? 1 : 0);
}

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '..', TARGET), 'utf8');
// The sub code header row and the per-job rows both live in renderCostTable.
const render = src.slice(src.indexOf('function renderCostTable('), src.indexOf('function exportCostCSV('));
if (!render) throw new Error('renderCostTable not found');

console.log(`\n[parent row — per-job averages (${TARGET})]`);
assert('the job count comes from the per-project entries',
  /const jobCount = (projEntries|_projKeys)\.length;/.test(render));
assert('Avg Qty averages each job\'s actual quantity',
  /const avg_qty {2}= jobCount\s*\n\s*\? (projEntries|_projKeys)\.reduce\(\(s, pk\) => s \+ scProjAgg\[pk\]\.running_qty, 0\) \/ jobCount/.test(render));
assert('Days Worked averages each job\'s own day count',
  /const avgDays {2}= jobCount\s*\n\s*\? (projEntries|_projKeys)\.reduce\(\(s, pk\) => s \+ scProjAgg\[pk\]\.dates\.size, 0\) \/ jobCount/.test(render));
assert('  neither divides by the daily-entry count any more',
  !/const avg_qty {2}= a\.qty_count \? rqty \/ a\.qty_count/.test(render));
assert('  and Days Worked is no longer the cross-job distinct-date count',
  !/const days {5}= a\.dates\.size;/.test(render));
assert('the averaged day count is rendered, not the raw total',
  /\$\{fmt\(avgDays,1\)\}<\/td>/.test(render) && !/<td class="calc">\$\{days\}<\/td>/.test(render));

console.log('\n[the distinct-date total is still used where it belongs]');
// Avg Laborers falls back to hours ÷ days ÷ 8. That has to stay the real number
// of days worked across the roll-up; feeding it a per-job average would inflate
// the implied crew size.
assert('daysAll keeps the cross-job distinct-date count', /const daysAll {2}= a\.dates\.size;/.test(render));
assert('Avg Laborers still divides by daysAll, not the average',
  /a\.labor_hours \/ daysAll \/ 8/.test(render) && !/a\.labor_hours \/ avgDays \/ 8/.test(render));

console.log('\n[child rows — each job\'s own figures]');
assert('a job row shows the quantity logged on that job',
  /const p_rqty {4}= pa\.running_qty;/.test(render)
  && /<td class="calc" title="Quantity logged on this job">\$\{fmt\(p_rqty,2\)\}<\/td>/.test(render));
assert('  the per-entry average is gone', !/p_avg_qty/.test(render));
assert('a job row still shows its own day count',
  /const p_days {4}= pa\.dates\.size;/.test(render) && /<td class="calc">\$\{p_days\}<\/td>/.test(render));

console.log('\n[the parent explains itself]');
assert('Avg Qty carries a tooltip naming the job count',
  /Average quantity per job across \$\{jobCount\}/.test(render));
assert('Days Worked carries a tooltip naming the job count',
  /Average days worked per job across \$\{jobCount\}/.test(render));
assert('the legend says both are per-job averages',
  /Avg Qty and Days Worked on a sub code row are <strong>per-job averages<\/strong>/.test(src));

console.log('\n[nothing else was rewired]');
assert('Production Rate is still cost ÷ quantity',
  /const past_avg = rqty \? rtotal \/ rqty : 0;/.test(render));
assert('Running Total is still the summed cost', /const rtotal {3}= a\.total_cost;/.test(render));
assert('Bid Qty is still summed across jobs',
  /scBidMap\[sc\]\.qty {3}\+= bq;/.test(src));
assert('the Scale of Economy hand-off still gets the real running quantity',
  /_soeSendFromCT\(this,'','\$\{esc\(sc\)\}',\$\{rqty\}/.test(render));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
