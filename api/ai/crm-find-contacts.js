'use strict';
/**
 * POST /api/ai/crm-find-contacts — who do we actually call at this place?
 *
 * The CRM fills up with companies long before it fills up with people. A rep
 * adds Fort Cherry because Lucius found a 2017 football field there, and then
 * the row sits untouched for a month because nobody knows whose desk to ring.
 * This finds the name.
 *
 * It searches for the roles that decide a turf purchase — athletic director,
 * facilities or buildings-and-grounds, business manager, superintendent — on
 * the school's own staff directory, and returns what it found with the page
 * it came from. A college gets a list of its own, because it is run by an
 * athletics department and a physical plant rather than a superintendent.
 *
 * Three rules it holds to.
 *
 * It never writes. Suggestions come back for a person to look at and accept,
 * exactly as AI Search returns prospects. A contact invented by a model and a
 * contact typed by a rep must stay distinguishable, and the moment the model
 * can write directly into People they are not.
 *
 * It reads the CRM itself, under the caller's own company scope, so a request
 * cannot widen its view of the data by sending a bigger payload — and so it
 * can see who we already have and not re-suggest them.
 *
 * It sources everything or drops it. An email address that cannot be pointed
 * at a page is a guess, and a guessed address in an outreach campaign is how
 * a domain gets a reputation problem.
 *
 * One company per call: the search plus the write-up is slow enough that
 * batching them is how a request meets the function ceiling. The tab loops.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { neon }  = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const { withDeadline } = require('../lib/deadline');

const MODEL  = 'claude-opus-5';
const EFFORT = 'medium';

// Enough to find a staff directory and read it. More than this and the model
// is browsing rather than looking something up.
const MAX_SEARCHES = 4;
const MAX_PEOPLE   = 6;

// vercel.json gives this function 300s. Stop first so an overrun is a
// sentence on screen rather than a bodiless gateway error.
const DEADLINE_MS = 150000;

const SEARCH_TOOL       = { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES };
const SEARCH_TOOL_BASIC = { type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES };

/** The people who decide, or influence, a field purchase at a school district. */
const ROLES = [
  'Athletic Director',
  'Director of Facilities / Buildings and Grounds',
  'Superintendent',
  'Business Manager / Director of Finance',
  'Director of Operations',
  'Head Groundskeeper / Grounds Supervisor',
  'Head Football Coach',
];

/**
 * The same people at a college, which is organised differently.
 *
 * A college has no superintendent and no district business office. The
 * athletics department owns its fields, one of the assistant ADs usually has
 * facilities as a portfolio, the physical plant looks after the grounds, and
 * the money goes through a finance office. Sending the K-12 list at a
 * university has the model hunting for a superintendent who does not exist.
 */
const COLLEGE_ROLES = [
  'Director of Athletics',
  'Associate / Assistant AD for Facilities or Operations',
  'Director of Facilities / Physical Plant',
  'Head Football Coach',
  'Business / Finance Officer',
];

// A college by its type alone. Athletics is a free-text cell a rep may well
// fill in for a high school too ("PIAA 6A"), so it cannot be the test.
function isCollege(company) {
  return /college|universit/i.test(String(company.contact_type || ''));
}

const rolesFor = company => (isCollege(company) ? COLLEGE_ROLES : ROLES);

/**
 * The school's MaxPreps profile, when that is what athletics_url holds.
 *
 * For a high school the import stores the varsity profile there, and it is the
 * best first page there is: it usually names the athletic director and links
 * the school's own site. Anything that is not maxpreps.com — the federal
 * athletics data page the colleges came from, a typo — is no help as a
 * starting page and is left out.
 */
function maxprepsUrl(raw) {
  const s = String(raw || '').trim();
  try {
    const u    = new URL(s);
    const host = u.hostname.toLowerCase();
    if (!/^https?:$/.test(u.protocol)) return '';
    return host === 'maxpreps.com' || host.endsWith('.maxpreps.com') ? s : '';
  } catch (_) {
    return '';
  }
}

async function readBlob(sql, companyCode, key) {
  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:${key}`}`;
    if (!rows.length) return [];
    const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    return Array.isArray(v) ? v : [];
  } catch (err) {
    console.error('[ai/crm-find-contacts] read failed:', key, err.message);
    return [];
  }
}

function buildPrompt(company, known, fields) {
  // County as well as town: the same school name turns up in more than one
  // county, and "McKinley High School" alone could be any of three.
  const where    = [company.address, company.city, company.county, company.state, company.zip].filter(Boolean).join(', ');
  const kind     = [company.sector, company.contact_type].filter(Boolean).join(' ');
  const maxpreps = maxprepsUrl(company.athletics_url);
  const college  = isCollege(company);
  const roles    = college ? COLLEGE_ROLES : ROLES;

  const about = [
    `ORGANISATION: ${company.company_name}`,
    kind                    && `TYPE: ${kind}`,
    company.athletics_level && `ATHLETICS: ${company.athletics_level}`,
    where                   && `LOCATION: ${where}`,
    company.work_website    && `WEBSITE: ${company.work_website}`,
    maxpreps                && `ATHLETICS PAGE: ${maxpreps} — the school's MaxPreps profile. It usually names the athletic director and links the school's own site, so it is a good first page; confirm names on the school's own site where they are printed there too.`,
    company.email_domain    && `EMAIL DOMAIN: ${company.email_domain}`,
    fields.length > 0       && `FIELDS WE KNOW OF: ${fields.map(f => `${f.field_name || f.field_type || 'field'}${f.installed_year ? ` (installed ${f.installed_year})` : ''}`).join('; ')}`,
  ].filter(Boolean).join('\n');

  return `Find the people we should contact at this organisation about its athletic fields.

${about}

${known.length ? `WE ALREADY HAVE THESE PEOPLE — do not return them again:\n${known.map(p => `  - ${p.name}${p.title ? `, ${p.title}` : ''}`).join('\n')}` : 'We have no contacts here yet.'}

Look for these roles, in this order of usefulness:
${roles.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}

${college
  ? `Search the college's own site first — the athletics department's staff directory, the facilities or physical plant page, the finance office. Those are the pages that carry real names and addresses.`
  : `Search the organisation's own site first — a staff directory, an athletics page, a district administration page. Those are the pages that carry real names and addresses.`}

Rules that matter more than coverage:
- Return only what you found on a page you can cite. Put that page's URL in source_url.
- NEVER construct an email address from a pattern. If the directory does not print the address, leave email empty and say so in "note". A guessed address is worse than none — it bounces, and enough of them costs us the domain.
- Prefer a current page. If a name is on an archived roster from several years ago, say so in "note" rather than presenting it as current.
- Do not return generic inboxes like info@ or athletics@ as a person. Put one in "note" if it is the only route in.
- At most ${MAX_PEOPLE} people. Two right names beat six uncertain ones.

Return ONLY a JSON object, no prose outside it:
{
  "found": true,
  "summary": "one sentence on what you found and how current it looks",
  "people": [
    {
      "name": "Jane Doe",
      "title": "Athletic Director",
      "email": "",
      "phone": "",
      "source_url": "https://…",
      "confidence": "high" | "medium" | "low",
      "note": "listed on the district athletics page, no address printed"
    }
  ]
}

If you cannot find anyone, return {"found": false, "summary": "why not", "people": []}.`;
}

const textOf = m => (m.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('');

function parseResult(text) {
  const stripped = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = stripped.indexOf('{'), b = stripped.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('No JSON in model response');
  return JSON.parse(stripped.slice(a, b + 1));
}

/**
 * Drops anything that cannot be stood behind.
 *
 * A row with no source is a guess, and an emailless row is still useful —
 * a name and a title is most of the work of finding the person.
 */
function cleanPeople(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue;
    const name = String(r.name || '').trim();
    const src  = String(r.source_url || '').trim();
    if (!name || !/^https?:\/\//i.test(src)) continue;

    const email = String(r.email || '').trim();
    out.push({
      name,
      title:      String(r.title || '').trim(),
      // A malformed address is a typo at best and a bounce at worst.
      email:      /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) ? email : '',
      phone:      String(r.phone || '').trim(),
      source_url: src,
      confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'medium',
      note:       String(r.note || '').trim(),
    });
    if (out.length >= MAX_PEOPLE) break;
  }
  return out;
}

async function findContacts(client, company, known, fields) {
  const messages = [{ role: 'user', content: buildPrompt(company, known, fields) }];
  let tools  = [SEARCH_TOOL];
  let effort = EFFORT;
  let message;

  for (let turn = 0; turn < 6; turn++) {
    try {
      message = await client.messages.create({
        model:      MODEL,
        max_tokens: 4000,
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

  const text = textOf(message);
  if (!text.trim()) return { found: false, summary: 'The search returned nothing.', people: [] };
  const parsed = parseResult(text);
  return {
    found:   !!parsed.found,
    summary: String(parsed.summary || '').trim(),
    people:  cleanPeople(parsed.people),
  };
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
    return res.status(503).json({ error: 'Contact finder is not configured — ANTHROPIC_API_KEY is missing.' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Contact finder is not configured — DATABASE_URL is missing.' });
  }

  const companyId = String((req.body || {}).companyId || '').trim();
  if (!companyId) return res.status(400).json({ error: 'companyId is required' });

  const sql = neon(process.env.DATABASE_URL);

  // The company comes from the stored CRM, not from the request — a caller
  // cannot point this at an organisation their company's CRM does not hold.
  const companies = await readBlob(sql, payload.companyCode, 'fct_crm_companies');
  const company   = companies.find(c => c && c.id === companyId);
  if (!company) return res.status(404).json({ error: 'No such company in this CRM.' });
  if (!String(company.company_name || '').trim()) {
    return res.status(400).json({ error: 'That company has no name to search for.' });
  }

  const name   = String(company.company_name).trim().toLowerCase();
  const people = await readBlob(sql, payload.companyCode, 'fct_crm_people');
  const known  = people.filter(p => String(p.company || '').trim().toLowerCase() === name);
  const allF   = await readBlob(sql, payload.companyCode, 'fct_crm_fields');
  const fields = allF.filter(f => f.company_id === company.id ||
    String(f.company_name || '').trim().toLowerCase() === name);

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await withDeadline(findContacts(client, company, known, fields), DEADLINE_MS);
    return res.json({ companyId, company: company.company_name, ...result });

  } catch (err) {
    if (err && err.deadline) {
      console.warn('[ai/crm-find-contacts] deadline:', companyId);
      return res.json({
        companyId, company: company.company_name, found: false, people: [],
        warning: `${company.company_name} took longer than the server allows — try it again on its own.`,
      });
    }
    console.error('[ai/crm-find-contacts] failed:', err.message);
    return res.status(500).json({ error: 'Contact lookup failed', detail: err.message });
  }
};

module.exports.cleanPeople   = cleanPeople;
module.exports.buildPrompt   = buildPrompt;
module.exports.ROLES         = ROLES;
module.exports.COLLEGE_ROLES = COLLEGE_ROLES;
module.exports.rolesFor      = rolesFor;
module.exports.maxprepsUrl   = maxprepsUrl;
module.exports.MAX_PEOPLE    = MAX_PEOPLE;
module.exports.DEADLINE_MS   = DEADLINE_MS;
