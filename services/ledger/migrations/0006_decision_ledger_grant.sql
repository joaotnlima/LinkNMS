-- The two grant gaps that only a real role-separated run could expose (LINA-56).
--
-- ⚠️ ARCHITECT REVIEW REQUESTED — grant matrix change.
--
-- Both of these were invisible until services/gateway/container.test.mjs became
-- the first thing to connect AS the `<service>_app` roles instead of as the
-- table-owning `migrator`. Every prior suite ran as the owner, so it had every
-- privilege and could not see a missing one. This is the same class of gap that
-- bit LINA-37 and LINA-51; the fix for both of those (0003, 0004) simply never
-- covered the two cases below.
--
-- ── 1. decision_app: EXECUTE without schema USAGE is not executable ──────────
-- 0002_ledger_roles.sql granted `decision_app` EXECUTE on ledger.append_event,
-- and db/0001_platform.sql grants each app role USAGE on ITS OWN schema only.
-- Nothing ever granted decision_app USAGE on schema `ledger`, and in Postgres
-- EXECUTE on a function you cannot reach through its schema is dead privilege:
-- every Decision Log write failed with `42501 permission denied for schema
-- ledger` the moment it tried to chain its event. 0003 fixed exactly this for
-- identity_app and 0004 for change_order_app — decision_app was simply missed.
--
-- Note what is NOT granted: no SELECT, INSERT, UPDATE or DELETE on any ledger
-- table. The Decision Log may call append_event and nothing else, so the chain
-- stays append-only through its one sanctioned writer (ADR-0002 §4).
GRANT USAGE ON SCHEMA ledger TO decision_app;

-- ── 1b. Reading the trail: the VIEW, for every service that derives from it ──
-- 0002_ledger_roles.sql granted SELECT on ledger.project_audit to ledger_app
-- only. But the authoritative budget (baseline from the `project_created`
-- genesis payload + Σ budget_event) is computed by each service through its OWN
-- ledger binding, so Identity (project summary), Decision and Change Order all
-- read the chain too. They read it through the view — the base table
-- ledger.audit_event stays unreadable to every app role (ADR-0002 §4).
GRANT SELECT ON ledger.project_audit TO decision_app, identity_app, change_order_app;

-- …and the budget projection it sums. `currentBudget` = baseline (from the
-- genesis payload, read via the view above) + Σ ledger.budget_event.delta_cents,
-- and Identity serves that total on GET /projects/:id. change_order_app already
-- holds SELECT here (0004); identity_app and decision_app never did.
--
-- READ ONLY, deliberately. Neither role gets INSERT or UPDATE: the budget moves
-- in exactly one place — the change-order approval path — and that stays true.
--
-- This one is worth dwelling on because of HOW it hid. All four services share a
-- single ledger cache (services/gateway/container.mjs), so once any service with
-- the grant had computed a project's budget, every other service read it from
-- memory and never touched the table. The missing privilege therefore surfaced
-- only on a cold cache — a 500 that appears under a cache miss and vanishes on
-- retry. Asserting it here means it cannot come back as a heisenbug.
GRANT SELECT ON ledger.budget_event TO identity_app, decision_app;

-- ── 2. change_order_app: no grants on its OWN table ─────────────────────────
-- services/change_order/migrations/0001_change_order.sql creates
-- change_order.change_order but sets no table grants, so change_order_app held
-- USAGE on the schema and nothing on the table inside it — `42501 permission
-- denied for table change_order` on the first propose. It went unnoticed because
-- LINA-51's pg-store tests connect as the migrator, which owns the table.
--
-- SELECT/INSERT/UPDATE, and deliberately NO DELETE: a change order's status
-- moves (proposed → approved/rejected) so UPDATE is required, but a change order
-- is a record of what was agreed and must never be removable by the service.
REVOKE ALL ON TABLE change_order.change_order FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE change_order.change_order TO change_order_app;
