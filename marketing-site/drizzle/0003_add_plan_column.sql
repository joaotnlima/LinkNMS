-- LINA-172 — record the claimed plan tier on signup.
--
-- Adds a nullable `plan` column to landing.signups so the waitlist form can
-- capture which pricing tier the user is claiming (e.g. 'free_founding' when
-- they click "Claim my free seat"). Existing rows default to NULL (no
-- historical tier known).
--
-- The founding-seat counter reads `count(signups WHERE plan = 'free_founding')`
-- and caps at 50. An index on plan makes that count fast.
--
-- Apply with the schema owner:
--   psql "$NEON_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f marketing-site/drizzle/0003_add_plan_column.sql

ALTER TABLE landing.signups
  ADD COLUMN IF NOT EXISTS plan text;

-- Least-privilege: the app role already has SELECT, INSERT, UPDATE on
-- landing.signups (0002), so no additional GRANT is needed — the new column
-- is covered by the existing grant.
CREATE INDEX IF NOT EXISTS signups_plan_idx ON landing.signups (plan);
