-- Schedule & Progress service — schema `schedule` (Slice 6, LINA-69; ADR-0005,
-- ADR-0006 §1; r0-plan-progress-functional-spec §8).
--
-- The GC owns the construction plan as an ordered list of stages, and reports
-- progress on them. This service owns exactly the `schedule` schema and NEVER
-- writes another service's tables. In particular it holds NO grant on
-- ledger.budget_event: Schedule & Progress can never move the authoritative
-- budget (baseline + Σ approved change orders). A stage's planned cost is
-- free-form and structurally incapable of reaching a budget_event — AC-P5 / AC-P12
-- are enforced by the absence of the grant, not merely by service behaviour.
--
-- Applied by the `migrator` role (Slice 0). The schema is pre-created in
-- db/0001_platform.sql (AUTHORIZATION migrator) with USAGE granted to
-- schedule_app; this migration lands the tables and their per-table grants.
--
-- TRUST DISCIPLINE (spec §8.1): a stage's CURRENT status is NOT a column. It is
-- DERIVED from the latest row of the append-only `stage_progress` history. There
-- is deliberately no mutable status column that could disagree with the record.

CREATE SCHEMA IF NOT EXISTS schedule;

-- ── stage — the GC-owned plan as an ordered stage list (FR-P1) ────────────────
-- Mutable: name / notes / dates / cost / position are edited in place, and stages
-- are reorderable. Stages are NEVER hard-deleted (spec §5) — a mistaken stage is
-- edited, and if a true removal is ever needed it is a ledgered event, not a row
-- drop. There is no DELETE grant below, so that discipline holds in the database.
CREATE TABLE schedule.stage (
  id                 uuid PRIMARY KEY,
  -- Monotonic insertion order across the whole table. `position` is the GC's plan
  -- order and is mutable (reorder); `created_at` is not a total order. Where a
  -- deterministic tie-break is needed (equal positions mid-reorder, equal
  -- timestamps) this gap-free counter provides it. Assigned by the DB.
  seq                bigint GENERATED ALWAYS AS IDENTITY,
  project_id         uuid NOT NULL,
  name               text NOT NULL,
  -- Plan order (FR-P1). The rollup's "current stage" pointer and the timeline read
  -- top-to-bottom by this, never by dates (spec §8.3 R3).
  position           integer NOT NULL,
  scope_note         text,
  -- The GC's planned dates. NOT a baseline/schedule claim: R0 makes no
  -- on-track-vs-baseline computation and never auto-advances a stage by a date
  -- (spec §5, §8.1). Stored and shown as-is.
  planned_start_date date,
  planned_end_date   date,
  -- Planned cost is integer cents, free-form (spec §2 Q2). It is NEVER an input to
  -- the authoritative budget. There is no code path and no grant from this column
  -- to ledger.budget_event.
  planned_cost_cents bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Timeline / rollup ordering (FR-P4, spec §8.3): plan order, tie-broken on seq.
CREATE INDEX stage_project_position_idx
  ON schedule.stage (project_id, position, seq);

-- ── stage_progress — append-only progress reports (FR-P3, spec §8.1) ──────────
-- One row per report. Rows are NEVER updated or deleted (no UPDATE/DELETE grant
-- below): the current status is always the latest row, so history is the source of
-- truth. "Latest" is a TOTAL, deterministic order — (reported_at, seq) — so two
-- reports in the same second never produce an ambiguous headline (spec §8.1).
CREATE TABLE schedule.stage_progress (
  id                   uuid PRIMARY KEY,
  seq                  bigint GENERATED ALWAYS AS IDENTITY,
  stage_id             uuid NOT NULL REFERENCES schedule.stage (id),
  project_id           uuid NOT NULL,
  -- The exact four R0 status values (spec §2 Q1). No mutable status lives on the
  -- stage; this column, on the latest row, IS the stage's status.
  status               text NOT NULL
                         CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done')),
  -- Advisory percent (spec §2 Q1), only meaningful while `in_progress`. The
  -- headline is always the status word, never this number, and it is EXCLUDED from
  -- the rollup percent (spec §8.3 R2). Forbidden outside in_progress so a stored
  -- report can never read "done · 70%".
  percent              integer
                         CHECK (percent IS NULL OR (percent BETWEEN 0 AND 100)),
  note                 text,
  reported_by_party_id uuid NOT NULL,
  reported_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT percent_only_in_progress
    CHECK (percent IS NULL OR status = 'in_progress')
);

-- The stage's current status is the last row by (reported_at, seq); the full,
-- attributed history is read in the same order (FR-P3, FR-P5, AC-P3, AC-P8/P9).
CREATE INDEX stage_progress_stage_idx
  ON schedule.stage_progress (stage_id, reported_at, seq);
CREATE INDEX stage_progress_project_idx
  ON schedule.stage_progress (project_id, reported_at, seq);

-- ── Least-privilege grants for schedule_app ───────────────────────────────────
-- schedule_app (created by db/roles.sql, NOLOGIN) holds USAGE on `schedule` only
-- (db/0001_platform.sql) and these per-table grants — nothing on any sibling
-- schema, and critically NO grant anywhere on ledger.budget_event. The append-only
-- tables get INSERT + SELECT and deliberately NO UPDATE / DELETE, so the immutable
-- history is enforced by the database, not just by the service.
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.stage           TO schedule_app;
GRANT SELECT, INSERT         ON TABLE schedule.stage_progress   TO schedule_app;
