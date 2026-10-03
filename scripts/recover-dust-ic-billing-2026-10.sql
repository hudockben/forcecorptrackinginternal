-- =====================================================================
-- Intercompany billing recovery: dust entries lost while the Dust page
-- priced UB gallons at $0 (blank dust-config save between the 2026-10-02
-- and 2026-10-03 09:45 UTC DataWatch runs). Neon SQL editor, Primary branch.
--
-- What went wrong. Every Dust page load and save reconciles each dust row
-- into <CO>:fct_intercompany_billing_entries (dust.html _reconcileDustBilling).
-- While the global UB rate read $0, for customers with no UB $/gal override:
--   * A row WITH vehicle charges had its entry REWRITTEN: ub_total 0, total =
--     vehicle charges only. Its id, sent_at and invoice/payment dates were
--     kept. Once the rate is back, opening the Dust page rewrites the figures
--     again, so this file leaves those entries alone.
--   * A UB-only row came to a $0 total, and the page deletes the entry of a
--     $0 row ("voids" it). The entry's id, its sent_at and the
--     invoice/payment dates entered in Intercompany went with it. Once the
--     rate is back the page creates a NEW entry: new id, sent_at = now, no
--     dates. That part never fixes itself. This file puts the original
--     entry back.
--
-- ORDER. Each step assumes the ones before it.
--   1. Deploy the dust-config fix. With it, a Dust tab whose config never
--      loaded can no longer save $0. It also can no longer sync Intercompany
--      at $0, which would void the entries this file restores, and a tab that
--      loaded the stored $0 leaves an entry that billed UB as it is.
--   2. Close every Dust tab AND every Intercompany tab, on every device.
--      - A Dust tab opened since the blank save still holds $0. Its next
--        save, or just closing or hiding it, writes $0 again, and its next
--        sync voids the entries this file restores.
--      - The Intercompany page saves the whole billing record from its own
--        copy, without the version check the Dust and Trucking pages use
--        (setIcInvDate, deleteIcEntry, and the de-duplicate write in
--        loadBillingEntries). An open tab could save its pre-restore copy
--        over this restore before its 60s poll picks it up.
--   3. Run recover-dust-config-2026-10.sql (UB rate, profit margin, lists) and COMMIT it.
--      The rate MUST be back before RESTORE is committed. Otherwise a Dust
--      page from before the fix, still open somewhere, voids the restored
--      UB-only entries again at $0.
--      RESTORE checks this itself: while dust_settings.ub_rate is still 0
--      it marks every row "wait" and changes nothing.
--   4. Run (1) LOOK, then (2) RESTORE. RESTORE ends in ROLLBACK. Read its
--      output, change the last line to COMMIT, and run it again.
--      If someone opened the Dust page between steps 3 and 4, the page has
--      already re-created the UB-only entries under new ids. RESTORE handles
--      that case too.
--   5. Open the Dust page once, on the new code. That re-syncs the figures:
--      - the rewritten entries get their ub_total and total back;
--      - the restored entries' dust-side fields catch up with any edit made
--        to their rows since 2026-10-02.
--      The page keeps each entry's id, sent_at and Intercompany dates while
--      doing it. Its save also rebuilds the intercompany_billing_entries
--      table (see (3)).
--   6. Run (4) CHECK. Then Intercompany can be opened again.
--
-- Cutoffs. pre: the billing record as the 2026-10-02 run found it, its
-- newest copy at or before that run's stamp: the company's first copy from
-- 09:45 to 10:45 that day, whatever second the run started (a start after
-- 09:46 fell past the old "< 09:46" cutoff), else 09:45:00 (nothing of the
-- company changed since its last copy, or the run failed). Never a run made
-- by hand later that day, after the blank save: for a company the 10-02
-- run copied nothing of, that run's copy was the first of the day, and LOOK
-- listed nothing. was reads every copy from pre's up to
-- "< 2026-10-04 00:00", i.e. through the 2026-10-03 run. Keep pre the same
-- as recover-dust-config-2026-10.sql's.
-- =====================================================================


-- ==== (1) LOOK, read-only ============================================
-- One row per dust row whose entry, in the newest pre-cutoff copy of the
-- billing record or a later copy through the 2026-10-03 run, is no longer
-- in the live record under the same id.
--
--   damage    missing   = no entry for the row now (voided by the Dust
--                         page, or deleted on the Intercompany page).
--             recreated = the Dust page created a new one (different id).
--   status    restore   = (2) will put the entry back.
--             skip: removed in Intercompany = someone deleted it on the
--               Intercompany page (fct_intercompany_removed_entries).
--               Restoring it would undo that delete.
--             skip: dust row deleted = the row is gone from the Dust page
--               (payroll un-approved it, or someone deleted it). Restoring
--               would bill work the page no longer has.
--             skip: job now billed by entry X = another row's entry now has
--               the same date|customer|location|truck. Intercompany keeps
--               one entry per job (the latest sent_at) and deletes the other
--               when it next loads, so a restored entry would not last.
--             skip: job restored as entry X = the same, for two entries this
--               file would restore: they come from different copies, which
--               each billed the job once. The one from the earliest copy
--               (the original) is restored.
--             wait: the UB rate is still 0. Run recover-dust-config-2026-10.sql first.
--   For a skipped row, ic_fields_restored is what was lost; enter those
--   dates by hand if they still apply.
--   ic_fields_now lists dates already entered on a re-created entry. For a
--   field in both, the original's value wins and the new one is dropped;
--   a field only on the re-created entry is kept.
WITH owned AS (
  -- The fields the Dust page writes on every sync. Anything else on a dust
  -- entry was put there by Intercompany (invoice_sent_date and
  -- payment_received_date today), and the page carries it over untouched.
  SELECT ARRAY['id','source','source_id','company_id','company_name','actual_date',
               'actual_start','actual_end','total_hours','total','company_man','location',
               'vehicle1','v1_unit','v1_rate','v1_total','vehicle2','v2_unit','v2_rate','v2_total',
               'gallons_ub','ub_total','inv_number','inv_status','sent_at','sent_by'] AS k
),
pre AS (
  -- Each company's billing record as the 2026-10-02 run found it.
  SELECT DISTINCT ON (s.key) s.key, s.company_code, s.taken_at, s.value_hash, s.value
    FROM app_data_snapshots s
   WHERE s.key = s.company_code || ':fct_intercompany_billing_entries'
     AND s.taken_at <= (SELECT COALESCE(min(r.taken_at), TIMESTAMPTZ '2026-10-02 09:45:00+00') FROM app_data_snapshots r
                         WHERE r.company_code = s.company_code
                           AND r.taken_at >= TIMESTAMPTZ '2026-10-02 09:45:00+00'
                           AND r.taken_at <  TIMESTAMPTZ '2026-10-02 10:45:00+00')
   ORDER BY s.key, s.taken_at DESC
),
was AS MATERIALIZED (
  -- Its dust entries, one per dust row: the one Intercompany keeps when a row
  -- has two (latest sent_at, first on a tie). ord is its place in that copy.
  -- A copy saying the record was deleted holds nothing to restore, so an
  -- older copy is NOT used in its place.
  -- Read from every copy from that one through the 2026-10-03 run, keeping
  -- each row's EARLIEST entry (its original id): an entry created after the
  -- 2026-10-02 run and voided after the 2026-10-03 run is only in the
  -- latter. taken_at is the copy it came from, which places it in (2).
  SELECT DISTINCT ON (p.key, e.v->>'source_id')
         p.key, p.company_code, s.taken_at, e.ord, e.v,
         e.v->>'source_id' AS sid, COALESCE(e.v->>'id', '') AS id
    FROM pre p
    JOIN app_data_snapshots s ON s.key = p.key AND s.taken_at >= p.taken_at
                             AND s.taken_at < TIMESTAMPTZ '2026-10-04 00:00:00+00'
                             AND s.value_hash <> 'deleted'
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]' END)
         WITH ORDINALITY e(v, ord)
   WHERE p.value_hash <> 'deleted'
     AND e.v->>'source' = 'dust'
     AND COALESCE(e.v->>'source_id', '') <> ''
   ORDER BY p.key, e.v->>'source_id', s.taken_at, e.v->>'sent_at' DESC NULLS LAST, e.ord
),
live AS MATERIALIZED (
  SELECT a.key, e.ord, e.v,
         e.v->>'source' AS src, e.v->>'source_id' AS sid, COALESCE(e.v->>'id', '') AS id,
         lower(COALESCE(e.v->>'actual_date', '') || '|' || COALESCE(e.v->>'company_name', '') || '|' ||
               COALESCE(e.v->>'location', '')    || '|' || COALESCE(e.v->>'vehicle1', '')) AS job
    FROM app_data a
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.value) = 'array' THEN a.value ELSE '[]' END)
         WITH ORDINALITY e(v, ord)
   WHERE a.key IN (SELECT key FROM pre)
),
-- The lookups below go through one jsonb object per record rather than
-- joins: the planner cannot size these sets, picks nested loops, and on a
-- record of a few thousand entries a join here runs for minutes.
idx AS MATERIALIZED (
  SELECT p.key,
         (SELECT jsonb_object_agg(l.sid || '|' || l.id, true)
            FROM live l WHERE l.key = p.key AND l.src = 'dust' AND l.sid IS NOT NULL) AS present,
         -- Manual rows' entries by physical job, in record order. Payroll-
         -- injected rows (tsd-) are told apart by row id alone on both pages,
         -- so they never clash.
         (SELECT jsonb_object_agg(z.job, z.hits)
            FROM (SELECT l.job, jsonb_agg(jsonb_build_array(l.sid, l.id) ORDER BY l.ord) AS hits
                    FROM live l
                   WHERE l.key = p.key AND l.src = 'dust' AND l.sid IS NOT NULL AND l.sid NOT LIKE 'tsd-%'
                   GROUP BY l.job) z) AS jobs
    FROM pre p
),
gone AS MATERIALIZED (
  -- The rows whose entry is no longer in the record under the same id.
  SELECT w.* FROM was w JOIN idx ON idx.key = w.key
   WHERE NOT COALESCE(idx.present ? (w.sid || '|' || w.id), false)
),
gone_ids AS MATERIALIZED (
  SELECT key, jsonb_object_agg(sid, id) AS ids FROM gone GROUP BY key
),
cur AS MATERIALIZED (
  -- What the record holds for each of those rows now (Intercompany's pick
  -- when it holds two), if anything.
  SELECT DISTINCT ON (l.key, l.sid) l.key, l.sid, l.v
    FROM live l JOIN gone_ids g ON g.key = l.key
   WHERE l.src = 'dust' AND g.ids ? l.sid
   ORDER BY l.key, l.sid, l.v->>'sent_at' DESC NULLS LAST, l.ord
),
later AS MATERIALIZED (
  -- The newest nightly copy of each of those entries (same row, same id). A
  -- run after the cutoff may have caught dates entered on it before it was
  -- voided.
  SELECT DISTINCT ON (s.key, e.v->>'source_id') s.key, e.v->>'source_id' AS sid, s.taken_at, e.v
    FROM pre p
    JOIN gone_ids g ON g.key = p.key
    JOIN app_data_snapshots s ON s.key = p.key AND s.taken_at > p.taken_at AND s.value_hash <> 'deleted'
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]' END) e(v)
   WHERE e.v->>'source' = 'dust' AND g.ids ->> (e.v->>'source_id') = e.v->>'id'
   ORDER BY s.key, e.v->>'source_id', s.taken_at DESC
),
removed AS (
  -- Entries deleted on the Intercompany page. The Dust page never re-creates
  -- these, and neither does this file.
  SELECT DISTINCT ON (r.key, t->>'source_id')
         split_part(r.key, ':', 1) AS company_code, t->>'source_id' AS sid, t->>'removed_at' AS removed_at
    FROM app_data r
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.value) = 'array' THEN r.value ELSE '[]' END) t
   WHERE r.key IN (SELECT company_code || ':fct_intercompany_removed_entries' FROM pre)
     AND COALESCE(t->>'source', '') = 'dust'
   ORDER BY r.key, t->>'source_id', t->>'removed_at'
),
res AS (
  SELECT w.company_code,
         CASE WHEN rm.sid IS NOT NULL THEN 'skip: removed in Intercompany ' || COALESCE(rm.removed_at, '')
              WHEN d.id IS NULL       THEN 'skip: dust row deleted'
              WHEN jk.id IS NOT NULL  THEN 'skip: job now billed by entry ' || jk.id || ' (dust row ' || jk.sid || ')'
              WHEN COALESCE(ds.ub_rate, 0) <= 0 THEN 'wait: UB rate still 0, run recover-dust-config-2026-10.sql first'
              ELSE 'restore' END                            AS status,
         CASE WHEN c.v IS NULL THEN 'missing' ELSE 'recreated' END AS damage,
         w.sid                                              AS dust_row_id,
         w.v->>'company_name'                               AS customer,
         w.v->>'actual_date'                                AS job_date,
         w.v->>'gallons_ub'                                 AS gallons_ub,
         w.v->>'ub_total'                                   AS ub_total_before,
         w.v->>'total'                                      AS total_before,
         w.id                                               AS id_before,
         c.v->>'id'                                         AS id_now,
         w.v->>'sent_at'                                    AS sent_at_before,
         c.v->>'sent_at'                                    AS sent_at_now,
         ic.restored                                        AS ic_fields_restored,
         ic.now                                             AS ic_fields_now,
         COALESCE(lt.taken_at, w.taken_at)                  AS copy_taken_at,
         d.gallons_ub                                       AS row_gallons_now,
         ds.ub_rate                                         AS ub_rate_now,
         m.entry                                            AS restored_entry,
         w.key, w.taken_at AS pre_taken_at, w.ord AS pre_ord, ic.job
    FROM gone w
    JOIN idx ON idx.key = w.key
    CROSS JOIN owned o
    LEFT JOIN later lt   ON lt.key = w.key AND lt.sid = w.sid
    LEFT JOIN cur c      ON c.key = w.key AND c.sid = w.sid
    LEFT JOIN removed rm ON rm.company_code = w.company_code AND rm.sid = w.sid
    LEFT JOIN dust_control_entries d ON d.id = w.sid AND d.company_code = w.company_code
    LEFT JOIN dust_settings ds ON ds.company_code = w.company_code
    -- The entry to write back: the copy, plus any Intercompany field that only
    -- the re-created entry has (a date entered on it since).
    CROSS JOIN LATERAL (
      SELECT COALESCE(lt.v, w.v) || COALESCE((
               SELECT jsonb_object_agg(f.key, f.value)
                 FROM jsonb_each(CASE WHEN jsonb_typeof(c.v) = 'object' THEN c.v ELSE '{}' END) f
                WHERE f.key <> ALL (o.k)
                  AND f.value NOT IN ('null'::jsonb, '""'::jsonb)
                  AND COALESCE(COALESCE(lt.v, w.v)->f.key, 'null'::jsonb) IN ('null'::jsonb, '""'::jsonb)
             ), '{}'::jsonb) AS entry
    ) m
    CROSS JOIN LATERAL (
      SELECT (SELECT jsonb_object_agg(f.key, f.value) FROM jsonb_each(m.entry) f
               WHERE f.key <> ALL (o.k) AND f.value NOT IN ('null'::jsonb, '""'::jsonb)) AS restored,
             (SELECT jsonb_object_agg(f.key, f.value)
                FROM jsonb_each(CASE WHEN jsonb_typeof(c.v) = 'object' THEN c.v ELSE '{}' END) f
               WHERE f.key <> ALL (o.k) AND f.value NOT IN ('null'::jsonb, '""'::jsonb)) AS now,
             lower(COALESCE(m.entry->>'actual_date', '') || '|' || COALESCE(m.entry->>'company_name', '') || '|' ||
                   COALESCE(m.entry->>'location', '')    || '|' || COALESCE(m.entry->>'vehicle1', '')) AS job
    ) ic
    -- Another manual row's entry on the same physical job.
    LEFT JOIN LATERAL (
      SELECT h->>1 AS id, h->>0 AS sid
        FROM jsonb_array_elements(idx.jobs -> ic.job) WITH ORDINALITY x(h, n)
       WHERE h->>0 <> w.sid AND w.sid NOT LIKE 'tsd-%'
       ORDER BY x.n
       LIMIT 1
    ) jk ON true
)
-- One restored entry per manual physical job. Entries come from more than
-- one copy, so two rows can each have billed the same job at a different
-- time; restoring both would leave Intercompany to delete the original.
SELECT r.company_code,
       CASE WHEN r.status = 'restore' AND dup.id_before IS NOT NULL
            THEN 'skip: job restored as entry ' || dup.id_before || ' (dust row ' || dup.dust_row_id || ')'
            ELSE r.status END AS status,
       r.damage, r.dust_row_id, r.customer, r.job_date, r.gallons_ub, r.ub_total_before, r.total_before,
       r.id_before, r.id_now, r.sent_at_before, r.sent_at_now, r.ic_fields_restored, r.ic_fields_now,
       r.copy_taken_at, r.row_gallons_now, r.ub_rate_now, r.restored_entry,
       r.key, r.pre_taken_at, r.pre_ord
  FROM res r
  LEFT JOIN LATERAL (
    SELECT y.id_before, y.dust_row_id
      FROM res y
     WHERE y.status = 'restore' AND y.key = r.key AND y.job = r.job AND y.dust_row_id <> r.dust_row_id
       AND y.dust_row_id NOT LIKE 'tsd-%' AND r.dust_row_id NOT LIKE 'tsd-%'
       AND (y.pre_taken_at, y.pre_ord) < (r.pre_taken_at, r.pre_ord)
     ORDER BY y.pre_taken_at, y.pre_ord
     LIMIT 1
  ) dup ON true
 ORDER BY r.company_code, (CASE WHEN r.status LIKE 'skip:%' OR dup.id_before IS NOT NULL THEN 1 ELSE 0 END),
          r.job_date, r.dust_row_id;


-- ==== (2) RESTORE ====================================================
-- Run the whole block as ONE execution. It ends in ROLLBACK: read what it
-- returns, then change the last line to COMMIT and run it again. Running it
-- again after the COMMIT changes nothing; the restored entries have their
-- ids back, so (1) no longer lists them as damaged.
-- For every "restore" row of (1), it removes whatever entry the record holds
-- for that dust row now, and puts the original back where it sat in the
-- copy it came from, just ahead of the entry that followed it there.
-- updated_at moves, so a Dust or Trucking tab still holding the old version
-- gets a conflict on its next save and re-reads, instead of saving over this.
BEGIN;

CREATE TEMP TABLE ic_co ON COMMIT DROP AS
SELECT unnest(ARRAY['FORCECORP']) AS company_code;          -- <== the only place to set the company code(s)

-- Hold the billing records until COMMIT, so no save from the app can land
-- between reading them and writing them back.
SELECT a.key, a.updated_at AS billing_updated_at_before
  FROM app_data a
  JOIN ic_co c ON a.key = c.company_code || ':fct_intercompany_billing_entries'
   FOR UPDATE OF a;

-- The same query as (1), for the companies above.
CREATE TEMP TABLE ic_fix ON COMMIT DROP AS
WITH owned AS (
  -- The fields the Dust page writes on every sync. Anything else on a dust
  -- entry was put there by Intercompany (invoice_sent_date and
  -- payment_received_date today), and the page carries it over untouched.
  SELECT ARRAY['id','source','source_id','company_id','company_name','actual_date',
               'actual_start','actual_end','total_hours','total','company_man','location',
               'vehicle1','v1_unit','v1_rate','v1_total','vehicle2','v2_unit','v2_rate','v2_total',
               'gallons_ub','ub_total','inv_number','inv_status','sent_at','sent_by'] AS k
),
pre AS (
  -- Each company's billing record as the 2026-10-02 run found it.
  SELECT DISTINCT ON (s.key) s.key, s.company_code, s.taken_at, s.value_hash, s.value
    FROM app_data_snapshots s
   WHERE s.key = s.company_code || ':fct_intercompany_billing_entries'
     AND s.company_code IN (SELECT company_code FROM ic_co)
     AND s.taken_at <= (SELECT COALESCE(min(r.taken_at), TIMESTAMPTZ '2026-10-02 09:45:00+00') FROM app_data_snapshots r
                         WHERE r.company_code = s.company_code
                           AND r.taken_at >= TIMESTAMPTZ '2026-10-02 09:45:00+00'
                           AND r.taken_at <  TIMESTAMPTZ '2026-10-02 10:45:00+00')
   ORDER BY s.key, s.taken_at DESC
),
was AS MATERIALIZED (
  -- Its dust entries, one per dust row: the one Intercompany keeps when a row
  -- has two (latest sent_at, first on a tie). ord is its place in that copy.
  -- A copy saying the record was deleted holds nothing to restore, so an
  -- older copy is NOT used in its place.
  -- Read from every copy from that one through the 2026-10-03 run, keeping
  -- each row's EARLIEST entry (its original id): an entry created after the
  -- 2026-10-02 run and voided after the 2026-10-03 run is only in the
  -- latter. taken_at is the copy it came from, which places it in (2).
  SELECT DISTINCT ON (p.key, e.v->>'source_id')
         p.key, p.company_code, s.taken_at, e.ord, e.v,
         e.v->>'source_id' AS sid, COALESCE(e.v->>'id', '') AS id
    FROM pre p
    JOIN app_data_snapshots s ON s.key = p.key AND s.taken_at >= p.taken_at
                             AND s.taken_at < TIMESTAMPTZ '2026-10-04 00:00:00+00'
                             AND s.value_hash <> 'deleted'
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]' END)
         WITH ORDINALITY e(v, ord)
   WHERE p.value_hash <> 'deleted'
     AND e.v->>'source' = 'dust'
     AND COALESCE(e.v->>'source_id', '') <> ''
   ORDER BY p.key, e.v->>'source_id', s.taken_at, e.v->>'sent_at' DESC NULLS LAST, e.ord
),
live AS MATERIALIZED (
  SELECT a.key, e.ord, e.v,
         e.v->>'source' AS src, e.v->>'source_id' AS sid, COALESCE(e.v->>'id', '') AS id,
         lower(COALESCE(e.v->>'actual_date', '') || '|' || COALESCE(e.v->>'company_name', '') || '|' ||
               COALESCE(e.v->>'location', '')    || '|' || COALESCE(e.v->>'vehicle1', '')) AS job
    FROM app_data a
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.value) = 'array' THEN a.value ELSE '[]' END)
         WITH ORDINALITY e(v, ord)
   WHERE a.key IN (SELECT key FROM pre)
),
-- The lookups below go through one jsonb object per record rather than
-- joins: the planner cannot size these sets, picks nested loops, and on a
-- record of a few thousand entries a join here runs for minutes.
idx AS MATERIALIZED (
  SELECT p.key,
         (SELECT jsonb_object_agg(l.sid || '|' || l.id, true)
            FROM live l WHERE l.key = p.key AND l.src = 'dust' AND l.sid IS NOT NULL) AS present,
         -- Manual rows' entries by physical job, in record order. Payroll-
         -- injected rows (tsd-) are told apart by row id alone on both pages,
         -- so they never clash.
         (SELECT jsonb_object_agg(z.job, z.hits)
            FROM (SELECT l.job, jsonb_agg(jsonb_build_array(l.sid, l.id) ORDER BY l.ord) AS hits
                    FROM live l
                   WHERE l.key = p.key AND l.src = 'dust' AND l.sid IS NOT NULL AND l.sid NOT LIKE 'tsd-%'
                   GROUP BY l.job) z) AS jobs
    FROM pre p
),
gone AS MATERIALIZED (
  -- The rows whose entry is no longer in the record under the same id.
  SELECT w.* FROM was w JOIN idx ON idx.key = w.key
   WHERE NOT COALESCE(idx.present ? (w.sid || '|' || w.id), false)
),
gone_ids AS MATERIALIZED (
  SELECT key, jsonb_object_agg(sid, id) AS ids FROM gone GROUP BY key
),
cur AS MATERIALIZED (
  -- What the record holds for each of those rows now (Intercompany's pick
  -- when it holds two), if anything.
  SELECT DISTINCT ON (l.key, l.sid) l.key, l.sid, l.v
    FROM live l JOIN gone_ids g ON g.key = l.key
   WHERE l.src = 'dust' AND g.ids ? l.sid
   ORDER BY l.key, l.sid, l.v->>'sent_at' DESC NULLS LAST, l.ord
),
later AS MATERIALIZED (
  -- The newest nightly copy of each of those entries (same row, same id). A
  -- run after the cutoff may have caught dates entered on it before it was
  -- voided.
  SELECT DISTINCT ON (s.key, e.v->>'source_id') s.key, e.v->>'source_id' AS sid, s.taken_at, e.v
    FROM pre p
    JOIN gone_ids g ON g.key = p.key
    JOIN app_data_snapshots s ON s.key = p.key AND s.taken_at > p.taken_at AND s.value_hash <> 'deleted'
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]' END) e(v)
   WHERE e.v->>'source' = 'dust' AND g.ids ->> (e.v->>'source_id') = e.v->>'id'
   ORDER BY s.key, e.v->>'source_id', s.taken_at DESC
),
removed AS (
  -- Entries deleted on the Intercompany page. The Dust page never re-creates
  -- these, and neither does this file.
  SELECT DISTINCT ON (r.key, t->>'source_id')
         split_part(r.key, ':', 1) AS company_code, t->>'source_id' AS sid, t->>'removed_at' AS removed_at
    FROM app_data r
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.value) = 'array' THEN r.value ELSE '[]' END) t
   WHERE r.key IN (SELECT company_code || ':fct_intercompany_removed_entries' FROM pre)
     AND COALESCE(t->>'source', '') = 'dust'
   ORDER BY r.key, t->>'source_id', t->>'removed_at'
)
SELECT w.company_code,
       CASE WHEN rm.sid IS NOT NULL THEN 'skip: removed in Intercompany ' || COALESCE(rm.removed_at, '')
            WHEN d.id IS NULL       THEN 'skip: dust row deleted'
            WHEN jk.id IS NOT NULL  THEN 'skip: job now billed by entry ' || jk.id || ' (dust row ' || jk.sid || ')'
            WHEN COALESCE(ds.ub_rate, 0) <= 0 THEN 'wait: UB rate still 0, run recover-dust-config-2026-10.sql first'
            ELSE 'restore' END                            AS status,
       CASE WHEN c.v IS NULL THEN 'missing' ELSE 'recreated' END AS damage,
       w.sid                                              AS dust_row_id,
       w.v->>'company_name'                               AS customer,
       w.v->>'actual_date'                                AS job_date,
       w.v->>'gallons_ub'                                 AS gallons_ub,
       w.v->>'ub_total'                                   AS ub_total_before,
       w.v->>'total'                                      AS total_before,
       w.id                                               AS id_before,
       c.v->>'id'                                         AS id_now,
       w.v->>'sent_at'                                    AS sent_at_before,
       c.v->>'sent_at'                                    AS sent_at_now,
       ic.restored                                        AS ic_fields_restored,
       ic.now                                             AS ic_fields_now,
       COALESCE(lt.taken_at, w.taken_at)                  AS copy_taken_at,
       d.gallons_ub                                       AS row_gallons_now,
       ds.ub_rate                                         AS ub_rate_now,
       m.entry                                            AS restored_entry,
       w.key, w.taken_at AS pre_taken_at, w.ord AS pre_ord, ic.job
  FROM gone w
  JOIN idx ON idx.key = w.key
  CROSS JOIN owned o
  LEFT JOIN later lt   ON lt.key = w.key AND lt.sid = w.sid
  LEFT JOIN cur c      ON c.key = w.key AND c.sid = w.sid
  LEFT JOIN removed rm ON rm.company_code = w.company_code AND rm.sid = w.sid
  LEFT JOIN dust_control_entries d ON d.id = w.sid AND d.company_code = w.company_code
  LEFT JOIN dust_settings ds ON ds.company_code = w.company_code
  -- The entry to write back: the copy, plus any Intercompany field that only
  -- the re-created entry has (a date entered on it since).
  CROSS JOIN LATERAL (
    SELECT COALESCE(lt.v, w.v) || COALESCE((
             SELECT jsonb_object_agg(f.key, f.value)
               FROM jsonb_each(CASE WHEN jsonb_typeof(c.v) = 'object' THEN c.v ELSE '{}' END) f
              WHERE f.key <> ALL (o.k)
                AND f.value NOT IN ('null'::jsonb, '""'::jsonb)
                AND COALESCE(COALESCE(lt.v, w.v)->f.key, 'null'::jsonb) IN ('null'::jsonb, '""'::jsonb)
           ), '{}'::jsonb) AS entry
  ) m
  CROSS JOIN LATERAL (
    SELECT (SELECT jsonb_object_agg(f.key, f.value) FROM jsonb_each(m.entry) f
             WHERE f.key <> ALL (o.k) AND f.value NOT IN ('null'::jsonb, '""'::jsonb)) AS restored,
           (SELECT jsonb_object_agg(f.key, f.value)
              FROM jsonb_each(CASE WHEN jsonb_typeof(c.v) = 'object' THEN c.v ELSE '{}' END) f
             WHERE f.key <> ALL (o.k) AND f.value NOT IN ('null'::jsonb, '""'::jsonb)) AS now,
           lower(COALESCE(m.entry->>'actual_date', '') || '|' || COALESCE(m.entry->>'company_name', '') || '|' ||
                 COALESCE(m.entry->>'location', '')    || '|' || COALESCE(m.entry->>'vehicle1', '')) AS job
  ) ic
  -- Another manual row's entry on the same physical job.
  LEFT JOIN LATERAL (
    SELECT h->>1 AS id, h->>0 AS sid
      FROM jsonb_array_elements(idx.jobs -> ic.job) WITH ORDINALITY x(h, n)
     WHERE h->>0 <> w.sid AND w.sid NOT LIKE 'tsd-%'
     ORDER BY x.n
     LIMIT 1
  ) jk ON true;

-- One restored entry per manual physical job, as in (1): of two entries
-- from different copies on the same job, the one from the earliest copy.
UPDATE ic_fix x
   SET status = 'skip: job restored as entry ' || y.id_before || ' (dust row ' || y.dust_row_id || ')'
  FROM (SELECT DISTINCT ON (r.key, r.dust_row_id) r.key AS of_key, r.dust_row_id AS of_row, y.id_before, y.dust_row_id
          FROM ic_fix r
          JOIN ic_fix y ON y.status = 'restore' AND y.key = r.key AND y.job = r.job AND y.dust_row_id <> r.dust_row_id
                       AND y.dust_row_id NOT LIKE 'tsd-%' AND r.dust_row_id NOT LIKE 'tsd-%'
                       AND (y.pre_taken_at, y.pre_ord) < (r.pre_taken_at, r.pre_ord)
         WHERE r.status = 'restore'
         ORDER BY r.key, r.dust_row_id, y.pre_taken_at, y.pre_ord) y
 WHERE x.key = y.of_key AND x.dust_row_id = y.of_row AND x.status = 'restore';

-- What this run will do. Only "restore" rows are written.
SELECT company_code, status, damage, dust_row_id, customer, job_date, id_before, id_now,
       ic_fields_restored, ic_fields_now, copy_taken_at
  FROM ic_fix
 ORDER BY company_code, (status = 'restore') DESC, job_date, dust_row_id;

-- The write. Every entry not being restored stays exactly as it is and
-- where it is. That covers other divisions, other dust rows and the
-- rewritten $0 entries.
WITH fix AS MATERIALIZED (
  SELECT key, dust_row_id, restored_entry, pre_taken_at, pre_ord FROM ic_fix WHERE status = 'restore'
),
live AS MATERIALIZED (
  SELECT a.key, e.ord, e.v, e.v->>'source' AS src, e.v->>'source_id' AS sid, e.v->>'id' AS id
    FROM app_data a
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.value) = 'array' THEN a.value ELSE '[]' END)
         WITH ORDINALITY e(v, ord)
   WHERE a.key IN (SELECT key FROM fix)
),
kept AS MATERIALIZED (
  -- Everything except the current entry of a row being restored (the one
  -- created again under a new id).
  SELECT l.key, l.ord, l.v, l.id
    FROM live l
   WHERE (l.src = 'dust' AND (l.key, l.sid) IN (SELECT key, dust_row_id FROM fix)) IS NOT TRUE
),
kept_pos AS MATERIALIZED (
  -- Where each entry still in the record sits, by id.
  SELECT key, jsonb_object_agg(id, ord) AS pos
    FROM (SELECT DISTINCT ON (key, id) key, id, ord FROM kept WHERE id IS NOT NULL ORDER BY key, id, ord) z
   GROUP BY key
),
pre_pos AS MATERIALIZED (
  -- Each entry of the copies the restored ones came from that is still in
  -- the record, and where.
  SELECT s.key, s.taken_at AS pre_taken_at, p.ord AS pre_ord, (kp.pos ->> (p.v->>'id'))::bigint AS pos
    FROM (SELECT DISTINCT key, pre_taken_at FROM fix) f
    JOIN app_data_snapshots s ON s.key = f.key AND s.taken_at = f.pre_taken_at
    JOIN kept_pos kp ON kp.key = s.key
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]' END)
         WITH ORDINALITY p(v, ord)
   WHERE kp.pos ? (p.v->>'id')
),
placed AS (
  SELECT k.key, k.v, k.ord AS pos, 1 AS grp, NULL::timestamptz AS taken, 0::bigint AS sub
    FROM kept k
  UNION ALL
  -- A restored entry goes just ahead of the first entry that followed it in
  -- the copy it came from and is still there. With none left, it goes last.
  -- Restored entries landing on the same spot keep their copy's order; one
  -- from a newer copy goes first, as the page adds new entries at the front.
  SELECT x.key, x.restored_entry,
         COALESCE((SELECT pp.pos FROM pre_pos pp
                    WHERE pp.key = x.key AND pp.pre_taken_at = x.pre_taken_at AND pp.pre_ord > x.pre_ord
                    ORDER BY pp.pre_ord LIMIT 1), 9223372036854775807),
         0, x.pre_taken_at, x.pre_ord
    FROM fix x
)
UPDATE app_data a
   SET value = n.value, updated_at = NOW()
  FROM (SELECT key, jsonb_agg(v ORDER BY pos, grp, taken DESC NULLS LAST, sub) AS value FROM placed GROUP BY key) n
 WHERE a.key = n.key
RETURNING a.key, jsonb_array_length(a.value) AS entries_now,
          (SELECT count(*) FROM ic_fix x WHERE x.key = a.key AND x.status = 'restore') AS restored,
          a.updated_at AS billing_updated_at_after;

-- Check before COMMIT: each restored row has exactly one entry, under its
-- original id. Expect 1 and 1 on every line.
SELECT x.company_code, x.dust_row_id, x.id_before,
       count(l.id) FILTER (WHERE l.id = x.id_before) AS entries_with_original_id,
       count(l.id)                                   AS entries_for_row
  FROM ic_fix x
  LEFT JOIN (SELECT a.key, e.v->>'source_id' AS sid, COALESCE(e.v->>'id', '') AS id
               FROM app_data a
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.value) = 'array' THEN a.value ELSE '[]' END) e(v)
              WHERE a.key IN (SELECT key FROM ic_fix WHERE status = 'restore')
                AND e.v->>'source' = 'dust') l
         ON l.key = x.key AND l.sid = x.dust_row_id
 WHERE x.status = 'restore'
 GROUP BY x.company_code, x.dust_row_id, x.id_before
 ORDER BY x.company_code, x.dust_row_id;

ROLLBACK;   -- <== change to COMMIT; once the rows above are right


-- ==== (3) The intercompany_billing_entries table =====================
-- Nothing to run. The table is a copy of the billing record. Every PUT of
-- the record rebuilds that company's rows from it (api/data/[key].js ->
-- api/lib/sync-normalized.js syncIntercompanyBillingEntries), and step 5's
-- Dust page save is such a PUT. Until then the table still has the
-- re-created entries and lacks the restored ones. Nothing is hurt in the
-- meantime:
--   - The Intercompany page, the executive report (api/lib/ic-metrics.js)
--     and Mathis all read the record, not the table.
--   - The only app reader is the cold-start rebuild of LOST dust rows in
--     api/dust-rows.js (recoverFromIcBilling). It only acts on rows missing
--     from dust_control_entries, and RESTORE only puts back entries whose
--     dust row still exists.
--   - The other reader is scripts/recover-dust-rows.js, run by hand, which
--     uses the same rule.
-- (4) CHECK shows how far the table lags behind the record. If step 5 saves
-- nothing (no rewritten entries and no row changes), any later Intercompany,
-- Trucking or Dust save rebuilds it, and so does the admin sync
-- (api/admin/sync-db.js).


-- ==== (4) CHECK, read-only ===========================================
-- One line per company. After step 5, expect:
--   pre_entries_still_gone = the number of "skip" rows (1) still lists.
--                            Run (1) again to see them.
--   rows_with_two_entries  = 0.
--   entries_at_0_ub        = 0. Above 0 means step 5 has not happened yet:
--                            these are the rewritten entries. It also counts
--                            a customer whose own UB $/gal is 0, if any.
--   table_missing / table_extra = 0, once a save has rebuilt the table.
WITH pre AS (
  SELECT DISTINCT ON (s.key) s.key, s.company_code, s.taken_at, s.value_hash, s.value
    FROM app_data_snapshots s
   WHERE s.key = s.company_code || ':fct_intercompany_billing_entries'
     AND s.taken_at <= (SELECT COALESCE(min(r.taken_at), TIMESTAMPTZ '2026-10-02 09:45:00+00') FROM app_data_snapshots r
                         WHERE r.company_code = s.company_code
                           AND r.taken_at >= TIMESTAMPTZ '2026-10-02 09:45:00+00'
                           AND r.taken_at <  TIMESTAMPTZ '2026-10-02 10:45:00+00')
   ORDER BY s.key, s.taken_at DESC
),
was AS MATERIALIZED (
  -- As in (1): each row's earliest entry, from the pre-cutoff copy through
  -- the 2026-10-03 run.
  SELECT DISTINCT ON (p.key, e.v->>'source_id') p.key, e.v->>'source_id' AS sid, COALESCE(e.v->>'id', '') AS id
    FROM pre p
    JOIN app_data_snapshots s ON s.key = p.key AND s.taken_at >= p.taken_at
                             AND s.taken_at < TIMESTAMPTZ '2026-10-04 00:00:00+00' AND s.value_hash <> 'deleted'
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]' END) WITH ORDINALITY e(v, ord)
   WHERE p.value_hash <> 'deleted' AND e.v->>'source' = 'dust' AND COALESCE(e.v->>'source_id', '') <> ''
   ORDER BY p.key, e.v->>'source_id', s.taken_at, e.v->>'sent_at' DESC NULLS LAST, e.ord
),
live AS MATERIALIZED (
  SELECT a.key, e.v, e.v->>'source' AS src, e.v->>'source_id' AS sid, COALESCE(e.v->>'id', '') AS id
    FROM app_data a
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.value) = 'array' THEN a.value ELSE '[]' END) e(v)
   WHERE a.key IN (SELECT key FROM pre)
),
tbl AS MATERIALIZED (
  SELECT t.company_code || ':fct_intercompany_billing_entries' AS key, t.id
    FROM intercompany_billing_entries t
   WHERE t.company_code IN (SELECT company_code FROM pre)
)
SELECT p.company_code,
       a.updated_at                                        AS billing_updated_at,
       ds.ub_rate                                          AS ub_rate_now,
       (SELECT count(*) FROM live l WHERE l.key = p.key)   AS entries_now,
       (SELECT count(DISTINCT g.sid) FROM (SELECT key, sid, id FROM was WHERE key = p.key
                                           EXCEPT
                                           SELECT key, sid, id FROM live WHERE key = p.key AND src = 'dust') g) AS pre_entries_still_gone,
       (SELECT count(*) FROM (SELECT 1 FROM live l
                               WHERE l.key = p.key AND l.src = 'dust' AND l.sid IS NOT NULL
                               GROUP BY l.sid HAVING count(*) > 1) z) AS rows_with_two_entries,
       (SELECT count(*) FROM live l
         WHERE l.key = p.key AND l.src = 'dust'
           AND (CASE WHEN l.v->>'gallons_ub' ~ '^\s*\d*\.?\d+\s*$' THEN (l.v->>'gallons_ub')::numeric ELSE 0 END) > 0
           AND (CASE WHEN l.v->>'ub_total' ~ '^\s*-?\d*\.?\d+\s*$' THEN (l.v->>'ub_total')::numeric ELSE 0 END) = 0) AS entries_at_0_ub,
       (SELECT count(*) FROM (SELECT id FROM live WHERE key = p.key AND id <> ''
                              EXCEPT SELECT id FROM tbl WHERE key = p.key) z) AS table_missing,
       (SELECT count(*) FROM (SELECT id FROM tbl WHERE key = p.key
                              EXCEPT SELECT id FROM live WHERE key = p.key) z) AS table_extra
  FROM pre p
  LEFT JOIN app_data a ON a.key = p.key
  LEFT JOIN dust_settings ds ON ds.company_code = p.company_code
 ORDER BY p.company_code;
