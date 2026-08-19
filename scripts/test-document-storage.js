#!/usr/bin/env node
'use strict';
/**
 * Unit test for api/lib/storage.js — the presigner behind document uploads.
 *
 * Run: node scripts/test-document-storage.js
 *
 * No network and no database. The signature chain is checked against the
 * example AWS publishes for query-string auth, then the module's own presign
 * output is re-derived by an independent implementation written straight from
 * the spec — if canonical-request assembly (ordering, encoding, the trailing
 * newline on canonical headers) ever drifts, these disagree.
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.S3_ENDPOINT          = 'https://acct123.r2.cloudflarestorage.com';
process.env.S3_BUCKET            = 'forcecorp-documents';
process.env.S3_ACCESS_KEY_ID     = 'AKIAIOSFODNN7EXAMPLE';
process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env.S3_REGION            = 'auto';

const storage = require('../api/lib/storage.js');

let passed = 0;
function ok(label) { console.log(`  ok  ${label}`); passed++; }

// ── 1. The AWS-published vector ────────────────────────────────────────────
// docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
{
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const amzDate = '20130524T000000Z', dateStamp = '20130524', region = 'us-east-1';
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const canonicalQuery = [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    'X-Amz-Credential=' + encodeURIComponent(`AKIAIOSFODNN7EXAMPLE/${scope}`),
    `X-Amz-Date=${amzDate}`,
    'X-Amz-Expires=86400',
    'X-Amz-SignedHeaders=host',
  ].join('&');
  const canonicalRequest = [
    'GET', '/test.txt', canonicalQuery,
    'host:examplebucket.s3.amazonaws.com\n', 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const h = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
  const kSign = h(h(h(h('AWS4' + secret, dateStamp), region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSign).update(stringToSign, 'utf8').digest('hex');

  assert.strictEqual(sig, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  ok('SigV4 chain reproduces the AWS-published signature');
}

// ── 2. The module's presign, re-derived independently ──────────────────────
{
  const now = new Date(Date.UTC(2026, 7, 18, 14, 5, 1));
  const key = 'FORCE/turf/proj-7/doc-42/delivery ticket.pdf';
  const url = storage._presign('PUT', key, { expiresIn: 900, now });

  // Independent re-derivation, written from the spec rather than reusing the
  // module's helpers.
  const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const encPath = s => s.split('/').map(enc).join('/');
  const amzDate = '20260818T140501Z', dateStamp = '20260818';
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = `/${encPath('forcecorp-documents')}/${encPath(key)}`;
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `AKIAIOSFODNN7EXAMPLE/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '900',
    'X-Amz-SignedHeaders': 'host',
  };
  const cq = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join('&');
  const cr = ['PUT', canonicalUri, cq, 'host:acct123.r2.cloudflarestorage.com\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope,
    crypto.createHash('sha256').update(cr, 'utf8').digest('hex')].join('\n');
  const h = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
  const kSign = h(h(h(h('AWS4wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', dateStamp), 'auto'), 's3'), 'aws4_request');
  const expected = crypto.createHmac('sha256', kSign).update(sts, 'utf8').digest('hex');

  assert.ok(url.includes(`X-Amz-Signature=${expected}`), `signature mismatch:\n  ${url}`);
  ok('presign() matches an independent implementation');

  // Path-style addressing — R2 and MinIO reject virtual-host style.
  assert.ok(url.startsWith('https://acct123.r2.cloudflarestorage.com/forcecorp-documents/FORCE/turf/'),
    `expected path-style URL, got ${url}`);
  ok('uses path-style addressing with the bucket in the path');

  // Slashes stay slashes; the space in the filename does not.
  assert.ok(url.includes('/doc-42/delivery%20ticket.pdf?'), 'key encoding mangled the path');
  ok('key encoding preserves / and escapes the rest');
}

// ── 3. Query ordering with a response-header override ──────────────────────
// SigV4 sorts by byte order, so every X-Amz-* param precedes
// response-content-disposition. Getting this backwards yields a signature the
// store rejects, and only for downloads — the failure would ship.
{
  const now = new Date(Date.UTC(2026, 7, 18, 14, 5, 1));
  const url = storage.presignDownload('FORCE/turf/p/d/ticket.pdf', { filename: 'ticket.pdf', now });
  const qs = url.slice(url.indexOf('?') + 1).split('&').map(p => p.split('=')[0]);
  const withoutSig = qs.filter(k => k !== 'X-Amz-Signature');
  assert.deepStrictEqual(withoutSig, [...withoutSig].sort(),
    `query params are not in sorted byte order: ${withoutSig.join(', ')}`);
  assert.strictEqual(qs[qs.length - 1], 'X-Amz-Signature', 'signature must be appended last');
  ok('download presign keeps query params in signed order');

  assert.ok(url.includes('response-content-disposition=attachment'), 'missing download disposition');
  ok('download forces attachment disposition');
}

// ── 4. Extension allowlist ─────────────────────────────────────────────────
{
  assert.strictEqual(storage.mimeFor('ticket.pdf'), 'application/pdf');
  assert.strictEqual(storage.mimeFor('IMG_0042.HEIC'), 'image/heic');
  assert.strictEqual(storage.mimeFor('photo.jpeg'), 'image/jpeg');
  ok('allowlisted extensions resolve to a MIME type');

  assert.strictEqual(storage.mimeFor('payload.exe'), null);
  assert.strictEqual(storage.mimeFor('shell.sh'), null);
  assert.strictEqual(storage.mimeFor('noextension'), null);
  // The classic bypass: a double extension. Only the last one is read.
  assert.strictEqual(storage.mimeFor('invoice.pdf.exe'), null);
  ok('non-allowlisted extensions are refused, including double extensions');
}

// ── 5. Storage keys ────────────────────────────────────────────────────────
{
  const k = storage.buildKey({
    companyCode: 'FORCE', division: 'turf', projectId: 'proj-7',
    documentId: 'doc-42', filename: '../../etc/passwd',
  });
  assert.ok(!k.includes('..'), `path traversal survived into the key: ${k}`);
  assert.ok(k.startsWith('FORCE/turf/proj-7/doc-42/'), `unexpected key shape: ${k}`);
  ok('buildKey strips path traversal out of the filename');

  const g = storage.buildKey({
    companyCode: 'FORCE', division: 'turf', projectId: null,
    documentId: 'doc-9', filename: 'shop.pdf',
  });
  assert.strictEqual(g, 'FORCE/turf/general/doc-9/shop.pdf');
  ok('a null project_id keys into the division-level general area');
}

// ── 6. Unconfigured deployments fail loudly ────────────────────────────────
{
  const saved = process.env.S3_BUCKET;
  delete process.env.S3_BUCKET;
  assert.strictEqual(storage.isConfigured(), false);
  assert.throws(() => storage.presignUpload('a/b'), /not configured/);
  process.env.S3_BUCKET = saved;
  assert.strictEqual(storage.isConfigured(), true);
  ok('missing credentials raise "not configured" rather than a bad signature');
}

console.log(`\n${passed} assertions passed.`);
