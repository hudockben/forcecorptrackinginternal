'use strict';
/**
 * The nightly copy of every company's saved data, and the morning check that
 * reads it. Run by api/cron/data-backup.js.
 *
 * In September a failed read on the turf page saved empty employee, equipment
 * and supplier lists over the real ones. Nothing held an earlier copy that
 * reached back far enough, so the lists were rebuilt from whatever the
 * projects happened to record — and nobody noticed for three days. This
 * answers both halves: a copy to restore from, and a morning email when a list
 * shrinks.
 *
 * The backup
 *   Every app_data record, as it stood each night, for RETAIN_DAYS. A record
 *   is stored only on nights it CHANGED, so one left alone for a month costs
 *   one row, not thirty. Its state on any night in the window is its newest
 *   row on or before that night, and pruning keeps that true: rows older than
 *   the window go, except each record's newest one from before it, which is
 *   still that record's state at the window's start. The copy is made inside
 *   the database in one statement — no blob travels through this function.
 *
 * The check
 *   Counts the entries in every company-level list — each array blob, and each
 *   array inside an object blob (fct_lists.employees, fct_lists.equipment...)
 *   — plus daily-tracking rows per division, and compares with the previous
 *   night. A list that empties, or loses half of six or more, is reported.
 *   Records that shrink as a matter of course are not watched: one job's own
 *   record, schedules that roll forward, presence, the news hub.
 *
 *   Each drop is reported once, on the night it happens. The night after, the
 *   smaller count is what gets compared.
 */

const { buildEmailHtml, sendEmail, isValidEmail } = require('./email');

const RETAIN_DAYS = 30;
// Counts are a few hundred small rows a night. A season of them is enough to
// see when a list started drifting.
const COUNTS_RETAIN_DAYS = 400;

// A record never copied: the heartbeat, rewritten every few seconds.
const SKIP_BACKUP = ['fct_presence'];

// Lists that shrink as a matter of course. A drop in these is not data loss.
const UNWATCHED = [
  /presence/,
  /^fct_(paving_|kiewit_)?project_/,          // one job's own record: its lists are edited, not accumulated
  /^fct_(paving_|kiewit_)?conschedule_/,      // construction schedules and their templates
  /^fct_scheduler/,                           // the Scheduler board's assignments roll forward
  /^fct_trucking(_labor)?_schedule/,          // so do the trucking boards
  /crm_news/,                                 // rewritten by the overnight news pull
  /^fct_trend_/, /^fct_lucius_/,              // derived and assistant state
  /^fct_last_sync/,
  /^fct_intercompany_removed_entries/,        // bookkeeping of deletions, not data
];

// A list reported as emptied must have held at least this many entries, and
// one reported as halved at least this many — below that, ordinary edits
// (two of three suppliers removed) would read as an incident.
const EMPTIED_MIN = 2;
const HALVED_MIN  = 6;

function isWatched(measure) {
  return !UNWATCHED.some(re => re.test(String(measure)));
}

/** 'YYYY-MM-DD' shifted by whole days. */
function shiftDay(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Copies every record that changed since its last copy, then prunes the
 * window. Returns how many records were stored and pruned.
 */
async function backupAppData(sql, day) {
  const stored = await sql`
    INSERT INTO app_data_backups (key, backup_date, company_code, value, value_hash, source_updated_at)
    SELECT a.key, ${day}::date, split_part(a.key, ':', 1), a.value,
           md5(COALESCE(a.value::text, '')), a.updated_at
    FROM app_data a
    WHERE strpos(a.key, ':') > 0
      AND NOT (substr(a.key, strpos(a.key, ':') + 1) = ANY(${SKIP_BACKUP}::text[]))
      AND md5(COALESCE(a.value::text, '')) IS DISTINCT FROM (
            SELECT b.value_hash FROM app_data_backups b
            WHERE b.key = a.key AND b.backup_date <= ${day}::date
            ORDER BY b.backup_date DESC LIMIT 1)
    ON CONFLICT (key, backup_date) DO UPDATE
      SET value = EXCLUDED.value, value_hash = EXCLUDED.value_hash,
          source_updated_at = EXCLUDED.source_updated_at, captured_at = NOW()
    RETURNING key
  `;
  const cutoff = shiftDay(day, -RETAIN_DAYS);
  const pruned = await sql`
    DELETE FROM app_data_backups b
    WHERE b.backup_date < ${cutoff}::date
      AND EXISTS (SELECT 1 FROM app_data_backups n
                  WHERE n.key = b.key
                    AND n.backup_date > b.backup_date
                    AND n.backup_date < ${cutoff}::date)
    RETURNING b.key
  `;
  return { stored: stored.length, pruned: pruned.length };
}

/**
 * Every watched list's size right now: [{ company_code, measure, n }].
 * `measure` is the record's key without the company prefix, with the array's
 * property appended for object records, or daily_tracking.<division>.
 */
async function readCounts(sql) {
  // jsonb_each is guarded by the CASE rather than by the WHERE: a lateral
  // call may run before the filter, and jsonb_each on an array throws.
  const rows = await sql`
    SELECT split_part(a.key, ':', 1)             AS company_code,
           substr(a.key, strpos(a.key, ':') + 1) AS measure,
           jsonb_array_length(a.value)           AS n
    FROM app_data a
    WHERE strpos(a.key, ':') > 0 AND jsonb_typeof(a.value) = 'array'
    UNION ALL
    SELECT split_part(a.key, ':', 1),
           substr(a.key, strpos(a.key, ':') + 1) || '.' || e.key,
           jsonb_array_length(e.value)
    FROM app_data a
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(a.value) = 'object'
                                       THEN a.value ELSE '{}'::jsonb END) e
    WHERE strpos(a.key, ':') > 0 AND jsonb_typeof(e.value) = 'array'
    UNION ALL
    SELECT company_code, 'daily_tracking.' || division, count(*)::int
    FROM daily_tracking
    WHERE company_code <> ''
    GROUP BY company_code, division
  `;
  return rows
    .filter(r => r.company_code && isWatched(r.measure))
    .map(r => ({ company_code: String(r.company_code), measure: String(r.measure), n: Number(r.n) || 0 }));
}

async function recordCounts(sql, day, counts) {
  if (!counts.length) return;
  await sql`
    INSERT INTO data_watch_counts (company_code, day, measure, n)
    SELECT t.c, ${day}::date, t.m, t.n
    FROM unnest(${counts.map(r => r.company_code)}::text[],
                ${counts.map(r => r.measure)}::text[],
                ${counts.map(r => r.n)}::int[]) AS t(c, m, n)
    ON CONFLICT (company_code, day, measure) DO UPDATE SET n = EXCLUDED.n
  `;
}

/** The last night before `day` that has counts, and those counts. */
async function previousCounts(sql, companyCode, day) {
  const rows = await sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, measure, n
    FROM data_watch_counts
    WHERE company_code = ${companyCode}
      AND day = (SELECT max(day) FROM data_watch_counts
                 WHERE company_code = ${companyCode} AND day < ${day}::date)
  `;
  if (!rows.length) return null;
  return {
    day: rows[0].day,
    counts: new Map(rows.filter(r => isWatched(r.measure)).map(r => [r.measure, Number(r.n) || 0])),
  };
}

/**
 * The lists that shrank enough to report, biggest loss first. A list missing
 * tonight — its record gone, or the array dropped from it — counts as empty.
 * Growth and new lists are never reported.
 */
function findDrops(prev, now) {
  const out = [];
  for (const [measure, before] of prev) {
    const after = now.has(measure) ? now.get(measure) : 0;
    if (after >= before) continue;
    const emptied = after === 0 && before >= EMPTIED_MIN;
    const halved  = before >= HALVED_MIN && after <= before / 2;
    if (emptied || halved) out.push({ measure, before, after });
  }
  return out.sort((a, b) => (b.before - b.after) - (a.before - a.after) || a.measure.localeCompare(b.measure));
}

const DIVISION_PREFIXES = [
  ['paving_', 'Paving'], ['kiewit_', 'Kiewit'], ['quarry_', 'Quarry'],
  ['intercompany_', 'Intercompany'], ['crm_', 'Turf CRM'],
];

/** 'fct_lists.employees' → 'Turf: lists › employees'. */
function labelFor(measure) {
  if (measure.startsWith('daily_tracking.')) return `Daily tracking rows (${measure.slice(15)})`;
  const dot = measure.indexOf('.');
  let key  = dot < 0 ? measure : measure.slice(0, dot);
  const prop = dot < 0 ? '' : measure.slice(dot + 1);
  let division = 'Turf';
  let suffix = '';
  const colon = key.indexOf(':');
  if (colon >= 0) { suffix = ` (${key.slice(colon + 1)})`; key = key.slice(0, colon); }
  let rest = key;
  if (rest.startsWith('dust_')) { division = 'Dust'; rest = rest.slice(5); }
  else {
    rest = rest.replace(/^fct_/, '');
    for (const [p, name] of DIVISION_PREFIXES) {
      if (rest.startsWith(p)) { division = name; rest = rest.slice(p.length); break; }
    }
  }
  const words = s => s.replace(/_/g, ' ');
  return `${division}: ${words(rest)}${suffix}${prop ? ' › ' + words(prop) : ''}`;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const sqlText = s => String(s).replace(/'/g, "''");

/**
 * The SQL that puts one record back as it was on `day`. The record is the
 * app_data key; daily-tracking rows are not in this backup and get no snippet.
 */
function restoreSql(companyCode, measure, day) {
  const key = `${companyCode}:${measure.split('.')[0]}`;
  return [
    `-- Look first: what the ${day} copy holds.`,
    `SELECT backup_date, value FROM app_data_backups`,
    `WHERE key = '${sqlText(key)}' AND backup_date <= DATE '${day}'`,
    `ORDER BY backup_date DESC LIMIT 1;`,
    ``,
    `-- Put it back. This replaces the whole record, so anything changed in it`,
    `-- since ${day} goes too.`,
    `UPDATE app_data SET updated_at = NOW(), value = (`,
    `  SELECT value FROM app_data_backups`,
    `  WHERE key = '${sqlText(key)}' AND backup_date <= DATE '${day}'`,
    `  ORDER BY backup_date DESC LIMIT 1)`,
    `WHERE key = '${sqlText(key)}';`,
  ].join('\n');
}

function buildAlert({ companyCode, companyName, prevDay, day, drops }) {
  const rows = drops.map(d => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${esc(labelFor(d.measure))}
          <div style="font-size:11px;color:#6b7280;font-family:monospace">${esc(d.measure)}</div></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${d.before}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;color:#991b1b;font-weight:700">${d.after}</td>
      </tr>`).join('');
  // One snippet per record — two arrays inside fct_lists are one restore.
  const records = [...new Set(drops.filter(d => !d.measure.startsWith('daily_tracking.'))
    .map(d => d.measure.split('.')[0]))];
  const snippets = records.map(r => `
      <div style="margin-top:14px;font-weight:700">${esc(labelFor(r))}</div>
      <pre style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;padding:10px;font-size:12px;white-space:pre-wrap">${esc(restoreSql(companyCode, r, prevDay))}</pre>`).join('');
  const dailyNote = drops.some(d => d.measure.startsWith('daily_tracking.'))
    ? `<p style="font-size:13px">Daily-tracking rows are not in this backup. Restore them from Neon's
       history — create a branch from a point in time before ${esc(day)} — while that time is still
       inside the project's restore window.</p>`
    : '';
  const bodyHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:13px">
      <tr style="background:#f9fafb;text-align:left">
        <th style="padding:6px 10px">List</th>
        <th style="padding:6px 10px;text-align:right">${esc(prevDay)}</th>
        <th style="padding:6px 10px;text-align:right">${esc(day)}</th>
      </tr>${rows}
    </table>
    ${records.length ? `<h3 style="font-size:15px;margin:22px 0 4px">To restore</h3>
    <p style="font-size:13px;margin:0">If the drop was not deliberate, run these in the Neon SQL editor
      (Primary branch). Each puts the record back as the ${esc(prevDay)} backup has it.</p>${snippets}` : ''}
    ${dailyNote}`;
  const html = buildEmailHtml({
    title: 'Lists that shrank overnight',
    companyName: companyName || companyCode,
    note: `The nightly check found ${drops.length === 1 ? 'a list' : `${drops.length} lists`} holding far fewer entries than on ${prevDay}. If nobody meant to remove them, restore them before more work is saved on top.`,
    summary: [
      { label: 'Lists that shrank', value: String(drops.length), tone: 'bad' },
      { label: 'Last fuller backup', value: prevDay },
    ],
    bodyHtml,
  });
  const subject = `DataWatch: ${drops.length === 1 ? 'a list' : `${drops.length} lists`} shrank overnight — ${companyName || companyCode}`;
  return { subject, html };
}

/** DATA_ALERT_EMAILS: addresses separated by commas, semicolons or spaces. */
function alertRecipients(raw = process.env.DATA_ALERT_EMAILS) {
  return [...new Set(String(raw || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))]
    .filter(isValidEmail);
}

/**
 * The whole night: back up, count, compare, email. Never lets one company's
 * email failure stop the rest; the backup always runs first, so a failed
 * check still leaves tonight's copy behind.
 */
async function runDataBackup(sql, opts = {}) {
  const day = opts.day || (opts.today || new Date()).toISOString().slice(0, 10);
  const send = opts.send || sendEmail;
  const recipients = opts.recipients || alertRecipients();
  const result = { day, backup: null, measures: 0, alerts: [], emailed: 0, errors: [] };

  result.backup = await backupAppData(sql, day);

  const counts = await readCounts(sql);
  result.measures = counts.length;
  await recordCounts(sql, day, counts);

  const byCompany = new Map();
  for (const r of counts) {
    if (!byCompany.has(r.company_code)) byCompany.set(r.company_code, new Map());
    byCompany.get(r.company_code).set(r.measure, r.n);
  }
  const names = new Map();
  try {
    (await sql`SELECT code, name FROM companies`).forEach(c => names.set(String(c.code), c.name));
  } catch (err) { result.errors.push({ step: 'companies', error: err.message }); }
  // A company whose every list vanished has no counts tonight, but still has
  // last night's — so it is checked too.
  const codes = new Set([...byCompany.keys(), ...names.keys()]);

  for (const code of codes) {
    try {
      const prev = await previousCounts(sql, code, day);
      if (!prev) continue;
      const drops = findDrops(prev.counts, byCompany.get(code) || new Map());
      if (!drops.length) continue;
      result.alerts.push({ company: code, since: prev.day, drops });
      if (!recipients.length) {
        result.errors.push({ company: code, step: 'email', error: 'DATA_ALERT_EMAILS is not set' });
        continue;
      }
      const { subject, html } = buildAlert({ companyCode: code, companyName: names.get(code), prevDay: prev.day, day, drops });
      const sent = await send({ to: recipients, subject, html });
      if (sent && sent.ok) result.emailed++;
      else result.errors.push({ company: code, step: 'email', error: (sent && sent.error) || 'send failed' });
    } catch (err) {
      result.errors.push({ company: code, step: 'check', error: err.message });
    }
  }

  try {
    await sql`DELETE FROM data_watch_counts WHERE day < ${shiftDay(day, -COUNTS_RETAIN_DAYS)}::date`;
  } catch (err) { result.errors.push({ step: 'prune counts', error: err.message }); }

  return result;
}

module.exports = {
  RETAIN_DAYS, COUNTS_RETAIN_DAYS, EMPTIED_MIN, HALVED_MIN,
  isWatched, shiftDay, findDrops, labelFor, restoreSql, buildAlert, alertRecipients,
  backupAppData, readCounts, recordCounts, previousCounts, runDataBackup,
};
