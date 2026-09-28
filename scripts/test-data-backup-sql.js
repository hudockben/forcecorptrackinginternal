#!/usr/bin/env node
'use strict';
/**
 * SQL-level test for the nightly backup and the morning check.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-data-backup-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * DESTRUCTIVE: empties app_data, app_data_backups, data_watch_counts and
 * daily_tracking. It refuses to run against a database whose name doesn't
 * look like a test database.
 *
 * scripts/test-data-backup.js pins the decisions around the SQL. This one runs
 * the SQL itself — the tables straight out of neon-schema.sql and the real
 * api/lib/data-backup.js — through a week that includes this September's
 * incident: the turf lists saved empty, noticed the next morning, and put back
 * by running the restore the alert email carries.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const B = require(path.join(ROOT, 'api', 'lib', 'data-backup'));

/** The statements neon-schema.sql holds for these two tables, split the way scripts/run-schema.js splits them. */
function schemaStatements() {
  return fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean)
    .filter(s => /app_data_backups|data_watch_counts/.test(s));
}

/** neon-serverless' tagged template over any client with query(text, values) → { rows }. */
function makeSql(client) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return client.query(text, values).then(r => r.rows);
  };
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
  await q(`CREATE TABLE IF NOT EXISTS app_data (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS daily_tracking (id SERIAL PRIMARY KEY, date DATE NOT NULL,
             company_code TEXT NOT NULL DEFAULT '', division TEXT NOT NULL DEFAULT 'turf')`);
  for (const stmt of schemaStatements()) await q(stmt);
  await q(`TRUNCATE app_data, app_data_backups, data_watch_counts`);
  await q(`DELETE FROM daily_tracking`);
  await q(`INSERT INTO companies (code, name) VALUES ('FORCECORP', 'Force Corp') ON CONFLICT (code) DO NOTHING`);

  const put = (key, value) => q(`
    INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);
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
  for (let i = 0; i < 5; i++) await q(`INSERT INTO daily_tracking (company_code, division, date) VALUES ('FORCECORP', 'turf', '2026-09-01')`);

  const emails = [];
  const night = (day) => B.runDataBackup(sql, {
    day, recipients: ['ops@forcecorp.test'],
    send: async (msg) => { emails.push({ day, ...msg }); return { ok: true }; },
  });
  const copies = key => q(`SELECT to_char(backup_date, 'YYYY-MM-DD') AS d, value FROM app_data_backups WHERE key = $1 ORDER BY backup_date`, [key]);

  console.log('\n[the first night copies everything but the heartbeat]');
  {
    const out = await night('2026-09-01');
    assert('three records copied', out.backup.stored === 3, JSON.stringify(out.backup));
    assert('presence is not copied', (await copies('FORCECORP:fct_presence')).length === 0);
    const counts = await q(`SELECT measure, n FROM data_watch_counts WHERE company_code = 'FORCECORP' ORDER BY measure`);
    const m = Object.fromEntries(counts.map(r => [r.measure, r.n]));
    assert('the lists inside fct_lists are counted', m['fct_lists.employees'] === 3 && m['fct_lists.equipment'] === 2 && m['fct_lists.suppliers'] === 0,
      JSON.stringify(m));
    assert('array records and daily rows are counted', m['fct_cost_rows'] === 8 && m['daily_tracking.turf'] === 5);
    assert('one job\'s own record and presence are not', !Object.keys(m).some(k => /fct_project_|presence/.test(k)));
    assert('no earlier night, no alert', out.alerts.length === 0 && emails.length === 0);
  }

  console.log('\n[an unchanged night stores nothing]');
  {
    const out = await night('2026-09-02');
    assert('nothing new to copy', out.backup.stored === 0, JSON.stringify(out.backup));
    assert('and nothing to report', out.alerts.length === 0);
  }

  console.log('\n[the wipe, and the next morning]');
  {
    await put('FORCECORP:fct_lists', WIPED);
    const out = await night('2026-09-03');
    assert('the changed record is copied', out.backup.stored === 1);
    const a = out.alerts[0];
    assert('the check finds it', a && a.company === 'FORCECORP' && a.since === '2026-09-02', JSON.stringify(out.alerts));
    const drops = a ? Object.fromEntries(a.drops.map(d => [d.measure, `${d.before}->${d.after}`])) : {};
    assert('employees and equipment both reported', drops['fct_lists.employees'] === '3->0' && drops['fct_lists.equipment'] === '2->0',
      JSON.stringify(drops));
    assert('one email, to the configured list', emails.length === 1 && emails[0].to[0] === 'ops@forcecorp.test');

    // Run the restore exactly as the email gives it.
    const restore = B.restoreSql('FORCECORP', 'fct_lists.employees', a.since);
    assert('the email carries that restore', emails[0].html.includes('UPDATE app_data SET updated_at = NOW(), value = ('));
    const stmts = restore.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean);
    const preview = await q(stmts[0]);
    assert('its preview shows the full list', preview.length === 1 && preview[0].value.employees.length === 3);
    await q(stmts[1]);
    const back = (await q(`SELECT value FROM app_data WHERE key = 'FORCECORP:fct_lists'`))[0].value;
    assert('and running it puts the list back', back.employees.length === 3 && back.equipment[1].unit_cost === 65
      && back.employees[0].prevailing_rate === 52.1);
  }

  console.log('\n[a second run the same night updates that night\'s copy]');
  {
    await put('FORCECORP:fct_cost_rows', Array.from({ length: 9 }, (_, i) => ({ id: i })));
    const out = await night('2026-09-03');
    const rows = (await copies('FORCECORP:fct_cost_rows')).filter(r => r.d === '2026-09-03');
    assert('one copy for the night, holding the later value', rows.length === 1 && rows[0].value.length === 9, JSON.stringify(rows.map(r => r.value.length)));
    assert('the restored lists are copied too', (await copies('FORCECORP:fct_lists')).filter(r => r.d === '2026-09-03')[0].value.employees.length === 3);
    assert('with the list back, the rerun sends nothing more', emails.length === 1 && out.alerts.length === 0, JSON.stringify(out.alerts));
  }

  console.log('\n[a record deleted outright]');
  {
    await put('FORCECORP:fct_inventory', [{ id: 1 }, { id: 2 }, { id: 3 }]);
    await night('2026-09-04');
    await q(`DELETE FROM app_data WHERE key = 'FORCECORP:fct_inventory'`);
    const out = await night('2026-09-05');
    const d = out.alerts[0] && out.alerts[0].drops.find(x => x.measure === 'fct_inventory');
    assert('is reported as emptied', d && d.before === 3 && d.after === 0, JSON.stringify(out.alerts));
  }

  console.log('\n[thirty days on]');
  {
    const out = await night('2026-10-10');
    const lists = await copies('FORCECORP:fct_lists');
    assert('older copies are pruned', out.backup.pruned > 0, JSON.stringify(out.backup));
    assert('but each record keeps its newest copy from before the window',
      lists.length === 1 && lists[0].d === '2026-09-03' && lists[0].value.employees.length === 3, JSON.stringify(lists.map(r => r.d)));
    const asOf = await q(`SELECT value FROM app_data_backups WHERE key = 'FORCECORP:fct_lists'
                          AND backup_date <= DATE '2026-09-20' ORDER BY backup_date DESC LIMIT 1`);
    assert('so a night inside the window still resolves', asOf.length === 1 && asOf[0].value.employees.length === 3);
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
