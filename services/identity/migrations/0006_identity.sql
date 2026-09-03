-- Identity — RBAC (Neon Postgres owns authorization; LINA-140; Auth Bridge §4).
--
-- The Auth Bridge Pattern (LINA-123 §4) retires the self-managed ADR-0004
-- authorizer in favour of a first-class RBAC mirror: Clerk answers "who are
-- you?", this schema answers "what may you do here?". Clerk IDs are the join
-- key; the authorization verdict is ALWAYS computed from these tables, never
-- from a Clerk role/claim (LINA-121 decision).
--
-- These tables live in schema `identity` (reusing the LINA-37 namespace, per
-- the design's §4 note) and are separate from the legacy 0002 project/membership
-- tables: `identity.membership` (singular, party×project×role) remains the
-- project-access model for R0's self-managed flow, while `identity.memberships`
-- (plural), `roles`, `permissions`, etc. are the NEW Clerk-backed RBAC mirror.
-- No name collision, and the legacy tables are NOT touched here (retirement is
-- a separate migration, gated for Architect review).
--
-- Forward-only: 0001–0005 are already applied, so this is a NEW migration (an
-- edited applied file is a checksum error in the runner). No cross-schema FK:
-- like every identity table, these are referenced by bare UUID from siblings
-- and validated at the service boundary (ADR-0006 §1).
--
-- NOTE (deviation from Auth Bridge §4, for Architect ratification): the design
-- specifies `email citext`. This repo consistently stores addresses as `text`
-- normalised to lower-case at the service boundary (identity.party.email,
-- identity.seat.email, invitation_email_normalised in 0005) and never uses the
-- citext extension anywhere. To keep one consistent email-discipline and avoid a
-- Neon extension dependency, `users.email` is `text` with the same normalised
-- CHECK; case-insensitivity is a service-layer concern, matching every other
-- email in this codebase. This does not weaken integrity.

CREATE SCHEMA IF NOT EXISTS identity;

-- ── users: local mirror of a Clerk user ──────────────────────────────────────
-- Clerk is the system of record for identity; this row keys on clerk_user_id.
-- `status` is our enforcement flag: 'disabled' is how we freeze a user's access
-- regardless of Clerk state (revocation is a flip, never a DELETE — integrity).
CREATE TABLE IF NOT EXISTS identity.users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id  text        NOT NULL UNIQUE CHECK (length(btrim(clerk_user_id)) > 0),
  email          text        NOT NULL CHECK (length(btrim(email)) > 0),
  display_name   text,
  status         text        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Match the repo's email discipline (0005): lower-cased, non-blank, has an `@`.
  CONSTRAINT users_email_normalised CHECK (
    email = lower(email) AND length(btrim(email)) > 0 AND position('@' in email) > 1
  )
);

CREATE INDEX IF NOT EXISTS identity_users_email_idx ON identity.users (email);

-- ── orgs: local mirror of a Clerk Organization ──────────────────────────────
-- We mirror clerk_org_id rather than own org lifecycle (Auth Bridge §6) so Clerk
-- keeps org-invitation email flow; authorization is still resolved here.
CREATE TABLE IF NOT EXISTS identity.orgs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_org_id  text        NOT NULL UNIQUE CHECK (length(btrim(clerk_org_id)) > 0),
  name          text        NOT NULL CHECK (length(btrim(name)) > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── roles: named roles, optionally scoped to an org ─────────────────────────
-- NULL org_id = a SYSTEM role (seeded here: owner, gc, subcontractor). Org-scoped
-- roles carry a non-null org_id. The plain UNIQUE(org_id, key) covers the
-- org-scoped case; because NULLs never collide, a partial index below enforces
-- the same on-or-more guarantee for system roles (exactly one row per key).
CREATE TABLE IF NOT EXISTS identity.roles (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        REFERENCES identity.orgs(id) ON DELETE CASCADE,
  key        text        NOT NULL CHECK (length(btrim(key)) > 0),
  name       text        NOT NULL CHECK (length(btrim(name)) > 0),
  UNIQUE (org_id, key)
);

-- Exactly one SYSTEM role per key (org_id IS NULL). Org-scoped roles are covered
-- by UNIQUE(org_id, key); this partial index closes the NULL gap so the seeded
-- owner/gc/subcontractor keys cannot be duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS identity_roles_system_key_uniq
  ON identity.roles (key) WHERE org_id IS NULL;

-- ── permissions: fine-grained verbs ─────────────────────────────────────────
-- e.g. 'project.create', 'change_order.approve'. Deny-by-default: a verb a role
-- never grants is, by construction, forbidden (Auth Bridge §3 `can()`).
CREATE TABLE IF NOT EXISTS identity.permissions (
  id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key      text        NOT NULL UNIQUE CHECK (length(btrim(key)) > 0),
  descr    text
);

-- ── role_permissions: which permissions a role grants ───────────────────────
CREATE TABLE IF NOT EXISTS identity.role_permissions (
  role_id       uuid NOT NULL REFERENCES identity.roles(id)       ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES identity.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ── memberships: a user's role within an org ────────────────────────────────
-- The Owner/GC/Subcontractor mapping. One role per user per org in v1
-- (UNIQUE(user_id, org_id)); multi-role can relax later (Auth Bridge §8.3).
CREATE TABLE IF NOT EXISTS identity.memberships (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  org_id     uuid        NOT NULL REFERENCES identity.orgs(id)  ON DELETE CASCADE,
  role_id    uuid        NOT NULL REFERENCES identity.roles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS identity_memberships_org_idx ON identity.memberships (org_id);
CREATE INDEX IF NOT EXISTS identity_memberships_role_idx ON identity.memberships (role_id);

-- ── resource_acls: per-resource overrides on top of role grants ─────────────
-- e.g. share one project with a user outside the org role. `effect` allow|deny;
-- `deny` always wins in `can()`'s evaluation order (Auth Bridge §4):
--   resource_acls deny → resource_acls allow → role/permission grant → deny.
-- `resource_id` is deliberately a bare uuid (no cross-schema FK).
CREATE TABLE IF NOT EXISTS identity.resource_acls (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  resource_type text        NOT NULL CHECK (length(btrim(resource_type)) > 0),
  resource_id   uuid        NOT NULL,
  permission_id uuid        NOT NULL REFERENCES identity.permissions(id) ON DELETE CASCADE,
  effect        text        NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'deny')),
  UNIQUE (user_id, resource_type, resource_id, permission_id)
);

-- ── Least-privilege grants: identity_app ────────────────────────────────────
-- `identity_app` is the runtime role for the auth path: the `can()` authorizer
-- READS users/orgs/roles/permissions/role_permissions/memberships/resource_acls,
-- and the Clerk webhook / JIT sync (0A-impl-2) WRITES users/orgs/memberships.
-- Consistent with the repo's discipline: grants are DML-only, and there is NO
-- DELETE anywhere — access control and user records are append/revoke-by-status,
-- never destroyed (integrity; Auth Bridge §4 preserve-intent).
--
-- roles/permissions/role_permissions are deliberately SELECT-only: the verb and
-- role catalog is seeded by the migrator (out of band, like identity.seat in
-- 0004), so a bug or injection on the request path can never grant itself a
-- permission. Org-scoped role creation, when it arrives, gets a narrower,
-- explicitly-audited grant under Architect review rather than a blanket INSERT.
REVOKE ALL ON TABLE identity.users           FROM PUBLIC;
REVOKE ALL ON TABLE identity.orgs            FROM PUBLIC;
REVOKE ALL ON TABLE identity.roles           FROM PUBLIC;
REVOKE ALL ON TABLE identity.permissions     FROM PUBLIC;
REVOKE ALL ON TABLE identity.role_permissions FROM PUBLIC;
REVOKE ALL ON TABLE identity.memberships     FROM PUBLIC;
REVOKE ALL ON TABLE identity.resource_acls   FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON TABLE identity.users, identity.orgs, identity.memberships, identity.resource_acls TO identity_app;
GRANT SELECT                     ON TABLE identity.roles, identity.permissions, identity.role_permissions                          TO identity_app;
