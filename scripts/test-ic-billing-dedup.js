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

console.log('\n[DUST — same source_id sent twice keeps the latest sent_at]');
const dustOld = {
  source: 'dust', source_id: 'd-100',
  actual_date: '2026-04-15', company_name: 'Kovalchick',
  location: 'site-a', vehicle1: '36300', start_time: '07:00',
  total: 50, sent_at: '2026-04-15T12:00:00Z',
};
const dustNew = { ...dustOld, total: 75, sent_at: '2026-04-16T08:00:00Z' };
const outDustResend = dedupBillingEntries([dustOld, dustNew]);
assert('only one dust entry survives', outDustResend.length === 1);
assert('the surviving entry is the latest sent_at',
  outDustResend[0].sent_at === '2026-04-16T08:00:00Z');
assert('the surviving entry has the new total', outDustResend[0].total === 75);

console.log('\n[DUST — timeless original + timed CSV replacement collapse to one]');
const dustTimeless = {
  source: 'dust', source_id: 'd-200a',
  actual_date: '2026-04-16', company_name: 'Kovalchick',
  location: 'plant-b', vehicle1: '36400', start_time: '',
  sent_at: '2026-04-16T10:00:00Z', total: 100,
};
const dustTimed = {
  source: 'dust', source_id: 'd-200b',
  actual_date: '2026-04-16', company_name: 'Kovalchick',
  location: 'plant-b', vehicle1: '36400', start_time: '08:30',
  sent_at: '2026-04-16T18:00:00Z', total: 110,
};
const outDustTimed = dedupBillingEntries([dustTimeless, dustTimed]);
assert('timeless+timed dust collapse to one (existing dust behavior intact)',
  outDustTimed.length === 1);
assert('the timed (later sent_at) winner is kept',
  outDustTimed[0].source_id === 'd-200b');

console.log('\n[DUST — two different physical jobs survive (different vehicle1)]');
const dustJobA = {
  source: 'dust', source_id: 'd-300',
  actual_date: '2026-04-17', company_name: 'Kovalchick',
  location: 'site-z', vehicle1: '36500', start_time: '06:00',
  sent_at: '2026-04-17T09:00:00Z',
};
const dustJobB = {
  source: 'dust', source_id: 'd-301',
  actual_date: '2026-04-17', company_name: 'Kovalchick',
  location: 'site-z', vehicle1: '36600', start_time: '06:00',
  sent_at: '2026-04-17T09:05:00Z',
};
const outDustTwo = dedupBillingEntries([dustJobA, dustJobB]);
assert('two distinct dust jobs both survive', outDustTwo.length === 2);

console.log('\n[DUST — dust without source_id falls through to content-key dedup]');
// (Old dust rows imported before source_id was tracked.)
const dustNoIdA = {
  source: 'dust',
  actual_date: '2026-04-18', company_name: 'Kovalchick',
  actual_start: '06:30', location: 'site-q',
  total: 80,
};
const dustNoIdB = { ...dustNoIdA }; // exact dup
const dustNoIdC = { ...dustNoIdA, location: 'site-r' }; // different location → not a dup
const outDustNoId = dedupBillingEntries([dustNoIdA, dustNoIdB, dustNoIdC]);
assert('dust-without-source_id true dup collapses, distinct survives',
  outDustNoId.length === 2);

console.log('\n[DUST — does NOT get caught by the new non-dust source_id branch]');
// Defensive: a dust entry with source_id should hit the dust branch first,
// never the new (source, source_id) branch — verify by mixing cases that
// would conflict if order were wrong.
const dustS = {
  source: 'dust', source_id: 'd-400',
  actual_date: '2026-04-19', company_name: 'Co', location: 'L',
  vehicle1: 'V1', sent_at: '2026-04-19T10:00:00Z',
};
const tr400 = {
  source: 'trucking', source_id: 'd-400', // same string, different source
  actual_date: '2026-04-19', company_name: 'Co',
  actual_start: '07:00', driver: 'X', total: 200,
};
const outMixSrc = dedupBillingEntries([dustS, tr400]);
assert('dust + trucking sharing the same source_id string both survive',
  outMixSrc.length === 2);

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
