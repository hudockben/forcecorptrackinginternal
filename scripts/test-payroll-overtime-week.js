#!/usr/bin/env node
'use strict';
/**
 * Reports ▸ Overtime: where each person stands against 40 THIS WEEK.
 *
 * Run: node scripts/test-payroll-overtime-week.js
 *
 * The simplest report on the page, and the one a supervisor opens mid-week:
 * hours worked so far (approved + pending), hours left before overtime, and
 * hours already past it. Anything over 40 in the Monday–Sunday week is
 * overtime.
 *
 * Three promises it makes, and this file holds it to each:
 *
 *   · IT IS ALWAYS THE WEEK IN PROGRESS. The date range above it is free to be
 *     last cycle; this report fetches its own week and never reads the range.
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

// ── The week, in the page's own terms ────────────────────────────────────────
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

// Rows the server would never send for this week, sent anyway in one test —
// the report must not depend on the server alone to keep them out.
const STRAYS = [
  E(90, 'ava', -3, 20),                       // last Friday
  E(91, 'fay',  2, 30, { status: 'draft' }),  // never submitted
];

// ── A stub server behind fetch ───────────────────────────────────────────────
// Filters the way /api/timesheet-entries does, so the range load and the week
// load each get what the real endpoint would hand them.
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
  const state = { rows: WEEK.slice(), leak: false, hold: false, held: [], fail: null,
                  urls: [], alerts: [], errors: [], downloads: [] };
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
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, state };
}

// Entry-list requests, split by which question they answer.
const listUrls = s => s.urls.filter(u => u.startsWith('/api/timesheet-entries?') && !/[?&]action=/.test(u));
const params   = u => new URL(u, 'https://datawatch.app').searchParams;
const isWeek   = u => params(u).get('from') === MON && params(u).get('to') === SUN;

function readReport(doc) {
  const wrap = doc.getElementById('overtimeWrap');
  const rows = [...wrap.querySelectorAll('table.otw-table tbody tr')].map(tr => {
    const td = [...tr.children];
    return {
      name: td[0].textContent.trim(), approved: +td[1].textContent, pending: +td[2].textContent,
      worked: +td[3].textContent, left: +td[4].textContent, ot: +td[5].textContent,
      status: td[6].textContent.trim(), pill: (td[6].querySelector('.pill') || {}).className || '',
      leftCls: td[4].className, otCls: td[5].className, nameTitle: td[0].getAttribute('title') || '',
      statusTitle: (td[6].querySelector('.pill') || { getAttribute: () => '' }).getAttribute('title') || '',
    };
  });
  const heads = [...wrap.querySelectorAll('table.otw-table thead th')].map(th => th.textContent.trim());
  const foot  = [...wrap.querySelectorAll('table.otw-table tfoot td')].map(td => td.textContent.trim());
  const tiles = [...wrap.querySelectorAll('.proj-stat')].map(s => ({
    label: s.querySelector('.proj-stat-label').textContent.trim(),
    value: s.querySelector('.proj-stat-value').textContent.trim(),
    cls:   s.className,
  }));
  const excel = wrap.querySelector('.btn-excel');
  return { rows, heads, foot, tiles, excel, text: wrap.textContent.replace(/\s+/g, ' ').trim() };
}

(async () => {

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[structural — payroll.html]');
// ─────────────────────────────────────────────────────────────────────────────
{
  const subs = PAGE.slice(PAGE.indexOf('id="reportSubTabs"'), PAGE.indexOf('id="reportWrap"'));
  assert('Reports has a third sub-tab, Overtime, after Employees and Projects',
    /id="rst-employees"[\s\S]*id="rst-projects"[\s\S]*id="rst-overtime"[^>]*>Overtime</.test(subs));
  assert('it has its own container beside the other two',
    /<div id="overtimeWrap" style="display:none"><\/div>/.test(PAGE));
  assert('the quick-range bar carries the week note that stands in for its buttons',
    /id="quickRanges"[\s\S]*?<span class="qr-otw-note" id="otwRangeNote"><\/span>\s*<\/div>/.test(PAGE));
  assert('the three standing pills are styled on screen',
    ['.pill-ot', '.pill-near', '.pill-room'].every(c => PAGE.includes(`    ${c} `)));
  const print = PAGE.slice(PAGE.indexOf('@media print {'));
  assert('  and given ink for paper',
    ['.pill-ot', '.pill-near', '.pill-room'].every(c => new RegExp(`\\${c}\\s+\\{[^}]*!important`).test(print)));
  assert('  and the table prints whole rather than inside a scroll box',
    /\.otw-scroll\s+\{ overflow: visible !important; \}/.test(print));
  assert('the quick-range bar, note included, stays off paper',
    /header, \.filters, \.tabs, \.stats, \.bulk, \.backlog, \.quick-ranges,/.test(print));
}

const { dom, win, doc, state } = bootPage();
await settle(150);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[the page boots, and agrees with this file about which week it is]');
// ─────────────────────────────────────────────────────────────────────────────
assert('nothing throws while the page loads', state.errors.length === 0, state.errors[0]);
assert(`the page's week opens on ${MON}`, win.eval('ymd(thisWeekMonday())') === MON,
  `page says ${win.eval('ymd(thisWeekMonday())')}`);

// Open Reports and point the range at LAST week. The Overtime report must
// ignore that entirely — and a range that is not this week also makes its own
// fetch tell apart from the range load in the request log.
doc.querySelector('.tab[data-tab="reports"]').click();
await settle();
doc.querySelector('#quickRanges .qr-btn[data-range="last_week"]').click();
await settle();
assert('the range is set to last week before Overtime is opened',
  doc.getElementById('flt-from').value === LAST_MON && doc.getElementById('flt-to').value === LAST_SUN);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[opening Reports ▸ Overtime]');
// ─────────────────────────────────────────────────────────────────────────────
let before = listUrls(state).length;
doc.getElementById('rst-overtime').click();
await settle();
{
  const fresh = listUrls(state).slice(before);
  assert('opening it makes exactly one request', fresh.length === 1, fresh.join(' | '));
  const p = fresh[0] ? params(fresh[0]) : new URLSearchParams();
  assert(`  for the week in progress, ${MON} → ${SUN}, not the range in the boxes`,
    p.get('from') === MON && p.get('to') === SUN, fresh[0]);
  assert('  for everyone\'s time, submitted and approved',
    p.get('scope') === 'all' && p.get('status') === 'submitted_approved', fresh[0]);
  assert('  and in every division', !p.has('division'), fresh[0]);
  assert('the boxes are left on last week — the other sub-tabs still read them',
    doc.getElementById('flt-from').value === LAST_MON && doc.getElementById('flt-to').value === LAST_SUN);

  assert('the Overtime button is the active one',
    doc.getElementById('rst-overtime').classList.contains('active') &&
    !doc.getElementById('rst-employees').classList.contains('active') &&
    !doc.getElementById('rst-projects').classList.contains('active'));
  assert('its report is on show and the other two are not',
    doc.getElementById('overtimeWrap').style.display === '' &&
    doc.getElementById('reportWrap').style.display === 'none' &&
    doc.getElementById('projectsWrap').style.display === 'none');

  const bar  = doc.getElementById('quickRanges');
  const note = doc.getElementById('otwRangeNote');
  assert('the quick-range bar switches to naming the week', bar.classList.contains('otw-mode'));
  assert('  its range buttons are hidden — they would change nothing here',
    [...bar.querySelectorAll(':scope > .qr-btn')].every(b => win.getComputedStyle(b).display === 'none'));
  assert('  the note is shown in their place', win.getComputedStyle(note).display === 'flex');
  const noteText = note.textContent.replace(/\s+/g, ' ').trim();
  assert('  and says which week, and that the dates above do not apply',
    noteText.startsWith('Week: ') &&
    noteText.includes(win.eval(`prettyDateShort('${MON}')`)) &&
    noteText.includes(win.eval(`prettyDateShort('${SUN}')`)) &&
    /From and To dates above apply to Employees and Projects/.test(noteText), noteText);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[the table]');
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = readReport(doc);
  assert('the columns are the ones asked for, in reading order',
    JSON.stringify(r.heads) === JSON.stringify(
      ['Employee', 'Approved Hrs', 'Pending Hrs', 'Hours Worked', 'Hours Left Until OT', 'OT Hrs', 'Status']),
    JSON.stringify(r.heads));
  assert('one row per person with time this week',
    r.rows.length === 6, r.rows.map(x => x.name).join(', '));
  assert('closest to overtime first',
    r.rows.map(x => x.name).join(',') === 'ava,ben,dee,cal,eli,fay', r.rows.map(x => x.name).join(','));

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
  assert('the name carries the divisions worked, for a company-wide list',
    /Paving, Turf · 4 days worked this week/.test(by.ben.nameTitle), by.ben.nameTitle);

  assert('the totals row adds the people up',
    r.foot[0] === 'Totals (6 employees)' &&
    near(r.foot[1], 165.5) && near(r.foot[2], 22) && near(r.foot[3], 187.5) &&
    near(r.foot[4], 60.5) && near(r.foot[5], 8), JSON.stringify(r.foot));
  assert('  and counts the standings', r.foot[6] === '2 in overtime · 2 near', r.foot[6]);
  assert('the totals row spans every column', r.foot.length === r.heads.length);

  const tile = l => r.tiles.find(t => t.label === l) || {};
  assert('tiles: 6 employees, 2 in overtime, 2 near it, 22.00 pending',
    tile('Employees').value === '6' && tile('In Overtime').value === '2' &&
    tile('Near Overtime').value === '2' && tile('Pending Hours').value === '22.00',
    JSON.stringify(r.tiles));
  assert('  the overtime tile is orange and the near tile amber when there are any',
    / ot\b/.test(tile('In Overtime').cls) && / near\b/.test(tile('Near Overtime').cls));

  assert('the head names the report and the week',
    r.text.includes('Weekly Overtime Report') &&
    r.text.includes(`This week · ${win.eval(`prettyDate('${MON}')`)} – ${win.eval(`prettyDate('${SUN}')`)}`) &&
    r.text.includes('Force Corp') && /As of /.test(r.text), r.text.slice(0, 240));
  assert('the note under the table states the rule',
    /Overtime is anything past 40 hours in the Monday–Sunday week/.test(r.text) &&
    /pending days included/.test(r.text) && /Paid time off does not count toward the 40/.test(r.text));
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
  const weekLoads  = fresh.filter(isWeek);
  const rangeLoads = fresh.filter(u => !isWeek(u));
  assert('Apply reloads the week AND the range', weekLoads.length === 1 && rangeLoads.length === 1, fresh.join(' | '));
  assert('  the week load still carries no division', weekLoads[0] && !params(weekLoads[0]).has('division'), weekLoads[0]);
  assert('  while the range load is filtered to Paving, as before',
    rangeLoads[0] && params(rangeLoads[0]).get('division') === 'paving', rangeLoads[0]);

  let r = readReport(doc);
  assert('Division = Paving lists the two people with Paving time',
    r.rows.map(x => x.name).join(',') === 'ava,ben', r.rows.map(x => x.name).join(','));
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
  assert('Supervisor "jones" lists everyone with a day under Jones',
    r.rows.map(x => x.name).join(',') === 'ben,cal,fay', r.rows.map(x => x.name).join(','));
  assert('  ben with his whole week, the Paving days under Smith included',
    near((r.rows.find(x => x.name === 'ben') || {}).worked, 42));
  assert('  the head says so', /Listing: supervisor "jones"/.test(r.text));
  sup.value = '';
  sup.dispatchEvent(new win.Event('input'));

  const usr = doc.getElementById('flt-user');
  usr.value = 'A';
  usr.dispatchEvent(new win.Event('input'));
  r = readReport(doc);
  assert('Employee "A" matches by name, any case',
    r.rows.map(x => x.name).join(',') === 'ava,cal,fay', r.rows.map(x => x.name).join(','));
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
console.log('\n[moving between sub-tabs and tabs]');
// ─────────────────────────────────────────────────────────────────────────────
{
  before = listUrls(state).length;
  doc.getElementById('rst-employees').click();
  await settle();
  const bar = doc.getElementById('quickRanges');
  assert('back on Employees, the range buttons return',
    !bar.classList.contains('otw-mode') &&
    [...bar.querySelectorAll(':scope > .qr-btn')].every(b => win.getComputedStyle(b).display !== 'none'));
  assert('  and the week note goes', doc.getElementById('otwRangeNote').innerHTML === '' &&
    win.getComputedStyle(doc.getElementById('otwRangeNote')).display === 'none');
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
  assert('coming back to Reports reopens it on Overtime',
    doc.getElementById('overtimeWrap').style.display === '' &&
    doc.getElementById('quickRanges').classList.contains('otw-mode'));
  assert('  and reloads the week', listUrls(state).slice(before).filter(isWeek).length === 1,
    listUrls(state).slice(before).join(' | '));
  assert('  back to the full table', readReport(doc).rows.length === 6);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[it keeps its own counsel about what counts]');
// ─────────────────────────────────────────────────────────────────────────────
{
  state.leak = true;          // the server sends last week's row and a draft
  win.eval('loadOvertimeWeek()');
  await settle();
  const r  = readReport(doc);
  const by = Object.fromEntries(r.rows.map(x => [x.name, x]));
  assert('a row from last week is not counted in this one (ava stays 46)', near((by.ava || {}).worked, 46));
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

  // The range load failing is a fact about the RANGE. This week's rows are
  // their own fetch; they stay on screen.
  state.fail = u => !isWeek(u.pathname + u.search);
  doc.querySelector('.btn-filter').click();
  await settle();
  r = readReport(doc);
  assert('a failed range load leaves this week\'s report standing', r.rows.length === 6, r.text.slice(0, 200));
  assert('  while the stat strip still blanks for the range that failed',
    doc.getElementById('stat-submitted').textContent === '—');
  state.fail = null;
  doc.querySelector('.btn-filter').click();
  await settle();
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
  let names = readReport(doc).rows.map(x => x.name).join(',');
  assert('the newer load draws', names === 'zed', names);
  a.release({ entries: WEEK });
  await settle();
  names = readReport(doc).rows.map(x => x.name).join(',');
  assert('the older one, landing late, is dropped', names === 'zed', names);
  const zed = readReport(doc).rows[0] || {};
  assert('  (zed: 50 worked, 10 over, nothing left)', near(zed.worked, 50) && near(zed.ot, 10) && near(zed.left, 0));
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
  // Rows still in memory from last week, and a keystroke re-draws them: the
  // head must not call them "this week".
  win.eval(`otwScope = { from: '${LAST_MON}', to: '${LAST_SUN}', at: new Date() }; otwEntries = [];
            renderOvertimeReport();`);
  const t = readReport(doc).text;
  assert('the head names the week rather than calling it this week',
    t.includes(`Week · ${win.eval(`prettyDate('${LAST_MON}')`)}`) && !t.includes('This week ·'), t.slice(0, 200));
  win.eval(`otwEntries = ${JSON.stringify([E(70, 'old', -7, 45)])}; renderOvertimeReport();`);
  const t2 = readReport(doc).text;
  assert('  and says a new week has started', /A new week has started since these hours were loaded/.test(t2), t2.slice(-200));
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
  const r = readReport(doc);
  assert('says no time is in yet, and that everyone has the full 40',
    /No time has been submitted for this week yet — everyone has the full 40 hours before overtime/.test(r.text), r.text);
  assert('  with nothing to export', r.excel && r.excel.disabled);
  state.rows = WEEK.slice();
  win.eval('loadOvertimeWeek()');
  await settle();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Export to Excel]');
// ─────────────────────────────────────────────────────────────────────────────
{
  win.downloadBlob = (name, blob) => state.downloads.push({ name, blob });
  readReport(doc).excel.click();
  const d = state.downloads[0] || {};
  assert('downloads one workbook, named for the week it holds — not the boxes',
    state.downloads.length === 1 && d.name === `weekly-overtime-FCT-${MON}_${SUN}.xlsx`, d.name);
  assert('  as an .xlsx blob', d.blob && /spreadsheetml/.test(d.blob.type), d.blob && d.blob.type);

  const xml = win.eval('overtimeWeekSheetXml(buildOvertimeWeekModel())');
  const sheet = new win.DOMParser().parseFromString(xml, 'application/xml');
  assert('the sheet is well-formed XML', !sheet.getElementsByTagName('parsererror').length);
  const cellsOf = r => [...r.getElementsByTagName('c')].map(c => {
    const t = c.getElementsByTagName('t')[0], v = c.getElementsByTagName('v')[0];
    return t ? t.textContent : v ? Number(v.textContent) : '';
  });
  const rows = [...sheet.getElementsByTagName('row')].map(cellsOf);
  assert('it opens with the title and the week',
    rows[0][0] === 'Weekly Overtime Report' && rows[1][0] === 'Force Corp' && /^This week · /.test(rows[2][0]));
  assert('the header row is the table\'s columns',
    JSON.stringify(rows[6]) === JSON.stringify(['Employee', 'Approved Hrs', 'Pending Hrs',
      'Hours Worked (approved + pending)', 'Hours Left Until OT (40 − worked)', 'OT Hrs (past 40)', 'Status']),
    JSON.stringify(rows[6]));
  assert('one row per person, in the order on screen',
    rows.slice(7, 13).map(r => r[0]).join(',') === 'ava,ben,dee,cal,eli,fay', rows.slice(7, 13).map(r => r[0]).join(','));
  assert('ava\'s figures are numbers, not text: 40 · 6 · 46 · 0 · 6 · Overtime',
    JSON.stringify(rows[7]) === JSON.stringify(['ava', 40, 6, 46, 0, 6, 'Overtime']), JSON.stringify(rows[7]));
  assert('the totals row matches the screen',
    JSON.stringify(rows[13]) === JSON.stringify(['Totals (6 employees)', 165.5, 22, 187.5, 60.5, 8, '2 in overtime · 2 near']),
    JSON.stringify(rows[13]));
  assert('the header is frozen and filterable', /ySplit="7"/.test(xml) && /<autoFilter ref="A7:G13"\/>/.test(xml));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[the other sub-tabs still read the range]');
// ─────────────────────────────────────────────────────────────────────────────
{
  doc.getElementById('rst-projects').click();
  await settle();
  assert('Projects draws from the range load, with Overtime put away',
    doc.getElementById('projectsWrap').style.display === '' &&
    doc.getElementById('overtimeWrap').style.display === 'none' &&
    !doc.getElementById('quickRanges').classList.contains('otw-mode'));
  assert('nothing threw along the way', state.errors.length === 0, state.errors[0]);
}

dom.window.close();
console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
