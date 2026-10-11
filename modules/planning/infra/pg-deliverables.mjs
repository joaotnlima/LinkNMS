// Postgres part of the planning store for deliverables (PRD-05, D-48). Spread
// into createPlanningStore's object. Every write ledgers in its transaction
// (invariant §6.4); submissions and decisions also publish their
// planning.deliverable.* event on the same client (doc 10).
//
// Writes on one deliverable serialise on its row (SELECT … FOR UPDATE): the
// seq of a submission, "only the latest submitted one is decided" and the
// supersede of a pending one are decided under that lock.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';

const projectScope = (projectId) => ({ type: 'project', id: projectId });

function eventOf({ projectId, actor, type, data }) {
  return {
    event_id: randomUUID(),
    type,
    project_id: projectId,
    actor: { person_id: actor.personId ?? null, org_id: actor.orgId ?? null },
    scope: projectScope(projectId),
    data,
  };
}

async function ledger(client, { projectId, actor, type, objectId, payload }) {
  await appendAuditEvent(client, {
    projectId,
    actor,
    category: 'planning',
    type,
    scope: projectScope(projectId),
    object: { type: 'deliverable', id: objectId },
    payload,
    channel: actor.channel ?? 'ui',
  });
}

async function withSubmissions(q, rows) {
  if (!rows.length) return [];
  const { rows: subs } = await q.query(
    'SELECT * FROM planning.deliverable_submission WHERE deliverable_id = ANY($1::uuid[]) ORDER BY deliverable_id, seq',
    [rows.map((r) => r.id)],
  );
  const by = new Map(rows.map((r) => [r.id, []]));
  for (const s of subs) by.get(s.deliverable_id)?.push(s);
  return rows.map((r) => ({ ...r, submissions: by.get(r.id) ?? [] }));
}

/** Supersede a pending submission and append the next one; ledger + event. */
async function appendSubmissionOn(client, { deliverable, facts, note, actor }) {
  await client.query(
    `UPDATE planning.deliverable_submission SET status = 'superseded'
      WHERE deliverable_id = $1 AND status = 'submitted'`,
    [deliverable.id],
  );
  const { rows: [sub] } = await client.query(
    `INSERT INTO planning.deliverable_submission
       (id, deliverable_id, seq, document_id, version_no, sha256, file_title, mime, note,
        submitted_by_person_id, submitted_by_org_id)
     SELECT $1, $2, coalesce(max(seq), 0) + 1, $3, $4, $5, $6, $7, $8, $9, $10
       FROM planning.deliverable_submission WHERE deliverable_id = $2
     RETURNING *`,
    [randomUUID(), deliverable.id, facts.document_id, facts.version_no, facts.sha256, facts.title, facts.mime,
      note, actor.personId, actor.orgId],
  );
  const data = {
    deliverable_id: deliverable.id, task_id: deliverable.task_id, title: deliverable.title,
    submission_id: sub.id, document_id: sub.document_id, version_no: sub.version_no, sha256: sub.sha256,
    submitted_by_org_id: sub.submitted_by_org_id,
  };
  await ledger(client, { projectId: deliverable.project_id, actor, type: 'planning.deliverable.submitted', objectId: deliverable.id, payload: data });
  await publishEvent(client, eventOf({ projectId: deliverable.project_id, actor, type: 'planning.deliverable.submitted', data }));
  return sub;
}

/** @param {import('pg').Pool} pool @param {(fn: Function) => Promise<any>} tx */
export function deliverableQueries(pool, tx) {
  async function lockDeliverable(client, id) {
    const { rows } = await client.query(
      'SELECT * FROM planning.deliverable WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id],
    );
    return rows[0] ?? null;
  }

  return {
    /** Live descendants of a row (the planning task port, PRD-05 F-10). */
    async descendantTaskIds(taskId) {
      const { rows } = await pool.query(
        `WITH RECURSIVE down AS (
           SELECT id FROM planning.task WHERE parent_id = $1 AND deleted_at IS NULL
           UNION ALL
           SELECT t.id FROM planning.task t JOIN down ON t.parent_id = down.id WHERE t.deleted_at IS NULL
         ) SELECT id FROM down`,
        [taskId],
      );
      return rows.map((r) => r.id);
    },

    /** Every live row of a build (the task port's taskIdsOf). */
    async liveTaskIds(projectId) {
      const { rows } = await pool.query(
        'SELECT id FROM planning.task WHERE project_id = $1 AND deleted_at IS NULL', [projectId],
      );
      return rows.map((r) => r.id);
    },

    /** Live deliverables of one task or one project, with their submissions. */
    async listDeliverables({ taskId = null, projectId = null }) {
      const { rows } = await pool.query(
        `SELECT * FROM planning.deliverable
          WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR task_id = $1) AND ($2::uuid IS NULL OR project_id = $2)
          ORDER BY task_id, position, created_at, id`,
        [taskId, projectId],
      );
      return withSubmissions(pool, rows);
    },

    async getDeliverable(id) {
      const { rows } = await pool.query('SELECT * FROM planning.deliverable WHERE id = $1 AND deleted_at IS NULL', [id]);
      return (await withSubmissions(pool, rows))[0] ?? null;
    },

    /** Create (idempotent on id): returns {deliverable, created}. */
    async insertDeliverable({ id, projectId, taskId, title, required, due, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO planning.deliverable
             (id, project_id, task_id, title, required, due, position, created_by_org_id, created_by_person_id)
           SELECT $1, $2, $3, $4, $5, $6, coalesce(max(position), 0) + 1, $7, $8
             FROM planning.deliverable WHERE task_id = $3
           ON CONFLICT (id) DO NOTHING RETURNING *`,
          [id, projectId, taskId, title, required, due, actor.orgId, actor.personId],
        );
        if (!rows.length) {
          const { rows: existing } = await client.query('SELECT * FROM planning.deliverable WHERE id = $1', [id]);
          return { deliverable: (await withSubmissions(client, existing))[0] ?? null, created: false };
        }
        await ledger(client, {
          projectId, actor, type: 'planning.deliverable.created', objectId: id,
          payload: { task_id: taskId, title, required, due },
        });
        return { deliverable: { ...rows[0], submissions: [] }, created: true };
      });
    },

    async patchDeliverable({ id, patch, actor }) {
      return tx(async (client) => {
        const current = await lockDeliverable(client, id);
        if (!current) return null;
        const next = { ...current, ...patch };
        await client.query(
          'UPDATE planning.deliverable SET title = $2, required = $3, due = $4 WHERE id = $1',
          [id, next.title, next.required, next.due],
        );
        await ledger(client, {
          projectId: current.project_id, actor, type: 'planning.deliverable.updated', objectId: id,
          payload: { task_id: current.task_id, changes: patch },
        });
        const { rows } = await client.query('SELECT * FROM planning.deliverable WHERE id = $1', [id]);
        return (await withSubmissions(client, rows))[0];
      });
    },

    async removeDeliverable({ id, actor }) {
      return tx(async (client) => {
        const current = await lockDeliverable(client, id);
        if (!current) return null;
        await client.query('UPDATE planning.deliverable SET deleted_at = now() WHERE id = $1', [id]);
        await ledger(client, {
          projectId: current.project_id, actor, type: 'planning.deliverable.removed', objectId: id,
          payload: { task_id: current.task_id, title: current.title },
        });
        return current;
      });
    },

    /** Submit a proven document version (facts from the documents port). */
    async submitDeliverable({ id, facts, note, actor }) {
      return tx(async (client) => {
        const deliverable = await lockDeliverable(client, id);
        if (!deliverable) return null;
        await appendSubmissionOn(client, { deliverable, facts, note, actor });
        const { rows } = await client.query('SELECT * FROM planning.deliverable WHERE id = $1', [id]);
        return (await withSubmissions(client, rows))[0];
      });
    },

    /**
     * Decide the latest submission. Answers {deliverable} or {conflict} when
     * the submission is no longer the pending latest one (someone was first).
     */
    async decideDeliverable({ id, submissionId, status, comment, actor }) {
      return tx(async (client) => {
        const deliverable = await lockDeliverable(client, id);
        if (!deliverable) return null;
        const { rows: [latest] } = await client.query(
          'SELECT * FROM planning.deliverable_submission WHERE deliverable_id = $1 ORDER BY seq DESC LIMIT 1', [id],
        );
        if (!latest || latest.id !== submissionId || latest.status !== 'submitted') return { conflict: true };
        await client.query(
          `UPDATE planning.deliverable_submission
              SET status = $2, decided_by_person_id = $3, decided_by_org_id = $4, decided_at = now(), decision_comment = $5
            WHERE id = $1`,
          [submissionId, status, actor.personId, actor.orgId, comment],
        );
        const type = status === 'approved' ? 'planning.deliverable.approved' : 'planning.deliverable.changes_requested';
        const data = {
          deliverable_id: id, task_id: deliverable.task_id, title: deliverable.title,
          submission_id: submissionId, document_id: latest.document_id, version_no: latest.version_no,
          sha256: latest.sha256, submitted_by_org_id: latest.submitted_by_org_id,
          decided_by_org_id: actor.orgId, decided_by_person_id: actor.personId,
          ...(comment ? { comment } : {}),
        };
        await ledger(client, { projectId: deliverable.project_id, actor, type, objectId: id, payload: data });
        await publishEvent(client, eventOf({ projectId: deliverable.project_id, actor, type, data }));
        const { rows } = await client.query('SELECT * FROM planning.deliverable WHERE id = $1', [id]);
        return { deliverable: (await withSubmissions(client, rows))[0] };
      });
    },

    /** Consumer of tendering.rfp.awarded (design): required deliverables, once. */
    async seedDeliverables({ projectId, taskId, rfpId, titles, actor }) {
      return tx(async (client) => {
        const { rows: task } = await client.query(
          'SELECT 1 FROM planning.task WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL', [taskId, projectId],
        );
        if (!task.length) return [];
        const created = [];
        for (const title of titles) {
          const { rows } = await client.query(
            `INSERT INTO planning.deliverable
               (id, project_id, task_id, title, required, source_rfp_id, position, created_by_org_id, created_by_person_id)
             SELECT $1, $2, $3, $4, true, $5, coalesce(max(position), 0) + 1, $6, $7
               FROM planning.deliverable WHERE task_id = $3
             ON CONFLICT (task_id, source_rfp_id, title) WHERE source_rfp_id IS NOT NULL DO NOTHING
             RETURNING id, title`,
            [randomUUID(), projectId, taskId, title, rfpId, actor.orgId, actor.personId],
          );
          if (rows.length) created.push(rows[0]);
        }
        if (created.length) {
          await ledger(client, {
            projectId, actor, type: 'planning.deliverable.seeded', objectId: created[0].id,
            payload: { task_id: taskId, rfp_id: rfpId, titles: created.map((c) => c.title) },
          });
        }
        return created;
      });
    },

    /**
     * Consumer of documents.version.uploaded (F-15): every live deliverable
     * whose latest submission is this document at an OLDER version gets the
     * new version submitted (back to review), by the uploader. Idempotent: a
     * replay finds the latest already at this version.
     */
    async resubmitForNewVersion({ projectId, facts, note, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `SELECT d.* FROM planning.deliverable d
             JOIN LATERAL (SELECT document_id, version_no FROM planning.deliverable_submission s
                            WHERE s.deliverable_id = d.id ORDER BY seq DESC LIMIT 1) last ON true
            WHERE d.project_id = $1 AND d.deleted_at IS NULL
              AND last.document_id = $2 AND last.version_no < $3
            ORDER BY d.id FOR UPDATE OF d`,
          [projectId, facts.document_id, facts.version_no],
        );
        const out = [];
        for (const deliverable of rows) {
          out.push(await appendSubmissionOn(client, { deliverable, facts, note, actor }));
        }
        return out;
      });
    },
  };
}
