'use strict';
/**
 * Safety Center — what the two sides of it may do, and who is expected to sign.
 *
 * The division has ONE key and two jobs, split by level rather than by a
 * second division key the way fuel/fuel_admin is:
 *
 *   level1          open the week's document and sign it
 *   level3 / admin  post documents, and read the sign-off report
 *
 * level2 exists in the platform's role scale and is not offered on the user
 * form, but a role map can still carry it, so it is resolved here rather than
 * left to each endpoint to guess at: it reads as a signer. The same goes the
 * other way for 'admin', which reads as a supervisor.
 */

const { hasDivisionAccess, levelFor } = require('./auth');

const SAFETY_DIVISION = 'safety';

/**
 * What a signature asserts.
 *
 * Lives here rather than in the signing endpoint because the DOCUMENT list
 * hands it out too: the page must display the sentence it is about to be
 * recorded against, and a second copy of it in the page would be a sentence
 * people see but do not agree to the moment either side is edited. Each
 * signature stores the text as well, so re-wording this line later cannot
 * rewrite what anyone has already agreed to.
 */
const SIGNATURE_STATEMENT =
  'I have read this document in full, I understand its contents, and I agree to '
  + 'follow the safety requirements it describes.';

// The levels that run the Safety Center rather than sign in it.
const SUPERVISOR_LEVELS = ['admin', 'level3'];

/**
 * What this caller may do in the Safety Center.
 *
 *   canView    open documents and sign them
 *   canManage  upload, edit, archive, and read the sign-off report
 *
 * Note canManage implies canView: a supervisor conducts the tailgate meeting
 * and signs it too, so the report counts them like anyone else.
 */
function safetyCapabilities(payload) {
  if (!hasDivisionAccess(payload, SAFETY_DIVISION)) {
    return { level: 'no_access', canView: false, canManage: false };
  }
  const level = safetyLevelFor(payload);
  return {
    level,
    canView: true,
    canManage: SUPERVISOR_LEVELS.includes(level),
  };
}

/**
 * This caller's level in the Safety Center.
 *
 * Deliberately NOT levelFor() from api/lib/auth.js, which answers 'admin' for
 * any platform admin before it looks at their roles at all. Here an EXPLICIT
 * safety grant wins over that default, which is the same rule divisions.html
 * already applies to deciding which tiles a platform admin sees: a role map
 * somebody has actually been edited into is the source of truth, and the
 * platform-admin default only fills in where nobody has said anything.
 *
 * It matters more here than elsewhere. The two levels of this division are the
 * whole design — somebody set to "Read & sign" is being told they are crew —
 * and a platform admin silently resolving to 'admin' handed them the upload
 * form and the sign-off report anyway, which is exactly what it looked like:
 * an account set to view-and-sign seeing everything.
 *
 * A platform admin with NO explicit safety role still gets the supervisor
 * side, so nobody is locked out of a division they administer; and this
 * narrows what one person can do rather than widening it, so it cannot hand
 * anybody access they did not already have.
 */
function safetyLevelFor(payload) {
  const dr = payload && payload.divisionRoles;
  const explicit = dr && typeof dr === 'object' ? dr[SAFETY_DIVISION] : null;
  if (explicit && explicit !== 'no_access') return explicit;
  if (payload && payload.isPlatformAdmin) return 'admin';
  return levelFor(payload, SAFETY_DIVISION);
}

/**
 * Everyone the report expects a signature from: every user in the company
 * whose role map grants them the Safety Center at all.
 *
 * That definition is the reason the division is granted per user rather than
 * inherited from a company-wide list. "Who has not signed" is only a real
 * question if the set of people being asked is a real set — an implicit grant
 * would put every login in the company on the outstanding list, office staff
 * included, and a report nobody can clear is a report nobody reads.
 *
 * Platform admins are deliberately NOT swept in. They can reach every division
 * by virtue of being platform admins, which is an access rule rather than a
 * statement that they attend this company's tailgate meeting; one appears here
 * only when their role map names safety explicitly, like anyone else's.
 */
async function requiredSigners(sql, companyCode) {
  // The ::text on the key is not decoration. Postgres has both jsonb->>text
  // and jsonb->>integer, so an untyped parameter in that position is an
  // ambiguous operator — the roster read fails outright rather than returning
  // the wrong people, which means the whole report fails to load.
  const rows = await sql`
    SELECT id, username, division_roles
    FROM   users
    WHERE  company_code = ${companyCode}
      AND  division_roles IS NOT NULL
      AND  COALESCE(division_roles->>${SAFETY_DIVISION}::text, 'no_access') <> 'no_access'
    ORDER  BY LOWER(username)
  `;
  return rows.map(r => ({
    userId:   r.id,
    username: r.username,
    level:    (r.division_roles && r.division_roles[SAFETY_DIVISION]) || 'level1',
  }));
}

/**
 * True when `key` already belongs to a safety document.
 *
 * api/document-upload-url.js mints the storage keys for this division too, and
 * its DELETE and relay-PUT arms refuse a key that project_documents claims.
 * Safety documents are not in that table, so without this they would look
 * unclaimed: a supervisor could have deleted the object out from under a
 * signed document, or written new bytes over one, leaving every signature
 * already collected pointing at a file that is no longer the file that was
 * signed.
 */
async function safetyKeyClaimed(sql, key) {
  if (!key) return false;
  try {
    const rows = await sql`SELECT id FROM safety_documents WHERE storage_key = ${key} LIMIT 1`;
    return rows.length > 0;
  } catch (err) {
    // A deployment whose schema has not been applied yet has no such table —
    // and therefore no safety documents for this guard to protect, so "not
    // claimed" is the true answer rather than a fail-open. Anything else is a
    // real fault and is raised, because guessing 'unclaimed' at a database
    // that is merely unwell is how a signed document loses its file.
    if (/relation .*safety_documents.* does not exist/i.test(err.message || '')) return false;
    throw err;
  }
}

/**
 * A DATE column as YYYY-MM-DD, whatever the driver hands back.
 *
 * @neondatabase/serverless applies the standard pg type parsers, so a DATE
 * comes back as a JS Date at LOCAL midnight. toISOString() on one converts to
 * UTC and moves the day BACK anywhere east of Greenwich: the Monday a document
 * is filed under reads as the Sunday before it, which is a date the whole
 * week-of rule says can never occur. Worse, feeding that value back through
 * mondayOf() on an edit refiles the document a week earlier.
 *
 * Read the local components instead, exactly as safeDate() in
 * api/quarry-sales-submissions.js does — this repo has been bitten by this
 * twice already, and both fixes carry a comment saying so.
 */
function dateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * The Monday of the week `value` falls in, as YYYY-MM-DD, or null.
 *
 * Documents are filed by week, and a week has to mean one date or the report
 * shows the same tailgate meeting twice because two supervisors picked two
 * days of it. Monday rather than Sunday: the tailgate is held at the start of
 * the working week, and a form posted on Friday for the week just worked
 * belongs to that week, not to the weekend after it.
 */
function mondayOf(value) {
  // Via dateOnly so a Date from the driver is read by its LOCAL components,
  // never through UTC — see the comment there.
  const s = String(dateOnly(value) || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Parsed at noon UTC so a timezone offset cannot roll the date back a day,
  // the same guard api/quarry-sales-submissions.js applies to work_date.
  const d = new Date(`${s}T12:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const dow = d.getUTCDay();             // 0 Sun … 6 Sat
  const back = dow === 0 ? 6 : dow - 1;  // Sunday belongs to the week just ended
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  SAFETY_DIVISION,
  SIGNATURE_STATEMENT,
  SUPERVISOR_LEVELS,
  safetyCapabilities,
  safetyLevelFor,
  requiredSigners,
  safetyKeyClaimed,
  mondayOf,
  dateOnly,
};
