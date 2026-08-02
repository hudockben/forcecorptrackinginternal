#!/usr/bin/env node
'use strict';
/**
 * Tests for /api/timesheet-job-costcodes — the cost codes the payroll
 * approval split modal offers for a job.
 *
 * Run: node scripts/test-timesheet-costcodes.js
 *
 * The endpoint used to read the normalized bid_items table. Only turf project
 * blobs are ever synced into that table — api/lib/sync-normalized.js routes
 * fct_project_* and fct_projects*, and nothing else — so a paving or kiewit
 * job came back with an empty cost code list. api/timesheet-jobs.js lists
 * those jobs happily, because it reads the blobs, so the picker offered a job
 * and then had nothing to split labor against.
 *
 * It now reads the project blob for the right division prefix, which is the
 * source of truth every other endpoint uses.
 *
 * Layers:
 *   1. Routing — proves sync-normalized still ignores paving/kiewit, so the
 *      reason for reading blobs stays documented and a regression is visible.
 *   2. Behavioural — runs the real handler against a stubbed database.
 */

const path = require('path');
const Module = require('module');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const API = path.resolve(__dirname, '../api');

// ─────────────────────────────────────────────────────────────────────
// 1) Why this endpoint cannot use the normalized mirror
// ─────────────────────────────────────────────────────────────────────
console.log('\n[normalized sync only covers turf]');
{
  const { syncForKey } = require(path.join(API, 'lib/sync-normalized.js'));
  const proj = { id: 'p1', 'project-name': 'T', bidItems: [{ id: 'b1', cost_code: 'CC', sub_code: 'SC' }] };
  const run = async key => {
    const stmts = [];
    const sql = (strings) => { stmts.push(strings.join('?')); return Promise.resolve([]); };
    await syncForKey(sql, 'ACME', key, proj);
    return stmts.length;
  };
  (async () => {
    assert('turf project blob syncs',            await run('fct_project_p1') > 0);
    assert('paving project blob syncs nothing',  await run('fct_paving_project_p1') === 0);
    assert('kiewit project blob syncs nothing',  await run('fct_kiewit_project_p1') === 0);
    assert('paving index syncs nothing',         await run('fct_paving_projects_index') === 0);
    assert('kiewit index syncs nothing',         await run('fct_kiewit_projects_index') === 0);
    await behavioural();
  })();
}

// ─────────────────────────────────────────────────────────────────────
// 2) The handler, against a stubbed database
// ─────────────────────────────────────────────────────────────────────
async function behavioural() {
  const store = {};
  const orig = Module._load;
  Module._load = function (req, parent) {
    if (req === '@neondatabase/serverless') {
      return { neon: () => (strings, ...vals) => {
        const q = strings.join(' ').replace(/\s+/g, ' ');
        if (/FROM app_data/.test(q)) return Promise.resolve(store[vals[0]] ? [{ value: store[vals[0]] }] : []);
        // If the handler ever queries the mirror again this stays empty, and
        // the paving/kiewit assertions below fail — which is the point.
        if (/FROM bid_items/.test(q)) return Promise.resolve([]);
        return Promise.resolve([]);
      }};
    }
    if (req === './lib/auth' && parent && parent.filename.includes('timesheet-job-costcodes')) {
      return {
        requireAuth: () => ({ companyCode: 'ACME', isPlatformAdmin: true }),
        hasDivisionAccess: () => true,
      };
    }
    return orig.apply(this, arguments);
  };

  const handler = require(path.join(API, 'timesheet-job-costcodes.js'));
  const bid = (cc, sc) => ({ id: 'b' + Math.random(), cost_code: cc, sub_code: sc });
  store['ACME:fct_project_T1']        = { id: 'T1', bidItems: [bid('Site Prep', 'Excavation'), bid('Site Prep', 'Grading'), bid('Concrete', 'Slab')] };
  store['ACME:fct_paving_project_P1'] = { id: 'P1', bidItems: [bid('Milling', 'Cold Plane'), bid('Paving', 'Base Course'), bid('Paving', '')] };
  store['ACME:fct_kiewit_project_K1'] = { id: 'K1', bidItems: [bid('Structures', 'Precast')] };
  store['ACME:fct_project_EMPTY']     = { id: 'EMPTY', bidItems: [] };

  const call = (division, jobId) => new Promise(resolve => {
    const req = { method: 'GET', query: { division, jobId }, headers: {} };
    const res = {
      setHeader() {}, status(c) { this._c = c; return this; },
      json(o) { resolve({ code: this._c || 200, body: o }); }, end() { resolve({ code: this._c }); },
    };
    handler(req, res);
  });

  console.log('\n[every division resolves its own jobs]');
  const t = await call('turf', 'T1');
  assert('turf job returns its cost codes',
    t.body.cost_codes.length === 2 && t.body.cost_codes[0].cost_code === 'Concrete',
    JSON.stringify(t.body.cost_codes));
  const p = await call('paving', 'P1');
  assert('paving job returns its cost codes', p.body.cost_codes.length === 2, JSON.stringify(p.body.cost_codes));
  const k = await call('kiewit', 'K1');
  assert('kiewit job returns its cost codes', k.body.cost_codes.length === 1, JSON.stringify(k.body.cost_codes));

  console.log('\n[grouping and edge cases]');
  assert('sub codes group under their cost code, blank preserved',
    JSON.stringify(p.body.cost_codes.find(c => c.cost_code === 'Paving').sub_codes) === JSON.stringify(['', 'Base Course']),
    JSON.stringify(p.body.cost_codes));
  assert('cost codes come back sorted',
    t.body.cost_codes.map(c => c.cost_code).join() === 'Concrete,Site Prep');
  const cross = await call('paving', 'T1');
  assert('a job id from another division resolves to nothing, not another job\'s codes',
    cross.body.cost_codes.length === 0, JSON.stringify(cross.body.cost_codes));
  const missing = await call('turf', 'NOPE');
  assert('an unknown job is an empty list, not an error',
    missing.code === 200 && missing.body.cost_codes.length === 0, JSON.stringify(missing));
  const empty = await call('turf', 'EMPTY');
  assert('a job with no bid items is an empty list', empty.body.cost_codes.length === 0);
  const bad = await call('quarry', 'X');
  assert('an unsupported division is still rejected', bad.code === 400);
  const noJob = await call('turf', '');
  assert('a missing jobId is still rejected', noJob.code === 400);

  Module._load = orig;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
