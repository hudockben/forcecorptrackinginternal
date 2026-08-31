'use strict';
/**
 * POST /api/ai/mathis-feedback
 *
 * "That answer was wrong." Recorded rather than felt.
 *
 * Body: { verdict: 'up' | 'down', threadId?, division?, asked, answered, digests?, note? }
 *
 * mathis_gaps already records what Mathis could not answer. This is the harder
 * half: a wrong answer looks exactly like a right one until somebody who knows
 * the jobs says otherwise, and without somewhere to put that, "the answers
 * aren't great" stays an impression and every prompt change is a guess.
 *
 * The digests are stored beside the reply deliberately. On its own, a
 * thumbs-down says almost nothing — what makes it fixable is whether the
 * FIGURES were wrong (a digest problem: the wrong rows, the wrong window, a
 * bad port) or the figures were right and the answer described them badly (a
 * prompt problem). Those have different fixes, and the reply alone cannot tell
 * them apart.
 *
 * Everything here is the caller's own words about their own conversation, so
 * this writes and never reads: there is no GET, and no way for one user to see
 * another's feedback through this endpoint. Read it in SQL.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, normalizeDivision } = require('../lib/auth');
const mathis = require('../lib/mathis-context');

const MAX_TEXT    = 4000;   // a question and a reply, generously
const MAX_NOTE    = 1000;
const MAX_DIGESTS = 64 * 1024;

const clip = (v, n) => {
  const s = String(v == null ? '' : v);
  return s.length > n ? s.slice(0, n) : s;
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Feedback is unavailable right now.' });
  }

  const body    = req.body || {};
  const verdict = body.verdict === 'up' ? 'up' : body.verdict === 'down' ? 'down' : null;
  if (!verdict) return res.status(400).json({ error: "verdict must be 'up' or 'down'" });

  const sql = neon(process.env.DATABASE_URL);

  // Re-read rather than trusted, like every other Mathis path: a token lasts
  // 30 days, and feedback rows carry a user id that had better be real.
  const authz = await mathis.refreshAuthz(sql, payload);
  if (!authz) return res.status(401).json({ error: 'Your access could not be verified — please log in again.' });

  // A thread id from the client is a claim of ownership. Unverified, it is
  // dropped rather than refused — the feedback is still worth keeping, it just
  // does not get to point at a conversation that may not be theirs.
  let threadId = Number.isFinite(Number(body.threadId)) ? Number(body.threadId) : null;
  if (threadId) {
    try {
      const own = await sql`
        SELECT id FROM mathis_threads
        WHERE id = ${threadId} AND company_code = ${authz.companyCode} AND user_id = ${authz.userId}
        LIMIT 1
      `;
      if (!own.length) threadId = null;
    } catch (err) {
      console.error('[mathis-feedback] thread check failed:', err.message);
      threadId = null;
    }
  }

  // Normalised against the canonical list, so this column stays groupable
  // rather than collecting whatever a client felt like sending.
  const division = normalizeDivision(body.division);

  // Bounded before it is stored. A digest is already bounded, but a bounded
  // thing kept forever is not, and this table has no natural ceiling.
  let digests = null;
  if (body.digests != null) {
    try {
      const s = JSON.stringify(body.digests);
      digests = s.length <= MAX_DIGESTS ? JSON.parse(s) : { truncated: true, bytes: s.length };
    } catch { digests = null; }
  }

  try {
    await sql`
      INSERT INTO mathis_feedback
        (company_code, user_id, thread_id, verdict, division, asked, answered, digests, note)
      VALUES
        (${authz.companyCode}, ${authz.userId}, ${threadId}, ${verdict}, ${division},
         ${clip(body.asked, MAX_TEXT)}, ${clip(body.answered, MAX_TEXT)},
         ${digests ? JSON.stringify(digests) : null}, ${clip(body.note, MAX_NOTE) || null})
    `;
  } catch (err) {
    console.error('[mathis-feedback] write failed:', err.message);
    return res.status(503).json({ error: 'Could not record that just now.' });
  }

  return res.status(200).json({ ok: true });
};

module.exports.MAX_TEXT    = MAX_TEXT;
module.exports.MAX_NOTE    = MAX_NOTE;
module.exports.MAX_DIGESTS = MAX_DIGESTS;
