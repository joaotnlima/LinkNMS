// Postgres reads for the build's quality page (PRD-12 N-3, N-4; db/v2 0027).
// Spread into createQualityStore's object, so callers still see ONE store;
// split out to keep pg-store.mjs under the size rule. Reads quality.* only.

/** @param {import('pg').Pool} pool */
export function qualityListQueries(pool) {
  return {
    /** Newest raised first; keyset (raised_at, id). `active` = not closed. */
    async listNonConformities({ projectId, status, kind, taskId, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT * FROM quality.nonconformity
          WHERE project_id = $1
            AND (CASE $2::text WHEN 'all' THEN true
                               WHEN 'active' THEN status <> 'closed'
                               ELSE status = $2 END)
            AND ($3::text IS NULL OR kind = $3)
            AND ($4::uuid IS NULL OR task_id = $4)
            AND ($5::timestamptz IS NULL OR (raised_at, id) < ($5, $6::uuid))
          ORDER BY raised_at DESC, id DESC
          LIMIT $7`,
        [projectId, status, kind, taskId, cursor?.key ?? null, cursor?.id ?? null, limit + 1],
      );
      return page(rows, limit, (r) => (r.raised_at instanceof Date ? r.raised_at.toISOString() : r.raised_at));
    },

    /** Newest inspection date first; keyset (date, id). */
    async listInspections({ projectId, taskId, locationId, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT * FROM quality.inspection
          WHERE project_id = $1
            AND ($2::uuid IS NULL OR $2 = ANY(task_ids))
            AND ($3::uuid IS NULL OR $3 = ANY(location_ids))
            AND ($4::date IS NULL OR (date, id) < ($4, $5::uuid))
          ORDER BY date DESC, id DESC
          LIMIT $6`,
        [projectId, taskId, locationId, cursor?.key ?? null, cursor?.id ?? null, limit + 1],
      );
      return page(rows, limit, (r) => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date)));
    },
  };
}

function page(rows, limit, keyOf) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? `${keyOf(last)}~${last.id}` : null };
}
