-- Waitlist — activation record (LINA-130; Onboarding Plan v4 Phase 2, D-1).
--
-- Phase 1 (0001_waitlist.sql) already carries the lifecycle on waitlist.signup:
--   status       'waitlisted' on signup (D-4) → 'active' on activation (D-1)
--   activated_at the server clock when the status flips
--
-- This migration adds ONE nullable, immutable column for auditability: the Clerk
-- org-invitation id minted when the go-date batch hands a waitlisted address its
-- D-1 activation email. Trends are cheap and the whole point of the platform is
-- "who decided this, when, how much" — so an activation that surfaced no Clerk
-- invitation id (a bug, a revoked invite, an out-of-band seat) stays visible as
-- a NULL rather than a silent gap. It is recording, never a join key: the batch
-- writes it once and nothing reads it to decide access (the seat gate does that,
-- ADR-0008), so it can never become a mutable control surface.

CREATE TABLE IF NOT EXISTS waitlist.waitlist_activation (
  signup_id           uuid PRIMARY KEY REFERENCES waitlist.signup(id),
  clerk_invitation_id text,
  invited_at          timestamptz NOT NULL DEFAULT now(),
  actor               text NOT NULL DEFAULT 'system',
  note                text,
  UNIQUE (signup_id, clerk_invitation_id)
);

-- Mirrors grant-seat.mjs's discipline: the running app never seats or activates
-- anybody, so only the migrator writes this table. The batch runs as migrator.
REVOKE ALL ON TABLE waitlist.waitlist_activation FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE waitlist.waitlist_activation TO waitlist_app;
