#!/usr/bin/env node
'use strict';
/**
 * Dust "EES Other": timesheet → tab injection.
 *
 * Run: node scripts/test-ees-other-injection.js
 *
 * A dust timesheet entry only becomes an EES Other row when the job is one of
 * the two standing EES activities minted by api/timesheet-jobs.js
 * ('ees:preloading' / 'ees:washing'). Ordinary dust entries — the customer
 * companies — must keep their existing behaviour of flipping status and
 * injecting nowhere, which is what stops this from quietly posting every dust
 * timesheet into the tab.
 *
 * The row is a straight copy of the approved entry: the office types the EES
 * detail fields on the timesheet, not in the tab, so a re-approve must not
 * invent or drop values.
 */

const path   = require('path');
const Module = require('module');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// app_data stand-in: key → value.
const store = new Map();

const orig = Module._load;
Module._load = function (req, parent) {
  if (req === '@neondatabase/serverless') {
    return { neon: () => (strings, ...vals) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      if (/^SELECT value FROM app_data/.test(q)) {
        const k = vals[0];
        return Promise.resolve(store.has(k) ? [{ value: store.get(k) }] : []);
      }
      if (/^INSERT INTO app_data/.test(q)) {
        store.set(vals[0], JSON.parse(vals[1]));
        return Promise.resolve([]);
      }
      // Mirrors clearIcSuppression's single UPDATE: rebuild the array without
      // the matching (source, source_id), and touch nothing when none matches.
      // Params in template order: source, source_id, key, source, source_id.
      if (/^UPDATE app_data/.test(q) && /jsonb_array_elements/.test(q)) {
        const [source, sourceId, key] = vals;
        const cur = store.get(key);
        if (!Array.isArray(cur)) return Promise.resolve([]);
        const next = cur.filter(t => !(t && t.source === source && t.source_id === sourceId));
        if (next.length === cur.length) return Promise.resolve([]);
        store.set(key, next);
        return Promise.resolve([{ cleared: 1 }]);
      }
      return Promise.resolve([]);
    }};
  }
  if (req === './lib/auth' || req === '../lib/auth') {
    return {
      requireAuth: () => ({ companyCode: 'ACME', isPlatformAdmin: true }),
      hasDivisionAccess: () => true, hasAnyDivisionAccess: () => true,
      divisionForKey: () => null, isSharedKey: () => true,
      isCrossDivisionKey: () => false, CROSS_DIVISION_CONTRIBUTORS: [],
    };
  }
  if (req === './lib/sync-normalized' || req === '../lib/sync-normalized') {
    return { syncForKey: async () => {} };
  }
  return orig.apply(this, arguments);
};

const TS = require(path.resolve(__dirname, '../api/timesheet-entries.js'));
const {
  insertEesOtherRow, insertEesOtherRows, removeEesOtherRows,
  eesOtherRowIdPrefix, eesOtherRowId, eesSplitForEntry, couldHaveEesOtherRows,
} = TS._test;
const sql = require('@neondatabase/serverless').neon();
const BLOB = 'ACME:dust_ees_other_rows';
const rows = () => store.get(BLOB) || [];

function entry(over = {}) {
  return {
    id: 501,
    username: 'Barr, Michael',
    entry_type: 'daily',
    division: 'dust',
    job_id: 'ees:preloading',
    job_label: 'EES - Pre Loading',
    work_date: '2026-07-01',
    start_time: '13:00',
    end_time: '13:30',
    computed_hours: 0.5,
    notes: 'PRE LOADED TRUCK',
    ees_unit: '',
    ees_customer: 'Environmental Energy Services',
    ees_location: 'EES',
    ees_name: 'EES',
    ees_job_number: '',
    ees_billing: 'Non-Billable',
    ...over,
  };
}

(async () => {
  console.log('\n[the row is a copy of the approved entry]');
  {
    store.clear();
    const row = await insertEesOtherRow(sql, 'ACME', entry());
    assert('one row written', rows().length === 1);
    assert('tagged with the entry id', String(row.id).startsWith(eesOtherRowIdPrefix(501)));
    assert('date ← work_date', row.actual_date === '2026-07-01');
    assert('start ← start_time', row.actual_start === '13:00');
    assert('end ← end_time', row.actual_end === '13:30');
    assert('hours ← computed_hours', row.actual_hours === 0.5);
    assert('driver ← employee', row.driver === 'Barr, Michael');
    assert('customer ← the EES field', row.customer === 'Environmental Energy Services');
    assert('location ← the EES field', row.location === 'EES');
    assert('name ← the EES field', row.name === 'EES');
    assert('billing ← the EES field', row.billing === 'Non-Billable');
    assert('comments ← notes', row.comments === 'PRE LOADED TRUCK');
    assert('activity recorded', row.activity === 'Pre Loading');
    assert('rate starts empty', row.rate === '');
  }

  console.log('\n[washing is the other standing activity]');
  {
    store.clear();
    const row = await insertEesOtherRow(sql, 'ACME', entry({
      job_id: 'ees:washing', job_label: 'EES - Washing', notes: 'WASHED AND PRE LOADED TRUCK',
    }));
    assert('activity recorded', row.activity === 'Washing');
    assert('comments carried', row.comments === 'WASHED AND PRE LOADED TRUCK');
  }

  console.log('\n[customer falls back to the job label when unset]');
  {
    store.clear();
    const row = await insertEesOtherRow(sql, 'ACME', entry({ ees_customer: '' }));
    assert('falls back to job_label', row.customer === 'EES - Pre Loading');
  }

  console.log('\n[re-approving replaces, never duplicates]');
  {
    store.clear();
    await insertEesOtherRow(sql, 'ACME', entry());
    const first = rows()[0];
    // Payroll corrects the entry and re-approves.
    const row = await insertEesOtherRow(sql, 'ACME', entry({ computed_hours: 2, ees_unit: 'T-12' }));
    assert('still exactly one row', rows().length === 1);
    // The id must NOT change. Intercompany keys its billing entry off it, so a
    // fresh id per injection would orphan that entry — dropped and replaced,
    // losing its sent_at and any Intercompany-side invoice/payment dates.
    assert('row id is stable across re-approval', row.id === first.id, `${first.id} → ${row.id}`);
    assert('corrected hours applied', rows()[0].actual_hours === 2);
    assert('newly typed unit applied', rows()[0].unit === 'T-12');
  }

  console.log('\n[a rate typed in the tab survives re-approval]');
  {
    // The rate is the one field the tab owns — the timesheet has nowhere to put
    // it — so a re-approve must not wipe it while refreshing everything else.
    store.clear();
    await insertEesOtherRow(sql, 'ACME', entry({ ees_billing: 'Billable' }));
    const cur = rows();
    cur[0].rate = '95';
    store.set(BLOB, cur);

    await insertEesOtherRow(sql, 'ACME', entry({ ees_billing: 'Billable', computed_hours: 4 }));
    assert('rate preserved', rows()[0].rate === '95');
    assert('timesheet fields still refreshed', rows()[0].actual_hours === 4);
  }

  console.log('\n[other rows in the blob are never touched]');
  {
    store.clear();
    await insertEesOtherRow(sql, 'ACME', entry({ id: 501 }));
    await insertEesOtherRow(sql, 'ACME', entry({ id: 502, work_date: '2026-07-17' }));
    assert('two entries, two rows', rows().length === 2);
    await insertEesOtherRow(sql, 'ACME', entry({ id: 501, computed_hours: 3 }));
    assert('still two rows', rows().length === 2);
    const other = rows().find(r => String(r.id).startsWith(eesOtherRowIdPrefix(502)));
    assert('the other entry\'s row is intact', other && other.actual_date === '2026-07-17');
  }

  console.log('\n[un-approve / delete removes only its own row]');
  {
    store.clear();
    await insertEesOtherRow(sql, 'ACME', entry({ id: 501 }));
    await insertEesOtherRow(sql, 'ACME', entry({ id: 502 }));
    const n = await removeEesOtherRows(sql, 'ACME', { id: 501 });
    assert('reports one removed', n === 1);
    assert('one row left', rows().length === 1);
    assert('the surviving row is the other entry\'s',
      String(rows()[0].id).startsWith(eesOtherRowIdPrefix(502)));
    assert('removing again is a no-op', (await removeEesOtherRows(sql, 'ACME', { id: 501 })) === 0);
  }

  console.log('\n[entry ids that share a prefix stay separate]');
  {
    // With a stable id the trailing dash is what keeps entry 50 from matching
    // entry 501's row — "tse-501-row".startsWith("tse-50-") must be false.
    store.clear();
    await insertEesOtherRow(sql, 'ACME', entry({ id: 50 }));
    await insertEesOtherRow(sql, 'ACME', entry({ id: 501 }));
    assert('two distinct rows', rows().length === 2);
    const n = await removeEesOtherRows(sql, 'ACME', { id: 50 });
    assert('removing 50 removes exactly one', n === 1);
    assert('501 survived', rows().length === 1 && String(rows()[0].id).startsWith(eesOtherRowIdPrefix(501)));
  }

  console.log('\n[an approved entry cannot be edited out from under the tab]');
  {
    const { eesOtherHasInjectedRow } = TS._test;
    store.clear();
    assert('no row → nothing to guard', (await eesOtherHasInjectedRow(sql, 'ACME', { id: 501 })) === false);
    await insertEesOtherRow(sql, 'ACME', entry({ id: 501 }));
    assert('injected row is detected', (await eesOtherHasInjectedRow(sql, 'ACME', { id: 501 })) === true);
    assert('a different entry is not', (await eesOtherHasInjectedRow(sql, 'ACME', { id: 502 })) === false);
    await removeEesOtherRows(sql, 'ACME', { id: 501 });
    assert('un-approving clears the guard', (await eesOtherHasInjectedRow(sql, 'ACME', { id: 501 })) === false);

    // …and the PUT handler must actually consult it, under the same gate.
    const SRC = require('fs').readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');
    const guard = SRC.slice(SRC.indexOf('injected cost rows, refuse'), SRC.indexOf('injected_row_count'));
    assert('the edit guard counts EES rows', /eesOtherHasInjectedRow/.test(guard));
    assert('and gates on any dust entry, not just an EES-activity one',
      /couldHaveEesOtherRows\(existing\)/.test(guard));
  }

  console.log('\n[approving puts back work that Intercompany had removed]');
  {
    const { clearIcSuppression } = TS._test;
    const REMOVED = 'ACME:fct_intercompany_removed_entries';
    const suppressions = () => store.get(REMOVED) || [];

    store.clear();
    const row = await insertEesOtherRow(sql, 'ACME', entry({ id: 501 }));

    // Someone clears it in Intercompany, then payroll re-approves the entry.
    store.set(REMOVED, [
      { source: 'dust-ees-other', source_id: row.id },
      { source: 'dust-ees-other', source_id: 'tse-999-row' },   // another entry
      { source: 'dust-other-billing', source_id: row.id },      // same id, other tab
      { source: 'trucking', source_id: 'tr-1' },
    ]);
    await insertEesOtherRow(sql, 'ACME', entry({ id: 501, computed_hours: 3 }));

    const left = suppressions();
    assert('this row is no longer suppressed',
      !left.some(t => t.source === 'dust-ees-other' && t.source_id === row.id));
    assert('another entry stays suppressed',
      left.some(t => t.source === 'dust-ees-other' && t.source_id === 'tse-999-row'));
    assert('the same id under another source is untouched',
      left.some(t => t.source === 'dust-other-billing' && t.source_id === row.id));
    assert('an unrelated division is untouched',
      left.some(t => t.source === 'trucking' && t.source_id === 'tr-1'));
    assert('nothing else was dropped', left.length === 3, `${left.length} left`);
  }

  console.log('\n[clearing is a no-op when there is nothing to clear]');
  {
    const { clearIcSuppression } = TS._test;
    const REMOVED = 'ACME:fct_intercompany_removed_entries';
    store.clear();
    assert('no list at all', (await clearIcSuppression(sql, 'ACME', 'dust-ees-other', 'x')) === 0);
    store.set(REMOVED, [{ source: 'trucking', source_id: 'tr-1' }]);
    assert('no matching row', (await clearIcSuppression(sql, 'ACME', 'dust-ees-other', 'x')) === 0);
    assert('list untouched', (store.get(REMOVED) || []).length === 1);
    assert('reports what it removed',
      (await clearIcSuppression(sql, 'ACME', 'trucking', 'tr-1')) === 1);
    assert('and removed it', (store.get(REMOVED) || []).length === 0);
  }

  console.log('\n[clearing a removal cannot lose a concurrent one]');
  {
    // Read-the-list-then-write-it-back would race the intercompany page
    // recording a removal — it reads [A], the page writes [A,B], it writes []
    // and B is silently gone, so that row quietly comes back. One statement
    // has no such window.
    const SRC = require('fs').readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');
    const fn = SRC.slice(SRC.indexOf('async function clearIcSuppression'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert('does not read the list separately', !/readBlobArray/.test(body));
    assert('does not write the list back', !/writeBlobArray/.test(body));
    assert('is a single statement', (body.match(/await sql`/g) || []).length === 1,
      `${(body.match(/await sql`/g) || []).length} statements`);
    assert('rebuilds the array in SQL', /jsonb_agg/.test(body));
    assert('skips the write when nothing matches', /EXISTS/.test(body));
  }

  console.log('\n[un-approving does not clear a removal]');
  {
    // Only approving is the deliberate "this counts" signal. Un-approve just
    // takes the row away; the removal stays recorded for if it comes back.
    const REMOVED = 'ACME:fct_intercompany_removed_entries';
    store.clear();
    const row = await insertEesOtherRow(sql, 'ACME', entry({ id: 501 }));
    store.set(REMOVED, [{ source: 'dust-ees-other', source_id: row.id }]);
    await removeEesOtherRows(sql, 'ACME', { id: 501 });
    assert('removal still recorded', (store.get(REMOVED) || []).length === 1);
  }

  // ── The routing gate, read out of the shipped source ────────────────────
  // Only a dust entry on a standing EES job injects. This is the whole point
  // of the feature: an ordinary dust customer entry must still inject nowhere.
  console.log('\n[only EES jobs route into the tab]');
  {
    // Canonical list lives in lib/truck-injected.js — the dust EES gate and the
    // Truck Tracking gate are two halves of one routing decision, so they read
    // the same constant rather than each keeping a copy.
    const SRC  = require('fs').readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');
    const GATE = require('fs').readFileSync(path.resolve(__dirname, '../api/lib/truck-injected.js'), 'utf8');
    const m = /const EES_JOB_IDS = (\[[^\]]*\])/.exec(GATE);
    assert('EES_JOB_IDS declared', !!m);
    const ids = m ? JSON.parse(m[1].replace(/'/g, '"')) : [];
    assert('covers pre loading and washing',
      ids.includes('ees:preloading') && ids.includes('ees:washing') && ids.length === 2, JSON.stringify(ids));

    // timesheet.html keeps its own copy — it decides whether to SHOW the EES
    // fields at all. The two lists have to name the same jobs: drift one way
    // and the page collects EES detail the server will discard, drift the
    // other and the server injects a row with every EES column blank. The
    // page is static and cannot require the module, so this is the only thing
    // holding them together.
    const PAGE = require('fs').readFileSync(path.resolve(__dirname, '../timesheet.html'), 'utf8');
    const pm = /const EES_JOB_IDS = (\[[^\]]*\])/.exec(PAGE);
    assert('timesheet.html declares EES_JOB_IDS too', !!pm);
    const pageIds = pm ? JSON.parse(pm[1].replace(/'/g, '"')) : [];
    assert('and names exactly the same jobs as the server',
      JSON.stringify(pageIds) === JSON.stringify(ids),
      `page ${JSON.stringify(pageIds)} vs server ${JSON.stringify(ids)}`);

    const isEesJob = id => ids.includes(String(id || ''));
    const needsEesOther = e =>
      e.entry_type === 'daily' && e.division === 'dust' && isEesJob(e.job_id);

    assert('dust + pre loading  → injects', needsEesOther(entry()));
    assert('dust + washing      → injects', needsEesOther(entry({ job_id: 'ees:washing' })));
    assert('dust + a customer   → does NOT inject', !needsEesOther(entry({ job_id: 'co-42' })));
    assert('dust + no job       → does NOT inject', !needsEesOther(entry({ job_id: '' })));
    assert('trucking + EES id   → does NOT inject', !needsEesOther(entry({ division: 'trucking' })));
    assert('turf + EES id       → does NOT inject', !needsEesOther(entry({ division: 'turf' })));
    assert('time off            → does NOT inject', !needsEesOther(entry({ entry_type: 'time_off' })));

    // The TEARDOWN gate is wider than either injection gate, and deliberately.
    // Two different things put rows in this tab: the single row an entry on a
    // standing EES activity posts, and the per-leg rows a dust CUSTOMER haul
    // posts for each haul billed off "Other Billing - Non Billable". Asking
    // isEesJob would find only the first, so a customer haul's rows would
    // outlive the entry that made them in a tab that deletes nothing.
    assert('the teardown gate covers any dust entry',
      /function couldHaveEesOtherRows\(entry\) \{\s*\n\s*return !!entry && entry\.division === 'dust';/.test(SRC));
    // And it must be identical everywhere it appears, or a row outlives the
    // entry that made it (approve injects, un-approve/delete miss it).
    const gates = SRC.match(/couldHaveEesOtherRows\(existing\)/g) || [];
    assert('un-approve, delete and the edit guard share the gate', gates.length === 3, `found ${gates.length}`);
    assert('and none of the three still asks the old narrower one',
      !/existing\.division === 'dust' && isEesJob\(existing\.job_id\)/.test(SRC));
  }

  // ── A customer haul billed off "Other Billing - Non Billable" ───────────
  // Not every haul is invoiced. A driver sent out to move a tank or wait on a
  // frac is real hours against a real customer that the dust office tracks and
  // bills to nobody — and until this it had nowhere to go but one of the two
  // billing grids, where it was either invoiced by accident or left off.
  console.log('\n[a customer haul that bills nobody]');
  {
    const haul = over => entry({
      id: 601, division: 'dust', job_id: 'co-cnx', job_label: 'CNX',
      start_time: '05:00', end_time: '15:00', computed_hours: 9.5,
      truck_unit: '4000 SPRAY', notes: 'moved the tank',
      // A customer job carries none of these — normalizeEntryBody forces them
      // null — which is exactly why the row is built from the leg instead.
      ees_unit: null, ees_customer: null, ees_location: null,
      ees_name: null, ees_job_number: null, ees_billing: null,
      ...over,
    });
    const leg = over => ({
      dest: 'ees', company: 'Northeast Natural Energy',
      location: 'Great Lakes Lease', start_time: '05:00', end_time: '08:00', ...over,
    });

    store.clear();
    const [row] = await insertEesOtherRows(sql, 'ACME', haul(), [leg()]);
    assert('one row written', rows().length === 1);
    assert('under leg 1\'s historic id', row.id === eesOtherRowId(601, 1));
    assert('customer ← the leg, not the timesheet', row.customer === 'Northeast Natural Energy');
    assert('location ← the leg', row.location === 'Great Lakes Lease');
    assert('the haul\'s own window', row.actual_start === '05:00' && row.actual_end === '08:00');
    // The leg's window, not the entry's lunch-deducted computed_hours: a split
    // day's legs have to sum to the day they came out of.
    assert('hours ← the leg\'s window', row.actual_hours === 3, String(row.actual_hours));
    assert('unit falls back to the timesheet\'s', row.unit === '4000 SPRAY');
    assert('and the leg\'s own unit wins when given',
      (await insertEesOtherRows(sql, 'ACME', haul(), [leg({ vehicle1: '7549' })]))[0].unit === '7549');
    assert('comments ← notes', row.comments === 'moved the tank');
    // The whole point of this destination.
    assert('always Non-Billable', row.billing === 'Non-Billable');
    assert('no rate', row.rate === '');
    // Neither of the two standing activities, so it claims neither.
    assert('no EES activity claimed', row.activity === '');
    // Read-only in the tab and unnameable from a customer haul, so blank rather
    // than guessed.
    assert('name and job number left blank', row.name === '' && row.job_number === '');
  }
  {
    // A day split three ways, only the middle haul non-billable. The id is the
    // haul's place in the DAY — Intercompany keys off it — so the row lands at
    // leg 2 rather than being packed to the front.
    store.clear();
    const legs = [
      { dest: 'dust', company: 'CNX' },
      { dest: 'ees',  company: 'Antero', location: 'Bear Hollow', start_time: '08:00', end_time: '11:00' },
      { dest: 'ob',   company: 'Range' },
    ];
    const day = entry({ id: 602, job_id: 'co-cnx', job_label: 'CNX' });
    const written = await insertEesOtherRows(sql, 'ACME', day, legs);
    assert('only the non-billable haul lands here', written.length === 1);
    assert('under the id of the leg it actually is', written[0].id === eesOtherRowId(602, 2));
    assert('billing that haul\'s own customer', written[0].customer === 'Antero');

    // Re-pointing it at a grid that bills takes the row back. Nothing else ever
    // would — the tab creates and deletes nothing.
    const after = await insertEesOtherRows(sql, 'ACME', day,
      legs.map(l => (l.dest === 'ees' ? { ...l, dest: 'ob' } : l)));
    assert('re-pointing it off takes the row back', after.length === 0 && rows().length === 0);
  }
  {
    // An ordinary billed day must not rewrite the blob at all — that would race
    // the dust tab's own save for no reason.
    store.clear();
    store.set(BLOB, [{ id: 'manual-1', customer: 'Someone' }]);
    const untouched = await insertEesOtherRows(sql, 'ACME',
      entry({ id: 603, job_id: 'co-cnx' }), [{ dest: 'dust' }, { dest: 'ob' }]);
    assert('a day with no non-billable haul writes nothing here', untouched.length === 0);
    assert('and the tab\'s own rows are untouched',
      rows().length === 1 && rows()[0].id === 'manual-1');
  }
  {
    // The modal has to reopen the day as the day it was, by LEG.
    store.clear();
    const day = entry({ id: 604, job_id: 'co-cnx', job_label: 'CNX' });
    await insertEesOtherRows(sql, 'ACME', day, [
      { dest: 'dust' },
      { dest: 'ees', company: 'Antero', location: 'Bear Hollow', start_time: '08:00', end_time: '11:00', vehicle1: '4000' },
    ]);
    const { rows: back } = await eesSplitForEntry(sql, 'ACME', day);
    assert('the pre-fill answers one haul', back.length === 1);
    assert('carrying the leg of the day it was', back[0].leg === 2);
    assert('and its destination', back[0].dest === 'ees');
    assert('with the boxes the modal asks for',
      back[0].company === 'Antero' && back[0].location === 'Bear Hollow'
      && back[0].vehicle1 === '4000' && back[0].start_time === '08:00');
  }
  {
    // The teardown gate has to cover a customer haul, or its rows outlive the
    // entry in a tab that cannot delete them.
    assert('the teardown gate covers a customer haul',
      couldHaveEesOtherRows({ division: 'dust', job_id: 'co-cnx' }) === true);
    assert('and a standing EES activity',
      couldHaveEesOtherRows({ division: 'dust', job_id: 'ees:washing' }) === true);
    assert('but no other division',
      couldHaveEesOtherRows({ division: 'trucking', job_id: 'co-cnx' }) === false);
    assert('and not a null entry', couldHaveEesOtherRows(null) === false);

    store.clear();
    const day = entry({ id: 605, job_id: 'co-cnx', job_label: 'CNX' });
    await insertEesOtherRows(sql, 'ACME', day, [{ dest: 'ees', company: 'CNX' }]);
    assert('un-approve finds the customer haul\'s row',
      (await removeEesOtherRows(sql, 'ACME', day)) === 1 && rows().length === 0);
  }

  console.log('\n[the two jobs are offered under dust, and only dust]');
  {
    const JOBS = require('fs').readFileSync(path.resolve(__dirname, '../api/timesheet-jobs.js'), 'utf8');
    assert('pre loading is offered', /id: 'ees:preloading', label: 'EES - Pre Loading'/.test(JOBS));
    assert('washing is offered', /id: 'ees:washing',\s+label: 'EES - Washing'/.test(JOBS));
    const dustFn = JOBS.slice(JOBS.indexOf('async function dustJobs'), JOBS.indexOf('async function quarryJobs'));
    assert('dustJobs returns them alongside the customers', /return \[\.\.\.EES_JOBS/.test(dustFn));
    // No other division may hand them out — the list is referenced exactly
    // twice: where it's declared, and where dustJobs spreads it.
    const uses = (JOBS.match(/EES_JOBS/g) || []).length;
    assert('no other division offers them', uses === 2, `${uses} references`);
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
