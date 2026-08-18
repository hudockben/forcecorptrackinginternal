'use strict';
/**
 * Hands back a short-lived signed URL for one stored document.
 *
 * GET /api/document-download?division=turf&id=X            — download
 * GET /api/document-download?division=turf&id=X&inline=1   — preview in place
 *   → { url, filename, contentType, expiresIn }
 *
 * Returns JSON rather than a 302 on purpose. A redirect cannot carry the
 * Authorization header an <img src> or <a href> would need, and putting the
 * JWT in a query string would leak it into logs and referrers. The browser
 * fetches this with its token, then points the tag at the signed URL — which
 * authenticates itself, expires in minutes, and never exposes the bucket
 * credentials.
 *
 * This is also the gate that keeps company_code scoping intact: object storage
 * has no idea who is asking, so the check has to live here.
 */
const { neon }            = require('@neondatabase/serverless');
const { requireDivision } = require('./lib/auth');
const storage             = require('./lib/storage');

const DOWNLOAD_WINDOW_SECONDS = 300; // 5 minutes

// Types safe to render in place. Anything else downloads, so a stored .html
// or .svg can never execute against a URL the user might trust.
const INLINE_SAFE = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain',
]);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const guard = requireDivision(req, res);
  if (!guard) return;
  const { payload, division } = guard;
  const { companyCode } = payload;

  const id = req.query.id ? String(req.query.id) : null;
  if (!id) return res.status(400).json({ error: 'id is required' });

  if (!storage.isConfigured()) {
    return res.status(503).json({ error: 'Document storage is not configured on this deployment' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // company_code AND division both in the WHERE clause: a turf user asking
    // for a paving document gets the same 404 as one asking for a document
    // that does not exist, which is the point.
    const rows = await sql`
      SELECT id, filename, content_type, storage_key, deleted_at
      FROM   project_documents
      WHERE  id = ${id} AND company_code = ${companyCode} AND division = ${division}
    `;
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });

    const doc = rows[0];
    // Deleted documents stay readable so an admin can confirm what they are
    // about to lose before the purge, but only an admin may look.
    if (doc.deleted_at && !(payload.isPlatformAdmin || payload.role === 'admin')) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const inline = Boolean(req.query.inline) && INLINE_SAFE.has(doc.content_type);
    const url = storage.presignDownload(doc.storage_key, {
      filename: doc.filename,
      inline,
      expiresIn: DOWNLOAD_WINDOW_SECONDS,
    });

    return res.json({
      url,
      filename: doc.filename,
      contentType: doc.content_type,
      inline,
      expiresIn: DOWNLOAD_WINDOW_SECONDS,
    });
  } catch (err) {
    console.error('[document-download]', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
