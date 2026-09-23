'use strict';
/**
 * GET /api/cron/crm-next-steps-email — the Monday-morning "what you owe" mail.
 *
 * The Next Steps Due report answers a question nobody thinks to go and ask:
 * what did I promise on the last call, and has it come due. A report only
 * helps the person who opens it, and the promises most at risk belong to
 * whoever has not opened it in a fortnight. So it comes to them.
 *
 * It reuses the report distribution groups the executive and daily reports
 * already use — a group with report_type 'crm_next_steps' is the address
 * list. No group, no mail: this must never guess who should receive a list of
 * somebody's unkept promises.
 *
 * Nothing owed, nothing sent. A weekly email that is empty four weeks running
 * is an email people stop opening, and the fifth one matters.
 */
const { neon } = require('@neondatabase/serverless');
const { buildEmailHtml, sendEmail } = require('../lib/email');
const steps = require('../lib/crm-next-steps');

const REPORT_TYPE = 'crm_next_steps';

// How far ahead the mail looks. A week: far enough to plan the week around,
// near enough that everything in it is actionable now.
const HORIZON_DAYS = 7;

/** The address lists that asked for this report, per company. */
async function groupsFor(sql, companyCode) {
  try {
    const rows = await sql`
      SELECT name, emails FROM report_recipient_groups
       WHERE company_code = ${companyCode} AND report_type = ${REPORT_TYPE}`;
    return rows.map(r => ({
      name: r.name,
      emails: (Array.isArray(r.emails) ? r.emails : []).map(e => String(e || '').trim()).filter(Boolean),
    })).filter(g => g.emails.length);
  } catch (err) {
    console.error('[next-steps-email] group read failed:', companyCode, err.message);
    return [];
  }
}

async function runNextStepsEmail(sql, opts = {}) {
  const today  = opts.today || new Date();
  const result = { day: today.toISOString().slice(0, 10), companies: 0, sent: 0, skipped: [], errors: [] };

  const companies = await sql`SELECT code, name FROM companies ORDER BY code`;
  for (const c of companies) {
    const groups = await groupsFor(sql, c.code);
    if (!groups.length) { result.skipped.push({ company: c.code, why: 'no recipient group' }); continue; }

    const rows = await steps.stepsForCompany(sql, c.code, today);
    const body = steps.buildStepsHtml(rows, { today, horizonDays: HORIZON_DAYS });
    if (!body) { result.skipped.push({ company: c.code, why: 'nothing due' }); continue; }

    const summary = steps.buildStepsSummary(rows, { today, horizonDays: HORIZON_DAYS });
    const overdue = rows.filter(r => r.overdue).length;
    const html = buildEmailHtml({
      title: 'Next Steps Due',
      note: overdue
        ? `${overdue} promise${overdue === 1 ? '' : 's'} already past its due date. Everything below was agreed on a logged call — the date is what was said, not a guess.`
        : 'What was promised on the last call, coming due this week.',
      bodyHtml:    body,
      companyName: c.name || c.code,
      summary,
    });

    for (const g of groups) {
      const sent = await sendEmail({
        to: g.emails,
        subject: overdue
          ? `Next Steps Due — ${overdue} overdue`
          : 'Next Steps Due — this week',
        html,
      });
      if (sent.ok) result.sent++;
      else result.errors.push({ company: c.code, group: g.name, error: sent.error });
    }
    result.companies++;
  }
  return result;
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[next-steps-email] CRON_SECRET is not set — refusing to run');
    return res.status(503).json({ error: 'Not configured.' });
  }
  if (String(req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Not configured.' });

  const sql = neon(process.env.DATABASE_URL);
  try {
    const out = await runNextStepsEmail(sql, {});
    console.log('[next-steps-email]', JSON.stringify(out));
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    console.error('[next-steps-email] failed:', err.message);
    return res.status(500).json({ error: 'Send failed.' });
  }
};

module.exports.runNextStepsEmail = runNextStepsEmail;
module.exports.REPORT_TYPE  = REPORT_TYPE;
module.exports.HORIZON_DAYS = HORIZON_DAYS;
