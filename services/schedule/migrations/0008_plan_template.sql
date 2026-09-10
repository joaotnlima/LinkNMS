-- Plan templates — a names-only scaffold with NO audit weight (LINA-241; ADR-0018).
--
-- A plan template is NOT a plan. It never links to a project's stages, never
-- stamps authorship, never moves a budget, and carries no ledger seam — it lives
-- entirely OUTSIDE the tamper-evident record (ADR-0002). Editing a template is a
-- mutable CRUD write, deliberately unlike the append-only plan lifecycle: a
-- template is a COPY target, and `seedSkeleton()` copies its `body` into a fresh
-- editor draft. Nothing here loosens the freeze model or the stage audit trail.
--
-- Templates live in schema `schedule` because they are plan-shaped, and the
-- schedule service stays the sole owner of that schema (ADR-0006 §1).
--
-- v1 scope (founder decision, ADR-0018 §Decisions made): per-USER default, a
-- single "my default" per user, no named library. Org scope is DEFERRED — the
-- enum value and `owner_id` column stay so enabling it later needs no migration,
-- but v1 neither writes nor consults `org`.
--
-- Forward-only. Applied by the migrator role; owned + finalised by the Full-Stack
-- Architect (drafted here; reviewed & applied to Neon by the Architect). NEVER
-- edit an applied migration — the prod schema-gate byte-checksum guard halts ALL
-- migrates if an applied file's bytes change (LINA-148 hotfix history).

CREATE TABLE schedule.plan_template (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope  text NOT NULL CHECK (owner_scope IN ('system', 'org', 'user')),
  owner_id     uuid,
  name         text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  body         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- The system default has no owner; every org/user template must name one. The
  -- biconditional pins both directions: system ⟺ owner_id IS NULL.
  CONSTRAINT plan_template_system_has_no_owner
    CHECK ((owner_scope = 'system') = (owner_id IS NULL))
);

-- One default per owner. Partial unique index over (owner_scope, owner_id) among
-- the default rows only — non-default rows (a future named library) are
-- unconstrained, so that later slice needs no migration rework.
--
-- NULLS NOT DISTINCT is load-bearing: the system default has owner_id NULL, and
-- under the default NULLS-DISTINCT semantics two system defaults would NOT
-- collide (NULL <> NULL), silently permitting a second source of truth. Treating
-- NULLs as equal here enforces exactly ONE system default. (PG15+ / Neon.)
CREATE UNIQUE INDEX plan_template_one_default_per_owner
  ON schedule.plan_template (owner_scope, owner_id)
  NULLS NOT DISTINCT
  WHERE is_default;

-- ── Seed the single system default from PLAN_SKELETON ─────────────────────────
-- The one seeded row becomes the single source of truth for the default shape;
-- the FE constant PLAN_SKELETON (app/src/lib/plan-authoring.ts) is demoted to an
-- unreachable-endpoint fallback by the FE slice. This body is byte-identical to
-- services/schedule/plan-skeleton.mjs (guarded by plan-template.pg.test.mjs) and
-- to PLAN_SKELETON (guarded FE-side). Idempotent: seeds only if absent, so a
-- re-run on a branch that already carries the row is a no-op.
INSERT INTO schedule.plan_template (owner_scope, owner_id, name, is_default, body)
SELECT 'system', NULL, 'Standard residential build', true, $json$[
  {
    "name": "1 · Pre-Construction",
    "tasks": [
      "1.1 Planning & Feasibility",
      "1.2 Design & Engineering",
      "1.3 Permitting & Approval",
      "1.4 Budget & Schedule"
    ]
  },
  {
    "name": "2 · Construction (Execution)",
    "tasks": [
      "2.1 Preliminary Works",
      "2.2 Substructure (Foundations)",
      "2.3 Superstructure (Frame)",
      "2.4 Masonry / Enclosure",
      "2.5 Roofing",
      "2.6 Plumbing",
      "2.7 Electrical",
      "2.8 Complementary Systems (HVAC)",
      "2.9 Interior Finishes",
      "2.10 Doors & Windows",
      "2.11 Painting",
      "2.12 Sanitary Ware"
    ]
  },
  {
    "name": "3 · Post-Construction",
    "tasks": [
      "3.1 Inspection & Handover",
      "3.2 Warranty & Maintenance"
    ]
  }
]$json$::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM schedule.plan_template WHERE owner_scope = 'system' AND is_default
);

-- ── Least-privilege grants for schedule_app ───────────────────────────────────
-- Templates are mutable CRUD (unlike the append-only history tables): the caller
-- creates and replaces their own default via upsert (INSERT + UPDATE). No DELETE
-- grant in v1 — nothing removes a template yet, and withholding the grant keeps
-- that true at the database, not just in the service.
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.plan_template TO schedule_app;
