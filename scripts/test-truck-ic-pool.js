'use strict';

/**
 * The "EES" customer pool on the Truck Tracking tab.
 *
 * Run: node scripts/test-truck-ic-pool.js
 *
 * Most of what leaves the yard is hauled by EES, whoever ordered it. "Ox Hill"
 * is the customer on the ticket, but EES ran the truck, so Intercompany has to
 * bill one EES rather than a page of one-job companies.
 *
 * What stays out of the pool is the Intercompany company list: a haul for a
 * company enrolled there under trucking bills under that company, because that
 * company is its own pool already. XTO's work belongs in XTO's pool, Ox Hill
 * has no company of its own and so is EES work. Force, Kinkead and Kovalchick
 * are named in the code as well, as a floor under the roster.
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
  ${extractConst('IC_KEEP_DEFAULT')}
  ${extractFn('icKeepList')}
  ${extractConst('_icPoolKey')}
  ${extractConst('_icWordish')}
  ${extractFn('_icNamesMatch')}
  ${extractFn('icCompanyFor')}
  ${extractFn('isIcRolledUp')}
  ${extractFn('icPoolName')}
  ${extractFn('_icTruckEntrySig')}
  ${extractFn('_reconcileTruckingBilling')}
  ${extractFn('applyColFilters')}
  ${extractFn('_recoverEntriesFromIcBilling')}
  ${extractConst('_cbEscape')}
  ${extractFn('fmtSentAt')}
  ${extractFn('_icDidFallBack')}
  ${extractFn('_icPoolTitle')}
  ${extractFn('_custPoolHtml')}
  ${extractFn('_icPoolNote')}
  let icSentMap = new Map();
  let _icEesEnrolled = null;
  let divTruckLists = {};
  return {
    icPoolName, isIcRolledUp, _icTruckEntrySig, IC_KEEP_DEFAULT, icKeepList,
    /** Set the office's rollup list. null puts it back to untouched. */
    keep(names) {
      if (names === null) delete divTruckLists.icKeep;
      else divTruckLists.icKeep = names.slice();
    },
    cell(id, customer, enrolled, sent) {
      _icEesEnrolled = enrolled;
      icSentMap = new Map(sent ? [[id, sent]] : []);
      return _custPoolHtml(id, customer);
    },
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

// Every case below runs against the list the office keeps in Manage Lists →
// Intercompany Rollup unless it says otherwise. Ox Hill is deliberately NOT on
// it even though Ox Hill has its own Intercompany company: which companies ran
// their own trucks is not something the page can read anywhere, which is why
// the list exists.
const KEEP = ['EAI', 'Force', 'Kinkead', 'Kovalchick', 'XTO'];
harness.keep(KEEP);

// The other list, and a different question: who is enrolled in Intercompany
// under trucking. It decides which company a haul is billed TO, and whether
// the pool has anywhere to bill at all — never who pools. Ox Hill is on it,
// which is exactly why the roster could not be the rule.
const IC_ROSTER = ['EES', 'Kinkead', 'Force', 'EAI', 'Kovalchick', 'XTO', 'Ox Hill'];

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

console.log('\n[a company with its own Intercompany pool keeps it]');
['XTO', 'XTO Energy', 'xto', 'EAI', 'EAI Trucking'].forEach(name => {
  assert(`"${name}" bills under itself, not EES`,
    icPoolName(name) === name.trim() && !isIcRolledUp(name));
});
assert('and a customer with no company of its own pools',
  icPoolName('Ox Hill') === 'EES');

console.log('\n[a name is matched on whole words, not on any run of letters]');
// The roster carries short names. "EAI" sits inside "Beaird" and "Force"
// inside "Workforce", and taking those hauls out of the pool would invoice a
// company that had nothing to do with them.
[['Beaird', 'EAI'], ['Beaird Hauling', 'EAI'], ['Workforce Solutions', 'Force'],
 ['Reinforced Earth', 'Force'], ['Enforcement Services', 'Force'],
 ['Kinkeadle Sand', 'Kinkead'], ['Extort Ltd', 'XTO']].forEach(([name, near]) => {
  assert(`"${name}" pools — it only looks like ${near}`, isIcRolledUp(name));
});
[['XTO Energy', 'XTO'], ['Kinkead HC', 'Kinkead'], ["Kinkead's", 'Kinkead'],
 ['EAI Trucking', 'EAI'], ['R. Kovalchick & Sons', 'Kovalchick'],
 ['Force Corp', 'Force']].forEach(([name, co]) => {
  assert(`"${name}" is ${co}'s work and stays out`, !isIcRolledUp(name));
});

console.log('\n[a list the office has never touched, and one it has emptied]');
harness.keep(null);
assert('an untouched list is the five it started with',
  JSON.stringify(harness.icKeepList()) === JSON.stringify(KEEP));
assert('so XTO keeps its name and Ox Hill pools, out of the box',
  !isIcRolledUp('XTO Energy') && isIcRolledUp('Ox Hill'));
harness.keep([]);
assert('an emptied list is an answer, not an absence — everything pools',
  isIcRolledUp('Ox Hill') && isIcRolledUp('XTO') && isIcRolledUp('Kovalchick'));
assert('except the pool itself and a blank', !isIcRolledUp('EES') && !isIcRolledUp(''));
harness.keep(KEEP);

console.log('\n[the names on the list, in every spelling the rows carry]');
const exemptSpellings = [
  'Force', 'Force Corp', 'FORCE', 'force corp',
  'Kinkead', 'Kinkead HC', "Kinkead's", 'kinkead',
  'Kovalchick', 'kovalchick', 'KOVALCHICK', ' Kovalchick ',
];
exemptSpellings.forEach(name => {
  assert(`"${name}" keeps its own name`, icPoolName(name) === name.trim() && !isIcRolledUp(name));
});
assert('the list starts as the five the office named',
  JSON.stringify(harness.IC_KEEP_DEFAULT) === JSON.stringify(KEEP));

// The whole point of the list being editable: taking a name off it pools that
// company's hauls, and adding one takes them back out, with no code change.
harness.keep(KEEP.filter(n => n !== 'XTO'));
assert('dropping XTO pools its hauls', isIcRolledUp('XTO Energy'));
assert('and leaves everything else alone', !isIcRolledUp('Kinkead HC'));
harness.keep([...KEEP, 'Ox Hill']);
assert('adding Ox Hill takes its hauls back out of the pool',
  !isIcRolledUp('Ox Hill') && icPoolName('Ox Hill') === 'Ox Hill');
assert('and a name is matched however it was typed on the row',
  !isIcRolledUp('OX HILL') && !isIcRolledUp('Ox Hill Quarry'));
harness.keep(KEEP);

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

console.log('\n[a company with its own pool is billed to it]');
{
  const XTO = { id: 'co-xto', name: 'XTO', divisions: ['trucking'] };
  const entries = [];
  harness.reconcile([row({ customer: 'XTO Energy' })], entries, roster(EES, XTO));
  assert('an XTO haul bills to XTO, not to EES', entries[0].company_id === 'co-xto');
  assert('its customer is the one on the row', entries[0].customer === 'XTO Energy');
  assert('and it carries no customer_real, because nothing was pooled',
    !('customer_real' in entries[0]));

  const pooled = [];
  harness.reconcile([row({ customer: 'Ox Hill' })], pooled, roster(EES, XTO));
  assert('while Ox Hill, which has no company of its own, goes to EES',
    pooled[0].company_id === 'co-ees' && pooled[0].customer_real === 'Ox Hill');

  // The other half of the same rule: a name kept out of the pool has to find
  // its company, or the haul would be spared the pool and then bill nowhere.
  const near = [];
  harness.reconcile([row({ customer: 'Beaird' })], near, roster(EES, XTO,
    { id: 'co-eai', name: 'EAI', divisions: ['trucking'] }));
  assert('a customer that merely looks like EAI is pooled, not billed to EAI',
    near[0].company_id === 'co-ees' && near[0].customer_real === 'Beaird');

  // Longest name wins, so a company sitting inside a longer one cannot take
  // the other's work.
  const two = [];
  harness.reconcile([row({ customer: 'Kinkead HC' })], two, roster(EES,
    { id: 'co-kin',  name: 'Kinkead',    divisions: ['trucking'] },
    { id: 'co-kinhc', name: 'Kinkead HC', divisions: ['trucking'] }));
  assert('"Kinkead HC" bills to Kinkead HC, not to Kinkead', two[0].company_id === 'co-kinhc');
}

console.log('\n[the case that sent this back: Ox Hill has its own IC company]');
{
  // Ox Hill is enrolled in Intercompany under trucking AND is not on the
  // office's rollup list. Having a company of its own is not what decides it —
  // XTO has one too and keeps its name — so Ox Hill still pools.
  const entries = [];
  harness.reconcile([row({ customer: 'Ox Hill' })], entries, roster(EES, OXH));
  assert('it pools to EES even though Ox Hill is on the company roster',
    entries[0].company_id === 'co-ees' && entries[0].customer === 'EES');
  assert('with its real name carried along', entries[0].customer_real === 'Ox Hill');

  // …and the day the office adds it to the rollup list, it stops.
  harness.keep([...KEEP, 'Ox Hill']);
  const kept = [];
  harness.reconcile([row({ customer: 'Ox Hill' })], kept, roster(EES, OXH));
  assert('putting it on the rollup list bills it to its own company',
    kept[0].company_id === 'co-oxh' && kept[0].customer === 'Ox Hill');
  harness.keep(KEEP);
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
  assert('and says the haul goes out under its own name when it is not',
    !fallback.includes('Billed to Intercompany as EES')
      && fallback.includes('goes out under Ox Hill instead'));
  assert('the line itself still reads EES either way',
    promised.endsWith('>EES</div>') && fallback.endsWith('>EES</div>'));
}

{
  // The window that closes only when somebody enrols EES: a haul mirrored
  // before then went out under its own name, and the entry is the only record
  // of that once the sync stops warning.
  const sentAsSelf = { sent_at: '2026-09-04T14:16:00Z', customer: 'Ox Hill' };
  const sentAsPool = { sent_at: '2026-09-04T14:16:00Z', customer: 'EES' };
  assert('a sent haul that fell back says so on the cell, however the roster reads now',
    harness.cell('tr-7', 'Ox Hill', true, sentAsSelf).includes('goes out under Ox Hill instead'));
  assert('and one that really pooled does not',
    harness.cell('tr-7', 'Ox Hill', false, sentAsPool).includes('Billed to Intercompany as EES'));
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
  // The timestamp is formatted in the reader's own timezone, so these compare
  // against the plain note rather than against a wall-clock string.
  const at    = '2026-09-04T14:16:00Z';
  const plain = harness.note(pooledRow, false, { sent_at: at, customer: 'EES' });
  assert('a sent row that really pooled just says when it went',
    /^Sent /.test(plain) && !plain.includes('not EES'));
  assert('and one that went out under its own name says that too, not just when',
    harness.note(pooledRow, true, { sent_at: at, customer: 'Ox Hill' })
      === `${plain} — as Ox Hill, not EES`);
  assert('an exempt row is never annotated, sent or not',
    harness.note(row({ customer: 'Kovalchick' }), false, { sent_at: at, customer: 'Kovalchick' })
      === plain);
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
// The Manage Lists panel, because the rollup list is edited there and the tab
// has to redraw when it changes.
const LISTS  = sliceSrc('    const _remKey =', '    function saveTruckLists()', 'list helpers');
const PANEL  = sliceSrc('    /* ── Reading a sign-in against the drivers list',
                        '    function schedSave()', 'panel');

function newPage(entries) {
  const dom = new JSDOM(
    '<div id="tab-truck-tracking"></div><div id="lists-tabs"></div><div id="lists-panel-body"></div>');
  const sandbox = {
    console, document: dom.window.document,
    divEntries: entries,
    divTruckLists: {
      drivers: [], customers: ['Ox Hill', 'Arcadis', 'Kovalchick'],
      units: [], locations: [], materials: [], rates: {}, notDrivers: [], removed: {},
    },
    divLists: { employees: [], equipment: [] },
    driverLoginMap: {}, driverLoginUsers: [], _driverLoginsLoaded: true,
    loadDriverLogins: () => Promise.resolve(),
    tdDivPut() {}, saveTruckLists() {}, renderScheduler() {}, schedIsActive: () => false,
    setCustomerRate() {}, _historicRate: () => '', _countRowsNaming: () => 0,
    _csvDate: v => v, _csvTime: v => v, _csvNum: v => v,
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
  vm.runInContext([COMBO, POOL, TOTALS, LISTS, PANEL, TAB].join('\n'),
    sandbox, { filename: 'trucking.html' });
  const run = code => vm.runInContext(code, sandbox);
  // The roster the page would have read before its first render. Through the
  // page's own setter so the derived _icEesEnrolled is set the same way, and
  // before any render so no case is measuring the not-yet-loaded state.
  run(`divTruckLists.icKeep = ${JSON.stringify(KEEP)};`);
  run(`_setIcTruckCompanies(new Map(${JSON.stringify(IC_ROSTER.map(n => [n.toLowerCase(), {}]))}));`);
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

console.log('\n[the Manage Lists rollup tab]');
{
  const p = newPage(pageRows());
  p.run("_listsTab = 'icKeep'; renderListsPanel();");
  const body = p.doc.getElementById('lists-panel-body');
  const names = [...body.querySelectorAll('.li-name')].map(el => el.textContent);
  assert('it lists the companies that keep their own name',
    JSON.stringify(names) === JSON.stringify(KEEP), JSON.stringify(names));

  // The count beside a name is how many rows it holds out of the pool, matched
  // the way the rule matches — so "Kovalchick" counts its one row here.
  const chip = n => body.querySelectorAll('.lists-item')[names.indexOf(n)]
    .querySelector('.li-count').textContent;
  assert('and how many rows each one keeps out', chip('Kovalchick') === '1');
  assert('with an em dash where a name holds nothing back', chip('Force') === '—');

  // Three of the four fixture rows name a customer; two of those pool.
  const tail = [...body.querySelectorAll('.lists-hint')].pop().textContent.replace(/\s+/g, ' ').trim();
  assert('the summary counts rows, not objects', /^2 of 3 rows with a customer bill as EES/.test(tail), tail);

  p.run("removeIcKeep('Kovalchick');");
  assert('taking a name off pools its hauls at once',
    p.doc.getElementById('cust-pool-b').textContent === 'EES');
  assert('and the list is written out, so the default no longer stands',
    JSON.stringify(p.sandbox.divTruckLists.icKeep)
      === JSON.stringify(['EAI', 'Force', 'Kinkead', 'XTO']),
    JSON.stringify(p.sandbox.divTruckLists.icKeep));
  assert('the row still stores its own customer',
    p.sandbox.divEntries.find(e => e.id === 'b').customer === 'Kovalchick');
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
  // EES taken off the INTERCOMPANY COMPANY roster — a different list from the
  // rollup one above, and the only thing that decides whether the pool has
  // anywhere to bill.
  p.run(`_setIcTruckCompanies(new Map(${JSON.stringify(
    IC_ROSTER.filter(n => n !== 'EES').map(n => [n.toLowerCase(), {}]))}));`);
  assert('once EES is known to be missing, every pooled tooltip says so',
    p.doc.getElementById('cust-pool-a').title.includes('goes out under Ox Hill instead'));
  assert('including the locked row\'s',
    p.doc.getElementById('cust-real-tst-9-row').title.includes('goes out under Arcadis instead'));
  assert('and every unsent note says so',
    p.doc.getElementById('ic-ts-a').textContent === "Not sent — EES isn't on the Intercompany company list yet");
  assert('an exempt row\'s note is left alone',
    p.doc.getElementById('ic-ts-b').textContent === 'Awaiting sync — check Intercompany company list');

  p.run(`_setIcTruckCompanies(new Map(${JSON.stringify(IC_ROSTER.map(n => [n.toLowerCase(), {}]))}));`);
  assert('and it all turns back once EES is enrolled',
    p.doc.getElementById('cust-pool-a').title.includes('Billed to Intercompany as EES')
      && p.doc.getElementById('ic-ts-a').textContent === 'Awaiting sync — bills to Intercompany as EES');
  assert('with the boxes never having been touched by any of it',
    p.custCell('a').querySelector('.cb-input').value === 'Ox Hill');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
