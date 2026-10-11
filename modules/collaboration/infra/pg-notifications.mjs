// Postgres part of the collaboration store for the notification centre
// (PRD-12 N-1, N-2; doc 08). Spread into createCollaborationStore's object, so
// callers still see ONE store; split out to keep pg-store.mjs under the size
// rule. Only collaboration.* is touched — the consumer already resolved WHO
// through the owning modules' audience ports. No ledger: notifications are
// housekeeping, not the build record.
import { randomUUID } from 'node:crypto';

/**
 * @param {import('pg').Pool} pool
 * @param {(fn: (client: object) => Promise<any>) => Promise<any>} tx
 */
export function notificationQueries(pool, tx) {
  return {
    // ── notifications ──────────────────────────────────────────────────────
    /** Newest first; composite keyset (created_at, id) — ids are random. */
    async listNotifications({ personId, unread, category = null, cursor, limit }) {
      const [cursorAt, cursorId] = cursor ? cursor.split('~') : [null, null];
      const { rows } = await pool.query(
        `SELECT * FROM collaboration.notification
          WHERE person_id = $1
            AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid))
            AND ($6::text IS NULL OR category = $6)
          ORDER BY created_at DESC, id DESC
          LIMIT $5`,
        [personId, unread, cursorAt, cursorId ?? null, limit + 1, category],
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: rows.length > limit ? `${last.created_at.toISOString()}~${last.id}` : null,
      };
    },

    /**
     * "What's waiting for you" (PRD-09 O-2): per category, the unread count and
     * the newest unread row — one statement, optionally about one build.
     */
    async notificationSummary({ personId, projectId = null }) {
      const { rows } = await pool.query(
        `WITH unread AS (
           SELECT * FROM collaboration.notification
            WHERE person_id = $1 AND read_at IS NULL
              AND ($2::text IS NULL OR object_ref->>'project_id' = $2)
         )
         SELECT DISTINCT ON (u.category) u.*, c.n AS unread_count
           FROM unread u
           JOIN (SELECT category, count(*)::int AS n FROM unread GROUP BY category) c USING (category)
          ORDER BY u.category, u.created_at DESC, u.id DESC`,
        [personId, projectId],
      );
      return rows;
    },

    /** The bell: every unread row of the person, whatever the page/filter. */
    async countUnread(personId) {
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM collaboration.notification WHERE person_id = $1 AND read_at IS NULL',
        [personId],
      );
      return rows[0].n;
    },

    async markNotificationsRead({ personId, ids, all }) {
      if (all) {
        await pool.query(
          'UPDATE collaboration.notification SET read_at = now() WHERE person_id = $1 AND read_at IS NULL',
          [personId],
        );
        return;
      }
      await pool.query(
        `UPDATE collaboration.notification SET read_at = now()
          WHERE person_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
        [personId, ids],
      );
    },

    async listPreferences(personId) {
      const { rows } = await pool.query(
        'SELECT category, channel, enabled FROM collaboration.notification_preference WHERE person_id = $1 ORDER BY category, channel',
        [personId],
      );
      return rows;
    },

    async putPreferences({ personId, items }) {
      return tx(async (client) => {
        for (const p of items) {
          await client.query(
            `INSERT INTO collaboration.notification_preference (person_id, category, channel, enabled)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (person_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled`,
            [personId, p.category, p.channel, p.enabled],
          );
        }
        const { rows } = await client.query(
          'SELECT category, channel, enabled FROM collaboration.notification_preference WHERE person_id = $1 ORDER BY category, channel',
          [personId],
        );
        return rows;
      });
    },

    /** Of these people, who switched the category's e-mail off (default on). */
    async emailDisabled(personIds, category) {
      if (!personIds.length) return [];
      const { rows } = await pool.query(
        `SELECT person_id FROM collaboration.notification_preference
          WHERE person_id = ANY($1::uuid[]) AND category = $2 AND channel = 'email' AND enabled = false`,
        [personIds, category],
      );
      return rows.map((r) => r.person_id);
    },

    /**
     * Consumer write: one notification per person for one event. The 0005
     * partial unique index (person_id, event_id) absorbs at-least-once
     * delivery; a person who disabled the category's in_app channel is
     * skipped (default is enabled — doc 08). Returns the person ids a row
     * was CREATED for (a replay returns none — so nothing is mailed twice).
     */
    async notifyPersons({ personIds, category, title, objectRef, eventId }) {
      const created = [];
      for (const personId of [...new Set(personIds)]) {
        const { rows } = await pool.query(
          `INSERT INTO collaboration.notification (id, person_id, event_id, category, title, object_ref)
           SELECT $1, $2, $3, $4, $5, $6::jsonb
            WHERE NOT EXISTS (
              SELECT 1 FROM collaboration.notification_preference np
               WHERE np.person_id = $2 AND np.category = $4 AND np.channel = 'in_app' AND np.enabled = false)
           ON CONFLICT (person_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
           RETURNING person_id`,
          [randomUUID(), personId, eventId, category, title, JSON.stringify(objectRef)],
        );
        if (rows.length) created.push(personId);
      }
      return created;
    },

    /**
     * The 15-minute variation digest (doc 10): one UNREAD `variations` row
     * per person per project per window. The first event of a window creates
     * the row (its event_id becomes the dedupe key); every further event
     * inside the window updates count + title in place. `event_ids` in
     * object_ref absorbs replays of already-folded events. Returns the person
     * ids a NEW row was created for (only those are e-mailed).
     */
    async digestVariation({ personIds, projectId, eventId, objectRef = null, windowMinutes = 15 }) {
      const created = [];
      const base = objectRef ?? { type: 'project', id: projectId };
      for (const personId of [...new Set(personIds)]) {
        await tx(async (client) => {
          const { rows: open } = await client.query(
            `SELECT id, object_ref FROM collaboration.notification
              WHERE person_id = $1 AND category = 'variations' AND read_at IS NULL
                AND object_ref->>'id' = $2::text
                AND created_at > now() - make_interval(mins => $3)
              ORDER BY created_at DESC LIMIT 1
              FOR UPDATE`,
            [personId, projectId, windowMinutes],
          );
          if (open.length) {
            const ref = open[0].object_ref;
            const seen = ref.event_ids ?? [];
            if (seen.includes(eventId)) return; // replay of a folded event
            const count = (ref.count ?? 1) + 1;
            await client.query(
              `UPDATE collaboration.notification
                  SET title = $2, object_ref = $3::jsonb
                WHERE id = $1`,
              [open[0].id,
                `${count} variations recorded on this build`,
                JSON.stringify({ ...ref, count, event_ids: [...seen, eventId] })],
            );
            return;
          }
          const { rows } = await client.query(
            `INSERT INTO collaboration.notification (id, person_id, event_id, category, title, object_ref)
             SELECT $1, $2, $3, 'variations', $4, $5::jsonb
              WHERE NOT EXISTS (
                SELECT 1 FROM collaboration.notification_preference np
                 WHERE np.person_id = $2 AND np.category = 'variations' AND np.channel = 'in_app' AND np.enabled = false)
             ON CONFLICT (person_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
             RETURNING person_id`,
            [randomUUID(), personId, eventId,
              'A variation was recorded on this build',
              JSON.stringify({ ...base, id: projectId, count: 1, event_ids: [eventId] })],
          );
          if (rows.length) created.push(personId);
        });
      }
      return created;
    },
  };
}
