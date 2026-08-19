'use strict';
/**
 * Mints a short-lived presigned PUT so the browser can upload a document
 * straight to object storage.
 *
 * POST /api/document-upload-url?division=turf
 *   body { filename, projectId?, sizeBytes? }
 *   →    { documentId, storageKey, uploadUrl, contentType, maxBytes }
 *
 * Vercel caps a serverless request body at 4.5 MB, which a single phone photo
 * can exceed — so bytes never come through this API at all. The browser PUTs
 * them to `uploadUrl`, then POSTs the metadata to /api/documents to register
 * the file. A ticket minted here and never used costs nothing: no row is
 * written until that second call lands.
 */
const { requireDivision, capabilities } = require('./lib/auth');
const storage             = require('./lib/storage');
const crypto              = require('crypto');

const UPLOAD_WINDOW_SECONDS = 900; // 15 minutes — enough for a slow jobsite LTE upload

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['POST', 'DELETE'].includes(req.method)) {
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
