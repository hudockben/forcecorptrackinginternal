#!/usr/bin/env node
'use strict';
/**
 * Work with no project behind it.
 *
 * Run: node scripts/test-sched-other-work.js
 *
 * A site visit, a day in the shop, a man sent to look at something that has
 * not been bid. It is real work and it is where the man IS, but there is no
 * project in Turf, Paving or Kiewit to hang it on, so the board had nowhere to
 * put him — and he stayed in the Idle count all week. That made the one number
 * a scheduler reads to answer "who can I send" quietly wrong, which is the
 * whole reason this exists.
 *
 * It is NOT a division. It is a pseudo-division, so that an assignment
 * carrying it is an ORDINARY assignment and the machinery already on the board
 * — the double-booking flag, placeOnJob's one-man-one-job rule, the time-off
 * guard, drag and drop — applies to it without being taught a new shape. Most
 * of what is asserted below is therefore that nothing had to change: the
 * page's own functions are run, not a restatement of them.
 *
 * The label is free text, typed per assignment, so the LABEL is the identity.
 * That is the one genuinely new rule and the first section pins it.
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
const eq = (label, got, want) => assert(label, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const SCHED = read('scheduler.html');

const FNS = ['otherKey','otherJobOf','otherLabel','otherJobsInWeek','jobFor','jobById','divLabel',
             'placeOnJob','addAssignmentSpan','conflictResourcesOn','dropJob','loadForResource',
             'assignmentsFor','dayList','idleEmployees'];

/** A board in a vm, running scheduler.html's own functions over it. */
function board({ week, assignments, drafts, jobs, employees }) {
  const days = week || ['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26','2026-09-27'];
  const sandbox = {
    console,
    state: {
      assignments: assignments || {},
      otherDrafts: drafts || [],
      board: { jobs: jobs || [], employees: employees || [] },
    },
    weekDateStrs: () => days,
    // The visible range and a calendar week are different functions now;
    // these fixtures use a full week for both.
    fullWeekDateStrs: () => days,
    // Nobody is off in these cases; the time-off rule has its own suite.
    isBlockedOff: () => false,
    saveAssignments: () => {},
    _n: 0,
    uid: () => 'id' + (++sandbox._n),
  };
  vm.createContext(sandbox);
  // OTHER_DIV is lifted from the page rather than restated, so a rename there
  // fails here instead of silently testing a string this file made up.
  const decl = SCHED.match(/^const OTHER_DIV = '[^']+';$/m);
  if (!decl) throw new Error('OTHER_DIV declaration not found in scheduler.html');
  vm.runInContext(decl[0], sandbox, { filename: 'scheduler.html' });
  FNS.forEach(n => vm.runInContext(requireFn(SCHED, n, 'scheduler.html'), sandbox, { filename: 'scheduler.html' }));
  // A `const` inside a vm script lands in the context's lexical scope, which
  // the lifted functions can see but a property read cannot. Hand the value
  // out so the assertions below still compare against the page's own string
  // rather than one restated here.
  sandbox.OTHER_DIV = vm.runInContext('OTHER_DIV', sandbox);
  return sandbox;
}

const TURF = { division:'turf', id:'26049', name:'Franklin Regional Softball', subCodes:[] };

(async () => {
  console.log('Work with no project behind it\n');

  console.log('[the label is the row]');
  {
    const p = board({});
    eq('  the same words are the same row',
      p.otherKey('Shop'), p.otherKey('shop'));
    eq('  and stray spacing does not split it in two',
      p.otherKey('  Site   visit  '), p.otherKey('Site visit'));
    assert('  different words are different rows',
      p.otherKey('Shop') !== p.otherKey('Yard'));
    eq('  but the words are kept as they were typed',
      p.otherJobOf('  Site   visit — Juniata ').name, 'Site visit — Juniata');
    assert('  and the row is not mistaken for a division job',
      p.otherJobOf('Shop').division === p.OTHER_DIV && p.otherJobOf('Shop').id.startsWith(p.OTHER_DIV + '::'));
  }

  console.log('\n[putting a man on it uses the board’s own rule]');
  {
    const p = board({});
    const job = p.otherJobOf('Site visit');
    eq('  he goes on', p.placeOnJob('2026-09-21', job, '', { resource:'Blake Hostetler', kind:'emp' }), 'added');
    eq('  once', p.placeOnJob('2026-09-21', job, '', { resource:'Blake Hostetler', kind:'emp' }), 'exists');
    const a = p.state.assignments['2026-09-21'][0];
    eq('  and the chip carries the words he typed', a.jobName, 'Site visit');
    eq('  under the pseudo-division', a.division, p.OTHER_DIV);
    assert('  with no cost code, because there is no project to code to', !a.costCode);
  }

  console.log('\n[a man in two places is still a man in two places]');
  {
    const p = board({});
    p.placeOnJob('2026-09-21', p.otherJobOf('Site visit'), '', { resource:'Blake Hostetler', kind:'emp' });
    p.placeOnJob('2026-09-21', TURF, '', { resource:'Blake Hostetler', kind:'emp' });
    const clash = p.conflictResourcesOn('2026-09-21');
    assert('  off-project work double-books against a job', clash.has('Blake Hostetler'), [...clash].join(','));
    // Two different off-project labels are two different places, too.
    const q = board({});
    q.placeOnJob('2026-09-21', q.otherJobOf('Shop'), '', { resource:'Colton Reed', kind:'emp' });
    q.placeOnJob('2026-09-21', q.otherJobOf('Site visit'), '', { resource:'Colton Reed', kind:'emp' });
    assert('  and so do two different kinds of off-project work',
      q.conflictResourcesOn('2026-09-21').has('Colton Reed'));
  }

  console.log('\n[he stops being idle, which is the point]');
  {
    const p = board({ employees: [{ name:'Blake Hostetler' }, { name:'Colton Reed' }] });
    eq('  both men are idle to begin with', p.idleEmployees().length, 2);
    p.placeOnJob('2026-09-22', p.otherJobOf('Shop'), '', { resource:'Blake Hostetler', kind:'emp' });
    eq('  a man in the shop is not available', p.idleEmployees().length, 1);
    eq('  and the day counts towards his week', p.loadForResource('Blake Hostetler'), 1);
  }

  console.log('\n[the rows the board draws]');
  {
    const p = board({ drafts: [] });
    p.placeOnJob('2026-09-22', p.otherJobOf('Shop'), '', { resource:'Blake Hostetler', kind:'emp' });
    p.placeOnJob('2026-09-23', p.otherJobOf('Site visit'), '', { resource:'Colton Reed', kind:'emp' });
    const rows = p.otherJobsInWeek();
    eq('  one row per label the week carries', rows.length, 2);
    eq('  in alphabetical order', rows.map(r => r.name).join('|'), 'Shop|Site visit');
    // A label just typed has no assignment yet; it must still draw, or there is
    // nothing to drag a name onto.
    p.state.otherDrafts.push(p.otherJobOf('Training'));
    eq('  a row typed but not yet staffed still draws', p.otherJobsInWeek().length, 3);
    // ...and a draft that duplicates a staffed label is not a second row.
    p.state.otherDrafts.push(p.otherJobOf('shop'));
    eq('  a draft of a label already in use is not a second row', p.otherJobsInWeek().length, 3);
  }

  console.log('\n[naming a row from an assignment]');
  {
    // Deliberately OUTSIDE the week on screen: paging away must not rename a row.
    const p = board({ assignments: { '2026-10-15': [
      { id:'x', resource:'Blake Hostetler', kind:'emp', division:'other',
        jobId:'other::site visit', jobName:'Site visit', costCode:'' } ] } });
    eq('  the label is read off any day, not just the week shown',
      p.otherLabel('other::site visit'), 'Site visit');
    eq('  and jobFor gives the row its real name',
      p.jobFor('other', 'other::site visit').name, 'Site visit');
    eq('  a project that has left the board keeps the name the chip remembers',
      p.jobFor('turf', 'gone', 'Old Job').name, 'Old Job');
    eq('  an off-project row nobody can name still reads as work, not "Job"',
      p.jobFor('other', 'other::vanished').name, 'Other work');
  }

  console.log('\n[a drop has to land on a row that exists]');
  {
    const p = board({ jobs: [TURF] });
    p.placeOnJob('2026-09-22', p.otherJobOf('Shop'), '', { resource:'Blake Hostetler', kind:'emp' });
    assert('  a live job takes a drop', !!p.dropJob({ division:'turf', jobId:'26049' }));
    assert('  an off-project row the week is drawing takes a drop',
      !!p.dropJob({ division:'other', jobId:p.otherKey('Shop') }));
    eq('  a row the board is not drawing refuses it',
      p.dropJob({ division:'other', jobId:'other::nothing here' }), null);
    eq('  and so does a job that is not on the board',
      p.dropJob({ division:'turf', jobId:'99999' }), null);
  }

  console.log('\n[what a person reads, versus what it is stored as]');
  {
    const p = board({});
    eq('  a crew does not read the word "other"', p.divLabel('other'), 'Other work');
    eq('  and a real division is left alone', p.divLabel('turf'), 'turf');
    // Every badge that prints a division goes through it, or one of them says
    // "OTHER" while the rest say "OFF PROJECT" and the row looks like a bug.
    const raw = SCHED.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /div-badge/.test(l) && /esc\((?:ctx|a|g\.job|j)\.division\)/.test(l));
    assert('  no badge or sheet prints the raw division key', raw.length === 0,
      raw.map(([n]) => 'line ' + n).join(', '));
  }

  // These three are wiring, asserted against the page source because they are
  // one-liners inside render functions with no seam to call. They are here
  // because all three were written once, silently rolled back by a patch that
  // failed after them, and shipped missing: the board looked right in every
  // case that had a project on it, which is every case anyone would try.
  console.log('\n[the ways in stay wired up]');
  {
    assert('the empty board still draws the off-project group',
      /if \(!jobs\.length && !otherJobsInWeek\(\)\.length\)/.test(SCHED),
      (SCHED.match(/if \(!jobs\.length[^)]*\)/) || ['(not found)'])[0]);
    assert('the division filter offers off-project',
      /concat\(\[OTHER_DIV\]\)/.test(SCHED) && /'Off project'/.test(SCHED));
    assert('and the + Work button has a function to call',
      /Object\.assign\(window, \{ addOtherWork,/.test(SCHED));
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
