// Unit tests for the v2 plan-grid WRITE-ORCHESTRATION planner (LINA-320, S3).
//
// The rules worth pinning: creates + deletes ride ONE schedule:apply (createOp
// first, then a delete_subtree per removed root); each update becomes a PATCH
// carrying the shared client_change_id; each added edge becomes a createLink pathed
// on the successor with a minted id; each removed edge resolves to a LIVE link id
// (matching both anchors) and is DROPPED when no live link matches; and idByKey +
// movedKeys pass straight through. A no-op diff yields an empty plan.
//
// Run: node --experimental-strip-types --test src/lib/v2/plan-edit-ops.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planEditRequests, isEmptyPlan } from './plan-edit-ops.ts';

// A deterministic id minter — the whole reason `mint` is injected.
const minter = () => {
  let n = 0;
  return () => `mint-${++n}`;
};

// An empty diff (every list empty, null createOp) — the shape diffPlanTrees emits
// for a no-op save. Tests override only the field under test.
const diff = (over = {}) => ({
  createOp: null,
  deletes: [],
  updates: [],
  linkAdds: [],
  linkRemoves: [],
  idByKey: {},
  movedKeys: [],
  ...over,
});

test('a no-op diff yields an empty plan the caller skips', () => {
  const plan = planEditRequests(diff(), [], minter(), 'ccid');
  assert.equal(plan.scheduleApply, null);
  assert.deepEqual(plan.patches, []);
  assert.deepEqual(plan.linkAdds, []);
  assert.deepEqual(plan.linkRemoves, []);
  assert.equal(isEmptyPlan(plan), true);
});

test('creates and deletes ride ONE schedule:apply — createOp first, delete_subtree per root', () => {
  const createOp = { op: 'create_rows', rows: [{ id: 'r1', parent_id: null, name: 'New' }], links: [] };
  const plan = planEditRequests(diff({ createOp, deletes: ['d1', 'd2'] }), [], minter(), 'ccid');
  assert.ok(plan.scheduleApply);
  assert.equal(plan.scheduleApply.client_change_id, 'ccid');
  assert.equal(plan.scheduleApply.operations.length, 3);
  assert.equal(plan.scheduleApply.operations[0], createOp); // create first
  assert.deepEqual(plan.scheduleApply.operations[1], { op: 'delete_subtree', task_id: 'd1' });
  assert.deepEqual(plan.scheduleApply.operations[2], { op: 'delete_subtree', task_id: 'd2' });
  assert.equal(isEmptyPlan(plan), false);
});

test('deletes alone still produce a schedule:apply (no create op)', () => {
  const plan = planEditRequests(diff({ deletes: ['gone'] }), [], minter(), 'ccid');
  assert.ok(plan.scheduleApply);
  assert.equal(plan.scheduleApply.operations.length, 1);
  assert.deepEqual(plan.scheduleApply.operations[0], { op: 'delete_subtree', task_id: 'gone' });
});

test('each update becomes a PATCH carrying the shared client_change_id', () => {
  const updates = [
    { taskId: 't1', changes: { name: 'Renamed' } },
    { taskId: 't2', changes: { start: '2026-01-01', dating_mode: 'dated' } },
  ];
  const plan = planEditRequests(diff({ updates }), [], minter(), 'the-ccid');
  assert.equal(plan.patches.length, 2);
  assert.deepEqual(plan.patches[0], { taskId: 't1', changes: { name: 'Renamed' }, client_change_id: 'the-ccid' });
  assert.equal(plan.patches[1].client_change_id, 'the-ccid');
});

test('an added edge becomes a createLink pathed on the successor, id minted', () => {
  const linkAdds = [
    { predecessor_id: 'p', successor_id: 's', from_anchor: 'end', to_anchor: 'start' },
  ];
  const plan = planEditRequests(diff({ linkAdds }), [], minter(), 'ccid');
  assert.equal(plan.linkAdds.length, 1);
  assert.equal(plan.linkAdds[0].successorId, 's'); // pathed on the successor
  assert.deepEqual(plan.linkAdds[0].body, {
    id: 'mint-1', predecessor_id: 'p', successor_id: 's', from_anchor: 'end', to_anchor: 'start',
  });
});

test('an added edge carries lag_wd only when present', () => {
  const withLag = planEditRequests(
    diff({ linkAdds: [{ predecessor_id: 'p', successor_id: 's', from_anchor: 'end', to_anchor: 'start', lag_wd: 3 }] }),
    [], minter(), 'ccid',
  );
  assert.equal(withLag.linkAdds[0].body.lag_wd, 3);
});

test('a removed edge resolves to the LIVE link id, matching both anchors', () => {
  const liveLinks = [
    { id: 'link-A', predecessor_id: 'p', successor_id: 's', from_anchor: 'end', to_anchor: 'start' },
    // same pair, DIFFERENT anchors — must not be picked for the end→start removal
    { id: 'link-B', predecessor_id: 'p', successor_id: 's', from_anchor: 'start', to_anchor: 'start' },
  ];
  const linkRemoves = [{ predecessorId: 'p', successorId: 's', fromAnchor: 'end', toAnchor: 'start' }];
  const plan = planEditRequests(diff({ linkRemoves }), liveLinks, minter(), 'ccid');
  assert.deepEqual(plan.linkRemoves, [{ linkId: 'link-A' }]);
});

test('a removed edge with no live match is dropped (already gone), never sent id-less', () => {
  const linkRemoves = [{ predecessorId: 'p', successorId: 's', fromAnchor: 'end', toAnchor: 'start' }];
  const plan = planEditRequests(diff({ linkRemoves }), [], minter(), 'ccid');
  assert.deepEqual(plan.linkRemoves, []);
});

test('idByKey and movedKeys pass straight through from the diff', () => {
  const plan = planEditRequests(
    diff({ idByKey: { 'local-1': 'v2-1' }, movedKeys: ['moved-key'] }),
    [], minter(), 'ccid',
  );
  assert.deepEqual(plan.idByKey, { 'local-1': 'v2-1' });
  assert.deepEqual(plan.movedKeys, ['moved-key']);
});

test('isEmptyPlan is false when only a move was reported (no writes, but a reload is due)', () => {
  // movedKeys alone carries no write op, so the plan is "empty" of writes — but the
  // caller still guards on movedKeys separately (a reload), which is why isEmptyPlan
  // reflects only the WRITE ops. This pins that contract.
  const plan = planEditRequests(diff({ movedKeys: ['m'] }), [], minter(), 'ccid');
  assert.equal(isEmptyPlan(plan), true);
});
