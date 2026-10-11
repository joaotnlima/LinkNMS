// Published query port: a build as other modules may see it (PRD-03).
//
// The directory needs two answers about a project and must not read
// project.* itself (doc 02 rules 2–3):
//   locationFor — "companies near this build": the build's point (R-3) or
//                 its municipality, for an organisation that takes part in it.
//                 Same rule as getProject: participant (∧ staffing), else 404.
//   ownedBuild  — the owner's consent to show the build's name (R-12): only
//                 the project owner, and the name as it is now.
//   factsOf     — name, municipality and point of several builds, for
//                 tendering's company inbox (PRD-04 X-9, X-10). No viewer: the
//                 caller has already decided the company may see the build —
//                 it holds an invite to it, or the issuer listed its RFP as an
//                 open request (D-47). The point is for measuring distance
//                 server-side; tendering never returns it.
// Both reuse the use-case guards, so the answers can never be wider than
// what the viewer could read through /projects/{id}.
//   ownerOf     — the build's owner organisation, for Collaboration routing a
//                 scope-gap question to the owner (PRD-12 N-5). No viewer: the
//                 caller has already checked the viewer reads the object.
//   locationsOf — which of the given ids are locations of the build, for
//                 Quality tagging a non-conformity or an inspection to a place
//                 (PRD-12 N-3, N-4). No viewer, ids only.
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

    async factsOf(projectIds) {
      const ids = [...new Set((projectIds ?? []).filter(Boolean))];
      const rows = ids.length ? await store.getProjects(ids) : [];
      return rows.map((p) => ({
        project_id: p.id,
        name: p.name,
        municipality_code: p.municipality_code ?? null,
        lat: p.location_lat == null ? null : Number(p.location_lat),
        lng: p.location_lng == null ? null : Number(p.location_lng),
      }));
    },

    async ownerOf(projectId) {
      const project = await store.getProject(projectId);
      return project ? { owner_org_id: project.owner_org_id ?? null } : null;
    },

    async locationsOf(projectId, locationIds) {
      const ids = [...new Set((locationIds ?? []).filter(Boolean))];
      return ids.length ? store.knownLocationIds(projectId, ids) : new Set();
    },

    async ownedBuild({ viewer, projectId }) {
      const { project } = await requireOwner({ viewer, store, projectId });
      return { name: project.name };
    },
  };
}
