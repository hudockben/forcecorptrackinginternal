'use strict';
/**
 * CRM News Center — the daily pull of local sports results the sales team
 * opens an outreach email with.
 *
 * The premise is narrow and worth stating, because it decides every choice
 * below. A rep emailing a school's athletic director does better opening with
 * "saw the Fort Cherry game Friday" than with "checking in about your field".
 * So what this produces is not a news feed. It is a list of one-line, factual,
 * recent, LOCAL results a person can paste into a first sentence.
 *
 * Three things follow from that.
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
 * It accumulates. Each run merges into what is already stored rather than
 * replacing it, keyed on the headline, so a Friday game found on Saturday is
 * still there on Tuesday when someone gets round to the email. Old items age
 * out on a day count, not a run count, so a week of failed crons cannot
 * silently empty the hub.
 */

// The sales territory. Sent to the model verbatim — it is the whole scope of
// the search, and a fourth region added here is the only change needed to
// widen it.
const REGIONS = [
  'Western Pennsylvania (Pittsburgh metro, Washington, Westmoreland, Beaver, Butler, Indiana, Fayette, Greene, Armstrong, Somerset, Cambria, Lawrence and Mercer counties)',
  'Eastern Ohio (Youngstown, Warren, Steubenville, East Liverpool, Canton and the Mahoning Valley)',
  'Western New York (Buffalo, Jamestown, Olean, Niagara Falls and the Southern Tier)',
];

// How far back a pull looks. A fortnight covers a missed week of crons and
// still reads as "recent" in an email; beyond that an opener sounds stale.
const LOOKBACK_DAYS = 14;

// Items kept in the hub. Past this, the tab is a scroll rather than a list.
const MAX_ITEMS   = 120;
const RETAIN_DAYS = 45;

// Searches per pull. Each one costs money and the marginal result after a
// dozen is another way of phrasing the same Friday scoreboard.
const MAX_SEARCHES = 12;

const MODEL = 'claude-opus-5';

/**
 * Anthropic's current web search tool. The dated `_20260209` variant does its
 * own result filtering; the older `_20250305` basic variant is the fallback
 * for API surfaces that do not know this one yet (see pullNews).
 */
const SEARCH_TOOL      = { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES };
const SEARCH_TOOL_BASIC = { type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES };

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

function buildPrompt(today, lookbackDays) {
  const since = new Date(new Date(today).getTime() - lookbackDays * 86400000);
  return `Search the web for recent HIGH SCHOOL and COLLEGE sports results from these regions only:

${REGIONS.map(r => `  - ${r}`).join('\n')}

Find games played between ${isoDay(since)} and ${isoDay(today)}. Cover football, soccer, baseball, softball, field hockey, lacrosse and track — the sports played on a field. Prefer games at schools big enough to have their own athletic field.

For each game, write ONE plain sentence a salesperson could open an email with. Model it exactly on this: "Indiana High School football defeated Fort Cherry this past Friday with a score of 30-25."

Rules that matter more than coverage:
- Only include a game you actually found a source for. If you cannot source the score, leave the game out. A wrong score in an outreach email is worse than no email.
- Use the school's real name as local people write it.
- No editorialising, no adjectives, no "thrilling" or "dominant". Just what happened.
- Do not invent a game to round out the list. Twelve real results beat thirty guesses.

Return ONLY a JSON object, no prose before or after, in exactly this shape:
{
  "items": [
    {
      "date": "YYYY-MM-DD",
      "region": "Western PA" | "Eastern OH" | "Western NY",
      "level": "High School" | "College",
      "sport": "Football",
      "school": "Indiana High School",
      "opponent": "Fort Cherry",
      "headline": "Indiana High School football defeated Fort Cherry this past Friday with a score of 30-25.",
      "source_url": "https://..."
    }
  ]
}`;
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

/** Drops anything unusable and normalises the rest. Unsourced items go. */
function cleanItems(raw, today) {
  const out  = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue;
    const headline = String(r.headline || '').trim();
    const source   = String(r.source_url || '').trim();
    // The two things an opener cannot be written without.
    if (!headline || !/^https?:\/\//i.test(source)) continue;

    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) ? r.date : isoDay(today);
    const item = {
      id:       '',
      date,
      region:   String(r.region   || '').trim() || 'Western PA',
      level:    String(r.level    || '').trim() || 'High School',
      sport:    String(r.sport    || '').trim(),
      school:   String(r.school   || '').trim(),
      opponent: String(r.opponent || '').trim(),
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
 * Runs one pull. Returns { items, searchError }.
 *
 * Server tools can pause a turn mid-search (stop_reason 'pause_turn'); the
 * turn is resumed by handing the assistant content straight back, which is why
 * this loops rather than making one call.
 */
async function pullNews(client, opts = {}) {
  const today        = opts.today || new Date();
  const lookbackDays = opts.lookbackDays || LOOKBACK_DAYS;

  const messages = [{ role: 'user', content: buildPrompt(today, lookbackDays) }];
  let tools = [SEARCH_TOOL];
  let message;

  for (let turn = 0; turn < 6; turn++) {
    try {
      message = await client.messages.create({
        model:      MODEL,
        max_tokens: 16000,
        tools,
        messages,
      });
    } catch (err) {
      // An API surface that does not know the dated search tool rejects the
      // request outright. Retry once on the basic variant rather than
      // returning an empty hub.
      if (err && err.status === 400 && tools[0] === SEARCH_TOOL) {
        tools = [SEARCH_TOOL_BASIC];
        continue;
      }
      throw err;
    }

    if (message.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: message.content });
  }

  const failure = searchFailure(message);
  const text    = textOf(message);
  if (!text.trim()) {
    return { items: [], searchError: failure || 'The model returned no results.' };
  }
  return { items: cleanItems(parseItems(text), today), searchError: failure };
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
  REGIONS, LOOKBACK_DAYS, MAX_ITEMS, RETAIN_DAYS, MAX_SEARCHES, MODEL,
  buildPrompt, parseItems, cleanItems, mergeNews, pullNews,
  searchFailure, textOf, stableId,
};
