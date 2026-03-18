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
    const parts = [
      `  • ${c.costCode}${c.subCode ? ' / ' + c.subCode : ''}`,
      `    Status: ${c.status}`,
      `    Bid Qty: ${c.bidQty > 0 ? c.bidQty : 'not set'} | Running Qty: ${c.runningQty}`,
      `    % Complete: ${c.bidQty > 0 ? Math.round((c.runningQty / c.bidQty) * 100) + '%' : 'unknown'}`,
      `    Days Worked: ${c.daysWorked} | Current Pace: ${c.currentPace > 0 ? c.currentPace.toFixed(2) + ' units/day' : 'no activity'}`,
      c.requiredPace != null ? `    Required Pace: ${c.requiredPace.toFixed(2)} units/day` : '    Required Pace: N/A (no deadline)',
      c.gap != null ? `    Gap: ${c.gap > 0 ? '+' + c.gap.toFixed(2) + ' units/day NEEDED' : Math.abs(c.gap).toFixed(2) + ' units/day ahead'}` : '    Gap: N/A',
      c.employees && c.employees.length ? `    Crew: ${c.employees.join(', ')}` : '',
      c.equipment && c.equipment.length ? `    Equipment: ${c.equipment.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return parts;
  }).join('\n\n');

  const prompt = `You are a construction project scheduling advisor analyzing production data.

PROJECT: ${projectName || 'Unnamed Project'}${jobNumber ? ` (Job #${jobNumber})` : ''}
DEADLINE: ${deadlineStr}

COST CODE PACING DATA:
${codeLines}

Based on this data, provide actionable scheduling recommendations. Be direct and specific — name the cost codes, suggest actual resources (add a laborer, add equipment), and quantify the impact where possible.

Respond with a JSON object in this exact format:
{
  "summary": "2-3 sentence overall project status assessment",
  "recommendations": [
    {
      "priority": "high" | "medium" | "low",
      "costCode": "the cost code this applies to, or 'Overall' for project-level",
      "issue": "what the problem is (1 sentence)",
      "action": "what to do about it (1-2 sentences, be specific)"
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
    // Strip markdown code fences if the model wrapped the JSON
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'').trim();
    const result  = JSON.parse(jsonStr);

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
