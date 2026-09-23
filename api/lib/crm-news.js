'use strict';
/**
 * CRM News Center — the daily pull of local sports results the sales team
 * opens an outreach email with.
 *
 * The premise is narrow and worth stating, because it decides every choice
 * below. A rep emailing a school's athletic director does better opening with
 * "saw the Fort Cherry game Friday" than with "checking in about your field".
 * So what this produces is not a news feed. It is a list of recent, LOCAL,
 * checkable results a person can paste into a first sentence — and, since the
 * hub reads as a scoreboard, the score broken out well enough to draw one.
 *
 * Four things follow from that.
 *
 * It is scoped to the sales territory, not to sport. Western PA, Eastern OH
 * and Western NY are where the fields we sell are. A national headline is
 * useless as an opener because the reader has no stake in it.
 *
 * It must be true. Every item carries the source URL the model searched, and
 * anything the model could not source is dropped rather than softened — an
 * opener with the wrong score is worse than no opener, because it tells the
 * reader you were not actually watching.
 *
 * It pulls ONE REGION per call. A web search wide enough to cover three
 * states takes longer than the 60 seconds a serverless function gets, and
 * the whole request dies at the gateway with nothing to show — which is
 * exactly what it did. One region finishes comfortably inside the budget, so
 * the caller makes three small calls that each either land or fail on their
 * own instead of one big one that fails as a whole.
 *
 * It accumulates. Each run merges into what is already stored rather than
 * replacing it, keyed on the headline, so a Friday game found on Saturday is
 * still there on Tuesday when someone gets round to the email. Old items age
 * out on a day count, not a run count, so a week of failed crons cannot
 * silently empty the hub.
 */

/**
 * The sales territory, one entry per call. `detail` is what the model
 * searches; `label` is what a row is tagged with and what the tab filters on,
 * so the two must not drift — hence one list rather than two.
 */
const REGIONS = [
  { key: 'wpa', label: 'Western PA',
    detail: 'Western Pennsylvania — the Pittsburgh metro plus Washington, Westmoreland, Beaver, Butler, Indiana, Fayette, Greene, Armstrong, Somerset, Cambria and Lawrence counties (WPIAL and PIAA District 6 schools)' },
  { key: 'cpa', label: 'Central PA',
    detail: 'Central Pennsylvania — Harrisburg, State College, Altoona, Williamsport, Lancaster, York, Lebanon and Carlisle (PIAA District 3 and District 4 schools)' },
  { key: 'epa', label: 'Eastern PA',
    detail: 'Eastern Pennsylvania — the Philadelphia metro plus Allentown, Bethlehem, Easton, Reading, Scranton, Wilkes-Barre and the Poconos (PIAA Districts 1, 2, 11 and 12 schools)' },
  { key: 'eoh', label: 'Eastern OH',
    detail: 'Eastern Ohio — Youngstown, Warren, Steubenville, East Liverpool, Canton and the Mahoning Valley (OHSAA District 5 and District 7 schools)' },
  { key: 'wv',  label: 'West Virginia',
    detail: 'West Virginia — Morgantown, Wheeling, Charleston, Huntington, Parkersburg, Fairmont, Clarksburg and Martinsburg (WVSSAC schools)' },
  { key: 'wny', label: 'Western NY',
    detail: 'Western New York — Buffalo, Jamestown, Olean, Niagara Falls, Rochester and the Southern Tier (Section V and Section VI schools)' },
  { key: 'md',  label: 'Maryland',
    detail: 'Maryland — the Baltimore metro plus Frederick, Hagerstown, Annapolis, Cumberland, Salisbury and the Washington suburbs (MPSSAA schools)' },
];

const REGION_LABELS = REGIONS.map(r => r.label);

// How far back a pull looks. A fortnight covers a missed week of crons and
// still reads as "recent" in an email; beyond that an opener sounds stale.
const LOOKBACK_DAYS = 14;

// Items kept in the hub. Past this, the tab is a scroll rather than a list.
const MAX_ITEMS   = 150;
const RETAIN_DAYS = 45;

/**
 * Searches per region, and results asked for.
 *
 * These were cut to three and ten while the functions ran under a 60-second
 * ceiling, which a fuller pull could not fit inside — and a request that does
 * not fit returns a gateway error having written nothing. vercel.json now
 * gives these three functions 300 seconds, so the budget is no longer what
 * decides the size of a pull: five searches and twenty results is a weekend's
 * scoreboard rather than a sample of one, and it fits several times over.
 *
 * Keep them in step with the deadlines if they grow again. The deadlines
 * (DEADLINE_MS here, TIME_BUDGET_MS in the cron) are what keep an overrun a
 * sentence on screen instead of a bodiless 504.
 */
const MAX_SEARCHES = 5;
const MAX_RESULTS   = 20;

const MODEL = 'claude-opus-5';

/**
 * Medium effort.
 *
 * Effort is the lever that decides how long a turn takes on Claude Opus 5,
 * and this sat at low only because the old 60-second ceiling left no room for
 * anything else. With 300 seconds the choice can be made on merit: medium
 * buys real judgement about which of twenty games is worth a line and which
 * source to believe, without the full deliberation the default spends on what
 * is still, underneath, reading a scoreboard. The rule that keeps it honest
 * is unchanged — drop anything you cannot source, enforced again in
 * cleanItems — and that is not a thing more thinking would improve.
 */
const EFFORT = 'medium';

/**
 * Anthropic's current web search tool. The dated `_20260209` variant does its
 * own result filtering; the older `_20250305` basic variant is the fallback
 * for API surfaces that do not know this one yet (see pullNews).
 */
const SEARCH_TOOL       = { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES };
const SEARCH_TOOL_BASIC = { type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES };

const { withDeadline } = require('./deadline');

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

function regionFor(key) {
  return REGIONS.find(r => r.key === key || r.label === key) || null;
}

function buildPrompt(region, today, lookbackDays) {
  const since = new Date(new Date(today).getTime() - lookbackDays * 86400000);
  return `Search the web for recent HIGH SCHOOL and COLLEGE sports results from this region only:

  ${region.detail}

Find games played between ${isoDay(since)} and ${isoDay(today)}. Cover football, soccer, baseball, softball, field hockey, lacrosse, tennis and track — the outdoor sports a school competes in. Most are played on the fields we sell; tennis is on courts, but a tennis result opens an email just as well. Prefer schools big enough to have their own athletic field.

Use at most ${MAX_SEARCHES} searches, then write the answer from what you found. Return up to ${MAX_RESULTS} games — the best-sourced ones, and prefer breadth across schools over several games from the same one. For each one, write ONE plain sentence a salesperson could open an email with, modelled exactly on this: "Indiana High School football defeated Fort Cherry this past Friday with a score of 30-25." — and also break the result out into its parts, so it can be shown as a scoreboard.

Rules that matter more than coverage:
- Only include a game you actually found a source for. If you cannot source the score, leave the game out. A wrong score in an outreach email is worse than no email.
- Use each school's real name as local people write it.
- No editorialising, no adjectives, no "thrilling" or "dominant". Just what happened.
- Do not invent a game to round out the list. Ten real results beat thirty guesses.

Return ONLY a JSON object, no prose before or after, in exactly this shape:
{
  "items": [
    {
      "date": "YYYY-MM-DD",
      "level": "High School" | "College",
      "sport": "Football",
      "winner": "Indiana",
      "winner_score": "30",
      "loser": "Fort Cherry",
      "loser_score": "25",
      "school": "Indiana High School",
      "opponent": "Fort Cherry",
      "headline": "Indiana High School football defeated Fort Cherry this past Friday with a score of 30-25.",
      "source_url": "https://..."
    }
  ]
}

If a game was a draw, put either side in "winner" and set "tie" to true.`;
}

/**
 * Pulls the JSON object out of a model reply.
 *
 * Mirrors api/ai/conflict-resolve.js rather than asking for a structured
 * output, because structured outputs and the citations web search attaches to
 * its text blocks cannot both be on — and the citation is what makes an item
 * checkable.
 */
function parseItems(text) {
  const stripped = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON in model response');
  const parsed = JSON.parse(stripped.slice(start, end + 1));
  return Array.isArray(parsed.items) ? parsed.items : [];
}

/** Concatenated text of every text block in a reply. */
function textOf(message) {
  return (message.content || [])
    .filter(b => b && b.type === 'text')
    .map(b => b.text)
    .join('');
}

/**
 * True if a reply carries a web search block that errored.
 *
 * Server tool failures arrive as a 200 with an error object where the results
 * list would be — they do not throw — so a caller that only catches exceptions
 * reports a confident empty hub. On success `content` is an array; on failure
 * it is an object with an error_code.
 */
function searchFailure(message) {
  for (const block of message.content || []) {
    if (block && block.type === 'web_search_tool_result') {
      const c = block.content;
      if (c && !Array.isArray(c) && c.error_code) return String(c.error_code);
    }
  }
  return null;
}

function stableId(item) {
  const basis = `${item.date || ''}|${(item.headline || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  let h = 0;
  for (let i = 0; i < basis.length; i++) h = (Math.imul(31, h) + basis.charCodeAt(i)) | 0;
  return 'news_' + (h >>> 0).toString(36);
}

const scoreOf = v => {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? String(n) : '';
};

/** Drops anything unusable and normalises the rest. Unsourced items go. */
function cleanItems(raw, today, regionLabel) {
  const out  = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue;
    const headline = String(r.headline || '').trim();
    const source   = String(r.source_url || '').trim();
    // The two things an opener cannot be written without.
    if (!headline || !/^https?:\/\//i.test(source)) continue;

    const date   = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) ? r.date : isoDay(today);
    // The region comes from which call this was, not from the model — it is
    // the one field we already know for certain, and a typo in it would break
    // the tab's filters.
    const region = regionLabel || String(r.region || '').trim() || REGION_LABELS[0];

    const item = {
      id:     '',
      date, region,
      level:  String(r.level || '').trim() || 'High School',
      sport:  String(r.sport || '').trim(),
      winner: String(r.winner || r.school   || '').trim(),
      loser:  String(r.loser  || r.opponent || '').trim(),
      winner_score: scoreOf(r.winner_score),
      loser_score:  scoreOf(r.loser_score),
      tie:    !!r.tie,
      school:   String(r.school   || r.winner || '').trim(),
      opponent: String(r.opponent || r.loser  || '').trim(),
      headline,
      source_url: source,
    };
    item.id = stableId(item);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Runs one pull, for ONE region. Returns { items, searchError }.
 *
 * Server tools can pause a turn mid-search (stop_reason 'pause_turn'); the
 * turn is resumed by handing the assistant content straight back, which is why
 * this loops rather than making one call.
 */
async function pullNews(client, opts = {}) {
  const region = regionFor(opts.region) || REGIONS[0];
  const today  = opts.today || new Date();
  const lookbackDays = opts.lookbackDays || LOOKBACK_DAYS;

  const messages = [{ role: 'user', content: buildPrompt(region, today, lookbackDays) }];

  // Two things this request uses may be unknown to an older API surface: the
  // dated search tool and the effort setting. Either is rejected as a flat
  // 400, so each gets dropped in turn rather than the whole pull failing over
  // a parameter. Order matters — effort only changes how long the answer
  // takes, the search tool decides whether there is an answer at all.
  let tools  = [SEARCH_TOOL];
  let effort = EFFORT;
  let message;

  for (let turn = 0; turn < 6; turn++) {
    try {
      message = await client.messages.create({
        model:      MODEL,
        max_tokens: 8000,
        ...(effort ? { output_config: { effort } } : {}),
        tools,
        messages,
      });
    } catch (err) {
      if (err && err.status === 400 && effort) { effort = null; continue; }
      if (err && err.status === 400 && tools[0] === SEARCH_TOOL) { tools = [SEARCH_TOOL_BASIC]; continue; }
      throw err;
    }

    if (message.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: message.content });
  }

  const failure = searchFailure(message);
  const text    = textOf(message);
  if (!text.trim()) {
    return { region: region.label, items: [], searchError: failure || 'The model returned no results.' };
  }
  return { region: region.label, items: cleanItems(parseItems(text), today, region.label), searchError: failure };
}

/**
 * Merges a fresh pull into what is stored.
 *
 * New items win on id so a re-run can correct a score. Ageing is by the game's
 * own date, so a run that finds nothing cannot empty the hub — the worst a bad
 * day does is leave yesterday's list in place.
 */
function mergeNews(existing, fresh, opts = {}) {
  const today      = opts.today || new Date();
  const retainDays = opts.retainDays || RETAIN_DAYS;
  const maxItems   = opts.maxItems   || MAX_ITEMS;
  const cutoff     = isoDay(new Date(new Date(today).getTime() - retainDays * 86400000));

  const byId = new Map();
  for (const item of Array.isArray(existing) ? existing : []) {
    if (item && item.id) byId.set(item.id, item);
  }
  for (const item of Array.isArray(fresh) ? fresh : []) {
    if (item && item.id) byId.set(item.id, item);
  }

  return [...byId.values()]
    .filter(i => String(i.date || '') >= cutoff)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, maxItems);
}

module.exports = {
  REGIONS, REGION_LABELS, LOOKBACK_DAYS, MAX_ITEMS, RETAIN_DAYS,
  MAX_SEARCHES, MAX_RESULTS, EFFORT, MODEL,
  regionFor, buildPrompt, parseItems, cleanItems, mergeNews, pullNews, withDeadline,
  searchFailure, textOf, stableId,
};
