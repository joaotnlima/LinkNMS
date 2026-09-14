-- RFP specialty tags + the awarded-proposal marker (LINA-279 / LINA-280;
-- ADR-0023 §2, slice-procurement-contract §3 "Two gaps").
--
-- Both close gaps the FE slice contract surfaced after migration 0012 shipped:
--
--   1. rfp.specialties — the trade tags the composer collects. The FE types the
--      field as REQUIRED because a tag editor that silently drops what was typed
--      would be worse than no tag editor. text[] because one brief may ask for
--      several trades at once.
--
--   2. rfp.selected_proposal_id — the permanent answer to "which bid won".
--      The inbox keeps EVERY proposal forever (the losers are the evidence
--      behind the choice), so the winner must be a first-class, readable value
--      rather than something scraped out of plan_change_log.
--
-- Stored on `rfp`, deliberately NOT on rfp_proposal:
--   * schedule.rfp_proposal is append-only by grant (SELECT+INSERT) — a
--     selected_at column there would have needed an UPDATE grant, loosening the
--     immutability of the submitted bid rows.
--   * schedule.rfp already carries UPDATE for its draft→sent→closed walk, so
--     closing + marking the winner is one guarded UPDATE, no grant change.
--   * A skip-to-execution build (Persona B, no RFP) leaves it NULL — that IS the
--     distinction the inbox needs ("selected" vs "skipped").
--
-- Forward-only. Applied by the `migrator` role; reviewed & applied to Neon by
-- the Full-Stack Architect. Head migration is schedule/0012.
ALTER TABLE schedule.rfp
  ADD COLUMN specialties        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN selected_proposal_id uuid REFERENCES schedule.rfp_proposal (id);

COMMENT ON COLUMN schedule.rfp.specialties IS
  'Trade tags on the brief (composer gap, LINA-279). text[] — one brief may ask for several trades.';
COMMENT ON COLUMN schedule.rfp.selected_proposal_id IS
  'The awarded proposal when this RFP closed with a winner (LINA-280). NULL on skip-to-execution. Written in the SAME transaction as status = closed.';