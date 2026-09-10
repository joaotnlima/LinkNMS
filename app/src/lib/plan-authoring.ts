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
//   2. TWO LEVELS ONLY. A phase (action) holds tasks (sub-actions); a task holds
//      nothing. `toWire` cannot emit a third level even if asked.
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

// A node's `dependsOn` holds the LOCAL KEYS of its predecessors ("this can't
// start until those are done"). Any other stage is a valid target — a task may
// follow a phase, a phase may follow a task in another phase (contract §1,
// ADR-0017 annex 2: scope is any-stage, no parent/level constraint). The keys
// are author-local: the server resolves them to its own stage ids inside the
// draft-save transaction and never persists them.

export interface TaskDraft {
  key: string; name: string; start: string; end: string; description: string;
  /** Local keys of this task's predecessors (LINA-233). */
  dependsOn: string[];
}
export interface PhaseDraft {
  key: string; name: string; tasks: TaskDraft[];
  /** Local keys of this phase's predecessors (LINA-233). */
  dependsOn: string[];
}

let keySeq = 0;
/** A stable per-session draft key. Not a stage id — the server assigns those. */
export function newKey(prefix = 'k'): string {
  keySeq += 1;
  return `${prefix}-${keySeq}`;
}

function emptyTask(name = ''): TaskDraft {
  return { key: newKey('t'), name, start: '', end: '', description: '', dependsOn: [] };
}

/** A fresh draft of the standard skeleton, with new keys each call. */
export function seedSkeleton(): PhaseDraft[] {
  return PLAN_SKELETON.map((p) => ({
    key: newKey('p'),
    name: p.name,
    dependsOn: [],
    tasks: p.tasks.map((t) => emptyTask(t)),
  }));
}

/** An empty phase, for "Add phase". */
export function emptyPhase(name = ''): PhaseDraft {
  return { key: newKey('p'), name, tasks: [], dependsOn: [] };
}

export { emptyTask };

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
  /** Resolved predecessor STAGE IDS (LINA-233); re-keyed to local keys below. */
  dependsOn?: string[] | null;
  children?: DraftStageNode[] | null;
}

/**
 * Turn a saved draft's stage tree into the editor's phase/task model.
 *
 * Dependencies come back as the SERVER's stage ids (contract §0: "getPlan
 * returns each stage's resolved dependsOn"), so re-keying is a two-pass job —
 * every node has to have been given its local key before any edge can be
 * translated, since a predecessor may sit later in the tree (a phase may follow
 * a task in a phase below it). An edge naming a stage that is not in this tree
 * is dropped rather than carried as a dangling key the next save would 400 on.
 */
export function hydrateDraft(stages: DraftStageNode[]): PhaseDraft[] {
  const keyByStageId = new Map<string, string>();
  const phases: PhaseDraft[] = stages.map((p) => {
    const key = newKey('p');
    if (p.id) keyByStageId.set(p.id, key);
    return {
      key,
      name: p.name,
      dependsOn: [],
      tasks: (p.children ?? []).map((t) => {
        const tk = newKey('t');
        if (t.id) keyByStageId.set(t.id, tk);
        return {
          key: tk,
          name: t.name,
          start: t.plannedStartDate ?? '',
          end: t.plannedEndDate ?? '',
          description: t.description ?? '',
          dependsOn: [],
        };
      }),
    };
  });

  const translate = (ids: string[] | null | undefined): string[] =>
    (ids ?? []).map((id) => keyByStageId.get(id)).filter((k): k is string => typeof k === 'string');

  stages.forEach((p, pi) => {
    phases[pi].dependsOn = translate(p.dependsOn);
    (p.children ?? []).forEach((t, ti) => { phases[pi].tasks[ti].dependsOn = translate(t.dependsOn); });
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

/**
 * Drop every predecessor edge pointing at a stage that is no longer in the
 * draft. Removing a stage others depended on must take its edges with it —
 * otherwise a chip would render for a row that is gone, and the save would ship
 * a key the server has never heard of (`400 unknown_dependency`).
 */
function pruneEdges(phases: PhaseDraft[]): PhaseDraft[] {
  const live = new Set<string>();
  for (const p of phases) { live.add(p.key); for (const t of p.tasks) live.add(t.key); }
  const keep = (deps: string[]) => deps.filter((k) => live.has(k));
  return phases.map((p) => ({
    ...p,
    dependsOn: keep(p.dependsOn),
    tasks: p.tasks.map((t) => ({ ...t, dependsOn: keep(t.dependsOn) })),
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
  const phase = phases[pi];
  return replaceAt(phases, pi, { ...phase, tasks: replaceAt(phase.tasks, ti, { ...phase.tasks[ti], name }) });
}

export function setTaskDate(
  phases: PhaseDraft[], pi: number, ti: number, field: 'start' | 'end', value: string,
): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, {
    ...phase,
    tasks: replaceAt(phase.tasks, ti, { ...phase.tasks[ti], [field]: value }),
  });
}

/** Edit a task's free-form description (the task-detail drawer field, LINA-234). */
export function setTaskDescription(
  phases: PhaseDraft[], pi: number, ti: number, description: string,
): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, {
    ...phase,
    tasks: replaceAt(phase.tasks, ti, { ...phase.tasks[ti], description }),
  });
}

export function moveTask(phases: PhaseDraft[], pi: number, ti: number, delta: number): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, { ...phase, tasks: move(phase.tasks, ti, delta) });
}

export function removeTask(phases: PhaseDraft[], pi: number, ti: number): PhaseDraft[] {
  const phase = phases[pi];
  return pruneEdges(replaceAt(phases, pi, { ...phase, tasks: phase.tasks.filter((_, i) => i !== ti) }));
}

// ── Dependencies: "depends on" (LINA-233, ADR-0017 annex 2) ─────────────────
// An edge reads "this stage cannot start until that one is done", stored on the
// DEPENDENT as `dependsOn: [predecessorKey]` — the same direction as the wire,
// so nothing is flipped at the edge. The server is the authority on what is a
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
    out.push({ key: phase.key, outline, name, label: `${outline} ${name}`, isPhase: true, phaseKey: '' });
    phase.tasks.forEach((task, ti) => {
      const to = `${pi + 1}.${ti + 1}`;
      const tn = stripOutline(task.name) || 'Untitled task';
      out.push({ key: task.key, outline: to, name: tn, label: `${to} ${tn}`, isPhase: false, phaseKey: phase.key });
    });
  });
  return out;
}

/** key → its label, for rendering chips without re-walking the tree per row. */
export function nodeIndex(phases: PhaseDraft[]): Map<string, PlanNodeRef> {
  return new Map(planNodes(phases).map((n) => [n.key, n]));
}

/** key → its declared predecessors. The graph every helper below walks. */
function edges(phases: PhaseDraft[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of phases) {
    m.set(p.key, p.dependsOn);
    for (const t of p.tasks) m.set(t.key, t.dependsOn);
  }
  return m;
}

/** Every stage that transitively depends on `key` (its downstream). */
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
      if (preds.some((p) => p === key || out.has(p))) { out.add(node); grew = true; }
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
  const selected = new Set(edges(phases).get(forKey) ?? []);
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

/** One stage's declared predecessors, by key — phases and tasks alike. */
export function dependsOnOf(phases: PhaseDraft[], key: string): string[] {
  return edges(phases).get(key) ?? [];
}

/** Replace a stage's predecessor list (by key — phases and tasks alike). */
export function setDependsOn(phases: PhaseDraft[], key: string, dependsOn: string[]): PhaseDraft[] {
  const next = dependsOn.filter((d) => d !== key);
  return phases.map((p) => ({
    ...p,
    dependsOn: p.key === key ? next : p.dependsOn,
    tasks: p.tasks.map((t) => (t.key === key ? { ...t, dependsOn: next } : t)),
  }));
}

/** Add or remove one predecessor — what a picker checkbox and a chip's ✕ do. */
export function toggleDependency(phases: PhaseDraft[], key: string, dep: string): PhaseDraft[] {
  const current = edges(phases).get(key) ?? [];
  return setDependsOn(
    phases, key,
    current.includes(dep) ? current.filter((d) => d !== dep) : [...current, dep],
  );
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
    for (const pred of deps.get(k) ?? []) {
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

/** Total task count across all phases — for the "N tasks across M phases" summary. */
export function taskCount(phases: PhaseDraft[]): number {
  return phases.reduce((acc, p) => acc + p.tasks.length, 0);
}

// ── The wire edge ─────────────────────────────────────────────────────────────

/** An action node of the authored WBS, as the server's :author contract wants it. */
export interface AuthoredNode {
  name: string;
  /** The author-local key (contract §1) — resolves `dependsOn`, never stored. */
  key: string;
  /** Predecessor keys. Always sent, `[]` when none, so a cleared row clears. */
  dependsOn: string[];
  description?: string | null;
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

/**
 * Build the `{ stages }` body, validating client-side first so the author gets a
 * pointed message beside the field rather than a round-trip 400. Mirrors exactly
 * what the server re-validates (§1): every phase and task needs a name; empty
 * phases are dropped (a phase with no tasks is a heading the author started and
 * left — not an error, just not sent); dates pass through, blanks become null.
 *
 * Dependencies (LINA-233): each node carries its local `key`, and `dependsOn`
 * naming its predecessors by key. THE WHOLE GRAPH GOES EVERY TIME — the server
 * replaces a draft's edges atomically, so a re-save that omitted an edge would
 * delete it. Edges pointing at a stage this pass dropped (a blank row) are
 * filtered out here rather than sent to be refused as `unknown_dependency`.
 */
export function toWire(phases: PhaseDraft[]): AuthoredNode[] {
  // Which rows will actually be sent — computed first, because an edge may point
  // at a row that comes later in the tree.
  const sent = new Set<string>();
  const keeps = (t: TaskDraft) =>
    t.name.trim() !== '' || !!t.start || !!t.end || (t.description ?? '').trim() !== '';
  for (const phase of phases) {
    const tasks = phase.tasks.filter(keeps);
    if (!phase.name.trim() && tasks.length === 0) continue;
    sent.add(phase.key);
    for (const t of tasks) sent.add(t.key);
  }
  const wireDeps = (deps: string[]) => deps.filter((k) => sent.has(k));

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
      const description = (t.description ?? '').trim() || null;
      return {
        name: tn, key: t.key, dependsOn: wireDeps(t.dependsOn), description,
        plannedStartDate: dateOrNull(t.start), plannedEndDate: dateOrNull(t.end),
      };
    });
    stages.push({ name, key: phase.key, dependsOn: wireDeps(phase.dependsOn), children });
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
