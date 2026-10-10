-- 0018 — Drawings: the markup layer and the DWG/DXF preview (PRD-06 V-1..V-17, D-49).
--
--   1. documents.markup — a layer kept on the record; the PDF / DWG bytes are
--      never changed (PRD-06 §1). One row per markup: pinned to the version it
--      was saved in and to a page (PDF) or layout (DWG/DXF). Geometry is jsonb,
--      validated in the domain (modules/documents/domain/markup.mjs) — the DB
--      only checks that it is an object. `state` and the question / issue links
--      are record-side state of the markup (closing writes no new version), so
--      the table is NOT append-only; every change is ledgered.
--      question_id / nonconformity_id reference Collaboration / Quality by id,
--      no cross-schema FK (doc 02).
--
--   2. Markups-only versions. Saving markups appends a document_version with
--      change_kind = 'markup_only' that REUSES the base version's storage_key and
--      sha256. Verified against 0001: document_version has no UNIQUE on
--      storage_key or sha256 and its append-only trigger fires on UPDATE /
--      DELETE only — an INSERT that reuses a key is allowed as-is, so no trigger
--      change is needed. The CHECK added here pins the shape of such a row.
--
--   3. documents.preview / documents.preview_layout — the server-side DWG/DXF
--      conversion (D-49) keyed by the BYTES (document_id, sha256): a markups-only
--      version shares the preview of the version it copies, and re-uploading the
--      same bytes reuses it. Layout SVGs are derived objects with their own
--      storage keys. Derived state — not ledgered.
--
--   4. document.preview_status gains its reason (V-14): preview_reason.
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).
-- Forward-only, no data rewrite.

CREATE TABLE documents.markup (
  id                   uuid PRIMARY KEY,
  document_id          uuid NOT NULL REFERENCES documents.document(id),
  project_id           uuid NOT NULL,
  version_no           int NOT NULL CHECK (version_no >= 1),
  page_or_layout       text NOT NULL CHECK (char_length(page_or_layout) BETWEEN 1 AND 200),
  kind                 text NOT NULL CHECK (kind IN ('cloud', 'arrow', 'text', 'measure', 'calibration')),
  geometry             jsonb NOT NULL CHECK (jsonb_typeof(geometry) = 'object'),
  text                 text CHECK (text IS NULL OR char_length(text) BETWEEN 1 AND 2000),
  author_person_id     uuid NOT NULL,
  author_org_id        uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  state                text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  closed_at            timestamptz,
  closed_by_person_id  uuid,
  closed_by_org_id     uuid,
  question_id          uuid,
  nonconformity_id     uuid,
  FOREIGN KEY (document_id, version_no) REFERENCES documents.document_version (document_id, version_no),
  CONSTRAINT markup_closed_stamp CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX markup_document_idx ON documents.markup (document_id, version_no);

ALTER TABLE documents.document_version
  ADD CONSTRAINT document_version_markup_only_base
    CHECK (change_kind <> 'markup_only' OR base_version_no IS NOT NULL);

ALTER TABLE documents.document
  ADD COLUMN preview_reason text CHECK (preview_reason IS NULL OR char_length(preview_reason) BETWEEN 1 AND 200);

CREATE TABLE documents.preview (
  document_id   uuid NOT NULL REFERENCES documents.document(id),
  sha256        text NOT NULL CHECK (char_length(sha256) = 64),
  status        text NOT NULL CHECK (status IN ('ready', 'unavailable')),
  reason        text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  converter     text NOT NULL,
  layers        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(layers) = 'array'),
  warnings      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
  converted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, sha256),
  CONSTRAINT preview_reason_when_unavailable CHECK ((status = 'unavailable') = (reason IS NOT NULL))
);

CREATE TABLE documents.preview_layout (
  document_id   uuid NOT NULL,
  sha256        text NOT NULL,
  layout_index  int NOT NULL CHECK (layout_index >= 0),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  storage_key   text NOT NULL,
  mime          text NOT NULL DEFAULT 'image/svg+xml',
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256_svg    text NOT NULL CHECK (char_length(sha256_svg) = 64),
  width         double precision,
  height        double precision,
  PRIMARY KEY (document_id, sha256, layout_index),
  FOREIGN KEY (document_id, sha256) REFERENCES documents.preview (document_id, sha256)
);
