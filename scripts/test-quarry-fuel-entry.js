#!/usr/bin/env node
'use strict';
/**
 * How a fuel price gets into a quarry row — what the columns are called, and
 * what stops a day's fuel bill landing in one that means dollars per gallon.
 *
 * Run: node scripts/test-quarry-fuel-entry.js
 *
 * A crushing row stores fuelCost as a PER-GALLON rate — crushCalc, the
 * executive report and quarry-metrics all cost fuel as fuelGallons × fuelCost.
 * The column was headed "Fuel Cost" anyway, with the dollars beside it headed
 * "Total Fuel", and the CSV template shipped a sample of 175 against 50
 * gallons: a $175 fuel bill written into a column that reads it as $175/gal,
 * or $8,750 of fuel. Supervisors entered the day's bill there and the tracker
 * priced the day off it.
 *
 * So the typed column is "$/Gal" and the computed one is "Fuel Cost" — the
 * same words the Daily grid, Analytics and payroll's Edit Quarry Row already
 * use for those two things.
 *
 * The rename reaches the CSV importer, which is where it could go wrong
 * quietly: the template's computed column is now headed "Fuel Cost", which is
 * also the header every previously-downloaded sheet uses for the per-gallon
 * column. Both have to land in the right place, so both are tested.
 *
 * Names are not the whole guard, though. On the grids and in payroll's Edit
 * Quarry Row the Fuel Cost figure recalculates as the rate is typed, so a bill
 * entered there shows up immediately as an absurd number on screen. Two paths
 * have no such tell — a CSV import, whose preview counts rows rather than
 * dollars, and the injection endpoint, whose cap used to be $1,000/gal — so
 * both range-check the rate against a price no pump has charged.
 *
 * No DB, no browser.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const SRC = fs.readFileSync(path.resolve(__dirname, '../quarry.html'), 'utf8');
function slice(from, to, label) {
  const a = SRC.indexOf(from);
  const b = a < 0 ? -1 : SRC.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : to})`);
  return SRC.slice(a, b);
}
// The real normHeader and the real column definitions, lifted out of the page.
const ctx = { todayIso: () => '2026-09-01', console };
vm.createContext(ctx);
vm.runInContext(slice('function normHeader(h)', '\n    function parseCSV(text)', 'normHeader'), ctx);
// `const` in a vm script stays lexical, so hand it out explicitly.
vm.runInContext(slice('const MAX_PER_GALLON =', '\n    const bulkParsed = {};', 'BULK_CONFIGS')
  + '\nglobalThis.BULK_CONFIGS = BULK_CONFIGS;', ctx);
const { normHeader, BULK_CONFIGS } = ctx;

// The header row downloadBulkTemplate writes, for a given config.
function templateHeaders(cfg) {
  return cfg.templateLayout.map(item => {
    if (typeof item === 'string') {
      const f = cfg.fields.find(x => x.name === item);
      return f ? f.label : item;
    }
    return item.label;
  });
}
// parseBulk's column matcher: the normalized label is tried first, then the
// aliases in order, and the first header that hits wins.
function mapColumns(cfg, headers) {
  const headerRow = headers.map(normHeader);
  const colIdx = {};
  cfg.fields.forEach(f => {
    for (const a of [...new Set([normHeader(f.label), ...f.aliases])]) {
      const idx = headerRow.indexOf(a);
      if (idx !== -1) { colIdx[f.name] = idx; break; }
    }
  });
  return colIdx;
}

console.log('Quarry fuel column names\n');

// ── 1) The grids ────────────────────────────────────────────────────────────
console.log('["Fuel Cost" means dollars on every grid]');
{
  const headsOf = cls => {
    const tbl = new RegExp(`<table class="sales-table ${cls}">[\\s\\S]*?</thead>`).exec(SRC);
    return tbl ? [...tbl[0].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1].trim()) : [];
  };
  const crush = headsOf('crush-table');
  const daily = headsOf('daily-table');

  assert('crushing reads Fuel Gallons → $/Gal → Fuel Cost',
    crush.join('|').includes('Fuel Gallons|$/Gal|Fuel Cost'), crush.join(' | '));
  assert('…and no longer heads the per-gallon column "Fuel Cost"',
    crush.indexOf('Fuel Cost') > crush.indexOf('$/Gal'), crush.join(' | '));
  assert('…nor the dollars "Total Fuel"', !crush.includes('Total Fuel'), crush.join(' | '));
  assert('daily still heads its computed dollars "Fuel Cost" too',
    daily.includes('Fuel Cost') && daily.includes('PPG'), daily.join(' | '));
}

// ── 2) The CSV template ─────────────────────────────────────────────────────
console.log('\n[the template the tracker hands out]');
{
  const cfg = BULK_CONFIGS.crushing;
  const heads = templateHeaders(cfg);
  const perGal = cfg.fields.find(f => f.name === 'fuelCost');

  assert('the typed column is headed $/Gal', perGal && perGal.label === '$/Gal',
    perGal && perGal.label);
  assert('the computed column is headed Fuel Cost',
    heads.filter(h => h === 'Fuel Cost').length === 1 && heads.includes('$/Gal'), heads.join(' | '));
  assert('and the two are different columns',
    heads.indexOf('$/Gal') !== heads.indexOf('Fuel Cost'), heads.join(' | '));

  // A sample of 175 in a per-gallon column is what taught the mistake.
  const sample = {};
  cfg.fields.forEach((f, i) => { sample[f.name] = cfg.sample()[i]; });
  const pg = Number(sample.fuelCost), gal = Number(sample.fuelGallons);
  assert('the sample $/Gal is a pump price, not a fuel bill', pg > 0 && pg < 20, String(pg));
  assert('…costing the same $175 of fuel it always meant to', gal * pg === 175,
    `${gal} gal × $${pg} = ${gal * pg}`);
  assert('the sample still lines up with the field list',
    cfg.sample().length === cfg.fields.length,
    `${cfg.sample().length} vs ${cfg.fields.length}`);
}

// ── 3) The importer ─────────────────────────────────────────────────────────
console.log('\n[which column the importer reads the per-gallon rate from]');
{
  const cfg  = BULK_CONFIGS.crushing;
  const now  = templateHeaders(cfg);
  const nowIdx = mapColumns(cfg, now);
  assert('a sheet off the current template reads $/Gal',
    nowIdx.fuelCost === now.indexOf('$/Gal'),
    `column ${nowIdx.fuelCost} of [${now.join(' | ')}]`);
  assert('…and not the computed Fuel Cost column beside it',
    nowIdx.fuelCost !== now.indexOf('Fuel Cost'), String(nowIdx.fuelCost));
  assert('gallons still read from Fuel Gallons',
    nowIdx.fuelGallons === now.indexOf('Fuel Gallons'), String(nowIdx.fuelGallons));

  // Every sheet built before the rename heads that same column "Fuel Cost",
  // with the dollars as "Total Fuel". Those must keep importing.
  const legacy = now.map(h => (h === '$/Gal' ? 'Fuel Cost' : h === 'Fuel Cost' ? 'Total Fuel' : h));
  const legIdx = mapColumns(cfg, legacy);
  assert('a sheet off the old template still reads the same column',
    legIdx.fuelCost === legacy.indexOf('Fuel Cost'),
    `column ${legIdx.fuelCost} of [${legacy.join(' | ')}]`);
  assert('…and does not drift onto Total Fuel',
    legIdx.fuelCost !== legacy.indexOf('Total Fuel'), String(legIdx.fuelCost));

  // PPG is what Daily calls it and what a supervisor is likeliest to type.
  const ppgHeads = now.map(h => (h === '$/Gal' ? 'PPG' : h));
  assert('a PPG header works too',
    mapColumns(cfg, ppgHeads).fuelCost === ppgHeads.indexOf('PPG'));

  // Daily has no field aliased to 'fuelcost', so its computed Fuel Cost column
  // is ignored on import — as it always was.
  const dcfg = BULK_CONFIGS.daily;
  const dHeads = templateHeaders(dcfg);
  const dIdx = mapColumns(dcfg, dHeads);
  assert('daily reads its rate from PPG and ignores its computed Fuel Cost',
    dIdx.ppg === dHeads.indexOf('PPG') &&
    !Object.values(dIdx).includes(dHeads.indexOf('Fuel Cost')),
    JSON.stringify(dIdx));
}

// ── 4) The matcher this test replicates ─────────────────────────────────────
console.log('\n[the replica above still matches parseBulk]');
{
  const parse = slice('function parseBulk(key, text)', '\n      const missing =', 'parseBulk');
  assert('the normalized label is still tried before the aliases',
    /\[\.\.\.new Set\(\[labelAlias, \.\.\.f\.aliases\]\)\]/.test(parse));
  assert('and the first header that hits still wins',
    /const idx = headerRow\.indexOf\(a\);[\s\S]*?break;/.test(parse));
}

// ── 5) The importer's range check ───────────────────────────────────────────
console.log('\n[a fuel bill pasted into the per-gallon column]');
{
  for (const [key, field] of [['crushing', 'fuelCost'], ['daily', 'ppg']]) {
    const f = BULK_CONFIGS[key].fields.find(x => x.name === field);
    assert(`${key}: the per-gallon column carries a ceiling`,
      f && typeof f.max === 'number' && f.max > 0 && f.max <= 25, f && String(f.max));
    assert(`${key}: …that no pump price reaches but every fuel bill clears`,
      f && f.max >= 10, f && String(f.max));
    assert(`${key}: …and says which number the column wants`,
      !!(f && f.maxNote && /per gallon/i.test(f.maxNote)), f && f.maxNote);
  }
  // The check itself lives in parseBulk's num branch, beside the other
  // per-field validations, so a row that trips it is excluded from the import
  // and listed in the preview like any other bad row.
  const numBranch = slice("} else if (f.type === 'num') {", "} else if (f.type === 'list') {", 'num branch');
  assert('parseBulk rejects the row rather than importing it',
    /f\.max != null && n !== '' && n > f\.max/.test(numBranch) && /errors\.push/.test(numBranch),
    numBranch.replace(/\s+/g, ' ').slice(0, 200));
}

// ── 6) The server backstop ──────────────────────────────────────────────────
console.log('\n[and the same number posted to the injection endpoint]');
{
  const { validateQuarryInjection, Q_MAX } = require('../api/timesheet-entries.js')._test;

  assert('ppg and fuelCost are capped at a pump price',
    Q_MAX.ppg <= 25 && Q_MAX.fuelCost <= 25, `ppg ${Q_MAX.ppg}, fuelCost ${Q_MAX.fuelCost}`);

  // 190 gallons at $4.50 — the day the modal is built to record.
  const goodDaily = validateQuarryInjection('daily', { rate: '26', fuelGallons: '190', ppg: '4.50' });
  assert('a real pump price goes through', goodDaily.fields && goodDaily.fields.ppg === 4.5,
    JSON.stringify(goodDaily));
  const goodCrush = validateQuarryInjection('crushing',
    { hourlyRate: '26', hoursCrushing: '5', fuelGallons: '190', fuelCost: '4.50',
      loadsToCrusher: '24', tonsPerLoad: '30' });
  assert('…on crushing too', goodCrush.fields && goodCrush.fields.fuelCost === 4.5,
    JSON.stringify(goodCrush));

  // That same day's fuel bill. It used to be under the $1,000/gal cap, so it
  // saved, and the row priced 190 gallons at $855 each.
  const billDaily = validateQuarryInjection('daily', { rate: '26', fuelGallons: '190', ppg: '855' });
  assert('the day\'s fuel bill is refused', !!billDaily.error, JSON.stringify(billDaily));
  assert('…saying it is a price per gallon, not a total',
    /price per gallon/i.test(billDaily.error || ''), billDaily.error);
  assert('…and what to type instead', /4\.50/.test(billDaily.error || ''), billDaily.error);

  const billCrush = validateQuarryInjection('crushing',
    { hourlyRate: '26', hoursCrushing: '5', fuelGallons: '190', fuelCost: '855',
      loadsToCrusher: '24', tonsPerLoad: '30' });
  assert('crushing refuses it the same way',
    /price per gallon/i.test(billCrush.error || ''), billCrush.error);

  // Fields that are not per-gallon keep their own caps and their plain message.
  const bigRate = validateQuarryInjection('daily', { rate: '99999999', fuelGallons: '1', ppg: '4' });
  assert('an out-of-range rate still reports its own range',
    /rate must be between 0 and/.test(bigRate.error || ''), bigRate.error);
  assert('and gallons are untouched by the fuel-price cap',
    (validateQuarryInjection('daily', { rate: '26', fuelGallons: '900', ppg: '4.50' }).fields || {}).fuelGallons === 900);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
