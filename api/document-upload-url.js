'use strict';
/**
 * Mints a short-lived presigned PUT so the browser can upload a document
 * straight to object storage.
 *
 * POST /api/document-upload-url?division=turf
 *   body { filename, projectId?, sizeBytes? }
 *   →    { documentId, storageKey, uploadUrl, contentType, maxBytes }
 *
 * PUT /api/document-upload-url?division=turf&...
 *   body { storageKey, contentBase64 }
 *   →    { ok, bytes, relayed }
 *
 * Vercel caps a serverless request body at 4.5 MB, which a single phone photo
 * can exceed — so bytes never come through this API at all. The browser PUTs
 * them to `uploadUrl`, then POSTs the metadata to /api/documents to register
 * the file. A ticket minted here and never used costs nothing: no row is
 * written until that second call lands.
 *
 * The PUT arm is the exception, and only ever a fallback: see the comment on
 * that branch. It exists so a bucket that has not been given a CORS rule
 * breaks large uploads instead of all of them.
 */
const { requireDivision, capabilities } = require('./lib/auth');
const storage             = require('./lib/storage');
const crypto              = require('crypto');

const UPLOAD_WINDOW_SECONDS = 900; // 15 minutes — enough for a slow jobsite LTE upload

// Ceiling on the relay arm. The platform caps a serverless request body at
// 4.5 MB and base64 costs a third on top of the file, so 3 MB of actual file is
// about all that fits. Jobsite paperwork and a downscaled photo clear it
// comfortably; a drawing set does not, and has to have the bucket fixed.
const RELAY_MAX_BYTES = 3 * 1024 * 1024;

// Buffer.from(str, 'base64') silently drops anything outside the alphabet, so a
// truncated or corrupted body would decode to plausible-looking bytes and land
// a broken file in the bucket. Check the input instead.
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const guard = requireDivision(req, res);
  if (!guard) return;
  const { payload, division } = guard;
  const { companyCode } = payload;

  // Same capability test /api/documents applies to the matching POST — minting
  // an upload ticket a view-only user could never redeem just wastes a round
  // trip and hands them a writable URL.
  if (!capabilities(payload, division).canUpload) {
    return res.status(403).json({ error: 'You do not have permission to upload' });
  }

  if (!storage.isConfigured()) {
    return res.status(503).json({
      error: 'Document storage is not configured on this deployment. Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
    });
  }

  // ── DELETE — abandon an upload whose registration never landed ────────
  // Step 2 puts the bytes in the bucket and step 3 writes the row. When step 3
  // fails (a folder deleted underneath the user, an expired token, a cold-start
  // timeout) the object is already stored and nothing references it: the purge
  // sweep only walks project_documents, so it was billed forever and no tool
  // could find it. The browser calls this to clean up after itself.
  if (req.method === 'DELETE') {
    const key = String((req.query && req.query.storageKey) || '').trim();
    if (!key) return res.status(400).json({ error: 'storageKey is required' });

    // Only ever a key inside this caller's own company and division, and only
    // one that no document row claims — so this can never delete a live file.
    if (!key.startsWith(`${companyCode}/${division}/`) || key.includes('..')) {
      return res.status(400).json({ error: 'storageKey does not belong to this company' });
    }
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    const claimed = await sql`SELECT id FROM project_documents WHERE storage_key = ${key} LIMIT 1`;
    if (claimed.length) {
      return res.status(409).json({ error: 'That file is registered to a document and was not removed' });
    }

    const gone = await storage.deleteObject(key);
    return res.json({ ok: gone });
  }

  // ── PUT — relay a small file's bytes when the browser cannot reach the
  //          bucket itself ────────────────────────────────────────────────
  // PUT is not a CORS-safelisted method, so the browser's direct upload always
  // needs a preflight, and a bucket with no CORS rule refuses it. The request
  // never leaves the browser: nothing reaches any log here, and every upload in
  // every division dies as a bare "Failed to fetch". Nothing on the server can
  // detect that, let alone fix it, and until somebody edits the bucket the tab
  // is simply broken.
  //
  // This arm is same-origin, so no preflight and no CORS are involved at all.
  // It is a fallback and stays one — capped at RELAY_MAX_BYTES, well under the
  // platform's body limit, so the answer for a drawing set is still to give the
  // bucket its CORS rule rather than to route bytes through a function.
  if (req.method === 'PUT') {
    const relayBody = req.body || {};
    const key = String(relayBody.storageKey || '').trim();
    const b64 = String(relayBody.contentBase64 || '');
    if (!key) return res.status(400).json({ error: 'storageKey is required' });
    if (!b64) return res.status(400).json({ error: 'contentBase64 is required' });

    // The same containment the DELETE arm applies. A relayed write can only
    // ever land inside the caller's own company and division, whatever key they
    // send — the ticket minted above is not proof of anything by itself, since
    // nothing ties this request to that one.
    if (!key.startsWith(`${companyCode}/${division}/`) || key.includes('..')) {
      return res.status(400).json({ error: 'storageKey does not belong to this company' });
    }

    // The extension decides the stored type, never the caller — the same rule
    // mimeFor() enforces when the ticket is minted, so a relay cannot smuggle
    // in a file type the direct path would have refused.
    const relayType = storage.mimeFor(key);
    if (!relayType) {
      return res.status(400).json({
        error: `Files of that type cannot be uploaded. Allowed: ${storage.allowedExtensions().join(', ')}`,
      });
    }

    if (!BASE64_ONLY.test(b64)) {
      return res.status(400).json({ error: 'The relayed body is not valid base64' });
    }
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) return res.status(400).json({ error: 'The relayed body was empty' });

    // Whichever ceiling is lower: a deployment that tightened S3_MAX_UPLOAD_BYTES
    // meant it for every path, not just the direct one.
    const relayCeiling = Math.min(RELAY_MAX_BYTES, storage.maxUploadBytes());
    if (bytes.length > relayCeiling) {
      return res.status(413).json({
        error: `That file is ${(bytes.length / 1048576).toFixed(1)} MB. Anything over `
             + `${(relayCeiling / 1048576).toFixed(0)} MB has to upload straight to storage, which `
             + `needs a CORS rule on the bucket allowing PUT from this site — see api/.env.example.`,
      });
    }

    // On the direct path the key is minted here, around a fresh uuid, so a
    // caller cannot aim a PUT at an object that already exists. A relayed key
    // is raw request input and could — at a colleague's file in the same
    // division, whose key the listing hands out. Refuse anything a document row
    // already claims, the mirror of the check the DELETE arm applies.
    {
      const { neon } = require('@neondatabase/serverless');
      const sql = neon(process.env.DATABASE_URL);
      const claimed = await sql`SELECT id FROM project_documents WHERE storage_key = ${key} LIMIT 1`;
      if (claimed.length) {
        return res.status(409).json({ error: 'That storage key already belongs to a document' });
      }
    }

    const put = await storage.putObject(key, bytes, relayType);
    if (!put.ok) {
      // Worth logging in full: this is the first place the store's own reason
      // for refusing an upload is visible to anyone. The browser only ever saw
      // "Failed to fetch".
      console.error(`[document-upload-url] relay to ${key} failed:`, put.status, put.detail);
      return res.status(502).json({
        error: 'Storage refused the upload',
        detail: `${put.status || 'network error'} ${put.detail || ''}`.trim(),
      });
    }
    return res.json({ ok: true, bytes: bytes.length, relayed: true });
  }

  const body     = req.body || {};
  const filename = String(body.filename || '').trim();
  if (!filename) return res.status(400).json({ error: 'filename is required' });

  const contentType = storage.mimeFor(filename);
  if (!contentType) {
    return res.status(400).json({
      error: `Files of that type cannot be uploaded. Allowed: ${storage.allowedExtensions().join(', ')}`,
    });
  }

  const sizeBytes = parseInt(body.sizeBytes, 10) || 0;
  const maxBytes  = storage.maxUploadBytes();
  if (sizeBytes > maxBytes) {
    return res.status(413).json({
      error: `That file is ${(sizeBytes / 1048576).toFixed(1)} MB. The limit is ${(maxBytes / 1048576).toFixed(0)} MB.`,
    });
  }

  const documentId = crypto.randomUUID();
  const projectId  = body.projectId ? String(body.projectId) : null;
  const storageKey = storage.buildKey({ companyCode, division, projectId, documentId, filename });

  try {
    const uploadUrl = storage.presignUpload(storageKey, { expiresIn: UPLOAD_WINDOW_SECONDS });
    return res.json({
      documentId,
      storageKey,
      uploadUrl,
      contentType,
      maxBytes,
      expiresIn: UPLOAD_WINDOW_SECONDS,
    });
  } catch (err) {
    console.error('[document-upload-url]', err);
    return res.status(500).json({ error: 'Could not prepare the upload', detail: err.message });
  }
};
