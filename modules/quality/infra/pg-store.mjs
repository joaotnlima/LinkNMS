// Postgres store for the quality module (schema: quality.*, db/v2 0001).
//
// Owns its transactions. Every write appends its ledger entry (category
// 'quality') AND — where doc 10 lists an event — publishes it on the SAME
// client before commit (invariants §6.3/§6.4, doc 02 rule 3). Cross-schema
// READS (identity for the actor, project for guards, planning.task for the
// row/branch, contracting.contract for the client chain) are query ports; it
// never WRITES outside quality.* + ledger + outbox.
//
// The DB CHECKs are the last line, not the first: the use cases pre-answer
// 8g (decider ≠ requester) and 8h (closer = raiser) as clean 403s; if a race
// slips past, the CHECK still refuses the write.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';

export function createQualityStore(pool) {
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

  /** One verification request + what its wire body needs, on any client. */
  async function loadVerification(q, verificationId) {
    const { rows } = await q.query(
      `SELECT vr.*, t.name AS task_name, t.project_id
         FROM quality.verification_request vr
         JOIN planning.task t ON t.id = vr.task_id
        WHERE vr.id = $1`,
      [verificationId],
    );
    return rows[0] ?? null;
  }

  return {
    // ── reads ────────────────────────────────────────────────────────────
    async getPersonByClerkId(clerkUserId) {
      const { rows } = await pool.query('SELECT * FROM identity.person WHERE clerk_user_id = $1', [clerkUserId]);
      return rows[0] ?? null;
    },

    async getProject(projectId) {
      const { rows } = await pool.query('SELECT * FROM project.project WHERE id = $1', [projectId]);
      return rows[0] ?? null;
    },

    async isParticipant(projectId, orgId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM project.participation WHERE project_id = $1 AND org_id = $2 AND status = 'active'`,
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

    /** Invited with capacity inspection|safety (doc 04 §verify, doc 17 §5). */
    async isInvitedInspector(projectId, orgId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM project.participation
          WHERE project_id = $1 AND org_id = $2 AND status = 'active'
            AND invite_capacity IN ('inspection','safety')`,
        [projectId, orgId],
      );
      return rows.length > 0;
    },

    /** Owner org, or client of a live contract on the project. */
    async isProjectClient(projectId, orgId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM project.project pr WHERE pr.id = $1 AND pr.owner_org_id = $2
         UNION ALL
         SELECT 1 FROM contracting.contract c
          WHERE c.project_id = $1 AND c.client_org_id = $2
            AND c.status NOT IN ('draft','cancelled','terminated')
          LIMIT 1`,
        [projectId, orgId],
      );
      return rows.length > 0;
    },

    /**
     * Is `orgId` in the CLIENT CHAIN over a row: client of the task's branch
     * contract (or the given contract), up any parent links, or the project
     * owner (doc 04 §verify — "the client chain up to the owner").
     */
    async isClientChain(orgId, { taskId = null, contractId = null, projectId }) {
      const { rows } = await pool.query(
        `WITH RECURSIVE base AS (
             SELECT coalesce(t.branch_contract_id, t.contract_id) AS cid
               FROM planning.task t WHERE t.id = $2::uuid
             UNION ALL
             SELECT $3::uuid WHERE $2::uuid IS NULL
           ),
           up AS (
             SELECT c.id, c.client_org_id, c.parent_contract_id
               FROM contracting.contract c JOIN base ON c.id = base.cid
             UNION ALL
             SELECT p.id, p.client_org_id, p.parent_contract_id
               FROM contracting.contract p JOIN up ON p.id = up.parent_contract_id
           )
         SELECT 1 WHERE EXISTS (SELECT 1 FROM up WHERE up.client_org_id = $1)
             OR EXISTS (SELECT 1 FROM project.project pr WHERE pr.id = $4 AND pr.owner_org_id = $1)`,
        [orgId, taskId, contractId, projectId],
      );
      return rows.length > 0;
    },

    async getTask(taskId) {
      const { rows } = await pool.query(
        `SELECT id, project_id, name, contract_id, branch_contract_id
           FROM planning.task WHERE id = $1 AND deleted_at IS NULL`,
        [taskId],
      );
      return rows[0] ?? null;
    },

    /** Which of `taskIds` are live rows of this project. */
    async tasksOfProject(projectId, taskIds) {
      const { rows } = await pool.query(
        `SELECT id FROM planning.task
          WHERE project_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [projectId, taskIds],
      );
      return new Set(rows.map((r) => r.id));
    },

    async getVerification(verificationId) {
      return loadVerification(pool, verificationId);
    },

    /**
     * The viewer org's decision queue: requests over rows whose client chain
     * contains the org (or where it is an invited inspector), minus its own
     * reports (D-31). Keyset-paged on id.
     */
    async listMyVerifications({ orgId, status, projectId, cursor, limit }) {
      const { rows } = await pool.query(
        `WITH RECURSIVE chain AS (
             SELECT c.id AS base, c.client_org_id, c.parent_contract_id
               FROM contracting.contract c
             UNION ALL
             SELECT ch.base, p.client_org_id, p.parent_contract_id
               FROM contracting.contract p JOIN chain ch ON p.id = ch.parent_contract_id
           )
         SELECT vr.*, t.name AS task_name, t.project_id
           FROM quality.verification_request vr
           JOIN planning.task t ON t.id = vr.task_id
          WHERE vr.requested_by_org_id <> $1
            AND ($2::text IS NULL OR vr.status = $2)
            AND ($3::uuid IS NULL OR t.project_id = $3)
            AND ($4::uuid IS NULL OR vr.id > $4)
            AND (
              EXISTS (SELECT 1 FROM project.project pr
                       WHERE pr.id = t.project_id AND pr.owner_org_id = $1)
              OR EXISTS (SELECT 1 FROM project.participation p
                          WHERE p.project_id = t.project_id AND p.org_id = $1
                            AND p.status = 'active'
                            AND p.invite_capacity IN ('inspection','safety'))
              OR EXISTS (SELECT 1 FROM chain
                          WHERE chain.base = coalesce(t.branch_contract_id, t.contract_id)
                            AND chain.client_org_id = $1)
            )
          ORDER BY vr.id
          LIMIT $5`,
        [orgId, status, projectId, cursor, limit + 1],
      );
      const page = rows.slice(0, limit);
      return {
        items: page,
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      };
    },

    async getNonConformity(nonconformityId) {
      const { rows } = await pool.query('SELECT * FROM quality.nonconformity WHERE id = $1', [nonconformityId]);
      return rows[0] ?? null;
    },

    async getInspection(inspectionId) {
      const { rows } = await pool.query('SELECT * FROM quality.inspection WHERE id = $1', [inspectionId]);
      return rows[0] ?? null;
    },

    // ── writes (ledger + outbox on the same client — §6.3/§6.4) ──────────

    /** pending → accepted|rejected; null when the pending row raced away. */
    async decideVerification({ verificationId, status, reason, deciderOrgId, deciderPersonId, projectId, taskId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE quality.verification_request
              SET status = $2, decided_by_org_id = $3, decided_by_person_id = $4,
                  reason = $5, decided_at = now()
            WHERE id = $1 AND status = 'pending'
            RETURNING *`,
          [verificationId, status, deciderOrgId, deciderPersonId, reason],
        );
        if (!rows.length) return null; // decided concurrently — caller answers 409
        const type = `quality.verification.${status}`;
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'quality',
          type,
          scope: { type: 'project', id: projectId },
          object: { type: 'verification_request', id: verificationId },
          payload: {
            task_id: taskId,
            decided_by_org_id: deciderOrgId,
            ...(reason ? { reason } : {}),
          },
          channel: actor.channel,
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type,
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'project', id: projectId },
          data: {
            task_id: taskId,
            project_id: projectId,
            decided_by: { org_id: deciderOrgId, person_id: deciderPersonId },
            note: reason ?? null,
            ...(status === 'rejected' ? { reason } : {}),
          },
        });
        return loadVerification(client, verificationId);
      });
    },

    async createNonConformity({ id, projectId, taskId, contractId, kind, severity, description,
      photoDocumentIds, assignedToOrgId, raisedByOrgId, raisedByPersonId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO quality.nonconformity
             (id, project_id, task_id, contract_id, kind, raised_by_org_id, raised_by_person_id,
              assigned_to_org_id, severity, description, photo_document_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING *`,
          [id, projectId, taskId, contractId, kind, raisedByOrgId, raisedByPersonId,
            assignedToOrgId, severity, description, photoDocumentIds],
        );
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'quality',
          type: 'quality.nonconformity.raised',
          scope: { type: 'project', id: projectId },
          object: { type: 'nonconformity', id },
          payload: {
            kind, severity,
            task_id: taskId, contract_id: contractId,
            assigned_to_org_id: assignedToOrgId,
          },
          channel: actor.channel,
        });
        // Consumers (doc 10): contracting (reception guard), notifications.
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'quality.nonconformity.raised',
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'project', id: projectId },
          data: {
            project_id: projectId,
            task_id: taskId,
            contract_id: contractId,
            kind, severity,
            assigned_to_org_id: assignedToOrgId,
            status: 'open',
          },
        });
        return rows[0];
      });
    },

    /** Guarded status move; null when `from` raced away (caller answers 409). */
    async transitionNonConformity({ nonconformityId, from, to, set, eventType, note, projectId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE quality.nonconformity
              SET status = $3,
                  assigned_to_org_id = coalesce($4, assigned_to_org_id),
                  closed_by_org_id = coalesce($5, closed_by_org_id)
            WHERE id = $1 AND status = $2
            RETURNING *`,
          [nonconformityId, from, to, set.assignedToOrgId ?? null, set.closedByOrgId ?? null],
        );
        if (!rows.length) return null;
        const nc = rows[0];
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'quality',
          type: eventType,
          scope: { type: 'project', id: projectId },
          object: { type: 'nonconformity', id: nonconformityId },
          payload: {
            from, to,
            ...(set.assignedToOrgId ? { assigned_to_org_id: set.assignedToOrgId } : {}),
            ...(note ? { note } : {}),
          },
          channel: actor.channel,
        });
        // Contracting's reception guard reads `status` from the event data.
        await publishEvent(client, {
          event_id: randomUUID(),
          type: eventType,
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'project', id: projectId },
          data: {
            project_id: projectId,
            task_id: nc.task_id,
            contract_id: nc.contract_id,
            status: nc.status,
            assigned_to_org_id: nc.assigned_to_org_id,
            note: note ?? null,
          },
        });
        return nc;
      });
    },

    /** Ledger only — doc 10 lists no outbox event for inspections. */
    async createInspection({ id, projectId, inspectorOrgId, kind, date, checklist, findings, taskIds, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO quality.inspection
             (id, project_id, inspector_org_id, kind, date, checklist, findings, task_ids)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
           RETURNING *`,
          [id, projectId, inspectorOrgId, kind, date, JSON.stringify(checklist), findings, taskIds],
        );
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'quality',
          type: 'quality.inspection.recorded',
          scope: { type: 'project', id: projectId },
          object: { type: 'inspection', id },
          payload: { kind, date, task_ids: taskIds, checklist_items: checklist.length },
          channel: actor.channel,
        });
        return rows[0];
      });
    },

    /**
     * Consumer write (planning.progress.reported → pending request). Ledger
     * only — creation is not a doc-10 event. Idempotent: one pending request
     * per task; a replay finds it (FOR UPDATE serialises racers) and skips.
     */
    async createVerificationRequest({ id, taskId, projectId, requestedByOrgId, criteria, actor }) {
      return tx(async (client) => {
        const { rows: pending } = await client.query(
          `SELECT id FROM quality.verification_request
            WHERE task_id = $1 AND status = 'pending' FOR UPDATE`,
          [taskId],
        );
        if (pending.length) return null; // already queued — absorb the replay
        await client.query(
          `INSERT INTO quality.verification_request (id, task_id, requested_by_org_id, criteria_snapshot)
           VALUES ($1, $2, $3, $4)`,
          [id, taskId, requestedByOrgId, criteria],
        );
        await appendAuditEvent(client, {
          projectId,
          actor: { personId: actor.personId, orgId: actor.orgId },
          category: 'quality',
          type: 'quality.verification.requested',
          scope: { type: 'project', id: projectId },
          object: { type: 'verification_request', id },
          payload: { task_id: taskId, requested_by_org_id: requestedByOrgId },
          channel: actor.channel ?? 'system',
        });
        return loadVerification(client, id);
      });
    },
  };
}
