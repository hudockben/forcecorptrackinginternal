#!/usr/bin/env node
'use strict';
/**
 * Test for the relay arm of /api/document-upload-url — PUT.
 *
 * Run: node scripts/test-document-upload-relay.js
 *
 * The browser is supposed to PUT file bytes straight to the bucket, and that
 * is what keeps a drawing set off a 4.5 MB request body. But PUT is not a
 * CORS-safelisted method, so that upload always needs a preflight, and a
 * bucket with no CORS rule refuses it before the request leaves the browser —
 * every upload in every division dies as "Failed to fetch" and nothing on the
 * server ever hears about it. The relay is the same-origin fallback for small
 * files.
 *
 * A fallback that skipped the checks the direct path applies would be a hole:
 * the containment on the key, the extension allowlist and the size ceiling are
 * most of what is asserted here. No network and no database — auth is stubbed
 * and the store is a fake fetch, so the real presigner still runs.
 */
const assert = require('assert');
const path   = require('path');

process.env.S3_ENDPOINT          = 'https://acct123.r2.cloudflarestorage.com';
process.env.S3_BUCKET            = 'forcecorp-documents';
process.env.S3_ACCESS_KEY_ID     = 'AKIAIOSFODNN7EXAMPLE';
process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env.S3_REGION            = 'auto';

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.error(`  ✗ ${label}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`);
}

// ── Stubs ─────────────────────────────────────────────────────────────────
const endpointPath = path.resolve(__dirname, '../api/document-upload-url.js');
const authPath     = path.resolve(__dirname, '../api/lib/auth.js');
const neonPath     = require.resolve('@neondatabase/serverless');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub/neondb';

function loadEndpoint({ canUpload = true, companyCode = 'FORCE', division = 'paving',
                        keyClaimed = false } = {}) {
  delete require.cache[endpointPath];
  delete require.cache[authPath];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: {
      requireDivision: () => ({ payload: { companyCode, userId: 'u1' }, division }),
      capabilities:    () => ({ canUpload }),
    },
  };
  // The relay's one query — does a document row already claim this key.
  delete require.cache[neonPath];
  require.cache[neonPath] = {
    id: neonPath, filename: neonPath, loaded: true,
    exports: { neon: () => async () => (keyClaimed ? [{ id: 'doc-existing' }] : []) },
  };
  return require(endpointPath);
}

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o)   { this.body = o; return this; },
    end()     { return this; },
  };
}

// Stand-in object store. Records what reached it; answers however the test asks.
function fakeStore({ status = 200, body = '' } = {}) {
  const seen = [];
  global.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method, body: init.body, headers: init.headers || {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      headers: { get: () => null },
    };
  };
  return seen;
}

const KEY  = 'FORCE/paving/p1/doc-new/INDIANA BORO LOT PREP PAVING CR.pdf';
const FILE = Buffer.from('%PDF-1.7 pretend paving change order');

(async () => {
  console.log('\n[relay — the happy path]');
  {
    const handler = loadEndpoint();
    const seen = fakeStore();
    const res  = makeRes();
    await handler(
      { method: 'PUT', query: { division: 'paving' }, headers: {},
        body: { storageKey: KEY, contentBase64: FILE.toString('base64') } },
      res,
    );
    check('the relay reports success', res.statusCode === 200 && res.body && res.body.ok === true,
      JSON.stringify(res.body));
    check('and the byte count it actually wrote', res.body && res.body.bytes === FILE.length,
      JSON.stringify(res.body));
    check('exactly one write reached the store', seen.length === 1, String(seen.length));
    check('as a PUT', seen[0] && seen[0].method === 'PUT');
    check('to the presigned URL for that key, path-style',
      seen[0] && seen[0].url.startsWith(
        'https://acct123.r2.cloudflarestorage.com/forcecorp-documents/FORCE/paving/p1/doc-new/'),
      seen[0] && seen[0].url);
    check('signed, not a bare URL', seen[0] && seen[0].url.includes('X-Amz-Signature='));
    check('the bytes arrive intact, not re-encoded',
      Buffer.isBuffer(seen[0].body) && seen[0].body.equals(FILE),
      seen[0] && String(seen[0].body).slice(0, 60));
    check('stored under the type the extension implies',
      seen[0] && seen[0].headers['Content-Type'] === 'application/pdf',
      JSON.stringify(seen[0] && seen[0].headers));
  }

  console.log('\n[relay — what it refuses]');

  // A relay is not tied to the ticket that minted the key, so the key it is
  // handed is raw request input and gets the same containment the DELETE arm
  // applies. Without this, any signed-in user could write into any company.
  for (const [label, key] of [
    ["another company's prefix", 'OTHER/paving/p1/doc-1/x.pdf'],
    ["another division's prefix", 'FORCE/turf/p1/doc-1/x.pdf'],
    ['a traversal out of the prefix', 'FORCE/paving/../../OTHER/turf/x.pdf'],
  ]) {
    const handler = loadEndpoint();
    const seen = fakeStore();
    const res  = makeRes();
    await handler(
      { method: 'PUT', query: {}, headers: {},
        body: { storageKey: key, contentBase64: FILE.toString('base64') } },
      res,
    );
    check(`refuses ${label}`, res.statusCode === 400 && seen.length === 0,
      `${res.statusCode} ${JSON.stringify(res.body)}`);
  }

  // The extension decides the type on the direct path too — a relay that
  // skipped the allowlist would be the way around it.
  {
    const handler = loadEndpoint();
    const seen = fakeStore();
    const res  = makeRes();
    await handler(
      { method: 'PUT', query: {}, headers: {},
        body: { storageKey: 'FORCE/paving/p1/doc-1/payload.exe', contentBase64: FILE.toString('base64') } },
      res,
    );
    check('refuses a file type the allowlist does not carry',
      res.statusCode === 400 && seen.length === 0, JSON.stringify(res.body));
  }

  // Buffer.from(str, 'base64') drops anything outside the alphabet instead of
  // failing, so an unchecked body would land a silently corrupted file.
  {
    const handler = loadEndpoint();
    const seen = fakeStore();
    const res  = makeRes();
    await handler(
      { method: 'PUT', query: {}, headers: {}, body: { storageKey: KEY, contentBase64: 'not base64!!' } },
      res,
    );
    check('refuses a body that is not base64 rather than storing the salvage',
      res.statusCode === 400 && seen.length === 0, JSON.stringify(res.body));
  }

  {
    const handler = loadEndpoint();
    const seen = fakeStore();
    const res  = makeRes();
    await handler({ method: 'PUT', query: {}, headers: {}, body: { storageKey: KEY } }, res);
    check('refuses an empty body', res.statusCode === 400 && seen.length === 0, JSON.stringify(res.body));
  }

  // A relayed key is raw request input, unlike a minted one — and the listing
  // hands out the keys of everyone's files in the division. Without this a user
  // with upload rights could overwrite a colleague's document in place.
  {
    const handler = loadEndpoint({ keyClaimed: true });
    const seen = fakeStore();
    const res  = makeRes();
    await handler(
      { method: 'PUT', query: {}, headers: {}, body: { storageKey: KEY, contentBase64: FILE.toString('base64') } },
      res,
    );
    check('refuses a key a document row already claims',
      res.statusCode === 409 && seen.length === 0, `${res.statusCode} ${JSON.stringify(res.body)}`);
  }

  // Past the ceiling the direct PUT is the only way through, so the answer has
  // to be the bucket's CORS rule — not a bigger relay.
  {
    const handler = loadEndpoint();
    const seen = fakeStore();
    const res  = makeRes();
    const big  = Buffer.alloc(3 * 1024 * 1024 + 1, 0x41);
    await handler(
      { method: 'PUT', query: {}, headers: {}, body: { storageKey: KEY, contentBase64: big.toString('base64') } },
      res,
    );
    check('refuses a file past the relay ceiling', res.statusCode === 413 && seen.length === 0,
      `${res.statusCode} ${JSON.stringify(res.body)}`);
    check('and names the real fix rather than the symptom',
      res.body && /CORS/.test(res.body.error), JSON.stringify(res.body));
  }

  // A deployment that tightened S3_MAX_UPLOAD_BYTES meant it for every path.
  {
    process.env.S3_MAX_UPLOAD_BYTES = '16';
    const handler = loadEndpoint();
    const seen = fakeStore();
    const res  = makeRes();
    await handler(
      { method: 'PUT', query: {}, headers: {}, body: { storageKey: KEY, contentBase64: FILE.toString('base64') } },
      res,
    );
    check('honours a lowered S3_MAX_UPLOAD_BYTES', res.statusCode === 413 && seen.length === 0,
      `${res.statusCode} ${JSON.stringify(res.body)}`);
    delete process.env.S3_MAX_UPLOAD_BYTES;
  }

  // Same test /api/documents applies to the matching POST.
  {
    const handler = loadEndpoint({ canUpload: false });
    const seen = fakeStore();
    const res  = makeRes();
    await handler(
      { method: 'PUT', query: {}, headers: {}, body: { storageKey: KEY, contentBase64: FILE.toString('base64') } },
      res,
    );
    check('a view-only user cannot relay either', res.statusCode === 403 && seen.length === 0,
      `${res.statusCode} ${JSON.stringify(res.body)}`);
  }

  {
    delete process.env.S3_BUCKET;
    const handler = loadEndpoint();
    const res = makeRes();
    fakeStore();
    await handler(
      { method: 'PUT', query: {}, headers: {}, body: { storageKey: KEY, contentBase64: FILE.toString('base64') } },
      res,
    );
    check('an unconfigured deployment says so instead of signing nothing',
      res.statusCode === 503, `${res.statusCode} ${JSON.stringify(res.body)}`);
    process.env.S3_BUCKET = 'forcecorp-documents';
  }

  console.log('\n[relay — the diagnosis it exists to produce]');

  // The whole reason this is worth having beyond the upload itself: a direct
  // PUT tells the browser only "Failed to fetch". Here the store answers.
  {
    const handler = loadEndpoint();
    fakeStore({ status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' });
    const res = makeRes();
    await handler(
      { method: 'PUT', query: {}, headers: {}, body: { storageKey: KEY, contentBase64: FILE.toString('base64') } },
      res,
    );
    check('a refusal comes back as 502, not a fabricated success', res.statusCode === 502,
      `${res.statusCode} ${JSON.stringify(res.body)}`);
    check('carrying what the store actually said',
      res.body && /403/.test(res.body.detail) && /SignatureDoesNotMatch/.test(res.body.detail),
      JSON.stringify(res.body));
  }

  {
    const handler = loadEndpoint();
    global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND acct123.r2.cloudflarestorage.com'); };
    const res = makeRes();
    await handler(
      { method: 'PUT', query: {}, headers: {}, body: { storageKey: KEY, contentBase64: FILE.toString('base64') } },
      res,
    );
    check('an unreachable endpoint is reported, not swallowed',
      res.statusCode === 502 && /ENOTFOUND/.test(res.body.detail), JSON.stringify(res.body));
  }

  console.log('\n[the direct path is untouched]');
  {
    const handler = loadEndpoint();
    fakeStore();
    const res = makeRes();
    await handler(
      { method: 'POST', query: {}, headers: {}, body: { filename: 'ticket.pdf', projectId: 'p1' } },
      res,
    );
    check('POST still mints a presigned URL', res.statusCode === 200 && res.body && res.body.uploadUrl,
      JSON.stringify(res.body && Object.keys(res.body)));
    check('keyed inside the caller\'s own company and division',
      res.body.storageKey.startsWith('FORCE/paving/p1/'), res.body.storageKey);
    check('and PUT is advertised alongside POST and DELETE',
      /PUT/.test(res.headers['Access-Control-Allow-Methods']),
      res.headers['Access-Control-Allow-Methods']);
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})();
