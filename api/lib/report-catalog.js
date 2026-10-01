'use strict';

// Every report that can be emailed, and what it takes to send one.
//
// REPORT_TYPES is the Email Report button's list: which division a sender
// needs access to, and the report's name. api/email/send-report.js refuses
// anything not in it.
//
// SCHEDULABLE is the subset Manage Users → Auto Reports can send on its own,
// with what the runner needs to build one without anybody at the keyboard:
// which page builds it, whether it is one job's report (and so one email per
// job) or the division's, and which settings the editor offers. Each entry's
// type is registered by its page in window.dwAutoReport (auto-report.js) —
// the page builds the report with the same function the button calls, which
// is the whole point: the 6:30 email is the report somebody would have sent.

const REPORT_TYPES = {
  executive:            { division: 'executive', label: 'Executive Report'                 },
  turf_daily_pm:        { division: 'turf',      label: 'Daily PM Report'                  },
  turf_daily_summary:   { division: 'turf',      label: 'Daily Summary Report'             },
  turf_bid_items:       { division: 'turf',      label: 'Bid Line Items vs Actuals — Turf' },
  turf_job_summary:     { division: 'turf',      label: 'Job Summary — Turf'               },
  turf_construction_schedule: { division: 'turf', label: 'Construction Schedule'           },
  paving_daily_pm:      { division: 'paving',    label: 'Daily PM Report'                    },
  paving_daily_summary: { division: 'paving',    label: 'Daily Summary Report'               },
  paving_bid_items:     { division: 'paving',    label: 'Bid Line Items vs Actuals — Paving' },
  paving_job_summary:   { division: 'paving',    label: 'Job Summary — Paving'                },
  kiewit_daily_pm:      { division: 'kiewit',    label: 'Daily PM Report'                            },
  kiewit_daily_summary: { division: 'kiewit',    label: 'Daily Summary Report'                       },
  kiewit_bid_items:     { division: 'kiewit',    label: 'Bid Line Items vs Actuals — Kiewit Pinetree' },
  kiewit_job_summary:   { division: 'kiewit',    label: 'Job Summary — Kiewit Pinetree'               },
  kiewit_construction_schedule: { division: 'kiewit', label: 'Construction Schedule'                  },
  quarry_breakeven:     { division: 'quarry',    label: 'Quarry Break-Even Analysis'          },
  dust_tracking_summary:{ division: 'dust',      label: 'Dust Control Tracking Report'        },
  scheduler_dispatch:   { division: 'scheduler', label: 'Crew Dispatch Schedule'              },
  trucking_dispatch:    { division: 'trucking',  label: 'Trucking Dispatch Schedule'          },
  // The Scheduler tab's second board. Same division — it is the trucking
  // office's own labor board — so the same access check applies.
  trucking_labor_dispatch: { division: 'trucking', label: 'Labor Dispatch Schedule'           },
  // The CRM lives in the Turf tab, so Turf access is what gates its reports.
  // The scheduled copy goes out from api/cron/crm-next-steps-email.js.
  crm_next_steps:       { division: 'turf',      label: 'Next Steps Due — CRM'                },
};

// The divisions Auto Reports groups its schedules under, in the order the
// tab lists them, and the page that builds each one's reports.
const DIVISIONS = [
  { key: 'turf',      name: 'Turf Management', page: 'tracker.html'         },
  { key: 'paving',    name: 'Paving',          page: 'paving.html'          },
  { key: 'kiewit',    name: 'Kiewit Pinetree', page: 'kiewit-pinetree.html' },
  { key: 'dust',      name: 'Dust Control',    page: 'dust.html'            },
  { key: 'quarry',    name: 'Quarry',          page: 'quarry.html'          },
  { key: 'trucking',  name: 'Trucking',        page: 'trucking.html'        },
  { key: 'scheduler', name: 'Scheduler',       page: 'scheduler.html'       },
  { key: 'executive', name: 'Executive',       page: 'executive.html'       },
];

// scope:
//   'job'        — one job's report. The schedule names a job, or '*' for
//                  every job marked In Progress, one email each.
//   'job_or_all' — a job, or (no job) every job's activity in one report.
//   'division'   — the division's report; nothing to pick.
// period: the default stretch of days the report covers (see PERIODS in
//         report-schedule-time.js); the editor offers the rest.
// day:    the default day a dispatch sheet is for — today, tomorrow or the
//         next workday.
// year:   offers "this year" or "all years".
const JOB_REPORTS = (div, label) => ({
  [`${div}_daily_pm`]:      { name: 'Daily PM Report', scope: 'job',
    blurb: 'The day\'s field plan for a job: pace, required pace and status on every bid item.' },
  [`${div}_daily_summary`]: { name: 'Daily Summary', scope: 'job_or_all', period: 'prev_workday',
    blurb: 'Production, hours and cost booked over the period, job by job.' },
  [`${div}_bid_items`]:     { name: 'Bid Line Items vs Actuals', scope: 'job',
    blurb: `Every bid line against what has been booked to it — ${label}.` },
  [`${div}_job_summary`]:   { name: 'Job Summary', scope: 'job',
    blurb: 'Contract, budget, cost and schedule for a job on one page.' },
});

const SCHEDULE_DEFS = {
  ...JOB_REPORTS('turf', 'Turf'),
  turf_construction_schedule:   { name: 'Construction Schedule', scope: 'job',
    blurb: 'The job\'s construction schedule and Gantt chart, as built in its tab.' },
  ...JOB_REPORTS('paving', 'Paving'),
  ...JOB_REPORTS('kiewit', 'Kiewit Pinetree'),
  kiewit_construction_schedule: { name: 'Construction Schedule', scope: 'job',
    blurb: 'The job\'s construction schedule and Gantt chart, as built in its tab.' },
  dust_tracking_summary:  { name: 'Dust Control Tracking Report', scope: 'division', period: 'prev_week',
    blurb: 'Every dust entry over the period, all customers, with hours, gallons and totals.' },
  quarry_breakeven:       { name: 'Quarry Break-Even Analysis', scope: 'division', year: true,
    blurb: 'Break-even by month and pit, from sales, crushing, fixed costs and royalty.' },
  trucking_dispatch:      { name: 'Trucking Dispatch', scope: 'division', day: 'next_workday',
    blurb: 'The Trucking board for one day — who is hauling what, where.' },
  trucking_labor_dispatch:{ name: 'Labor Dispatch', scope: 'division', day: 'next_workday',
    blurb: 'The Labor board for one day.' },
  scheduler_dispatch:     { name: 'Crew Dispatch', scope: 'division', day: 'next_workday',
    blurb: 'The Scheduler board for one day, by job.' },
  executive:              { name: 'Executive Report', scope: 'division',
    blurb: 'The cross-division roll-up, every section.' },
};

// Each schedulable report with its division, label and page filled in from
// the two lists above, so a report can only be scheduled under the division
// its Email button checks.
const SCHEDULABLE = {};
for (const [type, def] of Object.entries(SCHEDULE_DEFS)) {
  const rt  = REPORT_TYPES[type];
  const div = rt && DIVISIONS.find(d => d.key === rt.division);
  if (!rt || !div) throw new Error(`report-catalog: ${type} has no division page`);
  SCHEDULABLE[type] = { ...def, type, division: rt.division, label: rt.label, page: div.page };
}

module.exports = { REPORT_TYPES, DIVISIONS, SCHEDULABLE };
