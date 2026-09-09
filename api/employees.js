'use strict';
/**
 * GET    /api/employees                 — list all active employees for the company
 * PUT    /api/employees                 — full replace: sync entire employee array.
 *                                         Names absent from the array are deleted;
 *                                         `is_supervisor` is only moved when the
 *                                         payload actually carries it, since a
 *                                         division's roster save does not know
 *                                         about a global role flag.
 * POST   /api/employees                 — create a single employee (upserts by
 *                                         name, with the same is_supervisor rule)
 * PATCH  /api/employees?name=X          — partial update of one employee's global
 *                                         role flags (`is_supervisor`, `is_driver`)
 *                                         and contact card (`phone`, `email`,
 *                                         `supervisor_name`); used by the
 *                                         "Manage Users" and "Team Directory" UIs
 *                                         on divisions.html. Any field may be sent
 *                                         alone — an absent field is left alone
 *                                         rather than reset, so two editors of the
 *                                         same person can never clobber each other.
 * DELETE /api/employees?id=N            — hard-delete one employee by id
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

// ── Contact card normalisation ──────────────────────────────────────────────
// The three fields the Team Directory writes. Each one is stored as typed
// (minus surrounding whitespace) rather than reformatted: a number entered as
// "(814) 555-0142 x12" is what the office knows, and a tidy-up that eats the
// extension makes the field worse. What IS enforced is a length ceiling and,
// for email, that the thing is addressable at all — a mailto: link built from
// "call him" is a dead link that looks live.
const MAX_PHONE      = 40;
const MAX_EMAIL      = 160;
const MAX_SUPERVISOR = 120;

// Deliberately loose: one @, something either side, a dot in the domain. The
// only job is to catch a name or a note typed into the wrong box, not to
// adjudicate RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalises whichever of phone / email / supervisor_name are present in
 * `body`. An absent key stays absent (the PATCH leaves that column alone); a
 * key sent empty normalises to null, which is how the directory clears a
 * field.
 *
 * @param  {object} body        the request body
 * @param  {string} ownName     the employee being edited, for the self-report guard
 * @return {{error: string}|{fields: object}}
 */
function normalizeContact(body, ownName) {
  const out = {};
  const src = body || {};

  if (typeof src.phone !== 'undefined') {
    const phone = String(src.phone == null ? '' : src.phone).trim();
    if (phone.length > MAX_PHONE) return { error: `phone must be ${MAX_PHONE} characters or fewer` };
    // A "phone number" with no digits in it is someone's note in the wrong box.
    if (phone && !/\d/.test(phone)) return { error: 'phone must contain at least one digit' };
    out.phone = phone || null;
  }

  if (typeof src.email !== 'undefined') {
    const email = String(src.email == null ? '' : src.email).trim();
    if (email.length > MAX_EMAIL) return { error: `email must be ${MAX_EMAIL} characters or fewer` };
    if (email && !EMAIL_RE.test(email)) return { error: 'email is not a valid address' };
    out.email = email ? email.toLowerCase() : null;
  }

  if (typeof src.supervisor_name !== 'undefined') {
    const sup = String(src.supervisor_name == null ? '' : src.supervisor_name).trim();
    if (sup.length > MAX_SUPERVISOR) return { error: `supervisor_name must be ${MAX_SUPERVISOR} characters or fewer` };
    // A reporting line pointing at itself reads as "reports to nobody" in the
    // directory and breaks any roll-up built on the column later.
    if (sup && ownName && sup.toLowerCase() === String(ownName).trim().toLowerCase()) {
      return { error: 'an employee cannot be their own supervisor' };
    }
    out.supervisor_name = sup || null;
  }

  return { fields: out };
}

module.exports = async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    // Returns the union of every roster in the company — the canonical
    // `employees` table (turf/dust/trucking) + paving's separate
    // `fct_paving_lists.employees` blob + the `quarry_employees` table.
    // Deduplicated by name so the global "Manage Users" modal shows
    // everyone exactly once. `is_supervisor`, `is_driver` and the contact card
    // (`phone`, `email`, `supervisor_name`) only come from the employees table —
    // paving/quarry-only people come back unflagged with an empty card, and a
    // PATCH will create their row the first time either is filled in.
    if (req.method === 'GET') {
      const tableRows = await sql`
        SELECT id, name, job_class,
               pw_rate       AS prevailing_rate,
               non_pw_rate   AS non_prevailing_rate,
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

      const byName = new Map(); // lowercased name → row
      for (const r of tableRows) {
        byName.set(r.name.toLowerCase(), {
          id:                 r.id,
          name:               r.name,
          job_class:          r.job_class || null,
          prevailing_rate:    r.prevailing_rate,
          non_prevailing_rate:r.non_prevailing_rate,
          is_supervisor:      r.is_supervisor === true,
          is_driver:          r.is_driver === true,
          phone:              r.phone || null,
          email:              r.email || null,
          supervisor_name:    r.supervisor_name || null,
          source:             'employees',
        });
      }

      // Paving — blob lives at "<company>:fct_paving_lists"
      try {
        const pBlob = await sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_paving_lists'}`;
        const pList = pBlob.length && pBlob[0].value && Array.isArray(pBlob[0].value.employees)
          ? pBlob[0].value.employees
          : [];
        for (const e of pList) {
          const name = (typeof e === 'string' ? e : (e && e.name)) || '';
          const trimmed = name.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (byName.has(key)) continue;
          byName.set(key, {
            id:                 null,
            name:               trimmed,
            job_class:          (typeof e === 'object' && e.job_class) || null,
            prevailing_rate:    null,
            non_prevailing_rate:null,
            is_supervisor:      false,
            is_driver:          false,
            phone:              null,
            email:              null,
            supervisor_name:    null,
            source:             'paving',
          });
        }
      } catch (err) {
        console.error('[employees GET] paving blob read failed (non-fatal):', err.message);
      }

      // Kiewit Pinetree — blob lives at "<company>:fct_kiewit_lists"
      try {
        const kBlob = await sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_kiewit_lists'}`;
        const kList = kBlob.length && kBlob[0].value && Array.isArray(kBlob[0].value.employees)
          ? kBlob[0].value.employees
          : [];
        for (const e of kList) {
          const name = (typeof e === 'string' ? e : (e && e.name)) || '';
          const trimmed = name.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (byName.has(key)) continue;
          byName.set(key, {
            id:                 null,
            name:               trimmed,
            job_class:          (typeof e === 'object' && e.job_class) || null,
            prevailing_rate:    null,
            non_prevailing_rate:null,
            is_supervisor:      false,
            is_driver:          false,
            phone:              null,
            email:              null,
            supervisor_name:    null,
            source:             'kiewit',
          });
        }
      } catch (err) {
        console.error('[employees GET] kiewit blob read failed (non-fatal):', err.message);
      }

      // Quarry — quarry_employees table
      try {
        const qRows = await sql`
          SELECT name FROM quarry_employees
          WHERE company_code = ${companyCode}
        `;
        for (const r of qRows) {
          const trimmed = (r.name || '').trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (byName.has(key)) continue;
          byName.set(key, {
            id:                 null,
            name:               trimmed,
            job_class:          null,
            prevailing_rate:    null,
            non_prevailing_rate:null,
            is_supervisor:      false,
            is_driver:          false,
            phone:              null,
            email:              null,
            supervisor_name:    null,
            source:             'quarry',
          });
        }
      } catch (err) {
        console.error('[employees GET] quarry read failed (non-fatal):', err.message);
      }

      const merged = Array.from(byName.values())
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.json({ employees: merged });
    }

    // ── PUT (full replace) ────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { employees } = req.body || {};
      if (!Array.isArray(employees)) return res.status(400).json({ error: 'employees array required' });

      const incoming = employees
        .map((e, i) => ({ ...e, _i: i }))
        .filter(e => e.name?.trim());
      const incomingNames = new Set(incoming.map(e => e.name.trim()));

      // Bulk-wipe protection: an empty incoming list against a non-trivial
      // employees table is almost always a client bug (race / stale state)
      // and would silently destroy the company's payroll roster.
      // Single-employee deletes still work via DELETE /api/employees?id=.
      const existing = await sql`SELECT name FROM employees WHERE company_code = ${companyCode}`;
      if (incoming.length === 0 && existing.length > 1 && req.query.force !== '1') {
        console.warn(`[employees] refused empty PUT: ${existing.length} employees would have been wiped for ${companyCode}`);
        return res.status(409).json({
          error: 'Refusing to wipe employees',
          detail: `Cannot replace ${existing.length} employees with an empty list. Use DELETE /api/employees?id= for single removals, or pass ?force=1 to override.`,
        });
      }

      // Remove deleted employees
      for (const { name } of existing) {
        if (!incomingNames.has(name)) {
          await sql`DELETE FROM employees WHERE company_code = ${companyCode} AND name = ${name}`;
        }
      }

      // Upsert each employee. The contact card (phone, email, supervisor_name)
      // stays out of the UPDATE SET entirely, same rule as syncLists: this body
      // is a division's roster save, it carries no phone number, and naming
      // those columns here would blank the directory every time a list was
      // saved.
      //
      // is_supervisor is in the payload contract, so it cannot simply be
      // dropped — but it is a GLOBAL flag set from Manage Users → Roles, and a
      // roster save that does not mention it must not clear it. `undefined`
      // therefore means "leave it", exactly as it does on the PATCH, and only a
      // caller who actually sends the field moves it. Sending EXCLUDED.
      // is_supervisor unconditionally is what un-flagged every supervisor in
      // the company the moment anyone saved an employee list.
      //
      // is_driver is not in this statement at all, which is why it was never
      // exposed to the same bug.
      for (const e of incoming) {
        const pwRate    = parseFloat(e.prevailing_rate    ?? e.pw_rate)    || null;
        const nonPwRate = parseFloat(e.non_prevailing_rate ?? e.non_pw_rate) || null;
        const isSup     = typeof e.is_supervisor === 'undefined' ? null : Boolean(e.is_supervisor);
        await sql`
          INSERT INTO employees (company_code, name, job_class, pw_rate, non_pw_rate, is_supervisor, sort_order, active, updated_at)
          VALUES (
            ${companyCode}, ${e.name.trim()}, ${e.job_class || null},
            ${pwRate}, ${nonPwRate}, COALESCE(${isSup}::boolean, FALSE), ${e._i}, TRUE, NOW()
          )
          ON CONFLICT (company_code, name) DO UPDATE SET
            job_class     = EXCLUDED.job_class,
            pw_rate       = EXCLUDED.pw_rate,
            non_pw_rate   = EXCLUDED.non_pw_rate,
            is_supervisor = COALESCE(${isSup}::boolean, employees.is_supervisor),
            sort_order    = EXCLUDED.sort_order,
            active        = TRUE,
            updated_at    = NOW()
        `;
      }
      return res.json({ ok: true });
    }

    // ── POST (single create) ──────────────────────────────────────────────
    // "Create" that upserts, so it lands on an existing person often enough to
    // need the same rule the PUT does: an unmentioned is_supervisor is left
    // alone rather than cleared.
    if (req.method === 'POST') {
      const { name, job_class, prevailing_rate, non_prevailing_rate, is_supervisor } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ error: 'name required' });

      const isSup = typeof is_supervisor === 'undefined' ? null : Boolean(is_supervisor);

      const [row] = await sql`
        INSERT INTO employees (company_code, name, job_class, pw_rate, non_pw_rate, is_supervisor, sort_order, active, updated_at)
        VALUES (
          ${companyCode}, ${name.trim()}, ${job_class || null},
          ${parseFloat(prevailing_rate) || null},
          ${parseFloat(non_prevailing_rate) || null},
          COALESCE(${isSup}::boolean, FALSE),
          (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM employees WHERE company_code = ${companyCode}),
          TRUE, NOW()
        )
        ON CONFLICT (company_code, name) DO UPDATE SET
          job_class     = EXCLUDED.job_class,
          pw_rate       = EXCLUDED.pw_rate,
          non_pw_rate   = EXCLUDED.non_pw_rate,
          is_supervisor = COALESCE(${isSup}::boolean, employees.is_supervisor),
          active        = TRUE,
          updated_at    = NOW()
        RETURNING id, name, job_class,
                  pw_rate AS prevailing_rate, non_pw_rate AS non_prevailing_rate,
                  is_supervisor,
                  sort_order
      `;
      return res.status(201).json({ employee: row });
    }

    // ── PATCH (role flags + contact card, by name) ────────────────────────
    // Upserts the employees row by (company_code, name) so people who only
    // exist in paving's `fct_paving_lists` or in `quarry_employees` can be
    // flagged as supervisors — or given a cell number — without first existing
    // in the canonical table. Only company admins or platform admins may write.
    if (req.method === 'PATCH') {
      if (payload.role !== 'admin' && !payload.isPlatformAdmin) {
        return res.status(403).json({ error: 'Company admin access required' });
      }
      const name = (req.query.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });

      // Every field here is a global fact about the person, and several editors
      // reach the same row from different screens — the Roles tab flips a flag,
      // the Team Directory saves a phone number. Send whichever fields you are
      // changing: an absent field is left as it is rather than reset, so saving
      // a contact card can never silently clear "Driver" (a single upsert
      // naming every column would do exactly that, because the VALUES list has
      // to supply *something* for the columns the caller did not send).
      const fields = req.body || {};
      const hasSup = typeof fields.is_supervisor !== 'undefined';
      const hasDrv = typeof fields.is_driver     !== 'undefined';

      const contact = normalizeContact(fields, name);
      if (contact.error) return res.status(400).json({ error: contact.error });
      const hasPhone = Object.prototype.hasOwnProperty.call(contact.fields, 'phone');
      const hasEmail = Object.prototype.hasOwnProperty.call(contact.fields, 'email');
      const hasBoss  = Object.prototype.hasOwnProperty.call(contact.fields, 'supervisor_name');

      if (!hasSup && !hasDrv && !hasPhone && !hasEmail && !hasBoss) {
        return res.status(400).json({
          error: 'one of is_supervisor, is_driver, phone, email or supervisor_name is required',
        });
      }

      // One statement, so a save either lands whole or not at all — and a
      // person who only ever appeared in the paving or quarry roster still gets
      // their employees row created the first time they are edited.
      //
      // Two different "leave it alone" idioms, because the columns differ in
      // what NULL means. A flag is a boolean the caller either sends or does
      // not, so COALESCE on a NULL parameter keeps the stored value. A contact
      // field, though, is CLEARED by sending it empty — NULL is a real value
      // there — so a sent/not-sent boolean drives a CASE instead. Using
      // COALESCE for those would make the fields impossible to blank once set.
      const supVal   = hasSup ? Boolean(fields.is_supervisor) : null;
      const drvVal   = hasDrv ? Boolean(fields.is_driver)     : null;
      const phoneVal = hasPhone ? contact.fields.phone           : null;
      const emailVal = hasEmail ? contact.fields.email           : null;
      const bossVal  = hasBoss  ? contact.fields.supervisor_name : null;

      const [row] = await sql`
        INSERT INTO employees (company_code, name, is_supervisor, is_driver,
                               phone, email, supervisor_name,
                               sort_order, active, updated_at)
        VALUES (
          ${companyCode}, ${name},
          COALESCE(${supVal}::boolean, FALSE),
          COALESCE(${drvVal}::boolean, FALSE),
          ${phoneVal}::text, ${emailVal}::text, ${bossVal}::text,
          (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM employees WHERE company_code = ${companyCode}),
          TRUE, NOW()
        )
        ON CONFLICT (company_code, name) DO UPDATE SET
          is_supervisor   = COALESCE(${supVal}::boolean, employees.is_supervisor),
          is_driver       = COALESCE(${drvVal}::boolean, employees.is_driver),
          phone           = CASE WHEN ${hasPhone}::boolean THEN ${phoneVal}::text ELSE employees.phone END,
          email           = CASE WHEN ${hasEmail}::boolean THEN ${emailVal}::text ELSE employees.email END,
          supervisor_name = CASE WHEN ${hasBoss}::boolean  THEN ${bossVal}::text  ELSE employees.supervisor_name END,
          updated_at      = NOW()
        RETURNING id, name, is_supervisor, is_driver, phone, email, supervisor_name
      `;
      return res.json({ ok: true, employee: row });
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM employees WHERE id = ${id} AND company_code = ${companyCode}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[employees]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

// Exposed for scripts/test-employee-directory.js.
module.exports._test = { normalizeContact, EMAIL_RE, MAX_PHONE, MAX_EMAIL, MAX_SUPERVISOR };
