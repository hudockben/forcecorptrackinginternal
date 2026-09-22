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

// Top-level await so the async checks (the deadline, the fake client) read in
// line with the rest rather than nesting the whole file in a callback.

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

/* ── 4b. One region per call ─────────────────────────────────────────────── */
console.log('\nPer-region pulls');
{
  const news = require(path.join(ROOT, 'api', 'lib', 'crm-news.js'));
  const cron = require(path.join(ROOT, 'api', 'cron', 'crm-news.js'));
  const today = new Date('2026-09-22T12:00:00Z');

  assert('three regions, keyed', news.REGIONS.map(r => r.key).join(',') === 'wpa,eoh,wny');
  assert('every region has a label and a detail',
    news.REGIONS.every(r => r.label && r.detail && r.detail.length > 20));
  assert('a region resolves by key',   news.regionFor('eoh').label === 'Eastern OH');
  assert('a region resolves by label', news.regionFor('Western NY').key === 'wny');
  assert('an unknown region resolves to nothing', news.regionFor('texas') === null);

  // One region per prompt is the whole point — a prompt naming all three is
  // the request that timed out.
  const prompt = news.buildPrompt(news.regionFor('wpa'), today, 14);
  assert('the prompt names its own region',   prompt.includes('Western Pennsylvania'));
  assert('the prompt names no other region',  !prompt.includes('Eastern Ohio') && !prompt.includes('Western New York'));
  assert('the prompt asks for the score parts', prompt.includes('winner_score') && prompt.includes('loser_score'));
  assert('five searches per region', news.MAX_SEARCHES === 5);
  assert('twenty results per region', news.MAX_RESULTS === 20);

  // The region tag comes from which call this was, not from the model: it is
  // the one field already known for certain, and the tab filters on it.
  const tagged = news.cleanItems([{
    date: '2026-09-19', region: 'Nowhere', sport: 'Football',
    winner: 'Indiana', winner_score: '30', loser: 'Fort Cherry', loser_score: '25',
    headline: 'Indiana High School football defeated Fort Cherry this past Friday with a score of 30-25.',
    source_url: 'https://example.com/g',
  }], today, 'Eastern OH');
  assert('the caller\'s region wins over the model\'s', tagged[0].region === 'Eastern OH');
  assert('the winner is kept',       tagged[0].winner === 'Indiana');
  assert('the score is kept',        tagged[0].winner_score === '30' && tagged[0].loser_score === '25');
  assert('school falls back to winner', tagged[0].school === 'Indiana');

  // Scores arrive as whatever the model wrote them as.
  const messy = news.cleanItems([{
    date: '2026-09-19', winner: 'A', winner_score: ' 14 ', loser: 'B', loser_score: 'seven',
    headline: 'A beat B.', source_url: 'https://example.com/m',
  }], today, 'Western PA');
  assert('a padded score is cleaned',   messy[0].winner_score === '14');
  assert('an unparseable score is dropped, not guessed', messy[0].loser_score === '');

  // The cron starts on a different region each day, so the one cut off by the
  // clock yesterday goes first today.
  const d1 = cron.dayIndex(new Date('2026-09-22T06:00:00Z'));
  const d2 = cron.dayIndex(new Date('2026-09-23T06:00:00Z'));
  assert('the day index advances by one a day', d2 === d1 + 1);
  const starts = new Set([0, 1, 2].map(n =>
    cron.dayIndex(new Date(Date.UTC(2026, 8, 22 + n))) % news.REGIONS.length));
  assert('three consecutive days start on three different regions', starts.size === 3);
  // The budget has to leave room for the region in flight to finish and be
  // written to every company, so it is well under the ceiling, not just under.
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const cap    = f => (vercel.functions[f] || {}).maxDuration;
  assert('the cron has the raised ceiling', cap('api/cron/crm-news.js') === 300);
  assert('the pull endpoint has it too',    cap('api/ai/crm-news.js') === 300);
  assert('so does AI Search',               cap('api/ai/crm-search.js') === 300);
  assert('the cron stops well before the platform does',
    cron.TIME_BUDGET_MS < cap('api/cron/crm-news.js') * 1000 * 0.9,
    `${cron.TIME_BUDGET_MS}ms vs ${cap('api/cron/crm-news.js')}s`);

  // The same invariant one layer up: a deadline above the ceiling would never
  // fire, and the bodiless 504 it exists to prevent would come back.
  const endpoint = fs.readFileSync(path.join(ROOT, 'api', 'ai', 'crm-news.js'), 'utf8');
  const deadline = Number((endpoint.match(/const DEADLINE_MS\s*=\s*(\d+)/) || [])[1]);
  assert('the endpoint deadline is under its ceiling',
    deadline > 0 && deadline < cap('api/ai/crm-news.js') * 1000, `${deadline}ms`);

  // And the browser's backstop must sit above the server's deadline, or it
  // would cut off answers that were on their way.
  const backstop = Number((SRC.match(/ctl\.abort\(\), (\d+)\)/) || [])[1]);
  assert('the tab waits longer than the server takes', backstop > deadline, `${backstop}ms vs ${deadline}ms`);
}

/* ── 4d. The touch log ───────────────────────────────────────────────────── */
console.log('\nTouch log');
{
  const code = [
    'let crmTouches = [];',
    'let _crmTouchLatest = { person: new Map(), opp: new Map(), company: new Map() };',
    'const _CRM_COLD_DAYS = 60;',
    extractFunction(SRC, '_crmReindexTouches'),
    extractFunction(SRC, '_crmDaysSince'),
    extractFunction(SRC, '_crmTouchForPerson'),
    extractFunction(SRC, '_crmTouchForOpp'),
    extractFunction(SRC, '_crmTouchText'),
    'return { set: t => { crmTouches = t; _crmReindexTouches(); },',
    '  _crmTouchForPerson, _crmTouchForOpp, _crmTouchText, _crmDaysSince };',
  ].join('\n');
  const T = new Function(code)();

  const ago = n => new Date(Date.now() - n * 86400000).toISOString();
  T.set([
    { id: 'a', at: ago(30), person_id: 'p1', opp_id: '',   company: 'Fort Cherry SD', channel: 'Email' },
    { id: 'b', at: ago(3),  person_id: 'p1', opp_id: '',   company: 'Fort Cherry SD', channel: 'Call'  },
    { id: 'c', at: ago(10), person_id: '',   opp_id: 'o9', company: 'Peters Township', channel: 'Visit' },
  ]);

  // The newest touch wins, not the last one in the array.
  assert('a person shows their most recent touch',
    T._crmTouchForPerson({ id: 'p1', company: 'Fort Cherry SD' }).channel === 'Call');
  assert('and it is measured in days',
    T._crmDaysSince(T._crmTouchForPerson({ id: 'p1' }).at) === 3);

  // A call to anyone at the company counts for a colleague at the same one —
  // the company heard from us, which is the question being asked.
  assert('a colleague at the same company inherits the touch',
    T._crmTouchForPerson({ id: 'p2', company: 'Fort Cherry SD' }).channel === 'Call');
  assert('company matching ignores case and padding',
    T._crmTouchForPerson({ id: 'p3', company: '  fort cherry sd ' }).channel === 'Call');
  assert('an unrelated company has no touch',
    T._crmTouchForPerson({ id: 'p4', company: 'Somewhere Else' }) === null);

  assert('an opportunity finds its own touch',
    T._crmTouchForOpp({ id: 'o9', company: 'Peters Township' }).channel === 'Visit');
  assert('an opportunity falls back to its company',
    T._crmTouchForOpp({ id: 'o404', company: 'Fort Cherry SD' }).channel === 'Call');

  // "Never" has to sort and export as the coldest thing there is, not as a
  // blank that lands wherever the comparator happens to put it.
  const never   = T._crmTouchText(null);
  const recent  = T._crmTouchText({ at: ago(3) });
  const old     = T._crmTouchText({ at: ago(120) });
  assert('never sorts colder than a 120-day gap', Number(never) > Number(old), `${never} vs ${old}`);
  assert('120 days sorts colder than 3',          Number(old) > Number(recent));
  assert('days since is never negative',          T._crmDaysSince(new Date(Date.now() + 86400000).toISOString()) === 0);
  assert('a missing timestamp reads as unknown',  T._crmDaysSince('') === null);
}

/* ── 4e. What the contact finder will stand behind ───────────────────────── */
console.log('\nContact finder');
{
  const src = fs.readFileSync(path.join(ROOT, 'api', 'ai', 'crm-find-contacts.js'), 'utf8');
  const { cleanPeople } = new Function(
    'const MAX_PEOPLE = 6;\n' + extractFunction(src, 'cleanPeople') + '\nreturn { cleanPeople };')();

  const out = cleanPeople([
    { name: 'Greg Taranto', title: 'Superintendent', email: 'tarantog@cmsd.k12.pa.us',
      phone: '724-746-2940', source_url: 'https://example.com/staff', confidence: 'high' },
    { name: 'No Source Sam', title: 'AD', email: 'sam@x.com' },                 // unsourced
    { name: '', title: 'AD', source_url: 'https://example.com/a' },             // nameless
    { name: 'Bad Email Bob', source_url: 'https://example.com/b', email: 'bob(at)x.com' },
    { name: 'No Email Ned',  source_url: 'https://example.com/c', title: 'Athletic Director' },
  ]);

  assert('an unsourced person is dropped',  !out.find(p => p.name === 'No Source Sam'));
  assert('a nameless row is dropped',       out.every(p => p.name));
  assert('a sourced person survives',       out[0].name === 'Greg Taranto');
  assert('their address is kept',           out[0].email === 'tarantog@cmsd.k12.pa.us');

  // A malformed address is a typo at best and a bounce at worst — the name is
  // still worth having, the address is not.
  const bob = out.find(p => p.name === 'Bad Email Bob');
  assert('a malformed address is discarded, the person kept', bob && bob.email === '');

  // Most of the work is finding out who to ask for; no printed address does
  // not make the name useless.
  const ned = out.find(p => p.name === 'No Email Ned');
  assert('someone with no address is still returned', !!ned);
  assert('and keeps their title',                     ned.title === 'Athletic Director');
  assert('confidence defaults rather than being invented',
    ned.confidence === 'medium' && out[0].confidence === 'high');

  assert('the list is capped', cleanPeople(Array.from({ length: 20 }, (_, i) =>
    ({ name: 'P' + i, source_url: 'https://example.com/' + i }))).length === 6);

  // The lookup must never construct an address from a pattern — that is the
  // instruction that keeps the sending domain out of trouble.
  assert('the prompt forbids guessing an address',
    /NEVER construct an email address from a pattern/.test(src));
  assert('the lookup stops before the platform does',
    /const DEADLINE_MS = 150000/.test(src));
}

/* ── 4f. The Lucius bridge ───────────────────────────────────────────────── */
console.log('\nLucius \u2194 CRM');
{
  // _LUCIUS_SPORT_TO_FIELD is an object literal, so lift it by brace instead.
  const objStart = SRC.indexOf('const _LUCIUS_SPORT_TO_FIELD = {');
  let depth = 0, objEnd = -1;
  for (let j = SRC.indexOf('{', objStart); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) { objEnd = j + 1; break; }
  }
  const L = new Function([
    SRC.slice(objStart, objEnd) + ';',
    extractFunction(SRC, '_luciusOsmKey'),
    extractFunction(SRC, '_luciusSplitAddr'),
    extractFunction(SRC, '_luciusFieldType'),
    'let crmCompanies = [], crmFields = [];',
    extractFunction(SRC, '_luciusCrmLink'),
    'return { _luciusOsmKey, _luciusSplitAddr, _luciusFieldType, _luciusCrmLink,',
    '  seed: (c, f) => { crmCompanies = c; crmFields = f; } };',
  ].join('\n'))();

  // The link key is OSM's own identity — stable across reruns, and unchanged
  // by anyone tidying up a company name.
  assert('the osm key is type/id', L._luciusOsmKey({ osmType: 'way', osmId: '123' }) === 'way/123');
  assert('a field with no osm identity has no key', L._luciusOsmKey({ name: 'x' }) === '');

  // The address is joined "street, city, state, postcode" with parts missing,
  // so a ZIP and a state are found by shape, not by position.
  const full = L._luciusSplitAddr('110 Elm Street, McDonald, PA, 15057');
  assert('a full address splits', full.address === '110 Elm Street' && full.city === 'McDonald'
    && full.state === 'PA' && full.zip === '15057', JSON.stringify(full));

  const noZip = L._luciusSplitAddr('McMillan Road, Canonsburg, PA');
  assert('a missing zip does not shift the rest',
    noZip.address === 'McMillan Road' && noZip.city === 'Canonsburg' && noZip.state === 'PA' && noZip.zip === '',
    JSON.stringify(noZip));

  const plus4 = L._luciusSplitAddr('1 Main St, Erie, PA, 16501-1234');
  assert('a zip+4 is still a zip', plus4.zip === '16501-1234');

  // One bare part is a town far more often than a street, unless it starts
  // with a number.
  assert('a lone town reads as a town', L._luciusSplitAddr('Boardman').city === 'Boardman');
  assert('a lone street reads as a street', L._luciusSplitAddr('42 Oak Ave').address === '42 Oak Ave');
  assert('an empty address is empty, not undefined',
    JSON.stringify(L._luciusSplitAddr('')) === JSON.stringify({ address: '', city: '', state: '', zip: '' }));

  // OSM sport tags arrive in the CRM's own vocabulary, or the Fields filters
  // would be matching against raw tags nobody types.
  assert('american_football becomes Football', L._luciusFieldType('american_football') === 'Football');
  assert('soccer stays Soccer',                L._luciusFieldType('soccer') === 'Soccer');
  assert('rugby folds into Multi-Sport',       L._luciusFieldType('rugby_union') === 'Multi-Sport');
  assert('a multi-value tag takes the first',  L._luciusFieldType('soccer;lacrosse') === 'Soccer');
  assert('an unknown tag is still readable',   L._luciusFieldType('ultimate_frisbee') === 'Ultimate frisbee');
  assert('no sport is no type',                L._luciusFieldType('') === '');

  // The link itself. This is what stops a rerun growing a second Fort Cherry.
  const lucius = { id: 'way/7', name: 'Fort Cherry High School', osmType: 'way', osmId: '7' };

  L.seed([], []);
  assert('an unknown field links to nothing', !L._luciusCrmLink(lucius).company);

  // A company typed by hand, before Lucius ever saw the place, is matched by
  // name so it can adopt the key rather than be duplicated.
  L.seed([{ id: 'c1', company_name: 'Fort Cherry High School' }], []);
  assert('a hand-typed company is found by name', L._luciusCrmLink(lucius).company.id === 'c1');
  L.seed([{ id: 'c1', company_name: '  fort cherry HIGH school ' }], []);
  assert('and the name match ignores case and padding', !!L._luciusCrmLink(lucius).company);

  // Once the key is on the row, the name no longer matters — which is the
  // point: renaming a company must not orphan it.
  L.seed([{ id: 'c1', company_name: 'Fort Cherry School District', osm_id: 'way/7' }], []);
  assert('the key survives a rename', L._luciusCrmLink(lucius).company.id === 'c1');

  // The field carries the key too, and reaches its company through it.
  L.seed([{ id: 'c1', company_name: 'Anything At All' }],
         [{ id: 'f1', company_id: 'c1', osm_id: 'way/7' }]);
  const viaField = L._luciusCrmLink(lucius);
  assert('a linked field is found',        viaField.field.id === 'f1');
  assert('and leads back to its company',  viaField.company.id === 'c1');

  // A different pitch at the same school must not collide with it.
  assert('another osm id is a different field',
    L._luciusCrmLink({ id: 'way/8', name: 'Somewhere Else', osmType: 'way', osmId: '8' }).field == null);

  // Before the CRM blobs load there is nothing to match against, and the
  // table renders anyway rather than throwing.
  L.seed(null, null);
  const cold = L._luciusCrmLink(lucius);
  assert('an unloaded CRM links to nothing instead of throwing',
    cold.company === null && cold.field === null);
}

/* ── 4g. The pick lists ──────────────────────────────────────────────────── */
console.log('\nPick lists');
{
  // Lift the list object literal by brace, then the functions that read it.
  const objStart = SRC.indexOf('const _CRM_LISTS = [');
  let depth = 0, objEnd = -1;
  for (let j = SRC.indexOf('[', objStart); j < SRC.length; j++) {
    if (SRC[j] === '[') depth++;
    else if (SRC[j] === ']' && --depth === 0) { objEnd = j + 1; break; }
  }
  const K = new Function([
    'const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");',
    'let lists = {}; let saved = 0; function saveLists() { saved++; }',
    SRC.slice(objStart, objEnd) + ';',
    "const _CRM_EMPLOYEE_LIST = 'employees';",
    extractFunction(SRC, '_crmListDef'),
    extractFunction(SRC, '_crmListLabel'),
    extractFunction(SRC, '_crmSeedLists'),
    extractFunction(SRC, '_crmListValues'),
    extractFunction(SRC, '_crmListAdd'),
    extractFunction(SRC, '_crmListOptions'),
    'return { _CRM_LISTS, _crmSeedLists, _crmListValues, _crmListAdd, _crmListOptions,',
    '  reset: v => { lists = v; saved = 0; }, lists: () => lists, saves: () => saved };',
  ].join('\n'))();

  // Every list a dropdown names has to exist, or the cell renders empty with
  // no way for anyone to work out why.
  const keys = K._CRM_LISTS.map(l => l.key);
  for (const k of ['crm_contact_types', 'crm_org_types', 'crm_field_types',
                   'crm_turf_products', 'crm_sources', 'crm_loss_reasons']) {
    assert(`${k} is defined`, keys.includes(k));
    assert(`${k} is wired to a cell`, SRC.includes(`'${k}'`));
  }

  // First run seeds. defaultLists already hands over empty arrays, so seeding
  // has to treat empty as unseeded on that one pass.
  K.reset({ crm_contact_types: [], crm_sources: [], employees: [] });
  assert('the first load seeds', K._crmSeedLists() === true);
  assert('and fills a list',  K._crmListValues('crm_contact_types').length > 5);
  assert('turf products are left empty on purpose',
    K._crmListValues('crm_turf_products').length === 0);
  assert('the marker is set', K.lists()._crm_lists_seeded === true);

  // A list someone empties on purpose must stay empty across reloads.
  const after = { ...K.lists(), crm_sources: [] };
  K.reset(after);
  assert('a second load does not reseed', K._crmSeedLists() === false);
  assert('and an emptied list stays empty', K._crmListValues('crm_sources').length === 0);

  // Employees are objects; the picker wants names, sorted.
  K.reset({ employees: [{ name: 'Nate Brewer' }, { name: 'Ben Hudock' }, 'Old String Name'] });
  assert('employees read as sorted names',
    K._crmListValues('employees').join(',') === 'Ben Hudock,Nate Brewer,Old String Name',
    K._crmListValues('employees').join(','));

  // Adding.
  K.reset({ crm_turf_products: [], employees: [] });
  assert('a value is added',        K._crmListAdd('crm_turf_products', 'SuperBlade HD') === true);
  assert('and persisted',           K.saves() === 1);
  K._crmListAdd('crm_turf_products', 'SuperBlade HD');
  assert('a duplicate is not added', K._crmListValues('crm_turf_products').length === 1);
  assert('blank is refused',        K._crmListAdd('crm_turf_products', '   ') === false);
  K._crmListAdd('employees', 'New Person');
  assert('a new lead contact keeps the employee shape',
    K.lists().employees[0] && K.lists().employees[0].name === 'New Person'
      && K.lists().employees[0].job_class === '');

  // The rule that protects existing data: a stored value not on the list is
  // still offered, still selected, and marked — never silently blanked.
  K.reset({ crm_contact_types: ['Athletic Director', 'Superintendent'] });
  const off = K._crmListOptions('Athletic Dir.', 'crm_contact_types', 'type');
  assert('an off-list value is still an option', off.includes('Athletic Dir.'));
  assert('it is selected',  /Athletic Dir\.[^<]*<\/option>/.test(off) && off.includes('selected'));
  assert('and marked as off-list', off.includes('(not on list)'));

  const on = K._crmListOptions('Superintendent', 'crm_contact_types', 'type');
  assert('an on-list value is selected once',
    (on.match(/selected/g) || []).length === 1);
  assert('an on-list value is not marked off-list', !on.includes('(not on list)'));
  assert('every dropdown can be extended in place', on.includes('__crm_add__'));
  assert('and has a blank option to clear it', on.includes('<option value="">'));

  // The add sentinel must never be storable as a value.
  assert('the add sentinel is intercepted before it is written',
    SRC.includes("el.value !== '__crm_add__'") && SRC.includes('const picked = _crmListPick('));
  assert('cancelling an add restores the previous value',
    SRC.includes("el.value = previous || ''"));

  // Renaming rewrites the rows; removing deliberately does not.
  assert('renaming rewrites the rows that used it', SRC.includes('function _crmRewriteListValue('));
  assert('removing warns how many rows keep the value', SRC.includes('function _crmCountListValue('));
  assert('a CSV import snaps to the list', SRC.includes("contact_type: _crmListValues("));
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

  // The News Center asks for one region at a time; asking for all three in
  // one request is what returned a 504.
  assert('the tab sends a region', SRC.includes("JSON.stringify({ region, force: !!force })"));
  assert('the tab walks all three regions', /_NC_REGIONS\s*=\s*\[[\s\S]{0,200}wpa[\s\S]{0,200}eoh[\s\S]{0,200}wny/.test(SRC));
  assert('the tab gives up before hanging forever', SRC.includes('new AbortController()'));
  assert('a gateway timeout is said in words', SRC.includes("'the search ran past the time limit'"));
  assert('the feed has a scoreboard card', SRC.includes('function _ncCard('));
  assert('the feed has a ticker',          SRC.includes('function _ncTicker('));
  assert('the ticker respects reduced motion', SRC.includes('prefers-reduced-motion'));
  assert('the table view is still reachable',
    SRC.includes("viewBtn('table'") && SRC.includes("_crmNewsView === 'feed'"));
  assert('the old filter-row handler is gone', !SRC.includes('data-crm-nf'));

  assert('a touch can be logged from a People row',        SRC.includes("_crmTouchBtn('person', p.id)"));
  assert('and from an Opportunities row',                 SRC.includes("_crmTouchBtn('opportunity', o.id)"));
  assert('and from the outreach call list',               SRC.includes("_crmTouchBtn('opportunity', r.id)"));
  assert('People shows when it last heard from them',     SRC.includes("label: 'Last Touch'"));
  assert('the outreach report can show only cold names',  SRC.includes('_crmOutreachColdOnly'));
  assert('there is a contact activity report',            SRC.includes("tab('activity', 'Contact Activity')"));
  assert('the finder lives beside Companies and Fields',  SRC.includes("btn('find',      'Find Contacts'"));
  assert('found contacts are never written without a tick',
    SRC.includes('function crmFindAddSelected()') && SRC.includes("_crmFind.selected.has"));
  assert('an accepted contact carries where it came from',
    SRC.includes('Found by contact lookup'));

  // The bridge: Lucius files a field as a company AND a field, links both by
  // osm_id, and never invents the one thing OSM cannot know.
  assert('Lucius creates a CRM field, not just a company', SRC.includes('crmFields.push(field)'));
  assert('both sides carry the osm link',
    SRC.includes('osm_id: key, osm_lat: f.lat, osm_lng: f.lng'));
  assert('a name-matched company adopts the link',  SRC.includes('company.osm_id = key'));
  assert('the install year is left blank on purpose',
    /installed_year: '',[\s\S]{0,400}Found by Lucius/.test(SRC));
  assert('filing a field marks it converted',       SRC.includes("_luciusSetFieldStatus(id, 'Converted')"));
  assert('the table says what is already in the CRM', SRC.includes('function _luciusCrmCell('));
  assert('there is a not-in-CRM filter',            SRC.includes("_luciusFilter.crm === 'out'"));
  assert('and a bulk file-everything',              SRC.includes('function _luciusAddAllToCrm('));
  assert('a filed field links back to the map',     SRC.includes('Found by Lucius — see it on the map'));

  // The pickers themselves, on every table that has one.
  for (const [cell, field] of [
    ['_crmListSel(p', 'contact_type'], ['_crmListSel(c', 'field_type'],
    ['_crmListSel(o', 'source'],       ['_crmFieldListSel(f', 'turf_product'],
  ]) {
    assert(`${field} is a picker, not free text`,
      new RegExp(`${cell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, '${field}'`).test(SRC));
  }
  assert('lead contact picks from our own people',
    (SRC.match(/_crmListSel\([pco], 'lead_contact', _CRM_EMPLOYEE_LIST/g) || []).length === 3);
  assert('the lists are editable from the CRM', SRC.includes('function openCrmLists('));
  assert('and reachable from a toolbar',        SRC.includes('function _crmListsBtn('));
  assert('the superseded hard-coded field types are gone', !SRC.includes('_CRM_FIELD_TYPES'));

  for (const key of ['fct_crm_fields', 'fct_crm_news', 'fct_crm_status_log', 'fct_crm_touches']) {
    assert(`${key} is loaded on boot`, SRC.includes(`apiGet('${key}')`));
  }
  assert('stage and status moves are logged', SRC.includes('logCrmStatusChange(opp, field, before, el.value)'));
  assert('the paving CRM was left alone',
    !fs.readFileSync(path.join(ROOT, 'paving.html'), 'utf8').includes('data-crm-tab="news"'));
}

/* ── 4c. The request that has to fit in 60 seconds ───────────────────────── */
async function latencyBudget() {
  console.log('\nLatency budget');
  const news = require(path.join(ROOT, 'api', 'lib', 'crm-news.js'));
  const today = new Date('2026-09-22T12:00:00Z');

  const reply = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
  const body  = JSON.stringify({ items: [{
    date: '2026-09-19', sport: 'Football', winner: 'Indiana', winner_score: '30',
    loser: 'Fort Cherry', loser_score: '25',
    headline: 'Indiana High School football defeated Fort Cherry this past Friday with a score of 30-25.',
    source_url: 'https://example.com/g',
  }] });

  /** A stand-in for the Anthropic client that records what it was asked. */
  function fake(handler) {
    const calls = [];
    return { calls, messages: { create: async req => { calls.push(req); return handler(req, calls.length); } } };
  }

  // Three searches, ten results, low effort. Each of these is why the request
  // fits inside the function's ceiling instead of dying at the gateway.
  {
    const c = fake(() => reply(body));
    const out = await news.pullNews(c, { region: 'wpa', today });
    const req = c.calls[0];
    assert('the pull asks for five searches', req.tools[0].max_uses === 5, String(req.tools[0].max_uses));
    assert('the pull runs at medium effort', req.output_config && req.output_config.effort === 'medium',
      JSON.stringify(req.output_config));
    assert('the pull uses the current search tool', req.tools[0].type === 'web_search_20260209');
    assert('the prompt caps the searches',     /at most 5 searches/.test(req.messages[0].content));
    assert('the prompt caps the result count',  /up to 20 games/.test(req.messages[0].content));
    assert('the reply is parsed into items', out.items.length === 1 && out.items[0].winner === 'Indiana');
    assert('the item is tagged with the region asked for', out.items[0].region === 'Western PA');
  }

  // An API surface that does not know `effort` rejects the whole request. It
  // must cost the speed, not the answer.
  {
    let first = true;
    const c = fake(() => {
      if (first) { first = false; throw Object.assign(new Error('bad request'), { status: 400 }); }
      return reply(body);
    });
    const out = await news.pullNews(c, { region: 'wpa', today });
    assert('a rejected effort is dropped, not fatal', out.items.length === 1);
    assert('the retry carries no effort', !c.calls[1].output_config);
    assert('the retry keeps the search tool', c.calls[1].tools[0].type === 'web_search_20260209');
  }

  // Same for the dated search tool, which is the one that must not be lost
  // quietly — without a search there is nothing to report.
  {
    let n = 0;
    const c = fake(() => {
      if (++n <= 2) throw Object.assign(new Error('bad request'), { status: 400 });
      return reply(body);
    });
    const out = await news.pullNews(c, { region: 'eoh', today });
    assert('the basic search tool is the last resort', c.calls[2].tools[0].type === 'web_search_20250305');
    assert('and it still returns results', out.items.length === 1);
  }

  // A non-400 is a real failure and must surface, not be swallowed as empty.
  {
    const c = fake(() => { throw Object.assign(new Error('boom'), { status: 500 }); });
    let threw = false;
    try { await news.pullNews(c, { region: 'wny', today }); } catch { threw = true; }
    assert('a server error is raised, not reported as no news', threw);
  }

  // The deadline is what turns a gateway 504 into a sentence.
  {
    const slow = new Promise(r => setTimeout(r, 400));
    let caught = null;
    try { await news.withDeadline(slow, 40); } catch (e) { caught = e; }
    assert('a slow pull loses the race', !!caught);
    assert('and says it was a deadline, not a crash', caught && caught.deadline === true);

    const quick = await news.withDeadline(Promise.resolve('done'), 500);
    assert('a quick pull is untouched', quick === 'done');

    let real = null;
    try { await news.withDeadline(Promise.reject(new Error('nope')), 500); } catch (e) { real = e; }
    assert('a real failure is not relabelled a deadline', real && real.message === 'nope' && !real.deadline);
  }
}

latencyBudget().then(() => {
  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}).catch(err => {
  console.error('\n✗ the latency-budget checks threw:', err.message);
  process.exit(1);
});
