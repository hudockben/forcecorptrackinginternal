#!/usr/bin/env node
'use strict';
/**
 * The PO unit-cost backfill — its decisions, and the script end to end against
 * an in-memory database.
 *
 * Run: node scripts/test-po-unit-cost-backfill.js
 *
 * The one promise the script makes is that no job's material cost moves: only
 * a row still holding exactly what its delivery wrote is rewritten, and only
 * its unit cost. Most of what is below pins the rows it must NOT touch.
 *
 * @neondatabase/serverless is stubbed in the require cache with a table that
 * answers the four queries the script makes, the UPDATE's compare-and-set
 * included, so a row edited mid-run is exercised for real.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const Module = require('module');

try { require.resolve('@neondatabase/serverless'); require.resolve('dotenv'); }
catch { console.log('@neondatabase/serverless not installed — skipping backfill run checks'); process.exit(0); }

const B = require('./lib/po-unit-cost-backfill');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const line = (id, rowId, extra) => Object.assign({ id, po_row_id: rowId, date: '2026-09-30', invoice_num: 'INV-' + id }, extra);
const po = (id, projectId, lines, extra) => Object.assign({ id, po_number: id, project_id: projectId, supplier: 'Heidelberg', lines }, extra);

function blobs() {
  return [
    { key: 'FC:fct_purchase_orders:paving', value: [
      // The screenshot: 63.82 t × $16.00 + 6% = $1,082.39. Row still as written.
      po('PO-0057', 'orchard', [line('L1', 'r-fix', { qty: '63.82', unit_cost: '16', tax: '61.2672', tax_pct: '6' })]),
      po('PO-A', 'orchard', [
        line('L2', 'r-already', { qty: '10', unit_cost: '20', tax_pct: '6' }),
        line('L3', 'r-taxgone', { qty: '10', unit_cost: '20', tax_pct: '6' }),
        line('L4', 'r-edited',  { qty: '10', unit_cost: '20', tax_pct: '6' }),
        line('L5', 'r-notax',   { qty: '10', unit_cost: '20', tax_pct: '' }),
        line('L6', 'r-otherjob',{ qty: '10', unit_cost: '20', tax_pct: '6' }),
        line('L7', 'r-gone',    { qty: '10', unit_cost: '20', tax_pct: '6' }),
        line('L8', 'ts42-abc-0-x', { qty: '10', unit_cost: '20', tax_pct: '6' }),
        // Saved before the percentage field existed: a flat dollar tax.
        line('L9', 'r-legacy',  { qty: '10', unit_cost: '10', tax: '3.21' }),
        line('L10', 'r-race',   { qty: '5',  unit_cost: '10', tax_pct: '6' }),
      ]),
      // A general/quarry-style order: no job, so no cost row to consider.
      po('PO-B', '', [line('L11', 'r-nojob', { qty: '1', unit_cost: '100', tax_pct: '6' })]),
      // The paving half of a move that half landed.
      po('PO-MV', 'orchard', [line('L12', 'r-moved', { qty: '2', unit_cost: '50', tax_pct: '7' })]),
    ] },
    { key: 'FC:fct_purchase_orders:turf', value: [
      po('PO-MV', 'turfjob', [line('L12', 'r-moved', { qty: '2', unit_cost: '50', tax_pct: '7' })]),
    ] },
    { key: 'XY:fct_purchase_orders:paving', value: [
      po('PO-X', 'xjob', [line('LX', 'x-fix', { qty: '4', unit_cost: '25', tax_pct: '5' })]),
    ] },
    // Not an order list at all.
    { key: 'FC:fct_projects', value: [] },
  ];
}

const row = (row_id, units, uc, mat, extra) => Object.assign({
  row_id, company_code: 'FC', division: 'paving', project_id: 'orchard',
  units_purchased: String(units), unit_cost: String(uc), material_cost: String(mat), timesheet_entry_id: null,
}, extra);

function rows() {
  return [
    row('r-fix',      63.82, 16,    1082.3872),
    row('r-already',  10,    21.2,  212),
    row('r-taxgone',  10,    20,    200),          // the cost tab re-derived it without the tax
    row('r-edited',   10,    18.5,  196.1),        // a supervisor re-priced it
    row('r-notax',    10,    20,    200),
    row('r-otherjob', 10,    20,    212, { project_id: 'elsewhere' }),
    row('r-legacy',   10,    10,    103.21),
    row('r-race',     5,     10,    53),
    row('r-moved',    2,     50,    107),
    row('x-fix',      4,     25,    105, { company_code: 'XY', project_id: 'xjob' }),
  ];
}

// ── The decisions ───────────────────────────────────────────────────────────
console.log('\n[which rows are rewritten]');
{
  const cands = B.collectCandidates(blobs(), { company: 'FC' });
  const ids = cands.map(c => c.rowId);
  assert('only taxed deliveries are candidates', !ids.includes('r-notax'));
  assert('an order with no job has no cost row', !ids.includes('r-nojob'));
  assert('a payroll row is never a candidate', !ids.includes('ts42-abc-0-x'));
  assert('--company scopes the read', !ids.includes('x-fix'));
  assert('a row named by two copies of an order is one candidate',
    ids.filter(i => i === 'r-moved').length === 1 && cands.find(c => c.rowId === 'r-moved').copies.length === 2);

  const plan = B.planBackfill(cands, rows());
  const pick = list => list.map(x => x.rowId).sort();
  assert('rows still as their delivery wrote them are fixed',
    JSON.stringify(pick(plan.fixes)) === JSON.stringify(['r-fix', 'r-legacy', 'r-moved', 'r-race']), pick(plan.fixes));
  const fix = plan.fixes.find(f => f.rowId === 'r-fix');
  assert('the screenshot row goes to $16.96', fix.delivery.target === 16.96, fix.delivery.target);
  assert('a legacy dollar tax is spread over the quantity',
    plan.fixes.find(f => f.rowId === 'r-legacy').delivery.target === 10.321);
  assert('a half-landed move uses the copy the row is actually on',
    plan.fixes.find(f => f.rowId === 'r-moved').delivery.division === 'paving');
  assert('a row already carrying the tax is skipped', pick(plan.already).join() === 'r-already');
  assert('a row the tax has fallen off is reported, not fixed', pick(plan.taxMissing).join() === 'r-taxgone');
  assert('and the missing tax is the delivery\'s', Math.abs(plan.taxMissing[0].delivery.tax - 12) < 1e-9);
  assert('a row edited on the cost tab is left alone', pick(plan.drift).join() === 'r-edited');
  assert('a row on another job is out of scope', pick(plan.outOfScope).join() === 'r-otherjob');
  assert('a row that does not exist is reported', pick(plan.missing).join() === 'r-gone');

  // Every fix keeps units × unit cost on the material cost already charged.
  assert('no fix would move a job\'s material cost',
    plan.fixes.every(f => Math.abs(f.units * f.delivery.target - f.mat) < 0.01),
    plan.fixes.map(f => `${f.rowId}: ${f.units}×${f.delivery.target} vs ${f.mat}`).join('; '));

  // Two copies wanting different figures for the same row.
  const split = B.collectCandidates([
    { key: 'FC:fct_purchase_orders:paving', value: [po('P', 'orchard', [line('L', 'r-amb', { qty: '1', unit_cost: '10', tax_pct: '6' })])] },
    { key: 'FC:fct_purchase_orders:paving', value: [po('P', 'orchard', [line('L', 'r-amb', { qty: '1', unit_cost: '10', tax_pct: '7' })])] },
  ]);
  const amb = B.planBackfill(split, [row('r-amb', 1, 10, 10.6)]);
  assert('copies that disagree are reported, not guessed between', amb.ambiguous.length === 1 && !amb.fixes.length);

  const payroll = B.planBackfill(B.collectCandidates(blobs(), { company: 'FC' }),
    [row('r-fix', 63.82, 16, 1082.3872, { timesheet_entry_id: 7 })]);
  assert('a row payroll owns is out of scope', payroll.outOfScope.some(x => x.rowId === 'r-fix'));

  assert('blob keys parse', JSON.stringify(B.parseBlobKey('FC:fct_purchase_orders:paving')) ===
    JSON.stringify({ companyCode: 'FC', division: 'paving' }));
  assert('other keys do not', B.parseBlobKey('FC:fct_projects') === null);
}

// ── The script, end to end ─────────────────────────────────────────────────
function makeDb(seedRows, { afterRowRead } = {}) {
  const table = seedRows.map(r => Object.assign({}, r));
  const seen = [], updates = [];
  const sql = (strings, ...vals) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    seen.push(q);
    if (/^SELECT key, value FROM app_data/.test(q)) {
      const mark = vals[0];
      return Promise.resolve(blobs().filter(b => b.key.includes(mark) && Array.isArray(b.value)));
    }
    if (/^SELECT row_id, company_code, division, project_id/.test(q)) {
      const ids = vals[0];
      const out = table.filter(r => ids.includes(r.row_id)).map(r => Object.assign({}, r));
      if (afterRowRead) afterRowRead(table);
      return Promise.resolve(out);
    }
    if (/^UPDATE daily_tracking SET unit_cost/.test(q)) {
      const [target, company, rowId, division, projectId, cur, mat] = vals;
      updates.push({ rowId, target });
      const r = table.find(x => x.company_code === company && x.row_id === rowId && x.division === division
        && x.project_id === projectId && x.timesheet_entry_id == null
        && Math.abs(Number(x.unit_cost) - cur) < 0.0001 && Math.abs(Number(x.material_cost) - mat) < 0.0001);
      if (!r) return Promise.resolve([]);
      r.unit_cost = String(target);
      return Promise.resolve([{ row_id: r.row_id }]);
    }
    if (/^SELECT row_id, unit_cost, material_cost FROM daily_tracking/.test(q)) {
      const ids = vals[0];
      return Promise.resolve(table.filter(r => ids.includes(r.row_id)).map(r => Object.assign({}, r)));
    }
    throw new Error('unexpected query: ' + q.slice(0, 80));
  };
  return { sql, table, seen, updates };
}

function runScript(seedRows, args, opts) {
  const db = makeDb(seedRows, opts);
  const scriptPath = path.resolve(__dirname, 'backfill-po-unit-cost-tax.js');
  const stub = (spec, exports) => {
    const id = require.resolve(spec);
    const m = new Module(id, null);
    m.filename = id; m.loaded = true; m.exports = exports;
    require.cache[id] = m;
  };
  stub('@neondatabase/serverless', { neon: () => db.sql });
  stub('dotenv', { config: () => ({}) });

  const envWas = process.env.DATABASE_URL, logWas = console.log, errWas = console.error;
  const out = [];
  process.env.DATABASE_URL = 'postgres://stub/stub';
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push('ERR ' + a.join(' '));
  delete require.cache[scriptPath];
  const restore = () => { process.env.DATABASE_URL = envWas; console.log = logWas; console.error = errWas; };

  const { main } = require(scriptPath);
  return main(args).then(() => { restore(); return { out: out.join('\n'), db }; },
                         err => { restore(); throw err; });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'po-backfill-'));
const get = (db, id) => db.table.find(r => r.row_id === id);

(async () => {
  console.log('\n[a dry run reports and writes nothing]');
  {
    const { out, db } = await runScript(rows(), ['--company', 'FC']);
    assert('says it is a dry run', /DRY RUN — nothing will be written/.test(out));
    assert('no UPDATE was issued', !db.seen.some(q => /^UPDATE/.test(q)), db.seen.join('\n'));
    assert('lists the fixes', /4 cost row\(s\) to fix/.test(out), out);
    assert('shows the screenshot row going to $16.96', /\$16\.0000 → \$16\.9600/.test(out), out);
    assert('and its material cost unchanged', /\$1082\.39/.test(out));
    assert('flags the tax that already fell off a job', /ALREADY FALLEN OFF THE JOB/.test(out) && /total tax missing from jobs: \$12\.00/.test(out), out);
    assert('lists the row edited on the cost tab', /1 cost row\(s\) edited on the cost tab/.test(out));
    assert('ends by saying how to apply', /Re-run with --apply/.test(out));
  }

  console.log('\n[--apply rewrites exactly the planned unit costs]');
  {
    const log = path.join(tmp, 'run1.json');
    const { out, db } = await runScript(rows(), ['--apply', '--company', 'FC', '--log', log]);
    assert('the screenshot row carries $16.96', Number(get(db, 'r-fix').unit_cost) === 16.96, get(db, 'r-fix').unit_cost);
    assert('the legacy row carries $10.321', Number(get(db, 'r-legacy').unit_cost) === 10.321);
    assert('no material cost moved', rows().every(r => get(db, r.row_id).material_cost === r.material_cost));
    for (const id of ['r-already', 'r-taxgone', 'r-edited', 'r-notax', 'r-otherjob']) {
      const before = rows().find(r => r.row_id === id);
      assert(`${id} is untouched`, get(db, id).unit_cost === before.unit_cost, get(db, id).unit_cost);
    }
    assert('another company is untouched under --company', get(db, 'x-fix').unit_cost === '25');
    assert('reports the count', /Rewrote the unit cost on 4 cost row\(s\)/.test(out), out);
    assert('verifies what landed', /Verified: every row rewritten carries the unit cost with tax/.test(out), out);

    const rec = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert('records every change', rec.changed.length === 4);
    const r = rec.changed.find(c => c.row_id === 'r-fix');
    assert('with the unit cost before and after', r.unit_cost.from === 16 && r.unit_cost.to === 16.96, JSON.stringify(r));
  }

  console.log('\n[a second run finds nothing left to do]');
  {
    const first = await runScript(rows(), ['--apply', '--company', 'FC', '--log', path.join(tmp, 'a.json')]);
    const second = await runScript(first.db.table, ['--apply', '--company', 'FC', '--log', path.join(tmp, 'b.json')]);
    assert('no cost rows to fix', /No cost rows to fix/.test(second.out), second.out);
    assert('and nothing was written', !second.db.seen.some(q => /^UPDATE/.test(q)));
    assert('they read as already carrying the tax', /skipped: 5 already carry the tax/.test(second.out), second.out);
    assert('no record file for an empty run', !fs.existsSync(path.join(tmp, 'b.json')));
  }

  console.log('\n[a row edited between the read and the write is left as edited]');
  {
    const { out, db } = await runScript(rows(), ['--apply', '--company', 'FC', '--log', path.join(tmp, 'race.json')], {
      afterRowRead: table => { const r = table.find(x => x.row_id === 'r-race'); r.unit_cost = '9'; r.material_cost = '45'; },
    });
    assert('the edit stands', get(db, 'r-race').unit_cost === '9' && get(db, 'r-race').material_cost === '45');
    assert('and is reported', /1 row\(s\) changed between the read and the write/.test(out), out);
    assert('the others still landed', /Rewrote the unit cost on 3 cost row\(s\)/.test(out), out);
  }

  console.log('\n[without --company every company is covered]');
  {
    const { db } = await runScript(rows(), ['--apply', '--log', path.join(tmp, 'all.json')]);
    assert('the other company\'s row is fixed too', Number(get(db, 'x-fix').unit_cost) === 26.25, get(db, 'x-fix').unit_cost);
  }

  console.log('\n[no database configured]');
  {
    const envWas = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const errWas = console.error; const errs = [];
    console.error = (...a) => errs.push(a.join(' '));
    const scriptPath = path.resolve(__dirname, 'backfill-po-unit-cost-tax.js');
    delete require.cache[scriptPath];
    await require(scriptPath).main([]);
    console.error = errWas;
    if (envWas !== undefined) process.env.DATABASE_URL = envWas;
    assert('says so and stops', errs.some(e => /DATABASE_URL is not set/.test(e)));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
