// The plan grid's v2 I/O layer, on `/api/v2` (LINA-320, S3 of the UI cutover,
// doc 22 §3). This is the read side of the plan/Gantt cutover: it fetches the
// live WBS schedule through the shared v2 client (`./client.ts`, LINA-309) and
// hands the grid the tree it already renders (`./planning-view.ts`).
//
// ── FIRST-CLASS EMPTY / NO-ORG STATES (doc 22 header + the S1 pattern) ────────
// The v2 access model is org-centric: a signed-in Clerk user with no mirror row,
// or no active org, or who is not a participant on this build, must NOT crash the
// plan page — those are ordinary states of a fresh B2 install (LINA-310), not
// errors. As in `profile.ts`, any `V2Error` (401/403/404) collapses to an EMPTY
// plan: no rows, not baselined. The page then renders its own "no plan yet"
// authoring affordance rather than a stack trace. A non-V2 error (a real bug) is
// rethrown — we fail closed on authorization, not on our own defects.
//
// The pure wire→view transforms live in `./planning-view.ts` so they stay
// unit-testable without a session; this module is only the I/O and the
// fail-closed handling.
import 'server-only';
import { randomUUID } from 'node:crypto';

import { v2, V2Error } from './client';
import {
  toPlanGridView,
  type PlanGridView,
  type V2ScheduleView,
} from './planning-view';
import { authoredToCreateBatch } from './plan-apply';
import { diffPlanTrees } from './plan-diff';
import { planEditRequests, isEmptyPlan } from './plan-edit-ops';
import type { AuthoredNode } from '@/lib/plan-authoring';

/** The empty plan — a signed-in viewer with no readable schedule (no org / not a
 *  participant / nothing authored). Distinct object each call, never shared. */
function emptyPlan(projectId: string): PlanGridView {
  return { projectId, rows: [], isBaselined: false, dependenciesBySuccessor: {} };
}

/**
 * GET /api/v2/projects/{id}/schedule → the grid-native plan view, membership
 * scoped server-side (the viewer's participation on this build, never a
 * client-held claim). Returns the EMPTY plan for any authorization failure — a
 * viewer who cannot read the schedule sees "no plan", never a crash and never
 * another org's rows.
 */
export async function getPlanGrid(projectId: string): Promise<PlanGridView> {
  try {
    const body = await v2<V2ScheduleView>({
      method: 'GET',
      path: `/projects/${projectId}/schedule`,
    });
    return toPlanGridView(body);
  } catch (err) {
    if (err instanceof V2Error) return emptyPlan(projectId); // no access / no plan — not a crash
    throw err;
  }
}

/** What the fresh-authoring write returns to the editor: the created row ids by
 *  author-local key (the LINA-307 refresh) and the plan's row count. */
export interface ApplyPlanResult {
  /** author-local key → the stable v2 row id the server created for it. */
  idByKey: Record<string, string>;
  /** How many rows the batch created. */
  createdCount: number;
}

/** The `schedule:apply` response we read back — only the fields we surface. */
interface V2ApplyResponse {
  applied: boolean;
  created?: Array<{ id: string }>;
}

/**
 * Author a FRESH plan on v2 — the empty-plan case, the only one where the editor
 * owns the whole tree (see `plan-apply.ts`). Mints a row UUID per node and a
 * single `client_change_id`, builds one `create_rows` batch, and commits it via
 * `POST /api/v2/projects/{id}/schedule:apply` behind the shared client. The
 * change id doubles as the `Idempotency-Key`, so a retried submit is a proven
 * no-op, never a second plan.
 *
 * Unlike the READ path (`getPlanGrid`, which fail-closes to an empty plan on any
 * authorization error), a WRITE rethrows: a viewer who cannot author must see the
 * refusal, not a silent success. The caller (a server action) maps the thrown
 * `V2Error` to the editor's field-level messaging.
 */
export async function applyPlanDraft(
  projectId: string,
  nodes: AuthoredNode[],
): Promise<ApplyPlanResult> {
  const clientChangeId = randomUUID();
  const { request, idByKey } = authoredToCreateBatch(nodes, () => randomUUID(), clientChangeId);
  const res = await v2<V2ApplyResponse>({
    method: 'POST',
    path: `/projects/${projectId}/schedule:apply`,
    body: request,
    idempotencyKey: clientChangeId,
  });
  return { idByKey, createdCount: res.created?.length ?? 0 };
}

/** What an edit save returns to the editor: the created rows' ids by author-local
 *  key (the LINA-307 refresh, for rows this save ADDED) and whether a reparent was
 *  detected — the caller reloads to re-sync positions the read seam does not
 *  project (see `plan-diff.ts` / `plan-edit-ops.ts`). */
export interface EditPlanResult {
  /** author-local key → the stable v2 row id, for rows this save created. */
  idByKey: Record<string, string>;
  /** True when a row's parent changed — the caller must reload (a move is not
   *  emitted; the plan is otherwise saved). */
  needsReload: boolean;
}

/**
 * Save an EDIT of an EXISTING v2 plan — the incremental counterpart of
 * `applyPlanDraft` (which handles the empty-plan first author). Diffs the
 * last-saved authored tree (`prev`) against the tree the editor is saving now
 * (`next`), both keyed the way `planning-hydrate.ts` keys them (row key = v2 id for
 * existing rows). Reads the plan's LIVE links first so a removed edge resolves to a
 * link id, then fires the ordered request set (`plan-edit-ops.ts`):
 *   1. `schedule:apply` (new subtrees + deleted subtrees, dedupe on client_change_id),
 *   2. `PATCH /tasks/{id}` per changed row (same client_change_id),
 *   3. `POST /tasks/{id}/links` per added edge,
 *   4. `DELETE /links/{id}` per removed edge.
 *
 * The `client_change_id` is minted ONCE per save and reused across the batch's
 * calls, so a retried save dedupes on the ledger rather than doubling events — the
 * audit trail is the product, and a debounce that re-fires must not write twice.
 *
 * Like every v2 WRITE (unlike the fail-closed read), this rethrows a `V2Error`: a
 * viewer who cannot edit must see the refusal, not a silent success. The caller (a
 * server action) maps it to the editor's field-level messaging.
 */
export async function applyPlanEdits(
  projectId: string,
  prev: AuthoredNode[],
  next: AuthoredNode[],
): Promise<EditPlanResult> {
  const clientChangeId = randomUUID();
  const diff = diffPlanTrees(prev, next, () => randomUUID());

  // The plan's live links, so a removed edge resolves to its id. Read fresh per
  // save: v2 ids are stable, but a link created earlier this session has an id only
  // the server knows, and a link removed by a sibling delete_subtree is already
  // gone — the live read is the single source of truth for what to DELETE.
  const view = await v2<V2ScheduleView>({ method: 'GET', path: `/projects/${projectId}/schedule` });
  const plan = planEditRequests(diff, view.links ?? [], () => randomUUID(), clientChangeId);

  // No write of any kind — a debounce that fired after a selection, not an edit.
  // A reparent alone still needs a reload, so guard on that before short-circuiting.
  if (isEmptyPlan(plan)) {
    return { idByKey: plan.idByKey, needsReload: plan.movedKeys.length > 0 };
  }

  // ── STRUCTURE first (creates + deletes), so a later PATCH/link never targets a
  // row this save is about to delete or names a parent it is about to create. ─────
  if (plan.scheduleApply) {
    await v2<unknown>({
      method: 'POST',
      path: `/projects/${projectId}/schedule:apply`,
      body: plan.scheduleApply,
      idempotencyKey: clientChangeId,
    });
  }

  // ── FIELD patches on existing rows. ────────────────────────────────────────────
  for (const patch of plan.patches) {
    await v2<unknown>({
      method: 'PATCH',
      path: `/tasks/${patch.taskId}`,
      body: { changes: patch.changes, client_change_id: patch.client_change_id },
    });
  }

  // ── LINK adds (their endpoints validate against rows that now exist). ───────────
  for (const add of plan.linkAdds) {
    await v2<unknown>({
      method: 'POST',
      path: `/tasks/${add.successorId}/links`,
      body: add.body,
    });
  }

  // ── LINK removes last (a failed remove never strands a create). ─────────────────
  for (const rm of plan.linkRemoves) {
    await v2<unknown>({ method: 'DELETE', path: `/links/${rm.linkId}` });
  }

  return { idByKey: plan.idByKey, needsReload: plan.movedKeys.length > 0 };
}

export type { PlanGridView } from './planning-view';
