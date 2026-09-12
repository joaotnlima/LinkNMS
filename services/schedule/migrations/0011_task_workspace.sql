-- Task workspace — per-stage comments, file attachments, stable identity
-- (LINA-249; parent LINA-248, founder ask 3).
--
-- Every plan task must support **comments** and **file attachments** and be
-- addressable at its own URL (Jira-style). Collaboration chatter is NOT
-- agreement change: it carries no budget/decision semantics and NEVER touches
-- the tamper-evident ledger — these tables are schedule-owned, append-only,
-- with no ledger seam, exactly like stage_progress (migration 0001).
--
-- STABLE IDENTITY (the load-bearing decision). `:author` rebuilds a draft's
-- stage rows on every save (migrations 0005/0007 relaxed stage DELETE exactly
-- for that), so per-save stage row ids churn. Comments/attachments must survive
-- a re-save and a version bump, so they anchor on the client-minted `key` that
-- the FE already sends for dependsOn resolution — now PERSISTED on the stage
-- row (schedule.stage.key) so a comment outlives the stage row that existed
-- when it was written:
--
--   * `schedule.stage.key` — text ≤ 200 chars (the KEY_MAX the `:author`
--     validator already enforces), nullable. Rows from import/legacy `:author`
--     saves without a key work unchanged.
--   * `schedule.stage_comment` / `schedule.stage_attachment` — anchored on
--     (project_id, stage_key), NOT on stage row ids.
--
-- The stage exists ("unknown stage" 404) is NOT a cross-schema FK: a key's
-- stage goes away with the draft version swap that superseded it, and comments
-- attached to that key deliberately orphan (v1 acceptance — a stage that never
-- had one yet). The live-key check is the service's job against the store
-- (a key is live when its stage's plan version is a draft, a proposal, the
-- agreed baseline, or pre-versioning legacy).
--
-- Append-only by grant, not just by convention: INSERT + SELECT only, exactly
-- like stage_progress (0001) and plan_acceptance (0003). No edit, no delete in
-- v1 — immutability is cheaper than an edit-history design (revisit only on
-- founder demand). The staging CHECK enforces the body length at the DB too,
-- so no code path can sneak a >4000-char comment past the service.
--
-- Forward-only. Applied by the migrator role; owned + finalised by the
-- Full-Stack Architect (the BE drafts; the Architect reviews & applies to Neon).
-- NEVER edit an applied migration — the prod schema-gate byte-checksum guard
-- halts ALL migrates if an applied file's bytes change.

-- ── schedule.stage.key — the stable, client-minted per-stage identity ──────
ALTER TABLE schedule.stage
  ADD COLUMN key text CHECK (char_length(key) <= 200);

-- The workspace read ("does this key exist on this project?") and the
-- append-only rows' lookup go through this index.
CREATE INDEX stage_key_project_idx
  ON schedule.stage (project_id, key)
  WHERE key IS NOT NULL;

COMMENT ON COLUMN schedule.stage.key IS
  'Stable client-minted stage identity: comments and attachments anchor on (project_id, key), not stage row ids, so they survive a draft re-save and a version bump. NULL for import/legacy stages.';

-- ── schedule.stage_comment — append-only task comments ──────────────────────
CREATE TABLE schedule.stage_comment (
  id               uuid PRIMARY KEY,
  project_id       uuid NOT NULL,
  stage_key        text NOT NULL CHECK (char_length(stage_key) <= 200),
  author_party_id  uuid NOT NULL,
  body             text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_comment_project_key_idx
  ON schedule.stage_comment (project_id, stage_key, created_at);

COMMENT ON TABLE schedule.stage_comment IS
  'Append-only task comment (LINA-249). Collaboration chatter — no budget/decision semantics, no ledger seam. No edit, no delete in v1.';

-- ── schedule.stage_attachment — append-only task file references ────────────
CREATE TABLE schedule.stage_attachment (
  id                 uuid PRIMARY KEY,
  project_id         uuid NOT NULL,
  stage_key          text NOT NULL CHECK (char_length(stage_key) <= 200),
  uploader_party_id  uuid NOT NULL,
  file_name          text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  content_type       text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 127),
  size_bytes         bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  blob_url           text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_attachment_project_key_idx
  ON schedule.stage_attachment (project_id, stage_key, created_at);

COMMENT ON TABLE schedule.stage_attachment IS
  'Append-only task file reference (LINA-249). The bytes live in Vercel Blob; this row is the metadata + URL only. Collaboration chatter — no ledger seam. No delete in v1.';

-- ── Least-privilege grants (append-only: no UPDATE/DELETE, mirroring 0001/0003)
GRANT SELECT, INSERT ON TABLE schedule.stage_comment    TO schedule_app;
GRANT SELECT, INSERT ON TABLE schedule.stage_attachment TO schedule_app;