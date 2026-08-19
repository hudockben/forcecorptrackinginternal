'use strict';
/**
 * Object storage adapter for the job document vault.
 *
 * File BYTES never pass through this API. Vercel caps a serverless request
 * body at 4.5 MB, which a phone photo clears on its own and a set of drawings
 * blows past — so the browser uploads straight to the object store using a
 * presigned URL minted here, and only the metadata round-trips through
 * api/documents.js.
 *
 * Deliberately dependency-free: AWS SigV4 presigning is a few dozen lines of
 * node:crypto, and it speaks to every S3-compatible store (Cloudflare R2,
 * AWS S3, MinIO, Backblaze B2). The alternative — Vercel Blob's client-upload
 * flow — needs an SDK `import` in the browser, and the division pages are
 * plain <script> tags with no bundler to resolve one.
 *
 * Required env:
 *   S3_ENDPOINT           https://<account>.r2.cloudflarestorage.com
 *   S3_BUCKET             forcecorp-documents
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 * Optional:
 *   S3_REGION             defaults to 'auto' (what R2 expects)
 *   S3_MAX_UPLOAD_BYTES   defaults to 100 MB
 */
const crypto = require('crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE   = 's3';

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Extension → MIME. Anything not on this list is refused: the vault holds
// jobsite paperwork and photos, not arbitrary binaries. Mirrors the allowlist
// idiom in api/lib/email.js.
const ALLOWED_TYPES = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  csv:  'text/csv',
  txt:  'text/plain',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:  'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  msg:  'application/vnd.ms-outlook',
  eml:  'message/rfc822',
  dwg:  'image/vnd.dwg',
  zip:  'application/zip',
};

function config() {
  const endpoint = process.env.S3_ENDPOINT || '';
  const bucket   = process.env.S3_BUCKET   || '';
  const keyId    = process.env.S3_ACCESS_KEY_ID || '';
  const secret   = process.env.S3_SECRET_ACCESS_KEY || '';
  const region   = process.env.S3_REGION || 'auto';
  const maxBytes = parseInt(process.env.S3_MAX_UPLOAD_BYTES, 10) || DEFAULT_MAX_UPLOAD_BYTES;
  return { endpoint, bucket, keyId, secret, region, maxBytes };
}

/**
 * True when the deployment has storage credentials. Callers use this to fail
 * with a clear "storage is not configured" instead of a signature error.
 */
function isConfigured() {
  const c = config();
  return Boolean(c.endpoint && c.bucket && c.keyId && c.secret);
}

function maxUploadBytes() {
  return config().maxBytes;
}

function extensionOf(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/**
 * Resolve the MIME type to store a file under, or null when the extension is
 * not on the allowlist. The browser's reported type is not trusted — the
 * extension decides, so a .exe renamed in a form post cannot smuggle itself
 * in behind an image/png content type.
 */
function mimeFor(filename) {
  return ALLOWED_TYPES[extensionOf(filename)] || null;
}

function allowedExtensions() {
  return Object.keys(ALLOWED_TYPES);
}

// RFC 3986. encodeURIComponent leaves ! ' ( ) * alone and SigV4 does not.
function uriEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

// Encode an object key for the URL path, preserving the / separators.
function encodeKey(key) {
  return String(key).split('/').map(uriEncode).join('/');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secret, dateStamp, region) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, dateStamp), region), SERVICE), 'aws4_request');
}

// 20260818T140501Z / 20260818
function timestamps(now) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Build a presigned URL for one S3 operation.
 *
 * `extraQuery` carries response-header overrides (used to force a download
 * filename on GET). Payload is always UNSIGNED-PAYLOAD: the browser holds the
 * bytes, so this process can never hash them.
 */
function presign(method, key, { expiresIn = 900, extraQuery = {}, now = new Date() } = {}) {
  const { endpoint, bucket, keyId, secret, region } = config();
  if (!isConfigured()) throw new Error('Object storage is not configured');

  const url  = new URL(endpoint);
  const host = url.host;
  // Path-style addressing: <endpoint>/<bucket>/<key>. R2 and MinIO require it,
  // and S3 still accepts it.
  const canonicalUri = `${url.pathname.replace(/\/$/, '')}/${encodeKey(bucket)}/${encodeKey(key)}`;

  const { amzDate, dateStamp } = timestamps(now);
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;

  const query = {
    'X-Amz-Algorithm':     ALGORITHM,
    'X-Amz-Credential':    `${keyId}/${scope}`,
    'X-Amz-Date':          amzDate,
    'X-Amz-Expires':       String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
    ...extraQuery,
  };

  const canonicalQuery = Object.keys(query).sort()
    .map(k => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(secret, dateStamp, region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Presigned PUT the browser uploads to directly.
 *
 * Content-Type is intentionally NOT a signed header. Signing it would force
 * the browser to send a byte-identical value, and phones disagree with the
 * server about HEIC often enough that it is not worth the failed uploads —
 * the extension allowlist in mimeFor() is what actually gates the file.
 */
function presignUpload(key, { expiresIn = 900 } = {}) {
  return presign('PUT', key, { expiresIn });
}

/**
 * Presigned GET, short-lived. `filename` sets the download name.
 *
 * `contentType` is not optional in spirit: presignUpload deliberately leaves
 * Content-Type unsigned, so whoever performs the PUT chooses what the store
 * records against the object. Without an override the store replays that
 * choice, and a file registered as application/pdf (the extension is what
 * decides project_documents.content_type) can come back as text/html and be
 * rendered inline. Overriding it here means the type the database believes is
 * the type the browser is handed, whatever is actually stored.
 */
function presignDownload(key, { filename, contentType, expiresIn = 300, inline = false } = {}) {
  const extraQuery = {};
  if (filename) {
    const disp = inline ? 'inline' : 'attachment';
    // Strip quotes, backslashes, and anything that could end the header value
    // early — a filename is user input and this lands in a response header.
    const safe = String(filename).replace(/[\r\n"\\]/g, '_');
    extraQuery['response-content-disposition'] = `${disp}; filename="${safe}"`;
  }
  if (contentType) {
    extraQuery['response-content-type'] = String(contentType);
  }
  return presign('GET', key, { expiresIn, extraQuery });
}

/**
 * Ask the store what it actually holds at `key`.
 *
 * Returns { exists, size, contentType }. The upload flow declares a size twice
 * — once when minting the ticket and again when registering — and neither is
 * binding: the presigned PUT signs only `host`, so nothing bounds the body the
 * browser sends. This is the only way to learn the truth, and it is also how
 * registration confirms an object was uploaded at all rather than trusting a
 * caller who skipped step 2.
 *
 * Resolves { exists: false } on any error, so a store hiccup fails the
 * registration rather than silently recording a fabricated size.
 */
async function headObject(key) {
  try {
    const url = presign('HEAD', key, { expiresIn: 60 });
    const r = await fetch(url, { method: 'HEAD' });
    if (!r.ok) return { exists: false, size: 0, contentType: null };
    return {
      exists: true,
      size: parseInt(r.headers.get('content-length'), 10) || 0,
      contentType: r.headers.get('content-type') || null,
    };
  } catch (err) {
    console.warn(`[storage] head failed for ${key}: ${err.message}`);
    return { exists: false, size: 0, contentType: null };
  }
}

/**
 * Permanently remove an object. Called by the 30-day purge sweep, never by an
 * interactive delete — those only set project_documents.deleted_at.
 * Resolves false on failure rather than throwing so a purge run can continue.
 */
async function deleteObject(key) {
  try {
    const url = presign('DELETE', key, { expiresIn: 60 });
    const r = await fetch(url, { method: 'DELETE' });
    // A 404 usually means NoSuchKey — the object was already gone, which is
    // the outcome we wanted. But S3 and R2 also answer 404 for NoSuchBucket,
    // and treating that as success would let the purge sweep delete every
    // metadata row while the real objects survive in the real bucket,
    // unreferenced and invisible to every later run. Read the body to tell
    // them apart.
    if (r.status === 404) {
      let body = '';
      try { body = await r.text(); } catch { /* opaque */ }
      if (/NoSuchBucket|NoSuchHost|InvalidBucketName/i.test(body)) {
        console.warn(`[storage] delete for ${key} hit a missing bucket — not treating as deleted`);
        return false;
      }
      return true;
    }
    return r.ok;
  } catch (err) {
    console.warn(`[storage] delete failed for ${key}: ${err.message}`);
    return false;
  }
}

/**
 * Storage path for a document. Company and division lead so a bucket listing
 * is browsable and a per-company lifecycle rule stays possible; the document
 * id keeps two files of the same name apart.
 */
// One path segment of an object key. Anything outside [A-Za-z0-9._-] becomes
// '_', dot runs collapse, and leading dots go — so no caller-supplied value can
// contribute a '..' or a '/' to the key. projectId in particular is raw request
// input on both endpoints that build a key, and project_id has no format
// constraint in the schema, so 'FCT/turf/../../OTH/...' was reachable without
// touching the storageKey the recompute guard checks.
function safeSegment(value, fallback) {
  const out = String(value == null ? '' : value)
    .replace(/[^\w.\-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(-120);
  return out || fallback;
}

function buildKey({ companyCode, division, projectId, documentId, filename }) {
  // Every segment is sanitized, not just the filename. A '..' anywhere in the
  // key is normalized away by WHATWG URL parsing in fetch before the request
  // is sent, which on a store that canonicalizes before verifying SigV4 lands
  // the write in a different prefix entirely.
  return [
    safeSegment(companyCode, 'unknown'),
    safeSegment(division, 'unknown'),
    safeSegment(projectId, 'general'),
    safeSegment(documentId, 'doc'),
    safeSegment(filename, 'file'),
  ].join('/');
}

module.exports = {
  isConfigured,
  safeSegment,
  maxUploadBytes,
  mimeFor,
  extensionOf,
  allowedExtensions,
  presignUpload,
  presignDownload,
  headObject,
  deleteObject,
  buildKey,
  // exported for scripts/test-document-storage.js
  _presign: presign,
  _uriEncode: uriEncode,
};
