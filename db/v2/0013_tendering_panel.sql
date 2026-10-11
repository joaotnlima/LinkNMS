-- 0013 — Tender from the task panel (PRD-02, D-42).
--
-- Three additive changes to tendering.rfp:
--
--   1. Lifecycle stamps — published_at, closed_at, awarded_at, cancelled_at.
--      The panel's stepper says WHEN each step happened (T-10: created, sent,
--      bids due / comparing from, awarded). created_at already exists; the
--      others are stamped by the transition that enters the state. Until now
--      the only trace was the ledger, which the tendering read side never
--      reads (it is record's).
--
--   2. cancel_reason — the issuer's optional one-line reason, shown wherever
--      the tender reads Cancelled (T-19). Short free text, nullable.
--
--   3. excluded_task_ids — descendants of the roots LEFT OUT of the package
--      (T-3: e.g. a row already assigned to another party). The package is the
--      roots' sub-trees minus these rows and their own sub-trees. A plain uuid[]
--      (no FK: planning.task lives in another schema, D-03 no cross-schema FKs),
--      exactly as rfp_root.task_id is a bare uuid.
--
-- v2 runs a single application pool: no per-module role yet, so no GRANTs
-- (see 0008_project_phases_signoff.sql). Forward-only, no data rewrite: every
-- existing row keeps NULL stamps and an empty exclusion list.

ALTER TABLE tendering.rfp
  ADD COLUMN published_at timestamptz,
  ADD COLUMN closed_at    timestamptz,
  ADD COLUMN awarded_at   timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text
    CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 500),
  ADD COLUMN excluded_task_ids uuid[] NOT NULL DEFAULT '{}';
