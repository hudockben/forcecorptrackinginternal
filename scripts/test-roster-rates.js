#!/usr/bin/env node
'use strict';
/**
 * Turf pay rates reach the employees table, and go no further.
 *
 * Run: node scripts/test-roster-rates.js
 *
 * syncLists() mirrors the turf list into the employees table on every save.
 * It read each person's rates as pw_rate / non_pw_rate, but tracker.html
 * stores prevailing_rate / non_prevailing_rate, so every save wrote NULL over
 * every turf rate. When the list itself was lost, the table could give back
 * names and job classes but not one pay rate.
 *
 * Filling those columns has a second half. The table feeds readEmployeeRoster,
 * which GET /api/employees returns to anyone signed in and the Scheduler board
 * sends to anyone on the Scheduler. Neither page reads a rate, and both only
 * ever sent NULLs because of the bug above, so fixing the mirror alone would
 * have started handing out the company's pay rates. The roster now carries
 * none.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { syncLists } = require(path.join(ROOT, 'api', 'lib', 'sync-normalized'));
const { readEmployeeRoster } = require(path.join(ROOT, 'api', 'lib', 'roster'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

/** A tagged-template sql stub that records every statement and answers via `reply`. */
function recordingSql(reply = () => []) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    return Promise.resolve(reply(text, values));
  };
  sql.calls = calls;
  return sql;
}

(async () => {
  console.log('\n[the list\'s rates reach the employees table]');
  {
    const sql = recordingSql();
    await syncLists(sql, 'ACME', {
      employees: [
        { name: 'Allen Strick',  non_prevailing_rate: 31.5, prevailing_rate: 52.1, job_class: 'Foreman' },
        { name: 'Typed Rates',   non_prevailing_rate: '28.25', prevailing_rate: '49' },
        { name: 'Cleared Rates', non_prevailing_rate: '', prevailing_rate: '' },
        { name: 'Legacy Shape',  non_pw_rate: 25, pw_rate: 40 },
        'Bare String',
      ],
    });
    const rows = sql.calls.filter(c => /INSERT INTO employees/.test(c.text));
    // VALUES (company, name, job_class, rate, pw_rate, non_pw_rate, sort_order, NOW())
    assert('the column order this test reads is the statement\'s',
      rows.length === 5 && /\(company_code, name, job_class, rate, pw_rate, non_pw_rate, sort_order, updated_at\)/.test(rows[0].text),
      rows[0] && rows[0].text.slice(0, 140));
    const by = Object.fromEntries(rows.map(r => [r.values[1], { pw: r.values[4], nonPw: r.values[5] }]));
    assert('a turf employee\'s prevailing and standard rates are written',
      by['Allen Strick'].pw === 52.1 && by['Allen Strick'].nonPw === 31.5, JSON.stringify(by['Allen Strick']));
    assert('rates typed into the list as text are written as numbers',
      by['Typed Rates'].pw === 49 && by['Typed Rates'].nonPw === 28.25, JSON.stringify(by['Typed Rates']));
    assert('a cleared rate is written as no rate', by['Cleared Rates'].pw === null && by['Cleared Rates'].nonPw === null);
    assert('the older pw_rate names still work', by['Legacy Shape'].pw === 40 && by['Legacy Shape'].nonPw === 25);
    assert('a bare name still carries no rates', by['Bare String'].pw === null && by['Bare String'].nonPw === null);
  }

  console.log('\n[the roster carries no pay rates]');
  {
    const sql = recordingSql(text => {
      // Even if the table answered with rates, none may come through.
      if (/FROM employees/.test(text)) {
        return [{ id: 1, name: 'Allen Strick', job_class: 'Foreman', pw_rate: 52.1, non_pw_rate: 31.5,
                  prevailing_rate: 52.1, non_prevailing_rate: 31.5, is_supervisor: true, is_driver: false,
                  phone: '555-0142', email: null, supervisor_name: null, sort_order: 0 }];
      }
      if (/fct_paving_lists/.test(JSON.stringify(sql.calls[sql.calls.length - 1].values))) {
        return [{ value: { employees: [{ name: 'Paving Pete', prevailing_rate: 60, non_prevailing_rate: 40 }] } }];
      }
      if (/quarry_employees/.test(text)) return [{ name: 'Quarry Quinn' }];
      return [];
    });
    const roster = await readEmployeeRoster(sql, 'ACME');
    const table = sql.calls.find(c => /FROM employees/.test(c.text));
    assert('the table is not even asked for them', table && !/rate/.test(table.text), table && table.text);
    assert('everyone is still listed', roster.map(r => r.name).join('|') === 'Allen Strick|Paving Pete|Quarry Quinn',
      roster.map(r => r.name).join('|'));
    const leaked = roster.filter(r => Object.keys(r).some(k => /rate/i.test(k)));
    assert('no row carries a rate field', leaked.length === 0, JSON.stringify(leaked));
    const allen = roster.find(r => r.name === 'Allen Strick');
    assert('the fields the pages use are all there',
      allen.job_class === 'Foreman' && allen.is_supervisor === true && allen.phone === '555-0142');
  }

  console.log('\n[the Scheduler board sends no rates]');
  {
    const board = fs.readFileSync(path.join(ROOT, 'api', 'scheduler', 'board.js'), 'utf8');
    assert('readEmployees maps no rate onto a crew member', !/rateStd|ratePw|prevailing_rate/.test(board));
    const page = fs.readFileSync(path.join(ROOT, 'scheduler.html'), 'utf8');
    assert('and the Scheduler page never read one', !/rateStd|ratePw|prevailing_rate/.test(page));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
