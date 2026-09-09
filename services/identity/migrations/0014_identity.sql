-- Identity — Band B "Create the build · Basics": the three descriptive fields the
-- pen's Basics screen draws that had no home before (LINA-219; ADR-0011).
--
-- ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────
-- The pen's Basics screen (linkNMS.pen → "Band B · Create the build and invite",
-- screen "D2 · New build · Basics") asks for four things: the build name, its
-- Address, a Build type, and an Expected start. Migration 0009 added only
-- `operating_model` and `status`, so three of the four had nowhere to land and
-- were deliberately NOT rendered — this codebase's rule is that a field which
-- accepts what an owner types about their site and then discards it is worse than
-- its absence (see the GAPS note that used to live in app/src/lib/build-creation).
-- LINA-219 asked for pen compliance, so the columns exist now and the fields ship.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────
-- All three are NULLABLE `text`, set once at INSERT (the wizard's step 1) and
-- never mutated by the request path afterward:
--
--   • NULLABLE, no back-fill: every project created before this migration — and
--     every legacy one-shot createProject — simply has none of these, which is the
--     truth, not a guessed value. A draft that skips them is legal too.
--
--   • NO CHECK constraint, unlike operating_model/status in 0009. Those are
--     load-bearing enums the service and the money model branch on; these three
--     are descriptive metadata the UI guides (a select of build types, a month
--     picker) but does not depend on. Keeping them free `text` means adding a
--     build-type option later is a copy change, not a migration under load.
--
--   • NO new GRANT. identity_app already holds INSERT on identity.project (0002),
--     which is all these need — they are written at create and are not part of the
--     column-scoped UPDATE (operating_model, status) the wizard drives (0009). The
--     request path therefore still cannot rewrite them after genesis, which is the
--     right posture for a fact the audit trail stamps into `project_created`.
--
-- Forward-only: 0001–0013 are already applied, so this is a NEW file, never an
-- edit of an applied one (db/migrate.mjs treats an edited applied file as a
-- checksum error).

CREATE SCHEMA IF NOT EXISTS identity;

ALTER TABLE identity.project
  ADD COLUMN IF NOT EXISTS site_address   text,
  ADD COLUMN IF NOT EXISTS build_type     text,
  ADD COLUMN IF NOT EXISTS expected_start text;
