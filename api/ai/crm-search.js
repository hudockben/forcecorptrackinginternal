'use strict';
/**
 * POST /api/ai/crm-search — the CRM's plain-English search.
 *
 * The question this answers is the one the filter boxes cannot: "pull in all
 * the potential sports fields in this area with contact info and when the turf
 * was last installed". That is three joins and a judgement call about what
 * counts as "this area", and it ends with rows the user wants pushed into
 * Opportunities.
 *
 * So the endpoint does two things the filter row does not.
 *
 * It reads the CRM itself. The blobs come from app_data under the caller's own
 * company scope — not from the request body — so a request cannot widen its
 * own view of the data by sending a bigger payload, and the model sees exactly
 * what that user would see on the page.
 *
 * It can look outside the CRM. "Potential" fields are, by definition, mostly
 * schools we have no row for yet, so a query that asks for prospects may also
 * web search. Anything found that way is marked kind:'prospect' and carries
 * its source, because a row invented by a model and a row a rep typed must
 * never be indistinguishable once they are both sitting in Opportunities.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { neon }  = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const { withDeadline } = require('../lib/deadline');

const MODEL = 'claude-opus-5';

/**
 * Maximum effort, deliberately.
 *
 * This is the one endpoint here doing real reasoning rather than extraction:
 * it reads the whole CRM, works out what a vague question actually means,
 * and decides which rows answer it. The News Center reads a scoreboard and
 * the contact finder reads a staff page — those run at medium because more
 * thinking would not make a box score truer. Here it would: a question like
 * "schools whose turf is due and we have no open opportunity for" is a join
 * and a judgement, and a missed row is a missed deal.
 *
 * It costs time, which is why this endpoint now has a deadline and the tab
 * has a progress bar. A search that quietly ran for three minutes behind a
 * spinner reads as broken however good the answer is.
 */
const EFFORT = 'max';

// vercel.json gives this function 300s. Stop before that so an overrun comes
// back as a sentence rather than a gateway error with no body.
const DEADLINE_MS = 210000;

const MAX_QUERY_CHARS = 1000;

// How long a list of matches the model is asked for. A match is ~100 tokens
// written out, thinking shares max_tokens with the answer, and past a few
// dozen rows a list is better read in the tab's own Schools filter anyway.
const MAX_MATCHES = 60;

// What the model is shown. Past this the prompt costs more than the answer is
// worth, and the reply says plainly that it searched a capped slice.
//
// Companies was 500 until the schools import put ~1,100 school rows in the
// same blob. Measured on the 1,095-row import file, a school row is about 530
// characters whole and about 230 compacted (compactRow, below), so all of
// them come to ~251K characters — roughly 65-80K tokens, a little less than
// the 500 whole rows the old cap sent. 1,500 holds every school and 400 of our
// own companies besides. Past that the capped note still goes in, and what is
// cut is the tail of unworked schools (prioritiseCompanies, below), never a
// customer.
const CAPS = { people: 600, companies: 1500, fields: 800, opportunities: 500 };

/**
 * Keys that cost tokens and answer no question anyone asks the search.
 *
 * The OpenStreetMap id, the NCES id and the MaxPreps address are for the map
 * link, the import and the contact finder. Keys starting with "_" are the
 * page's own bookkeeping and were never data.
 *
 * Location stays. A ZIP is short and is how people ask ("anything in 15317"),
 * and a field Lucius found often has nothing but its coordinates to say where
 * it is — so those go in too, cut to three decimals (a hundred metres, which
 * is plenty to name a county). The one thing dropped is a school's street
 * address: a school carries its town, county and ZIP already, and across a
 * thousand of them the street is the largest thing left that no search asks.
 */
const PROMPT_DROP_KEYS = new Set(['osm_id', 'athletics_url', 'nces_id']);
const SCHOOL_DROP_KEYS = new Set(['address']);

const SEARCH_TOOL       = { type: 'web_search_20260209', name: 'web_search', max_uses: 8 };
const SEARCH_TOOL_BASIC = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 };

const KEYS = {
  people:        'fct_crm_people',
  companies:     'fct_crm_companies',
  fields:        'fct_crm_fields',
  opportunities: 'fct_crm_opportunities',
};

async function readBlob(sql, companyCode, key) {
  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:${key}`}`;
    if (!rows.length) return [];
    const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    return Array.isArray(v) ? v : [];
  } catch (err) {
    console.error('[ai/crm-search] read failed:', key, err.message);
    return [];
  }
}

/**
 * One row as the model sees it: only the keys that hold something.
 *
 * A CRM row is mostly empty strings — a company added by hand starts life as
 * sixteen keys, every one blank but the id — and each of those "": pairs was
 * paid for on every search. With the schools in the blob that stopped being a
 * rounding error. The id always survives, because a match the tab cannot find
 * again by id is a match it cannot open.
 */
function compactRow(row) {
  const school = SCHOOL_TYPE_RE.test(String(row.contact_type || ''));
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_') || PROMPT_DROP_KEYS.has(k)) continue;
    if (school && SCHOOL_DROP_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    if (Array.isArray(v) && !v.length) continue;
    if ((k === 'osm_lat' || k === 'osm_lng') && Number.isFinite(Number(v))) { out[k] = Math.round(Number(v) * 1000) / 1000; continue; }
    out[k] = v;
  }
  return out;
}

// A null or a stray string in a blob is not a row, and there is nothing in it
// to search.
function compactRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object' && !Array.isArray(r))
    .map(compactRow);
}

const _norm = s => String(s == null ? '' : s).trim().toLowerCase();

// The same test the page uses to put a row on its Schools tab (_crmIsSchool
// in tracker.html): the Organisation Type names a school.
const SCHOOL_TYPE_RE = /school|college|universit|academy|\bhs\b/i;

/**
 * Which companies come first when the list has to be capped.
 *
 * It used to be array order, and array order is upload order: the browser puts
 * new rows at the front, so the day 1,095 schools were imported every customer
 * we actually do business with fell off the end of AI Search. A company with a
 * field, a person or an opportunity against it is one somebody has worked, and
 * it keeps its place however many prospects are loaded on top of it.
 *
 * After those, the companies someone typed in by hand, and only then the
 * schools nobody has touched yet — a bought list of prospects is the thing to
 * cut first, because it is the thing that can be loaded again.
 *
 * Linked is the same test the page uses: a field by company_id or by name, a
 * person or an opportunity by name, names compared trimmed and lowercased.
 * Order inside each group is left alone, so nothing else moves.
 */
function prioritiseCompanies(companies, related) {
  const { fields = [], people = [], opportunities = [] } = related || {};
  const ids   = new Set();
  const names = new Set();
  for (const r of [...fields, ...people, ...opportunities]) {
    if (!r || typeof r !== 'object') continue;
    if (r.company_id) ids.add(r.company_id);
    for (const n of [_norm(r.company_name), _norm(r.company)]) if (n) names.add(n);
  }

  const linked  = [];
  const others  = [];
  const schools = [];
  for (const c of Array.isArray(companies) ? companies : []) {
    const isLinked = !!c && ((c.id && ids.has(c.id)) || names.has(_norm(c.company_name)));
    if (isLinked) linked.push(c);
    else if (c && SCHOOL_TYPE_RE.test(String(c.contact_type || ''))) schools.push(c);
    else others.push(c);
  }
  return linked.concat(others, schools);
}

/**
 * The four blobs as they go in the prompt: companies put in order, each list
 * capped, every row compacted. Returned with the notes on what was capped,
 * which the prompt passes on and the reply repeats.
 */
function prepareData(raw = {}) {
  const data      = {};
  const truncated = [];
  const ordered   = { ...raw, companies: prioritiseCompanies(raw.companies, raw) };
  for (const name of Object.keys(KEYS)) {
    const rows = Array.isArray(ordered[name]) ? ordered[name] : [];
    if (rows.length > CAPS[name]) truncated.push(`${name} capped at ${CAPS[name]} of ${rows.length}`);
    data[name] = compactRows(rows.slice(0, CAPS[name]));
  }
  return { data, truncated };
}

/**
 * The prompt, as two blocks.
 *
 * The first is the CRM itself and is marked for caching. It is by far the
 * largest thing sent, and it is sent more than once: every pause_turn from the
 * web search sends the whole conversation back, up to six times a search, and
 * without a cache each of those paid for the whole CRM again. Cached, the
 * first request writes it once and the rest read it back at a fraction of the
 * price — and so does the next search, if it comes within five minutes and the
 * CRM has not changed in between.
 *
 * Caching is a prefix match, so everything that differs between searches is in
 * the second block: today's date, the capped-list note, the web rules and the
 * question. The first block depends on nothing but the rows. The search tool
 * and the effort level are part of what the cache matches on too; each changes
 * only on its fallback in runSearch, where a fresh entry is the right outcome
 * anyway. Web search needs nothing extra — once a request caches, the API
 * caches the search results behind it on its own. And a CRM too small to be
 * worth caching (a few hundred tokens) is simply sent as before, no error.
 */
function buildPrompt(query, data, truncated, allowWeb) {
  const block = (label, rows) => `${label} (${rows.length}):\n${rows.length ? JSON.stringify(rows) : '  none'}`;

  const crm = `You are the search over a turf-installation company's CRM. Answer the user's question from the data below.

${block('COMPANIES', data.companies)}

${block('PEOPLE', data.people)}

${block('FIELDS', data.fields)}

${block('OPPORTUNITIES', data.opportunities)}`;

  const companiesCut = truncated.some(t => t.startsWith('companies'));
  const capped = truncated.length
    ? `Note: these lists were capped — ${truncated.join(', ')}.${companiesCut ? ' Companies with a field, a person or an opportunity against them were kept first, then our other companies, so the companies cut are schools nobody has worked yet.' : ''} Say so in your answer if it affects the result.\n\n`
    : '';

  const ask = `${capped}A field's age decides what we sell it: 1-3 years old is Maintenance, 4-7 is Maintenance/Replacement, 8+ is Replacement. Today is ${new Date().toISOString().slice(0, 10)}.

Some companies are schools — any contact_type that names one: High School, College / University, School District, Middle School, a private or church school. sector is "Public" or "Private", athletics_level the college's athletics classification, enrollment a head count. territory places a school against our sales territory line: "Inside" is inside the territory and more than 25 miles from the line; "On/near boundary" is within 25 miles of the line on either side, so which territory it belongs to still needs checking. miles_to_line is the distance to that line. Answer location questions from city, county, state and zip; osm_lat/osm_lng place a row that has none of those.
${allowWeb ? `
The question may ask for prospects we have no row for yet. Where it does, you may web search for real schools, colleges and municipalities that fit, and return them as kind "prospect". Only return a prospect you actually found a source for — never invent a school, an address or a contact. Leave a field empty rather than guessing it.
` : `
Answer only from the data above. Do not invent rows.
`}
USER'S QUESTION: ${query}

Return ONLY a JSON object, no prose outside it:
{
  "answer": "two or three sentences — what you found and anything about it worth knowing",
  "matches": [
    {
      "kind": "company" | "person" | "field" | "opportunity" | "prospect",
      "id": "the id from the data above, or \\"\\" for a prospect",
      "name": "company or person name",
      "company": "company name",
      "contact": "best contact name if known",
      "phone": "",
      "email": "",
      "website": "",
      "city": "",
      "county": "",
      "state": "",
      "territory": "Inside" | "On/near boundary" | "",
      "field_type": "",
      "field_size": "",
      "installed_year": "",
      "age_bucket": "Maintenance" | "Maintenance/Replacement" | "Replacement" | "",
      "turf_product": "",
      "lead_contact": "",
      "why": "one short line on why this matched",
      "source_url": "only for a prospect you web searched"
    }
  ]
}

Leave out any key you have no value for. Do not pad the list — a precise five beats a vague fifty. Return at most ${MAX_MATCHES} matches, best first; if more rows fit the question, say how many in "answer" and suggest how to narrow it (a county, a territory, a type).`;

  return [
    { type: 'text', text: crm, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: ask },
  ];
}

function textOf(message) {
  return (message.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('');
}

function parseResult(text) {
  const stripped = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON in model response');
  return JSON.parse(stripped.slice(start, end + 1));
}

/**
 * What can be saved from a reply that ran out of room mid-list.
 *
 * With every school in the prompt, "high schools in Ohio" has a few hundred
 * honest answers, and a reply that lists them stops at max_tokens partway
 * through a match. That used to reach parseResult as JSON with no closing
 * brackets and come back as a 500 after minutes of work. The matches written
 * before the cut are complete and true, so they are kept — each one is read
 * whole or not at all, by walking the braces outside of strings.
 */
function salvageResult(text) {
  const src = String(text || '');
  const answerM = src.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let answer = '';
  if (answerM) { try { answer = JSON.parse(`"${answerM[1]}"`); } catch (_) { answer = ''; } }

  const matches = [];
  const at = src.indexOf('"matches"');
  const open = at === -1 ? -1 : src.indexOf('[', at);
  if (open !== -1) {
    let depth = 0, inStr = false, esc = false, objStart = -1;
    for (let i = open + 1; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { if (depth === 0) objStart = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && objStart !== -1) {
          try { matches.push(JSON.parse(src.slice(objStart, i + 1))); } catch (_) { /* a broken one is skipped */ }
          objStart = -1;
        }
      } else if (ch === ']' && depth === 0) break;
    }
  }
  return { answer, matches };
}

/**
 * One search, however many turns the server tools need.
 *
 * Effort and the dated search tool are each dropped on a flat 400, in that
 * order: effort only changes how hard it thinks, the search tool decides
 * whether there is anything outside the CRM to find at all.
 */
async function runSearch(client, messages, allowWeb) {
  let tools  = allowWeb ? [SEARCH_TOOL] : undefined;
  let effort = EFFORT;
  let message;

  for (let turn = 0; turn < 6; turn++) {
    try {
      message = await client.messages.create({
        model:      MODEL,
        max_tokens: 16000,
        ...(effort ? { output_config: { effort } } : {}),
        ...(tools ? { tools } : {}),
        messages,
      });
    } catch (err) {
      if (err && err.status === 400 && effort) { effort = null; continue; }
      if (err && err.status === 400 && tools && tools[0] === SEARCH_TOOL) { tools = [SEARCH_TOOL_BASIC]; continue; }
      throw err;
    }
    if (message.stop_reason !== 'pause_turn') break;
    // Appended, never rebuilt: the first message is sent back byte for byte,
    // which is what lets the continuation read the CRM from the cache.
    messages.push({ role: 'assistant', content: message.content });
  }

  if (message && message.stop_reason === 'max_tokens') {
    const partial = salvageResult(textOf(message));
    return { ...partial, cutOff: true };
  }
  return parseResult(textOf(message));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const payload = await requireAuth(req, res);
  if (!payload) return;
  if (!hasDivisionAccess(payload, 'turf')) {
    return res.status(403).json({ error: 'No access to the turf division.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI Search is not configured — ANTHROPIC_API_KEY is missing.' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'AI Search is not configured — DATABASE_URL is missing.' });
  }

  const body  = req.body || {};
  const query = String(body.query == null ? '' : body.query).trim();
  if (!query) return res.status(400).json({ error: 'query is required' });
  if (query.length > MAX_QUERY_CHARS) {
    return res.status(400).json({ error: `Question is too long — keep it under ${MAX_QUERY_CHARS} characters.` });
  }
  const allowWeb = body.includeWeb !== false;

  const sql = neon(process.env.DATABASE_URL);

  const raw = {};
  for (const [name, key] of Object.entries(KEYS)) raw[name] = await readBlob(sql, payload.companyCode, key);
  const { data, truncated } = prepareData(raw);

  const messages = [{ role: 'user', content: buildPrompt(query, data, truncated, allowWeb) }];

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await withDeadline(
      runSearch(client, messages, allowWeb), DEADLINE_MS,
      'the search did not finish in the time the server allows');
    const matches = Array.isArray(result.matches) ? result.matches : [];

    return res.json({
      answer:    String(result.answer || '').trim(),
      matches,
      searched:  {
        people:        data.people.length,
        companies:     data.companies.length,
        fields:        data.fields.length,
        opportunities: data.opportunities.length,
        web:           allowWeb,
      },
      truncated,
      ...(result.cutOff ? {
        warning: `The answer ran out of room after ${matches.length} match${matches.length === 1 ? '' : 'es'}, so the list below is not the whole of it. Narrowing the question — one county, inside the territory, one type — gets the rest.`,
      } : {}),
    });

  } catch (err) {
    // Running long is not a crash, and at max effort it is the likely way to
    // fail. Answer 200 so the tab can say so in words.
    if (err && err.deadline) {
      console.warn('[ai/crm-search] deadline');
      return res.json({
        answer: '', matches: [], truncated,
        warning: 'That search ran longer than the server allows. Narrowing it — one county, one question — usually gets it back in time.',
      });
    }
    console.error('[ai/crm-search] failed:', err.message);
    return res.status(500).json({ error: 'AI Search failed', detail: err.message });
  }
};

module.exports.DEADLINE_MS         = DEADLINE_MS;
module.exports.EFFORT              = EFFORT;
module.exports.CAPS                = CAPS;
module.exports.compactRow          = compactRow;
module.exports.compactRows         = compactRows;
module.exports.prioritiseCompanies = prioritiseCompanies;
module.exports.prepareData         = prepareData;
module.exports.buildPrompt         = buildPrompt;
module.exports.salvageResult       = salvageResult;
module.exports.MAX_MATCHES         = MAX_MATCHES;
module.exports.runSearch           = runSearch;
