#!/usr/bin/env node
'use strict';
/**
 * When does a scheduled report go next, and what dates does it cover?
 *
 * Run: node scripts/test-report-schedule-time.js
 *
 * api/lib/report-schedule-time.js turns "weekdays at 6:30" into the UTC
 * instant of the next send, on the office clock — so the moments worth
 * pinning are the ones where the office clock and UTC disagree: the two DST
 * changes, the evening hours that are already tomorrow in UTC, a "31st" in a
 * short month, and a leap day. And the periods a report covers ("previous
 * workday" on a Monday is Friday) are worked out at send time from the same
 * clock.
 */

const path = require('path');
const T = require(path.join(__dirname, '..', 'api', 'lib', 'report-schedule-time.js'));

let passed = 0, failed = 0;
function eq(label, got, want) {
  const g = got instanceof Date ? got.toISOString() : JSON.stringify(got);
  const w = want instanceof Date ? want.toISOString() : JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ✓ ${label}`); }
  else         { failed++; console.error(`  ✗ ${label}\n      got  ${g}\n      want ${w}`); }
}
const at = s => new Date(s);
const NY = 'America/New_York';
const occ = (frequency, send_time, extra = {}) => ({ frequency, send_time, timezone: NY, ...extra });
const walk = (o, from, n) => { const out = []; let t = at(from); for (let i = 0; i < n; i++) { t = T.nextRunAt(o, t); out.push(t.toISOString()); } return out; };

console.log('Next send');
eq('weekdays from Thursday afternoon: Friday, then Monday',
  walk(occ('weekdays', '06:30'), '2026-10-01T18:00:00Z', 2), ['2026-10-02T10:30:00.000Z', '2026-10-05T10:30:00.000Z']);
eq('a time not yet reached today is today',
  T.nextRunAt(occ('daily', '06:30'), at('2026-10-01T10:00:00Z')), at('2026-10-01T10:30:00Z'));
eq('exactly at the time is the next one, not this one',
  T.nextRunAt(occ('daily', '06:30'), at('2026-10-01T10:30:00Z')), at('2026-10-02T10:30:00Z'));
eq('6:30 stays 6:30 on the office clock across the fall change (EDT → EST)',
  walk(occ('daily', '06:30'), '2026-10-31T00:00:00Z', 3),
  ['2026-10-31T10:30:00.000Z', '2026-11-01T11:30:00.000Z', '2026-11-02T11:30:00.000Z']);
eq('…and across the spring change (EST → EDT)',
  walk(occ('daily', '06:30'), '2027-03-13T00:00:00Z', 2), ['2027-03-13T11:30:00.000Z', '2027-03-14T10:30:00.000Z']);
eq('2:30 AM on the Sunday the clocks skip it goes at 3:30',
  T.nextRunAt(occ('daily', '02:30'), at('2027-03-14T05:00:00Z')), at('2027-03-14T07:30:00Z'));
eq('1:30 AM on the Sunday the clocks repeat it goes at the first 1:30',
  T.nextRunAt(occ('daily', '01:30'), at('2026-11-01T03:00:00Z')), at('2026-11-01T05:30:00Z'));
eq('9 PM Eastern is the same office day even though UTC has moved on',
  T.nextRunAt(occ('weekdays', '21:00'), at('2026-10-02T20:00:00Z')), at('2026-10-03T01:00:00Z'));
eq('…and a Friday 9 PM send does not slide to Saturday',
  new Date(T.nextRunAt(occ('weekdays', '21:00'), at('2026-10-02T20:00:00Z')).getTime() - 4 * 3600e3).getUTCDay(), 5);
eq('weekly Mon/Wed/Fri walks Mon, Wed, Fri, Mon',
  walk(occ('weekly', '07:15', { days_of_week: [5, 1, 3] }), '2026-10-04T12:00:00Z', 4),
  ['2026-10-05T11:15:00.000Z', '2026-10-07T11:15:00.000Z', '2026-10-09T11:15:00.000Z', '2026-10-12T11:15:00.000Z']);
eq('monthly on the 31st sends on the last day of a short month',
  walk(occ('monthly', '07:00', { day_of_month: 31 }), '2027-01-31T13:00:00Z', 3),
  ['2027-02-28T12:00:00.000Z', '2027-03-31T11:00:00.000Z', '2027-04-30T11:00:00.000Z']);
eq('monthly on the last day finds a leap day',
  T.nextRunAt(occ('monthly', '07:00', { day_of_month: -1 }), at('2028-02-01T00:00:00Z')), at('2028-02-29T12:00:00Z'));
eq('another zone is that zone\'s clock',
  T.nextRunAt({ frequency: 'daily', send_time: '06:30', timezone: 'America/Chicago' }, at('2026-10-01T10:00:00Z')), at('2026-10-01T11:30:00Z'));
eq('an occurrence that can never fire has no next send', T.nextRunAt(occ('weekly', '07:00', { days_of_week: [] }), at('2026-10-01T00:00:00Z')), null);

console.log('\nWhat the editor may save');
eq('weekly days are cleaned, sorted and de-duplicated',
  T.normalizeOccurrence({ frequency: 'weekly', send_time: '07:15', days_of_week: ['5', 1, 1, 9, 3] }).value.days_of_week, [1, 3, 5]);
eq('fields a frequency does not use are dropped',
  T.normalizeOccurrence({ frequency: 'daily', send_time: '07:15', days_of_week: [1], day_of_month: 4 }).value,
  { frequency: 'daily', send_time: '07:15', timezone: NY, days_of_week: null, day_of_month: null });
eq('no time is refused', T.normalizeOccurrence({ frequency: 'daily' }).ok, false);
eq('24:00 is refused', T.normalizeOccurrence({ frequency: 'daily', send_time: '24:00' }).ok, false);
eq('weekly with no day is refused, in words', T.normalizeOccurrence({ frequency: 'weekly', send_time: '07:00' }).error, 'Pick at least one day of the week.');
eq('monthly on the 32nd is refused', T.normalizeOccurrence({ frequency: 'monthly', send_time: '07:00', day_of_month: 32 }).ok, false);
eq('an unknown zone is refused', T.normalizeOccurrence({ frequency: 'daily', send_time: '07:00', timezone: 'Mars/Olympus' }).ok, false);

console.log('\nWhat a report covers, on Monday Oct 5 2026 at 7 AM Eastern');
const MON = at('2026-10-05T11:00:00Z');
eq('previous day is Sunday', T.periodRange('prev_day', MON, NY), { start: '2026-10-04', end: '2026-10-04' });
eq('previous workday is Friday', T.periodRange('prev_workday', MON, NY), { start: '2026-10-02', end: '2026-10-02' });
eq('…on a Tuesday it is Monday', T.periodRange('prev_workday', at('2026-10-06T11:00:00Z'), NY), { start: '2026-10-05', end: '2026-10-05' });
eq('…on a Sunday it is Friday', T.periodRange('prev_workday', at('2026-10-04T11:00:00Z'), NY), { start: '2026-10-02', end: '2026-10-02' });
eq('last 7 days ends yesterday', T.periodRange('last_7', MON, NY), { start: '2026-09-28', end: '2026-10-04' });
eq('last week is Monday to Sunday', T.periodRange('prev_week', MON, NY), { start: '2026-09-28', end: '2026-10-04' });
eq('…and on a Sunday it is the week before, not the one ending today',
  T.periodRange('prev_week', at('2026-10-04T15:00:00Z'), NY), { start: '2026-09-21', end: '2026-09-27' });
eq('week to date on a Monday is just Monday', T.periodRange('week_to_date', MON, NY), { start: '2026-10-05', end: '2026-10-05' });
eq('month to date', T.periodRange('month_to_date', MON, NY), { start: '2026-10-01', end: '2026-10-05' });
eq('last month', T.periodRange('prev_month', MON, NY), { start: '2026-09-01', end: '2026-09-30' });
eq('last month in January is December of last year', T.periodRange('prev_month', at('2027-01-04T12:00:00Z'), NY), { start: '2026-12-01', end: '2026-12-31' });
eq('a 9 PM Eastern send on the 5th still means the 5th, though UTC says the 6th',
  T.periodRange('today', at('2026-10-06T01:00:00Z'), NY), { start: '2026-10-05', end: '2026-10-05' });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
