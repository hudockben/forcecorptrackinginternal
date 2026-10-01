#!/usr/bin/env node
'use strict';
/**
 * Scheduled reports, in a real browser: does each page build its report when
 * nobody is there to press the button?
 *
 * Run: node scripts/test-auto-report-browser.js
 *      (skips cleanly when there is no Chrome: set CHROME_EXECUTABLE_PATH, or
 *       have Playwright's Chromium at /opt/pw-browsers)
 *
 * Manage Users → Auto Reports sends a report by opening its division page in
 * headless Chrome, signed in as the admin who scheduled it, and asking the
 * page for the report through window.dwAutoReport — which presses the page's
 * own Email button with the modal swapped for a recorder. Every link in that
 * chain is somewhere a rename breaks it silently: a page that stops
 * registering, a builder that alerts instead of returning, a boot that never
 * says it is ready. A suite that lifts functions out of the page cannot see
 * any of that, so this drives the real runner (buildInBrowser) against the
 * real pages, over HTTP, with a fake API behind them.
 *
 * It also holds the robot to its one hard rule: it only reads. Every write a
 * page attempts while the runner has it open must be refused before it
 * reaches the server.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');

const CHROME = [
  process.env.CHROME_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.log('no Chrome/Chromium on this box — skipping browser checks'); process.exit(0); }
process.env.CHROME_EXECUTABLE_PATH = CHROME;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'auto-report-test-secret';
// api/lib/email.js reads these at load. The Resend SDK itself is stubbed
// below — nothing leaves the box.
process.env.RESEND_API_KEY     = process.env.RESEND_API_KEY     || 'test-key';
process.env.EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'reports@datawatch.test';
const SENT = [];
{
  const resendPath = require.resolve('resend');
  require.cache[resendPath] = {
    id: resendPath, filename: resendPath, loaded: true, exports: {
      Resend: class { constructor() { this.emails = { send: async o => { SENT.push(o); return { data: { id: 'stub-' + SENT.length }, error: null }; } }; } },
    },
  };
}

const { buildInBrowser, runSchedule } = require(path.join(ROOT, 'api/lib/report-schedule-runner.js'));
const { launchBrowser }  = require(path.join(ROOT, 'api/lib/pdf.js'));
const { SCHEDULABLE }    = require(path.join(ROOT, 'api/lib/report-catalog.js'));

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + String(d).slice(0, 400) : '')); }
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const today = new Date();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return ymd(d); };
const YESTERDAY = daysAgo(1);
const LONG_AGO  = daysAgo(200);   // outside the boot's 90-day window: only the backfill brings it

function jobDivisionData(prefix, name) {
  const keyPfx = prefix === 'turf' ? 'fct_' : `fct_${prefix}_`;
  const proj = (id, pname, status, job) => ({
    id, 'project-name': pname, 'job-number': job, status,
    'start-date': daysAgo(250), 'end-date': ymd(new Date(today.getTime() + 60 * 864e5)),
    'contract-amount': 250000,
    bidItems: [
      { id: id + '-b1', cost_code: '0100', sub_code: 'Excavation', unit: 'CY', quantity: 1000, unit_cost: 12, description: 'Excavation' },
      { id: id + '-b2', cost_code: '0200', sub_code: 'Stone Base', unit: 'TON', quantity: 400, unit_cost: 30, description: 'Stone' },
    ],
  });
  const projects = [
    proj('p1', `${name} Maple Ave`, 'In Progress', '26101'),
    proj('p2', `${name} Oak St`,    'In Progress', '26102'),
    proj('p3', `${name} Done Job`,  'Complete',    '25009'),
  ];
  const store = {
    [`${keyPfx}projects_index`]: projects.map(p => p.id),
    [`${keyPfx}lists`]: { employees: [{ name: 'Sam' }], equipment: [], cost_codes: [], job_classes: [] },
  };
  projects.forEach(p => { store[`${keyPfx}project_${p.id}`] = p; });
  const rows = [];
  let n = 1;
  for (const p of projects.slice(0, 2)) {
    rows.push({ id: String(n++), _projectId: p.id, date: YESTERDAY, cost_code: '0100', sub_code: 'Excavation',
      quantity: 120, labor_hours: 32, equip_hours: 8, material_cost: 0, employee: 'Sam', job_class: 'Operator' });
    rows.push({ id: String(n++), _projectId: p.id, date: LONG_AGO, cost_code: '0100', sub_code: 'Excavation',
      quantity: 77, labor_hours: 20, equip_hours: 4, material_cost: 0, employee: 'Sam', job_class: 'Operator' });
  }
  return { store, rows, projects };
}

const DIVS = {
  turf:   jobDivisionData('turf', 'Turf'),
  paving: jobDivisionData('paving', 'Paving'),
  kiewit: jobDivisionData('kiewit', 'Kiewit'),
};

// A construction schedule for one Kiewit job and one Turf job.
const conSchedule = title => ({
  header: { heading: 'Construction Schedule', projectTitle: title, pm: 'Pat', company: '', date: '' },
  workWeek: 5,
  rows: [
    { id: 'r1', kind: 'task', name: 'Mobilize', start: daysAgo(10), end: daysAgo(5), duration: 5, pct: 100 },
    { id: 'r2', kind: 'task', name: 'Grade',    start: daysAgo(4),  end: daysAgo(-10), duration: 10, pct: 30 },
  ],
});
DIVS.turf.store['fct_conschedule_p1']          = conSchedule('Turf Maple Ave');
DIVS.kiewit.store['fct_kiewit_conschedule_p1'] = conSchedule('Kiewit Maple Ave');

const DUST_ROWS = [
  { id: 'd1', date: YESTERDAY, company: 'Acme Paving', location: 'Pit 2', start_time: '07:00', end_time: '15:00',
    vehicle1: 'T-1', gallons: 1200 },
  { id: 'd2', date: daysAgo(40), company: 'Old Co', location: 'Pit 9', start_time: '07:00', end_time: '09:00',
    vehicle1: 'T-2', gallons: 300 },
];

const STORE = Object.assign({}, DIVS.turf.store, DIVS.paving.store, DIVS.kiewit.store, {
  fct_trucking_schedule: { assignments: { [YESTERDAY]: [
    { id: 'a1', driver: 'Dale', customer: 'Acme Paving', unit: 'T-14', start: '06:30', notes: 'Stone to Maple Ave' },
  ] } },
  fct_trucking_labor_schedule: { assignments: {} },
});

// ── A fake API over the real pages ──────────────────────────────────────────
const writes = [];   // every non-read request that reached the server
function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function divisionOf(u) { return u.searchParams.get('division') || 'turf'; }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (p.startsWith('/api/')) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && p !== '/api/ai/schedule-analysis') {
      writes.push(req.method + ' ' + p);
      return json(res, { ok: true });
    }
    if (!/^Bearer .+\..+\..+/.test(String(req.headers.authorization || ''))) return json(res, { error: 'Unauthorized' }, 401);
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',').filter(Boolean);
      return json(res, { values: Object.fromEntries(keys.filter(k => k in STORE).map(k => [k, STORE[k]])) });
    }
    if (p === '/api/data/_keys') return json(res, { keys: [] });
    if (p.startsWith('/api/data/')) {
      const key = p.slice('/api/data/'.length);
      return json(res, { value: key in STORE ? STORE[key] : null });
    }
    if (p === '/api/daily-rows') {
      const d = DIVS[divisionOf(u)];
      const since = u.searchParams.get('since');
      const rows = (d ? d.rows : []).filter(r => !since || r.date >= since);
      return json(res, { rows, hasMore: false });
    }
    if (p === '/api/purchase-orders') return json(res, { purchaseOrders: [] });
    if (p === '/api/trucking')        return json(res, { truckingEntries: [] });
    if (p === '/api/deadlines')       return json(res, { deadlines: [] });
    if (p === '/api/ai/schedule-analysis') {
      return json(res, { summary: 'Excavation is pacing ahead of plan.', recommendations: [], outlook: 'on-track' });
    }
    if (p === '/api/dust-rows')   return json(res, { dustRows: DUST_ROWS });
    if (p === '/api/dust-config') return json(res, { settings: { ub_rate: 0 }, lists: { companies: [] } });
    if (p === '/api/executive/report') {
      return json(res, { ok: true, generatedAt: new Date().toISOString(), portfolios: [],
        safety: { key: 'safety', name: 'Safety Sign-Off', accent: '#f59e0b', weekOf: YESTERDAY, documents: [] } });
    }
    return json(res, {});
  }
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(f));
});

const ACCT = {
  userId: 7, username: 'robot-admin', companyCode: 'FCT', companyName: 'Force Corp',
  role: 'admin', isPlatformAdmin: true, allowedDivisions: [],
  divisionRoles: { turf: 'admin', paving: 'admin', kiewit: 'admin', dust: 'admin', quarry: 'admin',
    trucking: 'admin', scheduler: 'admin', executive: 'admin' },
};

async function build(browser, baseUrl, type, extra = {}) {
  const def = SCHEDULABLE[type];
  const spec = Object.assign({ type, projectId: null, options: {}, timezone: 'America/New_York', today: ymd(today) }, extra);
  writes.length = 0;
  try {
    const out = await buildInBrowser(browser, { baseUrl, def, acct: ACCT, spec });
    return { out, writes: writes.slice() };
  } catch (err) {
    return { error: err.message, writes: writes.slice() };
  }
}

const has = (item, s) => Boolean(item && typeof item.html === 'string' && item.html.includes(s));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser();
  try {
    for (const [div, label] of (process.env.ONLY_OTHERS ? [] : [['turf', 'Turf'], ['paving', 'Paving'], ['kiewit', 'Kiewit']])) {
      console.log(`\n${label} — ${SCHEDULABLE[div + '_daily_pm'].page}`);

      let r = await build(browser, baseUrl, `${div}_daily_pm`, { projectId: '*' });
      ok('Daily PM builds for every In Progress job and only those', !r.error && r.out.items.length === 2,
        r.error || JSON.stringify(r.out.items.map(i => i.projectName)) + ' ' + JSON.stringify(r.out.errors));
      const pm = r.out && r.out.items[0];
      ok('…as the button would: subject, job and the plan itself',
        pm && /^Daily PM Report — .*Maple Ave/.test(pm.subject) && pm.projectId === 'p1' && has(pm, 'Daily Field Plan'),
        pm && pm.subject);
      ok('…with a job that has production logged (the pace line used to throw)', has(pm, '/day avg'));
      ok('…with the AI read of the job', has(pm, 'Excavation is pacing ahead of plan.'));
      ok('…stamped with the DataWatch header', has(pm, 'data-dw-brand'));
      ok('…and no print bootstrap left in it', pm && !/window\.print/.test(pm.html));
      ok('the robot never wrote anything', r.writes.length === 0, r.writes.join(', '));

      r = await build(browser, baseUrl, `${div}_daily_pm`, { projectId: 'p3', projectName: `${label} Done Job` });
      ok('a job named outright is built even when it is not In Progress',
        !r.error && r.out.items.length === 1 && r.out.items[0].projectId === 'p3', r.error || JSON.stringify(r.out.errors));

      r = await build(browser, baseUrl, `${div}_daily_pm`, { projectId: 'gone', projectName: 'Deleted Job' });
      ok('a job that no longer exists is an error, not a silent skip',
        !r.error && r.out.items.length === 0 && r.out.errors.length === 1 && /Deleted Job/.test(r.out.errors[0].error),
        r.error || JSON.stringify(r.out));

      r = await build(browser, baseUrl, `${div}_daily_summary`, { projectId: null, start: YESTERDAY, end: YESTERDAY });
      const ds = r.out && r.out.items[0];
      ok('Daily Summary for every job, one report', !r.error && r.out.items.length === 1 && has(ds, 'Maple Ave') && has(ds, 'Oak St'),
        r.error || JSON.stringify(r.out && (r.out.skipped || r.out.errors)));
      ok('…with key figures for the email body', ds && Array.isArray(ds.summary) && ds.summary.length >= 2,
        ds && JSON.stringify(ds.summary));

      r = await build(browser, baseUrl, `${div}_daily_summary`, { projectId: null, start: daysAgo(3), end: daysAgo(2) });
      ok('a period with no entries is skipped with the page\'s own reason',
        !r.error && r.out.items.length === 0 && r.out.skipped.length === 1 && /No production data/i.test(r.out.skipped[0].why),
        r.error || JSON.stringify(r.out));

      r = await build(browser, baseUrl, `${div}_daily_summary`, { projectId: null, start: daysAgo(250), end: YESTERDAY });
      ok('rows older than 90 days are in it (the backfill was waited for)',
        !r.error && r.out.items.length === 1 && /197/.test(r.out.items[0].html),
        r.error || 'quantity 120+77 not found');

      r = await build(browser, baseUrl, `${div}_bid_items`, { projectId: 'p1' });
      const bid = r.out && r.out.items[0];
      ok('Bid Line Items vs Actuals builds for the job, every cost code',
        !r.error && r.out.items.length === 1 && /^Bid Line Items vs Actuals — .*Maple Ave \(26101\)$/.test(bid.subject)
          && has(bid, '0100') && has(bid, '0200'),
        r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped)));

      r = await build(browser, baseUrl, `${div}_job_summary`, { projectId: 'p2' });
      const js = r.out && r.out.items[0];
      ok('Job Summary builds for the job', !r.error && r.out.items.length === 1 && /^Job Summary — .*Oak St/.test(js.subject),
        r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped)));

      if (SCHEDULABLE[`${div}_construction_schedule`]) {
        r = await build(browser, baseUrl, `${div}_construction_schedule`, { projectId: '*' });
        ok('Construction Schedule: the job with one is built, the job without one is skipped',
          !r.error && r.out.items.length === 1 && r.out.skipped.length === 1 && r.out.items[0].projectId === 'p1',
          r.error || JSON.stringify({ items: r.out.items.map(i => i.subject), skipped: r.out.skipped, errors: r.out.errors }));
        const cs = r.out && r.out.items[0];
        ok('…with its Gantt attached as an inline image',
          cs && cs.attachments.length === 1 && cs.attachments[0].contentId === 'cs-gantt' && has(cs, 'cid:cs-gantt'),
          cs && JSON.stringify(cs.attachments.map(a => a.filename)));
        ok('…and nothing written', r.writes.length === 0, r.writes.join(', '));
      }
    }

    console.log('\nDust Control — dust.html');
    let r = await build(browser, baseUrl, 'dust_tracking_summary', { start: daysAgo(7), end: YESTERDAY });
    const dust = r.out && r.out.items[0];
    ok('the tracking report builds for the period, all customers',
      !r.error && r.out.items.length === 1 && has(dust, 'Acme Paving') && !has(dust, 'Old Co'),
      r.error || JSON.stringify(r.out));
    ok('…and its subject says which period', dust && dust.subject === `Dust Control Tracking Report — All Customers — ${daysAgo(7)} to ${YESTERDAY}`,
      dust && dust.subject);
    ok('…and the unload flush never reached the server', r.writes.length === 0, r.writes.join(', '));
    r = await build(browser, baseUrl, 'dust_tracking_summary', { start: daysAgo(3), end: daysAgo(2) });
    ok('an empty period is skipped, not sent', !r.error && r.out.items.length === 0 && r.out.skipped.length === 1,
      r.error || JSON.stringify(r.out));

    console.log('\nQuarry — quarry.html');
    r = await build(browser, baseUrl, 'quarry_breakeven', { year: String(today.getFullYear()) });
    ok('with no quarry data the break-even is skipped with the page\'s reason',
      !r.error && r.out.items.length === 0 && r.out.skipped.length === 1 && /No quarry data/i.test(r.out.skipped[0].why),
      r.error || JSON.stringify(r.out));
    STORE.fct_quarry_sales = [{ id: 's1', date: YESTERDAY, location: 'Pit 2', product: '2A Modified', tons: 400, price: 14, total: 5600 }];
    r = await build(browser, baseUrl, 'quarry_breakeven', { year: String(today.getFullYear()) });
    ok('with a sale on the books it builds', !r.error && r.out.items.length === 1 && /^Quarry Break-Even — /.test(r.out.items[0].subject),
      r.error || JSON.stringify(r.out));
    delete STORE.fct_quarry_sales;

    console.log('\nExecutive — executive.html');
    r = await build(browser, baseUrl, 'executive');
    ok('the executive report builds, every section', !r.error && r.out.items.length === 1 && /^Executive Report/.test(r.out.items[0].subject),
      r.error || JSON.stringify(r.out));

    console.log('\nScheduler — scheduler.html');
    r = await build(browser, baseUrl, 'scheduler_dispatch', { day: YESTERDAY });
    ok('the crew dispatch for a day with nothing on it is skipped',
      !r.error && r.out.items.length === 0 && r.out.skipped.length === 1 && /Nothing scheduled/.test(r.out.skipped[0].why),
      r.error || JSON.stringify(r.out));

    console.log('\nTrucking — trucking.html');
    r = await build(browser, baseUrl, 'trucking_dispatch', { day: YESTERDAY });
    const td = r.out && r.out.items[0];
    ok('the trucking dispatch builds for the day asked for', !r.error && r.out.items.length === 1 && has(td, 'Dale') && /^Trucking Dispatch — /.test(td.subject),
      r.error || JSON.stringify(r.out));
    r = await build(browser, baseUrl, 'trucking_labor_dispatch', { day: YESTERDAY });
    ok('the labor board, empty that day, is skipped', !r.error && r.out.items.length === 0 && r.out.skipped.length === 1,
      r.error || JSON.stringify(r.out));
    ok('…and nothing written', r.writes.length === 0, r.writes.join(', '));

    console.log('\nEnd to end — runSchedule, to the mail service');
    // The database the runner reads, as three answers: the account it runs
    // as, that account's access, and the recipient group.
    const fakeSql = (strings) => {
      const q = strings.join('?');
      if (/FROM users u\s+JOIN companies c ON c\.code = u\.company_code\s+WHERE u\.id/.test(q) && /AS company_name/.test(q)) {
        return Promise.resolve([{ id: 7, username: 'robot-admin', company_code: 'FCT', company_name: 'Force Corp' }]);
      }
      if (/u\.division_roles/.test(q)) {
        return Promise.resolve([{ division_roles: ACCT.divisionRoles, divisions: null, role: 'admin', is_platform_admin: false,
          company_code: 'FCT', allowed_divisions: ['turf'] }]);
      }
      if (/FROM report_recipient_groups/.test(q)) {
        return Promise.resolve([{ id: 1, name: 'Turf PMs', emails: ['PM@example.com', 'super@example.com'] }]);
      }
      return Promise.reject(new Error('unexpected query: ' + q.slice(0, 80)));
    };
    const sched = {
      id: 99, company_code: 'FCT', report_type: 'turf_daily_pm', division: 'turf', project_id: '*', project_name: null,
      options: {}, frequency: 'weekdays', send_time: '06:30', timezone: 'America/New_York', group_ids: [1],
      subject: null, note: 'Numbers through yesterday.', attach_pdf: true, enabled: true,
      run_as_user_id: 7, run_as_username: 'robot-admin',
    };
    SENT.length = 0;
    writes.length = 0;
    let res = await runSchedule(fakeSql, sched, { baseUrl, browser, now: new Date() });
    ok('every In Progress job goes out as its own email', res.status === 'sent' && res.sent === 2 && SENT.length === 2,
      JSON.stringify(res));
    const first = SENT[0] || {};
    ok('…to the group, folded to lower case', JSON.stringify(first.to) === '["pm@example.com","super@example.com"]', JSON.stringify(first.to));
    ok('…with the button\'s subject', /^Daily PM Report — Turf Maple Ave/.test(first.subject || ''), first.subject);
    const pdf = (first.attachments || []).find(a => a.contentType === 'application/pdf');
    ok('…the report attached as a real PDF', pdf && Buffer.from(pdf.content, 'base64').subarray(0, 5).toString() === '%PDF-',
      JSON.stringify((first.attachments || []).map(a => a.filename)));
    ok('…and the note in the body', String(first.html || '').includes('Numbers through yesterday.'));
    ok('…and the result says so in words', res.message === 'Sent 2 reports to 2 recipients.', res.message);
    ok('…and nothing was written while building it', writes.length === 0, writes.join(', '));

    SENT.length = 0;
    res = await runSchedule(fakeSql, { ...sched, report_type: 'trucking_labor_dispatch', division: 'trucking', project_id: null,
      options: { day: 'today' } }, { baseUrl, browser, now: new Date() });
    ok('a dispatch with nothing on the board is skipped, and nothing is sent',
      res.status === 'skipped' && SENT.length === 0 && /Nothing to send — Nothing scheduled/.test(res.message), JSON.stringify(res));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
