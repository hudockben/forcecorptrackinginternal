'use strict';
/* Mathis — the tools the model may call, and what happens when it calls them.
 *
 * Phase 1 and 2 prefetched exactly one division's digest and handed it over. A
 * tool loop replaces that: the model asks for what it needs, which is what lets
 * it drill down, and lets somebody who holds two divisions get an answer that
 * covers both. Widening what the model can reach is the whole point, so the
 * narrowing has to move somewhere it cannot be talked out of.
 *
 * It moves here, and it is two rules.
 *
 *   THE ENUM IS BUILT PER REQUEST, FROM THIS CALLER'S SCOPE. A static list of
 *   every division would tell a paving foreman that a quarry and an
 *   intercompany division exist — the tool schema is prompt text the model can
 *   quote. What a user cannot reach, they should not be able to read the name
 *   of. So the enum is the intersection of their live scope with the divisions
 *   that have a digest, and for someone holding one division it has one entry.
 *
 *   THE ENUM IS NOT THE CHECK. A schema is a hint to the model, not a
 *   constraint on the bytes that come back: a model can emit any string, and a
 *   `strict` flag is a promise from the API rather than a guarantee from this
 *   process. So every handler re-resolves the division it was handed through
 *   the same resolveDivision the endpoint uses, against roles re-read from the
 *   database on this turn. If the two ever disagree, the check wins.
 *
 * Tool results are digests — the same objects Phase 2 built, unchanged — so a
 * figure the model sees is a figure this server fetched and authorised, and the
 * widget renders it from the digest rather than out of the reply.
 */

const ctx     = require('./mathis-context');
const digests = require('./mathis-digests');

// Divisions with a digest behind them. Anything else is answered by saying
// what is missing, not by a tool that returns an apology as if it were data.
const SUPPORTED = ['turf', 'paving', 'kiewit', 'quarry', 'dust', 'trucking',
                   'intercompany', 'payroll', 'scheduler', 'executive', 'fuel_admin'];

// The field-side keys. These are not divisions you get FIGURES for — they are
// queues you have your OWN rows in, so they belong to a different tool with a
// different promise: nobody else's records, ever.
const PERSONAL_AREAS = ['timesheet', 'fuel', 'driver', 'quarry_sales'];

const HUMAN = {
  turf: 'Turf Management', paving: 'Paving', kiewit: 'Kiewit Pinetree',
  quarry: 'Quarry', dust: 'Dust Control', trucking: 'Trucking',
  intercompany: 'Intercompany', payroll: 'Payroll', scheduler: 'Scheduler',
  executive: 'Executive', fuel_admin: 'Fuel Administration',
};

const MAX_LIMIT = digests.MAX_JOB_ROWS;

/** The divisions this caller may actually be given figures for. */
function reachableDivisions(scope) {
  return SUPPORTED.filter(d => scope.includes(d));
}

/**
 * The personal queues this caller can be shown their own rows in.
 *
 * 'timesheet' is always offered. Every one of these reads only rows keyed to
 * this user, and refusing somebody their own hours because an administrator
 * never ticked a box would be a strange kind of security.
 */
function personalAreas(scope) {
  const areas = PERSONAL_AREAS.filter(a => a === 'timesheet' || scope.includes(a));
  return areas.length ? areas : ['timesheet'];
}

const AREA_LABEL = {
  timesheet:    'timesheet entries — hours logged, what is still in draft',
  fuel:         'fuel fill-ups they submitted',
  driver:       'hauls the dispatcher has assigned to them',
  quarry_sales: 'scale-house loads they recorded',
};

/**
 * The tool definitions for one request. `scope` must be the freshly computed
 * division scope, not anything the client sent.
 *
 * Returns [] when there is nothing to offer beyond the caller's own timesheet —
 * which is itself a tool, because a field employee asking about their hours is
 * the most common question this thing will ever get.
 */
function toolsFor(scope) {
  const reachable = reachableDivisions(scope);
  const tools = [];

  if (reachable.length) {
    tools.push({
      name: 'get_division_figures',
      description:
        'Fetch the current figures for one division the user has access to. Returns a digest: the figures themselves plus a "limits" list describing what this division\'s data cannot answer. Call it once per division you need. Available: '
        + reachable.map(d => `${d} (${HUMAN[d]})`).join(', ')
        // Naming turf, paving and kiewit here to explain `limit` would tell a
        // quarry foreman those divisions exist. The sentence is division-free
        // for the same reason the enum is scoped.
        + '. A division that runs jobs returns per-job financials, its purchase orders, its cost-code catalogue, its equipment roster and hours, and a count of the paperwork on file — file names only, never contents. `limit` sets how many of the most recent jobs to read.',
      input_schema: {
        type: 'object',
        properties: {
          division: {
            type: 'string',
            enum: reachable,
            description: 'Which division to read. Only the values listed are available to this user.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LIMIT,
            // Naming the job divisions here would tell a quarry foreman they
            // exist, for the sake of a hint the digest itself already gives.
            description: `How many of the most recent jobs to read. Ignored by a division that does not run jobs. Defaults to ${digests.DEFAULT_JOB_ROWS}, capped at ${MAX_LIMIT}.`,
          },
        },
        required: ['division'],
      },
    });
  }

  const areas = personalAreas(scope);
  tools.push({
    name: 'get_my_records',
    description:
      "Fetch the asking user's OWN records from one of their queues. Nobody else's are available through this or any other tool, in aggregate or otherwise. Available: "
      + areas.map(a => `${a} (${AREA_LABEL[a]})`).join('; ')
      + '. Timesheet data carries no pay rate, so it cannot answer anything about money.',
    input_schema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          enum: areas,
          description: 'Which of the user\'s own queues to read. Only the values listed are available.',
        },
      },
      required: ['area'],
    },
  });

  return tools;
}

/** A short line for the user, so a slow answer shows what it is doing. */
const AREA_STEP = {
  timesheet: 'Reading your timesheet', fuel: 'Reading your fill-ups',
  driver: 'Reading your hauls', quarry_sales: 'Reading your loads',
};
function stepLabel(name, input) {
  if (name === 'get_my_records') return AREA_STEP[input && input.area] || 'Reading your records';
  const d = input && input.division;
  return d && HUMAN[d] ? `Reading ${HUMAN[d]} figures` : 'Reading figures';
}

/**
 * Run one tool call.
 *
 * Returns { digest } on success or { error } with a sentence addressed to the
 * model. An error is a normal outcome — the model asked for something it may
 * not have, and being told so is how it learns to say that to the user instead
 * of guessing. It is never a thrown exception, because a throw would lose the
 * turn and the question with it.
 */
async function runTool(c, name, input) {
  if (name === 'get_my_records') {
    const area = String((input && input.area) || 'timesheet');
    if (!PERSONAL_AREAS.includes(area)) {
      return { error: `There is no records area called ${area.slice(0, 40)}.` };
    }
    // Every one of these reads by user_id, so the area does not need a
    // division check — but a queue the user has no part in is still not
    // theirs to browse, so anything beyond timesheet needs the grant.
    if (area !== 'timesheet' && !ctx.resolveDivision(area, c.authz)) {
      return { error: 'That queue is not available to this user.' };
    }
    return { digest: await digests.buildDigest(c, area, {}) };
  }

  if (name === 'get_division_figures') {
    // Not `input.division` straight into a read. resolveDivision normalises the
    // string and checks it against roles re-read this turn, so a division the
    // model invented, or one it saw in an earlier turn of a conversation whose
    // access has since been revoked, is refused here regardless of the enum.
    const division = ctx.resolveDivision(input && input.division, c.authz);
    if (!division) {
      return { error: 'That division is not available to this user. Tell them you cannot see it — do not name other divisions.' };
    }
    if (!SUPPORTED.includes(division)) {
      return { error: ctx.NOT_YET[division] || 'That division is not wired into Mathis yet.' };
    }

    const raw = input && input.limit;
    const limit = Number.isFinite(Number(raw)) ? Math.min(Math.max(1, Math.floor(Number(raw))), MAX_LIMIT) : undefined;

    const digest = await digests.buildDigest(c, division, { limit });
    return { digest };
  }

  return { error: `There is no tool called ${String(name).slice(0, 40)}.` };
}

module.exports = {
  SUPPORTED,
  PERSONAL_AREAS,
  personalAreas,
  HUMAN,
  MAX_LIMIT,
  reachableDivisions,
  toolsFor,
  stepLabel,
  runTool,
};
