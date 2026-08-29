-- Identity — invite-by-email: give identity.invitation an address (LINA-84; ADR-0008 §4).
--
-- 0002 modelled the invitation as a PURE BEARER TOKEN: project + sha256(token) +
-- role + status, and nothing about WHO it was for. That was deliberate for the
-- out-of-band flow (the owner copy-pastes a link into WhatsApp), but it means
-- there is no address to mail the link to and — once ADR-0008's seat allowlist
-- lands — nothing to auto-seat the counterparty against.
--
-- Forward-only: 0002 is already applied, so this is a NEW migration rather than
-- an edit (`db/migrate.mjs` treats an edited applied file as a checksum error).
--
-- ── Numbering note for the reviewer ────────────────────────────────────────────
-- The LINA-84 brief says "0005_identity.sql". On origin/main the identity
-- migrations are 0001, 0002, 0003 — 0004 is the next free ordinal, and no seat
-- migration exists on any branch. This file therefore claims 0004. If the
-- unmerged ADR-0008 seat migration also lands as 0004, ONE of the two must be
-- renumbered before merge; they do not touch the same objects, so the rename is
-- mechanical (the runner keys on filename, so renaming an APPLIED file is itself
-- a checksum error — renumber before either is applied to production).

CREATE SCHEMA IF NOT EXISTS identity;

-- The address the invitation was sent to, lower-cased. NULLABLE ON PURPOSE: the
-- out-of-band path (invite with no email) must keep working and still return a
-- shareable token, so "no address" stays a first-class state rather than being
-- forced into a sentinel.
--
-- The value is normalised in the service by `normalizeEmail` (sign-in.mjs) — the
-- SAME function the sign-in path uses, so `Ana@X.com` typed into the invite form
-- and `ana@x.com` typed into the sign-in form are one address. The CHECK below is
-- a cheap backstop against a bypassing writer, not a re-implementation of that
-- validation: it only asserts the invariant the service guarantees (lower-cased,
-- non-blank, contains an `@`). Address VALIDITY is the service's business.
ALTER TABLE identity.invitation
  ADD COLUMN IF NOT EXISTS email text;

-- Idempotent guard: ADD CONSTRAINT has no IF NOT EXISTS before PG 16 that covers
-- re-runs cleanly, so drop-then-add keeps this migration replayable.
ALTER TABLE identity.invitation
  DROP CONSTRAINT IF EXISTS invitation_email_normalised;

ALTER TABLE identity.invitation
  ADD CONSTRAINT invitation_email_normalised
  CHECK (
    email IS NULL
    OR (email = lower(email) AND length(btrim(email)) > 0 AND position('@' in email) > 1)
  );

-- Look-ups are "is there a pending invite for this address?", which is how the
-- seat/mail path finds the row. Partial: an accepted invitation is history and is
-- never queried by address.
CREATE INDEX IF NOT EXISTS identity_invitation_email_pending_idx
  ON identity.invitation (email)
  WHERE email IS NOT NULL AND status = 'pending';

-- ── Grants ────────────────────────────────────────────────────────────────────
-- Deliberately EMPTY. identity_app already holds SELECT, INSERT, UPDATE on
-- identity.invitation (0002); in PostgreSQL a table-level privilege covers
-- columns added later, so a new column needs no new grant. Nothing here widens
-- the matrix — in particular this migration does NOT touch identity.seat, whose
-- INSERT boundary is the open design question on LINA-84 §2.
