-- Schedule & Progress — plan DRAFT status (LINA-230; annexes ADR-0017).
--
-- Founder feedback on LINA-228: "Once I set the plan — I am NOT already sending
-- him to approval… I'm only saving the work done." Authoring must be PRIVATE
-- drafting; proposing for approval is a separate, deliberate act.
--
-- This migration introduces a `draft` plan-version status that precedes
-- `proposed`. A draft is the author's private workspace: it is never an open
-- proposal, so it never blocks a proposal and is never visible to the other
-- party for review. The two-event trail is `plan_drafted` (at author, repeated
-- on every re-save) then, later, `plan_proposed` (at "Send for approval").
--
-- THREE MODEL CHANGES (see the issue and the ADR-0017 annex for the rationale):
--
-- 1. version_no is assigned at PROPOSE time, NULL while drafting. The invariant
--    `(status = 'draft') = (version_no IS NULL)` ties the two together: a draft
--    has no number, everything numbered is a real (proposed→) version. This keeps
--    proposed plans numbered v1, v2, … with NO gaps burned by drafting or by
--    re-saving a draft, and makes "the draft" unambiguous.
--
-- 2. At most ONE draft per project (a single resumable workspace), enforced by a
--    partial unique index mirroring the one-open-proposal index. The `:author`
--    write upserts that single draft IN PLACE: re-saving replaces its stages.
--
-- 3. Replacing a draft's stages needs a DELETE on schedule.stage — which until now
--    had no DELETE grant (immutability of the proposed/accepted record). We add a
--    narrow DELETE grant guarded by a trigger that mirrors the existing
--    stage_freeze_guard: a stage on a frozen/terminal version can NEVER be
--    deleted; only a DRAFT's (or an open proposal's) stages may be. The audit
--    guarantee is untouched — a draft is never on the shared record (only the
--    immutable plan_drafted ledger events are), so discarding draft stages erases
--    nothing that was ever proposed or agreed.
--
-- Forward-only. Applied by the migrator role. Owned + finalised by the
-- Full-Stack Architect (drafted here; reviewed & applied to Neon by the Architect).
-- NEVER edit an applied migration — the prod schema-gate byte-checksum guard
-- halts ALL migrates if an applied file's bytes change (LINA-148 hotfix history).

-- ── 1. version_no nullable + the draft ⟺ no-number invariant ────────────────
ALTER TABLE schedule.plan_version ALTER COLUMN version_no DROP NOT NULL;

-- ── 2. extend the status CHECK to admit 'draft' ─────────────────────────────
-- The inline column CHECK from 0003 is named plan_version_status_check. Drop and
-- re-add with 'draft' included (forward-only: this file is new, not an edit).
ALTER TABLE schedule.plan_version DROP CONSTRAINT plan_version_status_check;
ALTER TABLE schedule.plan_version ADD CONSTRAINT plan_version_status_check
  CHECK (status IN ('draft','proposed','withdrawn','rejected','superseded','accepted'));

-- A draft has no number; a numbered version is never a draft. Together with the
-- frozen_iff_accepted CHECK (0003) a draft is therefore never frozen (draft ≠
-- accepted), so frozen_at stays NULL for a draft with no extra clause needed.
ALTER TABLE schedule.plan_version ADD CONSTRAINT plan_version_draft_has_no_number
  CHECK ((status = 'draft') = (version_no IS NULL));

-- ── 3. at most one DRAFT per project — the single resumable workspace ────────
-- The one-open-proposal index (0003) stays WHERE status = 'proposed'; a draft is
-- NOT an open proposal, so drafting never trips it and never blocks review.
CREATE UNIQUE INDEX plan_version_one_draft_per_project
  ON schedule.plan_version (project_id) WHERE status = 'draft';

-- ── 4. a draft's stages are deletable; a frozen baseline's never are ─────────
-- DELETE is granted (was withheld in 0001) ONLY so `:author` can replace a
-- draft's stages in place. The trigger below is the real guard — defense in depth
-- over the app-level "only a draft" check, exactly as stage_freeze_guard guards
-- INSERT/UPDATE. Without it the bare DELETE grant would let a bug erase a frozen
-- baseline's stages; with it, a terminal/frozen version's stages can never be
-- deleted by any code path.
CREATE FUNCTION schedule.reject_frozen_stage_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schedule.plan_version v
     WHERE v.id = OLD.plan_version_id
       AND v.status IN ('accepted','superseded','withdrawn','rejected')
  ) THEN
    RAISE EXCEPTION 'stage % belongs to a frozen/terminal plan version — a baseline is changed, never deleted', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stage_freeze_delete_guard
  BEFORE DELETE ON schedule.stage
  FOR EACH ROW EXECUTE FUNCTION schedule.reject_frozen_stage_delete();

GRANT DELETE ON TABLE schedule.stage TO schedule_app;
