#!/usr/bin/env node
'use strict';
/**
 * The one reading of a typed number, and the six copies of it.
 *
 * Run: node scripts/test-numeric.js
 *
 * Every figure in this app arrives as a STRING — typed on a phone, pasted off a
 * supplier's invoice, read off a photographed receipt, or imported from a
 * spreadsheet export. parseFloat stops at the first character it does not
 * understand, so a comma is silently destructive rather than an error, and the
 * three importers that tried to cope by stripping commas as thousands
 * separators were worse: that multiplies a decimal comma by a hundred.
 *
 * api/lib/numeric.js holds the reading. The pages carry no module loader, so
 * five of them carry a COPY, and copies drift. That is what this suite exists
 * for: it runs every copy over ONE table of cases and fails if any two of them
 * disagree, so a change to one is a red build rather than two screens quietly
 * showing different money.
 *
 * Then it runs the three importers that had the hundredfold bug, as functions,
 * on the values that caused it.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn } = require('./lib/fn-source');

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

let failed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail) console.error('      ' + String(detail).slice(0, 400));
};

const server = require('../api/lib/numeric');

/** Lift one function out of a page and hand back something callable. */
function lift(file, name, sandbox) {
  const ctx = vm.createContext(sandbox || {});
  vm.runInContext(requireFn(read(file), name, file) + `;this.f = ${name};`, ctx);
  return vm.runInContext('f', ctx);
}

// ── every copy reads a number the same way ─────────────────────────────────
console.log('\n[every copy of the rule reads a number the same way]');

// Where the reading lives, and what each copy decides. A disagreement between
// any two of these is one order, one bid line or one job costing differently
// depending on which screen you are looking at.
const COPIES = [
  ['api/lib/numeric.js',   'normalizeNumeric',  'what the database stores'],
  ['purchase-orders.html', 'normalizeNumeric',  'what central purchasing sees'],
  ['tracker.html',         '_normalizeNumeric', 'what turf sees'],
  ['paving.html',          '_normalizeNumeric', 'what paving sees'],
  ['kiewit-pinetree.html', '_normalizeNumeric', 'what kiewit sees'],
  ['dust.html',            '_normalizeNumeric', 'what the dust tickets import as'],
];

const fns = COPIES.map(([file, name, what]) => [
  file,
  file.endsWith('.js') ? server.normalizeNumeric : lift(file, name),
  what,
]);
assert(`all ${COPIES.length} copies of the rule were found`, fns.length === COPIES.length);

// input, what the number is, why it turns up
const CASES = [
  ['360.82',        360.82,     'a plain US amount'],
  [360.82,          360.82,     'a number something upstream already parsed'],
  ['0',             0,          'zero'],
  ['8.5',           8.5,        'a tonnage'],
  // The bug all of this exists for. parseFloat gives 360 and the cents vanish;
  // stripping commas as thousands separators gives 36082, a hundred times the
  // real amount, which is what the importers and the receipt reader did.
  ['360,82',        360.82,     'a till or keyboard set to a decimal-comma region'],
  ['8,5',           8.5,        'the same, on a tonnage'],
  ['-360,82',       -360.82,    'a credit on such a till'],
  ['0,00',          0,          'a zero line on such a till'],
  // Both separators present: whichever comes LAST is the decimal one, which
  // reads either convention right without being told a locale.
  ['1,234.56',      1234.56,    'a US invoice over a thousand dollars'],
  ['1.234,56',      1234.56,    'a European invoice for the same amount'],
  ['1,234,567.89',  1234567.89, 'a US figure in the millions'],
  ['1.234.567,89',  1234567.89, 'the European spelling of it'],
  ['$1,234.56',     1234.56,    'pasted with the dollar sign still on it'],
  ['$81,760.70',    81760.70,   'the exact case the importers were written for'],
  ['\u20ac1.234,56',   1234.56,    'pasted off a euro invoice'],
  ['\u00a31,234.56',   1234.56,    'and off a sterling one'],
  ['1 234,56',      1234.56,    'a space as the thousands separator'],
  ['1\u00a0234,56',    1234.56,    'the same, with the non-breaking space a PDF pastes'],
  ["1'234.56",      1234.56,    'the apostrophe a Swiss supplier prints'],
  ['(76.50)',       -76.50,     'accounting notation for a credit'],
  ['(1.234,56)',    -1234.56,   'both at once'],
  ['  42  ',        42,         'padded with spaces'],
  // The genuinely ambiguous pair. No rule can read both the way everyone means
  // them, so they resolve the way a US crew writes them.
  ['1,234',         1234,       'a thousands separator and no cents'],
  ['1.234',         1.234,      'three decimal places'],
  ['12,345,678',    12345678,   'grouped thousands with no decimal at all'],
];

{
  let disagreed = 0, wrong = 0;
  CASES.forEach(([input, want, why]) => {
    const answers = fns.map(([file, fn]) => [file, fn(input)]);
    const first = answers[0][1];
    if (answers.some(([, v]) => v !== first)) {
      disagreed++;
      assert(`the copies agree on ${JSON.stringify(input)}`, false,
        answers.map(([f, v]) => `${f} -> ${JSON.stringify(v)}`).join(' | '));
      return;
    }
    const got = parseFloat(first);
    if (Math.abs(got - want) > 1e-9) {
      wrong++;
      assert(`${JSON.stringify(input)} is ${want} — ${why}`, false, `got ${got}`);
    }
  });
  assert(`all ${CASES.length} cases read the same in all ${fns.length} copies`, disagreed === 0);
  assert(`all ${CASES.length} cases read the right number`, wrong === 0);
}

// Nothing usable stays nothing usable, so a blank field stays blank rather than
// becoming a zero-dollar line that reads as a real one.
console.log('\n[a field with nothing usable in it]');
['', '   ', null, undefined, 'abc', '$', '()'].forEach(v => {
  assert(`${JSON.stringify(v)} is not a number`, isNaN(server.numeric(v)));
  assert(`${JSON.stringify(v)} is 0 for the cost arithmetic`, server.numericOrZero(v) === 0);
});

// ── the Procore estimate import ────────────────────────────────────────────
// A bid quantity is the denominator of percent-complete and of the labour hours
// per unit the job's production is modelled from, so a tenfold error here hides
// inside a ratio instead of showing up as a dollar figure somebody queries.
console.log('\n[a Procore estimate exported as CSV]');
['tracker.html', 'paving.html', 'kiewit-pinetree.html'].forEach(file => {
  const pcNum = lift(file, '_pcNum', { _normalizeNumeric: lift(file, '_normalizeNumeric') });
  assert(`${file}: a US unit cost still reads as it always did`, pcNum('$81,760.70') === 81760.70);
  assert(`${file}: a decimal-comma unit cost is $360.82, not $36,082`, pcNum('360,82') === 360.82);
  assert(`${file}: a quantity of "8,5" is 8.5, not 85`,                pcNum('8,5') === 8.5);
  assert(`${file}: a European figure over a thousand is not divided`,  pcNum('1.234,56') === 1234.56);
  assert(`${file}: a bracketed figure is still negative`,              pcNum('(76.50)') === -76.50);
  // The null cases are load-bearing: they are what stops an estimate's
  // "Profit" / "Total labor" summary rows becoming bid line items.
  assert(`${file}: a label row is still not a number`,
    pcNum('Profit') === null && pcNum('Total labor') === null);
  assert(`${file}: and an empty cell likewise`, pcNum('') === null && pcNum(null) === null);
  assert(`${file}: the unconditional comma strip is gone`,
    !/replace\(\/\[\$,\\s\]\/g/.test(read(file)), `${file} still strips every comma`);
});

// ── the daily-row CSV import ───────────────────────────────────────────────
// Thirteen numeric fields, including a labour rate and a total cost, so this
// one reached payroll figures and not only material cost.
console.log('\n[a daily-row sheet exported as CSV]');
['tracker.html', 'paving.html', 'kiewit-pinetree.html'].forEach(file => {
  const src = read(file);
  assert(`${file}: numeric cells go through the shared reading`,
    /if \(NUMERIC_FIELDS\.has\(field\)\) val = _normalizeNumeric\(val\);/.test(src));
  assert(`${file}: the old thousands-separator strip is gone`,
    !/replace\(\/,\(\?=\\d\)\/g/.test(src), `${file} still strips a comma before a digit`);
  // A labour rate and a total cost are in the set, not just material figures.
  const set = /const NUMERIC_FIELDS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  assert(`${file}: the rate and total cost are covered`,
    !!set && /'rate'/.test(set[1]) && /'total_cost'/.test(set[1]) && /'quantity'/.test(set[1]));

  // And the reading the importer now uses, on what a sheet actually carries.
  const norm = lift(file, '_normalizeNumeric');
  assert(`${file}: "$81,760.70" still imports as 81760.70`, parseFloat(norm('$81,760.70')) === 81760.70);
  assert(`${file}: a rate of "360,82" imports as 360.82, not 36082`, parseFloat(norm('360,82')) === 360.82);
  assert(`${file}: it is STORED canonically, so nothing downstream guesses`,
    norm('$81,760.70') === '81760.70' && norm('360,82') === '360.82');
});

// ── …and the whole importer, driven end to end ────────────────────────
// The checks above read the call site and run the function it calls. That pair
// misses the one thing that matters most — what a row actually carries once it
// has been through the importer — and this is the path that writes a LABOUR
// RATE, so it gets driven with a real file rather than inspected.
console.log('\n[an imported daily row, end to end]');
{
  const file = 'tracker.html';
  const src  = read(file);

  // A sheet a US crew would export, and the same sheet off a machine whose
  // region uses a decimal comma. Same money, written two ways.
  const HEADER = 'Date,Project,Cost Code,Job Class,Rate,Labor Hours,Units Purchased,Unit Cost,Quantity,Total Cost';
  const SHEETS = {
    'a US export':       HEADER + '\n2026-09-17,Route 30,420,Operator,"$52.75",8,"1,250","$81,760.70","2,400","$98,112.84"',
    'a comma-region one': HEADER + '\n2026-09-17,Route 30,420,Operator,"52,75",8,"1250","360,82","8,5","2885,60"',
  };

  const runImport = csvText => {
    const ctx = vm.createContext({ console, JSON, Math, Number, parseFloat, isNaN, Set, Date, String });
    vm.runInContext(`
      // The page's own collaborators, stubbed only where they touch the DOM.
      const projectsList = [{ id: 'p1', 'project-name': 'Route 30', 'job-number': '30' }];
      let previewed = null;
      function uid() { return 'row1'; }
      function _renderImportPreview(h, m, parsed, skipped) { previewed = { parsed, skipped }; }
      const document = {
        getElementById: id => {
          if (id === 'csv-import-file')    return { files: [{ name: 'sheet.csv' }] };
          if (id === 'csv-import-project') return { value: 'p1' };
          return null;                       // no auto-create checkbox
        },
      };
      function alert(m) { throw new Error('importer alerted: ' + m); }
      class FileReader {
        readAsText() { this.onload({ target: { result: CSV_TEXT } }); }
      }
    `, ctx);
    vm.runInContext('const CSV_TEXT = ' + JSON.stringify(csvText) + ';', ctx);
    ['_csvNorm', '_normalizeNumeric', '_parseCSVLine', '_resolveImportProject', 'parseImportCSV']
      .forEach(n => vm.runInContext(requireFn(src, n, file), ctx));
    // CSV_COL_MAP is a const object, not a function — lift it by its braces.
    const mapStart = src.indexOf('const CSV_COL_MAP = {');
    const mapEnd   = src.indexOf('\n};', mapStart) + 3;
    vm.runInContext(src.slice(mapStart, mapEnd), ctx);
    vm.runInContext('parseImportCSV();', ctx);
    return vm.runInContext('previewed', ctx);
  };

  const out = {};
  Object.keys(SHEETS).forEach(label => {
    const r = runImport(SHEETS[label]);
    assert(`${label}: the row imported at all`,
      !!r && r.parsed.length === 1, r && JSON.stringify(r.skipped));
    out[label] = r && r.parsed[0] && r.parsed[0].row;
  });

  const us = out['a US export'], eu = out['a comma-region one'];

  // The US sheet is the case the old strip was written for. It must not move.
  assert('a US labour rate is still $52.75',        parseFloat(us.rate) === 52.75);
  assert('a US unit cost is still $81,760.70',      parseFloat(us.unit_cost) === 81760.70);
  assert('a US quantity is still 2,400',            parseFloat(us.quantity) === 2400);
  assert('a US total is still $98,112.84',          parseFloat(us.total_cost) === 98112.84);
  assert('and units purchased still 1,250',         parseFloat(us.units_purchased) === 1250);

  // The comma-region sheet is what used to come in a hundredfold wrong.
  assert('a labour rate of "52,75" imports as $52.75, not $5,275',
    parseFloat(eu.rate) === 52.75, eu.rate);
  assert('a unit cost of "360,82" imports as $360.82, not $36,082',
    parseFloat(eu.unit_cost) === 360.82, eu.unit_cost);
  assert('a quantity of "8,5" imports as 8.5, not 85',
    parseFloat(eu.quantity) === 8.5, eu.quantity);
  assert('a total of "2885,60" imports as $2,885.60, not $288,560',
    parseFloat(eu.total_cost) === 2885.60, eu.total_cost);

  // Stored canonically, so every later parseFloat on the row is safe whatever
  // it does — that is what keeps the ~150 display sites out of this.
  assert('the stored row carries a canonical number, not the typed text',
    eu.rate === '52.75' && eu.unit_cost === '360.82' && eu.quantity === '8.5',
    JSON.stringify({ rate: eu.rate, unit_cost: eu.unit_cost, quantity: eu.quantity }));

  // Non-numeric columns are untouched by any of it.
  assert('the text columns come through as written',
    us.job_class === 'Operator' && us.cost_code === '420' && us.date === '2026-09-17',
    JSON.stringify(us));
}

// ── the dust ticket import ─────────────────────────────────────────────────
console.log('\n[a dust ticket sheet]');
{
  const importParseNum = lift('dust.html', 'importParseNum',
    { _normalizeNumeric: lift('dust.html', '_normalizeNumeric') });
  assert('a US vehicle rate reads as it always did',    importParseNum('$1,234.56') === 1234.56);
  assert('a rate of "360,82" is 360.82, not 36,082',    importParseNum('360,82') === 360.82);
  assert('gallons of "1.234,56" are 1234.56',           importParseNum('1.234,56') === 1234.56);
  assert('a blank cell is still blank, not zero',       importParseNum('') === '' && importParseNum('   ') === '');
  assert('and an unreadable one likewise',              importParseNum('n/a') === '');
  assert('the unconditional comma strip is gone',
    !/replace\(\/\[\$,\\s\]\/g/.test(read('dust.html')), 'dust.html still strips every comma');
}

console.log(`\n${failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'}`);
process.exit(failed ? 1 : 0);
