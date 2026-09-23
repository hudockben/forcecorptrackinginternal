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
 * It works through the regions until the clock runs out, stalest first.
 * Seven regions do not fit in one run — the budget holds four or five — so
 * this fires twice a morning, and ordering by when each region was last
 * pulled is what makes the second run pick up exactly what the first did not
 * reach, without either run needing to know the other exists.
 *
 * That ordering also self-corrects. A region whose pull failed, timed out or
 * was never tried has no timestamp, so it sorts to the very front of the next
 * run rather than waiting for its turn to come round again. A fixed rotation
 * could not do that: it would skip past the failure and leave a stale region
 * stale for another full cycle.
 *
 * A function killed at its ceiling writes nothing at all, so stopping early
 * is the point. Items live for weeks and every write merges, so a hub filled
 * over two runs is the same hub.
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

/**
 * When each region was last pulled, from any one company's hub.
 *
 * Every company is written the same list in the same pass, so one of them is
 * a faithful sample — and reading one row beats reading all of them to learn
 * a fact they all agree on.
 */
async function lastPulledByRegion(sql) {
  try {
    const rows = await sql`
      SELECT value FROM app_data
      WHERE key LIKE ${'%:' + NEWS_KEY}
      ORDER BY updated_at DESC
      LIMIT 1`;
    if (!rows.length) return {};
    const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    return (v && v.regions) || {};
  } catch (err) {
    console.error('[crm-news] could not read pull times:', err.message);
    return {};
  }
}

/**
 * Stalest first. A region with no timestamp — never pulled, or last attempt
 * failed — sorts ahead of every dated one, which is what makes a failure
 * retry immediately instead of waiting for a rotation to come round.
 */
function orderByStaleness(regions, lastPulled) {
  return regions.slice().sort((a, b) => {
    const ta = Date.parse(lastPulled[a.key] || '') || 0;
    const tb = Date.parse(lastPulled[b.key] || '') || 0;
    if (ta !== tb) return ta - tb;
    return regions.indexOf(a) - regions.indexOf(b);   // stable, declared order
  });
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

  const lastPulled = opts.lastPulled || await lastPulledByRegion(sql);
  const ordered    = orderByStaleness(news.REGIONS, lastPulled);

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
      // Stamped on any completed look, found or not. A quiet week in Maryland
      // is not a failure, and treating it as one would park Maryland at the
      // front of every run for ever.
      gathered.regions[region.key] = new Date().toISOString();
      if (items.length) {
        gathered.rows.push(...items);
        result.found += items.length;
      }
    } catch (err) {
      console.error('[crm-news] region failed:', region.key, err.message);
      result.regions.push({ region: region.key, error: err.message });
    }
  }

  if (!gathered.rows.length && !Object.keys(gathered.regions).length) return result;

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

module.exports.runNewsPull       = runNewsPull;
module.exports.orderByStaleness  = orderByStaleness;
module.exports.lastPulledByRegion = lastPulledByRegion;
module.exports.NEWS_KEY       = NEWS_KEY;
module.exports.TIME_BUDGET_MS = TIME_BUDGET_MS;
module.exports.MIN_REGION_MS  = MIN_REGION_MS;
