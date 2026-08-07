#!/usr/bin/env node
'use strict';
/**
 * Two ways a daily tracking row could be overwritten by something the user
 * never aimed at. Both were found auditing a report of "labor hours and sub
 * codes look wiped" — neither caused that report, but both are real.
 *
 * Run: node scripts/test-daily-row-overwrite-guards.js
 *
 *   1. _syncPOHeaderToLines pushed the PO's cost_code and sub_code onto every
 *      linked daily row on ANY header edit. Renaming a PO's title, or fixing
 *      its supplier, silently undid a re-categorization the supervisor had
 *      made on the row. The codes now ride along only when the PO's own codes
 *      are what changed, which is the sub-code combobox commit and nothing
 *      else.
 *
 *   2. The fill-handle drag took its write range from data-i, which indexes
 *      p.dailyRows — but a column filter hides rows without renumbering the
 *      rest, so those indices have gaps. Dragging between two VISIBLE rows
 *      wrote to every hidden row caught between them. The write set now comes
 *      from the DOM, so it matches the rows the drag highlighted.
 *
 * No DB, no server, no browser: structural greps over the three division apps
 * plus both units evaluated in a vm sandbox with a hand-built DOM.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const readApp = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

// Pull a top-level function out of the HTML by its signature, up to the first
// closing brace in column 0.
function extractFn(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return null;
  const end = src.indexOf('\n}\n', i);
  return end < 0 ? null : src.slice(i, end + 2);
}

// The fill-drag commit is an anonymous document-level listener, and tracker.html
// registers three of them. Anchor on the destructure that only this one does,
// then walk back to its addEventListener and forward to the matching close.
function extractFillDragCommit(src) {
  const anchor = src.indexOf('const { projId, field, srcIdx, endIdx, value } = _fillDrag;');
  if (anchor < 0) return null;
  const start = src.lastIndexOf("document.addEventListener('mouseup'", anchor);
  if (start < 0) return null;
  const end = src.indexOf('\n});', start);
  return end < 0 ? null : src.slice(start, end + 4);
}

// ─────────────────────────────────────────────────────────────────────
// 1) Structural — the same guards in every division app
// ─────────────────────────────────────────────────────────────────────

function structuralChecks(file) {
  console.log(`\n[structural — ${file}]`);
  const src = readApp(file);

  // — PO header sync —
  assert('_syncPOHeaderToLines takes a syncCodes flag',
    /function _syncPOHeaderToLines\(po, syncCodes\) \{/.test(src));
  assert('the codes are written only under that flag',
    /if \(syncCodes\) \{\s*\n\s*r\.cost_code = po\.cost_code\|\| '';\s*\n\s*r\.sub_code  = po\.sub_code \|\| '';\s*\n\s*\}/.test(src));
  assert('no unconditional code write survives',
    !/r\.supplier  = po\.supplier \|\| '';\s*\n\s*r\.cost_code = po\.cost_code/.test(src));
  assert('material / supplier / po_num still sync unconditionally',
    /r\.material  = po\.title    \|\| '';\s*\n\s*r\.supplier  = po\.supplier \|\| '';\s*\n\s*r\.po_num    = po\.po_number\|\| '';/.test(src));
  assert('the sub-code commit opts in to the code sync',
    /_syncPOHeaderToLines\(po, true\);/.test(src));
  assert('exactly one call site opts in',
    (src.match(/_syncPOHeaderToLines\(po, true\)/g) || []).length === 1);
  assert('the title / supplier / date branch does not',
    /title \/ supplier \/ date_created changes[\s\S]{0,140}\n\s*_syncPOHeaderToLines\(po\);/.test(src));

  // — fill-handle drag —
  assert('the drag no longer walks the raw index range',
    !/for \(let i = srcIdx \+ 1; i <= endIdx; i\+\+\)/.test(src));
  assert('the drag collects its targets from the DOM',
    /const targets = \[\];[\s\S]{0,320}if \(ri > srcIdx && ri <= endIdx\) targets\.push\(\{ i: ri, tr \}\);/.test(src));
  assert('the drag writes only to those targets',
    /targets\.forEach\(\(\{ i, tr \}\) => \{/.test(src));
  assert('the injected-row whitelist still gates the drag',
    /if \(isInj && !INJECTED_EDITABLE_FIELDS\.has\(field\)\) return;/.test(src));
}

// ─────────────────────────────────────────────────────────────────────
// 2) Behavioural — _syncPOHeaderToLines in a sandbox
// ─────────────────────────────────────────────────────────────────────

function poSyncChecks(file) {
  console.log(`\n[behavioural: PO header sync — ${file}]`);
  const src = readApp(file);
  const fn  = extractFn(src, 'function _syncPOHeaderToLines(po, syncCodes) {');
  assert('extracted _syncPOHeaderToLines', !!fn);
  if (!fn) return;

  // The supervisor re-categorized the material row after the PO created it:
  // the PO still says Paving / Base, the row says Excavation / Haul.
  function run(syncCodes) {
    const row = {
      id: 'r1', material: 'old title', supplier: 'old supplier', po_num: 'PO-1',
      cost_code: 'Excavation', sub_code: 'Haul', labor_hours: '4',
    };
    const proj = { id: 'p1', dailyRows: [row] };
    const po = {
      project_id: 'p1', title: 'new title', supplier: 'new supplier',
      po_number: 'PO-1', cost_code: 'Paving', sub_code: 'Base',
      lines: [{ po_row_id: 'r1' }],
    };
    const puts = [];
    const sandbox = {
      console,
      getProj: () => proj,
      drPutNow: (id, r) => puts.push({ id, cost_code: r.cost_code, sub_code: r.sub_code }),
      renderDailyTable: () => {},
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fn, sandbox);
    sandbox._syncPOHeaderToLines(po, syncCodes);
    return { row, puts };
  }

  // The bug: editing the title used to drag the PO's codes along with it.
  {
    const { row, puts } = run(undefined);
    assert('a header-only edit leaves cost_code alone', row.cost_code === 'Excavation', row.cost_code);
    assert('a header-only edit leaves sub_code alone',  row.sub_code  === 'Haul',       row.sub_code);
    assert('a header-only edit still pushes the title', row.material  === 'new title',  row.material);
    assert('a header-only edit still pushes the supplier', row.supplier === 'new supplier', row.supplier);
    assert('the row is still persisted',                puts.length === 1);
    assert('the persisted row carries the kept codes',
      puts[0] && puts[0].cost_code === 'Excavation' && puts[0].sub_code === 'Haul',
      JSON.stringify(puts[0]));
  }

  // The behaviour that must survive: changing the PO's own codes still lands.
  {
    const { row, puts } = run(true);
    assert('a code change propagates cost_code',        row.cost_code === 'Paving', row.cost_code);
    assert('a code change propagates sub_code',         row.sub_code  === 'Base',   row.sub_code);
    assert('the persisted row carries the new codes',
      puts[0] && puts[0].cost_code === 'Paving' && puts[0].sub_code === 'Base',
      JSON.stringify(puts[0]));
  }

  // A PO whose codes were never set must not blank a row that has them.
  {
    const row  = { id: 'r1', cost_code: 'Excavation', sub_code: 'Haul' };
    const proj = { id: 'p1', dailyRows: [row] };
    const po   = { project_id: 'p1', title: 't', lines: [{ po_row_id: 'r1' }] };
    const sandbox = { console, getProj: () => proj, drPutNow: () => {}, renderDailyTable: () => {} };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fn, sandbox);
    sandbox._syncPOHeaderToLines(po);
    assert('an uncoded PO cannot blank the row it is linked to',
      row.cost_code === 'Excavation' && row.sub_code === 'Haul',
      JSON.stringify(row));
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3) Behavioural — the fill-handle drag in a sandbox
// ─────────────────────────────────────────────────────────────────────

function fillDragChecks(file) {
  console.log(`\n[behavioural: fill-handle drag — ${file}]`);
  const src  = readApp(file);
  const body = extractFillDragCommit(src);
  assert('extracted the fill-drag commit handler', !!body);
  if (!body) return;

  // rows: every row in p.dailyRows. visible: the indices the filter left on
  // screen, in render order — which is what the drag can actually span.
  function run({ rows, visible, field, srcIdx, endIdx, value }) {
    const puts = [];
    const cells = {};
    const trFor = i => ({
      querySelector(sel) {
        if (sel === `[data-proj="p1"][data-f]`) return { dataset: { i: String(i) } };
        if (sel === `[data-f="${field}"]`) return (cells[i] = cells[i] || { value: rows[i][field] });
        return null;
      },
    });
    const tbody = { children: visible.map(trFor) };
    const proj  = { id: 'p1', dailyRows: rows };

    const handlers = {};
    const sandbox = {
      console,
      INJECTED_EDITABLE_FIELDS: new Set(['cost_code', 'sub_code', 'job_class', 'quantity']),
      getProj: () => proj,
      drPutNow: (id, row) => puts.push({ id, value: row[field] }),
      renderDailyCalcCells: () => {},
      document: {
        addEventListener: (type, fn) => { handlers[type] = fn; },
        getElementById: id => (id === 'daily-tbody-p1' ? tbody : null),
        querySelectorAll: () => [],
        body: { style: {} },
      },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // _fillDrag is `let` in the app, which never lands on the sandbox object.
    // Declare it here with the state mousedown/mousemove would have left.
    vm.runInContext(
      `var _fillDrag = ${JSON.stringify({ projId: 'p1', field, srcIdx, endIdx, value })};\n${body}`,
      sandbox,
    );
    handlers.mouseup();
    return { rows, puts, cells };
  }

  const mk = (i, over) => Object.assign({ id: 'r' + i, sub_code: 'keep' + i }, over);

  // No filter: rows 0..4 all on screen, drag 0 → 3.
  {
    const rows = [0, 1, 2, 3, 4].map(i => mk(i));
    const { puts } = run({ rows, visible: [0, 1, 2, 3, 4], field: 'sub_code', srcIdx: 0, endIdx: 3, value: 'X' });
    assert('unfiltered drag fills every row in the span',
      rows[1].sub_code === 'X' && rows[2].sub_code === 'X' && rows[3].sub_code === 'X');
    assert('unfiltered drag leaves the source row alone',  rows[0].sub_code === 'keep0');
    assert('unfiltered drag stops at the end of the span', rows[4].sub_code === 'keep4');
    assert('unfiltered drag persists exactly the filled rows', puts.length === 3, JSON.stringify(puts));
  }

  // The bug: rows 1 and 2 are filtered out. Dragging from visible row 0 to
  // visible row 3 used to write to the two hidden rows in between.
  {
    const rows = [0, 1, 2, 3, 4].map(i => mk(i));
    const { puts } = run({ rows, visible: [0, 3, 4], field: 'sub_code', srcIdx: 0, endIdx: 3, value: 'X' });
    assert('filtered drag fills the visible target',   rows[3].sub_code === 'X');
    assert('filtered drag skips hidden row 1',         rows[1].sub_code === 'keep1', rows[1].sub_code);
    assert('filtered drag skips hidden row 2',         rows[2].sub_code === 'keep2', rows[2].sub_code);
    assert('filtered drag persists only the visible row', puts.length === 1, JSON.stringify(puts));
    assert('the persisted row is the visible one',     puts[0] && puts[0].id === 'r3', JSON.stringify(puts[0]));
  }

  // An injected row inside the span: editable fields fill, locked ones do not.
  {
    const rows = [mk(0), mk(1, { timesheet_entry_id: '42' }), mk(2)];
    run({ rows, visible: [0, 1, 2], field: 'sub_code', srcIdx: 0, endIdx: 2, value: 'X' });
    assert('a whitelisted field still fills an injected row', rows[1].sub_code === 'X');
  }
  {
    const rows = [
      { id: 'r0', labor_hours: '1' },
      { id: 'r1', labor_hours: '2', timesheet_entry_id: '42' },
      { id: 'r2', labor_hours: '3' },
    ];
    const { puts } = run({ rows, visible: [0, 1, 2], field: 'labor_hours', srcIdx: 0, endIdx: 2, value: '9' });
    assert('a locked field cannot be dragged onto an injected row', rows[1].labor_hours === '2', rows[1].labor_hours);
    assert('the ordinary row beside it still fills',                rows[2].labor_hours === '9');
    assert('the injected row is not persisted',                     puts.length === 1 && puts[0].id === 'r2',
      JSON.stringify(puts));
  }

  // Dragging upward is a no-op — endIdx <= srcIdx bails before any write.
  {
    const rows = [0, 1, 2].map(i => mk(i));
    const { puts } = run({ rows, visible: [0, 1, 2], field: 'sub_code', srcIdx: 2, endIdx: 0, value: 'X' });
    assert('an upward drag writes nothing',
      puts.length === 0 && rows.every((r, i) => r.sub_code === 'keep' + i));
  }
}

// ─────────────────────────────────────────────────────────────────────

(function main() {
  for (const f of FILES) {
    structuralChecks(f);
    poSyncChecks(f);
    fillDragChecks(f);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
