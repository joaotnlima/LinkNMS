-- 0031 — The model upload check, server-side (PRD-07 M-18; audit S4c).
--
-- Ownership: Documents. When a new .ifc of the build's model completes, the
-- server compares its element GlobalIds with the record (live links and issue
-- pins: "orphaned" ones are listed for relinking, never dropped) and with the
-- previous upload ("GlobalIds regenerated" when the two files share almost no
-- element). The GlobalIds are EXTRACTED BY THE CLIENT from the file it uploads
-- and sent with the reservation: parsing the IFC server-side would mean
-- downloading up to 100 MB from R2 on every upload. The server validates the
-- list (GlobalId shape, size), keeps it per version, and owns the comparison.
--
--   documents.model_upload — one row per uploaded model version:
--     global_ids             the declared element GlobalIds (deduplicated)
--     unmatched_global_ids,  filled at completion: recorded elements missing
--     regenerated,           from this file; the regenerated flag; elements
--     shared_count,          shared with the previous upload; elements on the
--     recorded_count,        record at completion
--     checked_at
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).

CREATE TABLE documents.model_upload (
  document_id          uuid NOT NULL,
  version_no           int NOT NULL,
  global_ids           text[] NOT NULL,
  unmatched_global_ids text[],
  regenerated          boolean,
  shared_count         int,
  recorded_count       int,
  checked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version_no),
  FOREIGN KEY (document_id, version_no) REFERENCES documents.document_version (document_id, version_no),
  CONSTRAINT model_upload_checked CHECK ((checked_at IS NULL) = (regenerated IS NULL))
);
