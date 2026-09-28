#!/usr/bin/env node
'use strict';
/**
 * The nightly backup and the morning check, without a database.
 *
 * Run: node scripts/test-data-backup.js
 *
 * scripts/test-data-backup-sql.js runs the SQL against a real PostgreSQL. This
 * one pins the decisions around it, where being quietly wrong looks exactly
 * like being right:
 *
 *   Which lists are watched. A record that shrinks as a matter of course (one
 *   job's own record, a schedule rolling forward) must not raise an alarm, or
 *   the alarm becomes an email nobody opens — and the one that matters is
 *   missed with the rest.
 *
 *   What counts as a drop. An emptied list, or one that lost half of six or
 *   more. Two of three suppliers removed is an edit, not an incident.
 *
 *   The email. It has to go to the configured addresses, say which lists and
 *   by how much, carry a restore that names the right record and night, and
 *   escape everything it quotes.
 *
 *   The run. The backup happens before anything that can fail, and one
 *   company's email failure does not stop the others.
 */

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const B = require(path.join(ROOT, 'api', 'lib', 'data-backup'));

/** A tagged-template sql stub: answers by matching the statement's text. */
function scriptedSql(answer) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    return Promise.resolve().then(() => answer(text, values));
  };
  sql.calls = calls;
  return sql;
}

(async () => {
  console.log('\n[which lists are watched]');
  for (const m of ['fct_lists.employees', 'fct_lists.equipment', 'fct_cost_rows', 'fct_inventory',
                   'fct_paving_lists.suppliers', 'fct_kiewit_cost_rows', 'fct_crm_companies',
                   'fct_purchase_orders:turf', 'fct_projects_index.ids', 'dust_other_billing_rows',
                   'fct_quarry_daily', 'fct_intercompany_billing_entries', 'daily_tracking.turf']) {
    assert(`${m} is watched`, B.isWatched(m));
  }
  for (const m of ['fct_presence', 'fct_project_abc.bidItems', 'fct_paving_project_x.assigned_employees',
                   'fct_kiewit_project_y', 'fct_conschedule_templates', 'fct_kiewit_conschedule_p1',
                   'fct_scheduler_assignments', 'fct_trucking_schedule', 'fct_trucking_labor_schedule',
                   'fct_crm_news.items', 'fct_trend_x', 'fct_lucius_y', 'fct_intercompany_removed_entries']) {
    assert(`${m} is not`, !B.isWatched(m));
  }
  assert('the projects index is not mistaken for a project record', B.isWatched('fct_projects_index'));

  console.log('\n[what counts as a drop]');
  {
    const prev = new Map([
      ['fct_lists.employees', 42], ['fct_lists.equipment', 17], ['fct_lists.suppliers', 3],
      ['fct_cost_rows', 120], ['fct_inventory', 10], ['fct_lists.job_classes', 1],
      ['fct_crm_people', 8], ['fct_lists.field_types', 2], ['daily_tracking.turf', 900],
    ]);
    const now = new Map([
      ['fct_lists.employees', 0],     // emptied — this week's incident
      ['fct_lists.equipment', 0],
      ['fct_lists.suppliers', 1],     // 3 → 1: an edit
      ['fct_cost_rows', 1],           // 120 → 1: the one-row save over the list
      ['fct_inventory', 6],           // 10 → 6: not half
      ['fct_lists.job_classes', 0],   // 1 → 0: too small to call
      ['fct_crm_people', 4],          // 8 → 4: exactly half
      // fct_lists.field_types missing tonight: the array is gone
      ['daily_tracking.turf', 901],
      ['fct_new_list', 3],            // new tonight: never reported
    ]);
    const drops = B.findDrops(prev, now);
    const got = Object.fromEntries(drops.map(d => [d.measure, `${d.before}->${d.after}`]));
    assert('an emptied list is reported', got['fct_lists.employees'] === '42->0' && got['fct_lists.equipment'] === '17->0');
    assert('a list saved over with one row is reported', got['fct_cost_rows'] === '120->1');
    assert('losing exactly half is reported', got['fct_crm_people'] === '8->4');
    assert('a list missing tonight counts as emptied', got['fct_lists.field_types'] === '2->0');
    assert('small edits are not', !got['fct_lists.suppliers'] && !got['fct_inventory'] && !got['fct_lists.job_classes']);
    assert('growth and new lists are not', !got['daily_tracking.turf'] && !got['fct_new_list']);
    assert('biggest loss first', drops[0].measure === 'fct_cost_rows', drops.map(d => d.measure).join(','));
  }

  console.log('\n[labels]');
  assert('turf list', B.labelFor('fct_lists.employees') === 'Turf: lists › employees', B.labelFor('fct_lists.employees'));
  assert('paving rows', B.labelFor('fct_paving_cost_rows') === 'Paving: cost rows', B.labelFor('fct_paving_cost_rows'));
  assert('crm', B.labelFor('fct_crm_people') === 'Turf CRM: people', B.labelFor('fct_crm_people'));
  assert('purchase orders by division', B.labelFor('fct_purchase_orders:paving') === 'Turf: purchase orders (paving)', B.labelFor('fct_purchase_orders:paving'));
  assert('dust', B.labelFor('dust_other_billing_rows') === 'Dust: other billing rows', B.labelFor('dust_other_billing_rows'));
  assert('daily rows', B.labelFor('daily_tracking.kiewit') === 'Daily tracking rows (kiewit)');

  console.log('\n[restore SQL]');
  {
    const s = B.restoreSql('FORCECORP', 'fct_lists.employees', '2026-09-24');
    assert('names the whole record, not the array', /key = 'FORCECORP:fct_lists'/.test(s) && !/employees'/.test(s));
    assert('takes the newest copy on or before that night', /backup_date <= DATE '2026-09-24'\s+ORDER BY backup_date DESC LIMIT 1/.test(s));
    assert('shows the copy before it writes', s.indexOf('SELECT backup_date, value') < s.indexOf('UPDATE app_data'));
    const q = B.restoreSql("O'CO", "fct_x", '2026-09-24');
    assert('a quote in a key cannot break out of the string', /key = 'O''CO:fct_x'/.test(q));
  }

  console.log('\n[recipients]');
  assert('commas, semicolons and spaces all separate', JSON.stringify(B.alertRecipients('a@x.com, B@x.com;c@x.com  d@x.com'))
    === JSON.stringify(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']));
  assert('duplicates and junk are dropped', JSON.stringify(B.alertRecipients('a@x.com,A@x.com,not-an-email,,')) === '["a@x.com"]');
  assert('unset is nobody', B.alertRecipients(undefined).length === 0);

  console.log('\n[the email]');
  {
    const { subject, html } = B.buildAlert({
      companyCode: 'FORCECORP', companyName: 'Force Corp <script>', prevDay: '2026-09-24', day: '2026-09-25',
      drops: [{ measure: 'fct_lists.employees', before: 42, after: 0 }, { measure: 'fct_lists.equipment', before: 17, after: 0 },
              { measure: 'daily_tracking.turf', before: 900, after: 3 }],
    });
    assert('the subject says how many and for whom', /3 lists shrank overnight — Force Corp/.test(subject), subject);
    assert('each list with its before and after', /Turf: lists › employees/.test(html) && />42</.test(html) && />17</.test(html));
    assert('one restore for the one record both arrays live in', (html.match(/UPDATE app_data/g) || []).length === 1);
    assert('restores to the last fuller night', /DATE &#39;2026-09-24&#39;/.test(html));
    assert('daily rows are pointed at Neon, not at this backup', /Daily-tracking rows are not in this backup/.test(html));
    assert('nothing quoted is left unescaped', !/<script>/.test(html) && /Force Corp &lt;script&gt;/.test(html));
  }

  console.log('\n[the run]');
  {
    // Company A lost its employees; company B's email fails; company C has no
    // earlier night to compare with.
    const sends = [];
    const order = [];
    const sql = scriptedSql((text, values) => {
      if (/^INSERT INTO app_data_backups/.test(text)) { order.push('backup'); return [{ key: 'A:fct_lists' }]; }
      if (/^DELETE FROM app_data_backups/.test(text)) { order.push('prune'); return []; }
      if (/^SELECT split_part/.test(text)) {
        order.push('count');
        return [
          { company_code: 'A', measure: 'fct_lists.employees', n: 0 },
          { company_code: 'A', measure: 'fct_project_p1.bidItems', n: 0 },   // unwatched: dropped
          { company_code: 'B', measure: 'fct_cost_rows', n: 1 },
          { company_code: 'C', measure: 'fct_cost_rows', n: 5 },
        ];
      }
      if (/^INSERT INTO data_watch_counts/.test(text)) { order.push('record'); return []; }
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }, { code: 'B', name: 'Beta' }, { code: 'C', name: 'Gamma' }];
      if (/FROM data_watch_counts WHERE company_code/.test(text)) {
        const code = values[0];
        if (code === 'A') return [{ day: '2026-09-24', measure: 'fct_lists.employees', n: 42 },
                                  { day: '2026-09-24', measure: 'fct_project_p1.bidItems', n: 9 }];
        if (code === 'B') return [{ day: '2026-09-24', measure: 'fct_cost_rows', n: 120 }];
        return [];
      }
      if (/^DELETE FROM data_watch_counts/.test(text)) return [];
      throw new Error('unexpected statement: ' + text.slice(0, 60));
    });
    const out = await B.runDataBackup(sql, {
      day: '2026-09-25', recipients: ['ops@x.com'],
      send: async (msg) => { sends.push(msg); return /Beta/.test(msg.subject) ? { ok: false, error: 'bounced' } : { ok: true }; },
    });
    assert('the backup runs before anything else', order[0] === 'backup' && order.indexOf('count') > order.indexOf('backup'), order.join(','));
    const recorded = sql.calls.find(c => /^INSERT INTO data_watch_counts/.test(c.text));
    assert('only watched lists are recorded', recorded && !recorded.values[1].includes('fct_project_p1.bidItems'), recorded && JSON.stringify(recorded.values[1]));
    assert('both drops are found', out.alerts.map(a => a.company).sort().join(',') === 'A,B', JSON.stringify(out.alerts));
    assert('an unwatched list never alerts, even from old counts', !out.alerts.some(a => a.drops.some(d => /fct_project_/.test(d.measure))));
    assert('each company gets its own email, to the configured list', sends.length === 2 && sends.every(s => s.to[0] === 'ops@x.com'));
    assert('a failed send is reported, and did not stop the other', out.emailed === 1 && out.errors.some(e => e.company === 'B' && /bounced/.test(e.error)));
    assert('a company with no earlier night is not compared', !out.alerts.some(a => a.company === 'C'));
  }
  {
    const sql = scriptedSql(text => {
      if (/FROM data_watch_counts WHERE company_code/.test(text)) return [{ day: '2026-09-24', measure: 'fct_cost_rows', n: 50 }];
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }];
      return [];
    });
    let sent = 0;
    const out = await B.runDataBackup(sql, { day: '2026-09-25', recipients: [], send: async () => { sent++; return { ok: true }; } });
    assert('with no recipients the drop is still found and reported', out.alerts.length === 1 && sent === 0
      && out.errors.some(e => /DATA_ALERT_EMAILS is not set/.test(e.error)));
    assert('a record gone entirely counts as emptied', out.alerts[0] && out.alerts[0].drops[0].after === 0);
  }

  console.log('\n[the cron endpoint]');
  {
    let ran = 0;
    const orig = Module._load;
    Module._load = function (req, parent) {
      if (req === '@neondatabase/serverless') return { neon: () => () => Promise.resolve([]) };
      if (req === '../lib/data-backup' && parent && /cron/.test(parent.filename)) {
        return { runDataBackup: async () => { ran++; return { day: 'd', backup: {}, measures: 0, alerts: [], emailed: 0, errors: [] }; } };
      }
      return orig.apply(this, arguments);
    };
    const handler = require(path.join(ROOT, 'api', 'cron', 'data-backup.js'));
    Module._load = orig;
    const call = (headers, method = 'GET') => new Promise(resolve => {
      const res = { status(c) { this.c = c; return this; }, json(b) { resolve({ code: this.c || 200, body: b }); } };
      handler({ method, headers }, res);
    });
    const env = { ...process.env };
    delete process.env.CRON_SECRET;
    process.env.DATABASE_URL = 'postgres://x';
    let r = await call({ authorization: 'Bearer anything' });
    assert('without CRON_SECRET it refuses to run', r.code === 503 && ran === 0);
    process.env.CRON_SECRET = 's3cret';
    r = await call({});
    assert('without the secret, 401', r.code === 401 && ran === 0);
    r = await call({ authorization: 'Bearer wrong' });
    assert('with the wrong secret, 401', r.code === 401 && ran === 0);
    r = await call({ authorization: 'Bearer s3cret' });
    assert('with it, the night runs', r.code === 200 && r.body.ok === true && ran === 1);
    r = await call({ authorization: 'Bearer s3cret' }, 'DELETE');
    assert('other methods are refused', r.code === 405);
    process.env = env;
  }
  {
    const vercel = require(path.join(ROOT, 'vercel.json'));
    const cron = (vercel.crons || []).find(c => c.path === '/api/cron/data-backup');
    assert('it is scheduled daily', cron && /^\d+ \d+ \* \* \*$/.test(cron.schedule), cron && cron.schedule);
    assert('with room to run', vercel.functions['api/cron/data-backup.js'] && vercel.functions['api/cron/data-backup.js'].maxDuration >= 60);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
