'use strict';
/**
 * GET /api/cron/crm-news — the morning pull that keeps the News Center full.
 *
 * Runs once a day so the hub already holds the weekend's results when someone
 * opens it to write Monday's outreach. One pull serves every company: the
 * results are public regional sport, not anyone's data, so the same merged
 * list is written to each company's scoped key rather than paying for a
 * separate search per tenant.
 *
 * Idempotent by construction. Items carry an id derived from their date and
 * headline, and the write merges on that id, so a cron that fires twice, a
 * retry, or a manual catch-up all converge on the same hub instead of
 * duplicating Friday's game.
 *
 * A run that finds nothing writes nothing. The failure mode worth designing
 * against is not a missing day — it is a bad search emptying a hub someone
 * was about to use.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { neon }  = require('@neondatabase/serverless');
const news = require('../lib/crm-news');

const NEWS_KEY = 'fct_crm_news';

async function runNewsPull(sql, client, opts = {}) {
  const today = opts.today || new Date();
  const { items, searchError } = await news.pullNews(client, { today });

  const result = { day: today.toISOString().slice(0, 10), found: items.length, companies: 0 };
  if (searchError) result.searchError = searchError;
  if (!items.length) return result;

  const companies = await sql`SELECT code FROM companies ORDER BY code`;
  for (const c of companies) {
    const scopedKey = `${c.code}:${NEWS_KEY}`;
    let existing = [];
    try {
      const rows = await sql`SELECT value FROM app_data WHERE key = ${scopedKey}`;
      if (rows.length) {
        const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
        if (v && Array.isArray(v.items)) existing = v.items;
      }
    } catch (err) {
      console.error('[crm-news] read failed for', c.code, err.message);
    }

    const value = {
      pulled_at: new Date().toISOString(),
      items:     news.mergeNews(existing, items, { today }),
    };

    try {
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${scopedKey}, ${JSON.stringify(value)}, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
      result.companies++;
    } catch (err) {
      // One company's write failing is not a reason to deny the rest their
      // morning. Recorded and carried past.
      console.error('[crm-news] write failed for', c.code, err.message);
    }
  }
  return result;
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[crm-news] CRON_SECRET is not set — refusing to run');
    return res.status(503).json({ error: 'News pull is not configured.' });
  }
  const auth = String(req.headers.authorization || '');
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.DATABASE_URL || !process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'News pull is not configured.' });
  }

  const sql    = neon(process.env.DATABASE_URL);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const out = await runNewsPull(sql, client, {});
    console.log('[crm-news]', JSON.stringify(out));
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    console.error('[crm-news] pull failed:', err.message);
    return res.status(500).json({ error: 'News pull failed.' });
  }
};

module.exports.runNewsPull = runNewsPull;
module.exports.NEWS_KEY    = NEWS_KEY;
