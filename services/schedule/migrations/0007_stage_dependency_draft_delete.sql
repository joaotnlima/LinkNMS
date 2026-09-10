-- Schedule & Progress — guarded DELETE for draft stage dependencies (LINA-233;
-- annex 2 of ADR-0017; parent LINA-229 §5 "depends on" authoring UI).
--
-- `:author` now lets the GC/owner express predecessors by hand ("depends on") on
-- a private draft. A draft's stage rows are REPLACED in place on every re-save
-- (migration 0005 relaxed schedule.stage DELETE for exactly that), which means
-- its `stage_dependency` rows must go with them — `deleteStagesByPlanVersion`
-- would otherwise fail on the FK `stage_dependency.stage_id → stage.id`.
--
-- Until now `stage_dependency` was an append-only projection (migration 0002:
-- SELECT + INSERT only, deliberately no UPDATE/DELETE) so a predecessor link on
-- the SHARED record could never be silently rewritten. That immutability is the
-- point and stays. This migration relaxes it EXACTLY and ONLY for private
-- drafts, identically to how 0005 relaxed `stage` DELETE:
--
--   * a `BEFORE DELETE` trigger (`stage_dependency_freeze_delete_guard`)
--     RAISEs if the OWNING stage (stage_id) belongs to a frozen/terminal plan
--     version (`accepted`/`superseded`/`withdrawn`/`rejected`) — mirroring
--     `stage_freeze_delete_guard` from 0005, same terminal set;
--   * a bare `GRANT DELETE` to `schedule_app` lets `:author` replace a draft's
--     dependency graph atomically (delete the draft's rows, re-insert the fresh
--     graph) while a terminal/baseline version's links can never be deleted by
--     any code path.
--
-- A draft is never on the shared record (only the immutable `plan_drafted` ledger
-- events are), so discarding its dependency rows erases nothing that was ever
-- proposed or agreed. The append-only guarantee for the record is intact.
--
-- (0006 is LINA-234's stage_description — do NOT reuse the number.)
--
-- Forward-only. Applied by the migrator role. Owned + finalised by the
-- Full-Stack Architect (drafted here; reviewed & applied to Neon by the Architect
-- — the push-to-main prod schema gate applies it on merge).
-- NEVER edit an applied migration — the prod schema-gate byte-checksum guard
-- halts ALL migrates if an applied file's bytes change (LINA-148 hotfix history).

-- ── the guarded DELETE: a frozen/terminal version's dependencies never die ───
-- The owning stage is `stage_dependency.stage_id` — the stage that lists a
-- predecessor. The terminal set mirrors reject_frozen_stage_delete (0005) and
-- reject_frozen_stage_write (0003) exactly.
CREATE FUNCTION schedule.reject_frozen_dependency_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM schedule.stage s
      JOIN schedule.plan_version v ON v.id = s.plan_version_id
     WHERE s.id = OLD.stage_id
       AND v.status IN ('accepted','superseded','withdrawn','rejected')
  ) THEN
    RAISE EXCEPTION 'stage dependency of % belongs to a frozen/terminal plan version — a baseline is changed, never deleted', OLD.stage_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stage_dependency_freeze_delete_guard
  BEFORE DELETE ON schedule.stage_dependency
  FOR EACH ROW EXECUTE FUNCTION schedule.reject_frozen_dependency_delete();

-- DELETE is granted ONLY so `:author` can rebuild a draft's dependency graph in
-- place; the trigger above is the real guard (defense in depth, exactly as
-- stage_freeze_delete_guard guards stage delete in 0005).
GRANT DELETE ON TABLE schedule.stage_dependency TO schedule_app;