-- 0005 — collaboration deltas for phase 7 (LINA-308).
--
-- Three gaps between the 0001 tables and the phase-7 contract:
--
-- 1. `circulateMinute` is author-only (openapi x-relationship: author) but
--    collaboration.meeting_minute never recorded who wrote it. Nullable on
--    purpose: forward-only migrations must not invent authors for rows that
--    could already exist; the use case refuses to circulate an authorless row.
-- 2. CommentCreate carries `attachment_ids` (doc 08: attachments[]) but the
--    comment table had nowhere to keep them. Document ids, not bytes — the
--    documents module owns the files.
-- 3. The notifications consumer is an at-least-once outbox handler (doc 10):
--    dedupe lives in the database, one notification per person per event.
--    Partial index because digest rows aggregate many events (event_id of the
--    window's first event; later events update the row in place).

ALTER TABLE collaboration.meeting_minute
  ADD COLUMN created_by_org_id    uuid,
  ADD COLUMN created_by_person_id uuid;

ALTER TABLE collaboration.comment
  ADD COLUMN attachment_document_ids uuid[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX notification_person_event
  ON collaboration.notification (person_id, event_id)
  WHERE event_id IS NOT NULL;
