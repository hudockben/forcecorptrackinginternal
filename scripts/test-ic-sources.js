#!/usr/bin/env node
'use strict';
/**
 * The intercompany billing `source` tags, and the places that must agree
 * about them.
 *
 * Run: node scripts/test-ic-sources.js
 *
 * Dust Control bills from three tabs, each writing the shared billing blob
 * under its own source tag. Twice now a query enumerated only some of them:
 * the executive report's unbilled-dust figure understated the division while
 * the AR and top-customer figures beside it, which filter on nothing, counted
 * every one — so trucking + dust never reconciled against the tile's own
 * totals. Both times it was found by audit rather than by a failing test.
 *
 * api/lib/ic-sources.js is now the list. This file fails when a consumer
 * stops agreeing with it, which is the point: adding a fourth dust tab should
 * break a test, not a report.
 */

const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const root = p => path.resolve(__dirname, '..', p);
const read = p => fs.readFileSync(root(p), 'utf8');

const { IC_SOURCES, DUST_IC_SOURCES, isDustSource } = require(root('api/lib/ic-sources.js'));

console.log('\n[the list itself]');
{
  assert('dust sources are unique', new Set(DUST_IC_SOURCES).size === DUST_IC_SOURCES.length);
  assert('dust tracking is included', DUST_IC_SOURCES.includes('dust'));
  assert('other billing is included', DUST_IC_SOURCES.includes('dust-other-billing'));
  assert('EES other is included', DUST_IC_SOURCES.includes('dust-ees-other'));
  assert('trucking is NOT a dust source', !DUST_IC_SOURCES.includes(IC_SOURCES.TRUCKING));
  assert('isDustSource agrees', DUST_IC_SOURCES.every(isDustSource) && !isDustSource('trucking'));
  assert('isDustSource tolerates junk', !isDustSource(null) && !isDustSource(undefined) && !isDustSource(''));
}

console.log('\n[the executive report reads the list, it does not restate it]');
{
  // The report's intercompany section no longer splits dust from trucking in
  // SQL — it reads the same blob intercompany.html reads and classifies each row
  // in api/lib/ic-metrics. The requirement is unchanged: one shared list, named
  // in one place, because a hand-written copy is what drifted twice before.
  const src = read('api/lib/ic-metrics.js');
  assert('requires the shared list', /require\('\.\/ic-sources'\)/.test(src));
  assert('classifies dust rows through it rather than by prefix',
    /isDustEntry\s*=\s*e => isDustSource\(e && e\.source\)/.test(src),
    'a prefix test would disagree with intercompany.html\'s _isDustSrc');
  assert('derives the flat-total tags from it too',
    /DUST_FLAT_TOTAL_SOURCES = DUST_IC_SOURCES\.filter/.test(src));
  assert('trucking still filters on its own tag',
    /IC_SOURCES\.TRUCKING/.test(src));

  // A hand-written list is exactly what drifted twice before.
  assert('no hand-written dust source list survives',
    !/\['dust'[^\]]*\]|\['dust-[^\]]*\]/.test(src),
    'found a literal dust source array');

  const report = read('api/executive/report.js');
  assert('and the report itself no longer enumerates them',
    !/source IN \([^)]*dust/.test(report) && !/DUST_IC_SOURCES/.test(report));
}

console.log('\n[intercompany.html agrees with the list]');
{
  const html = read('intercompany.html');
  const m = /const DUST_IC_SOURCES = (\[[^\]]*\])/.exec(html);
  assert('declares its own copy', !!m);
  const copy = m ? JSON.parse(m[1].replace(/'/g, '"')) : [];
  assert('the copy matches api/lib/ic-sources.js',
    JSON.stringify([...copy].sort()) === JSON.stringify([...DUST_IC_SOURCES].sort()),
    `${JSON.stringify(copy)} vs ${JSON.stringify(DUST_IC_SOURCES)}`);

  assert('_isDustSrc uses the list', /_isDustSrc\(e\) \{\s*return !!e && DUST_IC_SOURCES\.includes\(e\.source\)/.test(html));
  assert('no open-coded dust source chain remains in _isDustSrc',
    !/_isDustSrc\(e\) \{[\s\S]{0,200}e\.source === 'dust-other-billing'/.test(html));

  // Every dust source needs somewhere to be seen, or entries land in the blob
  // and are invisible on the page that exists to show them.
  for (const s of DUST_IC_SOURCES) {
    assert(`'${s}' has a sub-tab`, html.includes(`switchCiDiv('${s}')`));
  }
}

console.log('\n[every dust source is actually written by a dust tab]');
{
  const dust = read('dust.html');
  for (const s of DUST_IC_SOURCES) {
    assert(`'${s}' is produced by dust.html`, dust.includes(`source: '${s}'`), 'no reconciler writes it');
  }
}

console.log('\n[the normalized mirror keeps what each source carries]');
{
  // A source whose fields have no columns reaches SQL as a total and nothing
  // else — the gap the last two audits each found for a different tab.
  const sn = read('api/lib/sync-normalized.js');
  const i  = sn.indexOf('INSERT INTO intercompany_billing_entries');
  const cols = sn.slice(sn.indexOf('(', i) + 1, sn.indexOf(') VALUES (', i))
    .replace(/--[^\n]*/g, '').split(',').map(x => x.trim()).filter(Boolean);

  // Fields each dust reconciler puts on an entry, beyond the shared ones.
  const carried = {
    'dust':               ['location', 'vehicle1', 'v1_total', 'gallons_ub', 'ub_total', 'inv_number'],
    'dust-other-billing': ['destination', 'material', 'gallons_bags', 'price_per_unit',
                           'material_total', 'trucking_hrs', 'trucking_rate', 'trucking_total'],
    // `name` is mirrored as ees_name so it can't be confused with company_name.
    'dust-ees-other':     ['rate', 'ees_name', 'job_number', 'billing', 'total_hours', 'unit'],
  };
  for (const [src, fields] of Object.entries(carried)) {
    const missing = fields.filter(f => !cols.includes(f));
    assert(`'${src}' fields all have columns`, missing.length === 0, missing.join(', '));
  }

  // Arity, since these lists are edited by hand.
  const valStart = sn.indexOf(') VALUES (', i) + ') VALUES ('.length;
  let d = 1, j = valStart;
  for (; j < sn.length; j++) { if (sn[j] === '(') d++; else if (sn[j] === ')') { if (--d === 0) break; } }
  let depth = 0, cur = '', vals = [];
  for (const c of sn.slice(valStart, j)) {
    if (c === '(' || c === '{') depth++; else if (c === ')' || c === '}') depth--;
    if (c === ',' && depth === 0) { vals.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) vals.push(cur.trim());
  assert('INSERT arity matches', cols.length === vals.filter(Boolean).length,
    `${cols.length} columns vs ${vals.filter(Boolean).length} values`);

  const schema = read('neon-schema.sql');
  const tbl = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS intercompany_billing_entries'));
  const declared = new Set([...tbl.slice(0, tbl.indexOf('\n);')).matchAll(/^\s{4}(\w+)\s+/gm)].map(m => m[1]));
  const alter = sn.slice(sn.indexOf('ALTER TABLE intercompany_billing_entries'));
  const lazy = new Set([...alter.slice(0, alter.indexOf('`')).matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map(m => m[1]));
  const uncreatable = cols.filter(c => !declared.has(c) && !lazy.has(c));
  assert('every column exists on a fresh database', uncreatable.length === 0, uncreatable.join(', '));
  const lazyOnly = [...lazy].filter(c => !declared.has(c));
  assert('lazily-added columns are in neon-schema.sql too', lazyOnly.length === 0, lazyOnly.join(', '));
}

console.log('\n[the divisions can actually reach the shared keys]');
{
  // A key the source divisions cannot read is worse than a missing feature:
  // the GET 403s, the client's catch swallows it, the list reads as empty and
  // the behaviour silently reverts to what it replaced. That is exactly what
  // happened to the removed-entries list — recorded by intercompany, never
  // seen by dust, so every deletion was undone again on the next sync.
  const auth = require(root('api/lib/auth.js'));
  const pages = { 'dust.html': 'dust', 'trucking.html': 'trucking' };

  for (const [page, division] of Object.entries(pages)) {
    const src = read(page);
    // Every fct_intercompany* key this division's page touches.
    const keys = new Set((src.match(/'fct_intercompany[a-z_]*'/g) || []).map(k => k.slice(1, -1)));
    assert(`${page} references at least one intercompany key`, keys.size > 0);
    for (const k of keys) {
      assert(`${division} may use ${k}`, auth.isCrossDivisionKey(k),
        'not in CROSS_DIVISION_KEYS — the division will 403 and fail silently');
    }
  }

  assert('the removed-entries list is reachable',
    auth.isCrossDivisionKey('fct_intercompany_removed_entries'));
  assert('the contributors include the dust and trucking divisions',
    ['dust', 'trucking', 'intercompany'].every(d => auth.CROSS_DIVISION_CONTRIBUTORS.includes(d)),
    JSON.stringify(auth.CROSS_DIVISION_CONTRIBUTORS));
}

console.log('\n[a deletion in intercompany is honoured by every owning division]');
{
  // Each page that auto-syncs into the blob recreates rows from its own data,
  // so each has to consult the removed list or it undoes the deletion.
  for (const f of ['dust.html', 'trucking.html']) {
    const src = read(f);
    assert(`${f} loads the removed list`, /_loadIcSuppressions\(\)/.test(src));
    // Ordering, not call shape: the removed list must be in hand before the
    // reconcile that decides what to create.
    const load = src.indexOf('_loadIcSuppressions()');
    const co   = Math.max(src.indexOf("apiGet('fct_intercompany_companies')"), src.indexOf("tdGet('fct_intercompany_companies')"));
    assert(`${f} loads it before reconciling`, load !== -1 && co !== -1 && load < co,
      'the reconcile would run against an empty removed list');
    // The create branch specifically — matching the function's mere existence
    // would pass with the check removed from the one place it matters.
    assert(`${f} skips creating a suppressed row`, /else if \(icIsSuppressed\(/.test(src),
      'icIsSuppressed is defined but not consulted before creating an entry');
  }
  // …once per dust source, since each has its own reconciler.
  const dust = read('dust.html');
  for (const s of DUST_IC_SOURCES) {
    assert(`dust.html honours suppression for '${s}'`, dust.includes(`icIsSuppressed('${s}'`));
  }
}

console.log('\n[a removal is visible the moment a tab paints]');
{
  // The marker is what stops a suppression being silent, so it has to be
  // right on first paint. The tabs render as soon as their rows load — before
  // any sync has fetched the removed list — so loading it only inside the
  // sync left a suppressed row showing nothing at all until some unrelated
  // re-render happened to come along.
  const dust = read('dust.html');

  for (const [loader, tab] of [['async function eeLoad', 'EES Other'], ['async function obLoad', 'Other Billing']]) {
    const i = dust.indexOf(loader);
    assert(`${tab} has a loader`, i !== -1);
    const body = dust.slice(i, dust.indexOf('\n    }', i));
    assert(`${tab} loads removals before it paints`, /_loadIcSuppressions\(\)/.test(body),
      'the first render would show a suppressed row with no marker');
  }

  // …and when the list changes later, the tab has to be repainted: the sync
  // only touches the rows it changed, and a suppressed row is by definition
  // one it did not touch.
  assert('the loader reports whether it changed', /const changed = next\.size !== _icSuppressed\.size/.test(dust));
  const repaints = (dust.match(/if \(await _loadIcSuppressions\(\)\) _repaintForSuppressions\(/g) || []).length;
  assert('every dust sync repaints on a change', repaints === DUST_IC_SOURCES.length,
    `${repaints} of ${DUST_IC_SOURCES.length} syncs`);
  assert('a repaint never interrupts an edit', /_repaintForSuppressions\([\s\S]{0,200}!_isEditingAnyField\(\)/.test(dust));
}

console.log('\n[every writer of the shared blob uses the version check]');
{
  // The blob has no transaction: trucking and the dust tabs all read-modify-write
  // it, and before the version check whoever PUT last erased the others' entries.
  for (const f of ['dust.html', 'trucking.html']) {
    const src = read(f);
    // Only PUTs aimed at the billing blob itself — other blobs on these pages
    // (presence, the EES rows) are written directly and are not shared.
    const writes = src.match(/data\/(?:\$\{IC_BILLING_KEY\}|fct_intercompany_billing_entries)[^`]*`,\s*\{\s*\n?\s*method: 'PUT'/g) || [];
    assert(`${f} funnels every billing write through one place`, writes.length === 1, `${writes.length} PUT sites`);
    // …and nothing bypasses it via the generic key-value helper.
    const bypass = src.match(/(?:api|td)Put\(\s*(?:IC_BILLING_KEY|OB_IC_KEY|EE_IC_KEY|'fct_intercompany_billing_entries')/g) || [];
    assert(`${f} has no generic-helper bypass`, bypass.length === 0, bypass.join(', '));
    assert(`${f} sends baseUpdatedAt`, /_writeIcBilling\([^)]*updatedAt\)/.test(src) || /baseUpdatedAt/.test(src));
    assert(`${f} retries a stale write`, /conflict && _icConflictRetries < IC_MAX_CONFLICT_RETRIES/.test(src));
    assert(`${f} does not retry the wipe guard`, /b\.error === 'Conflict'/.test(src));
  }
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
