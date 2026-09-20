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
  // Plan templates (LINA-242).
  seedFromTemplate, toTemplateBody,
  // Dependencies (LINA-233), typed by ADR-0020 / LINA-253.
  planNodes, dependencyChoices, dependsOnOf, setDependsOn, toggleDependency, detectCycle,
  setDependencyType, planLinks, DEP_TYPES, DEP_LABELS, DEFAULT_DEP_TYPE, isDepType,
  // Dependency-date enforcement (LINA-306).
  enforceDependencies, enforceLink,
  // The third level (LINA-243).
  addSubtask, renameSubtask, setSubtaskDate, setSubtaskDates, setSubtaskDescription, removeSubtask,
  moveSubtask, reorderSubtask, subtaskCount,
  // Owner + specialty (LINA-235/246).
  setAssignee, setTrade, stageMeta,
  // Child-status meter + WBS promote/demote (LINA-259).
  childStatusCounts, promoteNode, demoteNode,
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
  assert.deepEqual(phases[1].tasks[0].dependsOn, [{ on: 'a2', type: 'starts_after' }],
    'a new link is born starts_after — the ADR default and the column default');
  assert.deepEqual(dependsOnOf(phases, 'b1'), [{ on: 'a2', type: 'starts_after' }],
    'read back by key, phase or task alike');
  assert.ok(!keys('a2').includes('b1'), 'a choice that would close a cycle is withheld');
  assert.ok(keys('a2').includes('a1'), 'unrelated stages are still offered');

  // A selected key is always offered back, so a link can be undone.
  assert.ok(keys('b1').includes('a2'));
  phases = toggleDependency(phases, 'b1', 'a2');
  assert.deepEqual(phases[1].tasks[0].dependsOn, [], 'toggle removes');
});

// ── Typed links (ADR-0020, LINA-253) ────────────────────────────────────────
// The founder's ask: not THAT one stage waits on another, but HOW. The type is
// carried per link, defaults to starts_after, and is blind to everything the
// graph rules already decide — cycles, choices, cleanup.

test('the type vocabulary is exactly the three the founder named, default first', () => {
  // These labels are the ASK, verbatim (LINA-251 → ADR-0020 §1). Pinned here so
  // a well-meaning reword ("After", "Finish-to-start") fails a test rather than
  // quietly changing what the user is being asked to say.
  assert.deepEqual([...DEP_TYPES], ['starts_after', 'starts_with', 'ends_with']);
  assert.deepEqual(DEP_TYPES.map((t) => DEP_LABELS[t]), ['Starts after', 'Starts with', 'Ends with']);
  assert.equal(DEFAULT_DEP_TYPE, 'starts_after', 'the default is the one the column defaults to');
  assert.equal(DEP_TYPES[0], DEFAULT_DEP_TYPE, 'and it is offered first');
  assert.ok(DEP_TYPES.every(isDepType));
  // Deliberately NOT in v1 (ADR-0020 §1): start-to-finish and lag days.
  assert.ok(!isDepType('starts_to_finish'));
  assert.ok(!isDepType(undefined) && !isDepType(null));
});

test('setDependencyType: re-types one link and leaves the rest of the graph alone', () => {
  let phases = [
    { key: 'p1', name: 'P', dependsOn: [], tasks: [
      { key: 't1', name: 'T1', start: '', end: '', description: '', dependsOn: [] },
      { key: 't2', name: 'T2', start: '', end: '', description: '', dependsOn: [] },
      { key: 't3', name: 'T3', start: '', end: '', description: '', dependsOn: [] },
    ] },
  ];
  phases = toggleDependency(phases, 't3', 't1');
  phases = toggleDependency(phases, 't3', 't2');
  phases = setDependencyType(phases, 't3', 't1', 'starts_with');
  assert.deepEqual(dependsOnOf(phases, 't3'), [
    { on: 't1', type: 'starts_with' },
    { on: 't2', type: 'starts_after' },
  ], 'only the named link is re-typed, and the author order holds');

  // Re-typing a pair that is NOT linked cannot create the link.
  const untouched = setDependencyType(phases, 't1', 't2', 'ends_with');
  assert.deepEqual(dependsOnOf(untouched, 't1'), []);
  assert.equal(untouched, phases, 'a no-op returns the same array');

  // Removing the link takes its type with it — a re-tick starts over at default.
  phases = toggleDependency(phases, 't3', 't1');
  phases = toggleDependency(phases, 't3', 't1');
  assert.deepEqual(dependsOnOf(phases, 't3').find((d) => d.on === 't1'),
    { on: 't1', type: 'starts_after' }, 'a stale type is never resurrected');
});

test('setDependsOn: one link per ordered pair, and never to itself', () => {
  const phases = [
    { key: 'p1', name: 'P', dependsOn: [], tasks: [
      { key: 't1', name: 'T1', start: '', end: '', description: '', dependsOn: [] },
      { key: 't2', name: 'T2', start: '', end: '', description: '', dependsOn: [] },
    ] },
  ];
  // Two typed links to the SAME target is `400 duplicate_dependency` server-side
  // (ADR-0020 §2: the type qualifies the link, it does not multiply it).
  const deduped = setDependsOn(phases, 't2', [
    { on: 't1', type: 'starts_with' },
    { on: 't1', type: 'ends_with' },
  ]);
  assert.deepEqual(dependsOnOf(deduped, 't2'), [{ on: 't1', type: 'starts_with' }], 'the first wins');
  // Self-links are `400 self_dependency` — dropped before they reach the draft.
  const selfish = setDependsOn(phases, 't2', [{ on: 't2', type: 'starts_after' }]);
  assert.deepEqual(dependsOnOf(selfish, 't2'), []);
});

test('planLinks: every link flattened for the Gantt, typed and in reading order', () => {
  let phases = [
    { key: 'p1', name: 'P', dependsOn: [], tasks: [
      { key: 't1', name: 'T1', start: '', end: '', description: '', dependsOn: [] },
      { key: 't2', name: 'T2', start: '', end: '', description: '', dependsOn: [] },
    ] },
  ];
  assert.deepEqual(planLinks(phases), [], 'a fresh plan draws no arrows');
  phases = toggleDependency(phases, 't2', 't1');
  phases = setDependencyType(phases, 't2', 't1', 'ends_with');
  phases = toggleDependency(phases, 't2', 'p1');
  assert.deepEqual(planLinks(phases), [
    { from: 't2', to: 't1', type: 'ends_with' },
    { from: 't2', to: 'p1', type: 'starts_after' },
  ], 'from = the stage carrying the link, to = its predecessor');
});

test('detectCycle: agrees with the server, and stays TYPE-BLIND (one DAG, ADR-0020 §4)', () => {
  const phases = [
    { key: 'p1', name: 'P', dependsOn: [], tasks: [
      { key: 'x', name: 'X', start: '', end: '', description: '', dependsOn: [{ on: 'y', type: 'starts_after' }] },
      { key: 'y', name: 'Y', start: '', end: '', description: '', dependsOn: [{ on: 'x', type: 'starts_after' }] },
    ] },
  ];
  const cycle = detectCycle(phases);
  assert.ok(cycle, 'a two-node loop is caught');
  assert.deepEqual(new Set(cycle.map((n) => n.key)), new Set(['x', 'y']));
  assert.equal(detectCycle(setDependsOn(phases, 'y', [])), null);
  // A deep chain that does not close is not a cycle.
  assert.equal(detectCycle(setDependsOn(phases, 'x', [{ on: 'p1', type: 'starts_after' }])), null);
  // A MUTUAL starts_with pair is arguably coherent in other PM tools; ADR-0020
  // §4 refuses it anyway, so the client must agree rather than let a save 409.
  const mutual = setDependencyType(
    setDependencyType(phases, 'x', 'y', 'starts_with'), 'y', 'x', 'starts_with',
  );
  assert.ok(detectCycle(mutual), 'type does not buy a loop an exemption');
});

test('dependencyChoices / dependents stay type-blind too', () => {
  let phases = [
    { key: 'p1', name: 'P', dependsOn: [], tasks: [
      { key: 't1', name: 'T1', start: '', end: '', description: '', dependsOn: [] },
      { key: 't2', name: 'T2', start: '', end: '', description: '', dependsOn: [] },
    ] },
  ];
  phases = setDependencyType(toggleDependency(phases, 't2', 't1'), 't2', 't1', 'ends_with');
  const keys = (k) => dependencyChoices(phases, k).flatMap((g) => g.options.map((o) => o.key));
  assert.ok(!keys('t1').includes('t2'), 'an ends_with downstream is withheld exactly like a starts_after one');
});

test('removing a stage takes its inbound links with it', () => {
  let phases = [
    { key: 'p1', name: 'P', dependsOn: [], tasks: [
      { key: 't1', name: 'T1', start: '', end: '', description: '', dependsOn: [] },
      { key: 't2', name: 'T2', start: '', end: '', description: '', dependsOn: [{ on: 't1', type: 'starts_with' }] },
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
    { key: 'p2', name: 'Phase B', dependsOn: [{ on: 'p1', type: 'starts_after' }], tasks: [
      { key: 't2', name: 'Task 2', start: '', end: '', description: '', dependsOn: [
        { on: 't1', type: 'starts_with' }, { on: 't9', type: 'starts_after' },
      ] },
    ] },
  ];
  const wire = toWire(phases);
  assert.equal(wire[0].key, 'p1');
  assert.deepEqual(wire[0].dependsOn, [], 'always present — a cleared row must clear server-side');
  assert.equal(wire[0].children[0].key, 't1');
  // Contract v5 (ADR-0020 §3): OBJECTS, never bare strings — even for the
  // default type, so the payload says what it means rather than leaning on the
  // column default.
  assert.deepEqual(wire[1].dependsOn, [{ key: 'p1', type: 'starts_after' }], 'a phase may follow a phase');
  assert.deepEqual(wire[1].children[0].dependsOn, [{ key: 't1', type: 'starts_with' }],
    'the type rides along, and the edge to the dropped blank row is gone');
});

test('hydrateDraft: typed server edges come back as local keys; dangling and dup edges dropped', () => {
  const phases = hydrateDraft([
    { id: 's1', name: 'Phase A', dependencies: [], children: [
      { id: 's2', name: 'Task 1', dependencies: [] },
    ] },
    // Links a stage EARLIER in the tree and one that is not in the tree at all.
    { id: 's3', name: 'Phase B', dependencies: [{ on: 's2', type: 'ends_with' }, { on: 'gone', type: 'starts_after' }], children: [
      { id: 's4', name: 'Task 2', dependencies: [{ on: 's3', type: 'starts_with' }] },
    ] },
  ]);
  assert.deepEqual(phases[1].dependsOn, [{ on: phases[0].tasks[0].key, type: 'ends_with' }]);
  assert.deepEqual(phases[1].tasks[0].dependsOn, [{ on: phases[1].key, type: 'starts_with' }]);
  // Re-saving the hydrated draft round-trips the graph AND the types.
  const wire = toWire(phases);
  assert.deepEqual(wire[1].dependsOn, [{ key: wire[0].children[0].key, type: 'ends_with' }]);
});

test('hydrateDraft: a missing or unknown type reads as starts_after, the column default', () => {
  const phases = hydrateDraft([
    { id: 'h1', name: 'Phase A', children: [{ id: 'h2', name: 'Task 1' }] },
    { id: 'h3', name: 'Phase B', dependencies: [{ on: 'h2' }] },
    // A type this client does not know would be a server the FE is behind — read
    // it as the default rather than carry a value the next save would 400 on.
    { id: 'h4', name: 'Phase C', dependencies: [{ on: 'h2', type: 'starts_to_finish' }, { on: 'h2', type: 'ends_with' }] },
  ]);
  assert.deepEqual(phases[1].dependsOn, [{ on: phases[0].tasks[0].key, type: 'starts_after' }]);
  assert.deepEqual(phases[2].dependsOn, [{ on: phases[0].tasks[0].key, type: 'starts_after' }],
    'and a repeated target keeps its first entry — one link per pair');
  // The legacy untyped `dependsOn` the service still dual-emits is IGNORED here:
  // reading it would mean inventing a type it never carried.
  const legacyOnly = hydrateDraft([
    { id: 'l1', name: 'Phase A' },
    { id: 'l2', name: 'Phase B', dependsOn: ['l1'] },
  ]);
  assert.deepEqual(legacyOnly[1].dependsOn, []);
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
      { key: 't2', name: 'Pour', start: '', end: '', description: '', dependsOn: [{ on: 's1', type: 'starts_after' }], children: [] },
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

  phases = setDependsOn(phases, 's1', [{ on: 't1', type: 'ends_with' }]);
  assert.deepEqual(dependsOnOf(phases, 's1'), [{ on: 't1', type: 'ends_with' }],
    'read back by key at the third level too');
  assert.equal(phases[0].tasks[1].dependsOn.length, 1, 'a sibling row is not disturbed');
  phases = toggleDependency(phases, 's1', 't1');
  assert.deepEqual(dependsOnOf(phases, 's1'), [], 'toggle removes at the third level');

  // A cycle through a sub-task is caught by the same check the server runs.
  const looped = setDependsOn(phases, 's1', [{ on: 't2', type: 'starts_after' }]);
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
        { key: 's1', name: ' Order the rebar ', start: '2026-04-01', end: '', description: ' 12mm ', dependsOn: [{ on: 't2', type: 'ends_with' }], children: [] },
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
  assert.deepEqual(framing.children[0].dependsOn, [{ key: 't2', type: 'ends_with' }],
    'a sub-task may be linked to any stage, and carries its type to the wire');
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
        { id: 'g3', name: 'Order the rebar', description: 'Grade 500', plannedStartDate: '2026-04-01', dependencies: [{ on: 'g4', type: 'starts_with' }] },
      ] },
      { id: 'g4', name: 'Pour', dependencies: [], children: [] },
    ] },
  ]);
  const sub = phases[0].tasks[0].children[0];
  assert.equal(sub.name, 'Order the rebar');
  assert.equal(sub.description, 'Grade 500');
  assert.equal(sub.start, '2026-04-01');
  assert.equal(sub.end, '', 'a missing wire date hydrates to the editor’s empty string');
  assert.deepEqual(sub.children, []);
  // The edge came back as a SERVER stage id and is now a local key, typed.
  assert.deepEqual(sub.dependsOn, [{ on: phases[0].tasks[1].key, type: 'starts_with' }]);

  // Round-trip: re-saving the hydrated draft ships the same shape back.
  const wire = toWire(phases);
  assert.equal(wire[0].children[0].children.length, 1);
  assert.deepEqual(wire[0].children[0].children[0].dependsOn,
    [{ key: wire[0].children[1].key, type: 'starts_with' }]);

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

// ── Owner + specialty (LINA-235/246, ADR-0017 annex 3) ──────────────────────

test('setAssignee / setTrade address a stage by key at all three levels', () => {
  let phases = seedSkeleton();
  phases = addSubtask(phases, 0, 0);
  const phaseKey = phases[0].key;
  const taskKey = phases[0].tasks[0].key;
  const subKey = phases[0].tasks[0].children[0].key;

  const before = phases;
  phases = setAssignee(phases, phaseKey, 'party-a');
  phases = setAssignee(phases, taskKey, 'party-b');
  phases = setAssignee(phases, subKey, 'party-c');
  phases = setTrade(phases, taskKey, 'Electrical');

  assert.equal(phases[0].assigneePartyId, 'party-a');
  assert.equal(phases[0].tasks[0].assigneePartyId, 'party-b');
  assert.equal(phases[0].tasks[0].children[0].assigneePartyId, 'party-c');
  assert.equal(phases[0].tasks[0].trade, 'Electrical');

  // Pure: the original draft is untouched, and a phase nothing was written to
  // keeps its identity (so React does not re-render the whole plan per keystroke).
  assert.equal(before[0].assigneePartyId, null);
  assert.equal(before[0].tasks[0].trade, '');
  assert.equal(phases[1], before[1]);

  // Clearing is a first-class edit, not an absence of one.
  phases = setAssignee(phases, taskKey, null);
  assert.equal(phases[0].tasks[0].assigneePartyId, null);
  phases = setTrade(phases, taskKey, '');
  assert.equal(phases[0].tasks[0].trade, '');
});

test('stageMeta reads back what was written, at any level, and null for an unknown key', () => {
  let phases = seedSkeleton();
  phases = addSubtask(phases, 1, 0);
  const subKey = phases[1].tasks[0].children[0].key;
  phases = setAssignee(phases, subKey, 'party-x');
  phases = setTrade(phases, subKey, 'Roofing');

  assert.deepEqual(stageMeta(phases, subKey), { assigneePartyId: 'party-x', trade: 'Roofing' });
  assert.deepEqual(stageMeta(phases, 'nope'), { assigneePartyId: null, trade: '' });
});

test('toWire: owner + trade go on every node, blanks normalise to null', () => {
  let phases = [emptyPhase('Phase')];
  phases = addTask(phases, 0);
  phases = renameTask(phases, 0, 0, 'Task');
  phases = addSubtask(phases, 0, 0);
  phases = renameSubtask(phases, 0, 0, 0, 'Sub');
  phases = setAssignee(phases, phases[0].key, 'p-phase');
  phases = setTrade(phases, phases[0].tasks[0].key, '  Plumbing  ');
  phases = setAssignee(phases, phases[0].tasks[0].children[0].key, 'p-sub');

  const [phase] = toWire(phases);
  assert.equal(phase.assigneePartyId, 'p-phase');
  // An untouched trade is null on the wire, never '' — the server stores a trade
  // or nothing, and '' would be a third state neither side has a meaning for.
  assert.equal(phase.trade, null);

  const [task] = phase.children;
  assert.equal(task.trade, 'Plumbing'); // trimmed
  assert.equal(task.assigneePartyId, null);

  const [sub] = task.children;
  assert.equal(sub.assigneePartyId, 'p-sub');
  assert.equal(sub.trade, null);
});

test('toWire: a row whose ONLY content is an owner or a trade still needs a name', () => {
  // Assigning somebody counts as touching the row (so it is not silently
  // dropped), but a nameless stage is still the refusal it always was — which is
  // exactly what the server answers with `invalid_name`.
  let phases = [emptyPhase('Phase')];
  phases = addTask(phases, 0);
  phases = setAssignee(phases, phases[0].tasks[0].key, 'p-1');
  assert.throws(() => toWire(phases), (e) => e instanceof PlanAuthorError && e.code === 'invalid_name');

  phases = renameTask(phases, 0, 0, 'Now named');
  const [phase] = toWire(phases);
  assert.equal(phase.children.length, 1);
  assert.equal(phase.children[0].assigneePartyId, 'p-1');
});

test('hydrateDraft: assignee + trade round-trip, and a stage with neither is unassigned', () => {
  const phases = hydrateDraft([
    {
      id: 's1', name: 'Phase', assigneePartyId: 'p-owner', trade: 'General',
      children: [
        { id: 's2', name: 'Task', assigneePartyId: null, trade: null, children: [] },
        {
          id: 's3', name: 'Task 2', assigneePartyId: 'p-sub', trade: 'Electrical',
          children: [{ id: 's4', name: 'Sub', assigneePartyId: 'p-sub2', trade: 'Wiring' }],
        },
      ],
    },
  ]);

  assert.equal(phases[0].assigneePartyId, 'p-owner');
  assert.equal(phases[0].trade, 'General');
  assert.equal(phases[0].tasks[0].assigneePartyId, null);
  assert.equal(phases[0].tasks[0].trade, '');
  assert.equal(phases[0].tasks[1].assigneePartyId, 'p-sub');
  assert.equal(phases[0].tasks[1].children[0].assigneePartyId, 'p-sub2');
  assert.equal(phases[0].tasks[1].children[0].trade, 'Wiring');

  // And the whole thing survives a save/re-save: hydrate → toWire keeps it.
  const wire = toWire(phases);
  assert.equal(wire[0].assigneePartyId, 'p-owner');
  assert.equal(wire[0].children[1].children[0].trade, 'Wiring');
});

// ── Child-status meter (LINA-259 ask 5) ──────────────────────────────────────

test('childStatusCounts: a fresh draft is honestly all not-started (no fabricated progress)', () => {
  const phases = seedSkeleton();
  const c = childStatusCounts(phases[0]); // a phase counts its tasks
  assert.equal(c.total, phases[0].tasks.length);
  assert.equal(c.done, 0);
  assert.equal(c.inProgress, 0);
  assert.equal(c.notStarted, c.total);

  // A leaf task (no sub-tasks) has an all-zero meter — the caller draws none.
  assert.deepEqual(childStatusCounts(phases[0].tasks[0]), { done: 0, inProgress: 0, blocked: 0, notStarted: 0, total: 0 });
});

test('childStatusCounts: derives from an optional status, counting blocked as its own bucket', () => {
  // Statuses only ever arrive via hydration (never authored); simulate a live plan.
  const phases = hydrateDraft([
    {
      id: 'p', name: 'Phase',
      children: [
        { id: 't1', name: 'Done', status: 'done', children: [] },
        { id: 't2', name: 'Going', status: 'in_progress', children: [] },
        { id: 't3', name: 'Stuck', status: 'blocked', children: [] },
        { id: 't4', name: 'Fresh', children: [] }, // no status → not_started
      ],
    },
  ]);
  const c = childStatusCounts(phases[0]);
  assert.deepEqual(c, { done: 1, inProgress: 1, blocked: 1, notStarted: 1, total: 4 });
  // The optional status survives hydration but authoring never sets it.
  assert.equal(phases[0].tasks[0].status, 'done');
  assert.equal(phases[0].tasks[3].status, undefined);
});

// ── WBS promote / demote (LINA-259 ask 7) ────────────────────────────────────

test('promoteNode: an L3 sub-task becomes an L2 task right after its former parent', () => {
  let phases = [emptyPhase('Phase')];
  phases = addTask(phases, 0); // task A at ti 0
  phases = renameTask(phases, 0, 0, 'A');
  phases = addTask(phases, 0); // task B at ti 1
  phases = renameTask(phases, 0, 1, 'B');
  phases = addSubtask(phases, 0, 0); // sub under A
  phases = renameSubtask(phases, 0, 0, 0, 'A.1');
  const subKey = phases[0].tasks[0].children[0].key;

  const out = promoteNode(phases, 0, 0, 0);
  assert.equal(out[0].tasks.length, 3);
  assert.equal(out[0].tasks[0].name, 'A');
  assert.equal(out[0].tasks[0].children.length, 0, 'sub left its former parent');
  assert.equal(out[0].tasks[1].key, subKey, 'sub inserted right after its parent');
  assert.equal(out[0].tasks[1].name, 'A.1');
  assert.equal(out[0].tasks[2].name, 'B');
  // Pure: original untouched.
  assert.equal(phases[0].tasks[0].children.length, 1);
});

test('promoteNode: an L2 task cannot climb above phase level (no-op)', () => {
  let phases = [emptyPhase('Phase')];
  phases = addTask(phases, 0);
  phases = renameTask(phases, 0, 0, 'A');
  assert.equal(promoteNode(phases, 0, 0), phases, 'same array, unchanged');
});

test('demoteNode: an L2 task nests under its preceding sibling as an L3 sub-task', () => {
  let phases = [emptyPhase('Phase')];
  phases = addTask(phases, 0);
  phases = renameTask(phases, 0, 0, 'A');
  phases = addTask(phases, 0);
  phases = renameTask(phases, 0, 1, 'B');
  const bKey = phases[0].tasks[1].key;

  const out = demoteNode(phases, 0, 1);
  assert.equal(out[0].tasks.length, 1, 'B left the task list');
  assert.equal(out[0].tasks[0].name, 'A');
  assert.equal(out[0].tasks[0].children.length, 1);
  assert.equal(out[0].tasks[0].children[0].key, bKey);
  assert.equal(out[0].tasks[0].children[0].name, 'B');
  // toWire keeps it three levels deep — never throws too_deep.
  const wire = toWire(out);
  assert.equal(wire[0].children[0].children[0].name, 'B');
});

test('demoteNode: the guards — first sibling, a task with children, and an L3 sub are all no-ops', () => {
  let phases = [emptyPhase('Phase')];
  phases = addTask(phases, 0); // A
  phases = renameTask(phases, 0, 0, 'A');
  phases = addTask(phases, 0); // B
  phases = renameTask(phases, 0, 1, 'B');
  phases = addSubtask(phases, 0, 1); // B has a child now
  phases = renameSubtask(phases, 0, 1, 0, 'B.1');

  // First sibling A has nothing to nest under.
  assert.equal(demoteNode(phases, 0, 0), phases);
  // B has a child — demoting it would create a fourth level.
  assert.equal(demoteNode(phases, 0, 1), phases);
  // An L3 sub-task cannot demote further.
  assert.equal(demoteNode(phases, 0, 1, 0), phases);
});

test('promote/demote never produce a too-deep tree (round-trip through toWire)', () => {
  let phases = [emptyPhase('Phase')];
  phases = addTask(phases, 0);
  phases = renameTask(phases, 0, 0, 'A');
  phases = addSubtask(phases, 0, 0);
  phases = renameSubtask(phases, 0, 0, 0, 'A.1');
  // Promote the sub to L2, then demote it back under A — a round trip.
  let out = promoteNode(phases, 0, 0, 0); // A.1 now an L2 task at ti 1
  out = demoteNode(out, 0, 1); // back under A as a sub-task
  assert.doesNotThrow(() => toWire(out));
  assert.equal(out[0].tasks.length, 1);
  assert.equal(out[0].tasks[0].children.length, 1);
});

// ── Stage identity survives a resume (LINA-250; persisted by LINA-249) ───────
// The saved key is the address the task workspace and the task permalink hang
// off. Re-keying a resumed draft would orphan every comment and file on it and
// break every link already shared, so hydration reuses what the server sent and
// only mints for a stage that never had one.
test('hydrateDraft: a saved key is reused; a keyless stage still gets a fresh one', () => {
  const phases = hydrateDraft([
    { id: 's1', key: 'p-7', name: 'Phase A', children: [
      { id: 's2', key: 't-9', name: 'Task 1', children: [{ id: 's3', key: 's-4', name: 'Sub 1' }] },
      { id: 's4', name: 'Legacy task' }, // import-seeded: no key was ever stored
    ] },
  ]);
  assert.equal(phases[0].key, 'p-7');
  assert.equal(phases[0].tasks[0].key, 't-9');
  assert.equal(phases[0].tasks[0].children[0].key, 's-4');
  assert.ok(phases[0].tasks[1].key, 'the keyless stage is still addressable locally');
  assert.notEqual(phases[0].tasks[1].key, 't-9');

  // And the saved keys reach the wire unchanged, so the next save writes the
  // same addresses back rather than a new set.
  const wire = toWire(phases);
  assert.equal(wire[0].key, 'p-7');
  assert.equal(wire[0].children[0].key, 't-9');
  assert.equal(wire[0].children[0].children[0].key, 's-4');
});

test('hydrateDraft: minting continues PAST the saved keys — no duplicate_key on the next add', () => {
  // A fresh page load starts the counter at 0 while the draft already holds
  // t-1/t-2; without absorbing them, "Add task" would mint t-1 a second time and
  // the save would come back 400 duplicate_key.
  const phases = hydrateDraft([
    { id: 'a', key: 'p-1', name: 'Phase A', children: [
      { id: 'b', key: 't-1', name: 'One' },
      { id: 'c', key: 't-2', name: 'Two' },
    ] },
  ]);
  const next = addTask(phases, 0);
  const keys = next[0].tasks.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, 'every key in the phase is distinct');
});

// ── Dependency-date ENFORCEMENT (LINA-306) ──────────────────────────────────
// The founder's ask: a link does not just draw an arrow, it MOVES the dependent
// so its schedule obeys the rule — and keeps obeying it when the predecessor
// shifts. Duration is preserved (a link reschedules, it does not restretch), and
// a cyclic draft is left alone (you cannot order a cycle).

const T = (key, start, end, dependsOn = []) =>
  ({ key, name: key.toUpperCase(), start, end, description: '', trade: '', assigneePartyId: null, dependsOn, children: [] });
const P = (key, tasks, dependsOn = []) =>
  ({ key, name: key.toUpperCase(), trade: '', assigneePartyId: null, dependsOn, tasks });

test('enforceDependencies: starts_after snaps the dependent to pred.end + 1 day, duration preserved', () => {
  let phases = [P('p1', [
    T('a', '2026-03-01', '2026-03-05'),          // 5-day predecessor
    T('b', '2026-03-10', '2026-03-12'),          // 3-day dependent, elsewhere
  ])];
  phases = toggleDependency(phases, 'b', 'a');    // b starts_after a (default type)
  const out = enforceDependencies(phases);
  // a ends 03-05, so b starts the DAY AFTER, 03-06; its 3-day span is kept → 03-08.
  assert.equal(out[0].tasks[1].start, '2026-03-06');
  assert.equal(out[0].tasks[1].end, '2026-03-08');
  // The predecessor is never touched.
  assert.equal(out[0].tasks[0].start, '2026-03-01');
  assert.equal(out[0].tasks[0].end, '2026-03-05');
});

test('enforceDependencies: starts_with aligns starts; ends_with aligns finishes; duration kept', () => {
  let sw = [P('p1', [T('a', '2026-03-01', '2026-03-10'), T('b', '2026-04-01', '2026-04-05')])];
  sw = toggleDependency(sw, 'b', 'a');
  sw = setDependencyType(sw, 'b', 'a', 'starts_with');
  const swOut = enforceDependencies(sw);
  assert.equal(swOut[0].tasks[1].start, '2026-03-01');   // b.start := a.start
  assert.equal(swOut[0].tasks[1].end, '2026-03-05');     // 5-day span kept

  let ew = [P('p1', [T('a', '2026-03-01', '2026-03-10'), T('b', '2026-04-01', '2026-04-05')])];
  ew = toggleDependency(ew, 'b', 'a');
  ew = setDependencyType(ew, 'b', 'a', 'ends_with');
  const ewOut = enforceDependencies(ew);
  assert.equal(ewOut[0].tasks[1].end, '2026-03-10');     // b.end := a.end
  assert.equal(ewOut[0].tasks[1].start, '2026-03-06');   // 5-day span kept (back from the end)
});

test('enforceDependencies: an undated predecessor constrains nothing; an undated dependent is left alone', () => {
  let phases = [P('p1', [T('a', '', ''), T('b', '2026-03-10', '2026-03-12')])];
  phases = toggleDependency(phases, 'b', 'a');
  assert.equal(enforceDependencies(phases), phases, 'no dated boundary → identity (same ref)');

  let p2 = [P('p1', [T('a', '2026-03-01', '2026-03-05'), T('b', '', '')])];
  p2 = toggleDependency(p2, 'b', 'a');
  const out = enforceDependencies(p2);
  assert.equal(out[0].tasks[1].start, '');               // nothing to shift yet
  assert.equal(out[0].tasks[1].end, '');
});

test('enforceDependencies: cascades down a chain in one pass', () => {
  let phases = [P('p1', [
    T('a', '2026-03-01', '2026-03-05'),
    T('b', '2026-03-01', '2026-03-03'),   // 3-day
    T('c', '2026-03-01', '2026-03-02'),   // 2-day
  ])];
  phases = toggleDependency(phases, 'b', 'a'); // b after a
  phases = toggleDependency(phases, 'c', 'b'); // c after b
  const out = enforceDependencies(phases);
  // a ends 03-05 → b starts 03-06..03-08 → c starts 03-09..03-10, all in one pass.
  assert.equal(out[0].tasks[1].start, '2026-03-06');
  assert.equal(out[0].tasks[1].end, '2026-03-08');
  assert.equal(out[0].tasks[2].start, '2026-03-09');
  assert.equal(out[0].tasks[2].end, '2026-03-10');
});

test('enforceDependencies: several predecessors → the LATEST start wins', () => {
  let phases = [P('p1', [
    T('a', '2026-03-01', '2026-03-05'),   // ends 03-05
    T('a2', '2026-03-01', '2026-03-20'),  // ends 03-20 (the binding one)
    T('b', '2026-03-01', '2026-03-03'),   // 3-day
  ])];
  phases = toggleDependency(phases, 'b', 'a');
  phases = toggleDependency(phases, 'b', 'a2');
  const out = enforceDependencies(phases);
  // Both are starts_after; b must clear the later one (a2 ends 03-20) → starts 03-21.
  assert.equal(out[0].tasks[2].start, '2026-03-21');
  assert.equal(out[0].tasks[2].end, '2026-03-23');
});

test('enforceDependencies: a cyclic draft is returned untouched (cannot order a cycle)', () => {
  let phases = [P('p1', [T('a', '2026-03-01', '2026-03-05'), T('b', '2026-03-10', '2026-03-12')])];
  phases = setDependsOn(phases, 'a', [{ on: 'b', type: 'starts_after' }]);
  phases = setDependsOn(phases, 'b', [{ on: 'a', type: 'starts_after' }]);
  assert.ok(detectCycle(phases), 'the fixture really is cyclic');
  assert.equal(enforceDependencies(phases), phases, 'identity — enforcement waits for the loop to break');
});

test('enforceDependencies: a task may key off a whole phase envelope', () => {
  let phases = [
    P('p1', [T('a', '2026-03-01', '2026-03-05'), T('a2', '2026-03-03', '2026-03-20')]),
    P('p2', [T('b', '2026-04-01', '2026-04-03')]), // 3-day
  ];
  phases = toggleDependency(phases, 'b', 'p1'); // b starts_after the whole phase p1
  const out = enforceDependencies(phases);
  // p1's envelope ends at its latest child finish (a2 → 03-20) → b starts 03-21.
  assert.equal(out[1].tasks[0].start, '2026-03-21');
  assert.equal(out[1].tasks[0].end, '2026-03-23');
});

test('enforceLink: moves ONLY the link dependent — the downstream chain stays put', () => {
  // The founder's bug: linking 1.1 ends_with its own sub 1.1.1 must not shove the
  // rest of the plan. t1.2 follows t1.1 and t1.3 follows t1.2 (a real chain), and
  // tX is independent — none of them may move when the ONE link is applied.
  let phases = [P('p1', [
    { key: 't1.1', name: 'T1.1', start: '2026-03-01', end: '2026-03-10', description: '', trade: '', assigneePartyId: null, dependsOn: [],
      children: [T('t1.1.1', '2026-03-02', '2026-03-25')] },
    T('t1.2', '2026-03-11', '2026-03-15', [{ on: 't1.1', type: 'starts_after' }]),
    T('t1.3', '2026-03-16', '2026-03-18', [{ on: 't1.2', type: 'starts_after' }]),
    T('tX', '2026-03-20', '2026-03-22'),
  ])];
  phases = setDependencyType(toggleDependency(phases, 't1.1', 't1.1.1'), 't1.1', 't1.1.1', 'ends_with');
  const out = enforceLink(phases, 't1.1');
  // The dependent (1.1) snaps ONLY its end to 1.1.1's end; its start is pinned
  // where the author left it — an end-to-end link resizes, it does not slide the
  // bar earlier (LINA-306). A pinned start also keeps the timeline's left edge and
  // every other bar's position visually put.
  assert.equal(out[0].tasks[0].end, '2026-03-25');
  assert.equal(out[0].tasks[0].start, '2026-03-01');
  // Everything else is byte-for-byte where it was — no cascade.
  assert.equal(out[0].tasks[1].start, '2026-03-11');   // t1.2 (follows 1.1) untouched
  assert.equal(out[0].tasks[1].end, '2026-03-15');
  assert.equal(out[0].tasks[2].start, '2026-03-16');   // t1.3 untouched
  assert.equal(out[0].tasks[3].start, '2026-03-20');   // tX untouched
});

test('enforceLink: ends_with moves only the end, pinning the start (resize, no slide)', () => {
  // Founder's exact gesture: draw "end of 1.1 → end of 1.1.1". 1.1's END jumps to
  // 1.1.1's finish and its START stays exactly where it was — the bar does not
  // slide earlier, so the Fit-plan left edge (and every other bar) holds still.
  let phases = [P('p1', [
    { key: 't1.1', name: 'T1.1', start: '2026-03-01', end: '2026-03-10', description: '', trade: '', assigneePartyId: null, dependsOn: [],
      children: [T('t1.1.1', '2026-03-02', '2026-03-25')] },
  ])];
  phases = setDependencyType(toggleDependency(phases, 't1.1', 't1.1.1'), 't1.1', 't1.1.1', 'ends_with');
  const out = enforceLink(phases, 't1.1');
  assert.equal(out[0].tasks[0].start, '2026-03-01', 'start pinned — no earlier slide');
  assert.equal(out[0].tasks[0].end, '2026-03-25', 'end snapped to the target finish');
});

test('enforceLink: ends_with falls back to a whole-bar shift when the target ends on/before our start', () => {
  // A pinned start would invert the bar (end before start), so here — and only
  // here — the bar shifts back wholesale, duration kept, to stay valid.
  let phases = [P('p1', [T('a', '2026-03-01', '2026-03-10'), T('b', '2026-04-01', '2026-04-05')])];
  phases = setDependencyType(toggleDependency(phases, 'b', 'a'), 'b', 'a', 'ends_with');
  const out = enforceLink(phases, 'b');
  assert.equal(out[0].tasks[1].end, '2026-03-10', 'end := target finish');
  assert.equal(out[0].tasks[1].start, '2026-03-06', '4-day span kept, shifted back from the end');
});

test('enforceLink: a released or undated link moves nothing (identity)', () => {
  let phases = [P('p1', [T('a', '2026-03-01', '2026-03-05'), T('b', '', '')])];
  phases = toggleDependency(phases, 'b', 'a');
  assert.equal(enforceLink(phases, 'b'), phases, 'an undated dependent → identity (same ref)');
  const noDeps = [P('p1', [T('a', '2026-03-01', '2026-03-05')])];
  assert.equal(enforceLink(noDeps, 'a'), noDeps, 'a node with no links → identity');
});

test('enforceDependencies: pure — the input tree is never mutated', () => {
  let phases = [P('p1', [T('a', '2026-03-01', '2026-03-05'), T('b', '2026-03-10', '2026-03-12')])];
  phases = toggleDependency(phases, 'b', 'a');
  const snapshot = JSON.parse(JSON.stringify(phases));
  enforceDependencies(phases);
  assert.deepEqual(phases, snapshot, 'original untouched');
});
