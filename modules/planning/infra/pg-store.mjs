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

function variationN(r) {
  return {
    id: r.id, projectId: r.project_id, taskId: r.task_id, kind: r.kind,
    scopeType: r.scope_type, scopeId: r.scope_id,
    baselineValue: r.baseline_value, currentValue: r.current_value, delta: r.delta,
    cause: r.cause, causeTaskId: r.cause_task_id,
    firstChangedAt: r.first_changed_at?.toISOString?.() ?? r.first_changed_at,
    lastChangedAt: r.last_changed_at?.toISOString?.() ?? r.last_changed_at,
    lastChangedByOrgId: r.last_changed_by_org_id,
    status: r.status, changeOrderId: r.change_order_id,
    taskName: r.task_name ?? undefined,
  };
}

function costLineN(r) {
  return {
    id: r.id, projectId: r.project_id, contractId: r.contract_id,
    estimateOwnerOrgId: r.estimate_owner_org_id, taskId: r.task_id,
    code: r.code, description: r.description, unit: r.unit,
    quantity: r.quantity, unitPriceCents: Number(r.unit_price_cents),
    materialSpec: r.material_spec,
    introducedByChangeOrderId: r.introduced_by_change_order_id,
    supersededByChangeOrderId: r.superseded_by_change_order_id,
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
      { rows: lineRows }, { rows: orgRows }, { rows: variationRows }, { rows: baselineRows },
      { rows: baselineTextRows }] = await Promise.all([
      q.query('SELECT work_days, closures FROM project.calendar WHERE project_id = $1', [projectId]),
      q.query(
        `SELECT ${D('date')} AS date, name FROM platform.holiday WHERE scope = 'national' OR scope = $1 ORDER BY date`,
        [project.municipality_code ?? ''],
      ),
      q.query(
        'SELECT id, supplier_org_id, client_org_id, parent_contract_id, status FROM contracting.contract WHERE project_id = $1',
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
        `SELECT id, project_id, contract_id, estimate_owner_org_id, task_id, code, description,
                unit, quantity, unit_price_cents, material_spec,
                introduced_by_change_order_id, superseded_by_change_order_id
           FROM contracting.boq_item
          WHERE project_id = $1
          ORDER BY code`,
        [projectId],
      ),
      q.query(
        `SELECT DISTINCT o.id, o.legal_name FROM identity.organization o
           JOIN planning.task t ON t.assignee_org_id = o.id
          WHERE t.project_id = $1`,
        [projectId],
      ),
      q.query(
        `SELECT * FROM planning.variation
          WHERE project_id = $1 AND status IN ('open', 'acknowledged')`,
        [projectId],
      ),
      q.query('SELECT DISTINCT contract_id FROM planning.baseline WHERE project_id = $1', [projectId]),
      q.query(
        `SELECT DISTINCT ON (bt.task_id) bt.task_id, bt.scope_text, bt.acceptance_criteria
           FROM planning.baseline_task bt
           JOIN planning.baseline b ON b.id = bt.baseline_id
          WHERE b.project_id = $1
          ORDER BY bt.task_id, b.version DESC`,
        [projectId],
      ),
    ]);
    const cal = calRows[0] ?? { work_days: [1, 2, 3, 4, 5], closures: [] };
    const boqLines = lineRows.map(costLineN);
    return {
      tasks: new Map(taskRows.map((r) => [r.id, taskN(r)])),
      links: linkRows.map(linkN),
      calendarRaw: {
        work_days: cal.work_days,
        closures: (cal.closures ?? []).map(({ from, to }) => ({ from, to })),
        holidays: holidayRows,
      },
      contracts: new Map(contractRows.map((r) => [r.id, {
        supplierOrgId: r.supplier_org_id, clientOrgId: r.client_org_id,
        parentContractId: r.parent_contract_id, status: r.status,
      }])),
      ownerOrgId: project.owner_org_id ?? project.created_by_org_id ?? null,
      statuses: new Map(statusRows.map((r) => [r.task_id, r.status])),
      orgNames: new Map(orgRows.map((r) => [r.id, r.legal_name])),
      boqLines,
      costedTaskIds: new Set(boqLines.filter((l) => l.taskId && !l.supersededByChangeOrderId).map((l) => l.taskId)),
      variations: new Map(variationRows.map((r) => {
        const v = variationN(r);
        return [`${v.taskId}|${v.kind}|${v.scopeId}`, v];
      })),
      baselinedContractIds: new Set(baselineRows.map((r) => r.contract_id)),
      baselineText: new Map(baselineTextRows.map((r) => [r.task_id, {
        scopeText: r.scope_text, acceptanceCriteria: r.acceptance_criteria,
      }])),
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
      insertVariation: (v) => client.query(
        `INSERT INTO planning.variation
           (id, project_id, task_id, kind, scope_type, scope_id, baseline_value, current_value,
            delta, cause, cause_task_id, first_changed_at, last_changed_at, last_changed_by_org_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now(),$12,'open')`,
        [v.id, v.projectId, v.taskId, v.kind, v.scopeType, v.scopeId,
          JSON.stringify(v.baselineValue ?? null), JSON.stringify(v.currentValue ?? null),
          JSON.stringify(v.delta), v.cause, v.causeTaskId ?? null, v.lastChangedByOrgId],
      ),
      patchVariation: (id, patch) => {
        const cols = {
          currentValue: ['current_value', (x) => JSON.stringify(x ?? null)],
          delta: ['delta', (x) => JSON.stringify(x)],
          cause: ['cause', (x) => x],
          causeTaskId: ['cause_task_id', (x) => x],
          lastChangedByOrgId: ['last_changed_by_org_id', (x) => x],
          status: ['status', (x) => x],
          changeOrderId: ['change_order_id', (x) => x],
        };
        const sets = ['last_changed_at = now()'];
        const values = [id];
        for (const [key, value] of Object.entries(patch)) {
          if (!cols[key]) continue;
          values.push(cols[key][1](value));
          sets.push(`${cols[key][0]} = $${values.length}`);
        }
        return client.query(`UPDATE planning.variation SET ${sets.join(', ')} WHERE id = $1`, values);
      },
      insertCostLine: (l) => client.query(
        `INSERT INTO contracting.boq_item
           (id, project_id, contract_id, estimate_owner_org_id, task_id, code, description,
            unit, quantity, unit_price_cents, material_spec)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [l.id, l.projectId, l.contractId, l.estimateOwnerOrgId, l.taskId, l.code,
          l.description, l.unit, l.quantity, l.unitPriceCents, l.materialSpec],
      ),
      patchCostLine: (id, patch) => {
        const cols = {
          code: 'code', description: 'description', unit: 'unit', quantity: 'quantity',
          unitPriceCents: 'unit_price_cents', materialSpec: 'material_spec',
        };
        const sets = [];
        const values = [id];
        for (const [key, value] of Object.entries(patch)) {
          if (!cols[key]) continue;
          values.push(value);
          sets.push(`${cols[key]} = $${values.length}`);
        }
        if (!sets.length) return Promise.resolve();
        return client.query(`UPDATE contracting.boq_item SET ${sets.join(', ')} WHERE id = $1`, values);
      },
      deleteCostLine: (id) => client.query('DELETE FROM contracting.boq_item WHERE id = $1', [id]),
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
      return rows.map(progressN);
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

    // ── cost lines / variations / progress (phase 5) ────────────────────────
    async getCostLine(costLineId) {
      const { rows } = await pool.query('SELECT * FROM contracting.boq_item WHERE id = $1', [costLineId]);
      return rows.length ? costLineN(rows[0]) : null;
    },

    async listVariations(projectId, { kind, status, since, taskId } = {}) {
      const { rows } = await pool.query(
        `SELECT v.*, t.name AS task_name
           FROM planning.variation v JOIN planning.task t ON t.id = v.task_id
          WHERE v.project_id = $1
            AND ($2::text IS NULL OR v.kind = $2)
            AND ($3::text IS NULL OR v.status = $3)
            AND ($4::timestamptz IS NULL OR v.last_changed_at >= $4)
            AND ($5::uuid IS NULL OR v.task_id = $5)
          ORDER BY v.last_changed_at DESC, v.id`,
        [projectId, kind ?? null, status ?? null, since ?? null, taskId ?? null],
      );
      return attachAcks(pool, rows.map(variationN));
    },

    async getVariation(variationId) {
      const { rows } = await pool.query(
        `SELECT v.*, t.name AS task_name, t.project_id AS task_project_id
           FROM planning.variation v JOIN planning.task t ON t.id = v.task_id
          WHERE v.id = $1`,
        [variationId],
      );
      if (!rows.length) return null;
      const [v] = await attachAcks(pool, [variationN(rows[0])]);
      return v;
    },

    /** open → acknowledged + the who/when row; a second ack just records. */
    async acknowledgeVariation({ variationId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          'SELECT * FROM planning.variation WHERE id = $1 FOR UPDATE', [variationId],
        );
        const v = rows[0];
        await client.query(
          `INSERT INTO planning.variation_ack (variation_id, org_id, person_id)
           VALUES ($1, $2, $3)`,
          [variationId, actor.orgId, actor.personId],
        );
        if (v.status === 'open') {
          await client.query(
            `UPDATE planning.variation SET status = 'acknowledged' WHERE id = $1`, [variationId],
          );
        }
        await appendAuditEvent(client, {
          projectId: v.project_id,
          actor,
          category: 'planning',
          type: 'planning.variation.acknowledged',
          scope: variationScope(v),
          object: { type: 'variation', id: variationId },
          payload: { task_id: v.task_id, kind: v.kind },
          channel: actor.channel ?? 'ui',
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'planning.variation.acknowledged',
          project_id: v.project_id,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: variationScope(v),
          data: { variation_id: variationId, task_id: v.task_id, kind: v.kind },
        });
        const [out] = await attachAcks(client, [variationN({ ...v, status: v.status === 'open' ? 'acknowledged' : v.status })]);
        return out;
      });
    },

    /** The question lives in collaboration.comment (one thread per object). */
    async questionVariation({ variationId, comment, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          'SELECT * FROM planning.variation WHERE id = $1', [variationId],
        );
        const v = rows[0];
        const { rows: threads } = await client.query(
          `INSERT INTO collaboration.thread (id, project_id, object_type, object_id)
           VALUES ($1, $2, 'variation', $3)
           ON CONFLICT (object_type, object_id) DO UPDATE SET project_id = EXCLUDED.project_id
           RETURNING id`,
          [randomUUID(), v.project_id, variationId],
        );
        const { rows: comments } = await client.query(
          `INSERT INTO collaboration.comment
             (id, thread_id, author_person_id, author_org_id, kind, body, addressee_org_id, question_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING created_at`,
          [comment.id, threads[0].id, actor.personId, actor.orgId, comment.kind, comment.body,
            comment.addresseeOrgId ?? null, comment.kind === 'question' ? 'open' : null],
        );
        await appendAuditEvent(client, {
          projectId: v.project_id,
          actor,
          category: 'planning',
          type: 'planning.variation.questioned',
          scope: variationScope(v),
          object: { type: 'variation', id: variationId },
          payload: { comment_id: comment.id, kind: comment.kind },
          channel: actor.channel ?? 'ui',
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'planning.variation.questioned',
          project_id: v.project_id,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: variationScope(v),
          data: { variation_id: variationId, comment_id: comment.id },
        });
        return { createdAt: comments[0].created_at.toISOString() };
      });
    },

    /** Append-only progress + planning.progress.reported, one transaction. */
    async insertProgress({ taskId, projectId, status, percent, note, photoDocumentIds, taskName, criteria, actor }) {
      return tx(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${projectId}`]);
        const { rows } = await client.query(
          `INSERT INTO planning.progress_report
             (task_id, seq, status, percent, note, photo_document_ids, reported_by_org_id, reported_by_person_id)
           SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5, $6, $7
             FROM planning.progress_report WHERE task_id = $1
           RETURNING *`,
          [taskId, status, percent, note, photoDocumentIds ?? [], actor.orgId, actor.personId],
        );
        const report = rows[0];
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'planning',
          type: 'planning.progress.reported',
          scope: { type: 'project', id: projectId },
          object: { type: 'task', id: taskId },
          payload: { seq: report.seq, status, ...(percent != null ? { percent } : {}), ...(note ? { note } : {}) },
          channel: actor.channel ?? 'ui',
        });
        // Quality consumes this to open a verification request on `done`
        // (criteria snapshot travels along); contracting consumes it to
        // activate signed contracts when work starts.
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'planning.progress.reported',
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'project', id: projectId },
          data: {
            task_id: taskId,
            task_name: taskName,
            project_id: projectId,
            status,
            ...(note ? { note } : {}),
            reported_by_org_id: actor.orgId,
            ...(criteria ? { criteria } : {}),
          },
        });
        return progressN(report);
      });
    },

    /**
     * Consumer of quality.verification.accepted / .rejected: accepted appends
     * 'verified' by the decider, rejected sends the row back to in_progress
     * with the reason. Idempotent: a replay whose outcome is already the
     * latest report (same status + note) appends nothing.
     */
    async appendQualityOutcome({ taskId, status, note, actor }) {
      return tx(async (client) => {
        const { rows: tasks } = await client.query(
          'SELECT project_id, name FROM planning.task WHERE id = $1', [taskId],
        );
        if (!tasks.length) return { appended: false, reason: 'unknown task' };
        const projectId = tasks[0].project_id;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${projectId}`]);
        const { rows: last } = await client.query(
          'SELECT status, note FROM planning.progress_report WHERE task_id = $1 ORDER BY seq DESC LIMIT 1',
          [taskId],
        );
        if (last.length && last[0].status === status && (last[0].note ?? null) === (note ?? null)) {
          return { appended: false, reason: 'already recorded' }; // at-least-once absorbed
        }
        await client.query(
          `INSERT INTO planning.progress_report
             (task_id, seq, status, note, reported_by_org_id, reported_by_person_id)
           SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5
             FROM planning.progress_report WHERE task_id = $1`,
          [taskId, status, note, actor.orgId, actor.personId],
        );
        await appendAuditEvent(client, {
          projectId,
          actor: { ...actor },
          category: 'planning',
          type: 'planning.progress.reported',
          scope: { type: 'project', id: projectId },
          object: { type: 'task', id: taskId },
          payload: { status, ...(note ? { note } : {}), source: 'quality' },
          channel: 'system',
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'planning.progress.reported',
          project_id: projectId,
          actor: { person_id: actor.personId ?? null, org_id: actor.orgId ?? null },
          scope: { type: 'project', id: projectId },
          data: { task_id: taskId, task_name: tasks[0].name, project_id: projectId, status, reported_by_org_id: actor.orgId },
        });
        return { appended: true };
      });
    },

    /**
     * Consumer of contracting.change_order.approved (doc 10): TIME entries
     * become the next baseline for that contract; the formalised variations
     * are stamped. Idempotent — a baseline already carrying this change order
     * absorbs the replay, and UNIQUE(contract_id, version) breaks races.
     */
    async baselineFromChangeOrder({ contractId, changeOrderId, projectId, time, fromVariationIds, actor }) {
      return tx(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${projectId}`]);
        const { rows: existing } = await client.query(
          'SELECT 1 FROM planning.baseline WHERE change_order_id = $1', [changeOrderId],
        );
        if (existing.length) return { rebaselined: false, reason: 'already applied' };

        if (fromVariationIds?.length) {
          await client.query(
            `UPDATE planning.variation
                SET status = 'formalised', change_order_id = $2, last_changed_at = now()
              WHERE id = ANY($1::uuid[]) AND status IN ('open', 'acknowledged')`,
            [fromVariationIds, changeOrderId],
          );
        }
        if (!time?.length) return { rebaselined: false, reason: 'no time entries', formalised: fromVariationIds?.length ?? 0 };

        const { rows: versions } = await client.query(
          'SELECT coalesce(max(version), 0) + 1 AS next FROM planning.baseline WHERE contract_id = $1',
          [contractId],
        );
        const version = versions[0].next;
        const baselineId = randomUUID();
        await client.query(
          `INSERT INTO planning.baseline (id, project_id, contract_id, version, reason, change_order_id)
           VALUES ($1, $2, $3, $4, 'change_order', $5)`,
          [baselineId, projectId, contractId, version, changeOrderId],
        );
        for (const t of time) {
          const { rows: tasks } = await client.query(
            'SELECT * FROM planning.task WHERE id = $1', [t.task_id],
          );
          if (!tasks.length) continue;
          const task = tasks[0];
          const start = t.new_baseline_start ?? null;
          const finish = t.new_baseline_finish ?? null;
          await client.query(
            `INSERT INTO planning.baseline_task
               (baseline_id, task_id, start, finish, duration_wd, name, scope_text, acceptance_criteria)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [baselineId, t.task_id, start, finish, task.duration_wd, task.name, task.description, task.acceptance_criteria],
          );
          await client.query(
            `UPDATE planning.task
                SET baseline_start = $2::date, baseline_finish = $3::date,
                    schedule_state = CASE
                      WHEN to_char(coalesce(actual_start, start), 'YYYY-MM-DD') IS NOT DISTINCT FROM $2::text
                       AND to_char(coalesce(actual_finish, finish), 'YYYY-MM-DD') IS NOT DISTINCT FROM $3::text
                      THEN 'on_baseline' ELSE 'extended' END
              WHERE id = $1`,
            [t.task_id, start, finish],
          );
          // if the row now sits ON the new baseline, its open time variation
          // has been answered — close it
          await client.query(
            `UPDATE planning.variation v SET status = 'closed', last_changed_at = now()
              WHERE v.task_id = $1 AND v.kind = 'time' AND v.status IN ('open', 'acknowledged')
                AND EXISTS (SELECT 1 FROM planning.task t WHERE t.id = $1
                             AND to_char(coalesce(t.actual_start, t.start), 'YYYY-MM-DD') IS NOT DISTINCT FROM $2
                             AND to_char(coalesce(t.actual_finish, t.finish), 'YYYY-MM-DD') IS NOT DISTINCT FROM $3)`,
            [t.task_id, start, finish],
          );
        }
        // freeze the contract's cost reference alongside the dates, as the
        // signature baseline does
        await client.query(
          `INSERT INTO planning.baseline_cost_line (baseline_id, boq_item_id, quantity, unit_price_cents, material_spec)
           SELECT $1, id, quantity, unit_price_cents, material_spec
             FROM contracting.boq_item
            WHERE contract_id = $2 AND superseded_by_change_order_id IS NULL`,
          [baselineId, contractId],
        );
        await appendAuditEvent(client, {
          projectId,
          actor: { personId: actor?.personId ?? null, orgId: actor?.orgId ?? null },
          category: 'planning',
          type: 'planning.baseline.taken',
          scope: { type: 'project', id: projectId },
          object: { type: 'baseline', id: baselineId },
          payload: { contract_id: contractId, version, reason: 'change_order', change_order_id: changeOrderId, rows: time.length },
          channel: 'system',
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'planning.baseline.taken',
          version: 1,
          project_id: projectId,
          actor: { person_id: actor?.personId ?? null, org_id: actor?.orgId ?? null },
          scope: { type: 'project', id: projectId },
          data: { baseline_id: baselineId, contract_id: contractId, version, reason: 'change_order', change_order_id: changeOrderId },
        });
        return { rebaselined: true, baselineId, version };
      });
    },

    /**
     * Consumer of planning.variation.recorded / .updated: fold the event into
     * this project's 15-minute digest window, one row PER RECIPIENT (project
     * owner members + scope-contract client members), nets re-computed from
     * the window's variations with the recipient's visibility. sent_at stays
     * NULL — e-mail is a later phase (ruling 14).
     */
    async recordVariationDigest(evt, { windowStart, windowEnd }) {
      return tx(async (client) => {
        const { rows: variations } = await client.query(
          'SELECT * FROM planning.variation WHERE id = $1', [evt.data.variation_id],
        );
        if (!variations.length) return { recipients: 0 };
        const v = variations[0];
        const { rows: projects } = await client.query(
          'SELECT owner_org_id FROM project.project WHERE id = $1', [v.project_id],
        );
        const orgIds = new Set();
        if (projects[0]?.owner_org_id) orgIds.add(projects[0].owner_org_id);
        if (v.scope_type === 'contract') {
          const { rows: contracts } = await client.query(
            'SELECT client_org_id FROM contracting.contract WHERE id = $1', [v.scope_id],
          );
          if (contracts[0]) orgIds.add(contracts[0].client_org_id);
        }
        // collaboration.variation_subscription narrows an org's kinds
        const { rows: subs } = await client.query(
          'SELECT org_id, kinds FROM collaboration.variation_subscription WHERE project_id = $1 AND org_id = ANY($2::uuid[])',
          [v.project_id, [...orgIds]],
        );
        for (const s of subs) {
          if (!s.kinds.includes(v.kind)) orgIds.delete(s.org_id);
        }
        if (!orgIds.size) return { recipients: 0 };
        const { rows: members } = await client.query(
          `SELECT DISTINCT person_id, org_id FROM identity.org_membership
            WHERE org_id = ANY($1::uuid[]) AND status = 'active'`,
          [[...orgIds]],
        );
        for (const m of members) {
          const { rows: digests } = await client.query(
            `SELECT id, variation_ids FROM planning.variation_digest
              WHERE project_id = $1 AND recipient_person_id = $2 AND window_start = $3 AND sent_at IS NULL
              FOR UPDATE`,
            [v.project_id, m.person_id, windowStart],
          );
          let digestId;
          let ids;
          if (digests.length) {
            digestId = digests[0].id;
            ids = digests[0].variation_ids.includes(v.id)
              ? digests[0].variation_ids
              : [...digests[0].variation_ids, v.id];
          } else {
            digestId = randomUUID();
            ids = [v.id];
          }
          const { rows: nets } = await client.query(
            `SELECT
               coalesce(sum((v2.delta->>'finish_wd')::int) FILTER (WHERE v2.kind = 'time'), 0) AS finish_wd,
               sum((v2.delta->>'amount_cents')::bigint) FILTER (
                 WHERE v2.kind IN ('cost', 'material')
                   AND EXISTS (SELECT 1 FROM contracting.contract c
                                WHERE c.id = v2.scope_id AND $2::uuid IN (c.client_org_id, c.supplier_org_id))
               ) AS cost_cents
               FROM planning.variation v2
              WHERE v2.id = ANY($1::uuid[]) AND v2.status <> 'closed'`,
            [ids, m.org_id],
          );
          if (digests.length) {
            await client.query(
              `UPDATE planning.variation_digest
                  SET variation_ids = $2, net_project_finish_delta_wd = $3, net_cost_delta_cents = $4
                WHERE id = $1`,
              [digestId, ids, nets[0].finish_wd, nets[0].cost_cents],
            );
          } else {
            await client.query(
              `INSERT INTO planning.variation_digest
                 (id, project_id, window_start, window_end, variation_ids,
                  net_project_finish_delta_wd, recipient_person_id, net_cost_delta_cents)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [digestId, v.project_id, windowStart, windowEnd, ids, nets[0].finish_wd, m.person_id, nets[0].cost_cents],
            );
          }
        }
        return { recipients: members.length };
      });
    },
  };
}

function progressN(r) {
  return {
    taskId: r.task_id, seq: r.seq, status: r.status, percent: r.percent, note: r.note,
    photoDocumentIds: r.photo_document_ids ?? [],
    reportedByOrgId: r.reported_by_org_id, reportedByPersonId: r.reported_by_person_id,
    onBehalfOfOrgId: r.on_behalf_of_org_id ?? null,
    reportedAt: r.reported_at?.toISOString?.() ?? r.reported_at,
  };
}

function variationScope(v) {
  return ['cost', 'material'].includes(v.kind)
    ? { type: 'contract', id: v.scope_id }
    : { type: 'project', id: v.project_id };
}

async function attachAcks(q, variations) {
  if (!variations.length) return variations;
  const { rows } = await q.query(
    `SELECT variation_id, org_id, person_id, acknowledged_at
       FROM planning.variation_ack WHERE variation_id = ANY($1::uuid[])
      ORDER BY acknowledged_at`,
    [variations.map((v) => v.id)],
  );
  const byId = new Map(variations.map((v) => [v.id, []]));
  for (const r of rows) {
    byId.get(r.variation_id)?.push({
      orgId: r.org_id, personId: r.person_id,
      acknowledgedAt: r.acknowledged_at?.toISOString?.() ?? r.acknowledged_at,
    });
  }
  return variations.map((v) => ({ ...v, acks: byId.get(v.id) ?? [] }));
}
