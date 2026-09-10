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
// reordering — it never reaches the server (which assigns its own stage ids).

export interface TaskDraft { key: string; name: string; start: string; end: string }
export interface PhaseDraft { key: string; name: string; tasks: TaskDraft[] }

let keySeq = 0;
/** A stable per-session draft key. Not a stage id — the server assigns those. */
export function newKey(prefix = 'k'): string {
  keySeq += 1;
  return `${prefix}-${keySeq}`;
}

function emptyTask(name = ''): TaskDraft {
  return { key: newKey('t'), name, start: '', end: '' };
}

/** A fresh draft of the standard skeleton, with new keys each call. */
export function seedSkeleton(): PhaseDraft[] {
  return PLAN_SKELETON.map((p) => ({
    key: newKey('p'),
    name: p.name,
    tasks: p.tasks.map((t) => emptyTask(t)),
  }));
}

/** An empty phase, for "Add phase". */
export function emptyPhase(name = ''): PhaseDraft {
  return { key: newKey('p'), name, tasks: [] };
}

export { emptyTask };

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

export function removePhase(phases: PhaseDraft[], pi: number): PhaseDraft[] {
  return phases.filter((_, i) => i !== pi);
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

export function moveTask(phases: PhaseDraft[], pi: number, ti: number, delta: number): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, { ...phase, tasks: move(phase.tasks, ti, delta) });
}

export function removeTask(phases: PhaseDraft[], pi: number, ti: number): PhaseDraft[] {
  const phase = phases[pi];
  return replaceAt(phases, pi, { ...phase, tasks: phase.tasks.filter((_, i) => i !== ti) });
}

/** Total task count across all phases — for the "N tasks across M phases" summary. */
export function taskCount(phases: PhaseDraft[]): number {
  return phases.reduce((acc, p) => acc + p.tasks.length, 0);
}

// ── The wire edge ─────────────────────────────────────────────────────────────

/** An action node of the authored WBS, as the server's :author contract wants it. */
export interface AuthoredNode {
  name: string;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  children?: AuthoredNode[];
}

/** A refusal raised before we send — an empty name, nothing to send. */
export class PlanAuthorError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'PlanAuthorError';
    this.code = code;
    this.status = status;
  }
}

const dateOrNull = (v: string): string | null => (v && v.trim() ? v.trim() : null);

/**
 * Build the `{ stages }` body, validating client-side first so the author gets a
 * pointed message beside the field rather than a round-trip 400. Mirrors exactly
 * what the server re-validates (§1): every phase and task needs a name; empty
 * phases are dropped (a phase with no tasks is a heading the author started and
 * left — not an error, just not sent); dates pass through, blanks become null.
 */
export function toWire(phases: PhaseDraft[]): AuthoredNode[] {
  const stages: AuthoredNode[] = [];
  for (const phase of phases) {
    const name = phase.name.trim();
    const tasks = phase.tasks.filter((t) => t.name.trim() !== '' || t.start || t.end);
    // A phase the author emptied out entirely is skipped silently.
    if (!name && tasks.length === 0) continue;
    if (!name) {
      throw new PlanAuthorError('invalid_name', 'Give every phase a name (or remove it).');
    }
    const children: AuthoredNode[] = tasks.map((t) => {
      const tn = t.name.trim();
      if (!tn) throw new PlanAuthorError('invalid_name', `A task under "${name}" needs a name.`);
      return { name: tn, plannedStartDate: dateOrNull(t.start), plannedEndDate: dateOrNull(t.end) };
    });
    stages.push({ name, children });
  }
  if (stages.length === 0) {
    throw new PlanAuthorError('empty_plan', 'Add at least one phase before creating the plan.');
  }
  return stages;
}

export interface AuthorResult {
  planVersionId: string;
  versionNo: number;
  status: 'proposed';
  stageCount: number;
  rootCount: number;
  auditEventId: string;
}

/**
 * POST /api/v1/projects/:id/plan-versions:author — commit the authored plan as a
 * proposed v1 (contract §0–§3). Only `{ stages }` crosses the wire; the actor is
 * the session. A refusal comes back as a typed PlanAuthorError so the editor can
 * react to the KIND (open_plan_exists sends the author to the live plan).
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
    const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new PlanAuthorError(
      err?.code ?? 'internal',
      err?.message ?? 'That did not go through. Try again.',
      res.status,
    );
  }
  return payload as AuthorResult;
}
