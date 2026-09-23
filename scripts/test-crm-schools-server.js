#!/usr/bin/env node
'use strict';
/**
 * Tests for the server side of the Schools tab.
 *
 * Run: node scripts/test-crm-schools-server.js
 *
 * The schools import put ~1,100 rows into the same companies blob that AI
 * Search and the contact finder read. Four things are worth pinning down,
 * because each one is a place where being wrong still returns an answer — just
 * a worse one, or a dearer one, with nothing on screen to say so.
 *
 *   What the model is shown. Every row goes into the prompt, so every empty
 *   string and every map coordinate is paid for on every search. Compaction
 *   has to drop those and must never drop the id, or a match cannot be opened.
 *
 *   Which companies survive the cap. Uploads prepend, so capping by array
 *   position hands the whole list to whatever was imported last. The
 *   customers with fields, people and deals against them have to come first.
 *
 *   The cache. The CRM block is re-sent on every pause_turn; it has to carry
 *   the cache marker, and it has to be byte-identical from one question to the
 *   next or the marker buys nothing.
 *
 *   The contact finder's brief. A college is not a school district, and a
 *   MaxPreps profile is a better first page than a blind search — but only
 *   when it really is a MaxPreps address.
 *
 * These call the real functions exported by the endpoints rather than copying
 * them here, where a copy could agree with itself and disagree with the file.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const search = require(path.join(ROOT, 'api', 'ai', 'crm-search.js'));
const finder = require(path.join(ROOT, 'api', 'ai', 'crm-find-contacts.js'));

/** A school row in the shape the import writes: every key present, most blank. */
function school(i, over = {}) {
  return {
    id: 's' + i, tag: 'Prospect', lead_contact: '',
    company_name: `School ${i} High`, contact_type: 'High School',
    sector: 'Public', athletics_level: '', enrollment: '',
    territory: i % 5 ? 'Inside' : 'On/near boundary', miles_to_line: (10 + (i % 90) / 10).toFixed(1),
    city: 'Cumberland', county: 'Allegany County', state: 'MD',
    zip: '21502-2596', address: `${100 + i} Seton Dr`,
    work_phone: '', email_domain: '', work_website: '',
    athletics_url: `https://www.maxpreps.com/md/cumberland/school-${i}/`,
    personal_interest: '', turf_product: '', notes: '', nces_id: String(240003000000 + i),
    ...over,
  };
}

/* ── 1. Compaction ───────────────────────────────────────────────────────── */
console.log('\nCompaction');
{
  const row = {
    id: 'c1', company_name: 'Fort Hill High', tag: '', lead_contact: '   ',
    city: 'Cumberland', county: 'Allegany County', state: 'MD',
    territory: 'Inside', miles_to_line: '44.9', enrollment: 0,
    notes: null, turf_product: undefined, tags: [], products: ['Sprinturf'],
    osm_lat: 39.6, osm_lng: -78.7, osm_id: 'way/123',
    athletics_url: 'https://www.maxpreps.com/md/cumberland/fort-hill-sentinels/',
    nces_id: '240003000015', address: '500 Greenway Ave', zip: '21502',
    _dirty: true, _bucket: 'replacement',
  };
  const out = search.compactRow(row);

  assert('the id is kept',                out.id === 'c1');
  assert('the name is kept',              out.company_name === 'Fort Hill High');
  assert('an empty string is dropped',    !('tag' in out));
  assert('a blank-but-for-spaces string is dropped', !('lead_contact' in out));
  assert('null and undefined are dropped', !('notes' in out) && !('turf_product' in out));
  assert('an empty list is dropped',      !('tags' in out));
  assert('a list with something in it is kept', Array.isArray(out.products) && out.products[0] === 'Sprinturf');

  // Zero is a value. A compactor that tests truthiness would lose it.
  assert('a zero is not mistaken for blank', out.enrollment === 0);

  // Location questions are asked by town, county and state; those stay.
  assert('city, county and state are kept',
    out.city === 'Cumberland' && out.county === 'Allegany County' && out.state === 'MD');
  assert('territory and miles to the line are kept',
    out.territory === 'Inside' && out.miles_to_line === '44.9');

  for (const k of ['osm_id', 'athletics_url', 'nces_id']) {
    assert(`${k} is not sent`, !(k in out));
  }
  // Location is how people ask. A ZIP stays on every row, and a Lucius field
  // may have nothing but coordinates — so those stay too, cut to 3 decimals.
  assert('the ZIP is kept', out.zip === '21502');
  assert('coordinates are kept, rounded', out.osm_lat === 39.6 && out.osm_lng === -78.7);
  assert('coordinates lose their noise',
    search.compactRow({ id: 'x', osm_lat: 40.1234567, osm_lng: -80.9876543 }).osm_lat === 40.123);
  // A school's street address is the one location key dropped: it carries its
  // town, county and ZIP, and a thousand streets are the bulk of what is left.
  assert("a company's street address is kept", out.address === '500 Greenway Ave');
  assert("a school's street address is not",
    !('address' in search.compactRow({ id: 's', contact_type: 'High School', address: '1 Main St', zip: '15317' })));
  assert('underscore keys are not sent', !('_dirty' in out) && !('_bucket' in out));
  assert('the row itself is left alone', row.tag === '' && row.osm_id === 'way/123');

  const rows = search.compactRows([row, null, 'stray', [1, 2], { id: 'c2', company_name: 'X' }]);
  assert('things that are not rows are skipped', rows.length === 2 && rows[1].id === 'c2');
  assert('a missing list compacts to nothing', search.compactRows(undefined).length === 0);

  // The point of all this: a school row as the import writes it costs well
  // under half as much once the blanks and the lookup keys are gone.
  const schools = Array.from({ length: 1100 }, (_, i) => school(i));
  const whole   = JSON.stringify(schools).length;
  const compact = JSON.stringify(search.compactRows(schools)).length;
  assert('1,100 schools compact to under half their whole size', compact < whole / 2,
    `${compact} vs ${whole} characters`);
  assert('and every compacted school still has its id',
    search.compactRows(schools).every((r, i) => r.id === 's' + i));
}

/* ── 2. Which companies come first ───────────────────────────────────────── */
console.log('\nCompany priority');
{
  const companies = [
    { id: 'a', company_name: 'Alpha Academy' },
    { id: 'b', company_name: 'Bravo HS' },
    { id: 'c', company_name: 'Fort Cherry SD' },
    { id: 'd', company_name: 'Delta College' },
    { id: 'e', company_name: 'Peters Township' },
    { id: 'f', company_name: '' },
    { id: 'g', company_name: 'Golf University' },
    { id: 'h', company_name: 'Hotel HS' },
  ];
  const related = {
    fields:        [{ company_id: 'g', company_name: '' }, { company_id: '', company_name: 'Hotel HS' }],
    people:        [{ company: '  FORT cherry sd ' }, { company: '' }],
    opportunities: [{ company: 'Peters Township' }],
  };
  const out = search.prioritiseCompanies(companies, related).map(c => c.id).join(',');

  assert('linked companies come first, then the rest', out === 'c,e,g,h,a,b,d,f', out);
  assert('a field links by company_id', out.indexOf('g') < out.indexOf('a'));
  assert('a field links by name when it has no id', out.indexOf('h') < out.indexOf('a'));
  assert('a person links by name, ignoring case and padding', out.startsWith('c'));
  assert('an opportunity links by name', out.indexOf('e') < out.indexOf('a'));
  // A blank company on a person must not link every nameless company to it.
  assert('a blank name links nothing', out.endsWith('f'));
  assert('the original list is not reordered in place', companies.map(c => c.id).join('') === 'abcdefgh');

  // A company linked only by name, with ids that match nothing, is still linked
  // — that is how people and opportunities point at a company.
  const byName = search.prioritiseCompanies(
    [{ id: 'x1', company_name: 'Somewhere' }, { id: 'x2', company_name: 'Named Only HS' }],
    { people: [{ company: 'named only hs' }] });
  assert('a company linked only by name is linked', byName[0].id === 'x2');

  assert('no related lists leaves the order as it was',
    search.prioritiseCompanies(companies, {}).map(c => c.id).join('') === 'abcdefgh');
  assert('no related argument at all is survivable',
    search.prioritiseCompanies(companies).length === companies.length);
}

/* ── 3. The caps ─────────────────────────────────────────────────────────── */
console.log('\nCaps');
{
  const { CAPS } = search;
  assert('there is room for every school and the companies we already had', CAPS.companies >= 1500,
    String(CAPS.companies));
  assert('the other caps are unchanged',
    CAPS.people === 600 && CAPS.fields === 800 && CAPS.opportunities === 500, JSON.stringify(CAPS));

  // The day of the import: 1,095 schools at the front, because uploads
  // prepend, then 500 companies of our own of which the last 20 are customers
  // with a field each. The old code kept the first 500 rows — every one a school.
  const schools   = Array.from({ length: 1095 }, (_, i) => school(i));
  const own       = Array.from({ length: 500 }, (_, i) => ({ id: 'own' + i, company_name: `Own Co ${i}`, city: '' }));
  const customers = own.slice(480);
  const raw = {
    companies:     [...schools, ...own],
    fields:        customers.map((c, i) => ({ id: 'f' + i, company_id: c.id, company_name: c.company_name })),
    people:        Array.from({ length: 700 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, company: '' })),
    opportunities: [],
  };
  const { data, truncated } = search.prepareData(raw);

  assert('companies are held to the cap', data.companies.length === CAPS.companies, String(data.companies.length));
  assert('people are held to theirs',     data.people.length === CAPS.people, String(data.people.length));
  assert('a list under its cap is whole', data.fields.length === 20 && data.opportunities.length === 0);
  const ids = new Set(data.companies.map(c => c.id));
  assert('every customer with a field survives the cap', customers.every(c => ids.has(c.id)));
  assert('and they lead the list', data.companies.slice(0, 20).every(c => c.id.startsWith('own')));
  // Then every company of our own, worked or not, and only then the schools:
  // a bought prospect list is what gets cut, never a company someone typed in.
  assert('our own unworked companies are kept ahead of the schools',
    own.every(c => ids.has(c.id)) && data.companies.slice(20, 500).every(c => c.id.startsWith('own')));
  assert('what is cut comes off the untouched schools at the end',
    ids.has('s0') && ids.has('s999') && !ids.has('s1000') && !ids.has('s1094'));
  assert('the cut is reported with both numbers',
    truncated.includes(`companies capped at ${CAPS.companies} of 1595`) &&
    truncated.includes(`people capped at ${CAPS.people} of 700`), truncated.join(' | '));
  assert('an uncapped list is not reported', !truncated.some(t => t.startsWith('fields')));
  assert('rows are compacted on the way in',
    data.companies.every(c => !Object.values(c).some(v => v === '')) && !('nces_id' in data.companies[20]));

  const small = search.prepareData({ companies: [school(1)] });
  assert('a small CRM is not reported as capped', small.truncated.length === 0);
  assert('a missing blob is an empty list',
    small.data.people.length === 0 && small.data.fields.length === 0);
}

/* ── 4. The prompt and its cache marker ──────────────────────────────────── */
console.log('\nAI Search prompt');
{
  const { data, truncated } = search.prepareData({ companies: [school(1), school(2)] });
  const a = search.buildPrompt('schools near the line in Allegany County', data, truncated, true);
  const b = search.buildPrompt('which colleges play football?', data, truncated, false);

  assert('the prompt is two blocks', Array.isArray(a) && a.length === 2 && a.every(x => x.type === 'text'));
  assert('the CRM block carries the cache marker',
    a[0].cache_control && a[0].cache_control.type === 'ephemeral', JSON.stringify(a[0].cache_control));
  assert('the CRM is in that block', /COMPANIES \(2\):/.test(a[0].text) && a[0].text.includes('"id":"s1"'));
  assert('the question comes after it, uncached',
    !a[1].cache_control && a[1].text.includes("USER'S QUESTION: schools near the line in Allegany County"));
  assert('only one breakpoint is spent', a.filter(x => x.cache_control).length === 1);

  // The cache is a prefix match: anything that changes between searches in the
  // first block would make every search a fresh write.
  assert('the CRM block is identical across different questions', a[0].text === b[0].text);
  assert('it holds no question',     !a[0].text.includes('USER\'S QUESTION'));
  assert('it holds no date',         !/\d{4}-\d{2}-\d{2}/.test(a[0].text));
  assert('the web rules are not in it either',
    !/web search/i.test(a[0].text) && /web search/i.test(a[1].text) && /Do not invent rows/.test(b[1].text));

  const ask = a[1].text;
  assert('it explains the school types', /High School, College \/ University, School District/.test(ask));
  assert('it bounds the list and asks for a total', ask.includes(`at most ${search.MAX_MATCHES} matches`));
  assert('and asks for empty keys to be left out', ask.includes('Leave out any key you have no value for'));
  assert('and sector, athletics level and enrollment',
    /sector/.test(ask) && /athletics_level/.test(ask) && /enrollment/.test(ask));
  assert('it says what Inside means',
    /"Inside" is inside the territory and more than 25 miles from the line/.test(ask));
  assert('and what On/near boundary means',
    /"On\/near boundary" is within 25 miles of the line on either side/.test(ask));
  assert('and what miles_to_line is', /miles_to_line is the distance to that line/.test(ask));
  assert('the reply carries county and territory next to city and state',
    /"city": "",\s*"county": "",\s*"state": "",\s*"territory": "Inside" \| "On\/near boundary" \| "",/.test(ask));

  // The capped note tells the model what it cannot see, and when companies
  // were cut, which ones.
  const cut = search.buildPrompt('q', data, ['companies capped at 1500 of 1600'], true)[1].text;
  assert('a capped list is still owned up to', /these lists were capped — companies capped at 1500 of 1600/.test(cut));
  assert('and says the worked companies were kept', /kept first/.test(cut));
  const peopleCut = search.buildPrompt('q', data, ['people capped at 600 of 700'], true)[1].text;
  assert('which it does not claim when only people were cut', !/kept first/.test(peopleCut));
  assert('an uncapped search has no note', !/capped/.test(ask));
}

/* ── 5. The overrun warning still reads true ─────────────────────────────── */
console.log('\nAI Search wording');
{
  const src = fs.readFileSync(path.join(ROOT, 'api', 'ai', 'crm-search.js'), 'utf8');
  // "One county" used to be advice about a field companies did not have.
  assert('the overrun advice names county, which schools now carry',
    /one county, one question/.test(src));
  assert('the model is unchanged',  /const MODEL = 'claude-opus-5'/.test(src));
  assert('so is the effort',        /const EFFORT = 'max'/.test(src));
  assert('the cap is no longer array position alone', !/data\[name\] = rows\.slice\(0, CAPS\[name\]\);/.test(src));
}

/* ── 6. The contact finder's brief ───────────────────────────────────────── */
console.log('\nContact finder brief');
{
  const src = fs.readFileSync(path.join(ROOT, 'api', 'ai', 'crm-find-contacts.js'), 'utf8');

  const hs = finder.buildPrompt(school(7, {
    company_name: 'McKinley High School', city: 'Buffalo', county: 'Erie County', state: 'NY',
    zip: '14207', address: '1500 Elmwood Ave',
    athletics_url: 'https://www.maxpreps.com/ny/buffalo/mckinley-macks/',
  }), [], []);
  assert('the location line carries the county',
    /LOCATION: 1500 Elmwood Ave, Buffalo, Erie County, NY, 14207/.test(hs));
  assert('a MaxPreps profile is offered as the athletics page',
    hs.includes('ATHLETICS PAGE: https://www.maxpreps.com/ny/buffalo/mckinley-macks/'));
  assert('the type reads as one phrase', /TYPE: Public High School/.test(hs));
  assert('a high school gets the district roles',
    hs.includes('Superintendent') && hs.includes('Athletic Director') && !hs.includes('Physical Plant'));
  assert('a high school has no athletics classification line', !/^ATHLETICS: /m.test(hs));

  const notMaxPreps = [
    'https://ope.ed.gov/athletics/#/datafile/list',
    'https://maxpreps.com.example.net/pa/x/',
    'https://notmaxpreps.com/pa/x/',
    'javascript:alert(1)//maxpreps.com',
    'maxpreps',
    '',
  ];
  for (const url of notMaxPreps) {
    const p = finder.buildPrompt(school(8, { athletics_url: url }), [], []);
    assert(`no athletics page for ${JSON.stringify(url)}`, !p.includes('ATHLETICS PAGE'));
  }
  assert('the bare maxpreps.com host is accepted too',
    finder.maxprepsUrl('https://maxpreps.com/pa/x/') === 'https://maxpreps.com/pa/x/');

  const college = finder.buildPrompt({
    id: 'u1', company_name: 'Frostburg State University', contact_type: 'College / University',
    sector: 'Public', athletics_level: 'NCAA Division II with football', enrollment: '2350',
    city: 'Frostburg', county: 'Allegany County', state: 'MD',
    athletics_url: 'https://ope.ed.gov/athletics/#/datafile/list',
  }, [], []);
  assert('a college gets the college roles',
    finder.COLLEGE_ROLES.every(r => college.includes(r)));
  assert('and not the district ones', !college.includes('Superintendent'));
  assert('it is told where a college keeps its names', /physical plant page/.test(college));
  assert('its athletics classification is passed on', /ATHLETICS: NCAA Division II with football/.test(college));
  assert('its sector too', /TYPE: Public College \/ University/.test(college));
  assert('the federal data page is not offered as a starting page', !college.includes('ATHLETICS PAGE'));

  // The type decides, not the Athletics cell: a rep may well type a high
  // school's league classification there, and that is no college. (The Schools
  // upload fills a blank type in from the name before a row gets this far.)
  assert('a high school with a classification is still a high school',
    finder.rolesFor({ contact_type: 'High School', athletics_level: 'PIAA 6A' }) === finder.ROLES);
  assert('so does a university type',
    finder.rolesFor({ contact_type: 'University' }) === finder.COLLEGE_ROLES);
  assert('a high school named Academy is still a high school',
    finder.rolesFor({ contact_type: 'High School', company_name: 'Central Catholic Academy' }) === finder.ROLES);

  // A company typed in by hand, with none of the school fields, reads as it did.
  const plain = finder.buildPrompt({ id: 'k', company_name: 'Peters Township', city: 'McMurray', state: 'PA' },
    [{ name: 'Jane Doe', title: 'AD' }], [{ field_name: 'Main', installed_year: '2015' }]);
  assert('a plain company has no type, athletics or page lines',
    !/TYPE:|ATHLETICS:|ATHLETICS PAGE:/.test(plain));
  assert('its location is unchanged', /LOCATION: McMurray, PA\n/.test(plain));
  assert('it still lists who we have', plain.includes('  - Jane Doe, AD'));
  assert('and the fields we know of', plain.includes('FIELDS WE KNOW OF: Main (installed 2015)'));
  const header = plain.slice(plain.indexOf('ORGANISATION:'), plain.indexOf('WE ALREADY HAVE'));
  assert('there are no empty lines where a missing detail would be', !header.trimEnd().includes('\n\n'),
    JSON.stringify(header));

  // The existing contract with the tests and the tab.
  assert('ROLES is still exported and still leads with the AD',
    Array.isArray(finder.ROLES) && finder.ROLES[0] === 'Athletic Director');
  assert('the college list is exported and short',
    Array.isArray(finder.COLLEGE_ROLES) && finder.COLLEGE_ROLES.length <= finder.ROLES.length);
  assert('cleanPeople is still a plain declaration', /\nfunction cleanPeople\(/.test(src));
  assert('the contact finder stays at medium', /const EFFORT = 'medium'/.test(src));
}

/* ── 7. Continuations read the CRM back from the cache ───────────────────── */
let CUT_REPLY = '';

/* ── 6. A reply that ran out of room ─────────────────────────────────────── */
console.log('\nCut-off replies');
{
  const cut = '{"answer":"Found 278 \\"high schools\\"","matches":[' +
    '{"kind":"company","id":"a","why":"a } in a string"},' +
    '{"kind":"company","id":"b","nested":{"x":1}},' +
    '{"kind":"company","id":"c","why":"cut here';
  const r = search.salvageResult(cut);
  assert('the answer survives, quotes and all', r.answer === 'Found 278 "high schools"', r.answer);
  assert('every whole match is kept', r.matches.map(m => m.id).join() === 'a,b', JSON.stringify(r.matches));
  assert('a brace inside a string does not end a match', r.matches[0].why === 'a } in a string');
  assert('the half-written match is dropped, not guessed at', !r.matches.some(m => m.id === 'c'));
  assert('nothing to salvage is an empty list, not a throw',
    search.salvageResult('no json at all').matches.length === 0);

  CUT_REPLY = cut;
}

// runSearch hands a max_tokens stop to the salvage instead of the parser.
async function cutOffSearch() {
  const client = { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: CUT_REPLY }] }) } };
  const res = await search.runSearch(client, [{ role: 'user', content: 'q' }], false);
  assert('a max_tokens stop comes back as the matches it has, marked cut off',
    res.cutOff === true && res.matches.length === 2, JSON.stringify(res));
}

/* ── 7. A worked school outranks an unworked company ─────────────────────── */
console.log('\nWorked schools');
{
  const out = search.prioritiseCompanies([
    { id: 'own', company_name: 'Acme Turf', contact_type: 'Contractor' },
    { id: 'sch', company_name: 'Fort Hill High', contact_type: 'High School' },
    { id: 'hot', company_name: 'Allegany High', contact_type: 'High School' },
  ], { opportunities: [{ company: 'Allegany High' }] }).map(c => c.id).join();
  assert('a school with a deal comes first, then our companies, then the rest', out === 'hot,own,sch', out);
}

async function continuations() {
  console.log('\nAI Search continuations');

  /** A stand-in for the Anthropic client that records a copy of each request. */
  function fake(handler) {
    const calls = [];
    return { calls, messages: { create: async req => {
      calls.push(JSON.parse(JSON.stringify(req)));
      return handler(req, calls.length);
    } } };
  }
  const done  = JSON.stringify({ answer: 'Two schools.', matches: [{ kind: 'company', id: 's1' }] });
  const reply = (stop, text) => ({ stop_reason: stop, content: [{ type: 'text', text }] });

  const { data, truncated } = search.prepareData({ companies: [school(1), school(2)] });

  {
    const messages = [{ role: 'user', content: search.buildPrompt('q', data, truncated, true) }];
    const c = fake((_, n) => (n === 1 ? reply('pause_turn', 'searching…') : reply('end_turn', done)));
    const out = await search.runSearch(c, messages, true);
    assert('a paused search is continued', c.calls.length === 2);
    assert('and the answer is parsed', out.answer === 'Two schools.' && out.matches[0].id === 's1');
    const [first, second] = c.calls;
    assert('the continuation re-sends the CRM block unchanged',
      JSON.stringify(first.messages[0]) === JSON.stringify(second.messages[0]));
    assert('with its cache marker still on it',
      second.messages[0].content[0].cache_control.type === 'ephemeral');
    assert('and the paused turn appended after it',
      second.messages.length === 2 && second.messages[1].role === 'assistant');
    assert('the search tool is on both requests',
      first.tools[0].type === 'web_search_20260209' && second.tools[0].type === 'web_search_20260209');
  }

  // The effort fallback must not strip the marker on its way past.
  {
    const messages = [{ role: 'user', content: search.buildPrompt('q', data, truncated, true) }];
    let first = true;
    const c = fake(() => {
      if (first) { first = false; throw Object.assign(new Error('bad request'), { status: 400 }); }
      return reply('end_turn', done);
    });
    await search.runSearch(c, messages, true);
    assert('a rejected effort is dropped', c.calls.length === 2 && !c.calls[1].output_config);
    assert('the retry keeps the cache marker', c.calls[1].messages[0].content[0].cache_control.type === 'ephemeral');
  }

  // Without the web there is no search tool, and the marker still goes on.
  {
    const messages = [{ role: 'user', content: search.buildPrompt('q', data, truncated, false) }];
    const c = fake(() => reply('end_turn', done));
    await search.runSearch(c, messages, false);
    assert('a CRM-only search sends no tools', !('tools' in c.calls[0]));
    assert('and still caches the CRM', c.calls[0].messages[0].content[0].cache_control.type === 'ephemeral');
  }
}

continuations().then(cutOffSearch).then(() => {
  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}).catch(err => {
  console.error('\n✗ the async checks threw:', err.message);
  process.exit(1);
});
