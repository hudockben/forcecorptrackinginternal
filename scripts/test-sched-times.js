#!/usr/bin/env node
'use strict';
/**
 * The two times a crew is told: the shop, and the site.
 *
 * Run: node scripts/test-sched-times.js
 *
 * They answer different questions. When to be at the SHOP is when you pick up
 * the truck and the gear; when to be ON SITE is when the work starts. A job
 * twenty minutes the far side of the county has the same site time and a very
 * different shop time, and a board that could only say one of them left the
 * other to a phone call at six in the morning.
 *
 * Two things here are easy to get wrong and both are pinned below.
 *
 * STORAGE. Both live in the one siteTimes map under two KEYS, not in a value
 * object holding both. mergeSiteTimes and _recoverTimes compare values with
 * !==, which is right for a string and silently wrong for an object: every
 * merge would read as a change and two schedulers editing one week would fight
 * over times neither had touched. The site key also keeps its old spelling, so
 * every time saved before the shop time existed is still found.
 *
 * REACHABILITY. The times shipped invisible: nothing was drawn until one was
 * set, and the only way to set one was a collapsed section inside the assign
 * dialog. A time you cannot see anywhere is a time nobody knows they can set,
 * so the cell now always carries the control.
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

const FNS = ['siteKey','shopKey','timeKeyFor','getJobTime','setJobTime','getSiteTime','getShopTime',
             'cellTimesHtml','jobTimesHtml','fmtTime','fmtTimeShort'];

function page(siteTimes) {
  const sandbox = { console, state: { siteTimes: siteTimes || {} }, saveAssignments: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(
    "const esc = s => String(s ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));" +
    "const escAttr = s => String(s ?? '').replace(/\\\\/g,'\\\\\\\\').replace(/'/g, \"\\\\'\").replace(/\"/g, '&quot;');" +
    // `pad` is an arrow const on the page, not a function declaration, so it is
    // restated here rather than lifted. It only zero-pads a number.
    "const pad = n => String(n).padStart(2, '0');", sandbox);
  FNS.forEach(n => vm.runInContext(requireFn(SCHED, n, 'scheduler.html'), sandbox, { filename: 'scheduler.html' }));
  return sandbox;
}
const D = '2026-09-21', DIV = 'turf', JOB = '26049';

(async () => {
  console.log('The two times a crew is told\n');

  console.log('[they are two keys, and they do not collide]');
  {
    const p = page();
    assert('  the shop key is not the site key', p.shopKey(DIV, JOB) !== p.siteKey(DIV, JOB));
    eq('  the site key keeps its old spelling', p.siteKey(DIV, JOB), 'turf::26049');
    // Prefixed, not suffixed: a suffix could collide with the site key of a
    // job whose id happened to end the same way.
    assert('  the shop key is prefixed, not suffixed', p.shopKey(DIV, JOB).startsWith('shop'));
    assert('  so one job’s shop key is never another’s site key',
      p.shopKey(DIV, JOB) !== p.siteKey(DIV, JOB + '¦shop') &&
      p.shopKey(DIV, JOB) !== p.siteKey(DIV, JOB + '::shop'));
  }

  console.log('\n[setting one does not disturb the other]');
  {
    const p = page();
    p.setJobTime('shop', DIV, JOB, '06:00', [D]);
    p.setJobTime('site', DIV, JOB, '07:00', [D]);
    eq('  the shop time reads back', p.getShopTime(D, DIV, JOB), '06:00');
    eq('  the site time reads back', p.getSiteTime(D, DIV, JOB), '07:00');
    p.setJobTime('shop', DIV, JOB, '', [D]);
    eq('  clearing the shop time leaves the site time', p.getSiteTime(D, DIV, JOB), '07:00');
    eq('  and the shop time is gone', p.getShopTime(D, DIV, JOB), '');
  }

  console.log('\n[a time saved before the shop time existed is still found]');
  {
    // Exactly the shape the blob already holds: the bare site key, a string.
    const p = page({ [D]: { 'turf::26049': '07:30' } });
    eq('  the old site time still reads', p.getSiteTime(D, DIV, JOB), '07:30');
    eq('  and no shop time is invented', p.getShopTime(D, DIV, JOB), '');
  }

  console.log('\n[the values stay strings, which the merge depends on]');
  {
    const p = page();
    p.setJobTime('shop', DIV, JOB, '06:00', [D]);
    const stored = p.state.siteTimes[D][p.shopKey(DIV, JOB)];
    eq('  a stored time is a string, not an object', typeof stored, 'string');
    // mergeSiteTimes/_recoverTimes compare with !==; an object would read as
    // changed on every merge and two schedulers would fight over it.
    assert('  and the merge still compares values with !==',
      /o\[k\] !== b\[k\]/.test(requireFn(SCHED, 'mergeSiteTimes', 'scheduler.html')),
      'mergeSiteTimes no longer compares by value — strings may no longer be safe');
  }

  console.log('\n[the cell always offers a way in]');
  {
    const none = page().cellTimesHtml(D, DIV, JOB);
    assert('  with nothing set, the cell still draws the control', /class="cell-times"/.test(none), none);
    assert('  as a faint "add" rather than a time', /class="ct-add"/.test(none) && !/ct-line/.test(none), none);
    assert('  and it opens the times', /openJobTimes\(/.test(none), none);

    const p = page();
    p.setJobTime('shop', DIV, JOB, '06:00', [D]);
    p.setJobTime('site', DIV, JOB, '07:00', [D]);
    const set = p.cellTimesHtml(D, DIV, JOB);
    assert('  with both set, both are shown', (set.match(/ct-line/g) || []).length === 2, set);
    assert('  the shop time reads 6a', /6a/.test(set), set);
    assert('  the site time reads 7a', /7a/.test(set), set);
    assert('  and clicking them opens the times too', /openJobTimes\(/.test(set), set);
    assert('  without also opening the cell’s own dialog',
      /event\.stopPropagation\(\)/.test(set), set);

    const half = page();
    half.setJobTime('site', DIV, JOB, '07:00', [D]);
    assert('  one set, one not, still shows the one', (half.cellTimesHtml(D, DIV, JOB).match(/ct-line/g) || []).length === 1);
  }

  console.log('\n[the way in actually lands on the times]');
  {
    const src = requireFn(SCHED, 'openJobTimes', 'scheduler.html');
    // openAssignJob clears moreOpts on the way in, so the flag has to be set
    // after it or the section opens collapsed and the click looks broken.
    const iOpen = src.indexOf('openAssignJob');
    const iFlag = src.indexOf('state.moreOpts = true');
    assert('  the disclosure is opened AFTER the dialog', iOpen > -1 && iFlag > iOpen,
      'moreOpts is set before openAssignJob, which resets it');
    assert('  and the dialog is redrawn so the section shows', /renderModal\(\)/.test(src));
    assert('  openJobTimes is reachable from the markup',
      /Object\.assign\(window, \{[^}]*openJobTimes/.test(SCHED.replace(/\n/g, ' ')));
  }

  console.log('\n[the printed sheet says both]');
  {
    const body = requireFn(SCHED, 'dispatchBodyJob', 'scheduler.html');
    assert('  the job sheet reads the shop time', /getShopTime\(/.test(body));
    assert('  and the site time', /getSiteTime\(/.test(body));
    const person = requireFn(SCHED, 'dispatchBodyPerson', 'scheduler.html');
    assert('  the per-person sheet reads both',
      /getShopTime\(/.test(person) && /getSiteTime\(/.test(person));
  }

  console.log('\n[on a day board the times sit beside the job name]');
  {
    const p = page();
    const none = p.jobTimesHtml(D, DIV, JOB);
    // Permanent fixture: both lines are drawn whether or not anything is set,
    // because a blank is something a scheduler has to remember to look for.
    assert('  both lines are drawn with nothing set',
      (none.match(/class="jt[ "]/g) || []).length === 2, none);
    assert('  and each says so with an em dash', (none.match(/—/g) || []).length >= 2, none);
    assert('  marked unset, so it reads as muted rather than as a time',
      (none.match(/jt unset/g) || []).length === 2, none);

    p.setJobTime('shop', DIV, JOB, '06:00', [D]);
    p.setJobTime('site', DIV, JOB, '07:00', [D]);
    const set = p.jobTimesHtml(D, DIV, JOB);
    assert('  with both set, both times show', /6a/.test(set) && /7a/.test(set), set);
    assert('  neither is still marked unset', !/jt unset/.test(set), set);
    assert('  and it opens the times on click',
      /openJobTimes\(/.test(set) && /event\.stopPropagation\(\)/.test(set), set);

    const half = page();
    half.setJobTime('site', DIV, JOB, '07:00', [D]);
    const h = half.jobTimesHtml(D, DIV, JOB);
    assert('  one set and one not still draws both lines',
      (h.match(/class="jt[ "]/g) || []).length === 2 && /jt unset/.test(h) && /7a/.test(h), h);
  }

  console.log('\n[words, not pictures]');
  {
    const p = page();
    p.setJobTime('shop', DIV, JOB, '06:00', [D]);
    p.setJobTime('site', DIV, JOB, '07:00', [D]);
    const both = p.jobTimesHtml(D, DIV, JOB) + p.cellTimesHtml(D, DIV, JOB) + page().cellTimesHtml(D, DIV, JOB);
    assert('  the times are labelled Shop and Site', /Shop/.test(both) && /Site/.test(both), both);
    // The house and the clock read as decoration at this size; they are gone.
    const pictures = both.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
    assert('  and no emoji is left in either renderer', pictures.length === 0, pictures.join(' '));
  }

  console.log('\n[which board puts them where]');
  {
    // Seven days on one row are seven different answers, and the job-name cell
    // can only hold one — so the week board keeps its times in the day cells.
    const row = requireFn(SCHED, 'jobRowHtml', 'scheduler.html');
    assert('  the row asks which board it is on', /viewingOneDay\(\)/.test(row), row.slice(0, 200));
    assert('  a day board puts them beside the name', /jobTimesHtml\(ds\[0\]/.test(row));
    assert('  a week board leaves them in the day cells',
      /oneDay \? '' : cellTimesHtml\(/.test(row));
  }


  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
