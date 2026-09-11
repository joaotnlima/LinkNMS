// Direct plan authoring — the "build it here" route (LINA-228, ADR-0017).
// Frozen contract: docs/architecture/slice-direct-plan-authoring-contract.md.
//
// WHAT LIVES HERE AND WHY
// The seeded skeleton, the client-side draft model, the pure tree operations the
// editor makes its edits with, and the single write. Everything here is either a
// constant, a pure function over the draft, or the one POST — so the editing
// logic is unit-testable under `node --test` without a browser
// (plan-authoring.test.mjs), and the screen itself stays copy + layout.
//
// THE RULES THIS FILE KEEPS (contract §0–§4):
//   1. THE ACTOR IS NEVER IN THE BODY. `authorPlan` sends only `{ stages }`; the
//      acting party is the session, resolved server-side. A client that could
//      name itself could stamp authorship as someone else.
//   2. THREE LEVELS, NEVER FOUR (LINA-238/243, ADR-0019). A phase (action) holds
//      tasks (sub-actions); a task holds sub-tasks (sub-sub-actions); a sub-task
//      holds nothing. There is no operation that nests below a sub-task, and
//      `toWire` refuses a draft that somehow carries one — the same `too_deep`
//      the server answers with, raised before the round-trip.
//   3. THE SKELETON IS A STARTING POINT, NOT A CLAIM. It carries names only — no
//      dates, no owner, no sub-tasks (the issue: "that is for the user to fill").

// ── The seeded skeleton (pen "Build the plan — schedule (Gantt)") ────────────
// A standard residential build broken into the three phases and the tasks the
// pen enumerates. Names only: unassigned, undated, no sub-tasks — the author
// fills those in. This is the one place the default plan shape is defined; the
// server has no skeleton of its own (it validates and writes whatever is sent).
export const PLAN_SKELETON: ReadonlyArray<{ name: string; tasks: readonly string[] }> = Object.freeze([
  {
    name: '1 · Pre-Construction',
    tasks: [
      '1.1 Planning & Feasibility',
      '1.2 Design & Engineering',
      '1.3 Permitting & Approval',
      '1.4 Budget & Schedule',
    ],
  },
  {
    name: '2 · Construction (Execution)',
    tasks: [
      '2.1 Preliminary Works',
      '2.2 Substructure (Foundations)',
      '2.3 Superstructure (Frame)',
      '2.4 Masonry / Enclosure',
      '2.5 Roofing',
      '2.6 Plumbing',
      '2.7 Electrical',
      '2.8 Complementary Systems (HVAC)',
      '2.9 Interior Finishes',
      '2.10 Doors & Windows',
      '2.11 Painting',
      '2.12 Sanitary Ware',
    ],
  },
  {
    name: '3 · Post-Construction',
    tasks: [
      '3.1 Inspection & Handover',
      '3.2 Warranty & Maintenance',
    ],
  },
]);

// ── The client-side draft model ──────────────────────────────────────────────
// Dates are the raw `<input type="date">` strings ('' = unset), normalised to
// null only at the wire edge. A `key` is a stable client id for React lists and
// reordering; since LINA-233 it is ALSO the author-local key sent with the draft
// so predecessors can be named ("depends on"). It is still not a stage id: the
// server resolves the keys to its own ids in-transaction and never stores them.

// A node's `dependsOn` holds TYPED EDGES to its predecessors (ADR-0020): the
// predecessor's LOCAL KEY plus HOW it constrains this stage. Any other stage is
// a valid target — a task may follow a phase, a phase may follow a task in
// another phase (contract §1, ADR-0017 annex 2: scope is any-stage, no
// parent/level constraint). The keys are author-local: the server resolves them
// to its own stage ids inside the draft-save transaction and never persists them.

// A task and a sub-task are the SAME shape — a sub-task is simply a task that
// sits under one. Reusing the type keeps every field (dates, description,
// dependencies) available at the third level without a parallel model; the depth
// cap is not in the type but in the vocabulary: nothing below adds a child to a
// sub-task, so `children` on a sub-task is always [] (LINA-243, ADR-0019).
/**
 * A stage's progress status. Mirrors the server's `STATUSES`
 * (not_started | in_progress | blocked | done). It is DERIVED from reported
 * progress, never authored (ADR-0019): a draft has none, so it is always
 * absent here and defaults to 'not_started'. The field exists READ-ONLY so a
 * hydrated LIVE plan can feed real progress into the child-count meter (LINA-259
 * ask 5) without a parallel model — authoring never writes it.
 */
export type StageStatus = 'not_started' | 'in_progress' | 'blocked' | 'done';

/**
 * HOW a predecessor constrains the stage that names it (ADR-0020 §1). Three
 * types, no more: the classic finish-to-start, start-to-start and
 * finish-to-finish. Lag days and start-to-finish are deliberately out of v1.
 */
export type DepType = 'starts_after' | 'starts_with' | 'ends_with';

/** The type vocabulary in the order the picker offers it — default first. */
export const DEP_TYPES: readonly DepType[] = Object.freeze(
  ['starts_after', 'starts_with', 'ends_with'] as const,
);

/** The EXACT labels the founder asked for. One place, so picker and chip agree. */
export const DEP_LABELS: Readonly<Record<DepType, string>> = Object.freeze({
  starts_after: 'Starts after',
  starts_with: 'Starts with',
  ends_with: 'Ends with',
});

/** What a type means, in the drawer's voice — the picker's per-option hint. */
export const DEP_HINTS: Readonly<Record<DepType, string>> = Object.freeze({
  starts_after: 'starts once that one finishes',
  starts_with: 'starts on the same day that one starts',
  ends_with: 'finishes on the same day that one finishes',
});

/** The type a fresh link is created with (ADR-0020: the column default too). */
export const DEFAULT_DEP_TYPE: DepType = 'starts_after';

/** A link to ONE predecessor, by local key, and how it constrains this stage. */
export interface DepEdge {
  /** The predecessor's author-local key. */
  on: string;
  type: DepType;
}

/** Is this one of the three types? Guards anything read off the wire. */
export function isDepType(v: unknown): v is DepType {
  return typeof v === 'string' && (DEP_TYPES as readonly string[]).includes(v);
}

export interface TaskDraft {
  key: string; name: string; start: string; end: string; description: string;
  /** Typed links to this task's predecessors (LINA-233, typed by ADR-0020). */
  dependsOn: DepEdge[];
  /** The member this stage is owned by, by PARTY ID — null = unassigned (LINA-235). */
  assigneePartyId: string | null;
  /** Free-form specialty label ("Electrical"), '' = none. The chip's text. */
  trade: string;
  /** Sub-sub-actions under this task. Always [] on a sub-task (the 3-level cap). */
  children: TaskDraft[];
  /**
   * DERIVED progress, never authored (ADR-0019). Absent on an authored draft;
   * present only when a live plan is hydrated for read. The child-count meter
   * (LINA-259) reads it, defaulting to 'not_started' — no op here ever sets it.
   */
  status?: StageStatus;
}
export interface PhaseDraft {
  key: string; name: string; tasks: TaskDraft[];
  /** Typed links to this phase's predecessors (LINA-233, typed by ADR-0020). */
  dependsOn: DepEdge[];
  /** A phase is a stage like any other — it may be owned and tagged too. */
  assigneePartyId: string | null;
  trade: string;
}

let keySeq = 0;
/** A stable per-session draft key. Not a stage id — the server assigns those. */
export function newKey(prefix = 'k'): string {
  keySeq += 1;
  return `${prefix}-${keySeq}`;
}

function emptyTask(name = ''): TaskDraft {
  return {
    key: newKey('t'), name, start: '', end: '', description: '',
    dependsOn: [], assigneePartyId: null, trade: '', children: [],
  };
}

/** A fresh sub-sub-action row. Keyed 's-' so a draft reads at a glance. */
function emptySubtask(name = ''): TaskDraft {
  return {
    key: newKey('s'), name, start: '', end: '', description: '',
    dependsOn: [], assigneePartyId: null, trade: '', children: [],
  };
}

/** A task's sub-tasks, tolerating a draft built before the level existed. */
const kids = (t: TaskDraft): TaskDraft[] => t.children ?? [];

/** A fresh draft of the standard skeleton, with new keys each call. */
export function seedSkeleton(): PhaseDraft[] {
  return PLAN_SKELETON.map((p) => ({
    key: newKey('p'),
    name: p.name,
    dependsOn: [],
    assigneePartyId: null,
    trade: '',
    tasks: p.tasks.map((t) => emptyTask(t)),
  }));
}

/** An empty phase, for "Add phase". */
export function emptyPhase(name = ''): PhaseDraft {
  return { key: newKey('p'), name, tasks: [], dependsOn: [], assigneePartyId: null, trade: '' };
}

export { emptyTask, emptySubtask };

// ── Hydrating an existing draft back into the editor (LINA-230) ──────────────
// The server returns a saved draft as a WBS tree (PlanStageNode-shaped) through
// GET /plan. "Keep editing" re-opens the editor on THAT draft rather than on the
// skeleton, so the author resumes exactly where they saved. Dates come back as
// wire dates (null) and become the editor's raw '' strings.

interface DraftStageNode {
  /** The server's stage id — the currency `dependsOn` comes back in. */
  id?: string;
  name: string;
  description?: string | null;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  /**
   * Resolved TYPED predecessor edges (ADR-0020): `on` is the server's stage id,
   * re-keyed to a local key below. This is the field the editor reads — the
   * service still dual-emits a legacy untyped `dependsOn: string[]` beside it
   * for `plan-baseline.ts`, which this file deliberately ignores: an untyped
   * edge read here would have to invent a type.
   */
  dependencies?: Array<{ on: string; type?: string | null }> | null;
  /** The owning member's party id, or null (LINA-235). */
  assigneePartyId?: string | null;
  /** Free-form specialty label, or null. */
  trade?: string | null;
  /** DERIVED status, present only on a hydrated LIVE plan (LINA-259). */
  status?: StageStatus | null;
  children?: DraftStageNode[] | null;
}

/**
 * Turn a saved draft's stage tree into the editor's phase/task model.
 *
 * Dependencies come back as typed edges over the SERVER's stage ids (contract
 * §0 / ADR-0020 §3: `dependencies: [{ on, type }]`), so re-keying is a two-pass —
 * every node has to have been given its local key before any edge can be
 * translated, since a predecessor may sit later in the tree (a phase may follow
 * a task in a phase below it). An edge naming a stage that is not in this tree
 * is dropped rather than carried as a dangling key the next save would 400 on.
 */
export function hydrateDraft(stages: DraftStageNode[]): PhaseDraft[] {
  const keyByStageId = new Map<string, string>();
  // A task and a sub-task hydrate identically — same fields, same key mapping —
  // so one reader serves both levels. Anything the server returned BELOW a
  // sub-task is dropped: the editor has no row to show it on, and carrying it
  // would make the next save the `too_deep` the server has already refused.
  const readTask = (t: DraftStageNode, prefix: string, deep: boolean): TaskDraft => {
    const key = newKey(prefix);
    if (t.id) keyByStageId.set(t.id, key);
    return {
      key,
      name: t.name,
      start: t.plannedStartDate ?? '',
      end: t.plannedEndDate ?? '',
      description: t.description ?? '',
      dependsOn: [],
      // An assignee the author set survives the round trip; a stage the server
      // has no owner for comes back null, which is "Unassigned" and not a guess.
      assigneePartyId: t.assigneePartyId ?? null,
      trade: t.trade ?? '',
      // Read-only status the meter derives from — absent on a draft, real on a
      // hydrated live plan. Never authored (ADR-0019).
      ...(t.status ? { status: t.status } : {}),
      children: deep ? (t.children ?? []).map((s) => readTask(s, 's', false)) : [],
    };
  };

  const phases: PhaseDraft[] = stages.map((p) => {
    const key = newKey('p');
    if (p.id) keyByStageId.set(p.id, key);
    return {
      key,
      name: p.name,
      dependsOn: [],
      assigneePartyId: p.assigneePartyId ?? null,
      trade: p.trade ?? '',
      tasks: (p.children ?? []).map((t) => readTask(t, 't', true)),
    };
  });

  // An edge whose type the server does not name falls back to the default —
  // the same thing migration 0010's column default does for a pre-ADR-0020 row,
  // so an old plan reads as the finish-to-start graph it has always been.
  const translate = (deps: DraftStageNode['dependencies']): DepEdge[] => {
    const out: DepEdge[] = [];
    const seen = new Set<string>();
    for (const d of deps ?? []) {
      const key = d && typeof d.on === 'string' ? keyByStageId.get(d.on) : undefined;
      if (key === undefined || seen.has(key)) continue; // dangling, or a dup the save would 400 on
      seen.add(key);
      out.push({ on: key, type: isDepType(d.type) ? d.type : DEFAULT_DEP_TYPE });
    }
    return out;
  };

  stages.forEach((p, pi) => {
    phases[pi].dependsOn = translate(p.dependencies);
    (p.children ?? []).forEach((t, ti) => {
      phases[pi].tasks[ti].dependsOn = translate(t.dependencies);
      (t.children ?? []).forEach((s, si) => {
        const sub = phases[pi].tasks[ti].children[si];
        if (sub) sub.dependsOn = translate(s.dependencies);
      });
    });
  });
  return phases;
}

// ── Pure draft operations (the editor's "organise tasks" vocabulary) ─────────
// Every operation returns a NEW array (no mutation), so React state updates and
// undo stay honest and the functions are trivially testable.

function replaceAt<T>(arr: T[], i: number, next: T): T[] {
  const out = arr.slice();
  out[i] = next;
  return out;
}

function move<T>(arr: T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (i < 0 || i >= arr.length || j < 0 || j >= arr.length) return arr;
  const out = arr.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/**
 * Move item `from` to index `to`, sliding the rest — the drag-and-drop reorder
 * the pen asks for ("drag a row", not step-by-step arrows). Insert semantics, not
 * a swap: dropping row 5 onto row 1 leaves 2–4 in order. Out-of-range or a no-op
 * drop returns the same array unchanged.
 */
function reorder<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= arr.length || to < 0 || to >= arr.length) return arr;
  const out = arr.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

export function renamePhase(phases: PhaseDraft[], pi: number, name: string): PhaseDraft[] {
  return replaceAt(phases, pi, { ...phases[pi], name });
}

export function movePhase(phases: PhaseDraft[], pi: number, delta: number): PhaseDraft[] {
  return move(phases, pi, delta);
}

/** Drag-drop a phase from one position to another (insert, not swap). */
export function reorderPhase(phases: PhaseDraft[], from: number, to: number): PhaseDraft[] {
  return reorder(phases, from, to);
}

/** Drag-drop a task within its phase from one position to another. */
export function reorderTask(phases: PhaseDraft[], pi: number, from: number, to: number): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, { ...phase, tasks: reorder(phase.tasks, from, to) });
}

/** Replace one task in place — the seam every task/sub-task edit goes through. */
function replaceTask(phases: PhaseDraft[], pi: number, ti: number, next: TaskDraft): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, { ...phase, tasks: replaceAt(phase.tasks, ti, next) });
}

/** Replace one sub-task in place. */
function replaceSubtask(
  phases: PhaseDraft[], pi: number, ti: number, si: number, next: TaskDraft,
): PhaseDraft[] {
  const task = phases[pi].tasks[ti];
  return replaceTask(phases, pi, ti, { ...task, children: replaceAt(kids(task), si, next) });
}

/**
 * Drop every predecessor edge pointing at a stage that is no longer in the
 * draft. Removing a stage others depended on must take its edges with it —
 * otherwise a chip would render for a row that is gone, and the save would ship
 * a key the server has never heard of (`400 unknown_dependency`).
 */
function pruneEdges(phases: PhaseDraft[]): PhaseDraft[] {
  const live = new Set<string>();
  for (const p of phases) {
    live.add(p.key);
    for (const t of p.tasks) { live.add(t.key); for (const s of kids(t)) live.add(s.key); }
  }
  const keep = (deps: DepEdge[]) => deps.filter((d) => live.has(d.on));
  return phases.map((p) => ({
    ...p,
    dependsOn: keep(p.dependsOn),
    tasks: p.tasks.map((t) => ({
      ...t,
      dependsOn: keep(t.dependsOn),
      children: kids(t).map((s) => ({ ...s, dependsOn: keep(s.dependsOn) })),
    })),
  }));
}

export function removePhase(phases: PhaseDraft[], pi: number): PhaseDraft[] {
  return pruneEdges(phases.filter((_, i) => i !== pi));
}

export function addPhase(phases: PhaseDraft[]): PhaseDraft[] {
  return [...phases, emptyPhase()];
}

export function addTask(phases: PhaseDraft[], pi: number): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, { ...phase, tasks: [...phase.tasks, emptyTask()] });
}

export function renameTask(phases: PhaseDraft[], pi: number, ti: number, name: string): PhaseDraft[] {
  return replaceTask(phases, pi, ti, { ...phases[pi].tasks[ti], name });
}

export function setTaskDate(
  phases: PhaseDraft[], pi: number, ti: number, field: 'start' | 'end', value: string,
): PhaseDraft[] {
  return replaceTask(phases, pi, ti, { ...phases[pi].tasks[ti], [field]: value });
}

/**
 * Set both of a task's dates in one immutable update — the Gantt "move" drag
 * (LINA-236) shifts start and finish together, and doing it as one op keeps the
 * two dates from being written across two renders (which would flash an inverted
 * bar mid-drag). Blanks are preserved as '' exactly like setTaskDate.
 */
export function setTaskDates(
  phases: PhaseDraft[], pi: number, ti: number, start: string, end: string,
): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, {
    ...phase,
    tasks: replaceAt(phase.tasks, ti, { ...phase.tasks[ti], start, end }),
  });
}

/** Edit a task's free-form description (the task-detail drawer field, LINA-234). */
export function setTaskDescription(
  phases: PhaseDraft[], pi: number, ti: number, description: string,
): PhaseDraft[] {
  return replaceTask(phases, pi, ti, { ...phases[pi].tasks[ti], description });
}

export function moveTask(phases: PhaseDraft[], pi: number, ti: number, delta: number): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, { ...phase, tasks: move(phase.tasks, ti, delta) });
}

export function removeTask(phases: PhaseDraft[], pi: number, ti: number): PhaseDraft[] {
  const phase = phases[pi];
  // A task takes its sub-tasks down with it — pruneEdges then drops every edge
  // that named any of them.
  return pruneEdges(replaceAt(phases, pi, { ...phase, tasks: phase.tasks.filter((_, i) => i !== ti) }));
}

// ── The third level: sub-sub-actions (LINA-243, ADR-0019) ───────────────────
// The same five verbs as a task — add, rename, date, describe, remove, reorder —
// one level down. There is deliberately NO addSubSubtask: three levels is the
// contract, and the way a client refuses a fourth is by never offering it. (A
// draft that carries one anyway is caught at the wire edge, see `toWire`.)

export function addSubtask(phases: PhaseDraft[], pi: number, ti: number): PhaseDraft[] {
  const task = phases[pi].tasks[ti];
  return replaceTask(phases, pi, ti, { ...task, children: [...kids(task), emptySubtask()] });
}

export function renameSubtask(
  phases: PhaseDraft[], pi: number, ti: number, si: number, name: string,
): PhaseDraft[] {
  return replaceSubtask(phases, pi, ti, si, { ...kids(phases[pi].tasks[ti])[si], name });
}

export function setSubtaskDate(
  phases: PhaseDraft[], pi: number, ti: number, si: number, field: 'start' | 'end', value: string,
): PhaseDraft[] {
  return replaceSubtask(phases, pi, ti, si, { ...kids(phases[pi].tasks[ti])[si], [field]: value });
}

/**
 * Set both of a sub-task's dates in one immutable update — the third-level
 * sibling of setTaskDates, for the Gantt "move" drag on a sub-task bar
 * (LINA-244). One op, so start and finish never land across two renders.
 */
export function setSubtaskDates(
  phases: PhaseDraft[], pi: number, ti: number, si: number, start: string, end: string,
): PhaseDraft[] {
  return replaceSubtask(phases, pi, ti, si, { ...kids(phases[pi].tasks[ti])[si], start, end });
}

export function setSubtaskDescription(
  phases: PhaseDraft[], pi: number, ti: number, si: number, description: string,
): PhaseDraft[] {
  return replaceSubtask(phases, pi, ti, si, { ...kids(phases[pi].tasks[ti])[si], description });
}

export function removeSubtask(phases: PhaseDraft[], pi: number, ti: number, si: number): PhaseDraft[] {
  const task = phases[pi].tasks[ti];
  return pruneEdges(replaceTask(phases, pi, ti, {
    ...task, children: kids(task).filter((_, i) => i !== si),
  }));
}

/** Step a sub-task up/down within its task (the keyboard-reachable move). */
export function moveSubtask(
  phases: PhaseDraft[], pi: number, ti: number, si: number, delta: number,
): PhaseDraft[] {
  const task = phases[pi].tasks[ti];
  return replaceTask(phases, pi, ti, { ...task, children: move(kids(task), si, delta) });
}

/** Drag-drop a sub-task within its OWN task — it never crosses into another. */
export function reorderSubtask(
  phases: PhaseDraft[], pi: number, ti: number, from: number, to: number,
): PhaseDraft[] {
  const task = phases[pi].tasks[ti];
  return replaceTask(phases, pi, ti, { ...task, children: reorder(kids(task), from, to) });
}

// ── WBS level promotion / demotion (LINA-259 ask 7, ADR-0019 depth cap) ──────
// Re-parent a node one level up or down within its phase, NEVER breaking the
// three-levels-deep contract. Every guard that would create a fourth level (or
// climb above a phase) is a no-op returning the same array — the same shape the
// UI reads to disable the action. Reparenting keeps every key alive, so no
// dependency edge is orphaned and pruneEdges is not needed.

/**
 * PROMOTE — lift a node one level:
 *   • an L3 sub-task becomes an L2 task under the same phase, inserted directly
 *     AFTER its former parent (so it reads where it left off). A sub-task's
 *     `children` is always [] (the depth cap), so the new task is a valid L2.
 *   • an L2 task has nowhere to go — a phase is the ceiling — so it is a no-op.
 * `si` names the sub-task; omit it to (attempt to) promote the L2 task at `ti`.
 */
export function promoteNode(
  phases: PhaseDraft[], pi: number, ti: number, si?: number,
): PhaseDraft[] {
  if (si == null) return phases; // an L2 task cannot promote above phase level
  const phase = phases[pi];
  if (!phase) return phases;
  const task = phase.tasks[ti];
  if (!task) return phases;
  const sub = kids(task)[si];
  if (!sub) return phases;
  const newTask = { ...task, children: kids(task).filter((_, i) => i !== si) };
  const tasks = phase.tasks.slice();
  tasks[ti] = newTask;
  // The sub already carries children: [] (L3 invariant), so it slots in as an
  // L2 task without any risk of a fourth level.
  tasks.splice(ti + 1, 0, { ...sub, children: [] });
  return replaceAt(phases, pi, { ...phase, tasks });
}

/**
 * DEMOTE — push a node one level down:
 *   • an L2 task becomes an L3 sub-task of its immediately PRECEDING sibling —
 *     appended as that task's last child. Allowed ONLY when the task itself has
 *     no children (else the move would carry an L3 node down to L4) and there IS
 *     a preceding sibling. Both bars are no-ops.
 *   • an L3 sub-task is already at the floor — no-op.
 * `si` names the sub-task; omit it to (attempt to) demote the L2 task at `ti`.
 */
export function demoteNode(
  phases: PhaseDraft[], pi: number, ti: number, si?: number,
): PhaseDraft[] {
  if (si != null) return phases; // an L3 sub-task cannot demote further
  const phase = phases[pi];
  if (!phase) return phases;
  const task = phase.tasks[ti];
  if (!task) return phases;
  if (ti === 0) return phases; // no preceding sibling to nest under
  if (kids(task).length > 0) return phases; // has children → demoting would make depth 4
  const prev = phase.tasks[ti - 1];
  const newPrev = { ...prev, children: [...kids(prev), { ...task, children: [] }] };
  const tasks = phase.tasks.filter((_, i) => i !== ti);
  tasks[ti - 1] = newPrev; // removing ti leaves prev at ti-1 untouched
  return replaceAt(phases, pi, { ...phase, tasks });
}

// ── Dependencies: typed scheduling links (LINA-233, ADR-0020) ───────────────
// An edge reads "this stage is scheduled against that one, THIS way", stored on
// the DEPENDENT as `dependsOn: [{ on: predecessorKey, type }]` — the same
// direction as the wire, so nothing is flipped at the edge. There is at most ONE
// link per ordered pair (ADR-0020 §2: the type qualifies the link, it does not
// multiply it); the server refuses a second with `400 duplicate_dependency`, so
// every op below keys by `on`. The server is the authority on what is a
// legal graph (it revalidates the whole thing on every save and refuses a cycle
// with 409); everything here is the courtesy layer that stops the author walking
// into that refusal, plus the labels the picker and the chips print.

/** One stage of the draft, as the picker and the chips need to name it. */
export interface PlanNodeRef {
  key: string;
  /** '1' / '1.2' — computed from POSITION, so it stays true after a reorder. */
  outline: string;
  /** The typed name, with any hand-written outline prefix taken off. */
  name: string;
  /** '1.2 Framing' — what a chip or an option prints (pen: "depends on"). */
  label: string;
  isPhase: boolean;
  /** 1 phase · 2 task · 3 sub-task — the picker indents by it (LINA-243). */
  level: 1 | 2 | 3;
  /** The owning phase's key ('' for a phase itself) — the picker groups by it. */
  phaseKey: string;
}

// The skeleton names its phases "1 · Pre-Construction" and its tasks "1.2 Design
// & Engineering", and authors type the same way. We prefix the computed outline
// number (so a reordered row renumbers honestly), which would read "1 1 ·
// Pre-Construction" if the typed prefix stayed. Strip a leading number ONLY when
// it is multi-level ("2.10 ") or followed by a separator ("1 · ", "3. ") — a name
// like "3 bedroom fit-out" keeps its number, since that is prose, not an index.
const OUTLINE_PREFIX = /^\s*(?:\d+(?:\.\d+)+\s+|\d+\s*[·.:)\-–—]\s*)/;

function stripOutline(name: string): string {
  return name.replace(OUTLINE_PREFIX, '').trim();
}

/** Every stage in the draft, in reading order, labelled for display. */
export function planNodes(phases: PhaseDraft[]): PlanNodeRef[] {
  const out: PlanNodeRef[] = [];
  phases.forEach((phase, pi) => {
    const outline = String(pi + 1);
    const name = stripOutline(phase.name) || 'Untitled phase';
    out.push({
      key: phase.key, outline, name, label: `${outline} ${name}`,
      isPhase: true, level: 1, phaseKey: '',
    });
    phase.tasks.forEach((task, ti) => {
      const to = `${pi + 1}.${ti + 1}`;
      const tn = stripOutline(task.name) || 'Untitled task';
      out.push({
        key: task.key, outline: to, name: tn, label: `${to} ${tn}`,
        isPhase: false, level: 2, phaseKey: phase.key,
      });
      kids(task).forEach((sub, si) => {
        const so = `${to}.${si + 1}`;
        const sn = stripOutline(sub.name) || 'Untitled sub-task';
        out.push({
          key: sub.key, outline: so, name: sn, label: `${so} ${sn}`,
          isPhase: false, level: 3, phaseKey: phase.key,
        });
      });
    });
  });
  return out;
}

/** key → its label, for rendering chips without re-walking the tree per row. */
export function nodeIndex(phases: PhaseDraft[]): Map<string, PlanNodeRef> {
  return new Map(planNodes(phases).map((n) => [n.key, n]));
}

/** key → its declared typed edges. The graph every helper below walks. */
function edges(phases: PhaseDraft[]): Map<string, DepEdge[]> {
  const m = new Map<string, DepEdge[]>();
  for (const p of phases) {
    m.set(p.key, p.dependsOn);
    for (const t of p.tasks) {
      m.set(t.key, t.dependsOn);
      for (const s of kids(t)) m.set(s.key, s.dependsOn);
    }
  }
  return m;
}

/**
 * Every stage that transitively depends on `key` (its downstream).
 *
 * TYPE-BLIND, like the cycle check: all three link types are ordering edges on
 * one directed graph (ADR-0020 §4), so a `starts_with` closes a loop exactly as
 * a `starts_after` does and is held back from the picker just the same.
 */
function dependents(phases: PhaseDraft[], key: string): Set<string> {
  const deps = edges(phases);
  const out = new Set<string>();
  let grew = true;
  // Small graphs (tens of rows) — a fixpoint sweep is clearer than a reverse
  // index and cannot loop forever even if the graph is momentarily cyclic.
  while (grew) {
    grew = false;
    for (const [node, preds] of deps) {
      if (out.has(node)) continue;
      if (preds.some((p) => p.on === key || out.has(p.on))) { out.add(node); grew = true; }
    }
  }
  return out;
}

/**
 * The choices to offer for `forKey`, grouped by phase.
 *
 * Every other stage is offered — any level, any phase (scope = any-stage). Two
 * are held back as a courtesy: the row itself (`400 self_dependency`) and
 * anything already downstream of it, which would close a cycle the server would
 * refuse with `409`. Already-selected keys are always offered, so a graph that
 * somehow got into a bad shape can still be un-picked rather than frozen.
 */
export function dependencyChoices(
  phases: PhaseDraft[], forKey: string,
): Array<{ phase: PlanNodeRef; options: PlanNodeRef[] }> {
  const selected = new Set((edges(phases).get(forKey) ?? []).map((d) => d.on));
  const blocked = dependents(phases, forKey);
  const nodes = planNodes(phases);
  const groups: Array<{ phase: PlanNodeRef; options: PlanNodeRef[] }> = [];
  for (const n of nodes) {
    if (n.isPhase) groups.push({ phase: n, options: [] });
    const offerable = n.key !== forKey && (selected.has(n.key) || !blocked.has(n.key));
    if (offerable && groups.length > 0) groups[groups.length - 1].options.push(n);
  }
  return groups.filter((g) => g.options.length > 0);
}

/** One stage's declared typed links, in author order — any level. */
export function dependsOnOf(phases: PhaseDraft[], key: string): DepEdge[] {
  return edges(phases).get(key) ?? [];
}

/**
 * Replace a stage's link list (by key — phases and tasks alike).
 *
 * Self-links are dropped (the server's `400 self_dependency`) and a repeated
 * target keeps its FIRST entry (`400 duplicate_dependency`): one link per
 * ordered pair is the storage shape, so the draft never holds a list the save
 * is certain to refuse.
 */
export function setDependsOn(phases: PhaseDraft[], key: string, dependsOn: DepEdge[]): PhaseDraft[] {
  const seen = new Set<string>();
  const next = dependsOn.filter((d) => {
    if (d.on === key || seen.has(d.on)) return false;
    seen.add(d.on);
    return true;
  });
  return phases.map((p) => ({
    ...p,
    dependsOn: p.key === key ? next : p.dependsOn,
    // Rows that are not the target keep their identity — only the one stage
    // whose list is being replaced (at either level) is rebuilt.
    tasks: p.tasks.map((t) => {
      const hit = kids(t).some((s) => s.key === key);
      const children = hit ? kids(t).map((s) => (s.key === key ? { ...s, dependsOn: next } : s)) : t.children;
      if (t.key === key) return { ...t, dependsOn: next, children };
      return hit ? { ...t, children } : t;
    }),
  }));
}

/**
 * Add or remove one link — what a picker checkbox and a chip's ✕ do.
 *
 * A link is BORN `starts_after` (ADR-0020: the default type, and the column
 * default the server writes). The author then says how it really blocks on the
 * chip's type selector; re-ticking a predecessor that is already linked removes
 * it, taking its type with it rather than silently keeping a stale one.
 */
export function toggleDependency(phases: PhaseDraft[], key: string, dep: string): PhaseDraft[] {
  const current = edges(phases).get(key) ?? [];
  return setDependsOn(
    phases, key,
    current.some((d) => d.on === dep)
      ? current.filter((d) => d.on !== dep)
      : [...current, { on: dep, type: DEFAULT_DEP_TYPE }],
  );
}

/**
 * Re-type ONE existing link — the chip's type selector. A pair that is not
 * linked is left alone: the picker creates links, this only qualifies them, so
 * a stale selector on a row whose link was just removed cannot resurrect it.
 */
export function setDependencyType(
  phases: PhaseDraft[], key: string, dep: string, type: DepType,
): PhaseDraft[] {
  const current = edges(phases).get(key) ?? [];
  if (!current.some((d) => d.on === dep)) return phases;
  return setDependsOn(phases, key, current.map((d) => (d.on === dep ? { ...d, type } : d)));
}

/** One typed link, flattened — what the Gantt draws a connector for. */
export interface PlanLink {
  /** The stage that carries the link (the arrow's HEAD). */
  from: string;
  /** The predecessor it is scheduled against (the arrow's TAIL). */
  to: string;
  type: DepType;
}

/**
 * Every link in the draft, in reading order — the Gantt's connector list
 * (ADR-0020 §6). Flat, keyed by LOCAL keys, so the timeline can look each end
 * up in the bar geometry it already computed without re-walking the tree.
 */
export function planLinks(phases: PhaseDraft[]): PlanLink[] {
  const out: PlanLink[] = [];
  for (const [from, deps] of edges(phases)) {
    for (const d of deps) out.push({ from, to: d.on, type: d.type });
  }
  return out;
}

/**
 * A cycle in the draft's graph, in cycle order, or null.
 *
 * Mirrors the server's 3-colour DFS (plan-version.mjs `rejectDependencyCycles`)
 * so "Save plan" can stay disabled rather than let the author fire a request
 * that is certain to come back 409. The server, not this, is the authority —
 * this only ever agrees with it earlier.
 */
export function detectCycle(phases: PhaseDraft[]): PlanNodeRef[] | null {
  const deps = edges(phases);
  const index = nodeIndex(phases);
  const colour = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycle: PlanNodeRef[] | null = null;

  const visit = (k: string): boolean => {
    colour.set(k, 1);
    stack.push(k);
    // TYPE-BLIND (ADR-0020 §4): one DAG regardless of link type, so a mutual
    // `starts_with` pair is a cycle here exactly as the server treats it.
    for (const { on: pred } of deps.get(k) ?? []) {
      if (colour.get(pred) === 1) {
        cycle = stack.slice(stack.indexOf(pred))
          .map((x) => index.get(x))
          .filter((n): n is PlanNodeRef => n != null);
        return true;
      }
      if ((colour.get(pred) ?? 0) === 0 && visit(pred)) return true;
    }
    colour.set(k, 2);
    stack.pop();
    return false;
  };

  for (const k of deps.keys()) {
    if ((colour.get(k) ?? 0) === 0 && visit(k)) return cycle;
  }
  return null;
}

// ── Owner + specialty (LINA-235/246, ADR-0017 annex 3) ──────────────────────
// Both live on EVERY stage — a phase can be a trade's from end to end, a task can
// be one person's, a sub-task can be a different sub's. So both ops address a
// stage by KEY at any level, the same way `setDependsOn` does, rather than
// growing a per-level pair.
//
// ASSIGNMENT IS ATTRIBUTION, NOT PERMISSION. Naming a party on a stage says who
// is expected to do it. It grants nothing: the assignee reads and writes exactly
// what their membership role already allowed, and the server never consults
// `assignee_party_id` to authorise anything. That is why the picker offers only
// parties who are ALREADY members — an id the project does not know comes back
// `400 unknown_assignee` rather than quietly seating someone.

/** Rebuild exactly the one stage `key` names, at whichever level it sits. */
function patchStage(
  phases: PhaseDraft[],
  key: string,
  patch: { assigneePartyId?: string | null; trade?: string },
): PhaseDraft[] {
  return phases.map((p) => {
    if (p.key === key) return { ...p, ...patch };
    let touchedTasks = false;
    const tasks = p.tasks.map((t) => {
      if (t.key === key) { touchedTasks = true; return { ...t, ...patch }; }
      if (!kids(t).some((s) => s.key === key)) return t;
      touchedTasks = true;
      return { ...t, children: kids(t).map((s) => (s.key === key ? { ...s, ...patch } : s)) };
    });
    return touchedTasks ? { ...p, tasks } : p;
  });
}

/**
 * Name the member who owns a stage, or clear it.
 *
 * The party id is passed straight through — this file never maps it to a name.
 * Display names and avatars are a pure FE projection of the project members the
 * screen already holds (ADR-0006): the schedule service stores an id and nothing
 * else, so a party who is renamed is renamed everywhere at once rather than
 * leaving a stale copy frozen into the plan.
 */
export function setAssignee(
  phases: PhaseDraft[], key: string, assigneePartyId: string | null,
): PhaseDraft[] {
  return patchStage(phases, key, { assigneePartyId });
}

/** Set a stage's free-form specialty label ('' clears it). */
export function setTrade(phases: PhaseDraft[], key: string, trade: string): PhaseDraft[] {
  return patchStage(phases, key, { trade });
}

/** One stage's owner + specialty, by key — for the row controls. */
export function stageMeta(
  phases: PhaseDraft[], key: string,
): { assigneePartyId: string | null; trade: string } {
  for (const p of phases) {
    if (p.key === key) return { assigneePartyId: p.assigneePartyId ?? null, trade: p.trade ?? '' };
    for (const t of p.tasks) {
      if (t.key === key) return { assigneePartyId: t.assigneePartyId ?? null, trade: t.trade ?? '' };
      for (const s of kids(t)) {
        if (s.key === key) return { assigneePartyId: s.assigneePartyId ?? null, trade: s.trade ?? '' };
      }
    }
  }
  return { assigneePartyId: null, trade: '' };
}

/** Total task count across all phases — for the "N tasks across M phases" summary. */
export function taskCount(phases: PhaseDraft[]): number {
  return phases.reduce((acc, p) => acc + p.tasks.length, 0);
}

/** Sub-tasks across the whole draft — the summary's "· N sub-tasks" tail. */
export function subtaskCount(phases: PhaseDraft[]): number {
  return phases.reduce(
    (acc, p) => acc + p.tasks.reduce((n, t) => n + kids(t).length, 0),
    0,
  );
}

// ── Derived child-status counts (LINA-259 ask 5) ─────────────────────────────
// A parent row (a phase, or a task that has sub-tasks) carries a segmented meter
// of its children by status. Status is DERIVED, never authored (ADR-0019), so on
// a fresh draft every child reads 'not_started' and the meter is honestly all
// grey — nothing here fabricates progress. When a LIVE plan is hydrated the
// optional `status` feeds the same counts. 'blocked' is folded into inProgress:
// a blocked stage is work under way that is stuck, not work not begun, and the
// three-segment meter has no fourth bucket to spend on it.

export interface StatusCounts {
  done: number;
  inProgress: number;
  notStarted: number;
  total: number;
}

/** A child's derived status, defaulting to 'not_started' when unreported. */
function statusOf(node: TaskDraft): StageStatus {
  return node.status ?? 'not_started';
}

/**
 * Count a parent's DIRECT children by status. A phase's children are its tasks;
 * a task's children are its sub-tasks. A leaf task (no children) returns all
 * zeros — the caller draws no meter for it. Pure over the draft.
 */
export function childStatusCounts(node: PhaseDraft | TaskDraft): StatusCounts {
  const children: TaskDraft[] = 'tasks' in node ? node.tasks : kids(node);
  const counts: StatusCounts = { done: 0, inProgress: 0, notStarted: 0, total: children.length };
  for (const c of children) {
    const s = statusOf(c);
    if (s === 'done') counts.done += 1;
    else if (s === 'in_progress' || s === 'blocked') counts.inProgress += 1;
    else counts.notStarted += 1;
  }
  return counts;
}

// ── The wire edge ─────────────────────────────────────────────────────────────

/** An action node of the authored WBS, as the server's :author contract wants it. */
export interface AuthoredNode {
  name: string;
  /** The author-local key (contract §1) — resolves `dependsOn`, never stored. */
  key: string;
  /**
   * Typed predecessor links (contract v5 / ADR-0020 §3). Always sent, `[]` when
   * none, so a cleared row clears. The object form is used for EVERY link, even
   * a `starts_after` one the server would have accepted as a bare string: the
   * payload then says what it means rather than leaning on a column default.
   */
  dependsOn: Array<{ key: string; type: DepType }>;
  description?: string | null;
  /** The owning member's party id, or null. Always sent, so clearing clears. */
  assigneePartyId?: string | null;
  /** Free-form specialty label, or null. Always sent, so clearing clears. */
  trade?: string | null;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  children?: AuthoredNode[];
}

/** The server's `details` on a dependency refusal (contract §3). */
export interface PlanAuthorErrorDetails {
  /** `409 dependency_cycle` — every stage on the cycle, in cycle order. */
  stages?: Array<{ key: string | null; name: string }>;
  /** `400 unknown_dependency` — the key that matched nothing, and its dependent. */
  key?: string;
  stage?: string;
}

/** A refusal raised before we send — an empty name, nothing to send. */
export class PlanAuthorError extends Error {
  code: string;
  status: number;
  /** Server-supplied detail: the cycle's stages, or the unknown key (§3). */
  details: PlanAuthorErrorDetails | null;
  constructor(code: string, message: string, status = 0, details: PlanAuthorErrorDetails | null = null) {
    super(message);
    this.name = 'PlanAuthorError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const dateOrNull = (v: string): string | null => (v && v.trim() ? v.trim() : null);

/** '' → null at the wire edge; the server stores a trade or nothing, never ''. */
const textOrNull = (v: string | null | undefined): string | null =>
  (v && v.trim() ? v.trim() : null);

/**
 * Build the `{ stages }` body, validating client-side first so the author gets a
 * pointed message beside the field rather than a round-trip 400. Mirrors exactly
 * what the server re-validates (§1): every phase, task and sub-task needs a name;
 * empty phases are dropped (a phase with no tasks is a heading the author started
 * and left — not an error, just not sent); dates pass through, blanks become null.
 *
 * Three levels, never four (LINA-243, ADR-0019). A task emits `children` when it
 * has sub-tasks worth sending and omits the field otherwise, so a two-level plan
 * puts exactly the bytes on the wire it always did. A sub-task carrying children
 * of its own is a bug in the draft, not an author mistake — it is refused here
 * with the server's own `too_deep` rather than sent to be refused there.
 *
 * Dependencies (LINA-233, typed by ADR-0020): each node carries its local `key`,
 * and `dependsOn` naming its predecessors as `{ key, type }` objects — contract
 * v5. THE WHOLE GRAPH GOES EVERY TIME — the server
 * replaces a draft's edges atomically, so a re-save that omitted an edge would
 * delete it. Edges pointing at a stage this pass dropped (a blank row) are
 * filtered out here rather than sent to be refused as `unknown_dependency`.
 */
export function toWire(phases: PhaseDraft[]): AuthoredNode[] {
  // Which rows will actually be sent — computed first, because an edge may point
  // at a row that comes later in the tree.
  const sent = new Set<string>();
  // An owner or a trade counts as touching the row: a task the author named
  // nobody on but handed to "Electrical" is a row they filled in, and dropping
  // it would throw that away silently. (A NAMED row is still the only one that
  // saves — a nameless one raises `invalid_name` below, as it always did.)
  const touched = (t: TaskDraft) =>
    t.name.trim() !== '' || !!t.start || !!t.end || (t.description ?? '').trim() !== ''
    || t.assigneePartyId != null || (t.trade ?? '').trim() !== '';
  // A sub-task the author added and never filled in is dropped like a blank task.
  const subs = (t: TaskDraft) => kids(t).filter(touched);
  // A row the author never touched is dropped — UNLESS it now holds a real
  // sub-task, which would otherwise be silently thrown away with its parent.
  const keeps = (t: TaskDraft) => touched(t) || subs(t).length > 0;
  for (const phase of phases) {
    const tasks = phase.tasks.filter(keeps);
    if (!phase.name.trim() && tasks.length === 0) continue;
    sent.add(phase.key);
    for (const t of tasks) { sent.add(t.key); for (const s of subs(t)) sent.add(s.key); }
  }
  const wireDeps = (deps: DepEdge[]) =>
    deps.filter((d) => sent.has(d.on)).map((d) => ({ key: d.on, type: d.type }));

  const stages: AuthoredNode[] = [];
  for (const phase of phases) {
    const name = phase.name.trim();
    const tasks = phase.tasks.filter(keeps);
    // A phase the author emptied out entirely is skipped silently.
    if (!name && tasks.length === 0) continue;
    if (!name) {
      throw new PlanAuthorError('invalid_name', 'Give every phase a name (or remove it).');
    }
    const children: AuthoredNode[] = tasks.map((t) => {
      const tn = t.name.trim();
      if (!tn) throw new PlanAuthorError('invalid_name', `A task under "${name}" needs a name.`);
      const grandchildren: AuthoredNode[] = subs(t).map((s) => {
        const sn = s.name.trim();
        if (!sn) throw new PlanAuthorError('invalid_name', `A sub-task under "${tn}" needs a name.`);
        if (kids(s).length > 0) {
          throw new PlanAuthorError(
            'too_deep',
            'A plan is three levels deep at most — a sub-task cannot have its own sub-tasks.',
          );
        }
        return {
          name: sn, key: s.key, dependsOn: wireDeps(s.dependsOn),
          description: (s.description ?? '').trim() || null,
          assigneePartyId: s.assigneePartyId ?? null, trade: textOrNull(s.trade),
          plannedStartDate: dateOrNull(s.start), plannedEndDate: dateOrNull(s.end),
        };
      });
      return {
        name: tn, key: t.key, dependsOn: wireDeps(t.dependsOn),
        description: (t.description ?? '').trim() || null,
        assigneePartyId: t.assigneePartyId ?? null, trade: textOrNull(t.trade),
        plannedStartDate: dateOrNull(t.start), plannedEndDate: dateOrNull(t.end),
        // Omitted, not `[]`, when there is no third level: a two-level plan puts
        // exactly the bytes on the wire it did before this level existed.
        ...(grandchildren.length > 0 ? { children: grandchildren } : {}),
      };
    });
    stages.push({
      name, key: phase.key, dependsOn: wireDeps(phase.dependsOn),
      assigneePartyId: phase.assigneePartyId ?? null, trade: textOrNull(phase.trade),
      children,
    });
  }
  if (stages.length === 0) {
    throw new PlanAuthorError('empty_plan', 'Add at least one phase before saving the plan.');
  }
  return stages;
}

export interface AuthorResult {
  planVersionId: string;
  /** null while drafting — a draft is unnumbered until it is sent for approval. */
  versionNo: number | null;
  status: 'draft';
  stageCount: number;
  rootCount: number;
  auditEventId: string;
}

/**
 * POST /api/v1/projects/:id/plan-versions:author — save the authored plan as a
 * private DRAFT (LINA-230; contract §0–§3). Only `{ stages }` crosses the wire;
 * the actor is the session. Saving is NOT sending for approval — the draft is
 * invisible to the other party until `:propose`. Re-saving replaces the single
 * draft in place. A refusal comes back as a typed PlanAuthorError so the editor
 * can react to the KIND (open_plan_exists / draft_exists send the author to the
 * live plan).
 */
export async function authorPlan(projectId: string, stages: AuthoredNode[]): Promise<AuthorResult> {
  const res = await fetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/plan-versions:author`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stages }),
    },
  );
  let payload: unknown = null;
  try { payload = await res.json(); } catch { /* proxy error page */ }
  if (!res.ok) {
    const err = (payload as {
      error?: { code?: string; message?: string; details?: PlanAuthorErrorDetails }
    } | null)?.error;
    // `details` carries the cycle's stages / the unknown key — the editor
    // highlights the offending rows from it (contract §3).
    throw new PlanAuthorError(
      err?.code ?? 'internal',
      err?.message ?? 'That did not go through. Try again.',
      res.status,
      err?.details ?? null,
    );
  }
  return payload as AuthorResult;
}
