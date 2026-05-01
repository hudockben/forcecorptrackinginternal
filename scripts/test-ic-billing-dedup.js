'use strict';

// Reproduces and verifies the IC billing dedup logic from intercompany.html
// loadBillingEntries(). Two legitimate trucking entries with the same date,
// customer, and start time (different drivers/units) MUST NOT be collapsed.
// The original logic used a content key that excluded source_id, so any two
// trucking sends sharing date+customer+start collided — the second was dropped
// and the deduped list was PUT back to the blob, permanently wiping it.

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}`); failed++; }
}

// Verbatim copy of the (fixed) dedup. Keep in sync with intercompany.html.
function dedupBillingEntries(raw) {
  const bestBySourceId = new Map();
  for (const e of raw) {
    if (e.source === 'dust' && e.source_id) {
      const prev = bestBySourceId.get(e.source_id);
      if (!prev || (e.sent_at || '') > (prev.sent_at || '')) {
        bestBySourceId.set(e.source_id, e);
      }
    }
  }
  const bestByJobKey = new Map();
  for (const e of bestBySourceId.values()) {
    const jk = `${e.actual_date}|${(e.company_name||'').toLowerCase()}|${(e.location||'').toLowerCase()}|${(e.vehicle1||'').toLowerCase()}`;
    const prev = bestByJobKey.get(jk);
    if (!prev || (e.sent_at || '') > (prev.sent_at || '')) {
      bestByJobKey.set(jk, e);
    }
  }
  const seenContentKeys = new Set();
  const seenSourceIds   = new Set();
  const deduped = [];
  for (const e of raw) {
    if (e.source === 'dust' && e.source_id) {
      const jk = `${e.actual_date}|${(e.company_name||'').toLowerCase()}|${(e.location||'').toLowerCase()}|${(e.vehicle1||'').toLowerCase()}`;
      if (bestByJobKey.get(jk) === e) deduped.push(e);
    } else if (e.source_id) {
      // Non-dust entries with a source_id (trucking, paving) are uniquely
      // identified by (source, source_id). Two entries with different
      // source_ids are different rows even if other fields collide.
      const sk = `${e.source||''}|${e.source_id}`;
      if (!seenSourceIds.has(sk)) { seenSourceIds.add(sk); deduped.push(e); }
    } else {
      const ck = `${e.actual_date}|${(e.company_name||'').toLowerCase()}|${e.actual_start||''}|${(e.location||'').toLowerCase()}|${e.source||''}`;
      if (!seenContentKeys.has(ck)) { seenContentKeys.add(ck); deduped.push(e); }
    }
  }
  return deduped;
}

console.log('[two trucking rows, same date+customer+start, different source_ids]');
const tr0610 = {
  source: 'trucking', source_id: 'src-tr-0610',
  task_number: 'TR-0610',
  actual_date: '2026-04-29', company_name: 'Kovalchick',
  actual_start: '05:30', driver: 'Becker, Ben', unit: '634',
  total_hours: 2.5, haul_fee: 115, total: 287.50,
  sent_at: '2026-04-30T13:36:00Z',
};
const tr0613 = {
  source: 'trucking', source_id: 'src-tr-0613',
  task_number: 'TR-0613',
  actual_date: '2026-04-29', company_name: 'Kovalchick',
  actual_start: '05:30', driver: 'Leasure, Rick', unit: '2767',
  total_hours: 2.0, haul_fee: 115, total: 230.00,
  sent_at: '2026-05-01T15:32:00Z',
};

const out = dedupBillingEntries([tr0610, tr0613]);
assert('both entries survive dedup', out.length === 2);
assert('TR-0610 survives', out.some(e => e.source_id === 'src-tr-0610'));
assert('TR-0613 survives', out.some(e => e.source_id === 'src-tr-0613'));

console.log('\n[true duplicate trucking entries — same source_id sent twice]');
const dupA = { ...tr0613, sent_at: '2026-05-01T15:32:00Z' };
const dupB = { ...tr0613, sent_at: '2026-05-01T15:35:00Z' };
const out2 = dedupBillingEntries([dupA, dupB]);
assert('only one survives', out2.length === 1);

console.log('\n[manual entry with no source_id — falls back to content key]');
const manualA = {
  source: 'manual',
  actual_date: '2026-04-29', company_name: 'Kovalchick',
  actual_start: '05:30', total: 100,
};
const manualB = { ...manualA };
const out3 = dedupBillingEntries([manualA, manualB]);
assert('manual content-key dedup still works', out3.length === 1);

console.log('\n[mixed dust + trucking]');
const dust1 = {
  source: 'dust', source_id: 'd1', actual_date: '2026-04-20',
  company_name: 'Kovalchick', location: 'site-a', vehicle1: '36303',
  sent_at: '2026-04-20T10:00:00Z',
};
const out4 = dedupBillingEntries([dust1, tr0610, tr0613]);
assert('dust and both trucking rows all survive', out4.length === 3);

console.log('\n[BUG REGRESSION — old behavior would collapse tr0610+tr0613]');
function oldDedup(raw) {
  const seen = new Set(), out = [];
  for (const e of raw) {
    const ck = `${e.actual_date}|${(e.company_name||'').toLowerCase()}|${e.actual_start||''}|${(e.location||'').toLowerCase()}|${e.source||''}`;
    if (!seen.has(ck)) { seen.add(ck); out.push(e); }
  }
  return out;
}
assert('OLD logic collapses to 1 (this is the bug)',
  oldDedup([tr0610, tr0613]).length === 1);
assert('NEW logic keeps both',
  dedupBillingEntries([tr0610, tr0613]).length === 2);

console.log('\n────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('────────────────────────────────────────');
process.exit(failed > 0 ? 1 : 0);
