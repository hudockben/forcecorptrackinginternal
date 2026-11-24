#!/usr/bin/env node
'use strict';
/**
 * What the browser keeps of a company's jobs, and what it may do with it.
 *
 * Run: node scripts/test-project-cache-guards.js
 *
 * Each division page keeps copies in the browser: the job list (drawn at boot
 * before the server answers, so the home tab shows at once), the inventory,
 * daily-row writes not yet confirmed, and on turf the Procurement tab's
 * remembered job. Two things went wrong with them.
 *
 *   1. They were kept under names everyone on the browser shares, and signing
 *      out left them. The next person to sign in, from another company, saw
 *      the last one's jobs — and where their company's server held no jobs
 *      yet, the page saved them into it: another company's jobs, bid lines
 *      and contract values in their data for good. Procurement opened on the
 *      other company's job. A daily-row write still owed went to the wrong
 *      company's server.
 *
 *   2. One failed read of the job index (a cold start, a database blip, a
 *      flaky connection on a job site) was taken for "no index", and the page
 *      saved yesterday's cached copy of every job over the server's — a bid
 *      line a colleague added since was gone, and a job they made dropped off
 *      everyone's list. The same from a failed read inside the minute poll.
 *
 * So this boots each page in a real DOM against a scripted server per company,
 * with the browser's storage carried from one sign-in to the next the way a
 * real browser carries it.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { requireFn } = require('./lib/fn-source');

const root = (...p) => path.resolve(__dirname, '..', ...p);

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''}`); }
}
const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));
const clone = v => JSON.parse(JSON.stringify(v));

const PAGES = [
  { file: 'tracker.html',         division: 'turf',   pre: 'fct_',        procurement: true },
  { file: 'paving.html',          division: 'paving', pre: 'fct_paving_' },
  { file: 'kiewit-pinetree.html', division: 'kiewit', pre: 'fct_kiewit_' },
];
const ROLES = { turf: 'admin', paving: 'admin', kiewit: 'admin' };
const XAVIER = { userId: 1, username: 'xavier', name: 'Xavier', companyCode: 'XCO', role: 'admin', isPlatformAdmin: false, divisionRoles: ROLES, allowedDivisions: Object.keys(ROLES) };
const YURI   = { userId: 2, username: 'yuri',   name: 'Yuri',   companyCode: 'YCO', role: 'admin', isPlatformAdmin: false, divisionRoles: ROLES, allowedDivisions: Object.keys(ROLES) };
const SESSION_KEYS = ['fct_token', 'fct_user', 'fct_division'];

/** Company X's jobs: Penn Cambria with three bid lines, and Franklin Field. */
function xJobs() {
  return {
    p1: { id: 'p1', 'project-name': 'Penn Cambria', 'job-number': '26119', status: 'In Progress', 'contract-amount': '1250000',
      bidItems: [
        { id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: '12500' },
        { id: 'b2', cost_code: 'Stormwater', sub_code: 'Perf drain', unit: 'LF', quantity: '901' },
        { id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization', unit: 'LS', quantity: '1' },
      ] },
    p2: { id: 'p2', 'project-name': 'Franklin Field', 'job-number': '26049', status: 'Awarded', bidItems: [] },
  };
}

/** One company's stored data, under the page's own key names. */
function companyStore(page, jobs, extra = {}) {
  const s = {};
  Object.values(jobs).forEach(j => { s[`${page.pre}project_${j.id}`] = clone(j); });
  if (Object.keys(jobs).length) s[`${page.pre}projects_index`] = { ids: Object.keys(jobs), _ts: 1000 };
  return Object.assign(s, extra);
}

/**
 * A scripted server over one company's `store`. `answer(call, url)` is asked
 * first and may return a response ({status, body}), 'network' for a request
 * that never reaches the server, or null to fall through.
 */
function server(page, store, answer) {
  return (call, u) => {
    const first = answer && answer(call, u);
    if (first) return first;
    const p = u.pathname, m = call.method;
    if (p === '/api/data/_batch') {
      const values = {};
      (u.searchParams.get('keys') || '').split(',').forEach(k => { if (k in store) values[k] = clone(store[k]); });
      return { status: 200, body: { values } };
    }
    if (p === '/api/data/_keys') {
      const prefix = u.searchParams.get('prefix') || '';
      const ids = Object.keys(store).filter(k => k.startsWith(prefix) && store[k] != null).map(k => k.slice(prefix.length));
      return { status: 200, body: { prefix, ids } };
    }
    if (p.startsWith('/api/data/')) {
      const key = decodeURIComponent(p.slice('/api/data/'.length));
      if (m === 'GET') return { status: 200, body: { value: key in store ? clone(store[key]) : null } };
      if (m === 'PUT') { store[key] = call.body && 'value' in call.body ? clone(call.body.value) : null; return { status: 200, body: { ok: true } }; }
      return { status: 200, body: { ok: true } };
    }
    if (p === '/api/daily-rows') return m === 'GET' ? { status: 200, body: { rows: [], hasMore: false } } : { status: 200, body: { ok: true } };
    if (p === '/api/purchase-orders' && m === 'GET') return { status: 200, body: { purchaseOrders: [], updatedAt: null } };
    return null;
  };
}

/**
 * Boot `page.file` signed in as `user`, the browser's storage holding
 * `storage` (what an earlier sign-in left), every request answered by
 * `route`. Every call is recorded. `{ autoReport: true }` opens it as the
 * scheduled-report robot does (?autoreport=1, auto-report.js loaded first);
 * `{ storageQuota }` sets how much the browser's storage holds.
 */
function boot(page, user, storage, route, opts = {}) {
  const calls = [];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (/Not implemented: navigation/i.test(e.message || '')) return;
    errors.push(e.message);
  });
  const EMPTY = { ok: true, value: null, user: null, employees: [], jobs: [], entries: [], rows: [], groups: [] };
  const dom = new JSDOM(fs.readFileSync(root(page.file), 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://datawatch.app/' + page.file + (opts.autoReport ? '?autoreport=1' : ''),
    virtualConsole: vc,
    ...(opts.storageQuota ? { storageQuota: opts.storageQuota } : {}),
    beforeParse(w) {
      if (opts.autoReport) w.eval(fs.readFileSync(root('auto-report.js'), 'utf8'));
      Object.entries(storage || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.localStorage.setItem('fct_token', 'tok-' + user.username);
      w.localStorage.setItem('fct_user', JSON.stringify(user));
      w.localStorage.setItem('fct_division', page.division);
      w.fetch = async (url, init) => {
        const call = { url: String(url), method: (init && init.method) || 'GET', body: null };
        try { call.body = init && init.body ? JSON.parse(init.body) : null; } catch { call.body = init.body; }
        calls.push(call);
        const u = new URL(call.url, 'https://datawatch.app');
        let res = await Promise.resolve(route(call, u));
        if (res === 'network') throw new TypeError('Failed to fetch');
        if (!res) res = { status: 200, body: EMPTY };
        const status = res.status || 200;
        return {
          ok: status >= 200 && status < 300, status,
          json: async () => clone(res.body),
          text: async () => JSON.stringify(res.body),
        };
      };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      w.scrollTo = () => {};
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  const w = dom.window;
  return {
    w, calls, errors,
    ids: () => w.eval('projectsList.map(p => p.id)'),
    /** Everything the browser keeps, but the sign-in itself (what logout() clears). */
    kept: () => {
      const out = {};
      for (let i = 0; i < w.localStorage.length; i++) {
        const k = w.localStorage.key(i);
        if (!SESSION_KEYS.includes(k)) out[k] = w.localStorage.getItem(k);
      }
      return out;
    },
    writes: re => calls.filter(c => c.method !== 'GET' && re.test(new URL(c.url, 'https://datawatch.app').pathname)),
    banner: () => {
      const b = w.document.getElementById('save-error-banner');
      return b && b.style.display !== 'none' ? (w.document.getElementById('save-error-msg') || {}).textContent || '' : '';
    },
  };
}

/** procurement.js into a booted turf page, as its <script defer> would put it, with the tab open. */
async function openProcurement(b) {
  b.w.eval(fs.readFileSync(root('procurement.js'), 'utf8'));
  b.w.document.querySelector('.tab-btn[data-tab="procurement"]').click();
  await settle(250);
}

const jobBlobs = (b, page) => b.writes(new RegExp(`^/api/data/${page.pre}project_`));
const indexWrites = (b, page) => b.writes(new RegExp(`^/api/data/${page.pre}projects_index$`));

(async () => {
  console.log('What the browser keeps of a company\'s jobs, and what it may do with it.');

  // ── 1. Another company's user on the same browser ─────────────────────────
  for (const page of PAGES) {
    console.log(`\n[${page.file}: company X signs out, a new company Y signs in on the same browser]`);
    const X = companyStore(page, xJobs(), { [`${page.pre}inventory`]: [{ id: 'i1', inv_number: 'INV-0001', material: 'X rubber' }] });
    const Y = {};   // a company set up today: no jobs, no index, no inventory yet

    // X works as usual: the job list is cached, an inventory change saved, a
    // daily-row write is still owed, and (turf) Procurement is open on p1.
    const x1 = boot(page, XAVIER, {}, server(page, X));
    await settle();
    assert('X boots without an error', x1.errors.length === 0, x1.errors[0]);
    assert('X sees X\'s jobs', JSON.stringify(x1.ids()) === '["p1","p2"]', x1.ids());
    x1.w.eval('saveInventoryEntries()');
    x1.w.eval("_walAdd('wx', { method: 'POST', projectId: 'p1', rowId: 'rx', row: { id: 'rx', quantity: '5' } })");
    if (page.procurement) {
      await openProcurement(x1);
      x1.w.FCTProcurement._test.selectProject('p1');
      await settle(100);
      assert('X picks Penn Cambria on Procurement', x1.w.FCTProcurement._test.state().projectId === 'p1');
    }
    x1.w.eval('logout()');
    await settle(100);
    const afterX = x1.kept();
    x1.w.close();

    // A browser used before this change also holds the copies under the old
    // names everyone shared.
    const oldNames = {
      [`${page.pre}projects`]: JSON.stringify(Object.values(xJobs())),
      [`${page.pre}inventory`]: JSON.stringify([{ id: 'i1', inv_number: 'INV-0001', material: 'X rubber' }]),
      [`fct_dr_wal_${page.division}`]: JSON.stringify({ wold: { method: 'POST', projectId: 'p1', rowId: 'rold', row: { id: 'rold' }, _ts: Date.now() } }),
    };
    if (page.procurement) Object.assign(oldNames, { fct_proc_project_turf: 'p1', fct_proc_group_turf: 'vendor', fct_proc_showall_turf: '1' });

    const y = boot(page, YURI, { ...afterX, ...oldNames }, server(page, Y));
    // The instant render runs while the page's script runs, before any read
    // has been answered.
    const yFirst = y.ids();
    await settle();
    assert('Y boots without an error', y.errors.length === 0, y.errors[0]);
    assert('Y\'s home tab is never drawn with X\'s jobs, not even before the server answers', yFirst.length === 0, yFirst);
    assert('Y\'s job list is Y\'s (empty), not X\'s', y.ids().length === 0, y.ids());
    assert('nothing on Y\'s page names X\'s job', !/Penn Cambria|Franklin Field/.test(y.w.document.body.textContent));
    assert('none of X\'s jobs is written into Y\'s server', jobBlobs(y, page).length === 0 && !Object.keys(Y).some(k => k.startsWith(`${page.pre}project_`)),
      jobBlobs(y, page).map(c => c.url));
    assert('Y\'s job index is not written with X\'s jobs', indexWrites(y, page).length === 0 && !(`${page.pre}projects_index` in Y), indexWrites(y, page).map(c => JSON.stringify(c.body)));
    assert('X\'s inventory is not carried into Y\'s server', y.writes(new RegExp(`^/api/data/${page.pre}inventory$`)).length === 0 && !(`${page.pre}inventory` in Y));
    assert('X\'s unsent daily-row writes are not sent to Y\'s server', y.writes(/^\/api\/daily-rows$/).length === 0,
      y.writes(/^\/api\/daily-rows$/).map(c => JSON.stringify(c.body)));
    const yKept = y.kept();
    assert('the copies under the old shared names are gone from the browser',
      !(`${page.pre}projects` in yKept) && !(`${page.pre}inventory` in yKept) && !Object.keys(yKept).some(k => /^fct_proc_\w+_turf$/.test(k)),
      Object.keys(yKept));
    if (page.procurement) {
      await openProcurement(y);
      assert('Procurement does not open on X\'s remembered job for Y', y.w.FCTProcurement._test.state().projectId === null,
        y.w.FCTProcurement._test.state().projectId);
      assert('  and asks Y to pick a job', /Pick a job above/.test((y.w.document.getElementById('fctproc-body') || {}).textContent || ''));
      assert('  nor keeps the old shared grouping or "show all"', y.w.FCTProcurement._test.state().grouping !== 'vendor' && y.w.FCTProcurement._test.state().showAll === false);
    }
    const afterY = y.kept();
    y.w.close();

    // X comes back: X's place is where X left it.
    const x2 = boot(page, XAVIER, afterY, server(page, X));
    const x2First = x2.ids();
    await settle();
    assert('X, signing back in, is drawn X\'s cached jobs at once, before the server answers', JSON.stringify(x2First) === '["p1","p2"]', x2First);
    const rx = x2.writes(/^\/api\/daily-rows$/).filter(c => c.body && c.body.row && c.body.row.id === 'rx');
    assert('X\'s owed daily-row write is sent to X\'s server when X signs back in', rx.length === 1 && rx[0].body.projectId === 'p1', x2.writes(/^\/api\/daily-rows$/).map(c => JSON.stringify(c.body)));
    if (page.procurement) {
      await openProcurement(x2);
      assert('Procurement opens on the job X left it on', x2.w.FCTProcurement._test.state().projectId === 'p1');
    }
    x2.w.close();
  }

  // ── 2. Unsent daily-row writes kept under the old shared name ────────────
  for (const page of PAGES) {
    console.log(`\n[${page.file}: daily-row writes still owed under the old shared name]`);
    const legacyKey = `fct_dr_wal_${page.division}`;
    const now = Date.now();
    const legacy = JSON.stringify({
      a: { method: 'POST', projectId: 'p1', rowId: 'ra', row: { id: 'ra', quantity: '3' }, _ts: now },
      z: { method: 'POST', projectId: 'zz', rowId: 'rz', row: { id: 'rz', quantity: '9' }, _ts: now },
    });
    const Y = companyStore(page, { y1: { id: 'y1', 'project-name': 'Y Field', bidItems: [] } });
    const y = boot(page, YURI, { [legacyKey]: legacy }, server(page, Y));
    await settle();
    assert('a company with neither job sends neither write', y.writes(/^\/api\/daily-rows$/).length === 0, y.writes(/^\/api\/daily-rows$/).map(c => JSON.stringify(c.body)));
    const yKept = y.kept();
    y.w.close();
    const X = companyStore(page, xJobs());
    const x = boot(page, XAVIER, yKept, server(page, X));
    await settle();
    const posts = x.writes(/^\/api\/daily-rows$/).map(c => c.body && c.body.row && c.body.row.id);
    assert('the company whose job it is sends its write, and only that one', JSON.stringify(posts) === '["ra"]', posts);
    const left = JSON.parse(x.w.localStorage.getItem(legacyKey) || '{}');
    assert('  the other job\'s write is left for its own company', JSON.stringify(Object.keys(left)) === '["z"]', Object.keys(left));
    x.w.close();
  }

  // ── 3. A read of the job index that fails ────────────────────────────────
  for (const page of PAGES) {
    console.log(`\n[${page.file}: the job index cannot be read once]`);
    const idxPath = `/api/data/${page.pre}projects_index`;
    const S = companyStore(page, xJobs());
    // Yesterday: the PM's page caches the jobs.
    const d1 = boot(page, XAVIER, {}, server(page, S));
    await settle();
    const cache = d1.kept();
    d1.w.close();
    // Overnight a colleague adds a bid line to Penn Cambria and makes a job.
    S[`${page.pre}project_p1`].bidItems.push({ id: 'b4', cost_code: 'Stormwater', sub_code: 'Inlet', unit: 'EA', quantity: '4' });
    S[`${page.pre}project_p3`] = { id: 'p3', 'project-name': 'Westmont', 'job-number': '26201', bidItems: [] };
    S[`${page.pre}projects_index`] = { ids: ['p1', 'p2', 'p3'], _ts: 2000 };

    // This morning the first read of the index answers 500.
    let idxFails = 1;
    const d2 = boot(page, XAVIER, cache, server(page, S, (c, u) => (u.pathname === idxPath && c.method === 'GET' && idxFails-- > 0 ? { status: 500, body: { error: 'cold start' } } : null)));
    await settle();
    assert('boots without an error', d2.errors.length === 0, d2.errors[0]);
    assert('no job is saved from yesterday\'s copy', jobBlobs(d2, page).length === 0, jobBlobs(d2, page).map(c => c.url));
    assert('the job index is not rewritten from it', indexWrites(d2, page).length === 0, indexWrites(d2, page).map(c => JSON.stringify(c.body)));
    assert('the colleague\'s bid line is still on the server', S[`${page.pre}project_p1`].bidItems.length === 4);
    assert('  and their job is still in the index', JSON.stringify(S[`${page.pre}projects_index`].ids) === '["p1","p2","p3"]', S[`${page.pre}projects_index`]);
    assert('the PM still sees yesterday\'s jobs meanwhile', JSON.stringify(d2.ids()) === '["p1","p2"]', d2.ids());
    assert('  with no alarm shown for one failed read', d2.banner() === '', d2.banner());
    // A job edited from that copy is not saved over the server's.
    d2.w.eval("getProj('p1')['notes'] = 'typed on the old copy'; saveProject('p1');");
    await settle(800);
    assert('a job edited from yesterday\'s copy is not saved over the server\'s', jobBlobs(d2, page).length === 0 && indexWrites(d2, page).length === 0,
      jobBlobs(d2, page).concat(indexWrites(d2, page)).map(c => c.url));
    assert('  and the PM is told it was not saved', /have not loaded from the server/.test(d2.banner()), d2.banner());
    // The read is tried again, and then the jobs are the server's.
    await settle(2200);
    const p1 = d2.w.eval('getProj("p1")');
    assert('the read is tried again shortly, and the PM then sees the colleague\'s job', JSON.stringify(d2.ids()) === '["p1","p2","p3"]', d2.ids());
    assert('  and the colleague\'s bid line', p1 && p1.bidItems.length === 4 && p1.notes !== 'typed on the old copy');
    assert('  still with nothing written back from the old copy', jobBlobs(d2, page).length === 0 && indexWrites(d2, page).length === 0);
    d2.w.eval("getProj('p1')['notes'] = 'after the load'; saveProject('p1');");
    await settle(800);
    const saved = jobBlobs(d2, page);
    assert('once loaded, a job edit saves as usual, with the colleague\'s bid line in it',
      saved.length === 1 && saved[0].body.value.notes === 'after the load' && saved[0].body.value.bidItems.length === 4, saved.map(c => c.url));

    // In session: the minute poll's reload, with its read of the index failing.
    const before = d2.calls.length;
    idxFails = 1;
    const answer = await d2.w.eval('loadProjects()');
    await settle(200);
    const later = d2.calls.slice(before).filter(c => c.method !== 'GET');
    assert('a reload whose index read fails writes nothing', later.length === 0, later.map(c => c.url));
    assert('  keeps the jobs in hand', JSON.stringify(d2.ids()) === '["p1","p2","p3"]', d2.ids());
    assert('  and says it took nothing, so the poll tries again', answer === false, answer);
    d2.w.close();

    // A request that never reaches the server is no different from a 500.
    let netFails = 1;
    const d3 = boot(page, XAVIER, cache, server(page, S, (c, u) => (u.pathname === idxPath && c.method === 'GET' && netFails-- > 0 ? 'network' : null)));
    await settle();
    assert('an index read lost on the network writes nothing either', jobBlobs(d3, page).length === 0 && indexWrites(d3, page).length === 0,
      jobBlobs(d3, page).concat(indexWrites(d3, page)).map(c => c.url));
    d3.w.close();

    // No index on the server (a company from before the per-job keys), and
    // the read of the old single list fails: nothing is known, nothing saved.
    const L = companyStore(page, {});
    let legacyFails = 1;
    const d4 = boot(page, XAVIER, cache, server(page, L, (c, u) => (u.pathname === `/api/data/${page.pre}projects` && legacyFails-- > 0 ? { status: 503, body: {} } : null)));
    await settle();
    assert('with no index, a failed read of the old job list does not save the cached copy as the company\'s jobs',
      jobBlobs(d4, page).length === 0 && indexWrites(d4, page).length === 0, jobBlobs(d4, page).concat(indexWrites(d4, page)).map(c => c.url));
    d4.w.close();
  }

  // ── 4. The poll after a reload that took nothing ─────────────────────────
  // The poll takes an index as "acted on" before it reloads. A reload whose
  // read failed now leaves the jobs and their stamp as they were — it no
  // longer rewrites the index from the cache — and the poll must still see
  // the colleague's change on its next tick rather than settle on it unseen.
  console.log('\n[the minute poll, after a reload that could not read the jobs]');
  for (const page of PAGES) {
    const src = fs.readFileSync(root(page.file), 'utf8');
    const world = { loads: 0, fail: true, server: { ids: ['p1', 'p2'], _ts: 5 }, ids: ['p1'], ts: 1 };
    const sandbox = {
      console,
      apiGet: async () => world.server,
      _isEditing: () => false,
      activeTab: 'cost',
      renderHomeTab() {}, renderProjectInfoComputed() {}, _procRerender() {},
      get projectsList() { return world.ids.map(id => ({ id })); },
      get _lastProjIndexTs() { return world.ts; },
      set _lastProjIndexTs(v) { world.ts = v; },
      // As loadProjects does: a read that worked takes the index and its
      // stamp; one that failed changes nothing and answers false.
      loadProjects: async () => {
        world.loads++;
        if (world.fail) return false;
        world.ids = world.server.ids.slice();
        world.ts = world.server._ts;
        return true;
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${requireFn(src, '_indexSig')}\nlet _lastIndexSig = null;\nasync ${requireFn(src, '_pollProjects').replace(/^async /, '')}`, sandbox);
    const poll = () => vm.runInContext('_pollProjects()', sandbox);
    await poll();
    await poll();
    assert(`${page.file}: a reload that could not read the jobs is tried again on the next tick, though the index has not changed`, world.loads === 2, world.loads);
    world.fail = false;
    await poll();
    await poll();
    await poll();
    assert(`${page.file}:   and once one has worked, an unchanged index reloads nothing`, world.loads === 3 && world.ids.length === 2, world.loads);
  }

  // ── 5. Daily Entry while the job read is failing ─────────────────────────
  // The daily rows are their own table, saved row by row (drPostBulk). The
  // job record does not change when a foreman submits the day, so the refusal
  // of a job save from the cached copy must not tell him it was not saved.
  const TODAY = '2026-11-24';
  const dayRows = () => [{ id: 'r-am', _projectId: 'p1', date: TODAY, employee: 'Joe', labor_hours: 8, cost_code: 'Stormwater', sub_code: 'Geofabric', quantity: '0' }];
  const withDayRows = (c, u) => (u.pathname === '/api/daily-rows' && c.method === 'GET' ? { status: 200, body: { rows: dayRows(), hasMore: false } } : null);
  for (const page of PAGES) {
    console.log(`\n[${page.file}: a foreman submits the day while the job read is failing]`);
    const idxPath = `/api/data/${page.pre}projects_index`;
    const S = companyStore(page, xJobs(), { [`${page.pre}lists`]: { employees: [{ name: 'Joe', job_class: 'Laborer', non_prevailing_rate: 30 }], cost_codes: [], field_types: ['Turf'] } });
    const d1 = boot(page, XAVIER, {}, server(page, S, withDayRows));
    await settle();
    const cache = d1.kept();
    d1.w.close();
    let idxFails = 3;
    const d = boot(page, XAVIER, cache, server(page, S, (c, u) => (u.pathname === idxPath && c.method === 'GET' && idxFails-- > 0 ? { status: 500, body: {} } : withDayRows(c, u))));
    await settle();
    assert('the jobs have not loaded', d.w.eval('_projectsLoaded') === false);
    const doc = d.w.document;
    d.w.eval('renderMobileEntryForm()');
    doc.getElementById('mob-project').value = 'p1';
    doc.getElementById('mob-date').value = TODAY;
    d.w.eval("renderMobTodayEntries('p1')");
    const listed = (doc.getElementById('mob-today-entries') || {}).textContent || '';
    assert('the day\'s entries are read for the cached jobs all the same', d.w.eval("getProj('p1').dailyRows.length") === 1, d.w.eval("getProj('p1').dailyRows.length"));
    assert('  and Daily Entry lists them, not "No entries for this date yet."', /Entries for this date/.test(listed) && !/No entries/.test(listed), listed.trim().slice(0, 80));
    assert('  reading them writes nothing', jobBlobs(d, page).length === 0 && indexWrites(d, page).length === 0, jobBlobs(d, page).concat(indexWrites(d, page)).map(c => c.url));
    doc.querySelector('.mob-emp-cb').checked = true;
    doc.querySelector('.mob-hrs-inp').value = '8';
    await d.w.eval('submitMobileEntry()');
    await settle(800);
    const posts = d.writes(/^\/api\/daily-rows$/).filter(c => c.method === 'POST');
    assert('the submitted row is saved', posts.length === 1 && posts[0].body.projectId === 'p1' && posts[0].body.rows[0].employee === 'Joe', posts.map(c => JSON.stringify(c.body).slice(0, 120)));
    assert('  and the foreman is not told it was not saved', d.banner() === '', d.banner());
    assert('  the form says the row was added', /1 row added/.test(doc.body.textContent));
    assert('  and the cached job is not saved over the server\'s', jobBlobs(d, page).length === 0 && indexWrites(d, page).length === 0, jobBlobs(d, page).concat(indexWrites(d, page)).map(c => c.url));
    d.w.close();
  }

  // ── 6. Deleting a job while the job read is failing ──────────────────────
  for (const page of PAGES) {
    console.log(`\n[${page.file}: a job is deleted while the job read is failing]`);
    const idxPath = `/api/data/${page.pre}projects_index`;
    const S = companyStore(page, xJobs());
    const d1 = boot(page, XAVIER, {}, server(page, S));
    await settle();
    const cache = d1.kept();
    d1.w.close();
    let idxFails = 1;
    const d = boot(page, XAVIER, cache, server(page, S, (c, u) => (u.pathname === idxPath && c.method === 'GET' && idxFails-- > 0 ? { status: 500, body: {} } : null)));
    await settle(300);
    assert('the jobs have not loaded', d.w.eval('_projectsLoaded') === false);
    const before = d.calls.length;
    d.w.eval("deleteProject('p2')");
    await settle(200);
    const sent = d.calls.slice(before).filter(c => c.method !== 'GET');
    assert('the delete is refused: no dialog to confirm it', !d.w.document.getElementById('dp-input'));
    assert('  and none of its deletes is sent (rows, record, files, Procurement rows)', sent.length === 0, sent.map(c => c.method + ' ' + c.url));
    assert('  the PM is told it was not done', /have not loaded from the server/.test(d.banner()), d.banner());
    assert('  the job stays, on the server and on the page', S[`${page.pre}project_p2`] && S[`${page.pre}projects_index`].ids.includes('p2') && d.ids().includes('p2'));
    // Once the jobs have loaded, the delete goes through, index and all.
    await settle(2400);
    assert('the jobs load on the retry', d.w.eval('_projectsLoaded') === true);
    d.w.eval("deleteProject('p2')");
    const inp = d.w.document.getElementById('dp-input');
    if (inp) { inp.value = 'Franklin Field'; inp.dispatchEvent(new d.w.Event('input')); d.w.document.getElementById('dp-confirm').click(); }
    await settle(300);
    assert('  then a delete takes the job off the index', !!inp && S[`${page.pre}project_p2`] == null && JSON.stringify(S[`${page.pre}projects_index`].ids) === '["p1"]', S[`${page.pre}projects_index`]);
    d.w.close();
  }

  // ── 7. A crew tablet the company's foremen share ─────────────────────────
  for (const page of PAGES) {
    console.log(`\n[${page.file}: a foreman's owed daily rows, then another foreman of the company on the tablet]`);
    const S = companyStore(page, xJobs());
    const ALICE = Object.assign({}, XAVIER, { userId: 3, username: 'alice', name: 'Alice' });
    let offline = true;
    const x = boot(page, XAVIER, {}, server(page, S, (c, u) => (u.pathname === '/api/daily-rows' && c.method !== 'GET' && offline ? 'network' : null)));
    await settle();
    x.w.eval(`drPost('p1', { id: 'rowX', date: '${TODAY}', employee: 'Joe', labor_hours: 8, quantity: '0' })`);
    await settle(500);
    x.w.eval('logout()');
    await settle(100);
    const afterX = x.kept();
    x.w.close();
    offline = false;
    // Logs kept per user, as this page did for a while before release.
    const now = Date.now();
    afterX[`fct_dr_wal_${page.division}@XCO/bob`] = JSON.stringify({ post_rowB: { method: 'POST', projectId: 'p1', rowId: 'rowB', row: { id: 'rowB', date: TODAY, employee: 'Bob', labor_hours: 4 }, _ts: now } });
    afterX[`fct_dr_wal_${page.division}@YCO/yuri`] = JSON.stringify({ post_rowY: { method: 'POST', projectId: 'y1', rowId: 'rowY', row: { id: 'rowY' }, _ts: now } });
    // Another company's user first: none of it is theirs to send.
    const Y = companyStore(page, { y1: { id: 'y1', 'project-name': 'Y Field', bidItems: [] } });
    const y = boot(page, YURI, afterX, server(page, Y));
    await settle(800);
    const ySent = y.writes(/^\/api\/daily-rows$/).map(c => JSON.stringify(c.body));
    assert('another company\'s user sends none of company X\'s owed rows', !ySent.some(b => /rowX|rowB/.test(b)), ySent);
    assert('  only the one left in a per-user log of their own company', ySent.filter(b => b.includes('rowY')).length === 1, ySent);
    y.w.eval('logout()');
    await settle(100);
    const afterY = y.kept();
    y.w.close();
    const a = boot(page, ALICE, afterY, server(page, S));
    await settle(800);
    const aSent = a.writes(/^\/api\/daily-rows$/).map(c => JSON.stringify(c.body));
    assert('the next foreman of the company sends the row the first still owed', aSent.filter(b => b.includes('rowX')).length === 1, aSent);
    assert('  and the rows in a log kept per user of the same company', aSent.filter(b => b.includes('rowB')).length === 1, aSent);
    assert('  and none of another company\'s', !aSent.some(b => b.includes('rowY')), aSent);
    assert('  the per-user log taken over is gone from the browser', a.w.localStorage.getItem(`fct_dr_wal_${page.division}@XCO/bob`) === null);
    a.w.close();
  }

  // ── 8. The scheduled-report robot, its job read failing ──────────────────
  {
    console.log('\n[the report robot, when its read of the job index fails]');
    const runs = PAGES.map(page => {
      const idxPath = `/api/data/${page.pre}projects_index`;
      const S = companyStore(page, xJobs());
      let once = 1;
      const flaky = boot(page, XAVIER, {}, server(page, S, (c, u) => (u.pathname === idxPath && c.method === 'GET' && once-- > 0 ? { status: 500, body: {} } : null)), { autoReport: true });
      const down = boot(page, XAVIER, {}, server(page, S, (c, u) => (u.pathname === idxPath && c.method === 'GET' ? { status: 500, body: {} } : null)), { autoReport: true });
      return { page, flaky, down };
    });
    for (const { page, flaky, down } of runs) {
      // plan() waits for the page to be ready, as the runner's does.
      const ready = await flaky.w.dwAutoReport.plan({ type: flaky.w.dwAutoReport.types()[0], projectId: '*' }).then(() => 'ready', e => e.message);
      assert(`${page.file}: one failed read is tried again, and the robot has the jobs`, ready === 'ready' && JSON.stringify(flaky.ids()) === '["p1","p2"]', [ready, flaky.ids()]);
      const failed = await down.w.dwAutoReport.plan({ type: down.w.dwAutoReport.types()[0], projectId: '*' }).then(r => 'resolved ' + JSON.stringify(r), e => e.message);
      assert(`${page.file}:   a read that keeps failing fails the run, rather than report no jobs`, /could not be read/.test(failed), failed);
      flaky.w.close(); down.w.close();
    }
  }

  // ── 9. A bid line edited while the job read is failing ───────────────────
  for (const page of PAGES) {
    console.log(`\n[${page.file}: a bid line a colleague deleted is edited from the cached copy]`);
    const idxPath = `/api/data/${page.pre}projects_index`;
    const S = companyStore(page, xJobs());
    const d1 = boot(page, XAVIER, {}, server(page, S));
    await settle();
    const cache = d1.kept();
    d1.w.close();
    S[`${page.pre}project_p1`].bidItems = S[`${page.pre}project_p1`].bidItems.filter(b => b.id !== 'b3');
    let idxFails = 1;
    // /api/bid-items as the server does it: replace the line, or add it when missing.
    const d = boot(page, XAVIER, cache, server(page, S, (c, u) => {
      if (u.pathname === idxPath && c.method === 'GET' && idxFails-- > 0) return { status: 500, body: {} };
      if (u.pathname === '/api/bid-items' && c.method === 'PUT') {
        const blob = S[u.searchParams.get('projectKey')];
        const i = blob.bidItems.findIndex(b => b.id === c.body.bidItem.id);
        if (i >= 0) blob.bidItems[i] = c.body.bidItem; else blob.bidItems.push(c.body.bidItem);
        return { status: 200, body: { ok: true } };
      }
      return null;
    }));
    await settle(300);
    assert('the jobs have not loaded', d.w.eval('_projectsLoaded') === false);
    d.w.eval("updateBidItem('p1', 'b3', 'quantity', '2')");
    await settle(900);
    assert('the line edit is not sent', d.writes(/^\/api\/bid-items$/).length === 0, d.writes(/^\/api\/bid-items$/).map(c => c.url));
    assert('  so the deleted line is not put back on the bid', JSON.stringify(S[`${page.pre}project_p1`].bidItems.map(b => b.id)) === '["b1","b2"]', S[`${page.pre}project_p1`].bidItems.map(b => b.id));
    assert('  and the PM is told it was not saved', /have not loaded from the server/.test(d.banner()), d.banner());
    await settle(1600);
    assert('the jobs load on the retry', d.w.eval('_projectsLoaded') === true);
    d.w.eval("updateBidItem('p1', 'b1', 'quantity', '13000')");
    await settle(900);
    const puts = d.writes(/^\/api\/bid-items$/);
    assert('  then a line edit is saved as usual', puts.length === 1 && S[`${page.pre}project_p1`].bidItems.find(b => b.id === 'b1').quantity === '13000', puts.map(c => c.url));
    d.w.close();
  }

  // ── 10. A shared browser whose storage the per-user copies have filled ───
  // Each user's job-list copy stays on the browser. Once storage was full the
  // inventory save threw on its local copy, before its PUT: the edit never
  // reached the server.
  for (const page of PAGES) {
    console.log(`\n[${page.file}: storage filled by other people's job-list copies]`);
    const S = companyStore(page, xJobs(), { [`${page.pre}inventory`]: [] });
    const QUOTA = 400000;
    const others = {
      [`${page.pre}projects@XCO/ada`]: JSON.stringify([{ id: 'p1', notes: 'a'.repeat(150000) }]),
      [`${page.pre}projects@YCO/yuri`]: JSON.stringify([{ id: 'y1', notes: 'y'.repeat(150000) }]),
      [`fct_dr_wal_${page.division}@YCO`]: JSON.stringify({ post_rowY: { method: 'POST', projectId: 'y1', rowId: 'rowY', row: { id: 'rowY' }, _ts: Date.now() } }),
    };
    const d = boot(page, XAVIER, others, server(page, S), { storageQuota: QUOTA });
    await settle();
    // Whatever room is left, filled with something that is not a job-list copy.
    const fill = d.w.eval(`(() => { let n = 0; try { for (;;) { localStorage.setItem('zz_fill#' + n, 'f'.repeat(1024)); n++; } } catch {} return n; })()`);
    const mine = d.w.eval('PROJECTS_KEY');
    const mineBefore = d.w.localStorage.getItem(mine);
    const before = d.calls.length;
    // Loaded (paving and kiewit read the inventory when its tab opens).
    const threw = d.w.eval(`(() => { _inventoryLoaded = true; inventoryEntries = Array.from({ length: 40 }, (_, i) => ({ id: 'inv' + i, inv_number: 'INV-' + i, material: 'Turf roll ' + i, notes: 'z'.repeat(200) }));
      try { saveInventoryEntries(); return null; } catch (e) { return e.name; } })()`);
    await settle(200);
    const puts = d.calls.slice(before).filter(c => c.method === 'PUT' && new URL(c.url, 'https://datawatch.app').pathname === `/api/data/${page.pre}inventory`);
    assert('with storage full, an inventory save is still sent to the server', threw === null && puts.length === 1 && puts[0].body.value.length === 40, { threw, puts: puts.length, fill });
    assert('  the other people\'s job-list copies make room for its copy', d.w.localStorage.getItem(`${page.pre}projects@XCO/ada`) === null && d.w.localStorage.getItem(`${page.pre}projects@YCO/yuri`) === null
      && JSON.parse(d.w.localStorage.getItem(`${page.pre}inventory@XCO/xavier`) || '[]').length === 40);
    assert('  this user\'s own job-list copy is kept', d.w.localStorage.getItem(mine) === mineBefore && !!mineBefore);
    assert('  and nothing else goes: not another company\'s owed daily rows, not other keys',
      !!d.w.localStorage.getItem(`fct_dr_wal_${page.division}@YCO`) && d.w.localStorage.getItem('zz_fill#0') !== null && d.w.localStorage.getItem('zz_fill#' + (fill - 1)) !== null);
    d.w.close();
  }

  // ── 11. A sub code's data deleted while the job read is failing ──────────
  // The day's rows are read for the cached jobs (see 5), so the Cost tab's
  // "Delete all data for this sub code" found them, and its confirm sent the
  // DELETE of every row of that sub code: gone from the server for good. Its
  // bid-line half was refused with saveProject, and the banner said nothing
  // had been saved.
  for (const page of PAGES) {
    console.log(`\n[${page.file}: a sub code's data is deleted while the job read is failing]`);
    const idxPath = `/api/data/${page.pre}projects_index`;
    const S = companyStore(page, xJobs());
    let rows = [
      { id: 'r1', _projectId: 'p1', date: TODAY, employee: 'Joe', labor_hours: 8, cost_code: 'Stormwater', sub_code: 'Geofabric', quantity: '4000' },
      { id: 'r2', _projectId: 'p1', date: TODAY, employee: 'Ann', labor_hours: 8, cost_code: 'Stormwater', sub_code: 'Geofabric', quantity: '3500' },
    ];
    // /api/daily-rows as the server does it: a DELETE by sub code takes every row of it.
    const rowsApi = (c, u) => {
      if (u.pathname !== '/api/daily-rows') return null;
      if (c.method === 'GET') return { status: 200, body: { rows, hasMore: false } };
      if (c.method === 'DELETE' && u.searchParams.get('subCode')) { rows = rows.filter(r => r.sub_code !== u.searchParams.get('subCode')); return { status: 200, body: { ok: true } }; }
      return null;
    };
    const d1 = boot(page, XAVIER, {}, server(page, S, rowsApi));
    await settle();
    const cache = d1.kept();
    d1.w.close();
    let idxFails = 1;
    const d = boot(page, XAVIER, cache, server(page, S, (c, u) => (u.pathname === idxPath && c.method === 'GET' && idxFails-- > 0 ? { status: 500, body: {} } : rowsApi(c, u))));
    await settle();
    assert('the jobs have not loaded', d.w.eval('_projectsLoaded') === false);
    assert('  the sub code\'s rows are read for the cached jobs', d.w.eval("getProj('p1').dailyRows.map(r => r.id).join()") === 'r1,r2', d.w.eval("getProj('p1').dailyRows.map(r => r.id).join()"));
    // The PM clicks the sub code's delete on the Cost tab, and confirms it the
    // way the dialog asks: by typing the sub code.
    const deleteSubCode = () => {
      d.w.eval("deleteDailyRowsBySubCode('', 'Geofabric')");
      const inp = d.w.document.getElementById('dsc-input');
      if (inp) { inp.value = 'Geofabric'; inp.dispatchEvent(new d.w.Event('input')); d.w.document.getElementById('dsc-confirm').click(); }
      return !!inp;
    };
    let before = d.calls.length;
    const asked = deleteSubCode();
    await settle(300);
    const sent = d.calls.slice(before).filter(c => c.method !== 'GET');
    assert('the delete is refused: no dialog to confirm it', !asked);
    assert('  and nothing is sent: not the rows\' DELETE, not the bid line\'s save', sent.length === 0, sent.map(c => c.method + ' ' + c.url));
    assert('  the rows stay on the server', rows.map(r => r.id).join() === 'r1,r2', rows.map(r => r.id));
    assert('  the PM is told it was not done', /have not loaded from the server/.test(d.banner()), d.banner());
    // Once the jobs have loaded, it deletes both halves, as it always did.
    await settle(2400);
    assert('the jobs load on the retry', d.w.eval('_projectsLoaded') === true);
    before = d.calls.length;
    const askedNow = deleteSubCode();
    await settle(900);
    const dels = d.calls.slice(before).filter(c => c.method === 'DELETE' && new URL(c.url, 'https://datawatch.app').pathname === '/api/daily-rows');
    assert('  then the delete is confirmed, and the sub code\'s rows are taken off the server', askedNow && dels.length === 1 && rows.length === 0,
      { askedNow, dels: dels.map(c => c.url), rows: rows.map(r => r.id) });
    assert('  and its bid line off the job', S[`${page.pre}project_p1`].bidItems.map(b => b.id).join() === 'b2,b3', S[`${page.pre}project_p1`].bidItems.map(b => b.id));
    d.w.close();
  }

  // ── 12. An inventory entry edited while the job read is failing ──────────
  // An entry linked to a job copies an edit onto its daily row, which is read
  // with the cached jobs (see 5): the row's PUT and the inventory's both go.
  // It also saved the job, which is refused before the jobs have loaded, and
  // the banner told the PM the edit was not saved and to make it again.
  for (const page of PAGES) {
    console.log(`\n[${page.file}: an inventory entry linked to a job is edited while the job read is failing]`);
    const idxPath = `/api/data/${page.pre}projects_index`;
    const INV = [{ id: 'i1', inv_number: 'INV-0001', project_id: 'p1', inv_row_id: 'r-inv', date: TODAY, employee: 'Joe', hours: '4', rate: '30', material: 'Rubber' }];
    const S = companyStore(page, xJobs(), { [`${page.pre}inventory`]: INV });
    const invRow = [{ id: 'r-inv', _projectId: 'p1', date: TODAY, employee: 'Joe', labor_hours: 4, rate: 30, material: 'Rubber', quantity: '0' }];
    const withInvRow = (c, u) => (u.pathname === '/api/daily-rows' && c.method === 'GET' ? { status: 200, body: { rows: invRow, hasMore: false } } : null);
    const d1 = boot(page, XAVIER, {}, server(page, S, withInvRow));
    await settle();
    const cache = d1.kept();
    d1.w.close();
    let idxFails = 3;
    const d = boot(page, XAVIER, cache, server(page, S, (c, u) => (u.pathname === idxPath && c.method === 'GET' && idxFails-- > 0 ? { status: 500, body: {} } : withInvRow(c, u))));
    await settle();
    // The inventory read fine (paving and kiewit read it when its tab opens).
    d.w.eval(`_inventoryLoaded = true; inventoryEntries = ${JSON.stringify(INV)};`);
    assert('the jobs have not loaded', d.w.eval('_projectsLoaded') === false);
    assert('  the entry\'s daily row is read for the cached jobs', d.w.eval("getProj('p1').dailyRows.some(r => r.id === 'r-inv')") === true);
    const before = d.calls.length;
    // The PM changes its hours from 4 to 6, as the Inventory tab's input handler does.
    d.w.eval("(() => { const e = inventoryEntries.find(x => x.id === 'i1'); e.hours = '6'; _syncINVRowField(e, 'hours'); saveInventoryEntries(); })()");
    await settle(300);
    const sent = d.calls.slice(before).filter(c => c.method !== 'GET');
    const at = c => new URL(c.url, 'https://datawatch.app');
    const rowPuts = sent.filter(c => c.method === 'PUT' && at(c).pathname === '/api/daily-rows' && at(c).searchParams.get('id') === 'r-inv');
    const invPuts = sent.filter(c => c.method === 'PUT' && at(c).pathname === `/api/data/${page.pre}inventory`);
    assert('the edit is sent to its daily row', rowPuts.length === 1 && String(rowPuts[0].body.row.labor_hours) === '6', sent.map(c => c.method + ' ' + c.url));
    assert('  and the inventory is saved with it', invPuts.length === 1 && invPuts[0].body.value[0].hours === '6', sent.map(c => c.method + ' ' + c.url));
    assert('  and the PM is not told it was not saved', d.banner() === '', d.banner());
    assert('  the cached job is not saved over the server\'s', jobBlobs(d, page).length === 0 && indexWrites(d, page).length === 0, jobBlobs(d, page).concat(indexWrites(d, page)).map(c => c.url));
    d.w.close();
  }

  // ── 13. Daily Entry on a browser whose storage is full ───────────────────
  // Submitting the day keeps the job picked for next time, before the rows
  // are posted. With storage full (see 10) that write threw, and the
  // foreman's day was never posted at all.
  for (const page of PAGES) {
    console.log(`\n[${page.file}: a foreman submits the day on a browser whose storage is full]`);
    const S = companyStore(page, xJobs(), { [`${page.pre}lists`]: { employees: [{ name: 'Joe', job_class: 'Laborer', non_prevailing_rate: 30 }], cost_codes: [], field_types: ['Turf'] } });
    const others = { [`${page.pre}projects@XCO/ada`]: JSON.stringify([{ id: 'p1', notes: 'a'.repeat(150000) }]) };
    const d = boot(page, XAVIER, others, server(page, S), { storageQuota: 400000 });
    await settle();
    // Whatever room is left, filled to the last character with something that is not a job-list copy.
    const fill = d.w.eval(`(() => { let n = 0; for (let sz = 4096; sz >= 1; sz = Math.floor(sz / 2)) { try { for (;;) { localStorage.setItem('zz' + n, 'f'.repeat(sz)); n++; } } catch {} } return n; })()`);
    const full = d.w.eval(`(() => { try { localStorage.setItem('mob_last_proj', 'p1'); } catch { return true; } localStorage.removeItem('mob_last_proj'); return false; })()`);
    assert('storage is full: not even the job picked fits', full === true, { fill });
    const mine = d.w.eval('PROJECTS_KEY');
    const mineBefore = d.w.localStorage.getItem(mine);
    const doc = d.w.document;
    d.w.eval('renderMobileEntryForm()');
    doc.getElementById('mob-project').value = 'p1';
    doc.getElementById('mob-date').value = TODAY;
    d.w.eval("renderMobTodayEntries('p1')");
    doc.querySelector('.mob-emp-cb').checked = true;
    doc.querySelector('.mob-hrs-inp').value = '8';
    const before = d.calls.length;
    const threw = await d.w.eval('submitMobileEntry()').then(() => null, e => e.name + ': ' + e.message);
    await settle(800);
    const posts = d.calls.slice(before).filter(c => c.method === 'POST' && new URL(c.url, 'https://datawatch.app').pathname === '/api/daily-rows');
    assert('the day is posted all the same', threw === null && posts.length === 1 && posts[0].body.projectId === 'p1' && posts[0].body.rows[0].employee === 'Joe',
      { threw, posts: posts.map(c => JSON.stringify(c.body).slice(0, 120)) });
    assert('  the form says the row was added', /1 row added/.test(doc.body.textContent));
    assert('  the other people\'s job-list copies make room for the job picked', d.w.localStorage.getItem(`${page.pre}projects@XCO/ada`) === null && d.w.localStorage.getItem('mob_last_proj') === 'p1',
      d.w.localStorage.getItem('mob_last_proj'));
    assert('  this user\'s own job-list copy is kept, and nothing else goes',
      d.w.localStorage.getItem(mine) === mineBefore && !!mineBefore && d.w.localStorage.getItem('zz0') !== null && d.w.localStorage.getItem('zz' + (fill - 1)) !== null);
    d.w.close();
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
