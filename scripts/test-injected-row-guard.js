#!/usr/bin/env node
'use strict';
/**
 * Payroll-injected daily_tracking rows: un-approve must actually take them away.
 *
 * Run: node scripts/test-injected-row-guard.js
 *
 * Approving a timesheet entry injects daily_tracking rows tagged with a
 * timesheet_entry_id and a row_id of "ts<entryId>-…"; un-approving deletes
 * them. The rows kept coming back anyway, from two directions:
 *
 *   - the division tab re-created them (Reload falling through to the legacy
 *     blob, a project-recovery re-migration, a queued PUT), and neither the
 *     POST nor the PUT upsert carries timesheet_entry_id, so the resurrected
 *     row was UNLINKED — no TS badge, editable, immune to the next un-approve,
 *     double-counted on re-approval;
 *   - Reload only replaced p.dailyRows when the server returned at least one
 *     row, so un-approving the LAST rows of a project left them on screen.
 *
 * Three layers, no DB or server required:
 *   1. api/daily-rows.js — POST skips injected rows, PUT 409s instead of
 *      resurrecting one, live injected rows still take a partial update, and
 *      ordinary rows are untouched.
 *   2. Structural greps over tracker.html / paving.html / kiewit-pinetree.html.
 *   3. reloadDailyRows evaluated in a vm: an empty server snapshot clears the
 *      table instead of falling back to (and re-POSTing) the legacy blob.
 */

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const Module = require('module');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ─────────────────────────────────────────────────────────────────────
// 1) api/daily-rows.js — the server-side guard
// ─────────────────────────────────────────────────────────────────────

// Stub the two modules the handler pulls in at load time so it can run with no
// node_modules and no auth. Must be installed before the require below.
let CURRENT_SQL = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireDivision: () => ({ payload: { companyCode: 'FCT' }, division: 'turf' }),
      requireAuth:     () => ({ payload: { companyCode: 'FCT' } }),
      hasDivisionAccess: () => true,
    };
  }
  return origLoad.apply(this, arguments);
};

const dailyRows = require(path.resolve(__dirname, '..', 'api', 'daily-rows.js'));
const { isInjectedRowId } = dailyRows._test;

// Mock res — records status + body.
function makeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = c => { res.statusCode = c; return res; };
  res.json   = b => { res.body = b; return res; };
  res.end    = () => res;
  return res;
}

// Mock of the neon tagged template. `rows` seeds the daily_tracking table
// (row_id → { timesheet_entry_id }); every statement is recorded for assertions.
function makeSql(seed = {}) {
  const log = [];
  const table = new Map(Object.entries(seed));
  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();
    log.push({ q, values });
    if (/^SELECT timesheet_entry_id FROM daily_tracking/.test(q)) {
      const rowId = String(values[0]);
      return Promise.resolve(table.has(rowId) ? [table.get(rowId)] : []);
    }
    return Promise.resolve([]);
  };
  sql.log = log;
  sql.inserts = () => log.filter(e => /^INSERT INTO daily_tracking/.test(e.q));
  sql.updates = () => log.filter(e => /^UPDATE daily_tracking/.test(e.q));
  return sql;
}

async function call(req, sql) {
  CURRENT_SQL = sql;
  const res = makeRes();
  await dailyRows(req, res);
  return res;
}

async function apiTests() {
  console.log('\n[api/daily-rows.js]');

  assert('isInjectedRowId: ts<entryId>- id is payroll-owned', isInjectedRowId('ts42-1700000000000-0-123456'));
  assert('isInjectedRowId: numeric manual id is not',        !isInjectedRowId('1754491234567.1234'));
  assert('isInjectedRowId: bare "ts" prefix is not',         !isInjectedRowId('tsomething-1'));
  assert('isInjectedRowId: null/undefined is not',           !isInjectedRowId(null) && !isInjectedRowId(undefined));

  // POST — injected rows are dropped, ordinary rows still land.
  {
    const sql = makeSql();
    const res = await call({
      method: 'POST', query: {}, body: {
        projectId: 'p1',
        rows: [
          { id: 'ts42-1700000000000-0-1', labor_hours: '8' },   // payroll's
          { id: '1754491234567.12',       labor_hours: '4' },   // a real manual row
        ],
      },
    }, sql);
    assert('POST: 200 with a skipped count',   res.statusCode === 200 && res.body.skipped === 1, JSON.stringify(res.body));
    assert('POST: manual row still inserted',  res.body.inserted === 1);
    assert('POST: only one INSERT issued',     sql.inserts().length === 1);
    assert('POST: the injected id never reaches the DB',
      !sql.inserts().some(e => e.values.some(v => String(v).startsWith('ts42-'))));
  }

  // POST — a batch that is nothing but injected rows writes nothing at all.
  {
    const sql = makeSql();
    const res = await call({
      method: 'POST', query: {},
      body: { projectId: 'p1', rows: [{ id: 'ts42-1-0-1' }, { id: 'ts43-1-0-1' }] },
    }, sql);
    assert('POST: all-injected batch inserts nothing', sql.inserts().length === 0 && res.body.inserted === 0);
    assert('POST: all-injected batch reports skipped', res.body.skipped === 2);
  }

  // PUT — the row is gone and payroll owns the id: refuse, do not resurrect.
  {
    const sql = makeSql();   // empty table = the un-approve already deleted it
    const res = await call({
      method: 'PUT', query: { id: 'ts42-1700000000000-0-1' },
      body: { projectId: 'p1', row: { id: 'ts42-1700000000000-0-1', labor_hours: '8' } },
    }, sql);
    assert('PUT: 409 on a deleted injected row', res.statusCode === 409, `got ${res.statusCode}`);
    assert('PUT: response marks the row removed', res.body && res.body.removed === true);
    assert('PUT: nothing was re-inserted',        sql.inserts().length === 0);
  }

  // PUT — a live injected row still takes the whitelisted partial update.
  {
    const sql = makeSql({ 'ts42-1700000000000-0-1': { timesheet_entry_id: 42 } });
    const res = await call({
      method: 'PUT', query: { id: 'ts42-1700000000000-0-1' },
      body: { projectId: 'p1', row: { cost_code: 'CC1', sub_code: 'SC1', quantity: '3' } },
    }, sql);
    assert('PUT: live injected row → partial update', res.statusCode === 200 && res.body.partial === true);
    assert('PUT: partial update issued an UPDATE',    sql.updates().length === 1);
  }

  // PUT — an ordinary row missing from the DB still upserts (offline replay).
  {
    const sql = makeSql();
    const res = await call({
      method: 'PUT', query: { id: '1754491234567.12' },
      body: { projectId: 'p1', row: { id: '1754491234567.12', labor_hours: '4' } },
    }, sql);
    assert('PUT: ordinary row still upserts', res.statusCode === 200 && sql.inserts().length === 1);
  }

  // DELETE — a live injected row is still refused from the division tab.
  {
    const sql = makeSql({ 'ts42-1-0-1': { timesheet_entry_id: 42 } });
    const res = await call({ method: 'DELETE', query: { id: 'ts42-1-0-1' } }, sql);
    assert('DELETE: injected row still 409s', res.statusCode === 409);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 1b) api/timesheet-entries.js — un-approve sweeps unlinked rows too
// ─────────────────────────────────────────────────────────────────────

async function removeSplitRowsTests() {
  console.log('\n[api/timesheet-entries.js — removeSplitRows]');
  const { removeSplitRows } = require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'))._test;

  // Mock table: rows keyed by row_id, each { company_code, timesheet_entry_id }.
  function makeTable(rows) {
    const store = new Map(Object.entries(rows));
    const matches = (companyCode, entryId, like) => {
      const prefix = like.slice(0, -1);   // drop the trailing %
      return [...store.entries()].filter(([rowId, r]) =>
        r.company_code === companyCode &&
        (String(r.timesheet_entry_id) === String(entryId) || rowId.startsWith(prefix)));
    };
    const sql = (strings, ...values) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      const [companyCode, entryId, like] = values;
      const hit = matches(companyCode, entryId, like);
      if (q.startsWith('SELECT COUNT(*)')) return Promise.resolve([{ cnt: hit.length }]);
      if (q.startsWith('DELETE FROM daily_tracking')) { hit.forEach(([rowId]) => store.delete(rowId)); return Promise.resolve([]); }
      return Promise.resolve([]);
    };
    return { sql, store };
  }

  {
    const { sql, store } = makeTable({
      'ts42-a-0-1': { company_code: 'FCT', timesheet_entry_id: 42 },   // still linked
      'ts42-b-0-2': { company_code: 'FCT', timesheet_entry_id: null }, // link lost
      'ts421-a-0-1': { company_code: 'FCT', timesheet_entry_id: 421 }, // a different entry
      '17544912.5': { company_code: 'FCT', timesheet_entry_id: null }, // a manual row
      'ts42-c-0-3': { company_code: 'OTHER', timesheet_entry_id: null },// another company
    });
    const removed = await removeSplitRows(sql, 'FCT', 42);
    assert('un-approve removes both linked and unlinked rows', removed === 2, `removed ${removed}`);
    assert('un-approve leaves entry 421 alone',                store.has('ts421-a-0-1'));
    assert('un-approve leaves manual rows alone',              store.has('17544912.5'));
    assert('un-approve never crosses companies',               store.has('ts42-c-0-3'));
    assert('un-approve emptied this entry',                   !store.has('ts42-a-0-1') && !store.has('ts42-b-0-2'));
  }

  {
    const { sql } = makeTable({});
    assert('un-approve on an entry with no rows returns 0', (await removeSplitRows(sql, 'FCT', 7)) === 0);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2) Structural — the same guards in every division app
// ─────────────────────────────────────────────────────────────────────

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];

function readApp(file) {
  return fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
}

function structuralChecks(file) {
  console.log(`\n[structural — ${file}]`);
  const src = readApp(file);

  assert('defines _drIsInjectedRow',            /function _drIsInjectedRow\(row\)/.test(src));
  assert('defines _drDropRowLocally',           /function _drDropRowLocally\(rowId\)/.test(src));
  assert('drPost refuses injected rows',        /function drPost\(projectId, row\) \{\s*\n\s*if \(_drIsInjectedRow\(row\)\)/.test(src));
  assert('drPostBulk filters injected rows',    /async function drPostBulk\(projectId, allRows\)[\s\S]{0,220}filter\(r => !_drIsInjectedRow\(r\)\)/.test(src));
  assert('PUT 409 drops the row locally',       /if \(r\.status === 409\) \{\s*\n\s*_drDropRowLocally\(rowId\);/.test(src));
  assert('WAL replay 409 drops the row',        /if \(r\.status === 409\) _drDropRowLocally\(entry\.rowId\);/.test(src));
  assert('migration skips injected rows',       /\.map\(p => \(\{ p, rows: \(p\.dailyRows \|\| \[\]\)\.filter\(r => !_drIsInjectedRow\(r\)\) \}\)\)/.test(src));
  assert('reload no longer gates on rows.length > 0',
    !/const \{ rows \} = await r\.json\(\);\s*\n\s*if \(Array\.isArray\(rows\) && rows\.length > 0\)/.test(src));
  assert('reload accepts an empty snapshot when memory has rows',
    /if \(rows && \(rows\.length > 0 \|\| \(Array\.isArray\(p\.dailyRows\) && p\.dailyRows\.length > 0\)\)\)/.test(src));
  assert('reload only treats a real array as an answer',
    /const rows = Array\.isArray\(body && body\.rows\) \? body\.rows : null;/.test(src));
  assert('focus refresh survives a WAL replay failure',
    /Promise\.resolve\(_walReplay\(\)\)\.catch\(\(\) => \{\}\)\.then\(_drRefreshOnFocus\)/.test(src));
  // api/lib/auth.js defaults a MISSING division to 'turf'. A project-scoped
  // reload that omits it therefore asks turf for paving's rows, gets an empty
  // answer, and — now that an empty snapshot is authoritative — wipes a table
  // that had just loaded correctly. Every daily-rows call must be scoped.
  assert('the project reload sends its division',
    /daily-rows\?division=\$\{DIVISION\}&projectId=/.test(src));
  assert('no daily-rows call is left unscoped',
    !/daily-rows\?projectId=/.test(src));
  assert('daily view refreshes when the tab regains focus',
    /function _drRefreshOnFocus\(\)/.test(src) && /window\.addEventListener\('focus', _drRefreshOnFocus\)/.test(src));
}

// ─────────────────────────────────────────────────────────────────────
// 3) Behavioural — reloadDailyRows in a sandbox
// ─────────────────────────────────────────────────────────────────────

// Pull a top-level function out of the HTML by its signature, up to the first
// closing brace in column 0.
function extractFn(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return null;
  const end = src.indexOf('\n}\n', i);
  return end < 0 ? null : src.slice(i, end + 2);
}

async function behaviouralChecks(file) {
  console.log(`\n[behavioural — ${file}]`);
  const src = readApp(file);

  const parts = [
    extractFn(src, 'function _drIsInjectedRow(row) {'),
    extractFn(src, 'function _drRowHasPendingWrite(id) {'),     // tracker.html only
    extractFn(src, 'function _mergeReloadedRows(prev, incoming) {'), // tracker.html only
    extractFn(src, 'async function reloadDailyRows(projId) {'),
  ].filter(Boolean);
  assert('extracted reloadDailyRows + helpers', parts.length >= 2, `got ${parts.length} block(s)`);

  const hasMerge = /function _mergeReloadedRows/.test(parts.join('\n'));

  // One sandbox per scenario so state never leaks between them.
  function run(scenario) {
    const calls = { postBulk: [], legacyReads: 0, renders: 0 };
    const proj  = { id: 'p1', dailyRows: scenario.memoryRows.slice() };
    const sandbox = {
      console,
      API_BASE: '/api',
      DIVISION: 'paving',   // the reload is division-scoped; a bare projectId asks turf
      fctToken: 't',
      dailyViewProjId: 'p1',
      projectsList: [proj],
      _aggCacheRowCount: 0,
      _projSubAggCacheRowCount: 0,
      _drSavePending: scenario.pending || {},
      _walRead: () => scenario.wal || {},
      getProj: () => proj,
      logout: () => { throw new Error('unexpected logout'); },
      renderDailyTable: () => { calls.renders++; },
      drPostBulk: (id, rows) => { calls.postBulk.push({ id, rows }); },
      apiGet: () => { calls.legacyReads++; return Promise.resolve(scenario.legacyBlob || null); },
      fetch: () => Promise.resolve({
        ok: scenario.httpOk !== false, status: scenario.httpOk === false ? 500 : 200,
        json: () => scenario.badBody
          ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
          : Promise.resolve(scenario.bodyOverride || { rows: scenario.serverRows }),
      }),
      document: { getElementById: () => null },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(parts.join('\n\n'), sandbox);
    return sandbox.reloadDailyRows('p1').then(() => ({ proj, calls }));
  }

  const injected = { id: 'ts42-1700000000000-0-1', labor_hours: '8', timesheet_entry_id: '42' };
  const manual   = { id: '1754491234567.12', labor_hours: '4' };

  // The reported bug: un-approving the last entries of a project emptied it
  // server-side, and Reload left the rows sitting in the table.
  {
    const { proj, calls } = await run({ memoryRows: [injected, manual], serverRows: [],
                                        legacyBlob: [{ id: 'p1', dailyRows: [injected] }] });
    assert('empty snapshot clears the table',        proj.dailyRows.length === 0, JSON.stringify(proj.dailyRows));
    assert('empty snapshot skips the legacy blob',   calls.legacyReads === 0);
    assert('empty snapshot re-POSTs nothing',        calls.postBulk.length === 0);
    assert('empty snapshot re-renders the view',     calls.renders === 1);
  }

  // Normal refresh: the server snapshot wins.
  {
    const { proj } = await run({ memoryRows: [manual], serverRows: [injected] });
    assert('non-empty snapshot replaces memory',
      proj.dailyRows.length === 1 && proj.dailyRows[0].id === injected.id);
  }

  // Clearing the table is only ever allowed on a real answer. A body that
  // cannot be parsed, one served with the wrong shape, and a failed request all
  // have to leave what is on screen alone — silently emptying a supervisor's
  // cost tracking because a proxy returned an HTML error page would be worse
  // than the bug this whole change fixes.
  {
    const { proj } = await run({ memoryRows: [injected, manual], serverRows: [], badBody: true });
    assert('unparseable body leaves the rows alone', proj.dailyRows.length === 2);
  }
  {
    const { proj } = await run({ memoryRows: [injected, manual], serverRows: [],
                                 bodyOverride: { error: 'nope' } });
    assert('unexpected body shape leaves the rows alone', proj.dailyRows.length === 2);
  }
  {
    const { proj } = await run({ memoryRows: [injected, manual], serverRows: [], httpOk: false });
    assert('failed request leaves the rows alone', proj.dailyRows.length === 2);
  }

  // The legacy-blob recovery still works for its real case: nothing in the DB
  // AND nothing in memory, from before rows were migrated out of the blob.
  {
    const { proj, calls } = await run({ memoryRows: [], serverRows: [],
                                        legacyBlob: [{ id: 'p1', dailyRows: [manual] }] });
    assert('pre-migration project still recovers from the blob',
      proj.dailyRows.length === 1 && proj.dailyRows[0].id === manual.id);
    assert('recovered blob rows are persisted to the DB', calls.postBulk.length === 1);
  }

  if (hasMerge) {
    // A pending local write protects a manual row from a stale snapshot…
    {
      const { proj } = await run({ memoryRows: [manual], serverRows: [],
                                   pending: { [manual.id]: manual } });
      assert('pending manual row survives an empty snapshot',
        proj.dailyRows.length === 1 && proj.dailyRows[0].id === manual.id);
    }
    // …but never an injected one: payroll removed it, and the queued write is
    // rejected by the server anyway.
    {
      const { proj } = await run({ memoryRows: [injected], serverRows: [],
                                   pending: { [injected.id]: injected } });
      assert('pending injected row is dropped anyway', proj.dailyRows.length === 0);
    }
  }
}

(async () => {
  await apiTests();
  await removeSplitRowsTests();
  for (const f of FILES) structuralChecks(f);
  for (const f of FILES) await behaviouralChecks(f);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
