-- =====================================================================
-- Dust config recovery: blank save between the 2026-10-02 and 2026-10-03
-- 09:45 UTC DataWatch runs. Neon SQL editor, Primary branch.
-- BEFORE RUNNING (2): close every Dust tab on every device (see notes).
--
-- Cutoff: each record as the 2026-10-02 run found it, i.e. its newest copy
-- at or before that run's stamp. A run copies only the records that changed
-- and stamps them all with the second it started, so the stamp is the
-- company's first copy from 09:45 to 10:45 that day — whatever second the
-- run started (a late start fell past the old "< 09:46" cutoff, which then
-- silently restored an older copy's rate and margin). A company with no copy
-- in that hour had nothing changed since its last copy (or the run failed),
-- and is read at 09:45:00. The search stops at 10:45 so it never reaches a
-- run made by hand later that day, after the blank save: for a company the
-- 10-02 run copied nothing of, that run's blank copy was the first of the
-- day, and nothing was restored. (1) shows the stamp used as cutoff_run_at.
-- Check (1b): the copy restored from must be that run's, and not already
-- blank. If it is not, replace the cutoff with "<=" the exact stamp of the
-- last good run (the DataWatch email's restore snippet carries it), in every
-- place it appears below and in recover-dust-ic-billing-2026-10.sql's pre.
-- =====================================================================

-- (1) LOOK, read-only. One row per company: the newest copy at or before
--     the cutoff, the first copy after it (saved_at = when the blank save
--     landed, or a save after it), and what is live now.
WITH v AS (
  (SELECT DISTINCT ON (s.key) 'pre' AS src, s.key, s.taken_at AS at, s.source_updated_at AS saved_at, s.value_hash, s.value
     FROM app_data_snapshots s
    WHERE s.key IN (s.company_code || ':dust_settings', s.company_code || ':dust_lists')
      AND s.taken_at <= (SELECT COALESCE(min(r.taken_at), TIMESTAMPTZ '2026-10-02 09:45:00+00') FROM app_data_snapshots r
                          WHERE r.company_code = s.company_code
                            AND r.taken_at >= TIMESTAMPTZ '2026-10-02 09:45:00+00'
                            AND r.taken_at <  TIMESTAMPTZ '2026-10-02 10:45:00+00')
    ORDER BY s.key, s.taken_at DESC)
  UNION ALL
  (SELECT DISTINCT ON (s.key) 'post', s.key, s.taken_at, s.source_updated_at, s.value_hash, s.value
     FROM app_data_snapshots s
    WHERE s.key IN (s.company_code || ':dust_settings', s.company_code || ':dust_lists')
      AND s.taken_at > (SELECT COALESCE(min(r.taken_at), TIMESTAMPTZ '2026-10-02 09:45:00+00') FROM app_data_snapshots r
                          WHERE r.company_code = s.company_code
                            AND r.taken_at >= TIMESTAMPTZ '2026-10-02 09:45:00+00'
                            AND r.taken_at <  TIMESTAMPTZ '2026-10-02 10:45:00+00')
    ORDER BY s.key, s.taken_at)
  UNION ALL
  SELECT 'now', a.key, a.updated_at, a.updated_at, NULL, a.value
    FROM app_data a
   WHERE a.key ~ '^[^:]+:dust_(settings|lists)$'
), m AS (
  SELECT split_part(key, ':', 1) AS company_code,
         src || '_' || split_part(key, ':', 2) AS k,
         at, saved_at, value_hash,
         value->>'ub_rate' AS ub_rate,
         (SELECT count(*) FROM jsonb_each(CASE WHEN jsonb_typeof(value->'profit_margin') = 'object'
                                               THEN value->'profit_margin' ELSE '{}' END) e
           WHERE e.key IN ('base_gal','base_rate','soap_gal','soap_rate','water_gal','water_rate','mix_parts','charge')
             AND e.value <> 'null') AS pm_fields,
         (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(value->'employee_rates') = 'object'
                                                      THEN value->'employee_rates' ELSE '{}' END)) AS emp_rates,
         jsonb_array_length(CASE WHEN jsonb_typeof(value->'cost_codes') = 'array' THEN value->'cost_codes' ELSE '[]' END) AS cost_codes,
         jsonb_array_length(CASE WHEN jsonb_typeof(value->'companies')  = 'array' THEN value->'companies'  ELSE '[]' END) AS companies
    FROM v
)
SELECT m.company_code,
       (SELECT COALESCE(min(r.taken_at), TIMESTAMPTZ '2026-10-02 09:45:00+00') FROM app_data_snapshots r
         WHERE r.company_code = m.company_code
           AND r.taken_at >= TIMESTAMPTZ '2026-10-02 09:45:00+00'
           AND r.taken_at <  TIMESTAMPTZ '2026-10-02 10:45:00+00') AS cutoff_run_at,
       max(m.at)         FILTER (WHERE k = 'pre_dust_settings')  AS pre_settings_copy_at,
       max(m.ub_rate)    FILTER (WHERE k = 'pre_dust_settings')  AS pre_ub_rate,
       max(m.pm_fields)  FILTER (WHERE k = 'pre_dust_settings')  AS pre_pm_fields_set,
       max(m.at)         FILTER (WHERE k = 'pre_dust_lists')     AS pre_lists_copy_at,
       max(m.emp_rates)  FILTER (WHERE k = 'pre_dust_lists')     AS pre_employee_rates,
       max(m.cost_codes) FILTER (WHERE k = 'pre_dust_lists')     AS pre_cost_codes,
       max(m.companies)  FILTER (WHERE k = 'pre_dust_lists')     AS pre_companies,
       bool_or(m.value_hash = 'deleted') FILTER (WHERE k LIKE 'pre%') AS pre_copy_is_deleted,
       max(m.saved_at)   FILTER (WHERE k = 'post_dust_settings') AS blank_settings_saved_at,
       max(m.ub_rate)    FILTER (WHERE k = 'post_dust_settings') AS post_ub_rate,
       max(m.saved_at)   FILTER (WHERE k = 'post_dust_lists')    AS blank_lists_saved_at,
       max(m.emp_rates)  FILTER (WHERE k = 'post_dust_lists')    AS post_employee_rates,
       max(m.companies)  FILTER (WHERE k = 'post_dust_lists')    AS post_companies,
       d.ub_rate                                                 AS now_page_ub_rate,
       d.updated_at                                              AS now_page_ub_rate_updated_at,
       max(m.ub_rate)    FILTER (WHERE k = 'now_dust_settings')  AS now_blob_ub_rate,
       max(m.pm_fields)  FILTER (WHERE k = 'now_dust_settings')  AS now_pm_fields_set,
       max(m.at)         FILTER (WHERE k = 'now_dust_settings')  AS now_settings_updated_at,
       max(m.emp_rates)  FILTER (WHERE k = 'now_dust_lists')     AS now_employee_rates,
       max(m.cost_codes) FILTER (WHERE k = 'now_dust_lists')     AS now_cost_codes,
       max(m.companies)  FILTER (WHERE k = 'now_dust_lists')     AS now_blob_companies,
       max(m.at)         FILTER (WHERE k = 'now_dust_lists')     AS now_lists_updated_at,
       (SELECT count(*) FROM dust_companies dc WHERE dc.company_code = m.company_code) AS now_table_companies
  FROM m
  LEFT JOIN dust_settings d ON d.company_code = m.company_code
 GROUP BY m.company_code, d.ub_rate, d.updated_at
 ORDER BY m.company_code;

-- (1b) LOOK, read-only. Every copy of the two records in the window, so a
--      wrong cutoff (a copy that is already blank) is visible.
SELECT s.key, s.taken_at, s.source_updated_at, s.value_hash = 'deleted' AS deleted,
       s.value->>'ub_rate' AS ub_rate,
       (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(s.value->'employee_rates') = 'object'
                                                    THEN s.value->'employee_rates' ELSE '{}' END)) AS employee_rates,
       jsonb_array_length(CASE WHEN jsonb_typeof(s.value->'cost_codes') = 'array' THEN s.value->'cost_codes' ELSE '[]' END) AS cost_codes,
       jsonb_array_length(CASE WHEN jsonb_typeof(s.value->'companies')  = 'array' THEN s.value->'companies'  ELSE '[]' END) AS companies
  FROM app_data_snapshots s
 WHERE s.company_code = 'FORCECORP'                           -- <== company code (the key prefix)
   AND s.key IN (s.company_code || ':dust_settings', s.company_code || ':dust_lists')
 ORDER BY s.key, s.taken_at;

-- (1c) LOOK, read-only. Entries the pre-wipe lists copy held that the page
--      no longer serves (in neither the table nor the live blob). These are
--      what a whole-blob restore would bring back. Each is either a removal
--      made since the copy, or the ONLY entry of its list, which the blank
--      save deleted: the server refuses to empty a list of 2 or more, but
--      let a list of one go (and DataWatch does not report 1 -> 0). (2d)
--      puts back such a lone employee, material, state or MU. A lone
--      customer or truck listed here went with its rates (and a customer
--      with its well pads and company men): re-enter it in Manage Lists.
WITH pre AS (
  SELECT DISTINCT ON (s.key) s.company_code, s.value
    FROM app_data_snapshots s
   WHERE s.company_code = 'FORCECORP'                         -- <== company code
     AND s.key = s.company_code || ':dust_lists'
     AND s.taken_at <= (SELECT COALESCE(min(r.taken_at), TIMESTAMPTZ '2026-10-02 09:45:00+00') FROM app_data_snapshots r
                          WHERE r.company_code = s.company_code
                            AND r.taken_at >= TIMESTAMPTZ '2026-10-02 09:45:00+00'
                            AND r.taken_at <  TIMESTAMPTZ '2026-10-02 10:45:00+00')
   ORDER BY s.key, s.taken_at DESC
)
SELECT l.list, e.v AS not_served_now
  FROM pre
 CROSS JOIN (VALUES ('employees','dust_employees'), ('materials','dust_materials'),
                    ('states','dust_states'), ('mu','dust_mu')) l(list, list_name)
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(pre.value->l.list) = 'array'
                                                   THEN pre.value->l.list ELSE '[]' END) e(v)
 WHERE e.v <> ''
   AND NOT EXISTS (SELECT 1 FROM dropdown_lists d
                    WHERE d.company_code = pre.company_code AND d.list_name = l.list_name AND d.value = e.v)
   AND NOT EXISTS (SELECT 1 FROM app_data a
                    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.value->l.list) = 'array'
                                                                      THEN a.value->l.list ELSE '[]' END) c(v)
                    WHERE a.key = pre.company_code || ':dust_lists' AND c.v = e.v)
UNION ALL
SELECT 'companies', co->>'name'
  FROM pre CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pre.value->'companies') = 'array'
                                                        THEN pre.value->'companies' ELSE '[]' END) co
 WHERE NOT EXISTS (SELECT 1 FROM dust_companies dc WHERE dc.company_code = pre.company_code AND dc.id = co->>'id')
UNION ALL
SELECT 'equipment', eq->>'name'
  FROM pre CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pre.value->'equipment') = 'array'
                                                        THEN pre.value->'equipment' ELSE '[]' END) eq
 WHERE NOT EXISTS (SELECT 1 FROM dust_equipment de WHERE de.company_code = pre.company_code AND de.id = eq->>'id')
 ORDER BY 1, 2;

-- (2) RESTORE. Run the whole block as ONE execution. It ends in ROLLBACK:
--     read the RETURNING rows and the final check, then change the last
--     line to COMMIT and run it again. Re-running after COMMIT changes nothing.
BEGIN;

-- The pre-wipe copies this restore reads from.
CREATE TEMP TABLE dust_pre ON COMMIT DROP AS
SELECT DISTINCT ON (s.key) s.key, split_part(s.key, ':', 2) AS rec, s.company_code, s.taken_at, s.value_hash, s.value
  FROM app_data_snapshots s
 WHERE s.company_code = 'FORCECORP'                           -- <== the only place to set the company code
   AND s.key IN (s.company_code || ':dust_settings', s.company_code || ':dust_lists')
   AND s.taken_at <= (SELECT COALESCE(min(r.taken_at), TIMESTAMPTZ '2026-10-02 09:45:00+00') FROM app_data_snapshots r
                          WHERE r.company_code = s.company_code
                            AND r.taken_at >= TIMESTAMPTZ '2026-10-02 09:45:00+00'
                            AND r.taken_at <  TIMESTAMPTZ '2026-10-02 10:45:00+00')   -- as the 2026-10-02 run found it
 ORDER BY s.key, s.taken_at DESC;
-- A copy saying the record was deleted holds no value: nothing to restore from it.
DELETE FROM dust_pre WHERE value_hash = 'deleted' OR jsonb_typeof(value) IS DISTINCT FROM 'object';
SELECT key, taken_at AS restoring_from_copy_taken_at FROM dust_pre ORDER BY key;

-- 2a. The UB Gallon Rate the page shows and bills with: GET serves dust_settings.ub_rate.
--     Only while it is still 0; a rate re-entered since is left alone.
UPDATE dust_settings d
   SET ub_rate = r.rate, updated_at = NOW()
  FROM (SELECT company_code,
               substring(value->>'ub_rate' from '^\s*([0-9]*\.?[0-9]+)')::numeric AS rate
          FROM dust_pre WHERE rec = 'dust_settings') r
 WHERE d.company_code = r.company_code
   AND d.ub_rate = 0
   AND r.rate > 0
RETURNING d.company_code, d.ub_rate AS restored_ub_rate;

-- 2b. The settings blob: ub_rate (only while 0) and profit_margin (only while
--     every numeric field is null, the page's own "empty" test). Other keys kept.
UPDATE app_data a
   SET value = a.value
             || CASE WHEN f.fix_rate THEN jsonb_build_object('ub_rate', f.pre_rate)    ELSE '{}' END
             || CASE WHEN f.fix_pm   THEN jsonb_build_object('profit_margin', f.pre_pm) ELSE '{}' END,
       updated_at = NOW()
  FROM (
    SELECT p.key, p.pre_rate, p.pre_pm,
           COALESCE(substring(c.value->>'ub_rate' from '^\s*([0-9]*\.?[0-9]+)')::numeric, 0) = 0
             AND p.pre_rate > 0 AS fix_rate,
           NOT EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(c.value->'profit_margin') = 'object'
                                                     THEN c.value->'profit_margin' ELSE '{}' END) e
                        WHERE e.key IN ('base_gal','base_rate','soap_gal','soap_rate','water_gal','water_rate','mix_parts','charge')
                          AND e.value <> 'null')
             AND EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(p.pre_pm) = 'object' THEN p.pre_pm ELSE '{}' END) e
                          WHERE e.key IN ('base_gal','base_rate','soap_gal','soap_rate','water_gal','water_rate','mix_parts','charge')
                            AND e.value <> 'null') AS fix_pm
      FROM (SELECT key,
                   substring(value->>'ub_rate' from '^\s*([0-9]*\.?[0-9]+)')::numeric AS pre_rate,
                   value->'profit_margin' AS pre_pm
              FROM dust_pre WHERE rec = 'dust_settings') p
      JOIN app_data c ON c.key = p.key
  ) f
 WHERE a.key = f.key
   AND jsonb_typeof(a.value) = 'object'
   AND (f.fix_rate OR f.fix_pm)
RETURNING a.key, a.value->'ub_rate' AS ub_rate, a.value->'profit_margin' AS profit_margin;

-- 2c. The lists blob: put employee_rates and cost_codes back INTO the live
--     record. Every other list in it is left as it is now.
--     employee_rates: the copy's rates, with any rate set since winning.
--     cost_codes: the copy's codes in their order (a code re-created since
--     keeps its new entry plus the copy's sub codes it lacks), then codes
--     added since. Codes match on `code`, as the page does; one with no
--     code (an older shape) on its id, so a re-run never adds it twice.
UPDATE app_data a
   SET value = jsonb_set(jsonb_set(a.value, '{employee_rates}', n.rates), '{cost_codes}', n.codes),
       updated_at = NOW()
  FROM (
    SELECT c.key,
           (CASE WHEN jsonb_typeof(p.value->'employee_rates') = 'object' THEN p.value->'employee_rates' ELSE '{}' END)
        || (CASE WHEN jsonb_typeof(c.value->'employee_rates') = 'object' THEN c.value->'employee_rates' ELSE '{}' END) AS rates,
           COALESCE((
             SELECT jsonb_agg(u.item ORDER BY u.grp, u.ord)
               FROM (
                 SELECT 0 AS grp, po.ord,
                        CASE WHEN cur.item IS NULL THEN po.item
                             -- Nothing to add leaves the code exactly as it is.
                             ELSE COALESCE(jsonb_set(cur.item, '{sub_codes}', cur.subs || (
                                    SELECT jsonb_agg(ps.sc ORDER BY ps.o)
                                      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(po.item->'sub_codes') = 'array'
                                                                     THEN po.item->'sub_codes' ELSE '[]' END) WITH ORDINALITY ps(sc, o)
                                     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cur.subs) cs(sc)
                                                        WHERE COALESCE(cs.sc->>'code', '#' || COALESCE(cs.sc->>'id', cs.sc::text))
                                                            = COALESCE(ps.sc->>'code', '#' || COALESCE(ps.sc->>'id', ps.sc::text))))), cur.item)
                        END AS item
                   FROM jsonb_array_elements(x.pc) WITH ORDINALITY po(item, ord)
                   LEFT JOIN LATERAL (
                     SELECT ce.item,
                            CASE WHEN jsonb_typeof(ce.item->'sub_codes') = 'array' THEN ce.item->'sub_codes' ELSE '[]' END AS subs
                       FROM jsonb_array_elements(x.cc) ce(item)
                      WHERE COALESCE(ce.item->>'code', '#' || COALESCE(ce.item->>'id', ce.item::text))
                          = COALESCE(po.item->>'code', '#' || COALESCE(po.item->>'id', po.item::text))
                      LIMIT 1) cur ON true
                 UNION ALL
                 SELECT 1, ce.ord, ce.item
                   FROM jsonb_array_elements(x.cc) WITH ORDINALITY ce(item, ord)
                  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(x.pc) pe(item)
                                     WHERE COALESCE(pe.item->>'code', '#' || COALESCE(pe.item->>'id', pe.item::text))
                                         = COALESCE(ce.item->>'code', '#' || COALESCE(ce.item->>'id', ce.item::text)))
               ) u), '[]') AS codes
      FROM dust_pre p
      JOIN app_data c ON c.key = p.key AND jsonb_typeof(c.value) = 'object'
     CROSS JOIN LATERAL (SELECT
             CASE WHEN jsonb_typeof(p.value->'cost_codes') = 'array' THEN p.value->'cost_codes' ELSE '[]' END AS pc,
             CASE WHEN jsonb_typeof(c.value->'cost_codes') = 'array' THEN c.value->'cost_codes' ELSE '[]' END AS cc) x
     WHERE p.rec = 'dust_lists'
  ) n
 WHERE a.key = n.key
   AND (a.value->'employee_rates' IS DISTINCT FROM n.rates OR a.value->'cost_codes' IS DISTINCT FROM n.codes)
RETURNING a.key, a.value->'employee_rates' AS employee_rates, a.value->'cost_codes' AS cost_codes;

-- 2d. A list of ONE employee, material, state or MU that the blank save
--     deleted (see (1c)): put the entry back, only while the list is still
--     empty. GET serves the table's values, and the page's next save writes
--     them into the lists record too.
INSERT INTO dropdown_lists (company_code, list_name, value, sort_order)
SELECT p.company_code, l.list_name, e.v, 0
  FROM dust_pre p
 CROSS JOIN (VALUES ('employees','dust_employees'), ('materials','dust_materials'),
                    ('states','dust_states'), ('mu','dust_mu')) l(list, list_name)
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.value->l.list) = 'array'
                                                   THEN p.value->l.list ELSE '[]' END) e(v)
 WHERE p.rec = 'dust_lists'
   AND jsonb_array_length(CASE WHEN jsonb_typeof(p.value->l.list) = 'array' THEN p.value->l.list ELSE '[]' END) = 1
   AND e.v <> ''
   AND NOT EXISTS (SELECT 1 FROM dropdown_lists d WHERE d.company_code = p.company_code AND d.list_name = l.list_name)
ON CONFLICT (company_code, list_name, value) DO NOTHING
RETURNING company_code, list_name, value AS restored_lone_entry;

-- Check: what GET /api/dust-config will now serve for these fields.
SELECT d.company_code,
       d.ub_rate                    AS ub_rate_served,
       s.value->'profit_margin'     AS profit_margin_served,
       l.value->'employee_rates'    AS employee_rates_served,
       jsonb_array_length(CASE WHEN jsonb_typeof(l.value->'cost_codes') = 'array' THEN l.value->'cost_codes' ELSE '[]' END) AS cost_codes_served
  FROM dust_settings d
  LEFT JOIN app_data s ON s.key = d.company_code || ':dust_settings'
  LEFT JOIN app_data l ON l.key = d.company_code || ':dust_lists'
 WHERE d.company_code IN (SELECT company_code FROM dust_pre);

ROLLBACK;   -- <== change to COMMIT; once the rows above are right
