// Unit tests for the v2 plan-grid hydration seam (LINA-320, S3).
//
// The rules worth pinning: the nested StageRow tree hydrates into the editor's
// up-to-5-level draft (PRD-01 G-1); a row below level 5 is DROPPED at the cap; `null` trade/dates normalise to the empty string the editor uses;
// the org-as-party id passes through; typed links re-attach per successor and an
// edge to an un-rendered (dropped/absent) predecessor is DROPPED, not drawn; and
// the status meter is carried ONLY on a baselined plan (all-grey on a draft,
// ADR-0019).
//
// Run: node --experimental-strip-types --test src/lib/v2/planning-hydrate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planGridToDraft, HYDRATE_MAX_DEPTH } from './planning-hydrate.ts';
import { MAX_DEPTH, toWire } from '../plan-authoring.ts';

// A single branch `levels` deep (phase = level 1), ids l1..lN.
const branch = (levels) => {
  let node = null;
  for (let l = levels; l >= 1; l -= 1) node = row({ id: `l${l}`, name: `L${l}`, children: node ? [node] : [] });
  return node;
};

const row = (over = {}) => ({
  id: 'r1', key: 'r1', name: 'Row', trade: null, assigneePartyId: null,
  start: null, end: null, costCents: null, status: 'not_started', children: [],
  ...over,
});

const view = (over = {}) => ({
  projectId: 'proj', rows: [], isBaselined: false, dependenciesBySuccessor: {}, ...over,
});

test('phases/tasks/subtasks: the tree hydrates into the nested draft', () => {
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

test('the hydrate cap is the editor cap', () => {
  assert.equal(HYDRATE_MAX_DEPTH, MAX_DEPTH);
});

test('levels 4 and 5 hydrate (no longer dropped); level 6 is dropped at the cap', () => {
  const [phase] = planGridToDraft(view({ rows: [branch(6)] }));
  const l4 = phase.tasks[0].children[0].children[0];
  assert.equal(l4.key, 'l4');
  const l5 = l4.children[0];
  assert.equal(l5.key, 'l5');
  assert.deepEqual(l5.children, []); // the 6th level never reaches the editor
  // And a 5-level plan saves without a too_deep refusal.
  assert.doesNotThrow(() => toWire(planGridToDraft(view({ rows: [branch(5)] }))));
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

test('a dep pointing past the level-5 cap is dropped; one at level 5 survives', () => {
  const v = view({
    rows: [branch(6)],
    // l3 depends on l6 (dropped at the cap) and on l5 (rendered).
    dependenciesBySuccessor: { l3: [{ on: 'l6', type: 'starts_after' }, { on: 'l5', type: 'ends_with' }] },
  });
  const l3 = planGridToDraft(v)[0].tasks[0].children[0];
  assert.deepEqual(l3.dependsOn, [{ on: 'l5', type: 'ends_with' }]);
});

test('reported status round-trips on a draft as well as a baselined plan (LINA-404)', () => {
  const rows = [row({ id: 'p1', children: [row({ id: 't1', status: 'in_progress' })] })];
  // A status the owner reported survives the read on a DRAFT plan now — it used to
  // be dropped unless baselined ("status not recorded", the founder's reopen).
  const draftTask = planGridToDraft(view({ rows, isBaselined: false }))[0].tasks[0];
  assert.equal(draftTask.status, 'in_progress');

  const liveTask = planGridToDraft(view({ rows, isBaselined: true }))[0].tasks[0];
  assert.equal(liveTask.status, 'in_progress');
});

test('an unreported row stays status-less so the meter is all-grey by default (ADR-0019)', () => {
  // The honest default holds: a row the server reports as `not_started` carries no
  // status, so a fresh/untouched plan still reads all-grey.
  const rows = [row({ id: 'p1', children: [row({ id: 't1', status: 'not_started' })] })];
  const draftTask = planGridToDraft(view({ rows, isBaselined: false }))[0].tasks[0];
  assert.equal('status' in draftTask, false);
});

test('an empty plan hydrates to an empty draft (the fail-closed / no-plan state)', () => {
  assert.deepEqual(planGridToDraft(view()), []);
});
