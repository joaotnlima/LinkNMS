-- Decision Log service — schema `decision` (ADR-0003, ADR-0006 §1; design §3, §4.1).
--
-- Owns two tables, mirroring the Architect's data model (design §3):
--   * decision            — the mutable current-state pointer (which rev is live).
--   * decision_revision   — the APPEND-ONLY history. rev 1 is the original;
--                           amendments append rev 2..n; nothing is ever overwritten.
--
-- The immutable fact of each write also lands in `ledger.audit_event` via
-- `ledger.append_event(...)`, inside the SAME transaction as the projection write
-- (design §4.1; ADR-0002/0006). This schema is the rebuildable projection the UI
-- reads; the ledger is the truth. No cross-schema hard FK: party IDs and the
-- audit_event id are stored as bare UUIDs and validated at the service boundary,
-- keeping the split-DB seam clean (ADR-0006 §1 — same discipline as change_order).
--
-- Applied by the `migrator` role; `decision_app` already holds USAGE on this
-- schema (db/0001_platform.sql) and EXECUTE on ledger.append_event
-- (services/ledger/migrations/0002_ledger_roles.sql). Forward-only.

CREATE SCHEMA IF NOT EXISTS decision;

-- ── Current state: one row per decision ──────────────────────────────────────
-- Holds only genesis metadata (who/when it was first recorded) and a pointer to
-- the live revision. The title/body of every version — including the current one
-- — live in decision_revision, so history is never flattened away.
CREATE TABLE IF NOT EXISTS decision.decision (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic insertion order within the table. `created_at` alone is not a total
  -- order (two decisions can share a microsecond), so chronological listing (FR7,
  -- design §353 "ordered by created_at/seq") tie-breaks on this gap-free counter,
  -- never on the random `id`. Assigned by the DB.
  seq                   bigint GENERATED ALWAYS AS IDENTITY,
  project_id            uuid NOT NULL,
  created_by_party_id   uuid NOT NULL,          -- identity.party.id (bare ref)
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Pointer to the live revision (= MAX(rev) in decision_revision). Advanced on
  -- every revise; the prior revision rows are left untouched.
  current_rev           integer NOT NULL DEFAULT 1 CHECK (current_rev >= 1)
);

-- Chronological listing per project (FR7): order by wall-clock, break ties on the
-- monotonic `seq` for a deterministic total order regardless of clock resolution.
CREATE INDEX IF NOT EXISTS decision_project_created_idx
  ON decision.decision (project_id, created_at, seq);

-- ── Append-only revision history ─────────────────────────────────────────────
-- One row per version. rev 1 is the original; a revision INSERTs rev = max+1 with
-- its OWN author + server timestamp. UNIQUE(decision_id, rev) makes a fork or a
-- silent overwrite impossible — the "corrections keep history" guarantee (FR2)
-- is enforced by the database, not just the service.
CREATE TABLE IF NOT EXISTS decision.decision_revision (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id           uuid NOT NULL REFERENCES decision.decision(id),
  rev                   integer NOT NULL CHECK (rev >= 1),
  title                 text NOT NULL,
  -- Body is optional content but never NULL in the projection: the service
  -- normalizes an absent body to '' so every revision has a definite value.
  body                  text NOT NULL DEFAULT '',
  -- Server-authoritative on every revision (design §4.1): taken from the
  -- authenticated party and the server clock, never from the request body.
  revised_by_party_id   uuid NOT NULL,
  revised_at            timestamptz NOT NULL DEFAULT now(),
  -- The ledger event this revision was chained into, in the same transaction.
  -- Bare UUID (not a hard cross-schema FK) so the split-DB seam stays clean.
  audit_event_id        uuid NOT NULL,

  -- Load-bearing: rev is unique per decision, so amendments can only ever APPEND
  -- (rev = max+1) and rev 1 can never be replaced (design §3 "UNIQUE(decision_id, rev)").
  CONSTRAINT decision_revision_decision_rev_uq UNIQUE (decision_id, rev)
);

-- listRevisions(decisionId) reads a decision's history in rev order; the unique
-- index above already serves (decision_id, rev), so no extra index is needed.

-- ── Least-privilege grants ───────────────────────────────────────────────────
-- decision_app reads/writes its own current-state row and INSERTs revisions. It
-- deliberately gets NO UPDATE and NO DELETE on decision_revision: the history is
-- append-only at the GRANT level, so even a bug in the service layer cannot
-- mutate or remove a past revision (mirrors the ledger's write-guard discipline).
REVOKE ALL ON TABLE decision.decision            FROM PUBLIC;
REVOKE ALL ON TABLE decision.decision_revision   FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE decision.decision          TO decision_app;
GRANT SELECT, INSERT         ON TABLE decision.decision_revision TO decision_app;
