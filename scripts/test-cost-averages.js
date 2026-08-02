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
assert('Actual Unit Cost is still cost ÷ quantity',
  /const past_avg = rqty \? rtotal \/ rqty : 0;/.test(render));
// rtotal no longer has a column of its own but still feeds the unit cost and
// the Scale of Economy hand-off.
assert('the summed cost is still computed', /const rtotal {3}= a\.total_cost;/.test(render));
assert('Bid Qty is still summed across jobs',
  /scBidMap\[sc\]\.qty {3}\+= bq;/.test(src));
assert('the Scale of Economy hand-off still gets the real running quantity',
  /_soeSendFromCT\(this,'','\$\{esc\(sc\)\}',\$\{rqty\}/.test(render));

console.log('\n[the table is 15 columns wide, everywhere]');
// Removing Running Total shifted every band and the empty-state row; a stale
// colspan leaves a ragged table the moment there is nothing to show.
const thead = src.slice(src.indexOf('<table id="tracker">'), src.indexOf('<tbody id="cost-tbody">'));
const bands = [...thead.matchAll(/colspan="(\d+)"/g)].map(m => +m[1]);
assert('the group bands add up to 15', bands.reduce((a, c) => a + c, 0) === 15, bands.join('+'));
assert('  Company Actuals is down to three columns', /class="g-sum" +colspan="3"/.test(thead), bands.join('+'));
assert('there are 15 column headers',
  (thead.slice(thead.indexOf('<tr class="col-row">')).match(/<th/g) || []).length === 15);
assert('Actual Unit Cost replaced Production Rate',
  /<th class="calc-hdr">Actual Unit Cost<\/th>/.test(thead)
  && !/Production Rate/.test(thead) && !/Running Total/.test(thead));
assert('the empty-state row spans 15, not the old 16',
  /<td colspan="15">No bid items found\./.test(src));
assert('the legend explains the renamed column',
  /Actual Unit Cost = Total Cost \u00f7 quantity logged/.test(src) || /Actual Unit Cost = Total Cost ÷ quantity logged/.test(src));

console.log('\n[Export CSV emits what the table drew]');
// The export used to recompute from a different source (buildDailyAgg + costRows,
// keyed per cost code + sub code, ignoring the filter bar) and pushed 20 values
// under 18 headers — so from "Cum Labor Hrs" rightward every number sat under the
// wrong heading, with projected cost appearing as "Days Worked" and two columns
// spilling past the header row entirely. It now emits the rendered rows.
const exportFn = src.match(/function exportCostCSV\(\)[\s\S]+?\n\}\n/);
assert('renderCostTable resets the export rows', /_ctExportRows = \[\];/.test(render));
assert('  and captures the company row', /_ctExportRows\.push\(\{\s*\n\s*sub_code: sc, job: 'All jobs',/.test(render));
assert('  and one row per job', /_ctExportRows\.push\(\{\s*\n\s*sub_code: sc, job: pa\.project,/.test(render));
assert('the export reads those rows', !!exportFn && /_ctExportRows\.forEach\(/.test(exportFn[0]));
assert('  and no longer recomputes from its own source',
  !!exportFn && !/buildDailyAgg\(\)/.test(exportFn[0]) && !/costRows/.test(exportFn[0]));
assert('  rendering first if the tab has not drawn yet',
  !!exportFn && /if \(!_ctExportRows\.length\) renderCostTable\(\);/.test(exportFn[0]));

// The alignment bug itself: headers and values must be the same length.
if (exportFn) {
  const heads = (exportFn[0].match(/const headers = \[([\s\S]+?)\];/) || [, ''])[1]
    .split(',').map(s => s.trim()).filter(Boolean);
  const push = (exportFn[0].match(/rows\.push\(\[([\s\S]+?)\]\.map\(/) || [, ''])[1];
  let depth = 0, cur = '', vals = [];
  for (const ch of push) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) vals.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) vals.push(cur.trim());
  assert(`every header has exactly one value under it (${heads.length} headers, ${vals.length} values)`,
    heads.length === vals.length && heads.length === 16,
    `${heads.length} vs ${vals.length}`);
  assert('  the columns are the table\'s own, plus a Job column',
    heads[0] === "'Sub Code'" && heads[1] === "'Job'"
    && heads.includes("'Avg Qty'") && heads.includes("'Days Worked'")
    && heads.includes("'Actual Unit Cost'") && heads.includes("'MU / Equip Hr'")
    && !heads.includes("'Running Total'") && !heads.includes("'Production Rate'"),
    heads.join(' '));
  // Order matters: a value under the wrong header is the bug being guarded.
  const order = ['sub_code','job','bid_qty','bid_unit_cost','bid_total','avg_qty',
    'actual_unit_cost','total_cost','labor_hours','days','avg_laborers','mu_labor',
    'equip_total','equip_hours','equip_cost_hr','mu_equip'];
  assert('  and each value sits under its own header',
    order.every((k, i) => new RegExp(`r\\.${k}\\b`).test(vals[i] || '')),
    order.map((k, i) => (new RegExp(`r\\.${k}\\b`).test(vals[i] || '') ? '' : `${i}:${k}`)).filter(Boolean).join(' '));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
