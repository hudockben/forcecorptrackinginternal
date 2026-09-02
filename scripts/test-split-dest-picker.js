#!/usr/bin/env node
'use strict';
/**
 * Payroll's "Send to" picker — the division override, from the modal's side.
 *
 * Run: node scripts/test-split-dest-picker.js
 *
 * A driver names one division on his timesheet and the whole day follows it.
 * When he names the wrong one, payroll could send the day back or move the
 * WHOLE entry, and neither says "six of these hours were turf and four were a
 * haul for EAI". So each split row may name its own destination.
 *
 * Two layers, the same two as the dust split modal beside it:
 *
 *   1. Structural — greps payroll.html and the server so the two halves of the
 *      contract stay in step: the same six divisions on both sides, the save
 *      sending each row through the payload shaper, and the window nested under
 *      the destination's own key so each division's existing validator reads it.
 *   2. Behavioural — runs the real override model out of payroll.html in a vm
 *      with a stubbed DOM, and asserts on what an approver actually does: pick
 *      a division, pick a job, change their mind, send a row to a tab that has
 *      no cost codes.
 *
 * No DB, no browser.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const SRC    = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');
const SERVER = fs.readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');

console.log('Payroll split destination picker\n');

// ── 1) Structural ───────────────────────────────────────────────────────────
console.log('[the page and the server name the same destinations]');
{
  const pageM   = /const SPLIT_DEST_DIVISIONS = (\[[^\]]*\])/.exec(SRC);
  const serverM = /const SPLIT_DEST_DIVISIONS = (\[[^\]]*\])/.exec(SERVER);
  assert('payroll.html declares the destination list', !!pageM);
  assert('and so does the server', !!serverM);
  const page   = pageM   ? JSON.parse(pageM[1].replace(/'/g, '"'))   : [];
  const server = serverM ? JSON.parse(serverM[1].replace(/'/g, '"')) : [];
  // A division offered by the picker but refused by the server is a 400 the
  // approver cannot act on; one the server takes but the picker never offers is
  // a destination nobody can reach.
  assert('and the two lists are identical',
    JSON.stringify(page) === JSON.stringify(server),
    `page ${JSON.stringify(page)} vs server ${JSON.stringify(server)}`);
  assert('every division is reachable', page.length === 6);

  // Which of them take a whole split row. The server decides this with
  // AUTO_INJECT_DIVISIONS — the divisions whose cost lives in daily_tracking —
  // and the page must not offer a cost-code box for any other.
  const pageDaily   = /const SPLIT_DEST_DAILY = (\[[^\]]*\])/.exec(SRC);
  const serverDaily = /const AUTO_INJECT_DIVISIONS = (\[[^\]]*\])/.exec(SERVER);
  assert('the page and the server agree which tabs have cost codes',
    !!pageDaily && !!serverDaily
    && JSON.stringify(JSON.parse(pageDaily[1].replace(/'/g, '"')))
       === JSON.stringify(JSON.parse(serverDaily[1].replace(/'/g, '"'))));
}

console.log('\n[the payload the modal and the server agree on]');
{
  const save = SRC.match(/const action = splitMode === 'approve'[\s\S]+?\n      \}\n/);
  assert('the save sends every row through the payload shaper',
    !!save && /split: splitRows\.map\(splitRowPayload\)/.test(save[0]));
  // Nested under the destination's own key, because each division's existing
  // validator reads its own half — validateTruckingLeg and validateDustLeg.
  assert('a trucking window is nested under dest.trucking',
    /out\.dest\.trucking = window;/.test(SRC));
  assert('a dust window is nested under dest.dust',
    /out\.dest\.dust     = window;/.test(SRC));
  assert('and the server reads them from exactly there',
    /validateTruckingLeg\(raw\.trucking\)/.test(SERVER)
    && /validateDustLeg\(raw\.dust\)/.test(SERVER));
  // Dust bills vehicle rates across the window, so a dust row without one
  // invoices the customer for the whole day. Refused on BOTH sides: the page so
  // the approver is told in the form, the server so no other client can skip it.
  assert('the page refuses a dust row with no window',
    /Dust Control Tracking bills by the clock/.test(SRC));
  assert('and so does the server',
    /which bills by the clock/.test(SERVER));
}

// ── 2) Behavioural ──────────────────────────────────────────────────────────
// The real override model out of payroll.html, in a vm with the outside world
// stubbed. A copy of these functions would test nothing.
function sandbox({ jobs = {}, costCodes = {}, fail = new Set() } = {}) {
  const painted = { rows: 0, tally: 0 };
  const fetched = [];
  const ctx = {
    console,
    escapeHtml: s => String(s == null ? '' : s),
    prettyDiv: d => (d === 'kiewit' ? 'Kiewit Pinetree' : d === 'dust' ? 'Dust Control'
      : d ? d.charAt(0).toUpperCase() + d.slice(1) : ''),
    authHeaders: () => ({}),
    renderSplitRows:  () => { painted.rows++; },
    renderSplitTally: () => { painted.tally++; },
    // The real one caches into splitCcCache; this records the call so a test can
    // prove the destination's codes are what get fetched.
    loadCostCodesFor: (division, jobId) => {
      fetched.push(`cc:${division}::${jobId}`);
      ctx.splitCcCache[`${division}::${jobId}`] = costCodes[`${division}::${jobId}`] || [];
      return Promise.resolve(ctx.splitCcCache[`${division}::${jobId}`]);
    },
    fetch: url => {
      fetched.push(`jobs:${url}`);
      const m = /division=([a-z]+)/.exec(String(url));
      const div = m ? m[1] : '';
      // `fail` names divisions whose lookup should answer like a real refusal:
      // a non-ok status with an error body, which parses just like an answer.
      if (fail.has(div)) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ jobs: jobs[div] || [] }) });
    },
    splitCcCache: {},
    splitEntry: null,
    splitRows: [],
  };
  vm.createContext(ctx);
  const start = SRC.indexOf('    // ── The division override ─');
  const end   = SRC.indexOf('    // Every travel line this job');
  if (start < 0 || end < 0) throw new Error('could not find the division override block in payroll.html');
  vm.runInContext(SRC.slice(start, end), ctx);
  const run = code => vm.runInContext(code, ctx);
  return {
    ctx, run, painted, fetched,
    set: (entry, rows) => { ctx.splitEntry = entry; ctx.splitRows = rows; },
    call: (fn, ...args) => { ctx.__args = args; return run(`${fn}(...__args)`); },
  };
}

const ENTRY = {
  id: 900, username: 'risingcam', division: 'turf', entry_type: 'daily',
  job_id: 'p-frank', job_label: 'Franklin Regional Multi',
  work_date: '2026-09-01', computed_hours: 10, travel_hours: 0,
};
const JOBS = {
  paving:   [{ id: 'pv-8', label: 'ACMH · 26055' }],
  trucking: [{ id: 'c-eai', label: 'EAI' }, { id: 'c-ees', label: 'EES' }],
  quarry:   [{ id: 'daily:hc', label: 'Daily — Homer City' }],
  kiewit:   [],
};
const row = (o = {}) => Object.assign({
  dest_division: '', dest_job: '', dest_start: '', dest_end: '',
  cost_code: 'Earthwork', sub_code: 'Excess Cut - Off Site', equipment: '',
  labor_hours: 0, equip_hours: 0, quantity: 0, is_travel: false, code_source: '',
}, o);

(async () => {
  console.log('\n[where a row says its cost goes]');
  {
    const s = sandbox({ jobs: JOBS });
    const plain = row();
    s.set(ENTRY, [plain]);
    assert('a row with no override goes to the entry\'s own division',
      s.call('splitRowDivision', plain) === 'turf');
    assert('and its own job', s.call('splitRowJob', plain) === 'p-frank');
    assert('and it posts to daily_tracking', s.call('splitRowIsDaily', plain) === true);

    const moved = row({ dest_division: 'paving', dest_job: 'pv-8' });
    s.set(ENTRY, [moved]);
    assert('an overridden row goes where it says', s.call('splitRowDivision', moved) === 'paving');
    assert('against the job it names', s.call('splitRowJob', moved) === 'pv-8');
    assert('and still posts to daily_tracking', s.call('splitRowIsDaily', moved) === true);

    const haul = row({ dest_division: 'trucking', dest_job: 'c-eai' });
    s.set(ENTRY, [haul]);
    assert('a row sent to Truck Tracking does not', s.call('splitRowIsDaily', haul) === false);
  }

  console.log('\n[a routed row is coded against the job it is going to]');
  {
    const s = sandbox({
      jobs: JOBS,
      costCodes: {
        'turf::p-frank': [{ cost_code: 'Earthwork', sub_codes: ['Excess Cut - Off Site'] }],
        'paving::pv-8':  [{ cost_code: '19mm Wearing', sub_codes: ['19mm - Travel'] }],
      },
    });
    s.ctx.splitCcCache['turf::p-frank'] = [{ cost_code: 'Earthwork', sub_codes: ['Excess Cut - Off Site'] }];
    s.ctx.splitCcCache['paving::pv-8']  = [{ cost_code: '19mm Wearing', sub_codes: ['19mm - Travel'] }];
    const home = row();
    const away = row({ dest_division: 'paving', dest_job: 'pv-8' });
    s.set(ENTRY, [home, away]);
    // Offering the timesheet's codes on the other board would file the cost
    // under a code that job has never had.
    assert('the home row is offered this job\'s codes',
      s.call('splitRowCcList', home)[0].cost_code === 'Earthwork');
    assert('and the routed row the destination job\'s',
      s.call('splitRowCcList', away)[0].cost_code === '19mm Wearing');
  }

  console.log('\n[picking a division]');
  {
    const s = sandbox({ jobs: JOBS });
    const r = row();
    s.set(ENTRY, [r]);
    // Before the lookup lands the box says so, rather than showing an empty
    // list that reads as "this division has no jobs".
    const p = s.call('splitOnDestDivision', 0, 'paving');
    assert('the job box says it is loading', /loading…/.test(s.call('splitDestCellHtml', r, 0)));
    await p;
    const html = s.call('splitDestCellHtml', r, 0);
    assert('the division comes back selected', /value="paving" selected/.test(html));
    assert('and its jobs are offered', /value="pv-8"/.test(html));
    assert('the job list was fetched once',
      s.fetched.filter(f => f.startsWith('jobs:')).length === 1, s.fetched.join(' '));

    // A second row on the same division must not fetch it again.
    const r2 = row();
    s.ctx.splitRows.push(r2);
    await s.call('splitOnDestDivision', 1, 'paving');
    assert('and reused for the next row on that division',
      s.fetched.filter(f => f.startsWith('jobs:')).length === 1);

    // An office with no live jobs is a real answer and says so.
    const r3 = row();
    s.ctx.splitRows.push(r3);
    await s.call('splitOnDestDivision', 2, 'kiewit');
    assert('a division with no live jobs says that, not nothing',
      /no live jobs/.test(s.call('splitDestCellHtml', r3, 2)));
  }

  console.log('\n[changing your mind clears what belonged to the old destination]');
  {
    const s = sandbox({ jobs: JOBS });
    const r = row({ dest_division: 'paving', dest_job: 'pv-8', cost_code: '19mm Wearing', sub_code: '19mm - Travel', code_source: 'manual' });
    s.set(ENTRY, [r]);
    await s.call('splitOnDestDivision', 0, 'trucking');
    // A job id from the old board points at nothing on the new one, and a cost
    // code from the old job means nothing there either.
    assert('the job is cleared', r.dest_job === '');
    assert('the cost code is cleared', r.cost_code === '');
    assert('the sub code is cleared', r.sub_code === '');
    assert('and so is who put them there', r.code_source === '');

    // Back to the timesheet's own job, which is the way out of an override.
    await s.call('splitOnDestDivision', 0, '');
    assert('clearing the division puts the row back on this job',
      s.call('splitRowDivision', r) === 'turf');
  }

  console.log('\n[picking the job loads that job\'s cost codes — but only where there are any]');
  {
    const s = sandbox({ jobs: JOBS, costCodes: { 'paving::pv-8': [{ cost_code: '19mm Wearing', sub_codes: [] }] } });
    const r = row({ dest_division: 'paving' });
    s.set(ENTRY, [r]);
    await s.call('splitOnDestJob', 0, 'pv-8');
    assert('a daily_tracking destination fetches its codes',
      s.fetched.includes('cc:paving::pv-8'));

    const s2 = sandbox({ jobs: JOBS });
    const t = row({ dest_division: 'trucking' });
    s2.set(ENTRY, [t]);
    await s2.call('splitOnDestJob', 0, 'c-eai');
    assert('a blob destination fetches none — that tab has no cost codes',
      s2.fetched.filter(f => f.startsWith('cc:')).length === 0);
  }

  console.log('\n[a row bound for a tab with no cost codes says so]');
  {
    const s = sandbox({ jobs: JOBS });
    s.set(ENTRY, []);
    assert('Truck Tracking is named',
      /Truck Tracking/.test(s.call('splitDestNoCodeHtml', row({ dest_division: 'trucking' }))));
    assert('Dust Control Tracking is named',
      /Dust Control Tracking/.test(s.call('splitDestNoCodeHtml', row({ dest_division: 'dust' }))));
    assert('and the quarry',
      /quarry/.test(s.call('splitDestNoCodeHtml', row({ dest_division: 'quarry' }))));

    // The window: dust bills across it, trucking is only stamped with it, the
    // quarry takes hours and wants neither.
    assert('a dust row is asked for a window',
      /type="time"/.test(s.call('splitDestWindowHtml', row({ dest_division: 'dust' }), 0)));
    assert('and marked while it is missing',
      /needed/.test(s.call('splitDestWindowHtml', row({ dest_division: 'dust' }), 0)));
    assert('the mark goes once it is filled',
      !/needed/.test(s.call('splitDestWindowHtml',
        row({ dest_division: 'dust', dest_start: '06:00', dest_end: '10:00' }), 0)));
    assert('a trucking row is offered one but never marked',
      /type="time"/.test(s.call('splitDestWindowHtml', row({ dest_division: 'trucking' }), 0))
      && !/needed/.test(s.call('splitDestWindowHtml', row({ dest_division: 'trucking' }), 0)));
    // The quarry takes hours, so no window — but it is the one destination that
    // cannot be priced afterwards, because quarry.html renders payroll's rows
    // read-only. So it is asked for a rate instead, and marked without one.
    const qHtml = s.call('splitDestWindowHtml', row({ dest_division: 'quarry' }), 0);
    assert('a quarry row is asked for no window', !/type="time"/.test(qHtml));
    assert('but it is asked for a rate', /placeholder="\$\/hr"/.test(qHtml));
    assert('and marked while it has none', /needed/.test(qHtml));
    assert('the mark goes once it is priced',
      !/needed/.test(s.call('splitDestWindowHtml', row({ dest_division: 'quarry', dest_rate: 95 }), 0)));
  }

  console.log('\n[a job lookup that fails is not the same as an office with no jobs]');
  {
    const s = sandbox({ jobs: JOBS, fail: new Set(['trucking']) });
    const r = row();
    s.set(ENTRY, [r]);
    await s.call('splitOnDestDivision', 0, 'trucking');
    const html = s.call('splitDestCellHtml', r, 0);
    // Cached as [], one 500 read as "no live jobs" — the phrase the picker uses
    // to mean the office genuinely has none — for the rest of the session, with
    // no way to retry short of reloading the page.
    assert('a failed lookup does not claim the office has no jobs',
      !/no live jobs/.test(html), html);
    assert('it offers a retry instead', /dest-retry/.test(html));
    // The block's own `const`s live in the context's lexical scope, not on the
    // context object, so they are reached by running code in the same context.
    assert('and nothing was cached',
      s.run('splitDestJobsCache.trucking === undefined') === true);

    // The retry has to work, and must not wipe a job the row already had.
    const s2 = sandbox({ jobs: JOBS });
    const r2 = row({ dest_division: 'trucking', dest_job: 'c-eai', cost_code: '' });
    s2.set(ENTRY, [r2]);
    await s2.call('splitOnDestDivision', 0, 'trucking', true);
    assert('a retry keeps the job already picked', r2.dest_job === 'c-eai');
    assert('and fills the list in', /value="c-eai"/.test(s2.call('splitDestCellHtml', r2, 0)));
  }

  console.log('\n[what goes on the wire]');
  {
    const s = sandbox({ jobs: JOBS });
    s.set(ENTRY, []);
    await s.call('loadDestJobs', 'trucking');
    await s.call('loadDestJobs', 'paving');

    const plain = s.call('splitRowPayload', row({ labor_hours: 6 }));
    assert('an ordinary row carries no destination at all', plain.dest === undefined);
    assert('and still carries its hours and codes',
      plain.labor_hours === 6 && plain.cost_code === 'Earthwork');

    const moved = s.call('splitRowPayload', row({ labor_hours: 4, dest_division: 'paving', dest_job: 'pv-8' }));
    assert('a routed row names its division', moved.dest.division === 'paving');
    assert('its job', moved.dest.job_id === 'pv-8');
    // The label rides along so the destination's injector can name the row
    // without a second lookup — and for trucking and dust it IS the customer.
    assert('and the label the picker showed', moved.dest.job_label === 'ACMH · 26055');

    const haul = s.call('splitRowPayload',
      row({ labor_hours: 4, dest_division: 'trucking', dest_job: 'c-eai', dest_start: '06:00', dest_end: '10:00' }));
    assert('a haul carries its window under dest.trucking',
      haul.dest.trucking && haul.dest.trucking.start_time === '06:00' && haul.dest.trucking.end_time === '10:00');
    assert('and the customer as the job label', haul.dest.job_label === 'EAI');
    const bare = s.call('splitRowPayload', row({ dest_division: 'trucking', dest_job: 'c-eai' }));
    assert('a haul with no window sends no window at all',
      bare.dest.trucking && Object.keys(bare.dest.trucking).length === 0);

    // The two quarry tabs cost a row the same way and spell the rate
    // differently; the activity is encoded in the job id.
    await s.call('loadDestJobs', 'quarry');
    const qDaily = s.call('splitRowPayload',
      row({ labor_hours: 3, dest_division: 'quarry', dest_job: 'daily:hc', dest_rate: 74 }));
    assert('a quarry Daily row sends its rate as rate', qDaily.dest.quarry.rate === 74);
    const qCrush = s.call('splitRowPayload',
      row({ labor_hours: 3, dest_division: 'quarry', dest_job: 'crushing:hc', dest_rate: 95 }));
    assert('and a Crushing row as hourlyRate', qCrush.dest.quarry.hourlyRate === 95);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('Harness error:', err);
  process.exit(1);
});
