#!/usr/bin/env node
'use strict';
/**
 * Trucking, Dust Control and EES on the master schedule.
 *
 * Run: node scripts/test-sched-trucking.js
 *
 * The board now carries the whole company. Dust Control and EES arrive as
 * ordinary rows — a job per dust customer, and the two standing EES activities
 * (Pre Loading, Washing) — staffed here and saved here, off the very functions
 * the Timesheet's job picker reads, so the two screens cannot disagree about
 * what work exists. Trucking is different: its hauls already exist, in
 * trucking.html's own dispatch blob, and they are READ THROUGH rather than
 * copied. One schedule, two windows onto it.
 *
 * That read-through is the whole risk, and it is what this suite is about:
 *
 *   NOTHING BORROWED IS EVER SAVED AS OURS. A haul written into the
 *   scheduler's blob would exist twice, owned by two screens, and the two
 *   would drift the first time a dispatcher touched one. So every path that
 *   persists or compares — the local cache, the baseline, both merges, the
 *   undo snapshot used for the dirty check — is asserted to carry own rows
 *   only, while the board itself keeps both.
 *
 *   AND NOTHING LENT IS EVER LOST. The board replaces state.assignments
 *   wholesale in six places; every one of them has to put the hauls back, or
 *   a background refresh silently empties half the week.
 *
 *   A WRITE-BACK REPLAYS, IT DOES NOT OVERWRITE. The server re-reads the blob
 *   and applies our adds, edits and removals by id over whatever the
 *   dispatcher has done since — and a removal leaves the same tombstone
 *   trucking's own Delete button writes, so Records still shows the work.
 *
 *   AND IT CANNOT REACH WHAT WE NEVER SAW. The base only carries the forward
 *   dates the board was given, so a haul filed last month is in neither side
 *   of the diff and cannot be deleted by a drag made today.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const eq   = (label, got, want) => assert(label, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const deep = (label, got, want) => assert(label, JSON.stringify(got) === JSON.stringify(want),
                                          `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const SCHED = read('scheduler.html');
const BOARD = require(path.resolve(__dirname, '..', 'api/scheduler/board.js'));
const TRUCK = require(path.resolve(__dirname, '..', 'api/scheduler/trucking.js'));

const D1 = '2026-09-21', D2 = '2026-09-22';
const HAUL_KEY = 'fct_trucking_schedule';

/** A haul as the board payload delivers it. */
const haul = (id, driver, date, jobId, over) => Object.assign({
  id: 'tk¦' + HAUL_KEY + '¦' + id,
  resource: driver, kind: 'emp', division: 'trucking',
  jobId: jobId || (HAUL_KEY + '¦acme'), jobName: 'Acme', costCode: '', half: false,
  unit: 'T-14', start: '06:00', end: '15:00',
  src: { key: HAUL_KEY, id, jobId: jobId || (HAUL_KEY + '¦acme'),
         row: { id, driver, project: 'Acme', project_id: 'p1', customer: 'Acme Inc',
                unit: 'T-14', start: '06:00', end: '15:00', material: 'Base', notes: 'gate code 4' } },
}, over || {});
/** One of the board's own rows. */
const own = (id, r, div, jobId) => ({ id, resource: r, kind: 'emp', division: div || 'turf',
                                      jobId: jobId || 'j1', jobName: 'Job 1', costCode: '', half: false });

// ── The page's own splitters and joiners, in a vm ───────────────────────────
const FNS = ['isForeign', '_splitRows', 'ownRows', 'foreignRows', 'withForeign',
             'truckDirty', 'foreignLocked', 'stampHaul', 'haulRowOf', 'haulMapFor',
             'commitKey', 'conflictResourcesOn', 'jobById'];

function page(assignments, opts) {
  const o = opts || {};
  const sandbox = {
    console, JSON,
    state: { assignments: assignments || {}, board: { jobs: o.jobs || [] } },
    _n: 0,
    uid() { return 'u' + (++sandbox._n); },
  };
  vm.createContext(sandbox);
  vm.runInContext("let _foreignBase = " + JSON.stringify(o.base || '{}') + ';', sandbox, { filename: 'scheduler.html' });
  FNS.forEach(n => vm.runInContext(requireFn(SCHED, n, 'scheduler.html'), sandbox, { filename: 'scheduler.html' }));
  // _foreignBase is a `const`-scope binding inside the vm, so it is read back
  // out rather than off the sandbox object.
  sandbox.readBase = () => vm.runInContext('_foreignBase', sandbox);
  return sandbox;
}

console.log('\nTrucking, Dust Control and EES on the master schedule\n');

// ═══════════════════════════════════════════════════════════════════════════
console.log('[a haul is told apart from the board’s own work]');
{
  const p = page();
  eq('a row carrying src is a haul', p.isForeign(haul('h1', 'Dave', D1)), true);
  eq('and one without it is not',    p.isForeign(own('a1', 'Mike')), false);
  eq('a haul trucking filed with no id is locked',
     p.foreignLocked(haul('', 'Dave', D1, null, { src: { key: HAUL_KEY, id: '', jobId: 'x', row: {} } })), true);
  eq('an ordinary haul is not', p.foreignLocked(haul('h1', 'Dave', D1)), false);
  eq('and neither is one of ours', p.foreignLocked(own('a1', 'Mike')), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[the board keeps both; what it SAVES keeps one]');
{
  const map = { [D1]: [own('a1', 'Mike'), haul('h1', 'Dave', D1)], [D2]: [haul('h2', 'Dave', D2)] };
  const p = page(map);
  deep('ownRows drops every haul',       Object.keys(p.ownRows(map)),     [D1]);
  eq  ('and keeps only our row',          p.ownRows(map)[D1].length,       1);
  eq  ('  which is ours',                 p.ownRows(map)[D1][0].id,        'a1');
  deep('foreignRows is the other half',  Object.keys(p.foreignRows(map)), [D1, D2]);
  eq  ('  one haul each day',             p.foreignRows(map)[D1].length,   1);
  // A day left with nothing must not survive as an empty array: an empty day in
  // the blob is noise the merge then has to reconcile on every save.
  deep('a day with only hauls leaves no empty row behind',
       Object.keys(p.ownRows({ [D1]: [haul('h1', 'Dave', D1)] })), []);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[and putting them back together loses nothing]');
{
  const hauls = { [D1]: [haul('h1', 'Dave', D1)] };
  const ours  = { [D1]: [own('a1', 'Mike')], [D2]: [own('a2', 'Sam')] };
  const p = page({}, {});
  const joined = p.withForeign(ours, hauls);
  eq('the day with both carries both', joined[D1].length, 2);
  eq('  ours first',                   joined[D1][0].id, 'a1');
  eq('  the haul after it',            joined[D1][1].src.id, 'h1');
  eq('a day with only ours is untouched', joined[D2].length, 1);
  // The round trip is the invariant every merge site below depends on.
  deep('own → split → join is the map you started with',
       p.withForeign(p.ownRows(joined), p.foreignRows(joined)), joined);
}
{
  // With no second argument it reads the hauls off the board, which is what the
  // merge sites do: they hand it freshly merged OWN rows and nothing else.
  const p = page({ [D1]: [own('a1', 'Mike'), haul('h1', 'Dave', D1)] });
  const joined = p.withForeign({ [D1]: [own('a9', 'Ann')] });
  eq('it defaults to the hauls on the board', joined[D1].length, 2);
  eq('  the haul came along',                 joined[D1][1].src.id, 'h1');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[a haul edited here is dirty; nothing else is]');
{
  const hauls = { [D1]: [haul('h1', 'Dave', D1)] };
  const base  = JSON.stringify(hauls);
  const clean = page({ [D1]: [own('a1', 'Mike'), haul('h1', 'Dave', D1)] }, { base });
  eq('a board straight off the server is clean', clean.truckDirty(), false);

  const moved = page({ [D2]: [haul('h1', 'Dave', D2)] }, { base });
  eq('a haul moved to another day is dirty', moved.truckDirty(), true);

  const gone = page({ [D1]: [own('a1', 'Mike')] }, { base });
  eq('a haul taken off the board is dirty', gone.truckDirty(), true);

  // The point of diffing rather than flagging: editing our OWN rows must not
  // send anything to trucking.
  const ourEdit = page({ [D1]: [own('a1', 'Mike'), own('a2', 'Sam'), haul('h1', 'Dave', D1)] }, { base });
  eq('adding one of our own rows is not', ourEdit.truckDirty(), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[a booking made here on a trucking job becomes a haul there]');
{
  const job = { division: 'trucking', id: HAUL_KEY + '¦acme', name: 'Acme',
                src: { key: HAUL_KEY, label: 'Trucking', project: 'Acme', projectId: 'p1', customer: 'Acme Inc' } };
  const p = page();
  const o = { id: 'u0', resource: 'Dave', kind: 'emp', division: 'trucking', jobId: job.id, jobName: 'Acme', costCode: '', half: false };
  eq('it is stamped', p.stampHaul(o, job), true);
  eq('  with the blob it belongs in', o.src.key, HAUL_KEY);
  eq('  and a row id of its own',     typeof o.src.id === 'string' && o.src.id.length > 0, true);
  eq('  the booking id follows the row id', o.id, 'tk¦' + HAUL_KEY + '¦' + o.src.id);
  eq('  the haul knows its driver',   o.src.row.driver, 'Dave');
  eq('  and who the work is for',     o.src.row.project, 'Acme');
  eq('  and which project',           o.src.row.project_id, 'p1');
  eq('it now reads as a haul',        p.isForeign(o), true);

  // Two bookings must never share a row id, or the write-back files one row
  // twice and trucking keeps whichever it merged last.
  const o2 = { id: 'u0', resource: 'Ann', kind: 'emp', division: 'trucking', jobId: job.id, jobName: 'Acme' };
  p.stampHaul(o2, job);
  assert('two bookings get two row ids', o.src.id !== o2.src.id, o.src.id + ' vs ' + o2.src.id);

  // Copied FROM an existing haul — alt-dragged, or repeated across the row —
  // it is the same load run again, with only the id new.
  const o3 = { id: 'u0', resource: 'Dave', kind: 'emp', division: 'trucking', jobId: job.id, jobName: 'Acme' };
  p.stampHaul(o3, job, haul('h1', 'Dave', D1));
  eq('a copy carries the load',  o3.src.row.material, 'Base');
  eq('  and the notes',          o3.src.row.notes, 'gate code 4');
  eq('  and the truck',          o3.unit, 'T-14');
  eq('  and the hours',          o3.start, '06:00');
  assert('but not the id it was copied from', o3.src.id !== 'h1', o3.src.id);

  // A machine is this board's note about a haul. Trucking's rows are drivers.
  const eqp = { id: 'u9', resource: 'T-14', kind: 'equip', op: 'Dave', division: 'trucking', jobId: job.id };
  eq('equipment is not stamped', p.stampHaul(eqp, job), false);
  eq('  and stays ours',         p.isForeign(eqp), false);
  // A job with no src is a job in some other division; nothing to file there.
  eq('nor is a booking on a turf job', p.stampHaul({ id: 'u8', resource: 'Dave', kind: 'emp' }, { division: 'turf', id: 'j1', name: 'Job 1' }), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[the row sent back is the row that came, not what fits here]');
{
  const p = page();
  const a = haul('h1', 'Dave', D1);
  const row = p.haulRowOf(a);
  eq('the material survives a move made here', row.material, 'Base');
  eq('and the notes',                          row.notes, 'gate code 4');
  eq('and the truck',                          row.unit, 'T-14');
  eq('and the hours',                          row.start, '06:00');
  eq('the id is trucking’s, not the board’s', row.id, 'h1');

  // Changing the driver is the "Dave’s out, give it to Mike" move.
  const handed = p.haulRowOf({ ...a, resource: 'Mike' });
  eq('a hand-over changes the driver', handed.driver, 'Mike');
  eq('  and nothing else',             handed.notes, 'gate code 4');
  eq('  on the same haul',             handed.id, 'h1');
  eq('  still for the same customer',  handed.project, 'Acme');
}
{
  // Moved to another haul: the job fields are rewritten from the job it landed
  // on. Only then — re-saving a row nobody moved must not normalise a customer
  // somebody spelled by hand.
  const jobs = [{ division: 'trucking', id: HAUL_KEY + '¦borden', name: 'Borden',
                  src: { key: HAUL_KEY, project: 'Borden', projectId: 'p2', customer: 'Borden LLC' } }];
  const p = page({}, { jobs });
  const a = haul('h1', 'Dave', D1);
  const moved = p.haulRowOf({ ...a, jobId: HAUL_KEY + '¦borden', jobName: 'Borden' });
  eq('a haul moved to another job is retitled', moved.project, 'Borden');
  eq('  with that job’s project id',          moved.project_id, 'p2');
  eq('  and its customer',                       moved.customer, 'Borden LLC');
  eq('  but keeps the load',                     moved.material, 'Base');
  const still = p.haulRowOf(a);
  eq('a haul that did not move keeps its own spelling', still.customer, 'Acme Inc');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[what is sent, and what is left out]');
{
  const p = page();
  const LABOR = 'fct_trucking_labor_schedule';
  const locked = haul('', 'Zed', D1, null, { src: { key: HAUL_KEY, id: '', jobId: 'x', row: {} } });
  const map = {
    [D2]: [haul('h2', 'Ann', D2)],
    [D1]: [own('a1', 'Mike'), haul('h1', 'Dave', D1), locked,
           haul('L1', 'Sam', D1, null, { src: { key: LABOR, id: 'L1', jobId: 'y', row: { id: 'L1', driver: 'Sam' } } })],
  };
  const out = p.haulMapFor(map, HAUL_KEY);
  deep('one board at a time, in date order', Object.keys(out), [D1, D2]);
  eq('our own rows are not sent',            out[D1].length, 1);
  eq('  only the haul from this blob',       out[D1][0].id, 'h1');
  eq('the other blob’s rows go in their own call', p.haulMapFor(map, LABOR)[D1][0].id, 'L1');
  // A row trucking cannot key is shown on the board and never written.
  assert('a haul with no id is left out', !out[D1].some(r => r.id === ''));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[several hauls in a day is a trucking day, not a clash]');
{
  const p = page();
  const two = { [D1]: [haul('h1', 'Dave', D1, HAUL_KEY + '¦acme'),
                       haul('h2', 'Dave', D1, HAUL_KEY + '¦borden')] };
  const p2 = page(two);
  eq('a driver on two hauls is not double-booked', p2.conflictResourcesOn(D1).size, 0);

  const both = page({ [D1]: [haul('h1', 'Dave', D1), own('a1', 'Dave')] });
  eq('a haul AND a turf job is', both.conflictResourcesOn(D1).size, 1);
  assert('and it is him', both.conflictResourcesOn(D1).has('Dave'));

  const twoJobs = page({ [D1]: [own('a1', 'Dave', 'turf', 'j1'), own('a2', 'Dave', 'paving', 'j2')] });
  eq('two ordinary jobs still clash', twoJobs.conflictResourcesOn(D1).size, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[every path that persists or compares carries our rows only]');
{
  // Read as source rather than run: these are the lines that would leak a haul
  // into the scheduler's own blob, and each has to name ownRows().
  const mustOwn = [
    ['the local cache',            "_writeLocal"],
    ['the dirty/baseline snapshot', "function _snap()"],
  ];
  mustOwn.forEach(([what, anchor]) => {
    const src = requireFn(SCHED, anchor.replace('function ', '').replace('()', ''), 'scheduler.html');
    assert(what + ' is own rows only', /ownRows\(/.test(src), src.slice(0, 120));
  });
  const puts = SCHED.match(/_putKey\(ASSIGN_KEY,[^\n]*/g) || [];
  eq('both saves of the board’s blob are found', puts.length, 2);
  puts.forEach((p, i) => assert('  save ' + (i + 1) + ' sends own rows only', /ownRows\(state\.assignments\)/.test(p), p));
}
{
  // And every wholesale replacement of state.assignments puts the hauls back.
  const lines = SCHED.split('\n').filter(l => /state\.assignments = [^[]/.test(l));
  assert('every replacement of the map is accounted for', lines.length === 6, 'found ' + lines.length);
  lines.forEach(l => {
    const ok = /withForeign\(/.test(l) || /_undoSnap|_undo\.pop|_redo\.pop/.test(l);
    assert('  ' + l.trim().slice(0, 64) + '…', ok, l.trim());
  });
  // Undo carries the whole map, hauls included — it never reaches a blob.
  assert('undo snapshots the whole map', /function _undoSnap\(\) \{ return JSON\.stringify\(state\.assignments\); \}/.test(SCHED));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[the server replays our difference over theirs]');
{
  const base   = { [D1]: [{ id: 'h1', driver: 'Dave' }, { id: 'h2', driver: 'Ann' }] };
  const ours   = { [D2]: [{ id: 'h1', driver: 'Mike' }] };               // moved day, new driver; h2 removed
  const theirs = { [D1]: [{ id: 'h1', driver: 'Dave' }, { id: 'h2', driver: 'Ann' }],
                   [D2]: [{ id: 'h9', driver: 'Zed' }] };                // the dispatcher added one meanwhile
  const out = TRUCK.merge3(base, ours, theirs);
  deep('our move lands',      out[D2].find(r => r.id === 'h1'), { id: 'h1', driver: 'Mike' });
  assert('our removal lands', !(out[D1] || []).some(r => r.id === 'h2'));
  assert('and the dispatcher keeps his row', out[D2].some(r => r.id === 'h9'));
  assert('nothing of ours is on the old day', !(out[D1] || []).some(r => r.id === 'h1'));
}
{
  // The base is only the forward dates the board was handed, so a haul filed
  // last month is in neither side of the diff and cannot be reached.
  const OLD = '2026-08-01';
  const out = TRUCK.merge3({ [D1]: [{ id: 'h1', driver: 'Dave' }] }, {},
                           { [OLD]: [{ id: 'old', driver: 'Ray' }], [D1]: [{ id: 'h1', driver: 'Dave' }] });
  assert('history is untouched', (out[OLD] || []).some(r => r.id === 'old'));
  assert('and the row we dropped is gone', !(out[D1] || []).length);
}
{
  const t = TRUCK.tombstone({ id: 'h1', driver: 'Dave', notes: '', unit: 'T-14' }, D1, 'ben');
  eq('a removal keeps the row',  t.unit, 'T-14');
  eq('  the day it was on',      t._d, D1);
  eq('  and who took it off',    t.removedBy, 'ben');
  assert('empty fields are dropped', !('notes' in t));
  assert('and it is stamped',        typeof t.removedAt === 'string' && t.removedAt.length > 0);
}
{
  eq('only trucking’s two keys are writable', TRUCK.TRUCKING_KEYS.size, 2);
  assert('the haul board', TRUCK.TRUCKING_KEYS.has('fct_trucking_schedule'));
  assert('and the labor board', TRUCK.TRUCKING_KEYS.has('fct_trucking_labor_schedule'));
  assert('and nothing else', !TRUCK.TRUCKING_KEYS.has('fct_scheduler_assignments'));

  // A malformed payload is refused before it can reach the blob.
  assert('a row with no id is refused',   !!TRUCK.readMap({ [D1]: [{ driver: 'Dave' }] }, 'rows').error);
  assert('a key that is not a date is',   !!TRUCK.readMap({ nope: [] }, 'rows').error);
  assert('and a day that is not a list',  !!TRUCK.readMap({ [D1]: 'x' }, 'rows').error);
  assert('a well-formed map is accepted', !TRUCK.readMap({ [D1]: [{ id: 'h1' }] }, 'rows').error);
  deep('and an absent one reads empty',   TRUCK.readMap(undefined, 'base').map, {});
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[the board offers the rest of the company]');
// A fake `sql` so the readers below can actually RUN. Everything they touch is
// one of three things: the dust customer table, the trucking roster blob, or a
// trucking schedule blob.
function fakeSql(data) {
  return (strings, ...vals) => {
    const q = strings.join(' ? ');
    if (/FROM dust_companies/.test(q))   return Promise.resolve(data.dustCompanies || []);
    if (/FROM dropdown_lists/.test(q))   return Promise.resolve([]);
    if (/FROM app_data/.test(q)) {
      // The scoped key is interpolated; the legacy unscoped one is a literal.
      const key = vals.length ? String(vals[0]) : (q.match(/'([^']+)'/) || [])[1];
      const v = (data.appData || {})[key];
      return Promise.resolve(v === undefined ? [] : [{ value: v }]);
    }
    return Promise.resolve([]);
  };
}
{
  // Dust and EES come off the very function the Timesheet's job picker uses,
  // so the two screens cannot disagree about what work exists — a man
  // scheduled on a customer the picker has never heard of could not then book
  // his hours against it.
  const sql = fakeSql({ dustCompanies: [{ id: 'c1', name: 'Acme Pit' }, { id: 'c2', name: 'Borden Yard' }] });
  return BOARD.readDustAndEes(sql, 'FCT').then(out => {
    deep('every dust customer is a row', out.dust.map(j => j.name), ['Acme Pit', 'Borden Yard']);
    eq  ('under the dust division',       out.dust[0].division, 'dust');
    eq  ('  keeping the timesheet\u2019s own job id', out.dust[0].id, 'c1');
    assert('and carrying no sub-codes, so nothing paces it', out.dust.every(j => !j.subCodes.length));

    // EES is not a dust customer: Pre Loading and Washing are two standing
    // activities, and on a schedule they are their own line of work.
    deep('EES is lifted out into its own division', out.ees.map(j => j.name),
         ['EES - Pre Loading', 'EES - Washing']);
    assert('  all of it',                  out.ees.every(j => j.division === 'ees'));
    assert('  and none of it left in dust', !out.dust.some(j => /^EES/.test(j.name)));
    // The shared id is the point: a man scheduled on ees:washing and a man who
    // books to ees:washing are on the same string, in both screens.
    deep('the ids are the timesheet\u2019s',  out.ees.map(j => j.id), ['ees:preloading', 'ees:washing']);
    assert('and EES paces nothing either',  out.ees.every(j => !j.subCodes.length));
    return runTruckingJobsCase();
  }).then(finish);
}

function runTruckingJobsCase() {
  // A trucking customer with nothing booked is still somewhere to send a
  // driver — off the same roster the Timesheet reads, not a second list.
  const sql = fakeSql({ appData: {
    'FCT:fct_truck_division_lists': { customers: ['Ox Hill', 'Kinkead HC'] },
    'FCT:fct_trucking_schedule': { version: 1, assignments: {
      '2999-01-01': [{ id: 'h1', driver: 'Dave', project: 'Ox Hill', unit: 'T-1' }],
      '1999-01-01': [{ id: 'old', driver: 'Ray', project: 'Gone Co' }],
    } },
  } });
  return BOARD.readTruckingBoards(sql, 'FCT', '2026-09-21').then(out => {
    const names = out.jobs.map(j => j.name);
    assert('a customer with nothing on is offered', names.includes('Kinkead HC'), names.join(', '));
    assert('and one with a haul on it is too',      names.includes('Ox Hill'), names.join(', '));
    eq  ('  once, not twice',                       names.filter(n => n === 'Ox Hill').length, 1);
    assert('the haul itself comes through',         !!(out.assignments['2999-01-01'] || []).length);
    // Forward work only. The base a write-back sends is built from what was
    // read, so a haul left out here is one nothing done on this board can reach.
    assert('a haul before today is left in the archive', !out.assignments['1999-01-01']);
    assert('and its customer is not raised as a job',    !names.includes('Gone Co'), names.join(', '));
    const j = out.jobs.find(x => x.name === 'Ox Hill');
    eq('a new haul booked here knows which blob to go in', j && j.src.key, 'fct_trucking_schedule');
  });
}

function finish() {
  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
