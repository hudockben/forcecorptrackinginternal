'use strict';
/**
 * POST /api/ai/crm-news — pull one region of the News Center hub on demand.
 *
 * The cron (api/cron/crm-news.js) is what keeps the hub current. This exists
 * for the case the cron cannot serve: someone is writing outreach on Monday
 * morning about Friday's games and does not want to wait for tomorrow's run.
 *
 * One call, one region. Searching three states in a single request took
 * longer than the 60 seconds a serverless function gets and died at the
 * gateway as a 504 with nothing written — so the tab asks for Western PA,
 * then Eastern OH, then Western NY, and shows each one as it lands. A region
 * that fails now fails alone.
 *
 * Both paths share api/lib/crm-news.js and both merge rather than replace, so
 * pressing Refresh can only add to or correct the hub — never empty it.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { neon }  = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const news = require('../lib/crm-news');

const NEWS_KEY = 'fct_crm_news';

// A refresh button that can be leaned on is a bill, so a region pulled this
// recently returns the stored hub untouched.
const MIN_REFRESH_MS = 3 * 60 * 1000;

/**
 * Stop before the platform does.
 *
 * vercel.json gives this function 300 seconds; overrunning that means the
 * invocation is killed mid-flight and the caller gets a bodiless 504, with no
 * chance to say what happened. But the ceiling is not the right deadline
 * either: a person is watching a spinner, and three regions at five minutes
 * each is not a refresh, it is an outage with a progress bar. Two and a half
 * minutes is several times what a region needs and still bounded by patience
 * rather than by the platform. The cron, which nobody is waiting on, gets the
 * longer budget.
 */
const DEADLINE_MS = 150000;

async function readHub(sql, scopedKey) {
  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${scopedKey}`;
    if (!rows.length) return null;
    const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    if (v && Array.isArray(v.items)) return v;
  } catch (err) {
    console.error('[ai/crm-news] read failed:', err.message);
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (!hasDivisionAccess(payload, 'turf')) {
    return res.status(403).json({ error: 'No access to the turf division.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'News Center is not configured — ANTHROPIC_API_KEY is missing.' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'News Center is not configured — DATABASE_URL is missing.' });
  }

  const body   = req.body || {};
  const region = news.regionFor(body.region);
  if (!region) {
    return res.status(400).json({ error: `region must be one of: ${news.REGIONS.map(r => r.key).join(', ')}` });
  }

  const sql       = neon(process.env.DATABASE_URL);
  const scopedKey = `${payload.companyCode}:${NEWS_KEY}`;
  const stored    = (await readHub(sql, scopedKey)) || { pulled_at: null, regions: {}, items: [] };

  const lastForRegion = (stored.regions || {})[region.key];
  if (!body.force && lastForRegion && Date.now() - Date.parse(lastForRegion) < MIN_REFRESH_MS) {
    return res.json({ ...stored, region: region.label, found: 0, skipped: `${region.label} was pulled a moment ago.` });
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { items, searchError } = await news.withDeadline(
      news.pullNews(client, { region: region.key, today: new Date() }), DEADLINE_MS);

    // A pull that found nothing keeps the stored hub and says so, rather than
    // writing an empty list over a week of usable openers.
    if (!items.length) {
      return res.json({
        ...stored,
        region: region.label,
        found:  0,
        warning: searchError
          ? `${region.label}: search did not complete (${searchError}).`
          : `${region.label}: no new results found.`,
      });
    }

    const now   = new Date().toISOString();
    const value = {
      pulled_at: now,
      regions:   { ...(stored.regions || {}), [region.key]: now },
      items:     news.mergeNews(stored.items, items, { today: new Date() }),
    };

    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${scopedKey}, ${JSON.stringify(value)}, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    return res.json({ ...value, region: region.label, found: items.length });

  } catch (err) {
    // Running long is not a crash. Say it plainly, keep the stored hub, and
    // answer 200 — a 504 from the gateway would say none of that.
    if (err && err.deadline) {
      console.warn('[ai/crm-news] deadline:', region.key);
      return res.json({
        ...stored,
        region: region.label,
        found:  0,
        warning: `${region.label} took longer than the server allows — try again, or leave it to the morning run.`,
      });
    }
    console.error('[ai/crm-news] pull failed:', region.key, err.message);
    return res.status(500).json({ error: `${region.label} pull failed`, detail: err.message });
  }
};
