-- Identity service — schema `identity` (ADR-0006 §1).
--
-- Owns party (person/organisation) records referenced by other services via UUID.
-- No cross-schema FK: sibling services store `party_id uuid` as a bare reference;
-- validation happens at the service boundary, not a DB constraint (split-DB seam,
-- ADR-0006 §1). Applied by the `migrator` role; `identity_app` gets USAGE on
-- this schema via db/0001_platform.sql and least-privilege DML below. Forward-only.

CREATE SCHEMA IF NOT EXISTS identity;

-- A party is any actor that can own, decide, or be referenced in an event.
-- R0: GC (general contractor) and homeowner are both parties. Auth integration
-- (Slice 3) will join sessions to parties via `external_id`; the join key lives
-- here so the Identity service owns the authoritative mapping.
CREATE TABLE IF NOT EXISTS identity.party (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text        NOT NULL,
  email         text        UNIQUE,
  role          text        NOT NULL DEFAULT 'contractor'
                              CHECK (role IN ('owner', 'contractor', 'viewer')),
  external_id   text        UNIQUE,               -- future: auth provider subject
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_party_email_idx  ON identity.party (email)       WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS identity_party_extid_idx  ON identity.party (external_id) WHERE external_id IS NOT NULL;

-- Least-privilege grants: identity_app may read/write its own table only.
REVOKE ALL ON TABLE identity.party FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE identity.party TO identity_app;
