-- LINA-189 — record which persona a signup came in as.
--
-- The landing page is organised around two people: the OWNER having the house
-- built, and the BUILDER doing or managing the work. The pricing section has a
-- tab for each, a ribbon for each, and a family of plans for each. Until now
-- that split was purely presentational — whichever side a visitor came in
-- through, the signup row looked identical, and the only way to learn who they
-- were was the optional six-way `role` dropdown they were free to skip (and
-- should be free to skip: an email address is enough to send a confirmation
-- link).
--
-- Which CTA someone pressed is not a question. It is something they already
-- told us by clicking, so it is recorded rather than asked. The persona then
-- rides the whole way through — signup → confirmation → the portal's sign-up →
-- account setup, which preselects Owner or General contractor instead of asking
-- a person to restate something they chose on the pricing page a minute ago.
--
-- NULLABLE, and deliberately so. The header, hero and final CTAs sit above the
-- Owner/Builder split; they have no persona and null is the honest value. A
-- DEFAULT here would fabricate a confident wrong answer for every one of them.
--
-- No CHECK constraint: `role` and `plan` next to it are equally unconstrained
-- text whose vocabulary is enforced at the service boundary (normalizePersona /
-- personaForPlan in src/lib/pricing.ts), and one column with a different
-- discipline from its neighbours is a trap for whoever edits this table next.
-- Historical rows keep NULL — the fact was not captured when they signed up,
-- and backfilling a guess from `plan` would make invented data indistinguishable
-- from observed data.
--
-- Apply with the schema owner:
--   psql "$NEON_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f marketing-site/drizzle/0004_add_persona_column.sql

ALTER TABLE landing.signups
  ADD COLUMN IF NOT EXISTS persona text;

-- Least-privilege: the app role already holds SELECT, INSERT, UPDATE on
-- landing.signups (0002), and a new column is covered by that table-level
-- grant. No additional GRANT is needed — stated so a future reader does not
-- go looking for a missing one.

-- Indexed for the same reason `plan` is: "how many owners vs builders signed
-- up" is the question this column exists to answer, and it will be asked as an
-- aggregate over the whole table.
CREATE INDEX IF NOT EXISTS signups_persona_idx ON landing.signups (persona);
