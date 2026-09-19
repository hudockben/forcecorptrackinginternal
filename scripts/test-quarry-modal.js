#!/usr/bin/env node
'use strict';
/**
 * Payroll's cost-tracking modals — the guards that stop a save writing over a
 * row it never managed to read.
 *
 * Run: node scripts/test-quarry-modal.js
 *
 * Editing an approved quarry entry works by pre-fill: the modal opens on blank
 * boxes, then fetches the row the entry already injected (?action=split) and
 * re-renders from it. Saving posts whatever is in the boxes, and the server
 * rewrites the injected row from that — so any path where the pre-fill silently
 * does not happen is a path where Save wipes the rate, equipment, task, fuel and
 * quantities the quarry office bills from.
 *
 * Three of those paths existed:
 *   - the lookup answered 403 or 500, whose JSON body parses like any other and
 *     was read as "this entry has no row",
 *   - the lookup threw, and the catch kept the blank boxes,
 *   - a lookup for one entry landed after the modal had moved to another.
 *
 * The turf/paving Edit Split modal fails the same way and worse: it falls back
 * to its own defaults — one labor row for the whole day — which are a perfectly
 * valid split, so the save lands, reports success, and replaces every cost code,
 * sub code, quantity and equipment line the supervisor had entered.
 *
 * Two layers, following test-dust-split-modal.js:
 *   1. Structural — the guards exist and sit in the right order in payroll.html,
 *      for both modals.
 *   2. Behavioural — quarrySave itself is run in a vm against a stubbed DOM, and
 *      asserted to refuse exactly when the posted row is unknown, and to go
 *      through when it is known or when there is nothing to know.
 *
 * The fuel boxes are covered here too, for a different failure: the form used to
 * take a dollar TOTAL and derive $/gal, supervisors read "Fuel Cost ($)" as the
 * pump price, and 190 gallons at a typed 4.50 was stored as $0.0237/gal — $4.50
 * of fuel for a day that burned $855. The typed box is the per-gallon price now.
 *
 * No DB, no browser.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const SRC = fs.readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');

const { sliceSource, evalSlice, requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
// Every marker in this file is hunted in the one page it reads, so the source
// is bound here rather than repeated at each call.
const slice = (from, to, label, must) => sliceSource(SRC, from, to, label, must);

console.log('Payroll cost-tracking modal guards\n');

// ── 1) Structural ───────────────────────────────────────────────────────────
console.log('[the pre-fill cannot be mistaken for an empty row]');
{
  const open = slice('async function openQuarryModal(entry, mode)', '\n    function closeQuarry()', 'openQuarryModal',
                     'function openQuarryModal(');
  assert('a refusal is thrown rather than read as "no row"',
    /if \(!res\.ok\) throw new Error/.test(open));
  assert('…before anything is taken from the body',
    open.includes('if (!res.ok) throw') && open.includes("quarryRowLoad = 'loaded'")
    && open.indexOf('if (!res.ok) throw') < open.indexOf("quarryRowLoad = 'loaded'"));
  assert('a late answer for another entry is dropped',
    /const seq = \+\+quarryFetchSeq/.test(open) && /if \(seq !== quarryFetchSeq\) return/.test(open));
  assert('and a failure is recorded rather than swallowed',
    /quarryRowLoad = 'failed'/.test(open) && !/keep blank fields on lookup failure/.test(open));
  assert('a fresh approve has nothing to load',
    /quarryRowLoad = mode === 'resplit' \? 'pending' : 'none'/.test(open));

  const close = slice('function closeQuarry()', 'bindBackdropClose(document.getElementById(\'quarryBackdrop\')', 'closeQuarry',
                      'function closeQuarry(');
  assert('closing orphans a pre-fill still in flight',
    /quarryFetchSeq\+\+/.test(close) && /quarryRowLoad = 'none'/.test(close));

  const save = slice('async function quarrySave()', '\n    // ──', 'quarrySave',
                     ['function quarrySave(', 'function unapproveEntry(']);
  assert('the save refuses while the posted row is unknown',
    /quarryRowLoad === 'pending' \|\| quarryRowLoad === 'failed'/.test(save));
  assert('…before it collects a single box',
    save.includes("quarryRowLoad === 'pending'")
    && save.indexOf("quarryRowLoad === 'pending'") < save.indexOf('collectQuarryFields(activity)'));
}

// ── 2) Behavioural ──────────────────────────────────────────────────────────
// quarrySave, run for real. Everything it reaches for is stubbed; the only
// thing under test is whether it posts.
function runSave(rowLoad, mode) {
  const boxes = {
    q_equipmentName: { value: 'Loader' }, q_taskName: { value: 'Stripping' },
    q_rate: { value: '42' }, q_fuelGallons: { value: '0' }, q_fuelPerGal: { value: '0' },
    q_hours: { value: '8' }, q_tons: { value: '' }, q_comments: { value: '' },
    quarrySaveBtn: { textContent: '', disabled: false },
    quarryMsg: {
      textContent: '', className: '',
      classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
    },
  };
  const posts = [];
  const ctx = {
    quarryEntry: { id: 7, username: 'strickallen', job_id: 'quarry:daily:homer', division: 'quarry' },
    quarryMode: mode,
    quarryRowLoad: rowLoad,
    quarryActivityOf: () => 'daily',
    collectQuarryFields: () => ({ equipmentName: 'Loader', taskName: 'Stripping', rate: '42' }),
    authHeaders: () => ({}),
    applyEntryUpdate: () => {}, renderRows: () => {}, renderStats: () => {},
    closeQuarry: () => {}, setTimeout: () => {},
    selectedIds: new Set(),
    _qval: id => (boxes[id] ? boxes[id].value : ''),
    fetch: (url, init) => {
      posts.push({ url, init });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, entry: null }) });
    },
    document: { getElementById: id => boxes[id] || null },
    console,
  };
  vm.createContext(ctx);
  evalSlice(slice('async function quarrySave()', '\n    // ──', 'quarrySave',
                  ['function quarrySave(', 'function unapproveEntry(']) + '\nquarrySave();', ctx, 'quarrySave');
  return { posts, msg: boxes.quarryMsg };
}

console.log('\n[what Save does when the row it should be correcting is unknown]');
{
  // Still in flight. The boxes are blank for a reason that has nothing to do
  // with the row, so posting them would blank the row.
  const pending = runSave('pending', 'resplit');
  assert('a save while the lookup is in flight posts nothing', pending.posts.length === 0);
  assert('and says to try again in a moment',
    /Still loading/.test(pending.msg.textContent) && pending.msg.classList.contains('error'),
    pending.msg.textContent);

  // The lookup failed — a refusal, a 500, or the network. Same blank boxes.
  const failed = runSave('failed', 'resplit');
  assert('a save after a failed lookup posts nothing', failed.posts.length === 0);
  assert('and says to reopen Edit Row',
    /close and reopen Edit Row/.test(failed.msg.textContent), failed.msg.textContent);
}

console.log('\n[and when it is known, or there is nothing to know]');
{
  const loaded = runSave('loaded', 'resplit');
  assert('an edit whose row came back saves normally', loaded.posts.length === 1);
  assert('as a resplit', /action=resplit/.test(loaded.posts[0].url), loaded.posts[0] && loaded.posts[0].url);

  // A fresh approve has no posted row to wipe: blank means blank there, exactly
  // as it always has.
  const fresh = runSave('none', 'approve');
  assert('a fresh approve is never blocked', fresh.posts.length === 1);
  assert('as an approve', /action=approve/.test(fresh.posts[0].url), fresh.posts[0] && fresh.posts[0].url);
}

// ── 3) Which fuel box is typed, and which is derived ────────────────────────
// quarryFieldsHtml / recalcQuarryFuelCost / collectQuarryFields, run for real
// against stubbed boxes. Getting this backwards is the bug they exist to stop.
const PRODUCTS = [{ id: 'p-2a', name: '2A Modified' }, { id: 'p-1', name: 'AASHTO #1' }];
function fuelCtx(boxes, products) {
  const ctx = {
    escapeHtml: v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    num2: n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2),
    Q_LABEL_STYLE: 'label', Q_INPUT_STYLE: 'input', Q_RO_STYLE: 'input;readonly-look',
    QUARRY_DEFAULT_RATE: 26,
    quarryEntry: { username: 'boringjamey' },
    quarryEmployeeRate: () => null,
    quarryEquipOptions: [], quarryTaskOptions: [],
    // The crushing form's Product picker reads this. Declared outside the
    // lifted region, so without it quarryFieldsHtml('crushing', …) dies with a
    // bare ReferenceError at call time rather than at eval time.
    quarryProductList: products === undefined ? PRODUCTS : products,
    _qval: id => (boxes[id] ? boxes[id].value : ''),
    document: { getElementById: id => boxes[id] || null },
    console,
  };
  vm.createContext(ctx);
  evalSlice(
    slice('function _qNumField(id, label, val, span)', '\n    function openQuarryModalById(', 'quarry fuel fields',
          'function quarryFieldsHtml('),
    ctx, 'the quarry fuel fields');
  return ctx;
}
// The <input …> tag carrying `id`, so readonly/value can be asserted per box.
function tagFor(html, id) {
  const m = new RegExp('<input[^>]*id="' + id + '"[^>]*>').exec(html);
  return m ? m[0] : '';
}

console.log('\n[the pump price is typed; the dollar total is the derived one]');
for (const activity of ['crushing', 'daily']) {
  // A row already on file: 190 gallons at $4.50/gal. Crushing keeps the
  // per-gallon rate in fuelCost, Daily in ppg — both hold $/gal, not dollars.
  const stored = activity === 'crushing'
    ? { fuelGallons: 190, fuelCost: 4.5 }
    : { fuelGallons: 190, ppg: 4.5 };
  const html   = fuelCtx({}).quarryFieldsHtml(activity, stored);
  const perGal = tagFor(html, 'q_fuelPerGal');
  const total  = tagFor(html, 'q_fuelCostAuto');

  assert(`${activity}: the $/gal box holds the stored per-gallon rate`,
    /value="4\.5"/.test(perGal), perGal);
  assert(`${activity}: …and is the box that can be typed in`,
    !!perGal && !/readonly/.test(perGal), perGal);
  assert(`${activity}: fuel cost reads gallons × $/gal`,
    /value="855\.00"/.test(total), total);
  assert(`${activity}: …read-only, so the total can't be typed in by mistake`,
    /readonly/.test(total), total);
}

console.log('\n[what the total does as the boxes are filled]');
{
  const boxes = {
    q_fuelGallons:  { value: '190' },
    q_fuelPerGal:   { value: '4.50' },
    q_fuelCostAuto: { value: '' },
  };
  const ctx = fuelCtx(boxes);
  ctx.recalcQuarryFuelCost();
  assert('190 gallons at $4.50 comes to $855.00', boxes.q_fuelCostAuto.value === '855.00',
    boxes.q_fuelCostAuto.value);

  boxes.q_fuelPerGal.value = '';
  ctx.recalcQuarryFuelCost();
  assert('and a half-filled pair shows nothing rather than $0.00',
    boxes.q_fuelCostAuto.value === '', boxes.q_fuelCostAuto.value);
}

// ── 4) The product the day was crushing ────────────────────────────────────
// Crushing Tracking has always had a Product column and injected rows always
// landed blank in it, so the tons were there and the material they were was
// not. The answer is asked for here, at the approval, and every figure that
// groups by material downstream depends on this one box.
console.log('\n[the material the day was crushing]');
{
  const stored = fuelCtx({}).quarryFieldsHtml('crushing', { productName: 'AASHTO #1' });
  const sel = /<select[^>]*id="q_productName"[\s\S]*?<\/select>/.exec(stored);
  assert('crushing asks which product, as a picker off the list', !!sel, stored.slice(0, 200));
  assert('…with the row\'s own product already selected',
    !!sel && /<option value="AASHTO #1" selected>/.test(sel[0]), sel && sel[0]);
  assert('…and every product on the list offered',
    !!sel && /value="2A Modified"/.test(sel[0]), sel && sel[0]);
  // Blank is a real answer: the quarry has always crushed days nobody recorded
  // a material for, and refusing the approval only parks the timesheet.
  const blank = fuelCtx({}).quarryFieldsHtml('crushing', {});
  assert('a row with no product opens on the empty option',
    /<option value="" selected>/.test(blank), blank.slice(0, 300));

  // Manage Lists can retire a product after a day was posted against it. The
  // modal posts every box blank-included, so a picker that quietly dropped the
  // stored name would rewrite that day as untagged on the next Save.
  const retired = fuelCtx({}).quarryFieldsHtml('crushing', { productName: 'Screened Sand' });
  assert('a product no longer on the list is still kept selectable',
    /<option value="Screened Sand" selected>/.test(retired), retired.slice(0, 300));

  // No list at all — the fetch failed, or nobody has set the products up yet.
  const noList = fuelCtx({}, []).quarryFieldsHtml('crushing', { productName: '2A Modified' });
  assert('with no list to offer it degrades to a typed box, not an empty dropdown',
    /<input[^>]*id="q_productName"/.test(noList) && !/<select[^>]*id="q_productName"/.test(noList),
    noList.slice(0, 300));

  // Daily is equipment and a task; the crusher is what makes a product.
  const daily = fuelCtx({}).quarryFieldsHtml('daily', {});
  assert('Daily is not asked — it is the crusher that makes a product',
    !/q_productName/.test(daily));
}

console.log('\n[and what Save sends]');
{
  const boxes = {
    q_hourlyRate:   { value: '26' }, q_hoursCrushing: { value: '5' },
    q_loadsToCrusher: { value: '24' }, q_tonsPerLoad: { value: '30' },
    q_fuelGallons:  { value: '190' }, q_fuelPerGal:   { value: '4.50' },
    q_fuelCostAuto: { value: '855.00' }, q_comments:   { value: '' },
    q_equipmentName: { value: 'Crusher' }, q_taskName:  { value: 'Crushing' },
    q_rate:         { value: '26' },
    q_productName:  { value: '2A Modified' },
  };
  const ctx = { _qval: id => (boxes[id] ? boxes[id].value : ''), quarryProductList: PRODUCTS, console };
  vm.createContext(ctx);
  // The real lookup, not a stub — resolving the picked name to the product's
  // id is the half of this that Inventory matches on first.
  evalSlice(requireFn(SRC, 'quarryProductIdFor', 'payroll.html'), ctx, 'quarryProductIdFor');
  evalSlice(
    slice('function collectQuarryFields(activity)', '\n    async function quarrySave()', 'collectQuarryFields',
          'function collectQuarryFields('),
    ctx, 'collectQuarryFields');

  const crush = ctx.collectQuarryFields('crushing');
  assert('crushing posts the typed $/gal as its per-gallon fuelCost',
    Number(crush.fuelCost) === 4.5, JSON.stringify(crush.fuelCost));
  const daily = ctx.collectQuarryFields('daily');
  assert('daily posts it as ppg', Number(daily.ppg) === 4.5, JSON.stringify(daily.ppg));

  // Both halves of the pair. The name is what the Crushing Tracking column
  // prints; the id is what Inventory matches on before it falls back to the
  // name, and it survives a rename in Manage Lists.
  assert('crushing posts the product it was given', crush.productName === '2A Modified',
    JSON.stringify(crush.productName));
  assert('…and the id behind it, resolved off the list', crush.productId === 'p-2a',
    JSON.stringify(crush.productId));

  // The load-bearing one. The form pre-fills from row.productName and Save
  // posts every box blank-included, so if these two keys ever drift apart the
  // first approve looks fine and every later Edit Row silently wipes the
  // product off a row nobody can correct in the quarry tab.
  const form = fuelCtx({}).quarryFieldsHtml('crushing', { productName: 'AASHTO #1' });
  assert('the key Save posts is the key the form pre-fills from',
    /value="AASHTO #1" selected/.test(form) && 'productName' in crush);

  // A free-typed name — the degraded no-list path, or a product since
  // retired — still posts, just without an id to match on.
  boxes.q_productName.value = 'Something Off List';
  const typed = ctx.collectQuarryFields('crushing');
  assert('a name that is not on the list still goes across',
    typed.productName === 'Something Off List', JSON.stringify(typed.productName));
  assert('…with a blank id rather than a wrong one', typed.productId === '',
    JSON.stringify(typed.productId));
  boxes.q_productName.value = '2A Modified';

  // The grid and the executive report both cost fuel as gallons × the stored
  // per-gallon rate. That product is the total the modal showed — which is the
  // whole point: what was on screen is what the quarry office gets billed.
  assert('the grid re-derives the $855 the modal showed',
    Number(crush.fuelGallons) * Number(crush.fuelCost) === 855,
    String(Number(crush.fuelGallons) * Number(crush.fuelCost)));
  assert('…and so does Daily',
    Number(daily.fuelGallons) * Number(daily.ppg) === 855,
    String(Number(daily.fuelGallons) * Number(daily.ppg)));
}

console.log('\n[the turf/paving split modal has the same guard]');
{
  const open = slice('async function openSplitModal(entry, mode)', '\n    function closeSplit()', 'openSplitModal',
                     'function openSplitModal(');
  assert('a refusal is thrown rather than read as "no split"',
    /if \(!r\.ok\) throw new Error/.test(open));
  assert('the pre-fill records whether it landed',
    /splitRowLoad = 'loaded'/.test(open) && /splitRowLoad = 'failed'/.test(open));
  assert('a late answer for another entry is dropped',
    /const seq = \+\+splitFetchSeq/.test(open) && /if \(seq !== splitFetchSeq\) return/.test(open));
  assert('and a fresh approve has nothing to load',
    /splitRowLoad = mode === 'resplit' \? 'pending' : 'none'/.test(open));

  const close = slice('function closeSplit()', "bindBackdropClose(document.getElementById('splitBackdrop')", 'closeSplit',
                      'function closeSplit(');
  assert('closing orphans a pre-fill still in flight',
    /splitFetchSeq\+\+/.test(close) && /splitRowLoad = 'none'/.test(close));

  const save = slice('async function splitSave()', '\n    // ──', 'splitSave',
                     'function splitSave(');
  assert('the save refuses while the posted split is unknown',
    /splitRowLoad === 'pending' \|\| splitRowLoad === 'failed'/.test(save));
  // …and before the pre-validation that would otherwise wave the defaults
  // through: one labor row for the whole day passes every check there is.
  assert('before the row checks that would pass the defaults',
    save.includes("splitRowLoad === 'pending'")
    && save.indexOf("splitRowLoad === 'pending'") < save.indexOf('Add at least one row.'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
