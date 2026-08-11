#!/usr/bin/env node
'use strict';
/**
 * Splitting one day across more than one job.
 *
 * Run: node scripts/test-timesheet-split.js   (no database, no server)
 *
 * George works the tennis court in the morning and the multi-field after
 * lunch. He fills timesheet.html in ONCE and the page writes one entry per
 * job, so payroll reviews and approves them exactly as if he had submitted
 * twice. Three things have to hold for that to be worth anything:
 *
 *   1. The day-level answers are applied ONCE across the group. Travel is one
 *      round trip — the drive out on the first job, the drive back on the last
 *      — and lunch is one 30-minute deduction, taken off the first job. Copy
 *      either onto every row and the company pays a second commute and the
 *      worker loses a second half hour, per extra job, silently.
 *   2. Every job keeps its OWN job, clock, equipment answer and division
 *      extras. A split that shares those is just a duplicate.
 *   3. The rows stay tied together (split_group_id / index / count), and stay
 *      tied together through an admin edit from payroll.html — which sends no
 *      split fields at all, so a PUT that "helpfully" cleared them would break
 *      the pairing the first time anyone fixed a typo.
 *
 * The API half stubs the neon driver and the auth module at require time. The
 * page half runs timesheet.html's real script against a small DOM stand-in, so
 * the payload assertions are made against the code that actually ships.
 */

const path   = require('path');
const fs     = require('fs');
const Module = require('module');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
function eq(label, actual, expected) {
  assert(label, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── API side ───────────────────────────────────────────────────────────────

const FIELD = { companyCode: 'FCT', userId: 7,  username: 'oakesgeorge' };
const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office', payrollAdmin: true };

let CURRENT_SQL = null;
let NEXT_AUTH   = FIELD;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: () => NEXT_AUTH,
      requireDivision: () => null,
      // Mirror the real gate: only a payroll admin may edit a submitted row.
      hasDivisionAccess: (p, area) => (area === 'payroll' ? !!(p && p.payrollAdmin) : true),
    };
  }
  if (request === './lib/sync-normalized') return { syncForKey: async () => {} };
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'));
const { normalizeSplitTag } = handler._test;

// A daily entry body as timesheet.html sends it.
function dailyBody(extra) {
  return Object.assign({
    entry_type: 'daily',
    work_date: '2026-08-10',
    division: 'turf',
    job_id: '26041',
    job_label: 'Franklin Regional — Tennis Court',
    start_time: '07:00',
    end_time: '11:00',
    lunch_break: true,
    operated_equipment: true,
    supervisor_id: 3,
    supervisor_name: 'Zach Brewer',
    notes: '',
  }, extra || {});
}

// A stored row as the driver hands it back.
function dbRow(extra) {
  return Object.assign({
    id: 501, company_code: 'FCT', user_id: 7, username: 'oakesgeorge',
    entry_type: 'daily', work_date: '2026-08-10', status: 'draft',
    division: 'turf', job_id: '26041', job_label: 'Franklin Regional — Tennis Court',
    start_time: '07:00', end_time: '11:00', computed_hours: 3.5,
    split_group_id: null, split_index: null, split_count: null,
  }, extra || {});
}

/**
 * Drive one write through the handler. `existing` is the row a PUT reads back
 * before updating. Returns the response plus the values bound to the INSERT or
 * UPDATE, keyed by the three split columns.
 */
async function write(method, query, body, existing, auth = FIELD) {
  const captured = { insert: null, update: null };
  NEXT_AUTH = auth;

  CURRENT_SQL = (strings, ...values) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    // The value bound immediately after the fragment ending in `name = ` (an
    // UPDATE) or at the position of `name` in the column list (an INSERT).
    const afterEquals = name => {
      const i = strings.findIndex(s => new RegExp(`\\b${name}\\s*=\\s*$`).test(s));
      return i === -1 ? undefined : values[i];
    };
    if (/^INSERT INTO timesheet_entries/.test(q)) {
      // Column list and VALUES list are positional; split_* are the last three.
      captured.insert = {
        split_group_id: values[values.length - 3],
        split_index:    values[values.length - 2],
        split_count:    values[values.length - 1],
      };
      return Promise.resolve([dbRow(Object.assign({}, body, captured.insert))]);
    }
    if (/^UPDATE timesheet_entries SET/.test(q)) {
      captured.update = {
        split_group_id: afterEquals('split_group_id'),
        split_index:    afterEquals('split_index'),
        split_count:    afterEquals('split_count'),
      };
      return Promise.resolve([dbRow(Object.assign({}, existing, captured.update))]);
    }
    if (/^SELECT \* FROM timesheet_entries/.test(q)) return Promise.resolve(existing ? [existing] : []);
    return Promise.resolve([]);
  };

  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query, body }, res);
  return { res, captured };
}

async function apiTests() {
  console.log('\n[normalizeSplitTag]');
  assert('a body with no split keys returns null, so the caller decides',
    normalizeSplitTag({ work_date: '2026-08-10' }) === null);
  eq('a well-formed tag comes through intact',
    normalizeSplitTag({ split_group_id: 'gk1x9a', split_index: 2, split_count: 2 }),
    { split_group_id: 'gk1x9a', split_index: 2, split_count: 2 });
  eq('a group of one is not a split',
    normalizeSplitTag({ split_group_id: 'gk1x9a', split_index: 1, split_count: 1 }),
    { split_group_id: null, split_index: null, split_count: null });
  eq('an index past the end of the group is dropped rather than stored',
    normalizeSplitTag({ split_group_id: 'gk1x9a', split_index: 3, split_count: 2 }),
    { split_group_id: null, split_index: null, split_count: null });
  eq('a group id outside [A-Za-z0-9_-] is refused',
    normalizeSplitTag({ split_group_id: "g'; DROP TABLE", split_index: 1, split_count: 2 }),
    { split_group_id: null, split_index: null, split_count: null });
  eq('and so is a group larger than the cap',
    normalizeSplitTag({ split_group_id: 'gk1x9a', split_index: 1, split_count: 99 }),
    { split_group_id: null, split_index: null, split_count: null });
  eq('an explicitly cleared tag clears it',
    normalizeSplitTag({ split_group_id: null, split_index: null, split_count: null }),
    { split_group_id: null, split_index: null, split_count: null });

  console.log('\n[POST — creating the rows of a split day]');
  {
    const { res, captured } = await write('POST', {},
      dailyBody({ split_group_id: 'gk1x9a', split_index: 2, split_count: 2 }));
    assert('the write succeeds', res.statusCode === 200 && res.body.ok === true,
      JSON.stringify(res.body));
    eq('the tag is stored as sent', captured.insert,
      { split_group_id: 'gk1x9a', split_index: 2, split_count: 2 });
    assert('and comes back on the entry so the page can badge it',
      res.body.entry.split_group_id === 'gk1x9a' &&
      res.body.entry.split_index === 2 &&
      res.body.entry.split_count === 2, JSON.stringify(res.body.entry));
  }
  {
    const { captured } = await write('POST', {}, dailyBody());
    eq('an ordinary entry stores no tag', captured.insert,
      { split_group_id: null, split_index: null, split_count: null });
  }
  {
    const { captured } = await write('POST', {}, {
      entry_type: 'time_off', work_date: '2026-08-10', time_off_type: 'sick',
      supervisor_id: 3, supervisor_name: 'Zach Brewer',
      split_group_id: 'gk1x9a', split_index: 1, split_count: 2,
    });
    eq('time off is never a split, whatever the body says', captured.insert,
      { split_group_id: null, split_index: null, split_count: null });
  }

  console.log('\n[PUT — an admin edit must not break the pairing]');
  {
    // Exactly what payroll.html's saveEdit sends: no split fields at all.
    const existing = dbRow({ status: 'submitted', split_group_id: 'gk1x9a', split_index: 1, split_count: 2 });
    const { res, captured } = await write('PUT', { id: '501' }, dailyBody(), existing, ADMIN);
    assert('the edit succeeds', res.statusCode === 200, JSON.stringify(res.body));
    eq('a body with no split keys leaves the tag exactly as it was', captured.update,
      { split_group_id: 'gk1x9a', split_index: 1, split_count: 2 });
  }
  {
    const existing = dbRow({ split_group_id: 'gk1x9a', split_index: 1, split_count: 2 });
    const { captured } = await write('PUT', { id: '501' },
      dailyBody({ split_group_id: 'gk1x9a', split_index: 1, split_count: 3 }), existing);
    eq('an explicit tag wins — re-saving a day with a third job re-counts it', captured.update,
      { split_group_id: 'gk1x9a', split_index: 1, split_count: 3 });
  }
  {
    const existing = dbRow({ split_group_id: 'gk1x9a', split_index: 1, split_count: 2 });
    const { captured } = await write('PUT', { id: '501' }, {
      entry_type: 'time_off', work_date: '2026-08-10', time_off_type: 'sick',
      supervisor_id: 3, supervisor_name: 'Zach Brewer',
    }, existing);
    eq('turning a split row into time off drops the tag with the job', captured.update,
      { split_group_id: null, split_index: null, split_count: null });
  }
}

// ── Page side ──────────────────────────────────────────────────────────────
// timesheet.html's script, run against a DOM stand-in. Only what the script
// actually touches is implemented: ids, values, text, classes, and enough of
// <select> to read the picked option's label.

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'timesheet.html'), 'utf8');

function loadPage() {
  const byId = new Map();

  const makeClassList = () => {
    const s = new Set();
    return {
      add: (...c) => c.forEach(x => s.add(x)),
      remove: (...c) => c.forEach(x => s.delete(x)),
      toggle: (c, on) => (on ? s.add(c) : s.delete(c)),
      contains: c => s.has(c),
    };
  };

  function makeEl(tag, id) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), id,
      value: '', textContent: '', innerHTML: '', disabled: false,
      dataset: {}, style: {}, classList: makeClassList(),
      options: [], selectedIndex: -1,
      // Only the two Yes/No pills are ever queried, and only for their buttons.
      querySelectorAll: () => (/seg-(lunch|equip)$/.test(id || '')
        ? [{ dataset: { val: 'true' }, classList: makeClassList() },
           { dataset: { val: 'false' }, classList: makeClassList() }]
        : []),
      appendChild(child) { this.options.push(child); return child; },
      insertAdjacentHTML(_pos, html) { registerIds(html); },
      remove() { byId.delete(this.id); },
      scrollIntoView() {},
    };
    return el;
  }

  // Every id in a chunk of markup becomes an element. The page only ever
  // reaches for fields by id, so this is the whole of what it needs.
  function registerIds(html) {
    const re = /<(\w+)\b[^>]*\bid="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) if (!byId.has(m[2])) byId.set(m[2], makeEl(m[1], m[2]));
  }
  registerIds(HTML);

  const document = {
    getElementById: id => byId.get(id) || null,
    querySelectorAll: () => [],
    createElement: tag => makeEl(tag, ''),
  };

  const sandbox = {
    document,
    window: { location: { replace() {} }, scrollTo() {} },
    localStorage: {
      getItem: k => (k === 'fct_token' ? 'tok'
        : k === 'fct_user' ? JSON.stringify({ username: 'oakesgeorge', allowedDivisions: ['timesheet'] })
        : null),
      removeItem() {},
    },
    // init() only fills today's date and fetches; the tests drive the form
    // directly, so keep it from racing them.
    queueMicrotask: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, entries: [], jobs: [], supervisors: [] }) }),
    confirm: () => true,
    console,
  };

  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  const exposed = `
    ;return {
      buildPayloads, addSplit, setSeg, updateHours, blockOrder, blockName,
      splitLabel, resetForm, bel, draftGroupFor,
      setEntriesCache: v => { entriesCache = v; },
      state: () => ({ groupId: currentGroupId, blocks: blockOrder() }),
    };`;
  const names = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  const run = new Function(...names, script + exposed);
  const api = run(...names.map(n => sandbox[n]));
  return { api, document, byId };
}

// Point a <select> at one option, the way a tap on the picker would.
function pick(sel, value, label) {
  sel.options = [{ value, textContent: label, dataset: { label } }];
  sel.selectedIndex = 0;
  sel.value = value;
}

function setBlock(api, i, { division, jobId, jobLabel, start, end, equip }) {
  api.bel(i, 'division').value = division;
  pick(api.bel(i, 'job'), jobId, jobLabel);
  api.bel(i, 'start').value = start;
  api.bel(i, 'end').value   = end;
  api.setSeg('equip', equip, i);
  api.updateHours(i);
}

// George's day: tennis court in the morning, multi-field after lunch, half an
// hour each way in the truck.
function georgesDay(api, doc) {
  doc.getElementById('f-date').value = '2026-08-10';
  doc.getElementById('f-travel-to-site').value = '0.5';
  doc.getElementById('f-travel-to-shop').value = '0.75';
  pick(doc.getElementById('f-supervisor'), '3', 'Zach Brewer');
  doc.getElementById('f-notes').value = 'Moved to the multi-field after lunch.';
  api.setSeg('lunch', true);

  setBlock(api, 0, {
    division: 'turf', jobId: '26041', jobLabel: 'Franklin Regional — Tennis Court',
    start: '07:00', end: '11:30', equip: true,
  });
  api.addSplit();
  const second = api.blockOrder()[1];
  setBlock(api, second, {
    division: 'turf', jobId: '26042', jobLabel: 'Franklin Regional — Multi Field',
    start: '12:00', end: '16:00', equip: false,
  });
  return second;
}

function pageTests() {
  console.log('\n[timesheet.html — one form, one entry per job]');

  {
    const { api, document: doc } = loadPage();
    georgesDay(api, doc);
    const { list, error } = api.buildPayloads();
    assert('the form builds without complaint', !error, error);
    assert('two jobs produce two entries', list && list.length === 2,
      `got ${list && list.length}`);

    const [a, b] = list;
    eq('each entry carries its own job',
      [a.data.job_id, b.data.job_id], ['26041', '26042']);
    eq('and its own clock',
      [a.data.start_time, a.data.end_time, b.data.start_time, b.data.end_time],
      ['07:00', '11:30', '12:00', '16:00']);
    eq('and its own equipment answer',
      [a.data.operated_equipment, b.data.operated_equipment], [true, false]);

    eq('the drive out is booked to the first job only',
      [a.data.travel_to_site_hours, b.data.travel_to_site_hours], ['0.5', '']);
    eq('the drive back to the last job only — the round trip is paid once',
      [a.data.travel_to_shop_hours, b.data.travel_to_shop_hours], ['', '0.75']);
    eq('lunch is deducted once, from the first job',
      [a.data.lunch_break, b.data.lunch_break], [true, false]);

    eq('the date is the same day for both',
      [a.data.work_date, b.data.work_date], ['2026-08-10', '2026-08-10']);
    eq('so is the supervisor',
      [a.data.supervisor_name, b.data.supervisor_name], ['Zach Brewer', 'Zach Brewer']);
    assert('and the note rides on both, since payroll reads them one at a time',
      a.data.notes === b.data.notes && a.data.notes.startsWith('Moved to'));

    assert('both rows share one group id',
      a.data.split_group_id && a.data.split_group_id === b.data.split_group_id,
      `${a.data.split_group_id} vs ${b.data.split_group_id}`);
    eq('numbered in order, with the size of the group',
      [a.data.split_index, a.data.split_count, b.data.split_index, b.data.split_count],
      [1, 2, 2, 2]);

    // The displayed hours are what the server will compute: 4.5 gross less the
    // 30-minute lunch on the first job, 4.0 on the second.
    eq('the first job shows its hours net of lunch',
      doc.getElementById('f-hours').textContent, '4.00');
    eq('the second shows its own, undeducted',
      api.bel(api.blockOrder()[1], 'hours').textContent, '4.00');
    eq('and the day total adds them up',
      doc.getElementById('f-day-hours').textContent, '8.00');
  }

  {
    const { api, document: doc } = loadPage();
    doc.getElementById('f-date').value = '2026-08-10';
    doc.getElementById('f-travel-to-site').value = '0.5';
    doc.getElementById('f-travel-to-shop').value = '0.75';
    pick(doc.getElementById('f-supervisor'), '3', 'Zach Brewer');
    api.setSeg('lunch', true);
    setBlock(api, 0, {
      division: 'turf', jobId: '26041', jobLabel: 'Franklin Regional — Tennis Court',
      start: '07:00', end: '15:30', equip: true,
    });
    const { list, error } = api.buildPayloads();
    assert('an ordinary one-job day still builds', !error, error);
    assert('as exactly one entry', list.length === 1);
    eq('carrying both travel legs and the lunch answer, as it always has',
      [list[0].data.travel_to_site_hours, list[0].data.travel_to_shop_hours, list[0].data.lunch_break],
      ['0.5', '0.75', true]);
    eq('and no split tag',
      [list[0].data.split_group_id, list[0].data.split_index, list[0].data.split_count],
      [null, null, null]);
  }

  console.log('\n[timesheet.html — what it refuses]');

  {
    const { api, document: doc } = loadPage();
    georgesDay(api, doc);
    // Second job left on the first job's clock.
    const second = api.blockOrder()[1];
    api.bel(second, 'start').value = '10:00';
    api.bel(second, 'end').value   = '14:00';
    const { list, error } = api.buildPayloads();
    assert('two jobs booked over the same hours are refused', !list && !!error, JSON.stringify(list));
    assert('and the message names both', /First job and Second job/.test(error || ''), error);
  }
  {
    const { api, document: doc } = loadPage();
    georgesDay(api, doc);
    const second = api.blockOrder()[1];
    api.bel(second, 'start').value = '12:00';
    api.bel(second, 'end').value   = '11:00';   // overnight — 23 hours
    const { list, error } = api.buildPayloads();
    assert('a day adding up to more than 24 hours is refused', !list && !!error, JSON.stringify(list));
    assert('and says so in hours', /more than one day/.test(error || ''), error);
  }
  {
    const { api, document: doc } = loadPage();
    georgesDay(api, doc);
    const second = api.blockOrder()[1];
    pick(api.bel(second, 'job'), '', '');
    const { error } = api.buildPayloads();
    assert('a missing field says WHICH job is missing it',
      /^Second job: pick a job\./.test(error || ''), error);
  }
  {
    const { api, document: doc } = loadPage();
    doc.getElementById('f-date').value = '2026-08-10';
    pick(doc.getElementById('f-supervisor'), '3', 'Zach Brewer');
    api.setSeg('lunch', false);
    setBlock(api, 0, {
      division: 'turf', jobId: '', jobLabel: '',
      start: '07:00', end: '15:30', equip: true,
    });
    const { error } = api.buildPayloads();
    eq('a one-job day keeps the plain wording it always had', error, 'Pick a job.');
  }

  console.log('\n[timesheet.html — form housekeeping]');
  {
    const { api, document: doc } = loadPage();
    georgesDay(api, doc);
    assert('the day total is shown once the day is split',
      doc.getElementById('dayTotalRow').style.display === '');
    api.resetForm();
    eq('Reset takes the extra jobs off the form', api.blockOrder(), [0]);
    assert('and forgets the group they were tied together with',
      api.state().groupId === null);
    assert('and hides the day total again',
      doc.getElementById('dayTotalRow').style.display === 'none');
  }
  console.log('\n[timesheet.html — re-opening a split day]');
  {
    const { api } = loadPage();
    const draft = (id, idx, extra) => Object.assign({
      id, entry_type: 'daily', status: 'draft',
      split_group_id: 'gk1x9a', split_index: idx, split_count: 2,
    }, extra || {});
    const one = draft('501', 1), two = draft('502', 2);
    api.setEntriesCache([two, one]);   // list order is newest-first, not split order

    eq('tapping either draft pulls the whole day back, in job order',
      api.draftGroupFor(one).map(x => x.id), ['501', '502']);
    eq('from either end', api.draftGroupFor(two).map(x => x.id), ['501', '502']);

    // Half the day already went through — only the draft is still editable.
    api.setEntriesCache([Object.assign({}, one, { status: 'submitted' }), two]);
    eq('a sibling that is already submitted is left alone',
      api.draftGroupFor(two).map(x => x.id), ['502']);

    api.setEntriesCache([{ id: '600', entry_type: 'daily', status: 'draft', split_group_id: '' }]);
    eq('and an ordinary draft is just itself',
      api.draftGroupFor({ id: '600', entry_type: 'daily', status: 'draft', split_group_id: '' }).map(x => x.id),
      ['600']);
  }

  {
    const { api } = loadPage();
    eq('an entry with no tag gets no badge', api.splitLabel({ split_group_id: '' }), '');
    eq('a tagged entry is badged with its position',
      api.splitLabel({ split_group_id: 'gk1x9a', split_index: 2, split_count: 2 }), 'Split 2/2');
    eq('a group of one is not badged',
      api.splitLabel({ split_group_id: 'gk1x9a', split_index: 1, split_count: 1 }), '');
  }
}

// ── Drift guard ────────────────────────────────────────────────────────────
// Block 0 is static markup and the extra blocks are built by splitBlockHtml().
// A per-job field added to one and not the other is silent data loss — the
// worker fills it in on their first job and it never appears on the second, or
// the split block collects a value buildPayloads never reads.

function driftTests() {
  console.log('\n[timesheet.html — the split block mirrors block 0]');

  const idMap = HTML.match(/const BLOCK0_IDS = \{([\s\S]*?)\n {4}\};/);
  assert('BLOCK0_IDS is where the field list lives', !!idMap);
  if (!idMap) return;
  const keys = [...idMap[1].matchAll(/'([^']+)':\s*'[^']+'/g)].map(m => m[1]);
  assert('and it names every per-job field', keys.length >= 16, `${keys.length} keys`);

  const tmpl = HTML.match(/function splitBlockHtml\(i\) \{([\s\S]*?)\n {4}\}/);
  assert('splitBlockHtml is where the extra blocks are built', !!tmpl);
  if (!tmpl) return;
  const missing = keys.filter(k => !tmpl[1].includes(`s\${i}-${k}`));
  eq('every field block 0 has, the split block has too', missing, []);

  // The other half of the rule: day-level answers must NOT be repeated per
  // job. A second lunch question is a second lunch deduction.
  const dayLevel = ['f-date', 'f-travel-to-site', 'f-travel-to-shop', 'seg-lunch', 'f-supervisor', 'f-notes'];
  const repeated = dayLevel.filter(f => tmpl[1].includes(f.replace(/^f-/, '')) && /date|travel|lunch|supervisor|notes/.test(f)
    && new RegExp(`s\\$\\{i\\}-${f.replace(/^f-/, '')}\\b`).test(tmpl[1]));
  eq('and no day-level field is asked for twice', repeated, []);
}

(async () => {
  await apiTests();
  pageTests();
  driftTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
