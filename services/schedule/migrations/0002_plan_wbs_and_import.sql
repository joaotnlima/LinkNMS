-- Schedule & Progress service — plan WBS + Excel import (Slice B1, LINA-199;
-- frozen contract docs/architecture/slice-b1-plan-import-contract.md §3;
-- anchors ADR-0012 §B, ADR-0002, ADR-0005/0006 §1).
--
-- Adds the two-level WBS hierarchy (Action / Sub-action) on `schedule.stage`
-- and the append-only `plan_import` header + `stage_dependency` many-to-many
-- that support the GC's Excel plan import (D8–D10).
--
-- TRUST DISCIPLINE: `plan_import` (the batch that created a set of stages) is
-- append-only — INSERT + SELECT only, no UPDATE/DELETE grant — mirroring the
-- stage_progress discipline so an import header can never be silently amended.
-- The single `plan_import` ledger event is appended through the existing
-- `ledger.append_event` seam in the SAME transaction as the projection writes
-- (ADR-0006 §1); schedule_app already holds EXECUTE on it via ledger/0007, so
-- NO new ledger grant is added here.
--
-- NOTE on Confirm-transaction ordering (contract §3 vs §4): `plan_import` is
-- INSERT+SELECT only, so audit_event_id (NOT NULL) can never be backfilled with
-- an UPDATE. ledger.append generates the audit_event id itself. Therefore inside
-- the ONE Confirm transaction the append runs BEFORE the plan_import header
-- INSERT (pre-generated import id + the returned audit_event_id), then stages
-- (parents before children), then stage_dependency rows. Same transaction, same
-- all-or-nothing, same FK discipline — the header precedes the stages.
--
-- Forward-only. Applied by the migrator role. Owned + finalised by the
-- Full-Stack Architect (the BE drafts; the Architect reviews & applies to Neon).

-- ── ALTER schedule.stage: WBS hierarchy + import provenance ────────────────
-- parent_id: WBS hierarchy. NULL = a top-level Action; a Sub-action points at
--   its Action. The B1 parser enforces exactly two levels (contract §6); the
--   self-ref *permits* deeper nesting for B2+.
-- trade: free-form trade label (pen "Trade"). Nullable.
-- import_id: the batch that created this stage; NULL for hand-added stages.
-- source_row_ref: originating spreadsheet row key — provenance and the token
--   used to resolve intra-import dependencies (contract §8).
ALTER TABLE schedule.stage ADD COLUMN parent_id        uuid REFERENCES schedule.stage (id);
ALTER TABLE schedule.stage ADD COLUMN trade            text;
ALTER TABLE schedule.stage ADD COLUMN import_id        uuid;
ALTER TABLE schedule.stage ADD COLUMN source_row_ref   text;

-- Index the WBS parent lookup (parents-first insertion order + tree reads).
CREATE INDEX stage_import_idx ON schedule.stage (import_id);
CREATE INDEX stage_parent_idx  ON schedule.stage (parent_id);

-- ── schedule.plan_import — append-only import batch header (contract §3) ────
-- One row per Confirm. Never updated or deleted (INSERT + SELECT grant only).
CREATE TABLE schedule.plan_import (
  id                    uuid PRIMARY KEY,
  project_id            uuid NOT NULL,
  filename              text NOT NULL,
  sheet_name            text NOT NULL,
  -- The exact field→column-index assignment used (contract §2: nothing inferred).
  column_mapping        jsonb NOT NULL,
  row_count             integer NOT NULL,
  -- Idempotency: a serverless retry with the same key returns the original
  -- result and writes nothing (contract §2). Unique, not just indexed.
  idempotency_key       text NOT NULL UNIQUE,
  imported_by_party_id  uuid NOT NULL,
  imported_at           timestamptz NOT NULL DEFAULT now(),
  audit_event_id        uuid NOT NULL
);

CREATE INDEX plan_import_project_idx ON schedule.plan_import (project_id);

-- ── schedule.stage_dependency — intra-import predecessors (m2m) ────────────
-- A stage may list several predecessors. Append-only (INSERT + SELECT only).
-- The self-dep CHECK forbids a stage depending on itself.
CREATE TABLE schedule.stage_dependency (
  stage_id             uuid NOT NULL REFERENCES schedule.stage (id),
  depends_on_stage_id  uuid NOT NULL REFERENCES schedule.stage (id),
  PRIMARY KEY (stage_id, depends_on_stage_id),
  CONSTRAINT stage_dependency_no_self_dep
    CHECK (stage_id <> depends_on_stage_id)
);

CREATE INDEX stage_dependency_stage_idx   ON schedule.stage_dependency (stage_id);
CREATE INDEX stage_dependency_depends_idx ON schedule.stage_dependency (depends_on_stage_id);

-- ── Least-privilege grants for schedule_app ─────────────────────────────────
-- plan_import and stage_dependency are append-only projections: SELECT + INSERT
-- only, deliberately NO UPDATE / DELETE (immutable history in the database).
-- `stage` already has SELECT, INSERT, UPDATE from 0001. schedule_app already
-- holds EXECUTE on ledger.append_event via ledger/0007 — no new ledger grant.
GRANT SELECT, INSERT ON TABLE schedule.plan_import      TO schedule_app;
GRANT SELECT, INSERT ON TABLE schedule.stage_dependency TO schedule_app;
