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
// ...and the real po-sync, for what the handler runs in-line rather than
// delegating: the creation-stamp helpers are pure, and stubbing them would let
// the PUT arm's use of them go untested.
const realPoSync = require(poSyncPath);

/**
 * Load the handler with its dependencies swapped.
 *
 * `roles` is a real division_roles map, run through the REAL
 * hasDivisionAccess / canAccessPODivision — only requireAuth is faked, so what
 * these tests assert about access is what the endpoint actually enforces.
 */
function loadEndpoint({ roles = {}, calls = null, upsertResult, removeResult, reconcileResult, sqlStub = null } = {}) {
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
    // Everything the handler runs in-line is the real thing — the stamp
    // helpers and the Daily Tracking derivation, which reads job rows through
    // the sql stub — and only the single-order writes are faked.
    exports: Object.assign({}, realPoSync, {
      reconcileDailyLines: async (sql, args) => {
        if (calls) calls.push({ fn: 'reconcileDailyLines', args });
        return reconcileResult !== undefined ? reconcileResult : { ok: true, changed: ['po1'], list: [PO] };
      },
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
    }),
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

  console.log('\n[Daily Tracking deliveries: what a save says it edited, and the catch-up]');
  {
    // A line recorded from a Daily Tracking row takes its figures from the row
    // unless purchasing says it edited that line — so the save must pass on
    // which lines it did, the way it passes on which it deleted.
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO, editedLineIds: ['dr-r1', 7] } }, res);
    check('the edited lines reach the upsert', calls[0] && JSON.stringify(calls[0].args.editedLineIds) === '["dr-r1","7"]',
      calls[0] && JSON.stringify(calls[0].args.editedLineIds));
    const res2 = makeRes();
    await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO, editedLineIds: 'dr-r1' } }, res2);
    check('anything but a list is no edits at all', calls[1] && Array.isArray(calls[1].args.editedLineIds)
      && calls[1].args.editedLineIds.length === 0);
  }
  {
    const calls = [];
    const sqlStub = (strings) => Promise.resolve(/SELECT updated_at FROM app_data/.test(strings.join(' '))
      ? [{ updated_at: new Date('2026-11-10T00:00:05Z') }] : []);
    const handler = loadEndpoint({ roles: { turf: 'level2' }, calls, sqlStub });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'turf', reconcile: '1' }, headers: AUTHED, body: {} }, res);
    check('a division editor can ask for the catch-up', res.statusCode === 200 && res.body.ok === true, JSON.stringify(res.body));
    check('  which the server runs over the whole division', calls.some(c => c.fn === 'reconcileDailyLines'
      && c.args.division === 'turf' && c.args.companyCode === 'FCT'));
    check('  and answers with the list, its version and what changed',
      Array.isArray(res.body.purchaseOrders) && res.body.changed === 1 && Boolean(res.body.updatedAt), JSON.stringify(res.body));
    check('  without being taken for a save', !calls.some(c => c.fn === 'upsertPO'));
  }
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { turf: 'level1' }, calls });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'turf', reconcile: '1' }, headers: AUTHED, body: {} }, res);
    check('a view-only user cannot run it', res.statusCode === 403 && !calls.length, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { turf: 'level3' }, reconcileResult: { ok: false, changed: [], list: null } });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'turf', reconcile: '1' }, headers: AUTHED, body: {} }, res);
    check('a catch-up that loses every race says so', res.statusCode === 409, JSON.stringify(res.body));
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

  console.log('\n[a division no purchase order can be filed under]');
  {
    // normalizeDivision accepts all sixteen divisions and the access guard
    // passes anyone holding a role in the one they named, but purchase_orders'
    // CHECK admits only the source divisions plus the general list. The INSERT
    // that violated it ran AFTER the blob write committed:
    // the order was stored, the caller was told "Database error", and the
    // retry hit the same wall forever.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const handler = loadEndpoint({ roles: { fuel: 'level3' } });
      const res = makeRes();
      await handler({
        method,
        query: { division: 'fuel', id: 'po1' },
        headers: AUTHED,
        body: { purchaseOrder: { id: 'po1', po_number: 'PO-0001', lines: [] }, purchaseOrders: [] },
      }, res);
      check(`a ${method} against fuel is refused before anything is written`,
        res.statusCode === 400, method + ' -> ' + res.statusCode + ' ' + JSON.stringify(res.body));
    }
  }
  {
    // Reading is not writing. A GET names no row in either mirror table, and
    // refusing it would break a division that legitimately has no orders.
    const handler = loadEndpoint({ roles: { fuel: 'level3' }, calls: [] });
    const res = makeRes();
    await handler({ method: 'GET', query: { division: 'fuel' }, headers: AUTHED }, res);
    check('but a GET against it still answers', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    // The four the full-list PUT has always served keep working.
    for (const division of ['turf', 'paving', 'kiewit', 'purchase_orders']) {
      const handler = loadEndpoint({ roles: { [division]: 'level3' } });
      const res = makeRes();
      await handler({
        method: 'PUT', query: { division },
        headers: AUTHED, body: { purchaseOrders: [] },
      }, res);
      check(`${division} is still storable`, res.statusCode !== 400,
        division + ' -> ' + res.statusCode + ' ' + JSON.stringify(res.body));
    }
  }

  console.log('\n[quarry: purchasing files orders there, one at a time]');
  {
    // Quarry has no Purchase Orders tab, so nothing legitimately PUTs its whole
    // list — central purchasing writes it through POST and DELETE. A PUT would
    // let any quarry role, view-only included, replace every order filed there.
    for (const level of ['level1', 'level3', 'admin']) {
      const calls = [];
      const sqlCalls = [];
      const handler = loadEndpoint({ roles: { quarry: level }, calls,
        sqlStub: async (...a) => { sqlCalls.push(a); return []; } });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'quarry', force: '1' }, headers: AUTHED,
                      body: { purchaseOrders: [] } }, res);
      check(`a quarry ${level} cannot replace quarry's whole list`, res.statusCode === 400,
        res.statusCode + ' ' + JSON.stringify(res.body));
      check(`  and nothing is written for the ${level}`, sqlCalls.length === 0 && calls.length === 0,
        sqlCalls.length + ' sql call(s)');
    }
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'PUT', query: { division: 'quarry' }, headers: AUTHED,
                    body: { purchaseOrders: [] } }, res);
    check('nor can central purchasing', res.statusCode === 400 || res.statusCode === 403,
      res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'quarry' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('purchasing may raise an order in quarry', res.statusCode === 200, JSON.stringify(res.body));
    check('  and it is filed under quarry', calls[0] && calls[0].args.division === 'quarry',
      JSON.stringify(calls[0] && calls[0].args.division));
  }
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'paving', from: 'quarry' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('an order can move out of quarry onto a job division', res.statusCode === 200, JSON.stringify(res.body));
    check('  naming quarry as where it came from', calls[0] && calls[0].args.from === 'quarry'
      && calls[0].args.division === 'paving', JSON.stringify(calls[0] && calls[0].args));
  }
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'quarry', from: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('and into quarry from one', res.statusCode === 200 && calls[0] && calls[0].args.from === 'paving',
      JSON.stringify(res.body));
  }
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'DELETE', query: { division: 'quarry', id: 'po1' }, headers: AUTHED }, res);
    check('purchasing may delete a quarry order', res.statusCode === 200, JSON.stringify(res.body));
    check('  from quarry\'s own list', calls[0] && calls[0].fn === 'removePO' && calls[0].args.division === 'quarry');
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level1' } });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'quarry' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('a view-only purchasing user cannot raise one there', res.statusCode === 403, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' } });
    const res = makeRes();
    await handler({ method: 'GET', query: { division: 'quarry' }, headers: AUTHED }, res);
    check('purchasing may read quarry\'s orders', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    const handler = loadEndpoint({ roles: { quarry_sales: 'level3' } });
    const res = makeRes();
    await handler({ method: 'GET', query: { division: 'quarry' }, headers: AUTHED }, res);
    check('but the scale house cannot', res.statusCode === 403, JSON.stringify(res.body));
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
      // Daily Tracking lines are re-derived from the job rows on every save,
      // whatever the tab's copy said. Four rows on job1:
      //   rowX  names PO-0001, but a line raised on the order owns it
      //   rowY  names PO-0001                → stays, figures from the row
      //   rowZ  names PO-0001, on no line   → recorded
      //   rowM  moved to PO-0002            → off PO-0001, onto PO-0002
      // and the tab's copy still carries dr-gone, whose row was deleted.
      const LINK_ROWS = [
        { row_id: 'rowX', project_id: 'job1', po_num: 'PO-0001', units_purchased: 5, unit_cost: 10, material_cost: 50, date: '2026-11-01', employee: 'Sam' },
        { row_id: 'rowY', project_id: 'job1', po_num: 'PO-0001', units_purchased: 3, unit_cost: 4,  material_cost: 12, date: '2026-11-02', employee: 'Lee', cost_code: '02-100', sub_code: '0420' },
        { row_id: 'rowZ', project_id: 'job1', po_num: 'po-0001 ', units_purchased: 7, unit_cost: 2, material_cost: 14, date: '2026-11-03', employee: '' },
        { row_id: 'rowM', project_id: 'job1', po_num: 'PO-0002', units_purchased: 1, unit_cost: 9,  material_cost: 9,  date: '2026-11-04', employee: '' },
      ];
      const seen = [];
      const sqlStub = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += '$' + (i + 1); });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT row_id, project_id, date, employee, cost_code, sub_code, po_num/.test(q)) {
          const ids = vals[2], projects = vals[3];
          return Promise.resolve(LINK_ROWS.filter(r => ids.includes(r.row_id)
            || (projects.includes(r.project_id) && String(r.po_num || '').trim())));
        }
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      const sent = [
        { id: 'a', po_number: 'PO-0001', project_id: 'job1', lines: [
          { id: 'L1', qty: '5', unit_cost: '10', po_row_id: 'rowX' },
          { id: 'dr-rowX', source: 'daily', qty: '5', unit_cost: '10', po_row_id: 'rowX' },
          { id: 'dr-rowY', source: 'daily', invoice_num: 'T-1', qty: '99', unit_cost: '1', po_row_id: 'rowY' },
          { id: 'dr-rowM', source: 'daily', qty: '1', unit_cost: '9', po_row_id: 'rowM' },
          { id: 'dr-gone', source: 'daily', qty: '2', unit_cost: '2', po_row_id: 'gone' },
        ] },
        { id: 'b', po_number: 'PO-0002', project_id: 'job1', lines: [] },
      ];
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: sent } }, res);
      const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
      const written = hit ? JSON.parse(hit.vals[1]) : [];
      const A = written.find(o => o.id === 'a') || { lines: [] };
      const B = written.find(o => o.id === 'b') || { lines: [] };
      const ids = o => o.lines.map(l => l.id).join();
      check('a Daily Tracking copy of a raised line is not stored', !A.lines.some(l => l.id === 'dr-rowX'), ids(A));
      check('  the raised line itself is', A.lines.some(l => l.id === 'L1' && l.po_row_id === 'rowX'), ids(A));
      check('a line whose row was deleted is not put back', !A.lines.some(l => l.id === 'dr-gone'), ids(A));
      check('a line whose row moved to another order leaves this one', !A.lines.some(l => l.id === 'dr-rowM'), ids(A));
      check('  and lands on the order its row names, once',
        B.lines.filter(l => l.id === 'dr-rowM').length === 1, ids(B));
      const y = A.lines.find(l => l.id === 'dr-rowY') || {};
      check('a stale copy\'s figures give way to the row\'s', y.qty === '3' && y.unit_cost === '4', JSON.stringify(y));
      check('  keeping what only the line holds', y.invoice_num === 'T-1');
      check('  and carrying the row\'s own codes', y.cost_code === '02-100' && y.sub_code === '0420');
      check('a row naming the order that no line had is recorded',
        A.lines.some(l => l.id === 'dr-rowZ' && l.source === 'daily' && l.po_row_id === 'rowZ' && l.qty === '7'), ids(A));
      check('the save reports that the rows changed what it sent', res.body && res.body.derived === 2, JSON.stringify(res.body));
      check('and still succeeds', res.body && res.body.ok === true);
      const sweep = seen.find(c => /^SELECT d\.po_row_id FROM po_deliveries d/.test(c.q));
      check('the sweep of a dropped order never takes a Daily Tracking row',
        Boolean(sweep) && sweep.q.includes("COALESCE(d.line_id, '') NOT LIKE 'dr-%'"), sweep && sweep.q);
    }
    {
      // A failed read of the rows: the save still lands, lines as sent, less a
      // copy of a raised line's row.
      let body = null;
      const sqlStub = (strings, ...vals) => {
        const q = strings.join('?').replace(/\s+/g, ' ').trim();
        if (/^SELECT row_id, project_id, date/.test(q)) return Promise.reject(new Error('connection dropped'));
        if (/^INSERT INTO app_data/.test(q)) { body = JSON.parse(vals[1]); return Promise.resolve([{ updated_at: new Date(T_NEW) }]); }
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED, body: { purchaseOrders: [
        { id: 'a', po_number: 'PO-0001', project_id: 'job1', lines: [
          { id: 'L1', po_row_id: 'rowX', qty: '1', unit_cost: '1' },
          { id: 'dr-rowX', source: 'daily', po_row_id: 'rowX' },
          { id: 'dr-rowY', source: 'daily', po_row_id: 'rowY' } ] },
      ] } }, res);
      console.error = orig;
      check('a failed read of the job rows does not fail the save', res.body && res.body.ok === true, JSON.stringify(res.body));
      check('  the copy of a raised line still goes',
        body && body[0].lines.map(l => l.id).join() === 'L1,dr-rowY', JSON.stringify(body));
      check('  and the failure is logged', errs.some(e => /Daily Tracking/.test(e)));
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
      // The client withholds the new version whenever `merged` is non-zero. A
      // delivery merged back that reported 0 let the tab adopt the post-merge
      // version: its next save then matched the compare-and-set, the merge did
      // not fire, and the delivery was written straight back out — along with
      // the job cost row behind it.
      check('and the merge is reported, so the client does not adopt the version',
        res.body && res.body.merged > 0 && res.body.mergedLines === 1,
        JSON.stringify(res.body));
    }
    {
      // The same again for a cost-row link. A tab that loaded the order before
      // purchasing minted the row sends the line with no po_row_id; the server
      // restores it. Reporting 0 for that let the next save write the null back
      // and _ensurePOLineRow mint a SECOND row — the job charged twice.
      const WITH_LINK = [
        { id: 'a', po_number: 'PO-0001', lines: [{ id: 'L1', po_row_id: 'row-1' }] },
      ];
      const seen = [];
      const sqlStub = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: WITH_LINK, updated_at: new Date(T_MOVED) }]);
        }
        // The stored row is still there, so the client's null is a stale copy
        // rather than somebody having deleted the row on the job's daily tab.
        if (/^SELECT row_id FROM daily_tracking/.test(q)) {
          return Promise.resolve([{ row_id: 'row-1' }]);
        }
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [{ id: 'a', po_number: 'PO-0001', lines: [{ id: 'L1' }] }],
                              baseUpdatedAt: T_READ } }, res);
      const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
      const written = hit ? JSON.parse(hit.vals[1]) : [];
      const line = ((written[0] || {}).lines || [])[0] || {};
      check('a dropped cost-row link is restored', line.po_row_id === 'row-1', JSON.stringify(line));
      check('and that restoration is reported too',
        res.body && res.body.merged > 0 && res.body.mergedLinks === 1,
        JSON.stringify(res.body));
    }
    {
      // The case that actually happens. _ensurePOLineRow mints a row id and
      // POSTs it to /api/daily-rows BEFORE savePurchaseOrders runs, so a stale
      // tab's line arrives carrying a link — just not the stored one. Judging
      // only the linkless case let that through: the job was charged twice and
      // the server's original row orphaned.
      const STORED = [
        { id: 'a', po_number: 'PO-0001', project_id: 'job1',
          lines: [{ id: 'L1', po_row_id: 'row-server' }] },
      ];
      const seen = [];
      const sqlStub = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: STORED, updated_at: new Date(T_MOVED) }]);
        }
        if (/^SELECT row_id FROM daily_tracking/.test(q)) {
          return Promise.resolve([{ row_id: 'row-server' }]);
        }
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [{ id: 'a', po_number: 'PO-0001', project_id: 'job1',
                                                 lines: [{ id: 'L1', po_row_id: 'row-tab-minted' }] }],
                              baseUpdatedAt: T_READ } }, res);
      const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
      const line = ((JSON.parse(hit.vals[1])[0] || {}).lines || [])[0] || {};
      check('the stored link wins over one a stale copy minted',
        line.po_row_id === 'row-server', JSON.stringify(line));
      check('and that counts as a merge', res.body && res.body.mergedLinks === 1,
        JSON.stringify(res.body));
      // The tab already POSTed its row to /api/daily-rows. Nothing references it
      // now, and on its own it charges the job a second time.
      const del = seen.find(c => /^DELETE FROM daily_tracking/.test(c.q));
      check('and the duplicate row the tab minted is removed',
        Boolean(del) && JSON.stringify(del.vals).includes('row-tab-minted'),
        del ? JSON.stringify(del.vals) : 'no DELETE issued');
      check('and only after the blob write has landed',
        seen.findIndex(c => /^INSERT INTO app_data/.test(c.q)) <
        seen.findIndex(c => /^DELETE FROM daily_tracking/.test(c.q)));
      // The id comes from the REQUEST BODY and daily_tracking.row_id is unique
      // across the whole company, so the id alone can never be what authorises
      // the delete. Every other column has to agree as well.
      check('and the delete is scoped past the row id alone',
        Boolean(del) &&
        /d\.division\s*=/.test(del.q) && /d\.project_id\s*=\s*t\.project_id/.test(del.q) &&
        /COALESCE\(d\.po_num, ''\) = t\.po_num/.test(del.q) &&
        /d\.field_type\s*=\s*'Material'/.test(del.q) &&
        /d\.timesheet_entry_id IS NULL/.test(del.q), del ? del.q : 'no DELETE issued');
      check('and carries the order\'s own project and number to check against',
        Boolean(del) && JSON.stringify(del.vals).includes('job1') &&
        JSON.stringify(del.vals).includes('PO-0001'), del ? JSON.stringify(del.vals) : '');
    }
    {
      // The attack the scoping exists for. A caller with a role in ONE division
      // names another division's cost row as their line's link. Before the
      // scoping, the id went straight into a DELETE guarded only by
      // company_code, and the request answered 200.
      const STORED = [
        { id: 'a', po_number: 'PO-0001', project_id: 'job1',
          lines: [{ id: 'L1', po_row_id: 'row-server' }] },
      ];
      const seen = [];
      const sqlStub = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: STORED, updated_at: new Date(T_MOVED) }]);
        }
        if (/^SELECT row_id FROM daily_tracking/.test(q)) return Promise.resolve([{ row_id: 'row-server' }]);
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [{ id: 'a', po_number: 'PO-0001', project_id: 'job1',
                                                 lines: [{ id: 'L1', po_row_id: 'paving-labour-row-42' }] }],
                              baseUpdatedAt: T_READ } }, res);
      const del = seen.find(c => /^DELETE FROM daily_tracking/.test(c.q));
      // The id is still named — it has to be, it is what the client sent — but
      // the statement can only match a row that is in THIS division, on THIS
      // order's job, under THIS order's number, and is a material row with no
      // timesheet behind it. A foreign row satisfies none of that.
      check('a foreign row id cannot be deleted on the strength of the id alone',
        !del || (/d\.division\s*=/.test(del.q) && /d\.project_id\s*=\s*t\.project_id/.test(del.q) &&
                 /d\.timesheet_entry_id IS NULL/.test(del.q)),
        del ? del.q : 'no DELETE issued');
      check('and it is checked against this order, not the one the body claims',
        !del || (JSON.stringify(del.vals).includes('turf') &&
                 JSON.stringify(del.vals).includes('job1')),
        del ? JSON.stringify(del.vals) : '');
    }
    {
      // The opposite reading of the same null. When somebody deletes a
      // PO-generated cost row on the job's own daily tab, _detachLinkedRows
      // clears the line's link and saves. Restoring it would point the line at
      // a row that no longer exists — and _ensurePOLineRow would then never
      // mint a replacement, because the link reads as present, so the job would
      // be silently UNDER-charged. The row being gone is what says which null
      // this is.
      const STORED = [
        { id: 'a', po_number: 'PO-0001', project_id: 'job1',
          lines: [{ id: 'L1', po_row_id: 'row-deleted' }] },
      ];
      const seen = [];
      const sqlStub = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: STORED, updated_at: new Date(T_MOVED) }]);
        }
        // row-deleted is not in daily_tracking any more.
        if (/^SELECT row_id FROM daily_tracking/.test(q)) return Promise.resolve([]);
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [{ id: 'a', po_number: 'PO-0001', project_id: 'job1',
                                                 lines: [{ id: 'L1', po_row_id: null }] }],
                              baseUpdatedAt: T_READ } }, res);
      const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
      const line = ((JSON.parse(hit.vals[1])[0] || {}).lines || [])[0] || {};
      check('a link cleared because the row was deleted stays cleared',
        !line.po_row_id, JSON.stringify(line));
      check('and nothing is reported as relinked for it',
        res.body && res.body.mergedLinks === 0, JSON.stringify(res.body));
    }
    {
      // ...but not when the JOB moved. The tab deletes every row and nulls
      // every link on purpose then, and restoring one points the line at a row
      // that no longer exists — after which nothing ever mints a replacement,
      // because the link reads as present, and the job is UNDER-charged.
      const STORED = [
        { id: 'a', po_number: 'PO-0001', project_id: 'job1',
          lines: [{ id: 'L1', po_row_id: 'row-old-job' }] },
      ];
      const seen = [];
      const sqlStub = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: STORED, updated_at: new Date(T_MOVED) }]);
        }
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [{ id: 'a', po_number: 'PO-0001', project_id: 'job2',
                                                 lines: [{ id: 'L1', po_row_id: null }] }],
                              baseUpdatedAt: T_READ } }, res);
      const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
      const line = ((JSON.parse(hit.vals[1])[0] || {}).lines || [])[0] || {};
      check('a job that moved keeps the client\'s cleared link',
        !line.po_row_id, JSON.stringify(line));
      check('and nothing is reported as relinked', res.body && res.body.mergedLinks === 0,
        JSON.stringify(res.body));
    }
    {
      // A merged-back delivery cannot keep its link either when the job moved.
      // The guard covered the relinked lines and this arm of the same block was
      // left out: the line kept a link to a row on the OLD job, and because the
      // link reads as present nothing ever minted a replacement — the new job
      // was never charged while the old one still was.
      const STORED = [
        { id: 'a', po_number: 'PO-0001', project_id: 'job1',
          lines: [{ id: 'L1', po_row_id: 'row-old-1' }, { id: 'L2', po_row_id: 'row-old-2' }] },
      ];
      const seen = [];
      const sqlStub = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: STORED, updated_at: new Date(T_MOVED) }]);
        }
        if (/^SELECT row_id FROM daily_tracking/.test(q)) return Promise.resolve([]);
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      // The tab re-tied the order to job2, clearing the links on the line it
      // held. L2 it never saw at all.
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [{ id: 'a', po_number: 'PO-0001', project_id: 'job2',
                                                 lines: [{ id: 'L1', po_row_id: null }] }],
                              baseUpdatedAt: T_READ } }, res);
      const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
      const lines = (JSON.parse(hit.vals[1])[0] || {}).lines || [];
      const l2 = lines.find(l => l.id === 'L2');
      check('the unseen delivery still survives the move', Boolean(l2), JSON.stringify(lines));
      check('but not with its link to the old job',
        Boolean(l2) && !l2.po_row_id, JSON.stringify(l2));
      const del = seen.find(c => /^DELETE FROM daily_tracking/.test(c.q));
      check('and the old job\'s row is taken out with the move',
        Boolean(del) && JSON.stringify(del.vals).includes('row-old-2') &&
        JSON.stringify(del.vals).includes('job1'),
        del ? JSON.stringify(del.vals) : 'no DELETE issued');
    }
    {
      // The existence lookup is advisory — it only decides whether a link is
      // worth restoring. A dropped connection on it must not discard the whole
      // save: the division tabs do not retry a non-409, so the user's edits
      // would only reach the server if they happened to type again.
      const STORED = [
        { id: 'a', po_number: 'PO-0001', project_id: 'job1',
          lines: [{ id: 'L1', po_row_id: 'row-server' }] },
      ];
      const seen = [];
      const sqlStub = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT row_id FROM daily_tracking/.test(q)) {
          return Promise.reject(new Error('connection terminated'));
        }
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: STORED, updated_at: new Date(T_MOVED) }]);
        }
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        return Promise.resolve([]);
      };
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [{ id: 'a', po_number: 'PO-0001', project_id: 'job1',
                                                 lines: [{ id: 'L1', po_row_id: 'row-tab' }] }],
                              baseUpdatedAt: T_READ } }, res);
      check('a failed existence check does not fail the save', res.statusCode === 200,
        res.statusCode + ' ' + JSON.stringify(res.body));
      check('and the blob is still written',
        seen.some(c => /^INSERT INTO app_data/.test(c.q)));
      // Nothing is restored and nothing destroyed on a state nobody could read.
      check('but nothing is relinked on unverified state',
        res.body && res.body.mergedLinks === 0, JSON.stringify(res.body));
      check('and no row is deleted on it either',
        !seen.some(c => /^DELETE FROM daily_tracking/.test(c.q)));
    }
    {
      // An up-to-date client that merged nothing must still get its version, or
      // every save would re-enter the merge arm forever.
      const sqlStub = appDataStub({ storedUpdatedAt: new Date(T_READ) });
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED,
                      body: { purchaseOrders: [{ id: 'a', po_number: 'PO-0001', lines: [] }],
                              baseUpdatedAt: T_READ } }, res);
      check('a save that merged nothing reports nothing',
        res.body && res.body.merged === 0, JSON.stringify(res.body));
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

  console.log('\n[a division tab\'s save takes only the fields it changed]');
  {
    // The Turf tab loaded its list at 14:40, when PO-0365 was blank. Purchasing
    // filled it in and approved it at 14:46. At 14:47 the foreman approved a
    // DIFFERENT order — and the tab's whole list went up, its blank PO-0365
    // with it, and was stored over purchasing's.
    const T_READ  = '2026-11-16T14:40:00.000Z';
    const T_MOVED = '2026-11-16T14:46:00.000Z';
    const T_NEW   = '2026-11-16T14:47:00.000Z';
    const STORED = () => [
      { id: 'po365', po_number: 'PO-0365', title: 'Drain Fabric', supplier: 'Hanes Geo Components',
        project_id: 'job2', cost_code: '300', sub_code: 'C', status: 'approved',
        status_changed_at: '2026-11-16T14:46:30.000Z', status_changed_by: 'hudockben',
        // A delivery purchasing recorded after the tab loaded, charged to job2.
        lines: [{ id: 'L1', qty: '10', unit_cost: '4', po_row_id: 'row-on-job2' }] },
      { id: 'po364', po_number: 'PO-0364', title: 'Fabric', status: 'pending', project_id: 'job1', lines: [] },
    ];
    const TAB = () => [
      { id: 'po365', po_number: 'PO-0365', title: '', supplier: '', project_id: 'job1',
        cost_code: '', sub_code: '', status: 'pending', lines: [] },
      { id: 'po364', po_number: 'PO-0364', title: 'Fabric', status: 'approved', project_id: 'job1',
        status_changed_at: '2026-11-16T14:47:00.000Z', status_changed_by: 'foreman', lines: [] },
    ];
    function stub(storedUpdatedAt) {
      const seen = [];
      const sql = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: STORED(), updated_at: new Date(storedUpdatedAt) }]);
        }
        if (/^SELECT value FROM app_data/.test(q)) return Promise.resolve([{ value: STORED() }]);
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        if (/^SELECT COUNT\(\*\)::int AS count FROM po_deliveries/.test(q)) return Promise.resolve([{ count: 0 }]);
        return Promise.resolve([]);
      };
      sql.written = () => {
        const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
        return Object.fromEntries((hit ? JSON.parse(hit.vals[1]) : []).map(p => [p.id, p]));
      };
      sql.rowDeletes = () => seen.filter(c => /^DELETE FROM daily_tracking/.test(c.q));
      return sql;
    }
    const put = async (sqlStub, body) => {
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: { division: 'turf' }, headers: AUTHED, body }, res);
      return res;
    };

    {
      const sqlStub = stub(T_MOVED);
      const res = await put(sqlStub, { purchaseOrders: TAB(), baseUpdatedAt: T_READ,
                                       editedFields: { po364: ['status'] } });
      const w = sqlStub.written();
      check('an order the tab did not touch keeps what purchasing filled in',
        w.po365 && w.po365.title === 'Drain Fabric' && w.po365.supplier === 'Hanes Geo Components'
        && w.po365.cost_code === '300' && w.po365.sub_code === 'C', JSON.stringify(w.po365));
      check('  stays approved, with purchasing\'s byline',
        w.po365.status === 'approved' && w.po365.status_changed_by === 'hudockben', JSON.stringify(w.po365));
      // The link checks read the job: a stale copy's old one looked like the
      // tab MOVING the order, and swept the cost rows purchasing had put on
      // the new job.
      check('  and stays on the job purchasing put it on', w.po365.project_id === 'job2', JSON.stringify(w.po365));
      check('the order the tab DID change takes its change',
        w.po364 && w.po364.status === 'approved' && w.po364.status_changed_by === 'foreman', JSON.stringify(w.po364));
      // Reported, or the tab adopts this version, its next save skips the
      // merge, and the blank copy goes straight back out.
      check('the kept fields are reported as merged, so the tab keeps its old version',
        res.body && res.body.merged > 0 && res.body.mergedFields === 8, JSON.stringify(res.body));
      // Read as a move, the delivery the tab never saw lost its link and its
      // cost row on job2 was deleted — the job silently lost the charge.
      check('  the delivery the tab never saw keeps its cost row link',
        (w.po365.lines || []).some(l => l.id === 'L1' && l.po_row_id === 'row-on-job2'), JSON.stringify(w.po365.lines));
      check('  and no cost row is deleted on the stale job\'s account',
        sqlStub.rowDeletes().length === 0, JSON.stringify(sqlStub.rowDeletes()));
    }
    {
      // A tab running the code from before this says nothing, and is stored
      // whole as before — the fix arrives when it reloads, and breaks nothing
      // until then.
      const sqlStub = stub(T_MOVED);
      const res = await put(sqlStub, { purchaseOrders: TAB(), baseUpdatedAt: T_READ });
      const w = sqlStub.written();
      check('a tab that sends no edited fields is stored whole, as before',
        w.po365.title === '' && w.po365.status === 'pending' && res.body.mergedFields === 0, JSON.stringify(w.po365));
    }
    {
      // Up to date: nothing was written since the tab read, so its copy IS the
      // stored one plus its own edits, and it is taken as sent.
      const sqlStub = stub(T_READ);
      const res = await put(sqlStub, { purchaseOrders: TAB(), baseUpdatedAt: T_READ, editedFields: {} });
      const w = sqlStub.written();
      check('an up-to-date tab is stored as sent', w.po365.title === '' && res.body.merged === 0,
        JSON.stringify(res.body));
    }
    {
      // An order the stored list does not have yet — raised on the tab — has
      // nothing to keep.
      const sqlStub = stub(T_MOVED);
      await put(sqlStub, { purchaseOrders: TAB().concat([{ id: 'new', po_number: 'PO-0366', title: 'Geogrid', lines: [] }]),
                           baseUpdatedAt: T_READ, editedFields: {} });
      check('an order raised on the tab is stored as raised', sqlStub.written().new.title === 'Geogrid');
    }
  }
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO, editedFields: ['status', 7] } }, res);
    check('a single-order save passes on the fields it changed',
      calls[0] && JSON.stringify(calls[0].args.editedFields) === '["status","7"]',
      calls[0] && JSON.stringify(calls[0].args.editedFields));
    const res2 = makeRes();
    await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res2);
    check('  and one that names none passes on "did not say" — stored whole',
      calls[1] && calls[1].args.editedFields === null, calls[1] && JSON.stringify(calls[1].args.editedFields));
  }

  console.log('\n[a division tab\'s save: delivery figures per key, its cost rows written here]');
  {
    // The Turf tab loaded its list at 09:00. Since then purchasing corrected
    // PO-0100's first delivery from 8 t at $4.00 to 10 t at $5.00, typed its
    // invoice #, and filled in the supplier. The tab's copy has none of that,
    // and every save sends the whole list as the tab holds it. Before this,
    // approving the order there stored the 8 t at $4.00 again — and the tab
    // then PUT that onto the job's cost row itself.
    const T_READ  = '2026-11-16T09:00:00.000Z';   // when the tab read the list
    const T_MOVED = '2026-11-16T09:04:00.000Z';   // purchasing's save since
    const T_LATER = '2026-11-16T09:05:00.000Z';   // a write that lands mid-save
    const T_NEW   = '2026-11-16T09:06:00.000Z';   // what this save produces
    const STAMP = { created_at: '2026-11-01T12:00:00.000Z', created_by: 'purchasing' };
    // What Postgres hands back for updated_at::text — not the ISO form the tab
    // sends, which is why the compare-and-set carries the text it read.
    const pgText = iso => iso.replace('T', ' ').replace('Z', '+00');
    const clone = v => JSON.parse(JSON.stringify(v));

    const storedA = (over = {}) => Object.assign({
      id: 'A', po_number: 'PO-0100', project_id: 'job1', title: 'Stone', supplier: 'Hanes Aggregates',
      cost_code: '02-100', sub_code: '0420', status: 'pending', notes: '',
      lines: [
        { id: 'L1', invoice_num: 'INV-77', date: '2026-11-10', qty: '10', unit_cost: '5', tax_pct: '6', tax: '3',
          employee: 'Sam', po_row_id: 'row-L1' },
        // Saved before tax was a percentage: a flat dollar figure, no tax_pct.
        { id: 'L2', invoice_num: '', date: '2026-11-11', qty: '4', unit_cost: '20', tax: '1.5',
          employee: 'Lee', po_row_id: 'row-L2' },
      ],
    }, STAMP, over);
    // The same order as the tab loaded it, before purchasing's changes.
    const tabA = (over = {}) => {
      const a = storedA(Object.assign({ supplier: '' }, over));
      if (!over.lines) Object.assign(a.lines[0], { invoice_num: '', qty: '8', unit_cost: '4', tax: '1.92' });
      return a;
    };
    const orderB = () => Object.assign({ id: 'B', po_number: 'PO-0101', project_id: 'job1', title: 'Sand',
      supplier: 'Hanes Aggregates', cost_code: '02-100', sub_code: '0420', status: 'pending', notes: '', lines: [] }, STAMP);
    // The rows A's deliveries raised. They carry its number, so the read
    // behind the Daily Tracking derivation finds them — and must pass them by.
    const RAISED_ROWS = [
      { row_id: 'row-L1', project_id: 'job1', po_num: 'PO-0100', units_purchased: 10, unit_cost: 5.3,
        material_cost: 53, date: '2026-11-10', employee: 'Sam', cost_code: '02-100', sub_code: '0420' },
      { row_id: 'row-L2', project_id: 'job1', po_num: 'PO-0100', units_purchased: 4, unit_cost: 20.375,
        material_cost: 81.5, date: '2026-11-11', employee: 'Lee', cost_code: '02-100', sub_code: '0420' },
    ];

    // A daily_tracking INSERT as { column: bound value }, read off its own
    // column and VALUES lists — so a check names the column it means.
    function insertedRow(call) {
      const m = /^INSERT INTO daily_tracking \(([^)]*)\) VALUES \(([^)]*)\)/.exec(call.q);
      if (!m) return {};
      const cols = m[1].split(',').map(s => s.trim());
      const vals = m[2].split(',').map(s => s.trim());
      const out = {};
      cols.forEach((c, i) => {
        const p = /^\$(\d+)$/.exec(vals[i] || '');
        out[c] = p ? call.vals[Number(p[1]) - 1] : String(vals[i]).replace(/^'|'$/g, '');
      });
      return out;
    }
    // A daily_tracking UPDATE's plain `col = $n` / `col = 0` assignments, SET
    // and WHERE apart.
    function updatedRow(call) {
      const m = /^UPDATE daily_tracking SET (.*?) WHERE (.*)$/.exec(call.q);
      const pick = s => {
        const out = {};
        for (const [, c, v] of String(s || '').matchAll(/(\w+) = (\$\d+|\d+(?:\.\d+)?)(?=,| |$)/g)) {
          out[c] = v[0] === '$' ? call.vals[Number(v.slice(1)) - 1] : Number(v);
        }
        return out;
      };
      return { set: pick(m && m[1]), where: pick(m && m[2]), q: call.q, vals: call.vals };
    }
    // The value a `col = CASE WHEN $n ...` column is written under: whether
    // the save re-codes the row.
    function caseFlag(call, col) {
      const m = new RegExp(col + ' = CASE WHEN \\$(\\d+)').exec(call.q);
      return m ? call.vals[Number(m[1]) - 1] : undefined;
    }

    /**
     * The database as the new-protocol PUT sees it.
     *
     *  versions       what the blob holds on each successive read; null is no
     *                 row. A compare-and-set that loses moves the blob on to
     *                 the next one — somebody else's write landed in between.
     *  loseCas        how many writes lose before one may land (Infinity: all)
     *  linkRows       the job rows fetchLinkRows finds, filtered as its WHERE would
     *  liveRows       the row ids the cost-row existence check finds
     *  failRowWrites  every daily_tracking INSERT / UPDATE rejects
     *
     * The UPDATE lands only when the text it carries is the version's own:
     * it is a real compare-and-set, not a counter.
     */
    function tabStub({ versions, loseCas = 0, linkRows = [], liveRows = [], failRowWrites = false }) {
      const seen = [];
      let at = 0, lost = 0;
      const cur = () => versions[Math.min(at, versions.length - 1)];
      const sql = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        const v = cur();
        const land = json => { sql.landed = JSON.parse(json); return [{ updated_at: new Date(T_NEW) }]; };
        if (/^SELECT value, updated_at, updated_at::text AS updated_at_text FROM app_data/.test(q)) {
          return Promise.resolve(v ? [{ value: clone(v.list), updated_at: new Date(v.at), updated_at_text: pgText(v.at) }] : []);
        }
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve(v ? [{ value: clone(v.list), updated_at: new Date(v.at) }] : []);
        }
        if (/^SELECT value FROM app_data/.test(q)) return Promise.resolve(v ? [{ value: clone(v.list) }] : []);
        if (/^UPDATE app_data SET value = \$1::jsonb, updated_at = clock_timestamp\(\) WHERE key = \$2 AND updated_at = \$3::timestamptz RETURNING updated_at$/.test(q)) {
          if (lost < loseCas) { lost++; at++; return Promise.resolve([]); }
          return Promise.resolve(v && vals[2] === pgText(v.at) ? land(vals[0]) : []);
        }
        if (/^INSERT INTO app_data .* ON CONFLICT \(key\) DO NOTHING RETURNING updated_at$/.test(q)) {
          if (!v && lost >= loseCas) return Promise.resolve(land(vals[1]));
          if (!v) { lost++; at++; }    // another first save created the row
          return Promise.resolve([]);
        }
        if (/^INSERT INTO app_data .* ON CONFLICT \(key\) DO UPDATE/.test(q)) return Promise.resolve(land(vals[1]));
        if (/^SELECT row_id FROM daily_tracking/.test(q)) {
          return Promise.resolve((vals[1] || []).filter(id => liveRows.includes(id)).map(row_id => ({ row_id })));
        }
        if (/^SELECT row_id, project_id, date, employee, cost_code, sub_code, po_num/.test(q)) {
          const ids = vals[2], projects = vals[3];
          return Promise.resolve(clone(linkRows.filter(r => ids.includes(r.row_id)
            || (projects.includes(r.project_id) && String(r.po_num || '').trim()))));
        }
        if (/^SELECT COUNT\(\*\)::int AS count FROM po_deliveries/.test(q)) return Promise.resolve([{ count: 0 }]);
        if (failRowWrites && /^(INSERT INTO|UPDATE) daily_tracking/.test(q)) {
          return Promise.reject(new Error('connection terminated'));
        }
        return Promise.resolve([]);
      };
      sql.landed = null;
      sql.calls = seen;
      sql.written = () => Object.fromEntries((sql.landed || []).map(p => [p.id, p]));
      sql.casReads = () => seen.filter(c => /updated_at::text AS updated_at_text/.test(c.q));
      sql.casWrites = () => seen.filter(c => /^UPDATE app_data/.test(c.q) || /DO NOTHING/.test(c.q));
      sql.plainWrites = () => seen.filter(c => /^INSERT INTO app_data .* DO UPDATE/.test(c.q));
      sql.rowWrites = () => seen.filter(c => /^(INSERT INTO|UPDATE|DELETE FROM) daily_tracking/.test(c.q));
      sql.upserts = () => seen.filter(c => /^INSERT INTO daily_tracking/.test(c.q));
      sql.updates = () => seen.filter(c => /^UPDATE daily_tracking/.test(c.q)).map(updatedRow);
      // Each superseded row as "row|project|po#", the way the DELETE pairs them.
      sql.dropped = () => seen.filter(c => /^DELETE FROM daily_tracking d USING unnest/.test(c.q))
        .flatMap(c => c.vals[0].map((id, i) => [id, c.vals[1][i], c.vals[2][i]].join('|')));
      sql.at = re => seen.findIndex(c => re.test(c.q));
      return sql;
    }
    const put = async (sqlStub, body, query = {}) => {
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      const logs = [];
      const { warn, error } = console;
      console.warn = (...a) => logs.push(a.join(' '));
      console.error = (...a) => logs.push(a.join(' '));
      try {
        await handler({ method: 'PUT', query: Object.assign({ division: 'turf' }, query), headers: AUTHED, body }, res);
      } finally { console.warn = warn; console.error = error; }
      res.logs = logs;
      return res;
    };
    // What a current tab sends: everything, even when it is empty.
    const tabBody = (purchaseOrders, extra = {}) => Object.assign({
      purchaseOrders, baseUpdatedAt: T_READ,
      editedFields: {}, editedLineFields: {}, deletedLineIds: {}, deletedOrderIds: [],
    }, extra);
    const lineOf = (po, id) => ((po && po.lines) || []).find(l => l && l.id === id) || {};
    const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
    const approvedA = () => tabA({ status: 'approved', status_changed_at: '2026-11-16T09:05:30.000Z',
                                   status_changed_by: 'foreman' });

    {
      // The report this came from: a foreman approving an order put back the
      // quantity and cost purchasing had corrected on it.
      const sqlStub = tabStub({ versions: [{ list: [storedA(), orderB()], at: T_MOVED }],
        linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      const res = await put(sqlStub, tabBody([approvedA(), orderB()], { editedFields: { A: ['status'] } }));
      const w = sqlStub.written();
      const l1 = lineOf(w.A, 'L1');
      check('a stale tab approving an order saves', res.statusCode === 200 && res.body.ok === true,
        res.statusCode + ' ' + JSON.stringify(res.body));
      check('  the approval is what it takes from the tab',
        w.A && w.A.status === 'approved' && w.A.status_changed_by === 'foreman', JSON.stringify(w.A));
      check('  the delivery keeps purchasing\'s corrected figures, not the copy the tab loaded',
        l1.qty === '10' && l1.unit_cost === '5' && l1.tax === '3', JSON.stringify(l1));
      check('  and the invoice # purchasing typed', l1.invoice_num === 'INV-77', JSON.stringify(l1));
      check('  a legacy flat-tax delivery the tab had right is left exactly as it was',
        JSON.stringify(lineOf(w.A, 'L2')) === JSON.stringify(storedA().lines[1]), JSON.stringify(lineOf(w.A, 'L2')));
      // Approving touches no figure, so no cost row is the tab's to write.
      check('an approval writes no cost-row figures at all',
        sqlStub.rowWrites().length === 0, JSON.stringify(sqlStub.rowWrites().map(c => c.q.slice(0, 70))));
      check('the kept figures are reported, and counted in `merged`',
        res.body.mergedLineFigures === 1 && res.body.merged >= res.body.mergedLineFigures + res.body.mergedFields,
        JSON.stringify(res.body));
      // The tab takes these on, after which it does hold the stored list —
      // without them its next save would carry the 8 t at $4.00 again.
      const backA = (res.body.orders || []).find(o => o.id === 'A');
      check('the order comes back as stored, so the tab shows purchasing\'s figures',
        backA && lineOf(backA, 'L1').qty === '10' && backA.supplier === 'Hanes Aggregates',
        JSON.stringify(res.body.orders));
      check('  and an order that came out exactly as sent does not',
        Array.isArray(res.body.orders) && !res.body.orders.some(o => o.id === 'B'), JSON.stringify(res.body.orders));
      const cas = sqlStub.casWrites();
      check('the save is a compare-and-set against the version it read',
        cas.length === 1 && /^UPDATE app_data/.test(cas[0].q) && cas[0].vals[2] === pgText(T_MOVED)
        && sqlStub.plainWrites().length === 0, JSON.stringify(cas.map(c => c.vals[2])));
      check('  and the version it produced comes back',
        new Date(res.body.updatedAt).getTime() === Date.parse(T_NEW), JSON.stringify(res.body.updatedAt));
    }
    {
      // Nobody wrote since the tab read — and its copy still differs from the
      // store: it took a row write's echo or a poll mid-save. Whatever it did
      // not mark is not its edit, so the settle runs on every save, not only
      // when the list moved.
      const sqlStub = tabStub({ versions: [{ list: [storedA(), orderB()], at: T_READ }],
        linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      const res = await put(sqlStub, tabBody([approvedA(), orderB()], { editedFields: { A: ['status'] } }));
      const w = sqlStub.written();
      check('an up-to-date tab still keeps the stored figures it did not change',
        lineOf(w.A, 'L1').qty === '10' && lineOf(w.A, 'L1').unit_cost === '5' && res.body.mergedLineFigures === 1,
        JSON.stringify(lineOf(w.A, 'L1')) + ' ' + JSON.stringify(res.body));
      check('  and the stored order fields', w.A && w.A.supplier === 'Hanes Aggregates' && w.A.status === 'approved',
        JSON.stringify(w.A));
      check('  still under the compare-and-set, against the version both agree on',
        sqlStub.casWrites().length === 1 && sqlStub.casWrites()[0].vals[2] === pgText(T_READ));
    }
    {
      // ...which an older tab, saying nothing about its lines, does not get:
      // up to date, it is stored as sent, exactly as before this change.
      const sqlStub = tabStub({ versions: [{ list: [storedA(), orderB()], at: T_READ }],
        linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      const res = await put(sqlStub, { purchaseOrders: [approvedA(), orderB()], baseUpdatedAt: T_READ,
                                       editedFields: { A: ['status'] } });
      const w = sqlStub.written();
      check('an older up-to-date tab is still stored exactly as sent',
        lineOf(w.A, 'L1').qty === '8' && w.A.supplier === '' && res.body.merged === 0,
        JSON.stringify(w.A) + ' ' + JSON.stringify(res.body));
    }
    {
      // Typing the invoice # on a stale line must not carry the line's old
      // quantity with it — and the invoice # is the order's alone: no job row
      // carries it, so there is nothing to write there.
      const a = tabA();
      a.lines[0].invoice_num = 'INV-80';
      const sqlStub = tabStub({ versions: [{ list: [storedA(), orderB()], at: T_MOVED }],
        linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      const res = await put(sqlStub, tabBody([a, orderB()], { editedLineFields: { A: { L1: ['invoice_num'] } } }));
      const l1 = lineOf(sqlStub.written().A, 'L1');
      check('an invoice # typed on a stale delivery is taken', l1.invoice_num === 'INV-80', JSON.stringify(l1));
      check('  without the stale quantity and cost beside it', l1.qty === '10' && l1.unit_cost === '5', JSON.stringify(l1));
      check('  and no cost row is written for it',
        res.statusCode === 200 && sqlStub.rowWrites().length === 0,
        res.statusCode + ' ' + JSON.stringify(sqlStub.rowWrites().map(c => c.q.slice(0, 70))));
    }
    {
      // The two sides of one delivery changed apart: the tab typed 12 t while
      // purchasing had re-priced it at $5.00. The tab's figure is the quantity
      // alone; the price is purchasing's, and the job row has to come to that
      // — not to 12 t at the $4.00 the tab still showed.
      const a = tabA();
      Object.assign(a.lines[0], { qty: '12', tax: '2.88' });   // the tab's own re-figuring on $4.00
      const sqlStub = tabStub({ versions: [{ list: [storedA(), orderB()], at: T_MOVED }],
        linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      const res = await put(sqlStub, tabBody([a, orderB()], { editedLineFields: { A: { L1: ['qty'] } } }));
      const l1 = lineOf(sqlStub.written().A, 'L1');
      check('a quantity typed on a stale delivery is taken, at the stored price',
        l1.qty === '12' && l1.unit_cost === '5' && l1.invoice_num === 'INV-77', JSON.stringify(l1));
      check('  its tax worked out again on the amount it now has (12 × $5.00 × 6%)',
        l1.tax_pct === '6' && l1.tax === '3.6', JSON.stringify(l1));
      const ups = sqlStub.upserts();
      const row = ups.length ? insertedRow(ups[0]) : {};
      check('the server writes that delivery\'s cost row — one row, the one the line names',
        ups.length === 1 && row.row_id === 'row-L1' && row.project_id === 'job1' && row.division === 'turf'
        && row.company_code === 'FCT', JSON.stringify(row));
      check('  carrying the tab\'s quantity', near(row.units_purchased, 12), JSON.stringify(row));
      check('  and the stored unit cost with its tax in it ($5.00 + $3.60 / 12), not the tab\'s $4.00',
        near(row.unit_cost, 5.3), JSON.stringify(row));
      check('  and a material cost that is the delivery\'s total', near(row.material_cost, 63.6), JSON.stringify(row));
      // The row is written from the order as stored, so the tab's blank copy of
      // the supplier does not blank the job's row.
      check('  with the order\'s stored header, not the tab\'s blank copy of it',
        row.material === 'Stone' && row.supplier === 'Hanes Aggregates' && row.po_num === 'PO-0100'
        && row.employee === 'Sam' && row.date === '2026-11-10' && row.field_type === 'Material', JSON.stringify(row));
      check('  leaving a supervisor\'s re-coding of the row alone: the codes were not edited',
        ups.length === 1 && caseFlag(ups[0], 'cost_code') === false && caseFlag(ups[0], 'sub_code') === false,
        ups.length ? ups[0].q : 'no upsert');
      // The id came in the request body; the update must still prove the row
      // is this order's job's, in this division, and not payroll's.
      check('  and an existing row is only updated when it is on this job, in this division, and not payroll\'s',
        ups.length === 1 && /WHERE daily_tracking\.company_code = \$\d+ AND daily_tracking\.division = \$\d+ AND daily_tracking\.project_id = \$\d+ AND daily_tracking\.timesheet_entry_id IS NULL$/.test(ups[0].q),
        ups.length ? ups[0].q.slice(-200) : '');
      check('no row is written for the delivery the tab did not touch',
        !sqlStub.rowWrites().some(c => JSON.stringify(c.vals).includes('row-L2')),
        JSON.stringify(sqlStub.rowWrites().map(c => c.vals[0])));
      check('the row is written only after the order it comes from has landed',
        sqlStub.at(/^UPDATE app_data/) >= 0 && sqlStub.at(/^UPDATE app_data/) < sqlStub.at(/^INSERT INTO daily_tracking/));
      check('and the save answers ok', res.statusCode === 200 && res.body.ok === true, JSON.stringify(res.body));
    }
    {
      // A delivery added on the tab: the tab mints its row id, and the row
      // itself is now the server's to create.
      const a = storedA();
      a.lines.push({ id: 'L5', invoice_num: '', date: '2026-11-13', qty: '2', unit_cost: '10', tax_pct: '', tax: '',
                     employee: 'Sam', po_row_id: 'row-tab-L5' });
      const sqlStub = tabStub({ versions: [{ list: [storedA(), orderB()], at: T_MOVED }],
        linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      await put(sqlStub, tabBody([a, orderB()], { editedLineFields: { A: { L5: ['qty', 'unit_cost'] } } }));
      const ups = sqlStub.upserts().map(insertedRow);
      check('a delivery added on the tab has its cost row created by the server',
        ups.length === 1 && ups[0].row_id === 'row-tab-L5' && near(ups[0].units_purchased, 2)
        && near(ups[0].unit_cost, 10) && near(ups[0].material_cost, 20), JSON.stringify(ups));
      check('  and the delivery is stored as the tab typed it',
        lineOf(sqlStub.written().A, 'L5').qty === '2', JSON.stringify(lineOf(sqlStub.written().A, 'L5')));
    }
    {
      // A retitle reaches every row the order raised — and only the columns
      // the order owns. A payroll row a line points at is never touched, and a
      // line with no row has none to write.
      const extra = [
        { id: 'L3', invoice_num: '', date: '2026-11-12', qty: '1', unit_cost: '9', tax: '', employee: '', po_row_id: 'ts12-abc' },
        { id: 'L4', invoice_num: '', date: '', qty: '', unit_cost: '', tax: '', employee: '', po_row_id: null },
      ];
      const stored = storedA({ lines: storedA().lines.concat(clone(extra)) });
      // Its lines as stored, so only the header is in question; its supplier
      // still the blank it loaded.
      const tab = tabA({ title: 'Crushed Stone', lines: storedA().lines.concat(clone(extra)) });
      const sqlStub = tabStub({ versions: [{ list: [stored, orderB()], at: T_MOVED }],
        linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      const res = await put(sqlStub, tabBody([tab, orderB()], { editedFields: { A: ['title'] } }));
      const ups = sqlStub.updates();
      const ids = ups.map(u => u.where.row_id).sort();
      check('a title edited on the tab is written to every row the order raised',
        res.statusCode === 200 && ids.join() === 'row-L1,row-L2', JSON.stringify(ids));
      check('  as the row\'s material, with the order\'s stored supplier and number',
        ups.length === 2 && ups.every(u => u.set.material === 'Crushed Stone' && u.set.supplier === 'Hanes Aggregates'
          && u.set.po_num === 'PO-0100'), JSON.stringify(ups.map(u => u.set)));
      check('  scoped to the order\'s job, this division and this company',
        ups.length === 2 && ups.every(u => u.where.project_id === 'job1' && u.where.division === 'turf'
          && u.where.company_code === 'FCT' && /timesheet_entry_id IS NULL/.test(u.q)), JSON.stringify(ups.map(u => u.where)));
      check('  without re-coding the rows, since the codes were not what changed',
        ups.length === 2 && ups.every(u => caseFlag(u, 'cost_code') === false && caseFlag(u, 'sub_code') === false),
        JSON.stringify(ups.map(u => u.q)));
      check('  and without touching any row\'s quantity or cost',
        sqlStub.upserts().length === 0 && ups.every(u => !('units_purchased' in u.set) && !('unit_cost' in u.set)),
        JSON.stringify(ups.map(u => u.set)));
      check('a payroll row a line points at is never written',
        !sqlStub.rowWrites().some(c => JSON.stringify(c.vals).includes('ts12-abc')));
    }
    {
      // The tab lost the compare-and-set: purchasing re-priced the delivery
      // again, renamed the supplier, raised D and deleted C between the tab's
      // read and its write. The second attempt merges against THAT list.
      const orderC = Object.assign({ id: 'C', po_number: 'PO-0102', project_id: 'job1', title: 'Gravel',
        status: 'pending', lines: [] }, STAMP);
      const orderD = Object.assign({ id: 'D', po_number: 'PO-0103', project_id: 'job1', title: 'Topsoil',
        status: 'pending', lines: [] }, STAMP);
      const a2 = storedA({ supplier: 'Hanes Aggregates Ltd' });
      Object.assign(a2.lines[0], { unit_cost: '5.5', tax: '3.3' });
      const sqlStub = tabStub({
        versions: [{ list: [storedA(), orderB(), orderC], at: T_MOVED },
                   { list: [a2, orderB(), orderD], at: T_LATER }],
        loseCas: 1, linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'],
      });
      const res = await put(sqlStub, tabBody([approvedA(), orderB()], { editedFields: { A: ['status'] } }));
      const w = sqlStub.written();
      const cas = sqlStub.casWrites();
      check('a save that loses the compare-and-set reads the list again and retries',
        res.statusCode === 200 && sqlStub.casReads().length === 2 && cas.length === 2,
        res.statusCode + ' reads=' + sqlStub.casReads().length + ' writes=' + cas.length);
      check('  each attempt against the version it had just read',
        cas.length === 2 && cas[0].vals[2] === pgText(T_MOVED) && cas[1].vals[2] === pgText(T_LATER),
        JSON.stringify(cas.map(c => c.vals[2])));
      check('  the newer list\'s changes survive the retry',
        w.A && w.A.supplier === 'Hanes Aggregates Ltd' && lineOf(w.A, 'L1').unit_cost === '5.5'
        && lineOf(w.A, 'L1').tax === '3.3', JSON.stringify(w.A));
      check('  alongside the tab\'s own', w.A && w.A.status === 'approved', JSON.stringify(w.A));
      check('  an order raised in between is kept', Boolean(w.D), Object.keys(w).join());
      // The first attempt merged C in. Its result must not leak into the
      // second, or an order purchasing deleted comes back.
      check('  and one deleted in between stays deleted — the first attempt\'s merge is not reused',
        !w.C, Object.keys(w).join());
      check('  the tab is sent the order as it finally landed',
        lineOf((res.body.orders || []).find(o => o.id === 'A'), 'L1').unit_cost === '5.5', JSON.stringify(res.body.orders));
    }
    {
      // Every attempt lost. Nothing landed, so nothing may be written to the
      // job's rows from it either — they would describe an order that is not
      // stored.
      const a = tabA();
      Object.assign(a.lines[0], { qty: '12' });
      const sqlStub = tabStub({ versions: [{ list: [storedA(), orderB()], at: T_MOVED }],
        loseCas: Infinity, linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      const res = await put(sqlStub, tabBody([a, orderB()], { editedLineFields: { A: { L1: ['qty'] } } }));
      check('a compare-and-set lost on every attempt is a 409',
        res.statusCode === 409 && /try again/i.test(JSON.stringify(res.body)), res.statusCode + ' ' + JSON.stringify(res.body));
      check('  after exactly the attempts it is allowed',
        sqlStub.casWrites().length === realPoSync.CAS_ATTEMPTS && sqlStub.casReads().length === realPoSync.CAS_ATTEMPTS,
        String(sqlStub.casWrites().length));
      check('  and nothing is written to the cost rows or the mirror for a save that did not land',
        sqlStub.landed === null && sqlStub.rowWrites().length === 0
        && !sqlStub.calls.some(c => /^INSERT INTO purchase_orders/.test(c.q)),
        JSON.stringify(sqlStub.rowWrites().map(c => c.q.slice(0, 50))));
    }
    {
      // No row at all (the blob was cleared) — and another first save creates
      // it at the same moment. An INSERT that overwrote would erase that one;
      // this one re-reads and merges instead.
      const sqlStub = tabStub({ versions: [null, { list: [orderB()], at: T_LATER }],
        loseCas: 1, linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      const res = await put(sqlStub, tabBody([storedA()]));
      const cas = sqlStub.casWrites();
      check('with no stored row the save inserts only if it is still the first',
        cas.length >= 1 && /ON CONFLICT \(key\) DO NOTHING/.test(cas[0].q), cas.length ? cas[0].q : 'no write');
      check('  and losing that to another first save re-reads and lands on top of it',
        res.statusCode === 200 && cas.length === 2 && /^UPDATE app_data/.test(cas[1].q)
        && cas[1].vals[2] === pgText(T_LATER), res.statusCode + ' ' + JSON.stringify(cas.map(c => c.q.slice(0, 40))));
      check('  keeping what that save stored', Boolean(sqlStub.written().B) && Boolean(sqlStub.written().A),
        Object.keys(sqlStub.written()).join());
    }
    {
      // A current tab says what it deleted. Without that, a list that moved on
      // made a deleted delivery read as one the tab never saw — and the merge
      // put it back, with its cost row already gone.
      //
      // deletePOLine removes the delivery's cost row as it removes the line,
      // so row-L2 is gone from the job by the time this save reads it. (Were
      // it still there, it would name PO-0100 with no line raising it, and the
      // derivation would — by its own rule — record it as a Daily Tracking
      // delivery until the row's delete synced.)
      const a = storedA();
      a.lines = a.lines.filter(l => l.id === 'L1');
      const versions = [{ list: [storedA(), orderB()], at: T_MOVED }];
      const ROWS_AFTER_DELETE = RAISED_ROWS.filter(r => r.row_id !== 'row-L2');
      const sqlStub = tabStub({ versions, linkRows: ROWS_AFTER_DELETE, liveRows: ['row-L1'] });
      const res = await put(sqlStub, tabBody([a], { deletedLineIds: { A: ['L2'] }, deletedOrderIds: ['B'] }));
      const w = sqlStub.written();
      check('a delivery the tab deleted stays deleted on a list that moved',
        w.A && w.A.lines.map(l => l.id).join() === 'L1', JSON.stringify(w.A && w.A.lines.map(l => l.id)));
      check('  and an order it deleted stays deleted', !w.B, Object.keys(w).join());
      check('  neither is reported as merged back', res.body.mergedLines === 0 && res.body.mergedOrders === 0,
        JSON.stringify(res.body));

      // The same save without the tab's word: both read as never seen.
      const again = tabStub({ versions, linkRows: ROWS_AFTER_DELETE, liveRows: ['row-L1'] });
      const res2 = await put(again, tabBody([a]));
      const w2 = again.written();
      check('without it, the missing delivery and order are put back as unseen — the safe direction',
        lineOf(w2.A, 'L2').id === 'L2' && Boolean(w2.B) && res2.body.mergedLines === 1 && res2.body.mergedOrders === 1,
        JSON.stringify(res2.body));

      // And a tab that does not speak the new protocol cannot use them.
      const old = tabStub({ versions, linkRows: ROWS_AFTER_DELETE, liveRows: ['row-L1'] });
      await put(old, { purchaseOrders: [a], baseUpdatedAt: T_READ, deletedLineIds: { A: ['L2'] }, deletedOrderIds: ['B'] });
      check('an older tab\'s save merges them back as it always did',
        lineOf(old.written().A, 'L2').id === 'L2' && Boolean(old.written().B), JSON.stringify(Object.keys(old.written())));
    }
    {
      // The tab moved the order to job2. It removed the rows its copy named
      // and minted new ones on job2 from its own figures, so the order must
      // keep those figures — and a row purchasing raised on job1 after the tab
      // loaded is one the tab never knew, left charging job1 for an order that
      // is now on job2.
      const stored = storedA({ lines: [
        { id: 'L1', invoice_num: '', date: '2026-11-10', qty: '10', unit_cost: '5', tax_pct: '', tax: '',
          employee: 'Sam', po_row_id: 'row-purch-L1' },
        { id: 'L2', invoice_num: '', date: '2026-11-11', qty: '4', unit_cost: '20', tax: '1.5',
          employee: 'Lee', po_row_id: 'row-L2' },
        { id: 'L3', invoice_num: '', date: '2026-11-12', qty: '1', unit_cost: '9', tax: '',
          employee: '', po_row_id: 'ts12-abc' },
      ] });
      const tab = storedA({ project_id: 'job2', lines: [
        { id: 'L1', invoice_num: '', date: '2026-11-10', qty: '7', unit_cost: '3', tax_pct: '', tax: '',
          employee: 'Sam', po_row_id: 'row-job2-L1' },
        { id: 'L2', invoice_num: '', date: '2026-11-11', qty: '4', unit_cost: '20', tax: '1.5',
          employee: 'Lee', po_row_id: 'row-job2-L2' },
        { id: 'L3', invoice_num: '', date: '2026-11-12', qty: '1', unit_cost: '9', tax: '',
          employee: '', po_row_id: null },
      ] });
      const sqlStub = tabStub({ versions: [{ list: [stored, orderB()], at: T_MOVED }], liveRows: ['row-purch-L1', 'row-L2'] });
      const res = await put(sqlStub, tabBody([tab, orderB()], {
        editedFields: { A: ['project_id'] }, editedLineFields: { A: { L1: ['qty', 'unit_cost'] } } }));
      const w = sqlStub.written();
      check('a job move is stored', res.statusCode === 200 && w.A && w.A.project_id === 'job2', JSON.stringify(w.A));
      check('  with the figures the tab minted job2\'s rows from — no settle against the old job\'s copy',
        lineOf(w.A, 'L1').qty === '7' && lineOf(w.A, 'L1').unit_cost === '3' && res.body.mergedLineFigures === 0,
        JSON.stringify(lineOf(w.A, 'L1')) + ' ' + JSON.stringify(res.body));
      check('  and the links it minted there', lineOf(w.A, 'L1').po_row_id === 'row-job2-L1', JSON.stringify(lineOf(w.A, 'L1')));
      const dropped = sqlStub.dropped();
      check('the row purchasing raised on the old job, which the tab never knew, is removed there',
        dropped.includes('row-purch-L1|job1|PO-0100'), JSON.stringify(dropped));
      check('  matched against the OLD job, which is where it sits',
        !dropped.some(d => /\|job2\|/.test(d)), JSON.stringify(dropped));
      check('  never a payroll row', !dropped.some(d => d.startsWith('ts12-')), JSON.stringify(dropped));
      check('  and the removal is scoped past the id alone',
        /d\.project_id\s*=\s*t\.project_id/.test((sqlStub.calls.find(c => /^DELETE FROM daily_tracking d/.test(c.q)) || {}).q || '')
        && /d\.timesheet_entry_id IS NULL/.test((sqlStub.calls.find(c => /^DELETE FROM daily_tracking d/.test(c.q)) || {}).q || ''));
      // The tab minted job2's rows from the figures it had at the move. A
      // delivery edited in the same save — queued behind the move, or carried
      // by its retry — has to reach them too, so the order's edits are written
      // to job2's rows, under the links the tab minted. Never job1's.
      const ups = sqlStub.upserts();
      check('a delivery edited in the same save as a job move is written to the new job\'s row',
        ups.length === 1 && ups[0].vals.includes('row-job2-L1') && ups[0].vals.includes('job2'),
        JSON.stringify(sqlStub.rowWrites().map(c => c.q.slice(0, 60))));
      check('  and nothing on the old job is written',
        !sqlStub.rowWrites().some(c => /^(INSERT|UPDATE)/.test(c.q) && c.vals.includes('job1')),
        JSON.stringify(sqlStub.rowWrites().map(c => c.vals)));
    }
    {
      // The order landed, the cost rows did not. That is not a success: the
      // tab keeps its marks only when the save fails, and the marks are what
      // get the rows written on the next one.
      const a = tabA();
      Object.assign(a.lines[0], { qty: '12' });
      const sqlStub = tabStub({ versions: [{ list: [storedA(), orderB()], at: T_MOVED }],
        linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'], failRowWrites: true });
      const res = await put(sqlStub, tabBody([a, orderB()], { editedLineFields: { A: { L1: ['qty'] } } }));
      check('a cost-row write that fails fails the save',
        res.statusCode === 500 && res.body && res.body.ok !== true, res.statusCode + ' ' + JSON.stringify(res.body));
      check('  saying the order itself was stored, so the tab does not treat it as lost',
        res.body && res.body.stored === true, JSON.stringify(res.body));
      check('  which it was — before the row write was tried',
        lineOf(sqlStub.written().A, 'L1').qty === '12'
        && sqlStub.at(/^UPDATE app_data/) < sqlStub.at(/^INSERT INTO daily_tracking/), JSON.stringify(lineOf(sqlStub.written().A, 'L1')));
      check('  and the mirror kept step with it', sqlStub.calls.some(c => /^INSERT INTO purchase_orders/.test(c.q)));
      check('  and the failure is logged', res.logs.some(l => /cost rows/.test(l)), JSON.stringify(res.logs));
    }
    {
      // The renumbered order still owns the Daily Tracking row carrying its
      // OLD number until the server rewrites it — and the quantity the tab
      // typed on that delivery is written to the row from here, while the
      // receiver a supervisor has since entered on the row stands.
      const ROW_D = { row_id: 'rowD', project_id: 'job1', po_num: 'PO-0100', units_purchased: 3, unit_cost: 4,
                      material_cost: 12, date: '2026-11-12', employee: 'Lee', cost_code: '02-100', sub_code: '0420' };
      const dailyLine = over => Object.assign({ id: 'dr-rowD', source: 'daily', invoice_num: '', date: '2026-11-12',
        qty: '3', unit_cost: '4', tax: '', tax_pct: '', employee: 'Lee', cost_code: '02-100', sub_code: '0420',
        po_row_id: 'rowD' }, over);
      const stored = storedA({ lines: storedA().lines.concat([dailyLine({})]) });
      const tab = storedA({ po_number: 'PO-0100A', lines: storedA().lines.concat([dailyLine({ qty: '5', employee: '' })]) });
      const sqlStub = tabStub({ versions: [{ list: [stored, orderB()], at: T_MOVED }],
        linkRows: RAISED_ROWS.concat([ROW_D]), liveRows: ['row-L1', 'row-L2'] });
      const res = await put(sqlStub, tabBody([tab, orderB()], {
        editedFields: { A: ['po_number'] }, editedLineFields: { A: { 'dr-rowD': ['qty'] } } }));
      const d = lineOf(sqlStub.written().A, 'dr-rowD');
      check('a renumbered order keeps the Daily Tracking delivery whose row still has the old number',
        res.statusCode === 200 && d.id === 'dr-rowD', JSON.stringify(sqlStub.written().A && sqlStub.written().A.lines));
      check('  with the quantity the tab typed, at the row\'s price', d.qty === '5' && d.unit_cost === '4', JSON.stringify(d));
      check('  and the row\'s receiver, which the tab\'s copy did not have', d.employee === 'Lee', JSON.stringify(d));
      const ups = sqlStub.updates();
      const rowD = ups.find(u => u.where.row_id === 'rowD');
      check('the Daily Tracking row is given the new number and the typed quantity',
        rowD && rowD.set.po_num === 'PO-0100A' && near(rowD.set.units_purchased, 5)
        && near(rowD.set.unit_cost, 4) && near(rowD.set.material_cost, 20) && rowD.set.employee === 'Lee',
        JSON.stringify(rowD));
      check('  and the rows the order raised take the new number too',
        ['row-L1', 'row-L2'].every(id => (ups.find(u => u.where.row_id === id) || { set: {} }).set.po_num === 'PO-0100A'),
        JSON.stringify(ups.map(u => [u.where.row_id, u.set.po_num])));
    }
    {
      // A tab running the code from before this — no editedLineFields — gets
      // exactly what it always did: the plain write, no compare-and-set read,
      // its deliveries stored as sent, nothing written to the job's rows from
      // here (it writes them itself), and no `orders` it would not read.
      const sqlStub = tabStub({ versions: [{ list: [storedA(), orderB()], at: T_MOVED }],
        linkRows: RAISED_ROWS, liveRows: ['row-L1', 'row-L2'] });
      const a = approvedA();
      Object.assign(a.lines[0], { qty: '12' });
      const res = await put(sqlStub, { purchaseOrders: [a, orderB()], baseUpdatedAt: T_READ,
                                       editedFields: { A: ['status'] } });
      const w = sqlStub.written();
      check('an older tab still saves', res.statusCode === 200 && res.body.ok === true, JSON.stringify(res.body));
      check('  through the plain write it always had',
        sqlStub.plainWrites().length === 1 && sqlStub.casWrites().length === 0, JSON.stringify(sqlStub.calls.map(c => c.q.slice(0, 40))));
      check('  reading the list the way it always did, with no compare-and-set read',
        sqlStub.casReads().length === 0 && sqlStub.at(/^SELECT value, updated_at FROM app_data/) >= 0);
      check('  its deliveries stored as it sent them',
        lineOf(w.A, 'L1').qty === '12' && lineOf(w.A, 'L1').unit_cost === '4' && res.body.mergedLineFigures === 0,
        JSON.stringify(lineOf(w.A, 'L1')));
      check('  the order fields it did not change still kept, as before this',
        w.A.supplier === 'Hanes Aggregates' && w.A.status === 'approved', JSON.stringify(w.A));
      check('  nothing written to the job\'s rows from here', sqlStub.rowWrites().length === 0,
        JSON.stringify(sqlStub.rowWrites().map(c => c.q.slice(0, 60))));
      check('  and no `orders` in the answer', !('orders' in res.body), JSON.stringify(Object.keys(res.body)));
    }
  }
  {
    // Purchasing's single-order save carries the same per-key edits, and the
    // upsert is what settles and writes with them.
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const send = async extra => {
      const res = makeRes();
      await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                      body: Object.assign({ purchaseOrder: PO }, extra) }, res);
      return calls[calls.length - 1];
    };
    const sent = await send({ editedLineFields: { L1: ['qty', 'unit_cost'] } });
    check('a single-order save passes on the delivery keys it changed',
      sent && JSON.stringify(sent.args.editedLineFields) === '{"L1":["qty","unit_cost"]}',
      sent && JSON.stringify(sent.args.editedLineFields));
    const empty = await send({ editedLineFields: {} });
    check('  "none" is still an answer, and is passed on as one',
      empty && empty.args.editedLineFields && typeof empty.args.editedLineFields === 'object'
      && !Object.keys(empty.args.editedLineFields).length, empty && JSON.stringify(empty.args.editedLineFields));
    for (const [label, v] of [['a list', ['L1']], ['a string', 'L1'], ['nothing', undefined]]) {
      const got = await send(v === undefined ? {} : { editedLineFields: v });
      check(`  ${label} in its place is "did not say" — deliveries stored whole`,
        got && got.args.editedLineFields === null, got && JSON.stringify(got.args.editedLineFields));
    }
  }

  console.log('\n[who raised an order, and when]');
  {
    // The division tabs save their whole list on every edit, so every order in
    // it passes through here each time — and one copy without the stamp would
    // have been enough to lose it.
    const T_READ = '2026-11-03T12:00:00.000Z';
    const T_NEW  = '2026-11-03T12:09:00.000Z';
    const STAMP  = { created_at: '2026-10-30T15:45:00.000Z', created_by: 'farmerykaleb' };
    const STORED = [
      Object.assign({ id: 'stamped', po_number: 'PO-0001', lines: [] }, STAMP),
      { id: 'legacy', po_number: 'PO-0002', lines: [] },
    ];
    const SENT = () => [
      { id: 'stamped', po_number: 'PO-0001', title: 'edited', lines: [] },
      { id: 'legacy', po_number: 'PO-0002', created_by: 'claimer', created_at: T_READ, lines: [] },
      { id: 'from-an-old-tab', po_number: 'PO-0003', lines: [] },
      { id: 'raised-here', po_number: 'PO-0004', created_by: 'hudockben',
        created_at: '2026-11-03T12:01:02.003Z', lines: [] },
    ];
    function stub() {
      const seen = [];
      const sql = (strings, ...vals) => {
        let q = ''; strings.forEach((x, i) => { q += x; if (i < vals.length) q += `$${i + 1}`; });
        q = q.replace(/\s+/g, ' ').trim();
        seen.push({ q, vals });
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve([{ value: STORED, updated_at: new Date(T_READ) }]);
        }
        if (/^SELECT value FROM app_data/.test(q)) return Promise.resolve([{ value: STORED }]);
        if (/^INSERT INTO app_data/.test(q)) return Promise.resolve([{ updated_at: new Date(T_NEW) }]);
        if (/^SELECT COUNT\(\*\)::int AS count FROM po_deliveries/.test(q)) return Promise.resolve([{ count: 0 }]);
        return Promise.resolve([]);
      };
      sql.written = () => {
        const hit = seen.find(c => /^INSERT INTO app_data/.test(c.q));
        return hit ? JSON.parse(hit.vals[1]) : null;
      };
      sql.mirrored = id => (seen.find(c => /^INSERT INTO purchase_orders/.test(c.q) && c.vals[0] === id) || {}).vals || [];
      return sql;
    }
    const byId = list => Object.fromEntries((list || []).map(p => [p.id, p]));

    // All three ways a full-list save reaches the write: through the merge's
    // read, with no version to merge against, and forced.
    for (const [label, query, extra] of [
      ['an up-to-date tab', {}, { baseUpdatedAt: T_READ }],
      ['a tab with no version', {}, {}],
      ['a forced save', { force: '1' }, {}],
    ]) {
      const sqlStub = stub();
      const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
      const res = makeRes();
      await handler({ method: 'PUT', query: Object.assign({ division: 'turf' }, query), headers: AUTHED,
                      body: Object.assign({ purchaseOrders: SENT() }, extra) }, res);
      const w = byId(sqlStub.written());
      check(`${label}: saved`, res.statusCode === 200, res.statusCode + ' ' + JSON.stringify(res.body));
      check(`${label}: a copy without the stamp does not erase it`,
        w.stamped && w.stamped.created_by === STAMP.created_by && w.stamped.created_at === STAMP.created_at
        && w.stamped.title === 'edited', JSON.stringify(w.stamped));
      check(`${label}: an order raised before the stamp cannot be claimed`,
        w.legacy && !('created_by' in w.legacy) && !('created_at' in w.legacy), JSON.stringify(w.legacy));
      check(`${label}: a new order a tab sent unstamped is stamped as the signed-in user`,
        w['from-an-old-tab'] && w['from-an-old-tab'].created_by === 'u1'
        && !isNaN(Date.parse(w['from-an-old-tab'].created_at)), JSON.stringify(w['from-an-old-tab']));
      check(`${label}: a new order keeps the stamp its page gave it`,
        w['raised-here'] && w['raised-here'].created_by === 'hudockben'
        && w['raised-here'].created_at === '2026-11-03T12:01:02.003Z', JSON.stringify(w['raised-here']));
      check(`${label}: the mirror row gets the stamp`,
        sqlStub.mirrored('raised-here').includes('hudockben')
        && sqlStub.mirrored('raised-here').includes('2026-11-03T12:01:02.003Z'),
        JSON.stringify(sqlStub.mirrored('raised-here')));
      check(`${label}: and not the claim`, !sqlStub.mirrored('legacy').includes('claimer'),
        JSON.stringify(sqlStub.mirrored('legacy')));
      // Stamping is not merging: the tab adopts the new version as usual.
      check(`${label}: nothing is reported as merged`, res.body && res.body.merged === 0, JSON.stringify(res.body));
    }
  }
  {
    const calls = [];
    const handler = loadEndpoint({ roles: { purchase_orders: 'level3' }, calls });
    const res = makeRes();
    await handler({ method: 'POST', query: { division: 'paving' }, headers: AUTHED,
                    body: { purchaseOrder: PO } }, res);
    check('a single-order save passes on who is saving, for a new order\'s stamp',
      calls[0] && calls[0].args.username === 'u1', JSON.stringify(calls[0] && calls[0].args.username));
  }
  {
    // The recovery read, with the blob gone: the stamp comes back from the
    // mirror — and the row's own created_at is NOT passed off as one.
    const rows = [
      { id: 'p1', po_num: 'PO-0001', status: 'approved', created_by: 'farmerykaleb',
        created_at: new Date('2026-10-30T15:45:00.000Z') },
      { id: 'p2', po_num: 'PO-0002', status: 'pending', created_by: null,
        created_at: new Date('2026-07-01T00:00:00.000Z') },
    ];
    const sqlStub = (strings) => {
      const q = strings.join('?').replace(/\s+/g, ' ').trim();
      if (/^SELECT \* FROM purchase_orders/.test(q)) return Promise.resolve(rows);
      return Promise.resolve([]);
    };
    const handler = loadEndpoint({ roles: { turf: 'level3' }, sqlStub });
    const res = makeRes();
    await handler({ method: 'GET', query: { division: 'turf' }, headers: AUTHED }, res);
    const got = Object.fromEntries(((res.body && res.body.purchaseOrders) || []).map(p => [p.id, p]));
    check('the recovery read returns who raised an order, and when',
      got.p1 && got.p1.created_by === 'farmerykaleb' && got.p1.created_at === '2026-10-30T15:45:00.000Z',
      JSON.stringify(got.p1));
    check('and gives no creation time for an order nobody stamped',
      got.p2 && got.p2.created_at === undefined && got.p2.created_by === undefined, JSON.stringify(got.p2));
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
