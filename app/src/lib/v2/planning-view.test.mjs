// Unit tests for the v2 plan-grid wire→view transforms (LINA-320, S3).
//
// The rules worth pinning: the flat v2 WBS rebuilds into the grid's nested tree
// ordered by fractional position; `verified` folds into `done` for the four-state
// meter; the plan is "baselined" only once a leaf carries a bound baseline (the
// honest-meter switch, ADR-0019); typed links map by anchor pair and an
// unmodelled start→end link is DROPPED, not guessed; and the org id — not a
// person — fills the grid's party slot.
//
// Run: node --experimental-strip-types --test src/lib/v2/planning-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toStageStatus, toDependencyType, toCostCents,
  toStageRows, isBaselined, toDependencies, toPlanGridView,
  findRowByKey, collectRowKeys,
} from './planning-view.ts';

const task = (over = {}) => ({
  id: 't1', project_id: 'proj', parent_id: null, depth: 0, position: 'a0',
  kind: 'task', name: 'Task', start: '2026-01-01', finish: '2026-01-05',
  baseline: null, status: 'not_started', ...over,
});

test('toStageStatus: verified folds into done, the rest pass through', () => {
  assert.equal(toStageStatus('verified'), 'done');
  assert.equal(toStageStatus('done'), 'done');
  assert.equal(toStageStatus('not_started'), 'not_started');
  assert.equal(toStageStatus('in_progress'), 'in_progress');
  assert.equal(toStageStatus('blocked'), 'blocked');
});

test('toDependencyType: anchor pairs map to typed deps; start→end is dropped', () => {
  assert.equal(toDependencyType('end', 'start'), 'starts_after');
  assert.equal(toDependencyType('start', 'start'), 'starts_with');
  assert.equal(toDependencyType('end', 'end'), 'ends_with');
  assert.equal(toDependencyType('start', 'end'), null);
});

test('toCostCents: uses cost.mine, null when the roll-up is absent or empty', () => {
  assert.equal(toCostCents({ mine: { amount_cents: 12345, currency: 'EUR' } }), 12345);
  assert.equal(toCostCents({ revenue: { amount_cents: 9, currency: 'EUR' } }), null);
  assert.equal(toCostCents(undefined), null);
  assert.equal(toCostCents({}), null);
  assert.equal(toCostCents({ mine: { amount_cents: 0, currency: 'EUR' } }), 0); // free ≠ unpriced
});

test('toStageRows: flat list rebuilds into the nested tree', () => {
  const rows = toStageRows([
    task({ id: 'child2', parent_id: 'root', position: 'a1', name: 'Second' }),
    task({ id: 'root', parent_id: null, position: 'a0', kind: 'summary', name: 'Root' }),
    task({ id: 'child1', parent_id: 'root', position: 'a0', name: 'First' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'root');
  assert.equal(rows[0].children.length, 2);
  // siblings ordered by position, not by input array order
  assert.deepEqual(rows[0].children.map((r) => r.name), ['First', 'Second']);
});

test('toStageRows: maps specialty→trade, org→party slot, dates→start/end, id→key', () => {
  const [row] = toStageRows([task({
    id: 'x', specialty: 'Electrical', assignee: { org_id: 'org-9', person_id: 'p-1' },
    start: '2026-02-01', finish: '2026-02-10', cost: { mine: { amount_cents: 500, currency: 'EUR' } },
    status: 'in_progress',
  })]);
  assert.equal(row.trade, 'Electrical');
  assert.equal(row.assigneePartyId, 'org-9'); // ORG id, never the person
  assert.equal(row.key, 'x'); // stable v2 id doubles as the key
  assert.equal(row.start, '2026-02-01');
  assert.equal(row.end, '2026-02-10');
  assert.equal(row.costCents, 500);
  assert.equal(row.status, 'in_progress');
});

test('toStageRows: a clipped parent (filtered read) surfaces its subtree as a root', () => {
  // parent_id names a task not in the list (?root= clipped it) → treat as root.
  const rows = toStageRows([task({ id: 'orphan', parent_id: 'gone', position: 'a0' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'orphan');
});

test('toStageRows: unassigned / unpriced / untraded rows degrade to null, not undefined', () => {
  const [row] = toStageRows([task({ id: 'bare' })]);
  assert.equal(row.trade, null);
  assert.equal(row.assigneePartyId, null);
  assert.equal(row.costCents, null);
});

test('isBaselined: false until a leaf carries a bound baseline', () => {
  assert.equal(isBaselined([task(), task()]), false);
  assert.equal(isBaselined([task({ baseline: { start: null, finish: null } })]), false); // empty baseline ≠ bound
  assert.equal(isBaselined([
    task(),
    task({ id: 't2', baseline: { start: '2026-01-01', finish: '2026-01-05', version: 1 } }),
  ]), true);
});

test('toDependencies: keyed by successor; start→end dropped', () => {
  const deps = toDependencies([
    { id: 'l1', predecessor_id: 'a', successor_id: 'b', from_anchor: 'end', to_anchor: 'start' },
    { id: 'l2', predecessor_id: 'c', successor_id: 'b', from_anchor: 'start', to_anchor: 'start' },
    { id: 'l3', predecessor_id: 'd', successor_id: 'e', from_anchor: 'start', to_anchor: 'end' }, // dropped
  ]);
  assert.deepEqual(deps.b, [{ on: 'a', type: 'starts_after' }, { on: 'c', type: 'starts_with' }]);
  assert.equal(deps.e, undefined); // unmodelled link is not invented
});

test('toPlanGridView: assembles the whole body and survives empty inputs', () => {
  const view = toPlanGridView({ project_id: 'proj', tasks: [], links: [] });
  assert.equal(view.projectId, 'proj');
  assert.deepEqual(view.rows, []);
  assert.equal(view.isBaselined, false);
  assert.deepEqual(view.dependenciesBySuccessor, {});

  const full = toPlanGridView({
    project_id: 'proj',
    tasks: [task({ id: 'root', kind: 'summary', baseline: { start: '2026-01-01', finish: '2026-01-05', version: 2 } })],
    links: [],
  });
  assert.equal(full.isBaselined, true);
  assert.equal(full.rows[0].id, 'root');
});

test('toPlanGridView: tolerates missing tasks/links arrays', () => {
  const view = toPlanGridView({ project_id: 'proj' });
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.dependenciesBySuccessor, {});
});

// ── findRowByKey / collectRowKeys (LINA-396, the task permalink's resolver) ────

const grid = () => toStageRows([
  task({ id: 'phase', parent_id: null, position: 'a0', kind: 'summary', name: 'Foundations' }),
  task({ id: 'taskA', parent_id: 'phase', position: 'a0', name: 'Excavate' }),
  task({ id: 'sub', parent_id: 'taskA', position: 'a0', name: 'Mark out' }),
]);

test('findRowByKey: matches on the row id (= key in v2) with trail + depth', () => {
  const rows = grid();
  assert.equal(findRowByKey(rows, 'phase').depth, 0);
  assert.deepEqual(findRowByKey(rows, 'phase').trail, []);

  const taskHit = findRowByKey(rows, 'taskA');
  assert.equal(taskHit.depth, 1);
  assert.deepEqual(taskHit.trail, ['Foundations']);
  assert.equal(taskHit.row.name, 'Excavate');

  const subHit = findRowByKey(rows, 'sub');
  assert.equal(subHit.depth, 2);
  assert.deepEqual(subHit.trail, ['Foundations', 'Excavate']); // phase → task, outermost first
});

test('findRowByKey: an unknown or empty key is null (the permalink 404)', () => {
  assert.equal(findRowByKey(grid(), 'nope'), null);
  assert.equal(findRowByKey(grid(), ''), null);
  assert.equal(findRowByKey([], 'phase'), null);
});

test('collectRowKeys: every row id, depth-first (the editor savedStageKeys seed)', () => {
  assert.deepEqual(collectRowKeys(grid()), ['phase', 'taskA', 'sub']);
  assert.deepEqual(collectRowKeys([]), []);
});
