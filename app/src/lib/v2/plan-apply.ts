// The plan grid's v2 WRITE layer — pure draft→operations transforms (LINA-320,
// S3 of the UI cutover, doc 22 §3). This is the write seam that lets the EXISTING
// authoring editor (which produces the v1 `AuthoredNode[]` tree via
// `plan-authoring.ts#toWire`) commit against the v2 Planning module without a UX
// change. The I/O + fail handling lives in `./planning.ts`; everything here runs
// under `node --test` with no session.
//
// ── WHY THIS IS NOT A FIELD RENAME (doc 05 §7 vs the v1 authoring contract) ────
// v1's write is a WHOLE-TREE REPLACE: `POST …/plan-versions:author` takes the
// entire `{ stages }` tree and mints a fresh, unnumbered private DRAFT — the plan
// is a version that walks draft → proposed → accepted, and re-saving replaces the
// draft in place. v2 has NO plan-version rows. The plan IS a live WBS, and it is
// written by an OPERATION BATCH: `POST /api/v2/projects/{id}/schedule:apply` takes
// `{ operations: [...] }` (op-log: `create_rows` / `move_subtree` / `indent` /
// `outdent` / `delete_subtree`), each op mutating rows in place. So mapping the
// editor's "save the whole draft" gesture onto v2 is structural, and it makes
// these deliberate calls:
//
//  1. FRESH AUTHORING = ONE `create_rows` BATCH. The empty-plan case (a new B2
//     build, LINA-310 — the only case where the editor legitimately owns the
//     whole tree) maps to a single `create_rows` op carrying every row. The
//     CLIENT mints each row's UUID (`buildRow` requires `spec.id`) and a child's
//     `parent_id` names its parent's minted id; the server inserts rows in list
//     order, so parents MUST precede children — we emit a pre-order traversal so
//     they always do. Links ride the same op (the server processes `rows` before
//     `links`, so a link may reference any row in the batch).
//
//  2. EDITING AN EXISTING PLAN IS NOT DONE HERE. Because v2 has no draft to
//     replace, re-authoring a plan that already has rows is a DIFF, not a replace
//     — incremental `create_rows`/`move_subtree`/`delete_subtree`/`updateTask`
//     ops emitted per interaction. That is the editor-wiring increment (it
//     changes the editor's interaction model, not just the wire), and it lives
//     with the page cutover, not in this pure seam. `authoredToCreateBatch`
//     therefore refuses to be used as a replace: the caller only reaches it for
//     the empty-plan authoring path.
//
//  3. ASSIGNMENT INHERITS BY DEFAULT, BUT AN EXPLICIT OWNER IS CARRIED (LINA-404
//     FIX 2). v2 rows inherit the assignee from their branch contract (D-33,
//     `buildRow` defaults `assigneeInherited: true`). When the author sets an
//     explicit owner on a row, the `create_rows` spec carries `assignee_org_id`
//     and the server's `buildRow` stores it under the own-org-or-supplier fence;
//     a row left to inherit sends no assignee field at all.
//
// The link-anchor mapping is the exact inverse of `planning-view.ts#toDependencyType`.

import type { AuthoredNode } from '@/lib/plan-authoring';
import type { GridDependencyType } from './planning-view';

// ── v2 write wire shapes (restated, snake_case exactly as `schedule:apply`
// consumes — openapi `ApplyScheduleRequest`). Restating locally means a
// projection drift shows up as a type error here, not as a 400 on the wire. ─────

export type V2LinkAnchor = 'start' | 'end';

/** One row spec inside a `create_rows` op. `id` is client-minted; `parent_id`
 *  names another row in the SAME batch (or an existing row). */
export interface V2CreateRowSpec {
  id: string;
  parent_id: string | null;
  name: string;
  kind?: 'task' | 'milestone' | 'summary';
  specialty?: string;
  description?: string;
  dating_mode?: 'dated' | 'undated';
  start?: string | null;
  finish?: string | null;
  /** Explicit owner org on a brand-new row (LINA-404 FIX 2); omitted → the row
   *  inherits from its branch (D-33). The server's buildRow honours it under the
   *  own-org-or-supplier fence. */
  assignee_org_id?: string | null;
}

/** One link spec inside a `create_rows` op. Ids reference rows of the batch. */
export interface V2CreateLinkSpec {
  predecessor_id: string;
  successor_id: string;
  from_anchor: V2LinkAnchor;
  to_anchor: V2LinkAnchor;
  lag_wd?: number;
}

export interface V2CreateRowsOp {
  op: 'create_rows';
  rows: V2CreateRowSpec[];
  links: V2CreateLinkSpec[];
}

/** The `schedule:apply` request body for the fresh-authoring batch. */
export interface V2ApplyScheduleRequest {
  operations: V2CreateRowsOp[];
  /** Dedupe key the server anchors idempotency on (a re-POST is a no-op). */
  client_change_id: string;
}

/**
 * The built batch plus the author-local `key → minted row id` map. The map is
 * what lets a follow-up op (a status report, a later edit) target the right row
 * without a page reload — the same key→id refresh v1 returned as
 * `AuthorResult.stageIds` (LINA-307). Distinct from v1: these ids are STABLE
 * (v2 does not re-mint on re-save), so the map is authoritative once created.
 */
export interface PlanCreateBatch {
  request: V2ApplyScheduleRequest;
  idByKey: Record<string, string>;
}

// ── Transforms ────────────────────────────────────────────────────────────────

/**
 * The grid's typed-dependency vocabulary (ADR-0020) → a v2 link's two anchors —
 * the exact inverse of `planning-view.ts#toDependencyType`:
 *  • `starts_after` (finish-to-start, the default sequence) → end → start
 *  • `starts_with`  (both begin together)                   → start → start
 *  • `ends_with`    (both finish together)                  → end → end
 */
export function toLinkAnchors(type: GridDependencyType): { from_anchor: V2LinkAnchor; to_anchor: V2LinkAnchor } {
  switch (type) {
    case 'starts_after': return { from_anchor: 'end', to_anchor: 'start' };
    case 'starts_with': return { from_anchor: 'start', to_anchor: 'start' };
    case 'ends_with': return { from_anchor: 'end', to_anchor: 'end' };
  }
}

/** A `DepType`-tagged edge as `AuthoredNode.dependsOn` carries it. */
type AuthoredDep = { key: string; type: GridDependencyType };

const dateOrUndef = (v: string | null | undefined): string | null | undefined =>
  v == null ? undefined : v;

/**
 * Flatten the validated `AuthoredNode[]` tree (the output of
 * `plan-authoring.ts#toWire`, already name-checked and depth-capped) into a
 * single `create_rows` batch for a FRESH plan.
 *
 * `mintId` is injected so this stays pure and deterministic under test — the I/O
 * caller passes `crypto.randomUUID`, a test passes a counter. Every node gets a
 * minted id keyed by its author-local `key`; a child's `parent_id` is its
 * parent's minted id (null at the top level). The traversal is PRE-ORDER, so a
 * parent is always emitted before its children — the server inserts in list
 * order and rejects a `parent_id` it has not seen yet.
 *
 * Links come from each node's `dependsOn`, mapped to anchor pairs. An edge whose
 * predecessor key is not a node in this batch is DROPPED (it cannot be drawn),
 * never sent to be refused as a dangling reference — the same tolerance
 * `toWire` already applied when it filtered edges to sent rows.
 *
 * `client_change_id` is passed in (minted by the caller) so a retried POST is a
 * proven no-op rather than a second plan.
 */
export function authoredToCreateBatch(
  nodes: AuthoredNode[],
  mintId: () => string,
  clientChangeId: string,
): PlanCreateBatch {
  const rows: V2CreateRowSpec[] = [];
  const idByKey = new Map<string, string>();
  const pendingLinks: Array<{ successorKey: string; deps: AuthoredDep[] }> = [];

  const walk = (node: AuthoredNode, parentId: string | null): void => {
    const id = mintId();
    idByKey.set(node.key, id);
    const start = dateOrUndef(node.plannedStartDate);
    const finish = dateOrUndef(node.plannedEndDate);
    const spec: V2CreateRowSpec = {
      id,
      parent_id: parentId,
      name: node.name,
      // dating_mode is explicit so an undated row is stored undated rather than
      // guessed from a null start (buildRow would otherwise infer it, but saying
      // it keeps the round-trip honest).
      dating_mode: start ? 'dated' : 'undated',
    };
    if (node.trade) spec.specialty = node.trade;
    if (node.description) spec.description = node.description;
    if (start !== undefined) spec.start = start;
    if (finish !== undefined) spec.finish = finish;
    if (node.assigneePartyId) spec.assignee_org_id = node.assigneePartyId;
    rows.push(spec);
    if (node.dependsOn.length) {
      pendingLinks.push({ successorKey: node.key, deps: node.dependsOn as AuthoredDep[] });
    }
    for (const child of node.children ?? []) walk(child, id);
  };

  for (const root of nodes) walk(root, null);

  const links: V2CreateLinkSpec[] = [];
  for (const { successorKey, deps } of pendingLinks) {
    const successorId = idByKey.get(successorKey);
    if (!successorId) continue; // unreachable — every walked node is keyed
    for (const dep of deps) {
      const predecessorId = idByKey.get(dep.key);
      if (!predecessorId) continue; // edge points outside the batch — dropped, not guessed
      links.push({ predecessor_id: predecessorId, successor_id: successorId, ...toLinkAnchors(dep.type) });
    }
  }

  return {
    request: { operations: [{ op: 'create_rows', rows, links }], client_change_id: clientChangeId },
    idByKey: Object.fromEntries(idByKey),
  };
}
