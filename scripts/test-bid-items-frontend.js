#!/usr/bin/env node
'use strict';
/**
 * Frontend wiring test for the per-bid-item PUT path.
 *
 * Run: node scripts/test-bid-items-frontend.js
 *
 * Two layers:
 *   1. Structural — greps tracker.html / paving.html to verify the new
 *      functions exist, are reachable from updateBidItem, are drained by
 *      the unload flush, and that the bid-item ALTERs survive in the
 *      schema. Catches the most common refactor breakage.
 *   2. Behavioural — evaluates the patchBidItem / _doBidItemPut /
 *      _flushPendingProjectSaves block from each HTML file inside a
 *      sandboxed vm with mocked globals (getProj, fetch, setTimeout,
 *      etc.) and asserts on:
 *        - debounce (no fetch within 600ms; one fetch after)
 *        - rapid edits to the same bid item coalesce to one fetch
 *        - the unload flush fires immediately with keepalive:true
 *        - _lastProjIndexTs is updated optimistically to the sent ts
 *        - the URL carries id, projectId, and the right projectKey
 *        - 404 falls back to saveProject; network error does not
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

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
// 1) STRUCTURAL CHECKS — cheap, fail-fast against accidental rewrites.
// ─────────────────────────────────────────────────────────────────────

function structuralChecks(file, projectKeyPrefix, indexKey) {
  console.log(`\n[structural — ${file}]`);
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

  assert('defines patchBidItem',                       /function patchBidItem\(projId, biId\)/.test(src));
  assert('defines _doBidItemPut',                      /function _doBidItemPut\(projId, biId, keepalive\)/.test(src));
  assert('defines _biSaveTimers + _biSavePending',     /_biSaveTimers\s*=\s*\{\}/.test(src) && /_biSavePending\s*=\s*\{\}/.test(src));
  // updateBidItem should call patchBidItem (not saveProject) for field edits
  const updateFn = src.match(/function updateBidItem[\s\S]+?\n\}\n/);
  assert('updateBidItem calls patchBidItem',           !!updateFn && /patchBidItem\(projId, itemId\)/.test(updateFn[0]));
  assert('updateBidItem no longer calls saveProject',  !!updateFn && !/saveProject\(projId\)/.test(updateFn[0]));
  assert('updateBidItem still writes localStorage',    !!updateFn && /localStorage\.setItem\(PROJECTS_KEY/.test(updateFn[0]));
  // _flushPendingProjectSaves drains pending bid-item patches first
  const flushFn = src.match(/function _flushPendingProjectSaves[\s\S]+?\n\}\n/);
  assert('flush drains _biSavePending',                !!flushFn && /Object\.keys\(_biSavePending\)/.test(flushFn[0]));
  assert('flush calls _doBidItemPut with keepalive',   !!flushFn && /_doBidItemPut\(projId, biId, true\)/.test(flushFn[0]));
  assert('flush still hooks beforeunload',             /beforeunload['"], _flushPendingProjectSaves/.test(src));
  assert('flush still hooks visibilitychange',         /visibilitychange['"][\s\S]+_flushPendingProjectSaves/.test(src));
  // closeBidView should still flush before tearing down the view
  assert('closeBidView flushes pending saves',         /function closeBidView[\s\S]+_flushPendingProjectSaves\(\)/.test(src));
  // The PUT body includes both bidItem and ts, and sets _lastProjIndexTs
  const putFn = src.match(/function _doBidItemPut[\s\S]+?\n\}\n/);
  assert('_doBidItemPut sends body {bidItem, ts}',     !!putFn && /JSON\.stringify\(\{ bidItem: item, ts \}\)/.test(putFn[0]));
  assert('_doBidItemPut updates _lastProjIndexTs',     !!putFn && /_lastProjIndexTs\s*=\s*ts/.test(putFn[0]));
  assert(`_doBidItemPut uses ${projectKeyPrefix}`,     !!putFn && new RegExp(projectKeyPrefix).test(putFn[0]));
  assert('_doBidItemPut sets keepalive when asked',    !!putFn && /if \(keepalive\) init\.keepalive = true/.test(putFn[0]));
  assert('_doBidItemPut hits /api/bid-items',          !!putFn && /\$\{API_BASE\}\/bid-items/.test(putFn[0]));
  assert('  URL encodes id / projectId / projectKey',  !!putFn && /encodeURIComponent\(biId\)[\s\S]+encodeURIComponent\(projId\)[\s\S]+encodeURIComponent\(projectKey\)/.test(putFn[0]));
  // Fallback on 404 → saveProject (so a brand-new project still saves)
  assert('404 falls back to saveProject',              !!putFn && /r\.status === 404[\s\S]+saveProject\(projId\)/.test(putFn[0]));
  // Network catch does NOT call saveProject (would blow keepalive cap)
  assert('network catch does NOT call saveProject',    !!putFn && !/\.catch[\s\S]+saveProject/.test(putFn[0]));
}

structuralChecks('tracker.html', 'fct_project_',        'fct_projects_index');
structuralChecks('paving.html',  'fct_paving_project_', 'fct_paving_projects_index');

// Also verify the structural changes preserved structural-mutation paths
console.log('\n[structural — structural mutations still use saveProject]');
for (const file of ['tracker.html', 'paving.html']) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  for (const fnName of ['addBidSubCode', 'removeBidItem', 'removeBidGroup', 'updateBidGroupCode', '_addCO', '_removeCO']) {
    const m = src.match(new RegExp(`function ${fnName}\\([^)]*\\)[\\s\\S]+?\\n\\}\\n`));
    assert(`${file}: ${fnName} still calls saveProject`, !!m && /saveProject\(/.test(m[0]));
  }
}

// Schema check — the bid_items columns the endpoint writes must exist
console.log('\n[structural — schema columns]');
const schema = fs.readFileSync(path.resolve(__dirname, '../neon-schema.sql'), 'utf8');
for (const col of ['start_date', 'is_complete', 'change_orders']) {
  assert(`bid_items.${col} added via ALTER`, new RegExp(`ALTER TABLE bid_items[\\s\\S]+${col}`).test(schema));
}

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL — execute the real functions in a sandbox with mocks.
// ─────────────────────────────────────────────────────────────────────

function extractBlock(src, startLabel, endLabel) {
  const start = src.indexOf(startLabel);
  const end   = src.indexOf(endLabel, start);
  if (start < 0 || end < 0) throw new Error(`extractBlock: missing labels ${startLabel} / ${endLabel}`);
  return src.slice(start, end);
}

function makeSandbox(prefix) {
  const fetchCalls = [];
  const fakeFetch = (url, init) => {
    fetchCalls.push({ url, init });
    return Promise.resolve({
      ok: !init._forceStatus || init._forceStatus === 200,
      status: init._forceStatus || 200,
      json: () => Promise.resolve({}),
    });
  };

  const projects = {
    p1: { id: 'p1', bidItems: [
      { id: 'b1', cost_code: 'Tennis Demo', sub_code: 'Fence Removal', quantity: 100, unit_cost: 12.42, start_date: '', target_date: '' },
      { id: 'b2', cost_code: 'Tennis Demo', sub_code: 'Sealcoat',      quantity:  50, unit_cost: 14.10, start_date: '', target_date: '' },
    ] },
  };

  let savedKeepalive = null;
  let saveProjectCalls = 0;
  let showSaveErrorCalls = [];

  const ctx = {
    // Globals the functions reference
    PROJECTS_KEY:        'fct_projects_state',
    API_BASE:            '/api',
    fctToken:            'TEST_TOKEN',
    projectsList:        [projects.p1],
    _lastProjIndexTs:    0,
    _saveProjTimers:     {},
    _biSaveTimers:       {},
    _biSavePending:      {},

    getProj:             (id) => projects[id],
    _projBlob:           (p) => p,
    apiPut:              (key, value, opts) => { savedKeepalive = opts && opts.keepalive === true; },
    saveProject:         () => { saveProjectCalls++; },
    saveProjectIndex:    () => {},
    _showSaveError:      (isAuth, msg) => { showSaveErrorCalls.push({ isAuth, msg }); },
    fmt:                 (n) => String(n),
    renderBidFooter:     () => {},
    document:            { getElementById: () => null, addEventListener: () => {} },
    window:              { addEventListener: () => {} },
    localStorage:        { setItem: () => {}, getItem: () => null },
    JSON,
    setTimeout, clearTimeout,
    Date, Math, Object, Array, String, Number,
    encodeURIComponent,
    fetch:               fakeFetch,
    console:             { warn: () => {}, log: () => {}, error: () => {} },
  };

  // Expose state we want to inspect from outside
  ctx._test = {
    fetchCalls,
    get savedKeepalive()      { return savedKeepalive; },
    get saveProjectCalls()    { return saveProjectCalls; },
    get showSaveErrorCalls()  { return showSaveErrorCalls; },
  };

  vm.createContext(ctx);
  return ctx;
}

function evalBidItemBlock(ctx, file, projectKeyVar, indexKey) {
  // Pull a contiguous slice from `function _flushPendingProjectSaves`
  // through the end of the patchBidItem / _doBidItemPut block — these
  // three functions plus the addEventListener lines live together in
  // both tracker.html and paving.html. Avoids evaluating the whole
  // 18k-line file.
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const start = src.indexOf('function _flushPendingProjectSaves(');
  if (start < 0) throw new Error('_flushPendingProjectSaves not found in ' + file);
  // End at the next saveProjectIndex declaration (next major section)
  const endMarker = src.indexOf('\n// Save the ordered list of project IDs', start);
  if (endMarker < 0) throw new Error('Could not locate end-of-block marker in ' + file);
  const block = src.slice(start, endMarker);
  vm.runInContext(block, ctx);
}

async function tick(ms) { return new Promise(r => setTimeout(r, ms)); }

async function behaviouralSuite(file, projectKeyPrefix, indexKey) {
  console.log(`\n[behavioural — ${file}]`);
  const ctx = makeSandbox(projectKeyPrefix);
  evalBidItemBlock(ctx, file, projectKeyPrefix, indexKey);

  // ── 1. Debounce: no fetch within the window
  ctx.patchBidItem('p1', 'b1');
  await tick(50);
  assert('no fetch within debounce window (50ms)',  ctx._test.fetchCalls.length === 0);

  // ── 2. Multiple rapid edits to the same bid item coalesce to one fetch
  ctx.patchBidItem('p1', 'b1');
  ctx.patchBidItem('p1', 'b1');
  ctx.patchBidItem('p1', 'b1');
  await tick(700);
  assert('one fetch after debounce fires',           ctx._test.fetchCalls.length === 1);
  const call = ctx._test.fetchCalls[0];
  assert('URL contains id=b1',                       /id=b1/.test(call.url));
  assert('URL contains projectId=p1',                /projectId=p1/.test(call.url));
  assert(`URL contains projectKey=${projectKeyPrefix}p1`,
                                                     decodeURIComponent(call.url).includes(`projectKey=${projectKeyPrefix}p1`));
  assert('body has bidItem.id b1',                   JSON.parse(call.init.body).bidItem.id === 'b1');
  assert('body has numeric ts',                      typeof JSON.parse(call.init.body).ts === 'number');
  assert('normal path has NO keepalive',             call.init.keepalive !== true);
  assert('_lastProjIndexTs set optimistically',      ctx._lastProjIndexTs > 0);

  // ── 3. Edits to a DIFFERENT bid item don't coalesce — separate timers
  ctx._test.fetchCalls.length = 0;
  ctx.patchBidItem('p1', 'b1');
  ctx.patchBidItem('p1', 'b2');
  await tick(700);
  assert('two distinct bid items → two fetches',     ctx._test.fetchCalls.length === 2);
  const ids = ctx._test.fetchCalls.map(c => /id=([^&]+)/.exec(c.url)[1]).sort();
  assert('  fetches cover both b1 and b2',           ids[0] === 'b1' && ids[1] === 'b2');

  // ── 4. _flushPendingProjectSaves fires immediately with keepalive
  ctx._test.fetchCalls.length = 0;
  ctx.patchBidItem('p1', 'b1');
  // Don't wait for the debounce — flush should drain right away
  ctx._flushPendingProjectSaves();
  await tick(0);
  assert('flush fires synchronously, no debounce wait',
                                                     ctx._test.fetchCalls.length === 1);
  assert('flush sets keepalive:true on the request',  ctx._test.fetchCalls[0].init.keepalive === true);
  assert('flush clears _biSaveTimers entry',          Object.keys(ctx._biSaveTimers).length === 0);
  assert('flush clears _biSavePending entry',         Object.keys(ctx._biSavePending).length === 0);

  // ── 5. 404 falls back to saveProject
  ctx._test.fetchCalls.length = 0;
  const origFetch = ctx.fetch;
  ctx.fetch = (url, init) => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  ctx.patchBidItem('p1', 'b1');
  await tick(700);
  await tick(10);  // give the .then handler a tick to run
  assert('404 → saveProject fallback called',         ctx._test.saveProjectCalls >= 1);

  // ── 6. Network error does NOT call saveProject (would blow keepalive cap)
  const saveCallsBefore = ctx._test.saveProjectCalls;
  const bannerCallsBefore = ctx._test.showSaveErrorCalls.length;
  ctx.fetch = () => Promise.reject(new Error('offline'));
  ctx.patchBidItem('p1', 'b1');
  await tick(700);
  await tick(10);
  assert('network error does NOT call saveProject',   ctx._test.saveProjectCalls === saveCallsBefore);
  assert('network error surfaces save banner',        ctx._test.showSaveErrorCalls.length > bannerCallsBefore);

  ctx.fetch = origFetch;  // restore for safety even though we're done
}

(async () => {
  try {
    await behaviouralSuite('tracker.html', 'fct_project_',        'fct_projects_index');
    await behaviouralSuite('paving.html',  'fct_paving_project_', 'fct_paving_projects_index');
  } catch (err) {
    console.error('Behavioural suite crashed:', err);
    failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
