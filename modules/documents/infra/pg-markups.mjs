// Postgres part of the documents store for the markup layer (PRD-06). Spread
// into createDocumentsStore's object, like pg-links.mjs.
//
// documents.markup is this module's own table. Who may save, close or link is
// decided in the application layer before these run; every write here commits
// with its ledger entry in ONE transaction (invariant §6.4). A save appends the
// markups-only document_version (same storage key + sha256 as its base — an
// INSERT the append-only trigger of 0001 allows) and advances current_version.
import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { markupOnlyVersion } from '../domain/markup.mjs';

export function markupQueries(pool, tx) {
  return {
    async getMarkup(markupId) {
      const { rows } = await pool.query('SELECT * FROM documents.markup WHERE id = $1', [markupId]);
      return rows[0] ?? null;
    },

    async getMarkupsByIds(ids) {
      if (!ids.length) return [];
      const { rows } = await pool.query('SELECT * FROM documents.markup WHERE id = ANY($1::uuid[])', [ids]);
      return rows;
    },

    /** Every markup of a document, by version then creation; keyset on (version_no, created_at, id). */
    async listMarkups({ documentId, cursor = null, limit }) {
      const params = [documentId, limit + 1];
      let after = '';
      if (cursor) {
        params.push(cursor);
        after = `AND (m.version_no, m.created_at, m.id) >
                     (SELECT c.version_no, c.created_at, c.id FROM documents.markup c WHERE c.id = $3)`;
      }
      const { rows } = await pool.query(
        `SELECT m.* FROM documents.markup m
          WHERE m.document_id = $1 ${after}
          ORDER BY m.version_no, m.created_at, m.id LIMIT $2`,
        params,
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },

    /**
     * Append the markups-only version n+1 over base n, then the markups on it.
     * Returns {conflict: current} when n is no longer current (someone uploaded
     * since), else {doc, markups}.
     */
    async saveMarkups({ documentId, baseVersionNo, drafts, note, actor }) {
      return tx(async (client) => {
        const { rows: [doc] } = await client.query(
          'SELECT * FROM documents.document WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [documentId],
        );
        if (!doc) return null;
        if (doc.current_version !== baseVersionNo) return { conflict: doc.current_version };
        const { rows: [base] } = await client.query(
          'SELECT * FROM documents.document_version WHERE document_id = $1 AND version_no = $2', [documentId, baseVersionNo],
        );
        if (!base) return null;
        // Reserved-but-unproven uploads above `current` keep their numbers: the
        // markups-only version takes the next FREE number, like addVersion.
        const { rows: [{ next }] } = await client.query(
          'SELECT coalesce(max(version_no), 0) + 1 AS next FROM documents.document_version WHERE document_id = $1',
          [documentId],
        );
        const v = markupOnlyVersion(base, { note });
        await client.query(
          `INSERT INTO documents.document_version
             (document_id, version_no, storage_key, mime, size_bytes, sha256, uploaded_by_person_id, uploaded_by_org_id,
              note, base_version_no, change_kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [documentId, next, v.storageKey, v.mime, v.sizeBytes, v.sha256, actor.personId, actor.orgId,
            v.note, v.baseVersionNo, v.changeKind],
        );
        const { rows: [updated] } = await client.query(
          'UPDATE documents.document SET current_version = $2 WHERE id = $1 RETURNING *', [documentId, next],
        );
        const markups = [];
        for (const d of drafts) {
          const { rows } = await client.query(
            `INSERT INTO documents.markup
               (id, document_id, project_id, version_no, page_or_layout, kind, geometry, text, author_person_id, author_org_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [d.id, documentId, doc.project_id, next, d.pageOrLayout, d.kind, JSON.stringify(d.geometry), d.text,
              actor.personId, actor.orgId],
          );
          markups.push(rows[0]);
        }
        await appendAuditEvent(client, {
          projectId: doc.project_id,
          actor,
          category: 'documents',
          type: 'documents.markups.saved',
          scope: { type: 'project', id: doc.project_id },
          object: { type: 'document', id: documentId },
          payload: {
            document_id: documentId,
            version_no: next,
            base_version_no: baseVersionNo,
            // The bytes are provably the base version's: same sha256.
            sha256: v.sha256,
            markup_ids: markups.map((m) => m.id),
          },
          channel: actor.channel,
        });
        return { doc: updated, markups };
      });
    },

    /** open ↔ closed, ledgered. Null when the markup vanished. */
    async setMarkupState({ markupId, to, actor }) {
      return tx(async (client) => {
        const closing = to === 'closed';
        const { rows: [row] } = await client.query(
          `UPDATE documents.markup
              SET state = $2,
                  closed_at = CASE WHEN $3 THEN now() ELSE NULL END,
                  closed_by_person_id = CASE WHEN $3 THEN $4::uuid ELSE NULL END,
                  closed_by_org_id = CASE WHEN $3 THEN $5::uuid ELSE NULL END
            WHERE id = $1 RETURNING *`,
          [markupId, to, closing, actor.personId, actor.orgId],
        );
        if (!row) return null;
        await appendAuditEvent(client, {
          projectId: row.project_id,
          actor,
          category: 'documents',
          type: closing ? 'documents.markup.closed' : 'documents.markup.reopened',
          scope: { type: 'project', id: row.project_id },
          object: { type: 'markup', id: markupId },
          payload: { document_id: row.document_id, version_no: row.version_no, markup_id: markupId },
          channel: actor.channel,
        });
        return row;
      });
    },

    /** Point a markup at its question or issue, ledgered. */
    async linkMarkup({ markupId, link, actor }) {
      return tx(async (client) => {
        const column = link.questionId ? 'question_id' : 'nonconformity_id';
        const target = link.questionId ?? link.nonconformityId;
        const { rows: [row] } = await client.query(
          `UPDATE documents.markup SET ${column} = $2 WHERE id = $1 RETURNING *`, [markupId, target],
        );
        if (!row) return null;
        await appendAuditEvent(client, {
          projectId: row.project_id,
          actor,
          category: 'documents',
          type: 'documents.markup.linked',
          scope: { type: 'project', id: row.project_id },
          object: { type: 'markup', id: markupId },
          payload: { document_id: row.document_id, markup_id: markupId, [column]: target },
          channel: actor.channel,
        });
        return row;
      });
    },
  };
}
