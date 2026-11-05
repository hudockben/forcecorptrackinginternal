/* ── Bid Line Items vs Actuals → Excel (.xlsx) ───────────────────────────
   The bid page's XLSX button. Shared by the three division pages (tracker,
   paving, kiewit-pinetree): the bid helpers it reads — getProj,
   actualForBidItem, bidGroupPct and the rest — are the same functions on all
   three, so the workbook is written once here rather than three times.

   It carries the same figures the PDF report prints, off the same helpers, so
   the two exports can never disagree — but as a workbook to work in rather
   than a picture of the table: quantities, money and hours as plain numbers,
   dates as real dates, and the arithmetic as formulas. Bid Cost Total is Bid
   Qty × Unit Cost, Variance is Bid Cost Total − Actual Cost, and each cost
   code's Total row is a SUBTOTAL of its lines — change a figure and what
   hangs off it follows. Each cost code's lines are an outline group, so they
   collapse to the Total row the way the green rows do on screen.

   The bottom Totals row is the whole job as the app reports it (every daily
   cost, every cost code), the same as the PDF's — so, like the PDF's, it is
   written as figures rather than formulas, and a note under the table says so
   whenever it differs from the cost code totals above it.

   Unlike the PDF, it carries the contract and the projected profit, as the
   bid page's summary bar does: in the line over the table, and as figures
   under the Totals row — Contract Value, then Projected Profit worked off it
   and the Totals row's Projected Cost as a formula. The contract figures come
   from the page's own bidContractFigures(), the one its summary bar reads.

   Written by hand like every other export in this app: a ZIP of XML parts
   with stored (uncompressed) entries, no library. */
(function () {
  'use strict';

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

  function zip(files) {
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
    return new Blob(chunks.concat(central, [end]), { type: XLSX_MIME });
  }

  const xesc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 cannot carry these, and Excel refuses the whole file over one.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  function colName(n) {
    let s = '';
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  // Days since 1899-12-30, read off the ISO date's own fields so a work date
  // never slips a day through the local-time parser.
  function dateSerial(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) + 25569 : null;
  }

  /* Styles are asked for by what they look like and numbered as they are
     first used, so no index into a hand-kept list can drift out of step with
     the list. */
  function makeStyles() {
    const fonts = [], fills = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
    ];
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    const fmts = [];
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const cache = new Map();
    const intern = (list, x) => { let i = list.indexOf(x); if (i < 0) { i = list.length; list.push(x); } return i; };
    const font = ({ b, i, sz = 11, color = '1F2937' } = {}) => intern(fonts,
      `<font>${b ? '<b/>' : ''}${i ? '<i/>' : ''}<sz val="${sz}"/><color rgb="FF${color}"/><name val="Calibri"/><family val="2"/></font>`);
    font();   // font 0 is the default
    const fill = rgb => rgb ? intern(fills,
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const border = top => top ? intern(borders,
      `<border><left/><right/><top style="${top[0]}"><color rgb="FF${top[1]}"/></top><bottom/><diagonal/></border>`) : 0;
    const numFmt = code => code ? 164 + intern(fmts, code) : 0;

    function xf(spec) {
      const key = JSON.stringify(spec);
      if (cache.has(key)) return cache.get(key);
      const nf = numFmt(spec.fmt), fo = font(spec.font), fi = fill(spec.fill), bo = border(spec.top);
      const al = (spec.align || spec.wrap)
        ? `<alignment${spec.align ? ` horizontal="${spec.align}"` : ''}${spec.wrap ? ' vertical="center" wrapText="1"' : ''}/>` : '';
      const x = `<xf numFmtId="${nf}" fontId="${fo}" fillId="${fi}" borderId="${bo}" xfId="0"`
        + (nf ? ' applyNumberFormat="1"' : '') + (fo ? ' applyFont="1"' : '')
        + (fi ? ' applyFill="1"' : '') + (bo ? ' applyBorder="1"' : '')
        + (al ? ` applyAlignment="1">${al}</xf>` : '/>');
      const idx = xfs.length;
      xfs.push(x);
      cache.set(key, idx);
      return idx;
    }

    function xml() {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + (fmts.length ? `<numFmts count="${fmts.length}">`
            + fmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xesc(c)}"/>`).join('') + '</numFmts>' : '')
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

  // A zero reads "—", as it does on screen, while the cell still holds a 0
  // that sums. Variance carries its sign in the number and the format words
  // it the way the page does, "under" or "over". Its green / red is set on the
  // cell rather than in the format: a [ColorN] in a number format is read off
  // each program's own palette, and LibreOffice draws Excel's green nearly
  // white.
  const FMT = {
    money: '"$"#,##0.00;-"$"#,##0.00;"—"',
    qty:   '#,##0.00;-#,##0.00;"—"',
    int:   '#,##0;-#,##0;"—"',
    pct:   '0.0%',
    date:  'mmm d, yyyy',
    vari:  '"$"#,##0.00" under";"$"#,##0.00" over";"—"',
  };
  const INK = { text: '1F2937', muted: '6B7280', actual: '92400E', under: '166534', over: '991B1B', white: 'FFFFFF', title: '1F2A44' };
  const BAND = { line: null, band: 'E8F5E9', sub: 'F3F4F6', tot: 'EDEFF3' };

  // A cell is { v, s } — a string or number — or { f, v, s } for a formula,
  // where v is what it works out to. Excel recalculates on open regardless;
  // the cached value is what a preview pane or a phone shows without running it.
  function cellXml(ref, c) {
    if (!c) return '';
    const st  = c.s ? ` s="${c.s}"` : '';
    const num = v => Math.round(Number(v) * 1e6) / 1e6;
    if (c.f) {
      if (typeof c.v === 'number' && isFinite(c.v)) return `<c r="${ref}"${st}><f>${xesc(c.f)}</f><v>${num(c.v)}</v></c>`;
      return `<c r="${ref}"${st} t="str"><f>${xesc(c.f)}</f><v>${xesc(c.v == null ? '' : c.v)}</v></c>`;
    }
    if (typeof c.v === 'number') return isFinite(c.v) ? `<c r="${ref}"${st}><v>${num(c.v)}</v></c>` : `<c r="${ref}"${st}/>`;
    if (c.v == null || c.v === '') return `<c r="${ref}"${st}/>`;
    return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xesc(c.v)}</t></is></c>`;
  }

  const plural = (n, w) => `${n} ${w}${n !== 1 ? 's' : ''}`;
  const money  = v => (v < 0 ? '-$' : '$') + fmt(Math.abs(v));

  /* Every figure the workbook prints, worked out exactly as exportBidPDF works
     it out, before anything is laid on a sheet. */
  function collectBidReport(projId, selectedCostCodes) {
    const p = getProj(projId); if (!p) return null;
    const items = p.bidItems || [];
    const groupOrder = [], groups = {};
    items.forEach(b => {
      const cc = b.cost_code || '';
      if (!groups[cc]) { groups[cc] = []; groupOrder.push(cc); }
      groups[cc].push(b);
    });
    const effQty = b => (parseFloat(b.quantity) || 0)
      + (b.change_orders || []).reduce((s, co) => s + (parseFloat(co.qty_delta) || 0), 0);

    // The whole job, always — whichever cost codes are picked.
    const grand = {
      bid:      items.reduce((s, b) => s + effQty(b) * (parseFloat(b.unit_cost) || 0), 0),
      actual:   (p.dailyRows || []).reduce((s, r) => s + dailyRowCost(r), 0),
      proj:     projectedCostForProject(p),
      hrs:      items.reduce((s, b) => s + cumulativeHoursForBidItem(b, projId), 0),
      pct:      bidProjectPct(projId),
      days:     daysWorkedForGroup(items, projId),
      laborers: new Set((p.dailyRows || []).map(r => r.employee).filter(Boolean)).size,
    };
    // Contract − projected final cost, as the summary bar works it. No
    // contract, no profit: a blank, not the whole projected cost as a loss.
    const contract = bidContractFigures(p);
    const profit   = contract.value ? contract.value - grand.proj : null;

    const visible = selectedCostCodes ? groupOrder.filter(cc => selectedCostCodes.has(cc || '')) : groupOrder;
    const projDone = projIsDone(p);
    const groupsOut = visible.map(costCode => {
      const gItems = groups[costCode];
      const lines = gItems.map(b => {
        const bidQty = effQty(b);
        const uc     = parseFloat(b.unit_cost) || 0;
        const bidTot = bidQty * uc;
        const actual = actualForBidItem(b, projId);
        const rqty   = runningQtyForBidItem(b, projId);
        const days   = _workDaysForItems([b], projId);
        const auto   = _autoBidDates(days);
        const pa     = computeSizeAwarePastAvg(bidQty, b.cost_code, b.sub_code, projId);
        return {
          costCode, subCode: b.sub_code || '', unit: b.unit || '',
          bidQty, uc, bidTot, actual, rqty,
          hrs:     cumulativeHoursForBidItem(b, projId),
          lab:     laborerCountForBidItem(b, projId),
          proj:    projForBidItem(b, actual, rqty, bidQty, bidTot, projDone || bidItemComplete(b, projId)),
          pastAvg: pa && pa.histUC > 0 ? pa.histUC : null,
          start:   b.start_date  || auto.start,  startAuto:  !b.start_date  && !!auto.start,
          target:  b.target_date || auto.target, targetAuto: !b.target_date && !!auto.target,
          days:    days.length,
        };
      });
      const sum = k => lines.reduce((s, l) => s + l[k], 0);
      return {
        costCode, lines,
        pct:     bidGroupPct(gItems, projId),
        days:    daysWorkedForGroup(gItems, projId),
        measure: _bidGroupMeasure(p, costCode),
        bid: sum('bidTot'), actual: sum('actual'), hrs: sum('hrs'), proj: sum('proj'),
      };
    });

    return {
      name:  p['project-name'] || 'Project',
      jobNo: p['job-number'] || '',
      sqft:  parseFloat(p['sqft']) || 0,
      filtered: !!(selectedCostCodes && visible.length < groupOrder.length),
      codeCount: groupOrder.length,
      groups: groupsOut, grand, contract, profit,
    };
  }

  /* Lay the report on a sheet. Columns follow the bid table on screen, Days
     Worked included; Cost Code gets a column of its own beside Sub Code so a
     line read on its own, copied out or filtered still says where it belongs. */
  function buildBidXlsx(projId, selectedCostCodes, opts) {
    const rep = collectBidReport(projId, selectedCostCodes);
    if (!rep) return null;
    opts = opts || {};
    const area      = String(opts.areaUnit || 'SY');
    const areaLower = area.toLowerCase();
    const st = makeStyles();

    const HEADS = ['Cost Code', 'Sub Code', 'Unit', 'Bid Qty', 'Running Qty', 'Qty Completed', 'Unit Cost',
      'Running Unit Cost', 'Past Avg UC', opts.costTotalLabel || 'Bid Cost Total', 'Actual Cost', 'Cum. Hours',
      '# Laborers', 'Variance', 'Projected Cost', 'Start Date', 'Target Date', 'Days Worked'];
    const WIDTHS = [22, 34, 7, 11, 12, 11, 11, 12, 12, 15, 15, 11, 10, 17, 15, 13, 13, 11];
    const NCOL = HEADS.length;
    // Column letters, by what they hold.
    const C = {}; ['cc', 'sc', 'unit', 'bidQty', 'rqty', 'pct', 'uc', 'ruc', 'past', 'bid', 'actual', 'hrs',
      'lab', 'vari', 'proj', 'start', 'target', 'days'].forEach((k, i) => { C[k] = colName(i + 1); });

    // One look per kind of cell, tinted for the kind of row it sits in.
    const look = (row, kind, extra) => {
      const fill = BAND[row];
      const top  = row === 'sub' ? ['thin', 'B8BEC7'] : row === 'tot' ? ['medium', INK.title] : null;
      const b = row === 'tot', i = row === 'sub';
      const base = { fill, top, font: { b, i } };
      const by = {
        label: { font: { b: true, i } },
        text:  {},
        muted: { font: { b, i, color: INK.muted } },
        qty:   { fmt: FMT.qty },
        int:   { fmt: FMT.int },
        pct:   { fmt: FMT.pct },
        money: { fmt: FMT.money },
        actual:{ fmt: FMT.money, font: { b, i, color: INK.actual } },
        under: { fmt: FMT.money, font: { b, i, color: INK.under } },
        over:  { fmt: FMT.money, font: { b, i, color: INK.over } },
        variU: { fmt: FMT.vari, font: { b, i, color: INK.under } },
        variO: { fmt: FMT.vari, font: { b, i, color: INK.over } },
        date:  { fmt: FMT.date },
        auto:  { fmt: FMT.date, font: { b, i: true, color: INK.muted } },
      }[kind];
      return st.xf(Object.assign(base, by, extra || {}));
    };
    const projLook = (row, proj, bid) => bid ? look(row, proj - bid <= 0 ? 'under' : 'over') : look(row, 'money');
    const variLook = (row, v) => look(row, v >= 0 ? 'variU' : 'variO');

    const rows = [];        // { cells, level, ht }
    const add = (cells, more) => { rows.push(Object.assign({ cells }, more || {})); return rows.length; };

    // ── Masthead: what the PDF's two summary bars say, in a line each ──
    const g = rep.grand;
    const dash = '—';
    add([{ v: `Bid Line Items vs Actuals — ${rep.name}${rep.jobNo ? ' — ' + rep.jobNo : ''}`,
      s: st.xf({ font: { b: true, sz: 15, color: INK.title } }) }], { ht: 22 });
    const subLook = st.xf({ font: { sz: 10, color: INK.muted } });
    add([{ v: 'Exported ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      + (rep.filtered ? ` · ${rep.groups.length} of ${plural(rep.codeCount, 'cost code')}` : ''), s: subLook }]);
    // In the summary bar's order: contract, the three costs, then profit and
    // progress behind its divider.
    const k = rep.contract;
    add([{ v: [
      ...(k.coCount
        ? ['Original Contract ' + (k.original ? money(k.original) : dash),
           `Change Orders (${k.coCount}) ` + (k.coTotal >= 0 ? '+' : '') + money(k.coTotal),
           'Revised Contract ' + (k.value ? money(k.value) : dash)]
        : ['Contract Value ' + (k.value ? money(k.value) : dash)]),
      'Bid Budget ' + (g.bid ? money(g.bid) : dash),
      'Actual Cost ' + (g.actual ? money(g.actual) : dash),
      'Projected Cost ' + ((g.bid || g.proj) ? money(g.proj) : dash),
      'Projected Profit ' + (rep.profit === null ? dash
        : `${money(rep.profit)} (${(rep.profit / k.value * 100).toFixed(1)}%)`),
      'Project Complete ' + (g.pct ? `${g.pct.pct.toFixed(1)}% (${g.pct.done}/${plural(g.pct.total, 'cost code')} done)` : dash),
    ].join('  ·  '), s: st.xf({ font: { b: true, sz: 11 } }) }]);
    if (rep.sqft > 0) {
      const bidPer = g.bid / rep.sqft, runPer = g.actual / rep.sqft, delta = bidPer - runPer;
      add([{ v: `Cost / ${area} · ${fmt(rep.sqft)} ${areaLower}  ·  Bid ${money(bidPer)}/${areaLower}  ·  `
        + `Running ${money(runPer)}/${areaLower}  ·  `
        + (delta >= 0 ? `${money(delta)}/${areaLower} under bid` : `${money(-delta)}/${areaLower} over bid`),
        s: st.xf({ font: { sz: 11, color: delta >= 0 ? INK.under : INK.over } }) }]);
    }
    add([]);

    const HEAD_ROW = add(HEADS.map((v, i) => ({ v, s: st.xf({
      font: { b: true, color: INK.white }, fill: INK.title, wrap: true, align: i >= 3 ? 'right' : 'left' }) })),
      { ht: 32 });

    let anyMeasure = false;
    rep.groups.forEach(grp => {
      const label = grp.costCode || '(No Code)';

      // The green bar: the same line the PDF prints over a cost code.
      const bits = [];
      if (grp.pct) bits.push(`${grp.pct.pct.toFixed(1)}% complete`, `${grp.pct.done}/${plural(grp.pct.total, 'sub code')} done`);
      if (grp.days) bits.push(`${plural(grp.days, 'day')} worked`);
      if (grp.measure.qty > 0) {
        anyMeasure = true;
        bits.push(`${qfmt(grp.measure.qty)} ${grp.measure.unit} @ ${_bidGroupUnitCostText(grp.actual, grp.measure.qty, grp.measure.unit)}`);
      }
      const bandFill = look('band', 'text');
      add(HEADS.map((_, i) => i === 0 ? { v: label, s: look('band', 'label') }
        : i === 1 ? { v: bits.join(' · '), s: look('band', 'muted') } : { s: bandFill }));

      const first = rows.length + 1;
      grp.lines.forEach(l => {
        const r = rows.length + 1;
        const ruc = l.rqty > 0 && l.actual ? l.actual / l.rqty : '';
        add([
          { v: l.costCode, s: look('line', 'text') },
          { v: l.subCode, s: look('line', 'text') },
          { v: l.unit, s: look('line', 'text', { align: 'center' }) },
          { v: l.bidQty, s: look('line', 'qty') },
          { v: l.rqty, s: look('line', 'qty') },
          { f: `IF(${C.bidQty}${r}=0,"",${C.rqty}${r}/${C.bidQty}${r})`, v: l.bidQty ? l.rqty / l.bidQty : '', s: look('line', 'pct') },
          { v: l.uc, s: look('line', 'money') },
          { f: `IF(AND(${C.rqty}${r}>0,${C.actual}${r}<>0),${C.actual}${r}/${C.rqty}${r},"")`, v: ruc, s: look('line', 'money') },
          { v: l.pastAvg, s: look('line', 'money') },
          { f: `${C.bidQty}${r}*${C.uc}${r}`, v: l.bidTot, s: look('line', 'money') },
          { v: l.actual, s: look('line', 'actual') },
          { v: l.hrs, s: look('line', 'qty') },
          { v: l.lab, s: look('line', 'int') },
          { f: `${C.bid}${r}-${C.actual}${r}`, v: l.bidTot - l.actual, s: variLook('line', l.bidTot - l.actual) },
          { v: l.proj, s: projLook('line', l.proj, l.bidTot) },
          { v: dateSerial(l.start), s: look('line', l.startAuto ? 'auto' : 'date') },
          { v: dateSerial(l.target), s: look('line', l.targetAuto ? 'auto' : 'date') },
          { v: l.days, s: look('line', 'int') },
        ], { level: 1 });
      });
      const last = rows.length;

      // SUBTOTAL rather than SUM: the Totals row's own SUBTOTALs step over
      // these, and it keeps a filter honest. Function 9, not 109 — collapsing
      // a cost code hides its lines, and that must not take them out of it.
      const r = rows.length + 1;
      const subtotal = c => grp.lines.length ? `SUBTOTAL(9,${c}${first}:${c}${last})` : null;
      const fill = look('sub', 'text');
      const cells = HEADS.map(() => ({ s: fill }));
      cells[0] = { v: label + ' — Total', s: look('sub', 'label') };
      cells[5] = { v: grp.pct ? grp.pct.pct / 100 : '', s: look('sub', 'pct') };
      cells[9]  = { f: subtotal(C.bid),    v: grp.bid,    s: look('sub', 'money') };
      cells[10] = { f: subtotal(C.actual), v: grp.actual, s: look('sub', 'actual') };
      cells[11] = { f: subtotal(C.hrs),    v: grp.hrs,    s: look('sub', 'qty') };
      cells[13] = { f: `${C.bid}${r}-${C.actual}${r}`, v: grp.bid - grp.actual, s: variLook('sub', grp.bid - grp.actual) };
      cells[14] = { f: subtotal(C.proj),   v: grp.proj,   s: projLook('sub', grp.proj, grp.bid) };
      cells[17] = { v: grp.days, s: look('sub', 'int') };
      add(cells);
    });

    // ── Totals: the job as the app reports it, as the PDF prints it ──
    const tr = rows.length + 1;
    const totFill = look('tot', 'text');
    const tot = HEADS.map(() => ({ s: totFill }));
    tot[0]  = { v: rep.filtered ? 'Project Totals (All Cost Codes)' : 'Totals', s: look('tot', 'label') };
    tot[5]  = { v: g.pct ? g.pct.pct / 100 : '', s: look('tot', 'pct') };
    tot[9]  = { v: g.bid,    s: look('tot', 'money') };
    tot[10] = { v: g.actual, s: look('tot', 'actual') };
    tot[11] = { v: g.hrs,    s: look('tot', 'qty') };
    tot[12] = { v: g.laborers, s: look('tot', 'int') };
    tot[13] = { f: `${C.bid}${tr}-${C.actual}${tr}`, v: g.bid - g.actual, s: variLook('tot', g.bid - g.actual) };
    tot[14] = { v: g.proj,   s: projLook('tot', g.proj, g.bid) };
    tot[17] = { v: g.days,   s: look('tot', 'int') };
    add(tot);

    // ── Contract and projected profit, stacked under the Projected Cost
    //    they are worked against, labelled just to their left ──
    const finRow = (label, cell) => {
      const cells = [];
      cells[13] = { v: label, s: st.xf({ font: { b: true }, align: 'right' }) };
      cells[14] = cell;
      return add(cells);
    };
    const finMoney = st.xf({ fmt: FMT.money });
    let contractRow;
    if (k.coCount) {
      const o = finRow('Original Contract', { v: k.original, s: finMoney });
      const c = finRow(`Change Orders (${k.coCount})`, { v: k.coTotal, s: finMoney });
      contractRow = finRow('Revised Contract', { f: `${C.proj}${o}+${C.proj}${c}`, v: k.value, s: finMoney });
    } else {
      contractRow = finRow('Contract Value', { v: k.value, s: finMoney });
    }
    const kc = C.proj + contractRow;
    const profitRow = finRow('Projected Profit', {
      f: `IF(${kc}=0,"",${kc}-${C.proj}${tr})`, v: rep.profit === null ? '' : rep.profit,
      s: st.xf({ fmt: FMT.money, font: { b: true, color: rep.profit === null || rep.profit >= 0 ? INK.under : INK.over } }),
    });
    finRow('Projected Profit %', {
      f: `IF(${kc}=0,"",${C.proj}${profitRow}/${kc})`, v: rep.profit === null ? '' : rep.profit / k.value,
      s: st.xf({ fmt: FMT.pct }),
    });

    // ── Notes, as the PDF carries them ──
    const noteLook = st.xf({ font: { sz: 9, color: INK.muted } });
    const notes = ['Start and Target Date come from the daily sheets — the first and the latest day work was booked to the sub code. '
      + 'Dates in italics are the sheets\'; a date in plain type was entered by hand and stands ahead of them.'];
    if (anyMeasure) notes.push('The "@ $/unit" on a cost code\'s green row is its Actual Cost divided by the quantity entered for that section '
      + 'on the bid page: the section\'s own size, not a total of its sub codes, which are measured in their own units.');
    const shown = k => rep.groups.reduce((s, x) => s + x[k], 0);
    if (rep.filtered || ['bid', 'actual', 'hrs', 'proj'].some(k => Math.abs(shown(k) - g[k]) > 0.005)) {
      notes.push('The ' + (rep.filtered ? 'Project Totals' : 'Totals') + ' row is the whole job as the app reports it — every cost code, '
        + 'and every daily cost including any not booked to a bid line — so it can differ from the cost code totals above.');
    }
    add([]);
    notes.forEach(n => add([{ v: n, s: noteLook }]));

    // ── The sheet ──
    const lastCol = colName(NCOL);
    const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetPr><outlinePr summaryBelow="1"/><pageSetUpPr fitToPage="1"/></sheetPr>'
      + `<dimension ref="A1:${lastCol}${rows.length}"/>`
      // Header row and the two code columns stay put while scrolling.
      + '<sheetViews><sheetView tabSelected="1" workbookViewId="0">'
      + `<pane xSplit="2" ySplit="${HEAD_ROW}" topLeftCell="C${HEAD_ROW + 1}" activePane="bottomRight" state="frozen"/>`
      + `<selection pane="topRight" activeCell="C1" sqref="C1"/>`
      + `<selection pane="bottomLeft" activeCell="A${HEAD_ROW + 1}" sqref="A${HEAD_ROW + 1}"/>`
      + `<selection pane="bottomRight" activeCell="C${HEAD_ROW + 1}" sqref="C${HEAD_ROW + 1}"/>`
      + '</sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15" outlineLevelRow="1"/>'
      + '<cols>' + WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
      + '<sheetData>' + rows.map((row, i) => {
          const n = i + 1;
          const attrs = (row.ht ? ` ht="${row.ht}" customHeight="1"` : '') + (row.level ? ` outlineLevel="${row.level}"` : '');
          return `<row r="${n}"${attrs}>` + row.cells.map((c, ci) => cellXml(colName(ci + 1) + n, c)).join('') + '</row>';
        }).join('') + '</sheetData>'
      + '<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
      + '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
      + '</worksheet>';

    const SHEET = 'Bid Items';
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const ct  = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
    return zip([
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
        // The header row repeats at the top of every printed page.
        + `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'${SHEET}'!$${HEAD_ROW}:$${HEAD_ROW}</definedName></definedNames>`
        + '<calcPr calcId="124519" fullCalcOnLoad="1"/>'
        + '</workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>`
        + `<Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/>`
        + '</Relationships>' },
      { name: 'xl/styles.xml', data: st.xml() },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    ]);
  }

  function bidXlsxFileName(projId) {
    const p = getProj(projId) || {};
    const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    return ['bid-items', slug(p['project-name']) || 'project', slug(p['job-number']),
      `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`].filter(Boolean).join('-') + '.xlsx';
  }

  function exportBidXlsx(projId, selectedCostCodes, opts) {
    const blob = buildBidXlsx(projId, selectedCostCodes, opts);
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = bidXlsxFileName(projId);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // On a timer, not at once: Safari reads the blob after click() returns,
    // and revoking it first downloads an empty file.
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  window.buildBidXlsx  = buildBidXlsx;
  window.exportBidXlsx = exportBidXlsx;
})();
