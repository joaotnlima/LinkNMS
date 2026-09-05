-- Retire the second, unwired RBAC mirror inside `identity` (LINA-189).
--
-- ── THE ACTUAL HAZARD THIS REMOVES ───────────────────────────────────────────
-- 0006 put a Clerk-backed RBAC mirror in this schema and said so plainly:
--
--   "`identity.membership` (singular, party×project×role) remains the
--    project-access model for R0's self-managed flow, while
--    `identity.memberships` (plural) … are the NEW Clerk-backed RBAC mirror.
--    No name collision, and the legacy tables are NOT touched here (retirement
--    is a separate migration, gated for Architect review)."
--
-- This is that migration, and the review verdict is that the plan inverted:
-- `identity.membership` is not legacy, it is the model the running system
-- authorizes every single request against. The plural table is the one nothing
-- ever wired up. In production it held zero rows, as did `users`, `orgs` and
-- `resource_acls`; only the seeded catalog (3 roles, 14 permissions, 29
-- mappings) was ever written, by 0007 itself.
--
-- "No name collision" was true of Postgres and false of people. Two tables in
-- one schema, one letter apart, one of them load-bearing for who may see a
-- build and the other inert — a query written against the wrong one returns an
-- empty result rather than an error, which on an authorization table means
-- silently denying everyone or, with the polarity flipped, silently admitting
-- them. That is not a hazard worth carrying for a model nothing consults.
--
-- Same reasoning as services/auth/migrations/0004_authz_retire.sql, which drops
-- the OTHER copy of this same design. Between them, production went from three
-- parallel answers to "what may this person do here" down to the one the
-- ADR-0004 authorizer actually asks: `identity.membership`.
--
-- ── WHAT IS DROPPED, AND WHAT IS EMPHATICALLY NOT ────────────────────────────
-- Dropped (all from 0006/0007, all unread by deployed code):
--     identity.resource_acls, identity.role_permissions, identity.memberships,
--     identity.permissions, identity.roles, identity.orgs, identity.users
--
-- KEPT — the live model, untouched by this file:
--     identity.party        the record's identity, keyed on by every service
--     identity.membership   SINGULAR — project access, the authorizer's input
--     identity.project · identity.invitation · identity.seat
--
-- Explicit per-table DROPs in dependency order rather than a schema-level
-- CASCADE, because unlike `authz` this schema also contains the live tables. A
-- CASCADE here would be a single typo away from dropping the record itself.
-- RESTRICT is the default and is left in force on purpose: if anything outside
-- this list has come to depend on one of these tables since, this migration
-- fails loudly instead of quietly taking that dependency with it.

DROP TABLE IF EXISTS identity.resource_acls;
DROP TABLE IF EXISTS identity.role_permissions;
DROP TABLE IF EXISTS identity.memberships;
DROP TABLE IF EXISTS identity.permissions;
DROP TABLE IF EXISTS identity.roles;
DROP TABLE IF EXISTS identity.orgs;
DROP TABLE IF EXISTS identity.users;
