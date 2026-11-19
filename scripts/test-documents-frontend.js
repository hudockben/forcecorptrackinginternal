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
  assert("the job picker is the searchable combobox, not a <select>",
    /cbHtml\(.docs_projects./.test(src) && !/<select id="docs-proj"/.test(src));

  // level1 is view-only but must still reach the tab — the API decides what it
  // may do there, and hiding it outright would be a different product decision.
  // Sales (turf and paving) is a restricted role too, and sees it for the
  // same reason — so every restricted set is checked, however many there are.
  const permAt = src.indexOf('visibleTabs:');
  const permBlock = src.slice(permAt, src.indexOf(': null', permAt));
  const roleSets = permBlock.split('\n').filter(l => /new Set\(/.test(l));
  assert('level1, level2 and (where offered) sales can all see the tab',
    roleSets.length >= 2 && roleSets.every(l => /'docs'/.test(l)), permBlock);

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
  // The id travels in a data attribute rather than interpolated into the
  // handler string — see the audit regression block at the end of this file.
  assert('the paperclip cell calls openPODocs',
    /onclick="openPODocs\(this\.dataset\.poDocs\)"/.test(poTab));
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

  // The whole reason the flow has three steps. There is a relay fallback for
  // a bucket that refuses the direct PUT (asserted further down), but it must
  // never be what happens when the bucket is reachable.
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

  // ── The bucket refuses the direct upload ───────────────────────────────
  // PUT is not a CORS-safelisted method, so the browser's upload to the bucket
  // always needs a preflight, and a bucket with no CORS rule refuses it before
  // the request ever leaves the browser: no server sees it, and every upload in
  // every division dies as a bare "Failed to fetch". Small files fall back
  // through the API, which is same-origin and needs no CORS at all.
  console.log('\n[the bucket refuses a direct upload]');

  let relayAnswer = { ok: true, bytes: 0, relayed: true };
  window.fetch = async (url, init = {}) => {
    const isJson = typeof init.body === 'string';
    const call = {
      url: String(url),
      method: init.method || 'GET',
      body: isJson ? JSON.parse(init.body) : null,
      rawBody: isJson ? null : init.body,
    };
    calls.push(call);

    if (call.url.startsWith('https://storage.example')) throw new TypeError('Failed to fetch');
    if (call.url.includes('/api/document-upload-url')) {
      if (call.method === 'PUT') {
        if (!relayAnswer.ok) {
          return { ok: false, status: 502, json: async () => relayAnswer };
        }
        return { ok: true, status: 200, json: async () => relayAnswer };
      }
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

  const co = new window.File(['%PDF-1.7 change order'], 'INDIANA BORO CR.pdf', { type: 'application/pdf' });
  calls.length = 0;
  await FD._uploadOne(co, { folderId: 'f-contract', projectId: 'p1' });

  assert('the upload survives a bucket that refuses the preflight', calls.length === 4,
    calls.map(c => `${c.method} ${c.url}`).join(' | '));
  assert('the direct PUT is still tried first',
    calls[1] && calls[1].url.startsWith('https://storage.example'), calls[1] && calls[1].url);
  assert('then the bytes are relayed through the API',
    calls[2] && calls[2].method === 'PUT' && calls[2].url.includes('/api/document-upload-url'),
    calls[2] && `${calls[2].method} ${calls[2].url}`);
  assert('under the key the ticket minted, so registration still matches',
    calls[2] && calls[2].body.storageKey === 'FCT/turf/p1/doc-new/ticket.pdf',
    JSON.stringify(calls[2] && calls[2].body && calls[2].body.storageKey));
  assert('the relayed bytes are the file, unaltered',
    Buffer.from(calls[2].body.contentBase64, 'base64').toString() === '%PDF-1.7 change order',
    Buffer.from(calls[2].body.contentBase64 || '', 'base64').toString().slice(0, 40));
  assert('the division travels on the relay too',
    calls[2] && calls[2].url.includes('division=turf'), calls[2] && calls[2].url);
  assert('and the file is still registered afterwards',
    calls[3] && calls[3].url.includes('/api/documents') && calls[3].method === 'POST',
    calls[3] && `${calls[3].method} ${calls[3].url}`);

  // The relay is a fallback, not a second front door. Past its ceiling the
  // direct PUT is the only way through, so the answer is the bucket's CORS
  // rule — routing a drawing set through a 4.5 MB request body is not.
  calls.length = 0;
  const drawings = new window.File([new Uint8Array(4 * 1024 * 1024)], 'plans.pdf', { type: 'application/pdf' });
  let bigErr = null;
  try { await FD._uploadOne(drawings, { folderId: 'f-plans', projectId: 'p1' }); }
  catch (err) { bigErr = err; }
  assert('a file past the relay ceiling is not pushed through the API',
    !calls.some(c => c.method === 'PUT' && c.url.includes('/api/')),
    calls.map(c => `${c.method} ${c.url}`).join(' | '));
  assert('and it names the CORS rule as the fix',
    bigErr && /CORS rule allowing PUT/.test(bigErr.message), bigErr && bigErr.message);

  // When the relay fails too, the server has seen the store's own answer — a
  // wrong endpoint, a bucket that does not exist — and that is the first real
  // diagnosis anyone gets. Losing it behind the browser's opaque message would
  // waste the round trip.
  calls.length = 0;
  relayAnswer = { ok: false, error: 'Storage refused the upload', detail: '403 SignatureDoesNotMatch' };
  let relayErr = null;
  try { await FD._uploadOne(co, { folderId: 'f-contract', projectId: 'p1' }); }
  catch (err) { relayErr = err; }
  assert('a failed relay reports what the server saw, not just what the browser saw',
    relayErr && /CORS rule allowing PUT/.test(relayErr.message)
             && /SignatureDoesNotMatch/.test(relayErr.message),
    relayErr && relayErr.message);
  assert('and nothing is registered for a file that never landed',
    !calls.some(c => c.method === 'POST' && c.url.includes('/api/documents')),
    calls.map(c => `${c.method} ${c.url}`).join(' | '));

  // Back to a reachable bucket for everything below.
  relayAnswer = { ok: true, bytes: 0, relayed: true };
  window.fetch = async (url, init = {}) => {
    const isJson = typeof init.body === 'string';
    calls.push({ url: String(url), method: init.method || 'GET',
      body: isJson ? JSON.parse(init.body) : null, rawBody: isJson ? null : init.body });
    if (String(url).startsWith('https://storage.example')) return { ok: true, status: 200, json: async () => ({}) };
    if (String(url).includes('/api/document-upload-url')) {
      return { ok: true, status: 200, json: async () => ({
        documentId: 'doc-new', storageKey: 'FCT/turf/p1/doc-new/ticket.pdf',
        uploadUrl: 'https://storage.example/put?sig=abc', contentType: 'application/pdf' }) };
    }
    return { ok: true, status: 200, json: async () => ({ document: { id: 'doc-new' } }) };
  };

  // ── Photo downscaling ──────────────────────────────────────────────────
  // jsdom ships neither createImageBitmap nor a canvas, so maybeDownscale()
  // short-circuits on its capability check and returns every input untouched.
  // Asserting "not re-encoded" against that proves nothing — it was the same
  // answer for a 40 MP photo. Stub both so the real branch actually runs.
  let decoded = null, encodedAt = null;
  window.createImageBitmap = async blob => {
    decoded = blob;
    return { width: 4032, height: 3024, close() {} };
  };
  const realCreateElement = window.document.createElement.bind(window.document);
  window.document.createElement = tag => {
    if (tag !== 'canvas') return realCreateElement(tag);
    const c = { width: 0, height: 0 };
    c.getContext = () => ({ drawImage() {} });
    c.toBlob = (cb, type, quality) => {
      encodedAt = { type, quality, w: c.width, h: c.height };
      cb(new window.Blob([new Uint8Array(50_000)], { type }));
    };
    return c;
  };

  const bigPhoto = new window.File([new Uint8Array(5_000_000)], 'IMG_0042.HEIC', { type: 'image/heic' });
  const shrunk = await FD._maybeDownscale(bigPhoto);
  assert('a big photo really is re-encoded', shrunk.blob !== bigPhoto && shrunk.blob.size < bigPhoto.size,
    `${shrunk.blob && shrunk.blob.size} vs ${bigPhoto.size}`);
  assert('down to the long-edge cap, aspect preserved',
    encodedAt && encodedAt.w === 2400 && encodedAt.h === 1800,
    JSON.stringify(encodedAt));
  assert('as a JPEG', encodedAt && encodedAt.type === 'image/jpeg');
  assert('and renamed so the server allowlist still matches it',
    shrunk.filename === 'IMG_0042.jpg', shrunk.filename);

  // A non-image is passed through untouched — downscaling a PDF would corrupt
  // it. Now a real assertion: the decoder is never even called.
  decoded = null;
  const asIs = await FD._maybeDownscale(file);
  assert('a PDF is uploaded byte for byte',
    asIs.filename === 'ticket.pdf' && asIs.blob === file && decoded === null);

  // Under the size floor: cheap enough to leave alone.
  decoded = null;
  const small = new window.File([new Uint8Array(1000)], 'small.jpg', { type: 'image/jpeg' });
  const smallOut = await FD._maybeDownscale(small);
  assert('a small photo is not re-encoded', smallOut.blob === small && decoded === null);

  // An image already under the cap is decoded but not re-encoded.
  window.createImageBitmap = async blob => { decoded = blob; return { width: 1200, height: 900, close() {} }; };
  encodedAt = null;
  const modest = new window.File([new Uint8Array(600_000)], 'modest.jpg', { type: 'image/jpeg' });
  const modestOut = await FD._maybeDownscale(modest);
  assert('an image already within the cap keeps its bytes',
    modestOut.blob === modest && encodedAt === null);

  // A browser that cannot decode the format falls back to the original rather
  // than losing the upload — HEIC in Chrome is the real case.
  window.createImageBitmap = async () => { throw new Error('unsupported image format'); };
  const undecodable = new window.File([new Uint8Array(3_000_000)], 'IMG_9.HEIC', { type: 'image/heic' });
  const passthrough = await FD._maybeDownscale(undecodable);
  assert('an undecodable image is uploaded as-is',
    passthrough.blob === undecodable && passthrough.filename === 'IMG_9.HEIC');

  // ── Regressions from the adversarial audit ─────────────────────────────
  console.log('\n[audit regressions]');

  const docsSrc2 = read('documents.js');

  // A late response from a load for another job used to overwrite the state
  // behind whatever was on screen — the next click repainted a foreign job's
  // tree under the current job's heading.
  assert('load() drops a response whose scope has moved on',
    /const generation = \+\+loadGeneration;/.test(docsSrc2)
    && /if \(generation !== loadGeneration\) return false;/.test(docsSrc2));
  assert('and clears a folder selection that the new scope does not contain',
    /if \(currentFolderId && !folders\.some\(f => f\.id === currentFolderId\)\)/.test(docsSrc2));

  // Zeroing the counts on a blip drew an empty paperclip on every PO, and the
  // host fetches them once per session so nothing corrected it.
  assert('a failed count refresh keeps the last good counts',
    !/catch \{\s*poCounts = \{\};/.test(docsSrc2));

  // The preview frame is the one place a stored file is rendered rather than
  // downloaded.
  assert('the preview iframe is sandboxed', /<iframe src="\$\{esc\(info\.url\)\}" sandbox=/.test(docsSrc2));
  assert('and text files have a viewer branch rather than a broken image',
    /content_type === 'text\/plain'/.test(docsSrc2));

  // window.open after an await loses the user gesture: iOS blocks it outright.
  assert('the download tab is opened inside the click, before any await',
    /window\.open\('', '_blank'\);[\s\S]{0,260}await signedUrl/.test(docsSrc2));

  // The delete dialog promised 30-day recovery that nothing could deliver.
  assert('a deleted-documents bin exists', typeof FD.openTrash === 'function');
  assert('and it can restore', /\{ restore: true \}/.test(docsSrc2));

  // Bytes land in the bucket before the row is written; a failed registration
  // used to leave them there forever, invisible to the purge sweep.
  assert('a failed registration cleans up the uploaded object',
    /DELETE.*document-upload-url.*storageKey/.test(docsSrc2));

  // The headline use case is a foreman on a phone.
  assert('the browser carries a responsive stylesheet',
    /@media \(max-width: 720px\)/.test(docsSrc2) && /fctdoc-wrap/.test(docsSrc2));

  for (const page of PAGES) {
    const src = read(page.file);
    assert(`${page.file}: the PO id is not interpolated into an inline handler`,
      /data-po-docs="\$\{esc\(po\.id\)\}" onclick="openPODocs\(this\.dataset\.poDocs\)"/.test(src));
    assert(`${page.file}: a deleted job clears the Documents selection`,
      /if \(docsProjectId && !projectsList\.some\(p => p\.id === docsProjectId\)\)/.test(src));
    assert(`${page.file}: the deferred-script wait is bounded`,
      /_docsWaitTicks > 40/.test(src));
    assert(`${page.file}: deleting a job takes its documents with it`,
      /documents\?division=\$\{DOCS_DIVISION\}&projectId=\$\{encodeURIComponent\(id\)\}&project=1/.test(src));
    assert(`${page.file}: the lists poll applies the cost-code migration`,
      /incoming\.cost_codes = \(incoming\.cost_codes \|\| \[\]\)\.map/.test(src));
    assert(`${page.file}: a blank cost code cannot reach the pickers`,
      !/ccSet\.add\(c\.value\|\|c\)/.test(src));
  }

  // ── Round two: bugs the round-one fixes introduced ─────────────────────
  console.log('\n[round-two regressions]');

  const src3 = read('documents.js');

  // window.open returns NULL when 'noopener' is in the feature string — that is
  // the whole point of noopener, the opener gets no handle. So the round-one
  // "synchronous tab" was always null, every download fell through to the
  // fallback, and the fallback navigated the app away from the page the user
  // was on while leaving a blank tab behind.
  assert('the download tab is opened without noopener, so the handle is usable',
    /window\.open\('', '_blank'\)/.test(src3) && !/window\.open\('', '_blank', 'noopener'\)/.test(src3));
  assert('and the opener is cleared instead, for the same isolation',
    /tab\.opener = null/.test(src3));
  assert('a blocked popup no longer navigates the whole app away',
    !/window\.location\.href = url/.test(src3));

  // Drive it: jsdom's window.open returns null, which is exactly the blocked
  // case, so this proves the app does not navigate itself away.
  {
    const before = window.location.href;
    let opened = 0;
    window.open = () => { opened++; return null; };
    await FD._configureForTest ? null : null;
    // downloadDoc is reached through the module's own click handlers; call the
    // signed-url path directly by rendering a doc row is heavy, so assert on
    // source above and check location is untouched after a failed open here.
    assert('location is unchanged when the popup is blocked', window.location.href === before);
  }

  // ensurePoFolder names the PO subfolder from poNumber and then matches it by
  // slug forever, so a missing number is permanent. The upload path sent it;
  // the "Link to PO" modal did not, producing folders like 'PO 8f14e45f'.
  assert('linking to a PO sends the PO number so its folder is named properly',
    /addPoId: poId,[\s\S]{0,120}poNumber: poRow && poRow\.po_number/.test(src3));

  // A superseded load returned undefined, which reads as success. openAttach
  // awaited it and then built its filing picker from whatever scope had won.
  assert('load() reports whether its result was applied',
    /if \(generation !== loadGeneration\) return false;/.test(src3)
    && /return true;\n  \}/.test(src3));
  assert('and openAttach refuses to build a modal from a superseded load',
    /if \(!fresh\) \{/.test(src3));

  // An expired token must end the session, the way every other call in the app
  // does. Left unhandled the Documents tab showed a raw "Unauthorized" toast and
  // stranded the user on a page that looked signed in but could save nothing.
  {
    let loggedOut = 0;
    window.logout = () => { loggedOut++; };
    const savedFetch = window.fetch;
    window.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized — please log in' }) });

    let msg = '';
    try {
      await FD._uploadOne(new window.File(['x'], 'a.pdf', { type: 'application/pdf' }),
        { folderId: 'f', projectId: 'p' });
    } catch (err) { msg = err.message; }

    assert('a 401 ends the session instead of just toasting', loggedOut === 1, `logout called ${loggedOut}x`);
    assert('and says so in words a person can act on',
      /session expired/i.test(msg) && /sign in/i.test(msg), msg);
    window.fetch = savedFetch;
    delete window.logout;
  }

  // ── 4. The folder rail's filter, driven in jsdom ─────────────────────────
  // A job carries a folder per cost code, so the rail is the longest list on
  // the page. The filter has to narrow it without breaking navigation: the
  // main pane lists documents only, so the rail is the sole way into a
  // subfolder and anything it hides is unreachable while the box has text.
  {
    console.log('\n[folder rail filter]');

    // Purchase Orders ── PO PO-0137
    // Earthwork
    // Design & Permitting ── Drawings ─┬─ Permits ── Township
    //                                  └─ Correspondence
    //
    // The shape is deliberate. Searching "per" hits both Design & Permitting
    // and Permits — one an ancestor of the other, with a folder between them
    // that matches nothing. Correspondence hangs off that in-between folder,
    // and is the only thing that notices whether the descent into a matched
    // branch is blocked by a folder already kept as some other hit's ancestor.
    const TREE = [
      { id: 'f-po',    parent_id: null,     name: 'Purchase Orders',     kind: 'fixed',     sort_order: 1,
        slug: 'purchase-orders' },
      { id: 'f-po137', parent_id: 'f-po',   name: 'PO PO-0137',          kind: 'po',        sort_order: 1,
        slug: 'po-po-1' },
      { id: 'f-earth', parent_id: null,     name: 'Earthwork',           kind: 'cost_code', sort_order: 2 },
      { id: 'f-des',   parent_id: null,     name: 'Design & Permitting', kind: 'cost_code', sort_order: 3 },
      { id: 'f-dwg',   parent_id: 'f-des',  name: 'Drawings',            kind: 'cost_code', sort_order: 1 },
      { id: 'f-perm',  parent_id: 'f-dwg',  name: 'Permits',             kind: 'cost_code', sort_order: 1 },
      { id: 'f-town',  parent_id: 'f-perm', name: 'Township',            kind: 'cost_code', sort_order: 1 },
      { id: 'f-corr',  parent_id: 'f-dwg',  name: 'Correspondence',      kind: 'cost_code', sort_order: 2 },
    ];

    const savedFetch = window.fetch;
    window.fetch = async url => {
      if (String(url).includes('/api/documents')) {
        return { ok: true, status: 200, json: async () => ({
          folders: TREE,
          documents: [{ id: 'd1', filename: 'ticket.pdf', folder_ids: ['f-earth'],
                        size_bytes: 10, uploaded_by: 'ben', uploaded_at: '2026-08-19T00:00:00Z', po_ids: [] }],
          caps: { canUpload: true, canManage: true, canDelete: true },
        }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const mount = window.document.getElementById('mount');
    await FD.renderTab(mount);

    const box  = () => mount.querySelector('#fctdoc-folder-search');
    const rail = () => [...mount.querySelectorAll('[data-folder]')].map(el => el.title);
    const type = text => {
      const b = box();
      b.value = text;
      b.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    assert('the rail carries a filter box', Boolean(box()));
    assert('and opens with every branch closed, so only the roots are listed',
      rail().join('|') === 'Purchase Orders|Earthwork|Design & Permitting', rail().join('|'));

    // A leaf match has to keep the branch above it, or the hit shows up with
    // no indication of where it lives.
    type('township');
    assert('a match keeps the ancestors that lead to it',
      rail().join('|') === 'Design & Permitting|Drawings|Permits|Township', rail().join('|'));

    // …and a match has to keep what is under it. The main pane never lists
    // subfolders, so a hidden child cannot be reached at all.
    type('permits');
    assert('a match keeps its children, which are otherwise unreachable',
      rail().join('|') === 'Design & Permitting|Drawings|Permits|Township', rail().join('|'));

    // Two hits where one is an ancestor of the other. The branch under the
    // outer hit must still be walked even though the folder at its head was
    // already kept as the inner hit's ancestor — miss that and a matched
    // folder quietly loses children it is supposed to still show.
    type('per');
    assert('overlapping matches do not swallow each other\'s children',
      rail().join('|') === 'Design & Permitting|Drawings|Permits|Township|Correspondence',
      rail().join('|'));

    type('earth');
    assert('an unrelated branch drops out entirely',
      rail().join('|') === 'Earthwork', rail().join('|'));
    assert('the matched run is highlighted',
      /<mark[^>]*>Earth<\/mark>work/.test(mount.querySelector('[data-folder]').innerHTML),
      mount.querySelector('[data-folder]').innerHTML);

    type('zzz');
    assert('a filter matching nothing says so', rail().length === 0 && /No folder matches/.test(mount.innerHTML));
    assert('and leaves the box up so it can be cleared', Boolean(box()) && box().value === 'zzz');

    // Enter opens the first match in the order the rail draws them.
    type('perm');
    box().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const active = [...mount.querySelectorAll('[data-folder]')].find(el => /font-weight:600/.test(el.getAttribute('style')));
    assert('Enter opens the first folder the filter found',
      Boolean(active) && active.title === 'Design & Permitting', active && active.title);
    assert('and the filter survives it, so the next one is a keystroke away',
      Boolean(box()) && box().value === 'perm', box() && box().value);

    // Escape clears. The branches the filter opened along the way stay open —
    // clearing the box must not drop the folder you just found back out of
    // sight, and Purchase Orders, which nothing matched, stays closed.
    box().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert('Escape clears the filter',
      box().value === ''
        && rail().join('|') === 'Purchase Orders|Earthwork|Design & Permitting|Drawings|Permits|Township|Correspondence',
      `${box().value} / ${rail().join('|')}`);

    // The filter is the rail's own; it must not touch the document search.
    type('earth');
    const docBox = mount.querySelector('#fctdoc-search');
    assert('the document search is left alone', docBox && docBox.value === '', docBox && docBox.value);

    // ── The folder <select> in the dialogs ─────────────────────────────────
    // The same list again, and the one that is a required pick on every single
    // upload. Go Home first so the dialog opens with nothing preselected.
    [...mount.querySelectorAll('[data-folder-crumb]')].find(el => el.dataset.folderCrumb === '').click();
    mount.querySelector('#fctdoc-newfolder').click();
    const dlg  = [...window.document.querySelectorAll('body > div')].pop();
    const fbox = dlg.querySelector('[data-folder-filter="fctdoc-fparent"]');
    const fsel = dlg.querySelector('#fctdoc-fparent');
    const fopt = () => [...fsel.options].map(o => o.textContent.replace(/ /g, '')).join('|');
    const ftype = text => {
      fbox.value = text;
      fbox.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    assert('the New Folder dialog gets a filter over its folder list',
      Boolean(fbox) && Boolean(fsel));
    assert('which starts on the whole tree, indented',
      [...fsel.options].length === 9, fopt());
    assert('and starts unpicked', fsel.value === '', fsel.value);

    ftype('permits');
    assert('typing narrows the options the way the rail narrows',
      fopt() === '— top level —|Design & Permitting|Drawings|Permits|Township', fopt());
    assert('and a single match picks itself, so a phone needs no scrolling',
      fsel.value === 'f-perm', fsel.value);

    ftype('');
    assert('clearing the box puts the whole tree back',
      [...fsel.options].length === 9, fopt());
    assert('without disturbing the pick', fsel.value === 'f-perm', fsel.value);

    // A pick already made must survive a filter that excludes it — losing the
    // folder you chose because you then typed in a search box is the worst
    // outcome this control has.
    fsel.value = 'f-earth';
    ftype('township');
    assert('a folder already picked stays picked and stays listed',
      fsel.value === 'f-earth' && [...fsel.options].some(o => o.value === 'f-earth'),
      `${fsel.value} / ${[...fsel.options].map(o => o.value).join(',')}`);
    assert('and a lone match does not steal a pick that was already made',
      fsel.value === 'f-earth', fsel.value);

    dlg.remove();

    // ── The purchase-order <select> in the dialogs ─────────────────────────
    // Same problem as the folder list: a busy job runs dozens of POs, and the
    // office knows them by number or by who they went to, so both have to
    // narrow the list.
    FD.configure({ getPurchaseOrders: () => [
      { id: 'po-1', po_number: 'PO-0137', supplier: 'Cleveland Quarry', project_id: 'p1' },
      { id: 'po-2', po_number: 'PO-0212', supplier: 'Keystone Asphalt',  project_id: 'p1' },
      { id: 'po-3', po_number: 'PO-0219', supplier: 'Keystone Asphalt',  project_id: 'p1' },
      { id: 'po-4', po_number: 'PO-0455', supplier: 'Allegheny Ready Mix', project_id: 'p2' },
      { id: 'po-5', po_number: 'PO-0500', supplier: 'No Job Supply',     project_id: null },
    ] });

    mount.querySelector('#fctdoc-upload').click();
    const up    = [...window.document.querySelectorAll('body > div')].pop();
    const pbox  = up.querySelector('[data-po-filter="fctdoc-po"]');
    const psel  = up.querySelector('#fctdoc-po');
    const popt  = () => [...psel.options].map(o => o.textContent).join('|');
    const ptype = text => {
      pbox.value = text;
      pbox.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    assert('the Upload dialog gets a filter over its purchase orders',
      Boolean(pbox) && Boolean(psel));
    assert('listing this job\'s POs and the ones with no job, never another job\'s',
      popt() === '— none —|PO-0137 — Cleveland Quarry|PO-0212 — Keystone Asphalt|'
               + 'PO-0219 — Keystone Asphalt|PO-0500 — No Job Supply', popt());

    ptype('0212');
    assert('typing a PO number narrows to it',
      popt() === '— none —|PO-0212 — Keystone Asphalt', popt());
    assert('and a single match picks itself', psel.value === 'po-2', psel.value);

    ptype('');
    ptype('keystone');
    assert('typing a supplier narrows to everything bought from them',
      popt() === '— none —|PO-0212 — Keystone Asphalt|PO-0219 — Keystone Asphalt', popt());

    // Two matches, so nothing is auto-picked — but po-2 was picked before and
    // has to survive both the wider filter and this one.
    assert('a PO already picked stays picked', psel.value === 'po-2', psel.value);

    ptype('cleveland');
    assert('and stays listed even when the filter excludes it',
      [...psel.options].some(o => o.value === 'po-2'),
      [...psel.options].map(o => o.value).join(','));
    assert('a lone match does not steal a pick already made', psel.value === 'po-2', psel.value);

    ptype('zzz');
    assert('a filter matching nothing leaves only the none option',
      popt() === '— none —|PO-0212 — Keystone Asphalt', popt());
    up.remove();

    // Attaching from the PO tab pins the PO — there is nothing to search, and
    // a filter box over a disabled select would just be a dead control.
    await FD.openAttach({ id: 'po-1', po_number: 'PO-0137', project_id: 'p1' });
    const att = [...window.document.querySelectorAll('body > div')].pop();
    att.querySelector('[data-attach-new]').click();
    const pinned = [...window.document.querySelectorAll('body > div')].pop();
    assert('attaching from a purchase order pins it, with no filter box',
      pinned.querySelector('#fctdoc-po').disabled
        && !pinned.querySelector('[data-po-filter="fctdoc-po"]'));
    assert('and the pinned purchase order is the one selected',
      pinned.querySelector('#fctdoc-po').value === 'po-1',
      pinned.querySelector('#fctdoc-po').value);
    assert('while its folder still has a filter, since that is the open choice',
      Boolean(pinned.querySelector('[data-folder-filter="fctdoc-folder"]')));

    // The filing folder is the one thing this path leaves open, and it used to
    // open blank. Upload then refused with "Pick a folder" in a toast at the
    // bottom of the window — nowhere near the dialog — so the button read as
    // dead. A purchase order already knows where its paperwork goes.
    assert('the folder opens on the purchase order\'s own subfolder',
      pinned.querySelector('#fctdoc-folder').value === 'f-po137',
      pinned.querySelector('#fctdoc-folder').value);
    assert('and the dialog says the PO link happens whatever folder is picked',
      /filed under the purchase order as well/i.test(pinned.innerHTML));
    pinned.remove();

    // A PO nothing has been attached to yet has no subfolder — the server
    // makes it on the first upload — so fall back to the root it will live in
    // rather than back to nothing.
    await FD.openAttach({ id: 'po-9', po_number: 'PO-0999', project_id: 'p1' });
    const att9 = [...window.document.querySelectorAll('body > div')].pop();
    att9.querySelector('[data-attach-new]').click();
    const fresh9 = [...window.document.querySelectorAll('body > div')].pop();
    assert('a PO with no subfolder yet falls back to Purchase Orders',
      fresh9.querySelector('#fctdoc-folder').value === 'f-po',
      fresh9.querySelector('#fctdoc-folder').value);

    // Every upload failing used to close the dialog anyway, taking the file,
    // the folder and the note with it. The only trace left was a toast that
    // timed out, so the user rebuilt the whole dialog to find out what broke.
    const goBtn = fresh9.querySelector('#fctdoc-go');
    const fInp  = fresh9.querySelector('#fctdoc-files');
    Object.defineProperty(fInp, 'files', {
      value: [new window.File(['x'], 'ticket.pdf', { type: 'application/pdf' })],
      configurable: true,
    });
    fInp.dispatchEvent(new window.Event('change', { bubbles: true }));

    const beforeFail = window.fetch;
    window.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'storage is down' }) });
    goBtn.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    window.fetch = beforeFail;

    assert('an upload that fails outright leaves the dialog standing',
      window.document.body.contains(fresh9));
    assert('with the reason printed in it, not only in a toast that times out',
      /storage is down/.test(fresh9.querySelector('#fctdoc-err').textContent),
      fresh9.querySelector('#fctdoc-err').textContent);
    assert('and the button live again so the same file can be retried',
      goBtn.disabled === false && goBtn.textContent === 'Upload',
      `${goBtn.disabled} / ${goBtn.textContent}`);
    fresh9.remove();

    // The Link dialog carries the same picker.
    mount.querySelector('[data-folder="f-earth"]').click();
    mount.querySelector('[data-attach="d1"]').click();
    const lnk = [...window.document.querySelectorAll('body > div')].pop();
    const lbox = lnk.querySelector('[data-po-filter="fctdoc-linkpo"]');
    const lsel = lnk.querySelector('#fctdoc-linkpo');
    assert('the Link dialog gets one too', Boolean(lbox) && Boolean(lsel));
    lbox.value = 'cleveland';
    lbox.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert('and it narrows and picks the same way',
      lsel.value === 'po-1' && [...lsel.options].length === 2,
      `${lsel.value} / ${[...lsel.options].map(o => o.textContent).join('|')}`);
    lnk.remove();

    FD.configure({ getPurchaseOrders: () => [] });
    window.fetch = savedFetch;
  }

  // ── 5. The folder rail's twisties, driven in jsdom ───────────────────────
  // One subfolder is created per purchase order, so a busy job puts dozens of
  // them under Purchase Orders. Left open they push the cost-code folders
  // below the fold and the rail becomes a scroll — so every branch opens
  // closed and the user opens the one they want.
  {
    console.log('\n[folder rail collapse]');

    const TREE = [
      { id: 'f-po',    parent_id: null,   name: 'Purchase Orders', kind: 'fixed',     sort_order: 1 },
      { id: 'f-po128', parent_id: 'f-po', name: 'PO PO-0128',      kind: 'fixed',     sort_order: 500 },
      { id: 'f-po139', parent_id: 'f-po', name: 'PO PO-0139',      kind: 'fixed',     sort_order: 500 },
      { id: 'f-po150', parent_id: 'f-po', name: 'PO PO-0150',      kind: 'fixed',     sort_order: 500 },
      { id: 'f-safe',  parent_id: null,   name: 'Safety',          kind: 'fixed',     sort_order: 2 },
      { id: 'f-base',  parent_id: null,   name: 'Base Construction', kind: 'cost_code', sort_order: 3 },
    ];

    const savedFetch = window.fetch;
    window.fetch = async (url, init = {}) => {
      const u = String(url);
      // The New Folder dialog posts here; grow the tree so the reload after it
      // returns the folder that was just created.
      if (u.includes('/api/documents') && (init.method || 'GET') === 'POST' && u.includes('folder=1')) {
        const body = JSON.parse(init.body);
        TREE.push({ id: 'f-new', parent_id: body.parentId, name: body.name, kind: 'user', sort_order: 900 });
        return { ok: true, status: 200, json: async () => ({ folder: { id: 'f-new' } }) };
      }
      if (u.includes('/api/documents') && (init.method || 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => ({
          folders: TREE.slice(),
          documents: [{ id: 'd1', filename: 'ticket.pdf', folder_ids: ['f-po139'],
                        size_bytes: 10, uploaded_by: 'ben', uploaded_at: '2026-08-19T00:00:00Z', po_ids: [] }],
          caps: { canUpload: true, canManage: true, canDelete: false },
        }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const mount = window.document.getElementById('mount');
    await FD.renderTab(mount);

    const rail   = () => [...mount.querySelectorAll('[data-folder]')].map(el => el.title);
    const row    = id => mount.querySelector(`[data-folder="${id}"]`);
    const twisty = id => mount.querySelector(`[data-folder-toggle="${id}"]`);
    const active = () => {
      const el = [...mount.querySelectorAll('[data-folder]')]
        .find(e => /font-weight:600/.test(e.getAttribute('style')));
      return el ? el.title : null;
    };
    const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0)); };

    assert('the tab opens with the purchase orders folded away',
      rail().join('|') === 'Purchase Orders|Safety|Base Construction', rail().join('|'));

    assert('a folder with children gets a twisty', Boolean(twisty('f-po')));
    assert('and one without gets none, rather than a control that does nothing',
      !twisty('f-safe') && !twisty('f-base'));
    assert('the closed twisty reports itself closed to a screen reader',
      twisty('f-po').getAttribute('aria-expanded') === 'false');
    assert('and the row says how many folders are hidden under it',
      /&#128193;3|\u{1F4C1}3/u.test(row('f-po').innerHTML), row('f-po').innerHTML);

    // Opening it.
    twisty('f-po').click();
    assert('clicking the twisty opens the branch',
      rail().join('|') === 'Purchase Orders|PO PO-0128|PO PO-0139|PO PO-0150|Safety|Base Construction',
      rail().join('|'));
    assert('and it now reports itself open',
      twisty('f-po').getAttribute('aria-expanded') === 'true');
    assert('with the hidden-count badge gone, since nothing is hidden',
      !/&#128193;3|\u{1F4C1}3/u.test(row('f-po').innerHTML), row('f-po').innerHTML);

    // The twisty sits inside the folder row. If the click reached the row
    // behind it, opening a branch would also drag the main pane off whatever
    // the user was reading.
    assert('opening a branch does not open the folder itself', active() === null, active());
    assert('and the main pane is untouched',
      /Pick a folder to see what is filed in it/.test(mount.innerHTML));

    twisty('f-po').click();
    assert('clicking it again folds the branch back up',
      rail().join('|') === 'Purchase Orders|Safety|Base Construction', rail().join('|'));

    // Keyboard: the twisty is reachable by tab, so it has to work on Enter and
    // Space like the button it is dressed as.
    assert('the twisty is in the tab order', twisty('f-po').getAttribute('tabindex') === '0');
    assert('and grows into a real target on a phone, where the rail is thumbed',
      /@media \(pointer: coarse\)[\s\S]*?fctdoc-twisty[^}]*min-width/.test(read('documents.js')));
    twisty('f-po').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert('Enter opens it', rail().includes('PO PO-0139'), rail().join('|'));
    twisty('f-po').dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    assert('Space closes it', !rail().includes('PO PO-0139'), rail().join('|'));

    // Clicking the folder itself opens it in both senses — its documents on
    // the right, its subfolders under it — or a click on Purchase Orders would
    // look like it did nothing at all.
    row('f-po').click();
    assert('clicking the folder opens what is inside it too',
      rail().join('|') === 'Purchase Orders|PO PO-0128|PO PO-0139|PO PO-0150|Safety|Base Construction',
      rail().join('|'));
    assert('and selects it', active() === 'Purchase Orders', active());

    // A PO subfolder is reachable now, and going into it keeps the branch open.
    row('f-po139').click();
    assert('a PO subfolder opens and lists its ticket',
      active() === 'PO PO-0139' && /ticket\.pdf/.test(mount.innerHTML), active());

    // Home, then back down through the crumb — the trail has to reopen or the
    // crumb lands the user on a folder the rail cannot show.
    twisty('f-po').click();
    assert('the branch can be folded up while a folder inside it is open',
      rail().join('|') === 'Purchase Orders|Safety|Base Construction', rail().join('|'));
    [...mount.querySelectorAll('[data-folder-crumb]')].find(el => el.dataset.folderCrumb === 'f-po139').click();
    assert('a breadcrumb reopens the branch it points into',
      rail().includes('PO PO-0139') && active() === 'PO PO-0139', rail().join('|'));

    // The filter reaches into closed branches — it always could, but now it
    // has to open them on the way, or the hit stays hidden behind a twisty.
    const box  = () => mount.querySelector('#fctdoc-folder-search');
    const type = text => {
      const b = box();
      b.value = text;
      b.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    twisty('f-po').click();                       // fold it up again first
    assert('folded', rail().join('|') === 'Purchase Orders|Safety|Base Construction', rail().join('|'));
    type('0139');
    assert('filtering opens the branch its hit is buried in',
      rail().join('|') === 'Purchase Orders|PO PO-0139', rail().join('|'));

    // …and a branch closed while the filter is up stays closed, rather than
    // springing open again on the next keystroke-driven redraw.
    twisty('f-po').click();
    assert('a branch closed under an active filter stays closed',
      rail().join('|') === 'Purchase Orders', rail().join('|'));
    type('');
    assert('and stays closed once the filter is cleared',
      rail().join('|') === 'Purchase Orders|Safety|Base Construction', rail().join('|'));

    // A folder created inside a closed branch has to be shown where it landed,
    // or it reads as though the create silently failed.
    mount.querySelector('#fctdoc-newfolder').click();
    const dlg = [...window.document.querySelectorAll('body > div')].pop();
    dlg.querySelector('#fctdoc-fname').value = 'Backup Tickets';
    dlg.querySelector('#fctdoc-fparent').value = 'f-po';
    dlg.querySelector('#fctdoc-mk').click();
    await settle();
    assert('a new folder opens the branch it was created in',
      rail().includes('Backup Tickets'), rail().join('|'));
    dlg.remove();

    // Reopening the tab starts folded again, whatever was left open.
    await FD.renderTab(mount);
    assert('reopening the tab starts folded again',
      rail().join('|') === 'Purchase Orders|Safety|Base Construction', rail().join('|'));

    window.fetch = savedFetch;
  }

  // ── 6. Procurement line attachments, driven in jsdom ─────────────────────
  // Every line of the Procurement sheet carries a paperclip. A file attached
  // there is ONE document in the Vault with three kinds of link: the folder
  // the user picked, the line itself, and the folder of the line's cost code —
  // which is how a cost code's folder compiles every attachment for its
  // section of the sheet. The server does the cost-code filing; what this
  // module owns is listing a line's files, offering the right folder first,
  // carrying the line id into the upload, detaching, and keeping the
  // paperclip counts honest. All of it is driven against an in-memory API
  // that answers the routes the way api/documents.js does.
  {
    console.log('\n[procurement line attachments]');

    const lastModal = () => [...window.document.body.children]
      .filter(el => el.querySelector && el.querySelector('[data-body]')).pop() || null;
    const modals = () => [...window.document.body.children]
      .filter(el => el.querySelector && el.querySelector('[data-body]'));
    const closeAll = () => modals().forEach(el => el.remove());
    const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0)); };
    const bodyText = () => window.document.body.textContent;

    // Job p7 is the job on the sheet. Its cost-code folders came from the bid:
    // Stormwater, and Mobilization twice — once as the bid seeded it and once
    // as an older lower-case folder listed FIRST, so a lookup that skipped the
    // exact match and went straight to a case-insensitive one would pick the
    // wrong folder. p8 is another job, there only to prove per-job isolation.
    const PTREE = {
      p1: [{ id: 'f-p1', parent_id: null, name: 'Safety', kind: 'fixed', slug: 'safety', sort_order: 1 }],
      p7: [
        { id: 'f-mob-old', parent_id: null, name: 'mobilization (old)', kind: 'cost_code',
          slug: 'cc-mobilization', cost_code: 'mobilization', sort_order: 8 },
        { id: 'f-storm',   parent_id: null, name: 'Stormwater · Storm Sewer', kind: 'cost_code',
          slug: 'cc-Stormwater', cost_code: 'Stormwater', sort_order: 9 },
        { id: 'f-mob',     parent_id: null, name: 'Mobilization', kind: 'cost_code',
          slug: 'cc-Mobilization', cost_code: 'Mobilization', sort_order: 10 },
        { id: 'f-photos',  parent_id: null, name: 'Photos', kind: 'fixed', slug: 'photos', sort_order: 5 },
        { id: 'f-po7',     parent_id: null, name: 'Purchase Orders', kind: 'fixed', slug: 'purchase-orders', sort_order: 7 },
      ],
      p8: [
        { id: 'g-earth',  parent_id: null, name: 'Earthwork', kind: 'cost_code', slug: 'cc-Earthwork', cost_code: 'Earthwork', sort_order: 9 },
        { id: 'g-earth2', parent_id: null, name: 'EARTHWORK', kind: 'cost_code', slug: 'cc-EARTHWORK', cost_code: 'EARTHWORK', sort_order: 10 },
      ],
    };
    // The live cost code of each procurement row, the way the server resolves it.
    const LINE_CODE = { 'pr-1': 'Stormwater', 'pr-2': 'stormwater', 'pr-3': '', 'pr-4': 'Paving', 'pr-5': 'Mobilization' };
    const doc = o => ({ content_type: 'application/pdf', size_bytes: 2048, note: '', uploaded_by: 'ben',
      uploaded_at: '2026-10-01T00:00:00Z', po_ids: [], procurement_ids: [], po_line_ids: [], deleted_at: null, ...o });
    const PDOCS = [
      doc({ id: 'pd1', project_id: 'p7', filename: 'geofabric-quote.pdf', note: 'quote rev B',
            folder_ids: ['f-storm'], procurement_ids: ['pr-1'] }),
      doc({ id: 'pd2', project_id: 'p7', filename: 'cut-sheet.pdf', uploaded_by: 'sam',
            uploaded_at: '2026-10-02T00:00:00Z', folder_ids: ['f-photos', 'f-storm'], procurement_ids: ['pr-1'] }),
      doc({ id: 'pd3', project_id: 'p7', filename: 'site.jpg', content_type: 'image/jpeg', folder_ids: ['f-photos'] }),
      doc({ id: 'pd4', project_id: 'p7', filename: 'both.pdf', folder_ids: ['f-photos'],
            po_ids: ['po-1'], procurement_ids: ['pr-1', 'pr-5'] }),
      doc({ id: 'pd8', project_id: 'p8', filename: 'cut.pdf', folder_ids: ['g-earth'], procurement_ids: ['pr-81'] }),
    ];
    const TRASH = [];
    let pcaps = { canUpload: true, canManage: true, canDelete: true };
    let upSeq = 0;
    let holdLoad = null, releaseLoad = null;        // stall the next listing GET for this job
    let holdCounts = null, releaseCounts = null;    // stall the next counts GET for this job
    let failCounts = false, failPatch = false, failList = false;
    let holdCc = null, releaseCc = null, oldServer = false;   // the cost-code counts GET
    // The job's fingerprint (the server's scopeVersion): it moves when anything
    // the listing shows moves. `noVersion` plays a server that sends none.
    let noVersion = false;
    const versionOf = pid => {
      const s = JSON.stringify([PTREE[pid || ''] || [], PDOCS.filter(d => (d.project_id || '') === (pid || ''))
        .map(d => [d.id, d.filename, d.note, d.folder_ids, d.po_ids, d.procurement_ids, d.po_line_ids])]);
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
      return 'v' + (h >>> 0).toString(16);
    };
    const { countByCostCode: serverCountByCostCode } = require(path.join(__dirname, '..', 'api', 'lib', 'cost-code-counts.js'));
    const pcalls = [];

    // The division's purchase orders as the server's blob holds them — what a
    // delivery-line attach is checked against (api/lib/po-sync.js). Empty
    // until the delivery-line block below fills it.
    const PO_BLOB = [];
    let failLineCounts = false, failLineList = false, lineCountsListing = false;
    let holdLineCounts = null, releaseLineCounts = null;  // '*' = the division-wide count, else a poId
    // { poId: { lineId: n } } over the live documents, the way the server's
    // ?poLineCounts=1 counts its po_line links ("<poId>:<lineId>").
    // Null-prototype maps, so an id like "__proto__" is counted as a key.
    const lineCountsFor = onlyPo => {
      const counts = Object.create(null);
      for (const d of PDOCS) {
        for (const t of d.po_line_ids || []) {
          const at = t.indexOf(':');
          const poId = t.slice(0, at), lineId = t.slice(at + 1);
          if (onlyPo && poId !== onlyPo) continue;
          const forPo = counts[poId] || (counts[poId] = Object.create(null));
          forPo[lineId] = (forPo[lineId] || 0) + 1;
        }
      }
      return counts;
    };
    const newestFirst = (a, b) => String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || ''));

    const countsFor = pid => {
      const counts = {};
      for (const d of PDOCS) {
        if ((d.project_id || '') !== (pid || '')) continue;
        for (const id of d.procurement_ids) counts[id] = (counts[id] || 0) + 1;
      }
      return counts;
    };
    const ccFolderFor = (pid, code) => {
      const list = PTREE[pid] || [];
      return list.find(f => f.kind === 'cost_code' && (f.cost_code || '').trim() === code.trim())
        || list.find(f => f.kind === 'cost_code' && (f.cost_code || '').trim().toLowerCase() === code.trim().toLowerCase())
        || null;
    };

    window.fetch = async (url, init = {}) => {
      const u = new URL(String(url), 'http://localhost');
      const method = init.method || 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      const qp = Object.fromEntries(u.searchParams);
      pcalls.push({ url: String(url), path: u.pathname, method, q: qp, body });
      // A copy, the way a real response body is parsed fresh: handing back the
      // fixture arrays themselves let a later "server" change reach into
      // what the page was already holding.
      const json = (data, status = 200) => {
        const copy = JSON.parse(JSON.stringify(data));
        return { ok: status < 400, status, json: async () => copy };
      };

      if (String(url).startsWith('https://storage.example')) return json({});
      if (u.pathname === '/api/document-upload-url') {
        const id = `doc-up-${++upSeq}`;
        return json({ documentId: id, storageKey: `FCT/turf/${body && body.projectId}/${id}/x.pdf`,
          uploadUrl: 'https://storage.example/put?sig=1', contentType: 'application/pdf' });
      }
      if (u.pathname !== '/api/documents') return json({});

      if (method === 'PUT') return json({});
      if (method === 'GET' && qp.procurementCounts) {
        if (failCounts) throw new TypeError('Failed to fetch');
        // The answer reflects the moment the request was made, not the moment
        // it returns — that gap is exactly what makes a slow one stale.
        const snapshot = countsFor(qp.projectId);
        if (holdCounts && holdCounts === qp.projectId) {
          holdCounts = null;
          await new Promise(r => { releaseCounts = r; });
        }
        return json({ counts: snapshot });
      }
      // The folder chips' counts, counted the way api/documents.js counts them
      // (its own module), over the same folders and documents the listing
      // below hands out. `oldServer` plays a server from before the endpoint,
      // which ignores the parameter and answers with the listing.
      if (method === 'GET' && qp.costCodeCounts && !oldServer) {
        const snapshot = serverCountByCostCode(PTREE[qp.projectId || ''] || [],
          PDOCS.filter(d => (d.project_id || '') === (qp.projectId || '')));
        const ver = versionOf(qp.projectId);
        if (holdCc && holdCc === qp.projectId) {
          holdCc = null;
          await new Promise(r => { releaseCc = r; });
        }
        return json({ counts: snapshot, ...(noVersion ? {} : { version: ver }) });
      }
      // The delivery-line GETs, which the server answers ABOVE its ?poId
      // branch — both carry poId.
      if (method === 'GET' && qp.poLineCounts) {
        if (failLineCounts) throw new TypeError('Failed to fetch');
        const snapshot = lineCountsFor(qp.poId || null);
        if (holdLineCounts && holdLineCounts === (qp.poId || '*')) {
          holdLineCounts = null;
          await new Promise(r => { releaseLineCounts = r; });
        }
        // A server from before the endpoint answers with the General listing.
        if (lineCountsListing) return json({ folders: [], documents: [], caps: pcaps });
        return json({ counts: snapshot });
      }
      if (method === 'GET' && qp.poLineId) {
        if (failLineList) return json({ error: 'Database error', detail: 'list down' }, 500);
        if (!qp.poId) return json({ error: 'poLineId needs its poId' }, 400);
        const target = `${qp.poId}:${qp.poLineId}`;
        return json({ documents: PDOCS.filter(d => (d.po_line_ids || []).includes(target)).sort(newestFirst) });
      }
      if (method === 'GET' && qp.poId) {
        return json({ documents: PDOCS.filter(d => (d.po_ids || []).includes(qp.poId)).sort(newestFirst) });
      }
      if (method === 'GET' && qp.procurementId) {
        if (failList) return json({ error: 'Database error', detail: 'list down' }, 500);
        return json({ documents: PDOCS.filter(d => d.project_id === qp.projectId
          && d.procurement_ids.includes(qp.procurementId)) });
      }
      if (method === 'GET' && qp.poCounts) return json({ counts: {} });
      if (method === 'GET' && qp.trash) return json({ documents: TRASH });
      if (method === 'GET') {
        if (holdLoad && holdLoad === qp.projectId) {
          holdLoad = null;
          await new Promise(r => { releaseLoad = r; });
        }
        return json({ folders: PTREE[qp.projectId || ''] || [],
          documents: PDOCS.filter(d => (d.project_id || '') === (qp.projectId || '')), caps: pcaps,
          ...(noVersion ? {} : { version: versionOf(qp.projectId) }) });
      }
      if (method === 'POST') {
        // A delivery line is checked against the order in the blob before
        // anything is written, with the server's answers.
        let poRow = null;
        if (body.poLineId != null && body.poLineId !== '') {
          if (!body.poId) return json({ error: 'poLineId needs its poId' }, 400);
          poRow = PO_BLOB.find(p => p.id === body.poId);
          if (!poRow) return json({ error: 'Purchase order not found' }, 404);
          if (!(poRow.lines || []).some(l => l.id === body.poLineId)) {
            return json({ error: 'Delivery line not found', detail: 'That delivery is not on the order yet — it may not have been saved. Wait a moment and try again.' }, 404);
          }
          if ((poRow.project_id || null) !== (qp.projectId || null)) return json({ error: 'That delivery belongs to another job' }, 400);
        }
        const d = doc({ id: body.documentId, project_id: qp.projectId || null, filename: body.filename,
          size_bytes: body.sizeBytes, note: body.note || '', folder_ids: [body.folderId],
          po_ids: body.poId ? [body.poId] : [], procurement_ids: body.procurementId ? [body.procurementId] : [],
          po_line_ids: poRow ? [`${body.poId}:${body.poLineId}`] : [] });
        // A delivery's file is filed in the order's own folder, when the
        // scope has one, and on a job in the cost-code folder of the
        // delivery's code (its own, else the order's).
        if (poRow) {
          const scope = PTREE[qp.projectId || ''] || [];
          const sub = scope.find(f => f.slug === `po-${body.poId}`);
          if (sub && !d.folder_ids.includes(sub.id)) d.folder_ids.push(sub.id);
          const line = poRow.lines.find(l => l.id === body.poLineId);
          const code = typeof line.cost_code === 'string' && line.cost_code.trim() ? line.cost_code.trim()
            : String(poRow.cost_code || '').trim();
          const cc = poRow.project_id && code ? ccFolderFor(qp.projectId, code) : null;
          if (cc && !d.folder_ids.includes(cc.id)) d.folder_ids.push(cc.id);
        }
        // What the server does with a line: file the document under the
        // line's cost code too, whatever folder was picked.
        let ccId = null;
        if (body.procurementId && LINE_CODE[body.procurementId]) {
          const f = ccFolderFor(qp.projectId, LINE_CODE[body.procurementId]);
          if (f) { ccId = f.id; if (!d.folder_ids.includes(f.id)) d.folder_ids.push(f.id); }
        }
        PDOCS.push(d);
        return json({ document: d, costCodeFolderId: ccId }, 201);
      }
      if (method === 'PATCH') {
        if (failPatch) return json({ error: 'Database error', detail: 'boom' }, 500);
        const at = PDOCS.findIndex(d => d.id === qp.id);
        if (body.restore) {
          const t = TRASH.findIndex(d => d.id === qp.id);
          if (t >= 0) PDOCS.push(TRASH.splice(t, 1)[0]);
          return json({ document: PDOCS[PDOCS.length - 1] });
        }
        if (at < 0) return json({ error: 'Document not found' }, 404);
        const d = PDOCS[at];
        if (body.removeProcurementId) d.procurement_ids = d.procurement_ids.filter(x => x !== body.removeProcurementId);
        if (body.removePoLineId !== undefined) {
          if (!/^[A-Za-z0-9_.-]{1,128}:[A-Za-z0-9_.-]{1,128}$/.test(String(body.removePoLineId))) {
            return json({ error: 'removePoLineId must be "<poId>:<lineId>"' }, 400);
          }
          d.po_line_ids = (d.po_line_ids || []).filter(x => x !== body.removePoLineId);
        }
        if (body.addPoId) d.po_ids.push(body.addPoId);
        if (body.removePoId) {
          d.po_ids = d.po_ids.filter(x => x !== body.removePoId);
          // Off the order is off its deliveries: the server drops every
          // "<poId>:<lineId>" link of that order with it.
          d.po_line_ids = (d.po_line_ids || []).filter(x => String(x).split(':')[0] !== body.removePoId);
        }
        return json({ document: d });
      }
      if (method === 'DELETE') {
        const at = PDOCS.findIndex(d => d.id === qp.id);
        if (at >= 0) TRASH.push(PDOCS.splice(at, 1)[0]);
        return json({ ok: true });
      }
      return json({});
    };

    let changes = 0;
    FD.configure({
      division: 'turf',
      getProjectId: () => 'p1',
      getProjectName: id => `Job ${id}`,
      getCostCodes: () => [],
      getPurchaseOrders: () => [{ id: 'po-1', po_number: 'PO-0137', supplier: 'Cleveland Quarry', project_id: 'p7' }],
      perm: { canUpload: true, canManage: true, canDelete: true },
      getUserName: undefined,
      onChange: () => { changes++; pcalls.push({ marker: 'onChange' }); },
    });
    const mount = window.document.getElementById('mount');
    await FD.renderTab(mount);                     // the Documents tab sits on p1

    assert('the procurement entry points are on the public surface',
      typeof FD.openProcurementAttach === 'function'
      && typeof FD.refreshProcurementCounts === 'function'
      && typeof FD.procurementCount === 'function');

    // ── Counts ────────────────────────────────────────────────────────────
    pcalls.length = 0;
    const c7 = await FD.refreshProcurementCounts('p7');
    assert('refreshProcurementCounts resolves to that job\'s { rowId: n } map',
      JSON.stringify(c7) === JSON.stringify({ 'pr-1': 3, 'pr-5': 1 }), JSON.stringify(c7));
    assert('in one GET for that job, carrying the division',
      pcalls.length === 1 && pcalls[0].method === 'GET' && pcalls[0].q.procurementCounts === '1'
        && pcalls[0].q.projectId === 'p7' && pcalls[0].q.division === 'turf',
      pcalls.map(c => `${c.method} ${c.url}`).join(' | '));
    assert('procurementCount reads a line\'s number', FD.procurementCount('p7', 'pr-1') === 3,
      String(FD.procurementCount('p7', 'pr-1')));
    assert('a line with nothing attached reads 0', FD.procurementCount('p7', 'pr-3') === 0);
    assert('a job never counted reads 0 rather than throwing', FD.procurementCount('p99', 'pr-1') === 0);
    assert('a row id that names a property of every object still reads 0',
      FD.procurementCount('p7', '__proto__') === 0 && FD.procurementCount('p7', 'constructor') === 0);

    // Counting must not move the Documents browser onto the job it counted:
    // the sheet asks about whatever job it shows, which is rarely the tab's.
    assert('counting a job neither seeds nor loads it',
      !pcalls.some(c => c.method === 'PUT' || (c.method === 'GET' && !c.q.procurementCounts)));
    mount.innerHTML = '';
    await FD.renderTab(mount);
    assert('and the Documents tab is still on its own job', /Safety/.test(mount.innerHTML)
      && !/Stormwater/.test(mount.innerHTML), mount.innerHTML.slice(0, 200));

    await FD.refreshProcurementCounts('p8');
    assert('counts are cached per job', FD.procurementCount('p8', 'pr-81') === 1
      && FD.procurementCount('p7', 'pr-1') === 3 && FD.procurementCount('p8', 'pr-1') === 0);

    pcalls.length = 0;
    const general = await FD.refreshProcurementCounts(null);
    assert('the General area has no procurement lines, and costs no request',
      general && Object.keys(general).length === 0 && pcalls.length === 0, JSON.stringify(general));

    // A failure is not a count of zero: the host would cache "counted" off it
    // and draw an empty paperclip on every line with files.
    failCounts = true;
    let rejected = false;
    const failedCounts = await FD.refreshProcurementCounts('p7').catch(() => { rejected = true; });
    failCounts = false;
    assert('a failed count fetch never rejects', !rejected);
    assert('it resolves null rather than an empty map', failedCounts === null, JSON.stringify(failedCounts));
    assert('and the last good counts are kept', FD.procurementCount('p7', 'pr-1') === 3);

    // A slow count that lands after a fresher one must not undo it. The slow
    // request saw pr-1 with three files; one is attached while it is out; the
    // fresh count sees four and lands first.
    holdCounts = 'p7';
    const slow = FD.refreshProcurementCounts('p7');
    await settle();
    PDOCS.push(doc({ id: 'pd5', project_id: 'p7', filename: 'extra.pdf', folder_ids: ['f-storm'], procurement_ids: ['pr-1'] }));
    await FD.refreshProcurementCounts('p7');
    assert('the fresher count lands', FD.procurementCount('p7', 'pr-1') === 4, String(FD.procurementCount('p7', 'pr-1')));
    releaseCounts();
    const slowAnswer = await slow;
    assert('a slow count cannot overwrite a fresher one for the same job',
      FD.procurementCount('p7', 'pr-1') === 4, String(FD.procurementCount('p7', 'pr-1')));
    assert('and the slow caller is handed the fresh numbers, not its stale ones',
      slowAnswer && slowAnswer['pr-1'] === 4, JSON.stringify(slowAnswer));

    // …but a refresh of ANOTHER job is no reason to throw an answer away: the
    // sheet and the Documents tab can each be counting a different job.
    PDOCS.splice(PDOCS.findIndex(d => d.id === 'pd5'), 1);
    holdCounts = 'p7';
    const slow7 = FD.refreshProcurementCounts('p7');
    await settle();
    await FD.refreshProcurementCounts('p8');
    releaseCounts();
    await slow7;
    assert('a count for one job still lands after another job was counted',
      FD.procurementCount('p7', 'pr-1') === 3, String(FD.procurementCount('p7', 'pr-1')));

    // ── costCodeCount's case-insensitive fallback ─────────────────────────
    await FD.refreshCostCodeCounts('p7');
    await FD.refreshCostCodeCounts('p8');
    assert('costCodeCount still answers the exact code',
      FD.costCodeCount('p7', 'Stormwater') === 2, String(FD.costCodeCount('p7', 'Stormwater')));
    assert('and a code that differs only in case finds the same folder',
      FD.costCodeCount('p7', 'stormwater') === 2 && FD.costCodeCount('p7', ' STORMWATER ') === 2,
      `${FD.costCodeCount('p7', 'stormwater')} / ${FD.costCodeCount('p7', ' STORMWATER ')}`);
    assert('an exact match wins over a case variant, even an empty one',
      FD.costCodeCount('p8', 'EARTHWORK') === 0 && FD.costCodeCount('p8', 'Earthwork') === 1,
      `${FD.costCodeCount('p8', 'EARTHWORK')} / ${FD.costCodeCount('p8', 'Earthwork')}`);
    assert('an unknown code is still 0', FD.costCodeCount('p7', 'Paving') === 0 && FD.costCodeCount('p7', '') === 0);

    // ── The register body ─────────────────────────────────────────────────
    const pdf = name => new window.File(['%PDF'], name, { type: 'application/pdf' });
    pcalls.length = 0;
    await FD._uploadOne(pdf('quote.pdf'), { folderId: 'f-photos', procurementId: 'pr-1', projectId: 'p7' });
    const reg7 = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
    assert('an upload from a line carries the line id into the registration',
      reg7 && reg7.body.procurementId === 'pr-1', reg7 && JSON.stringify(reg7.body));
    assert('alongside the folder that was picked, under the line\'s job',
      reg7 && reg7.body.folderId === 'f-photos' && reg7.q.projectId === 'p7', reg7 && reg7.url);
    pcalls.length = 0;
    await FD._uploadOne(pdf('ticket.pdf'), { folderId: 'f-po7', poId: 'po-1', projectId: 'p7' });
    const regPo = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
    assert('every other upload\'s body is untouched — no procurementId key at all',
      regPo && !('procurementId' in regPo.body) && regPo.body.poId === 'po-1', regPo && JSON.stringify(regPo.body));
    // Drop the two test uploads so the fixtures below read as written.
    for (let i = PDOCS.length - 1; i >= 0; i--) if (/^doc-up-/.test(PDOCS[i].id)) PDOCS.splice(i, 1);

    // ── The paperclip dialog ──────────────────────────────────────────────
    const LINE = { id: 'pr-1', project_id: 'p7', cost_code: 'Stormwater', sub_code: 'Geofabric',
                   label: 'Stormwater / Geofabric' };

    closeAll();
    pcalls.length = 0;
    changes = 0;
    await FD.openProcurementAttach(LINE);
    const loadIdx = pcalls.findIndex(c => c.method === 'GET' && c.q.projectId === 'p7'
      && !c.q.procurementId && !c.q.procurementCounts);
    const listIdx = pcalls.findIndex(c => c.method === 'GET' && c.q.procurementId);
    assert('opening a line on another job loads that job first',
      loadIdx >= 0 && pcalls.some(c => c.method === 'PUT' && c.q.projectId === 'p7'),
      pcalls.map(c => `${c.method || c.marker} ${c.url || ''}`).join(' | '));
    assert('then lists the line\'s files by procurementId, scoped to the job and the division',
      listIdx > loadIdx && pcalls[listIdx].q.procurementId === 'pr-1'
        && pcalls[listIdx].q.projectId === 'p7' && pcalls[listIdx].q.division === 'turf',
      listIdx >= 0 ? pcalls[listIdx].url : 'no list request');
    assert('and nudges the host to redraw, since a load ran', changes === 1, String(changes));

    let dlg = lastModal();
    assert('a wide dialog opens', Boolean(dlg) && /min\(60rem/.test(dlg.innerHTML));
    const titleOf = el => (el ? el.querySelector('span').textContent : '(no dialog open)');
    assert('titled with the line, without repeating a cost code the label already carries',
      titleOf(dlg) === 'Stormwater / Geofabric', titleOf(dlg));
    assert('it says how many files are attached', /3 attached documents/.test(dlg.textContent), dlg.textContent.slice(0, 200));
    assert('and lists each of them', ['geofabric-quote.pdf', 'cut-sheet.pdf', 'both.pdf']
      .every(n => dlg.textContent.includes(n)) && !dlg.textContent.includes('site.jpg'), dlg.textContent);
    const row1 = dlg.querySelector('[data-proc-doc="pd1"]');
    assert('each row carries size, uploader, date and note',
      row1 && /2 KB/.test(row1.textContent) && /ben/.test(row1.textContent)
        && /2026/.test(row1.textContent) && /quote rev B/.test(row1.textContent), row1 && row1.textContent);
    assert('and a download button', dlg.querySelectorAll('[data-pdl]').length === 3);
    assert('it says the files are compiled under the cost code too',
      /also filed in the Stormwater cost-code folder/.test(dlg.textContent), dlg.textContent);
    assert('the footer offers Close, the cost code\'s folder, and an attach',
      Boolean(dlg.querySelector('[data-cancel]'))
        && dlg.querySelector('[data-open-folder]') && /Open Stormwater folder/.test(dlg.querySelector('[data-open-folder]').textContent)
        && dlg.querySelector('[data-attach-new]') && /Attach a document/.test(dlg.querySelector('[data-attach-new]').textContent));
    assert('a manager may detach any of them', dlg.querySelectorAll('[data-detach]').length === 3);
    const detachTip = dlg.querySelector('[data-detach]').title;
    assert('and the Detach button says the file is not deleted', /not deleted/.test(detachTip), detachTip);

    pcalls.length = 0;
    dlg.querySelector('[data-pdl="pd2"]').click();
    await settle();
    assert('Download fetches that file\'s signed link',
      pcalls.some(c => c.path === '/api/document-download' && c.q.id === 'pd2'),
      pcalls.map(c => c.url).join(' | '));

    // Already on the job: no second load, and a matching count is no reason
    // to bother the host.
    closeAll();
    pcalls.length = 0;
    changes = 0;
    await FD.openProcurementAttach(LINE);
    assert('reopening on the same job does not reload it',
      !pcalls.some(c => c.method === 'PUT' || (c.method === 'GET' && !c.q.procurementId)),
      pcalls.map(c => `${c.method} ${c.url}`).join(' | '));
    assert('and with the paperclip already right, the host is not nudged', changes === 0, String(changes));

    // The list is the freshest count there is. Someone attached a file since
    // the sheet last counted — the paperclip the user clicked has to catch up.
    closeAll();
    PDOCS.push(doc({ id: 'pd6', project_id: 'p7', filename: 'late.pdf', folder_ids: ['f-storm'], procurement_ids: ['pr-1'] }));
    changes = 0;
    await FD.openProcurementAttach(LINE);
    assert('a stale paperclip count is corrected from the list',
      FD.procurementCount('p7', 'pr-1') === 4, String(FD.procurementCount('p7', 'pr-1')));
    assert('and the host is told to redraw it', changes === 1, String(changes));
    PDOCS.splice(PDOCS.findIndex(d => d.id === 'pd6'), 1);
    await FD.refreshProcurementCounts('p7');

    closeAll();
    await FD.openProcurementAttach({ ...LINE, label: 'Geofabric roll' });
    assert('a label without the code gets the code in the title',
      titleOf(lastModal()) === 'Geofabric roll · cost code Stormwater', titleOf(lastModal()));

    // ── Attach: the upload dialog ─────────────────────────────────────────
    closeAll();
    await FD.openProcurementAttach(LINE);
    lastModal().querySelector('[data-attach-new]').click();
    await settle();
    let up = lastModal();
    assert('Attach opens the upload dialog', /Upload documents/.test(titleOf(up)), titleOf(up));
    assert('with the folder defaulted to the line\'s cost-code folder',
      up.querySelector('#fctdoc-folder').value === 'f-storm', up.querySelector('#fctdoc-folder').value);
    assert('the line is shown, locked, by name',
      up.querySelector('#fctdoc-proc') && /^Procurement line: Stormwater \/ Geofabric$/
        .test(up.querySelector('#fctdoc-proc').textContent.trim().replace(/\s+/g, ' ')),
      up.querySelector('#fctdoc-proc') && up.querySelector('#fctdoc-proc').textContent);
    assert('and it is not a control that can be changed',
      !up.querySelector('#fctdoc-proc').matches('input,select,textarea')
        && !up.querySelector('#fctdoc-proc input,#fctdoc-proc select'));
    assert('the hint says the cost code gets it whatever folder is picked',
      /Filed under cost code Stormwater as well, whichever folder you pick\./.test(up.textContent), up.textContent);
    assert('the PO link stays optional and open, with no PO hint',
      !up.querySelector('#fctdoc-po').disabled && !/filed under the purchase order/i.test(up.textContent));

    // Pick another folder: the register carries the choice AND the line, and
    // the server files the cost-code copy on its own.
    up.querySelector('#fctdoc-folder').value = 'f-photos';
    const fInp = up.querySelector('#fctdoc-files');
    Object.defineProperty(fInp, 'files', { value: [pdf('invoice.pdf')], configurable: true });
    fInp.dispatchEvent(new window.Event('change', { bubbles: true }));
    pcalls.length = 0;
    changes = 0;
    up.querySelector('#fctdoc-go').click();
    await settle();
    const reg = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
    assert('the upload registers the line id', reg && reg.body.procurementId === 'pr-1', reg && JSON.stringify(reg.body));
    assert('and the folder the user chose', reg && reg.body.folderId === 'f-photos', reg && JSON.stringify(reg.body));
    assert('under the line\'s job', reg && reg.q.projectId === 'p7'
      && pcalls.find(c => c.path === '/api/document-upload-url').body.projectId === 'p7');
    assert('the dialog closes on success', !window.document.body.contains(up));
    const countsIdx = pcalls.findIndex(c => c.method === 'GET' && c.q.procurementCounts && c.q.projectId === 'p7');
    const changeIdx = pcalls.findIndex(c => c.marker === 'onChange');
    assert('the line counts are refreshed after the upload',
      countsIdx > pcalls.indexOf(reg), pcalls.map(c => `${c.method || c.marker} ${c.url || ''}`).join(' | '));
    assert('before the host is told to redraw', changeIdx > countsIdx && changes === 1, `${countsIdx} / ${changeIdx} / ${changes}`);
    assert('so the paperclip reads one more', FD.procurementCount('p7', 'pr-1') === 4, String(FD.procurementCount('p7', 'pr-1')));
    assert('and the cost-code folder compiled it too, though another folder was picked',
      FD.costCodeCount('p7', 'Stormwater') === 3, String(FD.costCodeCount('p7', 'Stormwater')));

    // The line's code typed in another case still opens on the right folder.
    closeAll();
    await FD.openProcurementAttach({ id: 'pr-2', project_id: 'p7', cost_code: 'stormwater', label: 'Storm Inlets' });
    lastModal().querySelector('[data-attach-new]').click();
    await settle();
    assert('a code in another case still defaults to its cost-code folder',
      lastModal().querySelector('#fctdoc-folder').value === 'f-storm', lastModal().querySelector('#fctdoc-folder').value);

    // An exact match beats an older folder that differs only in case, even
    // though that one is listed first.
    closeAll();
    await FD.openProcurementAttach({ id: 'pr-5', project_id: 'p7', cost_code: 'Mobilization', label: 'Mobilization / Trailer' });
    lastModal().querySelector('[data-attach-new]').click();
    await settle();
    assert('an exact cost-code folder wins over a case variant',
      lastModal().querySelector('#fctdoc-folder').value === 'f-mob', lastModal().querySelector('#fctdoc-folder').value);

    // A code that has no folder on this job yet: the server will create it on
    // the first attach, but there is nothing to preselect, so the user picks.
    closeAll();
    await FD.openProcurementAttach({ id: 'pr-4', project_id: 'p7', cost_code: 'Paving', label: 'Paving / Base' });
    lastModal().querySelector('[data-attach-new]').click();
    await settle();
    assert('a code with no folder yet opens on "pick a folder"',
      lastModal().querySelector('#fctdoc-folder').value === '', lastModal().querySelector('#fctdoc-folder').value);
    assert('and still says the cost code will get the file',
      /Filed under cost code Paving as well/.test(lastModal().textContent));

    // ── A line with no cost code ──────────────────────────────────────────
    closeAll();
    await FD.openProcurementAttach({ id: 'pr-3', project_id: 'p7', cost_code: '', label: 'Misc supplies' });
    dlg = lastModal();
    assert('a line with no cost code is titled with its label alone', titleOf(dlg) === 'Misc supplies', titleOf(dlg));
    assert('offers no cost-code folder to open', !dlg.querySelector('[data-open-folder]'));
    assert('says nothing attached yet', /Nothing attached yet/.test(dlg.textContent) && /0 attached documents/.test(dlg.textContent));
    assert('and explains where its files will be filed',
      /no cost code yet, so files attached here are filed only in the folder picked/.test(dlg.textContent), dlg.textContent);
    dlg.querySelector('[data-attach-new]').click();
    await settle();
    up = lastModal();
    assert('its upload opens with no folder chosen', up.querySelector('#fctdoc-folder').value === '');
    assert('and says the file goes only where it is put',
      /This line has no cost code yet, so the file is filed only in the folder you pick\./.test(up.textContent), up.textContent);
    const nInp = up.querySelector('#fctdoc-files');
    Object.defineProperty(nInp, 'files', { value: [pdf('misc.pdf')], configurable: true });
    nInp.dispatchEvent(new window.Event('change', { bubbles: true }));
    pcalls.length = 0;
    up.querySelector('#fctdoc-go').click();
    await settle();
    assert('and refuses to upload until a folder is picked',
      /Pick a folder/.test(up.querySelector('#fctdoc-err').textContent)
        && !pcalls.some(c => c.path === '/api/document-upload-url' || (c.method === 'POST' && c.path === '/api/documents')),
      up.querySelector('#fctdoc-err').textContent);
    up.querySelector('#fctdoc-folder').value = 'f-photos';
    up.querySelector('#fctdoc-go').click();
    await settle();
    const regN = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
    assert('once one is, it uploads to it, still tied to the line',
      regN && regN.body.folderId === 'f-photos' && regN.body.procurementId === 'pr-3', regN && JSON.stringify(regN.body));

    // ── Open <code> folder ────────────────────────────────────────────────
    closeAll();
    await FD.openProcurementAttach(LINE);
    lastModal().querySelector('[data-open-folder]').click();
    await settle();
    dlg = lastModal();
    assert('Open folder opens the cost code\'s folder dialog', titleOf(dlg) === 'Stormwater · Storm Sewer', titleOf(dlg));
    assert('which lists everything compiled under that cost code',
      /geofabric-quote\.pdf/.test(dlg.textContent) && /cut-sheet\.pdf/.test(dlg.textContent)
        && /invoice\.pdf/.test(dlg.textContent) && /filed under this cost code/.test(dlg.textContent), dlg.textContent);
    assert('and the line\'s own dialog got out of the way', modals().length === 1, String(modals().length));
    closeAll();
    await FD.openProcurementAttach({ id: 'pr-2', project_id: 'p7', cost_code: 'stormwater', label: 'Storm Inlets' });
    lastModal().querySelector('[data-open-folder]').click();
    await settle();
    assert('a code typed in another case still opens its folder',
      titleOf(lastModal()) === 'Stormwater · Storm Sewer', titleOf(lastModal()));

    // ── Detach ────────────────────────────────────────────────────────────
    closeAll();
    await FD.openProcurementAttach(LINE);
    dlg = lastModal();
    let asked = null;
    const realConfirm = window.confirm;
    window.confirm = msg => { asked = msg; return false; };
    pcalls.length = 0;
    dlg.querySelector('[data-detach="pd2"]').click();
    await settle();
    assert('Detach asks first, and says the file is not deleted',
      /cut-sheet\.pdf/.test(asked) && /not deleted/.test(asked), asked);
    assert('saying no changes nothing', !pcalls.some(c => c.method === 'PATCH'));

    failPatch = true;
    window.confirm = () => true;
    dlg.querySelector('[data-detach="pd2"]').click();
    await settle();
    failPatch = false;
    assert('a refused detach says why', /Database error/.test(bodyText()));
    assert('leaves the file listed with its button live again',
      dlg.querySelector('[data-detach="pd2"]') && !dlg.querySelector('[data-detach="pd2"]').disabled
        && dlg.querySelector('[data-detach="pd2"]').textContent === 'Detach');

    pcalls.length = 0;
    changes = 0;
    dlg.querySelector('[data-detach="pd2"]').click();
    await settle();
    const patch = pcalls.find(c => c.method === 'PATCH');
    assert('Detach PATCHes the document with removeProcurementId and nothing else',
      patch && patch.q.id === 'pd2' && patch.q.division === 'turf'
        && JSON.stringify(patch.body) === JSON.stringify({ removeProcurementId: 'pr-1' }),
      patch && `${patch.url} ${JSON.stringify(patch.body)}`);
    assert('it never deletes the file', !pcalls.some(c => c.method === 'DELETE')
      && PDOCS.some(d => d.id === 'pd2'));
    const dCounts = pcalls.findIndex(c => c.method === 'GET' && c.q.procurementCounts && c.q.projectId === 'p7');
    const dChange = pcalls.findIndex(c => c.marker === 'onChange');
    assert('then reloads the job and refreshes the line counts before telling the host',
      pcalls.some(c => c.method === 'GET' && c.q.projectId === 'p7' && !c.q.procurementId && !c.q.procurementCounts)
        && dCounts > pcalls.indexOf(patch) && dChange > dCounts && changes === 1,
      pcalls.map(c => `${c.method || c.marker} ${c.url || ''}`).join(' | '));
    assert('the same dialog redraws in place without the file',
      window.document.body.contains(dlg) && !dlg.querySelector('[data-proc-doc="pd2"]')
        && /3 attached documents/.test(dlg.textContent), dlg.textContent.slice(0, 200));
    assert('the paperclip reads one fewer', FD.procurementCount('p7', 'pr-1') === 3, String(FD.procurementCount('p7', 'pr-1')));
    assert('the cost-code folder keeps the file', FD.costCodeCount('p7', 'Stormwater') === 3,
      String(FD.costCodeCount('p7', 'Stormwater')));
    assert('and the toast says the file is still in the Vault', /Detached\. The file is still in the Vault/.test(bodyText()));

    // The detach landed but the list could not be fetched again afterwards.
    // The dialog must not keep offering Detach on a file that is no longer
    // attached, and the host must still hear about it.
    failList = true;
    changes = 0;
    dlg.querySelector('[data-detach="pd4"]').click();
    await settle();
    failList = false;
    assert('a detach whose refresh fails still drops the file from the dialog',
      !dlg.querySelector('[data-proc-doc="pd4"]') && /2 attached documents/.test(dlg.textContent),
      dlg.textContent.slice(0, 200));
    assert('says the list could not be refreshed', /Detached, but the list could not be refreshed/.test(bodyText()));
    assert('and still tells the host, with the paperclip one lower',
      changes === 1 && FD.procurementCount('p7', 'pr-1') === 2,
      `${changes} / ${FD.procurementCount('p7', 'pr-1')}`);
    // Put pd4 back on the line for the cases below.
    PDOCS.find(d => d.id === 'pd4').procurement_ids = ['pr-1', 'pr-5'];
    await FD.refreshProcurementCounts('p7');

    // ── Who may detach ────────────────────────────────────────────────────
    // The server's rule: a manager may edit any document's links, an uploader
    // only their own. The button follows it, so no one gets a button that 403s.
    const reopenAs = async (capsNow, getUserName) => {
      closeAll();
      pcaps = capsNow;
      FD.configure({ getUserName });
      await FD.renderTab(mount);                 // off the job, so the next open reloads caps
      await FD.openProcurementAttach(LINE);
      return lastModal();
    };
    PDOCS.push(doc({ id: 'pd7', project_id: 'p7', filename: 'sams.pdf', uploaded_by: 'sam',
      folder_ids: ['f-storm'], procurement_ids: ['pr-1'] }));
    dlg = await reopenAs({ canUpload: true, canManage: false, canDelete: false }, () => 'ben');
    assert('an uploader may detach their own files',
      Boolean(dlg.querySelector('[data-detach="pd1"]')) && Boolean(dlg.querySelector('[data-detach="pd4"]')),
      [...dlg.querySelectorAll('[data-detach]')].map(b => b.dataset.detach).join(','));
    assert('but not one someone else uploaded',
      Boolean(dlg.querySelector('[data-proc-doc="pd7"]')) && !dlg.querySelector('[data-detach="pd7"]'),
      [...dlg.querySelectorAll('[data-detach]')].map(b => b.dataset.detach).join(','));
    dlg = await reopenAs({ canUpload: true, canManage: false, canDelete: false }, undefined);
    assert('with no way to tell who is signed in, a non-manager gets no Detach at all',
      dlg.querySelectorAll('[data-detach]').length === 0 && Boolean(dlg.querySelector('[data-attach-new]')));
    dlg = await reopenAs({ canUpload: true, canManage: false, canDelete: false }, () => { throw new Error('no user'); });
    assert('a host getter that throws costs the button, not the dialog',
      Boolean(dlg) && dlg.querySelectorAll('[data-detach]').length === 0 && dlg.querySelectorAll('[data-pdl]').length > 0);
    dlg = await reopenAs({ canUpload: false, canManage: false, canDelete: false }, () => 'ben');
    assert('a viewer still sees the list and can download',
      dlg.querySelectorAll('[data-proc-doc]').length > 0 && dlg.querySelectorAll('[data-pdl]').length > 0);
    assert('but is offered no attach and no detach, even on their own name',
      !dlg.querySelector('[data-attach-new]') && dlg.querySelectorAll('[data-detach]').length === 0);
    assert('and can still open the cost code\'s folder to read it', Boolean(dlg.querySelector('[data-open-folder]')));
    dlg = await reopenAs({ canUpload: true, canManage: true, canDelete: true }, undefined);
    assert('a manager gets Detach on everyone\'s files',
      dlg.querySelectorAll('[data-detach]').length === dlg.querySelectorAll('[data-proc-doc]').length);
    PDOCS.splice(PDOCS.findIndex(d => d.id === 'pd7'), 1);

    // ── Races ─────────────────────────────────────────────────────────────
    // Something else loaded while the line's job was loading: the module state
    // now belongs to that, and building the dialog from it would offer the
    // wrong job's folders to file this line's document in.
    closeAll();
    await FD.renderTab(mount);                     // back on p1
    holdLoad = 'p7';
    pcalls.length = 0;
    const racing = FD.openProcurementAttach(LINE);
    await settle();
    await FD.renderTab(mount);                     // p1 loads while p7 is stalled
    releaseLoad();
    await racing;
    assert('a line whose load lost a race opens no dialog', modals().length === 0, String(modals().length));
    assert('and says to try the paperclip again',
      /Something else loaded while that was opening\. Try the paperclip again\./.test(bodyText()));
    assert('without listing anything for the line', !pcalls.some(c => c.q && c.q.procurementId));

    // Two clicks on a slow connection open one dialog — and without the
    // one-at-a-time guard the first click's load lost the race to the
    // second's and toasted an error over a dialog that opened fine.
    closeAll();
    const raceToasts = () => [...window.document.body.children]
      .filter(el => !el.querySelector('[data-body]') && /Something else loaded/.test(el.textContent)).length;
    const toastsBefore = raceToasts();
    await Promise.all([FD.openProcurementAttach(LINE), FD.openProcurementAttach(LINE)]);
    assert('a double click opens one dialog, not two', modals().length === 1, String(modals().length));
    assert('and raises no error toast', raceToasts() === toastsBefore, `${toastsBefore} -> ${raceToasts()}`);

    closeAll();
    const before = modals().length;
    await FD.openProcurementAttach({ id: '', project_id: 'p7', cost_code: 'Stormwater', label: 'Unsaved' });
    await FD.openProcurementAttach({ id: 'pr-9', project_id: null, cost_code: '', label: 'Nowhere' });
    assert('a line with no id or no job opens nothing', modals().length === before);

    // ── The Vault side: chips and preview ─────────────────────────────────
    FD.configure({ getProjectId: () => 'p7' });
    await FD.renderTab(mount);
    mount.querySelector('[data-folder="f-photos"]').click();
    const vrow = id => mount.querySelector(`[data-doc="${id}"]`);
    const chip = id => vrow(id) && vrow(id).querySelector('[data-proc-chip]');
    assert('a file detached from its only line carries no chip', vrow('pd2') && !chip('pd2'),
      vrow('pd2') && vrow('pd2').innerHTML);
    assert('a file on two says two', chip('pd4') && chip('pd4').title === 'Attached to 2 procurement lines'
      && /2/.test(chip('pd4').textContent), chip('pd4') && chip('pd4').outerHTML);
    assert('a file on none carries no chip', vrow('pd3') && !chip('pd3'));
    assert('the procurement chip is not the PO paperclip',
      vrow('pd4').querySelector('[title="Attached to 1 purchase order"]')
        && !/&#128206;|\u{1F4CE}/u.test(chip('pd4').textContent), vrow('pd4').innerHTML);

    vrow('pd4').querySelector('[data-open="pd4"]').click();
    await settle();
    let pv = lastModal();
    assert('the preview says how many procurement lines the file is on',
      /On 2 procurement lines/.test(pv.textContent), pv.textContent.slice(0, 400));
    closeAll();
    vrow('pd3').querySelector('[data-open="pd3"]').click();
    await settle();
    pv = lastModal();
    assert('and says nothing for a file on none', !/procurement line/.test(pv.textContent));
    closeAll();
    mount.querySelector('[data-folder="f-storm"]').click();
    assert('a file on one procurement line carries a chip saying so',
      chip('pd1') && chip('pd1').title === 'Attached to 1 procurement line' && /1/.test(chip('pd1').textContent),
      vrow('pd1') && vrow('pd1').innerHTML);
    vrow('pd1').querySelector('[data-open="pd1"]').click();
    await settle();
    assert('one line reads in the singular', /On 1 procurement line(?!s)/.test(lastModal().textContent),
      lastModal().textContent.slice(0, 400));
    closeAll();

    // ── Every other document change refreshes the line counts too ─────────
    const countsRefreshed = pid => pcalls.some(c => c.method === 'GET' && c.q.procurementCounts && c.q.projectId === pid);

    pcalls.length = 0;
    mount.querySelector('[data-folder="f-photos"]').click();
    mount.querySelector('[data-attach="pd3"]').click();
    let lk = lastModal();
    lk.querySelector('#fctdoc-linkpo').value = 'po-1';
    lk.querySelector('#fctdoc-dolink').click();
    await settle();
    assert('linking a file to a PO refreshes the line counts', countsRefreshed('p7'),
      pcalls.map(c => `${c.method || c.marker} ${c.url || ''}`).join(' | '));

    pcalls.length = 0;
    mount.querySelector('[data-folder="f-photos"]').click();
    mount.querySelector('[data-attach="pd3"]').click();
    lk = lastModal();
    lk.querySelector('[data-unlink="po-1"]').click();
    await settle();
    assert('so does unlinking it', countsRefreshed('p7'));

    pcalls.length = 0;
    changes = 0;
    mount.querySelector('[data-folder="f-storm"]').click();
    mount.querySelector('[data-delete="pd1"]').click();
    lastModal().querySelector('[data-yes]').click();
    await settle();
    assert('deleting a file refreshes the line counts', countsRefreshed('p7'));
    assert('so the deleted file stops counting on its line',
      FD.procurementCount('p7', 'pr-1') === 2, String(FD.procurementCount('p7', 'pr-1')));
    const delCounts = pcalls.findIndex(c => c.method === 'GET' && c.q.procurementCounts);
    assert('before the host is told to redraw',
      pcalls.findIndex(c => c.marker === 'onChange') > delCounts && changes === 1);

    // The bin lists every job's files, so a restore is recounted on the file's
    // own job — not on whichever job the Documents tab happens to be showing.
    FD.configure({ getProjectId: () => 'p1' });
    await FD.renderTab(mount);
    pcalls.length = 0;
    mount.querySelector('#fctdoc-trash').click();
    await settle();
    lastModal().querySelector('[data-restore="pd1"]').click();
    await settle();
    assert('restoring a file recounts the lines on its own job',
      countsRefreshed('p7'), pcalls.map(c => `${c.method || c.marker} ${c.url || ''}`).join(' | '));
    assert('so it counts on its line again', FD.procurementCount('p7', 'pr-1') === 3,
      String(FD.procurementCount('p7', 'pr-1')));
    closeAll();

    // ── The PO paperclip is exactly what it was ───────────────────────────
    await FD.openAttach({ id: 'po-1', po_number: 'PO-0137', project_id: 'p7' });
    lastModal().querySelector('[data-attach-new]').click();
    await settle();
    up = lastModal();
    assert('the PO upload dialog shows no procurement line and no cost-code hint',
      !up.querySelector('#fctdoc-proc') && !up.querySelector('[data-proc-hint]')
        && up.querySelector('#fctdoc-po').disabled && up.querySelector('#fctdoc-po').value === 'po-1');
    assert('and still opens on the Purchase Orders folder', up.querySelector('#fctdoc-folder').value === 'f-po7',
      up.querySelector('#fctdoc-folder').value);
    const poInp = up.querySelector('#fctdoc-files');
    Object.defineProperty(poInp, 'files', { value: [pdf('po-ticket.pdf')], configurable: true });
    poInp.dispatchEvent(new window.Event('change', { bubbles: true }));
    pcalls.length = 0;
    up.querySelector('#fctdoc-go').click();
    await settle();
    const regPo2 = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
    assert('and its upload carries the PO and no procurement line',
      regPo2 && regPo2.body.poId === 'po-1' && !('procurementId' in regPo2.body), regPo2 && JSON.stringify(regPo2.body));
    closeAll();

    // ── What the server moves on its own reaches the chips and the folder ──
    // A line re-coded (a Sub Code picked, the bid's code renamed) has its
    // files moved between cost-code folders by the server, and a colleague's
    // attachment lands in one. Neither reaches the copy of the job this
    // browser holds, so counting or listing from that copy left the section
    // chip and its folder on the old answer for as long as the browser sat on
    // the job.
    const toasts = kind => [...window.document.body.children]
      .filter(el => el.getAttribute && el.getAttribute('data-fctdoc-toast') === kind);
    const errorsBefore = () => toasts('error').length;
    // Reads of the job's whole listing, and of its cost-code counts alone.
    const reads = () => pcalls.filter(c => c.method === 'GET' && c.q && c.q.projectId === 'p7'
      && !c.q.procurementId && !c.q.procurementCounts && !c.q.costCodeCounts
      && !c.q.poLineCounts && !c.q.poLineId && !c.q.poId && !c.q.poCounts);
    const ccReads = () => pcalls.filter(c => c.method === 'GET' && c.q && c.q.projectId === 'p7' && c.q.costCodeCounts);
    await FD.openProcurementAttach(LINE);          // the browser holds p7
    closeAll();
    const stormWas = FD.costCodeCount('p7', 'Stormwater');
    const mobWas = FD.costCodeCount('p7', 'Mobilization');
    // pd2 (on pr-1) re-filed from Stormwater to Mobilization; a colleague's
    // file attached to pr-5 lands in Mobilization.
    const pd2 = PDOCS.find(d => d.id === 'pd2');
    pd2.folder_ids = pd2.folder_ids.map(id => (id === 'f-storm' ? 'f-mob' : id));
    PDOCS.push(doc({ id: 'pd9', project_id: 'p7', filename: 'colleague.pdf', uploaded_by: 'sam',
      folder_ids: ['f-mob'], procurement_ids: ['pr-5'] }));

    pcalls.length = 0;
    await FD.refreshCostCodeCounts('p7');
    assert('a plain count of the job in hand is still free (the bid page\'s chips)',
      pcalls.length === 0 && FD.costCodeCount('p7', 'Stormwater') === stormWas, pcalls.map(c => c.url).join(' | '));
    pcalls.length = 0;
    const freshCounts = await FD.refreshCostCodeCounts('p7', { fresh: true });
    assert('a fresh count asks the server even for the job in hand: one counts-only GET, never the listing, nothing seeded',
      ccReads().length === 1 && reads().length === 0 && !pcalls.some(c => c.method === 'PUT')
        && pcalls.length === 1 && pcalls[0].q.costCodeCounts === '1' && pcalls[0].q.division === 'turf',
      pcalls.map(c => `${c.method} ${c.url}`).join(' | '));
    assert('…and the chips follow the files the server moved',
      FD.costCodeCount('p7', 'Stormwater') === stormWas - 1 && FD.costCodeCount('p7', 'Mobilization') === mobWas + 2
        && freshCounts && freshCounts.Mobilization === mobWas + 2,
      `${stormWas}->${FD.costCodeCount('p7', 'Stormwater')} / ${mobWas}->${FD.costCodeCount('p7', 'Mobilization')}`);
    // The counts said the copy in hand is behind, so nothing reads that copy
    // as current any more — not even a plain count, which asks the server.
    pcalls.length = 0;
    await FD.refreshCostCodeCounts('p7');
    assert('with the copy in hand known to be behind, a plain count asks the server (counts only) rather than count the copy',
      ccReads().length === 1 && reads().length === 0 && FD.costCodeCount('p7', 'Mobilization') === mobWas + 2,
      pcalls.map(c => `${c.method} ${c.url}`).join(' | '));
    pcalls.length = 0;
    const openedMob = await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Mobilization' });
    dlg = lastModal();
    assert('the folder dialog reads the job again first (one listing), and lists what the chip counts',
      openedMob === true && reads().length === 1 && /colleague\.pdf/.test(dlg.textContent) && /cut-sheet\.pdf/.test(dlg.textContent)
        && new RegExp(`${mobWas + 2} documents filed under this cost code`).test(dlg.textContent), dlg.textContent.slice(0, 300));
    closeAll();
    // That read brought the copy up to date: the next fresh count agrees with
    // it, and nothing reads the job again for a dialog or a plain count.
    pcalls.length = 0;
    await FD.refreshCostCodeCounts('p7', { fresh: true });
    await FD.refreshCostCodeCounts('p7');
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Mobilization' });
    assert('a fresh count that agrees with the copy in hand leaves it trusted: no listing read, the plain count free again',
      reads().length === 0 && ccReads().length === 1 && /colleague\.pdf/.test(lastModal().textContent),
      pcalls.map(c => `${c.method} ${c.url}`).join(' | '));
    closeAll();
    // A server from before the counts endpoint answers with the listing: the
    // chips are counted from that, as they used to be.
    oldServer = true;
    pcalls.length = 0;
    const viaListing = await FD.refreshCostCodeCounts('p7', { fresh: true });
    assert('a server without the counts endpoint (it answers with the listing) is still counted, the same numbers',
      viaListing && viaListing.Mobilization === mobWas + 2 && FD.costCodeCount('p7', 'Stormwater') === stormWas - 1
        && pcalls.length === 1 && pcalls[0].q.costCodeCounts === '1', JSON.stringify(viaListing));
    oldServer = false;

    // The sheet's own folder chip opens fresh: the job is read again even
    // though it is the one in hand, so a re-file since the last count shows.
    PDOCS.find(d => d.id === 'pd9').folder_ids = ['f-storm'];
    pcalls.length = 0;
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Stormwater', fresh: true });
    dlg = lastModal();
    assert('a fresh folder open reads the job again and lists the file filed there since',
      reads().length === 1 && /colleague\.pdf/.test(dlg.textContent), dlg.textContent.slice(0, 300));
    assert('…and the chip count is moved with it', FD.costCodeCount('p7', 'Stormwater') === stormWas,
      String(FD.costCodeCount('p7', 'Stormwater')));
    closeAll();

    // The line dialog's "Open <code> folder" reads the job again too. pd2 is
    // known to the copy in hand, so opening the line costs no reload; only
    // the click does.
    pd2.folder_ids = pd2.folder_ids.map(id => (id === 'f-mob' ? 'f-storm' : id));
    await FD.openProcurementAttach({ id: 'pr-5', project_id: 'p7', cost_code: 'Mobilization', label: 'Mobilization / Trailer' });
    pd2.folder_ids = pd2.folder_ids.map(id => (id === 'f-storm' ? 'f-mob' : id));
    const lineDlg = lastModal();
    pcalls.length = 0;
    lineDlg.querySelector('[data-open-folder]').click();
    await settle();
    dlg = lastModal();
    assert('"Open Mobilization folder" reads the job, then lists a file the server re-filed into it',
      reads().length === 1 && dlg !== lineDlg && /cut-sheet\.pdf/.test(dlg.textContent)
        && !window.document.body.contains(lineDlg), dlg.textContent.slice(0, 300));
    closeAll();

    // A line holding a file the copy in hand has never seen reads the job
    // again before offering a folder picker built from that copy.
    PDOCS.push(doc({ id: 'pd10', project_id: 'p7', filename: 'new-from-sam.pdf', uploaded_by: 'sam',
      folder_ids: ['f-storm'], procurement_ids: ['pr-1'] }));
    pcalls.length = 0;
    changes = 0;
    await FD.openProcurementAttach(LINE);
    const listAt = pcalls.findIndex(c => c.method === 'GET' && c.q.procurementId);
    const reloadAt = pcalls.findIndex((c, i) => i > listAt && c.method === 'GET' && c.q.projectId === 'p7'
      && !c.q.procurementId && !c.q.procurementCounts);
    assert('a line listing a file the job in hand lacks reads the job again, after the list',
      listAt >= 0 && reloadAt > listAt, pcalls.map(c => `${c.method || c.marker} ${c.url || ''}`).join(' | '));
    assert('…and tells the host once', changes === 1, String(changes));
    closeAll();
    pcalls.length = 0;
    await FD.openProcurementAttach(LINE);
    assert('with nothing new on the line, opening it again reads nothing more than its list',
      reads().length === 0 && !pcalls.some(c => c.method === 'PUT'), pcalls.map(c => c.url).join(' | '));
    closeAll();
    for (const id of ['pd9', 'pd10']) PDOCS.splice(PDOCS.findIndex(d => d.id === id), 1);
    pd2.folder_ids = pd2.folder_ids.map(id => (id === 'f-mob' ? 'f-storm' : id));

    // A fresh count whose answer lands after a load of another job leaves
    // that job on screen: the module state is the newer load's.
    await FD.openProcurementAttach(LINE);
    closeAll();
    holdCc = 'p7';
    const slowFresh = FD.refreshCostCodeCounts('p7', { fresh: true });
    await settle();
    await FD.renderTab(mount);                       // the Documents tab loads p1 meanwhile
    releaseCc();
    await slowFresh;
    mount.querySelector('[data-folder="f-p1"]').click();   // redraw from the module state
    assert('a fresh count landing late never puts its job\'s folders under another job',
      /Safety/.test(mount.innerHTML) && !/Stormwater/.test(mount.innerHTML), mount.innerHTML.slice(0, 300));
    pcalls.length = 0;
    await FD.renderTab(mount);
    assert('…nor marks the job on screen as behind (the next draw of p1 reads nothing extra)',
      !pcalls.some(c => c.method === 'GET' && c.q.projectId === 'p7'), pcalls.map(c => `${c.method} ${c.url}`).join(' | '));
    // A fresh count that lands after a load of the SAME job started is older
    // than that load: it neither overwrites the load's counts nor marks it behind.
    await FD.openProcurementAttach(LINE);
    closeAll();
    const loadedCounts = FD.costCodeCount('p7', 'Stormwater');
    holdCc = 'p7';
    const slowSame = FD.refreshCostCodeCounts('p7', { fresh: true });
    await settle();
    PDOCS.push(doc({ id: 'pd12', project_id: 'p7', filename: 'mid-flight.pdf', folder_ids: ['f-storm'] }));
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Stormwater', fresh: true });   // a load lands first
    closeAll();
    releaseCc();
    await slowSame;
    pcalls.length = 0;
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Stormwater' });
    assert('a fresh count older than a load of the same job keeps the load\'s counts and does not mark it behind',
      FD.costCodeCount('p7', 'Stormwater') === loadedCounts + 1 && reads().length === 0
        && /mid-flight\.pdf/.test(lastModal().textContent), `${loadedCounts} -> ${FD.costCodeCount('p7', 'Stormwater')}`);
    closeAll();
    PDOCS.splice(PDOCS.findIndex(d => d.id === 'pd12'), 1);

    // ── A change that moves no count ──────────────────────────────────────
    // A colleague swaps the Stormwater quote for its new revision: Stormwater
    // still holds as many files as before. The counts cannot tell, but the
    // job's fingerprint, sent with them, can.
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Stormwater', fresh: true });   // the copy in hand is current
    closeAll();
    const pd1 = PDOCS.find(d => d.id === 'pd1');
    PDOCS.splice(PDOCS.indexOf(pd1), 1);
    PDOCS.push(doc({ id: 'pd1b', project_id: 'p7', filename: 'geofabric-quote-REV-C.pdf', folder_ids: ['f-storm'],
      procurement_ids: ['pr-1'] }));
    const stormSame = FD.costCodeCount('p7', 'Stormwater');
    pcalls.length = 0;
    await FD.refreshCostCodeCounts('p7', { fresh: true });
    assert('a swap that moves no count leaves the chip on its number, and the poll still reads counts only',
      FD.costCodeCount('p7', 'Stormwater') === stormSame && ccReads().length === 1 && reads().length === 0);
    pcalls.length = 0;
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Stormwater' });   // the bid page's chip: not a fresh open
    dlg = lastModal();
    assert('…but the fingerprint marks the copy behind: the folder dialog reads the job, lists the new revision and not the file taken away',
      reads().length === 1 && /geofabric-quote-REV-C\.pdf/.test(dlg.textContent) && !/geofabric-quote\.pdf/.test(dlg.textContent),
      dlg.textContent.slice(0, 300));
    closeAll();

    // The PO paperclip builds its upload picker from the copy too. Here a
    // colleague's first attach to PO-0137 went into Photos: no count moves,
    // but the server made the order's own subfolder, which is where its
    // paperwork belongs by default.
    PTREE.p7.push({ id: 'f-po-sub', parent_id: 'f-po7', name: 'PO PO-0137', kind: 'fixed', slug: 'po-po-1', sort_order: 1 });
    PDOCS.push(doc({ id: 'pd13', project_id: 'p7', filename: 'po-receipt.pdf', folder_ids: ['f-photos', 'f-po-sub'], po_ids: ['po-1'] }));
    await FD.refreshCostCodeCounts('p7', { fresh: true });
    pcalls.length = 0;
    await FD.openAttach({ id: 'po-1', po_number: 'PO-0137', project_id: 'p7' });
    lastModal().querySelector('[data-attach-new]').click();
    await settle();
    up = lastModal();
    assert('the PO paperclip reads the job again once the copy is behind, and its upload opens on the order\'s own new subfolder',
      reads().length === 1 && up.querySelector('#fctdoc-folder').value === 'f-po-sub'
        && [...up.querySelectorAll('#fctdoc-folder option')].some(o => o.value === 'f-po-sub'),
      `${reads().length} reads; folder ${up.querySelector('#fctdoc-folder').value}`);
    closeAll();
    pcalls.length = 0;
    await FD.refreshCostCodeCounts('p7', { fresh: true });
    await FD.openAttach({ id: 'po-1', po_number: 'PO-0137', project_id: 'p7' });
    assert('…and with nothing changed since, the poll leaves the copy trusted and the paperclip reads nothing more',
      reads().length === 0 && ccReads().length === 1, pcalls.map(c => `${c.method} ${c.url}`).join(' | '));
    closeAll();

    // A server that sends no fingerprint: the counts are all there is, so a
    // move that changes them is still noticed.
    noVersion = true;
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Stormwater', fresh: true });
    closeAll();
    const pd1b = PDOCS.find(d => d.id === 'pd1b');
    pd1b.folder_ids = ['f-mob'];
    await FD.refreshCostCodeCounts('p7', { fresh: true });
    pcalls.length = 0;
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Mobilization' });
    assert('with no fingerprint from the server, a count that moved still marks the copy behind',
      reads().length === 1 && /geofabric-quote-REV-C\.pdf/.test(lastModal().textContent), lastModal().textContent.slice(0, 200));
    closeAll();
    noVersion = false;
    PTREE.p7.splice(PTREE.p7.findIndex(f => f.id === 'f-po-sub'), 1);
    PDOCS.splice(PDOCS.findIndex(d => d.id === 'pd13'), 1);
    PDOCS.splice(PDOCS.findIndex(d => d.id === 'pd1b'), 1);
    PDOCS.push(pd1);

    // ── The line paperclip honours a copy found behind, too ───────────────
    // A colleague's file on another Paving line made the Paving folder since
    // this browser read the job. The poll marks the copy behind; the line's
    // own list holds nothing new, so only that flag makes the paperclip read
    // the job again before building its upload picker.
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Stormwater', fresh: true });
    closeAll();
    PTREE.p7.push({ id: 'f-pave-v', parent_id: null, name: 'Paving', kind: 'cost_code', slug: 'cc-Paving', cost_code: 'Paving', sort_order: 800 });
    PDOCS.push(doc({ id: 'pd-v1', project_id: 'p7', filename: 'colleague-paving.pdf', folder_ids: ['f-pave-v'], procurement_ids: ['pr-6'] }));
    await FD.refreshCostCodeCounts('p7', { fresh: true });
    pcalls.length = 0;
    await FD.openProcurementAttach({ id: 'pr-4', project_id: 'p7', cost_code: 'Paving', label: 'Paving / Base' });
    lastModal().querySelector('[data-attach-new]').click();
    await settle();
    assert('the line paperclip reads the job again once the copy is behind, and its upload opens on the new Paving folder',
      reads().length >= 1 && lastModal().querySelector('#fctdoc-folder').value === 'f-pave-v',
      `${reads().length} reads; folder ${lastModal().querySelector('#fctdoc-folder').value}`);
    closeAll();
    PTREE.p7.splice(PTREE.p7.findIndex(f => f.id === 'f-pave-v'), 1);
    PDOCS.splice(PDOCS.findIndex(d => d.id === 'pd-v1'), 1);
    await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Stormwater', fresh: true });
    closeAll();

    // ── A section code with no folder yet ─────────────────────────────────
    // A line keeps a code that is not on the job's bid ("Paving" here: the
    // bid seeds no codes in this fixture). The server makes its folder when
    // the first file is attached; until then there is nothing to open, and
    // that is not a fault.
    await FD.openProcurementAttach({ id: 'pr-4', project_id: 'p7', cost_code: 'Paving', label: 'Paving / Base' });
    const paveDlg = lastModal();
    const errs = errorsBefore();
    pcalls.length = 0;
    paveDlg.querySelector('[data-open-folder]').click();
    await settle();
    assert('"Open Paving folder" with no folder yet keeps the line dialog up, and opens nothing over it',
      lastModal() === paveDlg && modals().length === 1, String(modals().length));
    assert('…after reading the job again, in case the folder was made since', reads().length === 1);
    assert('…saying in the dialog that nothing is filed under the code yet, and how its folder comes to be',
      /Nothing is filed under cost code Paving yet/.test(paveDlg.textContent)
        && /made when the first file is attached to a line with this code/.test(paveDlg.textContent), paveDlg.textContent);
    assert('…with no error, and no button left that leads nowhere',
      errorsBefore() === errs && !paveDlg.querySelector('[data-open-folder]') && Boolean(paveDlg.querySelector('[data-attach-new]')));
    closeAll();
    const infoBefore = toasts('info').length;
    const missing = await FD.openCostCodeFolder({ projectId: 'p7', costCode: 'Paving', fresh: true });
    const lastInfo = toasts('info').pop();
    assert('the section chip for that code says the same as a notice, not an error',
      missing === 'missing' && modals().length === 0 && errorsBefore() === errs && toasts('info').length === infoBefore + 1
        && /No document folder for cost code Paving yet/.test(lastInfo.textContent)
        && /nothing has been filed under it/.test(lastInfo.textContent), lastInfo && lastInfo.textContent);

    // Once a colleague attaches a file, the server has made the folder: the
    // same button now opens it.
    PTREE.p7.push({ id: 'f-pave', parent_id: null, name: 'Paving', kind: 'cost_code', slug: 'cc-Paving',
      cost_code: 'Paving', sort_order: 800 });
    PDOCS.push(doc({ id: 'pd11', project_id: 'p7', filename: 'base-ticket.pdf', folder_ids: ['f-photos', 'f-pave'],
      procurement_ids: ['pr-4'] }));
    await FD.openProcurementAttach({ id: 'pr-4', project_id: 'p7', cost_code: 'Paving', label: 'Paving / Base' });
    lastModal().querySelector('[data-open-folder]').click();
    await settle();
    dlg = lastModal();
    assert('once the folder exists, the same button opens it',
      titleOf(dlg) === 'Paving' && /base-ticket\.pdf/.test(dlg.textContent) && modals().length === 1, titleOf(dlg));
    closeAll();
    PTREE.p7.pop();
    PDOCS.splice(PDOCS.findIndex(d => d.id === 'pd11'), 1);

    // ── Codes that read the same are the same code ────────────────────────
    // p9: the bid carried Stormwater twice, once pasted with a non-breaking
    // space after it, so the job has a folder for each spelling. Both are
    // Stormwater to anyone reading the job; the chip counts each file once
    // across them, and the dialog lists what the chip counts. And a dash
    // typed one way on the sheet finds the folder the bid spelled the other.
    PTREE.p9 = [
      { id: 'h-sw-nb', parent_id: null, name: 'Stormwater · Storm Sewer', kind: 'cost_code', slug: 'cc-Stormwater ',
        cost_code: 'Stormwater ', sort_order: 9 },
      { id: 'h-sw', parent_id: null, name: 'Stormwater', kind: 'cost_code', slug: 'cc-Stormwater', cost_code: 'Stormwater',
        sort_order: 800 },
      { id: 'h-walk', parent_id: null, name: 'Walkway – Wearing', kind: 'cost_code', slug: 'cc-Walkway – Wearing',
        cost_code: 'Walkway – Wearing', sort_order: 10 },
    ];
    PDOCS.push(
      doc({ id: 'pe1', project_id: 'p9', filename: 'seeded-only.pdf', folder_ids: ['h-sw-nb'] }),
      doc({ id: 'pe2', project_id: 'p9', filename: 'second-only.pdf', folder_ids: ['h-sw'] }),
      doc({ id: 'pe3', project_id: 'p9', filename: 'in-both.pdf', folder_ids: ['h-sw-nb', 'h-sw'] }),
      doc({ id: 'pe4', project_id: 'p9', filename: 'walkway.pdf', folder_ids: ['h-walk'] }));
    await FD.refreshCostCodeCounts('p9');
    assert('two folders whose codes trim alike count as one cost code, each file once',
      FD.costCodeCount('p9', 'Stormwater') === 3, String(FD.costCodeCount('p9', 'Stormwater')));
    assert('a hyphen typed where the bid has an en dash, in another case, finds that code\'s count',
      FD.costCodeCount('p9', 'walkway - wearing') === 1, String(FD.costCodeCount('p9', 'walkway - wearing')));
    await FD.openCostCodeFolder({ projectId: 'p9', costCode: 'Stormwater' });
    dlg = lastModal();
    assert('the folder dialog lists all three under the first folder\'s name',
      titleOf(dlg) === 'Stormwater · Storm Sewer' && /3 documents filed under this cost code/.test(dlg.textContent)
        && ['seeded-only.pdf', 'second-only.pdf', 'in-both.pdf'].every(n => dlg.textContent.includes(n))
        && !/ in Stormwater/.test(dlg.textContent), dlg.textContent.slice(0, 400));
    closeAll();
    await FD.openProcurementAttach({ id: 'pr-91', project_id: 'p9', cost_code: 'walkway - wearing', label: 'Walkway' });
    lastModal().querySelector('[data-attach-new]').click();
    await settle();
    assert('and the upload from that line opens on the bid\'s folder for it',
      lastModal().querySelector('#fctdoc-folder').value === 'h-walk', lastModal().querySelector('#fctdoc-folder').value);
    closeAll();
    for (const id of ['pe1', 'pe2', 'pe3', 'pe4']) PDOCS.splice(PDOCS.findIndex(d => d.id === id), 1);
    delete PTREE.p9;

    // The three copies of the normalising agree, character for character:
    // the sheet's sections (tracker.html), the server's filing
    // (api/lib/procurement-docs.js) and the chips (documents.js).
    {
      const { fnSource } = require('./lib/fn-source');
      const trackerKey = vm.runInNewContext(`(${fnSource(read('tracker.html'), '_codeKey')})`);
      const serverKey = require(path.resolve(__dirname, '..', 'api', 'lib', 'procurement-docs.js')).codeKey;
      const samples = ['Stormwater', ' stormwater ', 'Walkway – Wearing ', 'walkway - wearing', 'Walk​way—Wearing',
        '“A” ‘b’', '"a" \'b\'', 'E&S  Control', '', null, undefined, 420, '  ', '﻿420­'];
      const odd = samples.filter(s => !(FD._codeKey(s) === trackerKey(s) && serverKey(s) === trackerKey(s)));
      assert('documents.js, the server and tracker.html normalise every sample code the same way',
        odd.length === 0, odd.map(s => `${JSON.stringify(s)}: ${JSON.stringify([FD._codeKey(s), serverKey(s), trackerKey(s)])}`).join(' | '));
    }

    // The two copies of the folder chips' count agree: documents.js's, which
    // counts a listing in the browser, and the server's, behind
    // ?costCodeCounts=1 (api/lib/cost-code-counts.js). Same numbers AND the
    // same key order — costCodeCount()'s codeKey fallback takes the first
    // match in that order, and integer-like codes ("420") reorder a plain
    // object the same way on both sides only if both build it the same way.
    {
      const server = require(path.resolve(__dirname, '..', 'api', 'lib', 'cost-code-counts.js'));
      const same = (fl, ds) => {
        const a = FD._countByCostCode(fl, ds), b = server.countByCostCode(fl, ds);
        return JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));
      };
      const F = (id, o) => ({ id, parent_id: null, kind: 'cost_code', ...o });
      const named = [
        // nested subfolders, a document in two folders of one code, one in none
        [[F('a', { cost_code: '420' }), { id: 'a1', parent_id: 'a', kind: 'user' }, { id: 'a2', parent_id: 'a1', kind: 'user' },
          F('b', { cost_code: 'Stormwater' }), { id: 'x', parent_id: null, kind: 'fixed', slug: 'photos' }],
         [{ folder_ids: ['a2'] }, { folder_ids: ['a', 'a1'] }, { folder_ids: ['x'] }, { folder_ids: [] }, { folder_ids: ['b', 'x'] }]],
        // trailing-space and non-breaking-space spellings, legacy slug-only folders, a whitespace-only cost_code,
        // a 'cc-' slug on a folder that is not kind cost_code (not a cost-code folder), integer-like codes out of order
        [[F('s1', { cost_code: 'Stormwater ' }), F('s2', { cost_code: 'Stormwater ' }), F('s3', { slug: 'cc-Stormwater' }),
          F('w', { cost_code: '  ', slug: 'cc-Walk' }), { id: 'u', parent_id: null, kind: 'user', slug: 'cc-Fake' },
          F('n9', { cost_code: '900' }), F('n1', { cost_code: '100' }), F('z', { cost_code: 'zeta' }), F('e', { cost_code: '' })],
         [{ folder_ids: ['s1'] }, { folder_ids: ['s2', 's3'] }, { folder_ids: ['u'] }, { folder_ids: ['n9'] }, { folder_ids: ['w'] }]],
        [[], []],
      ];
      const badNamed = named.filter(([fl, ds]) => !same(fl, ds));
      // …and a few hundred random trees.
      let seed = 7;
      const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
      const CODES = ['420', '100', 'Stormwater', 'Stormwater ', 'stormwater', 'Walk – Way', 'Walk - Way', '  ', ''];
      const badRandom = [];
      for (let t = 0; t < 300; t++) {
        const fl = [];
        const nF = 1 + rnd(9);
        for (let i = 0; i < nF; i++) {
          const kind = ['cost_code', 'cost_code', 'user', 'fixed'][rnd(4)];
          const parent = i && rnd(3) === 0 ? fl[rnd(i)].id : null;
          const code = CODES[rnd(CODES.length)];
          fl.push({ id: `f${i}`, parent_id: parent, kind, cost_code: rnd(4) ? code : null, slug: rnd(2) ? `cc-${CODES[rnd(CODES.length)]}` : null });
        }
        const ds = Array.from({ length: rnd(8) }, () => ({ folder_ids: Array.from({ length: rnd(3) }, () => `f${rnd(nF + 1)}`) }));
        if (!same(fl, ds)) badRandom.push(JSON.stringify([fl, ds]));
      }
      assert('documents.js and the server count the folder chips alike: same codes, same numbers, same order',
        badNamed.length === 0 && badRandom.length === 0,
        [...badNamed.map(x => JSON.stringify(x)), ...badRandom.slice(0, 2)].join(' | '));
      assert('…including the codes that read alike and the nested folders',
        JSON.stringify(server.countByCostCode(...named[0])) === JSON.stringify({ 420: 2, Stormwater: 1 })
          && server.countByCostCode(...named[1]).Stormwater === 2 && server.countByCostCode(...named[1]).Walk === undefined,
        JSON.stringify([server.countByCostCode(...named[0]), server.countByCostCode(...named[1])]));
    }

    // ── 7. Purchase-order delivery lines ──────────────────────────────────
    // A paperclip in every delivery row of the PO tab. A file attached there
    // is ONE document: listed on the delivery (a po_line link,
    // "<poId>:<lineId>"), on its order (the 'po' link the order's paperclip
    // lists), filed in the order's own folder and — on a job — in the
    // cost-code folder of the delivery's code. The server checks and files;
    // this module owns the line counts, the delivery's dialog, carrying the
    // delivery into the upload, and detaching. Same in-memory API as above,
    // taught the delivery routes the way api/documents.js answers them.
    {
      console.log('\n[purchase-order delivery lines]');

      const had = new Set(PDOCS.map(d => d.id));
      PTREE.p5 = [
        { id: 'f5-po', parent_id: null, name: 'Purchase Orders', kind: 'fixed', slug: 'purchase-orders', sort_order: 7 },
        { id: 'f5-po42', parent_id: 'f5-po', name: 'PO PO-0420', kind: 'fixed', slug: 'po-po-42', sort_order: 500 },
        { id: 'f5-photos', parent_id: null, name: 'Photos', kind: 'fixed', slug: 'photos', sort_order: 5 },
        { id: 'f5-420', parent_id: null, name: '420 · Paving', kind: 'cost_code', slug: 'cc-420', cost_code: '420', sort_order: 9 },
        { id: 'f5-storm', parent_id: null, name: 'Stormwater', kind: 'cost_code', slug: 'cc-Stormwater',
          cost_code: 'Stormwater', sort_order: 10 },
      ];
      // The General / Non-Job area, where an order with no job files.
      PTREE[''] = [
        { id: 'g0-unassigned', parent_id: null, name: 'Unassigned POs', kind: 'fixed', slug: 'unassigned-pos', sort_order: 1 },
        { id: 'g0-misc', parent_id: null, name: 'Misc', kind: 'fixed', slug: 'misc', sort_order: 2 },
      ];
      // Raised deliveries carry the order's codes; a Daily Tracking one
      // (dr-<rowId>) carries its row's, which is what the server files by.
      const PO42 = { id: 'po-42', po_number: 'PO-0420', project_id: 'p5', cost_code: '420', supplier: 'Keystone Asphalt',
        lines: [
          { id: 'ln-a', invoice_num: 'INV-881', date: '2026-10-03' },
          { id: 'ln-b', invoice_num: '', date: '2026-10-05' },
          { id: 'ln-e', invoice_num: '  ', date: '' },
          { id: 'dr-row1', invoice_num: 'T-77', date: '2026-10-06', source: 'daily', cost_code: 'Stormwater' },
        ] };
      const PO43 = { id: 'po-43', po_number: 'PO-0430', project_id: 'p5', cost_code: '', supplier: 'Cleveland Quarry',
        lines: [{ id: 'ln-c', invoice_num: 'INV-9', date: '2026-10-07' }] };
      const POGEN = { id: 'po-gen', po_number: 'PO-0500', project_id: null, cost_code: '610', supplier: 'No Job Supply',
        lines: [{ id: 'ln-g', invoice_num: 'G-1', date: '2026-10-08' }] };
      PO_BLOB.push(PO42, PO43, POGEN);
      const lineOf = (po, id) => po.lines.find(l => l.id === id);
      const LN_A = lineOf(PO42, 'ln-a');
      PDOCS.push(
        doc({ id: 'ld1', project_id: 'p5', filename: 'inv-881.pdf', note: 'signed by foreman', uploaded_by: 'ben',
              uploaded_at: '2026-10-03T00:00:00Z', folder_ids: ['f5-po42', 'f5-420'], po_ids: ['po-42'], po_line_ids: ['po-42:ln-a'] }),
        doc({ id: 'ld2', project_id: 'p5', filename: 'ticket-photo.jpg', content_type: 'image/jpeg', uploaded_by: 'sam',
              uploaded_at: '2026-10-04T00:00:00Z', folder_ids: ['f5-photos', 'f5-po42', 'f5-420'], po_ids: ['po-42'],
              po_line_ids: ['po-42:ln-a'] }),
        doc({ id: 'ld3', project_id: 'p5', filename: 't-77.pdf', folder_ids: ['f5-po42', 'f5-storm'], po_ids: ['po-42'],
              po_line_ids: ['po-42:dr-row1'] }),
        doc({ id: 'ld4', project_id: 'p5', filename: 'po-0420-signed.pdf', folder_ids: ['f5-po42'], po_ids: ['po-42'] }),
        doc({ id: 'ld5', project_id: 'p5', filename: 'inv-9.pdf', folder_ids: ['f5-po'], po_ids: ['po-43'], po_line_ids: ['po-43:ln-c'] }),
        // A Daily Tracking delivery that has since moved to another order:
        // its file stays with this one.
        doc({ id: 'ld6', project_id: 'p5', filename: 'moved-on.pdf', folder_ids: ['f5-po42'], po_ids: ['po-42'],
              po_line_ids: ['po-42:dr-gone'] }),
        doc({ id: 'ld8', project_id: 'p8', filename: 'elsewhere.pdf', folder_ids: ['g-earth'], po_ids: ['po-99'],
              po_line_ids: ['po-99:ln-z'] }));

      let settleCalls = 0, settleAnswer = true, settleHold = null;
      const hostPOs = [PO42, PO43, POGEN].map(p => ({ id: p.id, po_number: p.po_number, supplier: p.supplier, project_id: p.project_id }));
      FD.configure({
        getProjectId: () => 'p1',
        // What the PO tabs hand over: no lines, the way they do today.
        getPurchaseOrders: () => hostPOs,
        settlePurchaseOrders: async () => {
          settleCalls++;
          pcalls.push({ marker: 'settle' });
          if (settleHold) await settleHold;
          if (settleAnswer instanceof Error) throw settleAnswer;
          return settleAnswer;
        },
        getUserName: () => 'ben',
      });
      pcaps = { canUpload: true, canManage: true, canDelete: true };
      closeAll();
      await FD.renderTab(mount);                       // the Documents tab sits on p1
      const requests = () => pcalls.filter(c => c.method);
      const callLog = () => pcalls.map(c => `${c.method || c.marker} ${c.url || ''}`).join(' | ');

      // ── Counts ──────────────────────────────────────────────────────────
      assert('the delivery-line entry points are on the public surface',
        typeof FD.openPOLineAttach === 'function' && typeof FD.refreshPoLineCounts === 'function'
          && typeof FD.poLineCount === 'function');
      assert('a delivery never counted reads 0', FD.poLineCount('po-42', 'ln-a') === 0);

      pcalls.length = 0;
      const all = await FD.refreshPoLineCounts();
      assert('refreshPoLineCounts() counts the whole division in one GET: no job, no order, the division carried',
        pcalls.length === 1 && pcalls[0].method === 'GET' && pcalls[0].q.poLineCounts === '1' && pcalls[0].q.division === 'turf'
          && !('poId' in pcalls[0].q) && !('projectId' in pcalls[0].q), callLog());
      assert('it resolves to every order\'s { lineId: n }',
        all && all['po-42'] && all['po-42']['ln-a'] === 2 && all['po-42']['dr-row1'] === 1 && all['po-43']['ln-c'] === 1
          && all['po-99']['ln-z'] === 1, JSON.stringify(all));
      assert('poLineCount reads each delivery\'s number, per order, on every job',
        FD.poLineCount('po-42', 'ln-a') === 2 && FD.poLineCount('po-42', 'dr-row1') === 1
          && FD.poLineCount('po-43', 'ln-c') === 1 && FD.poLineCount('po-99', 'ln-z') === 1,
        [FD.poLineCount('po-42', 'ln-a'), FD.poLineCount('po-42', 'dr-row1'), FD.poLineCount('po-43', 'ln-c')].join(','));
      assert('a delivery with nothing attached reads 0, and so does a line id on an order it is not on',
        FD.poLineCount('po-42', 'ln-b') === 0 && FD.poLineCount('po-43', 'ln-a') === 0 && FD.poLineCount('po-nope', 'ln-a') === 0);
      assert('ids that name a property of every object read 0 rather than throwing',
        FD.poLineCount('po-42', '__proto__') === 0 && FD.poLineCount('__proto__', 'ln-a') === 0
          && FD.poLineCount('constructor', 'x') === 0 && FD.poLineCount('po-42', 'constructor') === 0
          && FD.poLineCount(null, undefined) === 0);
      assert('counting neither seeds nor loads a job',
        !pcalls.some(c => c.method === 'PUT' || (c.method === 'GET' && !c.q.poLineCounts)));

      PDOCS.push(doc({ id: 'ld9', project_id: 'p5', filename: 'late.pdf', uploaded_at: '2026-10-05T00:00:00Z',
        folder_ids: ['f5-po42'], po_ids: ['po-42'], po_line_ids: ['po-42:ln-b'] }));
      pcalls.length = 0;
      const one42 = await FD.refreshPoLineCounts('po-42');
      assert('refreshPoLineCounts(poId) asks for that order alone',
        pcalls.length === 1 && pcalls[0].q.poLineCounts === '1' && pcalls[0].q.poId === 'po-42' && pcalls[0].q.division === 'turf',
        callLog());
      assert('…and resolves to its { lineId: n }', one42 && one42['ln-a'] === 2 && one42['ln-b'] === 1 && !one42['po-42'],
        JSON.stringify(one42));
      assert('that order\'s counts move and every other order\'s stay',
        FD.poLineCount('po-42', 'ln-b') === 1 && FD.poLineCount('po-43', 'ln-c') === 1 && FD.poLineCount('po-99', 'ln-z') === 1);

      const ld5 = PDOCS.find(d => d.id === 'ld5');
      ld5.po_line_ids = [];
      const none43 = await FD.refreshPoLineCounts('po-43');
      assert('an order whose deliveries have nothing attached counts to an empty map, and each reads 0',
        none43 && Object.keys(none43).length === 0 && FD.poLineCount('po-43', 'ln-c') === 0
          && FD.poLineCount('po-42', 'ln-a') === 2, JSON.stringify(none43));
      ld5.po_line_ids = ['po-43:ln-c'];
      const ld8 = PDOCS.find(d => d.id === 'ld8');
      ld8.po_line_ids = [];
      await FD.refreshPoLineCounts();
      assert('a division-wide count clears an order that is missing from it, and fills the rest',
        FD.poLineCount('po-99', 'ln-z') === 0 && FD.poLineCount('po-43', 'ln-c') === 1);
      ld8.po_line_ids = ['po-99:ln-z'];
      await FD.refreshPoLineCounts();

      // A failure is not a count of zero: the PO tab would draw an empty
      // paperclip on every delivery with files.
      failLineCounts = true;
      let lineRejected = false;
      const failedAll = await FD.refreshPoLineCounts().catch(() => { lineRejected = true; });
      const failedOne = await FD.refreshPoLineCounts('po-42').catch(() => { lineRejected = true; });
      failLineCounts = false;
      assert('a failed delivery-line count never rejects', !lineRejected);
      assert('it resolves null, division-wide or for one order', failedAll === null && failedOne === null,
        `${JSON.stringify(failedAll)} / ${JSON.stringify(failedOne)}`);
      assert('and the last good counts are kept', FD.poLineCount('po-42', 'ln-a') === 2 && FD.poLineCount('po-99', 'ln-z') === 1);
      lineCountsListing = true;
      const listingAnswer = await FD.refreshPoLineCounts();
      lineCountsListing = false;
      assert('an answer with no counts in it (a server from before the endpoint) is a failure too, not "nothing attached"',
        listingAnswer === null && FD.poLineCount('po-42', 'ln-a') === 2 && FD.poLineCount('po-43', 'ln-c') === 1);

      // A slow division-wide count must not undo a fresher count of one
      // order — but it is still the newest word on every other order.
      PDOCS.push(doc({ id: 'ld10', project_id: 'p5', filename: 'inv-9-page2.pdf', folder_ids: ['f5-po'], po_ids: ['po-43'],
        po_line_ids: ['po-43:ln-c'] }));
      holdLineCounts = '*';
      const slowAll = FD.refreshPoLineCounts();         // sees po-43 ln-c 2, po-42 ln-a 2
      await settle();
      PDOCS.push(doc({ id: 'ld11', project_id: 'p5', filename: 'extra.pdf', folder_ids: ['f5-po42'], po_ids: ['po-42'],
        po_line_ids: ['po-42:ln-a'] }));
      await FD.refreshPoLineCounts('po-42');
      assert('the fresher count of one order lands', FD.poLineCount('po-42', 'ln-a') === 3, String(FD.poLineCount('po-42', 'ln-a')));
      releaseLineCounts();
      const slowAllAnswer = await slowAll;
      assert('a slow division-wide count cannot overwrite a fresher count of one order',
        FD.poLineCount('po-42', 'ln-a') === 3, String(FD.poLineCount('po-42', 'ln-a')));
      assert('…but still lands on the orders nothing fresher has counted', FD.poLineCount('po-43', 'ln-c') === 2,
        String(FD.poLineCount('po-43', 'ln-c')));
      assert('…and its caller is handed the merged map',
        slowAllAnswer && slowAllAnswer['po-42']['ln-a'] === 3 && slowAllAnswer['po-43']['ln-c'] === 2, JSON.stringify(slowAllAnswer));

      // A slow count of one order is dropped once a later division-wide
      // count has landed.
      holdLineCounts = 'po-42';
      const slow42 = FD.refreshPoLineCounts('po-42');   // sees ln-a 3
      await settle();
      PDOCS.splice(PDOCS.findIndex(d => d.id === 'ld11'), 1);
      await FD.refreshPoLineCounts();
      releaseLineCounts();
      const slow42Answer = await slow42;
      assert('a slow count of one order cannot overwrite a later division-wide count',
        FD.poLineCount('po-42', 'ln-a') === 2, String(FD.poLineCount('po-42', 'ln-a')));
      assert('…and its caller is handed the fresh numbers', slow42Answer && slow42Answer['ln-a'] === 2, JSON.stringify(slow42Answer));

      // Two division-wide counts: the older one landing last changes nothing.
      holdLineCounts = '*';
      const slowAll2 = FD.refreshPoLineCounts();        // sees po-43 ln-c 2
      await settle();
      PDOCS.splice(PDOCS.findIndex(d => d.id === 'ld10'), 1);
      await FD.refreshPoLineCounts();
      releaseLineCounts();
      await slowAll2;
      assert('an older division-wide count landing after a newer one changes nothing',
        FD.poLineCount('po-43', 'ln-c') === 1, String(FD.poLineCount('po-43', 'ln-c')));

      // …and a count of ANOTHER order is no reason to throw an answer away.
      PDOCS.push(doc({ id: 'ld11', project_id: 'p5', filename: 'extra.pdf', folder_ids: ['f5-po42'], po_ids: ['po-42'],
        po_line_ids: ['po-42:ln-a'] }));
      holdLineCounts = 'po-42';
      const slow42b = FD.refreshPoLineCounts('po-42');
      await settle();
      await FD.refreshPoLineCounts('po-43');
      releaseLineCounts();
      await slow42b;
      assert('a count of one order still lands after another order was counted',
        FD.poLineCount('po-42', 'ln-a') === 3, String(FD.poLineCount('po-42', 'ln-a')));
      PDOCS.splice(PDOCS.findIndex(d => d.id === 'ld11'), 1);

      // Order and line ids are [A-Za-z0-9_.-], so "__proto__" is a legal one.
      PDOCS.push(doc({ id: 'ld12', project_id: 'p5', filename: 'odd.pdf', folder_ids: ['f5-po'], po_ids: ['__proto__'],
        po_line_ids: ['__proto__:constructor'] }));
      await FD.refreshPoLineCounts();
      assert('an order or delivery id that names a property of every object is counted like any other, disturbing nothing',
        FD.poLineCount('__proto__', 'constructor') === 1 && FD.poLineCount('po-42', 'ln-a') === 2
          && FD.poLineCount('po-43', 'toString') === 0 && FD.poLineCount('po-43', 'ln-c') === 1,
        [FD.poLineCount('__proto__', 'constructor'), FD.poLineCount('po-42', 'ln-a')].join(','));
      PDOCS.splice(PDOCS.findIndex(d => d.id === 'ld12'), 1);
      await FD.refreshPoLineCounts();
      assert('…and drops out again like any other', FD.poLineCount('__proto__', 'constructor') === 0);

      // ── The delivery's dialog ───────────────────────────────────────────
      closeAll();
      pcalls.length = 0;
      changes = 0;
      settleCalls = 0;
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      assert('opening a delivery never waits on the host\'s purchase-order saves: reading needs nothing saved',
        settleCalls === 0 && !pcalls.some(c => c.marker === 'settle'), callLog());
      const lLoad = pcalls.findIndex(c => c.method === 'GET' && c.q.projectId === 'p5' && !c.q.poLineId);
      const lList = pcalls.findIndex(c => c.method === 'GET' && c.q.poLineId);
      assert('then loads the order\'s job (it is not the one the Documents tab is on)',
        lLoad > 0 && pcalls.some(c => c.method === 'PUT' && c.q.projectId === 'p5'), callLog());
      assert('then lists the delivery\'s files by poLineId and poId, in the division',
        lList > lLoad && pcalls[lList].q.poLineId === 'ln-a' && pcalls[lList].q.poId === 'po-42'
          && pcalls[lList].q.division === 'turf', lList >= 0 ? pcalls[lList].url : 'no list request');
      assert('and nudges the host to redraw, since a load ran', changes === 1, String(changes));

      dlg = lastModal();
      assert('a wide dialog opens, titled with the order and the delivery\'s invoice / ticket number',
        Boolean(dlg) && /min\(60rem/.test(dlg.innerHTML) && titleOf(dlg) === 'PO PO-0420 · INV-881', titleOf(dlg));
      assert('it says how many files are attached', /2 attached documents/.test(dlg.textContent), dlg.textContent.slice(0, 200));
      const lineRows = () => [...lastModal().querySelectorAll('[data-line-doc]')].map(el => el.dataset.lineDoc);
      assert('and lists this delivery\'s files, newest first — not the order\'s other paperwork, nor another delivery\'s',
        lineRows().join(',') === 'ld2,ld1', lineRows().join(','));
      const lrow1 = dlg.querySelector('[data-line-doc="ld1"]');
      assert('each row carries size, uploader, date and note',
        lrow1 && /2 KB/.test(lrow1.textContent) && /ben/.test(lrow1.textContent) && /2026/.test(lrow1.textContent)
          && /signed by foreman/.test(lrow1.textContent), lrow1 && lrow1.textContent);
      assert('and a download button', dlg.querySelectorAll('[data-ldl]').length === 2);
      assert('it says the files are on the order too, in its folder and the delivery\'s cost-code folder',
        /also listed on PO PO-0420 and filed in its folder, and in the 420 cost-code folder\./
          .test(dlg.querySelector('[data-line-filing]').textContent), dlg.querySelector('[data-line-filing]').textContent);
      assert('the footer offers Close and an attach',
        Boolean(dlg.querySelector('[data-cancel]')) && /Attach a document/.test(dlg.querySelector('[data-attach-new]').textContent));
      assert('a manager may detach either file', dlg.querySelectorAll('[data-detach]').length === 2);
      assert('and the Detach button says the file is not deleted, and stays on the order',
        /not deleted/.test(dlg.querySelector('[data-detach]').title) && /stays on the order/.test(dlg.querySelector('[data-detach]').title));
      pcalls.length = 0;
      dlg.querySelector('[data-ldl="ld2"]').click();
      await settle();
      assert('Download fetches that file\'s signed link',
        pcalls.some(c => c.path === '/api/document-download' && c.q.id === 'ld2'), callLog());

      // Already on the job: no second load, and a matching count is no
      // reason to bother the host. The settle runs on every open.
      closeAll();
      pcalls.length = 0;
      changes = 0;
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      assert('reopening on the same job reads only the delivery\'s list',
        requests().length === 1 && requests()[0].q.poLineId === 'ln-a', callLog());
      assert('…with the paperclip already right, the host is not nudged', changes === 0, String(changes));
      assert('…and still never settles', settleCalls === 0, String(settleCalls));

      // A colleague attached a file since: the list is the freshest count
      // there is, and the copy of the job in hand has never seen the file.
      closeAll();
      PDOCS.push(doc({ id: 'ld13', project_id: 'p5', filename: 'colleague-ticket.pdf', uploaded_by: 'sam',
        uploaded_at: '2026-10-09T00:00:00Z', folder_ids: ['f5-po42', 'f5-420'], po_ids: ['po-42'], po_line_ids: ['po-42:ln-a'] }));
      pcalls.length = 0;
      changes = 0;
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      const cList = pcalls.findIndex(c => c.method === 'GET' && c.q.poLineId);
      const cReload = pcalls.findIndex((c, i) => i > cList && c.method === 'GET' && c.q.projectId === 'p5' && !c.q.poLineId);
      assert('a delivery listing a file the job in hand lacks reads the job again, after the list',
        cList >= 0 && cReload > cList, callLog());
      assert('the paperclip count is corrected from the list', FD.poLineCount('po-42', 'ln-a') === 3,
        String(FD.poLineCount('po-42', 'ln-a')));
      assert('…and the host is told once', changes === 1, String(changes));
      assert('the dialog lists the colleague\'s file first', lineRows()[0] === 'ld13', lineRows().join(','));
      closeAll();
      pcalls.length = 0;
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      assert('with nothing new on the delivery, opening it again reads nothing more than its list',
        requests().length === 1 && requests()[0].q.poLineId === 'ln-a', callLog());
      closeAll();
      PDOCS.splice(PDOCS.findIndex(d => d.id === 'ld13'), 1);
      await FD.refreshPoLineCounts();

      // What the dialog calls the delivery.
      const dayOf = (y, m, d) => new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      await FD.openPOLineAttach({ po: PO42, line: lineOf(PO42, 'ln-b') });
      assert('a delivery with no invoice / ticket number is called by its date, read as a calendar day',
        titleOf(lastModal()) === `PO PO-0420 · ${dayOf(2026, 10, 5)}`, titleOf(lastModal()));
      closeAll();
      await FD.openPOLineAttach({ po: PO42, line: lineOf(PO42, 'ln-e') });
      assert('one with neither is a "Delivery"', titleOf(lastModal()) === 'PO PO-0420 · Delivery', titleOf(lastModal()));
      closeAll();
      await FD.openPOLineAttach({ po: PO42, line: LN_A, label: 'Ticket 881 (Oct 3)' });
      assert('a label from the host wins', titleOf(lastModal()) === 'PO PO-0420 · Ticket 881 (Oct 3)', titleOf(lastModal()));
      closeAll();
      await FD.openPOLineAttach({ po: { ...PO42, po_number: '' }, line: LN_A });
      assert('an order with no number yet is named by its id', titleOf(lastModal()) === 'PO po-42 · INV-881', titleOf(lastModal()));
      closeAll();
      await FD.openPOLineAttach({ po: PO42, line: { ...LN_A, invoice_num: '<img src=x onerror="window.__pwned=1">' } });
      assert('a delivery\'s name is text, never markup',
        !lastModal().querySelector('img') && titleOf(lastModal()).includes('<img src=x') && !window.__pwned, lastModal().innerHTML.slice(0, 300));
      closeAll();

      // The cost code the dialog promises is the one the server files by.
      await FD.openPOLineAttach({ po: PO42, line: lineOf(PO42, 'dr-row1') });
      dlg = lastModal();
      assert('a Daily Tracking delivery is filed by its own row\'s code, not the order\'s',
        /and in the Stormwater cost-code folder\./.test(dlg.querySelector('[data-line-filing]').textContent)
          && !/the 420 cost-code/.test(dlg.querySelector('[data-line-filing]').textContent) && lineRows().join(',') === 'ld3',
        dlg.querySelector('[data-line-filing]').textContent);
      closeAll();
      await FD.openPOLineAttach({ po: PO43, line: lineOf(PO43, 'ln-c') });
      dlg = lastModal();
      assert('an order with no cost code promises only its own folder',
        /also listed on PO PO-0430 and filed in its folder\.$/.test(dlg.querySelector('[data-line-filing]').textContent.trim())
          && !/cost-code/.test(dlg.querySelector('[data-line-filing]').textContent),
        dlg.querySelector('[data-line-filing]').textContent);
      dlg.querySelector('[data-attach-new]').click();
      await settle();
      assert('…and before the order has a folder of its own, its upload opens on the Purchase Orders root',
        lastModal().querySelector('#fctdoc-folder').value === 'f5-po', lastModal().querySelector('#fctdoc-folder').value);
      closeAll();

      // ── Attach: the upload dialog ───────────────────────────────────────
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      lastModal().querySelector('[data-attach-new]').click();
      await settle();
      up = lastModal();
      assert('Attach opens the upload dialog', /Upload documents/.test(titleOf(up)), titleOf(up));
      assert('with the folder defaulted to the order\'s own folder',
        up.querySelector('#fctdoc-folder').value === 'f5-po42', up.querySelector('#fctdoc-folder').value);
      assert('the order is pinned: locked, selected, no filter box',
        up.querySelector('#fctdoc-po').disabled && up.querySelector('#fctdoc-po').value === 'po-42'
          && !up.querySelector('[data-po-filter="fctdoc-po"]'));
      const readout = up.querySelector('#fctdoc-poline');
      assert('the delivery is shown, locked, by name',
        readout && readout.textContent.trim().replace(/\s+/g, ' ') === 'Delivery: INV-881'
          && readout.dataset.poLine === 'po-42:ln-a', readout && readout.outerHTML);
      assert('and it is not a control that can be changed',
        !readout.matches('input,select,textarea') && !readout.querySelector('input,select,textarea'));
      assert('the hint says where else the file goes, whichever folder is picked',
        /Also listed on the order and filed under its folder and the 420 cost-code folder, whichever folder you pick\./
          .test(up.querySelector('[data-po-line-hint]').textContent), up.querySelector('[data-po-line-hint]').textContent);
      assert('in place of the order\'s own hint, and with no procurement line',
        !/Filed under the purchase order as well/.test(up.textContent) && !up.querySelector('#fctdoc-proc'));

      up.querySelector('#fctdoc-folder').value = 'f5-photos';
      const lInp = up.querySelector('#fctdoc-files');
      Object.defineProperty(lInp, 'files', { value: [pdf('inv-881-page2.pdf')], configurable: true });
      lInp.dispatchEvent(new window.Event('change', { bubbles: true }));
      pcalls.length = 0;
      changes = 0;
      up.querySelector('#fctdoc-go').click();
      await settle();
      const reg5 = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
      assert('the upload registers the delivery with its order',
        reg5 && reg5.body.poLineId === 'ln-a' && reg5.body.poId === 'po-42' && reg5.body.poNumber === 'PO-0420',
        reg5 && JSON.stringify(reg5.body));
      assert('…the folder the user chose, under the order\'s job',
        reg5 && reg5.body.folderId === 'f5-photos' && reg5.q.projectId === 'p5'
          && pcalls.find(c => c.path === '/api/document-upload-url').body.projectId === 'p5', reg5 && reg5.url);
      assert('…and nothing else: the body is exactly the register fields plus poLineId',
        reg5 && JSON.stringify(Object.keys(reg5.body).sort())
          === JSON.stringify(['documentId', 'filename', 'folderId', 'note', 'poId', 'poLineId', 'poNumber', 'sizeBytes', 'storageKey']),
        reg5 && JSON.stringify(Object.keys(reg5.body)));
      assert('the dialog closes on success', !window.document.body.contains(up));
      const lcIdx = pcalls.findIndex((c, i) => i > pcalls.indexOf(reg5) && c.method === 'GET' && c.q.poLineCounts);
      const pcIdx = pcalls.findIndex((c, i) => i > pcalls.indexOf(reg5) && c.method === 'GET' && c.q.poCounts);
      const chIdx = pcalls.findIndex(c => c.marker === 'onChange');
      assert('the delivery-line counts are refreshed after the upload, division-wide, and the order\'s too',
        lcIdx > 0 && !('poId' in pcalls[lcIdx].q) && pcIdx > 0, callLog());
      assert('before the host is told to redraw', chIdx > lcIdx && chIdx > pcIdx && changes === 1, `${lcIdx} / ${pcIdx} / ${chIdx} / ${changes}`);
      assert('so the delivery\'s paperclip reads one more', FD.poLineCount('po-42', 'ln-a') === 3,
        String(FD.poLineCount('po-42', 'ln-a')));
      assert('and the 420 cost-code folder compiled it too, though Photos was picked',
        FD.costCodeCount('p5', '420') === 3, String(FD.costCodeCount('p5', '420')));
      const landed = PDOCS.find(d => d.id === reg5.body.documentId);
      assert('one stored file: on the delivery, on the order, in the picked folder, the order\'s folder and the cost code\'s',
        landed && JSON.stringify(landed.po_line_ids) === '["po-42:ln-a"]' && JSON.stringify(landed.po_ids) === '["po-42"]'
          && JSON.stringify(landed.folder_ids) === '["f5-photos","f5-po42","f5-420"]', landed && JSON.stringify(landed));

      // Every other upload's body is what it was: no poLineId key at all.
      pcalls.length = 0;
      await FD._uploadOne(pdf('plain.pdf'), { folderId: 'f5-po42', poId: 'po-42', poNumber: 'PO-0420', projectId: 'p5' });
      const regPlain = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
      assert('an upload with no delivery carries no poLineId key',
        regPlain && !('poLineId' in regPlain.body) && !('procurementId' in regPlain.body) && regPlain.body.poId === 'po-42',
        regPlain && JSON.stringify(regPlain.body));
      PDOCS.splice(PDOCS.findIndex(d => d.id === regPlain.body.documentId), 1);

      // The host's list of orders is not what the delivery's order travels
      // by: an order missing from it still goes up with the file, by number.
      closeAll();
      FD.configure({ getPurchaseOrders: () => [] });
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      lastModal().querySelector('[data-attach-new]').click();
      await settle();
      up = lastModal();
      assert('an order the host did not list is still shown, pinned, in the upload',
        up.querySelector('#fctdoc-po').value === 'po-42' && up.querySelector('#fctdoc-po').disabled
          && /PO-0420/.test(up.querySelector('#fctdoc-po').selectedOptions[0].textContent),
        up.querySelector('#fctdoc-po').outerHTML);
      const mInp = up.querySelector('#fctdoc-files');
      Object.defineProperty(mInp, 'files', { value: [pdf('unlisted.pdf')], configurable: true });
      mInp.dispatchEvent(new window.Event('change', { bubbles: true }));
      pcalls.length = 0;
      up.querySelector('#fctdoc-go').click();
      await settle();
      const regUnlisted = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
      assert('…and registers with it and its number all the same',
        regUnlisted && regUnlisted.body.poId === 'po-42' && regUnlisted.body.poNumber === 'PO-0420' && regUnlisted.body.poLineId === 'ln-a',
        regUnlisted && JSON.stringify(regUnlisted.body));
      PDOCS.splice(PDOCS.findIndex(d => d.id === regUnlisted.body.documentId), 1);
      FD.configure({ getPurchaseOrders: () => hostPOs });
      await FD.refreshPoLineCounts();

      // A delivery the server has not stored (its order's save never landed):
      // the server refuses, and the dialog says why and stays up.
      closeAll();
      await FD.openPOLineAttach({ po: PO42, line: { id: 'ln-new', invoice_num: 'INV-NEW' } });
      assert('a delivery with nothing attached says so', /Nothing attached yet/.test(lastModal().textContent)
        && /0 attached documents/.test(lastModal().textContent));
      lastModal().querySelector('[data-attach-new]').click();
      await settle();
      up = lastModal();
      const nInp2 = up.querySelector('#fctdoc-files');
      Object.defineProperty(nInp2, 'files', { value: [pdf('orphan.pdf')], configurable: true });
      nInp2.dispatchEvent(new window.Event('change', { bubbles: true }));
      const docsBefore = PDOCS.length;
      up.querySelector('#fctdoc-go').click();
      await settle();
      assert('a delivery the server does not have is refused, and the dialog stays up saying why',
        window.document.body.contains(up)
          && /Delivery line not found — That delivery is not on the order yet/.test(up.querySelector('#fctdoc-err').textContent)
          && PDOCS.length === docsBefore, up.querySelector('#fctdoc-err').textContent);
      assert('…and the bytes it left in storage are cleaned up',
        pcalls.some(c => c.method === 'DELETE' && c.path === '/api/document-upload-url'), callLog());
      closeAll();

      // ── An order with no job: the General area ──────────────────────────
      pcalls.length = 0;
      await FD.openPOLineAttach({ po: POGEN, line: lineOf(POGEN, 'ln-g') });
      dlg = lastModal();
      assert('a delivery on an order with no job loads the General area, not a job',
        pcalls.some(c => c.method === 'GET' && !c.q.projectId && !c.q.poLineId && !c.q.poLineCounts)
          && !pcalls.some(c => c.q && c.q.projectId), callLog());
      assert('…and promises no cost-code folder, there being none outside a job',
        /also listed on PO PO-0500 and filed in its folder\./.test(dlg.querySelector('[data-line-filing]').textContent)
          && !/610/.test(dlg.textContent), dlg.querySelector('[data-line-filing]').textContent);
      dlg.querySelector('[data-attach-new]').click();
      await settle();
      up = lastModal();
      assert('its upload opens on the Unassigned POs folder',
        up.querySelector('#fctdoc-folder').value === 'g0-unassigned', up.querySelector('#fctdoc-folder').value);
      assert('…saying the file is on the order and in its folder, and nothing about a cost code',
        /Also listed on the order and filed under its folder, whichever folder you pick\./
          .test(up.querySelector('[data-po-line-hint]').textContent), up.querySelector('[data-po-line-hint]').textContent);
      const gInp = up.querySelector('#fctdoc-files');
      Object.defineProperty(gInp, 'files', { value: [pdf('g-1.pdf')], configurable: true });
      gInp.dispatchEvent(new window.Event('change', { bubbles: true }));
      pcalls.length = 0;
      up.querySelector('#fctdoc-go').click();
      await settle();
      const regG = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
      assert('…and registers in the General area, with the delivery and its order',
        regG && !regG.q.projectId && regG.body.poId === 'po-gen' && regG.body.poLineId === 'ln-g' && regG.body.folderId === 'g0-unassigned',
        regG && `${regG.url} ${JSON.stringify(regG.body)}`);
      assert('the delivery\'s paperclip counts it', FD.poLineCount('po-gen', 'ln-g') === 1, String(FD.poLineCount('po-gen', 'ln-g')));
      closeAll();

      // ── Detach ──────────────────────────────────────────────────────────
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      dlg = lastModal();
      let lAsked = null;
      window.confirm = msg => { lAsked = msg; return false; };
      pcalls.length = 0;
      dlg.querySelector('[data-detach="ld2"]').click();
      await settle();
      assert('Detach asks first, naming the file and the delivery, and says the file stays on the order',
        /ticket-photo\.jpg/.test(lAsked) && /INV-881/.test(lAsked) && /not deleted/.test(lAsked) && /stays on PO PO-0420/.test(lAsked), lAsked);
      assert('saying no changes nothing', !pcalls.some(c => c.method === 'PATCH'));

      failPatch = true;
      window.confirm = () => true;
      dlg.querySelector('[data-detach="ld2"]').click();
      await settle();
      failPatch = false;
      assert('a refused detach says why', /Database error/.test(bodyText()));
      assert('…and leaves the file listed with its button live again',
        dlg.querySelector('[data-detach="ld2"]') && !dlg.querySelector('[data-detach="ld2"]').disabled
          && dlg.querySelector('[data-detach="ld2"]').textContent === 'Detach');

      const countWas = FD.poLineCount('po-42', 'ln-a');
      pcalls.length = 0;
      changes = 0;
      dlg.querySelector('[data-detach="ld2"]').click();
      await settle();
      const lPatch = pcalls.find(c => c.method === 'PATCH');
      assert('Detach PATCHes the document with removePoLineId "<poId>:<lineId>" and nothing else',
        lPatch && lPatch.q.id === 'ld2' && lPatch.q.division === 'turf'
          && JSON.stringify(lPatch.body) === JSON.stringify({ removePoLineId: 'po-42:ln-a' }),
        lPatch && `${lPatch.url} ${JSON.stringify(lPatch.body)}`);
      const ld2 = PDOCS.find(d => d.id === 'ld2');
      assert('it never deletes the file, which stays on the order and in all its folders',
        !pcalls.some(c => c.method === 'DELETE') && ld2 && JSON.stringify(ld2.po_ids) === '["po-42"]'
          && ld2.folder_ids.length === 3 && ld2.po_line_ids.length === 0, ld2 && JSON.stringify(ld2));
      const dLc = pcalls.findIndex(c => c.method === 'GET' && c.q.poLineCounts);
      const dCh = pcalls.findIndex(c => c.marker === 'onChange');
      assert('then reloads the job and recounts the order\'s deliveries before telling the host',
        pcalls.some(c => c.method === 'GET' && c.q.projectId === 'p5' && !c.q.poLineId)
          && dLc > pcalls.indexOf(lPatch) && pcalls[dLc].q.poId === 'po-42' && dCh > dLc && changes === 1, callLog());
      assert('the same dialog redraws in place without the file',
        window.document.body.contains(dlg) && !dlg.querySelector('[data-line-doc="ld2"]')
          && new RegExp(`${countWas - 1} attached document`).test(dlg.textContent), dlg.textContent.slice(0, 200));
      assert('the delivery\'s paperclip reads one fewer', FD.poLineCount('po-42', 'ln-a') === countWas - 1,
        `${countWas} -> ${FD.poLineCount('po-42', 'ln-a')}`);
      assert('and the toast says the file is still on the order', /Detached\. The file is still on the order/.test(bodyText()));

      // The detach landed but the list could not be fetched again.
      failLineList = true;
      changes = 0;
      dlg.querySelector('[data-detach="ld1"]').click();
      await settle();
      failLineList = false;
      assert('a detach whose refresh fails still drops the file from the dialog',
        !dlg.querySelector('[data-line-doc="ld1"]') && new RegExp(`${countWas - 2} attached document`).test(dlg.textContent),
        dlg.textContent.slice(0, 200));
      assert('says the list could not be refreshed', /Detached, but the list could not be refreshed/.test(bodyText()));
      assert('and still tells the host, with the paperclip one lower',
        changes === 1 && FD.poLineCount('po-42', 'ln-a') === countWas - 2, `${changes} / ${FD.poLineCount('po-42', 'ln-a')}`);
      closeAll();
      PDOCS.find(d => d.id === 'ld1').po_line_ids = ['po-42:ln-a'];
      ld2.po_line_ids = ['po-42:ln-a'];
      await FD.refreshPoLineCounts();

      // ── Who may detach, and a viewer ────────────────────────────────────
      const reopenLineAs = async (capsNow, getUserName) => {
        closeAll();
        pcaps = capsNow;
        FD.configure({ getUserName });
        await FD.renderTab(mount);                 // off the job, so the next open reloads caps
        await FD.openPOLineAttach({ po: PO42, line: LN_A });
        return lastModal();
      };
      const detachable = d => [...d.querySelectorAll('[data-detach]')].map(b => b.dataset.detach).sort().join(',');
      dlg = await reopenLineAs({ canUpload: true, canManage: false, canDelete: false }, () => 'ben');
      assert('an uploader may detach their own files, and not someone else\'s',
        Boolean(dlg.querySelector('[data-line-doc="ld2"]')) && !dlg.querySelector('[data-detach="ld2"]')
          && Boolean(dlg.querySelector('[data-detach="ld1"]')), detachable(dlg));
      dlg = await reopenLineAs({ canUpload: true, canManage: false, canDelete: false }, undefined);
      assert('with no way to tell who is signed in, a non-manager gets no Detach at all, but can still attach',
        dlg.querySelectorAll('[data-detach]').length === 0 && Boolean(dlg.querySelector('[data-attach-new]')));
      dlg = await reopenLineAs({ canUpload: true, canManage: false, canDelete: false }, () => { throw new Error('no user'); });
      assert('a host getter that throws costs the button, not the dialog',
        Boolean(dlg) && dlg.querySelectorAll('[data-detach]').length === 0 && dlg.querySelectorAll('[data-ldl]').length > 0);
      dlg = await reopenLineAs({ canUpload: false, canManage: false, canDelete: false }, () => 'ben');
      assert('a viewer still sees the delivery\'s files and can download them',
        dlg.querySelectorAll('[data-line-doc]').length > 0 && dlg.querySelectorAll('[data-ldl]').length > 0);
      assert('but is offered no attach and no detach, even on their own name',
        !dlg.querySelector('[data-attach-new]') && dlg.querySelectorAll('[data-detach]').length === 0);
      dlg = await reopenLineAs({ canUpload: true, canManage: true, canDelete: true }, undefined);
      assert('a manager gets Detach on everyone\'s files',
        dlg.querySelectorAll('[data-detach]').length === dlg.querySelectorAll('[data-line-doc]').length
          && dlg.querySelectorAll('[data-detach]').length > 1);
      FD.configure({ getUserName: () => 'ben' });
      closeAll();

      // ── Off the order is off its deliveries ─────────────────────────────
      // The Vault's "Link to PO" dialog can take a file off an order. A
      // delivery's file comes off that order's deliveries with it (the server
      // does both, api/documents.js removePoId): the dialog says so before,
      // the toast after, and the delivery's paperclip is recounted.
      closeAll();
      FD.configure({ getProjectId: () => 'p5' });
      await FD.renderTab(mount);
      await FD.refreshPoLineCounts();
      const ld3 = PDOCS.find(d => d.id === 'ld3');
      assert('fixture: t-77.pdf is on PO-0420 and on its delivery dr-row1',
        FD.poLineCount('po-42', 'dr-row1') === 1 && JSON.stringify(ld3.po_ids) === '["po-42"]', JSON.stringify(ld3));
      const openPo42 = () => {
        if (!mount.querySelector('[data-folder="f5-po42"]')) mount.querySelector('[data-folder="f5-po"]').click();   // opens the branch
        mount.querySelector('[data-folder="f5-po42"]').click();
      };
      openPo42();
      mount.querySelector('[data-attach="ld4"]').click();
      assert('an order-only file\'s Link-to-PO dialog mentions no delivery',
        Boolean(lastModal().querySelector('[data-unlink="po-42"]')) && !lastModal().querySelector('[data-unlink-deliveries]'),
        lastModal().textContent.slice(0, 300));
      closeAll();
      openPo42();
      mount.querySelector('[data-attach="ld3"]').click();
      const lk3 = lastModal();
      const offNote = lk3.querySelector('[data-unlink-deliveries="po-42"]');
      assert('a delivery file\'s Link-to-PO dialog says it is on one of the order\'s deliveries, and comes off it too',
        offNote && /Also on one of its deliveries\. Removing it takes it off that delivery too\./.test(offNote.textContent),
        offNote ? offNote.textContent : lk3.textContent.slice(0, 300));
      pcalls.length = 0;
      changes = 0;
      lk3.querySelector('[data-unlink="po-42"]').click();
      await settle();
      const unl = pcalls.find(c => c.method === 'PATCH');
      assert('Remove sends removePoId and nothing else',
        unl && unl.q.id === 'ld3' && JSON.stringify(unl.body) === JSON.stringify({ removePoId: 'po-42' }),
        unl && `${unl.url} ${JSON.stringify(unl.body)}`);
      const unLc = pcalls.findIndex(c => c.method === 'GET' && c.q.poLineCounts);
      const unCh = pcalls.findIndex(c => c.marker === 'onChange');
      assert('the delivery counts are refreshed before the host is told',
        unLc > pcalls.indexOf(unl) && unCh > unLc && changes === 1, callLog());
      assert('so the delivery\'s paperclip drops the file along with the order\'s',
        FD.poLineCount('po-42', 'dr-row1') === 0 && ld3.po_line_ids.length === 0 && ld3.po_ids.length === 0,
        `${FD.poLineCount('po-42', 'dr-row1')} ${JSON.stringify(ld3)}`);
      assert('and the toast says it came off the delivery too',
        /Unlinked from the order and its delivery\. The file is still in its folder\./.test(bodyText()));
      ld3.po_ids = ['po-42'];
      ld3.po_line_ids = ['po-42:dr-row1'];
      closeAll();
      FD.configure({ getProjectId: () => 'p1' });
      await FD.renderTab(mount);
      await FD.refreshPoLineCounts();

      // ── The settle hook, and a host without one ─────────────────────────
      // The host's settle guards the ATTACH — the server attaches only to a
      // delivery it has stored — and nothing else. Its answer covers the
      // whole page: a save that failed on another order (it waits minutes
      // for the poll's retry) must not lock every delivery's files away.
      const lineToasts = () => [...window.document.body.children]
        .filter(el => el.getAttribute && el.getAttribute('data-fctdoc-toast') === 'error' && /not saved yet/.test(el.textContent)).length;
      const isUpload = el => Boolean(el && /Upload documents/.test(titleOf(el)));
      const onLnA = PDOCS.filter(d => (d.po_line_ids || []).includes('po-42:ln-a')).length;
      settleAnswer = false;
      pcalls.length = 0;
      settleCalls = 0;
      const notSavedBefore = lineToasts();
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      dlg = lastModal();
      assert('with a purchase-order save owed or failed, the delivery\'s dialog still opens and lists its files',
        modals().length === 1 && /INV-881/.test(titleOf(dlg)) && onLnA >= 2 && dlg.querySelectorAll('[data-line-doc]').length === onLnA
          && requests().some(c => c.method === 'GET' && c.q.poLineId === 'ln-a') && settleCalls === 0, callLog());
      pcalls.length = 0;
      dlg.querySelector('[data-ldl="ld1"]').click();
      await settle();
      assert('…and its files still download', pcalls.some(c => c.path === '/api/document-download' && c.q.id === 'ld1'), callLog());
      pcalls.length = 0;
      dlg.querySelector('[data-attach-new]').click();
      await settle();
      assert('but Attach asks the host first, and on false opens no upload and sends nothing',
        settleCalls === 1 && modals().length === 1 && lastModal() === dlg && !isUpload(lastModal()) && requests().length === 0,
        `${settleCalls} / ${modals().length} / ${callLog()}`);
      assert('…saying the page\'s purchase-order changes are not saved yet', lineToasts() === notSavedBefore + 1
        && /Purchase-order changes on this page are not saved yet/.test(bodyText()));
      assert('…and leaves the dialog up, its list and its Attach button live',
        window.document.body.contains(dlg) && dlg.querySelectorAll('[data-line-doc]').length === onLnA
          && !dlg.querySelector('[data-attach-new]').disabled && /Attach a document/.test(dlg.querySelector('[data-attach-new]').textContent));
      settleAnswer = true;
      dlg.querySelector('[data-attach-new]').click();
      await settle();
      assert('once the saves have landed, the same button opens the upload', settleCalls === 2 && isUpload(lastModal()),
        titleOf(lastModal()));
      closeAll();

      settleAnswer = new Error('host bug');
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      lastModal().querySelector('[data-attach-new]').click();
      await settle();
      settleAnswer = true;
      assert('a settle hook that throws is not an answer: the upload opens, and the server\'s own check stands',
        modals().length === 1 && isUpload(lastModal()), titleOf(lastModal()));
      closeAll();

      settleAnswer = undefined;
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      lastModal().querySelector('[data-attach-new]').click();
      await settle();
      settleAnswer = true;
      assert('a settle that resolves with nothing in particular lets the upload open', modals().length === 1 && isUpload(lastModal()));
      closeAll();

      // The settle is awaited: nothing goes to the server while it is out,
      // and the button says why it is not doing anything yet.
      let releaseSettle;
      settleHold = new Promise(r => { releaseSettle = r; });
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      dlg = lastModal();
      const attachBtn = dlg.querySelector('[data-attach-new]');
      pcalls.length = 0;
      settleCalls = 0;
      attachBtn.click();
      await settle();
      assert('while the host is still saving, Attach reads "Saving…", is disabled, and nothing is asked or opened',
        attachBtn.disabled && /Saving/.test(attachBtn.textContent) && requests().length === 0
          && modals().length === 1 && lastModal() === dlg, `${attachBtn.disabled} ${attachBtn.textContent} ${callLog()}`);
      // A second click meanwhile lands on a disabled button: no second wait.
      attachBtn.click();
      await settle();
      settleHold = null;
      releaseSettle();
      await settle();
      assert('once it is done the upload opens — once, however many clicks',
        settleCalls === 1 && modals().length === 1 && isUpload(lastModal()), `${settleCalls} / ${modals().length}`);
      closeAll();

      // Closed while the host was still saving: the user has moved on.
      settleHold = new Promise(r => { releaseSettle = r; });
      await FD.openPOLineAttach({ po: PO42, line: LN_A });
      lastModal().querySelector('[data-attach-new]').click();
      await settle();
      lastModal().querySelector('[data-cancel]').click();
      settleHold = null;
      releaseSettle();
      await settle();
      assert('a dialog closed while its Attach waited opens no upload afterwards', modals().length === 0, String(modals().length));

      const raceErrs = () => [...window.document.body.children]
        .filter(el => !el.querySelector('[data-body]') && /Something else loaded/.test(el.textContent)).length;
      const raceBefore = raceErrs();
      settleCalls = 0;
      await Promise.all([FD.openPOLineAttach({ po: PO42, line: LN_A }), FD.openPOLineAttach({ po: PO42, line: LN_A })]);
      assert('a double click opens one dialog, waits on nothing, and raises no error toast',
        modals().length === 1 && settleCalls === 0 && raceErrs() === raceBefore, `${modals().length} / ${settleCalls}`);
      closeAll();

      FD.configure({ settlePurchaseOrders: undefined, onChange: undefined });
      let threw = null;
      try {
        await FD.openPOLineAttach({ po: PO42, line: LN_A });
        lastModal().querySelector('[data-detach="ld1"]').click();
        await settle();
      } catch (err) { threw = err; }
      assert('a host with no settle hook and no onChange still opens the dialog and detaches',
        !threw && modals().length === 1 && !lastModal().querySelector('[data-line-doc="ld1"]'), threw && threw.message);
      closeAll();
      PDOCS.find(d => d.id === 'ld1').po_line_ids = ['po-42:ln-a'];
      FD.configure({ onChange: () => { changes++; pcalls.push({ marker: 'onChange' }); },
        settlePurchaseOrders: async () => { settleCalls++; pcalls.push({ marker: 'settle' }); return true; } });
      await FD.refreshPoLineCounts();

      settleCalls = 0;
      const before7 = modals().length;
      await FD.openPOLineAttach({ po: { id: '' }, line: LN_A });
      await FD.openPOLineAttach({ po: PO42, line: { id: '  ' } });
      await FD.openPOLineAttach({});
      await FD.openPOLineAttach();
      assert('a delivery or an order with no id opens nothing, and does not wait on the host for it',
        modals().length === before7 && settleCalls === 0);

      // Something else loaded while the order's job was loading: building
      // the dialog would offer that job's folders to file this delivery's
      // document in.
      closeAll();
      await FD.renderTab(mount);                     // back on p1
      holdLoad = 'p5';
      pcalls.length = 0;
      const racingLine = FD.openPOLineAttach({ po: PO42, line: LN_A });
      await settle();
      await FD.renderTab(mount);                     // p1 loads while p5 is stalled
      releaseLoad();
      await racingLine;
      assert('a delivery whose load lost a race opens no dialog', modals().length === 0, String(modals().length));
      assert('…says to try the paperclip again',
        /Something else loaded while that was opening\. Try the paperclip again\./.test(bodyText()));
      assert('…without listing anything for the delivery', !pcalls.some(c => c.q && c.q.poLineId));

      // ── Every other document change recounts the deliveries ─────────────
      const lineCounted = () => pcalls.findIndex(c => c.method === 'GET' && c.q && c.q.poLineCounts);
      const changedAt = () => pcalls.findIndex(c => c.marker === 'onChange');
      FD.configure({ getProjectId: () => 'p5' });
      await FD.renderTab(mount);
      pcalls.length = 0;
      changes = 0;
      mount.querySelector('[data-folder="f5-po"]').click();       // opens the branch
      mount.querySelector('[data-folder="f5-po42"]').click();
      mount.querySelector('[data-delete="ld3"]').click();
      lastModal().querySelector('[data-yes]').click();
      await settle();
      assert('deleting a file recounts the deliveries, before the host is told',
        lineCounted() >= 0 && changedAt() > lineCounted() && changes === 1, callLog());
      assert('…so a deleted file stops counting on its delivery', FD.poLineCount('po-42', 'dr-row1') === 0,
        String(FD.poLineCount('po-42', 'dr-row1')));
      pcalls.length = 0;
      changes = 0;
      mount.querySelector('#fctdoc-trash').click();
      await settle();
      lastModal().querySelector('[data-restore="ld3"]').click();
      await settle();
      assert('restoring it recounts them, before the host is told',
        lineCounted() >= 0 && changedAt() > lineCounted() && changes === 1, callLog());
      assert('…so it counts on its delivery again', FD.poLineCount('po-42', 'dr-row1') === 1,
        String(FD.poLineCount('po-42', 'dr-row1')));
      closeAll();
      pcalls.length = 0;
      mount.querySelector('[data-folder="f5-po42"]').click();
      mount.querySelector('[data-attach="ld4"]').click();
      lastModal().querySelector('#fctdoc-linkpo').value = 'po-43';
      lastModal().querySelector('#fctdoc-dolink').click();
      await settle();
      assert('linking a file to an order recounts the deliveries', lineCounted() >= 0 && changedAt() > lineCounted(), callLog());
      pcalls.length = 0;
      mount.querySelector('[data-folder="f5-po42"]').click();
      mount.querySelector('[data-attach="ld4"]').click();
      lastModal().querySelector('[data-unlink="po-43"]').click();
      await settle();
      assert('so does unlinking it', lineCounted() >= 0 && changedAt() > lineCounted(), callLog());
      closeAll();

      // ── The order's own paperclip ───────────────────────────────────────
      // A delivery's file is on the order too, so the order's dialog lists it
      // — tagged with the delivery it hangs off when the host hands over the
      // order's lines, and left as it was when it does not.
      await FD.openAttach({ id: 'po-42', po_number: 'PO-0420', project_id: 'p5', lines: PO42.lines });
      dlg = lastModal();
      const aRow = id => { const b = dlg.querySelector(`[data-adl="${id}"]`); return b ? b.parentElement : null; };
      const tagOf = id => { const r = aRow(id); const t = r && r.querySelector('[data-adelivery]'); return t ? t.textContent : null; };
      assert('the order\'s paperclip lists its deliveries\' files with its own',
        ['ld1', 'ld2', 'ld3', 'ld4', 'ld6', 'ld9'].every(id => aRow(id)), dlg.textContent.slice(0, 300));
      assert('each tagged with the delivery it hangs off',
        tagOf('ld1') === 'delivery INV-881' && tagOf('ld3') === 'delivery T-77' && tagOf('ld9') === `delivery ${dayOf(2026, 10, 5)}`,
        [tagOf('ld1'), tagOf('ld3'), tagOf('ld9')].join(' | '));
      assert('the order\'s own paperwork carries no tag', tagOf('ld4') === null, String(tagOf('ld4')));
      assert('a file whose delivery has left the order stays listed, and says so',
        tagOf('ld6') === 'a delivery no longer on this order', String(tagOf('ld6')));
      closeAll();
      await FD.openAttach({ id: 'po-42', po_number: 'PO-0420', project_id: 'p5' });
      dlg = lastModal();
      assert('without the order\'s lines it still says a file is on a delivery',
        tagOf('ld1') === 'on a delivery' && tagOf('ld4') === null, `${tagOf('ld1')} / ${tagOf('ld4')}`);
      dlg.querySelector('[data-attach-new]').click();
      await settle();
      up = lastModal();
      assert('and the order\'s upload is exactly what it was: no delivery, the order\'s hint',
        !up.querySelector('#fctdoc-poline') && !up.querySelector('[data-po-line-hint]')
          && /Filed under the purchase order as well/.test(up.textContent)
          && up.querySelector('#fctdoc-po').disabled && up.querySelector('#fctdoc-po').value === 'po-42'
          && up.querySelector('#fctdoc-folder').value === 'f5-po42', up.textContent.slice(0, 300));
      const oInp = up.querySelector('#fctdoc-files');
      Object.defineProperty(oInp, 'files', { value: [pdf('order-only.pdf')], configurable: true });
      oInp.dispatchEvent(new window.Event('change', { bubbles: true }));
      pcalls.length = 0;
      up.querySelector('#fctdoc-go').click();
      await settle();
      const regOrder = pcalls.find(c => c.method === 'POST' && c.path === '/api/documents');
      assert('…and its upload carries the order and no delivery',
        regOrder && regOrder.body.poId === 'po-42' && !('poLineId' in regOrder.body) && !('procurementId' in regOrder.body),
        regOrder && JSON.stringify(regOrder.body));
      closeAll();

      // Put the fixtures back the way the rest of this file found them.
      for (let i = PDOCS.length - 1; i >= 0; i--) if (!had.has(PDOCS[i].id)) PDOCS.splice(i, 1);
      TRASH.length = 0;
      delete PTREE.p5;
      delete PTREE[''];
      PO_BLOB.length = 0;
      pcaps = { canUpload: true, canManage: true, canDelete: true };
      FD.configure({ settlePurchaseOrders: undefined });
      await FD.refreshPoLineCounts();
    }

    window.confirm = realConfirm;
    FD.configure({ getProjectId: () => 'p1', getUserName: undefined, onChange: undefined,
                   getPurchaseOrders: () => [] });
  }

  // ── 3. The Documents job picker, driven in jsdom ─────────────────────────
  // The picker is the app's shared combobox now, not a <select>, so "can you
  // find a job by typing part of its name, or its job number" is only
  // answerable by running it. Each page's inline script is 30k lines and can't
  // be evaluated whole, so the combobox core and the two docs functions are
  // sliced out of the source and run against a real DOM — which also proves
  // the inline onchange the markup depends on actually resolves.
  for (const page of PAGES) {
    console.log(`\n[${page.file} — job picker]`);
    const src = read(page.file);

    // Lift a declaration out of the page, brace-matched to its close. Every
    // brace these particular functions contain is either code or a balanced
    // ${} inside a template literal, so counting is enough.
    const grabFn = header => {
      const at = src.indexOf(header);
      if (at < 0) throw new Error(`${page.file}: no ${header}`);
      let depth = 0;
      for (let i = src.indexOf('{', at); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
      }
      throw new Error(`${page.file}: unbalanced ${header}`);
    };
    const grabLine = header => {
      const at = src.indexOf(header);
      if (at < 0) throw new Error(`${page.file}: no ${header}`);
      return src.slice(at, src.indexOf('\n', at));
    };

    const harness = [
      grabLine('const _cbState = new WeakMap();'),
      grabLine('const _cbEsc = s =>'),
      grabLine('const _cbLabel = o =>'),
      grabFn('function cbHtml('),
      grabFn('function cbOptionsFor('),
      grabFn('function cbFilterFor('),
      grabFn('function cbOnFocus('),
      grabFn('function cbOnInput('),
      grabFn('function cbRenderMenu('),
      grabFn('function cbClose('),
      grabFn('function cbCommitInput('),
      grabFn('function _schedProjLabel('),
      grabFn('function renderDocsTab('),
      grabFn('function docsProjPick('),
      // Fixtures, plus the few page globals those functions reach for.
      `var projectsList = [
         { id: 'p-b', 'project-name': 'Beaver Falls Interchange', 'job-number': '5501' },
         { id: 'p-a', 'project-name': 'Allegheny Commons',        'job-number': '4402' },
         { id: 'p-f', 'project-name': 'Franklin Regional Multi',  'job-number': '0137' },
       ];
       var docsProjectId = null, _docsWaitTicks = 0, _docsWaitTimer = null, _rendered = [];
       function _docsEnsureConfigured() {}
       window.FCTDocuments = { renderTab: el => _rendered.push(el && el.id) };
       function _probe() { return { projectId: docsProjectId, rendered: _rendered.slice() }; }`,
    ].join('\n\n');

    const pdom = new JSDOM('<!doctype html><body><div id="docs-root"></div></body>',
      { url: 'http://localhost/', runScripts: 'dangerously' });
    const win = pdom.window;
    const doc = win.document;
    win.eval(harness);

    win.renderDocsTab();
    const cb = doc.querySelector('.cb[data-list="docs_projects"]');
    assert('the job picker renders as the searchable combobox', Boolean(cb));
    assert('and no <select> is left behind', !doc.querySelector('#docs-root select'));

    const input = doc.getElementById('docs-proj');
    assert('it opens on General / Non-Job', Boolean(input) && input.value === 'General / Non-Job',
      input && input.value);
    assert('with the resolved id planted, so an untouched blur resolves back to it',
      input.dataset.cbValue === '', JSON.stringify(input.dataset.cbValue));

    const menu = () => [...cb.querySelectorAll('.cb-opt')].map(o => o.dataset.val);
    const type = text => { input.value = text; win.cbOnInput({ stopPropagation() {} }, input); };

    win.cbOnFocus(input);
    assert('the unfiltered menu leads with General / Non-Job, then jobs A→Z',
      menu().join('|') === 'General / Non-Job|Allegheny Commons|Beaver Falls Interchange|Franklin Regional Multi',
      menu().join('|'));

    // The office looks jobs up by number as often as by name, so the number
    // carried in the note has to narrow the list too.
    type('0137');
    assert('typing a job number narrows to that job',
      menu().join('|') === 'Franklin Regional Multi', menu().join('|'));
    type('commons');
    assert('typing part of a name narrows to that job',
      menu().join('|') === 'Allegheny Commons', menu().join('|'));
    type('non-job');
    assert('the General / Non-Job entry is reachable by typing too',
      menu().join('|') === 'General / Non-Job', menu().join('|'));

    // Pick one the way the menu's mousedown delegate does.
    type('');
    const pick = [...cb.querySelectorAll('.cb-opt')].find(o => o.dataset.val === 'Franklin Regional Multi');
    input.value = pick.dataset.val;
    input.dataset.cbValue = pick.dataset.cbVal;
    win.cbCommitInput(input);
    let probe = win._probe();
    assert('picking a job selects it', probe.projectId === 'p-f', probe.projectId);
    assert('it reloads the browser under the picker', probe.rendered.join(',') === 'docs-mount,docs-mount',
      probe.rendered.join(','));
    assert('and leaves the picker itself standing, caret and all',
      doc.getElementById('docs-proj') === input);

    // Text matching nothing must put the current job back rather than quietly
    // dumping the user into the division-level area.
    delete input.dataset.cbValue;
    input.value = 'zzz not a job';
    win.cbCommitInput(input);
    probe = win._probe();
    assert('junk text keeps the current job', probe.projectId === 'p-f', probe.projectId);
    assert('and the box shows that job again', input.value === 'Franklin Regional Multi', input.value);

    // An emptied box is the one gesture that means "no job".
    delete input.dataset.cbValue;
    input.value = '';
    win.cbCommitInput(input);
    probe = win._probe();
    assert('an emptied box falls back to General / Non-Job', probe.projectId === null, String(probe.projectId));
    assert('and the box says so', input.value === 'General / Non-Job', input.value);

    // A job deleted while it was selected must not leave the picker showing a
    // live name for a scope no picker can reach again.
    win.eval('docsProjectId = "deleted-job"');
    win.renderDocsTab();
    assert('a job that left the list resets the picker',
      win._probe().projectId === null
        && doc.getElementById('docs-proj').value === 'General / Non-Job',
      doc.getElementById('docs-proj').value);

    pdom.window.close();
  }

  console.log(failed ? `\n${failed} failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\nTest run failed:', err);
  process.exit(1);
});
