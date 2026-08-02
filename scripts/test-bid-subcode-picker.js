#!/usr/bin/env node
'use strict';
/**
 * Tests for the bid line sub code picker in tracker.html.
 *
 * Run: node scripts/test-bid-subcode-picker.js
 *
 * Why this field needs a picker at all: computeSizeAwarePastAvg pools
 * production history on the sub code NAME ALONE — every job carrying that
 * name, regardless of the cost code it was filed under — and it matches the
 * name exactly. So "Turf Installation" and "turf installation" are two
 * separate pots, and a bid line typed with a fresh variant quietly stops
 * sharing history with the work it is actually the same as.
 *
 * Two layers, same shape as the other frontend tests:
 *   1. Structural — the field renders as a combobox wired to the catalog,
 *      the cache is invalidated everywhere a sub code can change, and the
 *      shared combobox changes stayed backwards-compatible.
 *   2. Behavioural — the catalog, ranking and canonicalisation run inside a
 *      sandboxed vm against a synthetic book of past jobs.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '../tracker.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// 1) STRUCTURAL
// ─────────────────────────────────────────────────────────────────────
console.log('\n[structural — wiring]');

assert('sub code cell renders a combobox',
  /cbHtml\(`bid_subcodes:\$\{projId\}:\$\{b\.id\}`, b\.sub_code, 'Sub code'/.test(src));
assert('  commits through _bidSubCodeCommit',
  /onchange="_bidSubCodeCommit\(this,'\$\{projId\}','\$\{b\.id\}'\)"/.test(src));
assert('  seeds data-cb-value so an untouched focus/blur is not an edit',
  /\$\{b\.sub_code \? ` data-cb-value="\$\{esc\(b\.sub_code\)\}"` : ''\}/.test(src));
assert('  uses a fixed-position menu (the bid table is a scroll pane)',
  /bid_subcodes[\s\S]{0,400}data-cb-fixed="1"/.test(src));
assert('cbOptionsFor serves the bid_subcodes list',
  /listKey\.startsWith\('bid_subcodes:'\)\) return _bidSubCodeOptions\(listKey\)/.test(src));
assert('the readonly bid table stays plain text',
  /childTr\.innerHTML = readonly\s*\n\s*\? `<td[^`]*\$\{esc\(b\.sub_code\)/.test(src));

for (const fn of ['_bidScNorm', '_bidSubCodeStats', '_bidSubCodeCanonical', '_bidScStatsFor',
                  '_bidScMeta', '_bidSubCodeOptions', '_bidSubCodeFilter', '_bidSubCodeCommit',
                  '_bidScInvalidate', 'cbFilterFor']) {
  assert(`defines ${fn}`, new RegExp(`function ${fn}\\s*\\(`).test(src));
}

console.log('\n[structural — shared combobox stayed compatible]');
// Other lists (suppliers, employees, PO sub codes…) must keep the plain
// substring filter and the plain-text option rows they have always had.
const filterFn = src.match(/function cbFilterFor\([\s\S]+?\n\}\n/);
assert('cbFilterFor falls back to the original substring match',
  !!filterFn && /return q \? options\.filter\(o => _cbLabel\(o\)\.toLowerCase\(\)\.includes\(q\)\) : options/.test(filterFn[0]));
assert('  and only diverts the bid_subcodes list',
  !!filterFn && /startsWith\('bid_subcodes'\)/.test(filterFn[0]));
const renderFn = src.match(/function cbRenderMenu\([\s\S]+?\n\}\n/);
assert('option rows stay plain text when no note is present',
  !!renderFn && /: _cbEsc\(_cbLabel\(opt\)\)\)/.test(renderFn[0]));
assert('data-val never carries the note (it becomes the input value)',
  !!renderFn && /data-val="\$\{_cbEsc\(_cbLabel\(opt\)\)\}"/.test(renderFn[0]));

console.log('\n[structural — catalog cache invalidation]');
// The cache key is built from row counts, which do not change when a sub code
// is merely renamed — so every rename path has to bump the epoch.
assert('cache key includes the epoch', /\+ '\|' \+ projectsList\.length \+ '\|' \+ _bidScEpoch/.test(src));
const commitFn = src.match(/function _bidSubCodeCommit\([\s\S]+?\n\}\n/);
assert('renaming a bid sub code invalidates', !!commitFn && /_bidScInvalidate\(\)/.test(commitFn[0]));
assert('editing a daily row sub code invalidates',
  /p\.dailyRows\[i\]\[f\] = el\.value;\s*\n\s*if \(f === 'sub_code'\) _bidScInvalidate\(\)/.test(src));
assert('a Procore import invalidates',
  /function commitProcoreImport\([\s\S]+?_bidScInvalidate\(\)/.test(src));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL
// ─────────────────────────────────────────────────────────────────────
function block(startLabel, endLabel) {
  const a = src.indexOf(startLabel);
  const b = src.indexOf(endLabel, a);
  if (a < 0 || b < 0) throw new Error(`block: missing ${startLabel} / ${endLabel}`);
  return src.slice(a, b);
}

const sandbox = {
  projectsList: [],
  getProj(id) { return sandbox.projectsList.find(p => p.id === id); },
  fmt(n, d = 2) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); },
  _cbLabel: o => (typeof o === 'string' ? o : o.label),
};
vm.createContext(sandbox);
vm.runInContext(block('// Matching key: what counts as', '// Off-bid daily costs for a project'), sandbox);
vm.runInContext(block('function cbFilterFor(', 'function cbOnFocus('), sandbox);
const { _bidScNorm, _bidSubCodeStats, _bidSubCodeCanonical, _bidSubCodeOptions, _bidSubCodeFilter, cbFilterFor } = sandbox;

// Two past jobs that ran the same work under different cost codes, one
// bid-only job, and the job being estimated now.
sandbox.projectsList.push(
  { id: 'old1', bidItems: [{ id: 'a', cost_code: 'Playing Field', sub_code: 'Turf Installation' }],
    dailyRows: [{ sub_code: 'Turf Installation', labor_hours: 40 }, { sub_code: 'Turf Installation', labor_hours: 40 }] },
  { id: 'old2', bidItems: [{ id: 'b', cost_code: 'Field Construction', sub_code: 'Turf Installation' }],
    dailyRows: [{ sub_code: 'Turf Installation', labor_hours: 30 }] },
  { id: 'old3', bidItems: [{ id: 'c', cost_code: 'Base', sub_code: 'Fine Grading' }], dailyRows: [] },
  { id: 'cur',  bidItems: [{ id: 'x', cost_code: 'Playing Field', sub_code: '' },
                           { id: 'y', cost_code: 'Playing Field', sub_code: 'Turf Logo' }], dailyRows: [] },
);

console.log('\n[behavioural — the catalog]');
const cat = _bidSubCodeStats();
assert('collects every name in use', cat.byNorm.size === 3, [...cat.byNorm.keys()].join(' | '));
assert('pools one name across different cost codes',
  cat.byNorm.get('turf installation').jobs.size === 2);
assert('sums logged hours across jobs',
  cat.byNorm.get('turf installation').hours === 110, String(cat.byNorm.get('turf installation').hours));
assert('blank sub codes are not catalogued', !cat.byNorm.has(''));

console.log('\n[behavioural — history counts exclude the job being bid]');
// computeSizeAwarePastAvg excludes the current project from its benchmark, so
// the note has to as well — otherwise a name that exists only on this job
// reads as though it had precedent.
const opts = _bidSubCodeOptions('bid_subcodes:cur:x');
const byName = Object.fromEntries(opts.map(o => [o.label, o.meta]));
console.log('    ' + opts.map(o => `${o.label} → ${o.meta}`).join('\n    '));
assert('established name shows its past jobs and hours',
  /2 past jobs/.test(byName['Turf Installation']) && /110 hrs logged/.test(byName['Turf Installation']),
  byName['Turf Installation']);
assert('bid-only name says so', /1 past job · bid only/.test(byName['Fine Grading']), byName['Fine Grading']);
assert('name only on this job claims no history',
  /already on this job/.test(byName['Turf Logo']) && /no history yet/.test(byName['Turf Logo']),
  byName['Turf Logo']);
assert('best-established name ranks first', opts[0].label === 'Turf Installation', opts[0].label);
assert('a name already on this job sinks below the ones with history',
  opts.findIndex(o => o.label === 'Turf Logo') === opts.length - 1);
// Editing the line that already holds the name must not accuse it of itself.
assert('editing a line does not flag its own name as a duplicate',
  !/already on this job/.test(Object.fromEntries(
    _bidSubCodeOptions('bid_subcodes:cur:y').map(o => [o.label, o.meta]))['Turf Logo']));

console.log('\n[behavioural — ranking and the create-new row]');
const q1 = _bidSubCodeFilter('bid_subcodes:cur:x', 'turf', opts);
assert('offers the typed text as a new sub code',
  q1[0].label === 'turf' && /new sub code/.test(q1[0].meta), JSON.stringify(q1[0]));
assert('  marked as a create, not a match', q1[0].metaCls === 'new');
assert('existing matches follow', q1.some(o => o.label === 'Turf Installation'));
assert('non-matches are filtered out', !q1.some(o => o.label === 'Fine Grading'));
assert('prefix matches outrank mid-string ones', (() => {
  const r = _bidSubCodeFilter('bid_subcodes:cur:x', 'grading', opts);
  return r.filter(o => !/new sub code/.test(o.meta || ''))[0].label === 'Fine Grading';
})());
assert('empty query lists everything', _bidSubCodeFilter('bid_subcodes:cur:x', '  ', opts).length === opts.length);

console.log('\n[behavioural — near misses]');
// A spelling that differs in case or internal spacing would start its own pot,
// so it gets the existing name offered first, flagged.
for (const variant of ['turf installation', 'TURF INSTALLATION', 'Turf  Installation']) {
  const r = _bidSubCodeFilter('bid_subcodes:cur:x', variant, opts);
  assert(`${JSON.stringify(variant)} offers the existing spelling first, flagged`,
    r[0].label === 'Turf Installation' && /existing spelling/.test(r[0].meta), JSON.stringify(r[0] && r[0].meta));
  assert('  and does not offer to create it fresh', !r.some(o => /new sub code/.test(o.meta || '')));
}
// Surrounding whitespace is trimmed on the way in, so it resolves to the same
// string with nothing to warn about — it must not nag.
for (const same of ['Turf Installation', '  Turf Installation  ']) {
  const r = _bidSubCodeFilter('bid_subcodes:cur:x', same, opts);
  assert(`${JSON.stringify(same)} matches cleanly, no warning`,
    r[0].label === 'Turf Installation' && !/existing spelling/.test(r[0].meta), JSON.stringify(r[0] && r[0].meta));
  assert('  and is not offered as a new sub code', !r.some(o => /new sub code/.test(o.meta || '')));
}

console.log('\n[behavioural — canonicalisation]');
assert('snaps a case variant',        _bidSubCodeCanonical('turf installation') === 'Turf Installation');
assert('snaps a spacing variant',     _bidSubCodeCanonical('Turf  Installation') === 'Turf Installation');
assert('trims surrounding space',     _bidSubCodeCanonical('  Turf Installation ') === 'Turf Installation');
assert('leaves a genuinely new name', _bidSubCodeCanonical('Goal Post Footings') === 'Goal Post Footings');
assert('leaves blank blank',          _bidSubCodeCanonical('') === '' && _bidSubCodeCanonical(null) === '');
assert('normalisation key is case/space insensitive',
  _bidScNorm(' Turf   INSTALLATION ') === 'turf installation');

// Canonical spelling = whichever one the data mostly uses, so snapping moves
// the odd line onto the majority rather than the other way round.
sandbox.projectsList.push({ id: 'odd', bidItems: [{ id: 'z', cost_code: 'X', sub_code: 'FLAT DRAIN' }],
  dailyRows: [{ sub_code: 'Flat Drain', labor_hours: 5 }, { sub_code: 'Flat Drain', labor_hours: 5 }] });
sandbox._bidScInvalidate();
assert('canonical spelling is the majority one', _bidSubCodeCanonical('flat drain') === 'Flat Drain');
assert('a name with rival spellings says so',
  /2 spellings in use/.test(Object.fromEntries(
    _bidSubCodeOptions('bid_subcodes:cur:x').map(o => [o.label, o.meta]))['Flat Drain']));

console.log('\n[behavioural — the cache]');
const before = _bidSubCodeStats();
assert('repeat calls reuse the cached catalog', _bidSubCodeStats() === before);
// A rename changes no row count, so only the epoch can catch it.
sandbox.projectsList[3].bidItems[1].sub_code = 'Renamed Thing';
assert('a rename alone does NOT bust a count-only key', _bidSubCodeStats() === before);
sandbox._bidScInvalidate();
assert('invalidating picks the rename up',
  _bidSubCodeStats() !== before && _bidSubCodeStats().byNorm.has('renamed thing'));

console.log('\n[behavioural — other lists are unaffected]');
assert('plain lists keep substring filtering',
  JSON.stringify(cbFilterFor('suppliers', 'o', ['box', 'axe', 'cot'])) === JSON.stringify(['box', 'cot']));
assert('plain lists keep every option on an empty query',
  cbFilterFor('employees', '', ['a', 'b']).length === 2);
assert('object lists filter on the label',
  cbFilterFor('projects', 'ri', [{ value: '1', label: 'Riverside' }, { value: '2', label: 'Oakmont' }]).length === 1);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
