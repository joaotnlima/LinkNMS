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

/** @param {{ variationAudienceRow: (id: string) => Promise<object|null> }} store planning pg-store */
export function createPlanningAudience(store) {
  return {
    async variationAudience(variationId) {
      const row = await store.variationAudienceRow(variationId);
      if (!row) return null;
      const orgIds = [...new Set([row.owner_org_id, row.client_org_id].filter(Boolean))];
      return {
        variation_id: row.id,
        project_id: row.project_id,
        task_id: row.task_id ?? null,
        kind: row.kind,
        org_ids: orgIds,
      };
    },
  };
}
