-- LinkNMS — DB roles (Slice 0, ADR-0006 §1).
--
-- Ownership model, enforced by Postgres itself:
--   * `migrator` OWNS every schema, table, and SECURITY DEFINER function. It is
--     the ONLY role that runs DDL. Migrations connect as this role (in prod it is
--     the provisioned owner; on Neon, pgcrypto and friends are pre-authorized).
--   * One app role per service — `<service>_app` — that a serverless function
--     connects with at runtime. Each gets USAGE on its OWN schema only (granted in
--     db/0001_platform.sql) and least-privilege table grants from its own service
--     migration. It can NEVER reach across the split-DB seam (ADR-0006 §1): no
--     USAGE, no SELECT on a sibling schema. That isolation is a database fact, not
--     a code convention. The ledger's `ledger_app` is the sharp example — it may
--     SELECT the audit trail and EXECUTE append_event, but holds no INSERT on the
--     trust anchor (ADR-0002 §4); see services/ledger/migrations/0002_ledger_roles.sql.
--
-- SECURITY: roles are created NOLOGIN and passwordless here. The provisioner
-- (Vercel/Neon) attaches credentials out-of-band from the secret manager. Never
-- commit a password. Where CREATE ROLE needs the platform owner, run this once
-- per environment as that owner. Idempotent — safe to re-run.

DO $$
DECLARE
  r text;
  app_roles text[] := ARRAY[
    'identity_app', 'decision_app', 'change_order_app', 'ledger_app', 'schedule_app'
  ];
BEGIN
  -- The one DDL owner.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
    CREATE ROLE migrator NOLOGIN;
  END IF;

  -- One least-privilege app role per service (matches each service migration's
  -- `create role <service>_app if not exists`, so both paths converge).
  FOREACH r IN ARRAY app_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), r);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
  END LOOP;
END
$$;
