#!/usr/bin/env node
'use strict';
/**
 * Regression test for api/lib/sync-normalized.js → syncProjects.
 *
 * Run: node scripts/test-sync-normalized.js
 *
 * The previous version of this file silently dropped `is_complete` and
 * `change_orders` from the bid_items INSERT/UPDATE — so any toggle of
 * those fields via saveProject (the full-blob path) never reached the
 * normalized table. /api/projects GET and analytics queries that read
 * from bid_items therefore returned stale data. This test pins the
 * complete column set so the regression can't sneak back.
 */

const path = require('path');

const { syncProjects } = require(path.resolve(__dirname, '../api/lib/sync-normalized.js'));

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tagged-template SQL mock — captures the raw SQL strings + parameter
// arrays for inspection.
// ─────────────────────────────────────────────────────────────────────
function makeMockSql() {
  const calls = [];
  function sql(strings, ...vals) {
    let str = '';
    strings.forEach((s, i) => {
      str += s;
      if (i < vals.length) str += `$${i + 1}`;
    });
    calls.push({ sql: str, values: vals });
    return Promise.resolve([]);
  }
  Object.defineProperty(sql, '_calls', { get: () => calls });
  return sql;
}

(async () => {
  console.log('\n[syncProjects — bid_items INSERT/UPDATE coverage]');

  const sql = makeMockSql();
  const project = {
    id: 'p1',
    'project-name': 'Franklin Regional',
    bidItems: [
      {
        id: 'b1',
        cost_code: 'Tennis Demo',
        sub_code: 'Fence Removal',
        description: 'Remove perimeter fence',
        quantity: 100,
        unit: 'LF',
        unit_cost: 12.42,
        status: 'Active',
        start_date: '2026-05-15',
        target_date: '2026-05-18',
        is_complete: true,                       // ← previously dropped
        change_orders: [                          // ← previously dropped
          { id: 'co1', date: '2026-05-10', qty_delta: 10, note: 'Scope add' }
        ],
      },
    ],
  };

  await syncProjects(sql, 'forcecorp', project);

  // We expect 2 calls: one for the project upsert, one for the bid_items upsert.
  assert('syncProjects issued at least 2 SQL statements', sql._calls.length >= 2);

  // Find the bid_items INSERT
  const biCall = sql._calls.find(c => /INSERT INTO bid_items/i.test(c.sql));
  assert('bid_items INSERT issued', !!biCall);
  if (!biCall) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }

  // ── Column coverage in INSERT
  for (const col of ['cost_code','sub_code','description','quantity','unit','unit_cost','status','start_date','target_date','is_complete','change_orders']) {
    assert(`INSERT includes column "${col}"`, new RegExp(`\\b${col}\\b`).test(biCall.sql));
  }

  // ── Column coverage in ON CONFLICT DO UPDATE
  // Extract just the ON CONFLICT clause so we don't false-positive on the INSERT column list
  const conflictMatch = biCall.sql.match(/ON CONFLICT \(id\) DO UPDATE SET([\s\S]+?updated_at\s*=\s*NOW\(\))/i);
  assert('ON CONFLICT DO UPDATE clause exists', !!conflictMatch);
  if (conflictMatch) {
    const setClause = conflictMatch[1];
    for (const col of ['cost_code','sub_code','description','quantity','unit','unit_cost','status','start_date','target_date','is_complete','change_orders']) {
      assert(`UPDATE SET includes column "${col}"`, new RegExp(`\\b${col}\\s*=\\s*EXCLUDED\\.${col}\\b`).test(setClause));
    }
  }

  // ── Values: confirm the actual passed-in values land in the parameter array
  assert('is_complete value passed as true',  biCall.values.includes(true));
  // change_orders is stringified jsonb — find the array-shaped string
  const coParam = biCall.values.find(v => typeof v === 'string' && /"id":"co1"/.test(v));
  assert('change_orders value passed as jsonb-stringified array', !!coParam);

  // ── Defaults: a bid item with NO is_complete / change_orders should
  // still produce safe param values (false / '[]'), not NULL.
  console.log('\n[syncProjects — default handling for missing fields]');
  const sql2 = makeMockSql();
  await syncProjects(sql2, 'forcecorp', {
    id: 'p2',
    'project-name': 'No-Optional-Fields',
    bidItems: [{ id: 'b2', cost_code: 'X', quantity: 1, unit_cost: 1 }],
  });
  const biCall2 = sql2._calls.find(c => /INSERT INTO bid_items/i.test(c.sql));
  assert('bid_items INSERT issued (defaults case)',  !!biCall2);
  if (biCall2) {
    assert('missing is_complete → false (strict ===)', biCall2.values.includes(false));
    assert('missing change_orders → "[]" jsonb',      biCall2.values.includes('[]'));
  }

  // ── Non-array change_orders should still serialize safely
  console.log('\n[syncProjects — defensive: non-array change_orders]');
  const sql3 = makeMockSql();
  await syncProjects(sql3, 'forcecorp', {
    id: 'p3',
    'project-name': 'Bad Inputs',
    bidItems: [{ id: 'b3', cost_code: 'X', quantity: 1, unit_cost: 1, change_orders: 'not-an-array' }],
  });
  const biCall3 = sql3._calls.find(c => /INSERT INTO bid_items/i.test(c.sql));
  if (biCall3) {
    assert('non-array change_orders coerced to "[]"', biCall3.values.includes('[]'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
