#!/usr/bin/env node
'use strict';
/**
 * The Scheduler's Records tab: the archive behind the two boards.
 *
 * Run: node scripts/test-sched-records.js
 *
 * Records is the third sub-tab under Scheduler. It flattens every assignment
 * either board has ever carried into one table for a date range, joins the
 * driver reports back onto it, and downloads the result as a workbook. Three
 * things have to hold for that to be worth pulling records from:
 *
 *   1. The rows are the boards' own rows. Nothing invented, nothing dropped —
 *      including a report whose assignment has since been deleted, which is
 *      still a record of work someone did.
 *   2. What the filters, the totals and the download see is the same set. A
 *      workbook that disagrees with the screen is worse than no workbook.
 *   3. The workbook is a real .xlsx. It is written by hand — no libraries on
 *      the page — so the archive is unzipped here, every part is parsed as
 *      XML, and the cells are read back and compared against the rows.
 *
 * Three layers:
 *   1. Behavioural — trucking.html's own record functions in a vm, over
 *      boards built to sit either side of every edge of the rules.
 *   2. Workbook    — the bytes schedRecXlsx() produces, unzipped, CRC-checked,
 *      XML-parsed and read cell by cell.
 *   3. Wiring      — the sub-tab, the panel, and the guards that stop a board
 *      being drawn into while Records is the one on screen.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

/* The download test clicks a real <a download>. jsdom has no navigation, and
   says so loudly; the click is the only thing under test, so the noise goes. */
const quiet = () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  return vc;
};

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
function eq(label, got, want) {
  assert(label, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
function slice(src, from, to, label) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : to})`);
  return src.slice(a, b);
}

const TRUCKING = read('trucking.html');

// Everything Records is built out of, taken from the page rather than copied:
// the boards and their state, the date helpers, the truck types the Truck Type
// column reads, the division labels, the OOXML writer, and Records itself.
const BOARDS  = slice(TRUCKING, '    const SCHED_BOARDS = [', '    function schedMerge(baseStr', 'boards + helpers');
const TYPES   = slice(TRUCKING, '    /* ── What kind of truck a unit is ──',
                                '    /** The dismissed sign-ins', 'unit types');
const GROUPS  = slice(TRUCKING, '    const SCHED_GROUPS = [', '    /* ═══════ Dispatch sheet', 'grouping + schedNum');
const XLSX    = slice(TRUCKING, '    function _crc32(bytes)', '    function schedSheetXlsx(date)', 'ooxml writer');
const DIVS    = slice(TRUCKING, '    const SCHED_DIVISIONS = [', '    const schedJobsCache', 'divisions');
const JOBOF   = slice(TRUCKING, '    function schedJobOf(a)', '    /** Layout A — by day.', 'job/division labels');
const HOURS   = slice(TRUCKING, '    /** Decimal hours between two HH:MM times',
                                '    /** "24.5 t · 3 loads', 'dispatch-sheet hours');
const DELETE  = slice(TRUCKING, '    function schedDeleteEditor()',
                                '    /* ═══════════════════════════════════════════\n       SCHEDULER RECORDS',
                                'delete + archive');
const RECORDS = slice(TRUCKING, '    /* ═══════════════════════════════════════════\n       SCHEDULER RECORDS',
                                '    /* ═══════════════════════════════════════════\n       CSV UPLOAD', 'records tab');

/* A `const` at the top of a vm script is a lexical binding, not a property of
   the context — so the few the tests reach for are handed out explicitly. */
const EXPORTS = [
  'schedRec', 'SCHED_REC_COLS', 'SCHED_REC_STATUSES', 'SCHED_REC_PRESETS',
  'SCHED_BOARDS', '_schedStates', 'SCHED_REC_STUCK', 'SCHED_REC_COLLATOR', 'SCHED_REC_NO_REPORTS',
].map(n => `globalThis.${n} = ${n};`).join('\n')
  // schedView is a `let`, so the tests get a door to it rather than reaching in.
  + '\nglobalThis.__setView = v => { schedView = v; };'
  + '\nglobalThis.__setCtx  = v => { schedCtx  = v; };';

/** trucking.html's Records tab, over boards and reports handed in. */
function page(opts) {
  const o = opts || {};
  const marked = [];
  const sandbox = {
    console, TextEncoder, TextDecoder, Uint8Array, DataView, Map, Set, Date, Math, JSON, Intl, isFinite, Number, String,
    _remKey: v => String(v == null ? '' : v).trim(),
    divTruckLists: { drivers: [], customers: [], units: o.units || [], materials: [], locations: [] },
    // Records never touches the DOM in these tests; the stubs are here so a
    // stray lookup fails loudly rather than blowing up the whole run.
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    API_BASE: '/api',
    token: 'test',
    user: { username: 'bhudock' },
    fetch: () => Promise.reject(new Error('no network in tests')),
    // The delete path's neighbours. Records must not need them; a call to one
    // is recorded so the tests can say what the delete actually did.
    marked,
    schedMarkDirty:  b => marked.push(b),
    schedCloseEditor: () => {},
    renderScheduler:  () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext([BOARDS, TYPES, GROUPS, DIVS, JOBOF, HOURS, XLSX, DELETE, RECORDS, EXPORTS].join('\n'),
    sandbox, { filename: 'trucking.html' });

  Object.keys(o.assignments || {}).forEach(board => {
    const st = sandbox._schedStates[board];
    st.assignments = o.assignments[board];
    st.loaded = true;
  });
  (o.reports || []).forEach(r => sandbox.schedRec.reports.set(r.assignment_id, r));
  sandbox.schedRec.from = o.from || '2026-01-01';
  sandbox.schedRec.to   = o.to   || '2026-12-31';
  // The map only answers for the range it was fetched for, so the fixture has
  // to claim the range it is standing in for.
  if (o.reports) sandbox.schedRec.reportsRange = sandbox.schedRec.from + '..' + sandbox.schedRec.to;
  return sandbox;
}

const A = (id, extra) => Object.assign({
  id, driver: 'Barr, Michael', division: 'trucking', project: 'Acme Materials',
  unit: '2757', material: 'Stone', start: '06:00', end: '14:00', notes: '', address: '', location: '',
}, extra || {});

/* ══════════════════════════════════════════════════════════════════════════
   1. HOURS AND RATES
   The numbers the whole tab is totalled on.
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── Hours and rates ──');
{
  const p = page({});
  eq('a plain day is its span',            p.schedRecHours('06:00', '14:30'), 8.5);
  eq('a night haul runs past midnight',    p.schedRecHours('22:00', '06:00'), 8);
  eq('end equal to start reads as a full day', p.schedRecHours('06:00', '06:00'), 24);
  eq('no end time is no figure',           p.schedRecHours('06:00', ''), '');
  eq('no start time is no figure',         p.schedRecHours('', '14:00'), '');
  eq('an unparseable time is no figure',   p.schedRecHours('6am', '2pm'), '');
  // The dispatch sheet's own hours function has to agree, or the sheet and the
  // archive would report a different day for the same haul.
  eq('agrees with the dispatch sheet',
    String(p.schedRecHours('22:00', '06:00').toFixed(2)), p.schedHoursBetween('22:00', '06:00'));

  eq('a figure comes through as a number',  p.schedRecFigure('96.5'), 96.5);
  eq('a blank figure stays blank',          p.schedRecFigure(null), '');
  eq('and so does one that is not a number', p.schedRecFigure('n/a'), '');

  eq('tons an hour',                       p.schedRecRate(100, 8), 12.5);
  eq('no rate without hours',              p.schedRecRate(100, ''), '');
  eq('no rate without tons',               p.schedRecRate('', 8), '');
  eq('no rate over zero hours',            p.schedRecRate(100, 0), '');
}

/* ══════════════════════════════════════════════════════════════════════════
   2. THE ROWS
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── The rows ──');
{
  const p = page({
    from: '2026-03-02', to: '2026-03-06',
    units: [{ name: '2757', type: 'triaxle' }, { name: 'LB-1', type: 'lowboy' }],
    assignments: {
      trucking: {
        '2026-03-01': [A('before')],                                  // a day early
        '2026-03-02': [A('t1'), A('t2', { driver: 'Kirk, Dan', unit: 'LB-1' })],
        '2026-03-06': [A('t3')],
        '2026-03-07': [A('after')],                                   // a day late
      },
      labor: { '2026-03-03': [A('l1', { driver: 'Glatt, Shane' })] },
    },
    reports: [
      { assignment_id: 't1', work_date: '2026-03-02', driver_name: 'Barr, Michael',
        tons: 96, loads: 4, actual_start: '06:05', actual_end: '14:20', tickets: 'T-1,T-2', notes: 'ran late' },
      // Reported against an assignment nobody deleted — but on a board day
      // outside the range, so it must not conjure a row of its own.
      { assignment_id: 'after', work_date: '2026-03-07', driver_name: 'Barr, Michael', tons: 10, loads: 1 },
      // The assignment behind this one is gone. The work still happened.
      { assignment_id: 'ghost', work_date: '2026-03-04', driver_name: 'Deemer Jr, Tracy',
        tons: 22.5, loads: 1, actual_start: '07:00', actual_end: '12:00', tickets: 'T-9', notes: 'gravel' },
    ],
  });

  const rows = p.schedRecBuild();
  const ids  = rows.map(r => r.id).sort();
  assert('only the range is built', JSON.stringify(ids) === JSON.stringify(['ghost', 'l1', 't1', 't2', 't3']),
    JSON.stringify(ids));

  const t1 = rows.find(r => r.id === 't1');
  eq('carries the board it came off',   t1.board, 'Trucking');
  eq('board id drives the board filter', t1.boardId, 'trucking');
  eq('the division reads as a label',   t1.division, 'Trucking');
  eq('the job comes off the assignment', t1.project, 'Acme Materials');
  eq('the truck type is the one set on the unit', t1.unitType, 'Tri-Axle');
  eq('scheduled hours',                 t1.planHrs, 8);
  eq('actual hours off the report',     t1.actHrs, 8.25);
  eq('tons off the report',             t1.tons, 96);
  eq('tons an hour is the actual rate', t1.tph, 11.64);
  eq('a reported haul says so',         t1.status, 'Reported');
  eq('the driver note is the driver\'s', t1.driverNotes, 'ran late');

  const t3 = rows.find(r => r.id === 't3');
  eq('an unreported haul is Planned',   t3.status, 'Planned');
  eq('and carries no actuals',          t3.actHrs, '');
  eq('and no rate',                     t3.tph, '');

  const l1 = rows.find(r => r.id === 'l1');
  eq('the labor board is folded in',    l1.board, 'Labor');

  // A figure the endpoint could not make a number of must not poison a total.
  {
    const junk = page({
      from: '2026-03-02', to: '2026-03-02',
      assignments: { trucking: { '2026-03-02': [A('j1'), A('j2', { driver: 'Kirk, Dan' })] } },
      reports: [
        { assignment_id: 'j1', work_date: '2026-03-02', tons: 'n/a', loads: null,
          actual_start: '06:00', actual_end: '14:00' },
        { assignment_id: 'j2', work_date: '2026-03-02', tons: 40, loads: 2,
          actual_start: '06:00', actual_end: '14:00' },
      ],
    });
    const t = junk.schedRecTotals(junk.schedRecBuild());
    eq('a junk figure is dropped, not added', t.tons, 40);
    assert('and the total is still a number', isFinite(t.tons) && isFinite(t.loads));
    eq('and its cell reads empty', junk.schedRecText(junk.schedRecBuild().find(r => r.id === 'j1'), 'tons'), '');
  }

  const gh = rows.find(r => r.id === 'ghost');
  eq('a report with no assignment is kept', gh.status, 'Report only');
  eq('under no board',                  gh.board, '—');
  eq('with the driver who filed it',    gh.driver, 'Deemer Jr, Tracy');
  eq('and its figures',                 gh.tons, 22.5);
  eq('and no scheduled hours',          gh.planHrs, '');

  assert('a report against an out-of-range assignment makes no row',
    !rows.some(r => r.id === 'after'));

  // "No assignment anywhere" is a claim about both boards. While one of them
  // is missing, every haul it holds would look like a deleted one.
  p._schedStates.labor.loaded = false;
  assert('nothing is called Report only while a board is still missing',
    !p.schedRecBuild().some(r => r.status === 'Report only'),
    JSON.stringify(p.schedRecBuild().map(r => r.id + ':' + r.status)));
  p._schedStates.labor.loaded = true;
  assert('and it comes back once that board is in',
    p.schedRecBuild().some(r => r.id === 'ghost'));

  // The type a unit's NAME gives away still stands in when nobody typed one.
  const p2 = page({
    from: '2026-03-02', to: '2026-03-02', units: [],
    assignments: { trucking: { '2026-03-02': [A('g1', { unit: 'Lowboy 4' })] } },
  });
  eq('an untyped unit falls back to its name', p2.schedRecBuild()[0].unitType, 'Lowboy');
}

/* ══════════════════════════════════════════════════════════════════════════
   3. FILTERS
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── Filters ──');
{
  const build = () => page({
    from: '2026-03-01', to: '2026-03-31',
    units: [{ name: '2757', type: 'triaxle' }],
    assignments: {
      trucking: { '2026-03-02': [
        A('a', { driver: 'Barr, Michael', material: 'Stone' }),
        A('b', { driver: 'Kirk, Dan', material: 'Millings', project: 'Route 22 Paving' }),
      ] },
      labor: { '2026-03-03': [A('c', { driver: 'Glatt, Shane', division: 'paving' })] },
    },
    reports: [{ assignment_id: 'a', work_date: '2026-03-02', tons: 50, loads: 2,
                actual_start: '06:00', actual_end: '14:00' }],
  });

  let p = build();
  const idsOf = () => p.schedRecFilter(p.schedRecBuild()).map(r => r.id).sort().join(',');

  eq('nothing set shows everything', idsOf(), 'a,b,c');

  p.schedRec.board = 'labor';
  eq('the board filter narrows to one board', idsOf(), 'c');
  p.schedRec.board = 'all';

  p.schedRec.status = 'Reported';
  eq('the status filter finds the reported haul', idsOf(), 'a');
  p.schedRec.status = 'all';

  p.schedRec.col.driver = 'kirk';
  eq('a column filter is case-insensitive', idsOf(), 'b');
  p.schedRec.col.driver = '';

  p.schedRec.col.material = 'mill';
  eq('a column filter matches part of a word', idsOf(), 'b');
  p.schedRec.col = {};

  p.schedRec.q = 'route 22';
  eq('the search box reaches every column', idsOf(), 'b');
  p.schedRec.q = '';

  // The filters read what the screen reads, not the stored value: the start
  // time shows as 6a, and typing 6a has to find it.
  p.schedRec.q = '6a';
  assert('the search matches the printed time, not the stored one', idsOf().includes('a'));
  p.schedRec.q = '';

  p.schedRec.col.driver = 'kirk';
  p.schedRec.col.material = 'stone';
  eq('two column filters are an AND', idsOf(), '');
  p.schedRec.col = {};

  p.schedRec.q = 'zzz';
  eq('a search that matches nothing shows nothing', idsOf(), '');
}

/* ══════════════════════════════════════════════════════════════════════════
   4. SORT AND TOTALS
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── Sort and totals ──');
{
  const p = page({
    from: '2026-03-01', to: '2026-03-31',
    assignments: { trucking: { '2026-03-02': [
      A('hi',    { driver: 'Zeller, Amy' }),
      A('lo',    { driver: 'Abbott, Rae' }),
      A('blank', { driver: 'Meyer, Sam' }),
    ] } },
    reports: [
      { assignment_id: 'hi', work_date: '2026-03-02', tons: 90, loads: 3, actual_start: '06:00', actual_end: '15:00' },
      { assignment_id: 'lo', work_date: '2026-03-02', tons: 10, loads: 1, actual_start: '06:00', actual_end: '11:00' },
    ],
  });
  const order = () => p.schedRecSort(p.schedRecBuild()).map(r => r.id).join(',');

  p.schedRec.sort = { key: 'tons', dir: 'desc' };
  eq('biggest tons first, blanks last', order(), 'hi,lo,blank');
  p.schedRec.sort = { key: 'tons', dir: 'asc' };
  eq('smallest tons first, blanks still last', order(), 'lo,hi,blank');

  p.schedRec.sort = { key: 'driver', dir: 'asc' };
  eq('drivers A–Z', order(), 'lo,blank,hi');
  p.schedRec.sort = { key: 'driver', dir: 'desc' };
  eq('drivers Z–A', order(), 'hi,blank,lo');

  // One day, one start time: the tie-break carries it, and it ends on the
  // driver's name so the order is the same on every reload.
  p.schedRec.sort = { key: 'date', dir: 'desc' };
  eq('a tie falls back to a stable order', order(), 'lo,blank,hi');

  const t = p.schedRecTotals(p.schedRecBuild());
  eq('records counted',  t.rows, 3);
  eq('drivers counted',  t.drivers.size, 3);
  eq('days counted',     t.days.size, 1);
  eq('scheduled hours summed', t.planHrs, 24);
  eq('actual hours summed',    t.actHrs, 14);
  eq('tons summed',      t.tons, 100);
  eq('loads summed',     t.loads, 4);
  eq('reported counted', t.reported, 2);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. RANGE PRESETS
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── Range presets ──');
{
  const p = page({
    assignments: {
      trucking: { '2024-11-04': [A('old')], '2026-05-20': [A('ahead')] },
      labor:    { '2025-06-01': [A('mid')] },
    },
  });
  const span = p.schedRecSpan();
  eq('the span starts at the earliest day on either board', span.lo, '2024-11-04');
  eq('and ends at the latest',                              span.hi, '2026-05-20');

  p.schedRecApplyPreset('all');
  eq('all time starts there', p.schedRec.from, '2024-11-04');
  assert('all time runs to the last scheduled day when work is booked ahead',
    p.schedRec.to === '2026-05-20' || p.schedRec.to >= p.schedTodayStr(), p.schedRec.to);

  p.schedRecApplyPreset('30');
  eq('last 30 days is thirty days', Math.round(
    (new Date(p.schedRec.to + 'T12:00:00') - new Date(p.schedRec.from + 'T12:00:00')) / 86400000) + 1, 30);
  eq('and ends today', p.schedRec.to, p.schedTodayStr());

  p.schedRecApplyPreset('lastm');
  const lm = new Date(p.schedRec.from + 'T12:00:00');
  eq('last month starts on the 1st', lm.getDate(), 1);
  const lmEnd = new Date(p.schedRec.to + 'T12:00:00');
  eq('and ends on the last day of that month',
    new Date(lmEnd.getFullYear(), lmEnd.getMonth() + 1, 0).getDate(), lmEnd.getDate());
  assert('and is one month long', lm.getMonth() === lmEnd.getMonth());

  p.schedRecApplyPreset('ytd');
  eq('this year starts on Jan 1', p.schedRec.from.slice(5), '01-01');

  // A board with nothing on it must still produce a range worth fetching.
  const empty = page({});
  empty.schedRecApplyPreset('all');
  assert('all time on an empty board still has a range',
    /^\d{4}-\d{2}-\d{2}$/.test(empty.schedRec.from) && empty.schedRec.from < empty.schedRec.to);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. THE WORKBOOK
   Written by hand, so it is taken apart here the way Excel would.
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── The workbook ──');

function crc32(bytes) {
  let c, crc = 0xFFFFFFFF;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Read a stored (uncompressed) ZIP the way a reader does: off the central
 *  directory, checking each entry's CRC against its bytes. */
function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('bad central directory header');
    const method = dv.getUint16(off + 10, true);
    const crc    = dv.getUint32(off + 16, true);
    const usize  = dv.getUint32(off + 24, true);
    const nlen   = dv.getUint16(off + 28, true);
    const elen   = dv.getUint16(off + 30, true);
    const clen   = dv.getUint16(off + 32, true);
    const lho    = dv.getUint32(off + 42, true);
    const name   = new TextDecoder().decode(bytes.slice(off + 46, off + 46 + nlen));
    if (method !== 0) throw new Error('unexpected compression in ' + name);
    if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const data  = bytes.slice(start, start + usize);
    if (crc32(data) !== crc) throw new Error('CRC mismatch on ' + name);
    out[name] = new TextDecoder().decode(data);
    off += 46 + nlen + elen + clen;
  }
  return out;
}

function parseXml(xml, label) {
  const dom = new JSDOM(xml, { contentType: 'application/xml' });
  const err = dom.window.document.querySelector('parsererror');
  if (err) throw new Error(label + ' is not well-formed XML: ' + err.textContent.slice(0, 200));
  return dom.window.document;
}

{
  const p = page({
    from: '2026-03-02', to: '2026-03-06',
    units: [{ name: '2757', type: 'triaxle' }],
    assignments: {
      trucking: { '2026-03-02': [
        A('x1', { notes: 'gate code 4 & <b>call</b> ahead' }),
        A('x2', { driver: 'Kirk, Dan', material: 'Millings', start: '13:00', end: '' }),
      ] },
      labor: { '2026-03-05': [A('x3', { driver: 'Glatt, Shane', division: 'paving', project: 'Route 22' })] },
    },
    reports: [{ assignment_id: 'x1', work_date: '2026-03-02', tons: 96, loads: 4,
                actual_start: '06:05', actual_end: '14:20', tickets: 'T-1', notes: 'ok' }],
  });

  const rows  = p.schedRecView();
  const bytes = p.schedRecXlsx(rows);
  assert('the workbook is bytes', bytes instanceof Uint8Array && bytes.length > 800, String(bytes && bytes.length));

  let files;
  try { files = unzip(bytes); assert('it unzips, every part CRC-clean', true); }
  catch (err) { assert('it unzips, every part CRC-clean', false, err.message); files = {}; }

  const want = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'];
  want.forEach(n => assert('carries ' + n, Object.prototype.hasOwnProperty.call(files, n)));

  let ok = true;
  Object.keys(files).forEach(n => {
    try { parseXml(files[n], n); } catch (err) { ok = false; assert('XML: ' + n, false, err.message); }
  });
  assert('every part parses as XML', ok);

  // Every part the content types promise is really in the archive, and every
  // sheet the workbook names is really related to a part. A workbook that
  // names a sheet it does not ship is the one thing Excel refuses outright.
  const ct = parseXml(files['[Content_Types].xml'], 'content types');
  const overrides = [...ct.getElementsByTagName('Override')].map(o => o.getAttribute('PartName'));
  assert('every content-type override points at a part in the archive',
    overrides.every(pn => files[pn.replace(/^\//, '')] !== undefined), overrides.join(' '));

  const wb = parseXml(files['xl/workbook.xml'], 'workbook');
  const sheets = [...wb.getElementsByTagName('sheet')];
  eq('two sheets', sheets.length, 2);
  eq('named Records', sheets[0].getAttribute('name'), 'Records');
  eq('and Summary',   sheets[1].getAttribute('name'), 'Summary');
  const rels = parseXml(files['xl/_rels/workbook.xml.rels'], 'workbook rels');
  const byId = {};
  [...rels.getElementsByTagName('Relationship')].forEach(r => { byId[r.getAttribute('Id')] = r.getAttribute('Target'); });
  assert('each sheet resolves to a worksheet part',
    sheets.every(s => files['xl/' + byId[s.getAttribute('r:id')]] !== undefined));
  assert('the styles part is related too',
    Object.values(byId).some(t => t === 'styles.xml'));

  // The styles the sheets reference have to exist, or Excel repairs the file.
  const st = parseXml(files['xl/styles.xml'], 'styles');
  const xfCount = st.getElementsByTagName('cellXfs')[0].getElementsByTagName('xf').length;
  const usedStyles = new Set();
  ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].forEach(n => {
    (files[n].match(/ s="(\d+)"/g) || []).forEach(m => usedStyles.add(Number(m.match(/\d+/)[0])));
  });
  assert('every style a cell asks for is defined',
    [...usedStyles].every(i => i < xfCount), `used ${[...usedStyles].join(',')} of ${xfCount}`);

  /* ── Sheet 1, cell by cell ── */
  const s1 = parseXml(files['xl/worksheets/sheet1.xml'], 'sheet1');
  const cellsOf = doc => {
    const m = {};
    [...doc.getElementsByTagName('c')].forEach(c => {
      const t = c.getElementsByTagName('t')[0];
      const v = c.getElementsByTagName('v')[0];
      m[c.getAttribute('r')] = { text: t ? t.textContent : (v ? v.textContent : ''),
                                 num: v ? Number(v.textContent) : null,
                                 s: c.getAttribute('s') };
    });
    return m;
  };
  const c1 = cellsOf(s1);
  const NCOL = p.SCHED_REC_COLS.length;
  const LAST = p._colName(NCOL - 1);
  eq('the first heading is the board',   c1.A1.text, 'Board');
  eq('the second is the date',           c1.B1.text, 'Date');
  eq('the last is the record id',        c1[LAST + '1'].text, 'Record ID');

  const dataRows = [...s1.getElementsByTagName('row')].length - 1;
  eq('a row per record', dataRows, rows.length);
  eq('three records in this range', rows.length, 3);

  // The date column is a real date, not the text of one — that is what an
  // Excel date filter needs to see. Checked against days Excel's own epoch is
  // known to number, so a slip in the epoch cannot pass by agreeing with
  // itself.
  eq('the epoch matches Excel at the 1900 leap-year fudge', p._xlsxSerial('1900-03-01'), 61);
  eq('and at the turn of the century',                      p._xlsxSerial('2000-01-01'), 36526);
  eq('a bad date writes no serial',                         p._xlsxSerial('not a date'), null);
  const rxDate = rows.findIndex(r => r.id === 'x1') + 2;
  eq('the date is written as a number', c1['B' + rxDate].num, p._xlsxSerial('2026-03-02'));
  eq('and carries the date format',     c1['B' + rxDate].s, '2');

  // The header freezes and the auto-filter is switched on across the sheet —
  // "filters on" is the point of the download.
  assert('the header row is frozen', /<pane[^>]+state="frozen"/.test(files['xl/worksheets/sheet1.xml']));
  const af = s1.getElementsByTagName('autoFilter')[0];
  assert('an auto-filter is set', !!af);
  eq('over the header and every row', af && af.getAttribute('ref'), 'A1:' + LAST + (rows.length + 1));
  assert('autoFilter is written after sheetData, where the schema wants it',
    files['xl/worksheets/sheet1.xml'].indexOf('</sheetData>') <
    files['xl/worksheets/sheet1.xml'].indexOf('<autoFilter'));
  assert('and Excel is told the filter range',
    /_xlnm\._FilterDatabase/.test(files['xl/workbook.xml']) &&
    files['xl/workbook.xml'].includes(`'Records'!$A$1:$${LAST}$${rows.length + 1}`),
    files['xl/workbook.xml'].slice(-320));

  // A column is written for exactly the columns there are.
  eq('a width per column', [...s1.getElementsByTagName('col')].length, NCOL);

  // What the screen says and what the cell says are the same thing.
  const rowOf = id => rows.findIndex(r => r.id === id) + 2;
  const rx1 = rowOf('x1');
  eq('the driver cell matches the row',  c1['D' + rx1].text, 'Barr, Michael');
  eq('the truck type is carried',        c1['K' + rx1].text, 'Tri-Axle');
  eq('scheduled hours are a number',     c1['N' + rx1].num, 8);
  eq('actual hours are a number',        c1['Q' + rx1].num, 8.25);
  eq('tons are a number',                c1['R' + rx1].num, 96);
  eq('loads are a whole number',         c1['S' + rx1].num, 4);
  eq('tons an hour is carried',          c1['T' + rx1].num, 11.64);
  eq('the times read as they do on screen', c1['L' + rx1].text, '6a');

  // Markup in a note is text in the workbook, not markup.
  assert('an ampersand and a tag survive as text',
    c1['V' + rx1].text === 'gate code 4 & <b>call</b> ahead', c1['V' + rx1].text);
  assert('and are escaped in the XML',
    /gate code 4 &amp; &lt;b&gt;call&lt;\/b&gt; ahead/.test(files['xl/worksheets/sheet1.xml']));

  const rx2 = rowOf('x2');
  assert('a haul with no end time writes no scheduled hours', !c1['N' + rx2], JSON.stringify(c1['N' + rx2]));
  assert('and no actuals',                                    !c1['Q' + rx2]);

  /* ── Sheet 2, the rollups ── */
  const s2   = parseXml(files['xl/worksheets/sheet2.xml'], 'sheet2');
  const c2   = cellsOf(s2);
  const text = files['xl/worksheets/sheet2.xml'];
  eq('the summary is titled',        c2.A1.text, 'Schedule Records — Summary');
  eq('and states the range',         c2.B2.text, '2026-03-02  to  2026-03-06');
  // A workbook gets emailed on. Whoever opens it never saw the note under the
  // table, so it has to carry whether the reported columns can be trusted.
  eq('and whether the reported columns are complete', c2.A6.text, 'Driver reports');
  eq('which they are here',                           c2.B6.text, 'complete');
  {
    const was = p.schedRec.reportsErr, wasRange = p.schedRec.reportsErrRange;
    p.schedRec.reportsErr = 'HTTP 503';
    p.schedRec.reportsErrRange = p.schedRecKey();
    const broken = unzip(p.schedRecXlsx(rows));
    assert('and says so when they could not be loaded',
      /NOT LOADED \(HTTP 503\)/.test(broken['xl/worksheets/sheet2.xml']),
      broken['xl/worksheets/sheet2.xml'].slice(0, 500));
    p.schedRec.reportsErr = was; p.schedRec.reportsErrRange = wasRange;
  }
  ['TOTALS', 'BY DRIVER', 'BY DIVISION', 'BY PROJECT / JOB', 'BY TRUCK', 'BY TRUCK TYPE',
   'BY MATERIAL', 'BY DAY'].forEach(h =>
    assert('rolls up ' + h.toLowerCase(), text.includes('>' + h + '<')));

  const byDriver = p.schedRecRollup(rows, 'driver');
  eq('three drivers in the rollup', byDriver.length, 3);
  const barr = byDriver.find(g => g.label === 'Barr, Michael');
  eq('their tons roll up',   barr.tons, 96);
  eq('their actual hours',   barr.actHrs, 8.25);
  eq('their record count',   barr.rows, 1);
  const byDay = p.schedRecRollup(rows, 'date');
  eq('days roll up in date order', byDay.map(g => g.label).join(','), '2026-03-02,2026-03-05');

  /* ── An empty pull still opens ── */
  const none = p.schedRecXlsx([]);
  let emptyFiles;
  try { emptyFiles = unzip(none); assert('a pull with no records still writes a workbook', true); }
  catch (err) { assert('a pull with no records still writes a workbook', false, err.message); emptyFiles = {}; }
  if (emptyFiles['xl/worksheets/sheet1.xml']) {
    parseXml(emptyFiles['xl/worksheets/sheet1.xml'], 'empty sheet1');
    const eaf = parseXml(emptyFiles['xl/worksheets/sheet1.xml'], 'e').getElementsByTagName('autoFilter')[0];
    eq('and its filter covers the header alone', eaf.getAttribute('ref'), 'A1:' + LAST + '1');
  }

  /* ── The download is what the screen shows ── */
  p.schedRec.col.driver = 'kirk';
  const narrowed = p.schedRecView();
  eq('a filter narrows the download too', narrowed.length, 1);
  const nb = unzip(p.schedRecXlsx(narrowed));
  eq('and the workbook carries the one row',
    [...parseXml(nb['xl/worksheets/sheet1.xml'], 's').getElementsByTagName('row')].length, 2);
  p.schedRec.col = {};
}

/* ══════════════════════════════════════════════════════════════════════════
   7. THE DISPATCH SHEET STILL WRITES ITS OWN WORKBOOK
   Records reuses the OOXML writer the day sheet has always used. That sheet
   must come out of the change unchanged.
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── The dispatch sheet is unchanged ──');
{
  const DAY = '2026-03-02';
  const sandbox = {
    console, TextEncoder, TextDecoder, Uint8Array, Map, Set, Date, Math, JSON, Intl, isFinite, Number, String,
    _remKey: v => String(v == null ? '' : v).trim(),
    divTruckLists: { drivers: [], customers: [], units: [{ name: '2757', type: 'triaxle' }], materials: [], locations: [] },
    schedS: () => ({ anchor: DAY, view: 'day', assignments: { [DAY]: [A('d1')] }, hidden: new Set() }),
    schedBoardCfg: () => ({ id: 'trucking', noun: 'Trucking' }),
    schedReports: new Map(),
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    TYPES, GROUPS, DIVS, JOBOF, XLSX,
    slice(TRUCKING, '    function schedPad(n)', '    /** True when the named board', 'date helpers'),
    HOURS,
    slice(TRUCKING, '    function schedRepItems(date)', '    function schedRepCell(v)', 'rep items'),
    slice(TRUCKING, '    const SCHED_SHEET_COLS = [', '    function schedSheetTitle(date)', 'sheet cols'),
    slice(TRUCKING, '    function schedSheetXlsx(date)', '    function schedSheetDownload()', 'sheet xlsx'),
  ].join('\n'), sandbox, { filename: 'trucking.html' });

  let files;
  try { files = unzip(sandbox.schedSheetXlsx(DAY)); assert('the dispatch sheet still zips', true); }
  catch (err) { assert('the dispatch sheet still zips', false, err.message); files = {}; }
  if (files['xl/workbook.xml']) {
    const wb = parseXml(files['xl/workbook.xml'], 'dispatch workbook');
    const sh = [...wb.getElementsByTagName('sheet')];
    eq('one sheet, still called Dispatch', sh.length && sh[0].getAttribute('name'), 'Dispatch');
    assert('no auto-filter is forced onto it', !/<autoFilter/.test(files['xl/worksheets/sheet1.xml']));
    assert('and no filter name is added to the workbook', !/_FilterDatabase/.test(files['xl/workbook.xml']));
    const c = [...parseXml(files['xl/worksheets/sheet1.xml'], 'd').getElementsByTagName('c')];
    const a1 = c.find(x => x.getAttribute('r') === 'A1');
    eq('its first heading is still Start', a1.getElementsByTagName('t')[0].textContent, 'Start');
    assert('bold is still style 1', a1.getAttribute('s') === '1', a1.getAttribute('s'));
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   8. WIRING
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── Wiring ──');
{
  const dom = new JSDOM(TRUCKING);
  const doc = dom.window.document;
  const btns = [...doc.querySelectorAll('.sched-sub-btn')].map(b => b.dataset.board);
  assert('a Records sub-tab sits beside the two boards',
    btns.join(',') === 'trucking,labor,records', btns.join(','));
  assert('and has a panel of its own', !!doc.getElementById('sched-board-records'));
  assert('every sub-tab has a panel',
    btns.every(b => !!doc.getElementById('sched-board-' + b)));

  assert('the tab bar routes through the one renderer',
    /dataset\.tab === 'scheduler'\) schedRerender\(\)/.test(TRUCKING));
  assert('switching to Records draws Records',
    /if \(board === 'records'\) renderSchedRecords\(\);/.test(TRUCKING));
  assert('Records leaves the board selection alone',
    /if \(board !== 'records'\) schedBoard = board;/.test(TRUCKING));
  assert('no board is drawn while Records is up',
    /if \(b !== schedBoard \|\| schedView !== schedBoard\) return;/.test(TRUCKING));
  assert('and schedIsActive says so too',
    /if \(schedView !== schedBoard\) return false;/.test(TRUCKING));
  // The three board-scoped redraws — a board finishing its load, and either
  // end of a save flush — go through schedRerender, which is what wakes
  // Records when the boards change underneath it.
  eq('every board-scoped redraw goes through schedRerender',
    (TRUCKING.match(/schedRerender\(b\);/g) || []).length, 4);
  assert('and schedRerender is the only thing left calling renderScheduler(b)',
    (TRUCKING.match(/schedIsActive\(b\)\) renderScheduler\(b\);/g) || []).length === 1);

  // Records must never write. Every mutation on this page goes through
  // schedMarkDirty; nothing in the Records block may call it.
  const rec = RECORDS;
  ['schedMarkDirty', 'schedSave(', 'schedFlush(', 'schedRemoveById', 'schedSaveEditor'].forEach(fn =>
    assert('Records never calls ' + fn.replace(/\($/, ''), !rec.includes(fn)));

  // The reports pull is chunked under the endpoint's own 400-day ceiling.
  const cap = /MAX_RANGE_DAYS = (\d+)/.exec(read('api/trucking-driver-reports.js'));
  const chunk = /SCHED_REC_CHUNK\s*=\s*(\d+)/.exec(TRUCKING);
  assert('the report pull chunks under the endpoint ceiling',
    cap && chunk && Number(chunk[1]) <= Number(cap[1]),
    `chunk ${chunk && chunk[1]} vs cap ${cap && cap[1]}`);

  // Every column the table draws has a width in the workbook, and every
  // filter box names a column that exists.
  const p = page({});
  assert('every column has a label, a key and a width',
    p.SCHED_REC_COLS.every(c => c.key && c.label && c.w > 0));
  assert('no column key is used twice',
    new Set(p.SCHED_REC_COLS.map(c => c.key)).size === p.SCHED_REC_COLS.length);
  assert('the sort opens on a column that exists',
    p.SCHED_REC_COLS.some(c => c.key === p.schedRec.sort.key));
  assert('every status the filter offers is one a row can carry',
    p.SCHED_REC_STATUSES.length === 4 &&
    p.SCHED_REC_STATUSES.includes('Report only') && p.SCHED_REC_STATUSES.includes('Removed'));

  // The frozen columns are positioned by hand, so their offsets have to be the
  // running total of the widths before them or they overlap on screen.
  {
    let left = 0;
    const bad = [];
    ['board', 'date', 'driver'].forEach((k, i) => {
      const st = p.schedRecStick(k);
      const px = p.SCHED_REC_COLS.find(c => c.key === k).px;
      if (!st.cls.includes('stk')) bad.push(k + ' is not pinned');
      if (!st.style.includes(`left:${left}px`)) bad.push(k + ' starts at the wrong offset: ' + st.style);
      if (!st.style.includes(`width:${px}px`)) bad.push(k + ' is not the width its offset assumes');
      if (i === 2 && !st.cls.includes('stk-edge')) bad.push('the last pinned column has no edge');
      left += px;
    });
    assert('the pinned columns tile the left edge exactly', !bad.length, bad.join('; '));
    // A pinned cell has to paint over what scrolls under it, so every rule that
    // gives one a background must give it an opaque one.
    const css = slice(TRUCKING, '    .rec-tbl th.stk, .rec-tbl td.stk', '    .rec-tbl tbody td.r ', 'pinned css');
    const bg = css.match(/td\.stk\s*\{[^}]*background:\s*([^;]+);/g) || [];
    assert('every pinned background is opaque',
      bg.length >= 3 && !/rgba|#[0-9a-f]{8}\b/i.test(css.replace(/tr:hover|orphan/g, '')), css);
    assert('and nothing else is pinned',
      p.SCHED_REC_COLS.filter(c => p.schedRecStick(c.key).cls).length === 3);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   8b. THE ARCHIVE
   Deleting a haul used to take it out of the record entirely — Records reads
   the boards, and what is not on a board is not in it. What was there is now
   kept, and these are the ways it could still be lost.
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── The archive ──');
{
  const DAY = '2026-03-02';
  const p = page({
    from: '2026-03-01', to: '2026-03-31',
    units: [{ name: '2757', type: 'triaxle' }],
    assignments: { trucking: { [DAY]: [
      A('d1', { notes: 'called off — plant down', address: '', location: '' }),
      A('d2', { driver: 'Kirk, Dan' }),
    ] } },
    reports: [{ assignment_id: 'd1', work_date: DAY, tons: 30, loads: 1,
                actual_start: '06:00', actual_end: '10:00' }],
  });
  const st = p._schedStates.trucking;

  /* ── The tombstone ── */
  p.schedArchiveRemoval('trucking', DAY, 'd1');
  const t = st.deleted.d1;
  assert('deleting archives the row under its id', !!t);
  eq('with the day it was on',        t._d, DAY);
  eq('the driver it was for',         t.driver, 'Barr, Michael');
  eq('the job it was on',             t.project, 'Acme Materials');
  eq('the truck it was going out on', t.unit, '2757');
  eq('and what it said',              t.notes, 'called off — plant down');
  eq('stamped with who removed it',   t.removedBy, 'bhudock');
  assert('and when', /^\d{4}-\d{2}-\d{2}T/.test(t.removedAt), t.removedAt);
  assert('empty fields are dropped — the archive is written on every save',
    !('address' in t) && !('location' in t), JSON.stringify(t));
  assert('the board itself is untouched by archiving',
    (st.assignments[DAY] || []).some(a => a.id === 'd1'));
  p.schedRemoveById(DAY, 'd1', 'trucking');   // the other half of the delete

  /* ── Delete does both, in that order ── */
  p.__setCtx({ board: 'trucking', date: DAY, id: 'd2' });
  p.schedDeleteEditor();
  assert('the Delete button archives as well as removes',
    !!st.deleted.d2 && !(st.assignments[DAY] || []).some(a => a.id === 'd2'));
  eq('and marks the board for saving', p.marked.join(','), 'trucking');
  eq('the archived row is the row as it stood', st.deleted.d2.driver, 'Kirk, Dan');
  assert('archiving a row that is not there does nothing',
    (() => { const was = JSON.stringify(st.deleted);
             p.schedArchiveRemoval('trucking', DAY, 'nosuch');
             return JSON.stringify(st.deleted) === was; })());

  /* ── It reaches the record ── */
  p.schedRec.removed = true;
  const rows = p.schedRecView();
  const r1 = rows.find(r => r.id === 'd1');
  eq('a removed haul is in the record',      r1.status, 'Removed');
  eq('on the board it was removed from',     r1.board, 'Trucking');
  eq('on the day it was on',                 r1.date, DAY);
  eq('with its scheduled hours',             r1.planHrs, 8);
  eq('and the report the driver did file',   r1.tons, 30);
  eq('and who removed it',                   r1.removedBy, 'bhudock');
  assert('and it still counts as reported, because it was', r1.reported === true);
  {
    // The one that was never reported must not be counted as if it had been.
    const t2 = p.schedRecTotals(p.schedRecView());
    eq('a removed haul nobody reported is not counted as reported', t2.reported, 1);
    eq('and both are counted as removed', t2.removed, 2);
  }
  assert('and when, in words', /2026/.test(p.schedRecText(r1, 'removedAt')), p.schedRecText(r1, 'removedAt'));
  assert('a haul with a report and a tombstone is Removed, not Report only',
    !rows.some(r => r.status === 'Report only'));

  /* ── Out of the way unless asked for ── */
  p.schedRec.removed = false;
  assert('removed hauls are out of the default pull',
    !p.schedRecView().some(r => r.status === 'Removed'));
  eq('and the tab counts what it is holding back', p.schedRecViewParts().hiddenRemoved, 2);
  p.schedRec.status = 'Removed';
  eq('asking for them by status brings them in whatever the tick says',
    p.schedRecView().length, 2);
  p.schedRec.status = 'all';
  eq('and then they are held back again', p.schedRecViewParts().hiddenRemoved, 2);

  // The other filters still apply to them.
  p.schedRec.removed = true;
  p.schedRec.col.driver = 'kirk';
  eq('a column filter narrows the archive too', p.schedRecView().length, 1);
  p.schedRec.col = {};

  // The count of what is hidden respects the other filters, or it would offer
  // to show rows that are filtered out anyway.
  p.schedRec.removed = false;
  p.schedRec.col.driver = 'kirk';
  eq('and so does the count of what is hidden', p.schedRecViewParts().hiddenRemoved, 1);
  p.schedRec.col = {};
  p.schedRec.removed = true;

  /* ── The workbook ── */
  {
    const wb = unzip(p.schedRecXlsx(p.schedRecView()));
    const doc = parseXml(wb['xl/worksheets/sheet1.xml'], 'records');
    const hdr = [...doc.getElementsByTagName('row')][0];
    const heads = [...hdr.getElementsByTagName('t')].map(t => t.textContent);
    assert('the workbook carries the removal columns',
      heads.includes('Removed') && heads.includes('Removed by'), heads.join(','));
    const at = p.SCHED_REC_COLS.findIndex(c => c.key === 'removedAt');
    const ref = p._colName(at) + '2';
    const c = [...doc.getElementsByTagName('c')].find(x => x.getAttribute('r') === ref);
    assert('the removal stamp is written as a date and time, not text',
      c && c.getAttribute('s') === '5' && c.getElementsByTagName('v').length === 1,
      c && c.outerHTML);
    const v = Number(c.getElementsByTagName('v')[0].textContent);
    assert('and it is a plausible serial with a time on it',
      v > 46000 && v % 1 !== 0, String(v));
    assert('and the summary says the archive is in this pull',
      /Removed hauls/.test(wb['xl/worksheets/sheet2.xml']) &&
      /included/.test(wb['xl/worksheets/sheet2.xml']));
    p.schedRec.removed = false;
    const wb2 = unzip(p.schedRecXlsx(p.schedRecView()));
    assert('and says so when it is not',
      /excluded/.test(wb2['xl/worksheets/sheet2.xml']));
    p.schedRec.removed = true;
  }

  /* ── A live row always wins a tombstone ── */
  {
    const q = page({
      from: '2026-03-01', to: '2026-03-31',
      assignments: { trucking: { [DAY]: [A('both')] } },
    });
    q._schedStates.trucking.deleted = { both: { ...A('both'), _d: DAY, removedAt: '2026-03-04T10:00:00.000Z', removedBy: 'x' } };
    q.schedRec.removed = true;
    const got = q.schedRecView().filter(r => r.id === 'both');
    eq('a row on a board and in the archive is drawn once', got.length, 1);
    eq('as the live row',                                   got[0].status, 'Planned');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   8c. THE ARCHIVE SURVIVES A SAVE
   The blob is written whole on every save, so anything the write forgets is
   gone from the server the next time anybody saves.
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── The archive survives a save ──');
{
  const p = page({});
  const st = p._schedStates.trucking;
  st.assignments = { '2026-03-02': [A('k1')] };
  st.deleted = { gone: { id: 'gone', driver: 'Kirk, Dan', _d: '2026-03-01',
                         removedAt: '2026-03-02T12:00:00.000Z', removedBy: 'bhudock' } };
  st.hidden = new Set(['Someone']);

  const body = p.schedBlobValue(st);
  assert('a save carries the archive', !!body.deleted && !!body.deleted.gone);
  assert('alongside the assignments and the hidden list',
    !!body.assignments['2026-03-02'] && body.hidden.join() === 'Someone');
  eq('and is versioned like before', body.version, 1);

  // Both writers must agree, or the keepalive on the way out of the page drops
  // the archive on every unload.
  const flush = slice(TRUCKING, '    async function schedFlush(board)', '    function schedStep(n)', 'flush');
  eq('the debounced save and the keepalive write the same shape',
    (flush.match(/JSON\.stringify\(\{ value: schedBlobValue\(st\) \}\)/g) || []).length, 2);
  assert('and nothing writes the blob by hand any more',
    !/value: \{ version: 1, assignments/.test(TRUCKING));

  /* ── Two dispatchers ── */
  const ours   = { a: { id: 'a', removedBy: 'us' } };
  const theirs = { b: { id: 'b', removedBy: 'them' } };
  const merged = p.schedMergeDeleted(ours, theirs);
  assert('a merge keeps both sides\' removals', !!merged.a && !!merged.b);
  eq('and takes neither off the record', Object.keys(merged).length, 2);
  eq('ours wins a row both hold',
    p.schedMergeDeleted({ x: { removedBy: 'us' } }, { x: { removedBy: 'them' } }).x.removedBy, 'us');
  assert('a server with no archive yet is not an error',
    Object.keys(p.schedMergeDeleted(ours, null)).length === 1);
  assert('and neither is one that is not an object',
    Object.keys(p.schedMergeDeleted(ours, [1, 2])).length === 1);

  // Nothing in the app may take a tombstone off the record.
  const recSrc = RECORDS + DELETE;
  assert('nothing deletes from the archive',
    !/delete\s+st\.deleted|delete\s+schedS\([^)]*\)\.deleted|\.deleted\s*=\s*\{\}/.test(recSrc),
    'a write to the archive that is not an addition');
  assert('and Records only ever reads it',
    !/st\.deleted\s*=|\.deleted\[[^\]]+\]\s*=/.test(RECORDS));
}

/* ══════════════════════════════════════════════════════════════════════════
   9. ON SCREEN
   The tab drawn into a real document and driven the way a dispatcher drives
   it. Everything above is the data; this is whether the thing renders, keeps
   its columns lined up, and holds what is typed into it across a repaint.
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── On screen ──');
{
  const dom = new JSDOM('<!doctype html><html><body><div id="sched-board-records"></div></body></html>',
    { virtualConsole: quiet() });
  const win = dom.window;
  const from = '2026-03-01', to = '2026-03-07';

  const sandbox = {
    console, TextEncoder, TextDecoder, Uint8Array, Map, Set, Date, Math, JSON, Intl, isFinite, Number, String,
    setTimeout: win.setTimeout.bind(win),
    _remKey: v => String(v == null ? '' : v).trim(),
    divTruckLists: { drivers: [], customers: [], units: [{ name: '2757', type: 'triaxle' }], materials: [], locations: [] },
    document: win.document,
    API_BASE: '/api', token: 'test',
    fetch: () => Promise.reject(new Error('no network in tests')),
    // The boards are handed over already loaded, so nothing here reaches out.
    schedEnsureLoaded: () => {},
    Blob: function (parts) { this.size = parts[0].length; },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext([BOARDS, TYPES, GROUPS, DIVS, JOBOF, HOURS, XLSX, RECORDS, EXPORTS].join('\n'),
    sandbox, { filename: 'trucking.html' });

  sandbox._schedStates.trucking.assignments = {
    '2026-03-02': [A('x1', { notes: 'call & <b>ask</b> for Ed' }),
                   A('x2', { driver: 'Kirk, Dan', start: '13:00', end: '' })],
  };
  sandbox._schedStates.trucking.loaded = true;
  sandbox._schedStates.labor.assignments = { '2026-03-05': [A('x3', { driver: 'Glatt, Shane' })] };
  sandbox._schedStates.labor.loaded = true;
  sandbox.schedRec.reports.set('x1', { assignment_id: 'x1', work_date: '2026-03-02',
    tons: 96, loads: 4, actual_start: '06:05', actual_end: '14:20' });
  sandbox.schedRec.from = from;
  sandbox.schedRec.to   = to;
  sandbox.schedRec.reportsRange = from + '..' + to;   // nothing left to fetch

  let threw = null;
  try { sandbox.renderSchedRecords(); } catch (err) { threw = err; }
  assert('the tab renders without throwing', !threw, threw && threw.stack);

  const doc  = win.document;
  const hdr  = doc.getElementById('sched-rec-hdr');
  const body = doc.getElementById('sched-rec-body');
  const filt = doc.querySelector('.rec-tbl tr.filter-row');
  assert('a header, a filter row and a body are drawn', !!hdr && !!body && !!filt);

  const nCols = sandbox.SCHED_REC_COLS.length;
  eq('a heading per column', hdr.querySelectorAll('th').length, nCols);
  eq('a filter cell per column', filt.querySelectorAll('th').length, nCols);
  const firstRow = body.querySelector('tr');
  eq('a cell per column on every row', firstRow.querySelectorAll('td').length, nCols);
  eq('a row per record', body.querySelectorAll('tr').length, 3);

  // Markup in a note is shown, not run.
  assert('a note with markup in it is escaped, not rendered',
    !body.querySelector('b') && body.textContent.includes('call & <b>ask</b> for Ed'),
    body.textContent.slice(0, 120));

  const totals = doc.getElementById('sched-rec-totals');
  assert('the totals bar is filled in', /Records/.test(totals.textContent) && /Tons/.test(totals.textContent));
  assert('and counts what is drawn', /Records\s*3/.test(totals.textContent.replace(/\s+/g, ' ')),
    totals.textContent);

  /* ── Filtering keeps the caret ── */
  const box = doc.getElementById('sched-rec-f-driver');
  assert('every filterable column has a box', !!box);
  box.value = 'kirk';
  sandbox.schedRecSetCol('driver', 'kirk', box);
  eq('typing in a column box narrows the table', body.querySelectorAll('tr').length, 1);
  assert('and the box is marked as set', box.classList.contains('on'));
  assert('and is the same element, still holding what was typed',
    doc.getElementById('sched-rec-f-driver') === box && box.value === 'kirk');

  sandbox.schedRecClear();
  eq('Clear puts every row back', body.querySelectorAll('tr').length, 3);
  eq('and empties the box', box.value, '');
  assert('and unmarks it', !box.classList.contains('on'));

  /* ── Sorting ── */
  sandbox.schedRecSortBy('tons');
  eq('a figure column opens biggest-first', sandbox.schedRec.sort.dir, 'desc');
  sandbox.schedRecSortBy('tons');
  eq('and toggles', sandbox.schedRec.sort.dir, 'asc');
  sandbox.schedRecSortBy('driver');
  eq('a name column opens A–Z', sandbox.schedRec.sort.dir, 'asc');
  assert('the sorted heading is marked', /sorted/.test(hdr.innerHTML));

  /* ── The range ── */
  const fEl = doc.getElementById('sched-rec-from'), tEl = doc.getElementById('sched-rec-to');
  eq('the date boxes hold the range', fEl.value + '..' + tEl.value, from + '..' + to);
  fEl.value = '2026-03-07'; tEl.value = '2026-03-01';        // typed back to front
  sandbox.schedRecSetRange();
  eq('a range typed backwards is turned round', fEl.value + '..' + tEl.value, '2026-03-01..2026-03-07');
  eq('and the preset says custom', doc.getElementById('sched-rec-preset').value, 'custom');
  sandbox.schedRecSetPreset('ytd');
  eq('picking a preset moves the boxes', fEl.value.slice(5), '01-01');
  assert('a half-typed date changes nothing, and the box goes back', (() => {
    const was = sandbox.schedRec.from;
    fEl.value = '2026-0';
    sandbox.schedRecSetRange();
    return sandbox.schedRec.from === was && fEl.value === was;
  })());
  assert('and so does an emptied one', (() => {
    const was = sandbox.schedRec.to;
    tEl.value = '';
    sandbox.schedRecSetRange();
    return sandbox.schedRec.to === was && tEl.value === was;
  })());

  /* ── A repaint mid-typing must not take the caret ── */
  sandbox.schedRecSetPreset('all');
  const box2 = doc.getElementById('sched-rec-f-project');
  box2.value = 'acm';
  sandbox.schedRecSetCol('project', 'acm', box2);
  sandbox.schedRerender();                     // as a save landing would
  assert('a repaint leaves the filter boxes alone',
    doc.getElementById('sched-rec-f-project') === box2 && box2.value === 'acm');

  /* ── Nothing found ── */
  sandbox.schedRecSetQ('nothing matches this');
  assert('an empty result says so', /No records in this range/.test(body.textContent));
  // A board still on its way looks exactly like an empty archive otherwise.
  sandbox._schedStates.labor.loaded = false;
  sandbox.schedRecPaint();
  assert('but an archive that has not arrived yet says that instead',
    /Loading the schedule/.test(body.textContent) && !/No records/.test(body.textContent),
    body.textContent.slice(0, 90));
  sandbox._schedStates.labor.loaded = true;
  eq('and the totals go to zero', sandbox.schedRecTotals(sandbox.schedRecView()).rows, 0);
  sandbox.schedRecSetQ('');

  /* ── The download ── */
  let dlErr = null;
  try { sandbox.schedRecDownload(); } catch (err) { dlErr = err; }
  assert('the download runs end to end', !dlErr, dlErr && dlErr.stack);

  /* ── Leaving and coming back ── */
  doc.getElementById('sched-board-records').innerHTML = '';   // what switching sub-tabs does
  let backErr = null;
  try { sandbox.renderSchedRecords(); } catch (err) { backErr = err; }
  assert('coming back rebuilds the tab', !backErr && !!doc.getElementById('sched-rec-body'),
    backErr && backErr.stack);
  assert('and the filters that were set are still set',
    doc.getElementById('sched-rec-f-project').value === 'acm');
}

/* ══════════════════════════════════════════════════════════════════════════
   10. WHEN THINGS FAIL
   Every keystroke repaints this tab. Anything a repaint triggers therefore has
   to be safe to trigger a hundred times — which is exactly what a failed load
   is not, unless it is remembered.
══════════════════════════════════════════════════════════════════════════ */
console.log('\n── When things fail ──');

/** The tab in a document, with a Scheduler tab bar so the real "is Records on
 *  screen" check answers yes, and a fetch that can be told to fail. */
function live(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><body>' +
    '<button class="tab-btn active" data-tab="scheduler"></button>' +
    '<div id="sched-board-records"></div></body></html>', { virtualConsole: quiet() });
  const win = dom.window;
  const calls = { loads: [], fetches: [] };
  const sandbox = {
    console, TextEncoder, TextDecoder, Uint8Array, Map, Set, Date, Math, JSON, Intl, isFinite, Number, String,
    setTimeout: win.setTimeout.bind(win),
    _remKey: v => String(v == null ? '' : v).trim(),
    divTruckLists: { drivers: [], customers: [], units: [], materials: [], locations: [] },
    document: win.document,
    API_BASE: '/api', token: 'test',
    fetch: url => {
      calls.fetches.push(String(url));
      if (o.fetchFails) return Promise.reject(new Error('HTTP 503'));
      // Answers the way the endpoint does: only the window it was asked for.
      const m = /from=([\d-]+)&to=([\d-]+)/.exec(String(url)) || [];
      const reports = (o.reports || []).filter(r => r.work_date >= m[1] && r.work_date <= m[2]);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ reports }) });
    },
    schedEnsureLoaded: b => { calls.loads.push(b); },
    Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext([BOARDS, TYPES, GROUPS, DIVS, JOBOF, HOURS, XLSX, RECORDS, EXPORTS].join('\n'),
    sandbox, { filename: 'trucking.html' });
  sandbox.__setView('records');
  SBOARDS(sandbox).forEach(id => {
    sandbox._schedStates[id].assignments = {};
    sandbox._schedStates[id].loaded = true;
  });
  sandbox.schedRec.from = o.from || '2026-03-01';
  sandbox.schedRec.to   = o.to   || '2026-03-07';
  return { sandbox, calls, win, opts: o };
}
const SBOARDS = sb => sb.SCHED_BOARDS.map(b => b.id);
const settle = () => new Promise(r => setImmediate(r));

(async () => {
  /* ── A board whose load failed is not asked again by a repaint ── */
  {
    const { sandbox, calls } = live({});
    sandbox._schedStates.trucking.loaded = false;
    sandbox._schedStates.trucking.loadError = 'HTTP 500';
    sandbox.renderSchedRecords();
    assert('a board that failed to load is not re-fetched by the repaint',
      !calls.loads.includes('trucking'), calls.loads.join(','));
    assert('the other board still loads', calls.loads.includes('labor'));
    const note = sandbox.document.getElementById('sched-rec-note');
    assert('and the tab says so', /Could not load the trucking schedule/.test(note.textContent), note.textContent);
    assert('and offers a retry', /schedRecRetryBoards/.test(note.innerHTML));

    calls.loads.length = 0;
    sandbox.schedRecRetryBoards();
    assert('retry clears the error and asks again',
      calls.loads.includes('trucking') && !sandbox._schedStates.trucking.loadError);
  }

  /* ── A failed report pull is asked for once, not once per keystroke ── */
  {
    const { sandbox, calls } = live({ fetchFails: true });
    sandbox.renderSchedRecords();
    await settle(); await settle();
    eq('a failed report pull is tried once', calls.fetches.length, 1);
    assert('and is remembered as failed', !!sandbox.schedRec.reportsErrRange);

    for (let i = 0; i < 8; i++) sandbox.schedRecSetQ('abcdefgh'.slice(0, i + 1));
    await settle(); await settle();
    eq('eight more keystrokes do not ask again', calls.fetches.length, 1);

    const note = sandbox.document.getElementById('sched-rec-note');
    assert('the tab says the reports are missing', /Driver reports could not be loaded/.test(note.textContent));
    assert('and offers a retry', /schedRecRetryReports/.test(note.innerHTML));

    sandbox.schedRecRetryReports();
    await settle(); await settle();
    eq('retry asks once more', calls.fetches.length, 2);
  }

  /* ── The pull is chunked, and says so when the range outruns the budget ── */
  {
    const { sandbox, calls } = live({ from: '2026-01-01', to: '2027-12-31' });
    sandbox.renderSchedRecords();
    await settle(); await settle(); await settle();
    eq('two years is two pulls', calls.fetches.length, 2);
    const win1 = /from=([\d-]+)&to=([\d-]+)/.exec(calls.fetches[0]);
    const win2 = /from=([\d-]+)&to=([\d-]+)/.exec(calls.fetches[1]);
    eq('the first window starts at the range',   win1[1], '2026-01-01');
    eq('the second starts the day after it ends', win2[1],
      new Date(Date.parse(win1[2] + 'T12:00:00') + 86400000).toISOString().slice(0, 10));
    eq('and the last ends at the range',         win2[2], '2027-12-31');
    assert('a window never exceeds the endpoint ceiling',
      (Date.parse(win1[2]) - Date.parse(win1[1])) / 86400000 < 400);
    assert('nothing is left short', !sandbox.schedRec.reportsShort, sandbox.schedRec.reportsShort);
  }
  {
    const { sandbox, calls } = live({ from: '1970-01-01', to: '2026-12-31' });
    sandbox.renderSchedRecords();
    for (let i = 0; i < 40; i++) await settle();
    assert('an absurd range stops at the chunk budget', calls.fetches.length <= 24, String(calls.fetches.length));
    assert('and the tab admits it stopped short',
      !!sandbox.schedRec.reportsShort &&
      /read through/.test(sandbox.document.getElementById('sched-rec-note').textContent),
      sandbox.document.getElementById('sched-rec-note').textContent);
  }

  /* ── A failure belongs to the range it happened on ── */
  {
    const { sandbox, calls, opts } = live({
      from: '2026-03-01', to: '2026-03-07',
      reports: [
        { assignment_id: 'mar', work_date: '2026-03-03', tons: 11, loads: 1,
          actual_start: '06:00', actual_end: '14:00' },
        { assignment_id: 'apr', work_date: '2026-04-03', tons: 99, loads: 9,
          actual_start: '06:00', actual_end: '14:00' },
      ],
    });
    sandbox._schedStates.trucking.assignments = {
      '2026-03-03': [A('mar')], '2026-04-03': [A('apr', { driver: 'Kirk, Dan' })],
    };
    const note = () => sandbox.document.getElementById('sched-rec-note');
    const rowOf = id => sandbox.schedRecView().find(r => r.id === id);

    // March fails.
    opts.fetchFails = true;
    sandbox.renderSchedRecords();
    await settle(); await settle();
    eq('the first range is tried once', calls.fetches.length, 1);
    assert('and says its reports are missing', /could not be loaded/.test(note().textContent));

    // April succeeds.
    opts.fetchFails = false;
    sandbox.schedRec.from = '2026-04-01'; sandbox.schedRec.to = '2026-04-30';
    sandbox.schedRecPaint();
    await settle(); await settle();
    eq('the next range is fetched', calls.fetches.length, 2);
    eq('and its reports land on its rows', rowOf('apr').tons, 99);
    assert('and the warning is gone', !/could not be loaded/.test(note().textContent), note().textContent);

    // Back to March. It is still not re-fetched — but it must not read as if
    // nobody reported anything, and it must not show April's answers.
    sandbox.schedRec.from = '2026-03-01'; sandbox.schedRec.to = '2026-03-07';
    sandbox.schedRecPaint();
    await settle();
    eq('the range that failed is still not re-fetched', calls.fetches.length, 2);
    assert('and it says so again', /could not be loaded/.test(note().textContent), note().textContent);
    assert('and offers the retry again', /schedRecRetryReports/.test(note().innerHTML));
    eq('the row shows no actuals rather than another range\'s', rowOf('mar').tons, '');
    eq('and is not miscounted as reported', rowOf('mar').status, 'Planned');

    // The retry works, and clears the failure for good.
    sandbox.schedRecRetryReports();
    await settle(); await settle();
    eq('retry fetches it', calls.fetches.length, 3);
    eq('and its reports land', rowOf('mar').tons, 11);
    assert('and the warning is gone for good', !/could not be loaded/.test(note().textContent));
    eq('and the failure is forgotten', sandbox.schedRec.reportsErrRange, '');
  }

  /* ── A map for another range is never joined, even mid-load ── */
  {
    const { sandbox } = live({
      from: '2026-04-01', to: '2026-04-30',
      reports: [{ assignment_id: 'apr', work_date: '2026-04-03', tons: 99, loads: 9,
                  actual_start: '06:00', actual_end: '14:00' }],
    });
    sandbox._schedStates.trucking.assignments = { '2026-04-03': [A('apr')] };
    sandbox.renderSchedRecords();
    await settle(); await settle();
    eq('April reads its reports', sandbox.schedRecView()[0].tons, 99);

    // Move the range. The old map is still in hand and the new pull has not
    // landed; the rows must not be joined against it.
    sandbox.schedRec.from = '2026-05-01'; sandbox.schedRec.to = '2026-05-31';
    sandbox._schedStates.trucking.assignments = { '2026-05-04': [A('apr')] };
    const mid = sandbox.schedRecView()[0];
    eq('the moved haul shows no actuals while the new range loads', mid.tons, '');
    eq('and is not counted as reported', mid.status, 'Planned');
  }

  /* ── "All time" catches up once the boards arrive ── */
  {
    const { sandbox } = live({});
    sandbox.renderSchedRecords();
    sandbox.schedRecSetPreset('all');           // boards are empty at this point
    const before = sandbox.schedRec.from;
    sandbox._schedStates.trucking.assignments = { '2019-07-04': [A('old')] };
    sandbox.renderSchedRecords();               // as a board finishing its load would
    assert('all time widens to the boards once they load',
      sandbox.schedRec.from === '2019-07-04' && sandbox.schedRec.from !== before,
      before + ' -> ' + sandbox.schedRec.from);
    eq('and the date box follows', sandbox.document.getElementById('sched-rec-from').value, '2019-07-04');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
