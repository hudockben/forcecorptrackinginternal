#!/usr/bin/env node
'use strict';
/**
 * Tests for the background poll guards on the three tracker pages.
 *
 * Run: node scripts/test-poll-convergence.js
 *
 * Background: a single browser generated ~12.8K function invocations in 50
 * minutes against production — roughly 4 requests a second from timers that
 * fire every 30-60 seconds. The cause was _pollProjects deciding "the index
 * changed" on every single tick and calling loadProjects(), which issues
 * eight-plus requests including two full daily-rows reads.
 *
 * The old guard was:
 *
 *   const curIds    = projectsList.map(p => p.id).sort().join(',');
 *   const newIds    = index.sort().join(',');
 *   const tsChanged = incomingTs && incomingTs !== _lastProjIndexTs;
 *   if (curIds === newIds && index.length > 0 && !tsChanged) return;
 *
 * Both halves can be permanently false:
 *
 *   - curIds vs newIds compares the in-memory list against the server index,
 *     but loadProjects() DROPS any id whose blob is missing on the server. One
 *     missing blob and the two never match again.
 *   - tsChanged compares the server's stamp against the one this tab last
 *     wrote. saveProjectIndex() writes with fire-and-forget apiPut, so a PUT
 *     that never landed leaves the local stamp ahead of the server's for good.
 *
 * Either state means loadProjects() on every tick, forever. These tests run
 * the real _pollProjects extracted from each page against both, plus the
 * two-tab case where each tab's index rewrite retriggered the other.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const FILES = [
  ['tracker.html',         'fct_projects_index'],
  ['paving.html',          'fct_paving_projects_index'],
  ['kiewit-pinetree.html', 'fct_kiewit_projects_index'],
];

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

/** Slice out `async function name(...) { ... }` by brace matching. */
function extractFunction(src, name, prefix) {
  const start = src.indexOf(`${prefix}${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

/**
 * Build a live _pollProjects bound to a controllable fake world.
 *
 * `server` is the mutable blob the page would read back from
 * /api/data/<indexKey>; `world.loads` counts loadProjects() calls, which is
 * the number the incident was about.
 */
function makeHarness(src, indexKey, opts) {
  const o = opts || {};
  const sigFn  = extractFunction(src, '_indexSig',     'function ');
  const pollFn = extractFunction(src, '_pollProjects', 'async function ');

  const world = {
    loads: 0,
    server: o.server,
    projectIds: (o.projectIds || []).slice(),
    lastProjIndexTs: o.lastProjIndexTs || 0,
    editing: false,
    // Whether loadProjects()'s recovery pass rewrites the index this run.
    rewritesIndex: o.rewritesIndex || (() => false),
    // Ids loadProjects() ends up with, given the index it fetched. Default
    // models the missing-blob case: the caller supplies a fixed list.
    resolveIds: o.resolveIds || (index => index.slice()),
    now: 1_000_000,
  };

  const sandbox = {
    console,
    apiGet: async () => world.server,
    _isEditing: () => world.editing,
    activeTab: 'cost',
    renderHomeTab: () => {},
    renderProjectInfoComputed: () => {},
    get projectsList() { return world.projectIds.map(id => ({ id })); },
    get _lastProjIndexTs() { return world.lastProjIndexTs; },
    set _lastProjIndexTs(v) { world.lastProjIndexTs = v; },
    loadProjects: async () => {
      world.loads++;
      const index = Array.isArray(world.server) ? world.server : (world.server.ids || []);
      // Mirrors loadProjects(): adopt the stamp that came with the index...
      world.lastProjIndexTs = (world.server && world.server._ts) || 0;
      world.projectIds = world.resolveIds(index);
      // ...then saveProjectIndex() may overwrite it with a fresh one.
      if (world.rewritesIndex(world)) {
        world.lastProjIndexTs = ++world.now;
        world.server = { ids: world.projectIds.slice(), _ts: world.lastProjIndexTs };
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${sigFn}\nlet _lastIndexSig = null;\n${pollFn}`, sandbox);
  return { world, poll: () => vm.runInContext('_pollProjects()', sandbox) };
}

const TICKS = 12;

(async () => {
  for (const [file, indexKey] of FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    console.log(`\n${file}`);

    // ── 1. Nothing changed anywhere: the poll must stay silent. ──
    {
      const h = makeHarness(src, indexKey, {
        server: { ids: ['a', 'b', 'c'], _ts: 500 },
        projectIds: ['a', 'b', 'c'],
        lastProjIndexTs: 500,
      });
      for (let i = 0; i < TICKS; i++) await h.poll();
      assert('steady state does not reload', h.world.loads === 0,
        `${h.world.loads} loadProjects() calls over ${TICKS} ticks`);
    }

    // ── 2. A project blob is missing, so projectsList is permanently
    //       shorter than the index. This was the loop. ──
    {
      const h = makeHarness(src, indexKey, {
        server: { ids: ['a', 'b', 'c'], _ts: 500 },
        projectIds: ['a', 'b'],
        lastProjIndexTs: 500,
        resolveIds: () => ['a', 'b'],   // 'c' has no blob — dropped every time
      });
      for (let i = 0; i < TICKS; i++) await h.poll();
      assert('missing project blob settles instead of reloading forever',
        h.world.loads <= 1, `${h.world.loads} loadProjects() calls over ${TICKS} ticks`);
    }

    // ── 3. A saveProjectIndex() PUT never landed, so the local stamp runs
    //       ahead of the server's. Also the loop. ──
    {
      const h = makeHarness(src, indexKey, {
        server: { ids: ['a', 'b'], _ts: 500 },
        projectIds: ['a', 'b'],
        lastProjIndexTs: 9_999_999,     // local stamp from a lost PUT
      });
      for (let i = 0; i < TICKS; i++) await h.poll();
      assert('stale local index stamp settles instead of reloading forever',
        h.world.loads <= 1, `${h.world.loads} loadProjects() calls over ${TICKS} ticks`);
    }

    // ── 4. A genuine remote change still gets picked up — exactly once. ──
    {
      const h = makeHarness(src, indexKey, {
        server: { ids: ['a', 'b'], _ts: 500 },
        projectIds: ['a', 'b'],
        lastProjIndexTs: 500,
      });
      await h.poll();
      assert('no reload before the change', h.world.loads === 0);
      h.world.server = { ids: ['a', 'b', 'd'], _ts: 600 };   // another user added 'd'
      for (let i = 0; i < TICKS; i++) await h.poll();
      assert('a real index change reloads exactly once', h.world.loads === 1,
        `${h.world.loads} loadProjects() calls`);
      assert('the new project is picked up', h.world.projectIds.includes('d'));
    }

    // ── 5. Recovery rewrites the index: this tab must not read its own
    //       write back as a remote change. Two tabs doing that retriggered
    //       each other indefinitely. ──
    {
      let rewrites = 0;
      const h = makeHarness(src, indexKey, {
        server: { ids: ['a', 'b'], _ts: 500 },
        projectIds: ['a'],
        lastProjIndexTs: 400,
        // Recovery finds an unindexed project the first time only, exactly as
        // it would once the index has been repaired on the server.
        resolveIds: index => (rewrites === 0 ? index.concat('recovered') : index.slice()),
        rewritesIndex: () => (rewrites++ === 0),
      });
      for (let i = 0; i < TICKS; i++) await h.poll();
      assert('a self-written index rewrite does not retrigger the poll',
        h.world.loads <= 2, `${h.world.loads} loadProjects() calls over ${TICKS} ticks`);
      assert('the recovered project survives', h.world.projectIds.includes('recovered'));
    }

    // ── 6. An edit in progress defers the reload rather than swallowing it. ──
    {
      const h = makeHarness(src, indexKey, {
        server: { ids: ['a', 'b'], _ts: 500 },
        projectIds: ['a', 'b'],
        lastProjIndexTs: 500,
      });
      h.world.server = { ids: ['a', 'b', 'e'], _ts: 700 };
      h.world.editing = true;
      for (let i = 0; i < 3; i++) await h.poll();
      assert('no reload while the user is editing', h.world.loads === 0);
      h.world.editing = false;
      await h.poll();
      assert('the deferred change lands once editing stops', h.world.loads === 1,
        `${h.world.loads} loadProjects() calls`);
    }

    // ── 7. Structural guards the incident also needed. ──
    {
      assert('_pollAll refuses to overlap itself',
        /if \(_pollCycleBusy \|\| _fctPollsSuspended\(\)\) return;/.test(src));
      assert('polling stands down on a hidden tab',
        /document\.visibilityState === 'hidden'/.test(src));
      assert('polling stands down once the session is over',
        /function _fctSessionOver\(\)/.test(src));
      assert('logout is latched against concurrent 401s',
        /if \(_loggingOut\) return;/.test(src));
      assert('returning to the tab refreshes without waiting a full interval',
        /addEventListener\('visibilitychange'/.test(src));
      assert('the lists poll also stands down',
        /async function pollLists\(\) \{\s*\n\s*if \(_fctPollsSuspended\(\)\) return;/.test(src));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
