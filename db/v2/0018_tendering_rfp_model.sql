-- 0018 (tendering) — RFPs reference the build's model instead of owning one
-- (PRD-07 §5, D-45). Split out of 0019_documents_project_model.sql (audit S3):
-- each migration writes only its own module's schema.
--
--   1. tendering.rfp.model_document_id + model_version_no (NULL = follows the
--      current version; a number = a pinned version). Ids only, no cross-schema
--      FK (doc 02).
--
--   2. Data (forward-only): each RFP points at its own LINA-409 model — the
--      first live `bim` document scoped to the RFP. This READS documents.document
--      and must run BEFORE 0019_documents_project_model.sql re-scopes those files
--      to their project (after that the RFP scope is gone), hence it sorts
--      between 0018_documents_markup_preview.sql and 0019 rather than after 0019.
--      It writes tendering.* only; documents.* is 0019's.
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).

ALTER TABLE tendering.rfp
  ADD COLUMN model_document_id uuid,
  ADD COLUMN model_version_no int CHECK (model_version_no IS NULL OR model_version_no >= 1),
  ADD CONSTRAINT rfp_model_pin_needs_model CHECK (model_version_no IS NULL OR model_document_id IS NOT NULL);

UPDATE tendering.rfp r
   SET model_document_id = d.id
  FROM (SELECT DISTINCT ON (scope_id) id, scope_id
          FROM documents.document
         WHERE scope_type = 'rfp' AND kind = 'bim' AND deleted_at IS NULL AND current_version > 0
         ORDER BY scope_id, id) d
 WHERE d.scope_id = r.id;
