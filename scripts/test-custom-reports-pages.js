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
 * And, for Custom Reporting v2:
 *   - _crEngineCfg is the one engine config: the tab's configure() and the
 *     scheduled-report builder are handed the same keys, perm and helpers;
 *   - the page's working-day count agrees with the engine's countWorkdays
 *     (one day apart only where the spec says: a one-day plan);
 *   - getConSchedule hands over the Construction Schedule rows read at boot
 *     with the completion flags, which read exactly as before (turf, Kiewit;
 *     paving has none), and the engine plans a dateless bid item off them;
 *   - the scheduled builder (<div>_custom_report) forces internal data off,
 *     skips anything still internal, covers the right jobs in each jobs mode,
 *     reads branding and the directory with a GET each and returns the log
 *     record the runner needs (job ids and clients included);
 *   - the bid table's Plan / Day box: header, column counts, the save through
 *     updateBidItem → the per-item PUT, bad input put back, text for a user
 *     who cannot edit — on all three pages;
 *   - divisions.html: the Branding sub-tab (validation, canvas downscale, the
 *     masthead preview, the PUT body) and the Auto Reports tab's read-only
 *     custom-report rows.
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

// What every page must hand the module (spec §3; v2 §7 added getConSchedule
// and the workingDaysBetween helper), and the page function each helper key
// is filled from. lineAmt / lineTax are the pages' underscored PO line helpers.
const ADAPTER_KEYS = ['division', 'divisionLabel', 'apiBase', 'getToken', 'user', 'perm', 'areaUnit', 'ready',
  'getProjects', 'getPurchaseOrders', 'getTruckingEntries', 'getConSchedule', 'helpers', 'onAuthError'];
const PERM_KEYS = ['role', 'canSeeCosts', 'canSeeFinancials', 'canShare'];
const HELPERS = {
  dailyRowCost: 'dailyRowCost', calcDaily: 'calcDaily', bidItemComplete: 'bidItemComplete',
  bidProjectPct: 'bidProjectPct', bidGroupPct: 'bidGroupPct', projForBidItem: 'projForBidItem',
  projectedCostForProject: 'projectedCostForProject', gpEarnedToDate: 'gpEarnedToDate',
  bidContractFigures: 'bidContractFigures', projIsDone: 'projIsDone', lineAmt: '_lineAmt', lineTax: '_lineTax',
  addWorkingDays: '_addWorkingDays', workingDaysBetween: '_workingDaysBetween',
};

// menu: the Analytics menu (and with it Custom Reporting) is on screen.
// share: the canShare hint. Financials visibility is not listed — it is read
// off the page's own visibility pass and the adapter must agree with it.
const PAGES = [
  {
    file: 'tracker.html', division: 'turf', label: 'Turf Management', area: 'SF', place: 'Turf', cs: true,
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
    file: 'paving.html', division: 'paving', label: 'Paving', area: 'SY', place: 'Paving', cs: false,
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
    file: 'kiewit-pinetree.html', division: 'kiewit', label: 'Kiewit Pinetree', area: 'SY', place: 'Kiewit Pinetree', cs: true,
    lastBefore: 'analytics-item-financials',
    // Kiewit has no sales role; its perm reads the kiewit grant (_levelHere).
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

  // v2 (spec Global): versioned src, so a browser holding last week's copy
  // fetches the new one rather than stripping v2 fields from a saved report.
  const scripts = [...doc.querySelectorAll('script[src]')];
  const at = name => scripts.findIndex(s => s.getAttribute('src') === name);
  const count = name => scripts.filter(s => s.getAttribute('src') === name).length;
  const bare = name => scripts.filter(s => (s.getAttribute('src') || '').split('?')[0] === name).length;
  const ENG = 'custom-reports-engine.js?v=2', UI = 'custom-reports.js?v=2', AI = 'custom-reports-ai.js?v=2', MAIL = 'report-email.js?v=2';
  const eng = at(ENG), ui = at(UI), ai = at(AI), mail = at(MAIL), docs = at('documents.js');
  assert('loads custom-reports-engine.js?v=2, custom-reports.js?v=2 and custom-reports-ai.js?v=2 once each',
    count(ENG) === 1 && count(UI) === 1 && count(AI) === 1);
  assert('…and no unversioned copy of any of them',
    bare('custom-reports-engine.js') === 1 && bare('custom-reports.js') === 1 && bare('custom-reports-ai.js') === 1);
  assert('all three deferred, none async (deferred scripts run in document order)',
    eng >= 0 && ui >= 0 && ai >= 0 && [eng, ui, ai].every(i => scripts[i].hasAttribute('defer') && !scripts[i].hasAttribute('async')));
  assert('engine first, the builder straight after it, the AI panel straight after that',
    eng >= 0 && ui === eng + 1 && ai === ui + 1, `engine #${eng}, builder #${ui}, ai #${ai}`);
  assert('next to the other shared scripts, after documents.js', docs >= 0 && eng > docs);
  assert('all in <head>', eng >= 0 && ui >= 0 && ai >= 0 && [eng, ui, ai].every(i => scripts[i].parentElement === doc.head));
  assert('report-email.js?v=2 once, deferred, and no unversioned copy',
    mail >= 0 && count(MAIL) === 1 && bare('report-email.js') === 1 && scripts[mail].hasAttribute('defer'));
  // A page that points at a script nobody shipped 404s and the tab never opens.
  for (const f of ['custom-reports-engine.js', 'custom-reports.js', 'report-email.js']) {
    assert(`${f} exists in the repo`, fs.existsSync(path.join(ROOT, f)));
  }
  // The AI panel is another engineer's file, shipped with the same change;
  // until it lands the tag only 404s (the panel is optional, nothing else
  // waits on it), so a missing file is reported, not failed, here.
  if (fs.existsSync(path.join(ROOT, 'custom-reports-ai.js'))) assert('custom-reports-ai.js exists in the repo', true);
  else console.log('  · custom-reports-ai.js is not in the repo yet (the AI builder ships it)');
}

/* ── Who sees the item: the page's own visibility pass, per role ─────────── */
function runVisibility(page, src, role, user) {
  const nav = sliceSource(src, '<nav class="tab-bar">', '</nav>', 'tab bar', 'analytics-item-customrpt') + '</nav>';
  const dom = new JSDOM(`<!DOCTYPE html><body>${nav}</body>`, { runScripts: 'outside-only' });
  const w = dom.window;
  w.__user = user || userFor(page.division, role);
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
    __user: opts.user || userFor(page.division, role),
    __logouts: 0,
  });
  ctx.window = ctx;
  ctx.__csRows = { p1: [{ id: 't1', kind: 'task', code: '100', subcode: 'Turf Install', start: '2026-10-05', end: '2026-11-20' }] };
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
    // turf and Kiewit keep the Construction Schedule rows read at boot.
    page.cs ? 'const _bidCsRows = __csRows;' : '',
    requireFn(src, '_crEngineCfg', page.file),
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

  // getConSchedule: the rows the boot read kept (turf, Kiewit); paving keeps
  // no Construction Schedule, so never any.
  if (page.cs) {
    assert('getConSchedule(id) hands over that job\'s Construction Schedule rows, as read',
      typeof cfg.getConSchedule === 'function' && cfg.getConSchedule('p1') === h.ctx.__csRows.p1);
    assert('…null for a job with none', cfg.getConSchedule('nope') === null);
    h.ctx.__csRows.p9 = [];
    assert('…and reads the map live', Array.isArray(cfg.getConSchedule('p9')));
  } else {
    assert('getConSchedule is there, and paving answers null for every job',
      typeof cfg.getConSchedule === 'function' && cfg.getConSchedule('p1') === null && cfg.getConSchedule() === null);
    assert('…paving has no Construction Schedule rows to keep', !/_bidCsRows/.test(src) && !fnSource(src, '_loadAllBidCsCompletion'));
  }

  // One config for the tab and the robot: renderCustomReports hands over
  // _crEngineCfg() itself, and a fresh call gives the same thing.
  const rcr = requireFn(src, 'renderCustomReports');
  assert('renderCustomReports configures with _crEngineCfg(), not an inline copy',
    /FCTCustomReports\.configure\(_crEngineCfg\(\)\)/.test(rcr) && !/configure\(\{/.test(rcr));
  {
    const again = h.run('_crEngineCfg()');
    const same = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
    assert('_crEngineCfg() is a fresh object each call, with the same keys', again !== cfg && same(again, cfg));
    assert('…the same perm, division, label, area and user',
      JSON.stringify(again.perm) === JSON.stringify(cfg.perm) && again.division === cfg.division
        && again.divisionLabel === cfg.divisionLabel && again.areaUnit === cfg.areaUnit && again.user === cfg.user);
    assert('…the very same helper functions',
      same(again.helpers, cfg.helpers) && Object.keys(cfg.helpers).every(k => again.helpers[k] === cfg.helpers[k]));
    assert('…and getters onto the same live lists',
      again.getProjects() === cfg.getProjects() && again.getTruckingEntries() === cfg.getTruckingEntries()
        && again.getConSchedule('p1') === cfg.getConSchedule('p1'));
  }

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

/* ── Grants that differ by division ──────────────────────────────────────
   fctUser.role is the caller's TURF role (login.js copies divisionRoles.turf
   into it), so a page that builds perm from it answers for the wrong
   division. Each page must read its own grant first, as the server's
   levelFor does — otherwise a turf admin with view access to Kiewit gets
   contract and profit columns onto a printed or exported report. */
function checkMixedGrants(page, src) {
  const others = ['turf', 'paving', 'kiewit'].filter(d => d !== page.division);
  const grant = (here, elsewhere) => {
    const dr = { [page.division]: here };
    others.forEach(d => { dr[d] = elsewhere; });
    return dr;
  };
  const cases = [
    { label: `${page.division} level1, admin everywhere else (account role admin)`,
      user: { role: 'admin', divisionRoles: grant('level1', 'admin') },
      want: { role: 'level1', fin: false, share: false } },
    { label: `${page.division} level2, level3 everywhere else (account role level3)`,
      user: { role: 'level3', divisionRoles: grant('level2', 'level3') },
      want: { role: 'level2', fin: false, share: false } },
    { label: `${page.division} admin, level1 everywhere else (account role level1)`,
      user: { role: 'level1', divisionRoles: grant('admin', 'level1') },
      want: { role: 'admin', fin: true, share: true } },
    { label: 'a platform admin with no grant here and account role level1',
      user: { role: 'level1', divisionRoles: grant('no_access', 'level1'), isPlatformAdmin: true },
      want: { role: 'admin', fin: true, share: true } },
  ];
  if (page.division === 'kiewit') {
    // Kiewit has no sales grant; a stray one must not read as full access.
    cases.push({ label: 'a stray kiewit:\'sales\' grant reads as view-only level1',
      user: { role: 'admin', divisionRoles: grant('sales', 'admin') },
      want: { role: 'level1', fin: false, share: false } });
  }
  for (const c of cases) {
    const user = Object.assign(userFor(page.division, c.user.role), c.user);
    const h = makeHarness(page, src, c.user.role, { user });
    h.run('renderCustomReports()');
    const cfg = h.mod.configs[0];
    const vis = runVisibility(page, src, c.user.role, user);
    assert(`${c.label}: perm.role '${c.want.role}', canSeeFinancials ${c.want.fin}, canShare ${c.want.share}`,
      cfg && cfg.perm.role === c.want.role && cfg.perm.canSeeFinancials === c.want.fin && cfg.perm.canShare === c.want.share,
      cfg && JSON.stringify(cfg.perm));
    assert(`${c.label}: the Financials item is ${c.want.fin ? 'shown' : 'hidden'} to match`, vis.financials === c.want.fin,
      `Financials shown: ${vis.financials}`);
    if (cfg && !c.want.fin) {
      // And the engine, fed this perm, keeps every financial column out.
      const E = loadEngine();
      const def = { includeInternal: true };
      const fin = [['job_info', 'contract'], ['job_info', 'retention'], ['job_info', 'invoiced'],
        ['summary_kpis', 'contract'], ['summary_kpis', 'co_total'], ['summary_kpis', 'gp_earned'], ['change_orders', 'amount']];
      const leaked = fin.filter(([t, k]) => E.columnState(t, k, def, cfg.perm) !== 'hidden');
      assert(`${c.label}: the engine hides contract, retention, invoiced, CO and GP columns even with internal data on`,
        !leaked.length, leaked.map(x => x.join('.')).join(', '));
    }
  }
}

let _engine = null;
function loadEngine() {
  if (_engine) return _engine;
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'custom-reports-engine.js'), 'utf8'), ctx, { filename: 'custom-reports-engine.js' });
  _engine = ctx.FCTReportEngine;
  return _engine;
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

/* ══════════════════════════════════════════════════════════════════════════
   Custom Reporting v2 — the page end
   ══════════════════════════════════════════════════════════════════════════ */
const ENGINE_TEXT = fs.readFileSync(path.join(ROOT, 'custom-reports-engine.js'), 'utf8');
const ROBOT_FROM  = '/* ── Custom Reporting on a timetable';

function liftLine(src, start, where) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`${start.trim()} not found${where ? ' in ' + where : ''}`);
  const e = src.indexOf('\n', i);
  return src.slice(i, e < 0 ? src.length : e);
}
// A region up to and including its end marker.
function sliceThrough(src, from, through, label) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(through, a);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : through})`);
  return src.slice(a, b + through.length);
}
const tick = () => new Promise(r => setImmediate(r));
async function settleAll(n = 8) { for (let i = 0; i < n; i++) await tick(); }
// Until pred() holds (a FileReader or an image load takes a few turns of the
// loop in jsdom), or ms have passed — then the assertion says what it says.
async function waitUntil(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let ok = false;
    try { ok = !!pred(); } catch (_) { ok = false; }
    if (ok) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return false;
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BRANDING = {
  display_name: 'Force Corp <b>Sports</b> & Turf', logo: { mime: 'image/png', base64: PNG_B64, width: 1, height: 1 },
  phone: '555-0100', email: 'office@example.com', website: 'https://example.com', address: '1 Main St', report_footer: 'Thank you',
};
const PEOPLE = [
  { name: 'John Smith', phone: '555-0111', email: 'john@example.com', logins: [] },
  { name: 'Pat Foreman', phone: '555-0122', email: 'pat@example.com', logins: ['pat'] },
  // A login row with no person behind it: never matched as a name.
  { name: 'Smith, John', login: true, phone: '000', logins: [] },
];

function crProjects() {
  const row = (id, date, sc, qty) => ({ id, date, cost_code: '100', sub_code: sc, quantity: qty,
    labor_hours: 8, rate: 41.5, employee: 'SECRET Employee', field_type: 'Labor', job_class: 'Laborer' });
  return [
    { id: 'p1', 'project-name': 'Maple Ave Fields', 'job-number': '26001', client: 'Acme Township', status: 'In Progress',
      pm: 'Smith, John', notes: 'SECRET note', 'start-date': '2026-10-01', 'end-date': '2026-12-18',
      bidItems: [
        { id: 'b1', cost_code: '100', sub_code: 'Turf Install', unit: 'SF', quantity: 20000, unit_cost: 3.25,
          start_date: '2026-10-05', target_date: '2026-11-27', planned_rate: 800 },
        { id: 'b2', cost_code: '100', sub_code: 'Base Prep', unit: 'SF', quantity: 20000, unit_cost: 1.1 },
      ],
      dailyRows: [row('r1', '2026-10-27', 'Turf Install', 900), row('r2', '2026-10-28', 'Turf Install', 700),
        row('r3', '2026-10-29', 'Base Prep', 1500)] },
    { id: 'p2', 'project-name': '<img src=x onerror=alert(1)>', 'job-number': '26002', client: 'Beta Corp', status: 'In Progress',
      pm: 'Nobody Known',
      bidItems: [{ id: 'b3', cost_code: '100', sub_code: 'Turf Install', unit: 'SF', quantity: 5000, unit_cost: 3 }],
      dailyRows: [row('r4', '2026-10-28', 'Turf Install', 400)] },
    { id: 'p3', 'project-name': 'Finished Job', client: 'Gamma', status: 'Complete', bidItems: [], dailyRows: [] },
  ];
}
function crDefinition(extra) {
  return Object.assign({
    v: 2, title: '', jobs: { mode: 'saved', ids: ['p1', 'p2', 'gone-job'] }, layout: 'separate',
    dates: { preset: 'last_week', from: '', to: '' }, includeInternal: true,
    header: { preparedFor: '', preparedBy: '', intro: '', footer: '', showGenerated: true, branding: 'company', showPmContact: true },
    sections: [
      { id: 's1', type: 'job_info', columns: ['project-name', 'client', 'notes', 'contract'] },
      { id: 's2', type: 'bid_progress', columns: ['cost_code', 'sub_code', 'bid_qty', 'installed_to_date', 'actual_cost', 'labor_hours', 'unit_cost'] },
      { id: 's3', type: 'daily_production', columns: ['date', 'sub_code', 'quantity', 'employee', 'labor_cost'], options: { summarize: false } },
    ],
  }, extra || {});
}

const okJson = body => ({ ok: true, status: 200, json: async () => body });
function sideAnswer(o = {}) {
  return url => {
    if (/\/api\/company\/branding$/.test(url)) {
      if (o.never) return new Promise(() => {});
      return o.brandingFail ? { ok: false, status: 500, json: async () => ({}) }
        : okJson({ ok: true, branding: o.branding === undefined ? BRANDING : o.branding, canEdit: false });
    }
    if (/\/api\/employees\?view=people$/.test(url)) {
      if (o.never) return new Promise(() => {});
      return o.peopleFail ? Promise.reject(new Error('offline')) : okJson({ employees: o.people || PEOPLE });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

/** The page's Custom Reporting end in a vm: perm, helpers, _crEngineCfg, the
 *  tab hand-over, the scheduled builder and the robot registration, over the
 *  real engine. */
function pageVm(page, src, opts = {}) {
  const calls = { fetch: [], configs: [] };
  const reg = {};
  const fast = !!opts.fastTimers;
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Promise, URLSearchParams,
    // The builder's 15-second guard on a side read must not hold the suite
    // open (unref); with fastTimers it fires at once, and is kept referenced
    // so the run waits for it.
    setTimeout: (fn, ms) => { const t = setTimeout(fn, fast ? 0 : ms); if (!fast && t && t.unref) t.unref(); return t; },
    clearTimeout,
    __user: opts.user || userFor(page.division, opts.role || 'admin'),
    __answer: opts.answer || sideAnswer(),
    __csRows: {},
  });
  ctx.window = ctx;
  ctx.fetch = async (url, init) => {
    const h = (init && init.headers) || {};
    calls.fetch.push({ url: String(url), method: (init && init.method) || 'GET', auth: h.Authorization || h.authorization || '' });
    return ctx.__answer(String(url), init || {});
  };
  ctx.document = { getElementById: id => (id === 'cr-content' ? { innerHTML: '' } : null) };
  ctx.FCTCustomReports = { configure(c) { calls.configs.push(c); }, renderTab() {} };
  ctx.dwAutoReport = {
    ready() {}, jobs(fn) { ctx.__jobsFn = fn; }, register(type, fn, o) { reg[type] = { fn, opts: o }; },
    capture: () => null, prefetch: () => new Map(), waitFor: () => Promise.resolve(),
  };
  vm.runInContext(ENGINE_TEXT, ctx, { filename: 'custom-reports-engine.js' });
  const code = [
    `const DIVISION = ${JSON.stringify(pageConst(src, 'DIVISION'))};`,
    `const API_BASE = ${JSON.stringify(pageConst(src, 'API_BASE'))};`,
    "const fctToken = 'tok-123';",
    'const fctUser = __user;',
    permSource(src),
    'let projectsList = [];', 'let purchaseOrders = [];', 'let truckingEntries = [];',
    'let _drBackfillDone = Promise.resolve();', 'let _bootReady = Promise.resolve();',
    "let activeTab = 'customrpt';",
    'function logout() {}',
    'function getProj(id) { return projectsList.find(p => String(p.id) === String(id)); }',
    requireFn(src, '_localDateStr', page.file), requireFn(src, '_usHolidays', page.file),
    liftLine(src, 'const _holidayCache', page.file), requireFn(src, '_isHoliday', page.file),
    ...[...new Set(Object.values(HELPERS))].map(n => requireFn(src, n, page.file)),
    page.cs ? 'const _bidCsRows = __csRows;' : '',
    requireFn(src, '_crEngineCfg', page.file),
    sliceSource(src, 'let _crConfigured', 'function renderCustomReports(', 'Custom Reporting state', '_crWaitTimer'),
    requireFn(src, 'renderCustomReports', page.file),
    sliceSource(src, ROBOT_FROM, 'function renderSubCodePerf() {', 'the scheduled custom report builder', 'async function _crScheduledReport('),
    sliceSource(src, '(function registerAutoReports() {', '\n/* ═══════════════════════════════════════════\n   LISTS SYNC',
      'registerAutoReports', `'${page.division}_custom_report'`),
  ].join('\n');
  vm.runInContext(code, ctx, { filename: page.file });
  const run = c => vm.runInContext(c, ctx);
  // Spy on the engine the builder reads at call time, without touching the real one.
  const spy = { makeContext: [], hasInternal: [] };
  const realE = ctx.FCTReportEngine;
  const useEngine = (over = {}) => {
    ctx.FCTReportEngine = Object.assign({}, realE, {
      makeContext(d, c, o) { spy.makeContext.push({ d, c, o }); return realE.makeContext(d, c, o); },
      hasInternal(d, p, div) { spy.hasInternal.push({ d, p, div }); return realE.hasInternal(d, p, div); },
    }, over);
  };
  useEngine();
  return { ctx, run, calls, reg, spy, useEngine, realE, setProjects: list => { ctx.__p = list; run('projectsList = __p;'); } };
}

/* ── The page's working days against the engine's ───────────────────────── */
function checkWorkdayParity(page, src) {
  const h = pageVm(page, src);
  const E = h.realE, W = h.ctx._workingDaysBetween;
  const days = [];
  for (let d = new Date(Date.UTC(2026, 5, 25)); d <= new Date(Date.UTC(2027, 1, 20)); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  const pairs = [];
  for (let i = 0; i < days.length; i += 3) for (let j = i; j < Math.min(days.length, i + 60); j += 7) pairs.push([days[i], days[j]]);
  // Spans across July 4 (a Saturday, kept on Friday the 3rd), Labor Day,
  // Columbus Day, Veterans Day, Thanksgiving, Christmas and New Year's.
  pairs.push(['2026-07-01', '2026-07-10'], ['2026-11-20', '2026-11-30'], ['2026-12-21', '2027-01-08'], ['2026-08-31', '2026-10-16']);
  const bad = pairs.filter(([a, b]) => a < b && W(a, b) !== E.countWorkdays(a, b));
  assert(`the page's _workingDaysBetween and the engine's countWorkdays agree on ${pairs.filter(([a, b]) => a < b).length} spans (holidays included)`,
    !bad.length, bad.slice(0, 3).map(([a, b]) => `${a}..${b}: page ${W(a, b)}, engine ${E.countWorkdays(a, b)}`).join('; '));
  assert('…Thanksgiving week: 4 working days, Thanksgiving and the weekend out, on both',
    W('2026-11-23', '2026-11-29') === 4 && E.countWorkdays('2026-11-23', '2026-11-29') === 4,
    `${W('2026-11-23', '2026-11-29')} / ${E.countWorkdays('2026-11-23', '2026-11-29')}`);
  // The one deliberate difference (spec Global): a one-day plan is one day.
  assert('a one-day span: the page says 0, the engine 1 on a working day',
    W('2026-11-04', '2026-11-04') === 0 && E.countWorkdays('2026-11-04', '2026-11-04') === 1);
  assert('…and both 0 on a weekend day or a holiday',
    E.countWorkdays('2026-11-07', '2026-11-07') === 0 && E.countWorkdays('2026-11-26', '2026-11-26') === 0);
  assert('a reversed span: 0 from both', W('2026-11-10', '2026-11-02') === 0 && E.countWorkdays('2026-11-10', '2026-11-02') === 0);
  assert('the engine is handed this very function as helpers.workingDaysBetween', h.run('_crEngineCfg()').helpers.workingDaysBetween === W);
}

/* ── Construction Schedule rows kept by the boot read (turf, Kiewit) ─────── */
async function checkConSchedule(page, src) {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Promise });
  ctx.window = ctx;
  ctx.__batches = [];
  ctx.__answer = null;
  vm.runInContext([
    liftLine(src, 'const _bidCsComplete', page.file),
    liftLine(src, 'const _bidCsRows', page.file),
    liftLine(src, 'const _csRowsOf', page.file),
    liftLine(src, 'const _csKey', page.file),
    requireFn(src, '_bidCsKey', page.file),
    requireFn(src, '_csCompletionSet', page.file),
    // fnSource lifts from the `function` keyword: put the async back.
    'async ' + requireFn(src, '_loadBidCsCompletion', page.file),
    'async ' + requireFn(src, '_loadAllBidCsCompletion', page.file),
    requireFn(src, 'bidItemComplete', page.file),
    'let projectsList = []; let bidViewProjId = null; let __renders = 0;',
    'function renderBidTable() { __renders++; }',
    'async function apiBatchGet(keys) { __batches.push(keys); return typeof __answer === "function" ? __answer(keys) : (__answer || {}); }',
    'async function apiGet(key) { return __single; }',
  ].join('\n'), ctx, { filename: page.file });
  const run = c => vm.runInContext(c, ctx);
  const key = id => run(`_csKey(${JSON.stringify(id)})`);
  const task = (code, sub, status, start, end, pct) => ({ id: code + sub + status, kind: 'task', code, subcode: sub, status, start, end, pct: pct || 0 });
  const p1rows = [
    task('100', 'Turf Install', 'Complete', '2026-10-05', '2026-11-20'),
    task('100', 'Base Prep', 'In Progress', '2026-09-28', '2026-10-30', 40),
    task('100', 'Base Prep', 'Complete', '10/1/26', '10/9/26'),
    { id: 'd', kind: 'divider', description: 'Phase 2' },
  ];
  const values = {
    [key('p1')]: { v: 1, rows: p1rows },
    [key('p3')]: { v: 1, rows: 'junk' },
    [key('p4')]: { v: 1, rows: [] },
  };
  ctx.__answer = values;
  run('projectsList = [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }, null, { id: "" }];');
  await run('_loadAllBidCsCompletion()');
  assert('one batched read for every job\'s schedule, as before',
    ctx.__batches.length === 1 && JSON.stringify(ctx.__batches[0]) === JSON.stringify(['p1', 'p2', 'p3', 'p4'].map(key)));
  const rows = run('_bidCsRows');
  assert('the rows are kept as read, for the job that has a schedule', rows.p1 === values[key('p1')].rows);
  assert('…null for a job with none saved, or rows that are not a list; [] stays []',
    rows.p2 === null && rows.p3 === null && Array.isArray(rows.p4) && rows.p4.length === 0);
  const comp = run('_bidCsComplete');
  const setOf = v => JSON.stringify([...run('_csCompletionSet')(v)].sort());
  assert('completion reads exactly as _csCompletionSet always made it, job by job',
    ['p1', 'p2', 'p3', 'p4'].every(id => JSON.stringify([...comp[id]].sort()) === setOf(values[key(id)])));
  assert('…a sub code is complete only when every task on it is (Turf Install yes, Base Prep no)',
    run('bidItemComplete({ cost_code: "100", sub_code: "Turf Install" }, "p1")') === true
      && run('bidItemComplete({ cost_code: "100", sub_code: "Base Prep" }, "p1")') === false);

  // A failed batch read: nothing kept, nothing complete — as before.
  ctx.__answer = {};
  await run('_loadAllBidCsCompletion()');
  assert('a failed read keeps no rows and marks nothing complete',
    ['p1', 'p2', 'p3', 'p4'].every(id => run('_bidCsRows')[id] === null && run('_bidCsComplete')[id].size === 0));

  // The bid view's own read refreshes both.
  ctx.__single = { rows: [task('100', 'Turf Install', 'Complete', '2026-10-12', '2026-11-13')] };
  await run('_loadBidCsCompletion("p1")');
  assert('opening a job\'s bid view refreshes its rows along with its completion',
    run('_bidCsRows').p1 === ctx.__single.rows && run('_bidCsComplete').p1.has('100||turf install'));

  // And the engine plans a bid item with no typed dates off them.
  const h = pageVm(page, src);
  h.ctx.__csRows.p1 = p1rows;
  const projects = crProjects();
  delete projects[0].bidItems[0].start_date;
  delete projects[0].bidItems[0].target_date;
  delete projects[0].bidItems[0].planned_rate;
  h.setProjects(projects);
  const E = h.realE;
  const cfg = h.run('_crEngineCfg()');
  const def = E.normalizeDefinition({ v: 2, jobs: { mode: 'pick', ids: ['p1'] }, dates: { preset: 'job_to_date' },
    sections: [{ id: 'pva', type: 'plan_vs_actual', columns: ['sub_code', 'planned_rate', 'start_date', 'target_date', 'plan_source'] }] });
  const sd = E.buildSectionData(def.sections[0], def, E.makeContext(def, cfg, { pickedIds: ['p1'], today: '2026-11-04' }));
  const rowsOut = sd.blocks[0].groups.flatMap(g => g.rows);
  const install = rowsOut.find(r => r.cells.sub_code === 'Turf Install');
  const W = E.countWorkdays('2026-10-05', '2026-11-20');
  assert('the engine plans a dateless line off its schedule task: basis "Construction schedule", task start to end',
    !!install && /schedule/i.test(String(install.cells.plan_source)) && install.cells.start_date === '2026-10-05'
      && install.cells.target_date === '2026-11-20', install && JSON.stringify(install.cells));
  assert('…planned rate = quantity over the working days between them',
    !!install && Math.abs(install.cells.planned_rate - 20000 / W) < 1e-6, install && install.cells.planned_rate);
}

/* ── The scheduled builder: <division>_custom_report ────────────────────── */
async function checkScheduledBuilder(page, src) {
  const type = `${page.division}_custom_report`;
  const h = pageVm(page, src);
  const reg = h.reg[type];
  assert(`registers '${type}' with the report robot, one job per call (perJob)`, !!reg && !!reg.opts && reg.opts.perJob === true);
  assert('…beside the page\'s other scheduled reports, which stay registered',
    !!h.reg[`${page.division}_bid_items`] && !!h.reg[`${page.division}_daily_pm`]);
  if (!reg) return;
  h.setProjects(crProjects());
  const spec = o => Object.assign({
    type, projectId: null, projectName: null, today: '2026-11-04', timezone: 'America/New_York', jobsMode: 'saved',
    customReport: { id: 41, name: 'Weekly Owner Update', version: 3, definition: crDefinition() },
  }, o || {});
  const lastMc = () => h.spy.makeContext[h.spy.makeContext.length - 1];

  // ── saved jobs, internal data asked for and refused ──
  const saved = crDefinition();
  const before = JSON.stringify(saved);
  const out = await reg.fn(spec({ customReport: { id: 41, name: 'Weekly Owner Update', version: 3, definition: saved } }));
  const mc = lastMc();
  assert('saved: a report comes back', !!out && typeof out.html === 'string' && out.html.length > 500 && !out.skip, out && out.skip);
  if (!out || !out.html) return;
  assert('internal data forced off: the engine is handed includeInternal false', mc.d.includeInternal === false);
  assert('…nothing internal prints — no names, notes, costs, hours; no internal mark or banner',
    !/SECRET/.test(out.html) && !/data-cr-internal/.test(out.html) && !/>\s*INTERNAL/.test(out.html) && !/Labor Cost|Actual Cost/.test(out.html));
  assert('…its log record says customer-safe and carries the definition as built, internal off',
    out.customReport.included_internal === false && out.customReport.definition.includeInternal === false);
  assert('…the saved definition the runner handed over is left as it was', JSON.stringify(saved) === before);
  assert('the engine checked the built definition with this page\'s perm and division',
    h.spy.hasInternal.length > 0 && h.spy.hasInternal[h.spy.hasInternal.length - 1].div === page.division
      && h.spy.hasInternal[h.spy.hasInternal.length - 1].d.includeInternal === false);
  assert('saved: the report\'s saved jobs that still exist, in their order',
    JSON.stringify(out.customReport.project_ids) === '["p1","p2"]' && JSON.stringify(mc.o.pickedIds) === '["p1","p2"]');
  assert('built from _crEngineCfg(): the adapter keys, this division, the page\'s own helpers',
    JSON.stringify(Object.keys(mc.c).sort()) === JSON.stringify(ADAPTER_KEYS.slice().sort()) && mc.c.division === page.division
      && mc.c.helpers.workingDaysBetween === h.ctx._workingDaysBetween && mc.c.helpers.dailyRowCost === h.ctx.dailyRowCost);
  assert('…with the schedule\'s today, so "last week" is the week before it',
    mc.o.today === '2026-11-04' && out.customReport.date_from === '2026-10-26' && out.customReport.date_to === '2026-11-01',
    `${mc.o.today} ${out.customReport.date_from}..${out.customReport.date_to}`);
  assert('…named for the saved report', mc.o.reportName === 'Weekly Owner Update');
  assert('subject "<report name> — 2 jobs"', out.subject === 'Weekly Owner Update — 2 jobs', out.subject);
  assert('two jobs: no single job id, and never a project name (the mail step would rewrite the subject)',
    out.projectId === null && out.projectName === null);
  const cr = out.customReport;
  assert('log record: every field the runner reads',
    ['report_id', 'report_name', 'project_ids', 'project_names', 'clients', 'date_from', 'date_to', 'definition', 'included_internal']
      .every(k => k in cr), Object.keys(cr).join(','));
  assert('…the saved report\'s id and name, the jobs\' names',
    cr.report_id === 41 && cr.report_name === 'Weekly Owner Update'
      && JSON.stringify(cr.project_names) === JSON.stringify(['Maple Ave Fields', '<img src=x onerror=alert(1)>']));
  assert('…and each job\'s client, for its saved contacts',
    JSON.stringify(cr.clients) === JSON.stringify([{ id: 'p1', client: 'Acme Township' }, { id: 'p2', client: 'Beta Corp' }]));
  assert('…the definition lists the jobs it was built for', JSON.stringify(cr.definition.jobs.ids) === '["p1","p2"]');
  assert('a job name prints as text', out.html.includes('&lt;img src&#61;x onerror&#61;alert(1)&gt;') && !out.html.includes('<img src=x'));

  // ── branding and the directory: a GET each ──
  const f = h.calls.fetch;
  assert('branding and the Team Directory are read with one GET each, signed in as the run',
    f.length === 2 && f.every(c => c.method === 'GET' && c.auth === 'Bearer tok-123')
      && f.some(c => c.url === '/api/company/branding') && f.some(c => c.url === '/api/employees?view=people'),
    JSON.stringify(f));
  assert('…the company\'s name and logo in the masthead (name escaped)',
    /class="mast-co"/.test(out.html) && out.html.includes('Force Corp &lt;b&gt;Sports&lt;/b&gt; &amp; Turf')
      && out.html.includes(`src="data:image/png;base64,${PNG_B64}"`));
  assert('…the PM matched in the directory ("Smith, John" is John Smith), not the bare login row',
    !!mc.o.contacts.p1 && mc.o.contacts.p1.pm.name === 'John Smith' && mc.o.contacts.p1.pm.phone === '555-0111' && !mc.o.contacts.p2);
  assert('…and printed on that job\'s band', /Project Manager: John Smith/.test(out.html));
  assert('"Prepared by": the person behind the login the schedule runs as',
    cr.definition.header.preparedBy === 'Pat Foreman' && mc.o.userName === 'Pat Foreman');
  assert('…no "Prepared for" on a two-job report; the Questions contact is that person (the jobs share no PM)',
    cr.definition.header.preparedFor === '' && mc.o.reportContact && mc.o.reportContact.name === 'Pat Foreman');

  // ── one job per email ──
  const one = await reg.fn(spec({ jobsMode: 'each', projectId: 'p1', projectName: 'Maple Ave Fields' }));
  assert('each: that one job', JSON.stringify(one.customReport.project_ids) === '["p1"]' && one.projectId === 'p1' && one.projectName === null);
  assert('…subject "<report name> — <job>"', one.subject === 'Weekly Owner Update — Maple Ave Fields', one.subject);
  assert('…"Prepared for" that job\'s client; the Questions contact its PM',
    one.customReport.definition.header.preparedFor === 'Acme Township' && lastMc().o.reportContact.name === 'John Smith');
  assert('…branding and the directory not read again (one read a page)', h.calls.fetch.length === 2, h.calls.fetch.length);
  let err = null;
  try { await reg.fn(spec({ jobsMode: 'each', projectId: 'zz', projectName: 'Old Job' })); } catch (e) { err = e; }
  assert(`each: a job no longer on the page fails in the page's own words ("…no longer in ${page.place}")`,
    !!err && new RegExp(`^Old Job is no longer in ${page.place} — edit or delete this schedule\\.$`).test(err.message), err && err.message);

  // ── every In Progress job in one report ──
  const all = await reg.fn(spec({ jobsMode: 'all_in_progress' }));
  assert('all_in_progress: the jobs marked In Progress, the Complete one left out',
    JSON.stringify(all.customReport.project_ids) === '["p1","p2"]' && all.subject === 'Weekly Owner Update — 2 jobs');
  h.run('projectsList[1].status = "On Hold";');
  const allOne = await reg.fn(spec({ jobsMode: 'all_in_progress' }));
  assert('…follows the status as it is now', JSON.stringify(allOne.customReport.project_ids) === '["p1"]'
    && allOne.customReport.definition.header.preparedFor === 'Acme Township');
  h.run('projectsList.forEach(p => { p.status = "Complete"; });');
  const none = await reg.fn(spec({ jobsMode: 'all_in_progress' }));
  assert('…none In Progress: skipped, with the reason', none && none.skip === 'No jobs are marked In Progress.', JSON.stringify(none));
  h.setProjects(crProjects());

  // ── saved jobs edge cases, and the mode inferred when none is sent ──
  const empty = await reg.fn(spec({ customReport: { id: 1, name: 'R', definition: crDefinition({ jobs: { mode: 'pick', ids: [] } }) } }));
  assert('saved: a report with no saved jobs is skipped', !!empty && /no jobs saved/.test(empty.skip || ''), JSON.stringify(empty));
  const gone = await reg.fn(spec({ customReport: { id: 1, name: 'R', definition: crDefinition({ jobs: { mode: 'saved', ids: ['x', 'y'] } }) } }));
  assert('saved: jobs all gone — skipped, not an empty email', !!gone && /None of the jobs/.test(gone.skip || ''), JSON.stringify(gone));
  const inferredEach = await reg.fn(spec({ jobsMode: undefined, projectId: 'p2' }));
  const inferredSaved = await reg.fn(spec({ jobsMode: 'bogus', projectId: null }));
  assert('no jobs mode sent: a job id means that job, none means the saved jobs',
    JSON.stringify(inferredEach.customReport.project_ids) === '["p2"]' && JSON.stringify(inferredSaved.customReport.project_ids) === '["p1","p2"]');
  const own = await reg.fn(spec({ subject: '  Owner update  ' }));
  assert('a subject given with the spec is used as is', own.subject === 'Owner update');
  const named = await reg.fn(spec({ customReport: { id: 7, name: '', definition: crDefinition({ title: 'Field Report' }) } }));
  assert('a report with no saved name goes by its title', named.subject === 'Field Report — 2 jobs' && named.customReport.report_name === 'Field Report');

  // ── internal after all: skipped ──
  const SKIP = 'Report has internal data — scheduled sends are customer-safe only';
  h.useEngine({ buildReportHtml: () => '<div class="masthead" data-dw-brand data-cr-internal="1">x</div>' });
  const marked = await reg.fn(spec());
  assert('a report that still comes out carrying the internal mark is skipped, in the spec\'s words',
    !!marked && marked.skip === SKIP && !marked.html, JSON.stringify(marked));
  h.useEngine({ hasInternal: () => true });
  const flagged = await reg.fn(spec());
  assert('…and so is one the engine says has internal columns', !!flagged && flagged.skip === SKIP && !flagged.html);
  h.useEngine({ buildReportHtml: () => "<div data-cr-internal = '1'></div>" });
  const spaced = await reg.fn(spec());
  assert('…the mark is read however it is spaced or quoted', !!spaced && spaced.skip === SKIP);
  h.useEngine();

  // ── what the runner might send badly ──
  let e1 = null, e2 = null;
  try { await reg.fn(spec({ customReport: { id: 1, name: 'R' } })); } catch (e) { e1 = e; }
  assert('no definition with the spec: a plain error', !!e1 && /did not say which saved report/.test(e1.message));
  h.ctx.FCTReportEngine = undefined;
  try { await reg.fn(spec()); } catch (e) { e2 = e; }
  assert('the engine missing from the page: a plain error', !!e2 && /did not load/.test(e2.message));
  h.useEngine();

  // ── side reads that fail, or never answer ──
  // The login as the robot's fct_user carries it: no display name.
  const bareUser = Object.assign(userFor(page.division, 'admin'), { name: undefined });
  for (const [label, o] of [['fail', { answer: sideAnswer({ brandingFail: true, peopleFail: true }), user: bareUser }],
                            ['never answer', { answer: sideAnswer({ never: true }), fastTimers: true, user: bareUser }]]) {
    const g = pageVm(page, src, o);
    g.setProjects(crProjects());
    const r = await g.reg[type].fn(spec());
    assert(`branding and the directory ${label}: the report still goes, with the DataWatch masthead and no PM line`,
      !!r && !!r.html && /class="mast-word">DataWatch</.test(r.html) && !/class="mast-co"|class="mast-logo"|Project Manager:/.test(r.html),
      r && (r.skip || r.html.slice(0, 200)));
    assert(`…"Prepared by" falls back to the login`, !!r && r.customReport.definition.header.preparedBy === 'pat');
  }
  // A typed contact on the header wins over the directory.
  const typed = await reg.fn(spec({ customReport: { id: 1, name: 'R', definition: crDefinition({
    header: { contactName: 'Front Desk', contactPhone: '555-0199', contactEmail: '', branding: 'datawatch', preparedBy: 'Office' } }) } }));
  assert('the header\'s typed contact is the Questions contact; a typed "Prepared by" stays',
    lastMc().o.reportContact.name === 'Front Desk' && typed.customReport.definition.header.preparedBy === 'Office');
  assert('…and a report set to the DataWatch masthead keeps it', /class="mast-word">DataWatch</.test(typed.html) && !/class="mast-co"/.test(typed.html));

  // ── the tab and the robot are handed the same config ──
  h.run('renderCustomReports()');
  const tab = h.calls.configs[0], robot = lastMc().c;
  const keysOf = o => JSON.stringify(Object.keys(o).sort());
  assert('parity: the tab\'s configure() and the robot\'s build get the same keys',
    !!tab && keysOf(tab) === keysOf(robot) && keysOf(tab.helpers) === keysOf(robot.helpers));
  assert('…the same perm, division, label, area unit and user',
    !!tab && JSON.stringify(tab.perm) === JSON.stringify(robot.perm) && tab.division === robot.division
      && tab.divisionLabel === robot.divisionLabel && tab.areaUnit === robot.areaUnit && tab.user === robot.user);
  assert('…the same helper functions and the same live lists',
    !!tab && Object.keys(tab.helpers).every(k => tab.helpers[k] === robot.helpers[k])
      && tab.getProjects() === robot.getProjects() && tab.getPurchaseOrders() === robot.getPurchaseOrders());
}

/* ── The bid table's Plan / Day box ──────────────────────────────────────── */
function checkPlanMarkup(page, src) {
  const head = src.slice(src.lastIndexOf('<thead>', src.indexOf('<tbody id="bid-fs-tbody">')), src.indexOf('<tbody id="bid-fs-tbody">'));
  const ths = head.match(/<th[ >]/g) || [];
  const TIP = 'Planned production per working day (in the item&#39;s unit). Leave blank to plan from Start/Target dates.';
  assert('bid table header: Plan / Day right after Target Date, with the tooltip',
    head.includes(`<th>Start Date</th><th>Target Date</th>\n        <th class="num" title="${TIP}">Plan / Day</th>`));
  const render = requireFn(src, 'renderBidTable', page.file);
  const cols = /const COLS\s+= readonly \? (\d+) : (\d+);/.exec(render);
  const editable = render.slice(render.indexOf(': `<td class="bid-del"'), render.indexOf('tbody.appendChild(childTr)'));
  const tdsIn = s => (s.match(/<td[ >]/g) || []).length;
  const block = name => { const a = render.indexOf(`const ${name} = \``); return render.slice(a, render.indexOf('`;', a)); };
  const rowCells = tdsIn(editable) + tdsIn(block('calcCellsA')) + tdsIn(block('calcCellsB'))
    + (editable.match(/\$\{_bidDateCellHTML\(/g) || []).length + (editable.match(/\$\{_bidPlanRateCellHTML\(/g) || []).length;
  assert('editable row: one cell per header, and the group header spans exactly that',
    ths.length === 19 && rowCells === 19 && !!cols && Number(cols[2]) === 19 && Number(cols[1]) === 14,
    `${ths.length} th / ${rowCells} td / COLS ${cols && cols[2]}`);
  assert('…the Plan / Day cell sits straight after the Target Date cell',
    /\$\{_bidDateCellHTML\(projId, b, 'target_date', _auto\.target\)\}\s*\$\{_bidPlanRateCellHTML\(projId, b\)\}/.test(editable));
  assert('…and only in the editable table (the dashboard keeps its 14 columns)',
    (render.match(/_bidPlanRateCellHTML/g) || []).length === 1);
  assert('group total row: a blank under Plan / Day', /<td><\/td><td><\/td><td><\/td><td class="bid-calc" title="Distinct days worked across this cost code/.test(render));
  const foot = requireFn(src, 'renderBidFooter', page.file);
  const footRow = /footEl\.innerHTML = readonly \? cells : `([^`]*)`/.exec(foot);
  const footCells = footRow ? tdsIn(footRow[1]) + tdsIn(foot.slice(foot.indexOf('const cells = `'), foot.indexOf('`;', foot.indexOf('const cells = `')))) : 0;
  assert('footer: one cell per column', footCells === 19, footCells);
}

function planDom(page, src, role) {
  const dom = new JSDOM('<!DOCTYPE html><body><table><tbody id="tb"></tbody></table><span id="bic-b1"></span></body>',
    { runScripts: 'outside-only' });
  const w = dom.window;
  w.__user = userFor(page.division, role);
  w.__puts = [];
  w.__timers = [];
  w.fetch = async (url, init) => { w.__puts.push({ url: String(url), method: init.method, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  w.eval([
    `const DIVISION = ${JSON.stringify(pageConst(src, 'DIVISION'))};`,
    `const API_BASE = ${JSON.stringify(pageConst(src, 'API_BASE'))};`,
    "const fctToken = 'tok-123';",
    'const fctUser = window.__user;',
    permSource(src),
    liftLine(src, 'const _cbEsc =', page.file),
    liftLine(src, 'const PROJECTS_KEY', page.file),
    liftLine(src, 'const _biSaveTimers', page.file),
    liftLine(src, 'const _biSavePending', page.file),
    // var, not let: each window.eval is its own scope for let/const, and the
    // test sets the jobs from a later one.
    'var _lastProjIndexTs = 0;',
    'var projectsList = [];',
    'function getProj(id) { return projectsList.find(p => p.id === id); }',
    'function _projBlob(p) { return p; }',
    'function renderBidFooter() {}', 'function saveProject() {}', 'function _showSaveError() {}',
    'var setTimeout = fn => { window.__timers.push(fn); return window.__timers.length; }; var clearTimeout = () => {};',
    requireFn(src, 'fmt', page.file), requireFn(src, 'qfmt', page.file),
    requireFn(src, 'updateBidItem', page.file), requireFn(src, 'patchBidItem', page.file), requireFn(src, '_doBidItemPut', page.file),
    sliceThrough(src, '/* The "Plan / Day" box on a bid row', "document.addEventListener('change', _bidPlanRateOnChange);", 'the Plan / Day helpers'),
  ].join('\n'));
  const flush = () => { const due = w.__timers.splice(0); due.forEach(fn => fn()); };
  return { w, doc: w.document, flush };
}

function checkPlanCell(page, src) {
  // ── an editor ──
  const ed = planDom(page, src, 'admin');
  const { w, doc } = ed;
  w.eval(`projectsList = [{ id: 'P1', bidItems: [
    { id: 'b1', cost_code: '100', sub_code: '<i>Turf</i> "Install"', quantity: 100, unit_cost: 2, planned_rate: 250 },
    { id: 'b"2', cost_code: '100', sub_code: 'Base', quantity: 50, unit_cost: 1 },
    { id: 'b3', cost_code: '100', sub_code: 'Zero', quantity: 50, unit_cost: 1, planned_rate: 0 } ] }];`);
  doc.getElementById('tb').innerHTML = '<tr>' + w.eval("projectsList[0].bidItems.map(b => _bidPlanRateCellHTML('P1', b)).join('')") + '</tr>';
  const inputs = [...doc.querySelectorAll('#tb input')];
  assert('editor: a number box per row, one cell each', inputs.length === 3 && doc.querySelectorAll('#tb td').length === 3);
  const [i1, i2, i3] = inputs;
  assert('…numeric, zero or more, blank allowed, with the tooltip',
    i1 && i1.type === 'number' && i1.min === '0' && i1.getAttribute('step') === 'any'
      && i1.title === 'Planned production per working day (in the item\'s unit). Leave blank to plan from Start/Target dates.');
  assert('…showing the saved rate, blank for none, and 0 as 0', i1.value === '250' && i2.value === '' && i3.value === '0');
  assert('…no handler in the markup (one delegated listener saves it)', !/\son[a-z]+=/i.test(doc.getElementById('tb').innerHTML));
  assert('…ids and the sub code escaped into its attributes',
    i2.dataset.bidPlan === 'b"2' && i2.dataset.proj === 'P1' && i1.getAttribute('aria-label') === 'Planned per day — <i>Turf</i> "Install"'
      && !doc.querySelector('#tb i'));

  const change = (el, value) => { el.value = value; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const item = id => w.eval(`projectsList[0].bidItems.find(b => b.id === ${JSON.stringify(id)})`);
  change(i1, '312.5');
  assert('typing a rate saves it on the item as a number', item('b1').planned_rate === 312.5);
  ed.flush();
  const put = w.__puts[w.__puts.length - 1];
  assert('…through the per-item PUT (updateBidItem → patchBidItem), the whole item with planned_rate',
    !!put && put.method === 'PUT' && /\/api\/bid-items\?id=b1&projectId=P1&projectKey=/.test(put.url)
      && put.body.bidItem.planned_rate === 312.5 && put.body.bidItem.sub_code === '<i>Turf</i> "Install"', put && put.url);
  change(i1, '');
  ed.flush();
  assert('clearing it saves null', item('b1').planned_rate === null && w.__puts[w.__puts.length - 1].body.bidItem.planned_rate === null);
  const n = w.__puts.length;
  change(i1, '');
  ed.flush();
  assert('…and clearing a blank one again sends nothing', w.__puts.length === n);
  change(i2, '-5');
  ed.flush();
  assert('a negative is put back, not saved', i2.value === '' && !('planned_rate' in item('b"2')) && w.__puts.length === n);
  Object.defineProperty(i3, 'validity', { value: { badInput: true }, configurable: true });
  change(i3, '');
  assert('a half-typed number the box cannot read (badInput) is put back, not saved as blank',
    i3.value === '0' && item('b3').planned_rate === 0);
  delete i3.validity;
  change(i3, '0');
  ed.flush();
  assert('re-entering the same rate sends nothing', w.__puts.length === n);
  change(i2, '1200');
  ed.flush();
  assert('a rate on a line that had none saves too', item('b"2').planned_rate === 1200
    && w.__puts[w.__puts.length - 1].body.bidItem.planned_rate === 1200);
  w.eval(`window.__vals = ['12', '12.5', '.5', '7.', '1e3', ' 1,200 ', '', '  ', null, undefined, 0, 3, -1, '-2', 'x', '1.2.3', NaN, Infinity, 'e5', '.']
    .map(v => { const r = _bidPlanRateValue(v); return r === undefined ? 'bad' : r; });`);
  assert('_bidPlanRateValue: numbers ≥ 0 kept, blank → null, anything else refused',
    JSON.stringify(w.__vals) === JSON.stringify([12, 12.5, 0.5, 7, 1000, 1200, null, null, null, null, 0, 3, 'bad', 'bad', 'bad',
      'bad', 'bad', 'bad', 'bad', 'bad']), JSON.stringify(w.__vals));

  // ── someone who cannot edit bid items ──
  const ro = planDom(page, src, 'level1');
  ro.w.eval(`projectsList = [{ id: 'P1', bidItems: [{ id: 'b1', sub_code: 'Turf', planned_rate: 1234.5 }, { id: 'b2', sub_code: 'Base' }] }];`);
  const cells = ro.w.eval("projectsList[0].bidItems.map(b => _bidPlanRateCellHTML('P1', b))");
  assert('view-only: the rate as text, no box', !/<input/.test(cells.join('')) && /1,234\.5/.test(cells[0]) && />—</.test(cells[1]));
  ro.doc.getElementById('tb').innerHTML = '<tr><td><input type="number" data-bid-plan="b1" data-proj="P1" value="1234.5"></td></tr>';
  const forged = ro.doc.querySelector('#tb input');
  forged.value = '9';
  forged.dispatchEvent(new ro.w.Event('change', { bubbles: true }));
  ro.flush();
  assert('…and a box put there by hand saves nothing and is put back',
    ro.w.eval('projectsList[0].bidItems[0].planned_rate') === 1234.5 && ro.w.__puts.length === 0 && forged.value === '1234.5');
}

/* ══════════════════════════════════════════════════════════════════════════
   divisions.html — Manage System → Branding, and Auto Reports' custom rows
   ══════════════════════════════════════════════════════════════════════════ */
const DIVS = fs.readFileSync(path.join(ROOT, 'divisions.html'), 'utf8');
const MU_SUBTABS_RE = /const MU_SUBTABS = \{[^}]*\};/;

function divsDom(answer, opts = {}) {
  const dom = new JSDOM(DIVS, { runScripts: 'outside-only' });
  const w = dom.window;
  w.__calls = [];
  w.__confirms = [];
  w.confirm = msg => { w.__confirms.push(msg); return true; };
  w.fetch = async (url, init) => {
    const c = { url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {},
      body: init && init.body ? JSON.parse(init.body) : null };
    w.__calls.push(c);
    const a = answer(c) || { status: 404, body: { ok: false, error: 'not stubbed' } };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  };
  w.eval("var token = 'test-token'; var muActiveSubTab = 'users'; var supervisorsLoaded = true; var __dirOpened = 0;");
  w.eval(requireFn(DIVS, 'escHtml', 'divisions.html'));
  w.eval(MU_SUBTABS_RE.exec(DIVS)[0].replace('const ', 'var '));
  w.eval('function loadSupervisorList() {} function loadSchedulerList() {} function loadVacationList() {}'
    + ' function openDirectory() { __dirOpened++; }');
  if (!opts.autoReports) w.eval('function loadAutoReports() {} function arStartPolling() {} function arStopPolling() {}');
  w.eval(requireFn(DIVS, 'switchUserSubTab', 'divisions.html'));
  if (opts.autoReports) {
    // arData is the slice's own `let`: set it from inside that scope.
    w.eval(sliceSource(DIVS, '// ── Auto Reports sub-panel (inside Manage Users modal)', '// ── Vacation sub-panel',
      'the Auto Reports sub-panel', 'initAutoReportForm') + '\nwindow.__setArData = d => { arData = d; };');
  }
  w.eval(sliceSource(DIVS, '// ── Branding sub-panel (inside Manage Users modal)', '// ── Team Directory ─', 'the Branding sub-panel', 'initBrandingPanel'));
  return { w, doc: w.document, $: id => w.document.getElementById(id) };
}

function checkBrandingMarkup() {
  const doc = new JSDOM(DIVS).window.document;
  const m = MU_SUBTABS_RE.exec(DIVS);
  assert('MU_SUBTABS stays one flat object literal, now with branding: \'Branding\'',
    !!m && /branding: 'Branding'/.test(m[0]) && !/\{[^}]*\{/.test(m[0]));
  const btn = doc.getElementById('muTabBtnBranding'), panel = doc.getElementById('mu-panel-branding');
  assert('a Branding sub-tab button and panel, the panel inside Manage System',
    !!btn && !!panel && panel.classList.contains('mu-panel') && !!panel.closest('#userModalBackdrop') && /Branding/.test(btn.textContent));
  assert('…the button last in the strip, wired from the script (no inline handler)',
    !!btn && btn.parentElement.lastElementChild === btn && !btn.hasAttribute('onclick'));
  assert('…no inline handlers anywhere in the panel', !!panel && ![...panel.querySelectorAll('*')].some(el =>
    [...el.attributes].some(a => /^on/i.test(a.name))));
  const file = doc.getElementById('br-logo-file');
  assert('the logo picker takes PNG and JPEG only', !!file && file.type === 'file' && file.getAttribute('accept') === 'image/png,image/jpeg');
  assert('fields for name, phone, email, website, address and report footer, with the server\'s limits',
    [['br-name', 120], ['br-phone', 40], ['br-email', 254], ['br-website', 200], ['br-address', 300], ['br-footer', 300]]
      .every(([id, max]) => doc.getElementById(id) && Number(doc.getElementById(id).getAttribute('maxlength')) === max));
  assert('a link to the Team Directory for the PM phone and email',
    /PM phone and email come from the Team Directory/.test((doc.getElementById('br-dir-link') || {}).textContent || ''));
}

async function checkBrandingPanel() {
  const SAVED = { display_name: 'Force Corp Turf', logo: { mime: 'image/png', base64: PNG_B64, width: 1, height: 1 },
    phone: '555-0100', email: 'office@example.com', website: 'https://example.com', address: '1 Main St\nTown, PA',
    report_footer: 'PA HIC #123', updated_at: '2026-11-01T00:00:00Z', updated_by_username: 'boss' };
  let putAnswer = null;
  const answer = c => {
    if (c.url === '/api/company/branding' && c.method === 'GET') return { status: 200, body: { ok: true, branding: SAVED, canEdit: true } };
    if (c.url === '/api/company/branding' && c.method === 'PUT') {
      return putAnswer || { status: 200, body: { ok: true, branding: Object.assign({}, SAVED, c.body, c.body.logo === undefined ? {} : { logo: c.body.logo }), canEdit: true } };
    }
    return null;
  };
  const { w, doc, $ } = divsDom(answer);
  $('muTabBtnBranding').click();   // the button, as wired by the panel's script
  await waitUntil(() => $('br-name').value);
  assert('clicking the Branding tab shows its panel and reads the branding with a GET, signed in',
    $('mu-panel-branding').classList.contains('active') && $('muTabBtnBranding').classList.contains('active')
      && w.__calls.length === 1 && w.__calls[0].method === 'GET' && w.__calls[0].url === '/api/company/branding'
      && w.__calls[0].headers.Authorization === 'Bearer test-token');
  assert('…the saved fields filled in', $('br-name').value === 'Force Corp Turf' && $('br-phone').value === '555-0100'
    && $('br-address').value === '1 Main St\nTown, PA' && $('br-footer').value === 'PA HIC #123');
  assert('…the logo shown, and Remove logo offered', !!doc.querySelector('#br-logo-box img') && !$('br-logo-remove').disabled && !$('br-save').disabled);
  const pv = $('br-preview');
  assert('the masthead preview: the logo and the company name in place of DataWatch',
    !!pv.querySelector('.br-mast-logo') && pv.querySelector('.br-mast-logo').getAttribute('src') === `data:image/png;base64,${PNG_B64}`
      && pv.querySelector('.br-mast-co').textContent === 'Force Corp Turf' && !pv.querySelector('.br-mast-word'));
  assert('…the foot: the footer line, address, phone and website (the email is kept on file, not printed), and the DataWatch credit',
    /PA HIC #123/.test(pv.querySelector('.br-foot').textContent) && /1 Main St, Town, PA · 555-0100 · https:\/\/example\.com/.test(pv.querySelector('.br-foot').textContent)
      && !/office@example\.com/.test(pv.querySelector('.br-foot').textContent) && /Prepared with DataWatch/.test(pv.querySelector('.br-foot').textContent));
  // Round 7: the preview's foot is the report's foot — the same lines the
  // engine prints for the same branding, so neither can drift from the other.
  {
    const E = loadEngine();
    const def = E.normalizeDefinition({ title: 'Parity', sections: [{ type: 'notes', text: 'x' }] });
    const ctx = E.makeContext(def, { division: 'turf', divisionLabel: 'Turf', areaUnit: 'SF', perm: { role: 'admin', canSeeCosts: true, canSeeFinancials: true },
      getProjects: () => [{ id: 'p1', 'project-name': 'Lot', status: 'In Progress', bidItems: [], dailyRows: [] }], getPurchaseOrders: () => [], getTruckingEntries: () => [] },
    { pickedIds: ['p1'], branding: SAVED, today: '2026-11-05', now: new Date(2026, 10, 5) });
    const rdoc = new JSDOM(E.buildReportHtml(def, ctx)).window.document;
    const engineLines = [...rdoc.querySelectorAll('.rpt-foot .foot-co')].map(e => e.textContent);
    const previewLines = pv.querySelector('.br-foot span').textContent.split('\n');
    assert('round 7: the Branding preview\'s foot lines are the ones a report prints for the same branding (was an email line no report prints)',
      engineLines.length === 2 && JSON.stringify(previewLines) === JSON.stringify(engineLines)
        && !/office@example\.com/.test(rdoc.body.textContent), JSON.stringify({ previewLines, engineLines }));
  }
  $('br-name').value = '<img src=x onerror="window.__xss=1">';
  $('br-name').dispatchEvent(new w.Event('input', { bubbles: true }));
  assert('typing redraws the preview, and a name is text, never markup',
    pv.querySelector('.br-mast-co').textContent === '<img src=x onerror="window.__xss=1">' && !pv.querySelector('.br-mast-co img') && w.__xss === undefined);

  // ── the logo: type checks ──
  // Pick a file the way the box does, and wait for the panel's answer.
  const pick = async file => {
    const input = $('br-logo-file');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await waitUntil(() => $('br-result').textContent);
  };
  const saved = () => waitUntil(() => $('br-result').textContent && $('br-result').textContent !== 'Saving…');
  const canvasCalls = [];
  let dataUrls = {};
  w.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    return {
      fillStyle: '',
      fillRect(...a) { canvasCalls.push({ op: 'fillRect', a, fill: this.fillStyle, w: canvas.width, h: canvas.height }); },
      drawImage(img, ...a) { canvasCalls.push({ op: 'drawImage', img, a, w: canvas.width, h: canvas.height }); },
    };
  };
  w.HTMLCanvasElement.prototype.toDataURL = function (mime, q) {
    canvasCalls.push({ op: 'toDataURL', mime, q, w: this.width, h: this.height });
    return typeof dataUrls[mime] === 'function' ? dataUrls[mime]() : dataUrls[mime];
  };
  let nextImage = { w: 1800, h: 400 };
  w.Image = class {
    set src(v) { this._src = v; setTimeout(() => { if (nextImage.fail) { this.onerror(); return; } this.naturalWidth = nextImage.w; this.naturalHeight = nextImage.h; this.onload(); }, 0); }
    get src() { return this._src; }
  };
  const file = (type, bytes) => new w.File([new Uint8Array(bytes || 64)], 'logo', { type });
  for (const t of ['image/svg+xml', 'image/gif', 'image/webp', '']) {
    canvasCalls.length = 0;
    await pick(file(t));
    assert(`a ${t || 'typeless'} file is refused before anything is drawn`,
      /PNG or JPEG/.test($('br-result').textContent) && canvasCalls.length === 0 && $('br-logo-file').value === '');
  }
  const huge = file('image/png', 8);
  Object.defineProperty(huge, 'size', { value: 16 * 1024 * 1024 });
  await pick(huge);
  assert('a file over 15 MB is refused unopened', /under 15 MB/.test($('br-result').textContent) && canvasCalls.length === 0);

  // ── downscale: fits 600 × 200, keeps its shape, never enlarges ──
  const small = 'data:image/png;base64,' + PNG_B64;
  dataUrls = { 'image/png': small, 'image/jpeg': 'data:image/jpeg;base64,/9j/4AAQ' };
  await pick(file('image/png'));
  const draw = canvasCalls.find(c => c.op === 'drawImage');
  assert('a 1800 × 400 logo is drawn at 600 × 133 — the width the limit, the shape kept',
    !!draw && draw.w === 600 && draw.h === 133 && JSON.stringify(draw.a) === '[0,0,600,133]', draw && JSON.stringify([draw.w, draw.h, draw.a]));
  assert('…saved as a PNG, no JPEG tried when the PNG is small',
    canvasCalls.filter(c => c.op === 'toDataURL').map(c => c.mime).join() === 'image/png' && !canvasCalls.some(c => c.op === 'fillRect'));
  assert('…shown in the box and the preview, Save to keep it',
    doc.querySelector('#br-logo-box img').getAttribute('src') === small && /Logo ready — 600 × 133/.test($('br-result').textContent));
  canvasCalls.length = 0;
  nextImage = { w: 300, h: 100 };
  await pick(file('image/jpeg'));
  const draw2 = canvasCalls.find(c => c.op === 'drawImage');
  assert('a 300 × 100 logo is not enlarged', !!draw2 && draw2.w === 300 && draw2.h === 100);
  canvasCalls.length = 0;
  nextImage = { w: 100, h: 900 };
  await pick(file('image/png'));
  const draw3 = canvasCalls.find(c => c.op === 'drawImage');
  assert('a tall one fits the 200-pixel height (100 × 900 → 22 × 200)', !!draw3 && draw3.w === 22 && draw3.h === 200);

  // A PNG over 200 KB: JPEG at 0.9, on white.
  canvasCalls.length = 0;
  nextImage = { w: 600, h: 200 };
  const big = 'A'.repeat(Math.ceil(210 * 1024 / 3) * 4);
  dataUrls = { 'image/png': 'data:image/png;base64,' + big, 'image/jpeg': 'data:image/jpeg;base64,' + 'B'.repeat(4000) };
  await pick(file('image/png'));
  const jpgCall = canvasCalls.find(c => c.op === 'toDataURL' && c.mime === 'image/jpeg');
  const fill = canvasCalls.find(c => c.op === 'fillRect');
  assert('a PNG over 200 KB is saved as a JPEG at quality 0.9 instead',
    !!jpgCall && jpgCall.q === 0.9 && doc.querySelector('#br-logo-box img').getAttribute('src').startsWith('data:image/jpeg;base64,B'));
  assert('…on white, since a JPEG has no transparency', !!fill && fill.fill === '#fff' && JSON.stringify(fill.a) === '[0,0,600,200]');
  // Both over: refused, the logo before it kept.
  dataUrls = { 'image/png': 'data:image/png;base64,' + big, 'image/jpeg': 'data:image/jpeg;base64,' + big.slice(0, big.length - 400) };
  await pick(file('image/png'));
  assert('still over 200 KB as a JPEG: refused, with the size, and the logo before it kept',
    /must be under 200 KB/.test($('br-result').textContent) && /KB/.test($('br-result').textContent)
      && doc.querySelector('#br-logo-box img').getAttribute('src').startsWith('data:image/jpeg;base64,B'));
  nextImage = { fail: true };
  await pick(file('image/png'));
  assert('a file the browser cannot open as an image is refused', /Could not use that image/.test($('br-result').textContent));
  dataUrls = { 'image/png': 'data:,' };
  nextImage = { w: 50, h: 50 };
  await pick(file('image/png'));
  assert('…and so is one the canvas cannot save as a PNG', /could not save it as a PNG/.test($('br-result').textContent));

  // ── Save: the PUT body ──
  $('br-name').value = '  Force Corp Sports  ';
  $('br-phone').value = '';
  w.__calls.length = 0;
  $('br-save').click();
  await saved();
  const put = w.__calls.find(c => c.method === 'PUT');
  assert('Save sends one PUT to /api/company/branding, signed in, as JSON',
    !!put && put.url === '/api/company/branding' && put.headers.Authorization === 'Bearer test-token' && put.headers['Content-Type'] === 'application/json');
  assert('…every field, trimmed — a cleared one sent empty so it is cleared',
    !!put && put.body.display_name === 'Force Corp Sports' && put.body.phone === '' && put.body.email === 'office@example.com'
      && put.body.website === 'https://example.com' && put.body.address === '1 Main St\nTown, PA' && put.body.report_footer === 'PA HIC #123');
  assert('…and the new logo, as the downscale made it', !!put && put.body.logo && put.body.logo.mime === 'image/jpeg'
    && put.body.logo.base64.startsWith('BBBB') && put.body.logo.width === 600 && put.body.logo.height === 200);
  assert('…nothing but those keys', !!put && JSON.stringify(Object.keys(put.body).sort())
    === JSON.stringify(['address', 'display_name', 'email', 'logo', 'phone', 'report_footer', 'website']));
  assert('saved: says so, and the form shows what the server kept', /Saved/.test($('br-result').textContent) && $('br-name').value === 'Force Corp Sports');
  w.__calls.length = 0;
  $('br-save').click();
  await saved();
  const put2 = w.__calls.find(c => c.method === 'PUT');
  assert('saving again with the logo untouched leaves it out (the saved one stays)', !!put2 && !('logo' in put2.body));
  $('br-logo-remove').click();
  assert('Remove logo empties the box', !doc.querySelector('#br-logo-box img') && /Save to take it off/.test($('br-result').textContent));
  w.__calls.length = 0;
  $('br-save').click();
  await saved();
  const put3 = w.__calls.find(c => c.method === 'PUT');
  assert('…and Save then sends logo: null', !!put3 && put3.body.logo === null);
  // Quick checks before the server's.
  w.__calls.length = 0;
  $('br-email').value = 'not an email';
  $('br-save').click();
  await settleAll();
  assert('a mistyped email is caught before sending', /email address does not look right/.test($('br-result').textContent) && !w.__calls.length);
  $('br-email').value = 'office@example.com';
  $('br-website').value = 'javascript:alert(1)';
  $('br-save').click();
  await settleAll();
  assert('a website that is not http(s) is caught before sending', /http or https/.test($('br-result').textContent) && !w.__calls.length);
  $('br-website').value = 'example.com';
  putAnswer = { status: 413, body: { ok: false, error: 'The logo is too large — keep it under 200 KB.' } };
  $('br-save').click();
  await saved();
  assert('the server\'s refusal is shown as it said it', $('br-result').textContent === 'The logo is too large — keep it under 200 KB.');
  $('br-dir-link').click();
  assert('the Team Directory link opens the directory', w.__dirOpened === 1);

  // ── someone who cannot edit ──
  const ro = divsDom(c => (c.method === 'GET' ? { status: 200, body: { ok: true, branding: null, canEdit: false } } : null));
  ro.w.eval("switchUserSubTab('branding')");
  await settleAll();
  assert('without edit rights: every box, the picker and Save disabled, and it says why',
    ['br-name', 'br-phone', 'br-email', 'br-website', 'br-address', 'br-footer', 'br-logo-file', 'br-save', 'br-logo-remove'].every(id => ro.$(id).disabled)
      && /Only a company admin/.test(ro.$('br-status').textContent));
  assert('…with no branding saved, the preview keeps the DataWatch masthead',
    !!ro.doc.querySelector('#br-preview .br-mast-word') && !ro.doc.querySelector('#br-preview .br-mast-co'));
  ro.$('br-save').disabled = false;
  ro.$('br-save').click();
  await settleAll();
  assert('…and Save does nothing even if pressed', !ro.w.__calls.some(c => c.method === 'PUT'));
  const bad = divsDom(() => ({ status: 500, body: { ok: false, error: 'Database error' } }));
  bad.w.eval("switchUserSubTab('branding')");
  await settleAll();
  assert('a failed read says so, and nothing is editable', /Could not read the branding: Database error/.test(bad.$('br-status').textContent) && bad.$('br-save').disabled);
  const evil = divsDom(c => (c.method === 'GET' ? { status: 200, body: { ok: true, canEdit: true,
    branding: { display_name: 'X', logo: { mime: 'image/svg+xml', base64: 'PHN2Zz4=' } } } } : null));
  evil.w.eval("switchUserSubTab('branding')");
  await settleAll();
  assert('a logo that is not PNG/JPEG base64 is never drawn', !evil.doc.querySelector('#br-logo-box img') && !evil.doc.querySelector('#br-preview img'));
}

async function checkAutoReportsCustomRows() {
  const future = new Date(Date.now() + 86400000).toISOString(), past = new Date(Date.now() - 86400000).toISOString();
  const AR_DATA = {
    ok: true, defaultTimezone: 'America/New_York', periods: { prev_day: 'Previous day' }, payRanges: {},
    divisions: [
      { key: 'turf', name: 'Turf', reports: [
        { type: 'turf_daily_pm', name: 'Daily PM Report', scope: 'job', blurb: 'pm' },
        { type: 'turf_bid_items', name: 'Bid Items', scope: 'job', blurb: 'bid' },
        { type: 'turf_custom_report', name: 'Custom Report', scope: 'custom', customReport: true, managed_in: 'custom_reporting', blurb: 'c' } ] },
      { key: 'paving', name: 'Paving', reports: [
        { type: 'paving_daily_pm', name: 'Daily PM Report', scope: 'job', blurb: 'pm' },
        { type: 'paving_custom_report', name: 'Custom Report', scope: 'custom', customReport: true, managed_in: 'custom_reporting', blurb: 'c' } ] },
    ],
    schedules: [
      { id: 1, report_type: 'turf_daily_pm', division: 'turf', project_id: '*', frequency: 'weekdays', send_time: '06:30',
        group_ids: [5], enabled: true, next_run_at: future, options: {} },
      { id: 2, report_type: 'turf_custom_report', division: 'turf', managed_in: 'custom_reporting', report_name: 'Owner <b>Update</b>',
        custom_report_id: 41, jobs_mode: 'each', project_id: '*', picked_jobs: [{ id: 'p1', name: 'Maple' }, { id: 'p2', name: 'Oak' }],
        frequency: 'weekly', days_of_week: [1], send_time: '07:00', group_ids: [5], emails: ['a@x.com', 'b@x.com'], use_job_contacts: true,
        enabled: true, next_run_at: future, last_status: 'sent', last_run_at: past, last_message: 'Sent 2 reports.', options: {} },
      { id: 3, report_type: 'paving_custom_report', division: 'paving', managed_in: 'custom_reporting', report_name: 'Paving Weekly',
        jobs_mode: 'saved', project_id: null, frequency: 'daily', send_time: '06:00', group_ids: [], emails: [], use_job_contacts: true,
        enabled: false, options: {} },
      { id: 4, report_type: 'turf_custom_report', division: 'turf', managed_in: 'custom_reporting', report_name: 'Gone Report',
        report_deleted: true, jobs_mode: 'all_in_progress', project_id: null, frequency: 'daily', send_time: '05:00', group_ids: [5],
        emails: ['c@x.com'], use_job_contacts: false, enabled: true, next_run_at: future, last_status: 'failed', last_run_at: past,
        last_message: 'The saved report was deleted.', options: {} },
    ],
    groups: [{ id: 5, name: 'Office', count: 3, emails: ['o@x.com'] }],
    runs: [
      { id: 9, schedule_id: 2, kind: 'schedule', status: 'sent', report_type: 'turf_custom_report', division: 'turf',
        report_name: 'Owner <b>Update</b>', project_name: '2 picked jobs', project_id: '*', started_at: past, message: 'ok' },
      { id: 10, schedule_id: 1, kind: 'manual', status: 'sent', report_type: 'turf_daily_pm', division: 'turf', report_name: null,
        project_id: '*', started_at: past, message: 'ok' },
    ],
  };
  const answer = c => {
    if (/report-schedules\?projects=/.test(c.url)) return { status: 200, body: { ok: true, projects: [] } };
    if (/report-schedules\?id=2$/.test(c.url) && c.method === 'PUT') {
      return { status: 200, body: { ok: true, schedule: Object.assign({}, AR_DATA.schedules[1], { enabled: c.body.enabled }) } };
    }
    if (/report-schedules\?id=2$/.test(c.url) && c.method === 'DELETE') return { status: 200, body: { ok: true } };
    if (/report-schedules$/.test(c.url)) return { status: 200, body: AR_DATA };
    return null;
  };
  const { w, doc, $ } = divsDom(answer, { autoReports: true });
  w.HTMLElement.prototype.scrollIntoView = function () {};   // jsdom has no layout
  w.__ar = JSON.parse(JSON.stringify(AR_DATA));
  w.__setArData(w.__ar);
  w.eval('arFillDivisionFilter(); renderAutoReports();');
  const row = id => doc.querySelector(`.ar-row[data-id="${id}"]`);
  const r2 = row(2), r1 = row(1), r3 = row(3), r4 = row(4);
  assert('every schedule has a row, custom ones included', !!r1 && !!r2 && !!r3 && !!r4);
  if (!r2) return;
  const title = r2.querySelector('.ar-title');
  assert('custom row: the saved report\'s name (as text) and a Custom Report tag',
    title.firstChild.textContent === 'Owner <b>Update</b>' && !title.querySelector('b') && r2.querySelector('.ar-managed').textContent === 'Custom Report');
  const subs = [...r2.querySelectorAll('.ar-c-title .ar-sub')].map(e => e.textContent);
  assert('…who it goes to: its groups, its own addresses and the jobs\' saved contacts',
    subs[0] === 'To Office (3), 2 addresses, each job\'s saved contacts', subs[0]);
  assert('…the note that it is managed in Custom Reporting', subs.includes('Managed in Analytics → Custom Reporting'));
  assert('…its jobs: the picked ones, one email each', r2.querySelector('.ar-c-job').textContent.replace(/\s+/g, ' ').trim()
    === '2 picked jobs Maple, Oak · one email per job');
  assert('…its cadence and last status like any other row',
    /Mon · 7:00 AM/.test(r2.querySelector('.ar-c-when').textContent) && /Sent/.test(r2.querySelector('.ar-badge').textContent)
      && /Sent 2 reports\./.test(r2.querySelector('.ar-c-status').textContent));
  const edit = [...r2.querySelectorAll('.ar-c-act button')].find(b => b.textContent.trim() === 'Edit');
  assert('…Edit disabled, saying where it is managed; no Send now',
    !!edit && edit.disabled && edit.title === 'Managed in Analytics → Custom Reporting' && !edit.hasAttribute('onclick')
      && !r2.querySelector('.ar-send-btn'));
  assert('…switch on/off and Delete still there', !!r2.querySelector('.ar-c-tog input[type=checkbox]') && !!r2.querySelector('.user-del-btn'));
  assert('an ordinary row keeps Send now and Edit',
    !!r1.querySelector('.ar-send-btn') && [...r1.querySelectorAll('.ar-c-act button')].some(b => b.textContent.trim() === 'Edit' && !b.disabled));
  assert('a saved-jobs custom row: "The report\'s saved jobs", one report, to the jobs\' contacts; shown off',
    /The report's saved jobs/.test(r3.querySelector('.ar-c-job').textContent) && /one report/.test(r3.querySelector('.ar-c-job').textContent)
      && r3.querySelector('.ar-c-title .ar-sub').textContent === 'To each job\'s saved contacts' && r3.classList.contains('off'));
  assert('an every-In-Progress custom row, its report deleted: says so',
    /All In Progress jobs/.test(r4.querySelector('.ar-c-job').textContent) && !!r4.querySelector('.ar-gone')
      && /To Office \(3\), 1 address$/.test(r4.querySelector('.ar-c-title .ar-sub').textContent));
  const hist = [...doc.querySelectorAll('#ar-hist-body tr')].map(tr => tr.cells[1].textContent);
  assert('recent sends name the saved report ("Custom Report — …", as text)',
    hist.some(t => t.startsWith('Custom Report — Owner <b>Update</b>')) && hist.some(t => t.startsWith('Daily PM Report'))
      && !doc.querySelector('#ar-hist-body b'));

  // The editor never offers a custom report.
  w.eval("arNew('turf')");
  await settleAll();
  const types = () => [...$('ar-report').options].map(o => o.value);
  assert('New Schedule: the report picker leaves the custom report out',
    $('ar-form').classList.contains('open') && types().join() === 'turf_daily_pm,turf_bid_items', types().join());
  $('ar-division').value = 'paving';
  w.eval('arOnDivision()');
  await settleAll();
  assert('…in every division', types().join() === 'paving_daily_pm', types().join());
  w.eval('arCloseForm()');
  w.eval('arEdit(2)');
  assert('Edit on a custom schedule (by any route) opens nothing and says where to go',
    !$('ar-form').classList.contains('open') && /Managed in Analytics → Custom Reporting/.test($('ar-status').textContent));
  w.__calls.length = 0;
  await w.eval('arSendNow(2, null)');
  assert('…and Send now on one does nothing', !w.__calls.length && !w.__confirms.length);
  // Off and on, and delete.
  const tog = r2.querySelector('.ar-c-tog input');
  tog.checked = false;
  await w.eval('arToggle(document.querySelector(\'.ar-row[data-id="2"] .ar-c-tog input\'), 2)');
  await settleAll();
  const putCall = w.__calls.find(c => c.method === 'PUT');
  assert('switching it off sends only { enabled: false }', !!putCall && /\?id=2$/.test(putCall.url) && JSON.stringify(putCall.body) === '{"enabled":false}');
  w.__calls.length = 0;
  await w.eval('arDelete(2)');
  await settleAll();
  assert('Delete asks by the saved report\'s name, then deletes',
    /Owner <b>Update<\/b>/.test(w.__confirms[w.__confirms.length - 1] || '') && w.__calls.some(c => c.method === 'DELETE' && /\?id=2$/.test(c.url)));
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
    attempt('mixed-grant checks ran', () => checkMixedGrants(page, src));
    attempt('wait checks ran', () => checkWaiting(page, src));

    console.log('  — v2: working days, the Construction Schedule, the scheduled builder');
    attempt('working-day parity checks ran', () => checkWorkdayParity(page, src));
    if (page.cs) await attemptAsync('Construction Schedule checks ran', () => checkConSchedule(page, src));
    await attemptAsync('scheduled builder checks ran', () => checkScheduledBuilder(page, src));
    console.log('  — v2: the bid table\'s Plan / Day box');
    attempt('Plan / Day markup checks ran', () => checkPlanMarkup(page, src));
    attempt('Plan / Day cell checks ran', () => checkPlanCell(page, src));
  }

  console.log('\ndivisions.html');
  attempt('Branding markup checks ran', () => checkBrandingMarkup());
  await attemptAsync('Branding panel checks ran', () => checkBrandingPanel());
  await attemptAsync('Auto Reports custom-row checks ran', () => checkAutoReportsCustomRows());

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
