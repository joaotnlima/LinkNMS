-- 0012 — Changes against the baseline, shown in the plan (PRD-13, D-43, D-44).
--
-- Three additive changes to planning.*:
--
--   1. planning.baseline.reason gains 'award' — D-43: the baseline of an
--      awarded branch is taken AT AWARD (the winning proposal's start and
--      duration), amending D-13 (signature) while contracts are parked. The
--      (contract_id, version) key is unchanged: the award already drafts the
--      contract, so the award baseline is that contract's v1 and a later
--      signature finds it baselined (idempotent).
--
--   2. planning.variation.cause gains 'closed_late' — PRD-13 §5: when a row is
--      closed with an actual finish past its baseline finish, the time
--      variation says so instead of a plain 'direct'.
--
--   3. planning.variation.reason — PRD-13 S-11: the optional "why" the author
--      gave with the latest direct date change. Nullable, short free text; the
--      full trail stays in the ledger entry of each change.
--
-- Forward-only, no data rewrite: every existing row satisfies the widened
-- checks, and reason starts NULL.

ALTER TABLE planning.baseline
  DROP CONSTRAINT baseline_reason_check,
  ADD CONSTRAINT baseline_reason_check
    CHECK (reason IN ('contract_signed', 'change_order', 'award'));

ALTER TABLE planning.variation
  DROP CONSTRAINT variation_cause_check,
  ADD CONSTRAINT variation_cause_check
    CHECK (cause IN ('direct', 'propagated', 'closed_late'));

ALTER TABLE planning.variation
  ADD COLUMN reason text
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500);
