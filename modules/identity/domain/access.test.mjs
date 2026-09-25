// Phase-1 acceptance (AGENT-INDEX §5): "the matrix in 16 §5 has tests".
// Every ✓ and every blank of the doc-16 §5 table is asserted cell by cell,
// so a drive-by edit to access.mjs fails loudly against the doc.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLES, ROLE_SETS, PERMISSION_MATRIX, PERMISSIONS,
  roleHolds, permissionsForRole, kindAllowsRole,
} from './access.mjs';

// Doc 16 §5, transcribed independently of access.mjs: one row per permission,
// one column per role, in the table's order.
const HEADER = ['admin', 'manager', 'representative', 'site_lead', 'finance', 'member', 'inspector'];
const TABLE = [
  ['org:projects:create',        1, 1, 1, 0, 0, 0, 0],
  ['org:projects:staff',         1, 1, 1, 0, 0, 0, 0],
  ['org:plan:edit',              1, 1, 1, 1, 0, 0, 0],
  ['org:progress:report',        1, 1, 1, 1, 0, 1, 0],
  ['org:quality:verify',         1, 1, 1, 1, 0, 0, 1],
  ['org:quality:inspect',        1, 1, 1, 1, 0, 0, 1],
  ['org:money:view',             1, 1, 1, 0, 1, 0, 0],
  ['org:costs:edit',             1, 1, 0, 0, 0, 0, 0],
  ['org:variations:acknowledge', 1, 1, 1, 0, 0, 0, 0],
  ['org:changes:propose',        1, 1, 1, 0, 0, 0, 0],
  ['org:changes:decide',         1, 1, 1, 0, 0, 0, 0],
  ['org:tendering:issue',        1, 1, 1, 0, 0, 0, 0],
  ['org:tendering:bid',          1, 1, 0, 0, 0, 0, 0],
  ['org:contracts:sign',         1, 1, 1, 0, 0, 0, 0],
  ['org:measurements:submit',    1, 1, 1, 0, 1, 0, 0],
  ['org:measurements:approve',   1, 1, 1, 0, 1, 0, 0],
  ['org:payments:declare',       1, 0, 1, 0, 1, 0, 0],
  ['org:payments:confirm',       1, 0, 1, 0, 1, 0, 0],
  ['org:profile:manage',         1, 1, 0, 0, 0, 0, 0],
  ['org:reviews:write',          1, 1, 1, 0, 0, 0, 0],
  ['org:templates:publish',      1, 1, 0, 0, 0, 0, 0],
  ['org:members:manage',         1, 0, 0, 0, 0, 0, 0],
  ['org:billing:manage',         1, 0, 0, 0, 1, 0, 0],
];

test('the matrix covers exactly the doc-16 §5 permissions, in order', () => {
  assert.deepEqual(PERMISSIONS, TABLE.map(([p]) => p));
  assert.deepEqual(ROLES, HEADER);
});

for (const [permission, ...cells] of TABLE) {
  test(`§5 row: ${permission}`, () => {
    for (let i = 0; i < HEADER.length; i += 1) {
      assert.equal(
        roleHolds(HEADER[i], permission), Boolean(cells[i]),
        `${HEADER[i]} × ${permission} must be ${cells[i] ? '✓' : 'blank'}`,
      );
    }
  });
}

test('§4 role sets, verbatim', () => {
  assert.deepEqual(ROLE_SETS.household, ['admin', 'representative', 'finance', 'member']);
  assert.deepEqual(ROLE_SETS.contractor, ['admin', 'manager', 'site_lead', 'finance', 'member']);
  assert.deepEqual(ROLE_SETS.consultant, ['admin', 'manager', 'inspector', 'member']);
  assert.equal(kindAllowsRole('household', 'site_lead'), false);
  assert.equal(kindAllowsRole('consultant', 'inspector'), true);
  assert.equal(kindAllowsRole('supplier', 'member'), false, 'supplier has no role set yet (doc 16 §6)');
});

test('permissionsForRole inverts the matrix', () => {
  for (const role of ROLES) {
    const fromMatrix = PERMISSIONS.filter((p) => PERMISSION_MATRIX[p].includes(role));
    assert.deepEqual(permissionsForRole(role), fromMatrix);
  }
  // Spot checks straight from the doc's "consequences" prose.
  assert.ok(!permissionsForRole('site_lead').includes('org:money:view'),
    'a foreman sees the plan but not the margin');
  assert.ok(!permissionsForRole('finance').includes('org:plan:edit'),
    'finance: measurements and payments, no plan editing');
});

test('unknowns throw instead of answering', () => {
  assert.throws(() => roleHolds('admin', 'org:nope:nope'));
  assert.throws(() => permissionsForRole('org:admin'), /unknown role/);
});
