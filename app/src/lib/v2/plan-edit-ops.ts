// The plan grid's v2 WRITE-ORCHESTRATION seam — a pure `PlanDiff` → ordered set of
// v2 HTTP requests (LINA-320, S3 of the UI cutover, doc 22 §3). This is the fifth
// and last pure brick of the plan cutover, the one that turns the tree diff
// (`plan-diff.ts#diffPlanTrees`) into the exact wire calls the I/O layer
// (`planning.ts#applyPlanEdits`) fires. It runs under `node --test` with no
// session, exactly like its four siblings, so the load-bearing mapping — which op
// rides which endpoint, how a removed link resolves to an id, what carries a
// `client_change_id` — is tested without a live plan.
//
// ── WHY A SECOND WRITE SEAM, AND WHY IT IS PURE ───────────────────────────────
// `plan-apply.ts` maps the EMPTY-plan first author to ONE `create_rows` batch —
// one endpoint, one call. Editing an EXISTING plan is not one call: v2 spreads the
// edit across FOUR endpoints, each its own transaction with its own contract
// (planning/http/register.mjs):
//
//   • `POST /projects/{id}/schedule:apply` — structural batch. Takes BOTH the new
//     subtrees (`create_rows`, client-minted row ids, pre-order) AND the removed
//     subtrees (`delete_subtree`, one op per topmost removed row, server cascades
//     descendants + their links). So creates and deletes ride ONE apply call.
//   • `PATCH /tasks/{taskId}` — one call per changed EXISTING row, carrying only
//     the changed fields (`updateTask`; it rejects an empty `changes`). Requires a
//     `client_change_id` (uuid) it dedupes on.
//   • `POST /tasks/{taskId}/links` — one call per edge ADDED on an existing
//     successor (a new row's edges already rode the `create_rows` batch). The body
//     needs a CLIENT-MINTED link id, and the path task must be one of the pair —
//     we always path the SUCCESSOR, the row that owns the dependency (mirrors the
//     editor: `fromKey` is the dependent).
//   • `DELETE /links/{linkId}` — one call per edge REMOVED from an existing
//     successor. The diff names the pair + anchors, NOT an id (the editor draft
//     never held link ids); this brick resolves the id against the plan's LIVE
//     links, matching predecessor + successor + both anchors so a typed pair is
//     distinguished from a differently-anchored one between the same two rows.
//
// Because these are FOUR non-atomic transactions, order matters and is fixed here:
// STRUCTURE (create + delete) first, so a later PATCH/link never targets a row the
// same save is about to delete or names a parent it is about to create; then field
// PATCHes; then link ADDs (their endpoints validate against rows that now exist);
// then link REMOVES last (safe in any order, but kept last so a failed remove
// never strands a create). The I/O caller fires them in exactly this order.
//
// ── IDEMPOTENCY (the audit trail is the product — a retry must not double-write) ─
// `schedule:apply` and `updateTask` both dedupe on a `client_change_id`; a retried
// call with the SAME id is a proven no-op on the ledger, not a second event. So the
// id is NOT minted here per call — it is passed in by the caller and REUSED across
// a retry of the same logical save (`planning.ts` holds it for the debounce's
// lifetime). `createLink`/`deleteLink` have no change-id dedupe, but they are
// naturally idempotent against a re-run: `addLink` refuses a duplicate pair
// (`version_conflict`) and a delete of an already-gone link resolves to nothing
// here (the pair is absent from live links), so both no-op on replay. Link ids ARE
// minted here (the create endpoint requires a client id) via the injected `mint`.

import type { PlanDiff } from './plan-diff';
import type { V2CreateRowsOp, V2LinkAnchor } from './plan-apply';
import type { V2Link } from './planning-view';

// ── The request shapes the I/O layer fires (one per endpoint) ─────────────────

/** `POST /projects/{projectId}/schedule:apply` — creates + deletes in one batch. */
export interface ScheduleApplyRequest {
  operations: Array<V2CreateRowsOp | DeleteSubtreeOp>;
  client_change_id: string;
}

/** A `delete_subtree` op — the server cascades to descendants and their links. */
export interface DeleteSubtreeOp {
  op: 'delete_subtree';
  task_id: string;
}

/** `PATCH /tasks/{taskId}` — the changed fields on one existing row. */
export interface PatchTaskRequest {
  taskId: string;
  changes: PlanDiff['updates'][number]['changes'];
  client_change_id: string;
}

/** `POST /tasks/{successorId}/links` — one edge added on an existing successor. */
export interface CreateLinkRequest {
  /** The row the call is pathed on — always the successor (owns the dependency). */
  successorId: string;
  /** The full create-link body (client-minted `id`, both rows, both anchors). */
  body: {
    id: string;
    predecessor_id: string;
    successor_id: string;
    from_anchor: V2LinkAnchor;
    to_anchor: V2LinkAnchor;
    lag_wd?: number;
  };
}

/** `DELETE /links/{linkId}` — one edge removed from an existing successor. */
export interface DeleteLinkRequest {
  linkId: string;
}

/**
 * The complete, ordered write plan for one save of an existing plan. Empty lists
 * (and a null `scheduleApply`) mean "nothing of that kind changed"; a save whose
 * every field is empty is a no-op the caller skips entirely. The caller fires them
 * in field order: `scheduleApply` → `patches` → `linkAdds` → `linkRemoves`.
 */
export interface PlanEditPlan {
  /** The structural batch (creates + deletes), or null when neither changed. */
  scheduleApply: ScheduleApplyRequest | null;
  /** Field PATCHes on existing rows. */
  patches: PatchTaskRequest[];
  /** Edges added on existing successors. */
  linkAdds: CreateLinkRequest[];
  /** Edges removed from existing successors, resolved to live link ids. */
  linkRemoves: DeleteLinkRequest[];
  /** New local key → minted v2 id for the created rows (the LINA-307 refresh). */
  idByKey: Record<string, string>;
  /** Existing rows whose parent changed — the caller reloads to re-sync positions
   *  (a move needs a position key the read seam does not project; see plan-diff). */
  movedKeys: string[];
}

/** A live link's identity key — predecessor + successor + both anchors — so a typed
 *  edge (e.g. `end→start`) is distinguished from a differently-anchored one between
 *  the SAME pair. Matches the `V2LinkRemoval` the diff produces. */
function linkKey(predecessorId: string, successorId: string, from: V2LinkAnchor, to: V2LinkAnchor): string {
  return `${predecessorId}→${successorId}|${from}→${to}`;
}

/**
 * Turn one `PlanDiff` + the plan's LIVE links into the ordered set of v2 requests.
 * Pure and deterministic: `mint` is injected for the client-minted link ids (the
 * I/O caller passes `crypto.randomUUID`, a test passes a counter), and
 * `clientChangeId` is passed in (reused across a retry so a re-fired save dedupes
 * on the ledger rather than doubling it).
 *
 *  • CREATES + DELETES → one `scheduleApply` (createOp first, then a `delete_subtree`
 *    per removed root), or null when the diff added and removed nothing.
 *  • UPDATES → a `PatchTaskRequest` each, carrying the same `client_change_id`.
 *  • LINK ADDS → a `CreateLinkRequest` each, pathed on the successor, id minted.
 *  • LINK REMOVES → resolved against `liveLinks`; an edge with no live match is
 *    DROPPED (already gone — a delete_subtree cascade or a prior remove took it),
 *    never sent as a DELETE on an id we do not have.
 *
 * `idByKey` and `movedKeys` pass straight through from the diff — the caller needs
 * the id refresh and the reload guard.
 */
export function planEditRequests(
  diff: PlanDiff,
  liveLinks: V2Link[],
  mint: () => string,
  clientChangeId: string,
): PlanEditPlan {
  // ── Structure: create_rows (if any) then a delete_subtree per removed root ────
  const operations: Array<V2CreateRowsOp | DeleteSubtreeOp> = [];
  if (diff.createOp) operations.push(diff.createOp);
  for (const taskId of diff.deletes) operations.push({ op: 'delete_subtree', task_id: taskId });
  const scheduleApply: ScheduleApplyRequest | null = operations.length
    ? { operations, client_change_id: clientChangeId }
    : null;

  // ── Field PATCHes: the same change-id, so a retried batch dedupes per row ──────
  const patches: PatchTaskRequest[] = diff.updates.map((u) => ({
    taskId: u.taskId,
    changes: u.changes,
    client_change_id: clientChangeId,
  }));

  // ── Link adds: pathed on the successor, a fresh client id per edge ─────────────
  const linkAdds: CreateLinkRequest[] = diff.linkAdds.map((edge) => ({
    successorId: edge.successor_id,
    body: {
      id: mint(),
      predecessor_id: edge.predecessor_id,
      successor_id: edge.successor_id,
      from_anchor: edge.from_anchor,
      to_anchor: edge.to_anchor,
      ...(edge.lag_wd !== undefined ? { lag_wd: edge.lag_wd } : {}),
    },
  }));

  // ── Link removes: resolve each named pair to a live link id, drop the unmatched ─
  const liveById = new Map<string, string>();
  for (const l of liveLinks) {
    liveById.set(linkKey(l.predecessor_id, l.successor_id, l.from_anchor, l.to_anchor), l.id);
  }
  const linkRemoves: DeleteLinkRequest[] = [];
  for (const rm of diff.linkRemoves) {
    const id = liveById.get(linkKey(rm.predecessorId, rm.successorId, rm.fromAnchor, rm.toAnchor));
    if (!id) continue; // already gone (cascade or prior remove) — nothing to delete
    linkRemoves.push({ linkId: id });
  }

  return {
    scheduleApply,
    patches,
    linkAdds,
    linkRemoves,
    idByKey: diff.idByKey,
    movedKeys: diff.movedKeys,
  };
}

/** True when a plan carries no write of any kind — the debounce fired but nothing
 *  changed. The caller skips every round-trip. */
export function isEmptyPlan(plan: PlanEditPlan): boolean {
  return (
    plan.scheduleApply === null &&
    plan.patches.length === 0 &&
    plan.linkAdds.length === 0 &&
    plan.linkRemoves.length === 0
  );
}
