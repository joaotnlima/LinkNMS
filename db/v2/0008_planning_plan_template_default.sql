-- Plan template "my default" on v2 (LINA-383, phase 12b.4) — the read + save-default
-- half of the plan-authoring cutover off v1 `/me/plan-template` (LINA-241, ADR-0018).
--
-- The v2 bootstrap (db/v2/0001_schema.sql) already carries planning.plan_template
-- and planning.plan_template_row — the richer library model the future template
-- feature builds on. This forward migration adds the two affordances the
-- names-only "my default" needs on TOP of that table, WITHOUT touching the applied
-- bootstrap (forward-only; the prod schema-gate byte-checksum guard halts ALL
-- migrates if an applied file's bytes change):
--
--   1. `is_default` — the single default flag, plus a partial unique index that
--      pins ONE default per owner (personal → per person; library → the one
--      system default). NULLS NOT DISTINCT is load-bearing: the library default
--      has owner_person_id NULL, and under default NULLS-DISTINCT two library
--      defaults would NOT collide, silently allowing a second source of truth.
--   2. `updated_at` — surfaced back as `template.updatedAt` (the v1 shape a "Save
--      as my default" control shows), stamped on every upsert.
--
-- A plan template carries NO audit weight: it never links to a project's tasks,
-- never stamps authorship, never moves a budget, never appends a ledger event
-- (ADR-0002). `seedSkeleton()` COPIES its rows into a fresh editor draft — the
-- copy-not-link boundary of LINA-241. So this is mutable CRUD (INSERT/UPDATE/
-- DELETE the caller's own rows), deliberately unlike the append-only plan life.
--
-- Forward-only. NEVER edit an applied migration.

ALTER TABLE planning.plan_template
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- One default per owner. Partial unique index over (scope, owner_person_id) among
-- default rows only; non-default rows (a future named library) stay unconstrained
-- so that later slice needs no rework. NULLS NOT DISTINCT → exactly ONE library
-- default (owner_person_id NULL) and exactly ONE personal default per person.
CREATE UNIQUE INDEX IF NOT EXISTS plan_template_one_default_per_owner
  ON planning.plan_template (scope, owner_person_id)
  NULLS NOT DISTINCT
  WHERE is_default;

-- ── Seed the single library (system) default ──────────────────────────────────
-- Byte-identical phase/task names to the v1 seed (services/schedule/migrations/
-- 0008_plan_template.sql) and to the FE PLAN_SKELETON fallback, so the resolved
-- default is the same scaffold whichever transport answered during the cutover.
-- Idempotent: seeds only if no library default exists, so a re-run is a no-op.
DO $seed$
DECLARE
  tpl_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM planning.plan_template WHERE scope = 'library' AND is_default) THEN
    RETURN;
  END IF;

  tpl_id := gen_random_uuid();
  INSERT INTO planning.plan_template
    (id, scope, owner_person_id, owner_org_id, name, description,
     construction_type, phase_tags, is_default)
  VALUES
    (tpl_id, 'library', NULL, NULL, 'Standard residential build', NULL,
     'residential', '{}', true);

  INSERT INTO planning.plan_template_row
    (template_id, row_key, parent_row_key, position, kind, name, specialty)
  VALUES
    (tpl_id, 'p01', NULL,  '01', 'summary', '1 · Pre-Construction',            NULL),
    (tpl_id, 'p01.t01', 'p01', '01', 'task', '1.1 Planning & Feasibility',     NULL),
    (tpl_id, 'p01.t02', 'p01', '02', 'task', '1.2 Design & Engineering',       NULL),
    (tpl_id, 'p01.t03', 'p01', '03', 'task', '1.3 Permitting & Approval',      NULL),
    (tpl_id, 'p01.t04', 'p01', '04', 'task', '1.4 Budget & Schedule',          NULL),
    (tpl_id, 'p02', NULL,  '02', 'summary', '2 · Construction (Execution)',    NULL),
    (tpl_id, 'p02.t01', 'p02', '01', 'task', '2.1 Preliminary Works',          NULL),
    (tpl_id, 'p02.t02', 'p02', '02', 'task', '2.2 Substructure (Foundations)', NULL),
    (tpl_id, 'p02.t03', 'p02', '03', 'task', '2.3 Superstructure (Frame)',     NULL),
    (tpl_id, 'p02.t04', 'p02', '04', 'task', '2.4 Masonry / Enclosure',        NULL),
    (tpl_id, 'p02.t05', 'p02', '05', 'task', '2.5 Roofing',                    NULL),
    (tpl_id, 'p02.t06', 'p02', '06', 'task', '2.6 Plumbing',                   NULL),
    (tpl_id, 'p02.t07', 'p02', '07', 'task', '2.7 Electrical',                 NULL),
    (tpl_id, 'p02.t08', 'p02', '08', 'task', '2.8 Complementary Systems (HVAC)', NULL),
    (tpl_id, 'p02.t09', 'p02', '09', 'task', '2.9 Interior Finishes',          NULL),
    (tpl_id, 'p02.t10', 'p02', '10', 'task', '2.10 Doors & Windows',           NULL),
    (tpl_id, 'p02.t11', 'p02', '11', 'task', '2.11 Painting',                  NULL),
    (tpl_id, 'p02.t12', 'p02', '12', 'task', '2.12 Sanitary Ware',             NULL),
    (tpl_id, 'p03', NULL,  '03', 'summary', '3 · Post-Construction',           NULL),
    (tpl_id, 'p03.t01', 'p03', '01', 'task', '3.1 Inspection & Handover',      NULL),
    (tpl_id, 'p03.t02', 'p03', '02', 'task', '3.2 Warranty & Maintenance',     NULL);
END
$seed$;
