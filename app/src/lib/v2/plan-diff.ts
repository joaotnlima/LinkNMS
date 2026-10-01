// The plan grid's v2 INCREMENTAL-EDIT seam — a pure `prev → next` tree diff that
// turns one debounced editor save of an ALREADY-AUTHORED v2 plan into the minimal
// set of v2 write operations (LINA-320, S3 of the UI cutover, doc 22 §3). This is
// the fourth and final pure brick of the plan cutover, the sibling of
// `plan-apply.ts` (which handles the OTHER half — the first author of an EMPTY
// plan as one `create_rows` batch). It runs under `node --test` with no session,
// exactly like the read/write/hydration seams.
//
// ── WHY A DIFF AND NOT A REPLACE (doc 05 §7 vs the v1 authoring contract) ──────
// v1's write is a WHOLE-TREE REPLACE: every debounced save re-POSTs the entire
// `{ stages }` tree to `…/plan-versions:author`, which mints a fresh draft and
// replaces the previous one in place. v2 has NO plan-version rows and NO draft to
// replace — the plan IS a live WBS, and re-sending every row as `create_rows`
// would DUPLICATE the plan on every keystroke-pause. So editing an existing v2
// plan is a DIFF against the last-saved tree, emitting only what changed:
//
//   • a NEW subtree (a row the author just added, and its descendants) → one
//     `create_rows` op, client-minted ids, pre-order so parents precede children;
//   • a REMOVED subtree (a row the author deleted) → one `delete_subtree` op on
//     its topmost removed row (the server cascades to descendants + links);
//   • a CHANGED field on an existing row (name, dates, specialty, description) →
//     one `updateTask` PATCH carrying only the changed fields;
//   • a CHANGED dependency edge on an existing successor → a `createLink` for an
//     added edge, a `deleteLink` for a removed one.
//
// Each maps to a DISTINCT v2 endpoint (`schedule:apply`, `PATCH /tasks/{id}`,
// `POST /tasks/{id}/links`, `DELETE /links/{id}`), so the caller (`planning.ts`,
// the write increment) orchestrates them; this brick only computes WHAT to send.
//
// ── IDENTITY: THE EDITOR KEY IS THE v2 ROW ID (planning-hydrate.ts) ────────────
// The hydration seam sets every hydrated row's `key` to its stable v2 id (v2 ids
// never re-mint, doc 05). So a node whose key is present in `prev` is an EXISTING
// row we can target by id; a node whose key is ABSENT from `prev` is one the
// author added this session (its key is a local `newKey()` mint, never a v2 id).
// That single rule classifies every node as create / update / (unchanged), and
// every `prev` key absent from `next` as a delete — no UUID-format sniffing.
//
// ── WHAT THIS BRICK DELIBERATELY DOES NOT EMIT (the documented deferral) ───────
// REORDER and REPARENT are NOT emitted here. A `move_subtree` op needs the
// target's `after_position` — a fractional-index position key the server owns
// (`domain/position.mjs`) and which the read seam (`planning-view.ts`) does NOT
// project onto `StageRow`, so the editor draft never holds it. Emitting a move
// without it would drop the row to the end of its siblings, silently reordering
// the plan — unacceptable on the audit surface. So a structural move is DETECTED
// and REPORTED in `movedKeys` (never silently dropped, never half-emitted); the
// caller guards on it (e.g. a reload after a reparent) until the read seam
// projects positions and a `move_subtree` sub-brick lands. See the S3 write-cut
// notes in `planning-hydrate.ts`. Assignment is likewise NOT diffed — v2 inherits
// it from the branch contract (D-33), the same call `plan-apply.ts` documents.

import type { AuthoredNode } from '@/lib/plan-authoring';
import type {
  V2CreateRowSpec,
  V2CreateRowsOp,
  V2CreateLinkSpec,
  V2LinkAnchor,
} from './plan-apply';
import { toLinkAnchors } from './plan-apply.ts';
import type { GridDependencyType } from './planning-view';

// ── The updateTask + link wire shapes (restated snake_case, exactly as the v2
// endpoints consume — openapi `UpdateTaskRequest` / `CreateLinkRequest`. Restating
// locally means a projection drift shows up as a type error here, not a 400.) ────

/** One field's delta on the wire — the openapi `FieldChange` the `updateTask`
 *  endpoint consumes (`modules/.../use-cases.mjs#applyDelta` reads `change.value`,
 *  never a bare scalar). `base` is the value the client last saw; the server uses
 *  it for last-writer-wins overwrite detection (D-26), reporting — never blocking —
 *  when the live row drifted from `base` since the editor loaded it. A flat scalar
 *  here is the LINA-404 regression: the server read `undefined.value → null` and
 *  rejected every edit (e.g. `dating_mode: null` → `validation_failed`). */
export interface V2FieldChange<T> {
  value: T;
  base: T;
}

/** The subset of `DELTA_FIELDS` (use-cases.mjs) the editor can change on an
 *  existing row. Dates carry `dating_mode` alongside so an undated→dated edit is
 *  stored as dated rather than inferred. Assignment is inherited, not diffed.
 *  Every field is a `FieldChange` envelope, never a bare value — see above. */
export interface V2TaskChanges {
  name?: V2FieldChange<string>;
  description?: V2FieldChange<string | null>;
  specialty?: V2FieldChange<string | null>;
  dating_mode?: V2FieldChange<'dated' | 'undated'>;
  start?: V2FieldChange<string | null>;
  finish?: V2FieldChange<string | null>;
}

/** One `PATCH /api/v2/tasks/{taskId}` — the changed fields on an existing row. */
export interface V2TaskUpdate {
  taskId: string;
  changes: V2TaskChanges;
}

/** One parent whose children must be reordered to an ABSOLUTE target order — the
 *  editor's drag-reorder saved through the v2 `reorder_children` op (LINA-404).
 *  `parentKey` is null at the top level (phases). `orderedChildIds` lists EVERY
 *  child of that parent in the target order, already RESOLVED to v2 ids — an
 *  existing child's key IS its v2 id; a child created THIS save is its minted id —
 *  so the server sees real ids by the time the reorder op runs (it rides the same
 *  batch, after `create_rows`). Emitted only when the target order differs from the
 *  order the plan would otherwise have — a create appends to the end, so inserting
 *  a row mid-list reorders too. */
export interface V2ReorderChildren {
  parentKey: string | null;
  orderedChildIds: string[];
}

/** One edge removed from an existing successor — the caller resolves it to a
 *  link id (`DELETE /links/{id}`) from the plan's live links; we name the pair so
 *  the resolution is unambiguous and the anchors let it distinguish typed edges. */
export interface V2LinkRemoval {
  predecessorId: string;
  successorId: string;
  fromAnchor: V2LinkAnchor;
  toAnchor: V2LinkAnchor;
}

/**
 * The minimal write set for one save of an existing plan. Every list is empty
 * when nothing of that kind changed, so a no-op save (the common debounce that
 * fires after a selection, not an edit) yields an all-empty diff the caller skips
 * entirely. `movedKeys` is the honest escape hatch: a reparent/reorder the caller
 * must handle out-of-band (see the deferral note above), never a silent drop.
 */
export interface PlanDiff {
  /** New subtrees as one `create_rows` op (rows pre-order, links among the batch),
   *  or null when nothing was added. Shape-identical to `plan-apply.ts`'s batch op
   *  so the caller sends both through the same `schedule:apply` path. */
  createOp: V2CreateRowsOp | null;
  /** Topmost removed rows → `delete_subtree` (the server cascades descendants). */
  deletes: string[];
  /** Field patches on existing rows. */
  updates: V2TaskUpdate[];
  /** Edges added on an EXISTING successor (a new row's edges ride `createOp`). */
  linkAdds: V2CreateLinkSpec[];
  /** Edges removed from an EXISTING successor. */
  linkRemoves: V2LinkRemoval[];
  /** Parents whose child order changed → one `reorder_children` op each. */
  reorders: V2ReorderChildren[];
  /** New local key → minted v2 id, for the created rows (the LINA-307 refresh). */
  idByKey: Record<string, string>;
  /** Existing rows whose PARENT changed between prev and next — reported, not
   *  emitted (the caller guards; see the deferral note). Empty in the common case. */
  movedKeys: string[];
}

/** A `DepType`-tagged edge as `AuthoredNode.dependsOn` carries it. */
type AuthoredDep = { key: string; type: GridDependencyType };

const dateOrUndef = (v: string | null | undefined): string | null | undefined =>
  v == null ? undefined : v;

/** A flat index of a tree by node key, plus each node's parent key (null at the
 *  top level). Pre-order so callers that iterate it see parents before children. */
interface FlatNode {
  node: AuthoredNode;
  parentKey: string | null;
}

function flatten(nodes: AuthoredNode[]): Map<string, FlatNode> {
  const out = new Map<string, FlatNode>();
  const walk = (node: AuthoredNode, parentKey: string | null): void => {
    out.set(node.key, { node, parentKey });
    for (const child of node.children ?? []) walk(child, node.key);
  };
  for (const root of nodes) walk(root, null);
  return out;
}

/** The row spec for a newly-added node. Mirrors `plan-apply.ts#authoredToCreateBatch`
 *  field-for-field so a row created via the diff is byte-identical to one created
 *  in the first-author batch. */
function createSpec(node: AuthoredNode, parentId: string | null): V2CreateRowSpec {
  const start = dateOrUndef(node.plannedStartDate);
  const finish = dateOrUndef(node.plannedEndDate);
  const spec: V2CreateRowSpec = {
    id: '', // filled by the caller-injected minter in buildCreateOp
    parent_id: parentId,
    name: node.name,
    dating_mode: start ? 'dated' : 'undated',
  };
  if (node.trade) spec.specialty = node.trade;
  if (node.description) spec.description = node.description;
  if (start !== undefined) spec.start = start;
  if (finish !== undefined) spec.finish = finish;
  return spec;
}

/** The field changes between an existing row's prev and next state — only the
 *  fields that actually differ, so `updateTask` never rejects an empty `changes`
 *  and the ledger records the real edit, not the whole row. Dates carry
 *  `dating_mode` when the date presence flips (undated↔dated), matching the
 *  create seam so the round-trip is honest. */
export function diffFields(prev: AuthoredNode, next: AuthoredNode): V2TaskChanges | null {
  const changes: V2TaskChanges = {};

  if (prev.name !== next.name) changes.name = { value: next.name, base: prev.name };

  const prevDesc = prev.description ?? null;
  const nextDesc = next.description ?? null;
  if (prevDesc !== nextDesc) changes.description = { value: nextDesc, base: prevDesc };

  const prevTrade = prev.trade ?? null;
  const nextTrade = next.trade ?? null;
  if (prevTrade !== nextTrade) changes.specialty = { value: nextTrade, base: prevTrade };

  const prevStart = prev.plannedStartDate ?? null;
  const nextStart = next.plannedStartDate ?? null;
  const prevFinish = prev.plannedEndDate ?? null;
  const nextFinish = next.plannedEndDate ?? null;
  if (prevStart !== nextStart) changes.start = { value: nextStart, base: prevStart };
  if (prevFinish !== nextFinish) changes.finish = { value: nextFinish, base: prevFinish };
  // The date's PRESENCE flipped → the row's dating mode changed with it. Send it
  // explicitly so an undated→dated edit is stored dated (and the reverse undated),
  // never inferred from a null the server might read either way. `base` mirrors the
  // prior presence so the server's overwrite check sees no drift on a clean edit.
  if ((prevStart === null) !== (nextStart === null)) {
    changes.dating_mode = {
      value: nextStart === null ? 'undated' : 'dated',
      base: prevStart === null ? 'undated' : 'dated',
    };
  }

  return Object.keys(changes).length ? changes : null;
}

/** The typed edges of a node as a comparable set of `predKey|type` strings. */
function edgeKeys(deps: AuthoredDep[]): Set<string> {
  return new Set(deps.map((d) => `${d.key}|${d.type}`));
}

/**
 * Diff the LAST-SAVED authored tree (`prev`) against the tree the editor is
 * saving now (`next`), both keyed the way `planning-hydrate.ts` keys them (row key
 * = v2 id for existing rows, a local mint for new ones). Returns the minimal set
 * of v2 write operations — see `PlanDiff`. Pure and deterministic: `mintId` is
 * injected (the I/O caller passes `crypto.randomUUID`, a test passes a counter).
 *
 * The classification, per node key:
 *  • in `next` only  → CREATE (a subtree the author added this session);
 *  • in `prev` only  → DELETE (a subtree the author removed);
 *  • in both, parent unchanged → UPDATE its changed fields + diff its edges;
 *  • in both, parent changed    → a MOVE, reported in `movedKeys`, not emitted.
 *
 * A CREATE that sits under an existing parent names that parent's v2 id; a CREATE
 * under another new row names the parent's freshly-minted id, so a whole new
 * subtree is one internally-consistent `create_rows` op. A DELETE is emitted only
 * for the TOPMOST removed row of a removed subtree — the server cascades, and
 * emitting a descendant too would be a double-delete. Edge diffs are computed
 * ONLY for existing successors (a new row's edges already ride `createOp`), and an
 * edge whose predecessor is not a row in `next` is dropped, never sent dangling.
 */
export function diffPlanTrees(
  prev: AuthoredNode[],
  next: AuthoredNode[],
  mintId: () => string,
): PlanDiff {
  const prevFlat = flatten(prev);
  const nextFlat = flatten(next);
  const nextKeys = new Set(nextFlat.keys());

  // ── CREATES: new nodes, pre-order (a Map preserves insertion = pre-order). Mint
  // ids first so a child under a new parent can name the parent's minted id. ─────
  const idByKey = new Map<string, string>();
  for (const [key, { node }] of nextFlat) {
    if (!prevFlat.has(key)) idByKey.set(key, mintId());
  }

  const createRows: V2CreateRowSpec[] = [];
  const createLinks: V2CreateLinkSpec[] = [];
  for (const [key, { node, parentKey }] of nextFlat) {
    if (prevFlat.has(key)) continue; // existing row — not a create
    const mintedId = idByKey.get(key)!;
    // The parent's id: a new parent's minted id, else the existing parent's v2 id
    // (its key IS its id), null at the top level.
    const parentId = parentKey === null ? null : (idByKey.get(parentKey) ?? parentKey);
    const spec = createSpec(node, parentId);
    spec.id = mintedId;
    createRows.push(spec);
    // A new row's typed edges ride the create batch. An edge to a row not in
    // `next` cannot be drawn — dropped, not guessed (same as the create seam).
    for (const dep of node.dependsOn as AuthoredDep[]) {
      if (!nextKeys.has(dep.key)) continue;
      const predecessorId = idByKey.get(dep.key) ?? dep.key; // new pred → minted, else its v2 id
      createLinks.push({
        predecessor_id: predecessorId,
        successor_id: mintedId,
        ...toLinkAnchors(dep.type),
      });
    }
  }

  // ── DELETES: prev subtree roots absent from next. Emit only the TOPMOST removed
  // row — if a node's parent is also removed, the parent's delete_subtree covers
  // it (and a top-level removed node has a null/absent parent). ──────────────────
  const removedKeys = new Set<string>();
  for (const key of prevFlat.keys()) {
    if (!nextKeys.has(key)) removedKeys.add(key);
  }
  const deletes: string[] = [];
  for (const key of removedKeys) {
    const parentKey = prevFlat.get(key)!.parentKey;
    if (parentKey !== null && removedKeys.has(parentKey)) continue; // covered by ancestor's delete
    deletes.push(key); // key === v2 id for an existing row
  }

  // ── UPDATES + MOVES + EDGE DIFFS: nodes present in both trees. ─────────────────
  const updates: V2TaskUpdate[] = [];
  const linkAdds: V2CreateLinkSpec[] = [];
  const linkRemoves: V2LinkRemoval[] = [];
  const movedKeys: string[] = [];

  for (const [key, { node: nextNode, parentKey: nextParent }] of nextFlat) {
    const prevEntry = prevFlat.get(key);
    if (!prevEntry) continue; // a create — handled above
    const { node: prevNode, parentKey: prevParent } = prevEntry;

    // A reparent is reported, not emitted (needs a position key the read seam does
    // not project). The caller guards on `movedKeys`; we still diff the row's
    // FIELDS below, so a rename-and-reparent in one save keeps the rename.
    if (prevParent !== nextParent) movedKeys.push(key);

    const changes = diffFields(prevNode, nextNode);
    if (changes) updates.push({ taskId: key, changes });

    // Edge diff for this EXISTING successor: adds are edges now present that were
    // not, removes the reverse. An added edge to a row not in `next` is dropped.
    const prevEdges = edgeKeys(prevNode.dependsOn as AuthoredDep[]);
    const nextEdges = nextNode.dependsOn as AuthoredDep[];
    const nextEdgeSet = edgeKeys(nextEdges);
    for (const dep of nextEdges) {
      const tag = `${dep.key}|${dep.type}`;
      if (prevEdges.has(tag)) continue; // unchanged
      if (!nextKeys.has(dep.key)) continue; // predecessor gone — cannot draw
      const predecessorId = idByKey.get(dep.key) ?? dep.key;
      linkAdds.push({ predecessor_id: predecessorId, successor_id: key, ...toLinkAnchors(dep.type) });
    }
    for (const dep of prevNode.dependsOn as AuthoredDep[]) {
      const tag = `${dep.key}|${dep.type}`;
      if (nextEdgeSet.has(tag)) continue; // still present
      const anchors = toLinkAnchors(dep.type);
      linkRemoves.push({
        predecessorId: dep.key,
        successorId: key,
        fromAnchor: anchors.from_anchor,
        toAnchor: anchors.to_anchor,
      });
    }
  }

  // ── REORDERS: a parent whose child order changed → one absolute reorder op. The
  // editor represents order by array position (no position key in the draft), so we
  // compare the TARGET child order against the order the plan would otherwise have:
  // existing children keep their prev order, a newly-created child is appended
  // (create_rows adds it at the end). When they differ — a drag, or a row inserted
  // mid-list — emit the whole sibling set in target order, resolved to v2 ids. A
  // pure create at the end, or an all-new parent (its create order is already the
  // target), emits nothing. See V2ReorderChildren. ───────────────────────────────
  const resolve = (key: string): string => idByKey.get(key) ?? key;
  const nextChildrenOf = new Map<string | null, string[]>();
  for (const [key, { parentKey }] of nextFlat) {
    const arr = nextChildrenOf.get(parentKey) ?? [];
    arr.push(key);
    nextChildrenOf.set(parentKey, arr);
  }
  const prevChildrenOf = new Map<string | null, string[]>();
  for (const [key, { parentKey }] of prevFlat) {
    const arr = prevChildrenOf.get(parentKey) ?? [];
    arr.push(key);
    prevChildrenOf.set(parentKey, arr);
  }
  const reorders: V2ReorderChildren[] = [];
  for (const [parentKey, childKeys] of nextChildrenOf) {
    if (childKeys.length < 2) continue; // nothing to order
    const targetIds = childKeys.map(resolve);
    // Natural order absent a reorder: existing children of THIS parent (still under
    // it in next — a deleted or reparented-away row drops out) in their prev order,
    // then the rows this save created under it, in create (next) order.
    const stillUnderParent = (prevChildrenOf.get(parentKey) ?? [])
      .filter((k) => nextFlat.get(k)?.parentKey === parentKey);
    const createdHere = childKeys.filter((k) => !prevFlat.has(k));
    const naturalIds = [...stillUnderParent, ...createdHere].map(resolve);
    const same = targetIds.length === naturalIds.length
      && targetIds.every((id, i) => id === naturalIds[i]);
    if (!same) reorders.push({ parentKey, orderedChildIds: targetIds });
  }

  const createOp: V2CreateRowsOp | null = createRows.length
    ? { op: 'create_rows', rows: createRows, links: createLinks }
    : null;

  return {
    createOp,
    deletes,
    updates,
    linkAdds,
    linkRemoves,
    reorders,
    idByKey: Object.fromEntries(idByKey),
    movedKeys,
  };
}

/** True when a diff carries no write of any kind — the debounce fired but nothing
 *  changed (a selection, a focus). The caller skips the round-trip entirely. */
export function isEmptyDiff(diff: PlanDiff): boolean {
  return (
    diff.createOp === null &&
    diff.deletes.length === 0 &&
    diff.updates.length === 0 &&
    diff.linkAdds.length === 0 &&
    diff.linkRemoves.length === 0 &&
    diff.reorders.length === 0 &&
    diff.movedKeys.length === 0
  );
}
