-- Identity — Band B "Who are you on this build?": GC-as-creator ownership
-- inversion (LINA-221; ADR-0016, building on ADR-0011).
--
-- ── WHAT THIS CLOSES ──────────────────────────────────────────────────────────
-- The republished New-build pen opens on a role screen: General contractor OR
-- Owner. When a GC creates the build the spine inverts — the creator is the
-- counterparty, and the HOMEOWNER is the party who gets invited. At genesis there
-- is no owner party yet, so this migration lets the record represent that
-- truthfully without weakening the audit trail:
--
--   1. owner_party_id becomes NULLABLE. It still MEANS the homeowner (never the
--      GC). A GC-founded build carries NULL until the invited owner accepts, when
--      it is stamped ONCE, in the same unit of work as the owner membership and an
--      owner_joined ledger event (ADR-0016 §1). Owner-created builds are unchanged.
--   2. invitation.role admits 'owner', so a GC can invite the homeowner
--      (ADR-0016 §4). membership.role already admits 'owner' (0009).
--   3. A COLUMN-SCOPED UPDATE (owner_party_id) grant lets the accept path stamp
--      the owner exactly once. The one-way discipline (NULL → value only) lives in
--      the service (WHERE owner_party_id IS NULL); the grant stays least-privilege
--      so identity_app can never rewrite baseline_budget_cents (ADR-0002 intent).
--
-- Additive and behaviour-neutral to every existing flow: all current rows already
-- have a non-NULL owner, no live caller invites 'owner' or sends creatorRole yet,
-- and legacy createProject is byte-identical. Verified against a full 0001→0015
-- apply.

-- ── owner_party_id: NULLABLE (the homeowner may not be on the record yet) ─────
ALTER TABLE identity.project
  ALTER COLUMN owner_party_id DROP NOT NULL;

-- ── invitation.role: admit 'owner' so a GC can invite the homeowner ──────────
-- 0009 relaxed this from the single value 'counterparty' to
-- {counterparty, subcontractor}; add 'owner' for the inverted first invite. The
-- per-role one-pending index (0009) and membership's UNIQUE(project_id, role)
-- remain the hard backstops — a build still holds at most one owner.
ALTER TABLE identity.invitation
  DROP CONSTRAINT IF EXISTS invitation_role_check;
ALTER TABLE identity.invitation
  ADD CONSTRAINT invitation_role_check
  CHECK (role IN ('owner', 'counterparty', 'subcontractor'));

-- ── Grant: column-scoped UPDATE (owner_party_id) — the one-time owner stamp ───
-- 0009 granted UPDATE (operating_model, status). The accept path of a GC-founded
-- build must additionally bind the homeowner principal to the record. Granting
-- (owner_party_id) alone keeps the least-privilege posture: identity_app still
-- can NEVER touch baseline_budget_cents, and the service guards the write to
-- NULL → value (owner set once, never re-pointed) so an existing owner is
-- immutable at the projection layer (ADR-0016 §4).
GRANT UPDATE (owner_party_id) ON TABLE identity.project TO identity_app;
