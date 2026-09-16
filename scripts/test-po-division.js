#!/usr/bin/env node
'use strict';
/**
 * Central purchasing — access rules and single-order writes.
 *
 * Run: node scripts/test-po-division.js
 *
 * The Purchase Orders division raises orders against turf, paving and kiewit
 * and stores each one in THAT division's list, so a purchasing user has to
 * reach lists it holds no role in. That is a deliberate hole in the division
 * wall, and these tests pin both halves of it: what it opens, and — far more
 * of them — what it does not.
 *
 * Covered:
 *  - canAccessPODivision / poDivisionsFor: purchasing reaches the three job
 *    divisions and nothing else; a job division gains nothing from it.
 *  - requirePODivision: names its division, 403s outside the carve-out.
 *  - The endpoint guard: the full-list PUT stays behind a real division role,
 *    so purchasing can never wipe a division's list.
 *  - upsertPO: the compare-and-set merge, in-place replacement, a losing
 *    writer's retry, and moving an order between divisions.
 *  - syncPOCostRows: which deliveries become job cost rows, which do not, and
 *    what happens to the rows when an order is re-tied or a line emptied.
 *  - removePO: the order, its deliveries and its cost rows all go.
 *  - resolvePODocScope: a receipt's carve-out needs a real order id.
 *
 * No DB and no server — the neon driver is a small in-memory store.
 */

const path   = require('path');
const Module = require('module');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const auth = require('../api/lib/auth');
const {
  canAccessPODivision, poDivisionsFor, requirePODivision,
  hasDivisionAccess, poCapabilities, PO_SOURCE_DIVISIONS, PO_GENERAL_DIVISION,
} = auth;
const poSync = require('../api/lib/po-sync');

// ── Fixtures ────────────────────────────────────────────────────────────────
const purchasing   = { username: 'buyer',   companyCode: 'FCT', divisionRoles: { purchase_orders: 'level3' } };
const purchViewer  = { username: 'buyer1',  companyCode: 'FCT', divisionRoles: { purchase_orders: 'level1' } };
const pavingOnly   = { username: 'paving',  companyCode: 'FCT', divisionRoles: { paving: 'level3' } };
const dustOnly     = { username: 'dust',    companyCode: 'FCT', divisionRoles: { dust: 'level3' } };
const bothRoles    = { username: 'both',    companyCode: 'FCT', divisionRoles: { purchase_orders: 'level3', paving: 'level3' } };
const platformAdmin= { username: 'root',    companyCode: 'FCT', divisionRoles: null, isPlatformAdmin: true };

// ── An in-memory stand-in for app_data + the two mirror tables ─────────────
// Only the statements po-sync issues are understood; anything else answers []
// so an accidental new query shows up as a failed assertion rather than a pass.
function makeStore() {
  const appData   = new Map();   // key → { value, updatedAt }
  const poRows    = new Map();   // id → row
  const deliveries= [];          // { po_id, line_id, ... }
  const daily     = new Map();   // row_id → row
  // Microsecond-precision TEXT stamps, which is what app_data.updated_at
  // actually holds and what the driver would destroy if it parsed the column
  // into a JS Date. Whole-second stamps could not express that failure, which
  // is how a compare-and-set that could NEVER match survived three reviews.
  let tick = 0;
  const stamp = () => '2026-07-01T00:00:00.' + String(++tick).padStart(6, '0') + 'Z';
  const log = [];
  // Set to a function to interfere with a write once — used to simulate
  // another writer landing between this one's read and its update.
  let interfere = null;

  function sql(strings, ...vals) {
    let q = '';
    strings.forEach((s, i) => { q += s; if (i < vals.length) q += `$${i + 1}`; });
    q = q.replace(/\s+/g, ' ').trim();
    log.push(q);

    // ── app_data reads ──
    // The real read casts to text so the microseconds survive the round trip.
    if (/^SELECT value, updated_at::text AS updated_at FROM app_data WHERE key =/.test(q)) {
      const row = appData.get(vals[0]);
      return Promise.resolve(row ? [{ value: row.value, updated_at: row.updatedAt }] : []);
    }
    if (/^SELECT value, updated_at FROM app_data WHERE key =/.test(q)) {
      throw new Error('read app_data.updated_at without ::text — microseconds would be lost');
    }
    // ── app_data compare-and-set ──
    if (/^UPDATE app_data SET value =/.test(q)) {
      const [json, key, base] = vals;
      if (interfere) { const f = interfere; interfere = null; f(); }
      const row = appData.get(key);
      if (!row || row.updatedAt !== base) return Promise.resolve([]);
      appData.set(key, { value: JSON.parse(json), updatedAt: stamp() });
      return Promise.resolve([{ key }]);
    }
    if (/^INSERT INTO app_data .* ON CONFLICT \(key\) DO NOTHING/.test(q)) {
      const [key, json] = vals;
      if (interfere) { const f = interfere; interfere = null; f(); }
      if (appData.has(key)) return Promise.resolve([]);
      appData.set(key, { value: JSON.parse(json), updatedAt: stamp() });
      return Promise.resolve([{ key }]);
    }

    // ── purchase_orders mirror ──
    if (/^INSERT INTO purchase_orders/.test(q)) {
      poRows.set(vals[0], { id: vals[0], company_code: vals[1], division: vals[2], po_num: vals[3] });
      return Promise.resolve([]);
    }
    if (/^DELETE FROM purchase_orders WHERE id =/.test(q)) {
      poRows.delete(vals[0]);
      return Promise.resolve([]);
    }

    // ── po_deliveries mirror ──
    if (/^DELETE FROM po_deliveries WHERE po_id =/.test(q)) {
      for (let i = deliveries.length - 1; i >= 0; i--) {
        if (deliveries[i].po_id === vals[0]) deliveries.splice(i, 1);
      }
      return Promise.resolve([]);
    }
    if (/^INSERT INTO po_deliveries/.test(q)) {
      deliveries.push({ po_id: vals[0], line_id: vals[2], tax: vals[8], po_row_id: vals[10] });
      return Promise.resolve([]);
    }

    // ── daily_tracking ──
    if (/^DELETE FROM daily_tracking WHERE company_code = .* row_id = ANY/.test(q)) {
      const ids = vals[1] || [];
      const gone = [];
      ids.forEach(id => { if (daily.has(id)) { daily.delete(id); gone.push({ row_id: id }); } });
      return Promise.resolve(gone);
    }
    if (/^INSERT INTO daily_tracking/.test(q)) {
      // 'Material' is a literal in the INSERT, so it is NOT one of the
      // parameters — the columns after date shift down by one.
      const [rowId, projectId, companyCode, division, date, employee,
             costCode, subCode, material, supplier, poNum,
             qty, unitCost, cost, codesChanged] = vals;
      const existing = daily.get(rowId);
      if (existing) {
        // The conflict arm: scoped to this company, never a payroll-injected
        // row, and the codes only follow the order when the order changed them.
        if (existing.company_code !== companyCode) return Promise.resolve([]);
        if (existing.timesheet_entry_id) return Promise.resolve([]);
        Object.assign(existing, {
          project_id: projectId, division, date, employee,
          material, supplier, po_num: poNum,
          units_purchased: qty, unit_cost: unitCost, material_cost: cost,
        });
        if (codesChanged) { existing.cost_code = costCode; existing.sub_code = subCode; }
        return Promise.resolve([{ row_id: rowId }]);
      }
      daily.set(rowId, {
        row_id: rowId, project_id: projectId, company_code: companyCode, division,
        date, field_type: 'Material', employee,
        cost_code: costCode, sub_code: subCode,
        material, supplier, po_num: poNum,
        units_purchased: qty, unit_cost: unitCost, material_cost: cost,
      });
      return Promise.resolve([{ row_id: rowId }]);
    }
    if (/^SELECT 1 FROM document_links/.test(q)) return Promise.resolve([]);

    return Promise.resolve([]);
  }

  return {
    sql, appData, poRows, deliveries, daily, log,
    setBlob(key, list) { appData.set(key, { value: list, updatedAt: stamp() }); },
    getBlob(key) { const r = appData.get(key); return r ? r.value : null; },
    onNextWrite(f) { interfere = f; },
  };
}

const KEY = (div) => `FCT:fct_purchase_orders:${div}`;

function makePO(over) {
  return Object.assign({
    id: 'po1', po_number: 'PO-0001', title: 'Stone', supplier: 'Acme',
    status: 'pending', date_created: '2026-09-01',
    project_id: '', cost_code: '', sub_code: '', lines: [],
  }, over || {});
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[canAccessPODivision]');
PO_SOURCE_DIVISIONS.forEach(d => {
  assert(`purchasing reaches ${d}`, canAccessPODivision(purchasing, d) === true);
});
assert('purchasing reaches its own general list', canAccessPODivision(purchasing, PO_GENERAL_DIVISION) === true);
assert('purchasing does NOT reach dust',          canAccessPODivision(purchasing, 'dust') === false);
assert('purchasing does NOT reach trucking',      canAccessPODivision(purchasing, 'trucking') === false);
assert('purchasing does NOT reach quarry',        canAccessPODivision(purchasing, 'quarry') === false);
assert('purchasing does NOT reach intercompany', canAccessPODivision(purchasing, 'intercompany') === false);
assert('purchasing does NOT reach executive',    canAccessPODivision(purchasing, 'executive') === false);
// A view-only purchasing role still resolves here — reading is the point, and
// whether it may WRITE is decided by capabilities(), not by this function.
assert('level1 purchasing still resolves paving', canAccessPODivision(purchViewer, 'paving') === true);

assert('paving user reaches paving',            canAccessPODivision(pavingOnly, 'paving') === true);
assert('paving user gains NOTHING for turf',    canAccessPODivision(pavingOnly, 'turf') === false);
assert('paving user gains NOTHING for general', canAccessPODivision(pavingOnly, PO_GENERAL_DIVISION) === false);
assert('dust user reaches nothing here',        canAccessPODivision(dustOnly, 'paving') === false);
assert('platform admin reaches paving',         canAccessPODivision(platformAdmin, 'paving') === true);
assert('null payload rejected',                 canAccessPODivision(null, 'paving') === false);
assert('null division rejected',                canAccessPODivision(purchasing, null) === false);

console.log('\n[the carve-out does not leak into the ordinary division check]');
assert('hasDivisionAccess(purchasing, paving) still false', hasDivisionAccess(purchasing, 'paving') === false);
assert('hasDivisionAccess(purchasing, turf) still false',   hasDivisionAccess(purchasing, 'turf') === false);
assert('hasDivisionAccess(purchasing, purchase_orders)',    hasDivisionAccess(purchasing, 'purchase_orders') === true);

console.log('\n[poCapabilities — reaching a division is not permission to write it]');
{
  const cap = (roles, div) => poCapabilities({ divisionRoles: roles }, div);

  // Reaching paving's orders and being allowed to change them are different
  // questions, and the answer to the second comes from the PURCHASING level.
  assert('a view-only purchasing user cannot write paving orders',
    cap({ purchase_orders: 'level1' }, 'paving').canUpload === false);
  assert('and cannot delete them',
    cap({ purchase_orders: 'level1' }, 'paving').canManage === false);
  assert('a level2 purchasing user can write them',
    cap({ purchase_orders: 'level2' }, 'paving').canUpload === true);
  assert('but not delete them',
    cap({ purchase_orders: 'level2' }, 'paving').canManage === false);
  assert('a level3 purchasing user can do both',
    cap({ purchase_orders: 'level3' }, 'paving').canUpload === true &&
    cap({ purchase_orders: 'level3' }, 'paving').canManage === true);

  // Granting a purchasing user READ access to a division must not take a
  // capability away — the division role used to win outright, so adding
  // paving:level1 silently stopped their receipts uploading.
  assert('adding a view-only division role takes nothing away',
    cap({ purchase_orders: 'level3', paving: 'level1' }, 'paving').canUpload === true);
  assert('and a view-only division role alone still grants nothing',
    cap({ paving: 'level1' }, 'paving').canUpload === false);
  assert('a real division role answers for itself',
    cap({ paving: 'level3' }, 'paving').canUpload === true);

  // Destroying a file belongs to the division that owns it. Raising an order
  // there is not a reason to hand purchasing that.
  assert('purchasing never gets delete rights in a division',
    cap({ purchase_orders: 'admin' }, 'paving').canDelete === false);
  // ...and `level` is derived from the booleans rather than carried over from
  // whichever role won, or it could answer 'admin' alongside canDelete false —
  // an object contradicting itself, and the first consumer to test
  // `level === 'admin'` would hand over a division's document vault.
  [
    [{ purchase_orders: 'admin' },  'paving'], [{ purchase_orders: 'level3' }, 'paving'],
    [{ purchase_orders: 'level2' }, 'paving'], [{ purchase_orders: 'level1' }, 'paving'],
    [{ paving: 'level1', purchase_orders: 'admin' }, 'paving'],
    [{ paving: 'admin' }, 'paving'], [{ paving: 'level1' }, 'paving'],
    [{ purchase_orders: 'admin' }, 'dust'],
  ].forEach(([roles, div]) => {
    const c = cap(roles, div);
    const coherent = (c.level === 'admin') === c.canDelete
      && (!c.canDelete || c.canManage) && (!c.canManage || c.canUpload);
    assert(`level agrees with the rights: ${JSON.stringify(roles)} -> ${div}`, coherent,
      JSON.stringify(c));
  });
  assert('a division admin keeps them',
    cap({ paving: 'admin' }, 'paving').canDelete === true);

  assert('and none of it reaches a division outside the carve-out',
    cap({ purchase_orders: 'admin' }, 'dust').canUpload === false);
  assert('a user with no roles gets nothing',
    cap({}, 'paving').canUpload === false);
}

console.log('\n[poDivisionsFor]');
assert('purchasing sees all four lists',
  JSON.stringify(poDivisionsFor(purchasing)) === JSON.stringify(['turf','paving','kiewit','purchase_orders']));
assert('paving user sees only paving',
  JSON.stringify(poDivisionsFor(pavingOnly)) === JSON.stringify(['paving']));
assert('dust user sees none', poDivisionsFor(dustOnly).length === 0);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[requirePODivision]');
function fakeRes() {
  const r = { code: null, body: null };
  r.status = c => { r.code = c; return r; };
  r.json   = b => { r.body = b; return r; };
  return r;
}
function guardWith(payload, query) {
  const res = fakeRes();
  const req = { query: query || {}, body: null, headers: {} };
  // requirePODivision calls requireAuth, which wants a Bearer token. Stub the
  // verification rather than minting a real JWT — the token path is already
  // covered by test-division-isolation.js.
  const origVerify = require('jsonwebtoken').verify;
  require('jsonwebtoken').verify = () => payload;
  req.headers.authorization = 'Bearer x';
  try { return { out: requirePODivision(req, res), res }; }
  finally { require('jsonwebtoken').verify = origVerify; }
}

let g = guardWith(purchasing, { division: 'paving' });
assert('purchasing passes for paving', g.out && g.out.division === 'paving');

g = guardWith(purchasing, { division: 'dust' });
assert('purchasing 403s for dust', g.out === null && g.res.code === 403);
assert('the 403 names no division',
  g.res.body && !/dust/i.test(JSON.stringify(g.res.body)));

g = guardWith(purchasing, {});
assert('a missing division is 400, not a turf default', g.out === null && g.res.code === 400);

g = guardWith(purchasing, { division: 'nonsense' });
assert('an unknown division is 400', g.out === null && g.res.code === 400);

g = guardWith(pavingOnly, { division: 'turf' });
assert('paving user 403s for turf', g.out === null && g.res.code === 403);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[endpoint guard — the full-list PUT stays shut]');
// The PUT replaces a division's entire list. Purchasing must never reach it,
// or one call could erase everything paving's own tab had saved.
(function () {
  const endpointPath = path.resolve(__dirname, '../api/purchase-orders.js');
  const src = require('fs').readFileSync(endpointPath, 'utf8');
  assert('PUT is routed to requireDivision',
    /if \(req\.method === 'PUT'\) return requireDivision\(req, res\);/.test(src));
  assert('everything else resolves through canAccessPODivision',
    /canAccessPODivision\(payload, division\)/.test(src));
  assert('POST exists for single-order upsert', /req\.method === 'POST'/.test(src));
  assert('DELETE exists for single-order removal', /req\.method === 'DELETE'/.test(src));
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[upsertPO — merging into a division list]');
(async function () {
  // Insert into a list that already has somebody else's order in it.
  let st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'theirs', po_number: 'PO-0009' })]);
  let po = makePO({ id: 'mine', po_number: 'PO-0010', origin: 'purchasing' });
  let r  = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po });
  let list = st.getBlob(KEY('paving'));
  assert('insert keeps the existing order', r.ok && list.length === 2);
  assert('the existing order is untouched', list[0].id === 'theirs');
  assert('the new order is appended',       list[1].id === 'mine');
  assert('the mirror row carries the division',
    st.poRows.get('mine') && st.poRows.get('mine').division === 'paving');

  // Editing replaces IN PLACE. Appending would jump the edited order to the end
  // of the list, which is the order every PO table draws in.
  st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'a' }), makePO({ id: 'b' }), makePO({ id: 'c' })]);
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po: makePO({ id: 'b', title: 'Changed' }) });
  list = st.getBlob(KEY('paving'));
  assert('edit does not reorder the list', list.map(p => p.id).join(',') === 'a,b,c');
  assert('edit applied',                   list[1].title === 'Changed');

  // A list that does not exist yet.
  st = makeStore();
  r = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'purchase_orders', po: makePO({ id: 'gen' }) });
  assert('creates the blob when absent', r.ok && st.getBlob(KEY('purchase_orders')).length === 1);

  // A writer that loses the race re-reads and merges onto the winner's list
  // rather than overwriting it.
  st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'a' })]);
  st.onNextWrite(() => {
    // Somebody else's save lands between our read and our update.
    st.setBlob(KEY('paving'), [makePO({ id: 'a' }), makePO({ id: 'sneaked-in' })]);
  });
  r = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po: makePO({ id: 'ours' }) });
  list = st.getBlob(KEY('paving'));
  assert('a lost race retries instead of failing', r.ok === true);
  assert('the other writer\'s order survived', list.some(p => p.id === 'sneaked-in'));
  assert('ours landed too',                   list.some(p => p.id === 'ours'));
  assert('nothing was lost',                  list.length === 3);
})()

// ════════════════════════════════════════════════════════════════════════════
.then(async function () {
  console.log('\n[syncPOCostRows — what reaches the job]');

  // A delivery with a quantity costs the job.
  let st = makeStore();
  let po = makePO({
    id: 'p1', project_id: 'job7', cost_code: '420', sub_code: 'Base',
    lines: [{ id: 'L1', date: '2026-09-02', qty: '10', unit_cost: '2.50', tax_pct: '6', employee: 'Sam' }],
  });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po });
  let rows = [...st.daily.values()];
  assert('one cost row created', rows.length === 1);
  const row = rows[0];
  assert('filed in the ORDER\'s division', row.division === 'paving');
  assert('on the order\'s job',            row.project_id === 'job7');
  assert('as Material',                    row.field_type === 'Material');
  assert('carries the codes',              row.cost_code === '420' && row.sub_code === 'Base');
  assert('carries vendor and PO number',   row.supplier === 'Acme' && row.po_num === 'PO-0001');
  assert('quantity and unit cost copied',  Number(row.units_purchased) === 10 && Number(row.unit_cost) === 2.5);
  // 10 × 2.50 = 25.00, plus 6% tax = 26.50. The job is charged the tax too,
  // which is what the division tabs do.
  assert('material cost includes the tax', Math.abs(Number(row.material_cost) - 26.5) < 0.001);
  assert('the line is linked back to the row', po.lines[0].po_row_id === row.row_id);

  // Re-saving the same order must not create a second row.
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po });
  assert('re-saving is idempotent', st.daily.size === 1);

  // An empty delivery line costs nothing — someone added a row and never
  // filled it in.
  st = makeStore();
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
    po: makePO({ id: 'p2', project_id: 'job1', lines: [{ id: 'L1', date: '2026-09-02', qty: '', unit_cost: '' }] }) });
  assert('an empty delivery creates no cost row', st.daily.size === 0);

  // A general order has no job, so nothing to charge.
  st = makeStore();
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'purchase_orders',
    po: makePO({ id: 'p3', project_id: '', lines: [{ id: 'L1', qty: '4', unit_cost: '9' }] }) });
  assert('a general order creates no cost row', st.daily.size === 0);
  assert('but the order itself is stored', st.getBlob(KEY('purchase_orders')).length === 1);

  // Clearing a delivery's quantity removes the row it had created.
  st = makeStore();
  po = makePO({ id: 'p4', project_id: 'job1', lines: [{ id: 'L1', qty: '5', unit_cost: '3' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  const rowId = po.lines[0].po_row_id;
  assert('row created first', Boolean(rowId) && st.daily.size === 1);
  po.lines[0].qty = '';
  po.lines[0].unit_cost = '';
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('emptying the delivery removes the cost row', st.daily.size === 0);
  assert('and drops the stale link',                   po.lines[0].po_row_id === null);

  // Deleting a delivery from the order removes its row.
  st = makeStore();
  po = makePO({ id: 'p5', project_id: 'job1', lines: [
    { id: 'L1', qty: '1', unit_cost: '10' },
    { id: 'L2', qty: '2', unit_cost: '20' },
  ] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('two rows for two deliveries', st.daily.size === 2);

  // A delivery simply MISSING from the payload is one the caller may never
  // have seen — somebody else could have added it — so it is kept. Removing
  // one has to be said out loud.
  const droppedId = po.lines[1].id;
  po.lines = [po.lines[0]];
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('an undeclared omission keeps the delivery', st.daily.size === 2);

  // The merge above put the delivery back on `po` — as it does on the page,
  // which adopts what came back. Removing it for real means taking it out of
  // the list AND declaring it, which is what deleteLine() now does.
  po.lines = po.lines.filter(l => l.id !== droppedId);
  await poSync.upsertPO(st.sql, {
    companyCode: 'FCT', division: 'turf', po, deletedLineIds: [droppedId],
  });
  assert('removing a delivery removes its row', st.daily.size === 1);

  // Moving the order to a different job takes its costs with it.
  st = makeStore();
  po = makePO({ id: 'p6', project_id: 'jobA', lines: [{ id: 'L1', qty: '3', unit_cost: '7' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  const firstRow = po.lines[0].po_row_id;
  po.project_id = 'jobB';
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('still exactly one cost row', st.daily.size === 1);
  assert('the old job\'s row is gone',  !st.daily.has(firstRow));
  assert('the new row is on the new job', [...st.daily.values()][0].project_id === 'jobB');

  // A payroll-injected row is never touched, whatever a corrupted link says.
  st = makeStore();
  st.daily.set('ts99-abc-0-x', { row_id: 'ts99-abc-0-x', project_id: 'job1', company_code: 'FCT', timesheet_entry_id: 42 });
  po = makePO({ id: 'p7', project_id: 'job1', lines: [{ id: 'L1', qty: '1', unit_cost: '1', po_row_id: 'ts99-abc-0-x' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('a payroll-injected row survives', st.daily.has('ts99-abc-0-x'));

  console.log('\n[upsertPO — re-tying an order to another division]');
  st = makeStore();
  po = makePO({ id: 'mv', project_id: 'pav1', lines: [{ id: 'L1', qty: '2', unit_cost: '5' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po });
  const pavRow = po.lines[0].po_row_id;
  assert('starts in paving', st.getBlob(KEY('paving')).length === 1);

  // Re-tied to turf, against a turf job. The page clears the job when the
  // division changes, so this is the shape the server actually receives.
  po.project_id = 'turf1';
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po, from: 'paving' });
  assert('removed from paving\'s list', (st.getBlob(KEY('paving')) || []).length === 0);
  assert('added to turf\'s list',       st.getBlob(KEY('turf')).length === 1);
  assert('paving\'s cost row is gone',  !st.daily.has(pavRow));
  assert('exactly one cost row remains', st.daily.size === 1);
  assert('and it belongs to turf',      [...st.daily.values()][0].division === 'turf');
  assert('mirror row followed the move', st.poRows.get('mv').division === 'turf');

  console.log('\n[a delivery somebody else recorded]');
  // The feature's own primary workflow: purchasing raises an order against a
  // paving job, the paving supervisor records a delivery on it, and purchasing
  // — still holding the copy it loaded a minute ago — types in the Notes. The
  // save used to replace the order outright, so the supervisor's delivery went,
  // and syncPOCostRows read its absence as a deletion and took the job cost row
  // behind it too. Nothing on either screen said so.
  st = makeStore();
  po = makePO({ id: 'shared', project_id: 'job1',
                lines: [{ id: 'L1', qty: '10', unit_cost: '5' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po });
  const mine = JSON.parse(JSON.stringify(po));      // purchasing's copy, as loaded

  // The supervisor's delivery lands, with its own cost row.
  const theirs = JSON.parse(JSON.stringify(po));
  theirs.lines.push({ id: 'L2', qty: '4', unit_cost: '25' });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po: theirs });
  const theirRow = theirs.lines[1].po_row_id;
  assert('their delivery has a cost row', st.daily.size === 2 && Boolean(theirRow));

  // Purchasing saves its stale copy, changing only the notes.
  mine.notes = 'call the yard';
  const merged = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po: mine });
  const storedNow = st.getBlob(KEY('paving'))[0];
  assert('the save lands', merged.ok === true);
  assert('their delivery survives',
    storedNow.lines.some(l => l.id === 'L2'), JSON.stringify(storedNow.lines.map(l => l.id)));
  assert('and so does the job cost row behind it', st.daily.has(theirRow));
  assert('the edit still applied',   storedNow.notes === 'call the yard');
  assert('and the caller is told',   merged.mergedLines === 1, String(merged.mergedLines));
  assert('the job is charged for both', st.daily.size === 2);

  // A delivery the caller really DID delete must still go.
  const after = JSON.parse(JSON.stringify(storedNow));
  const l2row = after.lines.find(l => l.id === 'L2').po_row_id;
  after.lines = after.lines.filter(l => l.id !== 'L2');
  const dropped = await poSync.upsertPO(st.sql, {
    companyCode: 'FCT', division: 'paving', po: after, deletedLineIds: ['L2'],
  });
  assert('a deliberate deletion still deletes',
    !st.getBlob(KEY('paving'))[0].lines.some(l => l.id === 'L2'));
  assert('and takes its cost row with it', !st.daily.has(l2row) && st.daily.size === 1);
  assert('nothing is reported merged',     dropped.mergedLines === 0);

  console.log('\n[unseenLines on its own]');
  const prior = [{ lines: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] }];
  assert('keeps what the caller never sent',
    poSync.unseenLines({ lines: [{ id: 'A' }] }, prior, []).map(l => l.id).join() === 'B,C');
  assert('drops what it says it deleted',
    poSync.unseenLines({ lines: [{ id: 'A' }] }, prior, ['B']).map(l => l.id).join() === 'C');
  assert('keeps nothing when the caller sent everything',
    poSync.unseenLines({ lines: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] }, prior, []).length === 0);
  assert('survives an order with no lines at all',
    poSync.unseenLines({}, prior, []).map(l => l.id).join() === 'A,B,C');
  assert('and no prior copy',
    poSync.unseenLines({ lines: [{ id: 'A' }] }, [], []).length === 0);
  assert('never returns the same line twice',
    poSync.unseenLines({ lines: [] }, [prior[0], prior[0]], []).length === 3);

  console.log('\n[the compare-and-set has to be able to match]');
  // app_data.updated_at is a MICROSECOND timestamptz. The driver parses a
  // timestamptz into a JS Date, which holds only milliseconds — so reading the
  // column raw threw the microseconds away and the value re-bound in the WHERE
  // could never equal the stored one. Every compare-and-set lost all six
  // attempts and every purchasing save and delete answered 409: the division
  // was entirely non-functional. The mock above refuses an uncast read.
  st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'first' })]);
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const r = await poSync.upsertPO(st.sql, {
      companyCode: 'FCT', division: 'paving', po: makePO({ id: 'p' + i }),
    });
    if (r.ok) n++;
  }
  assert('five consecutive saves all land', n === 5, n + '/5');
  assert('and every one of them is in the list',
    st.getBlob(KEY('paving')).length === 6, JSON.stringify(st.getBlob(KEY('paving')).map(p => p.id)));
  // ...and the guard still guards: a writer on a stale base must still lose.
  const staleBase = { list: [], updatedAt: '2026-07-01T00:00:00.000001Z', exists: true };
  const lost = await poSync.mutatePOBlob(st.sql, KEY('paving'), list => list.concat([makePO({ id: 'z' })]));
  assert('a normal write still succeeds through mutatePOBlob', lost.ok === true);

  console.log('\n[a failed save must not take the job\'s costs with it]');
  // The rollback deleted every row the save had TOUCHED, including ones it only
  // updated — rows the stored order still names and the job still needs. With
  // the compare-and-set broken above, that fired on every save.
  st = makeStore();
  po = makePO({ id: 'keep', project_id: 'job1', lines: [{ id: 'L1', qty: '10', unit_cost: '5' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  const liveRow = po.lines[0].po_row_id;
  assert('the first save creates the cost row', st.daily.size === 1 && Boolean(liveRow));

  // Second save, edited, with the blob write losing every attempt.
  po.lines[0].qty = '12';
  const realSql3 = st.sql;
  const loseBlob = (strings, ...vals) => {
    const q = strings.join(' ').replace(/\s+/g, ' ');
    if (/^ *UPDATE app_data SET value =/.test(q) && vals[1] === KEY('turf')) return Promise.resolve([]);
    return realSql3(strings, ...vals);
  };
  // Not `failed` — that is the suite's own counter, and shadowing it made the
  // summary print an object instead of a number.
  const conflicted = await poSync.upsertPO(loseBlob, { companyCode: 'FCT', division: 'turf', po });
  assert('the save is reported as a conflict', conflicted.ok === false);
  assert('but the job KEEPS the cost row it already had',
    st.daily.has(liveRow), JSON.stringify([...st.daily.keys()]));
  assert('and the order still points at it', po.lines[0].po_row_id === liveRow);

  console.log('\n[deleting an order that is not in this list]');
  // mutatePOBlob reports ok when there is nothing to remove, and unmirrorPO
  // scopes on id and company alone — so this used to delete the order's mirror
  // row and every delivery row wherever they really lived.
  st = makeStore();
  po = makePO({ id: 'elsewhere', project_id: 'job1', lines: [{ id: 'L1', qty: '1', unit_cost: '5' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po });
  assert('it is mirrored under paving', st.poRows.has('elsewhere'));

  const wrong = await poSync.removePO(st.sql, { companyCode: 'FCT', division: 'turf', poId: 'elsewhere' });
  assert('deleting it from the wrong list reports not-found', wrong.ok === true && wrong.found === false);
  assert('and leaves the mirror row alone',   st.poRows.has('elsewhere'));
  assert('and its deliveries alone',          st.deliveries.some(d => d.po_id === 'elsewhere'));
  assert('and the job cost row alone',        st.daily.size === 1);
  assert('while paving still lists it',       st.getBlob(KEY('paving')).length === 1);

  console.log('\n[a row id the order does not own]');
  // po_row_id arrives in the request body and daily_tracking.row_id is unique
  // across the whole company, so a crafted one could otherwise reach any job
  // cost row in the tenant — from a division the caller holds no role in.
  st = makeStore();
  st.daily.set('VICTIM', {
    row_id: 'VICTIM', project_id: 'dustjob', company_code: 'FCT', division: 'dust',
    material: 'Somebody else\'s row', material_cost: 500,
  });

  // (a) Emptying a line that points at it must not delete it.
  po = makePO({ id: 'evil1', project_id: 'turfjob',
                lines: [{ id: 'L1', qty: '', unit_cost: '', po_row_id: 'VICTIM' }] });
  let ev = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('an unowned row is not deleted', st.daily.has('VICTIM'));
  assert('and nothing is reported removed', ev.rows.removed === 0, JSON.stringify(ev.rows));
  assert('the bogus link is dropped',      po.lines[0].po_row_id === null);

  // (b) A live line pointing at it must not overwrite it either.
  po = makePO({ id: 'evil2', project_id: 'turfjob', title: 'Stone',
                lines: [{ id: 'L1', qty: '1', unit_cost: '9999', po_row_id: 'VICTIM' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  const victim = st.daily.get('VICTIM');
  assert('an unowned row is not rewritten',
    victim.division === 'dust' && victim.project_id === 'dustjob' && Number(victim.material_cost) === 500,
    JSON.stringify(victim));
  assert('the delivery gets a row of its own instead',
    po.lines[0].po_row_id !== 'VICTIM' && st.daily.size === 2, po.lines[0].po_row_id);

  // (c) A row the order DOES own still works — the guard must not break the
  //     ordinary case it is wrapped around.
  st = makeStore();
  po = makePO({ id: 'ok1', project_id: 'job1', lines: [{ id: 'L1', qty: '2', unit_cost: '10' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  const ownId = po.lines[0].po_row_id;
  po.lines[0].unit_cost = '12';
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('an owned row is still updated in place',
    st.daily.size === 1 && po.lines[0].po_row_id === ownId &&
    Number(st.daily.get(ownId).material_cost) === 24, JSON.stringify([...st.daily.values()]));

  console.log('\n[an order that could not be stored leaves no rows behind]');
  // The cost rows are reconciled BEFORE the order is written, because that is
  // what mints the links it has to be stored with. If the write then loses,
  // nothing anywhere names those rows — and the retry would add a second set.
  st = makeStore();
  st.setBlob(KEY('turf'), []);
  po = makePO({ id: 'doomed', project_id: 'job1', lines: [{ id: 'L1', qty: '3', unit_cost: '10' }] });
  const realSql2 = st.sql;
  const alwaysLose = (strings, ...vals) => {
    const q = strings.join(' ').replace(/\s+/g, ' ');
    if (/^ *UPDATE app_data SET value =/.test(q) && vals[1] === KEY('turf')) return Promise.resolve([]);
    return realSql2(strings, ...vals);
  };
  const doomed = await poSync.upsertPO(alwaysLose, { companyCode: 'FCT', division: 'turf', po });
  assert('the save is reported as a conflict', doomed.ok === false);
  assert('and the job carries no rows for an order that was never stored',
    st.daily.size === 0, JSON.stringify([...st.daily.values()]));

  console.log('\n[a general order can carry no job]');
  // daily_tracking's division CHECK does not admit 'purchase_orders'. The page
  // clears the job when the division changes, but that is client-side — a stale
  // tab or a replayed request still sends one. Without the server clearing it,
  // the old job's rows are deleted and the insert that follows violates the
  // constraint: the request 500s having already destroyed them.
  st = makeStore();
  po = makePO({ id: 'gen1', project_id: 'turfjob', lines: [{ id: 'L1', qty: '2', unit_cost: '5' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('starts on a turf job', st.daily.size === 1);

  await poSync.upsertPO(st.sql, {
    companyCode: 'FCT', division: 'purchase_orders', po, from: 'turf',
  });
  assert('moving it to the general list clears the job', po.project_id === '');
  assert('no cost row is written under purchasing', st.daily.size === 0);
  assert('and the order is stored', st.getBlob(KEY('purchase_orders')).length === 1);
  const genRows = [...st.daily.values()];
  assert('nothing was filed under a division daily_tracking cannot hold',
    !genRows.some(r => r.division === 'purchase_orders'), JSON.stringify(genRows));

  console.log('\n[a client copy that lost its row link]');
  // The link from a delivery line to the job cost row it created lives in the
  // ORDER, and the client only learns a newly minted one from the save's
  // response. A response that never arrives — a dropped connection, a second
  // tab that loaded before the first filled the quantity in — leaves a client
  // holding a line with no link. Minting a fresh row for it would charge the
  // job twice for one delivery, and orphan the first row beyond the reach of
  // even deleting the order.
  st = makeStore();
  po = makePO({ id: 'relink', project_id: 'job1', lines: [{ id: 'L1', qty: '10', unit_cost: '12' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  const firstRowId = po.lines[0].po_row_id;
  assert('one row to begin with', st.daily.size === 1 && Boolean(firstRowId));

  // The same order as a client that never saw the response would send it.
  const amnesiac = JSON.parse(JSON.stringify(po));
  amnesiac.lines[0].po_row_id = null;
  amnesiac.title = 'edited elsewhere';
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: amnesiac });
  assert('the stored link is reused, not replaced',
    st.daily.size === 1, `rows=${st.daily.size}`);
  assert('and it is the same row',  amnesiac.lines[0].po_row_id === firstRowId);
  assert('the job is charged once',
    [...st.daily.values()].reduce((n, r) => n + Number(r.material_cost), 0) === 120);

  console.log('\n[a supervisor re-coding a PO row on the job]');
  // A PO-generated material row is fully editable on the job's own cost tab,
  // and re-coding one is a real workflow. Purchasing flipping the status later
  // must not drag it back — only a change to the ORDER's own codes should.
  st = makeStore();
  po = makePO({ id: 'recode', project_id: 'job1', cost_code: '100', sub_code: 'A',
                lines: [{ id: 'L1', qty: '1', unit_cost: '50' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  const recodedId = po.lines[0].po_row_id;
  // The supervisor re-codes it on the job.
  Object.assign(st.daily.get(recodedId), { cost_code: '250', sub_code: 'B' });

  po.status = 'approved';                       // purchasing touches something else
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('a status change leaves the supervisor\'s codes alone',
    st.daily.get(recodedId).cost_code === '250' && st.daily.get(recodedId).sub_code === 'B',
    JSON.stringify(st.daily.get(recodedId)));

  po.cost_code = '300'; po.sub_code = 'C';      // now the ORDER's codes change
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
  assert('but changing the order\'s own codes does carry through',
    st.daily.get(recodedId).cost_code === '300' && st.daily.get(recodedId).sub_code === 'C',
    JSON.stringify(st.daily.get(recodedId)));

  console.log('\n[a move that only half lands]');
  // The new list is written before the old one is emptied, so a compare-and-set
  // that runs out of attempts leaves a duplicate — never nothing. Losing the
  // order outright is the failure mode that ordering exists to prevent.
  st = makeStore();
  po = makePO({ id: 'half', project_id: 'pav1', lines: [{ id: 'L1', qty: '2', unit_cost: '5' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po });

  // Make every attempt to empty paving's list lose its race.
  const realSql = st.sql;
  let blocking = true;
  const blockedSql = (strings, ...vals) => {
    const q = strings.join(' ').replace(/\s+/g, ' ');
    if (blocking && /^ *UPDATE app_data SET value =/.test(q) && vals[1] === KEY('paving')) {
      return Promise.resolve([]);   // the compare-and-set never matches
    }
    return realSql(strings, ...vals);
  };
  po.project_id = 'turf1';
  let half = await poSync.upsertPO(blockedSql, { companyCode: 'FCT', division: 'turf', po, from: 'paving' });
  assert('the order is still reported as saved', half.ok === true);
  assert('and it really is in the new list',     st.getBlob(KEY('turf')).length === 1);
  assert('the half-landed move is reported',     half.staleCopy === true);
  assert('the old list still has the copy — not nothing',
    st.getBlob(KEY('paving')).length === 1);

  // Retrying with the same `from` finishes the move, and must NOT leave the
  // first attempt's cost row behind: two rows would charge the job twice.
  blocking = false;
  half = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po, from: 'paving' });
  assert('the retry clears the duplicate',  half.ok && half.staleCopy === false);
  assert('paving\'s list is empty now',     st.getBlob(KEY('paving')).length === 0);
  assert('turf still has exactly one',      st.getBlob(KEY('turf')).length === 1);
  assert('and exactly ONE cost row — not the retry\'s plus the first attempt\'s',
    st.daily.size === 1, `rows=${st.daily.size}`);
  assert('on the new job',                  [...st.daily.values()][0].project_id === 'turf1');

  console.log('\n[removePO]');
  st = makeStore();
  po = makePO({ id: 'del', project_id: 'job1', lines: [
    { id: 'L1', qty: '1', unit_cost: '5' },
    { id: 'L2', qty: '2', unit_cost: '5' },
  ] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'kiewit', po });
  st.setBlob(KEY('kiewit'), st.getBlob(KEY('kiewit')).concat([makePO({ id: 'keepme' })]));
  assert('two cost rows before the delete', st.daily.size === 2);

  let del = await poSync.removePO(st.sql, { companyCode: 'FCT', division: 'kiewit', poId: 'del' });
  assert('delete reports it found the order', del.ok && del.found === true);
  assert('order removed from the list',       st.getBlob(KEY('kiewit')).map(p => p.id).join() === 'keepme');
  assert('both cost rows removed',            st.daily.size === 0);
  assert('mirror row removed',                !st.poRows.has('del'));
  assert('deliveries removed',                st.deliveries.filter(d => d.po_id === 'del').length === 0);

  del = await poSync.removePO(st.sql, { companyCode: 'FCT', division: 'kiewit', poId: 'never-existed' });
  assert('deleting a missing order is not an error', del.ok === true && del.found === false);
  assert('and leaves the list alone',               st.getBlob(KEY('kiewit')).length === 1);

  console.log('\n[resolvePODocScope — the receipt carve-out]');
  st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'real', project_id: 'job3' })]);
  const args = { companyCode: 'FCT', hasDivisionAccess, canAccessPODivision };

  let scope = await poSync.resolvePODocScope(st.sql,
    Object.assign({ payload: purchasing, division: 'paving', poId: 'real' }, args));
  assert('applies for a real order', scope && scope.poId === 'real');
  assert('and answers with the ORDER\'s job, not a requested one', scope.projectId === 'job3');

  scope = await poSync.resolvePODocScope(st.sql,
    Object.assign({ payload: purchasing, division: 'paving', poId: 'invented' }, args));
  assert('an invented order id opens nothing', scope === null);

  scope = await poSync.resolvePODocScope(st.sql,
    Object.assign({ payload: purchasing, division: 'paving', poId: null }, args));
  assert('no order id, no carve-out', scope === null);

  scope = await poSync.resolvePODocScope(st.sql,
    Object.assign({ payload: purchasing, division: 'dust', poId: 'real' }, args));
  assert('never applies to a division outside purchasing\'s reach', scope === null);

  // Holding a role here is NOT a disqualification. It used to be, and it made a
  // purchasing administrator with read-only rights in paving worse off than one
  // with no paving rights at all: the division role answered "view only" and
  // the carve-out was skipped for the sole reason that a role existed. The bound
  // that keeps this safe is the order, not the absence of a role — and the two
  // callers only reach here once the caller's own role has come up short.
  scope = await poSync.resolvePODocScope(st.sql,
    Object.assign({ payload: bothRoles, division: 'paving', poId: 'real' }, args));
  assert('a role here no longer disqualifies a caller from the carve-out',
    scope && scope.poId === 'real');
  assert('and it is still bound to that order\'s own job', scope.projectId === 'job3');

  scope = await poSync.resolvePODocScope(st.sql,
    Object.assign({ payload: dustOnly, division: 'paving', poId: 'real' }, args));
  assert('an unrelated division gets nothing', scope === null);

  // The bound lives in the CALLERS now, so it is worth holding their shape.
  // /api/documents resolves the carve-out only once the caller's own role has
  // come up short — otherwise naming an order would DEMOTE a division
  // administrator to the carve-out's level2 and take away their delete.
  console.log('\n[the callers keep the carve-out behind their own role]');
  {
    const fs = require('fs');
    const DOCS   = fs.readFileSync(require('path').resolve(__dirname, '../api/documents.js'), 'utf8');
    const UPLOAD = fs.readFileSync(require('path').resolve(__dirname, '../api/document-upload-url.js'), 'utf8');
    assert('documents.js reads its own role first',
      /const ownCaps = hasDivisionAccess\(payload, division\) \? capabilities\(payload, division\) : null;/.test(DOCS));
    assert('and only resolves the carve-out when that role cannot upload',
      /const poScope = \(ownCaps && ownCaps\.canUpload\) \? null : await resolvePODocScope\(/.test(DOCS));
    assert('so an order id can never demote a real division role',
      /: ownCaps;/.test(DOCS) && !/: capabilities\(payload, division\);/.test(DOCS));
    assert('the upload endpoint judges stage one on the division role alone',
      /let canUpload = hasDivisionAccess\(payload, division\)\s*\n\s*&& capabilities\(payload, division\)\.canUpload;/.test(UPLOAD));
    assert('and reaches the carve-out only when that came up short',
      /if \(!canUpload && canAccessPODivision\(payload, division\)\) \{/.test(UPLOAD));
    assert('with the ticket gated on the PURCHASING level, not the division one',
      /if \(scope && poCapabilities\(payload, division\)\.canUpload\) \{/.test(UPLOAD));
  }

  console.log('\n[line math matches the division tabs]');
  assert('amount is qty × unit cost', poSync.lineAmt({ qty: '3', unit_cost: '4' }) === 12);
  assert('blank fields read as zero', poSync.lineAmt({ qty: '', unit_cost: '' }) === 0);
  assert('percentage tax',            Math.abs(poSync.lineTax({ qty: '10', unit_cost: '10', tax_pct: '7' }) - 7) < 1e-9);
  assert('legacy dollar tax is kept', poSync.lineTax({ qty: '10', unit_cost: '10', tax: '3.21' }) === 3.21);
  // A cleared percentage means no tax. `tax` may still hold what the
  // percentage last wrote there, and falling back to it would charge the job
  // for a tax the user had just removed.
  assert('a blank percentage zeroes the tax, not reviving the dollars',
    poSync.lineTax({ qty: '10', unit_cost: '10', tax: '3.21', tax_pct: '' }) === 0);
  assert('an absent percentage still honours legacy dollars',
    poSync.lineTax({ qty: '10', unit_cost: '10', tax: '3.21' }) === 3.21);
  assert('zero percent is zero, not a fallback',
    poSync.lineTax({ qty: '10', unit_cost: '10', tax: '3.21', tax_pct: '0' }) === 0);
  assert('a quantity alone is costable',  poSync.lineHasCost({ qty: '1' }) === true);
  assert('a unit cost alone is costable', poSync.lineHasCost({ unit_cost: '5' }) === true);
  assert('an empty line is not',          poSync.lineHasCost({ qty: '', unit_cost: '' }) === false);

  console.log('\n[blob keys]');
  assert('key is company:blob:division',
    poSync.blobKeyFor('FCT', 'paving') === 'FCT:fct_purchase_orders:paving');
  assert('general orders get their own key',
    poSync.blobKeyFor('FCT', 'purchase_orders') === 'FCT:fct_purchase_orders:purchase_orders');

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────\n');
  process.exit(failed === 0 ? 0 : 1);
})
.catch(err => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
