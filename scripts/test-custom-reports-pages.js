#!/usr/bin/env node
'use strict';
/**
 * Analytics → Custom Reporting, as each division page wires it in.
 *
 * Run: node scripts/test-custom-reports-pages.js
 *
 * The builder and its figures live in custom-reports.js and
 * custom-reports-engine.js, shared by turf, paving and Kiewit Pinetree, and
 * have suites of their own. What those suites cannot see is the seam: whether
 * a page offers the menu item at all, whether clicking it lands on a panel the
 * module can draw into, whether the scripts load in the order the module needs,
 * and — the part that matters most to a customer receiving one of these — what
 * the page tells the module about the person looking. A page that hands over
 * canSeeFinancials: true for a level2 lets contract and profit columns into a
 * report the Financials tab would have refused them; one that hands over a
 * helper under the wrong key leaves the module quietly working out % complete
 * its own way, and the customer's report disagrees with the dashboard.
 *
 * So for each page it:
 *   - reads the markup: the menu item (once, last in the Analytics menu), the
 *     panel next to the other analytics panels, the two deferred script tags,
 *     engine first;
 *   - runs the page's own tab-visibility pass per role in a DOM, so the item
 *     shows for everyone who has Analytics and the menu stays gone for sales;
 *   - runs the page's own analyticsSwitchTab and renderHeaderActions against
 *     the real nav and panels;
 *   - lifts renderCustomReports and runs it in a vm with a fake
 *     FCTCustomReports, with the page's own perm computed for each role, and
 *     checks every key of the adapter — division, area unit, the financial
 *     gate, live getters, a ready() that really waits for the old daily rows,
 *     and helpers that are the page's functions themselves, not look-alikes;
 *   - checks the wait for the deferred script is bounded, restarts on a fresh
 *     visit, stops when the user walks away, and that a module that throws
 *     leaves a message in the panel rather than a blank tab.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');
const { fnSource, requireFn, sliceSource } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}
// A lift that throws is a failed check, not a crashed suite: the other pages
// still have something to say.
function attempt(label, fn) {
  try { return fn(); }
  catch (err) { assert(label, false, err.message); return undefined; }
}
async function attemptAsync(label, fn) {
  try { return await fn(); }
  catch (err) { assert(label, false, err.stack || err.message); return undefined; }
}

const ROOT = path.resolve(__dirname, '..');

// What every page must hand the module (spec §3), and the page function each
// helper key is filled from. lineAmt / lineTax are the pages' underscored PO
// line helpers.
const ADAPTER_KEYS = ['division', 'divisionLabel', 'apiBase', 'getToken', 'user', 'perm', 'areaUnit', 'ready',
  'getProjects', 'getPurchaseOrders', 'getTruckingEntries', 'helpers', 'onAuthError'];
const PERM_KEYS = ['role', 'canSeeCosts', 'canSeeFinancials', 'canShare'];
const HELPERS = {
  dailyRowCost: 'dailyRowCost', calcDaily: 'calcDaily', bidItemComplete: 'bidItemComplete',
  bidProjectPct: 'bidProjectPct', bidGroupPct: 'bidGroupPct', projForBidItem: 'projForBidItem',
  projectedCostForProject: 'projectedCostForProject', gpEarnedToDate: 'gpEarnedToDate',
  bidContractFigures: 'bidContractFigures', projIsDone: 'projIsDone', lineAmt: '_lineAmt', lineTax: '_lineTax',
};

// menu: the Analytics menu (and with it Custom Reporting) is on screen.
// share: the canShare hint. Financials visibility is not listed — it is read
// off the page's own visibility pass and the adapter must agree with it.
const PAGES = [
  {
    file: 'tracker.html', division: 'turf', label: 'Turf Management', area: 'SF',
    // Turf carries two analytics views the other pages do not.
    lastBefore: 'analytics-item-schedest',
    roles: {
      admin:  { menu: true,  share: true  },
      level3: { menu: true,  share: true  },
      // Turf's restricted roles have no Analytics at all.
      level2: { menu: false, share: false },
      level1: { menu: false, share: false },
      sales:  { menu: false, share: false },
    },
  },
  {
    file: 'paving.html', division: 'paving', label: 'Paving', area: 'SY',
    lastBefore: 'analytics-item-financials',
    roles: {
      admin:  { menu: true,  share: true  },
      level3: { menu: true,  share: true  },
      level2: { menu: true,  share: false },
      level1: { menu: true,  share: false },
      sales:  { menu: false, share: false },
    },
  },
  {
    file: 'kiewit-pinetree.html', division: 'kiewit', label: 'Kiewit Pinetree', area: 'SY',
    lastBefore: 'analytics-item-financials',
    // Kiewit has no sales role, and its perm reads fctUser.role.
    roles: {
      admin:  { menu: true, share: true  },
      level3: { menu: true, share: true  },
      level2: { menu: true, share: false },
      level1: { menu: true, share: false },
    },
  },
];

const userFor = (division, role) => ({
  userId: 7, username: 'pat', name: 'Pat Foreman', role, companyCode: 'FCT', isPlatformAdmin: false,
  divisionRoles: { [division]: role }, allowedDivisions: [division],
});

// The page's own constants, read rather than restated, so a page whose
// DIVISION or API_BASE moved is caught here and not by a customer.
function pageConst(src, name) {
  const m = new RegExp(`^const ${name}\\s*=\\s*'([^']*)';`, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return m[1];
}

/** perm, exactly as the page builds it — _levelHere where the page has one. */
function permSource(src) {
  const level = fnSource(src, '_levelHere');
  return (level ? level + '\n' : '')
    + sliceSource(src, 'const perm = (() => {', '// Apply tab visibility', 'perm', '})();');
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settled = async (p) => {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
};

/* ── Markup ──────────────────────────────────────────────────────────────── */
function checkMarkup(page, src, doc) {
  const items = doc.querySelectorAll('#analytics-item-customrpt');
  assert('one Custom Reporting item', items.length === 1, `found ${items.length}`);
  const item = items[0];
  if (item) {
    const menu = item.closest('.analytics-dropdown-menu');
    assert('…inside the Analytics menu', !!menu);
    assert('…last in it, after the page\'s last analytics view',
      menu && menu.lastElementChild === item && item.previousElementSibling
        && item.previousElementSibling.id === page.lastBefore,
      item.previousElementSibling && item.previousElementSibling.id);
    assert('…opens the customrpt sub-tab', item.getAttribute('onclick') === "analyticsSwitchTab('customrpt')",
      item.getAttribute('onclick'));
    assert('…reads "Custom Reporting", styled like its neighbours',
      /Custom Reporting/.test(item.textContent) && item.classList.contains('admin-dropdown-item'));
  }
  // Exactly once in the source too: the jsdom parse would quietly keep the
  // first of two ids.
  assert('the item id appears once in the source', (src.match(/id="analytics-item-customrpt"/g) || []).length === 1);

  const panels = doc.querySelectorAll('#tab-customrpt');
  assert('one #tab-customrpt panel', panels.length === 1, `found ${panels.length}`);
  const panel = panels[0];
  if (panel) {
    assert('…is a tab-panel, hidden until opened', panel.classList.contains('tab-panel') && !panel.classList.contains('active'));
    assert('…holds the #cr-content mount', !!panel.querySelector('#cr-content') && doc.querySelectorAll('#cr-content').length === 1);
    assert('…sits beside the other analytics panels, after Sub Code Performance',
      panel.previousElementSibling && panel.previousElementSibling.id === 'tab-subcode',
      panel.previousElementSibling && panel.previousElementSibling.id);
    assert('…not nested inside another panel', !panel.parentElement.closest('.tab-panel'));
  }

  const scripts = [...doc.querySelectorAll('script[src]')];
  const at = name => scripts.findIndex(s => s.getAttribute('src') === name);
  const count = name => scripts.filter(s => s.getAttribute('src') === name).length;
  const eng = at('custom-reports-engine.js'), ui = at('custom-reports.js'), docs = at('documents.js');
  assert('loads custom-reports-engine.js and custom-reports.js once each',
    count('custom-reports-engine.js') === 1 && count('custom-reports.js') === 1);
  assert('both deferred, neither async (deferred scripts run in document order)',
    eng >= 0 && ui >= 0 && [eng, ui].every(i => scripts[i].hasAttribute('defer') && !scripts[i].hasAttribute('async')));
  assert('engine first, the builder straight after it', eng >= 0 && ui === eng + 1, `engine #${eng}, builder #${ui}`);
  assert('next to the other shared scripts, after documents.js', docs >= 0 && eng > docs);
  assert('both in <head>', eng >= 0 && ui >= 0 && scripts[eng].parentElement === doc.head && scripts[ui].parentElement === doc.head);
  // A page that points at a script nobody shipped 404s and the tab never opens.
  for (const f of ['custom-reports-engine.js', 'custom-reports.js']) {
    assert(`${f} exists in the repo`, fs.existsSync(path.join(ROOT, f)));
  }
}

/* ── Who sees the item: the page's own visibility pass, per role ─────────── */
function runVisibility(page, src, role) {
  const nav = sliceSource(src, '<nav class="tab-bar">', '</nav>', 'tab bar', 'analytics-item-customrpt') + '</nav>';
  const dom = new JSDOM(`<!DOCTYPE html><body>${nav}</body>`, { runScripts: 'outside-only' });
  const w = dom.window;
  w.__user = userFor(page.division, role);
  w.eval([
    `const DIVISION = ${JSON.stringify(pageConst(src, 'DIVISION'))};`,
    'const fctUser = window.__user;',
    permSource(src),
    sliceSource(src, '// Apply tab visibility', '\n/* ═', 'tab visibility pass', 'analytics'),
    'window.__perm = perm;',
  ].join('\n'));
  const d = w.document;
  const shown = el => {
    // Hidden by its own inline style or by an ancestor's.
    for (let e = el; e && e !== d.body; e = e.parentElement) if (e.style.display === 'none') return false;
    return true;
  };
  const out = {
    perm: w.__perm,
    menu: shown(d.querySelector('.analytics-dropdown-wrap')),
    item: shown(d.getElementById('analytics-item-customrpt')),
    financials: shown(d.getElementById('analytics-item-financials')),
  };
  w.close();
  return out;
}

/* ── analyticsSwitchTab and renderHeaderActions, on the real nav + panels ── */
function checkSwitch(page, src) {
  const nav = sliceSource(src, '<nav class="tab-bar">', '</nav>', 'tab bar', 'analytics-item-customrpt') + '</nav>';
  const panels = sliceSource(src, '<!-- ══════════════ EQUIPMENT UTILIZATION TAB', '<!-- ══════════════ COST TRACKING TAB',
    'analytics panels', 'id="tab-customrpt"');
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="header-actions"></div>${nav}${panels}`
    + '<div class="tab-panel active" id="tab-home"></div></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.__user = userFor(page.division, 'admin');
  w.__calls = [];
  const renders = ['renderEquipTable', 'renderLaborTable', 'renderScaleOfEconomy', 'renderSubCodePerf', 'renderFinancials',
    'renderTurfCalculator', 'renderScheduleEstimator', 'renderCustomReports', '_pvUpdateBanner'];
  w.eval([
    `const DIVISION = ${JSON.stringify(pageConst(src, 'DIVISION'))};`,
    'const fctUser = window.__user;',
    permSource(src),
    "let activeTab = 'home';",
    'const pvPreview = { active: false, rate: 0 };',
    ...renders.map(n => `function ${n}() { window.__calls.push(${JSON.stringify(n)}); }`),
    requireFn(src, 'analyticsSwitchTab', page.file),
    requireFn(src, 'renderHeaderActions', page.file),
    'window.__active = () => activeTab;',
    'window.__setActive = t => { activeTab = t; };',
  ].join('\n'));
  const d = w.document;

  w.eval("analyticsSwitchTab('customrpt')");
  assert("analyticsSwitchTab('customrpt') draws Custom Reporting, and nothing else",
    w.__calls.join() === 'renderCustomReports', w.__calls.join());
  assert('…marks customrpt the active tab', w.__active() === 'customrpt');
  const active = [...d.querySelectorAll('.tab-panel.active')].map(p => p.id);
  assert('…shows #tab-customrpt and only it', active.join() === 'tab-customrpt', active.join());
  assert('…highlights the menu item and the Analytics button',
    d.getElementById('analytics-item-customrpt').classList.contains('active')
      && d.getElementById('analytics-tab-btn').classList.contains('active'));

  const header = d.getElementById('header-actions').innerHTML;
  assert('header for customrpt keeps Sign Out', /onclick="logout\(\)"/.test(header));
  assert('…and carries none of another tab\'s buttons',
    !/exportCostCSV|pv-toggle|exportEquipCSV|exportLaborCSV|exportSubCodePDF/.test(header), header.slice(0, 120));

  w.__calls.length = 0;
  w.eval("analyticsSwitchTab('financials')");
  assert('another analytics view does not redraw Custom Reporting', !w.__calls.includes('renderCustomReports'), w.__calls.join());
  assert('…and hides its panel', !d.getElementById('tab-customrpt').classList.contains('active'));
  // The analytics views without a header of their own share the default
  // strip; Custom Reporting has its own toolbar and should get the same.
  assert('header for customrpt matches the other analytics views', d.getElementById('header-actions').innerHTML === header);
  w.close();
}

/* ── renderCustomReports in a vm, with a fake module ─────────────────────── */
function makeHarness(page, src, role, opts = {}) {
  const timers = new Map();
  let nextTimer = 0;
  const root = { innerHTML: '' };
  const logged = [];
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error: (...a) => logged.push(a) },
    Promise,
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => { timers.delete(id); },
    document: { getElementById: id => (id === 'cr-content' ? root : null) },
    __user: userFor(page.division, role),
    __logouts: 0,
  });
  ctx.window = ctx;
  const helperSrc = [...new Set(Object.values(HELPERS))].map(n => requireFn(src, n, page.file));
  vm.runInContext([
    `const DIVISION = ${JSON.stringify(pageConst(src, 'DIVISION'))};`,
    `const API_BASE = ${JSON.stringify(pageConst(src, 'API_BASE'))};`,
    "const fctToken = 'tok-123';",
    'const fctUser = __user;',
    permSource(src),
    'let projectsList = [{ id: "p1" }];',
    'let purchaseOrders = [{ id: "po1" }];',
    'let truckingEntries = [{ id: "tr1" }];',
    'let _drBackfillDone = Promise.resolve();',
    'let _bootReady = Promise.resolve();',
    "let activeTab = 'customrpt';",
    'function logout() { __logouts++; }',
    ...helperSrc,
    sliceSource(src, 'let _crConfigured', 'function renderCustomReports(', 'Custom Reporting state', '_crWaitTimer'),
    requireFn(src, 'renderCustomReports', page.file),
  ].join('\n'), ctx, { filename: page.file });

  const mod = { configs: [], renders: [], throwOnConfigure: false };
  mod.api = {
    configure(cfg) { if (mod.throwOnConfigure) throw new Error('boom'); mod.configs.push(cfg); },
    renderTab(el) { mod.renders.push(el); },
  };
  if (opts.loaded !== false) ctx.FCTCustomReports = mod.api;

  const run = code => vm.runInContext(code, ctx);
  const flush = () => { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); return due.length; };
  return { ctx, run, root, mod, timers, flush, logged };
}

async function checkAdapter(page, src, roleVis) {
  // ── admin: every key, the live getters, ready(), helpers ──
  const h = makeHarness(page, src, 'admin');
  h.run('renderCustomReports()');
  const cfg = h.mod.configs[0];
  assert('configure() is called once, then renderTab(#cr-content)',
    h.mod.configs.length === 1 && h.mod.renders.length === 1 && h.mod.renders[0] === h.root);
  if (!cfg) return;

  const keys = Object.keys(cfg);
  assert('adapter carries exactly the agreed keys',
    ADAPTER_KEYS.every(k => keys.includes(k)) && keys.length === ADAPTER_KEYS.length,
    'missing: ' + ADAPTER_KEYS.filter(k => !keys.includes(k)).join(',') + ' extra: ' + keys.filter(k => !ADAPTER_KEYS.includes(k)).join(','));
  assert(`division '${page.division}', labelled '${page.label}'`, cfg.division === page.division && cfg.divisionLabel === page.label,
    `${cfg.division} / ${cfg.divisionLabel}`);
  assert(`areaUnit ${page.area}`, cfg.areaUnit === page.area, cfg.areaUnit);
  assert('apiBase is the page\'s /api', cfg.apiBase === '/api', cfg.apiBase);
  assert('getToken() hands over the session token', typeof cfg.getToken === 'function' && cfg.getToken() === 'tok-123');
  assert('user is the signed-in fctUser itself', cfg.user === h.ctx.__user);
  assert('perm carries role, canSeeCosts, canSeeFinancials, canShare',
    cfg.perm && PERM_KEYS.every(k => k in cfg.perm), cfg.perm && Object.keys(cfg.perm).join(','));
  assert('admin: costs, financials and sharing all on',
    cfg.perm.role === 'admin' && cfg.perm.canSeeCosts === true && cfg.perm.canSeeFinancials === true && cfg.perm.canShare === true,
    JSON.stringify(cfg.perm));

  // Getters, not snapshots: the poll reassigns these lists.
  const firstProjects = cfg.getProjects();
  h.run('projectsList = [{ id: "p2" }, { id: "p3" }]; purchaseOrders = [{ id: "po2" }]; truckingEntries = [];');
  assert('getProjects() reads projectsList live',
    firstProjects[0].id === 'p1' && cfg.getProjects().length === 2 && cfg.getProjects()[0].id === 'p2');
  assert('getPurchaseOrders() / getTruckingEntries() read live',
    cfg.getPurchaseOrders()[0].id === 'po2' && Array.isArray(cfg.getTruckingEntries()) && cfg.getTruckingEntries().length === 0);

  // Helpers: the page's own functions, under the module's key names.
  const hk = Object.keys(cfg.helpers || {});
  assert('helpers carry exactly the agreed keys',
    Object.keys(HELPERS).every(k => hk.includes(k)) && hk.length === Object.keys(HELPERS).length,
    'missing: ' + Object.keys(HELPERS).filter(k => !hk.includes(k)).join(',') + ' extra: ' + hk.filter(k => !(k in HELPERS)).join(','));
  const wrong = Object.entries(HELPERS).filter(([k, fn]) => cfg.helpers[k] !== h.ctx[fn] || typeof cfg.helpers[k] !== 'function');
  assert('every helper is the page\'s own function (lineAmt → _lineAmt, lineTax → _lineTax)', !wrong.length,
    wrong.map(([k]) => k).join(', '));
  assert('…the very source on the page, not a stand-in',
    cfg.helpers.dailyRowCost && cfg.helpers.dailyRowCost.toString() === requireFn(src, 'dailyRowCost')
      && cfg.helpers.lineTax.toString() === requireFn(src, '_lineTax'));

  assert('onAuthError signs out', (cfg.onAuthError(), h.ctx.__logouts === 1));

  // ready(): the click can come before the jobs have loaded. It must wait for
  // the boot AND for the backfill promise the boot installs — read when the
  // boot is done, not the stale resolved one in place at click time.
  {
    const boot = deferred(), fill = deferred();
    h.ctx.__boot = boot.promise;
    h.run('_bootReady = __boot; _drBackfillDone = Promise.resolve();');
    const p = cfg.ready();
    assert('ready() returns a promise', p && typeof p.then === 'function');
    assert('…still pending while the jobs are loading', !(await settled(p)));
    h.ctx.__fill = fill.promise;
    h.run('_drBackfillDone = __fill;');       // loadProjects starts the backfill
    boot.resolve();
    assert('…still pending after the boot, while the old daily rows are on their way', !(await settled(p)));
    fill.resolve();
    assert('…settles once the backfill lands', await settled(p));

    const bad = deferred(), fill2 = deferred();
    h.ctx.__bad = bad.promise; h.ctx.__fill2 = fill2.promise;
    h.run('_bootReady = __bad; _drBackfillDone = __fill2;');
    const q = cfg.ready();
    bad.reject(new Error('offline'));
    assert('a failed boot still waits for the backfill', !(await settled(q)));
    fill2.resolve();
    let rejected = false;
    await q.catch(() => { rejected = true; });
    assert('…and resolves rather than failing the report', !rejected);
  }

  // Re-entrant: opening the tab again redraws, the hand-over is not repeated.
  h.run('renderCustomReports()');
  assert('opening the tab again redraws without configuring twice', h.mod.configs.length === 1 && h.mod.renders.length === 2);

  // ── each role: the page's own perm, and the financial gate ──
  for (const [role, want] of Object.entries(page.roles)) {
    const r = makeHarness(page, src, role);
    r.run('renderCustomReports()');
    const c = r.mod.configs[0];
    const vis = roleVis[role];
    if (!c) { assert(`${role}: configured`, false); continue; }
    assert(`${role}: canSeeFinancials (${c.perm.canSeeFinancials}) matches whether the Financials item shows`,
      c.perm.canSeeFinancials === vis.financials, `Financials item shown: ${vis.financials}`);
    assert(`${role}: canShare ${want.share}, role '${role}'`, c.perm.canShare === want.share && c.perm.role === role,
      JSON.stringify(c.perm));
    // Kiewit's perm has no canSeeCosts at all; that reads as true.
    const pagePerm = r.run('perm');
    assert(`${role}: canSeeCosts is a boolean the page's perm agrees with`,
      typeof c.perm.canSeeCosts === 'boolean' && c.perm.canSeeCosts === (pagePerm.canSeeCosts !== false),
      `${c.perm.canSeeCosts} vs perm.canSeeCosts ${pagePerm.canSeeCosts}`);
  }
  // The restricted roles are the reason the financial gate exists.
  for (const role of ['level1', 'level2']) {
    const r = makeHarness(page, src, role);
    r.run('renderCustomReports()');
    const c = r.mod.configs[0];
    assert(`${role}: contract and profit columns are kept from this role`, c && c.perm.canSeeFinancials === false && c.perm.canShare === false);
  }
}

function checkWaiting(page, src) {
  // Not loaded yet: a loading line and one retry queued, however many clicks.
  const h = makeHarness(page, src, 'admin', { loaded: false });
  h.run('renderCustomReports()');
  assert('before custom-reports.js has run: a loading line', /Loading Custom Reporting/.test(h.root.innerHTML), h.root.innerHTML);
  assert('…and one retry queued', h.timers.size === 1);
  h.run('renderCustomReports()');
  assert('a second click replaces the retry instead of starting another chain', h.timers.size === 1);
  h.flush();
  assert('…still waiting while the script is missing', h.timers.size === 1 && h.mod.configs.length === 0);
  h.ctx.FCTCustomReports = h.mod.api;
  h.flush();
  assert('once it arrives the retry configures and draws', h.mod.configs.length === 1 && h.mod.renders[0] === h.root);
  assert('…and the chain ends', h.timers.size === 0);

  // Never arrives: the wait gives up and says so.
  const g = makeHarness(page, src, 'admin', { loaded: false });
  g.run('renderCustomReports()');
  let rounds = 0;
  while (g.timers.size && rounds < 500) { g.flush(); rounds++; }
  assert('the wait is bounded (about six seconds of retries)', rounds > 0 && rounds <= 45 && g.timers.size === 0, `${rounds} retries`);
  assert('…and ends on a message that says what to do', /could not be loaded/.test(g.root.innerHTML), g.root.innerHTML);
  g.run('renderCustomReports()');
  assert('opening the tab again is a fresh wait, not the same error', /Loading Custom Reporting/.test(g.root.innerHTML) && g.timers.size === 1);

  // Walked away: the queued retry does nothing.
  g.run("activeTab = 'equip'");
  g.ctx.FCTCustomReports = g.mod.api;
  g.flush();
  assert('a retry after the user moved to another tab draws nothing and stops',
    g.mod.renders.length === 0 && g.timers.size === 0);

  // The module throws: a message in the panel, nothing thrown at the click.
  const e = makeHarness(page, src, 'admin');
  e.mod.throwOnConfigure = true;
  let threw = false;
  try { e.run('renderCustomReports()'); } catch { threw = true; }
  assert('a module that throws does not throw out of the menu click', !threw);
  assert('…leaves a message in the panel', /hit an error/.test(e.root.innerHTML), e.root.innerHTML);
  assert('…and logs it with the [custom-reports] tag', e.logged.some(a => a[0] === '[custom-reports]'));
  e.mod.throwOnConfigure = false;
  e.run('renderCustomReports()');
  assert('…and the next visit tries the hand-over again', e.mod.configs.length === 1 && e.mod.renders.length === 1);
}

(async () => {
  console.log('Analytics → Custom Reporting, wired into each division page');
  for (const page of PAGES) {
    console.log(`\n${page.file}`);
    const src = fs.readFileSync(path.join(ROOT, page.file), 'utf8');
    const doc = new JSDOM(src).window.document;

    attempt('markup checks ran', () => checkMarkup(page, src, doc));

    const roleVis = {};
    attempt('visibility pass ran', () => {
      for (const [role, want] of Object.entries(page.roles)) {
        const v = runVisibility(page, src, role);
        roleVis[role] = v;
        assert(`${role}: Analytics menu ${want.menu ? 'shown' : 'hidden'}`, v.menu === want.menu);
        assert(`${role}: Custom Reporting ${want.menu ? 'offered' : 'out of reach'} with it`, (v.menu && v.item) === want.menu);
      }
    });

    attempt('analyticsSwitchTab / renderHeaderActions ran', () => checkSwitch(page, src));
    if (Object.keys(roleVis).length === Object.keys(page.roles).length) {
      await attemptAsync('adapter checks ran', () => checkAdapter(page, src, roleVis));
    }
    attempt('wait checks ran', () => checkWaiting(page, src));
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
