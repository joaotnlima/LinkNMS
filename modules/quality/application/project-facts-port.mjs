// Published query port: a build's quality and safety facts for the build home
// (PRD-09 O-1 — the safety pillar). Project composes getProjectOverview from
// it and never reads quality.* (doc 02 rules 2–3). Counts only, no viewer:
// the caller has checked the viewer reads the project.
//
//   projectFacts(projectId) → {
//     pending_verifications,                    // requests not yet decided
//     open_nonconformities: {quality, safety},  // not closed
//   }

/**
 * @param {{ projectQualityFacts: Function }} store quality pg-store
 * @param {{ taskIdsOf: Function } | null} planning planning's task port — the
 *   build's rows a verification hangs on (quality never reads planning.*)
 */
export function createQualityFactsPort(store, planning = null) {
  return {
    async projectFacts(projectId) {
      const taskIds = planning ? await planning.taskIdsOf(projectId) : [];
      const f = await store.projectQualityFacts(projectId, taskIds);
      return {
        pending_verifications: Number(f.pending_verifications ?? 0),
        open_nonconformities: { quality: Number(f.open_quality ?? 0), safety: Number(f.open_safety ?? 0) },
      };
    },
  };
}
