#!/usr/bin/env node
'use strict';
/**
 * The Home tab fills in as soon as its own reads are in, and again when the
 * older daily rows land — on Turf, Paving and Kiewit, in a real browser.
 *
 * Run: node scripts/test-home-boot-draw-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *
 * Opening a division drew Home from this browser's copy of the jobs, which
 * holds no daily rows, so every job read $0 spent. The real figures waited for
 * every read the boot makes — the CRM, purchase orders, trucking, and
 * loadProjects' recovery passes, which read every daily row again — and the
 * daily rows older than 90 days, fetched in the background after that, were
 * never drawn at all: the backfill called a renderCurrentTab() the pages never
 * had. A job finished more than 90 days ago read $0 actual cost until the tab
 * was left and opened again.
 *
 * Every read Home does not draw from is held open here, so the boot cannot
 * finish, and the background read of the older rows is held on its own:
 *
 *   - Home shows the jobs' recent spend while the rest of the boot is still out,
 *     and where the page reads Construction Schedules at boot its first figures
 *     already count the bid lines a schedule has closed out (projected profit);
 *   - the older rows, once they land, are drawn with no tab click;
 *   - not while the caret is in a box on the page — what is being typed is
 *     left alone — but as soon as it is left;
 *   - a job a recovery pass brings back after the schedules were read has its
 *     own read, and no schedule is read twice;
 *   - the report robot's boot still settles with every schedule read.
 *
 * Harness traps (see test-haul-browser.js): served over HTTP, not file://, and
 * fct_division must match the page or it bounces to divisions.html.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright not installed — skipping browser checks'); process.exit(0); }
const path = require('path');
const http = require('http');
const fs   = require('fs');
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});
const BASE = new Promise(r => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port)));

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + d : '')); }
};

const TOKEN = 'x.y.z';
// `own`: the keys Home draws from, answered at once. `cs`: the key prefix of
// the Construction Schedules the page reads at boot (Paving reads none). `fig`:
// the Home figures checked — a stage tile's data-sb on Turf and Paving, a
// metric-strip label on Kiewit — each with the values it should read:
//   recent — the In Progress job's spend, from the last 90 days of rows;
//   profit — projected profit, with the job's one bid line closed out on its
//            schedule ($200,000 spent is its cost; open, it would project
//            $1,000,000);
//   older  — a figure the finished job's rows from 2025 move: before they
//            land, and after.
const PAGES = [
  { file: 'tracker.html', division: 'turf', prefix: 'fct_', cs: 'fct_conschedule_',
    own: ['fct_projects_index', 'fct_cost_rows', 'fct_inventory'],
    fig: { recent: ['ip|*|actual', '$200,000'], profit: ['ip|*|profit', '$1,950,000'],
           older: ['done|*|actual', '$0', '$400,000'] } },
  { file: 'paving.html', division: 'paving', prefix: 'fct_paving_', cs: null,
    own: ['fct_paving_projects_index', 'fct_paving_cost_rows'],
    fig: { recent: ['ip|*|actual', '$200,000'],
           older: ['done|*|actual', '$0', '$400,000'] } },
  // Kiewit keeps one metric strip: spend on the jobs in progress, projected
  // profit over the book (Mt Lebanon adds $146,600 at its bid margin), and GP
  // earned to date across every job with spend, which the finished job joins
  // once its rows are in ($1,100,000 − $400,000).
  { file: 'kiewit-pinetree.html', division: 'kiewit', prefix: 'fct_kiewit_', cs: 'fct_kiewit_conschedule_',
    own: ['fct_kiewit_projects_index', 'fct_kiewit_cost_rows'],
    fig: { recent: ['Total Actual Spend', '$200,000'], profit: ['Total Projected Profit', '$2,096,600'],
           older: ['Total GP Earned to Date', '$1,950,000', '$2,650,000'] } },
];

// ── The book ────────────────────────────────────────────────────────────────
// Ten square yards bid, two put in.
const job = (id, name, status, contract, unitCost, o = {}) => ({
  id, 'project-name': name, status, 'contract-value': String(contract),
  'start-date': o.start || '', 'end-date': o.end || '',
  bidItems: [{ id: 'b1', cost_code: '100', sub_code: 'Turf', quantity: 10, unit_cost: unitCost, unit: 'SY', change_orders: [] }],
});
const PROJECTS = [
  job('ip1', 'Franklin Regional', 'In Progress', 2150000, 150000),
  job('aw1', 'Mt Lebanon', 'Awarded', 596600, 45000, { start: '2027-03-15' }),
  job('c1', 'Peters Twp Field', 'Complete', 1100000, 85000, { end: '2025-08-01' }),
];
// A job missing from the index that the old single job list still holds: the
// recovery pass brings it back after the Home tab's first draw.
const RECOVERED = job('rec1', 'Recovered Field', 'Awarded', 300000, 20000, { start: '2027-05-01' });
const ymd = d => d.toISOString().slice(0, 10);
const ROWS = [
  // Last week: one of the recent rows Home is first drawn from.
  { id: 'r1', _projectId: 'ip1', date: ymd(new Date(Date.now() - 7 * 864e5)), total_cost: '200000' },
  // Well over 90 days ago: only the background read of the older rows has it.
  { id: 'r2', _projectId: 'c1', date: '2025-05-03', total_cost: '400000' },
].map(r => ({ ...r, cost_code: '100', sub_code: 'Turf', quantity: '2', labor_hours: '8', rate: '30' }));
// ip1's schedule has closed out its one bid line.
const SCHEDULE = { rows: [{ id: 't1', kind: 'task', code: '100', subcode: 'Turf', status: 'Complete', pct: 100 }] };

const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

/**
 * Opens a division page with the Home tab's own reads answered at once and
 * everything else held at `rest` until it is opened. The first read of the
 * whole daily-row history — the background one, which goes out two seconds
 * after the recent rows, while the recovery passes are still held at `rest` —
 * is held on its own at `older`.
 */
async function boot(browser, cfg, opts = {}) {
  const rest = gate(), older = gate(), olderAsked = gate();
  const ctx  = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [], reads = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.addInitScript(({ t, division, cacheKey, cached, fig }) => {
    localStorage.setItem('fct_token', t);
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'hudockben', role: 'admin',
      companyCode: 'FCT', isPlatformAdmin: true, allowedDivisions: ['turf', 'paving', 'kiewit'] }));
    localStorage.setItem('fct_division', division);
    // This browser's copy of the job list, as a returning user has one: the
    // job records with no daily rows in them.
    if (cached) localStorage.setItem(cacheKey, JSON.stringify(cached));
    // A Home figure by its stage tile (data-sb) or its metric-strip label.
    window.__fig = key => {
      const item = key.includes('|')
        ? document.querySelector(`#home-content [data-sb="${key}"]`)
        : [...document.querySelectorAll('#home-content .home-metric-item')]
            .find(x => (x.querySelector('.home-metric-label') || {}).textContent === key);
      const v = item && item.querySelector('.home-metric-value');
      return v ? v.textContent.trim() : null;
    };
    // Every value the recent-spend and profit figures take, in order.
    window.__draws = [];
    new MutationObserver(() => {
      const recent = window.__fig(fig.recent[0]);
      if (recent === null) return;
      const v = { recent, profit: fig.profit ? window.__fig(fig.profit[0]) : '' };
      const last = window.__draws[window.__draws.length - 1];
      if (!last || last.recent !== v.recent || last.profit !== v.profit) window.__draws.push(v);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, { t: TOKEN, division: cfg.division, cacheKey: cfg.prefix + 'projects@FCT/hudockben',
       cached: opts.robot ? null : PROJECTS, fig: cfg.fig });
  let fullReads = 0;
  await page.route('**/api/**', async route => {
    const req = route.request();
    const u   = new URL(req.url());
    const p   = u.pathname;
    const m   = req.method();
    const key = p.startsWith('/api/data/') ? decodeURIComponent(p.slice('/api/data/'.length)) : '';
    const keys = key === '_batch' ? (u.searchParams.get('keys') || '').split(',') : [];
    reads.push({ m, p, key, keys });
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) }).catch(() => {});
    if (m !== 'GET') return json({ ok: true });
    if (p === '/api/daily-rows') {
      const since = u.searchParams.get('since') || '';
      if (!since && !opts.robot && ++fullReads === 1) { olderAsked.open(); await older.p; }
      return json({ rows: ROWS.filter(r => !since || r.date >= since).map(r => ({ ...r })), hasMore: false });
    }
    if (key === '_batch') {
      const values = {};
      for (const pr of [...PROJECTS, RECOVERED]) if (keys.includes(cfg.prefix + 'project_' + pr.id)) values[cfg.prefix + 'project_' + pr.id] = pr;
      if (cfg.cs && keys.includes(cfg.cs + 'ip1')) values[cfg.cs + 'ip1'] = SCHEDULE;
      return json({ values });
    }
    if (key === cfg.prefix + 'projects_index') return json({ value: PROJECTS.map(pr => pr.id) });
    if (cfg.own.includes(key) || (cfg.cs && key.startsWith(cfg.cs))) return json({ value: null });
    // Everything else the boot reads waits: the boot cannot finish before it.
    if (!opts.robot) await rest.p;
    if (key === cfg.prefix + 'projects') return json({ value: opts.recovered ? [RECOVERED] : null });
    if (p.startsWith('/api/data/')) return json({ value: null });
    return json({});
  });
  await page.goto((await BASE) + '/' + cfg.file + (opts.robot ? '?autoreport=1' : ''));
  await page.evaluate(() => { window.__bootSettled = false; _bootReady.then(() => { window.__bootSettled = true; }, () => {}); });
  const fig = key => page.evaluate(k => window.__fig(k), key);
  const waitFig = (key, want, timeout = 8000) => page.waitForFunction(([k, w]) => window.__fig(k) === w,
    [key, want], { timeout }).then(() => true, () => false);
  const schedulesRead = () => {
    const batched = reads.filter(r => r.key === '_batch').flatMap(r => r.keys).filter(k => k.startsWith(cfg.cs));
    const single  = reads.filter(r => r.key.startsWith(cfg.cs)).map(r => r.key);
    return { batched, single };
  };
  return { ctx, page, errors, reads, rest, older, olderAsked, fig, waitFig, schedulesRead };
}

async function run(browser, cfg) {
  console.log(`\n${cfg.file}`);
  const [recentKey, recentWant] = cfg.fig.recent;
  const [olderKey, olderBefore, olderAfter] = cfg.fig.older;

  // ── Home's own reads in, the rest of the boot still out ──
  {
    const b = await boot(browser, cfg);
    const early = await b.waitFig(recentKey, recentWant);
    ok("Home shows the jobs' recent spend while the rest of the boot is still out", early,
      `${recentKey} reads ${await b.fig(recentKey)}`);
    ok('  (the boot itself has not finished)', !(await b.page.evaluate(() => window.__bootSettled)));
    ok('  and no tab was opened to get it there', await b.page.evaluate(() => activeTab === 'home'));
    if (cfg.fig.profit) {
      const draws = await b.page.evaluate(() => window.__draws);
      const first = draws.find(d => d.recent === recentWant);
      ok("  its first figures already count the bid lines a job's schedule closed out",
        first && first.profit === cfg.fig.profit[1], JSON.stringify(draws));
    }
    ok('  the finished job has no older rows yet', (await b.fig(olderKey)) === olderBefore, await b.fig(olderKey));

    // The older rows are asked for in the background; hold them while the
    // rest of the boot finishes, so the boot's own last draw comes first.
    await b.olderAsked.p;
    b.rest.open();
    await b.page.evaluate(() => _bootReady);
    ok('  the rest of the boot then finishes', await b.page.evaluate(() => window.__bootSettled));
    ok('  with the finished job still on the last 90 days', (await b.fig(olderKey)) === olderBefore, await b.fig(olderKey));

    b.older.open();
    const drawn = await b.waitFig(olderKey, olderAfter);
    ok('the older rows, once in, are drawn with no tab click', drawn, `${olderKey} reads ${await b.fig(olderKey)}`);
    ok('  still on the Home tab', await b.page.evaluate(() => activeTab === 'home'));
    if (cfg.cs) {
      const { batched, single } = b.schedulesRead();
      ok('  every schedule read once, in one request', batched.length === 3 && new Set(batched).size === 3 && !single.length,
        `batch: ${batched.join(', ')} · single: ${single.join(', ')}`);
    }
    ok('  no page errors', !b.errors.length, b.errors.join(' | '));
    await b.ctx.close();
  }

  // ── The caret in a box: the redraw waits for it to leave ──
  {
    const b = await boot(browser, cfg);
    await b.waitFig(recentKey, recentWant);
    await b.olderAsked.p;
    b.rest.open();
    await b.page.evaluate(() => _bootReady);
    await b.page.click('#dl-input');
    await b.page.keyboard.type('Pour footings');
    b.older.open();
    await b.page.evaluate(() => _drBackfillDone);
    await b.page.waitForTimeout(1500);
    ok('with the caret in a box, the older rows wait to be drawn', (await b.fig(olderKey)) === olderBefore,
      `${olderKey} reads ${await b.fig(olderKey)}`);
    ok('  and what is being typed is left alone',
      await b.page.evaluate(() => document.activeElement && document.activeElement.id === 'dl-input'
        && document.activeElement.value === 'Pour footings'));
    await b.page.evaluate(() => document.activeElement.blur());
    ok('  drawn once the box is left', await b.waitFig(olderKey, olderAfter, 4000), `${olderKey} reads ${await b.fig(olderKey)}`);
    ok('  no page errors', !b.errors.length, b.errors.join(' | '));
    await b.ctx.close();
  }

  if (!cfg.cs) return;

  // ── A job a recovery pass brings back ──
  {
    const b = await boot(browser, cfg, { recovered: true });
    await b.waitFig(recentKey, recentWant);
    await b.olderAsked.p;
    b.rest.open();
    await b.page.evaluate(() => _bootReady);
    const r = await b.page.evaluate(() => ({
      back: projectsList.some(p => p.id === 'rec1'),
      read: _bidCsComplete.rec1 instanceof Set,
    }));
    ok('a job a recovery pass brings back after the schedules were read has its own read', r.back && r.read, JSON.stringify(r));
    const { batched, single } = b.schedulesRead();
    ok('  and the others are not read again', batched.length === 3 && !batched.includes(cfg.cs + 'rec1')
      && single.length === 1 && single[0] === cfg.cs + 'rec1', `batch: ${batched.join(', ')} · single: ${single.join(', ')}`);
    b.older.open();
    ok('  no page errors', !b.errors.length, b.errors.join(' | '));
    await b.ctx.close();
  }

  // ── The report robot ──
  {
    const b = await boot(browser, cfg, { robot: true });
    const settled = await b.page.evaluate(() => _bootReady.then(() => true, e => 'rejected: ' + e.message));
    ok("the report robot's boot still settles", settled === true, settled);
    ok('  with every job\'s schedule read', await b.page.evaluate(() =>
      ['ip1', 'aw1', 'c1'].every(id => _bidCsComplete[id] instanceof Set) && _bidCsComplete.ip1.size === 1));
    ok('  and the Home tab not drawn', await b.page.evaluate(() => !document.querySelector('#home-content .home-metric-item')));
    ok('  no page errors', !b.errors.length, b.errors.join(' | '));
    await b.ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME } : {});
  try {
    for (const cfg of PAGES) await run(browser, cfg);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
