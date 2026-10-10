-- 0021 — A plan row may name its directory specialty (PRD-03 R-2).
--
-- Ownership: Planning. `specialty` stays the free-text label the row shows
-- (back-compat, planning.user_specialty suggestions); `specialty_code` is the
-- optional taxonomy code (directory.specialty.code). No cross-schema FK: the
-- code is checked through the directory's published specialty port when it is
-- written (planning application), and its shape here.

ALTER TABLE planning.task
  ADD COLUMN specialty_code text
    CONSTRAINT task_specialty_code_shape CHECK (specialty_code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(specialty_code) <= 60);
