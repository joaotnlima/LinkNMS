// The plan grid's v2 data layer — pure wire→view transforms (LINA-320, S3 of the
// UI cutover, doc 22 §3). This is the seam that lets the EXISTING grid + Gantt
// (`PlanBaseline`/`PlanGrid`, which read `StageRow` trees) render the v2 schedule
// without a UX change. The I/O + fail-closed handling lives in `./planning.ts`;
// everything here runs under `node --test` with no session.
//
// ── WHY THIS IS NOT A FIELD RENAME (doc 05 vs the v1 B2 contract) ─────────────
// v1's plan read is a NEGOTIATION: `{ baseline, current, history }`, where a
// version walks draft → proposed → accepted and freezing an accepted version is
// what makes a baseline. v2 has no plan-version rows at all. v2 is a LIVE WBS:
// a flat `tasks[]` with `parent_id`/`position`/`depth`, typed `links[]`, and a
// baseline that is BOUND PER TASK when the contract is signed (doc 05 §7). So the
// mapping here is structural, not cosmetic, and it makes three deliberate calls:
//
//  1. FLAT → TREE. v2 sends every row flat with a `parent_id`; the grid wants a
//     nested `StageRow` tree. We rebuild the tree by `parent_id`, ordering
//     siblings by `position` (the server already sorts, we do not trust order).
//
//  2. BASELINE = SIGNED. There is no `baseline` object on the schedule read; a
//     task carries its own `baseline` once the plan is bound. "Is this plan a
//     frozen baseline?" therefore reads as "does ANY leaf carry a baseline?"
//     (`isBaselined`). Until then the plan is a DRAFT — which is what keeps the
//     status meter honest (ADR-0019, all-grey on an unbound plan): the grid shows
//     progress only against a bound baseline, exactly as v1 showed it only
//     against an accepted version.
//
//  3. ORG IS THE PARTY. v1's `assigneePartyId` is a build-membership party id;
//     v2 assignment is org-centric (`assignee.org_id`). The grid resolves the
//     name from the members directory by that id, so we pass the ORG id through
//     the party slot — a renamed org renames on the plan, nothing is frozen here.
//
// Everything else (`verified` folding into `done` for the four-state meter,
// `specialty` → `trade`, the per-viewer cost roll-up → a single stage cost) is
// documented at its call site below.

// ── v2 wire shapes (restated, the same discipline as profile-view.ts) ─────────
// snake_case exactly as `/api/v2/projects/{id}/schedule` emits (openapi.yaml
// `Task`/`Link`). Restating locally means a projection drift shows up as a type
// error here, not as `undefined` on a Gantt bar.

/** Money as the v2 surface sends it. `amount_cents` is an integer of `currency`. */
export interface V2Money {
  amount_cents: number;
  currency: string;
}

/** Per-viewer cost roll-up (CostRollup, D-27). Absent when no visible lines. */
export interface V2CostRollup {
  mine?: V2Money;
  revenue?: V2Money;
  cost?: V2Money;
  margin?: V2Money;
}

/** The five-state v2 task status. `verified` is a stronger `done` (doc 05 §8). */
export type V2TaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'done' | 'verified';

export interface V2TaskAssignee {
  org_id: string;
  org_name?: string;
  person_id?: string;
  inherited?: boolean;
}

/** One row of the v2 WBS. Flat — `parent_id`/`position` carry the tree. */
export interface V2Task {
  id: string;
  project_id: string;
  parent_id: string | null;
  depth: number;
  position: string;
  kind: 'task' | 'milestone' | 'summary';
  name: string;
  description?: string;
  specialty?: string;
  location_id?: string;
  assignee?: V2TaskAssignee;
  dating_mode?: string;
  start: string | null;
  finish: string | null;
  duration_wd?: number;
  actual_start?: string | null;
  actual_finish?: string | null;
  baseline: { start: string | null; finish: string | null; version?: number } | null;
  schedule_state?: 'planned' | 'on_baseline' | 'extended' | 'sequence_warning';
  status: V2TaskStatus;
  acceptance_criteria?: string;
  can_edit?: boolean;
  editor_is_assignee?: boolean;
  cost?: V2CostRollup;
  open_variations?: number;
  open_questions?: number;
}

export type V2LinkAnchor = 'start' | 'end';

export interface V2Link {
  id: string;
  predecessor_id: string;
  successor_id: string;
  from_anchor: V2LinkAnchor;
  to_anchor: V2LinkAnchor;
  lag_wd?: number;
  created_by?: { org_id?: string; person_id?: string };
}

/** `GET /api/v2/projects/{id}/schedule` — the whole plan grid read. */
export interface V2ScheduleView {
  project_id: string;
  tasks: V2Task[];
  links: V2Link[];
  calendar?: unknown;
  health?: unknown;
}

// ── The grid's shapes (restated from lib/plan-baseline.ts) ────────────────────
// We import these types rather than redefine them, so a drift in the grid's
// contract is caught here. They are re-exported so `./planning.ts` and the page
// have one import site for the v2 view.
import type { StageStatus, StageRow } from '@/lib/plan-baseline';
export type { StageStatus, StageRow } from '@/lib/plan-baseline';

/** The dependency triple the grid draws links from (ADR-0020, typed deps). */
export type GridDependencyType = 'starts_after' | 'starts_with' | 'ends_with';

/**
 * The grid-native view of a v2 plan. `rows` is the nested tree the table + Gantt
 * render; `isBaselined` is the honest-meter switch (false = draft, all-grey);
 * `dependencies` is the flat typed-link list the Gantt overlays draw from,
 * keyed to the SUCCESSOR row id so the grid can hang each link off its row.
 */
export interface PlanGridView {
  projectId: string;
  rows: StageRow[];
  /** True once the plan is bound to a signed baseline (any leaf carries one). */
  isBaselined: boolean;
  /** Typed predecessor links per successor stage id (empty when none). */
  dependenciesBySuccessor: Record<string, Array<{ on: string; type: GridDependencyType }>>;
}

// ── Transforms ────────────────────────────────────────────────────────────────

/**
 * v2's five-state status → the grid's four-state meter. `verified` is a stronger
 * `done` (an inspector signed it off, doc 05 §8); the four-state meter has no
 * cell for it, and collapsing it to `done` keeps the meter honest — a verified
 * task IS complete. Every other value is shared verbatim.
 */
export function toStageStatus(s: V2TaskStatus): StageStatus {
  return s === 'verified' ? 'done' : s;
}

/**
 * A v2 link's two anchors → the grid's typed-dependency vocabulary (ADR-0020):
 *  • end → start  = `starts_after`  (finish-to-start, the default sequence)
 *  • start → start = `starts_with`  (both begin together)
 *  • end → end    = `ends_with`     (both finish together)
 * A start→end link has no grid analog (v1 never modelled it); it maps to
 * `starts_after` as the safe, most-common default and is flagged by returning
 * null so the caller can drop it rather than draw a wrong arrow.
 */
export function toDependencyType(from: V2LinkAnchor, to: V2LinkAnchor): GridDependencyType | null {
  if (from === 'end' && to === 'start') return 'starts_after';
  if (from === 'start' && to === 'start') return 'starts_with';
  if (from === 'end' && to === 'end') return 'ends_with';
  return null; // start→end: unmodelled in the grid, dropped by the caller
}

/**
 * The per-stage cost the grid shows. v2's roll-up is per-viewer and multi-faceted
 * (revenue/cost/margin, own + descendants); the grid has one "planned cost of
 * this stage" cell. We use `cost.mine` — the viewer's own+descendant total, the
 * closest analog to v1's `plannedCostCents` — and return null when no line is
 * visible (the roll-up is absent), which the grid renders as an unpriced row.
 */
export function toCostCents(cost: V2CostRollup | undefined): number | null {
  const cents = cost?.mine?.amount_cents;
  return typeof cents === 'number' ? cents : null;
}

/**
 * Build the nested `StageRow` tree from the flat v2 task list. Siblings are
 * ordered by `position` (a fractional-index string, compared lexically — the
 * same order the server sorts by, re-derived here so the view never trusts array
 * order). A row whose `parent_id` names no known task is treated as a root, so a
 * filtered read (`?root=`/`?depth=`) that clips a parent still renders its
 * subtree rather than dropping it.
 */
export function toStageRows(tasks: V2Task[]): StageRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childrenOf = new Map<string | null, V2Task[]>();
  for (const t of tasks) {
    const parent = t.parent_id !== null && byId.has(t.parent_id) ? t.parent_id : null;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(t);
    else childrenOf.set(parent, [t]);
  }

  const build = (parentId: string | null): StageRow[] => {
    const kids = childrenOf.get(parentId) ?? [];
    kids.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    return kids.map((t) => ({
      id: t.id,
      key: t.id, // v2 task ids are stable (doc 05); no draft re-mint, so id IS the key
      name: t.name,
      trade: t.specialty ?? null,
      assigneePartyId: t.assignee?.org_id ?? null, // org is the party in v2
      start: t.start,
      end: t.finish,
      costCents: toCostCents(t.cost),
      status: toStageStatus(t.status),
      children: build(t.id),
    }));
  };

  return build(null);
}

/** True once the plan is bound to a signed baseline — any leaf carries one. */
export function isBaselined(tasks: V2Task[]): boolean {
  return tasks.some((t) => t.baseline !== null && t.baseline.start !== null);
}

/**
 * The flat typed-link list, keyed by SUCCESSOR stage id so the grid can hang each
 * dependency off the row that waits on it. Links the grid cannot draw
 * (start→end) are dropped, not guessed.
 */
export function toDependencies(
  links: V2Link[],
): Record<string, Array<{ on: string; type: GridDependencyType }>> {
  const out: Record<string, Array<{ on: string; type: GridDependencyType }>> = {};
  for (const l of links) {
    const type = toDependencyType(l.from_anchor, l.to_anchor);
    if (type === null) continue;
    (out[l.successor_id] ??= []).push({ on: l.predecessor_id, type });
  }
  return out;
}

/** The whole `getSchedule` body → the grid-native view. */
export function toPlanGridView(view: V2ScheduleView): PlanGridView {
  return {
    projectId: view.project_id,
    rows: toStageRows(view.tasks ?? []),
    isBaselined: isBaselined(view.tasks ?? []),
    dependenciesBySuccessor: toDependencies(view.links ?? []),
  };
}

/** A row found by key, with the names above it — the task permalink's heading
 *  (the v2 counterpart of `task-workspace.ts#StageHit`, over the grid tree). */
export interface RowHit {
  row: StageRow;
  /** Ancestor names, outermost first (phase → task), excluding the row itself. */
  trail: string[];
  /** 0 = phase, 1 = task, 2 = sub-task. */
  depth: number;
}

/**
 * Resolve a task permalink's key against a grid tree, or null. In v2 a row's key
 * IS its id (`toStageRows`: v2 ids are stable, no draft re-mint), so this matches
 * on `row.id` — the same value the editor keys drafts on (`planning-hydrate.ts`)
 * and the URL carries. Null is what the permalink page turns into `notFound()`: a
 * key naming no row on this build's plan is a dead address, and rendering an empty
 * task for it would invent work that does not exist — the v1 `findStageByKey` rule.
 */
export function findRowByKey(rows: StageRow[], key: string): RowHit | null {
  const walk = (nodes: StageRow[], trail: string[]): RowHit | null => {
    for (const n of nodes) {
      if (n.id === key) return { row: n, trail, depth: trail.length };
      const hit = n.children.length ? walk(n.children, [...trail, n.name]) : null;
      if (hit) return hit;
    }
    return null;
  };
  return key ? walk(rows, []) : null;
}

/**
 * Every row id in the grid tree, depth-first. These are the keys the SERVER holds
 * — what the authoring editor seeds `savedStageKeys` from, so a permalinked task's
 * workspace (comments/files) opens on mount rather than saying "save first". In v2
 * every rendered row is persisted (it came from the read), so the whole tree is
 * "saved" — unlike a v1 draft, which could carry not-yet-written local rows.
 */
export function collectRowKeys(rows: StageRow[]): string[] {
  const out: string[] = [];
  const walk = (nodes: StageRow[]): void => {
    for (const n of nodes) {
      out.push(n.id);
      if (n.children.length) walk(n.children);
    }
  };
  walk(rows);
  return out;
}

/**
 * Every (id, name) in the grid tree, depth-first — the full set of tenderable
 * packages the procurement composer can root an RFP at. LINA-420 made tendering
 * per-task at ANY level (a pre-construction phase can carry several concurrent
 * tenders — architecture, electrical, plumbing…), so a candidate list built from
 * only the top-level rows would drop every nested task/sub-task and silently
 * discard a "Start tendering" deep-link raised on one.
 */
export function collectRowOptions(rows: StageRow[]): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const walk = (nodes: StageRow[]): void => {
    for (const n of nodes) {
      out.push({ id: n.id, name: n.name });
      if (n.children.length) walk(n.children);
    }
  };
  walk(rows);
  return out;
}
