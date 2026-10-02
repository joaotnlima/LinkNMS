// The plan grid's v2 HYDRATION seam — pure `PlanGridView` → editor-draft transform
// (LINA-320, S3 of the UI cutover, doc 22 §3). This is the third and final pure
// brick of the plan cutover, sitting between the read adapter (`planning-view.ts`,
// which turns the flat v2 WBS into the grid's nested `StageRow` tree) and the
// authoring editor (`PlanBuildEditor`/`PlanGrid`, which render the 3-level
// `PhaseDraft[]` model from `plan-authoring.ts`). It runs under `node --test`
// with no session, exactly like its two siblings.
//
// ── WHY A SECOND CONVERTER, NOT `hydrateDraft` ────────────────────────────────
// v1's `hydrateDraft` reads a `DraftStageNode` tree — the *v1 plan-version*
// shape (`plannedStartDate`/`plannedEndDate`, an embedded `dependencies[]`, a
// server stage id distinct from its key). The v2 read seam already collapsed the
// live WBS to `StageRow` (`start`/`finish` → `start`/`end`, org-as-party, id IS
// the key because v2 ids are stable, doc 05) and lifted the typed links OUT of
// the tree into `dependenciesBySuccessor`. Feeding that back through the v1 reader
// would mean re-inventing the v1 shape only to re-flatten it. So this converter
// maps `StageRow` → `PhaseDraft` directly, and makes three deliberate calls:
//
//  1. DEPTH-3 CAP, SAME AS v1. The editor renders exactly phase → task → subtask
//     (LINA-238/243, `too_deep` past depth 2). A v2 WBS can nest deeper; anything
//     below a subtask is DROPPED here rather than carried into a save the server
//     would refuse — the identical tolerance `hydrateDraft` applies below a
//     subtask.
//
//  2. LINKS RE-ATTACH BY SUCCESSOR ID = KEY. `dependenciesBySuccessor` is keyed
//     by the successor row id, which is the row's editor key (v2 ids are stable,
//     so id IS key — `planning-view.ts#toStageRows`). Each edge's `on` is a
//     predecessor id, already the predecessor's key. An edge whose predecessor
//     is not a row we RENDER (dropped past depth 3, or absent) is dropped, not
//     drawn dangling — the same discipline `toWire`/`hydrateDraft` apply.
//
//  3. REPORTED STATUS ROUND-TRIPS (LINA-404). The grid's child-count meter reads
//     `TaskDraft.status`; a row with no `status` counts as `not_started` (all-grey).
//     A row's REPORTED progress is carried whenever the server holds one — draft or
//     baselined. This used to be gated on `isBaselined` (v2's honest-meter switch),
//     which dropped a status the owner reported on their draft on the very next read
//     ("status not recorded", the founder's reopen). Carrying it always keeps the
//     meter honest-by-default — a never-reported row is still `not_started`/grey, so
//     an untouched plan reads all-grey exactly as before (ADR-0019) — while a row the
//     owner actually moved now survives a reload.
//
// ── WHAT THIS SEAM DELIBERATELY DOES NOT DO (the increment-4 write contract) ───
// This is READ hydration only — it seeds the editor so a v2 plan RENDERS in the
// existing grid/Gantt without a UX change. Cutting the editor's WRITES to v2 is a
// separate, larger increment (the page cutover, architect-owned), because the two
// write models differ structurally, not cosmetically:
//
//   • v1 SAVE = autosave a private DRAFT version (`POST …/plan-versions:author`,
//     whole-tree replace, one `plan_drafted` ledger event per debounced edit),
//     then an explicit "Send for approval" → propose → accept → freeze baseline.
//   • v2 SAVE = an OP BATCH on a LIVE WBS (`POST …/schedule:apply`). There is no
//     private draft and no version negotiation. The FIRST author of an empty plan
//     is one `create_rows` batch — already built and tested in `plan-apply.ts` /
//     `planning.ts#applyPlanDraft`. EDITING an existing plan is an incremental op
//     diff (`create_rows`/`move_subtree`/`indent`/`outdent`/`delete_subtree`/
//     `updateTask`), which changes the editor's autosave interaction model itself.
//     The baseline/sign-off half is S6 (LINA-323), on its own backend.
//
// Because the read and write cannot be half-cut on the product's most central
// surface (a v2 read wired under a v1 autosave would silently write v1 rows the
// v2 read never shows), the page cutover lands read+write together in that
// increment. This seam is the last piece it needs before it can.

import type { PlanGridView, StageRow } from './planning-view';
import type { DepEdge, PhaseDraft, TaskDraft } from '@/lib/plan-authoring';

/**
 * The set of row keys the editor will actually RENDER — every row down to the
 * subtask level (depth 2), phases included. A dependency whose predecessor is not
 * in this set cannot be drawn, so it is dropped rather than left dangling.
 */
function renderedKeys(rows: StageRow[]): Set<string> {
  const keys = new Set<string>();
  const walk = (row: StageRow, depth: number): void => {
    keys.add(row.id);
    if (depth >= 2) return; // subtask is the deepest rendered row
    for (const child of row.children) walk(child, depth + 1);
  };
  for (const row of rows) walk(row, 0);
  return keys;
}

/**
 * The typed predecessor edges for one successor row, mapped to the editor's
 * `DepEdge[]`. `dependenciesBySuccessor` is already the grid's typed vocabulary
 * (`GridDependencyType` ≡ `DepType`), so `{ on, type }` is a `DepEdge` verbatim —
 * we only DROP edges whose predecessor is not a rendered row (a dep that points
 * past the depth-3 cap or at an absent row), never guess one.
 */
function depsFor(
  successorId: string,
  bySuccessor: PlanGridView['dependenciesBySuccessor'],
  rendered: Set<string>,
): DepEdge[] {
  const edges = bySuccessor[successorId];
  if (!edges) return [];
  const out: DepEdge[] = [];
  for (const edge of edges) {
    if (!rendered.has(edge.on)) continue; // predecessor not rendered — cannot draw, dropped
    out.push({ on: edge.on, type: edge.type });
  }
  return out;
}

/**
 * One `StageRow` → one `TaskDraft`, at task (deep) or subtask level. The row id is
 * the editor key (v2 ids are stable — `planning-view.ts`). `trade`/`start`/`end`
 * normalise `null` to the empty string the editor uses for "not set".
 *
 * `status` is the row's REPORTED progress, carried whenever the server holds one —
 * on a draft plan as well as a baselined one (LINA-404). It USED to be gated on
 * `isBaselined`, so a status the owner reported on their draft was silently dropped
 * on the next read ("status not recorded" — the founder reopened on exactly this).
 * Carrying it always is still honest-by-default: a never-reported row comes back
 * `not_started`, which the meter already counts as grey (ADR-0019's "all-grey on an
 * untouched plan" holds), while a row the owner actually moved now survives a
 * reload. A `StageRow` carries no description (the read seam does not project it),
 * so the editor's description opens empty until the write increment round-trips it.
 */
function toTaskDraft(
  row: StageRow,
  deep: boolean,
  bySuccessor: PlanGridView['dependenciesBySuccessor'],
  rendered: Set<string>,
): TaskDraft {
  return {
    key: row.id,
    name: row.name,
    start: row.start ?? '',
    end: row.end ?? '',
    description: '',
    dependsOn: depsFor(row.id, bySuccessor, rendered),
    assigneePartyId: row.assigneePartyId,
    trade: row.trade ?? '',
    // Carry a MEANINGFUL reported status (draft or baselined) so a progress report
    // the owner made survives a page reload (LINA-404). `not_started` is the default
    // and stays un-carried, so an untouched plan is status-less and reads all-grey
    // exactly as before (ADR-0019) — `nodeStatus` reports a missing status as
    // not_started regardless, so nothing is lost by omitting it.
    ...(row.status && row.status !== 'not_started' ? { status: row.status } : {}),
    // Subtasks are the depth cap — a task's children hydrate, a subtask's are
    // dropped (the editor has no row for them, and a save would be `too_deep`).
    children: deep ? row.children.map((s) => toTaskDraft(s, false, bySuccessor, rendered)) : [],
  };
}

/**
 * A v2 plan grid view → the editor's `PhaseDraft[]`. Top-level rows become
 * phases; their children become tasks; grandchildren become subtasks; anything
 * deeper is dropped at the depth-3 cap. Typed links re-attach per successor from
 * `dependenciesBySuccessor`, dropping any edge to an un-rendered predecessor. The
 * status meter is carried only when the plan is baselined (honest all-grey on a
 * draft, ADR-0019). Pure — no I/O, no session; the page's read (`getPlanGrid`)
 * supplies the view and the fail-closed empty state.
 */
export function planGridToDraft(view: PlanGridView): PhaseDraft[] {
  const rendered = renderedKeys(view.rows);
  return view.rows.map((phase) => ({
    key: phase.id,
    name: phase.name,
    dependsOn: depsFor(phase.id, view.dependenciesBySuccessor, rendered),
    assigneePartyId: phase.assigneePartyId,
    trade: phase.trade ?? '',
    tasks: phase.children.map((t) => toTaskDraft(t, true, view.dependenciesBySuccessor, rendered)),
  }));
}
