import { test } from 'node:test';
import assert from 'node:assert/strict';

import { modelUploadCheck, validateDeclaredGlobalIds, uploadCheckBody } from './model-check.mjs';

const g = (n) => `${String(n).padStart(2, '0')}${'A'.repeat(20)}`;

test('M-18: recorded elements missing from the new file are listed; a regenerated export is flagged', () => {
  const recorded = [g(1), g(2), g(3)];
  const previous = [g(1), g(2), g(3), g(4), g(5), g(6)];
  const kept = modelUploadCheck({ recorded, next: [g(1), g(2), g(4), g(5), g(6), g(7)], previous });
  assert.deepEqual([kept.unmatched, kept.regenerated, kept.shared, kept.recorded], [[g(3)], false, 5, 3]);
  const regen = modelUploadCheck({ recorded, next: [g(10), g(11), g(12), g(13), g(14), g(15)], previous });
  assert.deepEqual([regen.unmatched.length, regen.regenerated], [3, true]);
  assert.equal(modelUploadCheck({ recorded: [], next: [g(1)], previous: null }).regenerated, false, 'a first model has nothing to compare');
});

test('declared GlobalIds: shape-checked, deduplicated, optional', () => {
  assert.deepEqual(validateDeclaredGlobalIds([g(2), g(1), g(2)]), { globalIds: [g(1), g(2)] });
  assert.deepEqual(validateDeclaredGlobalIds(undefined), { globalIds: null });
  assert.ok(validateDeclaredGlobalIds(['short']).error);
  assert.ok(validateDeclaredGlobalIds('x').error);
  assert.deepEqual(uploadCheckBody({ version_no: 2, global_ids: [g(1)], unmatched_global_ids: [g(3)], regenerated: false, shared_count: 1, recorded_count: 2 }),
    { version_no: 2, element_count: 1, unmatched_global_ids: [g(3)], regenerated: false, shared_count: 1, recorded_count: 2 });
});
