'use strict';
/**
 * The company's people, as ONE definition.
 *
 * A name can live in four places, because each division brought its own roster
 * with it:
 *
 *   - `employees`                          canonical (turf / dust / trucking)
 *   - `<company>:fct_paving_lists`         paving's blob
 *   - `<company>:fct_kiewit_lists`         kiewit's blob
 *   - `quarry_employees`                   quarry's table
 *
 * The "Manage employees" list has always shown the union of all four. The
 * Scheduler used to read only the first and then fold in any name it found on
 * a project's daily rows, which meant the two lists disagreed in BOTH
 * directions: the Scheduler offered people nobody could find in Manage (a name
 * off an old daily row, someone since removed from the roster, a typo), and it
 * was missing anyone who only exists on the paving, kiewit or quarry list and
 * has not worked a job yet.
 *
 * So the union lives here and both callers read it. A name is a name once:
 * matching is case-insensitive, and the first source to claim it wins, which
 * keeps the canonical table's job class, role flags and contact card
 * ahead of a bare blob entry.
 *
 * Every non-canonical source is read inside its own try/catch: a division blob
 * that has never been written must not take the roster down with it.
 */

function blankRow(name, source, jobClass) {
  return {
    id:                  null,
    name,
    job_class:           jobClass || null,
    is_supervisor:       false,
    is_driver:           false,
    phone:               null,
    email:               null,
    supervisor_name:     null,
    source,
  };
}

// Blob rosters hold either bare strings or {name, job_class} objects.
function addBlobList(byName, list, source) {
  for (const e of list || []) {
    const raw = (typeof e === 'string' ? e : (e && e.name)) || '';
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (byName.has(key)) continue;
    byName.set(key, blankRow(name, source, typeof e === 'object' ? e.job_class : null));
  }
}

async function readBlobEmployees(sql, key) {
  const rows = await sql`SELECT value FROM app_data WHERE key = ${key}`;
  return (rows.length && rows[0].value && Array.isArray(rows[0].value.employees)) ? rows[0].value.employees : [];
}

/**
 * Every person on the company's books, deduplicated by name.
 *
 * No pay rates. GET /api/employees hands this to anyone signed in and the
 * Scheduler board to anyone on the Scheduler, and neither page reads a rate.
 * The employees table carries each turf rate as a backup of the list, which is
 * no reason to send it to them.
 */
async function readEmployeeRoster(sql, companyCode) {
  const byName = new Map(); // lowercased name → row

  const tableRows = await sql`
    SELECT id, name, job_class,
           is_supervisor,
           is_driver,
           phone,
           email,
           supervisor_name,
           sort_order
    FROM   employees
    WHERE  company_code = ${companyCode} AND active = TRUE
    ORDER  BY sort_order ASC, name ASC
  `;
  for (const r of tableRows) {
    const name = (r.name || '').trim();
    if (!name) continue;
    byName.set(name.toLowerCase(), {
      id:                  r.id,
      name,
      job_class:           r.job_class || null,
      is_supervisor:       r.is_supervisor === true,
      is_driver:           r.is_driver === true,
      phone:               r.phone || null,
      email:               r.email || null,
      supervisor_name:     r.supervisor_name || null,
      source:              'employees',
    });
  }

  try { addBlobList(byName, await readBlobEmployees(sql, companyCode + ':fct_paving_lists'), 'paving'); }
  catch (err) { console.error('[roster] paving blob read failed (non-fatal):', err.message); }

  try { addBlobList(byName, await readBlobEmployees(sql, companyCode + ':fct_kiewit_lists'), 'kiewit'); }
  catch (err) { console.error('[roster] kiewit blob read failed (non-fatal):', err.message); }

  try {
    const qRows = await sql`SELECT name FROM quarry_employees WHERE company_code = ${companyCode}`;
    for (const r of qRows) {
      const name = (r.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (byName.has(key)) continue;
      byName.set(key, blankRow(name, 'quarry'));
    }
  } catch (err) { console.error('[roster] quarry read failed (non-fatal):', err.message); }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Login rows ──────────────────────────────────────────────────────────────
// Manage Users → Roles lists LOGINS, by username, and its Supervisor and Driver
// toggles are stored on an employees row named after the username: Timesheet's
// supervisor dropdown, its "was this a haul?" question and Code Time's
// send-to list all find a login's role by that name. So flagging Aaron Todd's
// login writes a row called "toddaaron" beside the "Aaron Todd" the division
// lists already hold, and every list of people showed Aaron Todd twice — once
// as a person, once as a login — and counted the one person twice as crew.
// Nothing links a login to its person, so they are paired here by name.
//
// The row stays in the table; Timesheet and Payroll still need it. What
// changes is the list of PEOPLE: a login's row folds into the person it names,
// who takes on its Supervisor and Driver flags and any contact detail the
// person's own row lacks. A login that names nobody, or could name two people,
// stays in the list as it is and is marked as a login. Guessing wrong would
// hand one person another's role, and a name nobody can place is better shown
// than lost.

const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|v)$/;

// The ways a login is usually made from a person's name: last + first
// (toddaaron), first + last (aarontodd), the one-initial forms (atodd, todda,
// aaront), and a middle name kept whole (smithmaryann, maryannsmith). Letters
// only, so "McMillan" and "O'Brien" compare the way they are typed into a
// username.
function loginKeysFor(name) {
  const parts = String(name || '').toLowerCase().split(/\s+/)
    .map(p => p.replace(/[^a-z]/g, ''))
    .filter(p => p && !NAME_SUFFIX.test(p));
  if (parts.length < 2) return [];
  const first = parts[0], last = parts[parts.length - 1], given = parts.slice(0, -1).join('');
  return [...new Set([last + first, first + last, first[0] + last, last + first[0], first + last[0],
                      last + given, given + last])];
}

// A username as the same kind of string: letters only, so "aaron.todd" and
// "toddaaron2" find their person too.
function loginKey(username) { return String(username || '').toLowerCase().replace(/[^a-z]/g, ''); }

/**
 * The roster as PEOPLE: each login's row folded into the person it names.
 *
 * A row is a login's when its name is a username and has no space in it — a
 * username with a space in it is a person's full name, and is left alone.
 *
 * An admin's answer (see readLoginLinks) beats the name. { person } folds the
 * login into that person whatever its username says. { none } says it is
 * nobody on the crew: it stays in the list of people, flagged `offCrew`, so the
 * directory still has its number, and the crew list leaves it off. An answer
 * naming somebody no longer on the roster is no answer, and the name is used.
 *
 * @param  {object[]} roster     readEmployeeRoster's rows
 * @param  {string[]} usernames  the company's logins
 * @param  {object}   [links]    lowercased login → { person } or { none: true }
 * @return {{ people: object[], matched: object, unmatched: string[],
 *            manual: string[], offCrew: string[], guesses: object,
 *            loginPeople: object }}
 *   `matched`   each folded login → the person it went to
 *   `unmatched` the logins left in the list, marked `login: true`
 *   `manual`    the matched logins an admin placed, rather than the name
 *   `offCrew`   the logins an admin said are nobody on the crew
 *   `guesses`   each login → the person its name alone points at, or null:
 *               what "automatic" gives, for the screen that overrides it
 *   `loginPeople` EVERY login, row or none, lowercased → the person it is;
 *               a login nobody is left out. Server-side only.
 */
function foldLoginRows(roster, usernames, links) {
  const answers = links || {};
  const logins = new Set((usernames || []).map(u => String(u || '').trim().toLowerCase()).filter(Boolean));
  const isLogin = r => !/\s/.test(r.name) && logins.has(r.name.toLowerCase());
  const people = roster.filter(r => !isLogin(r)).map(r => ({ ...r }));
  const byName = new Map(people.map(p => [p.name.toLowerCase(), p]));

  const byKey = new Map();   // login key → the people it could name
  for (const p of people) {
    for (const k of loginKeysFor(p.name)) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(p);
    }
  }

  // The one person a login's name points at; the person an admin said it is,
  // if that person is still on the roster; and an admin's "nobody on the crew".
  const guessFor  = u => { const hits = byKey.get(loginKey(u)) || []; return hits.length === 1 ? hits[0] : null; };
  const chosenFor = u => { const a = answers[u] || {}; return (a.person && byName.get(String(a.person).toLowerCase())) || null; };
  const saidNone  = u => (answers[u] || {}).none === true;

  const matched = {}, unmatched = [], manual = [], offCrew = [], guesses = {};
  const fold = (row, p) => {
    p.is_supervisor = p.is_supervisor || row.is_supervisor;
    p.is_driver     = p.is_driver     || row.is_driver;
    for (const f of ['phone', 'email', 'supervisor_name']) if (!p[f] && row[f]) p[f] = row[f];
    (p.logins = p.logins || []).push(row.name);
    matched[row.name] = p.name;
  };
  for (const row of roster.filter(isLogin)) {
    const login = row.name.toLowerCase();
    const guess = guessFor(login);
    guesses[row.name] = guess ? guess.name : null;
    if (saidNone(login)) {
      people.push({ ...row, login: true, offCrew: true });
      offCrew.push(row.name);
      continue;
    }
    const chosen = chosenFor(login);
    if (chosen) { fold(row, chosen); manual.push(row.name); continue; }
    if (guess) { fold(row, guess); continue; }
    people.push({ ...row, login: true });
    unmatched.push(row.name);
  }

  // Every login the company has, a row of its own or not → the person it is,
  // by the same answers and the same rule. Most logins have no row: only the
  // ones given a role in Manage Users → Roles do. Those have nothing to fold,
  // but they still file things under the username — time off above all — and
  // what they file is the person's. It names logins the roster does not show,
  // so it is for the server's own use and no caller sends it on.
  const loginPeople = {};
  for (const login of logins) {
    if (saidNone(login)) continue;
    const who = chosenFor(login) || guessFor(login);
    if (who) loginPeople[login] = who.name;
  }

  // "Reports to" names a person too. One that names a folded login now names
  // the person it folded into, or it would point at somebody no longer listed.
  const toPerson = new Map(Object.entries(matched).map(([login, name]) => [login.toLowerCase(), name]));
  for (const p of people) {
    const boss = toPerson.get(String(p.supervisor_name || '').trim().toLowerCase());
    if (boss) p.supervisor_name = boss;
  }

  people.sort((a, b) => a.name.localeCompare(b.name));
  return { people, matched, unmatched, manual, offCrew, guesses, loginPeople };
}

// ── Matched by hand ─────────────────────────────────────────────────────────
// The name is a guess, and some logins cannot be guessed: one made from a
// nickname ("beckerbob" for Robert Becker), one two people answer to, one for
// somebody who is not crew at all — an office login given a role. So an admin
// can say who a login is, or that it is nobody on the crew, and that answer
// beats the guess. One app_data row per company holds an entry per login. Only
// PATCH /api/employees?login= writes it: the generic data endpoint does not
// accept the key, so nobody but an admin moves a login onto a person.
const LOGIN_LINKS_KEY = 'fct_login_links';
function loginLinksKey(companyCode) { return companyCode + ':' + LOGIN_LINKS_KEY; }

async function readLoginLinks(sql, companyCode) {
  const rows = await sql`SELECT value FROM app_data WHERE key = ${loginLinksKey(companyCode)}`;
  const links = rows.length && rows[0].value && rows[0].value.links;
  return (links && typeof links === 'object' && !Array.isArray(links)) ? links : {};
}

/**
 * Sets, or with `link` null clears, one login's answer. The entry is written
 * in place rather than by reading the row and writing it back, so two admins
 * answering for different logins at the same moment cannot undo each other.
 *
 * @param {string}      login  the username, stored lowercased
 * @param {object|null} link   { person: '<name>' } or { none: true }; null
 *                             goes back to the name
 */
async function writeLoginLink(sql, companyCode, login, link) {
  const key = loginLinksKey(companyCode), entry = String(login || '').toLowerCase();
  if (link) {
    const answer = JSON.stringify(link);
    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${key}, jsonb_build_object('links', jsonb_build_object(${entry}::text, ${answer}::jsonb)), NOW())
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_build_object('links',
                  (CASE WHEN jsonb_typeof(app_data.value -> 'links') = 'object'
                        THEN app_data.value -> 'links' ELSE '{}'::jsonb END)
                  || jsonb_build_object(${entry}::text, ${answer}::jsonb)),
        updated_at = NOW()
    `;
  } else {
    await sql`
      UPDATE app_data SET
        value = jsonb_build_object('links',
                  (CASE WHEN jsonb_typeof(value -> 'links') = 'object'
                        THEN value -> 'links' ELSE '{}'::jsonb END) - ${entry}::text),
        updated_at = NOW()
      WHERE key = ${key}
    `;
  }
}

// ── Kept off the Scheduler ──────────────────────────────────────────────────
// The Scheduler offers everybody on the roster as crew, and not everybody on
// the roster can be sent to a job: office staff whose logins are flagged
// Supervisor so they can approve a timesheet, crew who have gone back to
// college. They stay on the roster — Timesheet, Payroll and the Team Directory
// still need them — and an admin says, person by person, that the Scheduler's
// crew list should leave them off. Manage Users → Scheduler says it, through
// PATCH /api/employees?scheduler= and nothing else: like the login answers, the
// generic data endpoint does not accept the key.
//
// Keyed by the person's name as the list of PEOPLE gives it (readPeopleRoster),
// lowercased. So a login folded into its person is covered by the person's
// entry, and a login nobody could be matched to — which is on the crew list
// under its own name — is its own entry. Not on the employees row: half the
// roster has no row (paving's and kiewit's lists, quarry's table), and making
// one just to hold this would put a blank job class ahead of the one on the
// division's list. One app_data row per company, an entry per person, written
// in place — the same shape, and for the same reason, as the login answers.
//
// Opt-OUT: nobody is off until an admin says so, so nothing on anyone's board
// moves when this ships.
const OFF_SCHEDULER_KEY = 'fct_off_scheduler';
function offSchedulerKey(companyCode) { return companyCode + ':' + OFF_SCHEDULER_KEY; }

/** Lowercased name → { at, by } for everybody kept off. */
async function readOffScheduler(sql, companyCode) {
  const rows = await sql`SELECT value FROM app_data WHERE key = ${offSchedulerKey(companyCode)}`;
  const people = rows.length && rows[0].value && rows[0].value.people;
  return (people && typeof people === 'object' && !Array.isArray(people)) ? people : {};
}

/**
 * Keeps one person off the Scheduler's crew list, or with `off` false puts them
 * back. Written in place, like writeLoginLink, so two admins at once cannot
 * undo each other.
 *
 * @param {string}  name  the person, as the list of people names them
 * @param {boolean} off
 * @param {string}  [by]  the username saying so, kept with the entry
 */
async function writeOffScheduler(sql, companyCode, name, off, by) {
  const key = offSchedulerKey(companyCode), entry = String(name || '').trim().toLowerCase();
  if (off) {
    const said = JSON.stringify({ at: new Date().toISOString(), by: by || null });
    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${key}, jsonb_build_object('people', jsonb_build_object(${entry}::text, ${said}::jsonb)), NOW())
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_build_object('people',
                  (CASE WHEN jsonb_typeof(app_data.value -> 'people') = 'object'
                        THEN app_data.value -> 'people' ELSE '{}'::jsonb END)
                  || jsonb_build_object(${entry}::text, ${said}::jsonb)),
        updated_at = NOW()
    `;
  } else {
    await sql`
      UPDATE app_data SET
        value = jsonb_build_object('people',
                  (CASE WHEN jsonb_typeof(value -> 'people') = 'object'
                        THEN value -> 'people' ELSE '{}'::jsonb END) - ${entry}::text),
        updated_at = NOW()
      WHERE key = ${key}
    `;
  }
}

/** Marks each person an admin kept off (`offScheduler: true`), in place. */
function markOffScheduler(people, off) {
  const kept = off || {};
  for (const p of people) {
    if (Object.prototype.hasOwnProperty.call(kept, String(p.name || '').toLowerCase())) p.offScheduler = true;
  }
  return people;
}

/**
 * readEmployeeRoster, folded into people. A failed read of the logins folds
 * nothing, which is the list as it was, rather than an error; a failed read of
 * the admins' answers leaves the names to decide; a failed read of who is kept
 * off the Scheduler keeps nobody off.
 *
 * Everything returned names only rows the roster already returns, so no login
 * the roster does not already show is handed out.
 */
async function readPeopleRoster(sql, companyCode) {
  const roster = await readEmployeeRoster(sql, companyCode);
  let usernames = [], links = {}, off = {};
  try {
    usernames = (await sql`SELECT username FROM users WHERE company_code = ${companyCode}`).map(r => r.username);
  } catch (err) { console.error('[roster] users read failed (non-fatal):', err.message); }
  try { links = await readLoginLinks(sql, companyCode); }
  catch (err) { console.error('[roster] login links read failed (non-fatal):', err.message); }
  try { off = await readOffScheduler(sql, companyCode); }
  catch (err) { console.error('[roster] off-scheduler read failed (non-fatal):', err.message); }
  const folded = foldLoginRows(roster, usernames, links);
  markOffScheduler(folded.people, off);
  return folded;
}

module.exports = { readEmployeeRoster, readPeopleRoster, foldLoginRows, loginKeysFor, loginKey,
                   readLoginLinks, writeLoginLink, loginLinksKey,
                   readOffScheduler, writeOffScheduler, markOffScheduler, offSchedulerKey };
