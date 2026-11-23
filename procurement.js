/* eslint-disable no-undef */
/* DataWatch — Procurement (a job's material buy-out sheet)
 *
 * The Procurement tab: per job, one row for every material the PM has to buy
 * — when it is needed on site, how long the supplier takes, which vendor and
 * quote, which purchase order, and whether it has been ordered and delivered.
 * It replaces the Excel sheet a PM kept per job, so it is laid out like one:
 * a dense grid, every cell edited in place, saved as you go.
 *
 * Shared the way documents.js is: one <script src defer>, no bundler, all
 * styling off the host page's CSS variables. Only tracker.html (turf) turns it
 * on today; the API is division-aware so the other job pages can follow.
 *
 * The host page configures it once and then hands it a mount:
 *
 *   FCTProcurement.configure({
 *     division, apiBase, getToken, getUserName, perm: { canView, canEdit },
 *     getProjects, getProject, getBidLines, getPurchaseOrders, isPOListLoaded,
 *     codeKey, getSuppliers, addSupplier, createPurchaseOrder,
 *     openPurchaseOrder, showSaveError, today, storage,
 *     // optional: the documents attached to each line, and the cost-code
 *     // folder each section compiles them into (the page's Document Vault)
 *     attachmentCount, refreshAttachmentCounts, openAttachments,
 *     costCodeDocCount, openCostCodeFolder,
 *   });
 *   FCTProcurement.renderTab(document.getElementById('procurement-root'));
 *
 * It reaches nothing of the page's beyond that cfg and the combobox globals
 * (cbHtml and friends). The page routes every combobox list key that starts
 * with 'proc_' back here, through cbOptions / cbFilter. Attachments are the
 * same: the files live in the page's document module, and this sheet only
 * asks the page for their counts and to open them — never that module itself.
 *
 * Where the numbers come from:
 *   - Rows live in procurement_items through /api/procurement — one row per
 *     material, saved field by field (PATCH sends only the cells that
 *     changed, so two people editing different cells of one row never undo
 *     each other).
 *   - Cost Code / Sub Code are the bid's own. A row sent from the bid keeps
 *     the bid line's id and shows that line's CURRENT codes; the stored copy
 *     is only what it falls back to when the line is gone ("not on bid").
 *   - Material (stored as `description`) is what is bought, in the job's
 *     own words, beside those codes: the bid stays simple ("Infill Crumb
 *     Rubber") while the sheet says what this job buys ("20/40 Mesh rubber
 *     crumb infill"), and one bid line can be bought as many materials
 *     ("+ Material"). Blank reads as the Sub Code. Its picker offers the
 *     names used under the same sub code on earlier jobs (the material
 *     library, GET action=materials).
 *   - The PO # is never stored. A row stores the PO's id (or nothing, which
 *     means "match automatically") and the number is read live off the page's
 *     purchase-order list, because PO numbers are renumbered, moved and
 *     deleted under us (see the PO notes in tracker.html).
 *   - Status, Order By, the late / due-soon flags and a derived Date Ordered
 *     are worked out on the fly from those, never stored, so they cannot
 *     drift from what they are worked out of.
 */
(function () {
  if (window.FCTProcurement) return; // already loaded

  const Z = 10070;                  // above documents.js (10060)
  const SAVE_DELAY = 600;           // ms of quiet before a row's edits are sent
  const DUE_SOON_DAYS = 14;
  const SCA_VALUES = ['Pending', 'Needed', 'Not Needed', 'Executed'];
  // How the Sub-Contractor Agreement reads in its tag under a row's Status
  // pill — short, since the Status column is narrow; the tooltip, filters,
  // exports and print say it in full.
  const SCA_SHORT = { Pending: 'Agmt pending', Needed: 'Agmt needed', 'Not Needed': 'No agmt', Executed: 'Agmt \u2713' };
  // …and in its picker's menu (labelled "Sub-Contractor Agreement"), each
  // starting with its own word, so a typed letter picks it.
  const SCA_OPTION = { Pending: 'Pending', Needed: 'Needed', 'Not Needed': 'Not needed', Executed: 'Executed' };
  // The bid's own unit list (tracker.html UNIT_OPTS). Free text is still
  // allowed in the Unit cell — a supplier sells by the roll, the bag, the
  // stick — this is only what the menu offers.
  const UNITS = ['SF', 'LF', 'SY', 'CY', 'TN', 'TON', 'EA', 'LS', 'HR', 'GAL', 'LB', 'AC'];
  // A "live" job, the same rule the Scheduler and timesheets use.
  const LIVE_STATUSES = new Set(['', 'awarded', 'in progress', 'substantially complete']);
  const MAX_LEN = { description: 500, vendor: 120, quote_number: 120, contact: 120, email: 200, unit: 20 };
  // The years api/procurement.js takes. A date box hands over whatever year
  // was typed — 0026 for "12/01/26", 3026 for a slipped 2 — and the server
  // refuses those, so the page refuses them first, out loud, rather than
  // sending one (refused) or reading it as a blank (the date wiped).
  const MIN_YEAR = 1900, MAX_YEAR = 2999;
  const DATE_MIN = `${MIN_YEAR}-01-01`, DATE_MAX = `${MAX_YEAR}-12-31`;

  let cfg = {
    division: 'turf',
    apiBase: '/api',
    getToken: () => '',
    getUserName: () => '',
    perm: { canView: false, canEdit: false },
    getProjects: () => [],
    getProject: () => null,
    getBidLines: () => [],
    getPurchaseOrders: () => [],
    isPOListLoaded: () => true,
    codeKey: null,
    getSuppliers: () => [],
    addSupplier: null,
    createPurchaseOrder: null,
    openPurchaseOrder: null,
    showSaveError: msg => console.warn('[procurement]', msg),
    today: null,
    storage: null,
    // Documents attached to a line, and the cost-code folders that compile
    // them per section. All optional: without them no line has a paperclip
    // and the section headers have no folder chip. Each is checked with
    // typeof wherever it is used, so a page can hand over some and not others.
    //   attachmentCount(projectId, rowId)  -> number, from the page's cache
    //   refreshAttachmentCounts(projectId) -> promise, settles once that cache
    //                                         (lines and cost codes) is fresh
    //   openAttachments(line)              -> opens the line's documents;
    //                                         line = { id, project_id, cost_code, sub_code, label }
    //   costCodeDocCount(projectId, code)  -> number in that cost code's folder
    //   openCostCodeFolder({ projectId, costCode }) -> opens that folder
    attachmentCount: null,
    refreshAttachmentCounts: null,
    openAttachments: null,
    costCodeDocCount: null,
    openCostCodeFolder: null,
  };

  // ── Small pure helpers ──────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  const lc = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
  const str = v => (v == null ? '' : String(v));

  // The page passes its own _codeKey; this is the same rule for when it does
  // not (a test, or a page that has not got one): case, runs of space, every
  // kind of dash and curly quote all compare equal.
  function defaultCodeKey(s) {
    if (s == null || s === '') return '';
    return String(s)
      .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }
  const keyFn = ctx => (ctx && typeof ctx.codeKey === 'function' ? ctx.codeKey : defaultCodeKey);
  const ck = (k, s) => k(s == null ? '' : String(s)) || '';

  function numOrNull(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(String(v).replace(/,/g, '').trim());
    return String(v).trim() !== '' && Number.isFinite(n) ? n : null;
  }
  function intOrNull(v) {
    const n = numOrNull(v);
    return n == null ? null : Math.round(n);
  }
  function sameNum(a, b) {
    if (a == null || b == null) return a == null && b == null;
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  const normUnit = u => String(u == null ? '' : u).trim().toUpperCase();

  // A 'YYYY-MM-DD' that is a real calendar date, or ''. Timestamps are cut to
  // their date part (a PO's date_created is a plain date today, but nothing
  // guarantees an import never wrote a full ISO stamp).
  function ymdOf(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v));
    if (!m) return '';
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(t);
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return '';
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  // Calendar-day arithmetic on a 'YYYY-MM-DD', done in UTC so a daylight-
  // saving change in between can never land it a day off.
  function addDays(ymd, n) {
    const d = ymdOf(ymd);
    if (!d || typeof n !== 'number' || !Number.isFinite(n)) return '';
    const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + Math.round(n) * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }

  // The format a US date input shows, so a worked-out date sitting next to a
  // typed one reads the same way.
  function fmtDate(ymd) {
    const d = ymdOf(ymd);
    return d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '';
  }
  function fmtQty(n) {
    const v = numOrNull(n);
    if (v == null) return '';
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }

  function localToday() {
    const d = new Date(), p = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Ids for new rows. The server checks them for shape ([A-Za-z0-9_-], <= 64)
  // and refuses a duplicate, so they only have to be unique, not secret.
  function uid() {
    let r = '';
    try {
      const a = new Uint32Array(2);
      (window.crypto || {}).getRandomValues(a);
      r = a[0].toString(36) + a[1].toString(36);
    } catch { r = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
    return 'pr' + Date.now().toString(36) + r.slice(0, 12);
  }

  // A row as the page keeps it. The API promises numbers as numbers and dates
  // as plain dates; this makes sure of it, so one stray "901.0000" string
  // from a driver cannot make every comparison below say "changed".
  function normRow(item) {
    if (!item || item.id == null) return null;
    return {
      ...item,
      id: String(item.id),
      project_id: str(item.project_id),
      source: item.source === 'bid' ? 'bid' : 'manual',
      bid_item_id: item.bid_item_id == null || item.bid_item_id === '' ? null : String(item.bid_item_id),
      cost_code: str(item.cost_code),
      sub_code: str(item.sub_code),
      description: str(item.description),
      quantity: numOrNull(item.quantity),
      unit: str(item.unit),
      bid_qty_at_send: numOrNull(item.bid_qty_at_send),
      bid_unit_at_send: item.bid_unit_at_send == null ? null : String(item.bid_unit_at_send),
      sca_status: SCA_VALUES.includes(item.sca_status) ? item.sca_status : 'Pending',
      date_needed: ymdOf(item.date_needed) || null,
      lead_time_days: intOrNull(item.lead_time_days),
      date_ordered: ymdOf(item.date_ordered) || null,
      date_delivered: ymdOf(item.date_delivered) || null,
      vendor: str(item.vendor),
      quote_number: str(item.quote_number),
      contact: str(item.contact),
      email: str(item.email),
      po_id: item.po_id == null || item.po_id === '' ? null : String(item.po_id),
      po_auto: item.po_auto !== false,
      deleted_at: item.deleted_at || null,
    };
  }

  // ── Derived values (pure; exported through _test) ───────────────────
  // ctx = { purchaseOrders, bidLines, codeKey, today, projectId, poLoaded }.
  // A site's sheet (several jobs at once) also has bidLinesByProject: each
  // job's own bid lines, by job id. Then a row is only ever matched against
  // its OWN job's bid — two jobs' bids can carry the same line ids (a bid
  // copied from a sister field) and always carry the same codes — and
  // bidLines is every job's lines together, for what only asks "is there a
  // bid at all".
  // Lookups are indexed once per ctx object; build a fresh ctx when the lists
  // behind it change (the page does, once per render).
  const _ctxIndex = new WeakMap();
  function ctxIndex(ctx) {
    let m = _ctxIndex.get(ctx);
    if (!m) {
      m = { lineById: new Map(), poById: new Map(), lineByJob: null, costKeysByJob: new Map() };
      (ctx.bidLines || []).forEach(l => { if (l && l.id != null) m.lineById.set(String(l.id), l); });
      (ctx.purchaseOrders || []).forEach(p => { if (p && p.id != null) m.poById.set(String(p.id), p); });
      if (ctx.bidLinesByProject) {
        m.lineByJob = new Map();
        ctx.bidLinesByProject.forEach((lines, pid) => {
          const byId = new Map();
          (lines || []).forEach(l => { if (l && l.id != null) byId.set(String(l.id), l); });
          m.lineByJob.set(String(pid), byId);
        });
      }
      _ctxIndex.set(ctx, m);
    }
    return m;
  }
  function lineFor(row, ctx) {
    if (!row || row.bid_item_id == null) return null;
    const m = ctxIndex(ctx);
    if (m.lineByJob) {
      const job = m.lineByJob.get(String(row.project_id || ''));
      return (job && job.get(String(row.bid_item_id))) || null;
    }
    return m.lineById.get(String(row.bid_item_id)) || null;
  }
  // The bid lines a row is coded against: its own job's.
  function linesFor(row, ctx) {
    if (ctx.bidLinesByProject) return ctx.bidLinesByProject.get(String((row && row.project_id) || '')) || [];
    return ctx.bidLines || [];
  }

  /** The codes a row shows: its bid line's current ones, else its stored copy. */
  function liveCodes(row, ctx) {
    const line = lineFor(row, ctx);
    if (line) return { cost_code: str(line.cost_code), sub_code: str(line.sub_code), line, notOnBid: false, costGone: false };
    // A row sent from the bid whose line has gone, or a hand-added row that
    // was coded off a bid line that has since gone. A hand-added row that
    // was never tied to a line is just a row, not a problem.
    const notOnBid = row.source === 'bid' || row.bid_item_id != null;
    const cost = str(row.cost_code);
    return {
      cost_code: cost, sub_code: str(row.sub_code), line: null, notOnBid,
      // …except one given a cost code alone (+ Add Row on a section): it
      // follows no line, so a rename of that code on the bid leaves it
      // behind. Said once no line on the bid has the code.
      costGone: !notOnBid && !!cost.trim() && costOffBid(cost, ctx, row),
    };
  }
  /**
   * What a row buys, named the way Procurement names it. The bid's codes are
   * the estimate's language ("Infill Crumb Rubber", "12\" Concrete Curb") and
   * are what cost is tracked by; the job's plans and its suppliers name the
   * same thing in more detail ("20/40 Mesh rubber crumb infill", "12\"x12\"
   * Concrete Curb"), and one bid line is often bought as many materials (a
   * detention system: pipe, fittings, stone, fabric, hatch…). So a row keeps
   * its own Material (stored as `description`) beside the codes it books to,
   * and a row that has none is called by its Sub Code — a bid row reads as
   * the bid until somebody names it differently, and typing nothing is "same
   * as the bid". Never the codes themselves: those stay the bid's.
   */
  function materialOf(row, ctx) {
    const own = str(row && row.description).trim();
    return own || liveCodes(row, ctx).sub_code.trim();
  }

  // Whether no line on the job's bid has this cost code. A job with no bid
  // lines in hand (none yet, or not read yet) says nothing.
  function costOffBid(cost, ctx, row) {
    const lines = linesFor(row, ctx);
    if (!lines.length) return false;
    const m = ctxIndex(ctx), k = keyFn(ctx);
    const job = ctx.bidLinesByProject ? String((row && row.project_id) || '') : '';
    let keys = m.costKeysByJob.get(job);
    if (!keys) {
      keys = new Set(lines.filter(Boolean).map(l => ck(k, l.cost_code)).filter(Boolean));
      m.costKeysByJob.set(job, keys);
    }
    return !keys.has(ck(k, cost));
  }

  // Blank on either side matches: a row with no vendor yet takes any PO, and a
  // PO with no supplier yet is taken by any row.
  function vendorCompatible(a, b) {
    const x = lc(a), y = lc(b);
    return !x || !y || x === y;
  }

  /**
   * Which purchase order a row is on.
   *   kind 'linked'   po_id set and the PO exists
   *        'removed'  po_id set but the PO is gone (shown red, counts as no PO)
   *        'moved'    po_id set but that PO now belongs to another job (or to
   *                   none) — re-pointed on the Purchase Orders tab. Shown
   *                   red like 'removed' and, like it, not this job's order
   *        'auto'     no link, and exactly one PO on the job has the row's
   *                   live cost + sub code and a compatible vendor
   *        'multiple' several such POs — the user has to pick
   *        'none'     no such PO
   *        'nopo'     the user said "No PO" (po_id null, po_auto false)
   *        'loading'  the page's PO list has not loaded, so we cannot say
   */
  function effectivePO(row, ctx) {
    const out = (kind, po, candidates) => ({ kind, po: po || null, candidates: candidates || [] });
    if (row.po_id) {
      if (!ctx.poLoaded) return out('loading');
      const po = ctxIndex(ctx).poById.get(String(row.po_id));
      if (!po) return out('removed');
      const pid = row.project_id || ctx.projectId;
      if (pid && String(po.project_id || '') !== String(pid)) return out('moved', po, [po]);
      return out('linked', po, [po]);
    }
    if (row.po_auto === false) return out('nopo');
    const k = keyFn(ctx);
    const codes = liveCodes(row, ctx);
    const cc = ck(k, codes.cost_code), sc = ck(k, codes.sub_code);
    // A row with no codes would otherwise "match" every PO raised with blank
    // codes — and '+ New PO' saves one exactly like that. It matches none
    // whatever the list holds, so it does not wait for the list either.
    if (!cc && !sc) return out('none');
    // Nor does a hand-added row with a cost code and no sub code (one added
    // from a section header): a cost code alone names no material, and it
    // would take the order a sibling row raised for that code — a blank row
    // reading Ordered on someone else's PO.
    if (!codes.line && !sc) return out('none');
    if (!ctx.poLoaded) return out('loading');
    const pid = row.project_id || ctx.projectId;
    const cands = (ctx.purchaseOrders || []).filter(po => po
      && String(po.project_id || '') === String(pid || '')
      && ck(k, po.cost_code) === cc && ck(k, po.sub_code) === sc
      && vendorCompatible(row.vendor, po.supplier));
    if (cands.length === 1) return out('auto', cands[0], cands);
    if (cands.length > 1) return out('multiple', null, cands);
    return out('none', null, cands);
  }

  /** The row's own Date Ordered, else the date its PO was raised, else ''. */
  function effectiveDateOrdered(row, ctx) {
    const own = ymdOf(row.date_ordered);
    if (own) return own;
    const e = effectivePO(row, ctx);
    if ((e.kind === 'linked' || e.kind === 'auto') && e.po) return ymdOf(e.po.date_created);
    return '';
  }

  /** Date Needed minus Lead Time, in calendar days; '' unless both are set. */
  function orderBy(row) {
    const needed = ymdOf(row.date_needed);
    const lead = intOrNull(row.lead_time_days);
    if (!needed || lead == null) return '';
    return addDays(needed, -lead);
  }

  /**
   * Delivered / Ordered / Not Ordered — or UNKNOWN ('…') while the page's PO
   * list has not loaded and the row's own dates do not settle it: a row on a
   * PO would otherwise read (and count, flag and export) as Not Ordered and
   * Late until the list arrived.
   */
  const UNKNOWN = '…';
  function statusOf(row, ctx) {
    if (ymdOf(row.date_delivered)) return 'Delivered';
    if (ymdOf(row.date_ordered)) return 'Ordered';
    const e = effectivePO(row, ctx);
    if (e.kind === 'loading') return UNKNOWN;
    // A linked or matched PO is the order (effectiveDateOrdered dates it).
    if (e.kind === 'linked' || e.kind === 'auto') return 'Ordered';
    return 'Not Ordered';
  }

  /**
   * The warnings on a row. The key date is Order By when there is a lead time
   * (that is the day the order has to go in), else Date Needed.
   */
  function flagsOf(row, ctx) {
    const flags = [];
    const today = ymdOf(ctx.today);
    const status = statusOf(row, ctx);
    const needed = ymdOf(row.date_needed);
    const ob = orderBy(row);
    const key = ob || needed;
    const what = ob ? `Order by ${fmtDate(ob)}` : `Needed ${fmtDate(needed)}`;
    if (today && status === 'Not Ordered' && key) {
      if (key < today) {
        flags.push({ key: 'late', level: 'red', label: 'Late', title: `${what} has passed and nothing is ordered` });
      } else if (key <= addDays(today, DUE_SOON_DAYS)) {
        flags.push({ key: 'due_soon', level: 'amber', label: 'Due soon', title: `${what} — within ${DUE_SOON_DAYS} days and not ordered yet` });
      }
    } else if (today && status === 'Ordered' && needed && needed < today) {
      flags.push({ key: 'late_delivery', level: 'red', label: 'Late delivery', title: `Needed ${fmtDate(needed)} and not delivered yet` });
    }
    if (row.sca_status === 'Needed') {
      flags.push({ key: 'sca_open', level: 'amber', label: 'Sub agreement open', short: 'Sub agmt open', title: 'A sub-contractor agreement is needed and not executed yet' });
    }
    return flags;
  }

  /**
   * A bid row whose bid line's quantity (change orders included) or unit has
   * moved since it was sent, or since the user last acknowledged it. Null
   * when nothing changed, for hand-added rows, and when the line is gone.
   */
  function bidChange(row, ctx) {
    if (!row || row.source !== 'bid') return null;
    const line = lineFor(row, ctx);
    if (!line) return null;
    const toQty = numOrNull(line.quantity), fromQty = numOrNull(row.bid_qty_at_send);
    const toUnit = normUnit(line.unit), fromUnit = normUnit(row.bid_unit_at_send);
    const qtyChanged = !sameNum(fromQty, toQty);
    const unitChanged = toUnit !== fromUnit;
    if (!qtyChanged && !unitChanged) return null;
    const q = v => (v == null ? '—' : fmtQty(v));
    const label = unitChanged
      ? `bid ${q(fromQty)}${fromUnit ? ' ' + fromUnit : ''} → ${q(toQty)}${toUnit ? ' ' + toUnit : ''}`
      : `bid ${q(fromQty)} → ${q(toQty)}${toUnit ? ' ' + toUnit : ''}`;
    return { fromQty, toQty, fromUnit, toUnit, qtyChanged, unitChanged, label, line };
  }

  const lineOrder = (l, i) => (l && Number.isFinite(l.index) ? l.index : i);

  // The one bid line whose cost + sub code are a row's stored ones, or null
  // when none or several have them (two lines with the same codes cannot be
  // told apart, so neither is guessed at).
  function onlyLineFor(row, lines, k) {
    const cc = ck(k, row.cost_code), sc = ck(k, row.sub_code);
    if (!cc && !sc) return null;
    const cands = lines.filter(l => ck(k, l.cost_code) === cc && ck(k, l.sub_code) === sc);
    return cands.length === 1 ? cands[0] : null;
  }
  const byAge = (a, b) => ((Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)) || (String(a.id) < String(b.id) ? -1 : 1);
  // A row that names a bid line the bid no longer has.
  const orphaned = (r, lineIds) => !(r.bid_item_id != null && lineIds.has(String(r.bid_item_id)));

  /**
   * What Send to Procurement offers for a job: every bid line, grouped by cost
   * code in bid order, each one
   *   'new'      not in Procurement yet — unticked, like every line: the PM
   *              ticks what to add (a section's All ticks the section)
   *   'added'    a live bid row already has it — shown greyed, not sendable
   *   'removed'  a bid row had it and was deleted — unchecked; checking it
   *              restores that row (restoreId) instead of adding a second one
   * `rows` must include deleted rows (GET include_deleted=1).
   *
   * A row deleted before a Procore "Replace all" still names the OLD line's
   * id, which the bid no longer has, so it matches no line by id. It is the
   * one new line's 'removed' entry all the same when that line is the only
   * one with its cost + sub code and nothing else holds it — the PM removed
   * that material on purpose, and a re-import is no reason to offer it again
   * ticked. Its entry carries `relink` (the line's id and codes) for the
   * restore to put on the row; a deleted row cannot be PATCHed.
   *
   * A 'new' line whose material plainly has a row already carries a `hint`
   * saying so, so it is not ticked into a second row of it unawares:
   *   - `orphans`: live rows of the job that are "not on bid" (their line is
   *     gone) and carry this line's cost + sub code. The re-link only moves a
   *     row when exactly one line has its codes (section 1), so after a
   *     "Replace all" two lines with the same codes — the estimate's own
   *     duplicates, or two that differ only in case or spacing — are left to
   *     the PM; so is a row whose re-link failed.
   *   - `handRows`: hand-added rows coded off this very line, with no bid row
   *     on it ("+ Add Row", then the line picked in Sub Code).
   */
  function sendPlan(bidLines, rows, codeKey) {
    const k = typeof codeKey === 'function' ? codeKey : defaultCodeKey;
    const live = new Map(), dead = new Map(), hand = new Map();
    for (const r of rows || []) {
      if (!r || r.bid_item_id == null) continue;
      const key = String(r.bid_item_id);
      if (r.source !== 'bid') {
        if (!r.deleted_at) hand.set(key, (hand.get(key) || 0) + 1);
        continue;
      }
      if (r.deleted_at) { if (!dead.has(key)) dead.set(key, r); }
      else if (!live.has(key)) live.set(key, r);
    }
    const ordered = (bidLines || []).map((l, i) => ({ l, o: lineOrder(l, i) }))
      .filter(x => x.l && x.l.id != null)
      .sort((a, b) => a.o - b.o).map(x => x.l);
    const lineIds = new Set(ordered.map(l => String(l.id)));
    const bidRows = (rows || []).filter(r => r && r.source === 'bid' && orphaned(r, lineIds));
    // A live orphan's line is the re-link's to give it, not a deleted row's.
    const wanted = new Set();
    bidRows.filter(r => !r.deleted_at).forEach(r => { const l = onlyLineFor(r, ordered, k); if (l) wanted.add(String(l.id)); });
    const moved = new Map();     // line id -> the deleted orphan that had its material
    bidRows.filter(r => r.deleted_at).sort(byAge).forEach(r => {
      const l = onlyLineFor(r, ordered, k);
      const id = l && String(l.id);
      if (!l || live.has(id) || dead.has(id) || wanted.has(id) || moved.has(id)) return;
      moved.set(id, r);
    });
    // Live rows of the job whose line is gone, by their codes.
    const codesOf = (cc, sc) => ck(k, cc) + '\u0000' + ck(k, sc);
    const orphanRows = new Map();
    (rows || []).filter(r => r && !r.deleted_at && (r.source === 'bid' || r.bid_item_id != null) && orphaned(r, lineIds))
      .forEach(r => {
        if (!ck(k, r.cost_code) && !ck(k, r.sub_code)) return;
        const key = codesOf(r.cost_code, r.sub_code);
        if (!orphanRows.has(key)) orphanRows.set(key, []);
        orphanRows.get(key).push(String(r.id));
      });
    const groups = [], byCode = new Map();
    const counts = { total: 0, new: 0, added: 0, removed: 0, checked: 0 };
    for (const line of ordered) {
      const id = String(line.id);
      let entry;
      if (live.has(id)) entry = { line, state: 'added', checked: false, restoreId: null, rowId: live.get(id).id };
      else if (dead.has(id)) entry = { line, state: 'removed', checked: false, restoreId: dead.get(id).id, rowId: dead.get(id).id };
      else if (moved.has(id)) {
        entry = { line, state: 'removed', checked: false, restoreId: moved.get(id).id, rowId: moved.get(id).id,
          relink: { bid_item_id: id, cost_code: str(line.cost_code), sub_code: str(line.sub_code) } };
      } else {
        entry = { line, state: 'new', checked: false, restoreId: null, rowId: null };
        const orphans = orphanRows.get(codesOf(line.cost_code, line.sub_code)) || [];
        const handRows = hand.get(id) || 0;
        if (orphans.length) {
          entry.orphans = orphans.slice();
          entry.hint = `${orphans.length} row${orphans.length === 1 ? '' : 's'} on this job ${orphans.length === 1 ? 'has' : 'have'} these codes but ${orphans.length === 1 ? 'is' : 'are'} not on the bid`;
        } else if (handRows) {
          entry.handRows = handRows;
          entry.hint = handRows === 1 ? 'has a hand-added row' : `has ${handRows} hand-added rows`;
        }
      }
      const code = String(line.cost_code == null ? '' : line.cost_code).trim();
      let g = byCode.get(code);
      if (!g) { g = { cost_code: code, lines: [] }; byCode.set(code, g); groups.push(g); }
      g.lines.push(entry);
      counts.total++;
      counts[entry.state]++;
      if (entry.checked) counts.checked++;
    }
    return { groups, counts };
  }

  /**
   * After a Procore "Replace all" every bid line has a new id, so every row
   * tied to the old bid points at a line that no longer exists. Each such
   * live row is re-linked to the new line with the same cost + sub code —
   * but only when exactly one line has those codes (two lines with the same
   * codes cannot be told apart).
   *   - A row sent from the bid takes the line only when no other bid row,
   *     live or deleted, already holds it (the database allows one bid row
   *     per line, deleted rows included, so a deleted row's line stays its
   *     own). Earlier rows win a line two orphans both want.
   *   - A hand-added row ("+ Material", or coded off a bid line) just follows
   *     its line: any number of those may share one.
   * Deleted rows are left alone here: a deleted row cannot be edited (Send to
   * Procurement offers it back on the new line instead — see sendPlan).
   * Returns the PATCHes to make: [{ id, bid_item_id, cost_code, sub_code }].
   */
  function relinkPlan(bidLines, rows, codeKey) {
    const k = typeof codeKey === 'function' ? codeKey : defaultCodeKey;
    const lines = (bidLines || []).filter(l => l && l.id != null);
    const lineIds = new Set(lines.map(l => String(l.id)));
    const claimed = new Set();
    for (const r of rows || []) {
      if (r && r.source === 'bid' && r.bid_item_id != null && lineIds.has(String(r.bid_item_id))) claimed.add(String(r.bid_item_id));
    }
    const live = (rows || []).filter(r => r && !r.deleted_at && orphaned(r, lineIds));
    const out = [];
    const take = (r, l) => out.push({ id: r.id, bid_item_id: String(l.id), cost_code: str(l.cost_code), sub_code: str(l.sub_code) });
    live.filter(r => r.source === 'bid').sort(byAge).forEach(r => {
      const l = onlyLineFor(r, lines, k);
      if (!l || claimed.has(String(l.id))) return;
      claimed.add(String(l.id));
      take(r, l);
    });
    // A hand-added row with no line at all was never tied to the bid.
    live.filter(r => r.source !== 'bid' && r.bid_item_id != null).sort(byAge).forEach(r => {
      const l = onlyLineFor(r, lines, k);
      if (l) take(r, l);
    });
    return out;
  }

  /**
   * The stored cost + sub code of a row is only what it falls back to when
   * its line is gone — and what the re-link above matches a new line by. A
   * line renamed on the bid page ("Perf Drain 15\"" → "Perimeter Drain 15in
   * Perf") shows the new name on the sheet at once, but the stored copy kept
   * the old one, so after a later "Replace all" with the new spelling the
   * row would find no line. This brings the stored copy of each live row
   * whose line is still there up to that line's codes. A line whose code was
   * just blanked (half way through being renamed) is left until it has one.
   * Returns PATCHes in relinkPlan's shape (`sync: true`).
   */
  function codeSyncPlan(bidLines, rows, codeKey) {
    const k = typeof codeKey === 'function' ? codeKey : defaultCodeKey;
    const byId = new Map((bidLines || []).filter(l => l && l.id != null).map(l => [String(l.id), l]));
    const out = [];
    for (const r of rows || []) {
      if (!r || r.deleted_at || r.bid_item_id == null) continue;
      const l = byId.get(String(r.bid_item_id));
      if (!l) continue;
      const lc_ = ck(k, l.cost_code), ls = ck(k, l.sub_code), rc = ck(k, r.cost_code), rs = ck(k, r.sub_code);
      if (lc_ === rc && ls === rs) continue;
      if ((!lc_ && rc) || (!ls && rs)) continue;
      out.push({ id: r.id, bid_item_id: String(l.id), cost_code: str(l.cost_code), sub_code: str(l.sub_code), sync: true });
    }
    return out;
  }

  /**
   * Bid order: by the bid line's position, the row sent from the bid ahead of
   * the materials added under it, then oldest first. Rows whose line is not
   * on the bid (or never was) go last. On a site's sheet each job's rows come
   * together, the jobs in the order the site lists them, each in its own
   * bid's order.
   */
  function sortRows(rows, ctx) {
    const pos = new Map(), jobAt = new Map();
    const byJob = ctx.bidLinesByProject;
    const lineKey = (pid, id) => (byJob ? `${pid}\u0000${id}` : String(id));
    if (byJob) {
      [...byJob.keys()].forEach((pid, i) => jobAt.set(String(pid), i));
      byJob.forEach((lines, pid) => (lines || []).forEach((l, i) => {
        if (l && l.id != null) pos.set(lineKey(String(pid), String(l.id)), lineOrder(l, i));
      }));
    } else {
      (ctx.bidLines || []).forEach((l, i) => { if (l && l.id != null) pos.set(String(l.id), lineOrder(l, i)); });
    }
    const job = r => (byJob ? (jobAt.has(String(r.project_id)) ? jobAt.get(String(r.project_id)) : Infinity) : 0);
    const at = r => {
      const p = r.bid_item_id != null ? pos.get(lineKey(String(r.project_id || ''), String(r.bid_item_id))) : undefined;
      return p === undefined ? Infinity : p;
    };
    const time = r => Date.parse(r.created_at) || 0;
    return (rows || []).slice().sort((a, b) => {
      const ja = job(a), jb = job(b);
      if (ja !== jb) return ja < jb ? -1 : 1;
      const pa = at(a), pb = at(b);
      if (pa !== pb) return pa < pb ? -1 : 1;
      const sa = a.source === 'bid' ? 0 : 1, sb = b.source === 'bid' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ta = time(a), tb = time(b);
      if (ta !== tb) return ta - tb;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });
  }

  function poText(e) {
    switch (e.kind) {
      case 'linked': case 'auto': return str(e.po && e.po.po_number) || '(no number)';
      case 'multiple': return `${e.candidates.length} POs match`;
      case 'removed': return 'PO removed';
      case 'moved': return 'PO on another job';
      case 'nopo': return 'No PO';
      case 'loading': return '…';
      default: return '';
    }
  }

  /** A column's displayed text — what the filters list and the search reads. */
  function fieldValue(row, field, ctx) {
    switch (field) {
      case 'status': return statusOf(row, ctx);
      case 'po': return poText(effectivePO(row, ctx));
      case 'sca_status': return row.sca_status || 'Pending';
      case 'date_needed': return fmtDate(row.date_needed);
      case 'lead_time_days': return row.lead_time_days == null ? '' : String(row.lead_time_days);
      case 'order_by': return fmtDate(orderBy(row));
      case 'date_ordered': return fmtDate(effectiveDateOrdered(row, ctx));
      case 'date_delivered': return fmtDate(row.date_delivered);
      case 'quantity': return fmtQty(row.quantity);
      case 'cost_code': return liveCodes(row, ctx).cost_code;
      case 'sub_code': return liveCodes(row, ctx).sub_code;
      // The Material as the sheet shows it: the row's own, else its Sub Code.
      case 'description': return materialOf(row, ctx);
      // The job a row is on, named — only on a site's sheet, where there is
      // more than one.
      case 'job': return ctx && ctx.jobLabels ? ctx.jobLabels.get(String(row.project_id || '')) || '' : '';
      default: return str(row[field]);
    }
  }

  const SEARCH_FIELDS = ['job', 'status', 'po', 'sca_status', 'date_needed', 'order_by', 'date_ordered', 'date_delivered',
    'quantity', 'unit', 'cost_code', 'sub_code', 'description', 'vendor', 'quote_number', 'contact', 'email'];

  /**
   * The quick chips. "Due in 14 days" is what has to happen in the next two
   * weeks: for a row not ordered yet, its key date (Order By, else Date
   * Needed); for one ordered and not delivered, the day it is needed on site.
   */
  function chipMatch(chip, row, ctx) {
    const status = statusOf(row, ctx);
    switch (chip) {
      case 'not_ordered': return status === 'Not Ordered';
      case 'not_delivered': return status !== 'Delivered';
      case 'sca_open': return row.sca_status === 'Needed';
      case 'late': return flagsOf(row, ctx).some(f => f.level === 'red');
      case 'due14': {
        const today = ymdOf(ctx.today);
        if (!today || status === 'Delivered' || status === UNKNOWN) return false;
        const d = status === 'Not Ordered' ? (orderBy(row) || ymdOf(row.date_needed)) : ymdOf(row.date_needed);
        return !!d && d >= today && d <= addDays(today, DUE_SOON_DAYS);
      }
      default: return true;
    }
  }

  /**
   * state = { search, filters: { field: Set|Array of displayed values }, chip }.
   * Every word of the search has to appear somewhere in the row; the column
   * filters keep a row whose displayed value is one of the ticked ones.
   */
  /**
   * A column the page has hidden (cfg.hiddenColumns, by key — turf hides
   * Description for now): left out of the sheet, its search, the Excel / CSV
   * files and the print view. What is stored in it is kept, and it comes
   * back as it was once the page stops hiding it.
   */
  const colHidden = key => Array.isArray(cfg.hiddenColumns) && cfg.hiddenColumns.includes(key);

  function applyFilters(rows, state, ctx) {
    const s = state || {};
    const words = lc(s.search).split(' ').filter(Boolean);
    const filters = Object.entries(s.filters || {}).filter(([f, set]) => set && (set.size || set.length) && !colHidden(f));
    const chip = s.chip || 'all';
    return (rows || []).filter(row => {
      for (const [field, set] of filters) {
        const v = fieldValue(row, field, ctx);
        if (!(Array.isArray(set) ? set.includes(v) : set.has(v))) return false;
      }
      if (chip !== 'all' && !chipMatch(chip, row, ctx)) return false;
      if (words.length) {
        const hay = SEARCH_FIELDS.filter(f => !colHidden(f)).map(f => fieldValue(row, f, ctx))
          .concat(flagsOf(row, ctx).map(f => f.label), [row.date_needed, row.date_ordered, row.date_delivered])
          // The agreement as its tag in the Status cell reads ("Agmt needed").
          .concat(colHidden('sca_status') ? [] : [SCA_SHORT[row.sca_status] || ''])
          .join(' ').toLowerCase();
        if (!words.every(w => hay.includes(w))) return false;
      }
      return true;
    });
  }

  // Quoting makes a CSV field parse; it does not stop a spreadsheet EVALUATING
  // one that begins with = + - @ (a vendor typed as =HYPERLINK(...) runs when
  // the export is opened). A leading apostrophe defuses it — but not for a
  // plain number, which would turn into text and drop out of every sum. The
  // same rule as tracker.html's exportPOCSV.
  const CSV_NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
  function csvEscape(v) {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(t) && !CSV_NUMERIC.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  }

  // ── Export (CSV + hand-written XLSX) ────────────────────────────────
  // The table's columns minus the checkbox and the row buttons, as shown.
  const EXPORT_COLS = [
    // Which job the row is on — a site's sheet only, where the file holds
    // several. First, so the file sorts and filters by job straight away.
    { label: 'Job', width: 24, site: true, get: (r, c) => ({ t: 's', v: fieldValue(r, 'job', c) }) },
    { label: 'Status', width: 13, get: (r, c) => ({ t: 's', v: statusOf(r, c) }) },
    { label: 'PO #', width: 12, get: (r, c) => ({ t: 's', v: poText(effectivePO(r, c)) }) },
    { label: 'Sub-Contractor Agreement', width: 14, get: r => ({ t: 's', v: r.sca_status || 'Pending' }) },
    { label: 'Date Needed', width: 12, get: r => ({ t: 'd', v: ymdOf(r.date_needed) }) },
    { label: 'Lead Time (days)', width: 10, get: r => ({ t: 'n', v: r.lead_time_days }) },
    { label: 'Order By', width: 12, get: r => ({ t: 'd', v: orderBy(r) }) },
    { label: 'Date Ordered', width: 12, get: (r, c) => ({ t: 'd', v: effectiveDateOrdered(r, c) }) },
    { label: 'Date Delivered', width: 12, get: r => ({ t: 'd', v: ymdOf(r.date_delivered) }) },
    { label: 'Quantity', width: 10, get: r => ({ t: 'n', v: r.quantity }) },
    { label: 'Unit', width: 7, get: r => ({ t: 's', v: r.unit }) },
    // What is bought, as the sheet shows it (a row with no name of its own
    // is its Sub Code) — the file goes to suppliers and the field, who order
    // by the material, not by our codes.
    { key: 'description', label: 'Material', width: 34, get: (r, c) => ({ t: 's', v: materialOf(r, c) }) },
    { label: 'Cost Code', width: 24, get: (r, c) => ({ t: 's', v: liveCodes(r, c).cost_code }) },
    { label: 'Sub Code', width: 26, get: (r, c) => ({ t: 's', v: liveCodes(r, c).sub_code }) },
    { label: 'Vendor', width: 22, get: r => ({ t: 's', v: r.vendor }) },
    { label: 'Quote #', width: 14, get: r => ({ t: 's', v: r.quote_number }) },
    { label: 'Contact', width: 18, get: r => ({ t: 's', v: r.contact }) },
    { label: 'Email', width: 26, get: r => ({ t: 's', v: r.email }) },
    // The warnings the table shows beside the values — the Status flags, "not
    // on bid", "bid changed" — are what a PM chases orders by, so the file
    // carries them too. In a column of their own, after the sheet's, so the
    // Status and Cost Code columns still filter and sort on clean values and
    // Quantity stays a number.
    { label: 'Notes', width: 34, get: (r, c) => ({ t: 's', v: exportNotes(r, c) }) },
  ];

  function exportNotes(r, c) {
    const notes = flagsOf(r, c).map(f => f.label);
    const live = liveCodes(r, c);
    if (live.notOnBid) notes.push('Not on bid');
    if (live.costGone) notes.push('Cost code not on bid');
    const bc = bidChange(r, c);
    if (bc) notes.push(`Bid changed: ${bc.label}`);
    return notes.join('; ');
  }

  // The file's columns: the sheet's, less any the page hides (and Job, but
  // on a site's sheet).
  const exportCols = ctx => EXPORT_COLS.filter(c => (!c.key || !colHidden(c.key)) && (!c.site || !!(ctx && ctx.site)));
  function exportMatrix(rows, ctx) {
    const cols = exportCols(ctx);
    return {
      header: cols.map(c => c.label),
      widths: cols.map(c => c.width),
      rows: (rows || []).map(r => cols.map(c => c.get(r, ctx))),
    };
  }

  function buildCsv(rows, ctx) {
    const m = exportMatrix(rows, ctx);
    const cell = c => (c.v == null ? '' : c.t === 'n' ? String(c.v) : c.v);
    const lines = [m.header.map(csvEscape).join(',')]
      .concat(m.rows.map(r => r.map(c => csvEscape(cell(c))).join(',')));
    // The byte-order mark is what makes Excel read the file as UTF-8, so a
    // "—" or an accented vendor name does not arrive as mojibake.
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  // The ZIP writer is bid-xlsx.js's, copied: stored (uncompressed) entries
  // and a CRC-32 table, no library. That file keeps its helpers private.
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function zipBytes(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = enc.encode(f.data);
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
      crc = (crc ^ 0xFFFFFFFF) >>> 0;

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // local file header
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0x0800, true);       // UTF-8 names
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); // stored: compressed = uncompressed
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      chunks.push(local, data);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);   // central directory entry
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);
      central.push(cd);
      offset += local.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);     // end of central directory
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return chunks.concat(central, [end]);
  }

  const xesc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // XML 1.0 cannot carry these, and Excel refuses the whole file over one.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  function colName(n) {
    let s = '';
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }
  // Days since 1899-12-30, off the date's own fields so it never slips a day.
  function dateSerial(ymd) {
    const d = ymdOf(ymd);
    return d ? Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000) + 25569 : null;
  }

  // The parts of the workbook, as { name, data } — split from the Blob so a
  // test can read the XML without unzipping anything.
  function xlsxParts(rows, ctx) {
    const m = exportMatrix(rows, ctx);
    const SHEET = 'Procurement';
    const S_HEAD = 1, S_DATE = 2;          // cellXfs indexes in styles below
    const cellXml = (ref, c, head) => {
      if (head) return `<c r="${ref}" s="${S_HEAD}" t="inlineStr"><is><t xml:space="preserve">${xesc(c)}</t></is></c>`;
      if (c.t === 'n') {
        const n = numOrNull(c.v);
        return n == null ? '' : `<c r="${ref}"><v>${Math.round(n * 1e6) / 1e6}</v></c>`;
      }
      if (c.t === 'd') {
        const serial = dateSerial(c.v);
        return serial == null ? '' : `<c r="${ref}" s="${S_DATE}"><v>${serial}</v></c>`;
      }
      return c.v == null || c.v === '' ? ''
        : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(c.v)}</t></is></c>`;
    };
    const lastCol = colName(m.header.length);
    const lastRow = m.rows.length + 1;
    const sheetRows = [`<row r="1" ht="30" customHeight="1">${m.header.map((h, i) => cellXml(colName(i + 1) + 1, h, true)).join('')}</row>`]
      .concat(m.rows.map((r, ri) => `<row r="${ri + 2}">${r.map((c, ci) => cellXml(colName(ci + 1) + (ri + 2), c)).join('')}</row>`));
    const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<dimension ref="A1:${lastCol}${lastRow}"/>`
      // The header row stays put while scrolling, as it does on screen.
      + '<sheetViews><sheetView tabSelected="1" workbookViewId="0">'
      + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
      + '</sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + '<cols>' + m.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
      + '<sheetData>' + sheetRows.join('') + '</sheetData>'
      // The filter arrows the old sheet had on every column.
      + `<autoFilter ref="A1:${lastCol}${lastRow}"/>`
      + '<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
      + '<pageSetup orientation="landscape"/>'
      + '</worksheet>';
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<numFmts count="1"><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/></numFmts>'
      + '<fonts count="2">'
      + '<font><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font>'
      + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>'
      + '</fonts>'
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
      + '<fill><patternFill patternType="solid"><fgColor rgb="FF166534"/><bgColor indexed="64"/></patternFill></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="3">'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
      + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
      + '</cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const ct = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
    return [
      { name: '[Content_Types].xml', data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + `<Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/>`
        + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.worksheet+xml"/>`
        + `<Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/>`
        + '</Types>' },
      { name: '_rels/.rels', data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/>`
        + '</Relationships>' },
      { name: 'xl/workbook.xml', data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}">`
        + '<bookViews><workbookView activeTab="0"/></bookViews>'
        + `<sheets><sheet name="${SHEET}" sheetId="1" r:id="rId1"/></sheets>`
        + `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${SHEET}'!$A$1:$${lastCol}$${lastRow}</definedName>`
        + `<definedName name="_xlnm.Print_Titles" localSheetId="0">'${SHEET}'!$1:$1</definedName></definedNames>`
        + '</workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>`
        + `<Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/>`
        + '</Relationships>' },
      { name: 'xl/styles.xml', data: styles },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    ];
  }
  const buildXlsx = (rows, ctx) => new Blob(zipBytes(xlsxParts(rows, ctx)), { type: XLSX_MIME });

  function download(blob, filename) {
    if (!window.URL || typeof URL.createObjectURL !== 'function') { console.warn('[procurement] downloads unsupported here'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // On a timer, not at once: Safari reads the blob after click() returns,
    // and revoking it first downloads an empty file.
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportName(ext) {
    const p = project(st.projectId) || {};
    const name = siteMode() ? `${siteLabel(st.projectId)} (site)` : str(p['project-name']) || str(p['job-number']) || 'Job';
    const safe = name.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '-').trim();
    return `Procurement - ${safe} - ${today()}.${ext}`;
  }

  // ── Page state ──────────────────────────────────────────────────────
  const st = {
    mountEl: null,
    // What is open: a job's id, or a site's key ('site:<name>' — every job
    // with that Site on one sheet; see Sites below).
    projectId: null,
    rows: [],
    loadState: 'none',        // 'none' | 'loading' | 'ok' | 'error'
    loadError: '',
    loadedFor: null,          // viewSig() of what the rows in hand were read for
    serverCanEdit: null,      // what the API said (null until it has)
    showAll: false,
    search: '',
    filters: {},              // field -> Set of displayed values
    chip: 'all',
    grouping: 'cost',         // 'cost' | 'vendor' | 'none'
    collapsed: new Set(),     // group keys folded shut
    selected: new Set(),
    // Rows just added, shown even when the filters would hide them — a row
    // that vanished the moment "+ Add Row" made it would read as a failure.
    // Forgotten the next time the user changes a filter.
    forceShow: new Set(),
    confirmDel: null,         // row id whose ✕ is asking "Delete?"
    bulkField: 'vendor',
    bulkConfirmDel: false,
    saveState: 'idle',
    prefsFor: null,
  };
  let loadGen = 0;

  // Saving. Edits collect per row in `pend` and go as one PATCH after a quiet
  // spell; `fly` is what has been sent and not answered; `server` is each
  // row as the server last returned it, which is what "unchanged" means.
  const pend = new Map();       // row id -> { field: value }
  const fly = new Map();        // row id -> { field: value } in flight
  const server = new Map();     // row id -> server copy
  const timers = new Map();     // row id -> debounce timer
  const failed = new Set();     // rows whose last save failed (retried on the next edit / refresh)
  let savedTimer = null;
  // What the person saw in each cell they are changing — the server's value
  // (or their own value still on its way) when they started — sent with the
  // save as `expect`, so a cell someone else changed meanwhile is not written
  // over unseen (the server answers "conflict" instead; see onConflict).
  const bases = new Map();      // row id -> { field: value seen } for the fields in pend
  const flyBases = new Map();   // row id -> { field: value seen } for the fields in fly
  // The value a cell showed when it took focus, by "row\0field": a box that
  // commits when it is left (the pickers) is saved after the fact, and a
  // colleague's save answered meanwhile must not become what it "saw".
  const seenAtFocus = new Map();
  // Cells other people changed, as polls brought them in: row id ->
  // { fields: Map(field -> { by, at }), added: { by, at } | null, until }.
  const recent = new Map();
  let RECENT_MS = 2 * 60 * 1000;          // (a test shortens it: _test.setRecentMs)

  // ── Host helpers ────────────────────────────────────────────────────
  function canEdit() {
    return !!(cfg.perm && cfg.perm.canEdit) && st.serverCanEdit !== false;
  }
  function today() {
    try { return ymdOf(typeof cfg.today === 'function' ? cfg.today() : '') || localToday(); } catch { return localToday(); }
  }
  function project(id) {
    if (!id) return null;
    try {
      const p = typeof cfg.getProject === 'function' ? cfg.getProject(id) : null;
      if (p) return p;
    } catch { /* fall through to the list */ }
    return projects().find(p => p.id === id) || null;
  }
  function projects() {
    try { return (cfg.getProjects() || []).filter(p => p && p.id); } catch { return []; }
  }
  function projLabel(p) {
    return str(p && p['project-name']).trim() || (p && p['job-number'] ? 'Job #' + p['job-number'] : '') || str(p && p.id);
  }

  // ── Sites ───────────────────────────────────────────────────────────
  // A site is the jobs that share a Site name on the job page (p.site): the
  // Hempfield fields, say — each its own job, with its own bid, rows, POs and
  // costs, but bought for at one time. The picker offers the site beside its
  // jobs, keyed 'site:<name in lower case>', and opening it puts every one of
  // its jobs on one sheet. Each row stays on its own job: it is read, saved,
  // attached to and ordered against that job exactly as on the job's own
  // sheet, and the sheet keeps the jobs apart (a band per job under the
  // cost-code grouping, a Job column in every grouping).
  //
  // A site holds the jobs the picker would list — the live ones, or every
  // one with "Show all jobs" ticked — so a finished field drops off its
  // site's sheet the way it drops off the picker.
  const SITE = 'site:';
  const JOB = 'j:';                  // a job band's group key, + the job id
  const isSiteKey = k => typeof k === 'string' && k.startsWith(SITE);
  const siteName = p => str(p && p.site).replace(/\s+/g, ' ').trim();
  const isLive = p => LIVE_STATUSES.has(lc(p && p.status));
  function siteJobs(key, { all = st.showAll } = {}) {
    if (!isSiteKey(key)) return [];
    const want = key.slice(SITE.length);
    return projects().filter(p => lc(siteName(p)) === want && (all || isLive(p)))
      .sort((a, b) => projLabel(a).localeCompare(projLabel(b)) || String(a.id).localeCompare(String(b.id)));
  }
  /** The site's name as typed on its jobs (the first job's spelling). */
  function siteLabel(key) {
    const p = siteJobs(key, { all: true })[0];
    return p ? siteName(p) : String(key || '').slice(SITE.length);
  }
  const siteOptLabel = (name, n) => `${name} — all ${n} job${n === 1 ? '' : 's'}`;
  /** The jobs a key opens: the job itself, or the site's jobs. */
  function openIds(key = st.projectId) {
    if (!key) return [];
    return isSiteKey(key) ? siteJobs(key).map(p => String(p.id)) : [String(key)];
  }
  const siteMode = () => isSiteKey(st.projectId);
  const isOpenJob = pid => !!pid && openIds().includes(String(pid));
  /**
   * What a key opens, as one string. A site whose jobs change under it (a
   * field marked complete, the Site typed on another job, Show all jobs
   * ticked) is a different sheet, read again; a job is just its id.
   */
  const viewSig = (key = st.projectId) => (isSiteKey(key) ? `${key}|${openIds(key).join(',')}` : key || null);
  /** Whether a key still names something: a job on the list, or a site one has. */
  function keyExists(key) {
    if (!key) return false;
    return isSiteKey(key) ? siteJobs(key, { all: true }).length > 0 : !!project(key);
  }
  /** What the picker shows for a key. */
  function openLabel(key = st.projectId) {
    if (!key) return '';
    if (isSiteKey(key)) return siteOptLabel(siteLabel(key), openIds(key).length);
    const p = project(key);
    return p ? projLabel(p) : '';
  }
  /** A job's name, as the sheet shows it (its Job column, its band). */
  function jobName(pid) {
    const p = project(pid);
    return p ? projLabel(p) : 'Job';
  }
  /**
   * The job a site-wide action is for: the open job, or on a site's sheet,
   * the one picked (null when the PM cancels). A site of one job asks nothing.
   */
  function pickJob(title, question) {
    if (!siteMode()) return Promise.resolve(st.projectId);
    const ids = openIds();
    if (ids.length <= 1) return Promise.resolve(ids[0] || null);
    return choose(title, `<p style="margin:0;line-height:1.5">${esc(question)}</p>`,
      ids.map(pid => {
        const p = project(pid) || {};
        return { value: pid, label: projLabel(p) + (p['job-number'] ? ` (#${p['job-number']})` : '') };
      }).concat([{ value: null, label: 'Cancel' }]));
  }
  function suppliers() {
    try { return (cfg.getSuppliers() || []).map(s => (typeof s === 'string' ? s : s && s.name)).filter(Boolean); } catch { return []; }
  }
  function canonicalSupplier(name) {
    const n = lc(name);
    return (n && suppliers().find(s => lc(s) === n)) || String(name || '').trim();
  }
  function showError(msg) {
    try { cfg.showSaveError(msg); } catch (e) { console.warn('[procurement]', msg, e); }
  }
  // How many documents the page knows of, attached to one line or filed in
  // one cost code's folder. Only ever a number on a button, so anything odd
  // from the page — no hook, a throw, a string, a negative — reads as none
  // rather than taking the row's drawing down with it.
  function docCount(hook, ...args) {
    if (typeof hook !== 'function') return 0;
    let n = 0;
    try { n = Number(hook(...args)); } catch { return 0; }
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  const attachmentCount = (projectId, rowId) => docCount(cfg.attachmentCount, projectId, rowId);
  const costCodeDocCount = (projectId, code) => docCount(cfg.costCodeDocCount, projectId, code);

  function makeCtx(projectId) {
    const key = projectId === undefined ? st.projectId : projectId;
    const site = isSiteKey(key);
    const pid = site ? null : key;
    let purchaseOrders = [], bidLines = [], poLoaded = true;
    let bidLinesByProject = null, jobLabels = null;
    try { purchaseOrders = cfg.getPurchaseOrders() || []; } catch { /* none */ }
    if (site) {
      // Each job's own bid, and its name for the Job column.
      bidLinesByProject = new Map();
      jobLabels = new Map();
      openIds(key).forEach(id => {
        let lines = [];
        try { lines = cfg.getBidLines(id) || []; } catch { /* none */ }
        bidLinesByProject.set(id, lines);
        jobLabels.set(id, jobName(id));
      });
      bidLines = [].concat(...bidLinesByProject.values());
    } else {
      try { bidLines = pid ? (cfg.getBidLines(pid) || []) : []; } catch { /* none */ }
    }
    try { poLoaded = typeof cfg.isPOListLoaded === 'function' ? !!cfg.isPOListLoaded() : true; } catch { poLoaded = false; }
    // Not loaded because the read FAILED (and is being retried), rather than
    // still on its way — said differently on screen.
    let poFailed = false;
    try { poFailed = !poLoaded && typeof cfg.poLoadFailed === 'function' && !!cfg.poLoadFailed(); } catch { poFailed = false; }
    return {
      purchaseOrders, bidLines, poLoaded, poFailed,
      codeKey: typeof cfg.codeKey === 'function' ? cfg.codeKey : defaultCodeKey,
      today: today(),
      // The open job; null on a site's sheet, where every row names its own.
      projectId: pid,
      site, bidLinesByProject, jobLabels,
      // Empty when the page's lists have not loaded: then nothing is marked
      // "not on the supplier list".
      supplierKeys: new Set(suppliers().map(lc)),
    };
  }

  const storeKey = what => `fct_proc_${what}_${cfg.division}`;
  function storeGet(what) {
    try { return cfg.storage ? cfg.storage.getItem(storeKey(what)) : null; } catch { return null; }
  }
  function storeSet(what, value) {
    try {
      if (!cfg.storage) return;
      if (value == null || value === '') cfg.storage.removeItem(storeKey(what));
      else cfg.storage.setItem(storeKey(what), String(value));
    } catch { /* private window, full quota — the preference just is not kept */ }
  }
  function loadPrefs() {
    if (st.prefsFor === cfg.division) return;
    st.prefsFor = cfg.division;
    const g = storeGet('group');
    if (g === 'cost' || g === 'vendor' || g === 'none') st.grouping = g;
    st.showAll = storeGet('showall') === '1';
    if (!st.projectId) st.projectId = storeGet('project') || null;
  }

  // ── API ─────────────────────────────────────────────────────────────
  const ERR_TEXT = {
    read_only: 'You have view-only access to Procurement.',
    forbidden: 'You do not have access to Procurement.',
    not_found: 'That row no longer exists — someone may have deleted it.',
    duplicate: 'That row already exists.',
    stale_bid: 'that bid line is no longer on the job\'s bid (it was changed somewhere else) — reload the page',
  };
  function q(params) {
    const parts = [`division=${encodeURIComponent(cfg.division)}`];
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== null && v !== undefined && v !== '') parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    return '?' + parts.join('&');
  }
  async function api(method, path, body, opts = {}) {
    let token = '';
    try { token = cfg.getToken() || ''; } catch { /* signed out */ }
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    // keepalive lets a save started as the page is closed outlive the page.
    if (opts.keepalive) init.keepalive = true;
    let r;
    try {
      r = await fetch(`${cfg.apiBase || '/api'}${path}`, init);
    } catch (e) {
      // No answer at all — offline, the connection dropped, a blocked
      // request. The browser's own words ("Failed to fetch") say nothing to
      // a PM. No status: the caller cannot tell whether the server acted.
      const err = new Error('could not reach the server — check the connection');
      err.status = 0;
      err.code = 'network';
      err.field = '';
      err.network = true;
      err.cause = e;
      throw err;
    }
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    if (!r.ok || (data && data.ok === false)) {
      const code = data && data.error;
      const msg = r.status === 401 ? 'Your session expired. Please sign in again.'
        : (data && data.message) || ERR_TEXT[code] || (code && /\s/.test(code) ? code : '')
          || `Request failed (${r.status})`;
      const err = new Error(msg);
      err.status = r.status;
      err.code = code || '';
      // The column the server refused, when it was one value (api/procurement.js
      // names it). A save uses it to put back just that cell and send the rest.
      err.field = data && typeof data.field === 'string' ? data.field : '';
      // The whole answer, for a refusal that carries more than a message (a
      // "conflict" names the cells someone else changed, and the row as it is).
      err.data = data || null;
      throw err;
    }
    return data || {};
  }

  // ── Toast + modal (the documents.js shells) ─────────────────────────
  function toast(message, kind) {
    // A combobox commits twice (on Tab or a pick, and again as it blurs), so
    // whatever it says would be said twice, stacked.
    if ([...document.querySelectorAll('.fctproc-toast')].some(t => t.textContent === message)) return;
    const el = document.createElement('div');
    el.textContent = message;
    el.className = 'fctproc-toast';
    el.style.cssText = `
      position:fixed;bottom:1.25rem;left:50%;transform:translateX(-50%);z-index:${Z + 20};
      background:var(--surface2,#1a1a26);color:var(--text,#e0e0e0);
      border:1px solid ${kind === 'error' ? 'var(--red,#ef4444)' : 'var(--green,#22c55e)'};
      border-left-width:3px;padding:0.6rem 1rem;border-radius:4px;font-size:0.85rem;
      box-shadow:0 8px 24px rgba(0,0,0,0.5);max-width:min(90vw,520px)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
  }

  function modal(title, bodyHTML, { wide = false, footHTML = '' } = {}) {
    // The bid page opens Send to Procurement before the tab has ever been
    // drawn, and the checklist's rows, groups and tags are styled by the
    // shared sheet — without it they run together as bare inline text.
    injectStyles();
    const back = document.createElement('div');
    back.className = 'fctproc-modal';
    back.style.cssText = `position:fixed;inset:0;z-index:${Z};background:rgba(0,0,0,0.6);
                          display:flex;align-items:center;justify-content:center;padding:1rem`;
    back.innerHTML = `
      <div role="dialog" aria-modal="true" aria-label="${esc(title)}"
           style="background:var(--surface,#111118);border:1px solid var(--border,#2a2a3a);border-radius:6px;
                  width:${wide ? 'min(52rem,95vw)' : 'min(32rem,95vw)'};max-height:90vh;display:flex;flex-direction:column;
                  color:var(--text,#e0e0e0);font-size:0.82rem">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:0.75rem 1rem;
                    border-bottom:1px solid var(--border,#2a2a3a)">
          <span style="font-weight:700;font-size:0.9rem;letter-spacing:0.04em;text-transform:uppercase">${esc(title)}</span>
          <button type="button" data-close style="background:none;border:none;color:var(--muted,#666);font-size:1.1rem;cursor:pointer" title="Close">&#10005;</button>
        </div>
        <div style="padding:0.9rem 1rem;overflow:auto;flex:1 1 auto" data-body>${bodyHTML}</div>
        ${footHTML ? `<div data-foot style="display:flex;align-items:center;gap:0.5rem;justify-content:flex-end;flex-wrap:wrap;
                     padding:0.7rem 1rem;border-top:1px solid var(--border,#2a2a3a)">${footHTML}</div>` : ''}
      </div>`;
    document.body.appendChild(back);
    let onClose = null;
    function onEsc(e) { if (e.key === 'Escape') close(); }
    const close = () => {
      document.removeEventListener('keydown', onEsc);
      back.remove();
      if (onClose) { const f = onClose; onClose = null; f(); }
    };
    document.addEventListener('keydown', onEsc);
    back.querySelector('[data-close]').addEventListener('click', close);
    // Close on the backdrop only when the press STARTED on it — a drag that
    // ends outside the dialog must not throw away what was ticked in it.
    let pressedBack = false;
    back.addEventListener('mousedown', e => { pressedBack = e.target === back; });
    back.addEventListener('click', e => { if (e.target === back && pressedBack) close(); });
    return {
      el: back, body: back.querySelector('[data-body]'), foot: back.querySelector('[data-foot]'), close,
      set onClose(f) { onClose = f; },
    };
  }

  // ── Styles ──────────────────────────────────────────────────────────
  // One stylesheet, injected once: the grid needs hover, focus, sticky and
  // placeholder rules that inline styles cannot carry.
  function injectStyles() {
    if (document.getElementById('fctproc-styles')) return;
    const el = document.createElement('style');
    el.id = 'fctproc-styles';
    el.textContent = `
      .fctproc { color: var(--text,#e0e0e0); font-size: 0.8rem; }
      .fctproc button { font-family: inherit; }
      .fctproc-top { display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap; margin-bottom:0.75rem; }
      .fctproc-title { font-size:1rem; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; margin-right:0.4rem; }
      .fctproc-lbl { color: var(--muted,#666); font-size:0.72rem; letter-spacing:0.06em; text-transform:uppercase; }
      .fctproc-check { display:inline-flex; align-items:center; gap:0.3rem; color: var(--muted,#888); font-size:0.75rem; cursor:pointer; user-select:none; }
      .fctproc-check input { accent-color: var(--green,#22c55e); }
      .fctproc .cb[data-list="proc_projects"] { width: 22rem; max-width: 100%; }
      .fctproc .cb[data-list="proc_projects"] .cb-input {
        background: var(--bg,#0a0a0f); border-radius:4px; padding:0.3rem 1.4rem 0.3rem 0.55rem; font-size:0.85rem; text-overflow: ellipsis;
      }
      .fctproc .cb[data-list="proc_projects"]::after {
        content:'\\25BE'; position:absolute; right:0.5rem; top:50%; transform:translateY(-50%);
        font-size:0.7rem; color: var(--muted,#6b7280); pointer-events:none;
      }
      .fctproc .cb[data-list="proc_projects"] .cb-menu { max-width: 440px; }
      .fctproc-spacer { flex: 1 1 auto; }
      /* Controls that belong together wrap together, pushed to the right. */
      .fctproc-cluster { display:inline-flex; align-items:center; gap:0.45rem; flex-wrap:nowrap; }
      .fctproc-right { margin-left:auto; }
      .fctproc-empty { color: var(--muted,#888); padding: 2.5rem 1rem; text-align:center; border:1px dashed var(--border,#2a2a3a); border-radius:6px; font-size:0.85rem; line-height:1.6; }
      .fctproc-err { color: var(--red,#ef4444); padding: 1.5rem 1rem; border:1px solid rgba(239,68,68,0.4); border-radius:6px; background: rgba(239,68,68,0.06); }
      .fctproc-head { display:flex; align-items:center; gap:0.7rem; flex-wrap:wrap; padding:0.6rem 0.75rem;
        background: var(--surface,#111118); border:1px solid var(--border,#2a2a3a); border-radius:6px 6px 0 0; }
      .fctproc-job { font-weight:700; font-size:0.95rem; }
      .fctproc-jobno { color: var(--muted,#888); font-size:0.78rem; }
      .fctproc-counts { display:flex; gap:0.35rem; flex-wrap:wrap; align-items:center; }
      .fctproc-b { padding:0.3rem 0.75rem !important; font-size:0.74rem !important; white-space:nowrap; }
      .fctproc-b[disabled] { opacity:0.45; cursor:not-allowed; }
      .fctproc-bar { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; padding:0.45rem 0.75rem;
        background: var(--surface,#111118); border:1px solid var(--border,#2a2a3a); border-top:none; }
      .fctproc-search { background: var(--bg,#0a0a0f); border:1px solid var(--border,#2a2a3a); border-radius:4px; color: var(--text,#e0e0e0);
        font-size:0.8rem; padding:0.28rem 0.55rem; width: 15rem; max-width: 100%; outline:none; }
      .fctproc-search:focus { border-color:#2563eb; }
      .fctproc-chips { display:inline-flex; gap:0.3rem; flex-wrap:wrap; }
      .fctproc-chip { border:1px solid var(--border,#2a2a3a); background:transparent; color: var(--muted,#9ca3af);
        border-radius:999px; padding:0.14rem 0.6rem; font-size:0.72rem; cursor:pointer; white-space:nowrap; }
      .fctproc-chip:hover { color: var(--text,#e0e0e0); }
      .fctproc-chip.on { border-color: var(--green,#22c55e); color: var(--green,#22c55e); background: rgba(34,197,94,0.08); }
      .fctproc-chip .n { opacity:0.7; margin-left:0.3rem; font-variant-numeric: tabular-nums; }
      .fctproc-chip.c-red .n { color:#f87171; opacity:1; }
      .fctproc-chip.c-amber .n { color:#fbbf24; opacity:1; }
      .fctproc-seg { display:inline-flex; border:1px solid var(--border,#2a2a3a); border-radius:4px; overflow:hidden; }
      .fctproc-seg button { background:transparent; border:none; color: var(--muted,#9ca3af); padding:0.2rem 0.55rem; font-size:0.72rem; cursor:pointer; }
      .fctproc-seg button + button { border-left:1px solid var(--border,#2a2a3a); }
      .fctproc-seg button.on { background: var(--surface2,#1a1a26); color: var(--text,#e0e0e0); }
      .fctproc-link { background:none; border:none; color: var(--muted,#9ca3af); cursor:pointer; font-size:0.72rem; text-decoration: underline; padding:0 0.2rem; }
      .fctproc-link:hover { color: var(--text,#e0e0e0); }
      .fctproc-shown { color: var(--muted,#888); font-size:0.72rem; white-space:nowrap; }
      .fctproc-bulk { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; padding:0.45rem 0.75rem;
        background: rgba(37,99,235,0.12); border:1px solid rgba(37,99,235,0.55); border-top:none; }
      .fctproc-bulk select, .fctproc-bulk input[type=text], .fctproc-bulk input[type=date], .fctproc-bulk input[type=number] {
        background: var(--bg,#0a0a0f); border:1px solid var(--border,#2a2a3a); border-radius:3px; color: var(--text,#e0e0e0);
        font-size:0.78rem; padding:0.22rem 0.4rem; outline:none; color-scheme: dark; }
      .fctproc-bulk .cb { width: 13rem; }
      .fctproc-bulk .cb-input { background: var(--bg,#0a0a0f); padding:0.22rem 0.4rem; }
      .fctproc-wrap { overflow:auto; max-height: calc(100vh - 15rem); min-height: 14rem; border:1px solid var(--border,#2a2a3a);
        border-top:none; border-radius:0 0 6px 6px; background: var(--bg,#0a0a0f); }
      .fctproc-table { border-collapse: separate; border-spacing:0; table-layout: fixed; font-size:0.8rem; }
      .fctproc-table th { position: sticky; top:0; z-index:3; background: var(--surface2,#1a1a26); color: var(--muted,#9ca3af);
        font-size:0.64rem; letter-spacing:0.06em; text-transform:uppercase; font-weight:600; text-align:left;
        padding:0.45rem 0.4rem; border-bottom:1px solid var(--border,#2a2a3a); border-right:1px solid var(--border,#2a2a3a);
        white-space: normal; line-height:1.2; vertical-align: bottom; }
      .fctproc-table th.num { text-align:right; }
      .fctproc-table td { padding:0.12rem 0.3rem; border-bottom:1px solid var(--border,#2a2a3a);
        border-right:1px solid rgba(42,42,58,0.55); background: var(--surface,#111118); vertical-align: middle; height: 1.95rem;
        overflow: hidden; }
      .fctproc-table tr.fctproc-row:hover > td { background: #16161f; }
      .fctproc-table tr.fctproc-row.sel > td { background: #141c30; }
      /* Changed by someone else lately (a couple of minutes): a blue edge and
         tint on the cell — or the part of a cell — with who and when as its
         tooltip; a row someone else added, a tint across it. */
      .fctproc-table tr.fctproc-row > td.fctproc-chg { background: rgba(59,130,246,0.13); box-shadow: inset 3px 0 0 #3b82f6; }
      .fctproc-part.fctproc-chg { background: rgba(59,130,246,0.16); box-shadow: inset 2px 0 0 #3b82f6; border-radius:3px; }
      .fctproc-table tr.fctproc-row.fctproc-new > td { background: rgba(59,130,246,0.07); }
      .fctproc-table tr.fctproc-row.fctproc-new > td.c-sel { box-shadow: inset 3px 0 0 #3b82f6; }
      /* The conflict dialog's table: theirs beside yours. */
      .fctproc-conflict { width:100%; border-collapse:collapse; font-size:0.8rem; }
      .fctproc-conflict th { text-align:left; color: var(--muted,#9ca3af); font-size:0.7rem; font-weight:600; padding:0.25rem 0.4rem; border-bottom:1px solid var(--border,#2a2a3a); }
      .fctproc-conflict td { padding:0.35rem 0.4rem; border-bottom:1px solid rgba(42,42,58,0.6); vertical-align:top; }
      .fctproc-conflict td:first-child { color: var(--muted,#9ca3af); white-space:nowrap; }
      .fctproc-conflict td.theirs { color:#93c5fd; }
      .fctproc-conflict td.mine { color: var(--text,#e0e0e0); font-weight:600; }
      .fctproc-table .stk { position: sticky; z-index:2; }
      .fctproc-table th.stk { z-index:4; }
      .fctproc-table .stk-edge { box-shadow: 2px 0 0 var(--border,#2a2a3a); }
      .fctproc-table td.c-sel, .fctproc-table th.c-sel { text-align:center; padding:0; }
      .fctproc-table input[type=checkbox] { accent-color: #2563eb; cursor:pointer; vertical-align: middle; }
      .fctproc-table td.c-status { white-space: normal; }
      .fctproc-table td.c-status.flag-red { box-shadow: inset 3px 0 0 var(--red,#ef4444), 2px 0 0 var(--border,#2a2a3a); }
      .fctproc-table td.c-status.flag-amber { box-shadow: inset 3px 0 0 var(--yellow,#eab308), 2px 0 0 var(--border,#2a2a3a); }
      .fctproc-txt { display:block; overflow:hidden; text-overflow: ellipsis; white-space: nowrap; padding:0 0.15rem; }
      .fctproc-txt.wrap { white-space: normal; overflow-wrap:anywhere; line-height:1.3; }
      /* The Sub Code IS the material in these bids, so it is shown whole
         (two lines) rather than cut to "Perimeter Collector Drain …" three
         times over for three different drains. */
      .fctproc-txt.wrap2 { white-space: normal; overflow-wrap:anywhere; line-height:1.25; display:-webkit-box;
        -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-overflow: clip; }
      .fctproc-txt.num { text-align:right; font-variant-numeric: tabular-nums; }
      .fctproc-dim { color: var(--muted,#777); }
      .fctproc-amber { color:#fbbf24; }
      .fctproc-ok { color: var(--green,#22c55e); }
      .fctproc-calc { color: var(--muted,#9ca3af); font-style: italic; }
      /* A Material with no name of its own: the bid's Sub Code, greyed. */
      .fctproc-frombid { color: var(--muted,#9ca3af); font-style: italic; }
      .fctproc-in { width:100%; box-sizing:border-box; background:transparent; border:1px solid transparent; border-radius:3px;
        color: var(--text,#e0e0e0); font: inherit; font-size:0.8rem; padding:0.14rem 0.25rem; outline:none; min-width:0; }
      .fctproc-in:hover { border-color: var(--border,#2a2a3a); }
      .fctproc-in:focus { border-color:#2563eb; background: var(--bg,#0a0a0f); box-shadow: 0 0 0 1px #2563eb33; }
      .fctproc-in[type=date] { color-scheme: dark; padding-right:0; }
      .fctproc-in[type=date]::-webkit-calendar-picker-indicator { opacity:0.45; cursor:pointer; margin-left:0.1rem; }
      .fctproc-in[type=date]:hover::-webkit-calendar-picker-indicator,
      .fctproc-in[type=date]:focus::-webkit-calendar-picker-indicator { opacity:0.9; }
      /* An empty date shows its "mm/dd/yyyy" faintly, so it reads as a box to
         fill in without being pointed at — but well under the dates that
         are set. */
      .fctproc-in[type=date].empty:not(:hover):not(:focus) { color: rgba(156,163,175,0.5); }
      .fctproc-in[type=date].empty:not(:hover):not(:focus)::-webkit-calendar-picker-indicator { opacity:0.35; }
      .fctproc-in[type=number] { text-align:right; font-variant-numeric: tabular-nums; -moz-appearance: textfield; appearance: textfield; }
      .fctproc-in[type=number]::-webkit-inner-spin-button,
      .fctproc-in[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
      .fctproc-in.derived { color: var(--muted,#9ca3af); font-style: italic; }
      .fctproc-in.bad, .fctproc-in.bad:hover, .fctproc-in.bad:focus { border-color: var(--red,#ef4444); box-shadow: 0 0 0 1px rgba(239,68,68,0.35); }
      select.fctproc-in { cursor:pointer; padding-left:0.15rem; }
      select.fctproc-in option { background: var(--surface,#111118); color: var(--text,#e0e0e0); font-style: normal; }
      select.fctproc-in.sca-Needed { color:#fbbf24; }
      select.fctproc-in.sca-Executed { color: var(--green,#22c55e); }
      select.fctproc-in.sca-Not-Needed { color: var(--muted,#9ca3af); }
      /* Status: the pill (and paperclip) on the first line; the Sub-Contractor
         Agreement tag and the flags on the second. */
      .fctproc-statusbox { display:flex; flex-wrap:wrap; align-items:center; gap:0.12rem 0.2rem; min-width:0; }
      .fctproc-statusbox > .c-pill { flex: 1 0 100%; display:flex; align-items:center; gap:0.15rem; min-width:0; }
      .fctproc-statusbox > .c-flags:empty { display:none; }
      .fctproc-statusbox .fctproc-flags { margin-left:0; }
      .fctproc-statusbox .fctproc-flag { letter-spacing:0.01em; padding-left:0.22rem; padding-right:0.22rem; }
      /* A pill like the Status pill above it, in the same greys for "pending",
         amber when an agreement is needed, green once executed. */
      .fctproc-scatag { display:inline-block; white-space:nowrap; font-size:0.62rem; font-weight:600; line-height:1.3; letter-spacing:0;
        padding:0.05rem 0.3rem; border:1px solid rgba(156,163,175,0.28); border-radius:999px;
        background: rgba(156,163,175,0.10); color:#9ca3af; }
      .fctproc-scatag.sca-Needed { background: rgba(234,179,8,0.14); color:#fbbf24; border-color: rgba(234,179,8,0.45); }
      .fctproc-scatag.sca-Executed { background: rgba(34,197,94,0.14); color: var(--green,#22c55e); border-color: rgba(34,197,94,0.4); }
      .fctproc-scatag.sca-Not-Needed { background: transparent; border-style:dashed; }
      .fctproc-scawrap { position:relative; display:inline-flex; max-width:100%; cursor:pointer; }
      .fctproc-scawrap:hover .fctproc-scatag { border-color: rgba(156,163,175,0.6); }
      .fctproc-scawrap:focus-within .fctproc-scatag { border-color:#2563eb; box-shadow: 0 0 0 1px #2563eb33; }
      .fctproc-scawrap select.fctproc-scasel { position:absolute; inset:0; width:100%; height:100%; min-width:0; opacity:0; padding:0; cursor:pointer; }
      /* The empty boxes of a stacked cell (Vendor, Quote #, Contact, Email)
         always say what they are, so they read as boxes to fill in without
         being pointed at — faintly, in the empty dates' grey, well under the
         values that are set. */
      .fctproc-stack input::placeholder { color: rgba(156,163,175,0.5); opacity:1; }
      /* Two fields over each other in one cell (Vendor over Quote #,
         Contact over Email): the second one a little smaller. */
      .fctproc-stack { display:grid; grid-template-columns: minmax(0,1fr); row-gap:0.06rem; }
      .fctproc-stack > .fctproc-part + .fctproc-part .fctproc-in,
      .fctproc-stack > .fctproc-part + .fctproc-part .cb-input,
      .fctproc-stack > .fctproc-part + .fctproc-part .fctproc-txt { font-size:0.74rem; }
      .fctproc-stack .fctproc-in, .fctproc-stack .cb-input { padding:0.06rem 0.25rem; }
      .fctproc-table th .fctproc-stack { row-gap:0.2rem; }
      /* A long sub code or vendor ends in an ellipsis like the plain-text
         cells beside it, instead of being cut off mid-letter. */
      .fctproc-table .cb-input, .fctproc-table input.fctproc-in[type=text] { text-overflow: ellipsis; }
      .fctproc-table .cb-input { background: transparent; border-color: transparent; font-size:0.8rem; padding:0.14rem 0.25rem; }
      .fctproc-table .cb-input:hover { border-color: var(--border,#2a2a3a); }
      .fctproc-table .cb-input:focus { background: var(--bg,#0a0a0f); border-color:#2563eb; }
      .fctproc-po { display:flex; align-items:center; gap:0.2rem; }
      .fctproc-po .cb { flex: 1 1 auto; min-width:0; }
      td.po-multi .cb-input::placeholder, td.po-multi .fctproc-txt { color:#fbbf24; opacity:1; font-style: italic; }
      td.po-removed .cb-input::placeholder, td.po-removed .fctproc-txt { color:#f87171; opacity:1; font-style: italic; }
      td.po-nopo .cb-input, td.po-nopo .fctproc-txt { color: var(--muted,#9ca3af); }
      .vendor-off .cb-input, .vendor-off .fctproc-txt { color:#fbbf24; text-decoration: underline dotted rgba(234,179,8,0.7); text-underline-offset: 3px; }
      .fctproc-open { background:none; border:1px solid var(--border,#2a2a3a); color: var(--blue,#60a5fa); border-radius:3px;
        font-size:0.68rem; line-height:1; padding:0.15rem 0.25rem; cursor:pointer; flex:none; }
      .fctproc-open:hover { background: rgba(96,165,250,0.12); }
      .fctproc-pill { display:inline-block; padding:0.08rem 0.45rem; border-radius:999px; font-size:0.68rem; font-weight:600;
        white-space:nowrap; border:1px solid transparent; line-height:1.35; }
      .fctproc-pill.st-not { background: rgba(156,163,175,0.10); color:#9ca3af; border-color: rgba(156,163,175,0.28); }
      .fctproc-pill.st-ord { background: rgba(96,165,250,0.14); color: var(--blue,#60a5fa); border-color: rgba(96,165,250,0.4); }
      .fctproc-pill.st-unk { background: transparent; color: var(--muted,#9ca3af); border-color: rgba(156,163,175,0.28); border-style: dashed; }
      .fctproc-pill.st-unk.po-failed { color:#fbbf24; border-color: rgba(251,191,36,0.45); }
      .fctproc-pill.st-del { background: rgba(34,197,94,0.14); color: var(--green,#22c55e); border-color: rgba(34,197,94,0.4); }
      .fctproc-pill.n-red { background: rgba(239,68,68,0.14); color:#f87171; border-color: rgba(239,68,68,0.4); }
      .fctproc-pill .n { font-variant-numeric: tabular-nums; margin-left:0.25rem; }
      .fctproc-flags { display:inline-flex; flex-wrap:wrap; gap:0.2rem; margin-left:0.2rem; vertical-align: middle; }
      .fctproc-flag { display:inline-block; padding:0.02rem 0.32rem; border-radius:3px; font-size:0.6rem; font-weight:700;
        text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap; line-height:1.4; }
      .fctproc-flag.red { background: rgba(239,68,68,0.2); color:#f87171; }
      .fctproc-flag.amber { background: rgba(234,179,8,0.17); color:#fbbf24; }
      .fctproc-tag { display:inline-block; font-size:0.58rem; text-transform: uppercase; letter-spacing:0.05em; padding:0 0.25rem;
        border-radius:3px; border:1px solid var(--border,#2a2a3a); color: var(--muted,#9ca3af); white-space:nowrap; line-height:1.4; flex:none; }
      .fctproc-tag.amber { color:#fbbf24; border-color: rgba(234,179,8,0.45); }
      .fctproc-tag.red { color:#f87171; border-color: rgba(239,68,68,0.45); }
      /* Cost Code / Sub Code in one cell: the cost code muted, a separator,
         the sub code plain. The sub code (the bid line) always shows, on two
         lines if it must; the cost code takes what is left, cut short with
         its tooltip only when there is no room. */
      .fctproc-codes { display:flex; align-items:center; gap:0.1rem; min-width:0; }
      /* Read-only: "Stormwater / Geofabric" on one line when it fits; else the
         sub code goes to the next line whole (as the PO view's text wraps),
         and a "not on bid" tag after it, never pushed out of the cell. */
      .fctproc-codes:not(.edit) { flex-wrap: wrap; align-content:center; column-gap:0.1rem; row-gap:0.05rem; }
      .fctproc-codes .fctproc-txt { flex: 1 1 auto; min-width:0; }
      .fctproc-codes .fctproc-cc { flex: 0 1 auto; min-width:2rem; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-left:0.15rem; }
      .fctproc-codes .fctproc-sc { flex: 0 1 auto; max-width:100%; min-width:0; white-space: normal; overflow-wrap:anywhere; line-height:1.25;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient: vertical; overflow:hidden; padding:0 0.15rem; }
      .fctproc-codes .fctproc-tag { flex: none; }
      .fctproc-cc { color: var(--muted,#9ca3af); font-size:0.74rem; }
      .fctproc-sep { flex: none; color:#4b7a4b; font-weight:600; padding:0 0.12rem; white-space:pre; }
      .fctproc-codes.edit .fctproc-scpick { flex: 1 1 0; min-width:5.5rem; }
      /* A header of several fields: each named, each with its filter. */
      .fctproc-table th .fctproc-hp { white-space:nowrap; }
      .fctproc-table th .fctproc-inl { display:flex; flex-wrap:wrap; align-items:baseline; gap:0 0.15rem; }
      .fctproc-table th .fctproc-sep { color: var(--muted,#9ca3af); }
      /* The ordering dates, 2 × 2 in their cell and in their header alike:
         Lead Time → Order By over Ordered · Delivered. */
      .fctproc-grid2 { display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); column-gap:0.3rem; row-gap:0.1rem; align-items:center; }
      .fctproc-table th .fctproc-grid2 { row-gap:0.2rem; align-items:end; }
      .fctproc-part { min-width:0; position:relative; display:flex; align-items:center; }
      .fctproc-part .fctproc-in { font-size:0.74rem; padding-top:0.06rem; padding-bottom:0.06rem; }
      .fctproc-part.c-lead_time_days .fctproc-in { width:3.1rem; flex: 0 0 auto; }
      .fctproc-u { color: var(--muted,#9ca3af); font-size:0.66rem; margin-left:0.15rem; }
      .fctproc-part.c-order_by::before { content:'\\2192'; color: var(--muted,#6b7280); font-size:0.72rem; margin-right:0.2rem; }
      .fctproc-part.c-order_by .fctproc-txt { font-size:0.74rem; padding:0; }
      /* In the ordering cell, an empty date says which one it is — "ordered",
         "delivered" — in place of the two identical "mm/dd/yyyy" (the cell
         has no room for labels). Always shown, so the boxes read as boxes to
         fill in; the date format comes back when one is pointed at. */
      /* (A browser without :has() keeps the "mm/dd/yyyy" rather than a blank.) */
      @supports selector(:has(a)) {
        .fctproc-part.c-date_ordered > input.empty:not(:hover):not(:focus),
        .fctproc-part.c-date_delivered > input.empty:not(:hover):not(:focus) { color: transparent; }
        .fctproc-part.c-date_ordered:has(> input.empty:not(:focus):not(:hover))::after,
        .fctproc-part.c-date_delivered:has(> input.empty:not(:focus):not(:hover))::after {
          position:absolute; left:0.3rem; top:50%; transform: translateY(-50%); pointer-events:none;
          font-size:0.66rem; letter-spacing:0.03em; color: var(--muted,#9ca3af); opacity:0.85; }
        .fctproc-part.c-date_ordered:has(> input.empty:not(:focus):not(:hover))::after { content:'ordered'; }
        .fctproc-part.c-date_delivered:has(> input.empty:not(:focus):not(:hover))::after { content:'delivered'; }
      }
      .fctproc-qty { display:flex; flex-direction:column; gap:0.1rem; padding:0.1rem 0; }
      .fctproc-bidchg { display:flex; flex-direction:column; align-items:flex-end; gap:0.12rem; font-size:0.62rem; color:#fbbf24; line-height:1.25; text-align:right; }
      .fctproc-bidchg > span:first-child { white-space: normal; }
      .fctproc-bidchg .acts { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:0.2rem; white-space:nowrap; }
      .fctproc-mini { background:none; border:1px solid rgba(234,179,8,0.4); color:#fbbf24; border-radius:3px; font-size:0.6rem;
        padding:0 0.25rem; cursor:pointer; line-height:1.4; }
      .fctproc-mini.ghost { border-color: var(--border,#2a2a3a); color: var(--muted,#9ca3af); }
      .fctproc-mini:hover { background: rgba(234,179,8,0.12); }
      .fctproc-acts { display:flex; gap:0.25rem; align-items:center; justify-content:flex-end; white-space:nowrap; }
      .fctproc-act { background:none; border:1px solid var(--border,#2a2a3a); color: var(--muted,#9ca3af); border-radius:3px;
        font-size:0.66rem; padding:0.1rem 0.32rem; cursor:pointer; line-height:1.3; white-space:nowrap; }
      .fctproc-act:hover { color: var(--text,#e0e0e0); border-color: var(--muted,#666); }
      .fctproc-act.add:hover { color: var(--green,#22c55e); border-color: var(--green,#22c55e); }
      .fctproc-act.del:hover, .fctproc-act.danger { color:#f87171; border-color: rgba(239,68,68,0.6); }
      /* The paperclip, beside the Status pill: muted with nothing attached,
         green with a count, the way the Purchase Orders tab draws its own.
         One fixed width whatever the count — the count is a badge on its
         corner, not text beside it — so it fits beside the widest pill
         ("Not Ordered") in the 7.2rem pinned column, and a line's height
         never changes with how many files it has. */
      .fctproc-clip { position:relative; display:inline-block; box-sizing:border-box; width:1.15rem; height:1.05rem;
        background:none; border:1px solid var(--border,#2a2a3a); border-radius:3px; color: var(--muted,#9ca3af);
        font-size:0.62rem; line-height:1; padding:0; margin-left:0.15rem; vertical-align: middle; text-align:center;
        cursor:pointer; white-space:nowrap; }
      .fctproc-clip .n { position:absolute; right:-0.24rem; bottom:-0.14rem; box-sizing:border-box; min-width:0.7rem; height:0.7rem;
        padding:0 0.12rem; border-radius:999px; background: var(--green,#22c55e); color:#052e16; font-size:0.5rem; font-weight:700;
        line-height:0.7rem; text-align:center; font-variant-numeric: tabular-nums; pointer-events:none; }
      .fctproc-table td.c-status .fctproc-pill { padding-left:0.4rem; padding-right:0.4rem; }
      .fctproc-clip:hover, .fctproc-clip:focus-visible { color: var(--text,#e0e0e0); border-color: var(--muted,#666); }
      .fctproc-clip.has { color: var(--green,#22c55e); border-color: rgba(34,197,94,0.45); }
      .fctproc-clip.has:hover, .fctproc-clip.has:focus-visible { border-color: var(--green,#22c55e); }
      tr.fctproc-grp > td { background:#111c11; color: var(--green,#22c55e); font-weight:600; font-size:0.78rem;
        padding:0.32rem 0.6rem; border-top:2px solid #1e3a1e; border-right:none; cursor:pointer; height:auto; user-select:none;
        overflow: visible; }
      tr.fctproc-grp:hover > td { background:#162216; }
      tr.fctproc-grp .gl { position: sticky; left:0.6rem; display:inline-flex; gap:0.6rem; align-items: baseline; flex-wrap:wrap; }
      tr.fctproc-grp .tw { display:inline-block; width:0.8rem; font-size:0.65rem; }
      tr.fctproc-grp .fctproc-grpsel { margin:0 0 0 0.05rem; align-self:center; }
      tr.fctproc-grp .fctproc-grpadd { background:none; border:1px solid #1e3a1e; color:#6f9a6f; border-radius:3px; font-size:0.66rem;
        font-weight:500; padding:0.05rem 0.4rem; cursor:pointer; line-height:1.3; align-self:center; white-space:nowrap; }
      tr.fctproc-grp .fctproc-grpadd:hover, tr.fctproc-grp .fctproc-grpadd:focus-visible { color: var(--green,#22c55e); border-color: var(--green,#22c55e); }
      tr.fctproc-grp .fctproc-grpdocs { background:none; border:1px solid #1e3a1e; color:#6f9a6f; border-radius:3px; font-size:0.66rem;
        font-weight:500; padding:0.05rem 0.4rem; cursor:pointer; line-height:1.3; align-self:center; white-space:nowrap;
        font-variant-numeric: tabular-nums; }
      tr.fctproc-grp .fctproc-grpdocs.has { color: var(--green,#22c55e); }
      tr.fctproc-grp .fctproc-grpdocs:hover, tr.fctproc-grp .fctproc-grpdocs:focus-visible { color: var(--green,#22c55e); border-color: var(--green,#22c55e); }
      tr.fctproc-grp .gm { color:#6f9a6f; font-weight:400; font-size:0.72rem; }
      tr.fctproc-grp .gm b { color:#9ccc9c; font-weight:600; }
      /* A site's job band: a heavier bar than the cost-code sections under it. */
      tr.fctproc-jobband > td { background:#0f2a1a; color:#e6f4ea; font-size:0.86rem; font-weight:700; padding:0.45rem 0.6rem;
        border-top:3px solid var(--green,#22c55e); }
      tr.fctproc-jobband:hover > td { background:#133420; }
      tr.fctproc-jobband .gm { color:#8fbf9a; }
      .fctproc-sitejobs .n { color: var(--muted,#888); font-variant-numeric: tabular-nums; }
      .fctproc-nomatch td { text-align:center; color: var(--muted,#888); padding:2rem 1rem !important; height:auto; }
      .fctproc-save { margin-left:auto; }
      .fctproc-save.idle { opacity:0; }
      #fctproc-filter-dd .dff-item { display:flex; align-items:center; gap:0.4rem; padding:0.25rem 0.6rem; cursor:pointer; font-size:0.78rem; }
      #fctproc-filter-dd .dff-item:hover { background: var(--surface2,#1a1a26); }
      #fctproc-filter-dd input[type=checkbox] { accent-color: var(--green,#22c55e); }
      .fctproc-send-grp { border:1px solid var(--border,#2a2a3a); border-radius:5px; margin-bottom:0.6rem; overflow:hidden; }
      .fctproc-send-h { display:flex; align-items:center; gap:0.6rem; background:#111c11; color: var(--green,#22c55e);
        font-weight:600; font-size:0.78rem; padding:0.35rem 0.6rem; border-bottom:1px solid #1e3a1e; }
      .fctproc-send-h .gm { color:#6f9a6f; font-weight:400; font-size:0.72rem; }
      .fctproc-send-line { display:flex; align-items:center; gap:0.55rem; padding:0.28rem 0.6rem; border-top:1px solid rgba(42,42,58,0.6); cursor:pointer; }
      .fctproc-send-line:first-of-type { border-top:none; }
      .fctproc-send-line:hover { background: var(--surface2,#1a1a26); }
      .fctproc-send-line input { accent-color: var(--green,#22c55e); }
      .fctproc-send-line .sub { flex: 1 1 auto; min-width:0; overflow:hidden; text-overflow: ellipsis; white-space:nowrap; }
      .fctproc-send-line .qty { color: var(--muted,#9ca3af); font-variant-numeric: tabular-nums; white-space:nowrap; }
      .fctproc-send-line.added { opacity:0.5; cursor:default; }
      .fctproc-tag[hidden] { display:none; }
      /* "+ Material" on a line with a list to copy, and that list's dialog. */
      /* On the button's corner, so "+ Material" is no wider for it. */
      .fctproc-act.add.past { position:relative; }
      .fctproc-pastdot { position:absolute; top:-0.2rem; right:-0.2rem; width:0.42rem; height:0.42rem; border-radius:50%;
        background: var(--green,#22c55e); box-shadow: 0 0 0 2px var(--surface,#111118); pointer-events:none; }
      .fctproc-copyjobs { display:flex; flex-direction:column; gap:0.3rem; margin:0 0 0.7rem; }
      .fctproc-copyjob { display:flex; align-items:center; gap:0.5rem; padding:0.35rem 0.6rem; border:1px solid var(--border,#2a2a3a);
        border-radius:5px; cursor:pointer; }
      .fctproc-copyjob.single { cursor:default; margin-bottom:0.7rem; }
      .fctproc-copyjob.on { border-color: var(--green,#22c55e); background: rgba(34,197,94,0.06); }
      .fctproc-copyjob input { accent-color: var(--green,#22c55e); }
      .fctproc-copyjob .n { font-weight:600; }
      .fctproc-copyjob .gm { color: var(--muted,#9ca3af); font-size:0.74rem; margin-left:auto; }
      .fctproc-send-line.added .sub { text-decoration: none; }
      .fctproc-choice { display:block; width:100%; text-align:left; margin-bottom:0.45rem; padding:0.55rem 0.75rem !important; white-space: normal; }
    `;
    document.head.appendChild(el);
  }

  // ── Comboboxes (the page's cbHtml) ──────────────────────────────────
  // Inside the scrolling table every combobox asks for a fixed-position menu
  // (data-cb-fixed) or the table's overflow would clip it. Without the page's
  // cbHtml (a test, a page that has not got it) a plain text box stands in;
  // it carries the cb-input class so it is committed on change, like one.
  function cbCell(listKey, value, placeholder, attrs, fixed = true) {
    if (typeof window.cbHtml === 'function') {
      return window.cbHtml(listKey, value, placeholder, attrs, fixed ? 'data-cb-fixed="1"' : '');
    }
    return `<input type="text" class="cb-input fctproc-in" data-list="${esc(listKey)}" value="${esc(value)}" placeholder="${esc(placeholder || '')}" ${attrs}>`;
  }

  function projectOptions() {
    const jobs = projects()
      .filter(p => st.showAll || p.id === st.projectId || isLive(p))
      .map(p => ({ value: p.id, label: projLabel(p), meta: p['job-number'] ? 'Job #' + p['job-number'] : '' }));
    // Each site with two or more jobs listed gets an entry of its own that
    // opens them all (the one open stays listed whatever it holds now). Its
    // job numbers ride in the meta, so typing one finds the site too.
    const keys = new Set(projects().map(p => siteName(p)).filter(Boolean).map(n => SITE + lc(n)));
    const sites = [...keys].map(key => ({ key, jobs: siteJobs(key) }))
      .filter(x => x.jobs.length >= 2 || x.key === st.projectId)
      .map(({ key, jobs: list }) => {
        const nums = list.map(p => str(p['job-number']).trim()).filter(Boolean);
        return { value: key, label: siteOptLabel(siteLabel(key), list.length),
          meta: 'Site' + (nums.length ? ' · Job #' + nums.join(', #') : '') };
      });
    return jobs.concat(sites).sort((a, b) => a.label.localeCompare(b.label));
  }

  function poOptions(row) {
    const ctx = makeCtx();
    const pid = (row && row.project_id) || st.projectId;
    const e = row ? effectivePO({ ...row, po_id: null, po_auto: true }, ctx) : { kind: 'none', candidates: [] };
    const autoMeta = !ctx.poLoaded ? 'POs still loading'
      : e.kind === 'auto' ? `matches ${str(e.po.po_number) || 'a PO'}`
      : e.kind === 'multiple' ? `${e.candidates.length} POs match` : 'no PO matches yet';
    const opts = [
      { value: '__auto__', label: 'Auto', meta: autoMeta },
      { value: '__none__', label: 'No PO', meta: 'not bought on a PO' },
    ];
    const codes = c => [c.cost_code, c.sub_code].filter(Boolean).join(' / ');
    (ctx.purchaseOrders || []).filter(p => p && String(p.project_id || '') === String(pid || ''))
      .slice().sort((a, b) => str(b.po_number).localeCompare(str(a.po_number), undefined, { numeric: true }))
      .forEach(p => opts.push({
        value: String(p.id),
        label: str(p.po_number) || '(no number)',
        meta: [str(p.supplier) || 'no supplier', codes(p) || 'no code'].join(' — '),
      }));
    return opts;
  }

  function codeOptions(projectId) {
    let lines = [];
    try { lines = cfg.getBidLines(projectId) || []; } catch { /* none */ }
    return lines.filter(l => l && l.id != null && (l.cost_code || l.sub_code)).map(l => ({
      value: String(l.id),
      label: [l.cost_code, l.sub_code].filter(Boolean).join(' / '),
      meta: [normUnit(l.unit), l.quantity == null ? '' : fmtQty(l.quantity)].filter(Boolean).join(' · '),
    }));
  }

  // ── Material library ────────────────────────────────────────────────
  /**
   * The names materials have been bought under on this division's jobs, by
   * the sub code they booked to: "Infill Crumb Rubber" was bought as "20/40
   * Mesh rubber crumb infill" from Willig Tire, by the LBS, on 3 jobs. Read
   * from the server (GET action=materials — every job's rows, aggregated)
   * once when the sheet loads and again after a while, and topped up from
   * the rows on this sheet, so a name typed a moment ago is offered on the
   * next row before any read. Nothing here is stored: it is the rows.
   */
  const LIB_STALE_MS = 5 * 60 * 1000;
  const MAT_SUGGEST_MAX = 40;
  const lib = { division: null, list: [], at: 0, loading: null };
  function loadLibrary({ force = false } = {}) {
    if (lib.division !== cfg.division) { lib.division = cfg.division; lib.list = []; lib.at = 0; lib.loading = null; }
    if (lib.loading || (!force && lib.at && Date.now() - lib.at < LIB_STALE_MS)) return lib.loading || Promise.resolve(lib.list);
    const division = cfg.division;
    lib.at = Date.now();
    lib.loading = api('GET', '/procurement' + q({ action: 'materials' }))
      .then(data => {
        if (lib.division !== division) return lib.list;
        lib.list = (Array.isArray(data && data.materials) ? data.materials : [])
          .filter(m => m && typeof m.material === 'string' && m.material.trim())
          .map(m => ({
            material: m.material.trim(), sub_code: str(m.sub_code), cost_code: str(m.cost_code),
            unit: str(m.unit), vendor: str(m.vendor), jobs: Math.max(0, intOrNull(m.jobs) || 0),
            last_used: str(m.last_used),
          }));
        // The rows were drawn before the library came (it is read after
        // them): each "+ Material" with a list to copy takes its dot now —
        // around any cell in use, and only the rows that change.
        if (isMounted() && st.loadState === 'ok' && canEdit()) redrawAround();
        return lib.list;
      })
      .catch(err => {
        // Suggestions are a help, not the sheet: a failed read is tried again
        // on a later load, and the Material cell takes typing meanwhile.
        console.warn('[procurement] could not read the material library', err);
        lib.at = 0;
        return lib.list;
      })
      .finally(() => { if (lib.division === division) lib.loading = null; });
    return lib.loading;
  }
  const libKey = (k, sub, mat) => ck(k, sub) + '\u0000' + ck(k, mat);
  const libValue = (k, e) => '__lib__:' + encodeURIComponent(ck(k, e.sub_code)) + '|' + encodeURIComponent(ck(k, e.material));
  /** The server's list, with this sheet's own named rows added. */
  function libraryEntries(ctx) {
    const k = keyFn(ctx);
    const out = new Map();
    lib.list.forEach(e => { const key = libKey(k, e.sub_code, e.material); if (!out.has(key)) out.set(key, e); });
    st.rows.forEach(r => {
      const mat = str(r.description).trim();
      if (!mat) return;
      const c = liveCodes(r, ctx);
      // A name that is just the Sub Code again says nothing the bid does not.
      if (ck(k, mat) === ck(k, c.sub_code)) return;
      const key = libKey(k, c.sub_code, mat);
      if (out.has(key)) return;
      out.set(key, { material: mat, sub_code: c.sub_code, cost_code: c.cost_code, unit: str(r.unit), vendor: str(r.vendor), jobs: 0, here: true });
    });
    return [...out.values()];
  }
  /**
   * The Material picker's list for a row, as it opens: the names used under
   * its Sub Code (that is the "Infill Crumb Rubber was 20/40 Mesh" memory) —
   * or, when that sub code has none, or the row has a cost code alone, the
   * names used under its Cost Code; a row with no codes yet, the names used
   * most anywhere. Most-used first, and a name another row of this job
   * already has after the rest, saying so (the next "+ Material" of a
   * detention system is one of the parts not bought yet). `all` lists every
   * name, nearest first — what typing searches.
   */
  function materialOptions(row, { all = false } = {}) {
    if (!row) return [];
    const ctx = siteMode() && row.project_id ? makeCtx(row.project_id) : makeCtx();
    const k = keyFn(ctx);
    const codes = liveCodes(row, ctx);
    const sk = ck(k, codes.sub_code), cc = ck(k, codes.cost_code);
    const rankOf = e => (sk && ck(k, e.sub_code) === sk ? 0 : cc && ck(k, e.cost_code) === cc ? 1 : 2);
    // The names this job's other rows already carry, by their own codes.
    const taken = new Set();
    st.rows.forEach(r => {
      if (r.id === row.id || String(r.project_id || '') !== String(row.project_id || '') || !str(r.description).trim()) return;
      taken.add(libKey(k, liveCodes(r, ctx).sub_code, str(r.description).trim()));
    });
    const ranked = libraryEntries(ctx).map(e => ({ e, rank: rankOf(e), taken: taken.has(libKey(k, e.sub_code, e.material)) }));
    let pool = ranked;
    if (!all) {
      pool = ranked.filter(x => x.rank === 0);
      if (!pool.length && cc) pool = ranked.filter(x => x.rank === 1);
      // A row with no codes yet (+ Add Row) has nothing to be near.
      if (!pool.length && !sk && !cc) pool = ranked;
    }
    pool.sort((a, b) => a.rank - b.rank || a.taken - b.taken || (b.e.jobs || 0) - (a.e.jobs || 0)
      || str(b.e.last_used).localeCompare(str(a.e.last_used)) || a.e.material.localeCompare(b.e.material));
    return pool.map(({ e, rank, taken: on }) => {
      const where = rank === 0 ? '' : [rank === 2 ? e.cost_code : '', e.sub_code].map(s => str(s).trim()).filter(Boolean).join(' / ');
      const used = on ? 'already on this job' : e.here ? 'this sheet' : e.jobs > 1 ? `${e.jobs} jobs` : e.jobs === 1 ? '1 job' : '';
      return {
        value: libValue(k, e), label: e.material, rank,
        meta: [where ? `under ${where}` : '', normUnit(e.unit), str(e.vendor).trim(), used].filter(Boolean).join(' · '),
      };
    });
  }
  /** The library entry a picked option stands for, or null. */
  function libraryEntry(row, value) {
    if (!row || !String(value || '').startsWith('__lib__:')) return null;
    const ctx = siteMode() && row.project_id ? makeCtx(row.project_id) : makeCtx();
    const k = keyFn(ctx);
    return libraryEntries(ctx).find(e => libValue(k, e) === value) || null;
  }

  function cbOptions(listKey) {
    const key = String(listKey || '');
    if (key === 'proc_projects') return projectOptions();
    if (key.startsWith('proc_materials:')) return materialOptions(rowById(key.slice(15))).slice(0, MAT_SUGGEST_MAX);
    if (key === 'proc_vendors') return suppliers().slice().sort((a, b) => a.localeCompare(b));
    if (key === 'proc_units') return UNITS.slice();
    if (key.startsWith('proc_contacts:')) {
      const row = rowById(key.slice(14));
      return row ? contacts.list(row.vendor).map(c => ({
        value: c.id, label: c.name || c.email, meta: c.name ? (c.email || c.phone || '') : (c.phone || ''),
      })) : [];
    }
    if (key.startsWith('proc_codes:')) return codeOptions(key.slice(11));
    if (key.startsWith('proc_pos:')) {
      const row = rowById(key.slice(9));
      return row ? poOptions(row) : [];
    }
    return [];
  }

  const optLabel = o => (typeof o === 'string' ? o : str(o && o.label));
  function cbFilter(listKey, rawQuery, options) {
    const key = String(listKey || '');
    const typed = String(rawQuery || '').trim();
    const ql = typed.toLowerCase();
    const opts = options || [];
    const withMeta = o => (optLabel(o) + ' ' + (o && typeof o === 'object' ? str(o.meta) : '')).toLowerCase();
    if (key === 'proc_vendors') {
      const out = ql ? opts.filter(o => optLabel(o).toLowerCase().includes(ql)) : opts.slice();
      if (typed && !suppliers().some(s => lc(s) === lc(typed))) {
        const name = typed.slice(0, MAX_LEN.vendor);
        out.push({ value: '__new__:' + name, label: `+ Add "${name}" as new supplier`, meta: 'new', metaCls: 'new' });
      }
      return out;
    }
    if (key.startsWith('proc_materials:')) {
      if (!ql) return opts;
      // Typing searches every name used on the division's jobs, the row's own
      // sub code's first. What was typed comes first unless it is one of them
      // word for word: Material is free text, and Enter or Tab takes the top
      // line — it must not swap "Flat Drain" for "Flat Drain 12in" unasked.
      const hits = materialOptions(rowById(key.slice(15)), { all: true })
        .filter(o => withMeta(o).includes(ql)).slice(0, MAT_SUGGEST_MAX);
      if (hits.some(o => optLabel(o).trim().toLowerCase() === ql)) return hits;
      return [{ value: '__typed__', label: typed.slice(0, MAX_LEN.description), meta: 'as typed', metaCls: 'new' }].concat(hits);
    }
    if (!ql) return opts;
    if (key === 'proc_projects' || key.startsWith('proc_contacts:') || key.startsWith('proc_codes:') || key.startsWith('proc_pos:')) {
      return opts.filter(o => withMeta(o).includes(ql));
    }
    return opts.filter(o => optLabel(o).toLowerCase().includes(ql));
  }

  // ── Shared supplier-contacts client ─────────────────────────────────
  // The contacts remembered under each supplier, read once per division and
  // kept here so the Procurement grid and the Suppliers tab see one list.
  const cc = { division: null, list: [], loaded: false, loading: null, listeners: new Set() };
  function ccFresh() {
    if (cc.division !== cfg.division) { cc.division = cfg.division; cc.list = []; cc.loaded = false; cc.loading = null; }
    return cc;
  }
  function ccNotify() { cc.listeners.forEach(f => { try { f(cc.list.slice()); } catch (e) { console.warn(e); } }); }
  function ccPut(c) {
    if (!c || c.id == null) return null;
    const norm = { id: String(c.id), supplier_name: str(c.supplier_name), name: str(c.name), email: str(c.email), phone: str(c.phone), updated_at: c.updated_at || null };
    const at = cc.list.findIndex(x => x.id === norm.id);
    if (at >= 0) cc.list[at] = norm; else cc.list.push(norm);
    return norm;
  }
  const contacts = {
    /** Every contact of the division, fetched once; force re-reads. */
    load(force) {
      const c = ccFresh();
      if (c.loaded && !force) return Promise.resolve(c.list.slice());
      if (c.loading && !force) return c.loading;
      const division = cfg.division;
      const p = api('GET', '/supplier-contacts' + q({})).then(data => {
        if (cc.division !== division) return [];
        cc.list = [];
        (data.contacts || []).forEach(ccPut);
        cc.loaded = true;
        ccNotify();
        return cc.list.slice();
      }).finally(() => { if (cc.loading === p) cc.loading = null; });
      c.loading = p;
      return p;
    },
    /** The contacts saved under one supplier (name matched case-insensitively). */
    list(supplierName) {
      const n = lc(supplierName);
      if (!n) return [];
      return ccFresh().list.filter(c => lc(c.supplier_name) === n)
        .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    },
    all() { return ccFresh().list.slice(); },
    get loaded() { return ccFresh().loaded; },
    /** Remember a contact under a supplier; the server merges duplicates. */
    async upsert({ supplier_name, name, email, phone } = {}) {
      ccFresh();
      const data = await api('POST', '/supplier-contacts' + q({}), {
        supplier_name: str(supplier_name).trim(), name: str(name).trim(), email: str(email).trim(), phone: str(phone).trim(),
      });
      const c = ccPut(data.contact);
      ccNotify();
      return c;
    },
    async update(id, fields) {
      ccFresh();
      const data = await api('PATCH', '/supplier-contacts' + q({ id }), fields || {});
      const c = ccPut(data.contact);
      ccNotify();
      return c;
    },
    async remove(id) {
      ccFresh();
      await api('DELETE', '/supplier-contacts' + q({ id }));
      cc.list = cc.list.filter(c => c.id !== String(id));
      ccNotify();
      return true;
    },
    /** A supplier was renamed: its contacts follow it, and so do the Vendor
     *  of every Procurement row and the Supplier of every purchase order that
     *  named it (the server does all of it in one request). Re-reads the
     *  contacts, since the server may have merged duplicates on the way, and
     *  the open job's rows. Resolves to the server's answer:
     *  { moved, merged, rows, pos, po_ids, po_error? }. */
    async rename(from, to) {
      ccFresh();
      const data = await api('POST', '/supplier-contacts' + q({ action: 'rename' }), { from: str(from), to: str(to) });
      try { await contacts.load(true); } catch (e) { console.warn('[procurement] contacts reload after rename failed', e); }
      if (st.projectId && st.loadState === 'ok' && st.loadedFor === viewSig()) await load(st.projectId, { quiet: true });
      return {
        moved: data.moved || 0, merged: data.merged || 0, rows: data.rows || 0,
        pos: data.pos || 0, po_ids: Array.isArray(data.po_ids) ? data.po_ids.map(String) : [],
        ...(data.po_error ? { po_error: String(data.po_error) } : {}),
      };
    },
    /** Called with the full list whenever it changes; returns an unsubscribe. */
    onChange(fn) { cc.listeners.add(fn); return () => cc.listeners.delete(fn); },
  };

  /**
   * A phone number typed into the Email cell — the sheets this replaces have
   * them there when a supplier's person has no email. "717-555-0142",
   * "(814) 555 0101 cell", "+1 717 555 0142 ext 12" are phones; anything
   * with an @, or with words left once the usual labels are taken off, is
   * not. The cell itself keeps what was typed; this only decides which of
   * the saved contact's fields it is filed under.
   */
  function looksLikePhone(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 60 || t.includes('@')) return false;
    const bare = t.replace(/\b(?:cell|mobile|mob|office|work|direct|main|phone|ph|tel|fax|ext|x)\b\.?:?/gi, ' ').trim();
    return /^[\d\s().+\-\/]{7,}$/.test(bare) && (bare.match(/\d/g) || []).length >= 7;
  }

  /** Whether a vendor is on the supplier list (as the page holds it). */
  function onSupplierList(name) {
    const n = lc(name);
    return !!n && suppliers().some(s => lc(s) === n);
  }

  // Recently remembered, so leaving a row twice does not post twice.
  const remembered = new Set();
  // Rows whose Contact or Email was typed or picked on this page since they
  // were last remembered. Only those are remembered: a row merely LEFT —
  // after a Date Delivered was typed on it, say — still shows whatever
  // contact it had, and saving that again would bring back a contact an
  // admin has since corrected or removed on Admin > Suppliers.
  const contactTouched = new Set();

  /** The saved contact of `vendor` that a row's Contact / Email is, or null. */
  function savedContactOf(vendor, row) {
    if (!row || !String(vendor || '').trim()) return null;
    const name = lc(row.contact), typed = lc(row.email);
    if (!name && !typed) return null;
    return contacts.list(vendor).find(c => (typed && (lc(c.email) === typed || lc(c.phone) === typed))
      || (name && lc(c.name) === name)) || null;
  }

  function rememberContact(row) {
    if (!row || !canEdit() || !contactTouched.has(row.id)) return;
    const vendor = row.vendor.trim(), name = row.contact.trim(), typed = row.email.trim();
    const phone = looksLikePhone(typed) ? typed : '';
    const email = phone ? '' : typed;
    const done = () => contactTouched.delete(row.id);
    // A phone alone is no contact (the server needs a name or an email).
    if (!name && !email) { done(); return; }
    // No vendor yet: kept for when there is one, which is who it is for.
    if (!vendor) return;
    // Contacts hang off the supplier list's names, and Admin > Suppliers is
    // the only place they are seen or tidied: saved under a vendor that was
    // typed but never added to the list, they could be neither. Once it is
    // added ("+ Add …" in the Vendor menu), the next time the row is left
    // saves them.
    if (!onSupplierList(vendor)) return;
    const saved = contacts.list(vendor);
    const hit = email
      ? saved.find(c => lc(c.email) === lc(email) && (c.name || !name))
      // Same name, and nothing new to add: a phone only fills a blank one.
      : saved.find(c => lc(c.name) === lc(name) && (!phone || c.phone));
    if (hit) { done(); return; }
    // An address another supplier's saved contact has is that supplier's
    // person — carried over on a row whose vendor was changed, most likely —
    // and is not filed under this one as well.
    if (email && contacts.all().some(c => lc(c.supplier_name) !== lc(vendor) && lc(c.email) === lc(email))) { done(); return; }
    const key = [lc(vendor), lc(name), lc(email), lc(phone)].join('|');
    done();
    if (remembered.has(key)) return;
    remembered.add(key);
    // The page's supplier list is up to a minute old: a supplier renamed (or
    // removed) by someone else since is still offered here, and a contact
    // filed under its old name would be seen nowhere. So the list is asked
    // first, when the page can; "don't know" goes ahead.
    const listed = typeof cfg.isSupplierListed === 'function'
      ? Promise.resolve().then(() => cfg.isSupplierListed(vendor)).catch(() => null) : Promise.resolve(null);
    listed.then(on => {
      if (on === false) {
        remembered.delete(key);
        // Kept for later, as a vendor not on the list is (above): once the
        // row's Vendor is put right, leaving it files the contact there.
        // And the PM is told, not just the console.
        contactTouched.add(row.id);
        console.warn(`[procurement] "${vendor}" is no longer on the supplier list; the contact was not remembered`);
        toast(`${name || email} was not saved as a contact: "${vendor}" is no longer on the supplier list `
          + '(renamed or removed on Admin > Suppliers). Pick the Vendor again from the list and it will be.', 'error');
        return null;
      }
      return contacts.upsert({ supplier_name: vendor, name, email, phone });
    }).catch(err => { remembered.delete(key); console.warn('[procurement] could not remember the contact', err); });
  }

  /**
   * Set a row's Vendor. When its Contact / Email are a saved contact of the
   * vendor it had, they are that supplier's person, not the new one's: both
   * are cleared (and said so), rather than left beside the new vendor to be
   * emailed by mistake — and filed under it as one of its people.
   */
  function changeVendor(rowId, name) {
    const row = rowById(rowId);
    if (!row || name === row.vendor) return false;
    const old = row.vendor.trim();
    const was = old && lc(old) !== lc(name) ? savedContactOf(old, row) : null;
    if (was) {
      setFields(rowId, { vendor: name, contact: '', email: '' });
      contactTouched.delete(row.id);
      toast(`Contact and Email cleared: ${was.name || was.email || 'that contact'} is a contact of ${old}, not of ${name || 'the new vendor'}.`);
    } else setField(rowId, 'vendor', name);
    return true;
  }

  // ── Row store + saving ──────────────────────────────────────────────
  const rowById = id => st.rows.find(r => r.id === String(id)) || null;

  function sameVal(a, b) {
    const na = a == null ? '' : a, nb = b == null ? '' : b;
    if (typeof na === 'number' || typeof nb === 'number') return sameNum(numOrNull(a), numOrNull(b));
    return String(na) === String(nb);
  }

  // When this page last took a row from the server, or dropped one (its own
  // delete, or a delete seen elsewhere), as a running count. A poll's answer
  // can land after a save's answer that is newer than it — the GET read the
  // table first — and load() uses these to tell what happened since its GET
  // went out from what the answer is telling it.
  let touchSeq = 0;
  const touched = new Map();    // row id -> touchSeq of the last take
  const gone = new Map();       // row id -> touchSeq of the drop

  // Take a row the server returned. A field the user has edited since — still
  // waiting to be sent, or sent and not answered — keeps the user's value;
  // everything else takes the server's. A copy OLDER than the one already in
  // hand (a lower version: a slow poll answer overtaken by a save's answer)
  // is ignored, or it would put the value just saved back to the old one on
  // screen until the next poll.
  function adoptServerRow(item) {
    const r = normRow(item);
    if (!r) return null;
    const known = server.get(r.id);
    if (known && Number(r.version) < Number(known.version)) return rowById(r.id);
    // Moved to another line by someone else: a re-link this page tried for
    // it (and would otherwise never try again) may be the right one now.
    if (known && known.bid_item_id !== r.bid_item_id) forgetRelinks(r.id);
    if (r.deleted_at) { dropRow(r.id); return null; }
    touched.set(r.id, ++touchSeq);
    server.set(r.id, { ...r });
    if (st.projectId && r.project_id && !isOpenJob(r.project_id)) return null;
    const local = rowById(r.id);
    if (!local) { const copy = { ...r }; st.rows.push(copy); return copy; }
    const keep = { ...(fly.get(r.id) || {}), ...(pend.get(r.id) || {}) };
    for (const k of Object.keys(r)) if (!(k in keep)) local[k] = r[k];
    return local;
  }

  function dropRow(id) {
    gone.set(id, ++touchSeq);
    st.rows = st.rows.filter(r => r.id !== id);
    clearTimeout(timers.get(id));
    timers.delete(id); pend.delete(id); server.delete(id); failed.delete(id);
    bases.delete(id); flyBases.delete(id); recent.delete(id);
    st.selected.delete(id); st.forceShow.delete(id);
    if (st.confirmDel === id) st.confirmDel = null;
  }

  /** Change one field of a row locally and queue it for saving. */
  function setField(rowId, field, value, { delay = SAVE_DELAY } = {}) {
    const row = rowById(rowId);
    if (!row || !canEdit()) return false;
    if ((field === 'contact' || field === 'email') && !sameVal(row[field], value)) contactTouched.add(row.id);
    row[field] = value;
    const base = baseOf(row.id, field);
    const p = pend.get(row.id) || {};
    const b = bases.get(row.id) || {};
    if (sameVal(base, value)) { delete p[field]; delete b[field]; }
    else {
      // The first change to a cell records what the person saw in it; later
      // keystrokes in the same cell keep that.
      if (!(field in p)) b[field] = takeSeen(row.id, field, base);
      p[field] = value;
    }
    if (Object.keys(b).length) bases.set(row.id, b); else bases.delete(row.id);
    // Changed here: no longer "changed by someone else".
    forgetRecent(row.id, field);
    if (Object.keys(p).length) {
      pend.set(row.id, p);
      schedule(row.id, delay);
    } else {
      pend.delete(row.id);
      clearTimeout(timers.get(row.id));
      timers.delete(row.id);
    }
    return true;
  }
  /** A cell's value as the page last had it from the server — or this page's own value still on its way there. */
  function baseOf(rowId, field) {
    const inFlight = fly.get(rowId);
    return inFlight && field in inFlight ? inFlight[field] : (server.get(rowId) || {})[field];
  }
  // A cell's value when it took focus, if it took focus lately; else `fallback`.
  const SEEN_MS = 10 * 60 * 1000;
  function takeSeen(rowId, field, fallback) {
    const key = rowId + '\u0000' + field;
    const s = seenAtFocus.get(key);
    seenAtFocus.delete(key);
    return s && Date.now() - s.at < SEEN_MS ? s.v : fallback;
  }
  // The fields a box saves: most are their own; the Sub Code picker saves the
  // line and its codes, the PO picker the PO and its auto flag.
  const FOCUS_FIELDS = { codes: ['bid_item_id', 'cost_code', 'sub_code'], po: ['po_id', 'po_auto'] };
  function onSeenFocusIn(e) {
    const t = e.target;
    const rowId = t && t.dataset && t.dataset.pr, pf = t && t.dataset && t.dataset.pf;
    if (!rowId || !pf || !rowById(rowId)) return;
    const pendNow = pend.get(rowId) || {};
    (FOCUS_FIELDS[pf] || [pf]).forEach(f => {
      // A cell already being changed keeps the value recorded when that began.
      if (f in pendNow) return;
      seenAtFocus.set(rowId + '\u0000' + f, { v: baseOf(rowId, f), at: Date.now() });
    });
  }
  function onSeenFocusOut(e) {
    const t = e.target;
    const rowId = t && t.dataset && t.dataset.pr, pf = t && t.dataset && t.dataset.pf;
    if (!rowId || !pf) return;
    // Kept a moment past the blur: a picker commits 120 ms after it is left.
    const keys = (FOCUS_FIELDS[pf] || [pf]).map(f => rowId + '\u0000' + f);
    const was = keys.map(k => seenAtFocus.get(k));
    setTimeout(() => keys.forEach((k, i) => { if (seenAtFocus.get(k) === was[i]) seenAtFocus.delete(k); }), 400);
  }
  function setFields(rowId, fields, opts) {
    let any = false;
    for (const [k, v] of Object.entries(fields)) any = setField(rowId, k, v, opts) || any;
    return any;
  }
  function schedule(rowId, ms) {
    clearTimeout(timers.get(rowId));
    timers.set(rowId, setTimeout(() => { flushRow(rowId); }, ms));
  }

  async function flushRow(rowId, { keepalive = false } = {}) {
    clearTimeout(timers.get(rowId));
    timers.delete(rowId);
    // One request per row at a time, so answers cannot arrive out of order;
    // whatever was edited meanwhile goes when this one is answered. The page
    // closing is the exception — there is no "afterwards" then.
    if (fly.has(rowId) && !keepalive) return;
    const p = pend.get(rowId);
    if (!p || !Object.keys(p).length) { pend.delete(rowId); bases.delete(rowId); return; }
    pend.delete(rowId);
    // What the person saw in each of these cells goes with them (expect): the
    // server writes them only while they still hold it.
    const b = bases.get(rowId) || {};
    const ex = {};
    Object.keys(p).forEach(k => { ex[k] = k in b ? b[k] : baseOf(rowId, k); if (ex[k] === undefined) delete ex[k]; });
    bases.delete(rowId);
    fly.set(rowId, p);
    flyBases.set(rowId, ex);
    setSave('saving');
    try {
      const data = await api('PATCH', '/procurement' + q({ id: rowId }), { fields: p, expect: ex }, { keepalive });
      if (fly.get(rowId) === p) { fly.delete(rowId); flyBases.delete(rowId); }
      failed.delete(rowId);
      if (data.item) adoptServerRow(data.item);
      refreshRow(rowId);
      updateCounts();
      if (touchesCode(p)) recountAfterRecode((data.item && data.item.project_id) || (rowById(rowId) || {}).project_id || st.projectId, [rowId]);
    } catch (err) {
      if (fly.get(rowId) === p) { fly.delete(rowId); flyBases.delete(rowId); }
      // An edit made while this one was out took this one's value as what it
      // "saw"; this one did not land, so it saw what this one saw.
      const rebase = keys => {
        const nb = bases.get(rowId) || {};
        keys.forEach(k => { if (k in ex) nb[k] = ex[k]; });
        Object.keys(nb).forEach(k => { if (!(k in (pend.get(rowId) || {}))) delete nb[k]; });
        if (Object.keys(nb).length) bases.set(rowId, nb); else bases.delete(rowId);
      };
      if (err.status === 409 && err.code === 'conflict' && !keepalive) {
        // Someone else changed a cell of this save since the person saw it:
        // nothing was written. The rest goes again at once; for those cells
        // the person is asked.
        onConflict(rowId, p, ex, err.data || {}, rebase);
      } else if (err.status === 404) {
        // Deleted by someone else while it was being edited: there is nothing
        // left to save into.
        dropRow(rowId);
        renderTable();
        updateCounts();
        showError('A row you were editing was deleted by someone else, so that change could not be saved.');
      } else if (err.status === 400 || err.code === 'stale_bid') {
        // Refused for good — a value the server will never take, or a bid
        // line that is no longer on the job's bid: sent again, it would be
        // refused again.
        refuseFields(rowId, p, err);
        rebase(Object.keys(p));
      } else {
        // Keep the user's values and try again on the next edit or refresh.
        pend.set(rowId, { ...p, ...(pend.get(rowId) || {}) });
        rebase(Object.keys(p));
        failed.add(rowId);
        // Said here rather than left to the page's banner, which cannot tell
        // this failure (value kept, sent again) from the others (nothing kept).
        showError(`Procurement: a change could not be saved (${err.message}). It stays on screen and is sent again on your next edit.`);
      }
    }
    if (pend.has(rowId) && !failed.has(rowId)) flushRow(rowId);
    settleSave();
  }

  // ── Someone else changed it meanwhile ──────────────────────────────
  // Cells saved together as one choice: a bid line and its codes, a PO and
  // its auto flag, a contact and the email picked with it. When one of them
  // was changed by someone else, the person decides for the group.
  const FIELD_GROUPS = [['bid_item_id', 'cost_code', 'sub_code'], ['po_id', 'po_auto'], ['contact', 'email']];
  const conflictQueue = [];
  let conflictOpen = false;
  /**
   * A save the server refused as a conflict: some of its cells no longer hold
   * what the person saw — someone else saved them meanwhile — so nothing was
   * written. The row takes the server's values; the save's other cells go
   * again at once (they still hold what was seen); and for the changed ones
   * the person is shown both values and picks.
   */
  function onConflict(rowId, p, ex, data, rebase) {
    let fields = (Array.isArray(data.fields) ? data.fields : []).filter(k => k in p);
    if (!fields.length || !data.item) {
      // Not one this page can show: kept, and sent again on the next edit.
      pend.set(rowId, { ...p, ...(pend.get(rowId) || {}) });
      rebase(Object.keys(p));
      failed.add(rowId);
      showError('Procurement: a change could not be saved (it was changed elsewhere meanwhile). It stays on screen and is sent again on your next edit.');
      return;
    }
    FIELD_GROUPS.forEach(g => { if (g.some(k => fields.includes(k))) fields = [...new Set(fields.concat(g.filter(k => k in p)))]; });
    const newer = pend.get(rowId) || {};
    // Yours: the newest value typed in each changed cell (one typed while
    // the refused save was out included).
    const mine = {};
    fields.forEach(k => { mine[k] = k in newer ? newer[k] : p[k]; delete newer[k]; });
    const again = {};
    Object.keys(p).forEach(k => { if (!fields.includes(k)) again[k] = p[k]; });
    const next = { ...again, ...newer };
    if (Object.keys(next).length) pend.set(rowId, next); else pend.delete(rowId);
    rebase(Object.keys(again));
    lineFill.delete(rowId);
    // The row as it is now: theirs in the changed cells, marked as theirs.
    adoptServerRow(data.item);
    const item = normRow(data.item) || {};
    markRecent(rowId, fields, data.changed_by, data.changed_at);
    refreshRow(rowId);
    updateCounts();
    conflictQueue.push({ rowId, fields, mine, theirs: item, by: str(data.changed_by), at: data.changed_at || null });
    showNextConflict();
  }

  const clock = at => { const d = at ? new Date(at) : null; return d && !isNaN(d) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; };
  /** What the conflict dialog shows for each changed cell: [what, theirs, yours]. */
  function conflictLines(c) {
    const theirs = c.theirs, mine = { ...theirs, ...c.mine };
    const in_ = keys => keys.some(k => c.fields.includes(k));
    const codes = o => [str(o.cost_code).trim(), str(o.sub_code).trim()].filter(Boolean).join(' / ') || '(blank)';
    const po = o => {
      if (o.po_id) { const x = (makeCtx().purchaseOrders || []).find(y => String(y.id) === String(o.po_id)); return x ? str(x.po_number) || '(no number)' : 'a PO no longer listed'; }
      return o.po_auto === false ? 'No PO' : 'Auto';
    };
    const lines = [];
    if (in_(FIELD_GROUPS[0])) lines.push(['Cost / Sub Code', codes(theirs), codes(mine)]);
    if (in_(FIELD_GROUPS[1])) lines.push(['PO #', po(theirs), po(mine)]);
    c.fields.filter(k => !FIELD_GROUPS[0].includes(k) && !FIELD_GROUPS[1].includes(k))
      .forEach(k => lines.push([FIELD_LABEL[k] || k, shownValue(k, theirs[k]), shownValue(k, mine[k])]));
    return lines;
  }
  function showNextConflict() {
    if (conflictOpen) return;
    const c = conflictQueue.shift();
    if (!c) return;
    const row = rowById(c.rowId);
    if (!row) { showNextConflict(); return; }
    conflictOpen = true;
    const who = c.by || 'Someone else';
    const name = materialOf(row, siteMode() && row.project_id ? makeCtx(row.project_id) : makeCtx()) || 'this row';
    const body = `<p style="margin:0 0 0.7rem;line-height:1.5">
        <b>${esc(who)}</b> changed <b>${esc(name)}</b>${clock(c.at) ? ` at ${esc(clock(c.at))}` : ''}, while you were editing it.
        Your change was not saved over theirs — pick which to keep.</p>
      <table class="fctproc-conflict"><thead><tr><th></th><th>${esc(who)}'s</th><th>Yours</th></tr></thead><tbody>
        ${conflictLines(c).map(([what, t, y]) => `<tr><td>${esc(what)}</td><td class="theirs">${esc(t)}</td><td class="mine">${esc(y)}</td></tr>`).join('')}
      </tbody></table>`;
    const foot = `<button type="button" class="btn btn-ghost fctproc-b" data-conflict="theirs">Keep ${esc(c.by ? c.by + "'s" : 'theirs')}</button>
      <button type="button" class="btn btn-green fctproc-b" data-conflict="mine">Keep mine</button>`;
    const m = modal('Changed by someone else', body, { footHTML: foot });
    let done = false;
    // Closed without a pick: theirs stays — nothing is written over it.
    m.onClose = () => { conflictOpen = false; setTimeout(showNextConflict, 0); };
    m.foot.addEventListener('click', e => {
      const b = e.target.closest('[data-conflict]');
      if (!b || done) return;
      done = true;
      if (b.dataset.conflict === 'mine' && rowById(c.rowId)) {
        // Written over theirs knowingly: what was "seen" is now theirs.
        Object.keys(c.mine).forEach(k => seenAtFocus.delete(c.rowId + '\u0000' + k));
        setFields(c.rowId, c.mine);
        refreshRow(c.rowId);
        flushRow(c.rowId);
      }
      m.close();
    });
  }

  // ── Cells other people changed ─────────────────────────────────────
  // The fields whose change by someone else is shown on the sheet.
  const WATCH_FIELDS = ['description', 'quantity', 'unit', 'sca_status', 'date_needed', 'lead_time_days', 'date_ordered',
    'date_delivered', 'vendor', 'quote_number', 'contact', 'email', 'po_id', 'po_auto', 'cost_code', 'sub_code', 'bid_item_id'];
  // The cells of each one-field column (the others are drawn in parts).
  const COL_FIELDS = { po: ['po_id', 'po_auto'], date_needed: ['date_needed'], quantity: ['quantity'], unit: ['unit'],
    description: ['description'], codes: ['bid_item_id', 'cost_code', 'sub_code'] };
  let recentTimer = null, recentDue = 0;
  function markRecent(rowId, fields, by, at, added = false) {
    const e = recent.get(rowId) || { fields: new Map(), added: null, until: 0 };
    fields.forEach(f => e.fields.set(f, { by: str(by), at: at || null }));
    if (added) e.added = { by: str(by), at: at || null };
    e.until = Date.now() + RECENT_MS;
    recent.set(rowId, e);
    scheduleRecentExpiry();
  }
  function forgetRecent(rowId, field) {
    const e = recent.get(rowId);
    if (!e || !e.fields.delete(field)) return;
    if (!e.fields.size && !e.added) recent.delete(rowId);
  }
  // "Changed by Dana at 2:14 PM" for the first of `fields` someone else
  // changed lately, else ''.
  function recentTip(rowId, fields) {
    const e = recent.get(rowId);
    if (!e || e.until <= Date.now()) return '';
    const f = fields.find(k => e.fields.has(k));
    if (!f) return '';
    const x = e.fields.get(f);
    return `Changed by ${x.by || 'someone else'}${clock(x.at) ? ` at ${clock(x.at)}` : ''}`;
  }
  function addedTip(rowId) {
    const e = recent.get(rowId);
    if (!e || !e.added || e.until <= Date.now()) return '';
    return `Added by ${e.added.by || 'someone else'}${clock(e.added.at) ? ` at ${clock(e.added.at)}` : ''}`;
  }
  // One timer, set for the mark due to fade first (set again when a sooner
  // one comes along); each row whose marks are due is redrawn without them.
  function scheduleRecentExpiry() {
    if (!recent.size) return;
    const next = Math.min(...[...recent.values()].map(e => e.until));
    if (recentTimer && recentDue <= next) return;
    if (recentTimer) clearTimeout(recentTimer);
    recentDue = next;
    recentTimer = setTimeout(() => {
      recentTimer = null;
      const now = Date.now(), done = [];
      recent.forEach((e, id) => { if (e.until <= now) { recent.delete(id); done.push(id); } });
      done.forEach(id => refreshRow(id));
      scheduleRecentExpiry();
    }, Math.max(250, next - Date.now() + 50));
  }
  /**
   * A poll's rows against the copies the page held before it: a cell whose
   * value moved — saved by someone else, since this page's own saves update
   * its copy as they are answered — is marked for a while, and so is a row
   * this page did not add. Cells being changed here are left out (a clash
   * there is the save's to catch), and so are changes under this person's
   * own name (another window of theirs).
   */
  function noteOthersChanges(items, before) {
    const me = (() => { try { return lc(cfg.getUserName()); } catch { return ''; } })();
    items.forEach(raw => {
      const it = normRow(raw);
      if (!it || it.deleted_at || !rowById(it.id)) return;
      const prev = before.get(it.id);
      if (!prev) {
        const by = it.created_by || it.updated_by;
        if (!me || lc(by) !== me) markRecent(it.id, [], by, it.created_at, true);
        return;
      }
      if (Number(it.version) <= Number(prev.version)) return;
      if (me && lc(it.updated_by) === me) return;
      const mine = { ...(fly.get(it.id) || {}), ...(pend.get(it.id) || {}) };
      const changed = WATCH_FIELDS.filter(f => !(f in mine) && !sameVal(prev[f], it[f]));
      if (changed.length) markRecent(it.id, changed, it.updated_by, it.updated_at);
    });
  }

  // What a refused value is called in the message about it.
  const FIELD_LABEL = {
    description: 'Material', quantity: 'Quantity', unit: 'Unit', sca_status: 'Sub-Contractor Agreement',
    date_needed: 'Date Needed', lead_time_days: 'Lead Time (days)', date_ordered: 'Date Ordered',
    date_delivered: 'Date Delivered', vendor: 'Vendor', quote_number: 'Quote #', contact: 'Contact', email: 'Email',
    po_id: 'PO #', po_auto: 'PO #', cost_code: 'Cost Code', sub_code: 'Sub Code', bid_item_id: 'Cost / Sub Code',
    bid_qty_at_send: 'Bid quantity', bid_unit_at_send: 'Bid unit',
  };
  function shownValue(field, v) {
    if (v == null || v === '') return '(blank)';
    if (/^date_/.test(field)) {
      const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(String(v));
      if (m) return `${m[2]}/${m[3]}/${m[1]}`;
    }
    const t = String(v);
    return t.length > 60 ? t.slice(0, 57) + '…' : t;
  }

  /**
   * The server refused a save outright (400): a value it will never take — a
   * year it does not accept, a description past its length. Sent again it
   * would be refused again, and since every later edit of the row goes in the
   * same PATCH, it would take each of those down with it, and all of them
   * would be gone on the next reload. So the refused value is dropped: its
   * cell goes back to what is saved, the message names it, and the row's
   * other changes go on their way at once. When the answer does not say
   * which value it was, the whole of that PATCH is what was refused.
   */
  function refuseFields(rowId, p, err) {
    let named = err.field && Object.prototype.hasOwnProperty.call(p, err.field) ? [err.field] : Object.keys(p);
    // A bid line refused (stale_bid) takes its codes with it: they came from
    // the same pick, and saved without the line they would leave the row
    // coded but tied to nothing — never re-linked, never renamed with the
    // bid, and offered again by Send as a new line.
    // So does the Quantity / Unit that pick filled in (fillFromLine), unless
    // something else has been put there since.
    const fill = lineFill.get(rowId);
    const filled = named.includes('bid_item_id') && fill && fill.bid_item_id === p.bid_item_id
      ? Object.keys(fill.fields).filter(k => k in p && sameVal(p[k], fill.fields[k])) : [];
    if (named.includes('bid_item_id')) {
      named = [...new Set([...named, ...['cost_code', 'sub_code'].filter(k => k in p), ...filled])];
      lineFill.delete(rowId);
    }
    const ofPick = k => k === 'cost_code' || k === 'sub_code' || filled.includes(k);
    const row = rowById(rowId), saved = server.get(rowId) || {};
    const newer = pend.get(rowId) || {};
    const rest = {};
    Object.keys(p).forEach(k => { if (!named.includes(k)) rest[k] = p[k]; });
    // A value typed into the same cell since this PATCH went is the user's
    // next try, and is sent on its own merits.
    // A newer bid-line pick made while the refused one was out owns the
    // codes now: a code it shares with the refused pick was left out of it
    // (equal to the one in flight), so it is carried into the next save
    // rather than put back — else the row would be saved linked with a
    // blank stored code.
    const repick = 'bid_item_id' in newer;
    const carried = {};
    named.forEach(k => {
      if (!row || k in newer || !(k in saved)) return;
      if (repick && ofPick(k)) {
        if (!sameVal(row[k], saved[k])) carried[k] = row[k];
        return;
      }
      row[k] = saved[k];
    });
    const next = { ...rest, ...carried, ...newer };
    if (Object.keys(next).length) pend.set(rowId, next); else pend.delete(rowId);
    failed.delete(rowId);
    // The line and its codes are one pick, named as one.
    const one = named.includes('bid_item_id') ? named.filter(k => !ofPick(k)) : named;
    const what = [...new Set(one.map(k => FIELD_LABEL[k] || k))];
    // A bid line's id means nothing to a PM; its codes are named instead.
    const vals = one.length === 1 && one[0] !== 'bid_item_id' ? ` "${shownValue(one[0], p[one[0]])}"` : '';
    showError(`Procurement: ${what.join(', ')}${vals} ${one.length === 1 ? 'was' : 'were'} not saved — ${err.message}. `
      + `${one.length === 1 ? 'The cell is' : 'Those cells are'} back to what was saved`
      + `${Object.keys(rest).length ? '; the rest of the row\'s changes go on without it' : ''}.`);
    if (named.includes('bid_item_id') && row && !('bid_item_id' in newer)) resetCodesBox(rowId);
    refreshRow(rowId);
    updateCounts();
    // Shown as not saved even when nothing else is left to send — "Saved"
    // would be the wrong word for an edit that was thrown away.
    if (!fly.size && !Object.keys(next).length) setSave('error');
  }
  // The refused line's Sub Code box can outlive the redraw (it is about to
  // commit, 120 ms after blur, or still has focus) and still holds the pick:
  // it would commit that line again and be refused again. So it is put back
  // to the saved codes, and its pick forgotten — a later commit of it is
  // "nothing chosen" until the user picks again.
  function resetCodesBox(rowId) {
    const wrap = st.mountEl && st.mountEl.querySelector('#fctproc-wrap');
    const box = wrap && wrap.querySelector(`[data-pr="${cssEsc(rowId)}"][data-pf="codes"]`);
    const row = rowById(rowId);
    if (!box || !row) return;
    box.value = liveCodes(row, makeCtx()).sub_code || '';
    if (row.bid_item_id) box.dataset.cbValue = String(row.bid_item_id); else delete box.dataset.cbValue;
    cbSession.set(box, { value: box.value, cbValue: box.dataset.cbValue || '', chosen: false, nav: false, cleared: false });
  }

  function flushAll(opts) {
    const ids = [...pend.keys()];
    return Promise.all(ids.map(id => flushRow(id, opts)));
  }

  function setSave(state) {
    st.saveState = state;
    clearTimeout(savedTimer);
    const el = st.mountEl && st.mountEl.querySelector('#fctproc-save');
    if (el) {
      el.className = `save-indicator fctproc-save ${state}`;
      const text = { saving: 'Saving…', saved: 'Saved', error: 'Not saved', idle: '' }[state] || '';
      el.querySelector('.si-text').textContent = text;
      el.title = state === 'error' ? 'A change could not be saved — the message at the top of the page says which, and what happens to it.' : '';
    }
    if (state === 'saved') savedTimer = setTimeout(() => setSave('idle'), 2500);
  }
  function settleSave() {
    if (fly.size) setSave('saving');
    else if (failed.size) setSave('error');
    else if (st.saveState === 'saving') setSave('saved');
  }

  // A save started as the page goes away (closed, reloaded, switched to
  // another browser tab) has to be sent now and survive the unload.
  window.addEventListener('pagehide', () => { flushAll({ keepalive: true }); });
  // …but a save that has already failed (the server or the connection is
  // down) will fail again as the page closes, and one still out may never be
  // answered. The banner promised those edits are kept and sent again, so
  // leaving now asks first — the browser's own "Leave site?" — the way the
  // page already does for unsent Daily rows.
  window.addEventListener('beforeunload', e => {
    if (!failed.size && !fly.size && !pend.size) return;
    e.preventDefault();
    e.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll({ keepalive: true });
  });

  // ── Loading ─────────────────────────────────────────────────────────
  async function load(projectId, { quiet = false } = {}) {
    if (!projectId) return;
    const gen = ++loadGen;
    // A site is its jobs' rows, each job read as on its own sheet — the API
    // knows nothing of sites — and is one answer: all of them, or a failure.
    const sig = viewSig(projectId), jobIds = openIds(projectId);
    if (!quiet) {
      st.loadState = 'loading';
      st.loadError = '';
      renderBody();
    }
    const mark = touchSeq;
    try {
      let data;
      if (isSiteKey(projectId)) {
        const all = await Promise.all(jobIds.map(pid => api('GET', '/procurement' + q({ project_id: pid }))));
        data = { items: [].concat(...all.map(d => d.items || [])) };
        // Read-only on any one of them is read-only here: a row's cells do
        // not change kind from one job's band to the next.
        if (all.length && all.every(d => typeof d.canEdit === 'boolean')) data.canEdit = all.every(d => d.canEdit);
      } else {
        data = await api('GET', '/procurement' + q({ project_id: projectId }));
      }
      if (gen !== loadGen || projectId !== st.projectId) return;
      if (typeof data.canEdit === 'boolean') st.serverCanEdit = data.canEdit;
      const before = signature();
      const since = (m, id) => (m.get(id) || 0) > mark;
      // A row this page deleted while the GET was out is still in its answer;
      // it is not brought back.
      const items = (data.items || []).map(normRow).filter(Boolean).filter(r => !since(gone, r.id));
      const ids = new Set(items.map(r => r.id));
      // Rows gone from the server were deleted elsewhere — unless this page is
      // still saving into them (the save will find out), or took them from
      // the server after the GET went out ("+ Add Row" a moment ago, a row
      // sent or restored): the answer is older than those, not news of them.
      st.rows.filter(r => !ids.has(r.id) && !pend.has(r.id) && !fly.has(r.id) && !since(touched, r.id)).forEach(r => dropRow(r.id));
      // A refresh of the sheet already on screen: what other people changed
      // since is marked (noteOthersChanges), against the copies held now. A
      // row taken from the server after this GET went out is newer than the
      // answer, and not news.
      const known = quiet && st.loadState === 'ok' && st.loadedFor === sig
        ? new Map(items.filter(r => !since(touched, r.id)).map(r => [r.id, server.get(r.id) ? { ...server.get(r.id) } : null])) : null;
      items.forEach(adoptServerRow);
      if (known) noteOthersChanges(items.filter(r => known.has(r.id)), known);
      const wasOk = st.loadState === 'ok' && st.loadedFor === sig;
      st.loadState = 'ok';
      st.loadedFor = sig;
      if (!wasOk || !quiet) renderBody();
      else if (signature() !== before) {
        // The answer can land after the PM has started typing (the poll only
        // checks as it starts): then the rows are redrawn around the cell in
        // use, never the table under it — see redrawAround.
        if (cellInUse()) redrawAround();
        else { renderTable(); updateCounts(); }
        renderHead();
      } else if (redrawDeferred && !cellInUse()) {
        // A redraw still owed from an answer that landed mid-edit.
        redrawWhenFree();
      }
      if (isSiteKey(projectId)) autoRelinkAll(jobIds); else autoRelink(projectId);
      // The paperclip and folder counts are read with the rows — on the first
      // read and on every poll — since a file a colleague attached changes no
      // row, and so would never show here otherwise.
      jobIds.forEach(refreshDocCounts);
      // The Material picker's names from earlier jobs, for someone who can
      // type one — read after the rows (never ahead of them), and only every
      // few minutes; every load in between is a no-op.
      if (canEdit() && !colHidden('description')) loadLibrary();
    } catch (err) {
      if (gen !== loadGen) return;
      // A failed poll leaves what is on screen alone. A failed first read is
      // shown as a failure — never as an empty job, which would invite
      // someone to start re-entering rows that are really there.
      if (quiet && st.loadState === 'ok' && st.loadedFor === sig) {
        console.warn('[procurement] refresh failed', err);
        return;
      }
      st.loadState = 'error';
      st.loadError = err.message;
      renderBody();
    }
  }
  function signature() {
    return st.rows.map(r => `${r.id}:${r.version}:${r.updated_at}`).sort().join('|');
  }

  // ── Attachment counts ───────────────────────────────────────────────
  // Whether a save's fields can move a line to another cost code: its code
  // itself, or the bid line it is tied to (whose code the line then shows).
  const touchesCode = f => Boolean(f) && (Object.prototype.hasOwnProperty.call(f, 'cost_code')
    || Object.prototype.hasOwnProperty.call(f, 'bid_item_id'));

  /**
   * After a save that can have moved lines to another cost code — a Sub Code
   * picked, a re-link to a replaced bid line, a deleted line brought back on
   * a new one. The server has already moved those lines' files to the new
   * code's folder by the time it answers (api/procurement.js), so the
   * section folder chips are counted again now: left to the next poll, the
   * old section's chip went on counting a file for up to a minute after the
   * line had left it. Only a line with something attached moves anything, so
   * a re-code of lines with nothing attached asks for nothing.
   */
  function recountAfterRecode(projectId, rowIds) {
    if (!projectId || isSiteKey(projectId) || !(rowIds || []).some(id => attachmentCount(projectId, id) > 0)) return;
    refreshDocCounts(projectId);
  }

  // The counts live with the page (its document module keeps them); this
  // asks it to read them again for a job and, once it has, redraws whatever
  // they changed. Never rejects: a count that could not be read leaves the
  // numbers already drawn, which is all a failed poll of the rows does too.
  function refreshDocCounts(projectId) {
    if (typeof cfg.refreshAttachmentCounts !== 'function' || !projectId) return Promise.resolve(false);
    return Promise.resolve()
      .then(() => cfg.refreshAttachmentCounts(projectId))
      .then(() => {
        // Another job was opened meanwhile: its own read asks for its counts.
        if (!isOpenJob(projectId)) return false;
        paintDocCounts();
        return true;
      }, err => {
        console.warn('[procurement] could not read the attachment counts', err);
        return false;
      });
  }

  /**
   * Redraw the paperclips and section folder chips whose count has changed,
   * and nothing else. Each row on screen is redrawn the way a background
   * refresh redraws it (refreshRow with onlyIfChanged): a row whose drawing
   * is the same as before is left alone, so counts that did not move cost no
   * redraw at all, and a cell being typed in keeps its box. Held while a
   * press in the sheet is down, as a rerender is, so the button under the
   * pointer — the paperclip itself, often — is not replaced before the click.
   */
  let docCountsOwed = false;
  function paintDocCounts() {
    if (!isMounted() || st.loadState !== 'ok' || st.loadedFor !== viewSig()) return;
    const wrap = st.mountEl.querySelector('#fctproc-wrap');
    if (!wrap) return;
    if (pressedAt && Date.now() - pressedAt < 5000) { docCountsOwed = true; return; }
    docCountsOwed = false;
    const ctx = makeCtx();
    [...wrap.querySelectorAll('tr.fctproc-row')].forEach(tr => refreshRow(tr.dataset.row, null, ctx, true));
    updateGroupDocs(ctx);
  }

  /**
   * Whether the table holds a cell being typed in, or a combobox that has
   * just been left and is about to commit (120 ms after blur).
   */
  function cellInUse() {
    const wrap = st.mountEl && st.mountEl.querySelector('#fctproc-wrap');
    if (!wrap) return false;
    const a = document.activeElement;
    return !!((a && a !== document.body && wrap.contains(a)) || wrap.querySelector('[data-pcommit]'));
  }

  /**
   * Other people's changes, merged in around a cell in use. Rebuilding the
   * table would replace the box being typed in: a combobox loses its menu
   * and the rest of the word, a date box restarts at its month — so the
   * day and year keys land in the wrong place and a wrong date is saved.
   * Instead each row on screen is redrawn in place (refreshRow keeps the
   * cell in use as it is), rows deleted elsewhere go, and the full redraw —
   * for rows added elsewhere, and the order and grouping (a row moved to
   * another vendor or cost code, a group's count) — waits until the table
   * is left — when the table drawn now would not have the same rows, in the
   * same order, under the same headers as the one on screen.
   *
   * Only a row whose drawing has changed is redrawn: a refresh that changes
   * nothing on this job (an order raised on another one, say) costs a pass
   * over the rows' HTML, not hundreds of rows rebuilt under the PM's typing,
   * and leaves no full redraw owed.
   */
  let redrawDeferred = false;
  // A whole-sheet redraw the page asked for (rerender) while a press in the
  // sheet was down: drawn once the button is up (see rerender).
  let rerenderOwed = false;
  // When a mouse button went down in the sheet, until it comes up (0).
  let pressedAt = 0;
  function onSheetMouseDown(e) { if (e.button === 0) pressedAt = Date.now(); }
  function onDocMouseUp() {
    if (!pressedAt) return;
    pressedAt = 0;
    // After the click the press was aimed at (it fires before this runs).
    if (rerenderOwed) setTimeout(() => {
      if (!rerenderOwed || pressedAt) return;       // drawn since, or pressed again
      rerenderOwed = false;
      window.FCTProcurement.rerender();
    }, 0);
    if (redrawDeferred) setTimeout(redrawWhenFree, 0);
    // Counts that came in while the button was down (paintDocCounts).
    if (docCountsOwed) setTimeout(() => { if (docCountsOwed && !pressedAt) paintDocCounts(); }, 0);
  }
  document.addEventListener('mouseup', onDocMouseUp, true);
  window.addEventListener('blur', onDocMouseUp);
  function redrawAround() {
    const wrap = st.mountEl && st.mountEl.querySelector('#fctproc-wrap');
    if (!wrap) return;
    const shown = new Set([...wrap.querySelectorAll('tr.fctproc-row')].map(tr => tr.dataset.row));
    const ctx = makeCtx();
    shown.forEach(id => refreshRow(id, null, ctx, true));
    if (layoutOf(visibleRows(ctx), ctx) !== drawnLayout) redrawDeferred = true;
    updateCounts();
  }
  // What the table on screen is made of — its rows, their order, the headers
  // over them — as renderTable drew it, and as it would draw it now.
  let drawnLayout = '';
  function layoutOf(rows, ctx, groups) {
    if (!st.rows.length || !rows.length) return '';     // a note, not a table
    if (!groups) groups = groupRows(rows, ctx);
    // A site's job bands, and which are folded (a folded job hides its sections).
    const bands = jobBands(ctx) ? 'J:' + openIds().map(pid => pid + (st.collapsed.has(JOB + pid) ? '-' : '+')).join(',') + '\n' : '';
    const shut = g => !!(g.pid && st.collapsed.has(JOB + g.pid));
    return `${st.rows.length}/${rows.length}/${st.grouping}\n` + bands + groups.map(g => (st.grouping === 'none' ? '' : `G:${g.key}|${g.label}|${g.meta}\n`)
      + (st.grouping === 'none' || (!shut(g) && !st.collapsed.has(g.key)) ? g.rows.map(r => r.id).join('\n') : '')).join('\n');
  }
  function redrawWhenFree() {
    if (!redrawDeferred || !isMounted()) return;
    // A press in the sheet (on a group header, a filter button) blurs the
    // cell first: redrawn now, the header under the pointer is replaced
    // before the button comes up, and the click lands on nothing. Paid once
    // the button is up — after the click it was aimed at.
    if (pressedAt && Date.now() - pressedAt < 5000) return;
    const wrap = st.mountEl.querySelector('#fctproc-wrap');
    // A combobox still committing: shortly. Another cell taken: the next
    // time one is left.
    if (wrap && wrap.querySelector('[data-pcommit]')) { setTimeout(redrawWhenFree, 250); return; }
    if (cellInUse()) return;
    redrawDeferred = false;
    renderTable();
    updateCounts();
  }

  function selectProject(id) {
    const next = id || null;
    if (next === st.projectId) return;
    flushAll();
    loadGen++;                          // drop any answer still coming for the old job
    st.projectId = next;
    storeSet('project', next);
    st.rows = [];
    st.loadedFor = null;
    st.serverCanEdit = null;
    st.selected.clear();
    st.forceShow.clear();
    st.collapsed.clear();
    st.confirmDel = null;
    st.bulkConfirmDel = false;
    st.filters = {};
    st.search = '';
    st.loadState = next ? 'loading' : 'none';
    renderBody();
    if (next) load(next);
    // The page's order list is read again alongside the rows: a PO list a
    // few minutes behind (a supplier renamed since, an order raised in
    // central purchasing) would otherwise show this job's rows as not on
    // their orders until the page's next poll. The host redraws the sheet
    // when the list it holds changes.
    if (next) refreshPOs();
  }
  function refreshPOs() {
    if (typeof cfg.refreshPurchaseOrders !== 'function') return Promise.resolve(false);
    return Promise.resolve().then(() => cfg.refreshPurchaseOrders()).catch(err => {
      console.warn('[procurement] could not read the purchase orders again', err);
      return false;
    });
  }

  // ── Rendering ───────────────────────────────────────────────────────
  const isMounted = () => !!(st.mountEl && st.mountEl.isConnected);

  function renderShell() {
    const el = st.mountEl;
    if (!el) return;
    injectStyles();
    const known = keyExists(st.projectId);
    const label = known ? openLabel() : '';
    el.innerHTML = `
      <div class="fctproc">
        <div class="fctproc-top">
          <span class="fctproc-title">Procurement</span>
          <span class="fctproc-lbl">Job</span>
          ${cbCell('proc_projects', label, 'Search jobs or sites…',
            `id="fctproc-proj" data-cb-value="${esc(known ? st.projectId : '')}" aria-label="Job or site"`, false)}
          <label class="fctproc-check" title="List every job, not only Awarded / In Progress / Substantially Complete (a site's sheet takes in its other jobs too)">
            <input type="checkbox" id="fctproc-showall" ${st.showAll ? 'checked' : ''}> Show all jobs
          </label>
          <span id="fctproc-save" class="save-indicator fctproc-save idle"><span class="si-dot"></span><span class="si-text"></span></span>
        </div>
        <div id="fctproc-body"></div>
      </div>`;
    renderBody();
    setSave(st.saveState === 'saved' ? 'idle' : st.saveState);
  }

  function renderBody() {
    if (!st.mountEl) return;
    const body = st.mountEl.querySelector('#fctproc-body');
    if (!body) return;
    if (!st.projectId) {
      body.innerHTML = `<div class="fctproc-empty">
        Pick a job above to see what has to be bought for it.<br>
        <span style="font-size:0.78rem">Only live jobs are listed — tick <b>Show all jobs</b> for the rest.
        Jobs on one site (the same <b>Site</b> on the job page) can also be opened together.</span></div>`;
      return;
    }
    let name;
    if (siteMode()) {
      // An empty list is the page still loading its jobs, not a deleted site.
      if (!projects().length) { body.innerHTML = '<div class="fctproc-empty">Loading the job list…</div>'; return; }
      if (!keyExists(st.projectId)) {
        body.innerHTML = '<div class="fctproc-empty">No job has that Site any more. Pick a job or another site above.</div>';
        return;
      }
      name = siteLabel(st.projectId);
      if (!openIds().length) {
        body.innerHTML = `<div class="fctproc-empty">None of the jobs on ${esc(name)} is live (Awarded, In Progress or Substantially Complete).<br>
          <span style="font-size:0.78rem">Tick <b>Show all jobs</b> to see the rest of the site.</span></div>`;
        return;
      }
    } else {
      const p = project(st.projectId);
      if (!p) {
        // An empty list is the page still loading its jobs, not a deleted job.
        body.innerHTML = projects().length
          ? '<div class="fctproc-empty">That job is no longer on the job list. Pick another one above.</div>'
          : '<div class="fctproc-empty">Loading the job list…</div>';
        return;
      }
      name = projLabel(p);
    }
    if (st.loadState === 'loading' && st.loadedFor !== viewSig()) {
      body.innerHTML = `<div class="fctproc-empty">Loading procurement for ${esc(name)}…</div>`;
      return;
    }
    if (st.loadState === 'error') {
      body.innerHTML = `<div class="fctproc-err">
        Could not load the procurement rows for ${esc(name)}: ${esc(st.loadError)}
        <div style="margin-top:0.7rem"><button type="button" class="btn btn-ghost fctproc-b" data-act="retry">Try again</button></div></div>`;
      return;
    }
    body.innerHTML = `
      <div class="fctproc-head" id="fctproc-head"></div>
      <div class="fctproc-bar" id="fctproc-bar"></div>
      <div id="fctproc-bulk"></div>
      <div class="fctproc-wrap" id="fctproc-wrap"></div>`;
    renderHead();
    renderBar();
    renderBulk();
    renderTable();
  }

  function statusCounts(ctx) {
    const n = { 'Not Ordered': 0, Ordered: 0, Delivered: 0, [UNKNOWN]: 0, late: 0 };
    st.rows.forEach(r => {
      n[statusOf(r, ctx)]++;
      if (flagsOf(r, ctx).some(f => f.level === 'red')) n.late++;
    });
    return n;
  }
  function countsHtml(ctx) {
    const n = statusCounts(ctx);
    return `<span class="fctproc-pill st-not" title="Not ordered yet">Not Ordered<span class="n">${n['Not Ordered']}</span></span>
      <span class="fctproc-pill st-ord" title="On a PO or given a date ordered, not delivered">Ordered<span class="n">${n.Ordered}</span></span>
      <span class="fctproc-pill st-del" title="Date delivered filled in">Delivered<span class="n">${n.Delivered}</span></span>
      ${n[UNKNOWN] ? (ctx.poFailed
        ? `<span class="fctproc-pill st-unk po-failed" title="The purchase orders could not be read from the server. The page tries again every minute; until then whether these rows are ordered is not known.">POs not loaded — retrying<span class="n">${n[UNKNOWN]}</span></span>`
        : `<span class="fctproc-pill st-unk" title="The purchase orders have not loaded yet, so whether these rows are ordered is not known">POs loading…<span class="n">${n[UNKNOWN]}</span></span>`) : ''}
      ${n.late ? `<span class="fctproc-pill n-red" title="Late to order, or late to arrive">Late<span class="n">${n.late}</span></span>` : ''}`;
  }

  function renderHead() {
    const head = st.mountEl && st.mountEl.querySelector('#fctproc-head');
    if (!head) return;
    const p = project(st.projectId) || {};
    const ctx = makeCtx();
    const edit = canEdit();
    const site = siteMode();
    // A site names its jobs: each keeps its own rows, bid and POs.
    const title = site
      ? `<span class="fctproc-job">${esc(siteLabel(st.projectId))}</span>
         <span class="fctproc-jobno fctproc-sitejobs" title="Each job keeps its own rows, bid, POs and costs">Site · ${openIds().map(pid => {
           const j = project(pid) || {};
           return esc(projLabel(j)) + (j['job-number'] ? ` <span class="n">#${esc(j['job-number'])}</span>` : '');
         }).join(' · ')}</span>`
      : `<span class="fctproc-job">${esc(str(p['project-name']) || 'Untitled job')}</span>
      ${p['job-number'] ? `<span class="fctproc-jobno">Job #${esc(p['job-number'])}</span>` : ''}`;
    head.innerHTML = `
      ${title}
      <span class="fctproc-counts" id="fctproc-counts">${countsHtml(ctx)}</span>
      <span class="fctproc-cluster fctproc-right">
      ${edit ? `<button type="button" class="btn btn-ghost fctproc-b" data-act="send" title="${site ? 'Pick a job, then its bid lines to add to this sheet as rows' : 'Pick bid lines to add to this sheet as rows'}">&#10148; Add to Procurement</button>
                <button type="button" class="btn btn-green fctproc-b" data-act="add"${site ? ' title="Pick the job, then add a row to it"' : ''}>+ Add Row</button>` : ''}
      <button type="button" class="btn btn-ghost fctproc-b" data-act="xlsx" title="The rows shown, as an Excel workbook">&#11015; Excel</button>
      <button type="button" class="btn btn-ghost fctproc-b" data-act="csv" title="The rows shown, as CSV">&#11015; CSV</button>
      <button type="button" class="btn btn-ghost fctproc-b" data-act="pdf" title="The rows shown, to print or save as a PDF">&#11015; PDF</button>
      </span>`;
  }

  const CHIPS = [
    { key: 'all', label: 'All' },
    { key: 'not_ordered', label: 'Not ordered' },
    { key: 'due14', label: 'Due in 14 days', tone: 'amber' },
    { key: 'late', label: 'Late', tone: 'red' },
    { key: 'sca_open', label: 'Sub agreement open', tone: 'amber' },
    { key: 'not_delivered', label: 'Not delivered' },
  ];
  function chipsHtml(ctx) {
    return CHIPS.map(c => {
      const n = c.key === 'all' ? st.rows.length : st.rows.filter(r => chipMatch(c.key, r, ctx)).length;
      return `<button type="button" class="fctproc-chip${st.chip === c.key ? ' on' : ''}${n && c.tone ? ' c-' + c.tone : ''}"
        data-chip="${c.key}">${esc(c.label)}<span class="n">${n}</span></button>`;
    }).join('');
  }
  function filtersActive() {
    return !!(st.search.trim() || st.chip !== 'all' || Object.keys(st.filters).length);
  }

  function renderBar() {
    const bar = st.mountEl && st.mountEl.querySelector('#fctproc-bar');
    if (!bar) return;
    const ctx = makeCtx();
    const seg = (k, label) => `<button type="button" data-group="${k}" class="${st.grouping === k ? 'on' : ''}">${label}</button>`;
    bar.innerHTML = `
      <input type="text" id="fctproc-search" class="fctproc-search" placeholder="&#128269; Search rows…"
             value="${esc(st.search)}" autocomplete="off" spellcheck="false" aria-label="Search rows">
      <span class="fctproc-chips" id="fctproc-chips">${chipsHtml(ctx)}</span>
      <button type="button" class="fctproc-link" data-act="clear" id="fctproc-clear" ${filtersActive() ? '' : 'hidden'}>Clear filters</button>
      <span class="fctproc-cluster fctproc-right">
        <span class="fctproc-lbl">Group</span>
        <span class="fctproc-seg">${seg('cost', 'Cost code')}${seg('vendor', 'Vendor / Quote')}${seg('none', 'None')}</span>
        <span class="fctproc-shown" id="fctproc-shown"></span>
      </span>`;
  }

  /** The counts in the header and on the chips, without touching the search box. */
  function updateCounts() {
    if (!isMounted()) return;
    const ctx = makeCtx();
    const counts = st.mountEl.querySelector('#fctproc-counts');
    if (counts) counts.innerHTML = countsHtml(ctx);
    const chips = st.mountEl.querySelector('#fctproc-chips');
    if (chips) chips.innerHTML = chipsHtml(ctx);
    const clear = st.mountEl.querySelector('#fctproc-clear');
    if (clear) clear.hidden = !filtersActive();
    updateGroupCounts(ctx);
    updateGroupDocs(ctx);
    fitWrap();
  }

  // ── Fitting the table to the window ─────────────────────────────────
  // The table scrolls inside its own box (sticky header, pinned columns), so
  // the box has to end inside the window: past it the page scrolls as well,
  // and the box's own sideways scrollbar sits below the fold — the one the
  // PM needs all the time for Vendor, Quote #, Contact and Email. Where the
  // box starts depends on what is above it (a nav that wraps to two lines on
  // a laptop, the bulk bar while rows are ticked), so it is measured rather
  // than guessed: from its top to the bottom of the window, less what the
  // page keeps below it. Never under the stylesheet's 14rem.
  function fitWrap() {
    const wrap = st.mountEl && st.mountEl.querySelector('#fctproc-wrap');
    if (!wrap || !wrap.offsetParent) return;          // not on screen (another tab is)
    const doc = document.documentElement;
    const minPx = 14 * (parseFloat(getComputedStyle(doc).fontSize) || 16);
    const top = wrap.getBoundingClientRect().top + (window.pageYOffset || 0);
    let max = Math.max(minPx, Math.floor(window.innerHeight - top - 16));
    wrap.style.maxHeight = max + 'px';
    // Whatever the page keeps under the box (padding, a footer) is not known
    // here, so it is measured: if the page still scrolls while the box is at
    // its full height, the box gives up that much. Worked out from the window
    // each time, never from the last answer, so it cannot creep.
    const over = doc.scrollHeight - doc.clientHeight;
    if (over > 0 && wrap.getBoundingClientRect().height >= max - 1) {
      max = Math.max(minPx, max - over);
      wrap.style.maxHeight = max + 'px';
    }
  }
  let fitQueued = false;
  window.addEventListener('resize', () => {
    if (fitQueued) return;
    fitQueued = true;
    const run = () => { fitQueued = false; fitWrap(); };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run); else setTimeout(run, 16);
  });

  // ── The table ───────────────────────────────────────────────────────
  // Widths in rem: the grid is wider than any screen and scrolls sideways
  // with the checkbox and Status columns pinned, the way the frozen columns
  // of the old sheet were.
  const COLS = [
    { key: 'sel', label: '', w: 2, edit: true, stick: true },
    // Status, with the Sub-Contractor Agreement as a tag under the pill
    // rather than a column of its own; each keeps its filter.
    { key: 'status', label: 'Status', w: 9.7, stick: true, sep: '·', parts: [
      { label: 'Status', filter: 'status' },
      { label: 'Sub Agmt', filter: 'sca_status', title: 'Sub-Contractor Agreement' },
    ] },
    // The job a row is on — only on a site's sheet (site: true).
    { key: 'job', label: 'Job', w: 9.5, filter: 'job', site: true },
    { key: 'po', label: 'PO #', w: 9, filter: 'po' },
    // Every column filters, as every column of the old sheet did — a blank
    // Date Needed is exactly the row the late flags can never catch, and
    // "(blank)" in its filter is how it is found.
    { key: 'date_needed', label: 'Date Needed', w: 7.7, filter: 'date_needed' },
    // Lead Time, Order By, Date Ordered and Date Delivered share one column,
    // two to a line — the plan (lead time → the day the order has to go in)
    // over what happened (ordered, delivered) — rather than four columns of
    // the sheet's width. Each keeps its own filter, in a header laid out the
    // same 2 × 2. (`parts` — see headerHtml.)
    { key: 'ordering', label: 'Lead Time · Order By · Ordered · Delivered', w: 14.6, grid: true, parts: [
      { label: 'Lead Time', filter: 'lead_time_days', title: 'Days the supplier needs from order to delivery' },
      { label: 'Order By', filter: 'order_by', title: 'Date Needed minus Lead Time' },
      { label: 'Ordered', filter: 'date_ordered', title: 'Date Ordered' },
      { label: 'Delivered', filter: 'date_delivered', title: 'Date Delivered' },
    ] },
    { key: 'quantity', label: 'Quantity', w: 7.4, num: true, filter: 'quantity' },
    { key: 'unit', label: 'Unit', w: 4.8, filter: 'unit' },
    // What is bought, in this job's words (stored as `description`), beside
    // the bid codes its cost books to. Quantity | Unit | Material | codes is
    // the order of the buy-out sheets it replaces.
    { key: 'description', label: 'Material', w: 18, filter: 'description',
      title: 'What is bought, named as this job\'s plans and suppliers name it. Blank shows the bid\'s Sub Code. The cost still books to the Cost Code / Sub Code beside it.' },
    // Cost Code and Sub Code in one column, "Stormwater / Geofabric" as the
    // purchase orders show them: the bid line the material books to.
    { key: 'codes', label: 'Cost Code / Sub Code', w: 14, sep: '/', parts: [
      { label: 'Cost Code', filter: 'cost_code' },
      { label: 'Sub Code', filter: 'sub_code', title: 'The bid line this material\'s cost books to' },
    ] },
    // Who it comes from: Vendor over its Quote #, and Contact over Email —
    // two to a column, each with its own filter.
    { key: 'supplier', label: 'Vendor / Quote #', w: 11, stack: true, parts: [
      { label: 'Vendor', filter: 'vendor' },
      { label: 'Quote #', filter: 'quote_number' },
    ] },
    { key: 'contact_email', label: 'Contact / Email', w: 12, stack: true, parts: [
      { label: 'Contact', filter: 'contact' },
      { label: 'Email', filter: 'email' },
    ] },
    { key: 'actions', label: '', w: 6.2, edit: true },
  ];
  const colsFor = edit => COLS.filter(c => (!c.edit || edit) && !colHidden(c.key) && (!c.site || siteMode()));
  // Whether the table is split into a band per job: a site's sheet grouped
  // by cost code (grouped by vendor, or not at all, the Job column says it).
  const jobBands = ctx => !!(ctx && ctx.site) && st.grouping === 'cost';

  function visibleRows(ctx) {
    const sorted = sortRows(st.rows, ctx);
    const shown = applyFilters(sorted, st, ctx);
    if (!st.forceShow.size) return shown;
    const ids = new Set(shown.map(r => r.id));
    return sorted.filter(r => ids.has(r.id) || st.forceShow.has(r.id));
  }

  function groupRows(rows, ctx) {
    if (st.grouping === 'none') return [{ key: '', label: '', rows }];
    const k = keyFn(ctx);
    const groups = [], byKey = new Map();
    const add = (key, make, row) => {
      let g = byKey.get(key);
      if (!g) { g = { key, rows: [], ...make() }; byKey.set(key, g); groups.push(g); }
      g.rows.push(row);
    };
    if (st.grouping === 'vendor') {
      rows.forEach(r => add('v:' + lc(r.vendor) + '|' + lc(r.quote_number),
        () => ({ vendor: r.vendor.trim(), quote: r.quote_number.trim() }), r));
      groups.sort((a, b) => {
        if (!a.vendor !== !b.vendor) return a.vendor ? -1 : 1;     // "No vendor yet" last
        return a.vendor.localeCompare(b.vendor) || a.quote.localeCompare(b.quote);
      });
      groups.forEach(g => {
        const one = f => {
          const vals = [...new Set(g.rows.map(r => r[f].trim()).filter(Boolean))];
          return vals.length === 1 ? vals[0] : vals.length > 1 ? `${vals.length} different` : '';
        };
        g.label = g.vendor || 'No vendor yet';
        g.meta = [g.quote ? `Quote # <b>${esc(g.quote)}</b>` : '', one('contact') ? esc(one('contact')) : '', one('email') ? esc(one('email')) : '']
          .filter(Boolean).join(' · ');
      });
      return groups;
    }
    // On a site's sheet a section is one job's cost code (pid): the rows come
    // sorted job by job, so each job's sections come together, under its band.
    rows.forEach(r => {
      const code = liveCodes(r, ctx).cost_code;
      const pid = ctx.site ? String(r.project_id || '') : null;
      add('c:' + (pid != null ? pid + '|' : '') + ck(k, code),
        () => ({ label: code.trim() || 'No cost code', meta: '', code: code.trim(), pid }), r);
    });
    return groups;
  }

  function headerHtml(cols) {
    let left = 0;
    return '<tr>' + cols.map(c => {
      const stick = c.stick ? ` stk${c.key === 'status' ? ' stk-edge' : ''}" style="left:${left}rem` : '';
      if (c.stick) left += c.w;
      if (c.key === 'sel') return `<th class="c-sel${stick}"><input type="checkbox" id="fctproc-selall" title="Select every row shown" aria-label="Select every row shown"></th>`;
      const fb = (filter, label) => (filter ? ` <button type="button" class="cfb fctproc-fb${st.filters[filter] ? ' active' : ''}" data-pff="${filter}" title="Filter ${esc(label)}">&#9660;</button>` : '');
      // A column of several fields (Cost Code / Sub Code, the ordering
      // dates): each field named, with its own filter, laid out the way its
      // cells are — side by side with a separator, or 2 × 2.
      if (c.parts) {
        const part = p => `<span class="fctproc-hp"${p.title ? ` title="${esc(p.title)}"` : ''}>${esc(p.label)}${fb(p.filter, p.label)}</span>`;
        const inner = c.grid || c.stack ? c.parts.map(part).join('')
          : c.parts.map(part).join(`<span class="fctproc-sep" aria-hidden="true">${esc(c.sep || '')}</span>`);
        return `<th class="c-${c.key}${stick}" data-label="${esc(c.label)}"><div class="${c.grid ? 'fctproc-grid2' : c.stack ? 'fctproc-stack' : 'fctproc-inl'}">${inner}</div></th>`;
      }
      return `<th class="${c.num ? 'num' : ''}${stick}" data-label="${esc(c.label)}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}${fb(c.filter, c.label)}</th>`;
    }).join('') + '</tr>';
  }

  function renderTable() {
    const wrap = st.mountEl && st.mountEl.querySelector('#fctproc-wrap');
    if (!wrap) return;
    redrawDeferred = false;
    const ctx = makeCtx();
    const edit = canEdit();
    const cols = colsFor(edit);
    const rows = visibleRows(ctx);
    const groups = groupRows(rows, ctx);
    const width = cols.reduce((s, c) => s + c.w, 0);
    const drawn = new Map();
    let body = '';
    if (!st.rows.length) {
      const hasBid = (ctx.bidLines || []).length > 0;
      body = `<tr class="fctproc-nomatch"><td colspan="${cols.length}">No procurement rows for ${ctx.site ? 'these jobs' : 'this job'} yet.${!edit ? ''
        : hasBid ? ' Use <b>Add to Procurement</b> to bring in the bid lines, or <b>+ Add Row</b> for a material by hand.'
        : ' This job has no bid lines yet — add them on the bid page (or import a Procore estimate) to send them here, or use <b>+ Add Row</b> for a material by hand.'}</td></tr>`;
    } else if (!rows.length) {
      body = `<tr class="fctproc-nomatch"><td colspan="${cols.length}">No rows match the filters.
        <button type="button" class="fctproc-link" data-act="clear">Clear filters</button></td></tr>`;
    } else {
      const section = g => {
        const head = st.grouping === 'none' ? '' : groupHeaderHtml(g, cols.length, ctx);
        const open = st.grouping === 'none' || !st.collapsed.has(g.key);
        return head + (open ? g.rows.map(r => { const h = rowHtml(r, ctx, edit, cols); drawn.set(r.id, h); return h; }).join('') : '');
      };
      if (jobBands(ctx)) {
        // A band per job, its sections under it. A job with nothing on the
        // sheet yet still gets its band — the band's buttons are how its bid
        // is brought in — but one whose rows the filters hide all of does not.
        body = openIds().map(pid => {
          const mine = groups.filter(g => g.pid === pid);
          const shown = [].concat(...mine.map(g => g.rows));
          if (!shown.length && st.rows.some(r => r.project_id === pid)) return '';
          return jobBandHtml(pid, shown, cols.length, ctx) + (st.collapsed.has(JOB + pid) ? '' : mine.map(section).join(''));
        }).join('');
      } else {
        body = groups.map(section).join('');
      }
    }

    // Rebuilding the table replaces the box being typed in; put focus, caret
    // and scroll position back on whatever took its place.
    const focus = captureFocus(wrap);
    const top = wrap.scrollTop, leftScroll = wrap.scrollLeft;
    wrap.innerHTML = `<table class="fctproc-table" style="width:${width}rem;min-width:${width}rem">
      <colgroup>${cols.map(c => `<col style="width:${c.w}rem">`).join('')}</colgroup>
      <thead>${headerHtml(cols)}</thead><tbody>${body}</tbody></table>`;
    wrap.querySelectorAll('tr.fctproc-row').forEach(tr => { const h = drawn.get(tr.dataset.row); if (h) drawnHtml.set(tr, h); });
    drawnLayout = layoutOf(rows, ctx, groups);
    wrap.scrollTop = top;
    wrap.scrollLeft = leftScroll;
    restoreFocus(wrap, focus);
    syncSelectAll(rows, groups);
    fitWrap();
    const shown = st.mountEl.querySelector('#fctproc-shown');
    if (shown) shown.textContent = rows.length === st.rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : `${rows.length} of ${st.rows.length} rows`;
  }

  function groupCountsHtml(rows, ctx) {
    const notOrdered = rows.filter(r => statusOf(r, ctx) === 'Not Ordered').length;
    const late = rows.filter(r => flagsOf(r, ctx).some(f => f.level === 'red')).length;
    return `${rows.length} row${rows.length === 1 ? '' : 's'}`
      + (notOrdered ? ` · ${notOrdered} not ordered` : '')
      + (late ? ` · <span style="color:#f87171">${late} late</span>` : '');
  }

  /**
   * A job's band on a site's sheet: its name and number, a box that ticks
   * every row of the job, its own "Add to Procurement" (that job's bid) and
   * "+ Add Row", and its counts. Folding it folds the job.
   */
  function jobBandHtml(pid, rows, span, ctx) {
    const key = JOB + pid;
    const p = project(pid) || {};
    const name = projLabel(p) || jobName(pid);
    const open = !st.collapsed.has(key);
    const edit = canEdit();
    const n = rows.filter(r => st.selected.has(r.id)).length;
    const box = edit && rows.length
      ? `<input type="checkbox" class="fctproc-grpsel" data-grpsel="${esc(key)}"${n && n === rows.length ? ' checked' : ''}
          title="Select every row on this job" aria-label="Select every row on ${esc(name)}">` : '';
    const btns = edit
      ? `<button type="button" class="fctproc-grpadd" data-grpsend="${esc(pid)}" title="${esc(`Pick bid lines of ${name} to add as rows`)}"
          aria-label="${esc(`Add ${name}'s bid lines to Procurement`)}">&#10148; Add to Procurement</button>
         <button type="button" class="fctproc-grpadd" data-grpadd="${esc(key)}" title="${esc(`Add a row to ${name}`)}"
          aria-label="${esc(`Add a row to ${name}`)}">+ Add Row</button>` : '';
    return `<tr class="fctproc-grp fctproc-jobband" data-grp="${esc(key)}" data-jobband="${esc(pid)}" title="${open ? 'Fold' : 'Unfold'} this job"><td colspan="${span}">
      <span class="gl">${box}<span class="tw">${open ? '&#9660;' : '&#9654;'}</span><span class="jn">${esc(name)}</span>${p['job-number'] ? `<span class="gm">Job #${esc(p['job-number'])}</span>` : ''}${btns}
      <span class="gm gc">${jobCountsHtml(rows, ctx)}</span></span></td></tr>`;
  }
  const jobCountsHtml = (rows, ctx) => (rows.length ? groupCountsHtml(rows, ctx) : 'No rows yet');

  function groupHeaderHtml(g, span, ctx) {
    const open = !st.collapsed.has(g.key);
    // An editor's box ticks every row in the section (folded ones too), for
    // Delete selected or a bulk edit; synced with the rows by syncSelectAll.
    const n = g.rows.filter(r => st.selected.has(r.id)).length;
    const box = canEdit() && g.rows.length
      ? `<input type="checkbox" class="fctproc-grpsel" data-grpsel="${esc(g.key)}"${n && n === g.rows.length ? ' checked' : ''}
          title="Select every row in this section" aria-label="Select every row in ${esc(g.label)}">` : '';
    // …and a button that adds a row in the section (sectionSeed), not under
    // "No cost code" as the toolbar's + Add Row does. Beside the name, ahead
    // of the quote / contact / counts: after a long vendor header it sat past
    // the sheet's right edge on a narrow screen, where the sticky label never
    // scrolls it into view.
    const into = (st.grouping === 'vendor'
      ? (g.vendor ? `for ${g.vendor}${g.quote ? `, quote # ${g.quote}` : ''}` : 'with no vendor yet')
      : (g.code ? `under ${g.code}` : 'with no cost code')) + (g.pid ? ` on ${jobName(g.pid)}` : '');
    const addBtn = canEdit()
      ? `<button type="button" class="fctproc-grpadd" data-grpadd="${esc(g.key)}" title="${esc(`Add a row ${into}`)}"
          aria-label="${esc(`Add a row ${into}`)}">+ Add Row</button>` : '';
    return `<tr class="fctproc-grp" data-grp="${esc(g.key)}" title="${open ? 'Fold' : 'Unfold'} this group"><td colspan="${span}">
      <span class="gl">${box}<span class="tw">${open ? '&#9660;' : '&#9654;'}</span><span>${esc(g.label)}</span>${grpDocsHtml(g, ctx)}${addBtn}
      ${g.meta ? `<span class="gm">${g.meta}</span>` : ''}<span class="gm gc">${groupCountsHtml(g.rows, ctx)}</span></span></td></tr>`;
  }

  /**
   * The folder chip on a cost-code section: every document attached to a
   * line in the section is filed in that cost code's folder as well, so the
   * folder is the section's paperwork in one place, and this opens it. The
   * same chip the bid page's green cost-code bars carry.
   *
   * Only on a cost-code section that has a code. "No cost code" has no
   * folder (nothing makes one for a blank code), and a vendor section mixes
   * cost codes. The count shows only once there is something in it — an
   * empty folder is the state most sections are in, and a 0 on each would be
   * noise.
   */
  function grpDocsHtml(g, ctx) {
    if (st.grouping !== 'cost' || !g.code || typeof cfg.openCostCodeFolder !== 'function') return '';
    // A site's section is one job's cost code, and its folder that job's.
    const pid = g.pid || ctx.projectId;
    const n = costCodeDocCount(pid, g.code);
    const tip = grpDocsTip(g.code, n);
    return `<button type="button" class="fctproc-grpdocs${n ? ' has' : ''}" data-grpdocs="${esc(g.code)}"${g.pid ? ` data-pid="${esc(g.pid)}"` : ''} data-n="${n}"
      title="${esc(tip)}" aria-label="${esc(tip)}">&#128193;${n || ''}</button>`;
  }
  const grpDocsTip = (code, n) => (n
    ? `${n} document${n === 1 ? '' : 's'} filed under cost code ${code} — open the folder`
    : `Open the document folder for cost code ${code}`);

  /**
   * The folder chips' counts, put right in place. An upload changes no row,
   * so nothing else would redraw the header; and the chip is changed rather
   * than replaced, so a chip with keyboard focus keeps it.
   */
  function updateGroupDocs(ctx) {
    const wrap = st.mountEl && st.mountEl.querySelector('#fctproc-wrap');
    if (!wrap) return;
    const open = ctx ? ctx.projectId : st.projectId;
    wrap.querySelectorAll('tr.fctproc-grp [data-grpdocs]').forEach(b => {
      const code = b.dataset.grpdocs;
      const n = costCodeDocCount(b.dataset.pid || open, code);
      if (b.dataset.n === String(n)) return;
      b.dataset.n = String(n);
      b.classList.toggle('has', n > 0);
      b.textContent = '\u{1F4C1}' + (n || '');
      const tip = grpDocsTip(code, n);
      b.title = tip;
      b.setAttribute('aria-label', tip);
    });
  }

  /**
   * The group headers' "N rows · N not ordered · N late", worked out again
   * for the rows under each, in place. An edit redraws only its own row (the
   * table is not rebuilt under someone typing), so without this a header
   * would go on saying what was true before the edit.
   */
  function updateGroupCounts(ctx) {
    const wrap = st.mountEl && st.mountEl.querySelector('#fctproc-wrap');
    if (!wrap || st.grouping === 'none') return;
    const heads = [...wrap.querySelectorAll('tr.fctproc-grp')];
    if (!heads.length) return;
    // A folded group has no rows on screen to count; its rows are the ones
    // the grouping gives it.
    const folded = heads.some(tr => st.collapsed.has(tr.dataset.grp))
      ? new Map(groupRows(visibleRows(ctx), ctx).map(g => [g.key, g.rows])) : new Map();
    let vis = null;
    heads.forEach(tr => {
      const span = tr.querySelector('.gc');
      if (!span) return;
      // A job band counts every row of its job shown, in all its sections.
      if (tr.dataset.jobband != null) {
        if (!vis) vis = visibleRows(ctx);
        const html = jobCountsHtml(vis.filter(r => r.project_id === tr.dataset.jobband), ctx);
        if (span.innerHTML !== html) span.innerHTML = html;
        return;
      }
      let rows = [];
      if (st.collapsed.has(tr.dataset.grp)) rows = folded.get(tr.dataset.grp) || [];
      else {
        for (let n = tr.nextElementSibling; n && !n.classList.contains('fctproc-grp'); n = n.nextElementSibling) {
          const r = n.dataset && n.dataset.row ? rowById(n.dataset.row) : null;
          if (r) rows.push(r);
        }
      }
      const html = groupCountsHtml(rows, ctx);
      if (span.innerHTML !== html) span.innerHTML = html;
    });
  }

  function captureFocus(scope) {
    const a = document.activeElement;
    if (!a || !scope.contains(a) || !a.dataset) return null;
    const f = { pr: a.dataset.pr || null, pf: a.dataset.pf || null, id: a.id || null, start: null, end: null,
      act: a.tagName === 'BUTTON' && a.dataset.act && a.dataset.row ? [a.dataset.act, a.dataset.row] : null,
      // A section's folder chip, reached with Tab: the redraw after its
      // folder changed (a file attached from it) puts the focus back on it.
      grpdocs: a.tagName === 'BUTTON' && a.dataset.grpdocs != null ? [a.dataset.grpdocs, a.dataset.pid || ''] : null };
    try { f.start = a.selectionStart; f.end = a.selectionEnd; } catch { /* not a text box */ }
    return f;
  }
  function restoreFocus(scope, f) {
    if (!f) return;
    let el = null;
    if (f.pr && f.pf) el = scope.querySelector(`[data-pr="${cssEsc(f.pr)}"][data-pf="${cssEsc(f.pf)}"]`);
    else if (f.act) el = scope.querySelector(`button[data-act="${cssEsc(f.act[0])}"][data-row="${cssEsc(f.act[1])}"]`);
    else if (f.grpdocs != null) el = scope.querySelector(`button[data-grpdocs="${cssEsc(f.grpdocs[0])}"]${f.grpdocs[1] ? `[data-pid="${cssEsc(f.grpdocs[1])}"]` : ''}`);
    else if (f.id) el = scope.querySelector('#' + cssEsc(f.id));
    // Focusing a combobox opens its menu and selects its text — not what a
    // background redraw should do to someone. Those are left unfocused.
    if (!el || el.classList.contains('cb-input')) return;
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    if (f.start != null) { try { el.setSelectionRange(f.start, f.end); } catch { /* dates, numbers */ } }
  }
  const cssEsc = s => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));

  function syncSelectAll(rows, groups) {
    const box = st.mountEl && st.mountEl.querySelector('#fctproc-selall');
    if (!box) return;
    const ctx = rows && groups ? null : makeCtx();
    const vis = rows || visibleRows(ctx);
    const n = vis.filter(r => st.selected.has(r.id)).length;
    box.checked = !!vis.length && n === vis.length;
    box.indeterminate = n > 0 && n < vis.length;
    // Each section's box: ticked when all its rows are, half when some are.
    const boxes = st.mountEl.querySelectorAll('[data-grpsel]');
    if (!boxes.length) return;
    const byKey = new Map((groups || groupRows(vis, ctx || makeCtx())).map(g => [g.key, g.rows]));
    // …and each job band's, ticked when every row of the job shown is.
    if (siteMode()) openIds().forEach(pid => byKey.set(JOB + pid, vis.filter(r => r.project_id === pid)));
    boxes.forEach(b => {
      const in_ = byKey.get(b.dataset.grpsel) || [];
      const k = in_.filter(r => st.selected.has(r.id)).length;
      b.checked = !!in_.length && k === in_.length;
      b.indeterminate = k > 0 && k < in_.length;
    });
  }
  // The row boxes on screen, after the selection changed in bulk.
  function paintSelection() {
    st.mountEl.querySelectorAll('[data-sel]').forEach(b => {
      b.checked = st.selected.has(b.dataset.sel);
      const tr = b.closest('tr'); if (tr) tr.classList.toggle('sel', b.checked);
    });
  }

  // One row's cells. Everything a cell shows is worked out here from the row
  // and ctx, so a single row can be redrawn on its own (refreshRow).
  function rowHtml(r, ctx, edit, cols) {
    const id = esc(r.id);
    const at = f => `data-pr="${id}" data-pf="${f}"`;
    const codes = liveCodes(r, ctx);
    const ep = effectivePO(r, ctx);
    const status = statusOf(r, ctx);
    const flags = flagsOf(r, ctx);
    const red = flags.some(f => f.level === 'red'), amber = !red && flags.some(f => f.level === 'amber');
    const txt = (v, cls) => `<span class="fctproc-txt${cls ? ' ' + cls : ''}" title="${esc(v)}">${esc(v)}</span>`;
    const dateIn = (f, v, extra = '') => `<input type="date" class="fctproc-in${ymdOf(v) ? '' : ' empty'}" ${at(f)} value="${esc(ymdOf(v))}" min="${DATE_MIN}" max="${DATE_MAX}"${extra}>`;
    const textIn = (f, ph, extra = '') => `<input type="text" class="fctproc-in" ${at(f)} value="${esc(r[f])}" maxlength="${MAX_LEN[f] || 200}"
      placeholder="${esc(ph || '')}" title="${esc(r[f])}" autocomplete="off" spellcheck="false"${extra}>`;
    // One field of a cell that holds several (class c-<field>): refreshRow
    // redraws the parts around the one being typed in.
    // A cell (or part) someone else changed lately is marked, its tooltip
    // saying who and when (recentTip).
    const part = (f, inner, cls = '') => {
      const ch = recentTip(r.id, [f]);
      return `<div class="fctproc-part c-${f}${cls}${ch ? ' fctproc-chg' : ''}"${ch ? ` title="${esc(ch)}"` : ''}>${inner}</div>`;
    };
    let left = 0;
    const cells = cols.map(c => {
      const stick = c.stick ? ` stk${c.key === 'status' ? ' stk-edge' : ''}" style="left:${left}rem` : '';
      if (c.stick) left += c.w;
      const ch = COL_FIELDS[c.key] ? recentTip(r.id, COL_FIELDS[c.key]) : '';
      const td = (cls, inner) => `<td class="c-${c.key}${cls ? ' ' + cls : ''}${ch ? ' fctproc-chg' : ''}${stick}"${ch ? ` title="${esc(ch)}"` : ''}>${inner}</td>`;
      switch (c.key) {
        case 'sel':
          return td('', `<input type="checkbox" data-sel="${id}" ${st.selected.has(r.id) ? 'checked' : ''} aria-label="Select row">`);
        case 'status': {
          const cls = status === 'Delivered' ? 'st-del' : status === 'Ordered' ? 'st-ord' : status === UNKNOWN ? 'st-unk' : 'st-not';
          const tip = status === UNKNOWN ? ' title="Waiting for the purchase orders to load"' : '';
          // The line's paperclip rides in its Status cell rather than a column
          // of its own: Status is pinned to the left, so the paperclip is in
          // reach however far the sheet is scrolled, and the sheet is no wider.
          // Under the pill: the Sub-Contractor Agreement — a tag that is its
          // own picker — then the flags. "Sub agmt open" is not repeated
          // there: the tag reads "Agmt needed", in amber, itself.
          const shown = flags.filter(f => f.key !== 'sca_open');
          const scaCls = `sca-${esc(r.sca_status.replace(/\s+/g, '-'))}`;
          const scaTip = `Sub-Contractor Agreement: ${r.sca_status}`;
          // An editor's tag is a picker: the select lies over it, unseen, so
          // the tag is only as wide as what it says (a select is as wide as
          // its longest option, which pushed the flags to a third line).
          const tag = `<span class="fctproc-scatag ${scaCls}"${edit ? ' aria-hidden="true"' : ` title="${esc(scaTip)}"`}>${esc(SCA_SHORT[r.sca_status] || r.sca_status)}</span>`;
          const sca = edit
            ? `<span class="fctproc-scawrap" title="${esc(scaTip)}">${tag}<select class="fctproc-in fctproc-scasel ${scaCls}" ${at('sca_status')} aria-label="Sub-Contractor Agreement">${SCA_VALUES.map(v =>
                `<option value="${esc(v)}"${v === r.sca_status ? ' selected' : ''}>${esc(SCA_OPTION[v])}</option>`).join('')}</select></span>`
            : tag;
          return td(red ? 'flag-red' : amber ? 'flag-amber' : '', `<div class="fctproc-statusbox">`
            + part('pill', `<span class="fctproc-pill ${cls}"${tip}>${esc(status)}</span>${clipHtml(r, ctx, edit)}`)
            + part('sca_status', sca)
            + part('flags', shown.length ? `<span class="fctproc-flags">${shown.map(f =>
              `<span class="fctproc-flag ${f.level}" title="${esc(f.title)}">${esc(f.short || f.label)}</span>`).join('')}</span>` : '')
            + '</div>');
        }
        case 'job': {
          const p = project(r.project_id) || {};
          const name = fieldValue(r, 'job', ctx);
          return td('', `<span class="fctproc-txt wrap2" title="${esc(name + (p['job-number'] ? ` — Job #${p['job-number']}` : ''))}">${esc(name)}</span>`);
        }
        case 'po': return poCellHtml(r, ep, edit, td);
        case 'date_needed':
          return td('', edit ? dateIn(c.key, r[c.key]) : txt(fmtDate(r[c.key])));
        case 'ordering': {
          // Four fields, 2 × 2, each in a part of its own (class c-<field>):
          // refreshRow redraws the parts around the one being typed in, so
          // Order By follows Lead Time key by key. Each box says what it is,
          // since the cell has no room for labels. A part someone else changed
          // is marked on its own (part()).
          const lead = edit
            ? `<input type="number" class="fctproc-in" ${at('lead_time_days')} min="0" max="3650" step="1" value="${r.lead_time_days == null ? '' : r.lead_time_days}" title="Lead Time (days): what the supplier needs from order to delivery" aria-label="Lead Time (days)" placeholder="—">`
            : txt(r.lead_time_days == null ? '' : String(r.lead_time_days), 'num');
          const ob = orderBy(r);
          const obHtml = ob ? `<span class="fctproc-txt fctproc-calc" title="Order By: Date Needed minus ${r.lead_time_days} day${r.lead_time_days === 1 ? '' : 's'} lead time">${fmtDate(ob)}</span>`
            : `<span class="fctproc-txt fctproc-dim" title="Order By: fill in Date Needed and Lead Time">—</span>`;
          const own = ymdOf(r.date_ordered);
          const eff = effectiveDateOrdered(r, ctx);
          const derived = !own && eff;
          const why = derived ? `Date Ordered: the date ${str(ep.po && ep.po.po_number) || 'its PO'} was raised${edit ? ' — pick a date to set your own' : ''}` : 'Date Ordered';
          const ordered = edit
            ? dateIn('date_ordered', own || eff, ` title="${esc(why)}" aria-label="Date Ordered"${derived ? ' data-derived="1"' : ''}`).replace('class="fctproc-in', `class="fctproc-in${derived ? ' derived' : ''}`)
            : derived ? `<span class="fctproc-txt fctproc-calc" title="${esc(why)}">${fmtDate(eff)}</span>` : `<span class="fctproc-txt" title="Date Ordered">${esc(fmtDate(own))}</span>`;
          const delivered = edit ? dateIn('date_delivered', r.date_delivered, ' title="Date Delivered" aria-label="Date Delivered"')
            : `<span class="fctproc-txt" title="Date Delivered">${esc(fmtDate(r.date_delivered))}</span>`;
          // "d" for days beside a lead time — and beside the box to type one
          // in — but not beside nothing on a view-only sheet.
          const days = edit || r.lead_time_days != null ? '<span class="fctproc-u" aria-hidden="true">d</span>' : '';
          return td('', `<div class="fctproc-grid2">${part('lead_time_days', lead + days)}${part('order_by', obHtml)}`
            + `${part('date_ordered', ordered)}${part('date_delivered', delivered)}</div>`);
        }
        case 'quantity': {
          const bc = bidChange(r, ctx);
          const badge = bc ? `<div class="fctproc-bidchg"><span title="The bid line changed since this row was sent">${esc(bc.label)}</span>${edit
            ? `<span class="acts"><button type="button" class="fctproc-mini" data-act="use-bid" data-row="${id}" title="Set Quantity and Unit to the bid's">Use bid qty</button>`
              + `<button type="button" class="fctproc-mini ghost" data-act="dismiss-bid" data-row="${id}" title="Keep this row's quantity and stop flagging the change">Dismiss</button></span>` : ''}</div>` : '';
          const field = edit
            ? `<input type="number" class="fctproc-in" ${at('quantity')} step="any" value="${r.quantity == null ? '' : r.quantity}">`
            : txt(fmtQty(r.quantity), 'num');
          return td('', badge ? `<div class="fctproc-qty">${field}${badge}</div>` : field);
        }
        case 'unit':
          return td('', edit ? cbCell('proc_units', r.unit, '', `${at('unit')} maxlength="${MAX_LEN.unit}"`) : txt(r.unit));
        case 'codes': {
          // "Stormwater / Geofabric", as the purchase orders show a code: the
          // cost code muted, the sub code (the bid line) plain. A hand-added
          // row picks its line in the sub code's place.
          const badge = codes.notOnBid ? '<span class="fctproc-tag amber" title="The bid line this row was tied to is no longer on the bid">not on bid</span>'
            : codes.costGone ? '<span class="fctproc-tag amber" title="No line on the bid has this cost code any more (renamed or removed on the bid). Pick the row\'s Sub Code from the bid to put it under a current code.">not on bid</span>' : '';
          const cc = codes.cost_code.trim(), sc = codes.sub_code.trim();
          const both = [cc, sc].filter(Boolean).join(' / ');
          const ccHtml = cc ? `<span class="fctproc-cc c-cost_code" title="${esc(`Cost Code: ${cc}`)}">${esc(cc)}</span>` : '';
          if (edit && r.source !== 'bid') {
            const pick = cbCell('proc_codes:' + (r.project_id || st.projectId), codes.sub_code, 'Pick bid line…',
              `${at('codes')} data-cb-value="${esc(r.bid_item_id || '')}" title="${esc(both || 'Pick the bid line this material books to')}" aria-label="Sub Code"`);
            return td('', `<div class="fctproc-codes edit">${ccHtml}${cc ? '<span class="fctproc-sep" aria-hidden="true"> / </span>' : ''}<span class="fctproc-scpick c-sub_code">${pick}</span>${badge}</div>`);
          }
          // The sub code — the bid line — always shows (on two lines if it
          // must); a long cost code gives way to it, cut short with its tooltip.
          return td('', `<div class="fctproc-codes" title="${esc(both)}">${ccHtml}${cc && sc ? '<span class="fctproc-sep" aria-hidden="true"> / </span>' : ''}`
            + `${sc || !cc ? `<span class="fctproc-sc c-sub_code">${esc(sc)}</span>` : ''}${badge}</div>`);
        }
        case 'description': {
          // Blank reads as the bid's Sub Code (materialOf), shown greyed — a
          // placeholder while editing — so a bid row needs no typing unless
          // this job names the material differently. The picker offers the
          // names used under the same sub code on earlier jobs.
          const own = str(r.description);
          const bid = codes.sub_code.trim();
          if (edit) {
            const tip = own.trim() ? (bid ? `${own.trim()} — books to ${[codes.cost_code.trim(), bid].filter(Boolean).join(' / ')}` : own.trim())
              : bid ? `Same as the bid's Sub Code (${bid}). Type or pick this job's name for it — the cost still books to ${bid}.` : 'What is being bought';
            return td('', cbCell('proc_materials:' + r.id, own, bid || 'What is it?',
              `${at('description')} maxlength="${MAX_LEN.description}" title="${esc(tip)}"`));
          }
          if (!own.trim() && bid) {
            return td('', `<span class="fctproc-txt wrap2 fctproc-frombid" title="${esc(`Same as the bid's Sub Code (${bid})`)}">${esc(bid)}</span>`);
          }
          return td('', txt(own, 'wrap2'));
        }
        case 'supplier': {
          // Vendor over its Quote #. A vendor typed but never picked or added
          // is allowed (the PM may not want it on the list yet), but marked,
          // since contacts typed on the row are not remembered under it until
          // it is on the list.
          const off = !!(r.vendor.trim() && ctx.supplierKeys && ctx.supplierKeys.size && !ctx.supplierKeys.has(lc(r.vendor)));
          const tip = off ? `"${r.vendor.trim()}" is not on the supplier list. Pick "+ Add" in the Vendor menu to add it — until then, contacts typed on this row are not remembered.` : '';
          const vendor = edit
            ? cbCell('proc_vendors', r.vendor, 'Vendor', `${at('vendor')} maxlength="${MAX_LEN.vendor}" aria-label="Vendor"${off ? ` title="${esc(tip)}"` : ''}`)
            : `<span class="fctproc-txt" title="${esc(tip || r.vendor)}">${esc(r.vendor)}</span>`;
          const quote = edit ? textIn('quote_number', 'Quote #', ' aria-label="Quote #"')
            : `<span class="fctproc-txt" title="${esc(r.quote_number ? `Quote # ${r.quote_number}` : '')}">${esc(r.quote_number)}</span>`;
          // data-cb-anchor: the Vendor (and, below, Contact) menu opens under
          // the whole cell, not over the box beneath it — a click meant for
          // Quote # or Email would otherwise pick an option (tracker.html
          // _cbPositionFixed).
          return td('', `<div class="fctproc-stack" data-cb-anchor>${part('vendor', vendor, off ? ' vendor-off' : '')}${part('quote_number', quote)}</div>`);
        }
        case 'contact_email': {
          // Contact over Email (a phone number is allowed there, as in the
          // sheets this replaces).
          const contact = edit
            ? cbCell('proc_contacts:' + r.id, r.contact, 'Contact', `${at('contact')} maxlength="${MAX_LEN.contact}" aria-label="Contact"`)
            : txt(r.contact);
          const email = edit ? textIn('email', 'Email', ' aria-label="Email"') : txt(r.email);
          return td('', `<div class="fctproc-stack" data-cb-anchor>${part('contact', contact)}${part('email', email)}</div>`);
        }
        case 'actions':
          if (st.confirmDel === r.id) {
            return td('', `<div class="fctproc-acts"><span style="color:#f87171;font-size:0.68rem">Delete?</span>
              <button type="button" class="fctproc-act danger" data-act="del-yes" data-row="${id}">Yes</button>
              <button type="button" class="fctproc-act" data-act="del-no" data-row="${id}">No</button></div>`);
          }
          {
            // A line bought as named materials on another job says so: its
            // "+ Material" offers that list to copy.
            const past = edit && hasPastList(r, ctx);
            const tip = past ? 'Add materials under this bid line — copy the list it was bought as on another job, or add a blank row'
              : `Add another material under this ${r.bid_item_id ? 'bid line' : 'row'}`;
            return td('', `<div class="fctproc-acts">
            <button type="button" class="fctproc-act add${past ? ' past' : ''}" data-act="material" data-row="${id}" title="${esc(tip)}">+ Material${past ? '<span class="fctproc-pastdot" aria-hidden="true"></span>' : ''}</button>
            <button type="button" class="fctproc-act del" data-act="del" data-row="${id}" title="Delete this row" aria-label="Delete row">&#10005;</button></div>`);
          }
        default: return td('', '');
      }
    }).join('');
    // A row someone else added lately is marked as a whole.
    const added = addedTip(r.id);
    return `<tr class="fctproc-row${st.selected.has(r.id) ? ' sel' : ''}${added ? ' fctproc-new' : ''}" data-row="${id}"${added ? ` title="${esc(added)}"` : ''}>${cells}</tr>`;
  }

  /**
   * The paperclip on a line, drawn in its Status cell beside the pill: how
   * many documents are attached to the line, and the button that lists them
   * (and, for someone who may, attaches another). A viewer gets it too — they
   * may open and download what is attached, as on the Documents tab. Drawn
   * from the page's count, so refreshRow redraws it like the rest of the row.
   * A page that cannot open attachments gets no button rather than one that
   * does nothing. Never in the exports or the print view: a count is not data.
   */
  function clipHtml(r, ctx, edit) {
    if (typeof cfg.openAttachments !== 'function') return '';
    const n = attachmentCount(r.project_id || ctx.projectId, r.id);
    const tip = n ? `${n} attached document${n === 1 ? '' : 's'}` : edit ? 'Attach a document' : 'No documents attached';
    // The badge stops at 99+ so the button never grows; the tooltip and the
    // label read out the real number.
    const badge = n ? `<span class="n">${n > 99 ? '99+' : n}</span>` : '';
    return `<button type="button" class="fctproc-clip${n ? ' has' : ''}" data-act="files" data-row="${esc(r.id)}"
      title="${esc(tip)}" aria-label="${esc(tip)}">&#128206;${badge}</button>`;
  }

  function poCellHtml(r, ep, edit, td) {
    const id = esc(r.id);
    const num = ep.po ? str(ep.po.po_number) || '(no number)' : '';
    const cls = ep.kind === 'multiple' ? 'po-multi' : (ep.kind === 'removed' || ep.kind === 'moved') ? 'po-removed' : ep.kind === 'nopo' ? 'po-nopo' : '';
    const autoTag = ep.kind === 'auto'
      ? '<span class="fctproc-tag" title="Matched automatically: the only PO on this job with this cost code, sub code and vendor">auto</span>' : '';
    const open = ep.po ? `<button type="button" class="fctproc-open" data-act="open-po" data-po="${esc(ep.po.id)}" title="Open ${esc(num)} on the Purchase Orders tab">&#8599;</button>` : '';
    let multiTitle = ep.kind === 'multiple' ? ep.candidates.map(p => str(p.po_number)).join(', ') : '';
    if (ep.kind === 'moved') {
      // Linked here, then re-pointed to another job on the Purchase Orders
      // tab: it is not this job's order any more, so the row is not ordered.
      const other = ep.po.project_id ? project(String(ep.po.project_id)) : null;
      multiTitle = `${num} now belongs to ${other ? projLabel(other) : ep.po.project_id ? 'another job' : 'no job'}, so it is not this job's order. Pick this job's PO, or "Auto".`;
    }
    if (!edit) {
      const text = ep.kind === 'multiple' ? `${ep.candidates.length} POs match` : poText(ep);
      return td(cls, `<div class="fctproc-po"><span class="fctproc-txt" title="${esc(multiTitle || text)}">${esc(text)}</span>${autoTag}${open}</div>`);
    }
    const value = ep.kind === 'linked' || ep.kind === 'auto' ? num : ep.kind === 'nopo' ? 'No PO' : '';
    const placeholder = ep.kind === 'multiple' ? `${ep.candidates.length} POs match — pick`
      : ep.kind === 'removed' ? 'PO removed' : ep.kind === 'moved' ? `${num} is on another job` : ep.kind === 'loading' ? '…' : '—';
    const cbv = r.po_id ? r.po_id : r.po_auto === false ? '__none__' : '__auto__';
    return td(cls, `<div class="fctproc-po">${cbCell('proc_pos:' + r.id, value, placeholder,
      `data-pr="${id}" data-pf="po" data-cb-value="${esc(cbv)}"${multiTitle ? ` title="${esc(multiTitle)}"` : ''}`)}${autoTag}${open}</div>`);
  }

  // Redraw one row in place. The cell being typed in — or a combobox that has
  // just lost focus and is about to commit (it commits 120 ms after blur, and
  // a replaced box would commit into nothing) — is left exactly as it is, and
  // so is `hold`, the box whose own change asked for the redraw.
  //
  // `onlyIfChanged` (a background refresh): a row drawn from the same HTML as
  // last time is left alone. Never for an edit's own redraw, which also puts
  // back a box whose typing was refused.
  const drawnHtml = new WeakMap();      // tr → the HTML it was drawn from
  // A box in use is not redrawn, but the cell or part around it takes the
  // fresh copy's class and tooltip.
  function marksFrom(el, fresh) {
    el.className = fresh.className;
    if (fresh.hasAttribute('title')) el.setAttribute('title', fresh.getAttribute('title'));
    else el.removeAttribute('title');
  }
  function refreshRow(rowId, hold, ctx0, onlyIfChanged) {
    const wrap = st.mountEl && st.mountEl.querySelector('#fctproc-wrap');
    if (!wrap) return;
    const tr = wrap.querySelector(`tr[data-row="${cssEsc(rowId)}"]`);
    if (!tr) return;
    const row = rowById(rowId);
    if (!row) { tr.remove(); return; }
    const ctx = ctx0 || makeCtx();
    const edit = canEdit();
    const html = rowHtml(row, ctx, edit, colsFor(edit));
    if (onlyIfChanged && drawnHtml.get(tr) === html) return;
    const tmp = document.createElement('tbody');
    tmp.innerHTML = html;
    const fresh = tmp.firstElementChild;
    if (!fresh) return;
    // Only a box being typed in holds its cell; a button that was just
    // clicked (the ✕ asking "Delete?", "Use bid qty") is redrawn like the rest.
    const active = document.activeElement;
    const typing = active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName) && active.type !== 'checkbox';
    // …but keyboard focus on one of the row's buttons ("+ Material", which
    // Tab out of Email lands on) stays on it when it is still there, or the
    // next Tab would start over from the top of the page.
    const btn = active && active.tagName === 'BUTTON' && tr.contains(active) && active.dataset.act ? active.dataset.act : null;
    const busy = td => (typing && td.contains(active)) || (hold && td.contains(hold)) || td.querySelector('[data-pcommit]');
    let host = fresh;
    if (![...tr.children].some(busy)) tr.replaceWith(fresh);
    else {
      host = tr;
      tr.className = fresh.className;
      const next = Array.from(fresh.children);
      Array.from(tr.children).forEach((td, i) => {
        if (!next[i]) return;
        if (!busy(td)) { td.replaceWith(next[i]); return; }
        // A cell of several fields (the ordering dates): the parts around
        // the one in use are redrawn — Order By follows Lead Time as it is
        // typed — and the one in use is left as it is, but for its marks.
        const mine = td.querySelectorAll('.fctproc-part'), theirs = next[i].querySelectorAll('.fctproc-part');
        if (mine.length && mine.length === theirs.length) {
          mine.forEach((p, j) => { if (!busy(p)) p.replaceWith(theirs[j]); else marksFrom(p, theirs[j]); });
        }
        // The cell's own marks follow too (Status's red / amber edge, as its
        // Sub-Contractor Agreement tag is being picked; "changed by someone
        // else", gone once the cell is changed here).
        marksFrom(td, next[i]);
      });
    }
    drawnHtml.set(host, html);
    if (btn && !host.contains(document.activeElement)) {
      const again = host.querySelector(`button[data-act="${cssEsc(btn)}"]`);
      if (again) { try { again.focus({ preventScroll: true }); } catch { again.focus(); } }
    }
  }

  // ── Bulk bar ────────────────────────────────────────────────────────
  const BULK_FIELDS = [
    ['vendor', 'Vendor'], ['quote_number', 'Quote #'], ['contact_email', 'Contact + Email'],
    ['sca_status', 'Sub-Contractor Agreement'], ['date_needed', 'Date Needed'], ['lead_time_days', 'Lead Time (days)'],
    ['date_ordered', 'Date Ordered'], ['date_delivered', 'Date Delivered'], ['po', 'PO link'],
  ];
  function bulkValueHtml() {
    switch (st.bulkField) {
      case 'vendor': return cbCell('proc_vendors', '', 'Vendor…', 'id="fctproc-bulk-vendor" aria-label="Vendor"');
      case 'contact_email': {
        // When the rows ticked share one vendor, its saved contacts are
        // offered (picking one fills Email too), as the row's own cell does.
        const rows = [...st.selected].map(rowById).filter(Boolean);
        const vendors = [...new Set(rows.map(r => lc(r.vendor)))];
        const offer = rows.length && vendors.length === 1 && vendors[0] && contacts.list(rows[0].vendor).length;
        const contact = offer
          ? cbCell('proc_contacts:' + rows[0].id, '', 'Contact…', `id="fctproc-bulk-contact" aria-label="Contact" maxlength="${MAX_LEN.contact}"`)
          : `<input type="text" id="fctproc-bulk-contact" placeholder="Contact" maxlength="${MAX_LEN.contact}">`;
        return `${contact}
        <input type="text" id="fctproc-bulk-email" placeholder="Email" maxlength="${MAX_LEN.email}">`;
      }
      case 'sca_status': return `<select id="fctproc-bulk-val">${SCA_VALUES.map(v => `<option>${esc(v)}</option>`).join('')}</select>`;
      case 'date_needed': case 'date_ordered': case 'date_delivered': return `<input type="date" id="fctproc-bulk-val" aria-label="Date" min="${DATE_MIN}" max="${DATE_MAX}">`;
      case 'lead_time_days': return '<input type="number" id="fctproc-bulk-val" min="0" max="3650" step="1" style="width:5rem" aria-label="Days">';
      case 'po': {
        // A PO is one job's. On a site's sheet the ticked rows' job's orders
        // are offered when they are all on one job; across jobs, only Auto
        // and No PO (Create PO from selected raises one per job).
        let forRow = null;
        if (siteMode()) {
          const jobs = [...new Set([...st.selected].map(rowById).filter(Boolean).map(r => r.project_id))];
          forRow = jobs.length === 1 ? { project_id: jobs[0] } : { project_id: '' };
        }
        return `<select id="fctproc-bulk-val">${poOptions(forRow).map(o =>
        `<option value="${esc(o.value)}">${esc(o.label)}${o.value.startsWith('__') ? '' : ' — ' + esc(o.meta)}</option>`).join('')}</select>`;
      }
      default: return `<input type="text" id="fctproc-bulk-val" maxlength="${MAX_LEN.quote_number}" placeholder="Quote #">`;
    }
  }
  function renderBulk() {
    const box = st.mountEl && st.mountEl.querySelector('#fctproc-bulk');
    if (!box) return;
    // A value typed or picked in the bar and not yet applied survives the
    // bar being drawn again (a row ticked, the order list refreshed): drawn
    // empty, Apply would offer to clear the field on every row selected.
    const keep = [];
    const vb0 = box.querySelector('#fctproc-bulk-valbox');
    if (vb0 && vb0.dataset.field === st.bulkField) {
      vb0.querySelectorAll('input[id], select[id]').forEach(el => keep.push([el.id, el.value, el.dataset.cbValue]));
    }
    st.selected.forEach(id => { if (!rowById(id)) st.selected.delete(id); });
    const n = st.selected.size;
    if (!canEdit() || !n) { box.innerHTML = ''; box.className = ''; st.bulkConfirmDel = false; fitWrap(); return; }
    box.className = 'fctproc-bulk';
    box.innerHTML = `
      <b>${n}</b> selected
      <span class="fctproc-lbl" style="margin-left:0.5rem">Set</span>
      <select id="fctproc-bulk-field" aria-label="Field to set">${BULK_FIELDS.map(([k, l]) =>
        `<option value="${k}"${k === st.bulkField ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <span style="color:var(--muted,#888)">to</span>
      <span id="fctproc-bulk-valbox" data-field="${esc(st.bulkField)}" style="display:inline-flex;gap:0.35rem;align-items:center">${bulkValueHtml()}</span>
      <button type="button" class="btn btn-green fctproc-b" data-act="bulk-apply">Apply to ${n}</button>
      <span class="fctproc-spacer"></span>
      <button type="button" class="btn btn-ghost fctproc-b" data-act="bulk-po" title="Raise a purchase order for these rows and link them to it"${creatingPO ? ' disabled' : ''}>${creatingPO ? 'Creating PO…' : 'Create PO from selected'}</button>
      ${st.bulkConfirmDel
        ? `<span style="color:#f87171">Delete ${n} row${n === 1 ? '' : 's'}?</span>
           <button type="button" class="btn btn-danger fctproc-b" data-act="bulk-del-yes">Yes, delete</button>
           <button type="button" class="btn btn-ghost fctproc-b" data-act="bulk-del-no">No</button>`
        : `<button type="button" class="btn btn-danger fctproc-b" data-act="bulk-del">Delete selected</button>`}
      <button type="button" class="btn btn-ghost fctproc-b" data-act="bulk-clear">Clear selection</button>`;
    keep.forEach(([id, value, cbValue]) => {
      const el = box.querySelector('#' + cssEsc(id));
      // A PO no longer on the list is not picked again.
      if (!el || (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === value))) return;
      el.value = value;
      if (cbValue) el.dataset.cbValue = cbValue; else delete el.dataset.cbValue;
    });
    fitWrap();
  }

  // ── Column filter dropdown (the PO tab's pattern) ───────────────────
  let ffField = null;
  function filterDd() {
    let dd = document.getElementById('fctproc-filter-dd');
    if (dd) return dd;
    dd = document.createElement('div');
    dd.id = 'fctproc-filter-dd';
    dd.style.cssText = `display:none;position:fixed;z-index:${Z - 10};background:var(--surface,#111118);border:1px solid var(--border,#2a2a3a);
      border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.5);min-width:200px;max-width:320px;max-height:320px;flex-direction:column;
      color:var(--text,#e0e0e0)`;
    dd.innerHTML = `
      <div style="padding:0.4rem 0.5rem;border-bottom:1px solid var(--border,#2a2a3a);display:flex;gap:0.4rem">
        <input id="fctproc-ff-search" type="text" placeholder="Search…" autocomplete="off"
               style="flex:1;background:var(--bg,#0a0a0f);border:1px solid var(--border,#2a2a3a);border-radius:3px;color:var(--text,#e0e0e0);font-size:0.75rem;padding:0.25rem 0.4rem;outline:none">
      </div>
      <div id="fctproc-ff-list" style="overflow-y:auto;flex:1;padding:0.3rem 0"></div>
      <div style="padding:0.4rem 0.5rem;border-top:1px solid var(--border,#2a2a3a);display:flex;gap:0.4rem;justify-content:flex-end">
        <button type="button" class="btn btn-ghost" style="font-size:0.7rem;padding:0.2rem 0.5rem" data-ff="clear">Clear</button>
        <button type="button" class="btn btn-green" style="font-size:0.7rem;padding:0.2rem 0.5rem" data-ff="apply">Apply</button>
      </div>`;
    document.body.appendChild(dd);
    const list = dd.querySelector('#fctproc-ff-list');
    dd.addEventListener('change', e => {
      if (e.target.id === 'fctproc-ff-all') list.querySelectorAll('.fctproc-ff-val').forEach(cb => { cb.checked = e.target.checked; });
      else if (e.target.classList.contains('fctproc-ff-val')) {
        const all = list.querySelector('#fctproc-ff-all');
        if (all) all.checked = [...list.querySelectorAll('.fctproc-ff-val')].every(c => c.checked);
      }
    });
    dd.querySelector('#fctproc-ff-search').addEventListener('input', e => {
      const needle = e.target.value.toLowerCase();
      list.querySelectorAll('.dff-item:not(.ff-all)').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(needle) ? '' : 'none';
      });
    });
    dd.addEventListener('click', e => {
      const b = e.target.closest('[data-ff]');
      if (!b) return;
      if (b.dataset.ff === 'clear') delete st.filters[ffField];
      else {
        const boxes = [...list.querySelectorAll('.fctproc-ff-val')];
        const ticked = boxes.filter(c => c.checked).map(c => c.value);
        if (ticked.length === boxes.length) delete st.filters[ffField];
        else st.filters[ffField] = new Set(ticked);
      }
      st.forceShow.clear();
      closeFilter();
      renderTable();
      updateCounts();
    });
    document.addEventListener('mousedown', e => {
      if (dd.style.display === 'none') return;
      if (!dd.contains(e.target) && !e.target.closest('.fctproc-fb')) closeFilter();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && dd.style.display !== 'none') closeFilter(); });
    return dd;
  }
  function closeFilter() {
    const dd = document.getElementById('fctproc-filter-dd');
    if (dd) dd.style.display = 'none';
    ffField = null;
  }
  /**
   * The order of a filter's values: dates by the day (the list shows
   * MM/DD/YYYY, which sorts January 2027 ahead of November 2026 as text),
   * numbers by size (the thousands comma would split 12,500 at the comma),
   * the rest as text.
   */
  const DATE_FILTERS = new Set(['date_needed', 'order_by', 'date_ordered', 'date_delivered']);
  const NUMBER_FILTERS = new Set(['quantity', 'lead_time_days']);
  function filterOrder(field, a, b) {
    if (DATE_FILTERS.has(field)) {
      const key = v => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v); return m ? m[3] + m[1].padStart(2, '0') + m[2].padStart(2, '0') : v; };
      const ka = key(a), kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }
    if (NUMBER_FILTERS.has(field)) {
      const na = Number(a.replace(/,/g, '')), nb = Number(b.replace(/,/g, ''));
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    }
    return a.localeCompare(b, undefined, { numeric: true });
  }
  function openFilter(field, btn) {
    const dd = filterDd();
    if (ffField === field && dd.style.display !== 'none') { closeFilter(); return; }
    ffField = field;
    const ctx = makeCtx();
    const values = [...new Set(st.rows.map(r => fieldValue(r, field, ctx)))]
      .sort((a, b) => (a === '') - (b === '') || filterOrder(field, a, b));
    const active = st.filters[field] || null;
    const list = dd.querySelector('#fctproc-ff-list');
    list.innerHTML = `<label class="dff-item ff-all"><input type="checkbox" id="fctproc-ff-all" ${active ? '' : 'checked'}> <span>(Select All)</span></label>`
      + values.map(v => `<label class="dff-item"><input type="checkbox" class="fctproc-ff-val" value="${esc(v)}" ${!active || active.has(v) ? 'checked' : ''}>
          <span>${v === '' ? '<em style="color:#888">(blank)</em>' : esc(v)}</span></label>`).join('');
    const search = dd.querySelector('#fctproc-ff-search');
    search.value = '';
    const rect = btn.getBoundingClientRect();
    dd.style.display = 'flex';
    dd.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 220)) + 'px';
    dd.style.top = (rect.bottom + 4) + 'px';
    try { search.focus({ preventScroll: true }); } catch { /* old browser */ }
  }

  // ── Events ──────────────────────────────────────────────────────────
  const wired = new WeakSet();
  function wire(el) {
    if (wired.has(el)) return;
    wired.add(el);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('click', onClick);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('keydown', onKeyDown);
    // What a combobox held, and whether anything was chosen in it (see
    // cbUntouched). On the way down, before the combobox's own handlers.
    el.addEventListener('focusin', onCbFocusIn, true);
    // What a cell showed when it took focus: what its save "saw" (expect).
    el.addEventListener('focusin', onSeenFocusIn, true);
    el.addEventListener('focusout', onSeenFocusOut, true);
    el.addEventListener('input', onCbInputCapture, true);
    el.addEventListener('keydown', onCbKeyCapture, true);
    el.addEventListener('mousedown', onCbMouseDownCapture, true);
    el.addEventListener('mousedown', onSheetMouseDown, true);
  }

  function readNumberInput(el, field) {
    // A number box reads '' while it holds something unparseable ("-", "1e")
    // — badInput tells that apart from a box the user really emptied.
    if (el.validity && el.validity.badInput) return undefined;
    const raw = el.value;
    if (raw === '' || raw == null) return null;
    const n = numOrNull(raw);
    if (n == null) return undefined;               // half-typed: leave the saved value alone
    if (field === 'lead_time_days') return Math.max(0, Math.min(3650, Math.round(n)));
    return n;
  }

  const SEARCH_LIVE_ROWS = 120, SEARCH_DELAY = 220;
  let searchTimer = null;
  function onInput(e) {
    const el = e.target;
    if (el.id === 'fctproc-search') {
      st.search = el.value;
      st.forceShow.clear();
      // Every key rebuilds the table, which on a big job (hundreds of rows,
      // thousands of boxes) takes longer than the next key takes to come:
      // there it waits for a pause in the typing. A small job keeps up.
      clearTimeout(searchTimer);
      if (st.rows.length > SEARCH_LIVE_ROWS) searchTimer = setTimeout(() => { renderTable(); updateCounts(); }, SEARCH_DELAY);
      else { renderTable(); updateCounts(); }
      return;
    }
    // Comboboxes are acted on at commit ('change'); their 'input' is the
    // synthetic half of that pair, or partial typing.
    if (el.classList.contains('cb-input')) return;
    const rowId = el.dataset.pr, field = el.dataset.pf;
    if (!rowId || !field) return;
    if (el.type === 'number') {
      const v = readNumberInput(el, field);
      if (v === undefined) return;
      setField(rowId, field, v);
      if (field === 'lead_time_days') refreshRow(rowId);
    } else if (el.type === 'text') {
      setField(rowId, field, el.value);
    }
  }

  function onChange(e) {
    const el = e.target;
    if (el.id === 'fctproc-proj') { if (!cbUntouched(el)) pickProject(el); return; }
    if (el.id === 'fctproc-bulk-vendor') { cbUntouched(el); return; }
    if (el.id === 'fctproc-bulk-contact' && isCb(el)) { if (!cbUntouched(el)) pickBulkContact(el); return; }
    if (el.id === 'fctproc-showall') {
      st.showAll = el.checked;
      storeSet('showall', el.checked ? '1' : '');
      // A site's sheet takes in (or lets go of) its jobs that are not live.
      if (siteMode() && st.loadedFor && st.loadedFor !== viewSig()) reloadSite();
      return;
    }
    if (el.id === 'fctproc-bulk-field') { st.bulkField = el.value; const vb = st.mountEl.querySelector('#fctproc-bulk-valbox'); if (vb) { vb.innerHTML = bulkValueHtml(); vb.dataset.field = st.bulkField; } return; }
    if (el.id === 'fctproc-selall') {
      const vis = visibleRows(makeCtx());
      vis.forEach(r => { if (el.checked) st.selected.add(r.id); else st.selected.delete(r.id); });
      paintSelection();
      syncSelectAll(vis);
      renderBulk();
      return;
    }
    if (el.dataset.grpsel != null) {
      // A section's rows as shown: the filters and search apply, a fold does not.
      sectionRows(el.dataset.grpsel, makeCtx()).forEach(r => { if (el.checked) st.selected.add(r.id); else st.selected.delete(r.id); });
      paintSelection();
      syncSelectAll();
      renderBulk();
      return;
    }
    if (el.dataset.sel) {
      if (el.checked) st.selected.add(el.dataset.sel); else st.selected.delete(el.dataset.sel);
      const tr = el.closest('tr'); if (tr) tr.classList.toggle('sel', el.checked);
      syncSelectAll();
      renderBulk();
      return;
    }
    const rowId = el.dataset.pr, field = el.dataset.pf;
    if (!rowId || !field || !rowById(rowId)) return;
    if (el.classList.contains('cb-input')) {
      delete el.dataset.pcommit;
      commitCombo(rowId, field, el);
      setTimeout(() => refreshRow(rowId), 0);
      return;
    }
    if (el.type === 'date') {
      // Chrome fires change on every keystroke once the box holds a whole
      // date, so typing 12/01/2026 passes through 0002-, 0020- and 0202-12-01
      // on the way. A date out of range is only marked here, and the saved
      // value left alone; it is refused (and the cell put back) when the box
      // is left still holding it — see refuseDate.
      const bad = dateProblem(el);
      el.classList.toggle('bad', !!bad);
      if (bad) { el.dataset.badDate = bad; el.title = `Not saved: ${bad}`; return; }
      delete el.dataset.badDate;
      el.classList.toggle('empty', !el.value);
      setField(rowId, field, ymdOf(el.value) || null);
      // Held by name: Chrome fires this change as typing moves from the month
      // to the day to the year, and in that instant document.activeElement is
      // the page, not the box — so refreshRow would take nobody to be typing,
      // replace the row, and the rest of the date would be typed into nothing.
      refreshRow(rowId, el);
      updateCounts();
    } else if (el.tagName === 'SELECT') {
      setField(rowId, field, el.value);
      // The tag's colour and tooltip follow the pick at once; the rest of
      // the Status cell (its edge, the flags) is redrawn around it.
      const scaCls = `sca-${el.value.replace(/\s+/g, '-')}`;
      el.className = `fctproc-in fctproc-scasel ${scaCls}`;
      const wrap = el.closest('.fctproc-scawrap'), shownTag = wrap && wrap.querySelector('.fctproc-scatag');
      if (wrap) wrap.title = `Sub-Contractor Agreement: ${el.value}`;
      if (shownTag) { shownTag.className = `fctproc-scatag ${scaCls}`; shownTag.textContent = SCA_SHORT[el.value] || el.value; }
      refreshRow(rowId);
      updateCounts();
    } else if (el.type === 'number') {
      const v = readNumberInput(el, field);
      if (v !== undefined) setField(rowId, field, v);
      const row = rowById(rowId);
      if (row) el.value = row[field] == null ? '' : row[field];
      flushRow(rowId);
    } else {
      setField(rowId, field, el.value);
      flushRow(rowId);
    }
  }

  /** Why a date box's value cannot be saved, or '' when it can (blank included). */
  function dateProblem(el) {
    // A date typed only part way: the box reads '' but is not empty.
    if (el.validity && el.validity.badInput) return 'that is not a whole date';
    const v = String(el.value || '');
    if (!v) return '';
    const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return 'that is not a date';
    const y = Number(m[1]);
    if (y < MIN_YEAR || y > MAX_YEAR) {
      return `the year ${m[1]} is not one this sheet takes (${MIN_YEAR}–${MAX_YEAR}${y < 100 ? ' — type all four digits of the year' : ''})`;
    }
    return ymdOf(v) ? '' : 'that is not a real date';
  }

  // The box was left holding a date that cannot be saved: say so, and put
  // the cell back to the date that is saved. `next` is where the click or
  // Tab that left it is going — a box of the same row that the redraw below
  // must not replace, or that click lands nowhere.
  function refuseDate(el, next) {
    const why = el.dataset.badDate;
    delete el.dataset.badDate;
    el.classList.remove('bad');
    const row = rowById(el.dataset.pr), field = el.dataset.pf;
    const typed = /^\d{4,}-\d{2}-\d{2}$/.test(el.value) ? shownValue(field, el.value) : '';
    const keep = row ? ymdOf(row[field]) : '';
    el.value = keep;
    el.classList.toggle('empty', !keep);
    toast(`${FIELD_LABEL[field] || 'Date'}: ${typed ? typed + ' was' : 'the date was'} not saved — ${why}. `
      + (keep ? `It is back to ${fmtDate(keep)}.` : 'The cell is left blank.'), 'error');
    if (row) refreshRow(row.id, next || null);
  }

  // ── What a combobox held when it took focus ─────────────────────────
  // The page's combobox highlights its FIRST option whenever the box's text
  // matches no option label — an empty Vendor, Unit or Contact, a Sub Code
  // (the cell shows the bare sub code, the options read "Cost / Sub"), a PO
  // matched automatically — and Tab or Enter then commits the highlighted
  // option. In a sheet moved through with Tab, that wrote LB Water, SF and
  // the first bid line into every cell tabbed past. So a commit counts only
  // when the user chose something since the box took focus: typed in it,
  // moved the highlight with the arrow keys, or clicked an option. Anything
  // else puts the box back as it was and saves nothing — as Excel leaves a
  // cell tabbed through.
  //
  // A box the user emptied is the other half of that: the empty text matches
  // no label either, so Tab or Enter would commit the first option in place
  // of the blank the user asked for. Emptied, and no option then picked with
  // the arrow keys, it commits as empty — as clicking away already did.
  const cbSession = new WeakMap();
  const isCb = el => !!(el && el.classList && el.classList.contains('cb-input'));
  function cbChosen(el, nav) {
    const s = cbSession.get(el);
    if (!s) return;
    s.chosen = true;
    s.nav = !!nav;
    s.cleared = false;
  }
  function onCbFocusIn(e) {
    const el = e.target;
    if (!isCb(el)) return;
    cbSession.set(el, { value: el.value, cbValue: el.dataset.cbValue || '', chosen: false, nav: false, cleared: false });
  }
  function onCbInputCapture(e) {
    // The synthetic input of a commit is not typing (tracker sets the flag
    // around it); real typing is stopped by the combobox before it bubbles,
    // so this listens on the way down.
    if (isCb(e.target) && !e.target._cbBypassFilter) cbChosen(e.target, false);
  }
  function onCbKeyCapture(e) {
    const el = e.target;
    if (!isCb(el)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { cbChosen(el, true); return; }
    if (e.key === 'Tab' || e.key === 'Enter') {
      // Seen before the combobox swaps in its highlighted option.
      const s = cbSession.get(el);
      if (s) s.cleared = s.chosen && !s.nav && !el.value.trim();
    }
  }
  function onCbMouseDownCapture(e) {
    const opt = e.target && e.target.closest && e.target.closest('.cb-opt');
    const menu = opt && opt.closest('.cb-menu');
    const input = menu && menu.previousElementSibling;
    if (isCb(input)) cbChosen(input, true);
  }
  /**
   * True (and the box put back) when this commit chose nothing. A box the
   * user emptied before Tab or Enter is emptied again here, so it commits
   * as blank whatever option the combobox highlighted.
   */
  function cbUntouched(input) {
    const s = cbSession.get(input);
    if (!s) return false;
    if (!s.chosen) {
      input.value = s.value;
      if (s.cbValue) input.dataset.cbValue = s.cbValue; else delete input.dataset.cbValue;
      return true;
    }
    if (s.cleared) {
      s.cleared = false;
      input.value = '';
      delete input.dataset.cbValue;
    }
    return false;
  }

  /**
   * What picking a bid line in Sub Code puts in Quantity and Unit: the
   * line's, as Add to Procurement gives a row. Only into a cell that is
   * blank, or that still holds the previously picked line's value (that
   * pick filled it, so correcting the pick brings the new line's numbers).
   * A quantity the PM typed is theirs and stays. So does a unit of their
   * own — and then the bid's quantity is not put in either, as it is
   * counted in the bid's unit (4,002 SY of aggregate is not 4,002 TON).
   */
  const lineUnit = l => str(l && l.unit).slice(0, MAX_LEN.unit);
  function fillFromLine(row, line, ctx) {
    const prev = lineFor(row, ctx);
    const unit = lineUnit(line), u = normUnit(row.unit);
    if (u && u !== normUnit(unit) && !(prev && u === normUnit(lineUnit(prev)))) return {};
    const out = {};
    if (str(row.unit) !== unit) out.unit = unit;
    const q = numOrNull(row.quantity), qty = numOrNull(line.quantity);
    if ((q == null || (prev && sameNum(q, numOrNull(prev.quantity)))) && !sameNum(q, qty)) out.quantity = qty;
    return out;
  }
  // The Quantity / Unit a Sub Code pick filled, by row id:
  // { bid_item_id, fields }. A pick the server refuses takes them with it.
  const lineFill = new Map();

  function commitCombo(rowId, field, input) {
    const row = rowById(rowId);
    if (!row) return;
    if (cbUntouched(input)) return;
    const v = input.dataset.cbValue || '';
    const typed = input.value.trim();
    if (field === 'vendor') {
      if (v.startsWith('__new__:')) { addVendor(rowId, v.slice(8).trim(), input); return; }
      const name = canonicalSupplier(typed).slice(0, MAX_LEN.vendor);
      input.value = name;
      if (changeVendor(rowId, name)) updateCounts();
      return;
    }
    if (field === 'contact') {
      const c = v && contacts.all().find(x => x.id === v);
      if (c) {
        // Picking a saved contact means "this person", so both cells take his
        // details — keeping whatever Email was there would put the previous
        // person's address beside his name, and save it so. One saved with a
        // phone and no email gets the phone, which is how the sheets this
        // replaces filled that column (and how rememberContact files a phone
        // typed there).
        setFields(rowId, { contact: c.name || '', email: c.email || c.phone || '' });
      } else {
        setField(rowId, 'contact', typed.slice(0, MAX_LEN.contact));
      }
      return;
    }
    if (field === 'description') {
      // A name from the library brings what it was bought by and from, into
      // cells that are still blank — never over what the PM has put there,
      // and the vendor not onto a row that is already on an order (the
      // order's supplier is the vendor). A Unit with no Quantity beside it
      // counts as blank: it is the one "+ Material" copied from the bid row
      // above (1 LS of detention system), not anybody's measurement, and the
      // pipe under it is bought by the LF. Anything else is the name as
      // typed; emptied, the row goes back to reading as its Sub Code.
      const entry = libraryEntry(row, v);
      const name = (entry ? entry.material : typed).slice(0, MAX_LEN.description);
      input.value = name;
      const fields = {};
      if (name !== row.description) fields.description = name;
      if (entry) {
        const unit = str(entry.unit).trim().slice(0, MAX_LEN.unit);
        const free = !row.unit.trim() || numOrNull(row.quantity) == null;
        if (unit && free && normUnit(unit) !== normUnit(row.unit)) fields.unit = UNITS.find(x => x.toLowerCase() === unit.toLowerCase()) || unit;
        const vendor = str(entry.vendor).trim();
        const kind = vendor && !row.vendor.trim() ? effectivePO(row, makeCtx()).kind : '';
        if (vendor && !row.vendor.trim() && !['linked', 'auto', 'multiple', 'loading'].includes(kind)) {
          fields.vendor = canonicalSupplier(vendor).slice(0, MAX_LEN.vendor);
        }
      }
      if (Object.keys(fields).length) { setFields(rowId, fields); updateCounts(); }
      return;
    }
    if (field === 'unit') {
      const u = UNITS.find(x => x.toLowerCase() === typed.toLowerCase()) || typed.slice(0, MAX_LEN.unit);
      setField(rowId, 'unit', u);
      return;
    }
    if (field === 'codes') {
      // The row's own job's bid lines (on a site's sheet, not the site's).
      const ctx = siteMode() && row.project_id ? makeCtx(row.project_id) : makeCtx();
      const line = v ? (ctx.bidLines || []).find(l => String(l.id) === v) : null;
      if (v && v === String(row.bid_item_id || '')) {
        // The line it already has, picked again: nothing to re-code, but a
        // row coded before picks brought Quantity and Unit over (or with
        // them emptied since) takes the blank ones now.
        const fill = line ? fillFromLine(row, line, ctx) : {};
        if (Object.keys(fill).length) setFields(rowId, fill);
        return;
      }
      if (line) {
        const fill = fillFromLine(row, line, ctx);
        if (Object.keys(fill).length) lineFill.set(rowId, { bid_item_id: String(line.id), fields: fill });
        else lineFill.delete(rowId);
        setFields(rowId, { bid_item_id: String(line.id), cost_code: str(line.cost_code), sub_code: str(line.sub_code), ...fill });
      } else if (!typed) setFields(rowId, { bid_item_id: null, cost_code: '', sub_code: '' });
      else {
        // Anything else typed matches no bid line: the codes are the bid's
        // (section 1), so the cell goes back to what it was (refreshRow
        // after the commit) — and says why, rather than just undoing it.
        const n = (ctx.bidLines || []).length;
        // (Material is only offered when the page shows it.)
        const desc = !colHidden('description');
        toast(n ? `Sub Code: "${typed.slice(0, 60)}" is not a line on this job's bid — pick one from the list.${desc ? ' Sub Code is the bid line the cost books to; this job\'s own name for the material goes in Material.' : ''}`
          : `Sub Code: this job has no bid lines yet, so there is no cost / sub code to pick. Add the bid items on the bid page first${desc ? '; the material\'s name can go in Material meanwhile' : ''}.`, 'error');
      }
      updateCounts();
      return;
    }
    if (field === 'po') {
      let next = null;
      if (v === '__auto__' || (!v && !typed)) next = { po_id: null, po_auto: true };
      else if (v === '__none__') next = { po_id: null, po_auto: false };
      else if (v && makeCtx().purchaseOrders.some(p => String(p.id) === v)) next = { po_id: v, po_auto: true };
      if (next) { setFields(rowId, next); updateCounts(); }
    }
  }

  async function addVendor(rowId, name, input) {
    if (!name) return;
    if (input) input.value = name;
    changeVendor(rowId, name);
    if (typeof cfg.addSupplier !== 'function') return;
    try {
      const canon = String((await cfg.addSupplier(name)) || name).trim();
      const row = rowById(rowId);
      if (row && canon && row.vendor === name && canon !== name) setField(rowId, 'vendor', canon);
      refreshRow(rowId);
      toast(`Added "${canon}" to the supplier list`);
      // A contact typed on the row before the vendor was on the list can be
      // remembered now.
      rememberContact(rowById(rowId));
    } catch (err) {
      showError(`"${name}" was kept on the row but could not be added to the supplier list: ${err && err.message ? err.message : err}`);
    }
  }

  function pickProject(input) {
    const opts = projectOptions();
    const typed = input.value.trim().toLowerCase();
    const v = input.dataset.cbValue || '';
    const picked = (v && opts.find(o => o.value === v)) || (typed ? opts.find(o => o.label.toLowerCase() === typed) : null);
    if (!picked && typed) {
      // Text matching no job puts the current one back rather than quietly
      // emptying the tab. Only an emptied box means "no job".
      const known = keyExists(st.projectId);
      input.value = known ? openLabel() : '';
      input.dataset.cbValue = known ? st.projectId : '';
      return;
    }
    if (picked) { input.value = picked.label; input.dataset.cbValue = picked.value; }
    selectProject(picked ? picked.value : null);
  }

  function onFocusOut(e) {
    const el = e.target;
    // The row's own buttons count too: Tab out of Email lands on "+ Material",
    // and the click elsewhere that follows is the moment the row is left.
    const tr0 = el.closest && el.closest('tr.fctproc-row');
    const rowId = (el.dataset && el.dataset.pr) || (tr0 && tr0.dataset.row);
    if (!rowId) {
      // Leaving the select-all box, a group header, a filter button: a
      // redraw held back while it had focus is due once focus is elsewhere.
      if (redrawDeferred) setTimeout(redrawWhenFree, 0);
      return;
    }
    if (el.type === 'date' && el.dataset.badDate) {
      // Chrome fires change only on the FIRST key of a box being emptied
      // (the box is then part-filled, so it is marked bad) and none once the
      // last segment is cleared — so what the box holds now decides, not the
      // mark. Emptied all the way, it is a cleared date, and saved as one.
      const now = dateProblem(el);
      if (now) refuseDate(el, e.relatedTarget);
      else {
        delete el.dataset.badDate;
        el.classList.remove('bad');
        el.removeAttribute('title');
        el.classList.toggle('empty', !el.value);
        if (rowById(rowId)) {
          setField(rowId, el.dataset.pf, ymdOf(el.value) || null);
          refreshRow(rowId, e.relatedTarget || null);
          updateCounts();
        }
      }
    }
    if (el.classList.contains('cb-input') && el.dataset.pr) {
      // The page's combobox commits 120 ms after blur. Mark it so nothing
      // redraws it out from under that commit, then tidy the row once it has.
      el.dataset.pcommit = '1';
      setTimeout(() => { if (el.isConnected) { delete el.dataset.pcommit; refreshRow(rowId); } }, 220);
    }
    // Leaving the row sends its edits now rather than after the quiet spell,
    // and remembers the contact typed on it under its vendor.
    setTimeout(() => {
      const a = document.activeElement;
      const tr = st.mountEl && st.mountEl.querySelector(`tr[data-row="${cssEsc(rowId)}"]`);
      if (tr && a && tr.contains(a)) return;
      flushRow(rowId);
      rememberContact(rowById(rowId));
      if (!el.classList.contains('cb-input')) refreshRow(rowId);
      // A redraw held back while this cell was in use (redrawAround).
      if (redrawDeferred) setTimeout(redrawWhenFree, el.classList.contains('cb-input') ? 250 : 0);
    }, 0);
  }

  function onKeyDown(e) {
    const el = e.target;
    if (el.id === 'fctproc-search' && e.key === 'Escape' && st.search) {
      e.preventDefault();
      el.value = '';
      st.search = '';
      renderTable();
      updateCounts();
      return;
    }
    // Enter moves down a row in the same column, as in the sheet it replaces.
    if (e.key !== 'Enter' || e.defaultPrevented || el.classList.contains('cb-input') || el.tagName === 'SELECT') return;
    const rowId = el.dataset && el.dataset.pr, field = el.dataset && el.dataset.pf;
    if (!rowId || !field) return;
    e.preventDefault();
    let tr = el.closest('tr') && el.closest('tr').nextElementSibling;
    while (tr && !tr.querySelector(`[data-pf="${cssEsc(field)}"]`)) tr = tr.nextElementSibling;
    const next = tr && tr.querySelector(`[data-pf="${cssEsc(field)}"]`);
    if (next) { next.focus(); try { next.select(); } catch { /* dates */ } } else el.blur();
  }

  function onClick(e) {
    const chip = e.target.closest('[data-chip]');
    if (chip) { st.chip = chip.dataset.chip; st.forceShow.clear(); renderTable(); updateCounts(); return; }
    const grp = e.target.closest('[data-group]');
    if (grp) {
      st.grouping = grp.dataset.group;
      storeSet('group', st.grouping);
      st.collapsed.clear();
      grp.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === grp));
      renderTable();
      return;
    }
    const ff = e.target.closest('[data-pff]');
    if (ff) { e.stopPropagation(); openFilter(ff.dataset.pff, ff); return; }
    // A section's box selects its rows (onChange); it does not fold it.
    if (e.target.closest('.fctproc-grpsel')) return;
    // Nor does its + Add Row, which adds a row in it.
    const ga = e.target.closest('[data-grpadd]');
    if (ga) { addToSection(ga.dataset.grpadd); return; }
    // Nor a job band's Add to Procurement, which opens that job's checklist.
    const gs = e.target.closest('[data-grpsend]');
    if (gs) { openSendModal(gs.dataset.grpsend); return; }
    // Nor its folder chip, which opens the section's cost-code folder. Enter
    // or Space on the chip arrives here as a click on it too, so the
    // keyboard opens the folder and never folds the section either.
    const gd = e.target.closest('[data-grpdocs]');
    if (gd) { openSectionFolder(gd.dataset.grpdocs, gd.dataset.pid); return; }
    const gh = e.target.closest('tr.fctproc-grp');
    if (gh) {
      const k = gh.dataset.grp;
      if (st.collapsed.has(k)) st.collapsed.delete(k); else st.collapsed.add(k);
      renderTable();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const rowId = b.dataset.row;
    switch (b.dataset.act) {
      case 'retry': load(st.projectId); break;
      case 'send': openSendModal(); break;
      case 'add': addRow({}); break;
      case 'material': addMaterial(rowId); break;
      case 'del': st.confirmDel = rowId; refreshRow(rowId); break;
      case 'del-no': st.confirmDel = null; refreshRow(rowId); break;
      case 'del-yes': deleteRows([rowId]); break;
      case 'xlsx': exportRows('xlsx'); break;
      case 'csv': exportRows('csv'); break;
      case 'pdf': printRows(); break;
      case 'clear': clearFilters(); break;
      case 'open-po': if (typeof cfg.openPurchaseOrder === 'function') cfg.openPurchaseOrder(b.dataset.po); break;
      case 'files': openAttachments(rowId); break;
      case 'use-bid': useBid(rowId, true); break;
      case 'dismiss-bid': useBid(rowId, false); break;
      case 'bulk-apply': bulkApply(); break;
      case 'bulk-po': createPOFromSelected(); break;
      case 'bulk-del': st.bulkConfirmDel = true; renderBulk(); break;
      case 'bulk-del-no': st.bulkConfirmDel = false; renderBulk(); break;
      case 'bulk-del-yes': deleteRows([...st.selected]); break;
      case 'bulk-clear': clearSelection(); break;
      default: break;
    }
  }

  function clearFilters() {
    st.search = '';
    st.filters = {};
    st.chip = 'all';
    st.forceShow.clear();
    renderBar();
    renderTable();
  }
  function clearSelection() {
    st.selected.clear();
    st.bulkConfirmDel = false;
    renderBulk();
    renderTable();
  }

  function focusField(rowId, field) {
    const el = st.mountEl && st.mountEl.querySelector(`[data-pr="${cssEsc(rowId)}"][data-pf="${cssEsc(field)}"]`);
    if (!el) return;
    try { el.scrollIntoView({ block: 'nearest' }); } catch { /* jsdom */ }
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  }

  // ── Row actions ─────────────────────────────────────────────────────
  /**
   * Add a hand-made row. `pid` is the job it goes on: the open job when not
   * given — and on a site's sheet, the job the PM picks.
   */
  async function addRow(seed, pid) {
    if (!canEdit() || st.loadState !== 'ok' || !st.projectId) return null;
    const job = pid || (siteMode() ? await pickJob('Add a row', 'Which job is the row for? Each job keeps its own rows and costs.') : st.projectId);
    if (!job || !isOpenJob(job) || st.loadState !== 'ok') return null;
    const item = { id: uid(), project_id: job, ...seed };
    setSave('saving');
    try {
      let data;
      try {
        data = await api('POST', '/procurement' + q({}), { item });
      } catch (err) {
        // No answer: the server may have added the row and the answer been
        // lost. Asked again with the SAME id, it is added once either way —
        // "duplicate" means the first one landed.
        if (!err.network) throw err;
        try {
          data = await api('POST', '/procurement' + q({}), { item });
        } catch (err2) {
          if (err2.code !== 'duplicate') throw err2;
          data = { item: { ...item, source: 'manual', version: 1, created_at: new Date().toISOString() } };
          // The row as the server has it comes with the next read.
          setTimeout(() => { if (isOpenJob(item.project_id)) load(st.projectId, { quiet: true }); }, 0);
        }
      }
      const row = adoptServerRow(data.item || item);
      if (row) st.forceShow.add(row.id);
      setSave('saved');
      renderTable();
      updateCounts();
      // Material to name — its picker opens on the names used under the
      // row's Sub Code before, which is what "+ Material" is for — or, with
      // it hidden, Quantity (the Sub Code picker is left for a click).
      if (row) focusField(row.id, colHidden('description') ? 'quantity' : 'description');
      return row;
    } catch (err) {
      setSave('error');
      showError(err.network
        ? `Procurement: the row may not have been added (${err.message}). It shows here once the server answers — check before adding it again.`
        : `Procurement: the row could not be added (${err.message}).`);
      return null;
    }
  }
  /**
   * What a row added from a section header starts with, so that it lands in
   * that section: its cost code (grouped by cost code; Sub Code is then
   * picked from the bid lines as on any hand-added row), or its vendor and
   * quote # (grouped by vendor / quote) — with the contact and email when
   * every row there has the same one. "No cost code" / "No vendor yet" give
   * a blank row, as the toolbar's + Add Row does.
   */
  function sectionSeed(g) {
    if (st.grouping === 'vendor') {
      const seed = {};
      if (g.vendor) seed.vendor = g.vendor;
      if (g.quote) seed.quote_number = g.quote;
      const one = f => {
        const vals = [...new Set(g.rows.map(r => str(r[f]).trim()).filter(Boolean))];
        return vals.length === 1 ? vals[0] : '';
      };
      if (g.vendor && one('contact')) seed.contact = one('contact');
      if (g.vendor && one('email')) seed.email = one('email');
      return seed;
    }
    return g.code ? { cost_code: g.code } : {};
  }
  function addToSection(key) {
    if (!canEdit() || st.loadState !== 'ok') return null;
    // A job band's: a blank row on that job.
    if (String(key).startsWith(JOB)) {
      const pid = String(key).slice(JOB.length);
      if (st.collapsed.delete(key)) renderTable();
      return addRow({}, pid);
    }
    const ctx = makeCtx();
    const g = groupRows(visibleRows(ctx), ctx).find(x => x.key === key);
    if (!g) return null;
    // A folded section opens, so the row is seen going in.
    if (st.collapsed.delete(key)) renderTable();
    // The section's job: its own (a site's cost-code section is one job's),
    // else the one job all its rows are on, else the PM picks (a vendor
    // section that spans the site's jobs).
    let pid = g.pid || null;
    if (!pid && ctx.site) {
      const jobs = [...new Set(g.rows.map(r => r.project_id))];
      if (jobs.length === 1) pid = jobs[0];
    }
    return addRow(sectionSeed(g), pid || undefined);
  }
  // The rows a section's box ticks: the section's as shown, or a job band's
  // (every row of the job shown, whatever section it is in).
  function sectionRows(key, ctx) {
    const vis = visibleRows(ctx);
    if (String(key).startsWith(JOB)) {
      const pid = String(key).slice(JOB.length);
      return vis.filter(r => r.project_id === pid);
    }
    const g = groupRows(vis, ctx).find(x => x.key === key);
    return g ? g.rows : [];
  }
  /**
   * "+ Material": another material under the row's bid line. When that line
   * was bought as named materials on another job (the library says so), the
   * PM is offered that job's list to copy — a detention system's seventeen
   * parts in one go — or a blank row as before.
   */
  // One copy at a time: from the click that reads the lists, through the
  // dialog, to the add's answer. A double click, or "+ Material" again while
  // an add is still out (the dialog closed with Escape meanwhile), would
  // otherwise open a second dialog and add the list twice.
  let copying = null;
  async function addMaterial(parentId) {
    const p = rowById(parentId);
    if (!p) return null;
    const ctx = siteMode() && p.project_id ? makeCtx(p.project_id) : makeCtx();
    const codes = liveCodes(p, ctx);
    const blank = () => addRow({ bid_item_id: p.bid_item_id || null, cost_code: codes.cost_code, sub_code: codes.sub_code, unit: p.unit || '' },
      p.project_id || undefined);
    if (!canEdit() || !hasPastList(p, ctx)) return blank();
    if (copying) {
      if (copying.adding) toast('Still adding the materials from the other job — a moment.');
      return null;
    }
    const token = copying = { open: false, adding: false };
    const done = () => { if (copying === token && !token.open && !token.adding) copying = null; };
    let lists = null;
    try {
      const data = await api('GET', '/procurement' + q({ action: 'breakdowns', sub_code: codes.sub_code, cost_code: codes.cost_code,
        exclude_project: p.project_id || st.projectId }));
      lists = (Array.isArray(data.breakdowns) ? data.breakdowns : []).filter(b => b && Array.isArray(b.items) && b.items.length);
    } catch (err) {
      // The lists are a help: without them "+ Material" still adds a row.
      console.warn('[procurement] could not read the material lists of other jobs', err);
    }
    if (!rowById(parentId) || !isMounted()) { copying = copying === token ? null : copying; return null; }
    if (!lists || !lists.length) { copying = copying === token ? null : copying; return blank(); }
    token.open = true;
    const m = openCopyList(rowById(parentId), lists, blank, token);
    m.onClose = () => { token.open = false; done(); };
    return m;
  }

  /**
   * Whether "+ Material" on a row has a list to offer: its bid line is on
   * the bid, and the library has a name bought under the line's sub code
   * (and cost code) that this job does not have yet — so some other job
   * bought it. Once everything is here, nothing is offered. Indexed once per
   * ctx (a render draws every row's "+ Material").
   */
  const _pastIndex = new WeakMap();
  function hasPastList(row, ctx) {
    if (colHidden('description') || !row) return false;
    const codes = liveCodes(row, ctx);
    // A row whose line is gone has no line to copy a list under.
    if (!codes.line) return false;
    const k = keyFn(ctx);
    const sk = ck(k, codes.sub_code), cc = ck(k, codes.cost_code);
    if (!sk) return false;
    let ix = _pastIndex.get(ctx);
    if (!ix || ix.list !== lib.list || ix.rows !== st.rows.length || ix.named !== st.rows.reduce((n, r) => n + (str(r.description).trim() ? 1 : 0), 0)) {
      ix = { list: lib.list, rows: st.rows.length, named: 0, bySub: new Map(), here: new Set() };
      lib.list.forEach(e => {
        const s = ck(k, e.sub_code);
        if (!s || !(e.jobs > 0)) return;
        if (!ix.bySub.has(s)) ix.bySub.set(s, []);
        ix.bySub.get(s).push(e);
      });
      st.rows.forEach(r => {
        const m = str(r.description).trim();
        if (!m) return;
        ix.named++;
        ix.here.add(`${r.project_id}\u0000${ck(k, liveCodes(r, ctx).sub_code)}\u0000${ck(k, m)}`);
      });
      _pastIndex.set(ctx, ix);
    }
    return (ix.bySub.get(sk) || []).some(e => (!cc || !ck(k, e.cost_code) || ck(k, e.cost_code) === cc)
      && !ix.here.has(`${row.project_id}\u0000${sk}\u0000${ck(k, e.material)}`));
  }

  /**
   * The copy dialog: the jobs this line was bought on, most recent first,
   * and the materials of the one picked, each ticked unless this job has it
   * already. Added with their names, units and vendors — quantities only
   * when asked, since they are the other job's. The line's own row (sent
   * from the bid), when it has no name yet, takes the name the other job's
   * own row had rather than standing beside it as a placeholder.
   */
  function openCopyList(p, lists, blank, token = null) {
    const ctx = siteMode() && p.project_id ? makeCtx(p.project_id) : makeCtx();
    const k = keyFn(ctx);
    const codes = liveCodes(p, ctx);
    const sk = ck(k, codes.sub_code);
    const pid = p.project_id || st.projectId;
    const lineRows = st.rows.filter(r => r.project_id === pid && ck(k, liveCodes(r, ctx).sub_code) === sk);
    const have = new Set(lineRows.map(r => ck(k, materialOf(r, ctx))).filter(Boolean));
    const own = p.bid_item_id ? st.rows.find(r => r.project_id === pid && r.source === 'bid' && String(r.bid_item_id) === String(p.bid_item_id)) : null;
    // Read as the dialog is used, not once: a colleague (or the PM, in the
    // sheet behind) can name that row while it is open.
    const ownFree = () => { const r = own && rowById(own.id); return !!r && !r.deleted_at && !str(r.description).trim(); };
    const name = [codes.cost_code.trim(), codes.sub_code.trim()].filter(Boolean).join(' / ');
    let pick = 0, copyQty = false;
    const ticks = lists.map(l => l.items.map(it => !have.has(ck(k, it.material))));
    // A row id per material, kept for the dialog's life: Add tried again
    // after an answer that never came sends the same ids, so a material
    // that went in the first time goes in once.
    const ids = lists.map(l => l.items.map(() => uid()));
    const jobOf = l => {
      const j = project(l.project_id);
      return j ? projLabel(j) + (j['job-number'] ? ` · Job #${j['job-number']}` : '') : 'An earlier job';
    };
    const when = iso => { const d = ymdOf(iso); return d ? fmtDate(d) : ''; };
    const foot = `<span data-copy="count" style="margin-right:auto;color:var(--muted,#9ca3af)"></span>
      <button type="button" class="btn btn-ghost fctproc-b" data-copy="blank">Just a blank row</button>
      <button type="button" class="btn btn-ghost fctproc-b" data-copy="cancel">Cancel</button>
      <button type="button" class="btn btn-green fctproc-b" data-copy="go">Add</button>`;
    const m = modal(`Add materials — ${name}`, '', { wide: true, footHTML: foot });
    const go = m.foot.querySelector('[data-copy="go"]');
    // Which ticked item names this line's own row: the other job's own row,
    // else the first ticked — only while this line's own row has no name.
    const namer = () => {
      if (!ownFree()) return -1;
      const items = lists[pick].items;
      const ticked = items.map((it, i) => (ticks[pick][i] ? i : -1)).filter(i => i >= 0);
      const bidOne = ticked.find(i => items[i].source === 'bid');
      return bidOne != null ? bidOne : ticked.length ? ticked[0] : -1;
    };
    const sync = () => {
      const n = ticks[pick].filter(Boolean).length;
      const named = namer() >= 0 ? 1 : 0;
      const adds = n - named;
      m.foot.querySelector('[data-copy="count"]').textContent = n
        ? `${adds} new row${adds === 1 ? '' : 's'}${named ? ` · names this line's own row` : ''}` : 'Nothing ticked';
      go.textContent = n ? `Add ${n} material${n === 1 ? '' : 's'}` : 'Add';
      go.disabled = !n;
      m.body.querySelectorAll('[data-ci]').forEach(el => {
        const i = +el.dataset.ci;
        el.querySelector('.own').hidden = namer() !== i;
      });
    };
    const draw = () => {
      const l = lists[pick];
      m.body.innerHTML = `
        <p style="margin:0 0 0.7rem;line-height:1.5;color:var(--muted,#9ca3af)">
          On ${lists.length === 1 ? 'another job' : `${lists.length} other jobs`} this bid line was bought as these materials.
          Tick what this job needs: each is added under <b>${esc(name)}</b> — the cost still books to that line — with its unit and vendor.</p>
        ${lists.length > 1 ? `<div class="fctproc-copyjobs" role="radiogroup" aria-label="Copy from which job">${lists.map((x, i) => `
          <label class="fctproc-copyjob${i === pick ? ' on' : ''}"><input type="radio" name="fctproc-copyjob" data-cj="${i}"${i === pick ? ' checked' : ''}>
            <span class="n">${esc(jobOf(x))}</span><span class="gm">${x.items.length} material${x.items.length === 1 ? '' : 's'}${when(x.last_used) ? ` · ${esc(when(x.last_used))}` : ''}</span></label>`).join('')}</div>`
          : `<div class="fctproc-copyjob on single"><span class="n">${esc(jobOf(l))}</span><span class="gm">${l.items.length} material${l.items.length === 1 ? '' : 's'}${when(l.last_used) ? ` · ${esc(when(l.last_used))}` : ''}</span></div>`}
        <div class="fctproc-send-grp"><div class="fctproc-send-h"><span>Materials</span><span class="fctproc-spacer"></span>
          <button type="button" class="fctproc-link" data-copy="all">All</button><button type="button" class="fctproc-link" data-copy="none">None</button></div>
          ${l.items.map((it, i) => {
            const dup = have.has(ck(k, it.material));
            const meta = [it.quantity == null ? '' : fmtQty(it.quantity), normUnit(it.unit)].filter(Boolean).join(' ');
            return `<label class="fctproc-send-line" data-ci="${i}">
              <input type="checkbox" data-cx="${i}"${ticks[pick][i] ? ' checked' : ''}>
              <span class="sub" title="${esc(it.material)}">${esc(it.material)}</span>
              <span class="qty">${esc([meta, it.vendor].filter(Boolean).join(' · '))}</span>
              ${dup ? '<span class="fctproc-tag" title="A row of this job under this line already has this name">already here</span>' : ''}
              <span class="fctproc-tag own" hidden title="This line's own row (sent from the bid) has no name yet: it takes this one (and its unit, in place of the bid's whole-line quantity) rather than a new row being added">names the line's own row</span></label>`;
          }).join('')}
        </div>
        <label class="fctproc-check" style="margin-top:0.7rem"><input type="checkbox" data-copy="qty"${copyQty ? ' checked' : ''}>
          Copy the quantities too — they are that job's: check them against this job's plans</label>`;
      sync();
    };
    draw();
    m.body.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.cj != null) { pick = +t.dataset.cj; draw(); return; }
      if (t.dataset.cx != null) { ticks[pick][+t.dataset.cx] = t.checked; sync(); return; }
      if (t.dataset.copy === 'qty') copyQty = t.checked;
    });
    m.body.addEventListener('click', e => {
      const b = e.target.closest('[data-copy="all"],[data-copy="none"]');
      if (!b) return;
      ticks[pick] = ticks[pick].map(() => b.dataset.copy === 'all');
      m.body.querySelectorAll('[data-cx]').forEach(cb => { cb.checked = ticks[pick][+cb.dataset.cx]; });
      sync();
    });
    let busy = false;
    m.foot.addEventListener('click', async e => {
      const b = e.target.closest('[data-copy]');
      if (!b || busy) return;
      if (b.dataset.copy === 'cancel') { m.close(); return; }
      if (b.dataset.copy === 'blank') { m.close(); blank(); return; }
      if (b.dataset.copy !== 'go') return;
      busy = true;
      if (token) token.adding = true;
      go.disabled = true;
      go.textContent = 'Adding…';
      let done = false;
      try {
        done = await copyMaterials(p, lists[pick], ticks[pick], { copyQty, nameOwn: namer(), ownId: own ? own.id : null, ids: ids[pick] });
      } finally {
        busy = false;
        if (token) {
          token.adding = false;
          if (!token.open && copying === token) copying = null;
        }
      }
      if (done) m.close();
      else if (m.el.isConnected) sync();
    });
    return m;
  }

  /**
   * Put the ticked materials of one job's list on this row's line: the
   * line's own row named (when `nameOwn` says which), the rest added in one
   * request (POST action=add). Each takes this job's codes for the line, the
   * other job's name, unit and vendor, and its quantity only when asked. A
   * retry after an answer lost on the way back sends the same ids, so a row
   * goes in once. True when it went in.
   */
  async function copyMaterials(p, list, ticked, { copyQty = false, nameOwn = -1, ownId = null, ids = null } = {}) {
    const ctx = siteMode() && p.project_id ? makeCtx(p.project_id) : makeCtx();
    const codes = liveCodes(p, ctx);
    const pid = p.project_id || st.projectId;
    const vendorOf = it => canonicalSupplier(str(it.vendor)).slice(0, MAX_LEN.vendor);
    const picked = list.items.map((it, i) => ({ it, i })).filter(x => ticked[x.i]);
    if (!picked.length) return false;
    const ownFree = () => { const r = ownId && rowById(ownId); return !!r && !r.deleted_at && !str(r.description).trim(); };
    // Decided now, on the row as it is now: named since the dialog opened,
    // the material that would have named it is added as a row of its own.
    let naming = nameOwn >= 0 && ticked[nameOwn] && ownFree() ? nameOwn : -1;
    const itemOf = (it, i) => ({
      id: (ids && ids[i]) || uid(),
      // The line is on the bid (hasPastList); a row coded off a line that has
      // gone since would be refused as stale, so it carries no line instead.
      bid_item_id: codes.line ? String(codes.line.id) : null,
      cost_code: codes.cost_code,
      sub_code: codes.sub_code,
      description: it.material.slice(0, MAX_LEN.description),
      unit: str(it.unit).slice(0, MAX_LEN.unit),
      vendor: vendorOf(it),
      quantity: copyQty && it.quantity != null ? it.quantity : null,
    });
    const from = (() => { const j = project(list.project_id); return j ? projLabel(j) : 'the other job'; })();
    const post = async items => {
      const send = () => api('POST', '/procurement' + q({ action: 'add' }), { project_id: pid, items });
      let data;
      try { data = await send(); } catch (err) { if (!err.network) throw err; data = await send(); }
      return (data.created || []).concat(data.existing || []).map(adoptServerRow).filter(Boolean);
    };
    let rows = [];
    const items = picked.filter(x => x.i !== naming).map(x => itemOf(x.it, x.i));
    // The new rows first: the line's own row is only renamed once they are
    // in, so a refused or failed add leaves it as it was.
    if (items.length) {
      setSave('saving');
      try {
        rows = await post(items);
      } catch (err) {
        setSave('error');
        showError(err.network
          ? `Procurement: the materials may not have been added (${err.message}). They show here once the server answers — check before adding them again.`
          : `Procurement: the materials could not be added (${err.message}).`);
        return false;
      }
    }
    let named = false;
    if (naming >= 0 && ownFree()) {
      const it = list.items[naming];
      const r = rowById(ownId);
      const f = { description: it.material.slice(0, MAX_LEN.description) };
      const unit = str(it.unit).trim().slice(0, MAX_LEN.unit);
      // The row's Quantity / Unit as the bid sent them (1 LS of detention
      // system) measure the whole line, not the one material the row now
      // names — so they make way for the material's (its unit, and its
      // quantity when asked). A quantity the PM typed is theirs and stays,
      // with its unit, whatever was asked.
      const asSent = r.source === 'bid' && r.quantity != null && sameNum(r.quantity, r.bid_qty_at_send)
        && normUnit(r.unit) === normUnit(r.bid_unit_at_send == null ? '' : r.bid_unit_at_send);
      const free = r.quantity == null || asSent;
      if (copyQty && it.quantity != null && free) { f.quantity = it.quantity; if (unit) f.unit = unit; }
      else if (unit && normUnit(unit) !== normUnit(r.unit)) {
        if (!r.unit.trim() || r.quantity == null) f.unit = unit;
        else if (asSent) { f.unit = unit; f.quantity = null; }
      }
      if (!r.vendor.trim() && it.vendor && !['linked', 'auto', 'multiple', 'loading'].includes(effectivePO(r, ctx).kind)) f.vendor = vendorOf(it);
      setFields(ownId, f);
      flushRow(ownId);
      named = true;
    } else if (naming >= 0) {
      // Named by someone else while the rows went in: that material is a row too.
      try { rows = rows.concat(await post([itemOf(list.items[naming], naming)])); } catch (err) {
        showError(`Procurement: "${list.items[naming].material}" could not be added (${err.message}).`);
      }
      naming = -1;
    }
    rows.forEach(r => st.forceShow.add(r.id));
    if (rows.length) setSave('saved');
    renderTable();
    updateCounts();
    const n = rows.length + (named ? 1 : 0);
    toast(`Added ${n} material${n === 1 ? '' : 's'} from ${from}${named ? ' (one names this line\'s own row)' : ''}${copyQty ? '' : ' — fill in this job\'s quantities'}`);
    // Fewer back than sent: an id already taken elsewhere. The sheet is read
    // again rather than guessed at.
    if (rows.length < items.length) setTimeout(() => { if (isOpenJob(pid)) load(st.projectId, { quiet: true }); }, 0);
    return true;
  }

  // ── Attachments ─────────────────────────────────────────────────────
  /**
   * What the documents dialog calls a line: its codes as the sheet shows them
   * ("Stormwater / Geofabric"), else its Description when the page shows that
   * column (a hidden one is text the PM can neither see nor correct), else
   * plainly "Procurement line".
   */
  function lineLabel(r, codes) {
    const named = [codes.cost_code.trim(), codes.sub_code.trim()].filter(Boolean).join(' / ');
    const desc = colHidden('description') ? '' : str(r.description).trim();
    // A line with a Material of its own is called by it, with the codes it
    // books to: the seventeen lines of one detention system share their codes.
    if (named && desc && lc(desc) !== lc(codes.sub_code)) return `${desc} — ${named}`;
    if (named) return named;
    return desc || 'Procurement line';
  }

  /**
   * Wait for the row's edits to be saved, a few seconds at most. The server
   * files a line's attachment under the cost code IT holds for the line, so
   * a Sub Code picked a moment ago has to be saved before anything is
   * attached: else the file is filed in the old cost code's folder (moved
   * when the save lands, but listed in the wrong place meanwhile). Two things
   * can still be on their way when the paperclip is clicked:
   *   - the Sub Code box's own commit. The page's combobox commits 120 ms
   *     after the box is left, and pressing the paperclip is what left it,
   *     so the click comes first. The box is marked until then (data-pcommit).
   *   - the row's save, which waits for a quiet spell before it goes, or is
   *     already out with more queued behind it. Sent now and waited for.
   * A save that fails stops the wait: the message about it is already up, and
   * the attachment follows the line's code once the save does land.
   */
  async function settleRow(rowId, ms = 5000) {
    const until = Date.now() + ms;
    const wait = () => new Promise(res => setTimeout(res, 40));
    const committing = () => {
      const tr = st.mountEl && st.mountEl.querySelector(`tr[data-row="${cssEsc(rowId)}"]`);
      return !!(tr && tr.querySelector('[data-pcommit]'));
    };
    while (committing() && Date.now() < until) await wait();
    let sent = false;
    while ((pend.has(rowId) || fly.has(rowId)) && Date.now() < until) {
      if (fly.has(rowId)) { await wait(); continue; }
      if (sent && failed.has(rowId)) break;
      sent = true;
      await flushRow(rowId);
    }
  }

  /**
   * The paperclip: the line's documents, opened by the page. The line is
   * described the way the sheet shows it — its live codes (the bid line's
   * own, when it is tied to one), trimmed — so the dialog can say which cost
   * code's folder the file is filed in as well.
   */
  const filesOpening = new Set();     // rows whose paperclip is waiting on a save
  async function openAttachments(rowId) {
    if (typeof cfg.openAttachments !== 'function' || !rowById(rowId) || filesOpening.has(rowId)) return;
    filesOpening.add(rowId);
    let line = null;
    try {
      await settleRow(rowId);
      const r = rowById(rowId);
      // Deleted by someone else while its save was out: the message about
      // that is up, and there is no line left to attach to.
      if (!r) return;
      const codes = liveCodes(r, makeCtx());
      line = {
        id: r.id,
        project_id: r.project_id || st.projectId,
        cost_code: codes.cost_code.trim(),
        sub_code: codes.sub_code.trim(),
        label: lineLabel(r, codes),
      };
    } finally {
      filesOpening.delete(rowId);
    }
    // Not awaited: the page's dialog may stay open for as long as it likes.
    try {
      const p = cfg.openAttachments(line);
      if (p && typeof p.then === 'function') p.then(null, err => console.warn('[procurement] could not open the attachments', err));
    } catch (err) {
      console.warn('[procurement] could not open the attachments', err);
    }
  }

  /** A cost-code section's folder chip: that cost code's folder on its job. */
  function openSectionFolder(code, pid) {
    const costCode = String(code == null ? '' : code).trim();
    const projectId = pid || (siteMode() ? null : st.projectId);
    if (typeof cfg.openCostCodeFolder !== 'function' || !projectId || !isOpenJob(projectId) || !costCode) return;
    try {
      const p = cfg.openCostCodeFolder({ projectId, costCode });
      if (p && typeof p.then === 'function') p.then(null, err => console.warn('[procurement] could not open the cost-code folder', err));
    } catch (err) {
      console.warn('[procurement] could not open the cost-code folder', err);
    }
  }

  async function deleteRows(ids) {
    const list = ids.filter(id => rowById(id));
    if (!list.length || !canEdit()) return;
    setSave('saving');
    try {
      const params = list.length === 1 ? { id: list[0] } : { ids: list.join(',') };
      await api('DELETE', '/procurement' + q(params));
      list.forEach(dropRow);
      st.bulkConfirmDel = false;
      setSave('saved');
      renderBulk();
      renderTable();
      updateCounts();
      if (list.length > 1) toast(`Deleted ${list.length} rows`);
    } catch (err) {
      setSave('error');
      st.confirmDel = null;
      list.forEach(refreshRow);
      showError(`Procurement: could not delete (${err.message}).`);
    }
  }

  function useBid(rowId, takeQty) {
    const row = rowById(rowId);
    if (!row) return;
    const bc = bidChange(row, makeCtx());
    if (!bc) { refreshRow(rowId); return; }
    const fields = { bid_qty_at_send: bc.toQty, bid_unit_at_send: str(bc.line.unit) };
    if (takeQty) { fields.quantity = bc.toQty; fields.unit = str(bc.line.unit); }
    setFields(rowId, fields);
    flushRow(rowId);
    refreshRow(rowId);
  }

  // ── Bulk edit ───────────────────────────────────────────────────────
  async function readBulkFields() {
    const box = st.mountEl.querySelector('#fctproc-bulk-valbox');
    const val = box && box.querySelector('#fctproc-bulk-val');
    switch (st.bulkField) {
      case 'vendor': {
        const input = box && box.querySelector('.cb-input');
        const v = (input && input.dataset.cbValue) || '';
        let name = input ? input.value.trim() : '';
        if (v.startsWith('__new__:')) {
          name = v.slice(8).trim();
          if (typeof cfg.addSupplier === 'function') {
            try { name = String((await cfg.addSupplier(name)) || name).trim(); } catch (err) {
              showError(`"${name}" could not be added to the supplier list: ${err && err.message ? err.message : err}`);
            }
          }
        } else name = canonicalSupplier(name);
        return { vendor: name.slice(0, MAX_LEN.vendor) };
      }
      case 'contact_email': return {
        contact: (box.querySelector('#fctproc-bulk-contact').value || '').trim().slice(0, MAX_LEN.contact),
        email: (box.querySelector('#fctproc-bulk-email').value || '').trim().slice(0, MAX_LEN.email),
      };
      case 'sca_status': return { sca_status: SCA_VALUES.includes(val.value) ? val.value : 'Pending' };
      case 'date_needed': case 'date_ordered': case 'date_delivered': return { [st.bulkField]: ymdOf(val.value) || null };
      case 'lead_time_days': { const n = numOrNull(val.value); return { lead_time_days: n == null ? null : Math.max(0, Math.min(3650, Math.round(n))) }; }
      case 'po': return val.value === '__none__' ? { po_id: null, po_auto: false }
        : val.value === '__auto__' || !val.value ? { po_id: null, po_auto: true } : { po_id: val.value, po_auto: true };
      default: return { quote_number: (val.value || '').trim().slice(0, MAX_LEN.quote_number) };
    }
  }

  async function bulkPatch(ids, fields) {
    // Edits already typed into these rows land first; then the bulk value
    // wins over any of them for the fields it sets.
    await flushAll();
    ids.forEach(id => {
      const p = pend.get(id);
      if (p) { Object.keys(fields).forEach(k => delete p[k]); if (!Object.keys(p).length) pend.delete(id); }
    });
    setSave('saving');
    // project_id pins the edit to the open job on the server too, so a
    // selection can never reach a row that has moved to another one. On a
    // site's sheet the rows are on several jobs: one edit per job, each
    // pinned to its own.
    const batches = [];
    if (siteMode()) {
      const byJob = new Map();
      ids.forEach(id => {
        const r = rowById(id);
        if (!r || !r.project_id) return;
        if (!byJob.has(r.project_id)) byJob.set(r.project_id, []);
        byJob.get(r.project_id).push(id);
      });
      byJob.forEach((list, pid) => batches.push({ ids: list, fields, project_id: pid }));
    } else {
      const body = { ids, fields };
      if (st.projectId) body.project_id = st.projectId;
      batches.push(body);
    }
    const data = { items: [], missing: [] };
    for (const body of batches) {
      const d = await api('PATCH', '/procurement' + q({ action: 'bulk' }), body);
      (d.items || []).forEach(adoptServerRow);
      (d.missing || []).forEach(dropRow);
      data.items.push(...(d.items || []));
      data.missing.push(...(d.missing || []));
    }
    settleSave();
    if (st.saveState === 'saving') setSave('saved');
    return data;
  }

  // A saved contact picked in the bulk bar fills its Email box too.
  function pickBulkContact(input) {
    const v = input.dataset.cbValue || '';
    const c = v && contacts.all().find(x => x.id === v);
    if (!c) return;
    input.value = c.name || '';
    const em = st.mountEl && st.mountEl.querySelector('#fctproc-bulk-email');
    if (em) em.value = c.email || c.phone || '';
  }

  async function bulkApply() {
    const ids = [...st.selected].filter(id => rowById(id));
    if (!ids.length || !canEdit()) return;
    if (/^date_/.test(st.bulkField)) {
      const box = st.mountEl.querySelector('#fctproc-bulk-val');
      const bad = box && dateProblem(box);
      if (bad) { toast(`${FIELD_LABEL[st.bulkField]}: nothing was changed — ${bad}.`, 'error'); return; }
    }
    const fields = await readBulkFields();
    // An empty box applied to twenty rows wipes twenty cells; make sure that
    // is what was meant rather than an Apply clicked before typing.
    if (Object.values(fields).every(v => v === '' || v == null)) {
      const label = (BULK_FIELDS.find(([k]) => k === st.bulkField) || [, 'that field'])[1];
      let ok = false;
      try { ok = window.confirm(`Clear ${label} on ${ids.length} row${ids.length === 1 ? '' : 's'}?`); } catch { ok = false; }
      if (!ok) return;
    }
    // A new vendor on rows whose Contact / Email are a saved contact of the
    // vendor they had: that person is the old supplier's, so those rows have
    // them cleared in the same change (changeVendor, for many rows).
    let groups = [[ids, fields]];
    if ('vendor' in fields && !('contact' in fields)) {
      const clear = ids.filter(id => {
        const r = rowById(id);
        return r && r.vendor.trim() && lc(r.vendor) !== lc(fields.vendor) && savedContactOf(r.vendor, r);
      });
      if (clear.length) {
        groups = [[ids.filter(id => !clear.includes(id)), fields], [clear, { ...fields, contact: '', email: '' }]].filter(g => g[0].length);
      }
    }
    try {
      let cleared = 0;
      for (const [gIds, gFields] of groups) {
        await bulkPatch(gIds, gFields);
        if ('contact' in gFields && !('contact' in fields)) { cleared += gIds.length; gIds.forEach(id => contactTouched.delete(id)); }
      }
      // Contact + Email set on purpose: remembered under each row's vendor.
      if ('contact' in fields) ids.forEach(id => contactTouched.add(id));
      ids.forEach(id => rememberContact(rowById(id)));
      renderTable();
      updateCounts();
      toast(`Updated ${ids.length} row${ids.length === 1 ? '' : 's'}`
        + (cleared ? ` — Contact and Email cleared on ${cleared}, whose contact was the previous vendor's` : ''));
    } catch (err) {
      setSave('error');
      showError(`Procurement: the bulk change could not be saved (${err.message}).`);
    }
  }

  // ── Create PO from selected ─────────────────────────────────────────
  function choose(title, html, options) {
    return new Promise(resolve => {
      const m = modal(title, `${html}<div style="margin-top:0.8rem">${options.map((o, i) =>
        `<button type="button" class="btn ${o.cls || 'btn-ghost'} fctproc-b fctproc-choice" data-choice="${i}">${esc(o.label)}</button>`).join('')}</div>`);
      let done = false;
      m.onClose = () => { if (!done) { done = true; resolve(null); } };
      m.body.addEventListener('click', e => {
        const b = e.target.closest('[data-choice]');
        if (!b) return;
        done = true;
        resolve(options[+b.dataset.choice].value);
        m.close();
      });
    });
  }

  // One "Create PO from selected" at a time: a second click while the first
  // is still out (a cold server takes a second or two) raised a second order
  // for the same rows — with the same number, since neither was on the list
  // yet when the next number was worked out.
  let creatingPO = false;
  function setPOButtonBusy(busy) {
    const b = st.mountEl && st.mountEl.querySelector('[data-act="bulk-po"]');
    if (!b) return;
    b.disabled = busy;
    b.textContent = busy ? 'Creating PO…' : 'Create PO from selected';
  }
  async function createPOFromSelected() {
    if (!canEdit() || creatingPO) return;
    creatingPO = true;
    setPOButtonBusy(true);
    try { await createPOFromSelectedNow(); } finally {
      creatingPO = false;
      setPOButtonBusy(false);
    }
  }
  /**
   * A PO's title, from the rows it is raised for — what it buys, by the name
   * the sheet shows: one row's Material (when the page shows that column — a
   * hidden one is text the PM can neither see nor correct), else its Sub
   * Code, else its Cost Code; several rows that all carry one Material, that
   * name; any other several, the vendor's materials. Never blank: a
   * hand-added row with no code made a PO with no title.
   */
  function poTitle(g, vendor) {
    const one = g.rows.length === 1 ? g.rows[0] : null;
    const own = r => (colHidden('description') ? '' : str(r.description).trim());
    const desc = one ? own(one) : '';
    if (one && (desc || g.sub_code || g.cost_code)) return desc || g.sub_code || g.cost_code;
    // Several rows that are all one named material (a delivery split in two).
    const names = g.rows.map(own);
    if (names.length > 1 && names[0] && names.every(n => lc(n) === lc(names[0]))) return names[0];
    return vendor ? `${vendor} materials` : (g.sub_code || g.cost_code || 'Materials');
  }
  async function createPOFromSelectedNow() {
    if (![...st.selected].some(id => rowById(id))) return;
    // Whether a row is already on an order is decided on the order list as
    // stored, not on the page's copy, which can be a minute or more behind
    // (a colleague's order, a supplier renamed since): a stale copy raised a
    // second order for rows already on one, without asking. A read that
    // fails leaves the list in hand.
    await refreshPOs();
    const ctx = makeCtx();
    let rows = sortRows([...st.selected].map(rowById).filter(Boolean), ctx);
    if (!rows.length) return;
    const explain = msg => { toast(msg, 'error'); };
    if (typeof cfg.createPurchaseOrder !== 'function') { explain('Purchase orders cannot be created from here.'); return; }
    // The page holds a purchase-order change the stored list does not have
    // yet (a save that failed and is owed), so the stored list was not read:
    // deciding on the page's copy raised a second order, with the same
    // number, for rows a colleague had already ordered.
    if (typeof cfg.poListUnsaved === 'function' && cfg.poListUnsaved()) {
      explain('A purchase-order change on this page has not been saved yet, so whether these rows are already on an order cannot be checked. No PO was created — try again once it has saved (the page retries every minute).');
      return;
    }
    if (!ctx.poLoaded) { explain(ctx.poFailed ? 'The purchase orders could not be read from the server, so no PO can be raised from here yet. The page tries again every minute.' : 'The purchase orders are still loading — try again in a moment.'); return; }
    if (rows.some(r => !isOpenJob(r.project_id))) { explain('Every selected row has to be on a job that is open.'); return; }

    // A row already on a PO — linked, or matched automatically — is material
    // that is already ordered: a second PO for it is a duplicate order, and
    // the link moving to the new one leaves the old PO with nothing on it.
    // So that is asked, never done quietly. A row several POs match is on
    // one of them; the PM picks which in the PO # column.
    const eps = new Map(rows.map(r => [r.id, effectivePO(r, ctx)]));
    const onPO = rows.filter(r => ['linked', 'auto'].includes(eps.get(r.id).kind));
    const multi = rows.filter(r => eps.get(r.id).kind === 'multiple');
    if (onPO.length || multi.length) {
      const free = rows.filter(r => !onPO.includes(r) && !multi.includes(r));
      const nums = [...new Set(onPO.map(r => str(eps.get(r.id).po.po_number) || '(no number)'))];
      const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
      const said = [];
      if (onPO.length) {
        said.push(`<b>${onPO.length}</b> of the ${n(rows.length, 'selected row', 'selected rows')} ${onPO.length === 1 ? 'is' : 'are'} already on `
          + `<b>${nums.slice(0, 4).map(esc).join(', ')}</b>${nums.length > 4 ? ` and ${nums.length - 4} more` : ''}.`);
      }
      if (multi.length) {
        said.push(`<b>${multi.length}</b> ${multi.length === 1 ? 'matches' : 'match'} several existing POs — pick the right one in the PO # column instead.`);
      }
      const opts = [];
      if (free.length) opts.push({ value: 'free', cls: 'btn-green', label: `Only the ${n(free.length, 'row', 'rows')} with no PO` });
      opts.push({ value: 'all', label: `Create a new PO anyway, for all ${n(rows.length, 'row', 'rows')}` });
      opts.push({ value: null, label: 'Cancel' });
      const pick = await choose('Create purchase order',
        said.map(t => `<p style="margin:0 0 0.45rem;line-height:1.5">${t}</p>`).join(''), opts);
      if (!pick) return;
      if (pick === 'free') rows = free;
    }
    const vendors = [...new Map(rows.filter(r => r.vendor.trim()).map(r => [lc(r.vendor), r.vendor.trim()])).values()];
    if (vendors.length > 1) {
      explain(`The selected rows have ${vendors.length} different vendors (${vendors.slice(0, 3).join(', ')}${vendors.length > 3 ? '…' : ''}). A PO has one supplier — select one vendor's rows.`);
      return;
    }
    if (vendors.length === 1 && rows.some(r => !r.vendor.trim())) {
      explain(`Some selected rows have no vendor yet. Set it to ${vendors[0]} (or leave every row blank) first.`);
      return;
    }
    const vendor = vendors[0] || '';
    const k = keyFn(ctx);
    // A PO is one job's: it books its cost to that job. Rows from several
    // jobs of a site (one supplier, one quote, bought at one time) make one
    // PO per job, so each field carries its own cost.
    const jobs = [...new Set(rows.map(r => String(r.project_id || st.projectId)))];
    const byCode = new Map();
    rows.forEach(r => {
      const c = liveCodes(r, ctx);
      const pid = String(r.project_id || st.projectId);
      const key = pid + '##' + ck(k, c.cost_code) + '||' + ck(k, c.sub_code);
      if (!byCode.has(key)) byCode.set(key, { project_id: pid, cost_code: c.cost_code, sub_code: c.sub_code, rows: [] });
      byCode.get(key).rows.push(r);
    });
    let plan = [...byCode.values()];
    if (jobs.length > 1) {
      // Asked every time: this raises an order on each job.
      const n = (k2, one, many) => `${k2} ${k2 === 1 ? one : many}`;
      const names = jobs.map(pid => `<b>${esc(jobName(pid))}</b> (${n(rows.filter(r => String(r.project_id) === pid).length, 'row', 'rows')})`);
      const perJob = jobs.map(pid => {
        const mine = plan.filter(g => g.project_id === pid);
        const top = mine.slice().sort((a, b) => b.rows.length - a.rows.length)[0];
        return { project_id: pid, cost_code: top.cost_code, sub_code: top.sub_code, rows: [].concat(...mine.map(g => g.rows)) };
      });
      const opts = plan.length > jobs.length
        ? [{ value: 'per', cls: 'btn-green', label: `One PO per job and sub code (recommended — a PO books its cost to one sub code) — ${plan.length} POs` },
           { value: 'one', label: `One PO per job, each coded to that job's main sub code — ${jobs.length} POs` }]
        : [{ value: 'per', cls: 'btn-green', label: `Create ${jobs.length} POs, one per job` }];
      opts.push({ value: null, label: 'Cancel' });
      const pick = await choose('Create purchase orders',
        `<p style="margin:0 0 0.45rem;line-height:1.5">The ${rows.length} selected rows are on <b>${jobs.length}</b> jobs: ${names.join(', ')}.</p>`
        + `<p style="margin:0;line-height:1.5">Each job gets its own PO${vendor ? ` to ${esc(vendor)}` : ''}, so each job's cost stays on that job.</p>`, opts);
      if (!pick) return;
      if (pick === 'one') plan = perJob;
    } else if (plan.length > 1) {
      const top = plan.slice().sort((a, b) => b.rows.length - a.rows.length)[0];
      const name = [top.cost_code, top.sub_code].filter(Boolean).join(' / ') || 'no code';
      const pick = await choose('Create purchase order',
        `<p style="margin:0;line-height:1.5">The ${rows.length} selected rows span <b>${plan.length}</b> sub codes.</p>`, [
          { value: 'per', cls: 'btn-green', label: `One PO per sub code (recommended — a PO books its cost to one sub code) — ${plan.length} POs` },
          { value: 'one', label: `One PO for all, coded to ${name}` },
          { value: null, label: 'Cancel' },
        ]);
      if (!pick) return;
      if (pick === 'one') plan = [{ project_id: top.project_id, cost_code: top.cost_code, sub_code: top.sub_code, rows }];
    }
    const made = [];
    for (const g of plan) {
      const quotes = [...new Set(g.rows.map(r => r.quote_number.trim()).filter(Boolean))];
      const seed = {
        project_id: g.project_id,
        cost_code: g.cost_code,
        sub_code: g.sub_code,
        supplier: vendor,
        title: poTitle(g, vendor),
        notes: quotes.length === 1 ? `Quote ${quotes[0]}` : '',
      };
      let po = null;
      try { po = await cfg.createPurchaseOrder(seed); } catch (err) { console.warn('[procurement] createPurchaseOrder failed', err); }
      if (!po || !po.id) {
        showError(made.length ? `Procurement: ${made.length} PO${made.length === 1 ? ' was' : 's were'} created, but the next one could not be.`
          : 'Procurement: the purchase order could not be created.');
        break;
      }
      try {
        await bulkPatch(g.rows.map(r => r.id), { po_id: String(po.id), po_auto: true });
        made.push(po);
      } catch (err) {
        setSave('error');
        showError(`Procurement: ${str(po.po_number) || 'the PO'} was created but the rows could not be linked to it (${err.message}).`);
        break;
      }
    }
    if (made.length) {
      st.selected.clear();
      renderBulk();
      renderTable();
      updateCounts();
      toast(made.length === 1 ? `Created ${str(made[0].po_number) || 'the PO'} and linked ${rows.length} row${rows.length === 1 ? '' : 's'}`
        : `Created ${made.length} POs${jobs.length > 1 ? `, each on its own job` : ''} (${made.map(p => str(p.po_number)).join(', ')})`);
    }
  }

  // ── Export ──────────────────────────────────────────────────────────
  function shownInOrder(ctx) {
    const rows = visibleRows(ctx);
    if (st.grouping === 'none') return rows;
    return groupRows(rows, ctx).flatMap(g => g.rows);
  }
  // Without the PO list, every row on a PO would go into the file as Not
  // Ordered with no Date Ordered — a sheet that says the opposite of what
  // is true, and gets mailed on. The list is read again on the page's poll.
  function exportBlocked(ctx) {
    if (ctx.poLoaded) return false;
    toast(ctx.poFailed
      ? 'The purchase orders could not be read from the server, so the export would show ordered rows as not ordered. The page tries again every minute — export once the PO # column stops showing "…".'
      : 'The purchase orders have not loaded yet, so the export would show ordered rows as not ordered. Try again once they have (the PO # column stops showing "…").', 'error');
    return true;
  }
  function exportRows(kind) {
    if (st.loadState !== 'ok') return;
    const ctx = makeCtx();
    if (exportBlocked(ctx)) return;
    const rows = shownInOrder(ctx);
    if (kind === 'csv') download(new Blob([buildCsv(rows, ctx)], { type: 'text/csv;charset=utf-8' }), exportName('csv'));
    else download(buildXlsx(rows, ctx), exportName('xlsx'));
  }

  /**
   * Print / PDF: the rows shown (search and filters apply; a folded section
   * prints whole), in their sections, as a light page in a new window that
   * opens the print dialog — where "Save as PDF" makes the file, the way
   * every other report on the page does. Written through dwWrite, so it
   * carries the DataWatch header like them (report-branding.js).
   */
  function printRows() {
    if (st.loadState !== 'ok') return;
    const ctx = makeCtx();
    if (exportBlocked(ctx)) return;
    // Opened here, in the click, or the browser blocks it as a pop-up.
    const win = window.open('', '_blank');
    if (!win) { toast('Allow pop-ups for this site to print or save a PDF.', 'error'); return; }
    const write = typeof window.dwWrite === 'function' ? window.dwWrite : (w, ...c) => w.document.write(...c);
    write(win, buildPrintHtml(ctx));
    win.document.close();
  }

  function buildPrintHtml(ctx, { printedAt = new Date() } = {}) {
    const rows = visibleRows(ctx);
    const groups = st.grouping === 'none' ? [{ key: '', label: '', meta: '', rows }] : groupRows(rows, ctx);
    // What a section's header already says is not repeated on every row
    // (on a site's sheet by cost code, the job's heading says the job).
    const drop = st.grouping === 'cost' ? ['Cost Code', 'Job'] : st.grouping === 'vendor' ? ['Vendor', 'Quote #'] : [];
    const cols = exportCols(ctx).filter(c => !drop.includes(c.label));
    const p = project(st.projectId) || {};
    const site = !!ctx.site;
    const name = site ? siteLabel(st.projectId) : str(p['project-name']) || 'Job';
    const job = site ? '' : str(p['job-number']);
    const siteJobsLine = site ? openIds().map(pid => {
      const j = project(pid) || {};
      return projLabel(j) + (j['job-number'] ? ` (#${j['job-number']})` : '');
    }).join(' · ') : '';
    const NUM = new Set(['Quantity', 'Lead Time (days)']);
    const DATE = new Set(['Date Needed', 'Order By', 'Date Ordered', 'Date Delivered']);
    const WRAP = new Set(['Sub Code', 'Material', 'Cost Code', 'Vendor', 'Contact', 'Email', 'Notes']);
    // Short values that read wrong broken across lines (PO-/0007, Not/Ordered).
    const ONE_LINE = new Set(['Status', 'PO #', 'Sub-Contractor Agreement', 'Unit', 'Quote #']);
    let derived = false;
    const cell = (c, r) => {
      const { t, v } = c.get(r, ctx);
      let text = v == null ? '' : t === 'd' ? fmtDate(v) : c.label === 'Quantity' ? fmtQty(v) : String(v);
      // Worked out, not typed: Order By always, Date Ordered when it is the PO's.
      const calc = !!text && (c.label === 'Order By' || (c.label === 'Date Ordered' && !ymdOf(r.date_ordered)));
      if (calc) derived = true;
      const cls = [NUM.has(c.label) ? 'num' : '', DATE.has(c.label) || ONE_LINE.has(c.label) ? 'one' : '', WRAP.has(c.label) ? 'wrap' : '', calc ? 'calc' : '',
        c.label === 'Status' ? 'st-' + (text === 'Delivered' ? 'del' : text === 'Ordered' ? 'ord' : 'not') : '',
        c.label === 'Notes' && flagsOf(r, ctx).some(f => f.level === 'red') ? 'red' : c.label === 'Notes' && text ? 'amber' : ''].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${esc(text)}</td>`;
    };
    const plainCounts = list => {
      const notOrdered = list.filter(r => statusOf(r, ctx) === 'Not Ordered').length;
      const late = list.filter(r => flagsOf(r, ctx).some(f => f.level === 'red')).length;
      return `${list.length} row${list.length === 1 ? '' : 's'}${notOrdered ? ` · ${notOrdered} not ordered` : ''}${late ? ` · ${late} late` : ''}`;
    };
    // A site's sheet by cost code: a heading per job ahead of its sections.
    let lastJob = null;
    const jobHead = g => {
      if (!site || st.grouping !== 'cost' || g.pid === lastJob) return '';
      lastJob = g.pid;
      const mine = rows.filter(r => r.project_id === g.pid);
      const j = project(g.pid) || {};
      return `<tr class="job"><td colspan="${cols.length}"><b>${esc(jobName(g.pid))}</b>${j['job-number'] ? ` <span class="gm">· Job #${esc(j['job-number'])}</span>` : ''}`
        + ` <span class="gm">· ${esc(plainCounts(mine))}</span></td></tr>`;
    };
    const body = rows.length ? groups.map(g => jobHead(g) + (g.label
      ? `<tr class="grp"><td colspan="${cols.length}"><b>${esc(g.label)}</b>`
        + `${g.meta ? ` <span class="gm">· ${String(g.meta).replace(/<(?!\/?b>)[^>]*>/g, '')}</span>` : ''}`
        + ` <span class="gm">· ${esc(plainCounts(g.rows))}</span></td></tr>` : '')
      + g.rows.map(r => `<tr>${cols.map(c => cell(c, r)).join('')}</tr>`).join('')).join('')
      : `<tr><td colspan="${cols.length}" class="none">No rows to print.</td></tr>`;
    const n = { 'Not Ordered': 0, Ordered: 0, Delivered: 0 };
    rows.forEach(r => { const s = statusOf(r, ctx); if (s in n) n[s]++; });
    const late = rows.filter(r => flagsOf(r, ctx).some(f => f.level === 'red')).length;
    const shown = rows.length === st.rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'}`
      : `${rows.length} of ${st.rows.length} rows (filtered)`;
    const title = `Procurement — ${name}${job ? ` — Job #${job}` : ''}${site ? ' (site)' : ''}`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    @page { size: landscape; margin: 0.4in; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color:#111; margin:0; padding:0.5rem; }
    h1 { font-size:14pt; margin:0 0 0.15rem; }
    .sub { font-size:8.5pt; color:#555; margin:0 0 0.45rem; }
    .sum { display:flex; gap:0.5rem; flex-wrap:wrap; margin:0 0 0.55rem; font-size:8pt; }
    .sum span { border:1px solid #ccc; border-radius:999px; padding:1px 8px; }
    .sum .ord { border-color:#93c5fd; color:#1d4ed8; } .sum .del { border-color:#86efac; color:#166534; } .sum .late { border-color:#fca5a5; color:#b91c1c; }
    table { width:100%; border-collapse:collapse; font-size:7pt; }
    th { text-align:left; background:#eee; border:1px solid #bbb; padding:3px 3px; font-size:6pt; text-transform:uppercase;
         letter-spacing:0.03em; vertical-align:bottom; }
    td { border:1px solid #ddd; padding:2px 3px; vertical-align:top; }
    td.num { text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; }
    td.one { white-space:nowrap; }
    /* Whole words to a line; only a word too long for its column (an email)
       is broken. Breaking anywhere let the table squeeze Sub Code down to a
       few letters a line while empty columns kept their room. */
    td.wrap { overflow-wrap:break-word; word-break:normal; }
    td.calc { color:#555; font-style:italic; }
    td.st-ord { color:#1d4ed8; white-space:nowrap; } td.st-del { color:#166534; white-space:nowrap; } td.st-not { color:#444; white-space:nowrap; }
    td.red { color:#b91c1c; } td.amber { color:#92400e; }
    tr.grp td { background:#e8f5e9; color:#14532d; font-size:8pt; padding:4px 5px; border-top:1px solid #9ccc9c; }
    tr.grp .gm { color:#4b5563; font-weight:400; }
    tr.grp { break-after: avoid; page-break-after: avoid; }
    tr.job td { background:#14532d; color:#fff; font-size:9pt; padding:5px 6px; }
    tr.job .gm { color:#d1fae5; font-weight:400; }
    tr.job { break-after: avoid; page-break-after: avoid; }
    td.none { text-align:center; padding:2rem; color:#666; }
    tr { page-break-inside: avoid; }
    thead { display: table-header-group; }
    p.note { font-size:7pt; color:#555; margin:0.4rem 0 0; }
  </style></head><body>
  <h1>${esc(title)}</h1>
  ${site ? `<p class="sub">Jobs: ${esc(siteJobsLine)} — each job keeps its own rows, POs and costs</p>` : ''}
  <p class="sub">${esc(shown)} · printed ${esc(printedAt.toLocaleString())}</p>
  <div class="sum"><span>Not Ordered ${n['Not Ordered']}</span><span class="ord">Ordered ${n.Ordered}</span><span class="del">Delivered ${n.Delivered}</span>${late ? `<span class="late">Late ${late}</span>` : ''}</div>
  <table><thead><tr>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
  ${derived ? '<p class="note">Dates in italics are worked out, not typed: Order By is Date Needed minus Lead Time, and a Date Ordered in italics is the date the row\'s PO was raised.</p>' : ''}
  <script>window.onload = () => { window.print(); }<\/script>
  </body></html>`;
  }

  // ── Send to Procurement ─────────────────────────────────────────────
  /**
   * The job's bid as the server holds it now, or null when that cannot be
   * said (the read failed). The page's own copy (cfg.getBidLines) is what it
   * drew, and can be behind: a colleague's Procore "Replace all" not polled
   * in yet, or a boot still showing yesterday's cached copy.
   */
  async function serverBidLines(pid) {
    if (typeof cfg.getFreshBidLines !== 'function') {
      // A page that cannot read its bid again (a test, an older host) has
      // only its own copy to go by.
      try { return cfg.getBidLines(pid) || []; } catch { return null; }
    }
    try {
      const lines = await cfg.getFreshBidLines(pid);
      return Array.isArray(lines) ? lines : null;
    } catch (err) {
      console.warn('[procurement] could not read the bid', err);
      return null;
    }
  }
  /** Whether two copies of a bid have the same lines with the same codes. */
  function sameBid(a, b, codeKey) {
    const k = typeof codeKey === 'function' ? codeKey : defaultCodeKey;
    const sig = lines => (lines || []).filter(l => l && l.id != null)
      .map(l => `${l.id}\u0000${ck(k, l.cost_code)}\u0000${ck(k, l.sub_code)}`).sort().join('\u0001');
    return sig(a) === sig(b);
  }
  /**
   * The bid lines a re-link may move rows by: the page's, and only when the
   * server holds the very same ones. Disagreeing either way means the rows
   * would be moved by a bid that is not the current one — the page behind (a
   * colleague's "Replace all" not polled in yet: its re-link would put every
   * row back on the deleted lines), or ahead of a save still on its way — so
   * nothing is moved until the two agree, on a later load.
   *   { lines }                  agreed
   *   { lines: null, why }       'unread' (the server could not be asked) or
   *                              'differs'
   */
  async function bidAgreed(pid, { patience = 0 } = {}) {
    for (let tries = 0; ; tries++) {
      const server = await serverBidLines(pid);
      if (!server) return { lines: null, why: 'unread' };
      const ctx = makeCtx(pid);
      if (sameBid(server, ctx.bidLines, ctx.codeKey)) return { lines: ctx.bidLines || [], why: '' };
      // A save of this page's own that was already on its way when the bid
      // was read lands a moment later: asked again once, when worth waiting.
      if (tries >= (patience ? 1 : 0)) return { lines: null, why: 'differs' };
      await new Promise(r => setTimeout(r, patience));
    }
  }

  // The rows of a job, deleted ones included, as the checklist needs them.
  async function readAllRows(pid) {
    const data = await api('GET', '/procurement' + q({ project_id: pid, include_deleted: 1 }));
    return (data.items || []).map(normRow).filter(Boolean);
  }

  // Live rows of the job whose bid line is gone ("not on bid").
  function notOnBidRows(rows, lines) {
    const ids = new Set((lines || []).filter(l => l && l.id != null).map(l => String(l.id)));
    return (rows || []).filter(r => r && !r.deleted_at && (r.source === 'bid' || r.bid_item_id != null) && orphaned(r, ids));
  }

  const relinkWords = done => {
    const names = [...new Set(done.map(r => [r.cost_code, r.sub_code].filter(Boolean).join(' / ')).filter(Boolean))];
    return `${names.slice(0, 3).join('; ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
  };

  async function openSendModal(projectId) {
    // On a site's sheet, the checklist is one job's bid: which, the PM says.
    if (!projectId && siteMode()) {
      const picked = await pickJob('Add to Procurement', 'Bring in the bid lines of which job? Each job keeps its own rows.');
      if (!picked) return null;
      projectId = picked;
    }
    const pid = projectId || st.projectId;
    if (!pid || isSiteKey(pid)) { toast('Pick a job first.', 'error'); return null; }
    if (!(cfg.perm && cfg.perm.canEdit)) { toast('You have view-only access to Procurement.', 'error'); return null; }
    const p = project(pid);
    const jobName = p ? projLabel(p) : 'this job';
    const m = modal(`Add to Procurement — ${jobName}`, '<div style="color:var(--muted,#888);padding:1rem 0">Loading the bid lines…</div>', { wide: true });

    if (!(makeCtx(pid).bidLines || []).length) {
      m.body.innerHTML = `<div class="fctproc-empty" style="border:none">${esc(jobName)} has no bid lines yet.
        Add bid items or import a Procore estimate on the bid page first.</div>`;
      return m;
    }
    // What is offered has to be the bid the server holds: lines from a copy
    // that is behind would be sent as rows tied to lines that are gone.
    const bid = await bidAgreed(pid, { patience: 900 });
    if (bid.why === 'differs') {
      m.body.innerHTML = `<div class="fctproc-err">The bid on this page is not the one saved for ${esc(jobName)} — it has
        been changed somewhere else since this page read it, or a change made here has not reached the server.
        Reload the page, then open Add to Procurement again. Nothing was added.</div>`;
      return m;
    }

    // Re-link rows orphaned by a Procore "Replace all" before deciding what is
    // new — otherwise every line would come up as new and be sent twice. One
    // re-link at a time: the automatic one may be under way (the bid poll
    // redrew the tab), and two would PATCH the same rows twice.
    let rows, relinked = [];
    try {
      await relinkExclusive(async () => {
        rows = await readAllRows(pid);
        if (bid.lines && m.el.isConnected) {
          relinked = await applyRelinks(relinkPlan(bid.lines, rows, makeCtx(pid).codeKey), rows, pid);
          rows = rows.map(r => relinked.find(d => d.id === r.id) || r);
        }
      });
    } catch (err) {
      m.body.innerHTML = `<div class="fctproc-err">Could not read what is already in Procurement for ${esc(jobName)}: ${esc(err.message)}.
        Nothing was added.</div>`;
      return m;
    }
    if (!m.el.isConnected) return m;     // closed meanwhile
    // The server refused a re-link: its bid is no longer the one checked a
    // moment ago (replaced elsewhere in between). Same answer as above.
    if (relinked.stale) {
      m.body.innerHTML = `<div class="fctproc-err">The bid for ${esc(jobName)} was changed somewhere else just now, so this
        page's copy of it is out of date. Reload the page, then open Add to Procurement again. Nothing was added.</div>`;
      return m;
    }

    const tags = { added: '<span class="fctproc-tag">already added</span>', removed: '<span class="fctproc-tag amber" title="This line\'s row was deleted. Tick it to bring that row back.">removed earlier</span>' };
    let plan = null, entries = [];
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;align-items:center;gap:0.5rem;justify-content:flex-end;flex-wrap:wrap;padding:0.7rem 1rem;border-top:1px solid var(--border,#2a2a3a)';
    foot.innerHTML = `<span id="fctproc-send-count" style="margin-right:auto;color:var(--muted,#9ca3af)"></span>
      <span id="fctproc-send-err" style="color:var(--red,#ef4444)"></span>
      <button type="button" class="btn btn-ghost fctproc-b" data-send="cancel">Cancel</button>
      <button type="button" class="btn btn-green fctproc-b" data-send="go">Add</button>`;
    m.body.parentElement.appendChild(foot);
    const go = foot.querySelector('[data-send="go"]');
    const sync = () => {
      const n = entries.filter(en => en.checked && en.state !== 'added').length;
      const already = entries.filter(en => en.state === 'added').length;
      // Nothing starts ticked, so the checklist opens on "Nothing ticked yet"
      // and a plain (disabled) Add.
      foot.querySelector('#fctproc-send-count').textContent = (n ? `${n} line${n === 1 ? '' : 's'} ticked` : 'Nothing ticked yet')
        + (already ? ` · ${already} already in Procurement` : '');
      go.textContent = n ? `Add ${n} line${n === 1 ? '' : 's'}` : 'Add';
      go.disabled = n === 0;
    };

    // The checklist, drawn from `rows` — again after a send that failed, from
    // a fresh read, so it shows what the server now holds. Drawn again, it
    // keeps the PM's own ticks: a line still in the state it was in keeps its
    // box as the PM left it (a line they unticked is never ticked again
    // behind their back); only a line whose state moved — now "already
    // added", say — takes that state's default.
    function draw(rowsNow) {
      const before = new Map(entries.map(en => [String(en.line.id), en]));
      const lines = makeCtx(pid).bidLines || [];
      plan = sendPlan(lines, rowsNow, makeCtx(pid).codeKey);
      entries = plan.groups.flatMap(g => g.lines);
      entries.forEach(en => {
        const was = before.get(String(en.line.id));
        if (was && was.state === en.state && en.state !== 'added') en.checked = was.checked;
      });
      const off = notOnBidRows(rowsNow, lines);
      const offNames = [...new Set(off.map(r => [r.cost_code, r.sub_code].filter(Boolean).join(' / ') || '(no code)'))];
      m.body.innerHTML = `
        <p style="margin:0 0 0.7rem;line-height:1.5;color:var(--muted,#9ca3af)">
          Tick the bid lines to track — nothing starts ticked (a section's <b>All</b> ticks every line in it).
          Each one becomes a row with the bid's cost code, sub code, quantity and unit.
          Adding again later only adds lines; it never changes rows already there.
          ${colHidden('description') ? '' : `On the sheet, <b>Material</b> names what this job actually buys (it reads as the sub code until you do),
          and <b>+ Material</b> breaks a line into the several things bought for it — the cost still books to the line.`}</p>
        ${relinked.length ? `<p style="margin:0 0 0.7rem;color:var(--green,#22c55e)">Re-linked ${relinked.length} row${relinked.length === 1 ? '' : 's'}
          to the current bid line${relinked.length === 1 ? '' : 's'} with the same cost and sub code (${esc(relinkWords(relinked))}).</p>` : ''}
        ${bid.why === 'unread' ? `<p style="margin:0 0 0.7rem;color:#fbbf24">The bid could not be checked against the server just now,
          so no rows were re-linked to it.</p>` : ''}
        ${off.length ? `<p class="fctproc-send-off" style="margin:0 0 0.7rem;line-height:1.5;color:#fbbf24">
          ${off.length} row${off.length === 1 ? ' on this job is' : 's on this job are'} <b>not on the bid</b>:
          ${esc(offNames.slice(0, 6).join('; '))}${offNames.length > 6 ? ` and ${offNames.length - 6} more` : ''}.
          Lines with the same codes are marked — tick one only for a material that has no row yet.</p>` : ''}
        ${plan.groups.map((g, gi) => `
          <div class="fctproc-send-grp">
            <div class="fctproc-send-h"><span>${esc(g.cost_code || 'No cost code')}</span>
              <span class="gm">${g.lines.length} line${g.lines.length === 1 ? '' : 's'}</span><span class="fctproc-spacer"></span>
              <button type="button" class="fctproc-link" data-sall="${gi}">All</button><button type="button" class="fctproc-link" data-snone="${gi}">None</button></div>
            ${g.lines.map(en => {
              const i = entries.indexOf(en);
              const qty = en.line.quantity == null ? '' : fmtQty(en.line.quantity);
              const tag = tags[en.state] || (en.hint ? `<span class="fctproc-tag amber" title="${esc(en.orphans
                ? 'Rows with this cost and sub code are already on this job, kept from an earlier bid. Adding this line gives it another row.'
                : 'A row added by hand is already coded to this line. Adding it brings in the bid\'s own row as well.')}">${esc(en.hint)}</span>` : '');
              return `<label class="fctproc-send-line ${en.state}${en.hint ? ' hinted' : ''}">
                <input type="checkbox" data-si="${i}" ${en.checked ? 'checked' : ''} ${en.state === 'added' ? 'disabled' : ''}>
                <span class="sub" title="${esc(en.line.sub_code)}">${esc(en.line.sub_code || '(no sub code)')}</span>
                <span class="qty">${esc([qty, normUnit(en.line.unit)].filter(Boolean).join(' '))}</span>${tag}</label>`;
            }).join('')}
          </div>`).join('')}`;
      sync();
    }
    draw(rows);

    m.body.addEventListener('change', e => {
      const i = e.target.dataset.si;
      if (i == null || !entries[+i]) return;
      entries[+i].checked = e.target.checked;
      sync();
    });
    m.body.addEventListener('click', e => {
      const all = e.target.closest('[data-sall]'), none = e.target.closest('[data-snone]');
      if (!all && !none) return;
      const g = plan.groups[+(all ? all.dataset.sall : none.dataset.snone)];
      if (!g) return;
      g.lines.forEach(en => { if (en.state !== 'added') en.checked = !!all; });
      m.body.querySelectorAll('[data-si]').forEach(cb => { cb.checked = entries[+cb.dataset.si].checked; });
      sync();
    });
    foot.querySelector('[data-send="cancel"]').addEventListener('click', () => m.close());

    // The sheet behind, brought to what the server holds.
    const reloadSheet = () => { if (isOpenJob(pid) && isMounted() && st.loadState === 'ok') load(st.projectId, { quiet: true }); };

    let sending = false;
    go.addEventListener('click', async () => {
      if (sending) return;
      const picked = entries.filter(en => en.checked && en.state !== 'added');
      if (!picked.length) return;
      const items = picked.filter(en => en.state === 'new').map(en => ({
        id: uid(),
        bid_item_id: String(en.line.id),
        cost_code: str(en.line.cost_code),
        sub_code: str(en.line.sub_code),
        quantity: numOrNull(en.line.quantity),
        unit: str(en.line.unit),
      }));
      // A row deleted before a "Replace all" comes back tied to the line that
      // replaced its old one ({ id, bid_item_id, cost_code, sub_code }); the
      // rest come back as they were (just the id).
      const restoreIds = picked.filter(en => en.state === 'removed' && en.restoreId)
        .map(en => (en.relink ? { id: en.restoreId, ...en.relink } : en.restoreId));
      sending = true;
      go.disabled = true;
      go.textContent = 'Adding…';
      const errBox = foot.querySelector('#fctproc-send-err');
      errBox.textContent = '';
      try {
        const data = await api('POST', '/procurement' + q({ action: 'send' }), { project_id: pid, items, restore_ids: restoreIds });
        m.close();
        const created = data.created || [], restored = data.restored || [];
        // Land the user on the job they just sent: the tab state switches to
        // it, and the page (listening for the event) switches to the tab. A
        // site's sheet the job is on stays open.
        if (isOpenJob(pid)) {
          created.concat(restored).forEach(adoptServerRow);
          if (isMounted()) { renderTable(); updateCounts(); }
          // A line brought back on its bid line's replacement can come back
          // under a new cost code, and its files with it. (A new line has
          // nothing attached yet.)
          recountAfterRecode(pid, restored.map(r => r && r.id).filter(Boolean));
          // Fewer rows came back than were ticked: they were there already —
          // an earlier try whose answer was lost, or a colleague's send. The
          // sheet reads them, rather than waiting for the next poll.
          if (created.length + restored.length < picked.length) reloadSheet();
        } else {
          selectProjectQuietly(pid);
        }
        const n = created.length + restored.length;
        const already = picked.length - n;
        toast(n
          ? `Added ${n} line${n === 1 ? '' : 's'} to Procurement${already > 0 ? ` (${already} ${already === 1 ? 'was' : 'were'} already there)` : ''}`
          : `${already === 1 ? 'That line was' : `All ${already} lines were`} already in Procurement — nothing new was added.`);
        window.dispatchEvent(new CustomEvent('fct:procurement-sent', { detail: { projectId: pid, created: created.length, restored: restored.length } }));
      } catch (err) {
        // Whatever happened on the server (an answer lost on the way back is
        // a send that DID happen), the checklist and the sheet are read
        // again, so the next click is decided on what is there now — and the
        // message says what that read shows, not what the error suggests.
        let reread = false, landed = 0;
        try {
          const fresh = await readAllRows(pid);
          if (m.el.isConnected) {
            draw(fresh);
            reread = true;
            // A ticked line now "already added" went in: a new line has its
            // row, a "removed earlier" one is back.
            const pickedIds = new Set(picked.map(en => String(en.line.id)));
            landed = entries.filter(en => pickedIds.has(String(en.line.id)) && en.state === 'added').length;
          }
        } catch (e2) { console.warn('[procurement] could not read the checklist again', e2); }
        reloadSheet();
        sending = false;
        if (m.el.isConnected) {
          sync();
          const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
          let text, good = false;
          if (err.status === 409) {
            // A 409 says itself which line, and that nothing was sent.
            text = `${err.message} The list above has been read again.`;
          } else if (reread && landed && landed === picked.length) {
            good = true;
            text = `They were added after all: ${n(landed, 'line is', 'lines are')} now in Procurement, shown above as `
              + `"already added". Only the server's answer was lost on the way back — ${err.message}.`;
          } else if (reread && landed) {
            text = `${landed} of the ${n(picked.length, 'line', 'lines')} you ticked ${landed === 1 ? 'is' : 'are'} now in Procurement; `
              + `the server's answer was lost — ${err.message}. The list above has been read again — check it before adding the rest.`;
          } else if (reread) {
            text = `Not added: ${err.message}. The list above has been read again — check it before trying again.`;
          } else {
            text = `The lines may not have been added (${err.message}), and the list could not be read again to check. `
              + 'Close this and open Add to Procurement again before trying again — lines already in Procurement show as "already added".';
          }
          const box = foot.querySelector('#fctproc-send-err');
          box.textContent = text;
          box.style.color = good ? 'var(--green,#22c55e)' : 'var(--red,#ef4444)';
        }
      }
    });
    return m;
  }

  // ── Re-linking after a Procore "Replace all" ────────────────────────
  // Re-links already tried this session ("row>line", or "row>line:codes" for
  // a code sync), so a PATCH the server refuses is not sent again on every
  // poll. A row's entries are forgotten when its line changes underneath the
  // page (adoptServerRow), so a row moved elsewhere can be put right here.
  const relinkTried = new Set();
  const tryKey = p => `${p.id}>${p.bid_item_id}${p.sync ? `:${p.cost_code}\u0000${p.sub_code}` : ''}`;
  function forgetRelinks(rowId) {
    const pre = `${rowId}>`;
    [...relinkTried].forEach(k => { if (k.startsWith(pre)) relinkTried.delete(k); });
  }
  let relinking = null;
  // Run `fn` with no other re-link pass going (see openSendModal).
  async function relinkExclusive(fn) {
    while (relinking) { try { await relinking; } catch { /* warned where it failed */ } }
    let release;
    const mine = new Promise(r => { release = r; });
    relinking = mine;
    try { return await fn(); } finally {
      if (relinking === mine) relinking = null;
      release();
    }
  }

  /**
   * PATCH each planned re-link (relinkPlan) or code sync (codeSyncPlan).
   * Returns the rows as the server now has them. The open job's table is
   * redrawn when any moved: the poll's change check would not do it, since
   * the rows on screen are already the new versions by then.
   */
  async function applyRelinks(plan, rows, pid) {
    const done = [], synced = new Set();
    let stale = false;
    for (const rl of plan) {
      relinkTried.add(tryKey(rl));
      try {
        const data = await api('PATCH', '/procurement' + q({ id: rl.id }),
          { fields: rl.sync ? { cost_code: rl.cost_code, sub_code: rl.sub_code }
            : { bid_item_id: rl.bid_item_id, cost_code: rl.cost_code, sub_code: rl.sub_code } });
        const before = (rows || []).find(r => r.id === rl.id) || {};
        const item = normRow(data.item) || { ...before, bid_item_id: rl.bid_item_id, cost_code: rl.cost_code, sub_code: rl.sub_code };
        if (rl.sync) synced.add(item);
        done.push(item);
        if (isOpenJob(pid)) adoptServerRow(item);
      } catch (err) {
        // The line is not on the bid the server holds NOW: the bid moved
        // since it was checked (a colleague's Replace all landing in between).
        // Nothing more is moved by a bid that is not the current one, and
        // nothing is marked tried — once the page has the new bid, it looks
        // again.
        if (err.code === 'stale_bid') {
          relinkTried.delete(tryKey(rl));
          stale = true;
          break;
        }
        console.warn('[procurement] re-link failed for', rl.id, err);
      }
    }
    if (done.length && isOpenJob(pid) && isMounted()) {
      if (cellInUse()) redrawAround(); else { renderTable(); updateCounts(); }
    }
    // Every one of these PATCHes carries the line's codes: its files may
    // have moved to another cost code's folder.
    if (done.length && isOpenJob(pid)) recountAfterRecode(pid, done.map(d => d.id));
    // The code syncs are housekeeping; what is reported is what moved.
    const moved = done.filter(d => !synced.has(d));
    moved.stale = stale;
    return moved;
  }

  /**
   * The re-link, run as soon as a job's rows are read rather than only when
   * someone opens Send to Procurement: a Procore "Replace all" answered "no"
   * to "Send the bid lines now?" (or done by a colleague) would otherwise
   * leave every row of the job "not on bid", out of bid order and with its
   * codes frozen, until somebody happened to open the checklist. It also
   * keeps each row's stored codes up to its line's (codeSyncPlan).
   *
   * Only against the bid the server holds, and only while the page holds
   * that same bid (bidAgreed): a page whose copy is behind — a colleague's
   * Replace all not polled in yet, a boot drawn from yesterday's cache, a
   * bid read that failed once — would otherwise "re-link" every row back to
   * the lines that were replaced. The rows on screen are only the live ones,
   * and the bid-line rule counts deleted rows too, so the plan is made again
   * off the full list (include_deleted) before anything is sent.
   */
  function autoRelink(pid) {
    if (relinking || !canEdit() || !isOpenJob(pid) || st.loadState !== 'ok') return relinking;
    const ctx = makeCtx(pid);
    if (!ctx.bidLines.length) return null;
    const untried = p => !relinkTried.has(tryKey(p));
    const plans = (lines, rows, k) => relinkPlan(lines, rows, k).concat(codeSyncPlan(lines, rows, k));
    // Only this job's rows: on a site's sheet the others' are matched against
    // their own bids, never this one.
    const looks = plans(ctx.bidLines, st.rows.filter(r => r.project_id === pid), ctx.codeKey).filter(untried);
    if (!looks.length) return null;
    relinking = (async () => {
      const bid = await bidAgreed(pid);
      // Not agreed (or not known): nothing is marked tried, so the next load
      // looks again — by then the page has caught up.
      if (!bid.lines || !isOpenJob(pid)) return;
      let all;
      try { all = await readAllRows(pid); } catch (err) { console.warn('[procurement] re-link check failed', err); return; }
      if (!isOpenJob(pid)) return;
      const now = makeCtx(pid);
      // The bid moved while the rows were read — on this page, or on the
      // server (a colleague's Replace all landing while the read was out):
      // asked again, and nothing moves unless the two still agree. The
      // server checks each line once more as it is written (stale_bid).
      if (!sameBid(bid.lines, now.bidLines, now.codeKey)) return;
      const again = await bidAgreed(pid);
      if (!again.lines || !isOpenJob(pid) || !sameBid(again.lines, bid.lines, now.codeKey)) return;
      const plan = plans(now.bidLines, all, now.codeKey).filter(untried);
      const done = await applyRelinks(plan, all, pid);
      // Looked at, whatever the full list says: one the deleted rows rule out
      // stays ruled out, and is not read for again on every poll. Not when
      // the server said the bid had moved: then it is all looked at again.
      if (done.stale) {
        looks.concat(plan).forEach(p => relinkTried.delete(tryKey(p)));
        return;
      }
      looks.forEach(p => relinkTried.add(tryKey(p)));
      if (done.length && isOpenJob(pid) && isMounted()) {
        toast(`Re-linked ${done.length} row${done.length === 1 ? '' : 's'} to the current bid line${done.length === 1 ? '' : 's'} `
          + `with the same cost and sub code (${relinkWords(done)}) — the bid's lines were replaced.`);
      }
    })().finally(() => { relinking = null; });
    return relinking;
  }
  // A site's jobs, one after the other: one re-link pass runs at a time.
  async function autoRelinkAll(ids) {
    for (const pid of ids) {
      try { await autoRelink(pid); } catch (err) { console.warn('[procurement] re-link failed', err); }
    }
  }
  /**
   * A site's sheet whose jobs changed under it (Show all jobs ticked, a field
   * marked complete, the Site typed on another job): read again as the sheet
   * it now is. Typed edits go first; ticks on rows no longer there go.
   */
  function reloadSite() {
    flushAll();
    st.forceShow.clear();
    st.confirmDel = null;
    st.bulkConfirmDel = false;
    load(st.projectId);
  }

  // Point the tab at a job without drawing anything yet — the page is about
  // to open the tab, and renderTab loads it then.
  function selectProjectQuietly(pid) {
    if (isMounted()) { selectProject(pid); return; }
    st.projectId = pid;
    storeSet('project', pid);
    st.rows = [];
    st.loadedFor = null;
    st.loadState = 'none';
    st.selected.clear();
    st.filters = {};
    st.search = '';
  }

  // ── Public API ──────────────────────────────────────────────────────
  window.FCTProcurement = {
    configure(opts) {
      cfg = { ...cfg, ...(opts || {}) };
    },

    /** Draw the whole tab (job picker + table) into `el`. */
    renderTab(el) {
      if (!el) return;
      st.mountEl = el;
      wire(el);
      loadPrefs();
      if (!(cfg.perm && cfg.perm.canView)) {
        injectStyles();
        el.innerHTML = '<div class="fctproc"><div class="fctproc-empty">You do not have access to Procurement.</div></div>';
        return;
      }
      if (st.projectId && !keyExists(st.projectId) && projects().length) {
        st.projectId = null;
        storeSet('project', null);
      }
      // The contact pickers read from the shared cache.
      contacts.load().catch(err => console.warn('[procurement] contacts did not load', err));
      const cached = st.projectId && st.loadedFor === viewSig() && st.loadState === 'ok';
      if (st.projectId && !cached) st.loadState = 'loading';
      renderShell();
      if (st.projectId) load(st.projectId, { quiet: cached });
    },

    /**
     * Redraw from what is in memory (POs or the bid changed, or the page's
     * attachment counts — every paperclip and folder chip is drawn from them
     * as it is drawn). No fetch.
     */
    rerender() {
      if (!isMounted()) return;
      // A press in the sheet is down (on a button, a header, a checkbox). The
      // press moved focus out of a cell, and what that let through (a PO
      // save's answer held while the cell had focus) asks for this redraw:
      // drawn now, the button under the pointer is replaced before it comes
      // up, and the click — Add Row, Create PO, an export — lands on nothing.
      // Drawn once the button is up instead (onDocMouseUp), as redrawWhenFree
      // is.
      if (pressedAt && Date.now() - pressedAt < 5000) { rerenderOwed = true; return; }
      rerenderOwed = false;
      const a = document.activeElement;
      // The job list moved under us: a rename shows in the picker, and a job
      // deleted elsewhere gets the "no longer on the list" note, not a table.
      const picker = st.mountEl.querySelector('#fctproc-proj');
      const known = keyExists(st.projectId);
      if (picker && picker !== a && known) { picker.value = openLabel(); picker.dataset.cbValue = st.projectId; }
      if (st.projectId && !known) { renderBody(); return; }
      // A site whose jobs changed (a field finished, a Site typed on another
      // job) is read again as the sheet it now is.
      if (siteMode() && st.loadState === 'ok' && st.loadedFor !== viewSig()) { reloadSite(); return; }
      // The bid changed under the open job (a line renamed, a Replace all):
      // rows re-link and their stored codes follow now, not at the next read.
      // autoRelink checks the bid with the server first, and does nothing
      // when there is nothing to do.
      if (st.projectId && st.loadState === 'ok' && st.loadedFor === viewSig()) {
        if (siteMode()) autoRelinkAll(openIds()); else autoRelink(st.projectId);
      }
      if (cellInUse()) {
        // Someone is in a cell: redraw every row around it, not the table.
        redrawAround();
        return;
      }
      // The table is redrawn in place only when it is on screen; a body that
      // was showing a note (job list still loading, say) is drawn afresh.
      if (st.loadState === 'ok' && st.mountEl.querySelector('#fctproc-wrap')) {
        renderHead();
        renderTable();
        updateCounts();
        // The bulk bar is left alone while it is being typed in (its value
        // box, a Vendor menu open): drawn again, the box would lose focus
        // and the keys typed next would go nowhere. Its PO list catches up
        // the next time it is drawn. A focused button ("Apply to N", say)
        // is no reason to keep a stale bar: it is drawn again and the same
        // button gets focus back.
        const bulk = st.mountEl.querySelector('#fctproc-bulk');
        const inBulk = bulk && a && bulk.contains(a);
        if (!inBulk) renderBulk();
        else if (!/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) {
          const act = a.dataset && a.dataset.act;
          renderBulk();
          const again = act && bulk.querySelector(`[data-act="${cssEsc(act)}"]`);
          if (again) again.focus();
        }
      } else renderBody();
    },

    /** Re-read the open job's rows (the page's poll). Skipped mid-edit. */
    async refresh() {
      if (!isMounted() || !st.projectId || st.loadState === 'loading') return;
      const a = document.activeElement;
      const editing = a && st.mountEl.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)
        && (a.dataset.pr || (a.closest && a.closest('#fctproc-bulk')));
      if (editing) return;
      if (pend.size) await flushAll();
      // A site whose jobs changed since is a new sheet, read as one.
      await load(st.projectId, { quiet: st.loadState === 'ok' && st.loadedFor === viewSig() });
    },

    /**
     * Read the open job's attachment counts again (through the page's
     * refreshAttachmentCounts) and redraw the paperclips and folder chips
     * whose number changed. No rows are read. The page calls it once a
     * document has been attached, detached or deleted. Resolves true once
     * the counts were read and drawn, false otherwise; never rejects.
     */
    refreshAttachmentCounts() {
      if (!st.projectId || st.loadedFor !== viewSig()) return Promise.resolve(false);
      // Every job of a site's sheet: true once all of them were read and drawn.
      const ids = openIds();
      if (ids.length === 1) return refreshDocCounts(ids[0]);
      return Promise.all(ids.map(refreshDocCounts)).then(r => r.length > 0 && r.every(Boolean));
    },

    openSendModal,
    cbOptions,
    cbFilter,
    contacts,

    // Pure helpers, for scripts/test-procurement-frontend.js.
    _test: {
      effectivePO, effectiveDateOrdered, orderBy, statusOf, flagsOf, liveCodes, bidChange,
      sendPlan, relinkPlan, codeSyncPlan, sameBid, sortRows, applyFilters, csvEscape, addDays,
      chipMatch, fieldValue, vendorCompatible, normRow, ymdOf, fmtDate, fmtQty, esc, uid, looksLikePhone,
      exportMatrix, buildCsv, xlsxParts, buildXlsx, buildPrintHtml, defaultCodeKey, makeCtx, openIds, viewSig,
      materialOf, materialOptions, loadLibrary, poTitle, lineLabel, hasPastList, addMaterial,
      recent: () => recent, setRecentMs: ms => { RECENT_MS = ms; }, bases: () => ({ bases: new Map(bases), flyBases: new Map(flyBases) }),
      library: () => lib,
      state: () => st,
      pending: () => ({ pend: new Map(pend), fly: new Map(fly), failed: new Set(failed) }),
      flushAll,
      selectProject,
    },
  };
})();
