#!/usr/bin/env node
'use strict';
/**
 * The sales access level, for turf and paving.
 *
 * Run: node scripts/test-sales-role.js
 *
 * Salesmen follow the jobs they sold — the Schedule, Purchase Orders,
 * Documents, Trucking — and work out of the CRM. They do not see what a job
 * costs. Those are the two halves checked here, in every place the level has
 * to be understood:
 *
 *   1. api/lib/auth.js        — sales reaches the division, and is view-only
 *   2. api/company/users.js   — it can be granted on turf and paving and
 *                               nowhere else, and never breaks users.role
 *   3. divisions.html         — Manage Users offers it on exactly those two
 *   4. paving.html, tracker.html — booted in a real DOM as a salesman: the
 *                               tabs he gets, and the cost surfaces he does not
 *   5. Mathis                 — the chat window does not hand back the job
 *                               costs his screen withholds
 */

const fs   = require('fs');
const path = require('path');
const jwt  = require('jsonwebtoken');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = (...p) => path.resolve(__dirname, '..', ...p);

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '\n      ' + String(detail).slice(0, 400) : ''}`); }
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// The database driver is replaced in the cache before anything that uses it
// is loaded; its exports are getter-only, so it cannot be mutated in place.
let sqlImpl = () => Promise.resolve([]);
const neonPath = require.resolve('@neondatabase/serverless');
require.cache[neonPath] = {
  id: neonPath, filename: neonPath, loaded: true,
  exports: { neon: () => (...args) => sqlImpl(...args) },
};

const auth = require(root('api/lib/auth.js'));

(async () => {
  // ── 1. auth.js ────────────────────────────────────────────────────────────
  console.log('\n[api/lib/auth.js]');
  {
    const sales = { role: 'sales', divisionRoles: { turf: 'sales', paving: 'sales' }, isPlatformAdmin: false };
    assert('sales reaches paving and turf', auth.hasDivisionAccess(sales, 'paving') && auth.hasDivisionAccess(sales, 'turf'));
    assert('  and nothing it was not granted', !auth.hasDivisionAccess(sales, 'kiewit'));
    const caps = auth.capabilities(sales, 'paving');
    assert('it is view-only: no upload, manage or delete',
      caps.level === 'sales' && !caps.canUpload && !caps.canManage && !caps.canDelete, JSON.stringify(caps));
    assert('isSalesIn names it', auth.isSalesIn(sales, 'paving') && auth.isSalesIn(sales, 'turf'));
    assert('  per division — a salesman on paving can hold full turf',
      !auth.isSalesIn({ role: 'level3', divisionRoles: { turf: 'level3', paving: 'sales' } }, 'turf'));
    assert('  and a platform admin is never narrowed to it',
      !auth.isSalesIn({ role: 'sales', divisionRoles: { paving: 'sales' }, isPlatformAdmin: true }, 'paving'));
    assert('offered for turf and paving only', JSON.stringify(auth.SALES_DIVISIONS) === '["turf","paving"]');
  }

  // ── 2. api/company/users.js ──────────────────────────────────────────────
  console.log('\n[api/company/users.js]');
  {
    const handler = require(root('api/company/users.js'));
    const adminToken = jwt.sign({ userId: 1, companyCode: 'FCT', role: 'admin', divisionRoles: { turf: 'admin' } }, process.env.JWT_SECRET);
    const sent = [];
    sqlImpl = (strings, ...values) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      sent.push({ text, values });
      if (/^SELECT id FROM users/.test(text)) return Promise.resolve([{ id: 7 }]); // existing user → role-only update
      return Promise.resolve([]);
    };
    const call = async body => {
      const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
      await handler({ method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body }, res);
      return res;
    };

    sent.length = 0;
    let r = await call({ username: 'sam', division_roles: { turf: 'sales', paving: 'sales', kiewit: 'no_access' } });
    assert('sales is accepted on turf and paving', r.statusCode === 200 && r.body && r.body.ok, JSON.stringify(r.body));
    const upd = sent.find(q => /^UPDATE users/.test(q.text));
    assert('  the legacy users.role column gets level1, inside its CHECK constraint',
      upd && upd.values[0] === 'level1', upd && JSON.stringify(upd.values));
    assert('  while division_roles keeps the real grant',
      upd && /"paving":"sales"/.test(String(upd.values[2])), upd && String(upd.values[2]));

    sent.length = 0;
    r = await call({ username: 'sam', division_roles: { turf: 'no_access', paving: 'sales' } });
    const upd2 = sent.find(q => /^UPDATE users/.test(q.text));
    assert('paving-only sales also stores level1', upd2 && upd2.values[0] === 'level1', upd2 && JSON.stringify(upd2.values));

    for (const div of ['kiewit', 'dust', 'trucking', 'scheduler', 'purchase_orders']) {
      sent.length = 0;
      r = await call({ username: 'sam', division_roles: { turf: 'level3', [div]: 'sales' } });
      assert(`sales on ${div} is refused`, r.statusCode === 400 && /only available for turf and paving/.test(r.body.error)
        && !sent.some(q => /^UPDATE|^INSERT/.test(q.text)), JSON.stringify(r.body));
    }
    sqlImpl = () => Promise.resolve([]);
  }

  // ── 3. divisions.html ────────────────────────────────────────────────────
  console.log('\n[divisions.html — Manage Users]');
  {
    const src = fs.readFileSync(root('divisions.html'), 'utf8');
    const selectFor = k => {
      const at = src.indexOf(`<select id="mu-role-${k}">`);
      return at < 0 ? '' : src.slice(at, src.indexOf('</select>', at));
    };
    assert('Turf offers the Sales level', /<option value="sales">/.test(selectFor('turf')));
    assert('Paving offers the Sales level', /<option value="sales">/.test(selectFor('paving')));
    const others = ['dust', 'kiewit', 'trucking', 'quarry', 'intercompany', 'executive', 'scheduler', 'purchase_orders'];
    const leaking = others.filter(k => /value="sales"/.test(selectFor(k)));
    assert('  no other division does', leaking.length === 0, leaking.join(', '));
    assert('the user table labels it', /sales:\s+'Sales',/.test(src));
    assert('the level filter can find it', /<option value="sales">Sales<\/option>/.test(src));
  }

  // ── 4. The two pages, booted as a salesman ───────────────────────────────
  function boot(file, user, division) {
    const html = fs.readFileSync(root(file), 'utf8');
    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => {
      if (/Not implemented: navigation/i.test(e.message || '')) { errors.navigated = true; return; }
      errors.push(e.message);
    });
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      url: 'https://datawatch.app/' + file,
      virtualConsole: vc,
      beforeParse(w) {
        w.localStorage.setItem('fct_token', 'harness');
        w.localStorage.setItem('fct_user', JSON.stringify(user));
        w.localStorage.setItem('fct_division', division);
        w.fetch = () => Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ ok: true, value: null, user: null, employees: [], jobs: [], entries: [], rows: [], groups: [] }),
          text: async () => '',
        });
        w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
        w.scrollTo = () => {};
        w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
        w.HTMLCanvasElement.prototype.getContext = () => null;
      },
    });
    return { dom, errors };
  }
  const settle = () => new Promise(res => setTimeout(res, 300));
  const shownTabs = doc => [...doc.querySelectorAll('.tab-btn[data-tab]')]
    .filter(b => b.style.display !== 'none').map(b => b.dataset.tab);
  const hidden = el => !el || el.style.display === 'none';

  const SALES = {
    userId: 2, username: 'sam', companyCode: 'FCT', role: 'sales', isPlatformAdmin: false,
    divisionRoles: { turf: 'sales', paving: 'sales' }, allowedDivisions: ['turf', 'paving'],
  };

  for (const { file, division, expect } of [
    { file: 'paving.html',  division: 'paving', expect: ['schedule', 'po', 'docs', 'trucking', 'crm'] },
    { file: 'tracker.html', division: 'turf',   expect: ['po', 'docs', 'trucking', 'crm'] },
  ]) {
    console.log(`\n[${file} — sales]`);
    const { dom, errors } = boot(file, SALES, division);
    await settle();
    const doc = dom.window.document;
    assert('boots without an error', errors.length === 0, errors[0]);
    assert(`shows exactly ${expect.join(', ')}`,
      JSON.stringify(shownTabs(doc)) === JSON.stringify(expect), JSON.stringify(shownTabs(doc)));
    for (const t of ['cost', 'info', 'home']) {
      const b = doc.querySelector(`.tab-btn[data-tab="${t}"]`);
      assert(`  ${t === 'cost' ? 'Cost Tracking' : t === 'info' ? 'Project Dashboard' : 'Home'} is hidden`, hidden(b));
    }
    assert('  Analytics is hidden', hidden(doc.querySelector('.analytics-dropdown-wrap')));
    assert('  Admin is hidden', hidden(doc.querySelector('.admin-dropdown-wrap')));
    const mob = doc.querySelector('.tab-btn[data-tab="mob-entry"]');
    assert('  Daily Entry stays hidden even on a phone, over the stylesheet\'s !important',
      mob && mob.style.display === 'none' && mob.style.getPropertyPriority('display') === 'important');
    assert('lands on the Schedule', doc.getElementById('tab-schedule').classList.contains('active')
      && !doc.getElementById('tab-cost').classList.contains('active')
      && !doc.getElementById('tab-home').classList.contains('active'));
    // The picker is mounted by renderScheduleTab itself; the markup ships the
    // mount empty, so a filled one proves the boot rendered the landing tab.
    const mount = doc.getElementById('sched-proj-cb-mount');
    assert('  and the Schedule is rendered there, not left blank',
      mount && mount.children.length > 0, mount && mount.outerHTML.slice(0, 120));
    const hdr = doc.getElementById('header-actions').innerHTML;
    assert('no Daily Summary report (it prints labor and equipment dollars)', hdr && !/Daily Summary/.test(hdr), hdr.slice(0, 200));
    assert('  the Sign-In Sheet is still there', /Sign-In Sheet/.test(hdr));
    assert('nothing is editable in POs or Trucking', dom.window.eval('perm.canEdit') === false);
    if (file === 'tracker.html') {
      assert('both schedules are offered',
        !hidden(doc.querySelector('.schedules-dropdown-wrap'))
          && !hidden(doc.getElementById('schedules-item-schedule'))
          && !hidden(doc.getElementById('schedules-item-construction')));
      assert('  Infill Inventory is not', hidden(doc.querySelector('.tab-btn[data-tab="inventory"]')));
    }
    dom.window.close();
  }

  // The level is read per division. Before this, paving read fctUser.role —
  // the TURF grant — so a salesman there who held anything on turf got it.
  console.log('\n[paving.html — the level is paving\'s own]');
  {
    const mixed = {
      userId: 3, username: 'pat', companyCode: 'FCT', role: 'level3', isPlatformAdmin: false,
      divisionRoles: { turf: 'level3', paving: 'sales' }, allowedDivisions: ['turf', 'paving'],
    };
    let r = boot('paving.html', mixed, 'paving');
    await settle();
    assert('turf level3 + paving sales gets the sales tabs on paving',
      JSON.stringify(shownTabs(r.dom.window.document)) === '["schedule","po","docs","trucking","crm"]',
      JSON.stringify(shownTabs(r.dom.window.document)));
    r.dom.window.close();

    r = boot('tracker.html', mixed, 'turf');
    await settle();
    assert('  and still everything on turf', r.dom.window.eval('perm.visibleTabs') === null);
    r.dom.window.close();

    const legacy = { userId: 4, username: 'lee', companyCode: 'FCT', role: 'level1', isPlatformAdmin: false, divisionRoles: null, allowedDivisions: ['turf', 'paving'] };
    r = boot('paving.html', legacy, 'paving');
    await settle();
    assert('a legacy token with no per-division map keeps its flat role',
      JSON.stringify(shownTabs(r.dom.window.document)) === '["info","po","docs","trucking"]',
      JSON.stringify(shownTabs(r.dom.window.document)));
    r.dom.window.close();

    const lvl1 = { userId: 5, username: 'val', companyCode: 'FCT', role: 'level1', isPlatformAdmin: false, divisionRoles: { turf: 'level1', paving: 'level1' }, allowedDivisions: ['turf', 'paving'] };
    r = boot('paving.html', lvl1, 'paving');
    await settle();
    const d = r.dom.window.document;
    assert('level1 is unchanged: its four tabs, Analytics menu and Daily Summary',
      JSON.stringify(shownTabs(d)) === '["info","po","docs","trucking"]'
        && !hidden(d.querySelector('.analytics-dropdown-wrap'))
        && /Daily Summary/.test(d.getElementById('header-actions').innerHTML),
      JSON.stringify(shownTabs(d)));
    assert('  and keeps Daily Entry on a phone', d.querySelector('.tab-btn[data-tab="mob-entry"]').style.getPropertyPriority('display') !== 'important');
    r.dom.window.close();
  }

  // ── 5. Mathis ─────────────────────────────────────────────────────────────
  console.log('\n[Mathis — no job costs for sales]');
  {
    const digests = require(root('api/lib/mathis-digests.js'));
    const IDS = ['j1', 'j2'];
    const PROJ = {
      j1: { id: 'j1', 'project-name': 'Franklin Regional Multi', 'job-number': '26049', 'contract-amount': '3017650', status: 'Active' },
      j2: { id: 'j2', 'project-name': 'Atwood Lot', 'job-number': '26050', 'contract-amount': '410000', status: 'Active' },
    };
    const queries = [];
    sqlImpl = (st, ...v) => {
      const text = st.join('?').replace(/\s+/g, ' ').trim();
      queries.push(text);
      if (/SELECT value FROM app_data/.test(text)) {
        const bare = String(v[0]).split(':')[1];
        if (bare === 'fct_paving_projects_index') return Promise.resolve([{ value: { ids: IDS } }]);
        if (bare === 'fct_paving_cost_rows') return Promise.resolve([{ value: [{ cost_code: '2100', unit_cost: 42 }] }]);
        return Promise.resolve([]);
      }
      if (/SELECT key, value FROM app_data/.test(text)) {
        return Promise.resolve((v[0] || []).map(k => {
          const id = String(k).split('fct_paving_project_')[1];
          return PROJ[id] ? { key: k, value: PROJ[id] } : null;
        }).filter(Boolean));
      }
      return Promise.resolve([]);
    };
    const mk = roles => ({ sql: (...a) => sqlImpl(...a), companyCode: 'FCT', authz: { role: 'level1', divisionRoles: roles }, division: 'paving' });

    const full = await digests.jobDigest(mk({ paving: 'level3' }), 'paving', {});
    const sold = await digests.jobDigest(mk({ paving: 'sales' }), 'paving', {});
    assert('a level3 digest carries contract figures (the control)',
      full.rows.some(r => r.contract === 3017650), JSON.stringify(full.rows[0]));
    assert('a sales digest lists the same jobs',
      sold.rows.length === full.rows.length && sold.rows.some(r => /Franklin/.test(r.name)), JSON.stringify(sold.rows));
    const money = ['contract', 'bid', 'actualCost', 'projectedFinalCost', 'variance', 'projectedProfit', 'actualProfit'];
    const leaked = sold.rows.flatMap(r => money.filter(k => k in r));
    assert('  with no contract, cost or profit on any row', leaked.length === 0, leaked.join(', '));
    assert('  no division summary', sold.summary === null);
    assert('  no cost-code catalogue or equipment', !('costCodes' in sold) && !('equipment' in sold));
    assert('  and says why, so the model does not report the jobs as costing nothing',
      /sales/.test(sold.covers[0]) && /SALES level/.test(sold.limits[0]), sold.limits[0]);

    queries.length = 0;
    const hist = await digests.jobHistory(mk({ paving: 'sales' }), 'paving', {});
    assert('job history (money over time) is refused for sales',
      hist && hist.kind === 'restricted' && !queries.some(q => /mathis_job_facts/.test(q)), JSON.stringify(hist));
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
