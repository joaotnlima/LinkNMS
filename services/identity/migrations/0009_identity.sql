-- Identity — Band B "Create the build and invite": operating model, draft status,
-- and the counterparty/subcontractor invite vocabulary (LINA-164; ADR-0011).
--
-- Band B extends the create-record-then-invite spine already shipped in 0002
-- (identity.project + membership + single-use invitation) rather than adding a new
-- Build table — the "build" IS the project (approved design, LINA-164). This
-- migration adds the two projection columns the wizard needs and widens the R0
-- role vocabulary so the same spine can carry a specialty subcontractor, not just
-- the one GC counterparty. It is deliberately ADDITIVE and behaviour-neutral: the
-- application still invites only `counterparty` (identity.mjs guard is relaxed in
-- the step-2 wiring PR), so shipping this ahead of the UI cannot change any live
-- flow — it only makes the schema ready.
--
-- Forward-only: 0001–0008 are already applied, so this is a NEW migration, never
-- an edit of an applied file (db/migrate.mjs treats an edited applied file as a
-- checksum error). No cross-schema FK: these rows stay bare-UUID-referenced and
-- validated at the service boundary (split-DB seam, ADR-0006 §1).

CREATE SCHEMA IF NOT EXISTS identity;

-- ── project: operating_model + status (draft-first wizard) ───────────────────
-- The Band B wizard is draft-first (approved OQ): the build row exists from
-- step 1 (name), the operating model is chosen in step 2, and the build flips to
-- `active` when the first invite commits it. Two new columns carry that:
--
--   operating_model — NULLABLE on purpose. A draft build has not chosen one yet,
--     and every project created before Band B (via the one-shot createProject)
--     predates the concept, so NULL is a first-class "not chosen" state rather
--     than a back-filled guess. When set it is one of the three §4 models. The
--     wizard enforces "operating_model present before commit" at the service
--     layer; the DB keeps NULL legal so legacy rows and drafts stay valid.
--
--   status — DEFAULT 'active'. This is the load-bearing back-fill choice: every
--     existing project was created fully-formed by the one-shot createProject
--     (name + baseline budget + owner membership + counterparty invite), i.e. it
--     is already active, so 'active' is the correct value for all applied rows
--     AND for the untouched legacy path (which sets no status). The new
--     draft-first insert is the ONLY writer that sets 'draft' explicitly.
ALTER TABLE identity.project
  ADD COLUMN IF NOT EXISTS operating_model text,
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'active';

-- Idempotent guards (ADD CONSTRAINT has no portable IF NOT EXISTS): drop-then-add
-- keeps the migration replayable by hand.
ALTER TABLE identity.project
  DROP CONSTRAINT IF EXISTS project_operating_model_check;
ALTER TABLE identity.project
  ADD CONSTRAINT project_operating_model_check
  CHECK (operating_model IS NULL
         OR operating_model IN ('turnkey', 'direct', 'hybrid'));

ALTER TABLE identity.project
  DROP CONSTRAINT IF EXISTS project_status_check;
ALTER TABLE identity.project
  ADD CONSTRAINT project_status_check
  CHECK (status IN ('draft', 'active'));

-- Owner-facing lists want "my drafts" cheaply; drafts are the small, hot set an
-- owner is mid-flow on, so a partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS identity_project_draft_idx
  ON identity.project (owner_party_id) WHERE status = 'draft';

-- ── invitation.role: allow specialty subcontractor, keep GC == counterparty ──
-- 0002 hard-pinned role to the single value 'counterparty' (R0 invited only the
-- one GC). Band B's Direct-to-specialty and Hybrid models invite a specialty sub,
-- so widen the CHECK to the launch vocabulary (§7). Default stays 'counterparty'
-- so the untouched GC path is unchanged. The inline 0002 CHECK is auto-named
-- `invitation_role_check` (single unnamed column check → deterministic name).
ALTER TABLE identity.invitation
  DROP CONSTRAINT IF EXISTS invitation_role_check;
ALTER TABLE identity.invitation
  ADD CONSTRAINT invitation_role_check
  CHECK (role IN ('counterparty', 'subcontractor'));

-- ── one-pending index → per-role (OQ-3: one-invite V1, Hybrid-ready) ─────────
-- 0002's partial unique index allowed AT MOST ONE pending invite per project.
-- Approved OQ-3 keeps V1 to one invite per wizard pass, but ships the per-role
-- index now so Hybrid (owner invites a GC *and* a specialty) is a purely additive
-- V2 change, not a schema migration under load. Per-role means a project may hold
-- one pending `counterparty` and one pending `subcontractor` at once, but never
-- two of the same role. Membership's UNIQUE(project_id, role) remains the hard
-- backstop once an invite accepts.
DROP INDEX IF EXISTS identity.identity_invitation_one_pending;
CREATE UNIQUE INDEX IF NOT EXISTS identity_invitation_one_pending_per_role
  ON identity.invitation (project_id, role)
  WHERE status = 'pending';

-- ── membership.role: allow subcontractor as a project member ─────────────────
-- The accept path writes identity.membership with the invitation's role, so the
-- membership CHECK must admit the same widened vocabulary. owner and counterparty
-- (== GC) are unchanged; add subcontractor. Auto-named `membership_role_check`.
ALTER TABLE identity.membership
  DROP CONSTRAINT IF EXISTS membership_role_check;
ALTER TABLE identity.membership
  ADD CONSTRAINT membership_role_check
  CHECK (role IN ('owner', 'counterparty', 'subcontractor'));

-- ── Grant: column-scoped UPDATE on project (least privilege) ─────────────────
-- The wizard mutates a draft build twice: PATCH operating_model (step 2) and the
-- draft→active flip on commit (step 3). identity_app holds only SELECT, INSERT on
-- identity.project today (0002), so it needs UPDATE — but a COLUMN-SCOPED grant,
-- not a blanket one. Restricting UPDATE to (operating_model, status) means the
-- request path can drive the wizard yet can NEVER rewrite baseline_budget_cents
-- or owner_party_id — the audit-sensitive fields whose changes must only ever be
-- expressed as ledger events, never a silent projection edit (ADR-0002 intent).
GRANT UPDATE (operating_model, status) ON TABLE identity.project TO identity_app;
