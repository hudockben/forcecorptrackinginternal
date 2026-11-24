#!/usr/bin/env node
'use strict';
/**
 * SQL-level integration test for /api/bid-items.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-bid-items-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Runs the actual jsonb_set / jsonb_agg / || queries against a real
 * PostgreSQL to verify the semantics are correct:
 *   - replace-by-id works (existing bid item)
 *   - append works (new bid item)
 *   - missing bidItems key gets created
 *   - missing project blob does not match (RETURNING returns 0 rows)
 *   - index _ts bump uses the supplied numeric ts
 *   - concurrent updates to the same project serialize cleanly
 *   - it hands back the line as stored before it (the codes a rename
 *     carries to the job's purchase orders come from there)
 */

const { Client } = require('pg');

const url = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

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

async function setup(c) {
  await c.query(`
    DROP TABLE IF EXISTS app_data;
    CREATE TABLE app_data (
      key TEXT PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// The exact UPDATE statement from api/bid-items.js, parameterised.
async function patchBidItem(c, { projectKey, biId, itemJson, indexKey, indexTs, companyCode }) {
  const scopedProjectKey = `${companyCode}:${projectKey}`;
  const scopedIndexKey   = `${companyCode}:${indexKey}`;
  const blobRes = await c.query(`
    WITH was AS (
      SELECT e.v AS line
        FROM app_data a
       CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(a.value->'bidItems') = 'array' THEN a.value->'bidItems' ELSE '[]'::jsonb END)
              WITH ORDINALITY AS e(v, ord)
       WHERE a.key = $3 AND e.v->>'id' = $1
       ORDER BY e.ord DESC
       LIMIT 1
    )
    UPDATE app_data
    SET value = jsonb_set(
          COALESCE(value, '{}'::jsonb),
          ARRAY['bidItems'],
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM jsonb_array_elements(COALESCE(value->'bidItems', '[]'::jsonb)) AS e
              WHERE e->>'id' = $1
            )
            THEN (
              SELECT jsonb_agg(
                CASE WHEN e->>'id' = $1 THEN $2::jsonb ELSE e END
              )
              FROM jsonb_array_elements(value->'bidItems') AS e
            )
            ELSE COALESCE(value->'bidItems', '[]'::jsonb) || $2::jsonb
          END
        ),
        updated_at = NOW()
    WHERE key = $3
    RETURNING 1 AS found, (SELECT line FROM was) AS line_before
  `, [biId, itemJson, scopedProjectKey]);
  if (!blobRes.rows.length) return { matched: false };
  const lineBefore = blobRes.rows[0].line_before;

  await c.query(`
    UPDATE app_data
    SET value = jsonb_set(
          COALESCE(value, '{"ids": []}'::jsonb),
          '{_ts}',
          to_jsonb($1::bigint)
        ),
        updated_at = NOW()
    WHERE key = $2
  `, [indexTs, scopedIndexKey]);
  return { matched: true, lineBefore };
}

async function getBlob(c, key) {
  const r = await c.query(`SELECT value FROM app_data WHERE key = $1`, [key]);
  return r.rows.length ? r.rows[0].value : null;
}

async function main() {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await setup(c);

    const COMPANY = 'forcecorp';
    const PROJECT_KEY = 'fct_project_p1';
    const INDEX_KEY   = 'fct_projects_index';

    // Seed a project blob with two bid items.
    await c.query(
      `INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)`,
      [
        `${COMPANY}:${PROJECT_KEY}`,
        JSON.stringify({
          'project-name': 'Franklin Regional',
          bidItems: [
            { id: 'b1', cost_code: 'Tennis Demo', sub_code: 'Fence Removal', start_date: '', target_date: '' },
            { id: 'b2', cost_code: 'Tennis Demo', sub_code: 'Sealcoat',      start_date: '', target_date: '' },
          ],
        }),
      ]
    );
    await c.query(
      `INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)`,
      [`${COMPANY}:${INDEX_KEY}`, JSON.stringify({ ids: ['p1'], _ts: 1000 })]
    );

    console.log('\n[replace existing bid item via jsonb_agg branch]');
    {
      const updated = { id: 'b1', cost_code: 'Tennis Demo', sub_code: 'Fence Removal', start_date: '2026-05-15', target_date: '2026-05-18' };
      const r = await patchBidItem(c, {
        projectKey: PROJECT_KEY, biId: 'b1', itemJson: JSON.stringify(updated),
        indexKey: INDEX_KEY, indexTs: 2000, companyCode: COMPANY,
      });
      assert('matched existing project blob', r.matched);
      const blob = await getBlob(c, `${COMPANY}:${PROJECT_KEY}`);
      assert('bidItems still has 2 items',     blob.bidItems.length === 2);
      const b1 = blob.bidItems.find(b => b.id === 'b1');
      const b2 = blob.bidItems.find(b => b.id === 'b2');
      assert('b1 start_date updated',          b1.start_date === '2026-05-15');
      assert('b1 target_date updated',         b1.target_date === '2026-05-18');
      assert('b2 unchanged',                   b2.sub_code === 'Sealcoat' && b2.start_date === '');
      const idx = await getBlob(c, `${COMPANY}:${INDEX_KEY}`);
      assert('index _ts bumped to 2000',       Number(idx._ts) === 2000);
      assert('index ids preserved',            JSON.stringify(idx.ids) === JSON.stringify(['p1']));
    }

    console.log('\n[append new bid item via || branch]');
    {
      const fresh = { id: 'b3', cost_code: 'Tennis Sports Equipment', sub_code: 'Tennis Netting', start_date: '2026-06-01' };
      const r = await patchBidItem(c, {
        projectKey: PROJECT_KEY, biId: 'b3', itemJson: JSON.stringify(fresh),
        indexKey: INDEX_KEY, indexTs: 3000, companyCode: COMPANY,
      });
      assert('matched existing project blob (b3 new)', r.matched);
      const blob = await getBlob(c, `${COMPANY}:${PROJECT_KEY}`);
      assert('bidItems now has 3 items',               blob.bidItems.length === 3);
      const b3 = blob.bidItems.find(b => b.id === 'b3');
      assert('b3 appended with start_date',            b3 && b3.start_date === '2026-06-01');
      // Existing items untouched
      assert('b1 still present after append',          blob.bidItems.find(b => b.id === 'b1'));
      assert('b2 still present after append',          blob.bidItems.find(b => b.id === 'b2'));
    }

    console.log('\n[blob without bidItems key — gets created from empty]');
    {
      const KEY = 'fct_project_p2';
      await c.query(
        `INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)`,
        [`${COMPANY}:${KEY}`, JSON.stringify({ 'project-name': 'No Items Yet' })],
      );
      const item = { id: 'b1', cost_code: 'X', sub_code: 'Y' };
      const r = await patchBidItem(c, {
        projectKey: KEY, biId: 'b1', itemJson: JSON.stringify(item),
        indexKey: INDEX_KEY, indexTs: 4000, companyCode: COMPANY,
      });
      assert('matched (blob with no bidItems key)',    r.matched);
      const blob = await getBlob(c, `${COMPANY}:${KEY}`);
      assert('bidItems array created',                 Array.isArray(blob.bidItems));
      assert('contains the new item',                  blob.bidItems.length === 1 && blob.bidItems[0].id === 'b1');
      assert('original project-name preserved',        blob['project-name'] === 'No Items Yet');
    }

    console.log('\n[missing project blob — RETURNING 0 rows → no match]');
    {
      const r = await patchBidItem(c, {
        projectKey: 'fct_project_nonexistent', biId: 'b1',
        itemJson: JSON.stringify({ id: 'b1' }),
        indexKey: INDEX_KEY, indexTs: 5000, companyCode: COMPANY,
      });
      assert('does NOT match nonexistent blob',        r.matched === false);
    }

    console.log('\n[blob with NULL value column — COALESCE protects jsonb_set]');
    {
      const KEY = 'fct_project_pnull';
      await c.query(`INSERT INTO app_data (key, value) VALUES ($1, NULL)`, [`${COMPANY}:${KEY}`]);
      const r = await patchBidItem(c, {
        projectKey: KEY, biId: 'b1',
        itemJson: JSON.stringify({ id: 'b1', sub_code: 'NullCase' }),
        indexKey: INDEX_KEY, indexTs: 6000, companyCode: COMPANY,
      });
      assert('matched even with NULL value',           r.matched);
      const blob = await getBlob(c, `${COMPANY}:${KEY}`);
      assert('blob now {bidItems: [item]}',            blob.bidItems.length === 1 && blob.bidItems[0].id === 'b1');
    }

    console.log('\n[the line as it was before the write]');
    {
      // A rename on the bid page is carried to the job's purchase orders
      // from the line's codes as the blob held them before this write.
      const KEY = 'fct_project_pbefore';
      await c.query(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)`, [`${COMPANY}:${KEY}`, JSON.stringify({ bidItems: [
        { id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' },
        { id: 'b2', cost_code: 'Stormwater', sub_code: 'Perf Drain' },
        { id: 'b2', cost_code: 'Stormwater', sub_code: 'Perf Drain (last copy)' },
      ] })]);
      let r = await patchBidItem(c, {
        projectKey: KEY, biId: 'b1', itemJson: JSON.stringify({ id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric 8oz' }),
        indexKey: INDEX_KEY, indexTs: 6500, companyCode: COMPANY,
      });
      assert('a renamed line comes back as it was stored before the write',
        r.matched && r.lineBefore && r.lineBefore.sub_code === 'Geofabric', JSON.stringify(r.lineBefore));
      const after = (await getBlob(c, `${COMPANY}:${KEY}`)).bidItems;
      assert('…while the blob holds it renamed, in place', after.length === 3 && after[0].sub_code === 'Geofabric 8oz', JSON.stringify(after));
      r = await patchBidItem(c, {
        projectKey: KEY, biId: 'b2', itemJson: JSON.stringify({ id: 'b2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15in' }),
        indexKey: INDEX_KEY, indexTs: 6501, companyCode: COMPANY,
      });
      assert('a line id twice: the last copy is the one read (as the page indexes it)',
        r.lineBefore && r.lineBefore.sub_code === 'Perf Drain (last copy)', JSON.stringify(r.lineBefore));
      r = await patchBidItem(c, {
        projectKey: KEY, biId: 'b9', itemJson: JSON.stringify({ id: 'b9', cost_code: 'E&S', sub_code: 'Silt Sock' }),
        indexKey: INDEX_KEY, indexTs: 6502, companyCode: COMPANY,
      });
      assert('a line new to the bid had nothing before it', r.matched && r.lineBefore === null, JSON.stringify(r));
      await c.query(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)`, [`${COMPANY}:fct_project_pnobid`, JSON.stringify({ name: 'x' })]);
      r = await patchBidItem(c, {
        projectKey: 'fct_project_pnobid', biId: 'b1', itemJson: JSON.stringify({ id: 'b1', cost_code: 'X' }),
        indexKey: INDEX_KEY, indexTs: 6503, companyCode: COMPANY,
      });
      assert('…nor did one on a blob with no bid yet', r.matched && r.lineBefore === null, JSON.stringify(r));
    }

    console.log('\n[index row missing — UPDATE no-op, no crash]');
    {
      // Drop the index row to simulate first-deploy state
      await c.query(`DELETE FROM app_data WHERE key = $1`, [`${COMPANY}:${INDEX_KEY}`]);
      const r = await patchBidItem(c, {
        projectKey: PROJECT_KEY, biId: 'b1',
        itemJson: JSON.stringify({ id: 'b1', sub_code: 'OK' }),
        indexKey: INDEX_KEY, indexTs: 7000, companyCode: COMPANY,
      });
      assert('blob update still succeeds without index row', r.matched);
      const idx = await getBlob(c, `${COMPANY}:${INDEX_KEY}`);
      assert('index row remains absent (no auto-create)',   idx === null);
    }

    console.log('\n[concurrent updates to the same project serialise]');
    {
      // Re-seed index and reset the project blob to a clean state
      await c.query(
        `INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [`${COMPANY}:${INDEX_KEY}`, JSON.stringify({ ids: ['p1'], _ts: 0 })]
      );
      await c.query(
        `UPDATE app_data SET value = $1::jsonb WHERE key = $2`,
        [JSON.stringify({ bidItems: [
          { id: 'b1', sub_code: 'orig1' },
          { id: 'b2', sub_code: 'orig2' },
        ] }), `${COMPANY}:${PROJECT_KEY}`]
      );

      // Fire two patches concurrently — different bid items, same project.
      const c2 = new Client({ connectionString: url });
      await c2.connect();
      try {
        const p1 = patchBidItem(c, {
          projectKey: PROJECT_KEY, biId: 'b1',
          itemJson: JSON.stringify({ id: 'b1', sub_code: 'updated1' }),
          indexKey: INDEX_KEY, indexTs: 8000, companyCode: COMPANY,
        });
        const p2 = patchBidItem(c2, {
          projectKey: PROJECT_KEY, biId: 'b2',
          itemJson: JSON.stringify({ id: 'b2', sub_code: 'updated2' }),
          indexKey: INDEX_KEY, indexTs: 8001, companyCode: COMPANY,
        });
        const [r1, r2] = await Promise.all([p1, p2]);
        assert('both concurrent patches matched',        r1.matched && r2.matched);
        const blob = await getBlob(c, `${COMPANY}:${PROJECT_KEY}`);
        const b1 = blob.bidItems.find(b => b.id === 'b1');
        const b2 = blob.bidItems.find(b => b.id === 'b2');
        assert('b1 has updated1 (no lost update)',       b1.sub_code === 'updated1');
        assert('b2 has updated2 (no lost update)',       b2.sub_code === 'updated2');
        assert('bidItems still exactly 2 items',          blob.bidItems.length === 2);
      } finally {
        await c2.end();
      }
    }
  } finally {
    await c.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('SQL test crashed:', err);
  process.exit(2);
});
