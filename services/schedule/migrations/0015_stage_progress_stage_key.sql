-- Settable task status on the DRAFT plan grid — anchor progress on stage_key
-- (LINA-307; parent LINA-306 founder ask "I should always be able to move the
-- status of a task").
--
-- THE PROBLEM. Status lives ONLY in the append-only, tamper-evident
-- `schedule.stage_progress` history (ADR-0019 — status is NEVER a stage column),
-- keyed on `stage_id` (FK, NOT NULL). But `:author` rebuilds a DRAFT's stage rows
-- on every save (delete + reinsert — migrations 0005/0007 relaxed the stage
-- DELETE exactly for that), so a draft stage's row id RE-MINTS each save. A
-- progress row written against a draft stage would therefore (a) detach on the
-- next save (its id no longer names a live stage) and, worse, (b) BREAK that
-- save: the stage DELETE would violate `stage_progress.stage_id`'s FK, and the
-- app role holds no DELETE grant on the audit table. That is why the STATUS
-- column has been derived/read-only on the draft grid.
--
-- THE FIX (single source of truth, precedented). Anchor the status history on the
-- STABLE, client-minted `schedule.stage.key` — the exact pattern
-- `stage_comment` / `stage_attachment` already use to survive draft re-saves
-- (migration 0011). We keep ONE status source (`stage_progress`) and ONE
-- append-only discipline; we simply let a row OUTLIVE the stage row that existed
-- when it was written:
--
--   * `stage_key` is recorded on every new progress row (the service resolves it
--     from the stage at write time).
--   * `stage_id` becomes NULLABLE and its FK is re-declared ON DELETE SET NULL,
--     so a draft re-save's stage DELETE nulls the id on any progress row that
--     referenced it while the row + its `stage_key` REMAIN. The SET NULL cascade
--     runs as a SYSTEM referential action (executed as the constraint owner, not
--     the current role), so the app role needs NO UPDATE grant on this
--     append-only table — verified by a pg test.
--   * Current status is derived per stage as latest-by-key, falling back to
--     latest-by-id for legacy rows written before this migration (stage_key NULL).
--
-- IMMUTABILITY IS UNCHANGED. This is still INSERT + SELECT only for the app role
-- (no UPDATE / DELETE grant): every status change is a NEW attributed row, never
-- an edit. Anchoring on `stage_key` makes the status SETTABLE on a draft and
-- resilient to re-saves; it does not make any existing row mutable by the app.
--
-- Forward-only. Applied by the migrator role; owned + finalised by the
-- Full-Stack Architect. NEVER edit an applied migration — the prod schema-gate
-- byte-checksum guard halts ALL migrates if an applied file's bytes change.

-- ── stage_key — the stable anchor the status history survives on ─────────────
ALTER TABLE schedule.stage_progress
  ADD COLUMN stage_key text CHECK (char_length(stage_key) <= 200);

COMMENT ON COLUMN schedule.stage_progress.stage_key IS
  'Stable client-minted stage identity (schedule.stage.key). Status history anchors here so a draft re-save (which re-mints stage row ids) does not detach or break it — mirrors the stage_comment/stage_attachment anchoring (migration 0011). NULL for legacy rows written before LINA-307.';

-- ── stage_id becomes nullable + SET NULL on delete ───────────────────────────
-- A draft re-save DELETEs the stage rows; ON DELETE SET NULL lets that succeed
-- while the progress row (and its stage_key) survive. The FK created inline in
-- migration 0001 is auto-named `stage_progress_stage_id_fkey`.
ALTER TABLE schedule.stage_progress
  ALTER COLUMN stage_id DROP NOT NULL;

ALTER TABLE schedule.stage_progress
  DROP CONSTRAINT stage_progress_stage_id_fkey;

ALTER TABLE schedule.stage_progress
  ADD CONSTRAINT stage_progress_stage_id_fkey
    FOREIGN KEY (stage_id) REFERENCES schedule.stage (id) ON DELETE SET NULL;

-- ── The derivation index — latest report per (project, stage_key) ────────────
-- Matches `latestProgressByProjectKey` / `listProgressByKey`: newest first by
-- (reported_at, seq) within a key, scoped to a project.
CREATE INDEX stage_progress_project_key_idx
  ON schedule.stage_progress (project_id, stage_key, reported_at DESC, seq DESC);

-- No new GRANT: the SET NULL cascade is a system referential action, so the
-- append-only INSERT+SELECT grant from migration 0001 is sufficient (a pg test
-- proves a draft re-save with a progress row succeeds without an UPDATE grant).
