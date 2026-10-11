// Postgres part of the documents store for the shared project model (PRD-07,
// D-45). Spread into createDocumentsStore's object, like pg-markups.mjs.
//
// documents.element_link / element_pin are this module's own tables. Who may
// edit what (M-8) is decided in the application layer; the MERGE of a draft
// (M-14) runs here under the document's row lock, through the pure `decide`
// callback the application passes, so two saves never interleave between the
// read of the record and the write of the new version. Each save appends one
// document_version re-pointing the current bytes (no byte copy), writes the
// record rows, then ledger + outbox — one transaction (invariant §6.4).
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';

export function modelQueries(pool, tx) {
  async function stateOn(q, documentId) {
    const [{ rows: links }, { rows: pins }] = await Promise.all([
      q.query('SELECT * FROM documents.element_link WHERE document_id = $1 ORDER BY added_in_version, created_at, id', [documentId]),
      q.query('SELECT * FROM documents.element_pin WHERE document_id = $1 ORDER BY version_no, created_at, id', [documentId]),
    ]);
    return { links, pins };
  }

  /** Append version `next` over `source` bytes, write the record rows, ledger + outbox. */
  async function appendRecordVersion(client, { doc, source, changeKind, baseVersionNo, note, apply, actor, authorOrgId }) {
    const { rows: [{ next }] } = await client.query(
      'SELECT coalesce(max(version_no), 0) + 1 AS next FROM documents.document_version WHERE document_id = $1', [doc.id],
    );
    await client.query(
      `INSERT INTO documents.document_version
         (document_id, version_no, storage_key, mime, size_bytes, sha256, uploaded_by_person_id, uploaded_by_org_id,
          note, base_version_no, change_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [doc.id, next, source.storage_key, source.mime, source.size_bytes, source.sha256, actor.personId, actor.orgId,
        note, baseVersionNo, changeKind],
    );
    const { rows: [updated] } = await client.query(
      'UPDATE documents.document SET current_version = $2 WHERE id = $1 RETURNING *', [doc.id, next],
    );
    const taskIds = new Set();
    for (const l of apply.links) {
      await client.query(
        `INSERT INTO documents.element_link
           (id, project_id, document_id, global_id, task_id, added_in_version, created_by_person_id, created_by_org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), doc.project_id, doc.id, l.globalId, l.taskId, next, actor.personId, actor.orgId],
      );
      taskIds.add(l.taskId);
    }
    for (const u of apply.unlinks) {
      const { rows } = await client.query(
        `UPDATE documents.element_link
            SET removed_in_version = $2, removed_by_person_id = $3, removed_by_org_id = $4, removed_at = now()
          WHERE id = $1 AND removed_in_version IS NULL RETURNING task_id`,
        [u.id, next, actor.personId, actor.orgId],
      );
      if (rows[0]) taskIds.add(rows[0].task_id);
    }
    for (const p of apply.pins) {
      await client.query(
        `INSERT INTO documents.element_pin
           (id, project_id, document_id, version_no, global_ids, task_ids, text, author_person_id, author_org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.id, doc.project_id, doc.id, next, p.globalIds, p.taskIds, p.text, actor.personId, actor.orgId],
      );
      for (const t of p.taskIds) taskIds.add(t);
    }
    for (const pinId of apply.closes) {
      await client.query(
        `UPDATE documents.element_pin SET state = 'closed', closed_in_version = $2, closed_by_org_id = $3, closed_at = now()
          WHERE id = $1 AND state = 'open'`,
        [pinId, next, actor.orgId],
      );
    }
    const changes = apply.links.length + apply.unlinks.length + apply.pins.length + apply.closes.length;
    const data = {
      document_id: doc.id,
      version_no: next,
      base_version_no: baseVersionNo,
      change_kind: changeKind,
      note,
      sha256: source.sha256,
      author_org_id: authorOrgId,
      edited_by_author: authorOrgId === actor.orgId,
      change_count: changes,
      links_added: apply.links.length,
      links_removed: apply.unlinks.length,
      pins_added: apply.pins.map((p) => p.id),
      pins_closed: apply.closes,
      // The tasks whose elements changed — their owners hear of it (M-12).
      task_ids: [...taskIds].sort(),
    };
    await appendAuditEvent(client, {
      projectId: doc.project_id,
      actor,
      category: 'documents',
      type: 'documents.model.edited',
      scope: { type: 'project', id: doc.project_id },
      object: { type: 'document', id: doc.id },
      payload: data,
      channel: actor.channel,
    });
    await publishEvent(client, {
      event_id: randomUUID(),
      type: 'documents.model.edited',
      project_id: doc.project_id,
      actor: { person_id: actor.personId, org_id: actor.orgId },
      scope: { type: 'project', id: doc.project_id },
      data,
    });
    return { doc: updated, versionNo: next, changes };
  }

  return {
    /** THE model of a build (live, any version state), or null. */
    async getProjectModel(projectId) {
      const { rows } = await pool.query(
        'SELECT * FROM documents.document WHERE project_id = $1 AND is_project_model AND deleted_at IS NULL', [projectId],
      );
      return rows[0] ?? null;
    },

    /** The org whose upload is v1 of the model — the model's author (PRD-07 M-9). */
    async modelAuthorOrgId(documentId) {
      const { rows } = await pool.query(
        'SELECT uploaded_by_org_id FROM documents.document_version WHERE document_id = $1 AND version_no = 1', [documentId],
      );
      return rows[0]?.uploaded_by_org_id ?? null;
    },

    /** The whole link history and every pin of a model. */
    async modelRecord(documentId) {
      return stateOn(pool, documentId);
    },

    // ── the upload check (M-18, 0031) ─────────────────────────────────────
    /** The client-declared GlobalIds of a reserved model version. */
    async saveModelElements({ documentId, versionNo, globalIds }) {
      await pool.query(
        `INSERT INTO documents.model_upload (document_id, version_no, global_ids) VALUES ($1, $2, $3)
         ON CONFLICT (document_id, version_no) DO UPDATE SET global_ids = excluded.global_ids
          WHERE documents.model_upload.checked_at IS NULL`,
        [documentId, versionNo, globalIds],
      );
    },

    /** This version's declared elements and the latest earlier upload's (or null). */
    async modelUploadPair(documentId, versionNo) {
      const { rows } = await pool.query(
        `SELECT version_no, global_ids, checked_at FROM documents.model_upload
          WHERE document_id = $1 AND version_no <= $2 ORDER BY version_no DESC LIMIT 2`,
        [documentId, versionNo],
      );
      const current = rows[0]?.version_no === versionNo ? rows[0] : null;
      return { current, previous: current ? rows[1] ?? null : null };
    },

    async recordModelUploadCheck({ documentId, versionNo, check }) {
      await pool.query(
        `UPDATE documents.model_upload
            SET unmatched_global_ids = $3, regenerated = $4, shared_count = $5, recorded_count = $6, checked_at = now()
          WHERE document_id = $1 AND version_no = $2 AND checked_at IS NULL`,
        [documentId, versionNo, check.unmatched, check.regenerated, check.shared, check.recorded],
      );
    },

    /** The latest completed check of the model (the one the page shows). */
    async latestModelUploadCheck(documentId) {
      const { rows } = await pool.query(
        `SELECT * FROM documents.model_upload WHERE document_id = $1 AND checked_at IS NOT NULL
          ORDER BY version_no DESC LIMIT 1`,
        [documentId],
      );
      return rows[0] ?? null;
    },

    /** Live element links of one task (Files tab card, PRD-05 F-4). */
    async taskElementCount(documentId, taskId) {
      const { rows: [{ n }] } = await pool.query(
        `SELECT count(*)::int AS n FROM documents.element_link
          WHERE document_id = $1 AND task_id = $2 AND removed_in_version IS NULL`,
        [documentId, taskId],
      );
      return n;
    },

    /**
     * M-12 / M-14 — save a record-side draft as version n+1. `decide(state)`
     * (pure, from the domain) runs under the document lock on the latest
     * record and answers {conflicts} or {apply}. Returns {conflicts} | {doc,
     * versionNo, changes} | {stale: current} (the base is not a proven version).
     */
    async saveModelEdit({ documentId, baseVersionNo, note, decide, actor, authorOrgId }) {
      return tx(async (client) => {
        const { rows: [doc] } = await client.query(
          'SELECT * FROM documents.document WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [documentId],
        );
        if (!doc) return null;
        if (baseVersionNo > doc.current_version) return { stale: doc.current_version };
        const state = await stateOn(client, documentId);
        const outcome = decide(state);
        if (outcome.conflicts?.length) return { conflicts: outcome.conflicts };
        if (outcome.refused?.length) return { refused: outcome.refused };
        const { rows: [source] } = await client.query(
          'SELECT * FROM documents.document_version WHERE document_id = $1 AND version_no = $2', [documentId, doc.current_version],
        );
        const saved = await appendRecordVersion(client, {
          doc, source, changeKind: 'edit', baseVersionNo, note, apply: outcome.apply, actor, authorOrgId,
        });
        return { ...saved, dropped: outcome.dropped ?? 0 };
      });
    },

    /**
     * M-17 — Restore vN: append v(n+1) over vN's BYTES and re-apply vN's link
     * record (`plan(state)` from the domain). Nothing is deleted.
     */
    async restoreModel({ documentId, versionNo, note, plan, actor, authorOrgId }) {
      return tx(async (client) => {
        const { rows: [doc] } = await client.query(
          'SELECT * FROM documents.document WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [documentId],
        );
        if (!doc) return null;
        if (versionNo > doc.current_version) return { stale: doc.current_version };
        const { rows: [source] } = await client.query(
          'SELECT * FROM documents.document_version WHERE document_id = $1 AND version_no = $2', [documentId, versionNo],
        );
        if (!source) return null;
        const { remove, add } = plan(await stateOn(client, documentId));
        return appendRecordVersion(client, {
          doc, source, changeKind: 'restore', baseVersionNo: versionNo, note,
          apply: { links: add, unlinks: remove, pins: [], closes: [] }, actor, authorOrgId,
        });
      });
    },
  };
}
