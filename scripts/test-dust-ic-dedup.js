#!/usr/bin/env node
'use strict';
/**
 * The dust → Intercompany dedup, on both sides of it.
 *
 * Run: node scripts/test-dust-ic-dedup.js
 *
 * Dust rows reach Intercompany through a physical job key —
 * date|company|location|vehicle1, with start_time deliberately excluded so a
 * time-less original and its timed CSV replacement collapse into one entry.
 * Two halves enforce it and they MUST agree, or they fight: dust.html refuses
 * to push a second entry for a key that is taken, and intercompany.html
 * collapses any that slip through and writes the shrunken list straight back.
 *
 * Payroll-injected rows broke that key's assumption. Each one is exactly one
 * approved timesheet entry, so two of them are two hauls — but a multi-haul day
 * for one customer with one truck and no well pad recorded (which is what bulk
 * approve produces) gives them an identical key. The first claimed it, every
 * later one was skipped, and on the Intercompany side the loser was deleted for
 * good. So injected rows are now identified by source_id alone on both sides.
 *
 * This test runs the REAL code from both files rather than a copy of it: the
 * dedup block is extracted out of intercompany.html and _reconcileDustBilling
 * out of dust.html, and executed against synthetic entries. If either side is
 * edited so they no longer agree, this fails.
 *
 * No DB, no browser, no server required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

const IC   = read('intercompany.html');
const DUST = read('dust.html');

// ── Extract intercompany.html's dedup, verbatim ─────────────────────────────
// From the line that receives the blob array through the line that assigns the
// result. Everything between is pure — no fetch, no DOM.
function icDedup(raw) {
  const from = 'const isInjectedDust =';
  const to   = 'icBillingEntries = deduped;';
  const a = IC.indexOf(from);
  const b = IC.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('intercompany.html dedup block not found (markers moved)');
  const body = IC.slice(a, b) + 'return deduped;';
  return new Function('raw', body)(raw);
}

// ── Extract dust.html's reconciler, verbatim ────────────────────────────────
function dustReconcile({ rows, entries, suppressed = [] }) {
  const from = 'function _reconcileDustBilling(entries, coByName) {';
  const a = DUST.indexOf(from);
  if (a < 0) throw new Error('dust.html _reconcileDustBilling not found');
  let depth = 0, end = -1;
  for (let i = DUST.indexOf('{', a); i < DUST.length; i++) {
    if (DUST[i] === '{') depth++;
    else if (DUST[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const fnSrc = DUST.slice(a, end);

  // The helpers it closes over, taken from dust.html too where they are pure.
  const grab = sig => {
    const s = DUST.indexOf(sig);
    if (s < 0) throw new Error(`dust.html ${sig} not found`);
    let d = 0;
    for (let i = DUST.indexOf('{', s); i < DUST.length; i++) {
      if (DUST[i] === '{') d++;
      else if (DUST[i] === '}') { d--; if (d === 0) return DUST.slice(s, i + 1); }
    }
    throw new Error('unbalanced');
  };

  const sandbox = {
    rows,
    user: { username: 'tester' },
    // Only the fields the reconciler reads off calc().
    calc: row => ({
      totalHours: 4, v1Total: 540, v2Total: 300, vehTotal: 840,
      gallons: Number(row.gallons_ub) || 0, ubTotal: 100,
      invTotal: row._notBillable ? 0 : 940,
    }),
    icIsSuppressed: (src, id) => suppressed.includes(`${src}|${id}`),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(grab('function isInjectedRowId(id) {'), sandbox);
  vm.runInContext(grab('function isInjectedRow(row) {'),   sandbox);
  vm.runInContext(grab('function _icEntrySig(e) {'),        sandbox);
  vm.runInContext(grab('function _icJobKey(e) {'),          sandbox);
  vm.runInContext(fnSrc, sandbox);

  const coByName = new Map([['cnx', { id: 'ic-cnx', name: 'CNX' }]]);
  sandbox.__entries  = entries;
  sandbox.__coByName = coByName;
  const result = vm.runInContext('_reconcileDustBilling(__entries, __coByName)', sandbox);
  return { result, entries };
}

const dustRow = (id, over = {}) => ({
  id, date: '2026-08-12', company: 'CNX', company_man: 'Steve Quinn',
  location: '', vehicle1: 'Distributor Truck 4000', v1_unit: '4000', v1_rate: '130',
  vehicle2: '', v2_unit: '', v2_rate: '', gallons_ub: '1000',
  start_time: '06:30', end_time: '10:30', inv_number: '', inv_status: '',
  ...over,
});

const icEntry = (sourceId, over = {}) => ({
  id: 'ic-' + sourceId, source: 'dust', source_id: sourceId,
  company_id: 'ic-cnx', company_name: 'CNX',
  actual_date: '2026-08-12', actual_start: '06:30', location: '',
  vehicle1: 'Distributor Truck 4000', sent_at: '2026-08-12T10:00:00Z',
  ...over,
});

(async () => {
  console.log('Dust → Intercompany dedup\n');

  // ── The bug this fixes ───────────────────────────────────────────────────
  console.log("[a multi-haul day with no well pad recorded]");
  {
    // Two hauls, one customer, one day, one truck, blank pad — identical job key.
    const rows = [dustRow('tsd-101-row'), dustRow('tsd-102-row', { start_time: '11:00', end_time: '15:00' })];
    const entries = [];
    dustReconcile({ rows, entries });
    const ids = entries.filter(e => e.source === 'dust').map(e => e.source_id).sort();
    assert('dust.html bills BOTH injected hauls', ids.length === 2, `billed ${JSON.stringify(ids)}`);

    // And Intercompany must not then collapse them back.
    const kept = icDedup([icEntry('tsd-101-row'), icEntry('tsd-102-row')]);
    assert('intercompany.html keeps both', kept.length === 2, `kept ${kept.length}`);
  }

  // ── The behaviour the job key exists for, unchanged ──────────────────────
  console.log('\n[manual rows keep the physical-job-key collapse]');
  {
    // A time-less original and its timed CSV replacement: two source_ids, one
    // haul. These must still fold into one.
    const kept = icDedup([
      icEntry('m-old', { actual_start: '',      sent_at: '2026-08-12T09:00:00Z' }),
      icEntry('m-new', { actual_start: '06:30', sent_at: '2026-08-12T11:00:00Z' }),
    ]);
    assert('two manual entries for one haul still collapse to one', kept.length === 1, `kept ${kept.length}`);
    assert('and the later send is the survivor', kept[0] && kept[0].source_id === 'm-new');

    const rows = [dustRow('manual-a'), dustRow('manual-b', { start_time: '11:00' })];
    const entries = [];
    dustReconcile({ rows, entries });
    const billed = entries.filter(e => e.source === 'dust').length;
    assert('dust.html still pushes only one entry for two manual twins', billed === 1, `billed ${billed}`);
  }

  // ── A manual row still blocks its injected twin ──────────────────────────
  console.log('\n[approving a haul the office already typed bills once, not twice]');
  {
    const rows = [dustRow('manual-a'), dustRow('tsd-101-row')];
    const entries = [];
    dustReconcile({ rows, entries });
    const ids = entries.filter(e => e.source === 'dust').map(e => e.source_id);
    assert('only the row already billing keeps its entry', ids.length === 1 && ids[0] === 'manual-a',
      `billed ${JSON.stringify(ids)}`);
  }

  // ── Trucking is untouched by any of this ────────────────────────────────
  console.log('\n[the trucking leg is never involved]');
  {
    const kept = icDedup([
      icEntry('tsd-101-row'),
      { id: 'ic-t', source: 'trucking', source_id: 'tst-101-row',
        company_name: 'CNX', actual_date: '2026-08-12', actual_start: '06:30', location: '' },
    ]);
    assert('a trucking entry and a dust entry for the same haul both survive', kept.length === 2);
    assert('and keep their own source tags',
      kept.some(e => e.source === 'dust') && kept.some(e => e.source === 'trucking'));
  }

  // ── Suppression still wins ───────────────────────────────────────────────
  console.log('\n[an Intercompany removal still sticks]');
  {
    const rows = [dustRow('tsd-101-row')];
    const entries = [];
    dustReconcile({ rows, entries, suppressed: ['dust|tsd-101-row'] });
    assert('a suppressed injected row is not re-created',
      entries.filter(e => e.source === 'dust').length === 0);
  }

  // ── The two halves must agree, structurally ──────────────────────────────
  console.log('\n[the two sides cannot drift apart]');
  {
    assert('intercompany.html exempts injected ids from the job key',
      /isInjectedDust\s*=\s*e\s*=>\s*String\(e\.source_id[^)]*\)\.startsWith\('tsd-'\)/.test(IC));
    assert('…and skips them when building bestByJobKey',
      /if \(isInjectedDust\(e\)\) continue;/.test(IC));
    assert('…and emits them on source_id alone',
      /if \(isInjectedDust\(e\)\) \{[\s\S]{0,240}bestBySourceId\.get\(e\.source_id\) === e/.test(IC));
    assert('dust.html only lets manual rows claim a key (seed)',
      /if \(!isInjectedRowId\(e\.source_id\)\) dustJobKeys\.add/.test(DUST));
    assert('dust.html only lets manual rows claim a key (loop)',
      /const claimsJobKey = !isInjectedRow\(row\);/.test(DUST));
    assert('…and still CHECKS the key for every row',
      /\} else if \(dustJobKeys\.has\(_icJobKey\(entry\)\)\) \{/.test(DUST));
    // The prefix is minted server-side; all three spellings must be the same.
    const lib = read('api/lib/dust-injected.js');
    const prefixes = [
      (lib.match(/return `tsd-\$\{entryId\}-`/) || [])[0],
      (IC.match(/startsWith\('tsd-'\)/)   || [])[0],
      (DUST.match(/\/\^tsd-\\d\+-\//)     || [])[0],
    ];
    assert('server, dust tab and Intercompany all spell the prefix "tsd-"',
      prefixes.every(Boolean), JSON.stringify(prefixes));
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
