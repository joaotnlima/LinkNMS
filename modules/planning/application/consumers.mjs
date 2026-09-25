// Planning-module event consumers (doc 10). Planning OWNS the plan rows and
// the baselines, so when contracting announces a signature it is this module
// that binds the tendered branch and freezes the reference (doc 05 §5):
//   contracting.contract.signed → task.contract_id on the roots,
//   branch_contract_id down their subtrees, baseline v1 snapshot
//   (dates, duration, scope text, acceptance criteria, cost lines),
//   schedule_state = on_baseline.
// Idempotent: the (contract_id, version) unique key on planning.baseline
// absorbs at-least-once delivery — a replay finds v1 and does nothing.
export function planningConsumers(store) {
  return {
    'contracting.contract.signed': async (evt) => {
      await store.bindSignedContract({
        contractId: evt.scope.id,
        projectId: evt.project_id,
        actor: { personId: evt.actor.person_id ?? null, orgId: evt.actor.org_id ?? null },
      });
    },
  };
}
