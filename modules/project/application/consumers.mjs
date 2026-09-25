// Project-module event consumers (doc 10). The project module OWNS
// project.participation, so when contracting announces a signature it is
// this module that materialises the supplier's seat at the table:
//   contracting.contract.signed → participation (capacity from the kind).
// Idempotent by construction: the participation PK (project_id, org_id,
// capacity) + ON CONFLICT re-activation absorb at-least-once delivery.

const CAPACITY_BY_KIND = Object.freeze({
  prime: 'prime_contractor',
  direct: 'direct_contractor',
  sub: 'subcontractor',
  service: 'consultant',
});

/**
 * Handlers for platform/outbox.mjs dispatchPending — keyed by type prefix.
 * @param {{ addContractParticipation: Function }} store project pg-store
 */
export function projectConsumers(store) {
  return {
    'contracting.contract.signed': async (evt) => {
      const capacity = CAPACITY_BY_KIND[evt.data.kind];
      if (!capacity) throw new Error(`unknown contract kind in event: ${evt.data.kind}`);
      await store.addContractParticipation({
        projectId: evt.project_id,
        orgId: evt.data.supplier_org_id,
        capacity,
        contractId: evt.scope.id,
      });
    },
  };
}
