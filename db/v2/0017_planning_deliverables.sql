-- 0017 — Deliverables of a task and their review (PRD-05 F-2, F-12..F-16, D-48).
--
-- Ownership: Planning. A deliverable is the task's ACCEPTANCE artefact — what
-- the task must hand over before it may be marked done (D-48 is a planning
-- invariant on the task's status, enforced by reportProgress on data planning
-- owns). The file itself stays a documents.document: a submission references
-- (document_id, version_no) by id — no cross-schema FK — and SNAPSHOTS the
-- version's sha256, title and mime, so an approval is bound to those bytes.
--
--   planning.deliverable             — what a task must hand over; seeded from
--                                      a design award (source_rfp_id, D-39) or
--                                      added by the client side of the task.
--   planning.deliverable_submission  — one file version submitted against a
--                                      deliverable. Append-only; the decision
--                                      (approved | changes_requested, by person
--                                      + org, at, comment) is written ONCE, and
--                                      a pending submission may only be
--                                      superseded by a newer one (trigger).
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).

CREATE TABLE planning.deliverable (
  id                   uuid PRIMARY KEY,
  project_id           uuid NOT NULL,
  task_id              uuid NOT NULL REFERENCES planning.task(id),
  title                text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  required             boolean NOT NULL DEFAULT true,
  due                  date,
  source_rfp_id        uuid,
  position             int NOT NULL DEFAULT 0,
  created_by_org_id    uuid,
  created_by_person_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

CREATE INDEX deliverable_task_idx ON planning.deliverable (task_id) WHERE deleted_at IS NULL;
CREATE INDEX deliverable_project_idx ON planning.deliverable (project_id) WHERE deleted_at IS NULL;
-- A design award seeds each deliverable once (replays of the award absorbed).
CREATE UNIQUE INDEX deliverable_seed_uq ON planning.deliverable (task_id, source_rfp_id, title)
  WHERE source_rfp_id IS NOT NULL;

CREATE TABLE planning.deliverable_submission (
  id                     uuid PRIMARY KEY,
  deliverable_id         uuid NOT NULL REFERENCES planning.deliverable(id),
  seq                    int NOT NULL,
  document_id            uuid NOT NULL,
  version_no             int NOT NULL CHECK (version_no >= 1),
  sha256                 text NOT NULL CHECK (char_length(sha256) = 64),
  file_title             text NOT NULL,
  mime                   text NOT NULL,
  note                   text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  submitted_by_person_id uuid NOT NULL,
  submitted_by_org_id    uuid NOT NULL,
  submitted_at           timestamptz NOT NULL DEFAULT now(),
  status                 text NOT NULL DEFAULT 'submitted'
                           CHECK (status IN ('submitted', 'approved', 'changes_requested', 'superseded')),
  decided_by_person_id   uuid,
  decided_by_org_id      uuid,
  decided_at             timestamptz,
  decision_comment       text CHECK (decision_comment IS NULL OR char_length(decision_comment) BETWEEN 1 AND 2000),
  UNIQUE (deliverable_id, seq),
  -- decided ⇔ approved / changes_requested; nobody decides its own submission.
  CONSTRAINT deliverable_submission_decided
    CHECK ((status IN ('approved', 'changes_requested')) = (decided_by_org_id IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT deliverable_submission_two_sided
    CHECK (decided_by_org_id IS NULL OR decided_by_org_id <> submitted_by_org_id)
);

CREATE INDEX deliverable_submission_document_idx ON planning.deliverable_submission (document_id);

-- Append-only with a write-once decision: no DELETE; only a `submitted` row
-- changes, only its status/decision columns, and only once.
CREATE OR REPLACE FUNCTION planning.deliverable_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'planning.deliverable_submission is append-only';
  END IF;
  IF OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'a decided or superseded deliverable submission never changes';
  END IF;
  IF (NEW.id, NEW.deliverable_id, NEW.seq, NEW.document_id, NEW.version_no, NEW.sha256, NEW.file_title, NEW.mime,
      NEW.note, NEW.submitted_by_person_id, NEW.submitted_by_org_id, NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.id, OLD.deliverable_id, OLD.seq, OLD.document_id, OLD.version_no, OLD.sha256, OLD.file_title, OLD.mime,
      OLD.note, OLD.submitted_by_person_id, OLD.submitted_by_org_id, OLD.submitted_at) THEN
    RAISE EXCEPTION 'only the decision of a deliverable submission is written';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER deliverable_submission_write_once BEFORE UPDATE OR DELETE ON planning.deliverable_submission
  FOR EACH ROW EXECUTE FUNCTION planning.deliverable_submission_guard();
