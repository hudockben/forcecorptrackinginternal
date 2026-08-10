'use strict';

// Verifies the Dust "Other Billing" → Intercompany auto-sync reconciler.
//
// Other Billing used to reach Intercompany only via a per-row "⇄ Intercompany
// Billing" button: one-shot, so later edits never propagated, zeroed-out rows
// kept billing, and deleting a row orphaned its IC entry. It now mirrors the
// Dust Tracking model — reconcile on every save — so these tests pin the
// reconciler's contract:
//
//   • create once per row, then keep in sync while preserving sent_at
//   • never churn when nothing dust-owned changed (that would ping-pong
//     against Intercompany's dedup-and-persist on load)
//   • preserve Intercompany-owned fields (invoice_sent_date / payment_received_date)
//   • void on zero total, remove on explicit delete
//   • never create for an un-enrolled customer, never wipe an existing entry
//     when a customer is later un-enrolled
//   • never touch other divisions' entries, and never mass-delete
//
// The functions under test are extracted verbatim from dust.html so this tests
// shipped code rather than a copy that can drift.

const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}`); failed++; }
}

// ── Extract the real implementation out of dust.html ──────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '..', 'dust.html'), 'utf8');

function extractFn(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in dust.html`);
  // Keep the `async` keyword when there is one — slicing from `function`
  // would silently turn an async declaration into a sync one.
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const harness = new Function(`
  let obRows = [];
  const obDeletedIds = new Set();
  const user = { username: 'tester' };
  ${extractFn('round2')}
  ${extractFn('obCalc')}
  ${extractFn('_icObEntrySig')}
  ${extractFn('_reconcileObBilling')}
  return function run(rows, deleted, entries, coByName) {
    obRows = rows;
    obDeletedIds.clear();
    (deleted || []).forEach(id => obDeletedIds.add(id));
    const res = _reconcileObBilling(entries, coByName);
    res.remainingDeletes = [...obDeletedIds];
    return res;
  };
`)();

// ── Fixtures ──────────────────────────────────────────────────────────────
const ACME = { id: 'co-1', name: 'Acme Materials', divisions: ['dust', 'paving'] };
const CO = new Map([['acme materials', ACME]]);

function obRow(over = {}) {
  return {
    id: 'ob-1', date: '2026-07-14', inv_number: 'INV-900',
    driver: 'J. Smith', truck_number: 'T-12', trailer_number: 'TR-4',
    customer: 'Acme Materials', destination: 'Pit 3', state: 'PA',
    material: 'Calcium', gallons_bags: '100', mu: 'GAL', price_per_unit: '2.50',
    trucking_hrs: '4', trucking_rate: '95', comments: '',
    ...over,
  };
}

// A foreign entry that must survive every pass untouched.
const foreign = () => ({
  id: 'tr-entry', source: 'trucking', source_id: 'tr-row-1',
  company_name: 'Kovalchick', actual_date: '2026-07-01', total: 1200,
});

const obEntries = e => e.filter(x => x.source === 'dust-other-billing');

console.log('[create]');
{
  const entries = [foreign()];
  const res = harness([obRow()], [], entries, CO);
  const mine = obEntries(entries);
  assert('reports changed', res.changed === true);
  assert('one entry created', mine.length === 1);
  assert('keyed by source_id', mine[0].source_id === 'ob-1');
  assert('company resolved from IC list', mine[0].company_id === 'co-1' && mine[0].company_name === 'Acme Materials');
  // 100 × 2.50 = 250 material, 4 × 95 = 380 trucking, 630 total
  assert('material_total computed', mine[0].material_total === 250);
  assert('trucking_total computed', mine[0].trucking_total === 380);
  assert('total computed', mine[0].total === 630);
  assert('sent_at stamped', typeof mine[0].sent_at === 'string' && mine[0].sent_at.length > 0);
  assert('sent_at reported to UI', res.sentNow.length === 1 && res.sentNow[0].id === 'ob-1');
  assert('foreign entry untouched', entries.some(x => x.id === 'tr-entry' && x.total === 1200));
}

console.log('\n[idempotent — no churn on an unchanged row]');
{
  const entries = [foreign()];
  harness([obRow()], [], entries, CO);
  const before = JSON.stringify(entries);
  const res = harness([obRow()], [], entries, CO);
  assert('second pass reports no change', res.changed === false);
  assert('blob byte-identical', JSON.stringify(entries) === before);
  assert('still reports the row as sent', res.sentNow.length === 1);
}

console.log('\n[update — edits propagate, sent_at and IC-side fields survive]');
{
  const entries = [];
  harness([obRow()], [], entries, CO);
  const firstSentAt = entries[0].sent_at;
  // Intercompany records an invoice + payment against the entry.
  entries[0].invoice_sent_date     = '2026-07-20';
  entries[0].payment_received_date = '2026-08-01';

  const res = harness([obRow({ price_per_unit: '3.00', comments: 'reweighed' })], [], entries, CO);
  const mine = obEntries(entries);
  assert('reports changed', res.changed === true);
  assert('still exactly one entry', mine.length === 1);
  assert('new price mirrored', mine[0].price_per_unit === '3.00');
  assert('total recomputed (300 + 380)', mine[0].total === 680);
  assert('comment mirrored', mine[0].comments === 'reweighed');
  assert('original sent_at preserved', mine[0].sent_at === firstSentAt);
  assert('IC invoice date preserved', mine[0].invoice_sent_date === '2026-07-20');
  assert('IC payment date preserved', mine[0].payment_received_date === '2026-08-01');
}

console.log('\n[no ping-pong — IC-owned edits alone never trigger a write]');
{
  const entries = [];
  harness([obRow()], [], entries, CO);
  entries[0].invoice_sent_date     = '2026-07-20';
  entries[0].payment_received_date = '2026-08-01';
  const res = harness([obRow()], [], entries, CO);
  assert('reports no change', res.changed === false);
  assert('IC dates still intact', entries[0].payment_received_date === '2026-08-01');
}

console.log('\n[void — row edited down to a zero total]');
{
  const entries = [foreign()];
  harness([obRow()], [], entries, CO);
  const res = harness(
    [obRow({ gallons_bags: '', price_per_unit: '', trucking_hrs: '', trucking_rate: '' })],
    [], entries, CO);
  assert('reports changed', res.changed === true);
  assert('entry removed', obEntries(entries).length === 0);
  assert('UI told to clear the chip', res.clearNow.includes('ob-1'));
  assert('foreign entry survived the void', entries.length === 1 && entries[0].id === 'tr-entry');
}

console.log('\n[delete — explicit id queue removes the entry]');
{
  const entries = [foreign()];
  harness([obRow()], [], entries, CO);
  const res = harness([], ['ob-1'], entries, CO);   // row gone from obRows AND queued
  assert('reports changed', res.changed === true);
  assert('entry removed', obEntries(entries).length === 0);
  assert('delete acknowledged for dequeue', res.handledDeletes.includes('ob-1'));
  assert('foreign entry survived', entries.length === 1 && entries[0].id === 'tr-entry');
}

console.log('\n[stale delete — a queued id that is back in obRows is not a deletion]');
{
  // A poll racing the save (or another device re-adding the row) can put a
  // queued id back into obRows. Honouring the delete would drop the entry and
  // immediately recreate it below with a fresh sent_at — losing the original
  // timestamp and any Intercompany-side invoice/payment dates on it.
  const entries = [];
  harness([obRow()], [], entries, CO);
  const originalSentAt = entries[0].sent_at;
  entries[0].invoice_sent_date     = '2026-07-20';
  entries[0].payment_received_date = '2026-08-01';

  const res = harness([obRow()], ['ob-1'], entries, CO);   // queued, yet still present
  assert('entry kept', obEntries(entries).length === 1);
  assert('no needless write', res.changed === false);
  assert('original sent_at intact', entries[0].sent_at === originalSentAt);
  assert('IC invoice date intact', entries[0].invoice_sent_date === '2026-07-20');
  assert('IC payment date intact', entries[0].payment_received_date === '2026-08-01');
  assert('stale delete dequeued', res.handledDeletes.includes('ob-1') && res.remainingDeletes.includes('ob-1'));
}

console.log('\n[no mass-delete — a failed/empty OB load must not wipe IC]');
{
  const entries = [foreign()];
  harness([obRow()], [], entries, CO);
  const beforeCount = entries.length;
  // obLoad() failed: obRows is [] but nothing was explicitly deleted.
  const res = harness([], [], entries, CO);
  assert('reports no change', res.changed === false);
  assert('every entry still present', entries.length === beforeCount);
  assert('the OB entry specifically survived', obEntries(entries).length === 1);
}

console.log('\n[un-enrolled customer]');
{
  // Never create for a customer missing from the IC dust list.
  const fresh = [];
  const resA = harness([obRow({ customer: 'Not Enrolled Co' })], [], fresh, CO);
  assert('no entry created', fresh.length === 0 && resA.changed === false);

  // A customer un-enrolled AFTER the fact keeps its history + IC dates.
  const entries = [];
  harness([obRow()], [], entries, CO);
  entries[0].payment_received_date = '2026-08-01';
  const resB = harness([obRow()], [], entries, new Map());   // company list now empty
  assert('existing entry left untouched', obEntries(entries).length === 1);
  assert('no write triggered', resB.changed === false);
  assert('IC payment date intact', entries[0].payment_received_date === '2026-08-01');
}

console.log('\n[division gating — customer enrolled but not under dust]');
{
  const pavingOnly = new Map([['acme materials', { id: 'co-1', name: 'Acme Materials', divisions: ['paving'] }]]);
  // The caller builds coByName filtered to 'dust', so a paving-only company
  // never reaches the reconciler. Mirror that filter here to prove the gate.
  const gated = new Map();
  pavingOnly.forEach((c, k) => { if ((c.divisions || []).includes('dust')) gated.set(k, c); });
  const entries = [];
  const res = harness([obRow()], [], entries, gated);
  assert('no entry created', entries.length === 0 && res.changed === false);
}

console.log('\n[look-alike rows are two billable rows, not a duplicate]');
{
  const entries = [];
  const a = obRow({ id: 'ob-a' });
  const b = obRow({ id: 'ob-b' });   // identical values, different row id
  harness([a, b], [], entries, CO);
  const mine = obEntries(entries);
  assert('both entries created', mine.length === 2);
  assert('distinct source_ids', mine[0].source_id !== mine[1].source_id);

  // …and Intercompany's own dedup must keep both. Verbatim from
  // intercompany.html loadBillingEntries(): entries with a source_id that
  // aren't source==='dust' dedup by (source, source_id).
  const seenSourceIds = new Set(), seenContentKeys = new Set(), deduped = [];
  for (const e of entries) {
    if (e.source === 'dust' && e.source_id) {
      deduped.push(e);
    } else if (e.source_id) {
      const sk = `${e.source || ''}|${e.source_id}`;
      if (!seenSourceIds.has(sk)) { seenSourceIds.add(sk); deduped.push(e); }
    } else {
      const ck = `${e.actual_date}|${(e.company_name || '').toLowerCase()}|${e.actual_start || ''}|${(e.location || '').toLowerCase()}|${e.source || ''}`;
      if (!seenContentKeys.has(ck)) { seenContentKeys.add(ck); deduped.push(e); }
    }
  }
  assert('IC dedup keeps both (no collapse, no ping-pong)', deduped.length === 2);
}

console.log('\n[duplicate source_id in the blob — first wins, matching IC]');
{
  // A pre-existing duplicate (e.g. a legacy double-send). IC's dedup keeps the
  // FIRST occurrence, so the reconciler must update that same one — updating
  // the second would write into a copy IC is about to discard.
  const first  = { id: 'e-first',  source: 'dust-other-billing', source_id: 'ob-1', company_id: 'co-1', company_name: 'Acme Materials', actual_date: '2026-07-14', total: 1, sent_at: '2026-07-14T10:00:00.000Z' };
  const second = { id: 'e-second', source: 'dust-other-billing', source_id: 'ob-1', company_id: 'co-1', company_name: 'Acme Materials', actual_date: '2026-07-14', total: 2, sent_at: '2026-07-15T10:00:00.000Z' };
  const entries = [first, second];
  harness([obRow()], [], entries, CO);
  const updated = entries.find(e => e.id === 'e-first');
  assert('first occurrence updated', updated && updated.total === 630);
  assert('its sent_at preserved', updated.sent_at === '2026-07-14T10:00:00.000Z');
  assert('no third entry appended', obEntries(entries).length === 2);
}

console.log('\n[mixed pass — create, update, void and delete in one reconcile]');
{
  const entries = [foreign()];
  harness([obRow({ id: 'ob-keep' }), obRow({ id: 'ob-zero' }), obRow({ id: 'ob-gone' })], [], entries, CO);
  assert('three entries seeded', obEntries(entries).length === 3);

  const res = harness(
    [obRow({ id: 'ob-keep', trucking_hrs: '6' }),
     obRow({ id: 'ob-zero', gallons_bags: '0', price_per_unit: '0', trucking_hrs: '0', trucking_rate: '0' }),
     obRow({ id: 'ob-new' })],
    ['ob-gone'], entries, CO);

  const byId = Object.fromEntries(obEntries(entries).map(e => [e.source_id, e]));
  assert('reports changed', res.changed === true);
  assert('edited row updated (250 + 570)', byId['ob-keep'].total === 820);
  assert('zeroed row voided', !byId['ob-zero']);
  assert('deleted row removed', !byId['ob-gone']);
  assert('new row created', byId['ob-new'] && byId['ob-new'].total === 630);
  assert('foreign entry still untouched', entries.some(x => x.id === 'tr-entry' && x.total === 1200));
  assert('clearNow covers void + delete', res.clearNow.includes('ob-zero') && res.clearNow.includes('ob-gone'));
}

// ── Orchestration: autoSyncObIntercompany's read → probe → write flow ─────
// The reconciler above is pure; this exercises the wrapper that actually talks
// to the shared blob, against a fake store. What matters here is that it never
// writes needlessly, never writes on a failed read, force-clears a genuinely
// emptied blob past the backend's bulk-wipe guard, and serialises against the
// Dust Tracking sync that writes the same blob.

function buildRuntime() {
  const state = {
    store: {
      fct_intercompany_companies: [ACME],
      fct_intercompany_billing_entries: [],
    },
    puts: [],            // {key, force, count}
    failBillingRead: false,
    gate: null,          // set to a promise to stall the first GET
    dustSyncCalls: 0,
  };
  const clone = v => JSON.parse(JSON.stringify(v));

  const api = new Function('state', 'clone', `
    let _icSyncRunning = false;
    let _icDustQueued  = false;
    let _icObQueued    = false;
    let obRows = [];
    const obDeletedIds = new Set();
    const obIcSent = new Map();
    const user  = { username: 'tester' };
    const token = 'tok';
    // Both consts exist in dust.html (IC_BILLING_KEY for the tracking sync's
    // guarded read, OB_IC_KEY for the OB writes) and hold the same key.
    const IC_BILLING_KEY = 'fct_intercompany_billing_entries';
    const OB_IC_KEY      = 'fct_intercompany_billing_entries';
    const document = { querySelector: () => null, getElementById: () => null };
    const AUTH_HDR = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer tok' });
    const signOut = () => {};
    const fmtSentAt = () => 'now';
    function autoSyncIntercompanyDust() { state.dustSyncCalls++; }

    async function fetch(url, init) {
      if (state.gate) { const g = state.gate; state.gate = null; await g; }
      const key = String(url).split('/').pop().split('?')[0];
      if (!init || init.method !== 'PUT') {
        if (key === 'fct_intercompany_billing_entries' && state.failBillingRead) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ value: clone(state.store[key]) }) };
      }
      const value = JSON.parse(init.body).value;
      state.store[key] = clone(value);
      state.puts.push({ key, force: String(url).includes('force=1'), count: value.length });
      return { ok: true, status: 200 };
    }
    async function apiGet(key) {
      const r = await fetch('/api/data/' + key, {});
      if (!r.ok) return null;
      const { value } = await r.json();
      return value;
    }
    async function apiPut(key, value) {
      const r = await fetch('/api/data/' + key, { method: 'PUT', headers: AUTH_HDR(), body: JSON.stringify({ value }) });
      return r.ok;
    }

    ${extractFn('round2')}
    ${extractFn('obCalc')}
    ${extractFn('_icObEntrySig')}
    ${extractFn('_reconcileObBilling')}
    ${extractFn('_readIcBilling')}
    ${extractFn('_drainIcQueue')}
    ${extractFn('autoSyncObIntercompany')}
    ${extractFn('obRefreshIcChips')}
    ${extractFn('obClearIcChips')}

    return {
      sync: autoSyncObIntercompany,
      setRows: r => { obRows = r; },
      queueDelete: id => obDeletedIds.add(id),
      pendingDeletes: () => [...obDeletedIds],
      sentMap: () => [...obIcSent.keys()],
      obQueued: () => _icObQueued,
      lock: v => { _icSyncRunning = v; },
    };
  `)(state, clone);

  return { state, api };
}

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const obIn = state => state.store.fct_intercompany_billing_entries.filter(e => e.source === 'dust-other-billing');

(async () => {
  console.log('\n[orchestration — first sync writes once]');
  {
    const { state, api } = buildRuntime();
    api.setRows([obRow()]);
    await api.sync();
    assert('exactly one PUT', state.puts.length === 1);
    assert('not force-cleared', state.puts[0] && state.puts[0].force === false);
    assert('entry landed in the blob', obIn(state).length === 1 && obIn(state)[0].total === 630);
    assert('sent map updated after the write', api.sentMap().includes('ob-1'));
  }

  console.log('\n[orchestration — steady state writes nothing]');
  {
    const { state, api } = buildRuntime();
    api.setRows([obRow()]);
    await api.sync();
    const after = state.puts.length;
    await api.sync();
    await api.sync();
    assert('no further PUTs', state.puts.length === after);
  }

  console.log('\n[orchestration — emptied blob is force-cleared past the wipe guard]');
  {
    const { state, api } = buildRuntime();
    api.setRows([obRow()]);
    await api.sync();
    api.setRows([obRow({ gallons_bags: '', price_per_unit: '', trucking_hrs: '', trucking_rate: '' })]);
    await api.sync();
    const last = state.puts[state.puts.length - 1];
    assert('a second PUT happened', state.puts.length === 2);
    assert('it used force=1', last.force === true);
    assert('blob is now empty', state.store.fct_intercompany_billing_entries.length === 0);
    assert('chip state cleared', !api.sentMap().includes('ob-1'));
  }

  console.log('\n[orchestration — a failed billing read never writes]');
  {
    const { state, api } = buildRuntime();
    api.setRows([obRow()]);
    state.failBillingRead = true;
    api.queueDelete('ob-gone');
    await api.sync();
    assert('no PUT attempted', state.puts.length === 0);
    assert('queued delete retained for retry', api.pendingDeletes().includes('ob-gone'));
    // Read recovers → the work still happens.
    state.failBillingRead = false;
    await api.sync();
    assert('writes once the read recovers', state.puts.length === 1);
    assert('delete dequeued after success', api.pendingDeletes().length === 0);
  }

  console.log('\n[orchestration — a delete with no IC entry dequeues without a write]');
  {
    const { state, api } = buildRuntime();
    api.setRows([]);
    api.queueDelete('never-sent');
    await api.sync();
    assert('no PUT', state.puts.length === 0);
    assert('id dropped from the queue', api.pendingDeletes().length === 0);
  }

  console.log('\n[orchestration — serialised against the Dust Tracking sync]');
  {
    const { state, api } = buildRuntime();
    api.setRows([obRow()]);
    api.lock(true);                       // pretend the tracking sync holds the lock
    await api.sync();
    assert('no concurrent write', state.puts.length === 0);
    assert('work queued instead', api.obQueued() === true);
    api.lock(false);
  }

  console.log('\n[orchestration — overlapping calls collapse, no duplicate entry]');
  {
    const { state, api } = buildRuntime();
    api.setRows([obRow()]);
    let release;
    state.gate = new Promise(r => { release = r; });
    const first = api.sync();             // stalls on its first GET
    await flush();
    const second = api.sync();            // must be queued, not run
    await second;
    assert('second call returned immediately', state.puts.length === 0);
    release();
    await first;
    await flush(8);                       // let the drained re-run finish
    assert('only one PUT total', state.puts.length === 1);
    assert('exactly one entry, no duplicate', obIn(state).length === 1);
    assert('queue drained', api.obQueued() === false);
  }

  // ── The 60s poller must not undo unsaved local state ────────────────────
  // pollObRows replaces obRows wholesale from the server. Guarding only on
  // _isEditing() is not enough: obDeleteRow leaves focus on a <button>, so
  // during the 900ms save debounce the poll saw "not editing", restored the
  // deleted row from the server snapshot, and the debounced save then wrote
  // that restored list back — the delete silently reverted.
  function buildPoller(serverRows) {
    const state = { server: serverRows, editing: false, gate: null, renders: 0, syncs: 0 };
    const api = new Function('state', `
      let obRows = [];
      let obSaveTimer = null;
      let obSaving = false;
      const obDeletedIds = new Set();
      const OB_KEY = 'dust_other_billing_rows';
      const document = { getElementById: () => null };
      const _isEditing = () => state.editing;
      const obRenderTable = () => { state.renders++; };
      const autoSyncObIntercompany = () => { state.syncs++; };
      async function apiGet() {
        if (state.gate) { const g = state.gate; state.gate = null; await g; }
        return JSON.parse(JSON.stringify(state.server));
      }
      ${extractFn('obHasPendingSave')}
      ${extractFn('pollObRows')}
      return {
        poll: pollObRows,
        rows: () => obRows,
        setRows: r => { obRows = r; },
        setTimer: v => { obSaveTimer = v; },
        setSaving: v => { obSaving = v; },
        queueDelete: id => obDeletedIds.add(id),
        clearDeletes: () => obDeletedIds.clear(),
        pending: () => obHasPendingSave(),
      };
    `)(state);
    return { state, api };
  }

  const rowA = { id: 'ob-a', date: '2026-07-14', customer: 'Acme Materials' };
  const rowB = { id: 'ob-b', date: '2026-07-15', customer: 'Acme Materials' };

  console.log('\n[poller — a delete mid-debounce is not resurrected]');
  {
    const { api } = buildPoller([rowA, rowB]);   // server still has both
    api.setRows([rowA]);                         // user deleted B locally
    api.queueDelete('ob-b');
    api.setTimer(1);                             // 900ms debounce still open
    assert('pending save detected', api.pending() === true);
    await api.poll();
    assert('obRows untouched', JSON.stringify(api.rows()) === JSON.stringify([rowA]));
    assert('deleted row stayed deleted', !api.rows().some(r => r.id === 'ob-b'));
  }

  console.log('\n[poller — a queued delete alone is enough to stand down]');
  {
    const { api } = buildPoller([rowA, rowB]);
    api.setRows([rowA]);
    api.queueDelete('ob-b');                     // debounce already fired…
    api.setTimer(null);                          // …but IC hasn't been told yet
    assert('still counted as pending', api.pending() === true);
    await api.poll();
    assert('obRows untouched', !api.rows().some(r => r.id === 'ob-b'));
  }

  console.log('\n[poller — a save in flight blocks the overwrite]');
  {
    const { api } = buildPoller([rowA, rowB]);
    api.setRows([rowA]);
    api.setSaving(true);
    assert('in-flight save detected', api.pending() === true);
    await api.poll();
    assert('obRows untouched', !api.rows().some(r => r.id === 'ob-b'));
  }

  console.log('\n[poller — a delete that lands mid-flight still wins]');
  {
    const { api, state } = buildPoller([rowA, rowB]);
    api.setRows([rowA, rowB]);
    let release;
    state.gate = new Promise(r => { release = r; });
    const p = api.poll();                        // stalls inside apiGet
    await flush();
    api.setRows([rowA]);                         // user deletes B during the round-trip
    api.queueDelete('ob-b');
    api.setTimer(1);
    release();
    await p;
    assert('stale snapshot discarded', !api.rows().some(r => r.id === 'ob-b'));
  }

  console.log('\n[poller — still picks up genuine remote changes]');
  {
    const { api, state } = buildPoller([rowA, rowB]);
    api.setRows([rowA]);                         // another device added B
    assert('nothing pending', api.pending() === false);
    await api.poll();
    assert('remote row adopted', api.rows().some(r => r.id === 'ob-b'));
    assert('table re-rendered / sync kicked', state.syncs === 1);
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
