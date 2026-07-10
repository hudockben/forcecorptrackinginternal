'use strict';
/**
 * POST /api/ai/estimate-subcode
 *
 * AI "fill in the blanks" estimator for the Turf Schedule Estimator. Given a
 * batch of sub codes (name, optional cost code, unit, planned quantity) that
 * have little or no historical data, it returns rough field-production
 * estimates so a schedule can still be built:
 *   - labor_hours_per_unit  (person-hours to complete one unit)
 *   - crew_size             (typical workers on the task at once)
 *   - hours_per_day         (productive field hours per working day)
 *   - equip_hours_per_unit  (machine hours per unit, 0 for hand work)
 *   - confidence + rationale
 *
 * One Anthropic call handles the whole batch. Bearer auth + ANTHROPIC_API_KEY
 * guard, mirroring api/ai/conflict-resolve.js. Advisory only — the frontend
 * clearly flags every value as AI-estimated.
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
    ? 'artificial turf, synthetic athletic fields, and running-track construction'
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

  const prompt = `You are a senior field estimator for ${domain}. For each line item below, give a realistic production estimate for a typical crew. Base it on the sub code / work-description name, the unit of measure, and the planned quantity. If the unit is missing or unclear, assume the most common unit for that kind of work.

For EVERY item provide:
- labor_hours_per_unit: crew person-hours to complete ONE unit of the given unit of measure
- crew_size: typical number of workers on that task at once (whole number, >= 1)
- hours_per_day: productive field hours per working day (usually 8; use 6-10 when appropriate)
- equip_hours_per_unit: equipment/machine hours per unit (0 if it is hand work)
- confidence: "High", "Moderate", or "Low"
- rationale: one short sentence explaining the basis

LINE ITEMS:
${itemLines}

Respond with ONLY a JSON object in this EXACT format, with one entry per line item IN THE SAME ORDER:
{
  "estimates": [
    {
      "sub_code": "...",
      "cost_code": "...",
      "labor_hours_per_unit": 0.0,
      "crew_size": 0,
      "hours_per_day": 8,
      "equip_hours_per_unit": 0.0,
      "confidence": "Moderate",
      "rationale": "..."
    }
  ]
}`;

  try {
    const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
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
