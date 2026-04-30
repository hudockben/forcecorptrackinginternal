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
assert('contains all 5 divisions', ALL_DIVISIONS.length === 5);
assert('includes paving',          ALL_DIVISIONS.includes('paving'));
assert('includes intercompany',    ALL_DIVISIONS.includes('intercompany'));

console.log('\n[normalizeDivision]');
assert('normalizes case',           normalizeDivision('PAVING') === 'paving');
assert('strips bad chars',          normalizeDivision('paving!@#') === 'paving');
assert('rejects unknown',           normalizeDivision('foo') === null);
assert('rejects empty',             normalizeDivision('') === null);
assert('rejects null',              normalizeDivision(null) === null);
assert('accepts trucking',          normalizeDivision('trucking') === 'trucking');
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

console.log('\n────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('────────────────────────────────────────');
process.exit(failed > 0 ? 1 : 0);
