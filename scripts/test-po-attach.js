#!/usr/bin/env node
'use strict';
/**
 * Attaching a file to a purchase order, on a connection that drops.
 *
 * Run: node scripts/test-po-attach.js
 *
 * Attaching was hit-and-miss: every one of its requests had one chance, a
 * photo the browser could not decode ended the attempt, and a file with no
 * extension was refused. These run the page's OWN upload code — lifted out of
 * purchase-orders.html, not restated — against a stubbed fetch that fails the
 * way a jobsite connection does, and check what reaches the server.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');
const { requireFn, sliceSource, evalSlice } = require('./lib/fn-source');
const storage = require('../api/lib/storage');

const PAGE = fs.readFileSync(path.resolve(__dirname, '..', 'purchase-orders.html'), 'utf8');

let failed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail) console.error('      ' + String(detail).slice(0, 600));
};

const STORAGE_URL = 'https://store.example/bucket/FCT/paving/p1/doc/receipt.jpg?X-Amz-Signature=x';

/**
 * A sandbox holding the page's api() and its whole upload region, with fetch
 * replaced by `route`. Timers: the short ones — retry pauses, a deliberately
 * tiny timeout — fire on the next turn, and the long request timeouts never
 * do, so a run takes milliseconds and a test only times something out when it
 * asks to.
 */
function sandbox(route, { downscale } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const calls = [];
  const warnings = [];
  const ctx = vm.createContext({
    console: { log() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
    JSON, Promise, Math, Error, TypeError, Number, String, Object, Array,
    encodeURIComponent,
    Blob: dom.window.Blob,
    FileReader: dom.window.FileReader,
    AbortController,
    setTimeout: (fn, ms) => (ms >= 10000 ? 0 : setImmediate(fn)),
    clearTimeout: () => {},
    fetch: async (url, init) => {
      const method = (init && init.method) || 'GET';
      const call = { method, url, body: init && init.body, signal: init && init.signal };
      calls.push(call);
      const out = await route(call, calls);
      if (out instanceof Error) throw out;
      if (out === 'hang') {
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted.');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      const status = out.status || 200;
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(out.json || {}) };
    },
  });
  vm.runInContext(`
    const API_BASE = '/api';
    const fctToken = 'tok';
    let loggedOut = false;
    function logout() { loggedOut = true; }
    const docCounts = {};
    async function downscaleImage(file, maxEdge) { return __downscale(file, maxEdge); }
  `, ctx);
  ctx.__downscale = downscale || (async () => ({ blob: new dom.window.Blob(['small-jpeg'], { type: 'image/jpeg' }) }));
  evalSlice('async ' + requireFn(PAGE, 'api', 'purchase-orders.html'), ctx, 'api()');
  const region = sliceSource(PAGE, '/* ── Getting a file through on a jobsite connection',
    '/* ═══', 'the attach region', ['async function prepareAttachment', 'async function attachToPO']);
  evalSlice(region, ctx, 'the attach region');
  return { ctx, calls, warnings, dom, run: expr => vm.runInContext(expr, ctx) };
}

const netDown = () => new TypeError('Failed to fetch');
const PO = "({ id: 'po1', po_number: 'PO-0042', _division: 'paving', project_id: 'p1' })";

/** The four legs of a healthy attach, answered; `over` replaces any of them. */
function server(over = {}) {
  return (call, calls) => {
    const u = call.url;
    const n = calls.filter(c => c.method === call.method && c.url.split('?')[0] === u.split('?')[0]).length;
    const pick = (key, dflt) => (over[key] ? over[key](call, n) : dflt) ?? dflt;
    if (u.startsWith('https://store.example/')) return pick('storage', { status: 200 });
    if (call.method === 'PUT' && u.startsWith('/api/documents?')) {
      return pick('folders', { json: { folders: [{ id: 'f-root', slug: 'purchase-orders' }] } });
    }
    if (call.method === 'POST' && u.startsWith('/api/document-upload-url?')) {
      return pick('ticket', { json: {
        documentId: 'd1', storageKey: 'FCT/paving/p1/d1/receipt.jpg',
        uploadUrl: STORAGE_URL, contentType: 'image/jpeg',
      } });
    }
    if (call.method === 'PUT' && u.startsWith('/api/document-upload-url?')) return pick('relay', { json: { ok: true } });
    if (call.method === 'POST' && u.startsWith('/api/documents?')) return pick('register', { status: 201, json: {} });
    if (call.method === 'GET' && u.startsWith('/api/documents?')) return pick('list', { json: { documents: [] } });
    if (call.method === 'DELETE') return pick('cleanup', { json: { ok: true } });
    return { status: 404, json: { error: 'unrouted ' + call.method + ' ' + u } };
  };
}

const legs = calls => calls.map(c => c.method + ' ' + (c.url.startsWith('https://') ? 'STORAGE' : c.url.split('?')[0]));
const count = (calls, leg) => legs(calls).filter(l => l === leg).length;

async function attach(s, blobExpr = "new Blob(['x'.repeat(2000)], { type: 'image/jpeg' })") {
  try {
    await s.run(`attachToPO(${PO}, ${blobExpr}, 'receipt.jpg')`);
    return null;
  } catch (err) {
    return err;
  }
}

(async () => {

console.log('\n[a healthy attach]');
{
  const s = sandbox(server());
  const err = await attach(s);
  assert('lands', !err, err && err.message);
  assert('in four requests, in order',
    JSON.stringify(legs(s.calls)) === JSON.stringify([
      'PUT /api/documents', 'POST /api/document-upload-url', 'PUT STORAGE', 'POST /api/documents']),
    JSON.stringify(legs(s.calls)));
  assert('and counts on the paperclip', s.run('docCounts.po1') === 1);
}

console.log('\n[a dropped signal is retried, not reported]');
{
  const s = sandbox(server({ folders: (c, n) => (n === 1 ? netDown() : null) }));
  const err = await attach(s);
  assert('folder seeding that drops once still attaches', !err, err && err.message);
  assert('  by asking again', count(s.calls, 'PUT /api/documents') === 2);
}
{
  const s = sandbox(server({ ticket: (c, n) => (n < 3 ? { status: 503, json: { error: 'cold' } } : null) }));
  const err = await attach(s);
  assert('a ticket refused twice by a cold function still attaches', !err, err && err.message);
  assert('  on the third try', count(s.calls, 'POST /api/document-upload-url') === 3);
}
{
  const s = sandbox(server({ ticket: () => netDown() }));
  const err = await attach(s);
  assert('but three drops in a row is reported', err && /Failed to fetch/.test(err.message), err && err.message);
  assert('  after exactly three tries', count(s.calls, 'POST /api/document-upload-url') === 3);
}
{
  const s = sandbox(server({ ticket: () => ({ status: 400, json: { error: 'Files of that type cannot be uploaded.' } }) }));
  const err = await attach(s);
  assert('a refusal is an answer — it is not asked again',
    err && /cannot be uploaded/.test(err.message) && count(s.calls, 'POST /api/document-upload-url') === 1,
    err && err.message);
}

console.log('\n[the bytes]');
{
  const s = sandbox(server({ storage: () => netDown() }));
  const err = await attach(s);
  assert('a small file the bucket cannot be reached for goes through the relay', !err, err && err.message);
  const relay = s.calls.find(c => c.method === 'PUT' && c.url.startsWith('/api/document-upload-url?'));
  assert('  carrying its bytes and its order',
    relay && /poId=po1/.test(relay.url) && JSON.parse(relay.body).storageKey === 'FCT/paving/p1/d1/receipt.jpg' &&
    JSON.parse(relay.body).contentBase64.length > 0, relay && relay.body.slice(0, 200));
}
{
  const s = sandbox(server({ storage: () => netDown(), relay: (c, n) => (n === 1 ? netDown() : null) }));
  const err = await attach(s);
  assert('and a relay that drops once is tried again', !err && count(s.calls, 'PUT /api/document-upload-url') === 2,
    err ? err.message : JSON.stringify(legs(s.calls)));
}
{
  const s = sandbox(server({ storage: () => ({ status: 403 }) }));
  const err = await attach(s);
  assert('a store that answers "no" is not relayed — it would say the same',
    err && /Upload to storage failed \(403\)/.test(err.message) && count(s.calls, 'PUT /api/document-upload-url') === 0,
    err && err.message);
}
const BIG = "new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: 'application/pdf' })";
{
  const s = sandbox(server({ storage: (c, n) => (n < 3 ? netDown() : null) }));
  const err = await attach(s, BIG);
  assert('a file over the relay ceiling retries the direct road instead', !err, err && err.message);
  assert('  and never tries the relay, which would only refuse it',
    count(s.calls, 'PUT STORAGE') === 3 && count(s.calls, 'PUT /api/document-upload-url') === 0,
    JSON.stringify(legs(s.calls)));
}
{
  const s = sandbox(server({ storage: () => netDown() }));
  const err = await attach(s, BIG);
  assert('and when it cannot get through, says why in words',
    err && /3\.0 MB file/.test(err.message) && /stronger signal/.test(err.message) && /CORS/.test(err.message),
    err && err.message);
  assert('  having registered nothing', count(s.calls, 'POST /api/documents') === 0);
}
{
  const s = sandbox(server({ storage: (c, n) => (n === 1 ? 'hang' : null) }));
  // The storage timeout scales with the file and is far over the sandbox's
  // "never fires" line, so shrink it for this one run.
  s.run('transferTimeoutMs = () => 5;');
  const err = await attach(s);
  assert('an upload that goes quiet is ended and sent again, not left spinning',
    !err && count(s.calls, 'PUT /api/document-upload-url') === 1, err ? err.message : JSON.stringify(legs(s.calls)));
}

console.log('\n[registering, when the answer is lost]');
{
  // The POST landed; the reply did not. The order's list already holds it.
  const s = sandbox(server({
    register: () => netDown(),
    list: () => ({ json: { documents: [{ id: 'd1' }] } }),
  }));
  const err = await attach(s);
  assert('a register that landed without a reply is not reported as failed', !err, err && err.message);
  assert('  nor sent twice', count(s.calls, 'POST /api/documents') === 1);
  assert('  nor cleaned up', count(s.calls, 'DELETE /api/document-upload-url') === 0);
  const look = s.calls.find(c => c.method === 'GET');
  assert('  and the look names the order', look && /poId=po1/.test(look.url), look && look.url);
}
{
  const s = sandbox(server({ register: (c, n) => (n === 1 ? netDown() : null) }));
  const err = await attach(s);
  assert('one that really did not land is sent again', !err && count(s.calls, 'POST /api/documents') === 2,
    err ? err.message : JSON.stringify(legs(s.calls)));
}
{
  // The first attempt landed on the server but its answer was lost AND the
  // look found nothing yet; the retry is then told "already registered".
  let looks = 0;
  const s = sandbox(server({
    register: (c, n) => (n === 1 ? netDown() : { status: 409, json: { error: 'That document is already registered' } }),
    list: () => (++looks >= 2 ? { json: { documents: [{ id: 'd1' }] } } : null),
  }));
  const err = await attach(s);
  assert('"already registered" after a lost reply is checked, and is a success', !err, err && err.message);
}
{
  const s = sandbox(server({ register: () => ({ status: 404, json: { error: 'Folder not found' } }) }));
  const err = await attach(s);
  assert('a register the server refuses is reported', err && /Folder not found/.test(err.message), err && err.message);
  assert('  without asking again', count(s.calls, 'POST /api/documents') === 1);
  const del = s.calls.find(c => c.method === 'DELETE');
  assert('  and the stored bytes are cleaned up, for this order',
    del && /storageKey=FCT%2Fpaving%2Fp1%2Fd1%2Freceipt\.jpg/.test(del.url) && /poId=po1/.test(del.url), del && del.url);
  assert('  and nothing is counted on the paperclip', s.run('docCounts.po1') === undefined);
}
{
  const s = sandbox(server({ register: () => netDown() }));
  const err = await attach(s);
  assert('a register that never gets through is reported after three tries',
    err && count(s.calls, 'POST /api/documents') === 3 && count(s.calls, 'DELETE /api/document-upload-url') === 1,
    err ? JSON.stringify(legs(s.calls)) : 'no error');
}

console.log('\n[what api() reports]');
{
  const s = sandbox(() => 'hang');
  let err = null;
  try { await s.run("api('GET', '/x', undefined, { timeoutMs: 5 })"); } catch (e) { err = e; }
  assert('a request that goes quiet times out as a network failure',
    err && err.network === true && /timed out/.test(err.message), err && err.message);
}
{
  const s = sandbox(() => ({ status: 502, json: { error: 'Bad gateway' } }));
  let err = null;
  try { await s.run("api('GET', '/x')"); } catch (e) { err = e; }
  assert('an answered failure carries its status', err && err.status === 502 && !err.network, err && err.message);
}
{
  const s = sandbox(() => ({ status: 401 }));
  let err = null;
  try { await s.run("api('GET', '/x')"); } catch (e) { err = e; }
  assert('a signed-out answer is neither retried nor called a network failure',
    err && err.message === 'Signed out' && !err.network && !s.run('isTransient')(err) && s.run('loggedOut'),
    err && err.message);
}
{
  const s = sandbox(() => netDown());
  let err = null;
  try { await s.run("api('GET', '/x')"); } catch (e) { err = e; }
  assert('a request with no answer at all is marked a network failure', err && err.network === true);
}

console.log('\n[getting the file ready]');
{
  const s = sandbox(server(), { downscale: async () => { throw new Error('That file is not an image this browser can read'); } });
  s.ctx.__File = s.dom.window.File;
  const out = await s.run("prepareAttachment(new __File(['heic-bytes'], 'IMG_1234.HEIC', { type: 'image/heic' }))");
  assert('a photo the browser cannot decode goes up as it is', out && out.filename === 'IMG_1234.HEIC' && out.blob.size === 10,
    JSON.stringify(out && { filename: out.filename, size: out.blob && out.blob.size }));
  assert('  rather than failing the attach', s.warnings.some(w => /sending it as it is/.test(w)));
}
{
  const s = sandbox(server());
  s.ctx.__File = s.dom.window.File;
  const photo = await s.run("prepareAttachment(new __File(['raw'], 'IMG_9.jpeg', { type: 'image/jpeg' }))");
  assert('a photo that decodes is shrunk and sent as .jpg', photo.filename === 'IMG_9.jpg' && photo.blob.size === 10,
    photo.filename);
  const pdf = await s.run("prepareAttachment(new __File(['%PDF'], 'document', { type: 'application/pdf' }))");
  assert('a PDF with no extension is given one', pdf.filename === 'document.pdf', pdf.filename);
  const xlsx = await s.run("prepareAttachment(new __File(['x'], 'Quote 118.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))");
  assert('a spreadsheet is passed along untouched', xlsx.filename === 'Quote 118.xlsx');
  const odd = await s.run("prepareAttachment(new __File(['x'], '', { type: '' }))");
  assert('a nameless, typeless file still has a name for the server to refuse', odd.filename === 'file');
}

console.log('\n[the picker offers what the server takes]');
{
  const m = PAGE.match(/<input type="file" id="attach-capture"\s+accept="([^"]+)"/);
  const accept = m ? m[1].split(',') : [];
  const coveredByImageStar = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const missing = storage.allowedExtensions().filter(ext => !coveredByImageStar.includes(ext) && !accept.includes('.' + ext));
  assert('every file type the vault allows can be picked', m && accept.includes('image/*') && !missing.length,
    'missing: ' + missing.join(', '));
  const extra = accept.filter(a => a.startsWith('.') && !storage.allowedExtensions().includes(a.slice(1)));
  assert('and nothing it would refuse', !extra.length, extra.join(', '));

  const s = sandbox(server());
  const map = s.run('EXT_FOR_TYPE');
  const bad = Object.entries(map).filter(([type, ext]) => storage.mimeFor('f.' + ext) !== type && !(type === 'image/jpeg' && ext === 'jpg'));
  const offList = Object.values(map).filter(ext => !storage.allowedExtensions().includes(ext));
  assert('an extension supplied from a type is one the server takes, for that type', !bad.length && !offList.length,
    JSON.stringify(bad) + ' ' + offList.join(','));
}

console.log('\n[the attach sheet uses all of it]');
{
  const add = requireFn(PAGE, 'addAttachment', 'purchase-orders.html');
  assert('the paperclip sheet prepares the file before attaching it',
    /const \{ blob, filename \} = await prepareAttachment\(file\);\s*\n\s*await attachToPO\(po, blob, filename\);/.test(add), add);
  assert('and no longer lets a photo that will not decode end the attach',
    !/downscaleImage/.test(add));
}

console.log(`\n${failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'}`);
process.exit(failed ? 1 : 0);
})();
