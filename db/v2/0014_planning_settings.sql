-- 0014 — Per-project planning settings (PRD-02 §5, T-5/T-13).
--
-- The award-by date of a tender is the planned start of the tendered rows
-- minus a MOBILISATION LEAD: the working days a winning bidder needs between
-- the award and starting on site. Planning owns the calendar and the critical
-- path, so planning owns this setting and computes the date
-- (getTenderWindow); tendering owns only the bids-due date.
--
-- One row per project, created on first write; an absent row means the
-- defaults (5 working days — an assumption to validate with owners and GCs,
-- PRD-02 §7.2). project_id is a bare uuid (no cross-schema FK, D-03), as
-- planning.task.project_id is.
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).
-- Forward-only.

CREATE TABLE planning.project_setting (
  project_id           uuid PRIMARY KEY,
  mobilisation_lead_wd smallint NOT NULL DEFAULT 5
                       CHECK (mobilisation_lead_wd BETWEEN 0 AND 60),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_person_id uuid
);
