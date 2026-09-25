// Postgres store for the planning module (schema: planning.*, db/v2 0001).
//
// Owns its transactions. A plan write runs under ONE per-project advisory
// lock (plan writes serialize per project — propagation must see a settled
// plan), and every write appends its ledger entry AND publishes its domain
// events on the SAME client before commit (invariants §6.3/§6.4).
// Cross-schema READS (project for guards + calendar, identity for actors,
// contracting for the contract chain, BoQ and tendered roots) are query
// ports; it never WRITES outside planning.* + ledger + outbox.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';
import { withIdempotency } from '../../../platform/idempotency.mjs';

const D = (col) => `to_char(${col}, 'YYYY-MM-DD')`;
const TASK_SELECT = `
  SELECT id, project_id, parent_id, depth, position, kind, name, description,
         specialty, location_id, contract_id, branch_contract_id,
         assignee_org_id, assignee_person_id, assignee_inherited, dating_mode,
         ${D('start')} AS start, ${D('finish')} AS finish, duration_wd,
         ${D('actual_start')} AS actual_start, ${D('actual_finish')} AS actual_finish,
         acceptance_criteria, ${D('baseline_start')} AS baseline_start,
         ${D('baseline_finish')} AS baseline_finish, schedule_state,
         last_changed_by_person_id, last_changed_by_org_id, last_changed_at,
         last_change_cause, deleted_at
    FROM planning.task`;

const TASK_COLS = {
  parentId: 'parent_id', depth: 'depth', position: 'position', kind: 'kind',
  name: 'name', description: 'description', specialty: 'specialty',
  locationId: 'location_id', contractId: 'contract_id', branchContractId: 'branch_contract_id',
  assigneeOrgId: 'assignee_org_id', assigneePersonId: 'assignee_person_id',
  assigneeInherited: 'assignee_inherited', datingMode: 'dating_mode',
  start: 'start', finish: 'finish', durationWd: 'duration_wd',
  actualStart: 'actual_start', actualFinish: 'actual_finish',
  acceptanceCriteria: 'acceptance_criteria', baselineStart: 'baseline_start',
  baselineFinish: 'baseline_finish', scheduleState: 'schedule_state',
  lastChangedByPersonId: 'last_changed_by_person_id', lastChangedByOrgId: 'last_changed_by_org_id',
  lastChangedAt: 'last_changed_at', lastChangeCause: 'last_change_cause',
};

function taskN(r) {
  return {
    id: r.id, projectId: r.project_id, parentId: r.parent_id, depth: r.depth,
    position: r.position, kind: r.kind, name: r.name, description: r.description,
    specialty: r.specialty, locationId: r.location_id, contractId: r.contract_id,
    branchContractId: r.branch_contract_id, assigneeOrgId: r.assignee_org_id,
    assigneePersonId: r.assignee_person_id, assigneeInherited: r.assignee_inherited,
    datingMode: r.dating_mode, start: r.start, finish: r.finish, durationWd: r.duration_wd,
    actualStart: r.actual_start, actualFinish: r.actual_finish,
    acceptanceCriteria: r.acceptance_criteria, baselineStart: r.baseline_start,
    baselineFinish: r.baseline_finish, baselineVersion: r.baseline_version ?? null,
    scheduleState: r.schedule_state, lastChangedByPersonId: r.last_changed_by_person_id,
    lastChangedByOrgId: r.last_changed_by_org_id,
    lastChangedAt: r.last_changed_at?.toISOString?.() ?? r.last_changed_at,
    lastChangeCause: r.last_change_cause, deletedAt: r.deleted_at,
  };
}

function linkN(r) {
  return {
    id: r.id, projectId: r.project_id, predecessorId: r.predecessor_id,
    successorId: r.successor_id, fromAnchor: r.from_anchor, toAnchor: r.to_anchor,
    lagWd: r.lag_wd, createdByOrgId: r.created_by_org_id, createdByPersonId: r.created_by_person_id,
  };
}

export function createPlanningStore(pool) {
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

  /** The whole plan on one client — every write and read starts here. */
  async function loadPlanOn(q, projectId) {
    const [{ rows: taskRows }, { rows: linkRows }, { rows: projectRows }] = await Promise.all([
      q.query(`${TASK_SELECT} WHERE project_id = $1 AND deleted_at IS NULL ORDER BY position`, [projectId]),
      q.query('SELECT * FROM planning.link WHERE project_id = $1', [projectId]),
      q.query('SELECT owner_org_id, created_by_org_id, municipality_code FROM project.project WHERE id = $1', [projectId]),
    ]);
    const project = projectRows[0] ?? {};
    const [{ rows: calRows }, { rows: holidayRows }, { rows: contractRows }, { rows: statusRows },
      { rows: costedRows }, { rows: orgRows }] = await Promise.all([
      q.query('SELECT work_days, closures FROM project.calendar WHERE project_id = $1', [projectId]),
      q.query(
        `SELECT ${D('date')} AS date, name FROM platform.holiday WHERE scope = 'national' OR scope = $1 ORDER BY date`,
        [project.municipality_code ?? ''],
      ),
      q.query(
        'SELECT id, supplier_org_id, client_org_id, parent_contract_id FROM contracting.contract WHERE project_id = $1',
        [projectId],
      ),
      q.query(
        `SELECT DISTINCT ON (task_id) task_id, status
           FROM planning.progress_report p
           JOIN planning.task t ON t.id = p.task_id
          WHERE t.project_id = $1
          ORDER BY task_id, seq DESC`,
        [projectId],
      ),
      q.query(
        `SELECT DISTINCT task_id FROM contracting.boq_item
          WHERE project_id = $1 AND task_id IS NOT NULL AND superseded_by_change_order_id IS NULL`,
        [projectId],
      ),
      q.query(
        `SELECT DISTINCT o.id, o.legal_name FROM identity.organization o
           JOIN planning.task t ON t.assignee_org_id = o.id
          WHERE t.project_id = $1`,
        [projectId],
      ),
    ]);
    const cal = calRows[0] ?? { work_days: [1, 2, 3, 4, 5], closures: [] };
    return {
      tasks: new Map(taskRows.map((r) => [r.id, taskN(r)])),
      links: linkRows.map(linkN),
      calendarRaw: {
        work_days: cal.work_days,
        closures: (cal.closures ?? []).map(({ from, to }) => ({ from, to })),
        holidays: holidayRows,
      },
      contracts: new Map(contractRows.map((r) => [r.id, {
        supplierOrgId: r.supplier_org_id, clientOrgId: r.client_org_id, parentContractId: r.parent_contract_id,
      }])),
      ownerOrgId: project.owner_org_id ?? project.created_by_org_id ?? null,
      statuses: new Map(statusRows.map((r) => [r.task_id, r.status])),
      orgNames: new Map(orgRows.map((r) => [r.id, r.legal_name])),
      costedTaskIds: new Set(costedRows.map((r) => r.task_id)),
    };
  }

  function writersOn(client) {
    return {
      insertTask: (t) => client.query(
        `INSERT INTO planning.task
           (id, project_id, parent_id, depth, position, kind, name, description, specialty,
            location_id, contract_id, branch_contract_id, assignee_org_id, assignee_person_id,
            assignee_inherited, dating_mode, start, finish, duration_wd, actual_start,
            actual_finish, acceptance_criteria, schedule_state, last_changed_by_person_id,
            last_changed_by_org_id, last_changed_at, last_change_cause)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,now(),$26)`,
        [
          t.id, t.projectId, t.parentId, t.depth, t.position, t.kind, t.name, t.description,
          t.specialty, t.locationId, t.contractId, t.branchContractId, t.assigneeOrgId,
          t.assigneePersonId, t.assigneeInherited, t.datingMode, t.start, t.finish, t.durationWd,
          t.actualStart, t.actualFinish, t.acceptanceCriteria, t.scheduleState,
          t.lastChangedByPersonId, t.lastChangedByOrgId, t.lastChangeCause,
        ],
      ),
      patchTask: (id, patch) => {
        const sets = [];
        const values = [id];
        for (const [key, value] of Object.entries(patch)) {
          const col = TASK_COLS[key];
          if (!col) continue;
          values.push(key === 'lastChangedAt' ? new Date(value) : value);
          sets.push(`"${col}" = $${values.length}`);
        }
        if (!sets.length) return Promise.resolve();
        return client.query(`UPDATE planning.task SET ${sets.join(', ')} WHERE id = $1`, values);
      },
      softDelete: (id) => client.query('UPDATE planning.task SET deleted_at = now() WHERE id = $1', [id]),
      fieldChange: (fc) => client.query(
        `INSERT INTO planning.task_field_change
           (task_id, field, old_value, new_value, base_value, changed_by_person_id,
            changed_by_org_id, cause, channel, cause_task_id, client_change_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (client_change_id, task_id, field) DO NOTHING`,
        [
          fc.taskId, fc.field, JSON.stringify(fc.oldValue ?? null), JSON.stringify(fc.newValue ?? null),
          JSON.stringify(fc.baseValue ?? null), fc.changedByPersonId, fc.changedByOrgId,
          fc.cause, fc.channel ?? 'ui', fc.causeTaskId, fc.clientChangeId,
        ],
      ),
      insertLink: (l) => client.query(
        `INSERT INTO planning.link
           (id, project_id, predecessor_id, successor_id, from_anchor, to_anchor, lag_wd,
            created_by_org_id, created_by_person_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [l.id, l.projectId, l.predecessorId, l.successorId, l.fromAnchor, l.toAnchor, l.lagWd,
          l.createdByOrgId, l.createdByPersonId],
      ),
      patchLink: (id, patch) => {
        const cols = { fromAnchor: 'from_anchor', toAnchor: 'to_anchor', lagWd: 'lag_wd' };
        const sets = [];
        const values = [id];
        for (const [key, value] of Object.entries(patch)) {
          if (!cols[key]) continue;
          values.push(value);
          sets.push(`${cols[key]} = $${values.length}`);
        }
        if (!sets.length) return Promise.resolve();
        return client.query(`UPDATE planning.link SET ${sets.join(', ')} WHERE id = $1`, values);
      },
      removeLink: (id) => client.query('DELETE FROM planning.link WHERE id = $1', [id]),
      ledger: (entry) => appendAuditEvent(client, entry),
      publish: (evt) => publishEvent(client, evt),
    };
  }

  return {
    // ── plain reads ────────────────────────────────────────────────────────
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

    async getTask(taskId) {
      const { rows } = await pool.query(`${TASK_SELECT} WHERE id = $1`, [taskId]);
      return rows.length ? taskN(rows[0]) : null;
    },

    async getLink(linkId) {
      const { rows } = await pool.query('SELECT * FROM planning.link WHERE id = $1', [linkId]);
      return rows.length ? linkN(rows[0]) : null;
    },

    async loadPlan(projectId) {
      return loadPlanOn(pool, projectId);
    },

    async listFieldChanges(taskId) {
      const { rows } = await pool.query(
        `SELECT field, old_value, new_value, changed_by_person_id, changed_by_org_id,
                changed_at, cause, cause_task_id
           FROM planning.task_field_change WHERE task_id = $1 ORDER BY id`,
        [taskId],
      );
      return rows.map((r) => ({
        field: r.field, oldValue: r.old_value, newValue: r.new_value,
        changedByPersonId: r.changed_by_person_id, changedByOrgId: r.changed_by_org_id,
        changedAt: r.changed_at.toISOString(), cause: r.cause, causeTaskId: r.cause_task_id,
      }));
    },

    async listProgress(taskId) {
      const { rows } = await pool.query(
        'SELECT * FROM planning.progress_report WHERE task_id = $1 ORDER BY seq',
        [taskId],
      );
      return rows.map((r) => ({
        taskId: r.task_id, seq: r.seq, status: r.status, percent: r.percent, note: r.note,
        reportedByOrgId: r.reported_by_org_id, reportedByPersonId: r.reported_by_person_id,
        reportedAt: r.reported_at.toISOString(),
      }));
    },

    async idempotent({ key, caller, operationId, body }, fn) {
      if (!key) return fn();
      return tx(async (client) => {
        const { replayed, status, body: result } = await withIdempotency(
          client, { key, caller, operationId, body },
          async () => {
            const r = await fn();
            return { status: r.status, body: r.body };
          },
        );
        return { status, body: result, replayed };
      });
    },

    /**
     * One plan transaction: per-project advisory lock (plan writes serialize
     * — propagation must run against a settled plan), snapshot, writers.
     */
    async withPlanTx(projectId, fn, { dryRun = false } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${projectId}`]);
        const plan = await loadPlanOn(client, projectId);
        plan.hasChange = async (clientChangeId) => {
          const { rows } = await client.query(
            'SELECT 1 FROM planning.task_field_change WHERE client_change_id = $1 LIMIT 1',
            [clientChangeId],
          );
          return rows.length > 0;
        };
        plan.write = writersOn(client);
        const result = await fn(plan);
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    /**
     * Consumer of contracting.contract.signed (doc 05 §5, doc 10): bind the
     * tendered roots, stamp the branch, take baseline v1. Idempotent — the
     * (contract_id, version) unique key absorbs at-least-once delivery.
     */
    async bindSignedContract({ contractId, projectId, actor }) {
      return tx(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${projectId}`]);
        const { rows: existing } = await client.query(
          'SELECT 1 FROM planning.baseline WHERE contract_id = $1 AND version = 1', [contractId],
        );
        if (existing.length) return { bound: false, reason: 'already baselined' };
        const { rows: rootRows } = await client.query(
          'SELECT task_id FROM contracting.contract_root WHERE contract_id = $1', [contractId],
        );
        const roots = rootRows.map((r) => r.task_id);
        if (!roots.length) return { bound: false, reason: 'no tendered roots recorded' };

        await client.query(
          'UPDATE planning.task SET contract_id = $1 WHERE id = ANY($2::uuid[])',
          [contractId, roots],
        );
        // The branch: the roots and everything under them, stopping at rows
        // bound to their own (deeper) contract.
        const { rows: branchRows } = await client.query(
          `WITH RECURSIVE branch AS (
             SELECT id FROM planning.task WHERE id = ANY($1::uuid[])
             UNION ALL
             SELECT t.id FROM planning.task t
               JOIN branch b ON t.parent_id = b.id
              WHERE t.contract_id IS NULL AND t.deleted_at IS NULL
           ) SELECT id FROM branch`,
          [roots],
        );
        const branchIds = branchRows.map((r) => r.id);
        await client.query(
          'UPDATE planning.task SET branch_contract_id = $1 WHERE id = ANY($2::uuid[])',
          [contractId, branchIds],
        );

        const baselineId = randomUUID();
        await client.query(
          `INSERT INTO planning.baseline (id, project_id, contract_id, version, reason)
           VALUES ($1, $2, $3, 1, 'contract_signed')`,
          [baselineId, projectId, contractId],
        );
        await client.query(
          'INSERT INTO planning.baseline_root (baseline_id, task_id) SELECT $1, unnest($2::uuid[])',
          [baselineId, roots],
        );
        await client.query(
          `INSERT INTO planning.baseline_task
             (baseline_id, task_id, start, finish, duration_wd, name, scope_text, acceptance_criteria)
           SELECT $1, id, start, finish, duration_wd, name, description, acceptance_criteria
             FROM planning.task WHERE id = ANY($2::uuid[])`,
          [baselineId, branchIds],
        );
        await client.query(
          `INSERT INTO planning.baseline_cost_line (baseline_id, boq_item_id, quantity, unit_price_cents, material_spec)
           SELECT $1, id, quantity, unit_price_cents, material_spec
             FROM contracting.boq_item
            WHERE contract_id = $2 AND superseded_by_change_order_id IS NULL`,
          [baselineId, contractId],
        );
        await client.query(
          `UPDATE planning.task
              SET baseline_start = start, baseline_finish = finish, schedule_state = 'on_baseline'
            WHERE id = ANY($1::uuid[])`,
          [branchIds],
        );

        await appendAuditEvent(client, {
          projectId,
          actor: { personId: actor?.personId ?? null, orgId: actor?.orgId ?? null },
          category: 'planning',
          type: 'planning.baseline.taken',
          scope: { type: 'project', id: projectId },
          object: { type: 'baseline', id: baselineId },
          payload: { contract_id: contractId, version: 1, roots, rows: branchIds.length },
          channel: 'system',
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'planning.baseline.taken',
          version: 1,
          project_id: projectId,
          actor: { person_id: actor?.personId ?? null, org_id: actor?.orgId ?? null },
          scope: { type: 'project', id: projectId },
          data: { baseline_id: baselineId, contract_id: contractId, version: 1, root_task_ids: roots },
        });
        return { bound: true, baselineId, rows: branchIds.length };
      });
    },
  };
}
