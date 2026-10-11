-- 0029 — Share links that can be audited and revoked (PRD-12 N-12, flow D21;
-- gap S1 bullet 4 in to-be/21).
--
-- Ownership: Project (share links are the project's, doc 02). Three changes:
--
--   1. project.share_link.created_at, revoked_by_person_id — the owner's list
--      shows when each link was made and who closed it.
--
--   2. The scope is frozen: a trigger refuses any UPDATE of a share link except
--      setting revoked_at / revoked_by_person_id once (gap S1: "nothing
--      prevents scope widening after creation"). No DELETE.
--
--   3. project.share_link_access — every access the public surface served
--      (view of the list, download of one document), append-only
--      (record.forbid_mutation). The address and user agent are kept HERE, for
--      the owner, and never in the ledger's hash chain; the ledger entry
--      project.share_link.accessed carries link, action and document only.
--      document_id is a bare ref to documents.document (no cross-schema FK).
--
-- Forward-only. No GRANTs (single application pool, see 0008).

ALTER TABLE project.share_link
  ADD COLUMN created_at           timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revoked_by_person_id uuid,
  ADD CONSTRAINT share_link_revoked_by CHECK (revoked_by_person_id IS NULL OR revoked_at IS NOT NULL);

CREATE INDEX share_link_project_idx ON project.share_link (project_id, created_at DESC);

CREATE OR REPLACE FUNCTION project.share_link_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project.share_link is never deleted — revoke it';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id
     OR NEW.audience IS DISTINCT FROM OLD.audience
     OR NEW.document_ids IS DISTINCT FROM OLD.document_ids
     OR NEW.task_ids IS DISTINCT FROM OLD.task_ids
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a share link''s scope is frozen at creation — only revocation changes it';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER share_link_frozen BEFORE UPDATE OR DELETE ON project.share_link
  FOR EACH ROW EXECUTE FUNCTION project.share_link_frozen();

CREATE TABLE project.share_link_access (
  id            uuid PRIMARY KEY,
  share_link_id uuid NOT NULL REFERENCES project.share_link(id),
  project_id    uuid NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  action        text NOT NULL CHECK (action IN ('view', 'download')),
  document_id   uuid,
  ip            text CHECK (ip IS NULL OR char_length(ip) <= 64),
  user_agent    text CHECK (user_agent IS NULL OR char_length(user_agent) <= 300),
  CHECK ((action = 'download') = (document_id IS NOT NULL))
);

CREATE INDEX share_link_access_link_idx ON project.share_link_access (share_link_id, at DESC);

CREATE TRIGGER share_link_access_append_only BEFORE UPDATE OR DELETE ON project.share_link_access
  FOR EACH ROW EXECUTE FUNCTION record.forbid_mutation();
