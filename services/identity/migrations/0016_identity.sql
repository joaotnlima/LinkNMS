-- Identity — the two descriptive Invite fields the pen's New-build screen 04 draws
-- that identity.invitation had no home for (LINA-222; ADR-0011, Band B).
--
-- ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────
-- The republished New-build pen's Invite screen (linkNMS.pen → "Band B · Create
-- the build and invite", screen "D4 · New build · Invite") draws five things:
-- a "Name or company", a Role picker, an Email, a "Scope note", and the
-- "What they will be able to do" consent callout. Email + a model-derived role
-- shipped in LINA-219 (@ 80dddfa); the ROLE picker needs no column (it is the
-- existing invitation.role, chosen instead of derived for Hybrid — ADR-0011
-- OQ-3). The two remaining fields — the invitee's Name/company and the free-text
-- Scope note — had nowhere to land, so per this codebase's standing rule a field
-- that accepts what the owner types and then discards it is worse than its
-- absence, they were deliberately NOT rendered (the GAPS note in
-- app/src/lib/build-creation.ts). This migration gives them a home.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────
-- Both are NULLABLE `text`, set once at INSERT (the wizard's invite step) and
-- never mutated by the request path afterward — the same shape and rationale as
-- the Basics descriptive fields (migration 0014):
--
--   • NULLABLE, no back-fill: every invitation minted before this — and every
--     out-of-band/email-only invite that skips them — simply has none, which is
--     the truth, not a guessed value.
--
--   • NO CHECK constraint. These are descriptive metadata the inviter types for
--     their own record ("who am I inviting, for what"); the service caps their
--     length (MAX_INVITEE_NAME / MAX_SCOPE_NOTE) but the shape is free text, so
--     the UI can guide it without a schema migration under load.
--
--   • NO new GRANT. identity_app already holds INSERT on identity.invitation
--     (0002), which is all these need — they are written at mint and are not part
--     of any column-scoped UPDATE. The accept path (markInvitationAccepted, 0002)
--     never touches them, so an invitation's Name/Scope note stay exactly what the
--     inviter wrote — the right posture for a fact the invite record preserves.
--
-- Additive and behaviour-neutral to every existing flow: all current rows already
-- carry NULL for both, and no live caller sends them yet. Forward-only: 0001–0015
-- are already applied, so this is a NEW file, never an edit of an applied one
-- (db/migrate.mjs treats an edited applied file as a checksum error).

CREATE SCHEMA IF NOT EXISTS identity;

ALTER TABLE identity.invitation
  ADD COLUMN IF NOT EXISTS invitee_name text,
  ADD COLUMN IF NOT EXISTS scope_note   text;
