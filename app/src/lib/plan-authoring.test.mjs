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
  hydrateDraft, seedFromTemplate, toTemplateBody,
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

// ── Plan templates (LINA-242, ADR-0018) ──────────────────────────────────────
// The FE half of the template slice is two mappings and nothing else: a resolved
// template body scaffolds a draft, and the draft maps back to a names-only body.
// The interesting one is the way back — what it DROPS is the contract.

test('seedFromTemplate: scaffolds a draft from a resolved template body', () => {
  const body = [
    { name: 'Groundworks', tasks: ['Excavate', 'Footings'] },
    { name: 'Handover', tasks: [] },
  ];
  const phases = seedFromTemplate(body);

  assert.equal(phases.length, 2);
  assert.equal(phases[0].name, 'Groundworks');
  assert.deepEqual(phases[0].tasks.map((t) => t.name), ['Excavate', 'Footings']);
  assert.equal(phases[1].tasks.length, 0, 'a phase with no tasks scaffolds empty, not dropped');

  // Names only: a template carries no dates and no descriptions, so the author
  // starts with those blank — they are per-project answers, not shape.
  for (const p of phases) {
    assert.ok(p.key);
    for (const t of p.tasks) {
      assert.equal(t.start, '');
      assert.equal(t.end, '');
      assert.equal(t.description, '');
      assert.ok(t.key);
    }
  }

  // Fresh React keys each call — two scaffolds of the same body never collide.
  assert.notEqual(seedFromTemplate(body)[0].key, phases[0].key);
});

test('seedFromTemplate: the built-in skeleton is just one template body', () => {
  // seedSkeleton is now the FALLBACK path through the same mapping, so the two
  // cannot drift: an unreachable endpoint yields the same editor shape.
  const viaSkeleton = seedSkeleton();
  const viaTemplate = seedFromTemplate(PLAN_SKELETON);
  assert.deepEqual(
    viaSkeleton.map((p) => [p.name, p.tasks.map((t) => t.name)]),
    viaTemplate.map((p) => [p.name, p.tasks.map((t) => t.name)]),
  );
});

test('toTemplateBody: names only, two levels — dates and descriptions are dropped', () => {
  const body = toTemplateBody([
    { key: 'p1', name: '  Groundworks  ', tasks: [
      { key: 't1', name: '  Excavate  ', start: '2026-03-01', end: '2026-03-10', description: 'to 1.2m' },
      { key: 't2', name: 'Footings', start: '', end: '2026-03-20', description: '' },
    ] },
  ]);

  assert.deepEqual(body, [{ name: 'Groundworks', tasks: ['Excavate', 'Footings'] }]);

  // The shape assertion the edge enforces (`too_deep` / extra-key refusals): a
  // phase carries ONLY { name, tasks }, and a task is a bare string.
  for (const phase of body) {
    assert.deepEqual(Object.keys(phase).sort(), ['name', 'tasks']);
    for (const task of phase.tasks) assert.equal(typeof task, 'string');
  }
});

test('toTemplateBody: an emptied phase is skipped, a nameless one refuses', () => {
  // A phase the author emptied out entirely — same tolerance as toWire.
  const body = toTemplateBody([
    { key: 'p1', name: '', tasks: [] },
    { key: 'p2', name: 'Real', tasks: [{ key: 't1', name: 'Task', start: '', end: '', description: '' }] },
  ]);
  assert.deepEqual(body, [{ name: 'Real', tasks: ['Task'] }]);

  // A nameless phase that still holds tasks is a mistake, not an omission.
  assert.throws(() => toTemplateBody([
    { key: 'p1', name: '   ', tasks: [{ key: 't1', name: 'Task', start: '', end: '', description: '' }] },
  ]), (e) => e instanceof PlanAuthorError && e.code === 'invalid_name');
});

test('toTemplateBody: an unnamed task is dropped, never sent blank', () => {
  // Unlike toWire there is no "dated but unnamed" case to rescue — dates do not
  // survive the mapping — so a nameless row is simply not part of the shape.
  // The edge refuses an empty task name, so sending one would be a 400.
  const body = toTemplateBody([
    { key: 'p1', name: 'Phase A', tasks: [
      { key: 't1', name: 'Kept', start: '', end: '', description: '' },
      { key: 't2', name: '   ', start: '2026-03-01', end: '', description: 'note' },
    ] },
  ]);
  assert.deepEqual(body, [{ name: 'Phase A', tasks: ['Kept'] }]);
});

test('toTemplateBody: nothing to save refuses with empty_plan', () => {
  assert.throws(() => toTemplateBody([{ key: 'p', name: '', tasks: [] }]),
    (e) => e instanceof PlanAuthorError && e.code === 'empty_plan');
  assert.throws(() => toTemplateBody([]),
    (e) => e instanceof PlanAuthorError && e.code === 'empty_plan');
});

test('toTemplateBody: the skeleton round-trips through a save and a re-seed', () => {
  // The loop that matters in the product: scaffold → save as my default → the
  // next build scaffolds from exactly that. Structure must survive untouched.
  const first = seedSkeleton();
  const saved = toTemplateBody(first);
  const next = seedFromTemplate(saved);
  assert.deepEqual(
    next.map((p) => [p.name, p.tasks.map((t) => t.name)]),
    first.map((p) => [p.name, p.tasks.map((t) => t.name)]),
  );
});
