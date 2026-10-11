// Postgres reads for the build's questions and minutes (PRD-12 N-5..N-7; db/v2
// 0028). Spread into createCollaborationStore's object, so callers still see
// ONE store; split out to keep pg-store.mjs under the size rule. Reads
// collaboration.* only.

/** @param {import('pg').Pool} pool */
export function questionQueries(pool) {
  return {
    /** The addressee's question queue across builds (D-13; PRD-12 N-7). */
    async listMyQuestions({ orgId, status, topic = null, projectId = null, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT c.*, t.object_type, t.object_id, t.project_id
           FROM collaboration.comment c JOIN collaboration.thread t ON t.id = c.thread_id
          WHERE c.kind = 'question' AND c.addressee_org_id = $1 AND c.deleted_at IS NULL
            AND ($2::text IS NULL OR c.question_status = $2)
            AND ($3::uuid IS NULL OR c.id > $3)
            AND ($5::text IS NULL OR c.topic = $5)
            AND ($6::uuid IS NULL OR t.project_id = $6)
          ORDER BY c.created_at, c.id
          LIMIT $4`,
        [orgId, status, cursor, limit + 1, topic, projectId],
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },

    /** A build's questions the org asked or must answer; newest first, keyset (created_at, id). */
    async listProjectQuestions({ projectId, orgId, role, status, topic, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT c.*, t.object_type, t.object_id, t.project_id
           FROM collaboration.comment c JOIN collaboration.thread t ON t.id = c.thread_id
          WHERE t.project_id = $1 AND c.kind = 'question' AND c.deleted_at IS NULL
            AND (CASE $3::text WHEN 'addressed' THEN c.addressee_org_id = $2
                               WHEN 'asked' THEN c.author_org_id = $2
                               ELSE (c.addressee_org_id = $2 OR c.author_org_id = $2) END)
            AND ($4::text IS NULL OR c.question_status = $4)
            AND ($5::text IS NULL OR c.topic = $5)
            AND ($6::timestamptz IS NULL OR (c.created_at, c.id) < ($6, $7::uuid))
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT $8`,
        [projectId, orgId, role, status, topic, cursor?.key ?? null, cursor?.id ?? null, limit + 1],
      );
      return keyset(rows, limit, (r) => r.created_at);
    },

    /** Newest meeting first; drafts only for the writing org. Keyset (date, id). */
    async listMinutes({ projectId, orgId, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT * FROM collaboration.meeting_minute
          WHERE project_id = $1
            AND (status <> 'draft' OR created_by_org_id = $2)
            AND ($3::date IS NULL OR (date, id) < ($3, $4::uuid))
          ORDER BY date DESC, id DESC
          LIMIT $5`,
        [projectId, orgId, cursor?.key ?? null, cursor?.id ?? null, limit + 1],
      );
      return keyset(rows, limit, (r) => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date)));
    },

    /** Items and acks of several minutes in two reads (no N+1). */
    async minutesParts(minuteIds) {
      const out = new Map(minuteIds.map((id) => [id, { items: [], acks: [] }]));
      if (!minuteIds.length) return out;
      const [{ rows: items }, { rows: acks }] = await Promise.all([
        pool.query('SELECT * FROM collaboration.minute_item WHERE minute_id = ANY($1::uuid[]) ORDER BY id', [minuteIds]),
        pool.query('SELECT * FROM collaboration.minute_ack WHERE minute_id = ANY($1::uuid[]) ORDER BY at', [minuteIds]),
      ]);
      for (const i of items) out.get(i.minute_id).items.push(i);
      for (const a of acks) out.get(a.minute_id).acks.push(a);
      return out;
    },
  };
}

function keyset(rows, limit, keyOf) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const key = last ? keyOf(last) : null;
  return {
    items,
    nextCursor: rows.length > limit && last ? `${key instanceof Date ? key.toISOString() : key}~${last.id}` : null,
  };
}
