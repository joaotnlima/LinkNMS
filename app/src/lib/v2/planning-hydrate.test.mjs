// Unit tests for the v2 plan-grid hydration seam (LINA-320, S3).
//
// The rules worth pinning: the nested StageRow tree hydrates into the editor's
// 3-level phase/task/subtask draft; a row below a subtask is DROPPED at the
// depth-3 cap; `null` trade/dates normalise to the empty string the editor uses;
// the org-as-party id passes through; typed links re-attach per successor and an
// edge to an un-rendered (dropped/absent) predecessor is DROPPED, not drawn; and
// the status meter is carried ONLY on a baselined plan (all-grey on a draft,
// ADR-0019).
//
// Run: node --experimental-strip-types --test src/lib/v2/planning-hydrate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planGridToDraft } from './planning-hydrate.ts';

const row = (over = {}) => ({
  id: 'r1', key: 'r1', name: 'Row', trade: null, assigneePartyId: null,
  start: null, end: null, costCents: null, status: 'not_started', children: [],
  ...over,
});

const view = (over = {}) => ({
  projectId: 'proj', rows: [], isBaselined: false, dependenciesBySuccessor: {}, ...over,
});

test('phases/tasks/subtasks: the tree hydrates into the 3-level draft', () => {
  const v = view({
    rows: [row({
      id: 'p1', name: 'Phase', children: [
        row({ id: 't1', name: 'Task', children: [row({ id: 's1', name: 'Sub' })] }),
      ],
    })],
  });
  const [phase] = planGridToDraft(v);
  assert.equal(phase.key, 'p1');
  assert.equal(phase.name, 'Phase');
  assert.equal(phase.tasks.length, 1);
  const [task] = phase.tasks;
  assert.equal(task.key, 't1');
  assert.equal(task.children.length, 1);
  assert.equal(task.children[0].key, 's1');
  assert.equal(task.children[0].name, 'Sub');
});

test('depth-3 cap: a row below a subtask is dropped', () => {
  const v = view({
    rows: [row({
      id: 'p1', children: [
        row({ id: 't1', children: [
          row({ id: 's1', children: [row({ id: 'x1', name: 'Too deep' })] }),
        ] }),
      ],
    })],
  });
  const sub = planGridToDraft(v)[0].tasks[0].children[0];
  assert.equal(sub.key, 's1');
  assert.deepEqual(sub.children, []); // the 4th level never reaches the editor
});

test('null trade/dates normalise to the empty string the editor uses', () => {
  const v = view({ rows: [row({ id: 'p1', children: [row({ id: 't1', trade: null, start: null, end: null })] })] });
  const task = planGridToDraft(v)[0].tasks[0];
  assert.equal(task.trade, '');
  assert.equal(task.start, '');
  assert.equal(task.end, '');
  assert.equal(task.description, '');
});

test('real trade/dates and the org-as-party id pass through', () => {
  const v = view({
    rows: [row({
      id: 'p1', children: [row({
        id: 't1', trade: 'Electrical', start: '2026-01-01', end: '2026-01-05',
        assigneePartyId: 'org-42',
      })],
    })],
  });
  const task = planGridToDraft(v)[0].tasks[0];
  assert.equal(task.trade, 'Electrical');
  assert.equal(task.start, '2026-01-01');
  assert.equal(task.end, '2026-01-05');
  assert.equal(task.assigneePartyId, 'org-42');
});

test('typed links re-attach per successor, keyed by predecessor id', () => {
  const v = view({
    rows: [row({
      id: 'p1', children: [
        row({ id: 't1' }),
        row({ id: 't2' }),
      ],
    })],
    dependenciesBySuccessor: { t2: [{ on: 't1', type: 'starts_after' }] },
  });
  const tasks = planGridToDraft(v)[0].tasks;
  assert.deepEqual(tasks[0].dependsOn, []);
  assert.deepEqual(tasks[1].dependsOn, [{ on: 't1', type: 'starts_after' }]);
});

test('an edge to an un-rendered predecessor is dropped, not drawn dangling', () => {
  const v = view({
    rows: [row({ id: 'p1', children: [row({ id: 't1' })] })],
    // t1 depends on "ghost", which is not a row anywhere in the tree.
    dependenciesBySuccessor: { t1: [{ on: 'ghost', type: 'starts_after' }, { on: 'p1', type: 'ends_with' }] },
  });
  const task = planGridToDraft(v)[0].tasks[0];
  // ghost dropped; the edge to the (rendered) phase survives.
  assert.deepEqual(task.dependsOn, [{ on: 'p1', type: 'ends_with' }]);
});

test('a dep pointing past the depth-3 cap is dropped', () => {
  const v = view({
    rows: [row({
      id: 'p1', children: [row({
        id: 't1', children: [row({ id: 's1', children: [row({ id: 'x1' })] })],
      })],
    })],
    // s1 depends on x1, which is dropped at the depth cap and never rendered.
    dependenciesBySuccessor: { s1: [{ on: 'x1', type: 'starts_after' }] },
  });
  const sub = planGridToDraft(v)[0].tasks[0].children[0];
  assert.deepEqual(sub.dependsOn, []);
});

test('status meter is honest: carried on a baselined plan, absent on a draft', () => {
  const rows = [row({ id: 'p1', children: [row({ id: 't1', status: 'in_progress' })] })];
  const draftTask = planGridToDraft(view({ rows, isBaselined: false }))[0].tasks[0];
  assert.equal('status' in draftTask, false); // draft → all-grey, no status carried

  const liveTask = planGridToDraft(view({ rows, isBaselined: true }))[0].tasks[0];
  assert.equal(liveTask.status, 'in_progress'); // baselined → the real derived status shows
});

test('an empty plan hydrates to an empty draft (the fail-closed / no-plan state)', () => {
  assert.deepEqual(planGridToDraft(view()), []);
});
