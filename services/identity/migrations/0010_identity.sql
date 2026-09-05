-- Self-serve founding seats (LINA-189) — the write half of ADR-0008.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- 0004_identity.sql created identity.seat as a READ-ONLY table for the request
-- path: identity_app holds SELECT and nothing else, because the party path ends
-- in `findOrCreateByEmail` and a request path that can seat itself is open
-- registration on a trust product. That reasoning is unchanged and this
-- migration does not weaken it — identity_app still cannot write a seat.
--
-- What changes is that the founder committed publicly to fifty free founding
-- seats claimable from the landing page. Somebody has to turn a confirmed claim
-- into a seat, and "a human runs scripts/grant-seat.mjs fifty times" is not the
-- onboarding experience that was promised. So a SECOND, much narrower writer is
-- introduced, and the safety that used to come from "nobody can write" now comes
-- from three things instead:
--
--   1. A separate role. The landing site connects as landing_app_v2, NOT as
--      identity_app. Exploiting the portal's request path still cannot seat
--      anybody, which is the property 0004 actually cared about.
--   2. A column-scoped INSERT. The writer may set the email and the note. It
--      may NOT choose `source` or `status` — those come from defaults and are
--      pinned by the trigger below — so the landing site cannot mint itself a
--      'stripe' seat or resurrect a revoked one.
--   3. A HARD CAP IN THE DATABASE. Fifty is a promise made to the public, so it
--      is enforced where it cannot be argued with, not in application code that
--      a refactor can drop. Even a fully compromised landing site gets seat 51
--      rejected by Postgres.
--
-- Deliberately NOT done here: revocation, reinstatement, and paid ('stripe')
-- seats stay out-of-band administrative acts under the migrator/webhook roles.
-- This migration buys exactly one new capability — claim a founding seat — and
-- nothing else.

-- ── 1. 'founding' as a first-class seat source ───────────────────────────────
-- The existing sources describe how a seat was obtained: 'beta' (hand-granted),
-- 'invite' (rode in on someone else's project), 'stripe' (reserved for paid).
-- A self-claimed founding seat is none of those. It gets its own value so the
-- cap below can count exactly the fifty that were promised, and so a later
-- audit can tell a hand-granted seat from a self-claimed one — which matters,
-- because they were admitted under different rules.
DO $$
BEGIN
  -- 0004 declared the CHECK inline, so its generated name depends on the
  -- server. Find it by definition rather than guessing, and drop it.
  EXECUTE (
    SELECT coalesce(
      string_agg(format('ALTER TABLE identity.seat DROP CONSTRAINT %I', conname), '; '),
      'SELECT 1'
    )
    FROM pg_constraint
    WHERE conrelid = 'identity.seat'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%source%'
  );
END $$;

ALTER TABLE identity.seat
  ADD CONSTRAINT seat_source_check
  CHECK (source IN ('beta', 'invite', 'stripe', 'founding'));

-- ── 2. The cap, enforced by the database ─────────────────────────────────────
-- Counting rows in a BEFORE INSERT trigger is only correct if concurrent
-- inserts are serialised: two transactions can each count 49 and each insert,
-- yielding 51. A transaction-scoped advisory lock on a constant key makes the
-- count-then-insert atomic with respect to other founding claims. It is held
-- only for the remainder of the inserting transaction, and it is taken ONLY on
-- the founding path, so hand-granted and invited seats are never serialised
-- behind it.
--
-- The cap counts 'founding' seats in ANY status, revoked included. A revoked
-- founding seat means that person was admitted and then removed; it does not
-- hand their seat to the next comer. Fifty people were let in, and the promise
-- was about who got in, not about how many are currently active.
CREATE OR REPLACE FUNCTION identity.enforce_founding_seat_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cap  constant int    := 50;
  -- Arbitrary but fixed: the lock key IS the founding-seat allocation.
  key  constant bigint := 4801920189;
  taken int;
BEGIN
  IF NEW.source IS DISTINCT FROM 'founding' THEN
    RETURN NEW;
  END IF;

  -- A seat is granted, never born revoked. Pinning it here means the writer
  -- cannot insert a pre-revoked row to dodge the cap and then flip it active.
  IF NEW.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'a founding seat must be created active (got %)', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(key);

  SELECT count(*) INTO taken FROM identity.seat WHERE source = 'founding';

  IF taken >= cap THEN
    -- A distinct SQLSTATE so the caller can tell "all fifty are gone" (a normal,
    -- expected, user-facing outcome) apart from a real database failure.
    RAISE EXCEPTION 'founding seats exhausted (% of % claimed)', taken, cap
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS seat_founding_cap ON identity.seat;
CREATE TRIGGER seat_founding_cap
  BEFORE INSERT ON identity.seat
  FOR EACH ROW
  EXECUTE FUNCTION identity.enforce_founding_seat_cap();

-- ── 3. The narrow writer grant ───────────────────────────────────────────────
-- landing_app_v2 is the marketing site's role (db/roles.sql). It gets:
--   • USAGE on the schema, so it can reach the table at all.
--   • SELECT, to render the honest "N of 50 claimed" counter. The counter is
--     public information — it is printed on the landing page — but note this is
--     a whole-table SELECT, so the landing site can read seat EMAILS. It must
--     only ever aggregate them; see marketing-site/src/lib/seats.ts.
--   • INSERT on (email, source, note) ONLY. Omitting `status` from the column
--     list means the writer cannot set it, so it takes the 'active' default and
--     the trigger's assertion above always holds.
-- No UPDATE and no DELETE: this role can admit a founding claimant and can do
-- nothing else to a seat, forever.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'landing_app_v2') THEN
    GRANT USAGE ON SCHEMA identity TO landing_app_v2;
    GRANT SELECT ON TABLE identity.seat TO landing_app_v2;
    GRANT INSERT (email, source, note) ON TABLE identity.seat TO landing_app_v2;
  END IF;

  -- The Neon-console-created `landing_app` is a permanent neon_superuser member
  -- (see db/roles.sql) and is what production actually connects as today, until
  -- LINA-68 swaps it out. Granting here is a no-op for access — it already has
  -- everything — but it keeps the intended privilege set declared in one place,
  -- so the cutover to a non-superuser role is a connection-string change and
  -- not a scavenger hunt for missing grants.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'landing_app') THEN
    GRANT USAGE ON SCHEMA identity TO landing_app;
    GRANT SELECT ON TABLE identity.seat TO landing_app;
    GRANT INSERT (email, source, note) ON TABLE identity.seat TO landing_app;
  END IF;
END $$;
