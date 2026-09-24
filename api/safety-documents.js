'use strict';
/**
 * Safety Center — the documents the crew is asked to read and sign.
 *
 *   GET    /api/safety-documents                  the live list, newest week first
 *          ?include=archived                      supervisors: archived ones too
 *          ?from=YYYY-MM-DD&to=YYYY-MM-DD         a window of weeks
 *   GET    /api/safety-documents?action=open&id=X the signed URL to read one
 *   GET    /api/safety-documents?action=count     how many this caller owes
 *   POST   /api/safety-documents                  register an uploaded file
 *   PUT    /api/safety-documents?id=X             retitle / re-date one
 *   DELETE /api/safety-documents?id=X             archive one
 *
 * The FILE never passes through here. The browser asks
 * /api/document-upload-url?division=safety for a presigned PUT, uploads
 * straight to object storage, and posts the metadata back to this endpoint —
 * the same three-step flow the job document vault uses, and for the same
 * reason: a serverless request body is capped at 4.5 MB and a scanned
 * tailgate form with photographs clears that on its own.
 *
 * Every list read carries the caller's OWN signature state, because that is
 * what the crew's screen is: not a library, a list of what is still owed. The
 * supervisor's list carries the counts as well, so the badge on each card
 * agrees with the report without a second round trip.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');
const {
  SAFETY_DIVISION, currentSafetyCapabilities, requiredSigners, mondayOf, dateOnly, SIGNATURE_STATEMENT,
} = require('./lib/safety');
const storage = require('./lib/storage');

// Long enough to read a tailgate form through and sign it without the link
// going stale mid-meeting, short enough that a URL copied out of the address
// bar is worth nothing tomorrow.
const OPEN_WINDOW_SECONDS = 900;

const MAX_TITLE = 160;
const MAX_DESC  = 2000;

// A tailgate form is a document, not a spreadsheet or a photo dump. Everything
// the storage allowlist would otherwise take is refused here: the crew signs a
// statement that they read THE DOCUMENT, and that only means something if what
// opens is a document rather than whatever the uploader had to hand.
const ALLOWED_EXTENSIONS = ['pdf'];

function extensionOf(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function cleanText(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** The shape every list read and every write answers in. */
function toDocument(row, extra = {}) {
  return {
    id:          row.id,
    title:       row.title,
    description: row.description || null,
    weekOf:      dateOnly(row.week_of),
    filename:    row.filename,
    contentType: row.content_type || null,
    sizeBytes:   Number(row.size_bytes) || 0,
    uploadedBy:  row.uploaded_by || null,
    uploadedAt:  row.uploaded_at || null,
    archivedAt:  row.archived_at || null,
    archivedBy:  row.archived_by || null,
    ...extra,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode, userId } = payload;
  const sql = neon(process.env.DATABASE_URL);
  const q   = req.query || {};

  try {
    // The row, not the token: a grant made since this device last signed in
    // has to work now, and one taken away has to stop working now. See
    // currentSafetyCapabilities in api/lib/safety.js.
    const caps = await currentSafetyCapabilities(sql, payload);
    if (!caps.canView) {
      return res.status(403).json({ error: 'You do not have access to the Safety Center' });
    }

    // ── GET ?action=open — a short-lived URL for one document ─────────────
    if (req.method === 'GET' && q.action === 'open') {
      const id = String(q.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id is required' });

      if (!storage.isConfigured()) {
        return res.status(503).json({ error: 'Document storage is not configured on this deployment' });
      }

      const [doc] = await sql`
        SELECT id, filename, content_type, storage_key, archived_at
        FROM   safety_documents
        WHERE  id = ${id} AND company_code = ${companyCode}
      `;
      // company_code is in the WHERE clause rather than checked afterwards, so
      // a document belonging to another company is indistinguishable from one
      // that does not exist.
      if (!doc) return res.status(404).json({ error: 'Document not found' });

      // An archived form stays readable for whoever runs the division — they
      // may need to produce what was signed — but it is off the crew's list,
      // so it is not theirs to open any more either.
      if (doc.archived_at && !caps.canManage) {
        return res.status(404).json({ error: 'Document not found' });
      }

      const url = storage.presignDownload(doc.storage_key, {
        filename:    doc.filename,
        // Pinned, never replayed from the store. The PUT that uploaded these
        // bytes signs only `host`, so whatever Content-Type it sent is what
        // the object carries; without this override a file registered as a
        // PDF could come back as text/html and render in the viewer frame.
        contentType: doc.content_type || 'application/pdf',
        inline:      true,
        expiresIn:   OPEN_WINDOW_SECONDS,
      });
      return res.json({ url, filename: doc.filename, contentType: doc.content_type, expiresIn: OPEN_WINDOW_SECONDS });
    }

    // ── GET ?action=count — what this caller still owes ───────────────────
    // A count, and nothing else, for the badge on the Safety tile: the
    // division picker asks on every page load and wants one number, so it
    // should not be paying for the document rows, this caller's signature
    // rows and the supervisor's roster tally to get there.
    //
    // Counted the same way the crew's own list counts it — live documents
    // this caller has not signed — so the tile and the notice inside the
    // Safety Center cannot disagree with each other.
    if (req.method === 'GET' && q.action === 'count') {
      const [row] = await sql`
        SELECT COUNT(*)::int AS unsigned_by_me
        FROM   safety_documents d
        WHERE  d.company_code = ${companyCode}
          AND  d.archived_at IS NULL
          AND  NOT EXISTS (
                 SELECT 1
                 FROM   safety_signatures s
                 WHERE  s.document_id  = d.id
                   AND  s.company_code = ${companyCode}
                   AND  s.user_id      = ${userId}
               )
      `;
      return res.json({ unsignedByMe: Number(row && row.unsigned_by_me) || 0 });
    }

    // ── GET — the list ────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // Archived documents are a supervisor's view of the record. Asking for
      // them without the level does not fail — it just gets the live list,
      // because there is nothing there a laborer is being denied.
      const withArchived = caps.canManage && q.include === 'archived';
      const fromF = mondayOf(q.from) || '1900-01-01';
      const toF   = mondayOf(q.to)   || '9999-12-31';

      const rows = await sql`
        SELECT *
        FROM   safety_documents
        WHERE  company_code = ${companyCode}
          AND  (${withArchived}::boolean OR archived_at IS NULL)
          AND  week_of >= ${fromF}::date
          AND  week_of <= ${toF}::date
        ORDER  BY week_of DESC, uploaded_at DESC
      `;

      // The caller's own signatures, in one read rather than one per document.
      const mine = await sql`
        SELECT document_id, full_name, signed_at
        FROM   safety_signatures
        WHERE  company_code = ${companyCode} AND user_id = ${userId}
      `;
      const signedByMe = new Map(mine.map(r => [r.document_id, r]));

      // Counts, for the supervisor's badge. Only fetched for the side that
      // can see them: a laborer being told 3 of 11 have signed is being shown
      // the report through the back door.
      //
      // Counted AGAINST THE ROSTER, not as a bare COUNT(*) of signature rows.
      // The two stop being the same number the moment anyone signs who is not
      // on the roster — a platform admin, or somebody whose grant was removed
      // after they signed — and a bare count then reads HIGHER than the people
      // actually covered. That is the dangerous direction: the card showed a
      // green "11 / 11 signed" on a tailgate the report still listed people as
      // owing, so the badge said signed off when it was not. It is also the
      // definition the report uses, which is what makes the two agree.
      let counts = new Map();
      let expected = 0;
      if (caps.canManage && rows.length) {
        const roster    = await requiredSigners(sql, companyCode);
        const rosterIds = roster.map(r => r.userId);
        expected = roster.length;
        const tally = rosterIds.length
          ? await sql`
              SELECT document_id, COUNT(*)::int AS signed
              FROM   safety_signatures
              WHERE  company_code = ${companyCode}
                AND  user_id = ANY(${rosterIds})
              GROUP  BY document_id
            `
          : [];
        counts = new Map(tally.map(r => [r.document_id, r.signed]));
      }

      const documents = rows.map(r => {
        const sig = signedByMe.get(r.id);
        const extra = {
          signedByMe: Boolean(sig),
          mySignature: sig
            ? { fullName: sig.full_name, signedAt: sig.signed_at }
            : null,
        };
        if (caps.canManage) {
          const signed = counts.get(r.id) || 0;
          extra.signedCount = signed;
          extra.expectedCount = expected;
          // Cannot go negative now that `signed` counts only roster members,
          // but clamped anyway: a badge reading "-1 outstanding" would be a
          // worse way to learn that invariant had broken than a silent zero.
          extra.outstandingCount = Math.max(0, expected - signed);
        }
        return toDocument(r, extra);
      });

      return res.json({
        documents,
        permissions: { level: caps.level, canManage: caps.canManage, canSign: caps.canView },
        // The sentence the sign panel must display. Sent with the list so the
        // page never has to hold a copy that could drift from what is stored.
        statement: SIGNATURE_STATEMENT,
        storageConfigured: storage.isConfigured(),
      });
    }

    // ── POST — register a file the browser has already uploaded ───────────
    if (req.method === 'POST') {
      if (!caps.canManage) {
        return res.status(403).json({ error: 'Only a safety supervisor can post a document' });
      }
      const body = req.body || {};

      const id         = String(body.documentId || '').trim();
      const filename   = String(body.filename || '').trim();
      const storageKey = String(body.storageKey || '').trim();
      const title      = cleanText(body.title, MAX_TITLE);
      const weekOf     = mondayOf(body.weekOf);

      if (!id || !filename || !storageKey) {
        return res.status(400).json({ error: 'documentId, filename and storageKey are required' });
      }
      // Always the uuid api/document-upload-url.js minted — nothing else is a
      // legitimate value. Checked because it is echoed back by the caller and
      // then rendered: the storage-key comparison below is NOT a check on the
      // id, since buildKey() sanitises the id on both sides, so a caller could
      // send any string at all and still produce a matching key.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: 'documentId is not a valid upload id' });
      }
      if (!title)  return res.status(400).json({ error: 'Give the document a title.' });
      if (!weekOf) return res.status(400).json({ error: 'Pick the week this document covers.' });

      if (!ALLOWED_EXTENSIONS.includes(extensionOf(filename))) {
        return res.status(400).json({ error: 'The Safety Center takes PDF documents only.' });
      }
      const contentType = storage.mimeFor(filename);
      if (!contentType) {
        return res.status(400).json({ error: 'Files of that type cannot be uploaded.' });
      }

      // Recompute the key from the same inputs api/document-upload-url.js used
      // rather than sanity-checking the string the browser echoed back. A
      // prefix test still admits a hand-crafted key like 'FCT/safety/../../…',
      // and object stores treat keys as opaque while proxies in front of them
      // may not. If it does not match byte for byte, it did not come from us.
      const expectedKey = storage.buildKey({
        companyCode, division: SAFETY_DIVISION, projectId: null, documentId: id, filename,
      });
      if (storageKey !== expectedKey) {
        return res.status(400).json({ error: 'storageKey does not match this document' });
      }

      // The declared size is not evidence of anything: the presigned PUT signs
      // only `host`, so the store accepts a body of any length. Ask the store
      // what it actually holds — which also confirms an object exists at the
      // key rather than trusting a caller who skipped the upload entirely.
      const head = await storage.headObject(storageKey);
      if (!head.exists) {
        return res.status(409).json({
          error: 'No uploaded file was found for this document. The upload may have failed — please try again.',
        });
      }
      if (head.size > storage.maxUploadBytes()) {
        await storage.deleteObject(storageKey);
        return res.status(413).json({
          error: `That file is ${(head.size / 1048576).toFixed(1)} MB. The limit is `
               + `${(storage.maxUploadBytes() / 1048576).toFixed(0)} MB.`,
        });
      }

      let inserted;
      try {
        [inserted] = await sql`
          INSERT INTO safety_documents
            (id, company_code, title, description, week_of, filename, content_type,
             size_bytes, storage_key, uploaded_by)
          VALUES
            (${id}, ${companyCode}, ${title}, ${cleanText(body.description, MAX_DESC)},
             ${weekOf}, ${filename}, ${contentType}, ${head.size}, ${storageKey},
             ${payload.username || null})
          RETURNING *
        `;
      } catch (err) {
        if (/unique|duplicate/i.test(err.message || '')) {
          return res.status(409).json({ error: 'That document is already registered' });
        }
        throw err;
      }

      return res.status(201).json({ ok: true, document: toDocument(inserted, { signedByMe: false, mySignature: null }) });
    }

    // ── PUT — retitle or re-date ──────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!caps.canManage) {
        return res.status(403).json({ error: 'Only a safety supervisor can edit a document' });
      }
      const id = String(q.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id is required' });

      const body = req.body || {};
      const [existing] = await sql`
        SELECT * FROM safety_documents WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Document not found' });

      // The file itself is never replaced in place. Signatures already on this
      // document say a named person read THESE bytes, and swapping them would
      // silently turn every one of those records into a statement about a
      // document its signer never saw. A revised form is a new document.
      const title  = body.title       === undefined ? existing.title       : cleanText(body.title, MAX_TITLE);
      const desc   = body.description === undefined ? existing.description : cleanText(body.description, MAX_DESC);
      // Through dateOnly, never the raw Date the driver handed back. Binding a
      // Date to a DATE column serialises it as a UTC instant, and the value
      // read back is LOCAL midnight — so east of Greenwich a title-only edit
      // stored the day before, and the next edit the day before that. The week
      // walked backwards one edit at a time until the document fell out of its
      // own report filter.
      const weekOf = body.weekOf      === undefined
        ? dateOnly(existing.week_of)
        : mondayOf(body.weekOf);

      if (!title)  return res.status(400).json({ error: 'Give the document a title.' });
      if (!weekOf) return res.status(400).json({ error: 'Pick the week this document covers.' });

      const [updated] = await sql`
        UPDATE safety_documents
        SET    title = ${title}, description = ${desc}, week_of = ${weekOf}, updated_at = NOW()
        WHERE  id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      return res.json({ ok: true, document: toDocument(updated) });
    }

    // ── DELETE — archive ──────────────────────────────────────────────────
    // Archiving, never destroying. A signed acknowledgement is a record of
    // something that happened, and the document it points at has to still be
    // there for the record to mean anything — so this takes the form off the
    // crew's list and leaves everything else exactly as it was. Restoring is
    // the same call with restore=1.
    if (req.method === 'DELETE') {
      if (!caps.canManage) {
        return res.status(403).json({ error: 'Only a safety supervisor can archive a document' });
      }
      const id = String(q.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id is required' });

      const restore = q.restore === '1' || q.restore === 'true';
      const [updated] = restore
        ? await sql`
            UPDATE safety_documents
            SET    archived_at = NULL, archived_by = NULL, updated_at = NOW()
            WHERE  id = ${id} AND company_code = ${companyCode}
            RETURNING *`
        : await sql`
            UPDATE safety_documents
            SET    archived_at = NOW(), archived_by = ${payload.username || null}, updated_at = NOW()
            WHERE  id = ${id} AND company_code = ${companyCode}
            RETURNING *`;

      if (!updated) return res.status(404).json({ error: 'Document not found' });
      return res.json({ ok: true, document: toDocument(updated) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[safety-documents]', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
};

// Exported for scripts/test-safety-center.js.
module.exports._test = { cleanText, extensionOf, toDocument, ALLOWED_EXTENSIONS };
