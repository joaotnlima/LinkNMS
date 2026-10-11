// Directory domain — which domain events feed the "On the record" read model
// and what each one changes (to-be/10 §Directory read model). Pure: an
// envelope in, a list of read-model operations out. The consumer applies them
// in one transaction with the event_id dedupe.
//
// Only facts both sides of a contract can see are taken, and never an amount:
// change_order.approved carries amount_delta_cents — it is not copied.

export const RECORD_EVENT_TYPES = Object.freeze([
  'contracting.contract.signed',
  'contracting.contract.activated',
  'contracting.contract.provisionally_received',
  'contracting.contract.closed',
  'contracting.contract.terminated',
  'contracting.change_order.submitted',
  'contracting.change_order.approved',
  'contracting.change_order.rejected',
  'contracting.change_order.withdrawn',
  'planning.progress.reported',
  'tendering.proposal.submitted',
  'tendering.rfp.awarded',
]);

const CONTRACT_STATUS = {
  'contracting.contract.activated': 'active',
  'contracting.contract.provisionally_received': 'provisionally_received',
  'contracting.contract.closed': 'closed',
  'contracting.contract.terminated': 'terminated',
};
const CO_STATUS = {
  'contracting.change_order.submitted': 'submitted',
  'contracting.change_order.approved': 'approved',
  'contracting.change_order.rejected': 'rejected',
  'contracting.change_order.withdrawn': 'withdrawn',
};
const REOPENED = new Set(['not_started', 'in_progress', 'blocked']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {{ type: string, occurred_at?: string|Date, project_id?: string,
 *           scope?: {type: string, id: string}, data?: object }} evt
 * @param {Date} now the clock — the moment an envelope without `occurred_at`
 *   is recorded at (the consumer passes its own; the domain reads no clock)
 * @returns {object[]} read-model operations (empty: nothing to record)
 */
export function recordOps(evt, now) {
  const at = evt.occurred_at ? new Date(evt.occurred_at).toISOString() : now.toISOString();
  const d = evt.data ?? {};

  if (evt.type === 'contracting.contract.signed') {
    if (!d.client_org_id || !d.supplier_org_id || evt.scope?.type !== 'contract') return [];
    return [{
      op: 'contract_signed',
      contractId: evt.scope.id,
      projectId: evt.project_id,
      kind: d.kind ?? 'direct',
      clientOrgId: d.client_org_id,
      supplierOrgId: d.supplier_org_id,
      at,
    }];
  }
  if (CONTRACT_STATUS[evt.type]) {
    if (evt.scope?.type !== 'contract') return [];
    return [{ op: 'contract_status', contractId: evt.scope.id, status: CONTRACT_STATUS[evt.type], at }];
  }
  if (CO_STATUS[evt.type]) {
    if (!d.change_order_id || !d.contract_id) return [];
    return [{
      op: 'change_order',
      changeOrderId: d.change_order_id,
      contractId: d.contract_id,
      status: CO_STATUS[evt.type],
      at,
    }];
  }
  if (evt.type === 'planning.progress.reported') {
    if (!d.task_id) return [];
    if (d.status === 'done') {
      // A done report without the on-record facts (an event from before
      // PRD-03, or a row nobody is assigned) records nothing.
      if (!d.assignee_org_id) return [];
      return [{
        op: 'task_finished',
        taskId: d.task_id,
        projectId: d.project_id ?? evt.project_id,
        contractId: d.contract_id ?? null,
        assigneeOrgId: d.assignee_org_id,
        baselineFinish: DATE.test(d.baseline_finish ?? '') ? d.baseline_finish : null,
        actualFinish: DATE.test(d.actual_finish ?? '') ? d.actual_finish : null,
        at,
      }];
    }
    if (REOPENED.has(d.status)) return [{ op: 'task_reopened', taskId: d.task_id }];
    return []; // 'verified' keeps the finished row as it is
  }
  if (evt.type === 'tendering.proposal.submitted') {
    if (!d.proposal_id || !d.rfp_id) return [];
    return [{ op: 'proposal_submitted', proposalId: d.proposal_id, rfpId: d.rfp_id, bidderOrgId: d.bidder_org_id ?? null, at }];
  }
  if (evt.type === 'tendering.rfp.awarded') {
    if (!d.proposal_id || !d.rfp_id) return [];
    return [{ op: 'proposal_awarded', proposalId: d.proposal_id, rfpId: d.rfp_id, at }];
  }
  return [];
}
