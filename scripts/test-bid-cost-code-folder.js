#!/usr/bin/env node
'use strict';
/**
 * The folder shortcut on the bid page's green cost-code bar.
 *
 * Run: node scripts/test-bid-cost-code-folder.js
 *
 * Going down a bid item page, the paperwork that belongs to a cost code — the
 * drawing, the submittal, the delivery ticket — used to be a trip through the
 * Documents tab and back, which on tracker.html means closing the fullscreen
 * bid overlay and losing your place. The green bar now carries a folder chip
 * that opens that cost code's folder in a dialog over the table.
 *
 * Three halves, for the three ways this can quietly break:
 *
 *  1. The wiring on all three pages carrying the bid table. They are separate
 *     30k-line files with no shared module system, so nothing but matching
 *     edits keeps them in step — this is what notices when one drifts.
 *
 *  2. _bidGroupDocsHTML run rather than eyeballed, because the chip is built
 *     by string interpolation into an inline onclick and a cost code like
 *     "Owner's Allowance" is a real cost code.
 *
 *  3. documents.js in jsdom. The property worth protecting is that counting a
 *     job's cost codes must NOT move the Documents browser onto that job — the
 *     bid page routinely asks about a job the tab is not sitting on.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

const PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];

let passed = 0, failed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail) console.error('      ' + String(detail).slice(0, 400));
};

/* Lift one top-level function out of a page by brace-matching its body. Brace
   matching starts after the parameter list, not at the first `{` in the source
   — a default like `opts = {}` in the signature otherwise ends the match
   immediately and returns an empty body that passes every check. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let paren = 0, i = src.indexOf('(', start);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

// ── 1. Page wiring ────────────────────────────────────────────────────────
for (const page of PAGES) {
  console.log(`\n[${page}]`);
  const src = read(page);

  assert('the chip helper exists', src.includes('function _bidGroupDocsHTML(projId, costCode)'));

  const renderer = extractFunction(src, 'renderBidTable');

  // Off the cost code, not off visItems: filtering a group down to two sub
  // codes must not change which folder the chip opens.
  assert('the chip is built from the group\'s cost code',
    /const gDocsHTML\s+= _bidGroupDocsHTML\(projId, costCode\);/.test(renderer), renderer.slice(0, 0));

  // Both branches — a view-only reader has the same reason to reach a drawing.
  const docsUses = (renderer.match(/\$\{gPctHTML\}\$\{gDaysHTML\}\$\{gDocsHTML\}/g) || []).length;
  assert('both the readonly and editable headers draw it', docsUses === 2, `found ${docsUses}`);

  // The whole header row toggles the group on click. A control that does not
  // stop the event collapses the group instead of doing its job.
  const chip = extractFunction(src, '_bidGroupDocsHTML');
  assert('the chip stops the header\'s collapse click',
    /onclick="event\.stopPropagation\(\);openBidGroupDocs\(/.test(chip), chip);
  assert('a group with no cost code gets no chip',
    /if \(!code\) return '';/.test(chip), chip);
  // The cost code never reaches the JS parser: it rides in a data attribute
  // and is read back out of the dataset, the way the PO paperclip does it.
  assert('the cost code rides in a data attribute, not the handler string',
    /data-bid-docs-code="\$\{_cbEsc\(code\)\}"/.test(chip)
    && /openBidGroupDocs\(this\.dataset\.bidDocsProj,this\.dataset\.bidDocsCode\)/.test(chip), chip);
  assert('the count comes from the shared module, guarded',
    /window\.FCTDocuments \? FCTDocuments\.costCodeCount\(projId, code\) : 0/.test(chip), chip);

  const opener = extractFunction(src, 'openBidGroupDocs');
  assert('the chip opens the cost code folder through documents.js',
    /FCTDocuments\.openCostCodeFolder\(\{ projectId: projId, costCode/.test(opener), opener);
  assert('a click before the deferred script lands retries',
    /if \(!window\.FCTDocuments\) \{ setTimeout\(\(\) => openBidGroupDocs\(projId, costCode\), 150\); return; \}/
      .test(opener), opener);

  const loader = extractFunction(src, '_loadBidDocCounts');
  assert('counts are fetched once per job, not once per render',
    /if \(_bidDocCountsFor === projId\) return;/.test(loader), loader);
  assert('waiting for the deferred script is bounded',
    /_bidDocCountTicks\+\+ > 40/.test(loader), loader);
  assert('the repaint is guarded against the user moving on',
    /if \(bidViewProjId !== projId\) return;/.test(loader), loader);
  assert('…and against repainting over someone mid-edit',
    /tbody\.contains\(document\.activeElement\)\) return;/.test(loader), loader);

  assert('opening a bid warms the counts',
    /renderBidTable\(projId\);\n  _loadBidDocCounts\(projId\);/.test(src));
  assert('attaching or deleting a document makes the counts stale',
    /onChange: \(\) => \{[\s\S]{0,160}_bidDocCountsStale\(\);/.test(src));

  // Subtle was the ask: dimmed on a bar that already carries five things, lit
  // only under the cursor — or permanently, once there is paperwork to find.
  assert('the chip is dimmed until the row is hovered',
    /\.bid-grp-docs \{[^}]*opacity: 0\.35;/.test(src) &&
    /\.bid-group-hdr:hover \.bid-grp-docs \{ opacity: 1; \}/.test(src));
  assert('a cost code with paperwork keeps its chip lit',
    /\.bid-grp-docs\.has-docs \{ opacity: 1;/.test(src));
}

// ── 2. The chip itself, run ─────────────────────────────────────
console.log('\n[_bidGroupDocsHTML]');
{
  const src = read('tracker.html');
  const sandbox = { console };
  // In a browser `window.FCTDocuments` and the bare global are the same slot,
  // and the helper reads it both ways — guard on window, then call unqualified.
  // A sandbox where they are two different names would let a helper that only
  // ever worked because of the guard pass this file.
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const fn of ['esc', '_cbEsc', '_bidGroupDocsHTML']) {
    // _cbEsc is an arrow assigned to a const, not a function declaration, so
    // it does not come out through extractFunction.
    const line = fn === '_cbEsc'
      ? src.slice(src.indexOf('const _cbEsc = s =>'), src.indexOf('\n', src.indexOf('const _cbEsc = s =>')))
      : extractFunction(src, fn);
    vm.runInContext(line, sandbox);
  }

  // Parse what the helper emits rather than pattern-matching the string: the
  // whole point of moving the cost code into a data attribute is that the
  // browser hands it back byte-for-byte, and only a real parse proves it.
  const parser = new JSDOM('<!doctype html><body></body>').window;
  const chipFor = (code, counts) => {
    sandbox.FCTDocuments = counts
      ? { costCodeCount: (p, c) => (counts[p] || {})[c] || 0 }
      : undefined;
    const html = sandbox._bidGroupDocsHTML('p1', code);
    const host = parser.document.createElement('div');
    host.innerHTML = html;
    return { html, el: host.firstElementChild };
  };

  assert('no cost code, no chip',
    chipFor('', null).html === '' && chipFor(null, null).html === '');
  assert('a whitespace-only cost code is treated as none', chipFor('   ', null).html === '');

  const cold = chipFor('420', null);
  assert('it still renders before documents.js has loaded', Boolean(cold.el), cold.html);
  assert('and still carries the cost code to open',
    cold.el.dataset.bidDocsCode === '420' && cold.el.dataset.bidDocsProj === 'p1', cold.html);
  assert('with no counts in hand it shows no number',
    cold.el.textContent.trim() === '\u{1F4C1}', JSON.stringify(cold.el.textContent));
  assert('and does not claim to have any', !cold.el.classList.contains('has-docs'), cold.html);

  const empty = chipFor('420', { p1: { 420: 0 } });
  assert('a cost code with no paperwork stays unlit',
    !empty.el.classList.contains('has-docs') && empty.el.textContent.trim() === '\u{1F4C1}', empty.html);
  assert('and offers to open the folder anyway',
    empty.el.title === 'Open the document folder for cost code 420', empty.el.title);

  const full = chipFor('420', { p1: { 420: 7 } });
  assert('a cost code with paperwork lights up', full.el.classList.contains('has-docs'), full.html);
  assert('and prints the count', full.el.textContent.trim() === '\u{1F4C1}7', full.el.textContent);
  assert('and says what the count is',
    full.el.title.startsWith('7 documents filed under cost code 420'), full.el.title);

  const one = chipFor('420', { p1: { 420: 1 } });
  assert('one document is not "1 documents"',
    one.el.title.startsWith('1 document filed'), one.el.title);

  // The count is per job: two jobs both have a 420 and they are not the same
  // pile of paperwork.
  const other = chipFor('420', { p2: { 420: 9 } });
  assert('another job\'s count does not leak onto this one',
    !other.el.classList.contains('has-docs'), other.html);

  // Cost codes are free text and really do carry these characters — "Owner's
  // Allowance & Contingency" is one. Every one of them has to survive the trip
  // through the attribute unchanged, or the chip opens a folder for a cost code
  // that does not exist.
  for (const code of ["Owner's Allowance", 'SAY "HI"', 'A & B', 'A<B>C', 'back\\slash']) {
    const c = chipFor(code, { p1: { [code]: 3 } });
    assert(`the cost code survives the round trip: ${code}`,
      c.el.dataset.bidDocsCode === code, `${c.el.dataset.bidDocsCode} !== ${code}`);
    assert(`\u2026and its title stays one attribute: ${code}`,
      c.el.title.startsWith('3 documents filed under cost code ' + code), c.el.title);
  }

  // Nothing user-typed is interpolated into the handler at all any more — the
  // onclick is a fixed string that reads the dataset back.
  const risky = chipFor("');alert(1);//", { p1: {} });
  assert('a cost code cannot inject into the inline handler',
    risky.el.getAttribute('onclick')
      === 'event.stopPropagation();openBidGroupDocs(this.dataset.bidDocsProj,this.dataset.bidDocsCode)',
    risky.el.getAttribute('onclick'));
  assert('\u2026and is still carried through intact',
    risky.el.dataset.bidDocsCode === "');alert(1);//", risky.el.dataset.bidDocsCode);
}

// ── 3. documents.js in jsdom ──────────────────────────────────────────────
console.log('\n[documents.js cost-code folders]');

// Job A: 420 has one document in the folder itself and one in a subfolder
// under it, so a count that only reads direct children reports the wrong
// number. 415 exists as a folder with nothing in it. 411 is a legacy folder
// that predates the cost_code column and carries only its `cc-411` slug.
const JOB_A = {
  folders: [
    { id: 'f-420', parent_id: null,    name: '420 · Paving',  kind: 'cost_code', slug: 'cc-420', cost_code: '420', sort_order: 9 },
    { id: 'f-420-t', parent_id: 'f-420', name: 'Tickets',     kind: 'user',      slug: null,     cost_code: null,  sort_order: 1 },
    { id: 'f-415', parent_id: null,    name: '415 · Subbase', kind: 'cost_code', slug: 'cc-415', cost_code: '415', sort_order: 10 },
    { id: 'f-411', parent_id: null,    name: '411',           kind: 'cost_code', slug: 'cc-411', cost_code: null,  sort_order: 11 },
    { id: 'f-photos', parent_id: null, name: 'Photos',        kind: 'fixed',     slug: 'photos', cost_code: null,  sort_order: 5 },
  ],
  documents: [
    { id: 'd1', filename: 'plan.pdf',   content_type: 'application/pdf', size_bytes: 10, note: '', uploaded_by: 'ben', uploaded_at: '2026-09-01T10:00:00Z', folder_ids: ['f-420'],   po_ids: [] },
    { id: 'd2', filename: 'ticket.jpg', content_type: 'image/jpeg',      size_bytes: 20, note: '', uploaded_by: 'ben', uploaded_at: '2026-09-02T10:00:00Z', folder_ids: ['f-420-t'], po_ids: [] },
    { id: 'd3', filename: 'legacy.pdf', content_type: 'application/pdf', size_bytes: 30, note: '', uploaded_by: 'ben', uploaded_at: '2026-09-03T10:00:00Z', folder_ids: ['f-411'],   po_ids: [] },
    { id: 'd4', filename: 'site.jpg',   content_type: 'image/jpeg',      size_bytes: 40, note: '', uploaded_by: 'ben', uploaded_at: '2026-09-04T10:00:00Z', folder_ids: ['f-photos'], po_ids: [] },
  ],
  caps: { canUpload: true, canManage: true, canDelete: false },
};

const JOB_B = {
  folders: [
    { id: 'g-530', parent_id: null, name: '530 · Retaining Wall', kind: 'cost_code', slug: 'cc-530', cost_code: '530', sort_order: 9 },
  ],
  documents: [
    { id: 'e1', filename: 'wall.pdf', content_type: 'application/pdf', size_bytes: 50, note: '', uploaded_by: 'ben', uploaded_at: '2026-09-05T10:00:00Z', folder_ids: ['g-530'], po_ids: [] },
  ],
  caps: { canUpload: true, canManage: true, canDelete: false },
};

(async () => {
  const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>',
    { url: 'http://localhost/', runScripts: 'dangerously' });
  const { window } = dom;
  window.localStorage.setItem('fct_token', 'test-token');

  const seen = [];
  window.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.push(`${init.method || 'GET'} ${u}`);
    const body = u.includes('projectId=B') ? JOB_B : JOB_A;
    return { ok: true, status: 200, json: async () => (init.method === 'PUT' ? {} : body) };
  };

  window.eval(read('documents.js'));
  const FD = window.FCTDocuments;

  assert('the cost-code entry points are on the public surface',
    typeof FD.openCostCodeFolder === 'function'
    && typeof FD.refreshCostCodeCounts === 'function'
    && typeof FD.costCodeCount === 'function');

  FD.configure({
    division: 'turf',
    getProjectId: () => 'A',
    getProjectName: () => 'Job A',
    getCostCodes: () => [{ code: '420', label: 'Paving' }],
    getPurchaseOrders: () => [],
    perm: { canUpload: true, canManage: true, canDelete: false },
  });

  const mount = window.document.getElementById('mount');
  await FD.renderTab(mount);
  assert('the tab loaded job A', mount.innerHTML.includes('420 · Paving'), mount.innerHTML.slice(0, 200));

  // Counting off the state already in hand — no extra request.
  const before = seen.length;
  await FD.refreshCostCodeCounts('A');
  assert('counting the job already on screen costs no request', seen.length === before,
    seen.slice(before).join(' | '));

  assert('a cost code counts its subfolders too, not just its own files',
    FD.costCodeCount('A', '420') === 2, String(FD.costCodeCount('A', '420')));
  assert('an empty cost-code folder counts zero',
    FD.costCodeCount('A', '415') === 0, String(FD.costCodeCount('A', '415')));
  assert('a legacy folder with only a cc- slug is still matched',
    FD.costCodeCount('A', '411') === 1, String(FD.costCodeCount('A', '411')));
  assert('a fixed folder is not mistaken for a cost code',
    FD.costCodeCount('A', 'photos') === 0);
  assert('an unknown cost code counts zero rather than throwing',
    FD.costCodeCount('A', '999') === 0);

  // The property this whole design exists for: the bid page asks about a job
  // the Documents tab is not sitting on, and asking must not move the tab.
  await FD.refreshCostCodeCounts('B');
  assert('counting another job fetches it', seen.some(s => s.includes('projectId=B')), seen.join(' | '));
  assert('…and reports its counts', FD.costCodeCount('B', '530') === 1,
    String(FD.costCodeCount('B', '530')));
  assert('…without disturbing the job already counted',
    FD.costCodeCount('A', '420') === 2, String(FD.costCodeCount('A', '420')));
  assert('…and without a PUT that would seed folders on it',
    !seen.some(s => s.startsWith('PUT') && s.includes('projectId=B')), seen.join(' | '));

  // The browser on screen must still be job A. Re-rendering it is the honest
  // check — if load() had been repointed, the rail would redraw as job B.
  mount.innerHTML = '';
  await FD.renderTab(mount);
  assert('the Documents tab is still showing job A',
    mount.innerHTML.includes('420 · Paving') && !mount.innerHTML.includes('530 · Retaining Wall'),
    mount.innerHTML.slice(0, 300));

  // ── The dialog ──────────────────────────────────────────────────────────
  await FD.openCostCodeFolder({ projectId: 'A', costCode: '420', label: 'Paving' });
  const dialog = [...window.document.body.children].pop();
  const html   = dialog.innerHTML;
  assert('the dialog is titled with the folder', html.includes('420 · Paving'), html.slice(0, 300));
  assert('it lists the file in the folder', html.includes('plan.pdf'), html.slice(0, 600));
  assert('and the one a level down in a subfolder', html.includes('ticket.jpg'), html.slice(0, 600));
  assert('naming the subfolder it sits in', html.includes('in Tickets'), html.slice(0, 900));
  assert('it does not list another cost code\'s paperwork', !html.includes('legacy.pdf'));
  assert('nor the job\'s photos', !html.includes('site.jpg'));
  assert('it counts what it is showing', html.includes('2 documents filed under this cost code'),
    html.slice(0, 400));
  assert('an editor is offered an upload straight into the folder',
    html.includes('Upload to this folder'), html.slice(0, 900));

  // The whole saving over the Upload button in the Documents tab is that the
  // folder is already chosen. If it opened on "pick a folder" the user would
  // still have to find the cost code in a list of forty.
  dialog.querySelector('[data-ccnew]').click();
  await new Promise(r => setTimeout(r, 50));
  const upload = [...window.document.body.children].pop();
  assert('…which opens the upload dialog', upload.textContent.includes('Upload documents'),
    upload.textContent.slice(0, 200));
  const picker = upload.querySelector('#fctdoc-folder');
  assert('…already filed to the cost code\'s own folder',
    picker && picker.value === 'f-420', picker && picker.value);
  assert('…and the cost-code dialog got out of the way',
    ![...window.document.body.children].includes(dialog));
  upload.querySelector('[data-cancel]').click();

  // An empty folder says so rather than showing an empty box.
  await FD.openCostCodeFolder({ projectId: 'A', costCode: '415' });
  const emptyDlg = [...window.document.body.children].pop();
  assert('an empty cost-code folder says it is empty',
    emptyDlg.innerHTML.includes('Nothing filed here yet'), emptyDlg.innerHTML.slice(0, 400));
  assert('and reports zero rather than blank',
    emptyDlg.innerHTML.includes('0 documents filed under this cost code'),
    emptyDlg.innerHTML.slice(0, 400));
  emptyDlg.querySelector('[data-cancel]').click();

  // A cost code with no folder must not open an empty dialog pretending to be
  // that cost code's paperwork.
  const bodyBefore = window.document.body.children.length;
  await FD.openCostCodeFolder({ projectId: 'A', costCode: '999' });
  assert('a cost code with no folder opens no dialog',
    window.document.body.children.length === bodyBefore + 1
    && !window.document.body.lastElementChild.querySelector('[data-cancel]'),
    window.document.body.lastElementChild.outerHTML.slice(0, 300));
  assert('it says so instead',
    /No document folder for cost code 999/.test(window.document.body.lastElementChild.textContent),
    window.document.body.lastElementChild.textContent);

  await FD.openCostCodeFolder({ projectId: 'A', costCode: '   ' });
  assert('a blank cost code is refused with a reason',
    /no cost code yet/.test(window.document.body.lastElementChild.textContent),
    window.document.body.lastElementChild.textContent);

  // A view-only user gets the listing and the download, and no upload.
  FD.configure({ perm: { canUpload: false, canManage: false, canDelete: false } });
  window.fetch = async (url, init = {}) => {
    const u = String(url);
    if ((init.method || 'GET') === 'PUT') {
      return { ok: false, status: 403, json: async () => ({ error: 'Read-only' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ ...JOB_A, caps: { canUpload: false, canManage: false, canDelete: false } }),
    };
  };
  await FD.openCostCodeFolder({ projectId: 'B', costCode: '420' });   // force a reload
  const ro = [...window.document.body.children].pop();
  assert('a view-only user still sees the paperwork', ro.innerHTML.includes('plan.pdf'),
    ro.innerHTML.slice(0, 400));
  assert('…and can still download it', Boolean(ro.querySelector('[data-ccdl]')));
  assert('…but is offered no upload', !ro.innerHTML.includes('Upload to this folder'));
  assert('…and a refused folder seed does not stop the dialog opening',
    Boolean(ro.querySelector('[data-cancel]')));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('Harness error:', err);
  process.exit(1);
});
