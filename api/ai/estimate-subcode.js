'use strict';
/**
 * POST /api/ai/estimate-subcode
 *
 * AI "fill in the blanks" estimator for the Turf Schedule Estimator. Given a
 * batch of sub codes (name, optional cost code, unit, planned quantity) that
 * have little or no historical data, it returns realistic, industry-standard
 * field-production estimates so a schedule can still be built.
 *
 * The estimate is PRODUCTION-RATE first — the way estimators actually think:
 *   - units_per_crew_day : how many units a full crew completes in a working day
 *   - crew_size          : typical workers on the task at once
 *   - hours_per_day      : productive field hours per working day
 *   - equip_hours_per_unit
 *   - confidence + rationale
 * The frontend derives labor-hours/unit and working days from these, so days
 * come straight from a daily output rate instead of compounding a per-unit
 * labor figure through crew ÷ hours (which is what produced wildly high day
 * counts before).
 *
 * Bearer auth + ANTHROPIC_API_KEY guard, mirroring the other api/ai endpoints.
 * Advisory only — the frontend clearly flags every value as AI-estimated.
 */

const Anthropic = require('@anthropic-ai/sdk');
const jwt       = require('jsonwebtoken');

function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI not configured — ANTHROPIC_API_KEY missing.' });
  }

  const body     = req.body || {};
  const items    = Array.isArray(body.items) ? body.items : [];
  const division = (body.division || 'turf').toString();
  if (items.length === 0) return res.status(400).json({ error: 'items array required' });
  if (items.length > 40)  return res.status(400).json({ error: 'Too many items (max 40 per request)' });

  const domain = division === 'turf'
    ? 'artificial turf, synthetic athletic fields, running tracks, and the site/earthwork that goes with them'
    : `${division} construction`;

  const itemLines = items.map((it, i) => {
    const cc  = (it.costCode || '').toString().trim();
    const sc  = (it.subCode  || '').toString().trim();
    const un  = (it.unit     || '').toString().trim();
    const qty = Number(it.quantity) || 0;
    return `  ${i + 1}. sub_code="${sc || '(unnamed)'}"`
      + `${cc  ? `, cost_code="${cc}"` : ''}`
      + `${un  ? `, unit="${un}"`      : ''}`
      + `${qty ? `, planned_quantity=${qty}` : ''}`;
  }).join('\n');

  const prompt = `You are a senior field estimator for ${domain}. For each line item, give a REALISTIC production estimate for one typical crew, the way a scheduler would.

Think in PRODUCTION RATE first: how many units of the given unit of measure does one full crew complete in a normal working day? A working crew completes a substantial quantity per day — most site, base, and installation tasks run in the hundreds to thousands of units per crew per day (e.g. placing & grading stone base at ~1,500-4,000 SY/day, laying turf at ~1,500-3,000 SY/day, fine grading at thousands of SF/day). Only slow, piece-by-piece work (e.g. installing individual goal posts, inlaid logos) runs in single-digit units per day. Do NOT produce estimates that would take a small job dozens of days — sanity-check that quantity ÷ units_per_crew_day gives a believable number of days.

If the unit of measure is missing or unclear, assume the most common unit for that kind of work and report it in "unit".

For EVERY item provide:
- unit: the unit of measure you assumed (e.g. "SY", "SF", "ton", "LF", "ea")
- crew_size: typical number of workers on the task at once (whole number >= 1)
- hours_per_day: productive field hours per working day (usually 8; 6-10 if warranted)
- units_per_crew_day: units one full crew completes in one working day (> 0)
- equip_hours_per_unit: equipment/machine hours per unit (0 for hand work)
- confidence: "High", "Moderate", or "Low"
- rationale: one short sentence, ideally citing the assumed daily rate

LINE ITEMS:
${itemLines}

Respond with ONLY a JSON object in this EXACT format, one entry per line item IN THE SAME ORDER:
{
  "estimates": [
    {
      "sub_code": "...",
      "cost_code": "...",
      "unit": "SY",
      "crew_size": 4,
      "hours_per_day": 8,
      "units_per_crew_day": 2500,
      "equip_hours_per_unit": 0.0,
      "confidence": "Moderate",
      "rationale": "..."
    }
  ]
}`;

  try {
    const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 3072,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw      = message.content[0].text.trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const jStart   = stripped.indexOf('{');
    const jEnd     = stripped.lastIndexOf('}');
    if (jStart === -1 || jEnd === -1) throw new Error('No JSON in model response');
    const parsed    = JSON.parse(stripped.slice(jStart, jEnd + 1));
    const estimates = Array.isArray(parsed.estimates) ? parsed.estimates : [];
    return res.json({ estimates });

  } catch (err) {
    console.error('[ai/estimate-subcode] error:', err.message);
    return res.status(500).json({ error: 'AI estimate failed', detail: err.message });
  }
};
