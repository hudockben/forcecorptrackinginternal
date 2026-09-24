'use strict';
/**
 * POST /api/scheduler/trucking
 *
 * Write a change the master scheduler made to a TRUCKING haul back to the
 * dispatch blob it came from.
 *
 * WHY THIS EXISTS RATHER THAN /api/data. Trucking's schedule blobs are gated to
 * the trucking division, and rightly so — a scheduler role is not a trucking
 * role. But the master board reads those hauls through (see readTruckingBoards
 * in board.js) precisely so the whole company's week is on one screen, and a
 * board you can only look at is half a board. This endpoint is the narrow
 * opening that makes the other half work: scheduler access, those two keys and
 * no others, and one operation — reconcile a set of rows into the blob.
 *
 * WHAT IT GUARANTEES. The blob is never overwritten wholesale. The caller sends
 * the rows as it READ them (`base`) and as they stand now (`rows`); the server
 * re-reads the blob and replays only the difference — adds, edits and removals,
 * by row id — over whatever a dispatcher has done in the meantime. That is the
 * same 3-way merge trucking.html runs against its own board, so two people
 * scheduling the same drivers at once merge rather than clobber.
 *
 * Because `base` only ever carries the forward dates the board was given, a row
 * trucking holds in the past is in neither side of the diff and cannot be
 * touched. And a removal here leaves a tombstone in `deleted`, the same record
 * trucking's own Delete button writes, so Records still shows the work.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const { syncForKey } = require('../lib/sync-normalized');

// The only two keys this endpoint will touch. Mirrors SCHED_BOARDS in
// trucking.html and TRUCKING_BOARDS in board.js.
const TRUCKING_KEYS = new Set(['fct_trucking_schedule', 'fct_trucking_labor_schedule']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 5000;   // a year of dispatch is a few hundred; this is a ceiling, not a target

/** A date-keyed map of rows, or a 400. Returns { map } or { error }. */
function readMap(v, label) {
  if (v == null) return { map: {} };
  if (typeof v !== 'object' || Array.isArray(v)) return { error: '`' + label + '` must be an object keyed by date' };
  const map = {};
  let n = 0;
  for (const [d, list] of Object.entries(v)) {
    if (!DATE_RE.test(d)) return { error: '`' + label + '` has a key that is not a date: ' + d };
    if (!Array.isArray(list)) return { error: '`' + label + '`.' + d + ' must be an array' };
    const out = [];
    for (const r of list) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: '`' + label + '`.' + d + ' has a row that is not an object' };
      if (typeof r.id !== 'string' || !r.id) return { error: '`' + label + '`.' + d + ' has a row with no id' };
      if (++n > MAX_ROWS) return { error: '`' + label + '` is too large' };
      out.push(r);
    }
    if (out.length) map[d] = out;
  }
  return { map };
}

function flat(a) { const m = {}; for (const d in a) for (const x of (a[d] || [])) m[x.id] = { ...x, _d: d }; return m; }
function unflat(m) { const o = {}; for (const id in m) { const { _d, ...rest } = m[id]; (o[_d] = o[_d] || []).push(rest); } return o; }

/** Start from theirs, then replay our adds, removals and edits by id. */
function merge3(base, ours, theirs) {
  const b = flat(base), o = flat(ours), t = flat(theirs), res = { ...t };
  for (const id in o) if (!(id in b)) res[id] = o[id];                                                    // we added
  for (const id in b) if (!(id in o)) delete res[id];                                                     // we removed
  for (const id in o) if (id in b && JSON.stringify(o[id]) !== JSON.stringify(b[id])) res[id] = o[id];    // we edited
  return unflat(res);
}

/** The record a removed haul leaves behind — the row as it stood, the day it
 *  was on, when it went and who took it. Same shape as schedArchiveRemoval in
 *  trucking.html, because Records reads both without knowing which wrote it. */
function tombstone(row, date, username) {
  const lean = {};
  Object.keys(row).forEach(k => { const v = row[k]; if (v !== '' && v != null && k !== '_d') lean[k] = v; });
  lean._d = date;
  lean.removedAt = new Date().toISOString();
  lean.removedBy = username || '';
  return lean;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = await requireAuth(req, res);
  if (!payload) return;
  if (!hasDivisionAccess(payload, 'scheduler')) {
    return res.status(403).json({ error: 'Scheduler access required' });
  }

  const body = req.body || {};
  const key = String(body.key || '');
  if (!TRUCKING_KEYS.has(key)) {
    return res.status(400).json({ error: 'Unknown trucking schedule key' });
  }
  const baseR = readMap(body.base, 'base');  if (baseR.error) return res.status(400).json({ error: baseR.error });
  const oursR = readMap(body.rows, 'rows');  if (oursR.error) return res.status(400).json({ error: oursR.error });
  const base = baseR.map, ours = oursR.map;

  const sql = neon(process.env.DATABASE_URL);
  const scopedKey = payload.companyCode + ':' + key;

  try {
    const got = await sql`SELECT value FROM app_data WHERE key = ${scopedKey}`;
    const value = got.length && got[0].value && typeof got[0].value === 'object' && !Array.isArray(got[0].value)
      ? got[0].value : {};
    const theirs = (value.assignments && typeof value.assignments === 'object' && !Array.isArray(value.assignments))
      ? value.assignments : {};

    const assignments = merge3(base, ours, theirs);

    // Rows the board took off. Only ids the caller actually read can be
    // removed, so this can never reach a haul the scheduler never saw.
    const live = new Set();
    for (const d in ours) (ours[d] || []).forEach(r => live.add(r.id));
    const deleted = (value.deleted && typeof value.deleted === 'object' && !Array.isArray(value.deleted))
      ? { ...value.deleted } : {};
    for (const d in base) (base[d] || []).forEach(r => { if (!live.has(r.id)) deleted[r.id] = tombstone(r, d, payload.username); });

    // hidden is trucking's own display setting and is written straight back
    // untouched — this board has no opinion about which drivers it shows.
    const next = {
      version: 1,
      assignments,
      hidden: Array.isArray(value.hidden) ? value.hidden : [],
      deleted,
    };

    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${scopedKey}, ${JSON.stringify(next)}, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    try { await syncForKey(sql, payload.companyCode, key, next); }
    catch (err) { console.error('[sync-normalized] scheduler/trucking', key, err.message); }

    return res.json({ ok: true, assignments });
  } catch (err) {
    console.error('[scheduler/trucking]', err.message);
    return res.status(500).json({ error: 'Failed to save to the trucking schedule', detail: err.message });
  }
};

module.exports.merge3 = merge3;
module.exports.readMap = readMap;
module.exports.tombstone = tombstone;
module.exports.TRUCKING_KEYS = TRUCKING_KEYS;
