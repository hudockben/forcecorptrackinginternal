'use strict';
/**
 * POST /api/ai/crm-news — pull the News Center hub on demand.
 *
 * The cron (api/cron/crm-news.js) is what keeps the hub current. This exists
 * for the case the cron cannot serve: someone is writing outreach on Monday
 * morning about Friday's games and does not want to wait for tomorrow's run.
 *
 * Both paths share api/lib/crm-news.js and both merge rather than replace, so
 * pressing Refresh can only add to or correct the hub — never empty it.
 *
 * Auth mirrors the other api/ai endpoints: a valid token, plus the turf
 * division access the blob itself requires, re-read from the request rather
 * than trusted from the token's age.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { neon }  = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const news = require('../lib/crm-news');

const NEWS_KEY = 'fct_crm_news';

// One pull is a dozen web searches. A refresh button that can be leaned on is
// a bill, so a pull already this recent returns the stored hub untouched.
const MIN_REFRESH_MS = 5 * 60 * 1000;

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

  const sql       = neon(process.env.DATABASE_URL);
  const scopedKey = `${payload.companyCode}:${NEWS_KEY}`;

  let stored = { pulled_at: null, items: [] };
  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${scopedKey}`;
    if (rows.length) {
      const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      if (v && Array.isArray(v.items)) stored = v;
    }
  } catch (err) {
    console.error('[ai/crm-news] read failed:', err.message);
  }

  const force = !!(req.body && req.body.force);
  if (!force && stored.pulled_at && Date.now() - Date.parse(stored.pulled_at) < MIN_REFRESH_MS) {
    return res.json({ ...stored, skipped: 'A pull ran in the last few minutes — showing that one.' });
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { items, searchError } = await news.pullNews(client, { today: new Date() });

    // A pull that found nothing keeps the stored hub and says so, rather than
    // writing an empty list over a week of usable openers.
    if (!items.length) {
      return res.json({
        ...stored,
        found: 0,
        warning: searchError
          ? `Search did not complete (${searchError}) — showing the stored hub.`
          : 'No new results found — showing the stored hub.',
      });
    }

    const merged = news.mergeNews(stored.items, items, { today: new Date() });
    const value  = { pulled_at: new Date().toISOString(), items: merged };

    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${scopedKey}, ${JSON.stringify(value)}, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    return res.json({ ...value, found: items.length });

  } catch (err) {
    console.error('[ai/crm-news] pull failed:', err.message);
    return res.status(500).json({ error: 'News pull failed', detail: err.message });
  }
};
