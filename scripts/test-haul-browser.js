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

    const built = await page.evaluate(() => {
      if (typeof splitHaulPickerHtml !== 'function') return { err: 'splitHaulPickerHtml missing' };
      const host = document.createElement('div');
      host.innerHTML = splitHaulPickerHtml({ haul_type: 'off_site' });
      document.body.appendChild(host);
      const sel = host.querySelector('#splitHaulPick');
      return {
        opts: sel ? [...sel.options].map(o => o.value) : null,
        selected: sel ? sel.value : null,
        answer: typeof splitHaulAnswer !== 'undefined' ? splitHaulAnswer : '(missing)',
      };
    });
    ok('the approve modal renders the hauling picker', !built.err, built.err);
    ok('  with all three answers',
      built.opts && built.opts.length === 3 && built.opts.includes('on_site'),
      JSON.stringify(built.opts));
    ok('  defaulted to what the driver said', built.selected === 'off_site', built.selected);
    ok('  and seeded into splitHaulAnswer, not onto the entry', built.answer === 'off_site', built.answer);

    const note = await page.evaluate(() => {
      const h = document.createElement('div');
      h.innerHTML = splitHaulNoteHtml({ prevailing_wage: true });
      return h.textContent;
    });
    // The per-row Haul tick: the column only exists on a haul day, it follows
    // the truck on the row, and unticking it is what pays a driver who got out
    // and worked the site.
    const perRow = await page.evaluate(() => {
      splitEntry = { id: 1, computed_hours: 9, travel_hours: 0, haul_type: 'off_site' };
      splitHaulAnswer = 'off_site';
      splitProjEquipment = [];
      splitRows = [
        { cost_code: 'Notch Milling', sub_code: 'Milling - Trucking', quantity: 0,
          equipment: 'Triaxle Dump', labor_hours: 6.5, equip_hours: 6.5, is_travel: false, code_source: '' },
        { cost_code: 'Notch Milling', sub_code: 'Scratch/leveling - Labor', quantity: 0,
          equipment: '', labor_hours: 2.5, equip_hours: 0, is_travel: false, code_source: '' },
      ];
      renderSplitRows();
      const boxes = () => [...document.querySelectorAll('#splitTbody .haul-col input')];
      const shown = () => getComputedStyle(document.querySelector('#splitTbody .haul-col')).display !== 'none';
      const before = { onHaulDay: shown(), checked: boxes().map(b => b.checked) };
      // Untick the site-labour row — he was out of the truck.
      splitOnChange(1, 'is_haul', false);
      const after = { checked: boxes().map(b => b.checked), payload: splitRows.map(splitRowPayload) };
      // And the column disappears entirely once the day is not a haul.
      splitHaulAnswer = '';
      renderSplitRows();
      const off = { colShown: shown() };
      return { before, after, off };
    });
    ok('the Haul column is shown on a haul day', perRow.before.onHaulDay);
    ok('  with the driving row ticked and the site-labour row not — no clicks needed',
      JSON.stringify(perRow.before.checked) === '[true,false]', JSON.stringify(perRow.before.checked));
    ok('  and it disappears on a day nobody called a haul', perRow.off.colShown === false);
    ok('unticking a row sends is_haul false, so the server pays him for it',
      perRow.after.payload[1].is_haul === false, JSON.stringify(perRow.after.payload[1]));
    ok('  while the untouched driving row sends no answer at all — the truck decides',
      !('is_haul' in perRow.after.payload[0]), JSON.stringify(perRow.after.payload[0]));

    // The column has to appear the moment the ANSWER changes, not only when the
    // repaint happens to be triggered by something else. It used to be revealed
    // inside a repaint that onSplitHaulChange only ran `if` one of the auto-fill
    // helpers had changed something — so on a day with no truck_unit and no
    // single assigned unit, answering "haul" left the column hidden while the
    // warning told the approver to untick a checkbox that was not on screen.
    const reveal = await page.evaluate(async () => {
      splitEntry = { id: 2, computed_hours: 8, travel_hours: 0, haul_type: null };
      splitHaulAnswer = '';
      splitProjEquipment = ['Triaxle Dump', 'Lowboy'];   // several: nothing to infer
      splitRows = [{ cost_code: 'Earthwork', sub_code: 'Stone', quantity: 0,
                     equipment: '', labor_hours: 8, equip_hours: 0, is_travel: false, code_source: '' }];
      renderSplitRows();
      const shown = () => {
        const th = document.querySelector('.split-table thead .haul-col');
        return !!th && getComputedStyle(th).display !== 'none';
      };
      const before = shown();
      document.getElementById('splitHaulPick').value = 'off_site';
      onSplitHaulChange();
      return { before, after: shown() };
    });
    ok('answering the haul question reveals the column even when nothing else changes',
      reveal.before === false && reveal.after === true, JSON.stringify(reveal));

    // And the tick is derived, so an edit to the truck or its hours has to
    // redraw it. Left stale it said the opposite of how the row would be
    // priced — an unticked box, promising the job pays him, beside a row about
    // to post $0.
    const stale = await page.evaluate(() => {
      const box = () => document.querySelector('#splitTbody .haul-col input').checked;
      splitEntry.truck_unit = 'Triaxle Dump';
      const start = box();
      splitOnChange(0, 'equipment', 'Triaxle Dump');
      const named = box();
      splitOnChange(0, 'equip_hours', '8');
      const priced = box();
      // And the pricing rule the server will actually apply.
      return { start, named, priced, willPost0: splitRowIsHaul(splitRows[0]) };
    });
    ok('the tick follows the truck onto the row instead of going stale',
      stale.start === false && stale.priced === true, JSON.stringify(stale));
    ok('  and it agrees with how the row will be priced',
      stale.priced === stale.willPost0, JSON.stringify(stale));

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
