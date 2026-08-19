#!/usr/bin/env node
'use strict';
/**
 * Front-end test for the Documents tab.
 *
 * Run: node scripts/test-documents-frontend.js
 *
 * Two halves:
 *
 *  1. The wiring on every division page that has the tab, read from the
 *     source. The three pages are separate 30k-line files with no shared
 *     module system, so the only thing keeping them in step is that each was
 *     given the same edits — this is what notices when one drifts. It also
 *     re-counts the purchase-order table's colspan against its header, which
 *     is invisible until a filter empties the table.
 *
 *  2. documents.js driven in jsdom against a stubbed fetch. The upload
 *     sequence is the part a static read cannot confirm: bytes must go
 *     straight to object storage and never through /api, because Vercel caps
 *     a serverless request body at 4.5 MB and one phone photo clears it.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

// Every page carrying the Documents tab, and the division it reports as.
// tracker.html hard-codes 'turf'; the others read their DIVISION constant.
const PAGES = [
  { file: 'tracker.html',         division: 'turf',   configuredAs: "'turf'" },
  { file: 'paving.html',          division: 'paving', configuredAs: 'DIVISION' },
  { file: 'kiewit-pinetree.html', division: 'kiewit', configuredAs: 'DIVISION' },
];

let failed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail) console.error('      ' + String(detail).slice(0, 400));
};

// ── 1. Page wiring ────────────────────────────────────────────────────────
for (const page of PAGES) {
  console.log(`\n[${page.file}]`);
  const src = read(page.file);

  assert('documents.js is loaded alongside report-email.js',
    /<script src="documents\.js" defer><\/script>/.test(src));
  assert('the Documents tab button exists',
    /<button class="tab-btn"\s+data-tab="docs">/.test(src));
  assert('the Documents panel exists',
    /<div class="tab-panel" id="tab-docs">/.test(src));
  // tracker dispatches on activeTab directly; the others defer through _t.
  assert('clicking the tab renders it',
    /if \((?:activeTab|_t) === 'docs'\)\s+renderDocsTab\(\);/.test(src));
  assert(`it configures itself as ${page.configuredAs}`,
    src.includes(`division:          ${page.configuredAs},`), page.configuredAs);

  // level1 is view-only but must still reach the tab — the API decides what it
  // may do there, and hiding it outright would be a different product decision.
  const permAt = src.indexOf('visibleTabs:');
  const permBlock = src.slice(permAt, permAt + 320);
  assert('both level1 and level2 can see the tab',
    (permBlock.match(/'docs'/g) || []).length === 2, permBlock);

  // ── The PO table's colspan must match its header ───────────────────────
  const poTab = src.slice(src.indexOf('function renderPOTab()'));
  const colsMatch = poTab.match(/const COLS = (\d+);/);
  assert('renderPOTab declares a column count', Boolean(colsMatch));

  const theadStart = poTab.indexOf('<thead><tr>');
  const thead = poTab.slice(theadStart, poTab.indexOf('</tr></thead>', theadStart));
  // Literal <th> plus the thf()/th() helpers that emit one each. The header is
  // the honest count — the body row wraps its delete cell in a ternary, so two
  // <td> in the source render as one.
  const thCount = (thead.match(/<th /g) || []).length + (thead.match(/\$\{th[f]?\(/g) || []).length;
  assert(`the empty-state colspan matches the ${thCount} columns actually rendered`,
    colsMatch && thCount === Number(colsMatch[1]),
    `COLS=${colsMatch && colsMatch[1]} but counted ${thCount} header cells`);

  assert('the paperclip column is in the header', /title="Attached documents"/.test(thead));
  assert('the paperclip cell calls openPODocs', /onclick="openPODocs\('\$\{po\.id\}'\)"/.test(poTab));
  assert('the badge count comes from the shared module',
    /const docCount= window\.FCTDocuments \? FCTDocuments\.poCount\(po\.id\) : 0;/.test(poTab));
  assert('counts are fetched once, guarded against a render loop',
    /_poDocCountsLoaded = true;[\s\S]{0,200}refreshPoCounts\(\)/.test(poTab));

  // ── Cost-code label resolution, run rather than eyeballed ──────────────
  // The master list is what makes a code read the same way on every job.
  const sandbox = {
    lists: { cost_codes: [{ value: '420', description: 'Paving' }, { value: '415', description: '' }] },
    console,
  };
  sandbox.getProj = () => ({
    bidItems: [
      { cost_code: '420', description: 'Wearing Course' },  // master list should win
      { cost_code: '415', description: 'Subbase' },         // blank master entry → bid item
      { cost_code: '411', description: '' },                // nothing anywhere → bare code
    ],
  });
  vm.createContext(sandbox);
  for (const fn of ['costCodeLabel', 'docsCostCodesFor']) {
    const at = src.indexOf(`function ${fn}(`);
    if (at < 0) { assert(`${fn} exists`, false); continue; }
    let i = src.indexOf('{', at), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    vm.runInContext(src.slice(at, i + 1), sandbox);
  }

  const byCode = Object.fromEntries(sandbox.docsCostCodesFor('p1').map(c => [c.code, c.label]));
  assert('the master list wins over the bid item description',
    byCode['420'] === 'Paving', JSON.stringify(byCode));
  assert('a blank master entry falls back to the bid item description',
    byCode['415'] === 'Subbase', JSON.stringify(byCode));
  assert('a code with no label anywhere yields the bare code',
    byCode['411'] === '', JSON.stringify(byCode));
  assert('the General area asks for no cost codes',
    sandbox.docsCostCodesFor(null).length === 0);

  // Each division keeps its own lists blob, the same way its employees and
  // equipment do — so the cost-code panel has to be wired into that page's own
  // Manage Lists, not inherited from anywhere.
  assert('the Cost Codes panel is in this page\'s Manage Lists',
    src.includes('id="panel-cost_codes"') && src.includes("addListItem('cost_codes')"));
  assert('cost_codes is in this page\'s defaultLists',
    /cost_codes:   \[\],/.test(src));
}

// ── 2. documents.js in jsdom ─────────────────────────────────────────────
console.log('\n[documents.js upload sequence]');

(async () => {
  const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>',
    { url: 'http://localhost/', runScripts: 'dangerously' });
  const { window } = dom;
  window.localStorage.setItem('fct_token', 'test-token');

  const calls = [];
  window.fetch = async (url, init = {}) => {
    // Only the API calls carry JSON; the storage PUT carries the file itself.
    const isJson = typeof init.body === 'string';
    calls.push({
      url: String(url),
      method: init.method || 'GET',
      body: isJson ? JSON.parse(init.body) : null,
      rawBody: isJson ? null : init.body,
    });

    if (String(url).startsWith('https://storage.example')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (String(url).includes('/api/document-upload-url')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          documentId: 'doc-new', storageKey: 'FCT/turf/p1/doc-new/ticket.pdf',
          uploadUrl: 'https://storage.example/put?sig=abc', contentType: 'application/pdf',
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ document: { id: 'doc-new' } }) };
  };

  window.eval(read('documents.js'));
  const FD = window.FCTDocuments;
  assert('documents.js exposes its entry points',
    FD && typeof FD.renderTab === 'function' && typeof FD.openAttach === 'function');

  FD.configure({
    division: 'turf',
    getProjectId: () => 'p1',
    perm: { canUpload: true, canManage: true, canDelete: false },
  });

  const file = new window.File(['x'], 'ticket.pdf', { type: 'application/pdf' });
  await FD._uploadOne(file, { folderId: 'f-420', poId: 'po-1042', note: '22.14 tons', projectId: 'p1' });

  assert('three calls: ticket, storage, register', calls.length === 3,
    calls.map(c => `${c.method} ${c.url}`).join(' | '));

  assert('1 — asks the API for a presigned URL',
    calls[0].url.includes('/api/document-upload-url') && calls[0].method === 'POST',
    calls[0].url);
  assert('2 — PUTs the bytes straight to object storage',
    calls[1].url.startsWith('https://storage.example') && calls[1].method === 'PUT',
    calls[1].url);
  assert('3 — registers the metadata with the API',
    calls[2].url.includes('/api/documents') && calls[2].method === 'POST',
    calls[2].url);

  // The whole reason the flow has three steps.
  const bytesThroughApi = calls.some(c => c.url.includes('/api/') && c.rawBody);
  assert('file bytes never pass through /api', !bytesThroughApi);
  assert('the file itself is the body of the storage PUT', calls[1].rawBody === file);

  const reg = calls[2].body;
  assert('the registration carries the folder', reg.folderId === 'f-420', JSON.stringify(reg));
  assert('and the purchase order, so one action files it in both places',
    reg.poId === 'po-1042', JSON.stringify(reg));
  assert('and echoes back the storage key the API minted',
    reg.storageKey === 'FCT/turf/p1/doc-new/ticket.pdf', JSON.stringify(reg));
  assert('the division travels on every request',
    calls.filter(c => c.url.includes('/api/')).every(c => c.url.includes('division=turf')),
    calls.map(c => c.url).join(' | '));

  // A PO can belong to a different job than the one the Documents tab has
  // selected — and attaching from the PO tab before that tab was ever opened
  // means no selection at all. The upload has to follow the PO's job, not the
  // tab's, or the folder it was filed into belongs to another project.
  calls.length = 0;
  await FD._uploadOne(file, { folderId: 'f-other', poId: 'po-77', projectId: 'p2' });
  assert('the ticket is minted against the job passed in, not the tab selection',
    calls[0].body.projectId === 'p2', JSON.stringify(calls[0].body));
  assert('and the registration files it under that same job',
    calls[2].url.includes('projectId=p2'), calls[2].url);

  const docsSrc = read('documents.js');
  assert('openAttach threads the purchase order\'s own job into the upload',
    /openUpload\(\{ folderId: null, poId: po\.id, lockPo: true, projectId \}\)/.test(docsSrc),
    'openAttach must pass projectId explicitly');

  // The host pages derive perm from fctUser.role, which login.js sets from the
  // caller's TURF role. On paving and kiewit that can understate what the user
  // may do, so seeding must not be gated on it — the server decides.
  assert('folder seeding is not gated on the host page\'s perm',
    !/if \(cfg\.perm\.canUpload\) \{[\s\S]{0,200}\/documents\$\{q\(\{ projectId \}\)\}/.test(docsSrc),
    'the seed must run and let the server 403 if it disagrees');

  // A non-image is passed through untouched — downscaling a PDF would corrupt it.
  const asIs = await FD._maybeDownscale(file);
  assert('a PDF is uploaded byte for byte', asIs.filename === 'ticket.pdf' && asIs.blob === file);

  const small = new window.File([new Uint8Array(1000)], 'small.jpg', { type: 'image/jpeg' });
  const smallOut = await FD._maybeDownscale(small);
  assert('a small photo is not re-encoded', smallOut.blob === small);

  console.log(failed ? `\n${failed} failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\nTest run failed:', err);
  process.exit(1);
});
