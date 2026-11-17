#!/usr/bin/env node
'use strict';
/**
 * Central purchasing — access rules and single-order writes.
 *
 * Run: node scripts/test-po-division.js
 *
 * The Purchase Orders division raises orders against turf, paving, kiewit and
 * quarry and stores each one in THAT division's list, so a purchasing user has to
 * reach lists it holds no role in. That is a deliberate hole in the division
 * wall, and these tests pin both halves of it: what it opens, and — far more
 * of them — what it does not.
 *
 * Covered:
 *  - canAccessPODivision / poDivisionsFor: purchasing reaches the four source
 *    divisions and nothing else; a source division gains nothing from it.
 *  - requirePODivision: names its division, 403s outside the carve-out.
 *  - The endpoint guard: the full-list PUT stays behind a real division role,
 *    so purchasing can never wipe a division's list.
 *  - upsertPO: the compare-and-set merge, in-place replacement, a losing
 *    writer's retry, and moving an order between divisions.
 *  - syncPOCostRows: which deliveries become job cost rows, which do not, and
 *    what happens to the rows when an order is re-tied or a line emptied.
 *  - removePO: the order, its deliveries and its cost rows all go.
 *  - editedLineFields: a save takes only the delivery figures its page
 *    changed (settleLineFigures, at the top and again at the write), rewrites
 *    a job row's figures only for those deliveries, and a page that does not
 *    say is stored whole as before. writeTabRows: what a division tab's save
 *    writes to its job rows.
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
  hasDivisionAccess, poCapabilities, PO_SOURCE_DIVISIONS, PO_JOB_DIVISIONS, PO_GENERAL_DIVISION,
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
  // Every job row whose figures a statement actually wrote, in order. A row
  // can come out of a save with the same numbers whether or not the save
  // rewrote them; this tells the two apart.
  const figureWrites = [];
  const FIGURE_COLS = ['date', 'employee', 'units_purchased', 'unit_cost', 'material_cost'];
  // The row an `UPDATE daily_tracking ... WHERE company_code = .. AND division
  // = .. AND project_id = .. AND row_id = .. AND timesheet_entry_id IS NULL`
  // reaches, or null — read off the statement's own WHERE.
  function scopedRow(q, vals) {
    const w = q.match(/WHERE company_code = \$(\d+) AND division = \$(\d+) AND project_id = \$(\d+) AND row_id = \$(\d+) AND timesheet_entry_id IS NULL$/);
    if (!w) throw new Error('daily_tracking UPDATE with a scope this store does not know: ' + q);
    const p = n => vals[Number(n) - 1];
    const r = daily.get(p(w[4]));
    if (!r || r.company_code !== p(w[1]) || r.division !== p(w[2])
        || r.project_id !== p(w[3]) || r.timesheet_entry_id) return null;
    return r;
  }

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

    // The mirror's division, so removePO can tell its own copy from the one a
    // half-landed move left live in another division's list.
    if (/^SELECT division FROM purchase_orders WHERE id =/.test(q)) {
      const row = poRows.get(vals[0]);
      return Promise.resolve(row ? [{ division: row.division }] : []);
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
      // Two statements share this shape: syncPOCostRows' writeRow and
      // writeTabRows' upsert. The VALUES are the same; the conflict arms are
      // not. 'Material' is a literal in the INSERT, so it is NOT one of the
      // parameters — the columns after date shift down by one.
      const [rowId, projectId, companyCode, division, date, employee,
             costCode, subCode, material, supplier, poNum,
             qty, unitCost, cost] = vals;
      const returning = /RETURNING row_id\s*$/.test(q);
      const existing = daily.get(rowId);
      if (existing) {
        // The conflict arm, read off the statement itself rather than off fixed
        // parameter positions: each column is either taken outright
        // (`col = EXCLUDED.col`), taken only when its CASE's parameter is true
        // (`col = CASE WHEN $n THEN EXCLUDED.col ELSE daily_tracking.col END` —
        // the codes on codesChanged, the figures on writeRow's withFigures), or
        // not set at all. A column the arm leaves out keeps the row's value.
        const arm = q.split('ON CONFLICT (row_id) DO UPDATE SET')[1];
        if (!arm) throw new Error('INSERT INTO daily_tracking without the conflict arm this store knows: ' + q);
        const scope = arm.match(/WHERE daily_tracking\.company_code = \$(\d+) AND daily_tracking\.division = \$(\d+) AND daily_tracking\.project_id = \$(\d+) AND daily_tracking\.timesheet_entry_id IS NULL/);
        if (!scope) throw new Error('daily_tracking upsert with a conflict scope this store does not know: ' + q);
        const p = n => vals[Number(n) - 1];
        // The conflict arm's WHERE: this company, this division, this job, never
        // a payroll-injected row. A row it excludes is neither updated nor
        // inserted over — the conflict still happened — and RETURNING is empty.
        if (existing.company_code !== p(scope[1]) || existing.division !== p(scope[2])
            || existing.project_id !== p(scope[3]) || existing.timesheet_entry_id) {
          return Promise.resolve([]);
        }
        const EXCLUDED = {
          project_id: projectId, division, date, employee,
          cost_code: costCode, sub_code: subCode, material, supplier, po_num: poNum,
          units_purchased: qty, unit_cost: unitCost, material_cost: cost,
        };
        const takes = col => {
          const when = arm.match(new RegExp(`\\b${col} = CASE WHEN \\$(\\d+) THEN EXCLUDED\\.${col} ELSE daily_tracking\\.${col} END`));
          if (when) return Boolean(p(when[1]));
          return new RegExp(`\\b${col} = EXCLUDED\\.${col}\\b`).test(arm);
        };
        let figures = false;
        for (const col of Object.keys(EXCLUDED)) {
          if (!takes(col)) continue;
          existing[col] = EXCLUDED[col];
          if (FIGURE_COLS.includes(col)) figures = true;
        }
        if (figures) figureWrites.push(rowId);
        return Promise.resolve(returning ? [{ row_id: rowId }] : []);
      }
      daily.set(rowId, {
        row_id: rowId, project_id: projectId, company_code: companyCode, division,
        date, field_type: 'Material', employee,
        cost_code: costCode, sub_code: subCode,
        material, supplier, po_num: poNum,
        units_purchased: qty, unit_cost: unitCost, material_cost: cost,
      });
      figureWrites.push(rowId);
      return Promise.resolve(returning ? [{ row_id: rowId }] : []);
    }
    // ── daily_tracking, as the Daily Tracking derivation reads and writes it ──
    if (/^SELECT row_id, project_id, date, employee, cost_code, sub_code, po_num/.test(q)) {
      const [companyCode, division, ids, projects] = vals;
      const out = [];
      for (const r of daily.values()) {
        if (r.company_code !== companyCode || r.division !== division) continue;
        if (ids.includes(r.row_id) || (projects.includes(r.project_id) && String(r.po_num || '').trim())) {
          out.push({ timesheet_entry_id: null, ...r });
        }
      }
      return Promise.resolve(out);
    }
    // writeTabRows: a delivery the tab emptied leaves its row at zero. Matched
    // before writeDailyRows' figure write below, which opens the same way but
    // binds real figures.
    if (/^UPDATE daily_tracking SET units_purchased = 0, unit_cost = 0, material_cost = 0, date = COALESCE\(\$1::date, daily_tracking\.date\), employee = \$2,/.test(q)) {
      const r = scopedRow(q, vals);
      if (r) {
        Object.assign(r, { units_purchased: 0, unit_cost: 0, material_cost: 0, employee: vals[1] });
        if (vals[0]) r.date = vals[0];
        figureWrites.push(r.row_id);
      }
      return Promise.resolve([]);
    }
    // writeDailyRows: purchasing's figures for a Daily Tracking delivery.
    if (/^UPDATE daily_tracking SET units_purchased = \$1, unit_cost = \$2, material_cost = \$3,/.test(q)) {
      const [qty, unitCost, cost, date, employee, poNum] = vals;
      const r = scopedRow(q, vals);
      if (r) {
        Object.assign(r, { units_purchased: qty, unit_cost: unitCost, material_cost: cost, employee, po_num: poNum });
        if (date) r.date = date;
        figureWrites.push(r.row_id);
      }
      return Promise.resolve([]);
    }
    // writeTabRows: the order's title, supplier and number on a row it raised,
    // and its codes only when the CASE's parameter says the codes changed.
    if (/^UPDATE daily_tracking SET material = /.test(q)) {
      const m = q.match(/^UPDATE daily_tracking SET material = \$(\d+), supplier = \$(\d+), po_num = \$(\d+), cost_code = CASE WHEN \$(\d+) THEN \$(\d+) ELSE cost_code END, sub_code = CASE WHEN \$(\d+) THEN \$(\d+) ELSE sub_code END, updated_at = NOW\(\) WHERE/);
      if (!m) throw new Error('header UPDATE of daily_tracking this store does not know: ' + q);
      const p = n => vals[Number(n) - 1];
      const r = scopedRow(q, vals);
      if (r) {
        Object.assign(r, { material: p(m[1]), supplier: p(m[2]), po_num: p(m[3]) });
        if (p(m[4])) r.cost_code = p(m[5]);
        if (p(m[6])) r.sub_code  = p(m[7]);
      }
      return Promise.resolve([]);
    }
    if (/^UPDATE daily_tracking SET po_num =/.test(q)) {
      const [poNum, companyCode, division, projectId, rowId] = vals;
      const r = daily.get(rowId);
      if (r && r.company_code === companyCode && r.division === division
          && r.project_id === projectId && !r.timesheet_entry_id) r.po_num = poNum;
      return Promise.resolve([]);
    }
    if (/^SELECT 1 FROM document_links/.test(q)) return Promise.resolve([]);

    return Promise.resolve([]);
  }

  return {
    sql, appData, poRows, deliveries, daily, log, figureWrites,
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
assert('purchasing reaches quarry',                canAccessPODivision(purchasing, 'quarry') === true);
assert('which is a source division without jobs',
  PO_SOURCE_DIVISIONS.includes('quarry') && !PO_JOB_DIVISIONS.includes('quarry'));
assert('every job division is a source division',
  PO_JOB_DIVISIONS.every(d => PO_SOURCE_DIVISIONS.includes(d)));
assert('purchasing does NOT reach quarry sales',  canAccessPODivision(purchasing, 'quarry_sales') === false);
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
assert('purchasing sees all five lists',
  JSON.stringify(poDivisionsFor(purchasing)) === JSON.stringify(['turf','paving','kiewit','quarry','purchase_orders']));
assert('paving user sees only paving',
  JSON.stringify(poDivisionsFor(pavingOnly)) === JSON.stringify(['paving']));
assert('dust user sees none', poDivisionsFor(dustOnly).length === 0);

// ════════════════════════════════════════════════════════════════════════════
function fakeRes() {
  const r = { code: null, body: null };
  r.status = c => { r.code = c; return r; };
  r.json   = b => { r.body = b; return r; };
  return r;
}
// requirePODivision calls requireAuth, which wants a Bearer token and then
// reads the account behind it. Both are stood in for rather than minting a real
// JWT — the token path is already covered by test-division-isolation.js — and
// the account read answers with the roles each fixture holds, since the payload
// the guard judges is built from that row.
function accountSql(payload) {
  return strings => (/FROM\s+users\s+u\s+JOIN\s+companies/.test(strings.join('?'))
    ? Promise.resolve([{
        division_roles: payload.divisionRoles || null, divisions: null, role: 'level1',
        is_platform_admin: Boolean(payload.isPlatformAdmin),
        company_code: payload.companyCode, allowed_divisions: null,
      }])
    : Promise.reject(new Error('unexpected query from the guard')));
}
async function guardWith(payload, query) {
  const res = fakeRes();
  const req = { query: query || {}, body: null, headers: { authorization: 'Bearer x' } };
  const jwtLib   = require('jsonwebtoken');
  const neonPath = require.resolve('@neondatabase/serverless');
  const origVerify = jwtLib.verify;
  const origNeon   = require.cache[neonPath];
  jwtLib.verify = () => ({ userId: 1, ...payload });
  require.cache[neonPath] = {
    id: neonPath, filename: neonPath, loaded: true,
    exports: { neon: () => accountSql(payload) },
  };
  try { return { out: await requirePODivision(req, res), res }; }
  finally {
    jwtLib.verify = origVerify;
    if (origNeon) require.cache[neonPath] = origNeon;
    else delete require.cache[neonPath];
  }
}

// Awaited from the async runner below: requirePODivision is async now, and an
// un-awaited promise is truthy — it would read as a pass.
async function guardChecks() {
  console.log('\n[requirePODivision]');
  let g = await guardWith(purchasing, { division: 'paving' });
  assert('purchasing passes for paving', g.out && g.out.division === 'paving');

  g = await guardWith(purchasing, { division: 'dust' });
  assert('purchasing 403s for dust', g.out === null && g.res.code === 403);
  assert('the 403 names no division',
    g.res.body && !/dust/i.test(JSON.stringify(g.res.body)));

  g = await guardWith(purchasing, {});
  assert('a missing division is 400, not a turf default', g.out === null && g.res.code === 400);

  g = await guardWith(purchasing, { division: 'nonsense' });
  assert('an unknown division is 400', g.out === null && g.res.code === 400);

  g = await guardWith(pavingOnly, { division: 'turf' });
  assert('paving user 403s for turf', g.out === null && g.res.code === 403);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[endpoint guard — the full-list PUT stays shut]');
// The PUT replaces a division's entire list. Purchasing must never reach it,
// or one call could erase everything paving's own tab had saved.
(function () {
  const endpointPath = path.resolve(__dirname, '../api/purchase-orders.js');
  const src = require('fs').readFileSync(endpointPath, 'utf8');
  assert('PUT is routed to requireDivision',
    /if \(req\.method === 'PUT'\) return await requireDivision\(req, res\);/.test(src));
  assert('everything else resolves through canAccessPODivision',
    /canAccessPODivision\(payload, division\)/.test(src));
  assert('POST exists for single-order upsert', /req\.method === 'POST'/.test(src));
  assert('DELETE exists for single-order removal', /req\.method === 'DELETE'/.test(src));
})();

// ════════════════════════════════════════════════════════════════════════════
(async function () {
  await guardChecks();

  console.log('\n[upsertPO — merging into a division list]');
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

  // ...and the same one level down, which the order-level merge did not cover.
  // upsertPO merges unseen deliveries from the list it read at the TOP of the
  // call, then spends several round trips reconciling cost rows. A delivery
  // recorded inside that window — or, on a lost race, between the retry's
  // re-read and its write — was not in that snapshot, so replacing the order
  // wholesale dropped it: gone from the stored order, gone from po_deliveries,
  // and its daily_tracking row left with nothing naming it. Not even deleting
  // the order finds such a row, because removePO reads the ids off the lines.
  st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'p1', project_id: 'job1', lines: [{ id: 'L1', qty: '1', unit_cost: '100' }] })]);
  st.onNextWrite(() => {
    // The supervisor's tab records a second delivery, with the cost row it
    // minted, while our save is mid-flight.
    st.setBlob(KEY('paving'), [makePO({ id: 'p1', project_id: 'job1', lines: [
      { id: 'L1', qty: '1', unit_cost: '100' },
      { id: 'L2', qty: '1', unit_cost: '50', po_row_id: 'their-row' },
    ] })]);
  });
  r = await poSync.upsertPO(st.sql, {
    companyCode: 'FCT', division: 'paving',
    po: makePO({ id: 'p1', project_id: 'job1', title: 'retitled by us',
                 lines: [{ id: 'L1', qty: '1', unit_cost: '100' }] }),
  });
  let stored = st.getBlob(KEY('paving')).find(p => p.id === 'p1');
  let lineIds = (stored.lines || []).map(l => l.id);
  assert('a delivery recorded inside the write window survives',
    lineIds.includes('L2'), JSON.stringify(lineIds));
  assert('and ours is still there',            lineIds.includes('L1'), JSON.stringify(lineIds));
  assert('and our own edit landed',            stored.title === 'retitled by us');
  // Its row is live and correct for that delivery; clearing the link would
  // orphan it rather than fix anything.
  assert('the row the other writer minted is still named',
    (stored.lines.find(l => l.id === 'L2') || {}).po_row_id === 'their-row',
    JSON.stringify(stored.lines));
  assert('and the caller is told, rather than carrying on with a short list',
    r.mergedLines === 1, String(r.mergedLines));

  // ...but when the save MOVED the order, the late line's link has to go.
  // writeRow's ON CONFLICT predicate pins project_id and division, so a row on
  // the OLD job can never be re-pointed at the new one — the UPDATE matches
  // nothing and the next save mints a SECOND row, leaving both jobs charged for
  // the one delivery. The stale row goes out with the rest of the move's.
  st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'mv2', project_id: 'job1', cost_code: '420', sub_code: 'Base',
    lines: [{ id: 'L1', qty: '1', unit_cost: '100' }] })]);
  st.onNextWrite(() => {
    const cur = st.getBlob(KEY('paving'));
    st.daily.set('old-job-row', { row_id: 'old-job-row', project_id: 'job1', company_code: 'FCT' });
    st.setBlob(KEY('paving'), cur.map(p => p.id !== 'mv2' ? p : Object.assign({}, p, {
      lines: (p.lines || []).concat([{ id: 'L2', qty: '1', unit_cost: '50', po_row_id: 'old-job-row' }]),
    })));
  });
  // The same order, re-tied to a different job.
  r = await poSync.upsertPO(st.sql, {
    companyCode: 'FCT', division: 'paving',
    po: makePO({ id: 'mv2', project_id: 'job2', cost_code: '430', sub_code: 'Sub',
                 lines: [{ id: 'L1', qty: '1', unit_cost: '100' }] }),
  });
  stored = st.getBlob(KEY('paving')).find(p => p.id === 'mv2');
  const lateLine = (stored.lines || []).find(l => l.id === 'L2');
  assert('a delivery recorded during a move still survives it', Boolean(lateLine),
    JSON.stringify(stored.lines));
  assert('but its link to the old job is cleared, not carried over',
    Boolean(lateLine) && !lateLine.po_row_id, JSON.stringify(lateLine));
  assert('and the row it named on the old job goes with the move',
    !st.daily.has('old-job-row'), JSON.stringify([...st.daily.keys()]));

  // A delivery the caller DECLARED deleted is still deleted, race or no race.
  st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'p2', project_id: 'job1', lines: [{ id: 'L1' }, { id: 'L2' }] })]);
  st.onNextWrite(() => {
    st.setBlob(KEY('paving'), [makePO({ id: 'p2', project_id: 'job1', lines: [{ id: 'L1' }, { id: 'L2' }] })]);
  });
  r = await poSync.upsertPO(st.sql, {
    companyCode: 'FCT', division: 'paving',
    po: makePO({ id: 'p2', project_id: 'job1', lines: [{ id: 'L1' }] }),
    deletedLineIds: ['L2'],
  });
  stored = st.getBlob(KEY('paving')).find(p => p.id === 'p2');
  assert('a declared deletion is not undone by the late merge',
    (stored.lines || []).map(l => l.id).join(',') === 'L1',
    JSON.stringify(stored.lines));
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
  assert('quantity copied',                Number(row.units_purchased) === 10);
  // 10 × 2.50 = 25.00, plus 6% tax = 26.50. The job is charged the tax too,
  // which is what the division tabs do.
  assert('material cost includes the tax', Math.abs(Number(row.material_cost) - 26.5) < 0.001);
  // …and so does the unit cost, or the row reads 10 × $2.50 = $26.50 and the
  // cost tab drops the tax the next time either figure is edited there.
  assert('unit cost includes the tax',     Number(row.unit_cost) === 2.65, row.unit_cost);
  assert('units × unit cost is the material cost',
    Math.abs(Number(row.units_purchased) * Number(row.unit_cost) - Number(row.material_cost)) < 0.001);
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

  console.log('\n[a quarry order carries no job]');
  // Quarry is a source division with no projects, and daily_tracking's CHECK
  // does not admit it. A job sent with a quarry order — a stale tab, a replayed
  // request — must be cleared, not charged.
  st = makeStore();
  po = makePO({ id: 'q1', project_id: 'nojob', lines: [{ id: 'L1', qty: '4', unit_cost: '25' }] });
  const qRes = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'quarry', po });
  assert('the quarry order is stored', qRes.ok === true && st.getBlob(KEY('quarry')).length === 1);
  assert('with its job cleared', po.project_id === '' && st.getBlob(KEY('quarry'))[0].project_id === '');
  assert('and no cost row written', st.daily.size === 0, JSON.stringify([...st.daily.values()]));

  // Moved there from a paving job: the job's rows go, and none come back.
  st = makeStore();
  po = makePO({ id: 'q2', project_id: 'pav1', lines: [{ id: 'L1', qty: '2', unit_cost: '5' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po });
  assert('starts on a paving job', st.daily.size === 1);
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'quarry', po, from: 'paving' });
  assert('moving it to quarry takes its cost off the paving job', st.daily.size === 0,
    JSON.stringify([...st.daily.values()]));
  assert('and it lives in quarry\'s list alone',
    st.getBlob(KEY('quarry')).length === 1 && st.getBlob(KEY('paving')).length === 0);

  // A quarry order can never own a cost row, so a link it arrives with points
  // at somebody else's. Stored, it would count as owned on the next save — and
  // emptying the line would delete that row by id, on whatever job it is.
  st = makeStore();
  st.daily.set('PAVROW', {
    row_id: 'PAVROW', project_id: 'pav1', company_code: 'FCT', division: 'paving',
    material: 'Paving\'s own row', material_cost: 750,
  });
  po = makePO({ id: 'q3', lines: [{ id: 'L1', qty: '1', unit_cost: '50', po_row_id: 'PAVROW' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'quarry', po });
  assert('a link a quarry order arrives with is not stored',
    po.lines[0].po_row_id === null && st.getBlob(KEY('quarry'))[0].lines[0].po_row_id === null,
    JSON.stringify(st.getBlob(KEY('quarry'))[0].lines[0]));
  po = makePO({ id: 'q3', lines: [{ id: 'L1', qty: '', unit_cost: '', po_row_id: 'PAVROW' }] });
  const qEmpty = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'quarry', po });
  assert('so emptying the line later cannot delete paving\'s row', st.daily.has('PAVROW'),
    JSON.stringify(qEmpty.rows));
  po = makePO({ id: 'q4', lines: [{ id: 'L1', qty: '1', unit_cost: '50' }] });
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'quarry', po });
  await poSync.removePO(st.sql, { companyCode: 'FCT', division: 'quarry', poId: 'q3' });
  assert('nor can deleting the order', st.daily.has('PAVROW'));

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

  // ══════════════════════════════════════════════════════════════════════
  // Deliveries recorded from Daily Tracking
  // ══════════════════════════════════════════════════════════════════════
  // A job row that names one of its job's orders and carries material is a
  // delivery on that order — a line tagged source:'daily', which the server
  // alone derives from the rows. These pin that it is recorded, follows its
  // row, moves and leaves with it, survives no stale copy, and that nothing
  // done to an order ever mints, sweeps or re-codes the field's row.
  const dRow = (id, over) => Object.assign({
    row_id: id, project_id: 'job1', company_code: 'FCT', division: 'turf',
    date: '2026-11-02', field_type: 'Material', employee: 'Sam',
    cost_code: '02-100', sub_code: '0420', material: '57 stone', supplier: 'Quarry Co',
    po_num: 'PO-0001', units_purchased: 20, unit_cost: 16, material_cost: 320, timesheet_entry_id: null,
  }, over || {});
  const lineOf = (st2, div, poId, lineId) => {
    const o = (st2.getBlob(KEY(div)) || []).find(p => p && p.id === poId);
    return o ? (o.lines || []).find(l => l && l.id === lineId) || null : null;
  };
  const linesOf = (st2, div, poId) => {
    const o = (st2.getBlob(KEY(div)) || []).find(p => p && p.id === poId);
    return o ? (o.lines || []).map(l => l.id).join() : '(no order)';
  };

  console.log('\n[Daily Tracking: the figures a row gives its line]');
  {
    const f = (row, line) => poSync.lineFiguresFromRow(row, line || {});
    assert('quantity and unit cost as the row has them',
      JSON.stringify(f(dRow('a'))) === JSON.stringify({ qty: '20', unit_cost: '16' }), JSON.stringify(f(dRow('a'))));
    assert('an imported total is reached to the cent',
      f(dRow('a', { units_purchased: 10, unit_cost: 15, material_cost: 160 })).unit_cost === '16');
    assert('a lump sum is one unit at the total',
      JSON.stringify(f(dRow('a', { units_purchased: 0, unit_cost: 0, material_cost: 500 }))) === JSON.stringify({ qty: '1', unit_cost: '500' }));
    assert('a quantity with no price yet is recorded unpriced',
      JSON.stringify(f(dRow('a', { unit_cost: 0, material_cost: 0 }))) === JSON.stringify({ qty: '20', unit_cost: '' }));
    assert('a copied row not yet charged records nothing', f(dRow('a', { material_cost: 0 })) === null);
    assert('nor does a row with no material', f(dRow('a', { units_purchased: 0, unit_cost: 0, material_cost: 0 })) === null);
    assert('a percentage tax comes back out of the row\'s unit cost',
      f(dRow('a', { units_purchased: 10, unit_cost: 17.04, material_cost: 170.4 }), { tax_pct: '6.5' }).unit_cost === '16');
    const legacy = { tax: '9.6' };   // no tax_pct key: a flat dollar tax
    const lf = f(dRow('a', { units_purchased: 12, unit_cost: 16.96, material_cost: 203.52 }), legacy);
    assert('a flat tax is spread back out of it',
      Math.abs(poSync.lineAmt({ qty: lf.qty, unit_cost: lf.unit_cost }) + 9.6 - 203.52) < 0.005, JSON.stringify(lf));
    const big = f(dRow('a', { units_purchased: 1000, unit_cost: 1, material_cost: 1234.5678 }));
    assert('a large quantity keeps the places it needs to reach the row\'s money',
      Math.abs(poSync.lineAmt({ qty: big.qty, unit_cost: big.unit_cost }) - 1234.5678) < 0.005, JSON.stringify(big));
    assert('payroll\'s rows are never deliveries',
      !poSync.rowIsDelivery(dRow('a', { timesheet_entry_id: 7 })) && !poSync.rowIsDelivery(dRow('ts9-1-0-x')));
  }

  console.log('\n[Daily Tracking: a row write carries to the order it names]');
  {
    st = makeStore();
    const A = makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1' });
    const B = makePO({ id: 'B', po_number: 'PO-0002', project_id: 'job1' });
    st.setBlob(KEY('turf'), [A, B]);
    st.daily.set('r1', dRow('r1'));
    let out = await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    const l1 = lineOf(st, 'turf', 'A', 'dr-r1');
    assert('the row is recorded on its order', Boolean(l1) && l1.source === 'daily' && l1.po_row_id === 'r1', linesOf(st, 'turf', 'A'));
    assert('  with its quantity, unit cost, date and receiver',
      l1 && l1.qty === '20' && l1.unit_cost === '16' && l1.date === '2026-11-02' && l1.employee === 'Sam', JSON.stringify(l1));
    assert('  and its own codes', l1 && l1.cost_code === '02-100' && l1.sub_code === '0420');
    assert('the changed order comes back for the page', out.ok && out.orders.length === 1 && out.orders[0].id === 'A');
    assert('and its mirror carries the delivery', st.deliveries.some(d => d.po_id === 'A' && d.line_id === 'dr-r1'));
    assert('the order\'s own header is untouched',
      (st.getBlob(KEY('turf')).find(p => p.id === 'A').cost_code || '') === '');
    out = await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    assert('a second sync changes nothing', out.orders.length === 0);

    Object.assign(st.daily.get('r1'), { units_purchased: 25, material_cost: 400 });
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    assert('a new quantity follows', lineOf(st, 'turf', 'A', 'dr-r1').qty === '25');

    // purchasing typed an invoice # on it; then the foreman re-points the row.
    const blob = st.getBlob(KEY('turf'));
    blob.find(p => p.id === 'A').lines[0].invoice_num = 'T-118';
    st.setBlob(KEY('turf'), blob);
    st.daily.get('r1').po_num = 'PO-0002';
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    assert('a changed PO # moves the delivery', linesOf(st, 'turf', 'A') === '' && linesOf(st, 'turf', 'B') === 'dr-r1');
    assert('  with its invoice #', lineOf(st, 'turf', 'B', 'dr-r1').invoice_num === 'T-118');
    st.daily.get('r1').po_num = '';
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    assert('a cleared PO # takes it off', linesOf(st, 'turf', 'B') === '');
    st.daily.get('r1').po_num = 'PO-0001';
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    st.daily.delete('r1');
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: [], deletedIds: ['r1'] });
    assert('a deleted row leaves its order', linesOf(st, 'turf', 'A') === '');

    st.daily.set('rOther', dRow('rOther', { project_id: 'job2' }));
    st.daily.set('rPay',   dRow('rPay',   { timesheet_entry_id: 12 }));
    st.daily.set('rCopy',  dRow('rCopy',  { material_cost: 0 }));
    out = await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['rOther', 'rPay', 'rCopy'] });
    assert('another job\'s row, a payroll row and an uncharged copy are not recorded',
      out.orders.length === 0 && linesOf(st, 'turf', 'A') === '', linesOf(st, 'turf', 'A'));
    out = await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'quarry', rowIds: ['r1'] });
    assert('a division without jobs is never touched', out.ok && out.orders.length === 0);
  }

  console.log('\n[Daily Tracking: a row an order raised follows its row]');
  {
    st = makeStore();
    const L1 = { id: 'L1', qty: '10', unit_cost: '16', tax: '10.4', tax_pct: '6.5', date: '2026-11-02', employee: 'Sam', po_row_id: 'r9' };
    st.setBlob(KEY('turf'), [makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1', lines: [L1] })]);
    st.daily.set('r9', dRow('r9', { units_purchased: 12, unit_cost: 17.04, material_cost: 12 * 17.04 }));
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r9'] });
    const l = lineOf(st, 'turf', 'A', 'L1');
    assert('its new quantity reaches the order', l.qty === '12', JSON.stringify(l));
    assert('  its pre-tax unit cost is untouched', l.unit_cost === '16');
    assert('  and the order comes to the job\'s money',
      Math.abs(poSync.lineAmt(l) + poSync.lineTax(l) - 12 * 17.04) < 0.005, JSON.stringify(l));
    assert('  with no Daily Tracking copy beside it', linesOf(st, 'turf', 'A') === 'L1');
    st.daily.get('r9').po_num = 'PO-0777';
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r9'] });
    assert('its PO # is the order\'s: the line stays put', linesOf(st, 'turf', 'A') === 'L1');
    st.daily.delete('r9');
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: [], deletedIds: ['r9'] });
    const gone = lineOf(st, 'turf', 'A', 'L1');
    assert('deleting the row detaches the line, the delivery kept', gone && gone.po_row_id === null && gone.qty === '12');
  }

  console.log('\n[Daily Tracking: the once-per-load catch-up]');
  {
    st = makeStore();
    st.setBlob(KEY('turf'), [makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1', lines: [
      { id: 'dr-gone', source: 'daily', qty: '1', unit_cost: '1', po_row_id: 'gone' },
      { id: 'L1', qty: '2', unit_cost: '3', po_row_id: 'rRaised' },
    ] })]);
    st.daily.set('r1', dRow('r1'));
    st.daily.set('r2', dRow('r2', { po_num: ' po-0001', units_purchased: 5, unit_cost: 0, material_cost: 0 }));
    st.daily.set('rRaised', dRow('rRaised', { units_purchased: 2, unit_cost: 3, material_cost: 6 }));
    let out = await poSync.reconcileDailyLines(st.sql, { companyCode: 'FCT', division: 'turf' });
    assert('rows entered before are recorded, and a line whose row is gone dropped',
      out.ok && linesOf(st, 'turf', 'A') === 'L1,dr-r1,dr-r2', linesOf(st, 'turf', 'A'));
    assert('  a raised line\'s row is not recorded twice', !lineOf(st, 'turf', 'A', 'dr-rRaised'));
    assert('  and the list comes back for the page', Array.isArray(out.list) && out.changed.join() === 'A');
    out = await poSync.reconcileDailyLines(st.sql, { companyCode: 'FCT', division: 'turf' });
    assert('a second catch-up finds nothing to do', out.ok && out.changed.length === 0);
  }

  console.log('\n[Daily Tracking: a save from a copy a minute behind]');
  {
    st = makeStore();
    st.daily.set('r1', dRow('r1'));
    const A = makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1', cost_code: '100', sub_code: 'A' });
    const B = makePO({ id: 'B', po_number: 'PO-0002', project_id: 'job1' });
    st.setBlob(KEY('turf'), [A, B]);
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    const stale = JSON.parse(JSON.stringify(st.getBlob(KEY('turf')).find(p => p.id === 'A')));   // purchasing's copy

    // The foreman moves the row to PO-0002, and the server moves the line.
    st.daily.get('r1').po_num = 'PO-0002';
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    const rowsBefore = st.daily.size;
    stale.status = 'approved';
    const res = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: stale });
    assert('a stale copy cannot put a moved delivery back', res.ok && linesOf(st, 'turf', 'A') === '', linesOf(st, 'turf', 'A'));
    assert('  it stays on the order its row names', linesOf(st, 'turf', 'B') === 'dr-r1');
    assert('  and no second job row is minted for it', st.daily.size === rowsBefore,
      [...st.daily.keys()].join());
    assert('  nor any INSERT for the field\'s row',
      !st.log.some(q => /^INSERT INTO daily_tracking/.test(q)));
    assert('the status flip itself is saved', st.getBlob(KEY('turf')).find(p => p.id === 'A').status === 'approved');
  }
  {
    st = makeStore();
    st.daily.set('r1', dRow('r1'));
    st.setBlob(KEY('turf'), [makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1', cost_code: '100', sub_code: 'A' })]);
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    const copy = JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0]));
    copy.lines[0].qty = '15';                       // a figure from before the foreman's last edit
    copy.cost_code = '300'; copy.sub_code = 'C';    // and purchasing re-codes the ORDER
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: copy });
    assert('a re-sent figure gives way to the row\'s', lineOf(st, 'turf', 'A', 'dr-r1').qty === '20');
    assert('  and the row is left as the field entered it', st.daily.get('r1').units_purchased === 20);
    assert('re-coding the order does not re-code the field\'s row',
      st.daily.get('r1').cost_code === '02-100' && st.daily.get('r1').sub_code === '0420');

    const edit = JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0]));
    edit.lines[0].qty = '22';
    edit.lines[0].date = '2026-11-03';
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: edit, editedLineIds: ['dr-r1'] });
    assert('a figure purchasing says it edited stands', lineOf(st, 'turf', 'A', 'dr-r1').qty === '22');
    assert('  and reaches the row: quantity, money and date',
      st.daily.get('r1').units_purchased === 22 && st.daily.get('r1').material_cost === 352
      && st.daily.get('r1').date === '2026-11-03', JSON.stringify(st.daily.get('r1')));
    assert('  still without re-coding it', st.daily.get('r1').cost_code === '02-100');
  }

  {
    // The row moved to PO-0002 but its sync never ran (a dropped connection),
    // so the STORED PO-0001 still lists it. A purchasing save of PO-0001 drops
    // it — and the re-read under the compare-and-set, which keeps deliveries
    // other writers added, must not bring it straight back from that copy.
    st = makeStore();
    st.daily.set('r1', dRow('r1', { po_num: 'PO-0002' }));
    st.setBlob(KEY('turf'), [
      makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1', lines: [
        { id: 'dr-r1', source: 'daily', qty: '20', unit_cost: '16', po_row_id: 'r1' }] }),
      makePO({ id: 'B', po_number: 'PO-0002', project_id: 'job1' }),
    ]);
    const copy = JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0]));
    copy.status = 'approved';
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: copy });
    assert('a line whose row moved on is not merged back from the stored copy',
      linesOf(st, 'turf', 'A') === '', linesOf(st, 'turf', 'A'));
  }

  console.log('\n[Daily Tracking: nothing done to an order removes the field\'s row]');
  {
    st = makeStore();
    st.daily.set('r1', dRow('r1'));
    po = makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1', lines: [{ id: 'L1', qty: '2', unit_cost: '5' }] });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    const raisedRow = st.getBlob(KEY('turf'))[0].lines.find(l => l.id === 'L1').po_row_id;
    const del = await poSync.removePO(st.sql, { companyCode: 'FCT', division: 'turf', poId: 'A' });
    assert('deleting the order removes its own delivery\'s row', del.ok && !st.daily.has(raisedRow));
    assert('  but not the Daily Tracking row', st.daily.has('r1') && st.daily.get('r1').po_num === 'PO-0001');
  }
  {
    st = makeStore();
    st.daily.set('r1', dRow('r1'));
    po = makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1', lines: [{ id: 'L1', qty: '2', unit_cost: '5' }] });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po });
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    const moved = JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0]));
    moved.project_id = 'job2';
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: moved });
    assert('re-jobbing the order leaves the Daily Tracking row on its job',
      st.daily.has('r1') && st.daily.get('r1').project_id === 'job1', JSON.stringify(st.daily.get('r1')));
    assert('  and takes the delivery off the order', !lineOf(st, 'turf', 'A', 'dr-r1'), linesOf(st, 'turf', 'A'));
    const L1 = lineOf(st, 'turf', 'A', 'L1');
    assert('  while the order\'s own delivery moves with it as before',
      L1 && st.daily.get(String(L1.po_row_id)) && st.daily.get(String(L1.po_row_id)).project_id === 'job2');
  }
  {
    // Moving the order to another division. Its Daily Tracking line stays
    // behind with its row, and that must not read as a delivery the move lost.
    st = makeStore();
    st.daily.set('r1', dRow('r1'));
    st.setBlob(KEY('turf'), [makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1' })]);
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    const mv = JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0]));
    mv.project_id = 'pav1';
    const res = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po: mv, from: 'turf' });
    assert('a move across divisions completes', res.ok && !res.staleCopy, JSON.stringify(res));
    assert('  the old division no longer lists it', linesOf(st, 'turf', 'A') === '(no order)');
    assert('  the Daily Tracking row stays on its turf job', st.daily.has('r1') && st.daily.get('r1').division === 'turf');
    assert('  and the moved order carries no line for it', linesOf(st, 'paving', 'A') === '');
  }
  {
    // A row sync lands while a purchasing save is in flight. Its new line is
    // kept; it is not mistaken for one the save decided against.
    st = makeStore();
    st.setBlob(KEY('turf'), [makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1' })]);
    const copy = JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0]));
    copy.status = 'approved';
    st.onNextWrite(() => {
      const list = st.getBlob(KEY('turf'));
      list[0].lines = [{ id: 'dr-late', source: 'daily', qty: '1', unit_cost: '4', po_row_id: 'late' }];
      st.setBlob(KEY('turf'), list);
    });
    st.daily.set('late', dRow('late', { units_purchased: 1, unit_cost: 4, material_cost: 4 }));
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: copy });
    assert('a delivery a row sync recorded mid-save survives it', linesOf(st, 'turf', 'A') === 'dr-late', linesOf(st, 'turf', 'A'));
  }

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

  // The old division's own tab still shows the order for the whole of a move —
  // this drop is what removes it — so it can record a delivery against it right
  // up to the last moment. That delivery is on the copy about to be filtered
  // out and on nothing else: it would go from the blob, and from po_deliveries
  // too, because mirrorOnePO has already re-inserted only the new list's lines.
  // Its cost row would then sit on the old job with nothing naming it.
  st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'moving', project_id: 'job1',
    lines: [{ id: 'L1', qty: '1', unit_cost: '100' }] })]);
  st.setBlob(KEY('turf'), []);
  st.onNextWrite(() => {
    // Paving's tab records L2 while the move is in flight.
    st.onNextWrite(() => {
      const cur = st.getBlob(KEY('paving'));
      st.setBlob(KEY('paving'), cur.map(p => p.id !== 'moving' ? p : Object.assign({}, p, {
        lines: (p.lines || []).concat([{ id: 'L2', qty: '1', unit_cost: '250', po_row_id: 'R2' }]),
      })));
      st.daily.set('R2', { row_id: 'R2', project_id: 'job1', company_code: 'FCT' });
    });
  });
  const moveRes = await poSync.upsertPO(st.sql, {
    companyCode: 'FCT', division: 'turf', from: 'paving',
    po: makePO({ id: 'moving', project_id: 'turf1',
                 lines: [{ id: 'L1', qty: '1', unit_cost: '100' }] }),
  });
  assert('the move still reports saved',        moveRes.ok === true);
  assert('and the order really is in turf',     st.getBlob(KEY('turf')).some(p => p.id === 'moving'));
  const leftovers = st.getBlob(KEY('paving')) || [];
  const leftCopy  = leftovers.find(p => p.id === 'moving');
  assert('the old copy is left rather than dropped over a delivery it holds',
    Boolean(leftCopy), JSON.stringify(leftovers));
  assert('...which still carries that delivery',
    Boolean(leftCopy) && (leftCopy.lines || []).some(l => l.id === 'L2'),
    JSON.stringify(leftCopy && leftCopy.lines));
  assert('and the caller is told, so its next save repeats the move',
    moveRes.staleCopy === true, JSON.stringify({ staleCopy: moveRes.staleCopy }));
  assert('so the cost row behind it is still named by something',
    st.daily.has('R2'), JSON.stringify([...st.daily.keys()]));
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
  assert('and leaves the list alone',                st.getBlob(KEY('kiewit')).length === 1);

  // The row ids come from the copy the compare-and-set actually removed, not
  // from a snapshot read beforehand. mutatePOBlob re-reads on every attempt, so
  // a delivery recorded in between was absent from the list whose rows get
  // deleted — and its daily_tracking row then outlived the order that named it,
  // charging the job with nothing anywhere pointing at it.
  st = makeStore();
  st.setBlob(KEY('kiewit'), [makePO({ id: 'race', project_id: 'job9', cost_code: '420', sub_code: 'Base',
    lines: [{ id: 'L1', qty: '1', unit_cost: '100' }] })]);
  await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'kiewit',
    po: makePO({ id: 'race', project_id: 'job9', cost_code: '420', sub_code: 'Base',
                 lines: [{ id: 'L1', qty: '1', unit_cost: '100' }] }) });
  assert('one cost row to start with', st.daily.size === 1);
  // Somebody records a second delivery, with its own cost row, between the
  // delete's read and its write.
  st.onNextWrite(() => {
    const cur = st.getBlob(KEY('kiewit'));
    const withLate = cur.map(p => p.id !== 'race' ? p : Object.assign({}, p, {
      lines: (p.lines || []).concat([{ id: 'L2', qty: '1', unit_cost: '50', po_row_id: 'late-row' }]),
    }));
    st.daily.set('late-row', { row_id: 'late-row', project_id: 'job9' });
    st.setBlob(KEY('kiewit'), withLate);
  });
  del = await poSync.removePO(st.sql, { companyCode: 'FCT', division: 'kiewit', poId: 'race' });
  assert('the delete still lands',              del.ok === true && del.found === true);
  assert('and takes the cost row of a delivery recorded inside its own window',
    !st.daily.has('late-row'), JSON.stringify([...st.daily.keys()]));
  assert('leaving no cost row behind at all',   st.daily.size === 0, JSON.stringify([...st.daily.keys()]));

  // A half-landed move leaves the order in BOTH lists on purpose. Clearing the
  // leftover copy must not wipe the mirror of the one that is live elsewhere —
  // unmirrorPO scopes on id and company alone, so it would take the live
  // order's row and every delivery row with it.
  st = makeStore();
  st.setBlob(KEY('paving'), [makePO({ id: 'both' })]);   // the leftover copy
  st.setBlob(KEY('turf'),   [makePO({ id: 'both' })]);   // where it really lives
  st.poRows.set('both', { id: 'both', company_code: 'FCT', division: 'turf', po_num: 'PO-0001' });
  st.deliveries.push({ po_id: 'both', line_id: 'L1', po_row_id: null });
  del = await poSync.removePO(st.sql, { companyCode: 'FCT', division: 'paving', poId: 'both' });
  assert('the leftover copy is dropped',        del.ok === true && del.found === true);
  assert('and paving no longer lists it',       (st.getBlob(KEY('paving')) || []).length === 0);
  assert('but the live order keeps its mirror', st.poRows.has('both'));
  assert('and its delivery rows',               st.deliveries.some(d => d.po_id === 'both'));
  assert('while turf still lists it',           st.getBlob(KEY('turf')).some(p => p.id === 'both'));

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
  // The screenshot case: 63.82 t at $16.00 with 6% tax is $1,082.39 — $16.96 a ton.
  assert('unit cost with a percentage tax',
    poSync.lineUnitCostWithTax({ qty: '63.82', unit_cost: '16', tax_pct: '6' }) === 16.96);
  assert('no tax leaves the unit cost alone',
    poSync.lineUnitCostWithTax({ qty: '63.82', unit_cost: '16', tax_pct: '' }) === 16);
  assert('a legacy dollar tax is spread over the quantity',
    poSync.lineUnitCostWithTax({ qty: '10', unit_cost: '10', tax: '3.21' }) === 10.321);
  assert('with no quantity the percentage applies to the price',
    poSync.lineUnitCostWithTax({ qty: '', unit_cost: '20', tax_pct: '6' }) === 21.2);
  assert('rounded to the four places the column stores',
    poSync.lineUnitCostWithTax({ qty: '7', unit_cost: '15.37', tax_pct: '6' }) === 16.2922);
  assert('a quantity alone is costable',  poSync.lineHasCost({ qty: '1' }) === true);
  assert('a unit cost alone is costable', poSync.lineHasCost({ unit_cost: '5' }) === true);
  assert('an empty line is not',          poSync.lineHasCost({ qty: '', unit_cost: '' }) === false);

  console.log('\n[who raised an order, and when]');
  {
    const S = poSync.settleCreationStamp;
    const T = '2026-11-03T14:05:12.345Z';

    // A new order keeps the stamp the page put on it — what is on screen is
    // what gets stored.
    let p = S({ id: 'n1', created_at: T, created_by: 'hudockben' }, null, { username: 'someone-else' });
    assert('a new order keeps the page\'s own stamp',
      p.created_at === T && p.created_by === 'hudockben', JSON.stringify(p));

    // A tab still running the code from before the stamp existed sends none.
    const before = Date.now();
    p = S({ id: 'n2' }, null, { username: 'buyer' });
    const t = Date.parse(p.created_at);
    assert('a new order sent with no stamp gets the signed-in user', p.created_by === 'buyer', JSON.stringify(p));
    assert('  and the server\'s clock, as an ISO time',
      t >= before && t <= Date.now() && p.created_at === new Date(t).toISOString(), p.created_at);

    p = S({ id: 'n3', created_at: 'yesterday-ish', created_by: 'x' }, null, { username: 'buyer' });
    assert('a time that does not read as one is replaced, not stored',
      !isNaN(Date.parse(p.created_at)) && p.created_by === 'x', JSON.stringify(p));
    p = S({ id: 'n4', created_by: '   ' }, null, {});
    assert('no name and nobody signed in leaves created_by off', !('created_by' in p), JSON.stringify(p));
    p = S({ id: 'n5', created_by: '  ' + 'a'.repeat(500) + '  ' }, null, {});
    assert('a name is trimmed and capped', p.created_by.length === 200 && p.created_by[0] === 'a');

    // Already stored: the stored stamp stands, whatever the save says.
    const stored = { id: 's1', created_at: T, created_by: 'hudockben' };
    p = S({ id: 's1', created_by: 'impostor', created_at: '2020-01-01T00:00:00.000Z' }, stored, { username: 'impostor' });
    assert('a save cannot rewrite who raised an order, or when',
      p.created_by === 'hudockben' && p.created_at === T, JSON.stringify(p));
    p = S({ id: 's1', title: 'edited' }, stored, { username: 'buyer' });
    assert('nor drop it by leaving it out', p.created_by === 'hudockben' && p.created_at === T, JSON.stringify(p));

    // Stored before the stamp existed: nobody can claim it afterwards.
    p = S({ id: 'old', created_by: 'buyer', created_at: T }, { id: 'old' }, { username: 'buyer' });
    assert('an order raised before the stamp cannot be claimed by saving it',
      !('created_by' in p) && !('created_at' in p), JSON.stringify(p));
    p = S({ id: 'old', title: 'x' }, { id: 'old' }, { username: 'buyer' });
    assert('  and saving it adds nothing', !('created_by' in p) && !('created_at' in p), JSON.stringify(p));

    // The list form the full-list PUT uses.
    const list = [{ id: 'a' }, { id: 'b', created_by: 'tab', created_at: T }, { id: 'c', created_by: 'forged' }];
    poSync.settleCreationStamps(list, [{ id: 'c', created_by: 'orig', created_at: T }, { id: 'gone' }], { username: 'u' });
    assert('settleCreationStamps: a new order with no stamp gets one',
      list[0].created_by === 'u' && !isNaN(Date.parse(list[0].created_at)), JSON.stringify(list[0]));
    assert('  a new order with one keeps it', list[1].created_by === 'tab' && list[1].created_at === T);
    assert('  a stored order keeps the stored one', list[2].created_by === 'orig' && list[2].created_at === T);
  }
  {
    // Through upsertPO — how the Purchase Orders page saves.
    let st = makeStore();
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po: makePO({ id: 'raised' }), username: 'buyer' });
    let saved = st.getBlob(KEY('paving'))[0];
    assert('upsertPO stamps a new order the page sent unstamped',
      saved.created_by === 'buyer' && !isNaN(Date.parse(saved.created_at)), JSON.stringify(saved));
    const stampedAt = saved.created_at;

    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving',
      po: makePO({ id: 'raised', title: 'Edited' }), username: 'someone' });
    saved = st.getBlob(KEY('paving'))[0];
    assert('a later save by somebody else keeps who raised it',
      saved.created_by === 'buyer' && saved.created_at === stampedAt && saved.title === 'Edited', JSON.stringify(saved));

    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
      po: makePO({ id: 'raised', created_by: 'mover' }), from: 'paving', username: 'mover' });
    saved = (st.getBlob(KEY('turf')) || [])[0] || {};
    assert('moving the order to another division carries its stamp',
      saved.created_by === 'buyer' && saved.created_at === stampedAt, JSON.stringify(saved));

    // Two first saves of one new order — a closing tab's keepalive save racing
    // the ordinary one. Whichever is stored first, its stamp stands.
    st = makeStore();
    st.onNextWrite(() => {
      st.setBlob(KEY('paving'), [makePO({ id: 'twice', created_by: 'first', created_at: '2026-11-03T10:00:00.000Z' })]);
    });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po: makePO({ id: 'twice' }), username: 'second' });
    saved = st.getBlob(KEY('paving')).find(p => p.id === 'twice');
    assert('a first save that loses the race keeps the winner\'s stamp',
      saved.created_by === 'first' && saved.created_at === '2026-11-03T10:00:00.000Z', JSON.stringify(saved));
  }
  {
    // The mirror row carries it — and a time that does not read as one is
    // never handed to Postgres to cast, where it would fail the whole save.
    const calls = [];
    const cap = (strings, ...vals) => {
      calls.push({ q: strings.join('$').replace(/\s+/g, ' '), vals });
      return Promise.resolve([]);
    };
    await poSync.mirrorOnePO(cap, 'FCT', 'paving',
      makePO({ id: 'm1', created_by: 'buyer', created_at: '2026-11-03T14:05:12.345Z' }));
    const ins = calls.find(c => /INSERT INTO purchase_orders/.test(c.q));
    assert('the mirror row is written with created_by',
      Boolean(ins) && /created_at, created_by/.test(ins.q) && ins.vals.includes('buyer'), ins && ins.q);
    assert('  and the stamp\'s time', Boolean(ins) && ins.vals.includes('2026-11-03T14:05:12.345Z'));
    calls.length = 0;
    await poSync.mirrorOnePO(cap, 'FCT', 'paving', makePO({ id: 'm2', created_at: 'not a time' }));
    const ins2 = calls.find(c => /INSERT INTO purchase_orders/.test(c.q));
    assert('an unreadable time reaches the mirror as null',
      Boolean(ins2) && !ins2.vals.includes('not a time'), ins2 && JSON.stringify(ins2.vals));
  }

  console.log('\n[a save takes only the fields its page changed]');
  {
    // Two screens loaded PO-0365 while it was blank. One fills it in; the
    // other — its 60s refresh skipped because a field had focus — approves it.
    // The approval carried the whole blank copy and was stored whole: the
    // order came out approved with its title and supplier gone.
    const blank = () => makePO({ id: 'po365', po_number: 'PO-0365', title: '', supplier: '',
                                 project_id: 'job1', cost_code: '100', sub_code: 'A',
                                 lines: [{ id: 'L1', qty: '10', unit_cost: '4' }] });
    const stored = () => st.getBlob(KEY('turf')).find(p => p.id === 'po365');

    st = makeStore();
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: blank(), editedFields: [] });
    const rowId = stored().lines[0].po_row_id;
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
      po: Object.assign(blank(), { title: 'Drain Fabric', supplier: 'Hanes Geo Components',
                                   cost_code: '300', sub_code: 'C' }),
      editedFields: ['title', 'supplier', 'cost_code', 'sub_code'] });

    const approve = Object.assign(blank(), { status: 'approved',
      status_changed_at: '2026-11-16T14:47:00.000Z', status_changed_by: 'hudockben' });
    const res = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: approve,
                                                editedFields: ['status'] });
    assert('approving from a stale copy keeps the title and supplier somebody filled in',
      stored().title === 'Drain Fabric' && stored().supplier === 'Hanes Geo Components', JSON.stringify(stored()));
    assert('  and the code', stored().cost_code === '300' && stored().sub_code === 'C', JSON.stringify(stored()));
    assert('  and is approved, stamped by who approved it',
      stored().status === 'approved' && stored().status_changed_by === 'hudockben'
      && stored().status_changed_at === '2026-11-16T14:47:00.000Z', JSON.stringify(stored()));
    assert('  and the order it answers with is the stored one, for the page to take on',
      res.purchaseOrder.title === 'Drain Fabric' && res.purchaseOrder.status === 'approved',
      JSON.stringify(res.purchaseOrder));
    // codesChanged compares the order with its stored copy: the stale copy's
    // old code read as a re-code and was pushed onto the job's row.
    assert('  and the job\'s cost row keeps the order\'s real code',
      st.daily.get(rowId) && st.daily.get(rowId).cost_code === '300' && st.daily.get(rowId).sub_code === 'C',
      JSON.stringify(st.daily.get(rowId)));
    assert('  and its real supplier', st.daily.get(rowId).supplier === 'Hanes Geo Components',
      JSON.stringify(st.daily.get(rowId)));

    // The other way round: the screen that changed the status had an older
    // status stamp too. Editing the title must not put the old status back.
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
      po: Object.assign(blank(), { title: 'Drain fabric, 12 oz' }), editedFields: ['title'] });
    assert('a title edit from a copy that predates the approval leaves it approved',
      stored().status === 'approved' && stored().status_changed_by === 'hudockben'
      && stored().title === 'Drain fabric, 12 oz' && stored().supplier === 'Hanes Geo Components',
      JSON.stringify(stored()));

    // Clearing a field is an edit like any other.
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
      po: Object.assign(blank(), { notes: '' , supplier: '' }), editedFields: ['supplier'] });
    assert('emptying a field the page changed empties it', stored().supplier === '' && stored().title === 'Drain fabric, 12 oz',
      JSON.stringify(stored()));

    // A page still running the code from before this sends no list at all, and
    // is stored whole, as it always was.
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
      po: Object.assign(blank(), { title: 'Old page' }) });
    assert('a page that says nothing is stored whole, as before',
      stored().title === 'Old page' && stored().status === 'pending', JSON.stringify(stored()));

    // A new order has nothing stored to keep: everything comes from the page.
    st = makeStore();
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', editedFields: [],
      po: makePO({ id: 'fresh', title: 'Geogrid', supplier: 'Tensar', status: 'approved' }) });
    const fresh = st.getBlob(KEY('turf'))[0];
    assert('a new order is stored as the page raised it',
      fresh.title === 'Geogrid' && fresh.supplier === 'Tensar' && fresh.status === 'approved', JSON.stringify(fresh));
  }
  {
    // A move that half landed leaves the order in BOTH lists, and the retry
    // comes from a page whose edits the first attempt already confirmed — it
    // no longer names the job or number it changed. Settled against the old
    // list's copy, the retry would move the order straight back.
    st = makeStore();
    const moving = makePO({ id: 'mv', po_number: 'PO-0009', project_id: 'pav1', title: 'Curb mix',
                            lines: [{ id: 'L1', qty: '2', unit_cost: '5' }] });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'paving', po: moving, editedFields: [] });
    const realSql = st.sql;
    let blocking = true;
    const blockedSql = (strings, ...vals) => {
      const q = strings.join(' ').replace(/\s+/g, ' ');
      if (blocking && /^ *UPDATE app_data SET value =/.test(q) && vals[1] === KEY('paving')) return Promise.resolve([]);
      return realSql(strings, ...vals);
    };
    const moved = Object.assign({}, moving, { project_id: 'turf1', po_number: 'PO-0031' });
    const first = await poSync.upsertPO(blockedSql, { companyCode: 'FCT', division: 'turf', po: moved, from: 'paving',
      editedFields: ['project_id', 'cost_code', 'sub_code', 'po_number'] });
    assert('(the move half lands)', first.ok && first.staleCopy === true);
    blocking = false;
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', from: 'paving',
      po: Object.assign({}, moved, { lines: st.getBlob(KEY('turf'))[0].lines }), editedFields: [] });
    const t = st.getBlob(KEY('turf'))[0];
    assert('the retry finishes the move on the job and number it was moved to',
      t && t.project_id === 'turf1' && t.po_number === 'PO-0031' && st.getBlob(KEY('paving')).length === 0,
      JSON.stringify(t));
  }
  {
    console.log('\n[settleHeaderFields on its own]');
    const s = (po, stored, edited) => ({ kept: poSync.settleHeaderFields(po, stored, edited), po });
    let r = s({ title: 'stale', status: 'approved', status_changed_by: 'me' },
              { title: 'real', status: 'pending', status_changed_by: 'them' }, new Set(['status']));
    assert('a field the page did not change takes the stored value', r.po.title === 'real');
    assert('  one it did change keeps the page\'s, with its byline',
      r.po.status === 'approved' && r.po.status_changed_by === 'me');
    assert('  and it says which it kept', JSON.stringify(r.kept) === '["title"]', JSON.stringify(r.kept));
    r = s({ title: '', notes: null }, { notes: '' }, new Set());
    assert('blank, missing and null are the same nothing — no churn',
      r.kept.length === 0 && r.po.title === '', JSON.stringify(r));
    r = s({ title: 'x', supplier: 'stale' }, { title: 'x' }, new Set());
    assert('a field the stored order never had is dropped, not kept from the copy',
      !('supplier' in r.po) && JSON.stringify(r.kept) === '["supplier"]', JSON.stringify(r));
    r = s({ title: 'x', lines: [1], created_by: 'a', origin: 'purchasing', id: 'z' },
          { title: 'y', lines: [2], created_by: 'b', origin: 'turf', id: 'z' }, new Set());
    assert('lines, the creation stamp and the rest are not this function\'s',
      r.po.lines[0] === 1 && r.po.created_by === 'a' && r.po.origin === 'purchasing' && r.po.title === 'y');
    assert('no stored copy, or no list from the page: left as sent',
      s({ title: 'a' }, null, new Set()).kept.length === 0 && s({ title: 'a' }, { title: 'b' }, null).po.title === 'a');
    assert('editedFieldSet: a list is a set, anything else is "did not say"',
      poSync.editedFieldSet(['title', 7]).has('7') && poSync.editedFieldSet('title') === null
      && poSync.editedFieldSet(undefined) === null);
    const by = poSync.editedFieldsByOrder({ a: ['title'], b: 'nope' });
    assert('editedFieldsByOrder: per order, dropping what is not a list',
      by.get('a').has('title') && !by.has('b') && poSync.editedFieldsByOrder(['a']) === null
      && poSync.editedFieldsByOrder(null) === null);
  }

  // ══════════════════════════════════════════════════════════════════════
  // A delivery's figures: only the keys a page changed
  // ══════════════════════════════════════════════════════════════════════
  // The same staleness one level down. Every screen's copy of a delivery is as
  // old as its last refresh — and the refresh skips while a field has focus —
  // so a save carrying the whole line put back a quantity another screen had
  // corrected, and then wrote that stale figure onto the job's cost row over
  // whatever the supervisor had re-figured there. A page now says which keys of
  // which deliveries it changed (editedLineFields); every other key comes from
  // the stored order, and a job row's figures are rewritten only for a delivery
  // whose figures the save changed.
  const editsOf = o => new Map(Object.entries(o || {}).map(([id, keys]) => [id, new Set(keys)]));
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;

  console.log('\n[a save takes only the delivery figures its page changed]');
  {
    st = makeStore();
    const stored = () => st.getBlob(KEY('turf')).find(p => p.id === 'pf');
    const storedLine = id => (stored().lines || []).find(l => l.id === id);
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', editedFields: [], editedLineFields: {},
      po: makePO({ id: 'pf', po_number: 'PO-0042', project_id: 'job1', cost_code: '100', sub_code: 'A',
                   lines: [{ id: 'L1', date: '2026-11-02', qty: '10', unit_cost: '4', employee: 'Sam' }] }) });
    const rowId = storedLine('L1').po_row_id;
    const row = () => st.daily.get(rowId);
    assert('(a new order\'s delivery still gets its job row, figures and all)',
      Boolean(row()) && row().units_purchased === 10 && near(row().material_cost, 40), JSON.stringify(row()));
    assert('(the store reads writeRow\'s figures CASE off the statement)',
      st.log.some(q => /date = CASE WHEN \$(\d+) THEN EXCLUDED\.date/.test(q)));

    // Two screens hold the order as it is now. The first corrects the quantity.
    const snap = JSON.stringify(stored());
    const staleCopy = () => JSON.parse(snap);
    const fix = staleCopy();
    fix.lines[0].qty = '12';
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: fix,
      editedFields: [], editedLineFields: { L1: ['qty'] } });
    assert('(the correction lands, on the order and on the job row)',
      storedLine('L1').qty === '12' && row().units_purchased === 12 && near(row().material_cost, 48), JSON.stringify(row()));

    // The second — still showing 10 — approves the order.
    const approve = Object.assign(staleCopy(), { status: 'approved', status_changed_by: 'buyer' });
    st.figureWrites.length = 0;
    let res = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: approve,
      editedFields: ['status'], editedLineFields: {} });
    assert('approving from a stale screen keeps the quantity another screen corrected',
      res.ok && storedLine('L1').qty === '12' && stored().status === 'approved', JSON.stringify(stored()));
    assert('  and answers with it, for the page to take on',
      res.purchaseOrder.lines.find(l => l.id === 'L1').qty === '12');
    assert('  the job row still reads the corrected figures',
      row().units_purchased === 12 && near(row().material_cost, 48), JSON.stringify(row()));
    assert('  because the save never wrote the row\'s figures at all — it changed none',
      !st.figureWrites.includes(rowId), JSON.stringify(st.figureWrites));
    assert('  and the delivery keeps its one row', st.daily.size === 1 && storedLine('L1').po_row_id === rowId);

    // Typing the invoice # on that same stale line.
    const inv = staleCopy();
    inv.lines[0].invoice_num = 'INV-7';
    st.figureWrites.length = 0;
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: inv,
      editedFields: [], editedLineFields: { L1: ['invoice_num'] } });
    assert('an invoice # typed on a stale line is taken',
      storedLine('L1').invoice_num === 'INV-7', JSON.stringify(storedLine('L1')));
    assert('  without the stale quantity and cost riding along with it',
      storedLine('L1').qty === '12' && storedLine('L1').unit_cost === '4', JSON.stringify(storedLine('L1')));
    assert('  nor the stale status (the order\'s own fields settle the same way)', stored().status === 'approved');
    assert('  and the invoice # is the order\'s alone: the job row is not written',
      !st.figureWrites.includes(rowId) && row().units_purchased === 12, JSON.stringify(st.figureWrites));

    // The supervisor re-figures the row on the job's own cost tab. Purchasing,
    // still on its old copy, adds a note.
    Object.assign(row(), { units_purchased: 11, unit_cost: 4, material_cost: 44, employee: 'Ana', date: '2026-11-05' });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
      po: Object.assign(staleCopy(), { notes: 'call the yard' }), editedFields: ['notes'], editedLineFields: {} });
    assert('a supervisor\'s re-figured job row survives an unrelated purchasing save',
      row().units_purchased === 11 && near(row().material_cost, 44) && row().unit_cost === 4, JSON.stringify(row()));
    assert('  with the date and receiver they put on it',
      row().employee === 'Ana' && row().date === '2026-11-05', JSON.stringify(row()));
    assert('  while the save itself landed', stored().notes === 'call the yard');
    assert('  and still carried the order\'s own columns to the row',
      row().material === 'Stone' && row().po_num === 'PO-0042', JSON.stringify(row()));

    // The row sync that follows a row write brings the order to the row; then a
    // purchasing save that DOES change the quantity writes it.
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: [rowId] });
    const more = JSON.parse(JSON.stringify(stored()));
    more.lines[0].qty = '13';
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: more,
      editedFields: [], editedLineFields: { L1: ['qty'] } });
    assert('a save that changes a delivery\'s quantity still writes it to the row',
      row().units_purchased === 13 && near(row().material_cost, 52), JSON.stringify(row()));
    assert('  onto the date and receiver the row sync brought to the order',
      row().employee === 'Ana' && row().date === '2026-11-05', JSON.stringify(row()));
  }
  {
    // Two screens correct two different figures of one delivery. A percentage
    // tax follows both.
    st = makeStore();
    const stored = () => st.getBlob(KEY('turf')).find(p => p.id === 'tx');
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', editedFields: [], editedLineFields: {},
      po: makePO({ id: 'tx', project_id: 'job1', lines: [
        { id: 'L1', date: '2026-11-02', qty: '10', unit_cost: '4', tax_pct: '6', tax: '2.4' }] }) });
    const rowId = stored().lines[0].po_row_id;
    const snap = JSON.stringify(stored());

    // Screen X fixes the price; its page re-takes the tax as the user types.
    const x = JSON.parse(snap);
    Object.assign(x.lines[0], { unit_cost: '5', tax: '3' });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: x,
      editedFields: [], editedLineFields: { L1: ['unit_cost'] } });
    // Screen Y, loaded before that, doubles the quantity — its tax on the OLD price.
    const y = JSON.parse(snap);
    Object.assign(y.lines[0], { qty: '20', tax: '4.8' });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: y,
      editedFields: [], editedLineFields: { L1: ['qty'] } });
    const l = stored().lines[0];
    assert('a quantity from one screen and a price from another both survive',
      l.qty === '20' && l.unit_cost === '5', JSON.stringify(l));
    assert('  and the tax is re-taken on the two together, not left on the old price',
      near(l.tax, 6) && l.tax_pct === '6', JSON.stringify(l));
    const r = st.daily.get(rowId);
    assert('  the job row is the new quantity at the stored price, tax included',
      r.units_purchased === 20 && near(r.material_cost, 106) && near(r.unit_cost, 5.3), JSON.stringify(r));
  }
  {
    // A legacy flat-dollar tax (no tax_pct key at all) is a figure like any
    // other: it is not re-taken, and a stale copy cannot change it.
    st = makeStore();
    st.setBlob(KEY('turf'), [makePO({ id: 'lg', project_id: 'job1',
      lines: [{ id: 'L1', qty: '10', unit_cost: '10', tax: '3.21', po_row_id: null }] })]);
    const copy = JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0]));
    Object.assign(copy.lines[0], { qty: '12', tax: '9.99' });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: copy,
      editedFields: [], editedLineFields: { L1: ['qty'] } });
    const l = st.getBlob(KEY('turf'))[0].lines[0];
    assert('a legacy dollar tax keeps its stored figure when the page did not change it',
      l.qty === '12' && l.tax === '3.21' && !('tax_pct' in l), JSON.stringify(l));
    const r = st.daily.get(l.po_row_id);
    assert('  and the row carries those dollars', Boolean(r) && near(r.material_cost, 123.21), JSON.stringify(r));
  }

  console.log('\n[a delivery figure that changed while the save was in flight]');
  {
    // The save reconciles the job rows from the list it read at the top, then
    // writes under the compare-and-set. A row sync landing in between moves a
    // delivery the save did not touch; the write must not put it back.
    st = makeStore();
    const stored = () => st.getBlob(KEY('turf')).find(p => p.id === 'ms');
    const storedLine = id => stored().lines.find(l => l.id === id);
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', editedFields: [], editedLineFields: {},
      po: makePO({ id: 'ms', project_id: 'job1', lines: [
        { id: 'L1', qty: '10', unit_cost: '4' }, { id: 'L2', qty: '5', unit_cost: '3' }] }) });
    const r1 = storedLine('L1').po_row_id, r2 = storedLine('L2').po_row_id;
    const mine = JSON.parse(JSON.stringify(stored()));
    mine.lines.find(l => l.id === 'L2').qty = '6';
    st.onNextWrite(() => {
      // The supervisor re-figures L1's row, and the row sync carries it to the order.
      Object.assign(st.daily.get(r1), { units_purchased: 12, material_cost: 48 });
      const list = st.getBlob(KEY('turf'));
      list.find(p => p.id === 'ms').lines.find(l => l.id === 'L1').qty = '12';
      st.setBlob(KEY('turf'), list);
    });
    const res = await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: mine,
      editedFields: [], editedLineFields: { L2: ['qty'] } });
    assert('the save lands on its retry', res.ok === true);
    assert('a delivery the save did not touch keeps the figure a row sync gave it mid-save',
      storedLine('L1').qty === '12', JSON.stringify(storedLine('L1')));
    assert('  and its row keeps the supervisor\'s figures',
      st.daily.get(r1).units_purchased === 12 && near(st.daily.get(r1).material_cost, 48), JSON.stringify(st.daily.get(r1)));
    assert('  so order and row still agree',
      near(poSync.lineAmt(storedLine('L1')), st.daily.get(r1).material_cost));
    assert('the delivery it did change is stored, and written to its row',
      storedLine('L2').qty === '6' && st.daily.get(r2).units_purchased === 6 && near(st.daily.get(r2).material_cost, 18),
      JSON.stringify(st.daily.get(r2)));
  }
  {
    // The same window, on a delivery the save DID edit. Purchasing changes the
    // quantity; the supervisor re-prices that delivery's row on the job after
    // the save's first read and before it writes the row, and the row sync
    // carries the price to the stored order. The save then writes the row from
    // what it read first. Whatever the merge, the order and the job must come
    // out charging the same money — nothing re-syncs a raised delivery later.
    st = makeStore();
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', editedFields: [], editedLineFields: {},
      po: makePO({ id: 'rp', project_id: 'job1', lines: [{ id: 'L1', qty: '10', unit_cost: '4' }] }) });
    const rowId = st.getBlob(KEY('turf'))[0].lines[0].po_row_id;
    const mine = JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0]));
    mine.lines[0].qty = '12';
    let repriced = false;
    const racing = (strings, ...vals) => {
      if (!repriced && /^\s*INSERT INTO daily_tracking/.test(strings[0])) {
        repriced = true;
        Object.assign(st.daily.get(rowId), { unit_cost: 4.5, material_cost: 45 });
        return poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: [rowId] })
          .then(() => st.sql(strings, ...vals));
      }
      return st.sql(strings, ...vals);
    };
    const res = await poSync.upsertPO(racing, { companyCode: 'FCT', division: 'turf', po: mine,
      editedFields: [], editedLineFields: { L1: ['qty'] } });
    const l = st.getBlob(KEY('turf'))[0].lines[0];
    const r = st.daily.get(rowId);
    assert('(the re-price landed inside the save)', repriced && res.ok);
    assert('an edited delivery re-priced on the job mid-save: order and row still charge the same',
      near(poSync.lineAmt(l) + poSync.lineTax(l), r.material_cost) && near(l.qty, r.units_purchased),
      `order ${l.qty} × ${l.unit_cost} = ${poSync.lineAmt(l)}; row ${r.units_purchased} × ${r.unit_cost} = ${r.material_cost}`);
  }
  {
    // The order's own fields no row carries — status and notes — settle again
    // at the write in the same way.
    st = makeStore();
    st.setBlob(KEY('turf'), [makePO({ id: 'hs', project_id: 'job1', lines: [] })]);
    const copy = Object.assign(JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0])), { title: 'Geogrid' });
    st.onNextWrite(() => {
      const list = st.getBlob(KEY('turf'));
      Object.assign(list[0], { status: 'approved', status_changed_by: 'boss', notes: 'rush' });
      st.setBlob(KEY('turf'), list);
    });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: copy,
      editedFields: ['title'], editedLineFields: {} });
    const s = st.getBlob(KEY('turf'))[0];
    assert('an approval that landed mid-save survives a title edit',
      s.title === 'Geogrid' && s.status === 'approved' && s.status_changed_by === 'boss' && s.notes === 'rush',
      JSON.stringify(s));
  }

  console.log('\n[a page that does not say which figures it changed]');
  {
    // A tab still running the code from before: no editedLineFields at all.
    // Its figures are stored whole and written to the rows, as they always were.
    st = makeStore();
    const stored = () => st.getBlob(KEY('turf')).find(p => p.id === 'old');
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
      po: makePO({ id: 'old', project_id: 'job1', lines: [{ id: 'L1', date: '2026-11-02', qty: '10', unit_cost: '4' }] }) });
    const rowId = stored().lines[0].po_row_id;
    const snap = JSON.stringify(stored());
    const fix = JSON.parse(snap);
    fix.lines[0].qty = '12';
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: fix,
      editedFields: [], editedLineFields: { L1: ['qty'] } });
    Object.assign(st.daily.get(rowId), { units_purchased: 11, material_cost: 44 });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
      po: Object.assign(JSON.parse(snap), { status: 'approved' }) });
    assert('its copy of the delivery is stored whole', stored().lines[0].qty === '10' && stored().status === 'approved',
      JSON.stringify(stored()));
    assert('  and its figures are written over the row\'s',
      st.daily.get(rowId).units_purchased === 10 && near(st.daily.get(rowId).material_cost, 40),
      JSON.stringify(st.daily.get(rowId)));
  }

  console.log('\n[Daily Tracking deliveries: the keys only the order holds]');
  {
    // A Daily Tracking delivery takes its figures from its row on every save —
    // except the invoice # and tax rate, which no row carries. A stale copy
    // used to blank them: the row could not put them back.
    st = makeStore();
    st.daily.set('r1', dRow('r1'));                         // 20 × $16 = $320
    st.setBlob(KEY('turf'), [makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1' })]);
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    const snap = JSON.stringify(st.getBlob(KEY('turf'))[0]);

    const typed = JSON.parse(snap);
    Object.assign(typed.lines[0], { invoice_num: 'T-118', tax_pct: '6', tax: '19.2' });
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: typed,
      editedFields: [], editedLineFields: { 'dr-r1': ['invoice_num', 'tax_pct'] } });
    let l = lineOf(st, 'turf', 'A', 'dr-r1');
    assert('(purchasing\'s invoice # and tax rate land)', l.invoice_num === 'T-118' && l.tax_pct === '6', JSON.stringify(l));
    assert('(and the tax reaches the field\'s row, which charges the job)',
      near(st.daily.get('r1').material_cost, 339.2) && st.daily.get('r1').units_purchased === 20,
      JSON.stringify(st.daily.get('r1')));

    st.figureWrites.length = 0;
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf',
      po: Object.assign(JSON.parse(snap), { status: 'approved' }), editedFields: ['status'], editedLineFields: {} });
    l = lineOf(st, 'turf', 'A', 'dr-r1');
    assert('a stale save keeps a Daily Tracking delivery\'s invoice # and tax rate',
      l.invoice_num === 'T-118' && l.tax_pct === '6' && near(l.tax, 19.2), JSON.stringify(l));
    assert('  its quantity and price still the row\'s', l.qty === '20' && l.unit_cost === '16', JSON.stringify(l));
    assert('  and the field\'s row is left alone',
      !st.figureWrites.includes('r1') && near(st.daily.get('r1').material_cost, 339.2), JSON.stringify(st.daily.get('r1')));
    assert('  while the approval lands', st.getBlob(KEY('turf'))[0].status === 'approved');
  }
  {
    // Purchasing corrects the quantity on a Daily Tracking delivery while the
    // foreman re-dates the row and signs for it. Each keeps what they changed.
    st = makeStore();
    st.daily.set('r1', dRow('r1'));
    st.setBlob(KEY('turf'), [makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1' })]);
    await poSync.syncRowsToOrders(st.sql, { companyCode: 'FCT', division: 'turf', rowIds: ['r1'] });
    const copy = JSON.parse(JSON.stringify(st.getBlob(KEY('turf'))[0]));
    Object.assign(st.daily.get('r1'), { date: '2026-11-04', employee: 'Ana' });   // no sync yet
    copy.lines[0].qty = '22';
    await poSync.upsertPO(st.sql, { companyCode: 'FCT', division: 'turf', po: copy,
      editedFields: [], editedLineFields: { 'dr-r1': ['qty'] } });
    const l = lineOf(st, 'turf', 'A', 'dr-r1');
    assert('the quantity purchasing typed stands on the delivery, at the price it was typed against',
      l.qty === '22' && l.unit_cost === '16', JSON.stringify(l));
    assert('  the keys it did not touch come from the row: the foreman\'s date and name',
      l.date === '2026-11-04' && l.employee === 'Ana', JSON.stringify(l));
    const r = st.daily.get('r1');
    assert('  and the row takes the new quantity without losing them',
      r.units_purchased === 22 && near(r.material_cost, 352) && r.date === '2026-11-04' && r.employee === 'Ana',
      JSON.stringify(r));
    assert('  nor its codes', r.cost_code === '02-100' && r.sub_code === '0420');
  }
  {
    // The same derivation on its own. Per key, and a function per order for
    // the full-list save; it wins over the old whole-line list.
    const row = dRow('r1', { date: '2026-11-04', employee: 'Ana', units_purchased: 25, unit_cost: 16, material_cost: 400 });
    const order = () => makePO({ id: 'A', po_number: 'PO-0001', project_id: 'job1', lines: [
      { id: 'dr-r1', source: 'daily', po_row_id: 'r1', qty: '20', unit_cost: '16', date: '2026-11-02', employee: 'Sam',
        tax_pct: '', tax: '', cost_code: '02-100', sub_code: '0420' }] });
    let o = order();
    poSync.deriveDailyLines([o], [row], { editedLineFields: editsOf({ 'dr-r1': ['date'] }) });
    assert('deriveDailyLines: a date the page changed stands; the money follows the row',
      o.lines[0].date === '2026-11-02' && o.lines[0].qty === '25' && o.lines[0].employee === 'Ana', JSON.stringify(o.lines[0]));
    o = order();
    poSync.deriveDailyLines([o], [row], { editedLineFields: () => editsOf({ 'dr-r1': ['unit_cost'] }) });
    assert('  any money key the page changed keeps all the money; the row supplies the rest',
      o.lines[0].qty === '20' && o.lines[0].unit_cost === '16' && o.lines[0].date === '2026-11-04', JSON.stringify(o.lines[0]));
    o = order();
    poSync.deriveDailyLines([o], [row], { editedLineIds: new Set(['dr-r1']), editedLineFields: editsOf({}) });
    assert('  and a per-key list wins over the whole-line one',
      o.lines[0].qty === '25' && o.lines[0].date === '2026-11-04', JSON.stringify(o.lines[0]));
    o = order();
    poSync.deriveDailyLines([o], [row], { editedLineIds: new Set(['dr-r1']) });
    assert('  which, alone, still keeps the whole line (a page from before)',
      o.lines[0].qty === '20' && o.lines[0].date === '2026-11-02', JSON.stringify(o.lines[0]));
    const line = { qty: '20', unit_cost: '16', date: '2026-11-02', employee: 'Sam' };
    poSync.applyRowToLine(line, row, false, new Set(['employee']));
    assert('applyRowToLine: a kept key is the only one the row does not supply',
      line.employee === 'Sam' && line.qty === '25' && line.date === '2026-11-04', JSON.stringify(line));
  }

  console.log('\n[writeTabRows — a division tab\'s changes to its job rows]');
  {
    // The tabs used to PUT every linked row whole from their own copy of the
    // job. Now they say what they changed, and the server writes exactly that.
    st = makeStore();
    const jobRow = (id, over) => Object.assign({
      row_id: id, project_id: 'job1', company_code: 'FCT', division: 'turf', date: '2026-11-02',
      field_type: 'Material', employee: 'Sam', cost_code: '100', sub_code: 'A',
      material: 'Stone', supplier: 'Acme', po_num: 'PO-0001',
      units_purchased: 10, unit_cost: 4, material_cost: 40, timesheet_entry_id: null,
    }, over || {});
    st.daily.set('R1', jobRow('R1'));
    st.daily.set('R2', jobRow('R2', { cost_code: '250', sub_code: 'B' }));   // re-coded on the job
    st.daily.set('r9', dRow('r9'));                                         // the field's own row
    st.daily.set('Rjob2', jobRow('Rjob2', { project_id: 'job2' }));
    st.daily.set('Rpav', jobRow('Rpav', { division: 'paving' }));
    st.daily.set('ts5-abc-0-x', jobRow('ts5-abc-0-x', { timesheet_entry_id: 5 }));
    const snapOf = id => JSON.stringify(st.daily.get(id));
    const untouched = ['r9', 'Rjob2', 'Rpav', 'ts5-abc-0-x'];
    const before = new Map(untouched.map(id => [id, snapOf(id)]));
    const tabPO = over => makePO(Object.assign({
      id: 'tab', po_number: 'PO-0001', project_id: 'job1', title: 'Gravel', supplier: 'Beta',
      cost_code: '300', sub_code: 'C', lines: [
        { id: 'L1', date: '2026-11-02', qty: '10', unit_cost: '4', employee: 'Sam', po_row_id: 'R1' },
        { id: 'L2', date: '2026-11-02', qty: '10', unit_cost: '4', employee: 'Sam', po_row_id: 'R2' },
        { id: 'dr-r9', source: 'daily', po_row_id: 'r9', qty: '20', unit_cost: '16', date: '2026-11-02', employee: 'Sam',
          tax_pct: '', tax: '', cost_code: '02-100', sub_code: '0420' },
        { id: 'L3', qty: '10', unit_cost: '4', po_row_id: 'Rjob2' },
        { id: 'L4', qty: '10', unit_cost: '4', po_row_id: 'Rpav' },
        { id: 'L5', qty: '10', unit_cost: '4', po_row_id: 'ts5-abc-0-x' },
      ] }, over || {}));
    const W = (po, headerEdits, lineEdits, division) => poSync.writeTabRows(st.sql, {
      companyCode: 'FCT', division: division || 'turf', po,
      headerEdits: new Set(headerEdits || []), lineEdits: editsOf(lineEdits),
      rowsById: new Map([['r9', st.daily.get('r9')]]),
    });

    await W(tabPO(), ['title', 'supplier']);
    let R1 = st.daily.get('R1'), R2 = st.daily.get('R2');
    assert('a retitle reaches every row the order raised',
      R1.material === 'Gravel' && R1.supplier === 'Beta' && R2.material === 'Gravel' && R2.supplier === 'Beta',
      JSON.stringify([R1, R2]));
    assert('  without re-coding them: the codes are not what changed',
      R1.cost_code === '100' && R2.cost_code === '250' && R2.sub_code === 'B', JSON.stringify([R1, R2]));
    assert('  nor touching their figures', R1.units_purchased === 10 && near(R1.material_cost, 40)
      && st.figureWrites.length === 0, JSON.stringify(st.figureWrites));
    assert('  nor the field\'s row, which is not the order\'s', snapOf('r9') === before.get('r9'), snapOf('r9'));

    await W(tabPO(), ['cost_code']);
    R1 = st.daily.get('R1'); R2 = st.daily.get('R2');
    assert('re-coding the order re-codes the rows it raised, the supervisor\'s re-code included',
      R1.cost_code === '300' && R1.sub_code === 'C' && R2.cost_code === '300' && R2.sub_code === 'C',
      JSON.stringify([R1, R2]));
    assert('  but never the field\'s row', st.daily.get('r9').cost_code === '02-100');

    Object.assign(st.daily.get('R2'), { cost_code: '250', sub_code: 'B' });   // the supervisor re-codes again
    const fig = tabPO();
    Object.assign(fig.lines[0], { qty: '12', employee: 'Ana', date: '2026-11-06' });
    st.figureWrites.length = 0;
    await W(fig, [], { L1: ['qty', 'employee', 'date'] });
    R1 = st.daily.get('R1');
    assert('a figure the tab changed is written to its row from the line',
      R1.units_purchased === 12 && near(R1.material_cost, 48) && R1.unit_cost === 4
      && R1.employee === 'Ana' && R1.date === '2026-11-06', JSON.stringify(R1));
    assert('  and only that delivery\'s row', JSON.stringify(st.figureWrites) === '["R1"]', JSON.stringify(st.figureWrites));
    assert('  a figure edit is not a re-code', st.daily.get('R2').cost_code === '250');

    const fresh = tabPO();
    fresh.lines.push({ id: 'L6', date: '2026-11-07', qty: '3', unit_cost: '10', po_row_id: 'Rgone' });
    await W(fresh, [], { L6: ['qty'] });
    const g = st.daily.get('Rgone');
    assert('a delivery whose row is missing gets it back, on the order\'s job',
      Boolean(g) && g.project_id === 'job1' && g.division === 'turf' && g.units_purchased === 3
      && near(g.material_cost, 30) && g.cost_code === '300' && g.material === 'Gravel', JSON.stringify(g));

    const emptied = tabPO();
    Object.assign(emptied.lines[1], { qty: '', unit_cost: '' });
    await W(emptied, [], { L2: ['qty', 'unit_cost'] });
    const z = st.daily.get('R2');
    assert('a delivery the tab emptied leaves its row at zero, not deleted',
      Boolean(z) && z.units_purchased === 0 && z.unit_cost === 0 && z.material_cost === 0, JSON.stringify(z));
    assert('  its date kept where the line has none to give', z.date === '2026-11-02');

    st.figureWrites.length = 0;
    const invOnly = tabPO();
    invOnly.lines[0].invoice_num = 'INV-9';
    const n = await W(invOnly, [], { L1: ['invoice_num'] });
    assert('an invoice # alone writes nothing to the job', n === 0 && st.figureWrites.length === 0, String(n));

    const daily = tabPO();
    daily.lines[2].qty = '25';
    await W(daily, [], { 'dr-r9': ['qty'] });
    assert('a Daily Tracking delivery\'s figure reaches its row the way purchasing\'s does',
      st.daily.get('r9').units_purchased === 25 && near(st.daily.get('r9').material_cost, 400)
      && st.daily.get('r9').cost_code === '02-100', JSON.stringify(st.daily.get('r9')));
    before.set('r9', snapOf('r9'));

    // Every other row a line names: another job's, another division's, payroll's.
    const all = tabPO({ title: 'Clobber', cost_code: '999' });
    all.lines.forEach(l => { l.qty = '99'; });
    await W(all, ['title', 'cost_code'], { L3: ['qty'], L4: ['qty'], L5: ['qty'] });
    assert('a row on another job is left alone', snapOf('Rjob2') === before.get('Rjob2'), snapOf('Rjob2'));
    assert('  and one in another division', snapOf('Rpav') === before.get('Rpav'), snapOf('Rpav'));
    assert('  and payroll\'s', snapOf('ts5-abc-0-x') === before.get('ts5-abc-0-x'), snapOf('ts5-abc-0-x'));
    assert('  while the order\'s own rows did take the header', st.daily.get('R1').material === 'Clobber');

    const renum = tabPO({ po_number: 'PO-0002' });
    await W(renum, ['po_number']);
    assert('a renumber reaches the raised rows', st.daily.get('R1').po_num === 'PO-0002');
    assert('  and the field\'s row, so it still names the order',
      st.daily.get('r9').po_num === 'PO-0002' && st.daily.get('r9').material === '57 stone', JSON.stringify(st.daily.get('r9')));

    const sizeBefore = st.daily.size;
    const q = await W(tabPO({ title: 'Nope' }), ['title'], { L1: ['qty'] }, 'quarry');
    const nj = await W(tabPO({ project_id: '', title: 'Nope' }), ['title'], { L1: ['qty'] });
    assert('a division with no jobs, or an order with none, writes nothing',
      q === 0 && nj === 0 && st.daily.size === sizeBefore && st.daily.get('R1').material !== 'Nope');
  }

  console.log('\n[settleLineFigures on its own]');
  {
    const S = (po, stored, edits, opts) => ({ kept: poSync.settleLineFigures(po, stored, editsOf(edits), opts), po });
    const stale = { id: 'L1', invoice_num: '', date: '2026-11-02', qty: '10', unit_cost: '4', tax_pct: '6', tax: '2.4', employee: 'Sam', po_row_id: 'R' };
    const store = { id: 'L1', invoice_num: 'INV', date: '2026-11-03', qty: '12', unit_cost: '5', tax_pct: '6', tax: '3.6', employee: 'Ana', po_row_id: 'R' };

    let sent = { lines: [Object.assign({}, stale, { qty: '20', tax: '4.8' })] };
    const sentLine = sent.lines[0];
    let r = S(sent, { lines: [store] }, { L1: ['qty'] });
    let l = r.po.lines[0];
    assert('every key the page did not name takes the stored value',
      l.qty === '20' && l.unit_cost === '5' && l.invoice_num === 'INV' && l.date === '2026-11-03' && l.employee === 'Ana',
      JSON.stringify(l));
    assert('  the tax re-taken on what came out (20 × 5 × 6%)', near(l.tax, 6), JSON.stringify(l));
    assert('  the line is replaced, never mutated — the request\'s objects may be shared',
      l !== sentLine && sentLine.qty === '20' && sentLine.unit_cost === '4');
    assert('  and it says which lines it changed', JSON.stringify(r.kept) === '["L1"]', JSON.stringify(r.kept));

    r = S({ lines: [Object.assign({}, stale, { tax: '7.77' })] }, { lines: [store] }, { L1: ['tax'] });
    assert('a tax the page typed itself stands', r.po.lines[0].tax === '7.77', JSON.stringify(r.po.lines[0]));

    r = S({ lines: [{ id: 'L1', qty: '12', unit_cost: '10', tax: '9.99' }] },
          { lines: [{ id: 'L1', qty: '10', unit_cost: '10', tax: '3.21' }] }, { L1: ['qty'] });
    assert('a legacy flat tax is kept like any figure, not re-taken',
      r.po.lines[0].tax === '3.21' && !('tax_pct' in r.po.lines[0]), JSON.stringify(r.po.lines[0]));

    r = S({ lines: [{ id: 'L1', qty: '12', unit_cost: '10', tax_pct: '6', tax: '7.2' }] },
          { lines: [{ id: 'L1', qty: '10', unit_cost: '10', tax: '3.21' }] }, { L1: ['qty'] });
    assert('a stale copy cannot turn a legacy line into a percentage one',
      !('tax_pct' in r.po.lines[0]) && r.po.lines[0].tax === '3.21', JSON.stringify(r.po.lines[0]));

    const dl = { id: 'dr-r1', source: 'daily', qty: '20', unit_cost: '16', invoice_num: '' };
    const raised = { id: 'L1', qty: '10', unit_cost: '4' };
    r = S({ lines: [Object.assign({}, dl), Object.assign({}, raised)] },
          { lines: [Object.assign({}, dl, { qty: '25', invoice_num: 'T' }), Object.assign({}, raised, { qty: '12' })] },
          {}, { raisedOnly: true });
    assert('raisedOnly leaves a Daily Tracking line as it came (it was just derived from its row)',
      r.po.lines[0].qty === '20' && r.po.lines[0].invoice_num === '', JSON.stringify(r.po.lines[0]));
    assert('  and still settles a raised one', r.po.lines[1].qty === '12', JSON.stringify(r.po.lines[1]));

    const fresh = { id: 'NEW', qty: '3', unit_cost: '9' };
    r = S({ lines: [fresh] }, { lines: [store] }, {});
    assert('a line the stored order does not have is new, and comes as sent',
      r.po.lines[0] === fresh && r.kept.length === 0);

    r = S({ lines: [{ id: 'X', qty: '1', unit_cost: '1' }] }, { lines: [{ id: 'X', source: 'daily', qty: '9', unit_cost: '9' }] }, {});
    assert('a raised line is not settled against a Daily Tracking line of the same id',
      r.po.lines[0].qty === '1' && r.kept.length === 0, JSON.stringify(r));
    r = S({ lines: [{ id: 'X', source: 'daily', qty: '1', unit_cost: '1' }] }, { lines: [{ id: 'X', qty: '9', unit_cost: '9' }] }, {});
    assert('  nor the other way round', r.po.lines[0].qty === '1' && r.kept.length === 0, JSON.stringify(r));

    r = S({ lines: [{ id: 'L1', qty: '10', unit_cost: '4', employee: 'stale' }] }, { lines: [{ id: 'L1', qty: '10', unit_cost: '4' }] }, {});
    assert('a key the stored line never had is dropped, not kept from the copy',
      !('employee' in r.po.lines[0]), JSON.stringify(r.po.lines[0]));
    r = S({ lines: [{ id: 'L1', qty: '10', invoice_num: null, po_row_id: 'mine' }] },
          { lines: [{ id: 'L1', qty: '10', invoice_num: '', po_row_id: 'theirs' }] }, {});
    assert('blank and null are the same nothing, and the row link is not a figure',
      r.kept.length === 0 && r.po.lines[0].po_row_id === 'mine', JSON.stringify(r));
    assert('no stored copy, or no edits from the page: left as sent',
      poSync.settleLineFigures({ lines: [{ id: 'L1', qty: '1' }] }, null, editsOf({})).length === 0
      && poSync.settleLineFigures({ lines: [{ id: 'L1', qty: '1' }] }, { lines: [{ id: 'L1', qty: '2' }] }, null).length === 0);
  }

  console.log('\n[editedLineFields: reading what a page sent]');
  {
    const m = poSync.editedLineFieldMap({ L1: ['qty', 7], L2: 'qty', L3: [] });
    assert('editedLineFieldMap: per line, a Set of keys, dropping what is not a list',
      m.get('L1').has('qty') && m.get('L1').has('7') && !m.has('L2') && m.get('L3').size === 0);
    assert('  anything that is not an object is "did not say" — distinct from an empty one',
      poSync.editedLineFieldMap(['L1']) === null && poSync.editedLineFieldMap(null) === null
      && poSync.editedLineFieldMap(undefined) === null && poSync.editedLineFieldMap({}).size === 0);
    const by = poSync.editedLineFieldsByOrder({ A: { L1: ['qty'] }, B: ['nope'], C: {} });
    assert('editedLineFieldsByOrder: per order, dropping what is not a map',
      by.get('A').get('L1').has('qty') && !by.has('B') && by.get('C').size === 0
      && poSync.editedLineFieldsByOrder(null) === null && poSync.editedLineFieldsByOrder([]) === null);
    const ids = poSync.rowEditedLineIds(editsOf({ a: ['invoice_num'], b: ['qty'], c: ['tax'], d: ['employee', 'invoice_num'], e: [] }));
    assert('rowEditedLineIds: every edit but the invoice # alone reaches the row',
      [...ids].sort().join() === 'b,c,d', [...ids].join());
    assert('  the invoice # is the one figure no row carries',
      poSync.LINE_KEYS.filter(k => !poSync.LINE_ROW_KEYS.includes(k)).join() === 'invoice_num');
  }

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
