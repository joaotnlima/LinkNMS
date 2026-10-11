import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askCandidates, askTargetOf, LOCKED_REASON } from './ask-candidates.mjs';

test('X-6: matching rows first, plan order otherwise; milestones left out; target from the governing RFP', () => {
  const tasks = [
    { id: 'a', code: '1', name: 'Foundations', kind: 'task', specialty_code: 'structure' },
    { id: 'b', code: '2', name: 'Roof', kind: 'summary', specialty_code: 'roofing-tiled' },
    { id: 'm', code: '3', name: 'Handover', kind: 'milestone', specialty_code: null },
    { id: 'c', code: '4', name: 'Gutters', kind: 'task', specialty_code: 'roofing' },
  ];
  const procurement = [
    { task_id: 'b', rfp_id: 'r1', title: 'Roof', status: 'draft', invited_count: 1 },
    { task_id: 'c', rfp_id: 'r2', title: 'Gutters', status: 'published', invited_count: 3 },
  ];
  const out = askCandidates({ tasks, family: ['roofing', 'roofing-tiled'], procurement });
  assert.deepEqual(out.map((t) => [t.task_id, t.specialty_match, t.target.kind]), [['b', true, 'draft'], ['c', true, 'locked'], ['a', false, 'new']]);
  assert.deepEqual(out[0].rfp, { id: 'r1', title: 'Roof', status: 'draft', invited_count: 1 });
  assert.deepEqual(askTargetOf({ status: 'cancelled' }), { kind: 'new' });
  assert.deepEqual(askTargetOf({ status: 'closed' }), { kind: 'locked', reason: LOCKED_REASON });
});
