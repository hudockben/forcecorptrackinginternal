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
 *   });
 *   FCTProcurement.renderTab(document.getElementById('procurement-root'));
 *
 * It reaches nothing of the page's beyond that cfg and the combobox globals
 * (cbHtml and friends). The page routes every combobox list key that starts
 * with 'proc_' back here, through cbOptions / cbFilter.
 *
 * Where the numbers come from:
 *   - Rows live in procurement_items through /api/procurement — one row per
 *     material, saved field by field (PATCH sends only the cells that
 *     changed, so two people editing different cells of one row never undo
 *     each other).
 *   - Cost Code / Sub Code are the bid's own. A row sent from the bid keeps
 *     the bid line's id and shows that line's CURRENT codes; the stored copy
 *     is only what it falls back to when the line is gone ("not on bid").
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
  // The bid's own unit list (tracker.html UNIT_OPTS). Free text is still
  // allowed in the Unit cell — a supplier sells by the roll, the bag, the
  // stick — this is only what the menu offers.
  const UNITS = ['SF', 'LF', 'SY', 'CY', 'TN', 'TON', 'EA', 'LS', 'HR', 'GAL', 'LB', 'AC'];
  // Lump-sum and hourly bid lines (design, mobilization, labour) almost never
  // have anything to buy, so Send to Procurement leaves them unchecked.
  const SKIP_UNITS = new Set(['LS', 'HR']);
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
  // Lookups are indexed once per ctx object; build a fresh ctx when the lists
  // behind it change (the page does, once per render).
  const _ctxIndex = new WeakMap();
  function ctxIndex(ctx) {
    let m = _ctxIndex.get(ctx);
    if (!m) {
      m = { lineById: new Map(), poById: new Map() };
      (ctx.bidLines || []).forEach(l => { if (l && l.id != null) m.lineById.set(String(l.id), l); });
      (ctx.purchaseOrders || []).forEach(p => { if (p && p.id != null) m.poById.set(String(p.id), p); });
      _ctxIndex.set(ctx, m);
    }
    return m;
  }
  const lineFor = (row, ctx) => (row && row.bid_item_id != null
    ? ctxIndex(ctx).lineById.get(String(row.bid_item_id)) || null : null);

  /** The codes a row shows: its bid line's current ones, else its stored copy. */
  function liveCodes(row, ctx) {
    const line = lineFor(row, ctx);
    if (line) return { cost_code: str(line.cost_code), sub_code: str(line.sub_code), line, notOnBid: false };
    return {
      cost_code: str(row.cost_code), sub_code: str(row.sub_code), line: null,
      // A row sent from the bid whose line has gone, or a hand-added row that
      // was coded off a bid line that has since gone. A hand-added row that
      // was never tied to a line is just a row, not a problem.
      notOnBid: row.source === 'bid' || row.bid_item_id != null,
    };
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
      flags.push({ key: 'sca_open', level: 'amber', label: 'Sub agreement open', title: 'A sub-contractor agreement is needed and not executed yet' });
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
   *   'new'      not in Procurement yet — checked unless its unit is LS or HR
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
   * A 'new' line whose material plainly has a row already starts UNTICKED,
   * with `hint` saying why, so Send never makes a second row of it by
   * default:
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
        entry = { line, state: 'new', checked: !SKIP_UNITS.has(normUnit(line.unit)), restoreId: null, rowId: null };
        const orphans = orphanRows.get(codesOf(line.cost_code, line.sub_code)) || [];
        const handRows = hand.get(id) || 0;
        if (orphans.length) {
          entry.checked = false;
          entry.orphans = orphans.slice();
          entry.hint = `${orphans.length} row${orphans.length === 1 ? '' : 's'} on this job ${orphans.length === 1 ? 'has' : 'have'} these codes but ${orphans.length === 1 ? 'is' : 'are'} not on the bid`;
        } else if (handRows) {
          entry.checked = false;
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
   * on the bid (or never was) go last.
   */
  function sortRows(rows, ctx) {
    const pos = new Map();
    (ctx.bidLines || []).forEach((l, i) => { if (l && l.id != null) pos.set(String(l.id), lineOrder(l, i)); });
    const at = r => {
      const p = r.bid_item_id != null ? pos.get(String(r.bid_item_id)) : undefined;
      return p === undefined ? Infinity : p;
    };
    const time = r => Date.parse(r.created_at) || 0;
    return (rows || []).slice().sort((a, b) => {
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
      default: return str(row[field]);
    }
  }

  const SEARCH_FIELDS = ['status', 'po', 'sca_status', 'date_needed', 'order_by', 'date_ordered', 'date_delivered',
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
  function applyFilters(rows, state, ctx) {
    const s = state || {};
    const words = lc(s.search).split(' ').filter(Boolean);
    const filters = Object.entries(s.filters || {}).filter(([, set]) => set && (set.size || set.length));
    const chip = s.chip || 'all';
    return (rows || []).filter(row => {
      for (const [field, set] of filters) {
        const v = fieldValue(row, field, ctx);
        if (!(Array.isArray(set) ? set.includes(v) : set.has(v))) return false;
      }
      if (chip !== 'all' && !chipMatch(chip, row, ctx)) return false;
      if (words.length) {
        const hay = SEARCH_FIELDS.map(f => fieldValue(row, f, ctx))
          .concat(flagsOf(row, ctx).map(f => f.label), [row.date_needed, row.date_ordered, row.date_delivered])
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
    { label: 'Cost Code', width: 24, get: (r, c) => ({ t: 's', v: liveCodes(r, c).cost_code }) },
    { label: 'Sub Code', width: 26, get: (r, c) => ({ t: 's', v: liveCodes(r, c).sub_code }) },
    { label: 'Description', width: 34, get: r => ({ t: 's', v: r.description }) },
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
    if (liveCodes(r, c).notOnBid) notes.push('Not on bid');
    const bc = bidChange(r, c);
    if (bc) notes.push(`Bid changed: ${bc.label}`);
    return notes.join('; ');
  }

  function exportMatrix(rows, ctx) {
    return {
      header: EXPORT_COLS.map(c => c.label),
      widths: EXPORT_COLS.map(c => c.width),
      rows: (rows || []).map(r => EXPORT_COLS.map(c => c.get(r, ctx))),
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
    const name = str(p['project-name']) || str(p['job-number']) || 'Job';
    const safe = name.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '-').trim();
    return `Procurement - ${safe} - ${today()}.${ext}`;
  }

  // ── Page state ──────────────────────────────────────────────────────
  const st = {
    mountEl: null,
    projectId: null,
    rows: [],
    loadState: 'none',        // 'none' | 'loading' | 'ok' | 'error'
    loadError: '',
    loadedFor: null,
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

  function makeCtx(projectId) {
    const pid = projectId === undefined ? st.projectId : projectId;
    let purchaseOrders = [], bidLines = [], poLoaded = true;
    try { purchaseOrders = cfg.getPurchaseOrders() || []; } catch { /* none */ }
    try { bidLines = pid ? (cfg.getBidLines(pid) || []) : []; } catch { /* none */ }
    try { poLoaded = typeof cfg.isPOListLoaded === 'function' ? !!cfg.isPOListLoaded() : true; } catch { poLoaded = false; }
    // Not loaded because the read FAILED (and is being retried), rather than
    // still on its way — said differently on screen.
    let poFailed = false;
    try { poFailed = !poLoaded && typeof cfg.poLoadFailed === 'function' && !!cfg.poLoadFailed(); } catch { poFailed = false; }
    return {
      purchaseOrders, bidLines, poLoaded, poFailed,
      codeKey: typeof cfg.codeKey === 'function' ? cfg.codeKey : defaultCodeKey,
      today: today(),
      projectId: pid,
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
      .fctproc-in { width:100%; box-sizing:border-box; background:transparent; border:1px solid transparent; border-radius:3px;
        color: var(--text,#e0e0e0); font: inherit; font-size:0.8rem; padding:0.14rem 0.25rem; outline:none; min-width:0; }
      .fctproc-in:hover { border-color: var(--border,#2a2a3a); }
      .fctproc-in:focus { border-color:#2563eb; background: var(--bg,#0a0a0f); box-shadow: 0 0 0 1px #2563eb33; }
      .fctproc-in[type=date] { color-scheme: dark; padding-right:0; }
      .fctproc-in[type=date]::-webkit-calendar-picker-indicator { opacity:0.45; cursor:pointer; margin-left:0.1rem; }
      .fctproc-in[type=date]:hover::-webkit-calendar-picker-indicator,
      .fctproc-in[type=date]:focus::-webkit-calendar-picker-indicator { opacity:0.9; }
      /* An empty date reads as an empty cell, not "mm/dd/yyyy", until it is
         pointed at — a column of placeholders drowns the dates that are set. */
      .fctproc-in[type=date].empty:not(:hover):not(:focus) { color: transparent; }
      .fctproc-in[type=date].empty:not(:hover):not(:focus)::-webkit-calendar-picker-indicator { opacity:0.18; }
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
      td.vendor-off .cb-input, td.vendor-off .fctproc-txt { color:#fbbf24; text-decoration: underline dotted rgba(234,179,8,0.7); text-underline-offset: 3px; }
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
      .fctproc-codes { display:flex; align-items:center; gap:0.3rem; min-width:0; }
      .fctproc-codes .fctproc-txt { flex: 1 1 auto; min-width:0; }
      .fctproc-qty { display:flex; flex-direction:column; gap:0.1rem; padding:0.1rem 0; }
      .fctproc-bidchg { display:flex; flex-direction:column; align-items:flex-end; gap:0.12rem; font-size:0.62rem; color:#fbbf24; line-height:1.25; text-align:right; }
      .fctproc-bidchg .acts { display:flex; gap:0.2rem; white-space:nowrap; }
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
      tr.fctproc-grp > td { background:#111c11; color: var(--green,#22c55e); font-weight:600; font-size:0.78rem;
        padding:0.32rem 0.6rem; border-top:2px solid #1e3a1e; border-right:none; cursor:pointer; height:auto; user-select:none;
        overflow: visible; }
      tr.fctproc-grp:hover > td { background:#162216; }
      tr.fctproc-grp .gl { position: sticky; left:0.6rem; display:inline-flex; gap:0.6rem; align-items: baseline; flex-wrap:wrap; }
      tr.fctproc-grp .tw { display:inline-block; width:0.8rem; font-size:0.65rem; }
      tr.fctproc-grp .fctproc-grpsel { margin:0 0 0 0.05rem; align-self:center; }
      tr.fctproc-grp .gm { color:#6f9a6f; font-weight:400; font-size:0.72rem; }
      tr.fctproc-grp .gm b { color:#9ccc9c; font-weight:600; }
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
    return projects()
      .filter(p => st.showAll || p.id === st.projectId || LIVE_STATUSES.has(lc(p.status)))
      .map(p => ({ value: p.id, label: projLabel(p), meta: p['job-number'] ? 'Job #' + p['job-number'] : '' }))
      .sort((a, b) => a.label.localeCompare(b.label));
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

  function cbOptions(listKey) {
    const key = String(listKey || '');
    if (key === 'proc_projects') return projectOptions();
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
      if (st.projectId && st.loadState === 'ok' && st.loadedFor === st.projectId) await load(st.projectId, { quiet: true });
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
    if (st.projectId && r.project_id && r.project_id !== st.projectId) return null;
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
    st.selected.delete(id); st.forceShow.delete(id);
    if (st.confirmDel === id) st.confirmDel = null;
  }

  /** Change one field of a row locally and queue it for saving. */
  function setField(rowId, field, value, { delay = SAVE_DELAY } = {}) {
    const row = rowById(rowId);
    if (!row || !canEdit()) return false;
    if ((field === 'contact' || field === 'email') && !sameVal(row[field], value)) contactTouched.add(row.id);
    row[field] = value;
    const inFlight = fly.get(row.id);
    const base = inFlight && field in inFlight ? inFlight[field] : (server.get(row.id) || {})[field];
    const p = pend.get(row.id) || {};
    if (sameVal(base, value)) delete p[field]; else p[field] = value;
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
    if (!p || !Object.keys(p).length) { pend.delete(rowId); return; }
    pend.delete(rowId);
    fly.set(rowId, p);
    setSave('saving');
    try {
      const data = await api('PATCH', '/procurement' + q({ id: rowId }), { fields: p }, { keepalive });
      if (fly.get(rowId) === p) fly.delete(rowId);
      failed.delete(rowId);
      if (data.item) adoptServerRow(data.item);
      refreshRow(rowId);
      updateCounts();
    } catch (err) {
      if (fly.get(rowId) === p) fly.delete(rowId);
      if (err.status === 404) {
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
      } else {
        // Keep the user's values and try again on the next edit or refresh.
        pend.set(rowId, { ...p, ...(pend.get(rowId) || {}) });
        failed.add(rowId);
        // Said here rather than left to the page's banner, which cannot tell
        // this failure (value kept, sent again) from the others (nothing kept).
        showError(`Procurement: a change could not be saved (${err.message}). It stays on screen and is sent again on your next edit.`);
      }
    }
    if (pend.has(rowId) && !failed.has(rowId)) flushRow(rowId);
    settleSave();
  }

  // What a refused value is called in the message about it.
  const FIELD_LABEL = {
    description: 'Description', quantity: 'Quantity', unit: 'Unit', sca_status: 'Sub-Contractor Agreement',
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
    if (named.includes('bid_item_id')) named = [...new Set([...named, ...['cost_code', 'sub_code'].filter(k => k in p)])];
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
      if (repick && (k === 'cost_code' || k === 'sub_code')) {
        if (!sameVal(row[k], saved[k])) carried[k] = row[k];
        return;
      }
      row[k] = saved[k];
    });
    const next = { ...rest, ...carried, ...newer };
    if (Object.keys(next).length) pend.set(rowId, next); else pend.delete(rowId);
    failed.delete(rowId);
    // The line and its codes are one pick, named as one.
    const one = named.includes('bid_item_id') ? named.filter(k => k !== 'cost_code' && k !== 'sub_code') : named;
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
    if (!quiet) {
      st.loadState = 'loading';
      st.loadError = '';
      renderBody();
    }
    const mark = touchSeq;
    try {
      const data = await api('GET', '/procurement' + q({ project_id: projectId }));
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
      items.forEach(adoptServerRow);
      const wasOk = st.loadState === 'ok' && st.loadedFor === projectId;
      st.loadState = 'ok';
      st.loadedFor = projectId;
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
      autoRelink(projectId);
    } catch (err) {
      if (gen !== loadGen) return;
      // A failed poll leaves what is on screen alone. A failed first read is
      // shown as a failure — never as an empty job, which would invite
      // someone to start re-entering rows that are really there.
      if (quiet && st.loadState === 'ok' && st.loadedFor === projectId) {
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
  // When a mouse button went down in the sheet, until it comes up (0).
  let pressedAt = 0;
  function onSheetMouseDown(e) { if (e.button === 0) pressedAt = Date.now(); }
  function onDocMouseUp() {
    if (!pressedAt) return;
    pressedAt = 0;
    if (redrawDeferred) setTimeout(redrawWhenFree, 0);
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
    return `${st.rows.length}/${rows.length}/${st.grouping}\n` + groups.map(g => (st.grouping === 'none' ? '' : `G:${g.key}|${g.label}|${g.meta}\n`)
      + (st.grouping === 'none' || !st.collapsed.has(g.key) ? g.rows.map(r => r.id).join('\n') : '')).join('\n');
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
    const p = project(st.projectId);
    const label = p ? projLabel(p) : '';
    el.innerHTML = `
      <div class="fctproc">
        <div class="fctproc-top">
          <span class="fctproc-title">Procurement</span>
          <span class="fctproc-lbl">Job</span>
          ${cbCell('proc_projects', label, 'Search jobs…',
            `id="fctproc-proj" data-cb-value="${esc(p ? p.id : '')}" aria-label="Job"`, false)}
          <label class="fctproc-check" title="List every job, not only Awarded / In Progress / Substantially Complete">
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
        <span style="font-size:0.78rem">Only live jobs are listed — tick <b>Show all jobs</b> for the rest.</span></div>`;
      return;
    }
    const p = project(st.projectId);
    if (!p) {
      // An empty list is the page still loading its jobs, not a deleted job.
      body.innerHTML = projects().length
        ? '<div class="fctproc-empty">That job is no longer on the job list. Pick another one above.</div>'
        : '<div class="fctproc-empty">Loading the job list…</div>';
      return;
    }
    if (st.loadState === 'loading' && st.loadedFor !== st.projectId) {
      body.innerHTML = `<div class="fctproc-empty">Loading procurement for ${esc(projLabel(p))}…</div>`;
      return;
    }
    if (st.loadState === 'error') {
      body.innerHTML = `<div class="fctproc-err">
        Could not load the procurement rows for ${esc(projLabel(p))}: ${esc(st.loadError)}
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
    head.innerHTML = `
      <span class="fctproc-job">${esc(str(p['project-name']) || 'Untitled job')}</span>
      ${p['job-number'] ? `<span class="fctproc-jobno">Job #${esc(p['job-number'])}</span>` : ''}
      <span class="fctproc-counts" id="fctproc-counts">${countsHtml(ctx)}</span>
      <span class="fctproc-cluster fctproc-right">
      ${edit ? `<button type="button" class="btn btn-ghost fctproc-b" data-act="send" title="Pick bid lines to add as rows">&#10148; Send to Procurement</button>
                <button type="button" class="btn btn-green fctproc-b" data-act="add">+ Add Row</button>` : ''}
      <button type="button" class="btn btn-ghost fctproc-b" data-act="xlsx" title="The rows shown, as an Excel workbook">&#11015; Excel</button>
      <button type="button" class="btn btn-ghost fctproc-b" data-act="csv" title="The rows shown, as CSV">&#11015; CSV</button>
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
    { key: 'status', label: 'Status', w: 11.2, filter: 'status', stick: true },
    { key: 'po', label: 'PO #', w: 9, filter: 'po' },
    { key: 'sca_status', label: 'Sub-Contractor Agreement', w: 7.6, filter: 'sca_status' },
    // Every column filters, as every column of the old sheet did — a blank
    // Date Needed is exactly the row the late flags can never catch, and
    // "(blank)" in its filter is how it is found.
    { key: 'date_needed', label: 'Date Needed', w: 7.7, filter: 'date_needed' },
    { key: 'lead_time_days', label: 'Lead Time (days)', w: 4.6, num: true, filter: 'lead_time_days' },
    { key: 'order_by', label: 'Order By', w: 6.4, title: 'Date Needed minus Lead Time', filter: 'order_by' },
    { key: 'date_ordered', label: 'Date Ordered', w: 7.7, filter: 'date_ordered' },
    { key: 'date_delivered', label: 'Date Delivered', w: 7.7, filter: 'date_delivered' },
    { key: 'quantity', label: 'Quantity', w: 8.2, num: true, filter: 'quantity' },
    { key: 'unit', label: 'Unit', w: 4.8, filter: 'unit' },
    { key: 'cost_code', label: 'Cost Code', w: 10.5, filter: 'cost_code' },
    { key: 'sub_code', label: 'Sub Code', w: 11.5, filter: 'sub_code' },
    { key: 'description', label: 'Description', w: 15, filter: 'description' },
    { key: 'vendor', label: 'Vendor', w: 10.5, filter: 'vendor' },
    { key: 'quote_number', label: 'Quote #', w: 7, filter: 'quote_number' },
    { key: 'contact', label: 'Contact', w: 9, filter: 'contact' },
    { key: 'email', label: 'Email', w: 11, filter: 'email' },
    { key: 'actions', label: '', w: 6.2, edit: true },
  ];
  const colsFor = edit => COLS.filter(c => !c.edit || edit);

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
    rows.forEach(r => {
      const code = liveCodes(r, ctx).cost_code;
      add('c:' + ck(k, code), () => ({ label: code.trim() || 'No cost code', meta: '' }), r);
    });
    return groups;
  }

  function headerHtml(cols) {
    let left = 0;
    return '<tr>' + cols.map(c => {
      const stick = c.stick ? ` stk${c.key === 'status' ? ' stk-edge' : ''}" style="left:${left}rem` : '';
      if (c.stick) left += c.w;
      if (c.key === 'sel') return `<th class="c-sel${stick}"><input type="checkbox" id="fctproc-selall" title="Select every row shown" aria-label="Select every row shown"></th>`;
      const active = c.filter && st.filters[c.filter] ? ' active' : '';
      const fb = c.filter ? ` <button type="button" class="cfb fctproc-fb${active}" data-pff="${c.filter}" title="Filter ${esc(c.label)}">&#9660;</button>` : '';
      return `<th class="${c.num ? 'num' : ''}${stick}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}${fb}</th>`;
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
      body = `<tr class="fctproc-nomatch"><td colspan="${cols.length}">No procurement rows for this job yet.${!edit ? ''
        : hasBid ? ' Use <b>Send to Procurement</b> to bring in the bid lines, or <b>+ Add Row</b> for a material by hand.'
        : ' This job has no bid lines yet — add them on the bid page (or import a Procore estimate) to send them here, or use <b>+ Add Row</b> for a material by hand.'}</td></tr>`;
    } else if (!rows.length) {
      body = `<tr class="fctproc-nomatch"><td colspan="${cols.length}">No rows match the filters.
        <button type="button" class="fctproc-link" data-act="clear">Clear filters</button></td></tr>`;
    } else {
      body = groups.map(g => {
        const head = st.grouping === 'none' ? '' : groupHeaderHtml(g, cols.length, ctx);
        const open = st.grouping === 'none' || !st.collapsed.has(g.key);
        return head + (open ? g.rows.map(r => { const h = rowHtml(r, ctx, edit, cols); drawn.set(r.id, h); return h; }).join('') : '');
      }).join('');
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

  function groupHeaderHtml(g, span, ctx) {
    const open = !st.collapsed.has(g.key);
    // An editor's box ticks every row in the section (folded ones too), for
    // Delete selected or a bulk edit; synced with the rows by syncSelectAll.
    const n = g.rows.filter(r => st.selected.has(r.id)).length;
    const box = canEdit() && g.rows.length
      ? `<input type="checkbox" class="fctproc-grpsel" data-grpsel="${esc(g.key)}"${n && n === g.rows.length ? ' checked' : ''}
          title="Select every row in this section" aria-label="Select every row in ${esc(g.label)}">` : '';
    return `<tr class="fctproc-grp" data-grp="${esc(g.key)}" title="${open ? 'Fold' : 'Unfold'} this group"><td colspan="${span}">
      <span class="gl">${box}<span class="tw">${open ? '&#9660;' : '&#9654;'}</span><span>${esc(g.label)}</span>
      ${g.meta ? `<span class="gm">${g.meta}</span>` : ''}<span class="gm gc">${groupCountsHtml(g.rows, ctx)}</span></span></td></tr>`;
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
    heads.forEach(tr => {
      const span = tr.querySelector('.gc');
      if (!span) return;
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
      act: a.tagName === 'BUTTON' && a.dataset.act && a.dataset.row ? [a.dataset.act, a.dataset.row] : null };
    try { f.start = a.selectionStart; f.end = a.selectionEnd; } catch { /* not a text box */ }
    return f;
  }
  function restoreFocus(scope, f) {
    if (!f) return;
    let el = null;
    if (f.pr && f.pf) el = scope.querySelector(`[data-pr="${cssEsc(f.pr)}"][data-pf="${cssEsc(f.pf)}"]`);
    else if (f.act) el = scope.querySelector(`button[data-act="${cssEsc(f.act[0])}"][data-row="${cssEsc(f.act[1])}"]`);
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
    const textIn = (f, ph) => `<input type="text" class="fctproc-in" ${at(f)} value="${esc(r[f])}" maxlength="${MAX_LEN[f] || 200}"
      placeholder="${esc(ph || '')}" title="${esc(r[f])}" autocomplete="off" spellcheck="false">`;
    let left = 0;
    const cells = cols.map(c => {
      const stick = c.stick ? ` stk${c.key === 'status' ? ' stk-edge' : ''}" style="left:${left}rem` : '';
      if (c.stick) left += c.w;
      const td = (cls, inner) => `<td class="c-${c.key}${cls ? ' ' + cls : ''}${stick}">${inner}</td>`;
      switch (c.key) {
        case 'sel':
          return td('', `<input type="checkbox" data-sel="${id}" ${st.selected.has(r.id) ? 'checked' : ''} aria-label="Select row">`);
        case 'status': {
          const cls = status === 'Delivered' ? 'st-del' : status === 'Ordered' ? 'st-ord' : status === UNKNOWN ? 'st-unk' : 'st-not';
          const tip = status === UNKNOWN ? ' title="Waiting for the purchase orders to load"' : '';
          return td(red ? 'flag-red' : amber ? 'flag-amber' : '',
            `<span class="fctproc-pill ${cls}"${tip}>${esc(status)}</span>${flags.length ? `<span class="fctproc-flags">${flags.map(f =>
              `<span class="fctproc-flag ${f.level}" title="${esc(f.title)}">${esc(f.label)}</span>`).join('')}</span>` : ''}`);
        }
        case 'po': return poCellHtml(r, ep, edit, td);
        case 'sca_status':
          return edit
            ? td('', `<select class="fctproc-in sca-${esc(r.sca_status.replace(/\s+/g, '-'))}" ${at('sca_status')}>${SCA_VALUES.map(v =>
                `<option value="${esc(v)}"${v === r.sca_status ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`)
            : td('', txt(r.sca_status, r.sca_status === 'Needed' ? 'fctproc-amber' : r.sca_status === 'Executed' ? 'fctproc-ok' : 'fctproc-dim'));
        case 'date_needed':
        case 'date_delivered':
          return td('', edit ? dateIn(c.key, r[c.key]) : txt(fmtDate(r[c.key])));
        case 'lead_time_days':
          return td('', edit
            ? `<input type="number" class="fctproc-in" ${at('lead_time_days')} min="0" max="3650" step="1" value="${r.lead_time_days == null ? '' : r.lead_time_days}" title="Days the supplier needs from order to delivery">`
            : txt(r.lead_time_days == null ? '' : String(r.lead_time_days), 'num'));
        case 'order_by': {
          const ob = orderBy(r);
          return td('', ob ? `<span class="fctproc-txt fctproc-calc" title="Date Needed minus ${r.lead_time_days} day${r.lead_time_days === 1 ? '' : 's'} lead time">${fmtDate(ob)}</span>`
            : `<span class="fctproc-txt fctproc-dim" title="Fill in Date Needed and Lead Time">—</span>`);
        }
        case 'date_ordered': {
          const own = ymdOf(r.date_ordered);
          const eff = effectiveDateOrdered(r, ctx);
          const derived = !own && eff;
          const why = derived ? `The date ${str(ep.po && ep.po.po_number) || 'its PO'} was raised${edit ? ' — pick a date to set your own' : ''}` : '';
          if (edit) return td('', dateIn('date_ordered', own || eff, derived ? ` data-derived="1" title="${esc(why)}"` : '').replace('class="fctproc-in', `class="fctproc-in${derived ? ' derived' : ''}`));
          return td('', derived ? `<span class="fctproc-txt fctproc-calc" title="${esc(why)}">${fmtDate(eff)}</span>` : txt(fmtDate(own)));
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
        case 'cost_code': {
          const badge = codes.notOnBid ? '<span class="fctproc-tag amber" title="The bid line this row was tied to is no longer on the bid">not on bid</span>' : '';
          return td('', `<div class="fctproc-codes">${txt(codes.cost_code, codes.cost_code ? '' : 'fctproc-dim')}${badge}</div>`);
        }
        case 'sub_code':
          if (edit && r.source !== 'bid') {
            return td('', cbCell('proc_codes:' + (r.project_id || st.projectId), codes.sub_code, 'Pick bid line…',
              `${at('codes')} data-cb-value="${esc(r.bid_item_id || '')}" title="${esc([codes.cost_code, codes.sub_code].filter(Boolean).join(' / '))}"`));
          }
          return td('', txt(codes.sub_code, 'wrap2'));
        case 'description':
          return td('', edit ? textIn('description', r.source === 'bid' ? '' : 'What is it?') : txt(r.description, 'wrap'));
        case 'vendor': {
          // Typed but never picked or added: allowed (the PM may not want it on
          // the list yet), but marked, since contacts typed on the row are
          // not remembered under it until it is on the list.
          const off = !!(r.vendor.trim() && ctx.supplierKeys && ctx.supplierKeys.size && !ctx.supplierKeys.has(lc(r.vendor)));
          const tip = off ? `"${r.vendor.trim()}" is not on the supplier list. Pick "+ Add" in the Vendor menu to add it — until then, contacts typed on this row are not remembered.` : '';
          return td(off ? 'vendor-off' : '', edit
            ? cbCell('proc_vendors', r.vendor, '', `${at('vendor')} maxlength="${MAX_LEN.vendor}"${off ? ` title="${esc(tip)}"` : ''}`)
            : `<span class="fctproc-txt" title="${esc(tip || r.vendor)}">${esc(r.vendor)}</span>`);
        }
        case 'quote_number':
          return td('', edit ? textIn('quote_number') : txt(r.quote_number));
        case 'contact':
          return td('', edit ? cbCell('proc_contacts:' + r.id, r.contact, '', `${at('contact')} maxlength="${MAX_LEN.contact}"`) : txt(r.contact));
        case 'email':
          return td('', edit ? textIn('email') : txt(r.email));
        case 'actions':
          if (st.confirmDel === r.id) {
            return td('', `<div class="fctproc-acts"><span style="color:#f87171;font-size:0.68rem">Delete?</span>
              <button type="button" class="fctproc-act danger" data-act="del-yes" data-row="${id}">Yes</button>
              <button type="button" class="fctproc-act" data-act="del-no" data-row="${id}">No</button></div>`);
          }
          return td('', `<div class="fctproc-acts">
            <button type="button" class="fctproc-act add" data-act="material" data-row="${id}" title="Add another material under this ${r.bid_item_id ? 'bid line' : 'row'}">+ Material</button>
            <button type="button" class="fctproc-act del" data-act="del" data-row="${id}" title="Delete this row" aria-label="Delete row">&#10005;</button></div>`);
        default: return td('', '');
      }
    }).join('');
    return `<tr class="fctproc-row${st.selected.has(r.id) ? ' sel' : ''}" data-row="${id}">${cells}</tr>`;
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
      Array.from(tr.children).forEach((td, i) => { if (next[i] && !busy(td)) td.replaceWith(next[i]); });
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
      case 'po': return `<select id="fctproc-bulk-val">${poOptions(null).map(o =>
        `<option value="${esc(o.value)}">${esc(o.label)}${o.value.startsWith('__') ? '' : ' — ' + esc(o.meta)}</option>`).join('')}</select>`;
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
    if (el.id === 'fctproc-showall') { st.showAll = el.checked; storeSet('showall', el.checked ? '1' : ''); return; }
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
      const ctx = makeCtx();
      const g = groupRows(visibleRows(ctx), ctx).find(x => x.key === el.dataset.grpsel);
      (g ? g.rows : []).forEach(r => { if (el.checked) st.selected.add(r.id); else st.selected.delete(r.id); });
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
      el.className = `fctproc-in sca-${el.value.replace(/\s+/g, '-')}`;
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
    if (field === 'unit') {
      const u = UNITS.find(x => x.toLowerCase() === typed.toLowerCase()) || typed.slice(0, MAX_LEN.unit);
      setField(rowId, 'unit', u);
      return;
    }
    if (field === 'codes') {
      if (v && v === String(row.bid_item_id || '')) return;
      const line = v ? (makeCtx().bidLines || []).find(l => String(l.id) === v) : null;
      if (line) setFields(rowId, { bid_item_id: String(line.id), cost_code: str(line.cost_code), sub_code: str(line.sub_code) });
      else if (!typed) setFields(rowId, { bid_item_id: null, cost_code: '', sub_code: '' });
      else {
        // Anything else typed matches no bid line: the codes are the bid's
        // (section 1), so the cell goes back to what it was (refreshRow
        // after the commit) — and says why, rather than just undoing it.
        const n = (makeCtx().bidLines || []).length;
        toast(n ? `Sub Code: "${typed.slice(0, 60)}" is not a line on this job's bid — pick one from the list. A material that is not on the bid can go in Description.`
          : `Sub Code: this job has no bid lines yet, so there is no cost / sub code to pick. Add the bid items on the bid page first; the material can go in Description meanwhile.`, 'error');
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
      const cur = project(st.projectId);
      input.value = cur ? projLabel(cur) : '';
      input.dataset.cbValue = cur ? cur.id : '';
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
      case 'send': openSendModal(st.projectId); break;
      case 'add': addRow({}); break;
      case 'material': addMaterial(rowId); break;
      case 'del': st.confirmDel = rowId; refreshRow(rowId); break;
      case 'del-no': st.confirmDel = null; refreshRow(rowId); break;
      case 'del-yes': deleteRows([rowId]); break;
      case 'xlsx': exportRows('xlsx'); break;
      case 'csv': exportRows('csv'); break;
      case 'clear': clearFilters(); break;
      case 'open-po': if (typeof cfg.openPurchaseOrder === 'function') cfg.openPurchaseOrder(b.dataset.po); break;
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
  async function addRow(seed) {
    if (!canEdit() || st.loadState !== 'ok' || !st.projectId) return null;
    const item = { id: uid(), project_id: st.projectId, ...seed };
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
          setTimeout(() => { if (st.projectId === item.project_id) load(item.project_id, { quiet: true }); }, 0);
        }
      }
      const row = adoptServerRow(data.item || item);
      if (row) st.forceShow.add(row.id);
      setSave('saved');
      renderTable();
      updateCounts();
      if (row) focusField(row.id, 'description');
      return row;
    } catch (err) {
      setSave('error');
      showError(err.network
        ? `Procurement: the row may not have been added (${err.message}). It shows here once the server answers — check before adding it again.`
        : `Procurement: the row could not be added (${err.message}).`);
      return null;
    }
  }
  function addMaterial(parentId) {
    const p = rowById(parentId);
    if (!p) return null;
    const codes = liveCodes(p, makeCtx());
    return addRow({ bid_item_id: p.bid_item_id || null, cost_code: codes.cost_code, sub_code: codes.sub_code, unit: p.unit || '' });
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
    // selection can never reach a row that has moved to another one.
    const body = { ids, fields };
    if (st.projectId) body.project_id = st.projectId;
    const data = await api('PATCH', '/procurement' + q({ action: 'bulk' }), body);
    (data.items || []).forEach(adoptServerRow);
    (data.missing || []).forEach(dropRow);
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
    if (!ctx.poLoaded) { explain(ctx.poFailed ? 'The purchase orders could not be read from the server, so no PO can be raised from here yet. The page tries again every minute.' : 'The purchase orders are still loading — try again in a moment.'); return; }
    if (rows.some(r => r.project_id && r.project_id !== st.projectId)) { explain('Every selected row has to be on the job that is open.'); return; }

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
    const byCode = new Map();
    rows.forEach(r => {
      const c = liveCodes(r, ctx);
      const key = ck(k, c.cost_code) + '||' + ck(k, c.sub_code);
      if (!byCode.has(key)) byCode.set(key, { cost_code: c.cost_code, sub_code: c.sub_code, rows: [] });
      byCode.get(key).rows.push(r);
    });
    let plan = [...byCode.values()];
    if (plan.length > 1) {
      const top = plan.slice().sort((a, b) => b.rows.length - a.rows.length)[0];
      const name = [top.cost_code, top.sub_code].filter(Boolean).join(' / ') || 'no code';
      const pick = await choose('Create purchase order',
        `<p style="margin:0;line-height:1.5">The ${rows.length} selected rows span <b>${plan.length}</b> sub codes.</p>`, [
          { value: 'per', cls: 'btn-green', label: `One PO per sub code (recommended — a PO books its cost to one sub code) — ${plan.length} POs` },
          { value: 'one', label: `One PO for all, coded to ${name}` },
          { value: null, label: 'Cancel' },
        ]);
      if (!pick) return;
      if (pick === 'one') plan = [{ cost_code: top.cost_code, sub_code: top.sub_code, rows }];
    }
    const made = [];
    for (const g of plan) {
      const quotes = [...new Set(g.rows.map(r => r.quote_number.trim()).filter(Boolean))];
      const seed = {
        project_id: st.projectId,
        cost_code: g.cost_code,
        sub_code: g.sub_code,
        supplier: vendor,
        title: g.rows.length === 1 ? (g.rows[0].description.trim() || g.sub_code) : (vendor ? `${vendor} materials` : (g.sub_code || 'Materials')),
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
        : `Created ${made.length} POs (${made.map(p => str(p.po_number)).join(', ')})`);
    }
  }

  // ── Export ──────────────────────────────────────────────────────────
  function shownInOrder(ctx) {
    const rows = visibleRows(ctx);
    if (st.grouping === 'none') return rows;
    return groupRows(rows, ctx).flatMap(g => g.rows);
  }
  function exportRows(kind) {
    if (st.loadState !== 'ok') return;
    const ctx = makeCtx();
    // Without the PO list, every row on a PO would go into the file as Not
    // Ordered with no Date Ordered — a sheet that says the opposite of what
    // is true, and gets mailed on. The list is read again on the page's poll.
    if (!ctx.poLoaded) {
      toast(ctx.poFailed
        ? 'The purchase orders could not be read from the server, so the export would show ordered rows as not ordered. The page tries again every minute — export once the PO # column stops showing "…".'
        : 'The purchase orders have not loaded yet, so the export would show ordered rows as not ordered. Try again once they have (the PO # column stops showing "…").', 'error');
      return;
    }
    const rows = shownInOrder(ctx);
    if (kind === 'csv') download(new Blob([buildCsv(rows, ctx)], { type: 'text/csv;charset=utf-8' }), exportName('csv'));
    else download(buildXlsx(rows, ctx), exportName('xlsx'));
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
    const pid = projectId || st.projectId;
    if (!pid) { toast('Pick a job first.', 'error'); return null; }
    if (!(cfg.perm && cfg.perm.canEdit)) { toast('You have view-only access to Procurement.', 'error'); return null; }
    const p = project(pid);
    const jobName = p ? projLabel(p) : 'this job';
    const m = modal(`Send to Procurement — ${jobName}`, '<div style="color:var(--muted,#888);padding:1rem 0">Loading the bid lines…</div>', { wide: true });

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
        Reload the page, then Send to Procurement again. Nothing was sent.</div>`;
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
        Nothing was sent.</div>`;
      return m;
    }
    if (!m.el.isConnected) return m;     // closed meanwhile
    // The server refused a re-link: its bid is no longer the one checked a
    // moment ago (replaced elsewhere in between). Same answer as above.
    if (relinked.stale) {
      m.body.innerHTML = `<div class="fctproc-err">The bid for ${esc(jobName)} was changed somewhere else just now, so this
        page's copy of it is out of date. Reload the page, then Send to Procurement again. Nothing was sent.</div>`;
      return m;
    }

    const tags = { added: '<span class="fctproc-tag">already added</span>', removed: '<span class="fctproc-tag amber" title="This line\'s row was deleted. Tick it to bring that row back.">removed earlier</span>' };
    let plan = null, entries = [];
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;align-items:center;gap:0.5rem;justify-content:flex-end;flex-wrap:wrap;padding:0.7rem 1rem;border-top:1px solid var(--border,#2a2a3a)';
    foot.innerHTML = `<span id="fctproc-send-count" style="margin-right:auto;color:var(--muted,#9ca3af)"></span>
      <span id="fctproc-send-err" style="color:var(--red,#ef4444)"></span>
      <button type="button" class="btn btn-ghost fctproc-b" data-send="cancel">Cancel</button>
      <button type="button" class="btn btn-green fctproc-b" data-send="go">Send</button>`;
    m.body.parentElement.appendChild(foot);
    const go = foot.querySelector('[data-send="go"]');
    const sync = () => {
      const n = entries.filter(en => en.checked && en.state !== 'added').length;
      const already = entries.filter(en => en.state === 'added').length;
      foot.querySelector('#fctproc-send-count').textContent = `${n} line${n === 1 ? '' : 's'} ticked`
        + (already ? ` · ${already} already in Procurement` : '');
      go.textContent = `Send ${n} line${n === 1 ? '' : 's'}`;
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
          Tick the bid lines to track. Each one becomes a row with the bid's cost code, sub code, quantity and unit.
          Lump-sum (LS) and hourly (HR) lines start unticked — there is rarely anything to buy for them.
          Sending again later only adds lines; it never changes rows already there.</p>
        ${relinked.length ? `<p style="margin:0 0 0.7rem;color:var(--green,#22c55e)">Re-linked ${relinked.length} row${relinked.length === 1 ? '' : 's'}
          to the current bid line${relinked.length === 1 ? '' : 's'} with the same cost and sub code (${esc(relinkWords(relinked))}).</p>` : ''}
        ${bid.why === 'unread' ? `<p style="margin:0 0 0.7rem;color:#fbbf24">The bid could not be checked against the server just now,
          so no rows were re-linked to it.</p>` : ''}
        ${off.length ? `<p class="fctproc-send-off" style="margin:0 0 0.7rem;line-height:1.5;color:#fbbf24">
          ${off.length} row${off.length === 1 ? ' on this job is' : 's on this job are'} <b>not on the bid</b>:
          ${esc(offNames.slice(0, 6).join('; '))}${offNames.length > 6 ? ` and ${offNames.length - 6} more` : ''}.
          Lines with the same codes start unticked — tick one only for a material that has no row yet.</p>` : ''}
        ${plan.groups.map((g, gi) => `
          <div class="fctproc-send-grp">
            <div class="fctproc-send-h"><span>${esc(g.cost_code || 'No cost code')}</span>
              <span class="gm">${g.lines.length} line${g.lines.length === 1 ? '' : 's'}</span><span class="fctproc-spacer"></span>
              <button type="button" class="fctproc-link" data-sall="${gi}">All</button><button type="button" class="fctproc-link" data-snone="${gi}">None</button></div>
            ${g.lines.map(en => {
              const i = entries.indexOf(en);
              const qty = en.line.quantity == null ? '' : fmtQty(en.line.quantity);
              const tag = tags[en.state] || (en.hint ? `<span class="fctproc-tag amber" title="${esc(en.orphans
                ? 'Rows with this cost and sub code are already on this job, kept from an earlier bid. Sending this line adds another row for it.'
                : 'A row added by hand is already coded to this line. Sending it adds the bid\'s own row as well.')}">${esc(en.hint)}</span>` : '');
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
    const reloadSheet = () => { if (pid === st.projectId && isMounted() && st.loadState === 'ok') load(pid, { quiet: true }); };

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
      go.textContent = 'Sending…';
      const errBox = foot.querySelector('#fctproc-send-err');
      errBox.textContent = '';
      try {
        const data = await api('POST', '/procurement' + q({ action: 'send' }), { project_id: pid, items, restore_ids: restoreIds });
        m.close();
        const created = data.created || [], restored = data.restored || [];
        // Land the user on the job they just sent: the tab state switches to
        // it, and the page (listening for the event) switches to the tab.
        if (pid === st.projectId) {
          created.concat(restored).forEach(adoptServerRow);
          if (isMounted()) { renderTable(); updateCounts(); }
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
          ? `Sent ${n} line${n === 1 ? '' : 's'} to Procurement${already > 0 ? ` (${already} ${already === 1 ? 'was' : 'were'} already there)` : ''}`
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
            text = `The send went through after all: ${n(landed, 'line is', 'lines are')} now in Procurement, shown above as `
              + `"already added". Only the server's answer was lost on the way back — ${err.message}.`;
          } else if (reread && landed) {
            text = `${landed} of the ${n(picked.length, 'line', 'lines')} you ticked ${landed === 1 ? 'is' : 'are'} now in Procurement; `
              + `the server's answer was lost — ${err.message}. The list above has been read again — check it before sending the rest.`;
          } else if (reread) {
            text = `Not sent: ${err.message}. The list above has been read again — check it before sending again.`;
          } else {
            text = `The send may not have gone through (${err.message}), and the list could not be read again to check. `
              + 'Close this and open Send to Procurement again before resending — lines already in Procurement show as "already added".';
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
        if (pid === st.projectId) adoptServerRow(item);
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
    if (done.length && pid === st.projectId && isMounted()) {
      if (cellInUse()) redrawAround(); else { renderTable(); updateCounts(); }
    }
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
    if (relinking || !canEdit() || pid !== st.projectId || st.loadState !== 'ok') return relinking;
    const ctx = makeCtx(pid);
    if (!ctx.bidLines.length) return null;
    const untried = p => !relinkTried.has(tryKey(p));
    const plans = (lines, rows, k) => relinkPlan(lines, rows, k).concat(codeSyncPlan(lines, rows, k));
    const looks = plans(ctx.bidLines, st.rows, ctx.codeKey).filter(untried);
    if (!looks.length) return null;
    relinking = (async () => {
      const bid = await bidAgreed(pid);
      // Not agreed (or not known): nothing is marked tried, so the next load
      // looks again — by then the page has caught up.
      if (!bid.lines || pid !== st.projectId) return;
      let all;
      try { all = await readAllRows(pid); } catch (err) { console.warn('[procurement] re-link check failed', err); return; }
      if (pid !== st.projectId) return;
      const now = makeCtx(pid);
      // The bid moved while the rows were read — on this page, or on the
      // server (a colleague's Replace all landing while the read was out):
      // asked again, and nothing moves unless the two still agree. The
      // server checks each line once more as it is written (stale_bid).
      if (!sameBid(bid.lines, now.bidLines, now.codeKey)) return;
      const again = await bidAgreed(pid);
      if (!again.lines || pid !== st.projectId || !sameBid(again.lines, bid.lines, now.codeKey)) return;
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
      if (done.length && pid === st.projectId && isMounted()) {
        toast(`Re-linked ${done.length} row${done.length === 1 ? '' : 's'} to the current bid line${done.length === 1 ? '' : 's'} `
          + `with the same cost and sub code (${relinkWords(done)}) — the bid's lines were replaced.`);
      }
    })().finally(() => { relinking = null; });
    return relinking;
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
      if (st.projectId && !project(st.projectId) && projects().length) {
        st.projectId = null;
        storeSet('project', null);
      }
      // The contact pickers read from the shared cache.
      contacts.load().catch(err => console.warn('[procurement] contacts did not load', err));
      const cached = st.projectId && st.loadedFor === st.projectId && st.loadState === 'ok';
      if (st.projectId && !cached) st.loadState = 'loading';
      renderShell();
      if (st.projectId) load(st.projectId, { quiet: cached });
    },

    /** Redraw from what is in memory (POs or the bid changed). No fetch. */
    rerender() {
      if (!isMounted()) return;
      const a = document.activeElement;
      // The job list moved under us: a rename shows in the picker, and a job
      // deleted elsewhere gets the "no longer on the list" note, not a table.
      const picker = st.mountEl.querySelector('#fctproc-proj');
      const p = project(st.projectId);
      if (picker && picker !== a && p) { picker.value = projLabel(p); picker.dataset.cbValue = p.id; }
      if (st.projectId && !p) { renderBody(); return; }
      // The bid changed under the open job (a line renamed, a Replace all):
      // rows re-link and their stored codes follow now, not at the next read.
      // autoRelink checks the bid with the server first, and does nothing
      // when there is nothing to do.
      if (st.projectId && st.loadState === 'ok' && st.loadedFor === st.projectId) autoRelink(st.projectId);
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
      await load(st.projectId, { quiet: st.loadState === 'ok' });
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
      exportMatrix, buildCsv, xlsxParts, buildXlsx, defaultCodeKey,
      state: () => st,
      pending: () => ({ pend: new Map(pend), fly: new Map(fly), failed: new Set(failed) }),
      flushAll,
      selectProject,
    },
  };
})();
