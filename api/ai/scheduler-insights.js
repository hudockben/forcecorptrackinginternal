'use strict';
/**
 * POST /api/ai/scheduler-insights
 *
 * AI advisor for the cross-division master Scheduler. Given a snapshot of the
 * active jobs (with at-risk sub-codes), the resource pool, cross-job conflicts
 * (people/equipment double-booked on the same day), and current staffing load,
 * it returns a prioritised set of scheduling recommendations and concrete
 * reassignment suggestions (move person X from job A to job B).
 *
 * Mirrors api/ai/schedule-analysis.js: Bearer auth, ANTHROPIC_API_KEY guard,
 * 30-min cache (keyed by company + day + a signature of the board so edits
 * invalidate it), and a 30s-per-company rate limit.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { neon }  = require('@neondatabase/serverless');
const jwt       = require('jsonwebtoken');

const CACHE_TTL_MS  = 30 * 60 * 1000;
const RATE_LIMIT_MS = 30 * 1000;
const _rateLimitMap = new Map();

function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch { return null; }
}

function hasScheduler(payload) {
  if (!payload) return false;
  if (payload.isPlatformAdmin) return true;
  const dr = payload.divisionRoles;
  return Boolean(dr && dr.scheduler && dr.scheduler !== 'no_access');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  if (!hasScheduler(payload)) return res.status(403).json({ error: 'Scheduler access required' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI not configured — ANTHROPIC_API_KEY missing.' });
  }

  const { today, jobs = [], conflicts = [], unstaffed = [], capacity = {} } = req.body || {};
  const todayStr = today || new Date().toISOString().slice(0, 10);
  const sql = neon(process.env.DATABASE_URL);

  // Signature so the cache refreshes when the board materially changes.
  const behindCount = jobs.reduce((s, j) => s + (j.subCodes || []).filter(c => c.status === 'behind' || c.status === 'at-risk').length, 0);
  const sig = `j${jobs.length}_b${behindCount}_x${conflicts.length}_u${unstaffed.length}_a${capacity.assignedThisWeek || 0}`;
  const cacheKey = `${payload.companyCode}:fct_scheduler_ai_${todayStr}_${sig}`;

  // ── Cache check ──
  try {
    const cached = await sql`SELECT value, updated_at FROM app_data WHERE key = ${cacheKey}`;
    if (cached.length) {
      const age = Date.now() - new Date(cached[0].updated_at).getTime();
      if (age < CACHE_TTL_MS) return res.json({ ...cached[0].value, cached: true });
    }
  } catch (err) { console.warn('[ai/scheduler] cache read failed:', err.message); }

  // ── Rate limit (per company) ──
  const rateKey = payload.companyCode;
  const last = _rateLimitMap.get(rateKey);
  if (last && (Date.now() - last) < RATE_LIMIT_MS) {
    return res.status(429).json({ error: 'Rate limited — try again in a few seconds' });
  }
  _rateLimitMap.set(rateKey, Date.now());

  // ── Build prompt ──
  const jobLines = jobs.map(j => {
    const codes = (j.subCodes || []).map(c => {
      const win = c.usingPPDays
        ? `${c.effectiveDaysLeft} planned working days left (Projection Planner)`
        : c.effectiveDaysLeft !== null && c.effectiveDaysLeft !== undefined
          ? `${c.effectiveDaysLeft} working days left to ${c.targetDate || 'project deadline'}`
          : 'no deadline set';
      const parts = [
        `    • ${c.costCode}${c.subCode ? ' / ' + c.subCode : ''} — ${c.status}`,
        `      ${c.pctComplete != null ? c.pctComplete + '% complete' : 'progress unknown'}, ${win}`,
        c.currentPace != null ? `      Current pace ${c.currentPace}/day` + (c.requiredPace != null ? `, required ${c.requiredPace}/day` : '') : '',
        c.gap != null && c.gap > 0 ? `      Behind by ${c.gap}/day` + (c.addlLaborersNeeded ? ` → ~${c.addlLaborersNeeded} more laborer(s) needed` : '') : '',
        c.crew && c.crew.length ? `      Current crew: ${c.crew.join(', ')}` : '      No crew currently assigned',
      ].filter(Boolean);
      return parts.join('\n');
    }).join('\n');
    return `  ${j.division.toUpperCase()} · ${j.name}${j.jobNumber ? ' (#' + j.jobNumber + ')' : ''}${j.deadline ? ' — deadline ' + j.deadline : ''}\n${codes || '    (no sub-codes need attention)'}`;
  }).join('\n\n');

  const conflictLines = conflicts.length
    ? conflicts.map(c => `  • ${c.date}: ${c.resource} double-booked on ${(c.jobs || []).map(x => x.name + (x.costCode ? ' [' + x.costCode + ']' : '')).join(' AND ')}`).join('\n')
    : '  (none)';

  const unstaffedLines = unstaffed.length
    ? unstaffed.map(u => `  • ${u.jobName} — ${u.costCode}${u.subCode ? ' / ' + u.subCode : ''}: behind, ~${u.addlLaborersNeeded || '?'} more laborer(s) needed`).join('\n')
    : '  (none)';

  const capLine = `Total field employees: ${capacity.totalEmployees ?? '?'}. Assigned this week: ${capacity.assignedThisWeek ?? '?'}. Idle/unassigned this week: ${capacity.idleThisWeek ?? '?'}.`;

  const prompt = `You are the operations scheduling advisor for a large multi-division construction company. A master scheduler is staffing crews and equipment across many simultaneous jobs.

TODAY'S DATE: ${todayStr} — use this for all date comparisons. A deadline is only "overdue" if today is strictly after it; if today equals it, say "due today".

RESOURCE CAPACITY:
${capLine}

CROSS-JOB CONFLICTS (same person/equipment booked on two jobs the same day — these are the highest priority to resolve):
${conflictLines}

JOBS AND SUB-CODES NEEDING ATTENTION (across divisions):
${jobLines || '  (all jobs on track)'}

UNDERSTAFFED / BEHIND WORK:
${unstaffedLines}

Based on this, act as a master scheduler. Produce specific, quantified guidance that moves real people:
- Resolve every cross-job conflict first: say which job each double-booked resource should stay on and which to pull them from, and why (favour the job that is more behind or has the nearer deadline).
- For behind/understaffed sub-codes, recommend how many laborers to add and, when possible, name idle or reallocatable crew to move (only use names that appear in the data).
- Flag jobs at risk of missing a deadline and the schedule impact.
- Be concrete with numbers and names. Do not pad with generic advice.

Respond with ONLY a JSON object in this exact format:
{
  "summary": "2-3 sentence assessment of the overall cross-division schedule health",
  "recommendations": [
    { "priority": "high" | "medium" | "low", "scope": "job name or 'Overall'", "issue": "the problem (1 sentence)", "action": "what to do, specific with numbers/names (1-2 sentences)" }
  ],
  "reassignments": [
    { "employee": "name", "fromJob": "job to pull from (or 'Unassigned')", "toJob": "job to staff", "reason": "why (1 sentence)" }
  ],
  "outlook": "on-track" | "at-risk" | "behind"
}
Only include real issues. Maximum 6 recommendations and 6 reassignments.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1536,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0].text.trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const jsonStart = stripped.indexOf('{');
    const jsonEnd = stripped.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON object found in model response');
    const result = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1));

    try {
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${cacheKey}, ${JSON.stringify(result)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
    } catch (err) { console.warn('[ai/scheduler] cache write failed:', err.message); }

    return res.json({ ...result, cached: false });
  } catch (err) {
    console.error('[ai/scheduler] Claude error:', err.message);
    return res.status(500).json({ error: 'AI analysis failed', detail: err.message });
  }
};
