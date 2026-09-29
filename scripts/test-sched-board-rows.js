#!/usr/bin/env node
'use strict';
/**
 * Each section shows what is being worked: picked customers, and off-project
 * work of its own.
 *
 * Run: node scripts/test-sched-board-rows.js
 *
 * Dust Control and Trucking bring every customer they have — the Timesheet's
 * whole picker list — while the crews work for a couple at a time, so those two
 * sections were a long list of empty rows around the two that mattered.
 *
 * WHAT A SECTION SHOWS. In Dust Control and Trucking, the customers a scheduler
 * picked from the section's + list, and any with work booked on the days on
 * screen; everywhere else every live job, as before, with any row able to be
 * taken off (×) and put back from the same list. A booked row is always drawn,
 * and is never offered for taking off. A search looks through everything, and
 * a row it finds offers "+ board".
 *
 * WHERE A PICK IS KEPT. fct_scheduler_rows, one key per row, written as it is
 * clicked: PATCH merges the one key once the object exists; the first pick a
 * company makes reads what is there and writes the whole object, and a read
 * that fails writes nothing.
 *
 * OFF-PROJECT WORK IN A DIVISION. + Work on a section's header makes work that
 * belongs to that division: drawn in its section, dashed in its colour, tagged
 * off project, keyed apart from the same words in another division, carried on
 * the booking (`home`), and printed under the division on the dispatch sheet.
 * Work with no division stays in the Off project group, keyed as it always was.
 *
 * No DB, server or browser required; jsdom only.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`); }
}
const eq = (label, got, want) => assert(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'scheduler.html'), 'utf8');
const pad = n => String(n).padStart(2, '0');
const ds  = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const D1  = ds(new Date());
const HAUL_KEY = 'fct_trucking_schedule';

const CUSTOMERS = ['Acme Pit', 'Borden LLC', 'Cedar Pad', 'Dunmore Sand', 'Elk Ridge', 'Fayette Stone', 'Glen Rock', 'Hanover Aggregates'];
const HAULERS   = ['Keystone Paving', 'Laurel Hill', 'Mercer Farms', 'Northgate'];
const job = (division, id, name, extra) => Object.assign({ division, id, name, jobNumber: '', status: 'Active', deadline: null, subCodes: [], bidValue: 0 }, extra || {});
function boardPayload() {
  return {
    generatedAt: new Date().toISOString(),
    employees: [{ name: 'Blake Hostetler', jobClass: 'Laborer' }, { name: 'Colton Reed', jobClass: 'Operator' }, { name: 'Dave Wilson', jobClass: 'Driver', isDriver: true }],
    offScheduler: [], equipment: ['T-14'],
    jobs: [
      job('turf', 'j1', 'Riverbend', { jobNumber: '26001', subCodes: [{ costCode: '3100', subCode: '', status: 'on-track', pctComplete: 10 }] }),
      job('turf', 'j2', 'Mill Street', { jobNumber: '26002', subCodes: [{ costCode: '3100', subCode: '', status: 'on-track', pctComplete: 40 }] }),
      job('paving', 'p1', 'Glen Campbell Grind', { jobNumber: '26069', subCodes: [{ costCode: '420', subCode: '', status: 'on-track', pctComplete: 0 }] }),
      ...CUSTOMERS.map((n, i) => job('dust', 'c' + (i + 1), n)),
      job('ees', 'ees:preloading', 'EES - Pre Loading'), job('ees', 'ees:washing', 'EES - Washing'),
      ...HAULERS.map(n => job('trucking', HAUL_KEY + '¦' + n.toLowerCase(), n, { src: { key: HAUL_KEY, label: 'Trucking', project: n, projectId: '', customer: n } })),
    ],
    plannedAssignments: [], timeOff: {}, excludedJobs: 0, truckingAssignments: {
      // Laurel Hill has a haul today, straight off Trucking's dispatch board.
      [D1]: [{ id: 'tk¦' + HAUL_KEY + '¦h1', resource: 'Dave Wilson', kind: 'emp', division: 'trucking', jobId: HAUL_KEY + '¦laurel hill',
               jobName: 'Laurel Hill', costCode: '', half: false, unit: 'T-14', start: '06:00', end: '14:00',
               src: { key: HAUL_KEY, id: 'h1', jobId: HAUL_KEY + '¦laurel hill', row: { id: 'h1', driver: 'Dave Wilson', project: 'Laurel Hill' } } }],
    },
    loginNames: {}, unmatchedLogins: [], manualLogins: [], offCrewLogins: [], loginGuesses: {},
    sourceDivisions: ['turf', 'paving', 'kiewit', 'dust', 'ees', 'trucking'], projectDivisions: ['turf', 'paving', 'kiewit'],
  };
}
// Cedar Pad is booked today; Paving has a shop day of its own; there is a site
// visit belonging to no division, booked before any of this existed.
const SAVED = () => ({ version: 1, siteTimes: {}, assignments: { [D1]: [
  { id: 'a1', resource: 'Blake Hostetler', kind: 'emp', division: 'dust', jobId: 'c3', jobName: 'Cedar Pad', costCode: '', half: false },
  { id: 'a2', resource: 'Colton Reed', kind: 'emp', division: 'other', jobId: 'other::paving::shop', jobName: 'Shop', home: 'paving', costCode: '', half: false },
  { id: 'a3', resource: 'Colton Reed', kind: 'emp', division: 'other', jobId: 'other::site visit', jobName: 'Site visit', costCode: '', half: false },
] } });
const SESSION = { fct_token: 'harness', fct_division: 'turf',
  fct_user: JSON.stringify({ userId: 1, username: 'harness', companyCode: 'FCT', isPlatformAdmin: true, divisionRoles: { turf: 'level5', scheduler: 'level5' } }) };

/**
 * scheduler.html, booted. `rows` is what the stored picks read as (null for
 * none yet); `rowsRead` can make the read-before-first-write fail.
 */
function boot(opts = {}) {
  const errors = [], writes = [];
  let rowsGets = 0;
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/i.test(e.message || '')) errors.push(e.message); });
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://datawatch.app/scheduler.html', virtualConsole: vc,
    beforeParse(w) {
      Object.entries(SESSION).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.fetch = (url, o) => {
        const u = String(url), req = o || {};
        if (req.method && req.method !== 'GET') writes.push({ url: u, method: req.method, body: req.body ? JSON.parse(req.body) : null });
        if (u.includes('fct_scheduler_rows') && (!req.method || req.method === 'GET')) {
          rowsGets++;
          if (opts.rowsRead === 'fail' && rowsGets > 1) return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'database unreachable' }) });
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ value: opts.rows === undefined ? { 'dust::c2': 'show' } : opts.rows }) });
        }
        const data = u.includes('/api/scheduler/board') ? boardPayload()
                   : u.includes('fct_scheduler_assignments') ? { value: SAVED() }
                   : u.includes('/api/data/') ? { value: null } : { ok: true };
        return Promise.resolve({ ok: true, status: 200, json: async () => data, text: async () => '' });
      };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      w.scrollTo = () => {}; w.alert = () => {}; w.confirm = () => true; w.prompt = () => opts.prompt || null;
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  const w = dom.window, doc = w.document;
  // The board as sections: badge text → the rows under it, in order.
  const sections = () => {
    const out = {}; let cur = null;
    [...doc.querySelectorAll('#main table.board tbody tr')].forEach(tr => {
      if (tr.classList.contains('div-row')) { cur = (tr.querySelector('.div-badge') || {}).textContent.trim(); out[cur] = []; return; }
      const lead = tr.querySelector('.jl-main') || tr.querySelector('td.lead-col'); if (cur && lead) out[cur].push(lead.textContent.replace(/\s+/g, ' ').trim());
    });
    return out;
  };
  const header = badge => [...doc.querySelectorAll('#main tr.div-row')].find(tr => (tr.querySelector('.div-badge') || {}).textContent.trim() === badge);
  const pickList = badge => { const h = header(badge); const sel = h && h.querySelector('select.grp-add'); return sel ? [...sel.options].slice(1).map(o => o.textContent) : []; };
  const pick = (badge, name) => {
    const sel = header(badge).querySelector('select.grp-add');
    sel.value = [...sel.options].find(o => o.textContent === name || o.textContent.startsWith(name + ' #')).value;
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const rowOf = name => [...doc.querySelectorAll('#main tr.job-row')].find(tr => { const l = tr.querySelector('.jl-main'); return l && l.textContent.includes(name); });
  const toast = () => (doc.getElementById('toast') || {}).textContent || '';
  const main = () => (doc.getElementById('main') || {}).innerHTML || '';
  return { dom, w, doc, errors, writes, sections, header, pickList, pick, rowOf, toast, main, rowsGets: () => rowsGets };
}
const settle = () => new Promise(r => setTimeout(r, 900));
const tick = () => new Promise(r => setTimeout(r, 30));
const names = rows => rows.map(r => r.replace(/ [×✕].*$| \+ board.*$/, '').replace(/ #\d+/, '').replace(/^off project /, ''));

(async () => {
  console.log('Each section shows what is being worked\n');

  console.log('[what each section shows]');
  {
    const p = boot(); await settle();
    assert('the page boots with nothing thrown', p.errors.length === 0, p.errors[0]);
    const s = p.sections();
    eq('Turf shows every live job, as it always has', names(s.Turf), ['Mill Street', 'Riverbend']);
    eq('Dust Control shows the customer picked, and the one booked today — not the other six', names(s['Dust Control']).sort(), ['Borden LLC', 'Cedar Pad']);
    eq('Trucking shows the customer with a haul today, and none of the rest', names(s.Trucking), ['Laurel Hill']);
    eq('EES shows both activities', names(s.EES).sort(), ['EES - Pre Loading', 'EES - Washing']);
    eq('the rest of Dust Control wait in its + list', p.pickList('Dust Control'), ['Acme Pit', 'Dunmore Sand', 'Elk Ridge', 'Fayette Stone', 'Glen Rock', 'Hanover Aggregates']);
    assert('  which says how many', /\+ Customer \(6\)/.test(p.header('Dust Control').textContent), p.header('Dust Control').textContent);
    eq('and the rest of Trucking in its', p.pickList('Trucking'), ['Keystone Paving', 'Mercer Farms', 'Northgate']);
    assert('the header counts customers where the board picks them', /2 customers/.test(p.header('Dust Control').textContent) && /2 jobs/.test(p.header('Turf').textContent));
    assert('a section with everything on it has no + list, but still has + Work', !p.header('EES').querySelector('select.grp-add') && !!p.header('EES').querySelector('.grp-work'));
    assert('a job nobody is booked on can be taken off', !!p.rowOf('Riverbend').querySelector('.row-x:not(.pin)'));
    assert('  a customer with crew booked today cannot', !p.rowOf('Cedar Pad').querySelector('.row-x'));
    assert('  nor a haul Trucking has booked', !p.rowOf('Laurel Hill').querySelector('.row-x'));
    p.w.dropBoardRow('dust', 'c3');
    assert('  and asking anyway says why, and changes nothing', /Cedar Pad has crew booked/.test(p.toast()) && p.writes.length === 0, p.toast());
    p.w.close();
  }

  console.log('\n[picking a customer, and taking a job off]');
  {
    const p = boot(); await settle();
    p.pick('Dust Control', 'Elk Ridge'); await tick();
    assert('picking one from the + list puts it on the board', names(p.sections()['Dust Control']).includes('Elk Ridge'));
    assert('  and out of the list', !p.pickList('Dust Control').includes('Elk Ridge'));
    const w1 = p.writes.find(x => x.url.includes('fct_scheduler_rows'));
    eq('  saved for everyone as one key merged into what is stored', w1 && { method: w1.method, body: w1.body }, { method: 'PATCH', body: { fields: { 'dust::c5': 'show' } } });
    p.rowOf('Riverbend').querySelector('.row-x').click(); await tick();
    assert('× takes a job off the board', !names(p.sections().Turf).includes('Riverbend'));
    eq('  into Turf’s own + list, with its job number', p.pickList('Turf'), ['Riverbend #26001']);
    const w2 = p.writes.filter(x => x.url.includes('fct_scheduler_rows'))[1];
    eq('  saved the same way', w2 && w2.body, { fields: { 'turf::j1': 'hide' } });
    p.pick('Turf', 'Riverbend'); await tick();
    assert('and the list puts it back', names(p.sections().Turf).includes('Riverbend'));

    p.w.eval("state.jobSearch = 'fayette'; render();");
    const found = p.rowOf('Fayette Stone');
    assert('a search finds a customer that is not on the board', !!found);
    assert('  and offers to put it there', !!found.querySelector('.row-x.pin'));
    found.querySelector('.row-x.pin').click(); await tick();
    p.w.eval("state.jobSearch = ''; render();");
    assert('  which keeps it there once the search is cleared', names(p.sections()['Dust Control']).includes('Fayette Stone'));
    p.w.close();
  }

  console.log('\n[the first pick a company makes]');
  {
    const p = boot({ rows: null }); await settle();
    p.pick('Dust Control', 'Acme Pit'); await tick(); await tick();
    const put = p.writes.find(x => x.url.includes('fct_scheduler_rows'));
    eq('  reads what is stored, then writes the whole object', put && { method: put.method, body: put.body }, { method: 'PUT', body: { value: { 'dust::c1': 'show' } } });
    p.pick('Dust Control', 'Borden LLC'); await tick();
    const next = p.writes.filter(x => x.url.includes('fct_scheduler_rows'))[1];
    eq('  and every pick after that merges one key', next && next.method, 'PATCH');
    p.w.close();

    const q = boot({ rows: null, rowsRead: 'fail' }); await settle();
    q.pick('Dust Control', 'Acme Pit'); await tick(); await tick();
    assert('a read that fails writes nothing over what might be there', !q.writes.some(x => x.url.includes('fct_scheduler_rows')));
    assert('  and says so', /Could not save that for everyone/.test(q.toast()), q.toast());
    q.w.close();
  }

  console.log('\n[a section with nothing on it]');
  {
    const p = boot({ rows: {} }); await settle();
    p.w.eval("state.assignments[" + JSON.stringify(D1) + "] = state.assignments[" + JSON.stringify(D1) + "].filter(a => a.division !== 'dust'); render();");
    const dust = p.sections()['Dust Control'];
    assert('is still drawn, so its + list can be reached', !!dust && !!p.header('Dust Control').querySelector('select.grp-add'));
    assert('  and says how to fill it', dust && /No customers on the board — pick one from \+ Customer/.test(dust.join(' ')), JSON.stringify(dust));
    p.w.eval("state.needCrewOnly = true; render();");
    assert('  but not when the board is narrowed to jobs needing crew', !p.sections()['Dust Control']);
    p.w.close();
  }

  console.log('\n[off-project work in a division]');
  {
    const p = boot({ prompt: 'Shop' }); await settle();
    const s = p.sections();
    assert('Paving’s shop day is drawn in the Paving section', (s.Paving || []).some(r => /off project Shop/.test(r)), JSON.stringify(s.Paving));
    assert('  not in the Off project group', !((s['off project'] || []).some(r => /Shop/.test(r))));
    assert('work with no division is still in the Off project group, keyed as before', (s['off project'] || []).some(r => /Site visit/.test(r)));
    const pavingShop = p.rowOf('off project Shop');
    assert('  dashed, in the division’s colour', /border-left:3px dashed #60a5fa/.test(pavingShop.querySelector('td.lead-col').getAttribute('style')), pavingShop.querySelector('td.lead-col').getAttribute('style'));

    p.header('Turf').querySelector('.grp-work').click(); await tick();
    const turf = p.sections().Turf;
    assert('+ Work on the Turf header makes a Turf row', turf.some(r => /off project Shop/.test(r)), JSON.stringify(turf));
    const modal = (p.doc.getElementById('assignOverlay') || {}).innerHTML || '';
    assert('  and opens it to staff, badged as Turf’s', /Turf · off project/.test(modal), modal.slice(0, 300));
    p.w.pickAdd('Blake Hostetler', 'emp'); await tick();
    const booked = p.w.eval('state').assignments[p.w.eval('firstWorkdayThisWeek()')].find(a => a.resource === 'Blake Hostetler' && a.division === 'other');
    eq('  the booking carries its division', booked && { jobId: booked.jobId, jobName: booked.jobName, home: booked.home }, { jobId: 'other::turf::shop', jobName: 'Shop', home: 'turf' });
    assert('  and is a different row from Paving’s shop', booked.jobId !== 'other::paving::shop');
    p.w.closeAssign();
    const kpi = /cap-val[^>]*>(\d+)<\/div><div class="cap-lbl">Off-project/.exec(p.main());
    assert('the Off-project count includes it', !!kpi && Number(kpi[1]) >= 2, kpi && kpi[1]);

    p.w.eval("state.divFilter = 'other'; render();");
    const all = p.sections()['off project'] || [];
    assert('filtered to Off project, every piece of off-project work is listed, each naming its division',
      all.some(r => /Paving · off project Shop/.test(r)) && all.some(r => /Site visit/.test(r)), JSON.stringify(all));
    p.w.eval("state.divFilter = 'all'; render();");

    const sheet = p.w.dispatchBodyJob([D1]);
    assert('the dispatch sheet prints it under the division', /PAVING · OFF PROJECT · Shop/.test(sheet), sheet.slice(0, 400));
    assert('  and work with no division as before', /OTHER WORK · Site visit/.test(sheet));
    p.w.close();
  }

  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('Harness error:', err); process.exit(1); });
