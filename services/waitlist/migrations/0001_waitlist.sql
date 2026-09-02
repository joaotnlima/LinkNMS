-- Waitlist service — schema `waitlist` (LINA-127; Onboarding Plan v4 Phase 1).
--
-- The portal's own waitlist: the authoritative table behind the D-4 email-capture
-- form and the D-2 welcome-email trigger, distinct from the legacy marketing-site
-- `landing.signups` (LINA-34) that this supersedes on the Portal path.
--
-- Data model (per the issue / accepted plan):
--   * email            — as entered
--   * email_norm       — normalized dedupe key, UNIQUE (enforced in the DB)
--   * status           — 'waitlisted' on signup, flips to 'active' on first
--                        login (the plan's lifecycle); never anything else (CHECK)
--   * created_at       — server clock
--   * signup_order     — monotonic, gap-free identity counter. The plan selects
--                        "the first 10 waitlisted users, by signup order" on the
--                        go-date, so order must be a deterministic total order,
--                        not a timestamp that two rows can share (same discipline
--                        as decision.seq / change_order.seq).
--
-- Applied by the `migrator` role. The `waitlist` app role gets USAGE on this
-- schema only and SELECT/INSERT/UPDATE on this table; it holds no DELETE and no
-- grant on any sibling schema (ADR-0006 §1).

CREATE SCHEMA IF NOT EXISTS waitlist;

-- The app role. Declared here (not in db/roles.sql) so a SQL-created role never
-- inherits neon_superuser (LINA-96), and in db/roles.sql's registry array too so
-- the role model records it; both paths converge via IF NOT EXISTS. Credentials
-- are attached out-of-band by the provisioner — never committed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waitlist_app') THEN
    CREATE ROLE waitlist_app NOLOGIN;
  END IF;
END $$;
-- `GRANT CONNECT ON DATABASE current_database()` is not valid SQL — the ON
-- DATABASE clause needs a literal identifier, so the database name is resolved
-- through format() inside the DO block (same pattern as db/roles.sql).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO waitlist_app', current_database());
END $$;
GRANT USAGE ON SCHEMA waitlist TO waitlist_app;

CREATE TABLE IF NOT EXISTS waitlist.signup (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The normalized dedupe key, unique, is what makes a duplicate impossible at
  -- the database (the plan's "check for duplicates" is enforced here, not just
  -- by the service).
  email         text NOT NULL,
  email_norm    text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'waitlisted'
                  CHECK (status IN ('waitlisted', 'active')),
  -- Monotonic insertion order within the table. `created_at` alone is not a total
  -- order (two signups can share a microsecond), so "first 10 by signup order"
  -- tie-breaks on this gap-free counter, never on the random `id` or a timestamp.
  signup_order  bigint GENERATED ALWAYS AS IDENTITY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz
);

-- The plan's "first 10, by signup order" on the go-date reads signup_order
-- directly; the index makes the active/waitlisted split cheap for the batch query.
CREATE INDEX IF NOT EXISTS signup_status_order_idx
  ON waitlist.signup (status, signup_order);

-- Least-privilege grants. The service only ever INSERTs a new signup (status
-- waitlisted) and later UPDATEs it to active on first login (Phase 2). No DELETE:
-- a waitlist seat, once created, is never removed — history is kept.
REVOKE ALL ON TABLE waitlist.signup FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE waitlist.signup TO waitlist_app;
