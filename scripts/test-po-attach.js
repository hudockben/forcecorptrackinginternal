#!/usr/bin/env node
'use strict';
/**
 * Attaching a file to a purchase order, on a connection that drops.
 *
 * Run: node scripts/test-po-attach.js
 *
 * Attaching was hit-and-miss: every one of its requests had one chance, a
 * photo the browser could not decode ended the attempt, and a file with no
 * usable extension was refused. These run the page's OWN upload code — lifted
 * out of purchase-orders.html, not restated — against a stubbed fetch and
 * XMLHttpRequest that fail the way a jobsite connection does, and check what
 * reaches the server.
 *
 * Time is virtual. A timer fires only when nothing else can move, so a retry
 * pause or a 45-second timeout costs nothing, a slow upload can run for ten
 * minutes in a millisecond — and a request that has NO timeout is caught as a
 * hang rather than quietly ending the run early with a pass.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');
const { requireFn, sliceSource, evalSlice } = require('./lib/fn-source');
const storage = require('../api/lib/storage');

const PAGE = fs.readFileSync(path.resolve(__dirname, '..', 'purchase-orders.html'), 'utf8');

let failed = 0;
let finished = false;
const assert = (msg, cond, detail) => {
  if (cond) { console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail) console.error('      ' + String(detail).slice(0, 600));
};

// A promise that never settles with nothing left on the event loop lets node
// exit — with code 0, before the summary — which reads as a pass.
process.on('beforeExit', () => {
  if (finished) return;
  console.error('\n  ✗ the run stopped part-way: something awaited a promise that never settled');
  process.exit(1);
});

const STORAGE_URL = 'https://store.example/bucket/FCT/paving/p1/d1/receipt.jpg?X-Amz-Signature=x';

/** Virtual timers: due times on a clock that only moves when told to. */
function makeClock() {
  let now = 1000000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { due: now + Math.max(0, Number(ms) || 0), fn, seq: id });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    fireNext() {
      let best = null;
      for (const [id, t] of timers) {
        if (!best || t.due < best.t.due || (t.due === best.t.due && t.seq < best.t.seq)) best = { id, t };
      }
      if (!best) return false;
      timers.delete(best.id);
      now = Math.max(now, best.t.due);
      best.t.fn();
      return true;
    },
  };
}

const realTick = ms => new Promise(r => setTimeout(r, ms));

/**
 * Settle `promise`, moving virtual time forward only when nothing else can
 * happen. Real async work (jsdom's FileReader) gets real time to finish. A
 * promise still pending with no timer left to fire is a hang, and says so.
 */
async function drive(clock, promise) {
  let state = 'pending', value, error;
  promise.then(v => { state = 'ok'; value = v; }, e => { state = 'err'; error = e; });
  for (let guard = 0; guard < 5000 && state === 'pending'; guard++) {
    await realTick(0);
    if (state !== 'pending') break;
    if (clock.fireNext()) continue;
    for (let waited = 0; state === 'pending' && !clock.pending() && waited < 400; waited += 5) await realTick(5);
    if (state === 'pending' && !clock.pending()) {
      throw new Error('HUNG: the request never settled and no timer is left to end it');
    }
  }
  if (state === 'pending') throw new Error('HUNG: still pending after 5000 timer firings');
  if (state === 'err') throw error;
  return value;
}

/**
 * A sandbox holding the page's api() and its whole attach region, with fetch
 * and XMLHttpRequest answered by `route`. A route returns { status, json }, an
 * Error (no answer at all), 'hang' (never answers), or for an XHR a
 * { progress: { every, steps, thenHang } } upload that moves in steps.
 */
function sandbox(route, { downscale } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const clock = makeClock();
  const calls = [];
  const warnings = [];

  class FakeXHR {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this._headers = {}; }
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader(k, v) { this._headers[k] = v; }
    abort() {
      if (this._finished) return;
      this._finished = true;
      this._aborted = true;
      if (this.onabort) this.onabort();
    }
    send(body) {
      const call = { method: this._method, url: this._url, body, headers: this._headers, via: 'xhr', at: clock.now() };
      calls.push(call);
      Promise.resolve().then(() => route(call, calls)).then(out => {
        if (this._finished) return;
        if (out instanceof Error) { this._finished = true; if (this.onerror) this.onerror(); return; }
        if (out === 'hang') return;
        const finish = () => {
          if (this._finished) return;
          this._finished = true;
          this.status = out.status || 200;
          this.responseText = JSON.stringify(out.json || {});
          if (this.onload) this.onload();
        };
        if (out.tail != null) {
          // What a real browser does on a slow uplink: upload progress leaps to
          // 100% as the body is handed to the OS buffer, then nothing at all
          // while that buffer drains — measured at over a minute in real Chrome.
          clock.setTimeout(() => {
            if (this._finished) return;
            if (this.upload.onprogress) this.upload.onprogress({});
            if (!out.tailHang) clock.setTimeout(finish, out.tail);
          }, 100);
          return;
        }
        if (!out.progress) { finish(); return; }
        let n = 0;
        const step = () => {
          if (this._finished) return;
          if (n++ >= out.progress.steps) { if (!out.progress.thenHang) finish(); return; }
          if (this.upload.onprogress) this.upload.onprogress({});
          clock.setTimeout(step, out.progress.every);
        };
        clock.setTimeout(step, out.progress.every);
      });
    }
  }

  const ctx = vm.createContext({
    console: { log() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
    JSON, Promise, Math, Error, TypeError, Number, String, Object, Array, Map, Boolean,
    encodeURIComponent,
    Date: { now: () => clock.now() },
    Blob: dom.window.Blob,
    File: dom.window.File,
    FileReader: dom.window.FileReader,
    AbortController,
    XMLHttpRequest: FakeXHR,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: id => clock.clearTimeout(id),
    fetch: async (url, init) => {
      const method = (init && init.method) || 'GET';
      const call = { method, url, body: init && init.body, signal: init && init.signal, via: 'fetch', at: clock.now() };
      calls.push(call);
      const out = await route(call, calls);
      if (out instanceof Error) throw out;
      if (out === 'hang') {
        // Never answers. Only an abort ends it — so a request sent WITHOUT a
        // signal hangs for good, and drive() reports it.
        return new Promise((_, reject) => {
          if (!init || !init.signal) return;
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
  return {
    ctx, calls, warnings, dom, clock,
    run: expr => vm.runInContext(expr, ctx),
    drive: expr => drive(clock, vm.runInContext(expr, ctx)),
  };
}

const netDown = () => new TypeError('Failed to fetch');
const PO = "({ id: 'po1', po_number: 'PO-0042', _division: 'paving', project_id: 'p1' })";

/**
 * The legs of a healthy attach, answered; `over[leg](call, n)` replaces any of
 * them, where n counts calls to that leg so far. Returning null keeps the
 * default.
 */
function server(over = {}) {
  return (call, calls) => {
    const u = call.url;
    const base = x => (x.startsWith('https://') ? 'STORAGE' : x.split('?')[0]);
    const n = calls.filter(c => c.method === call.method && base(c.url) === base(u)).length;
    const pick = (leg, dflt) => {
      const got = over[leg] ? over[leg](call, n) : null;
      return got == null ? dflt : got;
    };
    if (u.startsWith('https://store.example/')) return pick('storage', { status: 200 });
    if (call.method === 'PUT' && u.startsWith('/api/documents?')) {
      return pick('folders', { json: { folders: [{ id: 'f-root', slug: 'purchase-orders' }] } });
    }
    if (call.method === 'POST' && u.startsWith('/api/document-upload-url?')) {
      return pick('ticket', { json: {
        documentId: 'd1', storageKey: 'FCT/paving/p1/d1/receipt.jpg',
        uploadUrl: STORAGE_URL, contentType: 'image/jpeg', expiresIn: 900,
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
const SMALL = "new Blob(['x'.repeat(2000)], { type: 'image/jpeg' })";
const MB1   = "new Blob([new Uint8Array(1024 * 1024)], { type: 'application/pdf' })";
const BIG   = "new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: 'application/pdf' })";

async function attach(s, blobExpr = SMALL) {
  try {
    await s.drive(`attachToPO(${PO}, ${blobExpr}, 'receipt.jpg')`);
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
  const put = s.calls.find(c => c.url.startsWith('https://'));
  assert('the bytes go up by XHR, typed as the ticket says',
    put.via === 'xhr' && put.headers['Content-Type'] === 'image/jpeg', JSON.stringify(put.headers));
  assert('and it counts on the paperclip', s.run('docCounts.po1') === 1);
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

console.log('\n[every request has a way to end]');
// A leg that hangs on its first call must be ended and retried. Without a
// timeout it hangs for good — and drive() reports that as a failure, where the
// old harness let the run exit early with a pass.
for (const leg of ['folders', 'ticket', 'register']) {
  const s = sandbox(server({ [leg]: (c, n) => (n === 1 ? 'hang' : null) }));
  const err = await attach(s);
  assert(`a ${leg} request that never answers is timed out and tried again`, !err, err && err.message);
}
{
  const s = sandbox(server({ register: (c, n) => (n === 1 ? 'hang' : null), list: () => 'hang' }));
  const err = await attach(s);
  assert('so is the look at the order after a lost register', !err, err && err.message);
}
{
  const s = sandbox(server({
    register: () => ({ status: 404, json: { error: 'Folder not found' } }),
    cleanup: () => 'hang',
  }));
  const err = await attach(s);
  assert('and the clean-up after a refused register',
    err && /Folder not found/.test(err.message), err && err.message);
}

console.log('\n[the bytes]');
{
  const s = sandbox(server({ storage: () => netDown() }));
  const err = await attach(s);
  assert('a small file the bucket cannot be reached for goes through the relay', !err, err && err.message);
  const relay = s.calls.find(c => c.method === 'PUT' && c.url.startsWith('/api/document-upload-url?'));
  assert('  carrying its bytes and its order',
    relay && /poId=po1/.test(relay.url) && JSON.parse(relay.body).storageKey === 'FCT/paving/p1/d1/receipt.jpg' &&
    JSON.parse(relay.body).contentBase64.length > 0, relay && String(relay.body).slice(0, 200));
  assert('  signed in, and watched for progress rather than timed',
    relay && relay.via === 'xhr' && relay.headers.Authorization === 'Bearer tok', relay && JSON.stringify(relay.headers));
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
    err && /Upload to storage failed \(403\)/.test(err.message) &&
    count(s.calls, 'PUT STORAGE') === 1 && count(s.calls, 'PUT /api/document-upload-url') === 0,
    err && err.message);
}
{
  const s = sandbox(server({ storage: (c, n) => (n === 1 ? { status: 503 } : null) }));
  const err = await attach(s);
  assert('a store that answers with a passing 503 is asked again', !err && count(s.calls, 'PUT STORAGE') === 2,
    err ? err.message : JSON.stringify(legs(s.calls)));
  assert('  directly — the relay is for no answer, not a busy one', count(s.calls, 'PUT /api/document-upload-url') === 0);
}
{
  const s = sandbox(server({ storage: () => ({ status: 503 }) }));
  const err = await attach(s);
  assert('but a store that stays busy is reported after three tries',
    err && /\(503\)/.test(err.message) && count(s.calls, 'PUT STORAGE') === 3, err && err.message);
}
{
  const s = sandbox(server({ storage: (c, n) => (n < 3 ? netDown() : null) }));
  const err = await attach(s, BIG);
  assert('a file over the relay ceiling retries the direct road instead', !err, err && err.message);
  assert('  and never tries the relay, which would only refuse it',
    count(s.calls, 'PUT STORAGE') === 3 && count(s.calls, 'PUT /api/document-upload-url') === 0,
    JSON.stringify(legs(s.calls)));
  assert('  on the same ticket, still fresh', count(s.calls, 'POST /api/document-upload-url') === 1);
}
{
  const s = sandbox(server({ storage: () => netDown() }));
  const err = await attach(s, BIG);
  assert('and when it cannot get through, says why in words',
    err && /3\.0 MB file/.test(err.message) && /stronger signal/.test(err.message) && /CORS/.test(err.message),
    err && err.message);
  assert('  having registered nothing', count(s.calls, 'POST /api/documents') === 0);
}

console.log('\n[a slow upload is not a dead one]');
{
  // Ten minutes of upload, a progress event every 30 seconds. The fixed
  // deadline this replaced would have cut it off and started it over.
  const s = sandbox(server({ storage: (c, n) => (n === 1 ? { progress: { every: 30000, steps: 20 } } : null) }));
  const start = s.clock.now();
  const err = await attach(s, BIG);
  assert('an upload that keeps moving is left to finish, however long it takes',
    !err && count(s.calls, 'PUT STORAGE') === 1 && s.clock.now() - start >= 600000,
    err ? err.message : JSON.stringify(legs(s.calls)) + ' after ' + (s.clock.now() - start) + 'ms');
}
{
  const s = sandbox(server({ storage: (c, n) => (n === 1 ? 'hang' : null) }));
  const err = await attach(s);
  const relay = s.calls.find(c => c.method === 'PUT' && c.url.startsWith('/api/document-upload-url?'));
  const put = s.calls.find(c => c.url.startsWith('https://'));
  const windowMs = s.run('stallWindowMs')(2000);
  assert('one that stops moving is ended after the stall window, and sent again',
    !err && relay && relay.at - put.at === windowMs && windowMs >= 60000 && windowMs < 61000,
    err ? err.message : relay && ('relayed after ' + (relay.at - put.at) + 'ms, window ' + windowMs));
}
{
  // The real-Chrome case: 1 MB "sent" in 100 ms, then 150 s of silence while
  // the phone's buffer drains up a weak uplink. A bare 60 s window cut this off.
  const s = sandbox(server({ storage: (c, n) => (n === 1 ? { tail: 150000 } : null) }));
  const err = await attach(s, MB1);
  assert('a buffer still draining after "100% sent" is not taken for a stall',
    !err && count(s.calls, 'PUT STORAGE') === 1 && count(s.calls, 'PUT /api/document-upload-url') === 0,
    err ? err.message : JSON.stringify(legs(s.calls)));
}
{
  const s = sandbox(server({ storage: (c, n) => (n === 1 ? { tail: 0, tailHang: true } : null) }));
  const err = await attach(s, MB1);
  const relay = s.calls.find(c => c.method === 'PUT' && c.url.startsWith('/api/document-upload-url?'));
  const put = s.calls.find(c => c.url.startsWith('https://'));
  const windowMs = s.run('stallWindowMs')(1024 * 1024);
  assert('but one that never answers after it is still ended, a buffer\'s drain later',
    !err && relay && relay.at - put.at === 100 + windowMs,
    err ? err.message : relay && ('relayed after ' + (relay.at - put.at) + 'ms, window ' + windowMs));
  assert('  and that allowance is bounded, whatever the file size',
    s.run('stallWindowMs')(500 * 1024 * 1024) === s.run('stallWindowMs')(4 * 1024 * 1024));
}
{
  const s = sandbox(server({ storage: () => 'hang', relay: () => 'hang' }));
  const err = await attach(s);
  assert('and when nothing moves on either road, it ends with a reason, not a spinner',
    err && /stopped moving/.test(err.message) && err.network === true, err && err.message);
}
{
  // A big file crawls for 14½ minutes and then stalls. The retry would start
  // after the 15-minute presigned URL has expired, and the store would answer
  // a 403 that reads like a permissions problem. It gets a fresh ticket first.
  const s = sandbox(server({
    ticket: (c, n) => ({ json: {
      documentId: 'd' + n, storageKey: 'FCT/paving/p1/d' + n + '/receipt.jpg',
      uploadUrl: STORAGE_URL.replace('/d1/', '/d' + n + '/'), contentType: 'application/pdf', expiresIn: 900,
    } }),
    storage: (c, n) => (n === 1 ? { progress: { every: 30000, steps: 29, thenHang: true } } : null),
  }));
  const err = await attach(s, BIG);
  const puts = s.calls.filter(c => c.url.startsWith('https://'));
  const reg = s.calls.find(c => c.method === 'POST' && c.url.startsWith('/api/documents?'));
  assert('a retry that would outlive its upload link gets a fresh one first',
    !err && count(s.calls, 'POST /api/document-upload-url') === 2 && puts.length === 2 && /\/d2\//.test(puts[1].url),
    err ? err.message : JSON.stringify(legs(s.calls)));
  assert('  and registers the file under the ticket it was sent with',
    reg && JSON.parse(reg.body).documentId === 'd2' && JSON.parse(reg.body).storageKey === 'FCT/paving/p1/d2/receipt.jpg',
    reg && reg.body);
  // The abandoned PUT's buffered bytes can still complete the old key.
  const del = s.calls.find(c => c.method === 'DELETE');
  assert('  then clears whatever the abandoned upload stored under the old key, last',
    del && /storageKey=FCT%2Fpaving%2Fp1%2Fd1%2Freceipt\.jpg/.test(del.url) && /poId=po1/.test(del.url) &&
    s.calls.indexOf(del) > s.calls.indexOf(reg), del ? del.url : JSON.stringify(legs(s.calls)));
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
  // Landed, reply lost, and the first look could not get through either; the
  // second try is then told "already registered".
  let looks = 0;
  const s = sandbox(server({
    register: (c, n) => (n === 1 ? netDown() : { status: 409, json: { error: 'That document is already registered' } }),
    list: () => (++looks >= 2 ? { json: { documents: [{ id: 'd1' }] } } : netDown()),
  }));
  const err = await attach(s);
  assert('"already registered" after a lost reply is checked, and is a success', !err, err && err.message);
}
{
  const s = sandbox(server({ register: () => ({ status: 404, json: { error: 'Folder not found' } }) }));
  const err = await attach(s);
  assert('a register the server refuses is reported', err && /Folder not found/.test(err.message), err && err.message);
  assert('  as a plain failure, not an unsure one', err && !err.unconfirmed);
  assert('  without asking again', count(s.calls, 'POST /api/documents') === 1);
  const del = s.calls.find(c => c.method === 'DELETE');
  assert('  and the stored bytes are cleaned up, for this order',
    del && /storageKey=FCT%2Fpaving%2Fp1%2Fd1%2Freceipt\.jpg/.test(del.url) && /poId=po1/.test(del.url), del && del.url);
  assert('  and nothing is counted on the paperclip', s.run('docCounts.po1') === undefined);
}

console.log('\n[a long dead zone while filing]');
{
  // The register lands on the server, its reply is lost, and the phone then
  // stays out of signal through every retry and every look.
  let offline = false;
  const filed = new Set();
  const s = sandbox((call, calls) => {
    if (offline) return netDown();
    return server({
      register: c => {
        const body = JSON.parse(c.body);
        filed.add(body.documentId);
        if (body.documentId === 'd1') { offline = true; return netDown(); }
        return null;
      },
      list: () => ({ json: { documents: [...filed].map(id => ({ id })) } }),
    })(call, calls);
  });
  s.run(`var heldBlob = ${SMALL};`);
  let err = null;
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg')`); } catch (e) { err = e; }
  assert('a register lost in a long outage is reported as unsure, not as failed',
    err && err.unconfirmed === true && /may already be on the order/.test(err.message), err && err.message);
  assert('  and its bytes are left alone — the register may still be running',
    count(s.calls, 'DELETE /api/document-upload-url') === 0);

  // Still offline: the retry cannot check, so it sends nothing at all.
  const before = s.calls.length;
  err = null;
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg')`); } catch (e) { err = e; }
  assert('trying again while still offline sends nothing it cannot check',
    err && /Nothing was sent/.test(err.message) &&
    s.calls.slice(before).every(c => c.method === 'GET'), JSON.stringify(legs(s.calls.slice(before))));

  // Back in signal: the retry finds the first one filed, and stops there.
  offline = false;
  const back = s.calls.length;
  err = null;
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg')`); } catch (e) { err = e; }
  assert('trying again in signal finds it already filed, and files nothing twice',
    !err && filed.size === 1 && JSON.stringify(legs(s.calls.slice(back))) === JSON.stringify(['GET /api/documents']),
    err ? err.message : JSON.stringify(legs(s.calls.slice(back))) + ' filed=' + [...filed]);
  assert('  and counts it once', s.run('docCounts.po1') === 1);
}
{
  // Same outage, but the register never reached the server at all.
  let offline = false;
  const s = sandbox((call, calls) => {
    if (offline) return netDown();
    return server({
      ticket: (c, n) => ({ json: {
        documentId: 'd' + n, storageKey: 'FCT/paving/p1/d' + n + '/receipt.jpg',
        uploadUrl: STORAGE_URL, contentType: 'image/jpeg', expiresIn: 900,
      } }),
      register: (c, n) => (n === 1 ? ((offline = true), netDown()) : null),
    })(call, calls);
  });
  s.run(`var heldBlob = ${SMALL};`);
  let err = null;
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg')`); } catch (e) { err = e; }
  offline = false;
  const back = s.calls.length;
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg')`); err = null; } catch (e) { err = e; }
  const after = s.calls.slice(back);
  const reg = after.find(c => c.method === 'POST' && c.url.startsWith('/api/documents?'));
  assert('when the earlier try is NOT on the order, the retry registers that same upload',
    !err && reg && JSON.parse(reg.body).documentId === 'd1',
    err ? err.message : JSON.stringify(legs(after)));
  assert('  without minting or sending the bytes again',
    count(after, 'POST /api/document-upload-url') === 0 && count(after, 'PUT STORAGE') === 0, JSON.stringify(legs(after)));
}
{
  // The first register is still running on a cold function when the retry
  // looks: "not there yet". It lands while the retry is re-registering, so the
  // server's unique id answers the retry with a 409 — which must read as filed.
  let offline = false;
  const filed = new Set();
  let firstLands = null;
  const s = sandbox((call, calls) => {
    if (offline) return netDown();
    return server({
      register: (c, n) => {
        const id = JSON.parse(c.body).documentId;
        if (n === 1) { offline = true; firstLands = () => filed.add(id); return netDown(); }
        if (firstLands) { firstLands(); firstLands = null; }
        if (filed.has(id)) return { status: 409, json: { error: 'That document is already registered' } };
        filed.add(id);
        return null;
      },
      list: () => ({ json: { documents: [...filed].map(id => ({ id })) } }),
    })(call, calls);
  });
  s.run(`var heldBlob = ${SMALL};`);
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg')`); } catch (e) { /* unsure */ }
  offline = false;
  let err = null;
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg')`); } catch (e) { err = e; }
  assert('a first register still landing during the retry ends filed once, not twice',
    !err && filed.size === 1, err ? err.message : 'filed=' + [...filed]);
}
{
  // The retry's re-register is refused outright — its folder was deleted. It
  // starts again from scratch rather than leaving the user stuck.
  let offline = false;
  const s = sandbox((call, calls) => {
    if (offline) return netDown();
    return server({
      ticket: (c, n) => ({ json: {
        documentId: 'd' + n, storageKey: 'FCT/paving/p1/d' + n + '/receipt.jpg',
        uploadUrl: STORAGE_URL, contentType: 'image/jpeg', expiresIn: 900,
      } }),
      register: (c, n) => {
        if (n === 1) { offline = true; return netDown(); }
        return JSON.parse(c.body).documentId === 'd1' ? { status: 404, json: { error: 'Folder not found' } } : null;
      },
    })(call, calls);
  });
  s.run(`var heldBlob = ${SMALL};`);
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg')`); } catch (e) { /* unsure */ }
  offline = false;
  const back = s.calls.length;
  let err = null;
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg')`); } catch (e) { err = e; }
  const after = s.calls.slice(back);
  const regs = after.filter(c => c.method === 'POST' && c.url.startsWith('/api/documents?')).map(c => JSON.parse(c.body).documentId);
  assert('a held upload the server now refuses is replaced by a fresh one',
    !err && JSON.stringify(regs) === JSON.stringify(['d1', 'd2']), err ? err.message : JSON.stringify(regs));
  assert('  leaving the held bytes alone, in case the first register still records them',
    !after.some(c => c.method === 'DELETE' && /d1/.test(c.url)), JSON.stringify(legs(after)));
}
{
  // A 504 can arrive AFTER the function wrote the row, and the look cannot get
  // through. That is not a plain failure: it may be filed.
  const filed = new Set();
  const s = sandbox(server({
    register: (c, n) => {
      const id = JSON.parse(c.body).documentId;
      if (n === 1) { filed.add(id); return { status: 504, json: { error: 'FUNCTION_INVOCATION_TIMEOUT' } }; }
      return filed.has(id) ? { status: 409, json: { error: 'That document is already registered' } } : null;
    },
    list: () => ({ status: 504, json: { error: 'FUNCTION_INVOCATION_TIMEOUT' } }),
  }));
  const err = await attach(s);
  assert('an answered 504 that may have filed it, with no way to look, is unsure — not a failure',
    err && err.unconfirmed === true, err && err.message);
  assert('  and its bytes are kept for the retry', count(s.calls, 'DELETE /api/document-upload-url') === 0);
}

console.log('\n[what api() reports]');
{
  const s = sandbox(() => 'hang');
  let err = null;
  try { await s.drive("api('GET', '/x', undefined, { timeoutMs: 45000 })"); } catch (e) { err = e; }
  assert('a request that goes quiet times out as a network failure',
    err && err.network === true && /timed out/.test(err.message), err && err.message);
}
{
  const s = sandbox(() => ({ status: 502, json: { error: 'Bad gateway' } }));
  let err = null;
  try { await s.drive("api('GET', '/x')"); } catch (e) { err = e; }
  assert('an answered failure carries its status', err && err.status === 502 && !err.network, err && err.message);
}
{
  const s = sandbox(() => ({ status: 401 }));
  let err = null;
  try { await s.drive("api('GET', '/x')"); } catch (e) { err = e; }
  assert('a signed-out answer is neither retried nor called a network failure',
    err && err.message === 'Signed out' && !err.network && !s.run('isTransient')(err) && s.run('loggedOut'),
    err && err.message);
}
{
  const s = sandbox(() => ({ status: 401 }));
  let err = null;
  try { await s.drive("api('PUT', '/x', { a: 1 }, { watched: true })"); } catch (e) { err = e; }
  assert('  by either road', err && err.message === 'Signed out' && s.run('loggedOut'), err && err.message);
}
{
  const s = sandbox(() => netDown());
  let err = null;
  try { await s.drive("api('GET', '/x')"); } catch (e) { err = e; }
  assert('a request with no answer at all is marked a network failure', err && err.network === true);
}

console.log('\n[getting the file ready]');
{
  const s = sandbox(server(), { downscale: async () => { throw new Error('That file is not an image this browser can read'); } });
  const out = await s.drive("prepareAttachment(new File(['heic-bytes'], 'IMG_1234.HEIC', { type: 'image/heic' }))");
  assert('a photo the browser cannot decode goes up as it is', out && out.filename === 'IMG_1234.HEIC' && out.blob.size === 10,
    JSON.stringify(out && { filename: out.filename, size: out.blob && out.blob.size }));
  assert('  rather than failing the attach', s.warnings.some(w => /sending it as it is/.test(w)));
  const jfif = await s.drive("prepareAttachment(new File(['x'], 'scan.jfif', { type: 'image/jpeg' }))");
  assert('  and one in a format the vault does not name is given one it does', jfif.filename === 'scan.jfif.jpg', jfif.filename);
}
{
  const s = sandbox(server());
  const photo = await s.drive("prepareAttachment(new File(['raw'], 'IMG_9.jpeg', { type: 'image/jpeg' }))");
  assert('a photo that decodes is shrunk and sent as .jpg', photo.filename === 'IMG_9.jpg' && photo.blob.size === 10,
    photo.filename);
  const pdf = await s.drive("prepareAttachment(new File(['%PDF'], 'document', { type: 'application/pdf' }))");
  assert('a PDF with no extension is given one', pdf.filename === 'document.pdf', pdf.filename);
  const dotted = await s.drive("prepareAttachment(new File(['%PDF'], 'Home Depot receipt 11.10', { type: 'application/pdf' }))");
  assert('  and so is one whose name ends in a dotted number',
    dotted.filename === 'Home Depot receipt 11.10.pdf' && storage.mimeFor(dotted.filename) === 'application/pdf', dotted.filename);
  const xlsx = await s.drive("prepareAttachment(new File(['x'], 'Quote 118.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))");
  assert('a spreadsheet is passed along untouched', xlsx.filename === 'Quote 118.xlsx');
  const odd = await s.drive("prepareAttachment(new File(['x'], '', { type: '' }))");
  assert('a nameless, typeless file still has a name for the server to refuse', odd.filename === 'file');
  const exe = await s.drive("prepareAttachment(new File(['x'], 'setup.exe', { type: 'application/x-msdownload' }))");
  assert('and a type the vault refuses is left for the server to refuse by name', exe.filename === 'setup.exe');
}

console.log('\n[the picker offers what the server takes]');
{
  const s = sandbox(server());
  const vault = s.run('VAULT_EXTS');
  const serverExts = storage.allowedExtensions();
  assert('the page\'s list of vault extensions is the server\'s',
    vault.length === serverExts.length && serverExts.every(e => vault.includes(e)),
    'page: ' + vault.join(',') + ' server: ' + serverExts.join(','));

  const m = PAGE.match(/<input type="file" id="attach-capture"\s+accept="([^"]+)"/);
  const accept = m ? m[1].split(',') : [];
  const coveredByImageStar = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const missing = serverExts.filter(ext => !coveredByImageStar.includes(ext) && !accept.includes('.' + ext));
  assert('every file type the vault allows can be picked', m && accept.includes('image/*') && !missing.length,
    'missing: ' + missing.join(', '));
  const extra = accept.filter(a => a.startsWith('.') && !serverExts.includes(a.slice(1)));
  assert('and nothing it would refuse', !extra.length, extra.join(', '));

  const map = s.run('EXT_FOR_TYPE');
  const bad = Object.entries(map).filter(([type, ext]) => storage.mimeFor('f.' + ext) !== type);
  assert('an extension supplied from a type is one the server takes, for that type', !bad.length, JSON.stringify(bad));
}

console.log('\n[the callers use all of it]');
{
  const add = requireFn(PAGE, 'addAttachment', 'purchase-orders.html');
  assert('the paperclip sheet prepares the file before attaching it',
    /prepared = await prepareAttachment\(file\);\s*\n\s*await attachToPO\(po, prepared\.blob, prepared\.filename\);/.test(add), add);
  assert('and no longer lets a photo that will not decode end the attach', !/downscaleImage/.test(add));
  assert('a file it could not attach is kept, with whether it may have landed',
    /_docsRetry = \{ poId, blob: prepared\.blob, filename: prepared\.filename, unsure: Boolean\(err\.unconfirmed\) \};/.test(add), add);
  const open = requireFn(PAGE, 'openDocs', 'purchase-orders.html');
  assert('  and offered again on that order\'s sheet', /docsRetryHTML\(po\)/.test(open));
  const again = requireFn(PAGE, 'retryDocsAttach', 'purchase-orders.html');
  assert('  sending the SAME file, so the check-first applies',
    /await attachToPO\(po, held\.blob, held\.filename\);/.test(again), again);
  const html = requireFn(PAGE, 'docsRetryHTML', 'purchase-orders.html');
  assert('  with its order id escaped into the handlers',
    (html.match(/jsAttr\(po\.id\)/g) || []).length === 2 && !/\(\\'' \+ po\.id/.test(html), html);

  const commit = requireFn(PAGE, 'commitScan', 'purchase-orders.html');
  assert('the scan sheet says "may not have attached" when that is the truth',
    /attachUnsure = Boolean\(err\.unconfirmed\)/.test(commit) && /the photo may not have attached/.test(commit));
  const retry = requireFn(PAGE, 'retryAttach', 'purchase-orders.html');
  assert('and its retry sends the same photo, so the check-first applies',
    /attachToPO\(po, _attachRetry\.blob, _attachRetry\.filename/.test(retry));
}

finished = true;
console.log(`\n${failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'}`);
process.exit(failed ? 1 : 0);
})().catch(err => {
  finished = true;
  console.error('\n  ✗ the run threw: ' + (err && err.stack || err));
  process.exit(1);
});
