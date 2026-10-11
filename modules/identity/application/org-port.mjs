// Published query port: organisations as other modules may name them.
//
// Planning, Tendering and Project show who did something ("imported by",
// "changed by", a bidder's company, the people an organisation staffed on a
// build) and must not read identity.* themselves (doc 02 rules 2–3). No
// viewer: the caller has already decided the viewer may see the object the
// organisation is attached to; the port only names it.
//
//   namesOf(orgIds)                  → Map(org_id → legal_name)
//   staffedPeople(projectId, orgIds) → [{ org_id, person_id, name }] by name

/** @param {{ organizationNames: Function, staffedPeople: Function }} store identity pg-store */
export function createOrgPort(store) {
  return {
    async namesOf(orgIds) {
      const ids = [...new Set((orgIds ?? []).filter(Boolean))];
      const rows = ids.length ? await store.organizationNames(ids) : [];
      return new Map(rows.map((r) => [r.id, r.legal_name]));
    },

    async staffedPeople(projectId, orgIds) {
      const ids = [...new Set((orgIds ?? []).filter(Boolean))];
      if (!projectId || !ids.length) return [];
      return (await store.staffedPeople(projectId, ids)).map((r) => ({
        org_id: r.org_id, person_id: r.person_id, name: r.name,
      }));
    },
  };
}
