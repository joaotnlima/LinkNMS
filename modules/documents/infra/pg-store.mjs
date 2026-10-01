// Postgres store for the documents module (schema: documents.*, db/v2 0001).
//
// Owns its transactions. The ONE ledgered/outboxed moment is completeUpload —
// doc 10 lists exactly `documents.version.uploaded` (● sha256): creation only
// reserves the row and mints the ticket; until the bytes are proven present
// the version is invisible (current_version never points at it).
//
// Cross-schema READS are the V6 scope resolvers (project, contracting,
// planning, tendering, quality, identity) — query ports only; this module
// never WRITES outside documents.* + ledger + outbox.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';

export function createDocumentsStore(pool) {
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    // ── identity / project guards (same ports as the sibling modules) ─────
    async getPersonByClerkId(clerkUserId) {
      const { rows } = await pool.query('SELECT * FROM identity.person WHERE clerk_user_id = $1', [clerkUserId]);
      return rows[0] ?? null;
    },

    async isParticipant(projectId, orgId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM project.project pr WHERE pr.id = $1 AND pr.owner_org_id = $2
         UNION ALL
         SELECT 1 FROM project.participation p
          WHERE p.project_id = $1 AND p.org_id = $2 AND p.status = 'active'
         LIMIT 1`,
        [projectId, orgId],
      );
      return rows.length > 0;
    },

    async isStaffed(projectId, orgId, personId) {
      const { rows } = await pool.query(
        'SELECT 1 FROM identity.project_staffing WHERE project_id = $1 AND org_id = $2 AND person_id = $3',
        [projectId, orgId, personId],
      );
      return rows.length > 0;
    },

    /**
     * Resolve a document scope to its anchor: does the object exist, and
     * which project does it belong to (null for `profile` — an org has no
     * project, so profile documents are never ledgered into a build record).
     */
    async resolveScope(scopeType, scopeId) {
      const queries = {
        project: 'SELECT id AS project_id FROM project.project WHERE id = $1',
        location: 'SELECT project_id FROM project.location WHERE id = $1',
        contract: 'SELECT project_id FROM contracting.contract WHERE id = $1',
        task: 'SELECT project_id FROM planning.task WHERE id = $1 AND deleted_at IS NULL',
        rfp: 'SELECT project_id FROM tendering.rfp WHERE id = $1',
        proposal: `SELECT r.project_id FROM tendering.proposal p
                     JOIN tendering.rfp r ON r.id = p.rfp_id WHERE p.id = $1`,
        change_order: `SELECT c.project_id FROM contracting.change_order co
                         JOIN contracting.contract c ON c.id = co.contract_id WHERE co.id = $1`,
        measurement: `SELECT c.project_id FROM contracting.measurement m
                        JOIN contracting.contract c ON c.id = m.contract_id WHERE m.id = $1`,
        nonconformity: 'SELECT project_id FROM quality.nonconformity WHERE id = $1',
        profile: 'SELECT NULL::uuid AS project_id FROM identity.organization WHERE id = $1',
      };
      const sql = queries[scopeType];
      if (!sql) return null;
      const { rows } = await pool.query(sql, [scopeId]);
      if (!rows.length) return null;
      return { projectId: rows[0].project_id ?? null };
    },

    /**
     * V6 — may `orgId` READ documents of this scope?
     *   project | location | task | nonconformity → any active participant (V1);
     *   contract | change_order | measurement → the contract's parties (V2);
     *     `shareWithAncestors` widens a contract-scoped document to the client
     *     chain above and the owner (V3 — scope, never prices: the file was
     *     flagged shareable by a party);
     *   rfp → issuer or an invited recipient org; proposal → issuer or bidder
     *     (V8 — a competing bidder never reads another lane's documents);
     *   profile → anyone signed in (the directory is public inside the app).
     */
    async canReadScope({ scopeType, scopeId, orgId, shareWithAncestors = false }) {
      switch (scopeType) {
        case 'profile':
          return true;
        case 'project':
          return this.isParticipant(scopeId, orgId);
        case 'location': {
          const { rows } = await pool.query('SELECT project_id FROM project.location WHERE id = $1', [scopeId]);
          return rows.length ? this.isParticipant(rows[0].project_id, orgId) : false;
        }
        case 'task': {
          const { rows } = await pool.query(
            'SELECT project_id FROM planning.task WHERE id = $1 AND deleted_at IS NULL', [scopeId],
          );
          return rows.length ? this.isParticipant(rows[0].project_id, orgId) : false;
        }
        case 'nonconformity': {
          const { rows } = await pool.query('SELECT project_id FROM quality.nonconformity WHERE id = $1', [scopeId]);
          return rows.length ? this.isParticipant(rows[0].project_id, orgId) : false;
        }
        case 'contract':
          return contractRead(pool, scopeId, orgId, shareWithAncestors);
        case 'change_order': {
          const { rows } = await pool.query('SELECT contract_id FROM contracting.change_order WHERE id = $1', [scopeId]);
          return rows.length ? contractRead(pool, rows[0].contract_id, orgId, shareWithAncestors) : false;
        }
        case 'measurement': {
          const { rows } = await pool.query('SELECT contract_id FROM contracting.measurement WHERE id = $1', [scopeId]);
          return rows.length ? contractRead(pool, rows[0].contract_id, orgId, shareWithAncestors) : false;
        }
        case 'rfp': {
          const { rows } = await pool.query(
            `SELECT 1 FROM tendering.rfp r
              WHERE r.id = $1 AND (r.issuer_org_id = $2
                 OR EXISTS (SELECT 1 FROM tendering.rfp_recipient rc
                             WHERE rc.rfp_id = r.id AND rc.org_id = $2))`,
            [scopeId, orgId],
          );
          return rows.length > 0;
        }
        case 'proposal': {
          const { rows } = await pool.query(
            `SELECT 1 FROM tendering.proposal p JOIN tendering.rfp r ON r.id = p.rfp_id
              WHERE p.id = $1 AND (p.bidder_org_id = $2 OR r.issuer_org_id = $2)`,
            [scopeId, orgId],
          );
          return rows.length > 0;
        }
        default:
          return false;
      }
    },

    /**
     * Edit scope of the target object (openapi x-relationship) — who may
     * ATTACH a document. Stricter than reading where the object has an owner:
     *   rfp → issuer only; proposal → bidder or issuer (recorded-offline PDFs);
     *   contract family → parties; profile → the org itself;
     *   task → D-33 edit scope (branch supplier via assignee, or the client
     *   chain above, or the owner); the rest → any active participant.
     */
    async canEditScope({ scopeType, scopeId, orgId }) {
      switch (scopeType) {
        case 'profile':
          return scopeId === orgId;
        case 'rfp': {
          const { rows } = await pool.query('SELECT 1 FROM tendering.rfp WHERE id = $1 AND issuer_org_id = $2', [scopeId, orgId]);
          return rows.length > 0;
        }
        case 'proposal': {
          const { rows } = await pool.query(
            `SELECT 1 FROM tendering.proposal p JOIN tendering.rfp r ON r.id = p.rfp_id
              WHERE p.id = $1 AND (p.bidder_org_id = $2 OR r.issuer_org_id = $2)`,
            [scopeId, orgId],
          );
          return rows.length > 0;
        }
        case 'contract':
          return contractParty(pool, scopeId, orgId);
        case 'change_order': {
          const { rows } = await pool.query('SELECT contract_id FROM contracting.change_order WHERE id = $1', [scopeId]);
          return rows.length ? contractParty(pool, rows[0].contract_id, orgId) : false;
        }
        case 'measurement': {
          const { rows } = await pool.query('SELECT contract_id FROM contracting.measurement WHERE id = $1', [scopeId]);
          return rows.length ? contractParty(pool, rows[0].contract_id, orgId) : false;
        }
        case 'task': {
          const { rows } = await pool.query(
            `SELECT 1 FROM planning.task t
              WHERE t.id = $1 AND t.deleted_at IS NULL
                AND (t.assignee_org_id = $2
                     OR EXISTS (SELECT 1 FROM project.project pr
                                 WHERE pr.id = t.project_id AND pr.owner_org_id = $2))`,
            [scopeId, orgId],
          );
          if (rows.length) return true;
          // Client chain over the task's branch contract.
          const { rows: chain } = await pool.query(
            `WITH RECURSIVE up AS (
               SELECT c.id, c.client_org_id, c.parent_contract_id
                 FROM contracting.contract c
                WHERE c.id = (SELECT coalesce(t.branch_contract_id, t.contract_id)
                                FROM planning.task t WHERE t.id = $1)
               UNION ALL
               SELECT p.id, p.client_org_id, p.parent_contract_id
                 FROM contracting.contract p JOIN up ON p.id = up.parent_contract_id
             )
             SELECT 1 FROM up WHERE client_org_id = $2 LIMIT 1`,
            [scopeId, orgId],
          );
          return chain.length > 0;
        }
        case 'project':
        case 'location':
        case 'nonconformity': {
          const resolved = await this.resolveScope(scopeType, scopeId);
          return resolved ? this.isParticipant(resolved.projectId, orgId) : false;
        }
        default:
          return false;
      }
    },

    // ── documents ──────────────────────────────────────────────────────────
    async getDocument(documentId) {
      const { rows } = await pool.query('SELECT * FROM documents.document WHERE id = $1', [documentId]);
      return rows[0] ?? null;
    },

    async getVersion(documentId, versionNo) {
      const { rows } = await pool.query(
        'SELECT * FROM documents.document_version WHERE document_id = $1 AND version_no = $2',
        [documentId, versionNo],
      );
      return rows[0] ?? null;
    },

    /** Completed versions only — a version exists on the wire once proven. */
    async listVersions(documentId, currentVersion) {
      const { rows } = await pool.query(
        `SELECT * FROM documents.document_version
          WHERE document_id = $1 AND version_no <= $2 ORDER BY version_no`,
        [documentId, currentVersion],
      );
      return rows;
    },

    /**
     * Documents of one scope with at least one proven version. Keyset on id.
     * A private document (private_to_org_id set — e.g. a record export) lists
     * only for its owning org; NULL (every ordinary document) lists for every
     * reader of the scope, as before.
     */
    async listDocuments({ scopeType, scopeId, orgId, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT * FROM documents.document
          WHERE scope_type = $1 AND scope_id = $2 AND current_version > 0
            AND ($3::uuid IS NULL OR id > $3)
            AND (private_to_org_id IS NULL OR private_to_org_id = $5)
          ORDER BY id LIMIT $4`,
        [scopeType, scopeId, cursor, limit + 1, orgId],
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },

    /** Reserve document + version 1. No ledger yet — nothing proven uploaded. */
    async createDocument({ id, projectId, scopeType, scopeId, kind, title, shareWithAncestors, file, storageKey, actor, privateToOrgId = null }) {
      return tx(async (client) => {
        await client.query(
          `INSERT INTO documents.document (id, project_id, scope_type, scope_id, kind, title, share_with_ancestors, private_to_org_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, projectId, scopeType, scopeId, kind, title, shareWithAncestors, privateToOrgId],
        );
        const { rows } = await client.query(
          `INSERT INTO documents.document_version
             (document_id, version_no, storage_key, mime, size_bytes, sha256, uploaded_by_person_id, uploaded_by_org_id)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [id, storageKey, file.mime, file.size_bytes, file.sha256.toLowerCase(), actor.personId, actor.orgId],
        );
        return rows[0];
      });
    },

    /** Reserve the next version of an existing document. */
    async addVersion({ documentId, file, storageKeyOf, actor }) {
      return tx(async (client) => {
        // Lock the parent so two concurrent uploads get distinct numbers.
        await client.query('SELECT 1 FROM documents.document WHERE id = $1 FOR UPDATE', [documentId]);
        const { rows: [{ next }] } = await client.query(
          'SELECT coalesce(max(version_no), 0) + 1 AS next FROM documents.document_version WHERE document_id = $1',
          [documentId],
        );
        const { rows } = await client.query(
          `INSERT INTO documents.document_version
             (document_id, version_no, storage_key, mime, size_bytes, sha256, uploaded_by_person_id, uploaded_by_org_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [documentId, next, storageKeyOf(next), file.mime, file.size_bytes, file.sha256.toLowerCase(), actor.personId, actor.orgId],
        );
        return rows[0];
      });
    },

    /**
     * The proven moment: bytes exist in storage with the declared size —
     * advance current_version, ledger the sha256 (doc 08) and publish
     * `documents.version.uploaded` (doc 10), all in ONE transaction.
     * Replays (version already current or older) return the document as-is.
     */
    async completeUpload({ documentId, versionNo, actor }) {
      return tx(async (client) => {
        const { rows: docs } = await client.query(
          'SELECT * FROM documents.document WHERE id = $1 FOR UPDATE', [documentId],
        );
        const doc = docs[0];
        if (!doc) return null;
        if (doc.current_version >= versionNo) return { doc, replay: true };

        const { rows: [version] } = await client.query(
          'SELECT * FROM documents.document_version WHERE document_id = $1 AND version_no = $2',
          [documentId, versionNo],
        );
        if (!version) return null;

        const { rows: [updated] } = await client.query(
          'UPDATE documents.document SET current_version = $2 WHERE id = $1 RETURNING *',
          [documentId, versionNo],
        );
        // Profile documents anchor to no project: nothing to prove in a build
        // record, so no ledger entry and no feed event (doc 08 scopes the
        // ledger to builds).
        if (doc.project_id) {
          const scope = ['contract', 'change_order', 'measurement'].includes(doc.scope_type)
            ? { type: 'contract', id: await contractIdOfScope(client, doc) }
            : { type: 'project', id: doc.project_id };
          await appendAuditEvent(client, {
            projectId: doc.project_id,
            actor,
            category: 'documents',
            type: 'documents.version.uploaded',
            scope,
            object: { type: 'document', id: documentId },
            payload: {
              scope_type: doc.scope_type,
              scope_id: doc.scope_id,
              kind: doc.kind,
              title: doc.title,
              version_no: versionNo,
              sha256: version.sha256,
              size_bytes: Number(version.size_bytes),
              mime: version.mime,
            },
            channel: actor.channel,
          });
          await publishEvent(client, {
            event_id: randomUUID(),
            type: 'documents.version.uploaded',
            project_id: doc.project_id,
            actor: { person_id: actor.personId, org_id: actor.orgId },
            scope,
            data: {
              document_id: documentId,
              version_no: versionNo,
              scope_type: doc.scope_type,
              scope_id: doc.scope_id,
              kind: doc.kind,
              title: doc.title,
              sha256: version.sha256,
            },
          });
        }
        return { doc: updated, replay: false };
      });
    },
  };
}

async function contractParty(pool, contractId, orgId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM contracting.contract WHERE id = $1 AND (client_org_id = $2 OR supplier_org_id = $2)',
    [contractId, orgId],
  );
  return rows.length > 0;
}

async function contractRead(pool, contractId, orgId, shareWithAncestors) {
  if (await contractParty(pool, contractId, orgId)) return true;
  if (!shareWithAncestors) return false;
  // V3 widening: the client chain above the contract, and the project owner.
  const { rows } = await pool.query(
    `WITH RECURSIVE up AS (
       SELECT c.id, c.project_id, c.client_org_id, c.parent_contract_id
         FROM contracting.contract c WHERE c.id = $1
       UNION ALL
       SELECT p.id, p.project_id, p.client_org_id, p.parent_contract_id
         FROM contracting.contract p JOIN up ON p.id = up.parent_contract_id
     )
     SELECT 1 WHERE EXISTS (SELECT 1 FROM up WHERE client_org_id = $2)
         OR EXISTS (SELECT 1 FROM project.project pr
                     WHERE pr.id = (SELECT project_id FROM up ORDER BY 1 LIMIT 1)
                       AND pr.owner_org_id = $2)`,
    [contractId, orgId],
  );
  return rows.length > 0;
}

async function contractIdOfScope(client, doc) {
  if (doc.scope_type === 'contract') return doc.scope_id;
  const table = doc.scope_type === 'change_order' ? 'contracting.change_order' : 'contracting.measurement';
  const { rows } = await client.query(`SELECT contract_id FROM ${table} WHERE id = $1`, [doc.scope_id]);
  return rows[0]?.contract_id ?? doc.scope_id;
}
