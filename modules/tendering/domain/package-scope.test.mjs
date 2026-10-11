import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exclusionError, prunePackage } from './package-scope.mjs';

const rows = [
  { task_id: 'R', parent_task_id: null },
  { task_id: 'A', parent_task_id: 'R' },
  { task_id: 'B', parent_task_id: 'R' },
  { task_id: 'B1', parent_task_id: 'B' },
  { task_id: 'B2', parent_task_id: 'B' },
];
const items = [
  { task_id: 'A', code: 'a' },
  { task_id: 'B1', code: 'b1' },
  { task_id: 'B2', code: 'b2' },
];

test('no exclusions → the snapshot unchanged', () => {
  const out = prunePackage({ rows, items }, []);
  assert.equal(out.rows, rows);
  assert.equal(out.items, items);
});

test('an excluded row leaves with its own sub-tree and its BoQ items', () => {
  const out = prunePackage({ rows, items }, ['B']);
  assert.deepEqual(out.rows.map((r) => r.task_id), ['R', 'A']);
  assert.deepEqual(out.items.map((i) => i.code), ['a']);
});

test('excluding a leaf keeps its siblings', () => {
  const out = prunePackage({ rows, items }, ['B2']);
  assert.deepEqual(out.rows.map((r) => r.task_id), ['R', 'A', 'B', 'B1']);
  assert.deepEqual(out.items.map((i) => i.code), ['a', 'b1']);
});

test('exclusions must be descendants inside the tendered sub-trees', () => {
  assert.equal(exclusionError(rows, ['B1']), null);
  assert.match(exclusionError(rows, ['R']), /root cannot be left out/);
  assert.match(exclusionError(rows, ['Z']), /not inside/);
});
