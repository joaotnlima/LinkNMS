-- Schedule & Progress service — plan proposal → review → baseline v1 versioning
-- (Slice B2, LINA-200; frozen contract docs/architecture/slice-b2-plan-baseline
-- -contract.md §3; anchors ADR-0012 §B, ADR-0002 §4, ADR-0003/0006 §1, ADR-0004).
--
-- Adds the plan-version envelope (the unit that is proposed, reviewed, and — once
-- dual-stamped — frozen as a baseline), the per-party acceptance stamps, the
-- schedule-owned project_baseline pointer, and a DB-enforced freeze so a frozen
-- version's stages can never be mutated by any code path (ADR-0002 §4, defense in
-- depth over the app-level check).
--
-- TRUST DISCIPLINE: plan_acceptance (the per-party stamps) is append-only —
-- INSERT + SELECT only, no UPDATE/DELETE grant — so a stamp, once written, is
-- immutable in the database. plan_version keeps an UPDATE grant ONLY for the
-- status/frozen_at transition (each mirrored by a ledger event); project_baseline
-- keeps INSERT+UPDATE for a future re-baseline (the pointer advances, never
-- deletes in place). schedule_app already holds EXECUTE on ledger.append_event via
-- ledger/0007 — NO new ledger grant is added here.
--
-- Forward-only. Applied by the migrator role. Owned + finalised by the
-- Full-Stack Architect (the BE drafts; the Architect reviews & applies to Neon).

-- ── schedule.plan_version — the proposal/version envelope ──────────────────
CREATE TABLE schedule.plan_version (
  id                    uuid PRIMARY KEY,
  project_id            uuid NOT NULL,
  -- Monotonic per project: v1, v2, … Assigned server-side inside the append txn
  -- under the same per-project serialization as the ledger (advisory lock).
  version_no            integer NOT NULL,
  status                text NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed','withdrawn','rejected','superseded','accepted')),
  -- The B1 import batch that seeded this version (NULL for a request-changes fork
  -- and for any future hand-built version).
  source_import_id      uuid REFERENCES schedule.plan_import (id),
  -- Request-changes chain (D12a): the version this one forked from. NULL for v1.
  supersedes_version_id uuid REFERENCES schedule.plan_version (id),
  proposed_by_party_id  uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Set exactly when the version freezes (status → accepted). Immutable after.
  frozen_at             timestamptz,
  CONSTRAINT plan_version_project_no_uq UNIQUE (project_id, version_no),
  CONSTRAINT plan_version_frozen_iff_accepted
    CHECK ((status = 'accepted') = (frozen_at IS NOT NULL))
);

-- At most ONE open (proposed) version per project — a single negotiation thread.
CREATE UNIQUE INDEX plan_version_one_open_per_project
  ON schedule.plan_version (project_id) WHERE status = 'proposed';

-- ── schedule.stage: bind stages to their version ──────────────────────────
-- B1 created stages with import_id but no version. Add plan_version_id, then
-- backfill existing import-seeded stages into a v1 per (project_id, import_id).
ALTER TABLE schedule.stage ADD COLUMN plan_version_id uuid REFERENCES schedule.plan_version (id);
CREATE INDEX stage_plan_version_idx ON schedule.stage (plan_version_id);

-- ── schedule.plan_acceptance — per-party stamps (append-only) ──────────────
-- Declared before the backfill so the INSERT below has a table to write into.
CREATE TABLE schedule.plan_acceptance (
  id                uuid PRIMARY KEY,
  plan_version_id   uuid NOT NULL REFERENCES schedule.plan_version (id),
  project_id        uuid NOT NULL,
  party_id          uuid NOT NULL,
  -- 'proposed' = authorship stamp (proposer); 'accepted' = reviewer's stamp.
  kind              text NOT NULL CHECK (kind IN ('proposed','accepted')),
  stamped_at        timestamptz NOT NULL DEFAULT now(),
  audit_event_id    uuid NOT NULL,
  CONSTRAINT plan_acceptance_once UNIQUE (plan_version_id, party_id)
);
CREATE INDEX plan_acceptance_version_idx ON schedule.plan_acceptance (plan_version_id);

-- Backfill: for every distinct (project_id, import_id) that B1 seeded, create a
-- proposed v1 plan_version authored by the import's `imported_by_party_id` (the
-- GC/counterparty is who authored the B1 batch), bind the import's stages to it,
-- AND write the proposer's authorship ('proposed') acceptance stamp. The stamp's
-- audit_event_id is the import's own audit event id — a real ledger event
-- ("this proposal came into existence with the import"). A project with an
-- existing import gets a resumable proposal — no orphan stages — and its version
-- is already dual-acceptable: the reviewer's later accept is the SECOND stamp, so
-- it triggers the freeze (contract §2). Idempotent for the migrator's single
-- application.
INSERT INTO schedule.plan_version
  (id, project_id, version_no, status, source_import_id, supersedes_version_id,
   proposed_by_party_id, created_at, frozen_at)
SELECT gen_random_uuid()
     , pi.project_id
     , 1
     , 'proposed'
     , pi.id
     , NULL
     , pi.imported_by_party_id
     , pi.imported_at
     , NULL
  FROM schedule.plan_import pi
 WHERE NOT EXISTS (
   SELECT 1 FROM schedule.plan_version v WHERE v.source_import_id = pi.id
 );

INSERT INTO schedule.plan_acceptance
  (id, plan_version_id, project_id, party_id, kind, stamped_at, audit_event_id)
SELECT gen_random_uuid()
     , v.id
     , v.project_id
     , v.proposed_by_party_id
     , 'proposed'
     , v.created_at
     , pi.audit_event_id
  FROM schedule.plan_version v
  JOIN schedule.plan_import pi ON pi.id = v.source_import_id
 WHERE NOT EXISTS (
   SELECT 1 FROM schedule.plan_acceptance a
    WHERE a.plan_version_id = v.id AND a.party_id = v.proposed_by_party_id
 );

UPDATE schedule.stage s
   SET plan_version_id = v.id
  FROM schedule.plan_version v
 WHERE v.source_import_id = s.import_id;

-- ── schedule.project_baseline — the frozen baseline pointer (schedule-owned) ─
CREATE TABLE schedule.project_baseline (
  project_id             uuid PRIMARY KEY,
  plan_version_id        uuid NOT NULL REFERENCES schedule.plan_version (id),
  version_no             integer NOT NULL,
  frozen_at              timestamptz NOT NULL DEFAULT now(),
  baseline_audit_event_id uuid NOT NULL
);

-- ── Freeze is DB-enforced (ADR-0002 §4) ────────────────────────────────────
CREATE FUNCTION schedule.reject_frozen_stage_write() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schedule.plan_version v
     WHERE v.id = NEW.plan_version_id
       AND v.status IN ('accepted','superseded','withdrawn','rejected')
  ) THEN
    RAISE EXCEPTION 'stage % belongs to a frozen/terminal plan version — a baseline is changed, never edited', NEW.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stage_freeze_guard
  BEFORE INSERT OR UPDATE ON schedule.stage
  FOR EACH ROW EXECUTE FUNCTION schedule.reject_frozen_stage_write();

-- ── Least-privilege grants ─────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.plan_version     TO schedule_app;
GRANT SELECT, INSERT         ON TABLE schedule.plan_acceptance  TO schedule_app;
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.project_baseline TO schedule_app;
