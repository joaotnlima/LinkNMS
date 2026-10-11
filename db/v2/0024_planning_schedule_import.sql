-- 0024 — Excel plan import, server-side (PRD-09 O-6..O-12).
--
-- Ownership: Planning. 0001 drew `planning.schedule_import` (status machine,
-- sheet name, column mapping) but nowhere to keep what was read. The workbook
-- is parsed ONCE at upload (infra exceljs) into each sheet's cell text, kept
-- here so `:map` and `:preview` re-run the pure parser without the bytes: the
-- file itself is never stored. Bounded by the parser (≤ 5 000 rows × 40
-- columns per sheet, 10 MB upload).
--
--   org_id       the importing organisation — only it reads or drives the import
--   sheets       [{name, rows: text[][]}] — cell text as read, header row included
--   file_bytes   the uploaded size, for the record
--   result       the confirm's counts (actions, sub_actions, links, warnings)
--   confirmed_at set once, with status = confirmed
--
-- The rows themselves are written through the plan's structural batch in the
-- confirm transaction, with the ledger entry and the outbox event
-- `planning.plan.imported` (doc 10). No GRANTs (single application pool, see
-- 0008_project_phases_signoff.sql).

ALTER TABLE planning.schedule_import
  ADD COLUMN org_id       uuid,
  ADD COLUMN sheets       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN file_bytes   integer CHECK (file_bytes IS NULL OR file_bytes >= 0),
  ADD COLUMN result       jsonb,
  ADD COLUMN confirmed_at timestamptz,
  ADD CONSTRAINT schedule_import_confirmed
    CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL));

CREATE INDEX schedule_import_project ON planning.schedule_import (project_id, created_at DESC);
