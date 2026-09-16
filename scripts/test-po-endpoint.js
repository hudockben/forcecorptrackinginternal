#!/usr/bin/env node
'use strict';
/**
 * HTTP contract for /api/purchase-orders.
 *
 * Run: node scripts/test-po-endpoint.js
 *
 * scripts/test-po-division.js drives api/lib/po-sync.js directly. This drives
 * the HANDLER, which is where the access decision is actually made and where a
 * mistake would be a permission hole rather than a wrong number:
 *
 *  - which guard each method gets. The full-list PUT must stay behind a real
 *    division role, because one call from central purchasing would replace
 *    everything a division's own tab had saved.
 *  - that GET keeps tracker.html's turf default, which it has always relied on.
 *  - body validation on the single-order writes.
 *  - that the saved order comes BACK, carrying the po_row_id the server minted
 *    — a client that kept its own copy would create a second cost row for the
 *    same delivery on the next save.
 *
 * No DB and no server: neon and the auth helpers are stubbed.
 */

const path = require('path');

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.error(`  ✗ ${label}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`);
}

const endpointPath = path.resolve(__dirname, '../api/purchase-orders.js');
const authPath     = path.resolve(__dirname, '../api/lib/auth.js');
const poSyncPath   = path.resolve(__dirname, '../api/lib/po-sync.js');
const neonPath     = require.resolve('@neondatabase/serverless');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub/neondb';

// The real division rules, so the stub cannot quietly disagree with them.
const realAuth = require(authPath);

/**
 * Load the handler with its dependencies swapped.
 *
 * `roles` is a real division_roles map, run through the REAL
 * hasDivisionAccess / canAccessPODivision — only requireAuth is faked, so what
 * these tests assert about access is what the endpoint actually enforces.
 */
function loadEndpoint({ roles = {}, calls = null, upsertResult, removeResult, sqlStub = null } = {}) {
  [endpointPath, authPath, poSyncPath, neonPath].forEach(p => { delete require.cache[p]; });

  const payload = { companyCode: 'FCT', username: 'u1', divisionRoles: roles };

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: Object.assign({}, realAuth, {
      requireAuth: (req, res) => {
        if (!req.headers || !req.headers.authorization) {
          res.status(401).json({ error: 'Unauthorized' });
          return null;
        }
        return payload;
      },
      requireDivision: (req, res, opts) => {
        const p = require(authPath).requireAuth(req, res);
        if (!p) return null;
        const raw = (req.query && req.query.division) || (req.body && req.body.division) || null;
        const division = realAuth.normalizeDivision(raw) || (opts && opts.required ? null : 'turf');
        if (!division) { res.status(400).json({ error: 'division query param is required' }); return null; }
        if (!realAuth.hasDivisionAccess(p, division)) {
          res.status(403).json({ error: 'You do not have access to this division' });
          return null;
        }
        return { payload: p, division };
      },
    }),
  };

  require.cache[poSyncPath] = {
    id: poSyncPath, filename: poSyncPath, loaded: true,
    exports: {
      upsertPO: async (sql, args) => {
        if (calls) calls.push({ fn: 'upsertPO', args });
        return upsertResult !== undefined ? upsertResult : {
          ok: true,
          // Stands in for the po_row_id syncPOCostRows mints on a line that
          // did not have one.
          purchaseOrder: Object.assign({}, args.po, {
            lines: (args.po.lines || []).map(l => Object.assign({}, l, { po_row_id: l.po_row_id || 'row-' + l.id })),
          }),
          rows: { removed: 0, written: (args.po.lines || []).length },
        };
      },
      removePO: async (sql, args) => {
        if (calls) calls.push({ fn: 'removePO', args });
        return removeResult !== undefined ? removeResult : { ok: true, found: true, rowsRemoved: 1 };
      },
      resolvePODocScope: async () => null,
    },
  };

  require.cache[neonPath] = {
    id: neonPath, filename: neonPath, loaded: true,
    exports: { neon: () => sqlStub || (async () => []) },
  };

  return require(endpointPath);
}

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o)   { this.body = o; return this; },
    end()     { return this; },
  };
}

const AUTHED = { authorization: 'Bearer x' };
const PO = { id: 'po1', po_number: 'PO-0001', title: 'Stone', lines: [{ id: 'L1', qty: '2', unit_cost: '5' }] };

(async () => {
  console.log('\n[the full-list PUT stays behind a real division role]');
  {
    // This is the invariant the whole design rests on. PUT replaces the list.
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'PUT', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrders: [] } }, res);
    check('central purchasing CANNOT replace paving\'s list', res.statusCode === 403, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { paving: 'level3' } });
    const res = makeRes();
    await handler({ method: 'PUT', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrders: [PO] } }, res);
    check('a paving user still can', res.statusCode !== 403, JSON.stringify(res.body));
  }

  console.log('\n[reading]');
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'GET', query: { division: 'paving' }, headers: AUTHED }, res);
    check('central purchasing may READ paving\'s orders', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'GET', query: { division: 'dust' }, headers: AUTHED }, res);
    check('but not a division outside its reach', res.statusCode === 403);
  }
  {
    // tracker.html has always called GET with no division and relied on the
    // turf default. Breaking that would break the turf PO tab outright.
    const handler = loadEndpoint({ roles: { turf: 'level3' } });
    const res = makeRes();
    await handler({ method: 'GET', query: {}, headers: AUTHED }, res);
    check('GET with no division still defaults to turf', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { paving: 'level3' } });
    const res = makeRes();
    await handler({ method: 'GET', query: {}, headers: AUTHED }, res);
    check('and that default is still access-checked', res.statusCode === 403);
  }

  console.log('\n[single-order upsert]');
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('purchasing may upsert one order into paving', res.statusCode === 200, JSON.stringify(res.body));
    check('and it is filed under paving', calls[0] && calls[0].args.division === 'paving');
    // Without this the client keeps a line with no po_row_id and the next save
    // creates a SECOND cost row for the same delivery.
    check('the saved order comes back with the minted row link',
      res.body.purchaseOrder.lines[0].po_row_id === 'row-L1', JSON.stringify(res.body.purchaseOrder));
    check('and the row counts are reported', res.body.rows && res.body.rows.written === 1);
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'POST', query: {}, headers: AUTHED, body: { purchaseOrder: PO } }, res);
    check('a write must NAME its division — no turf default', res.statusCode === 400, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'dust' }, headers: AUTHED, body: { purchaseOrder: PO } }, res);
    check('and it cannot be one outside purchasing\'s reach', res.statusCode === 403);
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    for (const [label, body] of [
      ['a missing order',        {}],
      ['an order with no id',    { purchaseOrder: { po_number: 'PO-1' } }],
      ['an array in its place',  { purchaseOrder: [] }],
      ['lines that are not a list', { purchaseOrder: { id: 'x', lines: 'nope' } }],
    ]) {
      const res = makeRes();
      await handler({ method: 'POST', query: { division: 'turf' }, headers: AUTHED, body }, res);
      check(`${label} is refused`, res.statusCode === 400, JSON.stringify(res.body));
    }
  }
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'turf', from: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('a move names the list it is leaving', calls[0] && calls[0].args.from === 'paving');
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'turf', from: 'dust' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('but not one it cannot reach', res.statusCode === 403, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'turf', from: 'nonsense' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('an unknown `from` is refused, not ignored', res.statusCode === 400, JSON.stringify(res.body));
  }
  {
    // A half-landed move is still a save. Reporting it as a failure would have
    // the client retry from scratch and raise a second order.
    const handler = loadEndpoint({
      roles: { purchase_orders: 'level3' },
      upsertResult: { ok: true, purchaseOrder: PO, rows: {}, staleCopy: true },
    });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'turf', from: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('a half-landed move is reported, not failed',
      res.statusCode === 200 && res.body.staleCopy === true, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({
      roles: { purchase_orders: 'level3' },
      upsertResult: { ok: false, reason: 'conflict' },
    });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'turf' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('an exhausted compare-and-set is a 409, not a silent success',
      res.statusCode === 409, JSON.stringify(res.body));
    check('and it says what to do about it',
      /try again/i.test(JSON.stringify(res.body)), JSON.stringify(res.body));
  }

  console.log('\n[writing needs the purchasing LEVEL, not just reach]');
  {
    // Reaching paving's orders and being allowed to change them are different
    // questions. A view-only purchasing clerk could raise orders against any
    // paving job before this check existed.
    const handler = loadEndpoint({ roles: { purchase_orders: 'level1' } });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('a view-only purchasing user cannot raise an order', res.statusCode === 403, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level2' } });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('a level2 purchasing user can', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    // Deleting an order takes the job's cost rows with it.
    const handler = loadEndpoint({ roles: { purchase_orders: 'level2' } });
    const res = makeRes();
    await handler({ method: 'DELETE', query: { division: 'paving', id: 'po1' }, headers: AUTHED }, res);
    check('but cannot delete one', res.statusCode === 403, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'DELETE', query: { division: 'paving', id: 'po1' }, headers: AUTHED }, res);
    check('a level3 purchasing user can', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    // A view-only user in the division is unchanged by any of this.
    const handler = loadEndpoint({ roles: { paving: 'level1' } });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('a view-only paving user still cannot write', res.statusCode === 403);
  }

  console.log('\n[single-order delete]');
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'DELETE', query: { division: 'kiewit', id: 'po1' }, headers: AUTHED }, res);
    check('purchasing may delete one order', res.statusCode === 200 && res.body.ok);
    check('scoped to the order and division named',
      calls[0].args.poId === 'po1' && calls[0].args.division === 'kiewit');
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'DELETE', query: { division: 'kiewit' }, headers: AUTHED }, res);
    check('a delete with no id is refused', res.statusCode === 400);
  }
  {
    const handler = loadEndpoint({
      roles: { purchase_orders: 'level3' },
      removeResult: { ok: false, reason: 'conflict' },
    });
    const res = makeRes();
    await handler({ method: 'DELETE', query: { division: 'turf', id: 'po1' }, headers: AUTHED }, res);
    check('a lost race on delete is a 409', res.statusCode === 409);
  }
  {
    const handler = loadEndpoint({ roles: { dust: 'level3' } });
    const res = makeRes();
    await handler({ method: 'DELETE', query: { division: 'turf', id: 'po1' }, headers: AUTHED }, res);
    check('an unrelated division cannot delete turf\'s orders', res.statusCode === 403);
  }

  console.log('\n[the basics]');
  {
    const handler = loadEndpoint({ roles: { turf: 'level3' } });
    const res = makeRes();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    check('no token is a 401', res.statusCode === 401);
  }
  {
    const handler = loadEndpoint({ roles: { turf: 'level3' } });
    const res = makeRes();
    await handler({ method: 'PATCH', query: { division: 'turf' }, headers: AUTHED }, res);
    check('an unsupported method is a 405', res.statusCode === 405);
  }
  {
    const handler = loadEndpoint({ roles: { turf: 'level3' } });
    const res = makeRes();
    await handler({ method: 'OPTIONS', query: {}, headers: {} }, res);
    check('every method the page uses is advertised',
      /GET/.test(res.headers['Access-Control-Allow-Methods']) &&
      /POST/.test(res.headers['Access-Control-Allow-Methods']) &&
      /PUT/.test(res.headers['Access-Control-Allow-Methods']) &&
      /DELETE/.test(res.headers['Access-Control-Allow-Methods']),
      res.headers['Access-Control-Allow-Methods']);
  }
  {
    const handler = loadEndpoint({ roles: {}, calls: [] });
    const res = makeRes();
    await handler({ method: 'GET', query: { division: 'purchase_orders' }, headers: AUTHED }, res);
    check('a user with no roles at all reaches nothing', res.statusCode === 403);
  }

  console.log('\n[the full-list PUT no longer erases what it never saw]');
  {
    // A division tab refreshes its list every 60s, but skips while the user is
    // typing. Purchasing raises an order in that window; the tab then saves its
    // stale list. Before the merge, that order was gone — blob, mirror row and
    // all — while the job kept the material charge its deliveries had created.
    // The driver hands back a Date; the client sends the ISO string the GET
    // serialised from it. Both shapes appear below on purpose.
    const T_READ = '2026-09-16T12:00:00.000Z';   // when the client read the list
    const T_MOVED = '2026-09-16T12:05:00.000Z';  // somebody else wrote since
    const T_NEW = '2026-09-16T12:09:00.000Z';    // what this save produces
    const STORED = [
      { id: 'a', po_number: 'PO-0001' },
      { id: 'b', po_number: 'PO-0002' },
      { id: 'purchasing-raised', po_number: 'PO-0003', origin: 'purchasing' },
    ];
    function appDataStub({ storedUpdatedAt }) {
      const seen = [];
      const sql = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: STORED, updated_at: storedUpdatedAt }]);
        }
        if (/^SELECT value FROM app_data/.test(q)) return Promise.resolve([{ value: STORED }]);
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      sql.written = () => {
        const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
        return hit ? JSON.parse(hit.vals[1]) : null;
      };
      return sql;
    }

    {
      // The stale save: client read at T1, someone wrote since.
      const sqlStub = appDataStub({ storedUpdatedAt: new Date(T_MOVED) });
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [STORED[0], STORED[1]], baseUpdatedAt: T_READ } }, res);
      const ids = (sqlStub.written() || []).map(p => p.id);
      check('an order the client never saw survives its save',
        ids.includes('purchasing-raised'), JSON.stringify(ids));
      check('and what it did send is still there',
        ids.includes('a') && ids.includes('b'), JSON.stringify(ids));
      check('the merge is reported', res.body && res.body.merged === 1, JSON.stringify(res.body));
      check('and the new version comes back so the next save is judged fresh',
        res.body && new Date(res.body.updatedAt).getTime() === Date.parse(T_NEW),
        JSON.stringify(res.body));
    }
    {
      // The driver hands back a Date; the client sends the ISO string the GET
      // serialised. Comparing them as text made `moved` true on EVERY save, so
      // a deleted order looked like one the client had never seen and was
      // written straight back — no division tab could delete a purchase order
      // at all. This is the shape the real driver returns.
      const iso = T_READ;
      const sqlStub = appDataStub({ storedUpdatedAt: new Date(iso) });
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [STORED[0], STORED[2]], baseUpdatedAt: iso } }, res);
      const ids = (sqlStub.written() || []).map(p => p.id);
      check('a Date and its own ISO string count as unchanged',
        res.body.merged === 0, JSON.stringify(res.body));
      check('so deleting an order from a division tab actually deletes it',
        !ids.includes('b'), JSON.stringify(ids));
    }
    {
      // Nobody wrote in between: the list is replaced exactly as before, so a
      // deliberate delete still deletes.
      const sqlStub = appDataStub({ storedUpdatedAt: new Date(T_READ) });
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [STORED[0]], baseUpdatedAt: T_READ } }, res);
      const ids = (sqlStub.written() || []).map(p => p.id);
      check('an up-to-date client still deletes what it dropped',
        ids.length === 1 && ids[0] === 'a', JSON.stringify(ids));
      check('and nothing is reported as merged', res.body.merged === 0);
    }
    {
      // A client that sends no version keeps the old behaviour exactly.
      const sqlStub = appDataStub({ storedUpdatedAt: new Date(T_MOVED) });
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [STORED[0]] } }, res);
      const ids = (sqlStub.written() || []).map(p => p.id);
      check('a client with no version behaves as it always did',
        ids.length === 1 && ids[0] === 'a', JSON.stringify(ids));
    }
    {
      // The same protection one level down. An order the client DID send may
      // still be missing deliveries added to it since — and dropping those took
      // the job cost rows behind them via _syncPOs' orphan sweep.
      const WITH_LINES = [
        { id: 'a', po_number: 'PO-0001', lines: [{ id: 'L1' }, { id: 'L2' }] },
      ];
      const seen = [];
      const sqlStub = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: WITH_LINES, updated_at: new Date(T_MOVED) }]);
        }
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      // The client's copy of the same order, missing L2.
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [{ id: 'a', po_number: 'PO-0001', lines: [{ id: 'L1' }] }],
                              baseUpdatedAt: T_READ } }, res);
      const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
      const written = hit ? JSON.parse(hit.vals[1]) : [];
      const lineIds = ((written[0] || {}).lines || []).map(l => l.id);
      check('a delivery the client never saw survives its save',
        lineIds.includes('L2'), JSON.stringify(lineIds));
      check('and the one it did send is still there', lineIds.includes('L1'), JSON.stringify(lineIds));
    }
    {
      // ?force=1 is a genuine wipe and must stay one.
      const sqlStub = appDataStub({ storedUpdatedAt: new Date(T_MOVED) });
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf', force: '1' }, headers: AUTHED,
                      body: { purchaseOrders: [], baseUpdatedAt: T_READ } }, res);
      const ids = (sqlStub.written() || []).map(p => p.id);
      check('force=1 still means what it says', ids.length === 0, JSON.stringify(ids));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
