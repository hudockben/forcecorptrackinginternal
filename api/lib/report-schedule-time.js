'use strict';

// When does a scheduled report go out next — and what period does it cover?
//
// Pure functions, no database, no clock of their own: every one takes the
// moment it is asked about. That is what lets the suite walk a schedule across
// a DST change or a month end without waiting for one.
//
// Times are wall-clock times in the schedule's own time zone. "6:30 AM on
// weekdays" means 6:30 on the office clock in March and in November, not a
// fixed UTC instant that drifts an hour twice a year — so the conversion to
// UTC happens per occurrence, with that day's offset.

const DEFAULT_TZ = 'America/New_York';

const FREQUENCIES = ['daily', 'weekdays', 'weekly', 'monthly'];

// A day of the month past the end of a short month sends on its last day
// rather than skipping the month: "the 31st" in April is April 30th.
const LAST_DAY = -1;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

// One formatter per zone; Intl formatters are not cheap to build and the
// scheduler asks the same zone hundreds of times walking forward through days.
const fmtCache = new Map();
function fmtFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at instant `date`: { y, m (1-12), d, hh, mm, ss }. */
function wallClock(date, tz) {
  const parts = {};
  for (const p of fmtFor(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hh: Number(parts.hour), mm: Number(parts.minute), ss: Number(parts.second),
  };
}

/** Minutes `tz` is ahead of UTC at instant `date` (EDT → -240). */
function offsetMinutes(date, tz) {
  const w = wallClock(date, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/**
 * The UTC instant at which the clock in `tz` reads y-m-d hh:mm.
 *
 * Guess with the offset at the naive instant, then correct once with the
 * offset at the guess — which settles every case but the hour a spring-forward
 * skips. There the wall time does not exist, the two guesses straddle the
 * jump, and the later one is taken: a 2:30 AM report on that one Sunday goes
 * at 3:30, the way cron and every alarm clock handle it. In the hour a
 * fall-back repeats, the first 1:30 is the one.
 */
function zonedToUtc(y, m, d, hh, mm, tz) {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const t1 = naive - offsetMinutes(new Date(naive), tz) * 60000;
  const t2 = naive - offsetMinutes(new Date(t1), tz) * 60000;
  const w = wallClock(new Date(t2), tz);
  if (w.hh === hh && w.mm === mm) return new Date(t2);
  return new Date(Math.max(t1, t2));
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** 0 = Sunday … 6 = Saturday, for a civil date. */
function weekdayOf(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const pad2 = n => String(n).padStart(2, '0');
const ymd  = ({ y, m, d }) => `${y}-${pad2(m)}-${pad2(d)}`;

/**
 * Validate and tidy an occurrence as the editor sends it.
 *
 *   { frequency, days_of_week?, day_of_month?, send_time, timezone? }
 *
 * Returns { ok: true, value } with only the fields that frequency uses, or
 * { ok: false, error } in words an admin can act on.
 */
function normalizeOccurrence(input) {
  const src = input || {};
  const frequency = String(src.frequency || '').toLowerCase();
  if (!FREQUENCIES.includes(frequency)) return { ok: false, error: 'Pick how often it goes out.' };

  const send_time = String(src.send_time || '').trim();
  if (!TIME_RE.test(send_time)) return { ok: false, error: 'Pick a time of day.' };
  // The server checks every five minutes. 11:57 PM would never be reached
  // before midnight, and go out the next day as the next day's report.
  if (Number(send_time.slice(3)) % 5) {
    return { ok: false, error: 'Pick a time on a five-minute mark — the server checks every five minutes.' };
  }

  const timezone = src.timezone == null || src.timezone === '' ? DEFAULT_TZ : String(src.timezone);
  if (!isValidTimeZone(timezone)) return { ok: false, error: 'Unknown time zone.' };

  const value = { frequency, send_time, timezone, days_of_week: null, day_of_month: null };

  if (frequency === 'weekly') {
    const raw = Array.isArray(src.days_of_week) ? src.days_of_week : [];
    const days = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    if (!days.length) return { ok: false, error: 'Pick at least one day of the week.' };
    value.days_of_week = days;
  }

  if (frequency === 'monthly') {
    const n = Number(src.day_of_month);
    if (!(n === LAST_DAY || (Number.isInteger(n) && n >= 1 && n <= 31))) {
      return { ok: false, error: 'Pick a day of the month.' };
    }
    value.day_of_month = n;
  }

  return { ok: true, value };
}

/** Does the occurrence fire on civil date y-m-d? */
function firesOn(occ, y, m, d) {
  const wd = weekdayOf(y, m, d);
  switch (occ.frequency) {
    case 'daily':    return true;
    case 'weekdays': return wd >= 1 && wd <= 5;
    case 'weekly':   return Array.isArray(occ.days_of_week) && occ.days_of_week.includes(wd);
    case 'monthly': {
      const last = daysInMonth(y, m);
      const want = occ.day_of_month === LAST_DAY ? last : Math.min(Number(occ.day_of_month), last);
      return d === want;
    }
    default: return false;
  }
}

/**
 * The first moment strictly after `after` that the occurrence fires, as a
 * UTC Date — or null for an occurrence that can never fire.
 *
 * Walks forward a day at a time from the zone's own "today". Sixty-two days is
 * past the longest gap any occurrence can have (a monthly one on the 31st
 * still fires on the 30th or the 28th), so running out means the occurrence
 * itself is broken, not that the date is far off.
 */
function nextRunAt(occ, after) {
  if (!occ || !FREQUENCIES.includes(occ.frequency)) return null;
  const m = TIME_RE.exec(String(occ.send_time || ''));
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  const tz = isValidTimeZone(occ.timezone) ? occ.timezone : DEFAULT_TZ;
  const from = after instanceof Date ? after : new Date(after);

  // From the day before: where a spring-forward gap spans midnight (Nuuk's
  // does), the previous day's late occurrence lands on today, and starting
  // from today would step over it. Anything not after `after` is skipped below.
  const start = wallClock(from, tz);
  for (let i = -1; i <= 62; i++) {
    const c = addDays(start.y, start.m, start.d, i);
    if (!firesOn(occ, c.y, c.m, c.d)) continue;
    const at = zonedToUtc(c.y, c.m, c.d, hh, mm, tz);
    if (at.getTime() > from.getTime()) return at;
  }
  return null;
}

// ── Report periods ──────────────────────────────────────────────────────────
// A report that covers a stretch of days ("Daily Summary for yesterday") is
// told which stretch in words, and the dates are worked out at send time in
// the schedule's zone. Storing dates instead would freeze the first week's
// report into every week after it.

const PERIODS = {
  today:        'Same day',
  prev_day:     'Previous day',
  prev_workday: 'Previous workday',
  last_7:       'Last 7 days',
  prev_week:    'Last week (Mon–Sun)',
  week_to_date: 'Week to date',
  month_to_date:'Month to date',
  prev_month:   'Last month',
};

/**
 * The { start, end } (YYYY-MM-DD, inclusive) a period means at instant `at` in
 * zone `tz`. Unknown periods read as the previous day — the safe guess for a
 * report someone set to go out first thing in the morning.
 */
function periodRange(period, at, tz) {
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  const w = wallClock(at instanceof Date ? at : new Date(at), zone);
  const today = { y: w.y, m: w.m, d: w.d };
  const wd = weekdayOf(w.y, w.m, w.d);
  // Monday-based: Monday is 0 days into its week, Sunday 6.
  const intoWeek = (wd + 6) % 7;

  switch (period) {
    case 'today':
      return { start: ymd(today), end: ymd(today) };
    case 'prev_workday': {
      // Monday's previous workday is Friday; Sunday's and Saturday's too.
      const back = wd === 1 ? 3 : wd === 0 ? 2 : 1;
      const p = addDays(today.y, today.m, today.d, -back);
      return { start: ymd(p), end: ymd(p) };
    }
    case 'last_7': {
      const s = addDays(today.y, today.m, today.d, -7);
      const e = addDays(today.y, today.m, today.d, -1);
      return { start: ymd(s), end: ymd(e) };
    }
    case 'prev_week': {
      const s = addDays(today.y, today.m, today.d, -intoWeek - 7);
      const e = addDays(s.y, s.m, s.d, 6);
      return { start: ymd(s), end: ymd(e) };
    }
    case 'week_to_date': {
      const s = addDays(today.y, today.m, today.d, -intoWeek);
      return { start: ymd(s), end: ymd(today) };
    }
    case 'month_to_date':
      return { start: ymd({ y: w.y, m: w.m, d: 1 }), end: ymd(today) };
    case 'prev_month': {
      const pm = w.m === 1 ? 12 : w.m - 1;
      const py = w.m === 1 ? w.y - 1 : w.y;
      return { start: ymd({ y: py, m: pm, d: 1 }), end: ymd({ y: py, m: pm, d: daysInMonth(py, pm) }) };
    }
    case 'prev_day':
    default: {
      const p = addDays(today.y, today.m, today.d, -1);
      return { start: ymd(p), end: ymd(p) };
    }
  }
}

/** The civil date (YYYY-MM-DD) in `tz` at `at`, offset by `plusDays`. */
function localDate(at, tz, plusDays = 0) {
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  const w = wallClock(at instanceof Date ? at : new Date(at), zone);
  return ymd(addDays(w.y, w.m, w.d, plusDays));
}

module.exports = {
  DEFAULT_TZ,
  FREQUENCIES,
  LAST_DAY,
  PERIODS,
  isValidTimeZone,
  normalizeOccurrence,
  nextRunAt,
  periodRange,
  localDate,
  // exported for the suite
  zonedToUtc,
  wallClock,
  firesOn,
};
