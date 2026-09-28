#!/usr/bin/env node
'use strict';
/**
 * The crew's notes: three lines per job, per day.
 *
 * Run: node scripts/test-sched-notes.js
 *
 * What a crew needs to know that is not a time — the gate code, the mix coming
 * at seven, bring the laser screed — one thing to a line. They are tied to the
 * job and the day they are about, because a box of free text beside the board
 * says neither, goes stale by Thursday, and never reaches the crew.
 *
 * Pinned below:
 *
 * STORAGE. Each line lives in the siteTimes map under a key of its own, the
 * way the shop time does, so it merges between schedulers with no change to
 * the merge: two schedulers writing different lines, or different jobs, never
 * touch the same entry.
 *
 * WHERE THEY ARE TYPED. On a day board, in the day cell beside the crew, three
 * ruled lines saving the one day they are on; Enter drops to the next line. A
 * week cell is too narrow, so it only SHOWS the lines there; the dialog the
 * cell opens carries the fields, with the Apply-to span.
 *
 * WHAT SURVIVES A REDRAW. The board can be redrawn under somebody mid-note
 * (another scheduler's save merging in). The words and the caret go back into
 * the same line, and the line saves them when it is left.
 *
 * WHERE THEY END UP. On the dispatch sheet, under the job's day, one line each,
 * escaped.
 *
 * No DB or server required; the keyboard and redraw sections use jsdom.
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
// rather than restated, so a change to any of them is a change seen here. The
// two constants are read off the page for the same reason.
const HELPERS = sliceSource(SCHED, 'const esc = s =>', '// "06:30"', 'the page helpers', 'function shortDate(');
const SHEET   = sliceSource(SCHED, 'const _td =', 'function dispatchDates(', 'the dispatch sheet styles', 'function dispatchNote(');
const NOTE_MAX   = Number((/const NOTE_MAX = (\d+);/.exec(SCHED) || [])[1]);
const NOTE_LINES = Number((/const NOTE_LINES = (\d+);/.exec(SCHED) || [])[1]);

const FNS = ['siteKey','shopKey','noteKey','timeKeyFor','getJobTime','setJobTime','setDayEntry','getSiteTime','getShopTime',
             'cleanNote','getJobNote','getJobNotes','setJobNote','noteFieldHtml','noteTitle','onJobNoteKey','noteLine',
             'onJobNoteCell','cellNoteHtml','captureNoteTyping','restoreNoteTyping','commitNoteTyping',
             'onJobNoteInput','onJobNoteModalKey',
             '_flatTimes','_unflatTimes','mergeSiteTimes','_recoverTimes',
             'fmtTime','dayLabel','dispatchJobSummary','dispatchCodeMeta','dispatchBodyJob','dispatchBodyPerson'];

function page(siteTimes, extra) {
  const sandbox = {
    console, saves: 0, toasts: [],
    state: { siteTimes: siteTimes || {}, assignments: {}, applySpan: 'day', view: 'job', assignCtx: null },
    // Nothing here is about which job a row belongs to; the sheet only asks.
    jobById: () => null, codeOf: () => null, divLabel: d => d,
    ...(extra || {}),
  };
  sandbox.saveAssignments = () => { sandbox.saves++; };
  sandbox.toast = m => { sandbox.toasts.push(m); };
  vm.createContext(sandbox);
  vm.runInContext('var NOTE_MAX = ' + NOTE_MAX + ', NOTE_LINES = ' + NOTE_LINES + ';', sandbox);
  evalSlice(HELPERS, sandbox, 'the page helpers', { filename: 'scheduler.html' });
  evalSlice(SHEET, sandbox, 'the dispatch sheet styles', { filename: 'scheduler.html' });
  FNS.forEach(n => vm.runInContext(requireFn(SCHED, n, 'scheduler.html'), sandbox, { filename: 'scheduler.html' }));
  return sandbox;
}
// A page wired to a real DOM, for the parts that move focus between fields.
function domPage(html) {
  const dom = new JSDOM('<!doctype html><body><div id="main"></div>' + (html || '') + '</body>');
  const doc = dom.window.document;
  const p = page(null, { document: doc });
  return { p, doc, main: doc.getElementById('main') };
}
const ev = key => ({ key, stopped: 0, prevented: 0, stopPropagation() { this.stopped++; }, preventDefault() { this.prevented++; } });
const D = '2026-09-28', D2 = '2026-09-29', DIV = 'turf', JOB = '26049';

(async () => {
  console.log('The crew’s notes\n');

  console.log('[three lines, each with a key of its own]');
  {
    const p = page();
    eq('  the page draws three lines', NOTE_LINES, 3);
    const keys = [0, 1, 2].map(i => p.noteKey(DIV, JOB, i));
    eq('  three different keys', new Set(keys).size, 3);
    eq('  the first keeps the key a single note was saved under', keys[0], 'note¦turf::26049');
    assert('  none is the site key or the shop key',
      keys.every(k => k !== p.siteKey(DIV, JOB) && k !== p.shopKey(DIV, JOB)));
    assert('  all prefixed, like the shop key, so no job’s note is ever another’s time',
      keys.every(k => k.startsWith('note') && k !== p.siteKey(DIV, JOB + '::note')));
  }

  console.log('\n[stored beside the times, each line on its own]');
  {
    const p = page();
    p.setJobTime('shop', DIV, JOB, '06:15', [D]);
    p.setJobTime('site', DIV, JOB, '07:00', [D]);
    p.setJobNote(DIV, JOB, 0, 'Gate code 4471', [D]);
    p.setJobNote(DIV, JOB, 2, 'Bring the laser screed', [D]);
    eq('  line one reads back', p.getJobNote(D, DIV, JOB, 0), 'Gate code 4471');
    eq('  line three reads back', p.getJobNote(D, DIV, JOB, 2), 'Bring the laser screed');
    eq('  all three, in place — an empty middle line stays in the middle',
      JSON.stringify(p.getJobNotes(D, DIV, JOB)), JSON.stringify(['Gate code 4471', '', 'Bring the laser screed']));
    eq('  the shop time is untouched', p.getShopTime(D, DIV, JOB), '06:15');
    eq('  the site time is untouched', p.getSiteTime(D, DIV, JOB), '07:00');
    eq('  a line is a string, which the merge depends on', typeof p.state.siteTimes[D][p.noteKey(DIV, JOB, 2)], 'string');
    p.setJobNote(DIV, JOB, 0, '', [D]);
    eq('  clearing one line takes only that entry off', p.state.siteTimes[D][p.noteKey(DIV, JOB, 0)], undefined);
    eq('  and leaves the others', p.getJobNote(D, DIV, JOB, 2), 'Bring the laser screed');

    const q = page();
    q.setJobNote(DIV, JOB, 1, 'Mix at 7', [D]);
    q.setJobNote(DIV, JOB, 1, '   ', [D]);
    eq('  a date left with nothing on it goes too', q.state.siteTimes[D], undefined);
    assert('  every change is saved', q.saves === 2, `saves ${q.saves}`);
  }

  console.log('\n[one line each, trimmed, capped]');
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
    eq('  a stored line is the cleaned one', (p.setJobNote(DIV, JOB, 1, '  a \n b ', [D]), p.getJobNote(D, DIV, JOB, 1)), 'a b');
  }

  console.log('\n[two schedulers, nothing lost]');
  {
    // Both started from the same saved week. One writes line one on Franklin;
    // the other writes line two on Franklin, a note on Juniata and a site time.
    const p = page();
    const base = JSON.stringify({});
    const ours   = { [D]: { [p.noteKey(DIV, JOB, 0)]: 'Gate code 4471' } };
    const theirs = { [D]: { [p.noteKey(DIV, JOB, 1)]: 'Mulch at 7', [p.noteKey(DIV, '26053', 0)]: 'Infield mix 7 AM', [p.siteKey(DIV, JOB)]: '07:00' } };
    const out = p.mergeSiteTimes(base, ours, theirs);
    eq('  our line is kept', out[D][p.noteKey(DIV, JOB, 0)], 'Gate code 4471');
    eq('  their other line on the same job is kept', out[D][p.noteKey(DIV, JOB, 1)], 'Mulch at 7');
    eq('  their note on another job is kept', out[D][p.noteKey(DIV, '26053', 0)], 'Infield mix 7 AM');
    eq('  their time on the same job is kept', out[D][p.siteKey(DIV, JOB)], '07:00');

    // Clearing a line is a change like any other, and survives the merge.
    const base2 = JSON.stringify({ [D]: { [p.noteKey(DIV, JOB, 2)]: 'Old note' } });
    const cleared = p.mergeSiteTimes(base2, {}, { [D]: { [p.noteKey(DIV, JOB, 2)]: 'Old note' } });
    eq('  a line we cleared stays cleared', (cleared[D] || {})[p.noteKey(DIV, JOB, 2)], undefined);

    // A line typed before a save that never landed comes back on the next load.
    const rec = p._recoverTimes({}, { [D]: { [p.noteKey(DIV, JOB, 1)]: 'Unsaved note' } });
    eq('  an unsaved line is recovered from the local copy', rec[D][p.noteKey(DIV, JOB, 1)], 'Unsaved note');
  }

  console.log('\n[on a day board they are typed in the day cell]');
  {
    const p = page();
    const none = p.noteFieldHtml(D, DIV, JOB);
    eq('  three text fields are always drawn', (none.match(/<input type="text" class="jn-in"/g) || []).length, 3);
    assert('  one to a line', /data-line="0"/.test(none) && /data-line="1"/.test(none) && /data-line="2"/.test(none), none);
    eq('  only the first carries the hint', (none.match(/placeholder=/g) || []).length, 1);
    assert('  marked unset while all three are empty, so they step back', /class="jn unset"/.test(none), none);
    assert('  labelled in words', />Notes</.test(none), none);
    eq('  each capped at the length the page cleans to', (none.match(new RegExp('maxlength="' + NOTE_MAX + '"', 'g')) || []).length, 3);
    assert('  a click in them does not open the cell’s dialog', /onclick="event\.stopPropagation\(\)"/.test(none), none);
    eq('  each saves when it is left', (none.match(/onblur="onJobNoteCell\(this\)"/g) || []).length, 3);
    assert('  and knows its own day and job',
      /data-date="2026-09-28"/.test(none) && /data-div="turf"/.test(none) && /data-job="26049"/.test(none), none);
    const pictures = none.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
    assert('  words, not pictures', pictures.length === 0, pictures.join(' '));

    p.setJobNote(DIV, JOB, 1, 'Mulch at 7', [D]);
    const set = p.noteFieldHtml(D, DIV, JOB);
    assert('  a set line carries its value, on its own line', /value="Mulch at 7" data-date="2026-09-28" data-div="turf" data-job="26049" data-line="1"/.test(set), set);
    assert('  one set line is enough to stop the block stepping back', /class="jn"/.test(set) && !/jn unset/.test(set), set);

    const nasty = page();
    nasty.setJobNote(DIV, JOB, 2, '"><img src=x onerror=alert(1)> & co', [D]);
    const h = nasty.noteFieldHtml(D, DIV, JOB);
    assert('  a line is escaped in the field', !/<img/.test(h) && /&quot;&gt;&lt;img/.test(h) && /&amp; co/.test(h), h);

    const row = requireFn(SCHED, 'jobRowHtml', 'scheduler.html');
    assert('  the day board puts the lines in the day cell', /oneDay \? noteFieldHtml\(d,/.test(row), row.slice(0, 400));
  }

  console.log('\n[a line saves the one day it is on, and only when it changed]');
  {
    const p = page();
    const classes = [];
    const el = { dataset: { date: D, div: DIV, job: JOB, line: '1' }, value: '  Mulch at 7 ', title: '',
                 closest: () => ({ classList: { toggle: (c, on) => classes.push([c, on]) } }) };
    p.onJobNoteCell(el);
    eq('  it saves the cleaned line', p.getJobNote(D, DIV, JOB, 1), 'Mulch at 7');
    eq('  on its own line, not another', p.getJobNote(D, DIV, JOB, 0) + p.getJobNote(D, DIV, JOB, 2), '');
    eq('  the field shows what was saved', el.value, 'Mulch at 7');
    eq('  on that day only', p.getJobNote(D2, DIV, JOB, 1), '');
    assert('  it restyles its own block rather than redrawing the board',
      classes.length === 1 && classes[0][0] === 'unset' && classes[0][1] === false, JSON.stringify(classes));
    eq('  and says so', p.toasts[0], 'Note saved · ' + p.shortDate(D));
    const saves = p.saves;
    p.onJobNoteCell(el);
    eq('  leaving it unchanged saves nothing', p.saves, saves);
    el.value = '';
    p.onJobNoteCell(el);
    eq('  emptying it clears the line', p.getJobNote(D, DIV, JOB, 1), '');
    eq('  and says that instead', p.toasts[p.toasts.length - 1], 'Note cleared · ' + p.shortDate(D));
    assert('  with every line empty, the block steps back again', classes[classes.length - 1][1] === true, JSON.stringify(classes));

    const src = requireFn(SCHED, 'onJobNoteCell', 'scheduler.html');
    assert('  no redraw under the cursor', !/\brender\(\)/.test(src) && !/afterMutate\(/.test(src) && !/innerHTML/.test(src), src);
    assert('  compared with what is stored, not with what the field held on focus', /getJobNote\(/.test(src), src);
  }

  console.log('\n[the lines work like a notepad, and the board never hears the keys]');
  {
    const { p, doc, main } = domPage();
    p.setJobNote(DIV, JOB, 0, 'Gate code 4471', [D]);
    main.innerHTML = p.noteFieldHtml(D, DIV, JOB);
    const lines = () => Array.from(main.querySelectorAll('.jn-in'));

    lines()[0].focus();
    const enter = ev('Enter');
    p.onJobNoteKey(enter, lines()[0]);
    assert('  Enter drops to the next line', doc.activeElement === lines()[1] && enter.prevented === 1);
    p.onJobNoteKey(ev('Enter'), lines()[1]);
    assert('  and the next', doc.activeElement === lines()[2]);
    lines()[2].value = 'half typed';
    const last = ev('Enter');
    p.onJobNoteKey(last, lines()[2]);
    assert('  on the last line Enter just leaves it, which saves it', doc.activeElement !== lines()[2] && last.prevented === 1);
    eq('  keeping what was typed', lines()[2].value, 'half typed');

    lines()[1].focus();
    p.onJobNoteKey(ev('ArrowUp'), lines()[1]);
    assert('  the up arrow moves up a line', doc.activeElement === lines()[0]);
    p.onJobNoteKey(ev('ArrowDown'), lines()[0]);
    assert('  and the down arrow down one', doc.activeElement === lines()[1]);
    lines()[0].focus();
    const top = ev('ArrowUp');
    p.onJobNoteKey(top, lines()[0]);
    assert('  past the top the arrow is left to the field', doc.activeElement === lines()[0] && top.prevented === 0);

    lines()[0].value = 'oops';
    const esc = ev('Escape');
    p.onJobNoteKey(esc, lines()[0]);
    eq('  Escape puts back what that line held', lines()[0].value, 'Gate code 4471');
    assert('  and leaves it', doc.activeElement !== lines()[0]);

    const z = ev('z');
    lines()[1].focus();
    p.onJobNoteKey(z, lines()[1]);
    assert('  no key reaches the board (Ctrl+Z undoes typing, not a booking)',
      enter.stopped === 1 && esc.stopped === 1 && z.stopped === 1 && doc.activeElement === lines()[1]);
  }

  console.log('\n[on a week board they are shown, not typed]');
  {
    const p = page();
    eq('  a day with no notes shows nothing', p.cellNoteHtml(D, DIV, JOB), '');
    p.setJobNote(DIV, JOB, 2, 'Infield mix delivered 7 AM <sharp>', [D]);
    const one = p.cellNoteHtml(D, DIV, JOB);
    assert('  a day with one line shows it, under "Note"', /Infield mix delivered 7 AM/.test(one) && />Note</.test(one), one);
    assert('  escaped', /&lt;sharp&gt;/.test(one) && !/<sharp>/.test(one), one);
    p.setJobNote(DIV, JOB, 0, 'Gate code 4471', [D]);
    const two = p.cellNoteHtml(D, DIV, JOB);
    eq('  each line that has something on it gets a line, the empty one none', (two.match(/class="cell-note"/g) || []).length, 2);
    assert('  in their order, under "Notes"', two.indexOf('Gate code 4471') < two.indexOf('Infield mix') && />Notes</.test(two), two);
    assert('  with all of them on hover, a line each',
      /title="Gate code 4471\nInfield mix delivered 7 AM &lt;sharp&gt;"/.test(two), two);
    assert('  and no field to type into', !/<input/.test(two), two);
    const pictures = two.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
    assert('  words, not pictures', pictures.length === 0, pictures.join(' '));

    const row = requireFn(SCHED, 'jobRowHtml', 'scheduler.html');
    // The times wait for somebody to be on the day; a note does not have to.
    assert('  shown whether or not anybody is on the day yet',
      /: \(wantTimes \? cellTimesHtml\(d, job\.division, job\.id\) : ''\) \+ cellNoteHtml\(d,/.test(row), row.slice(0, 600));
  }

  console.log('\n[the dialog carries all three, across the Apply-to span]');
  {
    const modal = requireFn(SCHED, 'modalJobHtml', 'scheduler.html');
    assert('  the dialog has a field per line', /id="jobNote'\+i\+'"/.test(modal) && /getJobNotes\(ctx\.date, ctx\.division, ctx\.jobId\)/.test(modal));
    assert('  its section opens by itself when any line is set', /moreOpen = [^;]*noteCount/.test(modal), modal.match(/const moreOpen[^;]*;/));
    assert('  each line saves when it is left', /onchange="onJobNoteInput\('\+i\+'\)"/.test(modal));

    const main = { innerHTML: '' };
    const field = { value: '  Mulch at 7 ' };
    const p = page(null, {
      document: { getElementById: id => (id === 'jobNote1' ? field : id === 'main' ? main : null) },
      spanDates: () => [D, D2], spanLabel: () => 'the weekdays shown',
      renderJobBoard: () => 'BOARD', renderCrewBoard: () => 'CREW',
      renderModal: () => { throw new Error('the dialog was redrawn'); },
      afterMutate: () => { throw new Error('the dialog was redrawn'); },
    });
    p.state.assignCtx = { mode: 'job', division: DIV, jobId: JOB, date: D };
    p.state.applySpan = 'week5';
    p.setJobNote(DIV, JOB, 0, 'Gate code 4471', [D]);
    p.onJobNoteInput(1);
    assert('  the line lands on every day of the span', p.getJobNote(D, DIV, JOB, 1) === 'Mulch at 7' && p.getJobNote(D2, DIV, JOB, 1) === 'Mulch at 7');
    eq('  and leaves the other lines alone', p.getJobNote(D, DIV, JOB, 0), 'Gate code 4471');
    eq('  the board is redrawn so a week cell shows it', main.innerHTML, 'BOARD');
    eq('  and the toast names the span', p.toasts[0], 'Note saved · the weekdays shown');
    const saves = p.saves;
    p.onJobNoteInput(1);
    eq('  the same line again saves nothing', p.saves, saves);

    // Enter walks the dialog's lines as it does the board's.
    const focused = [];
    const q = page(null, { document: { getElementById: id => (/^jobNote[0-2]$/.test(id) ? { focus: () => focused.push(id) } : null) } });
    const tgt = { blurred: 0, blur() { this.blurred++; } };
    const e0 = ev('Enter'); e0.target = tgt;
    q.onJobNoteModalKey(e0, 0);
    assert('  Enter in the dialog drops to the next line', focused[0] === 'jobNote1' && tgt.blurred === 0);
    const e2 = ev('Enter'); e2.target = tgt;
    q.onJobNoteModalKey(e2, 2);
    assert('  and on the last line leaves it, which saves it', focused.length === 1 && tgt.blurred === 1);

    const key = requireFn(SCHED, 'onJobNoteModalKey', 'scheduler.html');
    // Everything else in the dialog saves as it goes; a note must not be the
    // one thing Escape throws away.
    assert('  Escape saves the line before the dialog closes', /'Escape'\) \{ e\.target\.blur\(\); return; \}/.test(key), key);
    assert('  and other keys stay out of the board’s shortcuts', /e\.stopPropagation\(\)/.test(key), key);
  }

  console.log('\n[a redraw mid-note keeps the words and the caret]');
  {
    const { p, doc, main } = domPage('<input id="other" type="time"><input id="jobNote2" type="text">');
    const JOB2 = 'Hildebrand "yard" O\'Brien';
    const draw = () => { main.innerHTML = p.noteFieldHtml(D, DIV, JOB) + p.noteFieldHtml(D, 'other', JOB2); };
    draw();
    const field = line => Array.from(main.querySelectorAll('.jn-in')).find(x => x.dataset.job === JOB2 && x.dataset.line === String(line));
    field(1).focus();
    field(1).value = 'Meet at the yard gate';
    field(1).setSelectionRange(8, 8);
    const typing = p.captureNoteTyping();
    draw();                                    // what a merge does under the cursor
    p.restoreNoteTyping(typing);
    eq('  the words come back', field(1).value, 'Meet at the yard gate');
    assert('  into the same job’s same line, found by walking rather than a selector',
      doc.activeElement === field(1) && field(0).value === '' && field(2).value === '',
      doc.activeElement && doc.activeElement.outerHTML.slice(0, 120));
    eq('  with the caret where it was', field(1).selectionStart, 8);
    eq('  and they are not saved until the line is left', p.getJobNote(D, 'other', JOB2, 1), '');

    doc.getElementById('other').focus();
    eq('  a redraw with no note being typed restores nothing', p.captureNoteTyping(), null);

    // Closing the tab does not blur the field, so its words are kept on the
    // way out rather than lost with the page.
    field(2).focus();
    field(2).value = 'Typed, then the tab was ';
    p.commitNoteTyping();
    eq('  a line still being typed is saved when the tab goes away', p.getJobNote(D, 'other', JOB2, 2), 'Typed, then the tab was');
    eq('  without trimming the field under the cursor, so the next word lands right', field(2).value, 'Typed, then the tab was ');
    assert('  and the block stops stepping back, as it does when a line is set',
      !field(2).closest('.jn').classList.contains('unset'), field(2).closest('.jn').className);

    // The same for a line being typed in the dialog.
    p.state.assignCtx = { mode: 'job', division: DIV, jobId: JOB, date: D };
    p.spanDates = d => [d];
    p.renderJobBoard = () => '';
    const dlg = doc.getElementById('jobNote2');
    dlg.focus(); dlg.value = 'From the dialog ';
    p.commitNoteTyping();
    eq('  and a dialog line still being typed is saved too', p.getJobNote(D, DIV, JOB, 2), 'From the dialog');

    const away = /document\.addEventListener\('visibilitychange'[\s\S]*?\}\);\s*window\.addEventListener\('pagehide'[^\n]*/.exec(SCHED);
    assert('  on both ways out, before the last save goes',
      away && (away[0].match(/commitNoteTyping\(\); flushSaves\(true\)/g) || []).length === 2, away && away[0]);

    const render = requireFn(SCHED, 'render', 'scheduler.html');
    const iCap = render.indexOf('captureNoteTyping()'), iDraw = render.indexOf('main.innerHTML'), iRes = render.indexOf('restoreNoteTyping(typing)');
    assert('  render() takes the note before it redraws and puts it back after',
      iCap > -1 && iDraw > iCap && iRes > render.lastIndexOf('main.innerHTML'), render);
  }

  console.log('\n[they print on the dispatch sheet]');
  {
    const p = page();
    const a = (id, resource, jobId, jobName) => ({ id, resource, kind: 'emp', division: DIV, jobId, jobName, costCode: '' });
    p.state.assignments = {
      [D]: [a('a1', 'Ben Hudock', JOB, 'Franklin Regional Haymaker'), a('a2', 'Ken Stewart', JOB, 'Franklin Regional Haymaker'),
            a('a3', 'Ben Hudock', '26053', 'Juniata College Baseball')],
    };
    p.setJobNote(DIV, JOB, 0, 'Gate code 4471 & bring the <laser> screed', [D, D2]);
    p.setJobNote(DIV, JOB, 2, 'Mulch at 7', [D]);
    p.setJobNote(DIV, '26053', 1, 'Infield mix 7 AM', [D]);

    const byJob = p.dispatchBodyJob([D, D2]);
    assert('  the job sheet prints each line, one to a line, the empty one skipped',
      /Gate code 4471 &amp; bring the &lt;laser&gt; screed<br>Mulch at 7</.test(byJob), byJob);
    assert('  escaped', !/<laser>/.test(byJob));
    assert('  once for the day, across the whole table, under "Notes"', /<td colspan="4"[^>]*><strong[^>]*>Notes<\/strong>/.test(byJob), byJob);
    assert('  and under "Note" when there is only one', /<strong[^>]*>Note<\/strong> — Infield mix 7 AM/.test(byJob), byJob);
    eq('  once per day it is on, not once per cost code', (byJob.match(/Gate code 4471/g) || []).length, 1);
    // D2 has a note but nobody on the job: the sheet lists the days crew are
    // on, and a note on a day nobody is on has nobody to read it.
    assert('  a day nobody is on has no row, so no note', !new RegExp(p.dayLabel(D2)).test(byJob), p.dayLabel(D2));

    const byPerson = p.dispatchBodyPerson([D, D2]);
    assert('  the per-person sheet prints them too', /Gate code 4471 &amp; bring[^<]*<br>Mulch at 7/.test(byPerson), byPerson);
    assert('  naming the job when the person is on more than one',
      /Franklin Regional Haymaker: Gate code 4471/.test(byPerson) && /Juniata College Baseball: Infield mix 7 AM/.test(byPerson), byPerson);
    const ken = byPerson.slice(byPerson.indexOf('Ken Stewart'));
    assert('  and not when they are on one', /Notes<\/strong> — Gate code 4471/.test(ken) && !/Haymaker: Gate/.test(ken), ken);
  }

  console.log('\n[they stay on the day they were written for]');
  {
    // Next Monday's crew does not need this Monday's delivery. Copy week
    // repeats the bookings; the times and the notes are the day's own.
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
