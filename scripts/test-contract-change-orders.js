#!/usr/bin/env node
'use strict';
/**
 * Contract change orders (project level) — paving.html
 *
 * Run: node scripts/test-contract-change-orders.js
 *
 * Bid-item change orders move QUANTITY; contract change orders move the
 * CONTRACT. This covers the second kind and the reporting that surfaces
 * both.
 *
 * Two layers, matching the house style of the other frontend tests:
 *   1. Structural — greps paving.html to verify the functions exist, the
 *      Contract & Financials panel hosts the field, the card badges read
 *      the same contract chain as the rest of the app, and the Job
 *      Summary Report carries both the inline base+CO line and the
 *      dedicated Change Orders section.
 *   2. Behavioural — evaluates the real contract-CO block inside a
 *      sandboxed vm with mocked globals and asserts on:
 *        - originalContract's fallback order (contract-amount →
 *          contract-value), deliberately excluding revised-amount
 *        - revised-amount === original + sum(CO amounts)
 *        - negative COs (deducted scope) reduce the contract
 *        - removing the last CO clears revised-amount so the original
 *          stands alone again and the old fallback chain is restored
 *        - editing the original re-derives the revised figure
 *        - a fresh project is untouched (no COs → no revised-amount)
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`);
  }
}

const SRC = fs.readFileSync(path.resolve(__dirname, '../paving.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// 1) STRUCTURAL
// ─────────────────────────────────────────────────────────────────────
console.log('\n[structural — contract CO plumbing]');

for (const fn of ['contractCOs', 'contractCOTotal', 'originalContract', 'revisedContract',
                  'projectContract', 'syncRevisedContract', 'renderContractCOField',
                  'showContractCOModal', '_addContractCO', '_removeContractCO']) {
  const defs = (SRC.match(new RegExp(`function ${fn}\\b`, 'g')) || []).length;
  assert(`defines ${fn} exactly once`, defs === 1, `found ${defs}`);
}

// originalContract must NOT read revised-amount — that's the derived field,
// and reading it would compound the change orders on every edit.
const origFn = SRC.match(/function originalContract\([\s\S]+?\n\}/);
assert('originalContract ignores revised-amount', !!origFn && !/revised-amount/.test(origFn[0]));
assert('originalContract falls back contract-amount → contract-value',
  !!origFn && /contract-amount[\s\S]+contract-value/.test(origFn[0]));

// syncRevisedContract writes the derived figure and clears it when empty
const syncFn = SRC.match(/function syncRevisedContract\([\s\S]+?\n\}\n/);
assert('syncRevisedContract writes revised-amount',   !!syncFn && /p\['revised-amount'\]\s*=/.test(syncFn[0]));
assert('syncRevisedContract clears when no COs left', !!syncFn && /cos\.length \?[\s\S]+: ''/.test(syncFn[0]));
assert('syncRevisedContract persists',                !!syncFn && /saveProject\(projId\)/.test(syncFn[0]));

// add/remove persist through the normal project-blob path
for (const fn of ['_addContractCO', '_removeContractCO']) {
  const m = SRC.match(new RegExp(`function ${fn}\\([^)]*\\)[\\s\\S]+?\\n\\}\\n`));
  assert(`${fn} calls syncRevisedContract`, !!m && /syncRevisedContract\(projId\)/.test(m[0]));
}

// projectContract must not recurse into itself — the fallback chain is the
// literal read, not another call.
const pcFn = SRC.match(/function projectContract\(p\)[\s\S]+?\n\}/);
assert('projectContract does not recurse',
  !!pcFn && (pcFn[0].match(/projectContract\(/g) || []).length === 1);
assert('projectContract derives live when COs exist',
  !!pcFn && /contractCOs\(p\)\.length\) return revisedContract\(p\)/.test(pcFn[0]));

// contractCOs must be a pure read — a side-effecting accessor would stamp
// an empty array onto every project the dashboard renders.
const ccosFn = SRC.match(/function contractCOs\(p\)[\s\S]+?\n\}/);
assert('contractCOs does not mutate', !!ccosFn && !/p\['contract-cos'\]\s*=/.test(ccosFn[0]));
assert('_addContractCO initialises the array itself',
  /function _addContractCO[\s\S]+?if \(!Array\.isArray\(p\['contract-cos'\]\)\) p\['contract-cos'\] = \[\]/.test(SRC));

// Every screen quotes the same contract figure.
const rawChains = (SRC.match(/parseFloat\(p\['revised-amount'\]\) \|\| parseFloat\(p\['contract-amount'\]\)/g) || []).length;
assert('only projectContract holds the raw fallback chain', rawChains === 1, `found ${rawChains}`);
const callSites = (SRC.match(/= *projectContract\(p\);/g) || []).length;
assert('all contract read sites routed through it', callSites >= 7, `found ${callSites}`);

console.log('\n[structural — Contract & Financials panel]');
assert('panel hosts the CO field',            /id="cco-field-\$\{p\.id\}"/.test(SRC));
assert('revised input is addressable by id',  /id="revamt-\$\{p\.id\}"/.test(SRC));
assert('revised input disabled when COs set', /_cos\.length \? 'disabled/.test(SRC));
// The input must show the live derivation, not the cached field, so a stale
// 'revised-amount' can never be displayed next to the COs that contradict it.
assert('revised input renders the live derivation',
  /_cos\.length \? String\(Math\.round\(revisedContract\(p\) \* 100\) \/ 100\) : \(p\['revised-amount'\] \|\| ''\)/.test(SRC));
assert('CO field re-rendered after card build',
  /pageItems\.forEach\(p => \{[^}]*renderContractCOField\(p\.id\)/.test(SRC));
// Editing the original has to carry through to the derived revised figure
const updField = SRC.match(/function updateProjectField\([\s\S]+?\n\}\n/);
assert('updateProjectField re-derives on contract edits',
  !!updField && /contract-amount' \|\| field === 'contract-value'[\s\S]+syncRevisedContract/.test(updField[0]));

console.log('\n[structural — project card badges]');
const cardFn = SRC.match(/function projectCardHTML\(p\)[\s\S]+?\n\}\n/);
assert('card contract badge uses projectContract',
  !!cardFn && /const contractValue = projectContract\(p\);/.test(cardFn[0]));
assert('card bid badge includes bid-item COs',
  !!cardFn && /_cardEffQty[\s\S]+qty_delta/.test(cardFn[0]));
assert('card shows a CO badge when there are contract COs',
  !!cardFn && /ccoTotal \? `<span class="proj-badge/.test(cardFn[0]));

console.log('\n[structural — Job Summary Report]');
const jsFn = SRC.match(/async function exportJobSummary\(projId, opts = \{\}\)[\s\S]+?\n\}\n\nfunction exportBidPDF/);
assert('job summary block located', !!jsFn);
const js = jsFn ? jsFn[0] : '';
assert('inline base + CO line on bid rows',    /class="co-line"[\s\S]*base [\s\S]*CO/.test(js));
assert('co-line style shipped in the report',  /\.co-line \{/.test(js));
assert('builds a Change Orders section',       /const coSectionHTML/.test(js));
assert('section injected into the report body',/\$\{coSectionHTML\}/.test(js));
assert('lists contract COs',                   /Contract Change Orders/.test(js));
assert('lists bid-item quantity COs',          /Bid Item Quantity Change Orders/.test(js));
assert('reports qty CO cost impact',           /coQtyCostImpact/.test(js));
assert('splits Original / CO / Revised in the fin bar',
  /Original Contract[\s\S]+Change Orders \(\$\{ccos\.length\}\)[\s\S]+Revised Contract/.test(js));
assert('keeps the single Contract Value metric when there are no COs',
  /: `<div class="sum-metric"><div class="sum-label">Contract Value/.test(js));

console.log('\n[structural — Bid Items summary bar]');
const footFn = SRC.match(/function renderBidFooter\([\s\S]+?\n\}\n\nfunction removeBidGroup/);
assert('bid footer splits contract when COs exist',
  !!footFn && /Original Contract[\s\S]+Change Orders[\s\S]+Revised Contract/.test(footFn[0]));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL — run the real functions in a sandbox.
// ─────────────────────────────────────────────────────────────────────
console.log('\n[behavioural — derived revised contract]');

function extractBlock(src, startLabel, endLabel) {
  const start = src.indexOf(startLabel);
  const end   = src.indexOf(endLabel, start);
  if (start < 0 || end < 0) throw new Error(`extractBlock: missing labels ${startLabel} / ${endLabel}`);
  return src.slice(start, end);
}

// Everything from the contract-CO helpers up to (not including) the
// bid-item CO modal — the DOM-touching modal builders are excluded.
const block = extractBlock(SRC, 'function contractCOs(p) {', 'function showContractCOModal(projId) {');

const projects = {};
let saveCalls = 0;
let coFieldRenders = 0;
let uidSeq = 0;

const ctx = {
  getProj:               id => projects[id],
  saveProject:           () => { saveCalls++; },
  renderContractCOField: () => { coFieldRenders++; },
  document:              { getElementById: () => null },   // detached — no card in the DOM
  esc:                   s => String(s || ''),
  fmt:                   n => String(n),
  uid:                   () => 'co' + (++uidSeq),
  console,
};
vm.createContext(ctx);
vm.runInContext(block, ctx);

// Mirrors _addContractCO / _removeContractCO without their DOM reads.
const addCO = (id, co) => {
  const p = projects[id];
  if (!Array.isArray(p['contract-cos'])) p['contract-cos'] = [];
  p['contract-cos'].push({ id: ctx.uid(), ...co });
  ctx.syncRevisedContract(id);
};
const rmCO  = (id, coId) => { projects[id]['contract-cos'] = ctx.contractCOs(projects[id]).filter(c => c.id !== coId); ctx.syncRevisedContract(id); };

// -- originalContract fallback order ---------------------------------
projects.a = { id: 'a', 'contract-amount': '200000', 'contract-value': '123894' };
assert('original prefers contract-amount', ctx.originalContract(projects.a) === 200000,
  String(ctx.originalContract(projects.a)));

// The Atwood shape: contract keyed only into the Project Details grid.
projects.b = { id: 'b', 'contract-value': '123894' };
assert('original falls back to contract-value', ctx.originalContract(projects.b) === 123894,
  String(ctx.originalContract(projects.b)));

// A stale revised-amount must never be treated as the original, or each
// edit would stack the change orders on top of themselves.
projects.c = { id: 'c', 'contract-value': '100000', 'revised-amount': '999999' };
assert('original ignores a stale revised-amount', ctx.originalContract(projects.c) === 100000,
  String(ctx.originalContract(projects.c)));

// -- a fresh project is untouched -------------------------------------
projects.d = { id: 'd', 'contract-value': '123894' };
assert('no COs → total is 0',           ctx.contractCOTotal(projects.d) === 0);
assert('no COs → revised stays unset',  !projects.d['revised-amount']);

// -- adding COs -------------------------------------------------------
projects.e = { id: 'e', 'contract-value': '123894' };
addCO('e', { date: '2026-03-02', number: 'CO-1', amount: 8500, note: 'Extra base repair' });
assert('one CO → revised = original + CO', projects.e['revised-amount'] === '132394',
  projects.e['revised-amount']);
assert('adding a CO saves the project',    saveCalls === 1, String(saveCalls));

addCO('e', { date: '2026-03-19', number: 'CO-2', amount: 2150.75, note: 'Added striping' });
assert('two COs accumulate',               projects.e['revised-amount'] === '134544.75',
  projects.e['revised-amount']);
assert('CO total sums both',               ctx.contractCOTotal(projects.e) === 10650.75,
  String(ctx.contractCOTotal(projects.e)));

// -- deducted scope ---------------------------------------------------
addCO('e', { date: '2026-04-01', number: 'CO-3', amount: -5000, note: 'Owner deleted cul-de-sac' });
assert('a negative CO reduces the contract', projects.e['revised-amount'] === '129544.75',
  projects.e['revised-amount']);

// Float noise must not leak into a dollar field.
projects.f = { id: 'f', 'contract-amount': '0.1' };
addCO('f', { date: '2026-01-01', number: 'CO-1', amount: 0.2, note: '' });
assert('rounds to cents, no float dust', projects.f['revised-amount'] === '0.3',
  projects.f['revised-amount']);

// -- editing the original re-derives ----------------------------------
projects.e['contract-amount'] = '150000';
ctx.syncRevisedContract('e');
assert('editing the original re-derives revised', projects.e['revised-amount'] === '155650.75',
  projects.e['revised-amount']);

// -- removing COs -----------------------------------------------------
const ids = projects.e['contract-cos'].map(c => c.id);
rmCO('e', ids[2]);
assert('removing a CO re-derives',  projects.e['revised-amount'] === '160650.75',
  projects.e['revised-amount']);
rmCO('e', ids[0]);
rmCO('e', ids[1]);
assert('removing the last CO clears revised-amount', projects.e['revised-amount'] === '',
  JSON.stringify(projects.e['revised-amount']));
// With revised-amount blank the app-wide chain falls through to the
// original, exactly as it behaved before contract COs existed.
const chain = p => parseFloat(p['revised-amount']) || parseFloat(p['contract-amount']) || parseFloat(p['contract-value']) || 0;
assert('contract chain falls back to the original', chain(projects.e) === 150000, String(chain(projects.e)));

// -- contractCOs is safe on a project that has never seen one ---------
projects.g = { id: 'g' };
assert('contractCOs returns an array',   Array.isArray(ctx.contractCOs(projects.g)));
assert('contractCOs leaves the blob alone', !('contract-cos' in projects.g));
assert('contractCOs coerces bad values', (() => {
  projects.h = { id: 'h', 'contract-cos': 'not-an-array' };
  return Array.isArray(ctx.contractCOs(projects.h)) && ctx.contractCOs(projects.h).length === 0;
})());

// -- projectContract: the figure every screen quotes ------------------
console.log('\n[behavioural — projectContract]');
projects.j = { id: 'j', 'contract-value': '123894' };
assert('no COs → legacy chain', ctx.projectContract(projects.j) === 123894,
  String(ctx.projectContract(projects.j)));
projects.j['revised-amount'] = '130000';
assert('no COs → a hand-keyed revised amount still wins',
  ctx.projectContract(projects.j) === 130000, String(ctx.projectContract(projects.j)));

// The bug this helper exists for: contract COs present but 'revised-amount'
// stale (blob written by another path, or never synced). The live
// derivation has to win, or a printed report quotes the wrong contract.
projects.k = { id: 'k', 'contract-value': '123894', 'revised-amount': '123894', 'contract-cos': [
  { id: 'c1', date: '2026-03-02', number: 'CO-1', amount: 8500,  note: '' },
  { id: 'c2', date: '2026-04-11', number: 'CO-2', amount: -3200, note: '' },
] };
assert('stale revised-amount does not win over live COs',
  ctx.projectContract(projects.k) === 129194, String(ctx.projectContract(projects.k)));
assert('profit uses the CO-adjusted contract',
  ctx.projectContract(projects.k) - 63000 === 66194,
  String(ctx.projectContract(projects.k) - 63000));
assert('projectContract handles a missing project', ctx.projectContract(null) === 0);

// -- amounts typed as strings (what the DOM actually yields) ----------
projects.i = { id: 'i', 'contract-value': '100000', 'contract-cos': [
  { id: 'x', date: '2026-01-01', number: 'CO-1', amount: '2500.50', note: '' },
] };
assert('string amounts are parsed', ctx.contractCOTotal(projects.i) === 2500.5,
  String(ctx.contractCOTotal(projects.i)));
assert('revisedContract composes',  ctx.revisedContract(projects.i) === 102500.5,
  String(ctx.revisedContract(projects.i)));

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
