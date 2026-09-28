'use strict';
/**
 * The nightly copy of every company's saved data, and the check that reads it.
 * Run by api/cron/data-backup.js.
 *
 * In September a failed read on the turf page saved empty employee, equipment
 * and supplier lists over the real ones. Nothing held an earlier copy that
 * reached back far enough, so the lists were rebuilt from whatever the
 * projects happened to record — and nobody noticed for three days. This
 * answers both halves: a copy to restore from, and an email when a list
 * shrinks.
 *
 * Every run is stamped with the instant it started, to the second. Its copy,
 * its counts and any alert it sends all carry that stamp, so an alert's
 * restore always names the copy taken alongside the counts it compared
 * against — however many times a day the job runs.
 *
 * The backup
 *   Every app_data record, as each run found it, for RETAIN_DAYS. A record is
 *   stored only when it CHANGED since its last copy, so one left alone for a
 *   month costs one row, not thirty. Its state at any moment in the window is
 *   its newest copy at or before that moment, and a record that disappears
 *   gets a copy saying so. Pruning keeps that true: copies older than the
 *   window go, except each record's newest one from before it, which is still
 *   its state at the window's start — unless that copy says the record was
 *   deleted, when it goes too. The copying happens inside the database; no
 *   record travels through this function.
 *
 * The check
 *   Counts the entries in every company-level list — each array record, and
 *   each array inside an object record (fct_lists.employees,
 *   fct_lists.equipment...) — plus daily-tracking rows per division, and
 *   compares with the previous run. A list that empties, or loses half of six
 *   or more, is reported. Records that shrink as a matter of course are not
 *   watched: one job's own record, schedules that roll forward, presence, the
 *   news hub.
 *
 *   Each drop is reported once: every run's counts are the next run's
 *   baseline. An alert that cannot be sent is kept and tried again on later
 *   runs, up to MAX_SEND_ATTEMPTS in all, still pointing at the copy it found.
 *   A list gone entirely is recorded as empty once, so it is reported once
 *   and not every night after.
 *
 *   Counts are recorded only by a run whose copy was made, so the run an
 *   alert compares with always has a copy to restore from. After a failed
 *   copy the next run compares with the last run that made one, and reports
 *   again anything this run found.
 *
 *   One run at a time. Two at once — a scheduler that fires twice, or a run
 *   by hand over the nightly one — would both compare with the same earlier
 *   run and both send its alerts, so the second one stops.
 *
 *   A run whose backup or check fails says so by email too. A copy that has
 *   quietly stopped is the same problem as a list nobody noticed emptying.
 */

const { buildEmailHtml, sendEmail, isValidEmail } = require('./email');

const RETAIN_DAYS = 30;
// Counts are a few hundred small rows a run. A season of them is enough to
// see when a list started drifting.
const COUNTS_RETAIN_DAYS = 400;
// An alert that could not be sent is tried again on each later run, this many
// times in all: a week of nights, well inside RETAIN_DAYS, so the copy it
// points at is still there when it arrives.
const MAX_SEND_ATTEMPTS = 7;

// Records never copied, by key prefix: the heartbeat, rewritten every few
// seconds, and the assistants' caches, a new record per job or signature per
// day, rebuilt on demand.
const SKIP_BACKUP = ['fct_presence', 'fct_ai_', 'fct_scheduler_ai_'];

// The value_hash of a copy that records the record's deletion, not a value.
const DELETED = 'deleted';

// Lists that shrink as a matter of course. A drop in these is not data loss.
const UNWATCHED = [
  /presence/,
  /^fct_(paving_|kiewit_)?project_/,          // one job's own record: its lists are edited, not accumulated
  /^fct_(paving_|kiewit_)?conschedule_/,      // construction schedules and their templates
  /^fct_scheduler/,                           // the Scheduler board's assignments roll forward
  /^fct_trucking(_labor)?_schedule/,          // so do the trucking boards
  /crm_news/,                                 // rewritten by the overnight news pull
  /^fct_trend_/, /^fct_lucius_/, /^fct_ai_/,  // derived and assistant state
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

/** A run's stamp: the instant to the whole second, as '2026-09-28T09:45:03Z'. */
function runInstant(now = new Date()) {
  return new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** A stamp shifted by whole days. */
function shiftDays(at, days) {
  return runInstant(new Date(Date.parse(at) + days * 86400000));
}

/** '2026-09-28T09:45:03Z' → '2026-09-28 09:45 UTC', for people. */
function human(at) {
  const s = String(at);
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}

// A stamp read back from the database in the form runInstant writes it.
const STAMP = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

/**
 * Copies every record that changed since its last copy, and marks every
 * record deleted since its last copy.
 */
async function backupAppData(sql, at) {
  const stored = await sql`
    INSERT INTO app_data_snapshots (key, taken_at, company_code, value, value_hash, source_updated_at)
    SELECT a.key, ${at}::timestamptz, split_part(a.key, ':', 1), a.value,
           md5(COALESCE(a.value::text, '')), a.updated_at
    FROM app_data a
    WHERE strpos(a.key, ':') > 0
      AND NOT EXISTS (SELECT 1 FROM unnest(${SKIP_BACKUP}::text[]) AS s(prefix)
                      WHERE left(substr(a.key, strpos(a.key, ':') + 1), length(s.prefix)) = s.prefix)
      AND md5(COALESCE(a.value::text, '')) IS DISTINCT FROM (
            SELECT b.value_hash FROM app_data_snapshots b
            WHERE b.key = a.key AND b.taken_at <= ${at}::timestamptz
            ORDER BY b.taken_at DESC LIMIT 1)
    ON CONFLICT (key, taken_at) DO NOTHING
    RETURNING key
  `;
  // Without this copy a deleted record's last value would read as its state
  // for ever after, and pruning would keep that value for ever too.
  const gone = await sql`
    INSERT INTO app_data_snapshots (key, taken_at, company_code, value, value_hash, source_updated_at)
    SELECT l.key, ${at}::timestamptz, l.company_code, NULL::jsonb, ${DELETED}::text, NULL::timestamptz
    FROM (SELECT DISTINCT ON (b.key) b.key, b.company_code, b.value_hash
          FROM app_data_snapshots b
          WHERE b.taken_at <= ${at}::timestamptz
          ORDER BY b.key, b.taken_at DESC) l
    WHERE l.value_hash <> ${DELETED}::text
      AND NOT EXISTS (SELECT 1 FROM app_data a WHERE a.key = l.key)
    ON CONFLICT (key, taken_at) DO NOTHING
    RETURNING key
  `;
  return { stored: stored.length, gone: gone.length };
}

/**
 * Drops the copies the window no longer needs: those older than RETAIN_DAYS,
 * except each record's newest one from before the window, unless that one
 * says the record was deleted. Returns how many went.
 */
async function pruneSnapshots(sql, at) {
  const cutoff = shiftDays(at, -RETAIN_DAYS);
  const pruned = await sql`
    DELETE FROM app_data_snapshots b
    WHERE b.taken_at < ${cutoff}::timestamptz
      AND (b.value_hash = ${DELETED}::text
           OR EXISTS (SELECT 1 FROM app_data_snapshots n
                      WHERE n.key = b.key
                        AND n.taken_at > b.taken_at
                        AND n.taken_at < ${cutoff}::timestamptz))
    RETURNING b.key
  `;
  return pruned.length;
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

async function recordCounts(sql, at, rows) {
  if (!rows.length) return;
  await sql`
    INSERT INTO list_counts (company_code, taken_at, measure, n)
    SELECT t.c, ${at}::timestamptz, t.m, t.n
    FROM unnest(${rows.map(r => r.company_code)}::text[],
                ${rows.map(r => r.measure)}::text[],
                ${rows.map(r => r.n)}::int[]) AS t(c, m, n)
    ON CONFLICT (company_code, taken_at, measure) DO UPDATE SET n = EXCLUDED.n
  `;
}

/** The counts the latest earlier run recorded for a company, and its stamp. */
async function previousCounts(sql, companyCode, at) {
  const rows = await sql`
    SELECT to_char(taken_at AT TIME ZONE 'UTC', ${STAMP}) AS at, measure, n
    FROM list_counts
    WHERE company_code = ${companyCode}
      AND taken_at = (SELECT max(taken_at) FROM list_counts
                      WHERE company_code = ${companyCode} AND taken_at < ${at}::timestamptz)
  `;
  if (!rows.length) return null;
  return {
    at: rows[0].at,
    counts: new Map(rows.filter(r => isWatched(r.measure)).map(r => [r.measure, Number(r.n) || 0])),
  };
}

/**
 * The lists that shrank enough to report, biggest loss first. A list missing
 * now — its record gone, or the array dropped from it — counts as empty.
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
 * The SQL that puts one record back as it stood at `since`. The record is the
 * app_data key; daily-tracking rows are not in this backup and get no snippet.
 */
function restoreSql(companyCode, measure, since) {
  const key = `${companyCode}:${measure.split('.')[0]}`;
  const where = `WHERE key = '${sqlText(key)}' AND taken_at <= TIMESTAMPTZ '${sqlText(since)}'`;
  return [
    `-- Look first: the copy as it stood at ${human(since)}.`,
    `SELECT taken_at, value FROM app_data_snapshots`,
    where,
    `ORDER BY taken_at DESC LIMIT 1;`,
    ``,
    `-- Put it back, whether it was emptied or deleted outright. This replaces`,
    `-- the whole record, so anything changed in it since then goes too.`,
    `INSERT INTO app_data (key, value, updated_at)`,
    `SELECT key, value, NOW() FROM (`,
    `  SELECT key, value, value_hash FROM app_data_snapshots`,
    `  ${where}`,
    `  ORDER BY taken_at DESC LIMIT 1`,
    `) latest WHERE value_hash <> '${DELETED}'`,
    `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`,
  ].join('\n');
}

/**
 * The email for one company's drops. `since` is the run whose counts were
 * fuller, `at` the run that found them smaller. `late` marks an alert a
 * later run is sending because the run that found it could not.
 */
function buildAlert({ companyCode, companyName, since, at, drops, late = false }) {
  const rows = drops.map(d => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${esc(labelFor(d.measure))}
          <div style="font-size:11px;color:#6b7280;font-family:monospace">${esc(d.measure)}</div></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${esc(d.before)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;color:#991b1b;font-weight:700">${esc(d.after)}</td>
      </tr>`).join('');
  // One snippet per record — two arrays inside fct_lists are one restore.
  const records = [...new Set(drops.filter(d => !d.measure.startsWith('daily_tracking.'))
    .map(d => d.measure.split('.')[0]))];
  const snippets = records.map(r => `
      <div style="margin-top:14px;font-weight:700">${esc(labelFor(r))}</div>
      <pre style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;padding:10px;font-size:12px;white-space:pre-wrap">${esc(restoreSql(companyCode, r, since))}</pre>`).join('');
  const dailyNote = drops.some(d => d.measure.startsWith('daily_tracking.'))
    ? `<p style="font-size:13px">Daily-tracking rows are not in this backup. Restore them from Neon's
       history — create a branch from ${esc(human(since))}, when they were last counted in full — while
       that time is still inside the project's restore window.</p>`
    : '';
  const bodyHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:13px">
      <tr style="background:#f9fafb;text-align:left">
        <th style="padding:6px 10px">List</th>
        <th style="padding:6px 10px;text-align:right">${esc(human(since))}</th>
        <th style="padding:6px 10px;text-align:right">${esc(human(at))}</th>
      </tr>${rows}
    </table>
    ${records.length ? `<h3 style="font-size:15px;margin:22px 0 4px">To restore</h3>
    <p style="font-size:13px;margin:0">If the drop was not deliberate, run these in the Neon SQL editor
      (Primary branch). Each puts the record back as the ${esc(human(since))} copy has it.</p>${snippets}` : ''}
    ${dailyNote}`;
  const lists = drops.length === 1 ? 'a list' : `${drops.length} lists`;
  const html = buildEmailHtml({
    title: 'Lists that shrank',
    companyName: companyName || companyCode,
    note: `The ${human(at)} check found ${lists} holding far fewer entries than at ${human(since)}. `
      + (late ? 'That check could not send this email, so it comes late: if the lists have been put back since, there is nothing to do. '
              : 'If nobody meant to remove them, restore them before more work is saved on top.'),
    summary: [
      { label: 'Lists that shrank', value: String(drops.length), tone: 'bad' },
      { label: 'Last fuller copy', value: human(since) },
    ],
    bodyHtml,
  });
  const subject = `DataWatch: ${lists} shrank — ${companyName || companyCode}${late ? ` (found ${at.slice(0, 10)})` : ''}`;
  return { subject, html };
}

/** The email for a run whose backup or check did not finish. */
function buildFailure({ at, errors }) {
  const items = errors.map(e => `<li style="margin:4px 0"><strong>${esc(e.step)}${e.company ? ` (${esc(e.company)})` : ''}</strong>: ${esc(String(e.error).slice(0, 300))}</li>`).join('');
  const html = buildEmailHtml({
    title: 'The nightly backup did not finish',
    note: `The ${human(at)} run of the backup and list check hit errors, so its copy or its check may be missing. It runs again tomorrow; if this repeats, the backup has stopped.`,
    summary: [{ label: 'Run', value: human(at) }, { label: 'Steps that failed', value: String(errors.length), tone: 'bad' }],
    bodyHtml: `<ul style="font-size:13px;padding-left:18px">${items}</ul>`,
  });
  return { subject: `DataWatch: the nightly backup did not finish (${at.slice(0, 10)})`, html };
}

/** DATA_ALERT_EMAILS: addresses separated by commas, semicolons or spaces. */
function alertRecipients(raw = process.env.DATA_ALERT_EMAILS) {
  return [...new Set(String(raw || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))]
    .filter(isValidEmail);
}

/** Sends one email. Resolves to null once it is sent, else to why it was not. */
async function deliver(send, recipients, { subject, html }) {
  if (!recipients.length) return 'DATA_ALERT_EMAILS is not set';
  try {
    const sent = await send({ to: recipients, subject, html });
    return sent && sent.ok ? null : String((sent && sent.error) || 'send failed');
  } catch (err) {
    return err.message || 'send failed';
  }
}

/**
 * The whole run: back up, count, compare, email — unless another run is
 * under way, when it stops at once and says so in `skipped`.
 */
async function runDataBackup(sql, opts = {}) {
  const at = runInstant(opts.now || new Date());
  const send = opts.send || sendEmail;
  const recipients = opts.recipients || alertRecipients();
  const result = { at, backup: null, measures: 0, alerts: [], emailed: 0, pending: 0, errors: [] };

  // The lock is one row. A run that dies holding it (Vercel stops the
  // function after a minute) leaves it to go stale after five.
  const holder = `${at}/${Math.random().toString(36).slice(2, 10)}`;
  let locked = false;
  try {
    const got = await sql`
      INSERT INTO data_backup_lock (id, holder, locked_at) VALUES (1, ${holder}, NOW())
      ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, locked_at = EXCLUDED.locked_at
        WHERE data_backup_lock.locked_at < NOW() - INTERVAL '5 minutes'
      RETURNING holder
    `;
    if (!got.length) {
      result.skipped = 'another run is under way';
      result.failed = false;
      return result;
    }
    locked = true;
  } catch (err) {
    // The run can do its job without the lock: at worst a run alongside it
    // repeats an alert. It carries on, and says so.
    result.errors.push({ step: 'lock', error: err.message });
  }
  try {
    await runNight(sql, at, send, recipients, result);
  } finally {
    if (locked) {
      try { await sql`DELETE FROM data_backup_lock WHERE id = 1 AND holder = ${holder}`; }
      catch (err) { result.errors.push({ step: 'unlock', error: err.message }); }
    }
  }
  return result;
}

/**
 * The backup runs first, but its failure does not stop the check — a night
 * with no copy is exactly when a shrinking list most needs noticing — and one
 * company's failure does not stop the rest.
 */
async function runNight(sql, at, send, recipients, result) {
  let copied = false;
  try { result.backup = await backupAppData(sql, at); copied = true; }
  catch (err) { result.errors.push({ step: 'backup', error: err.message }); }

  try {
    const pruned = await pruneSnapshots(sql, at);
    if (result.backup) result.backup.pruned = pruned;
  } catch (err) { result.errors.push({ step: 'prune copies', error: err.message }); }

  let counts = null;
  try { counts = await readCounts(sql); }
  catch (err) { result.errors.push({ step: 'count', error: err.message }); }

  const names = new Map();
  try {
    (await sql`SELECT code, name FROM companies`).forEach(c => names.set(String(c.code), c.name));
  } catch (err) { result.errors.push({ step: 'companies', error: err.message }); }

  if (counts) {
    result.measures = counts.length;
    const byCompany = new Map();
    for (const r of counts) {
      if (!byCompany.has(r.company_code)) byCompany.set(r.company_code, new Map());
      byCompany.get(r.company_code).set(r.measure, r.n);
    }
    // A company whose every list vanished has no counts now, but still has
    // earlier ones — so it is checked too.
    const codes = new Set([...byCompany.keys(), ...names.keys()]);

    for (const code of codes) {
      const now = byCompany.get(code) || new Map();
      try {
        const prev = await previousCounts(sql, code, at);
        const drops = prev ? findDrops(prev.counts, now) : [];
        if (drops.length) {
          result.alerts.push({ company: code, since: prev.at, drops });
          const why = await deliver(send, recipients,
            buildAlert({ companyCode: code, companyName: names.get(code), since: prev.at, at, drops }));
          if (why === null) {
            result.emailed++;
          } else {
            result.errors.push({ company: code, step: 'email', error: why });
            // Kept for later runs to send. If it cannot even be kept, these
            // counts are not recorded either, so the next run finds the same
            // drop against the same baseline and tries again. A run that made
            // no copy records no counts at all, so it keeps nothing either.
            if (copied) {
              try {
                await sql`
                  INSERT INTO list_alerts_pending (company_code, found_at, since, drops, attempts, last_error)
                  VALUES (${code}, ${at}::timestamptz, ${prev.at}::timestamptz, ${JSON.stringify(drops)}::jsonb, 1, ${why})
                  ON CONFLICT (company_code, found_at) DO NOTHING
                `;
                result.pending++;
              } catch (err) {
                result.errors.push({ company: code, step: 'queue', error: err.message });
                continue;
              }
            }
          }
        }
        // Without a copy beside them these counts would send a later alert's
        // restore to an older copy than the counts it quotes.
        if (!copied) continue;
        const rows = [...now].map(([measure, n]) => ({ company_code: code, measure, n }));
        // A list gone now is recorded as empty, once: the next run compares
        // it as empty, and the run after that it is simply gone.
        if (prev) for (const [measure, n] of prev.counts) {
          if (!now.has(measure) && n > 0) rows.push({ company_code: code, measure, n: 0 });
        }
        // Recorded straight after this company's alert, so a failure later in
        // the run cannot send that alert a second time.
        try { await recordCounts(sql, at, rows); }
        catch (err) { result.errors.push({ company: code, step: 'record', error: err.message }); }
      } catch (err) {
        result.errors.push({ company: code, step: 'check', error: err.message });
      }
    }
  }

  // Alerts earlier runs found but could not send.
  try {
    const waiting = await sql`
      SELECT company_code, to_char(found_at AT TIME ZONE 'UTC', ${STAMP}) AS found_at,
             to_char(since AT TIME ZONE 'UTC', ${STAMP}) AS since, drops, attempts
      FROM list_alerts_pending
      WHERE found_at < ${at}::timestamptz
      ORDER BY found_at
    `;
    for (const p of waiting) {
      const code = String(p.company_code);
      const drops = typeof p.drops === 'string' ? JSON.parse(p.drops) : p.drops;
      const why = await deliver(send, recipients, buildAlert({
        companyCode: code, companyName: names.get(code), since: p.since, at: p.found_at, drops, late: true,
      }));
      const attempts = (Number(p.attempts) || 0) + 1;
      if (why === null || attempts >= MAX_SEND_ATTEMPTS) {
        await sql`DELETE FROM list_alerts_pending
                  WHERE company_code = ${code} AND found_at = ${p.found_at}::timestamptz`;
      } else {
        await sql`UPDATE list_alerts_pending SET attempts = ${attempts}, last_error = ${why}
                  WHERE company_code = ${code} AND found_at = ${p.found_at}::timestamptz`;
        result.pending++;
      }
      if (why === null) result.emailed++;
      else result.errors.push({ company: code, step: 'email', error: attempts >= MAX_SEND_ATTEMPTS
        ? `gave up on the ${human(p.found_at)} alert after ${attempts} attempts: ${why}` : why });
    }
  } catch (err) { result.errors.push({ step: 'retry', error: err.message }); }

  // Pruned before the failure email is written, so a failed prune is in it.
  try {
    await sql`DELETE FROM list_counts WHERE taken_at < ${shiftDays(at, -COUNTS_RETAIN_DAYS)}::timestamptz`;
  } catch (err) { result.errors.push({ step: 'prune counts', error: err.message }); }

  // Anything but a failed send means the backup or the check did not do its
  // job, and that is said the same way a shrinking list is.
  const broken = result.errors.filter(e => e.step !== 'email');
  result.failed = broken.length > 0;
  if (broken.length && recipients.length) {
    const why = await deliver(send, recipients, buildFailure({ at, errors: broken }));
    if (why === null) result.emailed++;
    else result.errors.push({ step: 'email', error: why });
  }
}

module.exports = {
  RETAIN_DAYS, COUNTS_RETAIN_DAYS, MAX_SEND_ATTEMPTS, EMPTIED_MIN, HALVED_MIN, SKIP_BACKUP, DELETED,
  isWatched, runInstant, shiftDays, human, findDrops, labelFor, restoreSql, buildAlert, buildFailure,
  alertRecipients, deliver, backupAppData, pruneSnapshots, readCounts, recordCounts, previousCounts, runDataBackup,
};
