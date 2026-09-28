#!/usr/bin/env node
'use strict';
/**
 * A failed read of the cost rows or the infill inventory must never reach the
 * server as the list.
 *
 * Run: node scripts/test-failed-read-guards.js
 *
 * Both lists are saved whole, and the server only refuses a save that would
 * leave one EMPTY. Three paths turned a failed read into a wrong list and then
 * saved it, in the same code on the turf, paving and kiewit pages:
 *
 *   The loaders. apiGet answers null both when nothing is stored and when the
 *   request failed, and on null each loader pushed a local copy back over the
 *   server's list: this browser's own inventory copy, written only when it
 *   last saved and so possibly weeks old, or a legacy cost-rows key nothing has
 *   written since the rows moved to the server. An answered EMPTY list pushed
 *   it too, bringing back rows someone had deleted.
 *
 *   The 60-second poll. A failed read became an empty list in memory, blanking
 *   the table. The next row anybody added was then saved as the whole list,
 *   replacing every other row on the server.
 *
 *   The saves. After a failed first load the page held an empty stand-in, and
 *   the first entry saved replaced the real list with a list of one.
 *
 * Each case below lifts the real functions out of each page and runs them
 * against a scripted server, for both lists.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Each division page keeps its own copy of these lists, under its own keys.
const PAGES = [
  { file: 'tracker.html',         p: '' },
  { file: 'paving.html',          p: 'paving_' },
  { file: 'kiewit-pinetree.html', p: 'kiewit_' },
];

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

/** A function out of a page, `async` included when it has one. */
function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

/** The text from `from` up to (not including) the next `until`. */
function extractBetween(src, from, until) {
  const start = src.indexOf(from);
  if (start < 0) throw new Error(`${from} not found`);
  const end = src.indexOf(until, start + from.length);
  if (end < 0) throw new Error(`${until} not found after ${from}`);
  return src.slice(start, end);
}

/** The two lists as one page stores them. */
function listsOf(SRC, p) {
  return {
    'cost rows': {
      key: `fct_${p}cost_rows`, localKey: `fct_${p}rows`, tab: 'cost', render: 'renderCostTable',
      list: 'costRows', loaded: '_costRowsLoaded',
      load: 'loadCostRows', save: 'saveCostRows', poll: '_pollCostRows',
      // COST_KEY and the declarations after it.
      state: () => extractBetween(SRC, `const COST_KEY = 'fct_${p}cost_rows';`, 'async function loadCostRows('),
      fns:   () => [extractFunction(SRC, 'loadCostRows'), extractFunction(SRC, 'saveCostRows')],
    },
    'inventory entries': {
      key: `fct_${p}inventory`, localKey: `fct_${p}inventory`, tab: 'inventory', render: 'renderInventoryTab',
      list: 'inventoryEntries', loaded: '_inventoryLoaded',
      load: 'loadInventoryEntries', save: 'saveInventoryEntries', poll: '_pollInventory',
      state: () => extractBetween(SRC, '/* ── Inventory store ── */', '/* ═══'),
      fns:   () => [extractFunction(SRC, 'loadInventoryEntries'), extractFunction(SRC, 'saveInventoryEntries')],
    },
  };
}

const OLD = [{ id: 'old-1' }, { id: 'old-2' }];                     // a stale local copy
const REAL = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];                // what the server holds

/**
 * A fresh copy of one list's code. `respond(n)` answers the n-th GET with
 * {status, body} or 'network'. `local` is what localStorage holds for the
 * list's migration key.
 */
function page(SRC, L, { respond, local = null, editing = false, tab = L.tab }) {
  const puts = [], banners = [], draws = [], stored = {};
  let gets = 0, logouts = 0;
  const stubs = {
    fetch: async () => {
      const r = respond(++gets);
      if (r === 'network') throw new Error('Failed to fetch');
      // A fresh copy per response, as a real fetch gives: the page may push into it.
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => JSON.parse(JSON.stringify(r.body)) };
    },
    API_BASE: '/api',
    fctToken: 'tok',
    logout: () => { logouts++; },
    localStorage: {
      getItem: k => (k === L.localKey && local ? JSON.stringify(local) : null),
      setItem: (k, v) => { stored[k] = v; },
    },
    apiPut: (key, value) => { puts.push({ key, value: JSON.parse(JSON.stringify(value)) }); },
    _showSaveError: (isAuth, msg, kept) => { banners.push({ isAuth, msg, kept }); },
    _isEditing: () => editing,
    activeTab: tab,
    [L.render]: () => draws.push(L.render),
  };
  const code = [
    extractFunction(SRC, 'apiGetChecked'),
    extractFunction(SRC, '_unloadedSaveRefused'),
    L.state(),
    ...L.fns(),
    extractFunction(SRC, L.poll),
    `return {
       load: ${L.load}, save: ${L.save}, poll: ${L.poll},
       get list() { return ${L.list}; }, set list(v) { ${L.list} = v; },
       get loaded() { return ${L.loaded}; },
     };`,
  ].join('\n');
  const api = new Function(...Object.keys(stubs), code)(...Object.values(stubs));
  return { api, puts, banners, draws, stored, logouts: () => logouts };
}

const ok200  = body => ({ status: 200, body: { value: body } });
const fail503 = { status: 503, body: { error: 'Could not check your access just now.' } };

(async () => {
  for (const { file, p } of PAGES) {
  const SRC = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const [list, L] of Object.entries(listsOf(SRC, p))) {
    const name = `${file} ${list}`;
    const mine = P => P.puts.filter(p => p.key === L.key);

    console.log(`\n[${name}: a failed first read saves nothing]`);
    for (const [label, r] of [['a 503', fail503], ['a 500', { status: 500, body: {} }], ['a dropped connection', 'network']]) {
      const P = page(SRC, L, { respond: () => r, local: OLD });
      await P.api.load();
      assert(`${label}: the local copy is not pushed back`, mine(P).length === 0, JSON.stringify(mine(P)));
      assert(`${label}: not loaded`, P.api.loaded === false);
      assert(`${label}: the page has an empty list to draw`, Array.isArray(P.api.list) && P.api.list.length === 0);
    }
    {
      const P = page(SRC, L, { respond: () => ({ status: 401, body: {} }) });
      await P.api.load();
      assert('a 401 signs out and saves nothing', P.logouts() === 1 && mine(P).length === 0);
    }

    console.log(`\n[${name}: an answered read]`);
    {
      const P = page(SRC, L, { respond: () => ok200(REAL), local: OLD });
      await P.api.load();
      assert('the server\'s list is adopted', JSON.stringify(P.api.list) === JSON.stringify(REAL));
      assert('loaded, and nothing pushed', P.api.loaded === true && mine(P).length === 0);
    }
    {
      const P = page(SRC, L, { respond: () => ok200(null), local: OLD });
      await P.api.load();
      assert('a server that has never held the list still takes the local copy',
        mine(P).length === 1 && JSON.stringify(mine(P)[0].value) === JSON.stringify(OLD) && P.api.loaded === true);
    }
    {
      const P = page(SRC, L, { respond: () => ok200([]), local: OLD });
      await P.api.load();
      assert('a list someone emptied stays empty — the old copy is not brought back',
        mine(P).length === 0 && P.api.list.length === 0 && P.api.loaded === true, JSON.stringify(mine(P)));
    }

    console.log(`\n[${name}: nothing is saved until the list has loaded]`);
    {
      const P = page(SRC, L, { respond: () => fail503 });
      await P.api.load();
      P.api.list.push({ id: 'new' });
      P.api.save();
      assert('a one-entry list is not saved over the real one', mine(P).length === 0, JSON.stringify(mine(P)));
      assert('the banner says why', P.banners.length === 1 && /not loaded/.test(P.banners[0].msg), JSON.stringify(P.banners));
      assert('without claiming the edit was kept', P.banners[0] && P.banners[0].kept === false);
      assert('and nothing is written to localStorage either', Object.keys(P.stored).length === 0);
    }
    {
      const P = page(SRC, L, { respond: () => ok200(REAL) });
      await P.api.load();
      P.api.list.push({ id: 'd' });
      P.api.save();
      assert('once loaded, a save carries the whole list', mine(P).length === 1 && mine(P)[0].value.length === 4);
    }

    console.log(`\n[${name}: the 60-second poll]`);
    {
      // Loaded fine, then a poll's read fails.
      let n = 0;
      const P = page(SRC, L, { respond: () => (++n === 1 ? ok200(REAL) : fail503) });
      await P.api.load();
      await P.api.poll();
      assert('a failed poll leaves the list as it was, not blank', JSON.stringify(P.api.list) === JSON.stringify(REAL), JSON.stringify(P.api.list));
      assert('and draws nothing', P.draws.length === 0);
      P.api.list.push({ id: 'd' });
      P.api.save();
      assert('so the next save still carries every row', mine(P).length === 1 && mine(P)[0].value.length === 4);
    }
    {
      // The first read failed; a later poll succeeds.
      let n = 0;
      const P = page(SRC, L, { respond: () => (++n === 1 ? fail503 : ok200(REAL)) });
      await P.api.load();
      await P.api.poll();
      assert('a successful poll finishes the load', P.api.loaded === true && JSON.stringify(P.api.list) === JSON.stringify(REAL));
      assert('and redraws the open tab', P.draws.includes(L.render), JSON.stringify(P.draws));
      P.api.save();
      assert('after which saving works', mine(P).length === 1 && mine(P)[0].value.length === 3);
    }
    {
      // The server really is empty, so the poll's answer equals the stand-in.
      let n = 0;
      const P = page(SRC, L, { respond: () => (++n === 1 ? fail503 : ok200([])) });
      await P.api.load();
      await P.api.poll();
      assert('an answered empty list still counts as loaded', P.api.loaded === true);
    }
    {
      let n = 0;
      const P = page(SRC, L, { respond: () => (++n === 1 ? fail503 : ok200(REAL)), editing: true });
      await P.api.load();
      await P.api.poll();
      assert('while someone is typing the poll waits, and the list stays unloaded', P.api.loaded === false && P.api.list.length === 0);
    }
  }
  }

  console.log('\n[no inventory entry can be touched before inventory loads]');
  for (const { file, p } of PAGES) {
    const SRC = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let refused = 0, puts = 0;
    const stubs = {
      _unloadedSaveRefused: () => { refused++; },
      apiPut: () => { puts++; },
      localStorage: { setItem() {} },
      uid: () => 'u1', nextINVNumber: () => 'INV-0001', _localDateStr: () => '2026-09-28',
      renderInventoryTab: () => {}, getProj: () => null, drDelete: () => {}, renderDailyTable: () => {},
    };
    const I = new Function(...Object.keys(stubs), [
      'let inventoryEntries = []; let _inventoryLoaded = false;',
      // The real save, so copy and delete are judged by what actually reaches the server.
      extractFunction(SRC, 'saveInventoryEntries'),
      extractFunction(SRC, 'addINV'), extractFunction(SRC, 'copyINV'), extractFunction(SRC, 'deleteINV'),
      `return { addINV, copyINV, deleteINV, get list() { return inventoryEntries; },
                load() { _inventoryLoaded = true; } };`,
    ].join('\n'))(...Object.values(stubs));
    I.addINV();
    assert(`${file}: adding an entry is refused`, refused === 1 && I.list.length === 0 && puts === 0, `${refused} refused, ${puts} saved`);
    I.copyINV('u1'); I.deleteINV('u1');
    assert(`${file}: copy and delete reach nothing on the server`, puts === 0 && I.list.length === 0);
    I.load(); I.addINV();
    assert(`${file}: once loaded, adding works`, I.list.length === 1 && puts === 1);

    // Picking a project posts a linked daily row before the entry is saved,
    // so the refusal has to come first.
    const head = SRC.slice(SRC.search(/(document\.getElementById\('inventory-root'\)|_invRoot)\.addEventListener\('change'/));
    const beforePost = head.slice(0, head.indexOf('drPost('));
    assert(`${file}: the project picker refuses before it posts a daily row`,
      beforePost.length > 0 && /if \(!_inventoryLoaded\) \{ _unloadedSaveRefused\('inventory entries'\); return; \}/.test(beforePost));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
