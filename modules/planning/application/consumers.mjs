// Planning-module event consumers (doc 10). Planning OWNS the plan rows, the
// baselines, the variations and the progress trail, so:
//   contracting.contract.signed        → bind the tendered branch + baseline v1
//   contracting.change_order.approved  → next baseline from the CO's time
//                                        entries; from_variation_ids formalised
//   quality.verification.accepted     → append a 'verified' progress report
//   quality.verification.rejected    → back to 'in_progress' with the reason
//   planning.variation.recorded/.updated → fold into the 15-minute digest
//                                        (doc 05 §6; rows persisted, sent_at
//                                        NULL — e-mail is a later phase)
// All idempotent: baselines absorb on (contract_id, version) / change_order_id,
// progress appends skip when the outcome is already the latest report, digest
// rows are found-or-created per (project, recipient, window).
import { windowOf } from '../domain/variations.mjs';

export function planningConsumers(store) {
  return {
    'contracting.contract.signed': async (evt) => {
      await store.bindSignedContract({
        contractId: evt.scope.id,
        projectId: evt.project_id,
        actor: { personId: evt.actor.person_id ?? null, orgId: evt.actor.org_id ?? null },
      });
    },

    'contracting.change_order.approved': async (evt) => {
      await store.baselineFromChangeOrder({
        contractId: evt.data.contract_id ?? evt.scope.id,
        changeOrderId: evt.data.change_order_id,
        projectId: evt.project_id,
        time: evt.data.time ?? [],
        fromVariationIds: evt.data.from_variation_ids ?? [],
        actor: { personId: evt.actor.person_id ?? null, orgId: evt.actor.org_id ?? null },
      });
    },

    'quality.verification.accepted': async (evt) => {
      await store.appendQualityOutcome({
        taskId: evt.data.task_id,
        status: 'verified',
        note: evt.data.note ?? null,
        actor: { personId: evt.data.decided_by_person_id ?? evt.actor.person_id ?? null, orgId: evt.data.decided_by_org_id ?? evt.actor.org_id ?? null },
      });
    },

    'quality.verification.rejected': async (evt) => {
      await store.appendQualityOutcome({
        taskId: evt.data.task_id,
        status: 'in_progress',
        note: evt.data.reason ?? evt.data.note ?? null,
        actor: { personId: evt.data.decided_by_person_id ?? evt.actor.person_id ?? null, orgId: evt.data.decided_by_org_id ?? evt.actor.org_id ?? null },
      });
    },

    'planning.variation': async (evt) => {
      if (!['planning.variation.recorded', 'planning.variation.updated'].includes(evt.type)) return;
      const { start, end } = windowOf(evt.occurred_at ?? new Date());
      await store.recordVariationDigest(evt, { windowStart: start, windowEnd: end });
    },
  };
}
