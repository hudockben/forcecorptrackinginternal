#!/usr/bin/env node
'use strict';
/**
 * What the quarry tracker calls the two fuel numbers.
 *
 * Run: node scripts/test-quarry-fuel-headers.js
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
vm.runInContext(slice('const BULK_CONFIGS = {', '\n    const bulkParsed = {};', 'BULK_CONFIGS')
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
