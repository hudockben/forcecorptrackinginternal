'use strict';

/**
 * The "EES" customer pool on the Truck Tracking tab.
 *
 * Run: node scripts/test-truck-ic-pool.js
 *
 * Most of what leaves the yard is hauled by EES, whoever ordered it. "Ox Hill"
 * is the customer on the ticket, but EES ran the truck, so Intercompany has to
 * bill one EES rather than a page of one-job companies. Force, Kinkead and
 * Kovalchick are the exceptions and bill under their own name.
 *
 * The rule is a VIEW and a BILLING rule, never a rewrite, and that is the line
 * every case below holds. The row keeps the customer it was hauled for, because
 * the rate book, Analytics, the CSV and the server's own re-approval path all
 * read that field — and because _recoverEntriesFromIcBilling rebuilds a lost
 * row out of its billing entry and writes it back, so a mirror carrying the
 * pooled name alone would turn the rollup into a silent, permanent rewrite.
 *
 * Four layers:
 *   1. The rule itself — blank, the three exempt spellings, everything else.
 *   2. The Customer column filter, which shows two names and so matches both.
 *   3. The Intercompany reconciler: pooling, the fall-back for when nobody has
 *      enrolled EES yet, and customer_real riding along beside the pooled name.
 *   4. The recovery path, which must never read the pooled name back onto a row.
 *
 * The functions under test are extracted verbatim from trucking.html so this
 * tests shipped code rather than a copy that can drift.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); failed++; }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'trucking.html'), 'utf8');

function extractFn(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in trucking.html`);
  // Keep the `async` keyword when there is one — slicing from `function`
  // would silently turn an async declaration into a sync one.
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/** One `const NAME = ...;` line, verbatim, so the constants are the shipped ones. */
function extractConst(name) {
  const re = new RegExp(`^\\s*(?:const|let)\\s+${name}\\s*=.*$`, 'm');
  const m = re.exec(SRC);
  if (!m) throw new Error(`const ${name} not found in trucking.html`);
  return m[0];
}

// ── The harness ────────────────────────────────────────────────────────────
// divEntries and icBillingArr are the two module-level lists the extracted
// functions read; every case sets them through run().
const harness = new Function(`
  let divEntries = [];
  let icBillingArr = [];
  let trColFilters = {};
  let _divEntriesLoaded = true;
  let _icSuppressed = new Set();
  let saves = 0;
  const user = { username: 'tester' };
  function icIsSuppressed(sourceId) { return _icSuppressed.has('trucking|' + sourceId); }
  function isPayrollRowId(id) { return String(id || '').startsWith('tst-'); }
  function tdDivPut() { saves++; }
  ${extractConst('IC_POOL_NAME')}
  ${extractConst('IC_POOL_EXEMPT')}
  ${extractConst('IC_POOL_EXEMPT_KEYS')}
  ${extractConst('_icPoolKey')}
  ${extractFn('isIcRolledUp')}
  ${extractFn('icPoolName')}
  ${extractFn('_icTruckEntrySig')}
  ${extractFn('_reconcileTruckingBilling')}
  ${extractFn('applyColFilters')}
  ${extractFn('_recoverEntriesFromIcBilling')}
  ${extractConst('_cbEscape')}
  ${extractFn('fmtSentAt')}
  ${extractFn('_icPoolTitle')}
  ${extractFn('_custPoolHtml')}
  ${extractFn('_icPoolNote')}
  let icSentMap = new Map();
  let _icEesEnrolled = null;
  return {
    icPoolName, isIcRolledUp, _icTruckEntrySig, IC_POOL_EXEMPT,
    cell(id, customer, enrolled) { _icEesEnrolled = enrolled; return _custPoolHtml(id, customer); },
    note(e, enrolled, sent) {
      _icEesEnrolled = enrolled;
      icSentMap = new Map(sent ? [[e.id, sent]] : []);
      return _icPoolNote(e);
    },
    filter(rows, filters) {
      divEntries = rows; trColFilters = filters;
      return applyColFilters(rows);
    },
    reconcile(rows, entries, coByName, suppressed) {
      divEntries = rows;
      _icSuppressed = new Set(suppressed || []);
      return _reconcileTruckingBilling(entries, coByName);
    },
    recover(rows, entries) {
      divEntries = rows; icBillingArr = entries; saves = 0;
      _recoverEntriesFromIcBilling();
      return { rows: divEntries, saves };
    },
  };
`)();

const { icPoolName, isIcRolledUp } = harness;

// ── Fixtures ───────────────────────────────────────────────────────────────
const EES  = { id: 'co-ees',  name: 'EES',        divisions: ['trucking'] };
const KOVA = { id: 'co-kova', name: 'Kovalchick', divisions: ['trucking'] };
const OXH  = { id: 'co-oxh',  name: 'Ox Hill',    divisions: ['trucking'] };

const roster = (...cos) => new Map(cos.map(c => [c.name.trim().toLowerCase(), c]));

function row(over = {}) {
  return {
    id: 'tr-1', task_number: 'TR-1114', actual_date: '2026-09-02',
    driver: 'barrmike', unit: '3999 SPRAY',
    actual_start: '10:30', actual_end: '12:30',
    total_hours: '2', haul_fee: '121',
    customer: 'Ox Hill', description: 'Ultra bond', division: 'Dust', notes: '',
    ...over,
  };
}

// ── 1. The rule ────────────────────────────────────────────────────────────
console.log('[the rule: who pools and who does not]');

assert('a blank customer pools nowhere', icPoolName('') === '' && !isIcRolledUp(''));
assert('so does an all-space customer', icPoolName('   ') === '' && !isIcRolledUp('   '));
assert('null and undefined are blank too',
  icPoolName(null) === '' && icPoolName(undefined) === '' && !isIcRolledUp(null));

assert('Ox Hill pools to EES', icPoolName('Ox Hill') === 'EES' && isIcRolledUp('Ox Hill'));
assert('so does Arcadis',       icPoolName('Arcadis') === 'EES');
assert('so does Richard Sproul', icPoolName('Richard Sproul') === 'EES');
assert('so does Cowanshnock Twp', icPoolName('Cowanshnock Twp') === 'EES');

console.log('\n[the three exempt names, in every spelling the rows carry]');
const exemptSpellings = [
  'Force', 'Force Corp', 'FORCE', 'force corp',
  'Kinkead', 'Kinkead HC', "Kinkead's", 'kinkead',
  'Kovalchick', 'kovalchick', 'KOVALCHICK', ' Kovalchick ',
];
exemptSpellings.forEach(name => {
  assert(`"${name}" keeps its own name`, icPoolName(name) === name.trim() && !isIcRolledUp(name));
});
assert('the exempt list is exactly the three the office named',
  JSON.stringify(harness.IC_POOL_EXEMPT) === JSON.stringify(['Force', 'Kinkead', 'Kovalchick']));

console.log('\n[EES itself]');
// The pool's own name is not an exempt name, so it pools to itself — which
// means the cell shows one "EES" and no sub-line, not "EES over EES".
assert('a row already naming EES pools to EES', icPoolName('EES') === 'EES');
assert('and is not treated as rolled up, so no sub-line is drawn', !isIcRolledUp('EES'));

// ── 2. The Customer column filter ──────────────────────────────────────────
console.log('\n[the Customer filter answers to both names]');
const rows = [
  row({ id: 'r-ox',   customer: 'Ox Hill' }),
  row({ id: 'r-arc',  customer: 'Arcadis' }),
  row({ id: 'r-kov',  customer: 'Kovalchick' }),
  row({ id: 'r-kin',  customer: 'Kinkead HC' }),
  row({ id: 'r-none', customer: '' }),
];
const ids = out => out.map(e => e.id).sort().join(',');

assert('"EES" pulls up every pooled haul',
  ids(harness.filter(rows, { customer: 'EES' })) === 'r-arc,r-ox');
assert('"Ox Hill" still pulls up its own rows',
  ids(harness.filter(rows, { customer: 'Ox Hill' })) === 'r-ox');
assert('an exempt name still matches exactly itself',
  ids(harness.filter(rows, { customer: 'Kovalchick' })) === 'r-kov');
assert('a partial exempt name still works',
  ids(harness.filter(rows, { customer: 'kinkead' })) === 'r-kin');
assert('a blank-customer row matches no non-empty filter',
  !harness.filter(rows, { customer: 'e' }).some(e => e.id === 'r-none'));
assert('a lone space matches only the names that really contain one',
  ids(harness.filter(rows, { customer: ' ' })) === 'r-kin,r-ox');
assert('and no filter matches across the seam between the two names',
  harness.filter(rows, { customer: 'Hill EES' }).length === 0);
assert('every other column is untouched by the special case',
  ids(harness.filter(rows, { unit: '3999' })) === 'r-arc,r-kin,r-kov,r-none,r-ox');
assert('and a driver filter does not search the customer',
  harness.filter(rows, { driver: 'EES' }).length === 0);

// ── 3. The Intercompany reconciler ─────────────────────────────────────────
console.log('\n[pooling into Intercompany]');
{
  const entries = [];
  const res = harness.reconcile([row()], entries, roster(EES, KOVA));
  assert('a pooled haul creates one entry', res.changed && entries.length === 1);
  assert('billed to the EES company', entries[0].company_id === 'co-ees' && entries[0].company_name === 'EES');
  assert('and its customer reads EES', entries[0].customer === 'EES');
  assert('with the real customer carried beside it', entries[0].customer_real === 'Ox Hill');
  assert('the total is the row\'s own', entries[0].total === 242);
}

{
  const entries = [];
  harness.reconcile([row({ customer: 'Kovalchick' })], entries, roster(EES, KOVA));
  assert('an exempt haul bills under its own company', entries[0].company_id === 'co-kova');
  assert('its customer is unchanged', entries[0].customer === 'Kovalchick');
  assert('and it carries no customer_real to confuse anyone',
    !('customer_real' in entries[0]));
}

{
  const entries = [];
  const res = harness.reconcile([row({ customer: '' })], entries, roster(EES, KOVA));
  assert('a blank-customer row is mirrored nowhere', !res.changed && entries.length === 0);
}

console.log('\n[an individually enrolled customer is pooled too]');
{
  // Ox Hill has its own company on the roster. Pooling wins: the whole point is
  // that the hauls land on one EES card rather than on thirty of these.
  const entries = [];
  harness.reconcile([row()], entries, roster(EES, OXH));
  assert('the EES company wins over the customer\'s own', entries[0].company_id === 'co-ees');
}

console.log('\n[nobody has enrolled EES yet — the fall-back]');
{
  // This is the safety property. A miss on the pool used to mean the row was
  // skipped in silence, so shipping the rollup without this would have taken
  // every non-exempt haul off the Intercompany invoice run on day one.
  const entries = [];
  const res = harness.reconcile([row()], entries, roster(KOVA, OXH));
  assert('the haul still bills, under its own customer', res.changed && entries.length === 1);
  assert('to that customer\'s own company', entries[0].company_id === 'co-oxh');
  assert('its customer is the real one', entries[0].customer === 'Ox Hill');
  assert('and there is no customer_real, because nothing was pooled',
    !('customer_real' in entries[0]));
}

{
  const entries = [];
  const res = harness.reconcile([row({ customer: 'Nobody Ltd' })], entries, roster(KOVA));
  assert('a customer enrolled nowhere is still mirrored nowhere',
    !res.changed && entries.length === 0);
}

console.log('\n[an entry already sent under the old company]');
{
  // The first sync after this ships has to move a haul that was already
  // mirrored under Ox Hill onto the EES card — keeping its invoice number, the
  // date it was sent and the date it was paid, which are Intercompany's.
  const prev = {
    id: 'ic-1', source: 'trucking', source_id: 'tr-1',
    company_id: 'co-oxh', company_name: 'Ox Hill',
    task_number: 'TR-1114', actual_date: '2026-09-02',
    driver: 'barrmike', unit: '3999 SPRAY',
    actual_start: '10:30', actual_end: '12:30',
    total_hours: '2', haul_fee: '121', total: 242,
    customer: 'Ox Hill', description: 'Ultra bond', division: 'Dust', notes: '',
    sent_at: '2026-09-04T14:16:00Z', sent_by: 'hudockben',
    qb_invoice: 'QB-8891', invoice_sent_date: '2026-09-05',
    invoice_status: 'Paid', date_paid: '2026-09-20',
  };
  const entries = [prev];
  const res = harness.reconcile([row()], entries, roster(EES, OXH));
  assert('the entry is rewritten, not duplicated', res.changed && entries.length === 1);
  assert('and re-pointed at the EES company', entries[0].company_id === 'co-ees');
  assert('it keeps the id it was filed under', entries[0].id === 'ic-1');
  assert('it keeps the moment it was first sent', entries[0].sent_at === '2026-09-04T14:16:00Z');
  assert('the QB invoice number survives', entries[0].qb_invoice === 'QB-8891');
  assert('so does the date it was paid',
    entries[0].invoice_status === 'Paid' && entries[0].date_paid === '2026-09-20');
  assert('and the real customer is now on it', entries[0].customer_real === 'Ox Hill');
}

console.log('\n[nothing churns once the entry is right]');
{
  const entries = [];
  harness.reconcile([row()], entries, roster(EES));
  const first = JSON.parse(JSON.stringify(entries));
  const again = harness.reconcile([row()], entries, roster(EES));
  assert('a second pass over an unchanged row changes nothing', !again.changed);
  assert('and leaves the entry byte-identical',
    JSON.stringify(entries) === JSON.stringify(first));
}

{
  // An exempt row's signature must not move, or the first sync after this ships
  // would rewrite every Force / Kinkead / Kovalchick entry for no reason.
  const entries = [];
  harness.reconcile([row({ customer: 'Kovalchick' })], entries, roster(EES, KOVA));
  const again = harness.reconcile([row({ customer: 'Kovalchick' })], entries, roster(EES, KOVA));
  assert('an exempt row is not re-signed by this change', !again.changed);
}

console.log('\n[a customer edited across the line]');
{
  const entries = [];
  harness.reconcile([row()], entries, roster(EES, KOVA));
  const moved = harness.reconcile([row({ customer: 'Kovalchick' })], entries, roster(EES, KOVA));
  assert('editing a pooled haul onto an exempt name rewrites the entry', moved.changed);
  assert('it bills under its own company now', entries[0].company_id === 'co-kova');
  assert('its customer is the real one again', entries[0].customer === 'Kovalchick');
  assert('and customer_real is cleared rather than left lying',
    !('customer_real' in entries[0]));
}

console.log('\n[stray whitespace does not fork an entry]');
{
  // A name typed with a trailing space is the same company, and an exempt row
  // that carries one must not be rewritten — or re-signed — just for that.
  const entries = [];
  const res = harness.reconcile([row({ customer: ' Kovalchick ' })], entries, roster(EES, KOVA));
  assert('a spaced exempt name still finds its own company',
    res.changed && entries[0].company_id === 'co-kova');
  assert('and its customer is stored exactly as the row has it',
    entries[0].customer === ' Kovalchick ');
  assert('with no customer_real, because nothing was pooled',
    !('customer_real' in entries[0]));
}

{
  const entries = [];
  harness.reconcile([row({ customer: ' Ox Hill ' })], entries, roster(EES));
  assert('a spaced pooled name still pools', entries[0].company_id === 'co-ees');
  assert('and customer_real keeps the row\'s value verbatim, so recovery is exact',
    entries[0].customer_real === ' Ox Hill ');
}

{
  const entries = [];
  harness.reconcile([row({ customer: 'EES' })], entries, roster(EES));
  assert('a row already naming EES bills to EES', entries[0].company_id === 'co-ees');
  assert('and gains no customer_real', !('customer_real' in entries[0]));
}

console.log('\n[customer_real is in the signature]');
{
  const base = { customer: 'EES', description: 'd', division: '', notes: '' };
  assert('two entries differing only in customer_real do not look the same',
    harness._icTruckEntrySig({ ...base, customer_real: 'Ox Hill' })
      !== harness._icTruckEntrySig({ ...base, customer_real: 'Arcadis' }));
  assert('and an entry from before the pool shipped differs from one with it',
    harness._icTruckEntrySig(base)
      !== harness._icTruckEntrySig({ ...base, customer_real: 'Ox Hill' }));
}

console.log('\n[a $0 haul is still voided]');
{
  const entries = [];
  harness.reconcile([row()], entries, roster(EES));
  const voided = harness.reconcile([row({ haul_fee: '' })], entries, roster(EES));
  assert('the entry is pulled when the total drops to nothing',
    voided.changed && entries.length === 0);
  assert('and the row is named in clearNow', voided.clearNow.includes('tr-1'));
}

// ── 4. Recovery must never read the pooled name back onto a row ────────────
console.log('\n[recovering a lost row out of its billing entry]');
{
  // The whole reason customer_real exists. This function rebuilds a row that
  // fell out of the blob and PUTs it back to the server, so whatever it reads
  // as `customer` is what the row permanently becomes.
  const { rows: after, saves } = harness.recover([], [{
    source: 'trucking', source_id: 'tr-9', task_number: 'TR-9',
    actual_date: '2026-09-02', driver: 'barrmike', unit: '3999 SPRAY',
    total_hours: '2', haul_fee: '121',
    customer: 'EES', customer_real: 'Ox Hill', description: 'Ultra bond',
  }]);
  assert('the row comes back', after.length === 1 && saves === 1);
  assert('as Ox Hill, not as EES', after[0].customer === 'Ox Hill');
}

{
  // An entry mirrored before pooling shipped has no customer_real, and the name
  // in `customer` is the real one. It must still come back as itself.
  const { rows: after } = harness.recover([], [{
    source: 'trucking', source_id: 'tr-8', task_number: 'TR-8',
    actual_date: '2026-09-01', customer: 'Kovalchick',
  }]);
  assert('a pre-pool entry recovers under the name it always had',
    after.length === 1 && after[0].customer === 'Kovalchick');
}

{
  const { rows: after } = harness.recover([], [{
    source: 'trucking', source_id: 'tst-77-row', customer: 'EES', customer_real: 'Ox Hill',
  }]);
  assert('a payroll row is still left to payroll', after.length === 0);
}

// ── 5. What the office actually reads ──────────────────────────────────────
console.log('\n[the Customer cell]');
{
  const pooled = harness.cell('tr-1', 'Ox Hill', true);
  assert('a pooled row gets an EES line over its box', />EES<\/div>$/.test(pooled));
  assert('the line is findable again after an edit', pooled.includes('id="cust-pool-tr-1"'));
  assert('and its tooltip names the real customer', pooled.includes('Ox Hill ordered the haul'));
  assert('EES itself is never put in the editable box',
    !/value=/.test(pooled) && !pooled.includes('cb-input'));
}
{
  // An exempt or blank row must look exactly as it always has: the placeholder
  // is there only so the painter can find the cell again, and carries no style.
  const exempt = harness.cell('tr-2', 'Kovalchick', true);
  const blank  = harness.cell('tr-3', '', true);
  assert('an exempt row draws nothing visible', exempt === '<div id="cust-pool-tr-2"></div>');
  assert('nor does a blank one',                blank  === '<div id="cust-pool-tr-3"></div>');
  assert('nor does a row already naming EES',
    harness.cell('tr-4', 'EES', true) === '<div id="cust-pool-tr-4"></div>');
}
{
  // The pooled line is built with the page's own escaper, so a customer with a
  // quote in it cannot break out of the title attribute.
  const nasty = harness.cell('tr-5', 'O"Hara & <Sons>', true);
  assert('a customer with quotes and angles is escaped',
    !nasty.includes('O"Hara') && nasty.includes('O&quot;Hara')
      && nasty.includes('&amp;') && nasty.includes('&lt;Sons&gt;'));
}

{
  // The cell reads "EES" whether or not the pool has anywhere to bill, so the
  // tooltip is what has to stay honest about which of the two is happening.
  const promised = harness.cell('tr-6', 'Ox Hill', true);
  const fallback = harness.cell('tr-6', 'Ox Hill', false);
  assert('the tooltip claims EES billing only when EES is enrolled',
    promised.includes('Billed to Intercompany as EES'));
  assert('and says the haul still goes out under its own name when it is not',
    !fallback.includes('Billed to Intercompany as EES')
      && fallback.includes('still goes out under Ox Hill'));
  assert('the line itself still reads EES either way',
    promised.endsWith('>EES</div>') && fallback.endsWith('>EES</div>'));
}

console.log('\n[what the expanded panel tells the office]');
{
  const pooledRow = row();
  assert('an unsent pooled row says it bills as EES',
    harness.note(pooledRow, true, null) === 'Awaiting sync — bills to Intercompany as EES');
  assert('and says so outright when EES is not on the list yet',
    harness.note(pooledRow, false, null)
      === "Not sent — EES isn't on the Intercompany company list yet");
  assert('without promising what it bills under instead, which it cannot know',
    !harness.note(pooledRow, false, null).includes('Ox Hill'));
  assert('an unpriced row still asks for a customer and a total',
    harness.note(row({ haul_fee: '' }), true, null) === 'Needs customer & total');
  assert('so does a row with no customer',
    harness.note(row({ customer: '' }), true, null) === 'Needs customer & total');
  assert('an exempt row keeps the note it always had',
    harness.note(row({ customer: 'Kovalchick' }), true, null)
      === 'Awaiting sync — check Intercompany company list');
  assert('and a sent row shows when it went, whatever the pool is doing',
    harness.note(pooledRow, false, { sent_at: '2026-09-04T14:16:00Z' }).startsWith('Sent '));
}

// ── 6. The tab, rendered ───────────────────────────────────────────────────
// The layers above run the rule and the fragments. This one runs the page: the
// real renderTrackingTab over a real DOM, so the two Customer <td>s, the
// combobox beside the pooled line and the in-place repaints are exercised as
// the office meets them rather than as strings.
const { JSDOM } = require('jsdom');
const vm = require('vm');

function sliceSrc(from, to, label) {
  const a = SRC.indexOf(from);
  const b = a < 0 ? -1 : SRC.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved)`);
  return SRC.slice(a, b);
}
const BANNER = '    /* ═══════════════════════════════════════════\n       ';
const POOL   = sliceSrc(BANNER + 'INTERCOMPANY CUSTOMER POOLING', BANNER + 'INTERCOMPANY BILLING', 'the pool');
const COMBO  = sliceSrc('    const _cbState = new WeakMap();', '    /** Names list for the dropdown', 'combobox');
const TOTALS = sliceSrc('    /** Re-total a row and keep its Intercompany Billing mirror in step. */',
                        BANNER + 'BACKUP HAUL FEE', 'updateField');
const TAB    = sliceSrc(BANNER + 'BACKUP HAUL FEE', BANNER + 'SCHEDULER', 'renderTrackingTab');

function newPage(entries) {
  const dom = new JSDOM('<div id="tab-truck-tracking"></div>');
  const sandbox = {
    console, document: dom.window.document,
    divEntries: entries,
    divTruckLists: { drivers: [], customers: ['Ox Hill', 'Arcadis', 'Kovalchick'], units: [], rates: {} },
    icBillingArr: [], icSentMap: new Map(),
    activeYearFilter: 'all', expandedRows: new Set(entries.map(e => e.id)),
    _isSaved: true, saves: 0,
    schedSave() { sandbox.saves++; },
    isPayrollRowId: id => String(id || '').startsWith('tst-'),
    customerRate: () => '', calcHours: () => null,
    fmtTime12: v => String(v || ''), fmtSentAt: v => String(v || ''),
    setYearFilter() {}, toggleInvoiceRow() {}, addRow() {}, openManageLists() {},
    triggerCSVUpload() {}, downloadCSVTemplate() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(COMBO + '\n' + POOL + '\n' + TOTALS + '\n' + TAB, sandbox, { filename: 'trucking.html' });
  const run = code => vm.runInContext(code, sandbox);
  run('renderTrackingTab();');
  const doc = dom.window.document;
  return {
    run, doc, sandbox,
    /** The Customer <td> of the row whose caret carries `id`. */
    custCell: id => [...doc.getElementById('caret-' + id).closest('tr').children][10],
    taskNumbers: () => [...doc.querySelectorAll('tbody tr')]
      .filter(r => r.querySelector('[id^="caret-"]'))
      .map(r => r.querySelector('.td-task-num').textContent.replace('← Timesheet', '').trim()),
  };
}

const pageRows = () => [
  row({ id: 'a', task_number: 'TR-1114', customer: 'Ox Hill' }),
  row({ id: 'b', task_number: 'TR-1112', customer: 'Kovalchick' }),
  row({ id: 'tst-9-row', task_number: 'TR-1113', customer: 'Arcadis' }),
  row({ id: 'd', task_number: 'TR-1109', customer: '', total_hours: '', haul_fee: '' }),
];

console.log('\n[the tab, rendered]');
{
  const p = newPage(pageRows());

  const pooled = p.custCell('a');
  assert('a pooled row leads with EES',
    pooled.firstElementChild.id === 'cust-pool-a' && pooled.firstElementChild.textContent === 'EES');
  const box = pooled.querySelector('.cb-input');
  assert('and the box under it still holds the real customer', box && box.value === 'Ox Hill');
  assert('the combobox wrapper is intact and comes after the pooled line',
    pooled.querySelector('.cb') === pooled.children[1]);
  assert('and its menu is still the input\'s next sibling, which is how it is found',
    box.nextElementSibling && box.nextElementSibling.classList.contains('cb-menu'));

  const exempt = p.custCell('b');
  assert('an exempt row draws no visible pooled line',
    exempt.firstElementChild.id === 'cust-pool-b' && exempt.firstElementChild.innerHTML === '');
  assert('and its box is untouched', exempt.querySelector('.cb-input').value === 'Kovalchick');

  const locked = p.custCell('tst-9-row');
  assert('a locked payroll row shows EES over its real customer',
    locked.firstElementChild === null
      ? false
      : locked.textContent.replace(/\s+/g, '') === 'EESArcadis'
        && locked.querySelector('#cust-real-tst-9-row').textContent === 'Arcadis');
  assert('and has no editable box, because payroll owns it',
    !locked.querySelector('.cb-input'));

  assert('a blank-customer row draws nothing and keeps its empty box',
    p.custCell('d').firstElementChild.innerHTML === ''
      && p.custCell('d').querySelector('.cb-input').value === '');
}

console.log('\n[the filter, over the rendered table]');
{
  const p = newPage(pageRows());
  p.run('trColFilters = { customer: "EES" }; renderTrackingTab();');
  assert('"EES" shows the two pooled hauls', p.taskNumbers().sort().join(',') === 'TR-1113,TR-1114');
  p.run('trColFilters = { customer: "Ox Hill" }; renderTrackingTab();');
  assert('"Ox Hill" still shows its own row', p.taskNumbers().join(',') === 'TR-1114');
  p.run('trColFilters = { customer: "kovalchick" }; renderTrackingTab();');
  assert('and an exempt name still shows its own', p.taskNumbers().join(',') === 'TR-1112');
}

console.log('\n[editing a customer, with nothing re-rendered]');
{
  const p = newPage(pageRows());
  // Typed into the box, then committed — the way cbOnBlur / cbDispatch reach
  // updateField. The box is where the edit comes FROM, so nothing repaints it.
  const type = (id, name) => {
    p.custCell(id).querySelector('.cb-input').value = name;
    p.run(`updateField('${id}','customer','${name}');`);
  };
  type('a', 'Force Corp');
  assert('editing onto an exempt name clears the pooled line at once',
    p.doc.getElementById('cust-pool-a').innerHTML === '');
  assert('and the row stores what was typed, never EES',
    p.sandbox.divEntries.find(e => e.id === 'a').customer === 'Force Corp');
  assert('the box keeps showing what was typed',
    p.custCell('a').querySelector('.cb-input').value === 'Force Corp');
  assert('and the panel note follows the edit rather than going stale',
    p.doc.getElementById('ic-ts-a').textContent === 'Awaiting sync — check Intercompany company list');

  type('a', 'Arcadis');
  assert('editing back onto a pooled name draws the line again',
    p.doc.getElementById('cust-pool-a').textContent === 'EES');
  assert('and the row still stores the real customer',
    p.sandbox.divEntries.find(e => e.id === 'a').customer === 'Arcadis');
}

console.log('\n[the answer about EES arriving after the rows are on screen]');
{
  const p = newPage(pageRows());
  assert('the tooltip does not promise EES billing before the roster is read',
    !p.doc.getElementById('cust-pool-a').title.includes('Billed to Intercompany as EES')
      || p.doc.getElementById('cust-pool-a').title.length > 0);
  p.run('_setIcEesEnrolled(false);');
  assert('once EES is known to be missing, every pooled tooltip says so',
    p.doc.getElementById('cust-pool-a').title.includes('still goes out under Ox Hill'));
  assert('including the locked row\'s',
    p.doc.getElementById('cust-real-tst-9-row').title.includes('still goes out under Arcadis'));
  assert('and every unsent note says so',
    p.doc.getElementById('ic-ts-a').textContent === "Not sent — EES isn't on the Intercompany company list yet");
  assert('an exempt row\'s note is left alone',
    p.doc.getElementById('ic-ts-b').textContent === 'Awaiting sync — check Intercompany company list');

  p.run('_setIcEesEnrolled(true);');
  assert('and it all turns back once EES is enrolled',
    p.doc.getElementById('cust-pool-a').title.includes('Billed to Intercompany as EES')
      && p.doc.getElementById('ic-ts-a').textContent === 'Awaiting sync — bills to Intercompany as EES');
  assert('with the boxes never having been touched by any of it',
    p.custCell('a').querySelector('.cb-input').value === 'Ox Hill');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
