-- LINA-96 — least-privilege waitlist role.
--
-- Replaces the Neon-console-provisioned `landing_app`, which inherited
-- `neon_superuser` and therefore bypassed every grant in the database —
-- including ledger.append_event's write guard (LINA-35). The public signup
-- form's credential could read and rewrite ledger.audit_event, identity,
-- decision and change_order: the marketing role could forge the trust anchor.
--
-- neon_superuser cannot be revoked (only a role with ADMIN on it may, and
-- nothing reachable has that), so the fix is a replacement role created BY SQL:
-- SQL-created roles never inherit neon_superuser; console/API-created ones
-- always do. That asymmetry was the whole bug.
--
-- Run as the `landing` schema owner (neondb_owner). Only the object owner can
-- GRANT on landing.signups — `migrator` is a neon_superuser *member* but not a
-- true superuser (rolsuper = f), so its GRANTs here no-op with a warning.
--
--   psql "$NEON_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f marketing-site/drizzle/0002_landing_app_role.sql
--
-- The role is also declared in db/roles.sql (the role registry); both paths
-- converge via IF NOT EXISTS. The LOGIN password is attached out-of-band by the
-- provisioner (the Vercel DATABASE_URL secret) — never committed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'landing_app_v2') THEN
    CREATE ROLE landing_app_v2 NOLOGIN;
  END IF;
END $$;

GRANT CONNECT ON DATABASE neondb TO landing_app_v2;
GRANT USAGE ON SCHEMA landing TO landing_app_v2;

-- Exactly what the two routes do, verified against the code:
--   api/waitlist: SELECT (dupe check on email_norm) + INSERT
--   api/confirm : SELECT (by confirm_token) + UPDATE (status/confirmed_at/confirm_token)
-- No DELETE. No sequence grant — id is uuid DEFAULT gen_random_uuid(), not serial.
GRANT SELECT, INSERT, UPDATE ON landing.signups TO landing_app_v2;
