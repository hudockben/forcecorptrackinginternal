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

// executive report — apply path. The report no longer does this arithmetic in
// SQL: it reads the rows, the customer list and the division default, then runs
// dust.html's own formula over them in api/lib/dust-metrics. The requirement is
// unchanged — a per-customer override must beat the global rate — so the checks
// follow it to where it now lives.
const dustMetricsJs = read('api/lib/dust-metrics.js');
assert('executive report: reads dust_companies so per-customer rates are available',
  /FROM dust_companies/.test(reportJs));
assert('executive report: reads the division default from dust_settings',
  /FROM dust_settings WHERE company_code =/.test(reportJs));
assert('executive report: hands both to dustMetrics rather than computing in SQL',
  /dustMetrics\(\{[\s\S]{0,200}companies:/.test(reportJs)
  && /ubRate:/.test(reportJs));
assert('executive report: the customer override wins over the default',
  /const own = byName\.get\(String\(\(row && row\.company\) \|\| ''\)\);\s*\n\s*return own != null \? own : fallback;/.test(dustMetricsJs));
assert('executive report: gallons are billed at that resolved rate',
  /ubTotal\s*=\s*round2\(gallons \* ubRateFor\(row\)\)/.test(dustMetricsJs));
assert('executive report: ensures ub_rate column before querying',
  /ALTER TABLE IF EXISTS dust_companies ADD COLUMN IF NOT EXISTS ub_rate/.test(reportJs));

// ──────────────────────────────────────────────────────────────────────────
section('B. ubRateForRow() — customer override wins, else global');

const sandbox = { dustLists: { companies: [] }, ubRate: 0, rows: [] };
vm.createContext(sandbox);
vm.runInContext(extractFn(dustHtml, 'function ubRateForRow(row)'), sandbox);
// The back-fill skips payroll-injected rows, so it needs the same predicate the
// page uses to recognise one. Pulled from the page rather than re-declared here,
// so a change to the id scheme can't leave this test agreeing with itself. Both
// halves: isInjectedRow delegates to the id-only form, which the Intercompany
// reconciler uses directly on an entry's source_id.
vm.runInContext(extractFn(dustHtml, 'function isInjectedRowId(id)'), sandbox);
vm.runInContext(extractFn(dustHtml, 'function isInjectedRow(row)'),   sandbox);
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

// payroll-injected rows are not this back-fill's business: their rates were
// resolved by the same cascade when the timesheet entry was approved, and the
// server replays its own copy of those columns over anything this tab sends.
r = runMaterialize([{ id: 'tsd-42-row', company: 'CNX', vehicle1: 'Truck A', v1_rate: '', vehicle2: '', v2_rate: '' }]);
assert('payroll-injected row is NOT back-filled', r.rows[0].v1_rate === '' && r.changed === false);
r = runMaterialize([{ id: 'k3x9', company: 'CNX', vehicle1: 'Truck A', v1_rate: '', vehicle2: '', v2_rate: '' }]);
assert('a manually-added row with an id still IS back-filled', r.rows[0].v1_rate === 130 && r.changed === true);

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
section('E. _syncCompanies resilient to UNIQUE(company_code, name)');

// dust_companies enforces UNIQUE(company_code, name); the upsert keys ON
// CONFLICT (id). A name held by a different id (duplicate-named company, or a
// rename/swap) must NOT raise a 23505 and abort the sync — that silently
// reverts every company edit (new companies, per-customer UB $/gal) because
// the JSON blob is written but the normalized table is left stale and GET
// trusts it. This drives the *shipped* _syncCompanies against an in-memory
// store that enforces both constraints, exactly like Postgres.
const safeFloat = v => { const f = parseFloat(v); return isNaN(f) ? null : f; };

function makeDb() {
  const db = { companies: [], _err: null };
  const sql = async (strings, ...vals) => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    if (/^SELECT COUNT\(\*\)::int AS count FROM dust_companies WHERE company_code =/.test(q))
      return [{ count: db.companies.filter(c => c.company_code === vals[0]).length }];
    if (/^DELETE FROM dust_companies WHERE company_code = \? AND name = \? AND id <>/.test(q)) {
      const [code, name, id] = vals;
      db.companies = db.companies.filter(c => !(c.company_code === code && c.name === name && c.id !== id));
      return [];
    }
    if (/^DELETE FROM dust_companies WHERE company_code = \? AND id <> ALL/.test(q)) {
      const [code, ids] = vals;
      db.companies = db.companies.filter(c => !(c.company_code === code && !ids.includes(c.id)));
      return [];
    }
    if (/^DELETE FROM dust_companies WHERE company_code = \?$/.test(q)) {
      db.companies = db.companies.filter(c => c.company_code !== vals[0]);
      return [];
    }
    if (/^INSERT INTO dust_companies/.test(q)) {
      const [id, company_code, name] = vals;
      const ub = vals[6];
      const byId = db.companies.find(c => c.id === id);
      if (byId) {
        if (db.companies.find(c => c !== byId && c.company_code === company_code && c.name === name))
          { const e = new Error('23505 unique_violation (UPDATE name=' + name + ')'); throw e; }
        byId.name = name; byId.ub_rate = ub;
      } else {
        if (db.companies.find(c => c.company_code === company_code && c.name === name))
          { const e = new Error('23505 unique_violation (INSERT name=' + name + ')'); throw e; }
        db.companies.push({ id, company_code, name, ub_rate: ub });
      }
      return [];
    }
    // locations / personnel — irrelevant to this constraint; behave as empty.
    if (/dust_company_locations|dust_company_personnel/.test(q))
      return /^SELECT COUNT/.test(q) ? [{ count: 0 }] : [];
    throw new Error('UNHANDLED QUERY: ' + q);
  };
  return { db, sql };
}

const syncBox = { console, safeFloat };
vm.createContext(syncBox);
vm.runInContext(extractFn(cfgJs, 'async function _syncCompanies'), syncBox);
const runSync = async (sql, companies) => {
  syncBox._sql = sql; syncBox._companies = companies;
  return vm.runInContext('_syncCompanies(_sql, "FORCECORP", _companies)', syncBox);
};

(async () => {
  // 1. Clean list: adding a new company (B&B) persists.
  let { db, sql } = makeDb();
  await runSync(sql, [{ id: 'a', name: 'Kiewit' }, { id: 'b', name: 'CNX' }]);
  await runSync(sql, [{ id: 'a', name: 'Kiewit' }, { id: 'b', name: 'CNX' }, { id: 'c', name: 'B&B' }]);
  assert('clean list: new company "B&B" persists', !!db.companies.find(c => c.name === 'B&B'));

  // 2. Duplicate name present (different ids) must NOT abort the sync, and the
  //    new company added after it must still land.
  ({ db, sql } = makeDb());
  let threw = null;
  try {
    await runSync(sql, [
      { id: 'a', name: 'Kiewit' },
      { id: 'b', name: 'CNX' },
      { id: 'd', name: 'CNX' },   // duplicate name, different id
      { id: 'c', name: 'B&B', ub_rate: 1.55 },
    ]);
  } catch (e) { threw = e; }
  assert('duplicate company name does not throw / abort the sync', threw === null,
    threw && threw.message);
  assert('company added after the duplicate ("B&B") still persists',
    !!db.companies.find(c => c.name === 'B&B'));
  assert('per-customer ub_rate on that company is stored',
    (db.companies.find(c => c.name === 'B&B') || {}).ub_rate === 1.55);
  assert('duplicate name collapses to a single normalized row',
    db.companies.filter(c => c.name === 'CNX').length === 1);

  // 3. Swapping two companies' names (A<->B) must not collide.
  ({ db, sql } = makeDb());
  await runSync(sql, [{ id: 'x', name: 'Alpha' }, { id: 'y', name: 'Bravo' }]);
  threw = null;
  try {
    await runSync(sql, [{ id: 'x', name: 'Bravo' }, { id: 'y', name: 'Alpha' }]);
  } catch (e) { threw = e; }
  assert('name swap (Alpha<->Bravo) does not throw', threw === null, threw && threw.message);
  assert('after swap, both rows hold their new names',
    (db.companies.find(c => c.id === 'x') || {}).name === 'Bravo' &&
    (db.companies.find(c => c.id === 'y') || {}).name === 'Alpha');

  // ── Final summary (kept inside the async IIFE so it runs after the awaits) ──
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(48)}`);
  process.exit(failed ? 1 : 0);
})();
