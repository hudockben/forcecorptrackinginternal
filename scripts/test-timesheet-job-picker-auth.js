#!/usr/bin/env node
'use strict';
/**
 * The Timesheet job picker's failure states, and the session check behind them.
 *
 * Run: node scripts/test-timesheet-job-picker-auth.js
 *
 * A field user opened timesheet.html from a saved link on his phone and every
 * division read "(no active jobs)" — while the same account on a freshly
 * signed-in laptop listed all of them. Two faults stacked up:
 *
 *   1. timesheet.html only checked that a token STRING existed in
 *      localStorage. Tokens expire after 30 days; the user object beside one
 *      never does. A saved link goes straight here and skips divisions.html —
 *      the only page that was calling /api/auth/verify — so a dead session
 *      rendered a page that looked signed in and 401'd on every call behind it.
 *
 *   2. The job load read `data.jobs` off whatever came back. A 401/403/500
 *      body carries `error`, not `jobs`, so undefined became [] became
 *      "(no active jobs)" — a division full of live work reading to the crew
 *      as a division with none. Worse, that [] went into jobsCache, so
 *      re-picking the division never retried.
 *
 * Two layers, following test-truck-unit-roster.js:
 *   1. Structural — greps the pages for the wiring: the session check runs on
 *      load, a 401 clears the session, and the login page says why.
 *   2. Behavioural — runs timesheet.html's own onDivisionChange in a vm
 *      against a mock document and a scripted fetch, asserting that an empty
 *      list and a failed load are told apart, that a failure is never cached,
 *      and that a 401 signs out instead of drawing an empty picker.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

const { sliceSource, evalSlice, missingGlobals } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const slice = sliceSource;

const TIMESHEET = read('timesheet.html');
const INDEX     = read('index.html');

// ── 1. Structural ──────────────────────────────────────────────────────────
console.log('\n[timesheet.html — the session check]');
{
  assert('the page verifies its session on load, not just the presence of a token',
    /queueMicrotask\(verifySession\)/.test(TIMESHEET));
  assert('and it asks the same endpoint divisions.html does',
    /fetch\('\/api\/auth\/verify'/.test(TIMESHEET));

  const expired = slice(TIMESHEET, 'function sessionExpired()', 'async function verifySession()', 'sessionExpired',
                        'function sessionExpired(');
  for (const k of ['fct_token', 'fct_user', 'fct_division']) {
    assert(`signing out on a dead session clears ${k}`,
      new RegExp(`removeItem\\('${k}'\\)`).test(expired));
  }
  assert('and lands on the login page saying why',
    /replace\('index\.html\?expired=1'\)/.test(expired));

  const verify = slice(TIMESHEET, 'async function verifySession()', '// ── State ──', 'verifySession',
                       ['function verifySession(', 'function escapeHtml(']);
  // Crews work out of signal. An unreachable check must never sign anyone out —
  // only a server that actually answered 401 may.
  assert('an unreachable check keeps the cached session',
    /catch \(err\) \{[\s\S]*?return;[\s\S]*?\}\s*if \(res\.status === 401\)/.test(verify));
  assert('only a definitive 401 signs out', /if \(res\.status === 401\) \{ sessionExpired\(\); return; \}/.test(verify));
}

console.log('\n[timesheet.html — the loaders]');
{
  const jobs = slice(TIMESHEET, 'async function onDivisionChange(i = 0)', '// The two standing EES activities', 'onDivisionChange',
                     'function onDivisionChange(');
  assert('the job load routes a 401 to the sign-out path',
    /if \(res\.status === 401\) \{ sessionExpired\(\); return; \}/.test(jobs));
  assert('it refuses to read jobs off a non-2xx body',
    /if \(!res\.ok \|\| !Array\.isArray\(data && data\.jobs\)\)/.test(jobs));
  // The cache write must be downstream of the throw, or a failure poisons the
  // division for the rest of the session.
  assert('and only a good response reaches the cache',
    jobs.indexOf('throw new Error') < jobs.indexOf('jobsCache[div] = data.jobs'));
  assert('the error state is reachable by touch, not disabled',
    /couldn\\'t load jobs[\s\S]*?jobSel\.disabled = false/.test(jobs));

  const sup = slice(TIMESHEET, 'async function loadSupervisors()', 'const JOB_RETRY', 'loadSupervisors',
                    'function loadSupervisors(');
  assert('the supervisor load tells a failure from an empty roster too',
    /if \(!res\.ok \|\| !Array\.isArray\(data && data\.supervisors\)\)/.test(sup));
  assert('and routes its own 401 to the sign-out path',
    /if \(res\.status === 401\) \{ sessionExpired\(\); return; \}/.test(sup));
}

console.log('\n[index.html — what the phone is told]');
{
  assert('a bounced session is explained rather than silently signed out',
    /get\('expired'\) === '1'/.test(INDEX) && /Your session expired/.test(INDEX));
}

// ── 2. Behavioural ─────────────────────────────────────────────────────────
// Run the page's real onDivisionChange / onJobChange against a mock document.
console.log('\n[timesheet.html — the picker, run for real]');

// From the allow list down, not from onDivisionChange down. The load calls
// jobsForPicker to narrow what it just fetched, and that function (with the
// const behind it) sits directly above it — leave them out and the sandbox
// throws ReferenceError INSIDE the try, which the catch then dresses up as a
// failed load. Every failure case below still passed, for the wrong reason,
// while the three success cases quietly went red.
//
// The filter's own rules are not this suite's business — test-trucking-job-
// allowlist.js runs it against a dozen rosters. It comes along so the success
// path is the page's, not a stub's.
const SRC = slice(TIMESHEET, '    const TRUCKING_JOB_ALLOWLIST = [', '// The two standing EES activities',
                  'the job filter + onDivisionChange',
                  'function onDivisionChange(')
          + slice(TIMESHEET, 'function onJobChange(i = 0)', '// ── Entries list', 'onJobChange',
                  'function onJobChange(');

function harness(responses) {
  const els = {
    division: { value: 'paving', innerHTML: '', disabled: false },
    job:      { value: '',       innerHTML: '', disabled: false },
  };
  const calls = [];
  const logged = [];
  let signedOut = 0;
  const ctx = {
    // Swallow the page's own diagnostics — a failed load is supposed to shout
    // into the console, and this suite deliberately provokes several.
    console: Object.assign({}, console, { error: (...a) => logged.push(a.join(' ')) }),
    JOB_RETRY: '__retry__',
    jobsCache: {},
    jobLoadToken: {},
    bel: (i, name) => els[name] || null,
    bid: (i, name) => `s${i}-${name}`,
    document: { getElementById: (id) => (/-job$/.test(id) ? els.job : null) },
    escapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    authHeaders: () => ({}),
    sessionExpired: () => { signedOut++; },
    isEesSelection: () => false,
    isTruckSelection: () => false,
    // onDivisionChange re-evaluates the haul truck picker, because whether it
    // shows depends on the division. Stubbed like every other collaborator
    // here — this suite is about the job picker's auth behaviour, and the
    // picker's own rules are covered in test-haul-timesheet-state.js.
    applyHaulUnitVisibility: () => {},
    // And it re-offers the block's machines, because each division keeps its
    // own equipment list. Stubbed for the same reason as the line above — the
    // narrowing's own rules are covered in test-timesheet-equipment.js.
    applyEquipDivision: () => {},
    truckUnitRosterLoad: () => Promise.resolve(null),
    truckUnitOptionsFill: () => {},
    truckUnitHintsRefresh: () => {},
    fetch: async (url) => {
      calls.push(url);
      const r = responses.shift();
      if (!r) throw new Error('unexpected extra fetch: ' + url);
      if (r.throws) throw new Error(r.throws);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
      };
    },
  };
  vm.createContext(ctx);
  evalSlice(SRC, ctx, 'the job filter + the two pickers');
  const h = { ctx, els, calls, logged, signedOut: () => signedOut };
  ALL.push(h);
  return h;
}
// Every harness built below. The load does its work inside a try/catch whose
// job is to turn a failure into a retry the crew can press — which means it
// catches a missing collaborator just as readily as a 403, and reports it the
// same way. A ReferenceError is never a load failure; it is this file falling
// behind the page.
const ALL = [];

(async () => {
  // A real, populated division.
  {
    const h = harness([{ status: 200, body: { jobs: [{ id: 'p1', label: 'Route 22 · 26045' }] } }]);
    await h.ctx.onDivisionChange(0);
    assert('a good response lists the jobs', /Route 22 · 26045/.test(h.els.job.innerHTML));
    assert('and the picker is usable', h.els.job.disabled === false);
  }

  // A genuinely empty division — the message the crew SHOULD only ever see here.
  {
    const h = harness([{ status: 200, body: { jobs: [] } }]);
    await h.ctx.onDivisionChange(0);
    assert('a truly empty division still says "(no active jobs)"',
      /\(no active jobs\)/.test(h.els.job.innerHTML));
  }

  // The bug: a 403 must not read as an empty division.
  {
    const h = harness([{ status: 403, body: { error: 'Timesheet or Payroll access required' } }]);
    await h.ctx.onDivisionChange(0);
    assert('a 403 no longer masquerades as "(no active jobs)"',
      !/\(no active jobs\)/.test(h.els.job.innerHTML), h.els.job.innerHTML);
    assert('it says the load failed', /couldn.t load jobs/.test(h.els.job.innerHTML));
    assert('and offers a retry', /__retry__/.test(h.els.job.innerHTML));
    assert('the failure is not cached', h.ctx.jobsCache.paving === undefined);
    // Whoever gets the support call needs the real reason, not "(no jobs)".
    assert('and the real reason reaches the console',
      h.logged.some(l => /Timesheet or Payroll access required/.test(l)), h.logged.join(' | '));
  }

  // A 500 and a dead network land in the same place.
  for (const [label, resp] of [['a 500', { status: 500, body: { error: 'Database error' } }],
                               ['a dead network', { throws: 'Failed to fetch' }]]) {
    const h = harness([resp]);
    await h.ctx.onDivisionChange(0);
    assert(`${label} shows the retry state, not an empty division`,
      /couldn.t load jobs/.test(h.els.job.innerHTML) && h.ctx.jobsCache.paving === undefined);
  }

  // Retrying after a failure actually re-fetches, and succeeds.
  {
    const h = harness([
      { status: 500, body: { error: 'Database error' } },
      { status: 200, body: { jobs: [{ id: 'p1', label: 'Route 22' }] } },
    ]);
    await h.ctx.onDivisionChange(0);
    h.els.job.value = '__retry__';
    h.ctx.onJobChange(0);
    await new Promise(r => setImmediate(r));
    assert('picking Retry re-runs the load', h.calls.length === 2, `fetched ${h.calls.length}×`);
    assert('and the jobs turn up on the second try', /Route 22/.test(h.els.job.innerHTML));
    assert('the retry row never survives as a job value', h.els.job.value !== '__retry__');
  }

  // The phone case, end to end: an expired token signs out instead of drawing
  // an empty picker.
  {
    const h = harness([{ status: 401, body: { error: 'Unauthorized — please log in' } }]);
    await h.ctx.onDivisionChange(0);
    assert('a 401 signs the user out', h.signedOut() === 1);
    assert('and never renders "(no active jobs)" on the way',
      !/\(no active jobs\)/.test(h.els.job.innerHTML), h.els.job.innerHTML);
    assert('nor caches anything', h.ctx.jobsCache.paving === undefined);
  }

  // ── The sandbox still has everything the page reaches for ──
  // The check that would have caught this file going stale. onDivisionChange
  // does its work inside a try/catch that exists to turn a failed load into a
  // retry — so when the page started calling jobsForPicker and the sandbox had
  // no such function, the ReferenceError came out the same door a 403 does.
  // The failure cases all still passed; the success cases went red and said
  // only that some jobs were missing from a list.
  console.log('\n[the sandbox has not fallen behind the page]');
  const missing = missingGlobals(ALL.flatMap(h => h.logged));
  assert('no case lost a collaborator the page calls',
    missing.length === 0, missing.join(' | '));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
