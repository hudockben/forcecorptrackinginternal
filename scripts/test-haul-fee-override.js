#!/usr/bin/env node
'use strict';
/**
 * An unpriced haul can be priced where it is billed.
 *
 * Run: node scripts/test-haul-fee-override.js
 *
 * A "← Timesheet" row in Truck Tracking is payroll's: every cost column on it
 * is rewritten from the timesheet entry, and the tab renders them read-only.
 * The haul fee was one of them — and it is the one field where that cost more
 * than it protected. A haul approved with no fee (nobody typed one in the
 * approve modal, and the customer has no rate set beside its name) lands in the
 * tab at $0.00, and the tab is where somebody notices, because it is where the
 * invoice comes out of. Fixing it meant finding the entry in Payroll,
 * un-approving it, re-approving it with a fee, and hoping nothing else on the
 * day had moved in between.
 *
 * The fee box is now open on a locked row, as a BACKUP rather than a takeover:
 *
 *   - what the office types is stored as haul_fee_override, beside payroll's
 *     own figure (haul_fee_payroll) rather than on top of it,
 *   - haul_fee — the column nine other readers price a haul off — is DERIVED
 *     from the pair, at both writers, so none of them has to know any of this,
 *   - payroll goes on owning the fee: it can still correct one from the entry,
 *     the row says so when the two disagree, and clearing the box hands the
 *     number back.
 *
 * What this pins, in the order a fee moves through the system:
 *   1. the derivation (api/lib/truck-injected.js) — the rules, in isolation,
 *   2. a tab save (injected-blob-guard) — the office's number lands, and the
 *      rest of the row is still the server's,
 *   3. a re-approval (api/timesheet-entries.js) — a correction upstream does
 *      not restate a fee the office has already invoiced under,
 *   4. the page (trucking.html) — the box is really a box, wired to the
 *      override and not to haul_fee,
 *   5. the round trip (api/truck-division.js + neon-schema.sql).
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');

const {
  TRUCK_TAB_FIELDS, HAUL_FEE_OVERRIDE, HAUL_FEE_PAYROLL, HAUL_FEE_MAX,
  normalizeHaulFee, sameHaulFee, applyHaulFeeOverride, TRUCK_DIVISION_BLOB,
} = require('../api/lib/truck-injected.js');
const {
  guardConfigFor, mergeInjectedRows, guardInjectedBlobWrite,
} = require('../api/lib/injected-blob-guard.js');
const { insertTruckingRow } = require('../api/timesheet-entries.js')._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
function slice(src, from, to, label) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : to})`);
  return src.slice(a, b);
}

const TRUCK = guardConfigFor('fct_truck_division');
const CO = 'ACME', KEY = `${CO}:${TRUCK_DIVISION_BLOB}`;

/**
 * The app_data blob store the two write paths read and write, plus the
 * truck_division_entries mirror the injector upserts each row into.
 *
 * The mirror rows are read positionally out of upsertTruckDivisionEntry's
 * column list. That table is what the executive report and Intercompany read,
 * so a fee derived into the blob but not into the mirror is a row billed at one
 * number and reported at another.
 */
function mockSql(store, mirror = new Map()) {
  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT value FROM app_data')) {
      let k = values[0];
      if (k === undefined) { const m = q.match(/key = '([^']*)'/); k = m ? m[1] : undefined; }
      const v = store.get(k);
      return Promise.resolve(v === undefined ? [] : [{ value: v }]);
    }
    if (q.startsWith('INSERT INTO app_data')) {
      store.set(values[0], typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1]);
      return Promise.resolve([]);
    }
    if (q.startsWith('INSERT INTO truck_division_entries')) {
      const [id, , , , , , , , total_hours, haul_fee, haul_fee_override, haul_fee_payroll,
             customer] = values;
      mirror.set(id, { id, total_hours, haul_fee, haul_fee_override, haul_fee_payroll, customer });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  sql.mirror = mirror;
  return sql;
}

/* ── The page, running its own functions over a real DOM ──────────────────── */
const TRUCKING = read('trucking.html');
const TOTALS   = slice(TRUCKING, '    /** Re-total a row and keep its Intercompany Billing mirror in step. */',
                                 '    /* ═══════════════════════════════════════════\n       BACKUP HAUL FEE',
                                 '_syncRowTotal + updateField');
const BACKUP   = slice(TRUCKING, '    /* ═══════════════════════════════════════════\n       BACKUP HAUL FEE',
                                 '    /* ═══════════════════════════════════════════\n       SCHEDULER',
                                 'backup fee + column filters + renderTrackingTab');

function newPage(entries) {
  const dom = new JSDOM('<div id="tab-truck-tracking"></div>');
  const sandbox = {
    console, document: dom.window.document,
    divEntries: entries,
    divTruckLists: { drivers: [], customers: [], units: [], rates: {} },
    icBillingArr: [], icSentMap: new Map(),
    activeYearFilter: 'all',
    saves: 0,
    schedSave() { sandbox.saves++; },
    isPayrollRowId: id => String(id || '').startsWith('tst-'),
    customerRate: () => '',
    calcHours: () => null,
    cbHtml: (id, field, cur) => `<input data-cb="${field}" value="${cur}">`,
    fmtTime12: v => String(v || ''),
    fmtSentAt: v => String(v || ''),
    _isSaved: true,
    setYearFilter() {}, toggleInvoiceRow() {}, addRow() {}, openManageLists() {},
    triggerCSVUpload() {}, downloadCSVTemplate() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(TOTALS + '\n' + BACKUP, sandbox, { filename: 'trucking.html' });
  return { page: sandbox, dom, render: () => { sandbox.renderTrackingTab(); return dom.window.document; } };
}

/** The <td> at `idx` of the row whose first cell holds `id`'s caret. */
function rowCells(doc, id) {
  const caret = doc.getElementById('caret-' + id);
  return caret ? [...caret.closest('tr').children] : null;
}

(async () => {
  console.log('The backup haul fee — pricing a payroll row from the tab it is billed in\n');

  // ── 1. The rules ────────────────────────────────────────────────────────
  console.log('[the derivation]');
  {
    const ovr = (row) => applyHaulFeeOverride({ id: 'tst-42-row', ...row });

    const priced = ovr({ haul_fee: '', haul_fee_override: '135' });
    assert('an override prices a haul payroll left blank', priced.haul_fee === 135);
    assert('and payroll\'s blank is recorded behind it', priced[HAUL_FEE_PAYROLL] === '');

    const over = ovr({ haul_fee: 115, haul_fee_override: 135 });
    assert('an override outranks payroll\'s number', over.haul_fee === 135);
    assert('and payroll\'s number is kept, not lost', over[HAUL_FEE_PAYROLL] === 115);

    const cleared = ovr({ haul_fee: 135, haul_fee_payroll: 115, haul_fee_override: '' });
    assert('clearing it hands payroll\'s number back', cleared.haul_fee === 115);
    assert('and takes the receipt off the row',
      !(HAUL_FEE_OVERRIDE in cleared) && !(HAUL_FEE_PAYROLL in cleared));

    const agrees = ovr({ haul_fee: 115, haul_fee_payroll: 115, haul_fee_override: '115' });
    assert('an override that agrees with payroll is dropped',
      agrees.haul_fee === 115 && !(HAUL_FEE_OVERRIDE in agrees));

    // '115' from a JSON blob and 115 from payroll are the same fee. Read raw
    // they are not, and every row would read as a disagreement.
    assert('a string and a number are the same fee', sameHaulFee('115', 115));

    const zero = ovr({ haul_fee: 115, haul_fee_override: 0 });
    assert('$0 typed on purpose is a fee, not a blank', zero.haul_fee === 0 && zero[HAUL_FEE_OVERRIDE] === 0);
    const blank = ovr({ haul_fee: 115, haul_fee_override: '   ' });
    assert('a whitespace box is not $0', blank.haul_fee === 115 && !(HAUL_FEE_OVERRIDE in blank));

    const label = v => (typeof v === 'number' && Number.isNaN(v)) ? 'NaN' : JSON.stringify(v);
    for (const junk of [-5, 'abc', HAUL_FEE_MAX + 1, NaN, {}]) {
      const bad = ovr({ haul_fee: 115, haul_fee_override: junk });
      assert(`a junk override (${label(junk)}) is ignored, not billed`,
        bad.haul_fee === 115 && !(HAUL_FEE_OVERRIDE in bad), JSON.stringify(bad.haul_fee));
    }

    // The guard runs this on a row it just read back, so a second pass must not
    // read the derived fee as payroll's and freeze the override in as the truth.
    const once  = ovr({ haul_fee: 115, haul_fee_override: 135 });
    const twice = applyHaulFeeOverride({ ...once });
    assert('running it twice changes nothing',
      twice.haul_fee === 135 && twice[HAUL_FEE_PAYROLL] === 115);
    const back = applyHaulFeeOverride({ ...twice, [HAUL_FEE_OVERRIDE]: '' });
    assert('and payroll\'s number is still there to go back to', back.haul_fee === 115);

    assert('the fee gate reads a blank as unpriced', normalizeHaulFee('  ').value === '');
    assert('and rounds a price to the cent it is billed at', normalizeHaulFee('115.12345').value === 115.1235);
  }

  // ── 2. A tab save ───────────────────────────────────────────────────────
  console.log('\n[a save from the tab]');
  {
    const srv = [{ id: 'tst-42-row', driver: 'barrmike', total_hours: 2, haul_fee: '',
                   customer: 'Ox Hill', qb_invoice: '', invoice_status: 'Unpaid' }];
    // What the page sends after somebody types 135 into the locked row's box.
    const inc = [{ ...srv[0], haul_fee: 135, haul_fee_override: 135 }];
    const [row] = mergeInjectedRows(srv, inc, TRUCK);
    assert('the fee typed in the tab lands on the row', row.haul_fee === 135);
    assert('as an override, not as payroll\'s figure', row[HAUL_FEE_OVERRIDE] === 135);
    assert('with payroll\'s blank recorded behind it', row[HAUL_FEE_PAYROLL] === '');

    // Everything else on the row is still payroll's — that is the guard's whole
    // job, and opening one box must not have opened the rest.
    const meddling = [{ ...srv[0], haul_fee_override: 135, driver: 'nobody',
                        total_hours: 999, customer: 'Somewhere else' }];
    const [held] = mergeInjectedRows(srv, meddling, TRUCK);
    assert('the driver is still payroll\'s',  held.driver === 'barrmike');
    assert('the hours are still payroll\'s',  held.total_hours === 2);
    assert('the customer is still payroll\'s', held.customer === 'Ox Hill');

    // haul_fee is derived, never taken from the client: a save that moves it
    // without an override behind it is a stale copy or a forged one.
    const raw = [{ ...srv[0], haul_fee: 999 }];
    assert('a bare haul_fee from the tab is ignored',
      mergeInjectedRows(srv, raw, TRUCK)[0].haul_fee === '');
    // Same for the receipt: payroll's figure is the server's to write, or an
    // override could be made to look like agreement and quietly stick.
    const forged = [{ ...srv[0], haul_fee_override: 135, haul_fee_payroll: 135 }];
    const [f] = mergeInjectedRows(srv, forged, TRUCK);
    assert('and a forged haul_fee_payroll is overwritten',
      f[HAUL_FEE_PAYROLL] === '' && f.haul_fee === 135, JSON.stringify(f));

    assert('the override is a column the tab owns', TRUCK_TAB_FIELDS.includes(HAUL_FEE_OVERRIDE));
    assert('the fee itself is not', !TRUCK_TAB_FIELDS.includes('haul_fee'));
    assert('and neither is payroll\'s figure', !TRUCK_TAB_FIELDS.includes(HAUL_FEE_PAYROLL));

    // A row the tab owns outright is saved exactly as sent — no derivation, no
    // receipt, nothing added to a fee the office has always been able to type.
    const manual = { id: 'TR-1001', haul_fee: 121, customer: 'Kinkead' };
    const [kept] = mergeInjectedRows(srv, [manual], TRUCK);
    assert('a hand-added row is untouched by any of this',
      kept.haul_fee === 121 && !(HAUL_FEE_OVERRIDE in kept) && !(HAUL_FEE_PAYROLL in kept));

    // End to end through the route's own entry point.
    const store = new Map([[KEY, srv]]);
    const stored = await guardInjectedBlobWrite(mockSql(store), CO, 'fct_truck_division', inc);
    assert('the guarded write stores the derived fee', stored[0].haul_fee === 135);
  }

  // ── 3. A correction upstream ─────────────────────────────────────────────
  console.log('\n[payroll corrects the entry underneath it]');
  {
    const store = new Map([[KEY, []]]);
    const sql   = mockSql(store);
    const entry = {
      id: 42, company_code: CO, username: 'barrmike', entry_type: 'daily', division: 'trucking',
      work_date: '2026-09-01', job_id: 'Ox Hill', job_label: 'Ox Hill',
      start_time: '13:00', end_time: '15:30', computed_hours: 2.5,
    };

    // Approved with no fee — nobody typed one, and Ox Hill has no rate set.
    await insertTruckingRow(sql, CO, entry, {});
    assert('the haul arrives unpriced', store.get(KEY)[0].haul_fee === '');

    // The office prices it in the tab and invoices it.
    const arr = store.get(KEY);
    Object.assign(arr[0], { haul_fee: 135, haul_fee_override: 135, haul_fee_payroll: '',
                            qb_invoice: 'QB-9001' });
    store.set(KEY, arr);

    // Payroll corrects the hours and re-approves.
    await insertTruckingRow(sql, CO, { ...entry, end_time: '16:00', computed_hours: 3 }, {});
    let [row] = store.get(KEY);
    assert('the correction lands', Number(row.total_hours) === 3, String(row.total_hours));
    assert('and the fee the office invoiced under survives it', row.haul_fee === 135);
    assert('still marked as the office\'s', row[HAUL_FEE_OVERRIDE] === 135);
    assert('and the QB number beside it', row.qb_invoice === 'QB-9001');

    // Payroll now sets a fee of its own on the entry. The office's number still
    // stands — it was set deliberately and has been billed — but payroll's is
    // recorded, which is what lets the tab show the disagreement and offer it.
    await insertTruckingRow(sql, CO, { ...entry, end_time: '16:00', computed_hours: 3 }, { haul_fee: 115 });
    [row] = store.get(KEY);
    assert('a fee typed in payroll does not overwrite the office\'s', row.haul_fee === 135);
    assert('but it is recorded behind it', row[HAUL_FEE_PAYROLL] === 115);
    // The mirror is what the executive report and Intercompany read.
    const mir = sql.mirror.get(row.id);
    assert('the mirror bills the same number', mir && mir.haul_fee === 135, JSON.stringify(mir));
    assert('and records where it came from',
      mir && mir.haul_fee_override === 135 && mir.haul_fee_payroll === 115, JSON.stringify(mir));

    // The office takes payroll's figure: clear the box, save, re-approve again.
    const arr2 = store.get(KEY);
    delete arr2[0][HAUL_FEE_OVERRIDE];
    store.set(KEY, [applyHaulFeeOverride(arr2[0])]);
    assert('clearing the box takes payroll\'s number', store.get(KEY)[0].haul_fee === 115);
    await insertTruckingRow(sql, CO, { ...entry, end_time: '16:00', computed_hours: 3 }, { haul_fee: 115 });
    [row] = store.get(KEY);
    assert('and it stays payroll\'s across the next approval',
      row.haul_fee === 115 && !(HAUL_FEE_OVERRIDE in row));
    const cleared = sql.mirror.get(row.id);
    assert('and the mirror stops describing an override that is gone',
      cleared && cleared.haul_fee === 115 && cleared.haul_fee_override == null,
      JSON.stringify(cleared));
  }

  // A leg id is positional. Remove the first haul of a two-haul day and the
  // second is rewritten under the first one's id — different work, so it must
  // not inherit the first customer's fee any more than its QB number.
  {
    const store = new Map([[KEY, []]]);
    const sql   = mockSql(store);
    const base  = {
      id: 77, company_code: CO, username: 'rickl', entry_type: 'daily', division: 'trucking',
      work_date: '2026-09-02', job_id: 'Kovalchick', job_label: 'Kovalchick',
      start_time: '05:30', end_time: '16:45', computed_hours: 11.25,
    };
    await insertTruckingRow(sql, CO, base, { rows: [
      { company: 'Kovalchick', start_time: '05:30', end_time: '11:00' },
      { company: 'Arcadis',    start_time: '11:00', end_time: '16:45' },
    ] });
    const arr = store.get(KEY);
    Object.assign(arr[0], { haul_fee: 135, haul_fee_override: 135, haul_fee_payroll: '' });
    store.set(KEY, arr);
    // The Kovalchick leg is dropped; Arcadis moves up into its id.
    await insertTruckingRow(sql, CO, base, { rows: [
      { company: 'Arcadis', start_time: '11:00', end_time: '16:45' },
    ] });
    const [moved] = store.get(KEY);
    assert('a leg whose customer changed does not inherit the fee',
      moved.customer === 'Arcadis' && moved.haul_fee === '' && !(HAUL_FEE_OVERRIDE in moved),
      `${moved.customer} @ ${JSON.stringify(moved.haul_fee)}`);
  }

  // ── 4. The page ──────────────────────────────────────────────────────────
  console.log('\n[the tab renders a box, and it is wired to the override]');
  {
    const locked = { id: 'tst-42-row', task_number: 'TR-1111', actual_date: '2026-09-02',
      driver: 'barrmike', unit: '3999 SPRAY', actual_start: '10:30', actual_end: '12:30',
      total_hours: 2, haul_fee: '', customer: 'Ox Hill', description: 'Ultra bond',
      division: 'Dust', notes: '', invoice_status: 'Unpaid' };
    const manual = { id: 'TR-1002', task_number: 'TR-1002', actual_date: '2026-09-02',
      driver: 'Boring, Jamey', unit: '2773', total_hours: 1.25, haul_fee: 115,
      customer: 'Arcadis', invoice_status: 'Unpaid' };

    const { page, render } = newPage([locked, manual]);
    const doc = render();

    const cells = rowCells(doc, locked.id);
    assert('the locked row rendered', !!cells && cells.length === 15, cells && String(cells.length));
    const feeCell = cells[8];
    const box = feeCell.querySelector('input');
    assert('its haul fee is a box, not read-only text', !!box, feeCell.innerHTML.trim().slice(0, 80));
    assert('typing in it goes to the override, not to haul_fee',
      !!box && /setBackupFee\('tst-42-row'/.test(box.getAttribute('onchange') || ''),
      box && box.getAttribute('onchange'));
    assert('and it says it is the backup, so nobody reads it as unlocked',
      !!box && /backup/i.test(box.getAttribute('title') || ''));

    // The rest of the row is still read-only. A box that takes what is typed
    // and loses it on the next save is worse than no box at all.
    for (const [idx, name] of [[3, 'driver'], [4, 'unit'], [5, 'start'], [6, 'end'],
                               [7, 'hours'], [10, 'customer'], [11, 'description']]) {
      assert(`the ${name} column is still read-only`, !cells[idx].querySelector('input,select'),
        cells[idx].innerHTML.trim().slice(0, 60));
    }
    assert('the row is still undeletable', !cells[14].querySelector('button'));
    assert('and still shows the padlock', /128274|🔒/.test(cells[14].innerHTML));

    // The hand-added row beside it is unchanged.
    const mcells = rowCells(doc, manual.id);
    assert('a hand-added row still has every column open',
      !!mcells && !!mcells[8].querySelector('input') && !!mcells[14].querySelector('button'));

    // Typing a fee.
    page.setBackupFee('tst-42-row', '135');
    assert('the fee reaches the row', page.divEntries[0].haul_fee === 135);
    assert('as an override', page.divEntries[0][HAUL_FEE_OVERRIDE] === 135);
    assert('with payroll\'s blank behind it', page.divEntries[0][HAUL_FEE_PAYROLL] === '');
    assert('the row total is re-figured', doc.getElementById('td-tot-tst-42-row').textContent === '$270.00',
      doc.getElementById('td-tot-tst-42-row').textContent);
    assert('and the save is queued', page.saves === 1);
    const note = doc.getElementById('fee-ovr-tst-42-row');
    assert('the row says the fee was set here', /set here/.test(note.innerHTML));
    assert('and offers the way back to payroll\'s answer',
      /clearBackupFee\('tst-42-row'\)/.test(note.innerHTML)
      && /Payroll has no fee on this haul/.test(note.innerHTML),
      note.innerHTML);

    // Payroll's figure, once it has one, is what the note offers.
    page.divEntries[0][HAUL_FEE_PAYROLL] = 115;
    render();
    // Labelled, not bare: an unlabelled number under a fee box reads as the fee.
    assert('a disagreement shows payroll\'s number, and says whose it is',
      /payroll \$115\.00/.test(doc.getElementById('fee-ovr-tst-42-row').innerHTML),
      doc.getElementById('fee-ovr-tst-42-row').innerHTML);

    // Clearing it.
    page.clearBackupFee('tst-42-row');
    assert('clearing the box takes payroll\'s number back', page.divEntries[0].haul_fee === 115);
    assert('and drops the receipt', !(HAUL_FEE_OVERRIDE in page.divEntries[0]));
    assert('the box shows it', doc.getElementById('th-fee-tst-42-row').value === '115');
    assert('and the note is gone', doc.getElementById('fee-ovr-tst-42-row').innerHTML === '');

    // Junk is refused rather than saved — the server would drop it, and a fee
    // that vanishes on the next load is the failure this is meant to prevent.
    const before = page.saves;
    page.setBackupFee('tst-42-row', '-5');
    assert('a negative fee is refused', page.divEntries[0].haul_fee === 115 && page.saves === before);
    page.setBackupFee('tst-42-row', 'abc');
    assert('so is one that is not a number', page.divEntries[0].haul_fee === 115 && page.saves === before);
    assert('and the box is put back to what the row really bills',
      doc.getElementById('th-fee-tst-42-row').value === '115');

    // $0 is a fee somebody can mean.
    page.setBackupFee('tst-42-row', '0');
    assert('$0 typed on purpose is stored', page.divEntries[0].haul_fee === 0
      && page.divEntries[0][HAUL_FEE_OVERRIDE] === 0);

    // The page must not offer this on a row it owns outright — there the fee IS
    // the fee, and wrapping it in an override would shadow a column nothing
    // else on a manual row uses.
    page.setBackupFee('TR-1002', '99');
    assert('a hand-added row is not overridden, it is just edited',
      page.divEntries[1].haul_fee === 115 && !(HAUL_FEE_OVERRIDE in page.divEntries[1]));

    // The page's gate has to be the server's gate, or the tab accepts a figure
    // the guard then drops.
    assert('the page reads a fee exactly as the server does',
      /const HAUL_FEE_MAX = 1e7;/.test(TRUCKING)
      && /if \(!Number\.isFinite\(n\) \|\| n < 0 \|\| n > HAUL_FEE_MAX\) return null;/.test(TRUCKING));
  }

  // ── 5. The round trip ────────────────────────────────────────────────────
  console.log('\n[the receipt survives the round trip]');
  {
    const ROUTE  = read('api/truck-division.js');
    const SCHEMA = read('neon-schema.sql');
    assert('the mirror table has both columns',
      /haul_fee_override NUMERIC\(10,4\)/.test(SCHEMA) && /haul_fee_payroll  NUMERIC\(10,4\)/.test(SCHEMA));
    assert('and an existing database gets them',
      /ALTER TABLE truck_division_entries ADD COLUMN IF NOT EXISTS haul_fee_override/.test(SCHEMA)
      && /ALTER TABLE truck_division_entries ADD COLUMN IF NOT EXISTS haul_fee_payroll/.test(SCHEMA));
    assert('the sync writes them',
      /\$\{safeFloat\(e\.haul_fee_override\)\}/.test(ROUTE) && /\$\{safeFloat\(e\.haul_fee_payroll\)\}/.test(ROUTE));
    assert('and updates them on conflict',
      /haul_fee_override = EXCLUDED\.haul_fee_override/.test(ROUTE)
      && /haul_fee_payroll  = EXCLUDED\.haul_fee_payroll/.test(ROUTE));
    assert('and the table-fallback read carries them back',
      /r\.haul_fee_override != null \? \{ haul_fee_override: Number\(r\.haul_fee_override\) \}/.test(ROUTE));
    // Only when there is one. Every manual row would otherwise come back
    // carrying two null columns the tab has to reason about.
    assert('but only on a row that has one', /: \{\}\)/.test(ROUTE));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
