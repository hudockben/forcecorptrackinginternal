#!/usr/bin/env node
'use strict';
/**
 * Dust Control purchase orders: the Dust tab and central purchasing are ONE list.
 *
 * Run: node scripts/test-dust-po-sync.js
 *
 * Dust is a purchasing source division with no jobs, and it has a Purchase
 * Orders tab of its own. Both screens read and write app_data
 * fct_purchase_orders:dust — there is no second copy to keep in step, which is
 * the whole of the "sync". What has to hold for that to be true:
 *
 *  1. The catalogue offers Dust Control to purchasing, with dust's employees
 *     for "Received by" and no jobs, and only to callers who can reach it.
 *  2. Both pages, booted for real in jsdom against one shared order store:
 *       - purchasing lists Dust Control in its division filter and in an
 *         order's Division dropdown, and filing an order there lands it in
 *         dust's list, numbered on in dust's own sequence;
 *       - the Dust tab shows it, and an order raised on the Dust tab shows on
 *         the purchasing page at its next refresh;
 *       - a delivery purchasing records survives the Dust tab's next save;
 *       - a delete on the Dust tab reaches purchasing;
 *       - the Dust tab only ever saves one order at a time (never the
 *         full-list PUT, which the server refuses for dust);
 *       - a save that fails is retried, not lost;
 *       - the tab's rights follow the server's: level1 reads, level2 edits,
 *         level3 deletes.
 *  3. The helpers the Dust tab shares with the other PO pages are copies of
 *     theirs, not restatements.
 *
 * The shared store decides access with the REAL canAccessPODivision and
 * poCapabilities from api/lib/auth.js, so a page offering something the server
 * would refuse shows up here as a failure. The merge itself is po-sync's and is
 * tested against po-sync in test-po-division.js; the store mirrors only its
 * outcome (a delivery the writer never saw is kept).
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { fnSource } = require('./lib/fn-source');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const realAuth = require('../api/lib/auth');
// The server's own three-way merge, so the store keeps what it keeps.
const { keepOthersEdits } = require('../api/lib/po-sync');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if (cond()) return true; } catch { /* not there yet */ }
    await sleep(25);
  }
  return false;
}
const clone = v => JSON.parse(JSON.stringify(v));

// ── 1. The catalogue ───────────────────────────────────────────────────────
async function catalogChecks() {
  console.log('\n[the purchasing catalogue offers Dust Control]');
  const catPath  = path.resolve(ROOT, 'api/po-catalog.js');
  const authPath = require.resolve('../api/lib/auth');
  const neonPath = require.resolve('@neondatabase/serverless');

  const BLOBS = {
    'FCT:dust_lists':                 { employees: ['Pat Reilly', 'Dana Ruiz'], materials: ['ClearFrac'] },
    'FCT:fct_paving_lists':           { suppliers: [{ name: 'Fastenal' }], employees: ['Dana Ruiz'] },
    'FCT:fct_paving_projects_index':  ['p1'],
    'FCT:fct_paving_project_p1':      { id: 'p1', 'project-name': 'Route 9', bidItems: [] },
  };

  async function run(roles) {
    [catPath, authPath, neonPath].forEach(p => { delete require.cache[p]; });
    const asked = [];
    require.cache[authPath] = {
      id: authPath, filename: authPath, loaded: true,
      exports: Object.assign({}, realAuth, {
        requireAuth: async () => ({ companyCode: 'FCT', username: 'u', divisionRoles: roles }),
      }),
    };
    require.cache[neonPath] = {
      id: neonPath, filename: neonPath, loaded: true,
      exports: { neon: () => (strings, ...vals) => {
        const keys = Array.isArray(vals[0]) ? vals[0] : [];
        asked.push(...keys);
        return Promise.resolve(keys.filter(k => k in BLOBS).map(k => ({ key: k, value: BLOBS[k] })));
      } },
    };
    const handler = require(catPath);
    const res = {
      statusCode: 200, body: null,
      setHeader() {}, status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; }, end() { return this; },
    };
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    [catPath, authPath, neonPath].forEach(p => { delete require.cache[p]; });
    return { res, asked };
  }

  const buyer = await run({ purchase_orders: 'level3' });
  const divs  = (buyer.res.body && buyer.res.body.divisions) || [];
  const dust  = divs.find(d => d.division === 'dust');
  assert('purchasing is offered every source division, dust last',
    JSON.stringify(divs.map(d => d.division)) === JSON.stringify(['turf', 'paving', 'kiewit', 'quarry', 'dust']),
    JSON.stringify(divs.map(d => d.division)));
  assert('labelled Dust Control', dust && dust.label === 'Dust Control', JSON.stringify(dust));
  assert('with no jobs', dust && Array.isArray(dust.projects) && dust.projects.length === 0);
  assert('and no projects index is even read for it', !buyer.asked.includes('FCT:dust_projects_index'),
    buyer.asked.join(', '));
  assert('its lists come from dust_lists, the blob dust-config keeps', buyer.asked.includes('FCT:dust_lists'));
  const emps = (buyer.res.body && buyer.res.body.employees) || [];
  const pat  = emps.find(e => e.name === 'Pat Reilly');
  const dana = emps.find(e => e.name === 'Dana Ruiz');
  assert('dust\'s employees reach "Received by"', pat && JSON.stringify(pat.divisions) === '["dust"]', JSON.stringify(pat));
  assert('merged with the same person on another division',
    dana && dana.divisions.includes('dust') && dana.divisions.includes('paving'), JSON.stringify(dana));

  const dustUser = await run({ dust: 'level2' });
  assert('a dust user is offered dust alone',
    JSON.stringify((dustUser.res.body.divisions || []).map(d => d.division)) === '["dust"]',
    JSON.stringify(dustUser.res.body.divisions));
  const pavUser = await run({ paving: 'level3' });
  assert('and a paving user is not offered dust',
    !(pavUser.res.body.divisions || []).some(d => d.division === 'dust'));
  assert('nor are dust\'s employees read for them', !pavUser.asked.includes('FCT:dust_lists'));
}

// ── 2. One list, two screens ───────────────────────────────────────────────
const CATALOG = {
  divisions: [
    { division: 'turf',   label: 'Turf Management', projects: [] },
    { division: 'paving', label: 'Paving',          projects: [] },
    { division: 'kiewit', label: 'Kiewit Pinetree', projects: [] },
    { division: 'quarry', label: 'Quarry',          projects: [] },
    { division: 'dust',   label: 'Dust Control',    projects: [] },
  ],
  vendors: [{ name: 'Acme Chemical' }], employees: [{ name: 'Pat Reilly' }], truncated: [],
};
const DUST_CONFIG = {
  settings: { ub_rate: 0.35 },
  lists: {
    equipment: [], companies: [], states: ['PA'], mu: ['GAL'],
    employees: ['Pat Reilly', 'Sam Ortiz'], materials: ['ClearFrac', 'UB Concentrate'],
  },
};

function makeServer() {
  const lists = {
    dust: [{
      id: 'lzz0aaaa111', po_number: 'PO-0001', title: 'ClearFrac totes', supplier: 'Acme Chemical',
      status: 'approved', date_created: '2026-09-01', project_id: '', cost_code: '', sub_code: '', notes: '',
      lines: [{ id: 'A1', invoice_num: 'INV-77', date: '2026-09-02', qty: '4', unit_cost: '250',
                tax_pct: '6', tax: '60', employee: 'Pat Reilly', po_row_id: null }],
    }],
  };
  const log = [];
  let failNextPost = 0;
  let failNextDelete = 0;
  let postGate = null;     // a promise the next POST waits on, to hold a save in the air
  const reply = (b, status = 200) => ({
    ok: status < 400, status,
    json: async () => clone(b), text: async () => JSON.stringify(b),
  });
  async function handle(user, url, init) {
    const u = new URL(url, 'https://x.test');
    const m = (init && init.method) || 'GET';
    if (u.pathname === '/api/po-catalog') return reply(CATALOG);
    if (u.pathname === '/api/dust-config') return reply(DUST_CONFIG);
    if (u.pathname === '/api/dust-rows') return reply({ rows: [] });
    if (u.pathname === '/api/documents') return reply({ counts: {}, folders: [], documents: [] });
    if (u.pathname !== '/api/purchase-orders') return reply({});

    const div  = u.searchParams.get('division');
    const from = u.searchParams.get('from');
    const body = init && init.body ? JSON.parse(init.body) : null;
    log.push({ who: user.username, m, div, from, body });
    const payload = { companyCode: 'FCT', username: user.username, divisionRoles: user.divisionRoles };
    if (!realAuth.canAccessPODivision(payload, div)) return reply({ error: 'You do not have access to this division' }, 403);
    const caps = realAuth.poCapabilities(payload, div);

    if (m === 'GET') return reply({ purchaseOrders: lists[div] || [], updatedAt: null });
    // The real handler refuses a full-list PUT of dust's list outright.
    if (m === 'PUT') return reply({ error: 'refused' }, 400);
    if (m === 'POST') {
      if (!caps.canUpload) return reply({ error: 'You do not have permission to change purchase orders' }, 403);
      if (failNextPost > 0) { failNextPost--; return reply({ error: 'Could not save the purchase order. Try again.' }, 500); }
      if (postGate) { const g = postGate; postGate = null; await g; }
      const po = body.purchaseOrder;
      // The real handler's guard: an order not in this list but filed in
      // another was re-filed there; a save without `from` is refused.
      if (!from || from === div) {
        const elsewhere = Object.keys(lists).find(k => k !== div && (lists[k] || []).some(p => p.id === po.id));
        if (elsewhere && !(lists[div] || []).some(p => p.id === po.id)) {
          return reply({ error: 'Purchase order moved', moved: true, division: elsewhere,
                         label: elsewhere === 'purchase_orders' ? 'General' : elsewhere }, 409);
        }
      }
      if (from && from !== div) lists[from] = (lists[from] || []).filter(p => p.id !== po.id);
      const list = lists[div] || (lists[div] = []);
      const i = list.findIndex(p => p.id === po.id);
      let mergedLines = 0;
      let keptEdits = 0;
      if (i >= 0 && body.base && (!from || from === div)) keptEdits = keepOthersEdits(po, body.base, clone(list[i]));
      if (i >= 0) {
        // A delivery the writer never saw is kept, as po-sync's unseenLines keeps it.
        const sent = new Set((po.lines || []).map(l => l.id));
        const gone = new Set(body.deletedLineIds || []);
        const kept = (list[i].lines || []).filter(l => !sent.has(l.id) && !gone.has(l.id));
        mergedLines = kept.length;
        po.lines = (po.lines || []).concat(kept);
        list[i] = po;
      } else {
        list.push(po);
      }
      return reply({ ok: true, purchaseOrder: po, rows: { removed: 0, written: 0 }, staleCopy: false, mergedLines, keptEdits });
    }
    if (m === 'DELETE') {
      if (!caps.canManage) return reply({ error: 'You do not have permission to delete purchase orders' }, 403);
      if (failNextDelete > 0) { failNextDelete--; return reply({ error: 'Could not delete the purchase order. Try again.' }, 500); }
      const id = u.searchParams.get('id');
      const before = (lists[div] || []).length;
      lists[div] = (lists[div] || []).filter(p => p.id !== id);
      return reply({ ok: true, found: lists[div].length < before, rowsRemoved: 0 });
    }
    return reply({ error: 'Method not allowed' }, 405);
  }
  return {
    lists, log, handle,
    failPost(n) { failNextPost = n; },
    failDelete(n) { failNextDelete = n; },
    /** Hold the next POST until the returned function is called. */
    holdPost() { let release; postGate = new Promise(r => { release = r; }); return () => release(); },
  };
}

function boot(file, user, fctDivision, server) {
  const dom = new JSDOM(read(file), {
    runScripts: 'dangerously',
    url: 'https://x.test/' + file,
    pretendToBeVisual: true,
    beforeParse(win) {
      win.localStorage.setItem('fct_token', 'test-token');
      win.localStorage.setItem('fct_user', JSON.stringify(Object.assign({ userId: 1, companyCode: 'FCT', companyName: 'Test Co' }, user)));
      win.localStorage.setItem('fct_division', fctDivision);
      win.fetch = (url, init) => server.handle(user, String(url), init);
      win.confirm = () => true;
      win.alert = () => {};
      win.print = () => {};
      win.__errors = [];
      win.addEventListener('error', e => win.__errors.push(e.message || String(e.error)));
    },
  });
  return dom.window;
}
const input = (win, el, value) => {
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
};
const poRow = (doc, id) =>
  [...doc.querySelectorAll('#dpoTbody tr[data-po-id]')].find(tr => tr.getAttribute('data-po-id') === id) || null;
const linesRow = (doc, id) =>
  [...doc.querySelectorAll('#dpoTbody tr[data-lines-for]')].find(tr => tr.getAttribute('data-lines-for') === id) || null;
// The purchasing page polls on a visibility change, as it does every minute.
const nudge = win => win.document.dispatchEvent(new win.Event('visibilitychange'));

async function syncChecks() {
  const server = makeServer();
  const buyer  = { username: 'buyer', divisionRoles: { purchase_orders: 'level3' } };
  const clerk  = { username: 'clerk', name: 'Dust Clerk', divisionRoles: { dust: 'level2' } };
  const boss   = { username: 'boss',  divisionRoles: { dust: 'level3' } };
  const viewer = { username: 'viewer', divisionRoles: { dust: 'level1' } };

  // ── Purchasing ──
  console.log('\n[Purchase Orders: Dust Control is a division in the dropdowns]');
  const pw = boot('purchase-orders.html', buyer, 'purchase_orders', server);
  const pd = pw.document;
  await until(() => pw.eval('loadedLists.has("dust")') && pw.eval('purchaseOrders.length') === 1);
  assert('the page boots without errors', pw.__errors.length === 0, pw.__errors.join(' | '));
  const filterOpts = [...pd.querySelectorAll('#f-division option')].map(o => o.value + '=' + o.textContent);
  assert('the division filter offers Dust Control', filterOpts.includes('dust=Dust Control'), filterOpts.join(', '));
  assert('the dust order already filed is on screen, tagged dust',
    pw.eval('purchaseOrders.find(p => p.id === "lzz0aaaa111")._division') === 'dust');
  assert('  wearing a Dust Control chip in dust\'s colour',
    /Dust Control/.test(pw.eval('divChipHTML("dust")')) && /var\(--div-dust\)/.test(pw.eval('divChipHTML("dust")')));

  const newId = pw.eval('newPO().id');
  const sel = pw.eval(`divisionSelectHTML(purchaseOrders.find(p => p.id === ${JSON.stringify(newId)}))`);
  assert('a new order\'s Division dropdown offers Dust Control', /<option value="dust"[^>]*>Dust Control<\/option>/.test(sel), sel);
  pw.eval(`setDivision(${JSON.stringify(newId)}, 'dust')`);
  await until(() => server.lists.dust.some(p => p.id === newId));
  const filed = server.lists.dust.find(p => p.id === newId);
  assert('picking it files the order in dust\'s own list', Boolean(filed));
  assert('  numbered on in dust\'s sequence', filed && filed.po_number === 'PO-0002', filed && filed.po_number);
  assert('  moved out of the general list, not copied',
    !(server.lists.purchase_orders || []).some(p => p.id === newId));
  assert('  carrying no job', filed && !filed.project_id);
  pw.eval(`setField(${JSON.stringify(newId)}, 'title', 'Calcium chloride')`);
  await until(() => (server.lists.dust.find(p => p.id === newId) || {}).title === 'Calcium chloride');

  // ── The Dust tab ──
  console.log('\n[the Dust tab shows the same list]');
  const dw = boot('dust.html', clerk, 'dust', server);
  const dd = dw.document;
  await until(() => dw._dustPO && dw._dustPO.loaded);
  assert('the dust page boots without errors', dw.__errors.length === 0, dw.__errors.join(' | '));
  const tabBtn = dd.querySelector('.tab-btn[data-tab="purchase-orders"]');
  assert('it has a Purchase Orders tab', tabBtn && tabBtn.textContent.trim() === 'Purchase Orders');
  tabBtn.click();
  await sleep(30);
  assert('which opens its panel', dd.getElementById('tab-purchase-orders').classList.contains('active'));
  assert('both orders are listed', poRow(dd, 'lzz0aaaa111') && poRow(dd, newId),
    dd.querySelectorAll('#dpoTbody tr[data-po-id]').length);
  assert('  the one purchasing raised, as purchasing titled it',
    poRow(dd, newId) && poRow(dd, newId).querySelector('input[data-f="title"]').value === 'Calcium chloride');
  assert('  newest first', dd.querySelector('#dpoTbody tr[data-po-id]').getAttribute('data-po-id') === newId);
  assert('the totals are the order\'s money: 4 × $250 + 6% = $1,060.00',
    dd.getElementById('dpo-tot-total').textContent === '$1,060.00', dd.getElementById('dpo-tot-total').textContent);
  assert('the next number continues the shared sequence', dw._dustPO.nextNumber() === 'PO-0003');
  assert('a level2 user may edit', dw._dustPO.caps.canEdit === true);
  assert('  but is offered no delete', !dd.querySelector('#dpoTbody [data-act="del-po"]'));

  console.log('\n[an order raised on the Dust tab reaches Purchase Orders]');
  dd.getElementById('dpoNewBtn').click();
  await until(() => server.lists.dust.length === 3);
  const dustRaised = server.lists.dust[2];
  assert('+ New PO saves into dust\'s list', dustRaised && dustRaised.po_number === 'PO-0003',
    dustRaised && dustRaised.po_number);
  const myRow = poRow(dd, dustRaised.id);
  assert('  and opens it with a first delivery to fill in', myRow && linesRow(dd, dustRaised.id)
    && linesRow(dd, dustRaised.id).querySelectorAll('tr[data-line-id]').length === 1);
  input(dw, myRow.querySelector('input[data-f="title"]'), 'UB Concentrate');
  input(dw, myRow.querySelector('input[data-f="supplier"]'), 'Acme Chemical');
  const firstLine = linesRow(dd, dustRaised.id).querySelector('tr[data-line-id]');
  input(dw, firstLine.querySelector('input[data-lf="qty"]'), '200');
  input(dw, firstLine.querySelector('input[data-lf="unit_cost"]'), '1,25');   // a decimal comma
  input(dw, firstLine.querySelector('input[data-lf="tax_pct"]'), '6');
  assert('the delivery\'s total updates as it is typed — 200 × 1,25 + 6%',
    firstLine.querySelector('[data-calc="total"]').textContent === '$265.00',
    firstLine.querySelector('[data-calc="total"]').textContent);
  await until(() => (server.lists.dust.find(p => p.id === dustRaised.id) || {}).title === 'UB Concentrate'
    && (server.lists.dust.find(p => p.id === dustRaised.id).lines[0] || {}).tax === '15');
  const stored = server.lists.dust.find(p => p.id === dustRaised.id);
  assert('the typing is saved once the box goes quiet', stored.title === 'UB Concentrate'
    && stored.lines[0].qty === '200' && stored.lines[0].tax_pct === '6', JSON.stringify(stored));
  assert('  with the tax dollars kept beside the percentage', stored.lines[0].tax === '15', stored.lines[0].tax);
  assert('  and no job and no codes', !stored.project_id && !stored.cost_code && !stored.sub_code);

  nudge(pw);
  await until(() => (pw.eval(`(purchaseOrders.find(p => p.id === ${JSON.stringify(dustRaised.id)}) || {}).title`) === 'UB Concentrate'));
  assert('purchasing picks it up at its next refresh, under dust',
    pw.eval(`(purchaseOrders.find(p => p.id === ${JSON.stringify(dustRaised.id)}) || {})._division`) === 'dust');

  console.log('\n[a delivery purchasing records survives the Dust tab\'s next save]');
  pw.eval(`addLine(${JSON.stringify(dustRaised.id)})`);
  await until(() => (server.lists.dust.find(p => p.id === dustRaised.id).lines || []).length === 2);
  assert('purchasing adds a second delivery', server.lists.dust.find(p => p.id === dustRaised.id).lines.length === 2);
  dd.activeElement && dd.activeElement.blur && dd.activeElement.blur();
  input(dw, poRow(dd, dustRaised.id).querySelector('input[data-f="notes"]'), 'Deliver to the Bear Hollow yard');
  dd.activeElement && dd.activeElement.blur && dd.activeElement.blur();
  await until(() => (server.lists.dust.find(p => p.id === dustRaised.id) || {}).notes === 'Deliver to the Bear Hollow yard');
  await until(() => (dw._dustPO.orders.find(p => p.id === dustRaised.id).lines || []).length === 2);
  assert('the Dust tab\'s save keeps it on the server',
    server.lists.dust.find(p => p.id === dustRaised.id).lines.length === 2);
  assert('and the tab shows it too', dw._dustPO.orders.find(p => p.id === dustRaised.id).lines.length === 2);

  console.log('\n[a delete on the Dust tab reaches Purchase Orders]');
  const bw = boot('dust.html', boss, 'dust', server);
  const bd = bw.document;
  await until(() => bw._dustPO && bw._dustPO.loaded && poRow(bd, newId));
  assert('a level3 user is offered delete', Boolean(poRow(bd, newId).querySelector('[data-act="del-po"]')));
  poRow(bd, newId).querySelector('[data-act="del-po"]').click();
  await until(() => !server.lists.dust.some(p => p.id === newId));
  assert('the order leaves dust\'s list', !server.lists.dust.some(p => p.id === newId));
  assert('  through the one-order DELETE', server.log.some(c => c.m === 'DELETE' && c.div === 'dust'));
  await until(() => !poRow(bd, newId));
  assert('  and leaves the screen', !poRow(bd, newId));
  nudge(pw);
  await until(() => !pw.eval(`purchaseOrders.some(p => p.id === ${JSON.stringify(newId)})`));
  assert('purchasing no longer lists it', !pw.eval(`purchaseOrders.some(p => p.id === ${JSON.stringify(newId)})`));

  console.log('\n[a save that fails is retried, not lost]');
  // Two failures: the first save, and the retry the next refresh makes. The
  // edit has to survive a refresh that could not send it, too.
  server.failPost(2);
  input(bw, poRow(bd, 'lzz0aaaa111').querySelector('input[data-f="notes"]'), 'Reorder in March');
  bd.activeElement && bd.activeElement.blur && bd.activeElement.blur();
  await until(() => /Could not save/.test(bd.getElementById('dpoBanner').textContent));
  assert('the failure is said on screen', /Could not save PO-0001/.test(bd.getElementById('dpoBanner').textContent),
    bd.getElementById('dpoBanner').textContent);
  const held  = () => bw._dustPO.orders.find(p => p.id === 'lzz0aaaa111').notes;
  const shown = () => poRow(bd, 'lzz0aaaa111').querySelector('input[data-f="notes"]').value;
  assert('  and the edit is still there', held() === 'Reorder in March' && shown() === 'Reorder in March', held() + ' / ' + shown());
  await bw._dustPO.refresh();     // its retry fails as well
  assert('a refresh whose retry fails keeps the edit, rather than the server\'s older copy',
    held() === 'Reorder in March' && shown() === 'Reorder in March', held() + ' / ' + shown());
  assert('  and the server still has the old note', (server.lists.dust.find(p => p.id === 'lzz0aaaa111') || {}).notes === '');
  await bw._dustPO.refresh();
  await until(() => (server.lists.dust.find(p => p.id === 'lzz0aaaa111') || {}).notes === 'Reorder in March');
  assert('the refresh after that sends it', server.lists.dust.find(p => p.id === 'lzz0aaaa111').notes === 'Reorder in March');

  console.log('\n[only ever one order at a time]');
  const dustWrites = server.log.filter(c => c.div === 'dust' && c.m !== 'GET');
  assert('no page ever PUT dust\'s whole list', !server.log.some(c => c.m === 'PUT'),
    JSON.stringify(server.log.filter(c => c.m === 'PUT').map(c => c.who)));
  assert('every Dust tab save is a single-order POST naming dust',
    dustWrites.filter(c => c.who !== 'buyer').every(c => (c.m === 'POST' && c.body && c.body.purchaseOrder && !c.body.purchaseOrders)
      || c.m === 'DELETE'));
  assert('the Dust tab does not stamp itself as purchasing',
    !dustWrites.filter(c => c.who === 'clerk' && c.m === 'POST').some(c => c.body.purchaseOrder.origin === 'purchasing'));

  console.log('\n[a view-only dust user reads and changes nothing]');
  const vw = boot('dust.html', viewer, 'dust', server);
  const vd = vw.document;
  await until(() => vw._dustPO && vw._dustPO.loaded && vd.querySelectorAll('#dpoTbody tr[data-po-id]').length === 2);
  vd.querySelector('.tab-btn[data-tab="purchase-orders"]').click();
  await sleep(30);
  assert('both orders are shown', vd.querySelectorAll('#dpoTbody tr[data-po-id]').length === 2);
  assert('as text, with no boxes to type in', !vd.querySelector('#dpoTbody tr[data-po-id] input, #dpoTbody tr[data-po-id] select'));
  assert('no + New PO', vd.getElementById('dpoNewBtn').style.display === 'none');
  assert('no delete', !vd.querySelector('#dpoTbody [data-act="del-po"]'));
  assert('and the banner says why', /Level 2 in Dust Control/.test(vd.getElementById('dpoBanner').textContent),
    vd.getElementById('dpoBanner').textContent);
  vw.eval('document.getElementById("dpoNewBtn").click()');
  await sleep(50);
  assert('nothing is written for them', !server.log.some(c => c.who === 'viewer' && c.m !== 'GET'));

  console.log('\n[what an order carries is text, never markup]');
  server.lists.dust.push({
    id: 'evil"><img src=x onerror=window.__pwned=1>', po_number: 'PO-0099',
    title: '"><img src=x onerror=window.__pwned=1>', supplier: "O'Neil & Sons", status: 'pending',
    date_created: '2026-10-01', notes: '<b>bold</b>', lines: [],
  });
  await bw._dustPO.refresh();
  await until(() => bw._dustPO.orders.some(p => p.po_number === 'PO-0099'));
  const evil = poRow(bd, 'evil"><img src=x onerror=window.__pwned=1>');
  assert('a crafted order renders', Boolean(evil));
  assert('  as a value in its box', evil && evil.querySelector('input[data-f="title"]').value === '"><img src=x onerror=window.__pwned=1>');
  assert('  with no element injected', !bd.querySelector('#dpoTbody img, #dpoTbody b') && !bw.__pwned);
  evil.querySelector('[data-act="toggle"]').click();
  await sleep(20);
  assert('  and its own buttons still find it', Boolean(linesRow(bd, 'evil"><img src=x onerror=window.__pwned=1>')));

  [pw, dw, bw, vw].forEach(w => { try { w.close(); } catch { /* done */ } });
}

// ── 3. The fixes from the bug review, each driven for real ─────────────────
const blur = doc => { if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur(); };
const lineRow = (doc, poId, lineId) => {
  const lr = linesRow(doc, poId);
  return lr && ([...lr.querySelectorAll('tr[data-line-id]')].find(tr => tr.getAttribute('data-line-id') === lineId) || null);
};

async function fixChecks() {
  const server = makeServer();
  const buyer = { username: 'buyer', divisionRoles: { purchase_orders: 'level3' } };
  const boss  = { username: 'boss',  divisionRoles: { dust: 'level3' } };
  const dw = boot('dust.html', boss, 'dust', server);
  const dd = dw.document;
  await until(() => dw._dustPO && dw._dustPO.loaded && poRow(dd, 'lzz0aaaa111'));
  dd.querySelector('.tab-btn[data-tab="purchase-orders"]').click();
  await sleep(30);
  poRow(dd, 'lzz0aaaa111').querySelector('[data-act="toggle"]').click();
  await sleep(20);
  const order = () => dw._dustPO.orders.find(p => p.id === 'lzz0aaaa111');
  const stored = () => server.lists.dust.find(p => p.id === 'lzz0aaaa111');

  console.log('\n[deliveries merged in from elsewhere are added, never swapped in]');
  {
    // Purchasing records B1 on the order; the tab has not seen it.
    stored().lines.push({ id: 'B1', invoice_num: 'INV-90', date: '2026-10-02', qty: '10', unit_cost: '5', tax_pct: '', tax: '', employee: '', po_row_id: null });
    const release = server.holdPost();
    const qty = lineRow(dd, 'lzz0aaaa111', 'A1').querySelector('input[data-lf="qty"]');
    input(dw, qty, '5');
    await until(() => server.log.some(c => c.m === 'POST' && c.who === 'boss'), 3000);
    // While that save is in the air the user corrects the figure again.
    input(dw, qty, '7');
    release();
    await until(() => order().lines.length === 2);
    assert('the delivery purchasing recorded is taken in', order().lines.some(l => l.id === 'B1'));
    assert('  and the correction typed while the save was out is kept', order().lines.find(l => l.id === 'A1').qty === '7',
      order().lines.find(l => l.id === 'A1').qty);
    blur(dd);
    await until(() => stored().lines.find(l => l.id === 'A1').qty === '7');
    assert('  and reaches the server on the next save', stored().lines.find(l => l.id === 'A1').qty === '7'
      && stored().lines.length === 2, JSON.stringify(stored().lines.map(l => l.id + ':' + l.qty)));
  }

  console.log('\n[a redraw nobody asked for waits until the box is left]');
  {
    dw._dustPO.render();
    const box = poRow(dd, 'lzz0aaaa111').querySelector('input[data-f="notes"]');
    box.focus();
    dw._dustPO.repaint();     // paperclip counts arriving, an upload finishing
    assert('the box being typed in is not rebuilt under the caret',
      box.isConnected && dd.activeElement === box);
    blur(dd);
    await sleep(20);
    assert('once focus leaves the table, the table is redrawn', !box.isConnected);
  }

  console.log('\n[the search box and filter do not hold off a refresh]');
  {
    const search = dd.getElementById('dpoSearch');
    search.focus();
    server.lists.dust.push({ id: 'lzz0search01', po_number: 'PO-0005', title: 'Hose', supplier: '', status: 'pending',
      date_created: '2026-10-03', project_id: '', notes: '', lines: [] });
    await dw._dustPO.refresh();
    assert('an order raised elsewhere appears while the search box has focus',
      dw._dustPO.orders.some(p => p.id === 'lzz0search01'));
    blur(dd);
  }

  console.log('\n[figures are stored the way a number box holds them]');
  {
    const lr = lineRow(dd, 'lzz0aaaa111', 'B1');
    const q = lr.querySelector('input[data-lf="qty"]');
    const u = lr.querySelector('input[data-lf="unit_cost"]');
    const t = lr.querySelector('input[data-lf="tax_pct"]');
    input(dw, q, '1,500'); input(dw, u, '$2.10'); input(dw, t, '6%');
    const b1 = () => order().lines.find(l => l.id === 'B1');
    assert('1,500 is kept as 1500, $2.10 as 2.1 and 6% as 6',
      b1().qty === '1500' && b1().unit_cost === '2.1' && b1().tax_pct === '6', JSON.stringify(b1()));
    assert('  so the tax works out on the real quantity', b1().tax === '189', b1().tax);
    q.dispatchEvent(new dw.Event('change', { bubbles: true }));
    assert('  and the box shows the stored figure once it is left', q.value === '1500', q.value);
    assert('the delivery\'s tax and total cells lose the dimmed empty look',
      !lr.querySelector('[data-calc="tax"]').parentElement.classList.contains('empty') &&
      !lr.querySelector('[data-calc="total"]').parentElement.classList.contains('empty'));
    assert('the unit cost with tax reads as money, as purchasing shows it',
      lr.querySelector('[data-calc="uct"]').textContent === '$2.23 w/ tax', lr.querySelector('[data-calc="uct"]').textContent);
    blur(dd);
    await until(() => (stored().lines.find(l => l.id === 'B1') || {}).qty === '1500');
    assert('purchasing\'s number boxes get a number they can show',
      stored().lines.find(l => l.id === 'B1').qty === '1500' && stored().lines.find(l => l.id === 'B1').unit_cost === '2.1');
  }

  console.log('\n[a new order takes the next number as stored now]');
  {
    // The tab's own list is stale — a box in the table keeps refreshes off.
    poRow(dd, 'lzz0aaaa111').querySelector('input[data-f="notes"]').focus();
    server.lists.dust.push({ id: 'lzz0other099', po_number: 'PO-0009', title: 'Raised on Purchase Orders', supplier: '',
      status: 'pending', date_created: '2026-10-04', project_id: '', notes: '', lines: [] });
    const before = server.lists.dust.length;
    dd.getElementById('dpoNewBtn').click();
    await until(() => server.lists.dust.length === before + 1);
    const made = server.lists.dust[server.lists.dust.length - 1];
    assert('it does not reuse a number taken since the last refresh', made && made.po_number === 'PO-0010',
      made && made.po_number);
    blur(dd);
  }

  console.log('\n[an edit typed just before a failed delete is not lost]');
  {
    const victim = server.lists.dust.find(p => p.po_number === 'PO-0010');
    await dw._dustPO.refresh();
    const row = poRow(dd, victim.id);
    input(dw, row.querySelector('input[data-f="notes"]'), 'Keep this note');
    server.failDelete(1);
    row.querySelector('[data-act="del-po"]').click();
    await until(() => /Not deleted/.test(dd.getElementById('dpoBanner').textContent));
    assert('the delete fails and says so', /Not deleted/.test(dd.getElementById('dpoBanner').textContent));
    await until(() => (server.lists.dust.find(p => p.id === victim.id) || {}).notes === 'Keep this note');
    assert('  and the note typed before it is still saved',
      (server.lists.dust.find(p => p.id === victim.id) || {}).notes === 'Keep this note');
  }

  console.log('\n[a page sent to the background sends its failed saves]');
  {
    server.failPost(1);
    input(dw, poRow(dd, 'lzz0aaaa111').querySelector('input[data-f="supplier"]'), 'Acme Chemical Co');
    blur(dd);
    await until(() => /Could not save/.test(dd.getElementById('dpoBanner').textContent));
    Object.defineProperty(dd, 'visibilityState', { configurable: true, get: () => 'hidden' });
    dd.dispatchEvent(new dw.Event('visibilitychange'));
    await until(() => stored().supplier === 'Acme Chemical Co');
    assert('the failed save is sent when the page is hidden', stored().supplier === 'Acme Chemical Co', stored().supplier);
    Object.defineProperty(dd, 'visibilityState', { configurable: true, get: () => 'visible' });
  }

  console.log('\n[an order re-filed on Purchase Orders leaves the Dust tab instead of being copied back]');
  {
    const pw = boot('purchase-orders.html', buyer, 'purchase_orders', server);
    await until(() => pw.eval('loadedLists.has("dust") && purchaseOrders.some(p => p.id === "lzz0search01")'));
    // The dust tab still holds the order; purchasing re-files it to General.
    pw.eval(`setDivision('lzz0search01', 'purchase_orders')`);
    await until(() => (server.lists.purchase_orders || []).some(p => p.id === 'lzz0search01'));
    assert('purchasing moves it out of dust', !server.lists.dust.some(p => p.id === 'lzz0search01'));
    await dw._dustPO.render();
    const row = poRow(dd, 'lzz0search01');
    assert('the dust tab has not refreshed yet and still shows it', Boolean(row));
    input(dw, row.querySelector('input[data-f="notes"]'), 'edited on a stale copy');
    blur(dd);
    await until(() => !dw._dustPO.orders.some(p => p.id === 'lzz0search01'));
    assert('its save is refused rather than copying it back into dust',
      !server.lists.dust.some(p => p.id === 'lzz0search01'));
    assert('  so it is filed in one list only',
      (server.lists.purchase_orders || []).filter(p => p.id === 'lzz0search01').length === 1);
    assert('  the dust tab lets go of it', !dw._dustPO.orders.some(p => p.id === 'lzz0search01'));
    assert('  and says where it went', /moved out of Dust Control[\s\S]*General/.test(dd.getElementById('dpoBanner').textContent),
      dd.getElementById('dpoBanner').textContent);
    await dw._dustPO.refresh();
    assert('  and no refresh brings it back', !dw._dustPO.orders.some(p => p.id === 'lzz0search01'));
    try { pw.close(); } catch { /* done */ }
  }

  console.log('\n[removing a delivery on the Dust tab sticks]');
  {
    dw._dustPO.render();
    if (!linesRow(dd, 'lzz0aaaa111')) poRow(dd, 'lzz0aaaa111').querySelector('[data-act="toggle"]').click();
    const before = server.log.length;
    lineRow(dd, 'lzz0aaaa111', 'B1').querySelector('[data-act="del-line"]').click();
    await until(() => !stored().lines.some(l => l.id === 'B1'));
    const sent = server.log.slice(before).find(c => c.m === 'POST' && c.who === 'boss');
    assert('the save names the removed delivery', sent && JSON.stringify(sent.body.deletedLineIds) === '["B1"]',
      sent && JSON.stringify(sent.body.deletedLineIds));
    assert('  so the server drops it instead of keeping it as one this tab never saw',
      !stored().lines.some(l => l.id === 'B1'), JSON.stringify(stored().lines.map(l => l.id)));
    assert('  and it stays gone from the tab', !order().lines.some(l => l.id === 'B1'));
    await dw._dustPO.refresh();
    assert('  through a refresh too', !order().lines.some(l => l.id === 'B1'));
  }

  console.log('\n[the tab picks up purchasing\'s changes on its own]');
  {
    dd.querySelector('.tab-btn[data-tab="home"]').click();
    server.lists.dust.push({ id: 'lzz0opened01', po_number: 'PO-0020', title: 'Raised while the tab was shut', supplier: '',
      status: 'pending', date_created: '2026-10-05', project_id: '', notes: '', lines: [] });
    dd.querySelector('.tab-btn[data-tab="purchase-orders"]').click();
    await until(() => poRow(dd, 'lzz0opened01'));
    assert('opening the tab reads the list again', Boolean(poRow(dd, 'lzz0opened01')));
    server.lists.dust.push({ id: 'lzz0visible1', po_number: 'PO-0021', title: 'Raised while the page was hidden', supplier: '',
      status: 'pending', date_created: '2026-10-05', project_id: '', notes: '', lines: [] });
    dd.dispatchEvent(new dw.Event('visibilitychange'));
    await until(() => poRow(dd, 'lzz0visible1'));
    assert('so does coming back to the page', Boolean(poRow(dd, 'lzz0visible1')));
    const src = read('dust.html');
    assert('and it refreshes every minute', /setInterval\(\(\) => dpoRefresh\(\), DPO_POLL_MS\);/.test(src)
      && /const DPO_POLL_MS\s+= 60_000;/.test(src));
  }

  console.log('\n[typing is sent before the page is hidden or closed]');
  {
    const posts = () => server.log.filter(c => c.m === 'POST' && c.who === 'boss').length;
    let before = posts();
    input(dw, poRow(dd, 'lzz0opened01').querySelector('input[data-f="notes"]'), 'Typed, then switched apps');
    Object.defineProperty(dd, 'visibilityState', { configurable: true, get: () => 'hidden' });
    dd.dispatchEvent(new dw.Event('visibilitychange'));
    await sleep(100);   // well inside the 600ms debounce
    assert('hiding the page sends the edit at once, not after the debounce',
      posts() > before && (server.lists.dust.find(p => p.id === 'lzz0opened01') || {}).notes === 'Typed, then switched apps',
      (server.lists.dust.find(p => p.id === 'lzz0opened01') || {}).notes);
    Object.defineProperty(dd, 'visibilityState', { configurable: true, get: () => 'visible' });

    // Closing the tab: a keepalive request the browser delivers after the page is gone.
    const seen = [];
    const realFetch = dw.fetch;
    dw.fetch = (url, init) => { seen.push({ url: String(url), init }); return realFetch(url, init); };
    input(dw, poRow(dd, 'lzz0opened01').querySelector('input[data-f="notes"]'), 'Typed, then closed the tab');
    dw.dispatchEvent(new dw.Event('beforeunload'));
    const ka = seen.find(c => /purchase-orders\?division=dust/.test(c.url) && c.init && c.init.method === 'POST' && c.init.keepalive);
    assert('closing the tab sends it as a keepalive save', Boolean(ka));
    assert('  carrying the edit and the removals still owed',
      ka && JSON.parse(ka.init.body).purchaseOrder.notes === 'Typed, then closed the tab'
      && Array.isArray(JSON.parse(ka.init.body).deletedLineIds));
    dw.fetch = realFetch;
    await sleep(700);
  }

  console.log('\n[a save from an older copy keeps what the other screen changed]');
  {
    const pw = boot('purchase-orders.html', buyer, 'purchase_orders', server);
    await until(() => pw.eval('loadedLists.has("dust") && purchaseOrders.some(p => p.id === "lzz0opened01")'));
    await dw._dustPO.refresh();
    const notes = poRow(dd, 'lzz0opened01').querySelector('input[data-f="notes"]');
    notes.focus();                       // the dust clerk is mid-note: no refresh reaches this tab
    // Purchasing approves the order.
    pw.eval(`setField('lzz0opened01', 'status', 'approved')`);
    await until(() => (server.lists.dust.find(p => p.id === 'lzz0opened01') || {}).status === 'approved');
    assert('purchasing\'s approval is stored', server.lists.dust.find(p => p.id === 'lzz0opened01').status === 'approved');
    assert('the dust tab\'s copy still says pending', dw._dustPO.orders.find(p => p.id === 'lzz0opened01').status === 'pending');
    input(dw, notes, 'Note typed on the older copy');
    blur(dd);
    await until(() => (server.lists.dust.find(p => p.id === 'lzz0opened01') || {}).notes === 'Note typed on the older copy');
    const st = server.lists.dust.find(p => p.id === 'lzz0opened01');
    assert('the dust tab\'s note is saved', st.notes === 'Note typed on the older copy');
    assert('  without undoing purchasing\'s approval', st.status === 'approved' && st.status_changed_by === 'buyer',
      JSON.stringify({ status: st.status, by: st.status_changed_by }));
    await until(() => dw._dustPO.orders.find(p => p.id === 'lzz0opened01').status === 'approved');
    assert('  and the dust tab now shows it approved', dw._dustPO.orders.find(p => p.id === 'lzz0opened01').status === 'approved');

    // The other way round: purchasing holds the older copy now.
    input(dw, poRow(dd, 'lzz0opened01').querySelector('input[data-f="supplier"]'), 'Supplier set on the dust tab');
    blur(dd);
    await until(() => (server.lists.dust.find(p => p.id === 'lzz0opened01') || {}).supplier === 'Supplier set on the dust tab');
    assert('purchasing has not refreshed and still shows the old supplier',
      pw.eval(`purchaseOrders.find(p => p.id === 'lzz0opened01').supplier`) !== 'Supplier set on the dust tab');
    pw.eval(`setField('lzz0opened01', 'title', 'Title set on Purchase Orders')`);
    await until(() => (server.lists.dust.find(p => p.id === 'lzz0opened01') || {}).title === 'Title set on Purchase Orders');
    const st2 = server.lists.dust.find(p => p.id === 'lzz0opened01');
    assert('purchasing\'s title is saved without undoing the dust tab\'s supplier',
      st2.title === 'Title set on Purchase Orders' && st2.supplier === 'Supplier set on the dust tab', JSON.stringify(st2));
    await until(() => pw.eval(`purchaseOrders.find(p => p.id === 'lzz0opened01').supplier`) === 'Supplier set on the dust tab');
    assert('  and purchasing now shows the dust tab\'s supplier',
      pw.eval(`purchaseOrders.find(p => p.id === 'lzz0opened01').supplier`) === 'Supplier set on the dust tab');
    try { pw.close(); } catch { /* done */ }
  }

  console.log('\n[the rest]');
  {
    assert('the deliveries table\'s header does not stick over the orders\' header',
      /\.dpo-line-table thead,\s*\n\s*\.dpo-line-table thead tr\.col-row th \{ position: static; \}/.test(read('dust.html')));
    const lone = makeServer();
    lone.lists.dust = [];
    const solo = boot('dust.html', { username: 'solo', divisionRoles: { dust: 'level2' } }, 'dust', lone);
    await until(() => solo._dustPO && solo._dustPO.loaded);
    const empty = solo.document.querySelector('#dpoTbody .dpo-empty').textContent;
    assert('a dust-only user is not sent to a Purchase Orders page they cannot open',
      /Use \+ New PO to raise one\.$/.test(empty.trim()) && !/Purchase Orders page/.test(empty), empty);
    const mixed = boot('dust.html', { username: 'mixed', divisionRoles: { dust: 'level1', purchase_orders: 'level2' } }, 'dust', makeServer());
    await until(() => mixed._dustPO && mixed._dustPO.loaded);
    assert('a purchasing role edits dust orders here', mixed._dustPO.caps.canEdit === true);
    assert('  but is not promised an upload its dust role cannot make', mixed._dustPO.caps.docs.canUpload === false);
    assert('  and is told where receipts are attached instead', mixed._dustPO.caps.docsViaPurchasingOnly === true);
    [solo, mixed].forEach(w => { try { w.close(); } catch { /* done */ } });
  }
  try { dw.close(); } catch { /* done */ }
}

// ── 4. Shared helpers are copies ───────────────────────────────────────────
function sourceChecks() {
  console.log('\n[the Dust tab shares the PO pages\' own helpers]');
  const dust = read('dust.html');
  const po   = read('purchase-orders.html');
  const norm = s => (s || '').split('\n').map(l => l.trim()).join('\n');
  for (const name of ['_poCreatedMs', '_poNewestFirst']) {
    assert(`${name} is the purchasing page's, line for line`,
      fnSource(dust, name) && norm(fnSource(dust, name)) === norm(fnSource(po, name)));
  }
  const block = dust.slice(dust.indexOf('(function dustPurchaseOrders()'), dust.indexOf('SCHEDULED REPORTS'));
  assert('the tab is one block', block.length > 1000);
  assert('it never PUTs a list', !/'PUT'|"PUT"|method:\s*'PUT'/.test(block));
  assert('it reads numbers through the page\'s own copy of api/lib/numeric.js',
    /parseFloat\(_normalizeNumeric\(v\)\)/.test(block) && !/function _normalizeNumeric/.test(block));
  assert('it writes no user value into a handler\'s source', !/onclick=|oninput=|onchange=/.test(block));
  assert('the attachments go to dust\'s own vault', /division:\s+DPO_DIVISION/.test(block) && /const DPO_DIVISION = 'dust';/.test(block));
  assert('documents.js is loaded for the paperclip', /<script src="documents\.js" defer><\/script>/.test(dust));
  // The three-way merge: both pages name the same fields, grouped the same
  // way, as the server does.
  const sync = read('api/lib/po-sync.js');
  const grab = (src, re) => { const m = re.exec(src); return m ? m[1].replace(/\s+/g, '') : null; };
  const srvGroups = grab(sync, /const MERGE_HEADER_GROUPS = (\[[\s\S]*?\]);/);
  const srvLines  = grab(sync, /const MERGE_LINE_KEYS = (\[[^\]]*\]);/);
  assert('the dust tab merges the fields the server merges',
    srvGroups && grab(dust, /const DPO_MERGE_HEADER_GROUPS = (\[[\s\S]*?\]);/) === srvGroups
    && grab(dust, /const DPO_MERGE_LINE_KEYS = (\[[^\]]*\]);/) === srvLines);
  assert('and so does the Purchase Orders page',
    grab(po, /const MERGE_HEADER_GROUPS = (\[[\s\S]*?\]);/) === srvGroups
    && grab(po, /const MERGE_LINE_KEYS = (\[[^\]]*\]);/) === srvLines);
}

(async () => {
  try {
    await catalogChecks();
    await syncChecks();
    await fixChecks();
    sourceChecks();
  } catch (err) {
    failed++;
    console.error('\nTest run crashed:', err && err.stack || err);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
