// Postgres store for the collaboration module (schema: collaboration.*,
// db/v2 0001 + 0005).
//
// Owns its transactions. Ledger + outbox (same client, invariants §6.3/§6.4)
// exactly where doc 10 lists an event: collaboration.question.opened /
// .answered / .resolved and collaboration.minute.acknowledged. Notes, minute
// drafts and notification housekeeping are plain writes — they are not part
// of the build record.
//
// Cross-schema READS are the thread anchors (a thread's visibility IS the
// object's — doc 08): resolvers over project, planning, contracting,
// tendering, quality, documents. Never WRITES outside collaboration.* +
// ledger + outbox.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';
import { notificationQueries } from './pg-notifications.mjs';

export function createCollaborationStore(pool) {
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

  async function isParticipant(projectId, orgId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM project.project pr WHERE pr.id = $1 AND pr.owner_org_id = $2
       UNION ALL
       SELECT 1 FROM project.participation p
        WHERE p.project_id = $1 AND p.org_id = $2 AND p.status = 'active'
       LIMIT 1`,
      [projectId, orgId],
    );
    return rows.length > 0;
  }

  async function contractParty(contractId, orgId) {
    const { rows } = await pool.query(
      'SELECT 1 FROM contracting.contract WHERE id = $1 AND (client_org_id = $2 OR supplier_org_id = $2)',
      [contractId, orgId],
    );
    return rows.length > 0;
  }

  /** Object reference → its project anchor (null when the type is unknown). */
  async function resolveObject(objectType, objectId) {
    const queries = {
      project: 'SELECT id AS project_id FROM project.project WHERE id = $1',
      task: 'SELECT project_id FROM planning.task WHERE id = $1 AND deleted_at IS NULL',
      contract: 'SELECT project_id FROM contracting.contract WHERE id = $1',
      variation: 'SELECT project_id FROM planning.variation WHERE id = $1',
      change_order: `SELECT c.project_id FROM contracting.change_order co
                       JOIN contracting.contract c ON c.id = co.contract_id WHERE co.id = $1`,
      measurement: `SELECT c.project_id FROM contracting.measurement m
                      JOIN contracting.contract c ON c.id = m.contract_id WHERE m.id = $1`,
      nonconformity: 'SELECT project_id FROM quality.nonconformity WHERE id = $1',
      rfp: 'SELECT project_id FROM tendering.rfp WHERE id = $1',
      proposal: `SELECT r.project_id FROM tendering.proposal p
                   JOIN tendering.rfp r ON r.id = p.rfp_id WHERE p.id = $1`,
      document: 'SELECT project_id FROM documents.document WHERE id = $1',
      minute: 'SELECT project_id FROM collaboration.meeting_minute WHERE id = $1',
    };
    const sql = queries[objectType];
    if (!sql) return null;
    const { rows } = await pool.query(sql, [objectId]);
    if (!rows.length) return null;
    return { projectId: rows[0].project_id ?? null };
  }

  /**
   * May `orgId` READ this object — and therefore its thread (doc 08:
   * "visibility = the object's")? Plan-side objects follow V1 (any active
   * participant); money-side follow V2 (contract parties); tendering follows
   * V8 (issuer + own lane only); a document thread follows the document's
   * scope one level down.
   */
  async function canReadObject({ objectType, objectId, orgId }) {
    switch (objectType) {
      case 'project':
        return isParticipant(objectId, orgId);
      case 'task':
      case 'variation':
      case 'nonconformity':
      case 'minute': {
        const anchor = await resolveObject(objectType, objectId);
        return anchor?.projectId ? isParticipant(anchor.projectId, orgId) : false;
      }
      case 'contract':
        return contractParty(objectId, orgId);
      case 'change_order': {
        const { rows } = await pool.query('SELECT contract_id FROM contracting.change_order WHERE id = $1', [objectId]);
        return rows.length ? contractParty(rows[0].contract_id, orgId) : false;
      }
      case 'measurement': {
        const { rows } = await pool.query('SELECT contract_id FROM contracting.measurement WHERE id = $1', [objectId]);
        return rows.length ? contractParty(rows[0].contract_id, orgId) : false;
      }
      case 'rfp': {
        const { rows } = await pool.query(
          `SELECT 1 FROM tendering.rfp r
            WHERE r.id = $1 AND (r.issuer_org_id = $2
               OR EXISTS (SELECT 1 FROM tendering.rfp_recipient rc
                           WHERE rc.rfp_id = r.id AND rc.org_id = $2))`,
          [objectId, orgId],
        );
        return rows.length > 0;
      }
      case 'proposal': {
        const { rows } = await pool.query(
          `SELECT 1 FROM tendering.proposal p JOIN tendering.rfp r ON r.id = p.rfp_id
            WHERE p.id = $1 AND (p.bidder_org_id = $2 OR r.issuer_org_id = $2)`,
          [objectId, orgId],
        );
        return rows.length > 0;
      }
      case 'document': {
        const { rows } = await pool.query('SELECT scope_type, scope_id FROM documents.document WHERE id = $1', [objectId]);
        if (!rows.length) return false;
        const { scope_type: st, scope_id: si } = rows[0];
        if (st === 'profile') return true;
        // One level of indirection, same rules — a document never scopes to
        // another document.
        return canReadObject({ objectType: st === 'location' ? 'project' : st, objectId: si, orgId });
      }
      default:
        return false;
    }
  }

  return {
    resolveObject,
    canReadObject,
    isParticipant,

    // ── identity guards ────────────────────────────────────────────────────
    async getPersonByClerkId(clerkUserId) {
      const { rows } = await pool.query('SELECT * FROM identity.person WHERE clerk_user_id = $1', [clerkUserId]);
      return rows[0] ?? null;
    },

    async isStaffed(projectId, orgId, personId) {
      const { rows } = await pool.query(
        'SELECT 1 FROM identity.project_staffing WHERE project_id = $1 AND org_id = $2 AND person_id = $3',
        [projectId, orgId, personId],
      );
      return rows.length > 0;
    },

    /**
     * The project's variation subscriptions (doc 08) — collaboration's own
     * table. WHO a variation concerns comes from planning's audience port and
     * WHICH PEOPLE from identity's; this only narrows / extends by kind.
     */
    async variationSubscriptions(projectId) {
      const { rows } = await pool.query(
        'SELECT org_id, kinds FROM collaboration.variation_subscription WHERE project_id = $1',
        [projectId],
      );
      return rows;
    },

    // ── comments & questions ───────────────────────────────────────────────
    async getComment(commentId) {
      const { rows } = await pool.query(
        `SELECT c.*, t.object_type, t.object_id, t.project_id
           FROM collaboration.comment c JOIN collaboration.thread t ON t.id = c.thread_id
          WHERE c.id = $1`,
        [commentId],
      );
      return rows[0] ?? null;
    },

    async listComments({ objectType, objectId, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT c.*, t.object_type, t.object_id
           FROM collaboration.comment c JOIN collaboration.thread t ON t.id = c.thread_id
          WHERE t.object_type = $1 AND t.object_id = $2
            AND ($3::uuid IS NULL OR c.id > $3)
          ORDER BY c.created_at, c.id
          LIMIT $4`,
        [objectType, objectId, cursor, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },

    /** The addressee's question queue (D-13: the owner's dispute channel). */
    async listMyQuestions({ orgId, status, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT c.*, t.object_type, t.object_id
           FROM collaboration.comment c JOIN collaboration.thread t ON t.id = c.thread_id
          WHERE c.kind = 'question' AND c.addressee_org_id = $1
            AND ($2::text IS NULL OR c.question_status = $2)
            AND ($3::uuid IS NULL OR c.id > $3)
          ORDER BY c.created_at, c.id
          LIMIT $4`,
        [orgId, status, cursor, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },

    /**
     * Note: plain insert. Question: + ledger `collaboration.question.opened`
     * + outbox, one transaction. The thread row is found-or-created here —
     * UNIQUE(object_type, object_id) makes racers converge.
     */
    async createComment({ id, objectType, objectId, projectId, kind, body, mentions,
      attachmentDocumentIds, addresseeOrgId, actor }) {
      return tx(async (client) => {
        const { rows: [thread] } = await client.query(
          `INSERT INTO collaboration.thread (id, project_id, object_type, object_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (object_type, object_id) DO UPDATE SET object_type = EXCLUDED.object_type
           RETURNING id`,
          [randomUUID(), projectId, objectType, objectId],
        );
        const isQuestion = kind === 'question';
        const { rows } = await client.query(
          `INSERT INTO collaboration.comment
             (id, thread_id, author_person_id, author_org_id, kind, body, mentions,
              attachment_document_ids, addressee_org_id, question_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [id, thread.id, actor.personId, actor.orgId, kind, body, mentions,
            attachmentDocumentIds, addresseeOrgId, isQuestion ? 'open' : null],
        );
        const comment = { ...rows[0], object_type: objectType, object_id: objectId };
        if (isQuestion && projectId) {
          await appendAuditEvent(client, {
            projectId,
            actor,
            category: 'collaboration',
            type: 'collaboration.question.opened',
            scope: { type: 'project', id: projectId },
            object: { type: 'comment', id },
            payload: { object_type: objectType, object_id: objectId, addressee_org_id: addresseeOrgId },
            channel: actor.channel,
          });
          await publishEvent(client, {
            event_id: randomUUID(),
            type: 'collaboration.question.opened',
            project_id: projectId,
            actor: { person_id: actor.personId, org_id: actor.orgId },
            scope: { type: 'project', id: projectId },
            data: {
              comment_id: id,
              object_type: objectType,
              object_id: objectId,
              addressee_org_id: addresseeOrgId,
              asker_org_id: actor.orgId,
            },
          });
        }
        return comment;
      });
    },

    /**
     * Answer = the answer comment + the question's open → answered move in
     * ONE transaction; null when the question raced away from `open`.
     */
    async answerQuestion({ questionId, answerId, body, mentions, attachmentDocumentIds, projectId, actor }) {
      return tx(async (client) => {
        const { rows: moved } = await client.query(
          `UPDATE collaboration.comment SET question_status = 'answered'
            WHERE id = $1 AND kind = 'question' AND question_status = 'open'
            RETURNING thread_id, addressee_org_id, author_org_id, author_person_id`,
          [questionId],
        );
        if (!moved.length) return null;
        const q = moved[0];
        const { rows } = await client.query(
          `INSERT INTO collaboration.comment
             (id, thread_id, author_person_id, author_org_id, kind, body, mentions,
              attachment_document_ids, answers_comment_id)
           VALUES ($1,$2,$3,$4,'answer',$5,$6,$7,$8)
           RETURNING *`,
          [answerId, q.thread_id, actor.personId, actor.orgId, body, mentions,
            attachmentDocumentIds, questionId],
        );
        const { rows: [thread] } = await client.query(
          'SELECT object_type, object_id FROM collaboration.thread WHERE id = $1', [q.thread_id],
        );
        if (projectId) {
          await appendAuditEvent(client, {
            projectId,
            actor,
            category: 'collaboration',
            type: 'collaboration.question.answered',
            scope: { type: 'project', id: projectId },
            object: { type: 'comment', id: questionId },
            payload: { answer_comment_id: answerId },
            channel: actor.channel,
          });
          await publishEvent(client, {
            event_id: randomUUID(),
            type: 'collaboration.question.answered',
            project_id: projectId,
            actor: { person_id: actor.personId, org_id: actor.orgId },
            scope: { type: 'project', id: projectId },
            data: {
              comment_id: questionId,
              answer_comment_id: answerId,
              asker_org_id: q.author_org_id,
              asker_person_id: q.author_person_id,
            },
          });
        }
        return { ...rows[0], ...thread };
      });
    },

    /** answered → resolved; null when it raced away. */
    async resolveQuestion({ questionId, projectId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE collaboration.comment SET question_status = 'resolved'
            WHERE id = $1 AND kind = 'question' AND question_status = 'answered'
            RETURNING *`,
          [questionId],
        );
        if (!rows.length) return null;
        const { rows: [thread] } = await client.query(
          'SELECT object_type, object_id FROM collaboration.thread WHERE id = $1', [rows[0].thread_id],
        );
        if (projectId) {
          await appendAuditEvent(client, {
            projectId,
            actor,
            category: 'collaboration',
            type: 'collaboration.question.resolved',
            scope: { type: 'project', id: projectId },
            object: { type: 'comment', id: questionId },
            payload: {},
            channel: actor.channel,
          });
          await publishEvent(client, {
            event_id: randomUUID(),
            type: 'collaboration.question.resolved',
            project_id: projectId,
            actor: { person_id: actor.personId, org_id: actor.orgId },
            scope: { type: 'project', id: projectId },
            data: { comment_id: questionId, addressee_org_id: rows[0].addressee_org_id },
          });
        }
        return { ...rows[0], ...thread };
      });
    },

    // ── meeting minutes ────────────────────────────────────────────────────
    async getMinute(minuteId) {
      const { rows } = await pool.query('SELECT * FROM collaboration.meeting_minute WHERE id = $1', [minuteId]);
      return rows[0] ?? null;
    },

    async minuteParts(minuteId) {
      const [{ rows: items }, { rows: acks }] = await Promise.all([
        pool.query('SELECT * FROM collaboration.minute_item WHERE minute_id = $1 ORDER BY id', [minuteId]),
        pool.query('SELECT * FROM collaboration.minute_ack WHERE minute_id = $1 ORDER BY at', [minuteId]),
      ]);
      return { items, acks };
    },

    /** Draft — not yet part of the record (it becomes one ack by ack). */
    async createMinute({ id, projectId, date, attendees, items, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO collaboration.meeting_minute
             (id, project_id, date, attendees, created_by_org_id, created_by_person_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [id, projectId, date, attendees, actor.orgId, actor.personId],
        );
        for (const item of items) {
          await client.query(
            `INSERT INTO collaboration.minute_item (id, minute_id, text, owner_org_id, due_date, object_type, object_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [randomUUID(), id, item.text, item.owner_org_id ?? null, item.due_date ?? null,
              item.object_type ?? null, item.object_id ?? null],
          );
        }
        return rows[0];
      });
    },

    /** draft → circulated; null when it raced away. */
    async circulateMinute({ minuteId }) {
      const { rows } = await pool.query(
        `UPDATE collaboration.meeting_minute SET status = 'circulated'
          WHERE id = $1 AND status = 'draft' RETURNING *`,
        [minuteId],
      );
      return rows[0] ?? null;
    },

    /**
     * One org's acknowledgement: ack row (PK absorbs replays) + ledger +
     * outbox `collaboration.minute.acknowledged`; flips the minute to
     * `acknowledged` when every attendee org has acked (doc 09).
     */
    async acknowledgeMinute({ minuteId, projectId, actor }) {
      return tx(async (client) => {
        const { rows: inserted } = await client.query(
          `INSERT INTO collaboration.minute_ack (minute_id, org_id, person_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (minute_id, org_id) DO NOTHING
           RETURNING minute_id`,
          [minuteId, actor.orgId, actor.personId],
        );
        if (inserted.length) {
          await appendAuditEvent(client, {
            projectId,
            actor,
            category: 'collaboration',
            type: 'collaboration.minute.acknowledged',
            scope: { type: 'project', id: projectId },
            object: { type: 'minute', id: minuteId },
            payload: { org_id: actor.orgId },
            channel: actor.channel,
          });
          await publishEvent(client, {
            event_id: randomUUID(),
            type: 'collaboration.minute.acknowledged',
            project_id: projectId,
            actor: { person_id: actor.personId, org_id: actor.orgId },
            scope: { type: 'project', id: projectId },
            data: { minute_id: minuteId, org_id: actor.orgId },
          });
        }
        const { rows } = await client.query(
          `UPDATE collaboration.meeting_minute m SET status = 'acknowledged'
            WHERE m.id = $1 AND m.status = 'circulated'
              AND NOT EXISTS (
                SELECT 1 FROM unnest(m.attendees) AS a(org_id)
                 WHERE NOT EXISTS (SELECT 1 FROM collaboration.minute_ack k
                                    WHERE k.minute_id = m.id AND k.org_id = a.org_id))
            RETURNING *`,
          [minuteId],
        );
        if (rows.length) return rows[0];
        const { rows: current } = await client.query(
          'SELECT * FROM collaboration.meeting_minute WHERE id = $1', [minuteId],
        );
        return current[0];
      });
    },

    // ── activity feed (projection of platform.outbox, doc 08) ─────────────
    /**
     * Viewer-filtered: project-scoped events for any participant; contract-
     * scoped only for that contract's parties; private scopes only for the
     * acting org itself. Keyset on (occurred_at, event_id).
     */
    async listActivity({ projectId, orgId, cursor, since, limit }) {
      const [cursorAt, cursorId] = cursor ? cursor.split('~') : [null, null];
      const { rows } = await pool.query(
        `SELECT event_id, type, occurred_at, actor, scope, data
           FROM platform.outbox o
          WHERE o.project_id = $1
            AND ($4::timestamptz IS NULL OR o.occurred_at >= $4)
            AND ($5::timestamptz IS NULL OR (o.occurred_at, o.event_id) > ($5, $6::uuid))
            AND (
              o.scope->>'type' = 'project'
              OR (o.scope->>'type' = 'contract' AND EXISTS (
                    SELECT 1 FROM contracting.contract c
                     WHERE c.id = (o.scope->>'id')::uuid
                       AND (c.client_org_id = $2 OR c.supplier_org_id = $2)))
              OR o.actor->>'org_id' = $3
            )
          ORDER BY o.occurred_at, o.event_id
          LIMIT $7`,
        [projectId, orgId, orgId, since, cursorAt, cursorId ?? null, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: rows.length > limit ? `${last.occurred_at.toISOString()}~${last.event_id}` : null,
      };
    },

    // Notifications, preferences and the variation digest (PRD-12) —
    // infra/pg-notifications.mjs, spread so callers still see ONE store.
    ...notificationQueries(pool, tx),
  };
}
