-- Identity — retire the magic-link sign-in token store (LINA-149; ADR-0007 SUPERSEDED).
--
-- This drops `identity.sign_in_token` (created in 0003), the last live remnant of
-- the self-managed magic-link identity plane. The application layer was already
-- removed by LINA-124 (Auth Migration 0B): `services/identity/sign-in.mjs`,
-- `sign-in-store.mjs`, `session.mjs` (the `lnms_session` HMAC cookie), and the
-- `POST /api/v1/sessions/request` + `/consume` routes are all deleted, and
-- sign-in is now Clerk's (LINA-123 auth-bridge). Nothing in the codebase reads,
-- writes, or references this table any more — the only mention was 0003 itself.
--
-- ── WHY THIS IS SAFE TO DROP (not audit data) ────────────────────────────────
-- The 0003 header is explicit that minting/consuming a sign-in token is NOT
-- project history: it writes no ledger event and has no cross-schema FK or
-- ledger seam. So ADR-0002's immutability duty does not reach these rows — this
-- is not the audit trail, it is spent single-use auth scratch. With the consume
-- route gone, every remaining row is a one-time token that can never be
-- redeemed; dropping the table also removes the typed email addresses it stored
-- at rest (a small PII reduction), which is the point of retiring a dead plane
-- rather than leaving it to accumulate.
--
-- ── ARCHITECT GATE (LINA-149) ────────────────────────────────────────────────
-- This is the Architect-gated, forward-only retirement scheduled by the LINA-142
-- review (§8.2/§8.4). The gate condition — "once Clerk cutover is proven in
-- prod" — is met: LINA-124 shipped (fb8e69e), Clerk is live in prod, and the
-- legacy magic-link routes 404. Ratified by the Full-Stack Architect, 2026-09-03.
--
-- Forward-only: 0001–0007 are already applied, so retirement is a NEW migration,
-- never an edit of 0003 (an edited applied file is a checksum error in the
-- runner). The table's two indexes and its `identity_app` grant are owned by the
-- table and are removed with it; `identity_app` keeps every other grant (party,
-- invitation, seat, RBAC) and is untouched. No CASCADE: nothing depends on this
-- table, so a plain DROP must succeed — and if some unexpected dependent ever
-- existed, failing loud here beats silently cascading it away.

CREATE SCHEMA IF NOT EXISTS identity;

DROP TABLE IF EXISTS identity.sign_in_token;
