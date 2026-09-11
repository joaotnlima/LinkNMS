-- Typed plan dependencies — how one stage blocks another (LINA-252; ADR-0020).
--
-- v1 shipped an UNTYPED predecessor graph: schedule.stage_dependency
-- (stage_id, depends_on_stage_id) was semantically hard-coded to finish-to-start
-- (migration 0007, ADR-0017 annex 2). ADR-0020 makes the link type explicit:
--
--   starts_after — dependent starts only after the predecessor ENDS (FS; the
--                  previous implicit semantics — every existing row means this)
--   starts_with  — dependent starts together with the predecessor's START (SS)
--   ends_with    — dependent ends together with the predecessor's END (FF)
--
-- One typed link per ordered pair: the PK stays (stage_id, depends_on_stage_id);
-- dep_type QUALIFIES the link rather than widening the key, so two different
-- typed links between the same pair are rejected by design (matches MS Project /
-- Asana). Existing rows become starts_after via the column default — byte-exact
-- preservation of today's semantics, no backfill.
--
-- No new grant required: schedule_app already holds INSERT/SELECT on
-- schedule.stage_dependency (migration 0007). The ADD COLUMN ... DEFAULT is
-- immediate in PG when the CHECK is added in the same statement below; the
-- freeze guard trigger and DELETE grant from 0007 carry over untouched.
--
-- Forward-only. Applied by the migrator role; never edit an applied migration.

ALTER TABLE schedule.stage_dependency
  ADD COLUMN dep_type text NOT NULL DEFAULT 'starts_after'
  CHECK (dep_type IN ('starts_after','starts_with','ends_with'));

COMMENT ON COLUMN schedule.stage_dependency.dep_type IS
  'How this stage follows its predecessor: starts_after (FS), starts_with (SS), ends_with (FF).';