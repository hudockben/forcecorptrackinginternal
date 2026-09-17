'use strict';
/**
 * GET    /api/purchase-orders?division=turf          — all POs for a division
 * PUT    /api/purchase-orders?division=turf          — full sync: { purchaseOrders: [...] }
 * POST   /api/purchase-orders?division=turf          — upsert ONE: { purchaseOrder: {...} }
 * DELETE /api/purchase-orders?division=turf&id=X     — remove ONE
 *
 * GET and PUT are what the division tabs have always used: each page owns its
 * division's list and rewrites the whole thing.
 *
 * POST and DELETE exist for central purchasing (purchase-orders.html), which
 * writes into turf, paving and kiewit and so must never rewrite a list it does
 * not own — a full PUT from it would erase whatever that division's own tab had
 * saved since it loaded. They touch one order, under a compare-and-set, and
 * reconcile that order's job cost rows server-side. See api/lib/po-sync.js.
 *
 * Read and single-order write resolve access through canAccessPODivision, so a
 * purchasing user reaches the source divisions' lists. The full-list PUT keeps
 * the plain division check: only a division's own people may replace its list.
 *
 * The `division` query param defaults to 'turf' for backward compatibility.
 * Each division's POs are stored separately in both the normalized table
 * (purchase_orders.division column) and the blob
 * (app_data key = companyCode:fct_purchase_orders:<division>).
 *
 * Frontend PO shape:
 *   { id, po_number, date_created, project_id, cost_code, sub_code, title,
 *     supplier, status, notes,
 *     lines: [{ id, invoice_num, date, qty, unit_cost, tax, tax_pct, employee,
 *              po_row_id }] }
 *
 * `tax_pct` is what the user types (a percentage of qty × unit_cost); `tax` is
 * the dollar amount it works out to, kept in sync by the frontend. Only `tax`
 * is mirrored to po_deliveries — the JSON blob carries `tax_pct` and is the
 * source of truth on read, so the normalized fallback below losing it is fine:
 * the frontend re-derives the percentage from the dollar amount.
 */
const { neon } = require('@neondatabase/serverless');
const {
  requireAuth,
  requireDivision,
  normalizeDivision,
  canAccessPODivision,
  poCapabilities,
  PO_SOURCE_DIVISIONS,
  PO_GENERAL_DIVISION,
} = require('./lib/auth');
const poSync = require('./lib/po-sync');
const { numeric } = require('./lib/numeric');

// The only divisions a purchase order can be stored under — the three job
// divisions plus the general purchasing list. Both purchase_orders_division_chk
// and daily_tracking_division_chk are written to match.
const PO_STORABLE = PO_SOURCE_DIVISIONS.concat([PO_GENERAL_DIVISION]);

// ./lib/numeric, not a bare parseFloat: these are figures somebody typed, and
// parseFloat reads '1.234,56' as 1.234.
function safeFloat(v) {
  const f = numeric(v);
  return isNaN(f) ? null : f;
}

function safeDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return s.length === 10 ? s : null;
}

/**
 * Which access check this request gets.
 *
 * The full-list PUT stays on requireDivision: replacing a division's entire
 * purchase-order list is something only that division's own people may do, and
 * widening it would hand central purchasing a way to wipe paving's list in one
 * call. Everything else — reading, and the single-order writes purchasing makes
 * — goes through canAccessPODivision.
 *
 * The turf default is kept for GET and PUT because tracker.html has always
 * relied on it. A single-order write has to name its division: purchasing is
 * the only caller, and one that guessed would file the order against the wrong
 * division's jobs.
 */
function _guardFor(req, res) {
  const guarded = _guardDivision(req, res);
  if (!guarded) return null;
  // Both mirror tables' CHECK constraints admit only the job divisions and the
  // general list, while normalizeDivision accepts all sixteen and either guard
  // above passes anyone holding a role in the one they named — so a level2 fuel
  // user reached a write for `fuel`. The INSERT that violated the constraint ran
  // AFTER the blob write had committed: the order was stored, the caller was
  // told "Database error", and every retry hit the same wall. Refuse it here,
  // before anything is written, and say why. GET is untouched: reading names no
  // row in either table.
  if (req.method !== 'GET' && !PO_STORABLE.includes(guarded.division)) {
    res.status(400).json({ error: 'Purchase orders cannot be filed under this division' });
    return null;
  }
  return guarded;
}

function _guardDivision(req, res) {
  if (req.method === 'PUT') return requireDivision(req, res);

  const payload = requireAuth(req, res);
  if (!payload) return null;

  const raw = (req.query && req.query.division) || (req.body && req.body.division) || null;
  const division = normalizeDivision(raw);
  if (!division) {
    if (req.method !== 'GET') {
      res.status(400).json({ error: 'division query param is required' });
      return null;
    }
    if (!canAccessPODivision(payload, 'turf')) {
      res.status(403).json({ error: 'You do not have access to this division' });
      return null;
    }
    return { payload, division: 'turf' };
  }
  if (!canAccessPODivision(payload, division)) {
    res.status(403).json({ error: 'You do not have access to this division' });
    return null;
  }
  return { payload, division };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const guard = _guardFor(req, res);
  if (!guard) return;
  const { payload, division } = guard;

  const { companyCode } = payload;
  const blobKey  = `${companyCode}:fct_purchase_orders:${division}`;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // The JSON blob is the source of truth (PUT always awaits a write to it).
      const blobRows = await sql`
        SELECT value, updated_at FROM app_data WHERE key = ${blobKey}
      `;
      const blob = blobRows.length ? blobRows[0].value : null;
      const list = Array.isArray(blob) ? blob : [];
      // The version this list came from. A client that sends it back on PUT
      // gets its full-list save merged rather than clobbering anything written
      // in between — see the PUT arm.
      const updatedAt = blobRows.length ? blobRows[0].updated_at : null;

      if (list.length > 0) {
        return res.json({ purchaseOrders: list, updatedAt });
      }

      // ── Fallback: read from normalized table filtered by division ─────
      const poRows = await sql`
        SELECT * FROM purchase_orders
        WHERE  company_code = ${companyCode} AND division = ${division}
        ORDER  BY created_at ASC
      `;

      if (poRows.length === 0) {
        return res.json({ purchaseOrders: [], updatedAt });
      }

      const poIds = poRows.map(r => r.id);
      const dlRows = await sql`
        SELECT * FROM po_deliveries
        WHERE  po_id = ANY(${poIds})
        ORDER  BY po_id, created_at ASC
      `;

      const linesByPO = {};
      for (const d of dlRows) {
        if (!linesByPO[d.po_id]) linesByPO[d.po_id] = [];
        linesByPO[d.po_id].push({
          id:          d.line_id      || String(d.id),
          invoice_num: d.invoice_num  || '',
          date:        safeDate(d.delivery_date) || '',
          qty:         d.units_delivered != null ? String(d.units_delivered) : '',
          unit_cost:   d.unit_cost       != null ? String(d.unit_cost)       : '',
          tax:         d.tax             != null ? String(d.tax)             : '',
          employee:    d.employee        || '',
          po_row_id:   d.po_row_id       || null,
        });
      }

      const purchaseOrders = poRows.map(r => ({
        id:                r.id,
        po_number:         r.po_num          || '',
        date_created:      safeDate(r.date_created) || '',
        project_id:        r.project_id      || '',
        cost_code:         r.cost_code       || '',
        sub_code:          r.sub_code        || '',
        title:             r.title           || '',
        supplier:          r.supplier        || '',
        status:            r.status          || 'pending',
        notes:             r.notes           || '',
        origin:            r.origin          || undefined,
        status_changed_at: r.status_changed_at ? String(r.status_changed_at) : undefined,
        status_changed_by: r.status_changed_by || undefined,
        lines:             linesByPO[r.id]   || [],
      }));

      return res.json({ purchaseOrders, updatedAt });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { purchaseOrders } = req.body || {};
      if (!Array.isArray(purchaseOrders)) {
        return res.status(400).json({ error: 'purchaseOrders array required' });
      }

      // Bulk-wipe protection: empty incoming list against an existing
      // non-trivial blob is almost always a client bug. Single-row deletes
      // still work. Override with ?force=1 for genuine wipes.
      if (purchaseOrders.length === 0 && req.query.force !== '1') {
        const existing = await sql`SELECT value FROM app_data WHERE key = ${blobKey}`;
        const existingArr = Array.isArray(existing[0]?.value) ? existing[0].value : null;
        if (existingArr && existingArr.length > 1) {
          console.warn(`[purchase-orders] refused empty PUT: would have wiped ${existingArr.length} POs for ${blobKey}`);
          return res.status(409).json({
            error: 'Refusing to wipe purchase orders',
            detail: `Cannot replace ${existingArr.length} POs with an empty list. Pass ?force=1 to override.`,
          });
        }
      }

      // ── Merge anything written since the client read this list ──────────
      //
      // This arm REPLACES the division's whole list, which was safe while that
      // division's own tab was the only writer. Central purchasing writes here
      // too now, so a tab whose 60-second refresh happened to be skipped — it
      // skips while the user is typing — could save its stale list and erase an
      // order raised in the meantime, deleting the mirror row with it and
      // leaving the job charged for a purchase order that no longer exists
      // anywhere.
      //
      // A client that sends back the `updatedAt` it read gets the safe path:
      // when the stored list has moved on, an order that is in it but NOT in
      // what the client sent is one the client never saw, so it is kept. An
      // order the client did see and deliberately deleted is absent from BOTH
      // and stays deleted. `?force=1` still means exactly what it says.
      //
      // The one imprecision is a delete racing an edit of the same order: the
      // order comes back. That is the safe direction, and it is recoverable —
      // the other way round is not.
      const baseUpdatedAt = (req.body || {}).baseUpdatedAt || null;
      const baseTs = baseUpdatedAt ? Date.parse(baseUpdatedAt) : NaN;
      let toWrite = purchaseOrders;
      // Everything the merge arm put back, at any level. The response reports
      // the SUM, because the client withholds the new version whenever this is
      // non-zero — and a merge it is not told about is worse than no merge at
      // all: the client adopts the post-merge version, its next save matches
      // the compare-and-set, the merge does not fire, and what was just
      // recovered is written straight back out.
      let mergedLines = 0;      // deliveries the client had not seen
      let mergedLinks = 0;      // po_row_ids restored onto lines it had
      const supersededRows = [];  // cost rows a stale copy minted over a stored one

      if (!isNaN(baseTs) && req.query.force !== '1') {
        const cur = await sql`SELECT value, updated_at FROM app_data WHERE key = ${blobKey}`;
        const stored = cur.length && Array.isArray(cur[0].value) ? cur[0].value : [];
        // Compare instants, not strings — the driver hands back a Date and the
        // client always sends the ISO form, so the two never match textually.
        // Comparing them as text made `moved` true on EVERY save: a deleted
        // order looked like one the client had never seen and was written
        // straight back, so no division tab could delete a purchase order at
        // all. api/data/[key].js carries the same warning over its own guard.
        const curTs = cur.length && cur[0].updated_at ? new Date(cur[0].updated_at).getTime() : null;
        const moved = curTs !== null && curTs !== baseTs;
        if (moved && stored.length) {
          const sent = new Set(purchaseOrders.map(p => p && p.id).filter(Boolean));
          const unseen = stored.filter(p => p && p.id && !sent.has(p.id));
          if (unseen.length) {
            console.warn(`[purchase-orders] merged ${unseen.length} order(s) the client had not seen for ${blobKey}`);
            toWrite = purchaseOrders.concat(unseen);
          }

          // ...and the same one level down. An order this client DID send may
          // still be missing deliveries added to it since — central purchasing
          // records them against this division's orders all day. Replacing the
          // order wholesale dropped those, and _syncPOs' orphan sweep then took
          // the job cost rows behind them.
          //
          // Only on a detected race, and only for deliveries absent from what
          // the client sent. A client that is up to date replaces its own
          // orders exactly as before, so removing a delivery still removes it.
          const storedById = new Map(stored.filter(p => p && p.id).map(p => [p.id, p]));

          // A stored link is only worth restoring if the row it names is still
          // there. A null from the client means one of two opposite things and
          // the payload cannot tell them apart: the tab never had the link
          // (stale copy — restore it), or the user deleted that cost row on the
          // job's own daily tab and _detachLinkedRows cleared the link on
          // purpose (deliberate — leave it). Restoring the second points the
          // line at a row that no longer exists, and _ensurePOLineRow then never
          // mints a replacement because the link reads as present, so the job is
          // silently UNDER-charged. Whether the row still exists is exactly the
          // distinction, so ask.
          const candidateRows = [];
          for (const po of toWrite) {
            const was = po && po.id ? storedById.get(po.id) : null;
            if (!was || !Array.isArray(was.lines)) continue;
            if (String(po.project_id || '') !== String(was.project_id || '')) continue;
            const mineIds = new Set((Array.isArray(po.lines) ? po.lines : [])
              .map(l => l && l.id).filter(Boolean).map(String));
            for (const l of was.lines) {
              if (l && l.id && l.po_row_id && mineIds.has(String(l.id))) {
                candidateRows.push(String(l.po_row_id));
              }
            }
          }
          // Advisory: it only decides whether a link is worth restoring. Its two
          // siblings in this handler are wrapped and this was not, so a dropped
          // connection on a lookup that changes nothing turned a save that used
          // to succeed into a 500 with the blob unwritten — and the division
          // tabs do not retry a non-409. On failure nothing is restored and
          // nothing is deleted for this request; the next save reads it again.
          let liveRows = new Set();
          let liveKnown = true;
          if (candidateRows.length) {
            try {
              const found = await sql`
                SELECT row_id FROM daily_tracking
                WHERE company_code = ${companyCode} AND row_id = ANY(${candidateRows})
              `;
              liveRows = new Set(found.map(r => String(r.row_id)));
            } catch (err) {
              liveKnown = false;
              console.error('[purchase-orders] could not check cost rows, skipping relink:', err.message);
            }
          }

          toWrite = toWrite.map(po => {
            const was = po && po.id ? storedById.get(po.id) : null;
            if (!was || !Array.isArray(was.lines) || !was.lines.length) return po;
            const wasById = new Map(was.lines.filter(l => l && l.id).map(l => [l.id, l]));
            const mine = Array.isArray(po.lines) ? po.lines : [];
            const have = new Set(mine.map(l => l && l.id).filter(Boolean));

            // A delivery the client HAS but whose cost-row link is not the
            // stored one. Central purchasing creates those rows server-side, so
            // a tab that loaded the order beforehand carries the line either
            // with no link or — once the user touches it — with a fresh one the
            // tab minted and POSTed to /api/daily-rows itself. Both end the same
            // way if they are written: the job is charged TWICE for the one
            // delivery, and the server's original row is orphaned, because the
            // stored order then names only the tab's.
            //
            // Judging only the linkless case missed the one that matters, since
            // _ensurePOLineRow always mints before savePurchaseOrders runs. A
            // differing link is always the stale copy's: the tabs only ever
            // write po_row_id null -> new, or -> null, never one non-null value
            // over a different one.
            //
            // Unless the JOB moved. Then the tab deleted every row and nulled
            // every link deliberately, and restoring one would point the line at
            // a row that no longer exists — after which _ensurePOLineRow never
            // mints a replacement, because the link reads as present, and the
            // job is silently UNDER-charged instead.
            const jobMoved = String(po.project_id || '') !== String(was.project_id || '');
            let relinked = 0;
            const superseded = [];
            const kept = (jobMoved || !liveKnown) ? mine : mine.map(l => {
              if (!l || !l.id) return l;
              const before = wasById.get(l.id);
              if (!before || !before.po_row_id) return l;
              if (String(l.po_row_id || '') === String(before.po_row_id)) return l;
              // Gone from daily_tracking means somebody removed it deliberately.
              if (!liveRows.has(String(before.po_row_id))) return l;
              // The row the tab minted from its stale copy. Nothing references
              // it once the stored link is back, and it would charge the job on
              // its own, so it goes with the merge.
              //
              // Carried with the ORDER's project and PO number, because the id
              // itself comes from the request body and daily_tracking.row_id is
              // unique across the whole company. Deleting on the id alone let a
              // caller with a role in one division name any cost row in the
              // tenant — paving's labour, kiewit's equipment — and have it
              // destroyed by a save that answered 200. The row has to prove it
              // is this order's before it can be removed. Same reasoning as
              // ownsRow in po-sync.js, which the POST path has had all along.
              if (l.po_row_id) {
                superseded.push({
                  rowId:     String(l.po_row_id),
                  projectId: String(po.project_id || ''),
                  poNum:     String(po.po_number  || ''),
                });
              }
              relinked++;
              return { ...l, po_row_id: before.po_row_id };
            });
            if (superseded.length) supersededRows.push(...superseded);

            mergedLinks += relinked;

            // A delivery this client never saw. When the JOB moved it cannot
            // keep its link either: that row is on the old job, and because the
            // link reads as present _ensurePOLineRow never mints a replacement
            // on the new one — so the new job is never charged for the
            // delivery while the old job still is. The guard above covered the
            // relinked lines and this arm of the same block was left out.
            const missing = was.lines
              .filter(l => l && l.id && !have.has(l.id))
              .map(l => {
                if (!jobMoved || !l.po_row_id) return l;
                // Removed with the move, the way the tab removes the rows for
                // the lines it did hold. Matched against the OLD job, which is
                // where the row actually sits.
                if (!/^ts\d+-/.test(String(l.po_row_id))) {
                  supersededRows.push({
                    rowId:     String(l.po_row_id),
                    projectId: String(was.project_id || ''),
                    poNum:     String(was.po_number  || po.po_number || ''),
                  });
                }
                return { ...l, po_row_id: null };
              });
            if (!missing.length && !relinked) return po;
            mergedLines += missing.length;
            return { ...po, lines: kept.concat(missing) };
          });
          if (mergedLines) {
            console.warn(`[purchase-orders] merged ${mergedLines} delivery line(s) the client had not seen for ${blobKey}`);
          }
          if (mergedLinks) {
            console.warn(`[purchase-orders] restored ${mergedLinks} cost-row link(s) a stale copy had dropped for ${blobKey}`);
          }
        }
      }

      // Always write to the division-specific JSON blob first — source of truth.
      const written = await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${blobKey}, ${JSON.stringify(toWrite)}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        RETURNING updated_at
      `;

      // Only once the blob naming the STORED links has landed: until then the
      // tab's row is the only one anything references, and deleting it first
      // would lose the delivery's cost outright if the write then failed.
      // Payroll-injected rows are never ours to remove, the same exclusion
      // _syncPOs' orphan sweep makes.
      const dropRows = supersededRows.filter(r =>
        r && r.rowId && r.projectId && !/^ts\d+-/.test(r.rowId));
      if (dropRows.length) {
        try {
          // Every column is checked, not just the id: the division this request
          // was authorised for, the ORDER's own project and PO number, a
          // material row, and no timesheet behind it. A row that fails any of
          // them is not this order's duplicate, whatever the request called it.
          await sql`
            DELETE FROM daily_tracking d
            USING  unnest(${dropRows.map(r => r.rowId)}::text[],
                          ${dropRows.map(r => r.projectId)}::text[],
                          ${dropRows.map(r => r.poNum)}::text[]) AS t(row_id, project_id, po_num)
            WHERE  d.company_code = ${companyCode}
              AND  d.division     = ${division}
              AND  d.row_id       = t.row_id
              AND  d.project_id   = t.project_id
              AND  COALESCE(d.po_num, '') = t.po_num
              AND  d.field_type   = 'Material'
              AND  d.timesheet_entry_id IS NULL
          `;
          console.warn(`[purchase-orders] removed up to ${dropRows.length} duplicate cost row(s) a stale copy minted for ${blobKey}`);
        } catch (err) {
          console.error('[purchase-orders] could not remove duplicate cost rows:', err.message);
        }
      }

      // Mirror to normalized table (awaited so serverless doesn't kill it).
      try { await _syncPOs(sql, companyCode, division, toWrite); }
      catch (err) { console.error('[purchase-orders] normalize failed:', err.message); }

      // The new version, so the next save from this client takes the fast path
      // instead of re-merging against a base it already knows is stale.
      // `merged` is every level summed, not just whole orders. The client reads
      // it as "did the server have to put anything back" and withholds the new
      // version when it did, so a delivery or a link merged back has to count
      // too — reporting 0 for those let the next save erase them again.
      const mergedOrders = toWrite.length - purchaseOrders.length;
      return res.json({
        ok: true,
        updatedAt: written.length ? written[0].updated_at : null,
        merged: mergedOrders + mergedLines + mergedLinks,
        mergedOrders, mergedLines, mergedLinks,
      });
    }

    // ── POST (upsert one) ─────────────────────────────────────────────────
    // What central purchasing saves with. One order, merged into this
    // division's list under a compare-and-set, with its job cost rows
    // reconciled in the same call.
    if (req.method === 'POST') {
      // Reaching a division's orders and being allowed to WRITE them are
      // different questions. A purchasing clerk given view-only rights must not
      // be able to raise an order against a paving job, and the answer has to
      // come from their purchasing level — payload.role is their TURF role and
      // would answer about the wrong division entirely.
      if (!poCapabilities(payload, division).canUpload) {
        return res.status(403).json({ error: 'You do not have permission to change purchase orders' });
      }
      const po = (req.body || {}).purchaseOrder;
      if (!po || typeof po !== 'object' || Array.isArray(po)) {
        return res.status(400).json({ error: 'purchaseOrder object required' });
      }
      if (!po.id) {
        return res.status(400).json({ error: 'purchaseOrder.id is required' });
      }
      if (po.lines != null && !Array.isArray(po.lines)) {
        return res.status(400).json({ error: 'purchaseOrder.lines must be an array' });
      }
      // Deliveries the caller deliberately removed. Everything else the stored
      // order carries but this request omits is a delivery the caller never saw
      // — somebody else added it — and is kept rather than dropped.
      const deletedLineIds = Array.isArray((req.body || {}).deletedLineIds)
        ? (req.body || {}).deletedLineIds.map(String).slice(0, 500)
        : [];

      // The division the order was stored under before this save. Purchasing
      // sends it when someone re-ties an order to a different division, so the
      // order moves lists instead of existing in two at once.
      const from = normalizeDivision(req.query.from);
      if (req.query.from && !from) {
        return res.status(400).json({ error: 'Unknown `from` division' });
      }
      if (from && from !== division && !canAccessPODivision(payload, from)) {
        return res.status(403).json({ error: 'You do not have access to the division this order is moving from' });
      }

      const result = await poSync.upsertPO(sql, {
        companyCode,
        division,
        po: { ...po, lines: Array.isArray(po.lines) ? po.lines : [] },
        from,
        deletedLineIds,
      });
      if (!result.ok) {
        return res.status(409).json({
          error: 'Purchase order not saved',
          detail: 'Someone else is editing this division\'s purchase orders right now. Try again.',
        });
      }
      // The saved order goes back because syncPOCostRows mints po_row_id on any
      // line that did not have one. A client that kept its own copy instead
      // would create a second cost row for that line on the next save.
      //
      // staleCopy means the order saved but the division it moved FROM still
      // lists it. The client keeps its record of where the order was last
      // stored so the next save repeats the move — see savePO in
      // purchase-orders.html.
      return res.json({
        ok: true,
        purchaseOrder: result.purchaseOrder,
        rows: result.rows,
        staleCopy: Boolean(result.staleCopy),
        mergedLines: result.mergedLines || 0,
      });
    }

    // ── DELETE (one) ──────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      // Deleting an order removes the job's cost rows with it, so this is the
      // destructive end of the same capability the upsert checks.
      if (!poCapabilities(payload, division).canManage) {
        return res.status(403).json({ error: 'You do not have permission to delete purchase orders' });
      }
      const id = String(req.query.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id query param is required' });

      const result = await poSync.removePO(sql, { companyCode, division, poId: id });
      if (!result.ok) {
        return res.status(409).json({
          error: 'Purchase order not deleted',
          detail: 'Someone else is editing this division\'s purchase orders right now. Try again.',
        });
      }
      return res.json({ ok: true, found: result.found, rowsRemoved: result.rowsRemoved });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    // Logged in full, never echoed: the driver's message carries constraint,
    // table and column names, and the client has nothing to do with them.
    console.error('[purchase-orders]', err.message);
    // One handler covers every method, so it cannot say "save" for all of them —
    // a failed GET told the user their save had not landed when they had not
    // saved anything, and a failed DELETE told them the same about a delete.
    const doing = req.method === 'GET'    ? 'load the purchase orders'
                : req.method === 'DELETE' ? 'delete the purchase order'
                : 'save the purchase order';
    return res.status(500).json({ error: `Could not ${doing}. Try again.` });
  }
};

async function _syncPOs(sql, companyCode, division, list) {
  const incomingIds = list.map(p => p && p.id).filter(Boolean);

  // Defense in depth: even if an empty list slips past the upstream guard,
  // refuse to wipe the mirror table — leaves a recovery option intact.
  if (incomingIds.length === 0) return;

  // Remove POs for this division that are no longer in the list.
  //
  // The job cost rows they created go first. A division tab deleting its own
  // order removes them client-side as it goes, so this is normally a no-op —
  // but it is not for an order that tab never held, and a dropped order whose
  // rows survive leaves the job charged for material with no purchase order
  // anywhere behind it. Cheap, and it makes the invariant hold whatever the
  // client did or failed to do.
  const goneRows = await sql`
    SELECT d.po_row_id
    FROM   po_deliveries d
    JOIN   purchase_orders p ON p.id = d.po_id
    WHERE  d.company_code = ${companyCode}
      AND  p.company_code = ${companyCode}
      AND  p.division = ${division}
      AND  p.id <> ALL(${incomingIds})
      AND  d.po_row_id IS NOT NULL
  `;
  const orphanIds = goneRows
    .map(r => r.po_row_id)
    .filter(id => id && !/^ts\d+-/.test(String(id)));   // never a payroll-injected row
  if (orphanIds.length) {
    await sql`
      DELETE FROM daily_tracking
      WHERE company_code = ${companyCode} AND row_id = ANY(${orphanIds})
    `;
  }

  await sql`
    DELETE FROM purchase_orders
    WHERE company_code = ${companyCode} AND division = ${division}
      AND id <> ALL(${incomingIds})
  `;

  for (const po of list) {
    if (!po || !po.id) continue;

    await sql`
      INSERT INTO purchase_orders (
        id, company_code, division, po_num, title, supplier, project_id,
        cost_code, sub_code, status, notes, origin,
        date_created, status_changed_at, status_changed_by, updated_at
      ) VALUES (
        ${po.id}, ${companyCode}, ${division},
        ${po.po_number      || ''},
        ${po.title          || null},
        ${po.supplier       || null},
        ${po.project_id     || null},
        ${po.cost_code      || null},
        ${po.sub_code       || null},
        ${po.status         || 'pending'},
        ${po.notes          || null},
        ${po.origin         || null},
        ${safeDate(po.date_created)},
        ${po.status_changed_at || null},
        ${po.status_changed_by || null},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        division           = EXCLUDED.division,
        po_num             = EXCLUDED.po_num,
        title              = EXCLUDED.title,
        supplier           = EXCLUDED.supplier,
        project_id         = EXCLUDED.project_id,
        cost_code          = EXCLUDED.cost_code,
        sub_code           = EXCLUDED.sub_code,
        status             = EXCLUDED.status,
        notes              = EXCLUDED.notes,
        origin             = EXCLUDED.origin,
        date_created       = EXCLUDED.date_created,
        status_changed_at  = EXCLUDED.status_changed_at,
        status_changed_by  = EXCLUDED.status_changed_by,
        updated_at         = NOW()
    `;

    // Bulk-wipe protection for delivery records: only wipe-and-reinsert
    // when we actually have lines to write back. If lines is empty against
    // a PO with multiple existing deliveries, that's almost always a bug
    // (PO was edited without loading its full lines) and would silently
    // destroy the user's delivery history. The count==1 case still wipes
    // so a genuine "delete last delivery" still works.
    const lines = Array.isArray(po.lines) ? po.lines : [];
    if (lines.length > 0) {
      await sql`DELETE FROM po_deliveries WHERE po_id = ${po.id} AND company_code = ${companyCode}`;
    } else {
      const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count FROM po_deliveries
        WHERE po_id = ${po.id} AND company_code = ${companyCode}
      `;
      if (count > 1) {
        console.warn(`[purchase-orders] refused empty lines for PO ${po.id}: ${count} deliveries would have been wiped`);
      } else if (count === 1) {
        await sql`DELETE FROM po_deliveries WHERE po_id = ${po.id} AND company_code = ${companyCode}`;
      }
    }
    for (const line of lines) {
      if (!line) continue;
      const qty = safeFloat(line.qty)       ?? 0;
      const uc  = safeFloat(line.unit_cost) ?? 0;
      const tax = safeFloat(line.tax)       ?? 0;
      await sql`
        INSERT INTO po_deliveries (
          po_id, company_code,
          line_id, invoice_num, delivery_date,
          units_delivered, unit_cost, delivery_cost,
          tax, employee, po_row_id
        ) VALUES (
          ${po.id}, ${companyCode},
          ${line.id          || null},
          ${line.invoice_num || null},
          ${safeDate(line.date)},
          ${qty}, ${uc}, ${qty * uc},
          ${tax},
          ${line.employee    || null},
          ${line.po_row_id   || null}
        )
      `;
    }
  }
}
