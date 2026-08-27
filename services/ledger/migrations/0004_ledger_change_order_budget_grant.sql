-- 0004_ledger_change_order_budget_grant.sql — the budget-move seam for change_order_app
--
-- Slice 4's production wiring (LINA-51) commits the change_order projection write
-- and the ledger budget move in ONE cross-schema transaction (ADR-0006 §1): the
-- Change Order service opens the transaction on change_order_app and passes that
-- SAME connection to the Ledger port's append_event / record-budget-event path.
-- For that shared-connection write to succeed under least privilege,
-- change_order_app needs, in the ledger schema:
--
--   1. USAGE ON SCHEMA ledger — 0002_ledger_roles granted change_order_app EXECUTE
--      on ledger.append_event but NOT schema USAGE, so the EXECUTE could not
--      actually resolve. Same gap 0003 closed for identity_app; closed here for
--      change_order_app (and re-affirmed EXECUTE so this migration is legible on
--      its own — the GRANT is idempotent).
--   2. SELECT, INSERT, and UPDATE (audit_event_id) ON ledger.budget_event — the
--      ONE budget move an approved change order performs. `record_budget_event`
--      (in pg-ledger) INSERTs the budget_event and then UPDATEs its
--      audit_event_id back-link on the caller's transaction. Exactly-once is
--      still enforced by the schema's UNIQUE(change_order_id) regardless of which
--      role inserts, so a serverless retry can never double-apply. audit_event
--      stays write-locked: nobody, change_order_app included, may
--      INSERT/UPDATE/DELETE it — the only writer remains ledger.append_event
--      (SECURITY DEFINER).
--
--      ARCHITECT AMENDMENT (LINA-51 review): the UPDATE is scoped to the SINGLE
--      COLUMN the back-link needs. A table-wide `GRANT UPDATE` would let
--      change_order_app rewrite `delta_cents` or `project_id` on ANY existing
--      budget_event row — moving a project's budget with no audit_event behind
--      it, which is precisely the property this ledger exists to make
--      impossible. `record_budget_event` only ever writes audit_event_id
--      (pg-ledger.mjs, `update ledger.budget_event set audit_event_id = ...`),
--      so the column-scoped grant is exactly sufficient. A budget row's amount
--      is therefore append-only to its writer: insert once, never mutate.
--      With that narrowing this genuinely does not widen the trust anchor; it
--      opens the same narrow, already-sanctioned budget seam the Slice-4 design
--      assumed (design §5).
--
-- Lives in the ledger service (not change_order's) for the same reason 0003 does:
-- the runner applies services alphabetically (change_order, decision, identity,
-- ledger, …), so ledger.budget_event does not exist yet while change_order's own
-- migrations run. The trust anchor's grant matrix stays in one place, forward-only
-- (ADR-0002 §4, ADR-0006 §1). change_order_app is created up-front by db/roles.sql.
--
-- ARCHITECT REVIEW (LINA-51): SIGNED OFF as amended. This is an additive grant on
-- the ledger's budget_event to a second app role — the intended Slice-4 wiring,
-- not a schema change to any table — but it touches the ledger grant matrix, so
-- it carries the Architect's explicit approval per the "no cross-service change
-- without Architect visibility" rule.

GRANT USAGE ON SCHEMA ledger TO change_order_app;

GRANT EXECUTE ON FUNCTION
  ledger.append_event(uuid, text, uuid, timestamptz, jsonb, text) TO change_order_app;

GRANT SELECT, INSERT ON ledger.budget_event TO change_order_app;

-- Column-scoped: the audit_event_id back-link ONLY. Never delta_cents,
-- project_id, or change_order_id. See note 2 above — this is the load-bearing
-- half of "the budget cannot move without its audit event".
GRANT UPDATE (audit_event_id) ON ledger.budget_event TO change_order_app;
