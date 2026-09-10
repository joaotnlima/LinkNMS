# ADR-0019 — Task-detail drawer: a per-stage description, and status stays derived

- **Status:** Accepted
- **Date:** 2026-09-10
- **Issue:** LINA-234 (parent LINA-229 "richer Gantt planner" §5; annexes ADR-0017)
- **Owner:** Full-Stack Architect
- **Supersedes / amends:** none. Re-affirms the status-is-derived invariant of
  ADR-0005 / migration 0001.

## Context

LINA-228 shipped direct plan authoring: a two-level WBS (phases → tasks) built in
the browser and saved as a private draft. LINA-229 tracks the fuller planner the
pen frame promises; its §5 backlog includes a **task-detail drawer (description,
status, sub-tasks, comments)**. LINA-234 is the first, foundational slice of that
drawer: a place to read and edit a task's **description**, and to see its
**status**.

The ticket phrased this as *"per-stage description + status store (add columns to
`schedule.stage`)"*. Taken literally that is two columns. One of them is a trap.

## Decision

### 1. Add a `description` column; add **no** status column.

`schedule.stage` gains a single mutable `description text` column (migration
0006). It is authoring content — edited in place exactly like `name`, dates, and
`scope_note` — and it is frozen with the plan version by the existing
`stage_freeze_guard` (0003) once a plan is accepted. It rides the plan-authoring
write with no new grant (`schedule_app` already holds INSERT/UPDATE on the table).

**Status does not become a column.** Migration 0001 deliberately kept a stage's
current status *out* of the stage row:

> A stage's CURRENT status is NOT a column. It is DERIVED from the latest row of
> the append-only `stage_progress` history. There is deliberately no mutable
> status column that could disagree with the record.

That is the core promise of this product — *who reported what, when* is answerable
because the status **is** the append-only history, not a mutable field a bug or a
race could desync from it. The service already exposes the derived value:
`schedule.mjs shapeStage` returns `currentStatus` (and, only while `in_progress`,
`currentPercent`). The "status store" the ticket asked for already exists — it is
`stage_progress`. The drawer's job is to **surface** that derived status, not to
duplicate it into a field that could lie.

So the drawer **reads** `currentStatus`; it never writes a stage-level status.

### 2. What the drawer shows in the *authoring* context.

This slice's drawer lives in the plan-authoring editor (`PlanBuildEditor`), which
edits a **draft**. A draft has no `stage_progress` rows — nobody reports progress
on a plan that has not been agreed — so a draft stage's derived status is, always,
`not_started`. The authoring drawer therefore:

- **edits** the task's `description` (a textarea; client-side draft state, saved
  by the existing `:author` write), and
- **shows** status as a read-only chip — "Not started" — with a one-line note
  that progress is reported once the plan is live.

This is honest: it delivers "description + status" in the drawer as the ticket
asks, without pretending a draft can carry reported progress and without inventing
a writable status. Surfacing the *live* derived status in the drawer on the
post-acceptance `/plan` view is a separate, later slice of LINA-229 (progress
reporting UI), not this one.

### 3. `description` is distinct from `scope_note`.

`scope_note` (0001) stays a separate field: a short, one-line scope summary that
already surfaces in other contexts. `description` is the longer, free-form drawer
body. They are not merged: merging would silently change the meaning of an
existing column and there is no migration-safe rename of an applied column. Two
narrow fields with clear jobs beats one overloaded one.

## Consequences

- **Audit integrity preserved.** No second source of truth for status is
  introduced; the tamper-evident history remains the only status authority.
- **Small, reversible surface.** One nullable column, wired through the existing
  author path, projection, and the two granular stage endpoints for model
  coherence. No new grants, no new tables, no new ledger event type.
- **Drawer is extensible.** Sub-tasks and comments (the other drawer affordances
  in LINA-229 §5) are deliberately out of scope here; the drawer is structured so
  they can be added as their own slices.
- **Tech debt / follow-ups (tracked under LINA-229):** the live-plan drawer that
  shows *reported* status + the progress-report affordance; sub-tasks; per-task
  comments; drag-schedule and dependencies UI.

## Alternatives considered

- **Add a mutable `stage.status` column (the literal ask).** Rejected: it
  re-introduces the exact desync hazard 0001 forbids and would let the stage row
  and the append-only history disagree — a direct hit on the product's core
  guarantee.
- **Reuse `scope_note` as the description.** Rejected: silently repurposes an
  existing field with a different meaning and no clean migration story.
