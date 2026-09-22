#!/usr/bin/env node
'use strict';
/**
 * The company's equipment list, as every picker sees it.
 *
 * Run: node scripts/test-equipment-roster.js
 *
 * THE BUG. "Operated equipment or drove pickup truck? Yes" opens a picker that
 * asks WHICH machine, because a cost row is coded per machine and reconstructing
 * that from the schedule days later is the failure the question exists to
 * remove. The picker reads GET /api/equipment, which read the `equipment_list`
 * table — and that table is turf's list and nothing else.
 *
 * Nothing writes to it directly: everything in it arrived through
 * sync-normalized.js, whose syncForKey routes ONLY `fct_lists` to syncLists.
 * `fct_paving_lists` and `fct_kiewit_lists` are routed nowhere, so paving and
 * kiewit have never had one machine in that table. A paving operator answering
 * Yes was handed turf's mowers, picked the closest or left it blank, and the
 * job was coded off a guess — the exact outcome the question was added to stop.
 *
 * Payroll's split modal already half-knew this: it merges the PROJECT's
 * assigned_equipment on top of the global list, which is a patch over a global
 * list that was never global. The fix is one union, read by every picker — the
 * way api/lib/roster.js already does for people.
 *
 * No DB or server required: the neon driver and the auth module are stubbed at
 * require time, and the sql tagged template is an in-memory mock that records
 * every statement so the reads themselves can be asserted.
 */

const path   = require('path');
const fs     = require('fs');
const Module = require('module');

let CURRENT_SQL = null;
const AUTH = { companyCode: 'FCT', userId: 1, username: 'admin', payrollAdmin: true };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth' || request === '../lib/auth') {
    return {
      requireAuth: () => AUTH,
      requireDivision: () => null,
      hasDivisionAccess: () => true,
      payrollAccess: () => ({ canCode: true, canApprove: true, isCoder: false }),
    };
  }
  return origLoad.apply(this, arguments);
};

const LIB = path.resolve(__dirname, '..', 'api', 'lib', 'equipment.js');
const { readEquipmentRoster } = require(LIB);

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (detail ? '  — ' + detail : '')); }
}

const names = rows => rows.map(r => r.name);
const rowFor = (rows, name) => rows.find(r => r.name.toLowerCase() === name.toLowerCase()) || {};
const costOf = (rows, name) => Number(rowFor(rows, name).unit_cost);
const divsOf = (rows, name) => rowFor(rows, name).divisions || [];

// Mock sql: the equipment_list table and the three division list blobs, each
// independently able to fail so the non-fatal paths can be proved rather than
// assumed.
function makeSql({ table = [], blobs = {}, failBlobs = false, failTable = false } = {}) {
  const log = [];
  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();
    log.push({ q, values });
    if (q.includes('FROM equipment_list')) {
      return failTable ? Promise.reject(new Error('equipment_list unreachable'))
                       : Promise.resolve(table);
    }
    if (q.startsWith('SELECT key, value FROM app_data')) {
      if (failBlobs) return Promise.reject(new Error('app_data unreachable'));
      const keys = Array.isArray(values[0]) ? values[0] : [];
      return Promise.resolve(keys.filter(k => blobs[k]).map(k => ({ key: k, value: blobs[k] })));
    }
    return Promise.resolve([]);
  };
  sql.log = log;
  sql.blobReads = () => log.filter(e => e.q.startsWith('SELECT key, value FROM app_data')).length;
  sql.tableReads = () => log.filter(e => e.q.includes('FROM equipment_list')).length;
  return sql;
}

// The shape each source stores. The table is normalized rows; a blob holds
// either {name, unit_cost} objects or bare strings, which is what the division
// pages have always written.
const TURF_TABLE = [
  { id: 1, name: 'Turf Machine', unit_cost: 45,   sort_order: 0 },
  { id: 2, name: 'Pickup Truck', unit_cost: 18.75, sort_order: 1 },
];
const PAVING_BLOB = {
  employees: [{ name: 'Zach Brewer' }],
  equipment: [
    { name: 'Paver',        unit_cost: 210 },
    { name: 'Roller',       unit_cost: 95  },
    { name: 'pickup truck', unit_cost: 18.75 },   // the same truck, typed differently
  ],
};
const KIEWIT_BLOB = {
  equipment: [{ name: 'Excavator', unit_cost: 130 }, 'Broom'],
};
const K = k => 'FCT:' + k;

// Silence the deliberate failure paths so a passing run reads clean. The
// message itself is asserted where it matters.
async function quiet(fn) {
  const real = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try { return { out: await fn(), logged: seen }; }
  finally { console.error = real; }
}

async function libTests() {
  console.log('\n[every division’s machines, in one list]');
  {
    const sql = makeSql({
      table: TURF_TABLE,
      blobs: { [K('fct_paving_lists')]: PAVING_BLOB, [K('fct_kiewit_lists')]: KIEWIT_BLOB },
    });
    const rows = await readEquipmentRoster(sql, 'FCT');
    const got = names(rows);

    assert('turf’s machines are still there',
      got.includes('Turf Machine') && got.includes('Pickup Truck'));
    assert('the paving machines an operator actually runs are offered',
      got.includes('Paver') && got.includes('Roller'), got.join(', '));
    assert('so are kiewit’s',
      got.includes('Excavator'), got.join(', '));
    assert('a blob entry stored as a bare string counts as a machine',
      got.includes('Broom'), got.join(', '));
    assert('  and every list is reached in ONE app_data read',
      sql.blobReads() === 1, 'reads: ' + sql.blobReads());
  }

  console.log('\n[a machine is a machine once]');
  {
    const sql = makeSql({
      table: TURF_TABLE,
      blobs: { [K('fct_paving_lists')]: PAVING_BLOB, [K('fct_kiewit_lists')]: KIEWIT_BLOB },
    });
    const rows = await readEquipmentRoster(sql, 'FCT');
    const trucks = rows.filter(r => r.name.toLowerCase() === 'pickup truck');
    assert('a name in two lists appears once, not twice',
      trucks.length === 1, JSON.stringify(names(rows)));
    assert('  and the table’s spelling wins, so the cost row reads as it always did',
      trucks[0].name === 'Pickup Truck' && trucks[0].id === 2);
    assert('  keeping the hand-ordered sort_order it was given',
      trucks[0].sort_order === 1);
    assert('a blob-only machine carries no table id',
      rows.find(r => r.name === 'Paver').id === null);
    assert('  and says which list it came from',
      divsOf(rows, 'Paver').join() === 'paving' &&
      divsOf(rows, 'Excavator').join() === 'kiewit');
    // The Timesheet narrows each job block's picker to its own division's list,
    // so the dedup must not decide a machine's division by whichever source was
    // read first: a pickup both divisions keep would then reach one crew and be
    // hidden from the other.
    assert('a machine on two lists belongs to BOTH, not to whichever was read first',
      divsOf(rows, 'Pickup Truck').join() === 'turf,paving',
      divsOf(rows, 'Pickup Truck').join());
    assert('  and the table is turf\u2019s list, since nothing else feeds it',
      divsOf(rows, 'Turf Machine').join() === 'turf');
  }

  console.log('\n[the price: a real one beats a missing one and beats a zero]');
  {
    const sql = makeSql({
      // Priced properly in paving, at 0 in the table — a gap in the table, not
      // a machine that runs for free.
      table: [{ id: 1, name: 'Paver', unit_cost: 0, sort_order: 0 }],
      blobs: { [K('fct_paving_lists')]: PAVING_BLOB },
    });
    const rows = await readEquipmentRoster(sql, 'FCT');
    assert('a blob price fills a zero the winning source carried',
      costOf(rows, 'Paver') === 210, String(costOf(rows, 'Paver')));
  }
  {
    const sql = makeSql({
      table: [{ id: 1, name: 'Paver', unit_cost: 210, sort_order: 0 }],
      blobs: { [K('fct_paving_lists')]: { equipment: [{ name: 'Paver', unit_cost: 0 }] } },
    });
    const rows = await readEquipmentRoster(sql, 'FCT');
    assert('  but a blob zero never overwrites a real price',
      costOf(rows, 'Paver') === 210, String(costOf(rows, 'Paver')));
  }
  {
    const sql = makeSql({
      table: [],
      blobs: {
        [K('fct_paving_lists')]: { equipment: [{ name: 'Roller', unit_cost: 0 }] },
        [K('fct_kiewit_lists')]: { equipment: [{ name: 'Roller', unit_cost: 95 }] },
      },
    });
    const rows = await readEquipmentRoster(sql, 'FCT');
    assert('  and one division’s price rescues another division’s blank',
      costOf(rows, 'Roller') === 95, String(costOf(rows, 'Roller')));
  }

  console.log('\n[a list that isn’t there must not take the picker down]');
  {
    const sql = makeSql({ table: TURF_TABLE, blobs: {} });
    const rows = await readEquipmentRoster(sql, 'FCT');
    assert('a division that has never written its list is simply absent',
      names(rows).join(',') === 'Turf Machine,Pickup Truck', names(rows).join(','));
  }
  {
    const sql = makeSql({ table: TURF_TABLE, failBlobs: true });
    const { out: rows, logged } = await quiet(() => readEquipmentRoster(sql, 'FCT'));
    assert('a blob read that fails falls back to the table alone',
      names(rows).join(',') === 'Turf Machine,Pickup Truck', names(rows).join(','));
    assert('  and says so rather than failing silently',
      logged.some(l => /division list blobs read failed/.test(l)), logged.join(' | '));
  }
  {
    const sql = makeSql({ table: [], failTable: true });
    let threw = false;
    try { await readEquipmentRoster(sql, 'FCT'); } catch { threw = true; }
    assert('a table read that fails is the caller’s to handle, as before',
      threw);
  }

  console.log('\n[turf keeps its canonical table, and its removals]');
  {
    const entries = require(LIB).DIVISION_LIST_KEYS.map(([d, k]) => d + ':' + k).join(',');
    assert('only the two divisions that were never synced are read from blobs',
      entries === 'paving:fct_paving_lists,kiewit:fct_kiewit_lists', entries);

    // syncLists only ever upserts, so turf's blob still carries a machine the
    // table no longer does. Reading that blob would walk the removal back.
    const sql = makeSql({
      table: [{ id: 1, name: 'Turf Machine', unit_cost: 45, sort_order: 0 }],
      blobs: {
        [K('fct_lists')]: { equipment: [{ name: 'Turf Machine', unit_cost: 45 },
                                        { name: 'Retired Mower', unit_cost: 12 }] },
      },
    });
    const rows = await readEquipmentRoster(sql, 'FCT');
    assert('  a machine dropped from the table does not walk back in off fct_lists',
      !names(rows).includes('Retired Mower'), names(rows).join(', '));
    assert('  so nothing about turf\u2019s list changes at all',
      names(rows).join(',') === 'Turf Machine', names(rows).join(','));

    // The blobs it DOES read are the ones the timesheet prices a machine from,
    // so a name this offers always has a list that can cost it.
    const tsSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'), 'utf8');
    const line = (tsSource.match(/const DIVISION_LISTS_KEY = \{[^}]*\}/) || [''])[0];
    assert('  and each one is a key DIVISION_LISTS_KEY in api/timesheet-entries.js knows',
      /paving: 'fct_paving_lists'/.test(line) && /kiewit: 'fct_kiewit_lists'/.test(line),
      line);
  }
}

// ── The endpoint every picker actually calls ────────────────────────────────
async function endpointTests() {
  console.log('\n[GET /api/equipment]');
  const handler = require(path.resolve(__dirname, '..', 'api', 'equipment.js'));

  function res() {
    const r = { code: 200, body: null };
    r.status = c => { r.code = c; return r; };
    r.json   = b => { r.body = b; return r; };
    return r;
  }

  {
    CURRENT_SQL = makeSql({
      table: TURF_TABLE,
      blobs: { [K('fct_paving_lists')]: PAVING_BLOB, [K('fct_kiewit_lists')]: KIEWIT_BLOB },
    });
    const r = res();
    await handler({ method: 'GET', query: {}, headers: {} }, r);
    const got = names(r.body.equipment);
    assert('the endpoint serves the union, not the table',
      got.includes('Paver') && got.includes('Excavator') && got.includes('Turf Machine'),
      got.join(', '));
    assert('  and still answers in the { equipment: [...] } shape both pages read',
      Array.isArray(r.body.equipment) &&
      ['id', 'name', 'unit_cost', 'sort_order'].every(k => k in r.body.equipment[0]));
    assert('  plus the divisions each machine is kept by, which is what the Timesheet narrows on',
      r.body.equipment.every(e => Array.isArray(e.divisions) && e.divisions.length),
      JSON.stringify(r.body.equipment.map(e => [e.name, e.divisions])));
  }

  // The PUT decides what to DELETE from the table. A paving machine has no row
  // there to delete, and folding the union into that read would have the first
  // save from the equipment editor delete... nothing, but count the blob names
  // as "existing" and so mis-read the bulk-wipe guard.
  {
    CURRENT_SQL = makeSql({
      table: TURF_TABLE,
      blobs: { [K('fct_paving_lists')]: PAVING_BLOB, [K('fct_kiewit_lists')]: KIEWIT_BLOB },
    });
    const r = res();
    await handler({ method: 'PUT', query: {}, headers: {}, body: { equipment: [] } }, r);
    const blobReads = CURRENT_SQL.blobReads();
    assert('a full-replace PUT still measures itself against the TABLE only',
      blobReads === 0, 'blob reads during PUT: ' + blobReads);
    assert('  so the bulk-wipe guard still refuses to empty a real list',
      r.code === 409, 'status ' + r.code);
  }
}

// ── The money that follows the pick ─────────────────────────────────────────
// Offering a machine the cost side cannot price would trade one silent failure
// for another: the operator names the paver, and the job is billed $0 for it.
async function costTests() {
  console.log('\n[a machine named on one division’s day still prices]');
  const { insertSplitRows } = require(
    path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'))._test;

  // turf's own blob knows nothing about a paver; paving's does.
  const BLOBS = {
    [K('fct_lists')]: { employees: [{ name: 'Zach Brewer', job_class: 'Operator', non_pw_rate: 32.5 }],
                        equipment: [{ name: 'Turf Machine', unit_cost: 45 }] },
    [K('fct_paving_lists')]: PAVING_BLOB,
    [K('fct_kiewit_lists')]: KIEWIT_BLOB,
  };

  function costSql({ table = [] } = {}) {
    const log = [];
    const sql = (strings, ...values) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      log.push({ q, values });
      if (q.startsWith('SELECT value FROM app_data')) {
        return Promise.resolve([{ value: BLOBS[values[0]] || null }]);
      }
      if (q.startsWith('SELECT key, value FROM app_data')) {
        const keys = Array.isArray(values[0]) ? values[0] : [];
        // Project blobs answer the prevailing-wage question; list blobs answer
        // the equipment one. One query shape, two callers.
        return Promise.resolve(keys.map(k => ({
          key: k, value: BLOBS[k] || { prevailing_wage: false },
        })));
      }
      if (q.includes('FROM equipment_list')) return Promise.resolve(table);
      return Promise.resolve([]);
    };
    sql.log = log;
    sql.inserted = () => {
      const ins = log.find(e => e.q.startsWith('INSERT INTO daily_tracking'));
      if (!ins) return null;
      const v = ins.values;
      return { employee: v[6], rate: v[10], equipment: v[12], equip_unit_cost: v[13], equip_hours: v[14] };
    };
    return sql;
  }

  const ENTRY = { id: 99, job_id: 'J1', work_date: '2026-08-03' };
  const ROW   = over => Object.assign({
    cost_code: 'General', sub_code: 'General Time',
    equipment: '', labor_hours: 8, equip_hours: 0, quantity: 0,
  }, over);

  {
    const sql = costSql();
    await insertSplitRows(sql, [ROW({ equipment: 'Paver', equip_hours: 6 })],
      ENTRY, 'turf', 'FCT', 'Zach Brewer');
    const r = sql.inserted();
    assert('a paving machine named on a turf day is priced from paving’s list',
      r.equip_unit_cost === 210, String(r.equip_unit_cost));
    assert('  so the job is billed for the machine, not $0',
      r.equip_unit_cost * r.equip_hours === 1260);
  }
  {
    const sql = costSql();
    await insertSplitRows(sql, [ROW({ equipment: 'Turf Machine', equip_hours: 8 })],
      ENTRY, 'turf', 'FCT', 'Zach Brewer');
    assert('the block’s own division still answers first',
      sql.inserted().equip_unit_cost === 45);
    const blobReads = sql.log.filter(e => e.q.startsWith('SELECT key, value FROM app_data')).length;
    assert('  and a machine its own list can price costs no extra read',
      blobReads === 1, 'batched app_data reads: ' + blobReads);
  }
  {
    const sql = costSql();
    await insertSplitRows(sql, [ROW({ equipment: 'Backhoe', equip_hours: 4 })],
      ENTRY, 'turf', 'FCT', 'Zach Brewer');
    assert('a machine no list knows is still injected, at the price it has',
      sql.inserted().equipment === 'Backhoe' && sql.inserted().equip_unit_cost === 0);
  }
}

// ── The pickers on the other side of it ─────────────────────────────────────
function consumerTests() {
  console.log('\n[the pickers that read it]');
  const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

  const board = read('api/scheduler/board.js');
  assert('the Scheduler staffs jobs off the same union',
    /require\('\.\.\/lib\/equipment'\)/.test(board) &&
    /readEquipmentRoster\(sql, companyCode\)/.test(board));
  assert('  so it can no longer read equipment_list behind the union’s back',
    !/FROM equipment_list/.test(board), 'board.js still queries equipment_list directly');

  const ts = read('timesheet.html');
  assert('the Timesheet picker still reads GET /api/equipment',
    /fetch\('\/api\/equipment'/.test(ts));
  assert('  and sorts the union once, before splitting it by division',
    /\.sort\(\(a, b\) => String\(a\.name\)\.localeCompare\(String\(b\.name\)\)\)/.test(ts) &&
    ts.indexOf('.sort((a, b) => String(a.name).localeCompare(String(b.name)))') <
    ts.indexOf('equipmentByDivision = byDiv;'));
  assert('  and buckets each machine under every division that keeps it',
    /for \(const d of \(Array\.isArray\(e\.divisions\) \? e\.divisions : \[\]\)\)/.test(ts));

  const pay = read('payroll.html');
  assert('the payroll split modal reads the same endpoint',
    /fetch\('\/api\/equipment'/.test(pay));
}

(async () => {
  await libTests();
  await endpointTests();
  await costTests();
  consumerTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
