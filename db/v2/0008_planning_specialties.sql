-- Planning specialty catalog — per-org user-created trade labels (LINA-380).
--
-- The picker in PlanGrid.tsx is enhancement-only: the seeded system set below
-- is offered immediately; a user can add their own labels and they will be
-- remembered across projects for that org. No label is ever required; free-form
-- input still stands if the endpoint is unreachable.
--
-- Intentionally separate from directory.specialty (a static code-catalog used
-- for org profiles / tendering). This table tracks what a GC has typed on
-- their plan tasks — a per-org suggest list, not a master classification.

CREATE TABLE IF NOT EXISTS planning.user_specialty (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES identity.organization(id) ON DELETE CASCADE,
  label      text NOT NULL CHECK (char_length(trim(label)) > 0 AND char_length(label) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lower(label))
);

CREATE INDEX IF NOT EXISTS user_specialty_org_idx ON planning.user_specialty (org_id);

-- System-level specialty labels are embedded directly in the endpoint so they
-- require no DB rows; this migration only creates the per-org overflow table.
