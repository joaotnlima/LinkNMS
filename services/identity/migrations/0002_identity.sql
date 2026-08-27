-- Identity & Membership — Slice 2 tables (LINA-37; design §3, §6, ADR-0004, ADR-0006 §1).
--
-- Adds the three tables Slice 2 owns on top of `identity.party` (0001): the
-- `project` a homeowner starts, the `membership` (party × project × role) that
-- ALL authorization is a property of (ADR-0004), and the single-use `invitation`
-- by which exactly one GC (counterparty) joins.
--
-- Forward-only: 0001_identity.sql is already applied, so this is a NEW migration
-- rather than an edit (the runner treats an edited applied file as a checksum
-- error). No cross-schema FK anywhere: sibling services and the ledger reference
-- these rows by bare UUID and validate at the service boundary (split-DB seam,
-- ADR-0006 §1). Applied by the `migrator` role; least-privilege grants below.

CREATE SCHEMA IF NOT EXISTS identity;

-- A shared record. The owner (homeowner) is captured here and mirrored as an
-- `owner` membership row created in the same transaction as the project_created
-- ledger event. `baseline_budget_cents` is the FR1 baseline; it is integer cents
-- (never a float) and it enters the ledger via the project_created event payload,
-- so the authoritative budget is computed ledger-side and never re-summed here.
CREATE TABLE IF NOT EXISTS identity.project (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text        NOT NULL CHECK (length(btrim(name)) > 0),
  owner_party_id         uuid        NOT NULL,               -- identity.party.id (bare ref)
  baseline_budget_cents  bigint      NOT NULL CHECK (baseline_budget_cents >= 0),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_project_owner_idx ON identity.project (owner_party_id);

-- Authorization is a property of membership, never of the user globally
-- (ADR-0004). R0 caps roles to `owner` (homeowner) and `counterparty` (GC);
-- adding `sub`, `inspector`, … later is new role VALUES + capability rows, not a
-- schema change. Two uniqueness rules are load-bearing integrity (design §3):
--   * UNIQUE(project_id, role)     — exactly one owner and one counterparty in R0.
--   * UNIQUE(project_id, party_id) — a party joins a given project at most once.
CREATE TABLE IF NOT EXISTS identity.membership (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid        NOT NULL REFERENCES identity.project(id),
  party_id     uuid        NOT NULL,                          -- identity.party.id (bare ref)
  role         text        NOT NULL CHECK (role IN ('owner', 'counterparty')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_project_role_uq  UNIQUE (project_id, role),
  CONSTRAINT membership_project_party_uq UNIQUE (project_id, party_id)
);

CREATE INDEX IF NOT EXISTS identity_membership_party_idx ON identity.membership (party_id);

-- A single-use invitation to join a project as the counterparty. Only the SHA-256
-- of the token is stored — the raw token is shown to the inviter once and never
-- persisted, so a database read can never reconstruct a live invite. R0 only ever
-- invites the one GC, so `role` is constrained to `counterparty`; the membership
-- UNIQUE(project_id, role) is the ultimate backstop against a second one.
CREATE TABLE IF NOT EXISTS identity.invitation (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid        NOT NULL REFERENCES identity.project(id),
  token_hash            text        NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  role                  text        NOT NULL DEFAULT 'counterparty'
                                      CHECK (role = 'counterparty'),
  status                text        NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending', 'accepted')),
  invited_by_party_id   uuid        NOT NULL,                 -- the owner who invited
  created_at            timestamptz NOT NULL DEFAULT now(),
  accepted_at           timestamptz
);

-- At most one PENDING invitation per project — a clean 409 before a second GC is
-- even invited (the membership UNIQUE is the hard backstop once one accepts).
CREATE UNIQUE INDEX IF NOT EXISTS identity_invitation_one_pending
  ON identity.invitation (project_id)
  WHERE status = 'pending';

-- ── Least-privilege grants: identity_app reads/writes only its own tables ──────
REVOKE ALL ON TABLE identity.project    FROM PUBLIC;
REVOKE ALL ON TABLE identity.membership FROM PUBLIC;
REVOKE ALL ON TABLE identity.invitation FROM PUBLIC;
GRANT SELECT, INSERT         ON TABLE identity.project    TO identity_app;
GRANT SELECT, INSERT         ON TABLE identity.membership TO identity_app;
GRANT SELECT, INSERT, UPDATE ON TABLE identity.invitation TO identity_app;

-- ── Cross-schema seam: identity appends its own events through the Ledger ──────
-- Identity's mutations (project_created, member_joined) are hash-chained events.
-- Like decision_app and change_order_app, identity_app may ONLY append through
-- ledger.append_event (SECURITY DEFINER) — it holds no INSERT on audit_event, so
-- hash-chain construction stays in exactly one place (ADR-0002 §4, ADR-0006 §1).
-- The project projection write and this append commit in ONE cross-schema
-- transaction on identity_app's connection.
--
-- NOTE for the trust-anchor owner (Founding Engineer): 0002_ledger_roles.sql
-- enumerated EXECUTE for ledger_app/decision_app/change_order_app but omitted
-- identity_app, which also produces events. This grant closes that gap from the
-- consuming service's own migration (the migrator owns the function, so the GRANT
-- is valid here). If you'd rather centralise the seam in the ledger's grant
-- matrix, add a forward 0003_ledger_*.sql and drop this block — never edit an
-- applied file.
GRANT USAGE ON SCHEMA ledger TO identity_app;
GRANT EXECUTE ON FUNCTION
  ledger.append_event(uuid, text, uuid, timestamptz, jsonb, text) TO identity_app;
