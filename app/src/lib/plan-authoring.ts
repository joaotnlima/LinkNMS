// Direct plan authoring — the "build it here" route (LINA-228, ADR-0017).
// Frozen contract: docs/architecture/slice-direct-plan-authoring-contract.md.
//
// The date arithmetic (parse/format/addDays) is the Gantt's, reused for the
// dependency-date ENFORCEMENT below (LINA-306). plan-gantt imports nothing from
// here, so this direction is a clean one-way dependency — no cycle.
import { addDays, formatDay, parseDay } from './plan-gantt.ts';
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
//   2. FIVE LEVELS AT MOST (ADR-0019, cap lifted from 3 to 5 by PRD-01 G-1; D-25
//      allows 10 server-side). A phase (level 1) holds tasks (level 2); a task
//      holds child tasks, recursively, down to level MAX_DEPTH. Every tree op is
//      PATH-addressed (`NodePath` = [phase, task, child, …]) so it works at any
//      level; no operation nests below MAX_DEPTH, and `toWire` refuses a draft
//      that somehow carries one — `too_deep`, raised before the round-trip.
//   3. THE SKELETON IS A STARTING POINT, NOT A CLAIM. It carries names only — no
//      dates, no owner, no sub-tasks (the issue: "that is for the user to fill").

// ── The seeded skeleton (pen "Build the plan — schedule (Gantt)") ────────────
// A standard residential build broken into the three phases and the tasks the
// pen enumerates. Names only: unassigned, undated, no sub-tasks — the author
// fills those in.
//
// SINCE LINA-242 THIS IS THE FALLBACK, NOT THE SOURCE. The default plan shape now
// lives server-side in `schedule.plan_template` and is resolved per caller by
// GET /me/plan-template (user default → system default, ADR-0018); the build page
// seeds the editor from that. This constant is what the editor starts from only
// when the endpoint could not be reached — a scaffold is a convenience, so an
// unreachable template must degrade to a usable editor, never to an empty screen
// or an error page. Do not delete it, and do not make it the primary seed again.
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

// ── The template shape (LINA-241/242, ADR-0018) ──────────────────────────────
// What GET/PUT /me/plan-template carries: names only, exactly two levels. A
// phase is `{ name, tasks: [name, …] }` and a task is a BARE STRING — the edge
// rejects a task-as-object (`too_deep`) and any extra phase key, so this type is
// the whole contract, not a subset of it. PLAN_SKELETON is already this shape.

export interface TemplatePhase { name: string; tasks: readonly string[] }

/** GET/PUT /me/plan-template — the resolved default plus its provenance. */
export interface ResolvedPlanTemplate {
  /** Which rung of the ladder answered: the caller's own default, or the system one. */
  source: 'user' | 'system';
  body: TemplatePhase[];
  template: {
    id: string;
    ownerScope: 'user' | 'org' | 'system';
    name: string;
    isDefault: boolean;
    updatedAt: string;
  };
}

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
// dependencies) available at every level without a parallel model; the depth
// cap is not in the type but in the vocabulary: nothing adds a child to a node
// at MAX_DEPTH, so `children` there is always [] (ADR-0019, PRD-01 G-1).

/**
 * The deepest outline level the editor renders and authors. Level 1 is a phase,
 * level 2 a task, 3..5 nested sub-tasks. ONE place: the grid, the hydrate step,
 * `toWire` and every tree op read this. ADR-0019 capped it at 3; PRD-01 G-1
 * lifts it to 5. The server (D-25) allows 10, so this is a UI cap, not a schema
 * one.
 */
export const MAX_DEPTH = 5;

/**
 * A node's address in the draft: `[phaseIndex, taskIndex, childIndex, …]`. Its
 * length IS the node's level (1 = phase). Positional, so it is only valid for
 * the tree it was read from — callers re-derive it each render.
 */
export type NodePath = readonly number[];
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
  /** The directory taxonomy code picked with the label (PRD-03 R-2); absent/'' = free text only. */
  tradeCode?: string;
  /** Child tasks under this one. Always [] at MAX_DEPTH (the outline cap). */
  children: TaskDraft[];
  /**
   * DERIVED progress, never authored (ADR-0019). Absent on an authored draft;
   * present only when a live plan is hydrated for read. The child-count meter
   * (LINA-259) reads it, defaulting to 'not_started' — no op here ever sets it.
   */
  status?: StageStatus;
  /** On the critical path as the SERVER computed it for the saved plan (v2 `Task.is_critical`). */
  isCritical?: boolean;
}
export interface PhaseDraft {
  key: string; name: string; tasks: TaskDraft[];
  /** On the critical path as the server computed it (v2 `Task.is_critical`). */
  isCritical?: boolean;
  /** Typed links to this phase's predecessors (LINA-233, typed by ADR-0020). */
  dependsOn: DepEdge[];
  /** A phase is a stage like any other — it may be owned and tagged too. */
  assigneePartyId: string | null;
  trade: string;
  tradeCode?: string;
}

let keySeq = 0;
/** A stable per-session draft key. Not a stage id — the server assigns those. */
export function newKey(prefix = 'k'): string {
  keySeq += 1;
  return `${prefix}-${keySeq}`;
}

/**
 * Push the minting counter past keys that already exist (LINA-250).
 *
 * Since hydration REUSES a saved key (it is the workspace's address), a resumed
 * draft arrives carrying `t-1`, `t-2`, … while the counter in this fresh page
 * load is still 0 — so the next "Add task" would mint `t-1` a second time and
 * the save would come back `400 duplicate_key`. Absorbing the suffixes first is
 * what keeps a resumed draft addable to.
 */
function absorbKeys(keys: Iterable<string>): void {
  for (const key of keys) {
    const n = /^[a-z]+-(\d+)$/.exec(key);
    if (n) keySeq = Math.max(keySeq, Number(n[1]));
  }
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

/**
 * A fresh editor draft scaffolded from a names-only template body, with new keys
 * each call. The COPY boundary (ADR-0018): the template's names are copied into
 * a draft that from here on has nothing to do with it — editing the draft never
 * writes back, and the draft carries no template id. Dates, descriptions,
 * dependencies, owners and trades all start blank because a template holds none
 * of them; they are per-project, not shape.
 */
export function seedFromTemplate(body: ReadonlyArray<TemplatePhase>): PhaseDraft[] {
  return body.map((p) => ({
    key: newKey('p'),
    name: p.name,
    dependsOn: [],
    assigneePartyId: null,
    trade: '',
    tasks: (p.tasks ?? []).map((t) => emptyTask(t)),
  }));
}

/**
 * A fresh draft of the hard-coded skeleton. The FALLBACK seed only — the build
 * page normally passes the resolved template through `seedFromTemplate`.
 */
export function seedSkeleton(): PhaseDraft[] {
  return seedFromTemplate(PLAN_SKELETON);
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
  /**
   * The stage's PERSISTED key (LINA-249, migration 0011), when it has one.
   *
   * Hydration reuses it instead of minting a fresh one, and that is not a
   * convenience: the key is the address the task workspace and the task
   * permalink hang off (LINA-250). Re-keying a resumed draft would silently
   * orphan every comment and file on it and break every link already shared,
   * because the next save would write the new keys over the old ones.
   */
  key?: string | null;
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
  // Every node read, with the server edges still to translate — the second pass
  // runs once ALL keys exist, since a predecessor may sit later in the tree.
  const pending: Array<{ node: PhaseDraft | TaskDraft; deps: DraftStageNode['dependencies'] }> = [];
  const allKeys: string[] = [];
  // Every level below a phase hydrates identically — same fields, same key
  // mapping — so one recursive reader serves them all. Anything the server
  // returned BELOW MAX_DEPTH is dropped: the editor has no row to show it on,
  // and carrying it would make the next save the `too_deep` toWire refuses.
  const readTask = (t: DraftStageNode, level: number): TaskDraft => {
    // The saved key wins. A fresh one is minted only for a stage that never had
    // one (import-seeded and pre-LINA-249 rows), so resuming a draft neither
    // orphans its workspace nor breaks a shared task link.
    const key = t.key || newKey(level === 2 ? 't' : 's');
    if (t.id) keyByStageId.set(t.id, key);
    allKeys.push(key);
    const node: TaskDraft = {
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
      children: level < MAX_DEPTH ? (t.children ?? []).map((s) => readTask(s, level + 1)) : [],
    };
    pending.push({ node, deps: t.dependencies });
    return node;
  };

  const phases: PhaseDraft[] = stages.map((p) => {
    const key = p.key || newKey('p');
    if (p.id) keyByStageId.set(p.id, key);
    allKeys.push(key);
    const phase: PhaseDraft = {
      key,
      name: p.name,
      dependsOn: [],
      assigneePartyId: p.assigneePartyId ?? null,
      trade: p.trade ?? '',
      tasks: (p.children ?? []).map((t) => readTask(t, 2)),
    };
    pending.push({ node: phase, deps: p.dependencies });
    return phase;
  });

  // Every key this draft now holds — saved ones included, whether or not the
  // node carried a stage id — so the next minted key cannot collide with one
  // the server already has (see absorbKeys).
  absorbKeys(allKeys);

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

  // The nodes were built fresh above and are not shared yet, so filling their
  // edge lists in place is still a pure function from the caller's view.
  for (const { node, deps } of pending) node.dependsOn = translate(deps);
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

// ── Path-addressed tree ops (PRD-01 G-1) ─────────────────────────────────────
// Every structural edit below a phase goes through these two seams, so an op
// works the same at level 2 as at level MAX_DEPTH. The older (pi, ti, si)
// exports further down are thin wrappers over them, kept because their call
// sites and tests read naturally at the levels they name.

/** The child list a parent path addresses: a phase's tasks, or a task's children. */
function childList(phases: PhaseDraft[], parentPath: NodePath): TaskDraft[] | null {
  if (parentPath.length === 0) return null;
  const phase = phases[parentPath[0]];
  if (!phase) return null;
  let list = phase.tasks;
  for (let d = 1; d < parentPath.length; d += 1) {
    const n = list[parentPath[d]];
    if (!n) return null;
    list = kids(n);
  }
  return list;
}

/** The node a path addresses (a phase for a 1-long path), or null. */
export function nodeAtPath(phases: PhaseDraft[], path: NodePath): PhaseDraft | TaskDraft | null {
  if (path.length === 0) return null;
  if (path.length === 1) return phases[path[0]] ?? null;
  return childList(phases, path.slice(0, -1))?.[path[path.length - 1]] ?? null;
}

/** The TASK a path addresses (level 2 or deeper), or null. */
export function taskAtPath(phases: PhaseDraft[], path: NodePath): TaskDraft | null {
  return path.length >= 2 ? (nodeAtPath(phases, path) as TaskDraft | null) : null;
}

/**
 * Rebuild the child list under `parentPath` through `fn`, copy-on-write along
 * the spine only. A path that names nothing returns the same array (identity),
 * so a stale path is a no-op rather than a crash.
 */
function withChildList(
  phases: PhaseDraft[], parentPath: NodePath, fn: (list: TaskDraft[]) => TaskDraft[],
): PhaseDraft[] {
  const pi = parentPath[0];
  const phase = pi == null ? undefined : phases[pi];
  if (!phase) return phases;
  const rec = (list: TaskDraft[], depth: number): TaskDraft[] | null => {
    if (depth === parentPath.length) return fn(list);
    const i = parentPath[depth];
    const node = list[i];
    if (!node) return null;
    const next = rec(kids(node), depth + 1);
    return next === null ? null : replaceAt(list, i, { ...node, children: next });
  };
  const tasks = rec(phase.tasks, 1);
  return tasks === null ? phases : replaceAt(phases, pi, { ...phase, tasks });
}

/** Replace the one task a path names (level ≥ 2) with `fn(task)`. */
function updateTaskAt(phases: PhaseDraft[], path: NodePath, fn: (t: TaskDraft) => TaskDraft): PhaseDraft[] {
  if (path.length < 2 || !taskAtPath(phases, path)) return phases;
  const i = path[path.length - 1];
  return withChildList(phases, path.slice(0, -1), (list) => replaceAt(list, i, fn(list[i])));
}

/** How many levels hang BELOW a node (0 for a leaf). */
export function subtreeHeight(t: TaskDraft): number {
  let h = 0;
  for (const c of kids(t)) h = Math.max(h, 1 + subtreeHeight(c));
  return h;
}

/** Can a child be added under the node at `parentPath` without passing MAX_DEPTH? */
export function canAddChildAt(parentPath: NodePath): boolean {
  return parentPath.length >= 1 && parentPath.length < MAX_DEPTH;
}

/**
 * Append a fresh child under the node at `parentPath` — a task under a phase, a
 * sub-task under a task, at any level. A parent already at MAX_DEPTH gets
 * nothing (identity): the cap is enforced by never offering the fifth-plus-one.
 */
export function addChildAt(phases: PhaseDraft[], parentPath: NodePath): PhaseDraft[] {
  if (!canAddChildAt(parentPath)) return phases;
  if (parentPath.length === 1) {
    const phase = phases[parentPath[0]];
    if (!phase) return phases;
    return replaceAt(phases, parentPath[0], { ...phase, tasks: [...phase.tasks, emptyTask()] });
  }
  return updateTaskAt(phases, parentPath, (t) => ({ ...t, children: [...kids(t), emptySubtask()] }));
}

/** Rename the node at `path` — a phase or a task at any level. */
export function renameAt(phases: PhaseDraft[], path: NodePath, name: string): PhaseDraft[] {
  if (path.length === 1) return phases[path[0]] ? renamePhase(phases, path[0], name) : phases;
  return updateTaskAt(phases, path, (t) => ({ ...t, name }));
}

/** Set one date of the task at `path` ('' clears it). */
export function setDateAt(
  phases: PhaseDraft[], path: NodePath, field: 'start' | 'end', value: string,
): PhaseDraft[] {
  return updateTaskAt(phases, path, (t) => ({ ...t, [field]: value }));
}

/** Set both dates of the task at `path` in one immutable update (a bar drag). */
export function setDatesAt(phases: PhaseDraft[], path: NodePath, start: string, end: string): PhaseDraft[] {
  return updateTaskAt(phases, path, (t) => ({ ...t, start, end }));
}

/** Edit the free-form description of the task at `path`. */
export function setDescriptionAt(phases: PhaseDraft[], path: NodePath, description: string): PhaseDraft[] {
  return updateTaskAt(phases, path, (t) => ({ ...t, description }));
}

/** Remove the node at `path` and its whole subtree; edges that named any of it go too. */
export function removeAt(phases: PhaseDraft[], path: NodePath): PhaseDraft[] {
  if (path.length === 1) return removePhase(phases, path[0]);
  if (!taskAtPath(phases, path)) return phases;
  const i = path[path.length - 1];
  return pruneEdges(withChildList(phases, path.slice(0, -1), (list) => list.filter((_, j) => j !== i)));
}

/** Drag-drop reorder WITHIN one parent (a path of [] reorders the phases). */
export function reorderAt(phases: PhaseDraft[], parentPath: NodePath, from: number, to: number): PhaseDraft[] {
  if (parentPath.length === 0) return reorderPhase(phases, from, to);
  const list = childList(phases, parentPath);
  if (!list || from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return phases;
  return withChildList(phases, parentPath, (l) => reorder(l, from, to));
}

/** Step the node at `path` up/down among its siblings (the keyboard-reachable move). */
export function moveAt(phases: PhaseDraft[], path: NodePath, delta: number): PhaseDraft[] {
  if (path.length === 1) return movePhase(phases, path[0], delta);
  const list = childList(phases, path.slice(0, -1));
  const i = path[path.length - 1];
  if (!list || i + delta < 0 || i + delta >= list.length || i >= list.length) return phases;
  return withChildList(phases, path.slice(0, -1), (l) => move(l, i, delta));
}

// ── WBS level promotion / demotion (LINA-259 ask 7, ADR-0019 depth cap) ──────
// Re-parent a node one level up or down within its phase, NEVER passing
// MAX_DEPTH. Every guard that would overflow the cap (or climb above a phase) is
// a no-op returning the same array — the same shape the UI reads to disable the
// action (`canPromoteAt` / `canDemoteAt`). Reparenting keeps every key alive and
// moves the node's WHOLE subtree, so no dependency edge is orphaned.

/** A node at level 3+ may outdent; a level-2 task has only a phase above it. */
export function canPromoteAt(phases: PhaseDraft[], path: NodePath): boolean {
  return path.length >= 3 && taskAtPath(phases, path) != null;
}

/**
 * A task may indent under its preceding sibling when it has one and its whole
 * subtree still fits under MAX_DEPTH one level down.
 */
export function canDemoteAt(phases: PhaseDraft[], path: NodePath): boolean {
  if (path.length < 2) return false;
  const node = taskAtPath(phases, path);
  if (!node || path[path.length - 1] === 0) return false;
  return path.length + 1 + subtreeHeight(node) <= MAX_DEPTH;
}

/**
 * PROMOTE (outdent) — lift the node at `path` one level: it leaves its parent
 * and is inserted directly AFTER that parent among the parent's siblings (so it
 * reads where it left off), carrying its subtree with it.
 */
export function promoteAt(phases: PhaseDraft[], path: NodePath): PhaseDraft[] {
  if (!canPromoteAt(phases, path)) return phases;
  const i = path[path.length - 1];
  const pIdx = path[path.length - 2];
  return withChildList(phases, path.slice(0, -2), (list) => {
    const parent = list[pIdx];
    const node = kids(parent)[i];
    const out = list.slice();
    out[pIdx] = { ...parent, children: kids(parent).filter((_, j) => j !== i) };
    out.splice(pIdx + 1, 0, node);
    return out;
  });
}

/**
 * DEMOTE (indent) — push the node at `path` one level down, appended as the last
 * child of its immediately PRECEDING sibling, subtree and all. Refused (identity)
 * for a first sibling, or when the subtree would pass MAX_DEPTH.
 */
export function demoteAt(phases: PhaseDraft[], path: NodePath): PhaseDraft[] {
  if (!canDemoteAt(phases, path)) return phases;
  const i = path[path.length - 1];
  return withChildList(phases, path.slice(0, -1), (list) => {
    const prev = list[i - 1];
    const out = list.filter((_, j) => j !== i);
    out[i - 1] = { ...prev, children: [...kids(prev), list[i]] };
    return out;
  });
}

// ── The level-named wrappers (kept for their call sites and tests) ───────────

/** Drag-drop a task within its phase from one position to another. */
export function reorderTask(phases: PhaseDraft[], pi: number, from: number, to: number): PhaseDraft[] {
  return reorderAt(phases, [pi], from, to);
}

/**
 * Drop every predecessor edge pointing at a stage that is no longer in the
 * draft. Removing a stage others depended on must take its edges with it —
 * otherwise a chip would render for a row that is gone, and the save would ship
 * a key the server has never heard of (`400 unknown_dependency`).
 */
function pruneEdges(phases: PhaseDraft[]): PhaseDraft[] {
  const live = new Set<string>();
  const collect = (t: TaskDraft) => { live.add(t.key); kids(t).forEach(collect); };
  for (const p of phases) { live.add(p.key); p.tasks.forEach(collect); }
  const keep = (deps: DepEdge[]) => deps.filter((d) => live.has(d.on));
  const prune = (t: TaskDraft): TaskDraft => ({
    ...t, dependsOn: keep(t.dependsOn), children: kids(t).map(prune),
  });
  return phases.map((p) => ({ ...p, dependsOn: keep(p.dependsOn), tasks: p.tasks.map(prune) }));
}

export function removePhase(phases: PhaseDraft[], pi: number): PhaseDraft[] {
  return pruneEdges(phases.filter((_, i) => i !== pi));
}

export function addPhase(phases: PhaseDraft[]): PhaseDraft[] {
  return [...phases, emptyPhase()];
}

export function addTask(phases: PhaseDraft[], pi: number): PhaseDraft[] {
  return addChildAt(phases, [pi]);
}

export function renameTask(phases: PhaseDraft[], pi: number, ti: number, name: string): PhaseDraft[] {
  return renameAt(phases, [pi, ti], name);
}

export function setTaskDate(
  phases: PhaseDraft[], pi: number, ti: number, field: 'start' | 'end', value: string,
): PhaseDraft[] {
  return setDateAt(phases, [pi, ti], field, value);
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
  return setDatesAt(phases, [pi, ti], start, end);
}

/** Edit a task's free-form description (the task-detail drawer field, LINA-234). */
export function setTaskDescription(
  phases: PhaseDraft[], pi: number, ti: number, description: string,
): PhaseDraft[] {
  return setDescriptionAt(phases, [pi, ti], description);
}

export function moveTask(phases: PhaseDraft[], pi: number, ti: number, delta: number): PhaseDraft[] {
  return moveAt(phases, [pi, ti], delta);
}

export function removeTask(phases: PhaseDraft[], pi: number, ti: number): PhaseDraft[] {
  // A task takes its sub-tasks down with it — pruneEdges then drops every edge
  // that named any of them.
  return removeAt(phases, [pi, ti]);
}

// ── The third level, by name (LINA-243) — wrappers over the path ops ────────

export function addSubtask(phases: PhaseDraft[], pi: number, ti: number): PhaseDraft[] {
  return addChildAt(phases, [pi, ti]);
}

export function renameSubtask(
  phases: PhaseDraft[], pi: number, ti: number, si: number, name: string,
): PhaseDraft[] {
  return renameAt(phases, [pi, ti, si], name);
}

export function setSubtaskDate(
  phases: PhaseDraft[], pi: number, ti: number, si: number, field: 'start' | 'end', value: string,
): PhaseDraft[] {
  return setDateAt(phases, [pi, ti, si], field, value);
}

/**
 * Set both of a sub-task's dates in one immutable update — the third-level
 * sibling of setTaskDates, for the Gantt "move" drag on a sub-task bar
 * (LINA-244). One op, so start and finish never land across two renders.
 */
export function setSubtaskDates(
  phases: PhaseDraft[], pi: number, ti: number, si: number, start: string, end: string,
): PhaseDraft[] {
  return setDatesAt(phases, [pi, ti, si], start, end);
}

export function setSubtaskDescription(
  phases: PhaseDraft[], pi: number, ti: number, si: number, description: string,
): PhaseDraft[] {
  return setDescriptionAt(phases, [pi, ti, si], description);
}

export function removeSubtask(phases: PhaseDraft[], pi: number, ti: number, si: number): PhaseDraft[] {
  return removeAt(phases, [pi, ti, si]);
}

/** Step a sub-task up/down within its task (the keyboard-reachable move). */
export function moveSubtask(
  phases: PhaseDraft[], pi: number, ti: number, si: number, delta: number,
): PhaseDraft[] {
  return moveAt(phases, [pi, ti, si], delta);
}

/** Drag-drop a sub-task within its OWN task — it never crosses into another. */
export function reorderSubtask(
  phases: PhaseDraft[], pi: number, ti: number, from: number, to: number,
): PhaseDraft[] {
  return reorderAt(phases, [pi, ti], from, to);
}

/** Promote by level-named indices; `si` omitted addresses the L2 task. */
export function promoteNode(
  phases: PhaseDraft[], pi: number, ti: number, si?: number,
): PhaseDraft[] {
  return promoteAt(phases, si == null ? [pi, ti] : [pi, ti, si]);
}

/** Demote by level-named indices; `si` omitted addresses the L2 task. */
export function demoteNode(
  phases: PhaseDraft[], pi: number, ti: number, si?: number,
): PhaseDraft[] {
  return demoteAt(phases, si == null ? [pi, ti] : [pi, ti, si]);
}

/**
 * Where a stage key sits in the draft, as a path — null when it names nothing.
 * The permalink and the panel resolve their open row through this.
 */
export function pathOfKey(phases: PhaseDraft[], key: string): number[] | null {
  const walk = (list: TaskDraft[], prefix: number[]): number[] | null => {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].key === key) return [...prefix, i];
      const hit = walk(kids(list[i]), [...prefix, i]);
      if (hit) return hit;
    }
    return null;
  };
  for (let pi = 0; pi < phases.length; pi += 1) {
    if (phases[pi].key === key) return [pi];
    const hit = walk(phases[pi].tasks, [pi]);
    if (hit) return hit;
  }
  return null;
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
  /** 1 phase · 2 task · 3..MAX_DEPTH sub-tasks — the picker indents by it. */
  level: number;
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
    // Depth-first, so the outline reads 2.5, 2.5.2, 2.5.2.2, 2.5.2.2.1 — any level.
    const visit = (task: TaskDraft, prefix: string, i: number, level: number) => {
      const o = `${prefix}.${i + 1}`;
      const n = stripOutline(task.name) || (level === 2 ? 'Untitled task' : 'Untitled sub-task');
      out.push({
        key: task.key, outline: o, name: n, label: `${o} ${n}`,
        isPhase: false, level, phaseKey: phase.key,
      });
      kids(task).forEach((c, ci) => visit(c, o, ci, level + 1));
    };
    phase.tasks.forEach((task, ti) => visit(task, outline, ti, 2));
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
  const visit = (t: TaskDraft) => { m.set(t.key, t.dependsOn); kids(t).forEach(visit); };
  for (const p of phases) {
    m.set(p.key, p.dependsOn);
    p.tasks.forEach(visit);
  }
  return m;
}

/** Does `key` name this task or anything under it? */
function subtreeHas(t: TaskDraft, key: string): boolean {
  return t.key === key || kids(t).some((c) => subtreeHas(c, key));
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
  // Rows that are not on the target's spine keep their identity — only the one
  // stage whose list is being replaced (at any level) and its ancestors rebuild.
  const patch = (t: TaskDraft): TaskDraft => {
    if (t.key === key) return { ...t, dependsOn: next };
    if (!subtreeHas(t, key)) return t;
    return { ...t, children: kids(t).map(patch) };
  };
  return phases.map((p) => ({
    ...p,
    dependsOn: p.key === key ? next : p.dependsOn,
    tasks: p.tasks.map(patch),
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

// ── The CRITICAL PATH (LINA-404, founder's ask) ──────────────────────────────
// "The filter which puts opacity in all tasks and highlights the ones in the
// critical path of the project." The SERVER decides it — planning's one rule
// (domain/critical-path.mjs: a leaf whose one-working-day slip moves the
// project finish, and every summary containing one), the same rule behind the
// tender window's critical alert — and hands it over as `Task.is_critical`,
// carried onto the draft by the read seam (planning-hydrate.ts). This only
// collects the keys the server marked; it reflects the SAVED plan (a draft edit
// lights its new path once the autosave lands and the plan is read again).
export function criticalPathKeys(phases: PhaseDraft[]): Set<string> {
  const out = new Set<string>();
  const walk = (t: TaskDraft): void => {
    if (t.isCritical) out.add(t.key);
    t.children.forEach(walk);
  };
  for (const ph of phases) {
    if (ph.isCritical) out.add(ph.key);
    ph.tasks.forEach(walk);
  }
  return out;
}

// ── Dependency-date ENFORCEMENT (LINA-306) ───────────────────────────────────
// The founder's ask: "whenever I add a dependency of the task starts when
// another one ends, the dates of that task need to be enforced following that
// logic." A link is no longer only a drawn arrow — it MOVES the dependent's dates
// so its schedule actually obeys the rule, and keeps obeying it when the
// predecessor is dragged. So this runs after every date edit and every link edit,
// not once at creation, and cascades down a chain in one pass.
//
// The three types map to one constraint each, on the dependent, preserving its
// duration (a link reschedules a task, it does not restretch it):
//   • starts_after — dep.start := pred.end + 1 day  (starts the day the pred
//     finishes releases — the connector's clean touch, no shared day)
//   • starts_with  — dep.start := pred.start
//   • ends_with    — dep.end   := pred.end
// A dependent with several predecessors takes the LATEST (max) of its start
// constraints so every "after" is satisfied at once. A predecessor with no dates
// constrains nothing (there is no boundary to snap to); a dependent with no dates
// is left undated (there is no bar to move — the author schedules it first, and
// the next edit enforces it). Phases derive their span from their children, so a
// task may key off a whole phase's envelope.

/** A stage's [start, end] in ms from a live date map, or from a phase envelope. */
function spanMs(
  key: string,
  dates: Map<string, { start: string; end: string }>,
  phaseKeys: Set<string>,
  phaseChildren: Map<string, string[]>,
): { start: number; end: number } | null {
  if (phaseKeys.has(key)) {
    let lo: number | null = null;
    let hi: number | null = null;
    for (const child of phaseChildren.get(key) ?? []) {
      const s = spanMs(child, dates, phaseKeys, phaseChildren);
      if (!s) continue;
      lo = lo === null || s.start < lo ? s.start : lo;
      hi = hi === null || s.end > hi ? s.end : hi;
    }
    return lo === null || hi === null ? null : { start: lo, end: hi };
  }
  const d = dates.get(key);
  if (!d) return null;
  const s = parseDay(d.start);
  const e = parseDay(d.end);
  return s === null || e === null ? null : { start: s, end: e };
}

/** The live date + phase-envelope maps enforcement reads and writes. */
function dateMaps(phases: PhaseDraft[]): {
  phaseKeys: Set<string>;
  phaseChildren: Map<string, string[]>;
  /** A task key → its DIRECT child keys, present only for tasks that HAVE
   *  children, at any level. Enforcement reads this to move a PARENT dependent
   *  as a group (LINA-404); `descendantKeys` walks it to the leaves. */
  taskChildren: Map<string, string[]>;
  dates: Map<string, { start: string; end: string }>;
} {
  const phaseKeys = new Set(phases.map((p) => p.key));
  const phaseChildren = new Map<string, string[]>();
  const taskChildren = new Map<string, string[]>();
  const dates = new Map<string, { start: string; end: string }>();
  const visit = (t: TaskDraft) => {
    dates.set(t.key, { start: t.start, end: t.end });
    const childKeys = kids(t).map((c) => c.key);
    if (childKeys.length) taskChildren.set(t.key, childKeys);
    kids(t).forEach(visit);
  };
  for (const p of phases) {
    phaseChildren.set(p.key, p.tasks.map((t) => t.key));
    p.tasks.forEach(visit);
  }
  return { phaseKeys, phaseChildren, taskChildren, dates };
}

/** Every key below `key` in the task hierarchy, any depth. */
function descendantKeys(key: string, taskChildren: Map<string, string[]>): string[] {
  const out: string[] = [];
  const walk = (k: string) => { for (const c of taskChildren.get(k) ?? []) { out.push(c); walk(c); } };
  walk(key);
  return out;
}

/** Slide one date-map entry by `deltaMs`, preserving a blank edge (an undated edge
 *  has no boundary to move). Used to move a PARENT's subtree rigidly (LINA-404). */
function slideEntry(
  dates: Map<string, { start: string; end: string }>, key: string, deltaMs: number,
): void {
  const d = dates.get(key);
  if (!d) return;
  const s = parseDay(d.start);
  const e = parseDay(d.end);
  dates.set(key, {
    start: s === null ? d.start : formatDay(s + deltaMs),
    end: e === null ? d.end : formatDay(e + deltaMs),
  });
}

/**
 * The START delta a link's `snap` implies for a PARENT dependent, in ms — non-zero
 * ONLY when the link moved the dependent's START (`starts_after` / `starts_with`).
 * A start-constrained parent slides its whole subtree by this delta so the children
 * follow. An `ends_with` link moves the END alone (pinning the start, LINA-306), so
 * it returns 0 — the caller then sets the parent's own row (resize), exactly as a
 * leaf, and the roll-up reconciles the span with the children on the next pass.
 */
function parentStartShiftMs(
  cur: { start: string; end: string }, snap: { start: string; end: string },
): number {
  const cs = parseDay(cur.start);
  const ss = parseDay(snap.start);
  return cs !== null && ss !== null && ss !== cs ? ss - cs : 0;
}

/**
 * New dates for ONE dependent so it obeys its links, or null when nothing moves
 * (undated, no dated predecessor, or already snapped). Predecessor spans are read
 * from the live `dates` map — a phase key resolves to its children's envelope.
 * Several predecessors take the LATEST (max) constraint so every "after" is
 * satisfied at once.
 *
 * How a link moves the bar (LINA-306, founder's ask):
 *  - `starts_after` / `starts_with` move the START and keep the duration — the
 *    task slides forward as a whole to begin after / with its predecessor.
 *  - `ends_with` moves ONLY the END to meet the predecessor's finish and pins the
 *    START where the author put it. Drawing "1.1 ends with 1.1.1" re-snaps 1.1's
 *    end alone; its start does not jump earlier, so the timeline's left edge — and
 *    every other bar's position — stays put. (If the target finishes on/before our
 *    start the end can't just retreat past the start, so we fall back to shifting
 *    the whole bar, duration kept, to keep the bar valid.)
 */
function snapToLinks(
  key: string,
  deps: DepEdge[],
  dates: Map<string, { start: string; end: string }>,
  phaseKeys: Set<string>,
  phaseChildren: Map<string, string[]>,
): { start: string; end: string } | null {
  const self = dates.get(key);
  if (!self) return null;
  const s = parseDay(self.start);
  const e = parseDay(self.end);
  if (s === null || e === null) return null;     // undated — nothing to shift yet
  const dur = e - s;

  let startTarget: number | null = null;
  let endTarget: number | null = null;
  for (const d of deps) {
    const span = spanMs(d.on, dates, phaseKeys, phaseChildren);
    if (!span) continue;
    if (d.type === 'starts_after') {
      const t = parseDay(addDays(formatDay(span.end), 1)) as number;
      startTarget = startTarget === null ? t : Math.max(startTarget, t);
    } else if (d.type === 'starts_with') {
      startTarget = startTarget === null ? span.start : Math.max(startTarget, span.start);
    } else if (d.type === 'ends_with') {
      endTarget = endTarget === null ? span.end : Math.max(endTarget, span.end);
    }
  }

  let ns = s;
  let ne = e;
  if (startTarget !== null) { ns = startTarget; ne = ns + dur; }
  else if (endTarget !== null) {
    // Pin the start, move the end to the target finish (a finish-to-finish link
    // resizes rather than slides). Only if the target ends on/before our start —
    // where a pinned start would invert the bar — do we shift the whole bar back.
    if (endTarget > s) { ne = endTarget; }
    else { ne = endTarget; ns = ne - dur; }
  }
  if (ns === s && ne === e) return null;
  return { start: formatDay(ns), end: formatDay(ne) };
}

/** Rebuild the tree from a mutated `dates` map — every task/sub-task by key. */
function withDates(
  phases: PhaseDraft[], dates: Map<string, { start: string; end: string }>,
): PhaseDraft[] {
  const rebuild = (t: TaskDraft): TaskDraft => {
    const td = dates.get(t.key)!;
    return { ...t, start: td.start, end: td.end, children: kids(t).map(rebuild) };
  };
  return phases.map((p) => ({ ...p, tasks: p.tasks.map(rebuild) }));
}

/**
 * Snap every dependent's dates to obey its links, duration-preserving, in a
 * single topological pass so a chain (A → B → C) settles at once. A cyclic draft
 * is returned untouched — you cannot order a cycle, and the draft is free to hold
 * one transiently (the save is what refuses it), so enforcement simply waits for
 * the author to break it rather than looping.
 */
export function enforceDependencies(phases: PhaseDraft[]): PhaseDraft[] {
  if (detectCycle(phases)) return phases;

  const link = edges(phases);
  const nodes = planNodes(phases);
  const { phaseKeys, phaseChildren, taskChildren, dates } = dateMaps(phases);

  // Kahn's algorithm on the predecessor → dependent graph, so a node is only
  // processed once all its predecessors already carry their enforced dates.
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) { indeg.set(n.key, 0); adj.set(n.key, []); }
  for (const n of nodes) {
    for (const dep of link.get(n.key) ?? []) {
      if (!indeg.has(dep.on)) continue; // an edge to a stage that no longer exists
      adj.get(dep.on)!.push(n.key);
      indeg.set(n.key, (indeg.get(n.key) ?? 0) + 1);
    }
  }
  const queue = nodes.filter((n) => (indeg.get(n.key) ?? 0) === 0).map((n) => n.key);
  const order: string[] = [];
  while (queue.length > 0) {
    const k = queue.shift()!;
    order.push(k);
    for (const child of adj.get(k) ?? []) {
      const d = (indeg.get(child) ?? 0) - 1;
      indeg.set(child, d);
      if (d === 0) queue.push(child);
    }
  }

  let changed = false;
  for (const key of order) {
    if (phaseKeys.has(key)) continue;            // a phase has no authored dates to move
    const deps = link.get(key) ?? [];
    if (deps.length === 0) continue;
    const snap = snapToLinks(key, deps, dates, phaseKeys, phaseChildren);
    if (!snap) continue;
    const subs = taskChildren.get(key);
    const deltaMs = subs && subs.length ? parentStartShiftMs(dates.get(key)!, snap) : 0;
    if (deltaMs !== 0) {
      // A start-constrained PARENT moves as a GROUP (LINA-404): slide its whole
      // subtree so the children follow and the derived envelope tracks them.
      slideEntry(dates, key, deltaMs);
      for (const c of descendantKeys(key, taskChildren)) slideEntry(dates, c, deltaMs);
    } else {
      // A leaf, or an `ends_with` parent (end-only, start pinned) → set the row;
      // the roll-up reconciles a parent's span with its children next pass.
      dates.set(key, snap);
    }
    changed = true;
  }
  if (!changed) return phases;

  return withDates(phases, dates);
}

/**
 * Enforce ONLY the link just applied: move `dependent` to obey its own links and
 * touch NOTHING else (LINA-306, founder's ask). Unlike enforceDependencies this
 * does not re-flow the dependent's downstream chain — applying a link changes the
 * dates of the two tasks it joins, not every task that transitively follows them.
 * A cyclic draft, an undated pair, or a dependent that is already snapped all
 * return the tree untouched.
 */
export function enforceLink(phases: PhaseDraft[], dependent: string): PhaseDraft[] {
  if (detectCycle(phases)) return phases;
  const deps = edges(phases).get(dependent) ?? [];
  if (deps.length === 0) return phases;
  const { phaseKeys, phaseChildren, taskChildren, dates } = dateMaps(phases);
  const snap = snapToLinks(dependent, deps, dates, phaseKeys, phaseChildren);
  if (!snap) return phases;
  const subs = taskChildren.get(dependent);
  const deltaMs = subs && subs.length ? parentStartShiftMs(dates.get(dependent)!, snap) : 0;
  if (deltaMs !== 0) {
    // A start-constrained link to a PARENT slides its whole subtree (LINA-404, the
    // founder's ask that linking 1.1→1.2 pushes 1.2 forward "regardless of the tasks
    // inside"): the children move with it and the derived envelope follows.
    slideEntry(dates, dependent, deltaMs);
    for (const c of descendantKeys(dependent, taskChildren)) slideEntry(dates, c, deltaMs);
  } else {
    // A leaf, or an `ends_with` parent (end only, start pinned, LINA-306).
    dates.set(dependent, snap);
  }
  return withDates(phases, dates);
}

// ── Parent end-date ROLL-UP (LINA-404, founder's ask) ────────────────────────
// The founder's rule, verbatim: "whenever there is hierarchy the parent should
// follow a simple rule — have an end date not before any of its descendants. So
// if a user sets a date in the future and I add a task that does not break that
// end date — do nothing. But if it changes, or if the parent doesn't have a date
// yet, it sets as final date the end date of the current task."
//
// So the invariant is: a parent's END is never earlier than any descendant's end.
//   • A descendant that fits inside the parent's existing window changes nothing.
//   • A descendant that ends LATER than the parent (or a parent with no end yet)
//     pushes the parent's end out to cover it.
// It only ever extends an end; it never pulls one in, and it never touches a
// start — a parent keeps the start the author gave it (or none), exactly as the
// `ends_with` link resizes rather than slides. A parent carrying no descendant
// end is left alone (nothing to cover).
//
// Every task level stores a date and may hold children, so every container task
// rolls up to cover its children, bottom-up (PRD-01 G-1). A phase carries
// no stored end — its bar is already the children's envelope (see spanMs) — so it
// is correct by construction and nothing here writes to it.

/**
 * A task's children's envelope — [earliest start, latest end] in ms — or null
 * when no child carries a date to derive from. Start and end are taken
 * independently, so a child dated on only one edge still contributes that edge
 * (mirrors `phaseEnvelope` in the grid). The children passed in have ALREADY
 * been rolled up, so a container child contributes its derived span.
 */
function childSpan(children: TaskDraft[]): { lo: number; hi: number } | null {
  let lo: number | null = null;
  let hi: number | null = null;
  for (const c of children) {
    const s = parseDay(c.start);
    const e = parseDay(c.end);
    if (s !== null) lo = lo === null || s < lo ? s : lo;
    if (e !== null) hi = hi === null || e > hi ? e : hi;
  }
  return lo === null || hi === null ? null : { lo, hi };
}

/**
 * Derive every container task's dates FROM its children, so a task with sub-tasks
 * behaves like a phase (LINA-404, the founder's ask: "its bar auto-covers its
 * children and its dates derive from them"). The parent's start becomes the
 * earliest child start and its end the latest child end — it both grows to cover
 * a child that runs past it AND pulls back in when the children shrink. It runs
 * BOTTOM-UP at every level (PRD-01 G-1): a level-4 container is derived first,
 * then the level-3 one above it reads that derived span. A task with no dated
 * child is left alone; a leaf task is never touched. Phases hold no stored dates —
 * their bar is already the children's envelope. Pure and idempotent: a draft that
 * already equals its envelope comes back the same ref, so this sits on the
 * universal edit funnel without fabricating a save of its own.
 */
export function enforceParentRollup(phases: PhaseDraft[]): PhaseDraft[] {
  const roll = (t: TaskDraft): TaskDraft => {
    const before = kids(t);
    if (before.length === 0) return t;                 // a leaf is never touched
    const children = before.map(roll);
    const childChanged = children.some((c, i) => c !== before[i]);
    const base = childChanged ? { ...t, children } : t;
    const span = childSpan(children);
    if (span === null) return base;                    // no dated child to derive from
    const start = formatDay(span.lo);
    const end = formatDay(span.hi);
    if (base.start === start && base.end === end) return base; // already the envelope
    return { ...base, start, end };                    // derive both edges from the children
  };
  let changed = false;
  const next = phases.map((p) => {
    const tasks = p.tasks.map(roll);
    if (tasks.every((t, i) => t === p.tasks[i])) return p;
    changed = true;
    return { ...p, tasks };
  });
  return changed ? next : phases;
}

/**
 * Slide a stage and every descendant under it by `deltaDays` whole days (LINA-404,
 * founder's ask: "if I try to move the parent task, the tasks inside move with it").
 * A GROUP — a phase or a task that holds sub-tasks — moves RIGIDLY: every dated leaf
 * under it slides by the SAME delta, so the children keep their relative layout and
 * the parent's derived envelope follows. A leaf shifts only itself. Only dated edges
 * move — a blank start/finish stays blank. `deltaDays === 0`, or a key that names
 * nothing, returns the same ref, so this never fabricates an edit. Pure and
 * copy-on-write: only the touched spine is rebuilt.
 */
export function shiftGroup(phases: PhaseDraft[], key: string, deltaDays: number): PhaseDraft[] {
  if (deltaDays === 0) return phases;
  const slide = (iso: string): string => (iso ? addDays(iso, deltaDays) : iso);
  // A task and everything under it, any depth, by the same delta.
  const slideTask = (t: TaskDraft): TaskDraft => ({
    ...t, start: slide(t.start), end: slide(t.end), children: kids(t).map(slideTask),
  });
  // Find `key` and slide its subtree; untouched branches keep their identity.
  const visit = (t: TaskDraft): TaskDraft => {
    if (t.key === key) return slideTask(t);
    if (!subtreeHas(t, key)) return t;
    return { ...t, children: kids(t).map(visit) };
  };
  let changed = false;
  const next = phases.map((p) => {
    if (p.key === key) {
      // A whole PHASE moves: every task (and its sub-tasks) slides by delta.
      changed = true;
      return { ...p, tasks: p.tasks.map(slideTask) };
    }
    if (!p.tasks.some((t) => subtreeHas(t, key))) return p;
    changed = true;
    return { ...p, tasks: p.tasks.map(visit) };
  });
  return changed ? next : phases;
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
  patch: { assigneePartyId?: string | null; trade?: string; tradeCode?: string },
): PhaseDraft[] {
  const visit = (t: TaskDraft): TaskDraft => {
    if (t.key === key) return { ...t, ...patch };
    if (!subtreeHas(t, key)) return t;
    return { ...t, children: kids(t).map(visit) };
  };
  return phases.map((p) => {
    if (p.key === key) return { ...p, ...patch };
    if (!p.tasks.some((t) => subtreeHas(t, key))) return p;
    return { ...p, tasks: p.tasks.map(visit) };
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

/**
 * Set a stage's specialty label ('' clears it). `tradeCode` is the directory
 * taxonomy code when the label was picked from the taxonomy (PRD-03 R-2); a
 * free-text label clears any code, so the two never disagree.
 */
export function setTrade(phases: PhaseDraft[], key: string, trade: string, tradeCode = ''): PhaseDraft[] {
  return patchStage(phases, key, { trade, tradeCode: trade ? tradeCode : '' });
}

/** One stage's owner + specialty, by key — for the row controls. */
export function stageMeta(
  phases: PhaseDraft[], key: string,
): { assigneePartyId: string | null; trade: string } {
  const path = pathOfKey(phases, key);
  const n = path ? nodeAtPath(phases, path) : null;
  return n ? { assigneePartyId: n.assigneePartyId ?? null, trade: n.trade ?? '' } : { assigneePartyId: null, trade: '' };
}

/** Total task count across all phases — for the "N tasks across M phases" summary. */
export function taskCount(phases: PhaseDraft[]): number {
  return phases.reduce((acc, p) => acc + p.tasks.length, 0);
}

/** Every node BELOW a task, at any depth. */
export function descendantCount(t: TaskDraft): number {
  return kids(t).reduce((n, c) => n + 1 + descendantCount(c), 0);
}

/** Sub-tasks (level 3 and deeper) across the whole draft — the summary's "· N sub-tasks" tail. */
export function subtaskCount(phases: PhaseDraft[]): number {
  return phases.reduce(
    (acc, p) => acc + p.tasks.reduce((n, t) => n + descendantCount(t), 0),
    0,
  );
}

/**
 * The Breakdown line for one node (PRD-01 P-3): how many sub-tasks sit under it
 * and across how many levels — "10 sub-tasks across 4 levels".
 */
export function breakdownOf(node: PhaseDraft | TaskDraft): { count: number; levels: number } {
  const list = 'tasks' in node ? node.tasks : kids(node);
  const count = list.reduce((n, c) => n + 1 + descendantCount(c), 0);
  const levels = list.reduce((h, c) => Math.max(h, 1 + subtreeHeight(c)), 0);
  return { count, levels };
}

// ── Derived child-status counts (LINA-259 ask 5) ─────────────────────────────
// A parent row (a phase, or a task that has sub-tasks) carries a segmented meter
// of its children by status. Status is DERIVED, never authored (ADR-0019), so on
// a fresh draft every child reads 'not_started' and the meter is honestly all
// grey — nothing here fabricates progress. When a LIVE plan is hydrated the
// optional `status` feeds the same counts. 'blocked' is its OWN bucket
// (LINA-306): the pen's STATUS column paints a blocked child red, distinct from
// the blue of work that is merely under way, so the meter now spends a fourth
// segment on it rather than folding it into inProgress.

export interface StatusCounts {
  done: number;
  inProgress: number;
  blocked: number;
  notStarted: number;
  total: number;
}

/**
 * A stage's derived status, defaulting to 'not_started' when unreported. Exported
 * (LINA-306) so the grid can paint a LEAF row's own status pill from the same
 * rule the parent meter counts by — one source of truth for "what colour is this
 * stage".
 */
export function nodeStatus(node: TaskDraft): StageStatus {
  return node.status ?? 'not_started';
}

/**
 * Count a parent's DIRECT children by status. A phase's children are its tasks;
 * a task's children are its sub-tasks. A leaf task (no children) returns all
 * zeros — the caller draws no meter for it. Pure over the draft.
 */
export function childStatusCounts(node: PhaseDraft | TaskDraft): StatusCounts {
  const children: TaskDraft[] = 'tasks' in node ? node.tasks : kids(node);
  const counts: StatusCounts = { done: 0, inProgress: 0, blocked: 0, notStarted: 0, total: children.length };
  for (const c of children) {
    const s = nodeStatus(c);
    if (s === 'done') counts.done += 1;
    else if (s === 'blocked') counts.blocked += 1;
    else if (s === 'in_progress') counts.inProgress += 1;
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
  /** Directory taxonomy code (PRD-03 R-2) — present only when one is picked. */
  tradeCode?: string | null;
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
 * At most MAX_DEPTH levels (ADR-0019, PRD-01 G-1). A task emits `children` when
 * it has children worth sending and omits the field otherwise, so a two-level
 * plan puts exactly the bytes on the wire it always did. Children serialise
 * recursively; a node AT MAX_DEPTH carrying children of its own is a bug in the
 * draft, not an author mistake — it is refused here with `too_deep` rather than
 * sent.
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
  // A row the author never touched is dropped — UNLESS something under it is
  // kept, which would otherwise be silently thrown away with its parent.
  const keeps = (t: TaskDraft): boolean => touched(t) || kids(t).some(keeps);
  const markSent = (t: TaskDraft) => { sent.add(t.key); kids(t).filter(keeps).forEach(markSent); };
  for (const phase of phases) {
    const tasks = phase.tasks.filter(keeps);
    if (!phase.name.trim() && tasks.length === 0) continue;
    sent.add(phase.key);
    tasks.forEach(markSent);
  }
  const wireDeps = (deps: DepEdge[]) =>
    deps.filter((d) => sent.has(d.on)).map((d) => ({ key: d.on, type: d.type }));

  const node = (t: TaskDraft, level: number, parentName: string): AuthoredNode => {
    const n = t.name.trim();
    if (!n) {
      throw new PlanAuthorError(
        'invalid_name',
        level === 2 ? `A task under "${parentName}" needs a name.` : `A sub-task under "${parentName}" needs a name.`,
      );
    }
    if (level >= MAX_DEPTH && kids(t).length > 0) {
      throw new PlanAuthorError(
        'too_deep',
        `A plan is ${MAX_DEPTH} levels deep at most here — a level-${MAX_DEPTH} task cannot have its own sub-tasks.`,
      );
    }
    const children = kids(t).filter(keeps).map((c) => node(c, level + 1, n));
    return {
      name: n, key: t.key, dependsOn: wireDeps(t.dependsOn),
      description: (t.description ?? '').trim() || null,
      assigneePartyId: t.assigneePartyId ?? null, trade: textOrNull(t.trade),
      ...(textOrNull(t.tradeCode) ? { tradeCode: textOrNull(t.tradeCode) } : {}),
      plannedStartDate: dateOrNull(t.start), plannedEndDate: dateOrNull(t.end),
      // Omitted, not `[]`, when there is no level below: a two-level plan puts
      // exactly the bytes on the wire it did before deeper levels existed.
      ...(children.length > 0 ? { children } : {}),
    };
  };

  const stages: AuthoredNode[] = [];
  for (const phase of phases) {
    const name = phase.name.trim();
    const tasks = phase.tasks.filter(keeps);
    // A phase the author emptied out entirely is skipped silently.
    if (!name && tasks.length === 0) continue;
    if (!name) {
      throw new PlanAuthorError('invalid_name', 'Give every phase a name (or remove it).');
    }
    // Children first: a nameless task's refusal outranks anything about the phase.
    const children = tasks.map((t) => node(t, 2, name));
    stages.push({
      name, key: phase.key, dependsOn: wireDeps(phase.dependsOn),
      assigneePartyId: phase.assigneePartyId ?? null, trade: textOrNull(phase.trade),
      ...(textOrNull(phase.tradeCode) ? { tradeCode: textOrNull(phase.tradeCode) } : {}),
      children,
    });
  }
  if (stages.length === 0) {
    throw new PlanAuthorError('empty_plan', 'Add at least one phase before saving the plan.');
  }
  return stages;
}

/**
 * Map the working draft to the names-only template body (LINA-242, ADR-0018).
 *
 * THE POINT OF THIS FUNCTION IS WHAT IT DROPS. A template is the SHAPE of a
 * build — phases and the tasks under them — and nothing about one particular
 * build. So dates and descriptions are dropped rather than carried: they are the
 * author's answers for this project, and the edge would refuse them anyway (a
 * phase may hold only `{ name, tasks }`). A task collapses to its bare name,
 * which is what makes the second level the last one — there is no key left to
 * hang a third on.
 *
 * Otherwise it mirrors `toWire`'s tolerance so the two never disagree about what
 * "empty" means: a phase the author emptied out entirely is skipped, a task with
 * no name is skipped (unlike toWire it cannot be "dated but unnamed" — dates do
 * not survive the mapping), a nameless phase that still holds tasks is a typed
 * refusal, and an empty result refuses rather than saving a blank default.
 */
export function toTemplateBody(phases: PhaseDraft[]): TemplatePhase[] {
  const out: TemplatePhase[] = [];
  for (const phase of phases) {
    const name = phase.name.trim();
    const tasks = phase.tasks.map((t) => t.name.trim()).filter((n) => n !== '');
    if (!name && tasks.length === 0) continue;
    if (!name) {
      throw new PlanAuthorError('invalid_name', 'Give every phase a name before saving it as your default.');
    }
    out.push({ name, tasks });
  }
  if (out.length === 0) {
    throw new PlanAuthorError('empty_plan', 'Add at least one phase before saving it as your default.');
  }
  return out;
}

/**
 * PUT /api/v2/me/plan-template — "save as my default" (LINA-383 cutover of
 * LINA-242, ADR-0018). This runs from the client editor, so it goes over HTTP to
 * the v2 catch-all route (the shared v2 client is server-only); the route
 * re-verifies the Clerk session, so the transport grants nothing extra.
 *
 * Only `{ name?, body }` crosses the wire: the owner is stamped from the resolved
 * identity mirror (viewer.personId), so there is no owner to send and a forged one
 * would be inert. A second save REPLACES the first — one default per person,
 * guaranteed by a partial unique index, so this is an upsert and never accumulates.
 *
 * This write is entirely OUTSIDE the project record: it touches no stage, no
 * version and no ledger event (templates COPY, never link). It is not a proposal
 * and nothing is sent to the other party.
 */
export async function saveMyDefaultTemplate(body: TemplatePhase[]): Promise<ResolvedPlanTemplate> {
  const res = await fetch('/api/v2/me/plan-template', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  let payload: unknown = null;
  try { payload = await res.json(); } catch { /* 204 / proxy error page */ }
  if (!res.ok) {
    // v2 speaks problem+json (RFC 9457): { code, title, detail, … }, not the v1
    // `{ error: { code, message } }` envelope.
    const p = (payload ?? {}) as { code?: string; title?: string; detail?: string | null };
    throw new PlanAuthorError(
      p.code ?? 'internal',
      p.detail || p.title || 'That did not save. Try again.',
      res.status,
    );
  }
  return payload as ResolvedPlanTemplate;
}

export interface AuthorResult {
  planVersionId: string;
  /** null while drafting — a draft is unnumbered until it is sent for approval. */
  versionNo: number | null;
  status: 'draft';
  stageCount: number;
  rootCount: number;
  auditEventId: string;
  /**
   * Each keyed stage's FRESHLY-MINTED id, by its stable client key (LINA-307). A
   * draft re-save re-mints these ids, so the editor refreshes its key→id lookup
   * from this map on every save — a status POST always targets the LIVE stage id
   * without waiting for a page reload. Keyless nodes are absent.
   */
  stageIds?: Record<string, string>;
}

// `authorPlan` (POST /api/v1/…:author) was removed in LINA-387 (Phase 12c). The
// editor saves drafts through the v2 writer (lib/v2/plan-write.ts); the types
// above (AuthorResult / AuthoredNode / PlanAuthorError) are retained because the
// v2 apply/diff path and the editor still build against them.
