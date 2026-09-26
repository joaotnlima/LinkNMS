// Contracting-module event consumers (doc 10). Signed → ACTIVE is derived
// from work starting on the ground (doc 09 §Contract): planning publishes
// planning.progress.reported, and the first in_progress/done report on a row
// of a signed contract's branch activates that contract — and every signed
// ancestor above it in the chain (work on a sub is work on the prime).
// Decision (phase 5, brief ruling 5): CONSUMER approach, not lazy-derive,
// because the event now exists and an explicit .activated event keeps the
// ledger honest. Idempotent: the status='signed' filter absorbs replays;
// terminated/closed contracts are never touched (ruling 16).
export function contractingConsumers(store) {
  return {
    'planning.progress.reported': async (evt) => {
      if (!['in_progress', 'done'].includes(evt.data?.status)) return;
      await store.activateContractsForTask({
        taskId: evt.data.task_id,
        projectId: evt.project_id,
        actor: { personId: evt.actor?.person_id ?? null, orgId: evt.actor?.org_id ?? null },
      });
    },
  };
}
