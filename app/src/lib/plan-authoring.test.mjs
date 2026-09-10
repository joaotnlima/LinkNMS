// Unit tests for the direct plan-authoring client helpers (LINA-228, ADR-0017).
//
// The screen is copy + layout; these seams are the logic:
//   1. the seeded skeleton matches the pen (names only — no dates, no sub-tasks);
//   2. the pure draft ops add / rename / reorder / remove without mutating;
//   3. `toWire` enforces the two-level contract, drops empty phases, refuses a
//      nameless one, and normalises blank dates to null — exactly what the server
//      re-validates, so the author sees the refusal beside the field.
//
// Run: node --test src/lib/plan-authoring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_SKELETON, seedSkeleton, emptyPhase, addPhase, addTask, renamePhase, renameTask,
  movePhase, moveTask, reorderPhase, reorderTask,
  removePhase, removeTask, setTaskDate, setTaskDescription, taskCount, toWire, PlanAuthorError,
  hydrateDraft,
} from './plan-authoring.ts';

test('skeleton: three phases, names only, no dates or sub-tasks (the issue scope)', () => {
  assert.equal(PLAN_SKELETON.length, 3);
  assert.equal(PLAN_SKELETON[0].name, '1 · Pre-Construction');
  assert.equal(PLAN_SKELETON[0].tasks[0], '1.1 Planning & Feasibility');

  const phases = seedSkeleton();
  assert.equal(phases.length, 3);
  for (const p of phases) {
    assert.ok(p.key && p.name);
    for (const t of p.tasks) {
      assert.equal(t.start, '');
      assert.equal(t.end, '');
      assert.ok(t.key && t.name);
    }
  }
  // Fresh keys each call — two seeds never collide.
  assert.notEqual(seedSkeleton()[0].key, seedSkeleton()[0].key);
});

test('draft ops are pure and do what they say', () => {
  let phases = seedSkeleton();
  const before = phases;

  phases = renamePhase(phases, 0, 'Phase One');
  assert.equal(phases[0].name, 'Phase One');
  assert.equal(before[0].name, '1 · Pre-Construction', 'original untouched (no mutation)');

  const n0 = phases[0].tasks.length;
  phases = addTask(phases, 0);
  assert.equal(phases[0].tasks.length, n0 + 1);

  phases = renameTask(phases, 0, n0, 'New task');
  assert.equal(phases[0].tasks[n0].name, 'New task');

  phases = removeTask(phases, 0, n0);
  assert.equal(phases[0].tasks.length, n0);

  // Reorder the first two phases and back.
  const firstKey = phases[0].key;
  phases = movePhase(phases, 0, 1);
  assert.equal(phases[1].key, firstKey);
  phases = movePhase(phases, 0, -5); // out-of-range is a no-op
  assert.equal(phases[1].key, firstKey);

  phases = addPhase(phases);
  assert.equal(phases[phases.length - 1].tasks.length, 0);
  assert.equal(emptyPhase('X').name, 'X');

  phases = moveTask(phases, 0, 0, 1);
  phases = setTaskDate(phases, 0, 0, 'start', '2026-03-01');
  assert.equal(phases[0].tasks[0].start, '2026-03-01');

  phases = removePhase(phases, phases.length - 1);
  assert.ok(taskCount(phases) > 0);
});

test('reorder: drag-drop moves a row and slides the rest (insert, not swap)', () => {
  let phases = seedSkeleton();
  const keys = phases.map((p) => p.key);
  // Drag the last phase (idx 2) onto the first (idx 0): [2,0,1].
  phases = reorderPhase(phases, 2, 0);
  assert.deepEqual(phases.map((p) => p.key), [keys[2], keys[0], keys[1]]);
  // No-op / out-of-range drops return the same reference.
  assert.equal(reorderPhase(phases, 1, 1), phases);
  assert.equal(reorderPhase(phases, 0, 9), phases);

  // Tasks reorder within their phase only, and don't touch siblings.
  const tks = phases[0].tasks.map((t) => t.key);
  const siblingBefore = phases[1];
  phases = reorderTask(phases, 0, 0, tks.length - 1); // first task to the end
  assert.equal(phases[0].tasks[tks.length - 1].key, tks[0]);
  assert.equal(phases[0].tasks[0].key, tks[1]);
  assert.equal(phases[1], siblingBefore, 'other phases keep identity (no mutation)');
});

test('toWire: two levels, blank dates → null, empty phase dropped', () => {
  const phases = [
    { key: 'p1', name: 'Phase A', tasks: [
      { key: 't1', name: 'Task 1', start: '2026-03-01', end: '' },
      { key: 't2', name: '  ', start: '', end: '' }, // blank task dropped
    ] },
    { key: 'p2', name: 'Empty phase', tasks: [] }, // kept — a heading with no tasks is allowed
    { key: 'p3', name: '   ', tasks: [] }, // blank + empty → dropped silently
  ];
  const wire = toWire(phases);
  assert.equal(wire.length, 2);
  assert.equal(wire[0].name, 'Phase A');
  assert.equal(wire[0].children.length, 1);
  assert.equal(wire[0].children[0].name, 'Task 1');
  assert.equal(wire[0].children[0].plannedStartDate, '2026-03-01');
  assert.equal(wire[0].children[0].plannedEndDate, null);
  assert.equal(wire[1].name, 'Empty phase');
  assert.equal(wire[1].children.length, 0);
  // No node ever carries a third level.
  for (const s of wire) for (const c of s.children) assert.equal(c.children, undefined);
});

test('description: drawer field round-trips through toWire and hydrateDraft (LINA-234)', () => {
  // setTaskDescription is pure and edits only the targeted task.
  let phases = seedSkeleton();
  const before = phases;
  phases = setTaskDescription(phases, 0, 0, '  Pour the slab; 28-day cure.  ');
  assert.equal(phases[0].tasks[0].description, '  Pour the slab; 28-day cure.  ');
  assert.equal(before[0].tasks[0].description, '', 'original untouched (no mutation)');

  // toWire trims → the description crosses the wire; a blank one normalises to null.
  const wire = toWire([
    { key: 'p1', name: 'Phase A', tasks: [
      { key: 't1', name: 'Task 1', start: '', end: '', description: '  has body  ' },
      { key: 't2', name: 'Task 2', start: '', end: '', description: '   ' },
    ] },
  ]);
  assert.equal(wire[0].children[0].description, 'has body');
  assert.equal(wire[0].children[1].description, null);

  // A description-only task (no name) is not silently dropped — it surfaces the
  // name-required refusal instead of vanishing.
  assert.throws(() => toWire([
    { key: 'p1', name: 'Phase A', tasks: [{ key: 't1', name: '', start: '', end: '', description: 'orphan note' }] },
  ]), (e) => e instanceof PlanAuthorError && e.code === 'invalid_name');

  // hydrateDraft brings a saved description back into the editor model.
  const hydrated = hydrateDraft([
    { name: 'Phase A', children: [{ name: 'Task 1', description: 'saved body', plannedStartDate: null, plannedEndDate: null }] },
  ]);
  assert.equal(hydrated[0].tasks[0].description, 'saved body');
  // A stage with no description hydrates to '' (the editor's empty string).
  const hydrated2 = hydrateDraft([{ name: 'P', children: [{ name: 'T' }] }]);
  assert.equal(hydrated2[0].tasks[0].description, '');
});

test('toWire: a named phase with a nameless task refuses', () => {
  assert.throws(() => toWire([
    { key: 'p1', name: 'Phase A', tasks: [{ key: 't1', name: '', start: '2026-03-01', end: '' }] },
  ]), (e) => e instanceof PlanAuthorError && e.code === 'invalid_name');
});

test('toWire: nothing to send refuses with empty_plan', () => {
  assert.throws(() => toWire([{ key: 'p', name: '', tasks: [] }]),
    (e) => e instanceof PlanAuthorError && e.code === 'empty_plan');
});
