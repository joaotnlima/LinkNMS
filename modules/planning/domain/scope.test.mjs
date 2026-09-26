import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { inEditScope, effectiveAssignee } from './scope.mjs';
import { keyBetween, keysBetween } from './position.mjs';

const OWNER = 'org-owner';
const GC = 'org-gc';
const SUB = 'org-sub';
const OTHER = 'org-other';

// owner ──client── PRIME (supplier GC) ──client── SUBK (supplier SUB)
const world = {
  ownerOrgId: OWNER,
  contracts: new Map([
    ['PRIME', { supplierOrgId: GC, clientOrgId: OWNER, parentContractId: null }],
    ['SUBK', { supplierOrgId: SUB, clientOrgId: GC, parentContractId: 'PRIME' }],
  ]),
};

describe('D-33 edit scope', () => {
  test('the owner edits everywhere, including rows outside any branch', () => {
    assert.equal(inEditScope(world, { branchContractId: null }, OWNER), true);
    assert.equal(inEditScope(world, { branchContractId: 'SUBK' }, OWNER), true);
  });

  test('a supplier edits its own branch only', () => {
    assert.equal(inEditScope(world, { branchContractId: 'SUBK' }, SUB), true);
    assert.equal(inEditScope(world, { branchContractId: 'PRIME' }, SUB), false);
    assert.equal(inEditScope(world, { branchContractId: null }, SUB), false);
  });

  test('a client edits every branch below its contracts (down the chain)', () => {
    assert.equal(inEditScope(world, { branchContractId: 'PRIME' }, GC), true);
    assert.equal(inEditScope(world, { branchContractId: 'SUBK' }, GC), true); // client of SUBK
  });

  test('an unrelated participant is read-only', () => {
    assert.equal(inEditScope(world, { branchContractId: 'PRIME' }, OTHER), false);
  });
});

describe('assignee inheritance', () => {
  const tasks = new Map([
    ['root', { id: 'root', parentId: null, assigneeOrgId: GC, assigneePersonId: 'p1' }],
    ['mid', { id: 'mid', parentId: 'root', assigneeOrgId: null, assigneePersonId: null }],
    ['leaf', { id: 'leaf', parentId: 'mid', assigneeOrgId: null, assigneePersonId: null }],
    ['own', { id: 'own', parentId: 'mid', assigneeOrgId: SUB, assigneePersonId: null }],
    ['orphan', { id: 'orphan', parentId: null, assigneeOrgId: null }],
  ]);
  test('a row inherits from the nearest assigned ancestor', () => {
    assert.deepEqual(effectiveAssignee(tasks, 'leaf'), { orgId: GC, personId: 'p1', inherited: true });
    assert.deepEqual(effectiveAssignee(tasks, 'own'), { orgId: SUB, personId: null, inherited: false });
    assert.equal(effectiveAssignee(tasks, 'orphan'), null);
  });
});

describe('position keys', () => {
  test('keys order and stay dense', () => {
    const first = keyBetween(null, null);
    const before = keyBetween(null, first);
    const after = keyBetween(first, null);
    const mid = keyBetween(before, first);
    assert.ok(before < first && first < after);
    assert.ok(before < mid && mid < first);
  });

  test('a run of keys between two neighbours stays ordered', () => {
    const [a, b] = [keyBetween(null, null), keyBetween(keyBetween(null, null), null)];
    const run = keysBetween(a, b, 20);
    for (let i = 0; i < run.length; i++) {
      assert.ok((i === 0 ? a : run[i - 1]) < run[i]);
      assert.ok(run[i] < b);
    }
  });

  test('inverted neighbours are rejected', () => {
    assert.throws(() => keyBetween('x', 'a'), /position/);
  });
});
