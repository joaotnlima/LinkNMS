// Postgres part of the documents store for task links and the project / task
// file reads (PRD-05). Spread into createDocumentsStore's object.
//
// documents.document_link is this module's own table; the reads never join
// another schema. Who may link (task edit scope) and who may read (V1/V6) are
// decided in the application layer before these run.
import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { IMAGE_EXTENSIONS, PROJECT_FILE_SCOPES } from '../domain/files.mjs';

/**
 * The FileType of a version row as SQL, generated from the same vocabulary
 * domain/files.mjs fileTypeOf() uses (name first, mime second), so the type
 * filter of listProjectDocuments agrees with the tag every row shows.
 */
export function fileTypeSql(v) {
  const key = `lower(${v}.storage_key)`;
  const mime = `lower(${v}.mime)`;
  const images = IMAGE_EXTENSIONS.map((e) => `${key} LIKE '%.${e}'`).join(' OR ');
  return `(CASE
    WHEN ${key} LIKE '%.pdf' THEN 'pdf'
    WHEN ${key} LIKE '%.dwg' THEN 'dwg'
    WHEN ${key} LIKE '%.dxf' THEN 'dxf'
    WHEN ${key} LIKE '%.ifc' THEN 'ifc'
    WHEN ${images} THEN 'image'
    WHEN ${mime} = 'application/pdf' THEN 'pdf'
    WHEN ${mime} IN ('image/vnd.dwg', 'application/acad') THEN 'dwg'
    WHEN ${mime} IN ('image/vnd.dxf', 'application/dxf') THEN 'dxf'
    WHEN ${mime} IN ('model/ifc', 'application/x-step') THEN 'ifc'
    WHEN ${mime} LIKE 'image/%' THEN 'image'
    ELSE 'other' END)`;
}

/** Insert link rows on the caller's client; ledgers what was new. Returns inserted rows. */
export async function insertLinksOn(client, { documentId, projectId, links, actor }) {
  const inserted = [];
  for (const l of links) {
    const { rows } = await client.query(
      `INSERT INTO documents.document_link
         (document_id, task_id, project_id, role, inherited, inherited_from_task_id, linked_by_person_id, linked_by_org_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (document_id, task_id) DO NOTHING RETURNING *`,
      [documentId, l.taskId, projectId, l.role, l.inherited, l.inheritedFromTaskId, actor.personId, actor.orgId],
    );
    if (rows.length) inserted.push(rows[0]);
  }
  if (inserted.length) {
    await appendAuditEvent(client, {
      projectId,
      actor,
      category: 'documents',
      type: 'documents.link.added',
      scope: { type: 'project', id: projectId },
      object: { type: 'document', id: documentId },
      payload: { links: inserted.map((r) => ({ task_id: r.task_id, role: r.role, inherited: r.inherited })) },
      channel: actor.channel,
    });
  }
  return inserted;
}

const LIVE = `d.deleted_at IS NULL AND d.current_version > 0
  AND (d.private_to_org_id IS NULL OR d.private_to_org_id = $ORG)`;

/** @param {import('pg').Pool} pool @param {(fn: Function) => Promise<any>} tx */
export function linkQueries(pool, tx) {
  return {
    /**
     * Of these ids, the documents a task of `projectId` may link: proven,
     * live, not private, project/location/task files of the same build.
     */
    async linkableDocuments(documentIds, projectId) {
      const { rows } = await pool.query(
        `SELECT d.* FROM documents.document d
          WHERE d.id = ANY($1::uuid[]) AND d.project_id = $2 AND d.scope_type = ANY($3::text[])
            AND d.deleted_at IS NULL AND d.current_version > 0 AND d.private_to_org_id IS NULL`,
        [documentIds, projectId, PROJECT_FILE_SCOPES],
      );
      return rows;
    },

    /** Link documents to tasks in one transaction (idempotent per document × task). */
    async addLinks({ documentIds, projectId, links, actor }) {
      return tx(async (client) => {
        const out = [];
        for (const documentId of documentIds) {
          out.push(...await insertLinksOn(client, { documentId, projectId, links, actor }));
        }
        return out;
      });
    },

    /** Remove one task's link; ledgered. Null when there was none. */
    async removeLink({ documentId, taskId, projectId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          'DELETE FROM documents.document_link WHERE document_id = $1 AND task_id = $2 RETURNING *',
          [documentId, taskId],
        );
        if (!rows.length) return null;
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'documents',
          type: 'documents.link.removed',
          scope: { type: 'project', id: projectId },
          object: { type: 'document', id: documentId },
          payload: { task_id: taskId, role: rows[0].role, inherited: rows[0].inherited },
          channel: actor.channel,
        });
        return rows[0];
      });
    },

    /**
     * The files of one task: documents linked to it (with the link) and
     * documents scoped to the task itself (`link` null). Capped at 500.
     */
    async listTaskFiles({ taskId, orgId }) {
      const { rows } = await pool.query(
        `SELECT d.*, l.role AS link_role, l.inherited AS link_inherited,
                l.inherited_from_task_id AS link_inherited_from, (l.task_id IS NOT NULL) AS linked
           FROM documents.document d
           LEFT JOIN documents.document_link l ON l.document_id = d.id AND l.task_id = $1
          WHERE (l.task_id IS NOT NULL OR (d.scope_type = 'task' AND d.scope_id = $1))
            AND ${LIVE.replaceAll('$ORG', '$2')}
          ORDER BY d.id LIMIT 500`,
        [taskId, orgId],
      );
      return rows;
    },

    /** Proven versions of these documents, oldest first — one query for a whole list. */
    async versionsOfDocuments(documentIds) {
      if (!documentIds.length) return [];
      const { rows } = await pool.query(
        `SELECT v.* FROM documents.document_version v
           JOIN documents.document d ON d.id = v.document_id
          WHERE v.document_id = ANY($1::uuid[]) AND v.version_no <= d.current_version
          ORDER BY v.document_id, v.version_no`,
        [documentIds],
      );
      return rows;
    },

    /** Every link of these documents (for `used_on`). */
    async linksOfDocuments(documentIds) {
      if (!documentIds.length) return [];
      const { rows } = await pool.query(
        `SELECT document_id, task_id, role, inherited FROM documents.document_link
          WHERE document_id = ANY($1::uuid[]) ORDER BY document_id, task_id`,
        [documentIds],
      );
      return rows;
    },

    /**
     * A project's files the viewer reads (V1/V6: project, location and task
     * files; never contract/RFP/proposal files, never another org's private
     * document). Newest first (UUIDv7 ids), keyset on id; `q` searches the
     * title, `fileType` filters on the newest version's type.
     */
    async listProjectFiles({ projectId, orgId, q = null, fileType = null, cursor = null, limit = 50 }) {
      const { rows } = await pool.query(
        `SELECT d.* FROM documents.document d
           JOIN documents.document_version v ON v.document_id = d.id AND v.version_no = d.current_version
          WHERE d.project_id = $1 AND d.scope_type = ANY($3::text[])
            AND ${LIVE.replaceAll('$ORG', '$2')}
            AND ($4::text IS NULL OR d.title ILIKE '%' || $4 || '%')
            AND ($5::text IS NULL OR ${fileTypeSql('v')} = $5)
            AND ($6::uuid IS NULL OR d.id < $6)
          ORDER BY d.id DESC LIMIT $7`,
        [projectId, orgId, PROJECT_FILE_SCOPES, q, fileType, cursor, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },
  };
}

