#!/usr/bin/env node
'use strict';
/**
 * The crew's note: one per job, per day.
 *
 * Run: node scripts/test-sched-notes.js
 *
 * What a crew needs to know that is not a time — the gate code, the mix coming
 * at seven, bring the laser screed. It is tied to the job and the day it is
 * about, because a box of free text beside the board says neither, goes stale
 * by Thursday, and never reaches the crew.
 *
 * Pinned below:
 *
 * STORAGE. The note lives in the siteTimes map under its own key, the way the
 * shop time does, so it merges between schedulers with no change to the merge:
 * two schedulers writing notes on different jobs never touch the same entry.
 *
 * WHERE IT IS TYPED. On a day board, in the day cell beside the crew, saving
 * the one day it is on. A week cell is too narrow, so it only SHOWS the note
 * there; the dialog the cell opens carries the field, with the Apply-to span.
 *
 * WHAT SURVIVES A REDRAW. The board can be redrawn under somebody mid-note
 * (another scheduler's save merging in). The words and the caret go back into
 * the field, and the field saves them when it is left.
 *
 * WHERE IT ENDS UP. On the dispatch sheet, under the job's day, escaped.
 *
 * No DB or server required; the redraw section uses jsdom.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const eq = (label, got, want) => assert(label, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const { requireFn, sliceSource, evalSlice } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const SCHED = read('scheduler.html');

// The escaper, the date helpers and the dispatch sheet's inline styles, lifted
// rather than restated, so a change to any of them is a change seen here.
const HELPERS = sliceSource(SCHED, 'const esc = s =>', '// "06:30"', 'the page helpers', 'function shortDate(');
const SHEET   = sliceSource(SCHED, 'const _td =', 'function dispatchDates(', 'the dispatch sheet styles', 'function dispatchNote(');
const NOTE_MAX = Number((/const NOTE_MAX = (\d+);/.exec(SCHED) || [])[1]);

const FNS = ['siteKey','shopKey','noteKey','timeKeyFor','getJobTime','setJobTime','setDayEntry','getSiteTime','getShopTime',
             'cleanNote','getJobNote','setJobNote','noteFieldHtml','noteTitle','onJobNoteKey','onJobNoteCell','cellNoteHtml',
             'captureNoteTyping','restoreNoteTyping','commitNoteTyping','onJobNoteInput',
             '_flatTimes','_unflatTimes','mergeSiteTimes','_recoverTimes',
             'fmtTime','dayLabel','dispatchJobSummary','dispatchCodeMeta','dispatchBodyJob','dispatchBodyPerson'];

function page(siteTimes, extra) {
  const sandbox = {
    console, NOTE_MAX, saves: 0, toasts: [],
    state: { siteTimes: siteTimes || {}, assignments: {}, applySpan: 'day', view: 'job', assignCtx: null },
    // Nothing here is about which job a row belongs to; the sheet only asks.
    jobById: () => null, codeOf: () => null, divLabel: d => d,
    ...(extra || {}),
  };
  sandbox.saveAssignments = () => { sandbox.saves++; };
  sandbox.toast = m => { sandbox.toasts.push(m); };
  vm.createContext(sandbox);
  vm.runInContext('var NOTE_MAX = ' + NOTE_MAX + ';', sandbox);
  evalSlice(HELPERS, sandbox, 'the page helpers', { filename: 'scheduler.html' });
  evalSlice(SHEET, sandbox, 'the dispatch sheet styles', { filename: 'scheduler.html' });
  FNS.forEach(n => vm.runInContext(requireFn(SCHED, n, 'scheduler.html'), sandbox, { filename: 'scheduler.html' }));
  return sandbox;
}
const D = '2026-09-28', D2 = '2026-09-29', DIV = 'turf', JOB = '26049';

(async () => {
  console.log('The crew’s note\n');

  console.log('[it has a key of its own, and it collides with neither time]');
  {
    const p = page();
    const k = p.noteKey(DIV, JOB);
    assert('  not the site key', k !== p.siteKey(DIV, JOB));
    assert('  not the shop key', k !== p.shopKey(DIV, JOB));
    assert('  prefixed, like the shop key', k.startsWith('note'));
    assert('  so one job’s note is never another job’s time',
      k !== p.siteKey(DIV, JOB + '::note') && k !== p.shopKey(DIV, JOB));
  }

  console.log('\n[it is stored beside the times without disturbing them]');
  {
    const p = page();
    p.setJobTime('shop', DIV, JOB, '06:15', [D]);
    p.setJobTime('site', DIV, JOB, '07:00', [D]);
    p.setJobNote(DIV, JOB, 'Gate code 4471', [D]);
    eq('  the note reads back', p.getJobNote(D, DIV, JOB), 'Gate code 4471');
    eq('  the shop time is untouched', p.getShopTime(D, DIV, JOB), '06:15');
    eq('  the site time is untouched', p.getSiteTime(D, DIV, JOB), '07:00');
    eq('  it is a string, which the merge depends on', typeof p.state.siteTimes[D][p.noteKey(DIV, JOB)], 'string');
    p.setJobNote(DIV, JOB, '', [D]);
    eq('  clearing it takes the entry off', p.state.siteTimes[D][p.noteKey(DIV, JOB)], undefined);
    eq('  and leaves the times', p.getSiteTime(D, DIV, JOB), '07:00');

    const q = page();
    q.setJobNote(DIV, JOB, 'Mix at 7', [D]);
    q.setJobNote(DIV, JOB, '   ', [D]);
    eq('  a date left with nothing on it goes too', q.state.siteTimes[D], undefined);
    assert('  every change is saved', q.saves === 2, `saves ${q.saves}`);
  }

  console.log('\n[one line, trimmed, capped]');
  {
    const p = page();
    eq('  surrounding space is trimmed', p.cleanNote('  Gate code 4471  '), 'Gate code 4471');
    eq('  a pasted paragraph becomes one line', p.cleanNote('Bring the screed\n\nand the roller\tplease'), 'Bring the screed and the roller please');
    eq('  nothing is nothing', p.cleanNote(null), '');
    eq('  the cap holds', Array.from(p.cleanNote('x'.repeat(NOTE_MAX + 50))).length, NOTE_MAX);
    // An emoji is two code units. Cut by code unit at the cap, it would leave
    // half of one — not valid text, and not something to save.
    const edge = p.cleanNote('x'.repeat(NOTE_MAX - 1) + '\u{1F69A}\u{1F69A}');
    assert('  an emoji at the cap is kept or dropped whole, never halved',
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(edge) && !/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(edge), JSON.stringify(edge.slice(-3)));
    eq('  a stored note is the cleaned one', (p.setJobNote(DIV, JOB, '  a \n b ', [D]), p.getJobNote(D, DIV, JOB)), 'a b');
  }

  console.log('\n[two schedulers, two notes, nothing lost]');
  {
    // Both started from the same saved week. One writes a note on Franklin,
    // the other a note on Juniata and a site time on Franklin.
    const p = page();
    const base = JSON.stringify({});
    const ours   = { [D]: { [p.noteKey(DIV, JOB)]: 'Gate code 4471' } };
    const theirs = { [D]: { [p.noteKey(DIV, '26053')]: 'Infield mix 7 AM', [p.siteKey(DIV, JOB)]: '07:00' } };
    const out = p.mergeSiteTimes(base, ours, theirs);
    eq('  our note is kept', out[D][p.noteKey(DIV, JOB)], 'Gate code 4471');
    eq('  their note on another job is kept', out[D][p.noteKey(DIV, '26053')], 'Infield mix 7 AM');
    eq('  their time on the same job is kept', out[D][p.siteKey(DIV, JOB)], '07:00');

    // Clearing a note is a change like any other, and survives the merge.
    const base2 = JSON.stringify({ [D]: { [p.noteKey(DIV, JOB)]: 'Old note' } });
    const cleared = p.mergeSiteTimes(base2, {}, { [D]: { [p.noteKey(DIV, JOB)]: 'Old note' } });
    eq('  a note we cleared stays cleared', (cleared[D] || {})[p.noteKey(DIV, JOB)], undefined);

    // A note typed before a save that never landed comes back on the next load.
    const rec = p._recoverTimes({}, { [D]: { [p.noteKey(DIV, JOB)]: 'Unsaved note' } });
    eq('  an unsaved note is recovered from the local copy', rec[D][p.noteKey(DIV, JOB)], 'Unsaved note');
  }

  console.log('\n[on a day board it is typed in the day cell]');
  {
    const p = page();
    const none = p.noteFieldHtml(D, DIV, JOB);
    assert('  a text field is always drawn', /<input type="text" class="jn-in"/.test(none), none);
    assert('  marked unset while empty, so it steps back', /class="jn unset"/.test(none), none);
    assert('  labelled in words', />Note</.test(none), none);
    assert('  capped at the same length the page cleans to', new RegExp('maxlength="' + NOTE_MAX + '"').test(none), none);
    assert('  a click in it does not open the cell’s dialog', /onclick="event\.stopPropagation\(\)"/.test(none), none);
    assert('  it saves when it is left', /onblur="onJobNoteCell\(this\)"/.test(none), none);
    assert('  and knows its own day and job',
      /data-date="2026-09-28"/.test(none) && /data-div="turf"/.test(none) && /data-job="26049"/.test(none), none);
    const pictures = none.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
    assert('  words, not pictures', pictures.length === 0, pictures.join(' '));

    p.setJobNote(DIV, JOB, 'Gate code 4471', [D]);
    const set = p.noteFieldHtml(D, DIV, JOB);
    assert('  a set note carries its value', /value="Gate code 4471"/.test(set), set);
    assert('  and is no longer marked unset', /class="jn"/.test(set) && !/jn unset/.test(set), set);

    const nasty = page();
    nasty.setJobNote(DIV, JOB, '"><img src=x onerror=alert(1)> & co', [D]);
    const h = nasty.noteFieldHtml(D, DIV, JOB);
    assert('  a note is escaped in the field', !/<img/.test(h) && /&quot;&gt;&lt;img/.test(h) && /&amp; co/.test(h), h);

    const row = requireFn(SCHED, 'jobRowHtml', 'scheduler.html');
    assert('  the day board puts the field in the day cell', /oneDay \? noteFieldHtml\(d,/.test(row), row.slice(0, 400));
  }

  console.log('\n[the field saves the one day it is on, and only when it changed]');
  {
    const p = page();
    const classes = [];
    const el = { dataset: { date: D, div: DIV, job: JOB }, value: '  Gate code 4471 ', title: '',
                 closest: () => ({ classList: { toggle: (c, on) => classes.push([c, on]) } }) };
    p.onJobNoteCell(el);
    eq('  it saves the cleaned note', p.getJobNote(D, DIV, JOB), 'Gate code 4471');
    eq('  the field shows what was saved', el.value, 'Gate code 4471');
    eq('  on that day only', p.getJobNote(D2, DIV, JOB), '');
    assert('  it restyles its own line rather than redrawing the board',
      classes.length === 1 && classes[0][0] === 'unset' && classes[0][1] === false, JSON.stringify(classes));
    eq('  and says so', p.toasts[0], 'Note saved · ' + p.shortDate(D));
    const saves = p.saves;
    p.onJobNoteCell(el);
    eq('  leaving it unchanged saves nothing', p.saves, saves);
    el.value = '';
    p.onJobNoteCell(el);
    eq('  emptying it clears the note', p.getJobNote(D, DIV, JOB), '');
    eq('  and says that instead', p.toasts[p.toasts.length - 1], 'Note cleared · ' + p.shortDate(D));

    const src = requireFn(SCHED, 'onJobNoteCell', 'scheduler.html');
    assert('  no redraw under the cursor', !/\brender\(\)/.test(src) && !/afterMutate\(/.test(src) && !/innerHTML/.test(src), src);
    assert('  compared with what is stored, not with what the field held on focus', /getJobNote\(/.test(src), src);
  }

  console.log('\n[Enter keeps it, Escape puts it back, and the board never hears either]');
  {
    const p = page();
    p.setJobNote(DIV, JOB, 'Gate code 4471', [D]);
    const mk = () => ({ dataset: { date: D, div: DIV, job: JOB }, value: 'half typed', blurred: 0, blur() { this.blurred++; } });
    const ev = key => ({ key, stopped: 0, prevented: 0, stopPropagation() { this.stopped++; }, preventDefault() { this.prevented++; } });

    const a = mk(), enter = ev('Enter');
    p.onJobNoteKey(enter, a);
    assert('  Enter leaves the field, which saves it', a.blurred === 1 && enter.prevented === 1);
    eq('  and keeps what was typed', a.value, 'half typed');

    const b = mk(), esc = ev('Escape');
    p.onJobNoteKey(esc, b);
    eq('  Escape puts back the saved note', b.value, 'Gate code 4471');
    assert('  and leaves the field', b.blurred === 1);

    const c = mk(), z = ev('z');
    p.onJobNoteKey(z, c);
    assert('  no key reaches the board (Ctrl+Z undoes typing, not a booking)',
      enter.stopped === 1 && esc.stopped === 1 && z.stopped === 1 && c.blurred === 0);
  }

  console.log('\n[on a week board it is shown, not typed]');
  {
    const p = page();
    eq('  a day with no note shows nothing', p.cellNoteHtml(D, DIV, JOB), '');
    p.setJobNote(DIV, JOB, 'Infield mix delivered 7 AM <sharp>', [D]);
    const cell = p.cellNoteHtml(D, DIV, JOB);
    assert('  a day with one shows it', /Infield mix delivered 7 AM/.test(cell), cell);
    assert('  escaped', /&lt;sharp&gt;/.test(cell) && !/<sharp>/.test(cell), cell);
    assert('  with all of it on hover', /title="Infield mix delivered 7 AM &lt;sharp&gt;"/.test(cell), cell);
    assert('  and no field to type into', !/<input/.test(cell), cell);
    const pictures = cell.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
    assert('  words, not pictures', pictures.length === 0, pictures.join(' '));

    const row = requireFn(SCHED, 'jobRowHtml', 'scheduler.html');
    // The times wait for somebody to be on the day; a note does not have to.
    assert('  shown whether or not anybody is on the day yet',
      /: \(wantTimes \? cellTimesHtml\(d, job\.division, job\.id\) : ''\) \+ cellNoteHtml\(d,/.test(row), row.slice(0, 600));
  }

  console.log('\n[the dialog carries it, across the Apply-to span]');
  {
    const modal = requireFn(SCHED, 'modalJobHtml', 'scheduler.html');
    assert('  the dialog has a note field', /id="jobNote"/.test(modal) && /getJobNote\(ctx\.date, ctx\.division, ctx\.jobId\)/.test(modal));
    assert('  its section opens by itself when there is a note', /moreOpen = [^;]*noteVal/.test(modal), modal.match(/const moreOpen[^;]*;/));
    assert('  it saves when it is left', /onchange="onJobNoteInput\(\)"/.test(modal));

    const main = { innerHTML: '' };
    const field = { value: '  Gate code 4471 ' };
    const p = page(null, {
      document: { getElementById: id => (id === 'jobNote' ? field : id === 'main' ? main : null) },
      spanDates: () => [D, D2], spanLabel: () => 'the weekdays shown',
      renderJobBoard: () => 'BOARD', renderCrewBoard: () => 'CREW',
      renderModal: () => { throw new Error('the dialog was redrawn'); },
      afterMutate: () => { throw new Error('the dialog was redrawn'); },
    });
    p.state.assignCtx = { mode: 'job', division: DIV, jobId: JOB, date: D };
    p.state.applySpan = 'week5';
    p.onJobNoteInput();
    assert('  it lands on every day of the span', p.getJobNote(D, DIV, JOB) === 'Gate code 4471' && p.getJobNote(D2, DIV, JOB) === 'Gate code 4471');
    eq('  the board is redrawn so a week cell shows it', main.innerHTML, 'BOARD');
    eq('  and the toast names the span', p.toasts[0], 'Note saved · the weekdays shown');
    const saves = p.saves;
    p.onJobNoteInput();
    eq('  the same note again saves nothing', p.saves, saves);

    const key = requireFn(SCHED, 'onJobNoteModalKey', 'scheduler.html');
    // Everything else in the dialog saves as it goes; a note must not be the
    // one thing Escape throws away.
    assert('  Escape saves the note before the dialog closes', /'Escape'\) \{ e\.target\.blur\(\); return; \}/.test(key), key);
    assert('  and other keys stay out of the board’s shortcuts', /e\.stopPropagation\(\)/.test(key), key);
  }

  console.log('\n[a redraw mid-note keeps the words and the caret]');
  {
    const dom = new JSDOM('<!doctype html><body><div id="main"></div><input id="other" type="time"></body>');
    const doc = dom.window.document;
    const JOB2 = 'Hildebrand "yard" O\'Brien';
    const p = page(null, { document: doc });
    const main = doc.getElementById('main');
    const draw = () => { main.innerHTML = p.noteFieldHtml(D, DIV, JOB) + p.noteFieldHtml(D, 'other', JOB2); };
    draw();
    const field = () => Array.from(main.querySelectorAll('.jn-in')).find(x => x.dataset.job === JOB2);
    field().focus();
    field().value = 'Meet at the yard gate';
    field().setSelectionRange(8, 8);
    const typing = p.captureNoteTyping();
    draw();                                    // what a merge does under the cursor
    p.restoreNoteTyping(typing);
    eq('  the words come back', field().value, 'Meet at the yard gate');
    assert('  into the same job’s field, found by walking rather than a selector',
      doc.activeElement === field(), doc.activeElement && doc.activeElement.outerHTML.slice(0, 80));
    eq('  with the caret where it was', field().selectionStart, 8);
    eq('  and they are not saved until the field is left', p.getJobNote(D, 'other', JOB2), '');

    doc.getElementById('other').focus();
    eq('  a redraw with no note being typed restores nothing', p.captureNoteTyping(), null);

    // Closing the tab does not blur the field, so its words are kept on the
    // way out rather than lost with the page.
    field().focus();
    field().value = 'Typed, then the tab was ';
    p.commitNoteTyping();
    eq('  a note still being typed is saved when the tab goes away', p.getJobNote(D, 'other', JOB2), 'Typed, then the tab was');
    eq('  without trimming the field under the cursor, so the next word lands right', field().value, 'Typed, then the tab was ');
    assert('  and the line stops stepping back, as it does when a note is set',
      !field().closest('.jn').classList.contains('unset'), field().closest('.jn').className);
    const away = /document\.addEventListener\('visibilitychange'[\s\S]*?\}\);\s*window\.addEventListener\('pagehide'[^\n]*/.exec(SCHED);
    assert('  on both ways out, before the last save goes',
      away && /commitNoteTyping\(\); flushSaves\(true\)/.test(away[0]) && (away[0].match(/commitNoteTyping\(\); flushSaves\(true\)/g) || []).length === 2,
      away && away[0]);

    const render = requireFn(SCHED, 'render', 'scheduler.html');
    const iCap = render.indexOf('captureNoteTyping()'), iDraw = render.indexOf('main.innerHTML'), iRes = render.indexOf('restoreNoteTyping(typing)');
    assert('  render() takes the note before it redraws and puts it back after',
      iCap > -1 && iDraw > iCap && iRes > render.lastIndexOf('main.innerHTML'), render);
  }

  console.log('\n[it prints on the dispatch sheet]');
  {
    const p = page();
    const a = (id, resource, date, jobId, jobName) => ({ id, resource, kind: 'emp', division: DIV, jobId, jobName, costCode: '' });
    p.state.assignments = {
      [D]:  [a('a1', 'Ben Hudock', D, JOB, 'Franklin Regional Haymaker'), a('a2', 'Ken Stewart', D, JOB, 'Franklin Regional Haymaker'),
             a('a3', 'Ben Hudock', D, '26053', 'Juniata College Baseball')],
    };
    p.setJobNote(DIV, JOB, 'Gate code 4471 & bring the <laser> screed', [D, D2]);
    p.setJobNote(DIV, '26053', 'Infield mix 7 AM', [D]);

    const byJob = p.dispatchBodyJob([D, D2]);
    assert('  the job sheet prints the note', /Gate code 4471 &amp; bring the &lt;laser&gt; screed/.test(byJob), byJob);
    assert('  escaped', !/<laser>/.test(byJob));
    assert('  once for the day, across the whole table', /<td colspan="4"[^>]*><strong[^>]*>Note<\/strong>/.test(byJob), byJob);
    eq('  once per day it is on, not once per cost code', (byJob.match(/Gate code 4471/g) || []).length, 1);
    // D2 has the note but nobody on the job: the sheet lists the days crew
    // are on, and a note on a day nobody is on has nobody to read it.
    assert('  a day nobody is on has no row, so no note', !new RegExp(p.dayLabel(D2)).test(byJob), p.dayLabel(D2));

    const byPerson = p.dispatchBodyPerson([D, D2]);
    assert('  the per-person sheet prints it too', /Gate code 4471 &amp; bring/.test(byPerson), byPerson);
    assert('  naming the job when the person is on more than one',
      /Franklin Regional Haymaker: Gate code 4471/.test(byPerson) && /Juniata College Baseball: Infield mix 7 AM/.test(byPerson), byPerson);
    const ken = byPerson.slice(byPerson.indexOf('Ken Stewart'));
    assert('  and not when they are on one', /Note<\/strong> — Gate code 4471/.test(ken) && !/Haymaker: Gate/.test(ken), ken);
  }

  console.log('\n[it stays on the day it was written for]');
  {
    // Next Monday's crew does not need this Monday's delivery. Copy week
    // repeats the bookings; the times and the note are the day's own.
    const copy = requireFn(SCHED, 'copyWeekForward', 'scheduler.html');
    assert('  Copy week does not carry notes forward', !/siteTimes|setJobNote|getJobNote|setDayEntry/.test(copy), copy.slice(0, 200));
  }

  console.log('\n[the markup can reach every handler]');
  {
    const exported = /Object\.assign\(window, \{([^}]*)\}/.exec(SCHED.replace(/\n/g, ' '));
    ['onJobNoteKey', 'onJobNoteCell', 'onJobNoteInput', 'onJobNoteModalKey'].forEach(n =>
      assert('  ' + n, exported && new RegExp('\\b' + n + '\\b').test(exported[1])));
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
