// Bridge: the Decision Log's `authz` port over the real Identity service
// (ADR-0004 — Identity is the SOLE authorizer; LINA-56).
//
// The Decision Log names its own actions (record_decision / revise_decision /
// view_decisions) and asks a port `can(actorPartyId, action, projectId)`. Identity
// speaks the platform-wide capability table in services/identity/authz.mjs. Two of
// the three names line up exactly; `view_decisions` has no separate capability in
// R0 — reading the decision log is reading the project — so it maps to
// VIEW_PROJECT. Doing the mapping HERE, in one table, is deliberate: the Decision
// Log never re-implements a capability rule, and an unmapped action is a hard
// error rather than a silent allow.
import { ACTIONS } from './decision-log.mjs';
import { ACTION } from '../identity/authz.mjs';

const ACTION_MAP = Object.freeze({
  [ACTIONS.RECORD]: ACTION.RECORD_DECISION,
  [ACTIONS.REVISE]: ACTION.REVISE_DECISION,
  // Reading the decision log is reading the project (design §4.1): any member.
  [ACTIONS.VIEW]: ACTION.VIEW_PROJECT,
});

/**
 * @param {Object} deps
 * @param {{ authorize(ctx): Promise<{role: string}> }} deps.identity  the Identity service
 */
export function createIdentityAuthz({ identity }) {
  if (!identity?.authorize) {
    throw new Error('createIdentityAuthz requires the identity service (authorize)');
  }
  return {
    async can(actorPartyId, action, projectId) {
      const mapped = ACTION_MAP[action];
      if (!mapped) throw new Error(`decision authz: unmapped action "${action}"`);
      try {
        await identity.authorize({ actorPartyId, action: mapped, projectId });
        return true;
      } catch {
        // The Decision Log turns `false` into its own typed 401/403 (it already
        // distinguishes "no acting party" from "denied"), so swallowing the
        // typed Identity error here loses nothing the caller needs.
        return false;
      }
    },
  };
}
