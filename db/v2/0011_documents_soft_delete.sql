-- LINA-409 — document soft-delete (BIM viewer, doc 24).
--
-- The BIM model attached to a draft RFP is a documents.document
-- (scope_type='rfp', kind='bim'). An issuer must be able to REMOVE a model it
-- attached by mistake (removeRfpModel). But documents.document_version is
-- append-only — a BEFORE UPDATE OR DELETE trigger (0001_schema.sql) forbids
-- touching the byte ledger, by design: the sha256 chain is tamper-evident and
-- must never be rewritten.
--
-- So removal is a SOFT delete on the PARENT row only: tombstone the document,
-- never the versions. The stored bytes and the `documents.version.uploaded`
-- audit event both remain intact — we record that a model existed and was
-- removed, we do not erase history.
--
-- `deleted_at` is a general primitive, not a BIM-only hack: NULL (the default,
-- and every existing row) means "live" exactly as before; a non-NULL hides the
-- document from every read path (getDocument, listDocuments, listScopeDocuments)
-- while leaving its append-only version ledger untouched.
ALTER TABLE documents.document
  ADD COLUMN deleted_at timestamptz;

-- Reads filter live rows; index the tombstone so that filter stays cheap as
-- removed documents accumulate.
CREATE INDEX document_deleted_at_idx
  ON documents.document (deleted_at)
  WHERE deleted_at IS NOT NULL;
