-- 0020 — The build's point (PRD-03 R-3).
--
-- Ownership: Project. "Companies near this build" needs a point; the
-- municipality (still required) is the fallback when the owner gives none.
-- Both coordinates or neither, WGS84 degrees. The Directory never reads this
-- table: it asks the project module's build port (application/build-port.mjs),
-- which applies the same participant + staffing rule as getProject.
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).

ALTER TABLE project.project
  ADD COLUMN location_lat numeric(8,5),
  ADD COLUMN location_lng numeric(8,5),
  ADD CONSTRAINT project_location_pair
    CHECK ((location_lat IS NULL) = (location_lng IS NULL)),
  ADD CONSTRAINT project_location_range
    CHECK (location_lat IS NULL OR (location_lat BETWEEN -90 AND 90 AND location_lng BETWEEN -180 AND 180));
