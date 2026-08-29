-- Identity — magic-link sign-in token (LINA-76; ADR-0007).
--
-- The "proof" half of ADR-0001: a single-use, short-lived, hashed-at-rest token
-- that proves the person asking for a session controls the email they typed.
-- Same discipline as identity.invitation (0002): store sha256(raw) ONLY — the
-- raw token is emailed once and never persisted, so a dump of this table can
-- never let its reader sign in as anybody.
--
-- Forward-only: 0001/0002 are already applied, so this is a NEW migration rather
-- than an edit (an edited applied file is a checksum error in the runner). No
-- cross-schema FK and no ledger seam: minting/consuming a sign-in token is NOT
-- project history — it writes no audit event — so identity_app needs no grant on
-- ledger.append_event for this table (unlike project_created/member_joined).

CREATE SCHEMA IF NOT EXISTS identity;

-- A pending magic link. `email` is the address the requester typed, lower-cased;
-- it is stored (unlike the invitation, whose subject is a project) because the
-- token is consumed by an anonymous browser that presents only the token — the
-- email must ride the row so consume can find-or-create the party. Storing the
-- address is no worse than identity.party.email, which already holds it.
--
-- Enumeration resistance (ADR-0007 §4): a token is minted for EVERY well-formed
-- request whether or not the email is already a known party, so the presence of
-- a row here leaks nothing about membership. `request_ip` backs the per-IP rate
-- limit; it is best-effort (a proxied/absent client address is NULL).
CREATE TABLE IF NOT EXISTS identity.sign_in_token (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL CHECK (length(btrim(email)) > 0),
  display_name  text,                                      -- optional; passed to find-or-create on consume
  token_hash    text        NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  request_ip    text,                                      -- best-effort, for per-IP rate limiting
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz                                -- NULL until the single-use consume flips it
);

-- Rate-limit counters are COUNT(*) over recent rows for an email / an IP within
-- the window (ADR-0007 §4: the counter lives in Postgres because a serverless
-- deploy has no shared memory). These two indexes make that count a range scan.
CREATE INDEX IF NOT EXISTS identity_sign_in_token_email_created_idx
  ON identity.sign_in_token (email, created_at);
CREATE INDEX IF NOT EXISTS identity_sign_in_token_ip_created_idx
  ON identity.sign_in_token (request_ip, created_at)
  WHERE request_ip IS NOT NULL;

-- Least-privilege: identity_app reads (rate-limit COUNT, consume RETURNING),
-- inserts (mint), and updates (the atomic single-use consume). No DELETE — spent
-- and expired rows are pruned by an out-of-band job, not the request path.
REVOKE ALL ON TABLE identity.sign_in_token FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE identity.sign_in_token TO identity_app;
