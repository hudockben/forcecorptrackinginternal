'use strict';

const Anthropic      = require('@anthropic-ai/sdk');
const { neon }       = require('@neondatabase/serverless');
const jwt            = require('jsonwebtoken');

const CACHE_TTL_MS   = 30 * 60 * 1000; // 30 minutes
const RATE_LIMIT_MS  = 30 * 1000;     // 30 seconds per project
const _rateLimitMap  = new Map();      // projectKey → timestamp of last AI call

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

  const { projectId, projectName, jobNumber, today, deadline, daysLeft, costCodes, onTrackSummary } = req.body || {};

  if (!projectId || !Array.isArray(costCodes)) {
    return res.status(400).json({ error: 'projectId and costCodes array required' });
  }

  // Frontend sends local-timezone date; fallback to UTC only if not provided
  const todayStr    = today || new Date().toISOString().slice(0, 10);
  const sql         = neon(process.env.DATABASE_URL);
  // Include date in cache key so each day gets a fresh AI result (avoids stale date reasoning)
  const cacheKey    = `${payload.companyCode}:fct_ai_sched_${projectId}_${todayStr}`;

  // If all codes are on-track (no priority codes), skip AI call entirely
  if (costCodes.length === 0) {
    const allOnTrack = { summary: 'All cost codes are on track with no issues requiring attention.', recommendations: [], outlook: 'on-track', cached: false };
    try {
      await sql`INSERT INTO app_data (key, value, updated_at) VALUES (${cacheKey}, ${JSON.stringify(allOnTrack)}, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
    } catch {}
    return res.json(allOnTrack);
  }

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

  // ── Rate limit (per project, 30s cooldown between AI calls) ─────────────────
  const rateKey = `${payload.companyCode}:${projectId}`;
  const lastCall = _rateLimitMap.get(rateKey);
  if (lastCall && (Date.now() - lastCall) < RATE_LIMIT_MS) {
    return res.status(429).json({ error: 'Rate limited — try again in a few seconds' });
  }
  _rateLimitMap.set(rateKey, Date.now());

  // ── Build prompt ───────────────────────────────────────────────────────────
  const deadlineStr = deadline
    ? `${deadline} (${daysLeft !== null && daysLeft !== undefined ? (daysLeft < 0 ? `${Math.abs(daysLeft)} working days overdue` : daysLeft === 0 ? 'due today' : `${daysLeft} working days remaining`) : 'no days calculated'})`
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

    // Describe the deadline window source for this cost code
    let windowDesc = 'no deadline set';
    if (c.effectiveDaysLeft !== null && c.effectiveDaysLeft !== undefined) {
      const absDays = Math.abs(c.effectiveDaysLeft);
      const daysStr = absDays % 1 !== 0 ? absDays.toFixed(1) : String(absDays);
      const isOverdue = c.effectiveDaysLeft < 0;
      const isDueToday = c.effectiveDaysLeft === 0;
      if (c.usingPPDays) {
        windowDesc = isOverdue ? `${daysStr} planned working days overdue (Projection Planner schedule)`
          : isDueToday ? 'due today (Projection Planner schedule)'
          : `${daysStr} planned working days remaining (Projection Planner schedule)`;
      } else if (c.targetDate) {
        windowDesc = isOverdue ? `${daysStr} working days overdue past sub-code target date ${c.targetDate}`
          : isDueToday ? `due today — sub-code target date ${c.targetDate}`
          : `${daysStr} working days remaining to sub-code target date ${c.targetDate}`;
      } else {
        windowDesc = isOverdue ? `${daysStr} working days overdue past project deadline`
          : isDueToday ? 'due today — project deadline'
          : `${daysStr} working days remaining to project deadline`;
      }
    }

    const trendDirLabel = c.trendDirection
      ? ({ up: 'Improving (↑)', flat: 'Stable (→)', down: 'Declining (↓)' }[c.trendDirection] || c.trendDirection)
      : null;
    const streakLabel = (c.consecutiveDays >= 2 && c.consecutiveStatus)
      ? `${c.consecutiveDays} consecutive working days ${c.consecutiveStatus.replace('-', ' ')}`
      : null;

    const parts = [
      `  • ${c.costCode}${c.subCode ? ' / ' + c.subCode : ''}`,
      `    Status: ${c.status}`,
      `    Scheduling Window: ${windowDesc}`,
      c.targetDate ? `    Sub-Code Target Date: ${c.targetDate}` : '',
      `    Bid Qty: ${c.bidQty > 0 ? c.bidQty : 'not set'} | Running Qty: ${c.runningQty}`,
      `    % Complete: ${c.bidQty > 0 ? Math.round((c.runningQty / c.bidQty) * 100) + '%' : 'unknown'}`,
      `    Days Worked: ${c.daysWorked} | Current Pace: ${c.currentPace > 0 ? c.currentPace.toFixed(2) + ' units/day' : 'no activity'}`,
      c.requiredPace != null ? `    Required Pace: ${c.requiredPace.toFixed(2)} units/day` : '    Required Pace: N/A (no deadline)',
      c.gap != null ? `    Gap: ${c.gap > 0 ? '+' + c.gap.toFixed(2) + ' units/day NEEDED' : Math.abs(c.gap).toFixed(2) + ' units/day ahead'}` : '    Gap: N/A',
      unitsPerLaborHour !== null ? `    Labor Productivity: ${unitsPerLaborHour.toFixed(3)} units/labor-hr` : '',
      laborHoursPerDay !== null ? `    Labor Hrs/Day: ${laborHoursPerDay.toFixed(1)} hrs/day across ${c.employees ? c.employees.length : 0} laborer(s)` : '',
      additionalLaborers !== null ? `    Est. Additional Laborers Needed (8hr day): ${additionalLaborers}` : '',
      trendDirLabel ? `    Pace Trend (last 7 working days): ${trendDirLabel}${c.avg3DayPace != null ? ' · 3-day avg: ' + c.avg3DayPace.toFixed(2) + '/day' : ''}${c.avg7DayPace != null ? ' · 7-day avg: ' + c.avg7DayPace.toFixed(2) + '/day' : ''}` : '',
      streakLabel ? `    Status Streak: ${streakLabel}` : '',
      c.employees && c.employees.length ? `    Current Crew: ${c.employees.join(', ')}` : '',
      c.equipment && c.equipment.length ? `    Equipment Used: ${c.equipment.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return parts;
  }).join('\n\n');

  // Compact summary of on-track codes so AI knows the full picture without burning tokens
  const onTrackLines = Array.isArray(onTrackSummary) && onTrackSummary.length > 0
    ? onTrackSummary.map(c => `  • ${c.costCode}${c.subCode ? ' / ' + c.subCode : ''} — ${c.status}${c.pct !== null ? ` (${c.pct}%)` : ''}`).join('\n')
    : '';

  const prompt = `You are a construction project scheduling advisor analyzing production data.

TODAY'S DATE: ${todayStr} — use this as the current date for all date comparisons.
CRITICAL DATE RULES:
- A deadline is "past due" or "overdue" ONLY if today's date is AFTER (strictly greater than) the deadline date.
- If today's date EQUALS the deadline date, say it is "due today" — do NOT say it has "passed" or is "overdue."
- If today's date is before the deadline, say the deadline is "upcoming" with X days remaining.
- Never say a deadline "has already passed" when today is the deadline date itself.
PROJECT: ${projectName || 'Unnamed Project'}${jobNumber ? ` (Job #${jobNumber})` : ''}
DEADLINE: ${deadlineStr}

COST CODES NEEDING ATTENTION (full detail):
${codeLines || '  (none — all codes are on track)'}
${onTrackLines ? `\nON-TRACK COST CODES (summary only — no action needed):\n${onTrackLines}` : ''}

Based on this data, provide actionable scheduling recommendations. Each cost code shows its Scheduling Window — this tells you whether the deadline is based on Projection Planner planned working days, a sub-code-specific target date, or the overall project deadline. Use this context to frame urgency correctly: a code with only 3 planned working days left is far more urgent than one with 30 calendar days left.

Use the labor productivity and estimated additional laborers figures to make specific, quantified recommendations. When a cost code is behind:
- Reference the Scheduling Window to explain the urgency (e.g. "with only 4 planned working days remaining on the Projection Planner schedule...")
- State how many additional laborers are needed based on the Est. Additional Laborers Needed figure
- Recommend by name from the Current Crew if they could be reallocated, or suggest adding a laborer
- If equipment is a bottleneck (low labor hours but still behind), recommend adding a specific machine from the Equipment Used list
- If a sub-code target date is set and being missed, flag that the downstream schedule may be impacted
- If a cost code shows a declining pace trend for 2+ consecutive working days, flag it as an early warning even if not yet "behind"
- When a status streak is 3+ days, reference it explicitly (e.g. "behind for the 4th consecutive working day")
- A code that is "behind" but shows an improving trend should be acknowledged as recovering — recommend continuing the current approach

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
      model:      'claude-sonnet-4-6',
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
