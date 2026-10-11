// Published query port: a build's quality and safety facts for the build home
// (PRD-09 O-1 — the safety pillar). Project composes getProjectOverview from
// it and never reads quality.* (doc 02 rules 2–3). Counts only, no viewer:
// the caller has checked the viewer reads the project.
//
//   projectFacts(projectId) → {
//     pending_verifications,                    // requests not yet decided
//     open_nonconformities: {quality, safety},  // not closed
//   }

/** @param {{ projectQualityFacts: Function }} store quality pg-store */
export function createQualityFactsPort(store) {
  return {
    async projectFacts(projectId) {
      const f = await store.projectQualityFacts(projectId);
      return {
        pending_verifications: Number(f.pending_verifications ?? 0),
        open_nonconformities: { quality: Number(f.open_quality ?? 0), safety: Number(f.open_safety ?? 0) },
      };
    },
  };
}
