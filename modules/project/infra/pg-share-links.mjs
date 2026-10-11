// Postgres part of the project store for share links (PRD-12 N-12, db/v2
// 0029) and the location facts other modules read through the build port
// (PRD-12 N-3/N-4). Spread into createProjectStore's object, so callers still
// see ONE store; split out to keep pg-store.mjs from growing further.
//
// Every write here appends its ledger entry on the SAME client (invariant
// §6.4). The access log keeps address and user agent; the ledger entry never
// does (they would be frozen into the hash chain).
import { appendAuditEvent } from '../../../platform/ledger.mjs';

/**
 * @param {import('pg').Pool} pool
 * @param {(fn: (client: object) => Promise<any>) => Promise<any>} tx
 */
export function shareLinkQueries(pool, tx) {
  const WITH_USE = `
    SELECT l.*,
           (SELECT count(*)::int FROM project.share_link_access a WHERE a.share_link_id = l.id) AS access_count,
           (SELECT max(a.at) FROM project.share_link_access a WHERE a.share_link_id = l.id) AS last_accessed_at
      FROM project.share_link l`;

  return {
    async getShareLink(shareLinkId) {
      const { rows } = await pool.query(`${WITH_USE} WHERE l.id = $1`, [shareLinkId]);
      return rows[0] ?? null;
    },

    async getShareLinkByTokenHash(tokenHash) {
      const { rows } = await pool.query('SELECT * FROM project.share_link WHERE token_hash = $1', [tokenHash]);
      return rows[0] ?? null;
    },

    /** Newest first; keyset (created_at, id). */
    async listShareLinks({ projectId, cursor, limit }) {
      const { rows } = await pool.query(
        `${WITH_USE}
          WHERE l.project_id = $1
            AND ($2::timestamptz IS NULL OR (l.created_at, l.id) < ($2, $3::uuid))
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT $4`,
        [projectId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
      );
      return page(rows, limit, (r) => r.created_at);
    },

    /** Set revoked_at once; null when it was already revoked (a racer won). */
    async revokeShareLink({ shareLinkId, projectId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE project.share_link SET revoked_at = now(), revoked_by_person_id = $2
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING *`,
          [shareLinkId, actor.personId],
        );
        if (!rows.length) return null;
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: 'project.share_link.revoked',
          scope: { type: 'project', id: projectId },
          object: { type: 'share_link', id: shareLinkId },
          payload: { audience: rows[0].audience },
          channel: actor.channel,
        });
        const { rows: [withUse] } = await client.query(`${WITH_USE} WHERE l.id = $1`, [shareLinkId]);
        return withUse;
      });
    },

    /** One served access: the log row + its ledger entry, one transaction. */
    async recordShareLinkAccess({ id, link, action, documentId, ip, userAgent }) {
      return tx(async (client) => {
        await client.query(
          `INSERT INTO project.share_link_access (id, share_link_id, project_id, action, document_id, ip, user_agent)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, link.id, link.project_id, action, documentId, ip ?? null, userAgent ?? null],
        );
        await appendAuditEvent(client, {
          projectId: link.project_id,
          // No account behind a share link: the entry names the link, not a person.
          actor: {},
          category: 'project',
          type: 'project.share_link.accessed',
          scope: { type: 'project', id: link.project_id },
          object: { type: 'share_link', id: link.id },
          payload: { share_link_id: link.id, action, ...(documentId ? { document_id: documentId } : {}) },
          channel: 'api',
        });
      });
    },

    /** Newest first; keyset (at, id). */
    async listShareLinkAccesses({ shareLinkId, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT * FROM project.share_link_access
          WHERE share_link_id = $1
            AND ($2::timestamptz IS NULL OR (at, id) < ($2, $3::uuid))
          ORDER BY at DESC, id DESC
          LIMIT $4`,
        [shareLinkId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
      );
      return page(rows, limit, (r) => r.at);
    },

    /** Which of `locationIds` are locations of this build (build port, PRD-12 N-3/N-4). */
    /** Every location of the build by id → name (the build port's locationNamesOf). */
    async locationNames(projectId) {
      const { rows } = await pool.query('SELECT id, name FROM project.location WHERE project_id = $1', [projectId]);
      return rows;
    },

    async knownLocationIds(projectId, locationIds) {
      if (!locationIds.length) return new Set();
      const { rows } = await pool.query(
        'SELECT id FROM project.location WHERE project_id = $1 AND id = ANY($2::uuid[])',
        [projectId, locationIds],
      );
      return new Set(rows.map((r) => r.id));
    },
  };
}

function page(rows, limit, atOf) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const at = last ? atOf(last) : null;
  return {
    items,
    nextCursor: rows.length > limit && last ? `${at instanceof Date ? at.toISOString() : at}~${last.id}` : null,
  };
}
