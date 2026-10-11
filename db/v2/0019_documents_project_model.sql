-- 0019 — The shared project model: one model per build, record-side edits only
-- (PRD-07 M-1..M-18, D-45).
--
--   1. documents.document.is_project_model — THE model of a build: a project-
--      scoped `bim` document, at most one live per project (partial unique
--      index). Other .ifc project files stay ordinary files.
--
--   2. (RFPs reference the project model: tendering.rfp.model_document_id +
--      model_version_no — moved to 0018_tendering_rfp_model.sql, which runs
--      first and records each RFP's model before step 3 re-scopes it.)
--
--   3. Data migration of the LINA-409 RFP models (forward-only): every
--      `rfp`-scoped `bim` document moves to its project's scope (readers widen
--      from the RFP's audience to every participant — M-7); per project the
--      model an RFP referenced (the first live `bim` of an RFP — the same rule
--      0018_tendering_rfp_model.sql applied), else the oldest live `bim` file,
--      becomes THE project model. Computed from documents.* alone (no read of
--      tendering.*). Ledger entries already written keep their original scope
--      (the record is never rewritten).
--
--   4. document_version.change_kind gains `restore` (M-17: Restore vN appends
--      v(n+1) re-pointing vN's bytes; base_version_no names vN). An `edit`
--      version (M-12) re-points the current bytes the same way. The append-only
--      trigger of 0001 fires on UPDATE / DELETE only: such INSERTs are allowed.
--
--   5. documents.element_link — element (IFC GlobalId) ↔ task, record-side,
--      versioned with the model: added_in_version / removed_in_version. The live
--      record is `removed_in_version IS NULL`; the record at version N is
--      added ≤ N < removed. Rows are never deleted; removal only stamps the
--      removed_* columns. Keyed by GlobalId, so links survive a re-upload.
--
--   6. documents.element_pin — an issue pinned on one or more elements,
--      naming zero or more tasks (M-5). Record-side, versioned like the links.
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).

ALTER TABLE documents.document
  ADD COLUMN is_project_model boolean NOT NULL DEFAULT false;

-- 3. Data: THE project model first (while the RFP scope still tells which
--    file an RFP referenced), then the RFP models move to the build.
UPDATE documents.document d
   SET is_project_model = true
  FROM (SELECT DISTINCT ON (doc.project_id) doc.id
          FROM documents.document doc
          JOIN documents.document_version v1 ON v1.document_id = doc.id AND v1.version_no = 1
         WHERE doc.scope_type IN ('project', 'rfp') AND doc.kind = 'bim' AND doc.project_id IS NOT NULL
           AND doc.deleted_at IS NULL AND doc.current_version > 0
         ORDER BY doc.project_id,
                  (doc.scope_type = 'rfp' AND NOT EXISTS (
                     SELECT 1 FROM documents.document o
                      WHERE o.scope_type = 'rfp' AND o.scope_id = doc.scope_id AND o.kind = 'bim'
                        AND o.deleted_at IS NULL AND o.current_version > 0 AND o.id < doc.id)) DESC,
                  v1.uploaded_at, doc.id) m
 WHERE d.id = m.id;

UPDATE documents.document
   SET scope_type = 'project', scope_id = project_id
 WHERE scope_type = 'rfp' AND kind = 'bim' AND project_id IS NOT NULL;

ALTER TABLE documents.document
  ADD CONSTRAINT document_project_model_shape
    CHECK (NOT is_project_model OR (scope_type = 'project' AND kind = 'bim' AND project_id IS NOT NULL));

CREATE UNIQUE INDEX document_one_project_model
  ON documents.document (project_id) WHERE is_project_model AND deleted_at IS NULL;

-- 4. Restore versions.
ALTER TABLE documents.document_version
  DROP CONSTRAINT document_version_change_kind_check,
  ADD CONSTRAINT document_version_change_kind_check
    CHECK (change_kind IN ('upload', 'markup_only', 'edit', 'restore')),
  ADD CONSTRAINT document_version_restore_base
    CHECK (change_kind <> 'restore' OR base_version_no IS NOT NULL);

-- 5. Element ↔ task links.
CREATE TABLE documents.element_link (
  id                   uuid PRIMARY KEY,
  project_id           uuid NOT NULL,
  document_id          uuid NOT NULL REFERENCES documents.document(id),
  global_id            text NOT NULL CHECK (global_id ~ '^[0-9A-Za-z_$]{22}$'),
  task_id              uuid NOT NULL,
  added_in_version     int NOT NULL,
  removed_in_version   int,
  created_by_person_id uuid NOT NULL,
  created_by_org_id    uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  removed_by_person_id uuid,
  removed_by_org_id    uuid,
  removed_at           timestamptz,
  FOREIGN KEY (document_id, added_in_version) REFERENCES documents.document_version (document_id, version_no),
  CONSTRAINT element_link_removed_after_added CHECK (removed_in_version IS NULL OR removed_in_version > added_in_version),
  CONSTRAINT element_link_removed_stamp CHECK ((removed_in_version IS NULL) = (removed_at IS NULL))
);

CREATE UNIQUE INDEX element_link_live
  ON documents.element_link (document_id, global_id, task_id) WHERE removed_in_version IS NULL;
CREATE INDEX element_link_document_idx ON documents.element_link (document_id);
CREATE INDEX element_link_task_idx ON documents.element_link (task_id) WHERE removed_in_version IS NULL;

-- 6. Issue pins.
CREATE TABLE documents.element_pin (
  id                uuid PRIMARY KEY,
  project_id        uuid NOT NULL,
  document_id       uuid NOT NULL REFERENCES documents.document(id),
  version_no        int NOT NULL,
  global_ids        text[] NOT NULL CHECK (cardinality(global_ids) BETWEEN 1 AND 200),
  task_ids          uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(task_ids) <= 20),
  text              text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  state             text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  author_person_id  uuid NOT NULL,
  author_org_id     uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_in_version int,
  closed_by_org_id  uuid,
  closed_at         timestamptz,
  FOREIGN KEY (document_id, version_no) REFERENCES documents.document_version (document_id, version_no),
  CONSTRAINT element_pin_closed_stamp CHECK ((state = 'closed') = (closed_in_version IS NOT NULL))
);

CREATE INDEX element_pin_document_idx ON documents.element_pin (document_id);
