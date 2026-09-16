-- Specialty catalog — the pickable list of trade labels (LINA-306 item 6).
--
-- Background: a plan stage carries a FREE-FORM `trade` label (a typed chip) —
-- see schedule.stage.trade / plan-authoring. That stays exactly as it is; this
-- table does NOT replace it and adds no foreign key to it. What the founder asked
-- for is a PICKER: "add specialties from a list … pre-filled some of them or
-- create on the fly and have it available cross projects." So this is a suggest
-- catalog that powers a datalist — the stage still stores the chosen string.
--
-- Scope (mirrors plan_template, ADR-0018): a `system` set seeded here is visible
-- to everyone; a `user` row is a specialty a party created on the fly and is
-- visible to THAT party across every project they touch (the "cross projects"
-- ask — the domain is keyed on identity.party.id, there is no org catalog yet,
-- so per-party is the honest scope). No ledger seam, no project authorizer: a
-- catalog carries no audit weight (ADR-0002), exactly like plan_template.
--
-- Forward-only. Applied by the migrator role; owned + finalised by the Full-Stack
-- Architect. NEVER edit an applied migration — the prod schema-gate byte-checksum
-- guard halts ALL migrates if an applied file's bytes change.

CREATE TABLE schedule.specialty (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope  text NOT NULL CHECK (owner_scope IN ('system', 'user')),
  owner_id     uuid,
  label        text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- A system specialty has no owner; every user specialty must name one. The
  -- biconditional pins both directions: system ⟺ owner_id IS NULL.
  CONSTRAINT specialty_system_has_no_owner
    CHECK ((owner_scope = 'system') = (owner_id IS NULL))
);

-- No duplicate label per owner, case-insensitively — "Electrical" and
-- "electrical" collide so the picker never shows two of the same trade. Scoped
-- by (owner_scope, owner_id): a user may re-create a label that already exists as
-- a system default (harmless — the list de-dupes on read), but cannot hold two
-- copies of their own. NULLS NOT DISTINCT so the system rows (owner_id NULL)
-- share one namespace rather than each being distinct under NULL <> NULL.
CREATE UNIQUE INDEX specialty_unique_label_per_owner
  ON schedule.specialty (owner_scope, owner_id, lower(btrim(label)))
  NULLS NOT DISTINCT;

-- Fast "my picker" read: system rows ∪ this party's rows.
CREATE INDEX specialty_by_owner ON schedule.specialty (owner_scope, owner_id);

-- ── Seed the common trades as system specialties ─────────────────────────────
-- A pragmatic residential-build set. Idempotent: inserts only labels not already
-- present as a system row, so a re-run (or a later append to this list in a NEW
-- migration) never duplicates. Ordering is not stored — the service sorts by
-- label on read.
INSERT INTO schedule.specialty (owner_scope, owner_id, label)
SELECT 'system', NULL, label
FROM (VALUES
  ('General Contractor'),
  ('Site Preparation & Excavation'),
  ('Concrete & Foundations'),
  ('Framing & Carpentry'),
  ('Masonry'),
  ('Roofing'),
  ('Waterproofing & Insulation'),
  ('Windows & Doors'),
  ('Plumbing'),
  ('Electrical'),
  ('HVAC'),
  ('Drywall & Plastering'),
  ('Painting'),
  ('Flooring & Tiling'),
  ('Cabinetry & Millwork'),
  ('Landscaping'),
  ('Structural Engineering'),
  ('Architecture'),
  ('Surveying'),
  ('Inspection')
) AS seed(label)
WHERE NOT EXISTS (
  SELECT 1 FROM schedule.specialty s
  WHERE s.owner_scope = 'system' AND lower(btrim(s.label)) = lower(btrim(seed.label))
);

-- ── Least-privilege grants for schedule_app ──────────────────────────────────
-- The caller lists (SELECT) and creates their own on the fly (INSERT). No UPDATE
-- or DELETE in v1 — nothing renames or removes a specialty yet, and withholding
-- the grant keeps that true at the database, not just in the service.
GRANT SELECT, INSERT ON TABLE schedule.specialty TO schedule_app;
