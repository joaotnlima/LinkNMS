// Unit tests for the v2 plan-grid INCREMENTAL-EDIT diff (LINA-320, S3).
//
// The rules worth pinning: a node present only in `next` is a CREATE (client-minted
// id, parent resolves to an existing v2 id or a sibling-new minted id); a node only
// in `prev` is a DELETE emitted on the TOPMOST removed row (the server cascades);
// a node in both with changed fields is an `updateTask` carrying ONLY the changed
// fields; edge changes on an EXISTING successor become link add/remove; a reparent
// is REPORTED in `movedKeys`, never silently emitted; and a no-op save yields an
// empty diff. Assignment is never diffed (v2 inherits it).
//
// Run: node --experimental-strip-types --test src/lib/v2/plan-diff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffPlanTrees, diffFields, isEmptyDiff } from './plan-diff.ts';

// A deterministic id minter — the whole reason `mintId` is injected.
const counter = () => {
  let n = 0;
  return () => `new-${++n}`;
};

// A minimal AuthoredNode (the shape `plan-authoring.ts#toWire` emits, and the shape
// `planning-hydrate.ts` produces — where key === v2 id for an existing row).
const node = (over = {}) => ({
  name: 'Node', key: 'k', dependsOn: [],
  description: null, assigneePartyId: null, trade: null,
  plannedStartDate: null, plannedEndDate: null,
  ...over,
});

// ── CREATES ────────────────────────────────────────────────────────────────────

test('a wholly new plan is one create_rows op, pre-order, parents before children', () => {
  const next = [
    node({ key: 'kp', name: 'Phase', children: [
      node({ key: 'kt', name: 'Task', children: [
        node({ key: 'ks', name: 'Sub' }),
      ] }),
    ] }),
  ];
  const diff = diffPlanTrees([], next, counter());
  assert.equal(diff.createOp?.op, 'create_rows');
  const rows = diff.createOp.rows;
  assert.deepEqual(rows.map((r) => r.name), ['Phase', 'Task', 'Sub']); // pre-order
  // parent chain by minted id
  const [p, t, s] = rows;
  assert.equal(p.parent_id, null);
  assert.equal(t.parent_id, p.id);
  assert.equal(s.parent_id, t.id);
  assert.deepEqual(diff.idByKey, { kp: p.id, kt: t.id, ks: s.id });
  assert.equal(diff.deletes.length, 0);
  assert.equal(diff.updates.length, 0);
});

test('a new row added under an EXISTING parent names the parent by its v2 id', () => {
  const prev = [node({ key: 'PID', name: 'Phase' })]; // key === v2 id
  const next = [node({ key: 'PID', name: 'Phase', children: [node({ key: ' knew', name: 'Fresh' })] })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.equal(diff.createOp.rows.length, 1);
  assert.equal(diff.createOp.rows[0].parent_id, 'PID'); // existing parent's id, not minted
  assert.equal(diff.createOp.rows[0].name, 'Fresh');
  assert.equal(diff.updates.length, 0); // the existing phase did not change
});

test('a new row carries dating_mode/specialty/description like the create seam', () => {
  const next = [node({ key: 'k1', name: 'Dated', plannedStartDate: '2026-01-05', plannedEndDate: '2026-01-09', trade: 'Framing', description: 'note' })];
  const [row] = diffPlanTrees([], next, counter()).createOp.rows;
  assert.equal(row.dating_mode, 'dated');
  assert.equal(row.start, '2026-01-05');
  assert.equal(row.finish, '2026-01-09');
  assert.equal(row.specialty, 'Framing');
  assert.equal(row.description, 'note');
});

test('a new row with no start is stored undated', () => {
  const next = [node({ key: 'k1', name: 'Undated' })];
  const [row] = diffPlanTrees([], next, counter()).createOp.rows;
  assert.equal(row.dating_mode, 'undated');
});

// ── DELETES ──────────────────────────────────────────────────────────────────

test('a removed subtree emits ONE delete on its topmost row, not per descendant', () => {
  const prev = [node({ key: 'P', name: 'Phase', children: [
    node({ key: 'T', name: 'Task', children: [node({ key: 'S', name: 'Sub' })] }),
  ] })];
  const next = []; // whole plan cleared
  const diff = diffPlanTrees(prev, next, counter());
  assert.deepEqual(diff.deletes, ['P']); // topmost only; server cascades T + S
});

test('deleting a middle task emits just that task, siblings untouched', () => {
  const prev = [node({ key: 'P', children: [node({ key: 'T1' }), node({ key: 'T2' })] })];
  const next = [node({ key: 'P', children: [node({ key: 'T1' })] })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.deepEqual(diff.deletes, ['T2']);
  assert.equal(diff.createOp, null);
  assert.equal(diff.updates.length, 0);
});

// ── UPDATES ──────────────────────────────────────────────────────────────────

test('a rename on an existing row is one updateTask with only the changed field', () => {
  const prev = [node({ key: 'T', name: 'Old' })];
  const next = [node({ key: 'T', name: 'New' })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.deepEqual(diff.updates, [{ taskId: 'T', changes: { name: 'New' } }]);
});

test('no change yields an empty diff (a debounce that fired on a selection)', () => {
  const prev = [node({ key: 'T', name: 'Same', trade: 'Plumbing' })];
  const next = [node({ key: 'T', name: 'Same', trade: 'Plumbing' })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.ok(isEmptyDiff(diff));
});

test('setting a date on an undated row flips dating_mode to dated', () => {
  const prev = [node({ key: 'T', plannedStartDate: null, plannedEndDate: null })];
  const next = [node({ key: 'T', plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-03' })];
  const c = diffFields(prev[0], next[0]);
  assert.equal(c.start, '2026-02-01');
  assert.equal(c.finish, '2026-02-03');
  assert.equal(c.dating_mode, 'dated');
});

test('clearing a date flips dating_mode to undated', () => {
  const prev = [node({ key: 'T', plannedStartDate: '2026-02-01' })];
  const next = [node({ key: 'T', plannedStartDate: null })];
  const c = diffFields(prev[0], next[0]);
  assert.equal(c.start, null);
  assert.equal(c.dating_mode, 'undated');
});

test('clearing specialty/description sends null, not omitted', () => {
  const prev = [node({ key: 'T', trade: 'Framing', description: 'x' })];
  const next = [node({ key: 'T', trade: null, description: null })];
  const c = diffFields(prev[0], next[0]);
  assert.equal(c.specialty, null);
  assert.equal(c.description, null);
});

test('assignment is never diffed (v2 inherits it from the branch contract)', () => {
  const prev = [node({ key: 'T', assigneePartyId: 'party-a' })];
  const next = [node({ key: 'T', assigneePartyId: 'party-b' })];
  assert.equal(diffFields(prev[0], next[0]), null); // no assignee field in the delta
  assert.ok(isEmptyDiff(diffPlanTrees(prev, next, counter())));
});

// ── LINKS ──────────────────────────────────────────────────────────────────────

test('an edge added on an existing successor is a linkAdd (existing predecessor by id)', () => {
  const prev = [node({ key: 'A' }), node({ key: 'B' })];
  const next = [node({ key: 'A' }), node({ key: 'B', dependsOn: [{ key: 'A', type: 'starts_after' }] })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.deepEqual(diff.linkAdds, [{ predecessor_id: 'A', successor_id: 'B', from_anchor: 'end', to_anchor: 'start' }]);
  assert.equal(diff.linkRemoves.length, 0);
});

test('an edge removed on an existing successor is a linkRemoval naming the pair + anchors', () => {
  const prev = [node({ key: 'A' }), node({ key: 'B', dependsOn: [{ key: 'A', type: 'starts_with' }] })];
  const next = [node({ key: 'A' }), node({ key: 'B' })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.deepEqual(diff.linkRemoves, [{ predecessorId: 'A', successorId: 'B', fromAnchor: 'start', toAnchor: 'start' }]);
  assert.equal(diff.linkAdds.length, 0);
});

test('changing an edge TYPE is a remove of the old + an add of the new', () => {
  const prev = [node({ key: 'A' }), node({ key: 'B', dependsOn: [{ key: 'A', type: 'starts_after' }] })];
  const next = [node({ key: 'A' }), node({ key: 'B', dependsOn: [{ key: 'A', type: 'ends_with' }] })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.equal(diff.linkAdds.length, 1);
  assert.equal(diff.linkAdds[0].to_anchor, 'end');
  assert.equal(diff.linkRemoves.length, 1);
  assert.equal(diff.linkRemoves[0].toAnchor, 'start'); // the old starts_after
});

test('a new row that depends on an existing row rides createOp links, not linkAdds', () => {
  const prev = [node({ key: 'A' })];
  const next = [node({ key: 'A' }), node({ key: 'kNew', dependsOn: [{ key: 'A', type: 'starts_after' }] })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.equal(diff.linkAdds.length, 0); // successor is new → link is on the create batch
  assert.equal(diff.createOp.links.length, 1);
  assert.equal(diff.createOp.links[0].predecessor_id, 'A');
  assert.equal(diff.createOp.links[0].successor_id, diff.createOp.rows[0].id);
});

test('an edge whose predecessor was deleted this save is dropped, not sent dangling', () => {
  const prev = [node({ key: 'A' }), node({ key: 'B', dependsOn: [{ key: 'A', type: 'starts_after' }] })];
  // A removed; B keeps the (now dangling) edge in its draft.
  const next = [node({ key: 'B', dependsOn: [{ key: 'A', type: 'starts_after' }] })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.deepEqual(diff.deletes, ['A']);
  // The edge to A is not re-added (unchanged from prev anyway) and never sent as an add.
  assert.equal(diff.linkAdds.length, 0);
});

// ── MOVES (the documented deferral) ─────────────────────────────────────────────

test('a reparent is REPORTED in movedKeys, never emitted as an op', () => {
  const prev = [
    node({ key: 'P1', children: [node({ key: 'T' })] }),
    node({ key: 'P2' }),
  ];
  const next = [
    node({ key: 'P1' }),
    node({ key: 'P2', children: [node({ key: 'T' })] }), // T moved P1 → P2
  ];
  const diff = diffPlanTrees(prev, next, counter());
  assert.deepEqual(diff.movedKeys, ['T']);
  assert.equal(diff.createOp, null); // not recreated
  assert.equal(diff.deletes.length, 0); // not deleted
  assert.ok(!isEmptyDiff(diff)); // a move is not a no-op
});

test('a rename-and-reparent in one save keeps the rename AND reports the move', () => {
  const prev = [node({ key: 'P1', children: [node({ key: 'T', name: 'Old' })] }), node({ key: 'P2' })];
  const next = [node({ key: 'P1' }), node({ key: 'P2', children: [node({ key: 'T', name: 'New' })] })];
  const diff = diffPlanTrees(prev, next, counter());
  assert.deepEqual(diff.movedKeys, ['T']);
  assert.deepEqual(diff.updates, [{ taskId: 'T', changes: { name: 'New' } }]);
});

// ── COMBINED ─────────────────────────────────────────────────────────────────

test('add + delete + update + link in one save each land in their own bucket', () => {
  const prev = [
    node({ key: 'P', children: [
      node({ key: 'T1', name: 'Keep' }),
      node({ key: 'T2', name: 'Drop' }),
    ] }),
  ];
  const next = [
    node({ key: 'P', children: [
      node({ key: 'T1', name: 'Renamed', dependsOn: [{ key: 'kAdd', type: 'starts_after' }] }),
      node({ key: 'kAdd', name: 'Added' }),
    ] }),
  ];
  const diff = diffPlanTrees(prev, next, counter());
  assert.deepEqual(diff.deletes, ['T2']);
  assert.equal(diff.createOp.rows.length, 1);
  assert.equal(diff.createOp.rows[0].name, 'Added');
  assert.deepEqual(diff.updates, [{ taskId: 'T1', changes: { name: 'Renamed' } }]);
  // T1 (existing) now depends on kAdd (new) → linkAdd with the minted predecessor id.
  assert.equal(diff.linkAdds.length, 1);
  assert.equal(diff.linkAdds[0].successor_id, 'T1');
  assert.equal(diff.linkAdds[0].predecessor_id, diff.idByKey['kAdd']);
});
