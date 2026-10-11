-- 0025 — The PartyInvite (PRD-09 O-3..O-5).
--
-- Ownership: Project. Flow 01 screen 4 invites a party with a name, an email,
-- a role and a scope note; the invitation kept only email + capacity.
--
-- 1. `contractor` joins the invitation capacities: a general or specialty
--    contractor invited BEFORE any contract (flow 01 A3–A4). It is presence on
--    the build, not a contract: participation stays source `invitation`,
--    capacity `consultant` (the "joined by invitation" bucket every invite
--    already uses) and gains no edit scope — that comes only from a contract
--    (D-33, D-35). `specialty_code` names the trade (directory taxonomy,
--    checked through the directory's port, never a cross-schema FK); none on a
--    contractor invite = general contractor.
-- 2. `invitee_name`, `scope_note` — what the inviter typed, shown on the
--    accept landing; `created_at` for the participants page.
-- 3. participation carries the specialty forward on accept, so the
--    participants list names the trade without reading invitations.
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).

ALTER TABLE project.project_invitation
  DROP CONSTRAINT project_invitation_capacity_check,
  ADD CONSTRAINT project_invitation_capacity_check
    CHECK (capacity IN ('design','inspection','safety','contractor','other')),
  ADD COLUMN invitee_name   text CHECK (invitee_name IS NULL OR char_length(invitee_name) <= 200),
  ADD COLUMN scope_note     text CHECK (scope_note IS NULL OR char_length(scope_note) <= 1000),
  ADD COLUMN specialty_code text
    CONSTRAINT project_invitation_specialty_code_shape
      CHECK (specialty_code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(specialty_code) <= 60),
  ADD COLUMN created_at     timestamptz NOT NULL DEFAULT now();

ALTER TABLE project.participation
  DROP CONSTRAINT participation_invite_capacity_check,
  ADD CONSTRAINT participation_invite_capacity_check
    CHECK (invite_capacity IN ('design','inspection','safety','contractor','other')),
  ADD COLUMN specialty_code text
    CONSTRAINT participation_specialty_code_shape
      CHECK (specialty_code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(specialty_code) <= 60);

CREATE INDEX project_invitation_inviter ON project.project_invitation (project_id, invited_by_org_id, created_at DESC);
