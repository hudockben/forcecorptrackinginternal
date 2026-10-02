#!/usr/bin/env node
'use strict';
/**
 * Reports ▸ Overtime: where each person stands against 40, week by week, over
 * the From and To dates.
 *
 * Run: node scripts/test-payroll-overtime-week.js
 *
 * The simplest report on the page, and the one a supervisor opens mid-week:
 * hours worked (approved + pending), hours left before overtime, and hours
 * already past it. Anything over 40 in the Monday–Sunday week is overtime.
 *
 * Four promises it makes, and this file holds it to each:
 *
 *   · IT READS THE DATES, IN WHOLE WEEKS. The From and To boxes and the
 *     quick-range buttons choose the weeks, as they do for Employees and
 *     Projects — but dates that cut into a week are widened to the whole
 *     Monday–Sunday week, because the 40 is counted on the whole week. With no
 *     dates at all it is the week in progress.
 *   · A ROW IS ONE PERSON IN ONE WEEK. Two weeks are two bands of rows, never
 *     one total per person; the tiles and the totals count each person once.
 *   · PENDING TIME COUNTS. A day waiting on a signature was still worked, so it
 *     is in Hours Worked — and shown on its own too, because it can move.
 *   · THE HOURS ARE THE WHOLE WEEK. Division, Supervisor and Employee choose who
 *     is LISTED, never which hours count: a Paving filter must not hide the
 *     twelve hours someone put in at Turf, or "hours left" lies. That is also
 *     why its fetch carries no division.
 *
 * It boots the real page in jsdom, with a stub server behind fetch, and drives
 * it through the buttons a person would click.
 */

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require(path.join(ROOT, 'node_modules/jsdom'))); }
catch { console.log('jsdom not installed — skipping weekly overtime checks'); process.exit(0); }

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const near   = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

const PAGE = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');

// ── The weeks, in the page's own terms ───────────────────────────────────────
// Monday of the week in progress, local time — thisWeekMonday()'s arithmetic.
// Checked against the page's own answer once it has booted, so a disagreement
// fails loudly here rather than as a dozen confusing row mismatches later.
const MONDAY = (() => {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  return t;
})();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = n => { const d = new Date(MONDAY); d.setDate(MONDAY.getDate() + n); return ymd(d); };
const MON = day(0), SUN = day(6), LAST_MON = day(-7), LAST_SUN = day(-1);

const E = (id, username, dayN, hours, over = {}) => Object.assign({
  id, username, entry_type: 'daily', status: 'approved', division: 'paving',
  work_date: day(dayN), computed_hours: hours, travel_hours: 0,
  supervisor_name: 'Smith', job_label: 'Ridge Road', prevailing_wage: false,
  created_at: `${day(dayN)}T12:00:00Z`,
}, over);

// The week in progress.
const WEEK = [
  // AVA — forty approved Monday to Thursday, then a pending Friday: six hours
  // of overtime, every one of them on time nobody has signed yet.
  E(1, 'ava', 0, 10), E(2, 'ava', 1, 10), E(3, 'ava', 2, 10), E(4, 'ava', 3, 10),
  E(5, 'ava', 4, 6, { status: 'submitted' }),
  // BEN — thirty on Paving under Smith, then twelve pending at Turf under
  // Jones. Listed under a Paving filter he is still 42: Turf is his week too.
  E(6, 'ben', 0, 10), E(7, 'ben', 1, 10), E(8, 'ben', 2, 10),
  E(9, 'ben', 4, 12, { status: 'submitted', division: 'turf', supervisor_name: 'Jones' }),
  // DEE — exactly forty. Nothing left and nothing over: the next hour is OT.
  E(10, 'dee', 0, 10, { division: 'dust', supervisor_name: 'Lee' }),
  E(11, 'dee', 1, 10, { division: 'dust', supervisor_name: 'Lee' }),
  E(12, 'dee', 2, 10, { division: 'dust', supervisor_name: 'Lee' }),
  E(13, 'dee', 3, 10, { division: 'dust', supervisor_name: 'Lee' }),
  // CAL — thirty-four: six left, inside a day of the line.
  E(14, 'cal', 0, 10, { division: 'turf', supervisor_name: 'Jones' }),
  E(15, 'cal', 1, 10, { division: 'turf', supervisor_name: 'Jones' }),
  E(16, 'cal', 2, 10, { division: 'turf', supervisor_name: 'Jones' }),
  E(17, 'cal', 3, 4,  { division: 'turf', supervisor_name: 'Jones', status: 'submitted' }),
  // ELI — sixteen worked and an hour and a half of travel. Travel on the clock
  // is time worked, so 17.50 counts toward the 40.
  E(18, 'eli', 0, 8, { division: 'quarry', supervisor_name: 'Lee', travel_hours: 1.5 }),
  E(19, 'eli', 1, 8, { division: 'quarry', supervisor_name: 'Lee' }),
  // FAY — one eight-hour day and an approved vacation day. Paid leave is not
  // hours worked: she has 32 left, not 24.
  E(20, 'fay', 0, 8, { division: 'turf', supervisor_name: 'Jones' }),
  { id: 21, username: 'fay', entry_type: 'time_off', status: 'approved', work_date: day(1),
    time_off_type: 'vacation', time_off_hours: 8, created_at: `${day(1)}T12:00:00Z` },
];

// Last week, closed. Read through Last Week, Last + This, and dates that cut
// into it.
const LAST = [
  // AVA — forty-eight, all approved: eight hours past the line. The Monday and
  // Tuesday are what a From on last Wednesday would have cut off the count.
  E(30, 'ava', -7, 10), E(31, 'ava', -6, 10), E(32, 'ava', -5, 10), E(33, 'ava', -4, 10),
  E(34, 'ava', -3, 8),
  // GUS — last week only, exactly forty on Trucking.
  E(35, 'gus', -7, 10, { division: 'trucking', supervisor_name: 'Lee' }),
  E(36, 'gus', -6, 10, { division: 'trucking', supervisor_name: 'Lee' }),
  E(37, 'gus', -5, 10, { division: 'trucking', supervisor_name: 'Lee' }),
  E(38, 'gus', -4, 10, { division: 'trucking', supervisor_name: 'Lee' }),
  // CAL — twenty-four, a day of it still pending a week on.
  E(39, 'cal', -7, 8, { division: 'turf', supervisor_name: 'Jones' }),
  E(40, 'cal', -6, 8, { division: 'turf', supervisor_name: 'Jones' }),
  E(41, 'cal', -5, 8, { division: 'turf', supervisor_name: 'Jones', status: 'submitted' }),
];
const ALL = WEEK.concat(LAST);

// Rows the server would never send for this week, sent anyway in one test —
// the report must not depend on the server alone to keep them out.
const STRAYS = [
  E(90, 'ava', -3, 20),                       // last Friday
  E(91, 'fay',  2, 30, { status: 'draft' }),  // never submitted
];

// ── A stub server behind fetch ───────────────────────────────────────────────
// Filters the way /api/timesheet-entries does, so the range load and the
// report's own load each get what the real endpoint would hand them.
function serverRows(state, u) {
  if (state.leak) return state.rows.concat(STRAYS);
  const from = u.searchParams.get('from') || '0000-00-00';
  const to   = u.searchParams.get('to')   || '9999-12-31';
  const div  = u.searchParams.get('division') || '';
  const st   = u.searchParams.get('status');
  return state.rows.filter(e =>
    e.work_date >= from && e.work_date <= to &&
    (!div || e.division === div) &&
    (st !== 'submitted_approved' || e.status === 'submitted' || e.status === 'approved'));
}

function respond(state, url) {
  state.urls.push(url);
  const u = new URL(url, 'https://datawatch.app');
  const isList = u.pathname === '/api/timesheet-entries' && !u.searchParams.get('action');
  let status = 200, body = {};
  if (u.pathname === '/api/timesheet-entries' && u.searchParams.get('action') === 'pending_span') {
    body = { total: 0, before: 0, after: 0 };
  } else if (isList) {
    if (state.fail && state.fail(u)) { status = 500; body = { error: 'database unavailable' }; }
    else body = { entries: serverRows(state, u) };
  }
  const reply = b => ({ ok: status < 400, status, json: async () => b });
  if (state.hold && isList) {
    // Held until the test lets it go — optionally with a different answer.
    return new Promise(resolve => state.held.push({ url, release: b => resolve(reply(b || body)) }));
  }
  return Promise.resolve(reply(body));
}

function bootPage() {
  const state = { rows: ALL.slice(), leak: false, hold: false, held: [], fail: null,
                  urls: [], alerts: [], errors: [], downloads: [], ar: {} };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (/Not implemented: (navigation|window\.print)/i.test(e.message || '')) return;
    state.errors.push(e.message);
  });
  const dom = new JSDOM(PAGE, {
    runScripts: 'dangerously',
    url: 'https://datawatch.app/payroll.html',
    virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(w) {
      w.localStorage.setItem('fct_token', 'harness');
      w.localStorage.setItem('fct_user', JSON.stringify({
        userId: 1, username: 'office', companyCode: 'FCT', companyName: 'Force Corp', isPlatformAdmin: true,
      }));
      w.fetch   = url => respond(state, String(url));
      w.alert   = m => state.alerts.push(String(m));
      w.confirm = () => true;
      w.scrollTo = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      // auto-report.js is not loaded here (jsdom fetches no scripts), so this
      // stands in for it and keeps what the page registers.
      w.dwAutoReport = { ready() {}, jobs() {}, register(type, fn) { state.ar[type] = fn; } };
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, state };
}

// Entry-list requests, and which dates they asked for.
const listUrls = s => s.urls.filter(u => u.startsWith('/api/timesheet-entries?') && !/[?&]action=/.test(u));
const params   = u => new URL(u, 'https://datawatch.app').searchParams;
const asks     = (u, from, to) => params(u).get('from') === from && params(u).get('to') === to;
const isWeek   = u => asks(u, MON, SUN);

function readReport(doc) {
  const wrap = doc.getElementById('overtimeWrap');
  const readRow = tr => {
    const td = [...tr.children];
    return {
      name: td[0].textContent.trim(), approved: +td[1].textContent, pending: +td[2].textContent,
      worked: +td[3].textContent, left: +td[4].textContent, ot: +td[5].textContent,
      status: td[6].textContent.trim(), pill: (td[6].querySelector('.pill') || {}).className || '',
      leftCls: td[4].className, otCls: td[5].className, nameTitle: td[0].getAttribute('title') || '',
      statusTitle: (td[6].querySelector('.pill') || { getAttribute: () => '' }).getAttribute('title') || '',
    };
  };
  // One <tbody> per week; a band heads it when there is more than one.
  const bodies = [...wrap.querySelectorAll('table.otw-table tbody')].map(tb => {
    const band = tb.querySelector('tr.otw-band');
    return {
      band: band && {
        label: band.querySelector('.otw-band-label').textContent.trim(),
        text:  band.textContent.replace(/\s+/g, ' ').trim(),
        cls:   band.className,
        span:  Number(band.querySelector('td').getAttribute('colspan') || 1),
      },
      rows: [...tb.querySelectorAll('tr.otw-row')].map(readRow),
    };
  });
  const heads = [...wrap.querySelectorAll('table.otw-table thead th')].map(th => th.textContent.trim());
  const foot  = [...wrap.querySelectorAll('table.otw-table tfoot td')].map(td => td.textContent.trim());
  const tiles = [...wrap.querySelectorAll('.proj-stat')].map(s => ({
    label: s.querySelector('.proj-stat-label').textContent.trim(),
    value: s.querySelector('.proj-stat-value').textContent.trim(),
    sub:   s.querySelector('.proj-stat-sub').textContent.trim(),
    title: s.getAttribute('title') || '',
    cls:   s.className,
  }));
  const excel = wrap.querySelector('.btn-excel');
  return {
    rows: bodies.flatMap(b => b.rows), bodies, bands: bodies.map(b => b.band).filter(Boolean),
    heads, foot, tiles, excel, text: wrap.textContent.replace(/\s+/g, ' ').trim(),
  };
}
const names = r => r.rows.map(x => x.name).join(',');
const tileOf = (r, l) => r.tiles.find(t => t.label === l) || {};

// Set the date boxes and press Apply, as a person would.
async function applyDates(doc, from, to) {
  doc.getElementById('flt-from').value = from;
  doc.getElementById('flt-to').value   = to;
  doc.querySelector('.btn-filter').click();
  await settle();
}
async function pressRange(doc, kind) {
  doc.querySelector(`#quickRanges .qr-btn[data-range="${kind}"]`).click();
  await settle();
}

(async () => {

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[structural — payroll.html]');
// ─────────────────────────────────────────────────────────────────────────────
{
  const subs = PAGE.slice(PAGE.indexOf('id="reportSubTabs"'), PAGE.indexOf('id="reportWrap"'));
  assert('Reports has a third sub-tab, Overtime, after Employees and Projects',
    /id="rst-employees"[\s\S]*id="rst-projects"[\s\S]*id="rst-overtime"[^>]*>Overtime</.test(subs));
  assert('  and it says it reads the dates above, week by week',
    /id="rst-overtime"[^>]*title="Week by week for the dates above/.test(subs));
  assert('it has its own container beside the other two',
    /<div id="overtimeWrap" style="display:none"><\/div>/.test(PAGE));
  const bar = PAGE.slice(PAGE.indexOf('id="quickRanges"'), PAGE.indexOf('id="reportSubTabs"'));
  assert('the quick-range bar has nothing standing in for its buttons any more — they apply here too',
    !/otwRangeNote|qr-otw-note|otw-mode/.test(PAGE) && /data-range="last_biweekly"[\s\S]*?<\/button>\s*<\/div>/.test(bar));
  assert('the three standing pills are styled on screen',
    ['.pill-ot', '.pill-near', '.pill-room'].every(c => PAGE.includes(`    ${c} `)));
  const print = PAGE.slice(PAGE.indexOf('@media print {'));
  assert('  and given ink for paper',
    ['.pill-ot', '.pill-near', '.pill-room'].every(c => new RegExp(`\\${c}\\s+\\{[^}]*!important`).test(print)));
  assert('  and the table prints whole rather than inside a scroll box',
    /\.otw-scroll\s+\{ overflow: visible !important; \}/.test(print));
  assert('  and its week bands print grey and black',
    /\.otw-table tr\.otw-band > td \{[^}]*background: #f2f2f2 !important;/.test(print) &&
    /\.otw-table \.otw-band-label,[\s\S]*?\{ color: #000 !important;/.test(print));
  assert('  and never strand at the foot of a page, away from their rows',
    /\.otw-table tr\.otw-band \{ break-inside: avoid; break-after: avoid; \}/.test(print));
  assert('the quick-range bar stays off paper',
    /header, \.filters, \.tabs, \.stats, \.bulk, \.backlog, \.quick-ranges,/.test(print));
}

const { dom, win, doc, state } = bootPage();
await settle(150);
const short = d => win.eval(`prettyDateShort('${d}')`);
const long  = d => win.eval(`prettyDate('${d}')`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[the page boots, and agrees with this file about which week it is]');
// ─────────────────────────────────────────────────────────────────────────────
assert('nothing throws while the page loads', state.errors.length === 0, state.errors[0]);
assert(`the page's week opens on ${MON}`, win.eval('ymd(thisWeekMonday())') === MON,
  `page says ${win.eval('ymd(thisWeekMonday())')}`);

// Open Reports and point the range at LAST week before Overtime is opened: it
// must load the dates in the boxes, not the week in progress.
doc.querySelector('.tab[data-tab="reports"]').click();
await settle();
await pressRange(doc, 'last_week');
assert('the range is set to last week before Overtime is opened',
  doc.getElementById('flt-from').value === LAST_MON && doc.getElementById('flt-to').value === LAST_SUN);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[opening Reports ▸ Overtime reads the dates — here, last week]');
// ─────────────────────────────────────────────────────────────────────────────
let before = listUrls(state).length;
doc.getElementById('rst-overtime').click();
await settle();
{
  const fresh = listUrls(state).slice(before);
  assert('opening it makes exactly one request', fresh.length === 1, fresh.join(' | '));
  const p = fresh[0] ? params(fresh[0]) : new URLSearchParams();
  assert(`  for the dates in the boxes, ${LAST_MON} → ${LAST_SUN}`,
    p.get('from') === LAST_MON && p.get('to') === LAST_SUN, fresh[0]);
  assert('  for everyone\'s time, submitted and approved',
    p.get('scope') === 'all' && p.get('status') === 'submitted_approved', fresh[0]);
  assert('  and in every division', !p.has('division'), fresh[0]);
  assert('the boxes are left on last week',
    doc.getElementById('flt-from').value === LAST_MON && doc.getElementById('flt-to').value === LAST_SUN);

  assert('the Overtime button is the active one',
    doc.getElementById('rst-overtime').classList.contains('active') &&
    !doc.getElementById('rst-employees').classList.contains('active') &&
    !doc.getElementById('rst-projects').classList.contains('active'));
  assert('its report is on show and the other two are not',
    doc.getElementById('overtimeWrap').style.display === '' &&
    doc.getElementById('reportWrap').style.display === 'none' &&
    doc.getElementById('projectsWrap').style.display === 'none');

  const bar = doc.getElementById('quickRanges');
  assert('the quick-range buttons stay on show — they choose the weeks here too',
    bar.style.display === 'flex' &&
    [...bar.querySelectorAll(':scope > .qr-btn')].every(b => win.getComputedStyle(b).display !== 'none'));
  assert('  with Last Week lit', bar.querySelector('.qr-btn[data-range="last_week"]').classList.contains('active'));
  assert('  and no line saying the dates do not apply',
    !/always covers the week in progress/.test(bar.textContent), bar.textContent.replace(/\s+/g, ' '));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[a closed week]');
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = readReport(doc);
  assert('one row per person with time last week, closest to overtime first',
    names(r) === 'ava,gus,cal', names(r));
  const by = Object.fromEntries(r.rows.map(x => [x.name, x]));
  const row = (who, a, p, w, l, o, s) => {
    const x = by[who] || {};
    assert(`${who}: ${a} approved + ${p} pending = ${w} worked · ${l} left · ${o} OT · ${s}`,
      near(x.approved, a) && near(x.pending, p) && near(x.worked, w) &&
      near(x.left, l) && near(x.ot, o) && x.status === s,
      JSON.stringify({ approved: x.approved, pending: x.pending, worked: x.worked, left: x.left, ot: x.ot, status: x.status }));
  };
  row('ava', 48, 0, 48, 0,  8, 'Overtime');
  row('gus', 40, 0, 40, 0,  0, 'At 40');
  row('cal', 16, 8, 24, 16, 0, 'Under 40');

  assert('one week, so no week bands', r.bands.length === 0 && r.bodies.length === 1);
  assert('the head names the week, and does not call it this week',
    r.text.includes(`Week · ${long(LAST_MON)} – ${long(LAST_SUN)}`) && !r.text.includes('This week ·'), r.text.slice(0, 240));
  assert('  with nothing to explain about the dates — they are a whole week already',
    !/Whole Monday–Sunday weeks for the dates set/.test(r.text) && !/No dates set/.test(r.text));
  assert('a closed week reads as finished: gus ended exactly on the line',
    /40\.00 h the week of .* — exactly 40, none of it overtime\./.test(by.gus.statusTitle), by.gus.statusTitle);
  assert('  cal ended sixteen under it, a day of it still pending',
    /it closed 16\.00 h under 40\. 8\.00 h of it is still pending approval/.test(by.cal.statusTitle), by.cal.statusTitle);
  assert('  and the name says which week it was',
    by.cal.nameTitle === `Turf · 3 days worked the week of ${short(LAST_MON)}`, by.cal.nameTitle);

  assert('tiles: 3 employees, 1 in overtime, 1 near it, 8.00 pending',
    tileOf(r, 'Employees').value === '3' && tileOf(r, 'In Overtime').value === '1' &&
    tileOf(r, 'Near Overtime').value === '1' && tileOf(r, 'Pending Hours').value === '8.00', JSON.stringify(r.tiles));
  assert('  and they speak of that week, not of "so far"',
    tileOf(r, 'Employees').sub === '112.00 h worked that week' && tileOf(r, 'In Overtime').sub === '8.00 OT hours',
    JSON.stringify(r.tiles.map(t => t.sub)));
  assert('the totals row adds that week up',
    r.foot[0] === 'Totals (3 employees)' && near(r.foot[1], 104) && near(r.foot[2], 8) &&
    near(r.foot[3], 112) && near(r.foot[4], 16) && near(r.foot[5], 8) && r.foot[6] === '1 in overtime · 1 near',
    JSON.stringify(r.foot));
  assert('no "new week" caveat on a past week chosen on purpose', !/A new week has started/.test(r.text));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[This Week]');
// ─────────────────────────────────────────────────────────────────────────────
before = listUrls(state).length;
await pressRange(doc, 'current_week');
{
  const fresh = listUrls(state).slice(before);
  assert('This Week reloads the report — and the range — for the week in progress',
    fresh.length === 2 && fresh.every(isWeek) && fresh.every(u => !params(u).has('division')), fresh.join(' | '));
  assert('  and lights This Week',
    doc.querySelector('#quickRanges .qr-btn[data-range="current_week"]').classList.contains('active'));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[the table — the week in progress]');
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = readReport(doc);
  assert('the columns are the ones asked for, in reading order',
    JSON.stringify(r.heads) === JSON.stringify(
      ['Employee', 'Approved Hrs', 'Pending Hrs', 'Hours Worked', 'Hours Left Until OT', 'OT Hrs', 'Status']),
    JSON.stringify(r.heads));
  assert('one row per person with time this week', r.rows.length === 6, names(r));
  assert('closest to overtime first', names(r) === 'ava,ben,dee,cal,eli,fay', names(r));
  assert('one week, so no week bands', r.bands.length === 0);

  const by = Object.fromEntries(r.rows.map(x => [x.name, x]));
  const row = (who, a, p, w, l, o, s) => {
    const x = by[who] || {};
    assert(`${who}: ${a} approved + ${p} pending = ${w} worked · ${l} left · ${o} OT · ${s}`,
      near(x.approved, a) && near(x.pending, p) && near(x.worked, w) &&
      near(x.left, l) && near(x.ot, o) && x.status === s,
      JSON.stringify({ approved: x.approved, pending: x.pending, worked: x.worked, left: x.left, ot: x.ot, status: x.status }));
  };
  row('ava', 40,   6, 46,   0,    6, 'Overtime');
  row('ben', 30,  12, 42,   0,    2, 'Overtime');
  row('dee', 40,   0, 40,   0,    0, 'At 40');
  row('cal', 30,   4, 34,   6,    0, 'Near OT');
  row('eli', 17.5, 0, 17.5, 22.5, 0, 'Under 40');
  row('fay', 8,    0, 8,    32,   0, 'Under 40');

  assert('pending time is counted — ava is in overtime on a day nobody has approved',
    near(by.ava.worked, by.ava.approved + by.ava.pending) && by.ava.ot > 0);
  assert('travel counts toward the 40 (eli: 16 worked + 1.5 travel)', near(by.eli.worked, 17.5));
  assert('paid time off does not (fay: 8 worked, a vacation day, 32 left)', near(by.fay.left, 32));
  assert('hours worked across divisions are one week (ben: 30 Paving + 12 Turf = 42)', near(by.ben.worked, 42));
  assert('last week\'s hours stay in last week (ava: 46 here, not 94)', near(by.ava.worked, 46));

  assert('overtime is coloured only where there is some',
    /num-ot/.test(by.ava.otCls) && !/num-ot/.test(by.cal.otCls));
  assert('hours left are coloured only where there are some',
    /num-room/.test(by.cal.leftCls) && !/num-room/.test(by.dee.leftCls));
  assert('each standing wears its pill: orange over, amber near, teal under',
    /pill-ot/.test(by.ava.pill) && /pill-near/.test(by.dee.pill) &&
    /pill-near/.test(by.cal.pill) && /pill-room/.test(by.eli.pill));
  assert('the status says when the overtime rests on pending time',
    /6\.00 h of it is still pending approval/.test(by.ava.statusTitle), by.ava.statusTitle);
  assert('  and does not say it when none is pending', !/pending/.test(by.dee.statusTitle), by.dee.statusTitle);
  assert('the week in progress reads as open: dee\'s next hour is overtime, cal has six left',
    /at 40, so the next hour worked is overtime/.test(by.dee.statusTitle) &&
    /34\.00 h this week — 6\.00 h left before overtime starts/.test(by.cal.statusTitle), by.cal.statusTitle);
  assert('the name carries the divisions worked, for a company-wide list',
    /Paving, Turf · 4 days worked this week/.test(by.ben.nameTitle), by.ben.nameTitle);

  assert('the totals row adds the people up',
    r.foot[0] === 'Totals (6 employees)' &&
    near(r.foot[1], 165.5) && near(r.foot[2], 22) && near(r.foot[3], 187.5) &&
    near(r.foot[4], 60.5) && near(r.foot[5], 8), JSON.stringify(r.foot));
  assert('  and counts the standings', r.foot[6] === '2 in overtime · 2 near', r.foot[6]);
  assert('the totals row spans every column', r.foot.length === r.heads.length);

  assert('tiles: 6 employees, 2 in overtime, 2 near it, 22.00 pending',
    tileOf(r, 'Employees').value === '6' && tileOf(r, 'In Overtime').value === '2' &&
    tileOf(r, 'Near Overtime').value === '2' && tileOf(r, 'Pending Hours').value === '22.00',
    JSON.stringify(r.tiles));
  assert('  the week in progress is "so far"',
    tileOf(r, 'Employees').sub === '187.50 h worked this week' && tileOf(r, 'In Overtime').sub === '8.00 OT hours so far',
    JSON.stringify(r.tiles.map(t => t.sub)));
  assert('  the overtime tile is orange and the near tile amber when there are any',
    / ot\b/.test(tileOf(r, 'In Overtime').cls) && / near\b/.test(tileOf(r, 'Near Overtime').cls));

  assert('the head names the report and the week',
    r.text.includes('Weekly Overtime Report') &&
    r.text.includes(`This week · ${long(MON)} – ${long(SUN)}`) &&
    r.text.includes('Force Corp') && /As of /.test(r.text), r.text.slice(0, 240));
  assert('the note under the table states the rule',
    /Overtime is anything past 40 hours in the Monday–Sunday week\./.test(r.text) &&
    /pending days included/.test(r.text) && /Paid time off does not count toward the 40/.test(r.text), r.text.slice(-500));
  assert('Export to Excel is live', r.excel && !r.excel.disabled);
  assert('no "new week" caveat on a week that is current', !/A new week has started/.test(r.text));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[filters choose who is listed — never which hours count]');
// ─────────────────────────────────────────────────────────────────────────────
{
  const divEl = doc.getElementById('flt-division');
  divEl.value = 'paving';
  before = listUrls(state).length;
  doc.querySelector('.btn-filter').click();   // Apply
  await settle();
  const fresh = listUrls(state).slice(before);
  const reportLoads = fresh.filter(u => !params(u).has('division'));
  const rangeLoads  = fresh.filter(u =>  params(u).has('division'));
  assert('Apply reloads the report AND the range', reportLoads.length === 1 && rangeLoads.length === 1, fresh.join(' | '));
  assert('  the report\'s load carries no division, and asks for the week',
    reportLoads[0] && isWeek(reportLoads[0]), reportLoads[0]);
  assert('  while the range load is filtered to Paving, as before',
    rangeLoads[0] && params(rangeLoads[0]).get('division') === 'paving', rangeLoads[0]);

  let r = readReport(doc);
  assert('Division = Paving lists the two people with Paving time', names(r) === 'ava,ben', names(r));
  const ben = r.rows.find(x => x.name === 'ben') || {};
  assert('  and ben is still 42 worked, 2 over — his Turf day is his week too',
    near(ben.worked, 42) && near(ben.ot, 2) && near(ben.pending, 12), JSON.stringify(ben));
  assert('  the head says who is listed', /Listing: Paving division/.test(r.text));
  assert('  and the note says the hours are still the whole week', /each person's hours are still their whole week/.test(r.text));

  divEl.value = '';
  doc.querySelector('.btn-filter').click();
  await settle();

  const sup = doc.getElementById('flt-supervisor');
  sup.value = 'jones';
  sup.dispatchEvent(new win.Event('input'));
  r = readReport(doc);
  assert('Supervisor "jones" lists everyone with a day under Jones', names(r) === 'ben,cal,fay', names(r));
  assert('  ben with his whole week, the Paving days under Smith included',
    near((r.rows.find(x => x.name === 'ben') || {}).worked, 42));
  assert('  the head says so', /Listing: supervisor "jones"/.test(r.text));
  sup.value = '';
  sup.dispatchEvent(new win.Event('input'));

  const usr = doc.getElementById('flt-user');
  usr.value = 'A';
  usr.dispatchEvent(new win.Event('input'));
  r = readReport(doc);
  assert('Employee "A" matches by name, any case', names(r) === 'ava,cal,fay', names(r));
  usr.value = 'zzz';
  usr.dispatchEvent(new win.Event('input'));
  r = readReport(doc);
  assert('a filter matching nobody says so, and does not claim the week is empty',
    /Nobody matching these filters has time submitted for this week yet/.test(r.text) && !r.rows.length, r.text);
  assert('  with nothing to export', r.excel && r.excel.disabled);
  usr.value = '';
  usr.dispatchEvent(new win.Event('input'));
  assert('clearing the filters brings everyone back', readReport(doc).rows.length === 6);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[several weeks — Last + This]');
// ─────────────────────────────────────────────────────────────────────────────
before = listUrls(state).length;
await pressRange(doc, 'last_and_this_week');
{
  const fresh = listUrls(state).slice(before);
  assert(`the report loads both weeks, ${LAST_MON} → ${SUN}, in every division`,
    fresh.filter(u => asks(u, LAST_MON, SUN) && !params(u).has('division')).length === 2 && fresh.length === 2,
    fresh.join(' | '));

  const r = readReport(doc);
  assert('a band for each week, oldest first',
    r.bands.length === 2 && r.bodies.length === 2 &&
    r.bands[0].label === `Week · ${short(LAST_MON)} – ${short(LAST_SUN)}` &&
    r.bands[1].label === `This week · ${short(MON)} – ${short(SUN)}`, JSON.stringify(r.bands.map(b => b.label)));
  assert('  each spans the whole table', r.bands.every(b => b.span === r.heads.length));
  assert('under each, that week\'s people, closest to overtime first',
    r.bodies[0].rows.map(x => x.name).join(',') === 'ava,gus,cal' &&
    r.bodies[1].rows.map(x => x.name).join(',') === 'ava,ben,dee,cal,eli,fay', names(r));
  const avaWeeks = r.rows.filter(x => x.name === 'ava');
  assert('ava is two rows, 48 and 46 — two weeks measured one at a time, never 94 against one 40',
    avaWeeks.length === 2 && near(avaWeeks[0].worked, 48) && near(avaWeeks[0].ot, 8) &&
    near(avaWeeks[1].worked, 46) && near(avaWeeks[1].ot, 6), JSON.stringify(avaWeeks));
  const calWeeks = r.rows.filter(x => x.name === 'cal');
  assert('cal is Under 40 in one week and Near OT in the other, each read on its own',
    calWeeks.length === 2 && calWeeks[0].status === 'Under 40' && near(calWeeks[0].left, 16) &&
    calWeeks[1].status === 'Near OT' && near(calWeeks[1].left, 6), JSON.stringify(calWeeks));
  assert('each band carries its own week\'s figures',
    /3 employees/.test(r.bands[0].text) && /112\.00 h worked/.test(r.bands[0].text) &&
    /8\.00 OT hrs · 1 in overtime/.test(r.bands[0].text) && /1 near/.test(r.bands[0].text) &&
    /6 employees/.test(r.bands[1].text) && /187\.50 h worked/.test(r.bands[1].text) &&
    /8\.00 OT hrs · 2 in overtime/.test(r.bands[1].text) && /2 near/.test(r.bands[1].text),
    JSON.stringify(r.bands.map(b => b.text)));
  assert('  and is edged orange when its week has overtime', r.bands.every(b => /\botw-band-ot\b/.test(b.cls)));

  assert('the head counts the weeks and names the span',
    r.text.includes(`2 weeks · ${long(LAST_MON)} – ${long(SUN)}`), r.text.slice(0, 240));
  assert('the tiles count each person once — 7 employees over 2 weeks',
    tileOf(r, 'Employees').value === '7' && tileOf(r, 'Employees').sub === '299.50 h worked over 2 weeks',
    JSON.stringify(tileOf(r, 'Employees')));
  assert('  in overtime is anyone past 40 in either week: ava and ben',
    tileOf(r, 'In Overtime').value === '2' && tileOf(r, 'In Overtime').sub === '16.00 OT hours' &&
    /Each person counted once/.test(tileOf(r, 'In Overtime').title), JSON.stringify(tileOf(r, 'In Overtime')));
  assert('  near is anyone close in a week without passing it in any: dee, cal and gus',
    tileOf(r, 'Near Overtime').value === '3' && tileOf(r, 'Near Overtime').sub === '8 h or less before 40 in a week',
    JSON.stringify(tileOf(r, 'Near Overtime')));
  assert('the totals row adds both weeks and counts people, not rows',
    r.foot[0] === 'Totals (7 employees · 2 weeks)' &&
    near(r.foot[1], 269.5) && near(r.foot[2], 30) && near(r.foot[3], 299.5) &&
    near(r.foot[4], 76.5) && near(r.foot[5], 16) && r.foot[6] === '2 in overtime · 3 near', JSON.stringify(r.foot));
  assert('the note says each week is counted on its own, and how people are counted',
    /in the Monday–Sunday week, each week counted on its own\./.test(r.text) &&
    /count each person once, by the furthest any of their weeks went/.test(r.text), r.text.slice(-600));

  const usr = doc.getElementById('flt-user');
  usr.value = 'gus';
  usr.dispatchEvent(new win.Event('input'));
  const g = readReport(doc);
  assert('a filter lists a person in the weeks they worked — gus last week only',
    names(g) === 'gus' && g.bodies[0].rows.length === 1 && g.bodies[1].rows.length === 0, names(g));
  assert('  the empty week keeps its band, and says why it is empty',
    g.bands.length === 2 && /no time from anyone matching these filters/.test(g.bands[1].text) &&
    !/\botw-band-ot\b/.test(g.bands[1].cls), JSON.stringify(g.bands.map(b => b.text)));
  assert('  and the totals are his: 1 employee, 2 weeks',
    g.foot[0] === 'Totals (1 employee · 2 weeks)' && g.foot[6] === '0 in overtime · 1 near', JSON.stringify(g.foot));
  usr.value = 'zzz';
  usr.dispatchEvent(new win.Event('input'));
  assert('a filter matching nobody in any of the weeks says so',
    /Nobody matching these filters has time submitted for these weeks yet\./.test(readReport(doc).text), readReport(doc).text);
  usr.value = '';
  usr.dispatchEvent(new win.Event('input'));

  win.downloadBlob = (name, blob) => state.downloads.push({ name, blob });
  readReport(doc).excel.click();
  const d = state.downloads.pop() || {};
  assert('Export to Excel names the file for both weeks', d.name === `weekly-overtime-FCT-${LAST_MON}_${SUN}.xlsx`, d.name);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[dates that cut into a week are widened to the whole week]');
// ─────────────────────────────────────────────────────────────────────────────
before = listUrls(state).length;
await applyDates(doc, day(-5), day(1));     // last Wednesday → this Tuesday
{
  const fresh = listUrls(state).slice(before);
  assert(`the report asks for the whole weeks the dates touch, ${LAST_MON} → ${SUN}`,
    fresh.filter(u => asks(u, LAST_MON, SUN)).length === 1, fresh.join(' | '));
  assert('  while the range load asks for exactly the dates typed',
    fresh.filter(u => asks(u, day(-5), day(1))).length === 1, fresh.join(' | '));
  const r = readReport(doc);
  const ava = r.bodies[0] ? r.bodies[0].rows.find(x => x.name === 'ava') || {} : {};
  assert('ava\'s last week is counted whole — 48 and 8 over, the Monday and Tuesday before the From included',
    near(ava.worked, 48) && near(ava.ot, 8), JSON.stringify(ava));
  assert('the head says the dates were widened, and why',
    r.text.includes(`Whole Monday–Sunday weeks for the dates set (${short(day(-5))} – ${short(day(1))}) — overtime is counted a week at a time`),
    r.text.slice(0, 320));
  assert('  and names the weeks actually shown', r.text.includes(`2 weeks · ${long(LAST_MON)} – ${long(SUN)}`));
  assert('no range button is lit for dates that are none of them',
    ![...doc.querySelectorAll('#quickRanges .qr-btn')].some(b => b.classList.contains('active')));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[no dates, or only one]');
// ─────────────────────────────────────────────────────────────────────────────
{
  before = listUrls(state).length;
  doc.querySelector('.btn-clear').click();    // Reset — both boxes empty
  await settle();
  let fresh = listUrls(state).slice(before);
  assert('Reset clears the dates, and the report falls back on the week in progress',
    doc.getElementById('flt-from').value === '' && fresh.filter(isWeek).length === 1, fresh.join(' | '));
  let r = readReport(doc);
  assert('  and says so', /No dates set — the week in progress/.test(r.text) &&
    r.text.includes(`This week · ${long(MON)} – ${long(SUN)}`) && r.rows.length === 6, r.text.slice(0, 260));

  before = listUrls(state).length;
  await applyDates(doc, LAST_MON, '');
  fresh = listUrls(state).slice(before);
  r = readReport(doc);
  assert('a From with no To runs through the week in progress',
    fresh.filter(u => asks(u, LAST_MON, SUN)).length === 1 && r.bands.length === 2, fresh.join(' | '));
  assert(`  and the head says what it made of the dates`,
    r.text.includes(`Whole Monday–Sunday weeks for the dates set (from ${short(LAST_MON)}, no To)`), r.text.slice(0, 320));

  before = listUrls(state).length;
  await applyDates(doc, '', LAST_SUN);
  fresh = listUrls(state).slice(before);
  r = readReport(doc);
  assert('a To with no From is that one week',
    fresh.filter(u => asks(u, LAST_MON, LAST_SUN)).length === 1 && names(r) === 'ava,gus,cal', fresh.join(' | '));
  assert('  and the head says what it made of the dates',
    r.text.includes(`Whole Monday–Sunday weeks for the dates set (to ${short(LAST_SUN)}, no From)`), r.text.slice(0, 320));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[To before From]');
// ─────────────────────────────────────────────────────────────────────────────
{
  before = listUrls(state).length;
  await applyDates(doc, MON, LAST_SUN);
  const fresh = listUrls(state).slice(before);
  assert('the report asks the server for nothing — only the range load goes out',
    fresh.length === 1 && asks(fresh[0], MON, LAST_SUN), fresh.join(' | '));
  const r = readReport(doc);
  assert('it says the dates are the wrong way round, rather than that nobody worked',
    /The From date is after the To date, so there are no weeks between them to show\./.test(r.text) &&
    !/No time has been submitted/.test(r.text) && !r.rows.length, r.text);
  assert('  with nothing to export', r.excel && r.excel.disabled);
}
await pressRange(doc, 'current_week');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[moving between sub-tabs and tabs]');
// ─────────────────────────────────────────────────────────────────────────────
{
  before = listUrls(state).length;
  doc.getElementById('rst-employees').click();
  await settle();
  const bar = doc.getElementById('quickRanges');
  assert('back on Employees, the range buttons are still there',
    [...bar.querySelectorAll(':scope > .qr-btn')].every(b => win.getComputedStyle(b).display !== 'none'));
  assert('  the Hours Report is on show, Overtime is not',
    doc.getElementById('reportWrap').style.display === '' &&
    doc.getElementById('overtimeWrap').style.display === 'none' &&
    /Payroll Hours Report/.test(doc.getElementById('reportWrap').textContent));
  assert('  and switching to it fetched nothing — it reads the range already loaded',
    listUrls(state).length === before);

  doc.getElementById('rst-overtime').click();
  await settle();
  doc.querySelector('.tab[data-tab="pending"]').click();
  await settle();
  assert('leaving Reports hides the Overtime report', doc.getElementById('overtimeWrap').style.display === 'none');

  before = listUrls(state).length;
  doc.querySelector('.tab[data-tab="reports"]').click();
  await settle();
  const fresh = listUrls(state).slice(before);
  assert('coming back to Reports reopens it on Overtime',
    doc.getElementById('overtimeWrap').style.display === '' &&
    doc.getElementById('rst-overtime').classList.contains('active'));
  assert('  and reloads its weeks', fresh.filter(u => isWeek(u) && !params(u).has('division')).length >= 1,
    fresh.join(' | '));
  assert('  back to the full table', readReport(doc).rows.length === 6);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[it keeps its own counsel about what counts]');
// ─────────────────────────────────────────────────────────────────────────────
{
  state.leak = true;          // the server sends last week's rows and a draft
  win.eval('loadOvertimeWeek()');
  await settle();
  const r  = readReport(doc);
  const by = Object.fromEntries(r.rows.map(x => [x.name, x]));
  assert('rows from last week are not counted in this one (ava stays 46)', near((by.ava || {}).worked, 46));
  assert('  nor listed as a week of their own (no gus, no bands)', !by.gus && r.bands.length === 0, names(r));
  assert('a draft is not counted (fay stays 8)', near((by.fay || {}).worked, 8));
  state.leak = false;
  win.eval('loadOvertimeWeek()');
  await settle();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[loading, failure, retry]');
// ─────────────────────────────────────────────────────────────────────────────
{
  state.fail = u => isWeek(u.pathname + u.search);
  win.eval('loadOvertimeWeek()');
  await settle();
  let r = readReport(doc);
  assert('a failed load says so, with the reason', /Couldn't load this week's time — database unavailable/.test(r.text), r.text);
  assert('  and shows no figures from before it failed', !r.rows.length && !r.tiles.length);
  assert('  and nothing to export', r.excel && r.excel.disabled);
  const retry = [...doc.querySelectorAll('#overtimeWrap .load-error button')].find(b => /Try again/.test(b.textContent));
  assert('  and offers a retry', Boolean(retry));

  state.fail = null;
  state.hold = true;
  if (retry) retry.click();
  r = readReport(doc);
  assert('the retry reads "Loading" while it waits, not the old failure',
    /Loading this week's time/.test(r.text) && !/Couldn't load/.test(r.text), r.text);
  state.hold = false;
  state.held.splice(0).forEach(h => h.release());
  await settle();
  assert('  and the table is back when it lands', readReport(doc).rows.length === 6);

  // A retry asks again for the weeks that failed — not whatever the boxes
  // have been changed to since.
  state.fail = u => u.searchParams.get('from') === LAST_MON;
  win.eval(`loadOvertimeWeek(overtimeSpan('${LAST_MON}', '${LAST_SUN}'))`);
  await settle();
  r = readReport(doc);
  assert('a failed past week names it as that week', /Couldn't load that week's time — database unavailable/.test(r.text), r.text);
  state.fail = null;
  before = listUrls(state).length;
  [...doc.querySelectorAll('#overtimeWrap .load-error button')].find(b => /Try again/.test(b.textContent)).click();
  await settle();
  let fresh = listUrls(state).slice(before);
  assert('  and its retry asks for that week again, though the boxes say this week',
    fresh.length === 1 && asks(fresh[0], LAST_MON, LAST_SUN) && names(readReport(doc)) === 'ava,gus,cal', fresh.join(' | '));
  win.eval('loadOvertimeWeek()');
  await settle();

  // The range load failing is a fact about the RANGE. Dates that cut into the
  // week make the two loads ask different things, so one fails alone: the
  // report's whole-week load lands and stays on screen.
  doc.getElementById('flt-from').value = day(2);
  doc.getElementById('flt-to').value   = SUN;
  state.fail = u => u.searchParams.get('from') === day(2);
  before = listUrls(state).length;
  doc.querySelector('.btn-filter').click();
  await settle();
  fresh = listUrls(state).slice(before);
  r = readReport(doc);
  assert('a failed range load leaves the report standing',
    r.rows.length === 6 && fresh.some(isWeek) && fresh.some(u => asks(u, day(2), SUN)), r.text.slice(0, 200));
  assert('  while the stat strip still blanks for the range that failed',
    doc.getElementById('stat-submitted').textContent === '—');
  state.fail = null;
  await pressRange(doc, 'current_week');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[a slow reply does not land over a newer one]');
// ─────────────────────────────────────────────────────────────────────────────
{
  state.hold = true;
  win.eval('loadOvertimeWeek()');   // A — will answer last
  win.eval('loadOvertimeWeek()');   // B — answers first
  const [a, b] = state.held.splice(0);
  state.hold = false;
  b.release({ entries: [E(80, 'zed', 0, 50)] });
  await settle();
  let who = names(readReport(doc));
  assert('the newer load draws', who === 'zed', who);
  a.release({ entries: WEEK });
  await settle();
  who = names(readReport(doc));
  assert('the older one, landing late, is dropped', who === 'zed', who);
  const zed = readReport(doc).rows[0] || {};
  assert('  (zed: 50 worked, 10 over, nothing left)', near(zed.worked, 50) && near(zed.ot, 10) && near(zed.left, 0));

  // Other weeks than the ones on screen: the old rows go at once rather than
  // sit under the new weeks' heading until the reply lands.
  state.hold = true;
  win.eval(`loadOvertimeWeek(overtimeSpan('${LAST_MON}', '${LAST_SUN}'))`);
  const t = readReport(doc).text;
  assert('asking for other weeks clears the old rows and reads "Loading" for the new ones',
    !readReport(doc).rows.length && /Loading that week's time/.test(t) &&
    t.includes(`Week · ${long(LAST_MON)} – ${long(LAST_SUN)}`), t.slice(0, 260));
  state.hold = false;
  state.held.splice(0).forEach(h => h.release());
  await settle();
  win.eval('loadOvertimeWeek()');
  await settle();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[where the line falls]');
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = (left, ot) => win.eval(`otwStanding(${left}, ${ot}).label`);
  assert('any overtime at all is Overtime', s(0, 0.25) === 'Overtime');
  assert('exactly 40 is At 40', s(0, 0) === 'At 40');
  assert('eight hours left is still Near OT', s(8, 0) === 'Near OT');
  assert('eight and a quarter is Under 40', s(8.25, 0) === 'Under 40');
  assert('the near line is one full day', win.eval('OTW_NEAR_HOURS') === 8);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[the week rolls over under an open page]');
// ─────────────────────────────────────────────────────────────────────────────
{
  // Rows loaded while last week was the week in progress, and a keystroke
  // redraws them: the head must not call them "this week".
  win.eval(`otwScope = { from: '${LAST_MON}', to: '${LAST_SUN}', askedFrom: '${LAST_MON}', askedTo: '${LAST_SUN}',
                         reversed: false, at: new Date(), liveWeek: '${LAST_MON}' };
            otwEntries = []; renderOvertimeReport();`);
  const t = readReport(doc).text;
  assert('the head names the week rather than calling it this week',
    t.includes(`Week · ${long(LAST_MON)}`) && !t.includes('This week ·'), t.slice(0, 200));
  win.eval(`otwEntries = ${JSON.stringify([E(70, 'old', -7, 45)])}; renderOvertimeReport();`);
  const t2 = readReport(doc).text;
  assert('  and says a new week has started, and how to get to it',
    /A new week has started since these hours were loaded\. Press This Week to load the week in progress\./.test(t2), t2.slice(-200));
  win.eval('otwScope.liveWeek = null; renderOvertimeReport();');
  assert('last week loaded on purpose says nothing of the kind', !/A new week has started/.test(readReport(doc).text));
  win.eval('loadOvertimeWeek()');
  await settle();
  assert('a reload brings the week in progress back', readReport(doc).rows.length === 6);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[an empty week]');
// ─────────────────────────────────────────────────────────────────────────────
{
  state.rows = [];
  win.eval('loadOvertimeWeek()');
  await settle();
  let r = readReport(doc);
  assert('says no time is in yet, and that everyone has the full 40',
    /No time has been submitted for this week yet — everyone has the full 40 hours before overtime/.test(r.text), r.text);
  assert('  with nothing to export', r.excel && r.excel.disabled);
  await pressRange(doc, 'last_week');
  r = readReport(doc);
  assert('an empty closed week says only that nothing was submitted for it',
    /No time has been submitted for that week\./.test(r.text) && !/yet/.test(r.text.slice(r.text.indexOf('No time'))), r.text);
  state.rows = ALL.slice();
  await pressRange(doc, 'current_week');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Export to Excel]');
// ─────────────────────────────────────────────────────────────────────────────
{
  win.downloadBlob = (name, blob) => state.downloads.push({ name, blob });
  state.downloads.length = 0;
  readReport(doc).excel.click();
  const d = state.downloads[0] || {};
  assert('downloads one workbook, named for the week it holds',
    state.downloads.length === 1 && d.name === `weekly-overtime-FCT-${MON}_${SUN}.xlsx`, d.name);
  assert('  as an .xlsx blob', d.blob && /spreadsheetml/.test(d.blob.type), d.blob && d.blob.type);

  const cellsOf = r => [...r.getElementsByTagName('c')].map(c => {
    const t = c.getElementsByTagName('t')[0], v = c.getElementsByTagName('v')[0];
    return t ? t.textContent : v ? Number(v.textContent) : '';
  });
  const sheetRows = xml => {
    const sheet = new win.DOMParser().parseFromString(xml, 'application/xml');
    return { ok: !sheet.getElementsByTagName('parsererror').length, rows: [...sheet.getElementsByTagName('row')].map(cellsOf) };
  };
  const serial = iso => win.eval(`excelDateSerial('${iso}')`);

  let xml = win.eval('overtimeWeekSheetXml(buildOvertimeWeekModel())');
  let { ok, rows } = sheetRows(xml);
  assert('the sheet is well-formed XML', ok);
  assert('it opens with the title and the week',
    rows[0][0] === 'Weekly Overtime Report' && rows[1][0] === 'Force Corp' && /^This week · /.test(rows[2][0]), JSON.stringify(rows.slice(0, 3)));
  assert('the header row is the table\'s columns, with the week\'s dates beside the name',
    JSON.stringify(rows[6]) === JSON.stringify(['Employee', 'Week Starting (Mon)', 'Week Ending (Sun)', 'Approved Hrs', 'Pending Hrs',
      'Hours Worked (approved + pending)', 'Hours Left Until OT (40 − worked)', 'OT Hrs (past 40)', 'Status']),
    JSON.stringify(rows[6]));
  assert('one row per person, in the order on screen',
    rows.slice(7, 13).map(r => r[0]).join(',') === 'ava,ben,dee,cal,eli,fay', rows.slice(7, 13).map(r => r[0]).join(','));
  assert('ava\'s figures are numbers, not text, the week as real dates: 40 · 6 · 46 · 0 · 6 · Overtime',
    JSON.stringify(rows[7]) === JSON.stringify(['ava', serial(MON), serial(SUN), 40, 6, 46, 0, 6, 'Overtime']), JSON.stringify(rows[7]));
  assert('the totals row matches the screen',
    JSON.stringify(rows[13]) === JSON.stringify(['Totals (6 employees)', '', '', 165.5, 22, 187.5, 60.5, 8, '2 in overtime · 2 near']),
    JSON.stringify(rows[13]));
  assert('the header is frozen and filterable', /ySplit="7"/.test(xml) && /<autoFilter ref="A7:I13"\/>/.test(xml));

  await pressRange(doc, 'last_and_this_week');
  xml = win.eval('overtimeWeekSheetXml(buildOvertimeWeekModel())');
  ({ ok, rows } = sheetRows(xml));
  assert('with two weeks: well-formed, and the head says so',
    ok && new RegExp(`^2 weeks · `).test(rows[2][0]), rows[2] && rows[2][0]);
  assert('  one row per person PER WEEK, last week first, each with its own week\'s dates',
    rows.slice(7, 16).map(r => `${r[0]}@${r[1]}`).join(',') ===
      ['ava', 'gus', 'cal'].map(n => `${n}@${serial(LAST_MON)}`).concat(
      ['ava', 'ben', 'dee', 'cal', 'eli', 'fay'].map(n => `${n}@${serial(MON)}`)).join(','),
    rows.slice(7, 16).map(r => `${r[0]}@${r[1]}`).join(','));
  assert('  ava\'s last week is its own row: 48 worked, 8 over',
    JSON.stringify(rows[7]) === JSON.stringify(['ava', serial(LAST_MON), serial(LAST_SUN), 48, 0, 48, 0, 8, 'Overtime']),
    JSON.stringify(rows[7]));
  assert('  the totals row counts people and weeks',
    JSON.stringify(rows[16]) === JSON.stringify(['Totals (7 employees · 2 weeks)', '', '', 269.5, 30, 299.5, 76.5, 16, '2 in overtime · 3 near']),
    JSON.stringify(rows[16]));
  assert('  and the filter covers every row', /<autoFilter ref="A7:I16"\/>/.test(xml));
  await pressRange(doc, 'current_week');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[the scheduled Weekly Overtime is still the week in progress]');
// ─────────────────────────────────────────────────────────────────────────────
{
  const build = state.ar.payroll_overtime;
  assert('the page registers it with Auto Reports', typeof build === 'function');
  if (typeof build === 'function') {
    // Whatever the boxes say — last week here — a scheduled send is the week
    // its day falls in.
    await pressRange(doc, 'last_week');
    before = listUrls(state).length;
    const out = await build({ type: 'payroll_overtime', today: ymd(new Date()), options: {} });
    const fresh = listUrls(state).slice(before);
    assert('  it loads the week in progress, not the boxes\' week',
      fresh.length === 1 && isWeek(fresh[0]) && !params(fresh[0]).has('division'), fresh.join(' | '));
    const fig = l => ((out.summary || []).find(s => s.label === l) || {}).value;
    assert('  and sends it: 6 employees, 187.50 h, 2 in overtime',
      /^Weekly Overtime — .* \(so far, as of /.test(out.subject || '') &&
      fig('Employees') === '6' && fig('Hours Worked') === '187.50' && fig('In Overtime') === '2',
      JSON.stringify({ subject: out.subject, summary: out.summary }));
    assert('  with no note about widened dates — it asked for a whole week',
      out.html && !/Whole Monday–Sunday weeks for the dates set/.test(out.html) && !/No dates set/.test(out.html));
    await pressRange(doc, 'current_week');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[the other sub-tabs still read the range]');
// ─────────────────────────────────────────────────────────────────────────────
{
  doc.getElementById('rst-projects').click();
  await settle();
  assert('Projects draws from the range load, with Overtime put away',
    doc.getElementById('projectsWrap').style.display === '' &&
    doc.getElementById('overtimeWrap').style.display === 'none');
  assert('nothing threw along the way', state.errors.length === 0, state.errors[0]);
}

dom.window.close();
console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
