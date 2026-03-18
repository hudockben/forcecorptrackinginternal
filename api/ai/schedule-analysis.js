'use strict';

const Anthropic      = require('@anthropic-ai/sdk');
const { neon }       = require('@neondatabase/serverless');
const jwt            = require('jsonwebtoken');

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI analysis not configured — ANTHROPIC_API_KEY missing.' });
  }

  const { projectId, projectName, jobNumber, deadline, daysLeft, costCodes } = req.body || {};

  if (!projectId || !Array.isArray(costCodes) || costCodes.length === 0) {
    return res.status(400).json({ error: 'projectId and costCodes array required' });
  }

  const sql         = neon(process.env.DATABASE_URL);
  const cacheKey    = `${payload.companyCode}:fct_ai_sched_${projectId}`;

  // ── Check cache ────────────────────────────────────────────────────────────
  try {
    const cached = await sql`SELECT value, updated_at FROM app_data WHERE key = ${cacheKey}`;
    if (cached.length) {
      const age = Date.now() - new Date(cached[0].updated_at).getTime();
      if (age < CACHE_TTL_MS) {
        return res.json({ ...cached[0].value, cached: true });
      }
    }
  } catch (err) {
    console.warn('[ai/schedule] cache read failed:', err.message);
  }

  // ── Build prompt ───────────────────────────────────────────────────────────
  const deadlineStr = deadline
    ? `${deadline} (${daysLeft !== null && daysLeft !== undefined ? (daysLeft < 0 ? `${Math.abs(daysLeft)} days overdue` : `${daysLeft} days remaining`) : 'no days calculated'})`
    : 'No deadline set';

  const codeLines = costCodes.map(c => {
    // Pre-compute labor productivity so AI can give specific crew recommendations
    const unitsPerLaborHour = (c.laborHours > 0 && c.runningQty > 0)
      ? c.runningQty / c.laborHours : null;
    const laborHoursPerDay = (c.laborHours > 0 && c.daysWorked > 0)
      ? c.laborHours / c.daysWorked : null;
    // Estimate additional laborers needed to close gap (assuming 8hr day)
    let additionalLaborers = null;
    if (c.gap > 0 && unitsPerLaborHour !== null && unitsPerLaborHour > 0) {
      additionalLaborers = Math.ceil(c.gap / (unitsPerLaborHour * 8));
    }

    const parts = [
      `  • ${c.costCode}${c.subCode ? ' / ' + c.subCode : ''}`,
      `    Status: ${c.status}`,
      `    Bid Qty: ${c.bidQty > 0 ? c.bidQty : 'not set'} | Running Qty: ${c.runningQty}`,
      `    % Complete: ${c.bidQty > 0 ? Math.round((c.runningQty / c.bidQty) * 100) + '%' : 'unknown'}`,
      `    Days Worked: ${c.daysWorked} | Current Pace: ${c.currentPace > 0 ? c.currentPace.toFixed(2) + ' units/day' : 'no activity'}`,
      c.requiredPace != null ? `    Required Pace: ${c.requiredPace.toFixed(2)} units/day` : '    Required Pace: N/A (no deadline)',
      c.gap != null ? `    Gap: ${c.gap > 0 ? '+' + c.gap.toFixed(2) + ' units/day NEEDED' : Math.abs(c.gap).toFixed(2) + ' units/day ahead'}` : '    Gap: N/A',
      unitsPerLaborHour !== null ? `    Labor Productivity: ${unitsPerLaborHour.toFixed(3)} units/labor-hr` : '',
      laborHoursPerDay !== null ? `    Labor Hrs/Day: ${laborHoursPerDay.toFixed(1)} hrs/day across ${c.employees ? c.employees.length : 0} laborer(s)` : '',
      additionalLaborers !== null ? `    Est. Additional Laborers Needed (8hr day): ${additionalLaborers}` : '',
      c.employees && c.employees.length ? `    Current Crew: ${c.employees.join(', ')}` : '',
      c.equipment && c.equipment.length ? `    Equipment Used: ${c.equipment.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return parts;
  }).join('\n\n');

  const prompt = `You are a construction project scheduling advisor analyzing production data.

PROJECT: ${projectName || 'Unnamed Project'}${jobNumber ? ` (Job #${jobNumber})` : ''}
DEADLINE: ${deadlineStr}

COST CODE PACING DATA:
${codeLines}

Based on this data, provide actionable scheduling recommendations. Use the labor productivity and estimated additional laborers figures to make specific, quantified recommendations — e.g. "Add 2 laborers from the existing crew" or "Add 1 laborer and an additional [specific equipment already used on this code]". When a cost code is behind:
- State how many additional laborers are needed based on the Est. Additional Laborers Needed figure
- Recommend by name from the Current Crew if they could be reallocated, or suggest adding a laborer
- If equipment is a bottleneck (low labor hours but still behind), recommend adding a specific machine from the Equipment Used list

Respond with a JSON object in this exact format:
{
  "summary": "2-3 sentence overall project status assessment",
  "recommendations": [
    {
      "priority": "high" | "medium" | "low",
      "costCode": "the cost code this applies to, or 'Overall' for project-level",
      "issue": "what the problem is (1 sentence)",
      "action": "what to do about it (1-2 sentences, be specific with numbers and names)"
    }
  ],
  "outlook": "on-track" | "at-risk" | "behind"
}

Only include recommendations where there is a real issue or insight. Do not pad with generic advice. Maximum 5 recommendations.`;

  // ── Call Claude ────────────────────────────────────────────────────────────
  try {
    const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message  = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw  = message.content[0].text.trim();
    // Strip markdown code fences if the model wrapped the JSON, then extract the JSON object
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'').trim();
    const jsonStart = stripped.indexOf('{');
    const jsonEnd   = stripped.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON object found in model response');
    const result  = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1));

    // ── Cache result ──────────────────────────────────────────────────────────
    try {
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${cacheKey}, ${JSON.stringify(result)}, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
    } catch (err) {
      console.warn('[ai/schedule] cache write failed:', err.message);
    }

    return res.json({ ...result, cached: false });

  } catch (err) {
    console.error('[ai/schedule] Claude error:', err.message);
    return res.status(500).json({ error: 'AI analysis failed', detail: err.message });
  }
};
