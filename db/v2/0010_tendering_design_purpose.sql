-- 0010 — Design (pre-construction) tendering: purpose + mode discriminator.
--
-- D-39 (doc 23) ratifies one RFP engine, two purposes: `design`
-- (pre-construction — the deliverable is the project itself: drawings + a
-- material spec, priced as a *service*) and `execution` (the as-is flow: plan
-- rows priced as a Bill of Quantities, awarded into a contract + baseline).
-- Until now every RFP was implicitly `execution`; the two shapes shared one
-- `tendering.proposal` table, distinguished only by which child rows existed
-- (summary fields vs priced `proposal_line` BoQ). LINA-407 makes the intent
-- explicit so the whole system — composer, public form, comparison renderer,
-- inbox — can key off it instead of inferring from populated children.
--
-- Two orthogonal-but-linked columns:
--   purpose  design | execution — WHAT is being tendered (a service vs built work)
--   mode     light  | detailed  — HOW a bid is shaped: a light bid is a fee
--            lump-sum + portfolio + references + a proposal PDF (no BoQ); a
--            detailed bid prices the BoQ line-by-line (the as-is).
-- A design RFP is always light (D-39: a design proposal prices a service, never
-- a BoQ of built quantities), pinned by rfp_design_is_light. Execution stays
-- detailed by default — the value both back-fill to on existing rows, so the
-- live execution tenders (LINA-360/371/372/406) are untouched.
--
-- Additive only: both columns carry NOT NULL defaults, so the Casa-Silva seed
-- and db/v2/checks.sql are unaffected (no check enumerates rfp columns).

ALTER TABLE tendering.rfp
  ADD COLUMN purpose text NOT NULL DEFAULT 'execution'
    CHECK (purpose IN ('design', 'execution')),
  ADD COLUMN mode    text NOT NULL DEFAULT 'detailed'
    CHECK (mode IN ('light', 'detailed'));

ALTER TABLE tendering.rfp
  ADD CONSTRAINT rfp_design_is_light CHECK (purpose <> 'design' OR mode = 'light');

-- A light bid answers with referenceable past work / client contacts alongside
-- the fee and the portfolio+PDF attachments (already carried by document_ids +
-- tendering.proposal_document, 0008). Free text — the bidder lists comparable
-- projects and who to call; nullable, only ever populated on a light bid.
ALTER TABLE tendering.proposal
  ADD COLUMN reference_notes text;
