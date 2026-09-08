-- The plan a seat was admitted under (LINA-189, ADR-0013) — the entitlement leg.
--
-- ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────
-- The landing page has been selling an active-project allowance per plan since
-- LINA-173 ("1 active project", "Up to 3 active projects", "Unlimited"). The
-- plan a visitor chose was recorded on `landing.signups.plan` and stopped there:
-- landing.signups lives in the marketing site's schema, the portal never reads
-- it, and nothing on the write path had ever asked what anyone bought. Every
-- plan was therefore unlimited, and the pricing page was a description of a
-- product that did not exist.
--
-- The plan belongs on the SEAT, not on the party and not on a new table:
--
--   • The seat is already the entitlement record (ADR-0008: authentication vs
--     entitlement vs authorization). "May you come in" and "what did you buy"
--     are the same commercial fact and must not be two rows that can disagree.
--   • It is keyed on email, so it can be written at CLAIM time — before the
--     party exists. The party is created on first authenticated request, long
--     after the plan was chosen; a plan on the party would have nowhere to live
--     in between and would have to be re-derived from the landing schema.
--   • The seat is the row the fifty-seat cap already counts, so the plan lands
--     under the same trigger and the same narrow grants, with no new surface.
--
-- What the plan BUYS is not stored here — see services/identity/plans.mjs. This
-- column is the immutable commercial fact; the allowance is a pricing decision
-- the founder changes without migrating anybody's data.

-- ── 1. The column ────────────────────────────────────────────────────────────
-- Nullable, and null is a legitimate value with a meaning: a seat granted with
-- no plan attached — the hand-granted 'beta' seats and every 'invite' seat, who
-- ride in on somebody else's build. plans.mjs gives those the entry allowance.
--
-- The CHECK mirrors PLAN_KEYS in services/identity/plans.mjs and in the
-- marketing site's @/lib/db. Three copies of one enum is a drift hazard, so the
-- constraint is the backstop that makes drift LOUD: a landing site that starts
-- writing a plan key the record does not know is refused at the boundary rather
-- than silently seating somebody on an allowance nobody can compute.
ALTER TABLE identity.seat
  ADD COLUMN IF NOT EXISTS plan text;

ALTER TABLE identity.seat
  DROP CONSTRAINT IF EXISTS seat_plan_check;

ALTER TABLE identity.seat
  ADD CONSTRAINT seat_plan_check CHECK (
    plan IS NULL OR plan IN (
      'free_founding',
      'personal',
      'build_plus',
      'real_estate_investor',
      'independent_builder',
      'growing_builder',
      'construction_business'
    )
  );

COMMENT ON COLUMN identity.seat.plan IS
  'The plan this seat was admitted under (landing funnel plan key), or NULL for '
  'a hand-granted beta seat or an invited counterparty. What the plan BUYS lives '
  'in services/identity/plans.mjs, never here.';

-- ── 2. The grant, widened by exactly one column ──────────────────────────────
-- 0010 gave the marketing site INSERT on (email, source, note) and nothing else:
-- it can admit a founding claimant and can do nothing further to a seat, ever.
-- That boundary is unchanged in kind — `plan` joins the insertable column list
-- because the claim is the moment the plan is known, and it is the same writer,
-- in the same statement, recording the same act.
--
-- Still no UPDATE and still no DELETE. A plan CHANGE (an upgrade) is therefore
-- NOT something the landing site can perform; it is an out-of-band act under the
-- migrator or the billing webhook's own role, which is correct — the request
-- path of a public marketing page must never be able to raise anybody's
-- entitlement, including its own visitor's.
--
-- identity_app is untouched: SELECT only, as 0004 and 0010 both insist. The
-- portal reads the plan to enforce the cap and can no more write one than it
-- could seat somebody.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'landing_app_v2') THEN
    GRANT INSERT (email, source, note, plan) ON TABLE identity.seat TO landing_app_v2;
  END IF;

  -- The Neon-console-created `landing_app` is still what production connects as
  -- until LINA-68 swaps it out; granting is a no-op for access but keeps the
  -- intended privilege set declared in one place (see 0010 §3).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'landing_app') THEN
    GRANT INSERT (email, source, note, plan) ON TABLE identity.seat TO landing_app;
  END IF;
END $$;
