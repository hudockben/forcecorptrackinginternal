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

// Payroll: timesheet entries for last week and this week, on the office's
// calendar (the page reads its ranges in the schedule's zone).
const NY_TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const nyDay = n => { const d = new Date(NY_TODAY + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const NY_MON = nyDay(-((new Date(NY_TODAY + 'T12:00:00Z').getUTCDay() + 6) % 7));   // this week's Monday
const weekDay = (weekOffset, i) => { const d = new Date(NY_MON + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + weekOffset * 7 + i); return d.toISOString().slice(0, 10); };
const LAST_MON = weekDay(-1, 0), LAST_SUN = weekDay(-1, 6);
const entry = (id, username, work_date, hours, status, division, job_id, job_label) => ({
  id, username, entry_type: 'daily', work_date, status, division, job_id, job_label,
  computed_hours: hours, travel_hours: 0, travel_to_site_hours: 0, travel_to_shop_hours: 0,
  prevailing_wage: false, haul_type: null, haul_hours: 0, haul_off_site_hours: 0,
  supervisor_name: 'Pat', start_time: '07:00', end_time: '16:30', lunch_break: 0.5, operated_equipment: [],
});
let PAYROLL_ENTRIES = [];
for (let i = 0; i < 5; i++) PAYROLL_ENTRIES.push(entry('s' + i, 'sam', weekDay(-1, i), 9, 'approved', 'turf', 'j1', 'Maple Ave'));
for (let i = 0; i < 4; i++) PAYROLL_ENTRIES.push(entry('d' + i, 'dale', weekDay(-1, i), 8, 'submitted', 'paving', 'j2', 'Route 30'));
for (let i = 0; i < 3; i++) PAYROLL_ENTRIES.push(entry('t' + i, 'sam', weekDay(0, i), 10, 'submitted', 'turf', 'j1', 'Maple Ave'));
const ALL_PAYROLL = PAYROLL_ENTRIES.slice();

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
    if (p === '/api/timesheet-entries') {
      const from = u.searchParams.get('from') || '0000', to = u.searchParams.get('to') || '9999';
      const inRange = PAYROLL_ENTRIES.filter(e => e.work_date >= from && e.work_date <= to);
      if (u.searchParams.get('action') === 'pending_span') {
        return json(res, { total: 0, before: 0, after: 0, oldest: null, newest: null, oldestSince: null });
      }
      return json(res, { entries: inRange });
    }
    if (p === '/api/timesheet-supervisors') return json(res, { supervisors: [{ name: 'Pat' }] });
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
  divisionRoles: { turf: 'admin', paving: 'admin', kiewit: 'admin', dust: 'admin', quarry: 'admin', payroll: 'admin',
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

    console.log('\nPayroll — payroll.html');
    const LAST_WEEK_WORDS = (() => {
      const a = new Date(LAST_MON + 'T00:00:00'), b = new Date(LAST_SUN + 'T00:00:00');
      const md = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (a.getFullYear() !== b.getFullYear()) return `${md(a)}, ${a.getFullYear()} – ${md(b)}, ${b.getFullYear()}`;
      if (a.getMonth() === b.getMonth()) return `${md(a)}–${b.getDate()}, ${b.getFullYear()}`;
      return `${md(a)} – ${md(b)}, ${b.getFullYear()}`;
    })();
    const fig = (item, label) => ((item && item.summary || []).find(x => x.label === label) || {});
    r = await build(browser, baseUrl, 'payroll_hours', { options: { range: 'last_week' } });
    const ph = r.out && r.out.items[0];
    ok('Payroll Hours for last week builds, everybody on it',
      !r.error && r.out.items.length === 1 && has(ph, '>sam<') && has(ph, '>dale<') && !has(ph, 'Maple Ave'),
      r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped)));
    ok('…with the week in its subject', ph && ph.subject === `Payroll Hours Report — ${LAST_WEEK_WORDS}`, ph && ph.subject);
    ok('…and the key figures: 2 men, 5 h overtime, 32 h pending',
      fig(ph, 'Employees').value === '2' && fig(ph, 'Overtime').value === '5.00' && fig(ph, 'Overtime').tone === 'bad'
        && fig(ph, 'Pending').value === '32.00', JSON.stringify(ph && ph.summary));
    ok('…as Print makes it: the page\'s landscape @page, no buttons, no unopened detail',
      has(ph, 'size: landscape') && !has(ph, 'Export to Excel') && !has(ph, 'report-detail" data-user') && !/<button/.test(ph.html),
      ph && ph.html.length);
    ok('…one DataWatch mark, not two', ph && (ph.html.match(/data-dw-brand/g) || []).length === 1);
    ok('…and no arrow the server\'s font cannot draw', ph && !ph.html.includes('→'));
    ok('…and nothing written', r.writes.length === 0, r.writes.join(', '));

    r = await build(browser, baseUrl, 'payroll_hours', { options: { range: 'current_week' } });
    ok('this week so far is this week\'s hours only',
      !r.error && r.out.items.length === 1 && fig(r.out.items[0], 'Employees').value === '1' && fig(r.out.items[0], 'Hours Worked').value === '30.00',
      r.error || JSON.stringify(r.out.items[0] && r.out.items[0].summary));

    r = await build(browser, baseUrl, 'payroll_projects', { options: { range: 'last_week' } });
    const pp = r.out && r.out.items[0];
    ok('the Project Overtime Report builds, both jobs on it',
      !r.error && r.out.items.length === 1 && has(pp, 'Maple Ave') && has(pp, 'Route 30')
        && pp.subject === `Project Overtime Report — ${LAST_WEEK_WORDS}`,
      r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped || pp.subject)));
    ok('…with the PDF ticks Print defaults to: no summary cards, the board and the job tables in',
      pp && !has(pp, 'class="proj-stats') && has(pp, 'data-piece="crew"') && has(pp, 'data-piece="tables"'));
    const blocks = pp ? (pp.html.match(/class="proj-block(?: [^"]*)?"/g) || []) : [];
    ok('…every job opened and the whole crew shown',
      pp && !/class="[^"]*\bcc-collapsed\b/.test(pp.html) && /class="cc-board/.test(pp.html)
        && blocks.length === 2 && blocks.every(c => /\bopen\b/.test(c)),
      JSON.stringify({ blocks }));
    ok('…and its key figures', fig(pp, 'Jobs Worked').value === '2' && fig(pp, 'Men Past 40').value === '1', JSON.stringify(pp && pp.summary));

    r = await build(browser, baseUrl, 'payroll_overtime', {});
    const po = r.out && r.out.items[0];
    ok('Weekly Overtime builds for the week in progress',
      !r.error && r.out.items.length === 1 && /^Weekly Overtime — .* \(so far, as of /.test(po.subject) && has(po, '>sam<'),
      r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped || po.subject)));
    ok('…with where everybody stands', fig(po, 'Employees').value === '1' && fig(po, 'Hours Worked').value === '30.00', JSON.stringify(po && po.summary));

    PAYROLL_ENTRIES = [];
    r = await build(browser, baseUrl, 'payroll_hours', { options: { range: 'last_week' } });
    ok('a week with no time on it is skipped, not sent empty',
      !r.error && r.out.items.length === 0 && r.out.skipped.length === 1 && /No timesheet entries for/.test(r.out.skipped[0].why),
      r.error || JSON.stringify(r.out));
    r = await build(browser, baseUrl, 'payroll_overtime', {});
    ok('…and so is a week nobody has submitted to yet', !r.error && r.out.items.length === 0 && /No time has been submitted/.test((r.out.skipped[0] || {}).why),
      r.error || JSON.stringify(r.out));
    PAYROLL_ENTRIES = ALL_PAYROLL.slice();

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
    SENT.length = 0;
    res = await runSchedule(fakeSql, { ...sched, report_type: 'payroll_hours', division: 'payroll', project_id: null,
      options: { range: 'last_week' } }, { baseUrl, browser, now: new Date() });
    const ppdf = ((SENT[0] || {}).attachments || []).find(a => a.contentType === 'application/pdf');
    const pbuf = ppdf ? Buffer.from(ppdf.content, 'base64') : Buffer.alloc(0);
    ok('payroll end to end: the hours report goes out as a PDF',
      res.status === 'sent' && SENT.length === 1 && pbuf.subarray(0, 5).toString() === '%PDF-', JSON.stringify(res));
    ok('…landscape, the way the page prints it', /\/MediaBox\s*\[\s*0\s+0\s+792(\.\d+)?\s+612/.test(pbuf.toString('latin1')),
      (pbuf.toString('latin1').match(/\/MediaBox\s*\[[^\]]*\]/) || [])[0]);
    ok('…with the figures in the email body', /Total Paid/.test((SENT[0] || {}).html || ''));
    // For a person to look at: SHOT_DIR=/some/dir keeps the PDF that was sent.
    if (process.env.SHOT_DIR && pbuf.length) fs.writeFileSync(path.join(process.env.SHOT_DIR, 'payroll-hours.pdf'), pbuf);
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
