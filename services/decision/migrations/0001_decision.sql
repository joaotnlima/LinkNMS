-- Decision Log service — schema `decision` (ADR-0003, ADR-0006 §1).
--
-- Owns the mutable decision record and its revision history. The Ledger service
-- records the immutable fact (via ledger.append_event); this schema holds the
-- editable current-state projection the UI reads. No cross-schema FK: party IDs
-- are stored as bare UUIDs and validated at the service boundary (split-DB seam).
-- Applied by the `migrator` role; `decision_app` gets USAGE on this schema via
-- db/0001_platform.sql and least-privilege DML below. Forward-only.

CREATE SCHEMA IF NOT EXISTS decision;

-- Current state of a decision (mutable; the append-only record of its history
-- is in ledger.audit_event). `original_*` captures the first version so revisions
-- can always be compared to genesis. `rev` starts at 1 and increments on each
-- revision; it matches the seq of the corresponding audit event.
CREATE TABLE IF NOT EXISTS decision.decision (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid        NOT NULL,
  title            text        NOT NULL,
  body             text,
  rev              integer     NOT NULL DEFAULT 1 CHECK (rev >= 1),
  original_title   text        NOT NULL,
  original_body    text,
  created_by       uuid        NOT NULL,          -- identity.party.id (bare ref)
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_revised_by  uuid,
  last_revised_at  timestamptz,
  -- Idempotency key for serverless retries (POST /projects/:id/decisions).
  idempotency_key  text        UNIQUE
);

CREATE INDEX IF NOT EXISTS decision_project_created_idx
  ON decision.decision (project_id, created_at, id);

-- Least-privilege grants: decision_app reads and writes its own table only.
REVOKE ALL ON TABLE decision.decision FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE decision.decision TO decision_app;
