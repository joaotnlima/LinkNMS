-- 0003_ledger_identity_grant.sql — extend the append_event seam to identity_app
--
-- Identity (Slice 2, LINA-37) produces hash-chained events (project_created,
-- member_joined) and, like decision_app and change_order_app, may ONLY write the
-- audit trail through ledger.append_event (SECURITY DEFINER, owned by the
-- migrator). 0002_ledger_roles.sql enumerated EXECUTE for
-- ledger_app/decision_app/change_order_app but predates the identity service, so
-- identity_app was omitted. This forward migration closes that gap.
--
-- It lives in the ledger service (not identity's) on purpose: the runner applies
-- services alphabetically (change_order, decision, identity, ledger, schedule),
-- so ledger.append_event does not exist yet while identity's migrations run. The
-- trust anchor's grant matrix therefore stays in one place and the forward pass
-- stays ordered (ADR-0002 §4, ADR-0006 §1). identity_app is created up-front by
-- db/roles.sql, so it already exists here.

GRANT USAGE ON SCHEMA ledger TO identity_app;
GRANT EXECUTE ON FUNCTION
  ledger.append_event(uuid, text, uuid, timestamptz, jsonb, text) TO identity_app;
