// Published query port: who holds which contract on a build, as other modules
// may ask it. Planning gates its settings on "the owner or the prime
// contractor" (PRD-02, putPlanningSettings) and must not read contracting.*
// itself (doc 02 rules 2–3). No viewer: the caller names the organisation.
//
//   isPrimeSupplier(projectId, orgId) → boolean   a live (signed, active or
//                                                 provisionally received) prime

/** @param {{ isLivePrimeSupplier: Function }} store contracting pg-store */
export function createContractPartyPort(store) {
  return {
    async isPrimeSupplier(projectId, orgId) {
      if (!projectId || !orgId) return false;
      return store.isLivePrimeSupplier(projectId, orgId);
    },
  };
}
