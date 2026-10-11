// The identity NOTIFICATION AUDIENCE PORT (PRD-12 N-1, doc 10 §Notification
// centre). Identity owns people, memberships and project staffing, so it is
// the module that answers "which PEOPLE of this organisation should hear
// about this?" — collaboration asks here instead of reading identity.*:
//
//   projectAudience(projectId, orgId) → [{ person_id, email, name, locale }]
//       members who work the project: staffed on it, or admin/manager (they
//       read every project of their org — the same rule as reading one, doc 16).
//   orgAudience(orgId, permission)    → [{ person_id, email, name, locale }]
//       members whose role holds `permission` (doc 16 §5) — for bidders, who
//       are not project participants and so are never staffed.
import { ROLES, roleHolds } from '../domain/access.mjs';

/** Roles that read every project of their org without staffing (doc 16 §6). */
export const ALL_PROJECT_ROLES = Object.freeze(['admin', 'manager']);

const contact = (r) => ({ person_id: r.person_id, email: r.email, name: r.name, locale: r.locale });

/** @param {ReturnType<import('../infra/pg-store.mjs').createIdentityStore>} store */
export function createIdentityAudience(store) {
  return {
    async projectAudience(projectId, orgId) {
      if (!projectId || !orgId) return [];
      const rows = await store.projectAudienceRows(projectId, orgId, [...ALL_PROJECT_ROLES]);
      return rows.map(contact);
    },

    async orgAudience(orgId, permission) {
      if (!orgId) return [];
      const roles = ROLES.filter((r) => roleHolds(r, permission));
      if (!roles.length) return [];
      const rows = await store.orgAudienceRows(orgId, roles);
      return rows.map(contact);
    },
  };
}
