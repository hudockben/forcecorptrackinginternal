#!/usr/bin/env node
'use strict';
/**
 * Un-approved Truck Tracking rows must stay gone.
 *
 * Run: node scripts/test-trucking-orphan-sweep.js
 *
 * The bug this locks down: payroll un-approved (or deleted) a timesheet entry,
 * the injected Truck Tracking row was removed — and it came back on the next
 * load of trucking.html, permanently, with no way to delete it from the tab.
 *
 * Two defects combined to produce that.
 *
 *   1. insertTruckingRow stamped the row id with Date.now(), so re-approving a
 *      corrected entry minted a SECOND identity. Intercompany keys its billing
 *      entry off the row id, so the first one was left describing a row nothing
 *      owned any more.
 *   2. Nothing removed the Intercompany billing entry when the row went away,
 *      and trucking.html's _recoverEntriesFromIcBilling reads a billing entry
 *      with no matching row as a row lost to a blob overwrite — so it rebuilt
 *      the row from the orphan. The rebuilt row kept the original id, which the
 *      tab refuses to delete and which the re-approved entry no longer owned.
 *
 * Real case: barrmike's 12 Aug entry was approved at 18.5h, corrected to 12.5h
 * and re-approved — and Truck Tracking showed BOTH, billing Antero for 31h.
 *
 * Covers the stable row id, the billing-entry removal, the read-time sweep that
 * clears rows stranded before those fixes, and the two guards in trucking.html.
 * No DB or server required.
 */

const path = require('path');
const fs   = require('fs');

const {
  truckingRowId, truckingRowIdPrefix, entryIdFromTruckRowId, isInjectedTruckRowId,
  truckRowRecency, findStaleTruckRows, sweepInjectedTruckRows,
  removeIcBillingEntries, TRUCK_DIVISION_BLOB, IC_BILLING_BLOB, IC_SOURCE_TRUCKING,
} = require('../api/lib/truck-injected.js');
const { insertTruckingRow, removeTruckingRows } = require('../api/timesheet-entries.js')._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const CO        = 'ACME';
const TRUCK_KEY = `${CO}:${TRUCK_DIVISION_BLOB}`;
const IC_KEY    = `${CO}:${IC_BILLING_BLOB}`;

// ── In-memory mock of the neon `sql` tagged template ────────────────────────
// Backs app_data (the truck + billing blobs), timesheet_entries (the sweep's
// one lookup), and the two mirror tables the sweep prunes.
function makeSql(initial = {}) {
  const store = {
    appData:  new Map(Object.entries(initial.appData || {})),
    entries:  new Map((initial.entries || []).map(e => [Number(e.id), e])),
    tde:      new Set(initial.tde || []),
    // intercompany_billing_entries: keyed by its own id, deleted by source_id.
    icMirror: new Map(initial.icMirror || []),
    // dust_control_entries, by row id — the Dust Control Tracking rows payroll
    // has posted. The sweep asks which of these hauls the dust office bills off
    // its own grid; a row here is what says leg N does.
    dustRows: new Set(initial.dustRows || []),
    queries:  [],
  };
  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();
    store.queries.push(q);

    if (q.startsWith('SELECT id, status, entry_type, division, job_id FROM timesheet_entries')) {
      const ids = values[values.length - 1] || [];
      return Promise.resolve(ids.map(id => store.entries.get(Number(id))).filter(Boolean));
    }
    if (q.startsWith('SELECT value FROM app_data')) {
      let key = values[0];
      if (key === undefined) { const m = q.match(/key = '([^']*)'/); key = m ? m[1] : undefined; }
      const v = store.appData.has(key) ? store.appData.get(key) : null;
      return Promise.resolve(v == null ? [] : [{ value: v }]);
    }
    if (q.startsWith('INSERT INTO app_data')) {
      const arr = typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1];
      store.appData.set(values[0], arr);
      return Promise.resolve([]);
    }
    // removeIcBillingEntries: key, source, ids, source, ids, key
    if (q.startsWith('WITH hits AS')) {
      const [key, source, ids] = values;
      const cur = store.appData.get(key);
      if (!Array.isArray(cur)) return Promise.resolve([{ removed: 0 }]);
      const hit  = e => e && e.source === source && ids.includes(String(e.source_id || ''));
      const next = cur.filter(e => !hit(e));
      const removed = cur.length - next.length;
      if (removed) store.appData.set(key, next);
      return Promise.resolve([{ removed }]);
    }
    // deleteTruckBlobRows (t->>'id') vs clearIcSuppression (t->>'source')
    if (q.startsWith('UPDATE app_data') && q.includes('jsonb_array_elements')) {
      if (q.includes("t->>'id'")) {
        const [ids, key] = values;
        const cur = store.appData.get(key);
        if (Array.isArray(cur)) store.appData.set(key, cur.filter(t => !(t && ids.includes(String(t.id || '')))));
        return Promise.resolve([]);
      }
      const [source, sourceId, key] = values;
      const cur = store.appData.get(key);
      if (!Array.isArray(cur)) return Promise.resolve([]);
      const next = cur.filter(t => !(t && t.source === source && t.source_id === sourceId));
      if (next.length === cur.length) return Promise.resolve([]);
      store.appData.set(key, next);
      return Promise.resolve([{ cleared: 1 }]);
    }
    if (q.startsWith('DELETE FROM truck_division_entries')) {
      (values[values.length - 1] || []).forEach(id => store.tde.delete(id));
      return Promise.resolve([]);
    }
    if (q.startsWith('DELETE FROM intercompany_billing_entries')) {
      const sourceIds = values[values.length - 1] || [];
      for (const [id, sourceId] of [...store.icMirror]) {
        if (sourceIds.includes(sourceId)) store.icMirror.delete(id);
      }
      return Promise.resolve([]);
    }
    if (q.startsWith('INSERT INTO truck_division_entries')) {
      store.tde.add(values[0]);
      return Promise.resolve([]);
    }
    // dustBilledLegs: which legs of these entries have a Dust Control Tracking
    // row, matched by the "tsd-<entryId>-%" patterns the caller builds.
    if (q.startsWith('SELECT id FROM dust_control_entries')) {
      const patterns = (values[values.length - 1] || []).map(p => String(p).replace(/%$/, ''));
      return Promise.resolve(
        [...store.dustRows].filter(id => patterns.some(p => String(id).startsWith(p)))
                           .map(id => ({ id }))
      );
    }
    if (q.startsWith('SELECT value FROM dropdown_lists')) return Promise.resolve([]);
    if (q.includes('FROM dropdown_lists')) return Promise.resolve([]);
    throw new Error('Unexpected query in mock: ' + q.slice(0, 90));
  };
  return { sql, store };
}

const tsEntry = (over = {}) => ({
  id: 42, company_code: CO, username: 'barrmike', entry_type: 'daily',
  division: 'trucking', status: 'approved', work_date: '2026-08-12',
  job_id: 'Antero', job_label: 'Antero',
  start_time: '05:00', end_time: '17:30', computed_hours: 12.5, travel_hours: 0,
  ...over,
});
const icEntry = (sourceId, over = {}) => ({
  id: 'ic-' + sourceId, source: IC_SOURCE_TRUCKING, source_id: sourceId,
  company_name: 'Antero', total: 1512.5, sent_at: '2026-08-13T16:44:00Z', ...over,
});

(async () => {
  console.log('Truck Tracking orphan lifecycle\n');

  // ── The row id is an identity, not a timestamp ───────────────────────────
  console.log('[row id is stable]');
  {
    assert('same entry → same id every time', truckingRowId(42) === truckingRowId(42));
    assert('and it carries no clock',        !/\d{10,}/.test(truckingRowId(42)));
    assert('still under the sweep prefix',   truckingRowId(42).startsWith(truckingRowIdPrefix(42)));
    assert('different entries stay distinct', truckingRowId(42) !== truckingRowId(43));
    assert('id parses back to its entry',    entryIdFromTruckRowId(truckingRowId(42)) === 42);
    assert('legacy stamped id parses too',   entryIdFromTruckRowId('tst-42-1755123456789') === 42);
    assert('a manual row is not ours',       !isInjectedTruckRowId('9d0f1a2b-uuid'));
    assert('a "TR-" task row is not ours',   !isInjectedTruckRowId('TR-1016'));
    assert('canonical id outranks any stamp',
      truckRowRecency('tst-42-row') > truckRowRecency('tst-42-9999999999999'));
    assert('newer stamp outranks older',
      truckRowRecency('tst-42-1755200000000') > truckRowRecency('tst-42-1755100000000'));
  }

  // ── Re-approving keeps the row's identity ────────────────────────────────
  // The whole failure starts here: a second id meant a second row, and a
  // billing entry left pointing at the first.
  console.log('\n[re-approval reuses the row rather than adding one]');
  {
    const { sql, store } = makeSql({ appData: { [TRUCK_KEY]: [] } });
    const first  = await insertTruckingRow(sql, CO, tsEntry({ computed_hours: 12.5, travel_hours: 6 }), {});
    const second = await insertTruckingRow(sql, CO, tsEntry({ computed_hours: 12.5, travel_hours: 0 }), {});
    const blob   = store.appData.get(TRUCK_KEY);
    assert('id survives the correction', first.id === second.id);
    assert('exactly one row in the blob', blob.length === 1, `found ${blob.length}`);
    assert('and it carries the corrected hours', Number(blob[0].total_hours) === 12.5);
    assert('mirror holds one row too', store.tde.size === 1, `found ${store.tde.size}`);
  }

  // ── A legacy stamped row is cleaned up by the next approval ─────────────
  console.log('\n[an old stamped row is replaced, not joined]');
  {
    const legacyId = 'tst-42-1755100000000';
    const { sql, store } = makeSql({
      appData: {
        [TRUCK_KEY]: [{ id: legacyId, total_hours: 18.5, customer: 'Antero' }],
        [IC_KEY]:    [icEntry(legacyId), icEntry('manual-1', { company_name: 'Kinkead' })],
      },
      tde: [legacyId], icMirror: [['ic-' + legacyId, legacyId]],
    });
    const row  = await insertTruckingRow(sql, CO, tsEntry(), {});
    const blob = store.appData.get(TRUCK_KEY);
    assert('the stamped row is gone', !blob.some(r => r.id === legacyId));
    assert('replaced by the canonical one', blob.length === 1 && blob[0].id === truckingRowId(42));
    assert('its billing entry went with it',
      !store.appData.get(IC_KEY).some(e => e.source_id === legacyId));
    assert('another row\'s billing entry is untouched',
      store.appData.get(IC_KEY).some(e => e.source_id === 'manual-1'));
    assert('mirror row cleared', !store.tde.has(legacyId));
    assert('billing mirror cleared', !store.icMirror.has('ic-' + legacyId));
    assert('the new row is mirrored', store.tde.has(row.id));
  }

  // ── Un-approving takes the billing entry with the row ───────────────────
  console.log('\n[un-approve removes the row AND stops the billing]');
  {
    const id = truckingRowId(42);
    const { sql, store } = makeSql({
      appData: {
        [TRUCK_KEY]: [{ id, total_hours: 12.5 }, { id: 'manual-1', total_hours: 8 }],
        [IC_KEY]:    [icEntry(id), icEntry('manual-1')],
      },
      tde: [id, 'manual-1'], icMirror: [['ic-' + id, id], ['ic-manual-1', 'manual-1']],
    });
    const removed = await removeTruckingRows(sql, CO, tsEntry());
    assert('one row removed', removed === 1);
    assert('gone from the blob', !store.appData.get(TRUCK_KEY).some(r => r.id === id));
    assert('gone from the mirror', !store.tde.has(id));
    assert('its billing entry is gone',
      !store.appData.get(IC_KEY).some(e => e.source_id === id));
    assert('billing mirror row is gone', !store.icMirror.has('ic-' + id));
    assert('the manual row is untouched',
      store.appData.get(TRUCK_KEY).some(r => r.id === 'manual-1'));
    assert('and so is its billing entry',
      store.appData.get(IC_KEY).some(e => e.source_id === 'manual-1'));
    // With no billing entry left there is nothing for the page's recovery pass
    // to read as a lost row — which is what used to resurrect it.
    assert('nothing left to resurrect the row from',
      store.appData.get(IC_KEY).filter(e => e.source_id.startsWith('tst-')).length === 0);
  }

  // ── Which rows the sweep considers stale ────────────────────────────────
  console.log('\n[stale-row rules]');
  {
    const byId = new Map([
      [1, { id: 1, status: 'approved',  entry_type: 'daily', division: 'trucking', job_id: 'Antero' }],
      [2, { id: 2, status: 'submitted', entry_type: 'daily', division: 'trucking', job_id: 'Antero' }],
      [4, { id: 4, status: 'approved',  entry_type: 'daily', division: 'turf',     job_id: 'p-1' }],
      [5, { id: 5, status: 'approved',  entry_type: 'daily', division: 'dust',     job_id: 'ees:washing' }],
      [6, { id: 6, status: 'approved',  entry_type: 'daily', division: 'dust',     job_id: 'Kinkead' }],
      [7, { id: 7, status: 'approved',  entry_type: 'time_off', division: 'trucking', job_id: null }],
    ]);
    const rows = [
      { id: 'tst-1-row' },              // approved trucking     → keep
      { id: 'tst-2-row' },              // un-approved           → stale
      { id: 'tst-3-row' },              // entry deleted         → stale
      { id: 'tst-4-row' },              // moved to turf         → stale
      { id: 'tst-5-row' },              // dust EES tab now      → stale
      { id: 'tst-6-row' },              // dust customer haul    → keep
      { id: 'tst-7-row' },              // now time off          → stale
      { id: 'manual-uuid' },            // office's own row      → never touched
      { id: 'TR-1016' },                // office's own row      → never touched
    ];
    const stale = findStaleTruckRows(rows, byId);
    assert('approved trucking row kept',      !stale.includes('tst-1-row'));
    assert('un-approved row is stale',         stale.includes('tst-2-row'));
    assert('deleted entry\'s row is stale',    stale.includes('tst-3-row'));
    assert('row rerouted to turf is stale',    stale.includes('tst-4-row'));
    assert('row now owned by the EES tab is stale', stale.includes('tst-5-row'));
    assert('dust customer haul kept',         !stale.includes('tst-6-row'));
    assert('row turned into time off is stale', stale.includes('tst-7-row'));
    assert('manual rows are never candidates',
      !stale.includes('manual-uuid') && !stale.includes('TR-1016'));
    assert('nothing else swept up', stale.length === 5, JSON.stringify(stale));
  }

  // ── Duplicates: exactly one row survives per entry ──────────────────────
  console.log('\n[one row per entry]');
  {
    const byId = new Map([[42, tsEntry()]]);
    const older = 'tst-42-1755100000000', newer = 'tst-42-1755200000000';
    const a = findStaleTruckRows([{ id: older }, { id: newer }], byId);
    assert('the older stamped row loses', a.length === 1 && a[0] === older);
    const b = findStaleTruckRows([{ id: newer }, { id: older }], byId);
    assert('order of the list does not decide it', b.length === 1 && b[0] === older);
    const c = findStaleTruckRows([{ id: newer }, { id: 'tst-42-row' }], byId);
    assert('the canonical id beats any stamp', c.length === 1 && c[0] === newer);
    const d = findStaleTruckRows([{ id: 'tst-42-row' }], byId);
    assert('a lone valid row is left alone', d.length === 0);
  }

  // ── The sweep, end to end ───────────────────────────────────────────────
  console.log('\n[the read-time sweep]');
  {
    // barrmike, 12 Aug: approved at 18.5h, corrected to 12.5h and re-approved.
    // The 18.5h row was rebuilt from its orphaned billing entry and had been
    // sitting in Truck Tracking ever since, billing Antero a second time.
    const ghost = 'tst-42-1755100000000';
    const live  = truckingRowId(42);
    const rows  = [
      { id: ghost, driver: 'Mike Barr', total_hours: 18.5, haul_fee: 121, customer: 'Antero' },
      { id: live,  driver: 'Mike Barr', total_hours: 12.5, haul_fee: 121, customer: 'Antero' },
      { id: 'TR-1016', driver: 'Nick Detwiler', total_hours: 1.25, customer: 'Kinkead' },
    ];
    const { sql, store } = makeSql({
      appData: { [TRUCK_KEY]: rows.slice(), [IC_KEY]: [icEntry(ghost), icEntry(live), icEntry('TR-1016')] },
      entries: [tsEntry()],
      tde: [ghost, live, 'TR-1016'],
      icMirror: [['ic-' + ghost, ghost], ['ic-' + live, live], ['ic-TR-1016', 'TR-1016']],
    });

    const { entries, removed } = await sweepInjectedTruckRows(sql, CO, rows);
    assert('the duplicate is swept', removed.length === 1 && removed[0] === ghost);
    assert('the corrected row stays', entries.some(r => r.id === live));
    assert('the office\'s own row stays', entries.some(r => r.id === 'TR-1016'));
    assert('the caller gets the cleaned list back', entries.length === 2);
    assert('and the blob is cleaned too',
      !store.appData.get(TRUCK_KEY).some(r => r.id === ghost));
    assert('mirror row dropped', !store.tde.has(ghost));
    assert('double-billing stopped',
      !store.appData.get(IC_KEY).some(e => e.source_id === ghost));
    assert('the live row still bills',
      store.appData.get(IC_KEY).some(e => e.source_id === live));
  }

  // hudockben's deleted test entry: the row outlived the entry entirely, and
  // payroll had nothing left to un-approve.
  {
    const orphan = 'tst-99-1754900000000';
    const rows = [{ id: orphan, driver: 'hudockben', total_hours: 8, haul_fee: 125, customer: 'Kinkead' }];
    const { sql, store } = makeSql({
      appData: { [TRUCK_KEY]: rows.slice(), [IC_KEY]: [icEntry(orphan)] },
      entries: [],                      // the entry was deleted in payroll
      tde: [orphan], icMirror: [['ic-' + orphan, orphan]],
    });
    const { entries, removed } = await sweepInjectedTruckRows(sql, CO, rows);
    assert('a row whose entry was deleted is swept', removed.length === 1 && entries.length === 0);
    assert('its billing entry goes too',
      (store.appData.get(IC_KEY) || []).length === 0);
  }

  // ── The dust hauls that were posted here before they stopped being ──────
  // Every dust customer haul used to post a Truck Tracking row beside its dust
  // billing row. A haul billed off Dust Control Tracking no longer does — that
  // grid records, prices and invoices it end to end — but the rows already
  // posted are stranded: the tab refuses to delete payroll's rows, and payroll
  // cannot take one back without un-approving a timesheet the office has been
  // paid for. The sweep is the only thing that will ever retire them.
  console.log('\n[a UB haul\'s Truck Tracking row is retired on read]');
  {
    const ub  = truckingRowId(70);          // leg 1, billed off Dust Control Tracking
    const mat = truckingRowId(71);          // leg 1, billed off Other Billing
    const rows = [
      { id: ub,  driver: 'Mike Barr', total_hours: 10, haul_fee: 121, customer: 'Northeast Natural Energy' },
      { id: mat, driver: 'Mike Barr', total_hours: 8,  haul_fee: 121, customer: 'CNX' },
      { id: 'TR-1016', driver: 'Nick Detwiler', total_hours: 1.25, customer: 'Kinkead' },
    ];
    const dustEntry = over => tsEntry({ division: 'dust', job_id: 'Antero', job_label: 'Antero', ...over });
    const { sql, store } = makeSql({
      appData: { [TRUCK_KEY]: rows.slice(), [IC_KEY]: [icEntry(ub), icEntry(mat)] },
      entries: [dustEntry({ id: 70 }), dustEntry({ id: 71 })],
      tde: [ub, mat, 'TR-1016'],
      icMirror: [['ic-' + ub, ub], ['ic-' + mat, mat]],
      // Only entry 70's haul has a Dust Control Tracking row. Entry 71's billed
      // off Other Billing, so it has none — and keeps its Truck Tracking row.
      dustRows: ['tsd-70-row'],
    });

    const { entries, removed } = await sweepInjectedTruckRows(sql, CO, rows);
    assert('the UB haul\'s row is swept', removed.length === 1 && removed[0] === ub);
    assert('the material haul\'s row stays', entries.some(r => r.id === mat));
    assert('and the office\'s own row is never touched', entries.some(r => r.id === 'TR-1016'));
    assert('the blob is cleaned on the same read', !store.appData.get(TRUCK_KEY).some(r => r.id === ub));
    assert('the mirror row goes with it', !store.tde.has(ub));
    // Without this the trucking page reads the billing entry as a row it lost
    // and rebuilds exactly what was just swept.
    assert('and so does its Intercompany billing',
      !store.appData.get(IC_KEY).some(e => e.source_id === ub));
    assert('the material haul still bills',
      store.appData.get(IC_KEY).some(e => e.source_id === mat));
  }
  {
    // A day split across both grids: leg 1 UB, leg 2 material. Only leg 1 goes,
    // and leg 2 keeps the id — and the Intercompany history — it was posted
    // under, rather than being renumbered into leg 1's place.
    const legOne = truckingRowId(72, 1);
    const legTwo = truckingRowId(72, 2);
    const rows = [{ id: legOne, customer: 'Antero' }, { id: legTwo, customer: 'CNX' }];
    const { sql, store } = makeSql({
      appData: { [TRUCK_KEY]: rows.slice(), [IC_KEY]: [icEntry(legOne), icEntry(legTwo)] },
      entries: [tsEntry({ id: 72, division: 'dust', job_id: 'Antero' })],
      tde: [legOne, legTwo],
      icMirror: [['ic-' + legOne, legOne], ['ic-' + legTwo, legTwo]],
      dustRows: ['tsd-72-row'],           // leg 1 only
    });
    const { entries, removed } = await sweepInjectedTruckRows(sql, CO, rows);
    assert('only the UB leg is swept', removed.length === 1 && removed[0] === legOne);
    assert('the material leg keeps its own id', entries.length === 1 && entries[0].id === legTwo);
    assert('and its billing entry with it',
      store.appData.get(IC_KEY).some(e => e.source_id === legTwo));
  }
  {
    // Nothing on the dust grid says anything about this haul — a row mid-
    // approval, or one whose dust row never landed. Absence is not evidence:
    // deleting a haul's billing on a guess is the one thing worse than leaving
    // a stale row up, so the row stays and the day is somebody's to look at.
    const row = truckingRowId(73);
    const rows = [{ id: row, customer: 'Antero' }];
    const { sql } = makeSql({
      appData: { [TRUCK_KEY]: rows.slice() },
      entries: [tsEntry({ id: 73, division: 'dust', job_id: 'Antero' })],
      tde: [row], dustRows: [],
    });
    const { removed } = await sweepInjectedTruckRows(sql, CO, rows);
    assert('a dust haul with no row on either grid is left alone', removed.length === 0);
  }
  {
    // A trucking entry has no dust side at all, so the lookup is never made —
    // its rows can never be retired by this rule.
    const row = truckingRowId(42);
    const rows = [{ id: row, customer: 'Antero' }];
    const { sql, store } = makeSql({
      appData: { [TRUCK_KEY]: rows.slice() }, entries: [tsEntry()], tde: [row],
      dustRows: ['tsd-42-row'],           // would match on id, but 42 is trucking
    });
    const { removed } = await sweepInjectedTruckRows(sql, CO, rows);
    assert('a trucking row is never swept for this', removed.length === 0);
    assert('and the dust grid is not even asked about',
      !store.queries.some(q => q.startsWith('SELECT id FROM dust_control_entries')));
  }

  // Every reader of findStaleTruckRows has to ask the same question, or they
  // disagree about which rows exist: the tab retires a legacy UB row on read
  // while the executive report goes on counting it as trucking revenue, and the
  // repair tool reports "nothing to do" over rows the next tab load removes.
  {
    const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
    for (const [file, label] of [
      ['api/executive/report.js',              'the executive report'],
      ['scripts/repair-orphaned-truck-rows.js', 'the repair tool'],
      ['api/lib/truck-injected.js',            'the read-time sweep'],
    ]) {
      const src = read(file);
      assert(`${label} asks the dust grid which hauls it bills`,
        src.includes('dustBilledLegs') && /findStaleTruckRows\([^)]*ubLegs\)/.test(src));
    }
  }

  // ── Costs nothing in the steady state ───────────────────────────────────
  console.log('\n[the sweep stays out of the way]');
  {
    const rows = [{ id: 'TR-1016' }, { id: 'uuid-2' }];
    const { sql, store } = makeSql({ appData: { [TRUCK_KEY]: rows.slice() } });
    const { entries, removed } = await sweepInjectedTruckRows(sql, CO, rows);
    assert('no injected rows → no lookup at all', store.queries.length === 0);
    assert('and the list is handed straight back', entries === rows && removed.length === 0);
  }
  {
    const live = truckingRowId(42);
    const rows = [{ id: live }, { id: 'TR-1016' }];
    const { sql, store } = makeSql({
      appData: { [TRUCK_KEY]: rows.slice() }, entries: [tsEntry()], tde: [live],
    });
    const { removed } = await sweepInjectedTruckRows(sql, CO, rows);
    assert('nothing stale → nothing removed', removed.length === 0);
    assert('and nothing written', store.queries.filter(q => !q.startsWith('SELECT')).length === 0,
      store.queries.filter(q => !q.startsWith('SELECT')).join(' | '));
  }
  {
    const { sql } = makeSql({ appData: {} });
    const { entries, removed } = await sweepInjectedTruckRows(sql, CO, null);
    assert('a null list is handled', Array.isArray(entries) && removed.length === 0);
  }

  // ── removeIcBillingEntries in isolation ─────────────────────────────────
  console.log('\n[billing removal is targeted]');
  {
    const { sql, store } = makeSql({
      appData: { [IC_KEY]: [
        icEntry('tst-42-row'),
        { id: 'ic-d1', source: 'dust', source_id: 'tst-42-row' },   // same id, other division
        icEntry('manual-1'),
      ] },
    });
    const n = await removeIcBillingEntries(sql, CO, IC_SOURCE_TRUCKING, ['tst-42-row']);
    const left = store.appData.get(IC_KEY);
    assert('reports what it removed', n === 1, `got ${n}`);
    assert('only the trucking entry went', left.length === 2);
    assert('a same-id dust entry is untouched', left.some(e => e.source === 'dust'));
    assert('other trucking rows untouched', left.some(e => e.source_id === 'manual-1'));
  }
  {
    const { sql, store } = makeSql({ appData: { [IC_KEY]: [icEntry('tst-42-row')] } });
    assert('empty id list is a no-op', (await removeIcBillingEntries(sql, CO, IC_SOURCE_TRUCKING, [])) === 0);
    assert('and issues no query', store.queries.length === 0);
  }

  // ── trucking.html must not undo any of this ─────────────────────────────
  // The page is static and cannot require the module, so the guards are held
  // in place by reading the shipped source.
  console.log('\n[trucking.html holds its end]');
  {
    const PAGE = fs.readFileSync(path.resolve(__dirname, '../trucking.html'), 'utf8');

    assert('the page knows which rows are payroll\'s',
      /function isPayrollRowId\(id\)\s*\{[^}]*startsWith\('tst-'\)/.test(PAGE));

    const rec = /function _recoverEntriesFromIcBilling\(\)\s*\{([\s\S]*?)\n    \}/.exec(PAGE);
    assert('_recoverEntriesFromIcBilling is still findable', !!rec);
    assert('and it refuses to rebuild a payroll row',
      !!rec && /if \(isPayrollRowId\(ic\.source_id\)\) return;/.test(rec[1]));

    const rec2 = /function _reconcileTruckingBilling\(entries, coByName\)\s*\{([\s\S]*?)\n      return \{ changed, sentNow, clearNow \};/.exec(PAGE);
    assert('_reconcileTruckingBilling is still findable', !!rec2);
    assert('it prunes billing entries whose payroll row is gone',
      !!rec2 && /isPayrollRowId\(sourceId\)/.test(rec2[1]) && /entries\.splice\(i, 1\)/.test(rec2[1]));
    assert('and only once the entries have actually loaded',
      !!rec2 && /if \(_divEntriesLoaded\)/.test(rec2[1]));
    assert('the flag starts false', /let _divEntriesLoaded = false;/.test(PAGE));
    // Set only where the rows are actually taken on board. The poll cycle can
    // bail out after a good fetch (the user is mid-edit), and a flag set on the
    // fetch alone would tell the reconciler every payroll row had gone.
    assert('the load path gates it on a real array',
      /_divEntriesLoaded = Array\.isArray\(divData\.entries\);/.test(PAGE));
    const pollBlock = /async function pollTruckDivision\(\)\s*\{([\s\S]*?)\n      \}/.exec(PAGE);
    assert('pollTruckDivision is still findable', !!pollBlock);
    assert('the poll sets it next to the assignment',
      !!pollBlock && /_divEntriesLoaded = true;\s*\n\s*divEntries = inEntries;/.test(pollBlock[1]));
    assert('and never earlier in the cycle',
      !!pollBlock && pollBlock[1].indexOf('_divEntriesLoaded') > pollBlock[1].indexOf('if (_isEditing()) return;'));

    assert('the tab still refuses to delete a payroll row',
      /function deleteRow\(id\)[\s\S]{0,400}?startsWith\('tst-'\)\) return;/.test(PAGE));
  }

  // ── the server sweeps on read ───────────────────────────────────────────
  console.log('\n[api/truck-division wires the sweep in]');
  {
    const SRC = fs.readFileSync(path.resolve(__dirname, '../api/truck-division.js'), 'utf8');
    assert('the GET path calls it',
      (SRC.match(/await sweepInjectedTruckRows\(sql, companyCode/g) || []).length === 2,
      'expected both the blob and the normalized-fallback path');
    assert('a failed sweep never costs the tab its data',
      /catch \(err\) \{\s*console\.error\('\[truck-division\] injected-row sweep failed/.test(SRC));
    assert('the swept list is what gets returned',
      /return res\.json\(\{ entries, lists: blobLists \}\)/.test(SRC));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
