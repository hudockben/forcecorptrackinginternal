'use strict';
/**
 * Hands back a short-lived signed URL for one stored document.
 *
 * GET /api/document-download?division=turf&id=X            — download
 * GET /api/document-download?division=turf&id=X&inline=1   — preview in place
 * GET /api/document-download?division=paving&id=X&poId=Y   — central purchasing
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
const { neon } = require('@neondatabase/serverless');
const {
  requireAuth,
  capabilities,
  normalizeDivision,
  hasDivisionAccess,
  canAccessPODivision,
} = require('./lib/auth');
const { resolvePODocScope } = require('./lib/po-sync');
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

  const payload = requireAuth(req, res);
  if (!payload) return;
  const { companyCode } = payload;
  const division = normalizeDivision(req.query.division) || 'turf';

  const id = req.query.id ? String(req.query.id) : null;
  if (!id) return res.status(400).json({ error: 'id is required' });

  if (!storage.isConfigured()) {
    return res.status(503).json({ error: 'Document storage is not configured on this deployment' });
  }

  const sql = neon(process.env.DATABASE_URL);

  // The two-stage check /api/documents applies. Central purchasing must be able
  // to open the receipt it attached to one of its own orders in this division,
  // and nothing else here — so under the carve-out the document has to be
  // linked to the order the request names.
  let poScope = null;
  if (!hasDivisionAccess(payload, division)) {
    poScope = await resolvePODocScope(sql, {
      payload, division, companyCode, poId: req.query.poId || null,
      canAccessPODivision,
    });
    if (!poScope) return res.status(403).json({ error: 'You do not have access to this division' });

    const linked = await sql`
      SELECT 1 FROM document_links
      WHERE document_id = ${id} AND company_code = ${companyCode}
        AND link_type = 'po' AND target_id = ${poScope.poId}
      LIMIT 1
    `;
    // Same 404 an id that does not exist gets — a caller learns nothing about
    // documents belonging to orders it has no business in.
    if (!linked.length) return res.status(404).json({ error: 'Document not found' });
  }

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
    //
    // The level has to come from capabilities(payload, division), not from
    // payload.role: login.js sets payload.role from the caller's TURF role for
    // tracker.html's benefit, so testing it here read the wrong division's role
    // in both directions — it let a turf admin read documents deleted in
    // paving, and it refused a real paving admin their own deleted file.
    if (doc.deleted_at && (poScope || !capabilities(payload, division).canDelete)) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const inline = Boolean(req.query.inline) && INLINE_SAFE.has(doc.content_type);
    // contentType pins what the store serves. Without it the object replays
    // whatever Content-Type was sent on the unsigned PUT, so a file registered
    // as a PDF could come back as text/html and render in the preview frame.
    const url = storage.presignDownload(doc.storage_key, {
      filename: doc.filename,
      contentType: doc.content_type,
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
