'use strict';

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

  const { conflicts, projectName } = req.body || {};
  // conflicts: [{ date, employees: string[], assignments: [{ employee, costCode, subCode }] }]
  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    return res.status(400).json({ error: 'conflicts array required' });
  }

  const conflictLines = conflicts.map(c => {
    const empList = c.employees.join(', ');
    const assignLines = (c.assignments || [])
      .map(a => `      - ${a.employee}: assigned to ${a.costCode}${a.subCode ? ' / ' + a.subCode : ''}`)
      .join('\n');
    return `  Date: ${c.date}\n  Double-booked: ${empList}\n  Current assignments:\n${assignLines}`;
  }).join('\n\n');

  const prompt = `You are a construction scheduling advisor. The following workers are double-booked on the same day across multiple cost codes. Recommend which cost code each worker should stay on and which to be removed from.

Project: ${projectName || 'Unknown'}

CONFLICTS:
${conflictLines}

For each conflict, recommend the optimal assignment for each double-booked worker. Consider that cost codes higher in the list may be higher priority — but use your judgment based on context.

Respond with ONLY a JSON object in this exact format:
{
  "suggestions": [
    {
      "date": "YYYY-MM-DD",
      "resolutions": [
        {
          "employee": "Worker Name",
          "keepOn": "cost code / sub code to keep them on",
          "removeFrom": "cost code / sub code to remove them from",
          "reason": "1 sentence justification"
        }
      ]
    }
  ]
}`;

  try {
    const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw      = message.content[0].text.trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const jStart   = stripped.indexOf('{');
    const jEnd     = stripped.lastIndexOf('}');
    if (jStart === -1 || jEnd === -1) throw new Error('No JSON in model response');
    const result = JSON.parse(stripped.slice(jStart, jEnd + 1));
    return res.json(result);

  } catch (err) {
    console.error('[ai/conflict-resolve] error:', err.message);
    return res.status(500).json({ error: 'AI analysis failed', detail: err.message });
  }
};
