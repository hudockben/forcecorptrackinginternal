#!/usr/bin/env node
'use strict';
/**
 * The Procurement tab, from tracker.html's side.
 *
 * Run: node scripts/test-procurement-page.js
 *
 * The sheet itself is procurement.js (scripts/test-procurement-frontend.js);
 * the rows are api/procurement.js (scripts/test-procurement-sql.js). What is
 * left, and checked here, is the page holding it all together:
 *
 *   1. the wiring, read off the source: the deferred script, the combobox
 *      routing, who sees the tab, the bid page's button and the offer after a
 *      Procore import, the landing after a send, the poll and boot hooks, and
 *      the clean-up when a job is deleted
 *   2. the page booted in a real DOM as each level — level1, level2 and
 *      admin get the tab, sales does not — with procurement.js loaded into it,
 *      so the configuration it is handed is the one that actually runs
 *   3. the page's own helpers run against a scripted server: the bid lines it
 *      hands over (change orders and all), "+ Add as new supplier" saving the
 *      lists blob with baseUpdatedAt and retrying a 409, "Create PO" saving one
 *      order on its own, and opening that order on the Purchase Orders tab
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { requireFn } = require('./lib/fn-source');

const root = (...p) => path.resolve(__dirname, '..', ...p);
const SRC  = fs.readFileSync(root('tracker.html'), 'utf8');
const MODULE_PATH = root('procurement.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '\n      ' + String(detail).slice(0, 400) : ''}`); }
}

// ── 1. Wiring ───────────────────────────────────────────────────────────────
console.log('\n[tracker.html — wiring]');
{
  const scripts = [...SRC.matchAll(/<script src="([^"]+)"([^>]*)><\/script>/g)].map(m => ({ src: m[1], attrs: m[2] }));
  const at = scripts.findIndex(s => s.src === 'procurement.js');
  assert('procurement.js is loaded, deferred', at >= 0 && /\bdefer\b/.test(scripts[at].attrs));
  assert('  next to documents.js, the module it is modelled on',
    at > 0 && scripts[at - 1].src === 'documents.js', scripts.map(s => s.src).join(', '));

  const cbOpts = requireFn(SRC, 'cbOptionsFor');
  assert('cbOptionsFor hands every proc_ key to the module, first thing',
    /^function cbOptionsFor\(listKey\) \{[\s\S]*?\n  if \(String\(listKey\)\.startsWith\('proc_'\)\) return window\.FCTProcurement \? FCTProcurement\.cbOptions\(listKey\) : \[\];\n  if \(listKey === 'suppliers'\)/.test(cbOpts),
    cbOpts.slice(0, 400));
  const cbFilt = requireFn(SRC, 'cbFilterFor');
  assert('cbFilterFor does the same, so the vendor picker can offer "+ Add as new supplier"',
    /if \(String\(listKey \|\| ''\)\.startsWith\('proc_'\)\) return window\.FCTProcurement \? FCTProcurement\.cbFilter\(listKey, rawQuery, options\) : options;/.test(cbFilt)
      && cbFilt.indexOf("startsWith('proc_')") < cbFilt.indexOf("startsWith('bid_subcodes')"));

  const permAt = SRC.indexOf('visibleTabs:');
  const permBlock = SRC.slice(permAt, SRC.indexOf(': null', permAt));
  const setFor = re => (permBlock.split('\n').find(l => re.test(l)) || '');
  assert('level1 sees the tab', /'procurement'/.test(setFor(/r === 'level1'/)), setFor(/r === 'level1'/));
  assert('level2 sees the tab', /'procurement'/.test(setFor(/r === 'level2'/)), setFor(/r === 'level2'/));
  assert('sales does not', setFor(/isSales/) && !/'procurement'/.test(setFor(/isSales/)), setFor(/isSales/));
  assert('  and nobody lands on it: it is never the first tab of a set',
    permBlock.split('\n').filter(l => /new Set\(/.test(l)).every(l => !/new Set\(\['procurement'/.test(l)));
  assert('the tab is still desktop-only', /\.tab-btn\[data-tab="procurement"\],\n[\s\S]*?\{ display: none !important; \}/.test(SRC));
  assert('clicking the tab draws it', /if \(activeTab === 'procurement'\) renderProcurementTab\(\);/.test(SRC));
  assert('the placeholder is gone', !/Placeholder for now/.test(SRC) && !/Nothing here yet\./.test(requireFn(SRC, 'renderProcurementTab')));

  const render = requireFn(SRC, 'renderProcurementTab');
  assert('the tab waits for the deferred script, bounded',
    /if \(!window\.FCTProcurement\)/.test(render) && /_procWaitTicks > 40/.test(render) && /setTimeout\(/.test(render));
  assert('  then configures it and mounts it on #procurement-root',
    /_procEnsureConfigured\(\);\n  FCTProcurement\.renderTab\(root\);/.test(render)
      && /const root = document\.getElementById\('procurement-root'\);/.test(render));
  const conf = requireFn(SRC, '_procEnsureConfigured');
  for (const k of ['division', 'apiBase', 'getToken', 'getUserName', 'perm', 'getProjects', 'getProject', 'getBidLines',
                   'getPurchaseOrders', 'isPOListLoaded', 'codeKey', 'getSuppliers', 'addSupplier', 'createPurchaseOrder',
                   'openPurchaseOrder', 'showSaveError', 'today', 'storage']) {
    assert(`  configure() is handed ${k}`, new RegExp(`\\n    ${k}[:,]`).test(conf));
  }
  assert('  as turf', /division:\s+PROC_DIVISION,/.test(conf) && /const PROC_DIVISION = 'turf';/.test(SRC));

  // The bid page's button. Between Import Procore Estimate and + Add Item —
  // XLSX → Email is pinned by test-bid-xlsx, and the Procore/Copy wiring lines
  // by test-procore-import / test-bid-copy.
  const doc = new JSDOM(SRC).window.document;
  const btn = doc.getElementById('bid-fs-procurement');
  assert('the bid page has a Send to Procurement button', btn && /Send\sto\sProcurement/.test(btn.textContent) && btn.classList.contains('btn-ghost'));
  // .btn is inline-flex: the span is a flex item, and plain spaces at its
  // edges collapse ("➤Send toProcurement"). Non-breaking ones stay.
  assert('  its label keeps its spaces inside the flex button', btn && /\u27A4\u00A0/.test(btn.textContent) && /Send to\u00A0$/.test((btn.querySelector('.bid-fs-long') || {}).textContent || ''));
  assert('  between Import Procore Estimate and + Add Item',
    btn && btn.previousElementSibling && btn.previousElementSibling.id === 'bid-fs-procore'
      && btn.nextElementSibling && btn.nextElementSibling.id === 'bid-fs-add');
  assert('  hidden until openBidView decides who gets it', btn && /display:\s*none/.test(btn.getAttribute('style') || ''));
  const obv = requireFn(SRC, 'openBidView');
  assert('openBidView wires it to sendBidToProcurement(projId)',
    /getElementById\('bid-fs-procurement'\)\.onclick = \(\) => sendBidToProcurement\(projId\)/.test(obv));
  assert('  and shows it only to someone who can edit and see Procurement',
    /getElementById\('bid-fs-procurement'\)\.style\.display = _procCanEdit\(\) \? '' : 'none'/.test(obv));
  assert('  right after the Procore wiring', obv.indexOf("'bid-fs-procore'") < obv.indexOf("'bid-fs-procurement'"));
  assert('_procCanEdit is canEdit AND the tab is visible',
    /return perm\.canEdit && _procCanSee\(\);/.test(requireFn(SRC, '_procCanEdit'))
      && /return !perm\.visibleTabs \|\| perm\.visibleTabs\.has\('procurement'\);/.test(requireFn(SRC, '_procCanSee')));

  const commit = SRC.match(/function commitProcoreImport\([\s\S]+?\n\}\n/);
  assert('a Procore import offers the send, after its alert',
    commit && /alert\(`Imported from the Procore estimate[\s\S]*_procOfferSendAfterImport\(projId\);/.test(commit[0]), commit && commit[0].slice(-300));
  const offer = requireFn(SRC, '_procOfferSendAfterImport');
  assert('  asking first, and only someone who may send',
    /if \(!_procCanEdit\(\) \|\| !window\.FCTProcurement\) return;/.test(offer)
      && /confirm\('Send the bid lines to Procurement now\?'\)/.test(offer)
      && /FCTProcurement\.openSendModal\(projId\)/.test(offer));

  assert('a send lands the user on the tab',
    /window\.addEventListener\('fct:procurement-sent', \(\) => \{[\s\S]*?if \(bidViewProjId\) closeBidView\(\);[\s\S]*?\.tab-btn\[data-tab="procurement"\][\s\S]*?btn\.click\(\);/.test(SRC));

  const del = SRC.slice(SRC.indexOf("confirm.addEventListener('click', () => {", SRC.indexOf('drDeleteByProject(id)') - 400));
  const delBody = del.slice(0, del.indexOf('renderProjectsTab();'));
  assert('deleting a job soft-deletes its Procurement rows',
    /fetch\(`\$\{API_BASE\}\/procurement\?division=\$\{PROC_DIVISION\}&project_id=\$\{encodeURIComponent\(id\)\}`, \{\s*method: 'DELETE'/.test(delBody));
  assert('  and says so in the console when that fails',
    /console\.warn\(`\[procurement\][^`]*HTTP \$\{r\.status\}`\)/.test(delBody) && /\.catch\(err => console\.warn\(/.test(delBody));

  const boot = SRC.slice(SRC.indexOf('const _bootReady = (async () => {'));
  const bootBody = boot.slice(0, boot.indexOf('\n})();'));
  assert('boot redraws the tab when it is the open one',
    /if \(activeTab === 'procurement'\) renderProcurementTab\(\);/.test(bootBody));

  const pollAll = requireFn(SRC, '_pollAll');
  assert('the minute poll includes Procurement', /_pollProcurement\(\),/.test(pollAll));
  const pollProc = requireFn(SRC, '_pollProcurement');
  assert('  which refreshes only the open tab, and never mid-edit, on a hidden page or for the robot',
    /if \(_AUTO_REPORT \|\| _fctPollsSuspended\(\)\) return;/.test(pollProc)
      && /if \(activeTab !== 'procurement' \|\| !window\.FCTProcurement \|\| !_procConfigured\) return;/.test(pollProc)
      && /if \(_isEditing\(\)\) return;/.test(pollProc)
      && /await FCTProcurement\.refresh\(\);/.test(pollProc));
  const pollPO = requireFn(SRC, '_pollPurchaseOrders');
  assert('a new order list redraws it (after the editing bail-out, which the Procurement tab — copies only — is not held by)',
    /if \(_isEditing\(\) && activeTab !== 'procurement'\) return;[\s\S]*purchaseOrders = incoming;[\s\S]*if \(activeTab === 'procurement'\) _procRerender\(\);/.test(pollPO));
  const reread = requireFn(SRC, '_poReread');
  assert('the order list can be read again on demand (Create PO, a job picked, a rename): taken with its version, never blanked by a failed read',
    /purchaseOrders = incoming;[\s\S]*_poBaseUpdatedAt = data\.updatedAt/.test(reread) && /if \(!r\.ok\) return false;/.test(reread)
      && !/purchaseOrders = \[\]/.test(reread) && /refreshPurchaseOrders: \(\) => _poReread\(\)/.test(SRC));
  assert('  and so does a job reload', /await loadProjects\(\);[\s\S]*if \(activeTab === 'procurement'\) _procRerender\(\);/.test(requireFn(SRC, '_pollProjects')));
  assert('_procRerender redraws without fetching',
    /FCTProcurement\.rerender\(\)/.test(requireFn(SRC, '_procRerender')));

  const sup = requireFn(SRC, 'renderSupplierTab');
  assert('the Suppliers tab has a search box', /id="sup-search"/.test(sup) && /oninput="_supSetSearch\(this\)"/.test(sup));
  assert('  reaching name, phone, address and the contacts',
    /\[s\.name, s\.phone, s\.address\]\.concat\(\s*_supContactsFor\(C, s\.name\)\.flatMap\(c => \[c\.name, c\.email, c\.phone\]\)/.test(sup));
  assert('  and a contacts column', /data-supc-toggle=/.test(sup) && />Contacts<\/th>/.test(sup));
  assert('contact inputs carry their own attributes, so the per-keystroke supplier listener skips them',
    !/data-sup-idx="\$\{i\}" data-supc/.test(SRC) && /data-supc-id="\$\{_cbEsc\(c\.id\)\}" data-supc-field="name"/.test(SRC));
  assert('a rename carries the contacts to the new name',
    /if \(el\.dataset\.supField === 'name'\) _supRenamed\(el\);/.test(SRC) && /C\.rename\(from, target\)/.test(requireFn(SRC, '_supRenamed'))
      // The old name a box had on focus — or, when an earlier visit left it
      // blank or a redraw took it mid-word, the last real one (still pending).
      && /addEventListener\('focusin'[\s\S]{0,400}el\.dataset\.supOldName = \(entry && _supPendingFrom\.get\(entry\)\) \|\| el\.value/.test(SRC));
  const renamed = requireFn(SRC, '_supRenamed');
  assert('a rename onto another supplier\'s name is asked (confirm), never a silent merge',
    /const other = lists\.suppliers\.findIndex\([\s\S]*confirm\(/.test(renamed) && /lists\.suppliers\.splice\(idx, 1\)/.test(renamed));
  assert('  a box a redraw took away renames nothing; one left blank gets its last real name back',
    /if \(!el\.isConnected\)/.test(renamed) && /if \(!to\) \{[\s\S]{0,120}if \(from\) \{\s*el\.value = from;\s*if \(entry\) \{ entry\.name = from; saveLists\(\);/.test(renamed));
  const afterRename = requireFn(SRC, '_supAfterPORename');
  assert('  and the purchase orders follow, renamed by the server: the page takes the answer on and saves no copy of its list',
    /C\.rename\(from, target\)\)\.then\(ans => \{\s*_supAfterPORename\(from, target, ans \|\| \{\}\)/.test(renamed)
      && !/savePurchaseOrders\(\)/.test(renamed) && !/savePurchaseOrders\(\)/.test(afterRename) && !/_supCarryRenameToPOs/.test(SRC)
      && /ans\.po_ids/.test(afterRename) && /_poReread\(\)/.test(afterRename) && /if \(ans\.po_error\)[\s\S]*_showSaveError\(/.test(afterRename));
  assert('  a redraw waits while a new contact is typed but not added (its button would be replaced under the click)',
    /_supNewContactTyped\(root\)/.test(requireFn(SRC, '_supRedrawWhenIdle')) && /data-supc-new-field/.test(requireFn(SRC, '_supNewContactTyped')));
  assert('a contact saved on the Suppliers tab redraws only when nobody is typing there',
    /_supRedrawWhenIdle\(\)/.test(requireFn(SRC, '_supContactFieldChanged')) && !/renderSupplierTab\(\)/.test(requireFn(SRC, '_supContactFieldChanged')));
  assert('+ Add contact files the contact under the supplier shown beside it, not by list index',
    /const supplier = _supNameFor\(btn\)/.test(requireFn(SRC, '_supAddContact')));
  const pollPOs = requireFn(SRC, '_pollPurchaseOrders');
  assert('the PO list counts as loaded only once the list in hand is the server\'s',
    pollPOs.indexOf('_poLoadOk = true') > pollPOs.indexOf('JSON.stringify(incoming) === JSON.stringify(purchaseOrders)')
      && pollPOs.lastIndexOf('_poLoadOk = true') > pollPOs.indexOf('purchaseOrders = incoming;')
      && pollPOs.indexOf('_poLoadOk = true') < pollPOs.indexOf("if (_isEditing() && activeTab !== 'procurement') return;")
      && pollPOs.indexOf("if (_isEditing() && activeTab !== 'procurement') return;") > 0);
  assert('  and the sheet redraws when an unchanged list is first confirmed', /if \(!wasOk && activeTab === 'procurement'\) _procRerender\(\);/.test(pollPOs));
  // A list equal to the one in hand is that version (a rename the server made
  // and the page applied itself): kept on the old version, the next save of
  // the list looked stale, and the server merged back what it deleted.
  const eqPoll = pollPOs.slice(pollPOs.indexOf('JSON.stringify(incoming) === JSON.stringify(purchaseOrders)'), pollPOs.indexOf("if (_isEditing() && activeTab !== 'procurement') return;"));
  const eqReread = reread.slice(reread.indexOf('JSON.stringify(incoming) === JSON.stringify(purchaseOrders)'), reread.indexOf('const before = purchaseOrders;'));
  assert('  an unchanged list read back is taken with its version, by the poll and by a re-read alike',
    /_poTakeBase\(data\.updatedAt\)/.test(eqPoll) && /_poTakeBase\(data\.updatedAt\)/.test(eqReread));
  assert('  never an older version than the one held', /if \(at && !\(Date\.parse\(at\) < Date\.parse\(_poBaseUpdatedAt\)\)\) _poBaseUpdatedAt = at;/.test(requireFn(SRC, '_poTakeBase')));
  assert('  a list the server did send is no longer "could not be read", even while an edit holds it back',
    pollPOs.indexOf('_poLoadFailed = false') > pollPOs.indexOf('const data = await r.json();')
      && pollPOs.indexOf('_poLoadFailed = false') < pollPOs.indexOf("if (_isEditing() && activeTab !== 'procurement') return;"));
  const cfgFn = requireFn(SRC, '_procEnsureConfigured');
  assert('procurement.js can read the bid fresh, knows a failed PO read, and can check the supplier list',
    /getFreshBidLines: procFreshBidLines/.test(cfgFn) && /poLoadFailed: \(\) => _poLoadFailed/.test(cfgFn) && /isSupplierListed:/.test(cfgFn));
  assert('  the fresh bid read sends this page\'s pending bid edits first', /await _procFlushProjectSaves\(projId\)/.test(requireFn(SRC, 'procFreshBidLines')));
  assert('a PO number handed out and not saved yet is not handed out again',
    /_poNumbersOut/.test(requireFn(SRC, 'nextPONumber')) && /_poNumbersOut\.add\(number\)[\s\S]*finally \{\s*_poNumbersOut\.delete\(number\)/.test(requireFn(SRC, 'fctCreatePurchaseOrder')));
  assert('the contact ✕ is not a data-tab delete the page-wide handler would answer too',
    !/data-supc-del="[^"]*"[^>]*data-tab=/.test(SRC));
  assert('fctCreatePurchaseOrder sits outside the Daily Tracking → PO block the three pages share',
    SRC.indexOf('function fctCreatePurchaseOrder(') > SRC.indexOf('\nfunction _subCodeOpts(po) {')
      || SRC.indexOf('function fctCreatePurchaseOrder(') < SRC.indexOf('/* ── Daily Tracking → Purchase Orders'));
}

// ── 2 & 3. Booted ───────────────────────────────────────────────────────────
const USERS = {
  level1: { userId: 11, username: 'val', name: 'Val One',  companyCode: 'FCT', role: 'level1', isPlatformAdmin: false, divisionRoles: { turf: 'level1' }, allowedDivisions: ['turf'] },
  level2: { userId: 12, username: 'lou', name: 'Lou Two',  companyCode: 'FCT', role: 'level2', isPlatformAdmin: false, divisionRoles: { turf: 'level2' }, allowedDivisions: ['turf'] },
  admin:  { userId: 13, username: 'ada', name: 'Ada Admin', companyCode: 'FCT', role: 'admin',  isPlatformAdmin: false, divisionRoles: { turf: 'admin' },  allowedDivisions: ['turf'] },
  sales:  { userId: 14, username: 'sam', name: 'Sam Sales', companyCode: 'FCT', role: 'sales',  isPlatformAdmin: false, divisionRoles: { turf: 'sales' },  allowedDivisions: ['turf'] },
};

/**
 * Boot tracker.html as `user`. Every request goes through `routes`, a list of
 * (call) => response | null tried in order; anything unrouted gets the empty
 * success the other boot tests answer with. Every call is recorded.
 */
function boot(user) {
  const calls = [];
  const routes = [];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (/Not implemented: navigation/i.test(e.message || '')) return;
    errors.push(e.message);
  });
  const EMPTY = { ok: true, value: null, user: null, employees: [], jobs: [], entries: [], rows: [], groups: [] };
  const dom = new JSDOM(fs.readFileSync(root('tracker.html'), 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://datawatch.app/tracker.html',
    virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem('fct_token', 'harness');
      w.localStorage.setItem('fct_user', JSON.stringify(user));
      w.localStorage.setItem('fct_division', 'turf');
      w.fetch = (url, init) => {
        const call = { url: String(url), method: (init && init.method) || 'GET', body: null, init };
        try { call.body = init && init.body ? JSON.parse(init.body) : null; } catch { call.body = init.body; }
        calls.push(call);
        let res = null;
        for (const r of routes) { res = r(call); if (res) break; }
        if (!res) res = { status: 200, body: EMPTY };
        const status = res.status || 200;
        return Promise.resolve({
          ok: status >= 200 && status < 300, status,
          json: async () => JSON.parse(JSON.stringify(res.body)),
          text: async () => JSON.stringify(res.body),
        });
      };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      w.scrollTo = () => {};
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  return { dom, w: dom.window, calls, routes, errors };
}
const settle = (ms = 300) => new Promise(res => setTimeout(res, ms));
const shownTabs = doc => [...doc.querySelectorAll('.tab-btn[data-tab]')]
  .filter(b => b.style.display !== 'none').map(b => b.dataset.tab);

/** procurement.js into the booted window, as its <script defer> would put it. */
function loadModule(w) {
  w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
  return !!w.FCTProcurement;
}

/** A job with three bid lines, one of them moved by change orders. */
const JOB = {
  id: 'j1', 'project-name': 'Franklin Field', 'job-number': '26049', status: 'In Progress', dailyRows: [],
  bidItems: [
    { id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SY', quantity: '901.1',
      change_orders: [{ id: 'co1', date: '2026-10-01', qty_delta: '0.2', note: '' }, { id: 'co2', qty_delta: '48.7' }] },
    { id: 'b2', cost_code: 'Stormwater', sub_code: 'Inlet', unit: 'EA', quantity: '' },
    { id: 'b3', cost_code: 'General', sub_code: 'Mobilization', unit: 'LS', quantity: '1' },
    { id: 'b4', cost_code: 'Stormwater', sub_code: 'Pipe', unit: 'LF', quantity: '', change_orders: [{ qty_delta: '-12' }] },
  ],
};

(async () => {
  if (!fs.existsSync(MODULE_PATH)) {
    console.error('\nprocurement.js is missing — nothing to boot against.');
    process.exit(1);
  }

  // ── Who gets the tab ──
  for (const [level, expectTab, expectEdit] of [['level1', true, false], ['level2', true, true], ['admin', true, true], ['sales', false, false]]) {
    console.log(`\n[tracker.html booted as ${level}]`);
    const b = boot(USERS[level]);
    await settle();
    const doc = b.w.document;
    assert('boots without an error', b.errors.length === 0, b.errors[0]);
    const tabBtn = doc.querySelector('.tab-btn[data-tab="procurement"]');
    assert(expectTab ? 'the Procurement tab is in the bar' : 'the Procurement tab is hidden',
      expectTab ? shownTabs(doc).includes('procurement') : tabBtn.style.display === 'none', JSON.stringify(shownTabs(doc)));
    if (level === 'level1') {
      assert('  level1\'s bar, in order', JSON.stringify(shownTabs(doc)) === '["info","po","procurement","docs","trucking"]', JSON.stringify(shownTabs(doc)));
      assert('  and it still lands on the Project Dashboard', b.w.eval('activeTab') === 'info');
    }
    if (level === 'level2') {
      assert('  level2\'s bar, in order', JSON.stringify(shownTabs(doc)) === '["info","po","procurement","docs","trucking"]', JSON.stringify(shownTabs(doc)));
    }
    assert(`  _procCanEdit() is ${expectEdit}`, b.w.eval('_procCanEdit()') === expectEdit);

    // Before the deferred script runs, the pickers have nothing and the tab says it is loading.
    assert('  a proc_ picker offers nothing before procurement.js has run',
      JSON.stringify(b.w.eval("cbOptionsFor('proc_units')")) === '[]');
    if (expectTab) {
      tabBtn.click();
      assert('  the tab says it is loading while the module is not there',
        /Loading Procurement/.test(doc.getElementById('procurement-root').textContent));
    }

    assert('  procurement.js loads into the page', loadModule(b.w));
    let cfg = null;
    const orig = b.w.FCTProcurement.configure;
    b.w.FCTProcurement.configure = c => { cfg = c; return orig.call(b.w.FCTProcurement, c); };
    // projectsList is the page's own; the job is put on it as the poll would.
    b.w.eval(`projectsList.push(${JSON.stringify(JOB)})`);

    if (expectTab) {
      await settle(250);   // the bounded wait picks the module up on its next tick
      const mount = doc.getElementById('procurement-root');
      assert('  once it has, the sheet is drawn into #procurement-root', !!mount.querySelector('.fctproc'), mount.innerHTML.slice(0, 200));
      assert('  configured for turf', cfg && cfg.division === 'turf' && cfg.apiBase === '/api');
      assert(`  with canView true and canEdit ${expectEdit}`,
        cfg && cfg.perm && cfg.perm.canView === true && cfg.perm.canEdit === expectEdit, cfg && JSON.stringify(cfg.perm));
      assert('  and the page\'s token, user name and local date',
        cfg && cfg.getToken() === 'harness' && cfg.getUserName() === USERS[level].name
          && /^\d{4}-\d{2}-\d{2}$/.test(cfg.today()) && cfg.today() === b.w.eval('_localDateStr()'));
      assert('  the job list and lookup are the page\'s',
        cfg && cfg.getProjects().some(p => p.id === 'j1') && cfg.getProject('j1')['job-number'] === '26049');
      assert('  codes compare the way the page compares them',
        cfg && cfg.codeKey('Storm–Water  ') === b.w.eval("_codeKey('storm-water')"));
      assert('  the PO list counts as loaded once it has been read', cfg && cfg.isPOListLoaded() === true);
      assert('  a remembered job is kept per division', cfg && cfg.storage === b.w.localStorage);
      assert('  proc_ pickers now come from the module',
        JSON.stringify(b.w.eval("cbOptionsFor('proc_units')")).includes('"LF"'));
      const filt = b.w.eval("cbFilterFor('proc_vendors', 'Brand New Co', cbOptionsFor('proc_vendors'))");
      assert('  and the vendor filter offers to add a new supplier',
        filt.some(o => o && o.value === '__new__:Brand New Co'), JSON.stringify(filt));
    } else {
      assert('  clicking a hidden tab draws nothing', (() => { b.w.eval('renderProcurementTab()'); return doc.getElementById('procurement-root').innerHTML === ''; })());
    }

    // The bid page's button.
    b.w.eval("openBidView('j1')");
    const sendBtn = doc.getElementById('bid-fs-procurement');
    assert(expectEdit ? '  the bid page shows Send to Procurement' : '  the bid page hides Send to Procurement',
      expectEdit ? sendBtn.style.display === '' : sendBtn.style.display === 'none', sendBtn.style.display);
    if (expectEdit) {
      let opened = null;
      b.w.FCTProcurement.openSendModal = pid => { opened = pid; return null; };
      sendBtn.click();
      assert('  which opens the checklist for that job', opened === 'j1');
      // After a send the page lands on the tab, closing the bid page.
      b.w.dispatchEvent(new b.w.CustomEvent('fct:procurement-sent', { detail: { projectId: 'j1' } }));
      assert('  a send closes the bid page', doc.getElementById('bid-fullscreen').style.display === 'none' && b.w.eval('bidViewProjId') === null);
      assert('  and switches to the Procurement tab',
        b.w.eval('activeTab') === 'procurement' && doc.getElementById('tab-procurement').classList.contains('active'));
    } else {
      b.w.eval('closeBidView()');
    }

    if (level === 'admin') await runAdminChecks(b, cfg);
    b.w.close();
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });

async function runAdminChecks(b, cfg) {
  const { w, calls, routes } = b;

  // ── Bid lines ──
  console.log('\n[the bid lines handed to the sheet]');
  {
    const lines = cfg.getBidLines('j1');
    const by = Object.fromEntries(lines.map(l => [l.id, l]));
    assert('one per bid item', lines.length === 4, JSON.stringify(lines));
    assert('the quantity is the Bid Qty column\'s: base plus every change order', by.b1 && by.b1.quantity === 950);
    assert('  rounded, so 901.1 + 0.2 + 48.7 is not 950.0000000000001', by.b1 && String(by.b1.quantity) === '950');
    assert('a blank quantity with no change orders is null, not 0', by.b2 && by.b2.quantity === null);
    assert('a blank quantity a change order moved counts from zero', by.b4 && by.b4.quantity === -12);
    assert('codes and unit come straight off the bid',
      by.b1.cost_code === 'Stormwater' && by.b1.sub_code === 'Geofabric' && by.b1.unit === 'SY' && by.b3.unit === 'LS');
    assert('index is the place on the bid', by.b1.index === 0 && by.b2.index === 1 && by.b3.index === 2 && by.b4.index === 3);
    assert('an unknown job has none', JSON.stringify(cfg.getBidLines('nope')) === '[]');
    // A damaged blob: a null entry and one with no id are skipped, and the
    // lines after them keep their real place on the bid.
    w.eval(`projectsList.push({ id: 'j2', 'project-name': 'Odd', bidItems: [null, { cost_code: 'X', quantity: '3' }, { id: 7, sub_code: 'Y', quantity: ' 4 ' }] })`);
    const odd = cfg.getBidLines('j2');
    assert('entries with no id are skipped, the rest keep their index',
      odd.length === 1 && odd[0].id === '7' && odd[0].index === 2 && odd[0].quantity === 4 && odd[0].cost_code === '', JSON.stringify(odd));
    w.eval(`projectsList = projectsList.filter(p => p.id !== 'j2')`);
  }

  // ── After a Procore import ──
  console.log('\n[after a Procore import]');
  {
    let opened = [];
    w.FCTProcurement.openSendModal = pid => { opened.push(pid); return null; };
    let asked = 0;
    w.confirm = () => { asked++; return false; };
    w.eval("_procOfferSendAfterImport('j1')");
    assert('the user is asked, and "no" sends nothing', asked === 1 && opened.length === 0);
    w.confirm = () => true;
    w.eval("_procOfferSendAfterImport('j1')");
    assert('"yes" opens the checklist for the job', JSON.stringify(opened) === '["j1"]');
    w.eval(`projectsList.push({ id: 'j3', 'project-name': 'Empty', bidItems: [] })`);
    asked = 0;
    w.confirm = () => { asked++; return true; };
    w.eval("_procOfferSendAfterImport('j3')");
    assert('a job left with no bid lines is not offered', asked === 0 && opened.length === 1);
    w.confirm = () => true;
  }

  assert('the page exposes fctAddSupplier and fctCreatePurchaseOrder on window',
    typeof w.fctAddSupplier === 'function' && typeof w.fctCreatePurchaseOrder === 'function' && typeof w.openPurchaseOrder === 'function');

  // ── Purchase orders ──
  console.log('\n[Create PO from selected rows]');
  {
    let posted = null;
    routes.unshift(c => {
      if (c.method === 'POST' && /\/api\/purchase-orders\?division=turf$/.test(c.url)) {
        posted = c.body;
        return { status: 200, body: { ok: true, purchaseOrder: { ...c.body.purchaseOrder, created_at: 'server-stamp' } } };
      }
      return null;
    });
    const before = w.eval('purchaseOrders.length');
    const po = await cfg.createPurchaseOrder({
      project_id: 'j1', cost_code: 'Stormwater', sub_code: 'Geofabric', supplier: 'Acme Supply', title: 'Geofabric', notes: 'Quote Q-17',
    });
    assert('one order is POSTed on its own, never a whole-list PUT',
      posted && posted.purchaseOrder && !calls.some(c => c.method === 'PUT' && /purchase-orders/.test(c.url)));
    const sent = posted && posted.purchaseOrder;
    assert('  seeded from the rows', sent && sent.project_id === 'j1' && sent.cost_code === 'Stormwater' && sent.sub_code === 'Geofabric'
      && sent.supplier === 'Acme Supply' && sent.title === 'Geofabric' && sent.notes === 'Quote Q-17', JSON.stringify(sent));
    assert('  numbered, pending, dated today, stamped, with no lines yet',
      sent && /^PO-\d{4}$/.test(sent.po_number) && sent.status === 'pending' && sent.date_created === w.eval('_localDateStr()')
        && sent.created_by === 'Ada Admin' && Array.isArray(sent.lines) && sent.lines.length === 0, JSON.stringify(sent));
    assert('resolves to the order as the server stored it', po && po.created_at === 'server-stamp' && po.id === sent.id);
    assert('  which joins the page\'s list', w.eval('purchaseOrders.length') === before + 1
      && w.eval(`purchaseOrders.some(p => p.id === ${JSON.stringify(sent.id)})`));
    assert('  and the sheet sees it', cfg.getPurchaseOrders().some(p => p.id === sent.id && p.po_number === sent.po_number));
    assert('  as a copy, so the sheet cannot edit the list the PO tab saves',
      (() => { const c = cfg.getPurchaseOrders().find(p => p.id === sent.id); c.title = 'changed'; return w.eval(`purchaseOrders.find(p => p.id === ${JSON.stringify(sent.id)}).title`) === 'Geofabric'; })());

    // Opening it on the Purchase Orders tab.
    w.eval("poFilters = { status: new Set(['closed']) }");
    cfg.openPurchaseOrder(sent.id);
    assert('opening the order switches to the Purchase Orders tab', w.eval('activeTab') === 'po');
    assert('  searched down to its number, with the filters cleared',
      w.eval('poSearch') === sent.po_number && w.eval('Object.keys(poFilters).length') === 0 && w.eval('poPage') === 0);
    assert('  and its lines open', w.eval(`_poExpanded.has(${JSON.stringify(sent.id)})`));

    // A refusal comes back as null, with the reason in the banner.
    routes.unshift(c => (c.method === 'POST' && /purchase-orders/.test(c.url) ? { status: 409, body: { error: 'Conflict', detail: 'Lost the race.' } } : null));
    const n = w.eval('purchaseOrders.length');
    const none = await cfg.createPurchaseOrder({ project_id: 'j1' });
    assert('a refused save resolves to null and adds nothing', none === null && w.eval('purchaseOrders.length') === n);
    assert('  with the server\'s reason on the banner', /Lost the race/.test(w.document.getElementById('save-error-msg').textContent));
    routes.shift();

    // Not against a list that never loaded: the number would collide.
    w.eval('_poLoadOk = false');
    const postsBefore = calls.filter(c => c.method === 'POST' && /purchase-orders/.test(c.url)).length;
    const refused = await cfg.createPurchaseOrder({ project_id: 'j1' });
    assert('refused while the order list has not loaded', refused === null
      && calls.filter(c => c.method === 'POST' && /purchase-orders/.test(c.url)).length === postsBefore);
    assert('  and the sheet is told the list is not loaded', cfg.isPOListLoaded() === false);
    w.eval('_poLoadOk = true');
  }

  // ── Suppliers ──
  console.log('\n[+ Add as new supplier]');
  {
    let server = {
      value: { suppliers: [{ name: 'Acme Supply', state: 'PA', address: '', phone: '', website: '' }], employees: [{ name: 'Jo', non_prevailing_rate: 31 }], cost_codes: [] },
      updated_at: '2026-11-16T10:00:00.000Z',
    };
    let puts = [];
    let conflictOnce = false;
    routes.unshift(c => {
      if (!/\/api\/data\/fct_lists$/.test(c.url)) return null;
      if (c.method === 'GET') return { status: 200, body: server };
      if (c.method === 'PUT') {
        puts.push(c.body);
        if (conflictOnce) {
          conflictOnce = false;
          // Someone saved an employee in between: the blob moved on.
          server = { value: { ...server.value, employees: server.value.employees.concat([{ name: 'Kim', non_prevailing_rate: 29 }]) },
                     updated_at: '2026-11-16T10:00:05.000Z' };
          return { status: 409, body: { error: 'Conflict', detail: 'changed' } };
        }
        if (c.body.baseUpdatedAt && c.body.baseUpdatedAt !== server.updated_at) return { status: 409, body: { error: 'Conflict' } };
        server = { value: c.body.value, updated_at: new Date(Date.parse(server.updated_at) + 1000).toISOString() };
        return { status: 200, body: { ok: true } };
      }
      return null;
    });
    // The page's copy as the lists poll would leave it.
    w.eval(`lists.suppliers = [{ name: 'Acme Supply', state: 'PA', address: '', phone: '', website: '' }]`);

    let name = await cfg.addSupplier('  acme   supply ');
    assert('a name already on the list resolves to it, case-insensitively, with no save',
      name === 'Acme Supply' && puts.length === 0);

    server.value.suppliers.push({ name: 'Bolt Bros', state: '', address: '', phone: '', website: '' });
    name = await cfg.addSupplier('BOLT BROS');
    assert('one someone else just added is found in the fresh read and not added twice',
      name === 'Bolt Bros' && puts.length === 0 && w.eval("lists.suppliers.some(s => s.name === 'Bolt Bros')"));

    conflictOnce = true;
    name = await cfg.addSupplier('Cobalt Aggregates');
    assert('a new name is saved and resolves to itself', name === 'Cobalt Aggregates');
    assert('  each save carries the updated_at it read, as baseUpdatedAt',
      puts.length === 2 && puts[0].baseUpdatedAt === '2026-11-16T10:00:00.000Z' && puts[1].baseUpdatedAt === '2026-11-16T10:00:05.000Z',
      JSON.stringify(puts.map(p => p.baseUpdatedAt)));
    assert('  a 409 re-reads and retries, so the employee saved in between survives',
      puts[1].value.employees.some(e => e.name === 'Kim') && server.value.employees.some(e => e.name === 'Kim'));
    assert('  the supplier goes on as a full entry',
      JSON.stringify(server.value.suppliers.find(s => s.name === 'Cobalt Aggregates')) === JSON.stringify({ name: 'Cobalt Aggregates', state: '', address: '', phone: '', website: '' }));
    assert('  and the page takes on the saved copy',
      w.eval("lists.suppliers.some(s => s.name === 'Cobalt Aggregates') && lists.employees.some(e => e.name === 'Kim')"));
    assert('  which the vendor picker offers at once', cfg.getSuppliers().includes('Cobalt Aggregates'));

    // Two rows adding one new name at once: queued, so it is added once.
    puts = [];
    const [a, b2] = await Promise.all([cfg.addSupplier('Delta Stone'), cfg.addSupplier('delta stone')]);
    assert('two adds of one new name at once save it once', a === 'Delta Stone' && b2 === 'Delta Stone' && puts.length === 1,
      `${a} / ${b2} / ${puts.length} saves`);

    // Every retry refused: give up, and take it back off the page's copy.
    routes.unshift(c => (c.method === 'PUT' && /fct_lists$/.test(c.url) ? (puts.push(c.body), { status: 409, body: { error: 'Conflict' } }) : null));
    puts = [];
    let err = null;
    try { await cfg.addSupplier('Echo Sand'); } catch (e) { err = e; }
    assert('a save that keeps conflicting gives up after three retries', err && puts.length === 4, `${puts.length} saves`);
    assert('  and the name is not left on the page\'s copy', w.eval("!lists.suppliers.some(s => s.name === 'Echo Sand')"));
    routes.shift();

    // A page whose lists never loaded holds only the empty defaults.
    w.eval('_listsLoaded = false');
    const getsBefore = calls.filter(c => /fct_lists$/.test(c.url)).length;
    err = null;
    try { await cfg.addSupplier('Foxtrot Fill'); } catch (e) { err = e; }
    assert('refused while the lists have not loaded, without a request',
      err && calls.filter(c => /fct_lists$/.test(c.url)).length === getsBefore);
    w.eval('_listsLoaded = true');
  }

  // ── Suppliers tab ──
  console.log('\n[Suppliers tab — search and contacts]');
  {
    const contacts = [
      { id: 'c1', supplier_name: 'acme supply', name: 'Dave Ruiz', email: 'dave@acme.test', phone: '412-555-0100', updated_at: null },
    ];
    const posts = [], renames = [];
    let renameAnswer = { ok: true, moved: 1 };
    routes.unshift(c => {
      if (!/\/api\/supplier-contacts/.test(c.url)) return null;
      if (c.method === 'GET') return { status: 200, body: { ok: true, contacts, canEdit: true } };
      if (c.method === 'POST' && /action=rename/.test(c.url)) { renames.push(c.body); return { status: 200, body: renameAnswer }; }
      if (c.method === 'POST') {
        posts.push(c.body);
        const made = { id: 'c' + (contacts.length + 1), ...c.body, updated_at: null };
        contacts.push(made);
        return { status: 201, body: { ok: true, contact: made, existed: false } };
      }
      return null;
    });
    w.eval(`lists.suppliers = [
      { name: 'Acme Supply', state: 'PA', address: '1 Mill Rd', phone: '', website: '' },
      { name: 'Bolt Bros', state: '', address: '', phone: '724-555-0199', website: '' },
    ]`);
    w.eval("adminSwitchTab('supplier')");
    await settle(100);
    const doc = w.document;
    const rows = () => [...doc.querySelectorAll('#supplier-root tbody tr')].filter(tr => tr.querySelector('[data-sup-field="name"]'));
    assert('both suppliers are listed', rows().length === 2);
    const listPuts = () => calls.filter(c => c.method === 'PUT' && /fct_lists$/.test(c.url)).length;
    const putsAtSearch = listPuts();
    const box = doc.getElementById('sup-search');
    box.value = 'dave@';
    box.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert('searching a contact\'s email finds its supplier',
      rows().length === 1 && rows()[0].querySelector('[data-sup-field="name"]').value === 'Acme Supply');
    assert('  and the box keeps the focus', doc.activeElement && doc.activeElement.id === 'sup-search');
    assert('  and the keystroke is not taken for a supplier edit and saved', listPuts() === putsAtSearch);
    const box2 = doc.getElementById('sup-search');
    box2.value = '0199';
    box2.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert('searching a phone number finds that supplier', rows().length === 1 && rows()[0].querySelector('[data-sup-field="name"]').value === 'Bolt Bros');
    const box3 = doc.getElementById('sup-search');
    box3.value = '';
    box3.dispatchEvent(new w.Event('input', { bubbles: true }));

    doc.querySelector('[data-supc-toggle="0"]').click();
    const contactRow = doc.querySelector('#supplier-root .sup-contacts-row');
    assert('the contacts open under the supplier', contactRow && /dave@acme\.test/.test(contactRow.innerHTML));
    const nameIn = contactRow.querySelector('[data-supc-new-field="name"]');
    const emailIn = contactRow.querySelector('[data-supc-new-field="email"]');
    nameIn.value = '<b>Pat</b>';
    emailIn.value = 'pat@acme.test';
    contactRow.querySelector('[data-supc-add="0"]').click();
    await settle(50);
    assert('+ Add contact saves it under the supplier',
      posts.length === 1 && posts[0].supplier_name === 'Acme Supply' && posts[0].name === '<b>Pat</b>' && posts[0].email === 'pat@acme.test');
    const listed = doc.querySelector('#supplier-root .sup-contacts-row');
    assert('  and it is listed, its name kept as text rather than markup',
      [...listed.querySelectorAll('[data-supc-field="name"]')].some(i => i.value === '<b>Pat</b>') && !listed.querySelector('b'));
    const putsBefore = calls.filter(c => c.method === 'PUT' && /fct_lists/.test(c.url)).length;
    const cIn = doc.querySelector('[data-supc-id="c1"][data-supc-field="phone"]');
    cIn.value = '412-555-0111';
    cIn.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert('typing in a contact box is not taken for a supplier edit',
      calls.filter(c => c.method === 'PUT' && /fct_lists/.test(c.url)).length === putsBefore);

    // Renaming the supplier carries its contacts.
    const supName = doc.querySelector('[data-sup-idx="0"][data-sup-field="name"]');
    supName.dispatchEvent(new w.FocusEvent('focusin', { bubbles: true }));
    supName.value = 'Acme Supply Co';
    supName.dispatchEvent(new w.Event('input', { bubbles: true }));
    supName.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(50);
    assert('renaming a supplier moves its contacts to the new name',
      renames.length === 1 && renames[0].from === 'Acme Supply' && renames[0].to === 'Acme Supply Co', JSON.stringify(renames));

    // Renamed by first clearing the box, leaving it, and coming back: the
    // rename still goes from the last real name.
    const nameBox = () => doc.querySelector('[data-sup-idx="0"][data-sup-field="name"]');
    const typeName = async (v, leave = true) => {
      const el = nameBox();
      el.dispatchEvent(new w.FocusEvent('focusin', { bubbles: true }));
      el.value = v;
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      if (leave) el.dispatchEvent(new w.Event('change', { bubbles: true }));
      await settle(50);
    };
    renames.length = 0;
    await typeName('');
    assert('a name box left blank renames nothing yet', renames.length === 0, JSON.stringify(renames));
    assert('  and gets its last real name back', nameBox().value === 'Acme Supply Co' && w.eval('lists.suppliers[0].name') === 'Acme Supply Co', nameBox().value);
    await typeName('Acme Supply Group');
    assert('  the name typed next renames from the last real one',
      renames.length === 1 && renames[0].from === 'Acme Supply Co' && renames[0].to === 'Acme Supply Group', JSON.stringify(renames));

    // The rename reaches the purchase orders too, so Procurement still
    // matches its rows to them.
    const poPuts = () => calls.filter(c => c.method === 'PUT' && /\/api\/purchase-orders/.test(c.url));
    w.eval(`purchaseOrders = [{ id: 'po7', po_number: 'PO-0007', supplier: 'acme supply group', project_id: '', cost_code: '', sub_code: '', status: 'pending', lines: [] },
      { id: 'po8', po_number: 'PO-0008', supplier: 'Bolt Bros', project_id: '', cost_code: '', sub_code: '', status: 'pending', lines: [] }]; _poLoadOk = true;`);
    renames.length = 0;
    const putsAtRename = poPuts().length;
    // The server renames the orders naming it and says which (po_ids); the
    // page then reads the stored list again.
    renameAnswer = { ok: true, moved: 1, pos: 1, po_ids: ['po7'] };
    const storedPOs = { purchaseOrders: [{ id: 'po7', po_number: 'PO-0007', supplier: 'Acme Group', project_id: '', cost_code: '', sub_code: '', status: 'approved', lines: [] },
      { id: 'po8', po_number: 'PO-0008', supplier: 'Bolt Bros', project_id: '', cost_code: '', sub_code: '', status: 'pending', lines: [] }], updatedAt: '2026-11-16T10:00:00.000Z' };
    routes.unshift(c => (c.method === 'GET' && /\/api\/purchase-orders/.test(c.url) ? { status: 200, body: storedPOs } : null));
    await typeName('Acme Group');
    assert('  a rename carries over to the purchase orders naming the supplier — the ones the server renamed',
      w.eval("purchaseOrders.find(p => p.id === 'po7').supplier") === 'Acme Group'
      && w.eval("purchaseOrders.find(p => p.id === 'po8').supplier") === 'Bolt Bros',
      w.eval('JSON.stringify(purchaseOrders.map(p => p.supplier))'));
    assert('  …without the page saving its copy of the order list', poPuts().length === putsAtRename, poPuts().length - putsAtRename);
    await settle(50);
    assert('  …and the stored list, read again, is taken on with its version', w.eval("purchaseOrders.find(p => p.id === 'po7').status") === 'approved'
      && w.eval('_poBaseUpdatedAt') === '2026-11-16T10:00:00.000Z', w.eval('JSON.stringify(purchaseOrders)'));
    routes.shift();
    renameAnswer = { ok: true, moved: 1 };

    // Renamed to another supplier's name: asked first.
    renames.length = 0;
    w.confirm = () => false;
    await typeName('Bolt Bros');
    assert('renaming onto another supplier asks first, and Cancel puts the name back',
      renames.length === 0 && nameBox().value === 'Acme Group'
      && w.eval("lists.suppliers.map(s => s.name).join('|')") === 'Acme Group|Bolt Bros', w.eval("lists.suppliers.map(s => s.name).join('|')"));
    w.confirm = () => true;
    await typeName('bolt bros');
    assert('  and OK merges them: one entry left, its contacts and rows moved',
      renames.length === 1 && renames[0].from === 'Acme Group' && renames[0].to === 'Bolt Bros'
      && w.eval("lists.suppliers.map(s => s.name).join('|')") === 'Bolt Bros', w.eval("lists.suppliers.map(s => s.name).join('|')"));
    routes.shift();
  }
}
