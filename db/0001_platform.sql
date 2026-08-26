-- LinkNMS — platform bootstrap (Slice 0, ADR-0006 §1).
--
-- Run as `migrator`. Creates the migration ledger and the five service schemas,
-- and grants each app role USAGE on ITS OWN schema only — the cross-schema
-- isolation guarantee. Table DDL and per-table grants live in each service's own
-- migration (services/<svc>/migrations/NNNN_*.sql); this file owns only the
-- cross-cutting platform surface. Forward-only.

-- ── Platform schema: the migration ledger ────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.schema_migrations (
  filename    text PRIMARY KEY,          -- e.g. 'services/ledger/migrations/0001_ledger.sql'
  checksum    text NOT NULL,             -- sha256 of the file at apply time
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user
);

-- The migration ledger is migrator-only; app roles never read or write it.
REVOKE ALL ON SCHEMA platform FROM PUBLIC;

-- ── The five service schemas ─────────────────────────────────────────────────
-- Created here so "all five schemas migrated" holds after Slice 0 alone, even for
-- services whose tables land in a later slice. Owned by the migrator.
CREATE SCHEMA IF NOT EXISTS identity     AUTHORIZATION migrator;
CREATE SCHEMA IF NOT EXISTS decision     AUTHORIZATION migrator;
CREATE SCHEMA IF NOT EXISTS change_order AUTHORIZATION migrator;
CREATE SCHEMA IF NOT EXISTS ledger       AUTHORIZATION migrator;
CREATE SCHEMA IF NOT EXISTS schedule     AUTHORIZATION migrator;

-- Deny-by-default, then grant exactly one schema to exactly one app role. An app
-- role gets USAGE on its OWN schema and nothing on any sibling — no cross-schema
-- SELECT is even resolvable (ADR-0006 §1). Table-level DML is granted per-table
-- in each service migration (least privilege); the ledger schema is deliberately
-- left with USAGE only here — its audit_event trust anchor is write-guarded and
-- all of its grants are set by hand in services/ledger (ADR-0002 §4).
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT * FROM (VALUES
      ('identity',     'identity_app'),
      ('decision',     'decision_app'),
      ('change_order', 'change_order_app'),
      ('ledger',       'ledger_app'),
      ('schedule',     'schedule_app')
    ) AS t(schema_name, app_role)
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', m.schema_name);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', m.schema_name, m.app_role);
  END LOOP;
END
$$;
