// Postgres part of the planning store for the Excel import (PRD-09 O-6..O-12,
// db/v2 0024). Spread into createPlanningStore's object, like the deliverable
// queries, so callers still see ONE store. The confirm's own write
// (`confirmScheduleImport`) runs on the plan transaction's client — see
// `importWriters`, merged into the plan writers.

function importN(r) {
  if (!r) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    orgId: r.org_id,
    orgName: r.org_name ?? null,
    personId: r.imported_by_person_id,
    filename: r.filename,
    fileBytes: r.file_bytes,
    sheets: r.sheets ?? [],
    sheetName: r.sheet_name,
    mapping: r.column_mapping ?? null,
    status: r.status,
    result: r.result ?? null,
    confirmedAt: r.confirmed_at?.toISOString?.() ?? r.confirmed_at ?? null,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
  };
}

/** @param {import('pg').Pool} pool */
export function scheduleImportQueries(pool) {
  return {
    async insertScheduleImport({ id, projectId, orgId, personId, filename, fileBytes, sheets, sheetName }) {
      const { rows } = await pool.query(
        `INSERT INTO planning.schedule_import
           (id, project_id, org_id, imported_by_person_id, filename, file_bytes, sheets, sheet_name, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'uploaded')
         RETURNING *`,
        [id, projectId, orgId, personId, filename, fileBytes, JSON.stringify(sheets), sheetName],
      );
      return importN(rows[0]);
    },

    async getScheduleImport(id) {
      const { rows } = await pool.query(
        `SELECT i.*, o.legal_name AS org_name
           FROM planning.schedule_import i
           LEFT JOIN identity.organization o ON o.id = i.org_id
          WHERE i.id = $1`,
        [id],
      );
      return importN(rows[0]);
    },

    /** Sheet + mapping + status, never on a confirmed import. */
    async updateScheduleImport({ id, sheetName, mapping, status }) {
      const { rows } = await pool.query(
        `UPDATE planning.schedule_import
            SET sheet_name = $2, column_mapping = $3::jsonb, status = $4
          WHERE id = $1 AND status <> 'confirmed'
          RETURNING *`,
        [id, sheetName, JSON.stringify(mapping), status],
      );
      return importN(rows[0]);
    },
  };
}

/** The confirm's write, on the plan transaction's client. */
export function importWriters(client) {
  return {
    async confirmScheduleImport({ id, result }) {
      const { rowCount } = await client.query(
        `UPDATE planning.schedule_import
            SET status = 'confirmed', confirmed_at = now(), result = $2::jsonb
          WHERE id = $1 AND status <> 'confirmed'`,
        [id, JSON.stringify(result)],
      );
      return rowCount === 1;
    },
  };
}
