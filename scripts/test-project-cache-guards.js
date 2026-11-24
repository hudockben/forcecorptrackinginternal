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
 * `route`. Every call is recorded.
 */
function boot(page, user, storage, route) {
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
    url: 'https://datawatch.app/' + page.file,
    virtualConsole: vc,
    beforeParse(w) {
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

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
