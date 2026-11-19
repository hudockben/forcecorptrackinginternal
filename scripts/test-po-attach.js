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
function sandbox(route, { downscale, settle } = {}) {
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
    const lineDocCounts = Object.create(null);
    let _lineCountTicket = 0;
    const _lineCountLanded = Object.create(null);
    const _lineFirstHand = Object.create(null);
    async function downscaleImage(file, maxEdge) { return __downscale(file, maxEdge); }
    // The order's save, settled before a file is filed against one of its
    // deliveries. Records how many requests had gone out when it was asked.
    const settled = [];
    async function settleOrderSave(po) { settled.push({ po: po.id, after: __calls.length }); return __settle(po); }
  `, ctx);
  ctx.__downscale = downscale || (async () => ({ blob: new dom.window.Blob(['small-jpeg'], { type: 'image/jpeg' }) }));
  ctx.__settle = settle || (async () => {});
  ctx.__calls = calls;
  evalSlice('async ' + requireFn(PAGE, 'api', 'purchase-orders.html'), ctx, 'api()');
  // The paperclip counts an attach updates, the page's own.
  ['lineDocCount', 'setLineDocCount', 'countAttached']
    .forEach(n => evalSlice(requireFn(PAGE, n, 'purchase-orders.html'), ctx, n));
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

async function attach(s, blobExpr = SMALL, optsExpr) {
  try {
    await s.drive(`attachToPO(${PO}, ${blobExpr}, 'receipt.jpg'${optsExpr ? ', ' + optsExpr : ''})`);
    return null;
  } catch (err) {
    return err;
  }
}
const registers = calls => calls.filter(c => c.method === 'POST' && c.url.startsWith('/api/documents?'));

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

console.log('\n[a file for one delivery]');
{
  const s = sandbox(server());
  const err = await attach(s, SMALL, "{ lineId: 'L1' }");
  assert('a file attached from a delivery lands', !err, err && err.message);
  assert('  in the same four requests, in the same order',
    JSON.stringify(legs(s.calls)) === JSON.stringify([
      'PUT /api/documents', 'POST /api/document-upload-url', 'PUT STORAGE', 'POST /api/documents']),
    JSON.stringify(legs(s.calls)));
  assert('  every one of them naming the order, which is what the purchasing carve-out reads',
    s.calls.filter(c => !c.url.startsWith('https://')).every(c => /[?&]poId=po1(&|$)/.test(c.url)),
    JSON.stringify(s.calls.map(c => c.url)));
  const settled = s.run('JSON.stringify(settled)');
  assert('  after the order\'s save was settled, before anything was sent',
    settled === JSON.stringify([{ po: 'po1', after: 0 }]), settled);
  const reg = JSON.parse(registers(s.calls)[0].body);
  assert('  the register names the delivery, beside its order', reg.poLineId === 'L1' && reg.poId === 'po1', JSON.stringify(reg));
  const ticket = JSON.parse(s.calls.find(c => c.method === 'POST' && c.url.startsWith('/api/document-upload-url?')).body);
  const seed = s.calls.find(c => c.method === 'PUT' && c.url.startsWith('/api/documents?'));
  assert('  and nothing else does — the other legs are the order\'s, as they always were',
    !('poLineId' in ticket) && seed.body === '{}' && !/poLineId/.test(seed.url), JSON.stringify(ticket));
  assert('it counts on the order\'s paperclip', s.run('docCounts.po1') === 1);
  assert('  and on the delivery\'s', s.run("lineDocCount('po1', 'L1')") === 1 && s.run("lineDocCount('po1', 'L2')") === 0);
}
{
  const s = sandbox(server());
  const err = await attach(s);
  const reg = JSON.parse(registers(s.calls)[0].body);
  assert('a file attached to the order itself sends no delivery at all', !err && !('poLineId' in reg), JSON.stringify(reg));
  assert('  settles nothing first', s.run('settled.length') === 0);
  assert('  and counts on no delivery', s.run('Object.keys(lineDocCounts).length') === 0);
}
{
  const s = sandbox(server());
  const err = await attach(s, SMALL, "{ note: 'Scanned receipt', lineId: 'L1' }");
  const reg = JSON.parse(registers(s.calls)[0].body);
  assert('a note travels with a delivery\'s file', !err && reg.note === 'Scanned receipt' && reg.poLineId === 'L1',
    JSON.stringify(reg));
}
{
  const s = sandbox(server(), { settle: async () => { throw new TypeError('Failed to fetch'); } });
  const err = await attach(s, SMALL, "{ lineId: 'L1' }");
  assert('a delivery whose order cannot be saved is said so, in words',
    err && /not saved yet/.test(err.message) && /Failed to fetch/.test(err.message), err && err.message);
  assert('  having sent nothing — no ticket minted, no bytes up to be thrown away', s.calls.length === 0,
    JSON.stringify(legs(s.calls)));
  assert('  and counted nothing', s.run('docCounts.po1') === undefined && s.run("lineDocCount('po1', 'L1')") === 0);
}
{
  const s = sandbox(server({ register: () => ({ status: 404, json: {
    error: 'Delivery line not found',
    detail: 'That delivery is not on the order yet — it may not have been saved. Wait a moment and try again.',
  } }) }));
  const err = await attach(s, SMALL, "{ lineId: 'L1' }");
  assert('a delivery the server does not have on the order is reported in its words',
    err && /not on the order yet/.test(err.message) && !err.unconfirmed, err && err.message);
  assert('  without asking again', registers(s.calls).length === 1);
  const del = s.calls.find(c => c.method === 'DELETE');
  assert('  with the stored bytes cleaned up, for this order', del && /poId=po1/.test(del.url), del && del.url);
  assert('  and nothing counted on either paperclip',
    s.run('docCounts.po1') === undefined && s.run("lineDocCount('po1', 'L1')") === 0);
}
{
  // The server lists a delivery's file on its order with the delivery's link
  // ("<poId>:<lineId>") — it writes both links in one statement.
  const s = sandbox(server({ register: () => netDown(),
    list: () => ({ json: { documents: [{ id: 'd1', po_ids: ['po1'], po_line_ids: ['po1:L1'] }] } }) }));
  const err = await attach(s, SMALL, "{ lineId: 'L1' }");
  assert('a delivery\'s file that landed without a reply is found on the order, and is a success',
    !err && registers(s.calls).length === 1, err ? err.message : JSON.stringify(legs(s.calls)));
  assert('  counted once on the delivery', s.run("lineDocCount('po1', 'L1')") === 1);
}
{
  // Half a register: the file reached the order but not the delivery it was
  // sent to (a function cut off between the two links, on a server that
  // wrote them apart). "On the order" is not "filed where it was sent" — the
  // delivery would never list it, and its count would fall back to 0 on the
  // next refresh. Neither the retry's 409 nor the check may call it done.
  const s = sandbox(server({
    register: (c, n) => (n === 1 ? { status: 500, json: { error: 'Database error' } }
                                 : { status: 409, json: { error: 'That document is already registered' } }),
    list: () => ({ json: { documents: [{ id: 'd1', po_ids: ['po1'], po_line_ids: [] }] } }),
  }));
  const err = await attach(s, SMALL, "{ lineId: 'L1' }");
  assert('a delivery\'s file found on the order but not on its delivery is not reported as attached to it',
    Boolean(err) && !/^Could not confirm/.test(err.message), err ? err.message : 'no error');
  assert('  and counts on neither paperclip',
    s.run("lineDocCount('po1', 'L1')") === 0 && s.run('docCounts.po1') === undefined,
    `${s.run("lineDocCount('po1', 'L1')")} / ${s.run('docCounts.po1')}`);
}
{
  // The same listing is a success for a file sent to the order itself.
  const s = sandbox(server({ register: () => netDown(),
    list: () => ({ json: { documents: [{ id: 'd1', po_ids: ['po1'], po_line_ids: [] }] } }) }));
  const err = await attach(s, SMALL);
  assert('an order\'s own file found on its paperclip is a success, delivery or none',
    !err && registers(s.calls).length === 1 && s.run('docCounts.po1') === 1, err ? err.message : JSON.stringify(legs(s.calls)));
}
{
  // The dead zone again, for a delivery: the retry re-registers the same
  // upload, still for that delivery.
  let offline = false;
  const s = sandbox((call, calls) => {
    if (offline) return netDown();
    return server({ register: (c, n) => (n === 1 ? ((offline = true), netDown()) : null) })(call, calls);
  });
  s.run(`var heldBlob = ${SMALL};`);
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg', { lineId: 'L1' })`); } catch (e) { /* unsure */ }
  offline = false;
  const back = s.calls.length;
  let err = null;
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg', { lineId: 'L1' })`); } catch (e) { err = e; }
  const after = registers(s.calls.slice(back)).map(c => JSON.parse(c.body));
  assert('a delivery\'s file held over a dead zone is registered again for that delivery',
    !err && after.length === 1 && after[0].documentId === 'd1' && after[0].poLineId === 'L1',
    err ? err.message : JSON.stringify(after));
  assert('  counted once on it', s.run("lineDocCount('po1', 'L1')") === 1 && s.run('docCounts.po1') === 1);
}
{
  // A held, unsure file for one delivery is not "already filed" for ANOTHER
  // delivery: being on the order is what the check finds, and that says
  // nothing about the second delivery.
  let offline = false;
  const filed = new Set();
  const s = sandbox((call, calls) => {
    if (offline) return netDown();
    return server({
      ticket: (c, n) => ({ json: {
        documentId: 'd' + n, storageKey: 'FCT/paving/p1/d' + n + '/receipt.jpg',
        uploadUrl: STORAGE_URL, contentType: 'image/jpeg', expiresIn: 900,
      } }),
      register: (c, n) => {
        filed.add(JSON.parse(c.body).documentId);
        return n === 1 ? ((offline = true), netDown()) : null;
      },
      list: () => ({ json: { documents: [...filed].map(id => ({ id })) } }),
    })(call, calls);
  });
  s.run(`var heldBlob = ${SMALL};`);
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg', { lineId: 'L1' })`); } catch (e) { /* unsure */ }
  offline = false;
  const back = s.calls.length;
  let err = null;
  try { await s.drive(`attachToPO(${PO}, heldBlob, 'receipt.jpg', { lineId: 'L2' })`); } catch (e) { err = e; }
  const after = registers(s.calls.slice(back)).map(c => JSON.parse(c.body));
  assert('the same file sent to another delivery is filed for that one, not taken as done',
    !err && after.length === 1 && after[0].poLineId === 'L2' && after[0].documentId === 'd2',
    err ? err.message : JSON.stringify(after));
  assert('  and counted on it, not on the first', s.run("lineDocCount('po1', 'L2')") === 1 && s.run("lineDocCount('po1', 'L1')") === 0);
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

/**
 * The delivery paperclips and their sheet, run in a jsdom document with the
 * page's own functions. `answer(url)` answers each api() GET: an object, an
 * Error to throw, or a promise to hold it back.
 */
function pageSandbox({ answer, canEdit = true, settle, orders, body = '' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body>' +
    '<div id="docs-backdrop"><div class="sheet" id="docs-sheet"></div></div>' + body + '</body></html>');
  const gets = [];
  const toasts = [];
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: dom.window.document,
    JSON, Promise, Math, Error, Number, String, Object, Array, Map, Set, Boolean, Date, encodeURIComponent,
    __answer: answer || (() => ({})),
    __settle: settle || (async () => {}),
  });
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    let purchaseOrders = ${JSON.stringify(orders || [])};
    // Where the server has each order: all of them stored, where they are.
    const _savedDivision = Object.fromEntries(purchaseOrders.map(po => [po.id, po._division]));
    const docCounts = {};
    const lineDocCounts = Object.create(null);
    let _lineCountTicket = 0;
    const _lineCountLanded = Object.create(null);
    const _lineFirstHand = Object.create(null);
    let _docsSheetSeq = 0;
    let _docsRetry = null;
    const gets = [], toasts = [], settled = [];
    let locks = 0;
    async function api(method, path) { gets.push(method + ' ' + path); return __answer(path); }
    async function settleOrderSave(po) { settled.push({ po: po.id, after: gets.length }); return __settle(po); }
    function lockBodyScroll() { locks++; }
    function toast(msg, kind) { toasts.push(msg); }
    function capsFor() { return { canEdit: ${canEdit ? 'true' : 'false'} }; }
    function divLabel(d) { return d === 'paving' ? 'Paving' : d; }
    function hasJobs(d) { return ['turf', 'paving', 'kiewit'].includes(d); }
    function projectFor(d, id) { return id === 'p1' ? { id: 'p1', name: 'Route 30' } : null; }
  `, ctx);
  ['esc', 'jsAttr', 'lineDocCount', 'setLineDocCount', 'countAttached', 'loadLineDocCounts',
   'lineClipHTML', 'lineClipLabel', 'paintLineClips', 'liveLineId', 'lineLabel', 'lineCostCodeFor',
   'openDocs', 'lineDocsSubHTML', 'deliveryTagOf', 'docsRetryHTML']
    .forEach(n => evalSlice((/^(loadLineDocCounts|openDocs)$/.test(n) ? 'async ' : '') +
      requireFn(PAGE, n, 'purchase-orders.html'), ctx, n));
  const run = e => vm.runInContext(e, ctx);
  return { dom, doc: dom.window.document, run, gets: () => run('gets'), ctx };
}
const settleAll = () => new Promise(r => setTimeout(r, 0));
const hold = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

const ORDERS = [
  { id: 'po1', po_number: 'PO-0042', _division: 'paving', project_id: 'p1', cost_code: '420', lines: [
    { id: 'L1', invoice_num: 'INV-77', date: '2026-11-02' },
    { id: 'dr-row1', source: 'daily', invoice_num: '', date: '2026-11-03', cost_code: 'Stormwater', sub_code: '01' },
    { id: 'L3', invoice_num: '', date: '' },
  ] },
  { id: 'po2', po_number: 'PO-0007', _division: 'quarry', project_id: '', cost_code: '', lines: [{ id: 'Q1', invoice_num: 'T-9' }] },
];

console.log('\n[a paperclip on every delivery]');
{
  const s = pageSandbox({ orders: ORDERS });
  const one = html => new JSDOM('<!doctype html><body>' + html).window.document.querySelector('button');
  const b = one(s.run("lineClipHTML(purchaseOrders[0], purchaseOrders[0].lines[0])"));
  assert('a delivery with nothing attached shows a muted paperclip',
    b && b.classList.contains('line-clip') && !b.classList.contains('has') && b.textContent === '\u{1F4CE}', b && b.outerHTML);
  assert('  that offers attaching, to someone who can', /^Attach a ticket or invoice/.test(b.title) && b.getAttribute('aria-label') === b.title);
  assert('  and opens the attachments sheet for that delivery', b.getAttribute('onclick') === "openDocs('po1','L1')", b.getAttribute('onclick'));
  assert('  found again by its own attributes, not the order paperclip\'s or a delivery box\'s',
    b.dataset.clipPo === 'po1' && b.dataset.clipLine === 'L1' && !b.hasAttribute('data-po-id') && !b.hasAttribute('id'));
  s.run("setLineDocCount('po1', 'L1', 3)");
  const g = one(s.run("lineClipHTML(purchaseOrders[0], purchaseOrders[0].lines[0])"));
  assert('with files attached it is green and says how many', g.classList.contains('has') && g.textContent === '\u{1F4CE}3' &&
    g.title === '3 attached to this delivery', g.outerHTML);
  const v = pageSandbox({ orders: ORDERS, canEdit: false });
  const vb = one(v.run("lineClipHTML(purchaseOrders[0], purchaseOrders[0].lines[0])"));
  assert('a viewer sees it too, worded for reading', vb && vb.title === 'Nothing attached to this delivery', vb && vb.title);

  // Ids are free text the full-list PUT never checks.
  const hostile = { id: "x');alert(1);('", _division: 'paving' };
  const line = { id: '"><img src=x onerror=alert(1)>' };
  const h = new JSDOM('<!doctype html><body>' + s.run(`lineClipHTML(${JSON.stringify(hostile)}, ${JSON.stringify(line)})`)).window.document;
  const hb = h.querySelector('button');
  assert('a hostile order or delivery id stays inside its attribute',
    h.querySelectorAll('img').length === 0 && h.querySelectorAll('button').length === 1 &&
    hb.dataset.clipPo === hostile.id && hb.dataset.clipLine === line.id, h.body.innerHTML);
  assert('  and inside its handler', /^openDocs\('(?:[^'\\]|\\.)*','(?:[^'\\]|\\.)*'\)$/.test(hb.getAttribute('onclick')),
    hb.getAttribute('onclick'));

  const rows = requireFn(PAGE, 'lineRowsHTML', 'purchase-orders.html');
  assert('the delivery rows draw it in the Invoice / Ticket # cell, beside the box — no new column',
    /inp\('invoice_num','text', l\.invoice_num, 'placeholder="Invoice \/ Ticket #"'\) \+ lineClipHTML\(po, l\) \+ '<\/div>' \+\s*\n\s*dailyLineTagHTML\(l\)/.test(rows), rows);
  assert('  on both surfaces, through the one row builder', (PAGE.match(/lineClipHTML\(/g) || []).length === 2);
  assert('  and not in the lock / ✕ cell', !/isDailyLine\(l\)\s*\n\s*\?[\s\S]{0,500}lineClipHTML/.test(rows));
  const head = (PAGE.match(/'<thead><tr><th>Invoice \/ Ticket #<\/th>[\s\S]*?<\/tr><\/thead>'/) || [''])[0];
  assert('  so the deliveries table keeps its nine columns', (head.match(/<th[ >]/g) || []).length === 9, head);
}

console.log('\n[counting each delivery\'s files]');
{
  const surfaces = ['tbl', 'card'].map(() =>
    '<button class="line-clip" data-clip-po="po1" data-clip-line="L1"></button>' +
    '<button class="line-clip" data-clip-po="po1" data-clip-line="dr-row1"></button>' +
    '<button class="line-clip" data-clip-po="po2" data-clip-line="L1"></button>').join('');
  let reply = () => ({ counts: { po1: { L1: 2, 'dr-row1': 1 }, po9: { X: 5 } } });
  const s = pageSandbox({ orders: ORDERS, body: surfaces, answer: path => reply(path) });
  const clips = [...s.doc.querySelectorAll('.line-clip')];
  const ok = await s.run('loadLineDocCounts(purchaseOrders[0])');
  assert('an order\'s deliveries are counted in one request, naming that order',
    ok === true && JSON.stringify(s.gets()) === JSON.stringify(['GET /documents?division=paving&poLineCounts=1&poId=po1']),
    JSON.stringify(s.gets()));
  assert('  and taken', s.run("lineDocCount('po1', 'L1')") === 2 && s.run("lineDocCount('po1', 'dr-row1')") === 1);
  assert('  only for that order — another order in the answer is not', s.run("'po9' in lineDocCounts") === false);
  const now = [...s.doc.querySelectorAll('.line-clip')];
  assert('the paperclips are redrawn where they stand, not re-rendered',
    now.length === clips.length && now.every((b, i) => b === clips[i]));
  assert('  on the table and on the phone card alike',
    now.filter(b => b.dataset.clipPo === 'po1' && b.dataset.clipLine === 'L1')
      .every(b => b.textContent === '\u{1F4CE}2' && b.classList.contains('has') && b.title === '2 attached to this delivery'),
    now.map(b => b.outerHTML).join(' '));
  assert('  leaving another order\'s delivery with the same line id alone',
    now.filter(b => b.dataset.clipPo === 'po2').every(b => b.textContent === '' && !b.classList.contains('has')));

  reply = () => { throw new Error('HTTP 502'); };
  assert('a count that fails keeps the last good one',
    await s.run('loadLineDocCounts(purchaseOrders[0])') === false && s.run("lineDocCount('po1', 'L1')") === 2);
  reply = () => ({ documents: [] });
  assert('  and so does an answer with no counts in it — a server from before the count answers with the order\'s list',
    await s.run('loadLineDocCounts(purchaseOrders[0])') === false && s.run("lineDocCount('po1', 'L1')") === 2);

  // A slow count overtaken by an attach this page just counted.
  const late = hold();
  reply = () => late.p;
  const slow = s.run('loadLineDocCounts(purchaseOrders[0])');
  await settleAll();
  s.run("countAttached(purchaseOrders[0], 'L1')");
  late.release({ counts: { po1: { L1: 2, 'dr-row1': 4 } } });
  const slowTook = await slow;
  assert('a count that left before an attach does not undo it', s.run("lineDocCount('po1', 'L1')") === 3,
    s.run("lineDocCount('po1', 'L1')"));
  assert('  but is still taken for the order\'s other deliveries, and painted',
    slowTook === true && s.run("lineDocCount('po1', 'dr-row1')") === 4
      && [...s.doc.querySelectorAll('.line-clip')].filter(b => b.dataset.clipPo === 'po1' && b.dataset.clipLine === 'dr-row1')
        .every(b => b.textContent === '\u{1F4CE}4' && b.classList.contains('has')),
    `${slowTook} / ${s.run("lineDocCount('po1', 'dr-row1')")}`);
  assert('  and the attach counted on the order\'s paperclip too', s.run('docCounts.po1') === 1);
  reply = () => ({ counts: { po1: { L1: 1 } } });
  assert('but a count asked for afterwards stands — a file detached in a division tab',
    await s.run('loadLineDocCounts(purchaseOrders[0])') === true && s.run("lineDocCount('po1', 'L1')") === 1 &&
    s.run("lineDocCount('po1', 'dr-row1')") === 0);
  reply = () => ({ counts: { po1: { L1: 0, L3: 'x', 'dr-row1': -1 } } });
  await s.run('loadLineDocCounts(purchaseOrders[0])');
  assert('nothing but a positive count is kept', s.run("JSON.stringify(Object.keys(lineDocCounts.po1))") === '[]');

  const asked = s.gets().length;
  s.run("purchaseOrders.push({ id: 'po-new', _division: 'paving', lines: [{ id: 'n1' }] })");
  assert('an order not yet stored is not counted — nothing is filed against it, and the carve-out would refuse it',
    await s.run("loadLineDocCounts(purchaseOrders[purchaseOrders.length - 1])") === false && s.gets().length === asked);
  s.run("_savedDivision.po1 = 'turf'");
  assert('  nor is one whose move to another list has not been saved',
    await s.run('loadLineDocCounts(purchaseOrders[0])') === false && s.gets().length === asked);
  s.run("_savedDivision.po1 = 'paving'");

  s.run("setLineDocCount('__proto__', '__proto__', 2)");
  assert('an id named like a prototype key is just an id',
    s.run("lineDocCount('__proto__', '__proto__')") === 2 && s.run("lineDocCount('po1', 'constructor')") === 0 &&
    s.run("lineDocCount('constructor', 'L1')") === 0 &&
    s.run("Object.getPrototypeOf(lineDocCounts) === null && Object.getPrototypeOf(lineDocCounts['__proto__']) === null"));
}

{
  // A delivery's sheet opened while its order's count is still out (slow LTE,
  // a cold function), and its listing lands first. That one delivery's count
  // is first-hand and newer; the order's answer is still every OTHER
  // delivery's count. Dropping the whole answer left them all on an empty
  // paperclip — "Attach a ticket or invoice" over tickets that are there —
  // until the order was collapsed and opened again.
  const surfaces = ['tbl', 'card'].map(() => ['L1', 'dr-row1', 'L3'].map(l =>
    `<button class="line-clip" data-clip-po="po1" data-clip-line="${l}"></button>`).join('')).join('');
  const late = hold();
  const s = pageSandbox({
    orders: ORDERS, body: surfaces,
    answer: path => (/poLineCounts=1/.test(path) ? late.p
      : /poLineId=L1/.test(path) ? { documents: [{ id: 'dA', filename: 'inv-77.pdf', po_ids: ['po1'], po_line_ids: ['po1:L1'] }] }
      : { documents: [] }),
  });
  const slow = s.run('loadLineDocCounts(purchaseOrders[0])');
  await settleAll();
  await s.run("openDocs('po1', 'L1')");
  assert('fixture: the delivery\'s sheet counted it first-hand', s.run("lineDocCount('po1', 'L1')") === 1);
  late.release({ counts: { po1: { L1: 5, 'dr-row1': 2, L3: 1 } } });
  const took = await slow;
  const clip = l => [...s.doc.querySelectorAll('.line-clip')].filter(b => b.dataset.clipLine === l);
  assert('an order\'s count that left before one delivery\'s sheet still counts the order\'s other deliveries',
    took === true && s.run("lineDocCount('po1', 'dr-row1')") === 2 && s.run("lineDocCount('po1', 'L3')") === 1,
    `${took} / ${s.run("JSON.stringify(lineDocCounts.po1)")}`);
  assert('  keeping the sheet\'s own, newer count for its delivery', s.run("lineDocCount('po1', 'L1')") === 1,
    String(s.run("lineDocCount('po1', 'L1')")));
  assert('  and paints every one of them, on both surfaces',
    clip('dr-row1').length === 2 && clip('dr-row1').every(b => b.textContent === '\u{1F4CE}2' && b.classList.contains('has'))
      && clip('L3').every(b => b.textContent === '\u{1F4CE}1') && clip('L1').every(b => b.textContent === '\u{1F4CE}1'),
    clip('dr-row1').concat(clip('L3'), clip('L1')).map(b => b.outerHTML).join(' '));

  // An order-wide answer asked for after it is newer than both, and wins outright.
  const later = hold();
  const s2 = pageSandbox({ orders: ORDERS, answer: path => (/poLineCounts=1/.test(path) ? later.p : { documents: [] }) });
  s2.run("setLineDocCount('po1', 'L1', 4)");
  const fresh = s2.run('loadLineDocCounts(purchaseOrders[0])');
  later.release({ counts: { po1: { 'dr-row1': 1 } } });
  assert('a count asked for after a delivery was counted first-hand is taken for that delivery too',
    await fresh === true && s2.run("lineDocCount('po1', 'L1')") === 0 && s2.run("lineDocCount('po1', 'dr-row1')") === 1,
    s2.run("JSON.stringify(lineDocCounts.po1)"));

  // Two order-wide counts out at once: the later one, landing first, still wins.
  const first = hold(), second = hold();
  let n = 0;
  const s3 = pageSandbox({ orders: ORDERS, answer: path => (/poLineCounts=1/.test(path) ? (++n === 1 ? first.p : second.p) : {}) });
  const a = s3.run('loadLineDocCounts(purchaseOrders[0])');
  const b = s3.run('loadLineDocCounts(purchaseOrders[0])');
  await settleAll();
  second.release({ counts: { po1: { L1: 2 } } });
  await b;
  first.release({ counts: { po1: { L1: 9, L3: 9 } } });
  assert('an order\'s older count never overwrites a newer count of the same order',
    await a === false && s3.run("lineDocCount('po1', 'L1')") === 2 && s3.run("lineDocCount('po1', 'L3')") === 0,
    s3.run("JSON.stringify(lineDocCounts.po1)"));
}

console.log('\n[a delivery\'s sheet]');
{
  const filesFor = { L1: [{ id: 'd9', filename: 'ticket.pdf', uploaded_by: 'sam', po_line_ids: ['po1:L1'] }] };
  const s = pageSandbox({
    orders: ORDERS,
    body: '<button class="line-clip" data-clip-po="po1" data-clip-line="L1"></button>',
    answer: path => {
      const m = path.match(/poLineId=([^&]+)/);
      if (m) return { documents: filesFor[decodeURIComponent(m[1])] || [] };
      return { documents: [
        { id: 'd9', filename: 'ticket.pdf', po_line_ids: ['po1:L1'] },
        { id: 'd8', filename: 'old.pdf', po_line_ids: ['po1:dr-gone'] },
        { id: 'd7', filename: 'quote.pdf', po_line_ids: [] },
        { id: 'd6', filename: 'other.pdf', po_line_ids: ['po11:L1'] },
      ] };
    },
  });
  await s.run("openDocs('po1', 'L1')");
  const sheet = s.doc.getElementById('docs-sheet');
  assert('it lists that delivery\'s files, through the order — what the carve-out is granted for',
    JSON.stringify(s.gets()) === JSON.stringify(['GET /documents?division=paving&poLineId=L1&poId=po1']),
    JSON.stringify(s.gets()));
  assert('  after settling the order\'s save', s.run('JSON.stringify(settled)') === JSON.stringify([{ po: 'po1', after: 0 }]));
  assert('  on the one sheet, locked the one way', s.run('locks') >= 1 && s.doc.getElementById('docs-backdrop') !== null);
  assert('  titled with the order and the delivery', sheet.querySelector('h2').textContent === 'PO-0042 · INV-77 — attachments',
    sheet.querySelector('h2').textContent);
  const open = sheet.querySelector('button[onclick^="openDoc("]');
  assert('  each file opened through its order', open && open.getAttribute('onclick') === "openDoc('paving','d9','po1')",
    open && open.getAttribute('onclick'));
  assert('  saying where else it is filed — the order, and the cost-code folder of the order\'s code',
    /on the order’s paperclip/.test(sheet.textContent) && /in the 420 cost-code folder/.test(sheet.textContent), sheet.textContent);
  const add = s.doc.getElementById('doc-add');
  assert('  attaching from it attaches to the delivery', add && add.getAttribute('onclick') === "addAttachment('po1','L1')",
    add && add.getAttribute('onclick'));
  const all = [...sheet.querySelectorAll('button')].find(b => /^All of/.test(b.textContent));
  assert('  with a way to the whole order\'s sheet', all && all.getAttribute('onclick') === "openDocs('po1')");
  assert('the list it fetched is the delivery\'s count', s.run("lineDocCount('po1', 'L1')") === 1);
  const clip = s.doc.querySelector('.line-clip');
  assert('  drawn on its paperclip in place', clip.textContent === '\u{1F4CE}1' && clip.classList.contains('has'));

  await s.run("openDocs('po1', 'dr-row1')");
  assert('a Daily Tracking delivery is filed under ITS row\'s code, and titled by its date',
    /in the Stormwater cost-code folder/.test(sheet.textContent) && /PO-0042 · 2026-11-03/.test(sheet.querySelector('h2').textContent),
    sheet.textContent);
  assert('  and listing nothing sets its count to nothing', s.run("lineDocCount('po1', 'dr-row1')") === 0 &&
    /Nothing attached yet/.test(sheet.textContent));
  await s.run("openDocs('po1', 'L3')");
  assert('a delivery with no ticket # and no date is just "Delivery"', /PO-0042 · Delivery/.test(sheet.querySelector('h2').textContent));
  await s.run("openDocs('po2', 'Q1')");
  assert('an order with no job has no cost-code folder to name', !/cost-code folder/.test(sheet.textContent) && /with no job/.test(sheet.textContent),
    sheet.textContent);

  await s.run("openDocs('po1')");
  const text = sheet.textContent;
  assert('the order\'s own sheet still lists through the order', s.gets()[s.gets().length - 1] === 'GET /documents?division=paving&poId=po1');
  // The line under each file's name.
  const meta = name => {
    const f = [...sheet.querySelectorAll('div')].find(d => !d.children.length && d.textContent === name);
    return f && f.nextElementSibling ? f.nextElementSibling.textContent : null;
  };
  assert('  and says which delivery a file hangs off', meta('ticket.pdf') === ' · delivery INV-77', meta('ticket.pdf'));
  assert('  or that its delivery has left the order', meta('old.pdf') === ' · a delivery no longer on this order', meta('old.pdf'));
  assert('  and nothing for a file on no delivery, or on another order\'s',
    meta('quote.pdf') === '' && meta('other.pdf') === '', JSON.stringify([meta('quote.pdf'), meta('other.pdf')]));
  assert('  attaching from it attaches to the order', s.doc.getElementById('doc-add').getAttribute('onclick') === "addAttachment('po1')");
  assert('  and it has no way "back" to an order it already is', !/All of/.test(text));
  assert('the order\'s count is the list it fetched, as before', s.run('docCounts.po1') === 4);

  const before = s.gets().length;
  await s.run("openDocs('po1', 'nope')");
  assert('a delivery no longer on the order says so, and shows the order\'s sheet — its files are the order\'s',
    /no longer on PO-0042/.test(s.run('toasts[toasts.length - 1]')) &&
    JSON.stringify(s.gets().slice(before)) === JSON.stringify(['GET /documents?division=paving&poId=po1']) &&
    sheet.querySelector('h2').textContent === 'PO-0042 — attachments', JSON.stringify(s.gets().slice(before)));
}
{
  const s = pageSandbox({ orders: ORDERS, canEdit: false, answer: () => ({ documents: [] }) });
  await s.run("openDocs('po1', 'L1')");
  assert('a viewer can read a delivery\'s sheet but is offered no attach', !s.doc.getElementById('doc-add') &&
    s.gets().length === 1);
}
{
  const s = pageSandbox({ orders: ORDERS, settle: async () => { throw new TypeError('Failed to fetch'); } });
  await s.run("openDocs('po1', 'L1')");
  const sheet = s.doc.getElementById('docs-sheet');
  assert('a delivery whose order cannot be saved says so, and asks for nothing it cannot have',
    /not saved yet/.test(sheet.textContent) && s.gets().length === 0, sheet.textContent);
  assert('  still offering the attach, which settles again first', Boolean(s.doc.getElementById('doc-add')));
}
{
  const first = hold();
  const s = pageSandbox({ orders: ORDERS, answer: path => (/poLineId=L1/.test(path) ? first.p : { documents: [] }) });
  const a = s.run("openDocs('po1', 'L1')");
  await settleAll();
  await s.run("openDocs('po1', 'L3')");
  first.release({ documents: [{ id: 'd1', filename: 'late.pdf' }] });
  await a;
  const sheet = s.doc.getElementById('docs-sheet');
  assert('a listing overtaken by another opening is not drawn over it',
    /PO-0042 · Delivery/.test(sheet.querySelector('h2').textContent) && !/late\.pdf/.test(sheet.textContent), sheet.textContent);
}
{
  const s = pageSandbox({ orders: ORDERS, answer: () => ({ documents: [] }) });
  s.run("_docsRetry = { poId: 'po1', lineId: 'L1', filename: 'held.jpg', unsure: true }");
  await s.run("openDocs('po1', 'L1')");
  const onLine = s.doc.getElementById('docs-sheet').textContent;
  await s.run("openDocs('po1')");
  const onOrder = s.doc.getElementById('docs-sheet').textContent;
  await s.run("openDocs('po1', 'L3')");
  const onOther = s.doc.getElementById('docs-sheet').textContent;
  assert('a file that did not attach to a delivery is offered again on that delivery\'s sheet',
    /held\.jpg may not have attached/.test(onLine), onLine);
  assert('  and not on the order\'s, or another delivery\'s', !/held\.jpg/.test(onOrder) && !/held\.jpg/.test(onOther));
  s.run("_docsRetry = { poId: 'po1', lineId: 'gone', filename: 'orphan.jpg', unsure: false }");
  await s.run("openDocs('po1')");
  assert('one held for a delivery that has since left the order is offered on the order\'s sheet',
    /orphan\.jpg did not attach/.test(s.doc.getElementById('docs-sheet').textContent));
  const clip = new JSDOM('<!doctype html><body>' + s.run("lineClipHTML(purchaseOrders[0], { invoice_num: 'x' })")).window.document;
  assert('a delivery with no id has no paperclip to attach to', !clip.querySelector('button'));
}

console.log('\n[the order is stored before a delivery gets a file]');
{
  const ctx = vm.createContext({ Promise, Error });
  vm.runInContext(`
    const _saveChain = {}, _saveTimers = {}, _savedDivision = {};
    const _unsaved = new Set();
    const saves = [], cleared = [];
    let failNext = false;
    function clearTimeout(id) { cleared.push(id); }
    async function _savePONow(po) {
      saves.push(po.id);
      if (failNext) { failNext = false; _unsaved.add(po.id); throw new Error('Failed to fetch'); }
      _savedDivision[po.id] = po._division;
      _unsaved.delete(po.id);
    }
  `, ctx);
  evalSlice('async ' + requireFn(PAGE, 'settleOrderSave', 'purchase-orders.html'), ctx, 'settleOrderSave');
  const run = e => vm.runInContext(e, ctx);
  const po = "({ id: 'po1', _division: 'paving' })";
  run("_savedDivision.po1 = 'paving'");
  await run(`settleOrderSave(${po})`);
  assert('an order with nothing owed is not saved again', run('saves.length') === 0);
  run('_saveTimers.po1 = 41');
  await run(`settleOrderSave(${po})`);
  assert('a delivery still in its save\'s debounce is saved now',
    run('saves.length') === 1 && run('JSON.stringify(cleared)') === '[41]' && run("'po1' in _saveTimers") === false);
  run("_unsaved.add('po1')");
  await run(`settleOrderSave(${po})`);
  assert('so is one whose save failed and is waiting for the retry', run('saves.length') === 2);
  await run(`settleOrderSave({ id: 'po2', _division: 'turf' })`);
  assert('and one never stored in its list — a new order, or one being moved', run("saves[saves.length - 1]") === 'po2');
  let landed = false;
  run('var inflight = null');
  ctx.__mark = () => { landed = true; };
  run("_saveChain.po1 = new Promise(r => { inflight = () => { __mark(); r(); }; })");
  const waiting = run(`settleOrderSave(${po})`);
  await settleAll();
  const savesBefore = run('saves.length');
  run('inflight()');
  await waiting;
  assert('a save in flight is waited out, and nothing more sent when it lands',
    landed && run('saves.length') === savesBefore);
  run("_saveChain.po1 = Promise.resolve(); _unsaved.add('po1'); failNext = true");
  let err = null;
  try { await run(`settleOrderSave(${po})`); } catch (e) { err = e; }
  assert('a save that fails fails the settle, so nothing is filed against a delivery the server lacks',
    err && /Failed to fetch/.test(err.message));
}

console.log('\n[opening an order counts its deliveries]');
{
  const ctx = vm.createContext({});
  vm.runInContext(`
    const purchaseOrders = [{ id: 'po1', _division: 'paving', lines: [] }];
    const expanded = new Set();
    const counted = [];
    let renders = 0;
    function loadLineDocCounts(po) { counted.push(po.id); }
    function render() { renders++; }
  `, ctx);
  vm.runInContext(requireFn(PAGE, 'toggleLines', 'purchase-orders.html'), ctx);
  const run = e => vm.runInContext(e, ctx);
  run("toggleLines('po1')");
  assert('opening an order\'s deliveries counts their files', run('JSON.stringify(counted)') === '["po1"]' && run('renders') === 1);
  run("toggleLines('po1')");
  assert('  and closing them asks nothing', run('counted.length') === 1 && run('renders') === 2);
  run("toggleLines('po1')");
  assert('  opening again counts again, so a colleague\'s attachment shows', run('counted.length') === 2);
  assert('the counts are asked per order, never division-wide — the carve-out answers no other way',
    /'&poLineCounts=1&poId=' \+ encodeURIComponent\(po\.id\)/.test(requireFn(PAGE, 'loadLineDocCounts', 'purchase-orders.html')) &&
    !/poLineCounts/.test(requireFn(PAGE, 'loadDocCounts', 'purchase-orders.html')));
}

console.log('\n[the callers use all of it]');
{
  const add = requireFn(PAGE, 'addAttachment', 'purchase-orders.html');
  assert('the paperclip sheet prepares the file before attaching it — to the delivery, from a delivery\'s sheet',
    /prepared = await prepareAttachment\(file\);\s*\n\s*await attachToPO\(po, prepared\.blob, prepared\.filename, \{ lineId \}\);/.test(add), add);
  assert('and no longer lets a photo that will not decode end the attach', !/downscaleImage/.test(add));
  assert('a file it could not attach is kept, with where it was going and whether it may have landed',
    /_docsRetry = \{ poId, lineId, blob: prepared\.blob, filename: prepared\.filename, unsure: Boolean\(err\.unconfirmed\) \};/.test(add), add);
  const open = requireFn(PAGE, 'openDocs', 'purchase-orders.html');
  assert('  and offered again on the sheet it came from', /docsRetryHTML\(po, lineId\)/.test(open));
  const again = requireFn(PAGE, 'retryDocsAttach', 'purchase-orders.html');
  assert('  sending the SAME file to the same place, so the check-first applies',
    /await attachToPO\(po, held\.blob, held\.filename, \{ lineId: liveLineId\(po, held\.lineId\) \}\);/.test(again), again);
  const html = requireFn(PAGE, 'docsRetryHTML', 'purchase-orders.html');
  assert('  with its order id escaped into the handlers',
    (html.match(/jsAttr\(po\.id\)/g) || []).length === 2 && !/\(\\'' \+ po\.id/.test(html), html);

  const commit = requireFn(PAGE, 'commitScan', 'purchase-orders.html');
  assert('the scan sheet says "may not have attached" when that is the truth',
    /attachUnsure = Boolean\(err\.unconfirmed\)/.test(commit) && /the photo may not have attached/.test(commit));
  assert('a scanned receipt is filed on the delivery the scan just recorded',
    /attachToPO\(po, shotBlob, shotName, \{ note: 'Scanned receipt', lineId: line\.id \}\)/.test(commit), commit);
  assert('  and a photo kept for the retry remembers that delivery', /_attachRetry\.lineId = line\.id;/.test(commit));
  const retry = requireFn(PAGE, 'retryAttach', 'purchase-orders.html');
  assert('and its retry sends the same photo, so the check-first applies',
    /attachToPO\(po, _attachRetry\.blob, _attachRetry\.filename,/.test(retry), retry);
  assert('  to that delivery while it is still on the order, else to the order alone',
    /\{ note: 'Scanned receipt', lineId: liveLineId\(po, _attachRetry\.lineId\) \}/.test(retry), retry);
}

finished = true;
console.log(`\n${failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'}`);
process.exit(failed ? 1 : 0);
})().catch(err => {
  finished = true;
  console.error('\n  ✗ the run threw: ' + (err && err.stack || err));
  process.exit(1);
});
