-- LINA-374 — record export privacy.
--
-- A record export (POST /projects/{id}/record:export) is a V7-REDACTED
-- projection of the ledger: it shows only what the REQUESTING org may read.
-- The artefact is persisted as a normal documents.document scoped to the
-- project (so "an export happened" is itself ledgered, transparently), but the
-- bytes must stay private to the org that produced them — otherwise a
-- lower-privilege participant could download a higher-privilege org's view and
-- read scoped content (money margins, other lanes' change orders) it is not
-- party to (gap-review S9).
--
-- `private_to_org_id` is a general primitive, not an export-only hack: a NULL
-- (the default, and every existing row) means "visible to readers of the
-- scope" exactly as before; a non-NULL narrows READ to that one org ON TOP of
-- the V6 scope check. It composes with V6, it does not replace it.
ALTER TABLE documents.document
  ADD COLUMN private_to_org_id uuid;

-- Listing a scope's documents filters private rows to their owner org; index
-- the owner so that filter is cheap.
CREATE INDEX document_private_to_org_idx
  ON documents.document (private_to_org_id)
  WHERE private_to_org_id IS NOT NULL;
