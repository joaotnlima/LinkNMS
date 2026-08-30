-- Identity — the seat allowlist (LINA-75; ADR-0008).
--
-- WHY THIS EXISTS. ADR-0007 gave us a working front door: prove you control an
-- email, get a session. But `consume` ends in `parties.findOrCreateByEmail`,
-- which means proving control of ANY address on the internet mints a party. On
-- a trust product that is open registration — the moment RESEND_API_KEY lands on
-- production, anybody can walk in. The CEO's rollout is the opposite: ten free
-- seats given away by hand, paid seats after. So sign-in needs an ALLOWLIST, and
-- this table is it.
--
-- WHERE THE GATE SITS. In `request` — we decline to MINT and MAIL a link to an
-- address with no seat. Not in `consume`: gating there would mail a real link to
-- an unseated stranger and then reject it, which both wastes a send and teaches
-- an attacker that the address exists. Declining at mint keeps ADR-0007 §4
-- intact — the response is still a uniform 202 whether or not a seat exists, so
-- this table is NOT a membership oracle either.
--
-- THE STRIPE SEAM. This is the whole point of a separate table rather than a
-- boolean on identity.party. Who may sign in is one question ("is there an
-- active seat for this address"); how the seat was paid for is another
-- (`source`, and later a subscription id). When billing arrives, Stripe inserts
-- and revokes seat rows and NOT ONE LINE of the auth path changes. `source`
-- already carries 'beta' for the ten giveaways and reserves 'stripe'.
--
-- NOT LEDGER HISTORY. A seat is commercial access, not project history: granting
-- one answers "who may log in", never "who decided what and what did it cost".
-- So there is no audit event and no ledger seam here, exactly as 0003 reasoned
-- for sign-in tokens. The trust anchor is untouched by this file.

CREATE SCHEMA IF NOT EXISTS identity;

-- One row per address that is allowed through the front door. `email` is the
-- natural key, lower-cased by the caller the same way sign-in normalizes it, so
-- `Ana@x.com` and `ana@x.com` are one seat and cannot be double-granted.
--
-- A seat is deliberately keyed on the EMAIL, not on identity.party.id: the whole
-- job of the seat is to decide whether a party may be created in the first
-- place, so it has to exist before the party does.
CREATE TABLE IF NOT EXISTS identity.seat (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text        NOT NULL UNIQUE CHECK (length(btrim(email)) > 0),
  -- 'beta'   — one of the hand-granted free seats (the first ten).
  -- 'invite' — a counterparty seated because a project owner invited them by
  --            email; they ride in on someone else's project and, per ADR-0008,
  --            do not consume a beta seat.
  -- 'stripe' — reserved: a seat backed by a paid subscription.
  source       text        NOT NULL DEFAULT 'beta'
                             CHECK (source IN ('beta', 'invite', 'stripe')),
  -- Revocation is a status flip, never a DELETE: we want to keep the record that
  -- a seat was granted and withdrawn. Only 'active' opens the door.
  status       text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'revoked')),
  note         text,                                     -- free-text: who this is, why granted
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  -- Belt and braces: a revoked seat must carry its revocation timestamp and an
  -- active one must not, so `status` can never drift away from the audit trail.
  CONSTRAINT seat_revoked_consistent CHECK (
    (status = 'active'  AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

-- The gate is a single point lookup on (email, status) on the hot sign-in path.
CREATE INDEX IF NOT EXISTS identity_seat_active_idx
  ON identity.seat (email) WHERE status = 'active';

-- Least-privilege, and narrower than the other identity tables ON PURPOSE.
-- identity_app only ever ASKS whether a seat exists — it must never be able to
-- grant itself one, so a bug or an injection on the request path cannot widen
-- who may sign in. Seats are issued out of band (scripts/grant-seat.mjs runs as
-- migrator) and, later, by the billing webhook under its own role.
REVOKE ALL ON TABLE identity.seat FROM PUBLIC;
GRANT SELECT ON TABLE identity.seat TO identity_app;
