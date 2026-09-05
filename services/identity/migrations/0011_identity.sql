-- Account setup — the profile fields the first-login screen writes (LINA-189).
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- /onboarding/setup (D0a-setup, LINA-132) has been asking a new user for three
-- things since it shipped: how they should APPEAR on the record, WHAT they are
-- (Owner vs GC), and which LANGUAGE the portal should speak. It then POSTed them
-- to an endpoint that did not exist in the deployed system — the handler was
-- written against a standalone Fastify service (apps/api) that was never
-- deployed, so the portal answered 404 and nobody could finish signing up.
--
-- The endpoint now lives in the portal itself, writing to identity.party — the
-- table the ENTIRE R0 domain is already keyed on. That is the whole point of
-- putting it here rather than in a second `users` mirror: `display_name` is what
-- appears beside every decision, change order, and audit row this person ever
-- creates, so account setup must write the attribution name itself, not a
-- parallel profile that agrees with it only by convention.
--
-- Two of the three fields already have a home (`display_name`, `role`). This
-- migration adds the other one and the flag that makes setup a once-only act.
--
-- Deliberately NOT done here: no new role/permission tables. The two dormant
-- RBAC mirrors (0006/0007 in this schema, and the `authz` schema) are retired by
-- 0012 rather than extended — authorization in R0 is identity.membership plus
-- the ADR-0004 authorizer, and a third parallel model would be the actual
-- integrity hazard.

-- ── language: which language the portal speaks to this party ─────────────────
-- Nullable with no default on purpose. NULL means "never asked" and is a
-- different fact from "asked, and they chose English" — the setup screen needs
-- to tell those apart, and a DEFAULT 'en' would erase the distinction for every
-- party created before this migration.
ALTER TABLE identity.party
  ADD COLUMN IF NOT EXISTS language text
    CHECK (language IS NULL OR language IN ('en', 'pt', 'es'));

-- ── setup_complete: has this party finished first-login setup? ───────────────
-- NOT NULL DEFAULT false so the flag is never ambiguous. It is what makes the
-- endpoint idempotent AND race-safe: the write is a conditional UPDATE guarded
-- on `setup_complete = false`, so two concurrent first-login POSTs both target
-- one row, exactly one updates it, and the loser reads zero rows affected and is
-- answered 409 — which the client treats as success (the contract's "already set
-- up"). No advisory lock and no read-then-write window.
--
-- Backfill note: existing parties (all created by the Clerk bridge's
-- findOrCreateByEmail, which invents a display name from the email local part)
-- correctly get `false`. They have not chosen a name, a role, or a language, so
-- the setup screen SHOULD still ask them.
ALTER TABLE identity.party
  ADD COLUMN IF NOT EXISTS setup_complete boolean NOT NULL DEFAULT false;

-- No new grant is needed: 0001 already gives identity_app SELECT, INSERT, UPDATE
-- on identity.party, and these are columns of that table. Stated explicitly so a
-- future reader does not go looking for a missing GRANT — the absence is
-- deliberate, not an oversight.
