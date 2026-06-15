#!/usr/bin/env node
'use strict';
/**
 * Audit/regression test for dust per-customer rates persistence + logic.
 *
 * Run: node scripts/test-dust-rates-audit.js
 *
 * Covers the two features:
 *   1. Per-customer UB $/gal override (dust_companies.ub_rate) — must be
 *      saved, retrieved, and applied everywhere UB revenue is computed
 *      (dust calc, intercompany, executive report), with global fallback.
 *   2. Vehicle-rate back-fill — blank V1/V2 rates filled from the customer's
 *      defaults on load, without touching invoiced rows or non-blank rates.
 *
 * Part A pins the column through every save/retrieve seam so a partial edit
 * can't silently drop it. Part B executes the *actual* shipped functions
 * (extracted from the HTML) against crafted inputs.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n[${t}]`); }

/** Pull a function's full source out of a file by signature, balancing braces.
 *  Skips strings, template literals, and // and /* *\/ comments so stray
 *  braces/quotes/apostrophes inside them don't throw off the depth count. */
function extractFn(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  let i = src.indexOf('{', start), depth = 0;
  let inStr = null, inTmpl = false, inLine = false, inBlock = false, esc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === inStr) inStr = null; continue; }
    if (inTmpl) { if (c === '`') inTmpl = false; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTmpl = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { return src.slice(start, i + 1); } }
  }
  throw new Error(`unbalanced braces for ${signature}`);
}

const dustHtml = read('dust.html');
const icHtml   = read('intercompany.html');
const cfgJs    = read('api/dust-config.js');
const reportJs = read('api/executive/report.js');
const schema   = read('neon-schema.sql');

// ──────────────────────────────────────────────────────────────────────────
section('A. ub_rate threaded through every save/retrieve seam');

// Schema
assert('schema: dust_companies has ub_rate column',
  /ub_rate\s+NUMERIC\(10,4\)/.test(schema) && /ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS ub_rate/.test(schema));

// dust-config.js — write + read paths
assert('dust-config: ensures ub_rate column on cold start',
  /ADD COLUMN IF NOT EXISTS ub_rate/.test(cfgJs));
assert('dust-config GET: maps co.ub_rate into company object',
  /ub_rate:\s*co\.ub_rate != null \? parseFloat\(co\.ub_rate\) : null/.test(cfgJs));
assert('dust-config PUT: INSERT column list includes ub_rate',
  /INSERT INTO dust_companies \(id, company_code, name, tier, v1_rate, v2_rate, ub_rate, sort_order\)/.test(cfgJs));
assert('dust-config PUT: VALUES bind safeFloat(co.ub_rate)',
  /safeFloat\(co\.v2_rate\)\},\s*\$\{safeFloat\(co\.ub_rate\)\}/.test(cfgJs));
assert('dust-config PUT: ON CONFLICT updates ub_rate',
  /ub_rate\s*=\s*EXCLUDED\.ub_rate/.test(cfgJs));

// dust.html — apply path
assert('dust.html: calc() uses ubRateForRow(row), not the bare global',
  /const ubTotal\s*=\s*round2\(gallons \* ubRateForRow\(row\)\)/.test(dustHtml));
assert('dust.html: Manage Lists exposes a UB $/gal input bound to ub_rate',
  /updateCompanyRate\('\$\{co\.id\}','ub_rate'/.test(dustHtml));
assert('dust.html: config poller refreshes companies (incl. ub_rate)',
  /incoming\s*=\s*\{[\s\S]*?companies:\s*Array\.isArray\(lists\.companies\)/.test(dustHtml));

// intercompany.html — apply path
assert('intercompany: loads per-customer overrides from dust-config',
  /map\[String\(co\.name\)\.trim\(\)\.toLowerCase\(\)\]\s*=\s*r/.test(icHtml));
assert('intercompany: no dust UB term still multiplies by the bare icUbRate',
  !/gallons_ub[^\n]*\*\s*icUbRate/.test(icHtml),
  'a dust UB computation still uses icUbRate directly');
assert('intercompany: dust UB terms route through dustUbRateFor()',
  (icHtml.match(/\* dustUbRateFor\(/g) || []).length >= 6);

// executive report — apply path
assert('executive report: joins dust_companies for per-customer rate',
  /LEFT JOIN dust_companies c\s*\n\s*ON c\.company_code = d\.company_code AND c\.name = d\.company/.test(reportJs));
assert('executive report: COALESCEs co rate over settings rate (x2 queries)',
  (reportJs.match(/COALESCE\(co_ub_rate, \(SELECT ub_rate::float FROM dust_settings WHERE company_code = \$\{companyCode\}\), 0\)/g) || []).length === 2);
assert('executive report: ensures ub_rate column before querying',
  /ALTER TABLE IF EXISTS dust_companies ADD COLUMN IF NOT EXISTS ub_rate/.test(reportJs));

// ──────────────────────────────────────────────────────────────────────────
section('B. ubRateForRow() — customer override wins, else global');

const sandbox = { dustLists: { companies: [] }, ubRate: 0, rows: [] };
vm.createContext(sandbox);
vm.runInContext(extractFn(dustHtml, 'function ubRateForRow(row)'), sandbox);
vm.runInContext(extractFn(dustHtml, 'function materializeCompanyVehicleRates()'), sandbox);

sandbox.ubRate = 1.28;
sandbox.dustLists.companies = [
  { name: 'Kiewit',  ub_rate: 1.55, v1_rate: 175, v2_rate: null },
  { name: 'CNX',     ub_rate: null, v1_rate: 130, v2_rate: 130 },
  { name: 'FreeJob', ub_rate: 0,    v1_rate: null, v2_rate: null },
];
const ubFor = r => vm.runInContext('ubRateForRow(' + JSON.stringify(r) + ')', sandbox);

assert('customer with override (Kiewit) bills at its own rate', ubFor({ company: 'Kiewit' }) === 1.55);
assert('customer without override (CNX) falls back to global 1.28', ubFor({ company: 'CNX' }) === 1.28);
assert('explicit $0 override is honored (not treated as unset)', ubFor({ company: 'FreeJob' }) === 0);
assert('unknown / stranded company falls back to global', ubFor({ company: 'Nobody' }) === 1.28);
assert('blank company falls back to global', ubFor({ company: '' }) === 1.28);
sandbox.ubRate = 0;
assert('with global 0 and no override, rate is 0 (UB total → $0)', ubFor({ company: 'CNX' }) === 0);
sandbox.ubRate = 1.28;

// ──────────────────────────────────────────────────────────────────────────
section('C. materializeCompanyVehicleRates() — back-fill rules');

function runMaterialize(rows) {
  sandbox.rows = rows;
  const changed = vm.runInContext('materializeCompanyVehicleRates()', sandbox);
  return { changed, rows: sandbox.rows };
}

// blank rate + vehicle + customer default → filled
let r = runMaterialize([{ company: 'CNX', vehicle1: 'Truck A', v1_rate: '', vehicle2: '', v2_rate: '' }]);
assert('blank V1 rate filled from customer default', r.rows[0].v1_rate === 130 && r.changed === true);
assert('empty V2 slot (no vehicle) left blank — no phantom charge', r.rows[0].v2_rate === '');

// non-blank manual rate preserved
r = runMaterialize([{ company: 'CNX', vehicle1: 'Truck A', v1_rate: 142, vehicle2: '', v2_rate: '' }]);
assert('hand-entered V1 rate (142) preserved, not overwritten', r.rows[0].v1_rate === 142 && r.changed === false);

// blank but no customer default → untouched
r = runMaterialize([{ company: 'Kiewit', vehicle1: 'Truck A', v1_rate: '', vehicle2: 'Truck B', v2_rate: '' }]);
assert('V1 filled from Kiewit default (175)', r.rows[0].v1_rate === 175);
assert('V2 blank left blank when customer has no V2 default', r.rows[0].v2_rate === '');

// invoiced rows must NOT be retroactively re-rated
['sent', 'paid', 'overdue'].forEach(st => {
  r = runMaterialize([{ company: 'CNX', vehicle1: 'Truck A', v1_rate: '', vehicle2: '', v2_rate: '', inv_status: st }]);
  assert(`invoiced row (status=${st}) is NOT back-filled`, r.rows[0].v1_rate === '' && r.changed === false);
});
r = runMaterialize([{ company: 'CNX', vehicle1: 'Truck A', v1_rate: '', vehicle2: '', v2_rate: '', inv_sent: '2026-01-05' }]);
assert('row with an invoice-sent date is NOT back-filled', r.rows[0].v1_rate === '' && r.changed === false);

// unknown company → untouched
r = runMaterialize([{ company: 'Ghost', vehicle1: 'Truck A', v1_rate: '', vehicle2: '', v2_rate: '' }]);
assert('row whose company is not in the list is left alone', r.rows[0].v1_rate === '' && r.changed === false);

// already-correct rate → no spurious change/save
r = runMaterialize([{ company: 'CNX', vehicle1: 'Truck A', v1_rate: 130, vehicle2: '', v2_rate: '' }]);
assert('rate already equal to default → no change (no needless save)', r.changed === false);

// real $0 rate preserved (0 is not "blank")
r = runMaterialize([{ company: 'CNX', vehicle1: 'Truck A', v1_rate: 0, vehicle2: '', v2_rate: '' }]);
assert('explicit 0 rate preserved (treated as set, not blank)', r.rows[0].v1_rate === 0 && r.changed === false);

// ──────────────────────────────────────────────────────────────────────────
section('D. intercompany dustUbRateFor() — override (case-insensitive) else IC default');

const icBox = { icUbRate: 1.10, dustCoUbRate: {} };
vm.createContext(icBox);
vm.runInContext(extractFn(icHtml, 'function dustUbRateFor(name)'), icBox);
icBox.dustCoUbRate = { 'kiewit': 1.55 }; // stored lower-cased by loadRates
const icFor = n => vm.runInContext('dustUbRateFor(' + JSON.stringify(n) + ')', icBox);

assert('IC: customer override applies', icFor('Kiewit') === 1.55);
assert('IC: override match is case/space-insensitive', icFor('  KIEWIT ') === 1.55);
assert('IC: customer without override uses IC default', icFor('CNX') === 1.10);
assert('IC: null/empty name uses IC default', icFor(null) === 1.10 && icFor('') === 1.10);

// ──────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(48)}`);
process.exit(failed ? 1 : 0);
