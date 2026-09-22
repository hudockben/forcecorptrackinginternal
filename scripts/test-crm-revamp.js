#!/usr/bin/env node
'use strict';
/**
 * Tests for the revamped turf CRM.
 *
 * Run: node scripts/test-crm-revamp.js
 *
 * Four things are worth pinning down, because each one is a place where being
 * quietly wrong looks exactly like being right.
 *
 *   The age buckets. A field's install year decides whether we are selling
 *   grooming or a replacement, and the dashboard counts fields into three
 *   buckets on that basis. An off-by-one at a boundary moves a customer from
 *   one sales conversation to another.
 *
 *   The sort. Every CRM table sorts through one helper, and the trap is that
 *   "Value" and "Win %" are strings in the blob — sorted as text, 9 beats 10.
 *   Blanks are the other half: a row with no close date is not the soonest
 *   close date, and must not lead the list in either direction.
 *
 *   The CSV. Export is what these tables are for, and a cell holding a comma,
 *   a quote, or a leading "=" is the difference between a file that opens and
 *   one that corrupts — or, for "=", one that executes.
 *
 *   The news merge. The overnight pull is allowed to add to and correct the
 *   hub, and not allowed to empty it. A run that finds nothing must leave
 *   yesterday's openers where they are.
 *
 * The first three lift the real functions out of tracker.html and run them,
 * rather than reimplementing the arithmetic here where it could agree with
 * itself and disagree with the page.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'tracker.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in tracker.html`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

function extractConst(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`${name} not found in tracker.html`);
  let depth = 0;
  for (let j = src.indexOf('[', start); j < src.length; j++) {
    if (src[j] === '[') depth++;
    else if (src[j] === ']' && --depth === 0) return src.slice(start, j + 1) + ';';
  }
  throw new Error(`${name} is not closed`);
}

/* ── 1. Age buckets ──────────────────────────────────────────────────────── */
console.log('\nField age buckets');
{
  const code = [
    extractConst(SRC, '_CRM_AGE_BUCKETS'),
    extractFunction(SRC, '_crmFieldAge'),
    extractFunction(SRC, '_crmBucketForAge'),
    'return { _CRM_AGE_BUCKETS, _crmFieldAge, _crmBucketForAge };',
  ].join('\n');
  const { _CRM_AGE_BUCKETS, _crmFieldAge, _crmBucketForAge } = new Function(code)();

  const today = new Date('2026-09-22T00:00:00Z');
  const bucket = year => {
    const b = _crmBucketForAge(_crmFieldAge({ installed_year: year }, today));
    return b ? b.key : null;
  };

  assert('three buckets, in order', _CRM_AGE_BUCKETS.map(b => b.key).join(',') === 'maintenance,both,replacement');

  // 1–3 years → Maintenance. This year counts as maintenance too: a field put
  // down in March is not uncategorised, it is brand new.
  assert('installed this year → maintenance', bucket('2026') === 'maintenance');
  assert('1 year old → maintenance',          bucket('2025') === 'maintenance');
  assert('3 years old → maintenance',         bucket('2023') === 'maintenance');

  // The boundaries are where an off-by-one would live.
  assert('4 years old → maintenance/replacement', bucket('2022') === 'both');
  assert('7 years old → maintenance/replacement', bucket('2019') === 'both');
  assert('8 years old → replacement',             bucket('2018') === 'replacement');
  assert('30 years old → replacement',            bucket('1996') === 'replacement');

  // Nothing usable must read as null rather than as a bucket, so an undated
  // field is reported as undated instead of being counted into maintenance.
  assert('blank year → no bucket',   bucket('')       === null);
  assert('garbage year → no bucket', bucket('soon')   === null);
  assert('absurd year → no bucket',  bucket('1802')   === null);
  assert('a full date still reads',  bucket('2017-06-01') === 'replacement');
}

/* ── 2. Sorting ──────────────────────────────────────────────────────────── */
console.log('\nTable sorting');
{
  const code = [
    'const _crmSort = {};',
    extractFunction(SRC, '_crmCellText'),
    extractFunction(SRC, '_crmSortRows'),
    'return { _crmSort, _crmSortRows };',
  ].join('\n');
  const { _crmSort, _crmSortRows } = new Function(code)();

  const cols = [{ f: 'value' }, { f: 'name' }, { f: 'due' }];
  const rows = [
    { name: 'b', value: '9',      due: '2026-03-01' },
    { name: 'a', value: '10',     due: '' },
    { name: 'c', value: '100000', due: '2026-01-15' },
    { name: 'd', value: '',       due: '2026-02-01' },
  ];

  _crmSort.t = { field: 'value', dir: 'asc' };
  let out = _crmSortRows(rows, 't', cols).map(r => r.value);
  // Sorted as text this would be 10, 100000, 9 — the bug this guards.
  assert('numeric column sorts as numbers', out.join(',') === '9,10,100000,', out.join(','));

  _crmSort.t = { field: 'value', dir: 'desc' };
  out = _crmSortRows(rows, 't', cols).map(r => r.value);
  assert('descending reverses the numbers', out.slice(0, 3).join(',') === '100000,10,9', out.join(','));
  assert('blank stays last descending too', out[3] === '', out.join(','));

  _crmSort.t = { field: 'due', dir: 'asc' };
  out = _crmSortRows(rows, 't', cols).map(r => r.due);
  assert('dates sort oldest first', out[0] === '2026-01-15', out.join(','));
  assert('no close date sorts last', out[3] === '', out.join(','));

  _crmSort.t = { field: 'name', dir: 'asc' };
  assert('text sorts alphabetically',
    _crmSortRows(rows, 't', cols).map(r => r.name).join('') === 'abcd');

  // A column the table does not have must leave the order alone rather than
  // silently sorting everything to blank.
  _crmSort.t = { field: 'nope', dir: 'asc' };
  assert('unknown column leaves order untouched',
    _crmSortRows(rows, 't', cols).map(r => r.name).join('') === 'bacd');

  delete _crmSort.t;
  assert('no sort set leaves order untouched',
    _crmSortRows(rows, 't', cols).map(r => r.name).join('') === 'bacd');

  // The sort must not reorder the caller's array in place — the blob is the
  // source of truth and a render must not rewrite it.
  _crmSort.t = { field: 'name', dir: 'desc' };
  const before = rows.map(r => r.name).join('');
  _crmSortRows(rows, 't', cols);
  assert('sorting does not mutate the source rows', rows.map(r => r.name).join('') === before);
}

/* ── 3. CSV cells ────────────────────────────────────────────────────────── */
console.log('\nCSV export');
{
  const { _crmCsvCell } = new Function(extractFunction(SRC, '_crmCsvCell') + '\nreturn { _crmCsvCell };')();

  assert('plain text passes through',   _crmCsvCell('Fort Cherry') === 'Fort Cherry');
  assert('a comma forces quoting',      _crmCsvCell('Canonsburg, PA') === '"Canonsburg, PA"');
  assert('a quote is doubled',          _crmCsvCell('the "big" field') === '"the ""big"" field"');
  assert('a newline forces quoting',    _crmCsvCell('line1\nline2') === '"line1\nline2"');
  assert('empty stays empty',           _crmCsvCell('') === '');
  assert('null reads as empty',         _crmCsvCell(null) === '');
  assert('numbers survive',             _crmCsvCell(42) === '42');

  // A leading =, +, - or @ is a formula to Excel. A phone number typed with a
  // country code must not become one.
  assert('= is neutralised',  _crmCsvCell('=1+1') === "'=1+1");
  assert('+ is neutralised',  _crmCsvCell('+1 412 555 0100') === "'+1 412 555 0100");
  assert('@ is neutralised',  _crmCsvCell('@SUM(A1)') === "'@SUM(A1)");
  assert('a formula with a comma is quoted too',
    _crmCsvCell('=HYPERLINK("a","b")') === '"\'=HYPERLINK(""a"",""b"")"', _crmCsvCell('=HYPERLINK("a","b")'));
}

/* ── 4. The news hub merge ───────────────────────────────────────────────── */
console.log('\nNews Center merge');
{
  const news = require(path.join(ROOT, 'api', 'lib', 'crm-news.js'));
  const today = new Date('2026-09-22T12:00:00Z');

  const clean = news.cleanItems([
    { date: '2026-09-18', headline: 'A beat B 30-25.', source_url: 'https://example.com/1', region: 'Western PA' },
    { date: '2026-09-18', headline: 'No source here.' },                       // unsourced
    { date: '2026-09-18', headline: '', source_url: 'https://example.com/2' }, // no opener
    { date: '2026-09-19', headline: 'C beat D 14-7.', source_url: 'not-a-url' },
  ], today);
  assert('an unsourced result is dropped', clean.length === 1, `kept ${clean.length}`);
  assert('the sourced result survives', clean[0].headline === 'A beat B 30-25.');
  assert('every kept item gets an id', !!clean[0].id);

  // The same game found again must correct the row, not duplicate it.
  const again = news.cleanItems([
    { date: '2026-09-18', headline: 'A beat B 30-25.', source_url: 'https://example.com/corrected', region: 'Western PA' },
  ], today);
  assert('the same game keeps the same id', again[0].id === clean[0].id);

  const merged = news.mergeNews(clean, again, { today });
  assert('a re-run corrects rather than duplicates', merged.length === 1, `got ${merged.length}`);
  assert('the newer source wins', merged[0].source_url === 'https://example.com/corrected');

  // The failure mode worth guarding: a search that finds nothing must not
  // empty a hub someone was about to use.
  assert('an empty pull keeps the stored hub',
    news.mergeNews(clean, [], { today }).length === 1);

  // Ageing is by the game's date, so a week of failed crons cannot clear it.
  const old = news.cleanItems([
    { date: '2020-01-01', headline: 'Ancient game.', source_url: 'https://example.com/old' },
  ], today);
  assert('a stale item ages out', news.mergeNews(old, [], { today }).length === 0);
  assert('a recent item does not', news.mergeNews(clean, [], { today }).length === 1);

  // Server tool failures arrive as a 200 with an error object where the
  // results list would be, so they have to be spotted rather than thrown.
  assert('a failed web search is detected',
    news.searchFailure({ content: [{ type: 'web_search_tool_result', content: { error_code: 'max_uses_exceeded' } }] })
      === 'max_uses_exceeded');
  assert('a successful web search is not flagged',
    news.searchFailure({ content: [{ type: 'web_search_tool_result', content: [{ title: 'x' }] }] }) === null);
}

/* ── 5. Wiring ───────────────────────────────────────────────────────────── */
console.log('\nTab wiring and columns');
{
  for (const t of ['news', 'dashboard', 'people', 'companies', 'opportunities', 'search', 'reports']) {
    assert(`"${t}" has a sub-tab button`, SRC.includes(`data-crm-tab="${t}"`));
    assert(`"${t}" has a panel`,          SRC.includes(`id="crm-panel-${t}"`));
    assert(`"${t}" is routed`,            new RegExp(`tab === '${t}'\\)\\s*\\w*\\s*render`).test(SRC));
  }
  // Lucius predates the revamp and was not asked to go.
  assert('Lucius is still there', SRC.includes('data-crm-tab="lucius"'));

  // Lead Contact sits immediately right of Tag on all three tables, which is
  // what the layout asked for.
  for (const cols of ['_CRM_PEOPLE_COLS', '_CRM_COMPANY_COLS', '_CRM_OPP_COLS']) {
    const block = SRC.slice(SRC.indexOf(`const ${cols} = [`), SRC.indexOf(`const ${cols} = [`) + 3000);
    const tagAt  = block.indexOf("f: 'tag'");
    const leadAt = block.indexOf("f: 'lead_contact'");
    assert(`${cols}: lead contact follows tag`, tagAt >= 0 && leadAt > tagAt);
    for (const f of ['personal_interest', 'turf_product']) {
      assert(`${cols}: has ${f}`, block.includes(`f: '${f}'`));
    }
  }

  // New columns have to reach the CSV importer too, or an export cannot be
  // edited and uploaded back.
  const uploads = SRC.slice(SRC.indexOf('const _CRM_UPLOAD_FIELDS'), SRC.indexOf('function _crmParseCSV'));
  for (const f of ['lead_contact', 'personal_interest', 'turf_product']) {
    assert(`CSV upload map carries ${f}`, (uploads.match(new RegExp(`'${f}'`, 'g')) || []).length === 3);
  }

  for (const key of ['fct_crm_fields', 'fct_crm_news', 'fct_crm_status_log']) {
    assert(`${key} is loaded on boot`, SRC.includes(`apiGet('${key}')`));
  }
  assert('stage and status moves are logged', SRC.includes('logCrmStatusChange(opp, field, before, el.value)'));
  assert('the paving CRM was left alone',
    !fs.readFileSync(path.join(ROOT, 'paving.html'), 'utf8').includes('data-crm-tab="news"'));
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
