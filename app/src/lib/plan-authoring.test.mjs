// Unit tests for the direct plan-authoring client helpers (LINA-228, ADR-0017).
//
// The screen is copy + layout; these seams are the logic:
//   1. the seeded skeleton matches the pen (names only — no dates, no sub-tasks);
//   2. the pure draft ops add / rename / reorder / remove without mutating;
//   3. `toWire` enforces the depth contract (three levels, never four — LINA-243),
//      drops empty phases, refuses a nameless one, and normalises blank dates to
//      null — exactly what the server re-validates, so the author sees the refusal
//      beside the field.
//
// Run: node --test src/lib/plan-authoring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_SKELETON, seedSkeleton, emptyPhase, addPhase, addTask, renamePhase, renameTask,
  movePhase, moveTask, reorderPhase, reorderTask,
  removePhase, removeTask, setTaskDate, setTaskDescription, taskCount, toWire, PlanAuthorError,
  hydrateDraft,
  // Dependencies (LINA-233).
  planNodes, dependencyChoices, dependsOnOf, setDependsOn, toggleDependency, detectCycle,
  // The third level (LINA-243).
  addSubtask, renameSubtask, setSubtaskDate, setSubtaskDates, setSubtaskDescription, removeSubtask,
  moveSubtask, reorderSubtask, subtaskCount,
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

test('toWire: a plan with no sub-tasks emits no third level, blank dates → null, empty phase dropped', () => {
  const phases = [
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 't1', name: 'Task 1', start: '2026-03-01', end: '', dependsOn: [] },
      { key: 't2', name: '  ', start: '', end: '', dependsOn: [] }, // blank task dropped
    ] },
    { key: 'p2', name: 'Empty phase', dependsOn: [], tasks: [] }, // kept — a heading with no tasks is allowed
    { key: 'p3', name: '   ', dependsOn: [], tasks: [] }, // blank + empty → dropped silently
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
  // A task with no sub-tasks omits `children` entirely — a two-level plan puts
  // exactly the bytes on the wire it did before the third level existed.
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
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 't1', name: 'Task 1', start: '', end: '', description: '  has body  ', dependsOn: [] },
      { key: 't2', name: 'Task 2', start: '', end: '', description: '   ', dependsOn: [] },
    ] },
  ]);
  assert.equal(wire[0].children[0].description, 'has body');
  assert.equal(wire[0].children[1].description, null);

  // A description-only task (no name) is not silently dropped — it surfaces the
  // name-required refusal instead of vanishing.
  assert.throws(() => toWire([
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [{ key: 't1', name: '', start: '', end: '', description: 'orphan note', dependsOn: [] }] },
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

// ── Dependencies ("depends on", LINA-233, ADR-0017 annex 2) ─────────────────
// The seams the picker, the chips and the save gate all rest on: the labels the
// author reads, which choices are offered, and the graph that crosses the wire.

test('planNodes: labels number by POSITION, and a hand-typed index is not doubled', () => {
  const phases = seedSkeleton();
  const nodes = planNodes(phases);
  // The skeleton names carry their own "1 · " / "1.2 " prefixes — stripped, so
  // the computed outline is the only number printed.
  assert.equal(nodes[0].label, '1 Pre-Construction');
  assert.equal(nodes[1].label, '1.1 Planning & Feasibility');
  // Prose that merely starts with a number keeps it (not an index).
  const typed = renameTask(renamePhase(phases, 0, 'Groundworks'), 0, 0, '3 bedroom fit-out');
  const t = planNodes(typed);
  assert.equal(t[0].label, '1 Groundworks');
  assert.equal(t[1].label, '1.1 3 bedroom fit-out');
  // A blank row still names itself rather than printing a bare number.
  assert.equal(planNodes([emptyPhase()])[0].label, '1 Untitled phase');
  // Reordering renumbers — the outline follows the plan, not the typing.
  assert.equal(planNodes(reorderPhase(phases, 0, 2))[0].name, 'Construction (Execution)');
});

test('dependencyChoices: every other stage is offered, grouped by phase; self and downstream are not', () => {
  let phases = [
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 'a1', name: 'A1', start: '', end: '', description: '', dependsOn: [] },
      { key: 'a2', name: 'A2', start: '', end: '', description: '', dependsOn: [] },
    ] },
    { key: 'p2', name: 'Phase B', dependsOn: [], tasks: [
      { key: 'b1', name: 'B1', start: '', end: '', description: '', dependsOn: [] },
    ] },
  ];
  // Cross-level and cross-phase are both legal targets (scope = any-stage).
  const keys = (k) => dependencyChoices(phases, k).flatMap((g) => g.options.map((o) => o.key));
  assert.deepEqual(keys('b1'), ['p1', 'a1', 'a2', 'p2']);
  assert.deepEqual(dependencyChoices(phases, 'b1').map((g) => g.phase.key), ['p1', 'p2']);

  // B1 after A2: now A2 (and anything upstream of it) may not be made to wait on
  // B1 — that is the cycle the server would refuse, kept off the menu.
  phases = toggleDependency(phases, 'b1', 'a2');
  assert.deepEqual(phases[1].tasks[0].dependsOn, ['a2']);
  assert.deepEqual(dependsOnOf(phases, 'b1'), ['a2'], 'read back by key, phase or task alike');
  assert.ok(!keys('a2').includes('b1'), 'a choice that would close a cycle is withheld');
  assert.ok(keys('a2').includes('a1'), 'unrelated stages are still offered');

  // A selected key is always offered back, so a link can be undone.
  assert.ok(keys('b1').includes('a2'));
  phases = toggleDependency(phases, 'b1', 'a2');
  assert.deepEqual(phases[1].tasks[0].dependsOn, [], 'toggle removes');
});

test('detectCycle: agrees with the server, and names the loop in order', () => {
  const phases = [
    { key: 'p1', name: 'P', dependsOn: [], tasks: [
      { key: 'x', name: 'X', start: '', end: '', description: '', dependsOn: ['y'] },
      { key: 'y', name: 'Y', start: '', end: '', description: '', dependsOn: ['x'] },
    ] },
  ];
  const cycle = detectCycle(phases);
  assert.ok(cycle, 'a two-node loop is caught');
  assert.deepEqual(new Set(cycle.map((n) => n.key)), new Set(['x', 'y']));
  assert.equal(detectCycle(setDependsOn(phases, 'y', [])), null);
  // A deep chain that does not close is not a cycle.
  assert.equal(detectCycle(setDependsOn(phases, 'x', ['p1'])), null);
});

test('removing a stage takes its inbound links with it', () => {
  let phases = [
    { key: 'p1', name: 'P', dependsOn: [], tasks: [
      { key: 't1', name: 'T1', start: '', end: '', description: '', dependsOn: [] },
      { key: 't2', name: 'T2', start: '', end: '', description: '', dependsOn: ['t1'] },
    ] },
  ];
  phases = removeTask(phases, 0, 0);
  assert.deepEqual(phases[0].tasks[0].dependsOn, [], 'a dangling key would 400 as unknown_dependency');
});

test('toWire: sends every node key and the whole graph, dropping edges to rows it did not send', () => {
  const phases = [
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 't1', name: 'Task 1', start: '', end: '', description: '', dependsOn: [] },
      // Blank row: not sent — so the edge naming it must not be sent either.
      { key: 't9', name: '  ', start: '', end: '', description: '', dependsOn: [] },
    ] },
    { key: 'p2', name: 'Phase B', dependsOn: ['p1'], tasks: [
      { key: 't2', name: 'Task 2', start: '', end: '', description: '', dependsOn: ['t1', 't9'] },
    ] },
  ];
  const wire = toWire(phases);
  assert.equal(wire[0].key, 'p1');
  assert.deepEqual(wire[0].dependsOn, [], 'always present — a cleared row must clear server-side');
  assert.equal(wire[0].children[0].key, 't1');
  assert.deepEqual(wire[1].dependsOn, ['p1'], 'a phase may follow a phase');
  assert.deepEqual(wire[1].children[0].dependsOn, ['t1'], 'the edge to the dropped blank row is gone');
});

test('hydrateDraft: server stage ids come back as local keys, dangling edges dropped', () => {
  const phases = hydrateDraft([
    { id: 's1', name: 'Phase A', dependsOn: [], children: [
      { id: 's2', name: 'Task 1', dependsOn: [] },
    ] },
    // Depends on a stage EARLIER in the tree and on one that is not in it at all.
    { id: 's3', name: 'Phase B', dependsOn: ['s2', 'gone'], children: [
      { id: 's4', name: 'Task 2', dependsOn: ['s3'] },
    ] },
  ]);
  assert.deepEqual(phases[1].dependsOn, [phases[0].tasks[0].key]);
  assert.deepEqual(phases[1].tasks[0].dependsOn, [phases[1].key]);
  // Re-saving the hydrated draft round-trips the graph through the local keys.
  const wire = toWire(phases);
  assert.deepEqual(wire[1].dependsOn, [wire[0].children[0].key]);
});

// ── The third level: sub-sub-actions (LINA-243, ADR-0019) ───────────────────
// The server now ACCEPTS three levels (LINA-238); these are the seams that make
// the client produce one — the ops the editor edits with, the labels the picker
// prints, the wire shape, and the round-trip back out of a saved draft.

test('sub-task ops: add / rename / date / describe / reorder / remove, all pure', () => {
  let phases = seedSkeleton();
  const before = phases;

  phases = addSubtask(phases, 0, 0);
  assert.equal(phases[0].tasks[0].children.length, 1);
  assert.equal(before[0].tasks[0].children.length, 0, 'original untouched (no mutation)');
  assert.equal(phases[0].tasks[1].children.length, 0, 'only the targeted task grew');
  assert.equal(phases[1], before[1], 'other phases keep identity');

  phases = renameSubtask(phases, 0, 0, 0, 'Order the rebar');
  assert.equal(phases[0].tasks[0].children[0].name, 'Order the rebar');

  phases = setSubtaskDate(phases, 0, 0, 0, 'start', '2026-04-01');
  phases = setSubtaskDate(phases, 0, 0, 0, 'end', '2026-04-03');
  assert.equal(phases[0].tasks[0].children[0].start, '2026-04-01');
  assert.equal(phases[0].tasks[0].children[0].end, '2026-04-03');

  phases = setSubtaskDescription(phases, 0, 0, 0, 'Grade 500, 12mm.');
  assert.equal(phases[0].tasks[0].children[0].description, 'Grade 500, 12mm.');

  // Reorder within its own task, insert semantics like every other level.
  phases = addSubtask(phases, 0, 0);
  phases = renameSubtask(phases, 0, 0, 1, 'Book the pump');
  const subKeys = phases[0].tasks[0].children.map((s) => s.key);
  phases = reorderSubtask(phases, 0, 0, 1, 0);
  assert.deepEqual(phases[0].tasks[0].children.map((s) => s.key), [subKeys[1], subKeys[0]]);
  assert.equal(reorderSubtask(phases, 0, 0, 0, 0)[0].tasks[0].children[0].key, subKeys[1], 'no-op drop');
  phases = moveSubtask(phases, 0, 0, 0, 1);
  assert.deepEqual(phases[0].tasks[0].children.map((s) => s.key), [subKeys[0], subKeys[1]]);
  assert.equal(subtaskCount(phases), 2);

  phases = removeSubtask(phases, 0, 0, 0);
  assert.deepEqual(phases[0].tasks[0].children.map((s) => s.key), [subKeys[1]]);
  assert.equal(subtaskCount(phases), 1);
  assert.equal(taskCount(phases), taskCount(before), 'sub-tasks are not counted as tasks');

  // Nothing nests below a sub-task: there is no op for it. That IS the cap.
  assert.deepEqual(phases[0].tasks[0].children[0].children, []);
});

test('setSubtaskDates writes both ends of a sub-task in one op and touches nothing else (LINA-244)', () => {
  let phases = [
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 't1', name: 'Framing', start: '2026-04-01', end: '2026-04-30', description: '', dependsOn: [], children: [
        { key: 's1', name: 'Order the rebar', start: '2026-04-02', end: '2026-04-04', description: 'n', dependsOn: [], children: [] },
        { key: 's2', name: 'Book the pump', start: '', end: '', description: '', dependsOn: [], children: [] },
      ] },
    ] },
  ];
  const before = phases;

  phases = setSubtaskDates(phases, 0, 0, 0, '2026-04-06', '2026-04-08');
  const sub = phases[0].tasks[0].children[0];
  assert.equal(sub.start, '2026-04-06');
  assert.equal(sub.end, '2026-04-08');
  assert.equal(sub.name, 'Order the rebar', 'the drag moves dates only');
  assert.equal(sub.description, 'n');

  // The parent task and the sibling sub-task are untouched — a sub-task bar drag
  // must never reschedule the row above or beside it.
  assert.equal(phases[0].tasks[0].start, '2026-04-01');
  assert.equal(phases[0].tasks[0].end, '2026-04-30');
  assert.equal(phases[0].tasks[0].children[1], before[0].tasks[0].children[1]);
  assert.equal(before[0].tasks[0].children[0].start, '2026-04-02', 'immutable: the input draft is unchanged');

  // Blanks round-trip as '' (an open bar dragged by one end stays open).
  phases = setSubtaskDates(phases, 0, 0, 1, '2026-05-01', '');
  assert.equal(phases[0].tasks[0].children[1].start, '2026-05-01');
  assert.equal(phases[0].tasks[0].children[1].end, '');
});

test('a sub-task is a stage: it is numbered 1.2.3, offered as a dependency, and takes its links when removed', () => {
  let phases = [
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 't1', name: 'Framing', start: '', end: '', description: '', dependsOn: [], children: [
        { key: 's1', name: 'Order the rebar', start: '', end: '', description: '', dependsOn: [], children: [] },
      ] },
      { key: 't2', name: 'Pour', start: '', end: '', description: '', dependsOn: ['s1'], children: [] },
    ] },
  ];
  const nodes = planNodes(phases);
  assert.deepEqual(nodes.map((n) => n.key), ['p1', 't1', 's1', 't2'], 'reading order: phase, task, its sub-tasks');
  assert.deepEqual(nodes.map((n) => n.level), [1, 2, 3, 2]);
  assert.equal(nodes[2].label, '1.1.1 Order the rebar');

  // Any stage may depend on a sub-task and a sub-task on any stage (any-stage
  // scope, ADR-0017 annex 2) — self and downstream stay off the menu.
  const keys = (k) => dependencyChoices(phases, k).flatMap((g) => g.options.map((o) => o.key));
  assert.deepEqual(keys('s1'), ['p1', 't1'], 't2 is downstream of s1, so it would loop');
  assert.ok(keys('t2').includes('s1'));

  phases = setDependsOn(phases, 's1', ['t1']);
  assert.deepEqual(dependsOnOf(phases, 's1'), ['t1'], 'read back by key at the third level too');
  assert.equal(phases[0].tasks[1].dependsOn.length, 1, 'a sibling row is not disturbed');
  phases = toggleDependency(phases, 's1', 't1');
  assert.deepEqual(dependsOnOf(phases, 's1'), [], 'toggle removes at the third level');

  // A cycle through a sub-task is caught by the same check the server runs.
  const looped = setDependsOn(phases, 's1', ['t2']);
  assert.ok(detectCycle(looped), 't2 → s1 → t2 is a loop');

  // Removing the sub-task takes the edge that named it, or the next save 400s.
  const pruned = removeSubtask(phases, 0, 0, 0);
  assert.deepEqual(pruned[0].tasks[1].dependsOn, []);
  // Removing the TASK takes its sub-tasks — and their inbound edges — with it.
  assert.deepEqual(removeTask(phases, 0, 0)[0].tasks[0].dependsOn, []);
});

test('toWire: a task emits its sub-tasks as children, blanks dropped, nameless refused', () => {
  const wire = toWire([
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 't1', name: 'Framing', start: '', end: '', description: '', dependsOn: [], children: [
        { key: 's1', name: ' Order the rebar ', start: '2026-04-01', end: '', description: ' 12mm ', dependsOn: ['t2'], children: [] },
        // Never filled in — dropped, and the edge naming it goes too.
        { key: 's9', name: '   ', start: '', end: '', description: '', dependsOn: [], children: [] },
      ] },
      { key: 't2', name: 'Pour', start: '', end: '', description: '', dependsOn: [], children: [] },
    ] },
  ]);
  const framing = wire[0].children[0];
  assert.equal(framing.children.length, 1, 'the blank sub-task is not sent');
  assert.equal(framing.children[0].name, 'Order the rebar', 'trimmed');
  assert.equal(framing.children[0].key, 's1');
  assert.equal(framing.children[0].description, '12mm');
  assert.equal(framing.children[0].plannedStartDate, '2026-04-01');
  assert.equal(framing.children[0].plannedEndDate, null);
  assert.deepEqual(framing.children[0].dependsOn, ['t2'], 'a sub-task may follow any stage');
  assert.equal(wire[0].children[1].children, undefined, 'a task with no sub-tasks omits the field');

  // A nameless sub-task under a named task is a refusal, not a silent drop.
  assert.throws(() => toWire([
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 't1', name: 'Framing', start: '', end: '', description: '', dependsOn: [], children: [
        { key: 's1', name: '', start: '2026-04-01', end: '', description: '', dependsOn: [], children: [] },
      ] },
    ] },
  ]), (e) => e instanceof PlanAuthorError && e.code === 'invalid_name');

  // A task the author never named but hung a real sub-task on is surfaced, not
  // thrown away with the sub-task the author DID write.
  assert.throws(() => toWire([
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 't1', name: '  ', start: '', end: '', description: '', dependsOn: [], children: [
        { key: 's1', name: 'Order the rebar', start: '', end: '', description: '', dependsOn: [], children: [] },
      ] },
    ] },
  ]), (e) => e instanceof PlanAuthorError && e.code === 'invalid_name');
});

test('toWire: a FOURTH level is refused here, with the server’s own too_deep', () => {
  // No editor op can build this — it is the belt to the braces, so a draft that
  // somehow nests deeper is refused before the round-trip rather than by the API.
  assert.throws(() => toWire([
    { key: 'p1', name: 'Phase A', dependsOn: [], tasks: [
      { key: 't1', name: 'Framing', start: '', end: '', description: '', dependsOn: [], children: [
        { key: 's1', name: 'Order the rebar', start: '', end: '', description: '', dependsOn: [], children: [
          { key: 'x1', name: 'Too deep', start: '', end: '', description: '', dependsOn: [], children: [] },
        ] },
      ] },
    ] },
  ]), (e) => e instanceof PlanAuthorError && e.code === 'too_deep');
});

test('hydrateDraft: grandchildren come back as sub-tasks, with their edges re-keyed', () => {
  const phases = hydrateDraft([
    { id: 'g1', name: 'Phase A', dependsOn: [], children: [
      { id: 'g2', name: 'Framing', dependsOn: [], children: [
        { id: 'g3', name: 'Order the rebar', description: 'Grade 500', plannedStartDate: '2026-04-01', dependsOn: ['g4'] },
      ] },
      { id: 'g4', name: 'Pour', dependsOn: [], children: [] },
    ] },
  ]);
  const sub = phases[0].tasks[0].children[0];
  assert.equal(sub.name, 'Order the rebar');
  assert.equal(sub.description, 'Grade 500');
  assert.equal(sub.start, '2026-04-01');
  assert.equal(sub.end, '', 'a missing wire date hydrates to the editor’s empty string');
  assert.deepEqual(sub.children, []);
  // The edge came back as a SERVER stage id and is now a local key.
  assert.deepEqual(sub.dependsOn, [phases[0].tasks[1].key]);

  // Round-trip: re-saving the hydrated draft ships the same shape back.
  const wire = toWire(phases);
  assert.equal(wire[0].children[0].children.length, 1);
  assert.deepEqual(wire[0].children[0].children[0].dependsOn, [wire[0].children[1].key]);

  // A server tree deeper than three levels cannot be edited here — the extra
  // level is dropped rather than carried into a save the server would refuse.
  const tooDeep = hydrateDraft([
    { id: 'h1', name: 'P', children: [
      { id: 'h2', name: 'T', children: [{ id: 'h3', name: 'S', children: [{ id: 'h4', name: 'X' }] }] },
    ] },
  ]);
  assert.deepEqual(tooDeep[0].tasks[0].children[0].children, []);
  assert.doesNotThrow(() => toWire(tooDeep));
});
