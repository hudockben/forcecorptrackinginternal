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
 * ticked in the section's checklist, and any with work booked on the days on
 * screen; everywhere else every live job, as before, with any row able to be
 * unticked (or ×'d) and ticked back. A booked row is always drawn, stays
 * ticked and cannot be unticked. A search looks through everything, and a row
 * it finds offers "+ board".
 *
 * THE CHECKLIST. + Customers / + Jobs on a section's header opens every row the
 * section has, on the board or not, with a search box when the list is long.
 * Tick several and Save puts them all on in one write; clicking away saves the
 * same way; Cancel, ✕ and Escape leave the board as it was. It lives outside
 * the board, so a redraw keeps what was ticked.
 *
 * WHERE A PICK IS KEPT. fct_scheduler_rows, one key per row: PATCH merges the
 * keys once the object exists; the first save a company makes reads what is
 * there and writes the whole object, and a read that fails writes nothing.
 * Saves go out one after another, so two made at once cannot race.
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
      ...CUSTOMERS.map((n, i) => job('dust', 'c' + (i + 1), n, n === 'Hanover Aggregates' ? { jobNumber: '7788' } : {})),
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
  // The checklist: the header's button, the panel it opens, and what the
  // panel says — group title → [{ name, on, locked }].
  const pickBtn = badge => { const h = header(badge); return h && h.querySelector('.grp-pick'); };
  const pop = () => doc.getElementById('rowPickPop');
  const open = badge => { pickBtn(badge).click(); return pop(); };
  const checklist = () => {
    const el = pop(); if (!el) return null;
    const out = {};
    el.querySelectorAll('.rp-group').forEach(g => {
      out[g.querySelector('.rp-head').textContent.split(' · ')[0]] = [...g.querySelectorAll('.rp-row')].map(r => {
        const i = r.querySelector('input');
        return Object.assign({ name: r.querySelector('.rp-name').textContent, on: i.checked }, i.disabled ? { locked: true } : {});
      });
    });
    return out;
  };
  const box = name => { const r = [...pop().querySelectorAll('.rp-row')].find(x => x.querySelector('.rp-name').textContent === name); return r && r.querySelector('input'); };
  const tick = (...list) => list.forEach(n => box(n).click());
  const foot = () => pop().querySelector('.rp-sum').textContent;
  const saveBtn = () => doc.getElementById('rowPickSave');
  const visible = () => [...pop().querySelectorAll('.rp-row')].filter(r => !r.hidden).map(r => r.querySelector('.rp-name').textContent);
  const search = q => { const el = doc.getElementById('rowPickSearch'); el.value = q; el.dispatchEvent(new w.Event('input', { bubbles: true })); return el; };
  const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const rowsWrites = () => writes.filter(x => x.url.includes('fct_scheduler_rows'));
  const rowOf = name => [...doc.querySelectorAll('#main tr.job-row')].find(tr => { const l = tr.querySelector('.jl-main'); return l && l.textContent.includes(name); });
  const toast = () => (doc.getElementById('toast') || {}).textContent || '';
  const main = () => (doc.getElementById('main') || {}).innerHTML || '';
  return { dom, w, doc, errors, writes, sections, header, pickBtn, pop, open, checklist, box, tick, foot, saveBtn, visible, search, key, rowsWrites, rowOf, toast, main, rowsGets: () => rowsGets };
}
const settle = () => new Promise(r => setTimeout(r, 900));
const later = () => new Promise(r => setTimeout(r, 30));
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
    assert('the header counts customers where the board picks them', /2 customers/.test(p.header('Dust Control').textContent) && /2 jobs/.test(p.header('Turf').textContent));
    assert('Dust Control’s header has + Customers, saying how many are not on the board', /\+ Customers \(6\)/.test(p.pickBtn('Dust Control').textContent), p.header('Dust Control').textContent);
    assert('  Turf’s has + Jobs', /^\+ Jobs\b/.test(p.pickBtn('Turf').textContent.trim()), p.pickBtn('Turf').textContent);
    assert('a section with everything on it still has its checklist, to take one off, and + Work',
      /^\+ Jobs ▾$/.test(p.pickBtn('EES').textContent.trim()) && !!p.header('EES').querySelector('.grp-work'), p.header('EES').textContent);
    assert('no checklist is open until one is asked for', !p.pop());
    assert('a job nobody is booked on can be taken off with ×', !!p.rowOf('Riverbend').querySelector('.row-x:not(.pin)'));
    assert('  a customer with crew booked today cannot', !p.rowOf('Cedar Pad').querySelector('.row-x'));
    assert('  nor a haul Trucking has booked', !p.rowOf('Laurel Hill').querySelector('.row-x'));
    p.w.dropBoardRow('dust', 'c3');
    assert('  and asking anyway says why, and changes nothing', /Cedar Pad has crew booked/.test(p.toast()) && p.writes.length === 0, p.toast());
    p.w.close();
  }

  console.log('\n[the checklist]');
  {
    const p = boot(); await settle();
    p.open('Dust Control');
    assert('+ Customers opens Dust Control’s checklist', !!p.pop() && /Dust Control/.test(p.pop().querySelector('.rp-top').textContent), p.pop() && p.pop().textContent);
    assert('  and marks its button open', p.pickBtn('Dust Control').classList.contains('open'));
    eq('every customer is on it: the ones on the board ticked, the booked one locked', p.checklist(), {
      'On the board': [{ name: 'Borden LLC', on: true }, { name: 'Cedar Pad', on: true, locked: true }],
      'Not on the board': ['Acme Pit', 'Dunmore Sand', 'Elk Ridge', 'Fayette Stone', 'Glen Rock', 'Hanover Aggregates'].map(name => ({ name, on: false })),
    });
    const cedar = p.box('Cedar Pad').closest('.rp-row');
    assert('  the locked one says why', /booked/.test(cedar.textContent) && /take them off it/.test(cedar.getAttribute('title') || ''), cedar.outerHTML);
    assert('nothing ticked yet: Save waits', p.saveBtn().disabled && /Tick what to show/.test(p.foot()), p.foot());
    p.w.closeRowPicker();
    p.open('Trucking');
    eq('Trucking’s: the haul booked today locked on, the rest to tick', p.checklist(), {
      'On the board': [{ name: 'Laurel Hill', on: true, locked: true }],
      'Not on the board': [{ name: 'Keystone Paving', on: false }, { name: 'Mercer Farms', on: false }, { name: 'Northgate', on: false }],
    });
    p.open('Turf');
    assert('opening another section’s closes the first', p.doc.querySelectorAll('#rowPickPop').length === 1 &&
      /Turf/.test(p.pop().querySelector('.rp-top').textContent) && !p.pickBtn('Trucking').classList.contains('open'));
    eq('  Turf’s shows its job numbers', [...p.pop().querySelectorAll('.rp-num')].map(x => x.textContent), ['#26002', '#26001']);
    p.pickBtn('Turf').click();
    assert('its button again closes it', !p.pop() && !p.pickBtn('Turf').classList.contains('open'));
    assert('  and with nothing changed, nothing is written', p.rowsWrites().length === 0);
    p.w.close();
  }

  console.log('\n[ticking several at once]');
  {
    const p = boot(); await settle();
    p.open('Dust Control');
    p.tick('Acme Pit', 'Elk Ridge', 'Glen Rock');
    assert('three ticked: the footer counts them and Save says Add 3', /3 to add/.test(p.foot()) && p.saveBtn().textContent === 'Add 3' && !p.saveBtn().disabled,
      p.foot() + ' / ' + p.saveBtn().textContent);
    assert('  nothing is written and nothing moves until it is saved', p.rowsWrites().length === 0 && names(p.sections()['Dust Control']).length === 2);
    p.saveBtn().click(); await later();
    assert('Save closes the checklist', !p.pop() && !p.pickBtn('Dust Control').classList.contains('open'));
    eq('  and puts all three on the board', names(p.sections()['Dust Control']).sort(), ['Acme Pit', 'Borden LLC', 'Cedar Pad', 'Elk Ridge', 'Glen Rock']);
    eq('  in one write, merged into what is stored', p.rowsWrites().map(x => ({ method: x.method, body: x.body })),
      [{ method: 'PATCH', body: { fields: { 'dust::c1': 'show', 'dust::c5': 'show', 'dust::c7': 'show' } } }]);
    assert('  and says so', /Dust Control · 3 customers added to the board/.test(p.toast()), p.toast());
    assert('the button’s count follows', /\+ Customers \(3\)/.test(p.pickBtn('Dust Control').textContent), p.pickBtn('Dust Control').textContent);

    p.open('Dust Control');
    eq('reopened, they are with the rest on the board', p.checklist()['On the board'].map(x => x.name), ['Acme Pit', 'Borden LLC', 'Cedar Pad', 'Elk Ridge', 'Glen Rock']);
    p.tick('Borden LLC', 'Dunmore Sand');
    assert('unticking one and ticking another: both counted, and Save says Save', /1 to add · 1 to take off/.test(p.foot()) && p.saveBtn().textContent === 'Save', p.foot());
    p.box('Cedar Pad').click();
    assert('  the booked one cannot be unticked', p.box('Cedar Pad').checked && /1 to add · 1 to take off/.test(p.foot()));
    p.saveBtn().click(); await later();
    eq('saved as one write with both', p.rowsWrites()[1] && p.rowsWrites()[1].body, { fields: { 'dust::c2': 'hide', 'dust::c4': 'show' } });
    eq('  Borden LLC is off the board and Dunmore Sand is on', names(p.sections()['Dust Control']).sort(), ['Acme Pit', 'Cedar Pad', 'Dunmore Sand', 'Elk Ridge', 'Glen Rock']);
    assert('  and the toast says both', /Dust Control · 1 added, 1 taken off/.test(p.toast()), p.toast());

    p.open('Turf'); p.tick('Riverbend'); p.saveBtn().click(); await later();
    assert('unticking a Turf job takes it off', !names(p.sections().Turf).includes('Riverbend') && /Turf · 1 job taken off the board/.test(p.toast()), p.toast());
    eq('  saved the same way', p.rowsWrites()[2] && p.rowsWrites()[2].body, { fields: { 'turf::j1': 'hide' } });
    assert('  and Turf’s button now counts it', /\+ Jobs \(1\)/.test(p.pickBtn('Turf').textContent), p.pickBtn('Turf').textContent);
    p.open('Turf'); p.tick('Riverbend'); p.saveBtn().click(); await later();
    assert('ticking it again puts it back', names(p.sections().Turf).includes('Riverbend'));
    p.w.close();
  }

  console.log('\n[Cancel, Escape, and clicking away]');
  {
    const p = boot(); await settle();
    const cancel = () => [...p.pop().querySelectorAll('.rp-foot button')].find(b => b.textContent === 'Cancel');
    p.open('Dust Control'); p.tick('Fayette Stone'); cancel().click(); await later();
    assert('Cancel closes it and leaves the board as it was', !p.pop() && !names(p.sections()['Dust Control']).includes('Fayette Stone') && p.rowsWrites().length === 0);
    p.open('Dust Control'); p.tick('Fayette Stone'); p.pop().querySelector('.rp-top .x').click(); await later();
    assert('so does ✕', !p.pop() && p.rowsWrites().length === 0);
    p.open('Dust Control'); p.tick('Fayette Stone'); p.key(p.doc, 'Escape'); await later();
    assert('so does Escape', !p.pop() && p.rowsWrites().length === 0);

    p.open('Dust Control'); p.tick('Fayette Stone'); p.doc.body.click(); await later();
    assert('clicking away saves what was ticked, the way a dropdown you made choices in does', !p.pop() && names(p.sections()['Dust Control']).includes('Fayette Stone'));
    eq('  in the same one write', p.rowsWrites().map(x => x.body), [{ fields: { 'dust::c6': 'show' } }]);
    p.open('Dust Control'); p.tick('Glen Rock'); p.pickBtn('Dust Control').click(); await later();
    assert('so does its button, clicked again', !p.pop() && names(p.sections()['Dust Control']).includes('Glen Rock') && p.rowsWrites().length === 2);
    p.open('Dust Control'); p.tick('Hanover Aggregates'); p.open('Trucking'); await later();
    assert('and opening another section’s', names(p.sections()['Dust Control']).includes('Hanover Aggregates') && p.rowsWrites().length === 3 &&
      /Trucking/.test(p.pop().querySelector('.rp-top').textContent));
    p.w.closeRowPicker();

    p.open('Dust Control'); p.tick('Acme Pit');
    p.rowOf('Borden LLC').querySelector('td.cell').click(); await later();
    assert('a click on a day cell saves, then opens that cell as it always did',
      names(p.sections()['Dust Control']).includes('Acme Pit') && !p.pop() && !!p.doc.getElementById('assignOverlay'));
    p.w.closeAssign();

    p.open('Dust Control'); p.tick('Dunmore Sand');
    p.w.eval("state.view = 'crew'; render();"); await later();
    assert('a redraw with no sections to hang it on (By Crew) saves it and puts it away',
      !p.pop() && p.rowsWrites().some(x => JSON.stringify(x.body) === JSON.stringify({ fields: { 'dust::c4': 'show' } })));
    p.w.close();
  }

  console.log('\n[a long list has a search box]');
  {
    const p = boot(); await settle();
    p.open('Dust Control');
    assert('Dust Control’s eight customers get one', !!p.pop().querySelector('#rowPickSearch'));
    p.search('elk');
    eq('typing narrows the list', p.visible(), ['Elk Ridge']);
    const groups = [...p.pop().querySelectorAll('.rp-group')];
    assert('  hiding a group with nothing left in it', groups[0].hidden && !groups[1].hidden);
    p.search('7788');
    eq('a job number finds its customer', p.visible(), ['Hanover Aggregates']);
    p.search('zzz');
    assert('nothing matching says so', p.visible().length === 0 && !p.pop().querySelector('.rp-none').hidden);
    const el = p.search('glen');
    p.key(el, 'Enter');
    assert('Enter ticks the one row a search narrowed to', p.box('Glen Rock').checked && /1 to add/.test(p.foot()), p.foot());
    assert('  and clears the search for the next', el.value === '' && p.visible().length === 8 && p.pop().querySelector('.rp-none').hidden);
    p.search('r'); p.key(el, 'Enter');
    assert('Enter with more than one match ticks nothing', /^1 to add$/.test(p.foot()) && el.value === 'r', p.foot());
    p.search('');
    p.w.eval('render()');
    assert('a redraw of the board keeps the checklist open, and what was ticked',
      !!p.pop() && p.box('Glen Rock').checked && p.pickBtn('Dust Control').classList.contains('open'));
    p.w.closeRowPicker();
    p.open('Trucking');
    assert('Trucking’s four do not', !p.pop().querySelector('#rowPickSearch'));
    p.w.closeRowPicker();
    p.w.close();
  }

  console.log('\n[the first save a company makes]');
  {
    const p = boot({ rows: null }); await settle();
    p.open('Dust Control'); p.tick('Acme Pit', 'Borden LLC'); p.saveBtn().click(); await later(); await later();
    eq('reads what is stored, then writes the whole object', p.rowsWrites().map(x => ({ method: x.method, body: x.body })),
      [{ method: 'PUT', body: { value: { 'dust::c1': 'show', 'dust::c2': 'show' } } }]);
    p.open('Dust Control'); p.tick('Elk Ridge'); p.saveBtn().click(); await later();
    eq('  and every save after that merges its keys', p.rowsWrites().map(x => x.method), ['PUT', 'PATCH']);
    p.w.close();

    const r = boot({ rows: null }); await settle();
    r.w.dropBoardRow('turf', 'j1');
    r.open('Dust Control'); r.tick('Acme Pit'); r.saveBtn().click();
    await later(); await later(); await later();
    eq('two saves made at once go one after the other: the second merges into the first rather than writing over it',
      r.rowsWrites().map(x => ({ method: x.method, body: x.body })),
      [{ method: 'PUT', body: { value: { 'turf::j1': 'hide' } } }, { method: 'PATCH', body: { fields: { 'dust::c1': 'show' } } }]);
    r.w.close();

    const q = boot({ rows: null, rowsRead: 'fail' }); await settle();
    q.open('Dust Control'); q.tick('Acme Pit'); q.saveBtn().click(); await later(); await later();
    assert('a read that fails writes nothing over what might be there', q.rowsWrites().length === 0);
    assert('  and says so', /Could not save that for everyone/.test(q.toast()), q.toast());
    q.w.close();
  }

  console.log('\n[a section with nothing on it]');
  {
    const p = boot({ rows: {} }); await settle();
    p.w.eval("state.assignments[" + JSON.stringify(D1) + "] = state.assignments[" + JSON.stringify(D1) + "].filter(a => a.division !== 'dust'); render();");
    const dust = p.sections()['Dust Control'];
    assert('is still drawn, so its checklist can be reached', !!dust && !!p.pickBtn('Dust Control'));
    assert('  and says how to fill it', dust && /No customers on the board — tick the ones being worked in \+ Customers/.test(dust.join(' ')), JSON.stringify(dust));
    p.w.eval("state.needCrewOnly = true; render();");
    assert('  but not when the board is narrowed to jobs needing crew', !p.sections()['Dust Control']);
    p.w.close();
  }

  console.log('\n[a search on the board, and ×]');
  {
    const p = boot(); await settle();
    p.w.eval("state.jobSearch = 'fayette'; render();");
    const found = p.rowOf('Fayette Stone');
    assert('a search finds a customer that is not on the board', !!found);
    assert('  and offers to put it there', !!found && !!found.querySelector('.row-x.pin'));
    found.querySelector('.row-x.pin').click(); await later();
    p.w.eval("state.jobSearch = ''; render();");
    assert('  which keeps it there once the search is cleared', names(p.sections()['Dust Control']).includes('Fayette Stone'));
    eq('  saved like any other pick', p.rowsWrites().map(x => x.body), [{ fields: { 'dust::c6': 'show' } }]);
    p.rowOf('Riverbend').querySelector('.row-x').click(); await later();
    assert('× takes a job off the board, and says where it went', !names(p.sections().Turf).includes('Riverbend') && /\+ Jobs in its section puts it back/.test(p.toast()), p.toast());
    p.open('Turf');
    eq('  where it waits, unticked', p.checklist()['Not on the board'], [{ name: 'Riverbend', on: false }]);
    p.w.closeRowPicker();
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

    p.header('Turf').querySelector('.grp-work').click(); await later();
    const turf = p.sections().Turf;
    assert('+ Work on the Turf header makes a Turf row', turf.some(r => /off project Shop/.test(r)), JSON.stringify(turf));
    const modal = (p.doc.getElementById('assignOverlay') || {}).innerHTML || '';
    assert('  and opens it to staff, badged as Turf’s', /Turf · off project/.test(modal), modal.slice(0, 300));
    p.w.pickAdd('Blake Hostetler', 'emp'); await later();
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
