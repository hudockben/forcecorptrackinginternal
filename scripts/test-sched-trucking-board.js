#!/usr/bin/env node
'use strict';
/**
 * The Scheduler with Trucking on it, running.
 *
 * Run: node scripts/test-sched-trucking-board.js
 *
 * test-sched-trucking.js lifts the pieces out of the page and checks each on
 * its own. This boots the whole page instead — a real DOM, a stubbed board
 * endpoint carrying a turf job, a dust customer and one haul — drags things
 * around it, and reads what the page tried to SAVE. It is the only check that
 * can catch the failures that live in the wiring rather than in any one
 * function, and the first run of it caught exactly that: dropOnJobCell moved a
 * haul by cutting a fresh booking and deleting the old one, which read as
 * correct everywhere except in what reached trucking — a new row id, and the
 * truck, hours, material and notes gone.
 *
 * The four operations a dispatcher actually does to a haul from here, and what
 * each has to mean in trucking's blob:
 *
 *   MOVE it to another day or another customer  → the same row, moved.
 *   COPY it (Alt-drag, or repeat across a row)  → a second row, same load, new id.
 *   HAND it to another driver                   → the same row, new driver.
 *   TAKE it off                                 → gone from the rows, still in
 *                                                 the base, so the server files
 *                                                 the tombstone.
 *
 * And the two lines that must not be crossed: a haul never reaches the
 * scheduler's own blob, and the scheduler's own work never reaches trucking's.
 *
 * No DB or server required; jsdom only.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`); }
}
const eq = (label, got, want) => assert(label, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'scheduler.html'), 'utf8');

const pad = n => String(n).padStart(2, '0');
const ds  = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
// The board only draws from today forward, so the fixture has to move with it.
const TODAY = new Date();
const D1 = ds(TODAY);
const D2 = (() => { const x = new Date(TODAY); x.setDate(x.getDate() + 1); return ds(x); })();

const HAUL_KEY = 'fct_trucking_schedule';
const JOB_ID   = HAUL_KEY + '¦borden haul';
const AID      = 'tk¦' + HAUL_KEY + '¦h1';

/** One turf job, one dust customer, one haul already dispatched. */
const board = () => ({
  generatedAt: new Date().toISOString(),
  employees: [{ name: 'Dave Wilson' }, { name: 'Mike Ortiz' }],
  equipment: ['T-14'],
  jobs: [
    { division: 'turf', id: 'j1', name: 'Riverbend', jobNumber: '', status: 'Active', bidValue: 1,
      subCodes: [{ costCode: '3100', subCode: '3100.1', name: 'Fine grade', status: 'on-track' }] },
    { division: 'dust', id: 'dust¦acme', name: 'Acme Pit', status: 'Active', subCodes: [], bidValue: 0 },
    { division: 'trucking', id: JOB_ID, name: 'Borden Haul', status: 'Active', subCodes: [], bidValue: 0,
      src: { key: HAUL_KEY, label: 'Trucking', project: 'Borden Haul', projectId: 'p2', customer: 'Borden LLC' } },
  ],
  plannedAssignments: {}, timeOff: {}, excludedJobs: [],
  truckingAssignments: { [D1]: [{
    id: AID, resource: 'Dave Wilson', kind: 'emp', division: 'trucking', jobId: JOB_ID,
    jobName: 'Borden Haul', costCode: '', half: false, unit: 'T-14', start: '06:00', end: '15:00',
    src: { key: HAUL_KEY, id: 'h1', jobId: JOB_ID,
           row: { id: 'h1', driver: 'Dave Wilson', project: 'Borden Haul', project_id: 'p2',
                  customer: 'Borden LLC', unit: 'T-14', start: '06:00', end: '15:00',
                  material: 'Base', notes: 'gate 4' } } }] },
  sourceDivisions: ['turf', 'paving', 'kiewit', 'dust', 'trucking'],
});

const SESSION = { fct_token: 'harness', fct_division: 'turf',
  fct_user: JSON.stringify({ userId: 1, username: 'harness', companyCode: 'FCT', isPlatformAdmin: true,
                             divisionRoles: { turf: 'level5', scheduler: 'level5' } }) };

/** The page, booted, with every write it attempts captured. */
function boot() {
  const errors = [], writes = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/i.test(e.message || '')) errors.push(e.message); });
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://datawatch.app/scheduler.html', virtualConsole: vc,
    beforeParse(w) {
      Object.entries(SESSION).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.fetch = (url, opts) => {
        const u = String(url), o = opts || {};
        if (o.method && o.method !== 'GET') writes.push({ url: u, body: o.body });
        const data = u.includes('/api/scheduler/board') ? board()
                   : u.includes('/api/data/')           ? { value: null, updated_at: null }
                   : { ok: true };
        return Promise.resolve({ ok: true, status: 200, json: async () => data, text: async () => '' });
      };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      w.scrollTo = () => {}; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  // What was sent to trucking, and what was saved as the board's own.
  const toTrucking = () => writes.filter(x => x.url.includes('/api/scheduler/trucking')).map(x => JSON.parse(x.body));
  const toBoard    = () => writes.filter(x => x.url.includes('fct_scheduler_assignments')).map(x => JSON.parse(x.body).value);
  return { dom, w: dom.window, errors, writes, toTrucking, toBoard };
}
// Long enough for loadAll() and the debounced save behind it.
const settle = () => new Promise(r => setTimeout(r, 900));
const liveRows = b => Object.values((b && b.rows) || {}).flat();

(async () => {
  console.log('\nThe Scheduler with Trucking on it, running\n');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('[it comes up with the whole company on it]');
  {
    const p = boot(); await settle();
    const main = (p.w.document.getElementById('main') || {}).innerHTML || '';
    assert('nothing throws while the page boots', p.errors.length === 0, p.errors[0]);
    assert('it gets past the loading placeholder', !(p.w.document.body.textContent || '').includes('Loading master schedule'));
    assert('the turf job is drawn',     main.includes('Riverbend'));
    assert('the dust customer is too',  main.includes('Acme Pit'));
    assert('and the haul',              main.includes('Borden Haul'));
    assert('the haul chip names the driver', main.includes('Dave Wilson'));
    assert('  and is marked as one',    /class="asn[^"]* haul"/.test(main), main.match(/class="asn[^"]*"/g));
    assert('  and says which truck and what hours', main.includes('T-14') && main.includes('from Trucking'));
    const filter = (p.w.document.getElementById('divFilter') || {}).innerHTML || '';
    assert('the division filter offers Dust',     filter.includes('>Dust<'));
    assert('and Trucking',                        filter.includes('>Trucking<'));
    // Reading a board must not write one.
    eq('and simply opening the board saves nothing', p.writes.length, 0);
    p.w.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[move it: the same haul, another day]');
  {
    const p = boot(); await settle();
    p.w.dropOnJobCell(D1, AID, { date: D2, division: 'trucking', jobId: JOB_ID, costCode: '' }, false);
    await settle();
    const b = p.toTrucking()[0] || {};
    eq('it is sent to the haul blob', b.key, HAUL_KEY);
    assert('the base says where it was',  (b.base[D1] || []).some(r => r.id === 'h1'), JSON.stringify(b.base));
    assert('the rows say where it is now', (b.rows[D2] || []).some(r => r.id === 'h1'), JSON.stringify(b.rows));
    eq('one haul, not two',               liveRows(b).length, 1);
    const r = (b.rows[D2] || [])[0] || {};
    eq('  trucking’s own id survives', r.id, 'h1');
    eq('  and the material',                r.material, 'Base');
    eq('  and the notes',                   r.notes, 'gate 4');
    eq('  and the truck',                   r.unit, 'T-14');
    eq('  and the hours',                   r.start, '06:00');
    p.w.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[copy it: a second haul, the same load]');
  {
    const p = boot(); await settle();
    p.w.dropOnJobCell(D1, AID, { date: D2, division: 'trucking', jobId: JOB_ID, costCode: '' }, true);
    await settle();
    const b = p.toTrucking()[0] || {};
    eq('there are two hauls now', liveRows(b).length, 2);
    const made = liveRows(b).find(r => r.id !== 'h1') || {};
    assert('the new one has an id of its own', !!made.id && made.id !== 'h1', made.id);
    eq('  but the same load',                   made.material, 'Base');
    eq('  and the same truck',                  made.unit, 'T-14');
    assert('and the original is where it was, untouched',
           (b.rows[D1] || []).some(r => r.id === 'h1' && r.notes === 'gate 4'), JSON.stringify(b.rows[D1]));
    p.w.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[hand it over: the same haul, another driver]');
  {
    const p = boot(); await settle();
    p.w.dropOnResCell(D1, AID, { date: D1, resource: 'Mike Ortiz', rkind: 'emp' }, false);
    await settle();
    const rows = liveRows(p.toTrucking()[0]);
    eq('still one haul', rows.length, 1);
    eq('  the same one',  rows[0] && rows[0].id, 'h1');
    eq('  driven by the man it was handed to', rows[0] && rows[0].driver, 'Mike Ortiz');
    eq('  with the load untouched',            rows[0] && rows[0].material, 'Base');
    p.w.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[take it off: gone from the rows, still in the base]');
  {
    const p = boot(); await settle();
    p.w.removePersonAssignment(D1, AID);
    await settle();
    const b = p.toTrucking()[0] || {};
    // The base is how the server knows to file a tombstone rather than simply
    // not seeing the row: only an id we READ can be removed.
    assert('the base still names it', (b.base[D1] || []).some(r => r.id === 'h1'), JSON.stringify(b.base));
    eq('and nothing is sent as live',  liveRows(b).length, 0);
    p.w.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[a haul cannot quietly become a turf job]');
  {
    const p = boot(); await settle();
    p.w.dropOnJobCell(D1, AID, { date: D1, division: 'turf', jobId: 'j1', costCode: '' }, false);
    await settle();
    eq('nothing was sent to trucking', p.toTrucking().length, 0);
    const his = p.w.assignmentsFor(D1, 'Dave Wilson');
    eq('he is on one thing still', his.length, 1);
    assert('and it is the haul, where it was', his[0] && his[0].jobId === JOB_ID && !!his[0].src);
    p.w.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[dust is ours; the two blobs never cross]');
  {
    const p = boot(); await settle();
    p.w.placeOnJob(D1, p.w.jobById('dust', 'dust¦acme'), '', { resource: 'Mike Ortiz', kind: 'emp' });
    p.w.saveAssignments();
    await settle();
    const saved = p.toBoard().pop() || {};
    const rows  = Object.values(saved.assignments || {}).flat();
    assert('the dust booking is in the board’s own blob',
           rows.some(r => r.division === 'dust' && r.resource === 'Mike Ortiz'), JSON.stringify(rows));
    assert('with no haul alongside it', !rows.some(r => r.src), JSON.stringify(rows));
    eq('and nothing went to trucking',  p.toTrucking().length, 0);
    p.w.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[repeat the week: every haul gets an id of its own]');
  {
    // The one bulk path into another division's data. A clone that kept the
    // original's row id would file one haul under two dates, and trucking would
    // keep whichever of them its merge saw last.
    const p = boot(); await settle();
    p.w.copyWeekForward();
    await settle();
    const rows = liveRows(p.toTrucking()[0]);
    eq('next week carries the haul too', rows.length, 2);
    eq('  and the two rows have two ids', new Set(rows.map(r => r.id)).size, 2);
    const copy = rows.find(r => r.id !== 'h1') || {};
    eq('  the repeat carries the load',   copy.material, 'Base');
    eq('  and the driver',                copy.driver, 'Dave Wilson');
    p.w.close();
  }

  console.log('\n[which is the point: the clash you could not see before]');
  {
    const p = boot(); await settle();
    p.w.placeOnJob(D1, p.w.jobById('turf', 'j1'), '', { resource: 'Dave Wilson', kind: 'emp' });
    assert('a driver on a haul AND a turf job is double-booked', p.w.conflictResourcesOn(D1).has('Dave Wilson'));
    eq('and a man on a haul is never counted spare', p.w.bookedInView('Dave Wilson'), true);
    p.w.close();
  }

  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
