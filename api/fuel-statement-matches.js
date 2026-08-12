'use strict';
/**
 * Saved fuel-account reconciliations.
 *
 *   GET    /api/fuel-statement-matches                 — list saved matches
 *     ?account=Guttman   one account
 *     ?limit=N           (default 50, max 200)
 *
 *   GET    /api/fuel-statement-matches?id=N            — one match + its lines
 *
 *   GET    /api/fuel-statement-matches?action=history  — per-truck rollup
 *     ?months=N          how far back to look (default 12, max 60)
 *     ?account=Guttman   restrict to one account
 *     → { trucks: [{ truck_number, periods, agreed, variances, missing,
 *                    resolved, net, abs_total, last_seen, last_ok }] }
 *     This is what turns twelve unrelated one-offs into "truck 412 has come
 *     up short every month since April".
 *
 *   POST   /api/fuel-statement-matches                 — save (or re-save)
 *     Body: { account, period_start, period_end, source_note, lines: [...] }
 *     Upserts on (account, period_start, period_end): re-running a month
 *     REPLACES its saved match. Resolution ticks are carried across by truck
 *     number, so re-matching after fixing an entry doesn't throw away the
 *     work of having chased the others down.
 *
 *   PATCH  /api/fuel-statement-matches?line_id=N       — tick one line
 *     Body: { resolved?, resolution_note? }
 *
 *   DELETE /api/fuel-statement-matches?id=N            — delete a saved match
 *
 * Access: Fuel Admin (or platform admin) throughout.
 *
 * The totals are stored as sent rather than recomputed. They are a record of
 * what the statement said on the day it was reconciled — re-deriving them
 * later from fuel entries that have since been corrected would quietly
 * rewrite history, which is the opposite of what saving one is for.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

const VALID_VERDICTS = ['match', 'variance', 'not-in-ours', 'not-on-statement'];
const MAX_LINES = 2000;

function safeInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function safeNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function safeStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function safeDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const y  = v.getFullYear();
    const mo = String(v.getMonth() + 1).padStart(2, '0');
    const d  = String(v.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeBool(v) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return null;
}

/**
 * "YYYY-MM" when the period is exactly one calendar month, else null.
 *
 * Worth storing rather than deriving: it is the difference between a saved
 * match that answers "how did July look" and one that answers "how did some
 * 47-day window look", and only the first is comparable month to month.
 */
function monthOfPeriod(start, end) {
  if (!start || !end) return null;
  if (start.slice(0, 7) !== end.slice(0, 7)) return null;
  const [y, m] = start.split('-').map(Number);
  const firstDay = `${start.slice(0, 7)}-01`;
  // Day 0 of the next month is the last day of this one.
  const last = new Date(y, m, 0).getDate();
  const lastDay = `${start.slice(0, 7)}-${String(last).padStart(2, '0')}`;
  return (start === firstDay && end === lastDay) ? start.slice(0, 7) : null;
}

function dbToMatch(r) {
  if (!r) return null;
  return {
    id:                     String(r.id),
    account:                r.account,
    period_start:           safeDate(r.period_start),
    period_end:             safeDate(r.period_end),
    period_month:           r.period_month || null,
    ours_total:             r.ours_total      == null ? null : Number(r.ours_total),
    statement_total:        r.statement_total == null ? null : Number(r.statement_total),
    difference:             r.difference      == null ? null : Number(r.difference),
    truck_count:            r.truck_count == null ? null : Number(r.truck_count),
    matched_count:          Number(r.matched_count || 0),
    variance_count:         Number(r.variance_count || 0),
    not_in_ours_count:      Number(r.not_in_ours_count || 0),
    not_on_statement_count: Number(r.not_on_statement_count || 0),
    source_note:            r.source_note || null,
    created_by_name:        r.created_by_name || null,
    created_at:             r.created_at || null,
    updated_at:             r.updated_at || null,
  };
}

function dbToLine(r) {
  if (!r) return null;
  return {
    id:              String(r.id),
    match_id:        String(r.match_id),
    truck_number:    r.truck_number == null ? null : Number(r.truck_number),
    ours:            r.ours       == null ? null : Number(r.ours),
    statement:       r.statement  == null ? null : Number(r.statement),
    difference:      r.difference == null ? null : Number(r.difference),
    fills:           Number(r.fills || 0),
    verdict:         r.verdict,
    resolved:        r.resolved === true,
    resolution_note: r.resolution_note || null,
  };
}

/**
 * Validate a save. Returns { data } or { error }.
 *
 * A match with no lines is refused: it would count as a reconciled period in
 * the history rollup while saying nothing about any truck, which is worse
 * than not having saved it.
 */
function normalizeMatch(body) {
  const b = (body && typeof body === 'object') ? body : {};

  // '' is a real value here — "all accounts together" — so it is stored as
  // the empty string rather than rejected as missing.
  const account = b.account == null ? '' : String(b.account).trim().slice(0, 100);

  const period_start = safeDate(b.period_start);
  const period_end   = safeDate(b.period_end);
  if (!period_start || !period_end) return { error: 'A start and end date are required.' };
  if (period_start > period_end)    return { error: 'The period starts after it ends.' };

  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  if (!rawLines.length) return { error: 'There is nothing to save — run a match first.' };
  if (rawLines.length > MAX_LINES) return { error: `That is more than ${MAX_LINES} trucks — too much for one match.` };

  const lines = [];
  for (const l of rawLines) {
    const verdict = String((l && l.verdict) || '');
    if (!VALID_VERDICTS.includes(verdict)) {
      return { error: `"${verdict}" is not a verdict this can store.` };
    }
    // truck_number is INTEGER. A fuel-card number read off a statement as a
    // truck is thirteen digits and would fail the INSERT with "integer out of
    // range" — after the save has already cleared the previous lines, taking
    // the reconciliation and its ticks with it. Refused up front instead, and
    // named, so the answer is "that column isn't a truck number" rather than
    // a 500.
    const truck = safeInt(l.truck_number);
    if (truck != null && (truck < 0 || truck > 2147483647)) {
      return { error: `"${l.truck_number}" is not a truck number — check which column the statement identifies vehicles in.` };
    }
    lines.push({
      truck_number: truck,
      ours:         safeNum(l.ours),
      statement:    safeNum(l.statement),
      difference:   safeNum(l.difference),
      fills:        safeInt(l.fills) || 0,
      verdict,
    });
  }

  const count = v => lines.filter(l => l.verdict === v).length;

  return {
    data: {
      account,
      period_start,
      period_end,
      period_month:           monthOfPeriod(period_start, period_end),
      ours_total:             safeNum(b.ours_total),
      statement_total:        safeNum(b.statement_total),
      difference:             safeNum(b.difference),
      truck_count:            lines.length,
      matched_count:          count('match'),
      variance_count:         count('variance'),
      not_in_ours_count:      count('not-in-ours'),
      not_on_statement_count: count('not-on-statement'),
      source_note:            safeStr(b.source_note, 500),
      lines,
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const canAdmin = hasDivisionAccess(payload, 'fuel_admin') || payload.isPlatformAdmin;
  if (!canAdmin) return res.status(403).json({ error: 'Fuel Admin access required' });

  const sql = neon(process.env.DATABASE_URL);
  const { companyCode } = payload;
  const q = req.query || {};

  try {
    // ── GET ?action=history — per-truck behaviour over recent matches ─────
    if (req.method === 'GET' && q.action === 'history') {
      let months = safeInt(q.months);
      if (months == null || months < 1) months = 12;
      if (months > 60) months = 60;
      // Trimmed on the way in because it is trimmed on the way out — a filter
      // of " Guttman" would otherwise match nothing that was ever saved.
      const acct = q.account == null ? '' : String(q.account).trim().slice(0, 100);

      // Counted over SAVED matches only. A month nobody reconciled says
      // nothing about a truck either way, and treating it as a clean month
      // would make an unbalanced truck look like it had come right.
      const rows = await sql`
        SELECT l.truck_number,
               COUNT(*)::int                                                          AS periods,
               COUNT(*) FILTER (WHERE l.verdict = 'match')::int                       AS agreed,
               COUNT(*) FILTER (WHERE l.verdict = 'variance')::int                    AS variances,
               COUNT(*) FILTER (WHERE l.verdict IN ('not-in-ours','not-on-statement'))::int AS missing,
               COUNT(*) FILTER (WHERE l.resolved)::int                                AS resolved,
               COALESCE(SUM(l.difference), 0)                                         AS net,
               COALESCE(SUM(ABS(l.difference)), 0)                                    AS abs_total,
               MAX(m.period_end)                                                      AS last_seen,
               MAX(m.period_end) FILTER (WHERE l.verdict = 'match' OR l.resolved)      AS last_ok
        FROM   fuel_statement_lines l
        JOIN   fuel_statement_matches m ON m.id = l.match_id
        WHERE  l.company_code = ${companyCode}
          AND  l.truck_number IS NOT NULL
          AND  m.period_end >= (CURRENT_DATE - (${months} || ' months')::interval)
          AND  (${acct} = '' OR m.account = ${acct})
        GROUP  BY l.truck_number
        ORDER  BY (COUNT(*) FILTER (WHERE l.verdict <> 'match' AND NOT l.resolved)) DESC,
                  COALESCE(SUM(ABS(l.difference)), 0) DESC,
                  l.truck_number ASC
      `;

      return res.json({
        months,
        account: acct,
        trucks: rows.map(r => ({
          truck_number: Number(r.truck_number),
          periods:      Number(r.periods),
          agreed:       Number(r.agreed),
          variances:    Number(r.variances),
          missing:      Number(r.missing),
          resolved:     Number(r.resolved),
          net:          Number(r.net),
          abs_total:    Number(r.abs_total),
          last_seen:    safeDate(r.last_seen),
          last_ok:      safeDate(r.last_ok),
        })),
      });
    }

    // ── GET ?id=N — one saved match, with its lines ──────────────────────
    if (req.method === 'GET' && q.id) {
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const [row] = await sql`
        SELECT * FROM fuel_statement_matches WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!row) return res.status(404).json({ error: 'Saved match not found' });
      const lines = await sql`
        SELECT * FROM fuel_statement_lines
        WHERE match_id = ${id} AND company_code = ${companyCode}
        ORDER BY
          CASE verdict WHEN 'variance' THEN 0 WHEN 'not-in-ours' THEN 1
                       WHEN 'not-on-statement' THEN 2 ELSE 3 END,
          ABS(COALESCE(difference, 0)) DESC,
          truck_number ASC
      `;
      return res.json({ match: dbToMatch(row), lines: lines.map(dbToLine) });
    }

    // ── GET — list ────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      let limit = safeInt(q.limit) || 50;
      if (limit > 200) limit = 200;
      if (limit < 1)   limit = 1;
      const acct = q.account == null ? '' : String(q.account).trim().slice(0, 100);
      const rows = await sql`
        SELECT * FROM fuel_statement_matches
        WHERE company_code = ${companyCode}
          AND (${acct} = '' OR account = ${acct})
        ORDER BY period_end DESC, account ASC
        LIMIT ${limit}
      `;
      return res.json({ matches: rows.map(dbToMatch) });
    }

    // ── POST — save or re-save ────────────────────────────────────────────
    if (req.method === 'POST') {
      const { data, error } = normalizeMatch(req.body || {});
      if (error) return res.status(400).json({ error });

      const [saved] = await sql`
        INSERT INTO fuel_statement_matches (
          company_code, account, period_start, period_end, period_month,
          ours_total, statement_total, difference, truck_count,
          matched_count, variance_count, not_in_ours_count, not_on_statement_count,
          source_note, created_by_user_id, created_by_name
        ) VALUES (
          ${companyCode}, ${data.account}, ${data.period_start}, ${data.period_end}, ${data.period_month},
          ${data.ours_total}, ${data.statement_total}, ${data.difference}, ${data.truck_count},
          ${data.matched_count}, ${data.variance_count}, ${data.not_in_ours_count}, ${data.not_on_statement_count},
          ${data.source_note}, ${payload.userId || null}, ${payload.username || null}
        )
        ON CONFLICT (company_code, account, period_start, period_end) DO UPDATE SET
          period_month           = EXCLUDED.period_month,
          ours_total             = EXCLUDED.ours_total,
          statement_total        = EXCLUDED.statement_total,
          difference             = EXCLUDED.difference,
          truck_count            = EXCLUDED.truck_count,
          matched_count          = EXCLUDED.matched_count,
          variance_count         = EXCLUDED.variance_count,
          not_in_ours_count      = EXCLUDED.not_in_ours_count,
          not_on_statement_count = EXCLUDED.not_on_statement_count,
          source_note            = EXCLUDED.source_note,
          created_by_user_id     = EXCLUDED.created_by_user_id,
          created_by_name        = EXCLUDED.created_by_name,
          updated_at             = NOW()
        RETURNING *
      `;

      // Carry the resolution ticks across a re-save. Re-matching a month
      // after correcting one entry would otherwise wipe every note made
      // while chasing the others down — which is exactly the work saving the
      // match exists to protect.
      const prior = await sql`
        SELECT truck_number, resolved, resolution_note
        FROM   fuel_statement_lines
        WHERE  match_id = ${saved.id} AND company_code = ${companyCode}
      `;
      const carried = new Map();
      for (const p of prior) {
        if (p.truck_number != null && (p.resolved === true || p.resolution_note)) {
          carried.set(Number(p.truck_number), { resolved: p.resolved === true, note: p.resolution_note || null });
        }
      }

      await sql`DELETE FROM fuel_statement_lines WHERE match_id = ${saved.id} AND company_code = ${companyCode}`;

      // Every line in ONE statement, not one round trip each.
      //
      // This sits immediately after a DELETE that has already removed the
      // previous lines, so the window between the two is the window in which
      // a saved reconciliation does not exist. A per-line loop makes that
      // window as long as the fleet: 200 trucks is 200 sequential HTTP round
      // trips through the serverless driver, and a function killed partway
      // leaves a match header claiming N trucks over a partial set of lines —
      // with the carried-over ticks gone, which is the work this feature
      // exists to protect.
      //
      // Passed as one JSON parameter and expanded by the database rather than
      // as bound arrays: the array-binding path is the one this codebase has
      // already been bitten by (see the ANY() note in fuel-submissions.js).
      // NOT named `payload` — that is the JWT, referenced a few lines above
      // in the same block, and shadowing it here is a temporal-dead-zone
      // error that only fires on the save path.
      const linePayload = data.lines.map(l => {
        const keep = l.truck_number != null ? carried.get(l.truck_number) : null;
        return {
          truck_number: l.truck_number,
          ours:         l.ours,
          statement:    l.statement,
          difference:   l.difference,
          fills:        l.fills,
          verdict:      l.verdict,
          resolved:     keep ? keep.resolved : false,
          note:         keep ? keep.note : null,
        };
      });

      await sql`
        INSERT INTO fuel_statement_lines
          (match_id, company_code, truck_number, ours, statement, difference, fills, verdict,
           resolved, resolution_note)
        SELECT ${saved.id}, ${companyCode}, x.truck_number, x.ours, x.statement,
               x.difference, x.fills, x.verdict, x.resolved, x.note
        FROM jsonb_to_recordset(${JSON.stringify(linePayload)}::jsonb)
          AS x(truck_number INTEGER, ours NUMERIC, statement NUMERIC, difference NUMERIC,
                fills INTEGER, verdict TEXT, resolved BOOLEAN, note TEXT)
      `;

      const lines = await sql`
        SELECT * FROM fuel_statement_lines
        WHERE match_id = ${saved.id} AND company_code = ${companyCode}
        ORDER BY
          CASE verdict WHEN 'variance' THEN 0 WHEN 'not-in-ours' THEN 1
                       WHEN 'not-on-statement' THEN 2 ELSE 3 END,
          ABS(COALESCE(difference, 0)) DESC,
          truck_number ASC
      `;
      return res.json({
        ok: true,
        match: dbToMatch(saved),
        lines: lines.map(dbToLine),
        carried_over: carried.size,
      });
    }

    // ── PATCH ?line_id=N — tick a truck off, or note what it was ──────────
    if (req.method === 'PATCH') {
      const lineId = safeInt(q.line_id);
      if (!lineId) return res.status(400).json({ error: 'line_id is required' });
      const [existing] = await sql`
        SELECT * FROM fuel_statement_lines WHERE id = ${lineId} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Line not found' });

      const b = req.body || {};
      const resolved = safeBool(b.resolved);
      const note = Object.prototype.hasOwnProperty.call(b, 'resolution_note')
        ? safeStr(b.resolution_note, 500)
        : existing.resolution_note;

      const [updated] = await sql`
        UPDATE fuel_statement_lines
        SET resolved        = ${resolved == null ? existing.resolved === true : resolved},
            resolution_note = ${note}
        WHERE id = ${lineId} AND company_code = ${companyCode}
        RETURNING *
      `;
      return res.json({ ok: true, line: dbToLine(updated) });
    }

    // ── DELETE ?id=N ──────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const [existing] = await sql`
        SELECT * FROM fuel_statement_matches WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Saved match not found' });
      // Lines go with it via ON DELETE CASCADE.
      await sql`DELETE FROM fuel_statement_matches WHERE id = ${id} AND company_code = ${companyCode}`;
      return res.json({ ok: true, match: dbToMatch(existing) });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[fuel-statement-matches]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

module.exports._test = { normalizeMatch, monthOfPeriod, dbToMatch, dbToLine };
