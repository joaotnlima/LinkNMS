-- 0027 — Quality on screen: where a non-conformity is, what the last step said,
-- and inspections against locations (PRD-12 N-3, N-4).
--
-- Ownership: Quality (doc 02). Additive only:
--
--   1. quality.nonconformity.location_id — the project location it was found
--      at (bare ref to project.location, no cross-schema FK; the use case
--      checks it through the project's build port).
--      raised_at / status_changed_at — the list is newest first and shows how
--      long the step has been waiting; back-filled from the ledger entry that
--      raised it (record.audit_event, object = nonconformity), else now().
--      last_note — the note of the latest transition (why a fix was rejected,
--      what the fix was). The full history stays the ledger's.
--
--   2. quality.inspection.location_ids — the locations inspected, beside
--      task_ids. inspector_person_id is not added: the ledger names the person.
--      recorded_at — newest first in the list.
--
-- The close-by-raiser CHECK (8h) is unchanged. Forward-only. No GRANTs (single
-- application pool, see 0008).

ALTER TABLE quality.nonconformity
  ADD COLUMN location_id       uuid,
  ADD COLUMN raised_at         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN last_note         text CHECK (last_note IS NULL OR char_length(last_note) BETWEEN 1 AND 2000);

UPDATE quality.nonconformity n
   SET raised_at = e.occurred_at
  FROM record.audit_event e
 WHERE e.project_id = n.project_id
   AND e.type = 'quality.nonconformity.raised'
   AND e.object_type = 'nonconformity'
   AND e.object_id = n.id;

CREATE INDEX nonconformity_project_idx ON quality.nonconformity (project_id, raised_at DESC);

ALTER TABLE quality.inspection
  ADD COLUMN location_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN recorded_at  timestamptz NOT NULL DEFAULT now();

CREATE INDEX inspection_project_idx ON quality.inspection (project_id, date DESC);
