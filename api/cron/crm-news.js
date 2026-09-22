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
 * It works through the regions until the clock runs out, and starts at a
 * different one each day. All three now fit comfortably in the budget, so the
 * rotation is insurance rather than the plan: a function killed at its
 * ceiling writes nothing at all, so this stops early on purpose, and if a
 * slow night ever does cut a region short, the one that got cut is the one
 * that goes first tomorrow. Items live for weeks and every write merges, so a
 * hub filled over two mornings is the same hub.
 *
 * Idempotent by construction. Items carry an id derived from their date and
 * headline, and the write merges on that id, so a cron that fires twice, a
 * retry, or a manual catch-up all converge on the same hub instead of
 * duplicating Friday's game.
 *
 * A region that finds nothing writes nothing. The failure mode worth
 * designing against is not a missing day — it is a bad search emptying a hub
 * someone was about to use.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { neon }  = require('@neondatabase/serverless');
const news = require('../lib/crm-news');

const NEWS_KEY = 'fct_crm_news';

// Vercel kills the function at maxDuration (300s, set in vercel.json). Stop
// well before that: the region being searched must be able to finish AND be
// written to every company, and a region that starts at 290s will not. Four
// minutes fits all three regions several times over.
const TIME_BUDGET_MS = 240000;

// Below this there is no point starting another region — see the loop.
const MIN_REGION_MS = 45000;

/** Day of the year — rotates which region the run starts with. */
function dayIndex(today) {
  const start = Date.UTC(today.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - start) / 86400000);
}

async function writeHub(sql, companies, items, today) {
  let written = 0;
  for (const c of companies) {
    const scopedKey = `${c.code}:${NEWS_KEY}`;
    let stored = { regions: {}, items: [] };
    try {
      const rows = await sql`SELECT value FROM app_data WHERE key = ${scopedKey}`;
      if (rows.length) {
        const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
        if (v && Array.isArray(v.items)) stored = v;
      }
    } catch (err) {
      console.error('[crm-news] read failed for', c.code, err.message);
    }

    const now   = new Date().toISOString();
    const value = {
      pulled_at: now,
      regions:   { ...(stored.regions || {}), ...items.regions },
      items:     news.mergeNews(stored.items, items.rows, { today }),
    };

    try {
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${scopedKey}, ${JSON.stringify(value)}, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
      written++;
    } catch (err) {
      // One company's write failing is not a reason to deny the rest their
      // morning. Recorded and carried past.
      console.error('[crm-news] write failed for', c.code, err.message);
    }
  }
  return written;
}

async function runNewsPull(sql, client, opts = {}) {
  const today   = opts.today || new Date();
  const started = Date.now();
  const budget  = opts.timeBudgetMs || TIME_BUDGET_MS;

  const offset  = dayIndex(today) % news.REGIONS.length;
  const ordered = news.REGIONS.slice(offset).concat(news.REGIONS.slice(0, offset));

  const result = { day: today.toISOString().slice(0, 10), found: 0, companies: 0, regions: [], skipped: [] };
  const gathered = { rows: [], regions: {} };

  for (const region of ordered) {
    // Checked between regions, never inside one: a region half-searched is a
    // region that wrote nothing, and the time it spent is gone either way.
    // A region needs a real window to be worth starting — handing it the
    // eight seconds left on the clock only buys a deadline error where the
    // truthful answer is that it was skipped.
    const left = budget - (Date.now() - started);
    if (left < MIN_REGION_MS) { result.skipped.push(region.key); continue; }
    try {
      // Each region gets what is left of the budget, so one slow search
      // cannot take the whole night's run down with it.
      const { items, searchError } = await news.withDeadline(
        news.pullNews(client, { region: region.key, today }), left);
      result.regions.push({ region: region.key, found: items.length, ...(searchError ? { searchError } : {}) });
      if (items.length) {
        gathered.rows.push(...items);
        gathered.regions[region.key] = new Date().toISOString();
        result.found += items.length;
      }
    } catch (err) {
      console.error('[crm-news] region failed:', region.key, err.message);
      result.regions.push({ region: region.key, error: err.message });
    }
  }

  if (!gathered.rows.length) return result;

  const companies = await sql`SELECT code FROM companies ORDER BY code`;
  result.companies = await writeHub(sql, companies, gathered, today);
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

module.exports.runNewsPull    = runNewsPull;
module.exports.dayIndex       = dayIndex;
module.exports.NEWS_KEY       = NEWS_KEY;
module.exports.TIME_BUDGET_MS = TIME_BUDGET_MS;
module.exports.MIN_REGION_MS  = MIN_REGION_MS;
