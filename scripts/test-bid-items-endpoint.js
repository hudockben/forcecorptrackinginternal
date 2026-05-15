#!/usr/bin/env node
'use strict';
/**
 * Smoke test for /api/bid-items.
 *
 * Run: node scripts/test-bid-items-endpoint.js
 *
 * Asserts the per-bid-item PUT endpoint:
 *  - rejects invalid auth, query params, and body shapes
 *  - enforces division access per projectKey prefix
 *  - normalises field types correctly
 *  - issues the expected SQL (jsonb_agg replace OR || append, then index
 *    _ts bump, then the mirror upsert)
 *  - returns 404 when the project blob doesn't exist
 *  - tolerates a normalised-mirror failure without surfacing it
 *
 * No DB required — the neon driver is mocked and queries are captured
 * as strings so we can pattern-match the SQL shape.
 */

const path = require('path');
const Module = require('module');

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
// Mock neon driver — captures each tagged-template SQL call so the
// tests can pattern-match the issued SQL. Each call returns an array
// (the postgres-driver shape used by the rest of the codebase).
// ─────────────────────────────────────────────────────────────────────
function makeMockSql({ projectBlobExists = true, mirrorThrows = false } = {}) {
  const calls = [];
  let mirrorCallSeen = false;
  function sql(strings, ...vals) {
    // Reconstruct the SQL string with $-style placeholders for capture.
    let str = '';
    strings.forEach((s, i) => {
      str += s;
      if (i < vals.length) str += `$${i + 1}`;
    });
    calls.push({ sql: str.trim(), values: vals });

    // Project blob UPDATE ... RETURNING 1
    if (/UPDATE app_data[\s\S]+RETURNING 1/i.test(str)) {
      return Promise.resolve(projectBlobExists ? [{ '?column?': 1 }] : []);
    }
    // Index _ts UPDATE (no RETURNING)
    if (/jsonb_set\(\s*COALESCE\(value,\s*'\{"ids":\s*\[\]\}/i.test(str)) {
      return Promise.resolve([]);
    }
    // Mirror INSERT ... ON CONFLICT
    if (/INSERT INTO bid_items/i.test(str)) {
      mirrorCallSeen = true;
      if (mirrorThrows) return Promise.reject(new Error('mirror table missing column'));
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }
  Object.defineProperty(sql, '_calls', { get: () => calls });
  Object.defineProperty(sql, '_mirrorSeen', { get: () => mirrorCallSeen });
  return sql;
}

// ─────────────────────────────────────────────────────────────────────
// Loader that swaps the endpoint's dependencies with our mocks. We use
// Module._resolveFilename to short-circuit the @neondatabase/serverless
// require so the endpoint never touches a real DB.
// ─────────────────────────────────────────────────────────────────────
function loadEndpoint({ sql, authPayload, divisionAllowed = true }) {
  // Clear the require cache for the endpoint and its deps so each test
  // gets a fresh module with our mocks injected.
  const endpointPath = path.resolve(__dirname, '../api/bid-items.js');
  const authPath     = path.resolve(__dirname, '../api/lib/auth.js');
  delete require.cache[endpointPath];
  delete require.cache[authPath];

  // Inject a fake auth module that returns the chosen payload.
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      requireAuth: (req, res) => {
        if (authPayload === null) {
          res.status(401).json({ error: 'Unauthorized' });
          return null;
        }
        return authPayload;
      },
      hasDivisionAccess: () => divisionAllowed,
      divisionForKey: (key) => key && key.startsWith('fct_paving_') ? 'paving' : null,
    },
  };

  // Inject a fake neon module.
  const neonPath = require.resolve('@neondatabase/serverless');
  delete require.cache[neonPath];
  require.cache[neonPath] = {
    id: neonPath,
    filename: neonPath,
    loaded: true,
    exports: { neon: () => sql },
  };

  return require(endpointPath);
}

// ─────────────────────────────────────────────────────────────────────
// Minimal req/res mocks.
// ─────────────────────────────────────────────────────────────────────
function makeReq({ method = 'PUT', query = {}, body = {}, headers = {} } = {}) {
  return { method, query, body, headers };
}
function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj)   { this.body = obj; return this; },
    end()       { return this; },
  };
  return res;
}

const goodAuth = { companyCode: 'forcecorp', userId: 'u1' };

// ─────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n[validation — auth / query / body]');

  // 1. Missing auth → 401
  {
    const sql = makeMockSql();
    const handler = loadEndpoint({ sql, authPayload: null });
    const req = makeReq({ query: { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' } });
    const res = makeRes();
    await handler(req, res);
    assert('missing auth → 401', res.statusCode === 401);
  }

  // 2. Wrong method → 405 with Allow header
  {
    const sql = makeMockSql();
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const req = makeReq({ method: 'POST', query: { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' } });
    const res = makeRes();
    await handler(req, res);
    assert('POST → 405',                  res.statusCode === 405);
    assert('POST sets Allow: PUT header', res.headers['Allow'] === 'PUT');
  }

  // 3. OPTIONS preflight → 200 with CORS headers
  {
    const sql = makeMockSql();
    const handler = loadEndpoint({ sql, authPayload: null }); // OPTIONS short-circuits before auth
    const req = makeReq({ method: 'OPTIONS' });
    const res = makeRes();
    await handler(req, res);
    assert('OPTIONS → 200',                  res.statusCode === 200);
    assert('OPTIONS sets CORS Allow-Methods', /PUT/.test(res.headers['Access-Control-Allow-Methods'] || ''));
  }

  // 4. Missing query params → 400
  for (const missing of ['id', 'projectId', 'projectKey']) {
    const sql = makeMockSql();
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const query = { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' };
    delete query[missing];
    const res = makeRes();
    await handler(makeReq({ query, body: { bidItem: { id: 'b1' } } }), res);
    assert(`missing query.${missing} → 400`, res.statusCode === 400);
  }

  // 5. Probe-style projectKey → 400 (security: can't be used to write arbitrary blobs)
  {
    const probes = [
      'fct_intercompany_billing_entries',
      'fct_lists',
      'fct_projects_index',
      'fct_trend_x',
      '../etc/passwd',
      'fct_project_',                 // empty id
      'fct_project_../sneak',
    ];
    for (const projectKey of probes) {
      const sql = makeMockSql();
      const handler = loadEndpoint({ sql, authPayload: goodAuth });
      const req = makeReq({ query: { id: 'b1', projectId: 'p1', projectKey }, body: { bidItem: { id: 'b1' } } });
      const res = makeRes();
      await handler(req, res);
      assert(`reject projectKey "${projectKey}" → 400`, res.statusCode === 400);
      assert(`  no SQL issued for "${projectKey}"`,     sql._calls.length === 0);
    }
  }

  // 6. Body missing bidItem → 400
  {
    const sql = makeMockSql();
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const res = makeRes();
    await handler(makeReq({ query: { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' }, body: {} }), res);
    assert('missing body.bidItem → 400', res.statusCode === 400);
  }

  // 7. bidItem.id mismatch → 400
  {
    const sql = makeMockSql();
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const res = makeRes();
    await handler(makeReq({
      query: { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' },
      body:  { bidItem: { id: 'b2' } },
    }), res);
    assert('bidItem.id mismatch → 400', res.statusCode === 400);
  }

  // 8. Cross-division: paving key requires paving access
  {
    const sql = makeMockSql();
    const handler = loadEndpoint({ sql, authPayload: goodAuth, divisionAllowed: false });
    const req = makeReq({
      query: { id: 'b1', projectId: 'p1', projectKey: 'fct_paving_project_p1' },
      body:  { bidItem: { id: 'b1' } },
    });
    const res = makeRes();
    await handler(req, res);
    assert('division access denied → 403', res.statusCode === 403);
    assert('  no SQL issued',              sql._calls.length === 0);
  }

  console.log('\n[happy path — turf project]');
  {
    const sql = makeMockSql({ projectBlobExists: true });
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const bidItem = {
      id: 'b1', cost_code: 'Tennis Paving', sub_code: 'Court Surface',
      description: 'Asphalt subbase', quantity: '3521', unit: 'SY',
      unit_cost: '20.53', status: 'Active',
      start_date: '2026-05-15', target_date: '2026-05-18',
      is_complete: false, change_orders: [],
    };
    const res = makeRes();
    await handler(makeReq({
      query: { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' },
      body:  { bidItem, ts: 1747300000000 },
    }), res);
    assert('happy path → 200',           res.statusCode === 200);
    assert('returns ok:true',            res.body && res.body.ok === true);
    assert('issued 3 SQL statements',    sql._calls.length === 3,
           `actual count=${sql._calls.length}`);
    // 1st: project blob jsonb_set
    assert('1st SQL updates app_data project blob', /UPDATE app_data[\s\S]+jsonb_set/i.test(sql._calls[0].sql));
    assert('  uses jsonb_agg replace path',          /jsonb_agg\(/i.test(sql._calls[0].sql));
    assert('  uses || append fallback',              /COALESCE\(value->'bidItems'/i.test(sql._calls[0].sql) && /\|\|/.test(sql._calls[0].sql));
    assert('  RETURNING 1 for existence check',      /RETURNING 1/i.test(sql._calls[0].sql));
    assert('  scoped key forcecorp:fct_project_p1',  sql._calls[0].values.includes('forcecorp:fct_project_p1'));
    // 2nd: index _ts bump using client ts
    assert('2nd SQL bumps projects-index _ts',       /jsonb_set\(\s*COALESCE\(value,\s*'\{"ids":\s*\[\]\}/i.test(sql._calls[1].sql));
    assert('  uses client-supplied ts',              sql._calls[1].values.includes(1747300000000));
    assert('  scoped index key turf',                sql._calls[1].values.includes('forcecorp:fct_projects_index'));
    // 3rd: mirror upsert
    assert('3rd SQL upserts bid_items table',        /INSERT INTO bid_items/i.test(sql._calls[2].sql));
    assert('  ON CONFLICT DO UPDATE',                /ON CONFLICT \(id\) DO UPDATE/i.test(sql._calls[2].sql));
    // Number coercion
    assert('quantity coerced from "3521" to 3521',   sql._calls[2].values.includes(3521));
    assert('unit_cost coerced from "20.53" to 20.53', sql._calls[2].values.includes(20.53));
  }

  console.log('\n[happy path — paving project routes to paving index]');
  {
    const sql = makeMockSql({ projectBlobExists: true });
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const res = makeRes();
    await handler(makeReq({
      query: { id: 'b1', projectId: 'p1', projectKey: 'fct_paving_project_p1' },
      body:  { bidItem: { id: 'b1', cost_code: 'X' } },
    }), res);
    assert('paving project → 200',                   res.statusCode === 200);
    assert('  paving index ts bumped (not turf)',    sql._calls[1].values.includes('forcecorp:fct_paving_projects_index'));
    assert('  paving blob scoped',                   sql._calls[0].values.includes('forcecorp:fct_paving_project_p1'));
  }

  console.log('\n[404 — project blob does not exist]');
  {
    const sql = makeMockSql({ projectBlobExists: false });
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const res = makeRes();
    await handler(makeReq({
      query: { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' },
      body:  { bidItem: { id: 'b1' } },
    }), res);
    assert('missing blob → 404',                     res.statusCode === 404);
    assert('  stops after blob UPDATE attempt',      sql._calls.length === 1);
    assert('  does NOT bump index ts',               !sql._calls.some(c => /COALESCE\(value,\s*'\{"ids"/.test(c.sql)));
    assert('  does NOT touch mirror table',          !sql._mirrorSeen);
  }

  console.log('\n[mirror failure is non-fatal]');
  {
    const sql = makeMockSql({ projectBlobExists: true, mirrorThrows: true });
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const res = makeRes();
    // Silence the [bid-items] warn for cleaner output
    const origWarn = console.warn;
    console.warn = () => {};
    await handler(makeReq({
      query: { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' },
      body:  { bidItem: { id: 'b1' } },
    }), res);
    console.warn = origWarn;
    assert('mirror throws but → 200',                res.statusCode === 200);
    assert('  body still ok:true',                   res.body && res.body.ok === true);
  }

  console.log('\n[ts coercion]');
  {
    // Missing / invalid ts should fall back to Date.now() without crashing
    for (const badTs of [undefined, null, 'not-a-number', NaN, {}]) {
      const sql = makeMockSql({ projectBlobExists: true });
      const handler = loadEndpoint({ sql, authPayload: goodAuth });
      const res = makeRes();
      await handler(makeReq({
        query: { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' },
        body:  { bidItem: { id: 'b1' }, ts: badTs },
      }), res);
      assert(`ts=${JSON.stringify(badTs)} still → 200`, res.statusCode === 200);
      // Index ts call should have a finite number as the ts value
      const tsValues = sql._calls[1].values.filter(v => typeof v === 'number' && Number.isFinite(v));
      assert('  index ts call used a finite number',  tsValues.length > 0);
    }
  }

  console.log('\n[normalisation — null vs empty vs invalid]');
  {
    const sql = makeMockSql({ projectBlobExists: true });
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const res = makeRes();
    const bidItem = {
      id: 'b1',
      cost_code: undefined,        // → ''
      sub_code: '',                 // → null
      description: '',              // → null
      quantity: 'not-a-number',     // → 0 (safeFloat ?? 0)
      unit: null,                   // → null
      unit_cost: undefined,         // → 0
      status: 'Bogus Status',       // → 'Active'
      start_date: 'invalid-date',   // → null
      target_date: '2026-13-99',    // → null (length OK but invalid; safeDate just slices)
      is_complete: 'yes',           // → false (strict ===)
      change_orders: 'not-an-array', // → []
    };
    await handler(makeReq({
      query: { id: 'b1', projectId: 'p1', projectKey: 'fct_project_p1' },
      body:  { bidItem },
    }), res);
    assert('happy → 200',                         res.statusCode === 200);
    const mirrorCall = sql._calls[2];
    // Each normalised value should appear in the values array passed to the mirror insert
    assert('  cost_code normalised to ""',        mirrorCall.values.includes(''));
    assert('  status fell back to "Active"',      mirrorCall.values.includes('Active'));
    assert('  quantity coerced to 0',             mirrorCall.values.includes(0));
    assert('  start_date coerced to null',        mirrorCall.values.indexOf(null) >= 0);
    assert('  is_complete strict-false (not "yes")', mirrorCall.values.includes(false));
    assert('  change_orders empty-array JSON',    mirrorCall.values.includes('[]'));
  }

  console.log('\n[SQL safety — no obvious injection vectors]');
  {
    // The endpoint uses parameterised tagged templates only. Verify the
    // user-controlled id ends up as a $-placeholder value, not inlined.
    const sql = makeMockSql({ projectBlobExists: true });
    const handler = loadEndpoint({ sql, authPayload: goodAuth });
    const res = makeRes();
    const badId = "b1'; DROP TABLE bid_items;--";
    // Endpoint enforces bidItem.id === query.id, so the query.id has to
    // match. Match the validator regex on projectKey (alphanumerics
    // + _ -) so it doesn't 400 us before we reach the SQL stage.
    await handler(makeReq({
      query: { id: badId, projectId: 'p1', projectKey: 'fct_project_p1' },
      body:  { bidItem: { id: badId } },
    }), res);
    // We expect 200 (treated as a normal id; PG params escape it)
    assert('SQLi-shaped id still → 200 via params', res.statusCode === 200);
    assert('  bad id appears as a parameter value', sql._calls[0].values.includes(badId));
    assert('  SQL text does NOT contain raw quotes', !/DROP TABLE/i.test(sql._calls[0].sql));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(2);
});
