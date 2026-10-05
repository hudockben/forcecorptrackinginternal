#!/usr/bin/env node
'use strict';
/**
 * Fold purchase-order tax into the unit cost of the job cost rows written
 * before deliveries did that themselves.
 *
 * Usage:
 *   node scripts/backfill-po-unit-cost-tax.js                # dry run — writes nothing
 *   node scripts/backfill-po-unit-cost-tax.js --apply        # rewrite the unit costs
 *
 *   --company FC        only this company
 *   --log <file>        where --apply records what it changed
 *                       (default: po-unit-cost-backfill-<timestamp>.json)
 *
 * Requires DATABASE_URL in the environment (or a .env file), like migrate.js.
 *
 * ── Run it after the fix is deployed ──────────────────────────────────────
 * Until the pages carry lineUnitCostWithTax, editing a taxed delivery writes
 * the pre-tax price straight back over what this sets. Deploy first, then run
 * this, and have anyone with a Paving, Turf or Kiewit tab open reload it — an
 * open tab holds the old figure in memory and writes it back if that cost row
 * is edited there.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 * A taxed delivery's cost row carried the tax in material_cost but not in
 * unit_cost — 63.82 t × $16.00 = $1,082.39 — so cost per unit read low by the
 * tax rate, and the cost tab, which re-derives material cost as units × unit
 * cost whenever either is edited, dropped the tax the first time anyone
 * touched the row. This sets unit_cost to the price with tax ($16.96 there).
 *
 * MATERIAL COST IS NEVER CHANGED. A row is rewritten only while it still holds
 * exactly what its delivery wrote, so the dollars on every job stay where they
 * are and only the unit cost moves to agree with them. Each write is a
 * compare-and-set on the figures it was planned from, so a row edited between
 * the read and the write is skipped rather than overwritten.
 *
 * ── What it reports and leaves alone ──────────────────────────────────────
 *   tax missing   the tax has already fallen off the job. Putting it back
 *                 changes what the job is charged — re-enter the tax % on that
 *                 PO line and the delivery rewrites the row in full.
 *   edited        someone changed the row's quantity, unit cost or material
 *                 cost on the cost tab. Their figure stands.
 *   out of scope / ambiguous / missing   see scripts/lib/po-unit-cost-backfill.js.
 *
 * There is no audit table for cost rows, so --apply writes its own record: one
 * entry per row with the unit cost before and after. Reverting a row is setting
 * unit_cost back to its `from`.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const B = require(path.resolve(__dirname, 'lib/po-unit-cost-backfill.js'));

// Read at call time so a test can drive main() with a stubbed driver — see
// scripts/test-po-unit-cost-backfill.js.
function parseArgs(argv) {
  const has = f => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    APPLY:   has('--apply'),
    COMPANY: val('--company', null),
    LOG:     val('--log', null),
  };
}

const money = n => '$' + Number(n).toFixed(2);
const unit  = n => '$' + Number(n).toFixed(4);
const pad   = (s, w) => String(s).padEnd(w);

function describe(item) {
  const d = item.delivery;
  return pad(item.companyCode + '/' + d.division, 16)
    + pad(d.poNumber || '—', 10)
    + pad((d.invoice || '—').slice(0, 14), 16)
    + pad(d.date || '—', 12)
    + pad(d.qty, 10);
}

async function main(argv) {
  const { APPLY, COMPANY, LOG } = parseArgs(argv || process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Put it in your environment or a .env file, as migrate.js does.');
    if (require.main === module) process.exit(2);
    return;
  }
  const sql = neon(process.env.DATABASE_URL);

  console.log(APPLY ? '── APPLYING ──' : '── DRY RUN — nothing will be written ──');
  if (COMPANY) console.log(`company: ${COMPANY}`);
  console.log('');

  // Every division's order list, every company. The stored order is the only
  // place that says which cost row a delivery wrote.
  const blobs = await sql`
    SELECT key, value FROM app_data
     WHERE POSITION(${B.BLOB_MARK} IN key) > 0
       AND jsonb_typeof(value) = 'array'
     ORDER BY key
  `;
  const candidates = B.collectCandidates(blobs, { company: COMPANY });
  console.log(`${blobs.length} order list(s) read · ${candidates.length} taxed deliveries with a cost row\n`);
  if (!candidates.length) { console.log('Nothing to do.'); return; }

  const ids = candidates.map(c => c.rowId);
  const rows = await sql`
    SELECT row_id, company_code, division, project_id,
           units_purchased, unit_cost, material_cost, timesheet_entry_id
      FROM daily_tracking
     WHERE row_id = ANY(${ids})
  `;
  const plan = B.planBackfill(candidates, rows);

  // ── The report ──────────────────────────────────────────────────────────
  const header = '  ' + pad('where', 16) + pad('PO', 10) + pad('invoice', 16) + pad('date', 12) + pad('qty', 10);
  if (plan.fixes.length) {
    console.log(`${plan.fixes.length} cost row(s) to fix:\n`);
    console.log(header + 'unit cost                  material cost (unchanged)');
    console.log('  ' + '-'.repeat(110));
    for (const f of plan.fixes) {
      console.log('  ' + describe(f) + pad(`${unit(f.cur)} → ${unit(f.delivery.target)}`, 27) + money(f.mat));
    }
    console.log('');
  } else {
    console.log('No cost rows to fix.\n');
  }

  if (plan.taxMissing.length) {
    console.log(`${plan.taxMissing.length} cost row(s) where the tax has ALREADY FALLEN OFF THE JOB — NOT changed.`);
    console.log('Putting it back changes what the job is charged. Re-enter the tax % on the PO line and');
    console.log('the delivery rewrites its cost row in full.\n');
    console.log(header + 'job carries   tax missing');
    for (const t of plan.taxMissing) {
      console.log('  ' + describe(t) + pad(money(t.mat), 14) + money(t.delivery.tax));
    }
    const sum = plan.taxMissing.reduce((s, t) => s + t.delivery.tax, 0);
    console.log(`  total tax missing from jobs: ${money(sum)}\n`);
  }

  const report = (list, title, why) => {
    if (!list.length) return;
    console.log(`${list.length} cost row(s) ${title} — NOT changed. ${why}`);
    for (const x of list) {
      console.log('  ' + (x.delivery ? describe(x) : '') + `[${x.rowId}]` + (x.why ? '  ' + x.why : ''));
    }
    console.log('');
  };
  report(plan.drift, 'edited on the cost tab', 'Whoever changed them made a decision this script will not undo.');
  report(plan.outOfScope, 'out of scope', 'The live sync would not write these either.');
  report(plan.ambiguous, 'named by two copies of an order that disagree', 'Re-save the order once to settle it.');
  report(plan.missing, 'named by an order but not found', '');

  console.log(`skipped: ${plan.already.length} already carry the tax`);

  if (!APPLY) {
    if (plan.fixes.length) console.log('\nDry run. Re-run with --apply to write these changes.');
    return;
  }
  if (!plan.fixes.length) return;

  // ── Writing ─────────────────────────────────────────────────────────────
  // Compare-and-set on the unit cost AND the material cost as planned: a row
  // somebody edited since the read no longer matches, comes back empty, and is
  // left as they left it.
  const changed = [], raced = [];
  for (const f of plan.fixes) {
    const d = f.delivery;
    const out = await sql`
      UPDATE daily_tracking
         SET unit_cost = ${d.target}, updated_at = NOW()
       WHERE company_code = ${f.companyCode}
         AND row_id       = ${f.rowId}
         AND division     = ${d.division}
         AND project_id   = ${d.projectId}
         AND timesheet_entry_id IS NULL
         AND ABS(unit_cost     - ${f.cur}) < 0.0001
         AND ABS(material_cost - ${f.mat}) < 0.0001
      RETURNING row_id
    `;
    if (!out.length) { raced.push(f); continue; }
    changed.push({
      row_id: f.rowId, company_code: f.companyCode, division: d.division, project_id: d.projectId,
      po_number: d.poNumber, invoice_num: d.invoice, date: d.date, qty: d.qty,
      unit_cost: { from: f.cur, to: d.target }, material_cost: f.mat,
    });
  }
  console.log(`\nRewrote the unit cost on ${changed.length} cost row(s).`);
  if (raced.length) {
    console.log(`${raced.length} row(s) changed between the read and the write and were left alone:`);
    raced.forEach(r => console.log('  ' + describe(r) + `[${r.rowId}]`));
  }

  if (changed.length) {
    const logPath = path.resolve(LOG || `po-unit-cost-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(logPath, JSON.stringify({ ranAt: new Date().toISOString(), changed }, null, 2));
    console.log(`Record of every change: ${logPath}`);
  }

  // ── Verify what landed ──────────────────────────────────────────────────
  if (!changed.length) return;
  const after = await sql`
    SELECT row_id, unit_cost, material_cost FROM daily_tracking
     WHERE row_id = ANY(${changed.map(c => c.row_id)})
  `;
  const byId = new Map(after.map(r => [String(r.row_id), r]));
  let bad = 0;
  for (const c of changed) {
    const r = byId.get(c.row_id);
    if (!r) { console.error(`  ! ${c.row_id} vanished`); bad++; continue; }
    if (Math.abs(Number(r.unit_cost) - c.unit_cost.to) >= 0.0001) {
      console.error(`  ! ${c.row_id} unit cost is ${r.unit_cost}, expected ${c.unit_cost.to}`); bad++;
    }
    if (Math.abs(Number(r.material_cost) - c.material_cost) >= 0.0001) {
      console.error(`  ! ${c.row_id} material cost moved to ${r.material_cost} from ${c.material_cost}`); bad++;
    }
  }
  console.log(bad ? `\n⚠ ${bad} problem(s) found after writing — see above.`
                  : '\nVerified: every row rewritten carries the unit cost with tax, and no material cost moved.');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
module.exports = { main, parseArgs };
