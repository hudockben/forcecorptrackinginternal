#!/usr/bin/env node
'use strict';
/**
 * The Dust "Other Billing" grid, rendered for real.
 *
 * Run: node scripts/test-dust-ob-tab.js
 *
 * The locking is greped structurally by test-dust-ob-injection.js; this loads
 * dust.html in jsdom and looks at the DOM it actually produces, because the
 * failure that matters is not "the branch is missing" but "the branch renders a
 * box anyway". A payroll row whose cells still hold inputs looks editable, takes
 * what is typed, and then loses it on the next save — the server replays its own
 * copy of those columns — with nothing on screen to say why.
 *
 * Asserts, against one injected row and one hand-added row side by side:
 *   - every payroll-owned column of the injected row is read-only text,
 *   - the invoice number and the comment are still inputs, because the dust
 *     office bills on them,
 *   - the delete button is a padlock,
 *   - the hand-added row beside it is untouched — every cell still editable,
 *     still deletable.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.resolve(__dirname, '../dust.html');
const OB_KEY    = 'dust_other_billing_rows';

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const INJECTED = {
  id: 'tso-41-1', date: '2026-08-04', inv_number: '', driver: 'John Doe',
  truck_number: '4000', trailer_number: 'TR-9', customer: 'CNX',
  destination: 'Bear Hollow', state: 'PA', material: 'ClearFrac',
  gallons_bags: 4000, mu: 'GAL', price_per_unit: 0.42,
  trucking_hrs: 10, trucking_rate: 95, comments: 'two loads',
  start_time: '06:00', end_time: '16:00',
};
const MANUAL = {
  id: 'm8x2p1', date: '2026-08-05', inv_number: '', driver: 'Pat Reilly',
  truck_number: '4000', trailer_number: '', customer: 'CNX',
  destination: 'Bear Hollow', state: 'PA', material: 'ClearFrac',
  gallons_bags: '500', mu: 'GAL', price_per_unit: '0.42',
  trucking_hrs: '2', trucking_rate: '95', comments: '',
};

const BLOBS = { [OB_KEY]: [INJECTED, MANUAL] };

const DUST_CONFIG = {
  settings: { ub_rate: 0.35 },
  lists: {
    equipment: [{ id: 1, name: 'Distributor Truck 4000', unit_number: '4000', vehicle_rate: 120 }],
    employees: ['John Doe', 'Pat Reilly'],
    materials: ['ClearFrac'],
    states:    ['PA', 'WV'],
    mu:        ['GAL', 'BAG'],
    companies: [{
      id: 'co-1', name: 'CNX', v1_rate: 130, v2_rate: 65,
      locations: [{ id: 1, name: 'Bear Hollow', state: 'PA' }],
      men:       [{ id: 1, name: 'Bill Reed' }],
    }],
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function stubFetch(writes) {
  return async (url, init) => {
    const u  = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (init && init.method && init.method !== 'GET') {
      const m = /\/api\/data\/([^?]+)/.exec(u);
      if (m) {
        let body = null;
        try { body = JSON.parse(init.body).value; } catch { /* ignore */ }
        writes.push({ key: decodeURIComponent(m[1]), value: body });
      }
      return ok({ ok: true });
    }
    if (u.includes('/api/dust-config'))  return ok(DUST_CONFIG);
    if (u.includes('/api/dust-rows'))    return ok({ rows: [] });
    if (u.includes('/api/dust-audit'))   return ok({ events: [] });
    const m = /\/api\/data\/([^?]+)/.exec(u);
    if (m) {
      const key = decodeURIComponent(m[1]).split('?')[0];
      return ok({ value: Object.prototype.hasOwnProperty.call(BLOBS, key) ? BLOBS[key] : null,
                  updated_at: '2026-08-04T00:00:00.000Z' });
    }
    return ok({});
  };
}

// The cell at `col` of the row whose id is `rowId`, by the column order the
// Other Billing table's own header declares.
const COLS = {
  expand: 0, date: 1, inv_number: 2, driver: 3, truck_number: 4, trailer_number: 5,
  customer: 6, destination: 7, state: 8, material: 9, gallons_bags: 10, mu: 11,
  price_per_unit: 12, trucking_hrs: 13, trucking_rate: 14, comments: 15,
  total: 16, del: 17,
};

async function main() {
  const writes = [];
  const dom = new JSDOM(fs.readFileSync(HTML_PATH, 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/dust.html',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.localStorage.setItem('fct_token', 'test-token');
      win.localStorage.setItem('fct_user', JSON.stringify({
        userId: 1, username: 'tester', companyCode: 'TEST', companyName: 'Test Co',
        allowedDivisions: ['dust'],
      }));
      win.fetch = stubFetch(writes);
      win.alert = () => {};
      win.confirm = () => true;
      win.print = () => {};
      win.__errors = [];
      win.addEventListener('error', e => win.__errors.push(e.message || String(e.error)));
    },
  });
  const win = dom.window, doc = win.document;

  // The OB rows load in the background after init, then the tab paints.
  for (let i = 0; i < 120; i++) {
    const n = doc.querySelectorAll('#obTbody tr[data-idx]').length;
    if (n >= 2) break;
    if (i === 20) { try { win.eval('obRenderTable()'); } catch (_) {} }
    await sleep(25);
  }

  console.log('Dust Other Billing tab — a payroll row rendered\n');
  console.log('[the page itself]');
  const errs = (win.__errors || []).filter(Boolean);
  assert('no uncaught script errors on load', errs.length === 0, errs.join(' | '));

  const trs = [...doc.querySelectorAll('#obTbody tr[data-idx]')];
  assert('both rows render', trs.length === 2, String(trs.length));
  if (trs.length !== 2) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }

  const byId = {};
  for (const tr of trs) {
    const idx = Number(tr.getAttribute('data-idx'));
    byId[win.eval(`obRows[${idx}].id`)] = tr;
  }
  const injected = byId['tso-41-1'];
  const manual   = byId['m8x2p1'];
  assert('the payroll row is on screen', !!injected);
  assert('and the hand-added one beside it', !!manual);
  if (!injected || !manual) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }

  const cell = (tr, col) => tr.children[COLS[col]];
  const editable = (tr, col) => {
    const td = cell(tr, col);
    return !!td && !!td.querySelector('input, select, textarea');
  };

  console.log('\n[the payroll row is locked]');
  const LOCKED = ['date', 'driver', 'truck_number', 'trailer_number', 'customer',
                  'destination', 'state', 'material', 'gallons_bags', 'mu',
                  'price_per_unit', 'trucking_hrs', 'trucking_rate'];
  for (const col of LOCKED) {
    assert(`${col} is read-only text`, !editable(injected, col),
      cell(injected, col) ? cell(injected, col).innerHTML.slice(0, 80) : 'no cell');
  }
  assert('and still shows its value',
    cell(injected, 'material').textContent.trim() === 'ClearFrac',
    cell(injected, 'material').textContent);
  assert('the hours it billed are the haul\'s window',
    cell(injected, 'trucking_hrs').textContent.trim() === '10');
  assert('the delete button is gone', !cell(injected, 'del').querySelector('button'));
  assert('replaced by a padlock', /🔒|&#128274;|\u{1F512}/u.test(cell(injected, 'del').innerHTML));
  assert('the row says where it came from',
    /Timesheet/.test(cell(injected, 'total').innerHTML));
  assert('and the whole row carries the explanation',
    /edit it in Payroll/i.test(injected.getAttribute('title') || ''));

  console.log('\n[but the office still bills on it]');
  assert('the invoice number is editable', editable(injected, 'inv_number'));
  assert('and the comment is too', editable(injected, 'comments'));

  console.log('\n[the hand-added row is untouched]');
  for (const col of LOCKED) {
    assert(`${col} is still editable`, editable(manual, col));
  }
  assert('and it can still be deleted', !!cell(manual, 'del').querySelector('button'));

  console.log('\n[a locked cell cannot be written even from script]');
  const before = win.eval("JSON.stringify(obRows.find(r => r.id === 'tso-41-1'))");
  win.eval("obSet(obRows.findIndex(r => r.id === 'tso-41-1'), 'material', 'Sand')");
  win.eval("obSetCustomer(obRows.findIndex(r => r.id === 'tso-41-1'), 'Antero')");
  const after = win.eval("JSON.stringify(obRows.find(r => r.id === 'tso-41-1'))");
  assert('the payroll columns are unchanged', before === after, after);
  win.eval("obSet(obRows.findIndex(r => r.id === 'tso-41-1'), 'inv_number', 'INV-77')");
  assert('while the invoice number takes the edit',
    win.eval("obRows.find(r => r.id === 'tso-41-1').inv_number") === 'INV-77');

  console.log(`\n${passed} passed, ${failed} failed`);
  dom.window.close();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
