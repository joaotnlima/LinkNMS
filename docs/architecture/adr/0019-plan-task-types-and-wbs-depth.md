# ADR-0019 — Plan task types and 3rd-level WBS

- Status: Proposed (design + tamper-evidence review; migration greenlight pending)
- Date: 2026-09-10
- Deciders: Full-Stack Architect (owner), Chief of Staff / founder (greenlight)
- Issue: LINA-238 "Plan authoring — milestone/bug task types + 3rd-level WBS"
- Parent: LINA-229 (richer Gantt planner, post-MVP, blocked — "gate on real
  product demand"); item deferred in ADR-0017 §5, line 120.
- Anchors: ADR-0017 (direct plan authoring), ADR-0018 (plan templates),
  ADR-0002 §4/§5 (tamper-evidence ledger), ADR-0005 (schedule/progress model).

## Context

LINA-238 asks for two additions to the plan/WBS model, both explicitly deferred
by ADR-0017 §5 as post-MVP:

1. **`task_type`** — mark a stage as a `milestone` or `bug` (defect / punch-list
   item) in addition to a normal work task.
2. **A 3rd WBS level** — the model is two-level today (Action → Sub-action).

The issue also names a specific deliverable: *"tamper-evidence review of the WBS
shape."* Because both touch `schedule.stage`, which is the projection the plan
ledger events anchor, that review is the gating concern and is done first here.

## Current model (as-built, verified 2026-09-10)

- `schedule.stage` carries WBS hierarchy as a **self-referential FK**
  `parent_id uuid REFERENCES schedule.stage(id)` (migration `0002`). NULL =
  root Action; a set value = child. There is **no `level` column and no dotted
  code** — depth is implicit. The FK **already permits arbitrary depth**; the
  two-level cap lives only in application code.
- Depth cap enforced in `validateAuthoredStages` (`plan-version.mjs:792`):
  `if (depth >= 1 && children.length > 0) throw too_deep`. The import parser
  (Slice B1 §6) and the ADR-0018 template validator enforce the same rule.
- Stage enums today: `stage_progress.status` (DB CHECK, derived — there is no
  `stage.status` column); `plan_version.status` (DB CHECK + TS union).
  `stage.trade` is **free-form text, not an enum**.
- Ordering: `position` (mutable) tie-broken by identity `seq`.

## Tamper-evidence review of the WBS shape

**Finding — stage *content* is not, and never has been, in the hashed ledger
payload.** Every plan lifecycle event (`plan_drafted`, `plan_proposed`,
`plan_accepted`, `plan_import`) hashes a payload that carries only
`{ planVersionId, sourceImportId, stageCount }` — a count, not the rows
(`plan-version.mjs:616-620, 418-426, 703-711`). Stage integrity is therefore
**not** provided by a per-row content hash. It is provided by three
depth-agnostic, content-agnostic mechanisms:

1. **The hash chain** anchors *that a plan write of N stages happened, by whom,
   at time T, for version V* — one event per write, in the same transaction as
   the stage projection.
2. **The version freeze** — once a version is accepted/terminal, the
   `stage_freeze_guard` (INSERT/UPDATE, `0003`) and `stage_freeze_delete_guard`
   (DELETE, `0005`) triggers make its stage rows immutable at the DB. This is
   what protects a baseline's content, per-row.
3. **Append-only discipline + grants** — a draft's stages are the drafter's
   private, replaceable workspace (deliberate, ADR-0017); only a draft version's
   rows are deletable.

**Conclusion — neither change weakens tamper-evidence:**

- **3rd WBS level:** the hash chain and both freeze guards are scoped by
  `plan_version`, not by tree depth. A deeper tree changes nothing about how
  events anchor or how a frozen version is protected. `stageCount = order.length`
  already counts every node at every level, so it stays accurate. **No new
  tamper-evidence surface.** (This is a validation relaxation, not a DDL change —
  the `parent_id` FK already allows it.)

- **`task_type`:** it is stage content, and lands on **exactly the same
  tamper-evidence footing as the existing content columns** — `trade`,
  `planned_cost_cents`, dates. Like them, it is *not* in the draft/propose hash,
  and *is* frozen per-row by the version freeze guard once baselined (it is a
  `schedule.stage` column, so the guards cover it for free). No regression.

**One invariant to preserve (budget attribution):** ADR-0002's promise is *"how
much did it move the budget."* A `milestone` or `bug` node must not silently
carry planned cost that is double-counted against work tasks. Decision below.

**One guardrail to keep:** the self-ref FK permits *unbounded* depth. The cap
must stay — just move from 2 to 3. Unbounded nesting is an abuse/perf footgun.

## Decision (pending greenlight)

1. **`task_type`** — add `task_type text NOT NULL DEFAULT 'task'` to
   `schedule.stage` in **new forward migration `services/schedule/migrations/0006`**
   with `CHECK (task_type IN ('task','milestone','bug'))`. Mirror as a TS union
   on `PlanStageNode` / `StageRow` (`app/src/lib/plan-baseline.ts`). Thread
   through `pg-store.mjs` `insertStage`/`mapStage`, `insertAuthoredStages`
   (`plan-version.mjs`), and `validateAuthoredStages`. Default preserves every
   existing row and the current API shape (additive, back-compatible).
2. **Cost semantics** — a `milestone` is zero-cost by definition; reject a
   non-null/non-zero `planned_cost_cents` on a `milestone` in
   `validateAuthoredStages` (DB CHECK optional, app-level is enough for V1). A
   `bug` may carry cost (a defect fix has a price). Keeps budget attribution
   honest with no double count.
3. **3rd WBS level** — relax the cap from `depth >= 1` to `depth >= 2` in
   `validateAuthoredStages`, and apply the identical relaxation to the ADR-0018
   template validator and the B1 import parser so all three writers agree. No
   DDL. Keep the cap at 3 — do not allow deeper.
4. **No migration is applied until the founder greenlights this slice in words**
   (see LINA-238 confirmation). The migration is forward-only and guarded by the
   prod byte-checksum gate; it is not casually reversible.

## Consequences

- Additive and back-compatible: default `'task'`, no backfill, existing plans
  and the flat `getPlan` projection are unaffected.
- `task_type` is a product/UX question as much as a schema one — whether a
  construction WBS wants a "bug" type at all, and how milestone/bug render on the
  Gantt, needs design sign-off. This is captured in the greenlight ask, not
  assumed.
- Deeper trees increase `getPlan` fan-out slightly; negligible at plan sizes.
- Tech debt unchanged: stage content still relies on the freeze guard rather
  than a content hash — a deliberate, pre-existing choice (ADR-0002/0005), not
  introduced here.
