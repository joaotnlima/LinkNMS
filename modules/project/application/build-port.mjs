// Published query port: a build as other modules may see it (PRD-03).
//
// The directory needs two answers about a project and must not read
// project.* itself (doc 02 rules 2–3):
//   locationFor — "companies near this build": the build's point (R-3) or
//                 its municipality, for an organisation that takes part in it.
//                 Same rule as getProject: participant (∧ staffing), else 404.
//   ownedBuild  — the owner's consent to show the build's name (R-12): only
//                 the project owner, and the name as it is now.
// Both reuse the use-case guards, so the answers can never be wider than
// what the viewer could read through /projects/{id}.
import { requireParticipant, requireOwner } from './use-cases.mjs';

/** @param {object} store project pg-store */
export function createBuildPort(store) {
  return {
    async locationFor({ viewer, projectId }) {
      const { project } = await requireParticipant({ viewer, store, projectId });
      return {
        name: project.name,
        municipality_code: project.municipality_code,
        lat: project.location_lat == null ? null : Number(project.location_lat),
        lng: project.location_lng == null ? null : Number(project.location_lng),
      };
    },

    async ownedBuild({ viewer, projectId }) {
      const { project } = await requireOwner({ viewer, store, projectId });
      return { name: project.name };
    },
  };
}
