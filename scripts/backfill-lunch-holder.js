#!/usr/bin/env node
'use strict';
/**
 * Move each existing split day's lunch break onto the job it fell in.
 *
 * Usage:
 *   node scripts/backfill-lunch-holder.js                 # dry run — writes nothing
 *   node scripts/backfill-lunch-holder.js --apply         # rewrite drafts and submitted entries
 *   node scripts/backfill-lunch-holder.js --show-approved # also LIST affected approved days
 *
 *   --company FC        only this company
 *   --from 2026-01-01   only days on or after
 *   --to   2026-12-31   only days on or before
 *   --limit 50          cap the number of days rewritten in one pass
 *
 * Requires DATABASE_URL in the environment (or a .env file), like migrate.js.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 * The day's one unpaid break used to be deducted from whichever job of a split
 * day was entered first. It now goes to the job the break fell in. Entries
 * written before that change still carry the old allocation, so on those days
 * one job is half an hour short of a window it worked in full and another is
 * half an hour long.
 *
 * For each affected day this moves the flag and rewrites both rows' hours from
 * their own punches. THE DAY'S TOTAL DOES NOT CHANGE — it reallocates between
 * two jobs of the same day. Any day where that invariant does not hold is
 * reported and skipped, never written.
 *
 * ── What it refuses to do ─────────────────────────────────────────────────
 * Three shapes are reported and never rewritten, because putting them right
 * would change what a day PAYS rather than which job is charged:
 *
 *   two breaks  a day already deducted twice. Correcting it hands hours back.
 *   drift       a row whose stored hours match neither its punches nor its own
 *               lunch flag. Something this backfill knows nothing about wrote
 *               that figure, and recomputing it would move the day's pay for a
 *               reason nobody established.
 *   unusable    punches that do not compute, so no job can be chosen.
 *
 * ── Why approved days are never written ──────────────────────────────────
 * Approving an entry posts cost rows derived from its hours — the
 * daily_tracking split and its cost, a Truck Tracking row, a quarry row, a dust
 * EES row — and every one stores an ABSOLUTE figure copied at approval time.
 * Nothing re-derives them. Moving 0.5h under an approved day would:
 *
 *   - leave both jobs mis-costed by half an hour of labour, in opposite
 *     directions, with the cost tab and payroll disagreeing and nothing saying so;
 *   - break the split's balance check, which requires the allocation to equal
 *     computed_hours + travel to within 0.001h. Half an hour is five hundred
 *     times that, so the day can no longer be saved from Edit Split at all —
 *     not even to fix a cost code — until someone re-types hours they never
 *     changed and decides afresh which cost row absorbs the half hour;
 *   - leave haul_hours possibly EXCEEDING computed_hours on a hauled day, so
 *     prevailing and standard hours stop adding up.
 *
 * The API already refuses the same edit for the same reason (a 409 telling you
 * to un-approve first). A script has no business doing quietly what the
 * application refuses to do loudly, so --show-approved only LISTS those days.
 * To move one: un-approve it (which removes the injected rows), re-run this,
 * then re-approve with a fresh split. Un-approving a QUARRY day is the one
 * exception worth care — the blob row it deletes is the only store of some of
 * its fields.
 *
 * Every row it changes gets an audit entry, so the whole pass is reconstructible
 * and reversible from timesheet_audit_log.
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const path = require('path');
const B = require(path.resolve(__dirname, 'lib/lunch-backfill.js'));

// Read at call time, not at load time, so the script can be driven from a test
// with a stubbed driver — see scripts/test-lunch-backfill-run.js. A backfill
// that has never been run end to end is a backfill nobody should point at
// payroll, and there is no database to rehearse against.
function parseArgs(argv) {
  const has = f => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    APPLY:        has('--apply'),
    SHOW_APPROVED: has('--show-approved'),
    COMPANY:      val('--company', null),
    FROM:         val('--from', null),
    TO:           val('--to', null),
    LIMIT:        Number(val('--limit', '0')) || 0,
    // Never widened. Approved days carry injected cost rows that hold an
    // absolute copy of these hours; see the header.
    STATUSES:     ['draft', 'submitted'],
  };
}

const n2 = n => Number(n).toFixed(2);
const pad = (s, w) => String(s).padEnd(w);

async function main(argv) {
  const { APPLY, SHOW_APPROVED, COMPANY, FROM, TO, LIMIT, STATUSES } =
    parseArgs(argv || process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Put it in your environment or a .env file, as migrate.js does.');
    if (require.main === module) process.exit(2);
    return;
  }
  const sql = neon(process.env.DATABASE_URL);

  console.log(APPLY ? '── APPLYING ──' : '── DRY RUN — nothing will be written ──');
  console.log(`statuses: ${STATUSES.join(', ')}`);
  if (COMPANY) console.log(`company:  ${COMPANY}`);
  if (FROM || TO) console.log(`dates:    ${FROM || '(any)'} → ${TO || '(any)'}`);
  console.log('');

  // Only split days can have the break in the wrong place, so only their rows
  // are read. Every row of a candidate group is fetched, including ones the
  // date filter would have excluded, because a day is judged whole.
  const groupIds = await sql`
    SELECT DISTINCT split_group_id
      FROM timesheet_entries
     WHERE entry_type = 'daily'
       AND split_group_id IS NOT NULL
       AND (${COMPANY}::text IS NULL OR company_code = ${COMPANY})
       AND (${FROM}::date   IS NULL OR work_date >= ${FROM}::date)
       AND (${TO}::date     IS NULL OR work_date <= ${TO}::date)
  `;
  if (!groupIds.length) { console.log('No split days found in that scope.'); return; }

  const ids = groupIds.map(g => g.split_group_id);
  const rows = await sql`
    SELECT id, company_code, username, entry_type, status, work_date,
           job_label, division, start_time, end_time, computed_hours,
           lunch_break, split_group_id, split_index, split_count
      FROM timesheet_entries
     WHERE entry_type = 'daily' AND split_group_id = ANY(${ids})
  `;

  const plan = B.planBackfill(rows, { statuses: STATUSES });

  // ── The report ──────────────────────────────────────────────────────────
  console.log(`${plan.counts.groups} split days examined (${plan.counts.rowsExamined} rows)\n`);

  if (plan.moves.length) {
    console.log(`${plan.moves.length} day(s) to move:\n`);
    console.log('  ' + pad('date', 12) + pad('who', 16) + pad('from', 26) + pad('to', 26) + 'day total');
    console.log('  ' + '-'.repeat(92));
    for (const m of plan.moves) {
      const label = r => `${(r.job_label || r.division || '?').slice(0, 16)} ${r.start_time}-${r.end_time}`;
      console.log('  ' + pad(m.rows[0].work_date instanceof Date
                    ? m.rows[0].work_date.toISOString().slice(0, 10)
                    : String(m.rows[0].work_date).slice(0, 10), 12)
        + pad((m.rows[0].username || '').slice(0, 14), 16)
        + pad(label(m.from), 26) + pad(label(m.target), 26)
        + `${n2(m.dayHoursBefore)} → ${n2(m.dayHoursAfter)}`);
      for (const u of m.updates) {
        console.log('      #' + pad(u.id, 10)
          + `lunch ${u.from.lunch_break ? 'yes' : 'no '} → ${u.to.lunch_break ? 'yes' : 'no '}   `
          + `hours ${n2(u.from.computed_hours)} → ${n2(u.to.computed_hours)}`);
      }
    }
    console.log('');
  } else {
    console.log('Nothing to move.\n');
  }

  const report = (list, title, why) => {
    if (!list.length) return;
    console.log(`${list.length} day(s) ${title} — NOT rewritten. ${why}`);
    for (const p of list) {
      const r = p.rows[0];
      const d = r.work_date instanceof Date ? r.work_date.toISOString().slice(0, 10) : String(r.work_date).slice(0, 10);
      console.log(`  ${d}  ${r.username}  group ${r.split_group_id}  `
        + p.rows.map(x => `#${x.id} ${x.start_time}-${x.end_time} ${n2(x.computed_hours)}h`
            + `${x.lunch_break === true ? ' [lunch]' : ''}`).join('  '));
    }
    console.log('');
  };
  report(plan.twoBreaks, 'already deducted twice',
    'Putting these right hands hours back, which is a change to pay — decide each one.');
  report(plan.drift, 'whose stored hours do not match their punches',
    'Something outside this backfill wrote those figures; rewriting them would move the day total.');
  report(plan.unusable, 'with punches that do not compute',
    'No job can be chosen without a usable clock.');

  const sk = plan.skipped;
  console.log(`skipped: ${sk.alreadyRight} already correct · ${sk.noLunch} no lunch · `
    + `${sk.single} single-job · ${sk.status} out of status scope`);

  // Approved days, listed and never written. Planned separately so the numbers
  // above stay strictly the work this script will actually do.
  if (SHOW_APPROVED) {
    const appr = B.planBackfill(rows, { statuses: ['approved'] });
    if (appr.moves.length) {
      console.log(`\n${appr.moves.length} APPROVED day(s) also sit on the old rule. NOT rewritten:`);
      for (const m of appr.moves) {
        const r = m.rows[0];
        const d = r.work_date instanceof Date ? r.work_date.toISOString().slice(0, 10)
                                              : String(r.work_date).slice(0, 10);
        console.log(`  ${d}  ${r.username}  `
          + m.rows.map(x => `#${x.id} ${x.start_time}-${x.end_time} ${n2(x.computed_hours)}h`
              + `${x.lunch_break === true ? ' [lunch]' : ''}`).join('  '));
      }
      console.log('\n  These carry cost rows posted at approval that hold an absolute copy of');
      console.log('  these hours. Rewriting them would mis-cost both jobs and jam the split\'s');
      console.log('  balance check, so the API refuses the same edit with a 409. To move one:');
      console.log('  un-approve it, re-run this script, then re-approve with a fresh split.');
    } else {
      console.log('\nNo approved days are affected.');
    }
  }

  // Said on every run, applying or not: a pass that reports "nothing to move"
  // while approved days sit on the old rule has answered a narrower question
  // than the one the reader asked.
  if (!SHOW_APPROVED) {
    console.log('\nApproved days were not examined. Add --show-approved to list them '
      + '(they are never written).');
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write these changes.');
    return;
  }

  // ── Writing ─────────────────────────────────────────────────────────────
  let todo = plan.moves;
  if (LIMIT && todo.length > LIMIT) {
    console.log(`\nLimiting to the first ${LIMIT} of ${todo.length} days.`);
    todo = todo.slice(0, LIMIT);
  }

  let wrote = 0, days = 0;
  for (const m of todo) {
    // Belt to the brace: the planner already refuses a move that changes the
    // day's pay, and it is checked again here because this is the last moment
    // before the write.
    if (!m.totalPreserved) {
      console.error(`  ! skipping group ${m.rows[0].split_group_id} — day total would move`);
      continue;
    }
    for (const u of m.updates) {
      const before = m.rows.find(r => String(r.id) === String(u.id));
      const [saved] = await sql`
        UPDATE timesheet_entries
           SET lunch_break    = ${u.to.lunch_break},
               computed_hours = ${u.to.computed_hours},
               updated_at     = NOW()
         WHERE id = ${u.id}
        RETURNING *
      `;
      if (!saved) { console.error(`  ! row ${u.id} vanished`); continue; }
      await sql`
        INSERT INTO timesheet_audit_log
          (company_code, entry_id, action, user_id, username, changes, snapshot)
        VALUES
          (${before.company_code}, ${u.id}, 'ADMIN_EDIT', NULL, 'backfill-lunch-holder',
           ${JSON.stringify({
             reason: 'lunch break moved to the job it fell in (backfill)',
             lunch_break:    { from: u.from.lunch_break, to: u.to.lunch_break },
             computed_hours: { from: u.from.computed_hours, to: u.to.computed_hours },
             split_group_id: before.split_group_id,
             day_total_hours: { from: m.dayHoursBefore, to: m.dayHoursAfter },
           })}::jsonb,
           ${JSON.stringify(saved)}::jsonb)
      `;
      wrote++;
    }
    days++;
  }
  console.log(`\nRewrote ${wrote} row(s) across ${days} day(s).`);

  // ── Verify what landed ──────────────────────────────────────────────────
  const touched = todo.map(m => m.rows[0].split_group_id);
  if (!touched.length) return;
  const after = await sql`
    SELECT split_group_id, id, start_time, end_time, computed_hours, lunch_break
      FROM timesheet_entries
     WHERE entry_type = 'daily' AND split_group_id = ANY(${touched})
  `;
  const byGroup = new Map();
  for (const r of after) {
    if (!byGroup.has(r.split_group_id)) byGroup.set(r.split_group_id, []);
    byGroup.get(r.split_group_id).push(r);
  }
  let bad = 0;
  for (const m of todo) {
    const list = byGroup.get(m.rows[0].split_group_id) || [];
    const holders = list.filter(r => r.lunch_break === true).length;
    const total = list.reduce((s, r) => s + Number(r.computed_hours), 0);
    if (holders !== 1) { console.error(`  ! group ${m.rows[0].split_group_id} now has ${holders} breaks`); bad++; }
    if (Math.abs(total - m.dayHoursAfter) > 0.005) {
      console.error(`  ! group ${m.rows[0].split_group_id} totals ${n2(total)}, expected ${n2(m.dayHoursAfter)}`);
      bad++;
    }
  }
  console.log(bad ? `\n⚠ ${bad} problem(s) found after writing — see above.`
                  : '\nVerified: every day rewritten holds exactly one break and totals what was planned.');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
module.exports = { main, parseArgs };
