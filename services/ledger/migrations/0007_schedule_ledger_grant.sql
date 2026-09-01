-- 0007_schedule_ledger_grant.sql — extend the append_event seam to schedule_app
--
-- Schedule & Progress (Slice 6, LINA-69) produces hash-chained audit events
-- (stage_added, stage_updated, progress_reported) and, exactly like
-- identity_app / decision_app / change_order_app, may ONLY write the audit trail
-- through ledger.append_event (SECURITY DEFINER, owned by the migrator). Every
-- plan/progress write is ledgered in the SAME transaction as its projection update
-- (spec §8.2), and the connection that write runs on is schedule_app's own pool —
-- so this grant is what lets that append land.
--
-- It lives in the ledger service (not schedule's) on purpose: the runner applies
-- services alphabetically (change_order, decision, identity, ledger, schedule), so
-- ledger.append_event exists by the time this runs, and the trust anchor's grant
-- matrix stays in one place (ADR-0002 §4, ADR-0006 §1). schedule_app is created
-- up-front by db/roles.sql, so it already exists here.
--
-- NOTE what is deliberately ABSENT: no budget-MOVE grant (INSERT / UPDATE / DELETE)
-- on ledger.budget_event to schedule_app — only the read-only SELECT below. Schedule
-- & Progress must be structurally incapable of moving the budget (spec §2 Q2,
-- AC-P5 / AC-P12); reading the authoritative number for the FR-P6 hint cannot move
-- it. The money gate stays the change order: only change_order_app holds the
-- budget-move (write) grants (0004).

GRANT USAGE ON SCHEMA ledger TO schedule_app;
GRANT EXECUTE ON FUNCTION
  ledger.append_event(uuid, text, uuid, timestamptz, jsonb, text) TO schedule_app;

-- The current-budget summary the plan surface shows as a read-only allocation hint
-- (FR-P6) is the ledger's authoritative number — Schedule never re-sums it. Schedule
-- reads it through its Ledger binding, which runs on schedule_app's OWN pool (see
-- services/gateway/container.mjs: ledgerFor(pools.schedule)), so schedule_app itself
-- needs SELECT on the same rows change_order_app/identity_app read for their budget
-- summaries.
GRANT SELECT ON ledger.project_audit TO schedule_app;
GRANT SELECT ON ledger.budget_event  TO schedule_app;
