// Plan grid + Gantt READ data layer on `/api/v2` (LINA-320, S3 of the UI
// cutover, doc 22 §3). This is the v2 counterpart to `lib/plan-baseline.ts`
// (reads) and lives on the server only — the write path (applyScheduleTree) is
// in `lib/plan-authoring.ts` alongside authorPlan, because both are called from
// the client-side build editor via a direct HTTP fetch.
//
// ── MODEL CHANGE FROM v1 ─────────────────────────────────────────────────────
// v1's plan model is version-based: a GC authors a draft, proposes it, the
// owner accepts/rejects/requests-changes. v2's model is task-based: tasks live
// directly on the project (no version envelope), `schedule_state` indicates
// draft/open/locked, and `applySchedule` commits a batch of operations
// atomically. The proposal/acceptance workflow moves to the contracting layer.
//
// For v2 projects this module returns null for the v1 `PlanBaselineView` shape,
// instead surfacing a `V2Schedule` that the plan page adapts to the existing
// grid's `StageRow[]` view model via `toV2PlanRows`.
//
// ── IDENTITY MODEL CHANGE ─────────────────────────────────────────────────────
// v1 used `assigneePartyId` (party = v1 identity entity). v2 uses
// `assignee.org_id` (organisation). Under B2 (fresh-start) there are no v1
// party rows on v2 projects; we put org_id in the `assigneePartyId` slot so the
// party-avatar display keeps working with the org as the "party".
import 'server-only';

import type { StageRow, StageStatus } from '@/lib/plan-baseline';
import { v2, V2Error } from './client';

// ── Wire types ────────────────────────────────────────────────────────────────

export interface V2Assignee {
  org_id: string;
  org_name?: string;
  person_id?: string;
  inherited: boolean;
}

export interface V2TaskSegment {
  kind: 'baseline' | 'current' | 'delay_start' | 'extension' | 'actual';
  from: string;
  to: string;
}

export interface V2Task {
  id: string;
  project_id: string;
  parent_id: string | null;
  depth: number;
  position: string;
  kind: 'summary' | 'task' | 'milestone';
  name: string;
  description?: string;
  specialty?: string;
  location_id?: string;
  assignee?: V2Assignee;
  dating_mode: 'dated' | 'undated' | 'external';
  start: string | null;
  finish: string | null;
  duration_wd?: number;
  actual_start: string | null;
  actual_finish: string | null;
  baseline: { start: string; finish: string; version: number } | null;
  segments: V2TaskSegment[];
  schedule_state: 'draft' | 'open' | 'locked';
  status: StageStatus;
  acceptance_criteria?: string;
  can_edit?: boolean;
}

export interface V2Link {
  id: string;
  predecessor_id: string;
  successor_id: string;
  from_anchor: 'start' | 'end';
  to_anchor: 'start' | 'end';
  lag_wd: number;
}

export interface V2Schedule {
  project_id: string;
  tasks: V2Task[];
  links: V2Link[];
  calendar: unknown;
  health: {
    critical_path_length_wd: number;
    late_task_count: number;
    float_exhausted_count: number;
  };
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * GET /api/v2/projects/:id/schedule
 *
 * Returns null when the project does not exist in v2 (404/403) so the caller
 * can fall back to the v1 `getPlan` path. Any other V2Error re-throws — it is
 * a real failure, not a "use v1 instead" signal.
 */
export async function getScheduleV2(projectId: string): Promise<V2Schedule | null> {
  try {
    return await v2<V2Schedule>({ method: 'GET', path: `/projects/${projectId}/schedule` });
  } catch (err) {
    if (err instanceof V2Error && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/**
 * Maps a flat v2 task array (sorted by position) to a nested `StageRow[]` tree,
 * the same shape `PlanBaseline`, `totalCents`, and `stageCounts` consume.
 *
 * `assigneePartyId` receives the org_id (v2 identity model) so the existing
 * party-avatar directory lookup is meaningful — under B2 the "party" IS the org.
 */
export function toV2PlanRows(tasks: V2Task[]): StageRow[] {
  const sorted = [...tasks].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
  );

  const byId = new Map<string, { row: StageRow; children: StageRow[] }>();
  const roots: { row: StageRow; children: StageRow[] }[] = [];

  for (const t of sorted) {
    const entry = {
      row: {
        id: t.id,
        key: null,
        name: t.name,
        trade: t.specialty ?? null,
        assigneePartyId: t.assignee?.org_id ?? null,
        start: t.start,
        end: t.finish,
        costCents: null,
        status: t.status,
        children: [],
      } satisfies StageRow,
      children: [] as StageRow[],
    };
    byId.set(t.id, entry);
    if (t.parent_id && byId.has(t.parent_id)) {
      byId.get(t.parent_id)!.children.push(entry.row);
    } else {
      roots.push(entry);
    }
  }

  // Connect children arrays.
  for (const { row, children } of byId.values()) {
    (row as { children: StageRow[] }).children = children;
  }

  return roots.map((r) => r.row);
}

/**
 * Converts v2 tasks to `PlanStageNode[]` shape for hydrating a `PhaseDraft[]`
 * (edit resume). This lets the build editor resume editing a previously saved v2
 * schedule via `hydrateDraft`, which expects the v1 node shape.
 *
 * Only the fields `hydrateDraft` actually reads are populated (name, key, id,
 * plannedStartDate, plannedEndDate, trade, assigneePartyId, children).
 */
export function v2TasksToStageNodes(tasks: V2Task[]): import('@/lib/plan-baseline').PlanStageNode[] {
  const sorted = [...tasks].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
  );

  type Node = import('@/lib/plan-baseline').PlanStageNode;
  const byId = new Map<string, Node>();
  const roots: Node[] = [];

  for (const t of sorted) {
    const node: Node = {
      id: t.id,
      name: t.name,
      position: 0,
      trade: t.specialty ?? null,
      assigneePartyId: t.assignee?.org_id ?? null,
      plannedStartDate: t.start,
      plannedEndDate: t.finish,
      plannedCostCents: null,
      currentStatus: t.status,
      dependencies: [],
      dependsOn: [],
      children: [],
    };
    byId.set(t.id, node);
    if (t.parent_id && byId.has(t.parent_id)) {
      byId.get(t.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
