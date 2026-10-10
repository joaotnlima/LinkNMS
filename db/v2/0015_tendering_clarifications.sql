-- 0015 — Clarifications from the personal link (PRD-08 H-6..H-9).
--
-- Until now only a platform org could ask (askClarification needs a session),
-- so tendering.clarification.asked_by_org_id was NOT NULL. A bidder who holds
-- only the emailed personal link has no org, yet must be able to ask too
-- (askClarificationByToken). So a question now records WHO asked as either:
--
--   asked_by_org_id        — the bidder org (authed ask; also set on a token
--                            ask when the recipient row carries an org), or
--   asked_by_recipient_id  — the personal-link recipient (token ask).
--
-- At least one is present. Neither is ever on the wire (the projection only
-- says `mine` to the asker itself — V8, PRD-08 H-7).
--
-- asked_at orders the list and dates each question; existing rows take the
-- migration moment (no better fact exists for them).
--
-- v2 runs a single application pool: no per-module role yet, so no GRANTs
-- (see 0008_project_phases_signoff.sql). Forward-only, no data rewrite.

ALTER TABLE tendering.clarification
  ALTER COLUMN asked_by_org_id DROP NOT NULL,
  ADD COLUMN asked_by_recipient_id uuid REFERENCES tendering.rfp_recipient(id),
  ADD COLUMN asked_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT clarification_has_asker
    CHECK (asked_by_org_id IS NOT NULL OR asked_by_recipient_id IS NOT NULL),
  ADD CONSTRAINT clarification_question_len
    CHECK (char_length(question) BETWEEN 1 AND 4000);

CREATE INDEX clarification_rfp_idx ON tendering.clarification (rfp_id, status);
