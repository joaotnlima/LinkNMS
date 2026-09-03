-- Auth service — RBAC mirror (LINA-143; Auth Bridge §4; Architect LINA-142 §8.4).
--
-- The authorization plane of the Clerk → Neon bridge. Clerk answers "who are
-- you?" (`@clerk/backend` JWT verification); THIS schema answers "what may you
-- do here?" — the sole source of authorization verdicts, deny-by-default.
--
-- SCHEMA NAMESPACE (Architect-ratified §8.4): the RBAC tables live under a NEW
-- `authz` schema, NOT the live `identity` schema. `identity` is a live schema
-- whose 5 migrations the ledger grants depend on (0003_ledger_identity_grant.sql);
-- overloading it in place with new-shape RBAC tables would be a big-bang mutation
-- of a namespace the audit ledger relies on. The Clerk-mirrored `users`/`orgs`
-- and the authz catalog are new objects here, and the legacy `identity` tables are
-- NOT touched (their retirement is a separate, Architect-gated migration).
--
-- ROLES: `authz_app` is the runtime role for the auth path — `can()` READS the
-- catalog, and the Clerk webhook / JIT sync WRITES users/orgs/memberships. It is
-- created in db/roles.sql alongside the other app roles and granted USAGE below.
--
-- Forward-only: new schema, new tables. No cross-schema FK (bare uuids), matching
-- ADR-0006 §1's split-DB seam.

CREATE SCHEMA IF NOT EXISTS authz;
REVOKE ALL ON SCHEMA authz FROM PUBLIC;
GRANT USAGE ON SCHEMA authz TO authz_app;

-- ── users: local mirror of a Clerk user ───────────────────────────────────────
-- Clerk is the system of record for identity; this row keys on clerk_user_id.
-- `status` is our enforcement flag: 'disabled' freezes access regardless of Clerk
-- state (revocation is a flip, never a DELETE — integrity, ADR-0002).
CREATE TABLE IF NOT EXISTS authz.users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id  text        NOT NULL UNIQUE CHECK (length(btrim(clerk_user_id)) > 0),
  email          text        NOT NULL CHECK (length(btrim(email)) > 0),
  display_name   text,
  status         text        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalised CHECK (
    email = lower(email) AND length(btrim(email)) > 0 AND position('@' in email) > 1
  )
);

CREATE INDEX IF NOT EXISTS authz_users_email_idx ON authz.users (email);

-- ── orgs: local mirror of a Clerk Organization ────────────────────────────────
-- We mirror clerk_org_id rather than own org lifecycle (Auth Bridge §6) so Clerk
-- keeps the org-invitation email flow (LINA-130); authorization still resolves here.
CREATE TABLE IF NOT EXISTS authz.orgs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_org_id  text        NOT NULL UNIQUE CHECK (length(btrim(clerk_org_id)) > 0),
  name          text        NOT NULL CHECK (length(btrim(name)) > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── roles: named roles, optionally scoped to an org ───────────────────────────
-- NULL org_id = a SYSTEM role (seeded here: owner, gc, subcontractor). Org-scoped
-- roles carry a non-null org_id. UNIQUE(org_id, key) covers org-scoped; the
-- partial index below closes the NULL gap so a system role key cannot be duped.
CREATE TABLE IF NOT EXISTS authz.roles (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        REFERENCES authz.orgs(id) ON DELETE CASCADE,
  key        text        NOT NULL CHECK (length(btrim(key)) > 0),
  name       text        NOT NULL CHECK (length(btrim(name)) > 0),
  UNIQUE (org_id, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS authz_roles_system_key_uniq
  ON authz.roles (key) WHERE org_id IS NULL;

-- ── permissions: fine-grained verbs ───────────────────────────────────────────
-- e.g. 'project.create', 'change_order.decide'. Deny-by-default: a verb a role
-- never grants is, by construction, forbidden (Auth Bridge §3 `can()`).
CREATE TABLE IF NOT EXISTS authz.permissions (
  id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key      text        NOT NULL UNIQUE CHECK (length(btrim(key)) > 0),
  descr    text
);

-- ── role_permissions: which permissions a role grants ─────────────────────────
CREATE TABLE IF NOT EXISTS authz.role_permissions (
  role_id       uuid NOT NULL REFERENCES authz.roles(id)       ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES authz.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ── memberships: a user's role within an org ──────────────────────────────────
-- The Owner/GC/Subcontractor mapping. One role per user per org in v1
-- (UNIQUE(user_id, org_id)); multi-role can relax later (Architect §8.3 debt).
CREATE TABLE IF NOT EXISTS authz.memberships (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES authz.users(id) ON DELETE CASCADE,
  org_id     uuid        NOT NULL REFERENCES authz.orgs(id)  ON DELETE CASCADE,
  role_id    uuid        NOT NULL REFERENCES authz.roles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS authz_memberships_org_idx ON authz.memberships (org_id);
CREATE INDEX IF NOT EXISTS authz_memberships_role_idx ON authz.memberships (role_id);

-- ── resource_acls: per-resource overrides on top of role grants ──────────────
-- `effect` allow|deny; deny always wins in `can()`'s evaluation order:
--   resource_acls deny → resource_acls allow → role/permission grant → deny.
-- `resource_id` is deliberately a bare uuid (no cross-schema FK).
CREATE TABLE IF NOT EXISTS authz.resource_acls (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES authz.users(id) ON DELETE CASCADE,
  resource_type text        NOT NULL CHECK (length(btrim(resource_type)) > 0),
  resource_id   uuid        NOT NULL,
  permission_id uuid        NOT NULL REFERENCES authz.permissions(id) ON DELETE CASCADE,
  effect        text        NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'deny')),
  UNIQUE (user_id, resource_type, resource_id, permission_id)
);

-- ── Least-privilege grants: authz_app ─────────────────────────────────────────
-- `authz_app` READS the whole catalog for `can()`, and the Clerk webhook / JIT
-- sync (LINA-143) WRITES users/orgs/memberships. roles/permissions/
-- role_permissions are SELECT-only: the verb/role catalog is seeded by the
-- migrator out of band (like identity.seat), so a request-path bug can never
-- grant itself a permission. No DELETE anywhere — access control and user records
-- are append/revoke-by-status, never destroyed.
REVOKE ALL ON TABLE authz.users            FROM PUBLIC;
REVOKE ALL ON TABLE authz.orgs             FROM PUBLIC;
REVOKE ALL ON TABLE authz.roles            FROM PUBLIC;
REVOKE ALL ON TABLE authz.permissions      FROM PUBLIC;
REVOKE ALL ON TABLE authz.role_permissions FROM PUBLIC;
REVOKE ALL ON TABLE authz.memberships      FROM PUBLIC;
REVOKE ALL ON TABLE authz.resource_acls    FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON TABLE authz.users, authz.orgs, authz.memberships TO authz_app;
GRANT SELECT ON TABLE authz.roles, authz.permissions, authz.role_permissions, authz.resource_acls TO authz_app;