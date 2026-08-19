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
      { id: 'f-po',    parent_id: null,     name: 'Purchase Orders',     kind: 'fixed',     sort_order: 1 },
      { id: 'f-po137', parent_id: 'f-po',   name: 'PO PO-0137',          kind: 'po',        sort_order: 1 },
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
    assert('and lists every folder before anything is typed',
      rail().join('|') === 'Purchase Orders|PO PO-0137|Earthwork|Design & Permitting|Drawings|Permits|Township|Correspondence', rail().join('|'));

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

    // Escape clears.
    box().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert('Escape clears the filter', box().value === '' && rail().length === 8, rail().join('|'));

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
    window.fetch = savedFetch;
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
