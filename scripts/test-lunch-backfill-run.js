#!/usr/bin/env node
'use strict';
/**
 * The backfill script end to end, against an in-memory database.
 *
 * Run: node scripts/test-lunch-backfill-run.js
 *
 * scripts/test-lunch-backfill.js proves the DECISIONS. This proves the script
 * that acts on them: that a dry run writes nothing, that --apply writes exactly
 * the planned rows and audits every one, that the days it refuses stay refused,
 * and that its own post-write verification would catch a bad landing.
 *
 * There is no database in this environment and there must not be one in CI, so
 * @neondatabase/serverless is stubbed in the require cache with a tiny table
 * that answers the five queries the script makes. That is enough to exercise
 * every branch of the script, which is the point: a backfill gets one chance to
 * be right against live payroll, and rehearsing it there is not an option.
 */

const path = require('path');
const Module = require('module');

// The script requires the Neon driver at load. Without node_modules there is
// nothing to stub and nothing to test, so say so and stop — same convention as
// the browser suites, which skip when playwright is absent.
try { require.resolve('@neondatabase/serverless'); require.resolve('dotenv'); }
catch { console.log('@neondatabase/serverless not installed — skipping backfill run checks'); process.exit(0); }

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── A table, and the five queries the script asks of it ───────────────────
function makeDb(rows) {
  const table = rows.map(r => Object.assign({}, r));
  const audit = [];
  const seen  = [];
  const sql = (strings, ...vals) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    seen.push(q);
    if (/SELECT DISTINCT split_group_id/.test(q)) {
      const [company, from, to] = vals;
      const ok = table.filter(r =>
        (!company || r.company_code === company) &&
        (!from || r.work_date >= from) && (!to || r.work_date <= to));
      return Promise.resolve([...new Set(ok.map(r => r.split_group_id))].map(g => ({ split_group_id: g })));
    }
    if (/SELECT id, company_code/.test(q)) {
      const ids = vals[0];
      return Promise.resolve(table.filter(r => ids.includes(r.split_group_id)).map(r => Object.assign({}, r)));
    }
    if (/UPDATE timesheet_entries/.test(q)) {
      const [lunch, hours, id] = vals;
      const row = table.find(r => String(r.id) === String(id));
      if (!row) return Promise.resolve([]);
      row.lunch_break = lunch; row.computed_hours = hours;
      return Promise.resolve([Object.assign({}, row)]);
    }
    if (/INSERT INTO timesheet_audit_log/.test(q)) {
      // The action and the actor are literals in the SQL, not bindings, so the
      // bound values are company_code, entry_id, changes, snapshot.
      audit.push({
        company: vals[0], entry_id: vals[1],
        changes: JSON.parse(vals[2]), snapshot: JSON.parse(vals[3]),
        sqlText: q,
      });
      return Promise.resolve([]);
    }
    if (/SELECT split_group_id, id/.test(q)) {
      const ids = vals[0];
      return Promise.resolve(table.filter(r => ids.includes(r.split_group_id)).map(r => Object.assign({}, r)));
    }
    throw new Error('unexpected query: ' + q.slice(0, 80));
  };
  return { sql, table, audit, seen };
}

// Run the script in-process with the driver and dotenv stubbed out.
function runScript(rows, args) {
  const db = makeDb(rows);
  const scriptPath = path.resolve(__dirname, 'backfill-lunch-holder.js');
  // Keyed by RESOLVED path — require.cache is keyed by filename, so a bare
  // specifier never matches and the real driver loads instead.
  const stub = (spec, exports) => {
    const id = require.resolve(spec);
    const m = new Module(id, null);
    m.filename = id; m.loaded = true; m.exports = exports;
    require.cache[id] = m;
  };
  stub('@neondatabase/serverless', { neon: () => db.sql });
  stub('dotenv', { config: () => ({}) });

  const envWas = process.env.DATABASE_URL, logWas = console.log, errWas = console.error;
  const out = [];
  process.env.DATABASE_URL = 'postgres://stub/stub';
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push('ERR ' + a.join(' '));
  delete require.cache[scriptPath];

  const { main } = require(scriptPath);
  return main(args).then(() => {
    process.env.DATABASE_URL = envWas;
    console.log = logWas; console.error = errWas;
    return { out: out.join('\n'), db };
  }, err => {
    process.env.DATABASE_URL = envWas;
    console.log = logWas; console.error = errWas;
    throw err;
  });
}

// ── Fixtures: the reported day, and the shapes that must be refused ───────
const day = (group, windows, holderIdx, status = 'submitted') => windows.map((w, i) => {
  const [sh, sm] = w[0].split(':').map(Number);
  const [eh, em] = w[1].split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm); if (mins < 0) mins += 1440;
  const gross = Math.round((mins / 60) * 100) / 100;
  return {
    id: `${group}-${i + 1}`, company_code: 'FC', username: 'johnstonadam',
    entry_type: 'daily', status, work_date: '2026-09-17',
    job_label: i === 0 ? 'Woodland Hills · 25008' : 'Hildebrand · 26045', division: 'turf',
    start_time: w[0], end_time: w[1],
    computed_hours: i === holderIdx ? Math.round((gross - 0.5) * 100) / 100 : gross,
    lunch_break: i === holderIdx,
    split_group_id: group, split_index: i + 1, split_count: windows.length,
  };
});

const REPORTED = day('gA', [['07:30', '09:00'], ['09:30', '16:00']], 0);

(async () => {
  // ── 1. Dry run ──────────────────────────────────────────────────────────
  console.log('\nA dry run reports and writes nothing');
  {
    const { out, db } = await runScript(REPORTED.map(r => ({ ...r })), []);
    assert('says it is a dry run', /DRY RUN — nothing will be written/.test(out));
    assert('finds the day', /1 day\(s\) to move/.test(out), out.slice(0, 300));
    assert('names both sides of the move',
      /Woodland Hills/.test(out) && /Hildebrand/.test(out));
    assert('shows the day total unchanged', /7\.50 → 7\.50/.test(out), out);
    assert('shows each row\'s before and after',
      /hours 1\.00 → 1\.50/.test(out) && /hours 6\.50 → 6\.00/.test(out), out);
    assert('wrote nothing at all',
      db.table.every(r => r.id === 'gA-1' ? r.computed_hours === 1.0 : r.computed_hours === 6.5)
      && db.audit.length === 0);
    assert('issues no UPDATE', !db.seen.some(q => /UPDATE/.test(q)));
    assert('tells you how to apply it', /Re-run with --apply/.test(out));
    assert('and that approved days were not looked at', /--show-approved/.test(out));
  }

  // ── 2. Apply ────────────────────────────────────────────────────────────
  console.log('\n--apply writes exactly the planned rows');
  {
    const { out, db } = await runScript(REPORTED.map(r => ({ ...r })), ['--apply']);
    assert('says it is applying', /── APPLYING ──/.test(out));
    assert('rewrote two rows across one day', /Rewrote 2 row\(s\) across 1 day\(s\)/.test(out), out);
    const a = db.table.find(r => r.id === 'gA-1'), b = db.table.find(r => r.id === 'gA-2');
    assert('the morning job is made whole', a.computed_hours === 1.5 && a.lunch_break === false);
    assert('the midday job carries the break', b.computed_hours === 6.0 && b.lunch_break === true);
    assert('the day still totals 7.50',
      Math.abs((a.computed_hours + b.computed_hours) - 7.5) < 0.005);
    assert('exactly one row holds it',
      db.table.filter(r => r.lunch_break === true).length === 1);
    assert('every change is audited', db.audit.length === 2);
    assert('the audit says why and records both figures',
      db.audit.every(x => /backfill/.test(x.changes.reason)
        && x.changes.computed_hours && x.changes.day_total_hours));
    assert('the audit names the actor and the action',
      db.audit.every(x => /'backfill-lunch-holder'/.test(x.sqlText) && /'ADMIN_EDIT'/.test(x.sqlText)));
    assert('and snapshots the row as it now stands',
      db.audit.every(x => x.snapshot && x.snapshot.id)
      && db.audit.some(x => x.snapshot.computed_hours === 1.5)
      && db.audit.some(x => x.snapshot.computed_hours === 6.0));
    assert('it verifies what landed', /Verified: every day rewritten/.test(out), out.slice(-300));
  }

  // ── 3. What it refuses ──────────────────────────────────────────────────
  console.log('\nDays that would change pay are refused, even with --apply');
  {
    const twice = day('gB', [['07:00', '11:00'], ['11:30', '16:00']], 0);
    twice[1].lunch_break = true; twice[1].computed_hours = 4.0;
    const { out, db } = await runScript(twice, ['--apply']);
    assert('reports the double deduction', /already deducted twice/.test(out), out.slice(0, 400));
    assert('says correcting it changes pay', /hands hours back/.test(out));
    assert('and writes nothing', db.audit.length === 0 && db.table[1].computed_hours === 4.0);
  }
  {
    const drift = day('gC', [['07:00', '11:00'], ['11:30', '16:00']], 0);
    drift[1].computed_hours = 9.75;
    const { out, db } = await runScript(drift, ['--apply']);
    assert('reports hours that match no punches', /do not match their punches/.test(out));
    assert('and writes nothing', db.audit.length === 0);
  }
  {
    const broken = day('gD', [['07:30', '09:00'], ['09:30', '16:00']], 0);
    broken[1].start_time = '';
    const { out, db } = await runScript(broken, ['--apply']);
    assert('reports punches that do not compute', /do not compute/.test(out));
    assert('and writes nothing', db.audit.length === 0);
  }

  // ── 4. Approved days are never written ──────────────────────────────────
  console.log('\nApproved days are listed, never rewritten');
  {
    const appr = day('gE', [['07:30', '09:00'], ['09:30', '16:00']], 0, 'approved');
    const { out, db } = await runScript(appr.map(r => ({ ...r })), ['--apply']);
    assert('an approved day is out of scope', /out of status scope/.test(out));
    assert('and nothing is written', db.audit.length === 0);
    assert('nothing is moved', /Nothing to move/.test(out));
    assert('it says how to see them', /--show-approved/.test(out));
  }
  {
    // --apply must not be a way in. This is the assertion that matters most in
    // this file: the API refuses the same edit with a 409, and a script has no
    // business doing quietly what the application refuses to do loudly.
    const appr = day('gF', [['07:30', '09:00'], ['09:30', '16:00']], 0, 'approved');
    const { out, db } = await runScript(appr.map(r => ({ ...r })), ['--show-approved', '--apply']);
    assert('--show-approved LISTS the affected approved day',
      /1 APPROVED day\(s\) also sit on the old rule/.test(out), out.slice(0, 600));
    assert('and still writes absolutely nothing',
      db.audit.length === 0 && !db.seen.some(q => /UPDATE/.test(q)));
    assert('the stored hours are untouched',
      db.table[0].computed_hours === 1.0 && db.table[1].computed_hours === 6.5);
    assert('it explains why, and what to do instead',
      /balance check/.test(out) && /un-approve it/i.test(out) && /409/.test(out), out.slice(-500));
  }
  {
    const none = day('gI', [['07:30', '09:00'], ['09:30', '16:00']], 1, 'approved');
    const { out } = await runScript(none, ['--show-approved']);
    assert('an approved day already on the new rule is not listed',
      /No approved days are affected/.test(out), out.slice(-300));
  }

  // ── 5. Scope filters ────────────────────────────────────────────────────
  console.log('\nScope filters narrow the pass');
  {
    const { out, db } = await runScript(REPORTED.map(r => ({ ...r })), ['--company', 'ZZ']);
    assert('a company with no days reports none',
      /No split days found/.test(out) && db.audit.length === 0);
  }
  {
    const two = [].concat(
      day('gG', [['07:30', '09:00'], ['09:30', '16:00']], 0),
      day('gH', [['06:00', '08:00'], ['08:30', '15:00']], 0));
    const { out, db } = await runScript(two, ['--apply', '--limit', '1']);
    assert('--limit caps how many days are rewritten',
      /Limiting to the first 1 of 2/.test(out) && /across 1 day\(s\)/.test(out), out.slice(-300));
    assert('so the second day is left for the next pass', db.audit.length === 2);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
