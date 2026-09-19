#!/usr/bin/env node
'use strict';
/**
 * The material a crushing day was making, from the approval to the grid.
 *
 * Run: node scripts/test-quarry-crush-product.js
 *
 * Crushing Tracking has always had a Product column, and for the rows that
 * matter it was always empty. A row typed into the quarry tab could carry one;
 * a row injected from an approved timesheet could not, because nothing ever
 * asked — and those injected rows are most of the tab. So the tons existed and
 * the material they were did not, which put every figure that groups by
 * material out of reach: tons per hour by product, cost per ton, and what is
 * actually on the ground once sales are taken off.
 *
 * Payroll asks at the approval now, where the supervisor signing the day is the
 * one person who knows the answer. Three paths inject a crushing row and all
 * three ask: the single Approve & Inject modal, bulk approve, and a division
 * override pointed at a crushing job.
 *
 * What this suite is really guarding is a chain of key names across four files.
 * The row is stored as the id/name PAIR the quarry tab already uses for
 * location and employee — productId and productName — and every link has to
 * spell it the same way:
 *
 *   payroll's form  →  validateQuarryInjection  →  buildQuarryRow  →  the blob
 *                                                                  →  the grid
 *
 * A mismatch anywhere does not fail loudly. The approve succeeds, the row
 * lands, and the Product column is blank exactly as it was before — or worse:
 * the modal posts every box blank-included, so a form pre-filling from a key
 * the row does not carry wipes the product on every later Edit Row, on a row
 * the quarry tab renders read-only and nobody over there can put back.
 *
 * The product is REQUIRED. A crushing day cannot be approved without naming
 * the material, on any of the three paths — an untagged row is tons with no
 * material on them, and the quarry tab renders an injected row read-only, so
 * it is not a gap anyone downstream can close afterwards. The server is the
 * backstop; each form refuses first so the approver is told beside the box
 * rather than by an error after the click.
 *
 * Two things about that check are worth saying out loud, because getting
 * either wrong takes down every crushing approval in the company. The product
 * is a STRING and must stay out of the numeric range loop — quarryNum returns
 * null for any real name, and the loop turns a null into a 400 reading
 * "productName must be between 0 and undefined". And the check must come AFTER
 * that loop, so a day with both a bad number and no product is still told
 * about the number the approver can actually see on screen.
 *
 * Required means "answer it", not "answer it off the list": when the product
 * list fails to load, every form degrades to a typed box. A list that did not
 * load must not be able to stop a day being approved.
 *
 * No DB, no browser.
 */

const fs   = require('fs');
const path = require('path');
const { sliceSource } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const PAYROLL = read('payroll.html');
const QUARRY  = read('quarry.html');
const SYNC    = read('api/lib/sync-normalized.js');
const SCHEMA  = read('neon-schema.sql');

const { validateQuarryInjection, buildQuarryRow } =
  require('../api/timesheet-entries.js')._test;

// Every structural check below is scoped to ONE function before it is matched.
// Matching these pages whole is worse than no check at all: the quarry tab's
// SALES grid renders an injected row with the same `ro(row.productName)` and
// normalizes the same productId/productName pair, so a whole-file regex for
// either goes green with the crushing Product column deleted — which is the
// exact state this change exists to end.
const inPayroll = (from, to, label, must) => sliceSource(PAYROLL, from, to, label, must);
const inQuarry  = (from, to, label, must) => sliceSource(QUARRY,  from, to, label, must);

// buildQuarryRow only reaches the database to put a NAME on the location and
// the employee. Neither is what this suite is about, and an empty answer is a
// case the function already handles (it falls back to the job label), so the
// stub simply never finds anything.
const sql = async () => [];

const ENTRY = {
  id: 91,
  username: 'himesjacob',
  work_date: '2026-09-15',
  computed_hours: 8,
  job_id: 'crushing:loc-mcgees',
  job_label: 'Crushing — Mcgees Mills',
};

// ── 1) The approval keeps it ────────────────────────────────────────────────
function approvalTests() {
  console.log('[what the approval accepts]');
  const { fields, error } = validateQuarryInjection('crushing', {
    productId: 'p-2a', productName: '2A Modified',
    hourlyRate: 26, hoursCrushing: 8, loadsToCrusher: 27, tonsPerLoad: 30,
    fuelGallons: 280, fuelCost: 5, comments: 'Belt to the Diester broke.',
  });
  assert('a crushing approval carrying a product is accepted', !error, error);
  assert('the name comes through', fields && fields.productName === '2A Modified',
    JSON.stringify(fields && fields.productName));
  assert('and the id with it', fields && fields.productId === 'p-2a',
    JSON.stringify(fields && fields.productId));

  // The one that would take down every crushing approval: a product run
  // through quarryNum comes back null on any real name, and the loop that
  // range-checks the numbers turns a null into a 400. "productName must be
  // between 0 and undefined" is what that looks like from the approver's side.
  assert('a product name is never range-checked as a number',
    !/productName must be between/.test(String(error || '')), error);

  // Required, and this is the backstop every path goes through.
  const none = validateQuarryInjection('crushing', {
    hourlyRate: 26, hoursCrushing: 8, loadsToCrusher: 0, tonsPerLoad: 0,
    fuelGallons: 0, fuelCost: 0, comments: '',
  });
  assert('a day with no product is refused', !!none.error, JSON.stringify(none.fields));
  assert('…and told what to do about it',
    /product this day was crushing/.test(String(none.error || '')), none.error);
  assert('…with no fields handed back to write a row from', !none.fields, JSON.stringify(none.fields));

  // Whitespace is not an answer either — it would tag the row with nothing and
  // read as answered everywhere downstream.
  const blank = validateQuarryInjection('crushing', {
    productName: '   ', hourlyRate: 26, hoursCrushing: 8, loadsToCrusher: 0,
    tonsPerLoad: 0, fuelGallons: 0, fuelCost: 0,
  });
  assert('nor is a name of nothing but spaces', !!blank.error, JSON.stringify(blank.fields));

  // Off the list is still an answer: when the product list fails to load every
  // form degrades to a typed box, and a list that did not load must not be able
  // to stop the day being approved.
  const typed = validateQuarryInjection('crushing', {
    productName: 'Screened Sand', hourlyRate: 26, hoursCrushing: 8,
    loadsToCrusher: 0, tonsPerLoad: 0, fuelGallons: 0, fuelCost: 0,
  });
  assert('a typed name with no id behind it is accepted',
    !typed.error && typed.fields.productName === 'Screened Sand' && typed.fields.productId === '',
    JSON.stringify(typed.error || typed.fields));

  // The numbers beside it still are checked — the product did not loosen them.
  const bad = validateQuarryInjection('crushing', {
    productName: '2A Modified', hourlyRate: 26, hoursCrushing: 8,
    loadsToCrusher: 0, tonsPerLoad: 0, fuelGallons: 10, fuelCost: 855,
  });
  assert('a day\'s fuel bill typed into the per-gallon box is still refused',
    /per gallon/.test(String(bad.error || '')), bad.error);

  // Order matters: a day with BOTH problems is told about the one on screen.
  const both = validateQuarryInjection('crushing', {
    hourlyRate: 26, hoursCrushing: 8, loadsToCrusher: 0, tonsPerLoad: 0,
    fuelGallons: 10, fuelCost: 855,
  });
  assert('and a day with both problems names the number, not the product',
    /per gallon/.test(String(both.error || '')), both.error);
}

// ── 2) The row it builds ────────────────────────────────────────────────────
async function rowTests() {
  console.log('\n[what lands in the blob]');
  const { fields } = validateQuarryInjection('crushing', {
    productId: 'p-2a', productName: '2A Modified',
    hourlyRate: 26, hoursCrushing: 8, loadsToCrusher: 27, tonsPerLoad: 30,
    fuelGallons: 280, fuelCost: 5, comments: '',
  });
  const row = await buildQuarryRow(sql, 'FCT', ENTRY, 'crushing', fields);

  assert('the injected row carries the product name', row.productName === '2A Modified',
    JSON.stringify(row.productName));
  assert('and the product id', row.productId === 'p-2a', JSON.stringify(row.productId));
  assert('under exactly the keys the crushing grid stores',
    'productId' in row && 'productName' in row, Object.keys(row).join(','));
  // Not `product`, not `material`. normalizeCrushRow in quarry.html whitelists
  // the row on every read, so a third spelling is destroyed on the next fetch.
  assert('and no third spelling alongside them',
    !('product' in row) && !('material' in row), Object.keys(row).join(','));

  // Daily is equipment and a task. It is the crusher that makes a product, and
  // a product key on a Daily row would be a column the Daily grid never shows.
  const daily = validateQuarryInjection('daily', {
    equipmentName: 'Loader', taskName: 'Stripping', rate: 26, fuelGallons: 0, ppg: 0,
  });
  const dailyRow = await buildQuarryRow(sql, 'FCT', ENTRY, 'daily', daily.fields);
  assert('a Daily row is not given one', !('productName' in dailyRow),
    Object.keys(dailyRow).join(','));
}

// ── 3) The names agree with the tab that has to render them ─────────────────
// The chain's far end, and the reason a mismatch is silent: the grid reads one
// key, and anything else the row carries is simply not drawn.
function gridTests() {
  console.log('\n[the grid reads the same keys]');
  // The CRUSHING row renderer alone — not the sales one that spells its own
  // product cell identically.
  const crushRow = inQuarry('function crushRowHtml(row, i, g, day)', '\n    function updateCrushSummary(',
                            'crushRowHtml', "cbHtml('crush:' + i, 'product'");
  const injected = crushRow.slice(crushRow.indexOf('if (isTimesheetRow(row))'),
                                  crushRow.indexOf("cbHtml('crush:' + i, 'product'"));
  assert('the Product cell of an injected crushing row reads row.productName',
    /ro\(row\.productName\)/.test(injected), injected.slice(0, 200));
  assert('and a typed crushing row edits the same field',
    /cbHtml\('crush:' \+ i, 'product',\s+row\.productName/.test(crushRow));
  // normalizeCrushRow is the whitelist every crushing row is read through: a
  // key it does not name is destroyed on the next fetch.
  const norm = /function normalizeCrushRow\(r\)[\s\S]*?\n    }/.exec(QUARRY);
  assert('the row normalizer keeps both halves of the pair',
    !!norm && /productId: row\.productId/.test(norm[0]) && /productName: row\.productName/.test(norm[0]));
}

// ── 4) Every path that injects a crushing row asks ──────────────────────────
// Structural, because these three live in one 740KB page and the bug is one of
// them quietly not being wired — which shows up as untagged rows, not an error.
function pathTests() {
  console.log('\n[all three approval paths ask the question]');
  // All three send the pair with the same two lines of code, so each of these
  // is scoped to the one function that has to carry it — matched against the
  // whole page they stand in for each other and two of the three prove nothing.
  const fields  = inPayroll('function quarryFieldsHtml(activity, row)', '\n    function openQuarryModalById(',
                            'quarryFieldsHtml', 'q_fuelCostAuto');
  const collect = inPayroll('function collectQuarryFields(activity)', '\n    async function quarrySave()',
                            'collectQuarryFields', 'ppg:');
  assert('the single Approve & Inject modal has the picker',
    /_qProductField\('q_productName'/.test(fields));
  assert('…and its own collector posts what the picker holds',
    /productId:\s+quarryProductIdFor\(productName\)/.test(collect), collect.slice(0, 200));

  // buildBulkBody returns a hardcoded literal rather than spreading the group
  // template, so a bulk card can render a box whose value is dropped on the
  // way out. Card, template key and payload are asserted separately.
  const card   = inPayroll('function bulkGroupCard(g, idx)', '\n    function bulkSkippedCard()',
                           'bulkGroupCard', 'Quarry Crushing');
  const groups = inPayroll('function buildBulkGroups(entries)', '\n    async function openBulkApprove(',
                           'buildBulkGroups', 'haul_fee_source');
  const body   = inPayroll('function buildBulkBody(g, e)', '\n    async function bulkRun()',
                           'buildBulkBody', "g.type === 'trucking'");
  assert('the bulk crushing card has one too',
    /_bulkProduct\(idx, 'productName'/.test(card));
  assert('…with the template key declared, so the box has somewhere to land',
    /\n\s+productName: '',/.test(groups), groups.slice(0, 120));
  assert('…and bulk actually sends it, not just shows it',
    /productName, productId: quarryProductIdFor\(productName\)/.test(body), body.slice(0, 200));

  // A division override is the path with no second chance: the row is born
  // read-only in the quarry tab and this modal is the only form it ever
  // passes through.
  const cell    = inPayroll('function splitDestWindowHtml(r, i)', '\n    async function splitOnDestDivision(',
                            'splitDestWindowHtml', 'dest-window');
  const payload = inPayroll('function splitRowPayload(r)', '\n    function splitDestCellHtml(',
                            'splitRowPayload', 'out.dest.quarry');
  const reopen  = inPayroll('async function openSplitModal(entry, mode)', '\n    function splitSeedRowHaul(',
                            'openSplitModal', 'dest_rate:');
  assert('a crushing division override asks as well',
    /splitOnChange\(\$\{i\},'dest_product',this\.value\)/.test(cell));
  assert('…sends it with the row',
    /productName, productId: quarryProductIdFor\(productName\),/.test(payload), payload.slice(0, 200));
  assert('…and reads it back when the split is re-opened, so a re-save keeps it',
    /dest_product:\s+\(r\.dest && r\.dest\.extras && r\.dest\.extras\.productName\)/.test(reopen));
}

// ── 5) Each form refuses first ─────────────────────────────────────────────
// The server is the backstop, but a supervisor should be told beside the box,
// not by an error after the click — and on bulk it matters more than that: one
// card stands for a whole pit's week, so an unguarded card would 400 once per
// day and report as a string of failed approvals.
function guardTests() {
  console.log('\n[and every form refuses before the server has to]');
  const save    = inPayroll('async function quarrySave()', '\n    async function unapproveEntry(',
                            'quarrySave', 'action=');
  const bulkRun = inPayroll('async function bulkRun()', '\n    function goToDivisions(',
                            'bulkRun', 'buildBulkBody');
  const runBtn  = inPayroll('function updateBulkRunBtn()', '\n    function bulkApplyHaulDefaults(',
                            'updateBulkRunBtn', 'btn.disabled');
  const splitSv = inPayroll('async function splitSave()', '\n    async function loadQuarryListsOnce(',
                            'splitSave', 'Add at least one row.');

  assert('the approve modal refuses to post an untagged crushing day',
    /activity === 'crushing' && !String\(quarry\.productName \|\| ''\)\.trim\(\)/.test(save), save.slice(0, 200));
  // …and only after the pre-fill guard, or an Edit Row whose row never loaded
  // would be refused for a product the form has not had a chance to show yet.
  assert('…after the guard that stops a save wiping a row it never read',
    save.indexOf("quarryRowLoad === 'pending'") < save.indexOf('productName'));

  assert('bulk refuses to run a crushing card with no material named',
    /bulkQuarryNeedsProduct/.test(bulkRun), bulkRun.slice(0, 200));
  assert('…and the Approve button is disabled until it has one',
    /bulkQuarryNeedsProduct\(g\)/.test(runBtn), runBtn.slice(0, 200));

  assert('and a crushing division override is refused without one',
    /dest_product/.test(splitSv) && /cannot tag it afterwards/.test(splitSv), splitSv.slice(0, 200));
}

// ── 6) The SQL mirror ───────────────────────────────────────────────────────
// Nothing reads these columns today — every quarry report works off the blob —
// but the mirror is what makes per-material reporting possible in SQL later,
// and a sync that writes a column the table has not got throws INSIDE the
// approve, which rolls the approval back. The ALTER has to exist.
function mirrorTests() {
  console.log('\n[and the normalized mirror can hold it]');
  const crush = /async function syncQuarryCrushing[\s\S]*?\n}/.exec(SYNC);
  assert('the crushing sync writes both columns',
    !!crush && /product_id, product_name/.test(crush[0]));
  assert('…and updates them on a re-sync, so an Edit Row is not lost',
    !!crush && /product_id\s+= EXCLUDED\.product_id/.test(crush[0])
    && /product_name\s+= EXCLUDED\.product_name/.test(crush[0]));
  assert('the table has the columns to write into',
    /ALTER TABLE quarry_crushing_entries ADD COLUMN IF NOT EXISTS product_id/.test(SCHEMA)
    && /ALTER TABLE quarry_crushing_entries ADD COLUMN IF NOT EXISTS product_name/.test(SCHEMA));
  assert('idempotently, so a deployed database picks it up',
    !/ALTER TABLE quarry_crushing_entries ADD COLUMN (?!IF NOT EXISTS)/.test(SCHEMA));
}

(async () => {
  console.log('The product a crushing day was making\n');
  approvalTests();
  await rowTests();
  gridTests();
  pathTests();
  guardTests();
  mirrorTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('Harness error:', err);
  process.exit(1);
});
