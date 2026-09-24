'use strict';
/**
 * Safety Center — signing a document, and the report of who has.
 *
 *   POST /api/safety-signatures         sign one document
 *   GET  /api/safety-signatures         my own signatures
 *   GET  /api/safety-signatures?scope=report[&from=&to=&include=archived]
 *                                       supervisors: every document, each with
 *                                       who signed, when, and who has not
 *   GET  /api/safety-signatures?documentId=X
 *                                       supervisors: that one document's split
 *
 * The report is grouped BY DOCUMENT rather than by person, because the
 * question it answers is "is this week's tailgate signed off" — a list of
 * people would have to be read against a list of documents to answer it, and
 * whoever is chasing the outstanding names is working one form at a time.
 *
 * Who is expected to sign is a real set, not everyone with a login: see
 * requiredSigners() in api/lib/safety.js.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');
const {
  safetyCapabilities, requiredSigners, mondayOf, dateOnly, SIGNATURE_STATEMENT: STATEMENT,
} = require('./lib/safety');

const MAX_NAME = 120;

// A finger-drawn mark on a phone-sized canvas is a few KB of PNG. The ceiling
// is generous enough for a tablet at 2x and small enough that nobody can post
// a photograph through this field — and it is checked on the base64 text,
// which is what actually arrives.
const MAX_SIGNATURE_IMAGE_CHARS = 128 * 1024;
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

// The regex above proves only the SHAPE of a data URL. Without a look at the
// bytes, 'data:image/png;base64,' + 'A'.repeat(130000) is a valid signature as
// far as it is concerned — not an image at all, just 128 KB of padding stored
// against a name forever, and repeatable once per document per person.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function looksLikePng(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return false;
  // 12 base64 characters decode to 9 bytes, one more than the signature needs.
  let head;
  try { head = Buffer.from(dataUrl.slice(comma + 1, comma + 13), 'base64'); }
  catch { return false; }
  return head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC);
}

function cleanName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/**
 * The one header that carries the caller's address on this platform.
 * x-forwarded-for is a list when proxies chain; the first entry is the client.
 */
function clientIp(req) {
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return fwd ? fwd.slice(0, 64) : null;
}

/**
 * One signature, as the API hands it out.
 *
 * `includeImage` is opt-in and off by default because the stored mark is a
 * base64 PNG of up to 128 KB. The all-documents report reads every signature
 * the company has ever recorded, so carrying the image there would pull tens
 * of megabytes into one serverless invocation to compute a boolean nobody
 * renders — and would grow without bound. It comes back only on the read of a
 * SINGLE document, which is where a supervisor actually looks at one.
 *
 * has_drawn is the column list's own answer when the image was not selected;
 * the fallback covers RETURNING * on the insert path, which has the real one.
 */
function signatureOut(row, includeImage = false) {
  const out = {
    userId:    row.user_id,
    username:  row.username,
    fullName:  row.full_name,
    signedAt:  row.signed_at,
    statement: row.statement || null,
    hasDrawnSignature: row.has_drawn === undefined
      ? Boolean(row.signature_image)
      : Boolean(row.has_drawn),
  };
  if (includeImage && row.signature_image) out.signatureImage = row.signature_image;
  return out;
}

function docOut(row) {
  return {
    id:     row.id,
    title:  row.title,
    weekOf: dateOnly(row.week_of),
    filename:   row.filename,
    uploadedBy: row.uploaded_by || null,
    uploadedAt: row.uploaded_at || null,
    archivedAt: row.archived_at || null,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = await requireAuth(req, res);
  if (!payload) return;

  const { companyCode, userId, username } = payload;
  const sql = neon(process.env.DATABASE_URL);
  const q   = req.query || {};

  try {
    // The payload is the account as it stands now (requireAuth reads it) —
    // the same row requiredSigners() reads the roster from, so nobody is
    // listed as owing a signature they are refused the right to make.
    const caps = safetyCapabilities(payload);
    if (!caps.canView) {
      return res.status(403).json({ error: 'You do not have access to the Safety Center' });
    }

    // ── POST — sign ───────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body || {};
      const documentId = String(body.documentId || '').trim();
      const fullName   = cleanName(body.fullName);

      if (!documentId) return res.status(400).json({ error: 'documentId is required' });

      // The acknowledgement is the signature. A row written without it would
      // be a record that somebody opened a file, which is not what the report
      // claims each row means.
      if (body.acknowledged !== true) {
        return res.status(400).json({ error: 'Tick the box to confirm you have read and understood the document.' });
      }
      if (fullName.length < 2) {
        return res.status(400).json({ error: 'Type your full name to sign.' });
      }

      let signatureImage = null;
      if (body.signatureImage) {
        const img = String(body.signatureImage);
        if (img.length > MAX_SIGNATURE_IMAGE_CHARS) {
          return res.status(413).json({ error: 'That signature image is too large.' });
        }
        // Only ever a PNG data URL. This string is rendered back into an <img>
        // on the report, so anything else — an SVG, an http: URL, a
        // javascript: scheme — is refused here rather than at the point it is
        // displayed, where one missed template would be an injection.
        if (!PNG_DATA_URL.test(img) || !looksLikePng(img)) {
          return res.status(400).json({ error: 'The drawn signature was not readable.' });
        }
        signatureImage = img;
      }

      // Only a live document may be signed — and the read is scoped by
      // company, so a document id from another company is simply not found.
      const [doc] = await sql`
        SELECT id, title FROM safety_documents
        WHERE  id = ${documentId} AND company_code = ${companyCode} AND archived_at IS NULL
      `;
      if (!doc) return res.status(404).json({ error: 'Document not found' });

      // Signing twice is not an error — a second tap on a slow connection is
      // the likeliest way it happens — but it does not overwrite the first
      // signature either. The first one is the one that was made; a later
      // timestamp would move a record of something that already happened.
      const [existing] = await sql`
        SELECT * FROM safety_signatures
        WHERE  document_id = ${documentId} AND user_id = ${userId}
      `;
      if (existing) {
        return res.json({ ok: true, alreadySigned: true, signature: signatureOut(existing) });
      }

      let inserted;
      try {
        [inserted] = await sql`
          INSERT INTO safety_signatures
            (company_code, document_id, user_id, username, full_name, signature_image,
             acknowledged, statement, ip_address, user_agent)
          VALUES
            (${companyCode}, ${documentId}, ${userId}, ${username || ''}, ${fullName},
             ${signatureImage}, TRUE, ${STATEMENT}, ${clientIp(req)},
             ${String((req.headers && req.headers['user-agent']) || '').slice(0, 400) || null})
          RETURNING *
        `;
      } catch (err) {
        // Two taps landing at once race past the SELECT above and meet the
        // unique index instead. Same outcome, same answer.
        if (/unique|duplicate/i.test(err.message || '')) {
          const [already] = await sql`
            SELECT * FROM safety_signatures
            WHERE  document_id = ${documentId} AND user_id = ${userId}
          `;
          if (already) return res.json({ ok: true, alreadySigned: true, signature: signatureOut(already) });
        }
        throw err;
      }

      return res.status(201).json({ ok: true, signature: signatureOut(inserted) });
    }

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── GET — the report, one document or all ─────────────────────────────
    const wantsReport = q.scope === 'report' || Boolean(q.documentId);
    if (wantsReport) {
      if (!caps.canManage) {
        return res.status(403).json({ error: 'Only a safety supervisor can read the sign-off report' });
      }

      const docId        = q.documentId ? String(q.documentId).trim() : null;
      const withArchived = q.include === 'archived';
      const fromF        = mondayOf(q.from) || '1900-01-01';
      const toF          = mondayOf(q.to)   || '9999-12-31';

      const docs = docId
        ? await sql`
            SELECT * FROM safety_documents
            WHERE  id = ${docId} AND company_code = ${companyCode}`
        : await sql`
            SELECT * FROM safety_documents
            WHERE  company_code = ${companyCode}
              AND  (${withArchived}::boolean OR archived_at IS NULL)
              AND  week_of >= ${fromF}::date
              AND  week_of <= ${toF}::date
            ORDER  BY week_of DESC, uploaded_at DESC`;

      if (docId && !docs.length) return res.status(404).json({ error: 'Document not found' });

      const ids = docs.map(d => d.id);
      // The drawn mark is fetched only when ONE document was asked for. An
      // all-documents report covers every signature the company has ever
      // recorded — a 40-person crew signing weekly is ~2,000 rows a year — and
      // SELECT * pulled each one's base64 PNG into a single serverless
      // invocation to compute one boolean that is not even rendered. Left
      // alone it eventually stops the report loading at all, and the only
      // recovery would be guessing a narrow date range.
      const withImages = Boolean(docId);
      const sigs = !ids.length ? []
        : withImages
          ? await sql`
              SELECT id, document_id, user_id, username, full_name, statement, signed_at,
                     signature_image, (signature_image IS NOT NULL) AS has_drawn
              FROM   safety_signatures
              WHERE  company_code = ${companyCode} AND document_id = ANY(${ids})
              ORDER  BY signed_at ASC`
          : await sql`
              SELECT id, document_id, user_id, username, full_name, statement, signed_at,
                     (signature_image IS NOT NULL) AS has_drawn
              FROM   safety_signatures
              WHERE  company_code = ${companyCode} AND document_id = ANY(${ids})
              ORDER  BY signed_at ASC`;

      const byDoc = new Map(ids.map(id => [id, []]));
      for (const s of sigs) {
        if (byDoc.has(s.document_id)) byDoc.get(s.document_id).push(s);
      }

      const roster = await requiredSigners(sql, companyCode);

      const rosterIds = new Set(roster.map(r => r.userId));

      const documents = docs.map(d => {
        const signed   = byDoc.get(d.id) || [];
        const signedBy = new Set(signed.map(s => s.user_id));
        // Outstanding is the roster minus who signed — never the other way
        // round. Somebody who signed and has since lost the division is not
        // outstanding, and would be if this counted down from the roster.
        const outstanding = roster
          .filter(r => !signedBy.has(r.userId))
          .map(r => ({ userId: r.userId, username: r.username, level: r.level }));

        // The headline count is ROSTER members who signed, not every signature
        // row. Not everyone who can sign is somebody the report is waiting on:
        // a platform admin can sign, and so can somebody whose grant was
        // removed afterwards, and neither is ever in `outstanding`. Counting
        // them in `signedCount` made the report's own three numbers fail to
        // add up — 4 signed and 1 outstanding against 4 expected — and pushed
        // the ratio past the roster.
        const covered = signed.filter(s => rosterIds.has(s.user_id)).length;

        return {
          document: docOut(d),
          expectedCount:    roster.length,
          signedCount:      covered,
          outstandingCount: outstanding.length,
          // A supervisor can be looking at a form posted before somebody
          // joined, so this is a percentage of the roster as it stands today,
          // not of who was on it that week.
          percentSigned: roster.length ? Math.round((covered / roster.length) * 100) : 0,
          // The full record, including anyone who signed without being on
          // today's roster — they are flagged rather than dropped, because the
          // signature happened and the report is the place it is produced.
          signed: signed.map(s => Object.assign(
            signatureOut(s, withImages),
            { onRoster: rosterIds.has(s.user_id) },
          )),
          outstanding,
        };
      });

      return res.json({
        documents,
        roster: roster.map(r => ({ userId: r.userId, username: r.username, level: r.level })),
        statement: STATEMENT,
      });
    }

    // ── GET — my own signatures ───────────────────────────────────────────
    // One person's own rows, so the image is affordable here — and this is the
    // only place a laborer can see the mark they drew.
    const mine = await sql`
      SELECT s.*, d.title, d.week_of
      FROM   safety_signatures s
      JOIN   safety_documents  d ON d.id = s.document_id
      WHERE  s.company_code = ${companyCode} AND s.user_id = ${userId}
      ORDER  BY s.signed_at DESC
    `;
    return res.json({
      signatures: mine.map(r => ({
        ...signatureOut(r, true),
        documentId: r.document_id,
        title:      r.title,
        weekOf:     dateOnly(r.week_of),
      })),
      statement: STATEMENT,
    });
  } catch (err) {
    console.error('[safety-signatures]', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
};

// Exported for scripts/test-safety-center.js.
module.exports._test = { STATEMENT, cleanName, clientIp, PNG_DATA_URL, MAX_SIGNATURE_IMAGE_CHARS };
