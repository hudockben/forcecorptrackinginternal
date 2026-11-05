/* eslint-disable no-undef */
/* DataWatch — Custom Reporting: the report engine
 *
 * The half of Analytics → Custom Reporting that decides what goes on a report.
 * It takes a report definition (the JSON the builder saves in
 * custom_reports.definition) and the division page's own data, and turns them
 * into rows, a printable HTML document and an .xlsx workbook. The builder
 * screens, saving and sending live in custom-reports.js, which asks this file
 * for every catalog lookup, every figure and every rendered page.
 *
 *   window.FCTReportEngine = { CATALOG, STARTERS, normalizeDefinition,
 *     makeContext, buildSectionData, buildReportHtml, buildXlsx, ... }
 *
 * It is pure on purpose: no fetch, no DOM, no page globals. The live preview,
 * the print window, the email and the workbook all come out of the same calls,
 * so they cannot disagree with each other, and the whole thing runs in a node
 * vm for scripts/test-custom-reports-engine.js.
 *
 * Figures come from the page's own helpers whenever the page hands them over
 * (cfg.helpers: dailyRowCost, bidProjectPct, projForBidItem and the rest), so a
 * number on a custom report is the number the bid page shows. Each helper has
 * a fallback here that restates the page's rule, for a page that does not pass
 * one — the test runs both ways and checks they agree.
 *
 * Customer-safe is the point of the feature. These reports go to customers,
 * and the people sending them need to be sure no cost, rate, wage, hour,
 * employee name or contract figure rides along by accident. So every column
 * in the catalog is tagged internal (and financial for contract / profit
 * money), and the renderers only ever see effectiveColumns(): a locked column
 * is dropped before its value is put into a row at all, so a saved definition
 * that names one — a shared template, an old report, a hand-edited payload —
 * still cannot carry it into the HTML or the workbook.
 *
 * Big jobs are the normal case (thousands of daily rows, a report over twenty
 * jobs), so each job's daily rows are indexed by cost code and sub code once,
 * and each bid item's figures are worked out once per report, rather than
 * every bid item re-scanning every row for every section.
 *
 * Dates are 'YYYY-MM-DD' strings throughout, compared as strings and stepped
 * in UTC off the date's own fields, so a work date never slips a day through
 * the local-time parser. "Today" is injectable (makeContext opts.today) so the
 * date presets and the projected-finish dates can be tested.
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.FCTReportEngine) return; // already loaded

  const VERSION = 1;

  // ── Small utilities ────────────────────────────────────────────────────
  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // The blobs hold numbers as typed: '', '12.5', sometimes a real number.
  // parseFloat semantics, like the pages, so a figure here matches theirs.
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const f = parseFloat(v);
    return isFinite(f) ? f : 0;
  }

  // Purchase-order numbers are typed by hand and pasted from invoices:
  // '$1,234.50', '1.234,50', '(12.00)'. The PO page reads them this way
  // (_normalizeNumeric); this is the fallback when its helpers are not passed.
  function poParse(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    let t = String(v).trim().replace(/[\s '$£€]/g, '');
    if (!t) return NaN;
    const neg = /^\(.*\)$/.test(t);
    if (neg) t = t.slice(1, -1);
    const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.');
    if (lc > -1 && ld > -1) t = lc > ld ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if (lc > -1) {
      const tail = t.length - lc - 1, once = t.indexOf(',') === lc;
      t = (once && tail >= 1 && tail <= 2) ? t.replace(',', '.') : t.replace(/,/g, '');
    }
    return parseFloat((neg ? '-' : '') + t);
  }
  const poNum = v => { const f = poParse(v); return isFinite(f) ? f : 0; };

  function str(v, max) {
    const s = typeof v === 'string' ? v
      : (typeof v === 'number' && isFinite(v)) || typeof v === 'boolean' ? String(v) : '';
    return max ? s.slice(0, max) : s;
  }
  const txt = v => str(v).trim();
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const cap1 = s => { s = txt(s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };

  // Every user-typed string that reaches the HTML goes through this. The
  // pages' own esc() only escapes quotes, which is not enough for a job name
  // like "<img onerror=…>" printed into a document that is opened, printed
  // and emailed.
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  }

  // ── Dates ──────────────────────────────────────────────────────────────
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_MS = 86400000;
  const p2 = n => String(n).padStart(2, '0');

  // A row's date as 'YYYY-MM-DD', or '' when it has none. Accepts a stamp
  // with a time on the end, and refuses Feb 30.
  function dayOf(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof v === 'string' ? v : '');
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : '';
  }
  const isIso = v => typeof v === 'string' && v.length === 10 && dayOf(v) === v;
  const utc = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  function fromUtc(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  }
  const addDays = (iso, n) => fromUtc(utc(iso) + n * DAY_MS);
  const weekday = iso => new Date(utc(iso)).getUTCDay();          // 0 Sun … 6 Sat
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY_MS);
  const mondayOf = iso => addDays(iso, -((weekday(iso) + 6) % 7)); // weeks run Mon–Sun
  function localToday(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }

  /* The pages' working-day calendar (_usHolidays / _addWorkingDays): Mon–Fri
     less the US federal holidays — the fixed ones moved to the Friday or
     Monday they are observed on, and MLK, Presidents, Memorial, Labor,
     Columbus and Thanksgiving days. The Schedule Estimator, the Gantt and
     the PDFs all count with it, so a projected finish here lands on the day
     the company's own schedule shows. Restated on UTC date fields, and the
     same way round as the page: a set per year holding only dates labelled
     with that year (a Saturday New Year's observed on Dec 31 is filed under
     the year it belongs to — a weekend, so it never moves a date). */
  const HOLIDAYS = new Map();
  function holidaysOf(year) {
    let h = HOLIDAYS.get(year);
    if (h) return h;
    h = new Set();
    const iso = (m, d) => `${year}-${p2(m)}-${p2(d)}`;
    const fixedObs = (m, d) => {
      const w = weekday(iso(m, d));
      const shifted = addDays(iso(m, d), w === 0 ? 1 : w === 6 ? -1 : 0);
      return `${year}-${shifted.slice(5)}`;
    };
    const nth = (m, wd, n) => {
      const first = weekday(iso(m, 1));
      return iso(m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
    };
    const last = (m, wd) => {
      const end = addDays(m === 12 ? `${year + 1}-01-01` : iso(m + 1, 1), -1);
      return addDays(end, -((weekday(end) - wd + 7) % 7));
    };
    [fixedObs(1, 1), fixedObs(7, 4), fixedObs(11, 11), fixedObs(12, 25),
      nth(1, 1, 3), nth(2, 1, 3), last(5, 1), nth(9, 1, 1), nth(10, 1, 2), nth(11, 4, 4)].forEach(x => h.add(x));
    HOLIDAYS.set(year, h);
    return h;
  }
  const isHoliday = iso => holidaysOf(+iso.slice(0, 4)).has(iso);

  // The page's own cap: past ten years of work days a projection is no date.
  const MAX_WORKDAYS = 3650;

  /* n working days after `iso`, or null when n is not a number or is past
     MAX_WORKDAYS — the page prints "—" then rather than a finish centuries
     out (or, once a Date overflows, "NaN-NaN-NaN"). A fraction rounds up. */
  function addWorkdays(iso, n) {
    if (typeof n !== 'number' || !isFinite(n) || n > MAX_WORKDAYS || !isIso(iso)) return null;
    let left = Math.ceil(Math.max(0, n));
    let t = utc(iso);
    while (left > 0) {
      t += DAY_MS;
      const w = new Date(t).getUTCDay();
      if (w === 0 || w === 6) continue;
      if (!isHoliday(fromUtc(t))) left--;
    }
    return fromUtc(t);
  }

  function fmtDate(iso) {
    if (!isIso(iso)) return String(iso == null ? '' : iso);
    return `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
  }
  // "Oct 1 – Oct 31, 2026", the year said once when both ends share it.
  function rangeText(from, to) {
    if (from && to) {
      if (from === to) return fmtDate(from);
      if (from.slice(0, 4) === to.slice(0, 4)) {
        return `${MONTHS[+from.slice(5, 7) - 1]} ${+from.slice(8, 10)} – ${fmtDate(to)}`;
      }
      return `${fmtDate(from)} – ${fmtDate(to)}`;
    }
    if (from) return 'Since ' + fmtDate(from);
    if (to) return 'Through ' + fmtDate(to);
    return 'Job to date';
  }
  function fmtStamp(d) {
    if (!(d instanceof Date) || isNaN(d)) d = new Date();
    const h = d.getHours(), h12 = h % 12 || 12;
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${h12}:${p2(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // ── Number formatting ──────────────────────────────────────────────────
  // Written out rather than handed to toLocaleString: it is called once per
  // cell on reports thousands of rows long, and it must give the same string
  // in every browser, in headless Chrome and in a test.
  const commas = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  function fmtQty(n) {
    const r = Math.round(n * 100) / 100;
    if (!r) return '0';
    let s = Math.abs(r).toFixed(2);
    s = s.replace(/0+$/, '').replace(/\.$/, '');
    const dot = s.indexOf('.');
    return (r < 0 ? '-' : '') + (dot < 0 ? commas(s) : commas(s.slice(0, dot)) + s.slice(dot));
  }
  function fmtMoney(n) {
    const r = Math.round(n * 100) / 100;
    const s = Math.abs(r).toFixed(2), dot = s.indexOf('.');
    return (r < 0 ? '-$' : '$') + commas(s.slice(0, dot)) + s.slice(dot);
  }
  const NUMERIC = { number: 1, qty: 1, money: 1, percent: 1, days: 1 };

  /* The display string for one cell — plain text, NOT escaped (the HTML
     escapes it). A string in a numeric column ("Multiple", "1,200 SY · 40
     TON", a "Subtotal" label) is already its own display text. */
  function formatCell(value, type, unit, signed) {
    if (value == null || value === '' || (typeof value === 'number' && !isFinite(value))) return '—';
    if (typeof value !== 'number') return type === 'date' ? fmtDate(String(value)) : String(value);
    let s;
    switch (type) {
      case 'money':   return fmtMoney(value);
      case 'percent': return (Math.round(value * 10) / 10).toFixed(1) + '%';
      case 'days':    s = (value < 0 ? '-' : '') + commas(String(Math.abs(Math.round(value)))); break;
      case 'qty': case 'number': s = fmtQty(value); break;
      default:        return String(value);
    }
    if (signed && value > 0) s = '+' + s;
    return unit ? s + ' ' + unit : s;
  }

  // ── The catalog ────────────────────────────────────────────────────────
  // col(key, label, type, flags): d = on by default, i = internal (locked
  // until "Include internal data"), f = financial (internal, and hidden
  // outright from roles that cannot open Financials), s = totals sum it.
  function col(key, label, type, flags) {
    flags = flags || '';
    const financial = flags.includes('f');
    return { key, label, type, internal: financial || flags.includes('i'), financial,
      def: flags.includes('d'), total: flags.includes('s') ? 'sum' : null };
  }
  const B = (key, label) => ({ key, label, kind: 'bool' });
  const COST_CODES = { key: 'costCodes', label: 'Cost codes', kind: 'costCodes' };
  const TOTALS = B('totals', 'Totals row');

  const CATALOG = {
    job_info: {
      type: 'job_info', label: 'Job Information', table: false,
      blurb: 'Name, client, address, dates and progress for each job, as a card.',
      columns: [
        col('project-name', 'Project', 'text', 'd'), col('job-number', 'Job #', 'text', 'd'),
        col('status', 'Status', 'text'), col('contract-type', 'Contract Type', 'text'),
        col('client', 'Client', 'text', 'd'), col('gc', 'General Contractor', 'text', 'd'),
        col('pm', 'Project Manager', 'text'), col('super', 'Superintendent', 'text'),
        col('estimator', 'Estimator', 'text'), col('client-contact', 'Client Contact', 'text'),
        col('address', 'Address', 'text', 'd'), col('city-state', 'City / State', 'text', 'd'),
        col('start-date', 'Start Date', 'date', 'd'), col('end-date', 'End Date', 'date', 'd'),
        col('contract-days', 'Contract Days', 'days'), col('scope', 'Scope', 'text'),
        col('sqft', 'Area', 'qty'), col('pct_complete', '% Complete', 'percent', 'd'),
        col('days_worked', 'Days Worked', 'days'),
        col('notes', 'Internal Notes', 'text', 'i'),
        col('contract', 'Contract Value', 'money', 'f'), col('retention', 'Retention', 'percent', 'f'),
        col('invoiced', 'Invoiced', 'money', 'f'),
      ],
      options: {}, optionSpec: [],
    },
    summary_kpis: {
      type: 'summary_kpis', label: 'Summary Figures', table: false,
      blurb: 'A strip of headline numbers: % complete, days worked, quantity installed.',
      columns: [
        col('pct_complete', '% Complete', 'percent', 'd'), col('days_worked', 'Days Worked', 'days', 'd'),
        col('items_complete', 'Bid Items Complete', 'text', 'd'), col('qty_period', 'Qty Installed', 'qty', 'd'),
        col('labor_hours', 'Labor Hours', 'number', 'i'), col('actual_cost', 'Actual Cost to Date', 'money', 'i'),
        col('period_cost', 'Cost This Period', 'money', 'i'), col('bid_budget', 'Bid Budget', 'money', 'i'),
        col('projected_cost', 'Projected Cost', 'money', 'i'), col('contract', 'Contract Value', 'money', 'f'),
        col('co_total', 'Contract Change Orders', 'money', 'f'), col('gp_earned', 'GP Earned to Date', 'money', 'f'),
      ],
      options: {}, optionSpec: [],
    },
    bid_progress: {
      type: 'bid_progress', label: 'Bid Item Progress', table: true,
      blurb: 'Every bid item with quantity installed, remaining and % complete, grouped by cost code.',
      columns: [
        col('cost_code', 'Cost Code', 'text', 'd'), col('sub_code', 'Sub Code', 'text', 'd'),
        col('description', 'Description', 'text'), col('unit', 'Unit', 'text', 'd'),
        col('bid_qty', 'Bid Qty', 'qty', 'ds'), col('installed_to_date', 'Installed to Date', 'qty', 'ds'),
        col('installed_period', 'Installed This Period', 'qty', 's'), col('remaining_qty', 'Remaining', 'qty', 'ds'),
        col('pct_complete', '% Complete', 'percent', 'd'), col('start_date', 'Start', 'date'),
        col('target_date', 'Target', 'date'), col('status', 'Status', 'text', 'd'),
        col('days_worked', 'Days Worked', 'days'),
        col('unit_cost', 'Unit Cost', 'money', 'i'), col('bid_total', 'Bid Total', 'money', 'is'),
        col('actual_cost', 'Actual Cost', 'money', 'is'), col('variance', 'Variance', 'money', 'is'),
        col('projected_cost', 'Projected Cost', 'money', 'is'), col('labor_hours', 'Labor Hours', 'number', 'is'),
        col('crew_size', 'Crew Size', 'number', 'i'), col('cost_per_unit', 'Cost / Unit', 'money', 'i'),
        col('units_per_mh', 'Units / Man-Hour', 'number', 'i'),
      ],
      options: { groupBy: 'cost_code', subtotals: true, totals: true, hideNotStarted: false, hideComplete: false, costCodes: [] },
      optionSpec: [
        { key: 'groupBy', label: 'Group by', kind: 'select', choices: [['cost_code', 'Cost code'], ['none', 'No grouping']] },
        B('subtotals', 'Cost code subtotals'), TOTALS,
        B('hideNotStarted', 'Hide items not started'), B('hideComplete', 'Hide completed items'), COST_CODES,
      ],
    },
    production_kpis: {
      type: 'production_kpis', label: 'Production Rates', table: true,
      blurb: 'Per bid item worked in the period: average and best day, days left and projected finish.',
      columns: [
        col('cost_code', 'Cost Code', 'text'), col('sub_code', 'Sub Code', 'text', 'd'),
        col('description', 'Description', 'text'), col('unit', 'Unit', 'text', 'd'),
        col('qty_period', 'Qty This Period', 'qty', 'ds'), col('days_period', 'Days Worked', 'days', 'd'),
        col('avg_per_day', 'Avg / Day', 'qty', 'd'), col('best_day', 'Best Day', 'qty'),
        col('remaining_qty', 'Remaining', 'qty', 'ds'), col('est_days_left', 'Est. Days Left', 'days', 'd'),
        col('projected_finish', 'Projected Finish', 'date', 'd'),
        col('labor_hours', 'Labor Hours', 'number', 'is'), col('units_per_mh', 'Units / Man-Hour', 'number', 'i'),
        col('cost_per_unit', 'Cost / Unit', 'money', 'i'), col('crew_avg', 'Avg Crew', 'number', 'i'),
      ],
      options: { totals: false, costCodes: [] },
      optionSpec: [TOTALS, COST_CODES],
    },
    daily_production: {
      type: 'daily_production', label: 'Daily Production', table: true,
      blurb: 'Quantities put down each day, by cost code and sub code.',
      columns: [
        col('date', 'Date', 'date', 'd'), col('cost_code', 'Cost Code', 'text', 'd'),
        col('sub_code', 'Sub Code', 'text', 'd'), col('quantity', 'Quantity', 'qty', 'ds'),
        col('unit', 'Unit', 'text', 'd'), col('field_type', 'Field Type', 'text'),
        col('employee', 'Employee', 'text', 'i'), col('job_class', 'Job Class', 'text', 'i'),
        col('labor_hours', 'Labor Hours', 'number', 'is'), col('rate', 'Rate', 'money', 'i'),
        col('labor_cost', 'Labor Cost', 'money', 'is'), col('equipment', 'Equipment', 'text', 'i'),
        col('equip_hours', 'Equip Hours', 'number', 'is'), col('equip_cost', 'Equip Cost', 'money', 'is'),
        col('material', 'Material', 'text', 'i'), col('supplier', 'Supplier', 'text', 'i'),
        col('po_num', 'PO #', 'text', 'i'), col('material_cost', 'Material Cost', 'money', 'is'),
        col('total_cost', 'Total Cost', 'money', 'is'),
      ],
      options: { summarize: true, groupBy: 'none', hideZeroQty: true, totals: true, costCodes: [] },
      optionSpec: [
        B('summarize', 'One row per day and sub code'),
        { key: 'groupBy', label: 'Group by', kind: 'select',
          choices: [['none', 'No grouping'], ['date', 'Day'], ['week', 'Week'], ['sub_code', 'Sub code']] },
        B('hideZeroQty', 'Hide rows with no quantity'), TOTALS, COST_CODES,
      ],
    },
    materials: {
      type: 'materials', label: 'Materials Delivered', table: true,
      blurb: 'Purchase-order deliveries: date, supplier, material, ticket and quantity.',
      columns: [
        col('date', 'Date', 'date', 'd'), col('po_number', 'PO #', 'text', 'd'),
        col('supplier', 'Supplier', 'text', 'd'), col('material', 'Material', 'text', 'd'),
        col('invoice_num', 'Ticket / Invoice #', 'text', 'd'), col('qty', 'Qty', 'qty', 'ds'),
        col('cost_code', 'Cost Code', 'text'), col('sub_code', 'Sub Code', 'text'),
        col('po_status', 'PO Status', 'text'),
        col('unit_cost', 'Unit Cost', 'money', 'i'), col('tax', 'Tax', 'money', 'is'),
        col('line_total', 'Line Total', 'money', 'is'),
      ],
      options: { summarize: false, totals: true },
      optionSpec: [B('summarize', 'One row per material and supplier'), TOTALS],
    },
    trucking: {
      type: 'trucking', label: 'Trucking / Haul Log', table: true,
      blurb: 'Trucking tickets: date, truck type, material hauled and loads.',
      columns: [
        col('date', 'Date', 'date', 'd'), col('tr_number', 'Ticket #', 'text', 'd'),
        col('truck_type', 'Truck Type', 'text', 'd'), col('material_hauled', 'Material Hauled', 'text', 'd'),
        col('loads', 'Loads', 'number', 'ds'), col('status', 'Status', 'text'),
        col('cost_code', 'Cost Code', 'text'), col('sub_code', 'Sub Code', 'text'),
        col('notes', 'Notes', 'text'),
        col('driver', 'Driver', 'text', 'i'), col('hours', 'Hours', 'number', 'is'),
        col('rate', 'Rate', 'money', 'i'), col('cost', 'Cost', 'money', 'is'),
      ],
      options: { totals: true },
      optionSpec: [TOTALS],
    },
    change_orders: {
      type: 'change_orders', label: 'Change Orders', table: true,
      blurb: 'Contract and quantity change orders with their dates and descriptions.',
      columns: [
        col('kind', 'Type', 'text', 'd'), col('date', 'Date', 'date', 'd'),
        col('number', 'CO #', 'text', 'd'), col('cost_code', 'Cost Code', 'text', 'd'),
        col('sub_code', 'Sub Code', 'text', 'd'), col('description', 'Description', 'text', 'd'),
        col('qty_change', 'Qty Change', 'qty', 'd'), col('amount', 'Amount', 'money', 'f'),
      ],
      options: { kinds: ['contract', 'quantity'] },
      optionSpec: [{ key: 'kinds', label: 'Show', kind: 'kinds',
        choices: [['contract', 'Contract change orders'], ['quantity', 'Quantity change orders']] }],
    },
    schedule: {
      type: 'schedule', label: 'Schedule', table: true,
      blurb: 'Start and target dates per bid item, with a simple timeline bar.',
      columns: [
        col('cost_code', 'Cost Code', 'text', 'd'), col('sub_code', 'Sub Code', 'text', 'd'),
        col('description', 'Description', 'text'), col('start_date', 'Start', 'date', 'd'),
        col('target_date', 'Target', 'date', 'd'), col('status', 'Status', 'text', 'd'),
        col('pct_complete', '% Complete', 'percent', 'd'), col('days_left', 'Days Left', 'days'),
      ],
      options: { showBars: true },
      optionSpec: [B('showBars', 'Timeline bars')],
    },
    notes: {
      type: 'notes', label: 'Notes', table: false,
      blurb: 'A free-text message, printed as written.',
      columns: [], options: {}, optionSpec: [],
    },
  };
  const SECTION_ORDER = ['job_info', 'summary_kpis', 'bid_progress', 'production_kpis', 'daily_production',
    'materials', 'trucking', 'change_orders', 'schedule', 'notes'];
  const COLS = {};
  Object.keys(CATALOG).forEach(t => {
    COLS[t] = {};
    CATALOG[t].columns.forEach(c => { COLS[t][c.key] = c; });
  });
  // What an empty section says: "No material deliveries in this period."
  const NOUN = { bid_progress: 'bid items', production_kpis: 'production', daily_production: 'daily production',
    materials: 'material deliveries', trucking: 'trucking tickets', change_orders: 'change orders',
    schedule: 'scheduled bid items' };
  // A combined report's tables open with this; it is never internal.
  const JOB_COL = { key: '_job', label: 'Job', type: 'text', internal: false, financial: false, def: true, total: null };
  // Materials summarized to one row per material + supplier gain a count.
  const DELIVERIES_COL = { key: 'deliveries', label: 'Deliveries', type: 'number', internal: false, financial: false, def: false, total: 'sum' };

  const DATE_PRESETS = [
    { key: 'job_to_date', label: 'Job to date' }, { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' }, { key: 'this_week', label: 'This week' },
    { key: 'last_week', label: 'Last week' }, { key: 'this_month', label: 'This month' },
    { key: 'last_month', label: 'Last month' }, { key: 'last_7', label: 'Last 7 days' },
    { key: 'last_30', label: 'Last 30 days' }, { key: 'custom', label: 'Custom range' },
  ];
  const PRESET_KEYS = new Set(DATE_PRESETS.map(p => p.key));
  const DIV_LABELS = { turf: 'Turf Management', paving: 'Paving', kiewit: 'Kiewit Pinetree' };

  const clone = v => JSON.parse(JSON.stringify(v));

  // ── Definitions ────────────────────────────────────────────────────────
  let idSeq = 0;
  function freshId() {
    idSeq = (idSeq + 1) % 1679616;
    return 's' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6) + idSeq.toString(36);
  }

  function defaultDefinition() {
    return {
      v: VERSION, title: '', jobs: { mode: 'pick', ids: [] }, layout: 'separate', pageBreakPerJob: false,
      dates: { preset: 'job_to_date', from: '', to: '' }, includeInternal: false, orientation: 'portrait',
      header: { preparedFor: '', preparedBy: '', intro: '', footer: '', showGenerated: true },
      sections: [],
    };
  }

  function newSection(type) {
    const cat = CATALOG[type];
    if (!cat) return null;
    const s = { id: freshId(), type, title: cat.label, columns: cat.columns.filter(c => c.def).map(c => c.key),
      labels: {}, options: clone(cat.options) };
    if (type === 'notes') s.text = '';
    return s;
  }

  function normOptions(type, raw) {
    const cat = CATALOG[type];
    const out = clone(cat.options);
    if (!isObj(raw)) return out;
    for (const spec of cat.optionSpec) {
      const v = raw[spec.key];
      if (spec.kind === 'bool') { if (typeof v === 'boolean') out[spec.key] = v; }
      else if (spec.kind === 'select') { if (spec.choices.some(c => c[0] === v)) out[spec.key] = v; }
      else if (spec.kind === 'costCodes') {
        if (Array.isArray(v)) out[spec.key] = [...new Set(v.filter(x => typeof x === 'string' && x && x.length <= 120))].slice(0, 300);
      } else if (spec.kind === 'kinds') {
        if (Array.isArray(v)) out[spec.key] = spec.choices.map(c => c[0]).filter(k => v.includes(k));
      }
    }
    return out;
  }

  function normSection(raw, usedIds) {
    if (!isObj(raw) || typeof raw.type !== 'string' || !has(CATALOG, raw.type)) return null;
    const type = raw.type, cat = CATALOG[type];
    let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : '';
    if (!id || usedIds.has(id)) { do { id = freshId(); } while (usedIds.has(id)); }
    usedIds.add(id);
    const s = { id, type, title: str(raw.title, 120), columns: [], labels: {}, options: normOptions(type, raw.options) };
    if (type !== 'notes') {
      if (Array.isArray(raw.columns)) {
        const seen = new Set();
        raw.columns.forEach(k => {
          if (typeof k === 'string' && has(COLS[type], k) && !seen.has(k) && seen.size < 60) { seen.add(k); s.columns.push(k); }
        });
      } else {
        s.columns = cat.columns.filter(c => c.def).map(c => c.key);
      }
      if (isObj(raw.labels)) {
        Object.keys(raw.labels).forEach(k => {
          const l = txt(str(raw.labels[k], 60));
          if (has(COLS[type], k) && l) s.labels[k] = l;
        });
      }
    } else {
      s.text = str(raw.text, 5000);
    }
    return s;
  }

  /* Anything in, a valid v1 definition out: null, a half-written draft, an
     older shape, or a payload someone edited by hand. Unknown section types
     and column keys are dropped, text is capped, order is kept. Every
     renderer runs its definition through this first, so a junk value cannot
     reach the output — includeInternal is on only when it is literally true. */
  function normalizeDefinition(def) {
    const d = isObj(def) ? def : {};
    const out = defaultDefinition();
    out.title = str(d.title, 120);
    // Jobs: { mode, ids }, or an older bare array of ids.
    let ids = [], mode = 'pick';
    if (Array.isArray(d.jobs)) { ids = d.jobs; mode = d.jobs.length ? 'saved' : 'pick'; }
    else if (isObj(d.jobs)) { ids = Array.isArray(d.jobs.ids) ? d.jobs.ids : []; mode = d.jobs.mode === 'saved' ? 'saved' : 'pick'; }
    const seenIds = new Set();
    out.jobs = { mode, ids: ids.filter(x => {
      const ok = (typeof x === 'string' && x && x.length <= 100) || (typeof x === 'number' && isFinite(x));
      if (!ok || seenIds.has(String(x))) return false;
      seenIds.add(String(x));
      return true;
    }).slice(0, 500) };
    out.layout = d.layout === 'combined' ? 'combined' : 'separate';
    out.pageBreakPerJob = d.pageBreakPerJob === true;
    const dt = isObj(d.dates) ? d.dates : {};
    out.dates = {
      preset: typeof dt.preset === 'string' && PRESET_KEYS.has(dt.preset) ? dt.preset : 'job_to_date',
      from: isIso(dt.from) ? dt.from : '', to: isIso(dt.to) ? dt.to : '',
    };
    out.includeInternal = d.includeInternal === true;
    out.orientation = d.orientation === 'landscape' ? 'landscape' : 'portrait';
    const h = isObj(d.header) ? d.header : {};
    out.header = {
      preparedFor: str(h.preparedFor, 200), preparedBy: str(h.preparedBy, 200),
      intro: str(h.intro, 4000), footer: str(h.footer, 300), showGenerated: h.showGenerated !== false,
    };
    const used = new Set();
    out.sections = (Array.isArray(d.sections) ? d.sections : [])
      .map(s => normSection(s, used)).filter(Boolean).slice(0, 20);
    return out;
  }

  // ── Dates & jobs ───────────────────────────────────────────────────────
  /* A preset against "today" → { from, to, label }, '' for an open end.
     Weeks are Monday–Sunday, as the crews work them. */
  function resolveDateRange(dates, today) {
    const t = isIso(today) ? today : localToday();
    const d = isObj(dates) ? dates : {};
    const preset = PRESET_KEYS.has(d.preset) ? d.preset : 'job_to_date';
    let from = '', to = '';
    switch (preset) {
      case 'today': from = to = t; break;
      case 'yesterday': from = to = addDays(t, -1); break;
      case 'this_week': from = mondayOf(t); to = addDays(from, 6); break;
      case 'last_week': from = addDays(mondayOf(t), -7); to = addDays(from, 6); break;
      case 'this_month': from = t.slice(0, 8) + '01'; to = addDays(fromUtc(Date.UTC(+t.slice(0, 4), +t.slice(5, 7), 1)), -1); break;
      case 'last_month': to = addDays(t.slice(0, 8) + '01', -1); from = to.slice(0, 8) + '01'; break;
      case 'last_7': from = addDays(t, -6); to = t; break;
      case 'last_30': from = addDays(t, -29); to = t; break;
      case 'custom':
        from = isIso(d.from) ? d.from : ''; to = isIso(d.to) ? d.to : '';
        if (from && to && from > to) { const x = from; from = to; to = x; }
        break;
      default: break;
    }
    return { from, to, label: rangeText(from, to) };
  }

  /* The jobs a report covers, in the order they were picked. pickedIds (the
     job picker's current selection) wins over the ids saved in the
     definition. Ids that no longer match a job come back in `missing` so the
     builder can say so; they are never an error. */
  function resolveJobs(def, projects, pickedIds) {
    const d = isObj(def) ? def : {};
    const ids = Array.isArray(pickedIds) ? pickedIds
      : (isObj(d.jobs) && Array.isArray(d.jobs.ids) ? d.jobs.ids : []);
    const byId = new Map();
    (Array.isArray(projects) ? projects : []).forEach(p => { if (p && p.id != null) byId.set(String(p.id), p); });
    const jobs = [], missing = [], seen = new Set();
    ids.forEach(id => {
      const k = String(id);
      if (seen.has(k)) return;
      seen.add(k);
      if (byId.has(k)) jobs.push(byId.get(k)); else missing.push(id);
    });
    return { jobs, missing };
  }

  // ── Column rules — the customer-safe guarantee lives here ──────────────
  /* 'available', 'locked' (internal while "Include internal data" is off) or
     'hidden' (a financial column for a role that cannot open Financials —
     or any internal column for a role that cannot see costs at all). */
  function columnState(type, key, def, perm) {
    const c = typeof type === 'string' && has(COLS, type) && typeof key === 'string' && has(COLS[type], key) ? COLS[type][key] : null;
    if (!c) return 'hidden';
    const p = perm || {};
    if (c.financial && p.canSeeFinancials === false) return 'hidden';
    if (c.internal && p.canSeeCosts === false) return 'hidden';
    if (c.internal && !(def && def.includeInternal === true)) return 'locked';
    return 'available';
  }

  /* The columns a section may print right now, in its chosen order, each a
     copy of the catalog column with its printed label (a custom label from
     the builder, else the catalog's). The renderers use nothing else. */
  function effectiveColumns(section, def, perm) {
    const type = section && section.type;
    const cat = typeof type === 'string' && has(CATALOG, type) ? CATALOG[type] : null;
    if (!cat || type === 'notes') return [];
    const chosen = Array.isArray(section.columns) ? section.columns : cat.columns.filter(c => c.def).map(c => c.key);
    const labels = isObj(section.labels) ? section.labels : {};
    const out = [], seen = new Set();
    chosen.forEach(k => {
      if (typeof k !== 'string' || seen.has(k)) return;
      seen.add(k);
      if (columnState(type, k, def, perm) !== 'available') return;
      const c = COLS[type][k];
      const label = has(labels, k) ? txt(str(labels[k], 60)) : '';
      out.push(Object.assign({}, c, { label: label || c.label }));
    });
    if (type === 'materials') {
      const summarize = isObj(section.options) ? section.options.summarize === true : false;
      if (summarize) {
        const at = out.findIndex(c => c.key === 'qty');
        const dcol = Object.assign({}, DELIVERIES_COL);
        if (at < 0) out.push(dcol); else out.splice(at + 1, 0, dcol);
      }
    }
    return out;
  }

  function hiddenFinancialCount(def, perm) {
    const d = normalizeDefinition(def);
    let n = 0;
    d.sections.forEach(s => s.columns.forEach(k => { if (columnState(s.type, k, d, perm) === 'hidden') n++; }));
    return n;
  }

  function hasInternal(def, perm) {
    const d = normalizeDefinition(def);
    return d.sections.some(s => effectiveColumns(s, d, perm).some(c => c.internal));
  }

  function costCodesFor(jobs) {
    const set = new Set();
    (Array.isArray(jobs) ? jobs : []).forEach(p => (p && Array.isArray(p.bidItems) ? p.bidItems : []).forEach(b => {
      const cc = b && txt(b.cost_code);
      if (cc) set.add(cc);
    }));
    return [...set].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
  }

  // ── Context, caches and the page's helpers ─────────────────────────────
  // Per-context working state (row indexes, bid item figures) kept off the
  // ctx object itself, so ctx stays the plain shape the builder sees.
  const STATE = new WeakMap();
  function stateOf(ctx) {
    let s = STATE.get(ctx);
    if (!s) { s = { jobs: new Map(), H: null, rangeKey: null, pos: null, trs: null }; STATE.set(ctx, s); }
    return s;
  }

  /* opts { pickedIds?, today?, now?, reportName?, userName? } → the context
     every builder call takes. A context is a snapshot of the page's data:
     make a fresh one for each render. */
  function makeContext(def, cfg, opts) {
    cfg = cfg || {};
    opts = opts || {};
    const d = normalizeDefinition(def);
    let projects = [];
    try { projects = typeof cfg.getProjects === 'function' ? (cfg.getProjects() || []) : []; } catch (_) { projects = []; }
    const picked = Array.isArray(opts.pickedIds) ? opts.pickedIds : undefined;
    const { jobs, missing } = resolveJobs(d, projects, picked);
    const today = isIso(opts.today) ? opts.today : localToday();
    let now = opts.now instanceof Date ? opts.now : opts.now != null ? new Date(opts.now) : new Date();
    if (isNaN(now)) now = new Date();
    const reportName = txt(str(opts.reportName, 120));
    const ctx = {
      cfg, perm: cfg.perm || {}, jobs, missing,
      range: resolveDateRange(d.dates, today), today, now,
      title: d.title || reportName || 'Custom Report', reportName,
      divisionLabel: txt(cfg.divisionLabel) || DIV_LABELS[cfg.division] || '',
      areaUnit: txt(cfg.areaUnit) || (cfg.division === 'turf' ? 'SF' : 'SY'),
      userName: txt(str(opts.userName, 120)),
    };
    stateOf(ctx).rangeKey = JSON.stringify(d.dates);
    return ctx;
  }

  // If the builder hands a newer definition (its dates changed) to an older
  // context, re-resolve the range rather than print the old one.
  function syncRange(def, ctx) {
    if (!isIso(ctx.today)) ctx.today = localToday();
    const st = stateOf(ctx);
    const key = JSON.stringify(def.dates);
    if (st.rangeKey === key && ctx.range) return;
    ctx.range = resolveDateRange(def.dates, ctx.today);
    st.rangeKey = key;
    st.jobs.clear();
  }

  // Run a page helper; on a missing helper, or one that throws, use ours.
  function tryHelper(fn, args, ok) {
    if (typeof fn !== 'function') return undefined;
    try {
      const v = fn.apply(null, args);
      return ok(v) ? v : undefined;
    } catch (_) { return undefined; }
  }
  const isNum = v => typeof v === 'number' && isFinite(v);

  function ownCalc(r) {
    const labor = num(r.rate) * num(r.labor_hours);
    const equip = num(r.equip_total_override) || num(r.equip_unit_cost) * num(r.equip_hours);
    return { labor_cost: labor, equip_total: equip, total_cost: labor + equip + num(r.material_cost) };
  }
  function effQty(b) {
    return num(b.quantity) + (Array.isArray(b.change_orders) ? b.change_orders : [])
      .reduce((s, co) => s + num(co && co.qty_delta), 0);
  }
  /* projForBidItem restated. Time is measured as the page measures it: from
     local midnight of the line's start date to the moment the report is
     made, in fractional days — so a line started this morning projects off
     the hours it has run, not off a whole day it has not had yet. */
  const localMidnight = iso => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)).getTime();
  function ownProjFor(b, actual, rqty, bidQty, bidTot, isComplete, now) {
    if (!(actual > 0)) return bidTot;
    if (isComplete) return actual;
    const s = dayOf(b.start_date), e = dayOf(b.target_date);
    if (s && e) {
      const at = now instanceof Date && !isNaN(now) ? now.getTime() : Date.now();
      const start = localMidnight(s);
      const elapsed = (at - start) / DAY_MS, total = (localMidnight(e) - start) / DAY_MS;
      if (elapsed > 0 && total > 0) return Math.max(actual, (actual / elapsed) * total);
    }
    if (rqty > 0) return Math.max(actual, (actual / rqty) * bidQty);
    return Math.max(actual, bidTot);
  }

  function helpersOf(ctx) {
    const st = stateOf(ctx);
    if (st.H) return st.H;
    const h = (ctx.cfg && isObj(ctx.cfg.helpers)) ? ctx.cfg.helpers : {};
    const H = {
      calc(r) {
        const v = tryHelper(h.calcDaily, [r], x => isObj(x) && isNum(x.total_cost));
        return v ? { labor_cost: num(v.labor_cost), equip_total: num(v.equip_total), total_cost: v.total_cost } : ownCalc(r);
      },
      // Imported rows carry their own total_cost; the page prefers it when it
      // is positive (and swaps in its prevailing-wage preview when that is on).
      rowCost(r) {
        const v = tryHelper(h.dailyRowCost, [r], isNum);
        if (v !== undefined) return v;
        const imported = num(r.total_cost);
        return imported > 0 ? imported : H.calc(r).total_cost;
      },
      itemComplete(b, p) {
        const v = tryHelper(h.bidItemComplete, [b, p.id], x => x !== undefined);
        return v !== undefined ? !!v : !!b.is_complete;
      },
      projDone(p) {
        const v = tryHelper(h.projIsDone, [p], x => typeof x === 'boolean');
        return v !== undefined ? v : ['complete', 'closed'].includes(txt(p.status).toLowerCase());
      },
      // undefined → no helper; null → the page says there is no figure.
      projectPct(p) {
        return tryHelper(h.bidProjectPct, [p.id], x => x === null || (isObj(x) && isNum(x.pct)));
      },
      projFor(b, actual, rqty, bidQty, bidTot, done, now) {
        const v = tryHelper(h.projForBidItem, [b, actual, rqty, bidQty, bidTot, done], isNum);
        return v !== undefined ? v : ownProjFor(b, actual, rqty, bidQty, bidTot, done, now);
      },
      // The page's _addWorkingDays: Mon–Fri less its holidays, null past the
      // ten-year cap. Ours restates it when the page does not pass it.
      workdays(iso, n) {
        if (typeof n !== 'number' || !isFinite(n) || n > MAX_WORKDAYS) return null;
        const v = tryHelper(h.addWorkingDays, [iso, n], x => x === null || isIso(x));
        return v !== undefined ? v : addWorkdays(iso, n);
      },
      projectedCost(p) { return tryHelper(h.projectedCostForProject, [p], isNum); },
      gp(contract, actual, projected) {
        const v = tryHelper(h.gpEarnedToDate, [contract, actual, projected], x => x === null || (isObj(x) && isNum(x.gp)));
        if (v !== undefined) return v ? v.gp : null;
        if (!(contract > 0) || !(actual > 0)) return null;
        const pct = projected > actual ? actual / projected : 1;
        return contract * pct - actual;
      },
      // Paving's contract COs make the revised contract original + COs; the
      // other pages have none and read the contract fields straight.
      contract(p) {
        const cos = Array.isArray(p['contract-cos']) ? p['contract-cos'] : [];
        const coTotal = cos.reduce((s, co) => s + num(co && co.amount), 0);
        const v = tryHelper(h.bidContractFigures, [p], x => isObj(x) && isNum(x.value));
        if (v) return { value: v.value, coTotal: isNum(v.coTotal) && (v.coCount || !cos.length) ? v.coTotal : coTotal };
        const value = cos.length ? (num(p['contract-amount']) || num(p['contract-value'])) + coTotal
          : (num(p['revised-amount']) || num(p['contract-amount']) || num(p['contract-value']));
        return { value, coTotal };
      },
      lineAmt(l) {
        const v = tryHelper(h.lineAmt, [l], isNum);
        return v !== undefined ? v : poNum(l.qty) * poNum(l.unit_cost);
      },
      lineTax(l) {
        const v = tryHelper(h.lineTax, [l], isNum);
        if (v !== undefined) return v;
        // Tax is a percent of the line; lines saved before the percent field
        // existed carry a dollar figure instead.
        const pct = poParse(l.tax_pct);
        return isFinite(pct) ? poNum(l.qty) * poNum(l.unit_cost) * pct / 100 : poNum(l.tax);
      },
    };
    st.H = H;
    return H;
  }

  // ── Per-job index and figures ──────────────────────────────────────────
  // A work day is a row the crew booked work to — the pages' _rowIsWorkDay.
  // A delivery that landed on a Saturday is not a day on the job.
  const isWorkRow = r => num(r.labor_hours) > 0 || num(r.equip_hours) > 0
    || num(r.equip_total_override) > 0 || num(r.quantity) > 0;

  function inPeriod(range, date) {
    if (!range.from && !range.to) return true;          // job to date: every row
    return !!date && (!range.from || date >= range.from) && (!range.to || date <= range.to);
  }

  /* One pass over a job's daily rows: each row's cost (through the page's
     dailyRowCost, once), and maps by cost code, sub code and the pair, so a
     bid item finds its rows without scanning the job. The pages' wildcard
     rule: a bid item with only a cost code takes every row on that code, one
     with only a sub code every row on that sub code, one with neither none. */
  function jobIndex(ctx, p) {
    const st = stateOf(ctx);
    const key = String(p.id);
    let ix = st.jobs.get(key);
    if (ix && ix.p === p) return ix;
    const H = helpersOf(ctx), range = ctx.range;
    const facts = [], byCC = new Map(), bySC = new Map(), byPair = new Map();
    let maxDate = '';
    const push = (m, k, f) => { const a = m.get(k); if (a) a.push(f); else m.set(k, [f]); };
    (Array.isArray(p.dailyRows) ? p.dailyRows : []).forEach(r => {
      if (!r || typeof r !== 'object') return;
      const date = dayOf(r.date);
      if (date > maxDate) maxDate = date;
      const f = {
        r, date, qty: num(r.quantity), hrs: num(r.labor_hours), cost: H.rowCost(r), work: isWorkRow(r),
        emp: r.employee ? String(r.employee) : '',
        toEnd: !range.to || !date || date <= range.to, inP: inPeriod(range, date),
      };
      facts.push(f);
      push(byCC, r.cost_code, f);
      push(bySC, r.sub_code, f);
      let m = byPair.get(r.cost_code);
      if (!m) { m = new Map(); byPair.set(r.cost_code, m); }
      push(m, r.sub_code, f);
    });
    // Which bid items each code lands on — for units, and for spend that
    // matches no bid line at all.
    const items = (Array.isArray(p.bidItems) ? p.bidItems : []).filter(b => b && typeof b === 'object');
    const unitPair = new Map(), unitCC = new Map(), unitSC = new Map();
    items.forEach(b => {
      const u = txt(b.unit);
      if (b.cost_code && b.sub_code) {
        let m = unitPair.get(b.cost_code);
        if (!m) { m = new Map(); unitPair.set(b.cost_code, m); }
        if (!m.has(b.sub_code)) m.set(b.sub_code, u);
      } else if (b.cost_code) { if (!unitCC.has(b.cost_code)) unitCC.set(b.cost_code, u); }
      else if (b.sub_code) { if (!unitSC.has(b.sub_code)) unitSC.set(b.sub_code, u); }
    });
    ix = { p, facts, byCC, bySC, byPair, maxDate, items, unitPair, unitCC, unitSC, stats: new Map(), job: null };
    // Each row's unit, by the same rule the daily table uses, worked out once:
    // whatever adds rows up across bid lines counts each row once, under it.
    facts.forEach(f => { const u = unitForRow(ix, f.r); f.on = u.on; f.unit = u.unit; });
    st.jobs.set(key, ix);
    return ix;
  }

  function rowsForItem(ix, b) {
    if (b.cost_code && b.sub_code) { const m = ix.byPair.get(b.cost_code); return (m && m.get(b.sub_code)) || []; }
    if (b.cost_code) return ix.byCC.get(b.cost_code) || [];
    if (b.sub_code) return ix.bySC.get(b.sub_code) || [];
    return [];
  }
  // Whether a row lands on any bid line, and the unit of the line it lands on
  // (the most specific match first).
  function unitForRow(ix, r) {
    const m = ix.unitPair.get(r.cost_code);
    if (m && m.has(r.sub_code)) return { on: true, unit: m.get(r.sub_code) };
    if (ix.unitCC.has(r.cost_code)) return { on: true, unit: ix.unitCC.get(r.cost_code) };
    if (ix.unitSC.has(r.sub_code)) return { on: true, unit: ix.unitSC.get(r.sub_code) };
    return { on: false, unit: '' };
  }

  /* Every figure one bid item contributes, worked out once per report.
       …End    rows dated on or before the range's end (undated rows count:
               they are part of the job's history) — "to date"
       …P      rows inside the range — "this period"
       …All    every row — what the bid page shows today */
  function itemStats(ctx, ix, b) {
    let s = ix.stats.get(b);
    if (s) return s;
    const H = helpersOf(ctx), p = ix.p;
    let qtyAll = 0, costAll = 0, qtyEnd = 0, costEnd = 0, hrsEnd = 0, qtyP = 0, costP = 0, hrsP = 0;
    const daysEnd = new Set(), empsEnd = new Set(), daysP = new Set(), qtyByDayP = new Map(), empsByDayP = new Map();
    rowsForItem(ix, b).forEach(f => {
      qtyAll += f.qty; costAll += f.cost;
      if (f.toEnd) {
        qtyEnd += f.qty; costEnd += f.cost; hrsEnd += f.hrs;
        if (f.emp) empsEnd.add(f.emp);
        if (f.work && f.date) daysEnd.add(f.date);
      }
      if (f.inP) {
        qtyP += f.qty; costP += f.cost; hrsP += f.hrs;
        if (f.date) qtyByDayP.set(f.date, (qtyByDayP.get(f.date) || 0) + f.qty);
        if (f.work && f.date) {
          daysP.add(f.date);
          if (f.emp) { let e = empsByDayP.get(f.date); if (!e) { e = new Set(); empsByDayP.set(f.date, e); } e.add(f.emp); }
        }
      }
    });
    const bidQty = effQty(b), unitCost = num(b.unit_cost), bidTotal = bidQty * unitCost;
    const complete = H.itemComplete(b, p);
    const projDone = jobDone(ctx, p);
    const worked = [...daysEnd].sort();
    const status = complete ? 'Complete' : (qtyEnd > 0 || daysEnd.size > 0) ? 'In Progress' : 'Not Started';
    s = {
      b, unit: txt(b.unit), bidQty, unitCost, bidTotal, complete, status,
      qtyAll, costAll, qtyEnd, costEnd, hrsEnd, qtyP, costP, hrsP,
      daysEnd, empsEnd, daysP, qtyByDayP, empsByDayP,
      pctEnd: complete ? 100 : bidQty > 0 ? clamp(qtyEnd / bidQty * 100, 0, 100) : 0,
      // A finished line has nothing left, whatever it under-ran by.
      remainingEnd: complete ? 0 : Math.max(0, bidQty - qtyEnd),
      remainingNow: complete ? 0 : Math.max(0, bidQty - qtyAll),
      // Typed dates stand ahead of the daily sheets. A start falls back to
      // the first day worked; a target only to the last day worked once the
      // line is complete — the last day worked on an open line is no target.
      start: dayOf(b.start_date) || worked[0] || '',
      target: dayOf(b.target_date) || (complete ? worked[worked.length - 1] || '' : ''),
      // Today's projection, whatever the range — the figure the bid page and
      // the summary strip show. Spend to the range end over time to today
      // matched neither.
      projected: H.projFor(b, costAll, qtyAll, bidQty, bidTotal, projDone || complete, ctx.now),
    };
    ix.stats.set(b, s);
    return s;
  }

  function jobDone(ctx, p) {
    const ix = jobIndex(ctx, p);
    if (ix.done === undefined) ix.done = helpersOf(ctx).projDone(p);
    return ix.done;
  }

  // The bid pages' % complete: each line by its installed share (100 once
  // marked complete), weighed by bid dollars into its cost code, and the
  // cost codes weighed into the job. Capped at 99.9 until every line is done.
  function rollPct(list) {
    let wDone = 0, wAll = 0, done = 0;
    list.forEach(x => { if (x.allDone) done++; wDone += x.weight * x.pct; wAll += x.weight; });
    if (!list.length) return null;
    const allDone = done === list.length, raw = wAll ? wDone / wAll : 0;
    return { pct: allDone ? 100 : Math.min(raw, 99.9), allDone, done, total: list.length, weight: wAll };
  }
  const itemPctParts = s => ({ pct: s.pctEnd, allDone: s.complete, weight: Math.abs(s.bidTotal) || 1 });
  function ownProjectPct(stats) {
    const groups = new Map();
    stats.forEach(s => {
      const cc = s.b.cost_code || '';
      if (!groups.has(cc)) groups.set(cc, []);
      groups.get(cc).push(itemPctParts(s));
    });
    return rollPct([...groups.values()].map(rollPct).filter(Boolean));
  }

  /* Whole-job figures for the job card and the summary strip. */
  function jobStats(ctx, p) {
    const ix = jobIndex(ctx, p);
    if (ix.job) return ix.job;
    const H = helpersOf(ctx), range = ctx.range;
    let actualAll = 0, actualEnd = 0, periodCost = 0, hrsP = 0;
    const daysEnd = new Set(), daysP = new Set();
    ix.facts.forEach(f => {
      actualAll += f.cost;
      if (f.toEnd) { actualEnd += f.cost; if (f.work && f.date) daysEnd.add(f.date); }
      if (f.inP) { periodCost += f.cost; hrsP += f.hrs; if (f.work && f.date) daysP.add(f.date); }
    });
    const stats = ix.items.map(b => itemStats(ctx, ix, b));
    let bidBudget = 0, done = 0;
    stats.forEach(s => { bidBudget += s.bidTotal; if (s.complete) done++; });
    // Quantity installed in the period, one row at a time — the rows the Daily
    // Production table lists, under the unit it lists them in. Adding up each
    // bid line's quantity instead counted a row twice wherever two lines take
    // it (a cost-code-only line beside a cost code + sub code one, which is
    // what "+ Sub Code" leaves until it is filled in), and dropped rows on no
    // line at all.
    const qtyByUnit = new Map();
    ix.facts.forEach(f => {
      if (!f.inP || !f.qty) return;
      qtyByUnit.set(f.unit, (qtyByUnit.get(f.unit) || 0) + f.qty);
    });
    // As of the range's end. When nothing is dated after it, that IS the
    // job to date, and the page's own bidProjectPct says it.
    const asOfIsNow = !range.to || ix.maxDate <= range.to;
    let pct = asOfIsNow ? H.projectPct(p) : undefined;
    if (pct === undefined) pct = ownProjectPct(stats);
    // Projected cost and GP are today's figures, as on the bid page.
    let projected = H.projectedCost(p);
    if (projected === undefined) projected = ownProjectedCost(ctx, ix, stats, actualAll);
    const cf = H.contract(p);
    ix.job = {
      actualAll, actualEnd, periodCost, hrsP, daysEnd, daysP, bidBudget, done, total: stats.length,
      qtyByUnit, pct: pct ? pct.pct : null, projected, contract: cf.value, coTotal: cf.coTotal,
      gp: H.gp(cf.value, actualAll, projected),
    };
    return ix.job;
  }

  // projectedCostForProject restated: each line's projection, plus spend on
  // codes no bid line covers (it adds on top — no line projects it), never
  // less than what has already gone out the door.
  function ownProjectedCost(ctx, ix, stats, actualAll) {
    if (jobDone(ctx, ix.p)) return actualAll;
    const H = helpersOf(ctx), done = jobDone(ctx, ix.p);
    const sumLines = stats.reduce((t, s) =>
      t + H.projFor(s.b, s.costAll, s.qtyAll, s.bidQty, s.bidTotal, done || s.complete, ctx.now), 0);
    const off = new Map();
    ix.facts.forEach(f => {
      if (!f.cost || unitForRow(ix, f.r).on) return;
      const k = (f.r.cost_code || '') + '\u0000' + (f.r.sub_code || '');
      off.set(k, (off.get(k) || 0) + f.cost);
    });
    let offBid = 0;
    off.forEach(v => { if (Math.abs(v) > 0.005) offBid += v; });
    return Math.max(sumLines + offBid, actualAll);
  }

  // ── Aggregation helpers ────────────────────────────────────────────────
  const jobKey = p => String(p && p.id);
  function sumOf(recs, k) {
    let t = 0, any = false;
    recs.forEach(r => { const v = r.c[k]; if (isNum(v)) { t += v; any = true; } });
    return any ? t : null;
  }
  // Quantities only add up within a unit. One unit → a number (and the unit
  // to print beside it); several → "1,200 SY · 40 TON".
  function qtyBy(recs, k, unitOf) {
    const m = new Map();
    recs.forEach(r => { const v = r.c[k]; if (isNum(v)) { const u = unitOf(r); m.set(u, (m.get(u) || 0) + v); } });
    if (!m.size) return { v: null, unit: '' };
    if (m.size === 1) { const [u, v] = [...m][0]; return { v, unit: u }; }
    return { v: unitList(m), unit: null };
  }
  function unitList(m) {
    return [...m].filter(([, v]) => v).map(([u, v]) => fmtQty(v) + (u ? ' ' + u : '')).join(' · ') || '0';
  }
  const recUnit = r => r.m.unit || '';
  const singleUnit = recs => { const u = new Set(recs.map(recUnit)); return u.size === 1 ? [...u][0] : null; };
  function unionSize(recs, setKey) {
    const all = new Set();
    recs.forEach(r => { const s = r.m[setKey]; if (s) s.forEach(x => all.add(jobKey(r.job) + '|' + x)); });
    return all.size;
  }
  const minIso = vals => vals.filter(Boolean).sort()[0] || null;
  const maxIso = vals => vals.filter(Boolean).sort().pop() || null;
  function sameText(recs, k) {
    let first;
    for (const r of recs) {
      const v = r.c[k] == null ? '' : r.c[k];
      if (first === undefined) first = v; else if (v !== first) return 'Multiple';
    }
    return first === undefined || first === '' ? null : first;
  }

  // ── Section builders ───────────────────────────────────────────────────
  // Each returns records { c: every cell by key, m: what totals need, job }.
  // Cells for every column are worked out, internal or not; finishBlock()
  // keeps only the effective columns, so nothing else leaves the engine.

  function jobInfoRecs(ctx, p) {
    const js = jobStats(ctx, p);
    const c = {};
    ['project-name', 'job-number', 'status', 'contract-type', 'client', 'gc', 'pm', 'super', 'estimator',
      'client-contact', 'address', 'city-state', 'scope', 'notes'].forEach(k => { c[k] = txt(p[k]) || null; });
    c['start-date'] = dayOf(p['start-date']) || txt(p['start-date']) || null;
    c['end-date'] = dayOf(p['end-date']) || txt(p['end-date']) || null;
    c['contract-days'] = txt(p['contract-days']) ? num(p['contract-days']) : null;
    c.sqft = num(p.sqft) || null;
    c.pct_complete = js.pct;
    c.days_worked = js.daysEnd.size;
    c.contract = js.contract || null;
    c.retention = txt(p.retention) ? num(p.retention) : null;
    c.invoiced = txt(p.invoiced) ? num(p.invoiced) : null;
    return [{ c, m: { unit: '' }, job: p }];
  }

  function summaryRec(ctx, p) {
    const js = jobStats(ctx, p);
    const c = {
      pct_complete: js.pct, days_worked: js.daysP.size,
      items_complete: js.total ? `${js.done} of ${js.total}` : null,
      labor_hours: js.hrsP, actual_cost: js.actualEnd, period_cost: js.periodCost, bid_budget: js.bidBudget,
      projected_cost: js.projected, contract: js.contract || null, co_total: js.coTotal, gp_earned: js.gp,
    };
    const q = js.qtyByUnit;
    let unit = '';
    if (!q.size) c.qty_period = 0;
    else if (q.size === 1) { const e = [...q][0]; unit = e[0]; c.qty_period = e[1]; }
    else c.qty_period = unitList(q);
    return { c, m: { unit, js }, job: p };
  }
  // A combined report's strip: additive figures summed across the jobs, %
  // complete weighed by each job's bid dollars (a plain mean when none has a
  // bid).
  function summaryCombined(recs) {
    const c = {}, js = recs.map(r => r.m.js);
    ['days_worked', 'labor_hours', 'actual_cost', 'period_cost', 'bid_budget', 'projected_cost', 'co_total']
      .forEach(k => { c[k] = sumOf(recs, k); });
    ['contract', 'gp_earned'].forEach(k => { c[k] = sumOf(recs, k); });
    const withPct = js.filter(j => isNum(j.pct));
    const w = withPct.reduce((t, j) => t + Math.abs(j.bidBudget), 0);
    c.pct_complete = !withPct.length ? null
      : w ? withPct.reduce((t, j) => t + Math.abs(j.bidBudget) * j.pct, 0) / w
        : withPct.reduce((t, j) => t + j.pct, 0) / withPct.length;
    const done = js.reduce((t, j) => t + j.done, 0), total = js.reduce((t, j) => t + j.total, 0);
    c.items_complete = total ? `${done} of ${total}` : null;
    const q = new Map();
    js.forEach(j => j.qtyByUnit.forEach((v, u) => q.set(u, (q.get(u) || 0) + v)));
    let unit = '';
    if (!q.size) c.qty_period = 0;
    else if (q.size === 1) { const e = [...q][0]; unit = e[0]; c.qty_period = e[1]; }
    else c.qty_period = unitList(q);
    return { c, m: { unit }, job: null };
  }

  function bidProgressRecs(ctx, p, opts) {
    const ix = jobIndex(ctx, p);
    const codes = opts.costCodes && opts.costCodes.length ? new Set(opts.costCodes) : null;
    const out = [];
    ix.items.forEach(b => {
      if (codes && !codes.has(txt(b.cost_code))) return;
      const s = itemStats(ctx, ix, b);
      if (opts.hideNotStarted && s.status === 'Not Started') return;
      if (opts.hideComplete && s.status === 'Complete') return;
      out.push({
        c: {
          cost_code: txt(b.cost_code), sub_code: txt(b.sub_code), description: txt(b.description) || null, unit: s.unit,
          bid_qty: s.bidQty, installed_to_date: s.qtyEnd, installed_period: s.qtyP, remaining_qty: s.remainingEnd,
          pct_complete: s.pctEnd, start_date: s.start || null, target_date: s.target || null, status: s.status,
          days_worked: s.daysEnd.size, unit_cost: s.unitCost, bid_total: s.bidTotal, actual_cost: s.costEnd,
          variance: s.bidTotal - s.costEnd, projected_cost: s.projected, labor_hours: s.hrsEnd,
          crew_size: s.empsEnd.size,
          cost_per_unit: s.qtyEnd > 0 ? s.costEnd / s.qtyEnd : null,
          units_per_mh: s.hrsEnd > 0 ? s.qtyEnd / s.hrsEnd : null,
        },
        m: { unit: s.unit, pct: itemPctParts(s), days: s.daysEnd, emps: s.empsEnd, status: s.status, cc: txt(b.cost_code),
          rows: rowsForItem(ix, b) },
        job: p,
      });
    });
    return out;
  }
  /* The rows behind a set of bid-progress records, each once — or null when
     no row is shared, so the plain per-line sums stand (they ARE the rows).
     A cost-code-only line takes every row on its code, so beside a cost code
     + sub code line the two share rows, and adding the lines up would count
     those rows twice. */
  function sharedRows(recs) {
    const seen = new Set();
    let shared = false;
    recs.forEach(r => (r.m.rows || []).forEach(f => { if (seen.has(f)) shared = true; else seen.add(f); }));
    return shared ? [...seen] : null;
  }
  function factQty(facts, pick) {
    const m = new Map();
    facts.forEach(f => { if (pick(f) && f.qty) m.set(f.unit, (m.get(f.unit) || 0) + f.qty); });
    if (!m.size) return 0;
    if (m.size === 1) return [...m][0][1];
    return unitList(m);
  }
  function bidProgressAgg(recs) {
    const c = {};
    const one = singleUnit(recs);
    ['bid_qty', 'installed_to_date', 'installed_period', 'remaining_qty'].forEach(k => { c[k] = qtyBy(recs, k, recUnit).v; });
    c.unit = one;
    // % complete the way bidProjectPct rolls it: each cost code first (held
    // at 99.9 until all its lines are signed off), then the codes weighed
    // into the whole — within each job on a combined report.
    const byCode = new Map();
    recs.forEach(r => {
      const k = jobKey(r.job) + '\u0000' + r.m.cc;
      if (!byCode.has(k)) byCode.set(k, []);
      byCode.get(k).push(r.m.pct);
    });
    const pr = rollPct([...byCode.values()].map(rollPct).filter(Boolean));
    c.pct_complete = pr ? pr.pct : null;
    const st = new Set(recs.map(r => r.m.status));
    // A totals / subtotal line only states a status every item shares — a
    // blended 'In Progress' under a mix of Complete and Not Started reads oddly.
    c.status = st.size === 1 ? [...st][0] : null;
    c.start_date = minIso(recs.map(r => r.c.start_date));
    c.target_date = maxIso(recs.map(r => r.c.target_date));
    c.days_worked = unionSize(recs, 'days');
    ['bid_total', 'actual_cost', 'variance', 'projected_cost', 'labor_hours'].forEach(k => { c[k] = sumOf(recs, k); });
    c.crew_size = unionSize(recs, 'emps');
    let inst = sumOf(recs, 'installed_to_date');
    const rows = sharedRows(recs);
    if (rows) {
      // Lines that share rows: what went in, what it cost and the hours are
      // the rows', counted once (to the range end, as each line's are).
      // Remaining has no single answer when two lines claim the same
      // quantity, so the total does not invent one.
      const toEnd = rows.filter(f => f.toEnd);
      c.installed_to_date = factQty(toEnd, () => true);
      c.installed_period = factQty(rows, f => f.inP);
      c.remaining_qty = null;
      c.actual_cost = toEnd.reduce((t, f) => t + f.cost, 0);
      c.labor_hours = toEnd.reduce((t, f) => t + f.hrs, 0);
      c.variance = (c.bid_total || 0) - c.actual_cost;
      inst = typeof c.installed_to_date === 'number' ? c.installed_to_date : 0;
    }
    c.cost_per_unit = one !== null && inst > 0 ? c.actual_cost / inst : null;
    c.units_per_mh = one !== null && c.labor_hours > 0 ? inst / c.labor_hours : null;
    return c;
  }

  /* The production-rate view: per bid item worked in the period, how much a
     day, the best day, and — off what is left on the line TODAY — how many
     work days to go and the working day (Mon–Fri, less the pages' holidays)
     that lands on. Remaining is today's,
     not the range end's, because the finish is projected forward from today. */
  function productionRecs(ctx, p, opts) {
    const ix = jobIndex(ctx, p), H = helpersOf(ctx);
    const codes = opts.costCodes && opts.costCodes.length ? new Set(opts.costCodes) : null;
    const out = [];
    ix.items.forEach(b => {
      if (codes && !codes.has(txt(b.cost_code))) return;
      const s = itemStats(ctx, ix, b);
      const days = s.daysP.size;
      if (!days) return;
      const avg = s.qtyP / days;
      let best = null;
      s.qtyByDayP.forEach(v => { if (best === null || v > best) best = v; });
      if (best !== null && best <= 0) best = null;
      const remaining = s.remainingNow;
      // The epsilon keeps 1.2 MI left at 0.1 a day at 12 days: the division
      // comes out 12.000000000000002, and a bare ceil would say 13.
      let est = remaining <= 0 ? 0 : avg > 0 ? Math.ceil(remaining / avg - 1e-9) : null;
      // Past the page's ten-year cap there is no honest number of days left
      // either: both print "—", as the Schedule Estimator does.
      if (est !== null && est > MAX_WORKDAYS) est = null;
      let crew = 0;
      s.empsByDayP.forEach(e => { crew += e.size; });
      out.push({
        c: {
          cost_code: txt(b.cost_code), sub_code: txt(b.sub_code), description: txt(b.description) || null, unit: s.unit,
          qty_period: s.qtyP, days_period: days, avg_per_day: avg, best_day: best, remaining_qty: remaining,
          est_days_left: est, projected_finish: est > 0 ? H.workdays(ctx.today, est) : null,
          labor_hours: s.hrsP, units_per_mh: s.hrsP > 0 ? s.qtyP / s.hrsP : null,
          cost_per_unit: s.qtyP > 0 ? s.costP / s.qtyP : null, crew_avg: crew / days,
        },
        m: { unit: s.unit, days: s.daysP, byDay: s.qtyByDayP, empsByDay: s.empsByDayP, costP: s.costP },
        job: p,
      });
    });
    return out;
  }
  function productionAgg(recs, ctx) {
    const c = {};
    const one = singleUnit(recs);
    c.unit = one;
    c.qty_period = qtyBy(recs, 'qty_period', recUnit).v;
    c.remaining_qty = qtyBy(recs, 'remaining_qty', recUnit).v;
    c.days_period = unionSize(recs, 'days');
    c.labor_hours = sumOf(recs, 'labor_hours');
    // The job finishes when its last line does.
    const ests = recs.map(r => r.c.est_days_left);
    c.est_days_left = ests.some(v => v === null) ? null : Math.max(0, ...ests);
    c.projected_finish = c.est_days_left > 0 ? helpersOf(ctx).workdays(ctx.today, c.est_days_left) : null;
    // Day-by-day across the lines, keyed by job so two jobs' Mondays stay two.
    const byDay = new Map(), crewByDay = new Map();
    recs.forEach(r => {
      const jk = jobKey(r.job);
      r.m.days.forEach(d => { if (!crewByDay.has(jk + '|' + d)) crewByDay.set(jk + '|' + d, new Set()); });
      r.m.byDay.forEach((v, d) => byDay.set(jk + '|' + d, (byDay.get(jk + '|' + d) || 0) + v));
      r.m.empsByDay.forEach((e, d) => { const s = crewByDay.get(jk + '|' + d); if (s) e.forEach(x => s.add(x)); });
    });
    const q = sumOf(recs, 'qty_period'), cost = recs.reduce((t, r) => t + r.m.costP, 0);
    if (one !== null) {
      c.avg_per_day = c.days_period ? q / c.days_period : null;
      let best = null;
      byDay.forEach(v => { if (best === null || v > best) best = v; });
      c.best_day = best !== null && best > 0 ? best : null;
      c.units_per_mh = c.labor_hours > 0 ? q / c.labor_hours : null;
      c.cost_per_unit = q > 0 ? cost / q : null;
    }
    let crew = 0;
    crewByDay.forEach(s => { crew += s.size; });
    c.crew_avg = crewByDay.size ? crew / crewByDay.size : null;
    return c;
  }

  const DP_SUM = ['quantity', 'labor_hours', 'labor_cost', 'equip_hours', 'equip_cost', 'material_cost', 'total_cost'];
  const DP_TEXT = ['unit', 'field_type', 'employee', 'job_class', 'equipment', 'material', 'supplier', 'po_num'];
  function dailyRecs(ctx, p, opts) {
    const ix = jobIndex(ctx, p), H = helpersOf(ctx);
    const codes = opts.costCodes && opts.costCodes.length ? new Set(opts.costCodes) : null;
    let out = [];
    ix.facts.forEach(f => {
      if (!f.inP) return;
      const r = f.r;
      if (codes && !codes.has(txt(r.cost_code))) return;
      const calc = H.calc(r);
      const unit = unitForRow(ix, r).unit;
      out.push({
        c: {
          date: f.date || null, cost_code: txt(r.cost_code), sub_code: txt(r.sub_code), quantity: f.qty, unit,
          field_type: txt(r.field_type), employee: txt(r.employee), job_class: txt(r.job_class),
          labor_hours: f.hrs, rate: num(r.rate), labor_cost: calc.labor_cost, equipment: txt(r.equipment),
          equip_hours: num(r.equip_hours), equip_cost: calc.equip_total, material: txt(r.material),
          supplier: txt(r.supplier), po_num: txt(r.po_num), material_cost: num(r.material_cost), total_cost: f.cost,
        },
        m: { unit },
        job: p,
      });
    });
    if (opts.summarize) {
      const groups = new Map();
      out.forEach(r => {
        const k = (r.c.date || '') + '\u0000' + r.c.cost_code + '\u0000' + r.c.sub_code;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      out = [...groups.values()].map(g => {
        if (g.length === 1) return g[0];
        const c = { date: g[0].c.date, cost_code: g[0].c.cost_code, sub_code: g[0].c.sub_code };
        DP_SUM.forEach(k => { c[k] = sumOf(g, k) || 0; });
        DP_TEXT.forEach(k => { c[k] = sameText(g, k); });
        // Rates that differ blend into the labour cost per labour hour.
        const rates = new Set(g.map(r => r.c.rate));
        c.rate = rates.size === 1 ? g[0].c.rate : c.labor_hours > 0 ? c.labor_cost / c.labor_hours : null;
        return { c, m: { unit: g[0].m.unit }, job: p };
      });
    }
    return out;
  }
  function dailyAgg(recs) {
    const c = {};
    const q = qtyBy(recs, 'quantity', recUnit);
    c.quantity = q.v;
    c.unit = singleUnit(recs);
    ['labor_hours', 'labor_cost', 'equip_hours', 'equip_cost', 'material_cost', 'total_cost'].forEach(k => { c[k] = sumOf(recs, k); });
    c.rate = c.labor_hours > 0 ? c.labor_cost / c.labor_hours : null;
    return c;
  }

  function posByJob(ctx) {
    const st = stateOf(ctx);
    if (st.pos) return st.pos;
    const m = new Map();
    let list = [];
    try { list = typeof ctx.cfg.getPurchaseOrders === 'function' ? (ctx.cfg.getPurchaseOrders() || []) : []; } catch (_) { list = []; }
    (Array.isArray(list) ? list : []).forEach(po => {
      if (!po || po.project_id == null || po.project_id === '') return;
      const k = String(po.project_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(po);
    });
    st.pos = m;
    return m;
  }
  function materialRecs(ctx, p, opts) {
    const H = helpersOf(ctx), range = ctx.range;
    let out = [];
    (posByJob(ctx).get(jobKey(p)) || []).forEach(po => (Array.isArray(po.lines) ? po.lines : []).forEach(l => {
      if (!l || typeof l !== 'object') return;
      const date = dayOf(l.date);
      if (!inPeriod(range, date)) return;
      const qty = poNum(l.qty), amt = H.lineAmt(l), tax = H.lineTax(l);
      // The PO page adds a blank delivery line with every new order. A line
      // carrying only a tax or freight dollar figure is not blank: the PO
      // page's totals count its tax, so this does too.
      if (!qty && !amt && !tax && !txt(l.invoice_num)) return;
      out.push({
        c: {
          date: date || null, po_number: txt(po.po_number), supplier: txt(po.supplier), material: txt(po.title),
          invoice_num: txt(l.invoice_num), qty, cost_code: txt(po.cost_code), sub_code: txt(po.sub_code),
          po_status: cap1(po.status), unit_cost: poNum(l.unit_cost), tax, line_total: amt + tax, deliveries: 1,
        },
        m: { unit: txt(po.title).toLowerCase(), amt },
        job: p,
      });
    }));
    if (opts.summarize) {
      const groups = new Map();
      out.forEach(r => {
        const k = r.c.material.toLowerCase() + '\u0000' + r.c.supplier.toLowerCase();
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      out = [...groups.values()].map(g => {
        const c = { material: g[0].c.material, supplier: g[0].c.supplier, deliveries: g.length };
        ['qty', 'tax', 'line_total'].forEach(k => { c[k] = sumOf(g, k) || 0; });
        ['po_number', 'invoice_num', 'cost_code', 'sub_code', 'po_status'].forEach(k => { c[k] = sameText(g, k); });
        const dates = g.map(r => r.c.date).filter(Boolean).sort();
        c.date = !dates.length ? null : dates[0] === dates[dates.length - 1] ? dates[0] : rangeText(dates[0], dates[dates.length - 1]);
        const amt = g.reduce((t, r) => t + r.m.amt, 0);
        c.unit_cost = c.qty ? amt / c.qty : null;
        return { c, m: { unit: g[0].m.unit, amt }, job: p };
      });
    }
    return out;
  }
  function materialAgg(recs) {
    // Tons of base and gallons of tack do not add, so the quantity is totalled
    // only when every line is the same material.
    const q = qtyBy(recs, 'qty', recUnit);
    return { qty: q.unit === null ? null : q.v, deliveries: sumOf(recs, 'deliveries'),
      tax: sumOf(recs, 'tax'), line_total: sumOf(recs, 'line_total') };
  }

  function truckingByJob(ctx) {
    const st = stateOf(ctx);
    if (st.trs) return st.trs;
    const m = new Map();
    let list = [];
    try { list = typeof ctx.cfg.getTruckingEntries === 'function' ? (ctx.cfg.getTruckingEntries() || []) : []; } catch (_) { list = []; }
    (Array.isArray(list) ? list : []).forEach(t => {
      if (!t || t.project_id == null || t.project_id === '') return;
      const k = String(t.project_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    });
    st.trs = m;
    return m;
  }
  function truckingRecs(ctx, p) {
    const out = [];
    (truckingByJob(ctx).get(jobKey(p)) || []).forEach(t => {
      const date = dayOf(t.date);
      if (!inPeriod(ctx.range, date)) return;
      const rate = num(t.rate), hours = num(t.hours);
      out.push({
        c: {
          date: date || null, tr_number: txt(t.tr_number), truck_type: txt(t.truck_type),
          material_hauled: txt(t.material_hauled), loads: num(t.loads), status: cap1(t.status),
          cost_code: txt(t.cost_code), sub_code: txt(t.sub_code), notes: txt(t.notes), driver: txt(t.driver),
          hours, rate, cost: t._payroll ? num(t._total) : rate * hours,
        },
        m: { unit: '' },
        job: p,
      });
    });
    return out;
  }
  const truckingAgg = recs => ({ loads: sumOf(recs, 'loads'), hours: sumOf(recs, 'hours'), cost: sumOf(recs, 'cost') });

  // Contract change orders move the contract (paving keeps them); quantity
  // change orders move a bid line. A CO with a date is held to the range; one
  // without is always shown.
  function changeOrderRecs(ctx, p, opts) {
    const kinds = new Set(opts.kinds || []);
    const range = ctx.range, keep = d => !d || inPeriod(range, d);
    const out = [];
    if (kinds.has('contract')) {
      (Array.isArray(p['contract-cos']) ? p['contract-cos'] : []).forEach(co => {
        if (!co || typeof co !== 'object') return;
        const date = dayOf(co.date);
        if (!keep(date)) return;
        out.push({ c: { kind: 'Contract', date: date || null, number: txt(co.number), cost_code: null, sub_code: null,
          description: txt(co.note), qty_change: null, amount: num(co.amount) }, m: { unit: '' }, job: p });
      });
    }
    if (kinds.has('quantity')) {
      jobIndex(ctx, p).items.forEach(b => (Array.isArray(b.change_orders) ? b.change_orders : []).forEach(co => {
        if (!co || typeof co !== 'object') return;
        const date = dayOf(co.date);
        if (!keep(date)) return;
        out.push({ c: { kind: 'Quantity', date: date || null, number: txt(co.number), cost_code: txt(b.cost_code),
          sub_code: txt(b.sub_code), description: txt(co.note), qty_change: num(co.qty_delta), amount: null },
          m: { unit: txt(b.unit) }, job: p });
      }));
    }
    return out;
  }

  function scheduleRecs(ctx, p) {
    const ix = jobIndex(ctx, p);
    const end = dayOf(p['end-date']);
    const out = [];
    ix.items.forEach(b => {
      if (!dayOf(b.start_date) && !dayOf(b.target_date)) return;
      const s = itemStats(ctx, ix, b);
      out.push({
        c: {
          cost_code: txt(b.cost_code), sub_code: txt(b.sub_code), description: txt(b.description) || null,
          start_date: s.start || null, target_date: s.target || null, status: s.status, pct_complete: s.pctEnd,
          days_left: s.target && !s.complete ? daysBetween(ctx.today, s.target) : null,
        },
        m: { unit: s.unit, bar: { start: s.start, target: s.target, pct: s.pctEnd, end } },
        job: p,
      });
    });
    return out;
  }

  const BUILD = {
    job_info: jobInfoRecs, bid_progress: bidProgressRecs, production_kpis: productionRecs,
    daily_production: dailyRecs, materials: materialRecs, trucking: truckingRecs,
    change_orders: changeOrderRecs, schedule: scheduleRecs,
  };
  const AGG = {
    bid_progress: bidProgressAgg, production_kpis: productionAgg, daily_production: dailyAgg,
    materials: materialAgg, trucking: truckingAgg,
  };
  const byDateThen = (a, b, more) => {
    const da = a.c.date || '\uffff', db = b.c.date || '\uffff';
    return da < db ? -1 : da > db ? 1 : more(a, b);
  };
  const cmp = (x, y) => (x || '') < (y || '') ? -1 : (x || '') > (y || '') ? 1 : 0;
  const SORT = {
    daily_production: (a, b) => byDateThen(a, b, (x, y) => cmp(x.c.cost_code, y.c.cost_code) || cmp(x.c.sub_code, y.c.sub_code)),
    materials: (a, b) => byDateThen(a, b, (x, y) => cmp(x.c.po_number, y.c.po_number)),
    trucking: (a, b) => byDateThen(a, b, (x, y) => cmp(x.c.tr_number, y.c.tr_number)),
    change_orders: (a, b) => byDateThen(a, b, (x, y) => cmp(x.c.kind, y.c.kind)),
    schedule: (a, b) => cmp(a.c.start_date || a.c.target_date || '\uffff', b.c.start_date || b.c.target_date || '\uffff'),
  };
  const jobLabel = p => {
    const name = txt(p && p['project-name']) || 'Untitled job', no = txt(p && p['job-number']);
    return no ? `${name} · ${no}` : name;
  };

  // How a table's rows fall into groups: [{ key, label }] per record.
  function groupOf(type, opts, combined) {
    if (type === 'bid_progress' && opts.groupBy === 'cost_code') {
      return r => {
        const cc = r.m.cc || '(No cost code)';
        return combined ? { key: jobKey(r.job) + '\u0000' + cc, label: jobLabel(r.job) + ' — ' + cc } : { key: cc, label: cc };
      };
    }
    if (type === 'daily_production' && opts.groupBy !== 'none') {
      if (opts.groupBy === 'date') return r => ({ key: r.c.date || '', label: r.c.date ? fmtDate(r.c.date) : 'No date' });
      if (opts.groupBy === 'week') {
        return r => { const m = r.c.date ? mondayOf(r.c.date) : ''; return { key: m, label: m ? 'Week of ' + fmtDate(m) : 'No date' }; };
      }
      return r => ({ key: r.c.sub_code, label: r.c.sub_code || '(No sub code)' });
    }
    return null;
  }

  /* Records → the block the renderers draw: sorted, grouped, subtotalled,
     totalled, and cut down to the effective columns. */
  function finishBlock(type, job, recs, cols, opts, ctx, combined) {
    const keys = cols.map(c => c.key);
    if (SORT[type]) recs = recs.slice().sort(SORT[type]);
    // Rows of zero quantity are noise on a customer's quantity log — unless
    // the report is showing hours or cost, where a zero-quantity row is real.
    if (type === 'daily_production' && opts.hideZeroQty && !cols.some(c => c.internal)) {
      recs = recs.filter(r => Math.abs(r.c.quantity) > 1e-9);
    }
    const project = cells => {
      const out = {};
      keys.forEach(k => { out[k] = cells[k] === undefined ? null : cells[k]; });
      return out;
    };
    const firstKey = keys[0];
    const labelled = (cells, label) => {
      if (firstKey && !NUMERIC[cols[0].type] && (cells[firstKey] == null || cells[firstKey] === '')) cells[firstKey] = label;
      return cells;
    };
    const toRow = r => {
      const cells = project(r.c);
      if (combined && keys.includes('_job')) cells._job = jobLabel(r.job);
      const row = { cells };
      if (r.m.unit && (type === 'change_orders' || type === 'summary_kpis')) row.unit = r.m.unit;
      if (combined) row.job = r.job;
      if (r.m.bar) row.bar = r.m.bar;
      return row;
    };
    const agg = AGG[type];
    const gf = groupOf(type, opts, combined);
    const groups = [];
    if (gf) {
      const map = new Map();
      recs.forEach(r => {
        const g = gf(r);
        if (!map.has(g.key)) { map.set(g.key, { key: g.key, label: g.label, recs: [] }); groups.push(map.get(g.key)); }
        map.get(g.key).recs.push(r);
      });
      // Days and weeks already fall in date order (the rows are sorted by
      // date); sub codes read better by name.
      if (type === 'daily_production' && opts.groupBy === 'sub_code') groups.sort((a, b) => cmp(a.key, b.key));
    } else if (recs.length) {
      groups.push({ label: null, recs });
    }
    const wantSub = !!agg && !!gf && (type !== 'bid_progress' || opts.subtotals !== false);
    // A group of one row has no subtotal: it would only repeat the row.
    const out = groups.map(g => ({
      label: g.label,
      rows: g.recs.map(toRow),
      subtotal: wantSub && g.recs.length > 1 ? labelled(project(agg(g.recs, ctx)), 'Subtotal') : null,
    }));
    const totals = agg && opts.totals && recs.length ? labelled(project(agg(recs, ctx)), 'Totals') : null;
    return { job, groups: out, totals, empty: !recs.length };
  }

  /* One section's data: { type, title, columns, blocks: [{ job, groups:
     [{ label, rows: [{ cells }], subtotal }], totals, empty }] }. Separate
     layout: a block per job, in job order. Combined: one block (job null) and
     a leading Job column on tables. Cells are raw — numbers, 'YYYY-MM-DD',
     text — and hold only the effective columns. */
  function buildSectionData(section, def, ctx) {
    const d = normalizeDefinition(def);
    syncRange(d, ctx);
    const s = normSection(section, new Set());
    if (!s) return { type: String(section && section.type || ''), title: '', columns: [], blocks: [] };
    const type = s.type, cat = CATALOG[type];
    const title = txt(s.title) || cat.label;
    if (type === 'notes') {
      return { type, title, columns: [], text: s.text || '',
        blocks: [{ job: null, groups: [], totals: null, empty: !txt(s.text) }] };
    }
    const cols = effectiveColumns(s, d, ctx.perm);
    const combined = d.layout === 'combined';
    const opts = s.options;
    const jobs = ctx.jobs || [];
    let blocks;
    if (type === 'summary_kpis') {
      const recs = jobs.map(p => summaryRec(ctx, p));
      blocks = combined
        ? [kpiBlock(null, recs.length ? [summaryCombined(recs)] : [], cols)]
        : recs.map(r => kpiBlock(r.job, [r], cols));
    } else if (combined) {
      const recs = [];
      jobs.forEach(p => BUILD[type](ctx, p, opts).forEach(r => recs.push(r)));
      blocks = [finishBlock(type, null, recs, cat.table ? [JOB_COL].concat(cols) : cols, opts, ctx, true)];
    } else {
      blocks = jobs.map(p => finishBlock(type, p, BUILD[type](ctx, p, opts), cols, opts, ctx, false));
    }
    return { type, title, columns: combined && cat.table ? [JOB_COL].concat(cols) : cols, blocks };
  }
  function kpiBlock(job, recs, cols) {
    const rows = recs.map(r => {
      const cells = {};
      cols.forEach(c => { cells[c.key] = r.c[c.key] === undefined ? null : r.c[c.key]; });
      const row = { cells };
      if (r.m.unit) row.unit = r.m.unit;
      return row;
    });
    return { job, groups: rows.length ? [{ label: null, rows, subtotal: null }] : [], totals: null, empty: !rows.length };
  }

  // ── Report HTML ────────────────────────────────────────────────────────
  // The Job Summary's masthead (paving.html, mastheadHTML) is the "DataWatch
  // header" the user asked for: the same green wordmark, sub-label and rule.
  // data-dw-brand on it tells report-branding.js's dwBrand() the report is
  // already branded, so its plain band is not stacked on top.
  const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#111;background:#fff;padding:22px;line-height:1.3}
.masthead{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;border-bottom:3px solid #22c55e;padding-bottom:8px;margin-bottom:12px}
.mast-word{font-size:24px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#22c55e;line-height:1}
.mast-sub{font-size:8px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#6b7280;margin-top:5px}
.mast-meta{text-align:right}
.mast-rpt{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#111}
.mast-date{font-size:8px;color:#9ca3af;margin-top:3px}
.mast-internal{display:inline-block;background:#b91c1c;color:#fff;font-size:8px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:3px 7px;border-radius:3px;margin-bottom:5px}
h1.rpt-title{font-size:17px;font-weight:800;margin-bottom:3px}
p.meta{font-size:9.5px;color:#555;margin-bottom:10px}
p.intro{font-size:11px;line-height:1.45;margin:0 0 10px}
p.none{color:#888;font-style:italic;margin:10px 0}
.job-band{background:#f0fdf4;border-left:4px solid #22c55e;padding:6px 10px;margin:16px 0 2px;font-size:12.5px;font-weight:800}
.job-band .jb-sub{font-weight:500;color:#555;font-size:11px}
.pb{page-break-before:always;break-before:page}
.sec{margin-top:12px}
h3{font-size:11px;font-weight:700;margin:0 0 5px;text-transform:uppercase;letter-spacing:.05em;color:#333}
.sum-bar{display:flex;align-items:center;gap:18px;background:#f3f9f4;border:1px solid #c6e0cb;border-radius:4px;padding:8px 14px;margin-bottom:6px;flex-wrap:wrap}
.sum-metric{display:flex;flex-direction:column;gap:1px}
.sum-label{font-size:7px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#666}
.sum-val{font-size:12px;font-weight:700;color:#000}
.ji{border:1px solid #d9dee4;border-radius:4px;padding:8px 10px;margin-bottom:6px;page-break-inside:avoid;break-inside:avoid}
.ji-h{font-weight:800;font-size:11.5px;margin-bottom:6px}
.ji-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 14px}
.ji-wide{grid-column:1/-1}
.ji-span2{grid-column:span 2}
.ji-k{font-size:7.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#666}
.ji-v{font-size:11px;font-weight:600;word-break:break-word;white-space:pre-line}
table.t{width:100%;border-collapse:collapse;margin-bottom:4px}
thead{display:table-header-group}
tr{page-break-inside:avoid;break-inside:avoid}
th,td{border:1px solid #ccc;padding:3px 6px;vertical-align:top;text-align:left}
th{background:#f0f0f0;font-size:8px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}
td.num,th.num{text-align:right;white-space:nowrap}
td.num.wrap{white-space:normal}
table.dense th,table.dense td{padding:2px 4px}
table.dense td{font-size:9.5px}
td.dt{white-space:nowrap}
tr.grp td{background:#e8f5e9;font-weight:700;font-size:10px}
tr.sub td{background:#eef2f6;font-weight:700;font-style:italic}
tr.tot td{background:#f6f6f6;font-weight:800;border-top:2px solid #999}
p.empty{color:#888;font-style:italic;font-size:10px;padding:2px 0 4px}
.notes p{margin:0 0 7px;line-height:1.45;font-size:11px}
th.tlh{width:32%}
td.tlc{padding:4px 6px;vertical-align:middle}
.tl{position:relative;height:12px;background:#f3f4f6;border-radius:2px;min-width:120px}
.tl-bar{position:absolute;top:2px;height:8px;background:#dcfce7;border:1px solid #16a34a;border-radius:2px;overflow:hidden;min-width:3px}
.tl-fill{height:100%;background:#16a34a}
.tl-end{position:absolute;top:-2px;bottom:-2px;width:0;border-left:2px dashed #b91c1c}
.tl-now{position:absolute;top:-2px;bottom:-2px;width:0;border-left:1px solid #2563eb}
p.legend{font-size:8px;color:#777;margin-top:2px}
.rpt-foot{margin-top:18px;padding-top:6px;border-top:1px solid #ddd;font-size:8.5px;color:#777;display:flex;justify-content:space-between;gap:12px}
@media print{body{padding:0}h3{page-break-after:avoid;break-after:avoid}.masthead,.sum-bar,.job-band{page-break-inside:avoid;break-inside:avoid}}
@media screen and (max-width:640px){body{padding:12px}.ji-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media screen{.tw{overflow-x:auto}}
`;

  const divisionSub = ctx => {
    const l = txt(ctx.divisionLabel);
    if (!l) return 'Force Corp Tracking';
    return /division$/i.test(l) ? l : l + ' Division';
  };
  function jobsMeta(jobs) {
    if (!jobs.length) return 'No jobs selected';
    if (jobs.length === 1) {
      const p = jobs[0], no = txt(p['job-number']);
      return (txt(p['project-name']) || 'Untitled job') + (no ? ' · Job #' + no : '');
    }
    const names = jobs.slice(0, 8).map(p => txt(p['project-name']) || 'Untitled job');
    return `${jobs.length} jobs: ${names.join(', ')}${jobs.length > 8 ? `, +${jobs.length - 8} more` : ''}`;
  }
  const reportTitle = (def, ctx) => def.title || ctx.reportName || 'Custom Report';
  const cellText = (v, c, row) => formatCell(v, c.type, row && row.unit && (c.key === 'qty_change' || c.key === 'qty_period') && isNum(v) ? row.unit : '', c.key === 'qty_change');

  function notesHtml(text) {
    return String(text || '').trim().split(/\n\s*\n/).filter(x => x.trim())
      .map(p => '<p>' + escHtml(p.trim()).replace(/\r?\n/g, '<br>') + '</p>').join('');
  }

  function cardHtml(row, cols, ctx, heading) {
    const items = cols.map(c => {
      let v = cellText(row.cells[c.key], c, row);
      if (c.key === 'sqft' && isNum(row.cells.sqft)) v += ' ' + ctx.areaUnit;
      // Scope and notes run to paragraphs and take the card's width. A street
      // address is one line: two columns hold it, and the field before it (the
      // GC, in the default order) keeps its row instead of sitting alone.
      const wide = c.key === 'scope' || c.key === 'notes' ? ' ji-wide' : c.key === 'address' ? ' ji-span2' : '';
      return `<div class="ji-i${wide}"><div class="ji-k">${escHtml(c.label)}</div><div class="ji-v">${escHtml(v)}</div></div>`;
    }).join('');
    return `<div class="ji">${heading ? `<div class="ji-h">${escHtml(heading)}</div>` : ''}<div class="ji-grid">${items}</div></div>`;
  }

  function kpiHtml(row, cols) {
    return '<div class="sum-bar">' + cols.map(c =>
      `<div class="sum-metric"><div class="sum-label">${escHtml(c.label)}</div><div class="sum-val">${escHtml(cellText(row.cells[c.key], c, row))}</div></div>`
    ).join('') + '</div>';
  }

  // The schedule's bars: start → target across the span of every date in the
  // block (and the job's end date), filled to % complete. Absolutely
  // positioned divs, so they print as drawn with no script or SVG.
  function barSpan(block) {
    const ds = [];
    block.groups.forEach(g => g.rows.forEach(r => { if (r.bar) ds.push(r.bar.start, r.bar.target, r.bar.end); }));
    const s = ds.filter(Boolean).sort();
    if (!s.length) return null;
    const a = s[0], b = s[s.length - 1];
    return { a, days: Math.max(1, daysBetween(a, b)) };
  }
  function barHtml(bar, span, today) {
    if (!bar || !span) return '<td class="tlc"></td>';
    const pos = d => clamp(daysBetween(span.a, d) / span.days * 100, 0, 100);
    const s = bar.start || bar.target, e = bar.target || bar.start;
    let inner = '';
    if (s) {
      const width = Math.max(1.5, pos(e) - pos(s)), left = Math.min(pos(s), 100 - width);
      inner += `<div class="tl-bar" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"><div class="tl-fill" style="width:${clamp(bar.pct || 0, 0, 100).toFixed(1)}%"></div></div>`;
    }
    if (bar.end) inner += `<div class="tl-end" style="left:${pos(bar.end).toFixed(2)}%"></div>`;
    if (today >= span.a && daysBetween(span.a, today) <= span.days) inner += `<div class="tl-now" style="left:${pos(today).toFixed(2)}%"></div>`;
    return `<td class="tlc"><div class="tl">${inner}</div></td>`;
  }

  function tableHtml(sd, block, opts, ctx) {
    const cols = sd.columns;
    const bars = sd.type === 'schedule' && opts.showBars;
    const span = bars ? barSpan(block) : null;
    const n = cols.length + (bars ? 1 : 0);
    // Words in a numeric column ("1,350 TON · 800 LF", "Multiple") may wrap;
    // figures stay on one line.
    const cls = (c, v) => NUMERIC[c.type] ? (typeof v === 'string' ? ' class="num wrap"' : ' class="num"')
      : c.type === 'date' ? ' class="dt"' : '';
    // A subtotal or totals row leaves a column it has no figure for blank,
    // rather than a line of dashes.
    const shown = (v, c, row, rc) => rc && (v == null || v === '') ? '' : escHtml(cellText(v, c, row));
    const tr = (row, rc, withBar) => `<tr${rc ? ` class="${rc}"` : ''}>`
      + cols.map(c => `<td${cls(c, row.cells[c.key])}>${shown(row.cells[c.key], c, row, rc)}</td>`).join('')
      + (bars ? (withBar ? barHtml(row.bar, span, ctx.today) : '<td></td>') : '') + '</tr>';
    let body = '';
    block.groups.forEach(g => {
      if (g.label != null) body += `<tr class="grp"><td colspan="${n}">${escHtml(g.label)}</td></tr>`;
      g.rows.forEach(r => { body += tr(r, '', true); });
      if (g.subtotal) body += tr({ cells: g.subtotal }, 'sub', false);
    });
    if (block.totals) body += tr({ cells: block.totals }, 'tot', false);
    const head = cols.map(c => `<th${NUMERIC[c.type] ? ' class="num"' : ''}>${escHtml(c.label)}</th>`).join('')
      + (bars ? '<th class="tlh">Timeline</th>' : '');
    const legend = bars && span ? '<p class="legend">Bars run from start to target, filled to % complete. '
      + 'Blue line: today. Red dashed line: the job\'s end date.</p>' : '';
    // A wide pick of columns (all nineteen of daily production, say) packs
    // tighter so it still fits the page.
    return `<div class="tw"><table class="t${n > 10 ? ' dense' : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${legend}`;
  }

  function emptyLine(sd, ctx) {
    const noun = NOUN[sd.type] || 'data';
    const range = ctx.range || {};
    if (sd.type === 'bid_progress' || sd.type === 'schedule' || (!range.from && !range.to)) {
      return `<p class="empty">No ${noun} to show.</p>`;
    }
    return `<p class="empty">No ${noun} in this period.</p>`;
  }

  function blockHtml(sd, block, section, ctx, combined) {
    if (sd.type === 'notes') {
      return sd.text && txt(sd.text) ? `<section class="sec notes"><h3>${escHtml(sd.title)}</h3>${notesHtml(sd.text)}</section>` : '';
    }
    // A section with every column locked or hidden prints nothing at all —
    // not an empty frame on a customer's copy.
    if (!sd.columns.length || (sd.columns.length === 1 && sd.columns[0].key === '_job')) return '';
    let inner = '';
    if (!block || block.empty) inner = sd.type === 'job_info' || sd.type === 'summary_kpis' ? '' : emptyLine(sd, ctx);
    else if (sd.type === 'job_info') {
      block.groups.forEach(g => g.rows.forEach(r => { inner += cardHtml(r, sd.columns, ctx, combined ? jobLabel(r.job) : ''); }));
    } else if (sd.type === 'summary_kpis') {
      block.groups.forEach(g => g.rows.forEach(r => { inner += kpiHtml(r, sd.columns); }));
    } else inner = tableHtml(sd, block, section.options, ctx);
    if (!inner) return '';
    return `<section class="sec sec-${sd.type}"><h3>${escHtml(sd.title)}</h3>${inner}</section>`;
  }

  /* The whole printable document: masthead, title, meta line, intro, then
     the sections — once per job (separate) or once for all (combined) — and
     the footer. Self-contained (inline CSS, no fonts, images or scripts):
     it is printed from about:blank, rendered to PDF by headless Chrome, and
     emailed. No print script — the builder adds that for the print window. */
  function buildReportHtml(def, ctx) {
    const d = normalizeDefinition(def);
    syncRange(d, ctx);
    const perm = ctx.perm || {};
    const title = reportTitle(d, ctx);
    const jobs = ctx.jobs || [];
    const combined = d.layout === 'combined';
    const data = d.sections.map(s => buildSectionData(s, d, ctx));
    const internal = hasInternal(d, perm);
    const h = d.header;

    const meta = [jobsMeta(jobs), (ctx.range || {}).label || 'Job to date'];
    if (txt(h.preparedFor)) meta.push('Prepared for ' + txt(h.preparedFor));
    if (txt(h.preparedBy)) meta.push('Prepared by ' + txt(h.preparedBy));

    // data-cr-internal tells the server, as well as the reader, that this copy
    // carries internal columns: the email path logs the send from it.
    const mast = `<div class="masthead" data-dw-brand${internal ? ' data-cr-internal="1"' : ''}>
  <div><div class="mast-word">DataWatch</div><div class="mast-sub">${escHtml(divisionSub(ctx))}</div></div>
  <div class="mast-meta">${internal ? '<div class="mast-internal">INTERNAL — contains cost data. Not for customer distribution.</div>' : ''}
    <div class="mast-rpt">${escHtml(title)}</div>${h.showGenerated ? `<div class="mast-date">Generated ${escHtml(fmtStamp(ctx.now))}</div>` : ''}</div>
</div>`;

    let body = '';
    if (combined || jobs.length <= 1) {
      if (!combined && jobs.length === 1) body += jobBand(jobs[0], false);
      d.sections.forEach((s, i) => { body += blockHtml(data[i], data[i].blocks[0], s, ctx, combined); });
    } else {
      // Several jobs, each its own block. Notes are said once, not per job:
      // ones written ahead of every data section print before the jobs, the
      // rest after them.
      const firstData = d.sections.findIndex(s => s.type !== 'notes');
      const lead = [], tail = [];
      d.sections.forEach((s, i) => { if (s.type === 'notes') (firstData < 0 || i < firstData ? lead : tail).push(i); });
      lead.forEach(i => { body += blockHtml(data[i], null, d.sections[i], ctx, false); });
      jobs.forEach((p, j) => {
        let part = jobBand(p, j > 0 && d.pageBreakPerJob);
        d.sections.forEach((s, i) => { if (s.type !== 'notes') part += blockHtml(data[i], data[i].blocks[j], s, ctx, false); });
        body += `<div class="job">${part}</div>`;
      });
      tail.forEach(i => { body += blockHtml(data[i], null, d.sections[i], ctx, false); });
    }
    if (!jobs.length) body = '<p class="none">No jobs selected.</p>' + body;

    const foot = `<div class="rpt-foot"><span>${escHtml(txt(h.footer))}</span><span>DataWatch — ${escHtml(title)}</span></div>`;
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + `<title>${escHtml(title)}</title><style>${CSS}@page{size:letter ${d.orientation};margin:0.45in}`
      // On screen — the print window before its dialog, an email, the
      // builder's preview — the report keeps the width of the sheet it prints
      // on, so a wide monitor shows the page the customer will get rather than
      // tables stretched across 1,400 pixels.
      + `@media screen{body{max-width:${d.orientation === 'landscape' ? '11in' : '8.5in'};margin:0 auto}}</style></head>`
      + `<body>${mast}<h1 class="rpt-title">${escHtml(title)}</h1><p class="meta">${escHtml(meta.join(' · '))}</p>`
      + (txt(h.intro) ? `<p class="intro">${escHtml(h.intro.trim()).replace(/\r?\n/g, '<br>')}</p>` : '')
      + body + foot + '</body></html>';
  }
  function jobBand(p, pageBreak) {
    const no = txt(p['job-number']), client = txt(p.client);
    const sub = [no ? 'Job #' + no : '', client].filter(Boolean).map(escHtml).join(' · ');
    return `<div class="job-band${pageBreak ? ' pb' : ''}">${escHtml(txt(p['project-name']) || 'Untitled job')}`
      + `${sub ? ` <span class="jb-sub">· ${sub}</span>` : ''}</div>`;
  }

  // ── XLSX ───────────────────────────────────────────────────────────────
  // Written by hand like every other export in this app (see bid-xlsx.js):
  // a ZIP of XML parts with stored entries, no library. Returns bytes; the
  // builder wraps them in a Blob to download.
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

  // UTF-8 without TextEncoder, which a bare vm (and so the test) lacks. A
  // lone surrogate becomes U+FFFD, as TextEncoder would make it.
  function utf8(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
    const out = new Uint8Array(s.length * 3);
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDFFF) {
        const d = s.charCodeAt(i + 1);
        if (c <= 0xDBFF && d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
        else c = 0xFFFD;
      }
      if (c < 0x80) out[n++] = c;
      else if (c < 0x800) { out[n++] = 0xC0 | (c >> 6); out[n++] = 0x80 | (c & 63); }
      else if (c < 0x10000) { out[n++] = 0xE0 | (c >> 12); out[n++] = 0x80 | ((c >> 6) & 63); out[n++] = 0x80 | (c & 63); }
      else { out[n++] = 0xF0 | (c >> 18); out[n++] = 0x80 | ((c >> 12) & 63); out[n++] = 0x80 | ((c >> 6) & 63); out[n++] = 0x80 | (c & 63); }
    }
    return out.slice(0, n);
  }

  function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    files.forEach(f => {
      const name = utf8(f.name), data = utf8(f.data);
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
      crc = (crc ^ 0xFFFFFFFF) >>> 0;
      const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // local file header
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0x0800, true);       // UTF-8 names
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); // stored: compressed = uncompressed
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      parts.push(local, data);
      const cd = new Uint8Array(46 + name.length), cv = new DataView(cd.buffer);
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
    });
    const cdSize = central.reduce((t, c) => t + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);     // end of central directory
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    const all = parts.concat(central, [end]);
    const out = new Uint8Array(all.reduce((t, a) => t + a.length, 0));
    let at = 0;
    all.forEach(a => { out.set(a, at); at += a.length; });
    return out;
  }

  const xesc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // XML 1.0 cannot carry these, and Excel refuses the whole file over one.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  function colName(n) {
    let s = '';
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }
  // Days since 1899-12-30, off the ISO date's own fields.
  const dateSerial = iso => isIso(iso) ? Math.round(utc(iso) / DAY_MS) + 25569 : null;

  /* Styles asked for by what they look like and numbered as first used, the
     way bid-xlsx.js does it, so no index into a hand-kept list can drift. */
  function makeStyles() {
    const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    const fmts = [], xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const cache = new Map();
    const intern = (list, x) => { let i = list.indexOf(x); if (i < 0) { i = list.length; list.push(x); } return i; };
    const font = ({ b, i, sz = 11, color = '1F2937' } = {}) => intern(fonts,
      `<font>${b ? '<b/>' : ''}${i ? '<i/>' : ''}<sz val="${sz}"/><color rgb="FF${color}"/><name val="Calibri"/><family val="2"/></font>`);
    font();
    const fill = rgb => rgb ? intern(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const border = top => top ? intern(borders, `<border><left/><right/><top style="${top[0]}"><color rgb="FF${top[1]}"/></top><bottom/><diagonal/></border>`) : 0;
    const numFmt = code => code ? 164 + intern(fmts, code) : 0;
    function xf(spec) {
      const key = JSON.stringify(spec);
      if (cache.has(key)) return cache.get(key);
      const nf = numFmt(spec.fmt), fo = font(spec.font), fi = fill(spec.fill), bo = border(spec.top);
      const al = (spec.align || spec.wrap)
        ? `<alignment${spec.align ? ` horizontal="${spec.align}"` : ''}${spec.wrap ? ' vertical="top" wrapText="1"' : ''}/>` : '';
      const x = `<xf numFmtId="${nf}" fontId="${fo}" fillId="${fi}" borderId="${bo}" xfId="0"`
        + (nf ? ' applyNumberFormat="1"' : '') + (fo ? ' applyFont="1"' : '') + (fi ? ' applyFill="1"' : '')
        + (bo ? ' applyBorder="1"' : '') + (al ? ` applyAlignment="1">${al}</xf>` : '/>');
      const idx = xfs.length;
      xfs.push(x);
      cache.set(key, idx);
      return idx;
    }
    function xml() {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + (fmts.length ? `<numFmts count="${fmts.length}">` + fmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xesc(c)}"/>`).join('') + '</numFmts>' : '')
        + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
        + `<fills count="${fills.length}">${fills.join('')}</fills>`
        + `<borders count="${borders.length}">${borders.join('')}</borders>`
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '</styleSheet>';
    }
    return { xf, xml };
  }

  const FMT = {
    money: '"$"#,##0.00;-"$"#,##0.00', qty: '#,##0.00', number: '#,##0.00', days: '#,##0',
    percent: '0.0%', date: 'mmm d, yyyy',
  };
  const BAND = { line: null, grp: 'E8F5E9', sub: 'F3F4F6', tot: 'EDEFF3' };
  // A unit rides in the number format, so "+40 SY" stays the number 40.
  const unitFmt = (unit, signed) => {
    const u = String(unit).replace(/["\\]/g, '').slice(0, 20);
    return signed ? `+#,##0.00" ${u}";-#,##0.00" ${u}";0" ${u}"` : `#,##0.00" ${u}"`;
  };

  function cellXml(ref, c) {
    if (!c) return '';
    const st = c.s ? ` s="${c.s}"` : '';
    if (typeof c.v === 'number') return isFinite(c.v) ? `<c r="${ref}"${st}><v>${Math.round(c.v * 1e6) / 1e6}</v></c>` : `<c r="${ref}"${st}/>`;
    if (c.v == null || c.v === '') return c.s ? `<c r="${ref}"${st}/>` : '';
    return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xesc(c.v)}</t></is></c>`;
  }

  const INTERNAL_NOTE = 'INTERNAL — contains cost data. Not for customer distribution.';
  const INTERNAL_HEADER = 'INTERNAL — Not for customer distribution';
  function sheetXml(rows, widths, headRow, view) {
    const ncol = Math.max(1, widths.length);
    const pane = headRow
      ? `<pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headRow + 1}" sqref="A${headRow + 1}"/>`
      : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
      + `<dimension ref="A1:${colName(ncol)}${Math.max(1, rows.length)}"/>`
      + `<sheetViews><sheetView${view.selected ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
      + '<sheetData>' + rows.map((row, i) => {
        const n = i + 1;
        return `<row r="${n}"${row.ht ? ` ht="${row.ht}" customHeight="1"` : ''}>`
          + (row.cells || []).map((c, ci) => cellXml(colName(ci + 1) + n, c)).join('') + '</row>';
      }).join('') + '</sheetData>'
      + '<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
      + `<pageSetup orientation="${view.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`
      // An internal workbook says so at the top of every printed page too.
      + (view.internal ? `<headerFooter><oddHeader>${xesc('&C&"-,Bold"' + INTERNAL_HEADER)}</oddHeader></headerFooter>` : '')
      + '</worksheet>';
  }

  // Excel's rules: ≤ 31 characters, none of []:*?/\, not blank, unique
  // ignoring case — and "History" is its own.
  function sheetName(raw, used) {
    let n = String(raw || '').replace(/[\[\]:*?\/\\\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').trim();
    if (!n) n = 'Sheet';
    n = n.slice(0, 31).trim();
    const base = n;
    for (let i = 2; used.has(n.toLowerCase()); i++) {
      const suf = ` (${i})`;
      n = base.slice(0, 31 - suf.length).trim() + suf;
    }
    used.add(n.toLowerCase());
    return n;
  }

  /* The workbook: a "Report" sheet first — title, jobs, dates, generated,
     prepared for / by, then each job card and summary strip as label / value
     rows and the notes — and a sheet per table section. Same columns as the
     HTML (effectiveColumns), numbers as numbers, dates as dates, percentages
     as fractions under a % format. */
  function buildXlsx(def, ctx) {
    const d = normalizeDefinition(def);
    syncRange(d, ctx);
    const st = makeStyles();
    const title = reportTitle(d, ctx);
    const jobs = ctx.jobs || [];
    const internal = hasInternal(d, ctx.perm || {});
    const h = d.header;
    const data = d.sections.map(s => buildSectionData(s, d, ctx));
    const used = new Set(['report', 'history']);
    const S = {
      title: st.xf({ font: { b: true, sz: 15, color: '1F2A44' } }),
      sub: st.xf({ font: { sz: 10, color: '6B7280' } }),
      key: st.xf({ font: { b: true, color: '374151' }, wrap: true }),
      val: st.xf({ wrap: true }),
      warn: st.xf({ font: { b: true, color: 'B91C1C' } }),
      head: st.xf({ font: { b: true, color: 'FFFFFF' }, fill: '1F2A44', wrap: true }),
      headR: st.xf({ font: { b: true, color: 'FFFFFF' }, fill: '1F2A44', wrap: true, align: 'right' }),
      sec: st.xf({ font: { b: true, sz: 12, color: '166534' } }),
    };
    const look = (row, type, unit, signed) => {
      const b = row === 'tot' || row === 'sub' || row === 'grp', i = row === 'sub';
      const top = row === 'sub' ? ['thin', 'B8BEC7'] : row === 'tot' ? ['medium', '1F2A44'] : null;
      const spec = { fill: BAND[row], top, font: { b, i } };
      if (unit && (type === 'qty' || type === 'number')) spec.fmt = unitFmt(unit, signed);
      else if (FMT[type]) spec.fmt = FMT[type];
      if (NUMERIC[type]) spec.align = 'right';
      return st.xf(spec);
    };
    const cellFor = (v, c, row, unit) => {
      if (v == null || v === '') return { s: look(row, 'text') };
      if (typeof v === 'number' && isFinite(v)) {
        if (c.type === 'percent') return { v: v / 100, s: look(row, 'percent') };
        if (c.type === 'date') return { v: String(v), s: look(row, 'text') };
        if (NUMERIC[c.type]) return { v, s: look(row, c.type, unit, c.key === 'qty_change') };
        return { v: String(v), s: look(row, 'text') };
      }
      if (c.type === 'date' && isIso(v)) return { v: dateSerial(v), s: look(row, 'date') };
      return { v: String(v), s: st.xf({ fill: BAND[row], font: { b: row !== 'line', i: row === 'sub' }, align: NUMERIC[c.type] ? 'right' : undefined }) };
    };

    // ── Report sheet ──
    const R = [];
    R.push({ cells: [{ v: title, s: S.title }], ht: 22 });
    R.push({ cells: [{ v: 'DataWatch — ' + divisionSub(ctx), s: S.sub }] });
    if (internal) R.push({ cells: [{ v: INTERNAL_NOTE, s: S.warn }] });
    R.push({ cells: [] });
    const kv = (k, v) => R.push({ cells: [{ v: k, s: S.key }, v && typeof v === 'object' ? v : { v, s: S.val }] });
    kv('Jobs', jobs.length ? jobs.map(jobLabel).join('; ') : 'No jobs selected');
    kv('Date range', (ctx.range || {}).label || 'Job to date');
    if (h.showGenerated) kv('Generated', fmtStamp(ctx.now));
    if (txt(h.preparedFor)) kv('Prepared for', txt(h.preparedFor));
    if (txt(h.preparedBy)) kv('Prepared by', txt(h.preparedBy));
    if (txt(h.intro)) kv('Message', txt(h.intro));
    d.sections.forEach((s, i) => {
      const sd = data[i];
      if (sd.type === 'notes') {
        if (!txt(sd.text)) return;
        R.push({ cells: [] });
        R.push({ cells: [{ v: sd.title, s: S.sec }] });
        R.push({ cells: [{ v: sd.text.trim(), s: S.val }] });
        return;
      }
      if (sd.type !== 'job_info' && sd.type !== 'summary_kpis') return;
      if (!sd.columns.length) return;
      sd.blocks.forEach(block => block.groups.forEach(g => g.rows.forEach(row => {
        const who = sd.type === 'job_info' ? (row.job || block.job) : block.job;
        R.push({ cells: [] });
        R.push({ cells: [{ v: sd.title + (who ? ' — ' + jobLabel(who) : jobs.length > 1 ? ' — All jobs' : ''), s: S.sec }] });
        sd.columns.forEach(c => {
          const unit = c.key === 'sqft' ? ctx.areaUnit : c.key === 'qty_period' && isNum(row.cells[c.key]) ? row.unit : '';
          const cell = cellFor(row.cells[c.key], c, 'line', unit);
          if (cell.v === undefined) cell.v = '—';
          kv(c.label, cell);
        });
      })));
    });
    if (txt(h.footer)) { R.push({ cells: [] }); kv('Note', txt(h.footer)); }
    const landscape = d.orientation === 'landscape';
    const sheets = [{ name: 'Report', xml: sheetXml(R, [24, 70], 0, { selected: true, landscape, internal }), head: 0 }];

    // ── One sheet per table section ──
    d.sections.forEach((s, i) => {
      const sd = data[i];
      if (!CATALOG[sd.type].table || !sd.columns.length) return;
      // Several jobs in one sheet always carry a Job column, so the sheet
      // filters by job whichever layout the HTML used.
      const addJob = jobs.length > 1 && !sd.columns.some(c => c.key === '_job');
      const cols = addJob ? [JOB_COL].concat(sd.columns) : sd.columns;
      const rows = [];
      rows.push({ cells: [{ v: sd.title, s: S.title }], ht: 20 });
      // The sheets that hold the costs, rates and names are the ones that get
      // copied out on their own, so each carries the warning, not just the
      // cover sheet.
      if (internal) rows.push({ cells: [{ v: INTERNAL_NOTE, s: S.warn }] });
      rows.push({ cells: [{ v: [jobs.length === 1 ? jobLabel(jobs[0]) : `${jobs.length} jobs`, (ctx.range || {}).label].join(' · '), s: S.sub }] });
      rows.push({ cells: [] });
      rows.push({ cells: cols.map(c => ({ v: c.label, s: NUMERIC[c.type] ? S.headR : S.head })), ht: 30 });
      const headRow = rows.length;
      const widths = cols.map(c => Math.min(40, Math.max(8, c.label.length + 2)));
      const line = (cells, kind, unit, job) => {
        rows.push({ cells: cols.map((c, ci) => {
          let v = cells[c.key];
          if (c.key === '_job' && addJob) v = kind === 'line' ? (job ? jobLabel(job) : '') : (cells._job || '');
          const u = c.key === 'qty_change' && isNum(v) ? unit : '';
          const shown = formatCell(v, c.type, u).length + 1;
          if (shown > widths[ci]) widths[ci] = Math.min(50, shown);
          return cellFor(v, c, kind, u);
        }) });
      };
      let any = false;
      sd.blocks.forEach(block => {
        if (block.empty) return;
        any = true;
        block.groups.forEach(g => {
          if (g.label != null) {
            rows.push({ cells: cols.map((c, ci) => ci === 0 ? { v: (addJob && block.job ? jobLabel(block.job) + ' — ' : '') + g.label, s: look('grp', 'text') } : { s: look('grp', 'text') }) });
          }
          g.rows.forEach(r => line(r.cells, 'line', r.unit, r.job || block.job));
          if (g.subtotal) line(g.subtotal, 'sub', '', block.job);
        });
        if (block.totals) {
          const t = Object.assign({}, block.totals);
          if (addJob && block.job) { t._job = 'Totals — ' + jobLabel(block.job); if (cols[1] && t[cols[1].key] === 'Totals') t[cols[1].key] = null; }
          line(t, 'tot', '', block.job);
        }
      });
      if (!any) rows.push({ cells: [{ v: `No ${NOUN[sd.type] || 'data'} for this report.`, s: S.sub }] });
      sheets.push({ name: sheetName(sd.title, used), xml: sheetXml(rows, widths, headRow, { selected: false, landscape, internal }), head: headRow });
    });

    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const ct = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
    const qn = n => `'${n.replace(/'/g, "''")}'`;
    const defined = sheets.map((sh, i) => sh.head
      ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${xesc(qn(sh.name))}!$${sh.head}:$${sh.head}</definedName>` : '').join('');
    return zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + `<Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/>`
        + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${ct}.worksheet+xml"/>`).join('')
        + `<Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/>`
        + '</Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/>`
        + '</Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}">`
        + '<bookViews><workbookView activeTab="0"/></bookViews><sheets>'
        + sheets.map((sh, i) => `<sheet name="${xesc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets>' + (defined ? `<definedNames>${defined}</definedNames>` : '')
        + '<calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${sheets.length + 1}" Type="${rel}/styles" Target="styles.xml"/>`
        + '</Relationships>' },
      { name: 'xl/styles.xml', data: st.xml() },
    ].concat(sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sh.xml }))));
  }

  // "<title>-<YYYY-MM-DD>.xlsx", safe on every file system — and
  // "<title>-INTERNAL-<date>.xlsx" when it carries internal columns, so the
  // file says what it is wherever it ends up attached.
  function xlsxFileName(def, ctx) {
    const d = normalizeDefinition(def);
    const base = reportTitle(d, ctx || {}).replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 80).replace(/-+$/, '');
    const tag = hasInternal(d, (ctx && ctx.perm) || {}) ? '-INTERNAL' : '';
    return `${base || 'report'}${tag}-${(ctx && isIso(ctx.today)) ? ctx.today : localToday()}.xlsx`;
  }

  // ── Starter templates ──────────────────────────────────────────────────
  // Built in and read-only; "Use this template" copies one into an unsaved
  // report. Section ids are fixed so a copy's sections are recognisable.
  function starter(id, name, blurb, extra, sections) {
    const def = Object.assign(defaultDefinition(), { title: name }, extra || {});
    def.sections = sections.map((s, i) => Object.assign(newSection(s.type), { id: `${id}-${i + 1}` }, s));
    const definition = normalizeDefinition(def);
    return { id, name, blurb, internal: definition.includeInternal, definition };
  }
  const JOB_MIN = ['project-name', 'job-number', 'client'];
  const STARTERS = [
    starter('customer_progress', 'Customer Progress Update',
      'Where the job stands: job card, headline figures, bid item progress, schedule and a note to the customer.', null, [
        { type: 'job_info' },
        { type: 'summary_kpis', columns: ['pct_complete', 'days_worked', 'items_complete'] },
        { type: 'bid_progress' },
        { type: 'schedule' },
        { type: 'notes', title: 'Notes', text: '' },
      ]),
    starter('quantities_installed', 'Quantities Installed',
      'Last week\'s quantities by day and sub code — no costs, no crew.', { dates: { preset: 'last_week', from: '', to: '' } }, [
        { type: 'job_info', columns: JOB_MIN },
        { type: 'daily_production', columns: ['date', 'cost_code', 'sub_code', 'quantity', 'unit'],
          options: { summarize: true, groupBy: 'none' } },
      ]),
    starter('production_rates', 'Production Rates',
      'Average and best day per item over the last 30 days, days left and projected finish.', { dates: { preset: 'last_30', from: '', to: '' } }, [
        { type: 'production_kpis' },
      ]),
    starter('materials_delivered', 'Materials Delivered',
      'Every delivery against the job\'s purchase orders: date, supplier, material, ticket and quantity.', null, [
        { type: 'job_info', columns: JOB_MIN },
        { type: 'materials' },
      ]),
    starter('haul_log', 'Haul Log',
      'Trucking tickets for the job: date, truck type, material hauled and loads.', null, [
        { type: 'job_info', columns: JOB_MIN },
        { type: 'trucking' },
      ]),
    starter('change_order_log', 'Change Order Log',
      'Contract and quantity change orders with their dates and descriptions.', null, [
        { type: 'job_info', columns: JOB_MIN },
        { type: 'change_orders' },
      ]),
    starter('internal_cost_snapshot', 'Internal Cost Snapshot',
      'Costs, budget, projection and profit by bid item. Internal — not for customers.', { includeInternal: true }, [
        { type: 'summary_kpis', columns: ['actual_cost', 'bid_budget', 'projected_cost', 'gp_earned', 'labor_hours', 'pct_complete'] },
        { type: 'bid_progress', columns: ['cost_code', 'sub_code', 'bid_qty', 'installed_to_date', 'pct_complete',
          'bid_total', 'actual_cost', 'variance', 'projected_cost'] },
      ]),
  ];

  root.FCTReportEngine = {
    VERSION, CATALOG, SECTION_ORDER, STARTERS, DATE_PRESETS,
    defaultDefinition, newSection, normalizeDefinition, resolveDateRange, resolveJobs,
    columnState, effectiveColumns, hiddenFinancialCount, hasInternal, costCodesFor,
    makeContext, buildSectionData, buildReportHtml, buildXlsx, xlsxFileName, formatCell, escHtml,
    XLSX_MIME,
  };
})();
