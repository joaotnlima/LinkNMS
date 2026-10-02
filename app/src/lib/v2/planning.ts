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
import type { AuthoredNode, StageStatus } from '@/lib/plan-authoring';

/** The empty plan — a signed-in viewer with no readable schedule (no org / not a
 *  participant / nothing authored). Distinct object each call, never shared. */
function emptyPlan(projectId: string): PlanGridView {
  return { projectId, rows: [], isBaselined: false, dependenciesBySuccessor: {} };
}

/** A party the viewer may set as a row owner — the editor's `PartyRef` shape. */
export interface AssignableParty {
  partyId: string;
  name: string;
  role: string | null;
}

interface V2AssignablePartiesResponse {
  parties: Array<{ id: string; name?: string | null; role?: string | null }>;
}

/**
 * GET /api/v2/projects/{id}/assignable-parties → the orgs the viewer may assign a
 * row to (LINA-404 FIX 2): their own org plus its direct suppliers, exactly the
 * set `updateTask`'s D-33 fence accepts. Mapped to the editor's `PartyRef` shape.
 * Fail-closed to an EMPTY list on any authorization error — a viewer who cannot
 * read it simply sees an inert owner picker, never a crash (the plan read uses the
 * same discipline).
 */
export async function getAssignableParties(projectId: string): Promise<AssignableParty[]> {
  try {
    const body = await v2<V2AssignablePartiesResponse>({
      method: 'GET',
      path: `/projects/${projectId}/assignable-parties`,
    });
    return (body.parties ?? []).map((p) => ({
      partyId: p.id,
      name: p.name ?? 'Unknown party',
      role: p.role ?? null,
    }));
  } catch (err) {
    if (err instanceof V2Error) return []; // no access — an inert picker, not a crash
    throw err;
  }
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
 *   1. `schedule:apply` (new/moved/deleted subtrees, dedupe on the base change id),
 *   2. `PATCH /tasks/{id}` per changed row (a DERIVED per-row change id),
 *   3. `POST /tasks/{id}/links` per added edge,
 *   4. `DELETE /links/{id}` per removed edge.
 *
 * The `client_change_id` is minted ONCE per save as the BASE id; each request then
 * carries its OWN id derived from it (`plan-edit-ops.ts#deriveChangeId`): the
 * `schedule:apply` batch uses the base verbatim, each `PATCH` uses
 * `derive(base, taskId)`. This is load-bearing (LINA-404): `applySchedule` stamps a
 * `batch` anchor field-change with its id, so a PATCH that REUSED the base would
 * trip `updateTask`'s idempotent-replay guard and SILENTLY DROP its edit — a create
 * (or reparent) plus a field edit in one debounced save would lose the edit.
 * Distinct derived ids keep per-request retry-dedup without the cross-request
 * collision; the audit trail is the product, and a debounce re-fire must neither
 * double-write nor drop a write.
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

/**
 * Report a task's execution status on v2 — the WRITE the plan editor's status
 * picker reaches through (LINA-384, Phase 12b.5). Appends an attributed,
 * append-only progress report via `POST /api/v2/tasks/{taskId}/progress`; the
 * server stamps who reported from the session, so widening WHO may report never
 * weakens the audit trail. `taskId` is the STABLE v2 row id — for a hydrated
 * existing row that is the editor's node key itself (v2 ids are stable, id IS
 * key — `planning-hydrate.ts`); for a row created this session it is the id the
 * save minted. The four `StageStatus` words are exactly the v2 reportable set
 * (`not_started|in_progress|blocked|done`); `verified` is Quality's word and is
 * never reported here.
 *
 * Like every v2 WRITE (unlike the fail-closed read), this rethrows a `V2Error`:
 * a viewer who may not report must see the refusal — the caller (`plan-write.ts`)
 * maps it to the picker's inline rollback message, never a silent success.
 */
export async function reportTaskProgress(taskId: string, status: StageStatus): Promise<void> {
  await v2<unknown>({
    method: 'POST',
    path: `/tasks/${taskId}/progress`,
    body: { status },
  });
}

export type { PlanGridView } from './planning-view';
