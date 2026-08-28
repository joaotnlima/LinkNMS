-- Let the login role assume each `<service>_app` role (LINA-56).
--
-- ⚠️ ARCHITECT REVIEW REQUESTED — this changes role membership, not table grants.
--
-- WHY THIS IS NEEDED
--
-- db/roles.sql creates `ledger_app` / `identity_app` / `decision_app` /
-- `change_order_app` as NOLOGIN roles: they hold the least-privilege grant matrix
-- but cannot open a connection of their own. Until now nothing connected AS them,
-- so the whole grant matrix was, in practice, unenforced at runtime — every
-- service connected as `migrator`, which owns every table. The privilege
-- separation existed in the migrations and nowhere else.
--
-- Mounting the HTTP surface is the moment that has to become real. The API
-- connects once as the login role and each service pool immediately issues
-- `SET ROLE <service>_app` (services/ledger/db.mjs), so from its first query a
-- service holds ONLY its own privileges. `SET ROLE` requires the login role to be
-- a MEMBER of the target role — hence this file.
--
-- WHY THIS DOES NOT WEAKEN ANYTHING
--
-- `migrator` owns these tables and already holds strictly more privilege than any
-- app role; membership grants it nothing it could not already do. The direction
-- that matters is the other one, and it is unchanged: an app role still cannot
-- assume `migrator`, still cannot INSERT into ledger.audit_event, and
-- change_order_app still holds UPDATE on only budget_event.audit_event_id.
--
-- WHAT THIS IS NOT: it is NOT a grant of `neon_superuser` to an app role.
-- Members of neon_superuser bypass `append_event`'s write guard entirely
-- (finding from LINA-35), which would silently void the hash chain.
--
-- The alternative — giving each app role LOGIN and a password — was not taken:
-- four separate credentials per environment, four connection pools' worth of
-- Neon connection budget, and a secret-rotation surface four times larger, to
-- buy a property SET ROLE already gives us. If the Architect prefers real login
-- roles, this file is the thing to revert; the `role:` option in db.mjs simply
-- goes unused and DATABASE_URL-per-service takes over.
--
-- Forward-only. Idempotent: GRANT of an already-held role membership is a no-op.

DO $$
DECLARE
  login_role text := current_user;   -- whoever runs the migrations
  app_role   text;
BEGIN
  FOREACH app_role IN ARRAY ARRAY['ledger_app', 'identity_app', 'decision_app', 'change_order_app']
  LOOP
    -- Skip cleanly if an environment has not provisioned every service role yet,
    -- rather than failing the whole migration run on a role that does not exist.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
      EXECUTE format('GRANT %I TO %I', app_role, login_role);
    END IF;
  END LOOP;
END
$$;
