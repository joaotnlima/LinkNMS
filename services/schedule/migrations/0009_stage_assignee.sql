-- Per-stage assignee — who owns this stage (LINA-235; ADR-0017 annex 3).
--
-- The specialty/trade tag already exists (migration 0002 `schedule.stage.trade`,
-- free-form label); the assignee is a reference to a **party/membership on the
-- project** (identity.party id, bare uuid per ADR-0006 §1) — NOT a second
-- free-form string. NULL = unassigned (matches v1, where every stage is unassigned
-- by default).
--
-- Validation that the party exists on the project is enforced by the schedule
-- service at `:author` time against the identity port (roleOf), NOT by a
-- cross-schema foreign key — respecting the schema isolation seam (ADR-0006 §1).
-- An orphaned reference (party removed from a project) degrades to "unknown" on
-- the next author plan read, which is the correct failure mode: no FK constraint
-- that could block membership removal.
--
-- Additive; no backfill. No new grant required: `schedule_app` already holds
-- INSERT/UPDATE/SELECT on `schedule.stage`.
--
-- Forward-only. Applied by the migrator role; never edit an applied migration.

ALTER TABLE schedule.stage ADD COLUMN assignee_party_id uuid;

COMMENT ON COLUMN schedule.stage.assignee_party_id IS
  'Party that owns this stage (identity.party id, bare ref). NULL = unassigned.';
