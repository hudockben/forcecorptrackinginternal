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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
