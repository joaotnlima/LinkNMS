-- Change Order service — schema `change_order` (ADR-0003, ADR-0006 §1).
--
-- This service owns exactly one table. It NEVER writes `ledger.audit_event` or
-- `ledger.budget_event` directly — those are the Ledger & Budget service's
-- (Slice 1); the budget only moves through `ledger.append_event(...)` /
-- `ledger.record_budget_event(...)`. See services/change_order/README.md for the
-- typed ports this service consumes.
--
-- Applied by the `migrator` role (Slice 0). The `change_order` app role gets
-- USAGE on this schema only and INSERT/SELECT/UPDATE on this table; it holds no
-- grants on any other service's schema (ADR-0006 §1).

CREATE SCHEMA IF NOT EXISTS change_order;

CREATE TABLE change_order.change_order (
  id                     uuid PRIMARY KEY,
  project_id             uuid NOT NULL,
  -- Optional link to the decision this change order sources from (FR3). FK is
  -- cross-schema in R0's single instance; enforced by the Decision Log service
  -- interface, not a hard FK, so the split-DB seam (ADR-0006 §1) stays clean.
  decision_id            uuid,
  title                  text NOT NULL,
  -- Money is integer cents, always. Signed: a credit/de-scope is negative.
  cost_delta_cents       bigint NOT NULL,
  status                 text NOT NULL DEFAULT 'proposed'
                           CHECK (status IN ('proposed', 'approved', 'rejected')),
  proposed_by_party_id   uuid NOT NULL,
  decided_by_party_id    uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz,

  -- FR8 — scope / schedule / quality are captured for transparency and NEVER
  -- enter the budget total. Only cost_delta_cents ever reaches a budget_event.
  scope_impact_note      text,
  schedule_impact_days   integer,
  schedule_impact_note   text,
  quality_flag           boolean NOT NULL DEFAULT false,
  quality_note           text,

  -- Idempotency for the decision step: a serverless retry that replays
  -- POST /change-orders/:id/decision carries the same key, so the second attempt
  -- resolves to the first result instead of double-applying (or 409-ing a
  -- legitimate retry). NULL until the CO is decided; UNIQUE so a key is spent once.
  decision_idempotency_key text,

  -- FR4, enforced in the DATABASE, not just the service: a change order can be
  -- decided only by someone other than its proposer. Even if the service layer
  -- is bypassed, this CHECK rejects a forged decided_by = proposed_by.
  CONSTRAINT decided_by_is_not_proposer
    CHECK (decided_by_party_id IS NULL
           OR decided_by_party_id <> proposed_by_party_id),

  -- A decided CO must carry who + when; a proposed CO must not.
  CONSTRAINT decision_fields_consistent
    CHECK (
      (status = 'proposed'
         AND decided_by_party_id IS NULL AND decided_at IS NULL)
      OR
      (status IN ('approved', 'rejected')
         AND decided_by_party_id IS NOT NULL AND decided_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX change_order_decision_idempotency_key_uq
  ON change_order.change_order (decision_idempotency_key)
  WHERE decision_idempotency_key IS NOT NULL;

CREATE INDEX change_order_project_created_idx
  ON change_order.change_order (project_id, created_at, id);

-- NOTE for Slice 1 (Ledger & Budget): `ledger.budget_event` carries
-- `UNIQUE(change_order_id)` so an approved CO moves the budget exactly once,
-- ever. That uniqueness lives in the ledger schema (its owner), not here.
