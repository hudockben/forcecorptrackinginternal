#!/usr/bin/env node
'use strict';
/**
 * Tests for the Schedules toolbar project picker.
 *
 * Run: node scripts/test-sched-project-picker.js
 *
 * The Project filter used to be a native <select>, which on a book of a
 * hundred jobs meant scrolling for the one you wanted. It is now the shared
 * typeahead combobox — the same one the bid, PO and trucking tables use — so
 * it can be searched by name or by job number.
 *
 * The catch is that #sched-proj-select is read all over the schedules code
 * (PM report, PDF export, Gantt, AI insights) and written directly by the
 * pacing cards. So the select stays as the source of truth, hidden behind the
 * combobox, and the picker's whole job is keeping the two in step. Both halves
 * are checked here:
 *   1. Structural — the combobox is mounted, the select survives as the
 *      hidden source of truth, and its readers/writers were left alone.
 *   2. Behavioural — the option list and the commit resolution run inside a
 *      sandboxed vm against a synthetic project book.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// The schedules tab ships in all three division pages. With no argument this
// re-runs itself once per file so each one is checked independently.
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

// ─────────────────────────────────────────────────────────────────────
// 1) STRUCTURAL
// ─────────────────────────────────────────────────────────────────────
console.log(`\n[structural — wiring (${TARGET})]`);

assert('the toolbar carries a mount point for the combobox',
  /<span id="sched-proj-cb-mount"><\/span>/.test(src));
assert('the select is still there as the source of truth, hidden',
  /<select id="sched-proj-select" onchange="renderScheduleTab\(\)" style="display:none">/.test(src));
assert('  and still starts on All Projects',
  /<select id="sched-proj-select"[^>]*>\s*<option value="">All Projects<\/option>/.test(src));
// A visible <select> alongside the combobox would be two controls fighting
// over one value.
assert('  and no second visible project select was left behind',
  (src.match(/id="sched-proj-select"/g) || []).length === 1);

assert('the picker is the shared combobox, not a bespoke one',
  /mount\.innerHTML = cbHtml\('sched_projects', '', 'Search projects…', 'onchange="schedProjPick\(this\)"'\)/.test(src));
// Passthrough is what turns a commit into the synthetic change event that
// fires the inline onchange; without it the picker is a dead text box.
assert('  and commits through passthrough mode',
  /const passFlag  = passthroughAttrs \? ' data-passthrough="1"' : '';/.test(src)
  && /if \(cb\.dataset\.passthrough === '1'\)/.test(src));
assert('cbOptionsFor serves the sched_projects list',
  /if \(listKey === 'sched_projects'\) \{/.test(src));
assert('renderScheduleTab keeps the picker in step with the select',
  /sel\.value = currentVal;\s*\n\s*syncSchedProjInput\(\);/.test(src));

// _schedProjLabel is hoisted on purpose: cbOptionsFor calls it from ~20k lines
// above the picker block, which a `const` arrow would put in the temporal dead
// zone if anything ever asked for the list during script evaluation.
for (const fn of ['syncSchedProjInput', 'schedProjPick', '_schedProjLabel']) {
  assert(`defines ${fn}`, new RegExp(`function ${fn}\\s*\\(`).test(src));
}

console.log('\n[structural — everything that reads the select still can]');
// These all read #sched-proj-select.value. Hiding the select rather than
// replacing it is the whole reason they needed no changes — if one of them
// ever moves off the select, this is the list to revisit.
for (const fn of ['openDailyPMReport', 'printSchedulePDF', 'openGanttModal', 'printGanttPDF', 'runSchedAI']) {
  const body = src.match(new RegExp(`function ${fn}\\([\\s\\S]{0,400}`));
  assert(`${fn} still reads the select`,
    !!body && /getElementById\('sched-proj-select'\)/.test(body[0]));
}
assert('the pacing cards still drive it by setting the value',
  /onclick="document\.getElementById\('sched-proj-select'\)\.value='\$\{proj\.id\}';renderScheduleTab\(\)"/.test(src));

console.log('\n[structural — shared combobox stayed compatible]');
// Every other list keeps the plain substring filter it has always had.
const filterFn = src.match(/function cbFilterFor\([\s\S]+?\n\}\n/);
assert('cbFilterFor falls back to the original substring match',
  !!filterFn && /return q \? options\.filter\(o => _cbLabel\(o\)\.toLowerCase\(\)\.includes\(q\)\) : options/.test(filterFn[0]));
assert('  and the job-number match is scoped to sched_projects',
  !!filterFn && /if \(listKey === 'sched_projects'\)/.test(filterFn[0]));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL
// ─────────────────────────────────────────────────────────────────────
function block(startLabel, endLabels) {
  const a = src.indexOf(startLabel);
  if (a < 0) throw new Error(`block: missing start ${startLabel}`);
  const ends = [].concat(endLabels).map(e => src.indexOf(e, a)).filter(i => i > 0);
  if (!ends.length) throw new Error(`block: missing end for ${startLabel}`);
  return src.slice(a, Math.min(...ends));
}

// Minimal stand-ins for the two DOM nodes the picker touches.
const select = { value: '' };
const input  = { value: '', dataset: {} };
const mount  = {
  firstElementChild: null,
  set innerHTML(_html) { this.firstElementChild = { tag: 'cb' }; },
  querySelector() { return this.firstElementChild ? input : null; },
};
let renders = 0;

const sandbox = {
  projectsList: [],
  document: {
    activeElement: null,
    getElementById(id) {
      if (id === 'sched-proj-cb-mount') return mount;
      if (id === 'sched-proj-select') return select;
      return null;
    },
  },
  cbHtml: () => '<div class="cb" data-list="sched_projects"></div>',
  renderScheduleTab: () => { renders++; },
  _cbLabel: o => (typeof o === 'string' ? o : o.label),
};
vm.createContext(sandbox);
vm.runInContext(block('function cbOptionsFor(', ['const _cbLabel = o =>']), sandbox);
vm.runInContext(block('function cbFilterFor(', ['function cbOnFocus(']), sandbox);
vm.runInContext(block('/* ── Schedules project picker', ['async function renderScheduleTab(']), sandbox);
const { cbOptionsFor, cbFilterFor, syncSchedProjInput, schedProjPick } = sandbox;

sandbox.projectsList.push(
  { id: 'p1', 'project-name': 'Tuffy Shellenbarger', 'job-number': '26081' },
  { id: 'p2', 'project-name': 'Penns Manor Groom',   'job-number': '26084' },
  { id: 'p3', 'project-name': 'Hempfield Founders Park' },
  { id: 'p4', 'job-number': '26090' },                     // unnamed job
);

console.log('\n[behavioural — the option list]');
const opts = cbOptionsFor('sched_projects');
assert('All Projects leads the list and clears the filter',
  opts[0].value === '' && opts[0].label === 'All Projects');
assert('every project is offered', opts.length === 5, String(opts.length));
assert('projects are sorted by the label they show',
  opts.slice(1).map(o => o.label).join(' | ') ===
  '26090 | Hempfield Founders Park | Penns Manor Groom | Tuffy Shellenbarger',
  opts.slice(1).map(o => o.label).join(' | '));
assert('an unnamed job falls back to its job number',
  opts.find(o => o.value === 'p4').label === '26090');
assert('the job number rides along as the note',
  opts.find(o => o.value === 'p2').meta === 'Job #26084');
assert('a project with no job number has no note',
  opts.find(o => o.value === 'p3').meta === '');

console.log('\n[behavioural — searching]');
const labels = q => cbFilterFor('sched_projects', q, opts).map(o => o.label);
assert('an empty query offers everything', labels('').length === opts.length);
assert('matches on name, anywhere in it', labels('manor').join() === 'Penns Manor Groom', labels('manor').join());
// Searching a job by its number is the whole reason the note is in the filter.
assert('matches on job number', labels('26081').join() === 'Tuffy Shellenbarger', labels('26081').join());
assert('a partial job number still narrows', labels('2608').length === 2, labels('2608').join());
assert('nothing matches nonsense', labels('zzz').length === 0);
assert('All Projects can be searched back to', labels('all pro').join() === 'All Projects', labels('all pro').join());
assert('  and drops out of a query it does not match', !labels('manor').includes('All Projects'));
// Other lists must not pick up the note-aware filter.
assert('plain lists keep the plain substring match',
  cbFilterFor('employees', 'sm', ['Smith', 'Jones']).join() === 'Smith');

console.log('\n[behavioural — mounting and syncing]');
syncSchedProjInput();
assert('mounts the combobox on first call', mount.firstElementChild !== null);
assert('  showing All Projects when nothing is filtered', input.value === 'All Projects');
select.value = 'p2';
syncSchedProjInput();
assert('follows the select when a pacing card sets it', input.value === 'Penns Manor Groom');
assert('  and carries the id alongside the label', input.dataset.cbValue === 'p2');
// A re-render mid-search would otherwise wipe what the user is typing.
sandbox.document.activeElement = input;
input.value = 'Hemp';
syncSchedProjInput();
assert('never overwrites a search in progress', input.value === 'Hemp');
sandbox.document.activeElement = null;

console.log('\n[behavioural — committing a pick]');
renders = 0;
input.value = 'Hempfield Founders Park';
input.dataset.cbValue = 'p3';
schedProjPick(input);
assert('a picked project lands on the select', select.value === 'p3');
assert('  and re-renders the tab once', renders === 1, String(renders));

// Typed-and-Enter'd text with no id attached still has to resolve.
renders = 0;
input.value = 'tuffy shellenbarger';
delete input.dataset.cbValue;
schedProjPick(input);
assert('a typed name resolves by label, case-insensitively', select.value === 'p1');
assert('  and the box is normalised to the real label', input.value === 'Tuffy Shellenbarger');

// A bare focus/blur commits too — it must not count as a change.
renders = 0;
schedProjPick(input);
assert('re-committing the same project changes nothing', select.value === 'p1' && renders === 0);

renders = 0;
input.value = '';
delete input.dataset.cbValue;
schedProjPick(input);
assert('clearing the box goes back to All Projects', select.value === '' && input.value === 'All Projects');
assert('  and re-renders', renders === 1, String(renders));

// The old <select> could not be left in a state that matched no project.
renders = 0;
select.value = 'p2';
input.value = 'not a real job';
delete input.dataset.cbValue;
schedProjPick(input);
assert('text matching nothing puts the current project back',
  select.value === 'p2' && input.value === 'Penns Manor Groom' && renders === 0,
  `${select.value} / ${input.value} / ${renders}`);

// A stale id (project deleted between render and commit) must not stick.
renders = 0;
select.value = '';
input.value = 'Penns Manor Groom';
input.dataset.cbValue = 'gone';
schedProjPick(input);
assert('a stale id falls back to the typed label', select.value === 'p2', select.value);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
