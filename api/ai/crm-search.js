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

const MODEL = 'claude-opus-5';

const MAX_QUERY_CHARS = 1000;

// What the model is shown. Past this the prompt costs more than the answer is
// worth, and the reply says plainly that it searched a capped slice.
const CAPS = { people: 600, companies: 500, fields: 800, opportunities: 500 };

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

function buildPrompt(query, data, truncated, allowWeb) {
  const block = (label, rows) => `${label} (${rows.length}):\n${rows.length ? JSON.stringify(rows) : '  none'}`;

  return `You are the search over a turf-installation company's CRM. Answer the user's question from the data below.

${block('COMPANIES', data.companies)}

${block('PEOPLE', data.people)}

${block('FIELDS', data.fields)}

${block('OPPORTUNITIES', data.opportunities)}
${truncated.length ? `\nNote: these lists were capped — ${truncated.join(', ')}. Say so in your answer if it affects the result.\n` : ''}
A field's age decides what we sell it: 1-3 years old is Maintenance, 4-7 is Maintenance/Replacement, 8+ is Replacement. Today is ${new Date().toISOString().slice(0, 10)}.
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
      "state": "",
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

Leave any field you do not know as an empty string. Do not pad the list — a precise five beats a vague fifty.`;
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

  const data      = {};
  const truncated = [];
  for (const [name, key] of Object.entries(KEYS)) {
    const rows = await readBlob(sql, payload.companyCode, key);
    if (rows.length > CAPS[name]) truncated.push(`${name} capped at ${CAPS[name]} of ${rows.length}`);
    data[name] = rows.slice(0, CAPS[name]);
  }

  const messages = [{ role: 'user', content: buildPrompt(query, data, truncated, allowWeb) }];
  let tools = allowWeb ? [SEARCH_TOOL] : undefined;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let message;

    for (let turn = 0; turn < 6; turn++) {
      try {
        message = await client.messages.create({
          model:      MODEL,
          max_tokens: 16000,
          ...(tools ? { tools } : {}),
          messages,
        });
      } catch (err) {
        if (err && err.status === 400 && tools && tools[0] === SEARCH_TOOL) {
          tools = [SEARCH_TOOL_BASIC];
          continue;
        }
        throw err;
      }
      if (message.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: message.content });
    }

    const result  = parseResult(textOf(message));
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
    });

  } catch (err) {
    console.error('[ai/crm-search] failed:', err.message);
    return res.status(500).json({ error: 'AI Search failed', detail: err.message });
  }
};
