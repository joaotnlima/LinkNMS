-- 0026 — Running the plan: baseline selector, start out of sequence, acceptance
-- on close, and the site's daily log (PRD-10 E-1, E-5..E-9).
--
-- Ownership: Planning & Execution (doc 02 #6 — progress, actuals and the
-- execution record against the plan's rows). Four additive changes:
--
--   1. planning.baseline.taken_by_person_id / taken_by_org_id — E-1: the
--      selector names who took each baseline. Written by the award, the
--      signature and the change-order paths from now on; back-filled here from
--      the baseline's own ledger entry (record.audit_event, object = baseline).
--
--   2. planning.progress_report.override_reason / waiting_on — E-5, D-48 (warn
--      and record, D-23): a task started before what it waits on carries the
--      reason given and the predecessors as they stood. Both or neither.
--
--   3. planning.progress_report.acceptance — E-6: a `done` report records the
--      task's acceptance checklist with `met` per criterion
--      ([{criterion, met}]). The criteria themselves stay the baselined text
--      planning.task.acceptance_criteria (one per line).
--
--   4. planning.daily_log_entry — E-7..E-9: the site diary, one row per thing
--      that happened on a site day (presence + headcount, weather, work against
--      a task, an issue, a photo tagged to a task and/or a location). Append-only
--      (record.forbid_mutation, like progress_report): a correction is a newer
--      entry, the day view reads the latest presence per organisation and the
--      latest weather. A photo references a documents.document version by id
--      (no cross-schema FK, as deliverable_submission); task_id references the
--      plan row; location_id is a bare ref to project.location.
--
-- progress_report is append-only by trigger: ADD COLUMN touches no row.
-- Forward-only. No GRANTs (single application pool, see 0008).

ALTER TABLE planning.baseline
  ADD COLUMN taken_by_person_id uuid,
  ADD COLUMN taken_by_org_id    uuid;

UPDATE planning.baseline b
   SET taken_by_person_id = e.actor_person_id,
       taken_by_org_id    = e.actor_org_id
  FROM record.audit_event e
 WHERE e.project_id = b.project_id
   AND e.type = 'planning.baseline.taken'
   AND e.object_type = 'baseline'
   AND e.object_id = b.id;

ALTER TABLE planning.progress_report
  ADD COLUMN override_reason text
    CHECK (override_reason IS NULL OR char_length(override_reason) BETWEEN 1 AND 500),
  ADD COLUMN waiting_on      jsonb,
  ADD COLUMN acceptance      jsonb,
  ADD CONSTRAINT progress_report_override
    CHECK ((override_reason IS NULL) = (waiting_on IS NULL)),
  ADD CONSTRAINT progress_report_acceptance_on_done
    CHECK (acceptance IS NULL OR status = 'done');

CREATE TABLE planning.daily_log_entry (
  id                    uuid PRIMARY KEY,
  project_id            uuid NOT NULL,
  log_date              date NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('presence', 'weather', 'work', 'issue', 'photo')),
  org_id                uuid,
  headcount             smallint CHECK (headcount IS NULL OR headcount BETWEEN 0 AND 999),
  weather               text CHECK (weather IS NULL OR weather IN
                          ('sunny', 'cloudy', 'rain', 'heavy_rain', 'wind', 'frost', 'snow', 'heat')),
  temperature_c         smallint CHECK (temperature_c IS NULL OR temperature_c BETWEEN -30 AND 50),
  task_id               uuid REFERENCES planning.task(id),
  location_id           uuid,
  document_id           uuid,
  version_no            int CHECK (version_no IS NULL OR version_no >= 1),
  percent               smallint CHECK (percent IS NULL OR percent BETWEEN 0 AND 100),
  note                  text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  recorded_by_person_id uuid NOT NULL,
  recorded_by_org_id    uuid NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  -- what each kind carries (the API validates the same, this is the floor)
  CONSTRAINT daily_log_presence CHECK (kind <> 'presence' OR (org_id IS NOT NULL AND headcount IS NOT NULL)),
  CONSTRAINT daily_log_weather  CHECK (kind <> 'weather'  OR weather IS NOT NULL),
  CONSTRAINT daily_log_work     CHECK (kind <> 'work'     OR task_id IS NOT NULL),
  CONSTRAINT daily_log_issue    CHECK (kind <> 'issue'    OR note IS NOT NULL),
  CONSTRAINT daily_log_photo    CHECK (kind <> 'photo'    OR (document_id IS NOT NULL AND version_no IS NOT NULL))
);

CREATE INDEX daily_log_entry_day_idx  ON planning.daily_log_entry (project_id, log_date, recorded_at);
CREATE INDEX daily_log_entry_task_idx ON planning.daily_log_entry (task_id, recorded_at DESC) WHERE task_id IS NOT NULL;

CREATE TRIGGER daily_log_entry_append_only BEFORE UPDATE OR DELETE ON planning.daily_log_entry
  FOR EACH ROW EXECUTE FUNCTION record.forbid_mutation();
