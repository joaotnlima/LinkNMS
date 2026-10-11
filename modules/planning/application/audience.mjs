// The planning NOTIFICATION AUDIENCE PORT (PRD-12 N-1, doc 10 §Notification
// centre). Published for the collaboration module, which owns the 15-minute
// variation digest notifications but must not read planning.* (or the
// contract tree) to find who to tell:
//
//   variationAudience(variationId) → null | {
//     variation_id, project_id, task_id, kind, org_ids[]   // owner + client of the row
//   }
//
// Narrowing by an org's variation subscription is collaboration's own rule
// (it owns collaboration.variation_subscription), not this port's.
//
// PRD-05 (deliverables and task files):
//
//   deliverableAudience(deliverableId, { submitterOrgId? }) → null | {
//     deliverable_id, project_id, task_id, title,
//     reviewer_org_ids[],   // client side of the task, minus the submitter
//     assignee_org_id       // the task's effective assignee (may be null)
//   }
//   taskOwners(taskIds[]) → [{ task_id, project_id, org_id }]
//     the owner of each row: its effective assignee org, else the project owner
import { effectiveAssignee } from '../domain/scope.mjs';
import { reviewerOrgIds } from '../domain/deliverables.mjs';

/** @param {object} store planning pg-store (variationAudienceRow, getDeliverable, getTask, loadPlan) */
export function createPlanningAudience(store) {
  return {
    async variationAudience(variationId) {
      const row = await store.variationAudienceRow(variationId);
      if (!row) return null;
      // The owner and the CLIENT of the contract the row belongs to: the one the
      // variation is scoped to (cost/material) or the row's branch (time/scope).
      // The supplier is the one changing its own plan — not told about itself.
      const plan = await store.loadPlan(row.project_id);
      const contractId = row.scope_type === 'contract' ? row.scope_id : row.branch_contract_id;
      const clientOrgId = contractId ? plan.contracts.get(contractId)?.clientOrgId ?? null : null;
      const orgIds = [...new Set([plan.ownerOrgId, clientOrgId].filter(Boolean))];
      return {
        variation_id: row.id,
        project_id: row.project_id,
        task_id: row.task_id ?? null,
        kind: row.kind,
        org_ids: orgIds,
      };
    },

    async deliverableAudience(deliverableId, { submitterOrgId = null } = {}) {
      const d = await store.getDeliverable(deliverableId);
      if (!d) return null;
      const plan = await store.loadPlan(d.project_id);
      const task = plan.tasks.get(d.task_id);
      if (!task) return null;
      const world = { ownerOrgId: plan.ownerOrgId, contracts: plan.contracts };
      return {
        deliverable_id: d.id,
        project_id: d.project_id,
        task_id: d.task_id,
        title: d.title,
        reviewer_org_ids: reviewerOrgIds({ world, tasks: plan.tasks, task, submitterOrgId }),
        assignee_org_id: effectiveAssignee(plan.tasks, d.task_id)?.orgId ?? null,
      };
    },

    async taskOwners(taskIds = []) {
      const out = [];
      const plans = new Map();
      for (const taskId of taskIds) {
        const row = await store.getTask(taskId);
        if (!row || row.deletedAt) continue;
        if (!plans.has(row.projectId)) plans.set(row.projectId, await store.loadPlan(row.projectId));
        const plan = plans.get(row.projectId);
        const orgId = effectiveAssignee(plan.tasks, taskId)?.orgId ?? plan.ownerOrgId ?? null;
        if (orgId) out.push({ task_id: taskId, project_id: row.projectId, org_id: orgId });
      }
      return out;
    },
  };
}
