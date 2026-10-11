// Published query port: the cost the viewer's organisation carries on a build
// (PRD-09 O-1 — the budget pillar). Project composes getProjectOverview from it
// and never reads contracting.* (doc 02 rules 2–3).
//
// Cost side only (D-38): the contracts the viewer's org is the CLIENT of, once
// signed. `baseline` = the BoQ as signed (lines a change order introduced are
// excluded, superseded originals included); `current` = the live BoQ. Money is
// field-absent (invariant §6.5): null unless the person holds org:money:view
// and the org is client of at least one signed contract.
//
//   costFor({viewer, projectId}) → null | { contracts, baseline_cents, current_cents }

/** @param {{ clientCostSummary: Function }} store contracting pg-store */
export function createCostPort(store) {
  return {
    async costFor({ viewer, projectId }) {
      if (!viewer?.orgId || !viewer.has?.('org:money:view')) return null;
      const s = await store.clientCostSummary(projectId, viewer.orgId);
      if (!s || Number(s.contracts) === 0) return null;
      return {
        contracts: Number(s.contracts),
        baseline_cents: Number(s.baseline_cents),
        current_cents: Number(s.current_cents),
      };
    },
  };
}
