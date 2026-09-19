'use strict';
/**
 * Planning a lunch-break backfill.
 *
 * The day's one unpaid break used to be deducted from whichever job of a split
 * day was entered first; it now goes to the job the break fell in — the block
 * overlapping the middle of the day the most, or the longest block when nothing
 * is near midday. Entries written before that change still carry the old
 * allocation. This works out, for a given set of entries, exactly which rows
 * would move and to what.
 *
 * Kept apart from the script that runs it so the decisions can be tested
 * without a database, which is the only way to be sure before pointing it at
 * live payroll. The rule itself is asserted against timesheet.html's own copy
 * in scripts/test-lunch-backfill.js — two implementations of "which job" is two
 * places for a man's hours to disagree.
 *
 * Nothing here writes. planBackfill() returns a description of the work.
 */

const LUNCH_WINDOW_MIN = [11 * 60, 14 * 60];   // 11:00–14:00
const LUNCH_HOURS      = 0.5;
const LUNCH_MINUTES    = 30;
const CENT             = n => Math.round(n * 100) / 100;

function spanMinutes(start, end) {
  if (!start || !end) return null;
  const a = /^(\d{1,2}):(\d{2})/.exec(String(start));
  const b = /^(\d{1,2}):(\d{2})/.exec(String(end));
  if (!a || !b) return null;
  let mins = (Number(b[1]) * 60 + Number(b[2])) - (Number(a[1]) * 60 + Number(a[2]));
  if (mins < 0) mins += 24 * 60;             // overnight shift
  if (mins > 24 * 60) mins = 24 * 60;
  return mins;
}

function startMinutes(start) {
  const a = /^(\d{1,2}):(\d{2})/.exec(String(start || ''));
  return a ? Number(a[1]) * 60 + Number(a[2]) : null;
}

function middayOverlap(startMin, spanMin) {
  let best = 0;
  for (const off of [0, 24 * 60]) {
    const lo = LUNCH_WINDOW_MIN[0] + off, hi = LUNCH_WINDOW_MIN[1] + off;
    const overlap = Math.min(startMin + spanMin, hi) - Math.max(startMin, lo);
    if (overlap > best) best = overlap;
  }
  return best;
}

/** Which of the day's blocks carries the break. Mirrors timesheet.html. */
function lunchHolderPos(windows) {
  let pos = -1, bestOverlap = -1, bestSpan = -1;
  let longest = -1, longestSpan = -1;
  windows.forEach((w, at) => {
    const span = spanMinutes(w.start, w.end);
    const from = startMinutes(w.start);
    if (span == null || span <= 0 || from == null) return;
    if (span > longestSpan) { longest = at; longestSpan = span; }
    // A block shorter than the break cannot carry it. The deduction clamps at
    // zero, so a 20-minute block straddling noon would absorb 20 minutes of a
    // 30-minute break and the DAY would quietly come out ten minutes long.
    // Under the old first-job rule this was nearly unreachable — a first block
    // is seldom that short — but a block that straddles midday often is, so the
    // rule has to refuse one it cannot fit.
    if (span < LUNCH_MINUTES) return;
    const overlap = middayOverlap(from, span);
    if (overlap > bestOverlap || (overlap === bestOverlap && span > bestSpan)) {
      pos = at; bestOverlap = overlap; bestSpan = span;
    }
  });
  // Nothing long enough anywhere: the whole day is shorter than the break. The
  // longest block takes it and the clamp does what it can — there is no
  // allocation that both pays the break and keeps the day whole.
  return pos >= 0 ? pos : longest;
}

/** The gross clock span in decimal hours, or null when the punches are unusable. */
function grossHours(row) {
  const mins = spanMinutes(row.start_time, row.end_time);
  return mins == null ? null : CENT(mins / 60);
}

/**
 * Group daily rows by split_group_id, in split_index order. Rows without a
 * group are their own day of one, which is never a move — one block has
 * nowhere else to put the break.
 */
function groupEntries(rows) {
  const byGroup = new Map();
  for (const r of rows) {
    if (r.entry_type !== 'daily') continue;
    const key = r.split_group_id || `solo:${r.id}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(r);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => (Number(a.split_index) || 0) - (Number(b.split_index) || 0)
                     || String(a.id).localeCompare(String(b.id)));
  }
  return byGroup;
}

/**
 * What to do with one split day.
 *
 * Verdicts:
 *   single        — one job; the break has nowhere else to go.
 *   no-lunch      — nobody claimed a break, so there is nothing to move.
 *   already-right — the rule already agrees with where it sits.
 *   move          — a clean reallocation. The day's total is IDENTICAL after.
 *   two-breaks    — more than one row claims the break, so the day is
 *                   over-deducted. Fixing it GIVES HOURS BACK, which is a
 *                   change to what the man is paid, not a reallocation.
 *   drift         — a row's stored hours do not match what its punches and its
 *                   own lunch flag imply. Rewriting it would move the day's
 *                   total by whatever that difference is, for a reason this
 *                   backfill did not establish and cannot explain.
 *   unusable      — the punches do not compute, so no target can be chosen.
 *
 * Only `move` is safe to apply blind. The other two that carry work —
 * two-breaks and drift — change what a day pays and are reported, never
 * applied, unless the caller asks for them by name.
 */
function planGroup(rows) {
  const holders = rows.filter(r => r.lunch_break === true);
  if (rows.length < 2) return { verdict: 'single', rows };
  if (!holders.length)  return { verdict: 'no-lunch', rows };

  const gross = rows.map(grossHours);
  if (gross.some(g => g == null)) return { verdict: 'unusable', rows };

  // A holder's hours, clamped at zero exactly as the server clamps them. Used
  // for both the expectation below and the writes further down, so a block too
  // short to absorb the whole break is read the same way it was written —
  // without this, a legitimately clamped row looks like corruption.
  const held = i => Math.max(0, CENT(gross[i] - LUNCH_HOURS));

  // What each row's hours OUGHT to be under the allocation it is stored with.
  // A row that does not match was changed by something this backfill knows
  // nothing about, and recomputing it would move the day's pay silently.
  const drifted = rows.filter((r, i) => {
    const want = r.lunch_break === true ? held(i) : gross[i];
    return Math.abs(Number(r.computed_hours) - want) > 0.005;
  });
  if (drifted.length) {
    return { verdict: 'drift', rows, drifted, gross };
  }

  if (holders.length > 1) return { verdict: 'two-breaks', rows, holders, gross };

  const targetPos = lunchHolderPos(rows.map(r => ({ start: r.start_time, end: r.end_time })));
  if (targetPos < 0) return { verdict: 'unusable', rows };

  const target = rows[targetPos];
  if (String(target.id) === String(holders[0].id)) return { verdict: 'already-right', rows, target };

  // The writes: the new holder goes short, everyone else is made whole. Every
  // figure comes from the punches, never from adding 0.5 to what is stored.
  //
  // held() clamps as the server does, so a block too short to take the whole
  // break is never written negative; such a day then fails totalPreserved below
  // and is reported as drift rather than rewritten, which is right — no
  // allocation both pays a 30-minute break and keeps a shorter day whole.
  const updates = rows.map((r, i) => {
    const holds = String(r.id) === String(target.id);
    const hours = holds ? held(i) : gross[i];
    return {
      id: r.id,
      from: { lunch_break: r.lunch_break === true, computed_hours: Number(r.computed_hours) },
      to:   { lunch_break: holds, computed_hours: hours },
    };
  }).filter(u => u.from.lunch_break !== u.to.lunch_break
              || Math.abs(u.from.computed_hours - u.to.computed_hours) > 0.005);

  const before = rows.reduce((s, r) => s + Number(r.computed_hours), 0);
  const after  = rows.reduce((s, r, i) =>
    s + (String(r.id) === String(target.id) ? held(i) : gross[i]), 0);

  return {
    verdict: 'move',
    rows,
    from: holders[0],
    target,
    updates,
    dayHoursBefore: CENT(before),
    dayHoursAfter:  CENT(after),
    // The invariant that makes this safe to apply without asking anyone: a
    // move reallocates, it does not pay more or less. A plan that breaks this
    // is a bug, and planBackfill refuses to carry it.
    totalPreserved: Math.abs(before - after) < 0.005,
  };
}

/**
 * Plan a backfill over a set of entries.
 *
 * `statuses` names which entry statuses may be rewritten. Approved entries have
 * already had cost rows injected from their hours, so they are not included
 * unless the caller says so explicitly.
 */
function planBackfill(rows, opts) {
  const statuses = new Set((opts && opts.statuses) || ['draft', 'submitted']);
  const groups = groupEntries(rows);
  const out = {
    moves: [], twoBreaks: [], drift: [], unusable: [],
    skipped: { single: 0, noLunch: 0, alreadyRight: 0, status: 0 },
    counts: { groups: groups.size, rowsExamined: 0 },
  };

  for (const list of groups.values()) {
    out.counts.rowsExamined += list.length;
    // A day is rewritten whole or not at all. One job of a split day moving
    // while its sibling is held back by a status filter is precisely how a day
    // ends up carrying two breaks or none.
    if (!list.every(r => statuses.has(r.status))) { out.skipped.status++; continue; }

    const plan = planGroup(list);
    switch (plan.verdict) {
      case 'single':        out.skipped.single++; break;
      case 'no-lunch':      out.skipped.noLunch++; break;
      case 'already-right': out.skipped.alreadyRight++; break;
      case 'two-breaks':    out.twoBreaks.push(plan); break;
      case 'drift':         out.drift.push(plan); break;
      case 'unusable':      out.unusable.push(plan); break;
      case 'move':
        if (!plan.totalPreserved) { out.drift.push(plan); break; }
        out.moves.push(plan);
        break;
    }
  }
  return out;
}

module.exports = {
  LUNCH_WINDOW_MIN, LUNCH_HOURS, LUNCH_MINUTES,
  spanMinutes, startMinutes, middayOverlap, lunchHolderPos,
  grossHours, groupEntries, planGroup, planBackfill,
};
