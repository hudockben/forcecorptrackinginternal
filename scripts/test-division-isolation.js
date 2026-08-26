#!/usr/bin/env node
'use strict';
/**
 * Cross-division isolation smoke test.
 *
 * Run: node scripts/test-division-isolation.js
 *
 * Exercises the auth helpers against a battery of impersonation scenarios.
 * Asserts that:
 *   - A user scoped to one division CANNOT access any other division.
 *   - Platform admins can access every division.
 *   - Legacy tokens (no division_roles) fall back to allowedDivisions or turf.
 *   - Blob key prefix → division mapping rejects cross-division keys.
 *   - Division name normalization rejects unknown values.
 *
 * No DB or server required — tests the pure helpers that every endpoint uses.
 */

const {
  ALL_DIVISIONS,
  hasDivisionAccess,
  divisionForKey,
  normalizeDivision,
  isSharedKey,
} = require('../api/lib/auth');

let passed = 0;
let failed = 0;

function assert(label, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// ── User fixtures ───────────────────────────────────────────────────────────
const pavingOnly = {
  username: 'paving-user',
  divisionRoles: { turf: 'no_access', dust: 'no_access', paving: 'level3', trucking: 'no_access', intercompany: 'no_access' },
  isPlatformAdmin: false,
};

const turfOnly = {
  username: 'turf-user',
  divisionRoles: { turf: 'level3', dust: 'no_access', paving: 'no_access', trucking: 'no_access', intercompany: 'no_access' },
  isPlatformAdmin: false,
};

const dustViewer = {
  username: 'dust-viewer',
  divisionRoles: { turf: 'no_access', dust: 'level1', paving: 'no_access', trucking: 'no_access', intercompany: 'no_access' },
  isPlatformAdmin: false,
};

const truckingOnly = {
  username: 'trucking-user',
  divisionRoles: { turf: 'no_access', dust: 'no_access', paving: 'no_access', trucking: 'level3', intercompany: 'no_access' },
  isPlatformAdmin: false,
};

const platformAdmin = {
  username: 'platform-admin',
  divisionRoles: null,
  isPlatformAdmin: true,
};

const legacyTurf = {
  username: 'legacy-turf',
  divisionRoles: null,
  allowedDivisions: ['turf'],
  isPlatformAdmin: false,
};

const legacyMulti = {
  username: 'legacy-multi',
  divisionRoles: null,
  allowedDivisions: ['turf', 'dust'],
  isPlatformAdmin: false,
};

const legacyEmpty = {
  username: 'legacy-empty',
  divisionRoles: null,
  isPlatformAdmin: false,
};

// ── Tests ───────────────────────────────────────────────────────────────────
console.log('\n[ALL_DIVISIONS]');
const EXPECTED_DIVISIONS = ['turf', 'dust', 'paving', 'kiewit', 'trucking', 'quarry', 'intercompany', 'executive', 'scheduler', 'timesheet', 'payroll', 'fuel', 'fuel_admin', 'driver', 'quarry_sales'];
assert('contains exactly the canonical divisions',
  ALL_DIVISIONS.length === EXPECTED_DIVISIONS.length &&
  EXPECTED_DIVISIONS.every(d => ALL_DIVISIONS.includes(d)));
assert('includes quarry',          ALL_DIVISIONS.includes('quarry'));
assert('includes paving',          ALL_DIVISIONS.includes('paving'));
assert('includes intercompany',    ALL_DIVISIONS.includes('intercompany'));
assert('includes timesheet',       ALL_DIVISIONS.includes('timesheet'));
assert('includes payroll',         ALL_DIVISIONS.includes('payroll'));
assert('includes fuel',            ALL_DIVISIONS.includes('fuel'));
assert('includes fuel_admin',      ALL_DIVISIONS.includes('fuel_admin'));
assert('includes quarry_sales',    ALL_DIVISIONS.includes('quarry_sales'));

console.log('\n[normalizeDivision]');
assert('normalizes case',           normalizeDivision('PAVING') === 'paving');
assert('strips bad chars',          normalizeDivision('paving!@#') === 'paving');
assert('rejects unknown',           normalizeDivision('foo') === null);
assert('rejects empty',             normalizeDivision('') === null);
assert('rejects null',              normalizeDivision(null) === null);
assert('accepts trucking',          normalizeDivision('trucking') === 'trucking');
// fuel_admin is the first division key carrying an underscore — the character
// class in normalizeDivision has to keep it, or the key silently becomes
// 'fueladmin' and stops matching anything.
assert('keeps the underscore',      normalizeDivision('fuel_admin') === 'fuel_admin');
assert('accepts FUEL_ADMIN',        normalizeDivision('FUEL_ADMIN') === 'fuel_admin');
assert('keeps quarry_sales whole',  normalizeDivision('quarry_sales') === 'quarry_sales');
assert('rejects sql injection',     normalizeDivision("paving'; DROP--") === null);

console.log('\n[hasDivisionAccess — paving-only user]');
assert('paving allowed',            hasDivisionAccess(pavingOnly, 'paving') === true);
assert('turf BLOCKED',              hasDivisionAccess(pavingOnly, 'turf') === false);
assert('dust BLOCKED',              hasDivisionAccess(pavingOnly, 'dust') === false);
assert('trucking BLOCKED',          hasDivisionAccess(pavingOnly, 'trucking') === false);
assert('intercompany BLOCKED',      hasDivisionAccess(pavingOnly, 'intercompany') === false);

console.log('\n[hasDivisionAccess — turf-only user]');
assert('turf allowed',              hasDivisionAccess(turfOnly, 'turf') === true);
assert('paving BLOCKED',            hasDivisionAccess(turfOnly, 'paving') === false);
assert('dust BLOCKED',              hasDivisionAccess(turfOnly, 'dust') === false);

console.log('\n[hasDivisionAccess — dust-viewer (level1)]');
assert('dust level1 still grants access', hasDivisionAccess(dustViewer, 'dust') === true);
assert('paving still BLOCKED',            hasDivisionAccess(dustViewer, 'paving') === false);

console.log('\n[hasDivisionAccess — platform admin]');
ALL_DIVISIONS.forEach(d => {
  assert(`admin allowed for ${d}`, hasDivisionAccess(platformAdmin, d) === true);
});

console.log('\n[hasDivisionAccess — legacy tokens]');
assert('legacy turf-only allowed turf',    hasDivisionAccess(legacyTurf, 'turf') === true);
assert('legacy turf-only BLOCKED paving',  hasDivisionAccess(legacyTurf, 'paving') === false);
assert('legacy multi allowed turf+dust',   hasDivisionAccess(legacyMulti, 'turf') && hasDivisionAccess(legacyMulti, 'dust'));
assert('legacy multi BLOCKED paving',      hasDivisionAccess(legacyMulti, 'paving') === false);
assert('legacy empty falls back to turf',  hasDivisionAccess(legacyEmpty, 'turf') === true);
assert('legacy empty BLOCKED paving',      hasDivisionAccess(legacyEmpty, 'paving') === false);

console.log('\n[hasDivisionAccess — bad inputs]');
assert('null payload rejected',     hasDivisionAccess(null, 'paving') === false);
assert('null division rejected',    hasDivisionAccess(pavingOnly, null) === false);
assert('empty division rejected',   hasDivisionAccess(pavingOnly, '') === false);

console.log('\n[isSharedKey — presence/heartbeat]');
assert('fct_presence is shared',         isSharedKey('fct_presence') === true);
assert('fct_paving_projects NOT shared', isSharedKey('fct_paving_projects') === false);
assert('dust_routes NOT shared',         isSharedKey('dust_routes') === false);
assert('fct_projects NOT shared',        isSharedKey('fct_projects') === false);

console.log('\n[divisionForKey — blob prefix mapping]');
assert('fct_paving_projects → paving',         divisionForKey('fct_paving_projects') === 'paving');
assert('fct_paving_crm_people → paving',       divisionForKey('fct_paving_crm_people') === 'paving');
assert('dust_routes → dust',                   divisionForKey('dust_routes') === 'dust');
assert('fct_intercompany_billing → intercompany', divisionForKey('fct_intercompany_billing_entries') === 'intercompany');
assert('fct_trucking → trucking',              divisionForKey('fct_trucking') === 'trucking');
assert('fct_truck_division → trucking',        divisionForKey('fct_truck_division') === 'trucking');
assert('fct_projects → null (turf default)',   divisionForKey('fct_projects') === null);
assert('fct_lists → null (turf default)',      divisionForKey('fct_lists') === null);

console.log('\n[Cross-division blob impersonation matrix]');
// Simulate: each user tries every other division's blob key.
const scenarios = [
  { user: pavingOnly,  allowedKey: 'fct_paving_projects',          blockedKeys: ['dust_routes', 'fct_intercompany_billing', 'fct_trucking', 'fct_projects'] },
  { user: turfOnly,    allowedKey: 'fct_projects',                  blockedKeys: ['fct_paving_projects', 'dust_routes', 'fct_intercompany_billing'] },
  { user: dustViewer,  allowedKey: 'dust_routes',                   blockedKeys: ['fct_paving_projects', 'fct_projects', 'fct_intercompany_billing', 'fct_trucking'] },
];

for (const { user, allowedKey, blockedKeys } of scenarios) {
  const allowedDiv = divisionForKey(allowedKey) || 'turf';
  assert(`${user.username} CAN read ${allowedKey}`,
    hasDivisionAccess(user, allowedDiv) === true);
  for (const bk of blockedKeys) {
    const div = divisionForKey(bk) || 'turf';
    assert(`${user.username} CANNOT read ${bk}`,
      hasDivisionAccess(user, div) === false);
  }
}

console.log('\n[Cross-division IC keys — source divisions can write]');
const { isCrossDivisionKey, hasAnyDivisionAccess, CROSS_DIVISION_CONTRIBUTORS } = require('../api/lib/auth');
assert('isCrossDivisionKey(fct_intercompany_billing_entries) true',
  isCrossDivisionKey('fct_intercompany_billing_entries') === true);
assert('isCrossDivisionKey(fct_intercompany_companies) true',
  isCrossDivisionKey('fct_intercompany_companies') === true);
assert('isCrossDivisionKey(fct_intercompany_billing) false (legacy/unused key)',
  isCrossDivisionKey('fct_intercompany_billing') === false);
assert('truckingOnly user can write IC billing (cross-division)',
  hasAnyDivisionAccess(truckingOnly, CROSS_DIVISION_CONTRIBUTORS) === true);
assert('dustViewer user can write IC billing (cross-division)',
  hasAnyDivisionAccess(dustViewer, CROSS_DIVISION_CONTRIBUTORS) === true);
assert('pavingOnly user can write IC billing (cross-division)',
  hasAnyDivisionAccess(pavingOnly, CROSS_DIVISION_CONTRIBUTORS) === true);
assert('turfOnly user CANNOT write IC billing (no source-division access)',
  hasAnyDivisionAccess(turfOnly, CROSS_DIVISION_CONTRIBUTORS) === false);

console.log('\n[Intercompany read-only quarry escape hatch]');
const { isIcQuarryReadOnlyGet, IC_QUARRY_READONLY_KEYS } = require('../api/lib/auth');
const icOnly = {
  username: 'ic-user',
  divisionRoles: { turf: 'no_access', dust: 'no_access', paving: 'no_access', trucking: 'no_access', quarry: 'no_access', intercompany: 'level3' },
  isPlatformAdmin: false,
};
// The IC Quarry sub-tab auto-pulls BOTH daily and crushing — regression guard
// for the bug where only fct_quarry_daily was whitelisted and crushing 403'd.
assert('escape-hatch set contains fct_quarry_daily',    IC_QUARRY_READONLY_KEYS.has('fct_quarry_daily'));
assert('escape-hatch set contains fct_quarry_crushing', IC_QUARRY_READONLY_KEYS.has('fct_quarry_crushing'));
assert('IC user CAN GET fct_quarry_daily',    isIcQuarryReadOnlyGet('fct_quarry_daily',    icOnly, 'GET') === true);
assert('IC user CAN GET fct_quarry_crushing', isIcQuarryReadOnlyGet('fct_quarry_crushing', icOnly, 'GET') === true);
assert('IC user CANNOT PUT fct_quarry_crushing (read-only)', isIcQuarryReadOnlyGet('fct_quarry_crushing', icOnly, 'PUT') === false);
assert('IC user CANNOT PATCH fct_quarry_daily (read-only)',  isIcQuarryReadOnlyGet('fct_quarry_daily', icOnly, 'PATCH') === false);
assert('hatch does NOT cover other quarry blobs (sales)',    isIcQuarryReadOnlyGet('fct_quarry_sales', icOnly, 'GET') === false);
assert('non-IC quarry user not granted via hatch (uses normal quarry role)',
  isIcQuarryReadOnlyGet('fct_quarry_crushing', pavingOnly, 'GET') === false);
// A real quarry user reaches crushing through the normal division check, not the hatch.
assert('quarry blob maps to quarry division', divisionForKey('fct_quarry_crushing') === 'quarry');

console.log('\n────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('────────────────────────────────────────');
process.exit(failed > 0 ? 1 : 0);
