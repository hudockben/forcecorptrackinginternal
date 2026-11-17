#!/usr/bin/env node
'use strict';
/**
 * Daily Tracking → Purchase Orders: the endpoint that triggers it and the
 * pages that show it.
 *
 * Run: node scripts/test-po-daily-sync.js
 *
 * A Daily Tracking row could name PO-0003 and carry 20 t at $16.00 under
 * 02-100 / 0420, the job was charged, and PO-0003 — on the division's own tab
 * and on central purchasing — still read "no deliveries". The server now
 * records such a row on the order it names (api/lib/po-sync.js, pinned by
 * scripts/test-po-division.js and scripts/test-po-endpoint.js). This suite
 * pins the rest:
 *
 *  1. api/daily-rows.js hands every row write and delete that could matter to
 *     the order sync, answers with the orders it changed, and never lets a
 *     failed sync fail the row.
 *  2. The division pages (tracker / paving / kiewit), run as their own code:
 *     they no longer write orders from a row edit; they take on what the
 *     server changed without losing a line they have not saved; they ask for
 *     the catch-up once; the notice and Create never run against a list that
 *     failed to load; nothing on the order side deletes the field's row.
 *  3. Central purchasing sends which lines it edited and cannot delete a Daily
 *     Tracking delivery.
 */

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const Module = require('module');
const { requireFn, sliceSource, evalSlice } = require('./lib/fn-source');

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

let passed = 0, failed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail !== undefined) console.error('      ' + String(detail).slice(0, 500));
};

const PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const BLOCK_FROM = '/* ── Daily Tracking → Purchase Orders';
const BLOCK_TO   = '\nfunction _subCodeOpts(po) {';
const block = (src, page) => sliceSource(src, BLOCK_FROM, BLOCK_TO,
  `the Daily Tracking → PO block in ${page}`, 'function _poDailyOrphansHTML');

(async () => {
  // ══ 1. api/daily-rows.js ═════════════════════════════════════════════════
  console.log('\n[api/daily-rows.js hands row writes to the order sync]');
  {
    let SQL = null, syncCalls = [], syncImpl = null;
    const orig = Module._load;
    Module._load = function (request) {
      if (request === '@neondatabase/serverless') return { neon: () => SQL };
      if (request === './lib/auth') return { requireDivision: () => ({ payload: { companyCode: 'FCT' }, division: 'turf' }) };
      if (request === './lib/po-sync') {
        return { syncRowsToOrders: async (sql, args) => { syncCalls.push(args); return syncImpl ? syncImpl(args) : { ok: true, orders: [] }; } };
      }
      return orig.apply(this, arguments);
    };
    const handlerPath = path.resolve(__dirname, '..', 'api', 'daily-rows.js');
    delete require.cache[handlerPath];
    const handler = require(handlerPath);
    Module._load = orig;

    const makeSql = (rowsById = {}, returning = []) => {
      const log = [];
      const sql = (strings, ...vals) => {
        // A batch insert calls sql(text, params) rather than as a template.
        const q = (Array.isArray(strings) ? strings.join('?') : String(strings)).replace(/\s+/g, ' ').trim();
        log.push(q);
        if (/^SELECT timesheet_entry_id(, po_num)? FROM daily_tracking/.test(q)) {
          const r = rowsById[String(vals[0])];
          return Promise.resolve(r ? [r] : []);
        }
        if (/^DELETE FROM daily_tracking/.test(q) && /RETURNING/.test(q)) return Promise.resolve(returning);
        return Promise.resolve([]);
      };
      sql.log = log;
      return sql;
    };
    const res = () => {
      const r = { statusCode: 200, body: null };
      r.setHeader = () => {}; r.status = c => { r.statusCode = c; return r; };
      r.json = b => { r.body = b; return r; }; r.end = () => r;
      return r;
    };
    const call = async (req, sql) => { SQL = sql; syncCalls = []; const r = res(); await handler(req, r); return r; };

    let r = await call({ method: 'POST', query: {}, body: { projectId: 'p1', rows: [
      { id: 'a', po_num: 'PO-0003', units_purchased: '2' }, { id: 'b', po_num: '' }, { id: 'c', po_num: '  ' },
      { id: 'ts9-1-0-x', po_num: 'PO-0003' } ] } }, makeSql());
    assert('POST hands over the inserted rows that name an order — and only those',
      syncCalls.length === 1 && JSON.stringify(syncCalls[0].rowIds) === '["a"]', JSON.stringify(syncCalls));
    assert('  scoped to the company and division', syncCalls[0] && syncCalls[0].companyCode === 'FCT' && syncCalls[0].division === 'turf');
    r = await call({ method: 'POST', query: {}, body: { projectId: 'p1', rows: [{ id: 'b' }] } }, makeSql());
    assert('POST of rows naming no order reads no orders at all', syncCalls.length === 0 && r.body.ok);

    r = await call({ method: 'PUT', query: { id: 'r1' }, body: { projectId: 'p1', row: { po_num: 'PO-0003' } } },
      makeSql({ r1: { timesheet_entry_id: null, po_num: null } }));
    assert('PUT of a row that now names an order syncs it', syncCalls.length === 1 && JSON.stringify(syncCalls[0].rowIds) === '["r1"]');
    r = await call({ method: 'PUT', query: { id: 'r1' }, body: { projectId: 'p1', row: { po_num: '' } } },
      makeSql({ r1: { timesheet_entry_id: null, po_num: 'PO-0003' } }));
    assert('PUT of a row that named one before syncs it — it may have to come off', syncCalls.length === 1);
    r = await call({ method: 'PUT', query: { id: 'r1' }, body: { projectId: 'p1', row: { labor_hours: '8' } } },
      makeSql({ r1: { timesheet_entry_id: null, po_num: null } }));
    assert('PUT of a row that never named one does no order work', syncCalls.length === 0 && r.body.ok);
    r = await call({ method: 'PUT', query: { id: 'r1' }, body: { row: { po_num: 'PO-1' } } },
      makeSql({ r1: { timesheet_entry_id: 44, po_num: 'PO-1' } }));
    assert('a payroll row\'s partial update never reaches the orders', syncCalls.length === 0 && r.body.partial === true);

    syncImpl = () => ({ ok: true, orders: [{ id: 'po3', lines: [] }] });
    r = await call({ method: 'PUT', query: { id: 'r1' }, body: { projectId: 'p1', row: { po_num: 'PO-0003' } } },
      makeSql({ r1: { timesheet_entry_id: null, po_num: null } }));
    assert('the orders the write changed come back with it',
      r.body.ok && r.body.po && r.body.po.orders.length === 1 && r.body.po.orders[0].id === 'po3', JSON.stringify(r.body));
    syncImpl = () => { throw new Error('blob read failed'); };
    const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(' '));
    r = await call({ method: 'PUT', query: { id: 'r1' }, body: { projectId: 'p1', row: { po_num: 'PO-0003' } } },
      makeSql({ r1: { timesheet_entry_id: null, po_num: null } }));
    console.error = oe;
    assert('a failed order sync never fails the row write', r.statusCode === 200 && r.body.ok === true && !r.body.po, JSON.stringify(r.body));
    assert('  and is logged', errs.some(e => /purchase orders/.test(e)));
    syncImpl = null;

    r = await call({ method: 'DELETE', query: { id: 'r1' } }, makeSql({ r1: { timesheet_entry_id: null } }));
    assert('a deleted row is handed over as deleted',
      syncCalls.length === 1 && JSON.stringify(syncCalls[0].deletedIds) === '["r1"]' && r.body.ok);
    r = await call({ method: 'DELETE', query: { id: 'r1' } }, makeSql({ r1: { timesheet_entry_id: 9 } }));
    assert('a refused delete of a payroll row touches no order', r.statusCode === 409 && syncCalls.length === 0);
    r = await call({ method: 'DELETE', query: { subCode: '0420' } },
      makeSql({}, [{ row_id: 'x', po_num: 'PO-1' }, { row_id: 'y', po_num: null }]));
    assert('a bulk delete hands over the deleted rows that named an order',
      syncCalls.length === 1 && JSON.stringify(syncCalls[0].deletedIds) === '["x"]', JSON.stringify(syncCalls));
    r = await call({ method: 'DELETE', query: { costCode: '02', subCode: '0420' } }, makeSql({}, [{ row_id: 'z', po_num: 'PO-2' }]));
    assert('  by cost and sub code too', syncCalls.length === 1 && JSON.stringify(syncCalls[0].deletedIds) === '["z"]');
    r = await call({ method: 'DELETE', query: { projectId: 'p1' } }, makeSql({}, [{ row_id: 'w', po_num: 'PO-3' }]));
    assert('  and with the whole job', syncCalls.length === 1 && JSON.stringify(syncCalls[0].deletedIds) === '["w"]');
  }

  // ══ 2. The division pages ═════════════════════════════════════════════════
  console.log('\n[the three division pages carry the same code]');
  {
    const blocks = PAGES.map(p => block(read(p), p));
    assert('paving.html carries the same block as tracker.html', blocks[1] === blocks[0]);
    assert('kiewit-pinetree.html carries the same block as tracker.html', blocks[2] === blocks[0]);
    ['makePOSelect', '_detachLinkedRows', '_syncPOHeaderToLines', 'deletePOLine', 'deletePO', '_syncPOLineToRow'].forEach(fn => {
      const srcs = PAGES.map(p => requireFn(read(p), fn, p));
      assert(`${fn} is the same in all three`, srcs.every(s => s === srcs[0]));
    });
    assert('no page still writes orders from a row edit',
      PAGES.every(p => !/_syncDailyRowToPO|_reconcileDailyPOLinks|_dailyRowToPO|PO_ROW_SYNC_FIELDS/.test(read(p))));
  }

  console.log('\n[the pages read the orders back from the server, and never delete the field\'s rows]');
  PAGES.forEach(page => {
    const src = read(page);
    const handlerSrc = sliceSource(src, "document.addEventListener('change', e => {\n  const el = e.target;\n  if (el.dataset.tab !== 'daily'",
      '\n});', `${page} daily change handler`, 'drPutNow');
    assert(`${page}: a Daily Tracking edit writes the row and nothing else`, !/purchaseOrders|savePurchaseOrders/.test(handlerSrc));
    ['drPost', '_drPutNow', 'drDelete', 'drDeleteBySubCode', 'drDeleteByProject'].forEach(fn => {
      assert(`${page}: ${fn} takes on the orders its write changed`, /_drAdoptPO\(r\)/.test(requireFn(src, fn, page)));
    });
    assert(`${page}: so does a bulk post`, /_drAdoptPO\(r\);/.test(requireFn(src, 'drPostBulk', page)));
    const boot = sliceSource(src, 'const _bootReady = (async () => {', '\n})();', `${page} boot`, 'renderHeaderActions');
    assert(`${page}: the catch-up is asked for once, after load, never by the report robot`,
      /_poServerCatchUp\(\);/.test(boot) && boot.indexOf('_poServerCatchUp();') > boot.indexOf('if (_AUTO_REPORT) return;'));
    assert(`${page}: a save the server re-derived re-reads the lines`,
      /if \(j && j\.derived\) _poRefreshDailyLines\(\);/.test(requireFn(src, 'savePurchaseOrders', page)));
    assert(`${page}: deleting an order leaves Daily Tracking rows`,
      /if \(line\.po_row_id && !_poLineFromDaily\(line\)\) \{\s*\n\s*proj\.dailyRows = proj\.dailyRows\.filter/.test(requireFn(src, 'deletePO', page)));
    const ev = requireFn(src, '_handlePOEvent', page);
    assert(`${page}: re-jobbing an order leaves them on the old job, and drops their lines`,
      /if \(line\.po_row_id && !_poLineFromDaily\(line\)\) \{\s*\n\s*oldP\.dailyRows/.test(ev)
      && /po\.lines = \(po\.lines \|\| \[\]\)\.filter\(l => !_poLineFromDaily\(l\)\);/.test(ev));
    assert(`${page}: a Daily Tracking line's row is never rebuilt from the order`,
      /if \(!r && _poLineFromDaily\(line\)\) return;/.test(requireFn(src, '_syncPOLineToRow', page)));
    assert(`${page}: the PO tab shows a lock, not a ✕, on a Daily Tracking line`,
      /\$\{_poLineFromDaily\(line\) \? `<td[^`]*&#128274;<\/td>`\s*\n\s*: perm\.canEdit \?/.test(requireFn(src, 'renderPOTab', page)));
    assert(`${page}: and tags it with the row's codes`,
      /from Daily Tracking\$\{\(line\.cost_code \|\| line\.sub_code\)/.test(requireFn(src, 'renderPOTab', page)));
    assert(`${page}: the notice of numbers with no order is drawn`, /\$\{_poDailyOrphansHTML\(\)\}/.test(requireFn(src, 'renderPOTab', page)));
    const fill = sliceSource(src, '  targets.forEach(({ i, tr }) => {', '\n  });', `${page} fill-drag`, 'drPutNow');
    assert(`${page}: a fill-drag cannot overwrite a PO # an order set`,
      /if \(field === 'po_num' && _poRowRaisedByOrder\(row\.id\)\) return;/.test(fill));
    assert(`${page}: a good read of the orders is recorded`, /_poLoadOk = true;/.test(requireFn(src, 'loadPurchaseOrders', page)));
  });

  // The pages' own functions, lifted and run.
  const LIFTED = ['_normalizeNumeric', '_poNum', '_poNum0', '_detachLinkedRows', 'makePOSelect',
                  '_syncPOHeaderToLines', 'deletePOLine', '_migratePOs', '_lineAmt', '_lineTaxPct', '_lineTax', '_recalcLineTax'];
  function sandbox(src, page) {
    const state = { saves: 0, rowPuts: [], fetches: [], renders: 0, errors: [], projectRenders: [] };
    let n = 0;
    const ctx = vm.createContext({
      console, Map, Set, Math, String, Number, Array, Boolean, JSON, Date, Promise, isNaN, Object,
      purchaseOrders: [], projectsList: [], truckingEntries: [], inventoryEntries: [],
      perm: { canEdit: true }, _AUTO_REPORT: false, activeTab: 'po', _poLoadOk: true, _poBaseUpdatedAt: 'v0',
      fctUser: { name: 'Tester' }, _poExpanded: new Set(), poPage: 3, DIVISION: 'turf', API_BASE: '/api', fctToken: 't',
      document: { activeElement: null, getElementById: () => null },
      uid: () => 'u' + (++n), _localDateStr: () => '2026-11-10',
      esc:   s => String(s || '').replace(/"/g, '&quot;'),
      escT:  s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      escJs: s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
      fmt:   v => Number(v).toFixed(2),
      savePurchaseOrders: () => { state.saves++; },
      saveTruckingEntries: () => {}, saveInventoryEntries: () => {},
      renderPOTab: () => { state.renders++; }, renderProjectPOs: id => { state.projectRenders.push(id); }, renderDailyTable: () => {},
      drPutNow: (id, row) => { state.rowPuts.push({ id, row: { ...row } }); },
      drDelete: () => {}, drGetAll: async () => [],
      _showSaveError: (auth, msg) => { state.errors.push(msg || 'error'); },
      fetch: async (url, opts) => { state.fetches.push({ url, opts }); return state.reply ? state.reply(url, opts) : { ok: false, status: 500 }; },
    });
    ctx.getProj = id => ctx.projectsList.find(p => p.id === id);
    LIFTED.forEach(name => {
      const fn = requireFn(src, name, page);
      evalSlice((src.includes(`async function ${name}(`) ? 'async ' : '') + fn, ctx, `${name} from ${page}`);
    });
    evalSlice(block(src, page), ctx, `the Daily Tracking → PO block from ${page}`);
    return { ctx, state };
  }
  const json = body => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)),
                          clone() { return json(body); } });
  const order = over => Object.assign({ id: 'po3', po_number: 'PO-0003', title: 'Aggregate', supplier: 'Acme',
    status: 'pending', date_created: '2026-11-01', project_id: 'job1', cost_code: '', sub_code: '', lines: [] }, over || {});

  for (const page of PAGES) {
    const src = read(page);

    console.log(`\n[${page}: taking on what the server changed]`);
    {
      const { ctx, state } = sandbox(src, page);
      // A line typed here a moment ago: its row's write came back first, and
      // the server recorded the row as a Daily Tracking line of its own.
      const local = order({ title: 'Local title', lines: [
        { id: 'L1', qty: '10', unit_cost: '16', po_row_id: 'r1' },          // saved
        { id: 'Lnew', qty: '5', unit_cost: '2', po_row_id: 'rNew' },        // not saved yet
        { id: 'dr-old', source: 'daily', qty: '1', unit_cost: '1', po_row_id: 'rOld' },
      ] });
      ctx.purchaseOrders.push(local);
      const srv = order({ title: 'Server title', lines: [
        { id: 'L1', qty: '12', unit_cost: '16', po_row_id: 'r1' },          // aligned to its row
        { id: 'dr-rNew', source: 'daily', qty: '5', unit_cost: '2', po_row_id: 'rNew' },
        { id: 'dr-r7', source: 'daily', qty: '7', unit_cost: '3', po_row_id: 'r7' },
      ] });
      const n = ctx._poAdoptServerOrders([srv]);
      const ids = local.lines.map(l => l.id).join();
      assert('the server\'s Daily Tracking lines replace the page\'s', ids === 'L1,Lnew,dr-r7', ids);
      assert('  a line the page has not saved yet stays', local.lines.some(l => l.id === 'Lnew'));
      assert('  and no Daily Tracking copy of its row is shown beside it', !local.lines.some(l => l.id === 'dr-rNew'));
      assert('  the server\'s figures for a line both hold are taken', local.lines.find(l => l.id === 'L1').qty === '12');
      assert('  the page\'s own header is left alone', local.title === 'Local title');
      assert('  and the tab is redrawn', n === 1 && state.renders === 1 && state.projectRenders.includes('job1'));
      assert('a second time changes nothing', ctx._poAdoptServerOrders([srv]) === 0 && state.renders === 1);
      ctx.document.activeElement = { tagName: 'INPUT' };
      ctx._poAdoptServerOrders([order({ lines: [{ id: 'dr-r8', source: 'daily', po_row_id: 'r8' }] })]);
      assert('nothing is redrawn under someone typing', state.renders === 1 && local.lines.some(l => l.id === 'dr-r8'));
      ctx.document.activeElement = null;

      let took = null;
      ctx._poAdoptServerOrders = orders => { took = orders; return 0; };
      ctx._drAdoptPO(json({ ok: true, po: { orders: [srv] } }));
      await new Promise(r => setTimeout(r, 0));
      assert('a row write\'s answer is read for its orders', took && took.length === 1);
      took = null;
      ctx._drAdoptPO({ ok: false, status: 500, clone() { throw new Error('never read'); } });
      ctx._drAdoptPO(json({ ok: true }));
      await new Promise(r => setTimeout(r, 0));
      assert('  and a failed or empty one is ignored', took === null);
    }

    console.log(`\n[${page}: the once-per-load catch-up]`);
    {
      const { ctx, state } = sandbox(src, page);
      ctx.purchaseOrders.push(order());
      const listBack = [order({ lines: [{ id: 'dr-r1', source: 'daily', qty: '20', unit_cost: '16', po_row_id: 'r1' }] })];
      state.reply = (url, opts) => json({ ok: true, changed: 1, purchaseOrders: listBack, updatedAt: '2026-11-10T00:00:05.000Z' });
      await ctx._poServerCatchUp();
      const f = state.fetches[0];
      assert('the server is asked, for this division', f && /\/purchase-orders\?division=turf&reconcile=1$/.test(f.url) && f.opts.method === 'POST', f && f.url);
      assert('its list is taken on', ctx.purchaseOrders.length === 1 && ctx.purchaseOrders[0].lines[0].id === 'dr-r1');
      assert('  with the version it came from', ctx._poBaseUpdatedAt === '2026-11-10T00:00:05.000Z');
      const view = sandbox(src, page);
      view.ctx.perm.canEdit = false;
      await view.ctx._poServerCatchUp();
      const robot = sandbox(src, page);
      robot.ctx._AUTO_REPORT = true;
      await robot.ctx._poServerCatchUp();
      assert('a view-only user and the report robot never ask', !view.state.fetches.length && !robot.state.fetches.length);
      const nothing = sandbox(src, page);
      nothing.ctx.purchaseOrders.push(order({ title: 'mine' }));
      nothing.state.reply = () => json({ ok: true, changed: 0, purchaseOrders: [], updatedAt: 'x' });
      await nothing.ctx._poServerCatchUp();
      assert('an answer that changed nothing leaves the list alone',
        nothing.ctx.purchaseOrders.length === 1 && nothing.ctx._poBaseUpdatedAt === 'v0');
    }

    console.log(`\n[${page}: PO numbers with no order, and raising one]`);
    {
      const { ctx, state } = sandbox(src, page);
      ctx.purchaseOrders.push(order(), order({ id: 'poZ', po_number: 'PO-0020', project_id: 'job2' }));
      ctx.projectsList.push(
        { id: 'job1', 'project-name': 'Main St', dailyRows: [
          { id: 'a', po_num: 'PO-0099', date: '2026-10-30', material: '#2 stone', cost_code: '02-200', sub_code: '0500', material_cost: '320' },
          { id: 'b', po_num: 'po-0099', date: '2026-10-28', material_cost: '100' },
          { id: 'c', po_num: 'PO-0020' },
          { id: 'd', po_num: 'PO-0003' } ] },
        { id: 'job2', 'project-name': 'Oak Ave', dailyRows: [] });
      const groups = ctx._dailyPONumbersWithoutOrder();
      const g99 = groups.find(g => g.poNum.toLowerCase() === 'po-0099');
      assert('a number no order holds is listed, its rows together', g99 && g99.rows === 2 && g99.material === 420, JSON.stringify(groups));
      assert('a number another job holds is listed with that order',
        groups.some(g => g.poNum === 'PO-0020' && g.elsewhere && g.elsewhere.id === 'poZ'));
      assert('a number the job has an order for is not', !groups.some(g => g.poNum === 'PO-0003'));
      const html = ctx._poDailyOrphansHTML();
      assert('the notice offers to raise the missing one', /createPOFromDaily\('job1','PO-0099'\)/.test(html));
      assert('  but not one that exists on another job', !/createPOFromDaily\('job1','PO-0020'\)/.test(html) && /is on Oak Ave/.test(html));

      let posted = null;
      state.reply = (url, opts) => { posted = { url, body: JSON.parse(opts.body), method: opts.method };
        return json({ ok: true, purchaseOrder: Object.assign({}, JSON.parse(opts.body).purchaseOrder,
          { lines: [{ id: 'dr-a', source: 'daily', po_row_id: 'a' }] }) }); };
      await ctx.createPOFromDaily('job1', 'PO-0020');
      assert('it will not raise a number the division already has', posted === null);
      await ctx.createPOFromDaily('job1', 'PO-0099');
      assert('raising one saves that order alone', posted && posted.method === 'POST'
        && /\/purchase-orders\?division=turf$/.test(posted.url) && posted.body.purchaseOrder && !posted.body.purchaseOrders);
      const made = ctx.purchaseOrders.find(p => p.po_number === 'PO-0099');
      assert('  on the job, headed from its rows', made && made.project_id === 'job1' && made.title === '#2 stone'
        && made.cost_code === '02-200' && made.date_created === '2026-10-28');
      assert('  taking on what the server recorded on it', made && made.lines.length === 1 && made.lines[0].id === 'dr-a');
      assert('  and never as a whole-list save', state.saves === 0);

      const broken = sandbox(src, page);
      broken.ctx._poLoadOk = false;
      broken.ctx.projectsList.push({ id: 'job1', 'project-name': 'Main St', dailyRows: [{ id: 'a', po_num: 'PO-0003' }] });
      broken.state.reply = () => { throw new Error('must not save'); };
      assert('after a failed read there is no notice at all', broken.ctx._poDailyOrphansHTML() === '');
      await broken.ctx.createPOFromDaily('job1', 'PO-0003');
      assert('  and Create does nothing', !broken.state.fetches.length && !broken.ctx.purchaseOrders.length);
      assert('  nor is any PO # cell flagged', !/outline/.test(broken.ctx.makePOSelect('job1', 'PO-0003', 0, undefined)));
    }

    console.log(`\n[${page}: the PO # cell, deletes and header edits]`);
    {
      const { ctx, state } = sandbox(src, page);
      const raised = { id: 'L1', qty: '5', unit_cost: '10', po_row_id: 'r2' };
      const daily  = { id: 'dr-r1', source: 'daily', qty: '20', unit_cost: '16', po_row_id: 'r1' };
      const po = order({ title: 'Stone', supplier: 'Acme', cost_code: '300', sub_code: 'C', po_number: 'PO-0007', lines: [daily, raised] });
      ctx.purchaseOrders.push(po);
      const links = ctx._poLinksByRow();
      assert('the PO # cell is locked on a row the order raised', /\sdisabled\b/.test(ctx.makePOSelect('job1', 'PO-0007', 0, links.get('r2'))));
      assert('  and free on a Daily Tracking delivery', !/\sdisabled\b/.test(ctx.makePOSelect('job1', 'PO-0007', 1, links.get('r1'))));
      assert('a number with no order on the job is flagged', /outline:1px solid var\(--yellow\)/.test(ctx.makePOSelect('job1', 'PO-0999', 2, undefined)));
      assert('_poRowRaisedByOrder tells the two apart', ctx._poRowRaisedByOrder('r2') && !ctx._poRowRaisedByOrder('r1') && !ctx._poRowRaisedByOrder('zz'));

      const r1 = { id: 'r1', material: '57 stone', supplier: 'Quarry Co', cost_code: '02-100', sub_code: '0420', po_num: 'PO-0003' };
      const r2 = { id: 'r2', material: '', supplier: '', cost_code: '', sub_code: '', po_num: '' };
      ctx.projectsList.push({ id: 'job1', dailyRows: [r1, r2], _drFullLoaded: true });
      vm.runInContext('_syncPOHeaderToLines(purchaseOrders[0], true)', ctx);
      assert('a header edit leaves a Daily Tracking row\'s own codes, material and supplier',
        r1.cost_code === '02-100' && r1.material === '57 stone' && r1.supplier === 'Quarry Co', JSON.stringify(r1));
      assert('  but gives it the order\'s number', r1.po_num === 'PO-0007');
      assert('the raised row follows the order as before', r2.cost_code === '300' && r2.material === 'Stone' && r2.po_num === 'PO-0007');

      vm.runInContext("deletePOLine('po3', 'dr-r1')", ctx);
      assert('a Daily Tracking delivery cannot be deleted from the order', po.lines.includes(daily) && state.saves === 0);

      ctx._detachLinkedRows(id => id === 'r1');
      assert('deleting its row takes it off the order here too', !po.lines.includes(daily) && po.lines.includes(raised));
      ctx._detachLinkedRows(id => id === 'r2');
      assert('a raised line is detached as before', raised.po_row_id === null && raised.qty === '5');
    }
  }

  // ══ 3. Central purchasing ═════════════════════════════════════════════════
  console.log('\n[purchase-orders.html]');
  {
    const src = read('purchase-orders.html');
    const ctx = vm.createContext({ String, Boolean });
    vm.runInContext(requireFn(src, 'esc') + requireFn(src, 'isDailyLine') + requireFn(src, 'dailyLineTagHTML'), ctx);
    const tag = ctx.dailyLineTagHTML({ source: 'daily', cost_code: '02-100', sub_code: '0420' });
    assert('a Daily Tracking delivery is tagged with its row\'s codes', /from Daily Tracking/.test(tag) && /02-100 \/ 0420/.test(tag), tag);
    assert('an ordinary one is not', ctx.dailyLineTagHTML({ id: 'L1' }) === '');
    const rows = requireFn(src, 'lineRowsHTML');
    assert('the delivery rows draw the tag', /dailyLineTagHTML\(l\)/.test(rows));
    assert('  and a lock in place of the ✕ on a Daily Tracking line', /isDailyLine\(l\)\s*\n\s*\? '<span[\s\S]{0,300}?&#128274;<\/span>'/.test(rows));
    assert('deleteLine refuses one', /if \(isDailyLine\(\(po\.lines \|\| \[\]\)\.find\(l => l\.id === lineId\)\)\) return;/.test(requireFn(src, 'deleteLine')));
    assert('an edit is remembered per line', /\(_editedLines\[poId\] \|\| \(_editedLines\[poId\] = new Set\(\)\)\)\.add\(lineId\);/.test(requireFn(src, 'setLineField')));
    const write = requireFn(src, '_savePOWrite');
    assert('every save says which lines it edited', /editedLineIds:\s*sentEdits,/.test(write));
    assert('  and forgets them once the server has them', /sentEdits\.forEach\(id => _editedLines\[po\.id\]\.delete\(id\)\);/.test(write));
    assert('so does the save made as the tab closes', /editedLineIds:\s*editedLinesFor\(id\),/.test(src));
  }

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────\n');
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('crashed:', err); process.exit(1); });
