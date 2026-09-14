#!/usr/bin/env node
'use strict';
/**
 * The haul UIs, in a real browser.
 *
 * Run: node scripts/test-haul-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *
 * Everything else on this branch is code-level — functions lifted out of the
 * pages and run in a sandbox. That cannot tell you whether the control actually
 * renders, whether it is reachable, or whether the page still boots at all. It
 * is exactly the class of gap the owner's own manual test found twice.
 *
 * Two harness traps this hit, both worth keeping written down because either one
 * makes the suite measure nothing while reporting a failure that looks real:
 *
 *   - The pages MUST be served over HTTP. Loaded from file://, a relative
 *     `/api/...` fetch never leaves as HTTP, every lookup fails, and the form
 *     degrades exactly as it would offline.
 *   - The stubbed fct_user MUST carry allowedDivisions. Without it timesheet.html
 *     shows its no-access panel and init() never runs, so nothing is fetched and
 *     every control is legitimately hidden.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright not installed — skipping browser checks'); process.exit(0); }
const path = require('path');
const http = require('http');
const fs   = require('fs');
const ROOT = path.resolve(__dirname, '..');

// Served over HTTP, not file://. A page loaded from file:// cannot fetch a
// relative /api/ URL at all — the request never leaves as HTTP, so every lookup
// fails and the form degrades exactly as it would offline. That would have made
// this whole harness measure the wrong thing.
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});
const BASE = new Promise(r => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port)));

let passed = 0, failed = 0;
const ok = (l, c, d) => { if (c) { passed++; console.log('  ✓ ' + l); } else { failed++; console.log('  ✗ ' + l + (d ? '  — ' + d : '')); } };

const TOKEN = 'x.y.z';
const USER  = { id: 7, username: 'hudockben', role: 'admin', companyCode: 'FCT',
              isPlatformAdmin: true, allowedDivisions: ['timesheet','payroll','turf'] };

// Every API the two pages touch on boot, answered with the smallest honest body.
function mockApi(page, { isDriver = true, equipment = [] } = {}) {
  return page.route('**/api/**', route => {
    const u = route.request().url();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('/api/timesheet-supervisors')) {
      return json({ supervisors: [{ id: 3, name: 'brewernate' }], is_driver: isDriver });
    }
    if (u.includes('/api/equipment'))       return json({ equipment });
    if (u.includes('/api/timesheet-jobs'))  return json({ jobs: [{ id: '26049', label: 'Franklin Regional Multi · 26049' }] });
    if (u.includes('/api/timesheet-entries')) return json({ entries: [] });
    if (u.includes('/api/company/users'))   return json({ users: [] });
    if (u.includes('/api/employees'))       return json({ employees: [] });
    if (u.includes('/api/projects'))        return json({ projects: [] });
    return json({});
  });
}

async function boot(page, file, opts) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ t, u }) => {
    localStorage.setItem('fct_token', t);
    localStorage.setItem('fct_user', JSON.stringify(u));
    localStorage.setItem('fct_division', 'turf');
  }, { t: TOKEN, u: USER });
  await mockApi(page, opts || {});
  await page.goto((await BASE) + '/' + file);
  await page.waitForTimeout(1200);
  return errors;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // ── The driver's form ────────────────────────────────────────────────────
  console.log('\n[timesheet.html — the driver is asked]');
  {
    const page = await browser.newPage();
    const errs = await boot(page, 'timesheet.html',
      { isDriver: true, equipment: [{ name: 'Triaxle Dump' }, { name: 'Lowboy' }] });
    ok('the page boots with no uncaught error', errs.length === 0, errs.slice(0, 2).join(' | '));

    const haulShown = await page.evaluate(() => {
      const r = document.getElementById('row-haul');
      return !!r && getComputedStyle(r).display !== 'none';
    });
    ok('a flagged driver is asked the hauling question', haulShown);

    const labels = await page.$$eval('#seg-haul button', b => b.map(x => x.textContent.trim()));
    ok('with all three answers', labels.length === 3 && labels.includes('On site'), labels.join('/'));

    // Nothing is answered for him. The control used to open on "No", so a
    // driver who scrolled past it filed the same entry as one who read it and
    // got it wrong — and afterwards nothing could tell the two apart. This is
    // the check that has to run in a real browser: the sandbox can say the
    // class is absent, only this can say the pill is not lit on screen.
    const fresh = await page.evaluate(() => {
      const seg = document.getElementById('seg-haul');
      const bg  = b => getComputedStyle(b).backgroundColor;
      return {
        lit:    [...seg.querySelectorAll('button')].filter(b => b.classList.contains('on')).length,
        needs:  seg.classList.contains('needs'),
        marker: getComputedStyle(document.getElementById('haul-need')).display !== 'none',
        // Every segment paints the same as its neighbours while unanswered.
        flat:   new Set([...seg.querySelectorAll('button')].map(bg)).size === 1,
      };
    });
    ok('the question opens with no answer chosen for him', fresh.lit === 0 && fresh.flat,
      JSON.stringify(fresh));
    ok('  and says so — dashed outline plus a "pick one" marker',
      fresh.needs && fresh.marker, JSON.stringify(fresh));

    // Answering it should reveal the truck picker, filled from the equipment list.
    await page.evaluate(() => { document.getElementById('f-division').value = 'turf'; });
    await page.click('#seg-haul button[data-val="off_site"]');
    await page.waitForTimeout(600);
    const unit = await page.evaluate(() => {
      const r = document.getElementById('row-haul-unit');
      const s = document.getElementById('haul-unit');
      return { shown: !!r && getComputedStyle(r).display !== 'none',
               opts: s ? [...s.options].map(o => o.value).filter(Boolean) : [] };
    });
    ok('answering "haul" reveals the truck picker', unit.shown);

    // And the answer he picked is its own colour rather than the same teal as
    // every other answer on the page — the second half of the same complaint.
    const hues = await page.evaluate(() => {
      const seg = document.getElementById('seg-haul');
      const by  = v => seg.querySelector(`button[data-val="${v}"]`);
      const lit = [...seg.querySelectorAll('button')].filter(b => b.classList.contains('on'));
      return {
        needs: seg.classList.contains('needs'),
        marker: getComputedStyle(document.getElementById('haul-need')).display !== 'none',
        litVal: lit.length === 1 ? lit[0].dataset.val : null,
        offSite: getComputedStyle(by('off_site')).backgroundColor,
        onSite:  getComputedStyle(by('on_site')).backgroundColor,
        no:      getComputedStyle(by('')).backgroundColor,
      };
    });
    ok('  and only the answer he picked is lit', hues.litVal === 'off_site', hues.litVal);
    ok('  the needs-an-answer marking is gone', !hues.needs && !hues.marker);
    ok('  "To & from" lights green, not the teal every other answer uses',
      hues.offSite === 'rgb(34, 197, 94)', hues.offSite);
    ok('  and the two answers he did not pick look nothing like it',
      hues.onSite !== hues.offSite && hues.no !== hues.offSite,
      `${hues.no} / ${hues.onSite} / ${hues.offSite}`);
    ok('  populated from the company equipment list',
      unit.opts.includes('Triaxle Dump') && unit.opts.includes('Lowboy'), unit.opts.join('/'));

    // And taking the answer back hides it again.
    await page.click('#seg-haul button[data-val=""]');
    await page.waitForTimeout(300);
    const hidden = await page.evaluate(() =>
      getComputedStyle(document.getElementById('row-haul-unit')).display === 'none');
    ok('answering "no" hides it again', hidden);

    // "No" is an answer, not the absence of one — tapping it has to look
    // different from never having touched the control.
    const said = await page.evaluate(() => {
      const seg = document.getElementById('seg-haul');
      return { needs: seg.classList.contains('needs'),
               no: getComputedStyle(seg.querySelector('button[data-val=""]')).backgroundColor };
    });
    ok('  and reads as answered, not as untouched',
      !said.needs && said.no === 'rgb(96, 165, 250)', JSON.stringify(said));

    // A second job on the same day is a second haul question, and it opens
    // blank too — a split day was the easiest way to inherit a wrong answer.
    await page.click('#btn-add-split');
    await page.waitForTimeout(200);
    const split = await page.evaluate(() => {
      const seg = document.querySelector('[id$="-seg-haul"]');
      if (!seg) return null;
      return { id: seg.id, needs: seg.classList.contains('needs'),
               lit: [...seg.querySelectorAll('button')].filter(b => b.classList.contains('on')).length };
    });
    ok('a second job opens its own haul question unanswered',
      !!split && split.needs && split.lit === 0, JSON.stringify(split));

    // The enforcement half. Removing the default only helps if a blank answer
    // stops the day going out — otherwise the wrong "No" is just traded for a
    // silent null. Fill a complete single-job day, leave this one question
    // alone, and ask the form what it would save.
    const gate = await page.evaluate(async () => {
      removeSplit(document.querySelector('[id$="-seg-haul"]').id.split('-')[0].slice(1) * 1);
      document.getElementById('f-division').value = 'turf';
      await onDivisionChange(0);
      const job = document.getElementById('f-job');
      job.value = [...job.options].map(o => o.value).filter(Boolean)[0] || '';
      onJobChange(0);
      document.getElementById('f-start').value = '07:00';
      document.getElementById('f-end').value   = '15:30';
      updateHours(0);
      setSeg('lunch', true);
      setSeg('equip', false);
      const sup = document.getElementById('f-supervisor');
      sup.value = [...sup.options].map(o => o.value).filter(Boolean)[0] || '';
      // Back to untouched, the way the driver's form actually opens.
      haulVals[0] = null; renderHaul(0); applyHaulUnitVisibility(0);
      const blank = buildPayloads();
      setHaul('on_site', 0);
      const answered = buildPayloads();
      return {
        blankErr: blank.error || null,
        answeredErr: answered.error || null,
        posted: answered.list ? answered.list[0].data.haul_type : undefined,
      };
    });
    ok('a day with the haul question untouched will not save',
      /haul/i.test(gate.blankErr || ''), JSON.stringify(gate));
    ok('  and the same day saves the moment he answers',
      gate.answeredErr === null && gate.posted === 'on_site', JSON.stringify(gate));
    await page.close();
  }

  console.log('\n[timesheet.html — a non-driver is not]');
  {
    const page = await browser.newPage();
    const errs = await boot(page, 'timesheet.html', { isDriver: false });
    ok('the page boots with no uncaught error', errs.length === 0, errs.slice(0, 2).join(' | '));
    const shown = await page.evaluate(() => {
      const r = document.getElementById('row-haul');
      return !!r && getComputedStyle(r).display !== 'none';
    });
    ok('the question is not shown', shown === false);
    await page.close();
  }

  // ── The approver's modal ─────────────────────────────────────────────────
  console.log('\n[payroll.html — the approver can classify]');
  {
    const page = await browser.newPage();
    const errs = await boot(page, 'payroll.html');
    ok('the page boots with no uncaught error', errs.length === 0, errs.slice(0, 2).join(' | '));

    // ── The question, on every row ─────────────────────────────────────
    // It used to be asked once for the whole day, above the table. That made
    // the approver answer for the majority of the day and then correct the rest
    // with a checkbox — and a day holding both answers could not be said at all.
    const built = await page.evaluate(() => {
      splitEntry = { id: 1, computed_hours: 9, travel_hours: 1,
                     haul_type: null, truck_unit: 'Triaxle Dump' };
      splitHaulAnswer = '';
      splitProjEquipment = [];
      splitRows = [
        { cost_code: 'Notch Milling', sub_code: 'Milling - Trucking', quantity: 0,
          equipment: '', labor_hours: 6.5, equip_hours: 0, is_travel: false,
          code_source: '', haul_type: '' },
        { cost_code: 'Notch Milling', sub_code: 'Scratch/leveling - Labor', quantity: 0,
          equipment: '', labor_hours: 2.5, equip_hours: 0, is_travel: false,
          code_source: '', haul_type: '' },
        { cost_code: 'Mobilization', sub_code: 'Travel', quantity: 0, equipment: '',
          labor_hours: 1, equip_hours: 0, is_travel: true, code_source: '', haul_type: '' },
      ];
      renderSplitRows();
      const picks = () => [...document.querySelectorAll('#splitTbody select.haul-pick')];
      const cells = () => [...document.querySelectorAll('#splitTbody tr')]
        .map(tr => tr.children[9] ? tr.children[9].textContent.trim() : null);
      return {
        count: picks().length,
        opts: picks()[0] ? [...picks()[0].options].map(o => o.value) : null,
        labels: picks()[0] ? [...picks()[0].options].map(o => o.textContent.trim()) : null,
        marked: picks().every(p => p.classList.contains('needed')),
        travelCell: cells()[2],
        gone: typeof splitHaulPickerHtml === 'undefined'
          && !document.getElementById('splitHaulPick'),
      };
    });
    ok('every labour row carries the question', built.count === 2, String(built.count));
    ok('  and the travel row is never asked — the commute is not the truck\'s time',
      /not asked/.test(built.travelCell || ''), built.travelCell);
    ok('  with all three answers plus the blank it opens on',
      built.opts && built.opts.join('|') === '|none|on_site|off_site',
      JSON.stringify(built.opts));
    ok('  spelled out the way the driver was asked them',
      built.labels && /No — worked on site/.test(built.labels[1])
      && /hauled on site/.test(built.labels[2])
      && /to & from site/.test(built.labels[3]),
      JSON.stringify(built.labels));
    ok('  marked until they are answered', built.marked === true);
    ok('  and the one day-level picker is gone', built.gone === true);

    // The day nobody could describe before: one leg in the truck, one on foot.
    const perRow = await page.evaluate(() => {
      const boxes = () => [...document.querySelectorAll('#splitTbody .haul-col input')]
        .map(b => b.checked);
      const colShown = () => {
        const th = document.querySelector('.split-table thead .haul-col');
        return !!th && getComputedStyle(th).display !== 'none';
      };
      const before = { col: colShown(), unanswered: splitUnansweredHaulRows() };
      splitOnChange(0, 'haul_type', 'off_site');
      const one = { col: colShown(), checked: boxes(), day: splitHaulAnswer,
                    unit: splitRows[0].equipment, eqh: splitRows[0].equip_hours };
      splitOnChange(1, 'haul_type', 'none');
      const two = { checked: boxes(), day: splitHaulAnswer,
                    unanswered: splitUnansweredHaulRows(),
                    payload: splitRows.map(splitRowPayload),
                    status: document.getElementById('splitTallyStatus').textContent };
      return { before, one, two };
    });
    ok('the Haul column is hidden until a row says it was one',
      perRow.before.col === false);
    ok('  and both labour rows are listed as unanswered',
      JSON.stringify(perRow.before.unanswered) === '[1,2]',
      JSON.stringify(perRow.before.unanswered));
    ok('answering "hauled to & from site" reveals the column', perRow.one.col === true);
    ok('  and ticks that row\'s Haul box for the approver',
      perRow.one.checked[0] === true, JSON.stringify(perRow.one.checked));
    ok('  and puts the truck the driver named on it, hours and all',
      perRow.one.unit === 'Triaxle Dump' && perRow.one.eqh === 6.5,
      `${perRow.one.unit} / ${perRow.one.eqh}`);
    ok('answering "no" on the site-labour row leaves its box unticked',
      perRow.two.checked[1] === false, JSON.stringify(perRow.two.checked));
    ok('  and the day is classified from the rows',
      perRow.two.day === 'off_site', perRow.two.day);
    ok('  with nothing left unanswered',
      JSON.stringify(perRow.two.unanswered) === '[]', JSON.stringify(perRow.two.unanswered));
    ok('the hauled row posts its own answer to the server',
      perRow.two.payload[0].is_haul === true
      && perRow.two.payload[0].haul_type === 'off_site',
      JSON.stringify(perRow.two.payload[0]));
    ok('  and the worked row says outright it was not one, so the job pays him',
      perRow.two.payload[1].is_haul === false
      && !('haul_type' in perRow.two.payload[1]),
      JSON.stringify(perRow.two.payload[1]));
    ok('  and the travel row is never classified either way',
      !('is_haul' in perRow.two.payload[2]) && !('haul_type' in perRow.two.payload[2]),
      JSON.stringify(perRow.two.payload[2]));
    ok('  and the tally reads balanced once every row has answered',
      /balanced/.test(perRow.two.status), perRow.two.status);

    // Unanswered is not saveable — the tally says so before the Save button is
    // reached, because a blank answer used to read as "no" and pay the driver
    // his wage on top of the truck priced on the very same row.
    const gate = await page.evaluate(async () => {
      splitOnChange(1, 'haul_type', '');
      const status = document.getElementById('splitTallyStatus').textContent;
      splitMode = 'approve'; splitRowLoad = 'none';
      let posted = false;
      const realFetch = window.fetch;
      window.fetch = () => { posted = true;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); };
      await splitSave();
      const msg = document.getElementById('splitMsg').textContent;
      window.fetch = realFetch;
      return { status, posted, msg };
    });
    ok('a row that has not answered holds the tally back',
      /Row 2/.test(gate.status) && /unanswered/.test(gate.status), gate.status);
    ok('  and the save refuses it rather than guessing "no"',
      gate.posted === false && /Row 2: answer/.test(gate.msg), gate.msg);

    // A row added after the fact is unanswered, and its tick is still derived
    // from the truck until it answers — so an edit to the equipment has to
    // redraw it. Left stale it said the opposite of how the row would be
    // priced: an unticked box, promising the job pays him, beside a row about
    // to post $0.
    const stale = await page.evaluate(() => {
      const box = () => [...document.querySelectorAll('#splitTbody .haul-col input')][1].checked;
      const start = box();
      splitOnChange(1, 'equipment', 'Triaxle Dump');
      const named = box();
      splitOnChange(1, 'equip_hours', '2.5');
      const priced = box();
      return { start, named, priced, willPost0: splitRowIsHaul(splitRows[1]) };
    });
    ok('an unanswered row\'s tick follows the truck instead of going stale',
      stale.start === false && stale.priced === true, JSON.stringify(stale));
    ok('  and it agrees with how the row would be priced',
      stale.priced === stale.willPost0, JSON.stringify(stale));

    // And the day-level note, which is what tells payroll why a row is $0.
    const note = await page.evaluate(() => {
      const h = document.createElement('div');
      h.innerHTML = splitHaulNoteHtml({ prevailing_wage: true });
      return h.textContent;
    });
    const mixedNote = await page.evaluate(() => {
      splitOnChange(1, 'haul_type', 'on_site');
      const h = document.createElement('div');
      h.innerHTML = splitHaulNoteHtml({ prevailing_wage: true });
      return { text: h.textContent, day: splitHaulAnswer };
    });
    ok('a day holding both answers still classifies as the off-site one',
      mixedNote.day === 'off_site', mixedNote.day);
    ok('  and says so, rather than leaving payroll to reconcile the Haul column',
      /both answers/.test(mixedNote.text), mixedNote.text.slice(0, 120));

    ok('the $0-labour note explains itself', /\$0 labour rate/.test(note), note.slice(0, 80));
    ok('  and says the hours pay at standard on a prevailing job',
      /standard/.test(note) && /prevailing/.test(note));
    await page.close();
  }

  console.log('\n[divisions.html — the Driver toggle is findable]');
  {
    const page = await browser.newPage();
    const errs = await boot(page, 'divisions.html');
    ok('the page boots with no uncaught error', errs.length === 0, errs.slice(0, 2).join(' | '));
    const tab = await page.evaluate(() => {
      const b = document.getElementById('muTabBtnSupervisors');
      const th = [...document.querySelectorAll('.sup-table thead th')].map(t => t.textContent.trim());
      return { label: b ? b.textContent.trim() : null, headers: th };
    });
    ok('the sub-tab is named for what it now holds', tab.label === 'Roles', tab.label);
    ok('  and the table has a Driver column',
      tab.headers.includes('Driver') && tab.headers.includes('Supervisor'), tab.headers.join('/'));
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('harness error:', e.message); process.exit(1); });
