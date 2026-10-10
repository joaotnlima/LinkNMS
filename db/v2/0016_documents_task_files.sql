-- 0016 — Task files: one project file linked to many tasks, version notes and
-- the preview state (PRD-05 F-3, F-6..F-11; PRD-06/07 hooks).
--
--   1. documents.document_link — a file lives ONCE in the project and is
--      linked to the tasks that use it (role reference | deliverable). A new
--      version therefore shows on every linking task. `inherited` marks a link
--      made by "also on sub-tasks" on an ancestor (removable per sub-task).
--      `share_with_ancestors` was evaluated for this and does not fit: it widens
--      a CONTRACT document to the client chain (V3), not a file to sub-tasks.
--      project_id is denormalised so a project's links read without planning.*.
--
--   2. document_version.note / base_version_no / change_kind — the change note
--      of a version (shown in the history, carried on the event) and, for
--      PRD-06/07, which version an edited / markup-only copy was made from.
--      The table is append-only (trigger, 0001): ADD COLUMN with defaults does
--      not touch existing rows' content and fires no row trigger.
--
--   3. document.preview_status — ready | pending | unavailable. A DWG waits for
--      its server-side conversion (D-49, PRD-06) as `pending`; everything else
--      is `ready`. Document-level: the latest version's preview.
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).
-- Forward-only, no data rewrite.

ALTER TABLE documents.document
  ADD COLUMN preview_status text NOT NULL DEFAULT 'ready'
    CHECK (preview_status IN ('ready', 'pending', 'unavailable'));

ALTER TABLE documents.document_version
  ADD COLUMN note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  ADD COLUMN base_version_no int CHECK (base_version_no IS NULL OR base_version_no >= 1),
  ADD COLUMN change_kind text NOT NULL DEFAULT 'upload'
    CHECK (change_kind IN ('upload', 'markup_only', 'edit'));

CREATE TABLE documents.document_link (
  document_id            uuid NOT NULL REFERENCES documents.document(id),
  task_id                uuid NOT NULL,
  project_id             uuid NOT NULL,
  role                   text NOT NULL DEFAULT 'reference' CHECK (role IN ('reference', 'deliverable')),
  inherited              boolean NOT NULL DEFAULT false,
  inherited_from_task_id uuid,
  linked_by_person_id    uuid NOT NULL,
  linked_by_org_id       uuid NOT NULL,
  linked_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, task_id),
  CONSTRAINT document_link_inherited_source CHECK (inherited = (inherited_from_task_id IS NOT NULL))
);

CREATE INDEX document_link_task_idx ON documents.document_link (task_id);
CREATE INDEX document_link_project_idx ON documents.document_link (project_id);

-- The project files page lists a build's documents newest-first.
CREATE INDEX document_project_idx ON documents.document (project_id) WHERE deleted_at IS NULL;
