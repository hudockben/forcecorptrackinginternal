#!/usr/bin/env node
'use strict';
/**
 * The nightly backup and the check, without a database.
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
 *   by how much, carry a restore that names the right record and run, and
 *   escape everything it quotes.
 *
 *   The run. The backup happens before anything that can fail, its copy,
 *   counts and alerts share one stamp, one company's email failure does not
 *   stop the others, and an alert that cannot be sent is kept and tried
 *   again rather than lost.
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
                   'fct_crm_news.items', 'fct_trend_x', 'fct_lucius_y', 'fct_intercompany_removed_entries',
                   'fct_ai_sched_p1_2026-09-28.recommendations', 'fct_scheduler_ai_2026-09-28_abc']) {
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

  console.log('\n[run stamps]');
  assert('a run is stamped to the second', B.runInstant(new Date('2026-09-25T09:45:03.789Z')) === '2026-09-25T09:45:03Z');
  assert('shifted by whole days', B.shiftDays('2026-09-25T09:45:03Z', -30) === '2026-08-26T09:45:03Z');
  assert('and shown to people in UTC', B.human('2026-09-25T09:45:03Z') === '2026-09-25 09:45 UTC');

  console.log('\n[restore SQL]');
  {
    const s = B.restoreSql('FORCECORP', 'fct_lists.employees', '2026-09-24T09:45:00Z');
    assert('names the whole record, not the array', /key = 'FORCECORP:fct_lists'/.test(s) && !/employees'/.test(s));
    assert('takes the newest copy at or before the fuller run',
      /taken_at <= TIMESTAMPTZ '2026-09-24T09:45:00Z'\s+ORDER BY taken_at DESC LIMIT 1/.test(s));
    assert('shows the copy before it writes', s.indexOf('SELECT taken_at, value') < s.indexOf('INSERT INTO app_data'));
    assert('puts back a record deleted outright, not only an emptied one',
      /INSERT INTO app_data \(key, value, updated_at\)[\s\S]*ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value/.test(s));
    assert('never writes back a copy that only says the record was deleted', /\) latest WHERE value_hash <> 'deleted'/.test(s));
    const q = B.restoreSql("O'CO", 'fct_x', '2026-09-24T09:45:00Z');
    assert('a quote in a key cannot break out of the string', /key = 'O''CO:fct_x'/.test(q));
  }

  console.log('\n[recipients]');
  assert('commas, semicolons and spaces all separate', JSON.stringify(B.alertRecipients('a@x.com, B@x.com;c@x.com  d@x.com'))
    === JSON.stringify(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']));
  assert('duplicates and junk are dropped', JSON.stringify(B.alertRecipients('a@x.com,A@x.com,not-an-email,,')) === '["a@x.com"]');
  assert('unset is nobody', B.alertRecipients(undefined).length === 0);

  console.log('\n[the email]');
  {
    const drops = [{ measure: 'fct_lists.employees', before: 42, after: 0 }, { measure: 'fct_lists.equipment', before: 17, after: 0 },
                   { measure: 'daily_tracking.turf', before: 900, after: 3 }];
    const { subject, html } = B.buildAlert({
      companyCode: 'FORCECORP', companyName: 'Force Corp <script>', since: '2026-09-24T09:45:00Z', at: '2026-09-25T09:45:00Z', drops,
    });
    assert('the subject says how many and for whom', /3 lists shrank — Force Corp/.test(subject), subject);
    assert('each list with its before and after', /Turf: lists › employees/.test(html) && />42</.test(html) && />17</.test(html));
    assert('under the two runs it compares', /2026-09-24 09:45 UTC<\/th>/.test(html) && /2026-09-25 09:45 UTC<\/th>/.test(html));
    assert('one restore for the one record both arrays live in', (html.match(/INSERT INTO app_data/g) || []).length === 1);
    assert('restores to the fuller run', /TIMESTAMPTZ &#39;2026-09-24T09:45:00Z&#39;/.test(html));
    assert('daily rows are pointed at Neon, not at this backup', /Daily-tracking rows are not in this backup/.test(html));
    assert('nothing quoted is left unescaped', !/<script>/.test(html) && /Force Corp &lt;script&gt;/.test(html));
    const late = B.buildAlert({ companyCode: 'FORCECORP', companyName: 'Force Corp', since: '2026-09-24T09:45:00Z', at: '2026-09-25T09:45:00Z', drops, late: true });
    assert('one sent late says when it was found', /\(found 2026-09-25\)$/.test(late.subject) && /comes late/.test(late.html), late.subject);
    assert('and still restores to the run it compared with', /TIMESTAMPTZ &#39;2026-09-24T09:45:00Z&#39;/.test(late.html));
  }

  console.log('\n[sending]');
  {
    const msg = { subject: 's', html: 'h' };
    assert('sent is null', await B.deliver(async () => ({ ok: true }), ['a@x.com'], msg) === null);
    assert('refused says why', await B.deliver(async () => ({ ok: false, error: 'bounced' }), ['a@x.com'], msg) === 'bounced');
    assert('a sender that throws says why', await B.deliver(async () => { throw new Error('socket hang up'); }, ['a@x.com'], msg) === 'socket hang up');
    let called = 0;
    assert('nobody to send to says so, without sending',
      await B.deliver(async () => { called++; return { ok: true }; }, [], msg) === 'DATA_ALERT_EMAILS is not set' && called === 0);
  }

  const NOW = new Date('2026-09-25T09:45:03.500Z');
  const AT = '2026-09-25T09:45:03Z';
  const PREV = '2026-09-24T09:45:00Z';

  console.log('\n[the run]');
  {
    // Company A lost its employees; company B's email fails; company C has no
    // earlier run to compare with.
    const sends = [];
    const order = [];
    const sql = scriptedSql((text, values) => {
      if (/^INSERT INTO app_data_snapshots .* SELECT a\.key/.test(text)) { order.push('backup'); return [{ key: 'A:fct_lists' }]; }
      if (/^INSERT INTO app_data_snapshots .* SELECT l\.key/.test(text)) { order.push('gone'); return []; }
      if (/^DELETE FROM app_data_snapshots/.test(text)) { order.push('prune'); return []; }
      if (/^SELECT split_part/.test(text)) {
        order.push('count');
        return [
          { company_code: 'A', measure: 'fct_lists.employees', n: 0 },
          { company_code: 'A', measure: 'fct_project_p1.bidItems', n: 0 },   // unwatched: dropped
          { company_code: 'B', measure: 'fct_cost_rows', n: 1 },
          { company_code: 'C', measure: 'fct_cost_rows', n: 5 },
        ];
      }
      if (/^INSERT INTO list_counts/.test(text)) { order.push('record'); return []; }
      if (/^INSERT INTO list_alerts_pending/.test(text)) { order.push('queue'); return []; }
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }, { code: 'B', name: 'Beta' }, { code: 'C', name: 'Gamma' }];
      if (/FROM list_counts WHERE company_code/.test(text)) {
        const code = values[1];
        if (code === 'A') return [{ at: PREV, measure: 'fct_lists.employees', n: 42 },
                                  { at: PREV, measure: 'fct_project_p1.bidItems', n: 9 }];
        if (code === 'B') return [{ at: PREV, measure: 'fct_cost_rows', n: 120 }];
        return [];
      }
      if (/FROM list_alerts_pending WHERE found_at/.test(text)) return [];
      if (/^DELETE FROM list_counts/.test(text)) return [];
      throw new Error('unexpected statement: ' + text.slice(0, 60));
    });
    const out = await B.runDataBackup(sql, {
      now: NOW, recipients: ['ops@x.com'],
      send: async (msg) => { sends.push(msg); return /Beta/.test(msg.subject) ? { ok: false, error: 'bounced' } : { ok: true }; },
    });
    assert('the backup runs before anything else', order[0] === 'backup' && order.indexOf('count') > order.indexOf('prune'), order.join(','));
    assert('the run is stamped to the second', out.at === AT, out.at);
    // Every statement that writes or compares uses the run's one stamp.
    const stamped = sql.calls.filter(c => /^INSERT INTO (app_data_snapshots|list_counts|list_alerts_pending)|FROM list_counts WHERE company_code|FROM list_alerts_pending WHERE found_at/.test(c.text));
    assert('its copy, its counts, its comparison and its alerts all carry that stamp',
      stamped.length >= 7 && stamped.every(c => c.values.includes(AT)), JSON.stringify(stamped.map(c => c.text.slice(0, 30))));
    assert('it compares with the run before it, not with itself',
      sql.calls.filter(c => /FROM list_counts WHERE company_code/.test(c.text)).every(c => /taken_at < \?::timestamptz/.test(c.text)));
    // Parameters of each recording: [at, companies, measures, counts].
    const recs = sql.calls.filter(c => /^INSERT INTO list_counts/.test(c.text));
    const recCompanies = recs.flatMap(c => c.values[1]), recMeasures = recs.flatMap(c => c.values[2]);
    assert('only watched lists are recorded', recMeasures.length > 0 && !recMeasures.includes('fct_project_p1.bidItems'),
      JSON.stringify(recMeasures));
    assert('every company checked takes this run as its baseline, so no drop is reported twice',
      ['A', 'B', 'C'].every(c => recCompanies.includes(c)), JSON.stringify(recCompanies));
    assert('both drops are found', out.alerts.map(a => a.company).sort().join(',') === 'A,B', JSON.stringify(out.alerts));
    assert('each points at the run it compared with', out.alerts.every(a => a.since === PREV));
    assert('an unwatched list never alerts, even from old counts', !out.alerts.some(a => a.drops.some(d => /fct_project_/.test(d.measure))));
    assert('each company gets its own email, to the configured list', sends.length === 2 && sends.every(s => s.to[0] === 'ops@x.com'));
    assert('a failed send is reported, and did not stop the other', out.emailed === 1 && out.errors.some(e => e.company === 'B' && /bounced/.test(e.error)));
    const queued = sql.calls.filter(c => /^INSERT INTO list_alerts_pending/.test(c.text));
    assert('the alert that could not be sent is kept, with the copy it points at',
      queued.length === 1 && queued[0].values[0] === 'B' && queued[0].values[1] === AT && queued[0].values[2] === PREV
        && JSON.parse(queued[0].values[3])[0].measure === 'fct_cost_rows' && queued[0].values[4] === 'bounced',
      queued[0] && JSON.stringify(queued[0].values));
    assert('and it is kept before the counts that would hide it are recorded', order.indexOf('queue') < order.lastIndexOf('record'));
    assert('a company with no earlier run is not compared', !out.alerts.some(a => a.company === 'C'));
    assert('a failed send alone is not a failed backup', out.failed === false && out.pending === 1);
  }
  {
    // The alert cannot even be kept: this run's counts are not recorded, so
    // the next run finds the same drop against the same baseline.
    const sql = scriptedSql(text => {
      if (/^SELECT split_part/.test(text)) return [{ company_code: 'A', measure: 'fct_cost_rows', n: 1 }];
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }];
      if (/FROM list_counts WHERE company_code/.test(text)) return [{ at: PREV, measure: 'fct_cost_rows', n: 40 }];
      if (/^INSERT INTO list_alerts_pending/.test(text)) throw new Error('relation "list_alerts_pending" does not exist');
      return [];
    });
    const sends = [];
    const out = await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'],
      send: async m => { sends.push(m); return /did not finish/.test(m.subject) ? { ok: true } : { ok: false, error: 'down' }; } });
    assert('an alert that can be neither sent nor kept leaves the baseline where it was',
      !sql.calls.some(c => /^INSERT INTO list_counts/.test(c.text)) && out.errors.some(e => e.step === 'queue'));
    assert('and is a failed run', out.failed === true && sends.some(m => /did not finish/.test(m.subject)));
  }
  {
    const sql = scriptedSql(text => {
      if (/FROM list_counts WHERE company_code/.test(text)) return [{ at: PREV, measure: 'fct_cost_rows', n: 50 }];
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }];
      return [];
    });
    let sent = 0;
    const out = await B.runDataBackup(sql, { now: NOW, recipients: [], send: async () => { sent++; return { ok: true }; } });
    assert('with no recipients the drop is still found and reported', out.alerts.length === 1 && sent === 0
      && out.errors.some(e => /DATA_ALERT_EMAILS is not set/.test(e.error)));
    assert('and kept for when they are set', sql.calls.some(c => /^INSERT INTO list_alerts_pending/.test(c.text)));
    assert('a record gone entirely counts as emptied', out.alerts[0] && out.alerts[0].drops[0].after === 0);
  }

  console.log('\n[alerts that earlier runs could not send]');
  {
    const MAX = B.MAX_SEND_ATTEMPTS;
    const waiting = [
      { company_code: 'A', found_at: '2026-09-24T09:45:00Z', since: '2026-09-23T09:45:00Z', attempts: 1,
        drops: [{ measure: 'fct_lists.employees', before: 42, after: 0 }] },
      { company_code: 'B', found_at: '2026-09-22T09:45:00Z', since: '2026-09-21T09:45:00Z', attempts: 3,
        drops: JSON.stringify([{ measure: 'fct_cost_rows', before: 120, after: 1 }]) },
      { company_code: 'C', found_at: '2026-09-18T09:45:00Z', since: '2026-09-17T09:45:00Z', attempts: MAX - 1,
        drops: [{ measure: 'fct_inventory', before: 30, after: 0 }] },
    ];
    const sends = [];
    const sql = scriptedSql(text => {
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }, { code: 'B', name: 'Beta' }, { code: 'C', name: 'Gamma' }];
      if (/FROM list_alerts_pending WHERE found_at/.test(text)) return waiting;
      return [];
    });
    const out = await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'],
      send: async m => { sends.push(m); return /Alpha/.test(m.subject) || /did not finish/.test(m.subject) ? { ok: true } : { ok: false, error: 'rate limited' }; } });
    const q = sql.calls.find(c => /FROM list_alerts_pending WHERE found_at/.test(c.text));
    assert('only alerts earlier runs found are tried', /found_at < \?::timestamptz/.test(q.text) && q.values.includes(AT));
    const alpha = sends.find(m => /Alpha/.test(m.subject));
    assert('one that goes through is sent late, as found', alpha && /\(found 2026-09-24\)/.test(alpha.subject)
      && /TIMESTAMPTZ &#39;2026-09-23T09:45:00Z&#39;/.test(alpha.html), alpha && alpha.subject);
    const del = sql.calls.filter(c => /^DELETE FROM list_alerts_pending/.test(c.text));
    const upd = sql.calls.filter(c => /^UPDATE list_alerts_pending/.test(c.text));
    assert('and is no longer kept', del.some(c => c.values[0] === 'A' && c.values[1] === '2026-09-24T09:45:00Z'));
    assert('one that fails again is kept, with its tries counted',
      upd.length === 1 && upd[0].values[0] === 4 && upd[0].values[1] === 'rate limited' && upd[0].values[2] === 'B',
      JSON.stringify(upd.map(c => c.values)));
    assert(`one that fails its ${MAX}th try is given up, and says so`,
      del.some(c => c.values[0] === 'C') && out.errors.some(e => e.company === 'C' && /gave up .* after 7 attempts: rate limited/.test(e.error)),
      JSON.stringify(out.errors));
    assert('the count of what is still waiting is right', out.pending === 1 && out.emailed === 1, `${out.pending} ${out.emailed}`);
    assert('a send that fails is not a failed backup', out.failed === false);
  }
  {
    const sql = scriptedSql(text => {
      if (/FROM list_alerts_pending WHERE found_at/.test(text)) throw new Error('connection reset');
      return [];
    });
    const sends = [];
    const out = await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'], send: async m => { sends.push(m); return { ok: true }; } });
    assert('a retry that cannot read the waiting alerts fails the run', out.failed === true
      && out.errors.some(e => e.step === 'retry') && sends.some(m => /did not finish/.test(m.subject)));
  }

  console.log('\n[a company with every list gone]');
  {
    const sql = scriptedSql(text => {
      if (/^SELECT split_part/.test(text)) return [];                 // nothing now
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }];
      if (/FROM list_counts WHERE company_code/.test(text))
        return [{ at: PREV, measure: 'fct_cost_rows', n: 50 }, { at: PREV, measure: 'fct_lists.employees', n: 9 }];
      return [];
    });
    const out = await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'], send: async () => ({ ok: true }) });
    const rec = sql.calls.find(c => /^INSERT INTO list_counts/.test(c.text));
    assert('is reported', out.alerts.length === 1 && out.alerts[0].drops.length === 2);
    assert('and recorded as empty, so the next run does not report it again',
      rec && JSON.stringify(rec.values[2]) === JSON.stringify(['fct_cost_rows', 'fct_lists.employees'])
        && JSON.stringify(rec.values[3]) === JSON.stringify([0, 0]), rec && JSON.stringify(rec.values));
  }

  console.log('\n[a run whose backup fails]');
  {
    const sends = [];
    const sql = scriptedSql(text => {
      if (/^INSERT INTO app_data_snapshots/.test(text)) throw new Error('statement timeout');
      if (/^SELECT split_part/.test(text)) return [{ company_code: 'A', measure: 'fct_cost_rows', n: 1 }];
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }];
      if (/FROM list_counts WHERE company_code/.test(text)) return [{ at: PREV, measure: 'fct_cost_rows', n: 40 }];
      return [];
    });
    const out = await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'], send: async m => { sends.push(m); return { ok: true }; } });
    assert('still runs the check', out.alerts.length === 1);
    assert('and says the backup failed, by email', sends.some(m => /nightly backup did not finish/.test(m.subject) && /statement timeout/.test(m.html)),
      JSON.stringify(sends.map(m => m.subject)));
    assert('as well as sending the drop', sends.some(m => /shrank/.test(m.subject)));
  }
  {
    const sends = [];
    const sql = scriptedSql(text => {
      if (/^SELECT split_part/.test(text)) throw new Error('connection reset');
      return [];
    });
    const out = await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'], send: async m => { sends.push(m); return { ok: true }; } });
    assert('a check that cannot count says so too', sends.length === 1 && /did not finish/.test(sends[0].subject)
      && out.errors.some(e => e.step === 'count'));
  }
  {
    const sends = [];
    const sql = scriptedSql(text => {
      if (/^DELETE FROM list_counts/.test(text)) throw new Error('lock timeout');
      return [];
    });
    const out = await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'], send: async m => { sends.push(m); return { ok: true }; } });
    assert('so does one that cannot prune its old counts', out.failed === true
      && sends.length === 1 && /lock timeout/.test(sends[0].html), JSON.stringify(out.errors));
  }

  console.log('\n[an emptied list is recorded as empty once]');
  {
    const sql = scriptedSql(text => {
      if (/^SELECT split_part/.test(text)) return [{ company_code: 'A', measure: 'fct_cost_rows', n: 5 }];
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }];
      // The last run already recorded fct_inventory as 0.
      if (/FROM list_counts WHERE company_code/.test(text))
        return [{ at: PREV, measure: 'fct_cost_rows', n: 5 }, { at: PREV, measure: 'fct_inventory', n: 0 }];
      return [];
    });
    await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'], send: async () => ({ ok: true }) });
    const rec = sql.calls.find(c => /^INSERT INTO list_counts/.test(c.text));
    assert('and not written again every run after', rec && !rec.values[2].includes('fct_inventory'), rec && JSON.stringify(rec.values[2]));
  }

  console.log('\n[a check that fails is reported too]');
  {
    const sends = [];
    const sql = scriptedSql(text => {
      if (/^SELECT split_part/.test(text)) return [{ company_code: 'A', measure: 'fct_cost_rows', n: 5 }];
      if (/^SELECT code, name FROM companies/.test(text)) return [{ code: 'A', name: 'Alpha' }];
      if (/FROM list_counts WHERE company_code/.test(text)) throw new Error('permission denied for table list_counts');
      return [];
    });
    const out = await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'], send: async m => { sends.push(m); return { ok: true }; } });
    assert('the run is marked failed', out.failed === true);
    assert('and the failure is emailed', sends.length === 1 && /did not finish/.test(sends[0].subject) && /permission denied/.test(sends[0].html));
    assert('its counts are not recorded, so the next run compares with the last good ones',
      !sql.calls.some(c => /^INSERT INTO list_counts/.test(c.text)));
  }
  {
    const sql = scriptedSql(() => []);
    const out = await B.runDataBackup(sql, { now: NOW, recipients: ['ops@x.com'], send: async () => ({ ok: true }) });
    assert('a clean run is not', out.failed === false && out.errors.length === 0, JSON.stringify(out.errors));
  }

  console.log('\n[the cron endpoint]');
  {
    let ran = 0;
    let FAILS = [];
    const orig = Module._load;
    Module._load = function (req, parent) {
      if (req === '@neondatabase/serverless') return { neon: () => () => Promise.resolve([]) };
      if (req === '../lib/data-backup' && parent && /cron/.test(parent.filename)) {
        return { runDataBackup: async () => { ran++; return { at: 'd', backup: {}, measures: 0, alerts: [], emailed: 0, pending: 0, errors: FAILS, failed: FAILS.some(e => e.step !== 'email') }; } };
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
    FAILS = [{ step: 'backup', error: 'statement timeout' }];
    r = await call({ authorization: 'Bearer s3cret' });
    assert('a run that did not finish answers 500, so the scheduler log shows it', r.code === 500 && r.body.ok === false);
    FAILS = [{ company: 'A', step: 'email', error: 'DATA_ALERT_EMAILS is not set' }];
    r = await call({ authorization: 'Bearer s3cret' });
    assert('so does one whose alert reached nobody', r.code === 500 && r.body.ok === false);
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
