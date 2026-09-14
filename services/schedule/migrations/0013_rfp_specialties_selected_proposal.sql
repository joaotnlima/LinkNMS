-- RFP specialties, selected-proposal marker & recipient-removal grant (LINA-279
-- procurement surface; FE contract ratified).
--
-- Three backfills to schedule.rfp / schedule.rfp_recipient that the procurement
-- surface needs and 0012 did not anticipate:
--
--   * schedule.rfp.specialties        — the service category/ies the builder can
--     deliver ("Cadiz bathroom remodels …"), a free-text list FED on the
--     procurement accordion alongside `description`. Presented verbatim to
--     contractors on the public token page.
--   * schedule.rfp.selected_proposal_id — the winning proposal (owner picks via
--     the LINA-280 ballot; the executor displays the winner's quote). A nullable
--     FK to schedule.rfp_proposal; NULL until a selection is made. Selection and
--     its re-vote surface land in LINA-280 — the column is reserved here so the
--     procurement view can expose it without a later column-add on a populated
--     table.
--   * GRANT DELETE on rfp_recipient — the procurement surface's one removal
--     route: an owner/GC deletes a DRAFT-era recipient to fix a typo'd email and
--     re-invite with the correct one. This is the SINGLE deliberate DELETE grant
--     relaxation in the RFP corpus; 0012 granted none. It is scoped to
--     rfp_recipient ONLY — append-only discipline still holds for
--     phase_sign_off_request, rfp_proposal and plan_change_log (no DELETE), and
--     rfp/phase/recipient status walks still happen exclusively via UPDATE (a
--     recipient row is NEVER deleted once its RFP is sent — the service
--     enforces that; the grant cannot express it, the code does).
--
-- rfp_proposal.id is already PK-indexed, so the new FK needs no index of its
-- own. Both new columns are NOT NULL WITH DEFAULT, so existing rows backfill on
-- apply and the migrator restart-gate (0045_default_in_backfill) stays happy.
--
-- Forward-only. Applied by the `migrator` role; drafted by BE, reviewed &
-- applied to Neon by the Full-Stack Architect. NEVER edit an applied migration —
-- the prod schema-gate byte-checksum guard halts ALL migrates if an applied
-- file's bytes change. Previous head migration is schedule/0012.

ALTER TABLE schedule.rfp
  ADD COLUMN specialties text[] NOT NULL DEFAULT '{}',
  ADD COLUMN selected_proposal_id uuid REFERENCES schedule.rfp_proposal (id);

COMMENT ON COLUMN schedule.rfp.specialties IS
  'Service category/ies the builder can deliver, free-text, FED on the procurement accordion and shown verbatim to contractors on the public token page (LINA-279).';

COMMENT ON COLUMN schedule.rfp.selected_proposal_id IS
  'Winning proposal after the owner''s selection (LINA-280 ballot). NULL until selected. Reserved in the procurement surface so the view can expose it without a column-add on a populated table.';

-- The single deliberate DELETE relaxation in the RFP corpus (only this table;
-- the append-only set keeps SELECT+INSERT-only grants from 0012).
GRANT DELETE ON TABLE schedule.rfp_recipient TO schedule_app;