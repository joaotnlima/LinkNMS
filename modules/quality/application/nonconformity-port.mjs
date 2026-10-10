// The quality NON-CONFORMITY PORT published for other modules (doc 02 rule 2).
// Documents records that a drawing markup points at an issue on the task
// (PRD-06 V-8: an issue can point at a PDF page, a DWG layout and a model
// element at once) without reading quality.*:
//
//   nonconformityFacts(id) → null | {
//     id, project_id, task_id, raised_by_org_id, status
//   }

/** @param {{ getNonConformity: (id: string) => Promise<object|null> }} store quality pg-store */
export function createNonConformityPort(store) {
  return {
    async nonconformityFacts(nonconformityId) {
      const nc = await store.getNonConformity(nonconformityId);
      if (!nc) return null;
      return {
        id: nc.id,
        project_id: nc.project_id,
        task_id: nc.task_id ?? null,
        raised_by_org_id: nc.raised_by_org_id,
        status: nc.status,
      };
    },
  };
}
