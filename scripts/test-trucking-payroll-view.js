#!/usr/bin/env node
'use strict';
/**
 * A division's Trucking tab lists the trucking payroll auto-inserted into its
 * jobs' Daily Tracking, beside the tab's own entries.
 *
 * Run: node scripts/test-trucking-payroll-view.js
 *
 * The Trucking tab already pushed its own entries INTO a job's Daily Tracking
 * (tr_row_id). The other direction was missing: a driver's haul approved
 * through payroll — Triaxle Dump, $121 × 10.5 h on Juniata Softball — landed on
 * the job but never showed in the division's Trucking tab, so turf or paving
 * could not scan its trucking in one place. Purchase orders already work both
 * ways; this is the same for trucking.
 *
 * Three layers, no DB or server required:
 *   1. isPayrollTruckingRow — which injected rows are trucking.
 *   2. GET /api/daily-rows?trucking=1 — scoped to the caller's company and
 *      division, and only trucking rows come back.
 *   3. The Trucking tab, run from each division page's own source in a vm:
 *      payroll rows are listed read-only, filtered and exported with the rest,
 *      and never written back through saveTruckingEntries.
 */

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const Module = require('module');
const { JSDOM } = require('jsdom');
const { fnSource, requireFn, sliceSource, evalSlice } = require('./lib/fn-source');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ─────────────────────────────────────────────────────────────────────
// Server: stub the two modules daily-rows.js pulls in at load time.
// ─────────────────────────────────────────────────────────────────────
let CURRENT_SQL = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return { requireDivision: () => ({ payload: { companyCode: 'FCT' }, division: 'turf' }) };
  }
  return origLoad.apply(this, arguments);
};
const dailyRows = require(path.resolve(__dirname, '..', 'api', 'daily-rows.js'));
Module._load = origLoad;
const { isPayrollTruckingRow, isTruckName } = dailyRows._test;

// A daily_tracking row as the SELECT returns it.
const dbRow = (o) => Object.assign({
  row_id: 'ts501-1759000000000-0-1', project_id: 'p1', date: '2026-09-28',
  field_type: null, employee: 'Nick Detwiler', cost_code: 'Mobilization',
  sub_code: 'Mobilization', job_class: 'Trucking', rate: '0', labor_hours: '10.5',
  equipment: 'Triaxle Dump', equip_unit_cost: '121.0000', equip_hours: '10.5000',
  material: null, supplier: null, po_num: null, units_purchased: '0', unit_cost: '0',
  material_cost: '0', quantity: '0', equip_total_override: null,
  total_cost_override: null, num_laborers: null, timesheet_entry_id: 501,
}, o);

console.log('\n[which payroll rows are trucking]');
{
  // The row from the report: Nick's haul onto Juniata Softball.
  assert("a driver's haul (Haul — To/From Site) is trucking",
    isPayrollTruckingRow(dbRow({ field_type: 'Haul — To/From Site' })));
  assert('a haul is trucking whatever the driver\'s job class',
    isPayrollTruckingRow(dbRow({ field_type: 'Haul — On Site', job_class: 'Laborer' })));
  assert('an unstamped, priced Triaxle is trucking (nobody answered the haul question)',
    isPayrollTruckingRow(dbRow({ field_type: null })));
  assert('any job class on a priced Lowboy is trucking',
    isPayrollTruckingRow(dbRow({ job_class: 'Operator', equipment: 'Lowboy' })));
  assert('any job class on a priced Tri-Axle is trucking',
    isPayrollTruckingRow(dbRow({ job_class: 'Hourly', equipment: 'Tri-Axle 12' })));
  assert('an injected row that lost its timesheet link still counts (ts id)',
    isPayrollTruckingRow(dbRow({ timesheet_entry_id: null })));

  assert("not his travel row: the truck is named but at 0 hours",
    !isPayrollTruckingRow(dbRow({ field_type: 'Travel', sub_code: 'Travel', equip_hours: '0' })));
  assert('not a crew Pickup Truck',
    !isPayrollTruckingRow(dbRow({ job_class: 'Hourly', equipment: 'Pickup Truck', equip_unit_cost: '35', equip_hours: '3' })));
  assert('not a Broom - Laymor on a laborer',
    !isPayrollTruckingRow(dbRow({ job_class: 'Hourly', equipment: 'Broom - Laymor', equip_unit_cost: '20', equip_hours: '7' })));
  assert('not a Toro Triplex ("tri" alone is a mower on a turf job)',
    !isPayrollTruckingRow(dbRow({ job_class: 'Hourly', equipment: 'Toro Triplex' })));
  assert('not an office\'s own "Haul Off" field type on a skid steer',
    !isPayrollTruckingRow(dbRow({ field_type: 'Haul Off', job_class: 'Hourly', equipment: 'Skid Steer' })));
  assert("not a manual row — the Trucking tab's own entry already lists it",
    !isPayrollTruckingRow(dbRow({ row_id: '1759000000000.123', timesheet_entry_id: null })));
  assert('an override total prices the truck as hours do',
    isPayrollTruckingRow(dbRow({ equip_hours: '0', equip_total_override: '600' })));

  // A Trucking-class driver's OTHER machines. Payroll's own case (truckOnRow):
  // he hauls in the triaxle, then runs a roller on site — that row is site work.
  assert("not the roller a Trucking-class driver ran on site",
    !isPayrollTruckingRow(dbRow({ equipment: 'Roller', equip_unit_cost: '45', equip_hours: '2.5', truck_unit: 'Triaxle Dump' })));
  assert('not a Trucking-class driver\'s Pickup Truck',
    !isPayrollTruckingRow(dbRow({ equipment: 'Pickup Truck', equip_unit_cost: '35', equip_hours: '3' })));
  assert('not a Trucking-class driver\'s skid steer when he named no truck',
    !isPayrollTruckingRow(dbRow({ equipment: 'Skid Steer', equip_hours: '3', truck_unit: null })));
  assert('a Trucking-class driver on the truck he named is trucking, whatever it is called',
    isPayrollTruckingRow(dbRow({ equipment: 'Tandem Dump', equip_hours: '8', truck_unit: ' tandem dump ' })));
  assert('the named truck counts only for a Trucking-class driver',
    !isPayrollTruckingRow(dbRow({ job_class: 'Hourly', equipment: 'Tandem Dump', equip_hours: '8', truck_unit: 'Tandem Dump' })));
  assert('never a row the approver answered "not a haul" (is_haul false)',
    !isPayrollTruckingRow(dbRow({ equipment: 'Triaxle Dump', equip_hours: '6', is_haul: false })));
  assert('a stamped haul stays trucking even if is_haul reads false (the stamp is the record)',
    isPayrollTruckingRow(dbRow({ field_type: 'Haul — On Site', is_haul: false })));

  assert('isTruckName: Triaxle Dump / Low-Boy Trailer', isTruckName('Triaxle Dump') && isTruckName('Low-Boy Trailer'));
  assert('isTruckName: Pickup Truck / Line Striper are not', !isTruckName('Pickup Truck') && !isTruckName('Line Striper'));
}

console.log('\n[GET /api/daily-rows?trucking=1]');
(async () => {
  {
    const seen = [];
    CURRENT_SQL = (strings, ...values) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      seen.push({ q, values });
      return Promise.resolve([
        dbRow({ field_type: 'Haul — To/From Site' }),
        dbRow({ row_id: 'ts501-1759000000000-1-2', field_type: 'Travel', equip_hours: '0' }),
        dbRow({ row_id: 'ts502-1759000000000-0-3', job_class: 'Hourly', equipment: 'Pickup Truck' }),
      ]);
    };
    const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; },
                  json(b) { this.body = b; return this; }, end() { return this; } };
    await dailyRows({ method: 'GET', query: { division: 'turf', trucking: '1' }, body: {} }, res);

    const rows = res.body && res.body.rows;
    assert('200 with a rows list', res.statusCode === 200 && Array.isArray(rows), JSON.stringify(res.body));
    assert('only the trucking row comes back', rows && rows.length === 1, rows && rows.length);
    const r = rows && rows[0];
    assert('in the shape Daily Tracking reads (id, _projectId, timesheet_entry_id)',
      r && r.id === 'ts501-1759000000000-0-1' && r._projectId === 'p1' && r.timesheet_entry_id === '501');
    assert('one statement, scoped to the caller\'s company and division',
      seen.length === 1 && seen[0].values[0] === 'FCT' && seen[0].values[1] === 'turf', JSON.stringify(seen.map(s => s.values)));
    assert('the query asks only for payroll-injected rows',
      /dt\.timesheet_entry_id IS NOT NULL OR dt\.row_id LIKE 'ts%'/.test(seen[0].q));
    assert('joins the entry for the truck the driver named',
      /LEFT JOIN timesheet_entries te ON te\.id = dt\.timesheet_entry_id AND te\.company_code = dt\.company_code/.test(seen[0].q)
      && /te\.truck_unit/.test(seen[0].q));
    assert('restates the whole rule, so the LIMIT counts trucking rows (see test-trucking-payroll-sql.js)',
      /dt\.is_haul IS DISTINCT FROM FALSE/.test(seen[0].q) && /= 'trucking'/.test(seen[0].q)
      && seen[0].values.includes('^\\s*haul\\s*[—–-]\\s'));
  }
  {
    // An ordinary GET is untouched by the new branch.
    const seen = [];
    CURRENT_SQL = (strings) => { seen.push(strings.join(' ')); return Promise.resolve([]); };
    const res = { setHeader() {}, status() { return this; }, json(b) { this.body = b; return this; } };
    await dailyRows({ method: 'GET', query: { division: 'turf', projectId: 'p1' }, body: {} }, res);
    assert('a plain project GET does not take the trucking path',
      seen.length === 1 && !/truck_unit/.test(seen[0]) && /project_id =/.test(seen[0]));
  }

  await pageTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

// ─────────────────────────────────────────────────────────────────────
// The Trucking tab, from each division page's own source.
// ─────────────────────────────────────────────────────────────────────
async function pageTests() {
  const PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
  const SRC = Object.fromEntries(PAGES.map(f => [f, fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8')]));

  console.log('\n[the copies agree]');
  for (const name of ['_trIsEditingEntry', '_trRefreshPayroll', '_trPayrollEntries', '_trTotal',
                      '_trAllEntries', '_trPayrollRowHTML', 'applyTRFilters', '_trPendingRowIds',
                      '_trOpenTab', '_trDrawHeldBack']) {
    const copies = PAGES.map(f => fnSource(SRC[f], name));
    assert(`${name} is in all three pages, identical`, copies.every(Boolean) && copies.every(c => c === copies[0]),
      PAGES.filter((f, i) => !copies[i]).join(', '));
  }
  for (const f of PAGES) {
    assert(`${f}: the data poll refreshes payroll trucking`,
      /_pollTrucking\(\),\s*_pollPayrollTrucking\(\),/.test(SRC[f])
      && /async function _pollPayrollTrucking\(\) \{\s*if \(activeTab === 'trucking'\) await _trRefreshPayroll\(\);/.test(SRC[f]));
    assert(`${f}: opening the Trucking tab fetches at once`,
      /if \((activeTab|_t) === 'trucking'\)\s+_trOpenTab\(\);/.test(SRC[f]));
    assert(`${f}: closing a job's Daily Tracking over the tab refreshes it`,
      /function closeDailyView\(\) \{\s*document\.getElementById\('daily-fullscreen'\)\.style\.display = 'none';\s*if \(activeTab === 'trucking'\) _trOpenTab\(\);/.test(SRC[f]));
    assert(`${f}: a held-back redraw runs when the user leaves the field`,
      /getElementById\('trucking-root'\)\.addEventListener\('focusout', _trDrawHeldBack\);/.test(SRC[f]));
  }

  for (const page of PAGES) {
    console.log(`\n[${page}: the Trucking tab]`);
    const src = SRC[page];
    const dom = new JSDOM('<!doctype html><div id="trucking-root"></div>');
    const doc = dom.window.document;
    const fetches = [];
    const saves   = [];
    const opened  = [];
    const reloaded = [];
    const timers  = [];
    let fetchAnswer = null;
    // The page's own division — a hard-coded 'turf' in the URL would show.
    const division = (/const DIVISION\s*=\s*'(\w+)'/.exec(src) || [])[1];

    const ctx = vm.createContext({
      document: doc, console, Date, JSON, Math, Set, Object, Array, String, Number, parseFloat, parseInt, isNaN,
      _AUTO_REPORT: false, API_BASE: '/api', DIVISION: division, fctToken: 't',
      logout() {}, openDailyView: id => opened.push(id), reloadDailyRows: id => reloaded.push(id),
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      fetch: (url) => { fetches.push(url); return Promise.resolve(fetchAnswer); },
      saveTruckingEntries: () => saves.push(1),
      cbHtml: (key, val, ph, attrs) => `<input class="cb-input" value="${String(val || '').replace(/"/g, '&quot;')}" ${attrs || ''}>`,
    });
    for (const name of ['fmt', 'qfmt', 'esc', 'escT']) evalSlice(requireFn(src, name, page), ctx, name);
    evalSlice(`
      let activeTab = 'trucking';
      let truckingEntries = [];
      let projectsList = [];
      const perm = { canEdit: true, visibleTabs: null };
      function getProj(id) { return projectsList.find(p => p.id === id); }
      const _drSavePending = {};
      let _walStore = {};
      function _walRead() { return _walStore; }
    `, ctx, 'stubs');
    evalSlice(sliceSource(src, '/* ── Payroll trucking (read-only) ──', '/* ── Inventory filter state ── */',
      'the Trucking tab', 'function renderTruckingTab()'), ctx, 'the Trucking tab');
    // The tab's click and focusout listeners, as the page registers them.
    evalSlice(sliceSource(src, "document.getElementById('trucking-root').addEventListener('click'",
      "document.getElementById('trucking-root').addEventListener('input'", 'the tab listeners',
      "addEventListener('focusout', _trDrawHeldBack)"), ctx, 'the tab listeners');

    const run = code => vm.runInContext(code, ctx);
    run(`projectsList = [
      { id: 'p1', 'project-name': 'Juniata Softball Warning Track',
        bidItems: [{ cost_code: 'Mobilization', sub_code: 'Mobilization', description: 'Mob' }] },
      { id: 'p2', 'project-name': 'Franklin Regional Softball' },
    ]`);
    // This tab's own entries, oldest first as the stored list keeps them.
    const own = [
      { id: 'a', tr_number: 'TR-0174', project_id: 'p2', driver: 'Ben Becker',  truck_type: 'Lowboy', rate: '121', hours: '11',  date: '2026-09-02', status: 'approved' },
      { id: 'b', tr_number: 'TR-0175', project_id: 'p2', driver: 'Kris Fairman', truck_type: 'Lowboy', rate: '121', hours: '2.5', date: '2026-09-30', status: 'pending' },
    ];
    run(`truckingEntries = ${JSON.stringify(own)}`);
    const ownBefore = run('JSON.stringify(truckingEntries)');

    // What the endpoint hands back (dbRowToFrontend shape).
    const payrollRows = [
      { id: 'ts501-1-0-1', _projectId: 'p1', timesheet_entry_id: '501', date: '2026-09-28',
        field_type: 'Haul — To/From Site', employee: 'Nick Detwiler', cost_code: 'Mobilization',
        sub_code: 'Mobilization', job_class: 'Trucking', equipment: 'Triaxle Dump',
        equip_unit_cost: '121.0000', equip_hours: '10.5000', material: '', quantity: '0.0000' },
      { id: 'ts777-1-0-1', _projectId: 'gone', timesheet_entry_id: '777', date: '2026-09-29',
        field_type: 'Haul — On Site', employee: 'Nobody', equipment: 'Triaxle Dump',
        equip_unit_cost: '121', equip_hours: '4' },
    ];
    fetchAnswer = { ok: true, status: 200, json: () => Promise.resolve({ rows: payrollRows }) };

    // First draw: nothing loaded yet, so it says so and fetches.
    run('renderTruckingTab()');
    assert('first draw fetches payroll trucking for this division',
      !!division && fetches.length === 1 && fetches[0] === `/api/daily-rows?division=${division}&trucking=1`, fetches.join());
    assert('and says it is loading', /Loading payroll trucking/.test(doc.getElementById('trucking-root').textContent));

    // Let the fetch resolve; the tab redraws itself.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    {
      const root = doc.getElementById('trucking-root');
      const rows = [...root.querySelectorAll('tbody tr')];
      const payrollTr = root.querySelector('tr.tr-payroll-row');
      assert('the payroll haul is listed', !!payrollTr && /Nick Detwiler/.test(payrollTr.textContent));
      assert('its job is out of this division\'s list → left out', !/Nobody/.test(root.textContent));
      assert('three rows: two of this tab\'s, one of payroll\'s', rows.length === 3, rows.length);
      assert('newest date first across both lists',
        rows.map(r => (r.textContent.match(/TR-\d+|Nick/) || [''])[0]).join() === 'TR-0175,Nick,TR-0174',
        rows.map(r => r.textContent.replace(/\s+/g, ' ').slice(0, 30)).join(' | '));
      assert('marked TS', payrollTr && payrollTr.querySelector('.row-badge-injected').textContent === 'TS');
      assert('priced off the truck: $1,270.50', payrollTr && /\$1,270\.50/.test(payrollTr.textContent));
      assert('rate and hours read plainly (121 × 10.5)', payrollTr && /\b121\b/.test(payrollTr.textContent) && /10\.5/.test(payrollTr.textContent));
      assert('the sub code reads as the job\'s bid item', payrollTr && /Mobilization \/ Mobilization — Mob/.test(payrollTr.textContent));
      assert('the haul stamp shows in Notes', payrollTr && /Haul — To\/From Site/.test(payrollTr.textContent));
      assert('read-only: no editable field, no delete',
        payrollTr && !payrollTr.querySelector('input, select, .del-btn'));
      assert('the job name is a link to its Daily Tracking',
        payrollTr && payrollTr.querySelector('[data-tr-open-proj="p1"]'));
      assert('this tab\'s own rows stay editable',
        root.querySelectorAll('tbody tr:not(.tr-payroll-row) input[data-tr-field="hours"]').length === 2);
      assert('the title line counts payroll\'s rows', /Includes 1 trucking row auto-inserted/.test(root.textContent));
      assert('and does not claim older rows were left off', !/Older ones are not listed/.test(root.textContent));

      // Filters and search run over both.
      run(`trFilters = { status: new Set(['payroll']) }`);
      run('renderTruckingTab()');
      assert('Status filter "payroll" shows only payroll rows',
        root.querySelectorAll('tbody tr').length === 1 && !!root.querySelector('tr.tr-payroll-row'));
      run(`trFilters = {}; trSearch = 'detwiler'`);
      run('renderTruckingTab()');
      assert('search finds the payroll driver',
        root.querySelectorAll('tbody tr').length === 1 && /Nick Detwiler/.test(root.textContent));
      run(`trSearch = ''`);
      run('renderTruckingTab()');

      // Read-only, really: nothing about the view reaches the stored list.
      assert('truckingEntries is untouched (not reordered, nothing added)',
        run('JSON.stringify(truckingEntries)') === ownBefore);
      assert('drawing never saves', saves.length === 0);
      assert('not re-fetched on every redraw (search keystrokes)', fetches.length === 1, fetches.length);

      // CSV carries payroll's rows with their own total.
      let csv = '';
      ctx.Blob = function (parts) { csv = parts.join(''); };
      ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
      const clickStub = doc.createElement;
      doc.createElement = (t) => { const el = clickStub.call(doc, t); if (t === 'a') el.click = () => {}; return el; };
      run('exportTRCSV()');
      doc.createElement = clickStub;
      assert('CSV lists the payroll haul at $1270.50',
        /"TS","Juniata Softball Warning Track","Nick Detwiler","Triaxle Dump".*"1270\.50"/.test(csv), csv.split('\r\n')[2]);
      assert('CSV still totals this tab\'s rows as rate × hours', /"TR-0174".*"1331\.00"/.test(csv));

      // The job name opens its Daily Tracking, and reloads a job already in
      // memory — the row clicked may have been approved since boot.
      run(`projectsList[0].dailyRows = [{ id: 'old-row', _projectId: 'p1' }]`);
      root.querySelector('[data-tr-open-proj="p1"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert('clicking the job name opens its Daily Tracking', opened.join() === 'p1', opened.join());
      assert('and reloads that job\'s rows', reloaded.join() === 'p1', reloaded.join());

      // Opening the tab fetches now, even inside the 30s window.
      const n0 = fetches.length;
      run('_trOpenTab()');
      assert('opening the tab fetches at once, inside the 30s window', fetches.length === n0 + 1, fetches.length - n0);
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      // A sub code this page changed in Daily Tracking and has not saved yet
      // shows at once, over the fetched copy.
      run(`projectsList[0].dailyRows.push(Object.assign({}, ${JSON.stringify(payrollRows[0])}, { sub_code: 'Excess Cut' }));
           _drSavePending['ts501-1-0-1'] = {};`);
      run('renderTruckingTab()');
      assert('an unsaved Daily Tracking edit shows on the TS row at once',
        /Mobilization \/ Excess Cut/.test(root.querySelector('tr.tr-payroll-row').textContent));
      // ...and a fetch that may predate it asks again shortly.
      timers.length = 0;
      run('_trRefreshPayroll()');
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      assert('a refresh racing that write schedules a follow-up fetch', timers.some(t => t.ms === 3000), timers.map(t => t.ms).join());
      run(`delete _drSavePending['ts501-1-0-1']`);
      run('renderTruckingTab()');
      assert('once saved, the row reads from the fetch again',
        /Mobilization \/ Mobilization/.test(root.querySelector('tr.tr-payroll-row').textContent));
      timers.length = 0;
      run('_trRefreshPayroll()');
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      assert('no follow-up when nothing is in flight', !timers.some(t => t.ms === 3000));

      // The server sent its cap: say older rows were left off.
      fetchAnswer = { ok: true, status: 200, json: () => Promise.resolve({ rows: payrollRows, hasMore: true }) };
      await run('_trRefreshPayroll()');
      assert('hasMore: the title line says older rows are not listed',
        /Includes the newest 1 trucking row/.test(root.textContent) && /Older ones are not listed/.test(root.textContent));

      // A refresh that lands while the user types is drawn when they leave the field.
      const notes = root.querySelector('tbody tr:not(.tr-payroll-row) input[data-tr-field="notes"]');
      notes.focus();
      fetchAnswer = { ok: true, status: 200, json: () => Promise.resolve({ rows: payrollRows.concat([
        Object.assign({}, payrollRows[0], { id: 'ts502-1-0-1', employee: 'Jon Cribbs', date: '2026-09-29' })]) }) };
      await run('_trRefreshPayroll()');
      assert('not drawn while typing', !/Jon Cribbs/.test(root.textContent) && run('_trPayrollUndrawn') === true);
      timers.length = 0;
      notes.blur();
      const held = timers.find(t => t.ms === 300);
      assert('leaving the field queues the redraw past the combobox commit (300ms)', !!held, timers.map(t => t.ms).join());
      if (held) held.fn();
      assert('and then draws it', /Jon Cribbs/.test(root.textContent) && run('_trPayrollUndrawn') === false);

      // A failed refresh keeps what was shown.
      fetchAnswer = { ok: false, status: 500, json: () => Promise.resolve({}) };
      await run('_trRefreshPayroll()');
      assert('a failed refresh keeps the rows already listed',
        !!root.querySelector('tr.tr-payroll-row') && /Nick Detwiler/.test(root.textContent));
    }
  }
}
