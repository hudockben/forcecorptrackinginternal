'use strict';
/**
 * The outstanding next steps, computed server-side for the scheduled email.
 *
 * This is the same rule the CRM tab applies in the browser, written a second
 * time because the tab's copy lives inside tracker.html and a cron cannot
 * reach into a page. Two copies of a rule is a drift risk, so
 * scripts/test-crm-revamp.js lifts the tab's function out of the HTML and
 * runs both over the same fixtures, asserting they agree row for row. If
 * someone changes one, the test fails rather than the Monday email quietly
 * disagreeing with the screen.
 *
 * The rule, restated because it is the part worth getting right: the latest
 * touch that SET a next step is the promise outstanding. A later touch that
 * set no next step does not clear it — saying nothing is not the same as
 * saying it is done. A promise attached to a deal that has since closed is
 * not owed and drops out.
 */

const KEYS = {
  touches:       'fct_crm_touches',
  people:        'fct_crm_people',
  opportunities: 'fct_crm_opportunities',
};

async function readBlob(sql, companyCode, key) {
  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:${key}`}`;
    if (!rows.length) return [];
    const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    return Array.isArray(v) ? v : [];
  } catch (err) {
    console.error('[crm-next-steps] read failed:', key, err.message);
    return [];
  }
}

/**
 * @param {object} data  { touches, people, opportunities }
 * @param {Date}   today
 * @returns rows, most overdue first, undated last.
 */
function outstandingSteps(data, today) {
  const touches = Array.isArray(data.touches) ? data.touches : [];
  const people  = Array.isArray(data.people) ? data.people : [];
  const opps    = Array.isArray(data.opportunities) ? data.opportunities : [];

  const latest = new Map();
  for (const t of touches) {
    if (!String((t && t.next_step) || '').trim()) continue;
    const key = t.person_id ? 'p:' + t.person_id
              : t.opp_id    ? 'o:' + t.opp_id
              : 'c:' + String(t.company || '').trim().toLowerCase();
    const cur = latest.get(key);
    if (!cur || String(t.at) > String(cur.at)) latest.set(key, t);
  }

  const now    = today || new Date();
  const todayS = now.toISOString().slice(0, 10);

  const who = t => {
    if (t.person_id) {
      const p = people.find(x => x.id === t.person_id);
      if (p) return p.name || '(unnamed contact)';
    }
    if (t.opp_id) {
      const o = opps.find(x => x.id === t.opp_id);
      if (o) return o.name || '(unnamed opportunity)';
    }
    return t.company || '(deleted)';
  };

  return [...latest.values()].map(t => {
    const person = t.person_id ? people.find(p => p.id === t.person_id) : null;
    const opp    = t.opp_id    ? opps.find(o => o.id === t.opp_id) : null;
    const due    = String(t.next_step_date || '');
    return {
      id: t.id, at: t.at, due,
      overdue: !!due && due < todayS,
      due_in:  due ? Math.round((Date.parse(due) - Date.parse(todayS)) / 86400000) : null,
      next_step: t.next_step,
      who:      who(t),
      company:  t.company || (opp && opp.company) || (person && person.company) || '',
      lead_contact: (opp && opp.lead_contact) || (person && person.lead_contact) || '',
      phone:    (person && person.work_phone) || '',
      email:    (person && person.work_email) || '',
      by:       t.by || '',
      _closed:  !!opp && ['Won', 'Lost'].includes(String(opp.status || '').trim()),
    };
  })
  .filter(r => !r._closed)
  .sort((a, b) => {
    if (!a.due && !b.due) return String(b.at).localeCompare(String(a.at));
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due.localeCompare(b.due);
  });
}

/** Everything owed, for one company. */
async function stepsForCompany(sql, companyCode, today) {
  const [touches, people, opportunities] = await Promise.all([
    readBlob(sql, companyCode, KEYS.touches),
    readBlob(sql, companyCode, KEYS.people),
    readBlob(sql, companyCode, KEYS.opportunities),
  ]);
  return outstandingSteps({ touches, people, opportunities }, today);
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The email body: overdue first, then the coming week, grouped by whoever
 * owns the relationship.
 *
 * Grouped rather than one flat list because the email goes to a distribution
 * group, and a rep scanning it wants to find their own name and stop reading.
 * Tables all the way down — Outlook is unreliable with anything else.
 */
function buildStepsHtml(rows, opts = {}) {
  const horizon = opts.horizonDays == null ? 7 : opts.horizonDays;
  const todayS  = (opts.today || new Date()).toISOString().slice(0, 10);
  const limit   = new Date(Date.parse(todayS) + horizon * 86400000).toISOString().slice(0, 10);

  const due = rows.filter(r => r.due && r.due <= limit);
  if (!due.length) return '';

  const byOwner = new Map();
  for (const r of due) {
    const k = String(r.lead_contact || '').trim() || 'Unassigned';
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(r);
  }

  const section = (owner, list) => {
    const rowsHtml = list.map(r => {
      const late = r.overdue;
      const when = late ? `${Math.abs(r.due_in)}d late` : r.due_in === 0 ? 'today' : `in ${r.due_in}d`;
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;white-space:nowrap;
                   color:${late ? '#b91c1c' : '#374151'};font-weight:${late ? 700 : 400};font-size:12px">${esc(when)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#111">${esc(r.next_step)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#374151">${esc(r.who)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#374151">${esc(r.company)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#6b7280;white-space:nowrap">${esc(r.phone)}</td>
      </tr>`;
    }).join('');

    const lateCount = list.filter(r => r.overdue).length;
    return `<div style="margin-bottom:20px">
      <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:6px">
        ${esc(owner)}
        <span style="font-weight:400;color:#6b7280">— ${list.length} owed${lateCount ? `, ${lateCount} overdue` : ''}</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr style="background:#f3f4f6">
          <th align="left" style="padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280">Due</th>
          <th align="left" style="padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280">Promised</th>
          <th align="left" style="padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280">Who</th>
          <th align="left" style="padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280">Company</th>
          <th align="left" style="padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280">Phone</th>
        </tr>
        ${rowsHtml}
      </table>
    </div>`;
  };

  // Whoever owes the most overdue goes first — the email should open on the
  // thing most at risk, not on whoever sorts alphabetically.
  const owners = [...byOwner.entries()].sort((a, b) => {
    const la = a[1].filter(r => r.overdue).length, lb = b[1].filter(r => r.overdue).length;
    return lb - la || b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });

  return owners.map(([owner, list]) => section(owner, list)).join('');
}

/** The figures across the top of the email. */
function buildStepsSummary(rows, opts = {}) {
  const horizon = opts.horizonDays == null ? 7 : opts.horizonDays;
  const todayS  = (opts.today || new Date()).toISOString().slice(0, 10);
  const limit   = new Date(Date.parse(todayS) + horizon * 86400000).toISOString().slice(0, 10);

  const overdue = rows.filter(r => r.overdue).length;
  const today   = rows.filter(r => r.due === todayS).length;
  const soon    = rows.filter(r => r.due && r.due > todayS && r.due <= limit).length;

  return [
    { label: 'Overdue',        value: String(overdue), tone: overdue ? 'bad' : 'good' },
    { label: 'Due today',      value: String(today) },
    { label: `Next ${horizon} days`, value: String(soon) },
    { label: 'Outstanding',    value: String(rows.length) },
  ];
}

module.exports = {
  KEYS, readBlob, outstandingSteps, stepsForCompany,
  buildStepsHtml, buildStepsSummary,
};
