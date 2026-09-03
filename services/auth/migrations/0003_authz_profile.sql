-- Auth service — account-setup profile columns on authz.users (LINA-137).
--
-- The D0a-setup endpoint (POST /api/me/profile) persists the first-login
-- account-setup form: display name, role choice, and language preference, and
-- marks the user's profile as set up so a repeat POST returns 409.
--
-- ROLES: `authz_app` already holds SELECT, INSERT, UPDATE on authz.users (0001);
-- in PostgreSQL a table-level privilege covers columns added later, so a new
-- column needs no new grant. Nothing here widens the authz_app grant matrix.
-- rbac access control (0001) is untouched.
--
-- Forward-only; idempotent (IF NOT EXISTS + drop-then-add for the constraint).

-- The UI language. NOT NULL DEFAULT 'en' keeps existing rows valid; the CHECK
-- mirrors the server-side validation (en|pt|es) as a cheap backstop, exactly as
-- the identity.invitation email CHECK does (identity 0005).
ALTER TABLE authz.users
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';

ALTER TABLE authz.users
  DROP CONSTRAINT IF EXISTS users_language_valid;

ALTER TABLE authz.users
  ADD CONSTRAINT users_language_valid
  CHECK (language IN ('en', 'pt', 'es'));

-- Whether the user has completed account setup (D0a-setup). Once true, the
-- endpoint answers 409 (client continues to the portal). Write-once: only the
-- admission path flips this to true; nothing ever clears it (revocation of an
-- already-provisioned account is `status = 'disabled'`, not a setup rollback).
ALTER TABLE authz.users
  ADD COLUMN IF NOT EXISTS setup_complete boolean NOT NULL DEFAULT false;
