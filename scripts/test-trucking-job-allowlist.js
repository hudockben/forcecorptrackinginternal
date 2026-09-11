#!/usr/bin/env node
'use strict';
/**
 * The trucking Job picker's allow list.
 *
 * Run: node scripts/test-trucking-job-allowlist.js
 *
 * Under Division = Trucking the Job picker lists the division's whole customer
 * roster (truckingJobs in api/timesheet-jobs.js) — the office's billing list,
 * which is far longer than the handful of customers a driver ever files a day
 * against. TRUCKING_JOB_ALLOWLIST in timesheet.html names the ones the field
 * form offers.
 *
 * Three rules it has to keep, all of them the kind that fail quietly:
 *   1. Only trucking narrows. A list left on the page must never reach turf,
 *      paving, kiewit, dust or quarry, whose jobs are real projects.
 *   2. An empty list offers the whole roster — the behaviour this form had
 *      before the list existed, and what an unconfigured company still gets.
 *   3. A list that answers NOTHING offers the whole roster too. The office
 *      renames customers, and a picker with nothing in it stops the crew
 *      filing the day at all: a wrong customer is caught at approval, a
 *      missing day is caught on payday.
 *
 * Runs timesheet.html's own jobsForPicker in a vm, once per allow list, by
 * re-evaluating the function against a substituted constant — so the rules are
 * tested on the shipped source rather than a copy of it.
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

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'timesheet.html'), 'utf8');

// Everything in this script block is indented four spaces, so the closing
// brace at that indent ends the function.
function grab(signature) {
  const i = SRC.indexOf('function ' + signature);
  if (i < 0) throw new Error(`timesheet.html no longer defines: ${signature}`);
  const end = SRC.indexOf('\n    }\n', i);
  if (end < 0) throw new Error(`could not find the end of: ${signature}`);
  return SRC.slice(i, end + 6);
}

const ALLOWLIST_LINE = (SRC.match(/const TRUCKING_JOB_ALLOWLIST = [^\n]+/) || [])[0];
if (!ALLOWLIST_LINE) throw new Error('timesheet.html no longer defines TRUCKING_JOB_ALLOWLIST');

const PICKER_SRC = grab('jobsForPicker(div, jobs)');

// Build a jobsForPicker bound to the allow list a case wants. Passing `null`
// means "whatever the page ships with", which is how the shipped value itself
// gets exercised.
function pickerWith(names) {
  const warnings = [];
  const sandbox = { console: { warn: m => warnings.push(String(m)) } };
  vm.createContext(sandbox);
  const decl = names === null
    ? ALLOWLIST_LINE
    : `const TRUCKING_JOB_ALLOWLIST = ${JSON.stringify(names)};`;
  vm.runInContext(`${decl}\n${PICKER_SRC}\nvar __pick = jobsForPicker;`, sandbox);
  return { pick: sandbox.__pick, warnings };
}

const jobs = names => names.map(n => ({ id: n, label: n }));
const labels = list => list.map(j => j.label);

const ROSTER = jobs(['Antero', 'CNX', 'Kinkead', 'Kovalchick', 'Force']);

console.log('\n[only trucking is ever narrowed]');
{
  const { pick } = pickerWith(['Kinkead']);
  for (const div of ['turf', 'paving', 'kiewit', 'dust', 'quarry']) {
    const projects = jobs(['Franklin Regional Multi · 26049', 'Kinkead']);
    assert(`${div} keeps every job`,
      labels(pick(div, projects)).length === 2,
      `got ${JSON.stringify(labels(pick(div, projects)))}`);
  }
  assert('trucking is narrowed to the named customer',
    JSON.stringify(labels(pick('trucking', ROSTER))) === JSON.stringify(['Kinkead']));
}

console.log('\n[an empty list offers the whole roster]');
{
  const { pick, warnings } = pickerWith([]);
  assert('every customer survives',
    labels(pick('trucking', ROSTER)).length === ROSTER.length);
  assert('and it is not treated as a misconfiguration', warnings.length === 0);
}

console.log('\n[matching is forgiving about case and stray spaces]');
{
  const { pick } = pickerWith(['  kinkead ', 'KOVALCHICK']);
  assert('both are found on a roster that spells them differently',
    JSON.stringify(labels(pick('trucking', ROSTER))) === JSON.stringify(['Kinkead', 'Kovalchick']));
}

console.log('\n[a list nothing answers falls back, loudly]');
{
  const { pick, warnings } = pickerWith(['Renamed Co']);
  assert('the picker is never left empty',
    labels(pick('trucking', ROSTER)).length === ROSTER.length);
  assert('and the console says why',
    warnings.some(w => /TRUCKING_JOB_ALLOWLIST/.test(w)), JSON.stringify(warnings));
}

console.log('\n[an empty roster cannot crash the picker]');
{
  const { pick } = pickerWith(['Kinkead']);
  assert('no jobs in, no jobs out', pick('trucking', []).length === 0);
}

console.log('\n[the shipped list]');
{
  const { pick } = pickerWith(null);
  const out = pick('trucking', ROSTER);
  assert('leaves the picker with something in it', out.length > 0);
  assert('and narrows nothing outside trucking',
    pick('turf', ROSTER).length === ROSTER.length);
}

console.log('\n[the filter is actually wired into the job picker]');
{
  assert('onDivisionChange renders through jobsForPicker',
    /const jobs = jobsForPicker\(div, jobsCache\[div\]\);/.test(SRC));
  assert('the cache still holds the server\'s unfiltered answer',
    /jobsCache\[div\] = data\.jobs;/.test(SRC));
  assert('payroll\'s re-assign picker is left alone',
    !/TRUCKING_JOB_ALLOWLIST/.test(
      fs.readFileSync(path.resolve(__dirname, '..', 'payroll.html'), 'utf8')));
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
