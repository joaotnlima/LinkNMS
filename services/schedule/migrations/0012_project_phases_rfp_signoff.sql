-- Project phases, RFP procurement loop & execution sign-off (LINA-277; ADR-0023
-- §2 DB Schema, revised for PRD v2).
--
-- Adds a lightweight phase-sequencing layer on top of the project record
-- (procurement vs. execution) plus the two loops it unlocks: an RFP loop that
-- solicits proposals from external, unauthenticated contractors via a hashed
-- token, and an execution sign-off that locks the plan so the change-order
-- ledger (ADR-0014) becomes the only mutation path.
--
-- SERVICE OWNERSHIP (ADR-0023 §1). These are plan-lifecycle concerns, so they
-- live in the `schedule` schema — no new `procurement` schema, no new
-- least-privilege role. `project_id`, `requested_by`, `actor_party_id`, and
-- `responsible_party_ids` are BARE refs to identity.project / identity.party (no
-- cross-schema FK — same discipline as schedule.stage.project_id in 0001). The
-- in-schema relationships (phase → sign-off / rfp / change-log; rfp → recipient →
-- proposal) DO carry real FKs.
--
-- TAMPER-EVIDENT / APPEND-ONLY DISCIPLINE (ADR-0023 §2, §8, enforced by grant):
--   * schedule.phase_sign_off_request is append-only (SELECT+INSERT only, no
--     UPDATE/DELETE). A request is a 'pending' row; its resolution is a NEW
--     'approved'/'rejected' row carrying resolved_at + resolution_comment. The
--     current state of a phase's sign-off is the LATEST row for that phase, the
--     same "history is the source of truth" pattern as stage_progress (0001).
--   * schedule.plan_change_log is append-only (SELECT+INSERT only). It captures
--     the PRE-sign-off audit trail (who moved a task date, renamed a stage, added
--     a dependency). Writes STOP once a phase reaches 'signed_off' — from there
--     the change-order ledger is the sole record. The two surfaces are split by
--     the sign-off boundary and never overlap.
--   * schedule.rfp_proposal is append-only (one proposal per recipient, submitted
--     once) — SELECT+INSERT only.
--   * A 'signed_off' project_phase is a ONE-WAY terminal state, enforced by a DB
--     trigger below — no code path can walk a phase back out of signed_off.
--
-- Forward-only. Applied by the `migrator` role; drafted by BE, reviewed &
-- applied to Neon by the Full-Stack Architect. NEVER edit an applied migration —
-- the prod schema-gate byte-checksum guard halts ALL migrates if an applied
-- file's bytes change. Head migration is schedule/0011.

-- ── schedule.project_phase — the phase-sequencing layer (ADR-0023 §10 FSM) ────
-- One row per phase kind per project. Phases 'procurement' and 'execution' are
-- seeded on project creation (ADR-0023 §3). `status` is the single source of
-- truth for both plan-edit gating and dynamic RFP-token validity (ADR-0023 §5) —
-- there is deliberately no denormalised token-expiry column anywhere.
CREATE TABLE schedule.project_phase (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL,                    -- ← identity.project.id (bare ref)
  kind                  text NOT NULL
                          CHECK (kind IN ('pre_design','procurement','execution','close_out')),
  name                  text NOT NULL,                    -- display name; defaults from kind
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','active','signed_off','archived')),
  sequence              integer NOT NULL,                 -- 0-indexed ordering; gaps allowed
  responsible_party_ids uuid[] NOT NULL DEFAULT '{}',     -- ← identity.party.id[] (bare refs)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_phase_kind_uq     UNIQUE (project_id, kind),
  CONSTRAINT project_phase_sequence_uq UNIQUE (project_id, sequence)
);
CREATE INDEX project_phase_project_sequence_idx
  ON schedule.project_phase (project_id, sequence);

COMMENT ON TABLE schedule.project_phase IS
  'Phase-sequencing layer (procurement/execution/…) per project. status is the single source of truth for plan-edit gating AND dynamic RFP-token validity (ADR-0023 §5). signed_off is a one-way terminal state (DB trigger). LINA-277.';

-- ── One-way signed_off (ADR-0023 §2, §10) ────────────────────────────────────
-- Once a phase is signed_off its plan is immutable and all edits route through
-- the change-order ledger. This enforces terminality in the database so no
-- service bug can walk a phase back out of the locked state.
CREATE FUNCTION schedule.reject_phase_signed_off_reopen() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'signed_off' AND NEW.status IS DISTINCT FROM 'signed_off' THEN
    RAISE EXCEPTION 'project_phase % is signed_off — a one-way terminal state; edits route through change orders (ADR-0014), the phase is never reopened', NEW.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_phase_signed_off_one_way
  BEFORE UPDATE ON schedule.project_phase
  FOR EACH ROW EXECUTE FUNCTION schedule.reject_phase_signed_off_reopen();

-- ── schedule.phase_sign_off_request — append-only sign-off ledger (ADR-0023 §2)
-- A 'pending' row is the request; resolution is a NEW 'approved'/'rejected' row
-- (never an in-place status update — SELECT+INSERT grant only). Current state is
-- the latest row per phase. Only ONE pending request may be outstanding per phase.
CREATE TABLE schedule.phase_sign_off_request (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id           uuid NOT NULL REFERENCES schedule.project_phase (id),
  requested_by       uuid NOT NULL,                       -- ← identity.party.id (bare ref)
  requested_at       timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected')),
  resolved_at        timestamptz,
  resolution_comment text,
  -- A resolved row must carry its resolution time; a pending row must not.
  CONSTRAINT phase_sign_off_resolved_iff_not_pending
    CHECK ((status = 'pending') = (resolved_at IS NULL))
);
-- At most one OUTSTANDING request per phase (a single sign-off thread).
CREATE UNIQUE INDEX phase_sign_off_one_pending_per_phase
  ON schedule.phase_sign_off_request (phase_id) WHERE status = 'pending';
CREATE INDEX phase_sign_off_phase_status_idx
  ON schedule.phase_sign_off_request (phase_id, status);

COMMENT ON TABLE schedule.phase_sign_off_request IS
  'Append-only sign-off ledger (ADR-0023 §2). Rejection = new row; never a status update in place (SELECT+INSERT grant). Current state = latest row per phase. LINA-277.';

-- ── schedule.rfp — a request for proposals against a procurement phase ────────
-- One active (non-closed) RFP per phase in v1. Attachments are R2 refs
-- ([{key, filename, size, content_type, url}]) mirroring stage_attachment.
CREATE TABLE schedule.rfp (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id     uuid NOT NULL REFERENCES schedule.project_phase (id),
  description  text NOT NULL,
  attachments  jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','sent','closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- One live RFP per phase (v1 constraint, relaxed in v2 for multi-round — Q2).
CREATE UNIQUE INDEX rfp_one_live_per_phase
  ON schedule.rfp (phase_id) WHERE status <> 'closed';

COMMENT ON TABLE schedule.rfp IS
  'Request for proposals against a procurement phase. attachments are R2 refs. One live (non-closed) RFP per phase in v1. LINA-277 / ADR-0023.';

-- ── schedule.rfp_recipient — an external, unauthenticated invitee (ADR-0023 §5)
-- Mirrors identity.invitation: only the SHA-256 (64 hex chars) of the raw token
-- is stored. There is NO token_expires_at — validity is DYNAMIC: a token is live
-- iff its RFP's phase is still 'active' (a single join), so no timestamp can drift
-- out of sync with the phase state.
CREATE TABLE schedule.rfp_recipient (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_id      uuid NOT NULL REFERENCES schedule.rfp (id),
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  status      text NOT NULL DEFAULT 'invited'
                CHECK (status IN ('invited','viewed','submitted','declined')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfp_recipient_rfp_email_uq UNIQUE (rfp_id, email)
);
CREATE INDEX rfp_recipient_rfp_status_idx
  ON schedule.rfp_recipient (rfp_id, status);

COMMENT ON TABLE schedule.rfp_recipient IS
  'External unauthenticated RFP invitee. token_hash = SHA-256 (mirrors identity.invitation). NO token_expires_at — validity is dynamic, tied to project_phase.status (ADR-0023 §5). LINA-277.';

-- ── schedule.rfp_proposal — a contractor''s submission (append-only, one per recipient)
CREATE TABLE schedule.rfp_proposal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_recipient_id  uuid NOT NULL UNIQUE REFERENCES schedule.rfp_recipient (id),
  company_name      text NOT NULL,
  website_url       text,
  portfolio_images  jsonb NOT NULL DEFAULT '[]',          -- same R2 ref shape
  budget_min_cents  bigint NOT NULL CHECK (budget_min_cents >= 0),
  budget_max_cents  bigint NOT NULL CHECK (budget_max_cents >= budget_min_cents),
  timeline_days     integer NOT NULL CHECK (timeline_days > 0),
  comment           text,
  submitted_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE schedule.rfp_proposal IS
  'One append-only proposal per RFP recipient (UNIQUE rfp_recipient_id). Budget in integer cents; never an input to the authoritative ledger budget. LINA-277 / ADR-0023.';

-- ── schedule.plan_change_log — pre-sign-off plan-edit audit trail (ADR-0023 §8)
-- Append-only (SELECT+INSERT grant). One row per task/stage/dependency field
-- change while the phase is still freely editable. Writes cease once the phase is
-- signed_off — from there the change-order ledger (ADR-0014) is the sole record.
-- actor_party_id NULL = system-originated change.
CREATE TABLE schedule.plan_change_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id       uuid NOT NULL REFERENCES schedule.project_phase (id),
  entity_type    text NOT NULL CHECK (entity_type IN ('task','stage','dependency')),
  entity_id      uuid NOT NULL,
  field_name     text NOT NULL,
  old_value      jsonb,
  new_value      jsonb,
  actor_party_id uuid,                                    -- ← identity.party.id (bare ref); NULL = system
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_change_log_phase_time_idx
  ON schedule.plan_change_log (phase_id, occurred_at);
CREATE INDEX plan_change_log_entity_idx
  ON schedule.plan_change_log (entity_type, entity_id);

COMMENT ON TABLE schedule.plan_change_log IS
  'Append-only PRE-sign-off plan-edit audit trail (ADR-0023 §8 PRD v2). Writes STOP at signed_off; the change-order ledger takes over after lock — the two surfaces never overlap. LINA-277.';

-- ── Least-privilege grants for schedule_app (mirroring 0001/0003/0011) ────────
-- Append-only tables get SELECT+INSERT only (no UPDATE/DELETE) — immutability by
-- grant, not just by convention. Mutable-lifecycle tables (phase status walk, rfp
-- draft→sent→closed, recipient status walk) additionally get UPDATE. No table
-- here grants DELETE.
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.project_phase           TO schedule_app;
GRANT SELECT, INSERT         ON TABLE schedule.phase_sign_off_request  TO schedule_app;
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.rfp                     TO schedule_app;
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.rfp_recipient           TO schedule_app;
GRANT SELECT, INSERT         ON TABLE schedule.rfp_proposal            TO schedule_app;
GRANT SELECT, INSERT         ON TABLE schedule.plan_change_log         TO schedule_app;
