-- 0028 — What a question is about (PRD-12 N-5, flows C16–C17).
--
-- Ownership: Collaboration (doc 08). collaboration.comment gains:
--
--   topic    — clarification | design_change | scope_gap, on questions only
--              (every existing question back-fills to `clarification`, the
--              default). A scope gap is addressed to the project owner — the
--              use case routes it; the column only records the kind.
--   decision — approved | rejected: the addressee's answer to a design-change
--              question, kept on the QUESTION row (the answer comment stays the
--              words). Only on design_change, only once answered.
--
-- Forward-only. No GRANTs (single application pool, see 0008).

ALTER TABLE collaboration.comment
  ADD COLUMN topic    text CHECK (topic IN ('clarification', 'design_change', 'scope_gap')),
  ADD COLUMN decision text CHECK (decision IN ('approved', 'rejected'));

UPDATE collaboration.comment SET topic = 'clarification' WHERE kind = 'question';

ALTER TABLE collaboration.comment
  ADD CONSTRAINT comment_topic_on_questions CHECK ((kind = 'question') = (topic IS NOT NULL)),
  ADD CONSTRAINT comment_decision_on_design_change
    CHECK (decision IS NULL OR (topic = 'design_change' AND question_status IN ('answered', 'resolved')));

CREATE INDEX comment_question_addressee_idx ON collaboration.comment (addressee_org_id, created_at DESC)
  WHERE kind = 'question';
