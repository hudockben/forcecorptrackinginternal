'use strict';

// POST /api/email/send-report
//
// Sends a report HTML body to one or more recipients via Resend.
// Auth-gated to any logged-in user with access to the report's source
// division. The caller supplies the rendered HTML (the same HTML the
// existing print/PDF flow produces); the server sanitizes it, wraps it
// in an email shell, and dispatches.
//
// Body:
//   {
//     report_type:  'executive' | 'turf_daily_pm' | 'turf_daily_summary' | 'paving_daily_pm',
//     project_id?:  string,        // for project-scoped reports (PM reports)
//     project_name?:string,        // displayed in email title
//     recipients:   string[],      // 1..MAX_RECIPIENTS emails
//     subject:      string,        // email subject
//     note?:        string,        // optional caller note prepended above the report
//     html:         string         // report body HTML (inline-styled is best)
//   }
//
// Response:
//   { ok: true, id: '<resend-id>' } | { ok: false, error: '...' }

const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const {
  MAX_RECIPIENTS,
  MAX_HTML_BYTES,
  isValidEmail,
  sanitizeReportHtml,
  buildEmailHtml,
  sendEmail,
} = require('../lib/email');

// Each report type → which division the caller must have access to.
const REPORT_TYPES = {
  executive:            { division: 'executive', label: 'Executive Report'                 },
  turf_daily_pm:        { division: 'turf',      label: 'Daily PM Report'                  },
  turf_daily_summary:   { division: 'turf',      label: 'Daily Summary Report'             },
  turf_bid_items:       { division: 'turf',      label: 'Bid Line Items vs Actuals — Turf' },
  paving_daily_pm:      { division: 'paving',    label: 'Daily PM Report'                    },
  paving_daily_summary: { division: 'paving',    label: 'Daily Summary Report'               },
  paving_bid_items:     { division: 'paving',    label: 'Bid Line Items vs Actuals — Paving' },
  quarry_breakeven:     { division: 'quarry',    label: 'Quarry Break-Even Analysis'          },
  dust_tracking_summary:{ division: 'dust',      label: 'Dust Control Tracking Report'        },
  scheduler_dispatch:   { division: 'scheduler', label: 'Crew Dispatch Schedule'              },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const body = req.body || {};
  const {
    report_type,
    project_name,
    recipients,
    subject,
    note,
    html,
  } = body;

  // Validate report type + division access.
  const cfg = REPORT_TYPES[report_type];
  if (!cfg) return res.status(400).json({ ok: false, error: 'Unknown report_type' });
  if (!hasDivisionAccess(payload, cfg.division)) {
    return res.status(403).json({ ok: false, error: 'You do not have access to send this report' });
  }

  // Validate recipients.
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ ok: false, error: 'At least one recipient is required' });
  }
  const cleaned = [];
  const seen = new Set();
  for (const raw of recipients) {
    if (typeof raw !== 'string') continue;
    const e = raw.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    if (!isValidEmail(e)) {
      return res.status(400).json({ ok: false, error: `Invalid email: ${raw}` });
    }
    seen.add(e);
    cleaned.push(e);
    if (cleaned.length > MAX_RECIPIENTS) {
      return res.status(400).json({ ok: false, error: `Too many recipients (max ${MAX_RECIPIENTS})` });
    }
  }
  if (cleaned.length === 0) {
    return res.status(400).json({ ok: false, error: 'No valid recipients' });
  }

  // Validate body.
  if (typeof html !== 'string' || html.length === 0) {
    return res.status(400).json({ ok: false, error: 'Report body is required' });
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return res.status(413).json({ ok: false, error: 'Report HTML is too large' });
  }

  const safeBody = sanitizeReportHtml(html);

  // Build subject — caller can override, fallback to a sensible default.
  let finalSubject = (typeof subject === 'string' && subject.trim()) || cfg.label;
  if (project_name && typeof project_name === 'string' && !finalSubject.includes(project_name)) {
    finalSubject = `${cfg.label} — ${String(project_name).trim()}`;
  }
  finalSubject = finalSubject.slice(0, 200);

  const wrapped = buildEmailHtml({
    title:        finalSubject,
    note,
    bodyHtml:     safeBody,
    companyName:  payload.companyName,
    generatedAt:  new Date().toLocaleString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }),
  });

  const result = await sendEmail({
    to:      cleaned,
    subject: finalSubject,
    html:    wrapped,
  });

  if (!result.ok) {
    console.error('[email/send-report] failed:',
      result.error,
      'user=' + payload.username,
      'company=' + payload.companyCode,
      'report=' + report_type
    );
    return res.status(502).json({ ok: false, error: result.error || 'Email send failed' });
  }

  console.log('[email/send-report] sent',
    'id=' + result.id,
    'user=' + payload.username,
    'company=' + payload.companyCode,
    'report=' + report_type,
    'recipients=' + cleaned.length
  );

  return res.json({ ok: true, id: result.id, recipientCount: cleaned.length });
};
