#!/usr/bin/env node
'use strict';
/**
 * The fuel entry importer's reading half — the part that turns a spreadsheet
 * somebody kept by hand into the thirteen fields the form asks for.
 *
 * Run: node scripts/test-fuel-import.js
 * No DB or server required. scripts/test-fuel-import-sql.js drives the other
 * half — the write — against a real PostgreSQL.
 *
 * Everything here is lifted out of the shipping fuel-admin.html rather than
 * copied into this file, so the code under test IS the code that runs. The
 * last assertion closes the loop the other way: every entry this produces is
 * fed to the server's own normalizeBody and completeness check, so the two
 * halves cannot drift into disagreeing about what a complete fuel entry is.
 *
 * What the tests are really guarding:
 *
 *   - 0 is an ANSWER. Both meter readings are documented on the form as "0 if
 *     not Force Fuel", and a reader that treats a zero cell as an empty one
 *     rejects every card purchase in the file.
 *   - a date is read the way the sheet meant it. 20260504 is a day, not Excel
 *     serial 20,260,504, and reading it as the latter files May's fuel in the
 *     year 57460 without a word.
 *   - nothing is guessed quietly. A value that isn't one of the four cards is
 *     reported against its line number rather than filed under the nearest
 *     thing, because a fill-up under the wrong account is a month that stops
 *     balancing for a reason nobody can see.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');

// The server module is required for the cross-check at the end, and it pulls
// in the neon driver and the auth gate at require time.
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => null };
  if (request === './lib/auth') {
    return { requireAuth: () => null, requireDivision: () => null, hasDivisionAccess: () => true };
  }
  return origLoad.apply(this, arguments);
};
const server = require(path.resolve(__dirname, '..', 'api', 'fuel-submissions.js'))._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// Same two lifters the other fuel suites use: pull a declaration straight out
// of the page's script block and evaluate it here.
function liftConst(src, name) {
  const re = new RegExp(`^\\s{0,6}const ${name} = ([\\s\\S]*?);\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`fuel-admin.html no longer declares ${name}`);
  return m[1];
}

function liftFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`fuel-admin.html no longer defines ${name}()`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`fuel-admin.html: could not find the end of ${name}()`);
}

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'fuel-admin.html'), 'utf8');

const CONSTS = ['FUEL_CARDS', 'FUEL_TYPES', 'US_STATES', 'FIELDS',
                'STATEMENT_COLUMNS', 'IMPORT_COLUMNS', 'CARD_ALIASES', 'TYPE_ALIASES',
                'NOT_ANSWERED', 'MAX_METER_FILL'];
const FNS = ['gallonsFromMeters', 'delimiterFor', 'excelSerialToYmd', 'detectColumns',
             'optKey', 'matchOption', 'importState', 'validYmd', 'importDate', 'importNumber',
             'importInt', 'colLetter', 'splitDelimitedLine', 'parseDelimited', 'pickHeaderRow',
             'readImportGrid', 'buildImportRows'];

const page = new Function(`
  ${CONSTS.map(n => `const ${n} = ${liftConst(SRC, n)};`).join('\n')}
  ${FNS.map(n => liftFn(SRC, n)).join('\n')}
  return { ${CONSTS.concat(FNS).join(', ')} };
`)();

const { FIELDS, FUEL_CARDS, FUEL_TYPES, IMPORT_COLUMNS,
        matchOption, importState, importDate, importNumber, colLetter,
        splitDelimitedLine, parseDelimited, detectColumns, pickHeaderRow,
        readImportGrid, buildImportRows, CARD_ALIASES, TYPE_ALIASES } = page;

// ── 1. Every field the form has is a field the importer can map ─────────────
function coverageTests() {
  console.log('\n[the importer covers the form]');
  const formKeys = FIELDS.map(f => f.key).sort().join(',');
  const impKeys  = Object.keys(IMPORT_COLUMNS).sort().join(',');
  // A field added to the form and forgotten here is a column nobody can point
  // at and a value nobody can supply — the row is simply unimportable, with
  // no message saying why.
  assert('IMPORT_COLUMNS names exactly the thirteen reported fields',
    formKeys === impKeys, `${impKeys}\n      vs ${formKeys}`);
}

// ── 2. Splitting a line ────────────────────────────────────────────────────
function splitTests() {
  console.log('\n[one line into its cells]');
  assert('plain commas', splitDelimitedLine('a,b,c', ',').join('|') === 'a|b|c');
  // The reason quotes are handled at all: a site or an employee written
  // "Smith, John" splits into two half-cells and shifts every column after it
  // by one — the gallons end up read out of the city.
  assert('a comma inside quotes stays put',
    splitDelimitedLine('635,"Smith, John",84.5', ',').join('|') === '635|Smith, John|84.5');
  assert('a doubled quote is one quote',
    splitDelimitedLine('a,"say ""hi""",b', ',')[1] === 'say "hi"');
  assert('an empty trailing cell is still a cell',
    splitDelimitedLine('a,b,', ',').length === 3);
  assert('tabs work the same way',
    splitDelimitedLine('a\tb\tc', '\t').join('|') === 'a|b|c');
}

function colLetterTests() {
  console.log('\n[column letters]');
  assert('0 is A',   colLetter(0)  === 'A');
  assert('25 is Z',  colLetter(25) === 'Z');
  assert('26 is AA', colLetter(26) === 'AA');
  assert('51 is AZ', colLetter(51) === 'AZ');
  assert('52 is BA', colLetter(52) === 'BA');
  // A hand-kept fuel log rarely gets this wide, but a workbook's own columns
  // are named the same way and both paths land in the same grid.
  assert('701 is ZZ', colLetter(701) === 'ZZ');
}

// ── 3. Reading values ──────────────────────────────────────────────────────
function dateTests() {
  console.log('\n[dates, however the sheet writes them]');
  assert('ISO',            importDate('2026-05-04') === '2026-05-04');
  assert('ISO with a time', importDate('2026-05-04T00:00:00') === '2026-05-04');
  assert('slashed ISO',    importDate('2026/05/04') === '2026-05-04');
  assert('US order',       importDate('5/4/2026')  === '2026-05-04');
  assert('US order, dashes', importDate('5-4-2026') === '2026-05-04');
  assert('two-digit year', importDate('5/4/26')    === '2026-05-04');
  assert('zero padded',    importDate('05/04/2026') === '2026-05-04');
  // Excel keeps a date as days since 1899-12-30. Wex's export ships them this
  // way, and a spreadsheet saved as CSV sometimes does too.
  assert('an Excel serial', importDate('46146') === '2026-05-04', importDate('46146'));
  // The ordering trap. Eight digits is a written-out day; read as a serial it
  // would be a date 55,000 years from now, and nothing downstream would blink.
  assert('20260504 is a day, not a serial', importDate('20260504') === '2026-05-04',
    importDate('20260504'));

  assert('an empty cell is no date', importDate('') === null);
  assert('a word is no date',        importDate('n/a') === null);
  // Shaped like a date without being one. Left to the DATE column this is a
  // driver error that takes the rest of the batch with it.
  assert('the 30th of February is refused', importDate('2026-02-30') === null);
  assert('the 13th month is refused',       importDate('2026-13-01') === null);
  assert('and 2/29 in a non-leap year',     importDate('2/29/2026') === null);
  assert('but 2/29 in a leap year is fine', importDate('2/29/2024') === '2024-02-29');
}

function numberTests() {
  console.log('\n[numbers, however the sheet writes them]');
  assert('plain',              importNumber('84.5') === 84.5);
  assert('a dollar sign',      importNumber('$84.50') === 84.5);
  // A thousands separator dropped rather than stripped turns 1,234.5 into
  // 234.5 and under-reports a truck by a thousand gallons.
  assert('a thousands separator', importNumber('1,234.50') === 1234.5);
  assert('padding spaces',     importNumber('  12 ') === 12);
  // The falsy-zero rule, at the point it first has a chance to go wrong.
  assert('zero is zero, not empty', importNumber('0') === 0);
  assert('an empty cell is null',   importNumber('') === null);
  assert('a word is null',          importNumber('none') === null);
}

// ── Real-world cells, taken from four thousand form responses ──────────────
function realCellTests() {
  console.log('\n[cells that decline to answer]');
  const { buildImportRows: build } = page;
  const header = { A: 'Date', B: 'Employee', C: 'Truck #', D: 'Fuel Card Used', E: 'Fuel Type',
                   F: 'Gallons', G: 'Mileage', H: 'Begin Meter', I: 'End Meter',
                   J: 'Site', K: 'City', L: 'State', M: 'Tank Number' };
  const map = detectColumns(header, IMPORT_COLUMNS).found;
  const grid = { labels: header, cols: Object.keys(header), headerLine: 1, firstDataLine: 2, rows: [
    { A: '5/4/2026', B: 'jsmith', C: '635', D: 'Guttman', E: 'Diesel', F: '84.5',
      G: 'N/A', H: '0', I: '0', J: 'Yard', K: 'DuBois', L: 'PA', M: 'Na' },
  ] };

  // "N/A" in a tank number column means what the form means by "0 if not
  // Force Fuel". Read as a value it fails an otherwise perfect row.
  const bare = build(grid, map, {}, { employees: [] });
  assert('N/A is read as unanswered, not as an error',
    bare.problems.length === 1 && !/couldn't read/.test(bare.problems[0].why.join(' ')),
    JSON.stringify(bare.problems));
  const filled = build(grid, map, { tank_number: '0', mileage: '0' }, { employees: [] });
  assert('so a default answers it', filled.ready.length === 1, JSON.stringify(filled.problems));
  assert('and it is counted apart from a truly empty cell',
    filled.notAnswered.tank_number === 1 && filled.notAnswered.mileage === 1,
    JSON.stringify(filled.notAnswered));

  console.log('\n[a zero typed off by one key]');
  // A cell of nothing but the letter O, in a column of numbers. Three rows in
  // the real file, each one otherwise perfect.
  const oh = build(Object.assign({}, grid, { rows: [
    Object.assign({}, grid.rows[0], { H: 'O', I: 'O', G: '100', M: '1' }),
  ] }), map, {}, { employees: [] });
  assert('the letter O in a meter column is a zero',
    oh.ready.length === 1 && oh.ready[0].entry.beginning_meter === 0 && oh.ready[0].entry.ending_meter === 0,
    JSON.stringify(oh.problems));

  console.log('\n[a number inside a description]');
  assert('"908 loader" is machine 908', page.importInt('908 loader').value === 908);
  assert('"Pump 16" is tank 16',        page.importInt('Pump 16').value === 16);
  assert('"315 Ex" is 315',             page.importInt('315 Ex').value === 315);
  assert('and it says it came out of text', page.importInt('908 loader').fromText === true);
  assert('a plain number does not',     page.importInt('635').fromText === undefined);
  assert('"5179.0" is 5179',            page.importInt('5179.0').value === 5179);
  assert('a fraction is still refused', page.importInt('63.5').error === 'not a whole number');
  assert('text with no number in it is refused', page.importInt('loader').error === 'no number in it');
  assert('an empty cell is not an error', page.importInt('').value === null);

  const desc = build(Object.assign({}, grid, { rows: [
    Object.assign({}, grid.rows[0], { C: '908 loader', M: 'Pump 16', G: '100' }),
  ] }), map, {}, { employees: [] });
  assert('a row of them reads', desc.ready.length === 1, JSON.stringify(desc.problems));
  assert('onto the right numbers',
    desc.ready[0].entry.truck_number === 908 && desc.ready[0].entry.tank_number === 16);
  // Counted and shown — reinterpreting a fleet of equipment quietly is not
  // something a preview should do.
  assert('and both are reported as read out of text', desc.fromText.length === 2,
    JSON.stringify(desc.fromText));
}

function nameTests() {
  console.log('\n[a person split across two columns]');
  // What a form export does. Employee is one field, so the pair is offered as
  // one column rather than making somebody edit the sheet first.
  const rows = [
    { A: 'Date', B: 'First Name', C: 'Last Name', D: 'Truck #', E: 'Gallons' },
    { A: '5/4/2026', B: 'Morgan', C: 'Wylie', D: '635', E: '29.16' },
    { A: '5/5/2026', B: 'Cher',   C: '',      D: '636', E: '30' },
  ];
  const grid = readImportGrid(rows);
  assert('the joined column is offered', grid.cols.includes('B+C'), JSON.stringify(grid.cols));
  assert('labelled as both halves', grid.labels['B+C'] === 'First Name + Last Name', grid.labels['B+C']);
  assert('and Employee is detected onto it', grid.found.employee_username === 'B+C',
    grid.found.employee_username);
  assert('the two halves are still selectable on their own',
    grid.cols.includes('B') && grid.cols.includes('C'));

  const out = buildImportRows(grid, { employee_username: 'B+C' }, {}, { employees: [] });
  const names = grid.rows.map(r => r['B+C']);
  assert('the names are joined', names[0] === 'Morgan Wylie', names[0]);
  // A missing half must not leave a trailing space, or the same person
  // becomes two employees in every report.
  assert('and a missing half leaves no stray space', names[1] === 'Cher', JSON.stringify(names[1]));
  assert('the rows still build', out.problems.length === 2, String(out.problems.length));
}

function optionTests() {
  console.log('\n[cards, types and states]');
  assert('an exact card',        matchOption('Guttman', FUEL_CARDS, CARD_ALIASES) === 'Guttman');
  assert('case and spacing do not matter',
    matchOption('  guttman ', FUEL_CARDS, CARD_ALIASES) === 'Guttman');
  // The card list holds an EN DASH. A sheet typed by hand will have a hyphen,
  // or nothing at all where the dash goes.
  assert('a hyphen where the list has an en dash',
    matchOption('Bulk Fuel - No card', FUEL_CARDS, CARD_ALIASES) === 'Bulk Fuel – No card');
  assert('"Bulk" on its own',    matchOption('Bulk', FUEL_CARDS, CARD_ALIASES) === 'Bulk Fuel – No card');
  assert('a card that is not one of the four is refused',
    matchOption('Sunoco', FUEL_CARDS, CARD_ALIASES) === null);
  assert('and an empty cell is refused rather than defaulted',
    matchOption('', FUEL_CARDS, CARD_ALIASES) === null);

  assert('an exact type',        matchOption('Off Road Diesel', FUEL_TYPES, TYPE_ALIASES) === 'Off Road Diesel');
  assert('"off-road"',           matchOption('Off-Road', FUEL_TYPES, TYPE_ALIASES) === 'Off Road Diesel');
  assert('"dyed diesel"',        matchOption('Dyed Diesel', FUEL_TYPES, TYPE_ALIASES) === 'Off Road Diesel');
  assert('"unleaded" is Gas',    matchOption('Unleaded', FUEL_TYPES, TYPE_ALIASES) === 'Gas');
  assert('a type nobody listed is refused',
    matchOption('Kerosene', FUEL_TYPES, TYPE_ALIASES) === null);

  assert('a state code',      importState('PA') === 'PA');
  assert('lower case',        importState('pa') === 'PA');
  assert('a state name',      importState('Pennsylvania') === 'PA');
  assert('a name with a space', importState('west virginia') === 'WV');
  assert('not a state',       importState('XX') === null);
  assert('empty',             importState('') === null);
}

// ── 4. Finding the headings ────────────────────────────────────────────────
const HEADER = {
  A: 'Date', B: 'Employee', C: 'Truck #', D: 'Fuel Card Used', E: 'Fuel Type',
  F: 'Gallons', G: 'Mileage', H: 'Beginning Meter Reading', I: 'Ending Meter Reading',
  J: 'Fueling Site', K: 'City Fueled', L: 'State', M: 'Tank Number',
};

function detectTests() {
  console.log('\n[which column is which]');
  const { found } = detectColumns(HEADER, IMPORT_COLUMNS);
  const want = {
    work_date: 'A', employee_username: 'B', truck_number: 'C', fuel_card: 'D',
    fuel_type: 'E', gallons: 'F', mileage: 'G', beginning_meter: 'H',
    ending_meter: 'I', fueling_site: 'J', city_fueled: 'K', state: 'L', tank_number: 'M',
  };
  for (const [field, col] of Object.entries(want)) {
    assert(`${field} → ${col}`, found[field] === col, `got ${found[field]}`);
  }

  // The two meters are the pair most easily crossed: a pattern loose enough
  // to match "meter" alone takes whichever column comes first, and a month
  // imported with them swapped computes negative fills all the way through.
  const reversed = detectColumns({ A: 'Ending Meter', B: 'Beginning Meter' }, IMPORT_COLUMNS).found;
  assert('the meters are told apart by their own word, not by position',
    reversed.beginning_meter === 'B' && reversed.ending_meter === 'A',
    JSON.stringify(reversed));

  // A column can only answer for one field. Without that, a sheet with both
  // "Truck #" and "Vehicle" hands the same column to two fields and one of
  // them silently reads the other's data.
  const both = detectColumns({ A: 'Truck Number', B: 'Vehicle' }, IMPORT_COLUMNS).found;
  assert('the more specific heading wins the field', both.truck_number === 'A', JSON.stringify(both));

  const sparse = detectColumns({ A: 'Date', B: 'Truck', C: 'Gallons' }, IMPORT_COLUMNS).found;
  assert('a sheet missing most columns maps the ones it has',
    Object.keys(sparse).sort().join(',') === 'gallons,truck_number,work_date',
    JSON.stringify(sparse));
}

function headerRowTests() {
  console.log('\n[finding the heading row]');
  const rows = [
    { A: 'Force Corp — Fuel Log' },
    { A: 'May 2026' },
    {},
    HEADER,
    { A: '5/4/2026', B: 'strickallen', C: '635' },
  ];
  const picked = pickHeaderRow(rows);
  // A sheet somebody printed once carries a title and a date range above the
  // real headings. Taking row 1 on faith reads the title as the header and
  // every data row as unmappable.
  assert('a title and a date line above the headings are skipped', picked.index === 3,
    String(picked.index));

  const grid = readImportGrid(rows);
  assert('the grid starts under the headings', grid.rows.length === 1, String(grid.rows.length));
  // Line numbers are what a problem gets reported against, so they have to be
  // the numbers the office would scroll to — not an index into what survived.
  assert('and its first row is line 5', grid.firstDataLine === 5, String(grid.firstDataLine));
  assert('the heading line is named too', grid.headerLine === 4, String(grid.headerLine));

  const junk = readImportGrid([{ A: 'hello', B: 'world' }, { A: 'x' }]);
  assert('a file with no headings at all is refused, showing what it did read',
    /Couldn't find a heading row/.test(junk.error || '') && /hello/.test(junk.error || ''),
    junk.error);
}

function delimitedTests() {
  console.log('\n[a pasted block]');
  const text = 'Date,Employee,Truck #,Gallons\n5/4/2026,strickallen,635,"1,084.50"\n';
  const rows = parseDelimited(text);
  assert('two rows read', rows.length === 2, String(rows.length));
  assert('headings land in A…D', rows[0].A === 'Date' && rows[0].D === 'Gallons');
  assert('a quoted thousands separator survives', rows[1].D === '1,084.50', rows[1].D);

  const tabbed = parseDelimited('Date\tTruck #\n5/4/2026\t635');
  assert('tabs are picked over commas', tabbed[1].B === '635', JSON.stringify(tabbed[1]));

  assert('blank lines are dropped', parseDelimited('a,b\n\n\nc,d').length === 2);
  assert('nothing at all is no rows', parseDelimited('').length === 0);
}

// ── 5. The whole read ──────────────────────────────────────────────────────
const CTX = { employees: ['strickallen', 'dhoover'] };

function gridOf(header, ...dataRows) {
  return {
    labels: header,
    cols: Object.keys(header),
    rows: dataRows,
    headerLine: 1,
    firstDataLine: 2,
  };
}

const MAP = Object.fromEntries(Object.entries(detectColumns(HEADER, IMPORT_COLUMNS).found));

function buildTests() {
  console.log('\n[a sheet into entries]');
  const grid = gridOf(HEADER,
    { A: '5/4/2026',  B: 'strickallen', C: '635',  D: 'Guttman', E: 'Off Road Diesel',
      F: '84.5', G: '132480', H: '0', I: '0', J: 'Guttman Clearfield', K: 'Clearfield', L: 'PA', M: '0' },
    { A: '5/11/2026', B: 'DHoover',     C: '2409', D: 'Wex',     E: 'Diesel',
      F: '61.2', G: '98110',  H: '0', I: '0', J: 'Wex Dubois', K: 'DuBois', L: 'Pennsylvania', M: '0' },
    {},
  );
  const out = buildImportRows(grid, MAP, {}, CTX);

  assert('two entries', out.ready.length === 2, JSON.stringify(out.problems));
  assert('the blank row is counted, not complained about', out.blank === 1 && out.problems.length === 0);

  const [a, b] = out.ready.map(r => r.entry);
  assert('the date is normalised', a.work_date === '2026-05-04', a.work_date);
  assert('the truck is a number',  a.truck_number === 635 && typeof a.truck_number === 'number');
  assert('the state name became a code', b.state === 'PA', b.state);
  // Spelling taken from the roster, or the same person becomes two employees
  // in every filter and by-employee total from here on.
  assert('the employee is spelled the way the roster does', b.employee_username === 'dhoover',
    b.employee_username);
  // The rule the whole feature turns on, at the last place it can go wrong.
  assert('a 0 meter stays 0 rather than becoming empty',
    a.beginning_meter === 0 && a.ending_meter === 0 && a.tank_number === 0,
    JSON.stringify([a.beginning_meter, a.ending_meter, a.tank_number]));
  assert('and the row is complete because of it', out.problems.length === 0);

  assert('lines are reported against the sheet', out.ready[0].line === 2 && out.ready[1].line === 3,
    JSON.stringify(out.ready.map(r => r.line)));
}

function meterTests() {
  console.log('\n[gallons off the tank meter]');
  const grid = gridOf(HEADER,
    { A: '5/4/2026', B: 'strickallen', C: '88', D: 'Bulk Fuel - No card', E: 'Off Road Diesel',
      F: '10', G: '1000', H: '18240.5', I: '18325', J: 'Force Yard', K: 'DuBois', L: 'PA', M: '2' });
  const out = buildImportRows(grid, MAP, {}, CTX);
  // The preview has to show the figure that will be STORED. The server
  // recomputes this on write either way, so a preview that showed the sheet's
  // 10 would be showing a number nobody ever signed off on.
  assert('the meter wins over the gallons column', out.ready[0].entry.gallons === 84.5,
    String(out.ready[0].entry.gallons));
}

function defaultsTests() {
  console.log('\n[a sheet that is missing a column]');
  // The common case by far: a hand-kept log has no tank number and no meter
  // readings, because nothing on a card purchase has either.
  const header = { A: 'Date', B: 'Employee', C: 'Truck #', D: 'Fuel Card Used',
                   E: 'Fuel Type', F: 'Gallons', G: 'Mileage', H: 'Site', I: 'City', J: 'State' };
  const map = detectColumns(header, IMPORT_COLUMNS).found;
  const grid = gridOf(header,
    { A: '5/4/2026', B: 'strickallen', C: '635', D: 'Guttman', E: 'Diesel',
      F: '84.5', G: '132480', H: 'Guttman Clearfield', I: 'Clearfield', J: 'PA' });

  const without = buildImportRows(grid, map, {}, CTX);
  assert('with nothing supplied the row is a problem, not a guess',
    without.ready.length === 0 && without.problems.length === 1, JSON.stringify(without.problems));
  assert('and it says which fields it could not answer',
    /beginning meter/.test(without.problems[0].why.join('; ')) &&
    /tank number/.test(without.problems[0].why.join('; ')),
    without.problems[0].why.join('; '));

  const withDefaults = buildImportRows(grid, map,
    { beginning_meter: '0', ending_meter: '0', tank_number: '0' }, CTX);
  assert('supplying 0 for the three makes it importable', withDefaults.ready.length === 1,
    JSON.stringify(withDefaults.problems));
  // Counted and shown, never silent: "0 used on 137 rows" has to be on screen
  // rather than inferred from a total that happened to come out right.
  assert('and every field filled in that way is counted',
    withDefaults.defaulted.beginning_meter === 1 &&
    withDefaults.defaulted.ending_meter === 1 &&
    withDefaults.defaulted.tank_number === 1,
    JSON.stringify(withDefaults.defaulted));

  // A default also covers a blank cell in a column that DOES exist — same
  // reasoning, and the count says how often it happened.
  const holes = gridOf(HEADER,
    { A: '5/4/2026', B: 'strickallen', C: '635', D: 'Guttman', E: 'Diesel',
      F: '84.5', G: '132480', H: '0', I: '0', J: 'Site', K: 'Clearfield', L: 'PA', M: '' });
  const filled = buildImportRows(holes, MAP, { tank_number: '0' }, CTX);
  assert('a blank cell falls back to the same value', filled.ready.length === 1);
  assert('and is counted with the rest', filled.defaulted.tank_number === 1);

  // Blankness is judged on the FILE, before defaults are applied. Judged
  // after, a single default makes every trailing empty row look half-filled,
  // and a clean import ends with a problem list full of rows that aren't
  // there — each one reporting the twelve fields it also doesn't have.
  const trailing = gridOf(HEADER,
    { A: '5/4/2026', B: 'strickallen', C: '635', D: 'Guttman', E: 'Diesel',
      F: '84.5', G: '1', H: '0', I: '0', J: 'S', K: 'C', L: 'PA', M: '0' },
    {}, {}, {});
  const out = buildImportRows(trailing, MAP, { tank_number: '0', beginning_meter: '0' }, CTX);
  assert('trailing blank rows stay blank even with defaults set',
    out.blank === 3 && out.problems.length === 0 && out.ready.length === 1,
    `blank=${out.blank} problems=${out.problems.length} ready=${out.ready.length}`);
}

function problemTests() {
  console.log('\n[rows that cannot be read]');
  const grid = gridOf(HEADER,
    { A: 'sometime',  B: 'strickallen', C: '635', D: 'Guttman', E: 'Diesel',
      F: '84.5', G: '1', H: '0', I: '0', J: 'S', K: 'C', L: 'PA', M: '0' },
    { A: '5/4/2026',  B: 'strickallen', C: '635', D: 'Sunoco',  E: 'Kerosene',
      F: '84.5', G: '1', H: '0', I: '0', J: 'S', K: 'C', L: 'PA', M: '0' },
    { A: '5/5/2026',  B: 'strickallen', C: '63.5', D: 'Guttman', E: 'Diesel',
      F: '84.5', G: '1', H: '0', I: '0', J: 'S', K: 'C', L: 'PA', M: '0' },
    { A: '5/6/2026',  B: 'strickallen', C: '635', D: 'Guttman', E: 'Diesel',
      F: '-4',   G: '1', H: '0', I: '0', J: 'S', K: 'C', L: 'PA', M: '0' },
    { A: '5/7/2026',  B: 'newhire',     C: '635', D: 'Guttman', E: 'Diesel',
      F: '84.5', G: '1', H: '0', I: '0', J: 'S', K: 'C', L: 'PA', M: '0' },
  );
  const out = buildImportRows(grid, MAP, {}, CTX);
  const why = i => (out.problems.find(p => p.line === i) || { why: [] }).why.join('; ');

  assert('an unreadable date is a problem, quoting the cell',
    /couldn't read the date "sometime"/.test(why(2)), why(2));
  // Both are reported on the same row rather than stopping at the first. The
  // office fixes a sheet in one pass, not one message at a time.
  assert('a bad card and a bad type are both reported',
    /not one of the fuel cards/.test(why(3)) && /not one of the fuel types/.test(why(3)), why(3));
  assert('a fractional truck number is refused',
    /not a whole number/.test(why(4)), why(4));
  assert('a negative gallons figure is refused', /gallons is negative/.test(why(5)), why(5));
  assert('five rows in, one still readable', out.ready.length === 1, JSON.stringify(out.ready));

  // A name nobody recognises is NOT a rejection — the fill-up still happened,
  // and the truck, card, gallons and date are what a statement is matched on.
  // It is flagged so the file can be fixed before the by-employee report is
  // read as gospel.
  assert('an unknown employee is flagged, not refused',
    out.ready[0].entry.employee_username === 'newhire' &&
    out.unknownEmployees.length === 1 && out.unknownEmployees[0].name === 'newhire',
    JSON.stringify(out.unknownEmployees));
}

// ── 6. The two halves agree ────────────────────────────────────────────────
function serverAgreementTests() {
  console.log('\n[what the page builds, the server accepts]');
  const grid = gridOf(HEADER,
    { A: '5/4/2026',  B: 'strickallen', C: '635',  D: 'Guttman', E: 'Off Road Diesel',
      F: '84.5', G: '132480', H: '0', I: '0', J: 'Guttman Clearfield', K: 'Clearfield', L: 'PA', M: '0' },
    { A: '5/11/2026', B: 'dhoover',     C: '2409', D: 'Bulk Fuel - No card', E: 'Gas',
      F: '12',   G: '98110',  H: '18240.5', I: '18325', J: 'Force Yard', K: 'DuBois', L: 'pennsylvania', M: '2' },
  );
  const out = buildImportRows(grid, MAP, {}, CTX);
  assert('both rows read', out.ready.length === 2, JSON.stringify(out.problems));

  for (const { line, entry } of out.ready) {
    const { data, error } = server.normalizeBody(entry);
    assert(`line ${line}: the server takes it without complaint`, !error, error);
    if (error) continue;
    const missing = server.missingFields(data);
    // The page counting a row as ready and the server calling it incomplete
    // is the one failure mode a preview cannot warn about: it shows a clean
    // import and the batch comes back half-rejected.
    assert(`line ${line}: and calls it complete`, missing.length === 0, missing.join(', '));
    assert(`line ${line}: with the gallons the preview showed`,
      data.gallons === entry.gallons, `${data.gallons} vs ${entry.gallons}`);
    assert(`line ${line}: and the date the preview showed`,
      data.work_date === entry.work_date, `${data.work_date} vs ${entry.work_date}`);
  }

  // The page's own idea of a duplicate has to be the server's, or the preview
  // promises rows the import then quietly skips.
  const [first, second] = out.ready.map(r => r.entry);
  assert('two different fill-ups are two different keys',
    server.importKey(first) !== server.importKey(second));
  assert('and the same one twice is one key',
    server.importKey(first) === server.importKey(Object.assign({}, first, { fueling_site: 'typed differently' })));
}

function batchTests() {
  console.log('\n[batch ids]');
  assert('an ordinary one is kept',        server.safeBatch('imp1a2b3c') === 'imp1a2b3c');
  assert('dashes and dots are fine',       server.safeBatch('may-2026.1') === 'may-2026.1');
  // It is compared against stored rows and echoed back to the page, so it is
  // constrained rather than trusted.
  assert('a space is refused',             server.safeBatch('may 2026') === null);
  assert('a quote is refused',             server.safeBatch("a'b") === null);
  assert('empty is refused',               server.safeBatch('') === null);
  assert('and it is length-capped',        server.safeBatch('x'.repeat(200)) === null);
}

coverageTests();
splitTests();
colLetterTests();
dateTests();
numberTests();
realCellTests();
nameTests();
optionTests();
detectTests();
headerRowTests();
delimitedTests();
buildTests();
meterTests();
defaultsTests();
problemTests();
serverAgreementTests();
batchTests();

console.log(`\n${'─'.repeat(40)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(40)}`);
process.exit(failed ? 1 : 0);
