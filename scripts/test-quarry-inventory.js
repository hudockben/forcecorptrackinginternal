'use strict';

/**
 * Quarry Inventory tab — end-to-end check of the running-balance math.
 *
 * Loads quarry.html in jsdom with stubbed blob endpoints, switches to the
 * Inventory tab, and asserts the rendered numbers. The balance under test:
 *
 *   on hand = opening + produced (Crushing) − sold (Sales) + adjustments
 *
 * Run: node scripts/test-quarry-inventory.js   (needs jsdom: npm i --no-save jsdom)
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'quarry.html');
const AS_OF     = '2026-07-30';

// ── Fixture ────────────────────────────────────────────────────────────────
// Homer City: 10% jaws→screen loss. McGees Mills: none configured.
const CRUSH = [
  // 10 loads × 20 t = 200 t to crusher → 180 sellable. Cost 30×8 + 50×4 = 440.
  { id: 'c1', date: '2026-03-10', locationName: 'Homer City',   hourlyRate: 30, hours: 8,
    fuelGallons: 50, fuelCost: 4, loadsToCrusher: 10, tonsPerLoad: 20, hoursCrushing: 6 },
  // 5 loads × 20 t = 100 t, no loss configured → 100 sellable.
  { id: 'c2', date: '2026-04-05', locationName: 'McGees Mills', hourlyRate: 0,  hours: 0,
    fuelGallons: 0,  fuelCost: 0, loadsToCrusher: 5,  tonsPerLoad: 20, hoursCrushing: 4 },
  // Dated past the As-Of cutoff → excluded, and flagged in the warning banner.
  { id: 'c3', date: '2026-12-31', locationName: 'Homer City',   loadsToCrusher: 99, tonsPerLoad: 20 },
  // No date → excluded, and flagged.
  { id: 'c4', date: '',           locationName: 'Homer City',   loadsToCrusher: 7,  tonsPerLoad: 20 },
];
const SALES = [
  { id: 's1', date: '2026-03-15', locationName: 'Homer City',   productName: '2A Modified', tons: 50, pricePerTon: 12, payment: 'Cash' },
  { id: 's2', date: '2026-05-01', locationName: 'Homer City',   productName: 'Rip Rap',     tons: 30, pricePerTon: 10, payment: 'Credit' },
  { id: 's3', date: '2026-04-10', locationName: 'McGees Mills', productName: '2A Modified', tons: 20, pricePerTon: 15, payment: 'Cash' },
  // Dated on/before Homer City's opening count → excluded (already in the pile).
  { id: 's4', date: '2026-01-15', locationName: 'Homer City',   productName: 'Rip Rap',     tons: 40, pricePerTon: 9,  payment: 'Cash' },
];
const INVENTORY = {
  basis: 'final',
  openings: { 'Homer City': { tons: 500, asOf: '2026-01-31' } },
  adjustments: [
    { id: 'a1', date: '2026-06-01', locationName: 'Homer City', tons: -25, reason: 'Waste / Fines Removed', comments: 'fines hauled off' },
  ],
};
const LOSS_PCT = { 'Homer City': 10 };
const LISTS = {
  location: [{ id: 'l1', name: 'Homer City' }, { id: 'l2', name: 'McGees Mills' }],
  product:  [{ id: 'p1', name: '2A Modified' }, { id: 'p2', name: 'Rip Rap' }],
  customer: [], equipment: [], tasks: [], employees: [],
};

const BLOBS = {
  fct_quarry_lists:     LISTS,
  fct_quarry_crushing:  CRUSH,
  fct_quarry_sales:     SALES,
  fct_quarry_daily:     [],
  fct_quarry_inventory:  INVENTORY,
  fct_quarry_loss_pct:  LOSS_PCT,
  fct_presence:         {},
};

// Expected on-hand:
//   Homer City   = 500 + 180 − (50 + 30) − 25 = 575
//   McGees Mills =   0 + 100 −  20             =  80
const EXPECT_HOMER  = 575;
const EXPECT_MCGEES = 80;
const EXPECT_TOTAL  = EXPECT_HOMER + EXPECT_MCGEES;

// ── Harness ────────────────────────────────────────────────────────────────
let failures = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}
function checkIncludes(label, haystack, needle) {
  const ok = String(haystack).includes(needle);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `: ${JSON.stringify(String(haystack).slice(0, 300))} is missing ${JSON.stringify(needle)}`}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function stubFetch(blobs, writes, gate) {
  return async (url, init) => {
    const u = String(url);
    const m = /\/api\/data\/([^?]+)/.exec(u);
    const key = m ? decodeURIComponent(m[1]) : '';
    if (m && (!init || !init.method || init.method === 'GET')) {
      // Optionally hold one key back so the tab paints before its data lands.
      if (gate && gate.key === key) await gate.promise;
      return {
        ok: true, status: 200,
        json: async () => ({ value: Object.prototype.hasOwnProperty.call(blobs, key) ? blobs[key] : null }),
        text: async () => '',
      };
    }
    if (m && init && init.method === 'PUT') {
      let body = null;
      try { body = JSON.parse(init.body).value; } catch { /* ignore */ }
      writes.push({ key, value: body });
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
}

function loadPage(blobs, writes, gate) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/quarry.html',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.localStorage.setItem('fct_token', 'test-token');
      win.localStorage.setItem('fct_user', JSON.stringify({
        userId: 1, username: 'tester', name: 'Test User', companyCode: 'TEST', companyName: 'Test Co',
      }));
      win.fetch = stubFetch(blobs, writes, gate);
      win.alert = (msg) => console.log('  [alert suppressed]', String(msg).slice(0, 120));
      win.print = () => {};
      const errs = [];
      win.__errors = errs;
      win.addEventListener('error', e => errs.push(e.message || String(e.error)));
    },
  });
}

async function main() {
  const writes = [];
  const dom = loadPage(BLOBS, writes);
  const win = dom.window;
  const doc = win.document;

  // Wait for the page's initial blob loads to settle.
  for (let i = 0; i < 60 && !/entr/i.test(doc.getElementById('salesSummary')?.textContent || ''); i++) await sleep(25);

  const scriptErrors = (win.__errors || []).filter(Boolean);
  check('no uncaught script errors on load', scriptErrors.length ? scriptErrors.join(' | ') : 0, 0);

  // ── The tab itself ──
  const tabBtn = doc.querySelector('.tab-btn[data-tab="inventory"]');
  check('Inventory tab button exists', !!tabBtn, true);
  check('Inventory tab label', tabBtn && tabBtn.textContent.trim(), 'Inventory');
  check('Inventory panel exists', !!doc.getElementById('tab-inventory'), true);

  win.switchTab('inventory');
  for (let i = 0; i < 80 && /Loading/i.test(doc.getElementById('inventorySubtitle').textContent); i++) await sleep(25);
  check('Inventory panel is active', doc.getElementById('tab-inventory').classList.contains('active'), true);

  // Pin the As-Of cutoff so the assertions don't drift with the clock.
  win.setInventoryAsOf(AS_OF);

  const txt = (id) => (doc.getElementById(id) || {}).textContent || '';
  const num = (id) => Number(txt(id).replace(/[^0-9.\-]/g, ''));

  // ── Division-total KPIs ──
  console.log('\n— Division totals (final-screen basis) —');
  check('Tons On Hand',      num('invKpiOnHand'),   EXPECT_TOTAL);
  check('Produced to Date',  num('invKpiProduced'), 280);            // 180 + 100
  check('Sold to Date',      num('invKpiSold'),     100);            // 50 + 30 + 20
  check('Opening Balance',   num('invKpiOpening'),  500);
  check('Adjustments',       txt('invKpiAdj').trim(), '-25');
  // Value: Homer 575 × (440/180) + McGees 80 × 0 = 1,405.56
  check('Inventory Value',   txt('invKpiValue').trim(), '$1,405.56');

  // ── Per-pit cards ──
  console.log('\n— Per-location cards —');
  check('card count (2 pits + division total)',
    doc.querySelectorAll('#inventoryLocationCards .loc-card').length, 3);
  // Re-query every time — each render replaces the cards wholesale.
  const cardFor = (name) => [...doc.querySelectorAll('#inventoryLocationCards .loc-card')]
    .find(c => c.querySelector('.loc-card-name').textContent.trim() === name);
  const onHandOf = (name) => {
    const c = cardFor(name);
    return c ? Number(c.querySelector('.loc-kpi.is-onhand .loc-kpi-value').textContent.replace(/[^0-9.\-]/g, '')) : null;
  };
  check('Homer City on hand',   onHandOf('Homer City'),     EXPECT_HOMER);
  check('McGees Mills on hand', onHandOf('McGees Mills'),   EXPECT_MCGEES);
  check('Division Total card',  onHandOf('Division Total'), EXPECT_TOTAL);
  checkIncludes('Homer City card shows the roll-forward',
    cardFor('Homer City').querySelector('.loc-kpi.is-onhand .loc-kpi-sub').textContent,
    'Opening 500 + produced 180 − sold 80');
  checkIncludes('Homer City card names its screen loss',
    cardFor('Homer City').textContent, 'After 10.0% screen loss');
  checkIncludes('McGees Mills card flags the missing loss %',
    cardFor('McGees Mills').textContent, 'No loss % set');

  // ── Roll-forward table ──
  console.log('\n— Roll-forward table —');
  const rollRows = [...doc.querySelectorAll('#inventoryLocationTable tbody tr')];
  check('roll-forward row count', rollRows.length, 3);
  const cellsOf = (tr) => [...tr.children].map(td => td.textContent.trim());
  const homerRow = cellsOf(rollRows.find(tr => tr.children[0].textContent.includes('Homer City')));
  check('Homer City opening cell', homerRow[1], '500 (2026-01-31)');
  check('Homer City tons crushed', homerRow[2], '200');
  check('Homer City loss %',       homerRow[3], '10.0%');
  check('Homer City produced',     homerRow[4], '180');
  check('Homer City sold',         homerRow[5], '80');
  check('Homer City adjustments',  homerRow[6], '-25');
  check('Homer City on hand',      homerRow[7], '575');
  check('Homer City cost / ton',   homerRow[8], '$2.44');            // 440 / 180
  check('Homer City last crushed', homerRow[10], '2026-03-10');
  check('Homer City last sold',    homerRow[11], '2026-05-01');
  const totalRow = cellsOf(rollRows.find(tr => tr.classList.contains('inv-row-total')));
  check('division total on hand',  totalRow[7], String(EXPECT_TOTAL));

  // ── Monthly movement: the running balance must land on the same number ──
  console.log('\n— Monthly movement —');
  const monthRows = [...doc.querySelectorAll('#inventoryMonthlyTable tbody tr')].map(cellsOf);
  check('opening row',          monthRows[0].slice(0, 2).join('|'), 'Opening balance|—');
  check('opening ending bal',   monthRows[0][5], '500');
  check('month rows (Mar–Jun)', monthRows.length - 1, 4);
  check('Mar 2026 label',       monthRows[1][0], 'Mar 2026');
  check('Mar 2026 produced',    monthRows[1][1], '180');
  check('Mar 2026 sold',        monthRows[1][2], '50');
  check('Mar 2026 net',         monthRows[1][4], '+130');
  check('Mar 2026 ending',      monthRows[1][5], '630');
  check('Apr 2026 ending',      monthRows[2][5], '710');            // +100 − 20
  check('May 2026 ending',      monthRows[3][5], '680');            // − 30
  check('Jun 2026 adjustments', monthRows[4][3], '-25');
  check('running balance reconciles with on hand', monthRows[4][5], String(EXPECT_TOTAL));

  // ── Excluded rows are surfaced, not silently dropped ──
  console.log('\n— Excluded-row warning —');
  const warn = doc.getElementById('inventoryWarning');
  check('warning is visible', !warn.classList.contains('is-hidden'), true);
  checkIncludes('undated row reported',      warn.textContent, '1 entry has no date');
  checkIncludes('future-dated row reported', warn.textContent, `1 dated after ${AS_OF}`);
  checkIncludes('pre-opening row reported',  warn.textContent, "1 dated on or before a pit's opening count");

  // ── Sold-by-product breakdown (scoped to the visible pits) ──
  console.log('\n— Sold by product —');
  const prodRows = [...doc.querySelectorAll('#inventoryProductTable tbody tr')].map(cellsOf);
  check('product row count', prodRows.length, 2);
  check('top product',       prodRows[0][0], '2A Modified');
  check('top product tons',  prodRows[0][1], '70');                 // 50 + 20, excludes the pre-opening sale
  check('2nd product tons',  prodRows[1][1], '30');

  // ── Basis toggle: raw jaws tonnage instead of final screen tons ──
  console.log('\n— Basis toggle —');
  win.setInventoryBasis('crusher');
  check('Homer City on hand on jaws basis', onHandOf('Homer City'), 595);   // 500 + 200 − 80 − 25
  check('total produced on jaws basis',     num('invKpiProduced'), 300);
  win.setInventoryBasis('final');
  check('on hand restored on final basis',  num('invKpiOnHand'), EXPECT_TOTAL);

  // ── Location filter narrows every section ──
  console.log('\n— Location filter —');
  win.locationFilterSetForTest = null;
  const locFilter = doc.getElementById('inventoryLocationFilter');
  const homerCb = [...locFilter.querySelectorAll('.ms-menu input[type="checkbox"]')]
    .find(cb => cb.value === 'McGees Mills');
  check('filter option for McGees Mills exists', !!homerCb, true);
  homerCb.checked = true;
  win.msOnCheck('inventory', 'location', homerCb);
  check('filtered on-hand KPI', num('invKpiOnHand'), EXPECT_MCGEES);
  check('filtered card count', doc.querySelectorAll('#inventoryLocationCards .loc-card').length, 1);
  checkIncludes('monthly title names the scope',
    doc.getElementById('inventoryMonthlyTitle').textContent, 'McGees Mills');
  win.msClear('inventory', 'location');
  check('cleared filter restores total', num('invKpiOnHand'), EXPECT_TOTAL);

  // ── Adjustments ledger renders + edits ──
  console.log('\n— Adjustments ledger —');
  const adjRows = [...doc.querySelectorAll('#invAdjTbody tr')];
  check('ledger row count', adjRows.length, 1);
  checkIncludes('ledger summary', txt('invAdjSummary'), 'Net');
  win.addInvAdjRow();
  check('add row appends to the ledger', doc.querySelectorAll('#invAdjTbody tr').length, 2);
  // New row is index 0 in the store (unshift); give it tons and confirm the balance moves.
  win.updateInvAdjTons(0, '15');
  win.updateInvAdjCell(0, 'date', '2026-07-01');
  win.cbDispatch('inv:0', 'location', 'McGees Mills');
  check('new adjustment moves the balance', num('invKpiOnHand'), EXPECT_TOTAL + 15);
  // A tons edit must refresh the balances without rebuilding the ledger under
  // the cursor — otherwise the click that moved focus gets swallowed.
  const liveTonsInput = doc.querySelector('#invAdjTbody tr input[type="number"]');
  win.renderInventory(true, true);
  check('tons edit leaves the ledger inputs in place', doc.contains(liveTonsInput), true);
  win.renderInventory();
  check('a normal render does rebuild the ledger', doc.contains(liveTonsInput), false);
  win.deleteInvAdjRow(0);
  check('delete restores the balance', num('invKpiOnHand'), EXPECT_TOTAL);
  check('delete removes the row', doc.querySelectorAll('#invAdjTbody tr').length, 1);

  // ── Opening-balance editor ──
  console.log('\n— Opening balances editor —');
  const openRows = [...doc.querySelectorAll('#inventoryOpeningEditor .inv-open-row')];
  check('one editor row per configured pit', openRows.length, 2);
  const homerOpen = openRows.find(r => r.querySelector('.inv-open-loc').textContent.trim() === 'Homer City');
  check('Homer City opening tons prefilled', homerOpen.querySelector('input[type="number"]').value, '500');
  check('Homer City as-of prefilled',        homerOpen.querySelector('input[type="date"]').value, '2026-01-31');
  const mcgeesOpen = openRows.find(r => r.querySelector('.inv-open-loc').textContent.trim() === 'McGees Mills');
  const mcgeesTons = mcgeesOpen.querySelector('input[type="number"]');
  mcgeesTons.value = '250';
  win.onInvOpeningTons(mcgeesTons);
  check('opening balance feeds straight into on hand', num('invKpiOnHand'), EXPECT_TOTAL + 250);
  const restored = [...doc.querySelectorAll('#inventoryOpeningEditor .inv-open-row')]
    .find(r => r.querySelector('.inv-open-loc').textContent.trim() === 'McGees Mills')
    .querySelector('input[type="number"]');
  restored.value = '';
  win.onInvOpeningTons(restored);
  check('clearing the opening balance restores on hand', num('invKpiOnHand'), EXPECT_TOTAL);

  // ── Totals have to foot: on hand × cost/ton must equal inventory value ──
  // Each pile carries its own cost, so the division rate is on-hand-weighted.
  console.log('\n— Total row foots —');
  const money = (s) => Number(String(s).replace(/[^0-9.\-]/g, ''));
  const tot = cellsOf([...doc.querySelectorAll('#inventoryLocationTable tbody tr')]
    .find(tr => tr.classList.contains('inv-row-total')));
  // Compare the rate the row implies (value ÷ on hand) against the rate the
  // row prints. Weighting the division rate by produced tons instead — the old
  // behaviour — lands ~27% off on this fixture, well outside cent rounding.
  check('total cost/ton is the on-hand-weighted rate',
    (money(tot[9]) / money(tot[7])).toFixed(2), money(tot[8]).toFixed(2));
  const homer = cellsOf([...doc.querySelectorAll('#inventoryLocationTable tbody tr')]
    .find(tr => tr.children[0].textContent.includes('Homer City')));
  check('per-pit cost/ton is consistent with its value',
    (money(homer[9]) / money(homer[7])).toFixed(2), money(homer[8]).toFixed(2));
  const mcgees = cellsOf([...doc.querySelectorAll('#inventoryLocationTable tbody tr')]
    .find(tr => tr.children[0].textContent.includes('McGees Mills')));
  check('total value is the sum of the pit values',
    (money(homer[9]) + money(mcgees[9])).toFixed(2), money(tot[9]).toFixed(2));
  check('KPI value matches the total row', money(txt('invKpiValue')), money(tot[9]));

  // ── Tons with no crushing behind them carry no cost — say so, don't hide it ──
  // As-Of before any crushing: Homer City's 500-ton opening is all that's left,
  // and there is no production rate to value it at.
  console.log('\n— Uncosted tonnage —');
  win.setInventoryAsOf('2026-02-01');
  check('on hand is the opening balance alone', num('invKpiOnHand'), 500);
  check('nothing produced in the window', num('invKpiProduced'), 0);
  check('value is zero without a cost basis', money(txt('invKpiValue')), 0);
  checkIncludes('the uncosted tonnage is called out',
    txt('invKpiValueSub'), '500 tons on hand with no crushing cost basis');
  win.setInventoryAsOf(AS_OF);
  checkIncludes('normal window reports the carrying rate', txt('invKpiValueSub'), 'Carried at $');

  // ── The As-Of picker cleared means no cutoff at all, not "through today" ──
  console.log('\n— No-cutoff labelling —');
  win.setInventoryAsOf('');
  checkIncludes('subtitle says there is no cutoff',
    txt('inventorySubtitle'), 'counted with no date cutoff');
  check('future-dated crushing now counts', num('invKpiProduced'), 280 + (99 * 20 * 0.9));
  win.setInventoryAsOf(AS_OF);
  check('restoring the cutoff restores the balance', num('invKpiOnHand'), EXPECT_TOTAL);

  // ── A negative opening balance is rejected, not quietly applied ──
  console.log('\n— Negative opening balance —');
  const negInput = [...doc.querySelectorAll('#inventoryOpeningEditor .inv-open-row')]
    .find(r => r.querySelector('.inv-open-loc').textContent.trim() === 'McGees Mills')
    .querySelector('input[type="number"]');
  negInput.value = '-400';
  win.onInvOpeningTons(negInput);
  check('negative opening does not move the balance', num('invKpiOnHand'), EXPECT_TOTAL);
  check('negative opening field reverts to blank',
    [...doc.querySelectorAll('#inventoryOpeningEditor .inv-open-row')]
      .find(r => r.querySelector('.inv-open-loc').textContent.trim() === 'McGees Mills')
      .querySelector('input[type="number"]').value, '');

  // ── The excluded-row banner reports only what the filter has in view ──
  console.log('\n— Warning respects the location filter —');
  const mcgeesCb = [...doc.getElementById('inventoryLocationFilter')
    .querySelectorAll('.ms-menu input[type="checkbox"]')].find(cb => cb.value === 'McGees Mills');
  mcgeesCb.checked = true;
  win.msOnCheck('inventory', 'location', mcgeesCb);
  check('Homer City exclusions are not reported while viewing McGees Mills',
    doc.getElementById('inventoryWarning').classList.contains('is-hidden'), true);
  win.msClear('inventory', 'location');
  check('unfiltered view reports them again',
    doc.getElementById('inventoryWarning').classList.contains('is-hidden'), false);

  // ── Persistence: only basis / openings / adjustments go to the blob ──
  // Saves coalesce behind one in-flight PUT, so let the queue drain first.
  console.log('\n— Persistence —');
  await sleep(100);
  const invWrites = writes.filter(w => w.key === 'fct_quarry_inventory');
  check('inventory edits PUT to fct_quarry_inventory', invWrites.length > 0, true);
  const last = invWrites[invWrites.length - 1].value;
  check('saved shape', Object.keys(last).sort().join(','), 'adjustments,basis,openings');
  check('saved basis', last.basis, 'final');
  check('saved opening for Homer City', JSON.stringify(last.openings['Homer City']), '{"tons":500,"asOf":"2026-01-31"}');
  check('saved adjustment count', last.adjustments.length, 1);
  check('saved adjustment tons', last.adjustments[0].tons, -25);
  check('as-of cutoff is view state, never persisted', 'asOf' in last, false);
  check('no crushing or sales rows were written', writes.some(w => w.key === 'fct_quarry_crushing' || w.key === 'fct_quarry_sales'), false);

  // ── Print / PDF export ──
  console.log('\n— Print / PDF —');
  let printed = '';
  win.open = () => ({
    document: { write: (s) => { printed += s; }, close: () => {} },
  });
  win.downloadInventoryPDF();
  check('export produced a document', printed.length > 500, true);
  checkIncludes('export titled for the pit scope', printed, 'Quarry Inventory &mdash; All Pits');
  checkIncludes('export states the as-of date', printed, `As of ${AS_OF}`);
  checkIncludes('export states the balance formula', printed, 'On hand = opening + produced');
  checkIncludes('export carries the roll-forward table', printed, 'Inventory Roll-Forward by Location');
  checkIncludes('export carries the monthly movement', printed, 'Monthly Movement');
  checkIncludes('export self-prints on load', printed, 'window.print()');

  // ── Other tabs still work (no regressions from the shared filter plumbing) ──
  console.log('\n— Existing tabs —');
  win.switchTab('crushing');
  await sleep(60);
  check('crushing tab still renders rows', doc.querySelectorAll('#crushTbody tr').length > 0, true);
  checkIncludes('crushing month filter still renders',
    doc.getElementById('crushingMonthFilter').innerHTML, 'All Months');
  win.switchTab('home');
  await sleep(60);
  check('home tab still renders location cards',
    doc.querySelectorAll('#homeLocationCards .loc-card').length > 0, true);
  win.switchTab('analytics');
  await sleep(60);
  check('analytics tab still renders its location table',
    doc.querySelectorAll('#analyticsLocationTable tbody tr').length > 0, true);

  const lateErrors = (win.__errors || []).filter(Boolean);
  check('no uncaught script errors overall', lateErrors.length ? lateErrors.join(' | ') : 0, 0);
  dom.window.close();

  // ── Empty division: every section must degrade to an empty state ──
  console.log('\n— Empty division —');
  const emptyWrites = [];
  const emptyDom = loadPage({
    fct_quarry_lists: null, fct_quarry_crushing: [], fct_quarry_sales: [],
    fct_quarry_daily: [], fct_quarry_inventory: null, fct_quarry_loss_pct: null, fct_presence: {},
  }, emptyWrites);
  const ewin = emptyDom.window, edoc = emptyDom.window.document;
  await sleep(200);
  ewin.switchTab('inventory');
  for (let i = 0; i < 80 && /Loading/i.test(edoc.getElementById('inventorySubtitle').textContent); i++) await sleep(25);
  check('empty on-hand KPI', edoc.getElementById('invKpiOnHand').textContent, '0');
  checkIncludes('empty subtitle prompts for entries',
    edoc.getElementById('inventorySubtitle').textContent, 'Add entries with a Location');
  checkIncludes('empty cards show a prompt',
    edoc.getElementById('inventoryLocationCards').textContent, 'No inventory yet');
  checkIncludes('empty roll-forward shows a prompt',
    edoc.querySelector('#inventoryLocationTable tbody').textContent, 'No inventory to roll forward');
  checkIncludes('empty monthly movement shows a prompt',
    edoc.querySelector('#inventoryMonthlyTable tbody').textContent, 'No dated crushing, sales, or adjustment activity');
  checkIncludes('empty ledger shows a prompt',
    edoc.getElementById('invAdjTbody').textContent, 'No adjustments');
  checkIncludes('empty openings editor points at Manage Lists',
    edoc.getElementById('inventoryOpeningEditor').textContent, 'No locations yet');
  check('warning banner stays hidden with nothing to warn about',
    edoc.getElementById('inventoryWarning').classList.contains('is-hidden'), true);
  check('adding an adjustment works from empty', (() => {
    ewin.addInvAdjRow();
    return edoc.querySelectorAll('#invAdjTbody tr').length;
  })(), 1);
  check('no writes fired before the user touched anything',
    emptyWrites.filter(w => w.key === 'fct_quarry_inventory').length, 1);
  const emptyErrors = (ewin.__errors || []).filter(Boolean);
  check('no uncaught script errors on the empty division',
    emptyErrors.length ? emptyErrors.join(' | ') : 0, 0);
  emptyDom.window.close();

  // ── Editing while the blob is still in flight must not clobber the server ──
  // The tab paints before its data lands; an unguarded edit in that window
  // would PUT an empty store over the real openings and adjustments.
  console.log('\n— Edits during load —');
  const raceWrites = [];
  let release;
  const raceDom = loadPage(BLOBS, raceWrites,
    { key: 'fct_quarry_inventory', promise: new Promise(r => { release = r; }) });
  const rwin = raceDom.window, rdoc = raceDom.window.document;
  await sleep(250);
  rwin.switchTab('inventory');
  await sleep(150);   // painted, blob still in flight
  const raceOpenRows = [...rdoc.querySelectorAll('#inventoryOpeningEditor .inv-open-row')];
  check('openings editor renders from Manage Lists while loading', raceOpenRows.length, 2);
  const raceTons = raceOpenRows[0].querySelector('input[type="number"]');
  check('opening tons input is locked while loading', raceTons.disabled, true);
  check('opening as-of input is locked while loading',
    raceOpenRows[0].querySelector('input[type="date"]').disabled, true);
  check('basis select is locked while loading', rdoc.getElementById('inventoryBasisSelect').disabled, true);
  check('add-adjustment button is locked while loading', rdoc.getElementById('invAdjAddBtn').disabled, true);
  // Fire the setters directly — the guard, not just the disabled attribute, has to hold.
  raceTons.value = '300';
  rwin.onInvOpeningTons(raceTons);
  rwin.setInventoryBasis('crusher');
  rwin.addInvAdjRow();
  await sleep(40);
  check('no inventory PUT fired before the blob landed',
    raceWrites.filter(w => w.key === 'fct_quarry_inventory').length, 0);
  release();
  for (let i = 0; i < 80 && /Loading/i.test(rdoc.getElementById('inventorySubtitle').textContent); i++) await sleep(25);
  rwin.setInventoryAsOf(AS_OF);
  check('server data survived the load race', num2(rdoc, 'invKpiOnHand'), EXPECT_TOTAL);
  check('controls unlock once loaded', rdoc.getElementById('inventoryBasisSelect').disabled, false);
  const raceErrors = (rwin.__errors || []).filter(Boolean);
  check('no uncaught script errors during the load race',
    raceErrors.length ? raceErrors.join(' | ') : 0, 0);
  raceDom.window.close();

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

function num2(d, id) {
  return Number(((d.getElementById(id) || {}).textContent || '').replace(/[^0-9.\-]/g, ''));
}

main().catch(err => { console.error(err); process.exit(1); });
