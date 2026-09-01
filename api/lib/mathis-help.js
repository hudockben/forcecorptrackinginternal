'use strict';
/**
 * What the job pages actually look like, written down.
 *
 * Mathis is a server endpoint. The browser sends a message, a division and a
 * thread id — no DOM, no screenshot, not a pixel — and the model has never
 * seen this codebase, which is private. So asked where a button is it had two
 * options: say it did not know, or invent a plausible menu path. It says it
 * does not know (rule 9), and that is correct but not useful.
 *
 * This is the third option: tell it. Every sentence below describes a control
 * that exists in tracker.html, paving.html and kiewit-pinetree.html, and every
 * `claims` entry is a literal string scripts/test-mathis.js greps for in all
 * three of those files. Rename "+ New PO" and the suite fails. That test is
 * the whole reason this file is safe to keep — help text that has quietly gone
 * stale is worse than no help text, because somebody follows it.
 *
 * Only the three job pages are written up. A division with nothing here is not
 * offered the tool at all, and the model falls back to saying it cannot walk
 * anyone through that screen — which stays true rather than becoming a guess.
 *
 * Served through a tool rather than the system prompt so it costs nothing on
 * the ordinary path: nobody asking about profit pays for a paragraph about
 * where the upload button is.
 */

// The pages every claim below is asserted against.
const JOB_PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];

// Divisions this file describes, and the page each one is. Anything else gets
// no help tool at all.
const PAGE_FOR = {
  turf:   'tracker.html',
  paving: 'paving.html',
  kiewit: 'kiewit-pinetree.html',
};
const HELP_DIVISIONS = Object.keys(PAGE_FOR);

const JOB_TOPICS = {
  purchase_orders: {
    summary: 'raising a purchase order and recording deliveries against it',
    claims: ['data-tab="po"', '+ New PO', '+ Add Delivery'],
    text:
      'Purchase orders live on the Purchase Orders tab in the top tab bar. ' +
      '"+ New PO" at the bottom of the list creates one; it takes a PO number, ' +
      'a title, a supplier, a job, and a cost code and sub-code. ' +
      'Deliveries are recorded against the PO itself rather than entered separately: ' +
      'open the PO and use "+ Add Delivery" to add a line with quantity, unit cost and tax. ' +
      'The PO\'s value is those lines added up. ' +
      'Creating a PO or adding a delivery needs level2 or above; level1 can see the tab but not change anything.',
  },

  documents: {
    summary: 'uploading, filing and deleting job paperwork',
    claims: ['data-tab="docs"', 'id="docs-proj"'],
    text:
      'Paperwork lives on the Documents tab. A "Job" picker at the top chooses which job you are filing under, ' +
      'and its first option is the division-level General / Non-Job area for anything that belongs to no job. ' +
      'Each job gets the same set of folders — Contract, Change Orders, Permits & Insurance, Submittals, Safety, ' +
      'Photos, Repairs, Closeout — created automatically, plus a Purchase Orders folder with one subfolder per PO. ' +
      'You can add your own folders alongside them. ' +
      'Uploading needs level2 or above. Deleting needs an administrator, and a deleted file sits in a 30-day ' +
      'trash window before it is really gone, so an accidental delete is recoverable within the month.',
  },

  daily_tracking: {
    summary: 'entering daily production, labor and equipment rows against a job',
    claims: ['Daily Tracking &#8594;', '+ Add Row', 'Bid Items &#8594;'],
    text:
      'Daily rows are entered per job, not from a top-level tab. Find the job on the Project Dashboard ' +
      'and use its "Daily Tracking →" button; "Bid Items →" beside it opens the same job\'s bid. ' +
      'Inside, "+ Add Row" adds one row, and the box next to it adds several at once. ' +
      'A row carries a date, a cost code and sub-code, an employee with their hours, a machine with its hours, ' +
      'and material — one row can carry both a person and a machine. ' +
      'These rows are what a job\'s actual cost is made of, which is why equipment and labor figures are a ' +
      'breakdown of that cost rather than something to add to it. ' +
      'Entering rows needs level2 or above; the Daily Tracking view itself needs level3.',
  },

  lists_and_rates: {
    summary: 'where employees, their pay rates, equipment and job classes are edited',
    claims: ['Manage Lists', 'id="items-employees"', 'data-key="employees"'],
    text:
      'Employees, equipment, job classes, field types and the other dropdown lists are all edited in one place: ' +
      'the Admin ▾ menu in the tab bar, then "Manage Lists". ' +
      'The Employees tab there is where a person\'s job class and their two pay rates live — ' +
      'Non-PW and PW — and which of the two applies is the job\'s prevailing-wage flag, not the person\'s. ' +
      'The Equipment tab holds each machine\'s hourly unit cost. ' +
      'Suppliers have their own entry in the same Admin menu. ' +
      'The Admin menu is hidden below level3, so a level1 or level2 user cannot reach this modal or see pay rates at all.',
  },

  access_levels: {
    summary: 'what each permission level can see and do on this page',
    claims: ['canDeleteProject', 'visibleTabs'],
    text:
      'Four levels, set per division. ' +
      'level1 sees the Project Dashboard, Purchase Orders, Trucking and Documents, and can change nothing. ' +
      'level2 adds the Schedule and can enter and edit rows, purchase orders and uploads. ' +
      'level3 sees every tab, including Daily Tracking, Cost Tracking, Analytics and the Admin menu — ' +
      'which is where pay rates are — and can delete a project. ' +
      'An administrator adds deleting and restoring documents. ' +
      'Mathis answers within whatever the asking person holds: the figures it will not show are the same ones ' +
      'their own screen will not show.',
  },

  // The one topic where the three pages genuinely differ. Written as a common
  // paragraph plus a per-page sentence rather than smoothed into something
  // true of none of them — the claims test caught exactly that, on its first
  // run, by finding no Schedules dropdown in paving.html.
  finding_things: {
    summary: 'the layout of the tab bar and what is behind each dropdown',
    claims: ['data-tab="home"', 'data-tab="cost"', 'data-tab="info"',
             'data-tab="trucking"', 'data-tab="inventory"',
             'analytics-item-labor', 'analytics-item-equip', 'admin-item-supplier'],
    text:
      'The tab bar runs across the top: Home, Cost Tracking, Project Dashboard, Purchase Orders, ' +
      'Documents, Trucking and Infill Inventory, plus two dropdowns. ' +
      'Analytics ▾ holds Equipment Utilization, Labor Analytics, Scale of Economy, Sub Code Performance, ' +
      'Financials and the calculators. ' +
      'Admin ▾ holds Suppliers and Manage Lists. ' +
      'A job\'s own views — Daily Tracking, Bid Items, Daily Production Rate — are reached from that job\'s card ' +
      'on the Project Dashboard rather than from the tab bar. ' +
      'Tabs a level cannot use are hidden rather than disabled, so a missing tab means missing permission, not a bug.',
    perDivision: {
      turf: {
        claims: ['schedules-item-schedule', 'schedules-item-construction', 'data-tab="crm"'],
        text: 'On this page the Schedule and the Construction Schedule sit behind a Schedules ▾ dropdown, and there is a CRM tab.',
      },
      paving: {
        claims: ['data-tab="schedule"', 'data-tab="crm"'],
        text: 'On this page the Schedule is its own tab in the bar rather than a dropdown, and there is a CRM tab.',
      },
      kiewit: {
        claims: ['schedules-item-schedule', 'schedules-item-construction'],
        text: 'On this page the Schedule and the Construction Schedule sit behind a Schedules ▾ dropdown. There is no CRM tab.',
      },
    },
  },
};

/** The topics this user's current division has anything written about. */
function topicsFor(division) {
  return HELP_DIVISIONS.includes(division) ? Object.keys(JOB_TOPICS) : [];
}

/**
 * One topic's help, or null.
 *
 * `limits` mirrors what a digest carries, and says the one thing that keeps
 * this honest in use: what is written here is all there is. The failure this
 * guards is the model reading three true sentences about the PO tab and
 * confidently extending them into a fourth.
 */
function helpFor(division, topic) {
  if (!HELP_DIVISIONS.includes(division)) return null;
  const t = JOB_TOPICS[topic];
  if (!t) return null;
  const variant = t.perDivision && t.perDivision[division];
  return {
    topic,
    about: t.summary,
    text: variant ? `${t.text} ${variant.text}` : t.text,
    limits: [
      'This is everything written down about this screen. It is not a view of the page — you cannot see it. If the question needs a detail that is not in the text above, say that much is not written down rather than filling it in.',
      'It describes the three job pages, which are laid out the same. Do not describe any other division\'s screen from it.',
    ],
  };
}

module.exports = { JOB_PAGES, PAGE_FOR, HELP_DIVISIONS, JOB_TOPICS, topicsFor, helpFor };
