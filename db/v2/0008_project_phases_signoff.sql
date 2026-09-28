-- 0008 — project phases + execution sign-off, ported to /api/v2 (LINA-356;
-- ADR-0024). Enabling backend for the S6 UI cutover (LINA-309 / LINA-323).
--
-- The LINA-308 fresh-start pivot (db/v2/0001) never carried the v1 phase +
-- sign-off surface across. This migration re-homes it on v2, mirroring the v1
-- DDL (services/schedule/migrations 0012 + 0013 as-built) but adapted to the
-- v2 identity space and module layout:
--
--   * v1 kept phases in the `schedule` schema and referenced identity.party.
--     v2 is org-centric (doc 16): phases are a PROJECT-lifecycle concern, so
--     they live in the `project` schema alongside project.project. `project_id`
--     and the actor refs (`requested_by`) are BARE cross-schema refs to
--     project.project / identity.person — same discipline as planning.task.
--   * ADR-0024: phases AND sign-off stay in ONE module (project). approveSignOff
--     resolves the request AND flips the phase to signed_off in ONE transaction
--     ("the decision and the lock commit together" — the audit invariant). A
--     split across module stores would break that atomicity.
--
-- TAMPER-EVIDENT DISCIPLINE (the core product promise):
--   * A 'signed_off' project_phase is a ONE-WAY terminal state, enforced by the
--     DB trigger below — no service bug can walk a phase back out of the lock.
--   * phase_sign_off_request is resolved IN PLACE (approve/reject stamps
--     status + resolved_at + resolution_comment on the request row), matching
--     the v1 as-built after 0013 superseded 0012's append-only note. The CHECK
--     binds resolved_at to a non-pending status; the partial UNIQUE keeps at
--     most one OUTSTANDING request per phase. Tamper-evidence for the sign-off
--     DECISION lives in the one-way project_phase trigger — not in this
--     workflow row's immutability.
--   * The PRE-sign-off plan-edit audit trail is planning.task_field_change
--     (0001, append-only by trigger) — v2 already logs every task field change
--     per task, richer than v1's phase-anchored plan_change_log. ADR-0024
--     records the decision NOT to add a redundant phase-anchored log: the
--     sign-off boundary is enforced by assertPlanEditable (a signed_off
--     execution phase rejects structural writes with plan_locked), so field-
--     change logging naturally ceases at the lock and the change-order ledger
--     (contracting.change_order / planning.variation, ADR-0014) takes over.
--
-- v2 runs a single application pool (registry.ts): there is no per-module
-- least-privilege role yet, so this migration adds no GRANTs. Append-only /
-- terminality are enforced by triggers + constraints, the same way 0001 does
-- (field_change_append_only et al.). Forward-only. Head migration is v2/0007.

-- ── project.project_phase — the phase-sequencing layer (ADR-0024 FSM) ─────────
-- One row per phase kind per project. 'procurement' (seq 0) and 'execution'
-- (seq 1) are seeded lazily on first read (ensurePhases). `status` is the single
-- source of truth for plan-edit gating.
CREATE TABLE project.project_phase (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL,                    -- ← project.project.id (bare ref)
  kind                  text NOT NULL
                          CHECK (kind IN ('pre_design','procurement','execution','close_out')),
  name                  text NOT NULL,                    -- display name; defaults from kind
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','active','signed_off','archived')),
  sequence              integer NOT NULL,                 -- 0-indexed ordering; gaps allowed
  responsible_party_ids uuid[] NOT NULL DEFAULT '{}',     -- ← identity.person.id[] (bare refs)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_phase_kind_uq     UNIQUE (project_id, kind),
  CONSTRAINT project_phase_sequence_uq UNIQUE (project_id, sequence)
);
CREATE INDEX project_phase_project_sequence_idx
  ON project.project_phase (project_id, sequence);

COMMENT ON TABLE project.project_phase IS
  'Phase-sequencing layer (procurement/execution/…) per project. status is the single source of truth for plan-edit gating. signed_off is a one-way terminal state (DB trigger). LINA-356 / ADR-0024.';

-- ── One-way signed_off (the tamper-evident lock) ─────────────────────────────
-- Once a phase is signed_off its plan is immutable and all edits route through
-- the change-order ledger. Enforced in the database so no service bug can walk
-- a phase back out of the locked state. Ported verbatim from v1 migration 0012.
CREATE FUNCTION project.reject_phase_signed_off_reopen() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'signed_off' AND NEW.status IS DISTINCT FROM 'signed_off' THEN
    RAISE EXCEPTION 'project_phase % is signed_off — a one-way terminal state; edits route through change orders (ADR-0014), the phase is never reopened', NEW.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_phase_signed_off_one_way
  BEFORE UPDATE ON project.project_phase
  FOR EACH ROW EXECUTE FUNCTION project.reject_phase_signed_off_reopen();

-- ── project.phase_sign_off_request — in-place-resolved sign-off ledger ────────
-- A 'pending' row is the request; approve/reject stamps status + resolved_at +
-- resolution_comment on the SAME row (v1 as-built after 0013). At most one
-- OUTSTANDING request per phase (partial UNIQUE → typed 409); the CHECK binds
-- resolved_at to a non-pending status.
CREATE TABLE project.phase_sign_off_request (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id           uuid NOT NULL REFERENCES project.project_phase (id),
  requested_by       uuid NOT NULL,                       -- ← identity.person.id (bare ref)
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
  ON project.phase_sign_off_request (phase_id) WHERE status = 'pending';
CREATE INDEX phase_sign_off_phase_status_idx
  ON project.phase_sign_off_request (phase_id, status);

COMMENT ON TABLE project.phase_sign_off_request IS
  'Sign-off request resolved IN PLACE (approve/reject stamps status + resolved_at + resolution_comment; one pending per phase via partial UNIQUE). Tamper-evidence for the decision is the one-way project_phase trigger + planning.task_field_change + the change-order ledger, not this workflow row. LINA-356 / ADR-0024.';
