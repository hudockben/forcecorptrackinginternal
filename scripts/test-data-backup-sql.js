#!/usr/bin/env node
'use strict';
/**
 * SQL-level test for the nightly backup and the check.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-data-backup-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * DESTRUCTIVE: empties app_data, app_data_snapshots, list_counts,
 * list_alerts_pending and daily_tracking. It refuses to run against a database
 * whose name doesn't look like a test database.
 *
 * scripts/test-data-backup.js pins the decisions around the SQL. This one runs
 * the SQL itself — the tables straight out of neon-schema.sql and the real
 * api/lib/data-backup.js — through a month that includes this September's
 * incident: the turf lists saved empty, noticed the next morning, and put back
 * by running the restore the alert email carries.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const B = require(path.join(ROOT, 'api', 'lib', 'data-backup'));

const TABLES = /app_data_snapshots|list_counts|list_alerts_pending/;

/** The statements neon-schema.sql holds for these tables, split the way scripts/run-schema.js splits them. */
function schemaStatements() {
  return fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean)
    .filter(s => TABLES.test(s));
}

/** neon-serverless' tagged template over any client with query(text, values) → { rows }. */
function makeSql(client) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return client.query(text, values).then(r => r.rows);
  };
}

/** The restores an alert email carries, as someone would copy them out of it. */
function restoresIn(html) {
  const unescape = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map(m => unescape(m[1]))
    .map(snippet => snippet.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(x => x.trim()).filter(Boolean));
}

async function run(client) {
  let passed = 0, failed = 0;
  const assert = (label, cond, detail) => {
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
  };
  const q = (text, values = []) => client.query(text, values).then(r => r.rows);
  const sql = makeSql(client);

  // The tables this reads, as far as it reads them — no-ops against a database
  // already carrying the full schema.
  await q(`CREATE TABLE IF NOT EXISTS companies (code TEXT PRIMARY KEY, name TEXT NOT NULL)`);
  await q(`CREATE TABLE IF NOT EXISTS app_data (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT 'null',
             updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS daily_tracking (id SERIAL PRIMARY KEY, date DATE NOT NULL,
             company_code TEXT NOT NULL DEFAULT '', division TEXT NOT NULL DEFAULT 'turf')`);
  const schema = schemaStatements();
  assert('the schema file holds the three tables', ['app_data_snapshots', 'list_counts', 'list_alerts_pending']
    .every(t => schema.some(s => s.startsWith(`CREATE TABLE IF NOT EXISTS ${t}`))), schema.map(s => s.slice(0, 50)).join(' | '));
  for (const stmt of schema) await q(stmt);
  await q(`TRUNCATE app_data, app_data_snapshots, list_counts, list_alerts_pending`);
  await q(`DELETE FROM daily_tracking`);
  await q(`INSERT INTO companies (code, name) VALUES ('FORCECORP', 'Force Corp') ON CONFLICT (code) DO NOTHING`);

  const put = (key, value) => q(`
    INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);
  const get = async key => { const r = await q(`SELECT value FROM app_data WHERE key = $1`, [key]); return r.length ? r[0].value : undefined; };
  const people = n => Array.from({ length: n }, (_, i) => ({ name: `Hand ${i}`, prevailing_rate: 40 + i, non_prevailing_rate: 20 + i }));
  const LISTS = {
    employees: [{ name: 'Allen Strick', prevailing_rate: 52.1, non_prevailing_rate: 31.5 },
                { name: 'Ted Devalerio', prevailing_rate: 49, non_prevailing_rate: 28 },
                { name: 'Sam Ortiz', prevailing_rate: 44, non_prevailing_rate: 24 }],
    equipment: [{ name: 'Skid Steer', unit_cost: 40 }, { name: 'CAT 299D', unit_cost: 65 }],
    suppliers: [], _crm_lists_seeded: true,
  };
  const WIPED = { employees: [], equipment: [], suppliers: [], crm_sources: ['Referral'], _crm_lists_seeded: true };
  await put('FORCECORP:fct_lists', LISTS);
  await put('FORCECORP:fct_cost_rows', Array.from({ length: 8 }, (_, i) => ({ id: i })));
  await put('FORCECORP:fct_presence', { who: ['someone'] });
  await put('FORCECORP:fct_project_p1', { id: 'p1', assigned_employees: ['Allen Strick', 'Sam Ortiz'] });
  // The assistants' caches: rebuilt on demand, so neither copied nor watched.
  await put('FORCECORP:fct_ai_sched_p1_2026-09-01', { recommendations: [1, 2, 3] });
  await put('FORCECORP:fct_scheduler_ai_2026-09-01_abc', { insights: [1, 2] });
  for (let i = 0; i < 5; i++) await q(`INSERT INTO daily_tracking (company_code, division, date) VALUES ('FORCECORP', 'turf', '2026-09-01')`);

  const emails = [];
  // failSend: the mail provider refuses every message on that run.
  const runAt = (at, { failSend = false } = {}) => B.runDataBackup(sql, {
    now: new Date(at), recipients: ['ops@forcecorp.test'],
    send: async (msg) => {
      if (failSend) return { ok: false, error: 'provider unavailable' };
      emails.push({ at, ...msg });
      return { ok: true };
    },
  });
  const STAMP = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;
  const copies = key => q(`SELECT to_char(taken_at AT TIME ZONE 'UTC', ${STAMP}) AS t, value, value_hash
                           FROM app_data_snapshots WHERE key = $1 ORDER BY taken_at`, [key]);
  const pending = () => q(`SELECT company_code, to_char(found_at AT TIME ZONE 'UTC', ${STAMP}) AS found_at,
                                  to_char(since AT TIME ZONE 'UTC', ${STAMP}) AS since, attempts, last_error, drops
                           FROM list_alerts_pending ORDER BY found_at`);

  console.log('\n[the first run copies everything but the heartbeat and the caches]');
  {
    const out = await runAt('2026-09-01T09:45:00Z');
    assert('three records copied', out.backup.stored === 3, JSON.stringify(out.backup));
    assert('presence is not copied', (await copies('FORCECORP:fct_presence')).length === 0);
    assert('nor are the assistants\' caches', (await copies('FORCECORP:fct_ai_sched_p1_2026-09-01')).length === 0
      && (await copies('FORCECORP:fct_scheduler_ai_2026-09-01_abc')).length === 0);
    const counts = await q(`SELECT measure, n FROM list_counts WHERE company_code = 'FORCECORP' ORDER BY measure`);
    const m = Object.fromEntries(counts.map(r => [r.measure, r.n]));
    assert('the lists inside fct_lists are counted', m['fct_lists.employees'] === 3 && m['fct_lists.equipment'] === 2 && m['fct_lists.suppliers'] === 0,
      JSON.stringify(m));
    assert('array records and daily rows are counted', m['fct_cost_rows'] === 8 && m['daily_tracking.turf'] === 5);
    assert('one job\'s own record, presence and the caches are not', !Object.keys(m).some(k => /fct_project_|presence|_ai_/.test(k)));
    const stamps = await q(`SELECT DISTINCT to_char(taken_at AT TIME ZONE 'UTC', ${STAMP}) AS t FROM app_data_snapshots
                            UNION SELECT DISTINCT to_char(taken_at AT TIME ZONE 'UTC', ${STAMP}) FROM list_counts`);
    assert('the copy and the counts carry the run\'s one stamp', stamps.length === 1 && stamps[0].t === out.at && out.at === '2026-09-01T09:45:00Z',
      JSON.stringify(stamps));
    assert('no earlier run, no alert', out.alerts.length === 0 && emails.length === 0);
  }

  console.log('\n[an unchanged run stores nothing]');
  {
    const out = await runAt('2026-09-02T09:45:00Z');
    assert('nothing new to copy', out.backup.stored === 0 && out.backup.gone === 0, JSON.stringify(out.backup));
    assert('and nothing to report', out.alerts.length === 0 && out.errors.length === 0, JSON.stringify(out.errors));
  }

  console.log('\n[the wipe, and the next morning]');
  {
    await put('FORCECORP:fct_lists', WIPED);
    const out = await runAt('2026-09-03T09:45:00Z');
    assert('the changed record is copied', out.backup.stored === 1);
    const a = out.alerts[0];
    assert('the check finds it, against the run before', a && a.company === 'FORCECORP' && a.since === '2026-09-02T09:45:00Z', JSON.stringify(out.alerts));
    const drops = a ? Object.fromEntries(a.drops.map(d => [d.measure, `${d.before}->${d.after}`])) : {};
    assert('employees and equipment both reported', drops['fct_lists.employees'] === '3->0' && drops['fct_lists.equipment'] === '2->0',
      JSON.stringify(drops));
    assert('one email, to the configured list', emails.length === 1 && emails[0].to[0] === 'ops@forcecorp.test');

    // Run the restore exactly as the email gives it.
    const restores = restoresIn(emails[0].html);
    assert('the email carries one restore, a preview and a write', restores.length === 1 && restores[0].length === 2, JSON.stringify(restores));
    const preview = await q(restores[0][0]);
    assert('its preview shows the full list', preview.length === 1 && preview[0].value.employees.length === 3);
    await q(restores[0][1]);
    const back = await get('FORCECORP:fct_lists');
    assert('and running it puts the list back', back.employees.length === 3 && back.equipment[1].unit_cost === 65
      && back.employees[0].prevailing_rate === 52.1);
  }

  console.log('\n[a second run the same day]');
  {
    await put('FORCECORP:fct_cost_rows', Array.from({ length: 9 }, (_, i) => ({ id: i })));
    const out = await runAt('2026-09-03T14:00:00Z');
    assert('copies what changed since the first, the restored list included', out.backup.stored === 2, JSON.stringify(out.backup));
    const lists = await copies('FORCECORP:fct_lists');
    assert('and keeps the first run\'s copy as it was', lists.map(r => `${r.t}:${r.value.employees.length}`).join(' ')
      === '2026-09-01T09:45:00Z:3 2026-09-03T09:45:00Z:0 2026-09-03T14:00:00Z:3', lists.map(r => r.t).join(' '));
    assert('with the list back, the rerun sends nothing more', emails.length === 1 && out.alerts.length === 0, JSON.stringify(out.alerts));
  }

  console.log('\n[entries added between two runs are in the copy the alert restores]');
  {
    await runAt('2026-09-04T09:45:00Z');
    await put('FORCECORP:fct_lists', { ...LISTS, employees: [...LISTS.employees, ...people(10)] });
    await runAt('2026-09-04T16:30:00Z');            // a run by hand, later the same day
    await put('FORCECORP:fct_lists', { ...LISTS, employees: [] });
    const sent = emails.length;
    const out = await runAt('2026-09-05T09:45:00Z');
    const a = out.alerts[0];
    const d = a && a.drops.find(x => x.measure === 'fct_lists.employees');
    assert('the alert compares with the later run', d && d.before === 13 && d.after === 0 && a.since === '2026-09-04T16:30:00Z',
      JSON.stringify(out.alerts));
    const restores = restoresIn(emails[sent].html);
    await q(restores[0][1]);
    assert('and its restore brings back all thirteen, not the morning\'s three',
      (await get('FORCECORP:fct_lists')).employees.length === 13);
  }

  console.log('\n[a record deleted outright]');
  {
    await put('FORCECORP:fct_inventory', [{ id: 1 }, { id: 2 }, { id: 3 }]);
    await runAt('2026-09-06T09:45:00Z');
    await q(`DELETE FROM app_data WHERE key = 'FORCECORP:fct_inventory'`);
    const sent = emails.length;
    const out = await runAt('2026-09-07T09:45:00Z');
    const d = out.alerts[0] && out.alerts[0].drops.find(x => x.measure === 'fct_inventory');
    assert('is reported as emptied', d && d.before === 3 && d.after === 0, JSON.stringify(out.alerts));
    const inv = await copies('FORCECORP:fct_inventory');
    assert('its deletion is recorded as a copy of its own', out.backup.gone === 1
      && inv.length === 2 && inv[1].value_hash === 'deleted' && inv[1].value === null && inv[1].t === out.at, JSON.stringify(inv));
    const again = await runAt('2026-09-07T11:00:00Z');
    assert('once', again.backup.gone === 0 && (await copies('FORCECORP:fct_inventory')).length === 2);
    await q(restoresIn(emails[sent].html)[0][1]);
    const back = await get('FORCECORP:fct_inventory');
    assert('and the email\'s restore puts it back', back && back.length === 3, JSON.stringify(back));
    // A restore pointed at a moment after the deletion finds only the marker,
    // and writes nothing rather than an empty record.
    await q(`DELETE FROM app_data WHERE key = 'FORCECORP:fct_inventory'`);
    const late = B.restoreSql('FORCECORP', 'fct_inventory', '2026-09-07T10:00:00Z')
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(x => x.trim()).filter(Boolean);
    await q(late[1]);
    assert('a restore to a moment the record did not exist writes nothing', (await get('FORCECORP:fct_inventory')) === undefined);
    await q(restoresIn(emails[sent].html)[0][1]);
  }

  console.log('\n[an alert that cannot be sent is sent by a later run]');
  {
    await q(`INSERT INTO companies (code, name) VALUES ('EMPTYCO', 'Empty Co') ON CONFLICT (code) DO NOTHING`);
    await put('FORCECORP:fct_crm_people', Array.from({ length: 10 }, (_, i) => ({ id: i })));
    await put('EMPTYCO:fct_cost_rows', [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    const first = await runAt('2026-09-08T09:45:00Z');
    assert('the restored record is copied again', first.backup.stored >= 1
      && (await copies('FORCECORP:fct_inventory')).slice(-1)[0].value.length === 3);

    await put('FORCECORP:fct_crm_people', [{ id: 0 }, { id: 1 }]);
    const sent = emails.length;
    const failedRun = await runAt('2026-09-09T09:45:00Z', { failSend: true });
    assert('the drop is found', failedRun.alerts.some(a => a.company === 'FORCECORP'));
    assert('the failed send is reported', failedRun.errors.some(e => e.step === 'email' && /provider unavailable/.test(e.error)));
    const kept = await pending();
    assert('and the alert is kept, pointing at the fuller run', kept.length === 1 && kept[0].company_code === 'FORCECORP'
      && kept[0].found_at === '2026-09-09T09:45:00Z' && kept[0].since === '2026-09-08T09:45:00Z' && kept[0].attempts === 1
      && kept[0].drops[0].measure === 'fct_crm_people', JSON.stringify(kept));
    assert('a failed send is not a failed backup', failedRun.failed === false);

    // Meanwhile a whole company's data goes.
    await q(`DELETE FROM app_data WHERE key = 'EMPTYCO:fct_cost_rows'`);
    const next = await runAt('2026-09-10T09:45:00Z');
    assert('the next run does not find the same drop again', !next.alerts.some(a => a.company === 'FORCECORP'), JSON.stringify(next.alerts));
    const ec = next.alerts.find(a => a.company === 'EMPTYCO');
    assert('a company with every list gone is reported', ec && ec.drops[0].measure === 'fct_cost_rows' && ec.drops[0].after === 0);
    const late = emails.slice(sent).find(m => /Force Corp/.test(m.subject));
    assert('the kept alert goes out, marked late', late && /\(found 2026-09-09\)/.test(late.subject), emails.slice(sent).map(m => m.subject).join(' | '));
    assert('both emails, and nothing is left waiting', emails.length === sent + 2 && (await pending()).length === 0 && next.errors.length === 0,
      JSON.stringify(next.errors));
    await q(restoresIn(late.html)[0][1]);
    assert('the late alert\'s restore brings back the fuller list', (await get('FORCECORP:fct_crm_people')).length === 10);

    const rerun = await runAt('2026-09-10T12:00:00Z');
    assert('a second run the same day sends nothing again', rerun.alerts.length === 0 && emails.length === sent + 2,
      JSON.stringify(rerun.alerts));
    const after = await runAt('2026-09-11T09:45:00Z');
    assert('nor does the day after — the emptied company included', after.alerts.length === 0, JSON.stringify(after.alerts));
    const emptyRows = await q(`SELECT to_char(taken_at AT TIME ZONE 'UTC', ${STAMP}) AS t, measure, n FROM list_counts
                               WHERE company_code = 'EMPTYCO' ORDER BY taken_at`);
    assert('its emptied list is recorded as empty once, not every run',
      emptyRows.filter(r => r.n === 0).length === 1 && !emptyRows.some(r => r.t > '2026-09-10T09:45:00Z'), JSON.stringify(emptyRows));
  }

  console.log('\n[a list emptied between two runs on the same day]');
  {
    await put('FORCECORP:fct_crm_companies', Array.from({ length: 8 }, (_, i) => ({ id: i })));
    await runAt('2026-09-12T09:45:00Z');
    await put('FORCECORP:fct_crm_companies', []);
    const sent = emails.length;
    const rerun = await runAt('2026-09-12T15:00:00Z');
    const fc = rerun.alerts.find(a => a.company === 'FORCECORP');
    const cos = fc && fc.drops.find(x => x.measure === 'fct_crm_companies');
    assert('is found by the second run, against the first', cos && cos.before === 8 && cos.after === 0 && fc.since === '2026-09-12T09:45:00Z',
      JSON.stringify(rerun.alerts));
    await q(restoresIn(emails[sent].html)[0][1]);
    assert('and the email\'s restore puts back the full list, not the empty one',
      (await get('FORCECORP:fct_crm_companies')).length === 8);
  }

  console.log('\n[an alert that can never be sent]');
  {
    await put('FORCECORP:fct_quarry_daily', Array.from({ length: 6 }, (_, i) => ({ id: i })));
    await runAt('2026-09-13T09:45:00Z');
    await put('FORCECORP:fct_quarry_daily', []);
    let out;
    for (let day = 14; day < 14 + B.MAX_SEND_ATTEMPTS; day++) {
      out = await runAt(`2026-09-${day}T09:45:00Z`, { failSend: true });
      if (day === 14 + B.MAX_SEND_ATTEMPTS - 2) {
        const kept = await pending();
        assert(`is tried on every run, ${B.MAX_SEND_ATTEMPTS - 1} tries in`, kept.length === 1 && kept[0].attempts === B.MAX_SEND_ATTEMPTS - 1
          && kept[0].last_error === 'provider unavailable', JSON.stringify(kept));
      }
    }
    assert(`is given up on its ${B.MAX_SEND_ATTEMPTS}th try, and says so`, (await pending()).length === 0
      && out.errors.some(e => /gave up on the 2026-09-14 09:45 UTC alert after 7 attempts/.test(e.error)), JSON.stringify(out.errors));
    const counts = await q(`SELECT n FROM list_counts WHERE company_code = 'FORCECORP' AND measure = 'fct_quarry_daily' ORDER BY taken_at DESC LIMIT 1`);
    assert('while the list stays counted as it is', counts[0] && counts[0].n === 0);
  }

  console.log('\n[thirty days on]');
  {
    const out = await runAt('2026-10-15T09:45:00Z');
    assert('older copies are pruned', out.backup.pruned > 0, JSON.stringify(out.backup));
    const lists = await copies('FORCECORP:fct_lists');
    assert('but each record keeps its newest copy from before the window',
      lists.length === 1 && lists[0].t === '2026-09-06T09:45:00Z' && lists[0].value.employees.length === 13, JSON.stringify(lists.map(r => r.t)));
    const asOf = await q(`SELECT value FROM app_data_snapshots WHERE key = 'FORCECORP:fct_lists'
                          AND taken_at <= TIMESTAMPTZ '2026-09-25T00:00:00Z' ORDER BY taken_at DESC LIMIT 1`);
    assert('so a moment inside the window still resolves', asOf.length === 1 && asOf[0].value.employees.length === 13);
    assert('a record deleted before the window leaves nothing behind', (await copies('EMPTYCO:fct_cost_rows')).length === 0);
    const inv = await copies('FORCECORP:fct_inventory');
    assert('one deleted and put back keeps only its value', inv.length === 1 && inv[0].value.length === 3, JSON.stringify(inv.map(r => r.value_hash)));
    assert('and the run is clean', out.errors.length === 0 && out.failed === false, JSON.stringify(out.errors));
  }

  return { passed, failed };
}

module.exports = { run, makeSql, schemaStatements };

if (require.main === module) {
  const { Client } = require('pg');
  const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
  const dbName = (URL.split('/').pop() || '').split('?')[0];
  if (!/test/i.test(dbName)) {
    console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
    console.error('This script empties tables. Point PG_TEST_URL at a scratch database.');
    process.exit(1);
  }
  const client = new Client({ connectionString: URL });
  client.connect()
    .then(() => run(client))
    .then(({ passed, failed }) => {
      console.log(`\n${passed} passed, ${failed} failed`);
      return client.end().then(() => process.exit(failed ? 1 : 0));
    })
    .catch(err => { console.error(err.message); process.exit(1); });
}
