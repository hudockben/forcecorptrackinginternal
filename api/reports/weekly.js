'use strict';

const { neon }     = require('@neondatabase/serverless');
const jwt          = require('jsonwebtoken');
const nodemailer   = require('nodemailer');

function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch { return null; }
}

function fmt(n, d = 0) {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function calcRowCost(r) {
  const laborCost   = (parseFloat(r.rate) || 0) * (parseFloat(r.labor_hours) || 0);
  const equipTotal  = r.equip_total_override != null
    ? parseFloat(r.equip_total_override)
    : (parseFloat(r.equip_unit_cost) || 0) * (parseFloat(r.equip_hours) || 0);
  const materialCost = parseFloat(r.material_cost) || 0;
  const override     = r.total_cost_override != null ? parseFloat(r.total_cost_override) : null;
  return override != null ? override : laborCost + equipTotal + materialCost;
}

function buildHtmlReport({ companyName, weekStart, weekEnd, projects, weeklyRows, deadlines, overBudget }) {
  const totalBid    = projects.reduce((s, p) => s + p.bid, 0);
  const totalActual = projects.reduce((s, p) => s + p.actual, 0);
  const weekCost    = weeklyRows.reduce((s, r) => s + calcRowCost(r), 0);

  // Top cost codes this week
  const codeTotals = {};
  weeklyRows.forEach(r => {
    const key = r.cost_code ? `${r.cost_code}${r.sub_code ? ' / ' + r.sub_code : ''}` : '(none)';
    codeTotals[key] = (codeTotals[key] || 0) + calcRowCost(r);
  });
  const topCodes = Object.entries(codeTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const projectRows = projects.map(p => {
    const pct     = p.bid > 0 ? ((p.actual / p.bid) * 100).toFixed(1) : '—';
    const varAmt  = p.bid - p.actual;
    const varTxt  = p.bid > 0 ? (varAmt >= 0 ? `$${fmt(varAmt)} under` : `$${fmt(Math.abs(varAmt))} OVER`) : '—';
    const varColor = varAmt < 0 ? '#ef4444' : '#22c55e';
    const flagged  = p.bid > 0 && p.actual > p.bid * 1.10;
    return `
      <tr style="border-bottom:1px solid #333;${flagged ? 'background:#2a1515;' : ''}">
        <td style="padding:0.5rem 0.75rem;color:#e5e5e5">${p.name}${flagged ? ' <span style="color:#ef4444;font-size:0.75rem">⚠ Over Budget</span>' : ''}</td>
        <td style="padding:0.5rem 0.75rem;color:#888">${p.status || '—'}</td>
        <td style="padding:0.5rem 0.75rem;text-align:right;color:#e5e5e5">$${fmt(p.bid)}</td>
        <td style="padding:0.5rem 0.75rem;text-align:right;color:#facc15">$${fmt(p.actual)}</td>
        <td style="padding:0.5rem 0.75rem;text-align:right;color:${varColor}">${varTxt}</td>
        <td style="padding:0.5rem 0.75rem;text-align:right;color:#888">${pct !== '—' ? pct + '%' : '—'}</td>
      </tr>`;
  }).join('');

  const deadlineRows = deadlines.map(d => {
    const days = d.deadline_date
      ? Math.ceil((new Date(d.deadline_date) - new Date()) / (1000 * 60 * 60 * 24))
      : null;
    const urgency = days != null && days <= 3 ? '#ef4444' : days != null && days <= 7 ? '#facc15' : '#888';
    return `
      <tr style="border-bottom:1px solid #333">
        <td style="padding:0.5rem 0.75rem;color:#e5e5e5">${d.message || '—'}</td>
        <td style="padding:0.5rem 0.75rem;color:#888">${d.project_name || '—'}</td>
        <td style="padding:0.5rem 0.75rem;color:${urgency}">
          ${d.deadline_date || '—'}${days != null ? ` (${days < 0 ? Math.abs(days) + 'd overdue' : days + 'd left'})` : ''}
        </td>
      </tr>`;
  }).join('');

  const codeRows = topCodes.map(([code, amt]) =>
    `<tr style="border-bottom:1px solid #333">
      <td style="padding:0.5rem 0.75rem;color:#e5e5e5">${code}</td>
      <td style="padding:0.5rem 0.75rem;text-align:right;color:#facc15">$${fmt(amt)}</td>
    </tr>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Weekly Report — ${companyName}</title></head>
<body style="margin:0;padding:0;background:#111;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:700px;margin:0 auto;padding:2rem 1rem">

    <!-- Header -->
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:1.5rem;margin-bottom:1.5rem">
      <div style="font-size:1.3rem;font-weight:700;color:#fff;margin-bottom:0.25rem">Weekly Report — ${companyName}</div>
      <div style="font-size:0.85rem;color:#888">${weekStart} — ${weekEnd}</div>
    </div>

    <!-- Summary cards -->
    <div style="display:flex;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap">
      <div style="flex:1;min-width:150px;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:1rem">
        <div style="font-size:0.75rem;color:#888;margin-bottom:0.25rem">Total Bid</div>
        <div style="font-size:1.4rem;font-weight:700;color:#22c55e">$${fmt(totalBid)}</div>
      </div>
      <div style="flex:1;min-width:150px;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:1rem">
        <div style="font-size:0.75rem;color:#888;margin-bottom:0.25rem">Total Actual</div>
        <div style="font-size:1.4rem;font-weight:700;color:#facc15">$${fmt(totalActual)}</div>
      </div>
      <div style="flex:1;min-width:150px;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:1rem">
        <div style="font-size:0.75rem;color:#888;margin-bottom:0.25rem">This Week's Spend</div>
        <div style="font-size:1.4rem;font-weight:700;color:#60a5fa">$${fmt(weekCost)}</div>
      </div>
      ${overBudget.length > 0 ? `
      <div style="flex:1;min-width:150px;background:#2a1515;border:1px solid #ef4444;border-radius:8px;padding:1rem">
        <div style="font-size:0.75rem;color:#ef4444;margin-bottom:0.25rem">Over Budget</div>
        <div style="font-size:1.4rem;font-weight:700;color:#ef4444">${overBudget.length} project${overBudget.length > 1 ? 's' : ''}</div>
      </div>` : ''}
    </div>

    ${overBudget.length > 0 ? `
    <!-- Budget alerts -->
    <div style="background:#2a1515;border:1px solid #ef4444;border-radius:8px;padding:1rem;margin-bottom:1.5rem">
      <div style="font-weight:600;color:#ef4444;margin-bottom:0.5rem">⚠ Budget Alerts — Projects Over Budget by More Than 10%</div>
      ${overBudget.map(p => `
        <div style="display:flex;justify-content:space-between;padding:0.3rem 0;border-bottom:1px solid #3a2020;color:#e5e5e5">
          <span>${p.name}</span>
          <span style="color:#ef4444;font-weight:600">${p.pct}% over ($${fmt(p.over)} excess)</span>
        </div>`).join('')}
    </div>` : ''}

    <!-- Projects table -->
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;margin-bottom:1.5rem;overflow:hidden">
      <div style="padding:0.75rem 1rem;border-bottom:1px solid #333;font-weight:600;color:#fff">All Projects</div>
      <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
        <thead>
          <tr style="border-bottom:1px solid #333;color:#888;font-size:0.75rem">
            <th style="padding:0.5rem 0.75rem;text-align:left">Project</th>
            <th style="padding:0.5rem 0.75rem;text-align:left">Status</th>
            <th style="padding:0.5rem 0.75rem;text-align:right">Bid</th>
            <th style="padding:0.5rem 0.75rem;text-align:right">Actual</th>
            <th style="padding:0.5rem 0.75rem;text-align:right">Variance</th>
            <th style="padding:0.5rem 0.75rem;text-align:right">% Used</th>
          </tr>
        </thead>
        <tbody>${projectRows || '<tr><td colspan="6" style="padding:1rem;text-align:center;color:#555">No projects found</td></tr>'}</tbody>
      </table>
    </div>

    <!-- Top cost codes -->
    ${topCodes.length > 0 ? `
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;margin-bottom:1.5rem;overflow:hidden">
      <div style="padding:0.75rem 1rem;border-bottom:1px solid #333;font-weight:600;color:#fff">Top Cost Codes — This Week</div>
      <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
        <tbody>${codeRows}</tbody>
      </table>
    </div>` : ''}

    <!-- Deadlines -->
    ${deadlines.length > 0 ? `
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;margin-bottom:1.5rem;overflow:hidden">
      <div style="padding:0.75rem 1rem;border-bottom:1px solid #333;font-weight:600;color:#fff">Upcoming Deadlines (Next 14 Days)</div>
      <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
        <thead>
          <tr style="border-bottom:1px solid #333;color:#888;font-size:0.75rem">
            <th style="padding:0.5rem 0.75rem;text-align:left">Description</th>
            <th style="padding:0.5rem 0.75rem;text-align:left">Project</th>
            <th style="padding:0.5rem 0.75rem;text-align:left">Due</th>
          </tr>
        </thead>
        <tbody>${deadlineRows}</tbody>
      </table>
    </div>` : ''}

    <!-- Footer -->
    <div style="font-size:0.75rem;color:#555;text-align:center;padding-top:1rem;border-top:1px solid #222">
      Generated by DataWatch · ${new Date().toLocaleString()}
    </div>
  </div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-cron-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);
  let companyCode, companyName, recipientEmail;

  // ── Auth: JWT (from UI) or CRON_SECRET header (from Vercel Cron) ──────────
  if (req.method === 'GET') {
    const cronSecret = req.headers['x-cron-secret'];
    if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized — invalid cron secret' });
    }
    // Cron mode: send to all companies that have REPORT_EMAIL configured
    recipientEmail = process.env.REPORT_EMAIL;
    if (!recipientEmail) return res.status(200).json({ ok: true, skipped: 'REPORT_EMAIL not set' });

    // Run report for every company
    const companies = await sql`SELECT code, name FROM companies ORDER BY code`;
    const results = [];
    for (const co of companies) {
      try {
        await _sendReport(sql, co.code, co.name, recipientEmail);
        results.push({ company: co.code, sent: true });
      } catch (e) {
        results.push({ company: co.code, error: e.message });
      }
    }
    return res.json({ ok: true, results });

  } else if (req.method === 'POST') {
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    companyCode    = payload.companyCode;
    companyName    = payload.companyName || companyCode;
    recipientEmail = req.body?.email;
    if (!recipientEmail) return res.status(400).json({ error: 'email is required in request body' });

    try {
      await _sendReport(sql, companyCode, companyName, recipientEmail);
      return res.json({ ok: true, sent: recipientEmail });
    } catch (err) {
      console.error('[reports/weekly] error:', err.message);
      return res.status(500).json({ error: 'Failed to send report', detail: err.message });
    }

  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
};

async function _sendReport(sql, companyCode, companyName, recipientEmail) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS environment variables');
  }

  // ── Gather data ────────────────────────────────────────────────────────────
  const now       = new Date();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const weekEndStr   = now.toISOString().slice(0, 10);
  const twoWeeksOut  = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Weekly daily rows
  const weeklyRows = await sql`
    SELECT * FROM daily_tracking
    WHERE company_code = ${companyCode} AND date >= ${weekStartStr} AND date <= ${weekEndStr}
  `;

  // Upcoming deadlines
  const deadlines = await sql`
    SELECT * FROM deadlines
    WHERE company_code = ${companyCode}
      AND (deadline_date IS NULL OR deadline_date <= ${twoWeeksOut})
    ORDER BY deadline_date ASC
    LIMIT 10
  `;

  // Projects from app_data
  const projRows = await sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_projects'}`;
  const rawProjects = projRows.length ? (projRows[0].value || []) : [];

  // Build per-project summaries
  // All daily rows for actual cost
  const allRows = await sql`
    SELECT project_id, rate, labor_hours, equip_unit_cost, equip_hours,
           equip_total_override, total_cost_override, material_cost
    FROM daily_tracking WHERE company_code = ${companyCode}
  `;
  const actualByProject = {};
  allRows.forEach(r => {
    actualByProject[r.project_id] = (actualByProject[r.project_id] || 0) + calcRowCost(r);
  });

  const projects = rawProjects.map(p => {
    const bid    = (p.bidItems || []).reduce((s, b) =>
      s + (parseFloat(b.quantity) || 0) * (parseFloat(b.unit_cost) || 0), 0);
    const actual = actualByProject[p.id] || 0;
    return { id: p.id, name: p['project-name'] || 'Untitled', status: p['status'] || '', bid, actual };
  });

  const overBudget = projects
    .filter(p => p.bid > 0 && p.actual > p.bid * 1.10)
    .map(p => ({
      name: p.name,
      pct:  ((p.actual / p.bid - 1) * 100).toFixed(1),
      over: p.actual - p.bid,
    }));

  // ── Build HTML ─────────────────────────────────────────────────────────────
  const html = buildHtmlReport({
    companyName,
    weekStart: weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    weekEnd:   now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    projects,
    weeklyRows,
    deadlines,
    overBudget,
  });

  // ── Send via SMTP ──────────────────────────────────────────────────────────
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to:      recipientEmail,
    subject: `Weekly Report — ${companyName} (${weekEndStr})`,
    html,
  });
}
