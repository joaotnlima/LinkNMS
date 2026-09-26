-- 0003 — project claim (to-be doc 14 Q4, doc 03 §Project).
--
-- A supplier may create a project on the owner's behalf (ProjectCreate.
-- on_behalf_of_owner_email). Until the owner claims it the project has no
-- owner_org_id and stays in draft; the pending email is WHO may claim it.
-- Cleared on claim — it never outlives its purpose.
ALTER TABLE project.project
  ADD COLUMN pending_owner_email text
    CHECK (pending_owner_email = lower(pending_owner_email));

-- One project cannot be both owned and claimable.
ALTER TABLE project.project
  ADD CONSTRAINT project_claim_xor_owner
    CHECK (NOT (owner_org_id IS NOT NULL AND pending_owner_email IS NOT NULL));
