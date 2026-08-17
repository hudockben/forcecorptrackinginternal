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
function slice(from, to, label) {
  const a = SRC.indexOf(from);
  const b = a < 0 ? -1 : SRC.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : to})`);
  return SRC.slice(a, b);
}

console.log('Payroll cost-tracking modal guards\n');

// ── 1) Structural ───────────────────────────────────────────────────────────
console.log('[the pre-fill cannot be mistaken for an empty row]');
{
  const open = slice('async function openQuarryModal(entry, mode)', '\n    function closeQuarry()', 'openQuarryModal');
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

  const close = slice('function closeQuarry()', 'bindBackdropClose(document.getElementById(\'quarryBackdrop\')', 'closeQuarry');
  assert('closing orphans a pre-fill still in flight',
    /quarryFetchSeq\+\+/.test(close) && /quarryRowLoad = 'none'/.test(close));

  const save = slice('async function quarrySave()', '\n    // ──', 'quarrySave');
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
    q_rate: { value: '42' }, q_fuelGallons: { value: '0' }, q_fuelCost: { value: '0' },
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
  vm.runInContext(slice('async function quarrySave()', '\n    // ──', 'quarrySave') + '\nquarrySave();', ctx);
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

console.log('\n[the turf/paving split modal has the same guard]');
{
  const open = slice('async function openSplitModal(entry, mode)', '\n    function closeSplit()', 'openSplitModal');
  assert('a refusal is thrown rather than read as "no split"',
    /if \(!r\.ok\) throw new Error/.test(open));
  assert('the pre-fill records whether it landed',
    /splitRowLoad = 'loaded'/.test(open) && /splitRowLoad = 'failed'/.test(open));
  assert('a late answer for another entry is dropped',
    /const seq = \+\+splitFetchSeq/.test(open) && /if \(seq !== splitFetchSeq\) return/.test(open));
  assert('and a fresh approve has nothing to load',
    /splitRowLoad = mode === 'resplit' \? 'pending' : 'none'/.test(open));

  const close = slice('function closeSplit()', "bindBackdropClose(document.getElementById('splitBackdrop')", 'closeSplit');
  assert('closing orphans a pre-fill still in flight',
    /splitFetchSeq\+\+/.test(close) && /splitRowLoad = 'none'/.test(close));

  const save = slice('async function splitSave()', '\n    // ──', 'splitSave');
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
